'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { logger } = require('../errorHandler');

const TOKEN_TTL = process.env.STAFF_SESSION_TTL || '8h';
const ROLE_RANK = Object.freeze({ receptionist: 1, doctor: 2, manager: 3, admin: 4 });

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeClinicIds(value) {
    if (value === '*' || value === undefined || value === null) return ['*'];
    return Array.isArray(value)
        ? value.map((id) => String(id).trim()).filter(Boolean)
        : String(value).split(',').map((id) => id.trim()).filter(Boolean);
}

function parseConfiguredUsers() {
    const users = [];
    const raw = process.env.STAFF_USERS_JSON;

    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) throw new Error('STAFF_USERS_JSON must be an array.');
            for (const user of parsed) {
                if (!normalizeEmail(user.email) || (!user.password && !user.passwordHash)) continue;
                users.push({
                    id: user.id || normalizeEmail(user.email),
                    email: normalizeEmail(user.email),
                    name: user.name || user.email,
                    password: user.password || null,
                    passwordHash: user.passwordHash || null,
                    roles: Array.isArray(user.roles) && user.roles.length ? user.roles.map((role) => String(role).toLowerCase()) : ['receptionist'],
                    clinicIds: normalizeClinicIds(user.clinicIds),
                });
            }
        } catch (err) {
            logger.error(`[StaffAuth] STAFF_USERS_JSON could not be parsed: ${err.message}`);
        }
    }

    // A backwards-compatible bootstrap account lets the existing ADMIN_SECRET
    // protect the dashboard until dedicated staff accounts are configured.
    if (!users.length && process.env.ADMIN_SECRET && process.env.ADMIN_SECRET !== 'changeme') {
        users.push({
            id: 'bootstrap-admin',
            email: normalizeEmail(process.env.DASHBOARD_ADMIN_EMAIL || 'admin@clinic.local'),
            name: 'Clinic Administrator',
            password: process.env.DASHBOARD_ADMIN_PASSWORD || process.env.ADMIN_SECRET,
            passwordHash: null,
            roles: ['admin'],
            clinicIds: ['*'],
        });
    }

    return users;
}

function signingSecret() {
    const secret = process.env.JWT_SECRET || process.env.ADMIN_SECRET;
    if (!secret || secret === 'changeme') {
        throw new Error('Secure staff authentication is not configured. Set JWT_SECRET and STAFF_USERS_JSON (or a non-default ADMIN_SECRET).');
    }
    return secret;
}

async function verifyPassword(user, password) {
    if (!user || !password) return false;
    if (user.passwordHash) return bcrypt.compare(String(password), user.passwordHash);

    const expected = Buffer.from(String(user.password));
    const received = Buffer.from(String(password));
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

async function authenticateCredentials(email, password) {
    const user = parseConfiguredUsers().find((candidate) => candidate.email === normalizeEmail(email));
    if (!user || !(await verifyPassword(user, password))) return null;
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles,
        clinicIds: user.clinicIds,
    };
}

function issueStaffToken(user) {
    return jwt.sign(
        {
            sub: user.id,
            email: user.email,
            name: user.name,
            roles: user.roles,
            clinicIds: user.clinicIds,
            type: 'staff',
        },
        signingSecret(),
        { expiresIn: TOKEN_TTL, issuer: 'jarvis-clinic-receptionist', audience: 'dashboard' }
    );
}

function authenticateStaff(req, res, next) {
    try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
        if (!token) return res.status(401).json({ success: false, error: 'Staff authentication is required.' });

        const staff = jwt.verify(token, signingSecret(), {
            issuer: 'jarvis-clinic-receptionist',
            audience: 'dashboard',
        });
        if (staff.type !== 'staff') throw new Error('Invalid token type.');
        req.staff = staff;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Your staff session is invalid or has expired. Please sign in again.' });
    }
}

function canAccessClinic(staff, clinicId) {
    const allowed = normalizeClinicIds(staff?.clinicIds);
    return allowed.includes('*') || allowed.includes(String(clinicId));
}

function authorizeClinic(req, res, next) {
    if (!req.staff) return res.status(401).json({ success: false, error: 'Staff authentication is required.' });
    if (!canAccessClinic(req.staff, req.clinicId || req.params.clinicId)) {
        return res.status(403).json({ success: false, error: 'You are not authorized for this clinic.' });
    }
    next();
}

function authorizeClinicFromRequest(req, res, next) {
    const clinicId = req.clinicId || req.params?.clinicId || req.body?.clinicId || req.query?.clinicId;
    if (!clinicId) return res.status(400).json({ success: false, error: 'A clinicId is required.' });
    req.clinicId = String(clinicId).trim();
    return authorizeClinic(req, res, next);
}

function requireRole(...allowedRoles) {
    const normalized = allowedRoles.map((role) => String(role).toLowerCase());
    return (req, res, next) => {
        const roles = (req.staff?.roles || []).map((role) => String(role).toLowerCase());
        if (!roles.some((role) => normalized.includes(role))) {
            return res.status(403).json({ success: false, error: 'Your staff role is not permitted to perform this action.' });
        }
        next();
    };
}

function publicStaffProfile(staff) {
    return {
        id: staff.sub || staff.id,
        email: staff.email,
        name: staff.name,
        roles: staff.roles || [],
        clinicIds: normalizeClinicIds(staff.clinicIds),
    };
}

module.exports = {
    authenticateCredentials,
    issueStaffToken,
    authenticateStaff,
    authorizeClinic,
    authorizeClinicFromRequest,
    requireRole,
    canAccessClinic,
    publicStaffProfile,
};
