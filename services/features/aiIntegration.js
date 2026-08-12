"use strict";

const Groq = require("groq-sdk");
const { logger } = require("../../errorHandler");
const { tenants } = require("../databaseService");
const { CLINIC_RECEPTIONIST_PROMPT, buildClinicContext } = require("./clinicPrompt");

const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
if (!apiKey) {
    console.warn("⚠️ WARNING: GROQ_API_KEY or OPENAI_API_KEY is missing. AI features will use a fallback key and may fail if called.");
}

const groq = new Groq({ apiKey: apiKey || "dummy_key_to_prevent_crash" });

const MODELS = {
    chat: "llama-3.3-70b-versatile",
    fast: "llama-3.1-8b-instant",
};

const DEFAULTS = {
    maxTokensChat: 1024,
    maxTokensFast: 256,
    temperature: 0.7,
    tempLow: 0.1,
};

/**
 * Generate a conversational response for the AI Receptionist.
 * Dynamically loads clinic context either from passed clinicData or from Firestore using tenantId (Instance ID).
 */
async function generateResponse(messages, tenantId = null, clinicDataOrOptions = {}, liveStatusText = null) {
    let clinicData = null;
    let options = {};

    // Intelligently handle whether the 3rd argument is clinicData or options object
    if (clinicDataOrOptions && (clinicDataOrOptions.profile || clinicDataOrOptions.doctors || clinicDataOrOptions.services || clinicDataOrOptions.clinicName)) {
        clinicData = clinicDataOrOptions;
    } else {
        options = clinicDataOrOptions || {};
    }

    const {
        model = MODELS.chat,
        maxTokens = DEFAULTS.maxTokensChat,
        temperature = DEFAULTS.temperature,
    } = options;

    let clinicContext = "No specific clinic context provided.";

    // 1. Use passed clinicData directly if available from the webhook
    if (clinicData) {
        try {
            clinicContext = buildClinicContext(clinicData);
        } catch (err) {
            logger.warn(`[Groq] Could not build clinic context from passed data: ${err.message}`);
        }
    } 
    // 2. Otherwise, fallback to fetching tenant data from Firestore
    else if (tenantId) {
        try {
            const tenantData = await tenants.getByInstanceId(tenantId);
            if (tenantData) {
                clinicContext = buildClinicContext(tenantData);
            } else {
                logger.warn(`[Groq] No tenant data found in Firestore for instance_id: ${tenantId}`);
            }
        } catch (err) {
            logger.warn(`[Groq] Could not load tenant data from Firestore: ${err.message}`);
        }
    }

    const systemPrompt = CLINIC_RECEPTIONIST_PROMPT.replace("{{context}}", clinicContext) +
        (liveStatusText ? `\n\n=== LIVE APPOINTMENT STATUS (authoritative — overrides any conflicting detail elsewhere in this conversation) ===\n${liveStatusText}` : '');

    // Sanitize all message content to ensure it is a string to prevent dropped history
    const sanitizedMessages = messages.map((m) => {
        if (typeof m.content === "string") return m;

        let coerced = "";
        if (m.content && typeof m.content === "object") {
            coerced = typeof m.content.reply === "string" ? m.content.reply :
                      typeof m.content.response === "string" ? m.content.response :
                      JSON.stringify(m.content);
        } else {
            coerced = String(m.content ?? "");
        }

        return { ...m, content: coerced };
    });

    try {
        logger.info(`[Groq] Calling generateResponse with model: ${model}`);
        const completion = await groq.chat.completions.create({
            model,
            max_tokens: maxTokens,
            temperature,
            messages: [
                { role: "system", content: systemPrompt },
                ...sanitizedMessages,
            ],
        });

        const text = completion.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error("Groq returned an empty response.");

        logger.info(`[Groq] generateResponse success. Model: ${model}`);
        return text;
    } catch (err) {
        logger.error(`[Groq] generateResponse failed: ${err.message}`);
        return "I'm sorry, I'm having trouble processing your request right now. Please try again later or call our clinic directly.";
    }
}

/**
 * Classify the intent of an incoming patient message.
 */
async function classifyIntent(message, history = []) {
    const historyBlock = history.length
        ? `Recent conversation:\n${history.map(m => {
            const contentStr = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            return `${m.role}: ${contentStr}`;
          }).join("\n")}\n\n`
        : "";

    const prompt = `
${historyBlock}
You are an intent classification engine for a medical clinic's virtual receptionist. 
Your ONLY job is to analyze the user's message and output a strict JSON object containing the correct intent.

Categories of Intent:

1. "check_availability": User is asking about clinic timings, if the clinic is open, or when the doctor sits.
2. "book_appointment": User is explicitly asking to book, schedule, or get a token.
3. "check_status": User is asking about their queue number, wait time, or active token.
4. "general_query": User is asking for address, fees, directions, or contact info.
5. "cancel_or_correct": User is frustrated, says they didn't mean to book, or wants to cancel.

Examples for mapping (pay close attention to Hinglish):

- "aaj doctor saab available hai?" -> "check_availability"
- "doctor kab beth te hai" -> "check_availability"
- "number laga do" -> "book_appointment"
- "mera token status kya hai" -> "check_status"
- "arey bhai mene booking karne ko bola hi nahi hai" -> "cancel_or_correct"

User message: "${message}"

Return ONLY valid JSON in this exact format, with no markdown formatting or extra text:
{
  "intent": "identified_intent_here"
}`;

    try {
        logger.info(`[Groq] Calling classifyIntent with model: ${MODELS.fast}`);
        const completion = await groq.chat.completions.create({
            model: MODELS.fast,
            max_tokens: 300,
            temperature: 0.0,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: prompt }],
        });

        const raw = completion.choices?.[0]?.message?.content?.trim() || "";
        const objMatch = raw.match(/\{.*\}/s);
        const result = JSON.parse(objMatch ? objMatch[0] : raw);
        logger.info(`[Groq] classifyIntent success. Intent: ${result.intent}`);
        return result;
    } catch (err) {
        logger.warn(`[Groq] classifyIntent fallback: ${err.message}`);
        return { intent: "unknown", confidence: 0, entities: {} };
    }
}

module.exports = {
    generateResponse,
    classifyIntent
};