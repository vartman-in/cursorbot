// bookingFlow.js
'use strict';

const { getSessionState, updateSessionState } = require('./db'); // The Firebase helpers we made earlier
const { classifyClinicIntent } = require('./clinicIntentRouter');

async function handleIncomingMessage(waId, clinicData, userText) {
    // 1. Check current state in Firebase
    let session = await getSessionState(waId);
    if (!session) {
        session = { currentState: 'IDLE', contextData: {} };
    }

    // 2. Classify Intent
    const intent = classifyClinicIntent(userText);

    // 3. HARD OVERRIDE: Emergency Routing
    if (intent === 'EMERGENCY') {
        await updateSessionState(waId, 'IDLE', {}); // Reset state
        return "🚨 URGENT: I am alerting our medical staff right now. If this is a life-threatening emergency, please call an ambulance (108) immediately.";
    }

    // 4. THE STATE MACHINE
    switch (session.currentState) {
        
        case 'IDLE':
            if (intent === 'BOOK_APPOINTMENT') {
                await updateSessionState(waId, 'COLLECTING_DOCTOR', { service: 'Complete Health Checkup' });
                return `Great! I can help you book that. Which doctor would you like to consult? We have ${clinicData.doctors.map(d => d.name).join(' and ')}.`;
            }
            if (intent === 'PAYMENT_QUERY') {
                return "You can pay your advance via UPI. Should I send you the payment link?";
            }
            return `Welcome to ${clinicData.clinic_info.name}. How can I help you today? You can say "Book an appointment".`;

        case 'COLLECTING_DOCTOR':
            // In a full app, you'd use NLP to extract the exact doctor name here
            session.contextData.doctor = userText; 
            await updateSessionState(waId, 'COLLECTING_TIME', session.contextData);
            return `Got it. You want to see ${userText}. What time would you prefer tomorrow? (Morning, Afternoon, or Evening?)`;

        case 'COLLECTING_TIME':
            session.contextData.time = userText;
            await updateSessionState(waId, 'PENDING_PAYMENT', session.contextData);
            // FIXED THE BUG: We only confirm the booking details HERE, after collecting time.
            return `Perfect. I have tentatively held a slot for tomorrow ${userText} with ${session.contextData.doctor}. To confirm this booking, a ₹${clinicData.services[1].booking_advance} advance is required. Should I send the payment link?`;

        case 'PENDING_PAYMENT':
            if (intent === 'PAYMENT_QUERY' || userText.toLowerCase().includes('yes') || userText.toLowerCase().includes('bhej')) {
                // Here we will later trigger the Razorpay/Stripe API
                return `Here is your secure payment link: https://your-saas.com/pay/xyz123 \n\nOnce paid, your appointment will be officially confirmed!`;
            }
            return "Please complete the payment using the link provided to confirm your slot.";

        default:
            await updateSessionState(waId, 'IDLE', {});
            return "Let's start over. How can I help you today?";
    }
}

module.exports = { handleIncomingMessage };
