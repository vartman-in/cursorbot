// services/features/aiIntegration.js
"use strict";

const { OpenAI } = require("openai");
const logger = require("../../utils/logger");

// Prioritize GROQ_API_KEY if we are hitting a Groq endpoint
const IS_GROQ_BASE = (process.env.OPENAI_API_BASE || "").includes("groq.com") || !process.env.OPENAI_API_BASE;
const OPENAI_API_KEY = (IS_GROQ_BASE && process.env.GROQ_API_KEY) 
    ? process.env.GROQ_API_KEY 
    : (process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY || "dummy-key-for-proxy");

const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.groq.com/openai/v1";

if (IS_GROQ_BASE) {
    logger.info(`[AI] Initializing with Groq-priority logic. Using key starting with: ${OPENAI_API_KEY.substring(0, 7)}...`);
}

const groq = new OpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: OPENAI_API_BASE,
});

const MODELS = {
    fast: "llama-3.1-8b-instant",
    smart: "llama-3.3-70b-versatile"
};

/**
 * Generate a conversational response using Groq LLM with system prompt.
 */
async function generateResponse(history, instanceId, clinicData, extraContext = "") {
    try {
        const { CLINIC_RECEPTIONIST_PROMPT, buildClinicContext } = require("./clinicPrompt");
        const clinicContextStr = buildClinicContext(clinicData);

        let systemPrompt = CLINIC_RECEPTIONIST_PROMPT.replace("{{context}}", clinicContextStr);
        if (extraContext) {
            systemPrompt += `\n\nAdditional Real-time Context:\n${extraContext}`;
        }

        const formattedMessages = [
            { role: "system", content: systemPrompt },
            ...history.map(m => ({
                role: m.role === "assistant" ? "assistant" : "user",
                content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
            }))
        ];

        logger.info(`[Groq] Calling generateResponse with model: ${MODELS.smart}`);
        const completion = await groq.chat.completions.create({
            model: MODELS.smart,
            messages: formattedMessages,
            temperature: 0.3,
            max_tokens: 500
        });

        const reply = completion.choices?.[0]?.message?.content?.trim() || "Namastey sir/ma'am, kripya apni query dobara bhejein.";
        logger.info(`[Groq] generateResponse success. Reply length: ${reply.length}`);
        return reply;
    } catch (err) {
        logger.error(`[Groq] generateResponse error: ${err.message}`);
        if (err.status === 401) {
            return "ERROR_401: Invalid API Key. Please check your GROQ_API_KEY or OPENAI_API_KEY in Render environment variables.";
        }
        return "Namastey sir/ma'am, clinic reception temporarily busy hai. Kripya thodi der mein message bhejein.";
    }
}

/**
 * Classify the intent of an incoming patient message, supporting multi-intent arrays and contextual confirmation.
 */
async function classifyIntent(message, history = []) {
    const historyBlock = history.length
        ? `Recent conversation context (pay attention to what the bot just asked):\n${history.map(m => {
            const contentStr = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            return `${m.role}: ${contentStr}`;
          }).join("\n")}\n\n`
        : "";

    const prompt = `
${historyBlock}
You are an intent classification engine for a medical clinic's virtual receptionist. 
Analyze the user's message and recent conversation history, and output a strict JSON object containing an array of identified intents.

Categories of Intent:
1. "check_availability": User is asking about clinic timings, if the clinic is open, or when the doctor sits.
2. "book_appointment": User is explicitly asking to book, schedule, or get a token.
3. "check_status": User is asking about their queue number, wait time, or active token.
4. "general_query": User is asking for address, fees, directions, or contact info.
5. "cancel_or_correct": User is frustrated, says they didn't mean to book, or wants to cancel.
6. "medical_query": User is asking about symptoms, medicines, test preparation (fasting, drinking water/coffee before tests), or lab instructions.
7. "confirmation": User is saying yes, okay, "haan kar do", "thik hai", or confirming a previous question/proposal by the bot.
8. "human_handoff": User is asking to speak with a human receptionist, staff, or doctor ("receptionist se baat karni hai").

Examples for mapping (pay close attention to Hinglish & context):
- "aaj doctor saab available hai?" -> ["check_availability"]
- "doctor kab beth te hai aur fees kitni hai?" -> ["check_availability", "general_query"]
- "haan kar do" (when bot asked to book) -> ["confirmation"]
- "mujhe receptionist se baat karni hai" -> ["human_handoff"]
- "Mera subah fasting blood sugar test hai, kya coffee pi sakti hu? Agar nahi, toh token cancel kar do" -> ["medical_query", "cancel_or_correct"]
- "arey bhai mene booking karne ko bola hi nahi hai" -> ["cancel_or_correct"]

User message: "${message}"

Return ONLY valid JSON in this exact format, with no markdown formatting or extra text:
{
  "intents": ["intent_1", "intent_2"]
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
        // Ensure backwards compatibility with single intent format if model returns string
        let intentsArray = result.intents || (result.intent ? [result.intent] : ["unknown"]);
        logger.info(`[Groq] classifyIntent success. Intents: ${JSON.stringify(intentsArray)}`);
        return { intents: intentsArray, intent: intentsArray[0] };
    } catch (err) {
        logger.warn(`[Groq] classifyIntent fallback: ${err.message}`);
        if (err.status === 401) {
            return { intents: ["error_401"], intent: "error_401", error: "Invalid API Key" };
        }
        return { intents: ["unknown"], intent: "unknown", confidence: 0, entities: {} };
    }
}

module.exports = {
    generateResponse,
    classifyIntent
};
