-- Regulars hub auto-connect (Nov 2026)
-- A brand created by the hub remembers which Regulars business it belongs to,
-- so every later set-up / pause / single sign-on finds the same brand.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS hub_business_id text UNIQUE;

-- Hub tokens are single use: each jti is recorded once (old rows are pruned).
CREATE TABLE IF NOT EXISTS hub_token_uses (
  jti      text PRIMARY KEY,
  purpose  text NOT NULL,
  used_at  timestamptz NOT NULL DEFAULT now()
);
