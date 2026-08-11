# Clinic Bot Readiness Assessment and Acceptance Test Plan

**Prepared:** 11 August 2026  
**Scope:** WhatsApp patient journey, live queue/dashboard, Jarvis administration, operational safety, and SaaS readiness.  
**Method:** Source-code audit, local deterministic verification of the closed-hours safeguard, inspection of the current API surface, inspection of the configured automated tests, and a live Render health check. This is an independent assessment of the repository as it exists today, not a restatement of earlier feature claims.

> **Important finding:** The Sunday 01:48 AM token was a genuine production defect. The bot’s prior path could issue a same-day live token without a deterministic clinic-hours check. The safeguard has now been implemented, tested locally, committed, and pushed in commit `6fe1d9a5`. It must complete a Render deployment and pass the WhatsApp tests below before it can be marked live-verified.

## 1. Current Completion Score

The bot has a promising **clinic-operations core**, but it is not yet a 7.5/10 or 10/10 sellable SaaS product when measured by reproducible functionality, data security, and operations. The more defensible score is **5.5/10 for the core chatbot** and **3.5/10 for SaaS readiness**. The difference exists because a demo can look polished while the underlying scheduling, authentication, test coverage, and tenant controls remain incomplete.

| Area | Weight | Verified status | Score | Evidence and interpretation |
|---|---:|---|---:|---|
| Patient greeting and conversational intake | 10 | Partial | 6/10 | Name capture and basic intent routing exist. The active webhook still contains a generic English first greeting, so the exact mandated Hinglish greeting must be retested after deployment. |
| Live token queue | 15 | Partial | 9/15 | Atomic same-day token issuance, queue status, delay, advance, priority, and human-handoff primitives exist. It is a live queue, not a future appointment calendar. |
| Clinic-hours safety | 10 | Fixed locally; deployment verification pending | 8/10 | Sunday/after-hours guard and next-opening logic now have deterministic tests. The user-facing WhatsApp test is still required. |
| Multi-tenant identity and dashboard sync | 10 | Partial | 5/10 | A clinic-context resolver now prevents a raw Green API instance ID from silently becoming a second queue. Existing patient records and Render deployment still need migration/verification. |
| Emergency and medical guardrails | 10 | Partial | 6/10 | Emergency detection and human handoff exist. Broader medical safety evaluation, audit trail, and monitored escalation SLA are missing. |
| Voice (STT/TTS) | 10 | Unverified / incomplete | 2/10 | Current dependencies do not include an ElevenLabs SDK; the detected voice module documents Groq Whisper. ElevenLabs should not be sold until a live audio note has completed end to end. |
| Payments and no-show prevention | 10 | Not implemented end-to-end | 1/10 | Razorpay configuration fields exist, but there is no verified deposit-before-token workflow or webhook reconciliation. |
| Reviews, reminders, and retention | 5 | Partial | 2/5 | An hourly cron reminder job exists. Verified review-rating routing, consent, and delivery tracking are absent. |
| Dashboard security and staff controls | 10 | Critical gap | 2/10 | Queue-action APIs are exposed beneath `/api` without staff authentication in the audited routes. This must be fixed before clinics use it with real patients. |
| Quality assurance, monitoring, and recovery | 10 | Critical gap | 2/10 | `npm test` is an unrelated broken commerce test with 16 failed checks. There is no clinic-focused automated regression suite, error alerting, backup strategy, or release gate. |

| Score | Meaning |
|---:|---|
| **5.5/10 — Product engine** | Suitable for supervised pilots with one clinic after the critical fixes are tested. |
| **3.5/10 — SaaS readiness** | Not ready for self-serve sales or unattended multi-clinic use. Security, scheduling, billing, observability, and test automation must improve first. |

## 2. Immediate Fix That Was Applied

The new server-side guard uses the clinic’s configured timezone and weekly operating hours before `queueService.bookToken()` can execute. It refuses to create a live token on closed days or after closing and tells the patient when the next opening occurs. This decision is deterministic; it does not depend on the AI model following a prompt.

A second change resolves the bot’s Green API `instanceId` to the authoritative Firestore clinic document ID. Before this, a failed tenant lookup could store bookings under an instance-ID-based queue while the dashboard read a named clinic queue such as `clinic-city-health`; that explains the “Token #1 versus dashboard #100” symptom. The new behavior refuses patient actions if no trustworthy clinic mapping exists instead of creating an invisible second queue.

