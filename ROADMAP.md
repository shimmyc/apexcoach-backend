# ApexCoach — Project Roadmap & Source of Truth

> Single reference for anyone joining the project or picking it back up after a break.
> Pairs with `CLAUDE.md` (deep implementation notes) and `FORMULAS.md` (readiness/sleep math).
> Last updated: 2026-05-20.
>
> **Doc accuracy notes:** Sections 2, 4, and 10 were verified directly against `server.js`,
> `wearables/`, and `migrations/` rather than transcribed. Where the original brief differed
> from the live code, the doc follows the code and flags it with **⚠ Correction**.

---

## 1. Project Overview

**ApexCoach** is an AI-powered personal fitness coaching web app. Users connect a wearable
(Fitbit today), which auto-syncs sleep / HRV / RHR / zone minutes daily. A regression-fitted
readiness formula scores recovery (0–100), and Claude generates specific daily workout
recommendations from biometrics, training history, goals, and short-horizon "challenges."

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express — single file `server.js` |
| Frontend | Vanilla HTML/CSS/JS single-page app — `public/index.html` |
| Database | Supabase (PostgreSQL), accessed via PostgREST (`/rest/v1/...`) |
| AI | Anthropic Claude via `/api/ai` proxy — **Haiku** (`claude-haiku-4-5-20251001`) for cheap tasks, **Sonnet** (`claude-sonnet-4-20250514`) for smart tasks. Model is chosen **server-side** from a `callType` field; clients can't request the expensive model. System prompts auto-wrapped with `cache_control: ephemeral`. |
| Wearables | Provider-agnostic adapters in `wearables/` — Fitbit fully implemented (OAuth2 + auto-refresh) |
| Hosting | Render.com — auto-deploys on push to `main` |
| Repo | github.com/shimmyc/apexcoach-backend |

### Current Deployment

- **URL:** https://apexcoach-backend.onrender.com
- **Branch → deploy:** every push to `main` triggers a Render rebuild.

---

## 2. Database Schema

Supabase/Postgres. IDs on `profiles` and most child tables are `bigint`; `micro_goals.id` is `uuid`.

### `profiles`
Core user record. PIN-protected, all child data scoped by `profile_id`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint PK | |
| `name`, `pin`, `avatar_color` | text | `pin` is sha256-hashed |
| `profile_data` | jsonb | goals, injuries, schedule, equipment, `ai_prompt_context`, `onboarding_complete`, `avatar_image`, `settings.*`. **Long-term goals live here at `profile_data.goals[]` — there is no separate `goals` table.** Sanitized via `cleanProfileData()` on read+write. |
| `fitbit_access_token`, `fitbit_refresh_token`, `fitbit_expires_at` | text / bigint | Live Fitbit token store (rotating). Mirrored ↔ `wearable_connections`. |
| `coaching_brief`, `historical_brief`, `historical_brief_updated_at` | text / ts | Three-tier coaching memory |
| `roadmap`, `roadmap_updated_at` | text / ts | Personal training road map |
| `daily_recommendations` (jsonb), `daily_recommendations_date` (date), `daily_recommendations_readiness` (int) | | Daily rec cache |
| `progress_brief` (jsonb), `progress_brief_date` (date) | | Progress brief cache |
| `height_inches`, `birth_date`, `sex`, `goal_weight_lbs`, `goal_weight_timeline_months` | | Body-composition profile fields |
| `gym_access` | text | `yes` / `no` / `sometimes` |
| `gym_type` | text | Commercial gym / Home gym / CrossFit / functional fitness / Multiple |
| `fitbit_pending_imports` | jsonb | **Soft-deprecated** legacy import queue (see §9) |
| `created_at` | ts | |

### `workouts`
| Column | Type | Notes |
|--------|------|-------|
| `id`, `profile_id`, `date`, `type`, `notes`, `done`, `mobility`, `med`, `ts` | | `date` stored as local `YYYY-MM-DD`; `type` is AI-generated title |
| `wearable_data` | jsonb | Full normalized activity (avg_hr, peak_hr, calories, zones, `heart_rate_samples`, duration_minutes, start_time, …) |
| `wearable_activity_id` | text | Namespaced dedupe key `"provider:id"` (e.g. `fitbit:abc123`), unique partial index |

