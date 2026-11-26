-- Testing report 2 (26 Nov 2026)

-- #5: a campaign where every message failed is FAILED, not COMPLETED, and each failure keeps its reason.
ALTER TABLE wa_campaigns DROP CONSTRAINT IF EXISTS wa_campaigns_status_check;
ALTER TABLE wa_campaigns ADD CONSTRAINT wa_campaigns_status_check CHECK (status IN ('DRAFT','RUNNING','COMPLETED','FAILED','CANCELLED'));
ALTER TABLE wa_campaigns ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE wa_campaign_recipients ADD COLUMN IF NOT EXISTS error text;
UPDATE wa_campaign_recipients r SET error = m.error FROM messages m WHERE m.id = r.message_id AND r.status = 'FAILED' AND r.error IS NULL;
UPDATE wa_campaigns w SET status = 'FAILED',
       note = 'All messages failed: ' || coalesce((SELECT r.error FROM wa_campaign_recipients r WHERE r.campaign_id = w.id AND r.error IS NOT NULL LIMIT 1), 'see the reasons per person')
 WHERE w.status = 'COMPLETED'
   AND EXISTS (SELECT 1 FROM wa_campaign_recipients r WHERE r.campaign_id = w.id AND r.status = 'FAILED')
   AND NOT EXISTS (SELECT 1 FROM wa_campaign_recipients r WHERE r.campaign_id = w.id AND r.status IN ('SENT','DELIVERED','READ'));

ALTER TABLE call_campaigns DROP CONSTRAINT IF EXISTS call_campaigns_status_check;
ALTER TABLE call_campaigns ADD CONSTRAINT call_campaigns_status_check CHECK (status IN ('DRAFT','RUNNING','COMPLETED','FAILED','CANCELLED'));

-- #2 / #3: a simulated call (CALL_PROVIDER=mock) is marked as test, never shown as a real "Wrong number".
ALTER TABLE calls ADD COLUMN IF NOT EXISTS test_mode boolean NOT NULL DEFAULT false;
UPDATE calls SET test_mode = true WHERE provider_call_id LIKE 'MOCKCALL-%';
UPDATE calls SET outcome = NULL, summary = 'TEST MODE — no real call was placed (CALL_PROVIDER=mock on the server)'
 WHERE test_mode AND (summary LIKE 'Mock call:%' OR summary LIKE 'Simulated call%');
