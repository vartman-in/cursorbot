'use strict';

const assert = require('assert');
const { triageMessage, getEmergencyReply, getUrgentReply } = require('../services/triageService');

const cases = [
    ['Meri chhati mein tez dard ho raha hai', 'emergency'],
    ['Baby ko high fever hai', 'emergency'],
    ['Mujhe sugar check up jaldi karwana hai', 'urgent'],
    ['Can I book a skin consultation tomorrow?', 'routine'],
];

for (const [message, expected] of cases) {
    assert.strictEqual(triageMessage(message).level, expected, `${message} should be ${expected}`);
}
assert(/diagnosis/i.test(getEmergencyReply()));
assert(/diagnosis/i.test(getUrgentReply()));
console.log('PASS: triage safety screen identifies emergency, urgent, and routine messages.');
