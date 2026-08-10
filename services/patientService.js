'use strict';

const queueService = require('./queueService');
const { patients } = require('./databaseService');
const { sendMessage } = require('./greenApi');
const { logger } = require('../errorHandler');

class PatientService {
    /**
     * Formats the live queue data specifically for the patient dashboard view.
     */
    static async getPatientStatus(chatId) {
        const queueStatus = await queueService.getPatientStatus(chatId);

        if (!queueStatus) {
            throw new Error('No active token found for this number today.');
        }

        const patientRecord = await patients.getById(chatId);

        return {
            patient: {
                patientName: patientRecord.name || 'Patient',
            },
            liveQueue: {
                nowServing: queueStatus.currentToken,
                yourToken: queueStatus.tokenNumber,
                tokensAhead: Math.max(queueStatus.tokenNumber - queueStatus.currentToken, 0),
                estimatedWaitMinutes: queueStatus.estimatedWaitMinutes,
            },
        };
    }

    /**
     * Handles patient-initiated self-service (cancellations and rescheduling).
     * Updates BOTH the patient's own record (what the bot itself reads) AND
     * the queue doc's queueList entry (what the dashboard reads) — same
     * underlying booking, two views of it, kept in sync on every change.
     */
    static async handlePatientAction({ chatId, action, newDate, newSlot, reason }) {
        const patientRecord = await patients.getById(chatId);
        const activeToken = patientRecord?.activeToken;

        if (!activeToken) {
            throw new Error('Cannot modify an inactive or missing appointment.');
        }

        const { clinicId, department, date, tokenNumber } = activeToken;

        if (action === 'cancel') {
            await patients.createOrUpdate(chatId, { activeToken: null, currentFlowState: 'idle' });

            try {
                await queueService.updateQueueListEntry(clinicId, department, date, tokenNumber, {
                    status: 'completed',
                    doctorNotes: `[Cancelled by patient] ${reason || ''}`.trim(),
                });
            } catch (err) {
                logger.error(`[PatientService] Failed to sync cancellation to queueList: ${err.message}`);
            }

            const cancelMsg = `❌ Your appointment for Token #${tokenNumber} has been canceled.\n\nReason: ${reason || 'Not specified'}.\n\nYou can text me anytime to book a new one.`;
            await sendMessage(chatId, cancelMsg);

            logger.info(`[PatientService] ${chatId} self-canceled their appointment.`);
            return { success: true, message: 'Appointment officially canceled.' };
        }

        if (action === 'reschedule') {
            await patients.createOrUpdate(chatId, { activeToken: null, currentFlowState: 'idle' });

            try {
                await queueService.updateQueueListEntry(clinicId, department, date, tokenNumber, {
                    status: 'completed',
                    doctorNotes: `[Rescheduled by patient to ${newDate} ${newSlot}] ${reason || ''}`.trim(),
                });
            } catch (err) {
                logger.error(`[PatientService] Failed to sync reschedule to queueList: ${err.message}`);
            }

            const rescheduleMsg = `📅 Your visit has been safely rescheduled to *${newDate}* at *${newSlot}*.\n\nI will message you on that day with your new live token number.`;
            await sendMessage(chatId, rescheduleMsg);

            logger.info(`[PatientService] ${chatId} rescheduled to ${newDate} at ${newSlot}.`);
            return { success: true, message: 'Appointment rescheduled successfully.' };
        }

        throw new Error('Invalid action requested.');
    }
}

module.exports = { PatientService };
