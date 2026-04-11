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

## App Structure (public/index.html)

- Profile selector screen on load (PIN protected)

- 4 tabs: Today, Calendar, Log, Profile

- Today tab: Fitbit biometrics + readiness score + progress brief + 3 AI workout options

- Calendar tab: Week/Month toggle view with workout dots

- Log tab: Full workout history with edit capability

- Profile tab: Dynamic from profile_data JSON - goals, injuries, belt tracker (if martial arts), schedule, philosophy

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

- GET /api/profiles/:id/brief — returns coaching_brief, historical_brief, historical_brief_updated_at

- POST /api/profiles/:id/generate-brief — generates coaching briefs from workout history (two AI calls)

- POST /api/profiles/:id/search-history — natural language search across all workout history

## Coaching Memory System (Three-Tier)

Three-tier AI memory system stored in Supabase profiles table:

1. **Historical Brief** (historical_brief column) — long-term training summary generated from all workouts beyond the last 30. Regenerated monthly or on demand. Covers consistency patterns, exercise progressions, injury history, and milestones.

2. **Coaching Brief** (coaching_brief column) — living analysis of the last 30 sessions, regenerated after every workout save. Covers recent patterns, exercise trends, injury status, what's working, and what needs attention. Includes historical context.

3. **History Search** (search-history endpoint) — on-demand natural language search across the complete workout history. Powers the "Ask Your History" feature on the Log tab.

Both briefs are injected into the daily AI coaching prompt (before FULL_PROFILE) so recommendations reference training history. The coaching brief card is displayed on the Profile tab with a collapsible historical section.

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
- ac_schedule — weekly schedule
- ac_belt — current belt level

## Environment Variables (on Render)

FITBIT_CLIENT_ID, FITBIT_CLIENT_SECRET, SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_KEY, ADMIN_SECRET

## Developer Tools

These browser console utilities are available for testing and debugging:

- `window.testStreak(days)` - Test streak display with any number of days. Example: `testStreak(30)` shows legendary mode, `testStreak(0)` shows broken streak

- `localStorage.removeItem('ac_cache')` then `location.reload()` - Force clear Fitbit cache and fetch fresh data

- `localStorage.clear()` then `location.reload()` - Nuclear option, clears everything including profile (will show profile selector)

These are intentionally left in production — they require console access and are invisible to regular users.

## Maintenance Instructions

This file should be kept up to date as the project evolves. After any significant change - new features, schema changes, new endpoints, formula updates, or architectural decisions - update the relevant section of this CLAUDE.md automatically as part of the commit. This way the file always reflects the current state of the project.
