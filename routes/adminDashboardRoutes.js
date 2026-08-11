// routes/adminDashboardRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const { DoctorService } = require('../services/doctorService');
const { PatientService } = require('../services/patientService');
const queueService = require('../services/queueService');
const { db } = require('../db');
const { logger } = require('../errorHandler');
const { logStaffAction } = require('../services/auditService');
const {
    authenticateCredentials,
    issueStaffToken,
    authenticateStaff,
    authorizeClinic,
    authorizeClinicFromRequest,
    requireRole,
    canAccessClinic,
    publicStaffProfile,
} = require('../services/staffAuthService');

const validateClinicId = (req, res, next) => {
    const { clinicId } = req.params;
    if (!clinicId || typeof clinicId !== 'string' || clinicId.trim() === '') {
        return res.status(400).json({ success: false, error: 'Invalid or missing clinicId parameter.' });
    }
    req.clinicId = clinicId.trim();
    next();
};

/* ==========================================================
   STAFF AUTHENTICATION (`/auth`)
   ========================================================== */

router.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        const staff = await authenticateCredentials(email, password);
        if (!staff) return res.status(401).json({ success: false, error: 'Invalid email or password.' });
        return res.json({
            success: true,
            token: issueStaffToken(staff),
            staff: publicStaffProfile(staff),
        });
    } catch (err) {
        logger.error(`[DashboardAuth] Login failed: ${err.message}`);
        return res.status(503).json({ success: false, error: 'Staff sign-in is not configured. Contact the clinic administrator.' });
    }
});

router.get('/auth/me', authenticateStaff, (req, res) => {
    res.json({ success: true, staff: publicStaffProfile(req.staff) });
});

/* ==========================================================
   TENANT LIST (`/clinics`)
   ========================================================== */

