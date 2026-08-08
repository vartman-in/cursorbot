# Archived: Sneaker-store ("The Dream Pair" / Maya) legacy code

This repo's `package.json` was originally named `the-dream-pair-maya` — a WhatsApp
commerce bot for a sneaker store (COD anti-fraud shields, Shiprocket shipping,
Google Sheets product catalog, Razorpay deposit checkout). That project was later
repurposed into the current **clinic AI receptionist** (see `server.js` →
`routes/webhook.js`), but the old sneaker-store files were left in place instead
of being removed, creating duplicate/conflicting services and at least one
broken entry point.

Everything below was moved here on the 2026-07-31 cleanup pass. Nothing here is
required by the live server (`server.js`, `routes/webhook.js`,
`controllers/adminController.js`, `jobs/reminderJob.js`) — confirmed by tracing
every `require()` from those entry points before moving.

## What moved and why

| Original path | Reason |
|---|---|
| `index.js` | Root "Anti-Fraud Shield" entry point; required `./codInterceptor`, `./locationVerifier`, `./unboxingContract`, none of which exist in the repo — already broken, and nothing required this file. |
| `routes/webhooks.js` | Sneaker payment/inventory webhook router (plural). Never mounted in `server.js` (only `routes/webhook.js`, singular, is mounted). |
| `routes/orderNotifications.js` | Sneaker order-confirmation email/notification route. Never mounted. |
| `jobs/tokenExpiryJob.js` | Sneaker "reserve → pay in 15 min or lose it" checkout timer, built against the Mongoose `Order` model (product/size/deposit fields). Not wired into `server.js`, and not the same concept as the clinic token/queue system (see new `services/queueService.js`). |
| `integrations/razorpay/depositHandler.js` | Sneaker COD deposit-link creation/verification. Unused. |
| `models/Order.js`, `models/FraudState.js`, `models/Client.js`, `models/User.js` | Mongoose schemas for sneaker orders, COD fraud state, and product-browsing client profiles (brand/size/color prefs). Clinic data lives in Firestore (`services/databaseService.js`), not these Mongoose models. |
| `services/paymentService.js`, `services/razorpayService.js` | Sneaker checkout/payment logic. Only referenced by the now-archived `routes/webhooks.js` and the test smoke test. |
| `services/inventoryService.js`, `services/features/inventoryService.js` | Sneaker product/stock inventory (two duplicate versions). Not applicable to a clinic. |
| `services/emailService.js` | Order-confirmation emails for the sneaker store. Only used by the archived `orderNotifications.js`. |
| `services/googleSheets.js`, `services/data/memoryStore.js` | Sneaker product catalog synced from a Google Sheet into an in-memory store. |
| `services/data/orderStore.js`, `services/orderStore.js`, `services/data/databaseService.js` | Sneaker order persistence (Razorpay + Google Sheets), built on the archived `Client`/`User` Mongoose models. |
| `services/features/whatsappService.js` | Thin Green API wrapper written specifically for the sneaker "payment flow" and only ever called by the archived `tokenExpiryJob.js`. The live path uses `services/greenApi.js` (and `services/whatsapp/whatsappService.js` remains available as a richer, generic wrapper for future use). |
| `middleware/webhookVerify.js` | Razorpay webhook signature verification, only used by the now-archived `routes/webhooks.js`. |
| `services/ai/aiIntegration.js.bak`, `services/features/visionRecognition.js.bak`, `services/data/googleSheetsFetch.js.bak` | Stale `.bak` files superseded by their live counterparts. |

## What was intentionally left alone

Some orphaned files are **clinic-domain**, not sneaker-domain, and were kept in
place as scaffolding for upcoming checklist items rather than archived:
`services/triageService.js`, `services/visionService.js`,
`services/features/voiceSearchService.js`, `services/features/clinicIntentRouter.js`,
`services/calendarService.js`, `services/patientService.js`, `bookingFlow.js`,
`integrations/whatsapp/sender.js` (Meta Cloud API sender, for future WhatsApp
number verification work). These aren't wired in yet either, but they're the
right domain and worth reusing rather than rebuilding.

If anything here turns out to still be needed, it's all preserved verbatim —
nothing was deleted, only moved.
