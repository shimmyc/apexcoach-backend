# Sandbox profile — simulated-history workflow

> Lets you drive the whole PT Brain arc (goal creation → roadmap → coexistence →
> arc decay / re-ramp → session depth) on a fresh profile without waiting real
> months for history to accumulate.
>
> **⚠ THIS CLOSES NO LEDGER ROW.** Rows 11, 13, 19, 20 and 28 in `ROADMAP.md` §7
> are **real-data-only** by definition — they are waiting on genuine athlete
> history or a genuine model response. Seeded history is a development aid for
> *exploring* behaviour. Never mark anything "verified live" off the back of it.

**Profiles 1 and 4 are denylisted and always return 403.** 1 is Shimmy's real
profile; 4 is the PT Brain test bed whose arc state backs open ledger rows.

---

## The workflow, in order

The order matters. Seeding history for a goal that has no linked schedule target
produces **zero qualifying sessions**, and the arc will read `position_week 0`
forever no matter how much history you seed.

### 1. Create the profile — in the app, normally

Profile selector → **+ New Profile** → name + 4-digit PIN. Note its id (visible
in `GET /api/profiles`, or `localStorage.ac_profile_id` in the console).

**Do not seed a profile row.** Onboarding writes `profile_data` the app depends on.

### 2. Create 1–3 goals — through the NORMAL UI flow

Profile tab → **Goals & Milestones** → add a goal → answer the intake → let it
generate the roadmap.

**Never seed goals.** Roadmap generation, the honest-timeline estimate, the
aggressiveness dial and the capacity fit check are *part of what you are
testing*. A hand-written goal row skips all of it.

Good goals to try: one `rehab` (dial is locked — that is the point), one
`strength_load`, one `endurance`.

### 3. Link schedule targets to those goals — the keystone join

Profile tab → **Schedule** card → **Your Training Blueprint ▸ Edit** → add a
**Weekly Target** → tap the goal pills on that target row to link it.

This is what makes a logged session *count* toward a goal's earned position.
Without it the arc falls back to tier-2 keyword matching, which is much weaker.

### 4. Seed history whose names MATCH those targets

A session qualifies (tier-1 `precise`) only when its workout has **≥2 distinct
exercise names that map to the target's muscle groups**. So:

- an **Upper Body Strength** target needs names like `Bench Press`,
  `Dumbbell Row`, `Overhead Press`, `Pull-Up`
- a **Lower Body** target needs `Goblet Squat`, `Romanian Deadlift`, `Reverse Lunge`
- **grip-only** names (`Dead Hang`, `Farmer Carry`) never count toward anything
- a **cardio** target matches on category, so `Easy Run` / `Indoor Bike` is enough

### 5. Open the app and watch

**No wearable means the Today rec sits behind the manual check-in gate** — this is
designed behaviour, not a bug (`ROADMAP.md` §9). Submit the daily check-in on the
Today tab and the rec generates.

---

## Commands (PowerShell)

```powershell
$env:ADMIN_SECRET = (Get-Content .env.claude.txt | Select-String '^ADMIN_SECRET=').ToString().Split('=',2)[1].Trim()
$base = "https://apexcoach-backend.onrender.com"
$pid  = 9        # <-- your sandbox profile id
```

### Write the spec

```powershell
$body = @'
{
  "start_date": "2026-01-05",
  "weeks": 26,
  "gap_windows": [
    { "start": "2026-03-02", "end": "2026-03-29" }
  ],
  "pattern": [
    {
      "session_type": "Strength (Upper Body)",
      "sessions_per_week": 2,
      "category": "strength",
      "subcategory": "upper body",
      "exercises": [
        { "name": "Bench Press",    "sets": 4, "reps": 8,  "weight_lbs": 135 },
        { "name": "Dumbbell Row",   "sets": 4, "reps": 10, "weight_lbs": 45 },
        { "name": "Overhead Press", "sets": 3, "reps": 10, "weight_lbs": 65 }
      ]
    },
    {
      "session_type": "Cardio (Outdoor)",
      "sessions_per_week": 1,
      "category": "cardio",
      "exercises": [
        { "name": "Easy Run", "duration_minutes": 35, "distance_miles": 3.5 }
      ]
    }
  ]
}
'@
Set-Content -Path body.json -Value $body -Encoding utf8
```

