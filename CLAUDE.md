# ApexCoach — Project Context

> See [`ROADMAP.md`](ROADMAP.md) for the project source of truth — full schema, all endpoints, features built (with commit refs), provider status, roadmap, onboarding flow, tech debt, and env vars. This file holds the deep implementation notes; `FORMULAS.md` holds the readiness/sleep math.

## What This Is

ApexCoach is a personalized AI fitness coaching web app. Users connect their Fitbit, which auto-syncs sleep/HRV/RHR/zone minutes daily. A custom readiness formula scores recovery (0-100), and Claude AI gives specific daily workout recommendations based on biometrics and training history.

## Tech Stack

- Frontend: Vanilla HTML/CSS/JS in public/index.html (single page app)

- Backend: Node.js + Express in server.js

- Database: Supabase (PostgreSQL)

- AI: Anthropic via /api/ai proxy. Smart tasks (daily recs, briefs, roadmap, onboarding, profile builder) use `claude-sonnet-4-20250514`; cheap tasks (format, workout title, extract, progress brief, goal description/estimate, exercise insight) use `claude-haiku-4-5-20251001`. Model is selected server-side from a `callType` field the client sends — the client cannot request an expensive model. The `/api/ai` proxy also auto-wraps any string `system` prompt with `cache_control: ephemeral` for prompt caching (~90% discount on repeat input tokens).

- Fitbit: OAuth2 with auto token refresh

- Hosting: Render.com (auto-deploys from GitHub)

- Repo: github.com/shimmyc/apexcoach-backend

## Supabase Tables

- profiles: id, name, pin (sha256 hashed), avatar_color, profile_data (jsonb), fitbit_access_token, fitbit_refresh_token, fitbit_expires_at, coaching_brief (text), historical_brief (text), historical_brief_updated_at (timestamp), roadmap (text — LEGACY free-text macro roadmap, still read/written by /roadmap), roadmap_updated_at (timestamp), roadmap_data (jsonb — structured macro roadmap, served by /roadmap-data), roadmap_data_updated_at (timestamptz), daily_recommendations (jsonb), daily_recommendations_date (date), daily_recommendations_readiness (int), progress_brief (jsonb), progress_brief_date (date), height_inches (numeric), birth_date (date), sex (text), goal_weight_lbs (numeric), goal_weight_timeline_months (int), gym_access (text: yes/no/sometimes), gym_type (text: Commercial gym/Home gym/CrossFit/functional fitness/Multiple), fitbit_pending_imports (jsonb — DEPRECATED, no longer written; see Unmatched Fitbit Activities), dismissed_fitbit_activities (jsonb — array of namespaced "fitbit:<id>" strings the user dismissed from the unmatched-activities card), created_at

- workout_templates: id (bigint identity pk), profile_id (fk → profiles, on delete cascade), name (text), type (text), notes_template (text), exercises (jsonb), use_count (int default 0), created_at (timestamptz). Saved routines surfaced as ▶ Use buttons on Today and a manager on Profile.

- workouts: id, date, type, notes, done, mobility, med, ts, profile_id

- exercises: id, profile_id, workout_id, date, name, category (strength/cardio/martial_arts/mind_body/rehab/sports/other), main_category (same as category, normalized), subcategory (specific sub-type), sets, reps, weight_lbs, distance_miles, duration_minutes, notes, raw_text, created_at

- daily_checkins: id, profile_id, date (text, YYYY-MM-DD), energy (text), soreness (text[]), severity (text), checkin_text (text), created_at. UNIQUE(profile_id, date) for upsert.

- micro_goals: id (uuid pk), profile_id (fk → profiles), title (text), type (text: daily_habit | weekly_frequency | cumulative_volume | strength_milestone | skill_technique | streak | recovery_balance), target_value (numeric), target_unit (text), period (text: daily | weekly | monthly | custom), end_date (date, nullable), current_value (numeric default 0), is_active (boolean default true), created_at (timestamp default now()).

- daily_steps: id (bigint identity pk), profile_id (fk → profiles, on delete cascade), date (date), steps (int), calories (int), distance_miles (numeric), floors (int), source (text default 'fitbit'), created_at (timestamptz default now()). UNIQUE(profile_id, date). Upserted nightly from Fitbit sync; powers history-tab step pills, Library 30-day chart, and step-goal context in the AI rec prompt.

- body_metrics: id (bigint identity pk), profile_id (fk → profiles, on delete cascade), date (date), weight_lbs (numeric), body_fat_pct (numeric), bmi (numeric), source (text default 'manual', also 'fitbit'), created_at (timestamptz default now()). UNIQUE(profile_id, date). Stores weight / BF% / BMI history. Upserted from `/1/user/-/body/log/{weight,fat}/date/today.json` via Fitbit sync, or manually via the Today-tab "Log Weight" modal. BMI is computed server-side as `(weight_lbs / height_inches²) × 703` when `profiles.height_inches` is set.

