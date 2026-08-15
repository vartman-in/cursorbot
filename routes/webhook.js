// routes/webhook.js
'use strict';

const express = require('express');
const router = express.Router();
const { patients, knowledgeBase, appointments } = require('../services/databaseService');
const { generateResponse, classifyIntent } = require('../services/features/aiIntegration');
const { sendMessage, sendButtons, sendListMessage } = require('../services/greenApi');
const { alertStaff } = require('../services/adminAlertService');
const { parseAdminCommand } = require('../services/features/adminsystemprompt');
const { logger } = require('../errorHandler');
const { db } = require('../db');
const queueService = require('../services/queueService');
const { resolveClinicContext } = require('../services/clinicContextService');
const { PatientService } = require('../services/patientService');
const {
    DEPARTMENTS,
    getSlotsForDate,
    getAvailableSlots,
    getNextAvailableDates,
    bookFutureAppointment,
    getFutureAppointmentForPatient,
    rescheduleFutureAppointment,
    displaySlot,
} = require('../services/appointmentService');
const { getLiveTokenAvailability, buildClosedHoursReply } = require('../services/clinicHoursService');
const { triageMessage, getEmergencyReply, getUrgentReply } = require('../services/triageService');

// Quick keyword pre-check for status queries
const STATUS_PHRASES = [
    'kitna number', 'kaunsa number', 'mera number', 'number kab',
    'kitni der', 'wait time', 'my turn', 'check status', 'what is my status',
];
const STATUS_AMBIGUOUS_WORDS = ['status', 'token', 'queue'];
const STATUS_AMBIGUOUS_MAX_WORDS = 4;

function looksLikeStatusQuery(message) {
    const lower = message.toLowerCase().trim();
    // If the patient is complaining or stating they didn't book, it's NOT a status query
    if (/(booking|book|nahi|bula|bola|kiya|karna)\b/i.test(lower)) {
        return false;
    }
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

function istDateIso(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysIso(date, days) {
    const target = new Date(`${date}T00:00:00Z`);
    target.setUTCDate(target.getUTCDate() + days);
    return target.toISOString().slice(0, 10);
}

function parseAppointmentDate(message, now = new Date()) {
    const input = String(message || '').trim().toLowerCase();
    const direct = input.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (direct) return direct[1];

    const today = istDateIso(now);
    if (/\b(aaj|today)\b/.test(input)) return today;
    if (/\b(kal|tomorrow)\b/.test(input)) return addDaysIso(today, 1);

    // Weekday & Relative Day mapping (e.g. "next saturday", "aagle shanivar", "sunday")
    const weekdays = {
        sunday: 0, ravivar: 0, ravivaar: 0, itwar: 0,
        monday: 1, somvaar: 1, somwar: 1,
        tuesday: 2, mangalvaar: 2, mangalwar: 2,
        wednesday: 3, budhvaar: 3, budhwar: 3,
        thursday: 4, guruvaar: 4, guruwar: 4,
        friday: 5, shukravaar: 5, shukrawar: 5,
        saturday: 6, shanivaar: 6, shaniwar: 6
    };

    const weekdayRegex = /\b(sunday|ravivar|ravivaar|itwar|monday|somvaar|somwar|tuesday|mangalvaar|mangalwar|wednesday|budhvaar|budhwar|thursday|guruvaar|guruwar|friday|shukravaar|shukrawar|saturday|shanivaar|shaniwar)\b/i;
    const weekdayMatch = input.match(weekdayRegex);
    if (weekdayMatch) {
        const targetDayIndex = weekdays[weekdayMatch[1].toLowerCase()];
        const currentDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const currentDayIndex = currentDate.getDay();
        
        let diff = targetDayIndex - currentDayIndex;
        const isNext = /\b(next|aagla|aagle|upcoming)\b/.test(input);
        
        if (diff <= 0 || isNext) {
            diff += 7;
        }
        
        const targetDate = new Date(currentDate);
        targetDate.setDate(currentDate.getDate() + diff);
        return targetDate.toISOString().slice(0, 10);
    }

    // Accept patient-friendly dates such as "12 August", "12 Aug 2026", and
    // "August 12". The date must still be validated by appointmentService
    // before a slot is shown or reserved.
    const monthNames = {
        jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
        apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
        aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
        nov: 10, november: 10, dec: 11, december: 11,
    };
    const dayFirst = input.match(/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s*,?\s*(20\d{2}))?\b/i);
    const monthFirst = input.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:\s*,?\s*(20\d{2}))?\b/i);
    const match = dayFirst || monthFirst;
    if (!match) return null;

    const day = Number(dayFirst ? match[1] : match[2]);
    const monthWord = String(dayFirst ? match[2] : match[1]).toLowerCase();
    const year = Number(match[3] || today.slice(0, 4));
    const month = monthNames[monthWord];
    if (!Number.isInteger(day) || month === undefined || day < 1 || day > 31) return null;

    const candidate = new Date(Date.UTC(year, month, day));
    if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month || candidate.getUTCDate() !== day) return null;
    return candidate.toISOString().slice(0, 10);
}

function parseAppointmentTime(message, availableSlots = []) {
    const cleanMessage = String(message || '').trim().toLowerCase().replace(/^slot_/, '');
    if (availableSlots.includes(cleanMessage)) return cleanMessage;

    const input = cleanMessage;
    const match = input.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|baje)?\b/);
    if (!match) return null;

    const rawHour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const suffix = (match[3] || '').replace(/\./g, '');
    if (minute > 59 || rawHour > 23 || rawHour < 0) return null;

    const candidates = [];
    if (suffix === 'pm' && rawHour <= 12) {
        candidates.push(rawHour === 12 ? 12 : rawHour + 12);
    } else if (suffix === 'am' && rawHour <= 12) {
        candidates.push(rawHour === 12 ? 0 : rawHour);
    } else if (suffix === 'baje' || !suffix) {
        // Prefer a listed slot when the patient writes a familiar short form
        // such as "10 baje", "10 am", or simply "10".
        if (rawHour <= 12) {
            candidates.push(rawHour === 12 ? 12 : rawHour, rawHour === 12 ? 0 : rawHour + 12);
        } else {
            candidates.push(rawHour);
        }
    } else {
        return null;
    }

    const formatted = candidates.map((hour) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    const listed = formatted.find((time) => availableSlots.includes(time));
    return listed || formatted[0] || null;
}

function parseLatestAppointmentTime(message, availableSlots = []) {
    const candidates = [...String(message || '').matchAll(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|baje)\b/gi)];
    for (const candidate of candidates.reverse()) {
        const parsed = parseAppointmentTime(candidate[0], availableSlots);
        if (parsed) return parsed;
    }
    return parseAppointmentTime(message, availableSlots);
}

function formatIsoDateForPatient(isoDate) {
    if (!isoDate) return null;
    const today = istDateIso();
    const tomorrow = addDaysIso(today, 1);
    
    let prefix = '';
    if (isoDate === today) prefix = 'Aaj ';
    else if (isoDate === tomorrow) prefix = 'Kal ';
    
    const [year, month, day] = isoDate.split('-').map(Number);
    const dateObj = new Date(Date.UTC(year, month - 1, day));
    const formatted = new Intl.DateTimeFormat('en-IN', { 
        timeZone: 'Asia/Kolkata', 
        weekday: 'long',
        day: 'numeric', 
        month: 'long'
    }).format(dateObj);
    
    return `${prefix}(${formatted})`;
}

function appointmentDatePrompt(nextOpening) {
    const opening = nextOpening ? `${nextOpening.year}-${String(nextOpening.month).padStart(2, '0')}-${String(nextOpening.day).padStart(2, '0')}` : null;
    const displayOpening = formatIsoDateForPatient(opening);
    return `Namastey sir, abhi clinic hours ke bahar live token issue nahi ho sakta. Aap future appointment book kar sakte hain. ` +
        `Kripya preferred date bhejein—for example, “12 August”, “kal”, ya “YYYY-MM-DD”${displayOpening ? ` (next opening: ${displayOpening})` : ''}.`;
}

function wantsClinicalAppointment(message) {
    const lower = String(message || '').toLowerCase();
    // Queries about timing, availability, fees, or location are NOT booking intents
    if (/(timing|time|timing kya|kab (khulta|band|aate|beth|baith|milte|milenge)|fees|address|kahan|charges|price|kitna)/i.test(lower)) {
        return false;
    }
    return /\b(appointment|book|booking|consultation|consult|slot|token chahiye|appointment book|dikhana hai|milna hai)\b/i.test(lower);
}

