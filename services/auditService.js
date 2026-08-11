'use strict';

const { db } = require('../db');
const { logger } = require('../errorHandler');

/**
 * Appends an audit record for an administrative mutation. Never include
 * patient messages, clinical notes, prescriptions, passwords, or API keys.
 */
async function logStaffAction({ clinicId, actor, action, target = {}, metadata = {}, requestId = null }) {
    const event = {
        clinicId,
        action,
        actor: {
            id: actor?.id || actor?.sub || actor?.email || 'unknown',
            email: actor?.email || null,
            role: actor?.role || actor?.roles?.[0] || null,
        },
        target,
        metadata,
        requestId,
        createdAt: new Date(),
    };

    if (!db) {
        logger.info(`[Audit] ${clinicId} ${action} by ${event.actor.id}`);
        return event;
    }

    await db.collection('auditLogs').add(event);
    return event;
}

module.exports = { logStaffAction };
