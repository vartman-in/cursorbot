// scripts/testClinicHours.js
'use strict';

const assert = require('assert');
const {
    getLiveTokenAvailability,
    buildClosedHoursReply,
} = require('../services/clinicHoursService');

const clinic = {
    clinic_info: {
        name: 'City Health Clinic',
        timings: 'Mon-Sat: 09:00 AM - 08:00 PM, Sunday: Closed',
    },
};

// 01:48 AM Sunday, 9 August 2026 in Asia/Kolkata.
const sundayEarlyMorning = new Date('2026-08-08T20:18:00.000Z');
const sunday = getLiveTokenAvailability(clinic, sundayEarlyMorning);
assert.strictEqual(sunday.canIssueLiveToken, false);
assert.strictEqual(sunday.reason, 'closed_day');
assert.strictEqual(sunday.nextOpening.weekday, 'Monday');
assert.strictEqual(sunday.nextOpening.time, '09:00');
assert.match(buildClosedHoursReply(clinic, sundayEarlyMorning), /Monday, 10 August 2026/i);

// 9:30 PM Monday in Asia/Kolkata: the clinic has closed for the day.
const mondayAfterClosing = new Date('2026-08-10T16:00:00.000Z');
const afterClosing = getLiveTokenAvailability(clinic, mondayAfterClosing);
assert.strictEqual(afterClosing.canIssueLiveToken, false);
assert.strictEqual(afterClosing.reason, 'after_closing');
assert.strictEqual(afterClosing.nextOpening.weekday, 'Tuesday');

// 10:30 AM Monday in Asia/Kolkata: live token booking is permitted.
const mondayOpen = new Date('2026-08-10T05:00:00.000Z');
const open = getLiveTokenAvailability(clinic, mondayOpen);
assert.strictEqual(open.canIssueLiveToken, true);

console.log('Clinic-hours safeguards: all tests passed.');