router.get('/clinics', authenticateStaff, async (req, res) => {
    try {
        if (!db) return res.json({ success: true, clinics: [] });
        const snapshot = await db.collection('clinics').limit(50).get();
        const clinics = snapshot.docs
            .filter((doc) => canAccessClinic(req.staff, doc.id))
            .map((doc) => {
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

router.use('/clinic/:clinicId', validateClinicId, authenticateStaff, authorizeClinic);

router.get('/clinic/:clinicId/departments', async (req, res) => {
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

router.get('/clinic/:clinicId/queue', async (req, res) => {
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

router.post('/clinic/:clinicId/advance', requireRole('receptionist', 'manager', 'admin'), async (req, res) => {
    try {
        const { department = 'Dentistry', date } = req.body;
        const queue = await queueService.advanceQueue(req.clinicId, department, date);
        await logStaffAction({ clinicId: req.clinicId, actor: req.staff, action: 'queue.advance', target: { department, date: date || queueService.todayISO() }, requestId: req.requestId });
        res.json({ success: true, message: 'Queue advanced.', queue });
    } catch (err) {
        console.error(`Error advancing queue for ${req.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/clinic/:clinicId/delay', requireRole('receptionist', 'manager', 'admin'), async (req, res) => {
    try {
        const { department = 'Dentistry', date, delayMinutes } = req.body;
        if (delayMinutes === undefined || delayMinutes === null) {
            return res.status(400).json({ success: false, error: 'delayMinutes is required.' });
        }
        const queue = await queueService.setDelay(req.clinicId, department, date, delayMinutes);
        await logStaffAction({ clinicId: req.clinicId, actor: req.staff, action: 'queue.delay.set', target: { department, date: date || queueService.todayISO() }, metadata: { delayMinutes: Number(delayMinutes) }, requestId: req.requestId });
        res.json({ success: true, message: `Delay set to +${delayMinutes}m.`, queue });
    } catch (err) {
        console.error(`Error setting delay for ${req.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/clinic/:clinicId/prioritize', requireRole('doctor', 'manager', 'admin'), async (req, res) => {
    try {
        const { department = 'Dentistry', date, tokenNumber } = req.body;
        if (!tokenNumber) {
            return res.status(400).json({ success: false, error: 'tokenNumber is required.' });
        }
        await queueService.prioritizeToken(req.clinicId, department, Number(tokenNumber), date);
        const queue = await queueService.getQueueState(req.clinicId, department, date);
        await logStaffAction({ clinicId: req.clinicId, actor: req.staff, action: 'queue.token.prioritized', target: { department, date: date || queueService.todayISO(), tokenNumber: Number(tokenNumber) }, requestId: req.requestId });
        res.json({ success: true, message: `Token #${tokenNumber} prioritized.`, queue });
    } catch (err) {
        console.error(`Error prioritizing token for ${req.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/clinic/:clinicId/human-handoff', requireRole('receptionist', 'doctor', 'manager', 'admin'), async (req, res) => {
    try {
        const patients = await queueService.getHumanHandoffPatients(req.clinicId);
        res.json({ success: true, count: patients.length, patients });
    } catch (err) {
        console.error(`Error fetching human handoff for ${req.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/clinic/:clinicId/unmute', requireRole('receptionist', 'manager', 'admin'), async (req, res) => {
    try {
        const { patientId, phone } = req.body;
        if (!patientId && !phone) {
            return res.status(400).json({ success: false, error: 'Either patientId or phone is required to unmute.' });
        }
        const result = await queueService.unmutePatient(req.clinicId, patientId, phone);
        await logStaffAction({ clinicId: req.clinicId, actor: req.staff, action: 'patient.bot_unmuted', target: { patientId: result.chatId }, requestId: req.requestId });
        res.json(result);
    } catch (err) {
        console.error(`Error unmuting patient for ${req.clinicId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/clinic/:clinicId/seed', requireRole('admin'), async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ success: false, error: 'Demo queue seeding is disabled in production.' });
    }
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

router.get('/doctor/:clinicId/dashboard', authenticateStaff, authorizeClinicFromRequest, requireRole('doctor', 'manager', 'admin'), async (req, res) => {
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

router.post('/doctor/notes', authenticateStaff, authorizeClinicFromRequest, requireRole('doctor', 'manager', 'admin'), async (req, res) => {
    try {
        const { clinicId, appointmentId, doctorNotes, prescriptions, feeAmount, paymentMode, paymentStatus, markCompleted } = req.body;
        if (!clinicId || !appointmentId) {
            return res.status(400).json({ error: 'clinicId and appointmentId are required.' });
        }

        const result = await DoctorService.saveClinicalNotes({
            clinicId, appointmentId, doctorNotes, prescriptions, feeAmount, paymentMode, paymentStatus, markCompleted
        });
        await logStaffAction({ clinicId, actor: req.staff, action: 'clinical_record.updated', target: { appointmentId }, metadata: { markCompleted: Boolean(markCompleted), paymentStatus: paymentStatus || null }, requestId: req.requestId });

        res.json({ success: true, ...result });
    } catch (err) {
        console.error('Error saving clinical notes:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/doctor/payment', authenticateStaff, authorizeClinicFromRequest, requireRole('receptionist', 'doctor', 'manager', 'admin'), async (req, res) => {
    try {
        const { clinicId, appointmentId, feeAmount, paymentMode, paymentStatus } = req.body;
        if (!clinicId || !appointmentId) {
            return res.status(400).json({ error: 'clinicId and appointmentId are required.' });
        }

        const result = await DoctorService.updatePayment({
            clinicId, appointmentId, feeAmount, paymentMode, paymentStatus
        });
        await logStaffAction({ clinicId, actor: req.staff, action: 'payment.updated', target: { appointmentId }, metadata: { paymentStatus: paymentStatus || null, paymentMode: paymentMode || null, feeAmount: Number(feeAmount) || 0 }, requestId: req.requestId });

        res.json(result);
    } catch (err) {
        console.error('Error updating payment:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================
   PATIENT PORTAL API ROUTES (`/patient`)
   ========================================================== */

router.get('/patient/status/:chatId', authenticateStaff, async (req, res) => {
    try {
        const { chatId } = req.params;
        if (!db) return res.status(503).json({ success: false, error: 'Patient database is unavailable.' });
        const patientDoc = await db.collection('patients').doc(chatId).get();
        const clinicId = patientDoc.exists ? patientDoc.data().clinicId : null;
        if (!clinicId || !canAccessClinic(req.staff, clinicId)) {
            return res.status(403).json({ success: false, error: 'You are not authorized to access this patient.' });
        }
        const statusData = await PatientService.getPatientStatus(chatId);
        res.json({ success: true, ...statusData });
    } catch (err) {
        console.error(`Error fetching patient status for ${req.params.chatId}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/patient/action', authenticateStaff, async (req, res) => {
    try {
        const { chatId, appointmentId, action, newDate, newSlot, reason } = req.body;
        if (!chatId) {
            return res.status(400).json({ error: 'chatId is required for a staff-initiated patient action.' });
        }
        if (!action) {
            return res.status(400).json({ error: 'action is required.' });
        }
        if (!db) return res.status(503).json({ success: false, error: 'Patient database is unavailable.' });
        const patientDoc = await db.collection('patients').doc(chatId).get();
        const clinicId = patientDoc.exists ? patientDoc.data().clinicId : null;
        if (!clinicId || !canAccessClinic(req.staff, clinicId)) {
            return res.status(403).json({ success: false, error: 'You are not authorized to modify this patient.' });
        }

        const result = await PatientService.handlePatientAction({
            chatId, appointmentId, action, newDate, newSlot, reason
        });
        await logStaffAction({ clinicId, actor: req.staff, action: `patient.${action}`, target: { patientId: chatId, appointmentId: appointmentId || null }, requestId: req.requestId });
        res.json(result);
    } catch (err) {
        console.error('Error performing patient action:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
