// clinicIntentRouter.js
'use strict';

/**
 * CLINIC SAFETY GUARDRAIL
 * Strictly detects medical emergencies. Ignores billing/administrative urgency.
 */
function isMedicalEmergency(text) {
    const lowerText = text.toLowerCase();
    
    // Financial/Admin keywords that should NEVER trigger a medical emergency
    const safeKeywords = ['payment', 'link', 'pay', 'upi', 'cash', 'bill', 'fee', 'advance'];
    if (safeKeywords.some(keyword => lowerText.includes(keyword))) {
        return false; 
    }

    // Actual medical emergency triggers
    const emergencyKeywords = ['heart attack', 'chest pain', 'bleeding', 'unconscious', 'emergency', 'accident', 'breath', 'breathing'];
    return emergencyKeywords.some(keyword => lowerText.includes(keyword));
}

/**
 * Basic intent classifier for the clinic bot
 */
function classifyClinicIntent(text) {
    const lowerText = text.toLowerCase();
    
    if (isMedicalEmergency(text)) return 'EMERGENCY';
    if (/(book|appointment|checkup|consultation|milna hai|dikhaana hai)/i.test(lowerText)) return 'BOOK_APPOINTMENT';
    if (/(pay|link|upi|cash|advance|paise)/i.test(lowerText)) return 'PAYMENT_QUERY';
    
    return 'GENERAL_INQUIRY';
}

module.exports = { classifyClinicIntent };
