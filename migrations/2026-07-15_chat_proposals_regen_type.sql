-- Adds 'regenerate_goal_roadmap' to chat_proposals.type's allowed values.
-- Discovered live (2026-07-15) while verifying the roadmap-regen auto-offer
-- feature: the original migrations/2026-07-15_chat_proposals.sql's CHECK
-- constraint only permitted ('update_goal', 'set_focus_override',
-- 'log_checkin_note') — every insert of the new type failed with a 23514
-- check-constraint violation until this runs. Run manually in the Supabase
-- SQL editor, same as the other Coach Chat migrations.
--
-- Postgres has no ALTER CHECK — drop the auto-named constraint
-- (chat_proposals_type_check, the default name for an unnamed CHECK on the
-- "type" column of "chat_proposals") and recreate it with the new value.

ALTER TABLE chat_proposals DROP CONSTRAINT IF EXISTS chat_proposals_type_check;
ALTER TABLE chat_proposals ADD CONSTRAINT chat_proposals_type_check
  CHECK (type IN ('update_goal', 'set_focus_override', 'log_checkin_note', 'regenerate_goal_roadmap'));

-- RLS + service_role_bypass already exist on this table (asserted here
-- idempotently, matching the convention used across every migration in this
-- project) — this migration only touches the CHECK constraint, not RLS.
ALTER TABLE chat_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_bypass ON chat_proposals;
CREATE POLICY service_role_bypass ON chat_proposals
  FOR ALL TO service_role USING (true) WITH CHECK (true);
