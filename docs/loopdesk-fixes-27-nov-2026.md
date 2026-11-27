# Loopdesk changes needed — bug report 27 Nov 2026

Loyvexa sends and receives WhatsApp through Loopdesk (repo `santwayne/loopdeskai-software`) for hub
brands. Bug #2 is entirely on the Loopdesk side, and #3, #4 and #5 also need Loopdesk to do its part.
Loyvexa's side is done in this PR.

## Bug 2 — owner number's messages never reach Loyvexa (must fix in Loopdesk)

**What happens:** 8264161658 is Loopdesk's owner number (the morning plan goes to it) and also
"Test Dealer B" in Loyvexa. On 27 Nov 10:34 it sent `STOP` and `hi`. Neither shows in Loyvexa →
WhatsApp → Recent messages nor in the Loopdesk Inbox. Loopdesk treats every message from the owner
number as a reply to the plan and keeps it.

**Fix in Loopdesk's inbound webhook (where the owner's plan replies are handled):**

1. A message from the owner number is a plan reply **only** if it matches the plan grammar:
   `ALL`, `SKIP`, `PLAN`, or item numbers (`1`, `1 3`, `1,3,4`). Case-insensitive, trimmed.
2. Everything else from the owner number goes down the normal path: shown in the Loopdesk Inbox and
   forwarded to every tool the business has (Loyvexa: `POST {LOYVEXA_API_URL}/api/hub/whatsapp/inbound`,
   hub token purpose `whatsapp-inbound`, body `{ messages: [{ from, text, id }] }`).
3. `STOP` / `START` (also `UNSUBSCRIBE`, `SUBSCRIBE`, `YES` after a STOP) are **always** recorded in
   Loopdesk's opt-out list **and** forwarded to Loyvexa — even from the owner number.
4. Send `from` with the country code (`918264161658`). Loyvexa now fixes a 10-digit number itself,
   but the full number is the contract.

## Bug 3 — reply to START fails with "This person sent STOP to the business"

Loyvexa now clears its own STOP flag and then calls Loopdesk **before** replying (with one retry):

```
POST {REGULARS_API_URL}/api/hub/tools/loyvexa/whatsapp/opt-in
Authorization: Bearer <HS256 JWT, HUB_SECRET, iss "loyvexa", aud "regulars-hub", sub <hub business id>, purpose "whatsapp-opt-in", jti, exp 2 min>
{ "to": "919814000102", "optIn": true }     →  200 { "ok": true }
```

If Loopdesk answers 404, Loyvexa shows: *"Loopdesk does not have the opt-in endpoint yet"*.
**Loopdesk must implement this endpoint** (remove/add the number on its STOP list for that business).
Until then the START reply keeps failing, and the Participants page now shows a **"STOP in Loopdesk"**
pill and an **Unblock WhatsApp** button for that dealer.

## Bug 4 — welcome template does not exist (#132001)

Loyvexa now reads the approved list from
`GET {REGULARS_API_URL}/api/hub/tools/loyvexa/whatsapp/templates` (purpose `whatsapp-templates`) and
uses the template's **real name and language code**. Loopdesk must:

- serve that endpoint: `{ templates: [{ name, language, status, category, body }] }`, and
- have `loyvexa_participant_created` (or `loyvexa_welcome`) **approved** in Meta.
  Body params: `{{1}}` dealer name, `{{2}}` brand name.

If the endpoint is missing, Loyvexa falls back to the language in `WHATSAPP_TEMPLATE_LANGUAGE`
(default `en`) on the Loyvexa server — set it to the language the template was created in (`hi`, `en_US`…).

## Bug 5 — bot replies fail with "Re-engagement message"

Loyvexa now always replies to `91XXXXXXXXXX`. A reply to a 10-digit number was read by Meta as a
foreign number that never messaged — the likely cause. If it still happens, Loyvexa's error text says
whether the dealer wrote within 24 hours. If they did, **Loopdesk sent the reply from a different
phone number ID than the one the dealer wrote to** — Loyvexa replies must go out from the same number
the inbound message came to.
