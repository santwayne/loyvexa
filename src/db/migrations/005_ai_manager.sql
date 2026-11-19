-- Loyvexa Phase 4 (Bundle B): AI Channel Manager, Korvo outstanding feed, Korvo link

-- ---------- What each dealer owes (pushed nightly by Korvo / Tally) ----------
CREATE TABLE dealer_outstanding (
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_ref      text NOT NULL,                       -- dealer id in Korvo / Tally
  participant_id    uuid REFERENCES participants(id) ON DELETE SET NULL,
  name              text,
  mobile            text,
  outstanding_paise bigint NOT NULL DEFAULT 0,
  overdue_paise     bigint NOT NULL DEFAULT 0,
  oldest_due_date   date,
  days_overdue      int NOT NULL DEFAULT 0,
  as_of             timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, external_ref)
);
CREATE INDEX dealer_outstanding_participant_idx ON dealer_outstanding (participant_id);

-- History, so the AI can see a payment come in after a reminder.
CREATE TABLE dealer_outstanding_history (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  participant_id    uuid REFERENCES participants(id) ON DELETE CASCADE,
  external_ref      text NOT NULL,
  overdue_paise     bigint NOT NULL,
  outstanding_paise bigint NOT NULL,
  as_of             timestamptz NOT NULL
);
CREATE INDEX dealer_outstanding_history_p_idx ON dealer_outstanding_history (participant_id, as_of DESC);

-- ---------- AI Channel Manager ----------
CREATE TABLE ai_actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  participant_id   uuid REFERENCES participants(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('REORDER_NUDGE','SLAB_PUSH','WINBACK_CALL','MECHANIC_NUDGE','PAYMENT_REMINDER','FRAUD_REVIEW','SCHEME_IDEA')),
  status           text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','APPROVED','EXECUTING','DONE','SKIPPED','FAILED','EXPIRED')),
  autonomy         text NOT NULL DEFAULT 'APPROVE' CHECK (autonomy IN ('SUGGEST','APPROVE','AUTO')),
  title            text NOT NULL,
  reason           text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- message text, basket, scheme draft…
  expected_paise   bigint NOT NULL DEFAULT 0,             -- what the AI thinks it is worth
  priority         real NOT NULL DEFAULT 0,               -- expected value x learned win rate
  plan_date        date NOT NULL,
  dedupe_key       text NOT NULL,
  brief_date       date,
  brief_item       int,
  decided_by       text,                                  -- 'whatsapp:<mobile>' | 'console:<admin id>' | 'auto'
  result           jsonb,
  error            text,
  executed_at      timestamptz,
  outcome          text CHECK (outcome IN ('WON','NONE')),
  outcome_paise    bigint,
  outcome_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX ai_actions_tenant_status_idx ON ai_actions (tenant_id, status, priority DESC);
CREATE INDEX ai_actions_participant_idx ON ai_actions (participant_id, executed_at DESC);
CREATE INDEX ai_actions_brief_idx ON ai_actions (tenant_id, brief_date, brief_item);

CREATE TABLE ai_state (
  tenant_id         uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last_plan_date    date,
  last_report_week  text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Dealer win-back calls from the AI use their own script.
ALTER TABLE call_campaigns DROP CONSTRAINT IF EXISTS call_campaigns_script_check;
ALTER TABLE call_campaigns ADD CONSTRAINT call_campaigns_script_check CHECK (script IN ('WINBACK','SCHEME_REMINDER','FEEDBACK','DEALER_WINBACK'));
ALTER TABLE call_campaigns ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'console';   -- console | ai

-- WhatsApp orders the AI started (reorder nudge → cart).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ai_action_id uuid REFERENCES ai_actions(id) ON DELETE SET NULL;

-- ---------- Korvo link (Bundle B one platform) ----------
-- Per-brand Korvo company + the key Loyvexa uses to push WhatsApp orders to it
-- (AES-256-GCM, like WhatsApp tokens). Falls back to KORVO_BASE_URL / KORVO_API_KEY.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS korvo jsonb NOT NULL DEFAULT '{}'::jsonb;  -- {companyCode, companyId, baseUrl, apiKeyEnc, linkedAt}
