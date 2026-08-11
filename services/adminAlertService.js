// services/adminAlertService.js
'use strict';

const axios = require("axios");
const { db } = require("../db");
const { sendMessage } = require("./greenApi");
const { logger } = require("../errorHandler");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now() {
  return new Date().toLocaleString("en-IN", {
    timeZone:    "Asia/Kolkata",
    day:         "2-digit",
    month:       "short",
    hour:        "2-digit",
    minute:      "2-digit",
    hour12:      true,
  });
}

/**
 * Builds alert-channel content with minimum necessary patient information by
 * default. Full patient detail is an explicit clinic decision, not a default.
 */
function buildStaffAlertPayload({ alertType, clinicName, patientReference, patientName, cleanPhone, lastUserMessage, tokenStr, includePatientPii }) {
  const slackFields = [
    { type: "mrkdwn", text: `*Patient Reference*\n${patientReference}` },
    { type: "mrkdwn", text: `*Action Required*\nReview the authorised dashboard immediately.` },
  ];

  if (includePatientPii) {
    slackFields.push(
      { type: "mrkdwn", text: `*Patient Name*\n${patientName || 'Unknown'}` },
      { type: "mrkdwn", text: `*Phone Number*\n+${cleanPhone}` },
      { type: "mrkdwn", text: `*Patient Message*\n"${lastUserMessage}"` },
    );
  }
  if (tokenStr) slackFields.push({ type: "mrkdwn", text: `*Token Number*\n${tokenStr}` });

  const fallback = `CLINIC ALERT: ${alertType} at ${clinicName} — ${patientReference}. Review the authorised dashboard immediately.`;
  const smsBody = includePatientPii
    ? `CLINIC ALERT (${clinicName}): ${alertType}\nPatient: ${patientName || cleanPhone}\nMessage: "${lastUserMessage}"\nUse only the authorised staff workflow.`
    : `CLINIC ALERT (${clinicName}): ${alertType}\nReference: ${patientReference}\nPlease review the authorised dashboard immediately.`;

  let whatsappAlert =
    `🚨 *${String(alertType || '').toUpperCase()}* 🚨\n\n` +
    `*Patient Reference:* ${patientReference}\n`;
  if (tokenStr) whatsappAlert += `*Token Number:* ${tokenStr}\n`;
  if (includePatientPii) {
    whatsappAlert +=
      `*Patient Name:* ${patientName || 'Unknown'}\n` +
      `*Phone Number:* +${cleanPhone}\n` +
      `*Patient Message:* "${lastUserMessage}"\n`;
  }
  whatsappAlert += '\n_Please review the authorised dashboard and follow the clinic escalation protocol._';

  return { slackFields, fallback, smsBody, whatsappAlert };
}

// ─── Slack ────────────────────────────────────────────────────────────────────

/**
 * Sends a Slack Block Kit message to the configured webhook URL.
 * @param {object} blocks  — Slack Block Kit blocks array
 * @param {string} fallback — Plain-text fallback for notifications
 */
async function postToSlack(blocks, fallback) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.warn("[AdminAlert] SLACK_WEBHOOK_URL not set — skipping Slack alert");
    return;
  }

  try {
    await axios.post(url, { text: fallback, blocks });
    console.log("[AdminAlert] ✅ Slack alert sent");
  } catch (err) {
    console.error("[AdminAlert] Slack alert failed:", err.message);
  }
}

// ─── Twilio SMS ───────────────────────────────────────────────────────────────

/**
 * Sends an SMS via Twilio REST API.
 * @param {string} body — SMS text
 */