function isAffirmative(message) {
    const input = String(message || '').trim().toLowerCase().replace(/[.!]/g, '');
    // Support numerical IDs or Poll Option names
    if (input === 'confirm_yes' || input === '1' || input.includes('✅') || input.includes('confirm')) return true;
    return /^\s*(yes|y|haan|ha|han|ji|theek hai|thik hai|book|book karo|kar do)\s*[.!]?\s*$/i.test(input);
}

// Only clear a scheduling flow for an unambiguous cancellation command. Hindi
// negations such as “emergency nahi hai” are common medical context and must
// never silently cancel a pending appointment.
function isExplicitAppointmentCancellation(message) {
    const input = String(message || '').trim().toLowerCase().replace(/[.!]/g, '');
    // Support numerical IDs or Poll Option names
    if (input === 'confirm_no' || input === '2' || input.includes('❌') || input.includes('cancel')) return true;
    return /^(cancel|cancel appointment|cancel booking|booking cancel(?: karo)?|appointment cancel(?: karo)?|mujhe cancel karna hai|nahi chahiye)$/.test(input);
}

const PENDING_APPOINTMENT_OFFER_TTL_MS = 10 * 60 * 1000;

function buildPendingAppointmentOffer({ clinicId, department, date, time, doctorName = null, now = new Date() }) {
    const offeredAt = new Date(now);
    return {
        clinicId: String(clinicId),
        department,
        date,
        time,
        doctorName: doctorName || null,
        offeredAt: offeredAt.toISOString(),
        expiresAt: new Date(offeredAt.getTime() + PENDING_APPOINTMENT_OFFER_TTL_MS).toISOString(),
    };
}

function isPendingAppointmentOfferValid(offer, now = new Date()) {
    if (!offer?.clinicId || !offer?.department || !offer?.date || !offer?.time || !offer?.expiresAt) return false;
    return new Date(offer.expiresAt).getTime() > new Date(now).getTime();
}

function confirmsPendingAppointmentOffer(message, offer) {
    if (!isPendingAppointmentOfferValid(offer)) return false;
    if (isAffirmative(message)) return true;
    return parseAppointmentTime(message, [offer.time]) === offer.time;
}

function wantsEarliestAvailableAppointment(message) {
    return /\b(next available|earliest|first available|next slot|jaldi|soon|kab|when|pehla|pehli)\b/i.test(String(message || ''));
}

