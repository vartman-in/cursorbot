// routes/webhook.js
'use strict';

const express = require('express');
const router = express.Router();
const { patients, knowledgeBase, appointments } = require('../services/databaseService');
const { generateResponse, classifyIntent } = require('../services/features/aiIntegration');
const { sendMessage } = require('../services/greenApi');
const { alertStaff } = require('../services/adminAlertService');
const { parseAdminCommand } = require('../services/features/adminsystemprompt');
const { logger } = require('../errorHandler');
const { db } = require('../db');
const queueService = require('../services/queueService');
const { resolveClinicContext } = require('../services/clinicContextService');
const { PatientService } = require('../services/patientService');
const { DEPARTMENTS } = require('../services/appointmentService');
const { getLiveTokenAvailability, buildClosedHoursReply } = require('../services/clinicHoursService');

// Quick keyword pre-check for status queries
const STATUS_PHRASES = [
    'kitna number', 'kaunsa number', 'mera number', 'number kab',
    'kitni der', 'wait time', 'my turn', 'check status', 'what is my status',
];
const STATUS_AMBIGUOUS_WORDS = ['status', 'token', 'queue'];
const STATUS_AMBIGUOUS_MAX_WORDS = 4;

function looksLikeStatusQuery(message) {
    const lower = message.toLowerCase().trim();
    if (STATUS_PHRASES.some((kw) => lower.includes(kw))) return true;

    const wordCount = lower.split(/\s+/).filter(Boolean).length;
    if (wordCount > STATUS_AMBIGUOUS_MAX_WORDS) return false;

    return STATUS_AMBIGUOUS_WORDS.some((kw) => lower.includes(kw));
}

// Wake-word for the admin channel.
const JARVIS_WAKE_WORD = /\bjarvis\b/i;

function containsWakeWord(message) {
    return JARVIS_WAKE_WORD.test(message);
}

function stripWakeWord(message) {
    return message
        .replace(/\bjarvis\b/gi, ' ')
        .replace(/^[\s,:.\-–—]+|[\s,:.\-–—]+$/g, '')
        .trim();
}

// A clinic's REAL department list — prefers what's actually configured on
// the clinic doc, falls back to doctor specializations, and only falls back
// to the generic DEPARTMENTS constant as a last resort. Using the generic
// list as a silent default was the actual root cause of bookings landing in
// the wrong department entirely (e.g. a dental clinic's bookings silently
// going into a "General Medicine" queue nobody was looking at).
function getClinicDepartments(clinicData) {
    if (Array.isArray(clinicData?.departments) && clinicData.departments.length) {
        return clinicData.departments;
    }
    const fromDoctors = (clinicData?.doctors || [])
        .map((d) => d.department || d.specialization)
        .filter(Boolean);
    if (fromDoctors.length) return [...new Set(fromDoctors)];

    return DEPARTMENTS;
}

function resolveDepartment(entities, clinicData) {
    const clinicDepartments = getClinicDepartments(clinicData);
    const requested = (entities?.department || '').trim();
    const match = clinicDepartments.find((d) => d.toLowerCase() === requested.toLowerCase());
    if (match) return match;
    return clinicDepartments[0];
}

// 🕒 Real-Time Clinic Schedule Guard — prevents the bot from handing out a
// live token when nobody's actually at the clinic to serve it. Reads the
// clinic's OWN configured hours (set via /admin/link-clinic) rather than a
// hardcoded value, so this works correctly for every clinic, not just one
// with 8am-8pm Mon-Sat hours. Falls back to that as a sensible default only
// when a clinic hasn't configured its own schedule yet.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getClinicSchedule(clinicData) {
    return {
        openHour: clinicData?.schedule?.openHour ?? 8,
        closeHour: clinicData?.schedule?.closeHour ?? 20,
        closedDays: Array.isArray(clinicData?.schedule?.closedDays) ? clinicData.schedule.closedDays : [0],
    };
}

