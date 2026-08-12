'use strict';

const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '../database/local_store.json');

function loadStore() {
    try {
        if (fs.existsSync(STORE_FILE)) {
            return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[JsonFallback] Error loading store:', e);
    }
    return {
        clinics: {
            "tenant_0283a9d331ba": {
                profile: {
                    name: "City Health Clinic",
                    address: "15 Hospital Road, Udaipur, Rajasthan 313001",
                    timings: "Mon-Sat: 09:00 AM - 08:00 PM, Sunday: Closed",
                    phone: "9876543210"
                },
                whatsapp: {
                    instanceId: "1101826071"
                },
                doctors: [
                    { name: "Dr. Ramesh Gupta", specialization: "General Physician" },
                    { name: "Dr. Sneha Patel", specialization: "Pediatrician" }
                ],
                services: [
                    { name: "Standard Consultation", duration_minutes: 15, total_price: 500, booking_advance: 200 },
                    { name: "Complete Health Checkup", duration_minutes: 45, total_price: 1500, booking_advance: 500 }
                ]
            }
        },
        patients: {},
        queues: {},
        audits: {}
    };
}

function saveStore(store) {
    try {
        const dir = path.dirname(STORE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch (e) {
        console.error('[JsonFallback] Error saving store:', e);
    }
}

class MockDocRef {
    constructor(collectionName, docId) {
        this.collectionName = collectionName;
        this.docId = docId;
    }

    async get() {
        const store = loadStore();
        const data = store[this.collectionName]?.[this.docId];
        return {
            exists: !!data,
            id: this.docId,
            data: () => data || null
        };
    }

    async set(data, options = {}) {
        const store = loadStore();
        if (!store[this.collectionName]) store[this.collectionName] = {};
        
        if (options.merge && store[this.collectionName][this.docId]) {
            store[this.collectionName][this.docId] = {
                ...store[this.collectionName][this.docId],
                ...data
            };
        } else {
            store[this.collectionName][this.docId] = data;
        }
        saveStore(store);
        return true;
    }

    async update(data) {
        return this.set(data, { merge: true });
    }
}

class MockQuery {
    constructor(collectionName, items) {
        this.collectionName = collectionName;
        this.items = items;
    }

    where(field, op, value) {
        const filtered = this.items.filter(item => {
            const val = field.split('.').reduce((obj, key) => obj?.[key], item.data);
            if (op === '==') return val === value;
            return true;
        });
        return new MockQuery(this.collectionName, filtered);
    }

    limit(n) {
        return new MockQuery(this.collectionName, this.items.slice(0, n));
    }

    async get() {
        return {
            empty: this.items.length === 0,
            docs: this.items.map(item => ({
                id: item.id,
                exists: true,
                data: () => item.data
            }))
        };
    }
}

class MockCollectionRef {
    constructor(collectionName) {
        this.collectionName = collectionName;
    }

    doc(docId) {
        return new MockDocRef(this.collectionName, docId || 'auto_' + Date.now());
    }

    async add(data) {
        const store = loadStore();
        if (!store[this.collectionName]) store[this.collectionName] = {};
        const id = 'auto_' + Math.random().toString(36).substr(2, 9);
        store[this.collectionName][id] = { ...data, createdAt: new Date() };
        saveStore(store);
        return { id };
    }

    where(field, op, value) {
        const store = loadStore();
        const col = store[this.collectionName] || {};
        const items = Object.entries(col).map(([id, data]) => ({ id, data }));
        const q = new MockQuery(this.collectionName, items);
        return q.where(field, op, value);
    }

    async get() {
        const store = loadStore();
        const col = store[this.collectionName] || {};
        const items = Object.entries(col).map(([id, data]) => ({ id, data }));
        return {
            empty: items.length === 0,
            docs: items.map(item => ({
                id: item.id,
                exists: true,
                data: () => item.data
            }))
        };
    }
}

class MockFirestore {
    collection(name) {
        return new MockCollectionRef(name);
    }

    async runTransaction(updateFunction) {
        const transaction = {
            get: async (docRef) => docRef.get(),
            set: async (docRef, data, opts) => docRef.set(data, opts),
            update: async (docRef, data) => docRef.update(data)
        };
        return await updateFunction(transaction);
    }
}

const FieldValue = {
    arrayUnion(val) {
        return { __arrayUnion: val };
    },
    serverTimestamp() {
        return new Date();
    }
};

module.exports = {
    db: new MockFirestore(),
    FieldValue,
    isFallback: true
};