> **⚠ Correction:** there is **no `workout_logs` table**. Logged sessions are rows in `workouts`; extracted movements are rows in `exercises`. The brief's "workout_logs / exercises" = `workouts` + `exercises`.
> **⚠ Note:** `workouts` has **no `duration_minutes` column** (tech-debt item in §9). Session duration in analytics is summed from `exercises.duration_minutes` or read from `wearable_data.duration_minutes`.

### `exercises`
Auto-extracted from workout notes by Claude on save.

| Column | Type | Notes |
|--------|------|-------|
| `id`, `profile_id`, `workout_id`, `date` | | |
| `name` | text | Canonicalized (e.g. "glute bridges 3x12" → "Glute Bridge") |
| `category`, `main_category`, `subcategory` | text | Two-level taxonomy; `category` mirrors `main_category` |
| `sets`, `reps`, `weight_lbs`, `distance_miles`, `duration_minutes` | | Duration-based exercises (e.g. Dead Hang) use `duration_minutes` |
| `notes`, `raw_text`, `created_at` | | `raw_text` preserves the original phrasing |

### `micro_goals` (Active Challenges)
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `profile_id` | bigint FK → profiles (cascade) | |
| `title`, `type` | text | type ∈ daily_habit / weekly_frequency / cumulative_volume / strength_milestone / skill_technique / streak / recovery_balance |
| `target_value` (numeric), `target_unit` (text), `period` (text) | | period ∈ daily / weekly / monthly / custom |
| `end_date` | date | nullable |
| `current_value` | numeric | **Progress is this column** — server recomputes it on every GET for auto-trackable types |
| `is_active` | boolean | `DELETE` archives by default (`?hard=1` to purge) |
| `created_at` | ts | |

> **⚠ Correction:** `micro_goals` has **no `progress` JSONB column**. Progress = the recomputed `current_value` numeric. (A `roadmap`/`progress` JSONB is part of the *planned* Living Goal Roadmaps feature — see §7.)

### `wearable_connections`
One row per (profile, provider). OAuth tokens for every connected wearable.

| Column | Type |
|--------|------|
| `id` bigint PK, `profile_id` bigint FK (cascade), `provider` text | |
| `access_token`, `refresh_token` text | |
| `token_expires_at` | bigint (epoch ms) |
| `last_synced_at`, `created_at`, `updated_at` | ts |
| UNIQUE(`profile_id`, `provider`) | |

### `rejected_wearable_matches`
Remembers a user's "these are separate sessions" decision so a rejected pairing stops resurfacing.

| Column | Type |
|--------|------|
| `id` bigint PK, `profile_id` bigint FK (cascade), `workout_id` bigint | |
| `provider` text, `wearable_activity_id` text (`"provider:id"`) | |
| `created_at` ts; UNIQUE(`profile_id`, `workout_id`, `wearable_activity_id`) | |

### Other tables
- **`daily_steps`** — id, profile_id, date, steps, calories, distance_miles, floors, source, created_at. UNIQUE(profile_id, date). Nightly Fitbit upsert.
- **`body_metrics`** — id, profile_id, date, weight_lbs, body_fat_pct, bmi, source, created_at. UNIQUE(profile_id, date).
- **`daily_checkins`** — id, profile_id, date, energy, soreness (text[]), severity, checkin_text, created_at. UNIQUE(profile_id, date).
- **`workout_templates`** — id, profile_id, name, type, notes_template, exercises (jsonb), use_count, created_at. Saved routines (▶ Use buttons).
- **`tokens`** *(legacy)* — pre-multi-profile single-user Fitbit token store; still read as a fallback in `/callback` and `/api/token-info`. Superseded by `profiles.fitbit_*` + `wearable_connections`.

