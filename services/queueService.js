// services/queueService.js
'use strict';

/**
 * Live Digital Token Engine — now also the single source of truth for the
 * admin dashboard's queue list (`queueList`), so there is exactly ONE place
 * a booking lives: this doc. No separate `clinics/{id}/appointments`
 * subcollection — that model existed nowhere in the actual booking flow and
 * would have silently drifted from reality.
 *
 * Firestore layout:
 *   queues/{clinicId}__{department}__{date}
 *     {
 *       clinicId, department, date,
 *       lastIssuedToken, currentToken,
 *       avgConsultMinutes, delayMinutes,
 *       priorityQueue: [tokenNumber, ...],
 *       completedTokens: [tokenNumber, ...],
 *       queueList: [
 *         { tokenNumber, chatId, patientName, phone, status,
 *           reason, doctorNotes, prescriptions, feeAmount,
 *           paymentStatus, paymentMode, bookedAt }
 *       ]
 *     }
 *
 * A patient's active token is ALSO still mirrored onto their own
 * `patients/{chatId}` doc as `activeToken` (unchanged) — that's what keeps
 * the bot's own "Status" replies fast and simple. `queueList` is additive,
 * for the dashboard; nothing that already worked stops working.
 */

const { db } = require('../db');
const { logger } = require('../errorHandler');
const { patients } = require('./databaseService');

const DEFAULT_AVG_CONSULT_MINUTES = 10;

function todayISO() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
}

function queueDocId(clinicId, department, date) {
    return `${clinicId}__${department}__${date}`.replace(/\s+/g, '_');
}

function defaultQueueState(clinicId, department, date) {
    return {
        clinicId,
        department,
        date,
        lastIssuedToken: 0,
        currentToken: 0,
        avgConsultMinutes: DEFAULT_AVG_CONSULT_MINUTES,
        delayMinutes: 0,
        priorityQueue: [],
        completedTokens: [],
        queueList: [],
    };
}

/**
 * Fetch the queue state for a clinic/department/day, without creating it.
 */
async function getQueueState(clinicId, department, date = todayISO()) {
    if (!db) return defaultQueueState(clinicId, department, date);
    const ref = db.collection('queues').doc(queueDocId(clinicId, department, date));
    const doc = await ref.get();
    if (!doc.exists) return defaultQueueState(clinicId, department, date);
    // Backfill any fields that predate this version of the schema (older
    // queue docs won't have queueList/priorityQueue/completedTokens yet).
    return { ...defaultQueueState(clinicId, department, date), ...doc.data() };
}

/**
 * Issue the next sequential token for a clinic/department/day. Optionally
 * appends a queueList entry in the SAME transaction (used by bookToken) so
 * the counter and the list can never drift apart.
 */
async function issueToken(clinicId, department, date = todayISO(), patientInfo = null) {
    if (!db) {
        return { tokenNumber: 1, queueState: defaultQueueState(clinicId, department, date) };
    }

    const ref = db.collection('queues').doc(queueDocId(clinicId, department, date));

    const result = await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        const current = doc.exists
            ? { ...defaultQueueState(clinicId, department, date), ...doc.data() }
            : defaultQueueState(clinicId, department, date);
        const nextToken = (current.lastIssuedToken || 0) + 1;

        const queueList = current.queueList || [];
        if (patientInfo) {
            queueList.push({
                tokenNumber: nextToken,
                chatId: patientInfo.chatId || null,
                patientName: patientInfo.patientName || 'Patient',
                phone: patientInfo.phone || null,
                status: 'waiting',
                reason: patientInfo.reason || '',
                doctorNotes: '',
                prescriptions: '',
                feeAmount: 0,
                paymentStatus: 'pending',
                paymentMode: null,
                bookedAt: new Date(),
            });
        }

        const updated = {
            ...current,
            lastIssuedToken: nextToken,
            queueList,
            updatedAt: new Date(),
        };
        tx.set(ref, updated, { merge: true });
        return { tokenNumber: nextToken, queueState: updated };
    });

    logger.info(`[QueueService] Issued token #${result.tokenNumber} for ${clinicId}/${department}/${date}`);
    return result;
}

/**
 * Moves a specific token to the front of the line (Priority/Emergency).
 */
