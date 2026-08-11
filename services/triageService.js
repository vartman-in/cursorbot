'use strict';

/**
 * Safety screen only — it does not diagnose, assess severity clinically, or
 * replace emergency services. It selects the safest receptionist action.
 */
const EMERGENCY_PATTERNS = [
    /\b(chest pain|heart attack|severe chest pressure|seene mein tez dard|chhati mein (tez )?dard)\b/i,
    /\b(difficulty breathing|shortness of breath|cannot breathe|saans (nahi|nahin) aa rahi|saans lene mein (bahut )?dikkat)\b/i,
    /\b(severe bleeding|bleeding (won't|wont|not) stop|bahut (zyada )?khoon|khoon (nahi|nahin) ruk raha)\b/i,
    /\b(unconscious|passed out|fainted|behosh|h[oō]sh (nahi|nahin))\b/i,
    /\b(seizure|convulsion|fits aa rahe|daure)\b/i,
    /\b(stroke|face droop|slurred speech|bolne mein achanak dikkat|lakwa)\b/i,
    /\b(suicidal|kill myself|self harm|khud ko (maar|nuksan))\b/i,
    /\b(poisoning|zeher|overdose|severe burn|serious head injury)\b/i,
    /\b(infant|baby|newborn|bachcha|bachche).{0,40}\b(high fever|tez bukhar|fever 10[3-9]|fever 104)\b/i,
];

// Ordinary fever or body pain alone is intentionally not marked urgent. The
// receptionist must offer a qualified consultation rather than creating an
// unnecessary emergency/staff alert. This is a routing rule, not a diagnosis.
const URGENT_PATTERNS = [
    /\b(high fever|tez bukhar|fever\s*(?:10[3-9]|104))\b/i,
    /\b(sugar (check|level)|blood sugar|diabetes).{0,30}\b(urgent|fast|jaldi|high|low)\b/i,
    /\b(pregnan(t|cy)|pregnancy|garbhavati).{0,40}\b(pain|bleeding|dard|khoon)\b/i,
    /\b(eye injury|dog bite|snake bite|animal bite|deep cut)\b/i,
];

function triageMessage(text) {
    const message = String(text || '').trim();
    if (!message) return { level: 'routine', matched: null };

    const emergency = EMERGENCY_PATTERNS.find((pattern) => pattern.test(message));
    if (emergency) return { level: 'emergency', matched: emergency.source };

    const urgent = URGENT_PATTERNS.find((pattern) => pattern.test(message));
    if (urgent) return { level: 'urgent', matched: urgent.source };

    return { level: 'routine', matched: null };
}

function isEmergency(text) {
    return triageMessage(text).level === 'emergency';
}

function getEmergencyReply() {
    return '🚨 Namastey sir, aapke message mein emergency ke signs ho sakte hain. Main diagnosis nahi kar sakta. Kripya turant nearest emergency department ya local emergency services se sampark karein. Clinic staff ko bhi alert kiya ja raha hai.';
}

function getUrgentReply({ canIssueLiveToken, nextOpening } = {}) {
    const bookingGuidance = canIssueLiveToken
        ? 'Clinic abhi open hai. Main aapke liye earliest available consultation arrange karne mein madad kar sakta hu.'
        : `Clinic abhi closed hai. Main aapke liye future appointment arrange kar sakta hu${nextOpening ? `; next opening ${nextOpening}` : ''}.`;
    return `Namastey sir, aapke symptoms ko qualified clinical review ki zarurat ho sakti hai. Main diagnosis nahi kar sakta. ${bookingGuidance} Agar symptoms severe hon ya emergency signs hon, kripya turant nearest emergency department se sampark karein.`;
}

function getTriageGuidance() {
    return 'Namastey sir, main diagnosis nahi kar sakta aur medicine recommend nahi kar sakta. Aap professional consultation ke liye appointment book kar sakte hain. Symptoms worsen hon ya emergency signs hon to nearest emergency department se sampark karein.';
}

module.exports = {
    triageMessage,
    isEmergency,
    getEmergencyReply,
    getUrgentReply,
    getTriageGuidance,
};
