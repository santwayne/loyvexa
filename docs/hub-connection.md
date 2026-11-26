# Regulars hub connection (auto-connect)

Loyvexa ab Regulars hub se apne aap judta hai, bilkul WayneRing, CRM, GMB aur Video Studio jaise. Sales/admin client ko Regulars me bundle deta hai (Admin → Products & Bundles, Loyvexa tick), aur baaki sab apne aap hota hai.

## Kya hota hai
| Regulars me | Loyvexa me |
| --- | --- |
| Client ko Loyvexa wala bundle diya | Brand (tenant) banta hai: naam = business ka naam, slug apne aap, pehla admin = owner ka email (TENANT_ADMIN) |
| Bundle renew / plan badla | Wahi brand update hota hai (`hub_business_id` se pehchaana jaata hai). Naam, colour, logo jo brand team ne set kiye wo nahi badalte |
| Bundle lapse / client suspend | Brand SUSPENDED (console aur scans band) |
| Payment aayi | Brand phir ACTIVE |
| Client home page pe "Open Loyvexa ↗" | `/sso#token=…` → brand console me seedha login, bina password |

Owner ka email kisi aur brand me pehle se ho toh admin ka login email `owner+<slug>@hub.loyvexa.invalid` banta hai. SSO phir bhi chalta hai. Owner apna password chahe toh brand console me set kar sakta hai.

## Endpoints
- `POST /api/hub/provision`: Bearer hub JWT (purpose `provision`). Body Regulars ke `lib/hub/provision.ts` jaisi hai. Jawab: `{ accountId, status: ACTIVE|PAUSED, data: { slug, name, created, consoleUrl } }`.
- `POST /api/hub/sso/exchange`: `{ token }` (purpose `sso`). Jawab me admin session milta hai.
- `GET /sso`: chhota page jo token exchange karke `/admin/` khol deta hai.

Token: HS256, `iss regulars-hub`, `aud loyvexa`, `sub` = Regulars business id, ek baar hi chalta hai (`hub_token_uses`), 2 minute ke andar expire.

## Setup
1. `npm run migrate` (`004_hub.sql`: `tenants.hub_business_id`, `hub_token_uses`).
2. Loyvexa `.env`: `HUB_SECRET=<openssl rand -hex 32>`.
3. Regulars `.env`: `HUB_SECRET_LOYVEXA=<wahi value>`, `LOYVEXA_API_URL` aur `LOYVEXA_APP_URL` = Loyvexa ka address (dono same).
4. Test: `BASE=… HUB_SECRET=… node scripts/e2e-hub.js`.

## Brands page (super admin)
Console me super admin ko **Brands** dikhta hai: saare brands, kaun hub se bana, participants/scans, Open, Suspend/Activate. Naya brand banane ka form jaan-boojh ke nahi hai: brand **Loopdesk admin → Businesses → Choose bundle B** se banta hai. Hub brand ko yahan suspend karoge toh agle hub update tak hi suspend rahega. Client ko pakka band karna ho toh Loopdesk admin me bundle khatam karo.

## Bundle rules (guide 06, Nov 2026)
Har tool sirf apna kaam karta hai. Hub se bane brand (`hub_business_id` wala) pe ye lagta hai; haath se bane purane/demo brand pehle jaise chalte hain.

| Rule | Loyvexa me kya hota hai |
| --- | --- |
| Calling sirf WayneRing se, aur sirf jab package me ho | Provision me `tools` aata hai (jaise `["LOYVEXA","WAYNERING"]`) → `settings.hub.tools`. WAYNERING nahi → AI calls page chhupta hai, call API 403, AI Manager win-back call nahi banata, queued calls SKIPPED. `tools` aaya hi nahi → calls band (hub brand). |
| WhatsApp / SMS sirf Regulars ke number se | `REGULARS_API_URL` set ho toh bot ke jawab, OTP, campaigns, AI messages sab Regulars se jaate hain (neeche contract). WhatsApp page pe number ka form nahi dikhta, "Regulars → Settings" likha aata hai. |
| Reorder nudge → Regulars, payment reminder → Korvo + Regulars | AI Manager ab ye dono nahi banata. Purane waiting wale `006_bundle_rules.sql` band kar deta hai. |
| Korvo tiles sirf Korvo link pe | Dashboard strip pe Korvo orders / overdue / recovered sirf jab Korvo linked ho. |

### Regulars side pe kya banana hai (alag PR, regularsplatform)
1. **Provision me `tools` bhejo**: `lib/hub/provision.ts` ki body me `tools: businessTools(biz)` (plus Korvo/WayneRing jo bhi package me ho).
2. **Send endpoint**: `POST /api/hub/tools/loyvexa/whatsapp/send`. Header `Authorization: Bearer <JWT>`: HS256, secret = `HUB_SECRET_LOYVEXA`, `iss "loyvexa"`, `aud "regulars-hub"`, `sub` = business id, `purpose "whatsapp-send"`, `jti`, 2 min. Body `{ to, message }` jahan `message` WhatsApp Cloud API ka payload hai (`type: "text"` ya `type: "template"`). Template naam Loyvexa `loyvexa_<event>` bhejta hai (jaise `loyvexa_otp`, `loyvexa_ai_slab`, `loyvexa_redemption_paid`) — ye templates Regulars ke Meta account me approve karne hain. STOP list Regulars ki. Jawab `{ messageId }`.
3. **Inbound forward**: client ke number pe aaya message jo Loyvexa ka ho (dealer/mechanic: points, scheme, order, cash-out) → `POST {LOYVEXA_API_URL}/api/hub/whatsapp/inbound`, hub token `purpose "whatsapp-inbound"`, body `{ messages: [{ from, text, id }], statuses: [{ id, status, error }] }`.
4. **Opt-in / opt-out sync (testing report 2 #1)**: `POST /api/hub/tools/loyvexa/whatsapp/opt-in`, same JWT with `purpose "whatsapp-opt-in"`, body `{ to: "9198…", optIn: true | false }` → `{ ok: true }`. Loyvexa isse START/YES pe (aur admin ke "Unblock WhatsApp" button pe) reply bhejne se **pehle** call karta hai, taaki Regulars ki STOP list se number hat jaaye. Iske bina reply "This person sent STOP" se FAIL hota rahega. Saath hi Regulars khud bhi inbound "START" dekh ke apni STOP list clear kare.
5. **Templates list**: `GET /api/hub/tools/loyvexa/whatsapp/templates` (purpose `whatsapp-templates`) → `{ templates: [{ name, language, category, body, status }] }`. Campaign me sirf `status: "APPROVED"` waale chunne milte hain. Ye endpoint na ho toh Loyvexa koi template select nahi hone deta (pehle bina-check `loyvexa_*` naam dikhata tha).

Loyvexa `.env`: `REGULARS_API_URL=https://regulars.wayneesolutions.com` (khaali = purana tareeka, brand ka apna number).
