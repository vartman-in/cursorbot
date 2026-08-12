// server.js
'use strict';

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('./errorHandler');
const { db } = require('./db');
const { version } = require('./package.json');

// Import Controllers
const { onboardNewClinic, resolveInstance, linkClinicInstance } = require('./controllers/adminController');
const adminDashboardRoutes = require('./routes/adminDashboardRoutes'); // <-- ADDED

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Render/Cloud environments
app.set('trust proxy', 1);

// Middleware
// Add an opaque correlation ID before logging or routing so operational events
// and audit records can be traced without placing sensitive details in logs.
app.use((req, res, next) => {
    req.requestId = uuidv4();
    res.setHeader('X-Request-Id', req.requestId);
    next();
});
morgan.token('request-id', (req) => req.requestId || '-');
// Disable strict CSP temporarily so Tailwind CDN and inline scripts work in our HTML
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan(':remote-addr :method :url :status :res[content-length] - :response-time ms request_id=:request-id'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Static Files for Dashboards ──────────────────────────────────────────
// Serve HTML, CSS, JS from the 'public' folder
app.use(express.static(path.join(__dirname, 'public'))); // <-- ADDED

// ─── Security Middleware for Admin Routes ──────────────────────────────────
const verifyAdminToken = (req, res, next) => {
    const token = req.headers['x-admin-token'];
    // Ensure you add ADMIN_SECRET to your Render environment variables
    if (token && token === process.env.ADMIN_SECRET) {
        next();
    } else {
        logger.warn('Unauthorized attempt to access Admin API.');
        res.status(401).json({ error: 'Unauthorized access.' });
    }
};

// ─── Routes ────────────────────────────────────────────────────────────────
const webhookRoutes = require('./routes/webhook');

// Agency Admin Route for Onboarding New Clinics
app.post('/admin/onboard-clinic', verifyAdminToken, onboardNewClinic);

// Diagnose which clinic (if any) a real WhatsApp instanceId currently resolves to
app.get('/admin/resolve-instance/:instanceId', verifyAdminToken, resolveInstance);

// Link a WhatsApp instanceId (and optionally departments/name) to a clinic doc
app.post('/admin/link-clinic', verifyAdminToken, linkClinicInstance);

// Mount Webhooks
app.use('/webhook', webhookRoutes);
app.use('/api/webhooks/greenapi', webhookRoutes);

// Mount Dashboard APIs
app.use('/api', adminDashboardRoutes); // <-- ADDED

// Health check: safe for Render probes and operational monitoring. A request
// read verifies that Firestore is reachable, not merely that credentials exist.
app.get('/health', async (req, res) => {
    let firestore = { configured: Boolean(db), status: db ? 'checking' : 'unavailable' };
    if (db) {
        try {
            await db.collection('clinics').limit(1).get();
            firestore = { configured: true, status: 'connected' };
        } catch (error) {
            firestore = { configured: true, status: 'degraded' };
            logger.warn(`[Health] Firestore connectivity check failed: ${error.message}`);
        }
    }

    const healthy = firestore.status === 'connected';
    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'degraded',
        service: 'clinic-ai-receptionist',
        version,
        release: {
            gitCommit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown',
            gitBranch: process.env.RENDER_GIT_BRANCH || process.env.GIT_BRANCH || 'unknown',
        },
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        requestId: req.requestId,
        dependencies: { firestore },
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(`Unhandled Error [${req.requestId || 'unknown'}]: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Internal Server Error', requestId: req.requestId });
});

// Initialize Cron Jobs
require('./jobs/reminderJob');

// Start server
app.listen(PORT, () => {
    console.log(`🚀 AI Receptionist Server started on port ${PORT}`);
    console.log(`   Admin API:        POST /admin/onboard-clinic`);
    console.log(`   WhatsApp Webhook: POST /webhook`);
    console.log(`   Dashboard APIs:   /api/doctor & /api/patient`);
    console.log(`   Health Check:     GET  /health`);
});

module.exports = app;
