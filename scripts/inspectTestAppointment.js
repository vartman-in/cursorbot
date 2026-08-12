'use strict';

require('dotenv').config();
const { db } = require('../db');

const appointmentId = process.argv[2];

async function main() {
    if (!appointmentId) {
        throw new Error('Usage: node scripts/inspectTestAppointment.js <appointmentId>');
    }
    if (!db) {
        throw new Error('Firestore is unavailable in this environment.');
    }

    const snapshot = await db.collection('appointments').doc(appointmentId).get();
    if (!snapshot.exists) {
        console.log(JSON.stringify({ found: false, appointmentId }, null, 2));
        return;
    }

    const item = snapshot.data();
    const dateTime = item.dateTime?.toDate ? item.dateTime.toDate().toISOString() : String(item.dateTime || '');
    console.log(JSON.stringify({
        found: true,
        appointmentId: snapshot.id,
        clinicId: item.clinicId || null,
        patientId: item.patientId || null,
        phone: item.phone || null,
        department: item.department || null,
        date: item.date || null,
        time: item.time || null,
        status: item.status || null,
        dateTime,
        createdAt: item.createdAt?.toDate ? item.createdAt.toDate().toISOString() : null,
    }, null, 2));
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