function formatHour12(h) {
    const period = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}:00 ${period}`;
}

// `now` is injectable for testing — defaults to the real current time.
function isClinicOpen(clinicData, now = new Date()) {
    const nowIST = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const currentDay = nowIST.getDay();   // 0=Sunday..6=Saturday
    const currentHour = nowIST.getHours();
    const { openHour, closeHour, closedDays } = getClinicSchedule(clinicData);

    if (closedDays.includes(currentDay)) return false;
    if (currentHour < openHour || currentHour >= closeHour) return false;
    return true;
}

function buildClosedMessage(clinicData) {
    const { openHour, closeHour, closedDays } = getClinicSchedule(clinicData);
    const openDayNames = DAY_NAMES.filter((_, i) => !closedDays.includes(i));
    const daysText = openDayNames.length === 7
        ? 'every day'
        : (openDayNames.length === 6 && !openDayNames.includes('Sunday'))
            ? 'Monday to Saturday'
            : openDayNames.join(', ');

    return `🌙 We're currently closed. Our hours are ${formatHour12(openHour)}–${formatHour12(closeHour)}, ${daysText}.\n\n` +
        `Please message us again during those hours and I'll get you a live token right away.`;
}

const ADMIN_HELP_TEXT =
    `🤖 *Jarvis admin commands:*\n` +
    `• "Jarvis, next" — advance the queue\n` +
    `• "Jarvis, delay 20" — report a delay (minutes)\n` +
    `• "Jarvis, status" — check the live queue\n` +
    `• "Jarvis, reset the queue" — clear today's queue back to zero\n` +
    `• "Jarvis, kal shift kardo" — bulk reschedule today to tomorrow\n` +
    `• "Jarvis, resolve 919876543210" — un-mute a patient\n` +
    `• "Jarvis, help" — show this list\n\n` +
    `_Note: You can also talk to me in natural Hindi/English!_`;

/**
 * AI Admin Command Channel (LLM Powered)
 */