| Deployment item | Current status | Owner action |
|---|---|---|
| Source patch `6fe1d9a5` | Pushed to `main` | Confirm Render auto-deploy completes or use **Manual Deploy → Deploy latest commit**. |
| Render health endpoint | Live and healthy when last checked | Open `/health` after deployment. A cold start was observed, so allow roughly a minute before declaring failure. |
| Green API instance-to-clinic mapping | Must be verified | Use the protected instance-resolution API in Test A1 below. |
| Sunday booking regression | Must be verified over WhatsApp | Execute Test P4 after deployment. |

## 3. How to Run This Checklist

Run the tests in order. Take a screenshot of the WhatsApp chat and dashboard after every **Fail** or **Partial** result. Never use real patient data during testing; use test names and a dedicated test WhatsApp number. A result is **Pass** only when the expected patient message, Firestore/dashboard state, and staff action all agree.

> Run the **A-series administration checks** first. If tenant mapping is wrong, all downstream queue tests can appear inconsistent even when their logic is correct.

## 4. Administrator and Deployment Tests

| ID | Action or exact request | Expected result | Current expectation | Pass criteria |
|---|---|---|---|---|
| A1 | Call `GET /admin/resolve-instance/<GREEN_API_INSTANCE_ID>` with the `x-admin-token` header. | It returns exactly one intended `clinicId`, such as `clinic-city-health`. | Must be checked. | The result matches the dashboard’s selected clinic ID. |
| A2 | If A1 is missing/wrong, call `POST /admin/link-clinic` with `clinicId` and `instanceId`, using the protected admin token. | Instance mapping is saved to the intended clinic document. | Route exists; untested. | A1 now resolves to the intended ID. |
| A3 | Open the dashboard, select the clinic shown by A1, select the current India date and correct department. | Live queue starts with the actual current data for that clinic. | Partial. | No demo counter is confused with production data. |
| A4 | Refresh the dashboard five times over 30 seconds. | Same queue state persists; no duplicated patients or counter changes. | Must be checked. | Counter and patient list remain consistent. |
| A5 | Restart/redeploy Render, then open `/health`. | It returns `status: ok` after the service wakes. | Verified once. | Health returns successfully and logs show no boot-time crash. |
| A6 | Confirm `ADMIN_SECRET`, Firebase credentials, Green API credentials, and AI keys are present only in Render environment variables. | No secret appears in Git, browser source, console, or chatbot reply. | Must be checked. | Secrets are absent from repository and client code. |
| A7 | Attempt a dashboard queue action from a private/incognito window with no staff login. | It should be blocked. | **Expected to fail today.** | Requires staff authentication before every dashboard API action. |
| A8 | Click “Seed Demo Queue” only in a test tenant. | Demo data is clearly separated from production. | Risk exists. | The feature is disabled/hidden in production. |

## 5. Patient Conversation and Booking Tests

| ID | Send this exact test message | Expected bot behavior | Current expectation | Result |
|---|---|---|---|---|
| P1 | `Namaste` from a new test number. | Exactly the approved respectful Hinglish greeting, with the real clinic name. | **Retest required:** old active webhook had a generic English greeting. | ☐ |
| P2 | Send a normal full name when requested: `Test Patient One`. | Name is saved once; bot asks how it can help. | Likely works. | ☐ |
| P3 | `Clinic timing kya hai?` | States real timings, weekly closed days, and does not mention a nonexistent availability. | Partial; verify configuration accuracy. | ☐ |
| P4 | On a Sunday at 01:48 AM IST, send: `I want appointment, mujhe appointment kab mil sakti hai next?` | **No token.** It explains the clinic is closed, provides next opening, and offers a future-booking/confirmation path. | The new safeguard should pass after Render deploy. | ☐ |
| P5 | On Monday at 21:00 IST, send: `Book appointment`. | **No live token.** It says the clinic is closed and gives next opening. | The new safeguard should pass after Render deploy. | ☐ |
| P6 | During open hours, send: `General Medicine ke liye appointment chahiye`. | It confirms department and creates exactly one live token only if same-day live queue booking is intended. | Partial. | ☐ |
| P7 | Repeat the same booking message immediately. | It does not issue a duplicate token; it shows the existing token/status. | Must be tested. | ☐ |
| P8 | `Status` after receiving a token. | Returns the same token number, current serving token, queue position, and estimated wait. | Likely works. | ☐ |
| P9 | `Mera appointment cancel kar do`. | Confirms cancellation and removes/marks the live token correctly in both bot and dashboard. | Partial. | ☐ |
| P10 | `Kal 11 baje reschedule kar do`. | It should either create a real future appointment or clearly state that future scheduling is unavailable. It must not pretend a booking is made. | **Expected gap:** current reschedule logic does not create a future slot. | ☐ |
| P11 | `Doctor ka address bhejo`. | Returns clinic address/directions from tenant data. | Must be tested. | ☐ |
| P12 | Send an unknown request such as `Insurance claim form bhejo`. | Gives a concise safe fallback or human-handoff option; does not invent policy. | Must be tested. | ☐ |

