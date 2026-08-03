-- ============================================================================
-- REPAIR: 8 workouts whose `date` column holds a TIME STRING (session #47)
--
-- ⚠ REVIEW-THEN-APPLY. Written by the agent, run MANUALLY by Shimmy in the
--   Supabase SQL editor (ROADMAP §0.2 rule 3). Nothing here was executed.
--
-- RUN ORDER:
--   1. Section A (verify)  — read-only, confirms the 8 rows and their evidence
--   2. Section B (repair)  — the UPDATEs
--   3. Section C (confirm) — read-only, must return 0 rows
--   4. THEN, and only then: 2026-08-03_workouts_date_format_check.sql
--
-- ── ROOT CAUSE (fixed in code the same session, commit in this branch) ──────
-- `wearables/fitbit.js normalize()` did:  String(activity.startTime).slice(0,10)
-- Fitbit returns TWO shapes for the same activity:
--   LIST   /1/user/-/activities/list.json    -> startTime = full ISO datetime
--   DETAIL /1/user/-/activities/{logId}.json -> startTime = "HH:mm", date lives
--                                               in a separate `startDate` field
-- On the DETAIL shape the slice yields the TIME ITSELF. `createWearableWorkout()`
-- (server.js) then inserts DIRECTLY into PostgREST, bypassing the `POST
-- /api/workouts` handler — which has always rejected a non-YYYY-MM-DD date. So
-- this was never a client bug and no client fix would have prevented it.
--
-- ── WHY THESE DATES ARE EVIDENCE, NOT GUESSES ──────────────────────────────
-- Each row's true date is stored inside the row itself, at
--   wearable_data -> 'raw_response' ->> 'startDate'
-- and is independently corroborated by Fitbit's own `lastModified`, which lands
-- on the activity's END time to within seconds:
--
--   id      stored  true date    start  duration  lastModified (UTC)
--   ------  ------  -----------  -----  --------  ------------------------
--   77      10:20   2026-05-28   10:20   49 min   2026-05-28T16:10:03.735Z
--   82      10:07   2026-06-02   10:07   59 min   2026-06-02T16:05:58.942Z
--   88      19:37   2026-06-09   19:37   25 min   2026-06-10T01:02:52.605Z
--   95      13:00   2026-06-15   13:00   30 min   2026-06-15T18:30:32.672Z
--   97      12:52   2026-07-14   12:52   28 min   2026-07-14T18:20:49.964Z
--   110     10:12   2026-07-21   10:12   57 min   2026-07-21T16:09:25.254Z
--   100143  10:14   2026-07-28   10:14   61 min   2026-07-28T16:15:02.340Z
--   100144  10:52   2026-07-29   10:52   50 min   2026-07-29T16:43:27.518Z
--
--   Worked example (id 110): 10:12 America/Chicago = 15:12Z; + 57 min = 16:09Z;
--   lastModified is 16:09:25Z. The date is determined, not inferred.
--
-- ⚠ `ts` IS NOT A VALID SOURCE and must not be used. It is the IMPORT time
--   (`Date.now()` at insert), and it is wrong by up to 3 days: id 95's ts is
--   2026-06-18 for a workout that happened 2026-06-15. `workouts` has no
--   created_at/updated_at (ROADMAP §6), so `ts` is the only timestamp on the row
--   and it is a last-write stamp. Section B does NOT touch `ts`.
--
-- ── BLAST RADIUS, MEASURED BEFORE WRITING THIS ─────────────────────────────
--  * Exactly 8 malformed rows exist across ALL SIX profiles (1/4/5/7/8/9);
--    all 8 are profile 1. Profiles 4 and 5 are clean, so the CHECK constraint
--    in the companion file will not fail on any other profile.
--  * All 8 rows have ZERO `exercises` rows, so no child row can desync.
--  * NO dedupe collision is created: `POST /api/profiles/:id/dedupe-workouts`
--    keys on `date || '|' || ts`, and after repair all 92 profile-1 keys are
--    still distinct (verified by replaying the repaired set).
--
-- ⚠ REVIEW POINT FOR SHIMMY — the one judgement call in this file.
--   7 of the 8 rows land on a date that ALREADY has a manually-logged workout:
--     77 -> 2026-05-28 (joins id 78)        97  -> 2026-07-14 (joins id 105)
--     82 -> 2026-06-02 (joins id 83)        110 -> 2026-07-21 (joins ids 111,112)
--     88 -> 2026-06-09 (joins id 89)        100143 -> 2026-07-28 (joins 100146)
--     95 -> 2026-06-15 (alone)              100144 -> 2026-07-29 (joins 100145)
--   That is expected — each is a Fitbit activity you chose "Import as New"
--   rather than "Match to <workout>", so it is a deliberate second row for that
--   day. After the repair those days will render TWO workouts in History and
--   count as two sessions in streak/volume/category tallies (today they count
--   as ZERO, because the rows are invisible).
--   If you would rather MERGE any of them into the same-day manual workout,
--   delete that id from Section B and handle it through the app's wearable
--   match/merge flow instead. Do not merge them in SQL.
-- ============================================================================


-- ── SECTION A — VERIFY BEFORE CHANGING ANYTHING (read-only) ────────────────
-- Expect exactly 8 rows, and `derived_true_date` must equal the table above.
SELECT
  id,
  profile_id,
  date                                                   AS stored_date_BAD,
  wearable_data -> 'raw_response' ->> 'startDate'        AS derived_true_date,
  wearable_data -> 'raw_response' ->> 'startTime'        AS raw_start_time,
  wearable_data -> 'raw_response' ->> 'lastModified'     AS fitbit_last_modified,
  type,
  wearable_activity_id,
  to_timestamp(ts / 1000.0) AT TIME ZONE 'UTC'           AS import_time_utc
FROM workouts
WHERE date !~ '^\d{4}-\d{2}-\d{2}$'
ORDER BY id;

-- Sanity: every malformed row must carry a usable startDate. Expect 0 rows.
SELECT id, date, wearable_data -> 'raw_response' ->> 'startDate' AS derived
FROM workouts
WHERE date !~ '^\d{4}-\d{2}-\d{2}$'
  AND COALESCE(wearable_data -> 'raw_response' ->> 'startDate', '') !~ '^\d{4}-\d{2}-\d{2}$';


-- ── SECTION B — THE REPAIR ────────────────────────────────────────────────
-- Explicit per-row UPDATEs rather than one data-driven statement: the ids and
-- the dates are both stated literally, so this file is auditable on its face and
-- cannot silently rewrite a row that appears later.
--
-- Each statement is guarded by the CURRENT bad value, so it is a no-op if the
-- row has already been repaired, and re-running the file is safe.

BEGIN;

UPDATE workouts SET date = '2026-05-28' WHERE id = 77     AND date = '10:20';
UPDATE workouts SET date = '2026-06-02' WHERE id = 82     AND date = '10:07';
UPDATE workouts SET date = '2026-06-09' WHERE id = 88     AND date = '19:37';
UPDATE workouts SET date = '2026-06-15' WHERE id = 95     AND date = '13:00';
UPDATE workouts SET date = '2026-07-14' WHERE id = 97     AND date = '12:52';
UPDATE workouts SET date = '2026-07-21' WHERE id = 110    AND date = '10:12';
UPDATE workouts SET date = '2026-07-28' WHERE id = 100143 AND date = '10:14';
UPDATE workouts SET date = '2026-07-29' WHERE id = 100144 AND date = '10:52';

-- Expect: 8. If this is not 8, ROLLBACK and re-read Section A.
SELECT count(*) AS repaired_rows
FROM workouts
WHERE id IN (77, 82, 88, 95, 97, 110, 100143, 100144)
  AND date ~ '^\d{4}-\d{2}-\d{2}$';

COMMIT;


-- ── SECTION C — CONFIRM (read-only) ───────────────────────────────────────
-- 1. Must return ZERO rows, across every profile.
SELECT id, profile_id, date FROM workouts WHERE date !~ '^\d{4}-\d{2}-\d{2}$';

-- 2. The repaired rows, with their stored evidence alongside. `date` must equal
--    `derived_true_date` on all 8.
SELECT id, date, wearable_data -> 'raw_response' ->> 'startDate' AS derived_true_date
FROM workouts
WHERE id IN (77, 82, 88, 95, 97, 110, 100143, 100144)
ORDER BY id;

-- 3. No (date, ts) dedupe-key collision was created. Must return ZERO rows.
SELECT date, ts, count(*) AS n
FROM workouts
WHERE profile_id = 1
GROUP BY date, ts
HAVING count(*) > 1;
