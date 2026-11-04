-- Loyvexa Phase 1 schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  brand_color   text DEFAULT '#E85D04',
  logo_url      text,
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants(id) ON DELETE CASCADE, -- NULL = platform super admin
  name           text NOT NULL,
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('SUPER_ADMIN','TENANT_ADMIN','TENANT_STAFF')),
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE participants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('DEALER','DISTRIBUTOR','RETAILER','MECHANIC','ELECTRICIAN','PLUMBER','CONTRACTOR','PAINTER','CARPENTER','OTHER')),
  name          text,
  mobile        text NOT NULL,
  city          text,
  state         text,
  pincode       text,
  upi_id        text,
  upi_name      text,
  language      text NOT NULL DEFAULT 'hi',
  parent_id     uuid REFERENCES participants(id), -- e.g. mechanic's dealer
  external_ref  text,                             -- id in Royal / Tally / other DMS
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED')),
  scan_blocked_until timestamptz,
  last_scan_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mobile)
);
CREATE INDEX participants_tenant_type_idx ON participants (tenant_id, type);
CREATE INDEX participants_external_ref_idx ON participants (tenant_id, external_ref);

CREATE TABLE otp_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mobile      text NOT NULL,
  code_hash   text NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_lookup_idx ON otp_codes (tenant_id, mobile, created_at DESC);

CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku             text NOT NULL,
  name            text NOT NULL,
  category        text,
  mrp_paise       int,
  points          int NOT NULL DEFAULT 0 CHECK (points >= 0),   -- default points per scan
  points_by_type  jsonb NOT NULL DEFAULT '{}'::jsonb,           -- e.g. {"RETAILER": 5, "MECHANIC": 20}
  active          boolean NOT NULL DEFAULT true,
  external_ref    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

CREATE TABLE qr_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id),
  label       text,
  quantity    int NOT NULL CHECK (quantity > 0),
  mfg_date    date,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','VOID')),
  created_by  uuid REFERENCES admin_users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE qr_codes (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id      uuid NOT NULL REFERENCES qr_batches(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products(id),
  code          text NOT NULL UNIQUE,
  serial_no     int NOT NULL,
  status        text NOT NULL DEFAULT 'UNUSED' CHECK (status IN ('UNUSED','SCANNED','VOID')),
  scanned_by    uuid REFERENCES participants(id),
  scanned_at    timestamptz,
  scan_lat      double precision,
  scan_lng      double precision,
  verify_count  int NOT NULL DEFAULT 0,
  UNIQUE (batch_id, serial_no)
);
CREATE INDEX qr_codes_batch_idx ON qr_codes (batch_id);
CREATE INDEX qr_codes_scanned_by_idx ON qr_codes (scanned_by);

-- One wallet per participant. balance = spendable, held = locked in pending redemptions.
CREATE TABLE wallets (
  participant_id     uuid PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  balance            bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  held               bigint NOT NULL DEFAULT 0 CHECK (held >= 0),
  lifetime_earned    bigint NOT NULL DEFAULT 0,
  lifetime_redeemed  bigint NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Append-only points ledger. Every change to wallets.balance has exactly one row here.
CREATE TABLE ledger_entries (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('EARN_SCAN','REDEEM_HOLD','REDEEM_RELEASE','ADJUST_CREDIT','ADJUST_DEBIT','BONUS','EXPIRE')),
  points          bigint NOT NULL,            -- signed: + credit, - debit
  balance_after   bigint NOT NULL,
  ref_type        text,
  ref_id          text,
  note            text,
  created_by      uuid,                       -- admin user id when manual
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, ref_type, ref_id)             -- idempotency guard
);
CREATE INDEX ledger_participant_idx ON ledger_entries (participant_id, id DESC);
CREATE INDEX ledger_tenant_time_idx ON ledger_entries (tenant_id, created_at);

CREATE TABLE redemptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  points          bigint NOT NULL CHECK (points > 0),
  amount_paise    bigint NOT NULL CHECK (amount_paise > 0),
  upi_id          text NOT NULL,
  status          text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','PROCESSING','PAID','FAILED','REJECTED')),
  provider        text,
  provider_ref    text,
  failure_reason  text,
  approved_by     uuid REFERENCES admin_users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX redemptions_tenant_status_idx ON redemptions (tenant_id, status, created_at);

CREATE TABLE scan_attempts (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid REFERENCES tenants(id) ON DELETE CASCADE,
  participant_id  uuid REFERENCES participants(id) ON DELETE CASCADE,
  code            text,
  result          text NOT NULL,  -- SUCCESS, INVALID, ALREADY_SCANNED, VOID, LIMIT, BLOCKED, WRONG_BRAND, INACTIVE_PRODUCT
  lat             double precision,
  lng             double precision,
  device_id       text,
  ip              text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scan_attempts_participant_idx ON scan_attempts (participant_id, created_at DESC);
CREATE INDEX scan_attempts_device_idx ON scan_attempts (device_id, created_at DESC);

-- Public authenticity checks (anyone with a phone camera)
CREATE TABLE verify_checks (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE,
  code       text NOT NULL,
  result     text NOT NULL,   -- GENUINE, ALREADY_SCANNED, VOID, NOT_FOUND
  ip         text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verify_checks_tenant_idx ON verify_checks (tenant_id, created_at);

CREATE TABLE fraud_flags (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  participant_id  uuid REFERENCES participants(id) ON DELETE CASCADE,
  rule            text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolved_by     uuid REFERENCES admin_users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fraud_flags_tenant_status_idx ON fraud_flags (tenant_id, status);

-- Outbox for Phase 2/3 consumers (WhatsApp bot, WayneRing calls, Royal sync)
CREATE TABLE events (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_undelivered_idx ON events (id) WHERE delivered_at IS NULL;