### Migrations
- `migrations/2026-05-19_wearables.sql` — adds `workouts.wearable_data` + `wearable_activity_id`, creates `wearable_connections` + `rejected_wearable_matches`, backfills Fitbit tokens from `profiles.fitbit_*`.

> Most other tables/columns were created ad-hoc via the Supabase SQL editor (the `CREATE TABLE`/`ALTER TABLE` snippets are documented inline in `CLAUDE.md`). Only the wearables migration is committed as a file.

---

## 3. Features Built

Commit hashes attached where known (from `git log`). Areas without a hash predate this log window or span many commits.

### Profile & Onboarding
- **Profile builder** — section-based Q&A, full-page paginated overlay (`c3008b2`)
- **Profile review/edit mode** — non-linear, pre-populated answers; falls back to AI-merged `profile_data` for older profiles (`c3008b2`, `292f619`, `7427fb7`)
- **Gym access questions** — `gym_access` + `gym_type` added to builder and AI prompts (`24f3456`)
- **Profile completeness card** — "Build Profile" prompt launching the deep builder

### Workout Logging
- **AI workout extraction** — free-text "What did you do?" → AI categorizes/titles on save (`67592df`)
- **Exercise row extraction** — canonical names + two-level taxonomy, hardened with STRICT RULE prompt (`9c4bcb2`)
- **Minutes + seconds duration input** — M:SS format
- **Templates / saved routines** — create, edit, delete, ▶ Use, `use_count` (`67592df`)
- **Workout history / Library tab** — calendar + list, "Ask Your History" AI search

### Dead Hang / Exercise Tracking
- **History → Goals sync** — UTC date bug fix + canonical name matching in auto-matcher (`53870a6`, `a3d9f31`)
- **PR tracking** — personal best surfaced (1:42 dead-hang PR)
- **Per-set duration parsing** — "4x25s" handled in strength_milestone tracker (`2d10098`)
- **Backfill of missing sessions** — one-shot dead-hang backfill; duration stored in `raw_text` (`c1e0d53`, `a35c1a9`)
- **Debug endpoints** — `dead-hang`, `missing-dates`, `dead-hang-backfill` (`f4e51b9`, `af37519`, `3585...`)
- **Past-date logging + goal check-in modal** (`4c5674c`)
- **Duration-based exercise support** throughout (reps→seconds where appropriate)

