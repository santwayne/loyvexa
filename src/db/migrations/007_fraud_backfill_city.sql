-- Testing report #1: reused / cancelled codes checked on the public page in the last 30 days
-- were counted on the dashboard but never flagged. Raise one open flag per code now.
INSERT INTO fraud_flags (tenant_id, participant_id, rule, details)
SELECT v.tenant_id, NULL,
       CASE WHEN v.result = 'VOID' THEN 'VOID_CODE_CHECKED' ELSE 'REUSED_CODE_CHECKED' END,
       jsonb_build_object('key', v.code, 'code', v.code, 'timesChecked', count(*), 'lastIp', max(v.ip), 'backfilled', true)
  FROM verify_checks v
 WHERE v.tenant_id IS NOT NULL AND v.result IN ('ALREADY_SCANNED', 'VOID') AND v.created_at > now() - interval '30 days'
   AND NOT EXISTS (SELECT 1 FROM fraud_flags f WHERE f.tenant_id = v.tenant_id AND f.status = 'OPEN' AND f.details->>'key' = v.code)
 GROUP BY v.tenant_id, v.code, v.result;

-- Testing report #6: "Ludhiana " / "ludhiana" were stored as different cities. Tidy existing rows.
UPDATE participants SET city = NULLIF(initcap(regexp_replace(btrim(city), '\s+', ' ', 'g')), '') WHERE city IS NOT NULL AND city <> NULLIF(initcap(regexp_replace(btrim(city), '\s+', ' ', 'g')), '');
CREATE INDEX IF NOT EXISTS participants_city_idx ON participants (tenant_id, lower(city));

-- Every city write is tidied the same way from now on (app sign-up, console, invoice import).
CREATE OR REPLACE FUNCTION participants_tidy_city() RETURNS trigger AS $$
BEGIN
  NEW.city := NULLIF(initcap(regexp_replace(btrim(coalesce(NEW.city, '')), '\s+', ' ', 'g')), '');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS participants_tidy_city_trg ON participants;
CREATE TRIGGER participants_tidy_city_trg BEFORE INSERT OR UPDATE OF city ON participants
  FOR EACH ROW EXECUTE FUNCTION participants_tidy_city();

-- Testing report #4: a campaign with nobody to call says WHY instead of showing "COMPLETED 0/0".
ALTER TABLE call_campaigns ADD COLUMN IF NOT EXISTS note text;

-- Testing report #4 (root cause): a new participant had segment NULL until the hourly worker ran,
-- so "NEW" campaigns matched nobody. Someone who just joined is NEW by definition.
CREATE OR REPLACE FUNCTION participants_default_segment() RETURNS trigger AS $$
BEGIN
  IF NEW.segment IS NULL THEN NEW.segment := 'NEW'; NEW.segment_changed_at := now(); END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS participants_default_segment_trg ON participants;
CREATE TRIGGER participants_default_segment_trg BEFORE INSERT ON participants
  FOR EACH ROW EXECUTE FUNCTION participants_default_segment();

-- Keep the segment history and the event stream complete for that first NEW.
CREATE OR REPLACE FUNCTION participants_log_first_segment() RETURNS trigger AS $$
BEGIN
  IF NEW.segment IS NOT NULL THEN
    INSERT INTO participant_segments (tenant_id, participant_id, segment, previous, computed_at)
      VALUES (NEW.tenant_id, NEW.id, NEW.segment, NULL, coalesce(NEW.segment_changed_at, now()));
    INSERT INTO events (tenant_id, type, payload)
      VALUES (NEW.tenant_id, 'segment.changed', jsonb_build_object('participantId', NEW.id, 'from', NULL, 'to', NEW.segment));
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS participants_log_first_segment_trg ON participants;
CREATE TRIGGER participants_log_first_segment_trg AFTER INSERT ON participants
  FOR EACH ROW EXECUTE FUNCTION participants_log_first_segment();

-- Participants who joined before this release and were never scored: run the normal
-- recompute (worker or Segments → Recompute) — audience() also does it before any NEW/REGULAR filter.
