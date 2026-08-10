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

/**
 * Diagnostic: shows exactly which clinic (if any) a given Green API
 * instanceId currently resolves to — this is what the webhook itself
 * checks, so this tells you definitively whether a real WhatsApp number is
 * actually connected to a clinic doc, or silently falling back to using the
 * raw instanceId as a synthetic clinicId (which is what happens when no
 * clinic doc has `whatsapp.instanceId` set to match).
 */
async function resolveInstance(req, res) {
    try {
        const { instanceId } = req.params;
        if (!instanceId) return res.status(400).json({ error: 'instanceId is required.' });

        const snapshot = await db.collection('clinics')
            .where('whatsapp.instanceId', '==', String(instanceId))
            .limit(1)
            .get();

        if (snapshot.empty) {
            return res.json({
                success: true,
                linked: false,
                message: `No clinic doc has whatsapp.instanceId == "${instanceId}". ` +
                    `The bot is currently falling back to using "${instanceId}" itself as the clinicId ` +
                    `for any messages from this WhatsApp instance — which is almost certainly NOT ` +
                    `the clinic you're viewing on the dashboard.`,
                fallbackClinicId: String(instanceId),
            });
        }

        const doc = snapshot.docs[0];
        return res.json({
            success: true,
            linked: true,
            clinicId: doc.id,
            clinicName: doc.data().profile?.name || null,
        });
    } catch (error) {
        console.error('❌ resolveInstance Error:', error);
        return res.status(500).json({ error: 'Failed to resolve instance.' });
    }
}

/**
 * Links a Green API instanceId to a clinic doc (creating the doc if it
 * doesn't exist yet), and optionally sets its real department list in the
 * same call. This is the direct fix for "dashboard shows a clinic that has
 * no relationship to my real WhatsApp traffic."
 */
async function linkClinicInstance(req, res) {
    try {
        const { clinicId, instanceId, departments, clinicName, schedule } = req.body;
        if (!clinicId || !instanceId) {
            return res.status(400).json({ error: 'clinicId and instanceId are required.' });
        }

        const patch = {
            whatsapp: { instanceId: String(instanceId) },
        };
        if (Array.isArray(departments) && departments.length) {
            patch.departments = departments;
        }
        if (clinicName) {
            patch.profile = { name: clinicName };
        }
        if (schedule && typeof schedule === 'object') {
            // e.g. { openHour: 8, closeHour: 20, closedDays: [0] } — 0=Sunday..6=Saturday
            patch.schedule = schedule;
        }

        await db.collection('clinics').doc(clinicId).set(patch, { merge: true });

        console.log(`✅ Linked instance ${instanceId} to clinic ${clinicId}`);
        return res.json({
            success: true,
            message: `Clinic "${clinicId}" is now linked to WhatsApp instance "${instanceId}".`,
            clinicId,
        });
    } catch (error) {
        console.error('❌ linkClinicInstance Error:', error);
        return res.status(500).json({ error: 'Failed to link clinic instance.' });
    }
}

module.exports = { onboardNewClinic, resolveInstance, linkClinicInstance };
