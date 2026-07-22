-- ============================================================================
-- CLONE PROFILE 1 -> PROFILE 4  ·  VERIFICATION  (READ-ONLY)
-- ============================================================================
-- WHAT THIS DOES
--   Section A is the BASELINE — run it BEFORE anything else and keep the
--   output. Sections B–E are the post-clone checks, including the proof that
--   profile 1 is unchanged.
--
-- STATUS: **NOT RUN.** Written by Claude Code, executed manually by Shimmy in
--   the Supabase SQL editor.
--
-- SAFETY: every statement in this file is a SELECT. Nothing here writes.
--   In particular, profile 1 must only ever be inspected this way — NOT via
--   `GET /api/profiles/1`, which fires a fire-and-forget PATCH of the entire
--   profile_data column when any goal lacks an id (server.js:990, ensureGoalIds).
--
-- ORDER OF USE
--   A  -> before the wipe            (capture baseline, resolve identity kinds)
--   B–E -> after the flags file       (verify the clone, prove p1 untouched)
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION A — BASELINE. RUN FIRST. SAVE THE OUTPUT.
-- ════════════════════════════════════════════════════════════════════════════
-- A1. Row counts for both profiles across every cloneable table.
--     This is the only reliable source for daily_sleep / daily_checkins /
--     daily_steps totals — the REST endpoints clamp their windows (daily-steps
--     to 365 days, body-metrics to 730), so API counts are partial.
SELECT 'workouts'          AS table_name, profile_id, count(*) AS row_count FROM workouts     WHERE profile_id IN (1,4) GROUP BY 1,2
UNION ALL SELECT 'exercises',         profile_id, count(*) FROM exercises         WHERE profile_id IN (1,4) GROUP BY 1,2
UNION ALL SELECT 'daily_sleep',       profile_id, count(*) FROM daily_sleep       WHERE profile_id IN (1,4) GROUP BY 1,2
UNION ALL SELECT 'daily_steps',       profile_id, count(*) FROM daily_steps       WHERE profile_id IN (1,4) GROUP BY 1,2
UNION ALL SELECT 'body_metrics',      profile_id, count(*) FROM body_metrics      WHERE profile_id IN (1,4) GROUP BY 1,2
UNION ALL SELECT 'daily_checkins',    profile_id, count(*) FROM daily_checkins    WHERE profile_id IN (1,4) GROUP BY 1,2
UNION ALL SELECT 'micro_goals',       profile_id, count(*) FROM micro_goals       WHERE profile_id IN (1,4) GROUP BY 1,2
UNION ALL SELECT 'workout_templates', profile_id, count(*) FROM workout_templates WHERE profile_id IN (1,4) GROUP BY 1,2
ORDER BY table_name, profile_id;

-- A2. Identity kind + date column types.
--     Drives the OVERRIDING SYSTEM VALUE handling in the copy script (which
--     resolves this automatically at run time — this is for the record, and to
--     confirm `workouts.date` really is text).
SELECT table_name, column_name, data_type, is_identity, identity_generation, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('workouts','exercises','micro_goals','daily_sleep','daily_steps',
                     'body_metrics','daily_checkins','workout_templates')
  AND column_name IN ('id','date')
ORDER BY table_name, column_name;

-- A3. The 6 malformed-date workouts on profile 1 (expected: 6 rows, ids
--     110/97/95/88/82/77). These are SKIPPED by the clone and left untouched
--     on profile 1. See ROADMAP.md §6.
SELECT id, date, type, done
FROM workouts
WHERE profile_id = 1
  AND date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
ORDER BY id DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION B — POST-CLONE ROW COUNTS, PROFILE 1 vs PROFILE 4
-- ════════════════════════════════════════════════════════════════════════════
-- Expected: identical everywhere EXCEPT workouts, where profile 4 should equal
-- profile 1's DATE-VALID workout count (total minus the malformed-date rows the
-- clone skips).
--
-- The workouts verdict is computed DYNAMICALLY — it counts profile 1's
-- malformed rows live rather than comparing against a frozen "minus 6". This
-- matters because profile 1 keeps growing: its total moved 81 -> 82 between the
-- API audit and the baseline run. A hardcoded delta would have started failing
-- the moment Shimmy logged another workout.
SELECT
  t.table_name,
  t.p1,
  t.p1_valid,
  t.p4,
  t.p4 - t.p1                                            AS delta_vs_total,
  CASE
    WHEN t.table_name = 'workouts' AND t.p4 = t.p1_valid
      THEN 'OK (' || (t.p1 - t.p1_valid) || ' malformed-date row(s) skipped)'
    WHEN t.table_name = 'workouts' AND t.p4 < t.p1_valid
      THEN 'CHECK — p4 short of p1''s date-valid count (or p1 gained a workout after the copy)'
    WHEN t.table_name = 'workouts'
      THEN 'CHECK — p4 exceeds p1''s date-valid count'
    WHEN t.p1 = t.p4                                     THEN 'OK'
    ELSE 'CHECK'
  END                                                    AS verdict
