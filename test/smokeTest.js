'use strict';

/**
 * Clinic AI Receptionist production smoke suite.
 * It makes no WhatsApp, AI, or live Firestore calls and covers deterministic
 * safety rules that must remain correct for every clinic tenant.
 */
const assert = require('assert');
let passed = 0;
let failed = 0;

function verify(condition, label) {
    if (condition) { console.log(`  PASS  ${label}`); passed += 1; }
    else { console.error(`  FAIL  ${label}`); failed += 1; }
}
function same(actual, expected, label) {
    try { assert.deepStrictEqual(actual, expected); verify(true, label); }
    catch (_error) { console.error(`  FAIL  ${label}\n        expected: ${JSON.stringify(expected)}\n        received: ${JSON.stringify(actual)}`); failed += 1; }
}
function mustThrow(fn, pattern, label) {
    try { assert.throws(fn, pattern); verify(true, label); }
    catch (error) { console.error(`  FAIL  ${label}: ${error.message}`); failed += 1; }
}
async function mustReject(fn, pattern, label) {
    try { await assert.rejects(fn, pattern); verify(true, label); }
    catch (error) { console.error(`  FAIL  ${label}: ${error.message}`); failed += 1; }
}

async function run() {
    console.log('\nClinic AI Receptionist — Production Smoke Tests\n');
    const queue = require('../services/queueService');
    const appointments = require('../services/appointmentService');
    const triage = require('../services/triageService');
    const staffAuth = require('../services/staffAuthService');
    const clinicHours = require('../services/clinicHoursService');
    const audit = require('../services/auditService');

    console.log('── 1. Core module contracts ──');
    [
        [queue.getQueueState, 'queueService.getQueueState'], [queue.issueToken, 'queueService.issueToken'],
        [queue.advanceQueue, 'queueService.advanceQueue'], [queue.estimateWait, 'queueService.estimateWait'], [queue.bookToken, 'queueService.bookToken'],
        [appointments.getSlotsForDate, 'appointmentService.getSlotsForDate'],
        [appointments.getNextAvailableDates, 'appointmentService.getNextAvailableDates'],
        [appointments.bookFutureAppointment, 'appointmentService.bookFutureAppointment'],
        [triage.triageMessage, 'triageService.triageMessage'],
        [staffAuth.authenticateCredentials, 'staffAuthService.authenticateCredentials'],
        [staffAuth.issueStaffToken, 'staffAuthService.issueStaffToken'],
        [clinicHours.getLiveTokenAvailability, 'clinicHoursService.getLiveTokenAvailability'],
        [audit.logStaffAction, 'auditService.logStaffAction'],
    ].forEach(([fn, name]) => verify(typeof fn === 'function', `${name} is exported`));

    console.log('\n── 2. Queue identity and wait-time math ──');
    const date = '2026-08-10';
    const fresh = await queue.getQueueState('clinic-01', 'General Medicine', date);
    same(fresh.clinicId, 'clinic-01', 'queue state remains scoped to its tenant');
    same(fresh.department, 'General Medicine', 'queue state remains scoped to its department');
    same(fresh.date, date, 'queue state remains scoped to its consultation date');
    same(fresh.lastIssuedToken, 0, 'a new queue starts with no issued tokens');
    same(fresh.currentToken, 0, 'a new queue starts with no consultation in progress');
    same(queue.estimateWait({ ...fresh, lastIssuedToken: 5 }, 3), 30, 'third waiting token estimates 30 minutes');
    same(queue.estimateWait({ ...fresh, currentToken: 3, delayMinutes: 15 }, 3), 0, 'token in consultation has no wait');
    same(queue.estimateWait({ ...fresh, currentToken: 1, priorityQueue: [5], delayMinutes: 5 }, 5), 5, 'first priority token includes only configured delay');
    same(queue.estimateWait({ ...fresh, currentToken: 1, priorityQueue: [5], delayMinutes: 5 }, 4), 45, 'normal token includes priority and delay');
    same(queue.estimateWait({ ...fresh, currentToken: 1, completedTokens: [2] }, 2), 0, 'completed token cannot receive a new wait estimate');

    console.log('\n── 3. Clinic-hours enforcement ──');
    const clinic = { clinic_info: { name: 'Test Clinic' }, operatingHours: {
        Monday: { open: '09:00', close: '20:00' }, Tuesday: { open: '09:00', close: '20:00' },
        Wednesday: { open: '09:00', close: '20:00' }, Thursday: { open: '09:00', close: '20:00' },
        Friday: { open: '09:00', close: '20:00' }, Saturday: { open: '09:00', close: '20:00' }, Sunday: null,
    }};
    const at = (value) => new Date(value);
    verify(clinicHours.getLiveTokenAvailability(clinic, at('2026-08-10T10:00:00+05:30')).canIssueLiveToken, 'live token is permitted during scheduled Monday hours');
    same(clinicHours.getLiveTokenAvailability(clinic, at('2026-08-10T08:59:00+05:30')).reason, 'before_opening', 'token is blocked before opening');
    same(clinicHours.getLiveTokenAvailability(clinic, at('2026-08-10T20:00:00+05:30')).reason, 'after_closing', 'token is blocked at the closing boundary');
    const sunday = clinicHours.getLiveTokenAvailability(clinic, at('2026-08-09T12:00:00+05:30'));
    same(sunday.reason, 'closed_day', 'token is blocked on Sunday');
    verify(clinicHours.buildClosedHoursReply(clinic, at('2026-08-09T12:00:00+05:30')).includes('live token issue nahi ho sakta'), 'closed-hours reply explicitly refuses a live token');

    console.log('\n── 4. Triage safety routing ──');
    same(triage.triageMessage('I have severe chest pain').level, 'emergency', 'chest pain is routed to emergency escalation');
    same(triage.triageMessage('Mere bachche ko high fever hai').level, 'emergency', 'high fever in a child is routed to emergency escalation');
    same(triage.triageMessage('Mujhe sugar check up jaldi chahiye').level, 'urgent', 'urgent blood-sugar message receives priority attention');
    same(triage.triageMessage('Please book a routine consultation').level, 'routine', 'routine booking remains a receptionist request');
    verify(triage.getEmergencyReply().includes('diagnosis nahi kar sakta'), 'emergency reply contains no diagnostic claim');
    verify(triage.getUrgentReply().includes('diagnosis nahi kar sakta'), 'urgent reply contains no diagnostic claim');

    console.log('\n── 5. Future scheduling safeguards ──');
    const schedulingClinic = { operatingHours: {
        Monday: { open: '09:00', close: '10:00' }, Tuesday: { open: '09:00', close: '10:00' },
        Wednesday: { open: '09:00', close: '10:00' }, Thursday: { open: '09:00', close: '10:00' },
        Friday: { open: '09:00', close: '10:00' }, Saturday: null, Sunday: null,
    }, holidays: ['2026-01-26'], appointmentSettings: { slotMinutes: 20, breaks: [{ start: '09:20', end: '09:40' }] }};
    same(appointments.getSlotsForDate({ clinicData: schedulingClinic, department: 'General Medicine', date: '2026-01-05' }), ['09:00', '09:40'], 'slot generation respects appointment duration and break');
    same(appointments.getSlotsForDate({ clinicData: schedulingClinic, department: 'General Medicine', date: '2026-01-04' }), [], 'Sunday has no future appointment slots');
    same(appointments.getSlotsForDate({ clinicData: schedulingClinic, department: 'General Medicine', date: '2026-01-26' }), [], 'clinic holiday has no future appointment slots');
    mustThrow(() => appointments.getSlotsForDate({ clinicData: schedulingClinic, department: 'General Medicine', date: 'invalid' }), /valid appointment date/, 'invalid appointment date is rejected');
    same(appointments.displaySlot('14:05'), '2:05 PM', 'slot displays in patient-friendly time');
    await mustReject(() => appointments.bookFutureAppointment({ clinicId: 'clinic-01', patientId: 'patient-01', department: 'General Medicine', date: '2020-01-01', time: '09:00' }), /Appointment database is unavailable/, 'booking safely fails while database is unavailable');

    console.log('\n── 6. Staff authentication and tenant scoping ──');
    const previousJwt = process.env.JWT_SECRET;
    const previousUsers = process.env.STAFF_USERS_JSON;
    process.env.JWT_SECRET = 'unit-test-signing-secret';
    process.env.STAFF_USERS_JSON = JSON.stringify([
        { id: 'reception-01', email: 'frontdesk@test.example', password: 'correct-password', name: 'Front Desk', roles: ['receptionist'], clinicIds: ['clinic-01'] },
        { id: 'admin-01', email: 'admin@test.example', password: 'correct-password', name: 'Clinic Admin', roles: ['admin'], clinicIds: ['*'] },
    ]);
    const receptionist = await staffAuth.authenticateCredentials('FRONTDESK@test.example', 'correct-password');
    verify(Boolean(receptionist), 'staff user authenticates with valid credentials');
    same(await staffAuth.authenticateCredentials('frontdesk@test.example', 'wrong-password'), null, 'invalid staff password is rejected');
    const token = staffAuth.issueStaffToken(receptionist);
    verify(typeof token === 'string' && token.split('.').length === 3, 'staff receives a signed JWT');
    verify(staffAuth.canAccessClinic(receptionist, 'clinic-01'), 'receptionist can access assigned clinic');
    verify(!staffAuth.canAccessClinic(receptionist, 'clinic-02'), 'receptionist cannot access another clinic');
    const admin = await staffAuth.authenticateCredentials('admin@test.example', 'correct-password');
    verify(staffAuth.canAccessClinic(admin, 'clinic-02'), 'wildcard administrator may access provisioned clinics');
    if (previousJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousJwt;
    if (previousUsers === undefined) delete process.env.STAFF_USERS_JSON; else process.env.STAFF_USERS_JSON = previousUsers;

    console.log('\n── 7. Audit record correlation ──');
    const auditEvent = await audit.logStaffAction({ clinicId: 'clinic-01', actor: { email: 'frontdesk@test.example', role: 'receptionist' }, action: 'queue.advance', target: { queueDate: date, department: 'General Medicine' }, requestId: 'req-smoke-test-001' });
    same(auditEvent.clinicId, 'clinic-01', 'audit event retains clinic ID');
    same(auditEvent.action, 'queue.advance', 'audit event retains mutation action');
    same(auditEvent.requestId, 'req-smoke-test-001', 'audit event retains request correlation ID');

    console.log(`\nSmoke test result: ${passed} passed, ${failed} failed.`);
    if (failed) process.exitCode = 1;
}

run().catch((error) => { console.error(`\nSmoke test crashed: ${error.stack || error.message}`); process.exitCode = 1; });
