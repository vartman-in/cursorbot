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
async function generateResponse(history, instanceId, clinicData, extraContext = "", intent = "general_query") {
    try {
        const { buildConciseClinicContext } = require("./clinicPrompt");
        const clinicContextStr = buildConciseClinicContext(clinicData, intent);

        // Tier 2 Simplified Persona: Focus on complex administrative reasoning
        const systemPrompt = `Role & Identity:
You are a highly efficient, empathetic Virtual Receptionist for a medical clinic.
The user has asked a complex administrative question that our automated system could not answer with a standard template. 
Your job is to answer their specific query politely in Hinglish using the clinic data below.

Strict Guardrails:
1. Administrative Only: Do not offer medical advice, diagnosis, or test preparation instructions.
2. No Guessing: If the user asks for a price or policy NOT in the context, say: "I don't have the exact details for that right now, but our front desk will help you."
3. Concise: Keep answers short. No long lists or overly verbose greetings if already mid-conversation.
4. Formatting: Use natural Hinglish. Clean bullet points. Acknowledge doctors by name.

Clinic Context:
${clinicContextStr}
${extraContext ? `\nAdditional Context:\n${extraContext}` : ''}`;

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
You are the Master Router for a medical clinic's virtual receptionist. 
Analyze the user's message and context to output a strict JSON object with identified intents and their designated routing_tier.

TIER 1: Pre-fixed Administrative (Standard queries)
- "greeting": Simple greetings (e.g., "hi", "hello", "namastey").
- "check_availability": Timings, open/closed, doctor schedule (e.g., "kab baithte hain", "timing kya hai").
- "clinic_address": Location, directions (e.g., "clinic kahan hai", "address bhejo").
- "book_appointment": Explicit booking/token request (e.g., "number laga do", "appointment chahiye").
- "check_status": Queue position, wait time (e.g., "token status kya hai").

TIER 2: Generative Reasoning (Complex or multi-part)
- "general_query": Fees, specific services, parking, insurance (e.g., "X-ray hota hai?", "fees kitni hai").
- "report_status": PDF reports, lab results, turnaround time (e.g., "report kab tak aayegi").
- "cancel_or_correct": Cancellations, correcting bot mistakes (e.g., "cancel kar do", "maine nahi bola").
- "confirmation": Affirmations to bot questions (e.g., "haan", "thik hai").

TIER 3: Human Handoff (Clinical or Emergency)
- "medical_query": Symptoms, medicines, test prep (e.g., "ulti ho rahi hai", "kya dawai loon").
- "emergency": Severe symptoms, urgent help (e.g., "saans lene mein dikkat", "tez bukhar").
- "human_handoff": Requesting human staff (e.g., "receptionist se baat karao").

STRICT NEGATIVE CONSTRAINT:
- PDF/Report requests are TIER 2 ("report_status"), NOT TIER 3 ("medical_query").

Return ONLY valid JSON in this format:
{
  "intents": ["intent_name"],
  "routing_tier": 1 | 2 | 3
}

User message: "${message}"`;

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
        // Ensure backwards compatibility and include routing_tier
        let intentsArray = result.intents || (result.intent ? [result.intent] : ["unknown"]);
        let tier = result.routing_tier || 2; // Default to generative if not specified
        
        logger.info(`[Groq] classifyIntent success. Intents: ${JSON.stringify(intentsArray)}, Tier: ${tier}`);
        return { intents: intentsArray, intent: intentsArray[0], routing_tier: tier };
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
