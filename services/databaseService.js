'use strict';

const { FieldValue } = require('firebase-admin/firestore');
const { logger } = require('../errorHandler');
const { db } = require('../db');

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
            if (!db) {
                console.warn(`[DatabaseService] Firestore db is not connected; skipping createOrUpdate for ${chatId}`);
                return data;
            }
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
            await db.collection('patients').doc(chatId).set(updateData, { merge: true });
        } catch (error) {
            console.error(`Error updating flow state for ${chatId}:`, error);
        }
    },
    async addMessageToHistory(chatId, message) {
        try {
            if (!db) return;
            await db.collection('patients').doc(chatId).set({
                conversationHistory: FieldValue.arrayUnion({
                    ...message,
                    timestamp: new Date()
                }),
                updatedAt: new Date()
            }, { merge: true });
        } catch (error) {
            console.error(`Error adding message to history for ${chatId}:`, error);
        }
    }
};

module.exports = {
    patients,
    db
};