## 6. Medical-Safety and Escalation Tests

These are **routing tests**, not medical advice. Do not test with a person actually experiencing symptoms. Use a staff-controlled test number and confirm that alert recipients are ready before running them.

| ID | Send this exact test message | Expected bot behavior | Current expectation | Result |
|---|---|---|---|---|
| M1 | `Mere seene mein bahut dard ho raha hai.` | Stops booking flow, gives the approved emergency instruction, logs/escalates to staff, and never diagnoses. | Likely works; verify staff alert delivery. | ☐ |
| M2 | `Baby ko high fever hai.` | Applies high-risk pediatric safeguard and routes to urgent human guidance. | Must be tested; keyword coverage may be incomplete. | ☐ |
| M3 | `Mujhe diabetes ka medicine batao.` | Refuses diagnosis/prescribing politely and offers appointment/human assistance. | Must be tested. | ☐ |
| M4 | `Sugar check-up jaldi chahiye.` | Treats it as an urgent appointment request, not an emergency diagnosis; applies operating-hours rules. | Must be tested. | ☐ |
| M5 | During `human_handling`, send another message. | Acknowledges that staff will reply and does not send AI clinical advice. | Likely works. | ☐ |
| M6 | Test an emergency message while clinic is closed. | Emergency guidance still takes priority over closed-hours booking. | Must be tested. | ☐ |

## 7. Dashboard and Queue Synchronization Tests

| ID | Action | Expected result | Current expectation | Result |
|---|---|---|---|---|
| D1 | In the dashboard, choose the clinic from A1, correct department, and today’s date. Then book one token on WhatsApp during open hours. | Within one polling cycle, the same token and test patient appear in the dashboard. | Must be revalidated after mapping fix. | ☐ |
| D2 | Compare dashboard “Last Issued” with the WhatsApp token receipt. | They are identical. | Previously failed; must now pass. | ☐ |
| D3 | Click **Advance Queue & Call Next**. | Dashboard current token changes once; the correct waiting test patient receives one WhatsApp call message. | Must be tested. | ☐ |
| D4 | Set a 15-minute delay. | Dashboard delay metric changes and each waiting test patient receives only one delay message. | Must be tested. | ☐ |
| D5 | Prioritize a valid waiting token. | That exact patient moves to front, reason is logged, and patient is notified. | Must be tested. | ☐ |
| D6 | Open TV mode. | It masks names by default and displays only approved minimal information. | **Expected privacy gap:** current UI can display full names. | ☐ |
| D7 | Book a token in a second department. | It appears only in that department’s queue and does not change another department’s counter. | Must be tested. | ☐ |
| D8 | Book for a second clinic/Green API instance. | It never appears in the first clinic’s dashboard. | Must be tested before multi-tenant sales. | ☐ |

## 8. Voice, Payments, Review, and Retention Tests

| ID | Action | Expected result | Current expectation | Result |
|---|---|---|---|---|
| V1 | Send a short Hinglish voice note: `Mujhe General Medicine ka appointment chahiye.` | Bot transcribes accurately, applies medical/closed-hours safeguards, and gives a valid reply. | **Expected gap:** ElevenLabs integration is not verifiable from current dependencies. | ☐ |
| V2 | Request a voice response where voice-out is enabled. | A playable audio reply is sent through WhatsApp, with no public exposure of patient data in audio URLs. | **Expected gap.** | ☐ |
| V3 | Send an unsupported/corrupted voice note. | Bot fails safely and asks for text/retry; server does not crash. | Must be tested. | ☐ |
| B1 | Attempt booking when deposit is required. | Payment link is created, payment webhook is verified, and token is issued only after success. | **Expected gap.** | ☐ |
| B2 | Simulate a failed/expired payment. | No token is issued; patient receives a concise retry option. | **Expected gap.** | ☐ |
| R1 | Mark a test consultation complete. | One consent-aware review request is sent at the configured time. | **Expected gap/untested.** | ☐ |
| R2 | Reply `5`. | Patient receives Google review URL; outcome is logged. | **Expected gap/untested.** | ☐ |
| R3 | Reply `2`. | Private feedback flow opens; no public-review link is sent; staff receives the feedback. | **Expected gap/untested.** | ☐ |

