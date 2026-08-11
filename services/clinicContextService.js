// services/clinicContextService.js
'use strict';

const { db } = require('../db');
const { logger } = require('../errorHandler');

/**
 * Normalize the tenant shapes that existed before the `clinics` collection was
 * standardized. The returned object always carries the authoritative Firestore
 * clinic document ID in `clinicId`.
 */
function normalizeClinicContext(id, data = {}) {
    return {
        ...data,
        clinicId: id,
        clinic_info: data.clinic_info || {
            name: data.profile?.name || data.name || id,
            address: data.profile?.address || data.address || '',
            timings: data.profile?.timings || data.timings || '',
        },
    };
}

async function findFirst(collection, field, value) {
    const snapshot = await db.collection(collection)
        .where(field, '==', value)
        .limit(1)
        .get();
    if (snapshot.empty) return null;
    return { id: snapshot.docs[0].id, data: snapshot.docs[0].data() };
}

/**
 * Resolve a Green API instance to one and only one clinic document.
 *
 * No raw instance ID is used as a queue ID. That fallback was the source of
 * dashboard drift: a bot booking could land in `queues/{instanceId}__...`
 * while the dashboard read `queues/clinic-city-health__...`.
 */
async function resolveClinicContext(instanceId) {
    if (!db || !instanceId) return null;
    const normalizedInstanceId = String(instanceId).trim();

    // Current production schema: clinics/{clinicId}.whatsapp.instanceId
    let hit = await findFirst('clinics', 'whatsapp.instanceId', normalizedInstanceId);
    if (hit) return normalizeClinicContext(hit.id, hit.data);

    // Compatibility for older onboarding/schema versions.
    hit = await findFirst('clinics', 'whatsapp.instance_id', normalizedInstanceId);
    if (hit) return normalizeClinicContext(hit.id, hit.data);

    hit = await findFirst('clinics', 'instance_id', normalizedInstanceId);
    if (hit) return normalizeClinicContext(hit.id, hit.data);

    hit = await findFirst('tenants', 'instance_id', normalizedInstanceId);
    if (hit) return normalizeClinicContext(hit.id, hit.data);

    // Optional explicit migration map. It is safe because it maps a known
    // Green API instance to a real clinic document; it never falls back to
    // treating the instance itself as a clinic ID.
    const mapRaw = process.env.INSTANCE_CLINIC_MAP_JSON;
    if (mapRaw) {
        try {
            const map = JSON.parse(mapRaw);
            const clinicId = map[normalizedInstanceId];
            if (clinicId) {
                const doc = await db.collection('clinics').doc(String(clinicId)).get();
                if (doc.exists) return normalizeClinicContext(doc.id, doc.data());
            }
        } catch (error) {
            logger.warn(`[ClinicContext] Ignoring malformed INSTANCE_CLINIC_MAP_JSON: ${error.message}`);
        }
    }

    logger.warn(`[ClinicContext] No clinic mapping configured for Green API instance ${normalizedInstanceId}.`);
    return null;
}

/**
 * Associate a known Green API instance with a clinic. This function is only
 * used by authenticated server-side/admin routes; it does not expose secrets.
 */
async function linkWhatsAppInstance(clinicId, instanceId) {
    if (!db) throw new Error('Database is not connected.');
    if (!clinicId || !instanceId) throw new Error('clinicId and instanceId are required.');

    const ref = db.collection('clinics').doc(String(clinicId));
    const doc = await ref.get();
    if (!doc.exists) throw new Error(`Clinic '${clinicId}' was not found.`);

    await ref.set({
        whatsapp: {
            ...(doc.data().whatsapp || {}),
            instanceId: String(instanceId).trim(),
        },
        updatedAt: new Date(),
    }, { merge: true });

    logger.info(`[ClinicContext] Linked Green API instance ${instanceId} to clinic ${clinicId}.`);
    return { clinicId: String(clinicId), instanceId: String(instanceId).trim() };
}

module.exports = {
    resolveClinicContext,
    linkWhatsAppInstance,
};
