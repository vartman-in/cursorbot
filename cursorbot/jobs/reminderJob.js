// jobs/reminderJob.js
'use strict';

const cron = require('node-cron');
const { sendReminders } = require('../services/appointmentService');
const { logger } = require('../errorHandler');

/**
 * Run reminder check every hour
 */
cron.schedule('0 * * * *', async () => {
    logger.info('[Cron] Running appointment reminder job...');
    try {
        await sendReminders();
        logger.info('[Cron] Reminder job completed successfully.');
    } catch (error) {
        logger.error('[Cron] Error in reminder job:', error);
    }
});

console.log('⏰ Reminder cron job initialized (hourly).');
