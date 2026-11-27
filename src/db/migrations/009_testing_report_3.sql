-- Testing report 3 (27 Nov 2026)

-- #1: keep what WayneRing really said about each call, so "NO ANSWER" is never shown for a call
--     that was never dialled. provider_status = WayneRing's own status / ended reason,
--     provider_detail = the last webhook body (for debugging), dial_failed = WayneRing never rang the phone.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_status text;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_detail jsonb;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS dial_failed boolean NOT NULL DEFAULT false;

-- #6: a simulated call (CALL_PROVIDER=mock) is TEST, never COMPLETED — same for its campaign.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_status_check CHECK (status IN ('QUEUED','DIALING','COMPLETED','FAILED','SKIPPED','TEST'));
ALTER TABLE call_campaigns DROP CONSTRAINT IF EXISTS call_campaigns_status_check;
ALTER TABLE call_campaigns ADD CONSTRAINT call_campaigns_status_check CHECK (status IN ('DRAFT','RUNNING','COMPLETED','FAILED','CANCELLED','TEST'));

UPDATE calls SET status = 'TEST' WHERE test_mode AND status = 'COMPLETED';
UPDATE call_campaigns c SET status = 'TEST', note = 'TEST MODE — no real calls were placed (CALL_PROVIDER=mock)'
 WHERE c.status = 'COMPLETED'
   AND EXISTS (SELECT 1 FROM calls k WHERE k.campaign_id = c.id AND k.status = 'TEST')
   AND NOT EXISTS (SELECT 1 FROM calls k WHERE k.campaign_id = c.id AND k.status IN ('COMPLETED','FAILED'));
