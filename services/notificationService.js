// services/notificationService.js
'use strict';

const { sendMessage } = require('./greenApi');
const { logger } = require('../errorHandler');

/**
 * Notification Service
 * Handles specialized patient notifications like lab reports and intake forms.
 */

/**
 * Notify patient that a lab report is ready.
 */
async function notifyLabReport(chatId, reportId, patientName) {
    const secureLink = `https://clinic-portal.com/reports/${reportId}?token=secure_auth_token`;
    const message = `Hello ${patientName}, \n\nYour lab results are now available. For your privacy and security, you can view them through our secure patient portal using the link below: \n\n🔗 ${secureLink} \n\nPlease note that this link is password-protected.`;
    
    try {
        await sendMessage(chatId, message);
        logger.info(`[Notification] Lab report notification sent to ${chatId}`);
    } catch (error) {
        logger.error(`[Notification] Failed to send lab report notification to ${chatId}:`, error);
    }
}

/**
 * Send pre-visit intake forms and instructions.
 */
async function sendIntakeForms(chatId, department, appointmentTime) {
    let instructions = "Please remember to bring your ID and insurance card.";
    if (department === 'General Medicine' || department === 'Cardiology') {
        instructions += "\n\nNote: If you are having blood work, please fast for 12 hours prior to your appointment.";
    }

    const formLink = `https://clinic-portal.com/intake?dept=${encodeURIComponent(department)}`;
    const message = `📋 *Pre-Visit Preparation:* \n\nWe look forward to seeing you at ${appointmentTime}. To save time during check-in, please complete our digital intake form before you arrive: \n\n🔗 ${formLink} \n\n*Instructions:* \n${instructions}`;
    
    try {
        await sendMessage(chatId, message);
        logger.info(`[Notification] Intake forms sent to ${chatId}`);
    } catch (error) {
        logger.error(`[Notification] Failed to send intake forms to ${chatId}:`, error);
    }
}

module.exports = {
    notifyLabReport,
    sendIntakeForms
};
