-- ============================================================================
-- ENGINE v2 · PHASE 7 · chat_proposals.type — add the v2 session proposal types
-- ============================================================================
-- WHAT THIS DOES
--   Extends chat_proposals.type's CHECK constraint with the three new v2
--   Coach Chat proposal types:
--     modify_planned_session  — swap an exercise / adjust volume-intensity /
--                               change a MOVABLE future session's category
--     skip_planned_session    — mark a future session skipped or rescheduled
--     set_standing_preference — record a standing preference the athlete states
--                               in chat (e.g. "never legs on Mondays")
--
-- STATUS: **NOT RUN.** Written by Claude Code, executed manually by Shimmy in
--   the Supabase SQL editor. Never assume it has been run.
--
-- PREREQUISITES
--   The existing chat_proposals table with its current CHECK
--   (update_goal | set_focus_override | log_checkin_note | regenerate_goal_roadmap).
--   Run BEFORE using the v2 session tools — an insert of a new type fails with a
--   23514 check-constraint violation until this runs (exactly the failure mode
--   the 2026-07-15 regen_type migration hit and documented).
--
-- CODE RESILIENCE
--   The v2 tools are only offered to a flagged profile (buildCoachChatTools),
--   so a v1 profile can never generate one of these proposals. On a flagged
--   profile before this migration runs, a proposal insert fails and the chat
--   send degrades to a plain reply (the tool result reports the failure) — it
--   never writes and never 500s the whole message.
--
-- Postgres has no ALTER CHECK — drop the auto-named constraint and recreate it.
-- ============================================================================

ALTER TABLE chat_proposals DROP CONSTRAINT IF EXISTS chat_proposals_type_check;
ALTER TABLE chat_proposals ADD CONSTRAINT chat_proposals_type_check
  CHECK (type IN (
    'update_goal',
    'set_focus_override',
    'log_checkin_note',
    'regenerate_goal_roadmap',
    'modify_planned_session',
    'skip_planned_session',
    'set_standing_preference'
  ));

-- RLS + service_role_bypass already exist; asserted idempotently per convention.
ALTER TABLE chat_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_bypass ON chat_proposals;
CREATE POLICY service_role_bypass ON chat_proposals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Post-run check (read-only) ──────────────────────────────────────────────
SELECT pg_get_constraintdef(oid) AS type_check
FROM pg_constraint
WHERE conrelid = 'public.chat_proposals'::regclass
  AND conname = 'chat_proposals_type_check';
-- Must list all 7 values.
