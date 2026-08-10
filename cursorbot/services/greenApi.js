// services/greenApi.js
require('dotenv').config();

const GREEN_API_ID_INSTANCE = process.env.INSTANCE_ID || process.env.GREEN_API_INSTANCE_ID || process.env.GREEN_API_ID_INSTANCE;
const GREEN_API_API_TOKEN_INSTANCE = process.env.INSTANCE_TOKEN || process.env.GREEN_API_TOKEN || process.env.GREEN_API_API_TOKEN_INSTANCE;
const GREEN_API_HOST = process.env.GREEN_API_HOST || 'https://api.green-api.com';

/**
 * Sends a standard text message via Green API.
 */
async function sendMessage(chatId, message) {
    // Note: Using the dynamic GREEN_API_HOST rather than hardcoding 7107.api.greenapi.com
    const url = `${GREEN_API_HOST}/waInstance${GREEN_API_ID_INSTANCE}/sendMessage/${GREEN_API_API_TOKEN_INSTANCE}`;
    
    // Dynamically assign the arguments to the payload
    const payload = {
        chatId: chatId,
        message: message
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Green API Text Error: ${response.status} - ${response.statusText}`);
        }

        const data = await response.json();
        console.log("[GreenAPI] Raw Response:", data);
        return data;
    } catch (error) {
        console.error("[Green API] Error in sendMessage:", error.message);
        throw error;
    }
}

/**
 * Sends a media file via URL to a WhatsApp chat.
 * Expects a direct, raw image URL (handled by urlHelper).
 */
async function sendMediaByUrl(chatId, fileUrl, fileName, caption = "") {
    const url = `${GREEN_API_HOST}/waInstance${GREEN_API_ID_INSTANCE}/sendFileByUrl/${GREEN_API_API_TOKEN_INSTANCE}`;

    // --- Resilient fileName Generation ---
    let safeFileName = "sneaker-image.jpeg";

    if (fileName && typeof fileName === 'string') {
        safeFileName = fileName.replace(/[^a-zA-Z0-9-.]/g, '_');
        if (!safeFileName.match(/\.(jpg|jpeg|png)$/i)) {
            safeFileName = safeFileName.replace(/\.+$/, '') + '.jpeg';
        }
    }

    console.log(`[Green API] Sending media: ${fileUrl} as ${safeFileName}`);

    const payload = {
        chatId: chatId,
        urlFile: fileUrl,
        fileName: safeFileName,
        caption: caption
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Green API Media Error: ${response.status} - ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        console.error("[Green API] Error in sendMediaByUrl:", error.message);
        throw error;
    }
}

module.exports = {
    sendMediaByUrl,
    sendMessage
};
