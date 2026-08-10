// server.js
'use strict';

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path'); // <-- ADDED
const { logger } = require('./errorHandler');

// Import Controllers
const { onboardNewClinic } = require('./controllers/adminController');
const adminDashboardRoutes = require('./routes/adminDashboardRoutes'); // <-- ADDED

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Render/Cloud environments
app.set('trust proxy', 1);

// Middleware
// Disable strict CSP temporarily so Tailwind CDN and inline scripts work in our HTML
app.use(helmet({ contentSecurityPolicy: false })); 
app.use(morgan('combined'));
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

// Mount Webhooks
app.use('/webhook', webhookRoutes);
app.use('/api/webhooks/greenapi', webhookRoutes);

// Mount Dashboard APIs
app.use('/api', adminDashboardRoutes); // <-- ADDED

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'clinic-ai-receptionist',
        uptime: process.uptime()
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(`Unhandled Error: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Internal Server Error' });
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