- daily_sleep: id (bigint identity pk), profile_id (fk → profiles, on delete cascade), date (date), hours (numeric(4,2)), score (int — the COMPUTED personal sleep score, NOT Fitbit's), deep_minutes / rem_minutes / light_minutes / wake_minutes (int), hrv (numeric(6,2)), rhr (int), source (text default 'fitbit'), created_at (timestamptz default now()). UNIQUE(profile_id, date). Upserted nightly from the Fitbit sync (`GET /api/profiles/:id/daily`) and on the `life-os-summary` fallback path. Powers the Life OS fast path: `life-os-summary` reads this first and returns sleep/HRV/RHR instantly with no live Fitbit call once the day's row exists. See migration `2026-05-24_daily_sleep.sql`.

## Row Level Security (RLS)

Row Level Security is enabled on **all 11 Supabase tables**: `profiles`, `workouts`, `exercises`, `daily_checkins`, `micro_goals`, `daily_steps`, `body_metrics`, `workout_templates`, `wearable_connections`, `rejected_wearable_matches`, `tokens`. Each table has a `service_role_bypass` policy, so the backend — which authenticates with the Supabase **service key** (`SUPABASE_KEY`) — keeps full access while public **anon**-key access is now closed. Because `server.js` talks to PostgREST with the service role, RLS is transparent to the app and no query changes were needed; this closes the prior gap where the anon key could read/write tables directly.

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

- Today tab: Fitbit biometrics + readiness score + progress brief + 3 AI workout options

- History tab: merged Calendar + Log with toggle buttons. Calendar view: Week/Month with workout dots. List view: collapsible workout cards with sort/filter, "Ask Your History" AI search

- Library tab: Exercise dashboard, exercises list, personal records (Chart.js)

- Profile tab: Dynamic from profile_data JSON - goals, injuries, belt tracker (if martial arts), schedule, philosophy

- + button: opens Log Workout modal directly (not a tab) — no type dropdown, just a notes textarea with voice input and quick-log shortcuts (MMA, Walk, Rest Day). Workout type/title is AI-generated from notes on save.

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

- GET /api/workouts?profile_id= — workout history

- POST /api/workouts — save workout

- PATCH /api/workouts/:id — edit workout

- PATCH /api/profiles/:id — update profile data (also accepts name, avatar_color top-level)

- PATCH /api/profiles/:id/pin — change PIN

- DELETE /api/profiles/:id — delete profile + all workouts (requires PIN in body)

- POST /api/ai — Anthropic API proxy

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

**System prompt (`buildSystemPrompt`)** — persona, coaching style, equipment/location/duration prefs, rules, and JSON response shape. Opens with the ApexCoach persona: "an elite, deeply personal AI fitness coach… You adapt to real human life… You never suggest something contraindicated by their injuries. You always factor in their micro-goals as non-negotiable daily commitments." Rules include the compound Posture/PT add-on on every Strength session (naming 2–3 specific movements). When called in `mode: 'reroll'` the system prompt appends an instruction to generate meaningfully different options than the previously-shown headlines. When called in `mode: 'category'` it narrows to a single category.

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
  - **Daily sync:** `GET /api/profiles/:id/daily` **prefers Google Health when connected**, using the local date; falls through to the Fitbit path when GH returns nothing (`hasData` gate over hrv/rhr/sleep/steps). An amber **reconsent banner** (`showGoogleHealthBanner()`, Profile tab + Settings → Account) prompts Fitbit users to migrate.
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

## Active Challenges (Micro-Goals)

Short-horizon, specific, measurable challenges that the AI weaves into EVERY daily recommendation. Separate from the long-term goal priority list — goals set direction, challenges set the next concrete target.

**Types** (`micro_goals.type`): `daily_habit`, `weekly_frequency`, `cumulative_volume`, `strength_milestone`, `skill_technique`, `streak`, `recovery_balance`.

**Auto-tracking** (server recomputes `current_value` on every GET):
- `cumulative_volume` — sums `sets*reps` (or `duration_minutes` if unit is minutes, `distance_miles` if unit is miles/km) from exercises matching title keywords since `created_at`
- `weekly_frequency` — counts workouts in current week (Mon-Sun) matching title keywords
- `streak` — consecutive days with `done=true` workouts ending today/yesterday
- `daily_habit` — distinct days the activity was logged, unioning (a) days with a matching `exercises` row and (b) days a workout's notes/type mention the canonical exercise even when the AI extractor never pulled an `exercises` row for it (`mgHabitDaySources` + `mgWorkoutTextMatches`, with a word-boundary guard so "hanging leg raise" etc. don't false-match the bare "hang"). This backstops extraction misses that silently dropped real habit days.
- `strength_milestone` — best single-effort across matching exercises, branched on `target_unit`: **weight** (`lbs`, or `kg`/`kgs`/`kilograms` converted from the stored `weight_lbs`) → max `weight_lbs`; **time** (`seconds`/`minutes` & aliases) → max hold duration, preferring `parseDurationToSeconds(raw_text||notes)` over the often-mis-populated `duration_minutes` column, with aspirational/goal-statement rows (e.g. "Dead Hang - work toward 2:00 goal") skipped via `mgIsAspirationalEntry()`; **reps** (`reps`/`rep`) → max single-set `reps`; **distance** (`miles`/`mi`, or `km`/`kilometers` converted from miles) → longest single-session `distance_miles`. Weight uses the `main_category=strength` filter; time/reps/distance do not (calisthenics/cardio rows are categorized differently).
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

