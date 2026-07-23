# ApexCoach — Project Context

> See [`ROADMAP.md`](ROADMAP.md) for the project source of truth — full schema, all endpoints, features built (with commit refs), provider status, roadmap, onboarding flow, tech debt, and env vars. This file holds the deep implementation notes; `FORMULAS.md` holds the readiness/sleep math.
>
> **§0 of [`ROADMAP.md`](ROADMAP.md) holds the operating conventions (communication contract, hard guardrails, session start/close-out workflows) — read it before any session begins.**

## What This Is

ApexCoach is a personalized AI fitness coaching web app. Users connect their Fitbit, which auto-syncs sleep/HRV/RHR/zone minutes daily. A custom readiness formula scores recovery (0-100), and Claude AI gives specific daily workout recommendations based on biometrics and training history.

## Tech Stack

- Frontend: Vanilla HTML/CSS/JS in public/index.html (single page app)

- Backend: Node.js + Express in server.js

- Database: Supabase (PostgreSQL)

- AI: Anthropic via /api/ai proxy. Smart tasks (daily recs, briefs, roadmap, onboarding, profile builder, coach chat) use `claude-sonnet-4-6`; cheap tasks (format, workout title, extract, progress brief, goal description/estimate, exercise insight, chat summarize) use `claude-haiku-4-5-20251001`. Model is selected server-side from a `callType` field the client sends — the client cannot request an expensive model (an unknown/missing callType logs a warning and falls back to Sonnet). The `/api/ai` proxy also auto-wraps any string `system` prompt with `cache_control: ephemeral` for prompt caching (~90% discount on repeat input tokens); this wrapping is factored into `wrapSystemWithCache()` so server-assembled prompts (coach chat) share the exact same caching logic without going through the proxy itself.

- Fitbit: OAuth2 with auto token refresh

- Hosting: Render.com (auto-deploys from GitHub)

- Repo: github.com/shimmyc/apexcoach-backend

## Supabase Tables

- profiles: id, name, pin (sha256 hashed), avatar_color, profile_data (jsonb), fitbit_access_token, fitbit_refresh_token, fitbit_expires_at, coaching_brief (text), historical_brief (text), historical_brief_updated_at (timestamp), roadmap_data (jsonb — structured macro roadmap, served by /roadmap-data), roadmap_data_updated_at (timestamptz), daily_recommendations (jsonb), daily_recommendations_date (date), daily_recommendations_readiness (int), progress_brief (jsonb), progress_brief_date (date), height_inches (numeric), birth_date (date), sex (text), goal_weight_lbs (numeric), goal_weight_timeline_months (int), gym_access (text: yes/no/sometimes), gym_type (text: Commercial gym/Home gym/CrossFit/functional fitness/Multiple), dismissed_fitbit_activities (jsonb — array of namespaced "fitbit:<id>" strings the user dismissed from the unmatched-activities card), timezone (text — IANA identifier e.g. `America/Chicago`, nullable, no default; silently captured client-side by `captureTimezoneIfNeeded()`, consumed by `localToday()`; see "Athlete Timezone" below), created_at — **`roadmap` (text) / `roadmap_updated_at` and `fitbit_pending_imports` (jsonb) are fully retired, code AND columns**: all reading/writing code was deleted 2026-07-17 (see "Tech Debt Batch" below), and `migrations/2026-07-17_drop_legacy_roadmap.sql` / `migrations/2026-07-17_drop_fitbit_pending_imports.sql` have both been **run in production** (confirmed 2026-07-17) — neither column exists anymore.

- chat_threads: id, profile_id (fk → profiles, UNIQUE — one thread per profile), summary (text, nullable), summary_through_message_id (bigint, nullable), created_at, updated_at. See "Coach Chat" below.

- chat_messages: id, thread_id (fk → chat_threads), role (user|assistant), content (text), created_at. Full history kept forever; summarization never deletes rows. See "Coach Chat" below.

- chat_proposals: id, thread_id (fk), message_id (fk, nullable — backfilled post-stream), tool_use_id, type (update_goal|set_focus_override|log_checkin_note), payload (jsonb), status (pending|confirmed|canceled), created_at, resolved_at. See "Coach Chat Tool Use" below.

- workout_templates: id (bigint identity pk), profile_id (fk → profiles, on delete cascade), name (text), type (text), notes_template (text), exercises (jsonb), use_count (int default 0), created_at (timestamptz). Saved routines surfaced as ▶ Use buttons on Today and a manager on Profile.

- workouts: id, date, type, notes, done, mobility, med, ts, profile_id

- exercises: id, profile_id, workout_id (FK → workouts.id, `ON DELETE CASCADE`, `exercises_workout_id_fkey`, added `migrations/2026-07-17_exercises_workout_fk_cascade.sql`, **run in production 2026-07-17** — nullable, `extract-exercises` can insert a null `workout_id`, which is always FK-valid and never reached by the cascade), date, name, category (strength/cardio/martial_arts/mind_body/rehab/sports/other), main_category (same as category, normalized), subcategory (specific sub-type), sets, reps, weight_lbs, distance_miles, duration_minutes (**`numeric(6,2)` since `migrations/2026-07-19_exercises_duration_numeric.sql`, run in production 2026-07-19** — was `integer`, which silently rejected the fractional values the extraction prompt emits for sub-minute holds and destroyed those rows; see "AI Temperature Policy" / "Exercise-Row Recovery" below), notes, raw_text, created_at (**no `updated_at`; the parent `workouts` table has no audit columns at all — see ROADMAP §6**)

- daily_checkins: id, profile_id, date (text, YYYY-MM-DD), energy (text), soreness (text[]), severity (text), checkin_text (text), created_at. UNIQUE(profile_id, date) for upsert.

- micro_goals: id (**integer pk — NOT uuid**; corrected 2026-07-22 against live data, rows read id `1` and `2` as JSON numbers. Both this file and `ROADMAP.md` §2 previously claimed `uuid PRIMARY KEY DEFAULT gen_random_uuid()`, and the "Supabase setup" snippet further down this file still shows that uuid DDL — it does **not** match the live table and must not be used to recreate it), profile_id (fk → profiles), title (text), type (text: daily_habit | weekly_frequency | cumulative_volume | strength_milestone | skill_technique | streak | recovery_balance), target_value (numeric), target_unit (text), period (text: daily | weekly | monthly | custom), end_date (date, nullable), current_value (numeric default 0), is_active (boolean default true), created_at (timestamp default now()).

- daily_steps: id (bigint identity pk), profile_id (fk → profiles, on delete cascade), date (date), steps (int), calories (int), distance_miles (numeric), floors (int), source (text default 'fitbit' — **threaded from the real provider since 2026-07-20 (session #31)**; was hardcoded `'fitbit'` on every write, mislabeling all Google-Health-sourced rows. Rows written before that date cannot be corrected — see ROADMAP §6), created_at (timestamptz default now()). UNIQUE(profile_id, date). Upserted nightly from Fitbit sync; powers history-tab step pills, Library 30-day chart, and step-goal context in the AI rec prompt.

- body_metrics: id (bigint identity pk), profile_id (fk → profiles, on delete cascade), date (date), weight_lbs (numeric), body_fat_pct (numeric), bmi (numeric), source (text default 'manual', also 'fitbit'), created_at (timestamptz default now()). UNIQUE(profile_id, date). Stores weight / BF% / BMI history. Upserted from `/1/user/-/body/log/{weight,fat}/date/today.json` via Fitbit sync, or manually via the Today-tab "Log Weight" modal. BMI is computed server-side as `(weight_lbs / height_inches²) × 703` when `profiles.height_inches` is set.

- daily_sleep: id (bigint identity pk), profile_id (fk → profiles, on delete cascade), date (date), hours (numeric(4,2)), score (int — the COMPUTED personal sleep score, NOT Fitbit's), deep_minutes / rem_minutes / light_minutes / wake_minutes (int), hrv (numeric(6,2)), rhr (int), source (text default 'fitbit' — **threaded from the real provider since 2026-07-20 (session #31)**, labeled by the row's SLEEP source; `upsertDailyVitals` stamps it on INSERT only, never PATCH. See "Provenance: threading the real provider into `source`" below), created_at (timestamptz default now()). UNIQUE(profile_id, date). Upserted nightly from the Fitbit sync (`GET /api/profiles/:id/daily`) and on the `life-os-summary` fallback path. Powers the Life OS fast path: `life-os-summary` reads this first and returns sleep/HRV/RHR instantly with no live Fitbit call once the day's row exists. See migration `2026-05-24_daily_sleep.sql`.

- exercise_catalog: id, canonical_name (UNIQUE), aliases (text[]), family (text, consumed by Library family rollups), muscle_groups_primary/secondary (text[], consumed by the muscle-group filter + heatmap), equipment (text[], not yet consumed), category (matches exercises.main_category taxonomy), is_duration_based (bool), source (musclewiki|custom|wger), musclewiki_id (nullable — reserved for a future MuscleWiki video layer), wger_id (nullable, unique when set — added 2026-07-16). Not per-profile — one shared catalog, ~880 rows (wger-seeded). See "Exercise Canonicalization" + "Exercise Canonicalization Phase 2" below.

## Row Level Security (RLS)

Row Level Security is enabled on the original **11 Supabase tables** (2026-05-26): `profiles`, `workouts`, `exercises`, `daily_checkins`, `micro_goals`, `daily_steps`, `body_metrics`, `workout_templates`, `wearable_connections`, `rejected_wearable_matches`, `tokens` — **plus 3 more added 2026-07-15 for Coach Chat** (`chat_threads`, `chat_messages`, `chat_proposals`) **and 1 more added 2026-07-15 for exercise canonicalization** (`exercise_catalog`) — **and `daily_sleep`, the 16th table**, confirmed missing during the first 2026-07-16 doc-sync audit (its migration has no RLS statements) and fixed the same day: RLS + `service_role_bypass` applied manually via the Supabase SQL editor, no committed migration, matching how several other tables/columns in this project were created (see ROADMAP.md §2's note). Each table has a `service_role_bypass` policy, so the backend — which authenticates with the Supabase **service key** (`SUPABASE_KEY`) — keeps full access while public **anon**-key access is now closed. Because `server.js` talks to PostgREST with the service role, RLS is transparent to the app and no query changes were needed; this closes the prior gap where the anon key could read/write tables directly.

Enabled once in the Supabase SQL editor (representative, repeated per table):
```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_bypass ON <table>
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

## Onboarding Flow (Full-Page Paginated)

New users go through a 7-question full-screen paginated onboarding flow:

- **Screens**: Welcome → 7 Questions → Generating → PIN Creation → Success → Dashboard
- **Questions**: Name, Goal, Injuries, Training Days (pill selector), Fitness Tracker (pill selector w/ follow-up), Experience Level (pill selector), Schedule (optional/skippable)
- **onboardingAnswers object**: `{ name, goal, injuries, days, tracker, trackerDevice, experience, schedule }`
- **UI**: Full-screen overlay (#080a0f bg), slide animations (300ms ease), progress bar (green fill), back navigation with answer preservation
- **PIN creation**: 4-digit bank-style boxes (auto-advance, confirm match, auto-submit)
- **Generating screen**: Pulsing brain emoji, fake progress bar (10s fill), AI profile generation via /api/ai
- **Voice input**: Mic button (🎙) in textarea bottom-right corner on every textarea question
- **Keyboard**: Enter submits (Shift+Enter for newline), visualViewport API for mobile keyboard handling
- **Deep Profile Builder**: Same full-page paginated style used for profile builder sections (Goals, Injuries, Training, Lifestyle, Mindset) on Profile tab. Launched from "Build Profile" completeness card. Uses `#profile-builder-screen` overlay.

## App Structure (public/index.html)

- Profile selector screen on load (PIN protected)

- 4 tabs: Today, History, Library, Profile + floating action button (+) for Log Workout

- Navigation: bottom tab bar on mobile (below 768px) with FAB center button, top horizontal nav on desktop

- Today tab: Fitbit biometrics + readiness score + progress brief + 3 AI workout options. **DOM order (2026-07-16 declutter pass, see "Today Tab + Profile Tab Reorganization" below)**: date/day-nav → conditional banners/status/manual-checkin gate (unchanged) → `#readiness-card` → `#feeling-checkin-card` → `#ai-card` → `#log-past-card` (Log past workout, see "Log Past Workout Panel" below) → then below the fold `#progress-card` (Cornerman) → `#unmatched-fitbit-card` → `#streak-card` → `#log-area`.

- History tab: merged Calendar + Log with toggle buttons. Calendar view: Week/Month with workout dots. List view: collapsible workout cards with sort/filter, "Ask Your History" AI search

- Library tab: Exercise dashboard, exercises list, personal records (Chart.js)

- Profile tab: Dynamic from profile_data JSON - goals, injuries, belt tracker (if martial arts), schedule, philosophy. **DOM order (2026-07-16 declutter pass)**: identity header → Schedule (position unchanged) → identity/body group (Body Metrics, Body, Weight Trend, Sync Wearables) → injuries/philosophy/context → coaching/AI group (Focus Override, Coaching Brief, legacy Roadmap, Macro Roadmap) → goals cluster (Belt, Active Challenges, Goals & Milestones) → Analytics → Templates → Settings/Account. See below for the full breakdown and what moved.

- + button: opens Log Workout modal directly (not a tab) — no type dropdown, just a notes textarea with voice input and quick-log shortcuts (MMA, Walk, Rest Day). Workout type/title is AI-generated from notes on save.

## Today Tab + Profile Tab Reorganization (2026-07-16 declutter pass)

Closes ROADMAP.md §7 priority 5. Pure UI: render-call relocation + CSS/HTML wrapper only — no JS logic, API, data-flow, or endpoint changes. A two-phase audit-then-approve process (Phase 1 report + open questions, Phase 2 implementation) preceded the edits; see git history for the full audit.

**Today tab — target: nothing between the readiness card and the rec except the feeling check-in.** Final order: date/day-nav → `#past-day-banner` (conditional) → `#status-box` (loading) → `#checkin-card` (manual/non-wearable check-in gate, unchanged, mutually exclusive with the rest on a given day) → `#readiness-card` → `#feeling-checkin-card` → `#ai-card` → `#progress-card` (Cornerman) → `#unmatched-fitbit-card` → `#streak-card` → `#log-area`.
- **`#body-metrics-card` relocated to Profile** (was between `#readiness-card` and `#unmatched-fitbit-card`). `renderBodyTodayCard()` itself untouched — every call site already does `getElementById('body-metrics-card')`, so moving the `<div>` was a zero-JS-change move. The two dead past-day hide/show references to it in `renderDayView()` (and to `#recent-workouts-card`, see below) were removed as harmless cleanup.
- **`#recent-workouts-card` (Recent Workouts + My Templates ▶ Use, previously one bundled `renderRecentAndTemplates()` card) removed from Today entirely.** The render function itself is untouched (still callable, still defined) — every one of its ~9 call sites now no-ops via its own existing `if (!card) return` guard, since the target div no longer exists in the Today DOM. Templates now live only in Profile's `#profile-templates` manager. **⚠ Update (2026-07-17, see "Log Past Workout Panel" below): `#recent-workouts-card` was re-introduced into the Today DOM, now nested inside the new `#log-past-card` panel, where `renderRecentAndTemplates()` renders it in a new templates-only mode. Its ~9 call sites no longer no-op — they populate the card inside the (usually collapsed) panel.**
- **`#streak-card` demoted below the rec** — confirmed via `renderStreakBadge()` that the header fire-badge (`#streak-badge`, inside `<header>`, NOT `.desktop-nav`) renders independently and stays visible at every viewport width including mobile (`.desktop-nav` is what `@media(max-width:768px)` hides, not `<header>` itself) — so the streak signal is already above the fold regardless of where the card itself sits.
- **`#progress-card` (Cornerman) and `#unmatched-fitbit-card` also moved below the rec** — neither was in the approved above-fold target list.
- **Readiness card left monolithic, not split, in this pass** — `renderReadiness()` was audited and found to render one long `card.innerHTML` (hero ring + bio grid + HRV/sleep/RHR bars + sleep-stage detail incl. the computed sleep score + zone minutes + HRV stat cards) with no seam to cleanly separate a compact "above-fold hero" from the detail below without a JS restructure. Accepted as-is for this pass, deferred to its own session — **done 2026-07-16, see "Readiness Card Hero/Detail Split" above**.
- **No reconsent/migration banner exists on Today** — audited and confirmed: the only such banner (`#gh-reconsent-banner`, Google Health migration) is Profile-tab/Settings-only (`_renderGHBanner()` only ever `insertBefore`s it relative to `#sync-wearables-card`), and there's no `RECONNECT_REQUIRED` banner outside the wearable-sync modal. The original brief's "connectivity/reconsent banners stay top" carve-out has nothing to apply to on Today.

**Profile tab — grouped by function, `#schedule-card` deliberately left at position 2 (unchanged, no reason found to move it).** Final order: identity header (`#profile-dynamic`) → `#schedule-card` → **identity/body group**: `#body-metrics-card` (new here), `#profile-body`, `#profile-weight-trend`, `#sync-wearables-card` (moved in) → **identity/context block**: `#profile-injuries`, `#profile-philosophy`, `#profile-context` → **coaching/AI group**: `#focus-override-card` (moved in), `#coaching-brief-card`, legacy `#roadmap-card` (untouched, still `display:none` dead code), `#roadmap-data-card` → **goals cluster**: `#belt-section` (moved in), `#challenges-card` (moved in), Goals & Milestones → **analytics**: `#analytics-card` (moved, internals untouched) → **templates/settings**: `#profile-templates` (moved in), the "⚙ Open Settings" account card, the wger attribution footer.
- **Body Metrics is now the single weight surface.** `#profile-body`'s own read-only "CURRENT WEIGHT" summary block (weight/BMI/body-fat/last-logged + its own "+ Log Weight" button) was trimmed out of `renderProfileBodyCard()` — it duplicated what `#body-metrics-card` already shows, now positioned directly above it. `#profile-body` is editable fields only (height/DOB/sex/goal weight/timeline) post-trim.
- **`#sync-wearables-card` stays the `insertBefore` anchor for `#gh-reconsent-banner`** — `_renderGHBanner()` only does `getElementById('sync-wearables-card')` + `insertBefore`, position-agnostic; verified live post-move that the anchor still resolves correctly (Shimmy's profile 1 is connected to both Fitbit and Google Health, so the banner correctly never renders for him — confirmed via `GET /api/wearables/providers/1`, not a bug).
- **Coaching Brief and Macro Roadmap collapsed by default, Analytics-style chevron/display toggle, visual-only.** `renderCoachingBrief()` and `rdEmptyHtml()`/`rdLoadedHtml()` were edited to wrap their body content in a collapsible `<div>` (`#coaching-brief-body` / `#rd-collapse-body`) toggled by a chevron in their own existing header row (`toggleCoachingBriefCard()` / `rdToggleCollapse()`), state persisted to `localStorage` (`ac_coaching_brief_open` / `ac_roadmap_data_open`) the same way `#schedule-card`'s blueprint toggle persists (`ac_schedule_blueprint_open`). **Critically, the boot-time data triggers were NOT touched** — the `/brief` GET fetch and `loadRoadmapData()` (which can auto-fire `generateRoadmapData()`, a live Sonnet call, when no roadmap exists yet) still run unconditionally in `bootApp()` exactly as before; the collapse only hides/shows already-rendered content. A naive copy of `#analytics-card`'s pattern (which gates its *data fetch* behind first-expand) would have been a real behavior change for Roadmap specifically — flagged in the Phase 1 audit and avoided.
- **Correction (Phase 1 audit): PIN change, wearables connect/disconnect, and delete-profile do NOT live in the Profile tab's card stack.** They're in `#settings-overlay`, a separate full-screen overlay reached via the gear icon — not part of `#tab-profile`'s scroll flow at all. The only Profile-tab-resident element in that direction is the "⚙ Open Settings" button card, already positioned near the bottom.

**Verified live** (profile 1, production, 2026-07-16): exact DOM child order of both `#tab-today` and `#tab-profile` confirmed via direct inspection (`Array.from(el.children).map(c=>c.id)`) at 390×844 and 1440×900 — matches the order above exactly. Both collapse bodies default `display:none`, expand correctly on click, chevron rotates. `openLogWeight()` from the relocated `#body-metrics-card` correctly opens `#weight-modal` pre-filled with the real latest weight. Screenshots at both viewports confirm visual layout matches (Chart.js weight-trend chart renders correctly, untouched). Zero console errors throughout. Check-in / rec-regen / readiness rendering logic unchanged — confirmed by reading the code (no JS touched in those paths) and by the live AI rec/readiness/Cornerman content rendering correctly post-move.

## Log Past Workout Panel (2026-07-17)

Frontend-only Today-tab feature (`public/index.html`) — a way to re-log a past session or start from a saved template without scrolling History or the Profile template manager. Partially reverses the declutter pass's removal of the Recent/Templates surface from Today, but as an opt-in collapsed panel rather than an always-open card.

- **`#log-past-card`** sits directly after `#ai-card` (near the rec). A "🔁 Log past workout" button (`toggleLogPastPanel()`) expands an inline panel `#log-past-panel` (not an overlay — the Log Workout modal is a fixed `.overlay` that renders on top of it, so no overlay-stacking coordination is needed). The card auto-hides when the athlete has no workouts AND no templates (`updateLogPastCard()`).
- **Two sections in the panel:**
  1. **Past workout history** — `renderLogPastHistory()`, a scrollable list built from `lpAllWorkouts()` (the `workoutLog` global + any paged-in older workouts, deduped). Each row's **🔁 Re-log** reuses the existing `reLogWorkout(id)` (prefills the modal from exercises + original notes).
  2. **Saved templates** — the reused `renderRecentAndTemplates()` in templates-only mode (see below), each **▶ Use** reusing the existing `useTemplate(id)`.
- **Both taps prefill the Log Workout modal and never log immediately** — they call the pre-existing `reLogWorkout`/`useTemplate`, which open `#log-modal` prefilled for the athlete to review/edit and save through the normal flow. `use_count` behavior is unchanged: `useTemplate` bumps it (as the ▶ Use flow always did); re-log doesn't.
- **`renderRecentAndTemplates(templatesOnly)`** gained one optional, backward-compatible param. All 8 pre-existing call sites are arg-less (`templatesOnly` → `undefined` → falsy → byte-identical prior behavior). When `true`, it renders only the "my templates" block (the deeper history list above it in the panel replaces the old last-3 recent-workouts block). A guard at the top also forces templates-only whenever `#log-past-panel` is open, so an arg-less data-change re-render (save/delete) can't reintroduce the recent-workouts block above the panel's own history list. It also calls `updateLogPastCard()` so the card's visibility stays synced via the existing render fan-out; `loadWorkouts()`'s completion calls it too (covers the boot case where templates load before workouts).
- **CSS is id-scoped** (`#log-past-card`/`#log-past-panel`/`#log-past-btn`/`#log-past-history-list`/`.lp-tpl-btn`/`#lp-status`), no global class changes. A scoped `#log-past-panel #recent-workouts-card` rule strips that element's normal full-card chrome (bg/border/padding) so it reads as a plain nested section.

### Expand, pagination, and template creation (2026-07-17, session #21)

Three additions, still all inside the panel; the only backend touch is an additive `?offset=` on `GET /api/workouts`.

- **Expand detail** — each history row has a chevron toggle (`toggleLogPastRow(id)`). `workoutLog` is summary-only (no exercise rows), so detail **lazy-fetches `/api/workouts/:id/full` on first expand** into a shared `fullWorkoutCache` (keyed by workout id) and renders exercises (via the existing `exerciseToNotesLine`) + notes. `reLogWorkout` was refactored to load through the same cache (`lpLoadFull(id)`), so expanding then re-logging a row doesn't re-hit `/full`. No eager fetching — collapsed rows never fetch.
- **"See more" pagination** — `logPastSeeMore()` reveals deeper into the already-loaded set first (`logPastShown += 20`); once that would run past what's loaded AND `workoutLog` is exactly 60 (the `loadWorkouts()` cap, so more may exist server-side), it pages in older workouts via `lpFetchNextPage()` → `GET /api/workouts?limit=60&offset=<already-loaded>`. Fetched pages go into a **panel-local `logPastExtra`** array — `workoutLog` itself is never mutated (streak calc, recent-3, and history read it). `logPastServerExhausted` stops paging when a short page comes back. **Backend:** `GET /api/workouts` now passes through `?offset=` (absent/0 = prior behavior; no existing caller sends it). **See-more renders append-only** (session #22): `lpAppendRows()` inserts only the newly-revealed rows into the existing `#log-past-history-list` (via a factored `lpRowHtml()` shared with the full render) and `lpUpdateSeeMore()` refreshes just the button — the scroll container is never rebuilt, so `scrollTop`, existing rows, and expanded detail are preserved (fixes a scroll-jump-to-top on every "See more"). The full `renderLogPastHistory()` still runs on panel open and as an append fallback when the list container is absent.
- **Template create/append — `notes_template` only.** Three entry points, all writing through the existing `POST /api/profiles/:id/templates` / `PATCH /api/templates/:id` (no new endpoints): (a) **New template** (`lpNewBlankTemplate()`, name+notes prompts); (b) **Save as template** from a past-workout row (`lpSaveWorkoutAsTemplate`) or an AI rec option (`lpSaveAiAsTemplate`, a picker over all 3 `aiRec.options` headlines); (c) **Append** a past workout (`lpWorkoutAppendPicker`) or AI rec option (`lpAppendAiToTemplate`) into an existing template (`lpAppendToTemplate` — client read-modify-write concat of `notes_template`, since the server PATCH is a blind overwrite). AI-rec text is built by `lpAiOptionToNotes()`, mirroring `prefillLogFromAI`'s format; past-workout text reuses the re-log notes builder. **The `workout_templates.exercises` jsonb is deliberately NOT written** — it's unread by `useTemplate` (which drives off `notes_template`); writing it would be dead data (see ROADMAP §9). A lightweight in-panel `lpOpenPicker()` handles the option/template choices; `aiRec` (the daily rec global) is read-only, so `renderAI` is untouched.

## Branding, Logo & PWA

- **Logo asset** — `public/logo.png` is the ApexCoach mark, wired throughout `public/index.html`:
  - **Favicon** (`<link rel="icon" type="image/png" href="/logo.png">`) + **apple-touch-icon** (`<link rel="apple-touch-icon" href="/logo.png">`).
  - **Splash screen** — `#apex-splash`, a pure-CSS intro overlay (`<div id="apex-splash"><img src="/logo.png">`) that fades the logo in, holds, then fades out on load (`@keyframes apexSplashFade`, ~2s, ending `visibility:hidden`). No JS.
  - **Profile-selector header** (~80px) and **desktop nav header** (~32px tall) both render the logo.
- **PWA manifest** — `public/manifest.json` (`<link rel="manifest" href="/manifest.json">`) makes the app installable: `name:"ApexCoach"`, `short_name:"Apex"`, `/logo.png` icons at 192/512, `theme_color`/`background_color` `#08090A`, `display:"standalone"`.
- **Known gap** — `public/logo.png` currently has a solid (black) background; a transparent-background version is a TODO so the figure floats on the app canvas (see `ROADMAP.md` §7 Next up / §9 tech debt).

## Readiness Formula V3

Regression-fitted to 36 days personal Fitbit data (R²=0.885, MAE=4.78):

score = 1.2077 × HRV + 0.1100 × deepSleepMinutes - 3.3834 × RHR_deviation - 10.84

Clamped to [1, 100]. See FORMULAS.md for full documentation.

## Sleep Score Formula

Personal regression model fitted on 36 nights of Fitbit sleep data (R²=0.883, MAE=2.45, 94% within 5pts of Fitbit):

score = 0.1558 × deep + 0.0935 × rem + 0.0607 × light - 0.1143 × awake - durationPenalty + 49.77

Duration penalty: max(0, (300 - asleepMinutes) * 0.3) for nights under 5 hours.
Tiers: 85+ Excellent, 70-84 Good, 55-69 Fair, <55 Poor.
Displayed in readiness card and sent to AI prompt. See FORMULAS.md for full documentation.

## Readiness Card Hero/Detail Split (2026-07-16)

Closes ROADMAP.md §7 priority 10 — the JS restructure explicitly deferred from the frontend declutter session (see "Today Tab + Profile Tab Reorganization" above). `renderReadiness()` (`public/index.html`) previously built one long `card.innerHTML` string with no seam between the compact hero and the detail sections; it's now split into an always-visible hero and a collapsed-by-default detail section, same visual-only toggle pattern as Coaching Brief/Macro Roadmap. **No data computation, fetch paths, or regen triggers changed** — this only reorganizes where the same HTML strings render.

- **Hero** — ring/score/tier/description/score-bar (`heroHTML`, untouched) + a 2×2 `bioGrid` (HRV / Resting HR / **Sleep Score** / Steps). The "Sleep" cell now shows the **computed sleep score** as its headline number (was sleep hours only) — e.g. "81" with a "Good · 5.9h" caption line, tier + hours combined rather than hours displacing the score. Reuses `ssColor`/`ssTier` (the exact tier thresholds/colors the detail section's own SLEEP SCORE card already used) rather than duplicating the logic.
- **`ssColor`/`ssTier` hoisted above the `if (deep.minutes || rem.minutes)` block — real bug fixed along the way.** They previously lived *inside* that block, so a light-only night (`sleepScore` non-null via `light.minutes` alone, `deep.minutes`/`rem.minutes` both 0 — `sleepScore`'s own gate is `deep.minutes || rem.minutes || light.minutes`, one condition wider) left them `undefined`. Not reachable from the hero before this session since the hero never referenced them; became a real risk once the hero started reusing them, so fixed at the source instead of worked around.
- **Detail section** (`#readiness-detail-body`, collapsed by default) — `barsHTML` (HRV/Deep Sleep/RHR bars) + `sleepStagesHTML` (the existing "sleep stages" card, SLEEP SCORE big number + Fitbit diff + Deep/REM/Light/Awake pills, untouched) + `zonesHTML` (zone minutes) + `hrvHTML` (HRV stat cards) — all four subsections exactly as they rendered before, just gated behind `toggleReadinessDetail()` (chevron + "SHOW/HIDE DETAIL" label, `localStorage.ac_readiness_detail_open`, mirrors `toggleCoachingBriefCard()`/`rdToggleCollapse()`).
- **Dead code removed**: `vitalsHTML` (built from `ssVital`/`ssVSub`) was computed every render but never concatenated into `card.innerHTML` — a fully inert leftover from an earlier redesign pass. Confirmed via diff review that removing it is a true no-op (it never rendered before either).
- **`showFeelingCheckinCard()`, the `#ai-card`/`#progress-card` display toggles, and `renderLogArea()`** all stay in their exact original position after `card.innerHTML = ...`, untouched.

**Height reality check, not glossed over.** The target was a ~200px hero; measured live (`getBoundingClientRect()`, profile 1, 390×844) the hero (clabel + ring/status/bar + bio-grid) is **~354px** — the ring, grid padding, and cell sizing are all pre-existing, unrelated to this split, and shrinking them would itself be a visual/behavior change beyond "the collapse," which was out of scope this session. What the collapse *does* deliver: the full card (hero + collapsed detail) dropped from **~1084px** (the old always-expanded monolith) to **~415px** — the detail section (bars/stages/zones/HRV, previously always rendered) is now hidden by default, cutting the scroll distance to the feeling check-in/rec roughly in half. A further hero-compaction pass (smaller ring, tighter grid) would need its own explicit sign-off, same as the readiness-split itself did.

**Verified live** (profile 1, production, both 390×844 and 1440×900): numbers captured from production *before* deploying (`readiness.score:62, tier:"light", hrv:52.3, rhr:58, sleepHours:5.87, steps:5976`, plus the raw sleep-stage minutes) matched exactly post-deploy — same inputs, same outputs, confirms zero data/logic drift. Sleep score correctly shows `81` / `Good · 5.9h` in the hero (matches the detail card's own `81` / `Good`). Detail toggle expands to reveal all four subsections with the same numbers; `localStorage.ac_readiness_detail_open` persists across a full page reload (confirmed the state survives `bootApp()` on a fresh load, not just a client-side re-render). Zero new console errors (one transient `Failed to fetch` on an unrelated Goals-progress call during a rapid-reload test cycle, not reproducible, unrelated to `renderReadiness()`).

## Workout Streak Tracking

Calculated from workoutLog entries where done=true. Counts backwards from today (or yesterday if no workout today). Streak breaks on a gap day with no completed workout. Displayed as:
- Header badge (fire emoji + count, visible at 2+ days, tappable tooltip)
- Streak card on Today tab (tiered: 2-6 green, 7-13 amber, 14-29 orange, 30+ gold animated)
- "Streak ended" card shown when a streak breaks
- Streak count sent to AI prompt for coaching context

## Multi-Profile System

- PIN auth: sha256 hashed PINs stored in Supabase

- Profile data cached in localStorage as ac_profile_data

- Profile ID stored in localStorage as ac_profile_id

- All API calls scoped by profile_id

- profile_data is sanitized on both read and write via cleanProfileData() in server.js — strips \r\n and excess whitespace from all string values recursively, preventing corruption from multiline form inputs or copy-paste

## Key API Endpoints

- GET /api/profiles — list profiles

- POST /api/profiles — create profile

- POST /api/profiles/verify — verify PIN

- GET /api/profiles/:id/daily — Fitbit data for profile

- GET /api/profiles/:id/unmatched-fitbit — last-7-day Fitbit activities not yet linked to a workout, rejected, or dismissed; each carries its same-day match candidates. Powers the Today-tab "Unmatched Fitbit Activities" card. Never 500s — returns `{activities:[]}` (no token) or `{activities:[], error:"fitbit_unavailable"}` on a Fitbit failure.

- POST /api/profiles/:id/dismiss-fitbit-activity — body `{provider_activity_id}`; appends the namespaced `fitbit:<id>` to `profiles.dismissed_fitbit_activities` (jsonb) so the activity never resurfaces in the card. Returns `{dismissed:true}`.

- GET /api/workouts?profile_id=&limit=&offset= — workout history (newest first). `limit` defaults 60; `offset` (2026-07-17, additive/backward-compatible — absent = 0) pages further back for the Today "Log past workout" panel's "See more".

- POST /api/workouts — save workout

- PATCH /api/workouts/:id — edit workout

- PATCH /api/profiles/:id — update profile data (also accepts name, avatar_color top-level)

- PATCH /api/profiles/:id/pin — change PIN

- DELETE /api/profiles/:id — delete profile + all workouts (requires PIN in body)

- POST /api/ai — Anthropic API proxy

- POST /api/profiles/:id/chat/message — send a Coach Chat message (streamed reply); body `{text}`. Pass `?debug=1` to get the assembled system/messages back as JSON instead of calling Anthropic (see "Coach Chat" → Debugging the snapshot)

- GET /api/profiles/:id/chat/thread — full Coach Chat thread history for initial render, plus a `proposals` array (live status for every tool-use proposal in the thread)

- POST /api/profiles/:id/chat/proposals/:proposalId/confirm — applies a pending Coach Chat tool-use proposal (goal update / focus override / check-in note) and marks it confirmed; no live Anthropic call

- POST /api/profiles/:id/chat/proposals/:proposalId/cancel — marks a pending proposal canceled without writing anything; no live Anthropic call

- GET /api/profiles/:id/checkin?date= — get daily feeling check-in for a date

- POST /api/profiles/:id/checkin — upsert daily feeling check-in (syncs across devices)

- GET /api/profiles/:id/roadmap — get saved road map text and timestamp (LEGACY free-text macro roadmap)

- POST /api/profiles/:id/roadmap — generate AI road map text from profile, goals, workouts (LEGACY; still used by current client)

- GET /api/profiles/:id/roadmap-data — structured macro roadmap (`roadmap_data` jsonb) + timestamp; `{roadmap_data:null}` if never generated. progress_pct recomputed on read.

- POST /api/profiles/:id/roadmap-data — generate a structured macro roadmap (Sonnet) tying ALL goals together; no intake gate. Saves to `roadmap_data` + `roadmap_data_updated_at`.

- POST /api/profiles/:id/generate-goal-description — AI generates motivating goal description from title

- POST /api/profiles/:id/goal-progress — calculates progress for all goals using workout data + AI deduction

- GET /api/profiles/:id/brief — returns coaching_brief, historical_brief, historical_brief_updated_at

- POST /api/profiles/:id/generate-brief — generates coaching briefs from workout history (two AI calls)

- POST /api/profiles/:id/search-history — natural language search across all workout history

- GET /api/profiles/:id/daily-recs — returns cached recommendations, date, and readiness score used

- POST /api/profiles/:id/daily-recs — upserts daily_recommendations, daily_recommendations_date, daily_recommendations_readiness on profiles

- GET /api/profiles/:id/life-os-summary — read-only aggregated daily summary for the external **Life OS** app. Auth: `X-Life-OS-Key: $LIFE_OS_API_KEY` (or admin secret). Returns `{date, readiness, readiness_fresh, sleep:{hours,score}, hrv, rhr, workout_done, workout_type, planned_workouts:[{headline,category,duration}]}`. Readiness + planned_workouts come from the cached `daily_recommendations*` columns and are nulled/`[]` when stale (`daily_recommendations_date != today`, → `readiness_fresh:false`); workout_done/type from today's `workouts`. **sleep/hrv/rhr are DB-first**: it reads `daily_sleep WHERE profile_id AND date=today` and returns those instantly with NO Fitbit call (fast path); only on a miss does it fall back to one best-effort live Fitbit call (7s timeout → those fields null, response still 200) and then upsert the result into `daily_sleep` for the rest of the day. `sleep.score` is the COMPUTED personal score (`estimateSleepScore`, server mirror of the index.html fn), NOT Fitbit's `fitbit_score`. Optional `?date=YYYY-MM-DD` overrides "today".

- GET /api/profiles/:id/progress-brief — returns cached progress brief + date

- POST /api/profiles/:id/progress-brief — upserts progress_brief (jsonb) + progress_brief_date on profiles

- GET /api/profiles/:id/micro-goals — list active micro-goals; server recomputes `current_value` for auto-trackable types (see Active Challenges system)

- POST /api/profiles/:id/micro-goals — create a new micro-goal; body: `{title, type, target_value, target_unit?, period?, end_date?}`

- PATCH /api/micro-goals/:id — update any of title, type, target_value, target_unit, period, end_date, current_value (manual override), is_active

- DELETE /api/micro-goals/:id — archives (is_active=false) by default; pass `?hard=1` for permanent delete

## Daily AI Recommendation Prompt Architecture

`fetchAI()` in public/index.html builds the Anthropic API request as a split **system** + **user** message (Anthropic Messages API), not a single user blob.

**System prompt (`buildSystemPrompt`)** — persona, coaching style, equipment/location/duration prefs, rules, an **expert reasoning standard** (see below), and JSON response shape. Opens with the ApexCoach persona: "an elite, deeply personal AI fitness coach… You adapt to real human life… You never suggest something contraindicated by their injuries. You always factor in their micro-goals as non-negotiable daily commitments." Rules include the compound Posture/PT add-on on every Strength session (naming 2–3 specific movements). When called in `mode: 'reroll'` the system prompt appends an instruction to generate meaningfully different options than the previously-shown headlines. When called in `mode: 'category'` it narrows to a single category.

**Expert reasoning core (`EXPERT_REASONING_CORE`, 2026-07-15).** A ~1400-char addition (not a rewrite) appended after the rules block, present in **both** `buildSystemPrompt()` here and `CHAT_SYSTEM_PERSONA` in `server.js` — deliberately duplicated (no shared module system exists between the static frontend and the Node backend), with a comment in each file pointing at the other so they get edited together. Covers two things concretely, not generically: (1) **S&C coaching reasoning standards** — manage weekly load/recovery against actual recent volume from the log (not vibes), progressive overload with real increments (+5-10lbs / +1-2 reps / +5-10s hold, not "add more"), when to hold a load steady vs. call a deload, respecting interference effects (never stack two high-CNS sessions back-to-back), treating readiness/HRV/RHR as autoregulation inputs that actually change the plan; (2) **sports-medicine-informed, explicitly non-diagnostic judgment** — load-tolerance logic on pain (warms up and eases vs. builds/worsens under load) before suggesting how to train around or rehab an issue, and a plain, named redirect to a PT/physician for anything persistent/worsening or neurological, never a specific diagnosis.

**User message** — assembled in this exact order; the schedule instruction comes FIRST so it anchors Claude's reasoning:

1. `buildScheduleInstruction()` — reads the **v2** schedule via `schedActiveSchedule()` (in-memory `currentSchedule`, falling back to `profile_data.schedule`). **Step 1 (today's primary):** if today has an **anchor**, Option 1 MUST be exactly that activity + duration with no exercise breakdown ("fixed commitment"); if no anchor, the most underserved **frequency_target** (lowest done-vs-`times_per_week`, boosted when today is its `suggested_day`) becomes the suggested Option 1; else bonus/recovery day. **Step 2 (add-ons):** when today has a planned workout, appends an `ADD-ONS:` line asking to weave each add-on into one option. **Step 3:** always emits a `WEEKLY TARGET STATUS (Mon–today):` block — anchor counts (`done/scheduled anchored ✓`) and target counts (`done/needed done` / `[NEEDED]`). Output kept under ~300 words.
2. `TODAY: <date>` + `CURRENT WORKOUT STREAK: N days`.
3. Biometric block (Fitbit live metrics OR manual check-in context, exclusive).
4. Daily check-in block (if submitted for today).
5. `buildWeeklyVolumeSummary()` — Mon–Today sessions completed vs scheduled (anchors), category breakdown, a `Weekly targets:` progress line (per-target `done/needed`, `(OVERDUE)` when past `suggested_day` and short, `✓` when met), yesterday's zone minutes (if Fitbit), compliance %.
6. `RECENT N-DAY LOG:` — last N workouts (N=10 default, trimmable to 7).
7. `buildVarietyAndSkipAnalysis()` — last-7-day category tally, missed **anchor** workouts (reads `currentSchedule.anchors`) with days-ago labels, an `OVERDUE WEEKLY TARGETS:` line (frequency_targets past their `suggested_day` and still short of `times_per_week`), VARIETY RULE, SKIP RULE, and CARRY FORWARD instruction when an anchor was missed in the last 3 days.
8. `HISTORICAL TRAINING SUMMARY:` + `RECENT COACHING BRIEF:` (each trimmable to 400 chars).
9. `RECENT EXERCISE HISTORY:` — top 10 exercises from libExercises (trimmable to top 5), followed by `buildMuscleRecoveryInstruction()` — exercise-science rules for 48–72h compound-lift recovery and what can be trained daily.
10. `FULL ATHLETE PROFILE:` — `profile_data.ai_prompt_context`.
11. `GOAL PRIORITIES:` — long-term profile goals.
12. `buildMicroGoalsPromptContext()` — ACTIVE CHALLENGES block. Daily habits are marked "no exceptions including Minimum Viable"; weekly-frequency and cumulative-volume goals are required to feature in ≥1 option and be referenced in others.
13. `WEEKLY SCHEDULE DEFAULTS:` — flat Mon–Sun schedule pairs.

**Truncation priority (preserves schedule + micro-goals always):** if `system+user > 8000` chars, trim in order (1) historicalBrief → 400, (2) coachingBrief → 400, (3) exerciseHistory → top 5, (4) recent log → 7 days. The schedule instruction, variety analysis, weekly volume, muscle recovery block, and micro-goals context are NEVER dropped.

**Workout-category inference** uses `inferWorkoutCategory(workoutType)` — regex-based parse of the stored workout title string into `strength | cardio | martial_arts | sports | mind_body | rehab | rest | other`. Used by weekly volume and variety analysis.

## Weekly Schedule (v2 — anchors / weekly targets / add-ons)

`profile_data.schedule` is a structured object (replaced the old day-keyed flat object):

```json
{
  "anchors": { "tue": [{"activity": "MMA Class", "duration": 60}], "thu": [{"activity": "MMA Class", "duration": 60}] },
  "frequency_targets": [{ "id": "ft1", "activity": "Upper Body Strength", "times_per_week": 1, "suggested_day": "wed", "duration": 45 }],
  "addons": [{ "id": "ao1", "activity": "Posture/PT work", "duration": 10, "days_per_week": 5 }]
}
```

- **anchors** — fixed days, keyed by Mon-first 3-letter day (`mon`…`sun`), value = array of `{activity, duration}` (duration minutes or null). The UI edits one anchor per day; migrated multi-activity days display all in the view popover.
- **frequency_targets** — "do this N×/week" goals (ids `ft1`, `ft2`…). `suggested_day` is a day key or null (Any).
- **addons** — daily extras like Posture/PT (ids `ao1`, `ao2`…), with `duration` + `days_per_week`.

**Migration (`loadSchedule`)** — on load, reads `currentProfileData.schedule`. If it's the legacy day-keyed shape (any `mon`…`sun` key present) it auto-migrates via `schedMigrateOld()` (days with activities → anchors; targets/addons empty), logs `"Schedule migrated to v2 format"`, and PATCHes the v2 format immediately. Null/missing → `{anchors:{}, frequency_targets:[], addons:[]}`. `normalizeScheduleDay()` is kept but only used during migration.

**UI** — `schedRender*`/`sched*` functions render a 3-section card in `#schedule-card` (Profile tab): **Fixed Days** (7-day pill row → tap shows read-only popover; in edit mode opens an inline anchor editor), **Weekly Targets**, **Daily Add-ons**. A `✏️ Edit` / `✓ Done` toggle (`schedToggleEdit`) switches modes. Edits save **live** on blur/change via `schedPersist()` which PATCHes `{ profile_data: {...existing, schedule: currentSchedule} }` (full profile_data); `✓ Done` does a final PATCH + a green "Saved ✓" toast. Module state: `currentSchedule`, `schedEditMode`, `schedOpenDay`. All CSS scoped to `#schedule-card`.

**Build-with-AI empty state** — when `currentSchedule` has no anchors/targets/addons (and not in edit mode), `renderSchedule()` shows `schedRenderEmptyState()` instead of the empty 3-section view: a centered "Build Your Schedule" card with **✨ Build with AI** (→ `schedStartAIBuild()`) and **Set it myself** (→ `schedToggleEdit()`). The AI path opens an inline 4-step flow (`schedAI*` fns, state `schedAIActive`/`schedAIStep`/`schedAIData`/`schedAIBuilding`) that takes over the card: (1) days/week stepper, (2) fixed-day pills + per-day activity inputs, (3) preference pills, (4) free-text "must include" with voice mic (`voiceMicBtn()` → `startVoice`). **Build My Schedule →** POSTs `callType: 'schedule_builder'` (Haiku) to `/api/ai` with a JSON-only system prompt + all 4 answers + goals/injuries, parses the returned v2 JSON into `currentSchedule`, backfills `ft*`/`ao*` ids, `schedPersist()`s, re-renders, and toasts "Schedule built! ✓". Errors return to the empty state with a danger toast.

**AI prompt now reads v2.** `buildScheduleInstruction()` / `buildVarietyAndSkipAnalysis` / `buildWeeklyVolumeSummary` read the v2 shape directly (`currentSchedule.anchors` + `frequency_targets`, via `schedActiveSchedule()` / helper fns `schedWeekDoneWorkouts`, `schedTargetDoneCount`, `schedAnchorStatus`). `schedSyncLegacy()` still mirrors `anchors` → the legacy day-keyed `schedule` var (+ `localStorage.ac_schedule`) for other readers (`getScheduleText`, `formatScheduleDaySummary`), but the daily-rec prompt no longer depends on it. Target↔workout matching is best-effort via `inferWorkoutCategory()`.

## 7-Day Smart Schedule Preview

A **rolling 7-day** plan preview (today … today+6) that lives in `#week-preview-section` inside `#schedule-card`, **above** the Fixed Days / Weekly Targets / Daily Add-ons sections. The section div is a sibling of `#schedule-grid` (which `renderSchedule()` overwrites), so it survives schedule re-renders.

- **Endpoint**: `POST /api/profiles/:id/week-preview` body `{ schedule (v2), readiness }`. `CALL_TYPE_MODEL.schedule_preview → MODEL_HAIKU`. Server fetches its own last-14d workouts + exercises (+ profile_data + active micro_goals).
- **Rolling window** — `buildWeekSkeleton` spans **today through today+6** (not a fixed Mon–Sun week). Each day's `dayKey`/`dayLabel` is its ACTUAL weekday (anchors are keyed by weekday), so the array starts at today's weekday. A day is `done` only when a completed workout exists on that date **AND the date is before today** (today shows the `•` indicator; `actual_workout` is still surfaced for today). The client renders the rolling weekday labels, not position-indexed ones.
- **Carry-forward done-counting** — frequency-target satisfaction is counted from the **start of the current Mon–Sun week** through the end of the rolling window (`weekStartMs … today+6`), not just the window. So a target **met earlier this week stays met** (not re-placed), while one **missed Mon→yesterday carries forward** as unmet and gets placed in the rolling window via the same recovery-aware scorer. Completions earlier this week (outside the window) still count but aren't drawn.
- **STEP 1 — rule engine (pure JS, no AI, `buildWeekSkeleton`)**: (a) **anchors** locked from `schedule.anchors[weekday]`, never moved, `done`-flagged per the rule above; (b) **frequency targets** — completed targets surface on their actual day if inside the window (see below), unmet targets placed in sorted order with guaranteed placement (see below), scoring each available day: `+30` not adjacent to a hard day (strength/martial_arts/cardio), `±20` muscle-specific recovery, `+10` mid-week (wed/thu); (c) **addons** attached to **every training day** (anchor OR frequency-target day, including completed-target days); (d) **rest** fills the remainder. Output: 7 objects `{ dayKey, date, dayLabel, planned:[{activity,type:anchor|frequency_target|addon|rest,duration,category,done?}], done, actual_workout, recovery_notes }`.
- **Frequency-target "done" counting (exercises table, NOT workout.type)** — the AI-generated `workout.type` title is polluted by micro-goal exercises (a Dead-Hang-only session can get titled "Strength (Upper Body)"), so done-counting ignores it entirely. A workout satisfies a target only when `workout.done===true` AND its `exercises` rows (by `workout_id`) contain **≥2 distinct names that map (via `MUSCLE_GROUP_MAP`) to the target's required muscle groups** (`activityMuscles`), **excluding any exercise that maps only to `grip_forearms`** (Dead Hang, farmer carry, bar/passive hang — these never count toward any target). `workout.type` is used for display labels only. `weekDone` collects ALL done workouts in the week (not one-per-date) so a strength session logged as a 2nd workout on an anchor day still counts. Needs `workouts.id` + `exercises.workout_id` in the fetch.
- **Completed targets shown on their day** — when a target is met, the qualifying workout's day gets a `{type:'frequency_target', done:true}` planned item (e.g. Upper Body Strength appears next to Wednesday's anchor) rather than being dropped. Occupies that day's single frequency slot.
- **Placement order + guaranteed placement** — unmet targets are sorted: **non-stackable first** (so stackable ones can land on the training days they create), then `suggested_day`-present, then `times_per_week` ascending, then category rank (strength/martial_arts `0` < cardio `1` < mind_body/rehab `2` < other `3`). Each unmet **non-stackable** slot is placed on the **highest-scoring available day even if negative**; only skipped when **zero** available days remain. Targets are never silently dropped.
- **Stackable cap (1 non-stackable target per day + stackable exception)** — the per-day cap is **one NON-STACKABLE frequency target per day** (anchors never count). A target with `stackable:true` on its `frequency_targets[]` object (e.g. yoga / mobility / light work) may ADDITIONALLY share a day that already has an anchor or a non-stackable target — placed preferring existing **training days** over rest days (falls back to a rest day only if no training day is open). A day can hold multiple stackable targets but only one non-stackable. **Missing `stackable` → `false`** (safe non-stackable default). `targetStackable(t)`/`hasNonStackable(idx)`/`isTrainingDay(idx)` drive this; placed `frequency_target` skeleton items carry `stackable:true|false`. (This replaced the short-lived "1 per category group per day" cap, which over-allowed volume like Upper Body + Cardio same-day.) The **editor** (`schedTargetRow`) shows a "Can be done on the same day as other workouts" checkbox per target, defaulting ON for yoga/pilates/stretch/meditation/mobility/rehab/pt and OFF otherwise (`schedStackableDefault`, keyword-based, user-overridable, materialized on first edit); saved as `stackable` on the target.
- **Muscle-group-specific recovery** — `MUSCLE_GROUP_MAP` is a generic keyword→muscle-group lookup (chest/back/shoulders/biceps/triceps/core/glutes/quads/hamstrings/calves/grip_forearms; keyword `.` = regex wildcard). From the last 7d of actual (done) workouts' **exercise rows**, `muscleGroupsForExercise(name)` builds a per-group last-worked map (flat 48h window, presence-based). `activityMuscles(activity)` maps a scheduled activity to its required groups by keyword (upper/push/pull/chest/back/arm → chest/back/shoulders/biceps/triceps; lower/leg/squat/hinge → glutes/quads/hamstrings; full/total → all major; core/ab → core; cardio/run/hike/walk → calves; mma/martial/grapple/bjj/boxing → shoulders/core/grip_forearms; else none). A candidate day gets **+20 only if ALL** required groups have ≥48h recovery, **-20 if ANY** was hit within 48h. `recovery_notes` name the specific conflicting groups ("chest worked <48h prior"). Fully generic — works for any user's schedule. (Replaced the old flat `previewMuscleGroup` category map.)
- **STEP 2 — Haiku** (`enrichWeekPreviewWithCoaching`, S&C-coach persona): given the skeleton (each `frequency_target` item tagged `[frequency_target,stackable]` when stackable) + profile (ai_prompt_context 600c) + last 7d workouts + today's readiness + micro-goal titles, returns `{ week_note, days:[{dayKey, coaching_note ≤12 words}] }`, merged onto the skeleton. The system prompt instructs that **stackable sessions paired with a main session be coached as one combined block**, not two hard efforts. **Non-fatal + 6s `Promise.race` cap** — returns the bare skeleton on timeout/failure. Response: `{ success, week:[7], week_note, generated_at }`. The full skeleton (per-day plan + done status, each target's `done@`/`placed@` dates, and the muscle-recovery map) is logged to the server console.
- **Client** (`public/index.html`): `loadWeekPreview()` (cache-first via `localStorage.ac_schedule_preview` = `{date, profileId, data}`; same-day+same-profile → render from cache, else POST with `schedActiveSchedule()` + `readiness.score`), `renderWeekPreview(data)` (compact 7-row list — 3-char day label (server's actual weekday, rolling order) colored by past/today/future, primary activities then actual **add-on names joined by " · "** in muted text, muted coaching note, `✓`/`•` status, today gets a 3px ember left border, past rows `opacity:.7`; the full `week_note` renders untruncated on its own wrapping muted-italic line below "THIS WEEK"; a muted Refresh link → `wpRefresh()`), and `invalidateSchedulePreview()` (clears cache; re-fetches only if the preview is on screen). CSS scoped to `#week-preview-section`.
- **Collapsible blueprint (client)** — the Fixed Days / Weekly Targets / Daily Add-ons blueprint (`#schedule-grid`) is **collapsed by default**, so the Schedule card's default view is just the 7-day preview. A `#blueprint-toggle` row (sibling between `#week-preview-section` and `#schedule-grid`) shows **"YOUR TRAINING BLUEPRINT ▸ Edit"** (ember) when collapsed; clicking it expands the blueprint **and enters edit mode** (`openBlueprintEdit` → `schedToggleEdit`). The original "Schedule ✏️ Edit" trigger is **suppressed** (only the **✓ Done** button renders, in edit mode — no duplicate Edit); ✓ Done collapses back + exits edit. `applyBlueprintChrome()` (called at the top of `renderSchedule`) toggles a **`bp-collapsed` CLASS** on `#schedule-grid` (NOT inline display — `renderSchedule` resets `el.style.cssText` right after, which would wipe an inline `display:none`; it never touches classList). `#schedule-grid` wraps only the blueprint header + sections (the week preview is a separate sibling). Shown only when editing / AI-build / empty-schedule, otherwise hidden behind the toggle; open state mirrors edit mode and persists in `localStorage.ac_schedule_blueprint_open` (restored into `schedEditMode` at boot). Additive only — `schedRender*`/`schedToggleEdit`/`schedPersist` are unchanged. CSS scoped to `#schedule-card .bp-toggle-*` / `#schedule-card #schedule-grid.bp-collapsed`.
- **Wiring**: `loadWeekPreview()` from `renderSchedule()` (top) + bootApp profile-load; `invalidateSchedulePreview()` from `saveWorkoutToSupabase()`, `deleteWorkout()`, and `schedPersist()`. `schedRender*`/`schedToggleEdit`/`schedPersist` logic itself is untouched (calls only).

## Alternative Recommendations (Cycling UI)

Below the 3 rec cards and Minimum Viable the Today tab renders two controls:

- **🔄 Show me different options** — `rerollAlternativeRecs()` fires a fresh `fetchAI({ alternative: { mode: 'reroll', previousHeadlines: … } })`. Claude is instructed to generate meaningfully different categories/intensities/durations than the headlines already shown.
- **Category pills** (Strength / Cardio / Martial Arts / Sports / Mind & Body / Rehab & Recovery / Rest) — `filterRecsByCategory(key)` fires `fetchAI({ alternative: { mode: 'category', category: <pretty> } })`. Claude is told to generate options in that category only, still respecting readiness, micro-goals, injuries, equipment.

Both paths write to `altRec` / `altRecMode` / `altRecCategory` state and DO NOT touch the main daily cache (`aiRec`, `ac_cache`, `daily_recommendations` on profiles). `renderAI()` switches to rendering `altRec` with a blue "SHOWING DIFFERENT OPTIONS" banner and a `← Back to today's recommendations` link that calls `restoreCachedRecs()` to clear alt state.

**Category override outranks schedule:** when the category pill path is taken, `fetchAI()` prepends a `CATEGORY OVERRIDE` block to the user message ("takes priority over everything else in this message") and swaps `buildScheduleInstruction()` to a suppressed note stating the schedule does NOT apply to this call. The system prompt's category block also enforces this with "if any option slips into a non-{category} category, the response is wrong." This fixes a bug where tapping Strength still returned MMA recommendations because the schedule instruction was drowning out the category filter.

## Daily AI Recommendation Cache

Recommendations are generated once per day and cached on the profiles table (`daily_recommendations` jsonb, `daily_recommendations_date` date, `daily_recommendations_readiness` int). On page load the app calls `tryLoadCachedAI()` first; if same-day recs exist they render immediately and no AI call is made. `renderAI()` shows a subtle "GENERATED AT H:MMAM" timestamp pill using the `generated_at` field stamped into the rec object.

Regeneration triggers:
- **Fitbit arrives / readiness changes**: `maybeRegenForReadiness()` silently regens if `|new - cached| > 10` or if cached readiness was null.
- **Daily check-in submit**: always regens (context changed).
- **Manual check-in submit**: always regens.
- **Goal reorder (saveGoalPriority)**: regens only if top-2 priority goals changed order — reorders below rank 2 don't trigger.
- **Goal add/remove**: always regens. Minor description edits don't trigger (only addGoal / removeGoal paths).
- **Road map or Coaching Brief regeneration (user-initiated)**: regens.

`fetchAI({silent:true})` skips the loading spinner and error banner so background regens don't disturb the visible cached recs. Every successful `fetchAI()` stamps `generated_at`, writes `ac_cache` locally, and POSTs to `/api/profiles/:id/daily-recs` so the cache survives reloads and syncs across devices.

**New columns required in Supabase** — add via Supabase SQL editor:
```sql
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS daily_recommendations jsonb;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS daily_recommendations_date date;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS daily_recommendations_readiness int;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS progress_brief jsonb;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS progress_brief_date date;
```

## Progress Brief Cache (Server-Side)

The progress brief on the Today tab is cached on the profile in `progress_brief` (jsonb) + `progress_brief_date` (date), mirroring the `daily_recommendations` pattern so it survives cross-device and doesn't fire an AI call on every load.

- **Client flow** (`fetchProgress()`): GET `/api/profiles/:id/progress-brief` first. If server has a same-day entry, render it and mirror to `localStorage.ac_cache.progressRec`. Otherwise fire the AI call (Haiku via `callType: 'progress_brief'`), render, then POST the result back to the server.
- **Invalidation**: `POST /api/workouts`, `PATCH /api/workouts/:id`, and `DELETE /api/workouts/:id` all call `clearProgressBriefCache(profile_id)` after the mutation. The PATCH/DELETE paths look up `profile_id` from the workouts row first (via `getWorkoutProfileId`). The client-side `saveWorkout` / `deleteWorkout` paths also clear `localStorage.ac_cache.progressRec` and call `fetchProgress()` if the Today card is visible, so the regenerated brief appears immediately on the active device.

## Daily Feeling Check-In

Optional daily check-in card on Today tab, shown between readiness card and AI recommendation. Available for both Fitbit and manual check-in users after their readiness score loads.

- **Energy**: 5-level tap selection (Drained / Low / Okay / Good / High)
- **Body Soreness**: Multi-select body parts (Neck, Shoulders, Upper Back, Lower Back, Core/Abs, Hips/Groin, Quads/IT Band, Knees, None)
- **Severity**: Single select when body parts selected (Mild / Moderate / Significant)
- **Free text**: Optional textarea with voice input via startCheckinVoice()
- **Submit**: "Tell My Coach" button, disabled until at least one input provided
- **Collapsed state**: After submit, collapses to summary pill with "Update" link to re-open
- **Storage**: Primary storage in Supabase `daily_checkins` table (syncs across devices). localStorage `ac_checkin` kept as offline fallback. On load: fetches from Supabase first, falls back to localStorage if network fails.
- **AI injection**: `buildCheckinContext()` builds context string injected into fetchAI() prompt after readiness data. Instructs AI to avoid sore body areas and reduce intensity if energy is low. Free text gets additional AI parsing instruction.
- **Re-trigger**: Submitting check-in re-fetches AI recommendation if AI card is already visible

## Coaching Memory System (Three-Tier)

Three-tier AI memory system stored in Supabase profiles table:

1. **Historical Brief** (historical_brief column) — long-term training summary generated from all workouts beyond the last 30. Regenerated monthly or on demand. Covers consistency patterns, exercise progressions, injury history, and milestones.

2. **Coaching Brief** (coaching_brief column) — living analysis of the last 30 sessions, regenerated after every workout save. Covers recent patterns, exercise trends, injury status, what's working, and what needs attention. Includes historical context.

3. **History Search** (search-history endpoint) — on-demand natural language search across the complete workout history. Powers the "Ask Your History" feature on the Log tab.

Both briefs are injected into the daily AI coaching prompt (before FULL_PROFILE) so recommendations reference training history. The coaching brief card is displayed on the Profile tab with a collapsible historical section.

## Exercise Library System

Exercises are auto-extracted from workout notes by Claude AI on every workout save and stored in the exercises table with a two-level category taxonomy. The Library tab has three views:

1. **Dashboard** — workout type donut chart (Chart.js), weekly volume bar chart, exercise category breakdown bars, top 6 exercises grid, quick stats row
2. **Exercises** — searchable list with two-level filter pills (main category → subcategory), click for detail view with progression chart, session history, and AI insight
3. **Records** — personal records (heaviest lift, most reps, longest distance), all-time aggregated stats

### Workout Taxonomy (two-level hierarchy)

Main categories and their subcategories:
- **strength**: upper body, lower body, core, full body, calisthenics, olympic lifting, powerlifting
- **cardio**: machine (elliptical/treadmill/etc), outdoor (running/walking/hiking), class, hiit, jump rope, general
- **martial_arts**: striking (boxing/kickboxing/muay thai), grappling (bjj/wrestling/judo), mma, general
- **sports**: team, racket, water, winter, general
- **mind_body**: yoga, pilates, stretching, meditation, breathwork
- **rehab**: physical therapy, foam rolling, active recovery, general
- **other**: general

Exercises table stores both `main_category` (top level) and `subcategory` (specific sub-type). The `category` column remains for backwards compatibility and mirrors `main_category`.

### Endpoints
- `POST /api/profiles/:id/extract-exercises` — AI extracts exercises from workout notes, inserts with main_category and subcategory
- `GET /api/profiles/:id/exercises` — grouped by name with counts, filtered by ?name=, ?category=, ?main_category=, ?subcategory=
- `GET /api/profiles/:id/exercises/stats` — aggregate stats including category_breakdown and subcategory_breakdown
- `GET /api/profiles/:id/exercises/:name` — full history for one exercise with PR data

### Auto-Extraction
- Triggered silently after every workout save (if notes exist)
- "Import History" button on Library tab backfills from existing workouts
- Exercise names are normalized by AI (e.g., "glute bridges 3x12" → "Glute Bridge")
- CANONICAL_NAMES maps common variations, CATEGORY_OVERRIDES and SUBCATEGORY_MAP assign correct categories
- Top 10 recent exercises injected into daily AI coaching prompt

## Exercise Canonicalization (`exercise_catalog`, 2026-07-15)

Generalizes the CANONICAL_NAMES hand-fix above (which only covers ~19 exercises, and required a one-off manual migration for Dead Hang specifically — `migrations/2026-05-09_dead_hang_canonicalization.sql`) into a catalog-backed system so every logged exercise, not just the hand-picked ones, resolves to one canonical identity across history, analytics, and micro-goal tracking.

**Layered on top of, never replacing, the existing hand-fix.** `normalizeExerciseName()`/`CANONICAL_NAMES` still run FIRST in `extract-exercises` and stay fully authoritative for everything they already cover — the catalog resolution only activates for names that pass through unchanged. This was a deliberate integration choice, audited before writing any code: the micro-goal auto-tracker (`mgMatchesExercise`/`extractCanonicalFromTitle`) re-derives canonicalization from `CANONICAL_NAMES` at READ time regardless of what's stored, so a catalog-resolved name can never disagree with it — either it matches what `CANONICAL_NAMES` would have produced (when the catalog is seeded from that same map, see below), or it resolves a variant `CANONICAL_NAMES` doesn't know, which is a pure coverage improvement, never a regression.

**Schema** (migration `migrations/2026-07-15_exercise_catalog.sql`, run manually, applied to production): `exercise_catalog` — `id`, `canonical_name` (UNIQUE), `aliases` (text[]), `family` (text — groups variants, e.g. "Push-Up" covers Incline/Decline/Close-Grip; consumed by phase 2's Library family rollups, see "Exercise Canonicalization Phase 2" below), `muscle_groups_primary`/`muscle_groups_secondary` (text[], consumed by phase 2's muscle-group filter + heatmap), `equipment` (text[], not yet consumed by anything), `category` (matches `exercises.main_category`'s real taxonomy: strength/cardio/martial_arts/sports/mind_body/rehab/other — NOT the AI extraction prompt's separate pre-normalization enum), `is_duration_based` (bool), `source` (`musclewiki`\|`custom`\|`wger`), `musclewiki_id` (nullable, unique when set — reserved for a future MuscleWiki VIDEO-streaming layer, see §7 in ROADMAP.md, not a data source anymore), `wger_id` (nullable, unique when set — added `migrations/2026-07-16_exercise_catalog_wger.sql`, run manually, applied), timestamps. RLS + `service_role_bypass` — the 2026-07-16 migration only adds a column and widens the `source` CHECK, so it doesn't touch RLS/policies at all (nothing to reassert). **Seeded directly FROM the CANONICAL_NAMES map** (not a parallel reimplementation) — 18 canonical rows with their alias groups transcribed verbatim, so the first save after migration exact-matches everything the app already knew how to canonicalize — **then bulk-seeded from wger.de** (below), landing on top of these + whatever custom rows had already accreted from real saves/backfill. ~880 rows total as of 2026-07-16.

**`resolveExerciseCatalog(name, category, requestCache)`** (`server.js`) — the resolution pipeline, called after `normalizeExerciseName()`/`normalizeCategory()` in the `extract-exercises` loop, once per extracted exercise:
1. **Exact/alias match** — `catalogNormKey()` (lowercase, per-word singularize — trailing 's' unless 'ss', length>2 — THEN strip hyphens/spaces/join) against every `canonical_name` and `aliases` entry. Because this normalization collapses purely cosmetic differences (plurals/hyphens/case) into the SAME key as the canonical name itself, a typed name that's just a spelling variant of the canonical (e.g. "push ups" vs "Push-Up") hits the **canonical_name** check directly → `method:'exact'`. Only when the typed text normalizes DIFFERENTLY from the canonical name but matches something in its `aliases` array does it fall through to `method:'alias'` — meaning every alias hit is, by construction, a genuine variant-vs-generic merge decision (e.g. "hang"→Dead Hang, "Curl"→Bicep Curl), never a cosmetic one. **Real bug found + fixed 2026-07-16** (post-wger-seed review, see below): the original implementation stripped a trailing 's' off the WHOLE concatenated string, so it only ever caught a plural on the LAST word ("push ups"→"pushup" only worked because "ups" is last) — a plural anywhere else was invisible ("Biceps Curl"→"bicepscurl" vs "Bicep Curl"→"bicepcurl" never collided). Fixed by stemming per-word before joining; verified against 13 known pairs with zero regressions, then verified live in production (typing "overhead triceps extension" now correctly hits `method:'exact'` against the existing "Overhead Tricep Extension" row). Known remaining gap, not chased: "-es" plurals on sibilant-ending words ("Press"→"Presses") still differ — but that pair is still caught by the fuzzy layer below (similarity 0.91), so it costs one confirm-chip tap, never a silent miss.
2. **Fuzzy match** — Levenshtein similarity (`levenshteinDistance`/`levenshteinSimilarity`, no npm dependency — audited first, no existing fuzzy-match utility in the codebase) against every canonical_name + alias, length-normalized. Requires similarity ≥ `CATALOG_FUZZY_MIN_SIMILARITY` (0.82) AND key length ≥ `CATALOG_FUZZY_MIN_KEY_LEN` (4) to auto-apply → `method:'fuzzy'`.
3. **Haiku fallback** (`haikuResolveExerciseName`) — only for names that miss both. A **separate small call**, deliberately NOT folded into the main extraction prompt (audited before building): that prompt runs unconditionally on every save regardless of whether anything is actually ambiguous, and the catalog is large (~880 rows, wger-seeded) — stuffing it in would bloat every single save's token cost even on the common all-exact-match case. The supplementary call passes the raw name + top-3 fuzzy candidates (even sub-threshold ones) and instructs Haiku to be conservative ("a wrong merge is worse than a new entry") — matches an existing candidate (`method:'haiku'`) or declares it new, creating a `source:'custom'` catalog row (`method:'custom'`). **Real coverage gap found live** (2026-07-16 verification): wger seeded plenty of *variant-qualified* lat pulldown names (Wide-Grip, Neutral-Grip, Single-Arm, …) but no bare "Lat Pulldown" — typing that plain phrase correctly falls through exact/alias/fuzzy and lands here, creating a new `source:'custom'` row via Haiku (confirm chip shown, as designed) rather than silently misfiring. Not a bug — the layered fallback doing exactly its job — but a concrete example of the kind of gap a Free Exercise DB top-up import could close (see ROADMAP.md §7).
4. Never blocks a save. Any internal failure (catalog fetch down, table not yet migrated, Haiku error) degrades to `method:'unavailable'` and the pre-catalog `normalizeExerciseName()` output is used as-is — provably identical to today's behavior before this feature existed.

**Confirm chip — standing rule (2026-07-16): ask whenever there's ambiguity, never silently guess.** Only `method:'exact'` (and `'unavailable'`, the silent-fallback case) save with no chip. `'alias'`, `'fuzzy'`, `'haiku'`, and `'custom'` all show the post-save confirm chip (`#ec-chip`, `public/index.html`) — including alias hits, which were originally silent until live review of the backfill data (see below) surfaced that an alias match is *always* a real variant-vs-generic decision in this system (per the exact/alias mechanics above), never a cosmetic one, so it needs the same confirmation as a fuzzy/Haiku match. `ecShowConfirmChip()` shows only the FIRST chip-worthy exercise in a multi-exercise save (a minor UX scoping choice — every exercise is already saved under its best-guess name regardless). "Change" expands an inline catalog search (`GET /api/exercise-catalog?q=`) + a "keep as typed → new custom entry" option, both applied via `PATCH /api/profiles/:id/exercises/:exerciseId` (`{canonical_name}` or `{keep_as_typed:true, typed_name}`).

**Confirming a chip persists the typed variant as an alias (2026-07-16 continuation session).** "✓" (tap, or the 8s auto-dismiss timer — treated identically, per the existing comment "untouched = left as saved, same as tapping check") calls `ecPersistConfirmedAlias()`, which fires `POST /api/exercise-catalog/confirm-alias` (`{canonical_name, typed_name}`, not admin-gated — a normal user-flow side effect, not a curation tool) before the chip is removed. The endpoint appends `typed_name` to the resolved row's `aliases` array, guarded so it's a true no-op when there's nothing to add: `typed_name` normalizing identically to `canonical_name` (covers `'alias'` hits, which are already an alias by construction — and by design still show a chip every time per the standing rule above, so this doesn't suppress future confirmations, it just stops the same `'fuzzy'`/`'haiku'` variant from repeating fuzzy/Haiku resolution work on every subsequent save) or the alias already being present. This was a real gap found on resume after a mid-session restart: the confirm chip existed and correctly gated on method, but "✓" was previously a pure UI no-op (`ecDismissChip()` just removed the chip) — confirming never fed anything back into the catalog, so the exact same typed wording would re-run fuzzy/Haiku resolution (and re-show a chip) every single time forever. Fire-and-forget on the client, silent-fail on the server (`{success:true, action:'skipped'|'failed'|'added'|'already_present'}`) — never blocks dismissing the chip.

**wger bulk-seed — `POST /api/debug/seed-exercise-catalog`, admin-gated, `?max_calls=N` (2026-07-16, replaces the never-run MuscleWiki seed that previously lived at this same route).** wger.de is a free, keyless, open (CC-BY-SA 4.0) exercise database — chosen specifically because the prior MuscleWiki seed was built across two sessions but never actually called (its API requires a paid $10/mo key that was never obtained); retired rather than left dormant, per audit — all `MUSCLEWIKI_API_KEY` references and the MuscleWiki implementation are gone from `server.js`. `musclewiki_id` stays on the schema, unused for now, reserved for a future MuscleWiki **video-streaming** layer (a separate concern from data seeding — see ROADMAP.md §7).
- **API shape confirmed live before writing any code** (not from memory/docs): `GET /api/v2/exerciseinfo/?language=2&limit=&offset=` returns each exercise base FULLY denormalized in one call — `category` (8 values), `muscles`/`muscles_secondary` (15 values), `equipment` (11 values), and a `translations[]` array (one per language, each with its own `name` + `aliases[]`) — so, unlike MuscleWiki's list-then-per-item-detail split, no separate throttled detail fetch is needed. 842 total exercises as of this session (filtered to `language:2`, English).
- **Vocabulary mapped onto this app's OWN conventions**, not wger's raw vocab, hardcoded in `server.js` (`WGER_CATEGORY_MAP`/`WGER_MUSCLE_MAP`/`WGER_EQUIPMENT_MAP`, confirmed live via wger's own reference endpoints, small/stable so not re-fetched per run): category → wger is a pure gym-exercise database (no martial_arts/sports/mind_body/rehab), so every category maps to `'strength'` except `'Cardio'`; muscle → the SAME muscle-group vocabulary `MUSCLE_GROUP_MAP` already uses (chest/back/shoulders/biceps/triceps/core/glutes/quads/hamstrings/calves/grip_forearms — wger has no dedicated grip/forearm muscle, so that group is never populated from wger data, accurately not a gap); equipment → light label cleanup only (e.g. "SZ-Bar"→"EZ-Bar", "none (bodyweight exercise)"→"Bodyweight").
- **Throttled ~1/sec between PAGE fetches only** (9 pages at limit=100) — no per-item throttle needed since each page is already fully detailed. Capped-retry-with-backoff for non-2xx responses (the existing global GET-retry wrapper at the top of `server.js` already covers bare transient network errors). `max_calls` caps exercises actually WRITTEN per run (default 1000, comfortably covers all 842 in one call) rather than pages, so a small value is a safe dry run.
- **Merge-safe against everything pre-existing (critical)** — see the dedicated section below.
- **Run for real, 2026-07-16**: `{fetched:842, inserted:805, merged:27, refreshed:10, skipped:0, errors:0, page_api_calls:9}`. The 27 merges (during the seed run itself) were genuine collisions caught by save-time-identical `catalogNormKey` logic — e.g. wger's "Push-Up", "Squat", "Plank", "Bird Dog" merging straight into the CANONICAL_NAMES-seeded rows of the same name.

**wger merge-safety (critical — these rows are already referenced by real `exercises.name` history, e.g. "Bicep Curl", "Dumbbell Curl", "Close Grip Push-Up", "Hang Clean" all predate this seed).** For each wger exercise, checked in order: (1) an existing row already has this EXACT `wger_id` (a re-run) → REFRESH that row's muscle/equipment/family data only where currently empty, union new aliases, `canonical_name` untouched; (2) else the wger name or any of its aliases normalizes (`catalogNormKey`) to an EXISTING row's `canonical_name` or an existing alias → MERGE: fill only EMPTY fields, union aliases, set `wger_id` — the existing `canonical_name` and its current aliases WIN, never overwritten, and only rows without their OWN `wger_id` are eligible merge targets (keeps `wger_id` 1:1); (3) else INSERT a new `source:'wger'` row. Every merge decision from case 2 is returned in the seed's `merges[]` array for review (27 of them this run — inserts/refreshes are summarized by count only, low-risk by construction).

**Post-seed near-duplicate audit (2026-07-16) — a real gap in the merge-safety logic above, found live, not by inspection.** `GET /api/debug/exercise-catalog-dupes` (admin-gated, read-only, general-purpose — not a one-off) indexes every row's `canonical_name` + every alias under `catalogNormKey()` and reports any key referencing 2+ distinct row ids — the same "is this the same exercise" logic save-time matching itself uses, run once across the whole table. First run post-seed found **5 clusters**, none of them false positives:
- `Overhead Tricep Extension` (id 33, `source:'custom'`, pre-existing) vs wger's `Overhead Triceps Extension` — the exact mid-string-plural `catalogNormKey` bug (above) manifesting as a real duplicate, since the ORIGINAL seed run's merge-safety check used the still-buggy normalizer.
- `Kettlebell Swing` vs `Kettlebell Swings`, and `Barbell Clean and press` vs `Clean and Press`'s own wger-supplied alias "Barbell Clean and Press", and `Side Dumbbell Trunk Flexion`'s alias "Side bends" vs `Side bend` — all **wger-vs-wger** collisions, a DIFFERENT root cause: the merge-safety step-2 check deliberately excludes rows that already have their OWN `wger_id` (to keep it 1:1), so two separately-inserted wger items that are textually related (one item's alias matching another item's already-claimed name) never got a chance to merge with each other during the single-pass seed run.
- `Hip hinge` vs `Good Morning`'s wger-supplied alias "Hip Hinge" — same wger-vs-wger root cause, but a **different resolution**: a hip hinge is a generic movement PATTERN (RDL, deadlift, good morning, kettlebell drills all use it), not a specific loggable exercise the way "Good Morning" is — the same safety class as "hang clean" never silently absorbing into "Dead Hang". Reviewed and confirmed by the user: **not a merge** — the stray alias was removed instead (`POST /api/debug/exercise-catalog-remove-alias`), leaving both rows intact and unambiguous.

**Two new general-purpose admin tools**, built for this cleanup but reusable for any future duplicate cluster: `POST /api/debug/exercise-catalog-merge` (`{winner_id, loser_id, retitle_canonical_name?}` — fetches BOTH rows fresh server-side rather than trusting anything the caller supplies, so it can never clobber data the caller didn't know about; unions aliases, fills only empty fields from the loser, optionally retitles the winner, deletes the loser) and `POST /api/debug/exercise-catalog-remove-alias` (`{id, alias}` — strips one alias without merging, for the "these are actually different exercises" case). **Real ordering bug found + fixed live**: the merge endpoint originally patched the winner before deleting the loser — whenever the winner had no `wger_id` of its own and was taking over the loser's, both rows briefly held the same `wger_id` at once and tripped the unique index. Fixed by deleting the loser first (with the loser's full pre-delete snapshot returned in the error if the subsequent winner patch somehow fails, so nothing already deleted is silently lost). 4 merges + 1 alias-removal applied 2026-07-16, all verified live (`Bicep Curl`/`Dumbbell Curl` still exactly 1 row each with history/PRs intact; `Bench Press` correctly muscle-tagged `{primary:["chest"], secondary:["shoulders","triceps"]}`; typing "overhead triceps extension" now hits `method:'exact'` against the merged row) — **re-running the dupe scan afterward came back `cluster_count:0`**. Final catalog size: 879 rows.

**Reviewed backfill (Part 5)** — `GET /api/debug/exercise-canonicalization-report/:userId` (admin-gated, read-only) reuses `resolveExerciseCatalog()` itself (not a separate reimplementation) over every distinct historical `exercises.name` for one profile, so the backfill proposal can never disagree with what a fresh save would resolve to today. Output is a human-reviewable `merge_list` (variant names + row counts grouped by proposed canonical target). **`POST /api/debug/apply-exercise-canonicalization/:userId`** (admin-gated) takes the — possibly hand-edited — mapping and rewrites `exercises.name` only (every other column untouched, so anything the micro-goal tracker/analytics depend on survives). Run once for real, 2026-07-16: profile 1's report proposed 14 rows across 9 groups; the user excluded "Dumbbell Curl"→"Bicep Curl" from the merge (a real distinct exercise, not a spelling variant) and approved the remaining 13, which applied cleanly — **re-verified on resume after a mid-session restart** (live production reads, not cached): `GET /api/profiles/1/exercises/Dumbbell%20Curl` still shows exactly its 1 original row untouched; `GET /api/profiles/1/exercises/Curl` and `/Elliptical` and `/Crunch` (the old bare names) are all `0` rows; `GET /api/profiles/1/exercises/Bicep%20Curl` shows all 4 sessions aggregated with sane PR data; the Dead Hang micro-goals (`strength_milestone` id 2, `daily_habit` id 1) both compute correctly live via `GET /api/profiles/1/micro-goals`. "Dumbbell Curl" itself was confirmed to have **no existing catalog row or alias** (`GET /api/exercise-catalog?q=curl` → only "Bicep Curl" and an unrelated "Curl and Squat", no "Dumbbell Curl") — the create command (not an alias command) via `POST /api/debug/exercise-catalog-upsert` with `family:'Bicep Curl'` is prepared but **not yet run**, deferred to the user (admin-secret-gated, run manually).

**Admin catalog curation** — `POST /api/debug/exercise-catalog-upsert` (create-or-update by `canonical_name`, sets `family`/`category`/`aliases`/muscle-group fields the save-time/backfill paths don't), `DELETE /api/debug/exercise-catalog/:id` (removes a row — no cascade concern, `exercises.name` is a plain text column, not an FK), `GET /api/debug/exercise-catalog-dupes`, `POST /api/debug/exercise-catalog-merge`, and `POST /api/debug/exercise-catalog-remove-alias` (all three added 2026-07-16, see above) — all admin-gated, general-purpose curation tools, not one-off scripts, since heuristic family-grouping and near-duplicate fragmentation will predictably recur with any future seed/backfill.

**Manual curation pass via `exercise-catalog-upsert`, run 2026-07-16 (curl, no session doc'd it at the time — recorded on the next doc-sync pass).** Three pre-wger custom rows that only ever get family/muscle data if a wger merge happens to fill it in — these three didn't, so they were curated by hand: `Bicep Curl` (id 9) → `family:"Bicep Curl"`, `muscle_groups_primary:["biceps"]`, `muscle_groups_secondary:["grip_forearms"]`; `Dead Hang` (id 18) → `muscle_groups_primary:["grip_forearms"]`, `muscle_groups_secondary:["shoulders","core"]`; `Dumbbell Curl` (id 100) → `family:"Bicep Curl"`, `muscle_groups_primary:["biceps"]`, `muscle_groups_secondary:["grip_forearms"]`. Remaining gaps of this shape get curated reactively as they surface — no bulk sweep planned. **This retroactively resolves two findings flagged earlier in this same file:**
- The "Dumbbell Curl doesn't group with Bicep Curl on the Library family rollup" finding (Phase 2 section below, "Verified live end-to-end") — both rows now share `family:"Bicep Curl"`, so as of this curation they group.
- The "`grip_forearms` shows zero/neutral on the muscle heatmap despite Dead Hang being the most-logged exercise" finding (same section) — Dead Hang's row now carries real primary/secondary muscle data, so `grip_forearms` should show non-zero intensity on the next heatmap load. Not re-verified live against the heatmap after this curation — flagged for a spot-check next session.

**wger CC-BY-SA attribution** — "Exercise database sourced from wger.de (CC-BY-SA)" in the Profile tab footer (`public/index.html`, below the "⚙ Open Settings" card, matching the existing `.mono`/`--text-dim` small-print convention used for other footer-style timestamps), linking to wger.de. Required by the license; kept low-key/tab-scoped per the existing UI conventions, not a modal or banner.

**Verified live**, not by reading code, against production (profile 4, a scratch test profile, for the matching pipeline; profile 1, real historical data, for the backfill): three spelling variants of "push ups" all resolved to "Push-Up" via `method:'exact'` (already covered by CANONICAL_NAMES); "close grip push-ups" and a genuinely made-up exercise name both correctly created NEW `source:'custom'` catalog rows via Haiku, each with a confirm chip; **the critical safety case — "hang clean" — correctly stayed its own distinct exercise, never silently merged into Dead Hang**; the Dead Hang micro-goal auto-tracker's `current_value` incremented 0→1 on a canonicalized save; a regression test with the catalog table not yet migrated (an empty/missing-table state) still saved successfully via the `'unavailable'` silent-fallback path. **A real, pre-existing bug was discovered incidentally during this verification** (see "Known Issues" in `ROADMAP.md` §6) — `exercises.duration_minutes` silently fails to insert for any non-integer value (0.75, 0.5, etc.), even though the extraction prompt's own Dead Hang rule explicitly instructs fractional-minute values ("45 seconds → 0.75"). Confirmed unrelated to this session's changes (the catalog resolution never touches `duration_minutes`) and reproducible on a whole-number-only basis (1-minute durations insert fine, 0.75/0.5 do not) — flagged, not fixed, out of scope for this session.

**Profile-4 test-data cleanup (2026-07-16 continuation session).** On resume after the mid-session restart, re-checked profile 4 live rather than trusting the prior session's notes: `GET /api/profiles/4/exercises`, `/api/workouts?profile_id=4`, and `/api/profiles/4/micro-goals?include_inactive=1` are all **already empty** — no leftover test workouts or a "Dead Hang Practice" micro-goal exist, so nothing to delete there (either the prior session cleaned these up before the restart, or the verification passes above only ever wrote orphan `exercises` rows via direct `extract-exercises` calls that were since removed). The **shared, global** `exercise_catalog` table is a different story since it isn't scoped to profile 4: the made-up exercise from the verification pass left behind a real row, "Kettlebell Twist Press" (id 20, `source:'custom'`) — a genuine test artifact, not a real exercise, flagged for deletion via `DELETE /api/debug/exercise-catalog/20`. "Close Grip Push-Up" (id 19) and "Hang Clean" (id 21) are legitimate — they stay, confirmed as not duplicating anything MuscleWiki-seeded since that seed never ran (still `status:'pending'`, no `source:'musclewiki'` rows exist in the catalog at all).

## Exercise How-To Content Seed — description + images (2026-07-17, session #25)

Adds how-to text + images to `exercise_catalog` for a future clickable exercise-detail view (video OUT of scope). **Backend/data only this session — no frontend touched.**

- **Migration** `migrations/2026-07-17_exercise_catalog_content.sql` (run manually): adds `description` (text) + `images` (jsonb: `[{url, is_main, license_author}]`), both nullable (null = never populated).
- **`POST /api/debug/seed-exercise-content`** (admin-gated, `?max_calls=`, `?force=`) — populates both columns from wger's `exerciseinfo` API, matched to our rows **by `wger_id`** (UPDATE only, no name-matching, no inserts). **Fill-if-null** by default (idempotent/re-runnable); `?force=1` overwrites. Same bulk-fetch shape as the structure seed (~9 pages @ limit=100, ~1 req/sec, capped retry). Returns real coverage counts (`matched_to_wger`, `descriptions_written`, `images_written`, `skipped_already_populated`, `wger_had_no_content`).
- **`sanitizeWgerHtml()`** — wger descriptions are HTML; sanitized at seed time to a strict, attribute-free tag allowlist (`p/ul/ol/li/br/strong/b/em/i`), dropping `<script>/<style>` blocks and every other tag (keeping inner text). No attributes ever survive → safe to render later with a plain `innerHTML`, no runtime sanitizer needed. Returns null for empty/text-less input.
- **Images are hot-linked** (wger.de URLs), not rehosted (per decision). CC-BY-SA: the wger.de footer credit already exists; `license_author` retained per image for future attribution.
- **Actual coverage (seed run 2026-07-17):** `{ matched_to_wger: 839, descriptions_written: 816, images_written: 263, wger_had_no_content: 18, errors: 0 }` — 816 rows got a description, 263 got ≥1 image. (Projection had been ~770/~250; real numbers came in a bit higher.) The ~74 non-wger rows stay null.
- **`exercise-catalog-merge` now UNIONs array data** (2026-07-17): factored into a shared `mergeCatalogRowsById(winnerId, loserId, retitle)` helper (used by both the merge endpoint AND the batched cleanup below). `muscle_groups_primary/secondary`, `equipment`, and `images` are unioned across the pair (was fill-if-empty, which could drop an enriched loser side); `description` stays fill-if-empty (scalar prose can't merge — winner wins, loser fills a gap); `family`/`wger_id` unchanged (winner authoritative / 1:1). Ensures a cleanup merge never drops a freshly-seeded field.
- **`POST /api/debug/exercise-catalog-cleanup`** (admin-gated, `?dry_run=1`) — runs the curated one-off `CATALOG_CLEANUP_PLAN` in one call: renames (auto-converted to a merge if the target name already exists), merges (via the shared helper), deletes, and family fixes. Resolves everything by `canonical_name` against a live index it maintains as it mutates (idempotent-ish — a re-run skips already-done ops as `not_found`). Returns a full per-op report + final row count. Plan (approved 2026-07-17): 24 renames, 13 merges (incl. 2 rename-collisions "Pistol Squat"/"Side Plank" and the 3-way calf-raise), 3 deletes, 1 family fix (Dead Hang "Deadhang"→"Dead Hang"); "Kreis Press DB", "Low-Cable Cross-Over - NB", "Kettlebell One Legged Deadlift" deliberately left as-is (ambiguous/legit, not guessed).

## Exercise Detail View — How-To Rendering + Zero-History Mode (2026-07-17, session #26)

Makes the seeded how-to content (session #25) visible in the Library exercise detail view (`showExerciseDetail`, renders into `#lib-detail`). Frontend + a small scoped backend addition. Video out of scope; no "Log this" CTA yet (that comes with the AI-rec/Guide clickability in a later session, where the view is actually reachable from unlogged exercises).

- **Backend — `GET /api/profiles/:id/exercises/:name` now also returns `category`, `description`, `images`.** After the existing (history-independent) catalog muscle attach finds the matched row, a **single targeted query** (`?id=eq.<match.id>&select=category,description,images`) fetches the how-to content for just that row — the shared `fetchExerciseCatalogWithMuscleData`/`buildCatalogMuscleIndex` (used by the grouped `/exercises` endpoint over ~865 rows) is deliberately NOT extended, so that endpoint's payload never carries the large description text. `buildCatalogMuscleIndex` entries gained an `id` field to enable the targeted fetch. Non-fatal — leaves the three fields null on any failure. The endpoint already worked for unlogged names (returns `history:[]` + catalog muscle data, no 404).
- **`renderExerciseHowTo(data, name)`** — a "how to" section mounted **after the muscle diagram** in both modes. Text-first: renders `description` (pre-sanitized at seed time → safe `innerHTML`) with the `is_main` image (or first image) shown **above** it, capped small (`max-height:240px`), `loading="lazy"`, `onerror` hides a broken hotlink. **Returns `''` when there's neither description nor image** (the ~74 non-wger + 18 no-content rows) — no empty block. The ~70% description-but-no-image case renders as label + prose and reads complete (image is a bonus, never the anchor).
- **In-section attribution** — the wger CC-BY-SA credit in the Profile footer (`index.html:1017`) isn't visible in the Library detail view, so `renderExerciseHowTo` adds a small muted line: "Image & guide via wger.de (CC-BY-SA)" (or "Guide via…" when text-only), plus the image's `license_author` **only when an image renders**.
- **Zero-history mode** — `showExerciseDetail` branches on `var logged = hist.length > 0`. Unlogged: renders name, category badge (from the new `data.category`, falling back to `'other'`), a muted "Not in your log yet." line, the muscle diagram, and the how-to — and **skips** the stat row, progression chart, performance analytics, session-history list, and AI insight. The post-render calls (`renderExDetailChart`, `loadExAnalytics`, `fetchExInsight`) are guarded behind `if (logged)` so nothing runs against elements the zero-history branch never rendered. Logged mode is unchanged except for the added how-to section.
- **CSS** id-scoped to `#lib-detail` (`.ex-howto`, `.ex-howto-img`, `.ex-howto-desc` + its `p`/`ul`/`ol`/`li`/`strong` children, `.ex-howto-attr`, `.ex-nolog`).

## Exercise Detail Reachability — Clickable Guide Cards + "Log this" CTA (2026-07-18, session #27, Job 1)

Makes the session-#26 detail view reachable from **every** catalog browse surface and adds the deferred "Log this" action. Frontend-only — no server, no schema, no `resolveExerciseCatalog`/`extract-exercises`/confirm-chip changes.

- **All Exercise Guide cards clickable (`filterLibGuide`, `public/index.html`).** Previously only rows with a `logged Nx` badge (`isLogged`) got an `onclick`/`cursor:pointer`; unlogged rows were display-only. Now **every** row calls `showExerciseDetail(canonical_name)` — session #26's zero-history mode already handles an unlogged catalog exercise (renders name/category/muscle-diagram/how-to, skips stats/chart/analytics/insight), so an unlogged Guide tap opens correctly to that view. The `logged Nx` badge still shows only for exercises in this profile's history (`isLogged` is retained, just no longer gates the click). This closes the explicit "unlogged rows are display-only, no click handler" scope note from the session-#25 Guide build.
- **Exercises list (`libExerciseCardHtml`) — no change needed, confirmed.** That list is built from `libExercises` (this profile's own history via `GET /api/profiles/:id/exercises`), so every entry is by definition already logged and already clickable. There is no unlogged-entry case there to fix.
- **"Log this" CTA (the piece deferred from session #26).** `showExerciseDetail` now renders an ember button (`.ex-log-cta`) under the category badge in **both** modes — "Log this exercise" (zero-history) / "Log this again" (logged). It calls a new `logThisExercise(name)` which reuses the existing AI-rec prefill path: `prefillLogFromAI('', '', [name], '')` → the Log Workout modal opens with notes prefilled to a single `- <Exercise>` bullet (empty type/headline), which `extract-exercises` re-canonicalizes on save exactly like any typed note. No new prefill plumbing.
- **CSS** — one new id-scoped rule `#lib-detail .ex-log-cta` (block, full-width, ember, matches the existing AI-rec "Log This Workout" button styling), added beside the session-#26 `.ex-nolog` rule.

### Job 2 — AI-rec exercise names clickable (read-only exact/alias linking)

AI rec exercise lines (`renderAI`, `public/index.html`) are freeform strings ("Bench Press 3x8 @ 135lbs"), not clean catalog names. This links a line to its detail view ONLY when it resolves to a catalog canonical at the exact/alias tier — never fuzzy/Haiku, never a write.

- **`resolveExerciseCatalog` was NOT reused wholesale** — deliberately, on two counts audited before building: it's server-only, and its Haiku fallback CREATES `source:'custom'` rows (`createCustomCatalogEntry`), which a browse/display surface must never trigger. Instead, its step-1 exact/alias block was **extracted into a shared `matchCatalogExactAlias(name, catalog)`** (`server.js`) that `resolveExerciseCatalog` now calls too — ONE implementation, no drift, and the read-only path gets exactly the top-confidence tier (the same bar as save-time `method:'exact'`/`'alias'`) with no fuzzy, no Haiku, no writes.
- **`stripExerciseAnnotation(raw)`** (`server.js`) — isolates the leading exercise NAME by cutting at the first digit / `@` / `(` / spaced separator (`-–—:`). Conservative: catalog names are word-only so it never truncates a real name; a line leading with a number ("90/90 hip rotation", "3 rounds…") or a compound ("A + B") yields something that simply misses → plain text. Never guesses.
- **`POST /api/exercise-catalog/resolve-batch`** (`{names:[…]}` → `{results:{raw:canonical|null}, matched, total}`, not admin-gated) — strips + exact/alias-matches each string over the lean `fetchExerciseCatalogForMatching()`. Keyed by the RAW string the client holds. Fully non-fatal: any failure returns empty results → everything stays plain text.
- **Client** — `aiRecLinkCache` (raw string → canonical|null, session-persistent) + `ensureAIExerciseLinks(strings)`: after `renderAI` paints, one batched resolve of all not-yet-cached strings across ALL options, then a single re-render. Re-entry-guarded (`aiRecLinkFetching`) and loop-safe (every requested string is written to the cache — null on miss/failure — so it's never re-requested). An exercise line renders as an underlined, `stopPropagation`-guarded clickable span **only when `aiRecLinkCache[str]` is truthy**; null/undefined → the exact same plain span as before (purely additive).
- **On a miss → plain text, never a link.** A link is only ever emitted for a string confirmed to resolve to a real catalog row, so a click always opens a real detail view (zero-history mode handles an unlogged one).
- **Match rate — measured live against real output** (`POST /resolve-batch`, production): (1) **profile 1's real cached rec** (2026-07-17, a *recovery-yoga* day) — **8/33 (24%)**: Cat-Cow×3, Wall Slide×3, Dead Bug, Child's Pose all correct; the 25 misses are all correct too (hand-rehab micro-movements + yoga poses not in the catalog, the "Dead Hang **Everday**" typo, "90/90…" leading-number, "Supine dead bug" qualifier, compound "A + B" lines). (2) **strength-day probe** (20 representative training lines) — **16/20 (80%)**; the 4 misses are principled exact/alias misses ("DB"-abbreviated "Incline DB Press", qualifier-prefixed "Barbell Squat" vs the bare "Squat" row, "Bent Over Row", "Dumbbell Bench Press"). **Zero wrong matches across all 53 lines** — the stated bar ("a wrong-match link is worse than no link") held. Match rate is content-dependent: high on clean strength lines, low on mobility/rehab/compound days, always zero false links.

### Job 3 — wger variations (variation_group, read-time sibling resolution)

Captures wger's OWN variation model (confirmed live: each `exerciseinfo` item carries a `variation_group` UUID; items sharing it are variants), rather than a denormalized id-array.

- **Migration** `migrations/2026-07-18_exercise_catalog_variation_group.sql` (**run in production 2026-07-18**): adds `variation_group text` (nullable) + a partial index (`WHERE variation_group IS NOT NULL`). Column-add only, no RLS/policy change.
- **`POST /api/debug/seed-exercise-variations`** (admin-gated, `?max_calls=`, `?force=`) — fills `variation_group` from wger by `wger_id` (UPDATE-only, fill-if-null), same bulk-fetch shape as the content seed. **Run 2026-07-18 — ~207 variation groups seeded.** Returns coverage counts (`matched_to_wger`, `variation_groups_written`, `wger_had_no_group`, …).
- **Read-time sibling resolution** — `GET /api/profiles/:id/exercises/:name` now attaches `variations` (array of sibling canonical names): after the existing catalog `match`, its OWN query (separate try/catch, so a pre-migration missing column can't null out the description/images attach) reads the matched row's `variation_group`, then `variation_group=eq.X&id=neq.<self>&select=canonical_name`. Because it queries the LIVE catalog, merged/renamed rows resolve to current names and deleted ones never appear — the group-key approach gives "skip any that no longer exist" for free (the session-#25/#8 merge/rename churn self-heals with zero array upkeep). `null` unless ≥1 live sibling.
- **Client** — `renderExerciseVariations(variations)` renders a clickable "Variations" chip section in `showExerciseDetail` (both modes, after the how-to), each chip → `showExerciseDetail(sibling)`; returns '' when empty (no section, never an empty block). CSS id-scoped: `#lib-detail .ex-variations`/`.ex-var-chips`/`.ex-var-chip`(+`:hover`).
- **DONE — migration applied + seed run, re-verified live 2026-07-18** (doc-sync pass, real production reads): `GET /api/profiles/1/exercises/Lunges` → 5 siblings (`Barbell/Dumbbell Lunges Standing/Walking`, `Reverse Lunge`), `Romanian Deadlift` → 6 (`Deadlifts`, `Deficit/Rack/Speed/Sumo Deadlift`, `Stiff-legged Deadlifts`), `Bench Press` → 10 — the read path returns real current-catalog sibling names, confirming both the column and the seed are live. (The `variations:null` non-fatal degrade path only applied pre-migration.)

## Logged-Workout Sectioning + Inline Exercise Quick-Views (2026-07-20, session #32)

Frontend-only (`public/index.html`). Grouped History rendering, clickable exercise names that expand an inline quick-view (how-to on the rec card, stats in History), and follow-up polish. No schema, no endpoints, no writes; the two data endpoints are reused as-is.

### Round 1 — grouped logged-workout render + quick-view card

Three **pure** helpers, shared across the History surfaces (replacing the old name-only chip row):
- **`groupLoggedWorkout(exercises, notes)`** → `{ groups:[{key,label,exercises[]}], multiCategory, notes }`. Group key = `main_category || category || 'other'`; group order is **first-appearance**; logged order is **preserved within** a group; labels come from the reused `CATEGORY_PRETTY` map (no new map). `multiCategory` is `groups.length > 1`.
- **`renderLoggedGroupsHtml(grouped, opts)`** — one `.lw-groups` block; a small uppercase `.lw-group-header` per group **only** when `multiCategory` (a single-category workout lists flat, no header); returns `''` when there are no exercises. Each line is `exerciseToNotesLine(ex)`. (`opts` — `{surface, workoutId}` — was added in Round 2 for the name-tap wrapping; a call with no `opts` renders plain, unchanged.)
- **`renderLoggedNotesHtml(notes)`** — a `.lw-notes` block rendered **only** when non-empty after trim, always placed **LAST** by the caller. Never an empty "Notes" heading.

Two consumers share them: **`renderLogPastRowDetail`** (`#log-past-panel`) and **`renderLog`** (`#tab-history`), the latter having replaced its name-only chips with grouped rows + notes-last.

**Full exercise rows are now retained.** `ensureHistoryChipsLoaded()` used to discard the fetched rows down to bare names; it now keeps the full objects in **`historyExercisesByWorkoutId`**, so the grouped render (and the quick-view stats gate) read them with **no new fetch**.

**Quick-view card `#history-quickview`** — mounted at the top of the History list by `renderHistoryQuickView()` (called at the end of `renderLog`). Shows the **latest** session's type + a group summary (`loggedGroupSummary` → `"Strength · 6 | Cardio · 1"`) + duration **only when derivable** (`loggedDerivedDuration`: summed `exercises.duration_minutes`, else `wearable_data.duration_minutes`; returns `null` → the field is omitted, **never estimated**). Hidden entirely when there are no workouts. Reuses the same already-loaded data — no fetch. CSS id-scoped to `#history-quickview`.

**Dead code removed:** `openChipExercise()` (the old name-chip click handler).

**Decisions:** sections are **derived from category, never inferred** — a log is a *record*, not a plan, so there is no Warm-up/Main/Add-on guessing (that only applies to the AI *rec* shape). Notes render only if present. The quick-view mounts on **History, not Today** — a Today card would need a new fetch, **declined**.

### Round 2 — clickable exercise names → inline quick-view (ONE component, two modes)

- **`exerciseQuickViewHtml(mode, name, key)`** + **`toggleExerciseQuickView(mode, name, key, surface)`**, backed by module state **`exQuickOpen`** (`key → true`; survives each surface's wholesale re-render so an open row re-expands on every paint) and **`exQuickCache = { howto:{}, stats:{} }`** (`name → payload | 'loading' | 'error'`). **Lazy fetch on first expand only** (`fetchExerciseQuickData`), cached per name; the surface re-renders once immediately (spinner) and again on resolve. `surface` is `'ai' | 'hist' | 'lp:<id>'` and drives `rerenderQuickSurface` (→ `renderAI` / `renderLog` / `refreshLogPastDetail`).
- **Surface 1 — rec card (`renderAI`):** the exercise **NAME only** is the tap target, split off via **`splitExerciseName(raw)`** (a client mirror of the server `stripExerciseAnnotation` cut rule at `server.js:3404` — cut at the first digit/`@`/`(`/spaced separator); the set/rep remainder trails as plain text and `exN` continuous numbering is untouched. Tap → **how-to** quick-view, which reuses **`renderExerciseHowTo(payload, name)`** verbatim (image + description + wger CC-BY-SA, empty-return intact). `showExerciseDetail` moved out of the name and into a **"Go to exercise →"** link inside the quick-view (`gotoExerciseDetail` = `showTab('library')` + `showExerciseDetail(name)`, so it works from any origin tab).
- **Surface 2 — History detail + Log-past (`renderLoggedGroupsHtml`):** wraps the **structured `ex.name`** (no string parsing). Tap → **stats** quick-view (`renderExerciseStatsMini`).
- **CORRECTNESS (load-bearing).** The stats fetch and the go-to link key off the **stored `ex.name`**, **not** the catalog canonical. `GET /api/analytics/exercise-stats/:userId/:exerciseName` matches `exercises.name` **exactly**; a legacy/pre-canonicalization row's stored name can alias-resolve to a *different* canonical, so fetching by canonical would return an empty series. The catalog canonical is used **only** as the clickability gate.
- **Clickability gate = `matchCatalogExactAlias`** via the existing `POST /api/exercise-catalog/resolve-batch` (exact/alias only — no fuzzy, no Haiku, no writes). Rec card keeps `aiRecLinkCache`/`ensureAIExerciseLinks`; the History surfaces use **`ensureExerciseLinks(strings, rerender)`** (a generalized resolver writing the **same** `aiRecLinkCache`, guarded by an `exLinkInFlight` set so the resolve-then-rerender loop is bounded). A miss caches `null` → plain, non-clickable text on both surfaces.
- **Rename (display only).** The daily **"Full override today"** button + **"Today: Full Override"** pill → **"Mix Focus Today" / "Today: Mix Focus"**. The `focusOverrideDaily('total')` argument, the `resolveFocusOverride`/`mode==='total'` logic (`~:8896`), stored values, and the separate standing-config **'Total'** mode selector are all untouched — pure UI text.

### Round 3 — quick-view follow-ups

- **Bubbling fix.** The History name-tap now runs `event.stopPropagation()` so it toggles only the quick-view and no longer reaches the workout card's `toggleLogCard`. (Log-past was already fine — its toggle lives on the header row, not the detail div.)
- **Single-open per panel family.** On open, `toggleExerciseQuickView` clears any other open key in the same family (`quickViewFamily` → `ai` / `hist` / `lp`), then re-renders every surface a collapse touched (`keySurface` reconstructs each cleared key's surface, so cross-row Log-past collapses repaint correctly). A second tap on the same key still just collapses it.
- **Stats fields (`renderExerciseStatsMini(data, name, key)`).** `Best set`/`Best hold` relabeled to **`PR`**; added **`Average`** (`avg_reps_per_set`, or `avg_seconds_per_set` as m:ss for duration moves; omitted when null). Final six: **Last performed** (from the `daily_data` tail) **· Total sessions · PR · Average · Est. 1RM** (weight-based only) **· Trend** (`exStatsTrend` — a last-vs-previous-session delta from `daily_data`, `▲`/`▼`/`▬`, omitted with < 2 sessions; no fake delta). Duration moves show seconds (`fmtMMSS`), never reps.
- **Mini Progress-Over-Time chart (STATS mode only).** Reuses `renderExDetailChart`'s single-line logic via **`quickViewChartSeries(data)`** (built off the `exercise-stats` `daily_data` already in the payload — **no new fetch**) → **`buildQuickViewChart(canvas, data)`**. Duration-aware (seconds axis + m:ss tooltip), weight/reps otherwise, PR point gold. 140px fixed-height wrapper + `maintainAspectRatio:false` (no resize loop); own instance per canvas id in **`quickViewCharts`**; **`flushQuickViewCharts()`** (called after every stats-surface paint) mounts open canvases and destroys orphaned ones — no leaked charts across taps. Skipped when there are **< 2 real points** (also covers pure-distance moves `daily_data` can't aggregate). **Never** rendered in the rec-card how-to.
- **Escaping fix.** The chart canvas `data-exname` (read back via `getAttribute` to look up the cache) must use **`attrEsc`** (HTML-entity escaper), not `escAttr` (which backslash-escapes quotes for JS-string context) — otherwise an apostrophe name like `"Child's Pose"` fails the cache lookup.

**CSS** for all of the above is id-scoped to `#ai-content` / `#tab-history` / `#log-past-panel` / `#history-quickview` (the how-to markup is re-styled compactly under `.ex-qv` per surface so the `#lib-detail .ex-howto*` rules are untouched). No global class changes; `renderAI` card chrome/colors untouched.

## Exercise Canonicalization Phase 2 — Library Rollups, Muscle Filter, Muscle Heatmap (2026-07-16)

The queued phase-2 consumer of `exercise_catalog.family`/`muscle_groups_primary`/`muscle_groups_secondary` (ROADMAP.md §7 priority 4) — the columns have existed and been populated since the wger seed, but nothing read them until this session. No schema changes; `resolveExerciseCatalog()`, `extract-exercises`, the confirm chip, and `normalizeExerciseName()` are all untouched.

**Server — catalog attach on the grouped exercises endpoint.** `GET /api/profiles/:id/exercises` (the grouped-by-name summary that feeds `libExercises` client-side) now fetches the catalog once per request via a new `fetchExerciseCatalogWithMuscleData()` (a separate, richer-select sibling of `fetchExerciseCatalogForMatching()` — that one deliberately stays lean for the hot save-time path, untouched) and indexes it by `catalogNormKey()` over every `canonical_name` **and alias** (`buildCatalogMuscleIndex()`) — reusing the exact normalization save-time matching uses, never a reimplementation. Each grouped exercise gets `{family, muscle_groups_primary, muscle_groups_secondary}` attached by normKey match on its (already-canonical) stored name; no match → all three `null`. Catalog fetch failure is non-fatal — attaches nothing, mirrors `resolveExerciseCatalog()`'s own `'unavailable'` degrade philosophy, endpoint still returns 200.

**Client — family rollups (Library → Exercises, unfiltered state only).** `renderLibExercisesGrouped()` groups `libExercises` by `family`; a family with 2+ variants renders one collapsible `libFamilyCardHtml()` card (name, variant count, aggregate total count, most-recent date across variants) — tap to expand into the *exact same* `libExerciseCardHtml()` cards used everywhere else (extracted from the old inline loop specifically so flat and grouped rendering can never drift apart). Single-variant families and `family:null` exercises render as plain cards; `family:null` exercises additionally collect into a bottom "uncategorized" section (custom BJJ/MMA entries, etc.), never grouped. **Deliberate v1 simplification**: any active search/category/subcategory/muscle filter falls through to the flat list exactly as before phase 2 — no partial-family logic. `applyLibSort()` (existing, unmodified) is reused as-is for the top-level family+single sort by feeding it `{name, count, last_date}`-shaped wrapper objects (family aggregates in the same fields real exercise rows already use) — and again, unmodified, on the variants inside a family and on the uncategorized list.

**Client — muscle-group filter.** 11 pills (`MUSCLE_FILTER_GROUPS`, the same `MUSCLE_GROUP_MAP` keys) below the category/subcategory pills, single-select (tap again clears, no persistence — parity with category pills), plus a Primary / Primary+Secondary toggle (`libMuscleMode`, default both). `exerciseMatchesMuscleFilter()` checks the attached arrays; an exercise with no catalog match (`muscle_groups_primary: null`) never matches any filter, so it's excluded while a filter is active and reappears when cleared — no special-casing needed, falls out of `(ex.muscle_groups_primary || [])` naturally. Combines with search/category (all still route to the flat-list branch).

**Muscle heatmap (`GET /api/analytics/muscle-volume/:userId?days=7|30|90`).** Pattern-matched to the existing analytics endpoints: `getProfileTimezone()` + `localToday(profile, -windowDays)` for the window start, a plain `exercises` fetch (name/sets/date) in range, the same catalog index as the endpoint above. Weighted volume per group: `(sets||1) × 1.0` per primary group hit, `× 0.5` per secondary — normalized to a 0–1 `intensity` against that request's own max group (all-zero → all-zero intensity, not a divide-by-zero). Read-only, non-fatal: **any** failure (profile/exercises/catalog fetch) degrades to all-zero groups with a 200, never a 500. Client renders a "MUSCLE HEAT" card on the Library Dashboard (below the category breakdown bars) — 7D/30D/90D pills styled with the Library's own ember tokens (not a literal reuse of `anRangePills()`, which is styled with the legacy `--accent` tokens from the pre-token-migration Profile-tab analytics card); two **original geometric SVG figures** (front/back, `HEATMAP_FRONT_SHAPES`/`HEATMAP_BACK_SHAPES`, each region a rounded-rect `<path data-muscle="...">` built by a small `svgRoundRectPath()` helper) — explicitly not traced or sourced from MuscleWiki/wger/any third party, stylized/geometric by design (licensing note, ROADMAP.md §7 priority 5). Fill = ember opacity ramp (`rgba(255,74,28, 0.08 + 0.72×intensity)`) on non-zero groups, `--bg-surface-2` + `--border-subtle` outline on zero — tap/hover a region shows a `.font-mono` readout (group label + weighted sets). Loading skeleton while fetching; a genuine network failure renders a quiet static message, no retry loop (the server's own non-fatal design means this path is rarely hit — a "no data" result is a normal 200 with all-zero groups, not an error). Cached per `profileId:days` key (`libHeatmapLoadedKey`) so switching Dashboard↔Exercises↔Records doesn't re-fetch.

**Verified live end-to-end, not by reading code** (profile 1, real historical data; profile 4, scratch profile, for a controlled 2-variant grouping test since profile 1's real data currently has no family with 2+ logged variants):
- **Family grouping mechanics** — profile 1 has zero families with 2+ variants right now (every family-tagged exercise Shimmy has actually logged is a lone variant — e.g. "Push-Up" has no "Close Grip Push-Up" etc. in his real history), so no family card renders there today; not a bug, just what the current wger-seed × logged-history intersection produces. Built a real, predictable 2-variant family on profile 4 instead — "Wide-Grip Lat Pulldown" + "Single-Arm Lat Pulldown" both strip to `family:"Lat Pulldown"` under the documented wger family heuristic (confirmed via the public catalog search before logging) — and verified via browser: collapsed card shows "2 VARIANTS · 2x total · last [date]" correctly; expanding reveals both variant cards with correct individual stats (12 reps / 10 reps), unchanged from their flat-list appearance. Test rows cleaned up after.
- **"Dumbbell Curl" — a real, more nuanced finding than a simple pass/fail.** The catalog-upsert from the prior session's backfill *was* run (`family:'Bicep Curl'` confirmed live on that row) — but the base "Bicep Curl" catalog row itself has `family:null`, because it's one of the 18 original CANONICAL_NAMES-seeded rows that predates the `family` column ever being populated by any pass (CANONICAL_NAMES seed, wger seed, or this manual upsert only ever targeted the Dumbbell Curl row). So they still don't group — same practical outcome as "upsert never run," different actual cause. Confirmed live via the API, not silently worked around.
- **Muscle filter** — "chest" (Primary+Secondary, the default) on profile 1's real data surfaces Wall Slide, Push-Up, and Crunches; toggling to Primary-only correctly drops Crunches (a secondary-only chest match) while Wall Slide and Push-Up (both primary) remain — confirms the toggle actually changes matching, not just its label. Tapping "chest" again clears the filter and the full list (including Dead Hang, which has no chest data) reappears.
- **Uncategorized section** — confirmed via direct DOM inspection that the "uncategorized" label renders at the exact correct boundary, with every `family:null` exercise (Bicep Curl and all custom BJJ/MMA entries — MMA Class, Kickboxing, Boxing Drill, Grappling Drill, Pad Work, MMA Sparring, MMA Kick Practice, Boxing) landing there, never grouped, and excluded from muscle-filtered results (confirmed no chest-filter false positive from anything uncategorized).
- **Heatmap** — rendered correctly on real profile-1 data at all three windows (7D/30D/90D all return distinct, sane `weighted_sets`/`intensity` values via direct endpoint checks; the 30D card screenshot shows a correctly-rendered ember gradient on chest/core/glutes/back/triceps/hamstrings with zero-volume regions — shoulders, quads, calves — correctly neutral). **Real, separate data-completeness finding**: `grip_forearms` shows zero/neutral at every window despite Dead Hang being the single most-logged exercise in the account (48x) — confirmed the "Dead Hang" catalog row has `muscle_groups_primary: []`/`muscle_groups_secondary: []` even though it carries `family:"Deadhang"` from the wger merge; wger's own "Deadhang" entry apparently has no muscle tagging of its own. This is upstream data sparsity in wger's dataset (a real gym-grip/isometric-hold category gap, not unique to this app), correctly reflected as zero by the code rather than a rendering bug — not fixed this session, not this session's data to curate.

## Exercise Guide, Per-Exercise Muscle Diagram, Heatmap Tap-Through, History Chips (2026-07-16)

Continuation session on top of Phase 2 above — the queued §7 priority-4/5 follow-ups (a Guide sub-nav, heatmap tap-through) plus two Feature additions (per-exercise diagram, History chips). No changes to `resolveExerciseCatalog`, `extract-exercises`, the confirm chip, canonicalization, or workout-notes handling; no schema changes; all endpoint changes additive/read-only.

**Exercise Guide — 4th Library sub-nav (`showLibView('guide')`, `#lib-guide`).** Browses the full shared `exercise_catalog` (~880 rows) independent of this profile's own history — a search box, the same 11-muscle-group pill row + Primary/Both toggle as the Exercises view (`MUSCLE_FILTER_GROUPS`/`MUSCLE_FILTER_LABELS` reused, but with its own independent filter state `libGuideMuscleFilter`/`libGuideMuscleMode` — not shared with the Exercises tab's `libMuscleFilter`), and an equipment `<select>` dropdown (matching the existing Library sort-dropdown convention rather than another pill row, built dynamically from whatever equipment values are actually present in the loaded catalog). Rows for exercises already in this profile's history get a green "logged Nx" badge (client-side cross-reference via `buildLoggedCountIndex()`, keyed by a client-side mirror of the server's `catalogNormKey()` — `catalogNormKeyClient()` — against the already-loaded `libExercises`) and tap through to `showExerciseDetail()`; unlogged rows are display-only (no click handler at all) — no how-to content/videos, explicitly out of scope (that's the separate, not-yet-built MuscleWiki video layer, ROADMAP.md §7 priority 9).
- **Server**: `GET /api/exercise-catalog` extended additively — now also selects `family`/`muscle_groups_primary`/`muscle_groups_secondary`/`equipment`, and accepts `?all=1` (bypasses the 50-row cap up to 2000, for Guide's one bulk load) or explicit `?limit=`/`?offset=`. The existing `?q=` confirm-chip search (`public/index.html`'s Part 4 "change" picker) is unchanged in shape/behavior — it just carries a few extra harmless fields now too.
- **Client**: `loadLibGuide()` fetches `/api/exercise-catalog?all=1` once and caches the result in the module var `libGuideCatalog` for the session (state machine `libGuideState`: idle/loading/loaded/error, mirroring the heatmap's own no-retry-loop error convention). `filterLibGuide()` applies search/muscle/equipment filters client-side, sorted alphabetically.

**Per-exercise muscle diagram (Library detail view, `showExerciseDetail()`).** Renders the same front/back SVG figures as the Dashboard heatmap — primary muscles full ember (`intensity:1`), secondary ~40% (`intensity:0.4`), everything else neutral — via a newly-**factored** `renderBodyFigureSvg(side, shapes, styleForMuscle)` shared helper (extracted from the old `renderHeatmapFigure`, which is now a thin wrapper passing a live-intensity-based `styleForMuscle`; `renderExerciseMuscleFigure` is the diagram's own thin wrapper passing a static primary/secondary-based one). Neither wrapper copy-pastes the `HEATMAP_FRONT_SHAPES`/`HEATMAP_BACK_SHAPES` region paths — both reuse the exact same arrays. `renderExerciseMuscleDiagramHtml()` skips entirely (no empty figure, no error) when both muscle arrays are empty.
- **Server**: `GET /api/profiles/:id/exercises/:name` now attaches `{family, muscle_groups_primary, muscle_groups_secondary}` (same non-fatal degrade pattern as the grouped `/exercises` endpoint's own catalog attach — any failure just leaves these null, never blocks the response). This single endpoint covers every entry path uniformly (Exercises list, Records, Guide, and the new History chips below) since Guide only ever opens the detail view for exercises already in history (unlogged rows are display-only, no tap) — no separate "pass the catalog row through" plumbing was needed.
- **Verified live**: `Bench Press` → `primary:["chest"], secondary:["shoulders","triceps"]` (diagram renders); a custom entry (`MMA Class`) → empty arrays both sides (diagram correctly absent).

**Heatmap tap-through (Dashboard MUSCLE HEAT card).** The region's `onclick` and `onmouseenter` were already wired to the identical `showHeatmapReadout()` handler — mobile tap has no separate hover stage to consume before a tap, so there was no genuine "reveal, then navigate" two-stage interaction to build a second stage onto. Resolution: kept the existing readout exactly as-is, and grew it into an explicit **"View Exercises →"** link (now `el.innerHTML`, was `el.textContent`) that appears once a region has been tapped/hovered. Tapping the link calls `navigateToMuscleFilter(muscle)` — sets `libMuscleFilter`/`libMuscleMode='both'` and switches to Library → Exercises, landing pre-filtered to that muscle in Primary+Secondary mode.

**History-card exercise chips (`#tab-history`, `renderLog()`).** Each expanded workout card renders its extracted canonical exercises as tappable, deduped chips below the notes (name only; notes themselves are never altered — the chips are a read-only canonical layer on top). Tapping a chip calls `openChipExercise(name)` → switches to the Library tab and opens that exercise's detail view. Workouts with zero extracted exercises (most Rest Days, unparsed notes) render no chip row.
- **Data source — no server change, no N+1.** `GET /api/profiles/:id/exercises`'s `raw` field already carries `id`/`workout_id`/`name` per exercise row (it's the same endpoint `loadLibrary()` already calls — the field was just discarded by the client until now). `ensureHistoryChipsLoaded()` does ONE lazy bulk fetch on first History-tab open, builds a `workout_id → distinct names[]` map (`historyChipsByWorkoutId`), and re-renders. Cached per-profile (`historyChipsLoadedForProfile`, mirroring `libHeatmapLoadedKey`'s convention) since `switchProfile()` doesn't reset this cache on its own — without the profile key, switching profiles would show a stale profile's chips until a full page reload.

**Verified live against production, profile 1** (data layer; UI click-through handed to the user to spot-check manually since the browser tool in this session couldn't reach a visible display): catalog search `?q=curl` returns 73 catalog-wide results; `?all=1` returns the full 881-row catalog; `GET .../exercises/Bench%20Press` correctly attaches primary/secondary muscle data; `GET .../exercises/MMA%20Class` correctly attaches empty arrays; the grouped `raw` array correctly carries `workout_id` per row (65 distinct workout ids with exercises on profile 1) confirming the chip-mapping data is sound.

## DELETE /api/workouts/:id — Orphaned Exercises Fix (2026-07-16)

**Bug, found live**: `DELETE /api/workouts/:id` only ever deleted the `workouts` row — it never touched `exercises` rows scoped to that `workout_id`, so every workout delete silently orphaned its extracted exercises. `DELETE /api/profiles/:id` has the identical gap (deletes `workouts`, never `exercises`) — noted in ROADMAP.md §6/§9 as a same-root-cause, out-of-scope-this-session item (narrower fix requested).

**Fix**: `DELETE /api/workouts/:id` now deletes `exercises WHERE workout_id=:id AND profile_id=:pid` (same profile-ownership guard `DELETE /api/profiles/:id/exercises/:exerciseId` already uses) before deleting the workout row itself. No schema change — an `ON DELETE CASCADE` FK would be more robust long-term but was explicitly deferred (flagged in ROADMAP.md §9) in favor of this narrower, no-migration fix.

**`PATCH /api/workouts/:id` audited for duplicate-stacking risk on notes edits — there isn't one, because it never re-extracts at all.** Traced the client edit path (`saveWorkout`→`updateWorkoutInSupabase`, `public/index.html`): editing a workout's notes only regenerates the AI-generated title when notes changed; nothing calls `/extract-exercises` again. So edits can't stack duplicate exercise rows, but there's a related, unfixed staleness gap: editing notes to actually change which exercises were done leaves the ORIGINAL extraction's `exercises` rows untouched (stale, not duplicated) — flagged in ROADMAP.md §6, not fixed (needs a replace-vs-diff design decision).

**New report-first admin cleanup pair**, mirroring the exercise-canonicalization backfill pattern exactly (GET report → human review → POST the reviewed ids, never a blind auto-apply): `GET /api/debug/orphaned-exercises/:userId` (admin-gated, read-only — lists this profile's `exercises` rows whose `workout_id` no longer references an existing `workouts` row, grouped by name/date with counts and per-group ids) and `POST /api/debug/delete-orphaned-exercises/:userId` (admin-gated, body `{ids:[...]}` — the possibly-edited id list from the report; re-verifies each id is still orphaned AND belongs to this profile fresh server-side before deleting, never trusting the caller's list blindly, same discipline as `/api/debug/exercise-catalog-merge`).

**Verified live** (profile 4, throwaway workout): logged a workout (id 103, notes "Test Orphan Bench Press 3x10 @ 100lbs"), ran `/extract-exercises` (created exercise row id 317 with `workout_id:103`), confirmed the row existed via `GET /api/profiles/4/exercises?name=Bench%20Press`, then `DELETE /api/workouts/103` — confirmed both the workout row AND its exercises row were gone afterward (0 rows).

**Save-time matching re-verified live, 2026-07-16 (no code change, spot-check only).** Two fresh typo'd saves against production both resolved correctly — "dumbell curlz" and "bench pres" — with the typo persisted as an alias on confirm-chip auto-dismiss, matching the confirm-persistence behavior documented above.

**Profile-1 cleanup run and verified (2026-07-16).** The orphan report (`GET /api/debug/orphaned-exercises/1`, run by the user — admin-secret-gated, not available to this session) found **27 real orphaned rows** across 5 dead workout ids (101, 102 — same-day leftover test artifacts; 17, 19, 20 — real historical workouts from 2026-04-15/16). Reviewed group-by-group before approving: nothing looked like a false positive, and one side-finding — workout 17's 8 exercises (Cat-Cow, Dead Bug, Glute Bridge, Clamshell, Wall Slide, Push-Up, Dead Hang, Goblet Squat) were each present in **exactly 2 copies** under that one `workout_id`, suggesting `/extract-exercises` was called twice historically against that workout — a separate, pre-existing duplication event unrelated to this session's bug, not chased. User approved the full delete; `POST /api/debug/delete-orphaned-exercises/1` with all 27 ids returned `{deleted:27, skipped:0}`. **Verified as a real correction, not just cleanup**: `GET /api/profiles/1/exercises/Dead%20Hang` dropped from 48 → 46 rows (exactly the predicted 2), and `GET /api/profiles/1/exercises/Bench%20Press` went to 0 rows (the orphaned test artifacts had no legitimate rows behind them). These orphaned rows had been silently inflating live exercise counts/PRs/analytics until this cleanup — **including falsely counting as `daily_habit` days in micro-goal tracking**, confirmed by reading `mgHabitDaySources()`: it queries `exercises?profile_id=eq.:pid` directly and unions any matching `date`, with no check that the row's `workout_id` still references a live `workouts` row, so an orphaned exercise row counted toward a habit streak exactly as if its (deleted) workout still existed. The same residual exposure exists via `DELETE /api/profiles/:id` (see ROADMAP.md §6) until that path gets the same fix.

## Current Primary User

Shimmy Castle - blue belt MMA, wedding musician, new dad. Injuries: pubic osteitis, right quad/IT band, concussion history, upper trap tightness, anterior pelvic tilt. Goals: mountain hike with baby, black belt, build muscle, fix posture, daily meditation.

## Important Rules

- Always use local date (not UTC) for date fields - use getFullYear/getMonth/getDate not toISOString()

- Workout dates stored as YYYY-MM-DD local time

- Cache Fitbit data in localStorage with ac_cache_date key for same-day caching

- All font sizes should be large and readable on desktop (body 17px min)

- Never hardcode Shimmy's data - everything renders from profile_data JSON

- After changes always commit and push to GitHub

## Wearable Support

- Fitbit: fully supported via OAuth2 API

- Manual check-in: supported (sleep/energy/pain emoji selectors → simplified readiness score capped at 85)

- **Google Health (API v4) — ✅ FULLY IMPLEMENTED (2026-05-26)**: the cloud REST API at `health.googleapis.com/v4/` — the direct **Fitbit Web API successor**. **NOT** the on-device Android Health Connect SDK (that has no cloud API; the old stub's "Path A companion app" design is **obsolete and was fully replaced**).
  - **Covers:** HRV (`averageHeartRateVariabilityMilliseconds`), RHR (`beatsPerMinute`), sleep stages (DEEP/REM/LIGHT/AWAKE via `:reconcile`), steps (`dailyRollUp` → `countSum`), AZM (three-zone sum), weight (`weightGrams`), and exercise activities (`fetchActivities` + `fetchActivityDetail` with HR samples).
  - **Auth:** Google OAuth 2.0; three `googlehealth.*.readonly` scope bundles; `access_type=offline`; 1-hour access tokens auto-refreshed by `getValidWearableToken`; refresh tokens expire after ~6 months of non-use. Callback `GET /callback/google_health` (+ `/api/wearables/callback/google_health` alias).
  - **Daily sync:** `GET /api/profiles/:id/daily` **prefers Google Health when connected**, using the local date; falls through to the Fitbit path when GH returns nothing (`hasData` gate over hrv/rhr/sleep/steps). An amber **reconsent banner** (`showGoogleHealthBanner()`, Profile tab + Settings → Account) prompts Fitbit users to migrate. **⚠ This preference applies to `/daily` ONLY** — `findWearableMatchOnSave()` is Fitbit-first, `life-os-summary`'s live fallback is Fitbit-only, and all backfill is Fitbit-only. See ROADMAP §5 for the full scope and the Sept-2026 consequence.
  - **Devices:** all Fitbit devices + Google Pixel Watch 1 / 2 / 3.
  - **User onboarding:** add each user's Gmail to **Test Users** in the Google Cloud Console (cap 100 users until the restricted-scope review is completed).
  - **September 2026:** the Fitbit Web API shuts down; Google Health is already preferred when connected, with Fitbit as the automatic fallback until then.
  - **Implementation:** `wearables/google_health.js` exports `buildAuthUrl` / `refreshToken` / `fetchActivities` / `fetchActivityDetail` / `fetchDailyData` / `getIdentity` / `normalize`. Env: `GOOGLE_HEALTH_CLIENT_ID` / `GOOGLE_HEALTH_CLIENT_SECRET`. Migration `2026-05-26_google_health.sql` adds `wearable_connections.provider_metadata` (jsonb; stores `{healthUserId, legacyUserId}` from `getIdentity`). See **"Google Health API — Key Implementation Notes"** below.

- **Open Wearables (Phase 2)**: Unified API for all wearables. Deploy on Railway ($5/mo). Android SDK ready now, iOS needs companion app. Long-term replacement for individual integrations. Supports: Samsung, Garmin, Whoop, Oura, Polar, Suunto, Apple Health (via iOS app).

- Samsung Health: available via Samsung Health Data SDK (Android only, Galaxy devices)

- Apple Watch / HealthKit: requires iOS companion app + Apple Developer Account ($99/yr). Use Open Wearables iOS SDK when ready.

- Garmin Connect API: public API, buildable without Open Wearables

- Whoop: API is invite-only, apply for access

profile_data.fitbit = true/false

profile_data.wearable = device name string or null (for future device routing)

## Settings Panel

Full-screen settings overlay accessible via gear icon or profile avatar click. Sections:

- Account & Security: display name, profile photo upload, change PIN, Fitbit status, export data, delete profile
- Appearance: 10 themes, font size (Normal/Large/XL), accent color override
- AI Coaching: tone (Motivational/Direct/Gentle/Scientific), detail level, num options, minimum viable toggle
- Training: equipment checkboxes, max duration, preferred workout time
- Data & Readiness: formula version, auto-sync, calendar default view

## Theme System

10 themes using CSS custom properties: apex (default), midnight, carbon, forest, crimson, arctic (light), sunset, monochrome, purple, gold. All colors use var() references. JS TC object mirrors CSS vars for dynamic HTML generation. Stored in `ac_settings.theme` (NOT `ac_theme`); applied via `applyTheme(name)` which swaps a `.theme-<name>` class on `<body>`.

## Design Token System (UI overhaul — in progress)

The 5-agent UI overhaul is **complete**: **Agent 1 (token foundation)**, **Agent 2 (Today tab)**, **Agent 3 (bottom nav + modals)**, **Agent 4 (History + Library tabs)**, and **Agent 5 (Profile tab + Settings content)** are all implemented. The new token system + Inter/Fraunces/JetBrains-Mono fonts + ember/cornerman/semantic palette now drive all four tabs, the nav, the modals, and the settings panel.

**Legacy systems intentionally retained (additive overhaul):** the legacy `--bg`/`--accent`/`--text` vars, the 10-theme `THEMES` object + `.theme-*` classes + `applyTheme()`, `BELTS`/`CAT_COLORS` data, and the shared `statCard()` helper were all kept — so a large amount of legacy hex still exists in those structures (and the hidden dev-roadmap), by design. The migration was done with **scoped, additive CSS** (tab-ID-prefixed selectors) + targeted inline-style migration in render output; no global shared class was redefined.

**Agent 5/5 — Profile tab + Settings** (scoped to `#tab-profile` / `#settings-overlay`; global `.card`/`.clabel`/`.mg-*`/`.navBtn`/`.theme-swatch` and the `THEMES`/`applyTheme()`/`statCard()` left intact):
- **Scoped CSS backbone**: `#tab-profile .card` → surface-1/border-subtle/radius-20; `.clabel` → muted section headers; `.mg-card` → surface-1/radius-16 (done = opacity .6); `.mg-pill`/`.mg-period-pill`/`.navBtn` → ember-active pills; inputs/selects → surface-2; ember checkboxes. Settings: `.settings-nav button.active` → ember, `.settings-section h3`/`.s-label` tokenized, inputs/selects surface-2, ember checkboxes, **`.theme-swatch.active` → 2px ember ring**.
- **Migrated render output**: profile header (64px avatar with 2px ember ring, Fraunces initial, 22/700 name); coaching brief (cornerman `--border-ai` + cornerman header); prominent action buttons (Sync Wearables, +Add challenge, goals Prioritize/Edit/refresh, roadmap Generate → ember; Open Settings → surface-2); My Templates (surface-2 rows, ember Use / muted Rename / danger Delete); Goals & Milestones cards (surface-1/radius-20, token priority circles #1 positive / #2 caution / #3 info, token status colors).
- **Scope note (honest):** the deeper *inner* content of a few heavy Profile renderers — the Analytics dashboard internals, Schedule day editor, Body weight-trend card body, Road Map phase rendering, the belt color strip, and micro-goal card internals — is **container-level migrated** (sits on the new surface cards / mg-cards via scoped CSS) but retains some legacy inline accent/text colors. These read fine on the new surfaces; a follow-up pass can tokenize the remaining inner styles. Chart.js init was never touched (only `.card` wrappers).

**Agent 4/5 — History + Library tabs** (scoped to `#tab-history` / `#tab-library` and their render functions; the global `.card`/`.navBtn`/`.clabel`/`.fc-pill` classes and the shared `statCard()` helper were NOT modified — scoped CSS uses tab-ID-prefixed selectors, and inline style values were migrated only inside these tabs' render output):
- **Scoped CSS backbone**: `#tab-history .card,#tab-library .card` → surface-1/border-subtle/radius-20; `.navBtn` (Week/Month + Dashboard/Exercises/Records sub-nav) → ember-active / surface-2 pills; `#history-query` focus = `--accent-cornerman` (AI feature), Library search focus = ember.
- **History**: calendar nav/day-headers/double-skip-warn migrated; `buildDayCell` (ember today border, ember selected bg, ember workout dot, positive/danger checks); `renderCalStats`/`renderCalBreakdown`/`renderCalDetail` token + Fraunces; "Ask Your History" card = cornerman accent + cornerman search button + purple-left-border answer; `setLogFilter` inline style values → ember pills; `renderLog` cards (surface-1, Fraunces-free type 15/600, info wearable pill, positive/danger Done/Skip, ember Edit / muted Re-log).
- **Library**: `renderLibDashboard` (Library-local `libStat` cell with Fraunces values — `statCard()` left alone since Today uses it; ember Fraunces top-exercise counts; surface-2 category bars; ember/caution maintenance buttons; Fraunces steps stats); `renderLibExercises` (surface-2 search, ember category/sub pills, surface-1 exercise rows); `renderLibRecords` (`prCard` = surface-2 + colored left border + Fraunces 28px value; caution/positive/info record accents); exercise detail (ember back, 22/700 headline, caution PR rows). Chart.js init untouched — only the `.card` wrappers (via scoped CSS).

**Agent 3/5 — bottom nav + modals** (scoped to nav + specific overlay IDs; the shared global `.overlay`/`.modal`/`.btnPri`/`.btnSec`/`.settings-overlay` classes were NOT modified — only `#`-scoped overrides + presentation markup; no JS handler changed):
- **Light-mode `--border-subtle` fix** — added `--border-subtle:rgba(0,0,0,0.08)` to the `[data-theme="light"]` block (the one allowed Agent-1 token fix, resolving the gap Agent 2 flagged).
- **Bottom nav (mobile-only)** — `--bg-surface-1` bar, `--border-subtle` top border, ~76px incl. safe-area; emoji icons replaced with inline Tabler-style outline SVGs (`currentColor`); active tab = `--accent-ember` icon+label inside a `rgba(255,74,28,0.1)` pill; center FAB = 52px ember circle with shadow, white `+` SVG, calls `openModal()`. Desktop top nav unchanged.
- **Log Workout modal (`#log-modal`)** — bottom sheet: `align-items:flex-end`, `--bg-surface-1`, top radius 20, slide-up via `@keyframes sheetUp` (plays on `display` change, so `openModal`/`closeModal` JS untouched; close is still instant — slide-down would need a JS hook). Drag handle + title + close ×; `--bg-surface-2` textarea/inputs with ember focus; pill quick-log shortcuts; ember accent checkboxes; full-width ember **Save Workout**. NOTE: the title stays a `.modal p.mono` element (restyled inline) because `openModal`/edit-mode set its text via `document.querySelector('.modal p.mono')`.
- **Wearable match modal (`#wm-modal`)** — centered, `@keyframes wmPop` scale-in, `--bg-surface-1`, centered activity-pulse icon + title, **stacked** buttons (ember "Yes, Link It" / surface-2 "No, Keep Separate").
- **Settings panel shell** — `--bg-base` background + slide-in-from-right (`@keyframes settingsSlideIn`), header title 22/700. Settings *content* left for Agent 5.

**Agent 2/5 — Today tab** (scoped entirely to Today card IDs + their JS render functions; the global `.card`/`.clabel`/`.fc-pill` shared classes were NOT modified — only `#`-scoped overrides + render-output styles):
- **Readiness card** — new hero: an 88px **SVG 270° ring** (`renderReadiness`, `rotate(135 44 44)`, gap at bottom; fill color by score ≥70 / 40–69 / <40 → positive/caution/danger), Fraunces score in the center, status + a 5px score bar, and a 2×2 **biometric grid** (HRV / Resting HR / Sleep / Steps) with Fraunces values + JetBrains Mono units. The existing detail sections (readiness bars, sleep score, sleep stages, zones, HRV) are **preserved** below.
- **AI rec cards** (`renderAI`) — option 1 = ember (`--accent-ember`) primary with white text/pills; options 2–3 = `--bg-surface-1` with `--border-subtle`, surface-2 category badge, purple (`--accent-cornerman`) "Supports" pills + green (`--color-positive`) goal pills; Minimum Viable = `--bg-surface-2`.
- **Cornerman (progress) card** — `#progress-card` gets the purple `--border-ai`; header relabeled **THE CORNERMAN** in `--accent-cornerman`; trend pill uses the semantic color tokens.
- **Body metrics, check-in, unmatched-Fitbit, recent/templates** — migrated to surface/ember/positive tokens; Fraunces on the weight value; check-in energy pills ember-when-selected, soreness pills surface-2-when-selected (scoped `#fc-energy`/`#fc-soreness`).
- **Known gap:** `--border-subtle` is a light-on-dark value (Agent 1 didn't add a `[data-theme="light"]` override for it), so the spec's "subtle card border in light mode" isn't visible until that token is overridden for light. Dark mode (the default; no light toggle exists yet) is unaffected.

- **Fonts** — added alongside the legacy stack: **Fraunces** (400/700, hero numerals only), **Inter** (400–700, all UI text), **JetBrains Mono** (400, telemetry numbers). `body` now uses Inter 16px / line-height 1.5.
- **Tokens** — new design tokens defined in `:root` (dark, default) with a `[data-theme="light"]` override on `<html>`: `--bg-base`, `--bg-surface-1`, `--bg-surface-2`, `--text-primary`, `--text-muted`, `--accent-ember`, `--accent-cornerman`, `--color-positive/caution/danger/info`, `--border-subtle`, `--border-ai`. Accent + semantic colors are shared across modes. ⚠ `--text-muted` is also a legacy var name; the 10-theme classes set it on `<body>`, so themed views keep their value (the new value applies in the default/unthemed state).
- **Utilities** — additive helper classes (not yet applied to existing markup): `.font-hero`, `.font-mono`, `.text-12/14/16/18/22`, `.text-muted/positive/caution/danger/ember/ai`, `.gap-4…32`, `.surface-1/2`, `.border-subtle/ai`.
- **Dark/Light color mode** — a NEW axis separate from the 10-theme selector. An isolated `<head>` script applies `data-theme="light"` from `localStorage.ac_theme` before render (no flash) and exposes `window.setColorMode('light'|'dark')`. The actual toggle button is **deferred to a later agent** (mechanism only for now). `body` background/text now read `--bg-base`/`--text-primary`, so the page canvas follows this color mode.

## Profile Data Fields

- profile_data.avatar_image — base64 JPEG string (200x200), displayed as circular photo
- profile_data.fitbit — true/false
- profile_data.wearable — device name string or null (Fitbit, Apple Watch, Garmin, Whoop, Samsung, Other)
- profile_data.profile_sections_completed — array of completed deep profile sections
- profile_data.onboarding_complete — boolean

## localStorage Keys

- ac_theme — dark/light color mode ('light' | 'dark') for the new design-token system (see Design Token System). NOTE: the legacy 10-theme name is stored in `ac_settings.theme`, not here.
- ac_compact — "true"/"false" for compact mode
- ac_settings — JSON with all settings:
  - fontSize, accentOverride — appearance
  - aiTone (Motivational/Direct/Gentle/Scientific), aiLang (Casual/Professional), aiDetail (Brief/Normal/Detailed), aiOptions (2-4), aiShowMV (always/low/never) — AI coaching
  - equipment[] (preset items), customEquipment[] (user-added items), workoutLocation (Home/Gym/Both), maxDuration (minutes or 0), preferredTime (Any/Morning/Afternoon/Evening), restDayPref (fixed/flexible) — training
- ac_data_prefs — JSON: autoSync (bool), showFitbitScore (bool), cacheDuration (day/none)
- ac_tracking_prefs — JSON: weeklyTarget (1-7), showMeditation (bool), showMobility (bool), calendarDefault (week/month)
- ac_profile_id, ac_profile_name, ac_profile_color, ac_profile_data — profile cache
- ac_cache, ac_cache_date — Fitbit/check-in data cache
- ac_checkin — daily feeling check-in (date + energy + soreness + severity + text), resets daily
- ac_schedule — weekly schedule
- ac_belt — current belt level

## Environment Variables (on Render)

FITBIT_CLIENT_ID, FITBIT_CLIENT_SECRET, GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET, SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_KEY, ADMIN_SECRET, LIFE_OS_API_KEY

`GOOGLE_HEALTH_CLIENT_ID` / `GOOGLE_HEALTH_CLIENT_SECRET` — OAuth 2.0 credentials for the Google Health API v4 adapter (`wearables/google_health.js`). Optional `RENDER_URL` overrides the OAuth redirect base for `/callback/google_health` (falls back to `https://apexcoach-backend.onrender.com`).

`LIFE_OS_API_KEY` — shared secret for the read-only Life OS integration endpoint (`GET /api/profiles/:id/life-os-summary`). The caller passes it as the `X-Life-OS-Key` header. The endpoint fails closed: if neither `LIFE_OS_API_KEY` nor `ADMIN_SECRET` is set it returns 503; `ADMIN_SECRET` (via `X-Admin-Secret` or `?secret=`) is also accepted for server-to-server calls.

**Local `ADMIN_SECRET` convention (2026-07-16): `.env.claude.txt`.** For agent sessions that need to call `/api/debug/*` endpoints against production directly (seeds, catalog curation, backfills), the value lives in a git-ignored `.env.claude.txt` in the repo root (`ADMIN_SECRET=<value>`, one line) — **never** pasted into chat/commit messages/code comments. `.gitignore` (added this session) excludes `.env.*` (with a `!.env.example` carve-out for any future template file) so this can never be accidentally staged. Read it fresh into a shell variable per command (`ADMIN_SECRET=$(grep '^ADMIN_SECRET=' .env.claude.txt | cut -d= -f2- | tr -d '\r\n')`) rather than exporting it once — shell state doesn't persist across separate tool calls in this environment anyway, and re-reading per-command means the value is never echoed into a reasoning trace or a saved shell history entry on its own.

## Goal Progress System

Smart goal progress tracking via `POST /api/profiles/:id/goal-progress`. Each goal type is calculated differently:

- **strength** — queries exercises for max weight matching goal keywords, auto-tracked
- **distance** — AI estimates readiness from cardio data, steps, and training patterns
- **consistency** — counts relevant workout types in last 30 days vs target
- **habit** — counts meditation days in last 30 days
- **skill** — maps current belt to position 1-13 out of 13
- **general** — AI estimates from recent workout patterns, or manual self-rating 0-100%

All goals have a manual override button (✏️) for updating progress directly. Results cached in localStorage for 6 hours (ac_goal_progress), invalidated after every workout save. Source icons: 🤖 AI estimate, ⚡ auto-tracked, ✋ manual.

## Goal Priority System

Goals can be ranked by priority via "Prioritize" button on Profile tab. Desktop: drag-to-reorder with ☰ handles. Mobile: up/down arrow buttons.

- **Array order = priority**: `profile_data.goals` array index 0 = #1 priority. Each goal also gets `goals[i].priority = i + 1` field.
- **Priority indicators**: Colored number circles on goal cards (#1 green, #2 amber, #3 blue, rest muted). Only shown when >1 goal.
- **AI integration**: `goalPriorityContext` injected into fetchAI() after FULL_PROFILE. Instructs AI to weight recommendations toward top goals (#1 ~40%, #2 ~25%, #3 ~15%).
- **Goal tags in AI response**: Each workout option includes `goal_tags` (array of goal titles targeted) and `goal_reasoning` (how it advances that goal). Rendered as amber pills below workout headline.
- **Save**: Reordered goals saved via PATCH /api/profiles/:id. Goal progress cache cleared on reorder.

## Focus Override System

Standing directive on `profile_data.focus_override` that reshapes daily AI recs independent of the normal goal-priority weighting, plus a per-day manual override on the AI rec card. Profile tab card `#focus-override-card`; all functions prefixed `fo`.

**Schema** (`profile_data.focus_override`): `{ active (bool), text, scope ('all' | array of goal ids), mode ('replace'|'boost'|'sprinkle'|'infuse'|'total'), start_date, end_date, daily_override_state (null|'forced'|'total'|'skipped') }`. `scope` only applies in `replace`/`boost` (scope selector hidden for sprinkle/infuse/total, which always save `scope:'all'`).

**Modes** — what each does to schedule + `goalPriorityContext`:
- `replace` — suppresses `goalPriorityContext` entirely (or just the in-scope goals if `scope` is an array); schedule (`buildScheduleInstruction()`) unaffected.
- `boost` — `goalPriorityContext` kept but compressed (~60-70% weight to the override, remainder split across ranked goals); schedule unaffected.
- `sprinkle` — schedule + goal weighting unchanged; asks for 1-2 non-anchored sessions this week to lean toward the override text.
- `infuse` — schedule/duration/frequency unchanged; asks to weave the override into whatever session is already planned (accessory work, technique emphasis, substitutions).
- `total` — suppresses `goalPriorityContext` like `replace` **and** skips `buildScheduleInstruction()`'s anchor-lock step entirely (Option 1 is not forced to match today's fixed commitment/weekly target) — recs are built purely from `focus_override.text`.

**Date range presets** (`foSetDatePreset(preset)`, 5 pills in the card next to the `fo-start-date`/`fo-end-date` inputs): all except `custom` set `start_date=today`; both fields stay freely editable after.
- `30d` — `end_date = today + 30` (rolling).
- `month` — `end_date` = last day of the current calendar month.
- `quarter` — `end_date` = last day of the current calendar quarter (Jan-Mar/Apr-Jun/Jul-Sep/Oct-Dec).
- `year` — `end_date` = Dec 31 of the current year.
- `custom` — no auto-fill; just focuses/opens the `fo-start-date` picker.

**Daily override flags** — `force` / `total` / `skip`, passed as `fetchAI({ dailyOverrideFlag })` from the AI rec card's "Focus fully today" / "Full override today" / "Skip focus today" buttons (shown only when the standing config is active + in date range). These are **per-call resolutions that do not mutate the stored config** (`resolveFocusOverride()` only touches its return value, not `profile_data.focus_override.mode/text/scope/dates`):
- `force` → resolves to `{forced:true, mode:'replace', scope:'all', text}` regardless of the standing mode.
- `total` → resolves to `{forced:true, mode:'total', scope:'all', text}` regardless of the standing mode (same non-mutating shape as `force`, but flows through to the schedule anchor-skip).
- `skip` → `resolveFocusOverride()` returns `null` (override off for this call).
- The chosen flag's outcome (`'forced'`/`'total'`/`'skipped'`) is stamped onto the cached rec (`daily_override_state`) and mirrored to `profile_data.focus_override.daily_override_state` (PATCH) so the card shows the right pill ("Today: Full Focus" / "Today: Full Override" / "Today: Focus Off") across reloads until "Reset to normal" (`resetFocusOverrideDaily()`) clears it. `foSave()`/`foToggleActive()` also clear it since a config edit invalidates any earlier per-day decision.

**Prompt injection** — `resolveFocusOverride(dailyOverrideFlag)` is the single source of truth for "is the override on for this call, and what mode/text/scope" (used by both the `goalPriorityContext` suppression logic and the schedule call in `fetchAI()`). `buildFocusOverrideContext(dailyOverrideFlag)` builds the actual `FOCUS OVERRIDE` prompt block from that resolution. Build order in `fetchAI()`'s user message: `buildScheduleInstruction()` (passed `{totalOverride: text}` when mode is `total`, `{categoryOverride}` when a category pill is active) → `buildFocusOverrideContext()` → biometrics/check-in/weekly-volume/log → ... → `goalPriorityContext` → `microGoalsContext`. `buildFocusOverrideContext()` never mutates `buildScheduleInstruction()`'s output — the `total`-mode schedule suppression is a separate early-return branch in `buildScheduleInstruction()` gated on `opts.totalOverride`.

## Athlete Timezone (`localToday()`) — 2026-07-15

Fixes a recurring bug **class**, not a one-off: server-side "today" had always been computed from the server's own clock/OS timezone, never the athlete's. `dateStr()` uses `.toISOString()` (always UTC). `ymdLocal()` and several inline `getFullYear/getMonth/getDate` IIFEs (the Google Health daily-sync date, the week-preview builder) use the Node **process's own OS timezone** — which on Render is UTC too, so in practice both of this file's existing "local" helpers have always meant UTC. The Google Health fix from an earlier session (the `ghDate` IIFE, comment claiming it "matches the app's local time") was the same bug wearing a disguise — it fixed the `.toISOString()` symptom without fixing the actual mismatch, since "local" there meant the server's OS, not the athlete's browser. Confirmed repro: at ~7pm+ America/Chicago, the server (UTC) has already rolled to the next calendar day — Coach Chat described a same-day workout as "yesterday's," and its today-fallback (see "Same-day workout visibility" below) found nothing.

**Schema**: `profiles.timezone` (text, IANA identifier like `America/Chicago`, nullable, no default — migration `migrations/2026-07-15_profile_timezone.sql`, run manually). Added to `PROFILE_SELECT_BASE` and echoed back on `GET /api/profiles/:id`, `POST /api/profiles/verify`, and `PATCH /api/profiles/:id`'s response — `PATCH` now also *accepts* a `timezone` field like any other top-level column.

**`localToday(profile, offsetDays)`** (`server.js`, near `dateStr()`) — the **one** athlete-timezone-aware date helper. Returns `YYYY-MM-DD` for the athlete's calendar day using `Intl.DateTimeFormat("en-CA", {timeZone: profile.timezone})` (built into Node, no npm dependency; `en-CA` formats as ISO `YYYY-MM-DD` directly) — falls back to UTC when `profile.timezone` is null/unset, so **every existing profile behaves exactly as before until the client captures a real value**. `offsetDays` (optional, default 0) shifts by whole calendar days via a UTC-noon-anchored `Date`, covering "today" / "yesterday" / "N days ago" with one function. `dateStr()`/`ymdLocal()` are unchanged and remain correct for non-athlete-specific things — OAuth token expiry, audit timestamps, the legacy single-tenant `/api/daily` endpoint (predates the profile/timezone concept entirely, deliberately left untouched). `getProfileTimezone(profileId)` is a minimal `select=id,timezone` fetch for callers that only need the timezone, not a full profile row.

**Client capture — silent, no UI.** `captureTimezoneIfNeeded()` (`public/index.html`, called from `bootApp()`, the one function every login/boot-from-cache/onboarding path converges on) reads `Intl.DateTimeFormat().resolvedOptions().timeZone`, compares it to a fresh `GET /api/profiles/:id`, and `PATCH`es only when different — a no-op on every boot after the first per device. Self-contained (its own tiny fetch) rather than threading a variable through every entry path, since those diverge (PIN verify vs. boot-from-`localStorage`-cache vs. post-onboarding) but all call `bootApp()`.

**Converted sites** (the "means the athlete's calendar day" call sites, audited before any code was written):
1. `buildChatSnapshot()` — the reported bug. `today` now computed *after* the profile fetch (was before it), since it depends on `profile.timezone`. The snapshot also now always includes a `TODAY: <date>` line (previously a date only appeared conditionally, via `TODAY'S READINESS`) — see the persona fix below, which depends on this line existing.
2. `buildRecentExerciseLog()` — the chat "last 7 days" window; now takes a `profile` param (passed by `buildChatSnapshot`, which already has it loaded — no extra fetch).
3. `buildTodayWorkoutFallback()` — inherits the fix automatically via `buildChatSnapshot`'s `today`.
4. `computeFocusOverrideProposal()` — default `start_date`/`end_date` for a new standing directive; `timezone` added to its existing `profile_data` select.
5. `computeCheckinNoteProposal()` — which `daily_checkins` row a chat-proposed note reads; a **bug introduced in the previous Coach Chat tool-use session**, not a pre-existing one. Stores the resolved date as `payload._today`.
6. `applyProposal()`'s checkin write — reuses `payload._today` from #5 rather than recomputing, so a read-then-write always targets the same date key even in the unlikely case a confirm lands right at a midnight boundary.
7. The Google Health `ghDate` IIFE in `GET /api/profiles/:id/daily` — replaced with `localToday(profileTz)`.
8. `buildDailyData(token, overrideDate, timezone)` — new third param for its internal `today`/`yesterday`/`weekAgo`, threaded through its 2 profile-scoped callers (`GET /api/profiles/:id/daily`, `life-os-summary`'s live-Fitbit fallback). The **legacy single-tenant `/api/daily`** call site is deliberately left calling `buildDailyData(token)` with no timezone — it predates profiles/timezone entirely and has no profile to look one up for; the 3-arg fallback already defaults it to UTC. `life-os-summary`'s own `today` (used for its DB-first `daily_sleep`/workouts reads) was converted too, beyond the letter of "3 call sites," for internal consistency within that one endpoint — noted here rather than silently expanding scope.
9. `POST /api/profiles/:id/week-preview` — determines which **weekday** is "today" for the whole rolling 7-Day Schedule Preview's anchor matching. The profile fetch (already happening for `profile_data`) was pulled out of the `Promise.all` batch and sequenced first, since `sinceStr`/`today` now depend on it — one extra round-trip, accepted given this endpoint is client-cached (`localStorage.ac_schedule_preview`) and not in a tight per-message loop.
10. `POST /api/workouts`'s future-date rejection — real bug for **positive**-UTC-offset athletes specifically (e.g. Sydney): in their morning, if the server (UTC) is still on the prior day, a legitimately same-day log gets wrongly rejected as "future." The Chicago repro doesn't hit this exact failure mode (same root cause, different symptom). Only fetches the profile's timezone when `body.date` is actually present (matching the existing validation gate).
11. `currentStreakFromDates(dateSet, profile)` (2026-07-15 session #6) — the analytics current-streak calc; was the original `#1` deferred item, fixed in a follow-up session. Now anchors "today" via `localToday(profile, offset)` in a loop (mirroring the original's mutate-and-decrement pattern, but with `offset` instead of a mutated `Date`) instead of `ymdLocal(new Date())`. `GET /api/analytics/activity-stats/:userId` — previously fetched no profile row at all — now fetches one (`getProfileTimezone()`, reused, no new helper) alongside its existing workouts query. `longestStreakFromDates()` and both most-active-day-of-week bucketers (`activity-stats` + `/exercises/stats`) were audited and left untouched — see the note directly below.
12. `/exercises/stats`' weekly-volume "last 12 weeks" cutoff (2026-07-15 session #6) — was the other half of the original `#1` deferred item. `var now = new Date()` (real wall-clock, driving the `weekAgo < 12` gate) replaced with `new Date(localToday(profile, 0) + "T12:00:00")` — noon-anchored like the exercise-date parse it's compared against, so the cutoff can't drift a day off from a server-vs-athlete mismatch (and, as a side effect, is no longer jittered by what time-of-day "now" happened to be, since a date string has no time component). Its week-bucket key also switched from `weekStart.toISOString().slice(0,10)` (UTC) to `ymdLocal(weekStart)` (local components) for consistency with how `weekStart` itself is built via local `setDate()`/`getDay()` mutation — harmless before only because Render's OS timezone happens to be UTC. This endpoint also previously fetched no profile row; now does.

**Audited and left as class-(b), NOT converted** (self-consistent noon-anchored parsing of already-known stored date strings — no dependency on "now" at all, confirmed by tracing the parse/read round-trip rather than assumed): `longestStreakFromDates()` (pure day-gap arithmetic between date strings); the most-active-day-of-week bucketing in both `activity-stats` and `/exercises/stats` (`new Date(w.date + "T12:00:00").getDay()` — encode and decode both happen in the same server-local TZ, so the round-trip is lossless regardless of what TZ the server happens to run in); `activity-stats`' previous-comparison-window boundary math (pure date-string arithmetic on caller-supplied `start_date`/`end_date` — there's no "today" default anywhere in that endpoint, an empty date range means all-time, not last-N-days-from-today).

**Still deliberately deferred** (found during the original audit, same bug class, lower severity or higher cost to fix — confirmed with the user, unchanged since): roadmap phase date assignment (`assignNearTermDates`) and the `getGoalExerciseContext`/`getFullExerciseContext` 60-90 day rolling windows — a 1-day skew is invisible at multi-week/90-day granularity; `life-os-summary`'s own date-param override behavior for its external caller — already has its own `?date=` override, different consumer/conventions; `POST /api/profiles/:id/daily-recs`'s `fallbackDate` — the primary path is already client-supplied (athlete-local via the browser's `ds(0)`), this only matters if the client omits `date` entirely.

**Verified with a mocked clock (2026-07-15 session #6), not just syntax-checked.** Booted the actual pre-fix `server.js` (extracted via `git show HEAD:server.js` at the commit before this fix) and the actual post-fix `server.js`, both against the same mock Supabase, both with `Date` globally mocked to the same fixed instant *before* `require()` (so real shipped code ran, not a copy) — for a `timezone:null` profile, `activity-stats`' and `/exercises/stats`' full JSON responses are **byte-identical** pre- vs. post-fix (the regression check: unaffected until a profile captures a real timezone). For a real positive-UTC-offset (`Australia/Sydney`) profile with a workout logged on each of 3 consecutive real local days (the most recent one being the athlete's actual "today," while the server's UTC clock was still on the previous day) — the pre-fix server returns `current_streak:2`, the post-fix server returns the correct `3`, matching `longest_streak`. This is direct proof of the bug: the old code's "not found in dateSet → check yesterday" fallback recovers correctly for a negative-UTC-offset athlete (server ahead) by coincidence, but goes the wrong direction for a positive-UTC-offset athlete (server behind) and skips 2 real days instead of 1.

**Left as UTC — correct as-is, not date-keys.** Every `new Date().toISOString()` stamping `created_at`/`updated_at`/`resolved_at`/`generated_at`/`last_synced_at`/token `expires_at` — these are timestamps ("when did this happen"), not date-keys ("which calendar day"). Converting these would be actively wrong.

**Persona fix** — `CHAT_SYSTEM_PERSONA`'s "WHAT YOU KNOW" paragraph now explicitly names the snapshot's `TODAY:` line as the *only* source of "today," instructing the model to never assert, compute, or guess a date itself. This only works because the snapshot now *always* states one (see site #1 above) — before, "use the snapshot's date" would have had nothing to point to on a day with no daily rec generated yet.

**Verification** (mocked-clock, not just syntax-checked): `localToday()` extracted verbatim and tested against a mocked `Date` at the exact reported instant (7:30pm CDT / 00:30 UTC next day) — confirms `America/Chicago` → correct prior-day date while `UTC` → the wrong next-day date at that same instant, proving the mismatch is real and the fix resolves it. Same technique for the Sydney-morning case (8am AEST / 22:00 UTC prior day). Then the **real server process** was booted with its `Date` globally mocked to each instant (mocking before `require("./server.js")` so every `new Date()` inside the actual server code, not a copy, uses the fixed clock) against a matching mock Supabase: the Chicago scenario proved a same-day evening workout appears correctly under `TODAY: 2026-07-15` in a real `?debug=1` chat snapshot; the Sydney scenario proved a real `POST /api/workouts` call with the correct local date succeeds (previously would 400) while a genuinely future date is still correctly rejected; a third run with `timezone: null` proved `GET /api/profiles/:id/daily`'s resolved date is byte-identical to the pre-fix UTC value at the same mocked instant — the regression check.

## Coach Chat

Persistent, one-thread-per-profile conversational surface for discussing/tweaking workouts, goals, routines, schedule, and biometrics — distinct from the structured daily-rec cards and the one-shot "Ask Your History" search. Reachable via a 💬 icon-only button in the top header (`.chatHeaderBtn`, cornerman-purple bordered, next to the profile-avatar/settings button group, visible on all tabs) calling `openChatView()`, which opens `#chat-view` — a body-level sibling of `#settings-overlay` (NOT nested inside a `.tab`, so it stays reachable regardless of which tab is active — unlike `#goal-roadmap-view`, which is nested in `#tab-profile` and only works while that tab is active). **The original Today-tab "Talk to your coach" button under the AI rec card was removed** (2026-07-15) once the header button shipped — it was a pure duplicate of the same destination with no contextual difference, and kept it off the Today tab matches the existing "Today tab declutter" roadmap direction (see §7 Next up in ROADMAP.md).

**Responsive layout**: `#chat-view` is a **fullscreen takeover on mobile** (`position:fixed;inset:0`, unchanged) and a **docked bottom-right panel on desktop** (`@media(min-width:769px)`: 400px wide × 66vh tall, capped at 720px, anchored `right:24px;bottom:0`, rounded top corners only, drop shadow — the same breakpoint the app's mobile-bottom-nav/desktop-top-nav split already uses, not the separate 700px breakpoint used elsewhere for minor padding tweaks). Same DOM, same JS — the media query only repositions/resizes the container; `openChatView()`/`closeChatView()`/`sendChatMessage()` have no viewport-conditional logic.

**Why server-driven, unlike daily_recs.** The daily-rec prompt is assembled **client-side** in `public/index.html` from browser state already loaded by page-load fetches (`buildScheduleInstruction()`, `buildWeeklyVolumeSummary()`, etc. — all zero-argument functions reading module globals like `currentSchedule`/`workoutLog`). Coach Chat has no such state to draw on server-side, so `server.js` rebuilds a compact athlete snapshot from Supabase on **every** send (`buildChatSnapshot()`) rather than trying to reuse those client functions — mirroring the pattern `getFullExerciseContext()`/`getGoalExerciseContext()` already use (independent Supabase fetch → compact aggregate text for the prompt), not a duplicate of the client prompt builders' scheduling-enforcement logic.

**Schema** (Supabase; migration `migrations/2026-07-15_chat.sql`, run manually — not applied automatically):
- `chat_threads` — `id`, `profile_id` (FK, UNIQUE — one thread per profile), `summary` (text, nullable), `summary_through_message_id` (bigint, nullable), `created_at`, `updated_at`. RLS enabled with a `service_role_bypass` policy, matching the other 11 tables.
- `chat_messages` — `id`, `thread_id` (FK), `role` (`user`|`assistant`), `content` (text), `created_at`. Full history is kept forever; summarization never deletes rows, it only changes what's sent to the model on future calls.

**Model routing**: `coach_chat` → `MODEL_SONNET`, `chat_summarize` → `MODEL_HAIKU`, both added to `CALL_TYPE_MODEL`. `chat_summarize` is called directly via `callAISystem()` (same pattern as `goal_roadmap_adapt`/`macro_roadmap_adapt`), not through `modelForCallType()`; `coach_chat` IS resolved through `modelForCallType("coach_chat")` inside the send handler, exercising the same single-source-of-truth mapping the `/api/ai` proxy uses — swapping in a Haiku pre-classifier later (or any other model change) is a one-line edit to `CALL_TYPE_MODEL`, not a new routing mechanism.

**Streaming**: reuses `pipeAnthropicStream()` (the same helper `daily_recs` uses to survive Render's idle-connection window), now generalized with a `label` param (for clearer logs) and a return value — the function accumulates and returns the full response text so the caller can persist it as the assistant's `chat_messages` row after the stream ends. `POST /api/profiles/:id/chat/message` builds its own request to Anthropic (system + messages assembled server-side) rather than routing through the client-facing `/api/ai` proxy, since the proxy expects the client to already have built system+user content — chat's snapshot is server-assembled instead.

**Prompt structure (cache-friendly)**: the **system** block is `CHAT_SYSTEM_PERSONA + ATHLETE SNAPSHOT (+ EARLIER-CONVERSATION SUMMARY if one exists)` — everything in it is stable across a session except when the snapshot's underlying data or the rolling summary changes, so it benefits from Anthropic prompt caching (wrapped via `wrapSystemWithCache()`, 1h TTL like daily_recs). Thread history (raw messages since the last summarization cutoff) goes in the **messages** array, which is expected to grow every turn and is deliberately kept out of the cached system block. No per-request-varying data (timestamps, etc.) is embedded in the system string — the only "freshness" signal is the athlete snapshot itself, rebuilt fresh each call but text-identical between calls unless the athlete's underlying data actually changed.

**Char guard — `CHAT_CHAR_GUARD = 20000`** (system + messages combined), with the snapshot built toward a **soft** `CHAT_SNAPSHOT_CHAR_CAP = 5000` and a **hard** `CHAT_SNAPSHOT_HARD_CAP = 8000`. Unlike daily_recs' 6000-char guard (sized to keep a **non-streamed** Sonnet call under Render's ~25s window), chat streams, so this cap isn't racing a timeout — it's a deliberate prompt-size/cost ceiling, tunable in `server.js`. `enforceChatCharGuard()` trims **oldest-first** on the *messages* array only: it never touches the snapshot (already capped during construction) and drops complete `(user, assistant)` turn-pairs from the front of thread history until under budget, preserving the Anthropic Messages API's required strict role alternation and always keeping at least the newest (just-sent) message.

**Snapshot cap discipline (fixed 2026-07-15 — see "Athlete snapshot contents" below for what broke).** Goals/challenges/focus-override/schedule/biometrics are **never** truncated to hit the soft cap — only the elastic sections (recent-exercise log, then profile context) are trimmed for that, and if content still exceeds the soft cap after trimming those, `buildChatSnapshot()` logs a warning and lets it through rather than cutting anything else. Only past the **hard** cap does it actually drop content: profile context shrinks further, then (last resort) lowest-priority goals are popped one at a time from the tail of the priority-ordered list — each drop is `console.warn`'d by name. This should never fire for a realistic goal/challenge count; a 300-goal stress test was the only way to trigger it during testing.

**Debugging the snapshot — `?debug=1`.** Pass `?debug=1` on `POST /api/profiles/:id/chat/message` (same body) to get back the assembled `{snapshot, system, messages, snapshot_chars, system_chars, messages_chars, combined_chars, char_guard, trimmed_history}` as JSON **instead of** calling Anthropic — no API cost, no message persisted. `buildChatSnapshot()` also always logs a compact one-liner (`[Chat] snapshot for profile N: X chars, Y goals, Z challenges...`) on every real call, and does a full `console.log` dump of the snapshot when `opts.debug` is set. This is a **permanent capability**, not a one-off — kept specifically because snapshot-completeness bugs (like the goals/focus-override gaps below) are expected to recur as new context sources get added.

**Summarization — fire-and-forget, not inline.** Once a thread has more than `CHAT_SUMMARIZE_TRIGGER = 24` messages since the last summary cutoff, `summarizeChatThreadIfNeeded()` folds everything older than the most recent `CHAT_SUMMARIZE_KEEP_TAIL = 20` messages into `chat_threads.summary` via Haiku (merging with any existing summary, not just appending) and advances `summary_through_message_id`. This runs **after** the response has finished streaming, called without `await` (`.catch()`-guarded, matching the `maybeAdaptAllRoadmaps()` fire-and-forget pattern) — a send is never slowed down by summarization. If a new send arrives before summarization lands, `enforceChatCharGuard()`'s oldest-first trim is the stopgap.

**Athlete snapshot contents** (`buildChatSnapshot()`): athlete name + `ai_prompt_context` (trimmed 600 chars, 200 as a hard-cap last resort), **ALL** long-term goals in priority order (`formatGoalLineForChat()` — one condensed line each: title, type, and the goal's own stored `target_value`/`current_value`/`unit`/`status`, NOT a freshly AI-computed progress % — that's what `POST /goal-progress` does, and recomputing it per chat message would mean an extra AI call on every send), **ALL** active micro-goals condensed one-per-line (`formatChallengeLineForChat()`, Supabase query limit raised 10→50 as a generous ceiling, not a real cap), the **standing Focus Override directive** if currently active (`summarizeFocusOverrideForChat()` — mirrors `resolveFocusOverride()`'s standing-directive branch from `public/index.html`; the daily per-call `force`/`total`/`skip` flags are daily-recs-card-only and don't apply here), a one-line schedule summary (`formatScheduleForChat()` — a compact read of the v2 schedule shape, NOT a reimplementation of `buildScheduleInstruction()`'s anchor-lock/variety-analysis rules, which are client-only and daily_recs-specific), today's cached readiness score (if generated today), latest **cached** biometrics — HRV/RHR/sleep from `daily_sleep`, steps from `daily_steps`, weight/BMI from `body_metrics` (DB-first, no live Fitbit/Google Health call, same philosophy as the `life-os-summary` fast path — chat never blocks on or breaks from a wearable-API outage), a **30-day sleep history block** (see below, 2026-07-17), and a condensed 7-day exercise log (`buildRecentExerciseLog()`, the same `DATE: EXERCISE (SETS x REPS @ WEIGHT)` one-line format the June daily-recs prompt-trim landed on). **Known gap:** zone/active-minutes aren't persisted anywhere in the schema (only held transiently in the `/daily` response), so they're omitted from the snapshot rather than adding a live wearable call per chat message.

**Sleep history block (2026-07-17) — the model can now trend-analyze sleep, not just see last night.** Before this, the only sleep data in the snapshot was the single-row "LATEST BIOMETRICS" line (still there, unchanged) — asked to analyze a month of sleep, the model correctly (and unhelpfully) said it only had one data point. Fixed additively, no other snapshot field touched: a second, separate `daily_sleep` query (`date >= today-30`, `order=date.asc`, distinct from the existing single-row `sleepPromise`) feeds a `SLEEP HISTORY (30d, ...)` block — one compact line per day (`YYYY-MM-DD Xh sYY dZZZm rWWWm`, hours/score/deep-min/rem-min, any null field omitted from that day's line). **Days with no `daily_sleep` row at all are never fabricated as zero** — they're just absent from the block, and the block's own header states this explicitly ("a date not listed = wearable-sync gap, not zero sleep") so the model doesn't misread a sync gap as a bad-sleep night. Lives in `coreLines` (the never-soft-cap-trimmed tier, same as the other biometric lines) — sized to stay well under budget by construction: ~1040 chars for a fully-populated 30-day window (measured), so it doesn't meaningfully compete with the elastic exercise-log/profile-context budget in practice. One PostgREST query, non-fatal — a fetch failure resolves to `[]` (same pattern as every other snapshot sub-fetch) and logs one `console.warn` line; the block is simply omitted and the message still sends. **Cache-invalidation impact confirmed, not assumed** (Known Limitation §6 item 5 in ROADMAP.md): `daily_sleep` only changes via the nightly wearable sync (or the `life-os-summary` fallback upsert), so this block is stable *within* a chat session exactly like the pre-existing single-row biometrics line already was — it doesn't introduce a new source of per-message cache-busting beyond what the existing "whole-block invalidates on any snapshot change" architecture already tolerates from other fields (exercise log, goal edits, etc.); it does make the cached block modestly larger, which raises the cost of a miss when the cache invalidates for an unrelated reason, but that's a different concern from invalidation *frequency*. **Verified live** (profile 1, production): `?debug=1` echoed the block with 6 real days of data (a genuine ~24-day wearable-sync gap between them, correctly un-fabricated) at 3637 total snapshot chars; a real Coach Chat message ("analyze my sleep over the past month") produced a trend analysis correctly citing the exact dates/hours/scores/deep-REM minutes from the block, correctly explained the gap as a sync issue rather than zero sleep, and cross-referenced today's cached readiness score to build a real causal read (short sleep → lower readiness) — not a templated response.

**Bugs fixed 2026-07-15 (real-world test: chat only saw ~4-5 goals, and nothing from Focus Override):**
1. **Goals were hardcoded to `goals.slice(0, 5)`**, unconditionally — independent of the char budget, so any goal outside the top 5 by priority was silently dropped every time regardless of how much room was left. This, not the char cap, was the actual bug. Fixed by removing the slice entirely and condensing the per-goal format so all goals normally fit.
2. **Focus Override was never read.** `profile_data.focus_override` is persisted server-side (same `profile_data` column fetch as goals/schedule — `PROFILE_SELECT_BASE` already selects it in full) and was sitting in memory unused; not a client-only-state architecture gap as initially suspected, just an omission in the assembler. Fixed by `summarizeFocusOverrideForChat()`.
3. **The soft-cap's final `snapshot.slice(0, CHAT_SNAPSHOT_CHAR_CAP)` was an unconditional hard string cut with no logging** — if core content (goals/challenges/schedule/biometrics) alone ever exceeded the cap, it would've been silently guillotined mid-line. Fixed by the soft/hard cap split above; every truncation event is now logged.

**Retry discipline**: the send endpoint has no automatic backend retry on the Anthropic call itself (it's a generation call, not idempotent to blindly retry) — pre-stream upstream errors are returned as JSON with status preserved, matching `/api/ai`'s pattern. Retry lives entirely on the frontend, scoped per-message.

## daily_recs Timeout — Root Cause + SSE Streaming Fix (2026-07-18, session #29)

**Resolves the long-open "streaming termination investigation (2026-07-15)" below** — which added observability + speculative mitigations but never found the root cause, and *couldn't reproduce it locally because the cause is Render-proxy-side, not in the code*.

**Reported symptom:** profile 1's daily AI rec failed — "Analyzing your data" → "Unable to load recommendation. Request timed out (90s)."

**Root cause — NOT the model string.** `MODEL_SONNET = "claude-sonnet-4-6"` is a valid, active model (verified against the Anthropic catalog + live: a Sonnet `daily_recs` call returns fine). A retired/invalid ID returns a fast **404** (surfaced to the client in ~1s at `server.js` `if (!response.ok)`), never a 90s hang — so the symptom shape ruled the model out from the start. The actual cause, proven live: **Render buffers the `daily_recs` `text/plain` "stream" and delivers it in one burst at completion** (measured **time-to-first-byte == total time == 45s**; 6 TCP chunks all at the same timestamp). The client therefore receives no incremental bytes, so its 45s idle timer (`fetchAI`, `public/index.html`) counts full generation time from the start — a de-facto 45s total cap. The **2200-token output** generation on Sonnet 4.6 (~40–45s end-to-end; the input is small — `fetchAI` caps the prompt at ~6KB) sits right at/over that line, so every attempt aborts; 3 auto-retries → `aiPermanentlyFailed` → the "Unable to load" card. The abort message was **hardcoded** `"Request timed out (90s)"` for any `AbortError`, so the 45s idle abort was mislabeled "90s". **Not** caused by anything in sessions #25–27: `resolve-batch` (session #27, Job 2) is a client-side call fired from `ensureAIExerciseLinks` *after* `renderAI` paints, and `renderAI` only runs on a *successful* rec — so it's never reached when recs fail. The server itself succeeds every time (returns the full valid rec); the client just gave up before receiving it.

**Fix 1 — minimal (shipped first, `public/index.html` `fetchAI`).** `IDLE_MS` 45s→120s, `MAX_MS` 90s→150s (sized for real end-to-end generation, since the streaming keepalive was non-functional under buffering); abort message now reports **real elapsed seconds** instead of the hardcoded "(90s)". This alone unblocks — the server returns a valid rec in ~45s, now comfortably inside the window.

**Fix 2 — SSE (shipped + live-verified as the real fix).** Switched the `daily_recs` response from `text/plain` to proper **SSE (`text/event-stream`)**, scoped to that path only (coach_chat's `pipeAnthropicToolStream` still uses `text/plain`, unchanged). Threaded an `sse` flag through the shared helpers: `startAnthropicStreamResponse` (content-type + a `": ok"` primer frame), `pumpAnthropicLeg` (text deltas framed as `data: <JSON.stringify(text)>\n\n` via a new `sseFrame()` — JSON-encoded so embedded newlines can't break SSE framing), `finalizeAnthropicStream` (`data: [DONE]`). `pipeAnthropicStream` passes `sse=true`. Client (`fetchAI`) detects `content-type: text/event-stream` and parses SSE frames (JSON-decode each `data:` payload, concat), else falls back to raw concat (backward-compatible with the old server). **Verified live, same method that proved the buffering: TTFB 45.1s → 1.4s, 93 chunks spread evenly across 38s** (was 6 chunks all at the end) — buffering defeated. Client reassembly yields valid 3-option rec JSON (110 frames, 0 malformed). With real streaming, the client's idle timer resets on every chunk, so it can no longer time out while tokens flow, regardless of total generation time.

**Incremental loading UI** — `updateRecLoadingProgress()` (new) surfaces the streaming `brief` field live (regex-extracts it from the partial JSON, `textContent` for XSS-safety, builds its wrapper once so the pulse animation doesn't restart per chunk), so the loading state shows real progress ("GENERATING RECOMMENDATION…" + the brief typing out) instead of a frozen spinner.

**Second root cause — `max_tokens` truncation (found right after SSE shipped).** With the timeout gone, profile 1's rec finally *arrived* — and revealed a pre-existing latent bug SSE had been masking: verbose recs exceed the client's `max_tokens: 2200` (`index.html`), so Anthropic cuts the JSON off mid-object → `extractRecJSON` returns null → "could not extract rec JSON" → 3 (pointless, identical) retries → `aiPermanentlyFailed`. **Confirmed it is NOT an SSE reassembly bug**: reproduced with the real client `fetch().getReader()` + verbatim `extractRecJSON` — a concise rec parses fine, a verbose one truncates cleanly at the token boundary (mid-sentence, no closing braces); the reassembly is faithful and fences are stripped (line 4228, same path the old text/plain used). Two fixes:
- **`max_tokens` 2200 → 4000** (`index.html`, the `daily_recs` fetch). Immediate unblock; SSE makes the longer generation safe from timeout (verified a 3665-token rec completes + parses in 83.6s, under the 150s cap).
- **Conciseness + uniformity constraints in `buildResponseShapeSpec()`** — 4–6 exercises/option, one short line each (no multi-clause parenthetical coaching essays), spelled-out canonical names ("Dumbbell Bench Press" not "DB Bench Press"), tight `reasoning`/`goal_reasoning`. **Measured live after tuning: output ~811 tokens / 2838 chars (was ~2300–3665, truncating), generation 17.4s (was 45–83s), parses cleanly, 3 options with 6/5/5 exercises.** Output is now far under the ceiling, so `max_tokens` could safely drop to ~3000 as a guardrail — but it's a ceiling, not a target (the model stops at `end_turn` ~811 tokens), so 4000 costs nothing in latency; kept as headroom for 4-option + minimum-viable configs.
- **AI-rec link match rate (the session #27 Job-2 linking) after tuning:** cleaner/uniform lines strip better, but the rate stays content-dependent — 5/16 (31%) on a yoga/MMA-heavy test day, **0 wrong links**. Conciseness removed *verbosity* as a miss cause; residual misses are qualifier variants ("Weighted Pull-Up", "Single-Arm Dumbbell Row") and genuinely uncatalogued yoga/MMA moves, not fixable by prompt tuning (would need catalog expansion or the fuzzy tier, which Job 2 deliberately rejected). A clean strength day still scores like the Job-2 80% strength probe. **Bounded by catalog coverage, not verbosity — tracked as an open follow-up in ROADMAP §7.**
- **Retry-on-truncation hardening: deliberately skipped** (moot once output fits under the ceiling).

**Backlog (ROADMAP §9):** prompt/generation-size management is now largely addressed by the conciseness pass; the residual note is smarter *input* context selection as logged history grows (the 6KB input cap increasingly truncates real context). **Not done this session:** model migration (Sonnet 5) was explicitly out of scope — a separate deliberate decision, not a timeout fix.

**Streaming termination investigation (2026-07-15) — `pipeAnthropicStream()` reliability. ⟶ ROOT-CAUSED + FIXED in session #29 above (Render-proxy response buffering; the SSE switch defeats it).** A production incident: three consecutive `daily_recs` requests each logged `Anthropic response status=200 (streaming)` → `usage (stream)` → `stream complete, wroteAny=true` server-side, while the client never received the reassembled text and hit its 90s hard-cap abort each time (not the 45s idle timeout — chunks were resetting the client's idle timer, so the connection stayed active, but true termination never arrived).
- **Diff finding: not a code regression.** `pipeAnthropicStream()` and the `/api/ai` handler were diffed against the pre-Coach-Chat version — the only changes across the whole Coach Chat effort are the `label` param and the `fullText` accumulator (returned to the caller, never affects `res.write()`/`res.end()` timing). `res.end()` was, and still is, unconditional on every path (success, caught error). Headers are byte-identical. **27984cf specifically touched zero lines of this path** — everything it changed is scoped to `buildChatSnapshot()` and chat UI. If this recurs, it predates Coach Chat entirely.
- **New observability (this is the permanent fix for "we can't tell what actually happened").** `pipeAnthropicStream()` now listens for the response's `finish` event (fires once all data is actually flushed to the socket) and `close` event (fires once the connection is fully torn down), logging both separately from the existing `"stream complete"` line — which only means the upstream Anthropic body finished and `res.end()` was *about to be called*, not that the client ever received it. `res.end()` itself is now wrapped in try/catch so a throw there (previously silent) surfaces as `"res.end() threw:"`. Next occurrence, these logs will show definitively whether `res.end()` completed cleanly (Express-level bug ruled out) or never flushed/closed (points at Render's proxy or the underlying socket).
- **Applied mitigation (precedented, not proven root cause).** The Anthropic streaming fetch calls (`daily_recs` in `/api/ai`, and `coach_chat`'s send endpoint) now use a dedicated `anthropicStreamAgent = new https.Agent({keepAlive:false})`, forcing a fresh TCP/TLS connection per call — the exact same fix this file already applies to Fitbit's token endpoint (`fitbitTokenAgent`, with a comment citing "Render's node-fetch pool has a compatibility issue... causes Premature close on pooled sockets"). A stale/reused pooled socket is consistent with the observed symptom (connection active, termination never arrives) but this was not empirically reproduced locally — see the E2E test note below.
- **`server.keepAliveTimeout`/`headersTimeout` tuned.** `app.listen()`'s return value is now captured (`httpServer`) and `keepAliveTimeout` set to 65000ms / `headersTimeout` to 66000ms (must exceed keepAliveTimeout) — the standard mitigation for Node apps behind a reverse proxy whose own idle-connection timeout (commonly ~60s) can otherwise race Node's much shorter default (5s), a well-documented class of intermittent connection issue for any Node app deployed behind a proxy like Render's.
- **Local E2E verification**: the exact current `pipeAnthropicStream()` was extracted verbatim (not reimplemented) into a standalone harness, run against a local mock Anthropic SSE server under three patterns — normal pacing, a 3000-chunk fast/large stress test (backpressure), and a slow 2s-spaced trickle (idle-timer-reset path) — driven by a real HTTP client replicating `fetchAI()`'s exact reader-pump logic. All three reached `done:true` cleanly, with the new FINISHED/CLOSED logs appearing correctly after "stream complete." This confirms the current code is correct under every locally-reproducible condition; the production incident, if it recurs, will be diagnosable from the new logs in a way it wasn't before.

**Verifying prompt caching (`coach_chat`).** Fixed 2026-07-15: `coach_chat` was logging `cache_write=0 cache_read=0` on every call. Root cause was **not** a bug in `wrapSystemWithCache()` (verified structurally identical to the `daily_recs` path — a string system prompt is wrapped into `[{type:"text", text, cache_control}]` either way) but that Anthropic requires a **minimum cacheable prefix length — 1024 tokens for Sonnet** (the model `coach_chat` uses), and `CHAT_SYSTEM_PERSONA` + a deliberately condensed athlete snapshot (Part A's own fix) was landing well under that for a typical athlete. Fixed by expanding `CHAT_SYSTEM_PERSONA` to ~4950 characters (~1200+ estimated tokens) of genuinely useful coaching-style/behavioral guidance — deliberately in the **stable, athlete-independent** block rather than padding the snapshot, since snapshot size varies per athlete and would make caching unreliable. To verify caching is actually working (locally or in prod): call `POST /api/profiles/:id/chat/message?debug=1` and check `system_est_tokens` (should be safely over 1024) and `cache_control_present` (should be `true`) in the response — this debug endpoint was itself fixed in the same pass to return the real post-`wrapSystemWithCache()` structure instead of the pre-wrap string, since the discrepancy was found while diagnosing this exact bug. The real confirmation is the `[AI] usage (stream): ... cache_write=N` log: nonzero `cache_write` on the first message of a session, nonzero `cache_read` on subsequent ones within the 1h TTL.

**Frontend** (`public/index.html`, CSS scoped to `#chat-view .cv-*` plus the standalone `.chatHeaderBtn` header-entry class, functions prefixed `cv`): `sendChatMessage()` mirrors `fetchAI()`'s streaming consumption — `reader.getReader()` pump loop, an idle-reset abort timer (45s) plus a hard cap (90s), and a bounded 3-attempt retry with 3s backoff. Unlike `fetchAI()`'s single global `aiRetryTimer`/`aiPermanentlyFailed` flags, retry state (`cvPendingRetry`) is scoped to the one in-flight message, so an earlier message's exhausted retry chain never blocks a new message the user types. Assistant bubbles render via the existing `parseMd()` markdown-lite helper (same one used for "Ask Your History" answers); AI bubbles use the established Cornerman-purple AI-attribution treatment (`background:var(--bg-surface-2);border-left:3px solid var(--accent-cornerman)`, matching `#history-answer`), user bubbles a neutral surface-1 bubble aligned right. `loadChatThread()` fetches full history on first open (`GET .../chat/thread`) and renders it before any send. None of `openChatView()`/`closeChatView()`/`sendChatMessage()` changed for the docked-panel work (2026-07-15) — the desktop/mobile layout split above is pure CSS via the `@media(min-width:769px)` override on `#chat-view`.

### Coach Chat Tool Use (2026-07-15)

v1 write scope, deliberately narrow: **update an existing goal** (target/timeline/notes/active-paused — never create or delete one), **set/update/clear the standing Focus Override**, **log a free-text check-in note**. Explicitly NOT supported: creating/deleting goals, editing workouts/exercises, schedule changes — the persona tells the model to redirect those to the app. **No tool ever writes real data directly** — every tool call only creates a PENDING row; a write happens only after the athlete explicitly confirms in the thread.

**Tools** (`COACH_CHAT_TOOLS` in `server.js`, sent on every `coach_chat` request): `propose_goal_update`, `propose_focus_override`, `propose_checkin_note` — full Anthropic `input_schema` for each is in the constant itself. A new `goal.target_date` field was added (additive jsonb key on `profile_data.goals[]` entries, no migration needed) since no existing field covered "timeline"; "active/inactive" reuses the goal editor's existing `status` vocabulary (`'PAUSED'` vs `'IN PROGRESS'`, already a real dropdown value, not a new field).

**Streaming architecture.** `pipeAnthropicStream()` was refactored (2026-07-15) without changing its external behavior for `daily_recs` — the same call site, same signature, same return value. Internally it now delegates to a shared `pumpAnthropicLeg()` (pumps ONE Anthropic SSE leg: writes text deltas to `res` same as before, and now also collects `tool_use` blocks by reassembling their `input_json_delta` chunks into parsed JSON), plus `startAnthropicStreamResponse()`/`finalizeAnthropicStream()` (headers/finish-close-logging/usage-logging/`res.end()`, factored out so both streaming paths share identical logging). A new `pipeAnthropicToolStream()` — used ONLY by `coach_chat` — loops legs: pump a leg; if `stop_reason === "tool_use"`, call the caller's `onToolUse(toolUses)` (executes each tool via `executeProposalTool()` — creates a pending `chat_proposals` row, returns a `tool_result` telling the model it's pending confirmation, never applies anything), then `fetchNextLeg(leg, toolResultBlocks)` re-POSTs to Anthropic with the reconstructed assistant turn + tool results appended, and continues — capped at `CHAT_MAX_TOOL_LEGS = 4` against a runaway loop. Text from every leg streams to the client as it arrives; there is no hidden/suppressed model text. After the loop ends, `onBeforeFinalize()` appends a **server-authored** (never model-generated) marker to the very end of the stream for any proposals created this call: `\n\n[[APEXCOACH_PROPOSALS]]\n<JSON array>\n[[/APEXCOACH_PROPOSALS]]`. This marker is embedded in the persisted `chat_messages.content` verbatim, which is how a page refresh doesn't lose the card — see below.

**Schema** (migration `migrations/2026-07-15_chat_proposals.sql` + `migrations/2026-07-15_chat_proposals_regen_type.sql`, both run manually):
- `chat_proposals` — `id`, `thread_id` (FK), `message_id` (FK, nullable — backfilled after the assistant message is saved post-stream, since a proposal is created mid-stream before that row exists), `tool_use_id` (**NOT NULL** — designed assuming a model-tool-call origin; the server-triggered `regenerate_goal_roadmap` type uses a synthetic sentinel string, see "Roadmap-Regenerate Auto-Offer" below), `type` (`update_goal`\|`set_focus_override`\|`log_checkin_note`\|`regenerate_goal_roadmap` — the 4th value needed its own migration, the original CHECK constraint didn't allow it, found live via a real `23514` error), `payload` (jsonb — `{title, changes:[{field,label,before,after}], reason, ...type-specific internal fields}`), `status` (`pending`\|`confirmed`\|`canceled`), `created_at`, `resolved_at`. RLS + `service_role_bypass`, matching every other table.

**Compute vs. apply — the safety-critical split.** `compute*Proposal()` functions (`computeGoalUpdateProposal`, `computeFocusOverrideProposal`, `computeCheckinNoteProposal`) are READ-ONLY — they read current state and describe the proposed change as a `changes` list, never writing anything. `applyProposal()` is the **only** function in the whole feature that writes real data, and it's called only from `POST .../chat/proposals/:id/confirm` after explicit confirmation. It reuses existing helpers rather than duplicating write logic: `loadProfileWithGoals()`/`findGoalById()`/`saveGoalToProfile()` (the same helpers the Living Goal Roadmap endpoints already use) for goals; a new `saveProfileDataField()` (a generic sibling of `saveGoalToProfile` for any other top-level `profile_data` key) for focus_override — **written this way specifically because a naive `PATCH /rest/v1/profiles` with just `{profile_data:{focus_override:...}}` would REPLACE the whole `profile_data` column and destroy every other key** (goals, schedule, `ai_prompt_context`, ...) — this was caught in review before it shipped, not a hypothetical; for check-in notes, a fetch-then-merge upsert into `daily_checkins` so a note never wipes out today's `energy`/`soreness`/`severity` logged from the app's own check-in form (that upsert is keyed on `(profile_id, date)` and overwrites the whole row if you don't merge first).

**Confirm/Cancel** (`POST .../chat/proposals/:id/confirm` and `.../cancel`) are simple, fast, synchronous endpoints — **neither makes a live Anthropic call**. Confirm applies the write and marks the proposal `confirmed`; cancel just marks it `canceled`. Both insert a short synthetic `chat_messages` row (role `user`, e.g. `"[Athlete confirmed the proposed change to \"...\".]"`) so thread history stays coherent for future turns — the model's natural-language acknowledgment happens on the athlete's *next* real message (which now has that note in context), rather than triggering a second live model turn from a button click. This is a deliberate design choice (latency/cost of a button press vs. conversational nicety), not an oversight.

**Refresh-proof by design.** `GET .../chat/thread` now also returns a `proposals` array (every proposal for the thread, any status). A stored message's embedded marker may have a stale/frozen status baked in from when it streamed (always `"pending"`, since that's the only state a proposal can be in at creation time) — the client always trusts the live `proposals` array over whatever's in the marker text, so a confirm/cancel survives a page refresh correctly.

**Frontend** (`cv-proposal-*` CSS classes, Cornerman-accented per the AI-attribution convention, Ember Confirm as the primary CTA): `cvStripProposalMarker()` strips the marker from message text on every render (including mid-stream, so the raw `[[APEXCOACH_PROPOSALS]]` JSON never flashes into view even for a frame) and returns the parsed proposals; `cvProposalsById` is the client-side source of truth for status, populated from `GET .../chat/thread`'s `proposals` array on load and merged with freshly-parsed ones after a live send. `cvConfirmProposal()`/`cvCancelProposal()` POST to the two endpoints and update the card in place (`cvSetProposalCardStatus()`) without a full reload. `cvRefreshProfileAfterApply()` re-fetches the profile after a confirmed change and refreshes `currentProfileData` + `localStorage.ac_profile_data` + clears `ac_goal_progress`, calling `renderProfileGoals()`/`renderFocusOverrideCard()` if defined (wrapped in try/catch — those functions assume Profile-tab DOM that may not be relevant to guard against defensively rather than audit exhaustively).

**Verification**: the tool-loop *mechanics* (incremental `input_json_delta` reassembly across split chunks, multi-leg re-POST orchestration, marker injection, clean termination) were verified with the exact current `pipeAnthropicToolStream()` extracted verbatim into a harness against a mock Anthropic emitting a real tool_use SSE sequence. The *write safety* (confirm actually changes only the intended fields and nothing else; cancel changes nothing; double-confirm is rejected; `GET .../chat/thread` reflects live status) was verified against the real server + a mock Supabase with real goal read/write round-trips. The *rendering* (marker never leaks into a bubble, card renders the right diff, status transitions correctly) was verified via real function calls in a live browser.

**Explicitly out of scope for this feature**: no changes to `profiles.roadmap` (legacy text roadmap), `fitbit_pending_imports`, or any wearable sync logic; no new npm dependencies (raw `node-fetch` SSE pipe, same as `daily_recs`); creating/deleting goals, workout/exercise edits, and schedule changes are NOT tool-callable even after the 2026-07-15 tool-use addition — those still redirect to the app.

### Roadmap-Regenerate Auto-Offer (2026-07-15 session #6)

Closes the gap noted above: a confirmed `propose_goal_update` on a goal that already has a roadmap now surfaces a follow-up offer to regenerate it, via the same confirm-card pattern as every other proposal. Per-goal only — the macro `roadmap_data` is never touched by this.

**Server-triggered, NOT a model tool call — a deliberate pivot from the original design, found live.** The first build gave the model a `propose_roadmap_regen` tool and instructed it (via `CHAT_SYSTEM_PERSONA`) to call it right after seeing its own goal-update confirmed in thread history. Live-tested against a real chat session with 3 different prompt strategies — a soft ask, an explicit "don't ask in text first, just call it," then a blunt mechanical if/then rule ("your response is INCOMPLETE and WRONG unless it contains an actual tool_use call") — and all 3 failed identically: the model narrated the offer in prose ("I'll queue it up now", "confirm that card and it'll generate a fresh plan") without ever emitting the `propose_roadmap_regen` tool_use block, across 3 separate confirmed goal-updates in the same session. `propose_goal_update` itself fired correctly all 3 times in that same session, ruling out a tool-plumbing bug — this was specifically the model choosing not to call this one tool despite explicit, increasingly forceful instruction. After presenting this evidence, the user chose a server-side trigger instead. `propose_roadmap_regen` was removed from `COACH_CHAT_TOOLS` entirely; the model has no tool for this anymore and isn't expected to create the offer itself. `CHAT_SYSTEM_PERSONA` now just has a short note ("ONE MORE CARD YOU DON'T CREATE...") so the model doesn't get confused if the athlete asks about a card it didn't propose.

**Mechanism**: `applyProposal()`'s `update_goal` branch now returns `{ autoOfferGoal }` — set to the (already-updated, in-memory) goal object when it has a `.roadmap`, `null` otherwise. `POST .../chat/proposals/:id/confirm` checks this after a successful apply and, if set, calls `maybeAutoOfferRoadmapRegen(threadId, profileId, goal)`, which: (1) dedup-guards against an already-pending regen offer for the same goal on this thread (fetches pending `regenerate_goal_roadmap` proposals, filters by `payload.goal_id` in JS — avoids relying on PostgREST jsonb-in-URL filter syntax); (2) calls `computeRoadmapRegenProposal(profileId, {goal_id, reason})` (unchanged from the original design — read-only, still throws a `noop` if the goal somehow has no roadmap, a defensive backstop); (3) `createChatProposal()`s the pending row directly (no tool_use origin, so a synthetic `"server:auto-offer-roadmap-regen"` string satisfies the `tool_use_id NOT NULL` constraint); (4) inserts a synthetic `chat_messages` note ("[The app automatically offered to regenerate the roadmap for ... this was not something you proposed, just acknowledge it naturally if asked.]") so thread history stays coherent, matching the confirm/cancel synthetic-note convention. The new proposal is returned in the confirm endpoint's JSON response as `follow_up_proposal`, so the frontend renders the card **immediately** — strictly better UX than the original tool-call design would have given even if it had worked, since that would have needed an entire extra chat turn (and Anthropic round-trip) before the offer could even have a chance to appear.

**Generation**: confirming the auto-offered card calls a new shared `generateGoalRoadmapForGoal(profileId, goalId, mode)`, extracted from the existing `POST /api/profiles/:id/goals/:goalId/roadmap` handler (that route now just calls this with `mode:"reset"` — zero behavior change for it). Called here with `mode:"regenerate"`: same Sonnet generation as a first-time roadmap, but the write increments the **existing** `version` and appends to the **existing** `adaptation_log` (`{date, summary:"Roadmap regenerated via Coach Chat after a goal update.", trigger:"manual"}`) instead of resetting them to `1`/`[]` — this goal already had roadmap history worth keeping, unlike a true cold-start generate. (This distinction was a live decision point, not an assumption — flagged and confirmed with the user before building, since the literal instruction to reuse the "full regenerate... not the adapt path" endpoint conflicted with the expectation that version/log survive.)

**Frontend loading/retry state** (`public/index.html`): unlike every other proposal type, confirming a `regenerate_goal_roadmap` card triggers a live multi-second Sonnet call that can genuinely fail — `cvConfirmProposal()` special-cases `p.type === 'regenerate_goal_roadmap'`: shows a `.cv-proposal-working` label in place of the buttons while in flight, auto-retries up to `CV_REGEN_MAX_ATTEMPTS = 3` times with a 2s delay on failure, then falls back to a `.cv-proposal-error` message + a manual "Try again" button (bounded, never a silent unbounded retry loop). Every other proposal type keeps the original plain `cvProposalButtonsBusy()` disable-on-click behavior, unchanged.

**Bonus fix found while wiring this up**: `formatGoalLineForChat()` never actually included a goal's `id` in the Coach Chat snapshot's GOALS section, despite `propose_goal_update`'s own tool description telling the model to "read it from the GOALS section... never guess it" — a real pre-existing gap that also affected the already-shipped `propose_goal_update` tool, not just this new feature. Fixed by appending `" (id: " + g.id + ")"` to every goal line. Also added a `" [has roadmap vN]"` marker to the same line — no longer load-bearing for the auto-offer trigger (that's server-side now), but harmless to keep since the model's persona note references it when explaining the card to the athlete.

**Two real schema bugs, found live, not by reading the schema**: (1) `chat_proposals.tool_use_id` is `NOT NULL` — every prior proposal type assumed a model-tool-call origin, so passing `null` for a server-originated proposal hit a `23502` violation on the first live attempt; worked around with the sentinel string above rather than migrating the column, since the workaround is sufficient and avoids touching a constraint every other proposal type still depends on. (2) `chat_proposals.type`'s CHECK constraint (`CHECK (type IN ('update_goal', 'set_focus_override', 'log_checkin_note'))`) didn't include the new value at all — a second live `23514` violation, this one genuinely requiring a schema change; fixed via `migrations/2026-07-15_chat_proposals_regen_type.sql` (drops and recreates the auto-named constraint with the 4th value added, asserts RLS + `service_role_bypass` idempotently per the project convention — **run manually, applied to production**).

**Verified live end-to-end**, not by reading code, against the "Test #3" scratch profile (id 4) via the real deployed app (real Anthropic calls, real Supabase writes): **positive case** — seeded a goal with a v1 roadmap (`generated_at: 2026-06-01`, 1 `adaptation_log` entry) via direct profile PATCH, then ran a real multi-turn chat: proposed and confirmed a `propose_goal_update` on that goal → the confirm response's `follow_up_proposal` contained a real, freshly-created `regenerate_goal_roadmap` proposal → confirmed that → re-fetched the goal and confirmed `version` went `1→2`, `generated_at` refreshed to a new timestamp, `adaptation_log` grew to 2 entries with the original preserved and a new one appended, and 5 fresh phases were generated genuinely grounded in the athlete's real profile/chat context (the model's own generated `timeline_note` referenced the knee issue mentioned earlier in the same chat thread). **Negative case** — proposed and confirmed a `propose_goal_update` on a different goal with no `.roadmap` → `follow_up_proposal:null` in the confirm response, and the thread's `proposals` array showed zero `regenerate_goal_roadmap` entries for that goal's id.

### Same-day workout visibility (fixed 2026-07-15)

Real-world repro: a workout logged minutes earlier didn't appear in the chat snapshot, and the model claimed it needed a "sync" — wrong on two counts (workouts are never wearable-synced, and the actual cause wasn't sync-related at all). Root cause: `buildRecentExerciseLog()` reads ONLY the `exercises` table, but exercise rows are created by a **separate, asynchronous** follow-up call — `saveWorkoutToSupabase()` in `public/index.html` fires `POST /api/workouts` first, and only after THAT resolves does it fire a second, independent `POST .../extract-exercises` call (its own Haiku request). There's a real multi-second window — or longer/never, if extraction fails or the notes don't parse into anything recognizable — where a workout is fully saved in `workouts` but has zero rows in `exercises` yet. (Date-window/timezone bounds were also audited: the query has no upper bound, so a plain 7-day-lookback timezone drift wasn't the cause here — though `buildChatSnapshot()`'s own "today" was, at the time, still computed server-side via `dateStr(0)`, i.e. the Render server's clock, not the athlete's actual timezone; flagged here as a real, separate gap rather than silently left undocumented — **fixed the same day**, see "Athlete Timezone (`localToday()`)" above, once the exact repro this note predicted actually happened in production.)

Fixed with `buildTodayWorkoutFallback()`: reads today's raw `workouts` rows directly and adds a fallback line (`type` + a trimmed notes snippet, clearly labeled `[logged just now, not yet broken into exercise data]`) for any of today's workouts that aren't yet represented in the exercises `buildRecentExerciseLog()` found (cross-referenced by `workout_id`, which that function now also selects/returns). The fallback naturally stops appearing on the next message once extraction actually completes, since the snapshot is rebuilt fresh every call. Also fixed `CHAT_SYSTEM_PERSONA`'s "WHAT YOU KNOW" paragraph to explicitly rule out fabricating a "sync" explanation: only biometrics (sleep/HRV/RHR/steps/weight) are cache-based from the last wearable sync — logged workouts appear the instant they're saved, never synced — so if a just-logged workout is genuinely missing, the instructed honest answer is "I don't see it yet," not a guessed mechanism.

## Active Challenges (Micro-Goals)

Short-horizon, specific, measurable challenges that the AI weaves into EVERY daily recommendation. Separate from the long-term goal priority list — goals set direction, challenges set the next concrete target.

**Types** (`micro_goals.type`): `daily_habit`, `weekly_frequency`, `cumulative_volume`, `strength_milestone`, `skill_technique`, `streak`, `recovery_balance`.

**Auto-tracking** (server recomputes `current_value` on every GET):
- `cumulative_volume` — sums `sets*reps` (or `duration_minutes` if unit is minutes, `distance_miles` if unit is miles/km) from exercises matching title keywords since `created_at`
- `weekly_frequency` — counts workouts in current week (Mon-Sun) matching title keywords
- `streak` — consecutive days with `done=true` workouts ending today/yesterday
- `daily_habit` — distinct days the activity was logged, unioning (a) days with a matching `exercises` row and (b) days a workout's notes/type mention the canonical exercise even when the AI extractor never pulled an `exercises` row for it (`mgHabitDaySources` + `mgWorkoutTextMatches`, with a word-boundary guard so "hanging leg raise" etc. don't false-match the bare "hang"). This backstops extraction misses that silently dropped real habit days.
- `strength_milestone` — best single-effort across matching exercises, branched on `target_unit`: **weight** (`lbs`, or `kg`/`kgs`/`kilograms` converted from the stored `weight_lbs`) → max `weight_lbs`; **time** (`seconds`/`minutes` & aliases) → max hold duration, preferring `parseDurationToSeconds(raw_text||notes)` over the `duration_minutes` column (**historical note:** that column was `integer` until 2026-07-19, so every sub-minute hold silently failed to insert — hence the preference for parsing `raw_text`. The column is now `numeric(6,2)` and populates correctly; `raw_text` parsing is retained because it remains the more faithful source of what the athlete actually typed, not because the column is broken), with aspirational/goal-statement rows (e.g. "Dead Hang - work toward 2:00 goal") skipped via `mgIsAspirationalEntry()`; **reps** (`reps`/`rep`) → max single-set `reps`; **distance** (`miles`/`mi`, or `km`/`kilometers` converted from miles) → longest single-session `distance_miles`; an **unknown unit → `null`** (no auto-track). Weight uses the `main_category=strength` filter; time/reps/distance do not (calisthenics/cardio rows are categorized differently).
- `recovery_balance` — rest days (no completed workout) in the last 7 days
- `skill_technique` — manual only (PATCH with `current_value`)

**UI** — Profile tab "Active Challenges" card above Goals & Milestones. Each challenge: title, type badge, progress bar (color scales with %), days-remaining/period label, edit/delete buttons. Completion triggers a canvas confetti burst (`fireConfetti()`) and a `.just-done` card pop animation. `+ Add` opens `#mg-modal` with title input, type pill selector, target value + unit, and period picker (daily/weekly/monthly/custom with date).

**AI integration** — `buildMicroGoalsPromptContext()` injects an ACTIVE CHALLENGES block after `goalPriorityContext`. Per-type instructions:
- Daily habit → must appear in every recommendation
- Weekly frequency → urgency flag when behind pace based on day-of-week (day X / 7)
- Cumulative volume → remaining ÷ days_left = suggested daily volume
- Strength milestone → progressive overload when readiness allows
- Streak → flag risk if no workout yet today
- Recovery balance → rest day as primary option if under rest target AND readiness < 70

Claude may include challenge titles in the rec's `goal_tags` array; `isMicroGoalTag()` detects these client-side and renders them as `🎯 Supports: [title]` pills (accent green) instead of the amber `→ [title]` pills used for long-term goals.

**Cache refresh** — adding, editing, completing, or deleting a challenge calls `regenerateAIForContextChange()` to invalidate cached daily recs. Workout saves also call `loadMicroGoals()` so auto-tracked progress updates immediately after a session is logged.

**Supabase setup** — ⚠ **STALE, DO NOT RUN AS-IS.** The snippet below is the *original* proposed DDL and does **not** describe the live table: production `micro_goals.id` is an **integer**, not a uuid (verified 2026-07-22 — live rows are ids `1` and `2`), and `profile_id` is a **bigint** FK to `profiles(id)` (bigint), not uuid. Kept for historical context only; recreating the table from this would break every existing FK relationship and the +100000 clone offset used by the profile-4 clone scripts.
```sql
CREATE TABLE IF NOT EXISTS micro_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),          -- ⚠ live table: integer
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,  -- ⚠ live table: bigint
  title text NOT NULL,
  type text NOT NULL,
  target_value numeric NOT NULL,
  target_unit text,
  period text DEFAULT 'custom',
  end_date date,
  current_value numeric DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_micro_goals_profile ON micro_goals(profile_id, is_active);
```

## Step History Tracking

Daily step totals (plus calories / distance / floors) are persisted per profile per day so they survive beyond Fitbit's rolling window and can power history views, trend charts, and AI prompt context.

- **Table**: `daily_steps` (see Supabase Tables). `profile_id + date` unique; rows upserted on conflict.
- **Source**: Upserted inside `GET /api/profiles/:id/daily` — right after `buildDailyData` returns, the server writes yesterday's `{steps, calories, distance, floors}` to `daily_steps` (source='fitbit'). Fire-and-forget; the daily response isn't delayed on the upsert.
- **Step goal**: Stored at `profile_data.settings.step_goal` (integer, default 8000). Editable in Settings → Goals & Tracking as a slider (range 3000–20000, step 500). Saved via `PATCH /api/profiles/:id`.
- **Auto-tracking of micro-goals**: After each steps upsert the server matches active `micro_goals` of type `daily_habit` where title ILIKE `%step%`/`%walk%` OR `target_unit = 'steps'` and sets `current_value` to today's step count. Lets a user create "Walk 8,000 steps daily" and have it auto-complete.
- **History pill**: Each history-list card with a matching `daily_steps` row gets a `👟 N steps` pill — green (`#22c97a`) if steps ≥ goal, muted grey if below.
- **Library Steps section**: 30-day bar chart (Chart.js) with dashed horizontal line at the step goal. Below the chart: 7-day average, best day (with value), goal hit rate ("Hit goal X of last 7 days").
- **AI prompt injection**: `buildStepContextLine()` adds `Steps yesterday: N (goal: G ✅/❌)` plus a "consider a walk today" nudge when under goal, appended to the LIVE FITBIT DATA block so Claude factors low-intensity volume into the rec.

**Endpoint**: `GET /api/profiles/:id/daily-steps?days=30` — returns last N days ordered by date desc.

**Supabase setup** — run once in SQL editor:
```sql
CREATE TABLE IF NOT EXISTS daily_steps (
  id bigint generated always as identity primary key,
  profile_id bigint references profiles(id) on delete cascade,
  date date not null,
  steps int,
  calories int,
  distance_miles numeric(6,2),
  floors int,
  source text default 'fitbit',
  created_at timestamptz default now(),
  UNIQUE(profile_id, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_steps_profile_date ON daily_steps(profile_id, date DESC);
```

## Body Composition Tracking

Per-profile weight / body-fat / BMI history powers a Today-tab Body Metrics card, a 90-day weight-trend line chart on the Profile tab, and a `BODY COMPOSITION` block in the daily AI rec prompt with TDEE math.

- **Profile body fields** (top-level columns on `profiles`, NOT `profile_data`): `height_inches` (numeric), `birth_date` (date), `sex` (text: `Male` | `Female` | `Prefer not to say`), `goal_weight_lbs` (numeric), `goal_weight_timeline_months` (int). Edited from the Profile tab "Body" card. PATCH `/api/profiles/:id` accepts these as siblings of `profile_data`.
- **Body Metrics card (Today)** — sits between the readiness card and the feeling check-in. Shows latest weight, BMI + label tier (`<18.5` Underweight, `18.5–24.9` Normal, `25–29.9` Overweight, `30+` Obese), body-fat % when available, and a goal progress bar ("X lbs to goal"). Hidden entirely if no metric rows exist AND height/weight have never been set. "+ Log Weight" opens a quick-entry modal that POSTs `weight_lbs` (and optional `body_fat_pct`) and re-renders.
- **Weight Trend (Profile)** — Chart.js line chart of last 90 days from `body_metrics`, with three reference lines: starting weight, current weight, goal weight. A `Projected goal date` line beneath estimates ETA from the rolling 14-day rate of change.
- **Fitbit sync**: `buildDailyData` also calls `/1/user/-/body/log/weight/date/today.json` and `/1/user/-/body/log/fat/date/today.json`. If either returns a row for today, `/api/profiles/:id/daily` upserts into `body_metrics` with `source='fitbit'` and recomputes BMI when `height_inches` is set.
- **AI prompt**: `buildBodyCompositionBlock()` injects a `BODY COMPOSITION` block right after the steps line. Computes TDEE via Mifflin-St Jeor (Men: `(10×kg)+(6.25×cm)−(5×age)+5`, Women: `−161` instead of `+5`), multiplies by 1.55 (moderately active default). Total `Δ lbs × 3500 ÷ days = daily delta`, capped at −750 cal/day (deficit, 1.5 lb/wk max) or +500 cal/day (surplus). The block ends with a one-liner Claude can echo back: "To reach your goal by [month], aim to burn ~X cal today through exercise and keep intake around Y cal."

**Endpoints**:
- `GET /api/profiles/:id/body-metrics?days=90` — returns rows ordered by date desc.
- `POST /api/profiles/:id/body-metrics` — body `{weight_lbs, body_fat_pct?, date?}`. Upserts; recomputes BMI from profile height when known. Used by manual log button and any future scale integrations.

**Supabase setup** — run once in SQL editor:
```sql
CREATE TABLE IF NOT EXISTS body_metrics (
  id bigint generated always as identity primary key,
  profile_id bigint references profiles(id) on delete cascade,
  date date not null,
  weight_lbs numeric(6,1),
  body_fat_pct numeric(5,2),
  bmi numeric(5,2),
  source text default 'manual',
  created_at timestamptz default now(),
  UNIQUE(profile_id, date)
);
CREATE INDEX IF NOT EXISTS idx_body_metrics_profile_date ON body_metrics(profile_id, date DESC);

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS height_inches numeric(5,1),
  ADD COLUMN IF NOT EXISTS birth_date date,
  ADD COLUMN IF NOT EXISTS sex text,
  ADD COLUMN IF NOT EXISTS goal_weight_lbs numeric(6,1),
  ADD COLUMN IF NOT EXISTS goal_weight_timeline_months int;
```

## Daily Sleep Tracking (Life OS fast-path)

Last night's sleep is persisted per profile per day so Life OS gets instant, Fitbit-independent sleep/HRV/RHR after the first successful sync each day (no more nulls from Render cold starts or Vercel timeouts).

- **Table**: `daily_sleep` (see Supabase Tables). `profile_id + date` unique; rows upserted on conflict.
- **Computed score**: `estimateSleepScore(deep, rem, light, awake)` in `server.js` is a server mirror of the `public/index.html` function (personal regression model — see FORMULAS.md; keep the two in sync). `buildDailyData` computes it from `sleepRecord.levels.summary` and exposes it as `data.sleep.score`. Fitbit's own score stays at `data.sleep.fitbit_score` (still read by the app UI).
- **Source**: `buildDailyData` returns a `sleepSummary` `{date=today, hours, score, deep/rem/light/wake_minutes, hrv, rhr}`. `GET /api/profiles/:id/daily` upserts it fire-and-forget (source='fitbit'); the `life-os-summary` Fitbit fallback path upserts it too. Keyed under `today` so the Life OS `date=today` lookup hits even when Fitbit files the sleep record under yesterday's start date.
- **Life OS read path**: `life-os-summary` reads `daily_sleep` first (fast path, no Fitbit). On a miss it does the live 7s Fitbit call, returns the computed score, and upserts for next time. HRV/RHR are stored alongside sleep so the fast path returns all three without a Fitbit call.
- **Migration**: `migrations/2026-05-24_daily_sleep.sql`.

## Exercise Context Helpers (roadmap grounding)

Two server helpers ground all roadmap prompts in the athlete's actual logged training (aggregation in Node after a PostgREST fetch; numerics via `numOrNull`; YYYY-MM-DD local dates):

- `getGoalExerciseContext(profileId, goalKeywords, days=90)` — filters `exercises` to names partial-matching any keyword (case-insensitive). Returns `{ total_sessions (distinct days), last_session_date, best_set {weight_lbs,reps,duration_minutes}, recent_volume [{date,sets,reps,weight_lbs} ×3], trend: 'improving'|'plateauing'|'declining'|'insufficient_data' (best metric first-half vs second-half of sessions), weeks_since_last }`.
- `getFullExerciseContext(profileId, days=60)` — overall picture: `{ top_exercises (top 10 by distinct-day count, each {name,last_date,total_sessions,best_set}), inactive_exercises (last done ≥6 weeks ago: {name,weeks_since_last}), category_breakdown ({strength:N,cardio:N,…} = distinct completed-workout days per inferred category via inferWorkoutCategoryServer), consistency (avg completed workouts/week) }`.

`extractGoalKeywords(title)` splits a goal title on spaces, strips `GOAL_STOP_WORDS`, and keeps tokens ≥3 chars — used to drive `getGoalExerciseContext`.

## Macro Roadmap (structured — `profiles.roadmap_data`)

Replaces the legacy free-text `profiles.roadmap` blob with a structured jsonb that ties ALL goals into one phased plan.

- **Legacy text roadmap (`profiles.roadmap`) — fully retired 2026-07-17.** `GET/POST /api/profiles/:id/roadmap`, the client fns (`loadRoadmap`/`renderRoadmapContent`/`generateRoadmap`), and the hidden `#roadmap-card` were all removed from `server.js`/`public/index.html` — see "Tech Debt Batch" below. The `profiles.roadmap`/`roadmap_updated_at` columns themselves are a pending manual migration, not yet dropped.
- **Profile-tab UI (structured card)** — the Profile tab now renders the structured roadmap via `renderRoadmapData()` into `#roadmap-data-card` (scoped CSS `#roadmap-data-card .rd-*`, matching the `grv*` per-goal roadmap visual language). Render helpers: `loadRoadmapData()` (fetch + cache), `renderRoadmapData()` (dispatch), `rdEmptyHtml()` (manual empty state), `rdLoadedHtml()` (full card), `generateRoadmapData(isRegen)` (POST + spinner), `rdAskRegen()` (inline confirm), `rdToggleLog()` (adaptation-log collapse). The legacy `renderRoadmapContent()`/`loadRoadmap()`/`generateRoadmap()` functions and the `#roadmap-card` div were fully removed 2026-07-17 (see "Tech Debt Batch" below) — the Profile render path has called `loadRoadmapData()` (GET → cache in module vars `currentRoadmapData`/`currentRoadmapUpdatedAt`/`roadmapDataLoaded` → render) exclusively since 2026-05-29. **Auto-generation:** when the GET returns `roadmap_data:null`, `loadRoadmapData()` auto-calls `generateRoadmapData(false)` (in-card spinner) rather than showing the empty state; the manual empty state ("MACRO ROADMAP" + Generate button + subtext) only appears if that auto-generation fails. The browser console logs the raw `roadmap_data` after each generation. Loaded state (in order): header (timeline_range in Fraunces + note + muted Regenerate link), `COVERS` goal pills, 3 near-term phase cards (status badge current=ember/upcoming=muted/complete=positive, progress bar capped at 90% unless complete, duration/end-date, weekly_targets `•`, completion_signals `☐`/`☑`, cornerman goal_connections pills), 2 horizon cards (info `HORIZON` badge + milestone + estimated_range), exercise callouts (`GAPS TO ADDRESS` caution-bordered ⚠ / `WHAT'S WORKING` positive-bordered ✓; section skipped if both empty), collapsible adaptation log ("Show history (N updates)"), and a `Generated [date] · v[version]` footer. `generateRoadmapData(isRegen)` POSTs `/roadmap-data` (in-card spinner, non-fatal toast on failure) and on success caches the result so re-renders don't refetch; Regenerate uses an inline Yes/Cancel confirmation (no modal).
- **Endpoints**: `GET /api/profiles/:id/roadmap-data` (returns `roadmap_data` + `roadmap_data_updated_at`, or `{roadmap_data:null}`; near-term phase **`status` + `progress_pct` recomputed on read**). `POST /api/profiles/:id/roadmap-data` generates via Sonnet (`macro_roadmap_generate`) using `getFullExerciseContext(90)` + per-goal contexts + last 30 workouts + coaching brief (600 chars) + `ai_prompt_context` (1000 chars); no intake gate.
- **Phase status is derived from dates, not the AI** — `recomputeRoadmapProgress()` (shared by macro + per-goal roadmaps) ignores the AI-supplied status (which tends to be all `upcoming`) and derives near-term status from the `assignNearTermDates`-assigned window: `end_date < today` → `complete`, first phase with `start_date ≤ today ≤ end_date` → `current`, else `upcoming`; then `current` gets the time-elapsed `progress_pct` (capped 90), `complete` = 100. The `macro_roadmap_generate` system prompt (`MACRO_ROADMAP_SYS`) hard-requires a non-empty `goals_summary[]` and a non-empty `milestone` + `estimated_range` string on every horizon phase.
- **Shape**: `{ timeline_range, timeline_note, goals_summary[], phases[], exercise_gaps[], exercise_highlights[], generated_at, version, adaptation_log[] }`. Phases = 3 `near_term` (4–6 wks, with `weekly_targets[]`, `completion_signals[]`, `goal_connections[]`, `start_date`/`end_date`, `status`, `progress_pct`) + 2 `horizon` (`estimated_range`, `milestone`, `status`). `exercise_gaps` call out what's missing ("No lower body strength in 5 weeks"); `exercise_highlights` celebrate what's working.
- **Columns**: `profiles.roadmap_data` (jsonb), `profiles.roadmap_data_updated_at` (timestamptz). Migration `2026-05-22_roadmap_data.sql`.

## Living Goal Roadmaps (Per-Goal)

Each **individual goal** in `profile_data.goals[]` can carry its own phased, adaptive roadmap. **No new tables** — stored as fields on the goal object (jsonb).

**Frontend drill-down UI** (`public/index.html`, all functions prefixed `grv`/`openGoalRoadmap`/etc., CSS scoped to `#goal-roadmap-view`): each Goals & Milestones card has a "View Roadmap →" link (`openGoalRoadmap(goalId)`) that slides in a full-screen sub-view inside `#tab-profile`. If `goal.roadmap` exists → `renderGoalRoadmap` (timeline range + confidence badge, near-term phase cards with progress bars / weekly targets / completion signals, horizon cards, collapsible adaptation log, "Update My Coach" check-in + "Regenerate"). If not → `renderTemplateRoadmap` (placeholder phases) + a 2-step "Personalize" conversation. **API wiring note:** the UI talks to the *live* endpoints (the spec it was built from described a different contract): tapping Continue calls **GET** `/goals/:goalId/intake` to fetch AI-generated questions; "Build My Roadmap" does **POST** `/intake {answers:[{key,answer}]}` then **POST** `/roadmap`. The free-text statement from step 1 is prepended into the first answer so it still informs generation (the live `GET /intake` generates questions from the goal+profile, not from the statement). Cache (`currentProfileData.goals[]` + `ac_profile_data`) is updated in place on generate/check-in — no reload.

**Goal object fields** (added on demand):
- `id` — uuid (backfilled by `ensureGoalIds()`)
- `intake_questions` — `[{ question, key }]` (Haiku) / `intake_answers` — `[{ question, key, answer }]` / `intake_completed` — boolean
- `roadmap` — `{ timeline_range, timeline_note, date_confidence, phases[], generated_at, version, adaptation_log[] }`
- `last_adapted_at` — ISO timestamp
- Near-term phase: `{ name, type:'near_term', duration_weeks, start_date, end_date, weekly_targets[], completion_signals[], status:'upcoming'|'current'|'complete', progress_pct }`. Horizon phase: `{ name, type:'horizon', estimated_range, milestone, status }`.
- Adaptation log entry: `{ date, summary, trigger: 'weekly'|'checkin'|'manual' }`
- `date_confidence` ∈ `high`/`medium`/`low`; `timeline_note` is the honest 1–2 sentence range caveat (replaces the old `estimated_completion`/`date_note`/`summary` fields).

**Goal IDs**: `ensureGoalIds(profileData)` assigns `crypto.randomUUID()` to any goal missing one. Called in `GET /api/profiles/:id` (fire-and-forget PATCH) and `PATCH /api/profiles/:id` (before write).

**Endpoints**:
- `GET  /api/profiles/:id/goals/:goalId` — full goal object; `progress_pct` recomputed on read.
- `GET  /api/profiles/:id/goals/:goalId/intake` — existing intake or generates 4–6 targeted questions (Haiku) on first call
- `POST /api/profiles/:id/goals/:goalId/intake` — body `{ answers: [{ key, answer }] }`; sets `intake_completed`
- `POST /api/profiles/:id/goals/:goalId/roadmap` — requires completed intake; generates the new-shape roadmap (Sonnet) from intake + `getGoalExerciseContext` + `getFullExerciseContext` + last 20 workouts + profile + coaching brief
- `POST /api/profiles/:id/goals/:goalId/checkin` — body `{ notes }`; adapts the roadmap (Haiku) with the goal's exercise context, increments `version`, appends an `adaptation_log` entry (trigger `checkin`)

**Phase progress** (`computePhaseProgress(phase, exerciseContext)`): current near-term phases get a time-elapsed estimate (`days since start_date / duration_weeks*7`), capped at 90 so it never auto-completes, +10 when the goal's `trend === 'improving'`. Recomputed on read (`recomputeRoadmapProgress`), never stored. `assignNearTermDates()` backfills missing phase `start_date`/`end_date` sequentially from today so progress is always computable.

**Unified weekly auto-adaptation**: `maybeAdaptAllRoadmaps(profileId)` (fire-and-forget on `POST /api/workouts`) replaces the old `maybeAdaptGoalRoadmaps`. It loads the profile once, fetches `getFullExerciseContext(60)` + last 10 workouts once, then: (1) adapts each per-goal roadmap that is intake-complete + has a roadmap + is >7 days stale (each with its own `getGoalExerciseContext`, Haiku, trigger `weekly`); (2) adapts `roadmap_data` if it exists and is >7 days stale (Haiku `adaptMacroRoadmap` — updates `exercise_gaps`/`exercise_highlights`/phase statuses). A single profile PATCH writes `profile_data` and/or `roadmap_data` at the end.

**Model routing** (`CALL_TYPE_MODEL`): `goal_intake_questions`→Haiku, `goal_roadmap_generate`→Sonnet, `goal_roadmap_adapt`→Haiku, `macro_roadmap_generate`→Sonnet, `macro_roadmap_adapt`→Haiku. Endpoints call Anthropic directly via `callAISystem(system, user, maxTokens, model)`; `parseAIJson()` extracts JSON from fenced/prose responses.

## Previous Days Navigation

Left/right arrow navigation on Today tab to browse past days.

- **Variable**: `viewingDate` (null = today, otherwise YYYY-MM-DD), `viewingOffset` (0 = today, negative = past)
- **UI**: `← Yesterday` / `Today` / `→` buttons below date header. Arrow keys also work (left/right).
- **Past day mode**: Shows amber "Viewing [date]" banner. Hides check-in card, AI recommendation, and progress brief. Shows logged workout for that date (with edit button) or "No workout logged this day". Disables forward button when on today.
- **Fitbit data**: Server endpoint `GET /api/profiles/:id/daily?date=YYYY-MM-DD` accepts optional date param. `buildDailyData(token, overrideDate)` uses the provided date instead of today.
- **Known issue**: UI navigation works but historical Fitbit data does not load for past dates. The server needs debugging to properly fetch and cache historical Fitbit data for specific past dates. Workout log for past dates works fine.

## Profile Image Crop Tool

Canvas-based crop/zoom/pan interface shown when uploading a profile photo.

- **Flow**: File select → crop modal overlay → adjust → save
- **Controls**: Zoom slider (1x–3x), drag to pan (mouse + touch), pinch zoom on mobile
- **Output**: 200x200 JPEG via `canvas.toDataURL('image/jpeg', 0.85)`, stored as `profile_data.avatar_image`
- **Circle mask**: Canvas arc() + clip() for circular preview matching avatar shape

## Exercise Media & Form (Planned)

Three-phase plan for exercise demonstrations and AI form coaching:

- **Phase 1 — Video Library**: ExerciseDB API (exercisedb.io) integration for 1300+ exercises with GIF demonstrations, muscle groups, equipment, and instructions. Auto-matches against existing exercise library names. YouTube embed fallback for exercises not in ExerciseDB. Tap any exercise in the Library tab to see how to do it.
- **Phase 2 — Photo Form Check**: Snap a photo mid-exercise, Claude Vision analyzes form and gives specific corrective feedback. Single-image analysis, no real-time processing.
- **Phase 3 — Real-Time Form Coaching**: Google MediaPipe or TensorFlow.js detects 33 body landmarks in-browser. Pose landmark data (not raw video) sent to Claude for interpretation. Camera analyzes every 3-5 seconds with on-screen feedback and audio cues. Privacy-preserving — no video leaves the device.
- **Content partnerships**: License exclusive video content for Pro subscribers with revenue share model.

## Voice Input

Web Speech API (browser built-in dictation). `startVoice(targetEl, btnEl)` is the **generic** dictation function — called with no args it defaults to the log-modal `#wnotes`/`#mic-btn`/`#voice-status` (the original behavior); called with a textarea + button it dictates into that field and toggles that button (one shared `recognition` instance; `#voice-status` is updated only when present). `startCheckinVoice()` (feeling check-in) and the onboarding/profile-builder `obStartVoice()`/`pbStartVoice()` are separate self-contained dictation functions for their flows. The `voiceMicBtn()` helper returns the standard surface-2 circular 🎙 button — drop it immediately after a textarea inside a `position:relative` wrapper and it dictates into its previous sibling via `startVoice(this.previousElementSibling, this)`. Mic buttons are now on every textarea: log modal, feeling check-in, onboarding (main + device follow-up), profile builder (main + review), and all Living Goal Roadmap textareas (statement, per-question answers, check-in).

**Tap-to-toggle + silence auto-stop (all four flows).** Every dictation flow is now a clear toggle (first tap starts, second tap stops) and shares one watchdog, `voiceSilenceWatch(rec, btn, statusEl)` (defined just above `startVoice`). It: (a) adds a pulsing `.mic-recording` state to the mic button so the user can see it's still listening; (b) auto-stops after 3s (`VOICE_SILENCE_MS`) of no speech — it bumps a deadline on `onsoundstart`/`onspeechstart` and on each caller `onresult`, and calls `rec.stop()` when the deadline passes; (c) after ~1s of silence shows a final-2s countdown ("⏸ Auto-stopping in Ns…") in the status element plus an amber `.mic-warning` pulse so the cut-off isn't a surprise. Callers create the watch after setting handlers but before `rec.start()`, call `watch.bump()` in their own `onresult`, and `watch.dispose()` in `onend`/`onerror`. **`obStartVoice`/`pbStartVoice` were `continuous=false`** (Web Speech cut them off on the first pause) and are now `continuous=true` with the watchdog + accumulating-transcript `onresult`. The watchdog governs only WHEN recording stops; the transcription/processing wired to `onend` is unchanged. CSS: `.mic-recording`/`.mic-warning` + `@keyframes micPulse`/`micPulseWarn` (near `.ob-mic`).

**Planned upgrade:** OpenAI Whisper API for better accuracy on fitness/medical terminology (~$0.006/min). Record audio as blob → POST to a Whisper endpoint → return transcript, replacing the Web Speech recognition.

## Auto-Format Notes

Workout notes can be auto-formatted by Claude AI on save. Controlled by `ac_auto_format` in localStorage (default: true). Toggle available in the Log Workout modal toolbar and Settings → AI Coaching. When enabled, notes are formatted into clean structured lists before saving. Falls back to unformatted save on AI error.

## AI-Generated Workout Titles

The Log Workout modal has no manual type/title selector. Instead, users describe their workout in a free-text textarea ("What did you do today?"). On save, an AI call categorizes the workout using the full taxonomy hierarchy (see Exercise Library System section). Format: `[Main] ([Sub]) + [Main] ([Sub])` — e.g. "Rehab (PT) + Cardio (Elliptical, 20min) + Strength (Upper Body)". Maximum 8 words, max 3 categories (uses "Mixed Training" if more). The title is stored in the `type` column of the workouts table. Quick-log shortcut buttons (🥋 MMA, 🚶 Walk, 😴 Rest Day) pre-fill the textarea with starter text. If AI title generation fails, "Workout" is used as fallback. When editing an existing workout, if the notes are changed the AI title is automatically regenerated in the background and the workout card is re-rendered with the new title. The `generateWorkoutTitle(notes)` function is extracted as a reusable function called from both new saves and edits.

## Auto-Generate Goal Description

When adding a goal without a description, the system auto-generates one via `POST /api/profiles/:id/generate-goal-description`. Shows "Generating description..." placeholder while loading, then fills in the AI-generated text.

## Developer Tools

These browser console utilities are available for testing and debugging:

- `window.testStreak(days)` - Test streak display with any number of days. Example: `testStreak(30)` shows legendary mode, `testStreak(0)` shows broken streak

- `localStorage.removeItem('ac_cache')` then `location.reload()` - Force clear Fitbit cache and fetch fresh data

- `localStorage.clear()` then `location.reload()` - Nuclear option, clears everything including profile (will show profile selector)

These are intentionally left in production — they require console access and are invisible to regular users.

## Business Roadmap

### Pricing Model (Recommended)
- Free: Manual check-in, basic workout log, no AI
- Pro ($9.99/mo): Full AI coaching, Fitbit sync, exercise library, road map
- Family ($14.99/mo): Up to 4 profiles

### Phase 1 - Beta (0-100 users)
Infrastructure: ~$32/mo
- Render paid: $7/mo
- Supabase Pro: $25/mo
One-time: LLC ($50-500), Privacy Policy/TOS ($30-1500)
Personnel: Just the founder
Break-even: N/A (beta/free)

### Phase 2 - Launch (100-500 users)
Infrastructure: ~$121/mo
- Render Pro: $50/mo, Supabase Pro: $25/mo, Cloudflare: $20/mo, Sentry: $26/mo
- Stripe fees: 2.9% + $0.30/transaction
Personnel: ~$600-1500/mo
- Part-time customer support (10hrs/week at $15-25/hr)
- Freelance developer as needed ($50-150/hr)
Break-even: ~150-200 paid users
Revenue at 500 users: ~$4,995/mo gross

### Phase 3 - Growth (500-2000 users)
Infrastructure: ~$600-950/mo
- AWS/GCP compute, managed PostgreSQL, Redis cache, monitoring stack
Personnel: ~$6,700-11,250/mo
- Full-time customer support: $35-45k/yr
- Part-time AI/backend developer: $2,000-4,000/mo
- Part-time marketing: $1,500-3,000/mo
- Accountant: $200-500/mo
Break-even: ~1,000 paid users
Revenue at 2,000 users: ~$19,980/mo gross

### Phase 4 - Scale (2000-10000 users)
Infrastructure: ~$2,200-4,700/mo
Personnel: ~$48,000-60,000/mo
- 2x customer support, 1x backend dev, 1x AI/ML engineer, 1x DevOps, 1x marketing manager, founder salary
Revenue at 10,000 users: ~$99,900/mo gross
Valuation at this scale: $6-12M (5-10x ARR)

### AI API Cost Estimates (Claude API)
- Per recommendation: ~$0.01-0.03
- 1,000 users/day: ~$300-900/mo
- 10,000 users/day: ~$3,000-9,000/mo
- IMPORTANT: Factor into pricing model

### Key Risks
- Fitbit API dependency - mitigate by adding Apple Health, Garmin
- AI API costs scale with users - monitor closely
- Health data sensitivity - get proper legal review before launch

### Commercial Readiness TODO
- [ ] Google/Apple OAuth (replace PIN)
- [ ] JWT tokens with expiry (replace localStorage auth)
- [ ] Rate limiting on all API endpoints
- [ ] Submit Fitbit app for production approval (removes 10 user limit)
- [ ] Stripe payment integration
- [ ] Privacy Policy and Terms of Service
- [ ] LLC formation
- [ ] Sentry error monitoring
- [ ] Uptime monitoring (UptimeRobot)
- [ ] Security audit
- [ ] GDPR/CCPA compliance review
- [ ] Apple Developer Account ($99/yr) for iOS app
- [ ] Freemium tier system (Free/Pro/Family)

## Fitbit History Backfill

`POST /api/profiles/:id/fitbit-backfill` pulls 90 days of steps + weight + body fat in one shot and upserts into `daily_steps` / `body_metrics`. BMI is recomputed from `profiles.height_inches`. The same routine fires automatically (fire-and-forget) inside the OAuth `/callback` once per profile, gated by `profile_data.settings.fitbit_backfilled`. Manual trigger: Settings → Data & Readiness → "Import full history from Fitbit (90 days)".

### Full-History Backfill (2026-07-17)

`POST /api/debug/backfill-wearable-history/:userId?start_date=&end_date=&max_calls=N&metrics=sleep,hrv,rhr,steps,weight,bodyfat` — pulls full Fitbit history (built for ~2 years of pre-app data before the Sept 2026 API shutdown, and doubles as the mechanism for filling the confirmed mid-June→mid-July 2026 `daily_sleep` gap from dead tokens during an outage) via Fitbit's RANGE endpoints exclusively — never per-day calls. Admin-gated exactly like `backfill-wearable-hr`. Writes into the existing `daily_sleep`/`daily_steps`/`body_metrics` tables via the existing upsert helpers — no schema changes; `UNIQUE(profile_id,date)` makes re-runs idempotent.

- **`max_calls` defaults to 100, NOT Infinity** — a deliberate deviation from `backfill-wearable-hr`'s `Infinity` default, an accidental-unbounded-call guard against a slow/large date range eating the whole 150/hr Fitbit budget in one call. All Fitbit calls across all six metrics share one budget and one ~1req/sec throttle.
- **Verified max span per metric** (checked against Fitbit's own docs, not assumed) and chunked one day short as a safety margin: sleep 100d→99, HRV 30d→29, steps 1095d→1094, weight 31d→30, body fat 30d→29. **RHR is the exception** — see the quirk below.
- **Never overwrites better data.** `daily_sleep` is fed by three independent Fitbit endpoints (sleep detail, HRV, RHR) but is one row per date — `upsertDailySleep()` always writes all 8 fields, so all three sources are merged into a single payload before one upsert call per date. Rules:
  - **Sleep detail** (hours/score/deep/rem/light/wake): an existing row with `deep_minutes` already set wins outright over a range re-pull (real stage data beats anything the backfill could offer); otherwise the new fetch is written and `estimateSleepScore()` recomputes the score server-side. Hours-only fallback rows (older Fitbit devices without stage data) are stored as-is.
  - **HRV / RHR**: independent gap-fill — each only writes when the existing row has that field null.
  - **Steps**: existing wins if a steps count is already present (preserves `calories`/`distance_miles`/`floors` already on that row, which the range steps endpoint doesn't carry); otherwise writes steps and carries over whatever `calories`/`distance_miles`/`floors` the existing row (if any) already had.
  - **Weight / body fat**: independent gap-fill, same shape as HRV/RHR. Every `body_metrics` write resolves an "effective weight" (existing-or-new) before calling `upsertBodyMetrics()`, even on a body-fat-only write — `upsertBodyMetrics()` recomputes `bmi` from whatever `weight_lbs` is *in* the payload, so omitting it on a body-fat-only call would send `bmi:null` and clobber an existing BMI.
- **`?metrics=`** scopes which of the six fetch loops run (comma-separated: `sleep,hrv,rhr,steps,weight,bodyfat`; defaults to all six). Lets a fix or gap-fill be re-applied to one metric without re-fetching (and discarding) the other five — only the FETCH loops are gated; the merge/write logic already no-ops correctly on an empty per-metric map, so nothing else needs to change for a scoped run to be safe.
- **RHR undocumented quirk (found live 2026-07-17)**: Fitbit's docs say `/1/user/-/activities/heart/date/[start]/[end].json` supports up to a 365-day range, and it does return 200 at that span — but `value.restingHeartRate` is silently omitted from every entry once the range gets long. A full 2-year backfill chunked at the (then-)364-day max wrote 0 of 677 possible RHR values; the identical merge code, re-run over a 32-day verification window, wrote 25/25. `heartRateZones` still comes back fine at any span — it's specifically `restingHeartRate` that's span-limited, and it isn't documented anywhere. Fixed by chunking RHR to 29 days, same as HRV (which shares a documented 30-day limit — the working theory is Fitbit applies the same internal window to both). A permanent per-chunk diagnostic log line (`[HistoryBackfill] RHR chunk [start]..[end]: N days returned, M carrying restingHeartRate`) now makes any future drift visible immediately instead of silently writing zero rows again.
- Response shape: `{ success, profile_id, range, api_calls_used, max_calls, budget_hit, sleep:{written,skipped,empty,resume_from}, hrv:{...}, rhr:{...}, steps:{written,skipped,empty,resume_from}, weight:{...}, bodyfat:{...} }` — a non-null `resume_from` on a metric hit by the budget tells you exactly where to restart that metric.

**Verified live** (profile 1, production): a 32-day verification window (2026-06-15→2026-07-16, overlapping the known `daily_sleep` gap) wrote sleep/HRV/RHR into every previously-empty date and left existing rows untouched. The full 2-year backfill (2024-07-17→2026-07-16) then ran: sleep 675 / HRV 674 / steps 653 rows written, 81/100 calls used, zero failed chunks — except RHR, which wrote 0/677 due to the chunking quirk above (fixed same session; a `?metrics=rhr` re-run over the same range picks up the missed values cheaply, ~24 calls at the corrected 29-day chunk size). Weight/body-fat wrote nothing — Fitbit's `/body/log/weight`/`/body/log/fat` scope has been 403ing since the 2026-05-17 reconsent gap (ROADMAP.md §6) and still is post-2026-07-14 reconsent; deliberately not chased further since the account has never logged weight via Fitbit, so there's nothing to backfill either way.

## Re-Log Past Workouts

`GET /api/workouts/:id/full` returns the workout row + every exercise extracted from it. Client `reLogWorkout(workoutId)` builds notes lines from the exercises array (`name: SxR @ Wlbs`, plus distance/duration when present), prepends the original free-text notes, opens the log modal pre-filled with type+notes, and shows a re-log banner inside the modal. Surfaces:
- 🔄 Re-log button on every History list card
- Today tab "Recent Workouts" card (top 3, newest first) sits above the AI rec card

## Workout Templates

Saved routines (`workout_templates` table). User flow:
- Save: log modal has a "Save as Template" prompt; tapping it shows an inline name input. POST creates a template with the current notes/type.
- Use: ▶ Use button on Today tab "My Templates" or Profile tab manager opens log modal pre-filled with `notes_template`/`type`. Use_count increments on Use.
- Manage: Profile tab "My Templates" card lists every template with Use / Rename / Delete and shows `Used N times`.

Endpoints: `GET/POST /api/profiles/:id/templates`, `PATCH/DELETE /api/templates/:id`.

## Unmatched Fitbit Activities (Today-tab card)

Replaces the legacy `fitbit_pending_imports` card. A card per unmatched Fitbit activity from the last 7 days renders between the body-metrics card and the check-in card (`#unmatched-fitbit-card`). Routes through the provider-agnostic wearable adapter — the actions reuse the `/api/wearables/merge` and `/api/wearables/import` endpoints.

**Server** — `GET /api/profiles/:id/unmatched-fitbit` calls `adapter.fetchActivities(token, 7-days-ago, today)`, then drops any activity that is (a) already linked to a workout (`workouts.wearable_activity_id`), (b) in `rejected_wearable_matches` for ANY workout of this profile (filtered by `profile_id` only, not `workout_id` — a rejection here is global), or (c) in `profiles.dismissed_fitbit_activities`. For each surviving activity it attaches `same_day_workouts` — this profile's completed, not-yet-linked workouts on that date. Returns `{activities:[…]}`; degrades to `{activities:[]}` (no token) or `{activities:[], error:"fitbit_unavailable"}` rather than 500ing.

**Client** (`public/index.html`) — `loadUnmatchedFitbit()` fetches once per day, caching in `localStorage.ac_unmatched_fitbit` (`{date, activities}`); a same-day cache renders instantly without a fetch. Called from `bootApp()` (cached render) and from the Fitbit-sync success path (`after Fitbit data loads`); an `_ufInFlight` guard prevents a double-fetch. `invalidateUnmatchedFitbit()` clears the cache and refetches; it fires after a workout is **saved** (`saveWorkoutToSupabase`), **merged**, or **rejected** (the `wm-modal` link/keep-separate paths). Per-card actions:
- **Match to [workout.type]** (shown per same-day workout, max 2) → `POST /api/wearables/merge/:id` with `{workout_id, provider:"fitbit", wearable_activity_id:"fitbit:<id>", list_activity}`; toast "Fitbit data linked to [type] ✓", reload workouts.
- **Import as Workout / Import as New** → `POST /api/wearables/import/:id` with `{provider, wearable_activity_id, list_activity}`; toast "Imported as workout ✓", reload workouts.
- **Dismiss** → `POST /api/profiles/:id/dismiss-fitbit-activity` `{provider_activity_id}`; removes the card silently (no toast). 

All three remove the card locally first (`ufRemoveActivity` splices the array + updates the cache + re-renders); the section disappears when empty. A subtle skeleton (`renderUnmatchedFitbitSkeleton`, `@keyframes pulse`) shows while fetching; an empty/errored fetch renders nothing. Past-day navigation hides the card (`renderDayView`).

**`fitbit_pending_imports` fully removed 2026-07-17** — this card replaced it (2026-05-22) and now the code that used to maintain it is gone too: `diffAndQueueFitbitImports()`, `GET /api/profiles/:id/fitbit-pending-imports`, and `POST /api/profiles/:id/fitbit-import` were all deleted from `server.js` (see "Tech Debt Batch" below), along with the now-orphaned `mapFitbitActivityType()`/`FITBIT_ACTIVITY_TYPE_MAP` helper. The client-side `loadFitbitPendingImports`/`renderFitbitImportPrompts`/`confirmFitbitImport`/`dismissFitbitImport` functions had already been removed earlier. The `profiles.fitbit_pending_imports` column itself is a pending manual migration, not yet dropped. The save-time auto-import `wm-modal` prompt (see Auto-Import on Workout Save) is unaffected and still useful for immediate post-save matching.

## Past-Day Navigation (Fixed)

`renderDayView()` now fetches `/api/profiles/:id/daily?date=YYYY-MM-DD` for past dates and replaces the readiness-card slot with that day's biometric snapshot (readiness score + steps + weight if logged). Results cached client-side per date in `_pastDayCache` so back-and-forth navigation doesn't re-fetch. Daily-steps history loader bumped from 30 → 90 days so the History tab steps pill works on older workout cards.

## Exercise Extraction Hardening

The `/api/profiles/:id/extract-exercises` prompt has explicit data-integrity rules: never invent or assume weights/reps/sets/distances/durations not in the raw text; if ambiguous, omit (null); never carry weights between exercises; never guess from words like "heavy"/"light"; raw_text must be the literal substring. Companion admin endpoints to clean up bad rows:
- `GET /api/profiles/:id/exercises/audit?name=...&min_weight=...&max_weight=...`
- `DELETE /api/profiles/:id/exercises/:exerciseId`

## Wearable Adapter System (provider-agnostic)

All wearable workout-matching flows route through a provider abstraction layer in `wearables/`. New providers are added by dropping a file in that directory — no `server.js` changes needed.

**Files**:
- `wearables/base.js` — adapter contract (JSDoc) + `KEYWORD_MAP` + `matchWearableToManual()` scoring (+40 within 15min, +20 within 30min, +30 keyword category match, threshold ≥40).
- `wearables/fitbit.js` — full implementation. OAuth 2.0, `/1/user/-/activities/list.json` pagination, per-activity detail via `/1/user/-/activities/{logId}.json`, refresh against `/oauth2/token`.
- `wearables/google_health.js` — **full implementation**: Google Health API v4 (cloud REST at `health.googleapis.com/v4`, the Fitbit Web API successor). OAuth 2.0 + auto-refresh, `fetchActivities` / `fetchActivityDetail` / `fetchDailyData` (HRV/RHR/sleep stages/steps/AZM/weight) / `getIdentity`. See "Wearable Support" → Google Health.
- `wearables/{apple_health,samsung_health,garmin}.js` — stubs with documented endpoints + integration strategy (HealthKit companion-app pattern, Garmin OAuth 1.0a notes).
- `wearables/index.js` — `getProviderAdapter(provider)` factory, `listProviders()`, `namespacedId(provider, id)` helper.

**NormalizedActivity shape** (every provider maps to this): `{ provider, provider_activity_id, date, activity_type, duration_minutes, steps, calories, avg_hr, peak_hr, active_zone_minutes, zones, raw }`. The `raw` field preserves the original provider payload for future use.

**Endpoints** (all in `server.js`, routed through the factory):
- `GET  /api/wearables/providers/:userId` — per-provider `{provider, label, connected, needs_reconnect, status, last_synced_at}`. `status` is `connected|needs_reconnect|disconnected`; `connected` reflects real token health (row exists AND last refresh didn't hit `invalid_grant`), not just row existence. See "Connection Health & Refresh Serialization" below.
- `POST /api/wearables/connect/:provider`  — returns `auth_url` for OAuth
- `POST /api/wearables/disconnect/:provider`
- `GET  /api/wearables/sync-backlog/:userId?provider=&start_date=&end_date=` — returns `{ matched, unmatched, already_synced }`
- `POST /api/wearables/merge/:userId`  — attach wearable session to an existing workout
- `POST /api/wearables/reject/:userId` — record rejection + create standalone wearable workout
- `POST /api/wearables/import/:userId` — create standalone workout from an unmatched session
- `POST /api/debug/backfill-wearable-hr/:userId?provider=fitbit[&max_intraday=N]` — two-pass HR repair (see HR-loss fix below); gated by `ADMIN_SECRET` (query `secret=` or `x-admin-secret` header) when that env var is set. Pass 1 fills `avg_hr`/`calories`/`zones` from the list endpoint; pass 2 derives `peak_hr` via the same priority chain as `fetchActivityDetail` — (a) reuse stored `heart_rate_samples` (free), (b) TCX `MaximumHeartRateBpm` (Server-type apps, needs only the activity id), (c) intraday HR max bpm (Personal-type apps, needs the time window). Provider calls (TCX + intraday) are throttled ~1/sec and non-fatal per session. `?max_intraday=N` caps total provider calls per run (idempotent — re-run to continue). Returns `{ checked, updated, skipped, errors, updated_peak_hr, peak_hr_from_samples, peak_hr_from_tcx, peak_hr_from_intraday, peak_hr_skipped, peak_hr_errors }` — the `peak_hr_from_*` split shows which path is working.

**HR-loss fix (list-vs-detail)**: Fitbit's `/activities/{logId}.json` detail endpoint (used by `fetchActivityDetail`) returns a payload **without `averageHeartRate`**, while the list endpoint (`fetchActivities`) carries it. Originally merge/import stored only the detail result, so `wearable_data.avg_hr` was null for synced sessions. Fix: the sync-backlog response already includes the full normalized list `activity` per matched/unmatched item; the client passes it back as `list_activity` on merge/reject/import, and `mergeListHr(adapter, detail, listActivity)` fills the HR fields (`avg_hr, peak_hr, zones, calories, active_zone_minutes`) the detail dropped — **detail wins for fields it already has**. `listActivity` may be already-normalized (sync-backlog) or a raw provider entry (the adapter's optional exported `normalize()` handles that). Bulk-action passes `activity` through too. The backfill endpoint repairs rows synced before this fix: pass 1 re-reads `avg_hr` from the list endpoint for any `wearable_activity_id IS NOT NULL` row whose `wearable_data.avg_hr` is null. Because the list endpoint carries `averageHeartRate` but **not `maxHeartRate`**, `peak_hr` can never be filled from it. Two peak sources exist: (1) on the forward sync path, `fetchActivityDetail` tries the activity's **TCX export** (`/1/user/-/activities/{logId}.tcx`) and parses `MaximumHeartRateBpm` — available to Server-type apps even when intraday is denied — then falls back to intraday HR samples (Personal-type apps); (2) the backfill endpoint's pass 2 derives `peak_hr` from intraday samples (reusing stored `heart_rate_samples` for free, else fetching the intraday window). The analytics read (`wearableMetrics`) also derives `peak_hr` from `heart_rate_samples` on the fly when the explicit field is absent, and as a last resort estimates a peak-HR **floor** from the highest HR zone the session recorded time in (Fitbit zone floors: peak 185 / vigorous 163 / moderate 108 bpm). Zone-estimated values are flagged `peak_hr_est=true` and surfaced through `sessionMetrics` → the activity-stats response (per-session `recent_sessions`, per-activity, and `overall`); the analytics UI (`anFmtPeak`) renders them as e.g. `185+ bpm (est.)`. On a tie a measured peak beats an estimate when aggregating the max.

**Token storage**: `wearable_connections (profile_id, provider, access_token, refresh_token, token_expires_at, last_synced_at, needs_reconnect)`. `getValidWearableToken()` auto-refreshes expired tokens; refresh failure throws with `code: "RECONNECT_REQUIRED"` mapped to HTTP 401 so the UI can prompt reconnection.

## Connection Health & Refresh Serialization (2026-07-17, session #19)

Fixes the "connected but no data" failure mode: a dead OAuth token (`invalid_grant`) while the UI still showed "connected", because the providers endpoint checked only row existence.

- **Refresh serialization** — OAuth refresh tokens are single-use (Fitbit and Google Health rotate the refresh token on every exchange). `getValidProfileToken`/`getValidWearableToken` are called from several endpoints (`/daily`, `/unmatched-fitbit`, `sync-backlog`, `life-os-summary`, backfill) that fire concurrently on app boot; two callers that both saw an expired token could each POST the same refresh token, and the loser's save would clobber the winner's fresh token with a now-dead one — the suspected cause of the 2026-07-17 Fitbit token death. `withRefreshLock(key, fn)` (+ the `_refreshLocks` map, keyed `provider:profileId`) makes concurrent callers await ONE in-flight refresh. It wraps `refreshProfileToken` (which now delegates to `_doRefreshProfileToken`) for Fitbit and the refresh+save block inside `getValidWearableToken` for Google Health. Valid-token reads are never serialized — only the actual refresh. **In-process only** — correct for the single Render web instance; a multi-instance deploy would need a DB/row lock.
- **`needs_reconnect` flag** (`wearable_connections.needs_reconnect` boolean, migration `2026-07-17_wearable_needs_reconnect.sql`, **run manually**) — set `true` on a definitive `invalid_grant` (Fitbit `_doRefreshProfileToken`) / `RECONNECT_REQUIRED` (Google Health `getValidWearableToken`); cleared to `false` on every successful token write (`saveProfileTokens`, `saveWearableTokens`) and thus on both OAuth callbacks. Set **only** on a real auth failure, never a transient network blip, so `connected` doesn't flap. Written via `setNeedsReconnect()` — **best-effort, never throws, never blocks a token save** (a failure, including the column not existing pre-migration, is logged and swallowed). It's a separate PATCH, deliberately NOT folded into the token-write upsert bodies, so a missing column can't break the token save itself.
- **Providers endpoint** derives `status` (`connected|needs_reconnect|disconnected`) and returns `connected: status==='connected'` plus `needs_reconnect`. It selects `needs_reconnect` but **falls back to a column-less select** if the response isn't an array (pre-migration), so the endpoint never breaks in the deploy/migration ordering window — every row just reads as healthy until the migration runs. Both existing consumers (`wsFetchProviders` sync modal, `_applyGHBanner` reconsent banner) keep reading `.connected` and now correctly drop a dead connection.
- **Settings → Account "Connected Devices"** (`public/index.html`): `loadConnectedDevices()` populates `#connected-devices-list` async after the settings HTML injects (same pattern as the GH banner), rendering Fitbit + Google Health rows from the providers endpoint with real status. `renderConnectedDeviceRow()` shows CONNECTED (green) / amber "&#9888; RECONNECT REQUIRED" / NOT CONNECTED, with `reconnectProvider()` (reuses `POST /api/wearables/connect/:provider`, uniform for every provider incl. Fitbit) and `disconnectProvider()` (confirm → existing `POST /api/wearables/disconnect/:provider` → reload the list). Additive JS, inline styles only, no global class changes. The old block was a single hardcoded Fitbit row driven by `profile_data.fitbit`.

**Dedupe**: `workouts.wearable_activity_id` is unique (when not null) and stored in `"provider:id"` form so the same numeric id from two providers cannot collide. `rejected_wearable_matches` keeps backlog sync idempotent — rejected pairings don't re-appear on subsequent runs.

**Coexistence with legacy Fitbit code**: `profiles.fitbit_access_token`/`refresh_token`/`expires_at` columns and the `buildDailyData` / `runFitbitBackfill` flows are untouched. Token writes are mirrored to both stores. The legacy auto-import queue path (`diffAndQueueFitbitImports` + `/api/profiles/:id/fitbit-pending-imports` + `/api/profiles/:id/fitbit-import`) was fully removed 2026-07-17 (see "Tech Debt Batch" below) — the Today-tab "Unmatched Fitbit Activities" card replaced it back on 2026-05-22. The new explicit `sync-backlog` path remains the bulk-review flow.

**Schema**: see `migrations/2026-05-19_wearables.sql`.

## Google Health API — Key Implementation Notes

Non-obvious gotchas that cost real debugging time on the Google Health API v4 integration (`wearables/google_health.js`, the cloud REST Fitbit successor at `health.googleapis.com/v4/`):

- **Daily types (HRV, RHR) only support `list` and `:reconcile` — NOT `dailyRollUp`, and they do NOT accept `=` or range filters.** List with `?page_size=1` to get the most recent daily record, then verify its date matches the requested day before using it.
- **`dailyRollUp` responses come back in `rollupDataPoints`, not `dataPoints`** (steps + AZM both use `dailyRollUp`).
- **Steps field is `countSum`, not `count`:** `rollupDataPoints[0].steps.countSum`.
- **AZM has three separate per-zone fields** — `sumInCardioHeartZone`, `sumInPeakHeartZone`, `sumInFatBurnHeartZone` — summed across all `rollupDataPoints`. There is no single "total" field. (`fetchDailyData` returns `{peak, cardio, fatBurn, total}`; the daily handler maps these to `prevZones`.)
- **Sleep:** use `:reconcile` with `dataSourceFamily=users/me/dataSourceFamilies/google-wearables` and a `sleep.interval.civil_end_time` filter. Pick the main sleep via `metadata.main === true` (and `nap !== true`); fall back to the longest by `minutesAsleep`.
- **`redirect_uri` at token exchange must EXACTLY match the authorize URL.** Because `POST /api/wearables/connect/:provider` builds the redirect as `/api/wearables/callback/:provider`, **both** `/api/wearables/callback/google_health` AND `/callback/google_health` must be registered in the Google Cloud Console. The callback handler derives `redirect_uri` from `req.path` so either route is self-consistent.
- **Do NOT add `include_granted_scopes=true`** to the auth URL — it breaks Google Health API auth.
- **Google sometimes omits `refresh_token` on a token refresh** — always keep the old refresh token as a fallback (`refreshToken` does this).
- **Weight is in grams (`weightGrams`)** — divide by `453.592` for lbs.
- **Distance is in millimetres throughout the API** (`distanceMillimeters`).
- **Use the local date, not UTC.** The daily handler derives "today" with `getFullYear`/`getMonth`/`getDate` (inline IIFE), NOT the module's UTC-based `dateStr()`, which can roll to the wrong day in negative-offset timezones in the evening.

## Google Health Failure Propagation + Observability (2026-07-20, session #31)

**The problem: a dead Google Health connection and a working one were indistinguishable from
outside.** `fetchDailyData()` runs its six metric legs (hrv, rhr, sleep, steps, azm, weight)
through a `Promise.allSettled` (`wearables/google_health.js`). Every rejection — **including a
401** — was discarded and became `null` for that metric, with zero logging. `/daily`'s `hasData`
gate then reported the whole thing as "no data, falling through to Fitbit", which is byte-identical
to a genuinely quiet day. Two consequences:
1. **`needs_reconnect` could never become `true` for `google_health`.** The 401 never propagated
   out of `fetchDailyData()`, so it never reached `getValidWearableToken()`'s catch, so
   `setNeedsReconnect()` was unreachable **by construction** — no matter how dead the connection.
2. The `/daily` GH token step was a **fully empty catch**, so an absent or dead connection skipped
   the entire branch leaving no trace whatsoever.

This is the same bug class as the Fitbit weight/body-fat 403 that hid for two months behind the
2026-06-18 non-fatal hardening pass (ROADMAP §6) — a graceful-degradation guard that degrades
*silently*.

**Error classification (`classifyGhError`).** Every error is tagged with two booleans:
- `auth_failure` — the **token** was rejected (401). Definitive.
- `transient` — a blip (timeout / 429 / 5xx / network). Must **never** drive `needs_reconnect`.

A **403 is deliberately neither**: the token is valid, the *scope* is not. That is exactly the
Fitbit weight/body-fat shape, where prompting a reconnect would have fixed nothing.

**Per-leg logging + the auth verdict.** Each rejected leg logs metric + code + HTTP status +
transient flag, followed by a summary line. The adapter returns an additive
`_diagnostics: { date, legs[], fulfilled_count, rejected_count, auth_failure }` on its normal
return value — **inert to existing consumers**, which read only the named metric fields, and it
never reaches the client because `/daily` builds its response field-by-field.
`auth_failure` is true **only when a leg was rejected with 401 AND zero legs fulfilled**. A lone
401 alongside successes is not a dead connection; requiring both keeps the flag from flapping,
the same bar the Fitbit `invalid_grant` path already holds itself to. `/daily` fires
`setNeedsReconnect(id, "google_health", true)` on that verdict, fire-and-forget, without changing
the Fitbit fallback at all. **Verified against 5 mocked scenarios**: all-401 → true; all-403,
1×401+5 OK, all-503, all-OK → false.

**Per-request timeout.** GH fetches previously had **no `AbortController` at all** — the only
bound was `/daily`'s outer `withTimeout(8000)`, which collapses one hung leg into an opaque
whole-call timeout. `ghFetch()` now applies `GH_REQUEST_TIMEOUT_MS = 7000` per request,
deliberately *under* the outer cap so a stall surfaces as a metric-attributable `TIMEOUT`.

**`GET /api/debug/google-health-probe/:userId`** (admin-gated) answers the question `/daily`
structurally cannot: is GH actually executing? Returns token state (`served_from:
cache | refreshed | expired_not_refreshed | refresh_failed`), the **unswallowed** per-leg outcome
with real HTTP status and message, the parsed values, and `would_serve_google_health` (mirroring
`/daily`'s own `hasData` gate). **Read-only by default** — an expired token is *reported*, not
refreshed, because refreshing writes. `allow_refresh=1` opts into the real refresh through the
app's own `getValidWearableToken()` path; that is the only writing option, and a failed refresh
will legitimately set `needs_reconnect`.

**What it proved (2026-07-20):** Google Health is **alive and is the serving provider** for
profile 1's biometrics — all 6 legs fulfilled, `/daily` returning `source:google_health` with
hrv 62.4 / rhr 57 / steps 609 / sleep 8.38h. The signals that suggested otherwise all had other
causes; see ROADMAP §5 and the session #31 banner.

**`last_synced_at` semantics.** Its only writer was `stampLastSynced()`, called only from
`computeWearableBacklog()` — i.e. it meant *"someone opened the Wearable Sync bulk-review modal
and the activity fetch succeeded"*, **not** "data synced". `/daily` never touched it, which is why
GH read `null` while GH was serving every day. It is now also stamped on a successful `/daily`
serve for both providers. Gate-checked first: **nothing reads it as a logic input** (only
`loadWearableTokens` carries it and the providers endpoint surfaces it), and the Settings UI never
rendered it at all — so no UI change was made.

## Provenance: threading the real provider into `source` (2026-07-20, session #31)

`daily_sleep.source` and `daily_steps.source` were **hardcoded `"fitbit"` on every write**, so
every Google-Health-sourced row was mislabeled. Not theoretical: `daily_steps` for 2026-07-20 read
`steps=609, source="fitbit"` while the GH probe returned exactly 609 **from Google Health**.

**The pattern (copied from `upsertBodyMetrics`, which was already correct — not reinvented):**
`source: summary.source || "fitbit"`. Every caller that passes no `source` still writes `"fitbit"`,
so the default path is byte-identical to before. The GH `/daily` call sites pass the real provider.

**Which provider labels a mixed row.** When the session #23 Fitbit sleep fallback fires inside the
GH branch, the row holds **Fitbit sleep alongside GH HRV/RHR**. The row is labeled by its **sleep**
source (`ghSleepProvider`), because the column lives on `daily_sleep` and the consumer question is
where the *sleep* came from. Deliberately **not** a second column.

**`upsertDailyVitals()` stamps `source` on the INSERT path only, never the PATCH.** A vitals-only
write must not relabel an existing row whose sleep came from a different provider. On a fresh row
there is no sleep yet, so the vitals provider is the only honest value available.

**Constraint state was verified live before writing a new value**, not assumed from the committed
DDL — this project has a history of constraints added by hand outside migrations
(`chat_proposals.type`, found only via a live `23514`). A one-time admin probe
(`GET /api/debug/source-constraint-probe/:userId`, since **removed** in the session #31 hygiene
pass) wrote `source:"google_health"` to throwaway date `1970-01-01` in both tables and deleted the
rows again. Result: **both accept it, no CHECK constraint, no migration needed.** The endpoint was
deleted once that verification was done — it was a gate, not ongoing infra.

**Loud failure (`logProvenanceWriteFailure`).** These upserts are fire-and-forget, so a rejected
write would lose the row behind a generic one-line catch — the `duration_minutes` data-loss shape
(session #30). A constraint rejection (`23514` / `22P02` / check-constraint text) is now called out
by name with an explicit `ROW LOST` line so it can never be misread as "no data today".

**Historical rows cannot be corrected.** Nothing recorded which provider wrote them, so no backfill
is derivable — provenance is **forward-looking only** (ROADMAP §6). Nothing in the codebase branches
on these columns today (confirmed by grep across `server.js` and `public/index.html`), so the value
change is behaviorally inert; it exists to make provenance *measurable*.

## Google Health Sleep Persistence — Decoupling + Fitbit Fallback (2026-07-17, session #23)

Fixes "everything lands except sleep" after the GH reconnect. Root cause was **not** scope/field/parse (GH sleep parses fine) and **not** timezone (profile 1's `profiles.timezone` is `America/Chicago`, verified — the strict `civil_end_time` window uses the right local date). It was `ghData.sleep` coming back null on morning opens (GH reconciles last night's wearable sleep session later than daily HRV/RHR/steps), combined with two code facts in the GH `/daily` branch:

- **HRV/RHR were persisted ONLY inside `if (ghData.sleep)`** (via `upsertDailySleep`, which writes sleep+hrv+rhr as one row) — so a sleep-less fetch dropped HRV/RHR from `daily_sleep` too, while steps (independent) still landed.
- **The `hasData` gate served GH wholesale and never fell back to Fitbit per-metric** — a GH-has-everything-but-sleep morning never tried Fitbit, which is often ahead on last night's sleep.

**Fix (GH branch only):**
1. **Per-metric Fitbit sleep fallback** — when `!ghData.sleep`, fetch `getValidProfileToken()` + `fetchFitbitSleepForDate(token, ghDate)` (a lean one-date Fitbit sleep read returning the GH sleep shape) and, if it yields sleep, assign it to `ghData.sleep` so the existing score/upsert/response all use it with no further changes. **Bounded + non-fatal:** wrapped in `withTimeout(…, 6000)` inside a `try/catch`; `withTimeout` *rejects* on timeout, so a slow Fitbit lands in the catch like any error — `/daily` never hangs. `fetchFitbitSleepForDate` never throws (internal failures → null), so the raced inner promise can't leave an orphan rejection. Only fires when GH sleep is null, so it adds no latency to the common path.
2. **Decouple HRV/RHR from sleep** — the sleep-upsert `if` now has an `else if (ghData.hrv != null || ghData.rhr != null)` that calls **`upsertDailyVitals`**, persisting vitals even with no sleep. `upsertDailyVitals` is **GET-then-PATCH-or-INSERT**, not a partial merge-upsert — its PATCH body only ever holds `hrv`/`rhr`, so it is **clobber-safe by construction** (can never null an existing sleep row's columns), without depending on PostgREST partial-merge semantics. Verified by `POST /api/debug/test-vitals-upsert/:userId` (admin-gated; seeds a full sleep row on a throwaway date `1970-01-01`, runs `upsertDailyVitals`, asserts sleep columns survive + vitals updated, then deletes the row).
3. **Timezone date-key fix skipped** — profile 1's timezone is correctly set; the lenient/widened-window change was only warranted if it were null/UTC.

Not touched: the scheduler (the durable fix — periodic re-pull after GH reconciles — tracked separately in ROADMAP §9), and `upsertDailySleep`'s hardcoded `source:"fitbit"` mislabel (even GH sleep is stored as `source:"fitbit"`; flagged in ROADMAP §9, not fixed here).

## Google Health Sleep Stages Shape — /daily Response Contract (2026-07-17, session #24)

Fixes "sleep card blank + readiness stuck at 1/100" after the GH reconnect. **The `/daily` response's `data.sleep.stages` MUST be the Fitbit NESTED shape** — `{ deep: { minutes: N }, rem: { minutes: N }, light: {...}, wake: {...} }` — **not** flat numbers (`{ deep: N }`). Every frontend reader keys off `stages.<stage>.minutes` (Fitbit's `levels.summary` shape): `renderReadiness()` (sleep score + stage pills), `computeReadiness()` (deep-sleep term in the readiness formula), and the AI-prompt builder. The GH branch originally emitted **bare numbers**, so `stages.deep.minutes` was `undefined` → sleep score computed `null`, the stage-detail block was skipped (blank card), and deep sleep was read as 0 (understating readiness → the cached 1/100). **This was masked for weeks** because GH's token was dead and `/daily` fell through to Fitbit (object shape); the session #19 reconnect made GH the serving provider and exposed it. Fix: the GH response builder now wraps each stage as `{ minutes: ghData.sleep.<stage>_minutes }`. `thirtyDayAvgMinutes` is absent for GH, which the frontend already handles as optional (`|| '?'` / `|| 0`). **Not** caused by the session #23 persistence work — that never touched `data.sleep.stages`.

- **Client cache bust**: `ac_cache` (the wearable-data cache, `localStorage`) stored the broken GH-shaped payload, so the fix would stay hidden behind a still-valid cache (`isCacheValid` only checks date + 2h age). Added a schema version — `CACHE_VERSION` (bumped to **2**); `isCacheValid` rejects a `fitData` cache whose `v` !== current, and the save stamps `v`. On the first load of the new JS, the stale cache is discarded and `/daily` is refetched with the corrected shape. Manual-checkin caches are unversioned/unaffected. **No service worker exists**, so a normal reload picks up the new JS (a hard refresh is only needed if the browser HTTP-cached `index.html`).
- **Readiness re-stamp is automatic, same root cause**: once the shape is fixed and the cache busts, `computeReadiness()` reads deep sleep correctly (~77 instead of 1), `renderReadiness()` shows it immediately (it uses the live client-computed score), and `maybeRegenForReadiness()` (delta 76 > 10 threshold) fires a silent regen that re-stamps the server-side `daily_recommendations_readiness`. No separate readiness code change was needed.

## Auto-Import on Workout Save

When a user saves a workout (`POST /api/workouts`), the server immediately checks whether Fitbit recorded a same-day activity that looks like the same session and, if so, returns the single best candidate so the client can **prompt** the user to link it. It never silently auto-attaches — the user always confirms. This is distinct from the daily-sync "Fitbit Workout Auto-Import" (pending-imports queue) and the explicit `sync-backlog` review UI; it's the save-time, one-candidate, prompt-on-the-spot path, and it routes through the same provider-agnostic merge/reject endpoints.

**Server** (`findWearableMatchOnSave(profileId, workout)` in `server.js`, called from the `POST /api/workouts` handler after the insert):
1. Resolves the Fitbit token via `getValidWearableToken()`; skips silently if the user hasn't connected.
2. Calls the Fitbit adapter's `fetchActivities(token, date, date)` for the workout's date (start = end = that date).
3. Dedupes: drops activities whose namespaced `provider:id` is already on a workout for that date (`wearable_activity_id`), and any in `rejected_wearable_matches` for this workout.
4. Scores each remaining activity against the new workout with `wearables.matchWearableToManual(act, [workout])`; keeps candidates scoring ≥ 40.
5. Sorts by score desc, takes the **top 1**, and trims it to a `wearable_match` object: `{ provider, provider_activity_id, activity_type, duration_minutes, avg_hr, calories, score, start_time }`.
6. Attaches `wearable_match` onto the returned workout row. Omitted entirely (not null) when there's no candidate.

The whole lookup is **awaited but capped at 4s** via `Promise.race` (timeout → resolve null), and is fully non-fatal — any error is logged and the save response returns normally. It can never delay or break the save.

**Client** (`public/index.html`): `saveWorkoutToSupabase()` checks the POST response for `wk.wearable_match`; if present it shows `#wm-modal` after a 500ms delay (so it follows the log-modal close + card render rather than interrupting the save). The modal ("Fitbit Activity Found") summarizes the activity (type, duration, avg HR, calories, and start time when available). **Yes, Link It** → `POST /api/wearables/merge/:userId` with `{ workout_id, provider, wearable_activity_id: provider_activity_id, list_activity: <wearable_match> }`, then a "Fitbit data linked ✓" toast and `loadWorkouts()` → re-render to surface the wearable badge + enriched stats. **No, Keep Separate** → `POST /api/wearables/reject/:userId` (same payload) plus **`create_standalone: false`**, which records the rejection only and closes the modal silently. The merge/reject calls reuse the exact contract of the wearable-sync review UI (`wsCardAction`) — note the endpoints take `wearable_activity_id`, not `activity_id`.

**`create_standalone` on `/api/wearables/reject/:userId`**: by default reject ALSO creates a standalone wearable workout (so the session survives as "a separate workout"); this is the behavior the sync-backlog review UI and bulk `skip_all` rely on, and they don't send the field. The auto-import-on-save prompt sends `create_standalone: false` so a "keep separate" answer leaves the manual workout alone and does NOT add a second Fitbit-sourced workout to the day — only the `rejected_wearable_matches` row is written. `performReject(...)` skips standalone creation only on an explicit `=== false`.

## Wearable Sync Bulk-Review Modal — Provider Picker (2026-07-16)

Closes ROADMAP.md §7 priority 6. The bulk-review modal (`#ws-overlay`, `openWearableSync()`, `wsState`) was hardcoded to `provider:'fitbit'`; the `sync-backlog` endpoint it drives was already provider-agnostic. **UI-only change** — no backend edits, no new endpoints, no new deps. `sync-backlog` and the merge/reject/import action functions (`wsCardAction` → `POST /api/wearables/merge|reject|import/:userId`) were already reading `wsState.provider` generically and needed zero changes; provider selection only decides what value that variable holds before those calls fire.

**`wsFetchProviders()`** — new, called from `openWearableSync()` in place of the old direct `wsFetchActivityTypes()` call. Reads `GET /api/wearables/providers/:userId` (the same endpoint the Google Health reconsent banner already uses — no new endpoint), filters to `connected:true` only, and sets `wsState.provider`: Google Health if connected, else Fitbit, else the first connected provider, else leaves the pre-existing `'fitbit'` default (matches prior behavior for a never-connected account — `sync-backlog` still 401s with `RECONNECT_REQUIRED` exactly as before). Chains into `wsFetchActivityTypes()` once resolved, so activity types load for the *correct* provider on first render instead of a stale default.

**`wsRenderProviderPicker()`** — renders into a dedicated `#ws-provider-picker` div inside `wsRenderConfig()` (independently targeted, same pattern as `#ws-type-list`). Shows one pill per connected provider (label from the providers endpoint, not hardcoded); **skipped entirely when 0 or 1 providers are connected** — nothing to choose, matches how the modal looked before this feature for the common single-provider case. `wsSelectProvider(provider)` swaps `wsState.provider`, clears `activityTypes`/`selectedTypes`, re-renders just the picker pills, and re-fetches activity types for the new provider — mirrors `wsOnDateChange()`'s existing "update state, refetch types" shape.

**Provider-aware labels** — `wsProviderLabel()` (looks up the label from `wsState.providers`, falls back to a humanized provider id) replaces three previously-hardcoded "Fitbit" strings: the loading-step copy (`wsRenderLoading()`), the per-card source label in `renderMatchCard()` (was a static "FITBIT" `<p>`), and the reconnect step.

**Reconnect step made provider-correct (real bug this change would otherwise have shipped).** `wsRenderReconnect()` previously hardcoded a link to the **legacy single-tenant** `/auth?profile_id=` route, which only knows about Fitbit — reconnecting while reviewing a Google Health backlog would have silently kicked off the wrong OAuth flow. Fixed with a new `wsReconnect()` that POSTs to the existing provider-agnostic `POST /api/wearables/connect/:provider` (the same endpoint `connectGoogleHealth()` already uses elsewhere) and redirects to the returned `auth_url`. Not scope creep beyond "UI-only, provider selection flows through" — without this fix the picker would have been actively misleading in exactly the state it's most likely to be exercised in (a stale token).

**Verified live** (profile 1, production, both providers actually connected): `wsState.providers` correctly resolved to `['fitbit','google_health']` with `google_health` as the default (both connected); clicking the Fitbit pill correctly reloaded Fitbit-specific activity types and the "FITBIT" card label; a full Fitbit sync ran end-to-end (`GET sync-backlog` → 13 matched / 25 unmatched / 32 already-synced, real data, review step rendered correctly) — confirms the pre-existing pipeline is untouched. **Google Health's token happened to be genuinely expired on this account** — a real, unplanned test of the reconnect fix: selecting Google Health correctly surfaced "Your Google Health connection needs to be refreshed" / "Reconnect Google Health" (previously would have read "Fitbit" and linked to the wrong flow). No merge/reject/import action was actually exercised against real data (those touch the user's real workout history and the code path was already confirmed untouched by direct diff review, not worth a live destructive test). Zero new console errors.

## Tech Debt Batch — Dead Code Removal + Orphan Hardening (2026-07-17)

Report-first session against four ROADMAP.md §9 items — full audit report presented and approved before any edit landed; see git history for the report. Three migration files land in `migrations/` for manual review/execution (never run by the agent) alongside the code changes.

**Item 1 — `fitbit_pending_imports` dead code removed.** Confirmed zero call sites by grep before deleting anything: `diffAndQueueFitbitImports()`, `GET /api/profiles/:id/fitbit-pending-imports`, and `POST /api/profiles/:id/fitbit-import` had no client callers (replaced by the Unmatched Fitbit Activities card, 2026-05-22) and `diffAndQueueFitbitImports()` itself had no call site anywhere in `server.js`. Removed the whole self-contained block (`FITBIT_ACTIVITY_TYPE_MAP`/`mapFitbitActivityType()` too, used only by the deleted `/fitbit-import` handler), plus trimmed two comments in unrelated live code (`createWearableWorkout()`, `notesMetrics()`) that referenced the endpoint by name for historical-format lineage. `migrations/2026-07-17_drop_fitbit_pending_imports.sql` drops the column — **run in production 2026-07-17**, the column no longer exists.

**Item 2 — legacy text roadmap fully retired.** Confirmed no external consumer reads `profiles.roadmap`/`roadmap_updated_at`: `life-os-summary` and `PROFILE_SELECT_BASE` (the only two places that could leak it) both use explicit column lists that never included these columns, and no endpoint anywhere does a wildcard `select=*` on `profiles`. Removed `GET/POST /api/profiles/:id/roadmap` from `server.js`, and `loadRoadmap()`/`generateRoadmap()`/`renderRoadmapContent()` + the hidden `#roadmap-card` div from `public/index.html` — this was deliberately left in place during the 2026-07-16 declutter session (full retirement was out of scope then, see "Today Tab + Profile Tab Reorganization" above). `migrations/2026-07-17_drop_legacy_roadmap.sql` drops both columns — **run in production 2026-07-17**.

**Item 3 — `exercises.workout_id → workouts.id` FK, migration written AND applied.** `migrations/2026-07-17_exercises_workout_fk_cascade.sql` adds `exercises_workout_id_fkey` with `ON DELETE CASCADE`, making the orphaned-exercises bug class (fixed for `DELETE /api/workouts/:id` in session #11) structurally impossible even if a future code path deletes a workout some other way. **No code change for this item** — SQL file only, per the approved scope. The migration's own header flags that it will fail if any `exercises.workout_id` doesn't match an existing `workouts.id` — profile 1 was cleaned in session #11, and profiles 4/5/7/8 had never been checked for this specifically as of the prior doc-sync; **run in production 2026-07-17** — since `ALTER TABLE ... ADD CONSTRAINT` fails outright on any pre-existing orphan, its success is itself confirmation every profile was orphan-free at run time (the orphan report was run for each profile first, per the migration's own instructions).

**Item 4 — `DELETE /api/profiles/:id` now deletes `exercises` too.** Mirrors the session #11 fix for `DELETE /api/workouts/:id` exactly: an explicit `exercises?profile_id=eq.` delete before the existing `workouts` delete, no schema change. **Deliberately kept independent of item 3's FK, not just belt-and-suspenders** — `POST /api/profiles/:id/extract-exercises` can insert a row with `workout_id: null` when the caller doesn't supply one, and a CASCADE triggered by deleting `workouts` rows can never reach a row whose FK value is already null. So even once the item-3 migration runs, this explicit profile-scoped delete stays load-bearing for that specific case.

**Verified live** (profile 1, production, post-deploy): confirmed via direct DOM inspection that `#roadmap-card` no longer exists while `#roadmap-data-card` renders correctly (11,979 chars of real content); ran a full `POST /api/workouts` → `POST .../extract-exercises` → `DELETE /api/workouts/:id` cycle on a throwaway workout (id 104, exercise id 318) — extraction correctly created the row, delete correctly removed both the workout and its exercise row, confirming the pre-existing session #11 cascade is unaffected by this session's changes. Swept all four tabs (Today/History/Library/Profile) with zero console errors. **Not tested live**: `DELETE /api/profiles/:id` itself — would require deleting a real profile, so item 4 was verified by code review + diff comparison against the session #11 pattern only, not exercised end-to-end.

## AI Temperature Policy (2026-07-19, session #30)

**Until this session no temperature was set anywhere** — the word did not appear in `server.js`. Every AI call ran at the Anthropic Messages API default (**1.0**), including tasks where identical input must produce identical output.

**Measured, not assumed** (workout 87, same notes, same model, 4 calls per arm):

| | rows returned | distinct results |
|---|---|---|
| default (1.0) | 7, 8, 4, 8 | **3 of 4** |
| temperature 0 | 8, 8, 8, 8 | **1 of 4** (identical incl. sets/reps/durations) |

Two mechanisms, deliberately separate:

1. **`callAI(prompt, maxTokens, model, temperature)`** — optional 4th arg, **omitted from the request body entirely when not passed**, so every pre-existing caller is byte-for-byte unaffected. `extract-exercises` passes `0` (via `extractExercisesFromNotes()`).
2. **`CALL_TYPE_TEMPERATURE`** — applied in the `/api/ai` proxy with the **same authority as model selection**: server-chosen, client value logged and overridden. Currently pins `extract_exercises`, `workout_title`, `format_notes`, `goal_estimate`, `schedule_builder` → `0`. Anything absent keeps the default.

**Deliberately NOT pinned** — variety is a feature: `daily_recs` (pinning to 0 would make "🔄 Show me different options" return the identical rec every reroll), `coach_chat`, `coaching_brief`, `historical_brief`, and all roadmap/goal generators. `daily_recs`' constraint-compliance tuning (~0.6–0.7) is a Phase B decision, tracked in ROADMAP §9.

**Readiness is unaffected and always was.** `computeReadiness()` / `estimateSleepScore()` contain zero AI calls — pure Formula V3 regression arithmetic. Identical biometrics always produce an identical score; temperature is irrelevant to that path.

**`format_notes` at 0 is a partial fix for the History render bugs** (measured): output is now stable and the stray markdown `#` heading is gone, but `Notes:` / `None provided` persist because the *prompt* mandates that section. See ROADMAP §9.

## daily_recs Time Budget + Sectioned Rec Output (2026-07-20, session #31)

Fixes the complaint "a rec labeled 45 minutes contains ~12 minutes of work." Everything here is
**client-side in `public/index.html`** — `daily_recs` is the one prompt assembled in the browser,
not in `server.js`. The `/api/ai` proxy only routes it.

**Root cause: `duration` was generated, never computed.** `buildResponseShapeSpec()` hardcoded
`45/30/20` as literal values inside the JSON skeleton, and **nothing in the prompt described
per-exercise time cost** — so the model had no basis to derive a session length and emitted a
plausible number. Measured on the real cached rec: an option stating 45 min contained ~25 min of
work. The literals weren't even binding (the model returned 40/45/20 against a 45/30/20 skeleton);
they acted as an *anchor*. On an anchor day the skeleton's `45` sat in the same prompt as the
schedule's own `"MMA Class — 60 min"` with nothing reconciling them.

### The duration ladder (`resolveOptionDurations`)
Source order: **explicit user choice → schedule → default ladder `[60,45,30,15]`**. Derived
options round to 5-minute increments (a "23 min" target is false precision on a number carrying a
±15% band anyway); floor is `REC_MIN_MINUTES = 10`; 10–20 is flagged as the minimum-viable band.
`recScheduleDurations()` reads the anchor for today, else mirrors **the exact same underserved
frequency-target pick** `buildScheduleInstruction()` makes — so the stated target can never
disagree with the activity the schedule just ordered.
**Deliberate exception:** on an anchor day the anchor's own duration wins for Option 1 **even over
an explicit user choice** — a 60-minute class is 60 minutes regardless. This is what fixes the
Tue/Thu 60-vs-45 collision.
Each entry is `{minutes, low, high, minimumViable}` with `low`/`high` at ±`REC_TOLERANCE_PCT`
(0.15). Resolved **once per call** in `fetchAI()` and reused by the skeleton, the TIME BUDGET
block, and the verifier, so all three describe the same targets.

**⚠ Correction (2026-07-20, session #32) — "Auto" no longer collapses to the frequency target.**
The source order above is now **explicit user choice → anchor → default ladder** — a **non-anchor
frequency target's duration (`sd.target`) no longer drives the base.** Root cause of the bug:
`base = userLength || sd.anchor || sd.target || REC_DEFAULT_LADDER[0]` meant that under **Auto**
(`userLength = null`) on a non-anchor day, `sd.target` (e.g. 30, the underserved weekly target's
duration) won the fallback and collapsed the **whole ladder** to 30/25/15 instead of 60/45/30; the
Auto pill echoed the same collapsed base → **"Auto (30m)"**. Fixes:
- `base = userLength || sd.anchor || REC_DEFAULT_LADDER[0]` (drop `sd.target`). Auto non-anchor →
  base 60 → **60/45/30**. The **anchor pin** (`ladder[0] = sd.anchor`) and **explicit-choice**
  (`userLength` wins) are both preserved — the Tue/Thu exception above is unchanged.
- `buildScheduleInstruction()` now drops the **`— N min` stamp from the frequency-target label
  only** (`tLabel = best.target.activity`), so a non-anchor day no longer states "— 30 min" while
  the TIME BUDGET says 60 — the `§1566` "never disagree" invariant is now honored the other way for
  non-anchor days. The **anchor branch keeps its `— N min`** (a scheduled class *is* a fixed-length
  commitment). `optionOneClaimed` still detects the frequency target via its duration-less fallback
  (B12 no regress). `recScheduleDurations()` itself is unchanged — it still returns `.target` for
  `optionOneClaimed`; only its role in the *duration base* and the instruction *label* was removed.
- **Label:** `renderRecControls`'s `autoLabel` is now the static string **`"Auto"`** (dropped the
  `derived = resolveOptionDurations(...)[0]` echo). The anchor note ("Option 1 is a fixed
  commitment today (N min)…") is unchanged.
- **Settings deep-link:** a small **⚙ Settings** link in `#rec-controls`
  (`openRecLengthSettings()` → `openSettings()` + `switchSettingsTab('ai')`) opens the AI Coaching
  settings tab, reusing the existing settings overlay. There is **no editable-defaults control
  there yet** — that is queued in ROADMAP §7 item (d).

### The coarse heuristic — ONE implementation, two consumers
`estimateExerciseMinutes(line)` parses a freeform exercise string in priority order: explicit
minutes (`"Elliptical 20min"` → 20) → sets×hold (`"2x1:00"` → hold + ~1 min rest/set) →
sets×seconds → sets×reps (× `REC_MIN_PER_SET` 1.5, or `REC_MIN_PER_MOBILITY` 1.0 when
`recIsMobilityish()` matches) → fallback single block.
**Deliberately approximate.** A tempo/rest model would manufacture precision the app has no data
for. The same numbers appear verbatim in the prompt (`buildTimeBudgetContext`) and the verifier
(`verifyRecTimeBudget`) so they can never disagree.

### TIME BUDGET prompt block (`buildTimeBudgetContext`)
States each option's target + acceptable range, tells the model to **allocate the target across
sections**, restates the heuristic, and carries the intensity guidance. Framed as a **target with
tolerance, never an exact minute** ("a 53-minute session counts as 60"). Instructs "add SETS or
another movement" when the target is large rather than inflating the number.

### Post-parse verification (`verifyRecTimeBudget`)
Runs in `fetchAI()` immediately after `extractRecJSON()`. **Verify, don't trust prompt
compliance.** Primary gate is the **section sum** vs the option's band (falling back to the
heuristic estimate for a legacy/flat option). Secondary is a loose per-section sanity check —
only flags `>2x` or `<0.5x`, because a tight threshold on a coarse heuristic is noise.
**Warn-only: never blocks, never auto-regenerates.** Verified live catching the exact complaint
(Option 2 stated 45, estimated 25 → OUT OF BAND).

### Sectioned option shape
```json
{ "type":"…", "headline":"…", "duration":45, "intensity":"…",
  "goal_tags":[…], "goal_reasoning":"…", "reasoning":"…",
  "sections":[ {"label":"Warm-up","minutes":5,"exercises":["…"]},
               {"label":"Main","minutes":25,"exercises":["…","…"]},
               {"label":"Add-on","minutes":15,"exercises":["…"]} ],
  "mobility":"…" }
```
Top-level `duration` stays the source of truth for the band; sections break down how the time is
spent. **Sections are FLEXIBLE** — the prompt emits only what applies and explicitly forbids empty
sections and placeholders. Mandating a fixed set would reproduce the `format_notes`
"None provided" filler trap (ROADMAP §9), where requiring a section made the model pad it. A
20-minute recovery bike is one `Main` section. **No per-exercise times** — section granularity
only, by decision.

**Backward compatibility is handled in ONE place, not per consumer.** Recs cached before this
deploy have a flat `exercises[]` and no `sections`, and are still on the profile. Every consumer
reads through:
- `recOptionSections(o)` — returns `sections[]`, or wraps a legacy flat `exercises[]` as a single
  **unlabeled** section (so it renders with no header row, byte-identical to before).
- `recOptionExerciseStrings(o)` — every exercise string across all sections, in order.
- `recDeclaredSectionMinutes(o)` — the model's own section sum, or `null` for legacy.

**Five consumers moved together** (the JSON shape is load-bearing in all of them):
1. `buildResponseShapeSpec()` — sectioned skeleton + the flexible-section rules block.
2. `renderAI()` — renders each section as a small uppercase label + `~N MIN` header with its
   exercises beneath, **continuous numbering across sections** (it is one session). Card chrome,
   pills and colours untouched — structural change to the exercise area only.
3. `extractRecJSON()` — **no change needed**; it is generic brace-slicing + `JSON.parse`, so the
   nested shape parses as-is. Verified against a live response, not assumed.
4. `ensureAIExerciseLinks()` / `aiRecLinkCache` — collects across all sections. Exact/alias only,
   no fuzzy, no writes, a miss renders plain text (session #27 behavior preserved).
5. `verifyRecTimeBudget()` — sums across sections.

**Warm-up double-count fix.** `estimateOptionMinutes()` adds the flat `REC_WARMUP_MIN` (5) **only
when the option has no Warm-up section** (`recHasWarmupSection()`). Adding it on top of an explicit
warm-up block is why all three options flagged over-band on the first verifier run.
`estimateExercisesMinutes(list)` is the no-warm-up primitive; `estimateOptionMinutes()` also still
accepts a bare array for legacy callers.

### Length + intensity controls (`#rec-controls`) — replaces the deferred temperature approach
`recLengthChoice` (minutes or `null` = auto) and `recIntensityChoice` (`Low|Medium|High`) are
**module vars, deliberately never persisted** — a per-open choice, reset on reload, not a stored
setting. Rendered by `renderRecControls()` and mounted in `renderAI()` **directly above the
"🔄 Show me different options" button**, because that is the regenerate surface they feed.
Selecting a value re-renders the control immediately but **does not auto-regenerate** — the
athlete then taps reroll, keeping generation explicit and avoiding a surprise AI call per tap.
Intensity shapes volume/density/rest and selection **coarsely** via `recIntensityGuidance()`, not
as a numeric knob. CSS is id-scoped `#rec-controls`, no global class changes.
This is why a temperature pin is no longer needed for variety: the athlete changes a real input
rather than the model being told to be more random. Temperature must **never** go to 0 for
`daily_recs` — reroll would return an identical rec.

### Prompt length guard (`PROMPT_CHAR_BUDGET`) — was structurally unreachable
The old budget was **6000 chars**, which the **protected (never-trimmed) content alone exceeded by
~2.6x**. Measured by instrumenting `fetchAI()` with an `auditOnly` path and executing the real
builders against real profile-1 data: **protected ~17,400, untrimmed total 25,817**. So every call
fired all four trim steps, exhausted the ladder, still landed ~2.8x over, and reported it with a
bare `console.log` that read like success. Practical damage: the briefs were guillotined to 400
chars and `exerciseHistory` cut to top-5 **on every call**, silently discarding part of the
session #30 (B33a) PERSONAL BEST progression signal.
Now **28000**, above the real untrimmed total, so the ladder fires only on a genuinely oversized
prompt (verified: `trims: none` on a normal day). Raising the *input* budget is safe for latency —
session #29 established generation time is driven by **output** size, still capped by the
conciseness block. An exhausted-but-still-over state is a `console.warn`. Per-section lengths log
permanently via `promptSections` (this prompt's bugs have only ever been caught by inspecting the
assembled string). **Hold PRs are re-attached** when `exerciseHistory` is trimmed — any exercise
with `best_duration_seconds` outside the top-N is appended back, so truncation can never remove
the progression signal itself.

**`fetchAI({auditOnly:true, onAudit})`** assembles and reports **without calling the model**,
sharing the exact same assembly (no parallel copy). It is the permanent way to measure this prompt
— the builders are closures inside `fetchAI` and cannot be measured from outside.

### Goal-ordering de-confliction (`stripEmbeddedGoalsList`)
`ai_prompt_context` is AI-authored prose embedding its **own numbered `GOALS:` list**, written at
onboarding/profile-builder time. Goal order is separately mutated by the Prioritize drag-reorder,
which writes `goals[]` and never regenerates the prose — so they drift permanently. Measured live
on profile 1 they were nearly **inverted** (Fix Posture #1 in `goals[]` vs #4 in the prose;
Mountain Hike #4 vs #1; Fix Pubic Osteitis absent from the prose list), while the prompt
simultaneously instructed *"Goal #1 should influence ~40%"*.
The fix strips the embedded list **at assembly time only**, leaving `goalPriorityContext` as the
single authoritative ordering. **The stored `ai_prompt_context` is NOT modified and `goals[]` is
NOT restructured** — this is a prompt-assembly workaround, not a data fix. The durable fix
(regenerate on goal change) is ROADMAP §7 item (c); the prose remains stale everywhere else it is
consumed (§9).

### CARRY FORWARD gate (B12)
`buildVarietyAndSkipAnalysis()`'s CARRY FORWARD was guarded by `todayHasSchedule`, which checks
**anchors only** — but `buildScheduleInstruction()` also issues an imperative Option-1 order on a
no-anchor day whenever an underserved frequency target exists. Both fired, producing **two
contradictory Option-1 orders**. For profile 1 (anchors only Tue/Thu) that was ~5 days a week.
Now gated on `optionOneClaimed` — anchor **or** frequency target, mirroring the same pick
`buildScheduleInstruction()` makes. The fallback NOTE names the real claimant instead of printing
"Flexible", and the SKIP RULE now states the schedule instruction always wins.

## Exercise-Row Recovery — Re-Merge Endpoint (2026-07-19, session #30)

`POST /api/debug/remerge-workout-exercises/:profileId/:workoutId` — admin-gated. Recovers exercise rows destroyed by the pre-2026-07-19 integer `duration_minutes` column, and corrects rows left stale by a notes edit (`PATCH /api/workouts/:id` never re-extracts).

- **DRY RUN by default.** `&apply=1` writes. `&max_ops=N` (default 50) refuses an unexpectedly large plan. `&stop_on_error=0` continues past a failed write (default: abort).
- **Merge, never delete.** Keyed on `(workout_id, catalogNormKey(name))`:

  | case | action |
  |---|---|
  | predicted key absent | INSERT |
  | key matches, any of sets/reps/weight/distance/duration differs | PATCH in place |
  | key matches, all equal | no-op |
  | existing row not reproduced | **KEEP + report in `flagged_kept`** |

  Delete-then-reinsert was designed and then **rejected on evidence**: at default temperature re-extraction was non-deterministic (see above), so a delete pass could destroy real rows to fix fewer. That risk is now closed by temperature 0, but the no-delete rule stays — a row whose source line was edited out of the notes is still real history.
- **Idempotent.** Temperature 0 makes re-extraction stable, so a second run matches the rows the first wrote and reports all no-ops. Proven live on workout 106: second `apply=1` produced 7 no-ops, 0 writes, identical row ids.
- **NOT atomic — stated rather than implied.** PostgREST exposes no multi-statement transaction, so "transactional per workout" is not achievable over this interface. Instead: dry-run default, the complete pre-state returned as `before` (manual reversal basis), fixed op order, and `stop_on_error` so a failure can't cascade.
- **Near-duplicate guard.** `catalogNormKey` collapses plurals/hyphens/case but **NOT** spelling variants — `indoorbike` ≠ `indoorbicycle`, `hiprotation` ≠ `90/90hiprotation`, `figure4stretch` ≠ `figurefourstretch`. So a kept row and an inserted row can be the same exercise under two names. Reported as `possible_near_duplicates` (levenshtein ≥0.72 or substring) — **never auto-merged**. Deliberately over-inclusive; it only reports.
- **Shared extraction.** `extractExercisesFromNotes(body)` is factored out of the `extract-exercises` endpoint and used by both, so recovery runs the identical prompt/model/temperature as the live save path — one implementation, no drift.

**Recovery run 2026-07-19, all 17 affected workouts**, one at a time, each dry run checked against its approved projection before applying: **zero divergence, zero failures.** 269 → 297 rows; fractional-duration rows 0 → 22; Dead Hang 46 → 57; **zero duplicates**. 3 rows unrecoverable (extraction-prompt gap) and 10 preserved-and-flagged for user review — both detailed in ROADMAP §6.

## Partial-Failure Reporting on extract-exercises (2026-07-19, session #30)

A per-row INSERT failure used to be logged to `console.error` while the loop continued and the endpoint still returned `success:true` — the row was destroyed silently. Response now carries the truth:

```json
{ "success": true, "count": 6, "attempted": 8, "failed": 2, "partial_failure": true,
  "failures": [ { "name": "Dead Hang", "raw_text": "Dead Hang - 2x30s",
                  "duration_minutes": 0.5, "status": 400,
                  "error": "invalid input syntax for type integer: \"0.5\"",
                  "reason": "fractional_duration_rejected" } ] }
```

- `classifyInsertFailure(errText, ex)` maps a raw PostgREST error to a readable cause (`fractional_duration_rejected`, `possible_fractional_duration`, `duplicate`, `fk_violation`, `check_constraint`, `not_null_violation`, `unknown`). Descriptive only — never changes control flow.
- Failed entries also carry `insert_failed: true` inside `exercises` so a caller can flag the exact item.
- **`success` stays `true` on a PARTIAL save.** Both existing callers gate real work on it (the confirm chip, and Import History's running total), so flipping it would discard correct results. Only a **total** loss (something to insert, nothing landed) reports `success:false`. **`partial_failure` is the flag callers should check.**
- `emptyExtractResult()` gives the "nothing to insert" early returns the identical shape, so there is one stable contract.
- **Client surfacing** (`public/index.html`): `noteExtractFailures(workoutId, exData)` runs in the post-save extract callback — records into `extractFailuresByWorkoutId`, `console.warn`s, fires one toast. A clean re-save clears it. `extractFailureHtml(workoutId)` renders an inline red-bordered warning inside that workout's History card beside the chip row, listing each failed exercise with a plain-English reason (`fractional_duration_rejected` → "the duration could not be stored"). Returns `''` when nothing failed, so healthy cards are unchanged.

## Progression Signals in the Daily Rec Prompt (2026-07-19, session #30)

The system prompt has always demanded progressive overload with specific increments ("+5-10lbs, +1-2 reps, +5-10s hold"). Until this session it supplied **nothing to increment from** for this athlete's exercise mix. Four fixes, all in `fetchAI()`'s builders:

- **`buildExerciseHistory()` reads all three PR fields**, not just `best_weight` (which is `null` for every bodyweight/hold exercise). Emits `— PERSONAL BEST: 2:00 hold (120 seconds)`. `best_duration_seconds` and `best_reps` were already in the `/exercises` payload and simply never read.
- **`buildLog()` carries hold duration.** It was sets/reps/weight only, so recent hold performance was invisible.
- **Units are spelled out** via `nUnit(n, singular, plural)`. Sets used to render as `<N>s` — a 1-set Dead Hang read as `1s`, i.e. one SECOND, on an exercise measured in seconds. `daily_habit` lines used to compare a DAY count against a minutes target (`56/2 Minutes`).
- **Achieved milestones are BASELINES, not deletions.** `mgIsComplete()` filtered completed goals out of the prompt, so hitting a target removed the only progression signal present. `buildMicroGoalsPromptContext()` now emits an `ACHIEVED MILESTONES` block — the proven level to work at or above, with a progression instruction anchored to it. **Never auto-escalated to a next tier**: some goals are open-ended (hold duration, load), some are terminal rehab targets where pushing past would be wrong. A milestone-complete CTA in the Profile tab asks the athlete instead.

## Goal Roadmap Emphasis in the Rec Prompt (2026-07-19, session #30)

`buildRoadmapEmphasisContext()` injects **what** each top-3-by-priority goal's current phase should emphasize — never **how many** sessions.

**Division of labour, and why it matters:** the schedule owns frequency and duration and tracks them with real status (`Upper Body Strength 0/1 [NEEDED]`). Roadmap `weekly_targets` carry their own competing counts ("3-4 strength sessions per week") with **no status tracking at all**, so injecting both would put two different weekly numbers into a prompt that already had contradiction problems. Emphasis only.

- **Source is a structured `roadmap.phases[].emphasis` field**, extracted server-side by Sonnet (`ROADMAP_EMPHASIS_SYS`), **not** parsed from prose at render time. A regex pass was built, tested and rejected: it leaked counts and silently dropped the three most actionable targets because `weighted`/`bodyweight` matched a weight-tracking filter. Pattern-matching human prose is unfixable in principle.
- `extractPhaseEmphasis()` drops session counts, **preserves load/weight/rep-scheme/hold-duration language**, drops nutrition/tracking/subjective items, and strips stale conditional framing ("Once training resumes:").
- Self-maintaining: `backfillMissingEmphasis()` runs after generate and adapt; both generation prompts request the field natively. `POST /api/debug/extract-roadmap-emphasis/:profileId` backfills roadmaps that predate it.
- `rmCurrentPhase()` resolves the live phase by date, falling back to stored status and taking the **last** phase marked `current` (some roadmaps carried two). Horizon falls back to the next phase's `start_date` where `end_date` is absent.
- **`exercise_gaps` from the macro roadmap are deliberately excluded** — only 1 of 5 was free of session counts or non-training content. Queued (ROADMAP §9).
- Protected tier: not in the trim ladder; self-caps at 3 goals × 4 emphases + 1 completion signal (~1,500 chars).

## Roadmap Adaptation — Premise Validity (2026-07-19, session #30)

Adaptation could not re-evaluate whether a phase's **premise** was still true. Build Muscle sat in a phase named "Progressive Overload (Paused)" whose first target began "Once training resumes:" for weeks after training had resumed.

- **`adaptGoalRoadmap` runs on Sonnet** (was Haiku). It decides whether a phase premise holds — the judgment that now steers the rec prompt. Measured ~0.39M input / 0.31M output tokens per YEAR across all goals with roadmaps; the ~3x delta is a few dollars and scales with goals, not recs.
- **Two checks added to the adapt prompt**, with the conservative "keep phases that are still valid" bias kept verbatim and a closing "these two checks are the ONLY reasons" clause: **DATE ROLLOVER** (an expired phase cannot remain `current` even if its `completion_signals` were never met; exactly one near_term phase may be `current`) and **PREMISE VALIDITY** (a phase premised on a pause/injury/deload/travel that has ENDED must be rewritten — scoped to that named class, with an explicit leave-it-alone clause).
- **`buildWeeklyReviewContext(workouts)`** replaces the literal `"(no notes — automatic weekly review)"` string with computed evidence: session counts this window vs prior, categories, longest gap, and a **RESUMPTION SIGNAL** line. Zero extra API calls. The `prev14 === 0` branch is gated on the data window actually reaching back 28 days — the adapt call receives only ~10 workouts, so for a consistent athlete that window is ~14 days and `prev14` would read 0 for lack of data, producing a permanent false signal.
- **`enforceSingleCurrentPhase()`** is a deterministic invariant run after adapt AND generate. Prompt rules are probabilistic; Fix Posture carried two `current` phases for weeks while the Goals tab rendered correctly (status is derived on read, never written back). Horizon phases untouched, idempotent.
- **`resequenceNearTermDates()`** (repair only, admin endpoint, dry-run default) rebuilds the calendar forward from the current phase and back-dates completed phases. `assignNearTermDates()` preserves existing `start_date` by design, so a bad adapt that pinned every phase to one date cannot otherwise be repaired.

## Engine v2 — Phase 2 Implementation (2026-07-22)

Parallel, feature-flagged replacement for the v1 daily-rec engine. Routed by
`profile_data.engine_v2 === true` — **only profile 4 ("Test #3", the designated test profile,
seeded with a verified clone of profile 1's training history)**. Every other profile, profile 1
included, runs the existing v1 path byte-identically.

**v1 isolation, and exactly what was touched.** The only edits to `server.js` are (a) three
additive `require`s and (b) one new route. No v1 function, prompt builder, endpoint, or column
was modified. Post-deploy smoke test of profile 1's `workouts` / `exercises` / `daily-recs` /
`micro-goals` / `wearables/providers` endpoints: all 200.

### `server/coachingRules.js`
ONE source of truth for the rule set, consumed two ways so the model and the code can never
disagree: `renderRulesForPrompt(sections)` emits prompt text, and the same constants back pure
functions used directly by the builders (`gapDecay`, `progressionDecision`, `deloadDecision`,
`readinessModification`, `painCheck`, `timeCompressionPlan`, `rotationPolicy`,
`assessAccessoryCost`). 12 sections, 6,654 chars rendered in full;
`rulesSectionLengths()` returns per-section counts for the `promptSections` logging discipline.

**Evidence marking is load-bearing, not decoration.** Every rule carries
`evidence: 'established' | 'contested'`, and `renderRulesForPrompt` prints contested rules with an
explicit `[CONTESTED GUIDANCE — …]` marker plus the reason. Currently marked contested: the
**MV/MEV/MAV/MRV weekly volume landmarks** (useful planning vocabulary, genuinely disputed
numbers, high inter-individual variance), the **3-consecutive-day HRV threshold** (HRV-guided
training beats fixed programming in several trials, but that specific cutoff is convention),
the **mat-load −2 sets figure** (direction well supported, the number is a convention chosen for
this athlete), the **mobility MED** (retention timelines for passive range are poorly
characterised), and the **10–14 day gap-decay band** (detraining evidence at that timescale is
weak and highly individual). Silbernagel's pain model is marked established but annotated that it
was validated for tendinopathy specifically and is applied here more broadly.

### `server/v2Progression.js`
Progression state computed **in code at generation time — no table**, so it can never go stale
relative to the log. 60-day window; per exercise: last 3–5 instances (one per date, the day's top
set), trend (`up|flat|down`, first-half vs second-half, comparing only rows sharing the dominant
metric), `days_since_last`, all three PR fields, the gap-decay adjustment from the rules module,
inferred modality, and a progression decision. `renderProgressionTable()` emits the compact
prompt table.

**The aggregation is deliberately duplicated** rather than extracted from
`GET /api/profiles/:id/exercises` (approved Phase 1 decision): v1 isolation outranks DRY, and the
windows differ anyway (v2 wants 60 days, ordered instances and a trend; v1 aggregates all
history).

**Session length vs hold duration** — `exercises.duration_minutes` means both, and nothing in the
schema distinguishes them. v2 disambiguates by `main_category`: cardio / martial_arts / sports /
mind_body are **session length** (tracked as `best_session_minutes`, modality `conditioning`);
everything else is a **hold** (`best_duration_seconds`, modality `isometric`). Found by running
the audit against real data — before the fix it reported `MMA Sparring PB 60:00 hold` and
prescribed `+5-10 s hold` on a sparring session. v1 still has the ambiguity (see ROADMAP §6).

### `server/v2Dossier.js`
Builds the compact dossier for `profiles.dossier`. **Every derived FLAG is computed in code from
the log; the model is used for exactly one thing — phrasing two prose fields — and only after the
flags are settled.** The prose prompt is explicitly told to add no facts. That split is what makes
the human-feel strings trustworthy: code detected it, the model only phrased it.

Flags: injury/pain (profile injuries merged with recent check-in soreness), equipment/time
reality, `novelty_pref` (explicit if set, else inferred from exercise-variety count and labelled
as inferred), stalled lifts (>3 wk no progression, driven off the progression state so the two
cannot disagree), neglected movements (>6 wk, from `getFullExerciseContext()`, reused not
rewritten), notable PBs, standing schedule constraints.

**Size discipline:** injury DESCRIPTIONS are shortened before any list is trimmed, and an injury
is **never dropped for size** — an injury removed for length is a safety problem. Measured 2,401
chars on real data against a ~2,000 target, under the 2,600 hard cap, warning emitted.

**Notable PBs require ≥2 sessions in the window and are ranked by magnitude.** A single logged
instance is not a personal best — that is how "Pinky Abduction with Rubber Band 15 reps" was
initially billed alongside real lifts. Session lengths are excluded entirely.

### `GET /api/v2/audit/:profileId`
Admin-gated (`ADMIN_SECRET`), **read-only, writes nothing** — the Phase 2 proof that the builders
work before any generation exists. Returns the assembled progression state, the dossier the
builder *would* write (never persisted), resolved roadmap phases, the rendered rules, and
per-section character counts. `?prose=1` runs the single Haiku prose pass (the only thing here
that costs money); `?window=N`, `?sections=a,b`.

Reads the profile via **direct PostgREST**, deliberately not `GET /api/profiles/:id` — that
endpoint fire-and-forget PATCHes `profile_data` via `ensureGoalIds()` (a read with a write side
effect, ROADMAP §6), which must never fire from an audit path. Tolerates the unrun
`dossier`/`dossier_updated_at` migration by falling back to a column-less select and reporting
`storage_columns_migrated` — without that, PostgREST's 400-on-unknown-column made the audit report
a misleading "Profile not found" on a profile that exists.

### `v2CurrentPhase(roadmap, todayYmd)`
Server-side roadmap phase resolver — `rmCurrentPhase()` in `public/index.html` is client-only, and
the planner runs server-side. Resolution order: the near_term phase whose date window contains
today → else the last phase stored `status:'current'` → else an open-ended started phase.
**Prefers the DATE window over the stored status** and reports `basis`, `disagreement` and
`stored_current_count`, because `recomputeRoadmapProgress()`/`assignNearTermDates()` run at read
time and never write back (ROADMAP §9 D5) — the stored `phases[]` this reads can disagree with
what the Goals tab renders, which is what let two phases sit marked `current` for weeks.

## Engine v2 — Phase 3 Implementation (2026-07-22)

### `server/coachingRules.test.js` — test harness
Plain `node --test`, zero dependencies: `node --test server/coachingRules.test.js`. 47 tests.
Exists because the Phase 2 audit against real data exercised only 3 of 5 gap-decay bands —
`10-14 days` and `2-3 weeks` had never executed. Covers every band, every boundary
(9/10, 14/15, 28/29, 42/43), garbage input, every `progressionDecision` branch, and the
pain/readiness/deload/rotation/time-compression/accessory functions.
**Found that `PER_EXERCISE_STALE_MULTIPLIER` is provably unreachable** (staleness needs >30 days;
every band from 29 days up is already ≤0.85) — kept and documented as defensive-not-active.

### `establish_baseline` — a first-class progression action
`progressionDecision` returns `establish_baseline` (NOT `hold`) when an exercise has fewer than
`MIN_SESSIONS_FOR_SIGNAL` (3) sessions in the window. On real data that is 34 of 40 exercises, so
"we have no idea yet" is the COMMON case and must be sayable separately from "we are deliberately
holding the load steady" — two states that need opposite coaching language. It yields to a
`brutal` effort report, which is checked first.

### Progression table: split by signal, not truncated by recency
`renderProgressionTable(state, {maxSignal, includeTail})` renders exercises with a resolvable
trend in full and collapses the rest into a dense `name (Nx, Nd)` tail. **9,989 → 3,093 chars.**
Capping by recency was rejected: it would discard a lift trained consistently but not lately,
which is the exact thing progression logic exists to notice.

### Goal tiers + Schedule v3
`profile_data.goals[i].tier` (`driver`|`maintenance`|`accessory`), no migration. Max 2 drivers —
`resolveTiers()` keeps the top 2 by array order (array order IS priority) and demotes the rest to
maintenance **for the block only, never mutating stored goals**, returning the demotions so the
planner can state them.

**Schedule v3 lives at `profile_data.schedule_v3`, NOT inside `profile_data.schedule`.** This is
load-bearing: `loadSchedule()` reconstructs `currentSchedule` as exactly
`{anchors, frequency_targets, addons}` and `schedPersist()` writes that reconstruction back, so
any key placed inside `.schedule` is destroyed the first time the athlete edits the Schedule card.
A sibling survives because `schedPersist` does
`Object.assign({}, currentProfileData, {schedule: currentSchedule})`. The same reconstruction is
what makes v1 **provably** unable to see these keys — they are stripped at load time, before any
v1 reader runs.

### `server/v2Planner.js` + `POST /api/v2/plan/:profileId`
Admin-gated, **streaming** (Render's 25s cap; a full week is ~7,300 output tokens / ~114 s), Sonnet,
**capped at 2 attempts** with the retry only on unparseable JSON. Refuses to run on a profile whose
`engine_v2` flag is not true. `?dry_run=1` generates and validates without persisting;
`?start=YYYY-MM-DD` overrides the week start.

Because the response is already streaming when persistence happens, the result is appended inside an
`[[APEXCOACH_V2_PLAN_RESULT]]` marker — the same server-authored-marker pattern coach_chat uses for
tool proposals.

**Persistence** (`v2PersistPlan`): supersedes any existing `active` block, deletes only
`status='planned'` rows in the target week (a completed/modified session is history and is never
destroyed by a re-plan), then inserts the block and its sessions.

**Deterministic invariants enforced in CODE after generation** (`enforceInvariants`), per the
`enforceSingleCurrentPhase` precedent that prompt rules are probabilistic:
- REPAIRED (structural, safe to fix mechanically): sessions dated outside the week; missing or
  duration-modified anchors; `(date, slot)` collisions; missing `why`; unknown segment type.
- FLAGGED (training content, never silently rewritten): high-CNS sessions on consecutive days;
  per-session volume ceiling.

The volume check is a **coarse whole-session 30-set proxy**, not the real ≤10-sets-per-muscle rule —
`planned_sessions.session` carries no muscle tags. Wiring `exercise_catalog` muscle data in would
make it exact; deferred.

### `GET /api/v2/plan/:profileId`
Returns the active block + sessions **and a `ready` object**. `{block:null, sessions:[]}` alone was
ambiguous — PostgREST returns an error OBJECT for a missing relation, which `Array.isArray()`
rejects identically to an empty result, so "not planned yet" and "cannot plan yet" were
indistinguishable. Now reports each precondition (tables present, `engine_v2`, goals tiered,
drivers, `schedule_v3`, `defaults`) plus `can_generate` / `will_be_meaningful`.

## Engine v2 — Phase 3.5 Correctness Pass (2026-07-22)

Four defects found in the first real plan, each closed at the level it belonged at.

### 1. Unverifiable history assertions → computed recency block
The first plan asserted a "22-day gap" and framed the week as "post-gap day 1", cutting load
10–20% on that basis. The number was **correct against the database and derivable from nothing in
the prompt** — and the gap had CLOSED 9 days and 7 sessions earlier. A right answer reached
unverifiably is the same failure mode as a confidently wrong one.

**`buildRecencyState()`** (`server/v2Progression.js`) computes, in code:
`days_since_last_workout`, `sessions_last_7`, `sessions_last_14`, `current_streak_days`,
`days_logged_in_window`, and `longest_gap_60d` **with an explicit `open`/closed flag**. Malformed
`workouts.date` text rows (ROADMAP §6) are excluded rather than text-sorted.
`renderRecencyBlock()` states it as the only sanctioned source and carries the framing rule.

The planner system prompt gained a **SOURCING RULE**: state no numeric fact about training history
that is not present in the prompt; never derive one from progression-table instance dates (that
table shows only a SAMPLE of instances, so any figure derived from it will be wrong); any
"post-gap" / "returning from a layoff" framing must be justified by the recency block.

**Verified on regeneration:** zero occurrences of "22-day", "post-gap", "layoff" or "returning
from". The two surviving "re-establish" uses are legitimate — one quotes the roadmap phase name,
one describes the Indoor Bike downtrend.

### 2. `time` had no unit → `time_seconds`
`Indoor Bike time=20` meant MINUTES; `Dead Hang time=30` and `Plank time=30` meant SECONDS. Same
key, same type, 18 occurrences — the `duration_minutes` overload reproducing itself in the very
schema meant to prevent it.

Fixed at the schema: **exercise time is `time_seconds`, always seconds**. A timed block's length
is not an exercise property at all — it belongs on the segment's `duration_min`. Chosen over a
value + required `time_unit` pair because a MISSING unit degrades silently back into the exact
ambiguity being fixed, and because `time_seconds` matches `best_hold_seconds` already used by the
progression state. The `time_unit_resolvable` invariant repairs a legacy bare `time` where the
intent is unambiguous (a value on a timed-block segment is minutes and moves to the segment;
anywhere else it is a hold in seconds) and FLAGS anything non-numeric rather than guessing.
**Verified on regeneration: 0 bare `time`, 11 correct `time_seconds`.**

### 3. No time-budget verifier → `session_time_budget`
4 of 7 sessions in the first plan disagreed with their own stated duration. Segment minutes must
now sum to the session's `duration_min`, tolerance `max(2, floor(10%))` — tighter than v1's ±15%
because the planner states segment durations EXPLICITLY, so a mismatch is the model contradicting
its own arithmetic rather than estimation noise. **Repair direction differs by case:** an anchored
session's stated duration is real-world truth (a 60-minute class is 60 minutes) so the SEGMENT is
corrected; everywhere else the segments are the concrete content and `duration_min` is corrected
to match. **Verified: all 7 sessions exact on regeneration.**

### 4. Tiered goals silently unprescribed → `tiered_goal_prescribed`
`Daily Meditation` appeared only inside a segment's `intent` string — acknowledged in prose,
dropped in practice. A goal is now satisfied by appearing in some session's `goal_tags` (on a
session that actually has segments) OR by being named in `block.tradeoff_notes` (the legitimate
"deliberately not addressed this week" escape). FLAGGED, never repaired — inventing work for an
unaddressed goal is content fabrication.

### 5. `server/v2Planner.test.js` — 27 tests, invariants proven
The invariant set had fired **0 times across 7 sessions**, which is no evidence it works — an
invariant that has never fired is indistinguishable from one that cannot. Every invariant is now
proven against a deliberately corrupted fixture: dropped anchor, modified anchor duration,
`(date,slot)` collision, consecutive high-CNS days, over-cap session, missing and whitespace-only
`why`, out-of-enum segment type, bare `time` in both unit senses, non-numeric time, over- and
under-budget sessions, anchored-vs-movable repair direction, goal-in-intent-only, goal on an empty
session, and out-of-week dates — plus a clean-plan case asserting **zero** false positives.

## Engine v2 — Phase 4 Implementation (2026-07-22)

Nightly job + autoregulator + alternate cache. v1 untouched (additive requires + new routes +
one flagged branch inside `life-os-summary`, v1 path byte-identical inside its `else`).

### Nightly job — `POST /api/v2/cron/nightly` (+ hourly interval)
Admin-gated. **The admin endpoint is the PRIMARY trigger** — Render's Hobby plan spins the
interval's host down when idle, so an external cron hitting this endpoint (which also wakes the
service) is the real mechanism. The in-process hourly `setInterval` is a **secondary** warm-path
only; the system is fully correct if it never fires.

`?profile_id=` scopes; default is every `profile_data->>engine_v2=eq.true` profile. `?force=1`
bypasses the idempotency guard. Per-profile isolation — one failure never aborts the run.

**Concurrency**: a NEW `_v2Locks` map + `withV2Lock('nightly:'+pid, fn)`, the exact shape of
`withRefreshLock` but a separate map (never overload the token map). Proven: two concurrent
same-profile calls share one generation; different profiles run independently; the lock releases
after settle.

**Idempotency**: keyed on the athlete-LOCAL date via `localToday(profile)`, not the server's UTC
date (Render runs UTC, so "nightly" must mean the athlete's night). Skips when
`v2_daily_cache_date === today` unless forced. `loadV2Context` MUST select `v2_daily_cache_date`
or the guard reads undefined and every tick does a full generation — a real bug found by testing.

**Per-profile pipeline** (`v2NightlyForProfile`), ordered: recency → progression → dossier →
readiness → today's `planned_sessions` row → autoregulate → alternates → **single** cache write.
No planned session for today → an explicit rest state is written; a session is NEVER invented.

### Autoregulator — `server/v2Autoregulator.js` (Haiku)
**Edits a plan; never invents one.** Inputs: today's planned session, readiness, recency, dossier,
progression, yesterday's `session_effort`, and a mat-load note. Output: the adjusted session in the
same schema (`time_seconds`, never bare `time`) + a decision tag
(`kept|reduced_volume|reduced_intensity|swapped|recovery`) + a one-line why.

**"Modification, not replacement" is enforced mechanically** (`assertIsModification`): exercise-name
RETENTION between planned and returned, keyed to the decision tag — `kept`=100%, `reduced_*`=60%,
`swapped`=25%, `recovery` exempt but must be low-intensity and not longer. A **category change or a
total replacement HARD-REJECTS** to the planned session (serving the plan always beats serving
something invented). The tag must also match the actual change (e.g. `reduced_volume` requires
total sets to fall). **Anchor integrity is checked structurally** (`assertAnchorUntouched`:
segments byte-identical + duration unchanged), not by trusting the prompt. The Phase 3.5 invariant
set is reused on the adjusted session.

### Readiness — `server/v2Readiness.js`
**Personal-baseline-relative, never population absolutes.** Built from stored `daily_sleep`
(30-day rolling baseline for HRV/RHR/sleep-score) + the freshest `daily_checkins` — **no live
wearable call**, so it runs correctly on profile 4's no-connection setup. The rules verdict is
computed in code (`readinessModification`); a subjective "brutal"/"wrecked"/"terrible" report
vetoes a green wearable score.

### Alternate cache — ≤4 objects, mostly code-derived
Primary (the autoregulated session) + the two neighboring durations relative to the profile
DEFAULT + one category swap. **Duration variants are derived IN CODE** (`compressSessionToDuration`)
via the rules module's time-compression order (drop tertiary accessories → shorten rest → NEVER
drop the primary compound or a prehab/mobility segment). Extending is a no-op restatement (adding
volume is a judgment the code won't fake — that's Phase 5). The **category swap is the ONE model
call**. Everything is flattened to renderer-ready strings at the cache boundary
(`flattenSessionForCache` → the v1 sectioned-renderer shape `{label, minutes, exercises:[str]}`),
so the renderer is untouched. **Morning open is a pure DB read — zero model calls.**

### life-os-summary v2 branch (flagged shared-surface edit)
`GET /api/profiles/:id/life-os-summary` now selects `profile_data` + `v2_daily_cache*` and, for a
`engine_v2` profile, reads `v2_daily_cache.today` instead of the now-empty
`daily_recommendations.options[]`. `readiness` stays `null` for v2 (baseline-relative, no single
0-100 score; inventing one is worse than null — Life OS treats it as optional). The v1 path is
byte-identical inside the `else`. Tolerates an unrun v2 migration via a column-less fallback
select.

## Engine v2 — Phase 5 Implementation (2026-07-22)

On-demand variant endpoint + the shared variant logic. `server/v2Variant.js` is ONE
implementation with TWO callers: the user-facing endpoint AND the nightly category-swap alternate
(replacing Phase 4's inline swap prompt).

### `POST /api/v2/variant/:profileId` (streaming, Haiku)
Admin-gated. Body `{ constraint_text?, duration_min?, intensity?, category? }`, any combination.
Transforms the **autoregulated primary from `v2_daily_cache`** (`today_session`, the structured
form — see below), not the raw `planned_sessions` row. **Ephemeral by design**: it never writes
`v2_daily_cache` or `planned_sessions` — proven both structurally (no Supabase write in the route
or `v2GenerateVariant`) and by a before/after check (a model variant left the planned session's
`updated_at` and the cache's `today` byte-identical). Returns 409 if there is no fresh cache for
today (run the nightly job first).

**Structured vs flattened, load-bearing.** The cache's `today` is the FLATTENED display shape
(`sections[]` of strings) the v1 renderer reads; `today_session` is the STRUCTURED session
(`segments[]` with exercise objects) the variant transforms — compression and the model both need
structure. Missing this initially made code-compression silently no-op ("no segments to
compress"). Alternates carry `session_structured` too.

### Routing — code before model
1. **CACHE-FIRST** (zero model call, ~1.4s): a pure duration request matching a prepared alternate.
   Matched by the `dur_<N>` key **when the alternate's actual duration is genuinely near the
   request** — a `dur_30` alternate compresses to ~28 min, and the `dur_60` no-op-extend (the
   40-min primary relabeled) is correctly excluded from being served as "60".
2. **CODE-ONLY** (~1.5-2s): a pure duration REDUCTION, resolved by the rules module's
   time-compression order (`compressSessionToDuration` — drop tertiary accessories → shorten rest
   → never drop the primary compound or a prehab/mobility segment). A duration INCREASE is NOT
   code (adding volume is a judgment the code must not fake).
3. **MODEL** (~15s, streamed): intensity, category, style, free-text, or a readiness signal.

### Free-text classification (in code, before any model call)
`classifyRequest`: "shorter"/"longer"/"harder"/"easier" map to structured equivalents;
**"not feeling it" is a READINESS signal** routed through the rules module (proven live: the model
applied the subjective-malaise-vetoes-green-score rule and trimmed intensity, it did not reroll);
"same muscle group, different style" holds the primary + pattern and varies structure. An explicit
structured field beats a vague phrasing.

### Hard rules constraints cannot override (proven live)
- **Anchors**: the code path is gated off for an anchor, and the model is told to refuse-in-prose.
- **Injury contraindications**: checked in code against ACTIVE dossier flags (`contraindications`,
  deduped; a merely-"declared" flag doesn't count). Proven live — "give me heavy sprint intervals
  and adductor work" was REFUSED (`refused:true`) with a plain-language Pubic Osteitis explanation
  and the safe session returned unchanged.
- The SOURCING RULE and the rules-module caps still bind.

### Two new invariants (`checkVariant`, both flag never rewrite)
- **`constraint_honored`**: the output reflects the ask (a 30-min request → a ~30-min session; the
  requested intensity/category). Suppressed on a legitimate refusal.
- **`contraindication_free`**: no exercise conflicts with an active injury flag. Keyword tokens are
  qualified to avoid false positives — "bridge" was matching "Glute Bridge" (a hip rehab staple)
  against a neck flag, now "neck bridge"/"wrestler bridge".

### Nightly swap rewired
The Phase 4 inline swap prompt produced nothing; the nightly category-swap alternate now calls
`v2GenerateVariant` (the shared path), so it gets the same dossier/contraindication/invariant
treatment. **The nightly job now yields 4 cache objects** (primary + two duration variants + the
swap) — the Phase 4 failure was the same structured-vs-flattened bug.

### Latency vs the targets
- **Sub-5s is met for the deterministic paths** (cache ~1.4s, code ~1.5-2s) — which cover the
  common "shorter"/duration cases.
- **Model paths run ~15s**, materially over 5s. Assembled prompt ~11k chars / ~3.2k input tokens
  (the structured session ~3.5k + rules ~3.3k dominate; smaller than the autoregulator's 15,890 as
  required). The latency is **output generation** (~1,500 tokens for a full structured session on
  Haiku), not input size — so trimming the prompt further won't reach 5s. A sub-5s full-session
  model generation isn't achievable; closing it would need generating a diff rather than a whole
  session, a design change deferred. Streaming means the user sees progress meanwhile.

## Engine v2 — Phase 6 Implementation (2026-07-22)

The flagged Today UI, rendered ONLY for `profile_data.engine_v2 === true` (profile 4). Profile 1
and every other profile see the unchanged v1 Today tab. **Frontend + one small server read
endpoint.** Verified with live browser renders (state-injected past the PIN) — no console errors,
all surfaces styled with the existing token system.

### The 7 v1 seams (branch-and-return; v1 body untouched)
Each branches on `isV2Profile()` (`currentProfileData.engine_v2 === true`) as its FIRST statement:
`resolveAIRecs` (→ `resolveV2Today`), `renderAI` (→ `renderV2Today`; this also bypasses the
cycling-UI reroll/category/focus block, SEAM 3), `maybeRegenForReadiness` (no-op — the nightly job
owns regeneration), `regenerateAIForContextChange` + `invalidateDailyRecsAndRefresh` (→ refresh
from cache), the day-nav `fetchAI` call, and `bootApp` (loads the v2 cache + week). **Verified: the
entire diff deletes exactly ONE line** — the day-nav `fetchAI()`, whose replacement runs
`fetchAI()` under the identical condition on the v1 branch (`else fetchAI()`), byte-identical for
v1. Every other seam is a guard inserted above the original first line (kept as context).

### `GET /api/v2/today/:profileId` — the browser read path
**Pure DB read, no model call, NOT admin-gated** (user-facing, same posture as v1 `/daily-recs`).
Returns the fresh `v2_daily_cache` (today's autoregulated session + alternates + decision tag) plus
the planned week. A non-v2 profile gets `{engine_v2:false}` so the client falls back to v1 without a
second call. **`POST /api/v2/variant` was also un-gated** (user-facing generation, like `/api/ai`);
the nightly CRON stays admin-gated. **This is the flagged shared-surface change** — the real guard
is the internal `engine_v2` check, and the app is PIN-gated at the profile selector, not per-API.

### Surfaces
- **Today card** (`renderV2Today` → `#ai-content`): the autoregulated session via the existing
  `recOptionSections` renderer (so `time_seconds` shows as "45s", never a bare number), the
  one-line `why` in cornerman/purple AI treatment, goal-tag pills, and — the "feels coached"
  payoff — the decision tag surfaced honestly ("VOLUME REDUCED TODAY") only when the session was
  actually adjusted, never a silent edit.
- **Variant surface** (`#v2-variant`): ONE surface replacing v1's reroll + category pills + focus
  buttons. Free-text box + 5 chips ("Different style, same focus" / "Not feeling it" / "Shorter" /
  "Harder" / "Easier"). Detects the endpoint's plain-JSON (cache/code, instant) vs SSE (model)
  response so a cached duration swap renders without a spinner-gate. Ephemeral "SHOWING A
  VARIATION" banner + "Back to today" link (mirrors v1's `altRec` pattern); **never overwrites the
  cache** — proven in Phase 5.
- **Week view** (`#v2-week-card`): the block's `planned_sessions` with status + duration; anchors
  marked with a ◆ and ember. Tap a day → a scoped bottom sheet (`#v2-sheet`) with its detail.
- **Effort tap** (`#v2-effort`): after a v2 save, a skippable 3-button prompt ("Had more in me" /
  "About right" / "Brutal") writing `session_effort` via the existing verbatim-body
  `PATCH /api/workouts/:id` — no endpoint change. **Verified writing to the DB.**
- **Defaults picker** (Settings → AI Coaching, `v2DefaultsSettingsHtml`): duration + intensity →
  `profile_data.defaults`. Copy notes that the two shortcut variations are prepared 15 min either
  side of the default.
- **Tier selector** (goal cards, `v2GoalTierHtml`): driver/maintenance/accessory →
  `profile_data.goals[i].tier`, with the **max-2-drivers rule enforced in the UI** (blocks a 3rd
  with a message; the planner also demotes server-side).

### CSS scope
All new CSS scoped under `#v2-today` / `#v2-week-card` / `#v2-variant` / `#v2-sheet` / `#v2-effort`
/ `.v2-def` / `.v2-tier`. **No global class redefined.** The `<style>` block sits in `<body>`
(valid, applies document-wide; confirmed rendering correctly in the live app). No migration — every
field already exists.

## Engine v2 — Phase 7 Implementation (2026-07-22): Coach Chat concierge

Extends the existing Coach Chat propose→confirm→apply pattern for flagged profiles. **v1 Coach Chat
is byte-identical** — verified: profile 1's `?debug=1` snapshot has no v2 section, no persona
addendum, and the original 4,968 chars; a v1 send resolves `isV2Chat=false` and every branch below
is the original. The only added cost for v1 is one small profile fetch to read the flag.

### v2-aware snapshot (`buildV2ChatSnapshotSection`, pure append)
Appended to `buildChatSnapshot`'s output only when `pd.engine_v2 === true` (its own fetches are
separate from the v1 query). Carries: goal tiers, today's autoregulated session + decision tag +
why, the block focus, **this week's `planned_sessions` each with an `[id]` and a FIXED marker on
anchors**, the stored dossier, recency (with the open/closed-gap framing), and progression (capped
at 10 signals here since it shares the chat budget). Plus the SOURCING RULE and a goal-tag caveat.
**Measured on profile 4: v2 section 5,484 chars, total snapshot 10,461 vs the 20,000 char guard.**

### v2 tools (`buildCoachChatTools(isV2)` — flagged profiles only)
`propose_session_change`, `propose_skip_session`, `propose_standing_preference`. A v1 profile gets
the exact original `COACH_CHAT_TOOLS` array. A v2-specific persona addendum
(`CHAT_PERSONA_V2_ADDENDUM`, appended to the stable/cached persona, not the snapshot) states the
rules: future-only, anchors immovable, no re-planning, confirm-first.

### Guards enforced IN CODE (not just prompt)
All at proposal-compute time, before a card can even be created (`_loadPlannedSessionForProposal`
throws a `noop` → the model gets a plain refusal, no `chat_proposals` row):
- **FUTURE-ONLY.** A change to today's session is refused with a pointer to the ephemeral variant
  surface. **This is how today's-cache vs `planned_sessions` desync is prevented** — chat never
  writes today's `planned_sessions` row (which today's cache is derived from), so the two can't
  diverge; the next nightly run re-derives the cache from the (chat-edited) future rows.
- **ANCHORS immovable** — a `movable:false` session is rejected at compute time.
- **INJURY conflicts** — `v2Variant.contraindications` against the stored dossier refuses in prose.
- **AT APPLY TIME** (the confirm endpoint) the future/anchor rules are re-checked against FRESH
  data (the row could have changed between propose and confirm), then the **Phase 3.5 invariant set
  + injury check** run against the confirmed session; a violation throws before the write, leaving
  the proposal pending (same failure mode as the roadmap-regen path).

### No re-planning, no new apply surface
The tools PATCH individual `planned_sessions` rows only — nothing calls the planner or regenerates
the block. `applyProposal` gained the three new type branches; the **confirmation enforcement is
inherited unchanged** — `applyProposal` is still only reachable from
`POST .../chat/proposals/:id/confirm`, so a proposal cannot write without explicit confirmation.

### A duration change must compress segments (found in the apply demo)
`computeSessionChangeProposal`'s duration edit runs the rules module's time-compression order
(`compressSessionToDuration`) on a REDUCTION — setting only the top-level `duration_min` left the
segments summing to the old length, and the Phase 3.5 **time-budget invariant then correctly
reverted it on apply** (which is how the demo proved the invariant runs). Now the segments are
actually shortened (primary compound + prehab protected), so the change is real and
invariant-consistent.

### Apply cycle — verified end to end (2026-07-22, migration run)
Real cycle on a future movable session (id 32, Fri, strength): **before** — planned/45min; **propose
via chat** → proposal #24 created, and the row stayed planned/45 with its `updated_at` unchanged
(**proof no write before confirmation**); **confirm** → row PATCHed to `status:modified`,
**duration 30, segments summing to 30 (time-budget invariant clean), primary + prehab kept**; a
second confirm is rejected 409 "already confirmed". The refusal paths (anchor, injury) were proven
to create no proposal, and v1 Coach Chat is byte-identical (profile 1's snapshot has no v2 section).

### Known residual: leg-1 narration
The tool loop streams the model's first-leg text before the tool runs, so a model that opens with
"Done" before a tool fails can leave a stale claim on screen. The persona now tells it to phrase
changes as proposals and self-correct on a failed tool result; a full fix needs stream buffering,
deferred (§6). The safety property is unaffected — a failed tool never writes and never renders a
card.

### Standing preferences close the Phase 2 deferred item
`propose_standing_preference` writes `profile_data.v2_preferences[]`; `v2Dossier.buildDossier` now
folds those into `refusals_preferences` (which Phase 2 deliberately left empty for exactly this),
and `renderDossierForPrompt` surfaces them — so a stated preference flows into every future prompt.

### goal_tags decision (LEFT logged, §9)
Deriving `goal_tags` in code from prescribed exercises is planner-side and larger than this phase.
Instead the v2 snapshot exposes the actual exercises in each planned session, and the persona tells
chat to reason from the exercises, not the tags — so goal-reasoning degrades **honestly** (it never
claims a goal was untrained when exercises that serve it are present). Verified live: "what am I
neglecting" reasoned correctly from exercises ("no rows, presses, or pull work"), not tags.

## Migrations

One-time data fixes that should be run in the Supabase SQL editor.

### `exercises.duration_minutes` → numeric (2026-07-19) — ✅ run in production
Widens the column so fractional durations survive. The extraction prompt emits `30s`→0.5, `45s`→0.75, `1:42`→1.7; the `integer` column rejected all of them and the insert loop dropped those rows silently. Verified before (`integer/32/0`) and after (`numeric/6/2`). Existing rows unaffected in value — every stored value was already whole. Does **not** recover already-destroyed rows; that was a separate re-merge pass. See `migrations/2026-07-19_exercises_duration_numeric.sql`.

```sql
ALTER TABLE exercises
  ALTER COLUMN duration_minutes TYPE numeric(6,2)
  USING duration_minutes::numeric(6,2);
```

### Drop `fitbit_pending_imports` (2026-07-17) — ✅ run in production
Drops the deprecated Fitbit auto-import queue column. All reading/writing code was removed the same day (see "Tech Debt Batch" above) — confirmed zero call sites before deletion. See `migrations/2026-07-17_drop_fitbit_pending_imports.sql`.

```sql
ALTER TABLE profiles DROP COLUMN IF EXISTS fitbit_pending_imports;
```

### Drop legacy text roadmap columns (2026-07-17) — ✅ run in production
Drops the legacy free-text macro roadmap columns, superseded by `roadmap_data` since 2026-05-29. Endpoint + client fns removed the same day (see "Tech Debt Batch" above) — confirmed no external consumer reads them first. See `migrations/2026-07-17_drop_legacy_roadmap.sql`.

```sql
ALTER TABLE profiles DROP COLUMN IF EXISTS roadmap;
ALTER TABLE profiles DROP COLUMN IF EXISTS roadmap_updated_at;
```

### `exercises.workout_id` FK cascade (2026-07-17) — ✅ run in production
Adds a real FK from `exercises.workout_id` to `workouts.id` with `ON DELETE CASCADE`. **Would have failed if any `exercises.workout_id` didn't match an existing `workouts.id`** — the orphan report (`GET /api/debug/orphaned-exercises/:userId`) was run for every profile first (profile 1 was cleaned in session #11; profiles 4/5/7/8 confirmed clean before this ran). Does not affect rows where `workout_id IS NULL` — `extract-exercises` can insert one, and NULL FK values are always valid. See `migrations/2026-07-17_exercises_workout_fk_cascade.sql`.

```sql
ALTER TABLE exercises
  ADD CONSTRAINT exercises_workout_id_fkey
  FOREIGN KEY (workout_id) REFERENCES workouts(id)
  ON DELETE CASCADE;
```

### Daily sleep (2026-05-24)
Adds the `daily_sleep` table backing the Life OS sleep fast-path. Stores hours, the computed personal sleep score, the stage-minute breakdown, and the morning HRV/RHR snapshot per profile per day. See `migrations/2026-05-24_daily_sleep.sql`.

```sql
CREATE TABLE IF NOT EXISTS daily_sleep (
  id bigint generated always as identity primary key,
  profile_id bigint references profiles(id) on delete cascade,
  date date not null,
  hours numeric(4,2),
  score int,
  deep_minutes int,
  rem_minutes int,
  light_minutes int,
  wake_minutes int,
  hrv numeric(6,2),
  rhr int,
  source text default 'fitbit',
  created_at timestamptz default now(),
  UNIQUE(profile_id, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_sleep_profile_date ON daily_sleep(profile_id, date DESC);
```

### Structured macro roadmap (2026-05-22)
Adds the structured macro roadmap columns. The legacy `roadmap` (text) column stays and is still used by the current client. See `migrations/2026-05-22_roadmap_data.sql`.

```sql
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS roadmap_data jsonb,
  ADD COLUMN IF NOT EXISTS roadmap_data_updated_at timestamptz;
```

### Dismissed Fitbit activities (2026-05-22)
Backs the Today-tab "Unmatched Fitbit Activities" card's Dismiss action. A dismissal is global (not tied to one workout), but `rejected_wearable_matches.workout_id` is `NOT NULL`, so dismissals are stored as an array of namespaced `fitbit:<activityId>` strings on the profile instead. See `migrations/2026-05-22_dismissed_fitbit_activities.sql`.

```sql
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS dismissed_fitbit_activities jsonb DEFAULT '[]'::jsonb;
```

### Gym access fields (2026-05-18)
Two top-level columns on `profiles` populated from the Profile Builder "Lifestyle & Schedule" section. Injected into the daily-rec system prompt (after `AVAILABLE EQUIPMENT`), the `POST /api/profiles/:id/goal-progress` distance + general AI prompts, and the roadmap prompt. PATCH `/api/profiles/:id` accepts both via `PROFILE_BODY_FIELDS`. `gym_type` is cleared to null whenever `gym_access` is set to anything other than `'yes'`.

```sql
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS gym_access text,
  ADD COLUMN IF NOT EXISTS gym_type text;
```

### Dead Hang canonicalization (2026-05-09)
Existing exercises rows were inserted before "hang"/"hanging"/"dead hangs" were aliased to the canonical "Dead Hang" name. Re-canonicalize them in place so the micro-goal auto-tracker can match them.

```sql
UPDATE exercises
SET name = 'Dead Hang'
WHERE LOWER(name) IN ('hang', 'hangs', 'dead hang', 'dead hangs', 'hanging', 'bar hang', 'bar hangs', 'passive hang', 'passive hangs')
AND profile_id = 1;
```

## Past-Date Workout Logging

The Log Workout modal exposes a real `<input type="date">` (max=today) so users can log a missed session against any past date. Picking a past date shows a "Logging for [Day, Month Date] — this will be saved to that date" banner; today is the default.

- **Server validation**: `POST /api/workouts` rejects malformed or future-dated `date` fields (400).
- **Cache**: past-date saves invalidate `progress_brief` (the 14-day pattern analysis covers any date in window) but NOT `daily_recommendations` — a workout logged for a past date doesn't change today's biometric/schedule context. The client also skips its `fetchAI()` regen for past-date saves.
- **History tab**: when viewing a past day with no entry, a "+ Log workout for this day" button opens the modal pre-set to that date.

## Goal Check-in (Log Modal)

The log modal renders an "Active Challenges" section listing every active, incomplete micro-goal. Each row's input mode depends on the goal type:

- **daily_habit / streak** with a recognizable canonical exercise → "Mark as done" checkbox; toggling appends the canonical exercise name to the notes textarea so the existing extract-exercises pipeline picks it up and the auto-tracker increments the streak.
- **strength_milestone** with unit `seconds`/`minutes` → numeric input ("My best today: ___ seconds"); appends `{Canonical} {N} {unit}`.
- **strength_milestone** with weight unit (lbs etc.) → numeric input; appends `{Canonical} 1x1 @ {N}lbs`.
- **cumulative_volume** with a recognizable canonical exercise → "+__ {unit} today" numeric input; appends `{Canonical} {N} {unit}`.
- **weekly_frequency / recovery_balance / skill_technique** → info-only (auto-tracked or manual).

The check-ins are merged into the notes textarea before the workout is saved, so they ride through the existing extract-exercises + auto-tracker flow. After save, `loadMicroGoals()` runs and `checkMicroGoalCompletions()` triggers `fireConfetti()` for any newly-completed goal.

## Analytics

Two read-only analytics endpoints (all aggregation done in Node after PostgREST fetches; all date math server-side; both degrade gracefully to N/A with no wearable connected).

### Workout Analytics Dashboard
`GET /api/analytics/activity-stats/:userId?start_date=&end_date=` (userId = profile_id; omit dates = all-time).
- Buckets workouts by **inferred category** via `inferWorkoutCategoryServer()` — a server-side mirror of the client `inferWorkoutCategory()` (strength/cardio/martial_arts/sports/mind_body/rehab/rest/other → `CATEGORY_PRETTY_SERVER` labels). Keep the two in sync.
- Per-workout metrics resolve via `sessionMetrics(w)`: **`wearable_data` JSONB first, then a `notesMetrics()` fallback that regex-parses HR / calories / (Fitbit-only) duration out of the notes string.** This matters because legacy Fitbit auto-imports (`/fitbit-import`) store HR/calories in `notes` ONLY and never populate `wearable_data` — without the fallback, avg/peak HR shows N/A for every auto-imported session. Duration precedence: wearable_data.duration_minutes → notes (Fitbit) → summed `exercises.duration_minutes` → 0. The workouts query selects `wearable_data`+`wearable_activity_id` but falls back to a select without them if the columns don't exist, and logs a one-line diagnostic per request (`withWearableData / withWearableHR / withNotesHR / wearableActivityId / activityId+HR`). The `activityId+HR` count exposes whether wearable-synced sessions actually carry `wearable_data.avg_hr` — if it's low, Fitbit didn't return averageHeartRate for those activities (no HR strap), not a query bug.
- Returns `overall` (total_workout_minutes, total_sessions, total_calories, avg_min_per_session, avg_calories_per_session, avg_hr, peak_hr, most_active_day_of_week, current_streak, longest_streak — streaks scoped to the queried window), `comparison` (current vs previous same-length window for total_minutes/sessions/calories/avg_hr; null for all-time), and `activities[]` sorted by total_minutes desc. Each activity: total_sessions, total_minutes, avg_min_per_session, avg_hr, peak_hr, total_calories, avg_calories_per_session, `trend_minutes`/`trend_avg_hr` (`{current, previous, pct, direction: up|down|stable}`, ±5% threshold), and `recent_sessions` (last 10: date, duration, avg_hr, peak_hr, calories).
- **UI**: collapsible `#analytics-card` on the Profile tab, above Active Challenges. Lazy-loads on first expand (reloads on profile switch). 7D/30D/90D/1YR/All/Custom pill bar (`anRangePills`). An **Overview / By Activity** toggle (`setAnalyticsMode`): Overview shows totals + green/red deltas, an averages row (avg min/session, avg cal/session, avg HR, peak HR), and a streaks row. By Activity lists per-activity collapsible rows whose subtitle shows avg HR + avg min/session without expanding. Clicking a row **isolates** it — `toggleActivityRow` resets `analyticsState.open` so all others collapse, expands only the clicked one, and promotes it to the headline dashboard (`anActivityHeadline`: that type's total min/sessions/calories/avg HR/peak HR); the "← All Activities" link (`clearActivityDrill`) clears the selection and collapses everything.

### Library Exercise Analytics
`GET /api/analytics/exercise-stats/:userId/:exerciseName?start_date=&end_date=`.
- Aggregates `exercises` rows where `name=eq.` matches. A row stores `sets`×`reps` (set count, reps-per-set); rows with reps but no set count = 1 set.
- Per day (`daily_data`, sorted asc for charting): highest_set (max reps in one set), total_reps (Σ sets×reps), total_sets, max_weight, plus `highest_hold`/`total_seconds` for time-based moves. Aggregate: total_reps, avg_reps_per_set, best_single_set, best_volume_day `{date,total_reps}`, total_sessions (distinct days), is_weight_based, max_weight_ever, estimated_1rm (Epley `weight×(1+reps/30)`, max over all sets). Weight fields null for bodyweight exercises.
- **Duration-based exercises** (Dead Hang, Plank, etc. — `is_duration_based` = has hold data and no reps): per-hold seconds come from `duration_minutes×60`, else `parseDurationToSeconds(raw_text||notes)`. Adds `total_seconds`, `avg_seconds_per_set`, `best_hold_seconds`, `best_duration_day {date,total_seconds}`. The UI switches charts/labels/stat boxes to seconds ("Best Hold (SECONDS/DAY)", "Total Duration (SECONDS/DAY)", `anFmtSec` for m:ss).
- **UI**: added to the Library exercise detail view (`#lib-ex-analytics`, populated by `loadExAnalytics`). Same pill-bar filter; two Chart.js charts (Best Set/Hold line + Total Volume/Duration bar, side-by-side desktop / stacked mobile via flex-wrap); 4 stat boxes (+2 weight boxes when weight-based). Chart instances stored in `libCharts.exBest`/`libCharts.exVolume`.
- The detail view's legacy **"Progress Over Time"** chart (`renderExDetailChart`, fed by `GET /api/profiles/:id/exercises/:name`) is also duration-aware: it detects duration-based exercises client-side (a client copy of `parseDurationToSeconds` + `!hasReps`) and plots seconds with a "Seconds" Y-axis and an `fmtMMSS` (M:SS) tooltip.
- The grouped `GET /api/profiles/:id/exercises` endpoint adds `best_duration_seconds` per exercise (duration_minutes×60 or parsed from raw_text/notes). The Library list card shows it as the right-side stat (M:SS) for duration-based moves that have no reps/weight.
- The Library exercises **list** sort is a dropdown `<select>` (`setLibSort`): Most Logged / Least Logged / A→Z / Z→A / Most Recent / Least Recent, default Most Logged, persisted to `localStorage.ac_lib_sort` and applied in `filterLibExercises` via `applyLibSort`.
- The Library dashboard's "workout distribution" doughnut (`#lib-donut`) uses a fixed-height (`position:relative;height:240px`) container + `maintainAspectRatio:false` to stop the Chart.js responsive shrink/grow loop.

Shared client helpers: `anYmd`, `anFmtNum`, `anFmtSec`, `fmtMMSS`, `parseDurationToSeconds`, `anResolveRange`, `anRangePills`.

## Maintenance Instructions

This file should be kept up to date as the project evolves. After any significant change - new features, schema changes, new endpoints, formula updates, or architectural decisions - update the relevant section of this CLAUDE.md automatically as part of the commit. This way the file always reflects the current state of the project.
