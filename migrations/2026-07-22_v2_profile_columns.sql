-- ============================================================================
-- ENGINE v2 · PHASE 2  ·  profiles: v2 daily cache + athlete dossier
-- ============================================================================
-- WHAT THIS DOES
--   Adds four nullable columns to `profiles`:
--     v2_daily_cache       jsonb  — today's autoregulated session + the <=4
--                                   pre-generated alternates + decision tag
--     v2_daily_cache_date  date   — the athlete-local date that cache is for
--     dossier              jsonb  — the compact athlete dossier (<= ~2k chars
--                                   serialized), maintained by the nightly job
--     dossier_updated_at   timestamptz
--
-- STATUS: **NOT RUN.** Written by Claude Code, executed manually by Shimmy in
--   the Supabase SQL editor. Never assume it has been run.
--
-- PREREQUISITES
--   None. Column adds only.
--
-- WHY NEW COLUMNS RATHER THAN REUSING daily_recommendations
--   Approved Phase 1 decision. Two reasons:
--     1. `GET /api/profiles/:id/life-os-summary` reads
--        `daily_recommendations.options[]` unconditionally and would otherwise
--        silently serve a v2-shaped object to the external Life OS app.
--     2. Separate columns keep the engine_v2 flag a clean TWO-WAY switch —
--        flipping a profile back to v1 finds its v1 cache exactly as it was
--        rather than destroyed.
--
-- ISOLATION — verified, not assumed
--   Adding columns to `profiles` is invisible to every v1 reader:
--   `PROFILE_SELECT_BASE` (server.js:978) is an explicit column list, and there
--   is NO `select=*` against `profiles` anywhere in server.js. Nothing will
--   start returning these fields until code explicitly asks for them.
--
--   ⚠ One consequence worth knowing: `cleanProfileData()` only runs on API
--   write paths, and these columns sit OUTSIDE `profile_data`, so nothing
--   sanitizes them. The v2 writers are responsible for what they store.
-- ============================================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS v2_daily_cache      jsonb,
  ADD COLUMN IF NOT EXISTS v2_daily_cache_date date,
  ADD COLUMN IF NOT EXISTS dossier             jsonb,
  ADD COLUMN IF NOT EXISTS dossier_updated_at  timestamptz;


-- ── Post-run check (read-only) ──────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name  = 'profiles'
  AND column_name IN ('v2_daily_cache','v2_daily_cache_date','dossier','dossier_updated_at')
ORDER BY column_name;
-- Expect 4 rows, all is_nullable = YES.

-- Sanity: profile 4 is the flagged v2 profile, profile 1 must NOT be.
SELECT id, name,
       profile_data -> 'engine_v2' AS engine_v2,
       v2_daily_cache_date,
       dossier_updated_at
FROM profiles
WHERE id IN (1,4)
ORDER BY id;