### Dry run first — always

```powershell
curl.exe -s -X POST "$base/api/debug/seed-sandbox-workouts/$pid" `
  -H "x-admin-secret: $env:ADMIN_SECRET" -H "Content-Type: application/json" `
  --data "@body.json"
```

Returns the full plan: total sessions, per-week counts, first/last date, how many
were skipped for gaps, and a 10-session preview from each end. **Zero writes.**

### Apply

```powershell
curl.exe -s -X POST "$base/api/debug/seed-sandbox-workouts/$pid`?apply=1&evaluate=1" `
  -H "x-admin-secret: $env:ADMIN_SECRET" -H "Content-Type: application/json" `
  --data "@body.json"

Remove-Item body.json
```

`&evaluate=1` runs one arc evaluation immediately after seeding (pure code, **zero
AI calls**) so `arc_state` reflects the new history without waiting for a save.

### Reset the sandbox

```powershell
# dry run — reports what would go
curl.exe -s -X POST "$base/api/debug/purge-sandbox-workouts/$pid" -H "x-admin-secret: $env:ADMIN_SECRET"

# do it
curl.exe -s -X POST "$base/api/debug/purge-sandbox-workouts/$pid`?apply=1" -H "x-admin-secret: $env:ADMIN_SECRET"
```

Deletes **only** rows carrying the `[SEED]` marker for that profile. Anything you
logged by hand in the app survives.

### Inspect the arc afterwards

```powershell
curl.exe -s "$base/api/profiles/$pid" | ConvertFrom-Json |
  ForEach-Object { $_.profile.profile_data.goals } |
  Where-Object { $_.roadmap.arc_state } |
  ForEach-Object { "$($_.title): pos=$($_.roadmap.arc_state.position_week) cal=$($_.roadmap.arc_state.calendar_week) drift=$($_.roadmap.arc_state.drift) status=$($_.roadmap.arc_state.status)" }
```

---

## Spec reference

| field | meaning |
|---|---|
| `start_date` | `YYYY-MM-DD`. The week grid is anchored to the Monday on/before it; dates before `start_date` are skipped. |
| `weeks` | 1–260. Dates after **today** are always skipped and reported as `skipped_future`. |
| `pattern[]` | One entry per recurring session template. |
| `pattern[].session_type` | Written to `workouts.type` — this is what category inference reads. |
| `pattern[].sessions_per_week` | 1–7, spread deterministically (1→Mon, 2→Mon/Thu, 3→Mon/Wed/Fri, …). |
| `pattern[].days` | Optional explicit `["mon","thu"]`; overrides `sessions_per_week`. |
| `pattern[].category` | `strength` / `cardio` / `martial_arts` / `mind_body` / `rehab` / `sports` / `other`. |
| `pattern[].exercises[]` | `{ name, sets, reps, weight_lbs, duration_minutes, distance_miles }`. Put **≥2 muscle-mapped names** in a session you want to qualify. |
| `gap_windows[]` | `{start, end}` inclusive. No sessions are produced inside. **This is how you drive decay and re-ramp deliberately.** |
| `done` | Defaults `true`. A `false` session never qualifies — useful for testing. |

**Hard limits:** 2000 sessions per plan; profiles 1 and 4 always 403.

**What the seeder does NOT do:** it never calls `POST /api/workouts`, so there is
no `extract-exercises` (Haiku per save), no fire-and-forget roadmap adapt (Sonnet)
and no AI cost during seeding. Rows are written straight to Supabase in the exact
shape the app writes them, including `workout_id` linkage and a `ts` derived from
the date so `GET /api/workouts` (which orders by `ts.desc`) returns them in
chronological order.