async function prioritizeToken(clinicId, department, tokenNumber, date = todayISO()) {
    if (!db) return null;
    const ref = db.collection('queues').doc(queueDocId(clinicId, department, date));

    return db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        if (!doc.exists) throw new Error('Queue not found');

        const current = { ...defaultQueueState(clinicId, department, date), ...doc.data() };
        const priorityQueue = current.priorityQueue || [];

        if (!priorityQueue.includes(tokenNumber) && current.currentToken !== tokenNumber) {
            priorityQueue.push(tokenNumber);
            tx.update(ref, { priorityQueue, updatedAt: new Date() });
        }

        logger.info(`[QueueService] Token #${tokenNumber} prioritized for ${clinicId}/${department}`);
        return { success: true, tokenNumber };
    });
}

/**
 * Advance the "currently being served" token. Checks the priority list
 * first, skips tokens already served out of order, and keeps each
 * queueList entry's `status` in sync (waiting → in-consultation → completed).
 */
async function advanceQueue(clinicId, department, date = todayISO()) {
    if (!db) return defaultQueueState(clinicId, department, date);
    const ref = db.collection('queues').doc(queueDocId(clinicId, department, date));

    return db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        const current = doc.exists
            ? { ...defaultQueueState(clinicId, department, date), ...doc.data() }
            : defaultQueueState(clinicId, department, date);

        let currentToken = current.currentToken || 0;
        let priorityQueue = current.priorityQueue || [];
        let completedTokens = current.completedTokens || [];
        let lastIssued = current.lastIssuedToken || 0;
        const queueList = current.queueList || [];
        const previousCurrent = currentToken;

        if (currentToken > 0 && !completedTokens.includes(currentToken)) {
            completedTokens.push(currentToken);
        }

        if (priorityQueue.length > 0) {
            currentToken = priorityQueue.shift();
        } else {
            currentToken++;
            while (completedTokens.includes(currentToken) && currentToken <= lastIssued) {
                currentToken++;
            }
        }

        if (currentToken > lastIssued && priorityQueue.length === 0) {
            currentToken = lastIssued;
        }

        // Keep queueList entry statuses in sync with the counters above.
        let justCompletedEntry = null;
        for (const entry of queueList) {
            if (entry.tokenNumber === previousCurrent && previousCurrent > 0) {
                entry.status = 'completed';
                justCompletedEntry = entry;
            } else if (entry.tokenNumber === currentToken) {
                entry.status = 'in-consultation';
            }
        }

        // 🔧 CRITICAL SYNC: the patient's own `patients/{chatId}.activeToken`
        // is a SEPARATE copy of this data (kept for fast bot status-replies).
        // Without this, a patient who has already been served keeps showing
        // up as "still waiting" forever — the bot would keep telling them
        // (and telling itself, via the LLM) that they have an active
        // appointment indefinitely. Clearing it here, in the SAME
        // transaction, is what actually closes the loop.
        if (justCompletedEntry && justCompletedEntry.chatId) {
            const patientRef = db.collection('patients').doc(justCompletedEntry.chatId);
            tx.set(patientRef, {
                activeToken: { ...justCompletedEntry, status: 'completed' },
            }, { merge: true });
        }

        const updated = {
            ...current,
            currentToken,
            priorityQueue,
            completedTokens,
            queueList,
            updatedAt: new Date(),
        };

        tx.set(ref, updated, { merge: true });
        return updated;
    });
}

/**
 * Record a manual delay (e.g. "doctor running 30 min late").
 */
async function setDelay(clinicId, department, date = todayISO(), delayMinutes = 0) {
    if (!db) return defaultQueueState(clinicId, department, date);
    const ref = db.collection('queues').doc(queueDocId(clinicId, department, date));
    await ref.set({ delayMinutes, updatedAt: new Date() }, { merge: true });
    return getQueueState(clinicId, department, date);
}

/**
 * Recalibrate the average pace of consultation.
 */
async function setAvgConsultMinutes(clinicId, department, date = todayISO(), minutes) {
    if (!db || !minutes || minutes <= 0) return getQueueState(clinicId, department, date);
    const ref = db.collection('queues').doc(queueDocId(clinicId, department, date));
    await ref.set({ avgConsultMinutes: minutes, updatedAt: new Date() }, { merge: true });
    return getQueueState(clinicId, department, date);
}

