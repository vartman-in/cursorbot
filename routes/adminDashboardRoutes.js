// routes/adminDashboardRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const { DoctorService } = require('../services/doctorService');
const { PatientService } = require('../services/patientService');
const queueService = require('../services/queueService');
const { db } = require('../db');
const { logger } = require('../errorHandler');

const validateClinicId = (req, res, next) => {
    const { clinicId } = req.params;
    if (!clinicId || typeof clinicId !== 'string' || clinicId.trim() === '') {
        return res.status(400).json({ success: false, error: 'Invalid or missing clinicId parameter.' });
    }
    req.clinicId = clinicId.trim();
    next();
};

/* ==========================================================
   TENANT LIST (`/clinics`)
   ========================================================== */

router.get('/clinics', async (_req, res) => {
    try {
        if (!db) return res.json({ success: true, clinics: [] });
        const snapshot = await db.collection('clinics').limit(50).get();
        const clinics = snapshot.docs.map((doc) => {
            const data = doc.data();
            return {
                id: doc.id,
                name: data.profile?.name || doc.id,
                specialty: data.profile?.specialty || data.services?.map((s) => s.name).join(', ') || '',
            };
        });
        res.json({ success: true, clinics });
    } catch (err) {
        console.error('Error listing clinics:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================
   RECEPTIONIST OS — LIVE QUEUE CONTROL (`/clinic/:clinicId`)
   ========================================================== */

router.get('/clinic/:clinicId/departments', validateClinicId, async (req, res) => {
    try {
        if (!db) return res.json({ success: true, departments: [] });
        const doc = await db.collection('clinics').doc(req.clinicId).get();
        const data = doc.exists ? doc.data() : {};

        let departments = Array.isArray(data.departments) && data.departments.length
            ? data.departments
            : [...new Set((data.doctors || []).map((d) => d.department || d.specialization).filter(Boolean))];

        if (!departments.length) departments = ['General Medicine'];

        res.json({ success: true, departments });
    } catch (err) {
        console.error(`Error fetching departments for ${req.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/clinic/:clinicId/queue', validateClinicId, async (req, res) => {
    try {
        const department = req.query.department || 'Dentistry';
        const date = req.query.date || queueService.todayISO();

        const queue = await queueService.getQueueState(req.clinicId, department, date);
        res.json({ success: true, queue });
    } catch (err) {
        console.error(`Error fetching queue for ${req.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/clinic/:clinicId/advance', validateClinicId, async (req, res) => {
    try {
        const { department = 'Dentistry', date } = req.body;
        const queue = await queueService.advanceQueue(req.clinicId, department, date);
        res.json({ success: true, message: 'Queue advanced.', queue });
    } catch (err) {
        console.error(`Error advancing queue for ${req.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/clinic/:clinicId/delay', validateClinicId, async (req, res) => {
    try {
        const { department = 'Dentistry', date, delayMinutes } = req.body;
        if (delayMinutes === undefined || delayMinutes === null) {
            return res.status(400).json({ success: false, error: 'delayMinutes is required.' });
        }
        const queue = await queueService.setDelay(req.clinicId, department, date, delayMinutes);
        res.json({ success: true, message: `Delay set to +${delayMinutes}m.`, queue });
    } catch (err) {
        console.error(`Error setting delay for ${req.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/clinic/:clinicId/prioritize', validateClinicId, async (req, res) => {
    try {
        const { department = 'Dentistry', date, tokenNumber } = req.body;
        if (!tokenNumber) {
            return res.status(400).json({ success: false, error: 'tokenNumber is required.' });
        }
        await queueService.prioritizeToken(req.clinicId, department, Number(tokenNumber), date);
        const queue = await queueService.getQueueState(req.clinicId, department, date);
        res.json({ success: true, message: `Token #${tokenNumber} prioritized.`, queue });
    } catch (err) {
        console.error(`Error prioritizing token for ${req.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/clinic/:clinicId/human-handoff', validateClinicId, async (req, res) => {
    try {
        const patients = await queueService.getHumanHandoffPatients(req.clinicId);
        res.json({ success: true, count: patients.length, patients });
    } catch (err) {
        console.error(`Error fetching human handoff for ${req.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/clinic/:clinicId/unmute', validateClinicId, async (req, res) => {
    try {
        const { patientId, phone } = req.body;
        if (!patientId && !phone) {
            return res.status(400).json({ success: false, error: 'Either patientId or phone is required to unmute.' });
        }
        const result = await queueService.unmutePatient(req.clinicId, patientId, phone);
        res.json(result);
    } catch (err) {
        console.error(`Error unmuting patient for ${req.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/clinic/:clinicId/seed', validateClinicId, async (req, res) => {
    try {
        const { department = 'Dentistry', date } = req.body;
        const queue = await queueService.seedClinicData(req.clinicId, department, date);
        res.json({ success: true, message: `Seeded sample data for ${req.clinicId}`, queue });
    } catch (err) {
        console.error(`Error seeding clinic ${req.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================
   DOCTOR PORTAL API ROUTES (`/doctor`)
   ========================================================== */

router.get('/doctor/:clinicId/dashboard', async (req, res) => {
    try {
        const clinicId = req.params.clinicId;
        const department = req.query.department || 'Dentistry';
        const date = req.query.date || queueService.todayISO();
        const doctorName = req.query.doctorName || 'Dr. Robert Chen';

        const dashboardData = await DoctorService.getDoctorDashboard(clinicId, doctorName, department, date);
        res.json({ success: true, ...dashboardData });
    } catch (err) {
        console.error(`Error fetching doctor dashboard for ${req.params.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/doctor/notes', async (req, res) => {
    try {
        const { clinicId, appointmentId, doctorNotes, prescriptions, feeAmount, paymentMode, paymentStatus, markCompleted } = req.body;
        if (!clinicId || !appointmentId) {
            return res.status(400).json({ error: 'clinicId and appointmentId are required.' });
        }

        const result = await DoctorService.saveClinicalNotes({
            clinicId, appointmentId, doctorNotes, prescriptions, feeAmount, paymentMode, paymentStatus, markCompleted
        });

        res.json({ success: true, ...result });
    } catch (err) {
        console.error('Error saving clinical notes:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/doctor/payment', async (req, res) => {
    try {
        const { clinicId, appointmentId, feeAmount, paymentMode, paymentStatus } = req.body;
        if (!clinicId || !appointmentId) {
            return res.status(400).json({ error: 'clinicId and appointmentId are required.' });
        }

        const result = await DoctorService.updatePayment({
            clinicId, appointmentId, feeAmount, paymentMode, paymentStatus
        });

        res.json(result);
    } catch (err) {
        console.error('Error updating payment:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================
   PATIENT PORTAL API ROUTES (`/patient`)
   ========================================================== */

router.get('/patient/status/:chatId', async (req, res) => {
    try {
        const { chatId } = req.params;
        const statusData = await PatientService.getPatientStatus(chatId);
        res.json({ success: true, ...statusData });
    } catch (err) {
        console.error(`Error fetching patient status for ${req.params.chatId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/patient/action', async (req, res) => {
    try {
        const { chatId, appointmentId, action, newDate, newSlot, reason } = req.body;
        if (!appointmentId && !chatId) {
            return res.status(400).json({ error: 'chatId (and appointmentId, if applicable) are required.' });
        }
        if (!action) {
            return res.status(400).json({ error: 'action is required.' });
        }

        const result = await PatientService.handlePatientAction({
            chatId, appointmentId, action, newDate, newSlot, reason
        });

        res.json(result);
    } catch (err) {
        console.error('Error performing patient self-service action:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
