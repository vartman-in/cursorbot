'use strict';

const assert = require('assert');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-signing-secret-that-is-long-enough';
process.env.STAFF_USERS_JSON = JSON.stringify([
    {
        email: 'reception@example.com',
        password: 'correct-horse-battery-staple',
        name: 'Reception Test User',
        roles: ['receptionist'],
        clinicIds: ['clinic-city-health'],
    },
]);

const {
    authenticateCredentials,
    issueStaffToken,
    canAccessClinic,
} = require('../services/staffAuthService');

(async () => {
    const authenticated = await authenticateCredentials('RECEPTION@example.com', 'correct-horse-battery-staple');
    assert(authenticated, 'The configured receptionist must be able to sign in.');
    assert.strictEqual(authenticated.email, 'reception@example.com');
    assert(canAccessClinic(authenticated, 'clinic-city-health'), 'Staff should access their assigned clinic.');
    assert(!canAccessClinic(authenticated, 'clinic-metro-dental'), 'Staff should not access an unassigned clinic.');

    const rejected = await authenticateCredentials('reception@example.com', 'incorrect-password');
    assert.strictEqual(rejected, null, 'Incorrect passwords must be rejected.');

    const token = issueStaffToken(authenticated);
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: 'jarvis-clinic-receptionist',
        audience: 'dashboard',
    });
    assert.deepStrictEqual(payload.roles, ['receptionist']);
    assert.deepStrictEqual(payload.clinicIds, ['clinic-city-health']);

    console.log('PASS: staff authentication and tenant authorization safeguards work as expected.');
})().catch((err) => {
    console.error(`FAIL: ${err.message}`);
    process.exitCode = 1;
});