async function tryHandleAdminCommand({ senderPhone, chatId, message, clinicData, instanceId }) {
    // 1. Gather all authorized numbers into an array (DB + Env Vars + Hardcoded Dev Number)
    const allowedAdmins = [
        clinicData?.adminPhone,
        clinicData?.profile?.phone,
        clinicData?.doctorPhone,
        process.env.DEFAULT_ADMIN_PHONE,
        process.env.ADMIN_PHONE_NUMBER,
        "919649147526" // <-- Your testing number explicitly whitelisted
    ].map(phone => String(phone || '').replace(/\D/g, '')).filter(Boolean);

    // 2. Verify sender is in the authorized list
    const normalizedSender = String(senderPhone).replace(/\D/g, '');
    if (!allowedAdmins.includes(normalizedSender)) {
        return false; 
    }

    const clinicId = clinicData?.clinicId || (instanceId ? String(instanceId) : null);
    if (!clinicId) return false;
    const defaultDept = getClinicDepartments(clinicData)[0];

    // Check for Wake Word. If missing, let them interact as a normal patient.
    const wakeWordUsed = containsWakeWord(message);
    if (!wakeWordUsed) return false;

    const instruction = stripWakeWord(message).trim();

    // If they just said "Jarvis", send help text
    if (!instruction || instruction.toLowerCase() === 'help') {
        await sendMessage(chatId, ADMIN_HELP_TEXT);
        return true;
    }

    // 🧠 SEND TO LLM FOR INTENT PARSING
    const aiDecision = await parseAdminCommand(instruction, clinicData);

    if (!aiDecision) {
        await sendMessage(chatId, "⚠️ I encountered an error processing your command.");
        return true;
    }

    // Execute the backend function based on what the LLM decided
    switch (aiDecision.command) {
        case 'set_delay':
            const mins = aiDecision.args.minutes || 15; // fallback to 15 if LLM misses it
            await queueService.setDelay(clinicId, defaultDept, undefined, mins);
            await sendMessage(chatId, `✅ Noted! The queue is delayed by ${mins} mins. I am updating wait estimates.`);
            return true;

        case 'advance_queue':
            const updated = await queueService.advanceQueue(clinicId, defaultDept);
            await sendMessage(chatId, `✅ Advanced queue. Now serving Token #${updated.currentToken}.`);
            return true;

        case 'prioritize_token':
            const urgentToken = aiDecision.args.token_number;
            
            if (typeof queueService.prioritizeToken === 'function') {
                await queueService.prioritizeToken(clinicId, defaultDept, urgentToken);
                await sendMessage(chatId, `🚨 Token #${urgentToken} has been moved to the front of the line. They are now next to be served.`);
            } else {
                await sendMessage(chatId, `⚠️ The backend function 'prioritizeToken' is not yet built in queueService.js.`);
            }
            return true;

        case 'bulk_reschedule':
            const fromDate = aiDecision.args.from_date;
            const toDate = aiDecision.args.to_date;
            
            if (typeof queueService.bulkRescheduleAndNotify === 'function') {
                await queueService.bulkRescheduleAndNotify(clinicId, fromDate, toDate); 
                await sendMessage(chatId, `✅ Done. All remaining appointments for ${fromDate} have been shifted to ${toDate}. Patients are being notified.`);
            } else {
                await sendMessage(chatId, `⚠️ The 'bulkRescheduleAndNotify' function is not yet built in queueService.js.`);
            }
            return true;

        case 'get_status':
            const liveState = await queueService.getQueueState(clinicId, defaultDept);
            await sendMessage(
                chatId,
                `📋 *${defaultDept}* — Now serving #${liveState.currentToken || 0} of #${liveState.lastIssuedToken || 0} issued.\n` +
                `Pace: ~${liveState.avgConsultMinutes || 10} min/patient. Delay: +${liveState.delayMinutes || 0} min.`
            );
            return true;

        case 'reset_queue':
            await queueService.resetQueue(clinicId, defaultDept);
            await sendMessage(chatId, `✅ Queue reset. Token counter is back to zero for ${defaultDept}.`);
            return true;

        case 'resolve_patient':
            let targetPhone = aiDecision.args.phone || aiDecision.args.patient_phone;
            if (!targetPhone) {
                 await sendMessage(chatId, `⚠️ Please specify the patient's phone number you want to un-mute.`);
                 return true;
            }
            
            targetPhone = String(targetPhone).replace(/\D/g, '');
            const targetChatId = `${targetPhone}@c.us`;
            
            const targetPatient = await patients.getById(targetChatId);
            if (!targetPatient) {
                await sendMessage(chatId, `⚠️ Could not find a patient record for +${targetPhone}.`);
                return true;
            }

            await patients.updateFlowState(targetChatId, 'idle');
            await sendMessage(chatId, `✅ Patient +${targetPhone} has been un-muted and reset to 'idle'. I will now respond to their messages again.`);
            return true;

        case 'unknown':
        default:
            await sendMessage(chatId, aiDecision.reply || "I didn't quite catch that. You can tell me to delay the queue, shift appointments, resolve a patient, or advance the line.");
            return true;
    }
}

/**
 * AI Receptionist Webhook Handler — Multi-Tenant & Conversational Memory Enabled
 * Processes incoming WhatsApp messages via Green API
 */
