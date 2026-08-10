// services/adminService.js
'use strict';

const { sendMessage } = require('./greenApi');
const { logger } = require('../errorHandler');

/**
 * Admin Service
 * Handles alerts to clinic staff and admin-specific functions.
 */

// In a real scenario, this would be a list of staff WhatsApp IDs or a Slack webhook
const ADMIN_NOTIFY_IDS = process.env.ADMIN_NOTIFY_IDS ? process.env.ADMIN_NOTIFY_IDS.split(',') : [];

/**
 * Alert clinic staff about a human handoff or emergency.
 */
async function alertStaff(patientChatId, patientName, reason, transcript = "") {
    const alertMessage = `🚨 *STAFF ALERT:* \n\n*Reason:* ${reason} \n*Patient:* ${patientName} (${patientChatId}) \n\n*Recent Transcript:* \n${transcript} \n\nPlease take over this chat or contact the patient immediately.`;
    
    for (const adminId of ADMIN_NOTIFY_IDS) {
        try {
            await sendMessage(adminId, alertMessage);
        } catch (error) {
            logger.error(`[Admin] Failed to notify admin ${adminId}:`, error);
        }
    }
    
    logger.info(`[Admin] Staff alerted for ${patientChatId} due to ${reason}`);
}

module.exports = {
    alertStaff
};
