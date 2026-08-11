// services/clinicHoursService.js
'use strict';

/**
 * Enforce clinic operating hours before issuing live, same-day tokens.
 * This is a server-side control, not an LLM instruction, so a token cannot be
 * issued accidentally when a clinic is closed.
 */

const TIME_ZONE = 'Asia/Kolkata';
const DAY_ORDER = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const DEFAULT_SCHEDULE = {
    Monday: { open: '09:00', close: '20:00' },
    Tuesday: { open: '09:00', close: '20:00' },
    Wednesday: { open: '09:00', close: '20:00' },
    Thursday: { open: '09:00', close: '20:00' },
    Friday: { open: '09:00', close: '20:00' },
    Saturday: { open: '09:00', close: '20:00' },
    Sunday: null,
};

function getIstParts(date = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE,
        weekday: 'long',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    });

    const parts = Object.fromEntries(formatter.formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]));

    return {
        weekday: parts.weekday,
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
    };
}

function timeToMinutes(time) {
    const match = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    return (Number(match[1]) * 60) + Number(match[2]);
}

function displayTime(time) {
    const mins = timeToMinutes(time);
    if (mins === null) return time;
    const hour24 = Math.floor(mins / 60);
    const minute = mins % 60;
    const suffix = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = (hour24 % 12) || 12;
    return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function getClinicSchedule(clinicData = {}) {
    // Future-ready: a tenant may pass a structured schedule map directly.
    const structured = clinicData.operatingHours || clinicData.profile?.operatingHours || clinicData.clinic_info?.operatingHours;
    if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
        return { ...DEFAULT_SCHEDULE, ...structured };
    }

    // Current onboarding/default tenant configuration is Mon–Sat, 9 AM–8 PM;
    // Sunday closed. Text timings remain part of the prompt but cannot override
    // this safety default until structured hours are configured per clinic.
    return { ...DEFAULT_SCHEDULE };
}

function dateLabel(year, month, day) {
    const localDate = new Date(Date.UTC(year, month - 1, day));
    return new Intl.DateTimeFormat('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    }).format(localDate);
}

function findNextOpening(schedule, ist) {
    const utcCursor = new Date(Date.UTC(ist.year, ist.month - 1, ist.day));

    for (let offset = 0; offset < 8; offset += 1) {
        const candidate = new Date(utcCursor.getTime() + (offset * 86400000));
        const dayName = DAY_ORDER[candidate.getUTCDay()];
        const slot = schedule[dayName];

        if (!slot || !slot.open || !slot.close) continue;

        const candidateDate = {
            year: candidate.getUTCFullYear(),
            month: candidate.getUTCMonth() + 1,
            day: candidate.getUTCDate(),
            weekday: dayName,
        };
        const nowMinutes = (offset === 0) ? ((ist.hour * 60) + ist.minute) : -1;
        const openMinutes = timeToMinutes(slot.open);
        const closeMinutes = timeToMinutes(slot.close);

        if (offset === 0 && nowMinutes >= openMinutes && nowMinutes < closeMinutes) {
            return { ...candidateDate, time: `${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}`, slot, isToday: true };
        }

        // Before opening: today is the next available day. After closing:
        // continue to the next calendar day rather than returning today's
        // already-passed opening time.
        if (offset === 0 && nowMinutes < openMinutes) {
            return { ...candidateDate, time: slot.open, slot, isToday: true };
        }

        if (offset > 0) {
            return { ...candidateDate, time: slot.open, slot, isToday: false };
        }
    }

    return null;
}

/**
 * Determine whether a live token may be issued now.
 */
function getLiveTokenAvailability(clinicData = {}, now = new Date()) {
    const schedule = getClinicSchedule(clinicData);
    const ist = getIstParts(now);
    const todaysHours = schedule[ist.weekday];
    const nowMinutes = (ist.hour * 60) + ist.minute;
    const openMinutes = todaysHours ? timeToMinutes(todaysHours.open) : null;
    const closeMinutes = todaysHours ? timeToMinutes(todaysHours.close) : null;
    const nextOpening = findNextOpening(schedule, ist);

    const isOpenNow = Boolean(todaysHours && openMinutes !== null && closeMinutes !== null && nowMinutes >= openMinutes && nowMinutes < closeMinutes);

    if (isOpenNow) {
        return {
            canIssueLiveToken: true,
            reason: null,
            now: ist,
            todaysHours,
            nextOpening,
        };
    }

    let reason = 'closed';
    if (!todaysHours) reason = 'closed_day';
    else if (nowMinutes < openMinutes) reason = 'before_opening';
    else if (nowMinutes >= closeMinutes) reason = 'after_closing';

    return {
        canIssueLiveToken: false,
        reason,
        now: ist,
        todaysHours,
        nextOpening,
    };
}

function buildClosedHoursReply(clinicData = {}, now = new Date()) {
    const availability = getLiveTokenAvailability(clinicData, now);
    const clinicName = clinicData?.clinic_info?.name || clinicData?.profile?.name || 'the clinic';

    if (availability.canIssueLiveToken) return null;

    const next = availability.nextOpening;
    if (!next) {
        return `Namastey sir, ${clinicName} is currently closed. Kripya clinic se directly sampark karein for the next available appointment.`;
    }

    const dateText = dateLabel(next.year, next.month, next.day);
    const openingText = displayTime(next.time);
    const hoursText = next.slot ? `${displayTime(next.slot.open)} to ${displayTime(next.slot.close)}` : openingText;

    return `Namastey sir, ${clinicName} is currently closed, isliye abhi live token issue nahi ho sakta. ` +
        `Next consultation hours are ${dateText}, ${hoursText}. Kripya ${openingText} ke baad message karke live token book karein.`;
}

module.exports = {
    TIME_ZONE,
    getClinicSchedule,
    getLiveTokenAvailability,
    buildClosedHoursReply,
};
