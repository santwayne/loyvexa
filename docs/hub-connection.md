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
Console me super admin ko **Brands** dikhta hai: saare brands, kaun hub se bana, participants/scans, Open, Suspend/Activate. Naya brand banane ka form jaan-boojh ke nahi hai, kyunki brand Regulars se hi banne chahiye. Hub brand ko yahan suspend karoge toh agle hub update tak hi suspend rahega. Client ko pakka band karna ho toh Regulars me bundle khatam karo.
