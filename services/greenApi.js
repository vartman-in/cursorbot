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

/**
 * Sends interactive buttons via Green API.
 */
async function sendButtons(chatId, message, buttons, footer = "City Health Clinic") {
    const url = `${GREEN_API_HOST}/waInstance${GREEN_API_ID_INSTANCE}/sendButtons/${GREEN_API_API_TOKEN_INSTANCE}`;
    
    // Format buttons for Green API spec
    const formattedButtons = buttons.map((btn, index) => ({
        buttonId: btn.id || String(index + 1),
        buttonText: {
            displayText: btn.text
        },
        type: 1 // Quick Reply button
    }));

    const payload = {
        chatId: chatId,
        message: message,
        buttons: formattedButtons,
        footer: footer || ""
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.warn(`[Green API] sendButtons failed (${response.status}), falling back to text message.`);
            return await sendMessage(chatId, `${message}\n\nOptions:\n` + buttons.map((b, i) => `${i+1}. ${b.text}`).join('\n'));
        }

        const data = await response.json();
        console.log("[GreenAPI] Buttons Response:", data);
        return data;
    } catch (error) {
        console.error("[Green API] Error in sendButtons:", error.message);
        // Fallback to text message
        return await sendMessage(chatId, `${message}\n\nOptions:\n` + buttons.map((b, i) => `${i+1}. ${b.text}`).join('\n'));
    }
}

/**
 * Sends a list message (dropdown/menu) via Green API.
 */
async function sendListMessage(chatId, message, title, buttonText, sections, footer = "City Health Clinic") {
    const url = `${GREEN_API_HOST}/waInstance${GREEN_API_ID_INSTANCE}/sendListMessage/${GREEN_API_API_TOKEN_INSTANCE}`;

    // Ensure sections and rows follow Green API's expected structure
    const formattedSections = (sections || []).map(section => ({
        title: section.title || "Options",
        rows: (section.rows || []).map(row => ({
            rowId: String(row.rowId || row.id),
            title: row.title,
            description: row.description || ""
        }))
    }));

    const payload = {
        chatId: chatId,
        message: message,
        title: title || "Select an option",
        buttonText: buttonText || "Select",
        sections: formattedSections,
        footer: footer || ""
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.warn(`[Green API] sendListMessage failed (${response.status}), falling back to text message.`);
            let fallbackText = `${message}\n\n${title}:\n`;
            sections.forEach(sec => {
                fallbackText += `*${sec.title}*\n`;
                sec.rows.forEach(r => {
                    fallbackText += `- ${r.title}${r.description ? ` (${r.description})` : ''}\n`;
                });
            });
            return await sendMessage(chatId, fallbackText);
        }

        const data = await response.json();
        console.log("[GreenAPI] ListMessage Response:", data);
        return data;
    } catch (error) {
        console.error("[Green API] Error in sendListMessage:", error.message);
        return await sendMessage(chatId, message);
    }
}

// Export new methods
module.exports.sendButtons = sendButtons;
module.exports.sendListMessage = sendListMessage;