**Supabase setup** — run once in SQL editor:
```sql
CREATE TABLE IF NOT EXISTS micro_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
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

- **Legacy text roadmap (`profiles.roadmap`)** — `GET/POST /api/profiles/:id/roadmap` are KEPT and still read/written, and the legacy client fns (`loadRoadmap`/`renderRoadmapContent`/`generateRoadmap` + the hidden `#roadmap-card`) remain defined. The new system never writes the text column.
- **Profile-tab UI (structured card)** — the Profile tab now renders the structured roadmap via `renderRoadmapData()` into `#roadmap-data-card` (scoped CSS `#roadmap-data-card .rd-*`, matching the `grv*` per-goal roadmap visual language). The Profile render path calls `loadRoadmapData()` (GET → cache in module vars `currentRoadmapData`/`currentRoadmapUpdatedAt`/`roadmapDataLoaded` → render) **instead of** the legacy `loadRoadmap()`; the legacy text card is no longer shown. Empty state = "MACRO ROADMAP" + Generate button + subtext. Loaded state (in order): header (timeline_range in Fraunces + note + muted Regenerate link), `COVERS` goal pills, 3 near-term phase cards (status badge current=ember/upcoming=muted/complete=positive, progress bar capped at 90% unless complete, duration/end-date, weekly_targets `•`, completion_signals `☐`/`☑`, cornerman goal_connections pills), 2 horizon cards (info `HORIZON` badge + milestone + estimated_range), exercise callouts (`GAPS TO ADDRESS` caution-bordered ⚠ / `WHAT'S WORKING` positive-bordered ✓; section skipped if both empty), collapsible adaptation log ("Show history (N updates)"), and a `Generated [date] · v[version]` footer. `generateRoadmapData(isRegen)` POSTs `/roadmap-data` (in-card spinner, non-fatal toast on failure) and on success caches the result so re-renders don't refetch; Regenerate uses an inline Yes/Cancel confirmation (no modal).
- **Endpoints**: `GET /api/profiles/:id/roadmap-data` (returns `roadmap_data` + `roadmap_data_updated_at`, or `{roadmap_data:null}`; `progress_pct` recomputed on read). `POST /api/profiles/:id/roadmap-data` generates via Sonnet (`macro_roadmap_generate`) using `getFullExerciseContext(90)` + per-goal contexts + last 30 workouts + coaching brief (600 chars) + `ai_prompt_context` (1000 chars); no intake gate.
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

**`fitbit_pending_imports` fully deprecated**: the daily Fitbit sync no longer calls `diffAndQueueFitbitImports()`, so `profiles.fitbit_pending_imports` is never written anymore — this card computes unmatched activities on demand instead. The function `diffAndQueueFitbitImports()` and the `GET /api/profiles/:id/fitbit-pending-imports` + `POST /api/profiles/:id/fitbit-import` endpoints remain defined for back-compat but are dead code: no caller writes the queue and the client no longer reads it (the `loadFitbitPendingImports` / `renderFitbitImportPrompts` / `confirmFitbitImport` / `dismissFitbitImport` functions were removed). The `fitbit_pending_imports` column is left in place (harmless; safe to drop later). The save-time auto-import `wm-modal` prompt (see Auto-Import on Workout Save) is unaffected and still useful for immediate post-save matching.

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
- `GET  /api/wearables/providers/:userId` — list providers + connection status
- `POST /api/wearables/connect/:provider`  — returns `auth_url` for OAuth
- `POST /api/wearables/disconnect/:provider`
- `GET  /api/wearables/sync-backlog/:userId?provider=&start_date=&end_date=` — returns `{ matched, unmatched, already_synced }`
- `POST /api/wearables/merge/:userId`  — attach wearable session to an existing workout
- `POST /api/wearables/reject/:userId` — record rejection + create standalone wearable workout
- `POST /api/wearables/import/:userId` — create standalone workout from an unmatched session
- `POST /api/debug/backfill-wearable-hr/:userId?provider=fitbit[&max_intraday=N]` — two-pass HR repair (see HR-loss fix below); gated by `ADMIN_SECRET` (query `secret=` or `x-admin-secret` header) when that env var is set. Pass 1 fills `avg_hr`/`calories`/`zones` from the list endpoint; pass 2 derives `peak_hr` via the same priority chain as `fetchActivityDetail` — (a) reuse stored `heart_rate_samples` (free), (b) TCX `MaximumHeartRateBpm` (Server-type apps, needs only the activity id), (c) intraday HR max bpm (Personal-type apps, needs the time window). Provider calls (TCX + intraday) are throttled ~1/sec and non-fatal per session. `?max_intraday=N` caps total provider calls per run (idempotent — re-run to continue). Returns `{ checked, updated, skipped, errors, updated_peak_hr, peak_hr_from_samples, peak_hr_from_tcx, peak_hr_from_intraday, peak_hr_skipped, peak_hr_errors }` — the `peak_hr_from_*` split shows which path is working.

