'use strict';

async function runSimulation() {
    console.log('🚀 Starting Emergency Triage & Dashboard Desync Simulation...');

    // 1. Load services
    const triageService = require('../services/triageService');
    const { db } = require('../db');

    const testPhone = '918426862111';
    const testClinicId = 'tenant_0283a9d331ba';
    const message = 'Mera 3 saal ka beta hai, usko achanak se bahot tez bukhar aa gaya hai aur saans lene mein thodi dikkat ho rahi hai.';

    console.log(`\n📨 [Simulated Patient Message]: "${message}"`);
    console.log(`📱 [Sender Phone]: ${testPhone}`);

    // 2. Test triage check
    const triageRes = triageService.triageMessage(message);
    const isEmerg = triageService.isEmergency(message);
    const replyText = triageService.getEmergencyReply();

    console.log(`\n🩺 [Triage Result]: level=${triageRes.level}, isEmergency=${isEmerg}`);
    console.log(`💬 [Emergency Reply]: ${replyText}`);

    if (!isEmerg) {
        console.error('❌ Triage failed to detect emergency!');
        process.exit(1);
    }

    // 3. Simulate state persistence (same as webhook.js on emergency)
    const patientRef = db.collection('patients').doc(testPhone);
    const patientData = {
        name: 'Simulation Parent',
        phone: testPhone,
        clinicId: testClinicId,
        currentFlowState: 'human_handling',
        emergencyFlag: true,
        aiNotes: replyText,
        conversationHistory: [
            { role: 'user', content: message, timestamp: new Date() },
            { role: 'assistant', content: replyText, timestamp: new Date() }
        ],
        updatedAt: new Date()
    };

    await patientRef.set(patientData, { merge: true });
    console.log('💾 [Database]: Patient record successfully saved with `currentFlowState: "human_handling"` and `emergencyFlag: true`.');

    // 4. Query human handoff endpoint logic (same as queueService.getHumanHandoffPatients)
    const queueService = require('../services/queueService');
    const handoffPatients = await queueService.getHumanHandoffPatients(testClinicId);

    console.log(`\n📊 [Dashboard Human Handoff API Output for ${testClinicId}]:`);
    console.log(JSON.stringify(handoffPatients, null, 2));

    const found = handoffPatients.find(p => p.phone === testPhone);
    if (found) {
        console.log('\n✅ SUCCESS: Patient successfully appeared in the Dashboard Human Handoff API!');
    } else {
        console.error('\n❌ FAILURE: Patient not found in Dashboard Human Handoff API.');
        process.exit(1);
    }

    console.log('\n🎉 Simulation completed successfully. The dashboard will now reflect this emergency in real-time during the next 5s poll cycle.');
}

runSimulation().catch(err => {
    console.error('❌ Simulation crashed:', err);
    process.exit(1);
});
