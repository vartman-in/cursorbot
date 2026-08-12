// db.js
'use strict';

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

let app;
let db = null;

if (process.env.FORCE_NULL_DB === 'true') {
    module.exports = { db: null };
    return;
}

// Initialize Firebase Admin (prevents duplicate initialization errors)
if (!getApps().length) {
    try {
        const credentialsJson = process.env.FIREBASE_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT;
        if (credentialsJson) {
            const serviceAccount = JSON.parse(credentialsJson);
            app = initializeApp({
                credential: cert(serviceAccount)
            });
            db = getFirestore(app);
            console.log('🔥 Firebase Admin initialized from environment credentials.');
        } else {
            console.warn('⚠️ FIREBASE_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT is missing; activating robust JSON Fallback DB store.');
        }
    } catch (error) {
        console.error('❌ Firebase Admin initialization failed:', error.message);
    }
} else {
    app = getApps()[0];
    db = getFirestore(app);
}

if (!db) {
    const fallback = require('./services/jsonFallbackDb');
    db = fallback.db;
    console.log('📁 JSON Fallback DB store activated successfully. All multi-tenant & queue operations are active.');
}

module.exports = { db };