/**
 * Fully resets a queue back to zero — clears counters, priority queue,
 * completed tokens, and the queue list. Note: a NEW date automatically
 * starts fresh anyway (the doc id includes the date), so this is only
 * needed to manually clear today's queue mid-day (e.g. after test data).
 * Also clears activeToken for every patient who was in that queue list, so
 * they don't get stuck referencing tokens that no longer exist.
 */
async function resetQueue(clinicId, department, date = todayISO()) {
    if (!db) return defaultQueueState(clinicId, department, date);
    const ref = db.collection('queues').doc(queueDocId(clinicId, department, date));

    return db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        const current = doc.exists ? doc.data() : null;
        const staleChatIds = (current?.queueList || [])
            .filter((e) => e.chatId && e.status !== 'completed')
            .map((e) => e.chatId);

        const fresh = defaultQueueState(clinicId, department, date);
        tx.set(ref, { ...fresh, updatedAt: new Date() });

        for (const chatId of staleChatIds) {
            tx.set(db.collection('patients').doc(chatId), { activeToken: null }, { merge: true });
        }

        logger.info(`[QueueService] Reset queue for ${clinicId}/${department}/${date} (cleared ${staleChatIds.length} stale patient tokens).`);
        return fresh;
    });
}

/**
 * Estimate wait time, accounting for VIP jumpers and completed ghost tokens.
 */
function estimateWait(queueState, tokenNumber) {
    const pace = queueState.avgConsultMinutes || DEFAULT_AVG_CONSULT_MINUTES;
    const delay = queueState.delayMinutes || 0;
    const priorityQueue = queueState.priorityQueue || [];
    const completedTokens = queueState.completedTokens || [];

    if (completedTokens.includes(tokenNumber) || tokenNumber === queueState.currentToken) {
        return 0;
    }

    const priorityIndex = priorityQueue.indexOf(tokenNumber);
    if (priorityIndex !== -1) {
        return (priorityIndex * pace) + delay;
    }

    const position = Math.max(tokenNumber - (queueState.currentToken || 0), 0);
    const priorityCount = priorityQueue.length;

    return ((position + priorityCount) * pace) + delay;
}

/**
 * Book a token for a patient: issues the next token (creating its queueList
 * entry atomically), and mirrors it onto the patient's own record.
 */
async function bookToken({ clinicId, chatId, patientName, phone, department, reason }) {
    const date = todayISO();
    const { tokenNumber, queueState } = await issueToken(clinicId, department, date, {
        chatId, patientName, phone, reason,
    });

    await patients.createOrUpdate(chatId, {
        clinicId,
        activeToken: {
            clinicId,
            department,
            date,
            tokenNumber,
            status: 'waiting',
        },
    });

    return {
        tokenNumber,
        department,
        date,
        currentToken: queueState.currentToken || 0,
        estimatedWaitMinutes: estimateWait(queueState, tokenNumber),
    };
}

/**
 * Look up a patient's current queue status by chatId.
 */
async function getPatientStatus(chatId) {
    const patient = await patients.getById(chatId);
    const activeToken = patient?.activeToken;

    if (!activeToken || activeToken.status !== 'waiting') {
        return null;
    }

    if (activeToken.date !== todayISO()) {
        await patients.createOrUpdate(chatId, {
            activeToken: { ...activeToken, status: 'expired' },
        });
        return null;
    }

    const queueState = await getQueueState(activeToken.clinicId, activeToken.department, activeToken.date);

    // Defensive self-heal: the queue doc's own completedTokens/queueList is
    // the more authoritative record. If it says this token is already done
    // (e.g. an older token issued before the advanceQueue sync fix existed),
    // don't trust the patient's own possibly-stale 'waiting' status.
    const alreadyServed =
        (queueState.completedTokens || []).includes(activeToken.tokenNumber) ||
        (queueState.queueList || []).some((e) => e.tokenNumber === activeToken.tokenNumber && e.status === 'completed');

    if (alreadyServed) {
        await patients.createOrUpdate(chatId, {
            activeToken: { ...activeToken, status: 'completed' },
        });
        return null;
    }

    return {
        ...activeToken,
        currentToken: queueState.currentToken || 0,
        estimatedWaitMinutes: estimateWait(queueState, activeToken.tokenNumber),
    };
}

