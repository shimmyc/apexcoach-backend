# ApexCoach — Project Context

## What This Is

ApexCoach is a personalized AI fitness coaching web app. Users connect their Fitbit, which auto-syncs sleep/HRV/RHR/zone minutes daily. A custom readiness formula scores recovery (0-100), and Claude AI gives specific daily workout recommendations based on biometrics and training history.

## Tech Stack

- Frontend: Vanilla HTML/CSS/JS in public/index.html (single page app)

- Backend: Node.js + Express in server.js

- Database: Supabase (PostgreSQL)

- AI: Anthropic claude-sonnet-4-20250514 via /api/ai proxy

- Fitbit: OAuth2 with auto token refresh

- Hosting: Render.com (auto-deploys from GitHub)

- Repo: github.com/shimmyc/apexcoach-backend

## Supabase Tables

- profiles: id, name, pin (sha256 hashed), avatar_color, profile_data (jsonb), fitbit_access_token, fitbit_refresh_token, fitbit_expires_at, coaching_brief (text), historical_brief (text), historical_brief_updated_at (timestamp), created_at

- workouts: id, date, type, notes, done, mobility, med, ts, profile_id

- exercises: id, profile_id, workout_id, date, name, category (strength/cardio/mobility/mma/rehab/other), sets, reps, weight_lbs, distance_miles, duration_minutes, notes, raw_text, created_at

- daily_checkins: id, profile_id, date (text, YYYY-MM-DD), energy (text), soreness (text[]), severity (text), checkin_text (text), created_at. UNIQUE(profile_id, date) for upsert.

## App Structure (public/index.html)

- Profile selector screen on load (PIN protected)

- 4 tabs: Today, History, Library, Profile + floating action button (+) for Log Workout

- Navigation: bottom tab bar on mobile (below 768px) with FAB center button, top horizontal nav on desktop

- Today tab: Fitbit biometrics + readiness score + progress brief + 3 AI workout options

- History tab: merged Calendar + Log with toggle buttons. Calendar view: Week/Month with workout dots. List view: collapsible workout cards with sort/filter, "Ask Your History" AI search

- Library tab: Exercise dashboard, exercises list, personal records (Chart.js)

- Profile tab: Dynamic from profile_data JSON - goals, injuries, belt tracker (if martial arts), schedule, philosophy

- + button: opens Log Workout modal directly (not a tab)

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

- GET /api/workouts?profile_id= — workout history

- POST /api/workouts — save workout

- PATCH /api/workouts/:id — edit workout

- PATCH /api/profiles/:id — update profile data (also accepts name, avatar_color top-level)

- PATCH /api/profiles/:id/pin — change PIN

- DELETE /api/profiles/:id — delete profile + all workouts (requires PIN in body)

- POST /api/ai — Anthropic API proxy

- GET /api/profiles/:id/checkin?date= — get daily feeling check-in for a date

- POST /api/profiles/:id/checkin — upsert daily feeling check-in (syncs across devices)

- POST /api/profiles/:id/generate-goal-description — AI generates motivating goal description from title

- POST /api/profiles/:id/goal-progress — calculates progress for all goals using workout data + AI deduction

- GET /api/profiles/:id/brief — returns coaching_brief, historical_brief, historical_brief_updated_at

- POST /api/profiles/:id/generate-brief — generates coaching briefs from workout history (two AI calls)

- POST /api/profiles/:id/search-history — natural language search across all workout history

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

Exercises are auto-extracted from workout notes by Claude AI on every workout save and stored in the exercises table. Categories: strength, combat, cardio, mobility, rehab, core, other. The Library tab has three views:

1. **Dashboard** — workout type donut chart (Chart.js), weekly volume bar chart, top 6 exercises grid, quick stats row
2. **Exercises** — searchable/filterable list of all exercises with category pills, click for detail view with progression chart, session history, and AI insight
3. **Records** — personal records (heaviest lift, most reps, longest distance), all-time aggregated stats

### Endpoints
- `POST /api/profiles/:id/extract-exercises` — AI extracts exercises from workout notes, inserts into exercises table
- `GET /api/profiles/:id/exercises` — all exercises grouped by name with counts, filtered by ?name= or ?category=
- `GET /api/profiles/:id/exercises/stats` — aggregate stats (type frequency, top exercises, PRs, weekly volume)
- `GET /api/profiles/:id/exercises/:name` — full history for one exercise with PR data

### Auto-Extraction
- Triggered silently after every workout save (if notes exist)
- "Import History" button on Library tab backfills from existing workouts
- Exercise names are normalized by AI (e.g., "glute bridges 3x12" → "Glute Bridge")
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

- Google Fit / Garmin: planned, have public APIs, buildable

- Apple Watch: requires iOS app bridge, longer term

- Whoop: API is invite-only, not yet accessible

- Samsung Health: requires partnership approval

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

10 themes using CSS custom properties: apex (default), midnight, carbon, forest, crimson, arctic (light), sunset, monochrome, purple, gold. All colors use var() references. JS TC object mirrors CSS vars for dynamic HTML generation.

## Profile Data Fields

- profile_data.avatar_image — base64 JPEG string (200x200), displayed as circular photo
- profile_data.fitbit — true/false
- profile_data.wearable — device name string or null (Fitbit, Apple Watch, Garmin, Whoop, Samsung, Other)
- profile_data.profile_sections_completed — array of completed deep profile sections
- profile_data.onboarding_complete — boolean

## localStorage Keys

- ac_theme — current theme name
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

FITBIT_CLIENT_ID, FITBIT_CLIENT_SECRET, SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_KEY, ADMIN_SECRET

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

## Auto-Format Notes

Workout notes can be auto-formatted by Claude AI on save. Controlled by `ac_auto_format` in localStorage (default: true). Toggle available in the Log Workout modal toolbar and Settings → AI Coaching. When enabled, notes are formatted into clean structured lists before saving. Falls back to unformatted save on AI error.

## Auto-Generate Goal Description

When adding a goal without a description, the system auto-generates one via `POST /api/profiles/:id/generate-goal-description`. Shows "Generating description..." placeholder while loading, then fills in the AI-generated text.

## Developer Tools

These browser console utilities are available for testing and debugging:

- `window.testStreak(days)` - Test streak display with any number of days. Example: `testStreak(30)` shows legendary mode, `testStreak(0)` shows broken streak

- `localStorage.removeItem('ac_cache')` then `location.reload()` - Force clear Fitbit cache and fetch fresh data

- `localStorage.clear()` then `location.reload()` - Nuclear option, clears everything including profile (will show profile selector)

These are intentionally left in production — they require console access and are invisible to regular users.

## Maintenance Instructions

This file should be kept up to date as the project evolves. After any significant change - new features, schema changes, new endpoints, formula updates, or architectural decisions - update the relevant section of this CLAUDE.md automatically as part of the commit. This way the file always reflects the current state of the project.