FROM (
  -- p1_valid is only meaningful for workouts (the only table the clone filters);
  -- every other row sets it equal to p1 so the verdict logic stays uniform.
  SELECT 'workouts' AS table_name,
         (SELECT count(*) FROM workouts WHERE profile_id = 1) AS p1,
         (SELECT count(*) FROM workouts WHERE profile_id = 1
            AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')        AS p1_valid,
         (SELECT count(*) FROM workouts WHERE profile_id = 4) AS p4
  UNION ALL SELECT 'exercises',
         (SELECT count(*) FROM exercises WHERE profile_id = 1),
         (SELECT count(*) FROM exercises WHERE profile_id = 1),
         (SELECT count(*) FROM exercises WHERE profile_id = 4)
  UNION ALL SELECT 'daily_sleep',
         (SELECT count(*) FROM daily_sleep WHERE profile_id = 1),
         (SELECT count(*) FROM daily_sleep WHERE profile_id = 1),
         (SELECT count(*) FROM daily_sleep WHERE profile_id = 4)
  UNION ALL SELECT 'daily_steps',
         (SELECT count(*) FROM daily_steps WHERE profile_id = 1),
         (SELECT count(*) FROM daily_steps WHERE profile_id = 1),
         (SELECT count(*) FROM daily_steps WHERE profile_id = 4)
  UNION ALL SELECT 'body_metrics',
         (SELECT count(*) FROM body_metrics WHERE profile_id = 1),
         (SELECT count(*) FROM body_metrics WHERE profile_id = 1),
         (SELECT count(*) FROM body_metrics WHERE profile_id = 4)
  UNION ALL SELECT 'daily_checkins',
         (SELECT count(*) FROM daily_checkins WHERE profile_id = 1),
         (SELECT count(*) FROM daily_checkins WHERE profile_id = 1),
         (SELECT count(*) FROM daily_checkins WHERE profile_id = 4)
  UNION ALL SELECT 'micro_goals',
         (SELECT count(*) FROM micro_goals WHERE profile_id = 1),
         (SELECT count(*) FROM micro_goals WHERE profile_id = 1),
         (SELECT count(*) FROM micro_goals WHERE profile_id = 4)
  UNION ALL SELECT 'workout_templates',
         (SELECT count(*) FROM workout_templates WHERE profile_id = 1),
         (SELECT count(*) FROM workout_templates WHERE profile_id = 1),
         (SELECT count(*) FROM workout_templates WHERE profile_id = 4)
) t
ORDER BY t.table_name;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION C — CLONED WORKOUT DATE RANGE (recency + gaps preserved)
-- ════════════════════════════════════════════════════════════════════════════
-- Dates were copied verbatim, so profile 4's range must match profile 1's
-- valid-date range exactly — the two rows below should agree on first_date and
-- last_date. (At API-audit time that range was 2026-04-07 -> 2026-07-21, but
-- profile 1 has logged at least one workout since, so compare the two rows
-- against EACH OTHER rather than against that frozen range. A later last_date
-- on profile 1 than on profile 4 just means he logged after the copy ran.)
SELECT profile_id,
       count(*)                                   AS workouts,
       min(date)                                  AS first_date,
       max(date)                                  AS last_date,
       count(*) FILTER (WHERE done)               AS done_workouts,
       count(*) FILTER (WHERE wearable_activity_id IS NOT NULL) AS with_wearable_id,
       count(*) FILTER (WHERE wearable_data IS NOT NULL)        AS with_wearable_data
FROM workouts
WHERE profile_id IN (1,4)
  AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
GROUP BY profile_id
ORDER BY profile_id;
-- with_wearable_id MUST be 0 for profile 4 — the clone forces it NULL because
-- the column carries a UNIQUE partial index. Profile 1's value was 46 at
-- API-audit time and may be higher now; the only hard requirement is that
-- profile 4 reads 0. with_wearable_data should be non-zero on both (that column
-- IS copied — it holds HR/calories/zones, no credentials).


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION D — DISTINCT EXERCISES + PARENT LINKAGE
-- ════════════════════════════════════════════════════════════════════════════
SELECT profile_id,
       count(*)                                        AS exercise_rows,
       count(DISTINCT name)                            AS distinct_names,
       count(DISTINCT workout_id)                      AS distinct_workouts,
       count(*) FILTER (WHERE workout_id IS NULL)      AS null_workout_id,
       min(date)                                       AS first_date,
       max(date)                                       AS last_date
FROM exercises
WHERE profile_id IN (1,4)
GROUP BY profile_id
ORDER BY profile_id;
-- Section A1 baseline for profile 1: 310 rows (69 distinct names, 65 distinct
-- workouts, 0 NULL workout_id at API-audit time). The two rows should be
-- identical to each other — that comparison is the real check, since profile 1
-- can gain exercise rows any time a new workout is extracted.

-- D2. FK integrity of the clone: every cloned exercise must point at a cloned
--     workout belonging to profile 4. Expected: 0 rows.
SELECT e.id, e.workout_id, e.name
FROM exercises e
WHERE e.profile_id = 4
  AND e.workout_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM workouts w WHERE w.id = e.workout_id AND w.profile_id = 4);

