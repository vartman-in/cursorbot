# Current Audit Evidence — 11 August 2026

## Live service verification

The deployed Render health endpoint returned a healthy JSON response after the service woke from a cold start:

```json
{"status":"ok","service":"clinic-ai-receptionist","uptime":14.164598199}
```

Endpoint checked: https://cursorbot-s9e5.onrender.com/health

## Verified code findings

| Area | Verified finding | Readiness impact |
|---|---|---|
| Closed-hours tokens | The original `queueService.bookToken()` always used the current India date and did not validate clinic hours. The webhook directly called it for `book_appointment`. | Critical defect: a Sunday/overnight request could receive an immediate live token. |
| Closed-hours remediation | `services/clinicHoursService.js` and a webhook gate have been added locally. Tests cover Sunday 01:48 IST, Monday after closing, and an open Monday time. | Fixed locally; needs commit, push, Render deploy, then WhatsApp validation. |
| Queue source of truth | `queueService` stores the live counter and `queueList` together in `queues/{clinicId}__{department}__{date}`. | Correct model for atomic token/dashboard sync. |
| Clinic identity drift | The webhook previously fell back from a missing clinic mapping to raw Green API `instanceId` as `clinicId`. The dashboard uses named clinic IDs such as `clinic-city-health`. | Critical dashboard mismatch risk. A context resolver and safe no-mapping response were added locally. |
| Dashboard API | The active production server mounts `routes/adminDashboardRoutes.js`; it reads queue documents directly. The separate `routes/dashboard.js` is not mounted. | Multiple competing dashboard implementations remain; only the active route should be treated as production. |
| Scheduling model | The product supports same-day sequential live tokens, not actual future appointment slots. Patient “reschedule” does not create a new date/time booking. | High-priority product gap. |
| Voice | The present `package.json` has no ElevenLabs dependency. The detected voice module documents Groq Whisper. | ElevenLabs replacement is not verifiable in the current checkout. |
| Automated tests | `npm test` runs an unrelated “Dream Pair Maya” commerce smoke test and failed 16 checks due to missing order/inventory/payment modules. | Critical QA gap: the configured suite does not test this clinic bot. |
| Admin dashboard security | Reception/doctor dashboard APIs are exposed under `/api` without authentication in the checked server/routes. | Critical security/compliance gap before SaaS sales. |
| Live availability | The first `curl` timed out during cold start; browser access then returned healthy status with ~14 sec uptime. | Free/low-tier cold-start behavior must be handled operationally. |

## Local validation performed

```text
node --check routes/webhook.js
node --check services/clinicHoursService.js
node --check services/clinicContextService.js
node --check routes/adminDashboardRoutes.js
node scripts/testClinicHours.js
```

Result: syntax checks passed and `Clinic-hours safeguards: all tests passed.`

## Note

This document reflects the repository checkout and the live health result on 11 August 2026. It intentionally separates locally fixed code from code confirmed as deployed on Render.
