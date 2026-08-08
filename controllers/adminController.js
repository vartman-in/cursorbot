// controllers/adminController.js
'use strict';

const { db } = require('../db'); // Your Firebase instance
const { v4: uuidv4 } = require('uuid');

/**
 * Provisions a new clinic tenant in the database.
 * This stores operational data, WhatsApp API keys, and Payment gateways.
 */
async function onboardNewClinic(req, res) {
    try {
        const { 
            clinicName, 
            address, 
            timings, 
            doctors, 
            services, 
            waPhoneNumberId, 
            waAccessToken,
            razorpayKeyId,
            razorpaySecret
        } = req.body;

        // Generate a unique Tenant ID
        const clinicId = `tenant_${uuidv4().replace(/-/g, '').slice(0, 12)}`;

        const newTenantConfig = {
            clinicId,
            isActive: true,
            onboardedAt: new Date().toISOString(),
            
            // 1. Operational Data
            profile: {
                name: clinicName,
                address: address,
                timings: timings
            },
            doctors: doctors, // Array of doctor objects
            services: services, // Array of service objects with prices
            
            // 2. API Linking (WhatsApp)
            whatsapp: {
                phoneNumberId: waPhoneNumberId,
                accessToken: waAccessToken
            },

            // 3. API Linking (Payments)
            payments: {
                provider: 'razorpay',
                keyId: razorpayKeyId,
                secret: razorpaySecret
            },
            
            // 4. Calendar Sync (Tokens will be injected here after OAuth)
            calendar: {
                provider: 'google_calendar',
                calendarId: null,
                tokens: null 
            }
        };

        // Write the new tenant configuration to Firebase
        await db.collection('clinics').doc(clinicId).set(newTenantConfig);

        console.log(`✅ Successfully provisioned workspace for: ${clinicName}`);
        
        return res.status(201).json({
            success: true,
            message: "Clinic successfully onboarded.",
            tenantId: clinicId
        });

    } catch (error) {
        console.error("❌ Onboarding Error:", error);
        return res.status(500).json({ error: "Failed to provision clinic workspace." });
    }
}

module.exports = { onboardNewClinic };
