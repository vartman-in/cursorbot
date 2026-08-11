'use strict';

const assert = require('assert');
const {
    getSlotsForDate,
    getNextAvailableDates,
    displaySlot,
} = require('../services/appointmentService');

(async () => {
    const clinicData = {
        operatingHours: {
            Monday: { open: '09:00', close: '10:00' },
            Tuesday: { open: '09:00', close: '10:00' },
            Wednesday: { open: '09:00', close: '10:00' },
            Thursday: { open: '09:00', close: '10:00' },
            Friday: { open: '09:00', close: '10:00' },
            Saturday: null,
            Sunday: null,
        },
        holidays: ['2026-01-26'],
        appointmentSettings: { slotMinutes: 20, breaks: [{ start: '09:20', end: '09:40' }] },
    };

    const mondaySlots = getSlotsForDate({
        clinicData,
        department: 'General Medicine',
        date: '2026-01-05', // Monday
    });
    assert.deepStrictEqual(mondaySlots, ['09:00', '09:40']);
    assert.deepStrictEqual(getSlotsForDate({ clinicData, department: 'General Medicine', date: '2026-01-04' }), []); // Sunday
    assert.deepStrictEqual(getSlotsForDate({ clinicData, department: 'General Medicine', date: '2026-01-26' }), []); // holiday

    const dates = await getNextAvailableDates({ clinicData, fromDate: '2026-01-24', days: 4 });
    assert.deepStrictEqual(dates, ['2026-01-27'], 'A configured holiday must be excluded from available appointment dates.');
    // Remove holiday before re-checking the next valid open dates.
    clinicData.holidays = [];
    const openDates = await getNextAvailableDates({ clinicData, fromDate: '2026-01-24', days: 4 });
    assert.deepStrictEqual(openDates, ['2026-01-26', '2026-01-27']);
    assert.strictEqual(displaySlot('14:05'), '2:05 PM');

    console.log('PASS: future slot generation respects clinics hours, breaks, and closures.');
})().catch((error) => {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
});