async function sendSms(body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER;
  const to    = process.env.ADMIN_PHONE_NUMBER;

  if (!sid || !token || !from || !to) {
    if (sid || token || from || to) {
      console.warn("[AdminAlert] Twilio partially configured — SMS skipped. Check env vars.");
    }
    return;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  try {
    await axios.post(
      url,
      new URLSearchParams({ From: from, To: to, Body: body }).toString(),
      {
        auth:    { username: sid, password: token },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
    console.log(`[AdminAlert] ✅ SMS sent to ${to}`);
  } catch (err) {
    console.error("[AdminAlert] Twilio SMS failed:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLINIC RECEPTIONIST EMERGENCY & STAFF ALERTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * alertStaff — fires when a medical emergency or human handoff is detected.
 * Fetches tenant clinic details from Firestore, and alerts staff via Slack, SMS, and WhatsApp.
 *
 * @param {string} chatId - Patient's chat ID / phone
 * @param {string} patientName - Name of the patient
 * @param {string} alertType - Reason for alert (e.g., 'Medical Emergency Detected')
 * @param {string} transcript - Recent conversation history transcript
 * @param {string} tenantId - The unique clinic tenant ID or instanceId
 */
async function alertStaff(chatId, patientName, alertType, transcript, tenantId) {
  // 1. Force string casting immediately to prevent Firestore SDK type errors
  const safeTenantId = String(tenantId || '');
  
  let staffPhone = null;
  let clinicName = "Clinic AI Receptionist";

  // 2. Isolate the database operation in its own try/catch
  try {
    if (safeTenantId) {
      let clinicDoc = await db.collection('clinics').doc(safeTenantId).get();
      if (!clinicDoc.exists) {
        const querySnapshot = await db.collection('clinics')
          .where('whatsapp.instanceId', '==', safeTenantId)
          .limit(1)
          .get();
        if (!querySnapshot.empty) {
          clinicDoc = querySnapshot.docs[0];
        }
      }

      if (clinicDoc && clinicDoc.exists) {
        const clinicData = clinicDoc.data();
        staffPhone = clinicData.adminPhone || clinicData.profile?.phone || clinicData.doctorPhone;
        clinicName = clinicData.profile?.name || clinicName;
      }
    }
  } catch (dbError) {
    // Log the DB failure, but DO NOT return. Let it fall through to the fail-safe.
    console.error(`[Alert Service] Firestore lookup failed for tenant ${safeTenantId}:`, dbError.message);
  }

  // 3. Fallback to environment variables if not found in tenant profile or if DB lookup failed
  if (!staffPhone) {
    staffPhone = process.env.DEFAULT_ADMIN_PHONE || process.env.ADMIN_PHONE_NUMBER;
  }

  // 4. Parse critical details from the transcript to prevent messy alert messages
  const tokenMatch = transcript.match(/Token\s*#?(\d+)/i);
  const tokenStr = tokenMatch ? tokenMatch[1] : null;

  const userMessages = transcript.match(/user:\s*(.*)/g);
  let lastUserMessage = "Emergency triggered";
  if (userMessages && userMessages.length > 0) {
    lastUserMessage = userMessages[userMessages.length - 1].replace(/user:\s*/i, '').trim();
  }
  
  const cleanPhone = chatId.replace('@c.us', '');
  const patientReference = `PATIENT-${cleanPhone.slice(-4) || 'UNKNOWN'}`;
  // Staff alerts may be delivered through third-party channels. Keep them
  // privacy-minimised by default; a clinic may explicitly enable full details
  // only for its restricted, authorised staff destination.
  const includePatientPii = process.env.ALERT_INCLUDE_PATIENT_PII === 'true';

  // 5. Execute the alert pipeline outside the DB try/catch
  try {
    const alertPayload = buildStaffAlertPayload({
      alertType,
      clinicName,
      patientReference,
      patientName,
      cleanPhone,
      lastUserMessage,
      tokenStr,
      includePatientPii,
    });

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: `🚨 ${alertType.toUpperCase()} — ${clinicName}`, emoji: true },
      },
      { type: "divider" },
      {
        type: "section",
        fields: alertPayload.slackFields,
      },
      { type: "divider" },
    ];

    const alertPromises = [
      postToSlack(blocks, alertPayload.fallback),
      sendSms(alertPayload.smsBody)
    ];

    if (staffPhone) {
      const staffChatId = staffPhone.includes('@c.us') ? staffPhone : `${staffPhone.replace('+', '')}@c.us`;
      
      alertPromises.push(
        sendMessage(staffChatId, alertPayload.whatsappAlert).catch(err => {
          console.error(`[AdminAlert] Failed to send WhatsApp alert to staff: ${err.message}`);
        })
      );
    }

    await Promise.allSettled(alertPromises);
    console.log(`[AdminAlert] Successfully dispatched staff alert for tenant ${safeTenantId}`);

  } catch (error) {
    logger.error(`[AdminAlertService] Critical failure dispatching alerts: ${error.message}`);
  }
}

module.exports = { alertStaff, postToSlack, sendSms, buildStaffAlertPayload };
