# ApexCoach — Project Roadmap & Source of Truth

> Single reference for anyone joining the project or picking it back up after a break.
> Pairs with `CLAUDE.md` (deep implementation notes) and `FORMULAS.md` (readiness/sleep math).
> Last updated: 2026-07-15.
>
> **Doc accuracy notes:** Sections 2, 4, and 10 were verified directly against `server.js`,
> `wearables/`, and `migrations/` rather than transcribed. Where the original brief differed
> from the live code, the doc follows the code and flags it with **⚠ Correction**.
>
> **✅ 2026-06-18 CRITICAL ISSUE — ROOT-CAUSED & MOSTLY RESOLVED (2026-06-19).** The "every Supabase/PostgREST query returns **'Premature close'**" outage is understood and largely fixed. **Real root cause (NOT Supabase throttling alone):** Supabase support confirmed the `apexcoach` project's **compute was sized at Nano (free-tier sizing) despite being on the Pro plan** — paid projects do **not** auto-upgrade their compute. The daily-recs **retry storm** (frontend stream-parse failure re-firing `fetchAI` with no cap — fixed this session, see the 2026-06-18 stream-parse item below) drove connection volume into **Nano's memory ceiling**, which made PostgREST's **Warp HTTP server kill in-flight request threads under timeout pressure** — surfacing client-side as **"Premature close"** on every query. The "EXCEEDING USAGE LIMITS" dashboard banner was a symptom of the same undersized compute, not a separate billing limit. **Primary fix:** upgraded Supabase compute **Nano → Micro** (free on the Pro plan, ~2 min downtime). This resolved the **majority** of failures.
>
> **Residual bug found after the upgrade (2026-06-19).** Intermittent "Premature close" still hit a subset of requests — Supabase `workouts`, and separately **Fitbit's `oauth2/token`** endpoint — traced to **node-fetch's stream sometimes dying mid-body-read**. Because that failure happens **after `fetch()` has already resolved** (during `res.json()`/`res.text()`), a naive retry wrapper around the `fetch()` call alone never caught it. **Fixes shipped (all `server.js`):**
> - **`c88b186`** — generic **GET-only** retry wrapper at the single `node-fetch` import point (`rawFetch` → `fetch`), retrying transient errors (`Premature close` / `ECONNRESET` / `ETIMEDOUT` / `EPIPE`), 2 extra attempts at 250ms/500ms. Non-GET passes straight through (no silent re-send of side-effecting requests).
> - **`f1aef8a`** — extended the wrapper to retry the **full fetch + body-read cycle** (the actual fix for the body-read failure mode): the GET path eagerly reads `res.text()` *inside* the retry loop and returns a **buffered Response-like object** (`.ok`/`.status`/`.headers`/`.json()`/`.text()`), so a transient read failure triggers a clean retry and **no call site needed changes**.
> - **`78ba684`** — Fitbit token refresh (`refreshProfileToken`, a **POST**, excluded from the GET wrapper by design) given its **own** retry loop + an **`invalid_grant` guard**: Fitbit **rotates the refresh token on each successful exchange**, so a blind retry after a lost response could hit a now-dead token — a non-2xx (esp. `400 invalid_grant`) stops retrying immediately and logs `[Fitbit] Refresh token already rotated or invalid — re-auth required`. Final failure still throws so the caller's non-fatal empty-wearable-data fallback is preserved.
> - Earlier in the session, `sbHeaders()` got **`Accept-Encoding: identity`** (to rule out node-fetch Brotli/gzip decompression). Turned out **not** to be the root cause, but harmless and left in.
>
> **⚠ STILL OPEN at session end (2026-06-19) — Fitbit token refresh failing 100%.** Even *after* the retry + `invalid_grant` guard, the Fitbit refresh fails **every time** with the same **"Premature close"** message — and **none of the new retry/guard log lines fire**. **Leading theory:** the original retry storm fired the refresh endpoint so many times concurrently that **one attempt succeeded and rotated the refresh token server-side before its response was lost client-side**; every attempt since has been using a **now-dead token**, which Fitbit may be rejecting in a way that **looks like a connection drop rather than a clean `invalid_grant` JSON body** (hence no guard log). **Next step:** direct **`curl` test from the Render Shell** against `api.fitbit.com/oauth2/token` with the actual stored refresh token to confirm. **If the token is dead, the fix is reconnecting via the existing Fitbit reconsent banner — not more retry code.**
>
> **Adapter parity gap (noted, not yet fixed).** `wearables/fitbit.js`'s own **`adapter.refreshToken()`** — reached **only** for wearable-only Fitbit connections that **never populated `profiles.fitbit_*`** — does **not** have the same retry / `invalid_grant` handling as `refreshProfileToken()`. **Low priority:** confirm whether any active profile actually hits that fallback path before patching. (Also tracked in §6.)
>
> **2026-07-15 session** (Focus Override system — standing directive + daily manual overrides for AI recommendations):
> - **Focus Override — new standing directive system.** New `profile_data.focus_override` jsonb field (`{text, scope, mode, start_date, end_date, daily_override_state}`) lets the user set a time-boxed directive that reshapes daily AI recs independent of the normal goal-priority weighting. 5 modes: **replace** (goalPriorityContext fully suppressed, scope "all" or specific goal ids), **boost** (~60-70% weight above the #1 priority goal, other weights compressed), **sprinkle** (goal weighting unchanged, 1-2 non-anchored sessions/week nudged toward the focus text), **infuse** (schedule/category untouched entirely — focus is woven into session content only: accessory work, technique emphasis, exercise substitutions), **total** (bypasses the schedule anchor lock itself — the only mode that can override a fixed commitment like a scheduled class). New `resolveFocusOverride()` + `buildFocusOverrideContext()` (public/index.html), injected in `fetchAI()`'s user-message assembly right after `buildScheduleInstruction()`; `goalPriorityContext`'s own construction consults the resolved override for skip/exclude/compress behavior. `total` mode required a matching branch inside `buildScheduleInstruction()` itself (opts.totalOverride) since it's the only mode touching schedule, not just goal weighting. No new Supabase table — saved via the existing `PATCH /api/profiles/:id` profile_data merge.
> - **Date range presets** — 5 pills replace a single fixed quick-set: 30 Days (rolling), This Month / This Quarter / This Year (all align to the calendar period's actual end date, not a fixed day-count from today), Custom (opens date inputs directly, no auto-fill).
> - **Daily manual override (AI rec card).** Three buttons alongside the existing "Show me different options": **Focus fully today** (force replace for this call only, schedule still respected), **Full override today** (force total mode for this call only — schedule bypassed), **Skip focus today** (ignore focus_override entirely, normal recs). None mutate the stored standing config. Unlike reroll/category (ephemeral `altRec`, never cached), a daily flag overwrites the actual `daily_recommendations` cache and stamps `daily_override_state` (`forced`/`total`/`skipped`) so a pill on the card reflects the real generated state on reload, with a "Reset to normal" link to clear it and regenerate.
> - **Bug found + fixed:** the daily `'total'` flag initially only reached `buildFocusOverrideContext()`, not `buildScheduleInstruction()` — Claude received contradictory instructions (schedule said today's anchor was fixed, override text said ignore schedule), which on at least one occasion produced a response long enough to blow the `daily_recs` `max_tokens` budget mid-JSON and fail `extractRecJSON()`. Fixed by threading a single "is total active this call" signal into both functions; also tightened the `brief` field spec to a firm ~25-word cap and bumped `daily_recs` `max_tokens` **1800 → 2200** for headroom. Commits `c574555`, `9b4dea7`.
> - **Documentation:** new "Focus Override System" section added to `CLAUDE.md` (between Goal Priority System and Active Challenges) covering schema, all 5 modes, date presets, daily flags, and injection point. Commit `53231a6`.
>
> **2026-06-18 session** (reliability hardening — Fitbit non-fatal, Sonnet streaming + prompt trim, stream-parse + retry-storm fixes, Claude model-string refresh; plus a cross-project life-os RLS fix and the planned Exercise Video DB):
> - **Claude model strings refreshed** — the old `MODEL_SONNET` string `claude-sonnet-4-20250514` was **deprecated and retired on 2026-06-15**. Updated `server.js` (the single `MODEL_SONNET` constant) → **`claude-sonnet-4-6`**. Because all 20+ AI call sites route through the `MODEL_SONNET` / `MODEL_HAIKU` constants and the `CALL_TYPE_MODEL` map, this **one** edit fixed every call site. `MODEL_HAIKU` was already current (`claude-haiku-4-5-20251001`) — no change. Doc references in `CLAUDE.md` + this file synced. Commit `e0cb3e3`. Active models now: **`claude-sonnet-4-6`** (Sonnet) / **`claude-haiku-4-5-20251001`** (Haiku). See §1.
> - **Fitbit made fully non-fatal (no more 500/504 from wearable outages).** Root cause: `buildDailyData()` had **5 of 11** Fitbit calls with **no `.catch()`** inside a `Promise.all`, so any single 403/401/500 rejected the entire batch → 500; `fitGet()` had **no timeout** (a hung call → 504); and `getValidProfileToken()` (token refresh) was unguarded → 500 on re-auth failure. Fixes (all `server.js`): (a) `fitGet()` now has a per-call **8s** `AbortController` timeout — 403/401/500/timeout all throw clear errors that callers swallow; (b) **every** `buildDailyData()` Fitbit call is now `.catch()`-guarded to an empty shape (the 5 unguarded calls fixed) so one failing metric degrades to `null` instead of failing the batch; (c) new helpers **`emptyWearableData()`** (200-safe null/empty snapshot, `source:"unavailable"`) and **`withTimeout()`** (hard cap for upstreams without their own `AbortController`); (d) the `/api/profiles/:id/daily` Fitbit path wraps `getValidProfileToken` + `buildDailyData` in try/catch under a **25s** `withTimeout` — any failure logs and returns **200 + `emptyWearableData()` + `fitbit_error:true`** instead of 500; (e) the Google Health fetch is wrapped in `withTimeout(8000)` (timeout falls through to Fitbit, as before); (f) the legacy `/api/daily` got the same `withTimeout` + degrade-to-empty-200 treatment for consistency. **Net effect:** a Fitbit *or* Google Health outage yields a 200 with null/empty wearable data, and the recommendation still generates from whatever data IS available. Google Health was already non-fatal — the only gap was the missing timeout. Fitbit `403 PERMISSION_DENIED` on the weight/fat endpoints now logs correctly as non-fatal. See §3 → Reliability & Resilience and §6.
> - **Sonnet daily-recs streaming + prompt trim (fixes the 25s Anthropic timeout → 504).** After the Fitbit fix the 504 **persisted**, because the **Sonnet generation step itself** was timing out (>25s) on Render Starter (logs confirmed `[AI] Anthropic API timed out after 25s`). **Fix part 1 — streaming (daily_recs only):** `callType === "daily_recs"` now sends `stream:true` to Anthropic and the server pipes the SSE `text_delta` chunks to the client as chunked `text/plain` via a new **`pipeAnthropicStream`** helper; a **per-chunk 20s idle timeout** aborts a hung upstream; upstream errors *before* streaming are still returned as JSON with the status preserved; **all other callTypes are untouched**; **no SDK added** — the raw `node-fetch` SSE pipe matches the existing code pattern. Frontend `fetchAI` now reads the streamed body with a reader, reassembles it into the full text, then runs the same JSON extraction; its abort timer is now **idle-based** (resets on each chunk). **Fix part 2 — prompt trimming:** the "RECENT N-DAY LOG" block is condensed to a **last-7-day exercise summary** — one line per exercise, `DATE: EXERCISE (SETS x REPS @ WEIGHT)`; the combined-prompt guard dropped from **8000 → 6000 chars** (falls back to 4 days if still over). The request body fell from **14,379 bytes → ~9,730 bytes**. Committed to `main`. See §3 → Reliability & Resilience.
> - **Stream-parse fix + retry-storm fix.** After streaming deployed, the stream was **completing server-side** (`wroteAny=true`, usage logged) but the client was **still erroring**. Root cause: the frontend was trying to parse the streaming response as the **legacy Anthropic envelope** `{content:[{text:"{…}"}]}` — a format mismatch with the new raw-text stream. Secondary problem: a failed parse meant `aiRec` **never cached**, so ambient triggers (`resolveAIRecs`, `maybeRegenForReadiness`, focus/poll events) kept **re-firing `fetchAI` with no spacing or cap → a retry storm → Supabase connection exhaustion** (the proximate trigger of the ⚠ critical issue above). Fix (all in `public/index.html` `fetchAI`): (a) a **diagnostic log** of the full reassembled stream text *before* extraction, so failures are visible; (b) a robust **`extractRecJSON()`** helper — parses the model's raw streamed JSON (the normal new path), **defensively unwraps** the legacy Anthropic envelope if present, strips ` ```json ` code fences, and returns `null` instead of throwing on junk; (c) **bounded retry backoff** — a failure waits **3s** then retries, **capped at 3 total attempts**, then shows the error UI; the pending retry is tracked in **`aiRetryTimer`** so chains don't stack, a success cancels any pending retry, and the manual "Retry" button starts a fresh chain at attempt 1. Committed to `main`. See §3 → Reliability & Resilience.
> - **Voice recording — investigated, no change needed.** A report that the mic stops recording too quickly (request: tap-to-toggle + 3s-silence auto-stop) was investigated and found **already fully implemented**: `recognition.continuous = true` (tap toggles start/stop), `VOICE_SILENCE_MS = 3000` auto-stop after 3s of silence, a pulsing `.mic-recording` state + amber warning pulse + live countdown readout, and all 4 mic entry points routed through the shared `voiceSilenceWatch` watchdog. No code changed.
> - **life-os RLS fix (different project — `shimmyc/life-os`, NOT ApexCoach).** Supabase sent a security alert: `public.tasks` in the **life-os** project had RLS disabled (Security Advisor showed "Policy Exists RLS Disabled" + "RLS Disabled in Public"). Fixed with `ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY` run directly in the life-os SQL editor (the one-liner sufficed because policies already existed); committed to `shimmyc/life-os` `main` (commit `b001d61`, migration `035_tasks_rls.sql`). **Key note:** life-os uses the Supabase **anon key** (not the service role), so RLS **is enforced against the app's own queries** — when enabling RLS there, always **re-assert the policies idempotently**, never just `ALTER TABLE` alone. (ApexCoach is unaffected: its backend uses the **service key**, which bypasses RLS — see §3 → RLS / 2026-05-26 and `CLAUDE.md`.)
> - **Exercise Video / Demonstration Database — architecture decided, NOT started.** Full plan (MuscleWiki primary / ExerciseDB fallback / YouTube tertiary; one-time bulk seed → `exercises_reference` Supabase table; weekly refresh cron; server video-streaming proxy; Library "Exercise Guide" sub-nav; AI rec-card "Watch" CTA; equipment-filtered + "similar exercises") is captured in §7 → Near term.
>
> **2026-05-29 session** (macro roadmap UI + 7-day smart schedule preview + micro-goal tracking fixes):
> - **Macro Roadmap UI — ✅ COMPLETE** (was the last "pending" item in §7). The Profile tab now renders the structured `roadmap_data` via `renderRoadmapData()` into `#roadmap-data-card` (phase-card UI: Fraunces timeline, COVERS pills, 3 near-term cards with progress bars + ember left-border on the current phase, 2 horizon cards, GAPS/WHAT'S WORKING callouts, collapsible adaptation log, footer). **Auto-generates on first load** when `roadmap_data` is null (spinner → manual Generate fallback on failure). Server `GET /roadmap-data` now derives phase status from dates (`recomputeRoadmapProgress`, shared with per-goal roadmaps); `MACRO_ROADMAP_SYS` hard-requires `goals_summary[]` + `milestone` + `estimated_range`. Legacy `renderRoadmapContent()` kept but no longer called.
> - **7-Day Smart Schedule Preview — ✅ NEW.** `POST /api/profiles/:id/week-preview` (`schedule_preview` → Haiku): a rolling-7-day rule engine (`buildWeekSkeleton`) — anchors locked, frequency targets placed by a recovery-aware scorer (`MUSCLE_GROUP_MAP`, 48h windows), add-ons on training days, stackable-flag exception, carry-forward of missed targets — then Haiku per-day coaching notes. Client renders a compact 7-row preview inside `#schedule-card` above a now-collapsible blueprint (`bp-collapsed`). See §3 + `CLAUDE.md`.
> - **Micro-goal tracking fixes** — `strength_milestone` branches on `target_unit` (weight/time/reps/distance, unknown → null); `mgIsAspirationalEntry()` skips goal-statement notes; `daily_habit` unions exercise-row days with workout-notes days (`mgHabitDaySources`/`mgWorkoutTextMatches`); frequency-target done-counting uses the exercises table (≥2 distinct mapped exercises), never `workout.type`, and grip_forearms-only exercises (Dead Hang) never count. See §3.
>
> **2026-05-26 session** (Google Health API v4 + frontend + platform):
> - **Google Health API v4 integration** — full cloud-REST adapter (`wearables/google_health.js`) replacing the obsolete on-device Health Connect stub: OAuth2 (`/callback/google_health` + `/api/wearables/callback/google_health` alias), `fetchDailyData` (HRV / RHR / sleep stages / steps / AZM / weight), exercise import on both surfaces (auto-match-on-save + unmatched card), the Fitbit-sunset reconsent banner, and migration `2026-05-26_google_health.sql` (`provider_metadata`). `/daily` prefers Google Health and falls through to Fitbit. See §3 / §5 / §9.
> - **Living Goal Roadmap UI** — per-goal drill-down from each goal card: a two-step coached conversation (free-text statement → AI-generated questions → roadmap) renders near-term phase cards with progress bars, horizon phases, an adaptation log, an inline check-in, and Regenerate. Wired to the live per-goal endpoints. JS prefixed `grv*`; CSS scoped to `#goal-roadmap-view`.
> - **Voice input on all textareas** — `startVoice(targetEl, btnEl)` + new `voiceMicBtn()` helper; mics now on every textarea (roadmap statement / answers / check-in, onboarding device follow-up, profile-builder review).
> - **Dynamic schedule (v2)** — `anchors` / `frequency_targets` / `addons` replace the flat day-keyed schedule (legacy auto-migrates). The daily-rec prompt and the empty-state Build-with-AI flow (`callType:schedule_builder`, Haiku) were rewritten for v2.
> - **ApexCoach logo + PWA branding** — `public/logo.png` + `public/manifest.json` wired into the favicon, apple-touch-icon, CSS splash screen, profile-selector header, and desktop nav header.
> - **Row Level Security** — enabled on all 11 Supabase tables with a `service_role_bypass` policy each; public anon access closed.
>
> **2026-05-22 session** (all backend-complete; roadmap UI pending — see §7):
> - **Living Goal Roadmaps + structured Macro Roadmap** — exercise-grounded phased roadmaps (3 near_term + 2 horizon), generated by Sonnet, adapted weekly by the unified `maybeAdaptAllRoadmaps()` (Haiku). New `roadmap_data` jsonb columns; per-goal roadmaps live on `profile_data.goals[]`.
> - **Auto-import on workout save** — `findWearableMatchOnSave()` returns the best same-day Fitbit candidate; client prompts via `#wm-modal`.
> - **Unmatched Fitbit Activities card** — Today-tab card over the last 7 days; replaces the `fitbit_pending_imports` flow. New `dismissed_fitbit_activities` jsonb column.
> - **Migrations added:** `2026-05-22_roadmap_data.sql`, `2026-05-22_dismissed_fitbit_activities.sql`.

---

## 1. Project Overview

**ApexCoach** is an AI-powered personal fitness coaching web app. Users connect a wearable
(Fitbit or Google Health API v4), which auto-syncs sleep / HRV / RHR / zone minutes daily. A regression-fitted
readiness formula scores recovery (0–100), and Claude generates specific daily workout
recommendations from biometrics, training history, goals, and short-horizon "challenges."

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express — single file `server.js` |
| Frontend | Vanilla HTML/CSS/JS single-page app — `public/index.html` |
| Database | Supabase (PostgreSQL), accessed via PostgREST (`/rest/v1/...`) |
| AI | Anthropic Claude via `/api/ai` proxy — **Haiku** (`claude-haiku-4-5-20251001`) for cheap tasks, **Sonnet** (`claude-sonnet-4-6`) for smart tasks. Model is chosen **server-side** from a `callType` field; clients can't request the expensive model. System prompts auto-wrapped with `cache_control: ephemeral`. **`callType:"daily_recs"` is streamed** (Anthropic SSE → chunked `text/plain`) to survive Render's request window — see §3 → Reliability & Resilience (2026-06-18). |
| Wearables | Provider-agnostic adapters in `wearables/` — **Fitbit** + **Google Health API v4** fully implemented (both OAuth2 + auto-refresh). Apple Health / Samsung / Garmin are stubs. |
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
| `profile_data` | jsonb | goals, injuries, schedule, equipment, `ai_prompt_context`, `onboarding_complete`, `avatar_image`, `settings.*`. **Long-term goals live here at `profile_data.goals[]` — there is no separate `goals` table.** Each goal carries `id` (uuid, backfilled by `ensureGoalIds()` on every profile GET) and, once a Living Goal Roadmap is built: `intake_questions[]` (`{question,key}`), `intake_answers[]` (`{question,key,answer}`), `intake_completed` (bool), `roadmap{}` (structured — `timeline_range`, `timeline_note`, `date_confidence`, 3 `near_term` + 2 `horizon` `phases[]`, `version`, `adaptation_log[]`; full shape in §7 + `CLAUDE.md`), `last_adapted_at` (ISO ts). Sanitized via `cleanProfileData()` on read+write. |
| `fitbit_access_token`, `fitbit_refresh_token`, `fitbit_expires_at` | text / bigint | Live Fitbit token store (rotating). Mirrored ↔ `wearable_connections`. |
| `coaching_brief`, `historical_brief`, `historical_brief_updated_at` | text / ts | Three-tier coaching memory |
| `roadmap`, `roadmap_updated_at` | text / ts | LEGACY free-text macro road map (still used by current client) |
| `roadmap_data`, `roadmap_data_updated_at` | jsonb / ts | Structured macro road map (ties all goals; served by `/roadmap-data`) |
| `daily_recommendations` (jsonb), `daily_recommendations_date` (date), `daily_recommendations_readiness` (int) | | Daily rec cache |
| `progress_brief` (jsonb), `progress_brief_date` (date) | | Progress brief cache |
| `height_inches`, `birth_date`, `sex`, `goal_weight_lbs`, `goal_weight_timeline_months` | | Body-composition profile fields |
| `gym_access` | text | `yes` / `no` / `sometimes` |
| `gym_type` | text | Commercial gym / Home gym / CrossFit / functional fitness / Multiple |
| `dismissed_fitbit_activities` | jsonb (default `[]`) | Global wearable-activity dismissals — array of namespaced `"provider:id"` strings (e.g. `fitbit:…` or `google_health:…`) hidden from the Unmatched Wearable Activities card (§3). Migration `2026-05-22_dismissed_fitbit_activities.sql`. |
| `fitbit_pending_imports` | jsonb | **Deprecated** — nothing writes to it anymore (the daily-sync `diffAndQueueFitbitImports()` call was removed). Replaced by `dismissed_fitbit_activities` + the Unmatched Fitbit card (see §9). |
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
| `provider_metadata` | jsonb (default `{}`); Google Health stores `{healthUserId, legacyUserId}` from `getIdentity`. Migration `2026-05-26_google_health.sql`. |
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
- `migrations/2026-05-22_roadmap_data.sql` — adds `profiles.roadmap_data` (jsonb) + `roadmap_data_updated_at` (timestamptz) for the structured macro roadmap. Legacy `profiles.roadmap` (text) is kept.
- `migrations/2026-05-22_dismissed_fitbit_activities.sql` — adds `profiles.dismissed_fitbit_activities` jsonb (default `[]`) for global wearable-activity dismissals (workout-agnostic, because `rejected_wearable_matches.workout_id` is `NOT NULL`).
- `migrations/2026-05-24_daily_sleep.sql` — adds the `daily_sleep` table (Life OS sleep fast-path; see `CLAUDE.md`).
- `migrations/2026-05-26_google_health.sql` — adds `wearable_connections.provider_metadata` jsonb (default `{}`) for the Google Health API v4 integration (stores the stable Google Health identity).

> Most other tables/columns were created ad-hoc via the Supabase SQL editor (the `CREATE TABLE`/`ALTER TABLE` snippets are documented inline in `CLAUDE.md`). Only the wearables + the 2026-05-22 / 2026-05-24 / 2026-05-26 migrations are committed as files.

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
- **Living Goal Roadmaps + Macro Roadmap (backend)** — per-goal AI intake → phased roadmap (3 `near_term` + 2 `horizon`, Sonnet) and a structured `roadmap_data` macro roadmap tying all goals together. Both are grounded in the athlete's real logged training via `getGoalExerciseContext()` / `getFullExerciseContext()` and adapted weekly by the unified `maybeAdaptAllRoadmaps()` (Haiku). `progress_pct` is computed on read (`computePhaseProgress()`, capped at 90), never stored. Per-goal roadmap UI built (2026-05-26) and macro-roadmap UI built (2026-05-29) — see the next two bullets. (`b477682`, `bc46c57`)
- **Living Goal Roadmap UI** — ✅ 2026-05-26. Drill-down from each goal card into a full-screen sub-view (`#goal-roadmap-view`, JS prefixed `grv*`): a two-step coached conversation (free-text statement → AI-generated questions → roadmap generation) renders near-term phase cards with progress bars + `weekly_targets` + `completion_signals`, horizon phase cards, a collapsible adaptation log, an inline check-in, and a Regenerate action. Progress bars cap at 90% until completion signals are met (never fake 100%). Wired to the live per-goal endpoints (`GET/POST .../intake`, `POST .../roadmap`, `POST .../checkin`). CSS scoped under `#goal-roadmap-view`. (See `CLAUDE.md` → "Living Goal Roadmaps (Per-Goal)" → Frontend drill-down UI.)
- **Macro Roadmap UI** — ✅ **2026-05-29** (was the last pending roadmap-UI item). The Profile tab renders the structured `profiles.roadmap_data` macro roadmap as a phase-card UI in `#roadmap-data-card` (`renderRoadmapData()` + `rdEmptyHtml`/`rdLoadedHtml`/`generateRoadmapData`/`rdAskRegen`/`rdToggleLog`; CSS scoped to `#roadmap-data-card .rd-*`): Fraunces `timeline_range` + note, `COVERS` `goals_summary` pills, **3 near-term phase cards** (status badge, progress bar capped at 90% unless complete, ember left border on the current phase, `weekly_targets`, `completion_signals` ☐/☑, `goal_connections` pills), **2 horizon cards** (`milestone` + `estimated_range`), `GAPS TO ADDRESS` / `WHAT'S WORKING` callouts, a collapsible adaptation log, and a `Generated … · v[version]` footer. **Auto-generates on first view** when `roadmap_data` is null (in-card spinner; falls back to a manual Generate button only if generation fails). Inline Yes/Cancel Regenerate (no modal). Server-side, `GET /roadmap-data` now derives near-term phase **status from dates** (`recomputeRoadmapProgress()`, shared with per-goal roadmaps: `end_date<today`→complete, first `start≤today≤end`→current w/ `progress_pct`, else upcoming), and `MACRO_ROADMAP_SYS` hard-requires `goals_summary[]` + `milestone` + `estimated_range` on every horizon phase. The legacy `renderRoadmapContent()` text card is kept but no longer called. (`ddcf06e`, `44f955a`)

### Active Challenges (Micro-Goals)
- **Daily habit card** — started date, X/Y days, completion %, tiered color coding (≥85% green, 65–84% yellow, <65% red) (`e8b7cfe`, `44e7c39`)
- **Timeline progress bar** — days elapsed / total goal days (`44e7c39`)
- **"Updated Xm ago" stamp** on each card (`466588c`)
- **Personal-best cards** with M:SS display
- **Refresh button** — refreshes both challenges and goals; fixed stale UI (`8c9ad2e`)
- **AI integration** — ACTIVE CHALLENGES block woven into every daily rec
- **Auto-tracking fixes** (2026-05-29) — server recomputes `current_value` more accurately: `strength_milestone` branches on `target_unit` (**weight** lbs/kg → max `weight_lbs`; **time** seconds/minutes → max parsed hold duration; **reps** → max single-set reps; **distance** miles/km → longest `distance_miles`; **unknown unit → null**). `mgIsAspirationalEntry()` skips goal-statement rows (e.g. "Dead Hang - work toward 2:00 goal") in time-based milestones so a target note isn't read as a logged hold. `daily_habit` day-counting unions exercise-row days with **workout-notes** days (`mgHabitDaySources` + `mgWorkoutTextMatches`, word-boundary guarded) so a session the AI extractor missed still counts. (See `CLAUDE.md` → "Active Challenges (Micro-Goals)".)

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
- **Fitbit adapter** (full) + **Google Health API v4 adapter** (full — cloud REST, Fitbit successor; see next bullet); Apple Health / Samsung / Garmin (stubs)
- **Google Health API v4 integration** (2026-05-26) — full implementation replacing the obsolete on-device Health Connect stub. Cloud REST adapter for `health.googleapis.com/v4/` (the **Fitbit Web API successor**, NOT the on-device Android Health Connect SDK, which has no cloud API).
  - **Adapter** (`wearables/google_health.js`, complete rewrite): `buildAuthUrl` (Google OAuth 2.0, `access_type=offline`, three `googlehealth.*.readonly` scopes), `refreshToken` (keeps the old refresh token when Google omits it on refresh), `fetchActivities` (paginated exercise dataPoints → `NormalizedActivity`, `mapExerciseType` helper), `fetchActivityDetail` (peak HR from the heart-rate sample series), `fetchDailyData` (HRV via list `page_size=1`, RHR via list `page_size=1`, sleep via `:reconcile` with the `metadata.main` filter, steps via `dailyRollUp` → `rollupDataPoints[0].steps.countSum`, AZM via `dailyRollUp` summing `sumInCardioHeartZone`+`sumInPeakHeartZone`+`sumInFatBurnHeartZone` across all `rollupDataPoints`, weight via list), `getIdentity`, `normalize`.
  - **OAuth routes:** `GET /callback/google_health` and `GET /api/wearables/callback/google_health` (alias) both handled by a shared `handleGoogleHealthCallback()`; `redirect_uri` is derived from `req.path` so both routes work. Stores tokens via `saveWearableTokens`, PATCHes `provider_metadata` (`healthUserId` + `legacyUserId`).
  - **Daily sync:** `GET /api/profiles/:id/daily` tries Google Health first using the **local** date (inline IIFE with `getFullYear`/`getMonth`/`getDate`, NOT UTC). Uses the GH response only if at least one of hrv/rhr/sleep/steps is non-null (`hasData` gate); otherwise falls through to Fitbit. Fire-and-forget persistence (`upsertDailySteps`, `upsertBodyMetrics`, `upsertDailySleep`, `estimateSleepScore`). Response shape matches the Fitbit path exactly; `prevZones` maps the real per-zone AZM breakdown `{peak, cardio, fatBurn}`.
  - **Exercise import (both surfaces):** `findWearableMatchOnSave` tries Fitbit first, falls back to Google Health when there's no Fitbit token (auto-match-on-save → `#wm-modal`). `GET /api/profiles/:id/unmatched-fitbit` uses the same Fitbit-first → Google-Health fallback resolution. `POST /api/profiles/:id/dismiss-fitbit-activity` is now provider-agnostic (derives the provider from `body.provider`, else a `<provider>:` prefix on the id, else defaults to `fitbit`).
  - **Reconsent banner:** `showGoogleHealthBanner()` (`public/index.html`) — amber "Fitbit shutting down Sept 2026 → connect Google Health" banner in Settings → Account and on the Profile wearables card when Fitbit is connected but Google Health isn't; shows "✓ Connected via Google Health" once connected; dismissable (banner only); called from `bootApp()`.
  - **UI:** "FETCHING WEARABLE DATA" replaces "FETCHING FITBIT DATA"; per-card activity tags are provider-aware ("FITBIT ACTIVITY" / "GOOGLE HEALTH ACTIVITY"); the `#wm-modal` body copy + link toasts are provider-aware (`wearableLabel()`).
  - **Migration:** `migrations/2026-05-26_google_health.sql` adds `wearable_connections.provider_metadata` (jsonb).
  - **Bugs fixed during implementation:** (1) **redirect_uri mismatch** — `connect/:provider` generates `/api/wearables/callback/google_health` but only `/callback/google_health` existed → added the alias route + derive `redirect_uri` from `req.path`. (2) **HRV/RHR filter** — Daily types don't support `=` or range filters → switched to list `?page_size=1` with date verification. (3) **Steps parse** — `rollupDataPoints` not `dataPoints`; field is `countSum` not `count`. (4) **AZM parse** — `rollupDataPoints`; three separate zone fields, not one. (5) **AZM total** — `|| null` masked a valid `0` → explicit `> 0` check. (6) **Timezone** — `ghDate` used UTC `dateStr(0)` → local-date IIFE. (7) **hasData fallthrough** — GH returns all-nulls before the device syncs each morning → fall through to Fitbit when no data. (8) **dismiss endpoint** — hardcoded `fitbit:` prefix broke GH dismissals → provider-agnostic. (9) **`dateStr` variable shadowing** — the original daily-handler snippet declared `const dateStr` shadowing the module helper and called it in its own initializer (TDZ `ReferenceError`) → renamed to `ghDate`.
  - New env: `GOOGLE_HEALTH_CLIENT_ID` / `GOOGLE_HEALTH_CLIENT_SECRET` (§10). Provider status §5; deprecation/migration tracking §9.
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
- **Auto-import on workout save** — `findWearableMatchOnSave()` runs after `POST /api/workouts` (awaited, capped at 4s via `Promise.race`, fully non-fatal): fetches the day's wearable activities (tries Fitbit first, falls back to Google Health when no Fitbit token), drops already-matched (`workouts.wearable_activity_id`) + rejected (`rejected_wearable_matches` by `profile_id`), scores via `matchWearableToManual()` (threshold ≥40), and returns the single best candidate as `wearable_match` on the save response (omitted on no-match/timeout/no-Fitbit). Client shows the `#wm-modal` "Fitbit Activity Found" prompt 500ms after save → **Yes, Link It** (`POST /api/wearables/merge` → toast + `loadWorkouts()`) or **No, Keep Separate** (`POST /api/wearables/reject` with `create_standalone:false` — records the rejection only, no standalone workout). (`8d18f94`)
- **Unmatched Wearable Activities card** — Today-tab card listing the last 7 days of unmatched **wearable** activities (`GET /api/profiles/:id/unmatched-fitbit`; provider-aware — tries Fitbit first, falls back to Google Health), filtering already-matched + dismissed and attaching each activity's same-day completed-but-unlinked workouts. Per card: **Match to [workout type]** (up to 2) or **Import as New** + **Dismiss** when same-day workouts exist; **Import as Workout** + **Dismiss** otherwise. Match → `/wearables/merge`; Import → `/wearables/import`; Dismiss → `/dismiss-fitbit-activity` (global, silent). Cached once/day in `localStorage.ac_unmatched_fitbit`, invalidated on workout save/merge/reject; skeleton loader while fetching; hidden during previous-day navigation. **Replaced** the `fitbit_pending_imports` client flow (`renderFitbitImportPrompts` / `loadFitbitPendingImports` / `confirmFitbitImport` / `dismissFitbitImport` removed). (`7172681`, `de72c77`)

### Dynamic Scheduling, Voice, Branding & Security (2026-05-26 session)
- **Dynamic schedule system (UI + AI)** — replaced the flat day-keyed schedule with a three-tier **v2** format: `anchors` (fixed day + activity), `frequency_targets` (N×/week with a `suggested_day`), and `addons` (short supplemental work on training days). Legacy format auto-migrates on load. `buildScheduleInstruction()` rewritten for v2 — an anchor day makes Option 1 exactly that session with no exercise breakdown; frequency targets are tracked Mon–today via a `WEEKLY TARGET STATUS` block; add-ons are woven into workout options. `buildVarietyAndSkipAnalysis()` + `buildWeeklyVolumeSummary()` updated for v2. Empty-state **Build with AI** flow (4 inline steps) → `POST /api/ai callType:schedule_builder` → parses the returned v2 JSON → saves. `server.js`: `schedule_builder` → `MODEL_HAIKU`.
- **Voice input on all textareas** — `startVoice()` refactored to accept optional `(targetEl, btnEl)` args (defaults to the log modal for back-compat); new `voiceMicBtn()` helper drops a standard 🎙 button after any textarea. Mics added to: goal-roadmap statement, per-question answer fields, check-in textarea, onboarding device follow-up, and the profile-builder review field.
- **ApexCoach logo + PWA branding** — `public/logo.png` wired into the favicon, apple-touch-icon, a CSS-only splash screen (logo fades in / holds / out on load), the profile-selector header, and the desktop nav header; `public/manifest.json` added (installable PWA — name / icons / theme).
- **Row Level Security (security fix)** — RLS enabled on all 11 Supabase tables (`profiles`, `workouts`, `exercises`, `daily_checkins`, `micro_goals`, `daily_steps`, `body_metrics`, `workout_templates`, `wearable_connections`, `rejected_wearable_matches`, `tokens`), each with a `service_role_bypass` policy. Public anon access closed; the service-key backend is unaffected.

### 7-Day Smart Schedule Preview (2026-05-29)
A rolling Mon-agnostic week preview that turns the v2 schedule into a concrete, recovery-aware plan. (`d4ebcda` and follow-ups; full detail in `CLAUDE.md` → "7-Day Smart Schedule Preview".)
- **Server** — `POST /api/profiles/:id/week-preview` (registered `schedule_preview` → Haiku). Two-step `buildWeekSkeleton()`:
  - **Rule engine (no AI):** a **rolling 7-day window** (today → today+6, NOT fixed Mon–Sun); each day keeps its real weekday so anchors lock to their fixed days inside the window; frequency targets placed by a **recovery-aware scorer**; add-ons attached to every training day; rest fills the rest.
  - **Carry-forward:** target satisfaction is counted from the **start of the current Mon–Sun week** through the window end — met targets stay met; targets missed before today get placed in the rolling window.
  - **`MUSCLE_GROUP_MAP`** — keyword→muscle-group lookup (chest/back/shoulders/biceps/triceps/core/glutes/quads/hamstrings/calves/grip_forearms); builds a per-muscle last-worked map from the last 7d of exercises with a **48h** recovery window per group (`+20` if all required groups recovered, `-20` if any worked <48h ago).
  - **Placement order:** `suggested_day` targets first, then `times_per_week` asc, then strength/martial_arts > cardio > mind_body/rehab.
  - **Stackable flag** — `frequency_targets[].stackable` (bool, default false; keyword-defaulted ON for yoga/mobility/rehab, user-overridable). Non-stackable cap = 1/day; stackable targets may share a day with an anchor or non-stackable target (prefer training days; multiple stackable allowed). **Done-counting uses the exercises table** (≥2 distinct names mapping to the target's muscle groups via `MUSCLE_GROUP_MAP`), never `workout.type`; **grip_forearms-only** exercises (Dead Hang) never count toward any target. **Completed targets appear on their actual day** (`done:true`), never silently dropped.
  - **Haiku enrichment** — S&C-coach persona; per-day `coaching_note` (≤12 words) + a `week_note`; stackable sessions coached as combined blocks. 6s `Promise.race`, non-fatal — returns the bare skeleton on timeout/failure. Response `{ week:[7 days], week_note, generated_at }`.
- **Client** — `renderWeekPreview()` draws a compact 7-row list inside `#schedule-card` above the blueprint: ember left border + `•` on today, `✓` on done past days, muted past rows, `activity · add-on` names, full `week_note` wrapping under the **THIS WEEK** label, and a Refresh link. `loadWeekPreview()` is **cache-first** (`localStorage.ac_schedule_preview` `{date,profileId,data}` → same-day + same-profile = cache hit), called from the top of `renderSchedule()` and `bootApp()`; `invalidateSchedulePreview()` fires from `saveWorkoutToSupabase()`, `deleteWorkout()`, and `schedPersist()`. A **stackable toggle** ("Can be done on the same day as other workouts") sits in the frequency-target editor, keyword-defaulted and saved to the schedule via `schedPersist()`.
- **Blueprint collapse** — the Fixed Days / Weekly Targets / Daily Add-ons editor (`#schedule-grid`) is **collapsed by default** behind a `bp-collapsed` CLASS (survives `renderSchedule()` re-renders, unlike inline style). The "**YOUR TRAINING BLUEPRINT ▸ Edit**" toggle (ember) is the sole Edit entry (the original Edit button is suppressed when chrome is active); only the ✓ Done button shows in edit mode. State persists in `localStorage.ac_schedule_blueprint_open`; `applyBlueprintChrome()` runs at the top of `renderSchedule()`.

### Reliability & Resilience (2026-06-18 session)
A defensive hardening pass after Render-Starter `500`/`504`s and a client-side retry storm. No new user-facing features — all of this is robustness. Full per-item narrative is in the **2026-06-18 session** changelog block at the top of this file.
- **Claude model-string refresh** — retired `claude-sonnet-4-20250514` (deprecated/retired 2026-06-15) → **`claude-sonnet-4-6`** via the single `MODEL_SONNET` constant (all call sites route through `CALL_TYPE_MODEL`). `MODEL_HAIKU` unchanged (`claude-haiku-4-5-20251001`). (`e0cb3e3`)
- **Fitbit fully non-fatal** — `fitGet()` per-call **8s** `AbortController` timeout; **every** `buildDailyData()` Fitbit call `.catch()`-guarded to an empty shape (the 5 previously-unguarded calls fixed) so one failing metric degrades to `null` instead of rejecting the `Promise.all`; new helpers **`emptyWearableData()`** (200-safe `source:"unavailable"` snapshot) + **`withTimeout()`**; `/api/profiles/:id/daily` *and* legacy `/api/daily` wrap token-refresh + `buildDailyData` in try/catch under a **25s** `withTimeout` and return **200 + `emptyWearableData()` + `fitbit_error:true`** on any failure; Google Health fetch wrapped in `withTimeout(8000)` (falls through to Fitbit on timeout). A wearable outage no longer `500`/`504`s — the rec still generates from whatever data is present. Fitbit `403 PERMISSION_DENIED` (weight/fat endpoints) now logs as non-fatal.
- **Daily-recs streaming** — `callType:"daily_recs"` sends `stream:true`; the server `pipeAnthropicStream` helper pipes Anthropic SSE `text_delta` chunks to the client as chunked `text/plain` (per-chunk **20s** idle abort; pre-stream upstream errors returned as JSON with status preserved; all other callTypes unchanged; raw `node-fetch`, **no SDK**). Frontend `fetchAI` reassembles the streamed text and parses it; its abort timer is idle-based (resets per chunk). Fixes the >25s Anthropic generation timing out behind Render Starter.
- **Daily-recs prompt trim** — the "RECENT N-DAY LOG" block condensed to a last-7-day exercise summary (`DATE: EXERCISE (SETS x REPS @ WEIGHT)`, one line per exercise); combined-prompt guard **8000 → 6000 chars** (falls back to 4 days if still over). Request body **14,379 → ~9,730 bytes**.
- **Stream-parse + retry-storm fix** — `fetchAI` now uses a robust **`extractRecJSON()`** (handles the raw streamed JSON, the legacy `{content:[{text}]}` envelope, and ` ```json ` fences; returns `null` on junk) and a **bounded retry** (3s backoff, max 3 attempts, `aiRetryTimer` prevents stacking, success cancels a pending retry, manual Retry resets). This replaces the prior parse-as-envelope path that — on a parse failure — left `aiRec` uncached and let ambient triggers re-fire `fetchAI` **unbounded**, producing the retry storm that exhausted Supabase connections (see the **⚠ critical issue** banner at the top + §6).

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
| GET | `/callback/google_health` · `/api/wearables/callback/google_health` | Google Health OAuth callback (shared `handleGoogleHealthCallback`; `redirect_uri` derived from `req.path`) |
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
| GET | `/api/profiles/:id/unmatched-fitbit` — last-7-day unmatched activities + same-day match candidates; `{activities:[]}` if no token / Fitbit error |
| POST | `/api/profiles/:id/dismiss-fitbit-activity` — body `{provider_activity_id}`; global dismissal → `dismissed_fitbit_activities` |
| POST | `/api/profiles/:id/fitbit-backfill` |
| GET | `/api/profiles/:id/fitbit-pending-imports` ⚠ **legacy** — client no longer calls (see §9) |
| POST | `/api/profiles/:id/fitbit-import` ⚠ **legacy** — client no longer calls (see §9) |

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
| GET/POST | `/api/profiles/:id/daily-recs` · `/progress-brief` · `/roadmap` (legacy text) · `/roadmap-data` (structured macro, Sonnet) |
| POST | `/api/profiles/:id/goal-progress` · `/generate-goal-description` |
| POST | `/api/profiles/:id/week-preview` — 7-Day Smart Schedule Preview (`schedule_preview` → Haiku); body `{schedule, readiness}` → rolling-7-day rule-engine skeleton + per-day Haiku coaching notes; non-fatal (6s cap), returns `{week, week_note, generated_at}` |
| GET/POST | `/api/profiles/:id/checkin` |

### Micro-goals (Active Challenges)
| Method | Path |
|--------|------|
| GET/POST | `/api/profiles/:id/micro-goals` |
| PATCH/DELETE | `/api/micro-goals/:id` |

### Living Goal Roadmaps (per-goal, stored in `profile_data.goals[]`)
| Method | Path |
|--------|------|
| GET | `/api/profiles/:id/goals/:goalId` |
| GET/POST | `/api/profiles/:id/goals/:goalId/intake` |
| POST | `/api/profiles/:id/goals/:goalId/roadmap` (Sonnet; requires completed intake; injects per-goal + full exercise context) |
| POST | `/api/profiles/:id/goals/:goalId/checkin` (Haiku adaptation) |

> Weekly auto-adaptation for BOTH per-goal roadmaps and the structured macro roadmap runs via `maybeAdaptAllRoadmaps()` (fire-and-forget on `POST /api/workouts`, >7-day-stale, shared context fetch).

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

> **Auto-import on save:** `POST /api/workouts` runs `findWearableMatchOnSave()` (≤4s, non-fatal) and returns the best same-day Fitbit candidate as `wearable_match` for the client link prompt. `/reject/:userId` accepts an optional `create_standalone` field: `false` (wm-modal "Keep Separate" path) records only the `rejected_wearable_matches` row; omitted (sync-backlog path) keeps the existing behavior of also creating a standalone workout.

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
| **Google Health (API v4)** | ✅ Implemented | Google Health API v4 (cloud REST). OAuth2, HRV, RHR, sleep stages, steps, AZM, weight, exercise activities. Fitbit + Pixel Watch supported. **September 2026 deadline** for full Fitbit migration. Preferred over Fitbit in `/daily`. (`2026-05-26`) |
| **Apple Health** | 🔲 Stub (TODO) | Needs iOS companion app pattern + Apple Developer account |
| **Samsung Health** | 🔲 Stub (TODO) | Galaxy devices via Samsung Health Data SDK |
| **Garmin** | 🔲 Stub (TODO) | Public API, **OAuth 1.0a** (differs from Fitbit's 2.0) |

> **Universal API note:** On Android, **Google Health Connect** can unify Google/Samsung/most
> Android-14+ device data — activating one Health Connect adapter may cover multiple providers
> without separate Samsung/Pixel integrations. "Open Wearables" (Railway, ~$5/mo) is a longer-term
> unified option covering Garmin/Whoop/Oura/Polar/Apple (via iOS app).

---

## 6. Known Limitations

- **⚠ Supabase "Premature close" on every query (2026-06-18 — UNRESOLVED, app non-functional).** All PostgREST queries (`daily_checkins`, `profiles`, `wearable_connections`, `workouts`, `roadmap_data`, profile data) drop mid-request; the Supabase dashboard shows an **"EXCEEDING USAGE LIMITS"** banner. The Node server is healthy and **AI streaming works** — only Supabase calls fail. Almost certainly **Supabase throttling / soft-pause** triggered by the (now code-fixed) daily-recs **retry storm** spiking connection count/egress. Paid plan (734 Micro Compute Hours, normal egress) so not a free-tier limit; exact exceeded limit not yet identified. **The full symptom list + the start-of-next-session investigation checklist are in the ⚠ banner at the top of this file.** The code root cause is fixed (§3 → Reliability & Resilience → Stream-parse + retry-storm fix); what remains is recovering the Supabase project state, not a code change.
- **Fitbit Server-type app → no intraday HR.** Peak HR falls back to TCX `MaximumHeartRateBpm`, then to a zone-floor estimate. (Confirm the registered app type in the Fitbit dev portal to know which path is active.)
- **Peak HR historical backfill** — a subset of older sessions (~24) only ever yields **estimated** peak values (no measured/sampled peak recoverable).
- **`wearable_connections` redundant double-write** on the OAuth callback (`/callback` calls both `saveProfileTokens` and `saveWearableTokens`) — cosmetic, idempotent, low priority (see §9).
- **Legacy text roadmap is now orphaned** — the Profile tab renders the structured `/roadmap-data` card (2026-05-29), so the client no longer reads or writes the legacy `profiles.roadmap` text via `POST /api/profiles/:id/roadmap`. That endpoint + column are still defined (and `renderRoadmapContent()` is kept) but dead-code; safe to retire (§9). Any pre-existing `profiles.roadmap` text is simply ignored.
- **Horizon-phase `progress_pct` is always 0** — by design: horizon phases have no `start_date`, so `computePhaseProgress()` returns null and the macro/per-goal roadmap UI shows no progress bar for them (only `milestone` + `estimated_range`).

---

## 7. Roadmap — Features To Build

### Near term

**Living Goal Roadmaps + Macro Roadmap** — ✅ **backend rebuilt** (migration `2026-05-22_roadmap_data.sql`); ✅ **per-goal roadmap UI built** (2026-05-26); ✅ **macro-roadmap UI built** (2026-05-29) — feature complete.
- **Per-goal storage:** fields on each goal object in `profile_data.goals[]` jsonb — **no new tables**. New roadmap shape: `{ timeline_range, timeline_note, date_confidence, phases[], generated_at, version, adaptation_log[] }`. Phases = 3 `near_term` (duration_weeks, start/end dates, `weekly_targets[]`, `completion_signals[]`, status, progress_pct) + 2 `horizon` (`estimated_range`, `milestone`). Replaces the old `estimated_completion`/`date_note`/`summary` fields. See `CLAUDE.md` → "Living Goal Roadmaps (Per-Goal)".
- **Macro roadmap (new):** structured `profiles.roadmap_data` jsonb ties ALL goals into one phased plan (`goals_summary[]`, `exercise_gaps[]`, `exercise_highlights[]`, 3 near_term + 2 horizon phases with `goal_connections[]`). `GET/POST /api/profiles/:id/roadmap-data` (Sonnet generate, no intake gate). Legacy free-text `/roadmap` kept for the current client.
- **Exercise grounding:** `getGoalExerciseContext()` + `getFullExerciseContext()` inject the athlete's real logged training (best sets, trend, inactive exercises, category mix, consistency) into every generation/adaptation prompt.
- **Intake flow:** profile-aware (Haiku generates 4–6 targeted questions); `intake_completed` gate before per-goal generation.
- **Progress:** `computePhaseProgress()` estimates a current near-term phase's `progress_pct` from elapsed time (capped 90) + improving-trend bonus; recomputed on read, never stored.
- **Adaptation:** per-goal check-in (user notes) + **unified** weekly auto-adaptation `maybeAdaptAllRoadmaps()` (fire-and-forget on workout save) that adapts both per-goal roadmaps AND the macro roadmap when >7 days stale, sharing one context fetch. Each adaptation increments `version` and appends to `adaptation_log`.
- **Model routing** (`CALL_TYPE_MODEL`): `goal_intake_questions`→Haiku, `goal_roadmap_generate`→Sonnet, `goal_roadmap_adapt`→Haiku, `macro_roadmap_generate`→Sonnet, `macro_roadmap_adapt`→Haiku.

Per-goal roadmap shape (stored on `profile_data.goals[].roadmap`):
```json
{
  "timeline_range": "3-6 months",
  "timeline_note": "Based on your current bench of 180lbs and 3x/week training, you're tracking toward the lower end.",
  "date_confidence": "high|medium|low",
  "phases": [
    { "name": "Phase 1: Build Base", "type": "near_term", "duration_weeks": 6,
      "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD",
      "weekly_targets": ["3x strength sessions", "Add 5lbs to bench weekly"],
      "completion_signals": ["Bench 195lbs", "Consistent 3x/week for 4 weeks"],
      "status": "current|upcoming|complete", "progress_pct": 0 },
    { "name": "Horizon: Peak Strength", "type": "horizon",
      "estimated_range": "6-12 months", "milestone": "Bench 225lbs", "status": "upcoming" }
  ],
  "generated_at": "ISO", "version": 1,
  "adaptation_log": [{ "date": "ISO", "summary": "...", "trigger": "weekly|checkin|manual" }]
}
```
Always 3 `near_term` (4–6 weeks, fixed dates, `weekly_targets`, `completion_signals`) + 2 `horizon` (milestone-based, `estimated_range`, no fixed dates). `date_confidence`: high (<6 mo, clear metrics), medium (6–24 mo), low (multi-year / skill-dependent like belts). `progress_pct` computed on read, never stored.

Macro roadmap shape (stored on `profiles.roadmap_data`):
```json
{
  "timeline_range": "8-15 years",
  "timeline_note": "...",
  "goals_summary": ["Black belt: 8-15 years", "Build muscle: 6-12 months"],
  "phases": [ "...same phase shape as per-goal, plus goal_connections[] on near_term..." ],
  "exercise_gaps": ["No squat sessions in 6 weeks", "Cardio below target"],
  "exercise_highlights": ["Dead hang PR 1:42", "BJJ consistent 3x/week"],
  "generated_at": "ISO", "version": 1, "adaptation_log": []
}
```

- **UI status:**
  - **✅ Per-goal roadmap UI (built 2026-05-26)** — each Goals & Milestones card has a "View Roadmap →" drill-down into a full-screen sub-view (`#goal-roadmap-view`, JS prefixed `grv*`): a two-step coached conversation (free-text statement → AI-generated questions → roadmap generation), near-term phase cards (progress bar + `weekly_targets` + `completion_signals`), horizon cards (`milestone` + `estimated_range`), a collapsible `adaptation_log`, an inline check-in (→ `POST .../checkin`, roadmap updates in place), and Regenerate. Progress bars capped at 90% until completion signals met (never fake 100%). Wired to the live per-goal endpoints. See `CLAUDE.md` → "Living Goal Roadmaps (Per-Goal)" → Frontend drill-down UI.
  - **✅ Macro roadmap card (Profile tab) — built 2026-05-29.** Replaced the static text roadmap card with `renderRoadmapData()` in `#roadmap-data-card`: Fraunces `timeline_range`, `COVERS` `goals_summary` pills, 3 near-term phase cards (progress bars, ember left border on the current phase) + 2 horizon cards, `exercise_gaps`/`exercise_highlights` callouts, collapsible adaptation log, footer. **Auto-generates on first view** (spinner → manual Generate fallback). Phase status derived server-side from dates; weekly auto-adaptation already runs. See §3 → Goals & Milestones and `CLAUDE.md` → "Macro Roadmap".
  - **🔲 Progress bars on long-term goal cards** — each Goals & Milestones card shows a progress bar driven by the existing goal-progress system + roadmap `progress_pct`.

**Auto-import on workout save** — ✅ **built** this session (see §3 → Wearable Integration): the server returns the best same-day Fitbit candidate on save and the client prompts to link it via `#wm-modal`.

**Unmatched Fitbit Activities card** — ✅ **built** this session (see §3 → Wearable Integration): persistent Today-tab card over the last 7 days; replaced the `fitbit_pending_imports` flow.

**Dynamic schedule (v2: anchors / weekly targets / add-ons)** — ✅ **built** this session (UI + AI). Replaced the flat day-keyed schedule; the daily-rec prompt and the Build-with-AI empty state were rewritten for v2 (see §3 → Dynamic Scheduling… and `CLAUDE.md` → "Weekly Schedule (v2…)").

**Voice input on all textareas** — ✅ **built** this session. `startVoice(targetEl, btnEl)` + `voiceMicBtn()` helper; mics on every textarea (see §3).

**ApexCoach logo + PWA branding** — ✅ **built** this session (favicon, apple-touch-icon, CSS splash, profile-selector + desktop nav headers, `public/manifest.json`).

**Row Level Security** — ✅ **enabled** this session on all 11 Supabase tables with a `service_role_bypass` policy each; public anon access closed.

**Exercise Video / Demonstration Database** — 🔲 **planned 2026-06-18 (architecture decided, implementation NOT started).** A searchable exercise guide with video/GIF demonstrations, surfaced in the Library tab and linked from AI rec cards.
- **Sources (tiered):**
  - **Primary — MuscleWiki API** (`api.musclewiki.com`): 1,900+ exercises, 7,500+ video demonstrations, 45 muscle groups, filterable by muscle group + equipment. Requires the **$10/mo TESTING plan minimum** for direct API access (free tier = playground only, no code access). Videos are served through **authenticated endpoints** → a **server proxy is required** (cannot embed the raw URL).
  - **Secondary — ExerciseDB** (`exercisedb.io` via RapidAPI): ~1,300 exercises, GIF demonstrations, **has a free tier with direct API access**. Fallback when an exercise isn't found in MuscleWiki.
  - **Tertiary — YouTube** embed links (optional "deep dive" per exercise).
- **Architecture (cache-first, near-zero live API calls):**
  - **One-time bulk seed** — hit the MuscleWiki API once, pull all ~1,900 exercises into a new Supabase **`exercises_reference`** table.
  - **Weekly refresh cron** — re-sync to catch new exercises (~50 calls/week).
  - All browsing / filtering / search runs **against the local Supabase cache** — zero API calls for data queries. The **only** live API calls are video streaming (server proxy with the auth key).
  - **"Similar exercises"** = filter the cached table by same primary muscle + equipment category — no extra API calls.
  - **Equipment filter** — the user's `equipment[]` Profile setting auto-filters the exercise guide.
  - **AI integration** — when the AI recommends an exercise by name, match it against `exercises_reference`; on a hit the rec card gets a tappable **"Watch" CTA** opening the video + instructions.
  - **UI location** — Library tab, new **4th sub-nav section "Exercise Guide"**, plus a **"Show me similar exercises"** action surfacing alternatives with the same muscle group + movement pattern.
- **Not yet implemented:** the `exercises_reference` Supabase schema, the bulk-seed endpoint + weekly cron, the server video-streaming proxy, the frontend Exercise Guide UI, and the AI rec-card "Watch" CTA integration.

**Front-end redesign** — in progress in a separate chat.

### Next up

- **Apple HealthKit / iOS integration** — opens the app to all iPhone users. Requires an iOS companion app + an Apple Developer Account ($99/yr). Long-term but high impact.
- **Wearable Sync bulk-review modal — Google Health support.** The bulk-review modal (`openWearableSync`, `wsState.provider`) is currently **Fitbit-only**; it needs a provider picker so Google Health activities surface in the bulk backlog review UI. The `sync-backlog` endpoint is already provider-agnostic — this is UI-only.
- **Today tab declutter** — above the fold should be only: readiness score + sleep score + "how are you feeling" tap + workout rec. Body metrics moves to Profile; Recent Workouts removed from Today.
- **Profile tab cleanup** — too cluttered; needs breathing room and reorganization.
- **Logo transparent background** — regenerate `public/logo.png` with a transparent background so the figure floats on the app background instead of sitting in a black box.

> ✅ **Done 2026-05-29:** Macro roadmap UI (structured phase-card card, auto-generating — see Near-term) and the **7-Day Smart Schedule Preview** (§3) both shipped.

### Medium term
- **Garmin** adapter (OAuth 1.0a).
- **Peak HR:** revisit once Health Connect is available (fewer API restrictions than Fitbit Server-type).
- Apple Health adapter is in **Next up** (above); Google Health is ✅ done (API v4 — see §3 / §5).

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

- [ ] **Drop the deprecated `fitbit_pending_imports` queue.** `diffAndQueueFitbitImports()` was removed from the daily sync (2026-05-22), so nothing writes the column anymore. The `GET /api/profiles/:id/fitbit-pending-imports` + `POST /api/profiles/:id/fitbit-import` endpoints are kept but the client no longer calls them (replaced by the Unmatched Fitbit Activities card). Safe to drop the column + both endpoints once confirmed no active profile depends on it.
- [ ] **Retire the legacy text roadmap (now unblocked).** The frontend migrated to the structured `/roadmap-data` card on 2026-05-29, so `profiles.roadmap` (text), `GET/POST /api/profiles/:id/roadmap`, and the client fns `loadRoadmap`/`renderRoadmapContent`/`generateRoadmap` (+ the hidden `#roadmap-card`) are now dead code. Remove the endpoint + client fns and drop the column once confirmed no external consumer reads it.
- [ ] **Drop the redundant `saveWearableTokens` call** in the `/callback` OAuth handler — `saveProfileTokens` now mirrors into `wearable_connections`, so the explicit second write is redundant (idempotent, harmless).
- [ ] **Add `workouts.duration_minutes` column** so manual session durations count in analytics without relying on summed `exercises.duration_minutes`.
- [ ] **Rename `?max_intraday=` → `?max_calls=`** in `/api/debug/backfill-wearable-hr` (the budget now covers TCX **+** intraday calls, not just intraday). Keep `max_intraday` as an alias for back-compat.
- [ ] **Retire the legacy `tokens` table** path once confirmed no profile depends on it.
- [ ] **Regenerate the logo with a transparent background.** `public/logo.png` currently has a solid (black) background; a transparent PNG would let the figure float on the app background instead of a black box. (Also tracked in §7 → Next up.)
- [ ] **Drive Fitbit → Google Health migration before the Sept-2026 shutdown.** The Google Health API v4 adapter is ✅ built (§3); the remaining work is getting every active Fitbit profile to reconnect via the reconsent banner so no one loses sync at cutover.
- [ ] **Drop the Fitbit adapter + legacy Fitbit paths after September 2026** once all active profiles have migrated to Google Health: remove the `profiles.fitbit_*` columns, the legacy `/auth` + `/callback` routes, `buildDailyData` / `runFitbitBackfill`, the `getValidProfileToken` Fitbit special-case inside `getValidWearableToken`, the Fitbit-first preference logic in `findWearableMatchOnSave` + the `unmatched-fitbit` endpoint, and the `wearables/fitbit.js` adapter.
- [ ] **Timezone verification — Google Health daily fetch.** The local-date fix (inline IIFE using `getFullYear`/`getMonth`/`getDate` instead of UTC `dateStr()`) appears to work, but logs still occasionally show a UTC date. Verify it applies correctly across timezone edge cases, particularly around midnight in negative-offset timezones.
- [ ] **Google Health weight returns null** in testing — verify once a user logs weight in the Fitbit/Google Health app. The `weightGrams / 453.592` lb conversion is implemented in `fetchDailyData`.

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
| `GOOGLE_HEALTH_CLIENT_ID` | ✅ Required | Google Cloud OAuth 2.0 client id (Google Health API v4) |
| `GOOGLE_HEALTH_CLIENT_SECRET` | ✅ Required | Google Cloud OAuth 2.0 client secret (Google Health API v4) |
| `ADMIN_SECRET` | ⚠ Recommended | Gates `/api/debug/*` admin endpoints when set |
| `PORT` | optional | Server port (Render injects this) |
| `FITBIT_ACCESS_TOKEN` | legacy | Single-user fallback token (pre-multi-profile) |
| `FITBIT_REFRESH_TOKEN` | legacy | Single-user fallback refresh token |

> **⚠ Correction:** the Anthropic key env var is **`ANTHROPIC_KEY`**, not `ANTHROPIC_API_KEY`.
> If you set `ANTHROPIC_API_KEY` on Render, the AI proxy will not pick it up.
