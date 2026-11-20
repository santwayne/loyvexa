-- Bundle rules (Nov 2026, guide 06): the AI Manager keeps only loyalty work.
-- Reorder nudges move to Regulars, payment reminders to Korvo (sent by Regulars).
-- Any still waiting are closed so they never go out from Loyvexa.
UPDATE ai_actions SET status='EXPIRED', error='Moved out of Loyvexa (bundle rule)', updated_at=now()
 WHERE type IN ('REORDER_NUDGE','PAYMENT_REMINDER') AND status IN ('PROPOSED','APPROVED');
