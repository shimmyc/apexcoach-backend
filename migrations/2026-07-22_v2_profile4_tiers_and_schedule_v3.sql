-- ============================================================================
-- ENGINE v2 · PHASE 3  ·  Profile 4: goal tiers + schedule v3 + defaults
-- ============================================================================
-- WHAT THIS DOES
--   Sets, on PROFILE 4 ONLY:
--     1. `tier` on every goal in profile_data.goals[]  (driver|maintenance|accessory)
--     2. profile_data.schedule_v3 = { fill_policy, anchor_meta }
--     3. profile_data.defaults    = { duration_min, intensity }
--   All three live in the existing `profile_data` jsonb — NO schema change.
--
-- STATUS: **NOT RUN.** Written by Claude Code, executed manually by Shimmy in
--   the Supabase SQL editor. Never assume it has been run.
--
-- PREREQUISITES
--   None schema-wise. Run this BEFORE `POST /api/v2/plan/4` — the planner
--   refuses to produce a meaningful tier split without it (with no tiers set,
--   every goal defaults to `maintenance` and nothing structures the week).
--
-- SAFETY
--   * Single-profile scoped: every statement is `WHERE id = 4`.
--   * Profile 1 is not read or written.
--   * Idempotent — re-running sets the same values.
--   * `ORDER BY ord` in statement 1 is LOAD-BEARING: goals[] array order IS
--     priority order (goals[0] = priority #1), and jsonb_agg without an
--     explicit ordering may not preserve it. Losing the order would silently
--     re-prioritise the athlete's goals.
--
-- ⚠ WHY schedule_v3 IS A SIBLING OF `schedule`, NOT A KEY INSIDE IT
--   `loadSchedule()` in public/index.html RECONSTRUCTS `currentSchedule` as
--   exactly {anchors, frequency_targets, addons}, and `schedPersist()` writes
--   that reconstruction straight back to profile_data.schedule. So any key
--   placed INSIDE profile_data.schedule is silently destroyed the first time
--   the athlete opens the Schedule card and edits anything. A sibling at the
--   profile_data level survives, because schedPersist does
--   Object.assign({}, currentProfileData, { schedule: currentSchedule }).
--   This also means v1 provably cannot see these keys — they are stripped at
--   load time, before any v1 reader runs.
-- ============================================================================


-- ── 1. Goal tiers ───────────────────────────────────────────────────────────
-- RECOMMENDED ASSIGNMENT (change the titles below to override):
--   DRIVER      Fix Posture, Fix Pubic Osteitis
--   ACCESSORY   Daily Meditation, Fix smartphone pinky…
--   MAINTENANCE everything else (Build Muscle, Mountain Hike, Black Belt, Stamina)
UPDATE profiles p
SET profile_data = jsonb_set(
  p.profile_data,
  '{goals}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN g->>'title' IN ('Fix Posture', 'Fix Pubic Osteitis')
          THEN g || '{"tier":"driver"}'::jsonb
        WHEN g->>'title' = 'Daily Meditation'
          THEN g || '{"tier":"accessory"}'::jsonb
        WHEN g->>'title' LIKE 'Fix smartphone pinky%'
          THEN g || '{"tier":"accessory"}'::jsonb
        ELSE g || '{"tier":"maintenance"}'::jsonb
      END
      ORDER BY ord                                  -- preserves priority order
    )
    FROM jsonb_array_elements(p.profile_data->'goals') WITH ORDINALITY AS t(g, ord)
  )
)
WHERE p.id = 4
  AND p.profile_data ? 'goals';


-- ── 2. Schedule v3 sibling keys + profile defaults ──────────────────────────
-- fill_policy 'ai_assigned': the planner pins every session to a specific date.
--   Chosen because all four of profile 4's weekly targets have
--   suggested_day = null, and because the resequencer that 'flexible' depends
--   on is Phase 4 work and does not exist yet.
-- anchor_meta: per-day metadata the v2 anchors map has nowhere to put. Only
--   `category` is set here; `time` is available and left unset.
UPDATE profiles
SET profile_data = profile_data || jsonb_build_object(
  'schedule_v3', jsonb_build_object(
    'fill_policy', 'ai_assigned',
    'anchor_meta', jsonb_build_object(
      'tue', jsonb_build_object('category', 'martial_arts'),
      'thu', jsonb_build_object('category', 'martial_arts')
    )
  ),
  'defaults', jsonb_build_object(
    'duration_min', 45,
    'intensity', 'auto'
  )
)
WHERE id = 4;


-- ── 3. Post-run check (read-only) ───────────────────────────────────────────
SELECT g->>'title' AS goal, g->>'tier' AS tier, ord AS priority
FROM profiles p, jsonb_array_elements(p.profile_data->'goals') WITH ORDINALITY AS t(g, ord)
WHERE p.id = 4
ORDER BY ord;
-- Expect 8 rows in the original priority order, exactly 2 marked 'driver'.

SELECT profile_data -> 'schedule_v3'          AS schedule_v3,
       profile_data -> 'defaults'             AS defaults,
       profile_data -> 'schedule' -> 'anchors' AS anchors_untouched
FROM profiles WHERE id = 4;

-- Profile 1 must be completely unaffected: no tier key, no schedule_v3.
SELECT id,
       (profile_data -> 'schedule_v3') IS NULL AS no_schedule_v3,
       NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(profile_data->'goals') gg
         WHERE gg ? 'tier'
       ) AS no_tiers_on_goals
FROM profiles WHERE id = 1;
-- Both columns must read true.
