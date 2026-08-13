'use strict';

const fetch = require('node-fetch');

const RENDER_URL = 'https://cursorbot-s9e5.onrender.com';
const CLINIC_ID = 'tenant_0283a9d331ba';
const INSTANCE_ID = '1101826071';

async function runLiveTest() {
    console.log('🌐 Starting Live End-to-End Render Integration Test...');

    // 1. Simulate incoming WhatsApp emergency message to Render webhook
    const webhookPayload = {
        typeWebhook: 'incomingMessageReceived',
        instanceData: {
            idInstance: Number(INSTANCE_ID),
            wid: INSTANCE_ID + '@c.us',
            typeWebhook: 'incomingMessageReceived'
        },
        senderData: {
            chatId: '918426862111@c.us',
            sender: '918426862111@c.us',
            senderName: 'Live Simulation User'
        },
        messageData: {
            typeMessage: 'textMessage',
            textMessageData: {
                textMessage: 'Mera 3 saal ka beta hai, usko achanak se bahot tez bukhar aa gaya hai aur saans lene mein thodi dikkat ho rahi hai.'
            }
        }
    };

    console.log(`\n📨 Sending emergency webhook payload to ${RENDER_URL}/webhook ...`);
    try {
        const whRes = await fetch(`${RENDER_URL}/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(webhookPayload)
        });
        const whText = await whRes.text();
        console.log(`📥 Webhook Response [Status ${whRes.status}]:`, whText);
    } catch (err) {
        console.error('❌ Webhook request failed:', err.message);
    }

    // 2. Query Dashboard API for Human Handoff
    console.log(`\n📊 Querying live dashboard handoff API: ${RENDER_URL}/api/clinic/${CLINIC_ID}/human-handoff ...`);
    try {
        const apiRes = await fetch(`${RENDER_URL}/api/clinic/${CLINIC_ID}/human-handoff`);
        const apiData = await apiRes.json();
        console.log(`📥 Dashboard API Response [Status ${apiRes.status}]:`, JSON.stringify(apiData, null, 2));

        if (Array.isArray(apiData) && apiData.length > 0) {
            console.log('\n✅ LIVE TEST SUCCESS: The live Render backend successfully processed the emergency triage and the dashboard API returned the pending patient in Human Handoff!');
        } else {
            console.log('\n⚠️ Live API returned empty handoff list. Checking if authentication is required or if storage sync needs a moment.');
        }
    } catch (err) {
        console.error('❌ Dashboard API request failed:', err.message);
    }
}

runLiveTest();
