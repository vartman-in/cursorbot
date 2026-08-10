// services/features/adminsystemprompt.js
const { Groq } = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function parseAdminCommand(adminMessage, clinicData) {
    const systemPrompt = `
    You are 'Jarvis', the backend admin assistant for a clinic. 
    The doctor/admin will send you instructions in English, Hindi, or Hinglish.
    Your job is to map their instruction to one of the available tools.
    
    - If they say they are late (e.g., "1 ghanta late", "busy hu 30 mins"), use 'set_delay'.
    - If they want to shift all today's appointments to tomorrow (e.g., "aaj ki kal kardo"), use 'bulk_reschedule'.
    - If they want to call the next patient, use 'advance_queue'.
    - If they want to unmute or resolve a patient so the bot can talk to them again, use 'resolve_patient'.
    - If they ask for the current line or queue status, use 'get_status'.
    - If they explicitly ask to reset, clear, or restart the queue (e.g. "queue reset kardo", "clear the queue"), use 'reset_queue'.
    - If they want to pull a specific token out of sequence for an emergency or priority (e.g., "token 50 ko pehle bulao", "Token 15 emergency hai"), use 'prioritize_token'.
    
    Current Date/Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
    `;

    const tools = [
        {
            type: "function",
            function: {
                name: "set_delay",
                description: "Delays the queue by a specific number of minutes.",
                parameters: {
                    type: "object",
                    properties: {
                        minutes: { type: "integer", description: "Number of minutes delayed" }
                    },
                    required: ["minutes"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "bulk_reschedule",
                description: "Moves all remaining appointments for a specific date to a new date.",
                parameters: {
                    type: "object",
                    properties: {
                        from_date: { type: "string", description: "YYYY-MM-DD" },
                        to_date: { type: "string", description: "YYYY-MM-DD" }
                    },
                    required: ["from_date", "to_date"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "advance_queue",
                description: "Advances the queue to serve the next token in line.",
                parameters: {
                    type: "object",
                    properties: {},
                    required: []
                }
            }
        },
        {
            type: "function",
            function: {
                name: "get_status",
                description: "Checks the current live queue status, including the currently serving token.",
                parameters: {
                    type: "object",
                    properties: {},
                    required: []
                }
            }
        },
        {
            type: "function",
            function: {
                name: "reset_queue",
                description: "Fully resets today's queue back to zero (clears token counters and the patient list). Use only when the admin explicitly asks to reset, clear, or start the queue over.",
                parameters: {
                    type: "object",
                    properties: {},
                    required: []
                }
            }
        },
        {
            type: "function",
            function: {
                name: "resolve_patient",
                description: "Un-mutes a patient chat so the AI can start responding to them again.",
                parameters: {
                    type: "object",
                    properties: {
                        phone: { type: "string", description: "The patient's phone number to resolve (e.g., 919876543210)" }
                    },
                    required: ["phone"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "prioritize_token",
                description: "Moves a specific token number to the very front of the queue for immediate service due to an emergency or VIP status.",
                parameters: {
                    type: "object",
                    properties: {
                        token_number: { type: "integer", description: "The specific token number to pull to the front" }
                    },
                    required: ["token_number"]
                }
            }
        }
    ];

    try {
        const response = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: adminMessage }
            ],
            model: "llama-3.3-70b-versatile", // Upgraded to the current supported model
            tools: tools,
            tool_choice: "auto",
        });

        const toolCall = response.choices[0]?.message?.tool_calls?.[0];
        if (toolCall) {
            return {
                command: toolCall.function.name,
                args: JSON.parse(toolCall.function.arguments)
            };
        }
        
        return { command: "unknown", reply: response.choices[0]?.message?.content };
    } catch (error) {
        console.error("Admin AI parsing failed:", error);
        return null;
    }
}

module.exports = { parseAdminCommand };