-- D3. Cross-profile leak check: no profile 4 row may reference a profile 1
--     parent, and no profile 1 row may reference a profile 4 parent.
--     Expected: 0 rows.
SELECT 'p4 exercise -> p1 workout' AS leak, count(*) AS n
FROM exercises e JOIN workouts w ON w.id = e.workout_id
WHERE e.profile_id = 4 AND w.profile_id = 1
UNION ALL
SELECT 'p1 exercise -> p4 workout', count(*)
FROM exercises e JOIN workouts w ON w.id = e.workout_id
WHERE e.profile_id = 1 AND w.profile_id = 4;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION E — PROFILE 1 UNCHANGED vs BASELINE  (the important one)
-- ════════════════════════════════════════════════════════════════════════════
-- HOW TO USE: paste the Section A1 profile-1 numbers into the VALUES list
-- below, then run. Every row must read PASS.
--
-- ALL EIGHT VALUES ARE NOW REAL, from the Section A1 baseline run on
-- 2026-07-22. No placeholders remain.
--
-- ⚠ This check detects ANY change to profile 1 — including legitimate change.
-- `workouts` moved 81 -> 82 between the read-only API audit and the baseline
-- run because Shimmy logged a real workout in between. If a count comes back
-- one or two high here, check whether he logged something before concluding the
-- clone leaked. The clone scripts themselves never write to profile 1, so a
-- LOWER count is the genuinely alarming direction.
WITH baseline(table_name, expected) AS (
  VALUES
    ('workouts',          82::bigint),   -- Section A1 baseline (was 81 at API-audit time; +1 real workout since)
    ('exercises',         310::bigint),  -- Section A1 baseline
    ('micro_goals',       2::bigint),    -- Section A1 baseline
    ('workout_templates', 0::bigint),    -- Section A1 baseline
    ('body_metrics',      2::bigint),    -- Section A1 baseline
    ('daily_steps',       736::bigint),  -- Section A1 baseline (API had clamped this to 365d / 366 rows)
    ('daily_sleep',       736::bigint),  -- Section A1 baseline (no REST endpoint exists)
    ('daily_checkins',    12::bigint)    -- Section A1 baseline (no REST endpoint exists)
),
actual(table_name, now_count) AS (
  SELECT 'workouts',          count(*) FROM workouts          WHERE profile_id = 1
  UNION ALL SELECT 'exercises',         count(*) FROM exercises         WHERE profile_id = 1
  UNION ALL SELECT 'micro_goals',       count(*) FROM micro_goals       WHERE profile_id = 1
  UNION ALL SELECT 'workout_templates', count(*) FROM workout_templates WHERE profile_id = 1
  UNION ALL SELECT 'body_metrics',      count(*) FROM body_metrics      WHERE profile_id = 1
  UNION ALL SELECT 'daily_steps',       count(*) FROM daily_steps       WHERE profile_id = 1
  UNION ALL SELECT 'daily_sleep',       count(*) FROM daily_sleep       WHERE profile_id = 1
  UNION ALL SELECT 'daily_checkins',    count(*) FROM daily_checkins    WHERE profile_id = 1
)
SELECT a.table_name,
       b.expected AS baseline,
       a.now_count,
       CASE
         WHEN b.expected IS NULL          THEN 'NO BASELINE — fill the VALUES list'
         WHEN b.expected = a.now_count    THEN 'PASS'
         ELSE                                  '*** FAIL — PROFILE 1 CHANGED ***'
       END AS verdict
FROM actual a
JOIN baseline b USING (table_name)
ORDER BY a.table_name;

-- E2. Profile 1's wearable connections must be untouched and still live.
--     Expected: fitbit + google_health rows present, needs_reconnect = false.
--     Profile 4 must have ZERO rows here — the clone never copies credentials.
SELECT profile_id, provider, needs_reconnect, last_synced_at,
       (access_token IS NOT NULL) AS has_access_token
FROM wearable_connections
WHERE profile_id IN (1,4)
ORDER BY profile_id, provider;

-- E3. Profile 1's own caches and identity must be untouched by the clone.
SELECT id, name, timezone,
       daily_recommendations_date,
       daily_recommendations_readiness,
       progress_brief_date,
       profile_data ->> 'name'      AS profile_data_name,
       profile_data -> 'engine_v2'  AS engine_v2,
       (profile_data ? 'avatar_image') AS has_avatar_image
FROM profiles
WHERE id IN (1,4)
ORDER BY id;
-- Profile 1: engine_v2 must be NULL (absent), avatar_image true, caches intact.
-- Profile 4: engine_v2 true, avatar_image false, caches NULL, name 'Test #3'.
