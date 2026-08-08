// db.js
'use strict';

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

let app;

// Initialize Firebase Admin (prevents duplicate initialization errors)
if (!getApps().length) {
    try {
        // Securely loads credentials from Render Environment Variables
        // Ensure you set FIREBASE_CREDENTIALS in your Render dashboard
        if (process.env.FIREBASE_CREDENTIALS) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
            app = initializeApp({
                credential: cert(serviceAccount)
            });
            console.log("🔥 Firebase Admin initialized via Environment Variable.");
        } else {
            console.warn("⚠️ FIREBASE_CREDENTIALS environment variable is missing!");
        }
    } catch (error) {
        console.error("🔥 Firebase Init Error: Could not parse credentials.", error.message);
    }
} else {
    app = getApps()[0];
}

const db = app ? getFirestore(app) : null;

module.exports = { db };
