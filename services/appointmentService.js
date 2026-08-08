// services/appointmentService.js
'use strict';

const { appointments, db } = require('./databaseService');
const { sendMessage } = require('./greenApi');
const { logger } = require('../errorHandler');

/**
 * Appointment Service
 * Handles complex booking logic, availability checks, and reminders.
 */

const DEPARTMENTS = [
    'General Medicine',
    'Pediatrics',
    'Cardiology',
    'Orthopedics',
    'Dental'
];

/**
 * Get available slots for a department/doctor on a specific date.
 * (Simulated logic - in a real app, this would query an EMR API)
 */
async function getAvailableSlots(department, date) {
    // For demonstration, we'll return a fixed set of slots
    // In a real scenario, we'd query Firestore or an EMR
    const slots = [
        '09:00 AM', '10:00 AM', '11:00 AM', 
        '02:00 PM', '03:00 PM', '04:00 PM'
    ];
    
    // Filter out already booked slots for this date/department
    const existing = await db.collection('appointments')
        .where('department', '==', department)
        .where('date', '==', date)
        .where('status', '==', 'booked')
        .get();
    
    const bookedTimes = existing.docs.map(doc => doc.data().time);
    return slots.filter(slot => !bookedTimes.includes(slot));
}

/**
 * Process a booking request.
 */
async function bookAppointment(patientId, details) {
    const { department, date, time, doctor } = details;
    
    const appointmentData = {
        patientId,
        department,
        date,
        time,
        doctor: doctor || 'Assigned Physician',
        dateTime: new Date(`${date} ${time}`)
    };
    
    return await appointments.create(appointmentData);
}

/**
 * Send appointment reminders.
 * This would be called by a cron job.
 */
async function sendReminders() {
    // 24-hour reminders
    const upcoming24h = await appointments.getUpcoming(24);
    for (const appt of upcoming24h) {
        if (!appt.reminderSent['24h']) {
            const message = `🔔 *Appointment Reminder:* \n\nYou have an appointment tomorrow, ${appt.date} at ${appt.time} in the ${appt.department} department. \n\nPlease reply with 'CONFIRM' to let us know you're coming, or 'RESCHEDULE' if you need to change.`;
            await sendMessage(appt.patientId, message);
            await db.collection('appointments').doc(appt.id).update({
                'reminderSent.24h': true
            });
        }
    }

    // 2-hour reminders
    const upcoming2h = await appointments.getUpcoming(2);
    for (const appt of upcoming2h) {
        if (!appt.reminderSent['2h']) {
            const message = `⏰ *Upcoming Appointment:* \n\nJust a quick reminder that your appointment is in 2 hours (${appt.time}). See you soon!`;
            await sendMessage(appt.patientId, message);
            await db.collection('appointments').doc(appt.id).update({
                'reminderSent.2h': true
            });
        }
    }
}

module.exports = {
    DEPARTMENTS,
    getAvailableSlots,
    bookAppointment,
    sendReminders
};
