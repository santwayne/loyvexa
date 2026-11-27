# Handover — Loyvexa bug report fixes (27 Nov 2026)

PR: santwayne/loyvexa #14 (merged into `main`). Bug list: the "LOYVEXA – BUG REPORT (27 Nov 2026)".
Related PRs on the other two products (same bug report) are listed at the end.

## 1. Deploy (Loyvexa EC2)

```bash
cd ~/loyvexa
git pull origin main
docker compose up -d --build        # migration 009 runs automatically when the api starts
docker logs -f loyvexa-api-1        # look for "applied 009_testing_report_3.sql"
```

`docker-compose.override.yml` (untracked, holds the real DATABASE_URL) must stay in place — without it
the containers crash with `auth_failed`.

Optional new env vars in `~/loyvexa/.env`:

| Var | Default | Meaning |
|-----|---------|---------|
| `CALL_RESULT_TIMEOUT_MIN` | `20` | A call still DIALING after this many minutes with no WayneRing result → FAILED – not dialled |
| `WHATSAPP_TEMPLATE_LANGUAGE` | `en` | Language used for Loopdesk templates **only** when Loopdesk's approved-template list can't be read |

Also check `CALL_PROVIDER=waynering` (not `mock`) if real calls are expected.

## 2. What changed, per bug

| # | Where in code | Behaviour now |
|---|---------------|---------------|
| 1 | `src/services/calls/providers.js` (`classifyCallReport`, `waynering`), `calls/index.js` (`settleCall`, `expireSilentCalls`) | Call with no WayneRing ID / failed start / report without proof of ringing / no result in 20 min → **FAILED – not dialled** + reason. NO ANSWER only with proof the phone rang. `calls.provider_status`, `provider_detail` (raw webhook), `dial_failed` columns. Server log lines `[calls] WayneRing start …` and `[calls] webhook …`. |
| 3 | `src/services/bot.js` (START), `routes/admin.js` (participants list) | START clears STOP in Loyvexa, then Loopdesk opt-in (1 retry), then reply. `wa_blocked_upstream` → "STOP in Loopdesk" pill + **Unblock WhatsApp** button. |
| 4 | `src/services/whatsapp.js` (`resolveTemplate`), `notifications.js`, `ai/messaging.js`, `otp.js` | Template name + language from the approved list (Loopdesk/Meta). Alias `loyvexa_welcome` accepted for the welcome. Not approved → message FAILED "Not sent: template … is not approved", nothing sent to Meta. Per-brand override: `tenants.settings.waTemplates = { "participant.created": { "name": "...", "language": "hi" } }`. WhatsApp page "Check connection" lists missing templates. |
| 5 | `whatsapp.js` (`waNumber`, `explain`), `lib/codes.js` | Every send goes to `91XXXXXXXXXX`. Re-engagement / STOP failures carry a plain explanation. |
| 6 | migration `009_testing_report_3.sql`, `calls/index.js`, `public/admin/admin.js` | New status `TEST` for calls and call campaigns (old mock rows converted). Test/failed calls don't count for the 7-day cooldown or the AI weekly contact cap. |
| 7 | `calls/index.js`, `campaigns.js` | Values verified with real scans. `{scheme}` and `{scheme_progress}` both available in call scripts and WhatsApp campaigns. |
| 8 | `routes/admin.js` (`mobileProblem`, `rowProblem`), `admin.js` UI | "Row 4: mobile number khali hai", Excel `E+11` hint, plain-language name/type/number errors. |
| 2 | — | Loopdesk side. Spec: `docs/loopdesk-fixes-27-nov-2026.md`. |

## 3. How to re-test on the live console

1. **AI calls** (#1, #6): launch a 1-person campaign to your own phone. If it doesn't ring, the call must show
   *FAILED – not dialled* with WayneRing ID + dial status, not NO ANSWER. With `CALL_PROVIDER=mock` the campaign shows **TEST**.
2. **START** (#3): from a dealer number send STOP, then START → "Offers wapas chalu kar diye 👍" must arrive.
   If not, Participants shows *STOP in Loopdesk* → click **Unblock WhatsApp**.
3. **Welcome** (#4): add a dealer → WhatsApp → Recent messages. Either the welcome is SENT, or FAILED with
   "template … is not approved" (then approve it in Loopdesk → WhatsApp templates).
4. **Bot reply** (#5): dealer sends "points" → reply SENT. If FAILED, read the reason text (24-hour window / number).
5. **CSV** (#8): import a file with an empty mobile and an Excel `9.198E+11` number → plain messages.

## 4. Automated tests

```bash
# local Postgres + server with WHATSAPP_SEND_MODE=mock, CALL_PROVIDER=mock
npm run migrate && npm run seed && node src/server.js &
BASE=http://localhost:4000 npm run test:report3     # 7 checks, fakes Loopdesk + WayneRing
```

Run each suite against a freshly started server (the OTP rate limit trips if suites run back to back, or
start the server with `OTP_RATE_LIMIT_PER_MINUTE=1000`). `e2e-phase3` needs `CALL_MOCK_OUTCOMES=1` on the server.
`e2e-phase4` needs a Korvo URL and stops at that check on `main` too.

## 5. Still open / depends on other products

- **Loopdesk** must forward owner-number messages that aren't plan replies (#2), and serve
  `POST /api/hub/tools/loyvexa/whatsapp/opt-in` (#3) and `GET /api/hub/tools/loyvexa/whatsapp/templates` (#4).
- **WayneRing** must send real dial status (status, ended_reason, duration) in its outbound-call webhook (#1).
- Meta: `loyvexa_participant_created` (or `loyvexa_welcome`) must be approved — params {{1}} name, {{2}} brand.
- PENDING items from the report (Campaign FAILED status after Meta approval, Korvo orders, "Send plan to
  WhatsApp") can be tested once the above are live.
