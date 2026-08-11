'use strict';

const { appointments } = require('./databaseService');
const { db } = require('../db');
const { sendMessage } = require('./greenApi');
const { getClinicSchedule, TIME_ZONE } = require('./clinicHoursService');
const { logger } = require('../errorHandler');

const DEPARTMENTS = [
    'General Medicine',
    'Pediatrics',
    'Cardiology',
    'Orthopedics',
    'Dental',
];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ACTIVE_STATUSES = ['booked', 'confirmed', 'checked_in'];

function toIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : value;
}

function timeToMinutes(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return (hours * 60) + minutes;
}

function minutesToTime(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function displaySlot(time) {
    const mins = timeToMinutes(time);
    if (mins === null) return time;
    const hour24 = Math.floor(mins / 60);
    const suffix = hour24 >= 12 ? 'PM' : 'AM';
    return `${(hour24 % 12) || 12}:${String(mins % 60).padStart(2, '0')} ${suffix}`;
}

function weekdayForDate(date) {
    return DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

function uniqueStrings(values) {
    return [...new Set((values || []).map((value) => String(value)))];
}

function appointmentSettings(clinicData = {}) {
    return clinicData.appointmentSettings || clinicData.profile?.appointmentSettings || {};
}

function isHoliday(clinicData, date) {
    const holidays = uniqueStrings(clinicData.holidays || clinicData.profile?.holidays || []);
    return holidays.includes(date);
}

function getDayHours(clinicData, date) {
    const schedule = getClinicSchedule(clinicData);
    return schedule[weekdayForDate(date)] || null;
}

function getSlotConfiguration(clinicData, department, doctorName) {
    const settings = appointmentSettings(clinicData);
    const doctor = (clinicData.doctors || []).find((candidate) =>
        String(candidate.name || candidate.doctorName || '').toLowerCase() === String(doctorName || '').toLowerCase()
    );
    const departmentSettings = settings.departments?.[department] || {};
    return {
        slotMinutes: Number(doctor?.slotMinutes || departmentSettings.slotMinutes || settings.slotMinutes || 20),
        capacity: Math.max(1, Number(doctor?.parallelCapacity || departmentSettings.parallelCapacity || settings.parallelCapacity || 1)),
        breaks: doctor?.breaks || departmentSettings.breaks || settings.breaks || [],
    };
}

function isBreakSlot(slotStart, slotEnd, breaks = []) {
    return breaks.some((item) => {
        const start = timeToMinutes(item.start || item.from);
        const end = timeToMinutes(item.end || item.to);
        return start !== null && end !== null && slotStart < end && slotEnd > start;
    });
}

function getSlotsForDate({ clinicData = {}, department, doctorName, date }) {
    if (!toIsoDate(date)) throw new Error('A valid appointment date (YYYY-MM-DD) is required.');
    if (isHoliday(clinicData, date)) return [];
    const hours = getDayHours(clinicData, date);
    if (!hours?.open || !hours?.close) return [];

    const open = timeToMinutes(hours.open);
    const close = timeToMinutes(hours.close);
    const { slotMinutes, breaks } = getSlotConfiguration(clinicData, department, doctorName);
    if (!Number.isInteger(slotMinutes) || slotMinutes < 5 || slotMinutes > 120 || open === null || close === null) {
        throw new Error('Clinic appointment settings are invalid.');
    }

    const slots = [];
    for (let start = open; start + slotMinutes <= close; start += slotMinutes) {
        const end = start + slotMinutes;
        if (!isBreakSlot(start, end, breaks)) slots.push(minutesToTime(start));
    }
    return slots;
}

function slotKey({ clinicId, department, doctorName, date, time }) {
    return [clinicId, date, department, doctorName || 'any-doctor', time]
        .map((part) => String(part).replace(/[^a-zA-Z0-9_-]/g, '_'))
        .join('__');
}

function buildIstDateTime(date, time) {
    // Stores the intended clinic-local appointment date/time unambiguously.
    return new Date(`${date}T${time}:00+05:30`);
}

async function getAvailableSlots({ clinicId, clinicData, department, date, doctorName = null }) {
    if (!clinicId) throw new Error('clinicId is required.');
    const candidateSlots = getSlotsForDate({ clinicData, department, doctorName, date });
    if (!db || !candidateSlots.length) return candidateSlots;

    const slotPrefix = `${slotKey({ clinicId, department, doctorName, date, time: '' })}`;
    const existingSnapshot = await db.collection('appointmentSlots')
        .where('clinicId', '==', clinicId)
        .where('date', '==', date)
        .where('department', '==', department)
        .get();

    const { capacity } = getSlotConfiguration(clinicData, department, doctorName);
    const bookedCounts = new Map();
    existingSnapshot.docs.forEach((doc) => {
        const item = doc.data();
        const matchesDoctor = !doctorName || item.doctorName === doctorName;
        if (matchesDoctor && ACTIVE_STATUSES.includes(item.status)) {
            bookedCounts.set(item.time, Number(item.bookedCount || 0));
        }
    });

    return candidateSlots.filter((time) => Number(bookedCounts.get(time) || 0) < capacity);
}

async function getNextAvailableDates({ clinicData = {}, fromDate, days = 14 }) {
    const initial = toIsoDate(fromDate) || new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
    const cursor = new Date(`${initial}T00:00:00Z`);
    const dates = [];
    for (let i = 0; i < Math.min(Math.max(Number(days) || 14, 1), 60); i += 1) {
        const date = new Date(cursor.getTime() + (i * 86400000)).toISOString().slice(0, 10);
        if (!isHoliday(clinicData, date) && getDayHours(clinicData, date)?.open) dates.push(date);
    }
    return dates;
}

async function bookFutureAppointment({ clinicId, clinicData, patientId, patientName, phone, department, date, time, doctorName = null, reason = '' }) {
    if (!db) throw new Error('Appointment database is unavailable.');
    if (!clinicId || !patientId || !department || !date || !time) throw new Error('Clinic, patient, department, date, and time are required.');
    const validSlots = getSlotsForDate({ clinicData, department, doctorName, date });
    if (!validSlots.includes(time)) throw new Error('That appointment slot is not available in clinic working hours.');
    if (isHoliday(clinicData, date)) throw new Error('The clinic is closed on the selected date.');
    if (buildIstDateTime(date, time).getTime() <= Date.now()) {
        throw new Error('Please choose a future appointment date and time.');
    }

    const { capacity } = getSlotConfiguration(clinicData, department, doctorName);
    const key = slotKey({ clinicId, department, doctorName, date, time });
    const slotRef = db.collection('appointmentSlots').doc(key);
    const appointmentRef = db.collection('appointments').doc();
    const appointment = {
        id: appointmentRef.id,
        clinicId,
        patientId,
        patientName: patientName || 'Patient',
        phone: phone || '',
        department,
        doctorName: doctorName || null,
        date,
        time,
        dateTime: buildIstDateTime(date, time),
        reason: String(reason || '').slice(0, 500),
        status: 'booked',
        reminderSent: { '24h': false, '2h': false },
        consent: { appointmentNotifications: true, recordedAt: new Date() },
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    await db.runTransaction(async (transaction) => {
        const slotDoc = await transaction.get(slotRef);
        const slot = slotDoc.exists ? slotDoc.data() : null;
        const bookedCount = Number(slot?.bookedCount || 0);
        if (slot && ACTIVE_STATUSES.includes(slot.status) && bookedCount >= capacity) {
            throw new Error('This slot was just booked by another patient. Please choose another time.');
        }

        transaction.set(slotRef, {
            clinicId,
            department,
            doctorName: doctorName || null,
            date,
            time,
            capacity,
            bookedCount: bookedCount + 1,
            status: 'booked',
            updatedAt: new Date(),
        }, { merge: true });
        transaction.set(appointmentRef, appointment);
    });

    return appointment;
}

async function getFutureAppointmentForPatient({ appointmentId, patientId, clinicId }) {
    if (!db) throw new Error('Appointment database is unavailable.');
    if (!appointmentId || !patientId || !clinicId) throw new Error('Appointment ID, patient, and clinic are required.');

    const snapshot = await db.collection('appointments').doc(String(appointmentId)).get();
    if (!snapshot.exists) return null;
    const appointment = { id: snapshot.id, ...snapshot.data() };
    if (appointment.patientId !== patientId || appointment.clinicId !== clinicId) return null;
    if (!ACTIVE_STATUSES.includes(appointment.status)) return null;

    const appointmentDateTime = appointment.dateTime?.toDate ? appointment.dateTime.toDate() : new Date(appointment.dateTime);
    if (Number.isNaN(appointmentDateTime.getTime()) || appointmentDateTime.getTime() <= Date.now()) return null;
    return appointment;
}

async function rescheduleFutureAppointment({ appointmentId, patientId, clinicId, clinicData, date, time, reason = '' }) {
    if (!db) throw new Error('Appointment database is unavailable.');
    if (!appointmentId || !patientId || !clinicId || !date || !time) {
        throw new Error('Appointment ID, patient, clinic, date, and time are required.');
    }

    const appointmentRef = db.collection('appointments').doc(String(appointmentId));
    const targetDateTime = buildIstDateTime(date, time);
    if (targetDateTime.getTime() <= Date.now()) throw new Error('Please choose a future appointment time.');

    return db.runTransaction(async (transaction) => {
        const appointmentSnapshot = await transaction.get(appointmentRef);
        if (!appointmentSnapshot.exists) throw new Error('Appointment was not found.');
        const appointment = { id: appointmentSnapshot.id, ...appointmentSnapshot.data() };
        if (appointment.patientId !== patientId || appointment.clinicId !== clinicId) {
            throw new Error('This appointment is not associated with your WhatsApp number.');
        }
        if (!ACTIVE_STATUSES.includes(appointment.status)) throw new Error('This appointment can no longer be rescheduled.');

        const originalDateTime = appointment.dateTime?.toDate ? appointment.dateTime.toDate() : new Date(appointment.dateTime);
        if (Number.isNaN(originalDateTime.getTime()) || originalDateTime.getTime() <= Date.now()) {
            throw new Error('Only future appointments can be rescheduled.');
        }

        const department = appointment.department;
        const doctorName = appointment.doctorName || null;
        const validSlots = getSlotsForDate({ clinicData, department, doctorName, date });
        if (!validSlots.includes(time)) throw new Error('That replacement time is outside clinic appointment hours.');
        if (isHoliday(clinicData, date)) throw new Error('The clinic is closed on the selected date.');
        if (appointment.date === date && appointment.time === time) throw new Error('Your appointment is already scheduled for that time.');

        const { capacity } = getSlotConfiguration(clinicData, department, doctorName);
        const originalSlotRef = db.collection('appointmentSlots').doc(slotKey({
            clinicId, department, doctorName, date: appointment.date, time: appointment.time,
        }));
        const replacementSlotRef = db.collection('appointmentSlots').doc(slotKey({
            clinicId, department, doctorName, date, time,
        }));
        const [originalSlotSnapshot, replacementSlotSnapshot] = await Promise.all([
            transaction.get(originalSlotRef),
            transaction.get(replacementSlotRef),
        ]);
        const replacementSlot = replacementSlotSnapshot.exists ? replacementSlotSnapshot.data() : null;
        const replacementBookedCount = Number(replacementSlot?.bookedCount || 0);
        if (replacementSlot && ACTIVE_STATUSES.includes(replacementSlot.status) && replacementBookedCount >= capacity) {
            throw new Error('This replacement slot was just booked. Please choose another time.');
        }

        const originalBookedCount = Math.max(0, Number(originalSlotSnapshot.data()?.bookedCount || 1) - 1);
        transaction.set(originalSlotRef, {
            bookedCount: originalBookedCount,
            status: originalBookedCount ? 'booked' : 'available',
            updatedAt: new Date(),
        }, { merge: true });
        transaction.set(replacementSlotRef, {
            clinicId,
            department,
            doctorName,
            date,
            time,
            capacity,
            bookedCount: replacementBookedCount + 1,
            status: 'booked',
            updatedAt: new Date(),
        }, { merge: true });
        transaction.update(appointmentRef, {
            date,
            time,
            dateTime: targetDateTime,
            status: 'booked',
            rescheduleCount: Number(appointment.rescheduleCount || 0) + 1,
            lastReschedule: {
                fromDate: appointment.date,
                fromTime: appointment.time,
                reason: String(reason || '').slice(0, 300),
                changedAt: new Date(),
            },
            updatedAt: new Date(),
        });

        return {
            ...appointment,
            date,
            time,
            dateTime: targetDateTime,
            rescheduleCount: Number(appointment.rescheduleCount || 0) + 1,
        };
    });
}

async function cancelFutureAppointment({ appointmentId, patientId, reason = '' }) {
    if (!db) throw new Error('Appointment database is unavailable.');
    if (!appointmentId || !patientId) throw new Error('Appointment ID and patient ID are required.');
    const appointmentRef = db.collection('appointments').doc(appointmentId);

    return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(appointmentRef);
        if (!snapshot.exists) throw new Error('Appointment was not found.');
        const appointment = snapshot.data();
        if (appointment.patientId !== patientId) throw new Error('You cannot change another patient’s appointment.');
        if (!ACTIVE_STATUSES.includes(appointment.status)) throw new Error('This appointment can no longer be cancelled.');

        const slotRef = db.collection('appointmentSlots').doc(slotKey(appointment));
        const slotSnapshot = await transaction.get(slotRef);
        const bookedCount = Math.max(0, Number(slotSnapshot.data()?.bookedCount || 1) - 1);
        transaction.update(appointmentRef, { status: 'cancelled', cancellationReason: String(reason).slice(0, 300), updatedAt: new Date() });
        transaction.set(slotRef, { bookedCount, status: bookedCount ? 'booked' : 'available', updatedAt: new Date() }, { merge: true });
        return { ...appointment, id: appointmentId, status: 'cancelled' };
    });
}

async function sendReminders() {
    const upcoming24h = await appointments.getUpcoming(24);
    for (const appointment of upcoming24h) {
        if (!appointment.reminderSent?.['24h'] && appointment.consent?.appointmentNotifications !== false) {
            await sendMessage(appointment.patientId, `Namastey sir, reminder: aapka appointment kal ${appointment.date} ko ${displaySlot(appointment.time)} par ${appointment.department} ke liye hai. Kripya CONFIRM ya RESCHEDULE reply karein.`);
            if (db) await db.collection('appointments').doc(appointment.id).update({ 'reminderSent.24h': true, updatedAt: new Date() });
        }
    }

    const upcoming2h = await appointments.getUpcoming(2);
    for (const appointment of upcoming2h) {
        if (!appointment.reminderSent?.['2h'] && appointment.consent?.appointmentNotifications !== false) {
            await sendMessage(appointment.patientId, `Namastey sir, aapka appointment ${displaySlot(appointment.time)} par 2 ghante mein hai. Kripya time par pahunchiye.`);
            if (db) await db.collection('appointments').doc(appointment.id).update({ 'reminderSent.2h': true, updatedAt: new Date() });
        }
    }
}

module.exports = {
    DEPARTMENTS,
    displaySlot,
    getSlotsForDate,
    getAvailableSlots,
    getNextAvailableDates,
    bookFutureAppointment,
    getFutureAppointmentForPatient,
    rescheduleFutureAppointment,
    cancelFutureAppointment,
    sendReminders,
};
