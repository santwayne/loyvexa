-- Loyvexa Phase 3: segmentation, AI call campaigns, WhatsApp ordering, WhatsApp campaigns, points expiry

ALTER TABLE participants ADD COLUMN IF NOT EXISTS segment text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS segment_changed_at timestamptz;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS last_purchase_at timestamptz;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS dnd boolean NOT NULL DEFAULT false;              -- no AI calls
ALTER TABLE participants ADD COLUMN IF NOT EXISTS wa_opt_out boolean NOT NULL DEFAULT false;       -- no WhatsApp campaigns
ALTER TABLE participants ADD COLUMN IF NOT EXISTS expiry_reminded_at timestamptz;
CREATE INDEX IF NOT EXISTS participants_segment_idx ON participants (tenant_id, segment);

ALTER TABLE products ADD COLUMN IF NOT EXISTS price_paise bigint;   -- dealer price for WhatsApp ordering

-- ---------- Segmentation history ----------
CREATE TABLE participant_segments (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  segment         text NOT NULL CHECK (segment IN ('NEW','REGULAR','AT_RISK','DORMANT','HIGH_SPENDER')),
  previous        text,
  computed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX participant_segments_p_idx ON participant_segments (participant_id, id DESC);

-- ---------- AI call campaigns (WayneRing) ----------
CREATE TABLE call_campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  script           text NOT NULL CHECK (script IN ('WINBACK','SCHEME_REMINDER','FEEDBACK')),
  language         text NOT NULL DEFAULT 'hi' CHECK (language IN ('hi','pa','en')),
  segments         text[] NOT NULL DEFAULT '{}',
  participant_types text[] NOT NULL DEFAULT '{}',
  city             text,
  scheme_id        uuid REFERENCES schemes(id),
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','RUNNING','COMPLETED','CANCELLED')),
  provider         text NOT NULL DEFAULT 'mock',
  created_by       uuid REFERENCES admin_users(id),
  launched_at      timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id      uuid NOT NULL REFERENCES call_campaigns(id) ON DELETE CASCADE,
  participant_id   uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','DIALING','COMPLETED','FAILED','SKIPPED')),
  outcome          text CHECK (outcome IN ('INTERESTED','NOT_INTERESTED','NO_ANSWER','WRONG_NUMBER','CALL_LATER','DO_NOT_CALL')),
  summary          text,
  context          jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_call_id text,
  attempted_at     timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, participant_id)
);
CREATE INDEX calls_status_idx ON calls (status, created_at);
CREATE INDEX calls_participant_idx ON calls (participant_id, created_at DESC);
CREATE UNIQUE INDEX calls_provider_id_uq ON calls (provider_call_id) WHERE provider_call_id IS NOT NULL;

-- ---------- Orders (WhatsApp → DMS) ----------
CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  participant_id   uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  order_no         text NOT NULL,
  channel          text NOT NULL DEFAULT 'WHATSAPP',
  status           text NOT NULL DEFAULT 'CART' CHECK (status IN ('CART','PLACED','SENT_TO_DMS','FAILED','CANCELLED')),
  items            jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{productId, sku, name, qty, pricePaise}]
  total_paise      bigint NOT NULL DEFAULT 0,
  dms              text,
  dms_order_ref    text,
  error            text,
  attempts         int NOT NULL DEFAULT 0,
  placed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_no)
);
CREATE UNIQUE INDEX orders_one_open_cart ON orders (participant_id) WHERE status = 'CART';
CREATE INDEX orders_tenant_status_idx ON orders (tenant_id, status, created_at DESC);

-- ---------- WhatsApp campaigns ----------
CREATE TABLE wa_campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  template_name    text NOT NULL,
  language         text NOT NULL DEFAULT 'en',
  params           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- strings with {name} {balance} {brand} {scheme_progress}
  preview_text     text,
  segments         text[] NOT NULL DEFAULT '{}',
  participant_types text[] NOT NULL DEFAULT '{}',
  scheme_id        uuid REFERENCES schemes(id),
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','RUNNING','COMPLETED','CANCELLED')),
  created_by       uuid REFERENCES admin_users(id),
  launched_at      timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wa_campaign_recipients (
  campaign_id      uuid NOT NULL REFERENCES wa_campaigns(id) ON DELETE CASCADE,
  participant_id   uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','SKIPPED')),
  message_id       bigint REFERENCES messages(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, participant_id)
);
CREATE INDEX wa_recipients_status_idx ON wa_campaign_recipients (status);

-- outgoing messages: let status webhooks find them
CREATE INDEX IF NOT EXISTS messages_out_provider_idx ON messages (provider_msg_id) WHERE direction = 'OUT' AND provider_msg_id IS NOT NULL;
