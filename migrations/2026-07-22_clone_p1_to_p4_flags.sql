-- ============================================================================
-- CLONE PROFILE 1 -> PROFILE 4  ·  STEP 3 of 3: FLAGS
-- ============================================================================
-- WHAT THIS DOES
--   Turns profile 4 into the designated Engine v2 test profile: sets the
--   engine_v2 feature flag, clears the v1 recommendation caches, pins the
--   timezone, and puts the profile into the no-wearable / manual-check-in
--   state the clone was approved to run in.
--
-- STATUS: **NOT RUN.** Written by Claude Code, executed manually by Shimmy in
--   the Supabase SQL editor. Never assume it has been run.
--
-- PREREQUISITES
--   Run AFTER 2026-07-22_clone_p1_to_p4_wipe.sql and
--   2026-07-22_clone_p1_to_p4_copy.sql. This file assumes profile 4's
--   profile_data has already been replaced with profile 1's payload.
--
-- SAFETY CONTRACT
--   * Single UPDATE, scoped `WHERE id = 4`.
--   * Profile 1 is read-only: it appears once, in a scalar subquery reading
--     its timezone.
--   * Fully idempotent — `||` merges the same keys to the same values, and the
--     NULL-outs are already-NULL no-ops on a re-run.
--
-- NOTE ON engine_v2
--   No application code reads `profile_data.engine_v2` yet — Engine v2 Phase 1
--   was audit-only and no build has started. Setting the flag now is inert and
--   deliberate: it means the v2 build has a correctly-flagged profile waiting
--   on day one, and it can be verified independently of any code.
-- ============================================================================

UPDATE profiles
SET
  -- ── Engine v2 flag + wearable posture ──────────────────────────────────────
  --  engine_v2  : routes this profile to the v2 engine once that code exists.
  --  fitbit     : FORCED FALSE. Profile 1's profile_data says fitbit:true, but
  --               profile 4 deliberately has NO wearable connection (approved
  --               option (a): drive readiness from cloned historical daily_sleep
  --               rows plus manual check-ins). Leaving it true would make the
  --               UI believe a wearable is present and SUPPRESS the manual
  --               check-in card — which is the only readiness input profile 4
  --               actually has. This is load-bearing, not cosmetic.
  --  wearable   : NULL for the same reason (no device to route to).
  profile_data = COALESCE(profile_data, '{}'::jsonb)
                 || jsonb_build_object(
                      'engine_v2', true,
                      'fitbit',    false,
                      'wearable',  NULL
                    ),

  -- ── Timezone ───────────────────────────────────────────────────────────────
  -- Copied from profile 1 so localToday() resolves profile 4's calendar day
  -- identically. Profile 4 already reads 'America/Chicago', so this is
  -- currently a no-op — set explicitly anyway so the script is self-contained
  -- and survives profile 4 ever being recreated.
  timezone = (SELECT timezone FROM profiles WHERE id = 1),

  -- ── v1 caches: CLEARED, never copied ───────────────────────────────────────
  -- So profile 4 never renders stale v1 output while it is the v2 profile.
  -- Also cleared by the wipe script; repeated here so this file leaves a
  -- coherent state on its own.
  daily_recommendations           = NULL,
  daily_recommendations_date      = NULL,
  daily_recommendations_readiness = NULL,
  progress_brief                  = NULL,
  progress_brief_date             = NULL,

  -- ── Wearable-connection state: cleared ─────────────────────────────────────
  -- Profile 4 has no wearable_connections rows and no fitbit_* tokens (all in
  -- the SKIP bucket — cloning profile 1's live Fitbit/Google Health credentials
  -- would give two profile ids a claim on the same single-use rotating refresh
  -- token, and withRefreshLock keys on provider:profileId, so they would take
  -- DIFFERENT locks and could each spend it. That is the exact failure that
  -- killed profile 1's Fitbit token in session #19).
  -- dismissed_fitbit_activities is reset because profile 1's dismissals name
  -- activity ids from a connection profile 4 does not have.
  dismissed_fitbit_activities = '[]'::jsonb
WHERE id = 4;


-- ── Post-flag check (read-only) ────────────────────────────────────────────
SELECT id,
       name,
       timezone,
       profile_data -> 'engine_v2'          AS engine_v2,
       profile_data -> 'fitbit'             AS fitbit_flag,
       profile_data ->> 'name'              AS profile_data_name,
       jsonb_array_length(COALESCE(profile_data -> 'goals', '[]'::jsonb)) AS goals,
       (profile_data ? 'ai_prompt_context') AS has_prompt_context,
       (profile_data ? 'schedule')          AS has_schedule,
       (profile_data ? 'focus_override')    AS has_focus_override,
       (profile_data ? 'avatar_image')      AS has_avatar_image_should_be_false,
       daily_recommendations IS NULL        AS rec_cache_cleared,
       progress_brief IS NULL               AS progress_brief_cleared,
       coaching_brief IS NOT NULL           AS coaching_brief_copied,
       roadmap_data IS NOT NULL             AS roadmap_data_copied
FROM profiles
WHERE id IN (1, 4)
ORDER BY id;
