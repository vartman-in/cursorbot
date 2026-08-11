// db.js
'use strict';

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

let app;

// Initialize Firebase Admin (prevents duplicate initialization errors)
if (!getApps().length) {
    try {
        // Accept both documented Render variable names while migrating older
        // deployments. The value must always be the JSON service-account object.
        const credentialsJson = process.env.FIREBASE_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT;
        if (credentialsJson) {
            const serviceAccount = JSON.parse(credentialsJson);
            app = initializeApp({
                credential: cert(serviceAccount)
            });
            console.log('Firebase Admin initialized from environment credentials.');
        } else {
            console.warn('FIREBASE_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT is missing; Firestore is unavailable.');
        }
    } catch (error) {
        console.error('Firebase Admin initialization failed:', error.message);
    }
} else {
    app = getApps()[0];
}

const db = app ? getFirestore(app) : null;

module.exports = { db };