function extractAppointmentId(message) {
    const input = String(message || '');
    const labelled = input.match(/\bappointment\s*(?:id|number|no\.?|reference)?\s*[:#-]?\s*([A-Za-z0-9_-]{10,})\b/i);
    if (labelled) return labelled[1];
    const standalone = input.match(/\b([A-Za-z0-9_-]{16,})\b/);
    return standalone ? standalone[1] : null;
}

function isFutureAppointmentChangeRequest(message) {
    return /\b(reschedule|modify|change|move|shift|reschedule karna|time change|date change)\b/i.test(String(message || ''));
}

async function findNextAvailableAppointmentOffer({ clinicId, clinicData, department, doctorName = null, fromDate }) {
    const dates = await getNextAvailableDates({ clinicData, fromDate, days: 14 });
    for (const date of dates) {
        const slots = await getAvailableSlots({ clinicId, clinicData, department, doctorName, date });
        if (slots.length) {
            return buildPendingAppointmentOffer({ clinicId, department, doctorName, date, time: slots[0] });
        }
    }
    return null;
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
        
        // Skip messages we sent or system events (Allow incoming messages and poll updates)
        if (body.typeWebhook !== 'incomingMessageReceived' && body.typeWebhook !== 'pollUpdateMessage') {
            return;
        }

        const chatId = body.senderData.chatId;
        const senderPhone = body.senderData.sender;
        const messageData = body.messageData || {};
        
        let patientMessage = "";

        // 🚀 HANDLE WHATSAPP POLL VOTES (Modern alternative to buttons)
        if (body.typeWebhook === 'pollUpdateMessage' && body.pollUpdateMessageData) {
            const pollUpdateData = body.pollUpdateMessageData;
            // Extract the option name selected by the user
            // In a single-choice poll, we look for the option the sender voted for
            if (pollUpdateData.votes && Array.isArray(pollUpdateData.votes)) {
                const vote = pollUpdateData.votes.find(v => 
                    v.optionVoters && v.optionVoters.includes(senderPhone)
                );
                if (vote) {
                    patientMessage = vote.optionName;
                    logger.info(`[Webhook] Extracted poll vote from ${senderPhone}: "${patientMessage}"`);
                }
            }
        } else {
            // Standard message extraction
            patientMessage = 
                messageData.textMessageData?.textMessage || 
                messageData.extendedTextMessageData?.text || 
                messageData.buttonsResponseMessageData?.selectedButtonId ||
                messageData.buttonsResponseMessageData?.selectedButtonText ||
                messageData.listResponseMessageData?.selectedRowId ||
                messageData.listResponseMessageData?.title ||
                messageData.fileMessageData?.caption ||
                "";
        }

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
            
            responseText = `Namaste, ${cleanedName}! 🙏 City Health Clinic mein aapka swagat hai. Aaj main aapki kaise madad kar sakti hoon?\n\n` +
                `*Options:*\n` +
                `1. 📅 Token book karein\n` +
                `2. 🎫 Token status check karein\n` +
                `3. ⏰ Timings, fees & location`;
            
            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
            await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
            await patients.updateFlowState(chatId, 'idle');
            
            await sendButtons(chatId, responseText, [
                { id: '1', text: '📅 Token book karein' },
                { id: '2', text: '🎫 Token status check karein' },
                { id: '3', text: '⏰ Timings, fees & location' }
            ], clinicData?.clinic_info?.name || 'City Health Clinic');
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

        // Consent controls are deterministic and apply before any LLM call.
        // STOP suppresses non-essential outreach; START restores consent.
        if (/^\s*(stop|unsubscribe|opt[ -]?out|band karo)\s*$/i.test(patientMessage)) {
            responseText = 'Aapko non-essential WhatsApp updates bhejna band kar diya gaya hai. Zaroori appointment messages ke liye aap kabhi bhi START reply kar sakte hain.';
            await patients.createOrUpdate(chatId, { communicationConsent: false, consentUpdatedAt: new Date() });
            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
            await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
            await sendMessage(chatId, responseText);
            return;
        }
        if (/^\s*(start|subscribe)\s*$/i.test(patientMessage)) {
            responseText = 'Thank you. Aapke WhatsApp updates phir se enabled hain.';
            await patients.createOrUpdate(chatId, { communicationConsent: true, consentUpdatedAt: new Date() });
            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
            await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
            await sendMessage(chatId, responseText);
            return;
        }
        logger.info(`[Webhook] Recognized returning patient: ${patientName} (${chatId})`);

        // Backfill clinicId for patients created before this field existed —
        // needed for the dashboard's human-handoff query to find them.
        const resolvedClinicIdForPatient = clinicData?.clinicId || null;
        if (resolvedClinicIdForPatient && patient.clinicId !== resolvedClinicIdForPatient) {
            logger.info(`[Webhook] Synchronizing clinicId for patient ${chatId}: ${patient.clinicId} -> ${resolvedClinicIdForPatient}`);
            await patients.createOrUpdate(chatId, { clinicId: resolvedClinicIdForPatient });
            patient.clinicId = resolvedClinicIdForPatient;
        }

        const clinicId = clinicData?.clinicId || null;
        const liveStatus = clinicId ? await queueService.getPatientStatus(chatId) : null;
        const entities = {};

        // 3. Classify Intent using Groq (Tiered Routing)
        const classification = await classifyIntent(patientMessage, patient.conversationHistory.slice(-3));
        const classifiedIntent = classification.intent || 'unknown';
        const classifiedIntents = classification.intents || [classifiedIntent];
        const routingTier = classification.routing_tier || 2;

        // Handle technical 401 errors early
        if (classifiedIntents.includes('error_401')) {
            responseText = "⚠️ *Technical Configuration Error*: The bot's AI engine is returning a 401 Unauthorized error. Please check the GROQ_API_KEY or OPENAI_API_KEY in your Render environment variables.";
            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
            await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
            await sendMessage(chatId, responseText);
            
            const transcript = patient.conversationHistory.slice(-3).map(m => `${m.role}: ${m.content}`).join('\n');
            await alertStaff(chatId, patientName, 'Critical Error: 401 Invalid API Key', transcript, clinicData?.clinicId || instanceId);
            return;
        }

        // Administrative vs Clinical splitting (Tier 3 Triage):
        const isReportRequest = classifiedIntents.includes('report_status') || /\b(pdf|report|invoice|bill|receipt|result|lab result|bheji nahi|aayi nahi)\b/i.test(patientMessage);
        
        // Safety Screening
        const safetyScreen = triageMessage(patientMessage);
        const isEmergency = routingTier === 3 && (classifiedIntents.includes('emergency') || safetyScreen.level === 'emergency');
        const hasMedicalQuery = (routingTier === 3 && classifiedIntents.includes('medical_query')) || (!isReportRequest && /\b(fasting|sugar test|lipid|coffee|paani|pani|water|test se pehle|khana|diet)\b/i.test(patientMessage));
        const isHumanHandoff = routingTier === 3 && (classifiedIntents.includes('human_handoff') || /receptionist|staff|doctor se baat|human/i.test(patientMessage));

        // TIER 3: Human Handoff & Emergency (Priority 1)
        if (isEmergency || hasMedicalQuery || isHumanHandoff || safetyScreen.level === 'urgent') {
            const targetClinicId = clinicData?.clinicId || instanceId;
            let handoffReason = 'Human Handoff Requested';
            
            if (isEmergency || safetyScreen.level === 'emergency') {
                responseText = "Aapke symptoms ko clinical review ki zarurat hai. Kripya turant nearest hospital se sampark karein. Clinic staff ko alert kar diya gaya hai.";
                handoffReason = 'EMERGENCY TRIAGE ALERT';
            } else if (hasMedicalQuery || safetyScreen.level === 'urgent') {
                responseText = "Test preparation ya medical advice ke baare mein chat par decide nahi kiya ja sakta. Main aapko clinic staff se connect kar raha hu.";
                handoffReason = 'Medical Query / Test Prep Review';
            } else {
                responseText = "Main aapko clinic receptionist se connect kar raha hu. Kripya thodi der wait karein.";
            }

            nextState = 'human_handling';
            await patients.createOrUpdate(chatId, { currentFlowState: nextState, clinicId: targetClinicId, lastQuery: patientMessage });
            
            const transcript = patient.conversationHistory.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n');
            await alertStaff(chatId, patientName, handoffReason, transcript, targetClinicId);
            
            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
            await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
            await sendMessage(chatId, responseText);
            return res.status(200).json({ success: true, handled: true, tier: 3 });
        }

        const isCorrectionOrNegation = !isReportRequest && (classifiedIntent === 'cancel_or_correct' || classifiedIntents.includes('cancel_or_correct') || /(mene nahi bola|nahi karni|nahi bola|galat|wrong|cancel karde|cancel kar do|maine nahi)/i.test(patientMessage));
        



        if (isCorrectionOrNegation) {
            if (liveStatus) {
                try {
                    await PatientService.handlePatientAction({ chatId, action: 'cancel', reason: 'Patient correction: ' + patientMessage });
                } catch (e) {
                    // Ignore if already inactive
                }
            }
            const cancellationText = `Namastey sir/ma'am, aapki booking/token request cancel kar di gayi hai. Kripya batayein, main aapki kis prakar sahayta kar sakta hu (jaise clinic timings ya doctor availability)?`;
            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
            await patients.addMessageToHistory(chatId, { role: 'assistant', content: cancellationText });
            await patients.updateFlowState(chatId, 'idle');
            await patients.createOrUpdate(chatId, { pendingAppointmentOffer: null, bookingDetails: null });
            await sendMessage(chatId, cancellationText);
            return;
        }

        const requestedAppointmentId = extractAppointmentId(patientMessage);
        let intent = classifiedIntents[0] || classifiedIntent;
        
        // Tier 1 & 2 Routing Pre-checks
        if (looksLikeStatusQuery(patientMessage)) intent = 'check_status';
        else if (isReportRequest) intent = 'report_status';
        
        // TIER 1: Pre-fixed Administrative (Priority 2)
        // Note: check_availability is moved to Tier 2 for generative temporal reasoning
        if (routingTier === 1 || (patient.currentFlowState === 'idle' && ['greeting', 'clinic_address', 'check_status', 'general_query'].includes(intent))) {
            if (intent === 'greeting') {
                responseText = `Namaste, ${patientName}! 🙏 Wapas swagat hai. Aaj main aapki kaise madad kar sakti hoon?\n\n` +
                    `*Options:*\n` +
                    `1. 📅 Token book karein\n` +
                    `2. 🎫 Token status check karein\n` +
                    `3. ⏰ Timings, fees & location`;
                await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
                await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
                
                await sendButtons(chatId, responseText, [
                    { id: '1', text: '📅 Token book karein' },
                    { id: '2', text: '🎫 Token status check karein' },
                    { id: '3', text: '⏰ Timings, fees & location' }
                ], clinicData?.clinic_info?.name || 'City Health Clinic');
                return;
            }

            const staticTemplates = {
                "clinic_address": `Humara address hai: ${clinicData?.clinic_info?.address || '15 Hospital Road, Udaipur'}.`,
                "check_status": liveStatus 
                    ? `Aapka Token #${liveStatus.tokenNumber} hai. Currently serving: #${liveStatus.currentToken}. Estimated wait: ~${liveStatus.estimatedWaitMinutes} mins.`
                    : "Aapka koi active token nahi hai. Kya aap appointment book karna chahte hain?",
                "general_query": `Namastey! Aap clinic ke fees, services, ya location ke baare mein puch sakte hain. Humara address: ${clinicData?.clinic_info?.address || '15 Hospital Road'}. Consultation timings: ${clinicData?.clinic_info?.timings || '9 AM - 8 PM'}.`
            };

            if (staticTemplates[intent]) {
                responseText = staticTemplates[intent];
                await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
                await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
                await sendMessage(chatId, responseText);
                return res.status(200).json({ success: true, handled: true, tier: 1 });
            }
        }

        if (requestedAppointmentId && isFutureAppointmentChangeRequest(patientMessage)) {
            intent = 'modify_appointment';
        }
        logger.info(`[Webhook] Classified intents: ${JSON.stringify(classifiedIntents)}, primary resolved intent: ${intent} for ${chatId}`);

        // 4. Handle based on intent and current state
        nextState = patient.currentFlowState;

        // Deterministic Date-Only Detection for idle state
        // If a patient just sends a date (e.g., "16 August"), we treat it as an intent to check availability for that date.
        if (nextState === 'idle' && intent === 'unknown') {
            const detectedDate = parseAppointmentDate(patientMessage);
            if (detectedDate) {
                intent = 'check_availability';
                logger.info(`[Webhook] Date detected in idle message: ${detectedDate}. Overriding intent to check_availability.`);
            }
        }

        // Deterministic safety screen runs in parallel with LLM classification.
        // The classifier may assist, but it never has authority to suppress a
        // high-risk phrase that requires escalation (Already handled in Tier 3 check above, but keeping for legacy loop safety)
        const isEmergencyLegacy = safetyScreen.level === 'emergency' ||
                           (entities.symptoms && entities.symptoms.some(s =>
                               ['chest pain', 'bleeding', 'breathing', 'unconscious', 'emergency'].includes(s.toLowerCase())
                           ));
        const isExplicitHumanHandoff = classifiedIntent === 'human_handoff' && !wantsClinicalAppointment(patientMessage);
        let urgentNotice = '';

        // ==========================================
        // 🛑 EMERGENCY LOOP BYPASS
        // ==========================================
        if (isEmergencyLegacy || safetyScreen.level === 'urgent') {
            const isEmergencyFlag = isEmergencyLegacy || safetyScreen.level === 'emergency';
            responseText = isEmergencyFlag ? getEmergencyReply() : (urgentNotice || 'Namastey sir, aapke symptoms ko qualified clinical review ki zarurat ho sakti hai. Clinic staff ko alert kiya ja raha hai.');
            nextState = 'human_handling';
            const targetClinicId = clinicData?.clinicId || instanceId;

            // Atomically update patient state and clinicId so dashboard Human Handoff updates instantly
            await patients.createOrUpdate(chatId, {
                currentFlowState: nextState,
                clinicId: targetClinicId,
                lastQuery: patientMessage,
                aiNotes: isEmergencyFlag ? 'Medical Emergency Detected' : 'Urgent Symptom Review Requested',
            });
            
            // Update in-memory patient object for consistency
            patient.currentFlowState = nextState;
            patient.clinicId = targetClinicId;

            // If patient has an active token, move it to the front of the line (Priority/Emergency)
            if (patient.activeToken && patient.activeToken.tokenNumber) {
                try {
                    const { prioritizeToken } = require('../services/queueService');
                    await prioritizeToken(
                        targetClinicId, 
                        patient.activeToken.department || 'General Physician', 
                        patient.activeToken.tokenNumber,
                        patient.activeToken.date
                    );
                    logger.info(`[Webhook] Prioritized token #${patient.activeToken.tokenNumber} for emergency patient ${chatId}`);
                } catch (err) {
                    logger.error(`[Webhook] Failed to prioritize token for emergency: ${err.message}`);
                }
            }

            const transcript = patient.conversationHistory.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n');
            await alertStaff(
                chatId,
                patientName,
                isEmergencyFlag ? 'Medical Emergency Detected' : 'Urgent Symptom Review Requested',
                transcript,
                targetClinicId
            );

            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
            await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });

            await sendMessage(chatId, responseText);
            logger.info(`[Webhook] Triage safety response sent to ${chatId} (level: ${safetyScreen.level}). Halted further processing.`);
            return res.status(200).json({ success: true, handled: true, triageLevel: safetyScreen.level });
        }

        if (isExplicitHumanHandoff) {
            responseText = 'Namastey sir, aapka message authorised clinic staff ko forward kar diya gaya hai. Team member aapse yahin reply karega.';
            nextState = 'human_handling';
            const targetClinicId = clinicData?.clinicId || instanceId;
            await patients.createOrUpdate(chatId, {
                currentFlowState: nextState,
                clinicId: targetClinicId,
                lastQuery: patientMessage,
            });
            const transcript = patient.conversationHistory.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n');
            await alertStaff(chatId, patientName, 'Human handoff requested', transcript, targetClinicId);
            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
            await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
            await sendMessage(chatId, responseText);
            return res.status(200).json({ success: true, handled: true, handoff: true });
        }

        // A quick future-slot offer is a durable conversation state, not merely
        // text in the transcript. It is clinic-scoped, expires after ten minutes,
        // and is revalidated atomically before any confirmation is sent.
        const pendingOffer = patient.pendingAppointmentOffer;
        const pendingOfferMatchesClinic = pendingOffer?.clinicId === String(clinicId || '');
        const hasValidPendingOffer = pendingOfferMatchesClinic && isPendingAppointmentOfferValid(pendingOffer);
        const hasExpiredPendingOffer = Boolean(pendingOffer) && !hasValidPendingOffer;

        // Future appointment state: date selection. This is intentionally
        // deterministic and runs before token logic, so a closed clinic never
        // turns a future visit request into a same-day queue token.
        if (isExplicitHumanHandoff) {
            // The handoff response and state were already set above. Do not
            // send it through ordinary status, booking, or LLM handling.
        } else if (hasExpiredPendingOffer) {
            responseText = 'Aapka proposed appointment slot expire ho gaya hai. Kripya preferred date bhejein, main latest available slots dikha deta hu.';
            nextState = 'awaiting_appointment_date';
            await patients.createOrUpdate(chatId, { pendingAppointmentOffer: null, bookingDetails: null });
        } else if (hasValidPendingOffer) {
            if (isExplicitAppointmentCancellation(patientMessage)) {
                responseText = 'Proposed appointment slot cancel kar diya gaya hai. Jab aap ready hon, preferred date bhej dijiye.';
                nextState = 'idle';
                await patients.createOrUpdate(chatId, { pendingAppointmentOffer: null, bookingDetails: null });
            } else if (confirmsPendingAppointmentOffer(patientMessage, pendingOffer)) {
                try {
                    const appointment = await bookFutureAppointment({
                        clinicId,
                        clinicData,
                        patientId: chatId,
                        patientName,
                        phone: senderPhone,
                        department: pendingOffer.department,
                        date: pendingOffer.date,
                        time: pendingOffer.time,
                        doctorName: pendingOffer.doctorName,
                        reason: patientMessage,
                    });
                    responseText = `✅ Appointment confirmed for ${appointment.department} on ${formatIsoDateForPatient(appointment.date)} at ${displaySlot(appointment.time)}. Appointment ID: ${appointment.id}. Kripya 10 minutes pehle pahunchiye.`;
                    nextState = 'idle';
                    await patients.createOrUpdate(chatId, {
                        pendingAppointmentOffer: null,
                        bookingDetails: null,
                        latestAppointmentId: appointment.id,
                    });
                } catch (error) {
                    logger.warn(`[Appointment] Pending slot confirmation failed for ${chatId}: ${error.message}`);
                    const replacementSlots = await getAvailableSlots({
                        clinicId,
                        clinicData,
                        department: pendingOffer.department,
                        doctorName: pendingOffer.doctorName,
                        date: pendingOffer.date,
                    });
                    if (replacementSlots.length) {
                        responseText = `Yeh slot ab available nahi raha. ${formatIsoDateForPatient(pendingOffer.date)} ke available times: ${replacementSlots.slice(0, 8).map(displaySlot).join(', ')}. Kripya exact time bhejein.`;
                        nextState = 'awaiting_appointment_time';
                        await patients.createOrUpdate(chatId, {
                            pendingAppointmentOffer: null,
                            bookingDetails: {
                                department: pendingOffer.department,
                                date: pendingOffer.date,
                                availableSlots: replacementSlots,
                                doctorName: pendingOffer.doctorName || null,
                            },
                        });
                    } else {
                        responseText = 'Yeh slot ab available nahi raha. Kripya preferred date bhejein, main latest available slots dikha deta hu.';
                        nextState = 'awaiting_appointment_date';
                        await patients.createOrUpdate(chatId, { pendingAppointmentOffer: null, bookingDetails: null });
                    }
                }
            } else {
                responseText = `Maine ${pendingOffer.department} ke liye ${formatIsoDateForPatient(pendingOffer.date)} ko ${displaySlot(pendingOffer.time)} ka slot ${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(pendingOffer.expiresAt))} tak hold kiya hai. Confirm karne ke liye “haan” ya “${displaySlot(pendingOffer.time)} book karo” likhein.`;
                nextState = 'awaiting_appointment_confirmation';
            }
        } else if (patient.currentFlowState === 'awaiting_appointment_date') {
            if (isExplicitAppointmentCancellation(patientMessage)) {
                responseText = 'Appointment booking cancelled. Jab aap ready hon, kripya date ke saath dobara message karein.';
                nextState = 'idle';
                await patients.createOrUpdate(chatId, { bookingDetails: null, pendingAppointmentOffer: null });
            } else {
                const date = parseAppointmentDate(patientMessage);
                if (!date) {
                    responseText = 'Kripya appointment date YYYY-MM-DD format mein bhejein, jaise 2026-08-10. Aap “kal” bhi likh sakte hain.';
                    nextState = 'awaiting_appointment_date';
                } else {
                    const department = patient.bookingDetails?.department || resolveDepartment(entities, clinicData);
                    const slots = getSlotsForDate({ clinicData, department, date });
                    if (!slots.length) {
                        const nextDates = await getNextAvailableDates({ clinicData, fromDate: addDaysIso(date, 1), days: 14 });
                        responseText = nextDates.length
                            ? `Is date par clinic appointment ke liye available nahi hai. Next available date: ${nextDates[0]}. Kripya apni preferred date YYYY-MM-DD mein bhejein.`
                            : 'Abhi appointment dates available nahi hain. Kripya clinic reception se sampark karein.';
                        nextState = 'awaiting_appointment_date';
                    } else {
                        const doctorName = patient.bookingDetails?.doctorName || entities?.doctor || null;
                        await patients.createOrUpdate(chatId, { bookingDetails: { department, date, availableSlots: slots, doctorName } });
                        const docLabel = doctorName ? ` (Dr. ${doctorName.replace(/^dr\.?\s*/i, '')})` : '';
                        responseText = `Aapke liye ${department}${docLabel} mein ${formatIsoDateForPatient(date)} ko available time slots yeh hain:`;
                        nextState = 'awaiting_appointment_time';

                        const slotRows = slots.slice(0, 10).map((s) => ({
                            id: `slot_${s}`,
                            title: displaySlot(s),
                            description: `${department} on ${date}`
                        }));

                        await sendListMessage(
                            chatId,
                            responseText,
                            "Available Time Slots",
                            "Select Slot",
                            [{ title: `${department} (${date})`, rows: slotRows }],
                            clinicData?.clinicInfo?.name || 'City Health Clinic'
                        );
                        await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
                        await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
                        await patients.updateFlowState(chatId, nextState);
                        return;
                    }
                }
            }
        }

        // Future appointment state: a final selected slot is atomically
        // reserved in Firestore so two patients cannot take it simultaneously.
        else if (patient.currentFlowState === 'awaiting_appointment_time') {
            if (isExplicitAppointmentCancellation(patientMessage)) {
                responseText = 'Appointment booking cancelled. Jab aap ready hon, kripya dobara message karein.';
                nextState = 'idle';
                await patients.createOrUpdate(chatId, { bookingDetails: null, pendingAppointmentOffer: null });
            } else {
                const bookingDetails = patient.bookingDetails || {};
                const selectedTime = parseAppointmentTime(patientMessage, bookingDetails.availableSlots || []);
                if (!bookingDetails.date || !selectedTime) {
                    responseText = 'Kripya listed time mein se exact time bhejein, jaise 10:00 AM. Date change karne ke liye “cancel” likhkar booking dobara shuru karein.';
                    nextState = 'awaiting_appointment_time';
                } else {
                    try {
                        const appointment = await bookFutureAppointment({
                            clinicId,
                            clinicData,
                            patientId: chatId,
                            patientName,
                            phone: senderPhone,
                            department: bookingDetails.department,
                            date: bookingDetails.date,
                            time: selectedTime,
                            doctorName: bookingDetails.doctorName,
                            reason: patientMessage,
                        });
	                        responseText = `✅ Appointment confirmed for ${appointment.department} on ${appointment.date} at ${displaySlot(appointment.time)}. Appointment ID: ${appointment.id}. Kripya 10 minutes pehle pahunchiye.`;
	                        
	                        // If this was a conversion from a live token, cancel the token now.
	                        if (bookingDetails.convertFromToken) {
	                            try {
	                                await PatientService.handlePatientAction({ chatId, action: 'cancel', reason: `Converted to future appointment ${appointment.id}` });
	                                responseText += `\n\nAapka aaj ka Token #${bookingDetails.convertFromToken} cancel kar diya gaya hai.`;
	                            } catch (cancelErr) {
	                                logger.warn(`[Appointment] Could not cancel token #${bookingDetails.convertFromToken} after conversion for ${chatId}: ${cancelErr.message}`);
	                            }
	                        }
	                        
	                        nextState = 'idle';
	                        await patients.createOrUpdate(chatId, { bookingDetails: null, latestAppointmentId: appointment.id });
	                    } catch (error) {
                        logger.warn(`[Appointment] Could not reserve future slot for ${chatId}: ${error.message}`);
                        responseText = `Yeh slot available nahi raha: ${error.message} Kripya another available time choose karein.`;
                        nextState = 'awaiting_appointment_time';
                    }
                }
            }
        }
        
        // Patient has already verified a future appointment and is choosing a
        // replacement time. This state is kept separate from new bookings so a
        // replacement never creates a duplicate visit.
        else if (patient.currentFlowState === 'awaiting_reschedule_time') {
            if (isExplicitAppointmentCancellation(patientMessage)) {
                responseText = 'Rescheduling request cancelled. Aapka existing appointment abhi bhi unchanged hai.';
                nextState = 'idle';
                await patients.createOrUpdate(chatId, { bookingDetails: null });
            } else {
                const details = patient.bookingDetails || {};
                const requestedDate = parseAppointmentDate(patientMessage) || details.date;
                if (!details.rescheduleAppointmentId || !details.department || !requestedDate) {
                    responseText = 'Reschedule details expire ho gaye hain. Kripya appointment ID ke saath dobara reschedule request bhejein.';
                    nextState = 'idle';
                    await patients.createOrUpdate(chatId, { bookingDetails: null });
                } else {
                    const availableSlots = await getAvailableSlots({
                        clinicId,
                        clinicData,
                        department: details.department,
                        doctorName: details.doctorName || null,
                        date: requestedDate,
                    });
                    const selectedTime = parseLatestAppointmentTime(patientMessage, availableSlots);
                    if (!selectedTime) {
                        if (availableSlots.length) {
                            const docLabel = details.doctorName ? ` (Dr. ${details.doctorName.replace(/^dr\.?\s*/i, '')})` : '';
                            responseText = `Available replacement times for ${details.department}${docLabel} on ${formatIsoDateForPatient(requestedDate)}:`;
                            nextState = 'awaiting_reschedule_time';

                            const slotRows = availableSlots.slice(0, 10).map((s) => ({
                                id: `slot_${s}`,
                                title: displaySlot(s),
                                description: `${details.department} on ${requestedDate}`
                            }));

                            await sendListMessage(
                                chatId,
                                responseText,
                                "Replacement Times",
                                "Select Time",
                                [{ title: `${details.department}`, rows: slotRows }],
                                clinicData?.clinicInfo?.name || 'City Health Clinic'
                            );
                            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
                            await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
                            await patients.updateFlowState(chatId, nextState);
                            return;
                        } else {
                            responseText = `Is date par replacement slot available nahi hai. Kripya another date bhejein.`;
                            nextState = 'awaiting_reschedule_time';
                        }
                    } else {
                        try {
                            const appointment = await rescheduleFutureAppointment({
                                appointmentId: details.rescheduleAppointmentId,
                                patientId: chatId,
                                clinicId,
                                clinicData,
                                date: requestedDate,
                                time: selectedTime,
                                reason: patientMessage,
                            });
                            responseText = `✅ Appointment rescheduled for ${appointment.department} on ${formatIsoDateForPatient(appointment.date)} at ${displaySlot(appointment.time)}. Appointment ID: ${appointment.id}. Kripya 10 minutes pehle pahunchiye.`;
                            nextState = 'idle';
                            await patients.createOrUpdate(chatId, { bookingDetails: null, latestAppointmentId: appointment.id });
                        } catch (error) {
                            logger.warn(`[Appointment] Could not reschedule ${details.rescheduleAppointmentId} for ${chatId}: ${error.message}`);
                            responseText = `Reschedule complete nahi ho saka: ${error.message} Kripya another available time choose karein.`;
                            nextState = 'awaiting_reschedule_time';
                        }
                    }
                }
            }
        }

        // Multi-intent Informational Query Handler (e.g. availability + fees + reports)
        const hasAvailability = classifiedIntents.includes('check_availability') || /\b(available|availabl|doctor.*hai|aaj.*doctor|timing|kab.*beth|appointment.*milti|khula)\b/i.test(patientMessage);
        const hasGeneralQuery = classifiedIntents.includes('general_query') || /\b(fees|fee|cost|price|address|pata|kaha|location|direction|contact)\b/i.test(patientMessage);
        const hasStatusQuery = classifiedIntents.includes('check_status') || looksLikeStatusQuery(patientMessage);
        const hasReportQuery = isReportRequest; // already defined above
        
        const informationalCount = (hasAvailability ? 1 : 0) + (hasGeneralQuery ? 1 : 0) + (hasStatusQuery ? 1 : 0) + (hasReportQuery ? 1 : 0);

        if (informationalCount > 1 && patient.currentFlowState === 'idle') {
            const history = (patient.conversationHistory || []).map(m => ({ role: m.role, content: m.content }));
            history.push({ role: 'user', content: patientMessage });
            
            let combinedTopics = [];
            if (hasAvailability) combinedTopics.push("doctor availability & clinic timings");
            if (hasGeneralQuery) combinedTopics.push("general clinic info, fees, or address");
            if (hasStatusQuery) combinedTopics.push("patient's active queue status");
            if (hasReportQuery) combinedTopics.push("administrative report/PDF delivery status");

            const extraContext = `The patient is asking a composite/multi-intent question covering: ${combinedTopics.join(" and ")}. Please answer all parts of their question comprehensively, politely, and accurately in Hinglish using the provided clinic data and strict zero-hallucination guardrails.`;
            
            if (hasReportQuery) {
                const targetClinicId = clinicData?.clinicId || instanceId;
                const transcript = patient.conversationHistory.slice(-3).map(m => `${m.role}: ${m.content}`).join('\n');
                await alertStaff(chatId, patientName, 'PATIENT REQUESTING REPORT / PDF (Multi-Intent)', transcript, targetClinicId);
            }

            responseText = await generateResponse(history, instanceId, clinicData, extraContext);
            nextState = patient.currentFlowState;
        }
        // SOP v2: Step 2 — Reason for Visit
        else if (patient.currentFlowState === 'awaiting_visit_reason') {
            const reasonMap = { '1': 'Fever/Cold', '2': 'General Consultation', '3': 'Follow-up' };
            const visitReason = reasonMap[patientMessage.trim()] || patientMessage.trim();
            const clinicDepartments = getClinicDepartments(clinicData);
            
            // Skip department selection if single-department clinic
            if (clinicDepartments.length <= 1) {
                const department = clinicDepartments[0] || 'General Physician';
                const queueState = await queueService.getQueueState(clinicId, department);
                const tokenNumber = (queueState.lastIssuedToken || 0) + 1;
                const estimatedWait = queueService.estimateWait(queueState, tokenNumber);
                const peopleAhead = Math.max(tokenNumber - (queueState.currentToken || 0) - 1, 0);

                responseText = `Aapki details:\n` +
                    `🏥 *Department:* ${department}\n` +
                    `📝 *Reason:* ${visitReason}\n` +
                    `👥 *Abhi line mein:* ${peopleAhead} log aapse pehle hain\n` +
                    `⏳ *Andaazan wait:* ~${estimatedWait} min\n\n` +
                    `Kya main aapka token confirm kar doon?\n\n` +
                    `1. ✅ Haan, Confirm\n` +
                    `2. ❌ Nahi, Cancel`;
                
                nextState = 'awaiting_live_token_confirmation';
                await patients.createOrUpdate(chatId, { 
                    currentFlowState: nextState,
                    bookingDetails: { department, reason: visitReason }
                });
                
                await sendButtons(chatId, responseText, [
                    { id: '1', text: '✅ Haan, Confirm' },
                    { id: '2', text: '❌ Nahi, Cancel' }
                ], clinicData?.clinic_info?.name || 'City Health Clinic');
                return res.status(200).json({ success: true, handled: true });
            } else {
                responseText = `Aapko kis department mein dikhana hai?\n\n` +
                    `*Departments:*\n` +
                    clinicDepartments.slice(0, 3).map((dept, idx) => `${idx + 1}. ${dept}`).join('\n');
                nextState = 'awaiting_department_selection';
                await patients.createOrUpdate(chatId, { 
                    currentFlowState: nextState,
                    bookingDetails: { reason: visitReason }
                });
                
                const deptButtons = clinicDepartments.slice(0, 3).map((dept, idx) => ({
                    id: String(idx + 1),
                    text: dept
                }));
                
                await sendButtons(chatId, responseText, deptButtons, clinicData?.clinic_info?.name || 'City Health Clinic');
                return res.status(200).json({ success: true, handled: true });
            }
        }
        // SOP v2: Step 2 — Capturing Department
        else if (patient.currentFlowState === 'awaiting_department_selection') {
            const clinicDepartments = getClinicDepartments(clinicData);
            const deptIndex = parseInt(patientMessage.trim(), 10) - 1;
            const department = (deptIndex >= 0 && deptIndex < clinicDepartments.length) 
                ? clinicDepartments[deptIndex] 
                : patientMessage.replace(/^dept_/, '').replace(/_/g, ' ');
            const visitReason = patient.bookingDetails?.reason || 'Consultation';
            
            const queueState = await queueService.getQueueState(clinicId, department);
            const tokenNumber = (queueState.lastIssuedToken || 0) + 1;
            const estimatedWait = queueService.estimateWait(queueState, tokenNumber);
            const peopleAhead = Math.max(tokenNumber - (queueState.currentToken || 0) - 1, 0);

            responseText = `Aapki details:\n` +
                `🏥 *Department:* ${department}\n` +
                `📝 *Reason:* ${visitReason}\n` +
                `👥 *Abhi line mein:* ${peopleAhead} log aapse pehle hain\n` +
                `⏳ *Andaazan wait:* ~${estimatedWait} min\n\n` +
                `Kya main aapka token confirm kar doon?\n\n` +
                `1. ✅ Haan, Confirm\n` +
                `2. ❌ Nahi, Cancel`;
            
            nextState = 'awaiting_live_token_confirmation';
            await patients.createOrUpdate(chatId, { 
                currentFlowState: nextState,
                bookingDetails: { department, reason: visitReason }
            });
            
            await sendButtons(chatId, responseText, [
                { id: '1', text: '✅ Haan, Confirm' },
                { id: '2', text: '❌ Nahi, Cancel' }
            ], clinicData?.clinic_info?.name || 'City Health Clinic');
            return res.status(200).json({ success: true, handled: true });
        }
        // SOP v2: Step 3 — Confirmation
        else if (patient.currentFlowState === 'awaiting_live_token_confirmation') {
            if (isAffirmative(patientMessage)) {
                const bookingDetails = patient.bookingDetails || {};
                const booking = await queueService.bookToken({
                    clinicId, 
                    chatId, 
                    patientName, 
                    department: bookingDetails.department,
                    phone: senderPhone,
                    reason: bookingDetails.reason
                });

                responseText = `✅ Aapka token book ho gaya hai!\n` +
                    `*Token Number: #${booking.tokenNumber}*\n` +
                    `*Ab serve ho raha hai: #${booking.currentToken}*\n` +
                    `Kripya time se pehle pahunch jaayein — reception par apna token number bata dijiye.\n\n` +
                    `💡 Kabhi bhi "Status" likh kar apni line check kar sakte hain, ya "Cancel" likh kar token cancel kar sakte hain.`;
                
                nextState = 'idle';
                await patients.createOrUpdate(chatId, { currentFlowState: nextState, bookingDetails: null });
                await sendMessage(chatId, responseText);
                
                // SOP v2: Step 5 — Anything Else?
                const followUp = `Kya aapko koi aur jaankari chahiye — parking, payment, ya kuch aur?`;
                await sendMessage(chatId, followUp);
                return res.status(200).json({ success: true, handled: true });
            } else {
                responseText = `Proposed token cancel kar diya gaya hai. Jab aap ready hon, kripya dobara message karein.`;
                nextState = 'idle';
                await patients.createOrUpdate(chatId, { currentFlowState: nextState, bookingDetails: null });
                await sendMessage(chatId, responseText);
                return res.status(200).json({ success: true, handled: true });
            }
        }
        else if (intent === 'check_availability') {
            const requestedDate = parseAppointmentDate(patientMessage);
            const department = resolveDepartment(entities, clinicData);
            const doctorName = entities?.doctor || null;

            if (requestedDate && patient.currentFlowState === 'idle') {
                // Deterministic Date-Availability Handling:
                // If the user provided a specific date, we check it against the clinic schedule.
                const slots = getSlotsForDate({ clinicData, department, date: requestedDate });
                
                if (!slots.length) {
                    const nextDates = await getNextAvailableDates({ clinicData, fromDate: addDaysIso(requestedDate, 1), days: 14 });
                    responseText = nextDates.length
                        ? `Is date (${formatIsoDateForPatient(requestedDate)}) par clinic appointment ke liye available nahi hai. Next available date: ${formatIsoDateForPatient(nextDates[0])}. Kripya apni preferred date bhejein.`
                        : `I'm sorry, ${formatIsoDateForPatient(requestedDate)} ko clinic closed hai aur koi upcoming slots available nahi hain.`;
                    nextState = 'awaiting_appointment_date';
                    await patients.createOrUpdate(chatId, { bookingDetails: { department, doctorName }, pendingAppointmentOffer: null });
                } else {
                    await patients.createOrUpdate(chatId, { bookingDetails: { department, date: requestedDate, availableSlots: slots, doctorName } });
                    const docLabel = doctorName ? ` (Dr. ${doctorName.replace(/^dr\.?\s*/i, '')})` : '';
                    responseText = `Aapke liye ${department}${docLabel} mein ${formatIsoDateForPatient(requestedDate)} ko available time slots yeh hain. Kripya apna preferred slot select karein:`;
                    nextState = 'awaiting_appointment_time';
                    
                    const slotRows = slots.slice(0, 10).map((s) => ({
                        id: `slot_${s}`,
                        title: displaySlot(s),
                        description: `${department} on ${requestedDate}`
                    }));
                    
                    await sendListMessage(
                        chatId,
                        responseText,
                        "Available Time Slots",
                        "Select Slot",
                        [{ title: `${department} (${requestedDate})`, rows: slotRows }],
                        clinicData?.clinicInfo?.name || 'City Health Clinic'
                    );
                    await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
                    await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
                    await patients.updateFlowState(chatId, nextState);
                    return res.status(200).json({ success: true, handled: true, date: requestedDate });
                }
            } else {
                // Fallback to LLM for general timing/availability questions
                const history = (patient.conversationHistory || []).map(m => ({ role: m.role, content: m.content }));
                history.push({ role: 'user', content: patientMessage });
                const liveStatusText = liveStatus
                    ? `Note: The patient currently has Token #${liveStatus.tokenNumber} for ${liveStatus.department} today, but they are asking about availability/timings. Answer their availability question first in polite Hinglish based on the clinic context, and gently remind them of their active token if relevant.`
                    : `The patient is asking about doctor availability or clinic timings. Answer directly in polite Hinglish using the clinic details.`;
                responseText = await generateResponse(history, instanceId, clinicData, liveStatusText, 'check_availability');
                nextState = patient.currentFlowState;
            }
        }

        // General Query (address, fees, directions, contact info)
        else if (intent === 'general_query') {
            const history = (patient.conversationHistory || []).map(m => ({ role: m.role, content: m.content }));
            history.push({ role: 'user', content: patientMessage });
            const liveStatusText = `The patient is asking a general inquiry (address, fees, directions, or contact info). Answer helpfully in polite Hinglish using clinic details.`;
            responseText = await generateResponse(history, instanceId, clinicData, liveStatusText);
            nextState = patient.currentFlowState;
        }

        // Report Status Query (PDF, lab results, etc.)
        else if (intent === 'report_status' || (isReportRequest && informationalCount === 1)) {
            const targetClinicId = clinicData?.clinicId || instanceId;
            responseText = `Aapki report abhi lab se process ho rahi hai. Jaise hi PDF ready hogi, hum aapko WhatsApp par bhej denge. Urgent requests ke liye maine staff ko inform kar diya hai.`;
            
            const transcript = patient.conversationHistory.slice(-3).map(m => `${m.role}: ${m.content}`).join('\n');
            await alertStaff(chatId, patientName, 'PATIENT REQUESTING REPORT / PDF', transcript, targetClinicId);
            nextState = patient.currentFlowState;
        }

        // Human Handoff / Talk to Receptionist
        else if (intent === 'human_handoff') {
            responseText = 'Namastey sir/ma' + 'am, aapka message authorised clinic staff ko forward kar diya gaya hai. Team member aapse yahin jaldi reply karega.';
            nextState = 'human_handling';
            const transcript = (patient.conversationHistory || []).slice(-5).map(m => `${m.role}: ${m.content}`).join('\n');
            await alertStaff(chatId, patientName, 'Patient requested human receptionist', transcript, clinicData?.clinicId || instanceId);
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

        // Future appointments use a separate, verified rescheduling workflow.
        // A known appointment ID alone is never sufficient: it must belong to
        // this WhatsApp patient and this resolved clinic before slots are shown.
        else if (intent === 'modify_appointment') {
            const appointmentId = requestedAppointmentId || patient.latestAppointmentId || null;
            if (appointmentId) {
                try {
                    const appointment = await getFutureAppointmentForPatient({ appointmentId, patientId: chatId, clinicId });
                    if (!appointment) {
                        responseText = 'Mujhe is appointment ID ke saath aapka active future appointment nahi mila. Kripya same WhatsApp number se valid appointment ID bhejein, ya clinic reception se sampark karein.';
                        nextState = 'idle';
                    } else {
                        const requestedDate = parseAppointmentDate(patientMessage) || appointment.date;
                        const availableSlots = await getAvailableSlots({
                            clinicId,
                            clinicData,
                            department: appointment.department,
                            doctorName: appointment.doctorName || null,
                            date: requestedDate,
                        });
                        const requestedTime = parseLatestAppointmentTime(patientMessage, availableSlots);
                        if (requestedTime) {
                            try {
                                const rescheduled = await rescheduleFutureAppointment({
                                    appointmentId: appointment.id,
                                    patientId: chatId,
                                    clinicId,
                                    clinicData,
                                    date: requestedDate,
                                    time: requestedTime,
                                    reason: patientMessage,
                                });
                                responseText = `✅ Appointment rescheduled for ${rescheduled.department} on ${formatIsoDateForPatient(rescheduled.date)} at ${displaySlot(rescheduled.time)}. Appointment ID: ${rescheduled.id}. Kripya 10 minutes pehle pahunchiye.`;
                                nextState = 'idle';
                                await patients.createOrUpdate(chatId, { bookingDetails: null, latestAppointmentId: rescheduled.id });
                            } catch (error) {
                                logger.warn(`[Appointment] Direct reschedule failed for ${appointment.id}: ${error.message}`);
                                responseText = `Yeh replacement time reserve nahi ho saka: ${error.message} Available times hain: ${availableSlots.map(displaySlot).join(', ')}. Kripya another time choose karein.`;
                                nextState = 'awaiting_reschedule_time';
                                await patients.createOrUpdate(chatId, {
                                    bookingDetails: {
                                        rescheduleAppointmentId: appointment.id,
                                        department: appointment.department,
                                        doctorName: appointment.doctorName || null,
                                        date: requestedDate,
                                        availableSlots,
                                    },
                                });
                            }
                        } else {
                            if (availableSlots.length) {
                                const docLabel = appointment.doctorName ? ` (Dr. ${appointment.doctorName.replace(/^dr\.?\s*/i, '')})` : '';
                                responseText = `Aapka ${appointment.department}${docLabel} appointment ${formatIsoDateForPatient(appointment.date)} at ${displaySlot(appointment.time)} hai. Available replacement times for ${formatIsoDateForPatient(requestedDate)}:`;
                                nextState = 'awaiting_reschedule_time';
                                await patients.createOrUpdate(chatId, {
                                    bookingDetails: {
                                        rescheduleAppointmentId: appointment.id,
                                        department: appointment.department,
                                        doctorName: appointment.doctorName || null,
                                        date: requestedDate,
                                        availableSlots,
                                    },
                                });

                                const slotRows = availableSlots.slice(0, 10).map((s) => ({
                                    id: `slot_${s}`,
                                    title: displaySlot(s),
                                    description: `${appointment.department} on ${requestedDate}`
                                }));

                                await sendListMessage(
                                    chatId,
                                    responseText,
                                    "Replacement Times",
                                    "Select Time",
                                    [{ title: `${appointment.department}`, rows: slotRows }],
                                    clinicData?.clinicInfo?.name || 'City Health Clinic'
                                );
                                await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
                                await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
                                await patients.updateFlowState(chatId, nextState);
                                return;
                            } else {
                                responseText = `Is date par replacement slot available nahi hai. Kripya another future date bhejein.`;
                                nextState = 'awaiting_reschedule_time';
                                await patients.createOrUpdate(chatId, {
                                    bookingDetails: {
                                        rescheduleAppointmentId: appointment.id,
                                        department: appointment.department,
                                        doctorName: appointment.doctorName || null,
                                        date: requestedDate,
                                        availableSlots,
                                    },
                                });
                            }
                        }
                    }
                } catch (error) {
                    logger.error(`[Appointment] Could not verify reschedule request for ${chatId}: ${error.message}`);
                    responseText = 'Appointment reschedule temporarily verify nahi ho saka. Kripya thodi der baad try karein ya clinic reception se sampark karein.';
                    nextState = 'idle';
                }
            } else if (!liveStatus) {
                responseText = 'Future appointment reschedule karne ke liye appointment ID bhejein. Agar aapke paas aaj ka live token hai, “status” likhkar check kar sakte hain.';
                nextState = 'idle';
            } else {
                // If the patient has a live token, they can "reschedule" it by
                // converting it to a future appointment.
                const requestedDate = parseAppointmentDate(patientMessage);
                if (requestedDate && requestedDate !== istDateIso()) {
                    const slots = getSlotsForDate({ clinicData, department: liveStatus.department, date: requestedDate });
                    if (slots.length) {
                        await patients.createOrUpdate(chatId, {
                            bookingDetails: {
                                department: liveStatus.department,
                                date: requestedDate,
                                availableSlots: slots,
                                convertFromToken: liveStatus.tokenNumber
                            }
                        });
                        responseText = `Aapka Token #${liveStatus.tokenNumber} future appointment mein convert kiya ja sakta hai. ${formatIsoDateForPatient(requestedDate)} ke liye available slots:`;
                        nextState = 'awaiting_appointment_time';

                        const slotRows = slots.slice(0, 10).map((s) => ({
                            id: `slot_${s}`,
                            title: displaySlot(s),
                            description: `${liveStatus.department} on ${requestedDate}`
                        }));

                        await sendListMessage(
                            chatId,
                            responseText,
                            "Available Slots",
                            "Select Slot",
                            [{ title: `${liveStatus.department}`, rows: slotRows }],
                            clinicData?.clinicInfo?.name || 'City Health Clinic'
                        );
                        await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
                        await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
                        await patients.updateFlowState(chatId, nextState);
                        return;
                    } else {
                        responseText = `Is date par slots available nahi hain. Kripya another date bhejein.`;
                        nextState = 'awaiting_appointment_date';
                        await patients.createOrUpdate(chatId, { bookingDetails: { department: liveStatus.department } });
                    }
                } else {
                    responseText = `You currently have Token #${liveStatus.tokenNumber} for ${liveStatus.department} today — ` +
                        `this system issues live same-day tokens. ` +
                        `Agar aap future appointment book karna chahte hain, to kripya date bhejein (jaise "kal"). ` +
                        `Time confirm hote hi aaj ka token cancel ho jayega.`;
                    nextState = 'awaiting_appointment_date';
                    await patients.createOrUpdate(chatId, { bookingDetails: { department: liveStatus.department } });
                }
            }
        }
        
        // Live Digital Token Engine
        else if (intent === 'book_appointment') {
            if (liveStatus) {
                const waiting = Math.max(liveStatus.tokenNumber - liveStatus.currentToken, 0);
                responseText = `Namastey sir/ma'am, aapke paas aaj ke liye Token #${liveStatus.tokenNumber} (${liveStatus.department}) pehle se hai (Now serving #${liveStatus.currentToken}).\n` +
                    `Kya aap apna status check karna chahte hain, naya future appointment book karna chahte hain, ya is token ko cancel karna chahte hain?`;
                nextState = 'idle';
            } else if (!clinicId) {
                const history = (patient.conversationHistory || []).map(m => ({ role: m.role, content: m.content }));
                history.push({ role: 'user', content: patientMessage });
                responseText = await generateResponse(history, instanceId, clinicData);
                nextState = 'booking_in_progress';
            } else {
                // Server-side guardrail: the LLM may describe timings, but only
                // this deterministic check may authorize a live token.
                const availability = getLiveTokenAvailability(clinicData);
                if (!availability.canIssueLiveToken) {
                    const department = resolveDepartment(entities, clinicData);
                    const doctorName = entities?.doctor || null;
                    const nextOpeningDate = availability.nextOpening
                        ? `${availability.nextOpening.year}-${String(availability.nextOpening.month).padStart(2, '0')}-${String(availability.nextOpening.day).padStart(2, '0')}`
                        : istDateIso();

                    if (wantsEarliestAvailableAppointment(patientMessage)) {
                        const offer = await findNextAvailableAppointmentOffer({
                            clinicId,
                            clinicData,
                            department,
                            doctorName,
                            fromDate: nextOpeningDate,
                        });
                        if (offer) {
                            const docLabel = doctorName ? ` (Dr. ${doctorName.replace(/^dr\.?\s*/i, '')})` : '';
                            responseText = `📅 Next available appointment for ${department}${docLabel} is on ${formatIsoDateForPatient(offer.date)} at ${displaySlot(offer.time)}. Would you like to book this slot?\n\n` +
                                `1. Yes, Book it\n` +
                                `2. No, search other`;
                            nextState = 'awaiting_appointment_confirmation';
                            await patients.createOrUpdate(chatId, {
                                bookingDetails: null,
                                pendingAppointmentOffer: offer,
                            });
                            
                            await sendButtons(chatId, responseText, [
                                { id: '1', text: 'Yes, Book it' },
                                { id: '2', text: 'No, search other' }
                            ]);
                            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
                            await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
                            await patients.updateFlowState(chatId, nextState);
                            return;
                        } else {
                            responseText = appointmentDatePrompt(availability.nextOpening);
                            nextState = 'awaiting_appointment_date';
                            await patients.createOrUpdate(chatId, { bookingDetails: { department, doctorName }, pendingAppointmentOffer: null });
                        }
                    } else {
                        responseText = appointmentDatePrompt(availability.nextOpening);
                        nextState = 'awaiting_appointment_date';
                        await patients.createOrUpdate(chatId, { bookingDetails: { department, doctorName }, pendingAppointmentOffer: null });
                    }
                    logger.info(`[Booking] Redirected closed-hours request for ${chatId} to future scheduling: clinic ${clinicId} is ${availability.reason}.`);
                } else {
                    const department = resolveDepartment(entities, clinicData);
                    const doctorName = entities?.doctor || null;
                    const date = parseAppointmentDate(patientMessage);
                    
                    // If the patient explicitly asked for a future date (e.g. "13 August"),
                    // route them to the future appointment flow even if the clinic is
                    // currently open for same-day tokens.
                    if (date && date !== istDateIso()) {
                        const slots = getSlotsForDate({ clinicData, department, date });
                        if (!slots.length) {
                            const nextDates = await getNextAvailableDates({ clinicData, fromDate: addDaysIso(date, 1), days: 14 });
                            responseText = nextDates.length
                                ? `Is date par clinic appointment ke liye available nahi hai. Next available date: ${nextDates[0]}. Kripya apni preferred date YYYY-MM-DD mein bhejein.`
                                : 'Abhi appointment dates available nahi hain. Kripya clinic reception se sampark karein.';
                            nextState = 'awaiting_appointment_date';
                            await patients.createOrUpdate(chatId, { bookingDetails: { department, doctorName }, pendingAppointmentOffer: null });
                        } else {
                            await patients.createOrUpdate(chatId, { bookingDetails: { department, date, availableSlots: slots, doctorName } });
                            const docLabel = doctorName ? ` (Dr. ${doctorName.replace(/^dr\.?\s*/i, '')})` : '';
                            responseText = `Aapke liye ${department}${docLabel} mein ${formatIsoDateForPatient(date)} ko available time slots yeh hain. Kripya apna preferred slot select karein:`;
                            nextState = 'awaiting_appointment_time';
                            
                            const slotRows = slots.slice(0, 10).map((s) => ({
                                id: `slot_${s}`,
                                title: displaySlot(s),
                                description: `${department} on ${date}`
                            }));
                            
                            await sendListMessage(
                                chatId,
                                responseText,
                                "Available Time Slots",
                                "Select Slot",
                                [{ title: `${department} (${date})`, rows: slotRows }],
                                clinicData?.clinicInfo?.name || 'City Health Clinic'
                            );
                            await patients.addMessageToHistory(chatId, { role: 'user', content: patientMessage });
                            await patients.addMessageToHistory(chatId, { role: 'assistant', content: responseText });
                            await patients.updateFlowState(chatId, nextState);
                            return;
                        }
                        logger.info(`[Booking] Routed future-date request for ${chatId} during open hours: ${date} (${department}).`);
                    } else {
                        // SOP v2: Live Token flow — Step 2 (Reason for Visit)
                        responseText = `Main aapka aaj ka token book kar sakti hoon. Kripya batayein, aap doctor ko kis wajah se dikhana chahte hain? (Short mein batayein, jaise "Fever", "Back pain", etc.)\n\n` +
                            `*Common Reasons:*\n` +
                            `1. Fever/Cold\n` +
                            `2. General Consultation\n` +
                            `3. Follow-up`;
                        nextState = 'awaiting_visit_reason';
                        await patients.createOrUpdate(chatId, { 
                            currentFlowState: nextState, 
                            bookingDetails: { department, doctorName } 
                        });
                        
                        // Add buttons for common reasons
                        await sendButtons(chatId, responseText, [
                            { id: '1', text: 'Fever/Cold' },
                            { id: '2', text: 'General Consultation' },
                            { id: '3', text: 'Follow-up' }
                        ], clinicData?.clinic_info?.name || 'City Health Clinic');
                        return res.status(200).json({ success: true, handled: true });
                    }
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

            responseText = await generateResponse(history, instanceId, clinicData, liveStatusText, 'general_query');
        }

        // Keep the safety guidance visible while still allowing a valid
        // appointment/token branch to complete for urgent-but-not-emergency cases.
        if (urgentNotice && responseText) {
            responseText = `${urgentNotice}\n\n${responseText}`;
        }

        // 5. Loop guard
        const rawResponseText = responseText;
        const loopState = patient._loopGuard || { rawResponse: null, count: 0 };
        
        // Only increment loop guard if the response is identical and NOT a transient technical error message
        const isTechnicalError = rawResponseText && (rawResponseText.includes("temporarily busy") || rawResponseText.includes("ERROR_401"));
        const repeatCount = (loopState.rawResponse === rawResponseText && !isTechnicalError) ? loopState.count + 1 : 1;

        if (repeatCount === 2) {
            responseText = "I'm sorry, I didn't quite catch that. I can help you book an appointment, check doctor timings, get clinic directions, or check your token status. How can I help you today?";
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
// Pure helpers are exposed only for deterministic regression tests. Express
// continues to receive the router object as the module export.
module.exports._test = {
    parseAppointmentDate,
    parseAppointmentTime,
    parseLatestAppointmentTime,
    extractAppointmentId,
    isFutureAppointmentChangeRequest,
    appointmentDatePrompt,
    formatIsoDateForPatient,
    wantsClinicalAppointment,
    isExplicitAppointmentCancellation,
    buildPendingAppointmentOffer,
    isPendingAppointmentOfferValid,
    confirmsPendingAppointmentOffer,
    wantsEarliestAvailableAppointment,
    PENDING_APPOINTMENT_OFFER_TTL_MS,
};