/**
 * Read-modify-write a single queueList entry (by tokenNumber) — the shared
 * primitive for the Doctor Portal saving notes/prescriptions/payment.
 */
async function updateQueueListEntry(clinicId, department, date, tokenNumber, patch) {
    if (!db) throw new Error('Database not connected');
    const ref = db.collection('queues').doc(queueDocId(clinicId, department, date));

    return db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        if (!doc.exists) throw new Error('Queue not found for this clinic/department/date');

        const current = { ...defaultQueueState(clinicId, department, date), ...doc.data() };
        const queueList = current.queueList || [];
        const idx = queueList.findIndex((e) => e.tokenNumber === Number(tokenNumber));
        if (idx === -1) throw new Error(`Token #${tokenNumber} not found in this queue`);

        queueList[idx] = { ...queueList[idx], ...patch };
        tx.set(ref, { ...current, queueList, updatedAt: new Date() }, { merge: true });
        return queueList[idx];
    });
}

/**
 * All patients currently in `human_handling` state for a given clinic —
 * powers the dashboard's Human Handoff panel.
 */
async function getHumanHandoffPatients(clinicId) {
    if (!db) return [];
    const snapshot = await db.collection('patients')
        .where('clinicId', '==', clinicId)
        .where('currentFlowState', '==', 'human_handling')
        .get();

    return snapshot.docs.map((doc) => {
        const data = doc.data();
        const lastUserMsg = [...(data.conversationHistory || [])].reverse().find((m) => m.role === 'user');
        return {
            id: doc.id,
            patientName: data.name || 'Unknown',
            phone: data.phone || doc.id.replace('@c.us', ''),
            tokenNumber: data.activeToken?.tokenNumber || null,
            lastQuery: lastUserMsg?.content || null,
        };
    });
}

/**
 * Resets a patient's flow state so the bot re-engages after a human has
 * handled their conversation.
 */
async function unmutePatient(clinicId, patientId, phone) {
    if (!db) throw new Error('Database not connected');
    const chatId = patientId || (phone ? `${String(phone).replace('+', '')}@c.us` : null);
    if (!chatId) throw new Error('patientId or phone is required to unmute');

    await patients.createOrUpdate(chatId, { currentFlowState: 'idle' });
    logger.info(`[QueueService] Un-muted ${chatId} for clinic ${clinicId} — bot re-engaged.`);
    return { success: true, chatId };
}

/**
 * Seeds a small demo queue for an empty dashboard — dev/demo convenience
 * only, never called from the real booking flow.
 */
async function seedClinicData(clinicId, department, date = todayISO()) {
    if (!db) throw new Error('Database not connected');
    const ref = db.collection('queues').doc(queueDocId(clinicId, department, date));

    const demoPatients = ['Rahul Sharma', 'Priya Verma', 'Amit Singh'];
    const queueList = demoPatients.map((name, i) => ({
        tokenNumber: i + 1,
        chatId: `demo-${clinicId}-${i + 1}@c.us`,
        patientName: name,
        phone: null,
        status: i === 0 ? 'in-consultation' : 'waiting',
        reason: 'Demo / seeded entry',
        doctorNotes: '',
        prescriptions: '',
        feeAmount: 0,
        paymentStatus: 'pending',
        paymentMode: null,
        bookedAt: new Date(),
    }));

    const seeded = {
        ...defaultQueueState(clinicId, department, date),
        lastIssuedToken: demoPatients.length,
        currentToken: 1,
        queueList,
        updatedAt: new Date(),
    };

    await ref.set(seeded, { merge: true });
    logger.info(`[QueueService] Seeded demo queue for ${clinicId}/${department}/${date}`);
    return seeded;
}

module.exports = {
    todayISO,
    getQueueState,
    issueToken,
    prioritizeToken,
    advanceQueue,
    setDelay,
    setAvgConsultMinutes,
    resetQueue,
    estimateWait,
    bookToken,
    getPatientStatus,
    updateQueueListEntry,
    getHumanHandoffPatients,
    unmutePatient,
    seedClinicData,
};
