// services/databaseService.js
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { logger } = require('../errorHandler');

// Initialize Firebase Admin SDK using modern modular imports
let db = null;
try {
    if (!getApps().length) {
        const saEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (saEnv) {
            const serviceAccount = JSON.parse(saEnv);
            initializeApp({
                credential: cert(serviceAccount)
            });
            db = getFirestore();
            console.log("🔥 Firebase Admin initialized successfully.");
        } else {
            console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT environment variable not found. Firestore features will be disabled.');
        }
    } else {
        db = getFirestore();
    }
} catch (error) {
    console.error('❌ Firebase initialization critical error:', error.message);
}

/**
 * Patient Collection Operations
 */
const patients = {
    async getById(chatId) {
        try {
            if (!db) return null;
            const doc = await db.collection('patients').doc(chatId).get();
            return doc.exists ? doc.data() : null;
        } catch (error) {
            console.error(`Error getting patient ${chatId}:`, error);
            return null;
        }
    },
    async createOrUpdate(chatId, data) {
        try {
            if (!db) return data;
            await db.collection('patients').doc(chatId).set({
                ...data,
                updatedAt: new Date()
            }, { merge: true });
            return this.getById(chatId);
        } catch (error) {
            console.error(`Error updating patient ${chatId}:`, error);
            throw error;
        }
    },
    async updateFlowState(chatId, state, bookingDetails = null) {
        try {
            if (!db) return;
            const updateData = { 
                currentFlowState: state,
                updatedAt: new Date()
            };
            if (bookingDetails) {
                updateData.bookingDetails = bookingDetails;
            }
            await db.collection('patients').doc(chatId).update(updateData);
        } catch (error) {
            console.error(`Error updating flow state for ${chatId}:`, error);
        }
    },
    async addMessageToHistory(chatId, message) {
        try {
            if (!db) return;
            await db.collection('patients').doc(chatId).update({
                conversationHistory: FieldValue.arrayUnion({
                    ...message,
                    timestamp: new Date()
                }),
                updatedAt: new Date()
            });
        } catch (error) {
            // If document doesn't exist, create it first
            if (error.code === 5 || error.message.includes('NOT_FOUND')) {
                await this.createOrUpdate(chatId, {
                    conversationHistory: [{ ...message, timestamp: new Date() }]
                });
            } else {
                console.error(`Error adding message to history for ${chatId}:`, error);
            }
        }
    }
};

/**
 * Appointment Collection Operations
 */
const appointments = {
    async create(appointmentData) {
        try {
            if (!db) return appointmentData;
            const docRef = await db.collection('appointments').add({
                ...appointmentData,
                status: 'booked',
                createdAt: new Date(),
                reminderSent: { '24h': false, '2h': false }
            });
            return { id: docRef.id, ...appointmentData };
        } catch (error) {
            console.error('Error creating appointment:', error);
            throw error;
        }
    },
    async getByPatient(patientId) {
        try {
            if (!db) return [];
            const snapshot = await db.collection('appointments')
                .where('patientId', '==', patientId)
                .orderBy('dateTime', 'desc')
                .get();
            return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        } catch (error) {
            console.error(`Error getting appointments for ${patientId}:`, error);
            return [];
        }
    },
    async updateStatus(appointmentId, status) {
        try {
            if (!db) return;
            await db.collection('appointments').doc(appointmentId).update({ 
                status,
                updatedAt: new Date()
            });
        } catch (error) {
            console.error(`Error updating appointment ${appointmentId}:`, error);
        }
    },
    async getUpcoming(timeWindowHours) {
        try {
            if (!db) return [];
            const now = new Date();
            const future = new Date(now.getTime() + timeWindowHours * 60 * 60 * 1000);
            const snapshot = await db.collection('appointments')
                .where('dateTime', '>=', now)
                .where('dateTime', '<=', future)
                .where('status', '==', 'booked')
                .get();
            return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        } catch (error) {
            console.error('Error getting upcoming appointments:', error);
            return [];
        }
    }
};

/**
 * Knowledge Base Operations
 */
const knowledgeBase = {
    async query(keywords) {
        try {
            if (!db || !keywords || keywords.length === 0) return [];
            const snapshot = await db.collection('clinicKnowledgeBase')
                .where('keywords', 'array-contains-any', keywords)
                .limit(5)
                .get();
            return snapshot.docs.map(doc => doc.data());
        } catch (error) {
            console.error('Error querying knowledge base:', error);
            return [];
        }
    },
    async getByQuestion(question) {
        try {
            if (!db) return null;
            const snapshot = await db.collection('clinicKnowledgeBase')
                .where('question', '==', question)
                .limit(1)
                .get();
            return snapshot.empty ? null : snapshot.docs[0].data();
        } catch (error) {
            console.error('Error getting FAQ by question:', error);
            return null;
        }
    }
};

/**
 * Tenant Collection Operations (Multi-Tenant SaaS Support)
 */
const tenants = {
    async getByInstanceId(instanceId) {
        try {
            if (!db || !instanceId) return null;
            const strId = String(instanceId);

            // 1. Check if the document ID matches directly (fastest lookup)
            const docRef = await db.collection('tenants').doc(strId).get();
            if (docRef.exists) {
                return docRef.data();
            }

            // 2. Fallback: Query by the 'instance_id' field if auto-ID was used
            const snapshot = await db.collection('tenants')
                .where('instance_id', '==', strId)
                .limit(1)
                .get();
            
            if (snapshot.empty) {
                logger.warn(`[Firestore] No tenant found for instance_id: ${strId}`);
                return null;
            }
            return snapshot.docs[0].data();
        } catch (error) {
            console.error(`Error getting tenant for instanceId ${instanceId}:`, error);
            return null;
        }
    }
};

module.exports = {
    db,
    patients,
    appointments,
    knowledgeBase,
    tenants
};
