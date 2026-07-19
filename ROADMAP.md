# ApexCoach — Project Roadmap & Source of Truth

> Single reference for anyone joining the project or picking it back up after a break.
> Pairs with `CLAUDE.md` (deep implementation notes) and `FORMULAS.md` (readiness/sleep math).
> Last updated: 2026-07-18.
> **§0 "How We Work — Standing Conventions" is required reading before any session work begins.**
>
> **Doc accuracy notes:** Sections 2, 4, and 10 were verified directly against `server.js`,
> `wearables/`, and `migrations/` rather than transcribed. Where the original brief differed
> from the live code, the doc follows the code and flags it with **⚠ Correction**.
>
> **2026-07-18 session #29** (daily_recs timeout — root-caused + fixed, report-first):
> - **Root cause (NOT the model string):** `MODEL_SONNET="claude-sonnet-4-6"` is valid/active (a retired
>   ID would 404 fast, not hang 90s). The real bug: Render **buffered** the daily_recs `text/plain`
>   "stream" and delivered it in one burst at completion (measured TTFB == total == 45s). The client got
>   no incremental bytes, so its 45s idle timer counted full generation time — a de-facto 45s total cap.
>   The 2200-token **output** generation on Sonnet 4.6 (~40–45s) exceeded it → every attempt aborted →
>   3 retries → `aiPermanentlyFailed` → "Unable to load." Latency driver is the output size, not the
>   input (capped at ~6KB). resolve-batch (session #27, Job 2) is client-side + post-render, never in the rec path.
> - **Fix 1 (minimal, shipped first):** `fetchAI` caps raised — IDLE 45s→120s, MAX 90s→150s; the abort
>   message now reports real elapsed seconds (was hardcoded "(90s)", which fired even for the 45s idle).
>   Verified: server returns a valid rec in ~45s, now inside the window.
> - **Fix 2 (SSE, shipped + verified):** daily_recs switched `text/plain`→`text/event-stream` (scoped;
>   coach_chat unchanged). **Measured live: TTFB 45.1s→1.4s, 93 chunks spread over 38s** — buffering
>   defeated; client reassembly yields valid 3-option rec JSON (110 frames, 0 malformed). Idle timer now
>   works as designed. Loading state streams the "brief" live (`updateRecLoadingProgress`).
> - **Second root cause (surfaced once SSE fixed the timeout):** verbose recs exceeded `max_tokens:2200`
>   and truncated mid-JSON → `extractRecJSON` failed → "could not extract rec JSON" → retries →
>   `aiPermanentlyFailed`. NOT an SSE reassembly bug (reproduced with the real client getReader path;
>   reassembly faithful, fences stripped). Fixed: `max_tokens` 2200→4000 + **conciseness constraints**
>   in `buildResponseShapeSpec` (4–6 exercises/option, short uniform lines, canonical names). **Measured:
>   output ~2300–3665→811 tokens, generation 45–83s→17.4s, parses cleanly.** AI-rec link rate stays
>   content-dependent (31% on a yoga/MMA-heavy day, 0 wrong links) — conciseness removed verbosity as a
>   miss cause; residual misses are qualifier/uncatalogued names. §9 output-half now resolved.
>
> **2026-07-18 session #27** (Exercise-detail reachability + linking + variations — all 3 jobs built):
> - **Job 1 SHIPPED (frontend-only):** (a) **all** Exercise Guide cards clickable (`filterLibGuide`
>   dropped the `isLogged` gate → unlogged rows open session #26's zero-history view; `logged Nx` badge
>   still history-only); (b) deferred **"Log this" CTA** (`.ex-log-cta` in both modes → `logThisExercise`
>   → `prefillLogFromAI('', '', [name], '')`). Exercises list unchanged (history-only, already clickable).
> - **Job 2 SHIPPED (AI-rec name linking, option B):** extracted `matchCatalogExactAlias()` from
>   `resolveExerciseCatalog`'s step-1 (shared, not reimplemented); `stripExerciseAnnotation()` isolates
>   the leading name off a freeform line; **read-only `POST /api/exercise-catalog/resolve-batch`** does
>   exact/alias ONLY — no fuzzy, no Haiku, **no writes** (the browse surface never spawns rows). Client
>   links a line only when it resolved (`aiRecLinkCache`); miss → plain text. **Match rate measured live:**
>   real recovery-yoga rec 8/33 (24%, lift-sparse), strength-day probe 16/20 (80%), **0 wrong matches /53**.
> - **Job 3 SHIPPED + DATA SEEDED:** `variation_group text` column (mirrors wger's own UUID grouping key),
>   seed endpoint `POST /api/debug/seed-exercise-variations` (by `wger_id`), and read-time sibling
>   resolution on `GET /exercises/:name` (`WHERE variation_group=X AND id≠self`, self-heals across
>   merges/renames). Clickable "Variations" section in `showExerciseDetail`. Migration **run in production**
>   + seed run (**~207 variation groups**); re-verified live 2026-07-18 (Lunges→5, RDL→6, Bench Press→10
>   real siblings). See §7.
>
> **2026-07-17 session #26** (Exercise detail view — how-to rendering + zero-history mode;
> frontend + scoped backend, plan approved before edits):
> - **`GET /api/profiles/:id/exercises/:name` now returns `category`/`description`/`images`** via a
>   targeted single-row fetch (by the matched catalog id) — the shared catalog index (grouped
>   `/exercises` over ~865 rows) is left lean so it never carries the large description text. Non-fatal.
> - **How-to section** (`renderExerciseHowTo`) in `showExerciseDetail`, mounted after the muscle
>   diagram: text-first (sanitized `description` via `innerHTML`), `is_main` image as a bonus (capped,
>   lazy, `onerror`-hidden), returns '' when neither exists so the ~70% no-image case reads complete.
>   In-section wger CC-BY-SA credit (Profile footer isn't visible here) + per-image `license_author`
>   only when an image renders.
> - **Zero-history mode**: `showExerciseDetail` branches on `logged = hist.length>0` — unlogged shows
>   name/category/muscle-diagram/how-to + a muted "Not in your log yet.", skipping the stat row, chart,
>   analytics, session list, and AI insight; the post-render calls are guarded behind `if(logged)`.
> - **No "Log this" CTA** (deferred to the AI-rec/Guide clickability session, where the view becomes
>   reachable from unlogged exercises). Video out of scope. CSS id-scoped to `#lib-detail`.
> - **Verified live (backend)**: `/exercises/:name` returns the new fields for both logged (Dead Hang:
>   46 sessions + description) and **unlogged** (Barbell Bench Press: `history:[]` + category/desc/
>   muscles) names; all three content cases confirmed — desc+images (Bench Press/Plank/Deadlift, with
>   `license_author`), desc-only (Squats), neither (Bicep Curl → how-to renders nothing). Inline JS
>   clean. The detail render itself is PIN-gated (Library tab) — spot-check on device.
>
> **2026-07-17 session #25** (Exercise how-to content seed + catalog cleanup prep — backend/data
> only, report-first, plan approved before edits):
> - **Built** `migrations/2026-07-17_exercise_catalog_content.sql` (adds `description` text + `images`
>   jsonb) and `POST /api/debug/seed-exercise-content` — populates both from wger's `exerciseinfo` by
>   `wger_id` (UPDATE-only, fill-if-null, `?force=`), with `sanitizeWgerHtml()` (strict attribute-free
>   allowlist `p/ul/ol/li/br/strong/b/em/i`, safe to `innerHTML` later). Images hot-linked, video out
>   of scope. Sanitizer verified locally (strips attrs/script/anchors, keeps allowlist).
> - **`exercise-catalog-merge` upgraded to UNION** muscles/equipment/images across the pair (+ keep
>   description fill-if-empty) so a cleanup merge never drops a freshly-seeded field or an enriched side.
> - **Seed run (2026-07-17):** `matched_to_wger:839, descriptions_written:816, images_written:263,
>   wger_had_no_content:18, errors:0` — 816 descriptions / 263 images landed; ~74 non-wger rows null.
> - **Cleanup batched into one endpoint** `POST /api/debug/exercise-catalog-cleanup` (admin-gated,
>   `?dry_run=1`), running the approved `CATALOG_CLEANUP_PLAN`: 24 renames (collision→merge), 13
>   merges (l/r pairs + 3-way calf raise + "Jumping Jack HD"; "Pistol Squat"/"Side Plank" collisions),
>   3 deletes (2 foreign English-dupes + 1 superset), 1 family fix (Dead Hang "Deadhang"→"Dead Hang").
>   "Kreis Press DB"/"Low-Cable Cross-Over - NB"/"Kettlebell One Legged Deadlift" left as-is (not
>   guessed). Merge logic factored into shared `mergeCatalogRowsById` (unions muscles/equipment/images).
> - **Cleanup execution pending the admin-gated run** (user runs `dry_run` then real); final row count
>   + per-op results to be recorded once run. Frontend untouched (detail view / Guide filters / AI rec
>   rendering — later sessions).
>
> **2026-07-17 session #24** (Bugfix — GH sleep card blank + readiness stuck at 1/100;
> report-first, approved before edits):
> - **Root cause**: the `/daily` response built `data.sleep.stages` as flat numbers
>   (`{deep:128}`) for Google Health, but every frontend reader (`renderReadiness`,
>   `computeReadiness`, AI-prompt builder) reads Fitbit's nested `stages.<stage>.minutes` shape.
>   So on GH data `stages.deep.minutes` was `undefined` → sleep score `null` + stage detail skipped
>   (blank card), and deep sleep read as 0 (understated readiness → cached 1/100). Masked for weeks
>   while GH's token was dead and `/daily` fell through to Fitbit; the session #19 reconnect made GH
>   primary and exposed it. **Not** caused by session #23 (which never touched `data.sleep.stages`).
> - **Fix**: GH response builder now emits `stages: { deep: { minutes: … }, rem: {…}, … }` —
>   normalizes to the Fitbit shape so all three readers work unchanged; `thirtyDayAvgMinutes` absent
>   for GH is already handled as optional.
> - **Cache bust**: added `CACHE_VERSION` (=2); `isCacheValid` rejects a `fitData` cache whose `v`
>   mismatches, so the stale broken-shape `ac_cache` is discarded on first load of the new JS (no
>   service worker → a normal reload suffices). Manual-checkin caches unaffected.
> - **Readiness re-stamp**: automatic — same root cause; fixed shape → `computeReadiness` reads deep
>   sleep correctly (~77) → `maybeRegenForReadiness` (delta > 10) re-stamps the server value. No
>   separate readiness code.
> - **Verified live (backend)**: `/daily` sleep stages now come back as `{minutes:N}` objects
>   (before: `{deep:128}` flat). Readiness recomputes to **77** with the fixed shape vs **63** on the
>   broken shape (deep read as 0) vs the stale cached **1/100**; sleep score computes to **97**
>   (matches the server's value). Frontend render + the server-side readiness re-stamp happen on
>   Shimmy's next app load (cache-bust auto-discards the stale `ac_cache`); a hard refresh forces it
>   immediately — not yet observed from the PIN-gated client at write time.
>
> **2026-07-17 session #23** (Bugfix — GH sleep not persisting after reconnect; report-first,
> plan approved before edits):
> - **Diagnosis**: everything landed except sleep because `ghData.sleep` came back null on morning
>   opens (GH reconciles last night's wearable sleep session later than daily HRV/RHR/steps), and the
>   GH `/daily` branch (a) persisted HRV/RHR **only inside `if (ghData.sleep)`** — so a sleep-less
>   fetch dropped vitals too — and (b) never fell back to Fitbit per-metric. **Not** scope/field/parse
>   (GH sleep parses fine) and **not** timezone (`profiles.timezone` for profile 1 verified as
>   `America/Chicago`, so the date-key fix was skipped per plan).
> - **Fix (GH branch only)**: (1) per-metric Fitbit sleep fallback — when GH sleep is null, fetch
>   Fitbit sleep for the same date via new `fetchFitbitSleepForDate()`, bounded by `withTimeout(6s)`
>   inside a try/catch (timeout REJECTS → caught → `/daily` never hangs; verified at runtime) and
>   fully non-fatal; (2) HRV/RHR decoupled from sleep via new `upsertDailyVitals()` in an `else if`,
>   so vitals persist even with no sleep.
> - **Clobber-safety**: `upsertDailyVitals` is **GET-then-PATCH-or-INSERT** (PATCH body only ever
>   holds hrv/rhr), clobber-safe by construction — chosen over a partial merge-upsert because
>   ADMIN_SECRET gating blocked running the server-side clobber test from the dev environment. Added
>   `POST /api/debug/test-vitals-upsert/:userId` (admin-gated, throwaway date `1970-01-01`,
>   self-cleaning) to confirm the invariant; **run it with the secret before fully trusting the real
>   path** (the real path is safe regardless).
> - **Not touched**: scheduler (§9, durable fix), `daily_sleep.source` mislabel (§9). **Not yet
>   verified live** at write time (pending deploy + the admin-gated clobber test).
>
> **2026-07-17 session #22** (Bugfix — Log-past "See more" scroll jump): clicking "See more"
> re-rendered the whole history list (`el.innerHTML = …`), rebuilding the `#log-past-history-list`
> scroll container and resetting `scrollTop` to top. Fixed with an **append-only** render path: the
> per-row markup was factored into `lpRowHtml()` (shared with the full render), and "See more" now
> calls `lpAppendRows()` (inserts only the newly-revealed/paged rows) + `lpUpdateSeeMore()` (refreshes
> just the button) instead of `renderLogPastHistory()`. Existing rows, expanded detail, and scroll
> position are untouched. Pagination/offset-fetch/expand/template logic all unchanged; frontend-only,
> id-scoped to the panel.
>
> **2026-07-17 session #21** (Log past workout panel — expand + pagination + template creation;
> report-first, audit approved before edits):
> - **Expand** — each history row lazy-fetches `/api/workouts/:id/full` on first expand into a shared
>   `fullWorkoutCache` (workoutLog is summary-only, no exercise rows); `reLogWorkout` refactored to
>   read the same cache (`lpLoadFull`). No eager fetching.
> - **"See more"** — reveals deeper into the loaded set client-side, then pages older workouts into a
>   panel-local `logPastExtra` via a new additive `?offset=` on `GET /api/workouts` (absent = 0, no
>   existing caller affected). `workoutLog` is never mutated. **Confirmed live** profile 1 has 76
>   workouts vs `loadWorkouts()`'s 60 cap, so pagination is real, not theoretical.
> - **Template create/append** — three entry points (new blank; save-as from a past workout or an AI
>   rec option via a 3-headline picker; append a past workout / AI rec option into an existing
>   template), all via the existing template POST/PATCH. **Writes `notes_template` only** — the
>   `workout_templates.exercises` jsonb is unread (`useTemplate` drives off `notes_template`), so
>   writing it would be dead data; flagged as a latent trap in §9.
> - **AI-rec parseability finding**: AI rec `options[].exercises` are freeform strings, not structured
>   objects — so save/append into `notes_template` (text) is clean and reuses `prefillLogFromAI`'s
>   format; no parsing attempted. `aiRec` is read-only, so `renderAI` is untouched.
> - **Scope**: one additive backend change (`?offset=`); all else frontend, CSS id-scoped, no global
>   class changes, no new endpoints. **Not yet verified live** at write time (pending deploy).
>
> **2026-07-17 session #20** (Log past workout panel — Today tab; frontend-only, report-first,
> plan approved before edits):
> - **New `#log-past-card`** after `#ai-card` on Today: a "🔁 Log past workout" button expands an
>   inline panel with two sections — a **deeper scrollable past-workout history** (last ~20 from the
>   existing `workoutLog`, **no new query**, `reLogWorkout()` on tap) and the **reused
>   `renderRecentAndTemplates()`** templates render (`useTemplate()` on tap). Both prefill the
>   existing Log Workout modal and **never log immediately**; `use_count` behavior unchanged.
> - **Deviation from the reuse plan, on the user's request**: past history is a deeper list
>   (~20, scrollable) rather than the reused function's last-3 cap — data-only re-render from
>   `workoutLog`, still no new query. Templates stay the reused render.
> - **`renderRecentAndTemplates(templatesOnly)`** gained one optional, backward-compatible param
>   (all 8 existing call sites are arg-less → identical prior behavior). A panel-open guard forces
>   templates-only while the panel is open so a background save/delete re-render can't duplicate the
>   recent-workouts block above the new history list. Closes §7 item 4's "Today ▶ Use quick-row"
>   conditional (and expands it). See `CLAUDE.md` → "Log Past Workout Panel".
> - **Scope**: frontend-only, no API calls added/changed; CSS id-scoped, no global class changes.
>   Deployed; **not yet verified live** at write time (pending deploy).
>
> **2026-07-17 session #19** (Wearable connection health — real token status, serialized
> refresh, Reconnect/Disconnect UI; report-first, audit approved before any edit):
> - **Root cause of the "connected but no data" audit**: both profile-1 tokens were dead
>   (`invalid_grant`) yet the UI showed connected, because `GET /api/wearables/providers/:id`
>   computed `connected: !!c` (row exists), never token health. The likely cause of the Fitbit
>   token *death* was a refresh race — `getValidProfileToken`/`getValidWearableToken` are called
>   from several endpoints that fire together on app boot, and OAuth refresh tokens are single-use,
>   so two concurrent refreshes could each spend the same token and clobber each other.
> - **Serialized refresh** — new in-process `_refreshLocks` map + `withRefreshLock(key, fn)` keyed
>   `provider:profileId`; concurrent callers now await ONE in-flight refresh instead of each POSTing
>   the same refresh token. Wraps the Fitbit path (`refreshProfileToken` → `_doRefreshProfileToken`)
>   and the Google Health path (the refresh+save block in `getValidWearableToken`). Valid-token
>   reads are never serialized. Single-instance only (fine for the one Render web service).
> - **Persisted `needs_reconnect` flag** on `wearable_connections` (migration
>   `2026-07-17_wearable_needs_reconnect.sql`, **run manually**) — set true on a definitive
>   `invalid_grant`/`RECONNECT_REQUIRED`, cleared to false on every successful (re)connect or
>   refresh (`saveProfileTokens`/`saveWearableTokens`, both OAuth callbacks). Only ever set on a
>   real auth failure, never a transient blip, so it doesn't flap. Writes are best-effort
>   (`setNeedsReconnect`, never blocks a token save) and the providers read falls back to a
>   column-less select if the migration hasn't been applied yet — so deploy/migration ordering
>   can't break token persistence or the endpoint.
> - **Providers endpoint** now returns real health: `connected` = row exists AND healthy, plus
>   `needs_reconnect` and a `status` enum (`connected`|`needs_reconnect`|`disconnected`). Both
>   existing consumers (sync-modal `wsFetchProviders`, GH reconsent banner) keep reading `.connected`
>   and now correctly drop a dead connection instead of treating it as live.
> - **Settings → Account "Connected Devices"** rebuilt: was a single hardcoded Fitbit row driven by
>   `profile_data.fitbit`; now `loadConnectedDevices()` renders Fitbit + Google Health from the
>   providers endpoint with per-provider status and **Reconnect** (reuses `POST
>   /api/wearables/connect/:provider`) + **Disconnect** (confirm → existing `POST
>   /api/wearables/disconnect/:provider`) buttons; `needs_reconnect` surfaces an amber
>   "&#9888; Reconnect required". Additive JS, inline styles only, no global class changes.
> - **Disconnect endpoint already existed** (`server.js`) — reused, not duplicated. **Scheduler/
>   nightly-sync gap deliberately untouched** (tracked separately).
> - **Removed** two stale "Front-end redesign — in progress in a separate chat" claims (no such
>   redesign exists) from §7 and the Exercise Video section.
> - **Not yet verified live** at write time — needs deploy + the manual migration; then confirm
>   `providers/1` reports `needs_reconnect:true` for both dead providers and the Settings rows +
>   buttons work, and reconnect Google Health to watch the flag clear and sync resume.
>
> **2026-07-17 session #18** (Doc sync + roadmap refresh — no feature work):
> - **Full read-through of `CLAUDE.md` + `ROADMAP.md`, verified against live `server.js`/
>   `public/index.html`/`migrations/`** for everything shipped since the last full sync: frontend
>   declutter (§7 priority 5), Wearable Sync provider picker (§7 priority 6), readiness hero/detail
>   split (§7 priority 10), the tech-debt batch (4 items), Coach Chat sleep-history snapshot, and
>   the full-history Fitbit backfill. All six were already accurately documented — spot-checked
>   live (`fitbit_pending_imports`/legacy-roadmap code confirmed gone from `server.js`,
>   `renderRecentAndTemplates()`'s null-guard confirmed, `?metrics=` gating confirmed in the
>   backfill endpoint) rather than trusted from the prior session's own claims.
> - **Real gap found: the tech-debt-batch migrations' RUN status was stale in both docs.** All
>   three 2026-07-17 migrations (drop `fitbit_pending_imports`, drop legacy roadmap columns,
>   `exercises.workout_id` FK cascade) had actually been run in production, but `CLAUDE.md` and
>   `ROADMAP.md` still said "pending manual migration" / "not yet run" in six places across the
>   Supabase Tables section, the `exercises` schema row, the Migrations list, §6, and §9. Fixed
>   every instance; also added the new FK's existence to the `exercises.workout_id` schema row in
>   both docs (previously undocumented even as pending).
> - **§6 weight/body-fat scope note**: confirmed still accurate — the gap survives the user's
>   2026-07-14 reconsent, deliberately deprioritized (documented in session #17, unchanged here).
> - **§7 rewritten for the next work cycle** (report-first, approved before writing): replaced the
>   old numbered list (6 of 10 items already done, accumulating strikethrough clutter) with a fresh
>   priority order — (1) second-profile Google Health migration, (2) Google Health historical
>   backfill mirroring this session's Fitbit work, (3) zone/active-minutes persistence, (4) a
>   decision gate requiring the next session to actively resolve three real-use-conditional items
>   (readiness hero compaction, Today template quick-row, Coach Chat monthly aggregates) before
>   defaulting to (5) the Free Exercise DB top-up — plus an unordered parked backlog and a "still on
>   the board" list (Apple HealthKit, MuscleWiki video, logo). Cleaned up three
>   now-stale live cross-references to the old priority numbering (Exercise Video plan section,
>   "Next up" subsection) that would otherwise have pointed at numbers that no longer meant anything.
>
> **2026-07-17 session #17** (Full-history Fitbit backfill — sleep/HRV/RHR/steps/weight/body-fat
> into `daily_sleep`/`daily_steps`/`body_metrics`; report-first, audit approved before any edit,
> see git history for the full audit report):
> - **Built** `POST /api/debug/backfill-wearable-history/:userId?start_date=&end_date=&max_calls=N&metrics=`
>   — same pattern as `backfill-wearable-hr`: admin-gated, budgeted (`max_calls` defaults to
>   **100, not Infinity** — a deliberate deviation, an accidental-unbounded-call guard), shared
>   ~1req/sec throttle, non-fatal per chunk, resumable via per-metric `resume_from`. Uses Fitbit's
>   RANGE endpoints exclusively (never per-day calls) — see `CLAUDE.md` → "Fitbit History Backfill"
>   for the full per-metric chunking/merge design and the never-overwrite-worse-data rules.
> - **Verified live** (profile 1, production): a 32-day window (2026-06-15→2026-07-16, chosen to
>   bracket the confirmed mid-June→mid-July `daily_sleep` gap with a day of margin) wrote
>   sleep/HRV/RHR into every gap date and left existing rows untouched.
> - **Full 2-year run** (2024-07-17→2026-07-16): sleep 675 / HRV 674 / steps 653 rows written,
>   81/100 calls used, zero failed chunks — except RHR, which unexpectedly wrote 0/677.
> - **Real bug found and fixed same session**: Fitbit's `activities/heart` range endpoint
>   documents a 365-day max and does return 200 at that span, but silently omits
>   `value.restingHeartRate` from every entry once the range gets long — confirmed via the
>   contradiction between the full run's 0/677 and the verification run's 25/25 over the exact
>   same merge code. Rechunked RHR to 29 days (same as HRV) and added a permanent per-chunk
>   diagnostic log line so this can't silently reoccur. Also added `?metrics=` so a fix like this
>   can be re-applied to one metric without re-fetching (and discarding) the other five.
>   **Re-run confirmed the fix** — `?metrics=rhr` over the full 2024-07-17→2026-06-14 range wrote
>   679 rows / skipped 19 (already had values from normal daily sync) / **0 empty**, 24 calls,
>   full RHR coverage across the entire 2-year window with no remaining gap.
> - **Weight/body-fat wrote nothing** — confirmed the 2026-05-17 Fitbit scope gap (§6) is still
>   present after the user's 2026-07-14 reconsent; deliberately not chased further, since the
>   account has never logged weight via Fitbit (nothing to backfill either way). §6 updated to
>   reflect current status.
> - **§9**: flagged (not fixed) the pre-existing `runFitbitBackfill()` `90d` weight-period call,
>   which isn't a Fitbit-documented-valid period value.
>
> **2026-07-17 session #16** (Coach Chat — 30-day sleep history in the athlete snapshot):
> - **Problem**: `buildChatSnapshot()` only ever carried today's single cached sleep row (the
>   "LATEST BIOMETRICS" line) — asked to analyze a month of sleep, the model correctly said it
>   only had one data point, even though `daily_sleep` has held per-day hours/score/deep/rem/light/
>   wake/HRV/RHR since 2026-05-24.
> - **Fix, purely additive**: a second `daily_sleep` query (`date >= today-30`, `order=date.asc`,
>   separate from the existing single-row fetch) feeds a new `SLEEP HISTORY (30d, ...)` block —
>   one compact line per day (date, hours, score, deep/rem minutes; null fields omitted). Days
>   with no row at all are never shown as zero — omitted, with the block's own header stating
>   gaps mean missing sync, not zero sleep. No changes to `CHAT_SYSTEM_PERSONA`, tools, the
>   proposal flow, streaming, or any existing snapshot field. One PostgREST query, non-fatal —
>   a failure resolves to `[]` and logs one line, same pattern as every other snapshot sub-fetch.
> - **Size**: ~1040 chars measured for a fully-populated 30-day window, well under the 1500-char
>   target — lives in the never-soft-cap-trimmed `coreLines` tier alongside the other biometric
>   lines, same as they already did.
> - **Cache-invalidation impact confirmed, not assumed** (per the session brief's explicit ask):
>   `daily_sleep` only changes via the nightly wearable sync, so the new block is stable within a
>   chat session exactly like the pre-existing single-row biometrics line — doesn't introduce a
>   new class of per-message cache churn, just a modestly bigger cached block. See §6 item 5.
> - **Verified live** (profile 1, production): `?debug=1` echoed the block with 6 real days of
>   data across a genuine ~24-day wearable-sync gap (correctly un-fabricated as zeros), 3637 total
>   snapshot chars, `cache_control_present:true`, `system_est_tokens:3411` (safely over the 1024
>   caching floor). A real chat message ("analyze my sleep over the past month") — sent twice,
>   since the first landed in a thread where the model had already told Shimmy 3x pre-fix that it
>   couldn't see this data and anchored on its own prior denials rather than re-checking a fresh
>   snapshot — on the second, explicit ask, produced a real trend analysis correctly citing the
>   exact dates/hours/scores/deep/REM minutes from the block, correctly explained the gap as a
>   sync issue, and cross-referenced today's cached readiness score into a genuine causal read
>   (short sleep → lower readiness), not a templated response.
>
> **2026-07-17 session #15** (Tech debt batch, ROADMAP §9 — report-first, all 4 items approved
> before any edit, see git history for the full audit report):
> - **Item 1 — dropped `fitbit_pending_imports` dead code.** Confirmed zero call sites (grep before
>   removal) for `diffAndQueueFitbitImports()`, `GET .../fitbit-pending-imports`, and
>   `POST .../fitbit-import`; all removed from `server.js`, along with the now-dead
>   `mapFitbitActivityType()`/`FITBIT_ACTIVITY_TYPE_MAP`. Column drop is a migration file
>   (`2026-07-17_drop_fitbit_pending_imports.sql`), **not run** — the user runs it manually.
> - **Item 2 — retired the legacy text roadmap fully.** Confirmed no external consumer reads
>   `profiles.roadmap`/`roadmap_updated_at` (`life-os-summary` and `PROFILE_SELECT_BASE` both use
>   explicit column lists that never included them). Removed `GET/POST /api/profiles/:id/roadmap`,
>   `loadRoadmap()`/`generateRoadmap()`/`renderRoadmapContent()`, and the hidden `#roadmap-card` div
>   (left in place during the 2026-07-16 declutter session on purpose — full retirement was out of
>   scope then). Column drop is a migration file (`2026-07-17_drop_legacy_roadmap.sql`), **not run**.
> - **Item 3 — FK migration written, not run.** `2026-07-17_exercises_workout_fk_cascade.sql` adds
>   `exercises_workout_id_fkey` (`ON DELETE CASCADE`) — closes the orphaned-exercises bug class
>   structurally. Requires an orphan check across every profile first (the `ALTER TABLE` fails on
>   any existing orphan); profile 1 was cleaned in session #11, profiles 4/5/7/8 haven't been
>   checked for this. No code changes for this item — SQL file only, per the approved scope.
> - **Item 4 — `DELETE /api/profiles/:id` now deletes `exercises` too**, mirroring the session #11
>   `DELETE /api/workouts/:id` fix. Deliberately kept independent of item 3's FK: `extract-exercises`
>   can insert a null `workout_id`, and a cascade from `workouts` can never reach those rows — so
>   this explicit profile-scoped delete stays load-bearing even after the FK lands, not just
>   belt-and-suspenders.
> - **Verified live** (profile 1, production, post-deploy): confirmed the old `#roadmap-card` div
>   and `fitbit-pending-imports` references are gone from the deployed page while `#roadmap-data-card`
>   renders correctly; ran a full create → extract-exercises → delete cycle on a throwaway workout
>   (id 104) to confirm the save/extract/delete pipeline is unaffected — the exercise row was
>   correctly cleaned up on delete; swept all four tabs with zero console errors. **Not tested live**:
>   `DELETE /api/profiles/:id` itself (would require deleting a real profile) — verified via code
>   review only.
>
> **2026-07-16 session #14** (Readiness card hero/detail split, closes §7 priority 10 — the JS
> restructure explicitly deferred from the declutter session):
> - `renderReadiness()` split into an always-visible hero (ring/score/tier/bar + 2×2 bio-grid) and
>   a collapsed-by-default detail section (bars/sleep-stages/zones/HRV), same visual-only toggle
>   pattern as Coaching Brief/Macro Roadmap. **No data computation, fetch paths, or regen triggers
>   touched** — confirmed by capturing production's readiness/HRV/RHR/sleep/steps numbers *before*
>   deploying and diffing against the same numbers post-deploy: identical.
> - **Sleep score surfaced in the hero** — the bio-grid's "Sleep" cell now shows the computed sleep
>   SCORE as its headline number (was hours-only before), e.g. "81" with a "Good · 5.9h" caption,
>   reusing the exact `ssColor`/`ssTier` tier logic the detail card's own SLEEP SCORE display
>   already used.
> - **Real bug found and fixed along the way**: `ssColor`/`ssTier` were computed inside `if
>   (deep.minutes || rem.minutes)`, one condition narrower than `sleepScore`'s own gate (`deep ||
>   rem || light`) — a light-only night left them `undefined`. Not reachable before this session
>   (the hero never referenced them), became a real risk once it started reusing them for the new
>   cell, so hoisted and fixed at the source.
> - **Dead code removed**: `vitalsHTML` was computed every render but never concatenated into
>   `card.innerHTML` — confirmed via diff review it was a true no-op, safe to delete.
> - **Honest gap, not glossed over**: the ~200px hero target wasn't hit — measured live it's
>   ~354px, since the ring/grid dimensions are pre-existing and shrinking them would itself be a
>   visual change beyond "the collapse" (out of scope per this session's own guardrails). What
>   shipped: the full card (hero + detail) went from ~1084px always-expanded to ~415px with the
>   detail collapsed — roughly halves the scroll distance to the feeling check-in/rec even though
>   the hero itself didn't hit the aspirational number.
> - **Verified live** (profile 1, production, 390×844 and 1440×900): pre/post-deploy numbers
>   identical (readiness 62/light, HRV 52.3, RHR 58, sleep 5.87h, steps 5976, sleep score 81/Good);
>   detail toggle expands with all four subsections and matching numbers;
>   `localStorage.ac_readiness_detail_open` persists across a full page reload, not just a
>   client-side re-render; zero new console errors.
>
> **2026-07-16 session #13** (Wearable Sync bulk-review modal — Google Health provider picker,
> closes §7 priority 6 — UI-only, no backend/endpoint/dependency changes):
> - `wsFetchProviders()` reads the existing `GET /api/wearables/providers/:userId` (same one the
>   Google Health reconsent banner already uses), filters to connected providers, and sets
>   `wsState.provider`: Google Health if connected, else Fitbit, else first connected, else the
>   pre-existing `'fitbit'` default. A pill picker renders when 2+ providers are connected
>   (skipped otherwise — nothing to choose). `sync-backlog` and the merge/reject/import action
>   functions already read `wsState.provider` generically — confirmed via direct diff review, zero
>   changes needed there.
> - **Real bug found and fixed along the way**: the reconnect step (`wsRenderReconnect()`) linked to
>   the legacy Fitbit-only `/auth?profile_id=` route regardless of which provider actually needed
>   reconnecting — selecting Google Health and hitting a stale token would have silently kicked off
>   the wrong OAuth flow. Fixed with `wsReconnect()`, reusing the existing provider-agnostic
>   `POST /api/wearables/connect/:provider` (the same endpoint `connectGoogleHealth()` already uses
>   elsewhere) — not scope creep, since leaving it broken would have shipped a picker that's
>   actively wrong in exactly the state it's most likely to be exercised in.
> - **Verified live, profile 1, both providers actually connected**: `wsState.providers` correctly
>   resolved `['fitbit','google_health']` with Google Health as the default; switching to Fitbit via
>   the picker correctly reloaded Fitbit-specific activity types; a full Fitbit sync ran end-to-end
>   (`sync-backlog` → 13 matched / 25 unmatched / 32 already-synced, real data) confirming the
>   pre-existing pipeline is untouched. **Google Health's token happened to be genuinely expired on
>   this account** — an unplanned real-world test of the reconnect fix: it correctly surfaced
>   "Reconnect Google Health" (previously would have read "Fitbit" and misdirected the OAuth flow).
>   No merge/reject/import action was exercised against real data (would permanently alter Shimmy's
>   actual workout history; the code path was already confirmed untouched by diff review). Zero new
>   console errors.
>
> **2026-07-16 session #12** (frontend declutter, closes §7 priority 5 — pure UI: render-call
> relocation + CSS/HTML wrapper only, no JS logic/API/data-flow changes):
> - **Two-phase process**: a read-only Phase 1 audit of `public/index.html` (actual DOM order,
>   render functions, dependencies) produced a findings report + open questions; the user approved
>   specific decisions before any edit landed (see `CLAUDE.md` → "Today Tab + Profile Tab
>   Reorganization" for the full breakdown).
> - **Today tab**: final above-the-fold order is readiness → feeling check-in → rec, nothing else
>   between them. `#body-metrics-card` relocated to Profile (zero JS change — every call site
>   already does `getElementById`); `#recent-workouts-card` (Recent Workouts + Templates ▶ Use,
>   previously one bundled render function) removed entirely from Today, its render function left
>   intact and now no-ops via its own existing null-guard; `#streak-card`/`#progress-card`/
>   `#unmatched-fitbit-card` demoted below the rec (the header fire-badge already covers the streak
>   signal above the fold at every viewport width, confirmed by reading the CSS).
> - **Profile tab**: regrouped into identity/body (Body Metrics + Body + Weight Trend + Sync
>   Wearables — `#profile-body`'s redundant read-only weight summary trimmed since Body Metrics now
>   covers it), an identity/context block, coaching/AI (Focus Override + Coaching Brief + Macro
>   Roadmap), a goals cluster (Belt + Active Challenges + Goals & Milestones), Analytics, and
>   Templates/Settings. `#schedule-card` deliberately left at its original position 2 — the audit
>   found no reason to move it. Coaching Brief and Macro Roadmap collapsed by default
>   (Analytics-style chevron, `localStorage`-persisted) — **visual-only**: confirmed
>   `loadRoadmapData()`'s boot-time auto-generation trigger fires exactly as before, only the
>   already-rendered body is hidden/shown.
> - **Deferred, not built this session**: a true readiness-card hero/detail split (`renderReadiness()`
>   is one monolithic render with no seam to compact-hero-ify without a JS restructure) — added as
>   §7 priority 10.
> - **Audit corrections**: no reconsent/migration banner exists on Today at all (the only one,
>   Google Health migration, is Profile/Settings-only); PIN change, wearables connect/disconnect,
>   and delete-profile live in the separate `#settings-overlay`, not the Profile tab's card stack.
> - **Verified live** (profile 1, production, 390×844 and 1440×900): exact DOM child order of both
>   tabs confirmed via direct inspection; both collapses default closed and expand correctly;
>   `openLogWeight()` from the relocated Body Metrics card opens pre-filled with the real latest
>   weight; Chart.js weight-trend chart unaffected; zero console errors.
>
> **2026-07-16 second doc-sync audit** (no feature work — CLAUDE.md + ROADMAP.md re-verified against
> live `server.js`/`public/index.html`/`migrations/`, covering sessions #9–#11 plus manual curl work
> that no single session had documented). Found and fixed: §4's debug table was missing the
> orphaned-exercises GET/POST pair (session #11) and the `/api/exercise-catalog` row's description
> hadn't been updated for session #10's Guide-driven extension (`family`/muscle-groups/`equipment`,
> `?all=1`/`?limit`/`?offset`); §2's Migrations list was missing `2026-07-16_exercise_catalog_wger.sql`
> entirely; §3's Exercise Canonicalization bullets still had a stale "MuscleWiki bulk-seed — built,
> not run" line left over from before session #8 replaced it with the wger seed; §6 was missing three
> known issues that only lived in session-changelog prose (workout 17's one-off double-extraction,
> wger-seed noise now visible in the Exercise Guide, Dead Hang's `family:"Deadhang"` typo) and had a
> now-stale `daily_sleep` RLS bullet — **RLS + `service_role_bypass` was applied manually the same day
> the first doc-sync audit found the gap**, both docs now reflect 16 RLS-covered tables. Recorded a
> manual catalog-curation pass run via curl (`Bicep Curl` id 9, `Dead Hang` id 18, `Dumbbell Curl` id
> 100) that no session had documented — it retroactively resolves two findings from session #9
> (`CLAUDE.md` → Phase 2): Dumbbell Curl now groups with Bicep Curl under `family:"Bicep Curl"`, and
> Dead Hang's previously-empty muscle data should surface on the heatmap (not re-verified live after
> curation — flagged for a spot-check). Also logged a same-day save-time-matching spot-check
> ("dumbell curlz"/"bench pres" both resolved correctly, no code change). **New finding, not
> previously tracked**: confirmed by reading `mgHabitDaySources()` that the 27 orphaned rows deleted
> in session #11 had also been falsely counting as `daily_habit` days in micro-goal tracking (it
> sources habit days from `exercises.profile_id`/`date` directly, no check that `workout_id` still
> points at a live workout) — the same exposure still exists via `DELETE /api/profiles/:id` (§6).
> Everything else — the Phase 2 and Exercise Guide session narratives, the orphaned-exercises fix,
> ROADMAP §7 priority 4's closure — matched the live code exactly, no further corrections needed.
>
> **2026-07-16 session #11** (bug fix — `DELETE /api/workouts/:id` orphaned its `exercises` rows):
> - **Root cause, confirmed by reading the code, not assumed:** the delete handler only ever
>   removed the `workouts` row itself — it never touched `exercises` rows scoped to that
>   `workout_id`, so every workout delete silently left its extracted exercises behind. The same
>   gap exists on `DELETE /api/profiles/:id` (deletes `workouts`, never `exercises`) — noted but
>   out of scope for this session (narrower blast radius fix requested).
> - **Fix**: `DELETE /api/workouts/:id` now also deletes `exercises WHERE workout_id=:id AND
>   profile_id=:pid` (the same profile-ownership guard `DELETE /api/profiles/:id/exercises/:exerciseId`
>   already uses) before deleting the workout row. No schema change — an `ON DELETE CASCADE` FK
>   would be more robust long-term but was explicitly deferred (see §9) in favor of the narrower,
>   no-migration fix.
> - **PATCH /api/workouts/:id audited for the "does an edit stack duplicate exercises" question
>   — it doesn't, because it never re-extracts at all.** Editing a workout's notes only
>   regenerates the AI-generated title (`saveWorkout`→`updateWorkoutInSupabase`, `public/index.html`);
>   `/extract-exercises` is never called again on edit. So there's no duplication risk, but a
>   related, unfixed gap: editing notes to change the actual exercises leaves the ORIGINAL
>   extraction's `exercises` rows stale (not updated, not duplicated). Flagged, not fixed — see §6.
> - **New report-first admin cleanup pair**, mirroring the exercise-canonicalization backfill
>   pattern exactly (GET report → human review → POST the reviewed ids): `GET
>   /api/debug/orphaned-exercises/:userId` (read-only, groups pre-existing orphaned rows by
>   name/date) and `POST /api/debug/delete-orphaned-exercises/:userId` (body `{ids:[...]}`,
>   re-verifies each id is still orphaned server-side before deleting — never trusts the caller's
>   list blindly).
> - **Verified live** (profile 4, throwaway workout): logged a workout, ran `/extract-exercises`,
>   confirmed the exercises row existed with the correct `workout_id`; deleted the workout via
>   `DELETE /api/workouts/:id`; confirmed both the workout row AND its exercises row were gone
>   (`GET /api/profiles/4/exercises?name=...` → 0 rows).
> - **Profile-1 cleanup run for real, reviewed and approved by the user.** The report found 27
>   orphaned rows across 5 dead workout ids — 101/102 (same-day leftover test artifacts) and
>   17/19/20 (real 2026-04-15/16 workouts). Reviewed before approving: no false positives; one
>   side-finding not chased — workout 17's 8 exercises each had exactly 2 copies under that one
>   `workout_id`, pointing at a separate, pre-existing `/extract-exercises` double-call from some
>   earlier session, unrelated to this bug. `POST /api/debug/delete-orphaned-exercises/1` with all
>   27 ids → `{deleted:27, skipped:0}`. **Confirmed as a real correction**: `Dead Hang` dropped
>   48→46 rows (exactly the predicted 2), `Bench Press` went to 0 (the test artifacts had no real
>   rows behind them) — these orphans had been silently inflating live counts/PRs **and falsely
>   counting as `daily_habit` days in micro-goal tracking** until now (`mgHabitDaySources()` sources
>   habit days straight from `exercises.profile_id`/`date`, no check that `workout_id` still points
>   at a live workout — confirmed by reading the code, second doc-sync pass).
>
> **2026-07-16 session #10** (Exercise Guide, per-exercise muscle diagram, heatmap tap-through,
> History-card exercise chips — builds on session #9's Phase 2 data):
> - **Guide (4th Library sub-nav)**: browses the full shared `exercise_catalog` (~880 rows)
>   independent of personal history — search, the same 11-muscle-group pill row + Primary/Both
>   toggle as Exercises (independent filter state), an equipment dropdown, a "logged Nx" badge +
>   tap-through for rows already in this profile's history, display-only for the rest. `GET
>   /api/exercise-catalog` extended additively (`family`/`muscle_groups_primary/secondary`/
>   `equipment`, plus `?all=1`/`?limit`/`?offset`) — the existing `?q=` confirm-chip search is
>   unchanged in shape/behavior. Loaded lazily on first Guide open, cached client-side for the
>   session.
> - **Per-exercise muscle diagram** on the Library detail view: front/back SVG figures (primary
>   muscles full ember, secondary ~40%, others neutral), reusing the Dashboard heatmap's exact
>   region paths via a newly-factored `renderBodyFigureSvg()` shared helper (no copy-pasted
>   paths). `GET /api/profiles/:id/exercises/:name` now attaches catalog muscle data (non-fatal,
>   same degrade pattern as the grouped endpoint's own attach) so this works regardless of entry
>   path — Guide only ever opens the detail view for exercises already in history, so no separate
>   "catalog row" plumbing was needed. Exercises with no catalog muscle data skip the diagram
>   entirely (no empty figure, no error).
> - **Heatmap tap-through**: tapping/hovering a MUSCLE HEAT region already showed the same
>   readout on both hover and tap (no separate hover-then-tap stage to build a second interaction
>   on) — resolved by growing the existing readout into a "View Exercises →" affordance that
>   navigates to the Exercises sub-view with that muscle filter pre-applied (Primary+Secondary).
> - **History-card exercise chips**: workout cards show tappable, deduped canonical-exercise
>   chips below the notes (never altering the notes themselves), tapping opens the Library detail
>   view. Sourced from a single lazy, session-cached bulk fetch of `GET
>   /api/profiles/:id/exercises`'s `raw` field (already carried `workout_id`/`name` per row, just
>   discarded by `loadLibrary()` until now) — no per-card fetch, no server change needed. Cache is
>   keyed by profileId (mirroring the heatmap's own `libHeatmapLoadedKey` convention) so
>   `switchProfile()` — which doesn't reset this cache — still refetches instead of showing a
>   stale profile's chips.
> - **Verified live** (profile 1): catalog search "curl" returns 73 catalog-wide results; `?all=1`
>   returns the full 881-row catalog; `GET .../exercises/Bench%20Press` correctly attaches
>   `primary:["chest"], secondary:["shoulders","triceps"]`; a custom entry (`MMA Class`) attaches
>   empty muscle arrays, correctly skipping the diagram; the grouped `raw` exercises response
>   correctly carries `workout_id` per row for the chip mapping. UI click-through (search/filter
>   interactions, diagram rendering, heatmap tap navigation, chip tap) handed to the user to spot-check manually since this session's browser tool couldn't reach a visible display.
>
> **2026-07-16 doc-sync audit** (no feature work — CLAUDE.md + ROADMAP.md re-verified line-by-line
> against live `server.js`/`public/index.html`/`wearables/`/`migrations/`, not against memory of
> past sessions). Found and fixed: §4 listed 3 admin endpoints (`dead-hang`, `missing-dates`,
> `dead-hang-backfill`) that no longer exist in code at all (removed); §4 was missing 2 real,
> live endpoints (`POST /api/exercise-catalog/confirm-alias`, `GET .../life-os-summary`); §10 was
> missing 2 real env vars actually read via `process.env.*` (`LIFE_OS_API_KEY`, `RENDER_URL`); §2's
> "Other tables" list omitted `daily_sleep` even though its migration is tracked in the same
> section. New finding, not previously tracked: `daily_sleep`'s RLS status is undocumented (see §6).
> Everything else audited — model strings/`CALL_TYPE_MODEL` routing, the full endpoint inventory,
> `exercise_catalog`'s schema, the athlete-timezone system, Coach Chat tool-use + the roadmap-regen
> auto-offer, exercise canonicalization end-to-end, and the `.env.claude.txt` convention — matched
> the live code exactly, no further corrections needed.
>
> **2026-07-16 session #9** (Exercise Canonicalization phase 2 — Library family rollups, muscle-group filter, muscle heatmap; the queued §7 priority-4 consumer of `family`/`muscle_groups_primary`/`muscle_groups_secondary`, populated since the wger seed but unread until now):
> - **Server**: `GET /api/profiles/:id/exercises` now attaches `{family, muscle_groups_primary, muscle_groups_secondary}` per grouped exercise via a `catalogNormKey()` index over the catalog's `canonical_name` + aliases (new `fetchExerciseCatalogWithMuscleData()`/`buildCatalogMuscleIndex()`, separate from the existing lean `fetchExerciseCatalogForMatching()` — untouched). New `GET /api/analytics/muscle-volume/:userId?days=7|30|90`: weighted per-group volume (primary ×1.0, secondary ×0.5) over a `localToday()`-anchored rolling window, normalized 0–1 intensity, all-zero-safe, non-fatal on any failure (200 + zero groups, never 500).
> - **Client — family rollups** (Library → Exercises, unfiltered state only, deliberate v1 scope): 2+-variant families collapse into one card (name/variant count/aggregate total/most-recent), tap to expand into the exact same per-variant cards used everywhere; `family:null` exercises land in a bottom "uncategorized" section, never grouped. Any active search/category/subcategory/muscle filter falls through to the flat list, no partial-family logic. The existing `applyLibSort()` is reused unmodified for family+single top-level sort via aggregate-shaped wrapper objects.
> - **Client — muscle filter**: 11 pills (the `MUSCLE_GROUP_MAP` groups) + a Primary/Primary+Secondary toggle, single-select, combines with search/category. An exercise with no catalog match is excluded while a filter is active, reappears when cleared.
> - **Client — muscle heatmap**: new "MUSCLE HEAT" card on the Library Dashboard, two **original geometric SVG figures** (front/back, rounded-rect `<path data-muscle>` regions — explicitly not traced or sourced from MuscleWiki/wger, licensing-clean per §7 priority 5), ember opacity ramp by intensity, 7D/30D/90D pills, tap/hover readout, quiet no-retry error state.
> - **Verified live, not by reading code** (profile 1 real data + profile 4 for a controlled test): profile 1 currently has **zero** families with 2+ logged variants (every family-tagged exercise Shimmy's actually logged is a lone variant, including "Push-Up" — no "Close Grip Push-Up" etc. in his real history), so no family card renders there today, not a bug. Built a real 2-variant family on profile 4 instead ("Wide-Grip Lat Pulldown" + "Single-Arm Lat Pulldown" both strip to `family:"Lat Pulldown"` under the documented wger heuristic) — confirmed via browser screenshot: collapsed card shows "2 VARIANTS · 2x total", expands to both variant cards with correct individual stats. **"Dumbbell Curl" — more nuanced than pass/fail**: the prior session's catalog-upsert *was* run (`family:'Bicep Curl'` confirmed live), but the base "Bicep Curl" row itself has `family:null` (one of the 18 original CANONICAL_NAMES-seeded rows, predates `family` ever being populated) — so they still don't group, same outcome as "upsert never run" but a different, real cause, confirmed live not assumed. Muscle filter confirmed on real data: "chest" surfaces Wall Slide/Push-Up/Crunches; toggling Primary-only correctly drops Crunches (secondary-only) while primary matches remain; clearing restores the full list. "Uncategorized" boundary confirmed via DOM inspection at the exact right place, catching Bicep Curl and every custom BJJ/MMA entry. Heatmap confirmed rendering correctly across all 3 windows on real data (7D/30D/90D each return distinct, sane values). **Real data-completeness finding, not a code bug**: `grip_forearms` shows zero at every window despite Dead Hang being the single most-logged exercise (48x) — its catalog row has empty `muscle_groups_primary`/`secondary` even though it carries `family:"Deadhang"` from the wger merge, meaning wger's own "Deadhang" entry apparently has no muscle tagging of its own (a plausible upstream gap in grip/isometric-hold coverage) — correctly reflected as zero, not fixed this session, not this session's data to curate. See `CLAUDE.md` → "Exercise Canonicalization Phase 2".
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
> **2026-07-15/16 session #7** (exercise canonicalization — a catalog-backed system generalizing the CANONICAL_NAMES/Dead Hang hand-fix so every logged exercise resolves to one identity, not just the ~19 hand-picked ones):
> - **New `exercise_catalog` table** (migration `migrations/2026-07-15_exercise_catalog.sql`, RLS + `service_role_bypass`, **applied**) — seeded directly FROM the existing `CANONICAL_NAMES` map (18 canonical rows, alias groups transcribed verbatim) rather than a parallel reimplementation, so the very first save after migration exact-matches everything the app already knew how to canonicalize. `family`/`muscle_groups_primary`/`muscle_groups_secondary`/`equipment` columns baked in now, consumed starting phase 2 (Library rollups/muscle filtering) — see §7.
> - **`resolveExerciseCatalog()`** (`server.js`) — layered on top of, never replacing, `normalizeExerciseName()`/`CANONICAL_NAMES` (which still run first and stay authoritative for everything they cover, audited before writing any code): exact/alias match (`catalogNormKey()` — lowercase/strip hyphens+spaces/singularize; cosmetic variants collapse into the SAME key as the canonical name and hit `'exact'`, so every genuine `'alias'` hit is, by construction, a real variant-vs-generic merge, never a spelling nit) → fuzzy match (Levenshtein, no new npm dep — audited first, no existing fuzzy utility in the codebase) → Haiku fallback (a **separate small call**, deliberately not folded into the main extraction prompt — that runs on every save regardless of ambiguity, a 1900-entry catalog doesn't belong in it) → creates a `source:'custom'` row if genuinely new. Never blocks a save — any internal failure degrades to today's pre-catalog behavior.
> - **Confirm chip, standing rule set mid-review (2026-07-16): ask whenever there's ambiguity, never silently guess.** Originally only `fuzzy`/`haiku`/`custom` triggered the post-save chip; live review of the backfill data (below) surfaced that `'alias'` hits needed the same treatment — an alias match in this system is *always* a real variant-vs-generic decision (e.g. "Curl"→Bicep Curl, "Tricep Extension"→Overhead Tricep Extension), never cosmetic, so it must be confirmed too. Only `'exact'` (and the silent `'unavailable'` fallback) now save with no chip. One-line frontend fix — the server was already returning the correct `method`, just not being asked to chip on `'alias'`.
> - **MuscleWiki bulk-seed** (`POST /api/debug/seed-exercise-catalog`) — built against MuscleWiki's documented API shape (paginated list + per-id detail, `X-API-Key` auth, ~1/sec throttle, capped retries, dedup-aware upsert against the CANONICAL_NAMES-seeded rows) but **NOT live-verified** — `MUSCLEWIKI_API_KEY` was never available this session, so it's only ever reported `status:'pending'`. **Outstanding action item**: set the key and run it (resumable via `?max_calls=N`, safe to re-run).
> - **Reviewed backfill, run for real (2026-07-16).** `GET /api/debug/exercise-canonicalization-report/:userId` reuses `resolveExerciseCatalog()` itself (not a separate implementation) so the proposal can't disagree with live save-time matching. Profile 1's report (69 distinct historical names, 9 Haiku calls) proposed 14 rows across 9 merge groups; user-reviewed and edited before applying — excluded `"Dumbbell Curl"→"Bicep Curl"` (a real distinct exercise, not a spelling variant) and approved the remaining 13 via `POST /api/debug/apply-exercise-canonicalization/1`. **Verified post-apply**: exactly 13 rows updated, "Curl" (bare) dropped to 0 remaining rows, "Bicep Curl" analytics correctly aggregated all 4 sessions (including the merged row) with sane weight/rep data, "Dumbbell Curl" confirmed untouched. New `POST /api/debug/exercise-catalog-upsert` (create-or-update by `canonical_name`, needed because no existing endpoint could set `family` — drafted to give "Dumbbell Curl" its own row with `family:'Bicep Curl'` so phase 2 still groups it, **command prepared but not yet run this session** — see the 2026-07-16 continuation entry below) and `DELETE /api/debug/exercise-catalog/:id` (removes a bad/test row, no cascade concern) shipped alongside as general-purpose admin curation tools.
> - **Verified live end-to-end**, not by reading code, on a scratch test profile: 3 spelling variants of "push ups" all resolved to "Push-Up" via `'exact'`; a genuinely made-up exercise name correctly created a new `'custom'` catalog entry with a chip; **the critical safety case — "hang clean" — correctly stayed its own distinct exercise, never silently absorbed into "Dead Hang"**; the Dead Hang micro-goal auto-tracker incremented 0→1 on a canonicalized save; a regression test with the catalog table not yet migrated still saved successfully via the silent `'unavailable'` fallback.
> - **Real pre-existing bug found incidentally, NOT fixed (out of scope this session):** `exercises.duration_minutes` silently fails to insert for any non-integer value (0.75, 0.5 — confirmed reproducible, unrelated to this session's changes since catalog resolution never touches this column) even though the extraction prompt's own Dead Hang rule explicitly instructs fractional-minute values ("45 seconds → 0.75"). Whole-number durations insert fine. Explains the pre-existing "often mis-populated `duration_minutes` column" caveat already in `CLAUDE.md`'s `strength_milestone` docs. See §6.
>
> **2026-07-16 continuation session** (closing out session #7 after a mid-session computer restart — re-verified everything live against production rather than trusting the prior session's own notes, then closed the 4 remaining items):
> - **Re-verified the profile-1 apply, live, from scratch.** `GET /api/profiles/1/exercises/Dumbbell%20Curl` → still exactly its 1 original row, untouched. `.../Curl`, `.../Elliptical`, `.../Crunch` (old bare names) → all `0` rows. `.../Bicep%20Curl` → all 4 sessions aggregated, sane PR data. `GET /api/profiles/1/micro-goals` → both Dead Hang goals (`strength_milestone` + `daily_habit`) compute correctly live. All matches the prior session's claims — nothing regressed across the restart.
> - **"Dumbbell Curl" — confirmed no existing catalog row or alias, create command prepared, not run.** `GET /api/exercise-catalog?q=curl` shows only "Bicep Curl" and an unrelated "Curl and Squat" (a real profile-1 backfill artifact, not test data) — no "Dumbbell Curl" anywhere, so this is a CREATE via `POST /api/debug/exercise-catalog-upsert`, not an alias-on-existing-row command. `family:'Bicep Curl'`, `category:'strength'`, `source:'custom'`. Admin-secret-gated — command handed to the user to run themselves, not run by this session.
> - **Real gap found and fixed: confirming a chip never persisted anything.** Rule (a) (alias/fuzzy/haiku/custom always chip, never silent) was already correctly implemented — confirmed by reading the exact `['alias','fuzzy','haiku','custom']` check in `public/index.html`. Rule (b) (confirming persists the typed variant as an alias) was **not** — `ecDismissChip()` was a pure no-op ("✓" just removed the chip). Fixed: new `POST /api/exercise-catalog/confirm-alias` (`server.js`, not admin-gated — a normal user-flow side effect) appends `typed_name` to the resolved catalog row's `aliases`, idempotent/silent-fail; wired from a new `ecPersistConfirmedAlias()` called by `ecDismissChip()` on both tap and the 8s auto-dismiss. Guarded so it's a true no-op when `typed_name` normalizes identically to `canonical_name` (the `'alias'`-method case, which by design still shows a chip every time regardless — this only stops repeat fuzzy/Haiku resolution work, it doesn't suppress the standing "always ask" rule).
> - **Profile-4 test-data cleanup — mostly already clean.** Live-checked rather than assumed: `GET /api/profiles/4/exercises`, `/api/workouts?profile_id=4`, `/api/profiles/4/micro-goals?include_inactive=1` are all already empty — no test workouts, no "Dead Hang Practice" micro-goal to delete. The one real leftover is in the **shared, global** `exercise_catalog` table (not profile-scoped, so profile 4 being clean doesn't cover it): the made-up exercise from verification, "Kettlebell Twist Press" (id 20, `source:'custom'`), flagged for `DELETE /api/debug/exercise-catalog/20`. "Close Grip Push-Up" (id 19) and "Hang Clean" (id 21) are legitimate, real exercises from the same verification pass — confirmed they can't be duplicating anything MuscleWiki-seeded since that seed still hasn't run (no `source:'musclewiki'` rows exist at all). Both admin-secret-gated deletes/creates handed to the user to run themselves (PowerShell curl.exe, JSON body via file — inline JSON quoting breaks in PowerShell).
> - **Phase 2 (family/muscle-group rollups in Library) remains the queued follow-up**, not started this session — see §7 → Next up.
>
> **2026-07-16 session #8** (retired the never-run MuscleWiki seed, replaced it with wger.de — free, keyless, CC-BY-SA — bulk-seeded the catalog for real, found and fixed a real normalization bug along the way, cleaned up the resulting duplicates, all run live end-to-end):
> - **MuscleWiki seed retired, wger.de seed built and run for real.** `POST /api/debug/seed-exercise-catalog` (same route, repurposed) now pulls from wger's public `exerciseinfo` API (no key, single call per page — category/muscles/equipment/translations all denormalized together, unlike MuscleWiki's list-then-detail split) instead of the MuscleWiki API that required a $10/mo key never obtained across two sessions. All `MUSCLEWIKI_API_KEY` references removed from `server.js`; `musclewiki_id` column kept, now reserved for a future MuscleWiki *video-streaming* layer only (see §7). wger's category/muscle/equipment vocab mapped onto this app's own existing conventions (`WGER_CATEGORY_MAP`/`WGER_MUSCLE_MAP`/`WGER_EQUIPMENT_MAP`), confirmed live against wger's reference endpoints before hardcoding. New migration `2026-07-16_exercise_catalog_wger.sql` (nullable `wger_id` + unique partial index, widens `source` CHECK to admit `'wger'`; doesn't touch RLS/policies since it's a same-table column add, nothing to reassert) — **run manually, applied**. **Live run**: `{fetched:842, inserted:805, merged:27, refreshed:10, skipped:0, errors:0}` — merge-safe against every pre-existing row (wger_id-match refresh on re-run, else normalized-name/alias collision merge with existing data always winning, else insert new), every merge decision returned for review. Catalog: ~93 rows → 883 after seeding.
> - **Real bug found + fixed: `catalogNormKey()` only caught a plural on the LAST word.** Found reviewing the seed's own output, not by inspection: it lowercased/stripped hyphens+spaces FIRST, then stripped one trailing 's' off the whole concatenated string — so "push ups"→"pushup" only worked because "ups" happens to be last; a plural anywhere else was invisible ("Biceps Curl"→"bicepscurl" vs "Bicep Curl"→"bicepcurl" never collided). Fixed by stemming each word before joining (verified against 13 known pairs, zero regressions; one known remaining gap — "-es" plurals on sibilant-ending words like "Press"/"Presses" — deliberately not chased, since the fuzzy layer still catches that pair at 0.91 similarity, costing one confirm-tap instead of a silent miss). This is a save-time fix too, not just a seed-time one — verified live: typing "overhead triceps extension" now hits `method:'exact'` against the pre-existing "Overhead Tricep Extension" row.
> - **Post-seed near-duplicate audit found 5 real clusters, all resolved.** New `GET /api/debug/exercise-catalog-dupes` (general-purpose, not one-off) indexes every row's canonical_name + aliases under the FIXED `catalogNormKey` and flags any key claimed by 2+ rows. Found: (1) the "Overhead Tricep(s) Extension" pair — direct fallout of the normalizer bug above, since the original seed run used the still-buggy version; (2)-(4) three **wger-vs-wger** pairs (`Kettlebell Swing`/`Swings`, `Barbell Clean and press`/`Clean and Press`, `Side Dumbbell Trunk Flexion`/`Side bend`) — a different root cause: the seed's own merge-safety deliberately never merges two rows that both already have a `wger_id`, so two separately-inserted wger items with a textual relationship (one's alias matching another's name) can't merge with each other in a single pass; (5) `Good Morning`'s wger-supplied alias "Hip Hinge" colliding with the standalone `Hip hinge` row — reviewed with the user and correctly judged **not** the same thing (a hip hinge is a generic movement pattern several different exercises use, not itself a specific loggable exercise — the same safety class as "hang clean" never absorbing into "Dead Hang"), so the alias was stripped rather than merged. New `POST /api/debug/exercise-catalog-merge` (`{winner_id,loser_id,retitle_canonical_name?}` — fetches both rows fresh server-side, unions aliases, fills only empty fields, deletes the loser) and `POST /api/debug/exercise-catalog-remove-alias` (`{id,alias}`) built for this, general-purpose going forward. **Real ordering bug found live in the merge endpoint itself**: patching the winner before deleting the loser meant both rows briefly held the same `wger_id` whenever the winner had none of its own — tripped the unique index. Fixed (delete loser first). 4 merges + 1 alias-removal applied; re-running the dupe scan came back `cluster_count:0`. Final catalog: **879 rows**.
> - **Verified live end-to-end**, not by reading code: `Bicep Curl` (4 rows) / `Dumbbell Curl` (1 row) history and PRs both unchanged by the seed; `Bench Press` correctly muscle-tagged (`primary:["chest"], secondary:["shoulders","triceps"]`, equipment `["Barbell","Bench"]`); a genuinely common exercise wger did NOT seed a bare entry for ("lat pulldown" — wger only has variant-qualified names like "Wide-Grip Lat Pulldown") correctly fell through exact/alias/fuzzy to Haiku and created a new `source:'custom'` row with a confirm chip, exactly as designed — a concrete, real example of the kind of gap a Free Exercise DB top-up (see §7) could close; the Dead Hang micro-goals (`strength_milestone` + `daily_habit`, profile 1) and the `/exercises/stats` Library analytics endpoint both compute correctly, unaffected. All test artifacts (2 scratch saves on profile 4) cleaned up after verification.
> - **wger CC-BY-SA attribution** added to the Profile tab footer (`public/index.html`), required by the license.
> - **New local secret-handling convention**: `.env.claude.txt` (git-ignored, `ADMIN_SECRET=<value>`) lets an agent session call `/api/debug/*` endpoints against production directly without the value ever appearing in chat. `.gitignore` added to the repo for the first time this session (`.env.*` excluded) — the file existed untracked-but-unprotected before this, a real exposure risk fixed before anything else this session touched it. See CLAUDE.md → "Environment Variables".
>
> **2026-07-15 session #6** (closed §6's two top-priority known issues — analytics timezone fix + roadmap-regen offer — both audited-then-built-then-verified live against real production data, not just code review):
> - **Analytics streaks/bucketing timezone fix — ✅ shipped.** `currentStreakFromDates(dateSet, profile)` and the `/exercises/stats` weekly-volume cutoff now anchor "today" via `localToday()` instead of `ymdLocal(new Date())`/raw `new Date()` — both endpoints previously did no profile fetch at all, both now do (reusing `getProfileTimezone()`, no new helper). Audited first, not assumed: `longestStreakFromDates()` and both most-active-day bucketers do only self-consistent noon-anchored parsing of stored date strings with zero "now" dependency, confirmed and left untouched. **Verified with a mocked clock**: booted the real pre-fix and post-fix `server.js` at the same instant against a mock Supabase — a `timezone:null` profile's full response is byte-identical pre/post-fix on both endpoints (the regression check); a real positive-UTC-offset (Sydney) profile with a genuine 3-day streak gets `current_streak:2` (wrong) pre-fix vs. the correct `3` post-fix, matching `longest_streak` — direct proof of the bug the audit predicted (the "check yesterday" fallback in the old code goes the wrong direction for a server-behind-athlete timezone offset). See §6 item 1.
> - **Roadmap-regenerate offer after a confirmed goal update — ✅ shipped, after a live-verified design pivot.** Built the originally-specified design first — a `propose_roadmap_regen` tool the model calls itself — but 3 different live-tested prompt strategies (soft ask, explicit "don't ask first," then a blunt mechanical if/then rule) all failed identically in real chat sessions: the model narrated the offer in text without ever emitting the tool call, across 3 separate confirmed goal-updates, while `propose_goal_update` fired correctly all 3 times in the same session (ruling out a plumbing bug). **Pivoted to a server-triggered auto-offer** instead, per direct user decision after presenting the live evidence: `applyProposal()` now returns `{autoOfferGoal}` for a confirmed goal update whose goal has a roadmap; the confirm endpoint's new `maybeAutoOfferRoadmapRegen()` creates the pending proposal directly (dedup-guarded per goal) and returns it inline so the card renders immediately. `propose_roadmap_regen` was removed from `COACH_CHAT_TOOLS` — not model-callable anymore. Confirming the regen card calls a new shared `generateGoalRoadmapForGoal(profileId, goalId, mode)` (extracted from the existing `/roadmap` POST handler) with `mode:"regenerate"`, which increments the existing `version` and appends to `adaptation_log` instead of resetting them — per-goal only, the macro `roadmap_data` is never touched. **Two real live schema bugs found and fixed**, neither caught by code review: `chat_proposals.tool_use_id` is `NOT NULL` (every prior proposal assumed a model-tool-call origin; worked around with a synthetic sentinel string) and `chat_proposals.type`'s CHECK constraint didn't allow the new value at all (`migrations/2026-07-15_chat_proposals_regen_type.sql`, **run manually, applied**). **Bonus fix**: `formatGoalLineForChat()` never actually included a goal's `id` in the Coach Chat snapshot despite `propose_goal_update`'s own tool description telling the model to read it from there — a real pre-existing gap on the already-shipped tool, not just the new one. **Verified live end-to-end** on the "Test #3" scratch profile: positive case (goal-update confirm on a goal with a v1 roadmap → regen card auto-appears in the confirm response → confirm → roadmap becomes v2, `generated_at` refreshed, `adaptation_log` grows from 1 to 2 entries with the original preserved) and negative case (goal-update confirm on a roadmap-less goal → `follow_up_proposal:null`, no card). See §6 item 7. Commits `b733f70` → `16b1f7b`.
>
> **2026-07-15 session #5** (fixed a recurring bug class: server-side "today" was always UTC/server-OS time, never the athlete's real timezone):
> - **Confirmed repro, same bug class the Coach Chat "sync" fix (session #4) had already flagged as a known gap.** At ~7pm+ America/Chicago, the server (UTC) has already rolled to the next calendar day — a workout logged and saved under the correct local date got described by Coach Chat as yesterday's, and the today-fallback (raw `workouts` rows) found nothing because it was looking under the wrong date. Traced the actual mechanism: `dateStr()` is UTC (`.toISOString()`); `ymdLocal()` and several inline `getFullYear/getMonth/getDate` IIFEs — including the earlier Google Health daily-sync "local date" fix, whose own comment incorrectly claimed it matched "the app's local time" — use the Node **process's own OS timezone**, UTC on Render in practice. Neither helper has ever represented the athlete's real day; the Google Health fix only patched the `.toISOString()` symptom, not the actual mismatch.
> - **Audited every date-keyed call site before writing any code** (`new Date()`/`dateStr()`/`ymdNDaysAgo()` across all of `server.js`) and reported the full list, classified, before touching anything: 10 sites genuinely mean "the athlete's calendar day" (fixed this session); analytics current/longest-streak + weekly-volume bucketing, roadmap phase-date assignment, and the 60-90 day roadmap exercise-context windows are the same bug class at lower severity/higher fix-cost (deliberately deferred, confirmed with the user — **analytics streaks is the agreed immediate follow-up task**); every `new Date().toISOString()` stamping `created_at`/`updated_at`/`resolved_at`/`generated_at`/token `expires_at` is correctly left as UTC — those are timestamps, not date-keys.
> - **New `profiles.timezone` column** (text, IANA identifier, nullable — migration `migrations/2026-07-15_profile_timezone.sql`, **not yet run**, deliver-for-manual-run) + new `localToday(profile, offsetDays)` in `server.js` — the one athlete-timezone-aware date helper, `Intl.DateTimeFormat` with the `timeZone` option (no npm dependency), falling back to UTC when unset so **every existing profile is provably unaffected until the client captures a real value**. `dateStr()`/`ymdLocal()` are untouched and remain correct for non-athlete-specific things (OAuth expiry, audit timestamps, the legacy single-tenant `/api/daily` endpoint which predates the profile/timezone concept and is deliberately left on the UTC fallback).
> - **Silent client capture, no UI.** `captureTimezoneIfNeeded()` in `public/index.html`, called from `bootApp()` (the one function every login/boot-from-cache/onboarding path converges on) — reads `Intl.DateTimeFormat().resolvedOptions().timeZone`, compares against a fresh profile fetch, `PATCH`es only on a mismatch. No-op on every boot after the first per device.
> - **Converted 10 sites**: `buildChatSnapshot()` (the reported bug — `today` now computed *after* the profile fetch, and the snapshot now *always* states a `TODAY: <date>` line, not just conditionally via `TODAY'S READINESS`); `buildRecentExerciseLog()`'s 7-day window; `buildTodayWorkoutFallback()` (inherits the fix via #1); `computeFocusOverrideProposal()`'s default date range; `computeCheckinNoteProposal()`'s `daily_checkins` date key (**a bug introduced in the previous session's tool-use work**, not pre-existing — now stores the resolved date on the proposal payload so `applyProposal()` reuses the exact same value rather than recomputing at confirm time); the Google Health `ghDate` IIFE; `buildDailyData()`'s internal today/yesterday/weekAgo (new 3rd `timezone` param threaded through its 2 profile-scoped callers — `GET /api/profiles/:id/daily` and `life-os-summary`'s live-Fitbit fallback — the legacy single-tenant `/api/daily` call site deliberately left unchanged); the 7-Day Schedule Preview's whole rolling-week "today" (determines which **weekday** anchors match against — the profile fetch was pulled out of its `Promise.all` batch and sequenced first, one extra round-trip, accepted since this endpoint is client-cached); `POST /api/workouts`'s future-date rejection — a **real, distinct bug for positive-UTC-offset athletes** (e.g. Sydney): in their morning, if the server (UTC) is still on the prior day, a legitimately same-day log was wrongly rejected as "future."
> - **`CHAT_SYSTEM_PERSONA` updated** to point at the snapshot's new `TODAY:` line as the *only* source of truth for "today" — the model is now told never to assert, compute, or guess a date itself.
> - **Verified with a mocked clock, not just syntax-checked.** `localToday()` extracted verbatim and tested against fixed instants for both scenarios (7:30pm CDT / 00:30 UTC-next-day for Chicago; 8am AEST / 22:00 UTC-prior-day for Sydney) — confirmed the UTC-vs-local mismatch is real at those instants and that `localToday()` resolves correctly for both. Then the **real server process** was booted with `Date` mocked globally *before* `require("./server.js")`, so the actual shipped code — not a copy — ran against the fixed clock: proved a same-day evening workout appears correctly (`TODAY: 2026-07-15`) in a real `?debug=1` Coach Chat snapshot; proved a real `POST /api/workouts` call with the Sydney-correct local date now succeeds where it previously would 400, while a genuinely future date is still correctly rejected; proved a `timezone: null` profile's `GET /api/profiles/:id/daily` resolves a **byte-identical** date to the pre-fix UTC value at the same mocked instant — the regression check. Commit `0fd7051`.
>
> **2026-07-15 session #4** (Coach Chat — expert-reasoning prompt standard, tool-use write proposals, same-day workout visibility fix):
> - **Part A — shared expert-reasoning core.** New `EXPERT_REASONING_CORE` (~1400 chars), added — not a rewrite — to both coaching prompts: `buildSystemPrompt()` (`public/index.html`, daily_recs) and `CHAT_SYSTEM_PERSONA` (`server.js`, Coach Chat). Deliberately duplicated (no shared module system between the static frontend and Node backend) with cross-referencing comments in both files. Covers concrete S&C reasoning standards — weekly load/recovery against actual logged volume, progressive overload with real increments (+5-10lbs / +1-2 reps / +5-10s hold), hold-vs-deload judgment, interference effects (never stack two high-CNS sessions back-to-back), readiness/HRV/RHR as autoregulation inputs that change the plan — plus explicitly non-diagnostic sports-medicine judgment (load-tolerance pain logic; a plain, named redirect to a PT/physician for anything persistent/worsening/neurological, never a diagnosis). Verified via real function execution (server `?debug=1` + a live browser calling `buildSystemPrompt()` directly) that both copies assemble identically into the right place in each prompt.
> - **Part B — Coach Chat tool use: propose, never silently apply.** v1 write scope, deliberately narrow: update an *existing* goal (target/timeline/notes/active-paused), set/update/clear the standing Focus Override, log a free-text check-in note. Explicitly NOT supported: creating/deleting goals, workout/exercise edits, schedule changes — still app-only. **Audited existing write paths before building anything**: reused `loadProfileWithGoals()`/`findGoalById()`/`saveGoalToProfile()` (the Living Goal Roadmap endpoints' own helpers) for goals rather than duplicating write logic. **Caught a real bug in review before it shipped**: an early draft of the focus-override apply logic would have `PATCH`ed `profile_data:{focus_override:...}` directly against Supabase, which **replaces the whole `profile_data` column** and would have silently destroyed every other key (goals, schedule, `ai_prompt_context`, …) on the next confirm. Fixed with a new `saveProfileDataField()` — a generic sibling of `saveGoalToProfile()` that always writes back the full loaded object. Check-in notes use a fetch-then-merge upsert into `daily_checkins` so a note never wipes today's `energy`/`soreness`/`severity` from the app's own check-in form (that table's upsert is keyed on `(profile_id,date)` and overwrites the whole row otherwise).
>   - **Streaming**: `pipeAnthropicStream()` refactored with **zero behavior change for `daily_recs`** (same call site, same signature, same return value) — internals now delegate to a shared `pumpAnthropicLeg()` (pumps one SSE leg, now also reassembling `input_json_delta` chunks into parsed `tool_use` input) plus `startAnthropicStreamResponse()`/`finalizeAnthropicStream()` (shared headers/logging/`res.end()`, so both paths' observability never drifts). New `pipeAnthropicToolStream()` (coach_chat only) loops legs — tool call → `executeProposalTool()` creates a **pending** `chat_proposals` row (never writes real data) → `tool_result` tells the model it's pending confirmation → model finishes its turn → loop continues if another tool call follows, capped at `CHAT_MAX_TOOL_LEGS = 4`. All model text streams to the client as it's generated, across every leg — nothing hidden. After the loop, a **server-authored** (never model-generated) `[[APEXCOACH_PROPOSALS]]` marker is appended, embedded verbatim in the persisted message so a refresh never orphans the card.
>   - **Schema**: new `chat_proposals` table (migration `migrations/2026-07-15_chat_proposals.sql`, RLS + `service_role_bypass`, **not yet run** — deliver-for-manual-run) — `thread_id`, `message_id` (nullable, backfilled post-stream), `tool_use_id`, `type`, `payload` (`{title,changes:[{field,label,before,after}],reason,...}`), `status` (`pending`\|`confirmed`\|`canceled`). New additive `goal.target_date` field on `profile_data.goals[]` entries (no migration — jsonb) since no existing field covered "timeline"; "active/inactive" reuses the goal editor's existing `status:'PAUSED'` value rather than inventing a new field.
>   - **Confirm/Cancel** (`POST .../chat/proposals/:id/confirm` / `.../cancel`) are synchronous, **no live Anthropic call on either** — confirm applies the write via `applyProposal()` (the only function in the feature that writes real data) and marks `confirmed`; cancel just marks `canceled`. Both insert a short synthetic `chat_messages` note so the model's natural-language acknowledgment happens on the athlete's *next* real message rather than paying for a second live model turn per button click — a deliberate tradeoff, not an oversight. `GET .../chat/thread` now also returns a `proposals` array (live status for the whole thread) that the client always trusts over whatever status is frozen in an older message's embedded marker.
>   - **Frontend**: Cornerman-accented `cv-proposal-*` confirmation cards, Ember Confirm as the primary CTA, before→after diff list. `cvStripProposalMarker()` strips the marker on every render including mid-stream so the raw JSON never flashes into view. `cvRefreshProfileAfterApply()` re-fetches the profile after a confirm and refreshes `currentProfileData`/`ac_profile_data`/`ac_goal_progress` + re-renders goals/focus-override if those functions exist.
>   - **Verified in three passes**, not just syntax-checked: tool-loop mechanics (incremental JSON reassembly, multi-leg re-POST, marker injection, clean termination) via the exact current `pipeAnthropicToolStream()` extracted verbatim against a mock Anthropic tool_use SSE sequence; write safety (confirm changes only the intended fields and nothing else, cancel changes nothing, double-confirm rejected with 409) against the real server + a mock Supabase with real goal read/write round-trips; card rendering (marker stripped, correct diff, correct status transitions) via real function calls in a live browser. Commit `47065b4`.
> - **Part C — fixed: same-day logged workouts invisible to chat, model fabricated a "sync" excuse.** `buildRecentExerciseLog()` reads only the `exercises` table, but exercise rows come from a **separate, asynchronous** follow-up call — `saveWorkoutToSupabase()` fires `POST /api/workouts` first, and only after that resolves does it fire an independent `POST .../extract-exercises` call (its own Haiku request). A real multi-second window (or longer/never, on extraction failure) existed where a workout was fully saved but had zero `exercises` rows, making it invisible to chat — the model then guessed a "you may need to sync" explanation, wrong twice over since workouts are never wearable-synced. Audited the date-window bounds too: the query has no upper bound so a plain lookback-window timezone drift wasn't the cause here, but `buildChatSnapshot()`'s "today" is still computed via the **Render server's clock** (`dateStr(0)`), not the athlete's actual timezone (not stored anywhere in the schema) — flagged as a real, separate, **not fixed in this pass** gap rather than silently left undocumented. Fix: `buildTodayWorkoutFallback()` reads today's raw `workouts` directly and adds a fallback line (type + notes snippet, labeled `[logged just now, not yet broken into exercise data]`) for any not yet represented in `exercises` (cross-referenced by `workout_id`, which `buildRecentExerciseLog()` now also returns) — naturally stops appearing once extraction completes, since the snapshot rebuilds fresh every message. Also fixed `CHAT_SYSTEM_PERSONA` to explicitly rule out inventing a "sync" explanation for missing workouts (only biometrics are cache-based; logged workouts appear instantly) — the honest answer for a genuinely missing entry is "I don't see it yet." Verified against the real server + mock Supabase with a deliberately unextracted today-dated workout.
>
> **2026-07-15 session #3** (Coach Chat — daily_recs streaming-termination investigation + coach_chat caching fix):
> - **Investigated: daily_recs stream completes server-side, client never receives termination.** Production evidence: three consecutive requests each logged `Anthropic response status=200 (streaming)` → `usage (stream)` → `stream complete, wroteAny=true` server-side, while the client hit its 90s hard-cap (not the 45s idle timeout — chunks kept resetting the client's idle timer, so the connection stayed active) with no reassembled text. **Diffed `pipeAnthropicStream()` and `/api/ai` against the pre-Coach-Chat version — found zero functional changes.** The only diffs across the entire Coach Chat effort are a `label` param and a `fullText` accumulator, both inert to `res.write()`/`res.end()` timing; `res.end()` was and remains unconditional on every path. **Confirmed via `git diff 4fe0a15 27984cf` that 27984cf touched zero lines of the daily_recs path** — everything in that commit is scoped to `buildChatSnapshot()` and chat UI. If this is a code bug, it predates Coach Chat entirely; the "introduced by 27984cf" framing didn't hold up.
> - **New permanent observability**: `pipeAnthropicStream()` now logs on the response's `finish` event (data actually flushed to the socket) and `close` event (connection fully torn down), separately from the existing "stream complete" line — which only ever meant "upstream finished, about to call `res.end()`," not "the client received it." `res.end()` is now wrapped in try/catch so a throw there is no longer silent. Next occurrence will show definitively whether `res.end()` completed (rules out an Express-level bug) or never flushed (points at the proxy/socket layer).
> - **Applied a precedented mitigation, not a proven root-cause fix.** Added `anthropicStreamAgent = new https.Agent({keepAlive:false})` to both Anthropic streaming fetch calls (`daily_recs`, `coach_chat`) — the identical fix this file already applies to Fitbit's token endpoint for a documented "Render's node-fetch pool has a compatibility issue... causes Premature close on pooled sockets" bug. Also tuned `httpServer.keepAliveTimeout`/`headersTimeout` (65000/66000ms) — the standard mitigation for a Node app's keep-alive timeout racing a reverse proxy's own (Render's is commonly ~60s vs Node's 5s default).
> - **Real local E2E verification** (not just server-side logging): the exact current `pipeAnthropicStream()` was extracted **verbatim** (brace-matched out of `server.js`, not retyped) into a standalone harness, run against a local mock Anthropic SSE server under 3 patterns — normal pacing, a 3000-chunk fast/large stress test (backpressure), a slow 2s-spaced trickle (idle-timer-reset path) — driven by a client replicating `fetchAI()`'s real reader-pump logic. All three reached `done:true` cleanly (690ms/82ms/10.1s respectively) with the new FINISHED/CLOSED logs firing correctly right after "stream complete." The current shipped code is confirmed correct under every locally-reproducible condition.
> - **Fixed: `coach_chat` always logged `cache_write=0 cache_read=0`.** Not a bug in `wrapSystemWithCache()` — verified structurally identical to `daily_recs`'s path (string → `[{type:"text", text, cache_control}]` either way). Root cause: Anthropic requires a **1024-token minimum cacheable prefix for Sonnet**, and `CHAT_SYSTEM_PERSONA` + a deliberately condensed athlete snapshot (Part A's own fix, ironically) was landing well under that for a typical profile (~875 estimated tokens before the fix). Fixed by expanding `CHAT_SYSTEM_PERSONA` from ~700 to ~4950 characters (~1200+ estimated tokens) of genuinely useful coaching-style/behavioral guidance (voice calibration, conversation-memory handling, explicit enumeration of what the snapshot contains) — deliberately in the **stable, athlete-independent** block rather than padding the snapshot, since snapshot size varies per athlete and would make caching unreliable.
> - **Bonus fix found while diagnosing Bug 2: `?debug=1` was lying about what gets sent.** It returned the pre-`wrapSystemWithCache()` system STRING, not the actual cache-wrapped array Anthropic receives — useless for verifying caching specifically. Fixed to return the real post-wrap structure plus `system_est_tokens` and `cache_control_present`, verified against the mock-Supabase test profile: 6049 chars ≈ 1512 estimated tokens, `cache_control_present: true`, comfortably over the 1024-token floor. Commit `17d73a3`.
>
> **2026-07-15 session #2** (Coach Chat — snapshot completeness audit/fix + docked desktop panel):
> - **Bug found + fixed: chat only saw ~4-5 of the athlete's goals.** Root cause was a hardcoded `goals.slice(0, 5)` in `buildChatSnapshot()` — completely independent of the char budget, so any goal outside the top 5 by priority order was dropped every time regardless of available room. **Not a truncation-cap issue at all.** Fixed by removing the slice and condensing the per-goal format (`formatGoalLineForChat()`: title + type + the goal's own stored `target_value`/`current_value`/`unit`/`status`, one line each) so all goals fit without a count cap. Active Challenges (micro-goals) got the same one-line-each treatment; the Supabase query limit was raised 10→50 as a generous ceiling rather than a real cap.
> - **Bug found + fixed: Focus Override invisible to chat.** Audited where `focus_override` actually lives before touching anything — it's `profile_data.focus_override`, persisted server-side via the same `PATCH /api/profiles/:id` path as goals/schedule, and already being fetched in full by `buildChatSnapshot()`'s existing profile-row query. **Not a client-only-state architecture gap** as initially suspected — the assembler simply never read it. Fixed with `summarizeFocusOverrideForChat()`, mirroring `resolveFocusOverride()`'s standing-directive branch (active + in date range) from `public/index.html`; the daily-recs-card-only `force`/`total`/`skip` per-call flags don't apply to chat and were deliberately left out.
> - **Bug found + fixed: silent truncation risk in the char cap itself.** The old `snapshot.slice(0, CHAT_SNAPSHOT_CHAR_CAP)` was an unconditional hard string cut with zero logging — if core content (goals/challenges/schedule/biometrics) alone ever exceeded 5000 chars, it would've been silently guillotined mid-line. Replaced with a soft/hard cap split: `CHAT_SNAPSHOT_CHAR_CAP = 5000` (soft — only the recent-exercise log, then profile context, are elastic; if core content alone exceeds it, `console.warn`'s and lets it through rather than cutting) and `CHAT_SNAPSHOT_HARD_CAP = 8000` (hard backstop — profile context shrinks further, then lowest-priority goals drop one at a time from the tail, each drop `console.warn`'d by name). Verified against a mock Supabase: a realistic 8-goal case (including a goal deliberately placed at priority rank 8, matching the reported bug) now includes everything; a deliberately pathological 300-goal stress case correctly exercises the hard-cap drop path with full logging instead of a silent cut.
> - **New permanent debug capability.** `?debug=1` on `POST /api/profiles/:id/chat/message` (same body) returns the fully assembled `{snapshot, system, messages, char counts, char_guard}` as JSON instead of calling Anthropic — free, no message persisted. `buildChatSnapshot()` also always logs a compact one-line summary (chars/goals/challenges/focus-override-active) on every real call, with a full snapshot dump to the console when debug is set. Kept intentionally, not a one-off — snapshot-completeness bugs are expected to recur as new context sources get added.
> - **Docked desktop chat panel.** `#chat-view` stays a fullscreen takeover on mobile (unchanged) but becomes a bottom-right docked panel on desktop via `@media(min-width:769px)` — 400px wide, 66vh tall (max 720px), anchored `right:24px;bottom:0`, rounded top corners only, drop shadow. Breakpoint deliberately matches the app's existing mobile-bottom-nav/desktop-top-nav split (768/769px), not the separate 700px breakpoint used elsewhere for minor padding. Zero changes to `openChatView()`/`closeChatView()`/`sendChatMessage()` — purely a CSS repositioning of the same DOM, verified visually at 1440×900 and 390×844 via gstack browse.
> - **New header entry point, Today-tab trigger removed.** Added `.chatHeaderBtn` (💬, cornerman-purple bordered, own scoped class — no `.gearBtn`/`.syncBtn` edits) to the header's icon-button row next to the profile avatar, visible on every tab. Removed the original Today-tab "💬 Talk to your coach" button under the AI rec card — it was a pure duplicate destination with no contextual difference from the header button, and dropping it aligns with the existing "Today tab declutter" item in §7 Next up. Commit `27984cf`.
>
> **2026-07-15 session** (Coach Chat — persistent, server-driven AI coaching conversation):
> - **Coach Chat — new persistent chat feature.** One thread per profile (`chat_threads`/`chat_messages`, migration `migrations/2026-07-15_chat.sql`, RLS + `service_role_bypass` — run manually, not auto-applied) for open-ended conversation about workouts/goals/schedule/biometrics, distinct from the structured daily-rec cards and the one-shot "Ask Your History" search. Reachable via a **💬 Talk to your coach** button on the Today-tab AI rec card, opening `#chat-view` — a body-level overlay sibling of `#settings-overlay` (reachable from any tab, unlike `#goal-roadmap-view` which is nested inside `#tab-profile`).
> - **Server-driven by necessity.** Unlike `daily_recs`, whose prompt is assembled **client-side** from already-loaded browser state (`buildScheduleInstruction()` etc.), chat has no such state server-side, so `buildChatSnapshot()` rebuilds a compact athlete snapshot from Supabase on every send — profile/goals/active challenges/schedule (`formatScheduleForChat()`) + **DB-first cached** biometrics (`daily_sleep`/`daily_steps`/`body_metrics`, no live wearable call — same philosophy as the `life-os-summary` fast path) + a condensed 7-day exercise log, mirroring the `getFullExerciseContext()`/`getGoalExerciseContext()` pattern rather than duplicating client prompt builders. **Known gap:** zone/active-minutes aren't persisted anywhere in the schema, so they're omitted from the snapshot rather than adding a live wearable call per message.
> - **Model routing + streaming reuse.** New `CALL_TYPE_MODEL` entries `coach_chat` → Sonnet, `chat_summarize` → Haiku; unknown callTypes now `console.warn` instead of silently defaulting to Sonnet (closes a footgun). Streaming reuses `pipeAnthropicStream()` (now takes a `label` param and **returns the accumulated text** so the caller can persist it) — the same helper that lets `daily_recs` survive Render's idle-connection window. The `/api/ai` proxy's inline cache-control block was extracted into a shared `wrapSystemWithCache()` so chat's server-assembled system prompt (which bypasses the client-facing `/api/ai` proxy entirely, since chat builds its own request) gets identical caching behavior, now including a 1h TTL for `coach_chat` alongside `daily_recs`.
> - **Cache-friendly prompt split + 20k char guard.** System block = stable persona + athlete snapshot + rolling summary (cached, no per-request-varying data); thread history goes in `messages` (expected to grow every turn, deliberately excluded from the cached prefix). `CHAT_CHAR_GUARD = 20000` (snapshot capped independently at `CHAT_SNAPSHOT_CHAR_CAP = 5000`) — unlike daily_recs' 6000-char guard (sized against a non-streamed 25s timeout), chat streams, so this is a deliberate cost/size ceiling, not a timeout race. `enforceChatCharGuard()` trims oldest-first, dropping complete user+assistant turn-pairs to preserve the Anthropic API's required role alternation.
> - **Fire-and-forget summarization, not inline.** Past `CHAT_SUMMARIZE_TRIGGER = 24` un-summarized messages, `summarizeChatThreadIfNeeded()` folds everything older than the most recent `CHAT_SUMMARIZE_KEEP_TAIL = 20` into `chat_threads.summary` via Haiku, called **after** the stream ends without `await` (matches the `maybeAdaptAllRoadmaps()` pattern) — never adds latency to a send. A send that races ahead of summarization just falls back on the char guard's oldest-first trim.
> - **Frontend mirrors `fetchAI()`'s streaming pattern**, deliberately adapted in one place: `sendChatMessage()` uses the same reader-pump loop, idle-reset (45s) + hard-cap (90s) abort timers, and bounded 3-attempt/3s-backoff retry, but retry state (`cvPendingRetry`) is scoped to the one in-flight message rather than `fetchAI`'s single global `aiRetryTimer`/`aiPermanentlyFailed` flags — so one message's exhausted retry chain can't block a later, unrelated message. AI bubbles reuse the established Cornerman-purple AI-attribution treatment (`border-left:3px solid var(--accent-cornerman)`, matching `#history-answer`); assistant text renders through the existing `parseMd()` helper. Commit `4fe0a15`.
> - **Explicitly untouched**: `profiles.roadmap` (legacy text roadmap) and its write path, `fitbit_pending_imports`, all wearable sync logic. No new npm dependencies — raw `node-fetch` SSE pipe, same as `daily_recs`.
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

## 0. How We Work — Standing Conventions

> **Read this first, every session, before §1.** These rules are not preferences — they are
> the operating contract for this project. They override any habit or default behavior.

### 0.1 Communication Contract

**Shimmy is the product owner, not the developer.** Claude Code is the developer. This chat
is the design, decision, and approval layer.

- **Plain language first, technical detail second.** Lead with what it means, what it costs,
  what breaks, and what the decision is. Drop into implementation detail only as deep as the
  decision actually requires — and say when you're switching registers.
- **Never assume shared jargon.** If a term is project-internal (`withRefreshLock`,
  `buildScheduleInstruction`, `resolve-batch`), say what it *does* in one clause the first
  time it appears in a thread.
- **Concise and direct.** No preamble, no affirmations, no filler. If the answer is two
  sentences, give two sentences.
- **One decision at a time**, with explicit options and a single recommendation. Don't stack
  three open questions into one message.
- **Correct immediately.** If Shimmy is wrong on a technical fact or a business assumption,
  say so up front — no easing in.
- **Push back up to two rounds** when a proposal is wrong or suboptimal. If Shimmy overrides
  after that, execute his call without relitigating.
- **Flag risk unprompted.** Surface problems he hasn't asked about.
- **Keep momentum.** If a thread is bogging down, say so and name the next best step.

### 0.2 Hard Guardrails

These are not negotiable and apply to every session:

1. **Audit-report-first.** Anything touching data flow gets a Phase 1 audit. Findings are
   surfaced and work **STOPS** for approval before any code is written. No blind builds.
2. **Scope lock.** One session, one scope. No scope creep mid-execution. New ideas that
   surface get written to the roadmap, not built.
3. **SQL migrations** are always written by the agent and executed manually by Shimmy in the
   Supabase SQL editor. Never assume a migration has been run — confirm it.
4. **Verification is not optional.** "Shipped" and "verified live" are different states and
   must be tracked separately (see §0.4).
5. **Never guess at ambiguous data.** If something's intent is unclear (a catalog name, a
   user's meaning), flag it and leave it — don't invent a resolution.

---

### 0.3 Session Start Workflow

**Trigger phrase: "start new session workflow"**

On that phrase, run this without further prompting:

1. **Read `CLAUDE.md` and `ROADMAP.md` fully.** They are the source of truth and override any
   in-thread assumption or memory.
2. **Report back, in this order:**
   - **Pending verifications** — anything shipped-but-unverified from prior sessions, with the
     exact check needed to close it out.
   - **Open bugs** — anything in §6/§9 that is active, not parked.
   - **This cycle's priorities** — the current agreed ordering from §7.
   - **Anything blocked**, and what it's blocked on.
3. **Confirm the single scope for this session** before any work begins. Get explicit approval.
4. **If the scope touches data flow**, the first deliverable is an audit report, not code.

---

### 0.4 Session Close-Out Workflow

**Trigger phrase: "close out session"**

This produces **four artifacts**. All four, every time, even for a short session.

#### Artifact 1 — Documentation Update (in-depth, not a summary)

Update `ROADMAP.md` and `CLAUDE.md` to capture **everything** covered in the thread. Err
heavily toward over-documenting; this project's failure mode is context loss between threads.

- **New dated, numbered session banner** at the top of `ROADMAP.md`: what was worked on, root
  causes found (with evidence, not guesses), what shipped, what was measured, and explicitly
  what is verified live vs. not.
- **`CLAUDE.md` implementation section** for anything architectural, with enough detail that a
  cold reader could pick it up without the thread.
- **§6 Known Limitations** — every limitation discovered, including ones deliberately not fixed.
- **§7 Roadmap** — re-order if priorities moved; add anything newly scoped.
- **§9 Tech Debt** — every new debt item, including ones we chose not to address.
- **Capture all of the following, not just the code changes:**
  - Bugs found (fixed *and* unfixed)
  - Bugs fixed, with root cause
  - New ideas raised, even half-formed ones
  - Decisions made, with reasoning
  - **Decisions deliberately declined**, with reasoning — so they don't resurface later as
    open questions
  - Anything tried that didn't work, and why (saves re-treading it)

#### Artifact 2 — Claude Code Hygiene Prompt

A paste-ready, **report-only** prompt for Claude Code (no writes, no fixes) covering:

- **Dead code** — functions, endpoints, columns, or CSS with zero call sites, whether
  introduced this session or orphaned by it.
- **Security** — new endpoints admin-gated where appropriate? Secrets or tokens in log output?
  RLS + `service_role_bypass` on any new table? Input validation on new query params or body
  fields? Any user-supplied value reaching `innerHTML` unsanitized?
- **Loose ends** — TODOs left in code, commented-out blocks, `console.log`s that should be
  removed vs. deliberately kept as diagnostics.
- **Doc drift** — does `CLAUDE.md`/`ROADMAP.md` still match what's actually in `server.js` and
  `public/index.html`?
- **Migration status** — any migration file written but not confirmed run in production.
- **Resilience discipline** — any new `fetch()` without a timeout, any unbounded retry, any new
  Fitbit call missing `keepAlive: false`.
- **Scope check** — did anything land outside the session's agreed scope?

#### Artifact 3 — Verification Ledger

Three explicit buckets. This is the artifact that prevents the recurring
"not yet verified live at write time" drift:

| Bucket | Requirement |
|---|---|
| **Verified live** | State *how* it was verified — the query, the endpoint, the observed value |
| **Shipped, NOT verified** | State the *exact* check needed to close it, ready to run |
| **Not shipped** | Scoped but unbuilt — where it now sits in the roadmap |

#### Artifact 4 — Next-Session Handoff Prompt

A paste-ready block to open the next thread, containing:

- Instruction to read `CLAUDE.md` + `ROADMAP.md` first
- Pending verifications carried forward (from Artifact 3)
- The agreed priority ordering for the next cycle
- The single decision or check needed to start

> **If the close-out output is too long to be useful in-thread**, compress Artifacts 1–3 into
> the docs and hand over only Artifact 4. The docs carry the detail; the handoff prompt
> carries the momentum.

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
| ~~`roadmap`, `roadmap_updated_at`~~ | — | **Removed entirely 2026-07-17** — code (endpoint + client fns) and columns both gone (`migrations/2026-07-17_drop_legacy_roadmap.sql`, run in production). Was the legacy free-text macro road map, superseded by `roadmap_data`. |
| `roadmap_data`, `roadmap_data_updated_at` | jsonb / ts | Structured macro road map (ties all goals; served by `/roadmap-data`) |
| `daily_recommendations` (jsonb), `daily_recommendations_date` (date), `daily_recommendations_readiness` (int) | | Daily rec cache |
| `progress_brief` (jsonb), `progress_brief_date` (date) | | Progress brief cache |
| `height_inches`, `birth_date`, `sex`, `goal_weight_lbs`, `goal_weight_timeline_months` | | Body-composition profile fields |
| `gym_access` | text | `yes` / `no` / `sometimes` |
| `gym_type` | text | Commercial gym / Home gym / CrossFit / functional fitness / Multiple |
| `dismissed_fitbit_activities` | jsonb (default `[]`) | Global wearable-activity dismissals — array of namespaced `"provider:id"` strings (e.g. `fitbit:…` or `google_health:…`) hidden from the Unmatched Wearable Activities card (§3). Migration `2026-05-22_dismissed_fitbit_activities.sql`. |
| ~~`fitbit_pending_imports`~~ | — | **Removed entirely 2026-07-17** — code (`diffAndQueueFitbitImports()` + both endpoints) and column both gone (`migrations/2026-07-17_drop_fitbit_pending_imports.sql`, run in production). Was replaced by `dismissed_fitbit_activities` + the Unmatched Fitbit card. |
| `timezone` | text | IANA identifier (e.g. `America/Chicago`), nullable, no default. Captured silently client-side (`captureTimezoneIfNeeded()`, no UI) and consumed by `localToday()` for every server-side "today" computation. Migration `2026-07-15_profile_timezone.sql`. |
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
| `id`, `profile_id`, `date` | | |
| `workout_id` | bigint, nullable, FK → `workouts.id` `ON DELETE CASCADE` | `exercises_workout_id_fkey`, added `2026-07-17_exercises_workout_fk_cascade.sql`, **run in production** — makes the orphaned-exercises bug class structurally impossible. Nullable: `extract-exercises` can insert `workout_id: null`, always FK-valid, never reached by the cascade — `DELETE /api/profiles/:id`'s explicit `exercises` cleanup stays load-bearing for that case even with the FK in place. |
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
- **`daily_sleep`** *(Life OS fast-path, added 2026-05-24)* — id, profile_id, date, hours, score (the COMPUTED personal sleep score, not Fitbit's), deep_minutes/rem_minutes/light_minutes/wake_minutes, hrv, rhr, source, created_at. UNIQUE(profile_id, date). Migration `2026-05-24_daily_sleep.sql` has no RLS/policy statements — flagged by the 2026-07-16 doc-sync audit as undocumented/unverified, and **fixed the same day**: RLS + `service_role_bypass` applied manually via the Supabase SQL editor (no committed migration, same ad-hoc convention as several other tables/columns in this project). `CLAUDE.md`'s RLS enumeration now lists 16 tables including `daily_sleep`. See §6.
- **`daily_checkins`** — id, profile_id, date, energy, soreness (text[]), severity, checkin_text, created_at. UNIQUE(profile_id, date).
- **`workout_templates`** — id, profile_id, name, type, notes_template, exercises (jsonb), use_count, created_at. Saved routines (▶ Use buttons).
- **`tokens`** *(legacy)* — pre-multi-profile single-user Fitbit token store; still read as a fallback in `/callback` and `/api/token-info`. Superseded by `profiles.fitbit_*` + `wearable_connections`.
- **`chat_threads`** *(Coach Chat, added 2026-07-15)* — id, profile_id (FK, UNIQUE — one thread per profile), summary (text, nullable), summary_through_message_id (bigint, nullable), created_at, updated_at.
- **`chat_messages`** *(Coach Chat, added 2026-07-15)* — id, thread_id (FK), role (user|assistant), content (text), created_at. Full history kept forever; summarization only updates `chat_threads.summary`, never deletes rows.
- **`chat_proposals`** *(Coach Chat tool use, added 2026-07-15)* — id, thread_id (FK), message_id (FK, nullable, backfilled post-stream), tool_use_id, type (update_goal|set_focus_override|log_checkin_note|regenerate_goal_roadmap), payload (jsonb), status (pending|confirmed|canceled), created_at, resolved_at.
- **`exercise_catalog`** *(exercise canonicalization, added 2026-07-15, wger-seeded 2026-07-16)* — id, canonical_name (UNIQUE), aliases (text[]), family (text, phase-2), muscle_groups_primary/secondary (text[], phase-2), equipment (text[], phase-2), category (matches exercises.main_category), is_duration_based (bool), source (musclewiki\|custom\|wger), musclewiki_id (nullable, unique when set — reserved for a future MuscleWiki video layer, not a data source), wger_id (nullable, unique when set — added `2026-07-16_exercise_catalog_wger.sql`). Not per-profile — one shared catalog, **879 rows**.

### Migrations
- `migrations/2026-05-19_wearables.sql` — adds `workouts.wearable_data` + `wearable_activity_id`, creates `wearable_connections` + `rejected_wearable_matches`, backfills Fitbit tokens from `profiles.fitbit_*`.
- `migrations/2026-05-22_roadmap_data.sql` — adds `profiles.roadmap_data` (jsonb) + `roadmap_data_updated_at` (timestamptz) for the structured macro roadmap. Legacy `profiles.roadmap` (text) code was retired 2026-07-17 — see `2026-07-17_drop_legacy_roadmap.sql` below.
- `migrations/2026-05-22_dismissed_fitbit_activities.sql` — adds `profiles.dismissed_fitbit_activities` jsonb (default `[]`) for global wearable-activity dismissals (workout-agnostic, because `rejected_wearable_matches.workout_id` is `NOT NULL`).
- `migrations/2026-05-24_daily_sleep.sql` — adds the `daily_sleep` table (Life OS sleep fast-path; see `CLAUDE.md`).
- `migrations/2026-05-26_google_health.sql` — adds `wearable_connections.provider_metadata` jsonb (default `{}`) for the Google Health API v4 integration (stores the stable Google Health identity).
- `migrations/2026-07-15_chat.sql` — adds `chat_threads` + `chat_messages` (Coach Chat), with RLS + `service_role_bypass` matching the other 11 tables. **✅ Applied to production.**
- `migrations/2026-07-15_chat_proposals.sql` — adds `chat_proposals` (Coach Chat tool-use write proposals), RLS + `service_role_bypass`. **✅ Applied to production.**
- `migrations/2026-07-15_profile_timezone.sql` — adds `profiles.timezone` (text, IANA identifier, nullable, no default — fixes the UTC-vs-athlete-timezone bug class, see session #5 changelog above). **✅ Applied to production.**
- `migrations/2026-07-15_chat_proposals_regen_type.sql` — adds `'regenerate_goal_roadmap'` to `chat_proposals.type`'s CHECK constraint (the original migration only allowed the first 3 proposal types; found live via a real `23514` constraint violation while verifying the roadmap-regen auto-offer — see session #6 changelog above). **✅ Applied to production.**
- `migrations/2026-07-15_exercise_catalog.sql` — creates `exercise_catalog`, RLS + `service_role_bypass`, seeded from the existing `CANONICAL_NAMES` map (18 rows). **✅ Applied to production.**
- `migrations/2026-07-16_exercise_catalog_wger.sql` — adds `exercise_catalog.wger_id` (text, unique when set) and widens the `source` CHECK to admit `'wger'`; doesn't touch RLS/policies (adds a column only). **✅ Applied to production.**
- `migrations/2026-07-17_drop_fitbit_pending_imports.sql` — drops `profiles.fitbit_pending_imports`. Code removed same day (§9). **✅ Applied to production.**
- `migrations/2026-07-17_drop_legacy_roadmap.sql` — drops `profiles.roadmap` + `roadmap_updated_at`. Code removed same day (§9). **✅ Applied to production.**
- `migrations/2026-07-17_exercises_workout_fk_cascade.sql` — adds `exercises_workout_id_fkey` (`exercises.workout_id → workouts.id`, `ON DELETE CASCADE`). **✅ Applied to production** — the orphan check ran clean across every profile first (a pre-existing orphan would have made the `ALTER TABLE` itself fail); see §9.
- `migrations/2026-07-17_wearable_needs_reconnect.sql` — adds `wearable_connections.needs_reconnect` (boolean, `NOT NULL DEFAULT false`) for the connection-health flag (session #19). **⚠ Run manually in the Supabase SQL editor.** Code is resilient to its absence — writes are best-effort and the providers endpoint falls back to a column-less select — so it can be applied just before/with the deploy without a broken window, but the flag only persists/reports once it's run.
- `migrations/2026-07-17_exercise_catalog_content.sql` — adds `exercise_catalog.description` (text) + `images` (jsonb), both nullable, for the exercise how-to content seed (session #25). **⚠ Run manually.** Populated by `POST /api/debug/seed-exercise-content` (fill-if-null, keyed by `wger_id`). Endpoint 500s cleanly if the columns are absent.

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

### Exercise Canonicalization (2026-07-15/16 session)
Generalizes the Dead Hang hand-fix (CANONICAL_NAMES, 18 exercises) into a catalog-backed system covering every logged exercise. Full detail in `CLAUDE.md` → "Exercise Canonicalization".
- **`exercise_catalog` table** — seeded from CANONICAL_NAMES, then bulk-seeded from wger.de (879 rows). `family`/`muscle_groups_primary`/`muscle_groups_secondary` now consumed by phase 2 (Library family rollups, muscle-group filter, muscle heatmap — session #9, 2026-07-16); `equipment` still not consumed by anything.
- **`resolveExerciseCatalog()`** — exact/alias (instant) → fuzzy (Levenshtein) → Haiku fallback (separate call, not folded into the main extraction prompt) → new `source:'custom'` row if genuinely new. Layered on top of the existing `normalizeExerciseName()` pass, never disagrees with it.
- **Confirm chip** — only `'exact'` matches save silently; alias/fuzzy/Haiku/custom all confirm (standing rule set mid-session after live review showed alias hits are always a real merge decision here, never cosmetic).
- **⚠ Correction (2026-07-16 doc-sync):** this bullet previously read "MuscleWiki bulk-seed — built, not run (no API key this session)" — stale as of session #8: the MuscleWiki seed was retired (never called in production, paid key never obtained) and **replaced by the wger.de bulk-seed**, which *did* run for real (see the "`exercise_catalog` table" bullet above). No `MUSCLEWIKI_API_KEY` references remain in `server.js`.
- **Reviewed backfill** — run for real against profile 1: 13 of 14 proposed merge rows applied (1 excluded on review — "Dumbbell Curl" kept distinct).
- **Manual catalog curation via `exercise-catalog-upsert`, run 2026-07-16 (curl, undocumented until this doc-sync pass)** — `Bicep Curl` (id 9) and `Dumbbell Curl` (id 100) both curated to `family:"Bicep Curl"` (now group together on the Library rollup); `Dead Hang` (id 18) curated with real primary/secondary muscle data (was empty, per the heatmap finding in `CLAUDE.md` → Phase 2). Pre-wger custom rows only get family/muscle data from a wger merge or a manual upsert like this one — remaining gaps curated reactively.
- **Save-time matching re-verified live, 2026-07-16** — "dumbell curlz" and "bench pres" both resolved correctly, typo persisted as an alias via the confirm-chip auto-dismiss. No code change.
- Found live (not fixed, out of scope): `exercises.duration_minutes` silently fails to insert for non-integer values. See §6.

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
| DELETE | `/api/profiles/:id` — deletes `exercises` (2026-07-17, see §9) then `workouts` then the profile row |

### Daily data / biometrics
| Method | Path |
|--------|------|
| GET | `/api/daily` · `/api/profiles/:id/daily` |
| GET | `/api/profiles/:id/daily-steps` · `/api/profiles/:id/body-metrics` |
| POST | `/api/profiles/:id/body-metrics` |
| GET | `/api/profiles/:id/unmatched-fitbit` — last-7-day unmatched activities + same-day match candidates; `{activities:[]}` if no token / Fitbit error |
| POST | `/api/profiles/:id/dismiss-fitbit-activity` — body `{provider_activity_id}`; global dismissal → `dismissed_fitbit_activities` |
| POST | `/api/profiles/:id/fitbit-backfill` |

### Workouts / templates / exercises
| Method | Path |
|--------|------|
| GET | `/api/workouts?limit=&offset=` (offset additive 2026-07-17, backward-compatible — pages the Log-past "See more") · `/api/workouts/:id/full` |
| POST | `/api/workouts` · PATCH `/api/workouts/:id` · DELETE `/api/workouts/:id` |
| POST | `/api/profiles/:id/reformat-titles` · `/api/profiles/:id/dedupe-workouts` |
| GET/POST | `/api/profiles/:id/templates` · PATCH/DELETE `/api/templates/:id` |
| POST | `/api/profiles/:id/extract-exercises` — now also resolves each name against `exercise_catalog` (see "Exercise Canonicalization" in `CLAUDE.md`); response's `exercises[]` includes `catalog_match:{method,typed_name}` per row for the frontend confirm chip |
| GET | `/api/profiles/:id/exercises` · `/exercises/stats` · `/exercises/:name` (returns history + catalog `family`/muscles, and — session #26 — `category`/`description`/`images` via a targeted single-row fetch; works for unlogged names too) · `/exercises/audit` |
| GET | `/api/exercise-catalog?q=` — search the shared catalog (not profile-scoped), for the confirm-chip "change" picker. Extended additively (2026-07-16 session #10) for the Exercise Guide: also selects `family`/`muscle_groups_primary`/`muscle_groups_secondary`/`equipment`; accepts `?all=1` (bypasses the 50-row cap up to 2000, Guide's one bulk load) or explicit `?limit=`/`?offset=`. `?q=` shape/behavior unchanged. |
| PATCH | `/api/profiles/:id/exercises/:exerciseId` — body `{canonical_name}` or `{keep_as_typed:true, typed_name}`, the confirm-chip "change" action |
| POST | `/api/exercise-catalog/confirm-alias` — body `{canonical_name, typed_name}`, not admin-gated; fired by the confirm chip's "✓" to persist the typed variant as an alias (see "Exercise Canonicalization" in `CLAUDE.md`) |
| DELETE | `/api/profiles/:id/exercises/:exerciseId` |
| GET | `/api/meditations` |

### Coaching / AI
| Method | Path |
|--------|------|
| POST | `/api/ai` (Anthropic proxy, server-side model selection) |
| GET/POST | `/api/profiles/:id/brief` · `/generate-brief` |
| POST | `/api/profiles/:id/search-history` |
| GET/POST | `/api/profiles/:id/daily-recs` · `/progress-brief` · `/roadmap-data` (structured macro, Sonnet) |
| GET | `/api/profiles/:id/life-os-summary` — read-only aggregated daily summary for the external Life OS app; auth `X-Life-OS-Key` (or admin secret); DB-first sleep/HRV/RHR (see `CLAUDE.md` for full field shape) |
| POST | `/api/profiles/:id/goal-progress` · `/generate-goal-description` |
| POST | `/api/profiles/:id/week-preview` — 7-Day Smart Schedule Preview (`schedule_preview` → Haiku); body `{schedule, readiness}` → rolling-7-day rule-engine skeleton + per-day Haiku coaching notes; non-fatal (6s cap), returns `{week, week_note, generated_at}` |
| GET/POST | `/api/profiles/:id/checkin` |
| POST | `/api/profiles/:id/chat/message` — Coach Chat, streamed (`coach_chat` → Sonnet); body `{text}`; server-assembled snapshot + thread history, persists both sides of the turn |
| GET | `/api/profiles/:id/chat/thread` — full Coach Chat thread history for initial render + live `proposals` array |
| POST | `/api/profiles/:id/chat/proposals/:proposalId/confirm` — applies a pending tool-use write proposal (goal update / focus override / check-in note); no live Anthropic call |
| POST | `/api/profiles/:id/chat/proposals/:proposalId/cancel` — cancels a pending proposal, writes nothing; no live Anthropic call |

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
| GET | `/api/analytics/muscle-volume/:userId?days=7\|30\|90` — weighted per-muscle-group volume for the Library Dashboard heatmap; non-fatal, all-zero groups on any failure |

### Wearables
| Method | Path |
|--------|------|
| GET | `/api/wearables/providers/:userId` — per-provider `{connected, needs_reconnect, status}` reflecting real token health (session #19), not just row existence |
| POST | `/api/wearables/connect/:provider` · `/disconnect/:provider` |
| GET | `/api/wearables/sync-backlog/:userId` · `/activity-types/:userId` |
| POST | `/api/wearables/merge/:userId` · `/reject/:userId` · `/import/:userId` · `/bulk-action/:userId` |

> **Auto-import on save:** `POST /api/workouts` runs `findWearableMatchOnSave()` (≤4s, non-fatal) and returns the best same-day Fitbit candidate as `wearable_match` for the client link prompt. `/reject/:userId` accepts an optional `create_standalone` field: `false` (wm-modal "Keep Separate" path) records only the `rejected_wearable_matches` row; omitted (sync-backlog path) keeps the existing behavior of also creating a standalone workout.

### Debug / admin (gated by `ADMIN_SECRET` where applicable)
| Method | Path |
|--------|------|
| POST | `/api/debug/backfill-wearable-hr/:userId` (`?provider=fitbit&max_intraday=N`) |
| POST | `/api/debug/backfill-wearable-history/:userId` (`?start_date=&end_date=&max_calls=N&metrics=`) — full-history sleep/HRV/RHR/steps/weight/body-fat pull via Fitbit RANGE endpoints; `max_calls` defaults to 100 (not Infinity); never overwrites existing better data; see CLAUDE.md → "Fitbit History Backfill" |
| POST | `/api/debug/seed-exercise-catalog` (`?max_calls=N`) — wger.de bulk-seed (no key needed; replaces the never-run MuscleWiki seed), resumable/idempotent, merge-safe against existing rows |
| GET | `/api/debug/exercise-canonicalization-report/:userId` (`?max_haiku=N`) — read-only backfill merge-list report |
| POST | `/api/debug/apply-exercise-canonicalization/:userId` — body `{mapping:[{from_name,to_canonical_name}]}`, rewrites `exercises.name` only |
| POST | `/api/debug/exercise-catalog-upsert` — create/update one catalog row by `canonical_name` (sets `family`/muscle-groups/etc. that save-time matching doesn't) |
| DELETE | `/api/debug/exercise-catalog/:id` — removes a catalog row (no cascade — `exercises.name` is plain text, not an FK) |
| GET | `/api/debug/exercise-catalog-dupes` — read-only near-duplicate audit (rows whose canonical_name/aliases normalize to the same key) |
| POST | `/api/debug/exercise-catalog-merge` — body `{winner_id,loser_id,retitle_canonical_name?}`, merges loser into winner (fetches both fresh, unions aliases, fill-empty-only, deletes loser) |
| POST | `/api/debug/exercise-catalog-remove-alias` — body `{id,alias}`, strips one alias without merging |
| GET | `/api/debug/orphaned-exercises/:userId` — read-only, lists this profile's `exercises` rows whose `workout_id` no longer references an existing `workouts` row, grouped by name/date with counts and per-group ids |
| POST | `/api/debug/delete-orphaned-exercises/:userId` — body `{ids:[...]}`, the possibly-edited id list from the report; re-verifies each id is still orphaned and belongs to this profile fresh server-side before deleting |

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

- **Supabase "Premature close" on every query (2026-06-18 — ✅ root-caused & mostly resolved 2026-06-19, see the banner at the top of this file).** Root cause: the `apexcoach` Supabase project's compute was sized at **Nano** despite being on the Pro plan; the (now code-fixed) daily-recs retry storm drove connection volume into Nano's memory ceiling, which surfaced as "Premature close" on every PostgREST call. Fixed by upgrading compute **Nano → Micro**. A **residual** intermittent "Premature close" on `workouts` and Fitbit's `oauth2/token` (a node-fetch stream-dies-mid-body-read failure mode) was separately fixed with a retry wrapper (`c88b186`, `f1aef8a`) and an `invalid_grant`-guarded Fitbit refresh retry (`78ba684`). No further "Premature close" reports since the many features shipped in the following weeks (Focus Override, Coach Chat, timezone fix) — treat as resolved unless it recurs.
- **Fitbit Server-type app → no intraday HR.** Peak HR falls back to TCX `MaximumHeartRateBpm`, then to a zone-floor estimate. (Confirm the registered app type in the Fitbit dev portal to know which path is active.)
- **Peak HR historical backfill** — a subset of older sessions (~24) only ever yields **estimated** peak values (no measured/sampled peak recoverable).
- **`wearable_connections` redundant double-write** on the OAuth callback (`/callback` calls both `saveProfileTokens` and `saveWearableTokens`) — cosmetic, idempotent, low priority (see §9).
- **✅ RESOLVED 2026-07-17 — legacy text roadmap fully retired.** The Profile tab had rendered the structured `/roadmap-data` card since 2026-05-29, leaving `GET/POST /api/profiles/:id/roadmap`, `loadRoadmap()`/`renderRoadmapContent()`/`generateRoadmap()`, and the hidden `#roadmap-card` as dead code. All removed from `server.js`/`public/index.html`. The `profiles.roadmap`/`roadmap_updated_at` columns themselves have also been dropped (`migrations/2026-07-17_drop_legacy_roadmap.sql`, **run in production**) — see §9.
- **Horizon-phase `progress_pct` is always 0** — by design: horizon phases have no `start_date`, so `computePhaseProgress()` returns null and the macro/per-goal roadmap UI shows no progress bar for them (only `milestone` + `estimated_range`).
- **`wearables/fitbit.js`'s `adapter.refreshToken()` lacks the retry / `invalid_grant` guard `refreshProfileToken()` has.** Confirmed by direct code comparison (2026-07-15): `refreshProfileToken()` (`server.js`) retries transient failures and stops cleanly on a `400 invalid_grant` (logging instead of looping on a dead token); `wearables/fitbit.js`'s own `refreshToken()` just throws on any non-ok response. This path is only reached for wearable-only Fitbit connections that never populated `profiles.fitbit_*`. **Pre-existing, low priority** — confirm whether any active profile actually hits that fallback path before patching.
- **✅ RESOLVED 2026-07-16 (same day as found).** `daily_sleep` table's RLS status was undocumented — found during the first 2026-07-16 doc-sync audit: the table's migration (`migrations/2026-05-24_daily_sleep.sql`) contains no `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` statements, and the table was absent from `CLAUDE.md`'s RLS enumeration (11 original tables + 3 Coach Chat + 1 exercise_catalog = 15 named tables — `daily_sleep`, created 2 days before the 2026-05-26 "enable RLS on all 11 tables" session, wasn't among any of the three groups). Fixed manually via the Supabase SQL editor the same day: RLS + `service_role_bypass` applied, no committed migration, matching how several other tables/columns in this project were created (see §2's note). `CLAUDE.md`'s RLS enumeration now lists 16 tables.
- **Watch item: workout 17's exercises were each found in exactly 2 copies (2026-07-16, session #11 orphaned-exercises audit).** All 8 exercises under historical workout id 17 had duplicate rows under that one `workout_id`, pointing at a one-off `/extract-exercises` double-call sometime in the past (unrelated to the orphaned-exercises bug that surfaced it — workout 17 itself is a dead workout id, so all 16 rows were deleted as orphans). Not chased since it's a single historical event, not reproduced. **If ×2 duplicates recur on a live/current workout, that's a real, active bug** in `/extract-exercises` (or something double-calling it), not this same one-off.
- **wger seed left visible near-duplicate and foreign-sourced variant names in the new Exercise Guide (4th Library sub-nav) — known noise, not cleaned up.** Distinct from the `exercise-catalog-dupes` cleanup (session #8), which only resolved *colliding* duplicates (same `catalogNormKey`); some non-colliding near-duplicates and oddly-worded variant names from wger's raw dataset remain visible when browsing the full catalog in Guide. Low priority — cosmetic browse-time noise, not a matching bug (save-time resolution is unaffected). Worth a manual sweep only if the confirm-chip "change" picker's search results start getting cluttered by these in practice.
- **`exercise_catalog` id 18 (Dead Hang) has `family:"Deadhang"` (no space), inherited from the wger merge.** Cosmetic — doesn't affect the family-rollup grouping today since no other row shares that exact family string. Becomes a real (one-line `exercise-catalog-upsert`) fix the moment a second Dead Hang variant joins the family and needs to group with it.
- **✅ RESOLVED 2026-07-17.** `DELETE /api/profiles/:id` orphaned `exercises` rows — same root cause as the `DELETE /api/workouts/:id` bug fixed in session #11, just narrower scope at the time. Fixed by adding an explicit `exercises?profile_id=eq.` delete before the existing `workouts` delete (same pattern, no schema change). Deliberately kept **independent** of the `exercises_workout_id_fkey` CASCADE migration proposed the same session (now run — see §9) — a cascade from `workouts` can never reach an `exercises` row whose `workout_id` is `null` (a real, reachable state — `extract-exercises` can insert one), so the explicit profile-scoped delete stays load-bearing even after the FK lands. Still not extended to `daily_checkins`/`micro_goals`/`daily_steps`/`body_metrics` — profile deletion beyond `workouts`+`exercises` remains unaudited, low real-world impact (profile deletion is rare).
- **Editing a workout's notes doesn't refresh its extracted `exercises` rows — found live during the session #11 orphaned-exercises audit, not fixed.** `PATCH /api/workouts/:id` never re-runs extraction (confirmed by tracing `saveWorkout`→`updateWorkoutInSupabase` in `public/index.html` — an edit only regenerates the AI title when notes change, nothing calls `/extract-exercises` again). So there's no duplicate-row risk from editing, but the original exercises rows go stale if the edited notes actually change which exercises were done (e.g. correcting a typo'd exercise name, or removing/adding a set). A fix would need to decide replace-vs-diff semantics for the stale rows — a real design decision, not a one-line patch.
- **`exercises.duration_minutes` silently fails to insert for non-integer values — found live 2026-07-16, NOT fixed (out of scope for the exercise-canonicalization session that discovered it).** Reproduced directly: logging a Dead Hang or Plank with a whole-number duration (e.g. "1 minute") inserts fine; the identical save with a fractional duration (0.75 for "45 seconds", 0.5 for "30 seconds") returns `count:0` from `POST /api/profiles/:id/extract-exercises` — the row is silently never written, no error surfaced to the client or logged distinctly from a normal skip. This is unrelated to the exercise-catalog work (catalog resolution never touches `duration_minutes`) but directly contradicts the extraction prompt's own hardcoded Dead Hang rule, which explicitly instructs fractional-minute values ("45 seconds → 0.75"). Almost certainly explains the pre-existing `CLAUDE.md` caveat that `strength_milestone`'s time-based tracking "prefers `parseDurationToSeconds(raw_text||notes)` over the often-mis-populated `duration_minutes` column" — that workaround was likely built around this exact bug without ever finding the root cause. **Likely root cause** (not confirmed — would need direct schema access to verify): `exercises.duration_minutes` is probably typed as an integer column in the live database, despite the app-level code and multiple docs treating it as free-precision numeric. **Fix, not attempted this session**: either a migration to widen the column to `numeric`, or have `extract-exercises` round to the nearest whole minute before insert (lossy — would break sub-minute hold tracking, the opposite of what the Dead Hang PR feature needs) — a real design decision, not a one-line patch, and out of scope for the session that found it.

### Coach Chat / Timezone — Known Issues & Deferred (2026-07-15)

Each item below is self-contained — no other doc/session context should be needed to pick it up.

1. **✅ RESOLVED 2026-07-15 (session #6).** Analytics streaks + weekly-volume bucketing were UTC-keyed. Fixed: `currentStreakFromDates(dateSet, profile)` now anchors "today" via `localToday()` instead of `ymdLocal(new Date())`; the `/exercises/stats` weekly-volume 12-week cutoff now anchors via `localToday()` too (and its week-bucket key switched from `.toISOString()` to `ymdLocal()` for consistency). Both endpoints previously took no profile row at all — both now fetch one (reusing the existing `getProfileTimezone()` helper, no new helper). **Audited, not assumed**: `longestStreakFromDates()` and both most-active-day-of-week bucketers were checked and left untouched — they only do self-consistent noon-anchored parsing of already-known stored date strings, no dependency on "now" at all. **Verified two ways**: (a) mocked-clock — booted the real pre-fix and post-fix `server.js` snapshots against a mock Supabase at the same fixed instant; for a `timezone:null` profile the full `activity-stats` AND `exercises/stats` responses are byte-identical pre- vs. post-fix (the regression check); for a real positive-UTC-offset (Sydney) profile with a genuine 3-day streak spanning the athlete's "today", the pre-fix server returned `current_streak:2` (wrong — the "check yesterday" fallback skips the wrong direction for a server-behind-athlete offset) while the post-fix server correctly returns `3`, matching `longest_streak`; (b) confirmed `profiles.timezone` is live in production before touching any code (profile 1 already had `"America/Chicago"` captured). Commit `b733f70`.
2. **Deferred timezone sites (deliberate, not a bug).** From the same 2026-07-15 audit, these were knowingly left on UTC/server-OS time because a 1-day skew is invisible at their granularity: roadmap phase-date assignment (`assignNearTermDates()`), the 60–90 day rolling windows in `getGoalExerciseContext()`/`getFullExerciseContext()`, `life-os-summary`'s own date-param override path (has its own `?date=` override with different conventions), and `POST /api/profiles/:id/daily-recs`'s `fallbackDate` (the primary path is already client-supplied via the browser's local `ds(0)` — this only matters if the client omits `date` entirely). No action needed unless the granularity assumption changes.
3. **Fitbit weight/body-fat sync has been silently dead since 2026-05-17 — reconsent didn't fix it, no longer being pursued.** The `/1/user/-/body/log/weight/date/*` and `/body/log/fat/date/*` endpoints have been returning `403 PERMISSION_DENIED` since a July Fitbit reconsent that didn't include the body/weight scope. Because every Fitbit call in `buildDailyData()` is `.catch()`-guarded to degrade gracefully (the 2026-06-18 non-fatal hardening pass — see §3 → Reliability & Resilience), this failure is swallowed silently: no error surfaces anywhere, weight/body-fat simply stop updating. The user reconsented Fitbit access 2026-07-14 hoping to restore it; **confirmed still missing** (session #17, 2026-07-17) — the full-history backfill's weight/body-fat range calls 403'd identically post-reconsent. **Deliberately deprioritized**: the account has never logged weight via Fitbit, so there's nothing to sync either way — not worth chasing the scope further unless that changes.
4. **90s Coach Chat / daily_recs stream-hang — root cause still formally unproven.** Investigated 2026-07-15 session #3 (see §3 changelog + `CLAUDE.md` → "Coach Chat" → "Streaming termination investigation"): a production incident where the server logged full success (`stream complete, wroteAny=true`) but the client never received termination. Diffed clean — not a code regression. Applied `keepAlive:false` on the Anthropic streaming HTTP agent as a **precedented mitigation** (matches the existing Fitbit-token-endpoint fix for the same "Premature close on pooled sockets" bug class), not a proven fix. If it recurs, the new `finish`/`close` event log lines added in the same session are the designed diagnostic — they'll show definitively whether `res.end()` completed (rules out Express) or never flushed (points at Render's proxy/socket layer).
5. **Prompt-cache efficiency risk for Coach Chat: one shared cached system block.** `CHAT_SYSTEM_PERSONA` + the per-message-rebuilt athlete snapshot are wrapped into a single cached system block (`wrapSystemWithCache()`, 1h TTL). Any change to the snapshot's underlying data (a new workout logged, a goal edited, etc.) invalidates the *entire* cached block, including the stable persona text — not just the part that changed. Not yet a confirmed problem in production. If `[AI] usage (stream): ... cache_read=0` shows up persistently mid-conversation (i.e., the cache never hits even between consecutive messages in the same session), the fix is splitting into two system blocks — persona cached separately from the uncached snapshot — so persona caching survives snapshot churn. **Confirmed, not assumed, 2026-07-17**: the new 30-day sleep-history snapshot block (see `CLAUDE.md` → Coach Chat) doesn't worsen this — `daily_sleep` only changes via the nightly wearable sync, so the block is stable within a chat session exactly like the pre-existing single-row biometrics line already was; it makes the cached block modestly bigger (higher miss cost), not more frequently invalidated.
6. **Zone/active-minutes are not persisted anywhere in the schema.** They're held only transiently in the `/api/profiles/:id/daily` response (never written to `daily_steps`/`body_metrics`/any table), so Coach Chat's snapshot omits them entirely rather than adding a live wearable call per chat message. Fix would be persisting zone minutes during the nightly Fitbit/Google Health sync (mirroring how `daily_steps`/`body_metrics` are upserted today).
7. **✅ RESOLVED 2026-07-15 (session #6) — but not the way it was originally designed.** A confirmed `propose_goal_update` on a goal that already has a roadmap now automatically surfaces a regen-offer confirm/cancel card (reusing the exact `chat_proposals`/`applyProposal()` infrastructure); confirming it triggers a real Sonnet regeneration of that goal's roadmap only (never the macro `roadmap_data`), incrementing `version` and appending to `adaptation_log` rather than resetting them (the goal already had history worth keeping) — reuses the same generation prompt as `POST .../goals/:goalId/roadmap`, now factored into a shared `generateGoalRoadmapForGoal(profileId, goalId, mode)`. **Design pivot, found live, not assumed:** the original design (a `propose_roadmap_regen` tool the MODEL calls) was built first, but 3 different live-tested prompt strategies (soft ask → explicit "don't ask first" → a blunt mechanical if/then rule) all failed identically — the model narrated the offer in text ("I'll queue it up now") without ever emitting the actual tool call, across 3 separate confirmed goal-updates in the same live session, while `propose_goal_update` itself fired correctly all 3 times (ruling out a plumbing bug). Switched to a **server-triggered** auto-offer instead: `applyProposal()` returns `{autoOfferGoal}` when a confirmed goal update's goal has a roadmap; the confirm endpoint's `maybeAutoOfferRoadmapRegen()` creates the pending proposal directly (dedup-guarded against an already-pending offer for the same goal) and returns it inline so the card renders immediately, no extra chat turn needed. `propose_roadmap_regen` was removed from `COACH_CHAT_TOOLS` entirely — the model no longer has or needs this tool. **Two real schema bugs found live** (not by reading the schema): `chat_proposals.tool_use_id` is `NOT NULL` (worked around with a synthetic sentinel value, since every prior proposal assumed a model tool-call origin) and `chat_proposals.type`'s CHECK constraint didn't allow `'regenerate_goal_roadmap'` at all (fixed via `migrations/2026-07-15_chat_proposals_regen_type.sql`, **run manually, applied**). **Bonus fix found while wiring this up**: `formatGoalLineForChat()` never actually included a goal's `id` in the Coach Chat snapshot, despite `propose_goal_update`'s own tool description telling the model to read it from there — a real pre-existing gap affecting the already-shipped tool too, not just the new one. **Verified live end-to-end**: positive case — confirmed a goal-update on a goal with a v1 roadmap (generated 2026-06-01, 1 adaptation_log entry) → regen card auto-appeared in the confirm response → confirmed it → roadmap became v2, `generated_at` refreshed, `adaptation_log` grew to 2 entries (original preserved + new one appended), 5 fresh phases generated grounded in real chat/profile context. Negative case — confirmed a goal-update on a goal with no roadmap → `follow_up_proposal:null`, no card, confirmed via the thread's proposals list. Commits `b733f70` → `16b1f7b` (7 commits total tracing the full design pivot).
8. **`wearables/fitbit.js`'s `adapter.refreshToken()` retry/guard gap** — see the bullet above in the main Known Limitations list (kept there since it predates Coach Chat; cross-referenced here because it was re-verified during this same audit).
9. **Legacy flags, kept intentionally**: `profiles.roadmap` text write path and `fitbit_pending_imports` are both still pre-existing, documented tech debt (see §9) — no change from this session, listed here only so this section is a complete picture of everything outstanding as of 2026-07-15.

---

## 7. Roadmap — Features To Build

**Priority order (updated 2026-07-18 after the session #29 daily_recs outage).** Items 1–3 were **deprioritized during the outage firefight** (profile 1's recs were failing — see the session #29 banner) but remain the active cycle; the Sept-2026 Fitbit shutdown deadline hasn't moved.

1. **Rebuild all other profiles off profile 1 once it's stable** *(supersedes the old "second-profile Google Health migration" item — new direction, decided this cycle).* Profile 1 is the reference build; the plan is to reconstruct every other profile from it once profile 1 is proven stable, rather than migrating each profile's wearable connection in place. Still resolves the Sept-2026 cutover for those profiles (they come up on Google Health as part of the rebuild). Ordered first, but gated on profile 1 being stable (the #29 rec fix was a prerequisite).
2. **Google Health historical backfill** — mirror `backfill-wearable-history` (§4 / `CLAUDE.md` → "Fitbit History Backfill") for GH's API v4. *Value: High, same Sept deadline — once Fitbit's API is gone, GH is the only remaining source for any further gap-filling. Effort: Medium.* Deprioritized by the #29 outage, still on the board. The chunking/merge/never-overwrite-worse-data design transfers directly — the real work is GH's different endpoint shapes (`:reconcile`, `dailyRollUp`, list+`page_size=1`) and confirming GH's own real per-metric range limits against Google's docs (the RHR silent-drop quirk found in session #17 is exactly what doesn't transfer safely by assumption).
3. **Zone/active-minutes persistence** — nightly-sync upsert, new column or extend an existing table. *Value: Medium — closes a named §6 gap: AZM is fetched live into `/daily` but never stored, so Coach Chat and analytics can't see history. Effort: Medium.* Deprioritized by the #29 outage, still on the board. Both sync paths already compute AZM transiently — this is "persist what's already being fetched," not new acquisition.
4. **Decision-gate verdicts — RESOLVED this cycle (no longer conditional):**
   - **Readiness hero compaction — ❌ DECIDED AGAINST (do not build).** The collapsed readiness card reads fine at 390px in real daily use; the ~354→250px compaction is not worth the visual-change risk. Recorded as decided-against so it doesn't resurface as an open question.
   - **~~Today ▶ Use templates quick-row restoration~~ — ✅ DONE (session #20, 2026-07-17), and expanded** into the "Log past workout" panel (`#log-past-card`). See `CLAUDE.md` → "Log Past Workout Panel".
   - **Coach Chat full-history sleep — ✅ ACTIVATED (build it), NOT yet built.** Verdict: Coach Chat should see **ALL** sleep history, not just the 30-day window. But a raw dump of 2+ years of `daily_sleep` rows blows the prompt/char budget — so this needs a **monthly-rollup aggregation** (avg/min/max sleep + stage mix per month), not a longer raw-row window. Effort: Medium (a monthly-rollup query + snapshot formatter, feeding `buildChatSnapshot()`).
5. **Free Exercise DB top-up** — *Value: Low-Medium. Effort: Low (free, keyless JSON source, e.g. `github.com/yuhonas/free-exercise-db`).* Now doubly-motivated: closes the bare-name Haiku-fallback gap ("Lat Pulldown") **and** is the lever that would lift the AI-rec link match rate (bounded by catalog coverage, not verbosity — see the exercise-arc open follow-ups above). Worth building if either keeps surfacing.
6. **Uniform AI logging format for search/view — NOT done (distinct from the session #29 fix).** Session #29 fixed the **recommendation** output wording (conciseness). The separate, still-open ask is a uniform format for how **logged** workouts are stored/formatted so History search + the exercise-detail views read consistently across sessions. Feature-level; needs a format spec + a pass over the log/extract path.

**Session #27 (2026-07-18) — all 3 jobs ✅ SHIPPED + DEPLOYED + DATA SEEDED (complete).**

*Approaches were reported and approved before writing code, per the brief ("a wrong-match link is worse than no link"). Full implementation detail in `CLAUDE.md` → "Exercise Detail Reachability…" (session #27).*

- **Job 1 — clickable Guide cards + "Log this" CTA — ✅ SHIPPED, deployed, code-verified live.** Frontend-only.
- **Job 2 — AI-rec exercise-name linking — ✅ SHIPPED, deployed, match rate measured live.** Option B (read-only `resolve-batch` endpoint). Did NOT reuse `resolveExerciseCatalog` wholesale — its Haiku fallback creates `source:'custom'` rows, and a browse surface must never spawn rows; extracted just the exact/alias block into a shared `matchCatalogExactAlias()`. Exact/alias ONLY, no fuzzy, no Haiku, no writes. Miss → plain text. **Live match rate:** real recovery-yoga rec **8/33 (24%)**, strength-day probe **16/20 (80%)**, **0 wrong matches across 53 lines** — content-dependent, always zero false links. (Match rate is bounded by catalog coverage, not verbosity — see the open follow-up below.)
- **Job 3 — wger variations — ✅ SHIPPED + DATA SEEDED (migration applied + seed run, ~207 variation groups).** `variation_group text` column (mirrors wger's own UUID grouping key — NOT a jsonb/id-array), `POST /api/debug/seed-exercise-variations` (by `wger_id`, fill-if-null), read-time sibling resolution on `GET /exercises/:name` (`WHERE variation_group=X AND id≠self`, self-heals across merges/renames/deletes), clickable "Variations" section in the detail view. `migrations/2026-07-18_exercise_catalog_variation_group.sql` **run in production** and the seed run (~207 groups). **Re-verified live 2026-07-18** (doc-sync pass): `GET /api/profiles/1/exercises/Lunges` → 5 siblings, `Romanian Deadlift` → 6, `Bench Press` → 10 — the read path returns real current-catalog sibling names, so both data steps are confirmed applied.

**Open follow-ups from the exercise + daily_recs arc (sessions #25–29), scoped but NOT built:**
- **Guide filter reorg — "Session D" of the exercise arc, scoped but NEVER BUILT.** The planned reorganization of the Exercise Guide's filter UI (the muscle-group pills + equipment dropdown + search) into a cleaner layout. Was scoped as the 4th session of the exercise-detail arc and never started. Frontend-only, no backend/schema.
- **Rec pre-generation for sub-5s app load.** SSE removed the timeout, but the daily rec still generates on-demand at app open (~17s+ live even after the conciseness tuning). Background-generate the rec right after the wearable sync lands, cache it (`daily_recommendations` already exists), and serve the cached rec instantly on open — regenerate only on a readiness change. **Pairs with the scheduler item below** (a nightly sync is the natural trigger).
- **No scheduler / nightly sync — data (and the rec) only land on app open.** All wearable ingestion + rec generation happen when the user opens the app; nothing runs server-side on a schedule. A nightly/cron sync would land wearable data AND pre-generate the rec without requiring an app open, and is the durable fix for the GH sleep-reconciliation lag currently noted in §6/§9 (that per-metric re-pull is one instance of this missing scheduler).
- **Muscle granularity upgrade.** wger exposes *specific* muscles per exercise; the wger seed collapses them to this app's coarse 11-group `MUSCLE_GROUP_MAP` (chest/back/shoulders/…). Storing + consuming the finer muscle data would sharpen the muscle heatmap and the muscle-group filter. Medium effort — schema + seed + heatmap/filter consumers.
- **AI-rec link match rate is bounded by catalog coverage, not verbosity (session #29 finding).** The session-#29 conciseness pass cleaned up line *stripping* (uniform, short lines resolve better), but residual link misses are qualifier variants ("Weighted Pull-Up", "Single-Arm Dumbbell Row") and genuinely uncatalogued yoga/MMA moves — not fixable by prompt tuning. **Catalog expansion (the Free Exercise DB top-up, priority 5 above) would lift the rate**; the fuzzy/Haiku resolver tier was *deliberately rejected* in session #27 (Job 2) to keep zero wrong links. So the lever is coverage, not the matcher.
- **Clickable exercises inside the Log-past panel's expanded workout rows.** The exercise-detail view is now reachable from Guide, Exercises, Records, History-card chips, and AI-rec links — but NOT yet from the expanded past-workout detail rows in the "Log past workout" panel. Small: mirror the History-card chip / `openChipExercise` tap-through pattern.

**Parked backlog (unordered, carried forward):**
- Onboarding §8 TODOs (checklist/progress indicator, guided first workout log, wearable-connect prompt, goal-suggestion flow, welcome email/push).
- wger catalog noise cleanup (near-duplicate/oddly-worded variant names visible in Exercise Guide).
- Family-rollup polish (e.g. `exercise_catalog` id 18 Dead Hang's `family:"Deadhang"` typo).

**Still on the board, not part of this cycle's ordering:**
- Apple HealthKit / iOS integration — long-term, needs an iOS companion app + Apple Developer Account.
- MuscleWiki video-streaming layer — paid-user/beta stage, gated behind a subscription decision (see the Exercise Video / Demonstration Database plan below).
- Logo transparent background.

> **Shipped 2026-07-16 → 2026-07-17** (superseded from the priority list above to avoid drift — see §3, session banners at the top of this file, and `CLAUDE.md` for full detail): Exercise Canonicalization phase 2 (family rollups, muscle-group filter, muscle heatmap), full frontend declutter pass, Wearable Sync bulk-review provider picker, Readiness card hero/detail split, tech-debt batch (4 items, all migrations now run in production), Coach Chat sleep-history snapshot, full-history Fitbit backfill (+ RHR chunking fix).

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

**Exercise Video / Demonstration Database** — 🔲 **planned 2026-06-18, data half done 2026-07-16, video half NOT started.** A searchable exercise guide with video/GIF demonstrations, surfaced in the Library tab and linked from AI rec cards. **Split into two genuinely separate concerns as of session #8** — the original plan bundled "get the exercise data" with "get the video" under one MuscleWiki integration; those turned out to have very different constraints (data is free and keyless via wger, video streaming genuinely needs a paid MuscleWiki subscription), so they're now tracked separately:
- **Data — ✅ done, via `exercise_catalog` itself, not a separate `exercises_reference` table.** The originally-planned one-time bulk seed + weekly refresh cron + separate Supabase table is superseded: `exercise_catalog` (already built for canonicalization, see §3) IS the exercise reference data now — wger-seeded, ~880 rows, `family`/`muscle_groups_primary`/`muscle_groups_secondary`/`equipment` all populated.
- **Guide UI — ✅ done (session #10, 2026-07-16).** The Library tab's 4th sub-nav "Exercise Guide" browses the full catalog (search, muscle-group filter, equipment dropdown, "logged Nx" badges) — see §3 → Exercise Canonicalization Phase 2 / `CLAUDE.md`. Display-only for now: no video, no "Show me similar exercises" action yet (the muscle filter partially substitutes but isn't the same UX).
- **Video — 🔲 not started, explicitly paid-user/beta stage** (see §7 → "Still on the board"). MuscleWiki remains the only tiered source with a real video library (1,900+ demonstrations) — still requires the **$10/mo TESTING plan minimum**, videos served through **authenticated endpoints** so a **server proxy is required** (never embed the raw URL, and **no stored media** — stream-through only, per their API ToS). When this gets built: a one-time exercise-ID **mapping pass** (not a data seed) matches existing `exercise_catalog.canonical_name`s against MuscleWiki's own names and fills `musclewiki_id` — the column has sat ready for exactly this since the original 2026-07-15 migration. An AI rec-card **"Watch" CTA** would match the recommended exercise name against `exercise_catalog` and, when `musclewiki_id` is set, open the proxied video.
  - **Secondary — ExerciseDB** (`exercisedb.io` via RapidAPI): ~1,300 exercises, GIF demonstrations, has a free tier — still a viable fallback for the video layer specifically once that's being built.
  - **Tertiary — YouTube** embed links (optional "deep dive" per exercise) — no change from the original plan.

### Next up

- See §7 → "Still on the board" (top of this section) for Apple HealthKit, MuscleWiki video, and the logo transparent-background item — not duplicated here to avoid drift.

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

- [x] **Drop the deprecated `fitbit_pending_imports` queue.** ✅ **Code + column both done 2026-07-17** — confirmed zero call sites (grep before removal), then deleted `diffAndQueueFitbitImports()`/`mapFitbitActivityType()`/`FITBIT_ACTIVITY_TYPE_MAP` and both endpoints from `server.js`. `migrations/2026-07-17_drop_fitbit_pending_imports.sql` **run in production** — column no longer exists.
- [x] **Retire the legacy text roadmap (now unblocked).** ✅ **Code + columns both done 2026-07-17** — confirmed no external consumer reads `profiles.roadmap`/`roadmap_updated_at` (neither `life-os-summary` nor `PROFILE_SELECT_BASE` select them), then removed `GET/POST /api/profiles/:id/roadmap`, `loadRoadmap`/`renderRoadmapContent`/`generateRoadmap`, and the hidden `#roadmap-card`. `migrations/2026-07-17_drop_legacy_roadmap.sql` **run in production** — both columns gone.
- [ ] **Drop the redundant `saveWearableTokens` call** in the `/callback` OAuth handler — `saveProfileTokens` now mirrors into `wearable_connections`, so the explicit second write is redundant (idempotent, harmless).
- [ ] **Add `workouts.duration_minutes` column** so manual session durations count in analytics without relying on summed `exercises.duration_minutes`.
- [ ] **Rename `?max_intraday=` → `?max_calls=`** in `/api/debug/backfill-wearable-hr` (the budget now covers TCX **+** intraday calls, not just intraday). Keep `max_intraday` as an alias for back-compat.
- [ ] **Retire the legacy `tokens` table** path once confirmed no profile depends on it.
- [ ] **Regenerate the logo with a transparent background.** `public/logo.png` currently has a solid (black) background; a transparent PNG would let the figure float on the app background instead of a black box. (Also tracked in §7 → Next up.)
- [ ] **Drive Fitbit → Google Health migration before the Sept-2026 shutdown.** The Google Health API v4 adapter is ✅ built (§3); the remaining work is getting every active Fitbit profile to reconnect via the reconsent banner so no one loses sync at cutover.
- [ ] **Drop the Fitbit adapter + legacy Fitbit paths after September 2026** once all active profiles have migrated to Google Health: remove the `profiles.fitbit_*` columns, the legacy `/auth` + `/callback` routes, `buildDailyData` / `runFitbitBackfill`, the `getValidProfileToken` Fitbit special-case inside `getValidWearableToken`, the Fitbit-first preference logic in `findWearableMatchOnSave` + the `unmatched-fitbit` endpoint, and the `wearables/fitbit.js` adapter.
- [ ] **Timezone verification — Google Health daily fetch.** The local-date fix (inline IIFE using `getFullYear`/`getMonth`/`getDate` instead of UTC `dateStr()`) appears to work, but logs still occasionally show a UTC date. Verify it applies correctly across timezone edge cases, particularly around midnight in negative-offset timezones.
- [ ] **Google Health weight returns null** in testing — verify once a user logs weight in the Fitbit/Google Health app. The `weightGrams / 453.592` lb conversion is implemented in `fetchDailyData`.
- [x] **`ON DELETE CASCADE` FK from `exercises.workout_id` → `workouts.id`.** ✅ **Migration run in production 2026-07-17** (`migrations/2026-07-17_exercises_workout_fk_cascade.sql`) — makes the orphaned-exercises bug class (fixed for `DELETE /api/workouts/:id` in session #11) structurally impossible even if a future endpoint deletes a workout some other way. The orphan report (`GET /api/debug/orphaned-exercises/:userId`) was run for every profile first, since the `ALTER TABLE` fails outright on any pre-existing orphan — profile 1 was cleaned in session #11, and its clean success confirms profiles 4/5/7/8 were orphan-free at run time too.
- [x] **Extend the same orphan-prevention fix to `DELETE /api/profiles/:id`** — ✅ **done 2026-07-17** (deletes `exercises` for the profile, then `workouts`, then the profile row). Deliberately kept independent of the FK above — see §6.
- [ ] **`PATCH /api/workouts/:id` doesn't refresh stale `exercises` rows on a notes edit** — see §6 for the full gap; needs a replace-vs-diff design decision, not a one-line patch.
- [ ] **`daily_sleep.source` is hardcoded `"fitbit"` for ALL sleep writes (flagged session #23).** `upsertDailySleep` sets `source:"fitbit"` unconditionally, so Google-Health-sourced sleep is mislabeled as Fitbit in `daily_sleep`. Cosmetic (no consumer branches on `source` for sleep today), low priority — thread the real provider through when convenient. Note the session #23 Fitbit sleep fallback happens to make the label accidentally correct for *that* path only.
- [ ] **GH-vs-Fitbit field-shape divergence is a recurring BUG CLASS, not a one-off (sessions #23/#24).** Google Health returns different field shapes than Fitbit across metrics, and each divergence surfaces as its own blank-card / parse / persistence bug: the GH **sleep-stages** shape mismatch (session #24 — normalized + `CACHE_VERSION` bust) and GH **sleep not persisting** (session #23 — HRV/RHR decoupled + Fitbit fallback) were two separate instances of the same underlying class. The durable fix is a defensive normalization layer at the adapter boundary (`wearables/google_health.js` → a canonical internal shape) so a new GH field-shape quirk is caught structurally instead of fixed reactively one card at a time. Flagged as a class; not built.
- [ ] **Google Health sleep reconciliation lag has no scheduler backstop (flagged session #23).** GH ingests last night's wearable sleep session later than daily HRV/RHR/steps; session #23 added a per-metric Fitbit sleep fallback + HRV/RHR decoupling so sleep-less morning opens still persist vitals and often backfill sleep from Fitbit, but the durable fix is a periodic re-pull (the tracked-separately scheduler) that re-fetches sleep once GH has it, instead of depending on the user reopening the app.
- [ ] **`workout_templates.exercises` jsonb is unused — latent trap (flagged session #21, do not fix now).** The schema and both write endpoints (`POST /api/profiles/:id/templates`, `PATCH /api/templates/:id`) carry an `exercises` jsonb array, but **nothing reads it**: `useTemplate()` (and the whole Use-template flow) drives the log modal purely off `notes_template` + `type`. It's currently always written `null`. The session #21 "Log past workout" template create/append flows deliberately write `notes_template` only for this reason. The trap: a future contributor may assume `exercises` is authoritative and write structured data there, silently diverging from what the app actually uses. Resolve later by either (a) wiring `useTemplate` to consume `exercises` when present (structured templates), or (b) dropping the column — don't half-populate it in the meantime.
- [~] **daily_recs generation-size management (session #29 — output half DONE, input half remains).** The output driver is resolved: the conciseness constraints in `buildResponseShapeSpec()` (4–6 exercises/option, one short line each, canonical names, tight reasoning) cut real output from ~2300–3665 tokens to **~811 tokens** and generation from 45–83s to **17.4s** (measured live), and `max_tokens` was raised 2200→4000 so a verbose rec can no longer truncate mid-JSON. Remaining, lower priority: the **input** side — `fetchAI` hard-caps the prompt at ~6000 chars ("Length guard"), so as logged history grows, more real context (historical/coaching briefs, exercise history, log days) gets bluntly truncated to fit. Lever: smarter context selection (rank/summarize history so the 6KB budget carries the most useful signal) instead of front-to-back truncation. Revisit if rec quality visibly thins as history accumulates.
- [ ] **`runFitbitBackfill()`'s weight fetch uses a `90d` period** (`/body/log/weight/date/today/90d.json`) — not a Fitbit-documented-valid period value for that endpoint (valid periods are `1d/7d/30d/1w/1m/3m/6m/1y`; an arbitrary span requires the by-date-range endpoint instead). Found during the full-history-backfill audit (session #17, 2026-07-17) while verifying every range endpoint's real max span against Fitbit's docs. Flagged only, not fixed — `runFitbitBackfill()` is the legacy 90-day onboarding backfill, already slated for removal post-Fitbit-shutdown (see the item above).
- [ ] **UNRESOLVED — diagnose: Log-past panel "My Templates" shows only "+ New Template" for profile 1 (surfaced this chat).** Never diagnosed whether this is the **correct empty state** (profile 1 genuinely has no saved `workout_templates` rows) or a **render bug** (templates exist but don't display). First step is a data check — `GET` the profile's templates — before touching the render path. Cheap to resolve; just never done.
- [ ] **PENDING VERIFICATION: sleep + HRV + RHR landing on a normal morning app open (session #23).** The #23 fix (HRV/RHR decoupled from the sleep write via `upsertDailyVitals()` + per-metric Fitbit sleep fallback) was verified against constructed/replayed states but **not yet against a real morning cycle** — GH's overnight reconciliation timing only exercises on an actual next-morning open. Confirm on a real morning that vitals persist even when GH sleep hasn't landed, and that the Fitbit fallback backfills sleep when it has.
- [ ] **Template naming uses `prompt()` dialogs — clunky on mobile (surfaced this chat).** The Log-past template create/rename flows (`lpNewBlankTemplate`, save-as-template) collect the name via native `prompt()`, which is awkward on mobile. Batch into a future frontend pass with an in-panel input instead of a blocking dialog. Pairs with the §7 "Log past workout" polish.
- [ ] **Exercise-catalog naming polish — awkward mechanical expansions, shipped as-is (session #25 cleanup).** The catalog-cleanup renames produced some clumsy but not-wrong canonical names — e.g. "Incline Overhead Press Dumbbell", "Lat Pull Dumbbell", "Shoulder Raise Side and Front Dumbbell". Deliberately shipped as-is (correct + unambiguous, just ugly); polish TBD, low priority. Related to the parked-backlog "wger catalog noise cleanup."
- [ ] **3 catalog rows deliberately left unresolved — do NOT guess (session #25 cleanup).** "Kreis Press DB", "Low-Cable Cross-Over - NB", and "Kettlebell One Legged Deadlift" were intentionally not renamed/merged during the cleanup because their intent is ambiguous ("NB" is an undetermined abbreviation). They stay as-is until their meaning is confirmed from a real source — not guessed. (Recorded here so the deliberate non-action is trackable, not just buried in the session #25 CLAUDE.md prose.)

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
| `ADMIN_SECRET` | ⚠ Recommended | Gates `/api/debug/*` admin endpoints when set; also accepted as a fallback for `LIFE_OS_API_KEY` |
| `LIFE_OS_API_KEY` | ⚠ Recommended | Shared secret for `GET /api/profiles/:id/life-os-summary` (`X-Life-OS-Key` header). Endpoint fails closed (503) if neither this nor `ADMIN_SECRET` is set |
| `RENDER_URL` | optional | Overrides the OAuth redirect base for `/callback/google_health`; falls back to `https://apexcoach-backend.onrender.com` |
| `PORT` | optional | Server port (Render injects this) |
| `FITBIT_ACCESS_TOKEN` | legacy | Single-user fallback token (pre-multi-profile) |
| `FITBIT_REFRESH_TOKEN` | legacy | Single-user fallback refresh token |

> **⚠ Correction:** the Anthropic key env var is **`ANTHROPIC_KEY`**, not `ANTHROPIC_API_KEY`.
> If you set `ANTHROPIC_API_KEY` on Render, the AI proxy will not pick it up.
