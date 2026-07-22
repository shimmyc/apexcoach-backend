-- ============================================================================
-- CLONE PROFILE 1 -> PROFILE 4  ·  STEP 1 of 3: WIPE
-- ============================================================================
-- WHAT THIS DOES
--   Clears ALL cloneable profile-scoped data belonging to profile 4 so the
--   copy script (step 2) can run into a clean target. Profile 4 is the
--   designated Engine v2 test profile ("Test #3").
--
-- STATUS: **NOT RUN.** Written by Claude Code, executed manually by Shimmy in
--   the Supabase SQL editor. Never assume it has been run.
--
-- PREREQUISITES
--   * Run the read-only baseline query (see the verification file) FIRST and
--     keep the output — it is the evidence that profile 1 is unchanged after.
--   * Run this file in full, in order, before 2026-07-22_clone_p1_to_p4_copy.sql.
--
-- SAFETY CONTRACT
--   * EVERY statement is explicitly scoped `WHERE profile_id = 4`.
--   * There is no unqualified DELETE anywhere in this file.
--   * There is no `profile_id <> 1` anywhere in this file.
--   * Nothing here reads or writes profile 1.
--   * Re-runnable: deleting already-deleted rows is a no-op.
--
-- DELIBERATELY NOT TOUCHED (see the Phase 1 audit, SKIP bucket)
--   * wearable_connections        — profile 4 has none today; if it ever gains
--                                   one, wiping it would silently disconnect a
--                                   live sync. Not this script's business.
--   * exercise_catalog, tokens    — global / legacy, not profile-scoped.
--   * profiles.pin / name /
--     avatar_color                — profile 4 keeps its own identity.
--   * chat_threads / chat_messages /
--     chat_proposals              — optional section at the bottom, commented
--                                   out by default. The copy script never
--                                   writes chat, so wiping it is not required
--                                   for idempotency.
-- ============================================================================


-- ── 1. Children before parents ──────────────────────────────────────────────
-- rejected_wearable_matches references workouts.id, so it goes first even
-- though the copy script never repopulates it.
DELETE FROM rejected_wearable_matches WHERE profile_id = 4;

-- exercises.workout_id -> workouts.id is ON DELETE CASCADE, so deleting
-- workouts would take most of these with it. Deleted explicitly anyway,
-- because extract-exercises can insert rows with workout_id IS NULL and a
-- cascade from workouts can never reach those.
DELETE FROM exercises WHERE profile_id = 4;

DELETE FROM workouts WHERE profile_id = 4;


-- ── 2. Independent profile-scoped tables ────────────────────────────────────
DELETE FROM daily_sleep       WHERE profile_id = 4;
DELETE FROM daily_steps       WHERE profile_id = 4;
DELETE FROM body_metrics      WHERE profile_id = 4;
DELETE FROM daily_checkins    WHERE profile_id = 4;
DELETE FROM micro_goals       WHERE profile_id = 4;
DELETE FROM workout_templates WHERE profile_id = 4;


-- ── 3. Profile-row caches ───────────────────────────────────────────────────
-- Cleared here as well as in the flags file so that a wipe on its own always
-- leaves profile 4 in a coherent state (no rec cache pointing at deleted
-- workouts). Both are idempotent.
UPDATE profiles
SET daily_recommendations           = NULL,
    daily_recommendations_date      = NULL,
    daily_recommendations_readiness = NULL,
    progress_brief                  = NULL,
    progress_brief_date             = NULL
WHERE id = 4;


-- ── 4. OPTIONAL — Coach Chat history for profile 4 ──────────────────────────
-- Commented out by default. The copy script never writes chat data, so this is
-- NOT required for the clone to be idempotent. Uncomment only if you want
-- profile 4's existing chat thread gone — note its proposals may reference
-- profile 4's OLD goal ids, which the copy script is about to replace.
--
-- DELETE FROM chat_proposals WHERE thread_id IN (SELECT id FROM chat_threads WHERE profile_id = 4);
-- DELETE FROM chat_messages  WHERE thread_id IN (SELECT id FROM chat_threads WHERE profile_id = 4);
-- DELETE FROM chat_threads   WHERE profile_id = 4;


-- ── 5. Post-wipe check (read-only) ──────────────────────────────────────────
-- Every count below must be 0 before running the copy script.
SELECT 'workouts'          AS table_name, count(*) AS rows_left FROM workouts          WHERE profile_id = 4
UNION ALL SELECT 'exercises',          count(*) FROM exercises          WHERE profile_id = 4
UNION ALL SELECT 'daily_sleep',        count(*) FROM daily_sleep        WHERE profile_id = 4
UNION ALL SELECT 'daily_steps',        count(*) FROM daily_steps        WHERE profile_id = 4
UNION ALL SELECT 'body_metrics',       count(*) FROM body_metrics       WHERE profile_id = 4
UNION ALL SELECT 'daily_checkins',     count(*) FROM daily_checkins     WHERE profile_id = 4
UNION ALL SELECT 'micro_goals',        count(*) FROM micro_goals        WHERE profile_id = 4
UNION ALL SELECT 'workout_templates',  count(*) FROM workout_templates  WHERE profile_id = 4
UNION ALL SELECT 'rejected_wearable_matches', count(*) FROM rejected_wearable_matches WHERE profile_id = 4
ORDER BY table_name;