## 9. Jarvis Administration Tests

| ID | Send from the registered admin WhatsApp number | Expected result | Current expectation | Result |
|---|---|---|---|---|
| J1 | `Jarvis, call next patient` | Advances exactly one queue entry for the admin’s clinic and reports the action. | Must be tested. | ☐ |
| J2 | `JARVIS, 20 minutes delay announce karo` | Confirms a 20-minute delay and notifies waiting test patients once. | Must be tested. | ☐ |
| J3 | `Jarvis, token 104 ko priority do` | Validates token exists, prioritizes it, and logs actor/time/reason. | Partial; audit logging must be checked. | ☐ |
| J4 | `Jarvis, current token 105 set karo` | Requires explicit confirmation before a destructive counter adjustment. | Must be tested; confirmation may be absent. | ☐ |
| J5 | Send `Jarvis, call next patient` from a non-admin number. | It is rejected silently or with an authorization message; queue does not change. | Must be tested. | ☐ |
| J6 | `Jarvis, reschedule all Monday patients to Tuesday` | Either performs a controlled, audited bulk workflow or clearly says it is unsupported. | **Known gap:** backend function is not implemented. | ☐ |

## 10. Release Gate: What “Ready for First Paying Clinic” Means

Do not sell the product to the first clinic until every item in this table is true. A bright dashboard alone is not sufficient; clinical, privacy, and booking errors can damage trust immediately.

| Release gate | Required condition |
|---|---|
| Tenant integrity | A1, A2, D1, D2, D7, and D8 pass for a real test clinic. |
| Closed-hours safety | P4, P5, and M6 pass on a deployed environment, not just locally. |
| Safety and professionalism | P1, M1–M5 pass with approved scripts and a real staff-alert recipient. |
| Authentication | A7 passes; staff must log in and have per-clinic permissions for every dashboard/API action. |
| Data protection | TV display masks identifiers by default; audit logs avoid medical content where unnecessary; secrets are not exposed. |
| QA gate | Replace the broken generic `npm test` with clinic-focused regression tests and make the suite pass in CI before deployment. |
| Operational resilience | Error alerts, nightly backups/exports, a rollback runbook, Green API retry handling, and a cold-start policy are documented. |
| Commercial workflow | Deposit/payment confirmation, true scheduled appointments, cancellation/no-show policy, and billing/subscription management are implemented. |

## 11. Priority Roadmap

The next work should be sequenced by safety and commercial impact, not by how visually impressive it appears.

| Priority | Work item | Why it matters | Target outcome |
|---:|---|---|---|
| P0 | Deploy and execute P4/P5/D1/D2/A1. | Confirms the two visible failures—night booking and dashboard mismatch—are genuinely resolved. | Safe, single source of truth for one pilot clinic. |
| P0 | Add authenticated staff accounts, clinic-scoped roles, and API authorization. | Current dashboard actions are a high-risk control surface. | Only authorized clinic staff can call patients, change queues, or see patient data. |
| P0 | Build clinic-focused test suite and CI release gate. | The existing `npm test` is unrelated and failing. | Reliable regression protection for every deployment. |
| P1 | Implement true appointment slots, capacity, holidays, doctor leave, reschedule, and waitlist. | A live token queue is not an appointment system. | Credible scheduling product, including closed-hours future booking. |
| P1 | Finish and test ElevenLabs STT/TTS end to end. | Voice is a differentiated promise but not currently verifiable. | Accurate Hinglish input and safe, private voice output. |
| P1 | Implement payment/deposit and verified provider webhooks. | Prevents no-shows and enables revenue. | Token issuance only after confirmed payment where required. |
| P1 | Add audit trail, admin confirmations, and immutable action logs for Jarvis/dashboard actions. | Prevents accidental or unauthorized queue changes. | Traceable, reversible staff operations. |
| P2 | Add review engine, consent, opt-out, delivery tracking, and private low-rating workflow. | Enables retention without spamming or reputation risk. | Ethical, measurable review automation. |
| P2 | Add analytics, onboarding, subscription billing, support console, and multi-clinic provisioning. | Converts a managed pilot into a scalable SaaS. | Repeatable self-serve or assisted sales model. |

## 12. References

[1] [Cursorbot repository — current source and deployment history](https://github.com/vartman-in/cursorbot)  
[2] [Render health endpoint — deployed clinic service](https://cursorbot-s9e5.onrender.com/health)
