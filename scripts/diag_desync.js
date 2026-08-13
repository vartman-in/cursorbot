'use strict';

const { db } = require('../db');

async function diagnose() {
    console.log("--- Firestore Diagnostics ---");
    if (!db) {
        console.error("❌ Database not connected");
        return;
    }

    const instanceId = '1101826071'; // From screenshot logs
    const dashboardClinicId = 'tenant_0283a9d331ba'; // From dashboard screenshot
    const patientChatId = '918426862111@c.us'; // From WhatsApp screenshot

    console.log(`Checking Clinic ID: ${dashboardClinicId}`);
    const clinicDoc = await db.collection('clinics').doc(dashboardClinicId).get();
    if (clinicDoc.exists) {
        console.log("✅ Clinic Doc Found:", JSON.stringify(clinicDoc.data(), null, 2));
    } else {
        console.log("❌ Clinic Doc NOT FOUND by ID");
    }

    console.log(`Searching clinics for instanceId: ${instanceId}`);
    const clinicsByInstance = await db.collection('clinics').where('whatsapp.instanceId', '==', instanceId).get();
    if (!clinicsByInstance.empty) {
        clinicsByInstance.forEach(doc => {
            console.log(`✅ Found Clinic by instanceId: ${doc.id}`, JSON.stringify(doc.data(), null, 2));
        });
    } else {
        console.log("❌ No Clinic found by instanceId");
    }

    console.log(`Checking Patient: ${patientChatId}`);
    const patientDoc = await db.collection('patients').doc(patientChatId).get();
    if (patientDoc.exists) {
        console.log("✅ Patient Doc Found:", JSON.stringify(patientDoc.data(), null, 2));
    } else {
        console.log("❌ Patient Doc NOT FOUND");
    }

    console.log("--- End Diagnostics ---");
    process.exit(0);
}

diagnose().catch(err => {
    console.error(err);
    process.exit(1);
});
