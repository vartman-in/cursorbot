// scripts/initKnowledgeBase.js
const { knowledgeBase, db } = require('../services/databaseService');

const initialFAQs = [
    {
        question: "Where are you located?",
        answer: "We are located at 123 Health Avenue, Medical District, Cityville. You can find us on Google Maps here: https://maps.google.com/?q=123+Health+Avenue",
        keywords: ["location", "address", "where", "maps", "directions"]
    },
    {
        question: "What are your opening hours?",
        answer: "Our clinic is open Monday to Friday from 8:00 AM to 8:00 PM, and Saturday from 9:00 AM to 2:00 PM. We are closed on Sundays.",
        keywords: ["hours", "opening", "timing", "open", "closed", "schedule"]
    },
    {
        question: "What is your cancellation policy?",
        answer: "We request at least 24 hours' notice for cancellations. Cancellations made less than 24 hours before the appointment may be subject to a small fee.",
        keywords: ["cancellation", "cancel", "policy", "fee", "reschedule"]
    },
    {
        question: "Do you accept insurance?",
        answer: "Yes, we accept most major insurance providers including HealthShield, MedSure, and GlobalCare. Please bring your insurance card during your visit.",
        keywords: ["insurance", "payment", "providers", "coverage", "accepted"]
    },
    {
        question: "What departments do you have?",
        answer: "We have General Medicine, Pediatrics, Cardiology, Orthopedics, and Dental departments.",
        keywords: ["departments", "services", "specialties", "doctors", "pediatrics", "cardiology"]
    }
];

async function init() {
    console.log("Initializing Clinic Knowledge Base...");
    const batch = db.batch();
    
    for (const faq of initialFAQs) {
        const docRef = db.collection('clinicKnowledgeBase').doc();
        batch.set(docRef, faq);
    }
    
    try {
        await batch.commit();
        console.log("Knowledge Base initialized successfully!");
    } catch (error) {
        console.error("Error initializing Knowledge Base:", error);
    }
    process.exit();
}

init();
