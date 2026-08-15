// services/greenApi.js
require('dotenv').config();

const GREEN_API_ID_INSTANCE = process.env.INSTANCE_ID || process.env.GREEN_API_INSTANCE_ID || process.env.GREEN_API_ID_INSTANCE;
const GREEN_API_API_TOKEN_INSTANCE = process.env.INSTANCE_TOKEN || process.env.GREEN_API_TOKEN || process.env.GREEN_API_API_TOKEN_INSTANCE;

// Resilient host detection: Green API uses cluster-specific subdomains (e.g., 7103, 7107)
const clusterId = String(GREEN_API_ID_INSTANCE || '').substring(0, 4);
const GREEN_API_HOST = process.env.GREEN_API_HOST || (clusterId ? `https://${clusterId}.api.greenapi.com` : 'https://api.green-api.com');

/**
 * Sends a standard text message via Green API.
 */
async function sendMessage(chatId, message) {
    const url = `${GREEN_API_HOST}/waInstance${GREEN_API_ID_INSTANCE}/sendMessage/${GREEN_API_API_TOKEN_INSTANCE}`;
    
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
 */
async function sendMediaByUrl(chatId, fileUrl, fileName, caption = "") {
    const url = `${GREEN_API_HOST}/waInstance${GREEN_API_ID_INSTANCE}/sendFileByUrl/${GREEN_API_API_TOKEN_INSTANCE}`;

    let safeFileName = "sneaker-image.jpeg";
    if (fileName && typeof fileName === 'string') {
        safeFileName = fileName.replace(/[^a-zA-Z0-9-.]/g, '_');
        if (!safeFileName.match(/\.(jpg|jpeg|png)$/i)) {
            safeFileName = safeFileName.replace(/\.+$/, '') + '.jpeg';
        }
    }

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

/**
 * Gets instance settings from Green API.
 */
async function getSettings() {
    const url = `${GREEN_API_HOST}/waInstance${GREEN_API_ID_INSTANCE}/getSettings/${GREEN_API_API_TOKEN_INSTANCE}`;
    try {
        const response = await fetch(url);
        return await response.json();
    } catch (error) {
        console.error("[Green API] Error in getSettings:", error.message);
        return null;
    }
}

/**
 * Sets instance settings for Green API.
 */
async function setSettings(settings) {
    const url = `${GREEN_API_HOST}/waInstance${GREEN_API_ID_INSTANCE}/setSettings/${GREEN_API_API_TOKEN_INSTANCE}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        return await response.json();
    } catch (error) {
        console.error("[Green API] Error in setSettings:", error.message);
        return null;
    }
}

/**
 * Sends a poll via Green API.
 */
async function sendPoll(chatId, message, options, multipleAnswers = false) {
    const url = `${GREEN_API_HOST}/waInstance${GREEN_API_ID_INSTANCE}/sendPoll/${GREEN_API_API_TOKEN_INSTANCE}`;
    
    const payload = {
        chatId: chatId,
        message: message,
        options: options.map(opt => ({ optionName: opt })),
        multipleAnswers: multipleAnswers
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Green API Poll Error: ${response.status} - ${response.statusText}`);
        }

        const data = await response.json();
        console.log("[GreenAPI] Poll Response:", data);
        return data;
    } catch (error) {
        console.error("[Green API] Error in sendPoll:", error.message);
        throw error;
    }
}

/**
 * Sends modern interactive buttons via Green API (SendInteractiveButtonsReply).
 */
async function sendInteractiveButtonsReply(chatId, body, buttons, header = "", footer = "City Health Clinic") {
    const url = `${GREEN_API_HOST}/waInstance${GREEN_API_ID_INSTANCE}/sendInteractiveButtonsReply/${GREEN_API_API_TOKEN_INSTANCE}`;
    
    const payload = {
        chatId: chatId,
        header: header || "",
        body: body,
        footer: footer || "",
        buttons: buttons.map((btn, index) => ({
            buttonId: String(btn.id || index + 1),
            buttonText: btn.text
        }))
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Green API InteractiveButtonsReply Error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        console.log("[GreenAPI] InteractiveButtonsReply Response:", data);
        return data;
    } catch (error) {
        console.error("[Green API] Error in sendInteractiveButtonsReply:", error.message);
        throw error;
    }
}

/**
 * Sends interactive buttons via Green API.
 * Tries modern SendInteractiveButtonsReply first, then legacy sendButtons, then text fallback.
 */
async function sendButtons(chatId, message, buttons, footer = "City Health Clinic") {
    try {
        // 1. Try modern Interactive Buttons first
        console.log(`[Green API] Attempting sendInteractiveButtonsReply for ${chatId}`);
        return await sendInteractiveButtonsReply(chatId, message, buttons, "", footer);
    } catch (error) {
        console.warn(`[Green API] sendInteractiveButtonsReply failed, trying legacy sendButtons:`, error.message);
        
        try {
            // 2. Fallback to legacy sendButtons
            const url = `${GREEN_API_HOST}/waInstance${GREEN_API_ID_INSTANCE}/sendButtons/${GREEN_API_API_TOKEN_INSTANCE}`;
            const formattedButtons = buttons.map((btn, index) => ({
                buttonId: String(btn.id || index + 1),
                buttonText: btn.text
            }));

            const payload = {
                chatId: chatId,
                message: message,
                buttons: formattedButtons,
                footer: footer || ""
            };

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                console.warn(`[Green API] sendButtons failed (${response.status}), falling back to text message.`);
                return await sendMessage(chatId, `${message}\n\nOptions:\n` + buttons.map((b, i) => `${i+1}. ${b.text}`).join('\n'));
            }

            return await response.json();
        } catch (innerError) {
            console.error("[Green API] Final fallback to text message:", innerError.message);
            return await sendMessage(chatId, `${message}\n\nOptions:\n` + buttons.map((b, i) => `${i+1}. ${b.text}`).join('\n'));
        }
    }
}

/**
 * Sends a list message (dropdown/menu) via Green API.
 */
async function sendListMessage(chatId, message, title, buttonText, sections, footer = "City Health Clinic") {
    const url = `${GREEN_API_HOST}/waInstance${GREEN_API_ID_INSTANCE}/sendListMessage/${GREEN_API_API_TOKEN_INSTANCE}`;

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

module.exports = {
    sendMediaByUrl,
    sendMessage,
    sendPoll,
    getSettings,
    setSettings,
    sendInteractiveButtonsReply,
    sendButtons,
    sendListMessage
};
