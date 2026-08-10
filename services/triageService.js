// services/triageService.js
'use strict';

const { logger } = require('../errorHandler');

/**
 * Triage Service
 * Analyzes patient messages for high-risk keywords and provides guidance.
 */

const EMERGENCY_KEYWORDS = [
    'chest pain', 'heart attack', 'difficulty breathing', 'shortness of breath',
    'severe bleeding', 'unconscious', 'seizure', 'stroke', 'poisoning',
    'head injury', 'severe burn', 'suicidal', 'emergency'
];

/**
 * Check if a message indicates a medical emergency.
 */
function isEmergency(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return EMERGENCY_KEYWORDS.some(keyword => lowerText.includes(keyword));
}

/**
 * Get guidance for common non-emergency symptoms.
 * (This would ideally be integrated with an LLM or a medical knowledge base)
 */
function getTriageGuidance(symptoms) {
    // This is a placeholder for more complex logic
    return "I've noted your symptoms. While I can't provide a diagnosis, I recommend scheduling an appointment with our General Medicine department for a proper evaluation. If your symptoms worsen, please seek immediate medical attention.";
}

module.exports = {
    isEmergency,
    getTriageGuidance
};
