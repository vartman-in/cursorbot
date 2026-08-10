'use strict';

const { sendMessage } = require('./greenApi');
const { logger } = require('../errorHandler');
const queueService = require('./queueService');

/**
 * Composite id encoding department+date+tokenNumber into a single string so
 * the dashboard can treat each queueList entry like a normal "appointment
 * record" (with an id it can round-trip back to us) without us needing a
 * separate collection that could drift from the real queue.
 */
function encodeAppointmentId(department, date, tokenNumber) {
    return `${department}__${date}__${tokenNumber}`;
}

function decodeAppointmentId(appointmentId) {
    const parts = String(appointmentId).split('__');
    if (parts.length !== 3) throw new Error(`Malformed appointmentId: ${appointmentId}`);
    const [department, date, tokenNumberStr] = parts;
    return { department, date, tokenNumber: Number(tokenNumberStr) };
}

class DoctorService {
    /**
     * Aggregates today's queueList and calculates live financial metrics —
     * reads directly from the same queue doc the bot itself writes to.
     */
    static async getDoctorDashboard(clinicId, doctorName, department, date) {
        const queueState = await queueService.getQueueState(clinicId, department, date);
        const queueList = queueState.queueList || [];

        let totalCollected = 0, upiPayments = 0, cashPayments = 0, onlinePayments = 0, pendingAmount = 0;

        const appointments = queueList
            .map((entry) => {
                const fee = Number(entry.feeAmount) || 0;
                if (entry.paymentStatus === 'paid') {
                    totalCollected += fee;
                    if (entry.paymentMode === 'UPI') upiPayments += fee;
                    else if (entry.paymentMode === 'Cash') cashPayments += fee;
                    else if (entry.paymentMode === 'Online') onlinePayments += fee;
                } else {
                    pendingAmount += fee;
                }
                return { id: encodeAppointmentId(department, date, entry.tokenNumber), ...entry };
            })
            .sort((a, b) => (a.tokenNumber || 0) - (b.tokenNumber || 0));

        return {
            financialLedger: { totalCollected, upiPayments, cashPayments, onlinePayments, pendingAmount },
            appointments,
        };
    }

    /**
     * Saves clinical notes and optionally dispatches the WhatsApp Rx.
     */
    static async saveClinicalNotes({ clinicId, appointmentId, doctorNotes, prescriptions, feeAmount, paymentMode, paymentStatus, markCompleted }) {
        const { department, date, tokenNumber } = decodeAppointmentId(appointmentId);

        const patch = {
            doctorNotes: doctorNotes || '',
            prescriptions: prescriptions || '',
            feeAmount: Number(feeAmount) || 0,
            paymentMode: paymentMode || 'Cash',
            paymentStatus: paymentStatus || 'pending',
            status: markCompleted ? 'completed' : 'in-consultation',
        };

        const updatedEntry = await queueService.updateQueueListEntry(clinicId, department, date, tokenNumber, patch);

        if (markCompleted && prescriptions && updatedEntry.chatId) {
            const rxMessage =
                `🏥 *Digital Prescription (Rx)*\n\n` +
                `*Patient:* ${updatedEntry.patientName}\n` +
                `*Diagnosis / Notes:* ${doctorNotes}\n\n` +
                `*💊 Medications:*\n${prescriptions}\n\n` +
                `*Total Fee:* ₹${feeAmount} (${String(paymentStatus).toUpperCase()})\n\n` +
                `_Get well soon! Reply to this message if you have any questions._`;

            try {
                await sendMessage(updatedEntry.chatId, rxMessage);
                logger.info(`[DoctorService] Dispatched digital Rx via Green API to ${updatedEntry.chatId}`);
            } catch (err) {
                logger.error(`[DoctorService] Failed to send Rx WhatsApp message: ${err.message}`);
            }
        }

        return { success: true, message: markCompleted ? 'Prescription sent via WhatsApp' : 'Notes saved' };
    }

    /**
     * Updates the payment ledger for one token.
     */
    static async updatePayment({ clinicId, appointmentId, feeAmount, paymentMode, paymentStatus }) {
        const { department, date, tokenNumber } = decodeAppointmentId(appointmentId);
        await queueService.updateQueueListEntry(clinicId, department, date, tokenNumber, {
            feeAmount: Number(feeAmount),
            paymentMode,
            paymentStatus,
        });
        return { success: true };
    }
}

module.exports = { DoctorService };