router.post('/', async (req, res) => {
    // ACK immediately to Green API to prevent retries
    res.status(200).json({ status: 'received' });

    try {
        const body = req.body;
        
        // Skip messages we sent or system events
        if (body.typeWebhook !== 'incomingMessageReceived') {
            return;
        }

        const chatId = body.senderData.chatId;
        const senderPhone = body.senderData.sender;
        const patientMessage = body.messageData.textMessageData?.textMessage || 
                               body.messageData.extendedTextMessageData?.text || "";

        // 🚀 EXTRACT THE INSTANCE ID FOR THE MULTI-TENANT CONTEXT
        const instanceId = body.instanceData?.idInstance;

        if (!patientMessage.trim()) {
            logger.info(`[Webhook] No text content in message from ${senderPhone}`);
            return;
        }

        logger.info(`[Webhook] Processing message from ${senderPhone} on Instance ${instanceId}: "${patientMessage.slice(0, 50)}..."`);

        // 1. DYNAMIC TENANT RESOLUTION
        // The resolver returns the actual Firestore clinic document ID. A raw
        // Green API instance ID must never become a queue ID because the
        // dashboard reads queue documents by clinic ID.
        const clinicData = await resolveClinicContext(instanceId);

        // 1b. ADMIN COMMAND CHANNEL (Now LLM Powered)
        const handledAsAdmin = await tryHandleAdminCommand({ senderPhone, chatId, message: patientMessage, clinicData, instanceId });
        if (handledAsAdmin) {
            logger.info(`[Webhook] Handled admin LLM command from ${senderPhone}`);
            return;
        }

        // A missing mapping must be visible and safe. It must never fall back
        // to a raw Green API instance ID because that creates a second queue
        // that the clinic dashboard cannot see.
        if (!clinicData) {
            logger.error(`[Webhook] No clinic mapping for Green API instance ${instanceId}; refusing patient action.`);
            await sendMessage(chatId, 'Namastey sir, clinic configuration is temporarily unavailable. Kripya clinic reception se sampark karein.');
            return;
        }

        // 2. CONVERSATIONAL MEMORY
        let patient = await patients.getById(chatId);
        let responseText = "";
        let nextState = 'idle';

        // CASE A: NEW PATIENT (Ask for Name)
        if (!patient) {
            patient = await patients.createOrUpdate(chatId, {
                name: null,
                phone: senderPhone,
                clinicId: clinicData?.clinicId || null,
                conversationHistory: [],
                currentFlowState: 'awaiting_name'
            });
            logger.info(`[Webhook] Created new patient record for ${chatId}, awaiting name.`);
            
            responseText = "Hello! Welcome to our clinic. To get started, could you please share your full name?";
            
            await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
            await patients.updateFlowState(chatId, 'awaiting_name');
            await sendMessage(chatId, responseText);
            return;
        }

        // CASE B: CAPTURING NAME FROM NEW PATIENT
        if (patient.currentFlowState === 'awaiting_name' || !patient.name) {
            const cleanedName = patientMessage.trim();
            await patients.createOrUpdate(chatId, { name: cleanedName });
            
            responseText = `Thank you, ${cleanedName}! How can we assist you today? Would you like to check doctor availability or book an appointment?`;
            
            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
            await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
            await patients.updateFlowState(chatId, 'idle');
            await sendMessage(chatId, responseText);
            return;
        }

        // ==========================================
        // 🛑 HUMAN HANDOFF MUTE GUARD (WITH ACKNOWLEDGEMENT)
        // ==========================================
        if (patient.currentFlowState === 'human_handling') {
            logger.info(`[Webhook] Message received from ${chatId} during human_handling. Notifying patient.`);
            
            const handoffNotice = "📬 Your message has been forwarded to our clinic staff. A team member will reply to you here shortly.";
            
            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
            await patients.addMessageToHistory(chatId, { role: 'assistant', content: handoffNotice });
            
            await sendMessage(chatId, handoffNotice);
            return;
        }

        // CASE C: RETURNING PATIENT INTERACTION
        const patientName = patient.name;
        logger.info(`[Webhook] Recognized returning patient: ${patientName} (${chatId})`);

        // Backfill clinicId for patients created before this field existed —
        // needed for the dashboard's human-handoff query to find them.
        const resolvedClinicIdForPatient = clinicData?.clinicId || null;
        if (!patient.clinicId && resolvedClinicIdForPatient) {
            await patients.createOrUpdate(chatId, { clinicId: resolvedClinicIdForPatient });
            patient.clinicId = resolvedClinicIdForPatient;
        }

        // 3. Classify Intent using Groq
        const classification = await classifyIntent(patientMessage, patient.conversationHistory.slice(-3));
        const { intent: classifiedIntent, entities } = classification;
        
        const intent = looksLikeStatusQuery(patientMessage) ? 'check_status' : classifiedIntent;
        logger.info(`[Webhook] Classified intent: ${intent} for ${chatId}`);

        // 4. Handle based on intent and current state
        nextState = patient.currentFlowState;

        // Fetch the patient's real, live token status ONCE — reused by every
        // branch below instead of each one independently guessing or (worse)
        // letting the LLM free-associate appointment details from memory.
        const clinicId = clinicData?.clinicId || null;
        const liveStatus = clinicId ? await queueService.getPatientStatus(chatId) : null;

        // Emergency Detection & Human Handoff
        const isEmergency = intent === 'human_handoff' || 
                           (entities.symptoms && entities.symptoms.some(s => 
                               ['chest pain', 'bleeding', 'breathing', 'unconscious', 'emergency'].includes(s.toLowerCase())
                           ));

        // ==========================================
        // 🛑 EMERGENCY LOOP BYPASS
        // ==========================================
        if (isEmergency) {
            responseText = "🚨 *URGENT:* I've detected a situation that may require immediate medical attention. \n\nI am alerting our human medical staff right now. If this is a life-threatening emergency, please call emergency services immediately.";
            nextState = 'human_handling';
            
            const transcript = patient.conversationHistory.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n');
            await alertStaff(
                chatId, 
                patientName, 
                intent === 'human_handoff' ? 'Human Handoff Requested' : 'Medical Emergency Detected', 
                transcript, 
                clinicData?.clinicId || instanceId
            );

            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
            await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
            await patients.updateFlowState(chatId, nextState);
            
            await sendMessage(chatId, responseText);
            logger.info(`[Webhook] Emergency response sent to ${chatId}. Halted further processing.`);
            return; 
        }
        
        // Real-Time Status Query
        else if (intent === 'check_status') {
            if (!liveStatus) {
                responseText = "You don't have an active token right now. Would you like to book one?";
            } else {
                const waiting = Math.max(liveStatus.tokenNumber - liveStatus.currentToken, 0);
                responseText = `🎫 *Your Token:* #${liveStatus.tokenNumber} (${liveStatus.department})\n` +
                    `👉 *Now Serving:* #${liveStatus.currentToken}\n` +
                    (waiting > 0
                        ? `⏳ *${waiting} patient(s) ahead of you* — estimated wait: ~${liveStatus.estimatedWaitMinutes} min.`
                        : `✅ You're next — please head to the clinic now if you haven't already.`);
            }
            nextState = 'idle';
        }

        // Patient wants to cancel their current visit
        else if (intent === 'cancel_appointment') {
            if (!liveStatus) {
                responseText = "You don't currently have an active token for me to cancel. Would you like to book one instead?";
                nextState = 'idle';
            } else {
                await PatientService.handlePatientAction({ chatId, action: 'cancel', reason: patientMessage });
                // handlePatientAction already sends its own WhatsApp confirmation —
                // save history and stop here so the patient isn't messaged twice.
                await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
                await patients.addMessageToHistory(chatId, { role: 'assistant', content: '[Appointment cancelled at patient\'s request]' });
                await patients.updateFlowState(chatId, 'idle');
                logger.info(`[Webhook] Cancelled appointment for ${chatId} via chat.`);
                return;
            }
        }

        // Patient wants to change their visit — honest about what this system
        // can actually do (same-day sequential tokens, not date/time slots),
        // rather than pretending to reschedule to a specific new slot.
        else if (intent === 'modify_appointment') {
            if (!liveStatus) {
                responseText = "You don't currently have an active token to modify. Would you like to book one?";
            } else {
                responseText = `You currently have Token #${liveStatus.tokenNumber} for ${liveStatus.department} today — ` +
                    `this system issues live same-day tokens rather than fixed time slots, so I can't move you to a specific new time. ` +
                    `If you'd like, just say "cancel" and I'll cancel this token so you can book a fresh one whenever suits you.`;
            }
            nextState = 'idle';
        }
        
        // Live Digital Token Engine
        else if (intent === 'book_appointment') {
            if (liveStatus) {
                const waiting = Math.max(liveStatus.tokenNumber - liveStatus.currentToken, 0);
                responseText = `You already have Token #${liveStatus.tokenNumber} for ${liveStatus.department} today.\n` +
                    `Now serving #${liveStatus.currentToken}` +
                    (waiting > 0 ? ` — about ${liveStatus.estimatedWaitMinutes} min to go.` : `. You're next!`);
                nextState = 'idle';
            } else if (!clinicId) {
                const history = (patient.conversationHistory || []).map(m => ({ role: m.role, content: m.content }));
                history.push({ role: 'user', content: patientMessage });
                responseText = await generateResponse(history, instanceId, clinicData);
                nextState = 'booking_in_progress';
            } else if (!isClinicOpen(clinicData)) {
                // 🛑 Don't hand out a live token when nobody's there to serve it.
                responseText = buildClosedMessage(clinicData);
                nextState = 'idle';
            } else {
                // Server-side guardrail: the LLM may describe timings, but only
                // this deterministic check may authorize a live token.
                const availability = getLiveTokenAvailability(clinicData);
                if (!availability.canIssueLiveToken) {
                    responseText = buildClosedHoursReply(clinicData);
                    nextState = 'idle';
                    logger.info(`[Booking] Denied live token for ${chatId}: clinic ${clinicId} is ${availability.reason}.`);
                } else {
                    const department = resolveDepartment(entities, clinicData);
                    const booking = await queueService.bookToken({
                        clinicId, chatId, patientName, department,
                        phone: senderPhone,
                        reason: (entities?.symptoms || []).join(', ') || patientMessage.slice(0, 200),
                    });
                    const waiting = Math.max(booking.tokenNumber - booking.currentToken, 0);

                    responseText = `✅ *Token #${booking.tokenNumber} booked* for ${department}.\n` +
                        `👉 Now serving: #${booking.currentToken}\n` +
                        (waiting > 0
                            ? `⏳ Estimated wait: ~${booking.estimatedWaitMinutes} min.\n`
                            : `You're next in line!\n`) +
                        `Reply "Status" anytime to check your position.`;
                    nextState = 'idle';
                }
            }
        }
        
        // Dynamic LLM Response Generation — grounded in the SAME live status
        // fetched above, so the model can't invent or recall stale token/wait
        // numbers from old conversation history (this was a real bug: patients
        // were told about appointments/delays that were no longer accurate).
        else {
            const history = (patient.conversationHistory || []).map(m => ({ role: m.role, content: m.content }));
            history.push({ role: 'user', content: patientMessage });
            
            const liveStatusText = liveStatus
                ? `The patient CURRENTLY has an active Token #${liveStatus.tokenNumber} for ${liveStatus.department} today. ` +
                  `Now serving #${liveStatus.currentToken}. Estimated wait: ~${liveStatus.estimatedWaitMinutes} min. ` +
                  `Only use these exact numbers if you mention their appointment — never invent or recall different figures from earlier in the conversation.`
                : `The patient does NOT currently have any active token or appointment. If earlier conversation history mentions one, it is no longer valid — do not reference old token numbers, wait times, or delays as if still current.`;

            responseText = await generateResponse(history, instanceId, clinicData, liveStatusText);
        }

        // 5. Loop guard
        const rawResponseText = responseText;
        const loopState = patient._loopGuard || { rawResponse: null, count: 0 };
        const repeatCount = loopState.rawResponse === rawResponseText ? loopState.count + 1 : 1;

        if (repeatCount === 2) {
            responseText = "Sorry, I may have misunderstood your last message. Could you rephrase — e.g. a payment question, directions, or your token status?";
        } else if (repeatCount >= 3) {
            responseText = "I'm sorry, I think I'm misunderstanding your question. I'm connecting you with our clinic staff now so they can help directly.";
            nextState = 'human_handling';
            const transcript = patient.conversationHistory.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
            await alertStaff(chatId, patientName, 'Bot Stuck In Loop — Needs Human', transcript, clinicData?.clinicId || instanceId);
        }

        await patients.createOrUpdate(chatId, { _loopGuard: { rawResponse: rawResponseText, count: repeatCount } });

        // 6. Update Database (History & State)
        await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
        await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
        await patients.updateFlowState(chatId, nextState);

        // 7. Send Response via Green API
        await sendMessage(chatId, responseText);
        logger.info(`[Webhook] Response sent to ${chatId}`);

    } catch (error) {
        logger.error('[Webhook] Error:', error);
    }
});

// Health check
router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'clinic-ai-receptionist', uptime: process.uptime() });
});

module.exports = router;
