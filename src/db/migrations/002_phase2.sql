-- Loyvexa Phase 2: schemes, accounting/DMS connectors, purchase-based earning, WhatsApp

-- Purchase reversals (credit notes after a payout) may take a wallet below zero;
-- future earnings net it off. Redemption still requires a positive balance.
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_balance_check;

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_type_check CHECK (type IN (
  'EARN_SCAN','REDEEM_HOLD','REDEEM_RELEASE','ADJUST_CREDIT','ADJUST_DEBIT','BONUS','EXPIRE',
  'PURCHASE_EARN','PURCHASE_REVERSAL','SCHEME_BONUS'));

ALTER TABLE participants ADD COLUMN IF NOT EXISTS gstin text;
CREATE INDEX IF NOT EXISTS participants_gstin_idx ON participants (tenant_id, upper(gstin));

ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_points_per_unit numeric(12,3); -- overrides amount-based purchase rate

-- ---------- Connectors (Tally, Zoho Books, Busy, Marg, Royal, CSV, any REST) ----------
CREATE TABLE connectors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type           text NOT NULL CHECK (type IN ('GENERIC','TALLY','ZOHO_BOOKS','BUSY','MARG','ROYAL','CSV')),
  name           text NOT NULL,
  api_key_hash   text NOT NULL UNIQUE,
  api_key_prefix text NOT NULL,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  last_received_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id    uuid REFERENCES connectors(id) ON DELETE SET NULL,
  source          text NOT NULL,              -- connector type, e.g. TALLY
  external_id     text NOT NULL,              -- voucher/invoice number or GUID in the source system
  doc_type        text NOT NULL CHECK (doc_type IN ('INVOICE','CREDIT_NOTE')),
  against_external_id text,                   -- credit note -> original invoice (optional)
  invoice_date    date NOT NULL,
  party_ref       text,
  party_gstin     text,
  party_mobile    text,
  party_name      text,
  participant_id  uuid REFERENCES participants(id),
  total_paise     bigint NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'UNMATCHED' CHECK (status IN ('UNMATCHED','PROCESSED','IGNORED')),
  base_points     bigint NOT NULL DEFAULT 0,
  raw             jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  UNIQUE (tenant_id, connector_id, external_id, doc_type)
);
CREATE INDEX invoices_participant_date_idx ON invoices (participant_id, invoice_date);
CREATE INDEX invoices_tenant_status_idx ON invoices (tenant_id, status, created_at DESC);

CREATE TABLE invoice_lines (
  id            bigserial PRIMARY KEY,
  invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  sku           text,
  item_name     text,
  product_id    uuid REFERENCES products(id),
  qty           numeric(14,3) NOT NULL DEFAULT 0,
  amount_paise  bigint NOT NULL DEFAULT 0     -- taxable value, before GST
);
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id);

-- ---------- Schemes ----------
-- PURCHASE_SLAB: dealer buys ₹X / Y units in the period -> slab reward at settlement
-- SCAN_TARGET:   mechanic scans N eligible codes in the period -> slab reward at settlement
-- SCAN_MULTIPLIER: extra points on every eligible scan during the period (instant)
CREATE TABLE schemes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,
  type             text NOT NULL CHECK (type IN ('PURCHASE_SLAB','SCAN_TARGET','SCAN_MULTIPLIER')),
  metric           text NOT NULL CHECK (metric IN ('AMOUNT','QUANTITY','SCANS')),
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','SETTLED','CANCELLED')),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  settle_grace_days int NOT NULL DEFAULT 3,   -- wait for late invoices before auto-settling
  eligible_types   text[] NOT NULL DEFAULT '{}', -- empty = all participant types
  product_ids      uuid[] NOT NULL DEFAULT '{}', -- empty = all products
  slabs            jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ "min": 100000, "rewardType": "FIXED_POINTS"|"PERCENT", "value": 500, "label": "Silver" }]
  multiplier       numeric(6,2),                 -- SCAN_MULTIPLIER: 2 = double points
  created_by       uuid REFERENCES admin_users(id),
  settled_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX schemes_tenant_status_idx ON schemes (tenant_id, status, ends_at);

CREATE TABLE scheme_results (
  scheme_id       uuid NOT NULL REFERENCES schemes(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  metric_value    numeric(18,3) NOT NULL,
  slab_index      int,
  points          bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scheme_id, participant_id)
);

-- ---------- Messaging channels (WhatsApp Cloud API; per-brand number) ----------
CREATE TABLE tenant_channels (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel          text NOT NULL CHECK (channel IN ('WHATSAPP')),
  phone_number_id  text NOT NULL UNIQUE,
  display_number   text,
  access_token_enc text,                 -- AES-256-GCM, see lib/crypto.js
  config           jsonb NOT NULL DEFAULT '{}'::jsonb, -- { otpTemplate, language }
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel)
);

CREATE TABLE messages (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid REFERENCES tenants(id) ON DELETE CASCADE,
  participant_id  uuid REFERENCES participants(id) ON DELETE SET NULL,
  channel         text NOT NULL DEFAULT 'WHATSAPP',
  direction       text NOT NULL CHECK (direction IN ('IN','OUT')),
  provider_msg_id text,
  peer            text NOT NULL,          -- the participant's number
  body            text,
  payload         jsonb,
  status          text NOT NULL DEFAULT 'RECEIVED', -- RECEIVED | SENT | MOCK | FAILED
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_provider_id_uq ON messages (channel, provider_msg_id) WHERE provider_msg_id IS NOT NULL AND direction = 'IN';
CREATE INDEX messages_tenant_time_idx ON messages (tenant_id, created_at DESC);

ALTER TABLE events ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN IF NOT EXISTS last_error text;