**HR-loss fix (list-vs-detail)**: Fitbit's `/activities/{logId}.json` detail endpoint (used by `fetchActivityDetail`) returns a payload **without `averageHeartRate`**, while the list endpoint (`fetchActivities`) carries it. Originally merge/import stored only the detail result, so `wearable_data.avg_hr` was null for synced sessions. Fix: the sync-backlog response already includes the full normalized list `activity` per matched/unmatched item; the client passes it back as `list_activity` on merge/reject/import, and `mergeListHr(adapter, detail, listActivity)` fills the HR fields (`avg_hr, peak_hr, zones, calories, active_zone_minutes`) the detail dropped — **detail wins for fields it already has**. `listActivity` may be already-normalized (sync-backlog) or a raw provider entry (the adapter's optional exported `normalize()` handles that). Bulk-action passes `activity` through too. The backfill endpoint repairs rows synced before this fix: pass 1 re-reads `avg_hr` from the list endpoint for any `wearable_activity_id IS NOT NULL` row whose `wearable_data.avg_hr` is null. Because the list endpoint carries `averageHeartRate` but **not `maxHeartRate`**, `peak_hr` can never be filled from it. Two peak sources exist: (1) on the forward sync path, `fetchActivityDetail` tries the activity's **TCX export** (`/1/user/-/activities/{logId}.tcx`) and parses `MaximumHeartRateBpm` — available to Server-type apps even when intraday is denied — then falls back to intraday HR samples (Personal-type apps); (2) the backfill endpoint's pass 2 derives `peak_hr` from intraday samples (reusing stored `heart_rate_samples` for free, else fetching the intraday window). The analytics read (`wearableMetrics`) also derives `peak_hr` from `heart_rate_samples` on the fly when the explicit field is absent, and as a last resort estimates a peak-HR **floor** from the highest HR zone the session recorded time in (Fitbit zone floors: peak 185 / vigorous 163 / moderate 108 bpm). Zone-estimated values are flagged `peak_hr_est=true` and surfaced through `sessionMetrics` → the activity-stats response (per-session `recent_sessions`, per-activity, and `overall`); the analytics UI (`anFmtPeak`) renders them as e.g. `185+ bpm (est.)`. On a tie a measured peak beats an estimate when aggregating the max.

**Token storage**: `wearable_connections (profile_id, provider, access_token, refresh_token, token_expires_at, last_synced_at)`. `getValidWearableToken()` auto-refreshes expired tokens; refresh failure throws with `code: "RECONNECT_REQUIRED"` mapped to HTTP 401 so the UI can prompt reconnection.

**Dedupe**: `workouts.wearable_activity_id` is unique (when not null) and stored in `"provider:id"` form so the same numeric id from two providers cannot collide. `rejected_wearable_matches` keeps backlog sync idempotent — rejected pairings don't re-appear on subsequent runs.

**Coexistence with legacy Fitbit code**: `profiles.fitbit_access_token`/`refresh_token`/`expires_at` columns and the `buildDailyData` / `runFitbitBackfill` flows are untouched. Token writes are mirrored to both stores. The legacy auto-import queue path (`diffAndQueueFitbitImports` + `/api/profiles/:id/fitbit-pending-imports` + `/api/profiles/:id/fitbit-import`) is now **deprecated dead code** — the daily sync no longer calls it, nothing writes `profiles.fitbit_pending_imports`, and the client no longer reads it; the Today-tab "Unmatched Fitbit Activities" card replaced it. The new explicit `sync-backlog` path remains the bulk-review flow.

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

## Migrations

One-time data fixes that should be run in the Supabase SQL editor.

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