### Goals & Milestones
- **6 goal types** — strength, distance, consistency, habit, skill, general
- **AI estimate scoring** per type; manual override (✏️) on every card
- **Auto-update on workout save** across all mutation paths
- **`last_computed_at`** timestamp on all goal cards; auto-refresh on workout save (`70dfa46`, `7c50f4d`)
- **Goal priority** — drag/arrow reorder, weights AI recs (#1 ~40% / #2 ~25% / #3 ~15%)

### Active Challenges (Micro-Goals)
- **Daily habit card** — started date, X/Y days, completion %, tiered color coding (≥85% green, 65–84% yellow, <65% red) (`e8b7cfe`, `44e7c39`)
- **Timeline progress bar** — days elapsed / total goal days (`44e7c39`)
- **"Updated Xm ago" stamp** on each card (`466588c`)
- **Personal-best cards** with M:SS display
- **Refresh button** — refreshes both challenges and goals; fixed stale UI (`8c9ad2e`)
- **AI integration** — ACTIVE CHALLENGES block woven into every daily rec

### Analytics  (`c91c5e0`, then `6a4f0ce`, `0b9afb2`)
- **Workout Analytics Dashboard** — Overview + By Activity modes
- **Date filters** — 7D, 30D, 90D, 1YR, All, Custom
- **Per-activity** — total min, sessions, avg HR, **peak HR (est.)**, calories, trends vs previous period
- **Overall** — total min, sessions, calories, top day, current + longest streak, averages
- **Drill-down** — click an activity type → headline stats rescope to that type only
- **Library exercise analytics** — Best Set chart, Total Volume chart, stat boxes
- **Duration-based exercise support** — Dead Hang shows seconds, not reps
- **Library sort dropdown** — Most/Least Logged, A→Z, Z→A, Most/Least Recent

### Wearable Integration
- **Provider-agnostic architecture** — `wearables/` dir (`index.js` registry, `base.js` contract) (`0192a57`)
- **Fitbit adapter** (full); Google Health / Apple Health / Samsung / Garmin (stubs)
- **NormalizedActivity schema** — cross-provider shape
- **Sync UI** — date-range picker, activity-type filter, batch review panel (`0de7f29`)
- **Match / Skip / Import / Ignore** actions
- **Bulk actions** — Match All (≥70 pts), Import All, Skip All (`f97f52a`)
- **Matching logic** — same-day required; single same-day workout = auto-match (score 60); multi-workout = scored (`929ac63`)
- **HR-loss fix (list-vs-detail)** — detail endpoint drops `averageHeartRate`; list carries it; `mergeListHr` backfills (`d2d6576`)
- **Token sync fix** — `profiles.fitbit_*` ↔ `wearable_connections` bidirectional mirror; backfill uses live profiles token (`1351e1c`, `ffd8ddb`)
- **HR backfill endpoint** — avg HR from list (pass 1); peak HR via TCX → intraday → (analytics) zone estimate; `peak_hr_from_*` counters (`941e0ed`, `19f3524`, `d09f998`, `56a7a8b`)
- **Peak HR estimation from Fitbit zones** — 185+/163+/108+ bpm (est.) when no measured peak (`387d723`)
- **Workout history cards** — wearable badge + enriched stats

### Supporting systems (context)
- **Readiness V3** + **Sleep score** regression formulas (`FORMULAS.md`)
- **Body composition** — weight/BMI/body-fat, TDEE coaching (`950e4a9`, `b1531c6`)
- **Step history** — `daily_steps`, goal, pill, 30-day chart, AI context (`6ed6ba8`)
- **Three-tier coaching memory** — historical brief / coaching brief / history search
- **Daily rec + progress-brief server-side caches** (`737d994`, `f5e60ea`)

---

## 4. API Endpoints

All verified present in `server.js`. `:id`/`:userId` = profile id.

### Auth / OAuth
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/auth` | Begin Fitbit OAuth |
| GET | `/callback` | Fitbit OAuth callback (dual-writes tokens) |
| GET | `/api/token-info` | Legacy token diagnostics |

### Profiles
| Method | Path |
|--------|------|
| GET | `/api/profiles` · GET `/api/profiles/:id` |
| POST | `/api/profiles` · POST `/api/profiles/verify` |
| PATCH | `/api/profiles/:id` · PATCH `/api/profiles/:id/pin` |
| DELETE | `/api/profiles/:id` |

### Daily data / biometrics
| Method | Path |
|--------|------|
| GET | `/api/daily` · `/api/profiles/:id/daily` |
| GET | `/api/profiles/:id/daily-steps` · `/api/profiles/:id/body-metrics` |
| POST | `/api/profiles/:id/body-metrics` |
| GET | `/api/profiles/:id/fitbit-pending-imports` |
| POST | `/api/profiles/:id/fitbit-import` · `/api/profiles/:id/fitbit-backfill` |

### Workouts / templates / exercises
| Method | Path |
|--------|------|
| GET | `/api/workouts` · `/api/workouts/:id/full` |
| POST | `/api/workouts` · PATCH `/api/workouts/:id` · DELETE `/api/workouts/:id` |
| POST | `/api/profiles/:id/reformat-titles` · `/api/profiles/:id/dedupe-workouts` |
| GET/POST | `/api/profiles/:id/templates` · PATCH/DELETE `/api/templates/:id` |
| POST | `/api/profiles/:id/extract-exercises` |
| GET | `/api/profiles/:id/exercises` · `/exercises/stats` · `/exercises/:name` · `/exercises/audit` |
| DELETE | `/api/profiles/:id/exercises/:exerciseId` |
| GET | `/api/meditations` |

### Coaching / AI
| Method | Path |
|--------|------|
| POST | `/api/ai` (Anthropic proxy, server-side model selection) |
| GET/POST | `/api/profiles/:id/brief` · `/generate-brief` |
| POST | `/api/profiles/:id/search-history` |
| GET/POST | `/api/profiles/:id/daily-recs` · `/progress-brief` · `/roadmap` |
| POST | `/api/profiles/:id/goal-progress` · `/generate-goal-description` |
| GET/POST | `/api/profiles/:id/checkin` |

### Micro-goals (Active Challenges)
| Method | Path |
|--------|------|
| GET/POST | `/api/profiles/:id/micro-goals` |
| PATCH/DELETE | `/api/micro-goals/:id` |

### Analytics
| Method | Path |
|--------|------|
| GET | `/api/analytics/activity-stats/:userId` |
| GET | `/api/analytics/exercise-stats/:userId/:exerciseName` |

### Wearables
| Method | Path |
|--------|------|
| GET | `/api/wearables/providers/:userId` |
| POST | `/api/wearables/connect/:provider` · `/disconnect/:provider` |
| GET | `/api/wearables/sync-backlog/:userId` · `/activity-types/:userId` |
| POST | `/api/wearables/merge/:userId` · `/reject/:userId` · `/import/:userId` · `/bulk-action/:userId` |

### Debug / admin (gated by `ADMIN_SECRET` where applicable)
| Method | Path |
|--------|------|
| GET | `/api/debug/dead-hang/:userId` · `/missing-dates/:userId` |
| POST | `/api/debug/dead-hang-backfill/:userId` |
| POST | `/api/debug/backfill-wearable-hr/:userId` (`?provider=fitbit&max_intraday=N`) |

---

## 5. Wearable Provider Status

| Provider | Status | Notes |
|----------|--------|-------|
| **Fitbit** | ✅ Fully implemented | OAuth2 + auto-refresh, list/detail/TCX/intraday HR, full normalization |
| **Google Health Connect** | 🔲 Stub (TODO) | Highest-priority next integration; Android API |
| **Apple Health** | 🔲 Stub (TODO) | Needs iOS companion app pattern + Apple Developer account |
| **Samsung Health** | 🔲 Stub (TODO) | Galaxy devices via Samsung Health Data SDK |
| **Garmin** | 🔲 Stub (TODO) | Public API, **OAuth 1.0a** (differs from Fitbit's 2.0) |

> **Universal API note:** On Android, **Google Health Connect** can unify Google/Samsung/most
> Android-14+ device data — activating one Health Connect adapter may cover multiple providers
> without separate Samsung/Pixel integrations. "Open Wearables" (Railway, ~$5/mo) is a longer-term
> unified option covering Garmin/Whoop/Oura/Polar/Apple (via iOS app).

---

## 6. Known Limitations

- **Fitbit Server-type app → no intraday HR.** Peak HR falls back to TCX `MaximumHeartRateBpm`, then to a zone-floor estimate. (Confirm the registered app type in the Fitbit dev portal to know which path is active.)
- **Peak HR historical backfill** — a subset of older sessions (~24) only ever yields **estimated** peak values (no measured/sampled peak recoverable).
- **`wearable_connections` redundant double-write** on the OAuth callback (`/callback` calls both `saveProfileTokens` and `saveWearableTokens`) — cosmetic, idempotent, low priority (see §9).

---

## 7. Roadmap — Features To Build

### Near term

**Living Goal Roadmaps** *(fully specced)*
- **Schema (planned):** `roadmap` jsonb, `roadmap_version`, `intake_answers` jsonb, `intake_completed`, `last_adapted_at` — *intended on a goals table*.
  > ⚠ **Caveat:** there is currently no `goals` table — long-term goals live in `profile_data.goals[]`. This feature needs either a new `goals` table or these columns added to wherever goals are persisted. Decide the storage model first.
- **Intake flow:** profile-aware (don't re-ask what the profile already knows); 4–6 targeted questions per goal; freeform answers; 1–2 rounds of AI follow-ups; open-ended final field.
- **Generation:** Sonnet for the one-time initial roadmap; Haiku for weekly adaptation.
- **Structure:** phases with completion signals, estimated dates, adaptation log.
- **UI:** click goal card → expand; inline intake questions; roadmap view with current phase highlighted; check-in button.
- **Adaptation:** weekly auto-adaptation on workout save; estimated completion date with delta tracking.

**Auto-import on workout save** — when a workout is logged, check for a same-day Fitbit activity and prompt the user to match. (Replaces the manual sync-backlog round trip for fresh logs.)

**Front-end redesign** — in progress in a separate chat.

### Medium term
- Activate **Google Health Connect** adapter (may unify Android wearables — see §5).
- Activate **Apple Health** adapter (iOS companion-app pattern).
- **Garmin** adapter (OAuth 1.0a).
- **Peak HR:** revisit once Health Connect is available (fewer API restrictions than Fitbit Server-type).

### Long term
- **Full Analytics tab** — dedicated page, not just a profile card.
- **Nutrition tracking** integration.
- **Sleep tracking** integration (Fitbit sleep data already partially available; feeds readiness/sleep score).
- **Social / sharing** features.

---

## 8. Onboarding Roadmap

### Intended flow
1. **Account creation** — name + PIN.
2. **Profile builder** (linear, 5 sections):
   - Basic info
   - Lifestyle & Schedule (equipment, gym access, typical day)
   - Injuries & Health
   - Goals (what they want to achieve)
   - Mindset & Preferences
3. **First workout log** (guided).
4. **Connect wearable** (optional but encouraged).
5. **Goals & Milestones setup** — AI suggests based on profile.
6. **First daily recommendation.**

> Current state: a 7-question paginated onboarding overlay + deep profile builder exist
> (`CLAUDE.md` → "Onboarding Flow"). The steps below are the gaps to reach the intended flow.

### TODO
- [ ] Onboarding checklist / progress indicator for new users
- [ ] Guided first workout log
- [ ] Wearable-connection prompt post-signup
- [ ] Goal-suggestion flow driven by profile answers
- [ ] Welcome email / push-notification flow

---

## 9. Technical Debt & Cleanup

- [ ] **Remove soft-deprecated `fitbit_pending_imports` queue** (and `/api/profiles/:id/fitbit-pending-imports`, `/fitbit-import`) once the UI fully migrates to wearable sync.
- [ ] **Drop the redundant `saveWearableTokens` call** in the `/callback` OAuth handler — `saveProfileTokens` now mirrors into `wearable_connections`, so the explicit second write is redundant (idempotent, harmless).
- [ ] **Add `workouts.duration_minutes` column** so manual session durations count in analytics without relying on summed `exercises.duration_minutes`.
- [ ] **Rename `?max_intraday=` → `?max_calls=`** in `/api/debug/backfill-wearable-hr` (the budget now covers TCX **+** intraday calls, not just intraday). Keep `max_intraday` as an alias for back-compat.
- [ ] **Retire the legacy `tokens` table** path once confirmed no profile depends on it.

---

## 10. Environment Variables Required

All read via `process.env.*` in `server.js`. No values here — set them in the Render dashboard.

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPABASE_URL` | ✅ | Supabase project REST base URL |
| `SUPABASE_KEY` | ✅ | Supabase service key (PostgREST auth) |
| `ANTHROPIC_KEY` | ✅ | Anthropic API key for the `/api/ai` proxy |
| `FITBIT_CLIENT_ID` | ✅ | Fitbit OAuth app client id |
| `FITBIT_CLIENT_SECRET` | ✅ | Fitbit OAuth app client secret |
| `ADMIN_SECRET` | ⚠ Recommended | Gates `/api/debug/*` admin endpoints when set |
| `PORT` | optional | Server port (Render injects this) |
| `FITBIT_ACCESS_TOKEN` | legacy | Single-user fallback token (pre-multi-profile) |
| `FITBIT_REFRESH_TOKEN` | legacy | Single-user fallback refresh token |

> **⚠ Correction:** the Anthropic key env var is **`ANTHROPIC_KEY`**, not `ANTHROPIC_API_KEY`.
> If you set `ANTHROPIC_API_KEY` on Render, the AI proxy will not pick it up.
