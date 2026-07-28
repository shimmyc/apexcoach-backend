# ApexCoach — Project Roadmap & Source of Truth

> Single reference for anyone joining the project or picking it back up after a break.
> Pairs with `CLAUDE.md` (deep implementation notes) and `FORMULAS.md` (readiness/sleep math).
> Last updated: 2026-07-27.
>
> **2026-07-27 session #42 — POST-ARC BUG WORK: BUG 2 diagnosed (NOT a bug), BUG 1 audited
> (deferred), and a THIRD bug found and FIXED that neither was.** Audit-then-build, gated. One
> code change shipped (`server.js`, 37 insertions / 1 deletion). **No migration. Profile 1
> byte-identical pre vs post deploy** (`profile_data` compared in full, sha256 of `goals`
> `5c57ba78aa6357d2` both sides). Zero writes to profile 1 all session — the one profile-1 read
> used (`GET /api/profiles/1`) PATCHes only `if (idsAdded || shapeFixed)`, and running the real
> shipped `ensureGoalIds` / `ensureGoalDefaults` against the returned `profile_data` returns
> **false for both**, so no PATCH fired.
>
> **BUG 2 IS NOT A BUG — it is designed behaviour, and §6/§9/ledger row 30 are updated to say so.**
> Profile 4 has `profile_data.fitbit === false` and zero connected wearables, so `syncFitbit()`
> routes to `showManualCheckin('no_fitbit')` (`public/index.html:3845`). That function has two
> branches, and **only the branch that finds a same-day `localStorage.ac_cache.manualCheckin`
> shows `#ai-card` and calls `resolveAIRecs()`** (`:3228`–`:3231`). The reset branch does neither,
> so `#ai-card` stays at its HTML default `display:none` (`:947`) and **no rec is rendered and none
> is even requested** until the athlete submits the daily manual check-in (`:3314`–`:3320`, which
> then fires `regenerateAIForContextChange('manual_checkin_submit')`). Consistent with the data:
> `GET /api/profiles/4/daily-recs` → `{recommendations:null, date:null, readiness:null}`.
>
> **The goal regeneration that preceded the observation was a COINCIDENCE, proven in code:**
> `grvRegenerateFromBanner()` (`:7800`) re-renders the roadmap view and the goal cards and calls
> **none** of `fetchAI` / `regenerateAIForContextChange` / `invalidateDailyRecsAndRefresh`. Only
> *macro* roadmap regeneration has a rec trigger (`:6220`). A per-goal regenerate cannot remove a
> rendered rec.
>
> **CANDIDATE (b) — a data-shape generation failure — WAS RULED OUT BY MEASUREMENT, not reasoning.**
> The real shipped `fetchAI({auditOnly:true})` was run headless against profile 4's real
> `profile_data`: **all 11 top-level builders returned OK with zero throws** (incl.
> `buildArcStateContext` 628 chars, `buildTimeBudgetContext` 2,180, `buildSectionDepthContext` 641),
> and the full assembly completed at **untrimmed 28,947 → total 27,193 / 28,000, one rung
> (`historicalBrief->400`), headroom 807**. So the arc'd profile pays the SAME single ladder rung
> profile 1 pays and did **not** need the projected extra `coachingBrief→400` rung. (Caveat:
> profile 4 carries **1** arc goal, not 3 — a three-arc profile is still heavier.)
>
> **⚠ THE REAL BUG, found while ruling out candidate (c), and in no document before now: BOTH
> roadmap rebuild sites DESTROY `arc_origin` AND `arc_state`. FIXED AND DEPLOYED this session
> (`ae46a96`).** `adaptGoalRoadmap` (`server.js:7019`) and `generateGoalRoadmapForGoal`
> (`:7696`/`:7711`, both branches) rebuild `goal.roadmap` from scratch, so any Layer 2 field not
> named explicitly is silently dropped. **This is the same bug class as the `roadmap.estimate` drop
> fixed in session #35, at the same two sites** — `estimate` was added to the carry-forward list
> then, and the arc fields shipped in session #37 and were never added.
> **Live evidence:** profile 4's "Bench press 175 lbs for a single" was regenerated
> **2026-07-26T02:47:22.417Z** (`adaptation_log` trigger `manual` — the athlete's inline regenerate,
> ledger row 14) and now carries **neither field**, where ledger row 10 recorded
> `position 3.0 / re_ramping / since 2026-07-06`.
> **Why it does not self-heal:** `arc_state` is a pure replay and returns on the next evaluation,
> but **`arc_origin` is re-pinned from `near[0].start_date`**, and both writers call
> `assignNearTermDates(parsed.phases, today)` on freshly model-authored phases that carry no dates
> — so the calendar is rebuilt **from today**. Dropping `arc_origin` therefore walks the origin
> forward on every adapt/regenerate and discards every earned week. **That is session #37 bug #1
> arriving through a different door**, which is exactly what pinning `arc_origin` was introduced to
> prevent. Because the weekly auto-adapt is fire-and-forget on every workout save, no goal could
> accumulate earned arc across an adapt.
> **Fix:** one shared `carryArcForward(prev, next)` — ONE implementation, TWO consumers, so the
> writers cannot disagree — **carry-if-present only**, so a legacy roadmap gains nothing (the same
> principle as `ensureGoalDefaults` never fabricating a `demand`).
> **Verified pre/post against the REAL shipped functions extracted from BOTH `git HEAD` and the
> working tree, frozen clock, real profile-1 and profile-4 fixtures — 9/9 pass:** an arc goal keeps
> both fields byte-identical through adapt, regenerate AND reset; **a legacy goal (profile 1's real
> "Fix Posture") produces output byte-identical pre-fix vs post-fix on all three paths with no
> fabricated keys** — the profile-1 non-regression check, since its 3 legacy roadmaps run this exact
> adapt path on every stale workout save; and only the two arc keys are ever added. Existing suites
> **213/213**.
>
> **BUG 1 AUDITED IN FULL, FIX DESIGNED, DEFERRED to its own session by decision. No limit bump.**
> The §9 reconciliation is settled with numbers:
> - **The verb anomaly is resolved: there is NO GET route.** Only `app.post` at `server.js:2952`.
>   Measured live: `GET /api/profiles/1/goal-progress` → **404 `text/html` `<!DOCTYPE html>…Cannot
>   GET`**; a small `POST` → **200 JSON**. The reported "GET/POST" pair is one endpoint written two
>   ways, not two observations. **Only the POST can 413** — and both a stray GET and an oversized
>   POST produce the identical client-side `SyntaxError: Unexpected token '<'`, which is why they
>   were conflated.
> - **The limit is the default 100 KB.** `server.js:92` is `app.use(express.json());` with **no
>   options**; no other body parser exists. Bracketed live: **101,357 B → 200**, **103,405 B → 413
>   `text/html` "Payload Too Large"**. That HTML body IS the `<!DOCTYPE` the client chokes on.
> - **Real profile-1 body: 207,357 B = 202.5 KB = 2.02× the limit.** Reconstructed field-for-field
>   from `fetchGoalProgress` (`index.html:11286`) against real read-only data: **exercises (310
>   rows, all-time) 104,059 B / 50.2%**, **workoutLog (60 rows) 65,689 B / 31.7%**, **goals
>   (profile_data) 37,483 B / 18.1%**, scalars 90 B.
> - **Apportionment — both causes are real, they are NOT equal.** The client blob (exercises +
>   workoutLog) is **169,748 B, 81.9%, and is 1.66× the limit ON ITS OWN** — sufficient to 413 with
>   zero goals; `exercises` alone already exceeds 100 KB. Accumulated `profile_data.goals` is
>   **18.1% and comfortably under the limit on its own**. **(a) is the cause; (b) is an aggravator.**
>   Removing all accumulated profile_data still leaves the endpoint broken.
> - **Migration projection: +8,653 B → 216,010 B = 210.9 KB (2.11×), i.e. ~4% worse.** Measured
>   per-goal on profile 4: `arc_state`+`arc_origin` ≈ 311 B/goal, `goal_type`+`demand`+`estimate`
>   ≈ 771 B/goal. **Migration is not what breaks this and not migrating would not fix it.**
> - **The real fix.** The handler (`:2952`–`:3090`) is **stateless — zero writes** — and consumes
>   the three big arrays only to compute scalar aggregates. **`var profileId = req.params.id` is
>   assigned at `:2954` and never used again.** The server already knows whose profile it is and
>   already has the pattern (`getGoalExerciseContext` / `getFullExerciseContext` /
>   `loadProfileWithGoals`). Stop sending `exercises` + `workoutLog` and let the server fetch its
>   own → **202.5 KB → 37.6 KB**, a drop-in because the handler reads raw row fields. Then stop
>   sending `goals` too → **<1 KB**, permanently immune to the migration.
>   **A limit bump is a stopgap only and must never ship as the fix.**
>
> **ITEM (c) / ledger row 28 REMAINS OPEN — and this session establishes exactly why, plus new
> evidence.** Post-deploy inventory: profile 4 has **12 goals, 5 with roadmaps, exactly ONE with an
> `arc_state`** — "Rehab right wrist tendonitis" (`arc_origin 2026-06-29`, status **`stalled`**,
> position 0, calendar 4, drift −4, **`re_ramp: null`**, tier 2 / keyword evidence, 1 qualifying
> session in 28d vs 20 expected, longest gap 22 days). **No goal is in `re_ramping`.**
> - **The bench goal's original `arc_origin` is NOT recoverable** — checked every field that could
>   carry it (`roadmap` keys, `goal` keys, all 7 `adaptation_log` entries, phases): nothing stores a
>   prior phase snapshot or the origin, and ledger row 10's recorded facts (peak 4.5, `since
>   2026-07-06`) **bound** the origin to a multi-week range rather than determining it. Per §0.2
>   rule 5 it was **not guessed**.
> - **The sanctioned back-dated-`last_evaluated` nudge cannot produce a re-ramp either, and this is
>   a code fact, not an opinion:** `computeArcState` sets `re_ramp` only when `preGapPeak > decayed`,
>   i.e. the goal must have **earned a non-zero position before the gap**. The wrist goal's
>   `preGapPeak` is 0, so it can only ever be `stalled`. The replay is pure and deterministic from
>   `arc_origin` + the real log, so forcing re-evaluation cannot change the outcome. **The nudge
>   would still be a valid way to close ledger row 22 (the stale branch) — that is a different row.**
> - **A REAL model call was made anyway, and it moved row 28 partway.** Two real generations on
>   profile 4 through the **category path**, which `fetchAI` short-circuits into `altRec` and
>   returns from **before** any `localStorage` write and before `cacheAIRecOnServer` — so this is
>   **provably write-free** (verified in source, confirmed at runtime: zero non-GET calls other than
>   `/api/ai`). **A** = arc block present (628 chars, 27,120 total); **B** = identical state with
>   `arc_state`/`arc_origin` stripped in memory only (0 chars, 26,492 total); 628-char delta, the
>   arc block the only intended difference.
>   **Criterion (iii) PASSES — but VACUOUSLY, and that is stated rather than glossed:** the rec
>   contains **no position / drift / week number at all**, so it cannot state one that was not
>   injected. It does not prove the model would resist inventing a number if it were narrating
>   progress.
>   **Criteria (i) and (ii) CANNOT be judged from this pair** — the arc goal is `stalled`, not
>   `re_ramping`, so the block's re-ramp instruction never applied. Structurally the arc run came
>   back marginally **denser**, not lighter (opt1 16 movements / ~33 sets vs 14 / ~28; opt2 12 / ~26
>   vs 10 / ~23), and the three "rebuilding" hits in run A are about **pubic osteitis**, not the arc
>   goal. **Also notable: the arc goal never appears in `goal_tags` in EITHER run**, though wrist
>   work appears as exercises in both — the block named a goal the model did not tag.
> - **Remaining check for row 28 is unchanged in substance and now needs a decision** (see the
>   ledger and the next-session block): the only honest routes are to let profile 4 accumulate real
>   qualifying sessions on the bench goal until a genuine peak-then-gap forms (slow, but the fix now
>   protects the origin), or for the athlete to state the bench roadmap's intended phase-1 start
>   date as a product decision, after which the replay derives everything else from the real log.
>
> **Backlog line logged (decision, not a bug):** the **manual** check-in is `localStorage`-only —
> per-device, per-day — and does **not** sync via `daily_checkins` the way the *feeling* check-in
> does, so a new day, another device, or cleared storage re-shows the gate. Left as designed.
>
> **2026-07-27 session #41 — PT BRAIN ARC CLOSE-OUT. DOCUMENTATION ONLY — no code, no
> migrations, no data changes. The only files written are `ROADMAP.md` and `CLAUDE.md`.**
> Sessions A, B, C and D each closed out individually; the **arc-level** state had never been
> consolidated, and two live findings from after Session D's close-out were in no document at all.
> This pass makes the docs a true cold-start source of truth.
>
> **§7's PT Brain section is restructured from DESIGN TARGET to SHIPPED.** All four layers are
> built. The design rationale is deliberately KEPT — it explains why the shape is what it is — but
> it no longer reads as future work. A new **AS-BUILT** table gives, per layer: what shipped, where
> it lives in code, what is verified live vs shipped-but-unverified, and what is still open.
>
> **THE HEADLINE ARTIFACT IS THE CONSOLIDATED VERIFICATION LEDGER** (§7 → "PT Brain — consolidated
> verification ledger"). One table across all four layers, with **shipped and verified tracked
> separately**, and for every unverified item the **exact check that closes it**. Highest-value
> open check, unchanged: **Session D item (c)** — a re-ramping goal producing a visibly lighter,
> rebuild-the-base rec on profile 4. The block's construction is verified; the model's response to
> it is not. **It is now BLOCKED by BUG 2 below**, because profile 4 is where the check has to run.
>
> **TWO NEW OPEN BUGS, found live AFTER Session D closed. Neither is fixed; both are logged with
> enough detail to pick up cold** (§6 → "PT Brain arc close-out — open bugs", §9):
> - **BUG 1 — HTTP 413 on `/api/profiles/1/goal-progress` (profile 1, live).** The 413 comes back
>   as an HTML error page, so the client's `JSON.parse` fails as a **secondary** symptom — the
>   `SyntaxError: Unexpected token '<'` at `index.html:11308` is **not** the bug. Impact: goal
>   progress numbers don't load; everything else on the profile renders. **⚠ Raising the body
>   limit is a band-aid** — profile 1 has ZERO arc goals today, so migrating it (§7 → profile-1
>   migration decision) lands `arc_state` on every goal and grows the payload again. **First step
>   when picked up is an AUDIT of what that endpoint actually sends.**
> - **BUG 2 — no workout rec renders on Today for profile 4 (Test #3),** observed right after the
>   athlete regenerated a goal's roadmap there. Undiagnosed. **NOT a general Layer 4 regression** —
>   profile 1 was checked immediately and is healthy. **This blocks the Session D item (c)
>   verification**, so it is the first thing to work next session.
>
> **TWO ITEMS NEWLY VERIFIED LIVE by the athlete after Session D's close-out:**
> - The loud `needs_regeneration` banner renders on a real drifted goal (profile 4, "Bench press
>   175 lbs for a single") and the inline regenerate action works. **This closes the Session B/C
>   item that had never been human-confirmed.**
> - **Profile 1 renders normally post-Layer-4** — rec cards generate, and the capacity card and
>   profile cards load correctly on boot and on tab switch. No depth regression observed by the
>   athlete. This is the human confirmation behind session #40's 77 structural checks.
>
> **Carried forward, deliberately NOT chased with synthetic data this pass:** Session C's handoff
> firing at ≥75%, derived-target-through-week-preview, the stale branch of app-open arc
> evaluation, and Session B's rehab-vs-skill decay contrast + the flex SHORTEN direction (both
> unit-tested against the real shipped functions, never exercised end-to-end on real data).
>
> **Key learnings recorded** (`CLAUDE.md` → "PT Brain — Arc Close-Out"; §9): prompt char-budget
> projections in this codebase run **systematically low** (Session D projected +300/+500, actual
> +641/+935; session #31's audit was ~30% under) — measure, don't estimate. A **green test harness
> can be broken** — Session D's extractor over-captured thousands of lines because its brace
> scanner didn't skip comments, and the functional tests passed anyway at 48/49; a harness that
> reports near-green while silently mis-extracting is more dangerous than one that fails outright.
>
> **Doc contradictions resolved this pass** (each was a real conflict between two sections, not a
> tidy-up): the "`estimateSegmentWorkMinutes`'s additions fire ZERO times" claim in §6 SALVAGE, §7
> Layer 4 and §9 contradicted §6 Session D item 3, which measured the all-bare rule firing on 1 of
> 11 strength-day sections; §6 Session B item 1 still said arc evaluation runs on workout save only,
> which Session C's app-open evaluation had already narrowed; and both docs still routed
> `goal_roadmap_adapt` to Haiku when `server.js:2724` has routed it to **Sonnet** since session #30.
>
> **NO NEW FEATURE WORK should start until Session D item (c) is closed** — it is the last unproven
> link in the Layer 2 → Layer 4 chain and the entire athlete-facing payoff of the arc.
>
> **2026-07-25 session #40 — PT BRAIN SESSION D SHIPPED: Layer 4, session depth. THE FOUR-LAYER
> PT BRAIN ARC IS NOW CODE-COMPLETE.** Five pieces, `public/index.html` ONLY — no server change, no
> `server/` file, no v2 file, no npm dep, SSE path untouched, macro paths untouched. **The entire
> diff removes exactly THREE lines, all of them signature/call-site edits to one function.**
>
> **⚠ This is the FIRST PT Brain layer to change code profile 1 runs every day** (`fetchAI`'s
> daily-rec prompt). Sessions A–C never touched a `fetchAI` builder. **Primary success criterion was
> depth NON-REGRESSION, above every feature — and it holds.**
>
> **STEP 1 GATE CLOSED — the strength-day measurement.** The athlete generated and pasted a real
> profile-1 strength-day rec (category-pill path, which writes only `altRec` and never touches the
> stored daily cache). 3 options / 11 sections / 34 exercise lines, verdict **accepted quality**.
>
> **THE TABLE IS RATIFIED UNCHANGED — no revision.** `<8 EXEMPT · 8–14→2 · 15–24→3 · ≥25→4`.
> Across **12 gated sections spanning both days, ZERO are flagged.** Held **AT the measured line**
> rather than dropped a notch, and the reason is that the number has two consumers with opposite
> failure modes: **stated in the prompt it acts as a TARGET** (a minimum below accepted quality
> invites regression — and non-regression is the primary criterion), while **in the verifier it acts
> as a TRIPWIRE** (at the line it fires the moment a section drops one movement below anything ever
> accepted). The prompt role dominates: a false warn costs one console line, a stated-too-low
> minimum costs real depth on every rec every day. **Mitigation for the zero-margin concern:
> `margin` is now reported per section**, so an at-the-line pass stays legible. 5 of 12 gated
> sections sit at exactly zero margin (3 strength Mains, 2 mobility Mains) — the 6th Main (18 min /
> 4 movements) carries +1.
>
> **VERIFICATION — 77 checks across two harnesses, 77 pass**, run against the REAL shipped functions
> extracted from BOTH the pre-change (`HEAD`) and post-change `public/index.html` by source slicing
> and evaluated in a `vm` sandbox (the `v2FoldedCards.test.js` discipline: run the actual code, never
> a hand-copied duplicate). **PRIMARY, read-only, no writes to profile 1, both days:** per-section
> exercise counts, total exercises per option, exercise strings and declared minutes are all
> **byte-identical before vs after** — strength `[[3,4,4,3],[2,3,4,3],[2,3,3]]`, mobility
> `[[3,4,3,3,1],[2,4,3,1],[4,3]]`, legacy `[[4]]`. **Zero depth drop anywhere.**
>
> **A REAL EXTRACTION BUG WAS FOUND AND FIXED MID-VERIFICATION, and it matters.** The first harness
> run reported 48/49 with one structural check failing. The cause was **the harness, not the
> product**: the brace scanner did not skip comments, so an apostrophe in `// the model's own` opened
> a phantom string and swallowed braces, making `grabFunction` over-capture thousands of lines. The
> functional tests had passed *anyway*, which is exactly the danger — a broken extractor that still
> looks green. Fixed with proper comment/string/template/regex-literal handling **plus an
> over-capture guard that throws** (no other column-0 `function` may appear inside a slice, and every
> slice must re-parse). Re-run: **49/49**. This is why the extraction discipline exists.
>
> **ONE PHASE 1 FINDING WAS CORRECTED BY REAL DATA.** A1 recorded that the all-bare-section rule
> "fires ZERO times" — that was measured on the **mobility day only**. On the strength day it fires
> on **1 of 11 sections** (Hand Rehab: `Wrist Circles` / `Reverse Prayer Stretch 30s` /
> `Slow Fist Open and Close`, all unquantified, declared 5 min → estimate 4.0 → 5.0). It is a small,
> correct improvement, and it is the **only** before/after time delta anywhere in either day — every
> other section's estimate is byte-identical.
>
> **PROMPT SIZE OVERSHOT THE PHASE 1 PROJECTION — measured and reported, not glossed.** Depth block
> **+641** (projected ~300, after a tightening pass from an initial 919); arc block up to **935**
> (projected ~500 — that estimate did not budget for the mandated-verbatim ARC REALITY instruction,
> which is ~430 chars on its own). **Profile 1: 27,223 / 28,000, headroom 777, needs no extra trim,
> and its arc block is 0 chars because it has 8 goals and ZERO arc goals.** A hypothetical
> fully-arc'd profile lands 158 over the untrimmed budget and pays **one** additional ladder rung
> (`coachingBrief→400`, worth 1,943) — the designed behaviour A4 predicted. **The trim ladder is
> unchanged (same 4 rungs) and all seven protected blocks, `arcStateContext` included, are provably
> absent from it.**
>
> **A5 capacity card FIXED, and the Session C diagnosis was wrong.** Confirmed in the live source:
> `renderCapacityCard()` was never in the profile render fan-out — the call sits inside
> `foPersist()` at `public/index.html:6843`, the Focus-Override **save** handler. Now called from
> `showTab()`'s profile branch (tab switches, plus `loadCapacityFit()`) **and** from the profile
> render fan-out where Session A meant to put it (boot). Verified idempotent across 5 repeated calls
> against a stub DOM running the real shipped function and its real helpers; empty-state still
> hides correctly.
>
> **NOT verified live (stated plainly):** item **(c)** — driving a profile-4 goal into `re_ramping`
> and confirming a generated rec visibly reads as a re-ramp. That needs a deploy plus a real model
> call; the block's **construction** and its content constraints are fully verified, the **model's
> response to it** is not. Also carried forward unchased, per the brief: Session C's handoff firing,
> derived-target-through-week-preview, and the stale branch of app-open arc evaluation.
>
> Full record: `CLAUDE.md` → **"PT Brain — Session D"**. Limitations: §6 → "PT Brain Session D".
> Four new backlog items (L1 pacing/circuit estimation, L2 section-label misplacement, L3
> coexistence-awareness absent from the daily rec, L4 category+intensity in one action) are logged
> in §7 and were **deliberately NOT built** — scope stayed locked to the five pieces.
>
> **2026-07-25 session #39 — PT BRAIN SESSION D, PHASE 1 AUDIT RESULT (RECORDED BEFORE BUILD).**
> **Nothing was built at the time this was written. No code, no deploy — the repo is exactly as
> Session C left it.** This banner exists because the Phase 1 audit was completed in a context that
> was subsequently lost before it reached the docs. The findings below are **AUTHORITATIVE — do not
> re-run this audit.** Layer 4 (session depth) is the last PT Brain layer and the FIRST one to
> change code that profile 1 runs every day (`fetchAI`'s daily-rec prompt).
>
> **Benchmark on record, and the primary success criterion.** v1's current output for profile 1 is a
> **60-min rec, 16 exercises, 4 labeled sections, real autoregulation reasoning**. **Non-regression
> of that depth outranks every feature in Layer 4.** A depth regression here is the exact failure
> that killed Engine v2 (§6 → "Rejected Approaches & Lessons").
>
> **A1 — ESTIMATOR: keep the existing heuristic (option (c)). APPROVED, SETTLED.** The v2 salvage
> candidate `estimateSegmentWorkMinutes` was evaluated **against real content** and deliberately
> **NOT ported**. Reasons, all measured:
> - `server/coachingRules.js` derives its constants FROM v1 and they are identical by construction:
>   `WORK_MIN_PER_STRENGTH_SET 1.5 = REC_MIN_PER_SET`; `WORK_MIN_PER_MOBILITY_SET 1.0 =
>   REC_MIN_PER_MOBILITY`; `WORK_MIN_REST_PER_HOLD 1.0 =` v1's "+1 min" per hold.
> - `estimateSegmentWorkMinutes` reads **STRUCTURED** objects (`ex.sets`, `ex.reps`,
>   `ex.time_seconds`, `seg.type`, `seg.duration_min`) and parses **no strings**. v1 rec sections
>   carry **FREEFORM strings** ("Bench Press 3x8 @ 135lbs"). Porting it means writing a
>   string→structure parser to feed an estimator that computes what `estimateExerciseMinutes`
>   already computes — **the parser IS the existing function's entire job.**
> - Measured on profile 1's live rec (**32 exercise lines, 11 sections**), the salvaged version's two
>   genuine additions fire **ZERO times**: whole-segment-bare → declared minutes (only **3/32 lines
>   bare = 9%**, no section all-bare), and segment-type mobility rate (`recIsMobilityish` already
>   catches every yoga/mobility name present).
> - **TAKE ONE THING:** the all-bare-section rule, as a **3-LINE ADDITION** to the existing function
>   (not a port) — now implementable because `sections[].minutes` exists since session #31.
> - **HARD INVARIANT:** `estimateExerciseMinutes` stays **ONE implementation with TWO consumers** —
>   `buildTimeBudgetContext` (prompt) and `verifyRecTimeBudget` (verifier) — so they can never
>   disagree. Prove this in verification.
>
> **A1b — EMPIRICAL FINDING, recorded beside the rejected 0.70 gate.** Profile 1's live,
> **athlete-ACCEPTED** rec estimates at **36/60, 23/45, 18/30 min = 60% / 51% / 60%** of stated
> time. **Every option would have FAILED a 0.70 work-floor.** This is direct confirmation of the §6
> rejection, and it is the standing constraint for Layer 4: **the depth floor must never become a
> time floor by another name.**
>
> **A2 — DEPTH FLOOR: table PROPOSED, ONE OPEN GATE.** Measured on profile 1's live output
> (a mobility/yoga day) — *section: declared min / distinct movements*: Warm-up 8/3, 5/2 · Main Flow
> 30/4, 25/4, 18/4 · Posture add-on 12/3 · Core+Hand 10/3 · Hand Reset 5/3, 5/3 · Dead Hang Everday
> 5/1, 7/1. Two findings shape the table: (1) a **25–30 min Main carries only 4 movements in
> ACCEPTED output** — `≥4 at 25 min` exactly ratifies, `≥5` would fail live good content; (2)
> **single-movement habit blocks are correct and common** (Dead Hang appears in all 3 options) — any
> floor `≥2` would flag them every day. Proposed table (applies only to sections with declared
> minutes **≥ 8**): `<8 → EXEMPT` · `8–14 → 2` · `15–24 → 3` · `≥25 → 4`. Every live section passes;
> two Main sections sit **exactly at the line with zero margin** (acceptable given warn-only).
> **⚠ DERIVED FROM ONE MOBILITY DAY ONLY — a strength-day measurement is the open gate and the
> table must be re-derived against both before anything is built against it.**
>
> **A3 — ARC BLOCK: APPROVED, SETTLED.** `arc_state` is confirmed reachable client-side at
> `currentProfileData.goals[].roadmap.arc_state` (Session B renders the RE-RAMPING chip from it;
> `cleanProfileData` is recursive and type-preserving). **Profile 1 has 8 goals and ZERO arc
> goals** — all legacy roadmaps — so this contributes **0 chars and 0 behaviour change on the
> regression-risk profile**. Shape: self-capped, top-3 by priority, **protected tier**, mirroring
> `buildRoadmapEmphasisContext`. Header "ARC STATE (computed from the athlete's log — the ONLY
> source of these facts)"; one line per arc goal (status, earned week vs calendar, drift, re_ramp
> target + since-date); then an INSTRUCTION line: prescribe for the EARNED position not the
> calendar, a re-ramping goal gets a lighter rebuild-the-base session and honest framing, never
> state a position/drift/week number not listed above, never contradict it. **Reuse the adapt
> prompt's ARC REALITY wording VERBATIM.** Cap ≈ 3 goals × ~110 chars + instruction ≤ **500 chars**.
> Zero arc goals → **empty string, no header, no placeholder.**
>
> **A4 — PROMPT BUDGET: measured, APPROVED to proceed.** Real `auditOnly` run against profile 1:
> `_startedAt 28336` · `_total 26582` · `_budget 28000` · `_trims "historicalBrief->400"`.
> Components: systemPrompt 6934 · roadmapEmphasis 2112 · exerciseHistory 2903 · coachingBrief 2343 ·
> focusOverride 1861 · fullProfile 1607 · timeBudget 1539 · microGoals 1347. **Headroom 1,418.**
> Projected: profile 1 (0 arc goals) +~300 depth → ~26,882, headroom **~1,118 ✅**; a fully-arc'd
> profile +300 depth +500 arc → ~27,382, headroom **~618 ✅**. Untrimmed rises 28,336 → ~29,136 so
> the ladder trims harder; the next rung (`coachingBrief 2343→400`) frees ~1,943.
>
> **A5 — CAPACITY CARD: root cause FOUND, one-liner. Session C's §6 entry calling this a
> "render-ordering pass" was a MISDIAGNOSIS.** Actual cause: Session A appended
> `renderCapacityCard(); loadCapacityFit();` after `renderFocusOverrideCard()`, which landed
> **INSIDE `foPersist(fo, reason)`** (`public/index.html:6843`) — the **Focus-Override save
> handler**, not the profile render fan-out. The card therefore only ever renders when a Focus
> Override is saved; **never on boot, never on tab switch.** Fix: call both from `showTab()`'s
> existing `if (name === 'profile')` branch. Leave the `foPersist` call (harmless).
>
> **A6 — BACK-COMPAT: unchanged.** `recOptionSections` / `recOptionExerciseStrings` /
> `recDeclaredSectionMinutes` remain the single seam. Depth measurement reads through
> `recOptionSections`, so a legacy flat rec presents as one unlabeled section with no declared
> minutes and is **exempt under the `<8` gate**. No consumer signature changes.
>
> **FILES for the build: `public/index.html` ONLY.** `buildTimeBudgetContext` (+depth minimums),
> `verifyRecTimeBudget` (+depth reporting, still **warn-only**), `estimateExercisesMinutes`
> (all-bare-section rule), a new `buildArcStateContext()` inserted beside `roadmapEmphasisContext`
> as a protected tier, `showTab` (capacity fix). **No server changes, no `server/` file, no v2
> file.**
>
> **2026-07-25 session #38 — PT BRAIN SESSION C SHIPPED: Layer 3, the coexistence engine.**
> Classifies the athlete's goals against their real week (GATE → capacity in code →
> COEXIST | SEQUENCE) and produces a schedule **DELTA PROPOSAL**. **The verdict never mutates
> the schedule** — approving is what applies it, through the ordinary `schedPersist` path, so the
> app still has exactly one schedule writer. Profile 1 goals byte-identical
> (`0901b047d1c95f50…`), no `coexistence` key on profile 1, macro phases untouched.
>
> **Storage moved to `profile_data.coexistence` (approved).** Phase 1 found that
> `roadmap_data` is **null on 3 of 5 profiles**, and that **both** macro writers
> (`POST /roadmap-data` and `adaptMacroRoadmap`) rebuild the column from a fixed key list and
> would have silently dropped the verdict on the next regenerate or stale workout save — the
> Session A `roadmap.estimate` bug class, caught by inspection this time instead of by data loss.
> **Proven moot live:** a real macro regenerate left `coexistence` intact. Neither macro path was
> touched.
>
> **`link_existing` is deliberately narrow.** Category agreement alone would attach "Bench press
> 175 lbs" to a broad "Upper Body Strength" target. The test is a shared *meaningful keyword*
> between goal title and target activity, plus a muscle-disjointness guard — so bench falls
> through to `create` and legitimately gets its own narrow target alongside the broad one, while
> "Wrist Rehab" correctly links to the wrist-rehab goal. **An athlete-typed activity string is
> never renamed.** 16 unit tests on the shipped functions.
>
> **One bug found live:** `capApplyDelta` was not idempotent — the delta is applied before the
> decision status is recorded, so a failure between them left the schedule updated with the
> proposal still `pending`, and re-approving would duplicate a target. A `create` now skips when
> the goal already has a linked target.
>
> **Also shipped:** app-open arc evaluation (`POST .../evaluate-arcs`, 24h-gated, zero AI calls)
> so decay accrues across a break instead of landing all at once — this narrows, but does not
> fully close, the §9 "no time-based trigger" gap. Full record: `CLAUDE.md` → **"PT Brain —
> Session C"**. **Next: Layer 4 (session depth) — the last layer, and independent.**
>
> **2026-07-25 session #37 — PT BRAIN SESSION B SHIPPED: Layer 2, living adaptation (earned
> arc position).** The calendar no longer advances you; doing the work does. `position_week` is
> a pure code-owned replay of the log — the AI narrates it and never authors it. Applies to
> new-shape roadmaps only; legacy 3+2 roadmaps get no `arc_state` and keep time-elapsed
> progress. **Profile 1 goals byte-identical (sha256 `0901b047d1c95f50…`), and the week-preview
> skeleton is byte-identical across the matcher factoring (`5ef8579eefec6577…`).**
>
> **FOUR REAL BUGS FOUND LIVE**, none by inspection, all fixed and re-verified:
> 1. **The arc origin moved.** `computeArcState` read its replay start from `near[0].start_date`,
>    but `applyTimelineFlex` → `resequenceNearTermDates` rebuilds the phase calendar forward from
>    *today* — so every flex reset the origin, collapsing `calendar_week` to 1 and wiping every
>    earned week. Two goals with 3 weeks of real history evaluated to position 0. Now an
>    immutable `roadmap.arc_origin`, pinned once.
> 2. **Same bug class, other half of the function:** the workouts/exercises fetch window was also
>    keyed off `near[0].start_date`, so after a flex it narrowed to "since today". A goal with 18
>    real qualifying sessions evaluated against the 9 inside the phase window.
> 3. **Timeline flex compounded.** `flex_streak` kept incrementing while a drift persisted, so a
>    sustained condition re-stretched the roadmap on every workout save. The streak now resets
>    after a successful flex.
> 4. **`re_ramp.started_date` reported the latest decay week, not the start** — it renders as
>    "re-ramping since <date>", so it has to mean that.
>
> **Also closed this session:** ROADMAP §9 **F1** (standing since 2026-07-19) —
> `resequence-roadmap` took the server clock where it must take the athlete's day;
> `loadProfileWithGoals` now selects `timezone`. And the §6 **negotiation-loop** item — a round
> counter escalates the framing toward capacity from round 2 without touching the three levers.
>
> Full record: `CLAUDE.md` → **"PT Brain — Session B"**. **Next is Session C (Layer 3,
> coexistence) — design discussion FIRST, per §7. Layer 4 remains independent.**
>
> **2026-07-25 session #36 — PT BRAIN SESSION A SHIPPED: keystone join + Layer 1 (honest
> per-goal timelines + aggressiveness dial) + global capacity + intake negotiation.**
> Two-phase session per §0.2 (audit + plan → approval → build). Profile 4 was flipped to v1
> as pre-work and is now the PT-Brain test bed. **Profile 1 untouched — its 8 goals are
> byte-identical (sha256 `0901b047d1c95f50` before and after).**
>
> **What shipped.** The fixed "3 near_term + 2 horizon" skeleton and the integer 4–6
> `duration_weeks` clamp are **retired for per-goal roadmaps**. Phase count and each phase's
> week budget are now **derived in code** from an honest per-goal timeline estimate and handed
> to the model as fixed slots — the model authors words, never the numbers it is judged on.
> **Macro-roadmap paths are deliberately untouched** (`MACRO_ROADMAP_SYS`, `adaptMacroRoadmap`)
> and keep 3+2 until Layer 3.
>
> **Verified live on profile 4, all three worked targets hit exactly:**
> (a) rehab wrist goal → estimate 4–10 wk → **2 near-term phases `[4,3]`, 0 horizon**, dial
> locked; (b) 135→175 bench → estimate 16–32 wk (~3.7–7.4 months) → **3 near `[6,5,5]` + 1
> horizon "months 4–6"**, dial live; (c) marathon → **negotiation fired** with exactly three
> levers in order `slower/capacity/sequence`. Budgets sum to the derived total in every case.
>
> **Server-authoritative dial lock PROVEN**, not asserted: a request that tried to move the
> rehab goal's frequency 5→7 was overridden back to 5 (`dial_override_applied:true`).
>
> **TWO REAL BUGS FOUND LIVE** (neither by inspection), both fixed and re-verified:
> 1. **`adaptGoalRoadmap` silently dropped `roadmap.estimate`** — it rebuilds the roadmap object
>    from scratch and had no `estimate` key, so the first check-in after generation wiped the
>    record of what the roadmap was built from and the staleness banner could never fire again.
> 2. **`adaptGoalRoadmap` truncated a 5-phase roadmap at `max_tokens: 2000`** — reproduced 3/3
>    at the same byte offset. **This is the 3+2 legacy shape, i.e. profile 1's three roadmaps**,
>    and the weekly auto-adapt is fire-and-forget with `console.error` only, so a systematic
>    failure there would have been invisible. Raised to 3000.
>
> **A third destroy-site was found in Phase 1 that the brief hadn't listed:** `schedSaveAnchor`
> replaced the anchor with a fresh object literal on every "Set Anchor" tap, destroying any
> extra key — including the new `goal_ids`. That is the *normal* editing path and far more
> likely to fire than the Build-with-AI builder. Fixed to merge; verified end-to-end.
>
> Full implementation record: `CLAUDE.md` → **"PT Brain — Session A"**. Design of record:
> §7 → "NEXT DIRECTION — the 'PT Brain'". **Next build session is Session B (Layer 2,
> `arc_state`)** — unblocked, since Session 0 confirmed there are no corrupted phase dates.
> **§0 "How We Work — Standing Conventions" is required reading before any session work begins.**
>
> **Doc accuracy notes:** Sections 2, 4, and 10 were verified directly against `server.js`,
> `wearables/`, and `migrations/` rather than transcribed. Where the original brief differed
> from the live code, the doc follows the code and flags it with **⚠ Correction**.
>
> **2026-07-24 session #34 — ⚠ STRATEGIC PIVOT: Engine v2 PAUSED, focus reverts to v1.
> DOCUMENTATION-ONLY session — no code, no migrations, no flag changes, nothing reverted.**
> Read this before any Engine v2 material further down; it changes what the next thread should
> build, not what was built. Full record: `CLAUDE.md` → **"Strategic Pivot — Engine v2 paused,
> v1 is the go-forward engine"**; rejected approaches in §6 → **"Rejected Approaches & Lessons —
> Engine v2 arc"**; forward direction in §7 → **"NEXT DIRECTION — the 'real personal trainer'
> brain"**.
>
> **What happened.** The athlete used Engine v2 on his real profile and judged the v2 SESSIONS a
> **depth regression from v1**. Three findings, in order:
> 1. **v1 was never the problem.** Profile 1 has been on v1 throughout and every v2 session
>    verified it byte-identical. v1 produces genuinely deep multi-goal sessions — a real example
>    this session: a **60-minute rec with 16 exercises across 4 labeled sections** (Hand & Wrist,
>    Warm-up, Main Yoga Flow, Posture & Core add-on) with real autoregulation reasoning from HRV
>    and weekly-target status. **That depth is the target state and STAYS.**
> 2. **The v2 sessions were thin BY CONSTRUCTION.** The **0.70 work-floor invariant (§6)** rewarded
>    "technically fills the time," and the model satisfied it the cheap way — few exercises,
>    inflated per-segment minutes — rather than prescribing rich multi-exercise blocks. Optimizing
>    that proxy metric produced sparse sessions. **This is now understood as the root cause of the
>    depth complaint, not a tuning issue.** No floor value fixes it.
> 3. **A context check was run against the PREVIOUS thread's actual statements** to settle a
>    disagreement about what had been claimed regarding v1. Recorded so it is not re-litigated:
>    (a) **v1 is NOT context-starved** — it feeds 13 ordered blocks and its length guard was raised
>    **6000 → 28000** in session #17; the "can't see enough context" problem was **v2's PLANNER**;
>    (b) **"high randomness" was a real finding about the `extract_exercises` call** (temperature),
>    **NOT** about v1 daily-rec generation; (c) **"doesn't scale as it learns" is real but was a
>    v2-PLANNER gap** (no phase/progression context), not a v1 defect — though v1 **does** lack
>    **persisted progression memory**, which is the real forward-looking gap.
>
> **Decisions recorded.** Focus reverts to **v1**; new capability is ADDED to v1. **v2 code REMAINS
> in the repo, flag-gated off — NOT deleted, NOT reverted, NO tables dropped**, preserved for
> possible future reference. **Profile 4 was NOT flipped this session** — the revert audit/execution
> was scoped, then the athlete chose to pivot to forward design instead; its honest current state is
> **still `engine_v2 = true`, still carrying the cloned data and the v2 writes**. Formally
> decommissioning v2 is a separate future task. **The next direction is NOT "finish v2."**
>
> **Four approaches REJECTED** (details + reasons in §6): the 0.70 work-floor as a session-quality
> gate; "honestly shorten light/rehab days"; bolting maintenance-tier filler onto a thin driver
> skeleton; and **rebuilding v1's capability as a from-scratch parallel engine — the entire v2
> strategy** (lesson: ADD to v1, which already produces the depth and already coexists multiple
> goals per session).
>
> **Next direction (DESIGN TARGET, not approved for build).** A "real personal trainer" brain,
> designed ON PAPER first, then built ONE layer at a time with each layer's generated goals/roadmaps
> tested before proceeding; roadmap/goal CREATION on **Sonnet** (quality-critical), not Haiku. Four
> layers: honest per-goal timeline → living adaptation → coexistence engine (COEXIST/SEQUENCE/GATE)
> → session depth. **The immediate next step is an AUDIT** of what v1 already persists for roadmaps,
> timelines and multi-goal scheduling (Living Goal Roadmaps, Macro Roadmap, the schedule system —
> anchors / frequency targets / add-ons), so the paper model is designed against what exists. **Not
> a build session.**
>
> **Salvage from v2:** `estimateSegmentWorkMinutes` / `estimateSessionWorkMinutes` (hand-verified,
> reusable in v1 as a **content reconciler** enforcing depth — explicitly NOT the 0.70 gate) and
> the COEXIST/SEQUENCE/GATE + honest-timeline framing (genuinely new). **NOT salvaged:** the
> single-plan model, the allocation invariant, and the alternate-card UI.
>
> **2026-07-22 session #33** (Profile-4 clone + Engine v2 Phases 1–2. Audit-report-first and
> gated at every step; Phase 1 was audit-only, Phase 2 ends here with no Phase 3 work started):
>
> **ARC 1 — Engine v2 Phase 1 audit (no code).** Mapped every producer and consumer of the daily
> rec. **The single structural finding: the entire v1 rec prompt is assembled in the BROWSER** —
> `server.js` never builds it, `/api/ai` is a routing proxy only. So v2 is not "moving" the prompt
> server-side; there is nothing server-side to move. 7 client seams must branch on the flag, 4
> consumers are shape-dependent (including `life-os-summary`, an EXTERNAL app). **Confirmed no
> scheduler of any kind exists** (`setInterval`/`cron`/`nightly` return nothing in `server.js`).
>
> **ARC 2 — Profile-4 clone (data operation, 4 SQL files, run manually by Shimmy, verified).**
> Profile 4 now holds a verified clone of profile 1's training history. Three findings worth
> carrying forward: **6 of profile 1's workouts hold a TIME STRING in `workouts.date`** (proving
> the column is `text`, not `date` — see §6, skipped by the clone, not repaired);
> **`micro_goals.id` is an INTEGER, not a uuid** (both docs and the Phase 1 audit said uuid — all
> three were wrong); and **`GET /api/profiles/:id` writes on read** via `ensureGoalIds`, so profile
> 1 was inspected by SQL SELECT only throughout. The REST API also under-reported two baselines
> badly — `daily_steps` is 736 rows, not the 366 the endpoint returned (it clamps to 365 days),
> and `daily_sleep` (736) has no listing endpoint at all. Running the baseline query rather than
> trusting the API is what caught both.
>
> **ARC 4 — Engine v2 Phase 3 (planner shipped; one real plan generated + persisted).** 47-test
> rules harness closes the two gap-decay bands real data never reached; progression table resized
> **9,989 -> 3,093 chars** by splitting on signal not recency; `establish_baseline` added as a
> first-class action; goal tiers + `profile_data.schedule_v3`; `POST /api/v2/plan/:profileId`
> (streaming Sonnet, 2-attempt cap). **First generation: 1 attempt, 114 s, 5,426 in / 7,323 out
> tokens, 7 sessions persisted, ZERO invariant violations — so the invariant set is shipped but
> UNPROVEN.** The plan used all 6 progression signals, both anchors, the tier split and all three
> roadmap emphases. Four real defects found in its output, all logged in §6: the `time` field
> carries no unit (bike 20 = minutes, dead hang 30 = seconds — a SCHEMA defect, not prompt-fixable),
> no time-budget verifier exists in v2 (4 of 7 sessions disagreed with their own stated length by
> 5 min), an accessory-tier goal was named in prose but never actually prescribed, and the model
> asserted a "22-day gap" statistic that is correct against the DB but **absent from its inputs**.
>
> **ARC 3 — Engine v2 Phase 2 (shipped, deployed, run live).** `server/coachingRules.js` +
> `server/v2Progression.js` + `server/v2Dossier.js` + `GET /api/v2/audit/:profileId` +
> `v2CurrentPhase()`, plus three UNRUN migration files. **v1 untouched**: three additive requires
> and one new route in `server.js`, nothing else; profile 1's endpoints all verified 200
> post-deploy. Measured live on profile 4: rules 6,654 chars, progression table 9,989 (40
> exercises), dossier 2,401 serialized — 17,798 total before any planner context.
>
> **THREE BUGS FOUND BY RUNNING IT, NOT BY READING IT** (all fixed):
> - The audit endpoint selected `dossier`/`dossier_updated_at` before their migration was run;
>   PostgREST 400s an unknown column and returns an error OBJECT, not an array, so the handler
>   reported **"Profile not found" on a profile that exists.** Now falls back to a column-less
>   select and reports `storage_columns_migrated`.
> - **`duration_minutes` is overloaded** — hold duration AND session length, with nothing in the
>   schema distinguishing them. A 60-minute MMA class was classified `modality: isometric` with
>   `PB 60:00 hold`, and the rules then prescribed **"+5-10 s hold" on a sparring session**. v2 now
>   disambiguates by category. **v1 still has this and is unfixed** (§6).
> - A single logged instance was being reported as a **notable PB**. PBs now require ≥2 sessions
>   and are ranked by magnitude.
>
> **Honest gaps carried into Phase 3:** 34 of 40 exercises have <3 sessions in 60 days, so most of
> this athlete's log carries **no usable progression signal** — the planner must treat "no signal"
> as a first-class case. The dossier sits at 2,401 chars against a ~2,000 target (injury histories
> dominate; injuries are shortened, never dropped). The progression table at 9,989 chars is the
> elastic section and will need a cap. **Render's plan/spin-down behavior could not be determined
> from the repo or the API** — it decides whether the nightly interval is viable, and needs a
> dashboard check.
>
> **2026-07-20 session #32** (Logged-workout sectioning + clickable exercise names with inline
> quick-views + Auto rec-length fix. **Frontend-only — every change is in `public/index.html`;
> no schema, no endpoints, no writes.** Four build rounds, each audit-or-report-gated where it
> touched a data path):
>
> **ROUND 1 — Logged-workout sectioning (grouped history render + quick-view card).**
> - **New shared pure helpers** replace the old name-only chip render across History surfaces:
>   `groupLoggedWorkout(exercises, notes)` → `{groups[], multiCategory, notes}` (group key =
>   `main_category || category || 'other'`, group order = first appearance, logged order
>   preserved within a group, labels via the reused `CATEGORY_PRETTY` — no new map);
>   `renderLoggedGroupsHtml(grouped)` (uppercase per-group header **only** when `multiCategory`,
>   single-category renders flat/no header, `''` when no exercises); `renderLoggedNotesHtml(notes)`
>   (renders only when non-empty after trim, always placed **LAST**).
> - **Two surfaces share them:** `renderLogPastRowDetail` (Log-past panel) and `renderLog`
>   (History detail), which replaced its name-only chip row with grouped rows + notes-last.
> - **`ensureHistoryChipsLoaded` now RETAINS the full exercise rows** in
>   `historyExercisesByWorkoutId` (it was discarding down to bare names) — the grouped render
>   reads them with **no new fetch**.
> - **New quick-view card `#history-quickview`** at the top of the History list: latest
>   session's type + a group summary (`"Strength · 6 | Cardio · 1"`) + duration **only when
>   derivable** (summed `exercises.duration_minutes`, else `wearable_data.duration_minutes`;
>   omitted, never estimated). Reuses the same already-loaded data — no fetch.
> - **Dead code removed:** `openChipExercise()`.
> - **Decisions:** sections are **derived from category, never inferred** (a log is a record,
>   not a plan — no Warm-up/Main/Add-on guessing); notes render only if present; the quick-view
>   mounts on **History, not Today** (Today would need a new fetch — **declined**).
>
> **ROUND 2 — Clickable exercise names → inline quick-view.**
> - **One shared component, two data modes:** `exerciseQuickViewHtml(mode, name, key)` +
>   `toggleExerciseQuickView(mode, name, key, surface)`, backed by `exQuickOpen` (per-row open
>   state that survives each surface's wholesale re-render) and
>   `exQuickCache = {howto:{}, stats:{}}` (`payload | 'loading' | 'error'`). **Lazy fetch on
>   first expand only, cached per name.**
> - **Surface 1 — rec card (`renderAI`):** the exercise NAME (name only) is the tap target via
>   `splitExerciseName` (a client mirror of the server `stripExerciseAnnotation` cut rule), the
>   set/rep remainder trails as plain text, `exN` numbering untouched. Tap → **howto** quick-view
>   (reuses `renderExerciseHowTo`: image + description + wger CC-BY-SA). `showExerciseDetail`
>   moved into a **"Go to exercise →"** link inside the quick-view.
> - **Surface 2 — History detail + Log-past (`renderLoggedGroupsHtml`):** wraps the **structured
>   `ex.name`** (no string parsing). Tap → **stats** quick-view (`renderExerciseStatsMini`).
> - **CORRECTNESS (load-bearing):** the stats fetch and the go-to link key off the **stored
>   `ex.name`**, NOT the catalog canonical — `exercise-stats` matches `exercises.name` exactly,
>   and a legacy/pre-canonicalization row's stored name can alias-resolve to a *different*
>   canonical (fetching by canon would return an empty series). The catalog canonical is used
>   **only** as the clickability gate.
> - **Gate = `matchCatalogExactAlias`** via the existing `resolve-batch` path on both surfaces
>   (no fuzzy, no Haiku, no writes); a miss renders plain, non-clickable text.
> - **Rename (display only):** the daily "Full override today" button + "Today: Full Override"
>   pill → **"Mix Focus Today" / "Today: Mix Focus"**. `focusOverrideDaily('total')` argument and
>   the `mode === 'total'` logic untouched; the separate standing-config **'Total'** mode selector
>   untouched.
>
> **ROUND 3 — Quick-view follow-ups.**
> - **Bubbling fix:** the History name-tap now runs `event.stopPropagation()` so it toggles only
>   the inline quick-view and no longer collapses the parent workout card. (Log-past was already
>   unaffected — its toggle lives on the header row, not the detail div.)
> - **Single-open per family (`ai` / `hist` / `lp`):** opening a quick-view auto-collapses any
>   other open one in the same panel family (re-rendering every surface a collapse touched,
>   including across different Log-past rows); a second tap on the same name still collapses it.
> - **Stats relabel + field:** `Best set`/`Best hold` → **`PR`**; added **`Average`**
>   (`avg_reps_per_set`, or `avg_seconds_per_set` as m:ss for duration moves; omitted when null).
>   Final six fields: **Last performed · Total sessions · PR · Average · Est. 1RM (weight-based
>   only) · Trend** (client last-vs-previous-session delta from `daily_data`, omitted with < 2
>   sessions — no fake delta).
> - **Mini Progress-Over-Time chart (STATS mode only):** reuses `renderExDetailChart`'s
>   single-line logic (`quickViewChartSeries` → `buildQuickViewChart`) driven off the
>   `exercise-stats` `daily_data` already in the payload (**no new fetch**). 140px fixed-height
>   wrapper + `maintainAspectRatio:false` (no resize loop), duration-aware (seconds axis + m:ss
>   tooltip), PR point gold, destroy/recreate via `flushQuickViewCharts` (no leaked canvases),
>   **skipped when < 2 real points** (also covers pure-distance moves `daily_data` can't
>   aggregate). **Never** on the rec-card howto.
> - **Escaping fix:** the chart canvas `data-exname` (read back to look up the cache) needed
>   `attrEsc` (entity escaper), not `escAttr`, or apostrophe names ("Child's Pose") failed the
>   lookup.
>
> **ROUND 4 — Auto rec-length fix + settings deep-link** (commit `074f1db`; **audit-report-first,
> gated**).
> - **Root cause:** `resolveOptionDurations`'s base was
>   `userLength || sd.anchor || sd.target || REC_DEFAULT_LADDER[0]`. On a **non-anchor day under
>   Auto** (`userLength = null`, `sd.anchor = null`), `sd.target` — the underserved
>   frequency-target's duration (e.g. 30) — won the fallback and collapsed the **whole ladder** to
>   30/25/15 instead of 60/45/30. The Auto pill echoed the same collapsed base → **"Auto (30m)"**.
>   Ladder indexing itself was correct; the **base** collapsed.
> - **Fix 1 (label):** `autoLabel = 'Auto'` always — a mode label, not Option 1's derived
>   minutes; removed the `derived` echo.
> - **Fix 2 (behavior):** `base = userLength || sd.anchor || REC_DEFAULT_LADDER[0]` (dropped
>   `sd.target`). Auto non-anchor → base 60 → **60/45/30**. Anchor pin (`ladder[0] = sd.anchor`)
>   and explicit-choice (`userLength` wins) both preserved.
> - **Fix 3 (reconciliation):** `buildScheduleInstruction` dropped the `— N min` stamp from the
>   **frequency-target** label only (`tLabel = best.target.activity`) — otherwise Option 1's TIME
>   BUDGET would say 60 while the schedule instruction still said "— 30 min", a *new* prompt
>   contradiction (the exact `§1566` "never disagree" invariant, now honored the other way for
>   non-anchor days). The activity is still ordered into Option 1; the **anchor branch is
>   untouched** (a scheduled class keeps its "— 60 min"). `optionOneClaimed` and its
>   **duration-less fallback** still detect the frequency target (**B12 no regress** — verified in
>   code).
> - **Settings deep-link:** a small **⚙ Settings** link in `#rec-controls` →
>   `openRecLengthSettings()` → `openSettings()` + `switchSettingsTab('ai')`, reusing the existing
>   settings overlay path (no new panel).
>
> **2026-07-20 session #31** (Wearable provenance + daily_recs time budget + sectioned rec
> output. Two arcs, both audit-report-first with gated approval between phases):
>
> **ARC 1 — Google Health provenance.**
> - **Google Health is ALIVE and is the serving provider for profile 1's biometrics.** This
>   inverted the working hypothesis. Proven with a new admin-gated probe,
>   `GET /api/debug/google-health-probe/1?allow_refresh=1` → **all 6 legs fulfilled**
>   (hrv/rhr/sleep/steps/azm/weight), and `GET /api/profiles/1/daily` → `source:google_health`
>   with **hrv 62.4 / rhr 57 / steps 609 / sleep 8.38h**.
> - **Every signal that suggested GH was dead had a different cause.** (a) *Zero GH workouts*:
>   `findWearableMatchOnSave()` is **Fitbit-first** and `getValidWearableToken()` short-circuits
>   Fitbit to the legacy `profiles.fitbit_*` columns — so GH is never asked. (b) *`last_synced_at`
>   null*: only `computeWearableBacklog()` writes it (the sync modal), never `/daily`. It was never
>   a data-freshness signal. (c) *`needs_reconnect:false`*: see below — it was structurally
>   incapable of being true.
> - **`needs_reconnect` could NEVER turn true for Google Health.** Auth failures were swallowed by
>   a `Promise.allSettled` in `wearables/google_health.js` (~line 418) — a 401 became `null` for
>   that metric and never propagated out of `fetchDailyData()`, so it never reached
>   `getValidWearableToken()`'s catch and `setNeedsReconnect()` was unreachable by construction.
>   The `/daily` GH token step was additionally a **fully empty catch**, so a dead or absent
>   connection skipped the whole branch with no trace at all.
> - **The `source` mislabel was real, not theoretical.** `daily_steps` for 2026-07-20 read
>   `steps=609, source="fitbit"` while the probe returned exactly 609 **from Google Health**.
>
> **ARC 2 — daily_recs time budget, extended into sectioned output.**
> - **`duration` was model-invented, not computed.** `buildResponseShapeSpec()` hardcoded
>   45/30/20 as literals in the JSON skeleton and **nothing** in the prompt described
>   per-exercise time cost, so the model had no basis to derive a length. Verified live on the
>   real cached rec: an option **stating 45 min contained ~25 min of work**. The literals were an
>   anchor, not a spec — the model ignored them anyway (emitted 40/45/20 against a 45/30/20
>   skeleton), and on an anchor day the skeleton's 45 sat in the same prompt as the schedule's
>   own "MMA Class — 60 min" with nothing reconciling them.
> - **The ~6000-char `fetchAI()` length guard was structurally unreachable.** Measured by
>   instrumenting `fetchAI()` with an `auditOnly` path and executing the **real builders** against
>   real profile-1 data: **protected (never-trimmable) content ~17,400 chars, untrimmed total
>   25,817**. Every call fired all four trim steps, exhausted the ladder, and still ran ~2.8x over
>   — reported by a bare `console.log` that read like success. Practical damage: the briefs were
>   guillotined to 400 chars and `exerciseHistory` cut to top-5 on **every** call, silently
>   discarding part of the session #30 (B33a) **PERSONAL BEST** progression signal.
>   **The Phase 1 audit's ~12,000 estimate was 30% low** — it assumed no active Focus Override
>   (profile 1 has one, **1,861 chars**) and could not measure `buildLog`/`buildExerciseHistory`/
>   `dataBlock`, which are closures *inside* `fetchAI`. Flagged at the gate, as required.
> - **Two contradictory goal orderings in one prompt.** `goalPriorityContext` (from `goals[]`
>   array order) vs an embedded numbered `GOALS:` list inside the AI-authored
>   `ai_prompt_context` prose. Measured live they were nearly **inverted** — Fix Posture #1 vs
>   #4, Mountain Hike #4 vs #1, and Fix Pubic Osteitis absent from the prose list entirely —
>   while the prompt simultaneously instructed *"Goal #1 should influence ~40%"*. Cause:
>   reordering `goals[]` never regenerates the prose.
> - **B12 Option-1 contradiction fired ~5 days a week for profile 1.** `CARRY FORWARD` in
>   `buildVarietyAndSkipAnalysis()` was guarded by `todayHasSchedule`, which checks **anchors
>   only** — blind to the fact that `buildScheduleInstruction()` also issues an imperative
>   Option-1 order on a no-anchor day whenever an underserved frequency target exists. Profile 1
>   has anchors only Tue/Thu, so this was the common case, not an edge case.
> - **Steps card mislabeled.** The caption was hardcoded `'yesterday'` — correct for Fitbit
>   (`buildDailyData` reads `/activities/date/{yesterday}`) but wrong for GH, which reports
>   `ghDate = localToday()`. With GH serving, the card showed **today's partial count labeled
>   "yesterday"**.
>
> **SHIPPED + VERIFIED LIVE:**
> - **`source` now threads the real provider** on `daily_sleep` + `daily_steps`
>   (`summary.source || "fitbit"`, mirroring the already-correct `upsertBodyMetrics`).
>   **Verified:** 2026-07-20 rows read `google_health`, older rows still `fitbit`.
>   Constraint state was checked live *before* writing a new value via a throwaway-date probe —
>   both tables accept it, no CHECK constraint, no migration needed.
> - **GH failures are no longer swallowed.** Every rejected leg is classified and logged
>   (metric + code + HTTP status + transient flag); a **definitive** auth failure (401 **and**
>   zero legs fulfilled) now reaches `setNeedsReconnect(..., "google_health", true)`. A 403
>   (valid token, missing scope — the Fitbit weight/body-fat shape), 429/5xx, timeouts, and a
>   lone 401 among successes deliberately do **not** set it, so the flag cannot flap.
>   **Verified against 5 mocked scenarios** (all-401 → true; all-403, 1×401+5 OK, all-503,
>   all-OK → false). The `/daily` empty catch now logs the skip.
> - **7s per-request `AbortController` on GH legs** — they previously had no timeout at all,
>   bounded only by `/daily`'s outer 8s cap, which collapsed one hung leg into an opaque
>   whole-call timeout.
> - **`last_synced_at` stamped on a successful `/daily` serve** for both providers, so it means
>   what its name implies. **Gate confirmed nothing reads it as logic input** — and, a correction
>   to the brief's premise, the Settings UI never rendered the field at all, so no UI change was
>   made. **Verified:** GH went `null` → `2026-07-20T14:47:44Z`; Fitbit correctly did **not**
>   move, because GH is the one serving.
> - **Length guard 6000 → 28000**, set above the real observed untrimmed total. Per-section
>   prompt lengths now log permanently; an exhausted-but-still-over state is a `console.warn`.
>   Hold PRs are re-attached when `exerciseHistory` is trimmed, so truncation can no longer
>   remove the progression signal. ~~**Verified: `trims: none` on a normal day** — briefs and full
>   exercise history now survive intact.~~ **⚠ STALE — CORRECTED 2026-07-25 (session #39 Phase 1
>   audit).** A real `auditOnly` run against profile 1 measures `_startedAt 28336` · `_total 26582` ·
>   `_budget 28000` · **`_trims "historicalBrief->400"`** — the first rung of the ladder **already
>   fires on a normal day**. The guard is still doing its job (the total lands under budget and
>   `exerciseHistory` survives intact at 2,903 chars, so the progression signal is not being cut),
>   but "trims: none" is not the measured reality and must not be relied on as headroom. Real
>   headroom is **1,418 chars**.
> - **`stripEmbeddedGoalsList()`** removes the stale prose GOALS list at assembly time, leaving
>   `goalPriorityContext` as the sole authoritative ordering. **Verified: zero `GOALS:`
>   occurrences** in the assembled prompt. Stored `ai_prompt_context` and `goals[]` untouched.
> - **Real duration targets**: user length choice → schedule → defaults (60/45/30/15), rounded
>   to 5-minute increments, floor 10, **±15% tolerance band** (a target, never an exact minute).
>   **Anchor days pin Option 1 to the anchor's own duration**, fixing the Tue/Thu 60-vs-45
>   collision. Verified: a 60 choice yields `[60, 45, 30]`.
> - **TIME BUDGET prompt block + post-parse `verifyRecTimeBudget()`** sharing ONE coarse
>   heuristic (~1.5 min/strength set incl. rest, ~1 min/mobility set, hold + ~1 min rest, stated
>   cardio as stated, +5 warm-up). Warn-only, never blocks, never auto-regenerates.
>   **Caught the exact complaint live**: Option 2 stated 45, estimated 25 → OUT OF BAND.
> - **Length + intensity controls** (Low/Medium/High), **ephemeral per-generation** (never
>   persisted), mounted in `renderAI()` directly above the reroll button (`#rec-controls`,
>   id-scoped CSS). These **replace the deferred temperature approach** as the mechanism that
>   makes regeneration vary.
> - **B12 hole closed**: `CARRY FORWARD` is now gated on *"Option 1 already claimed"* — anchor
>   **or** frequency target — mirroring the same underserved-target pick `buildScheduleInstruction()`
>   makes. The fallback NOTE also names the real claimant instead of printing "Flexible".
> - **Steps caption re-sourced** from `fitData.stepsSummary.date` — a field the server already
>   sent and the client discarded (`stepsSummary` appeared nowhere in `index.html`).
>   Provider-agnostic and self-correcting.
> - **Sectioned rec output.** Options now carry a flexible ordered `sections[]`
>   (`{label, minutes, exercises[]}` — Warm-up / Main / Add-on, **emit only what applies**) with
>   per-section minutes; the option's top-level `duration` + band remains the source of truth.
>   `renderAI()` renders section headers; **legacy flat cached recs render byte-identical** via
>   the `recOptionSections()` / `recOptionExerciseStrings()` normalizers. The verifier's
>   **warm-up double-count is fixed** — no flat +5 when a Warm-up section already exists, which
>   is why all three options had flagged over-band on the prior run.
>   **Verified live via a real reroll**: durations `[45, 35, 25]`, section sums `45/35/25`,
>   **all three IN BAND, zero warnings**, no empty sections, no placeholder filler, no
>   per-exercise times.
>
> **DECISIONS DELIBERATELY DECLINED (recorded so they don't resurface):**
> - **Temperature pin for `daily_recs`** — deferred, and now likely unnecessary: length +
>   intensity give explicit, user-controlled variety. It must **never** be set to 0 ("Show me
>   different options" would return an identical rec every reroll). Target ~0.65 if revisited.
> - **Goal schema restructure** — declined. The drift is stale `ai_prompt_context` prose, not a
>   schema flaw; the `goals[]` array order is already a clean priority source.
> - **Per-exercise time estimates** — declined. Section-level granularity only; per-move times
>   manufacture false precision on data the app does not have (no rest intervals, no tempo).
> - **Mandatory 3-section structure** — declined. Sections are flexible; a 30-minute run is one
>   section (Shimmy, 2026-07-20). Forcing a fixed set would repeat the `format_notes`
>   "None provided" filler trap (§9), where mandating a section made the model pad it.
> - **Server-side steps normalization** (making both providers mean the same calendar day) —
>   declined for this scope. It's a provider-behavior change and belongs to its own item.
> - **Wiring the re-merge endpoint into `PATCH /api/workouts/:id`** — still declined. It turns
>   an admin recovery tool into a hot path and needs its own sign-off.
>
> **2026-07-19 session #30** (Exercise-row data loss — root-caused, stopped, and recovered;
> plus temperature app-wide. Audit-report-first, gated approval at every step):
> - **Root cause (silent data destruction, ~3 months):** `exercises.duration_minutes` was an
>   **integer** column, but the `extract-exercises` prompt's own MANDATORY DEAD HANG RULE
>   explicitly instructs fractional minutes (`30s`→0.5, `45s`→0.75, `1:42`→1.7). Postgres
>   rejected every such INSERT; the per-row loop (`server.js` ~3377) logged to `console.error`,
>   **continued**, and the endpoint still returned `success:true`. The row was destroyed and
>   neither client nor user ever learned. **Evidence:** across profile 1's 269 rows, 59 carried
>   a duration and the distinct value set was `{1,2,5,10,20,23,30,35,40,60}` — **zero
>   non-integer values had ever survived.** The more correctly the extractor obeyed its own
>   mandatory rule, the more reliably the row was destroyed.
> - **Quantified loss:** **23 high-confidence rows across 17 workouts** (12 of them Dead Hang,
>   the most-tracked exercise in the account, subject of two active micro-goals). Library
>   showed Dead Hang at 46× logged; true figure was higher.
> - **Fixed, in this order (ordering mattered):** (1) `5deede2` surfaced per-row failures
>   (`attempted`/`failed`/`partial_failure`/`failures[]` + `insert_failed` per entry +
>   `classifyInsertFailure()`); (2) migration `2026-07-19_exercises_duration_numeric.sql`
>   integer→`numeric(6,2)` — **RUN IN PRODUCTION 2026-07-19**, verified before/after
>   (`integer/32/0` → `numeric/6/2`); (3) `dbf3a02` client-side inline warning on the affected
>   workout card. Had the migration run first, recovery would have destroyed the same rows again.
> - **Temperature — separate, larger finding.** `callAI()` sent **no temperature at all**; the
>   word appeared nowhere in `server.js`. Every AI call in the app ran at the Anthropic default
>   (1.0). **Measured on workout 87: 4 identical extraction calls returned 3 DIFFERENT results
>   (7 / 8 / 4 / 8 rows); at temperature 0, 4 identical calls returned 1 identical result.**
>   Fixed: `callAI()` gained an optional temperature arg (omitted → unchanged for every other
>   caller); `extract_exercises` passes 0 (`aaf7252`); `CALL_TYPE_TEMPERATURE` pins
>   `workout_title`/`format_notes`/`goal_estimate`/`schedule_builder` to 0 in the `/api/ai`
>   proxy with the same authority as model selection (`0fefbd6`). `daily_recs`, `coach_chat`
>   and the prose/planning writers deliberately left at default — variety is a feature there.
> - **`readiness` is NOT affected**: `computeReadiness()`/`estimateSleepScore()` contain zero
>   AI calls — pure Formula V3 arithmetic. Same biometrics always produce the same score.
> - **Recovery — merge, never delete** (`aaf7252`): `POST /api/debug/remerge-workout-exercises/
>   :profileId/:workoutId` (admin-gated, **dry-run by default**, `&apply=1` to write). Keyed on
>   `(workout_id, catalogNormKey(name))`: absent→INSERT, differing→PATCH in place, equal→no-op,
>   **not-reproduced→KEPT and reported, never deleted.** Delete-then-reinsert was designed,
>   then **rejected on evidence** — at default temperature re-extraction was non-deterministic,
>   so a delete pass could have destroyed real rows to fix fewer. Not atomic, and says so:
>   PostgREST has no multi-statement transaction, so instead dry-run default + full `before`
>   snapshot returned as a manual reversal basis + `stop_on_error`.
> - **Recovery executed and verified (all 17 workouts):** applied one at a time, each dry-run
>   checked against its approved projection before writing; **zero divergence, zero failures.**
>   **269 → 297 rows.** Fractional-duration rows persisting: **0 → 22**. Dead Hang **46 → 57**.
>   **Zero duplicates** across all 17. Idempotency proven: a second `apply=1` on workout 106
>   was a complete no-op (7 no-ops, 0 writes, identical row ids).
> - **Not recovered (accepted collateral, 3 rows):** wid 106 `Figure-4 Stretch`, wid 72
>   `Elliptical` + `Indoor bike`. Cause is the extraction prompt over-applying its
>   "don't extract stretches/warm-ups" rule — inconsistently, since `Figure Four Stretch` IS
>   recovered on wid 42. Prompt fix queued separately (§7).
> - **10 rows flagged for review, deliberately preserved, resolution deferred to the user:**
>   1 rename (`Hip Rotation` vs incoming `90/90 Hip Rotation`, wid 12), 8 genuine orphans whose
>   source line no longer exists in the notes (wid 18 ×3, 71 ×2, 83 ×2, 99 ×1), and wid 83
>   `MMA Class` (still in the notes; the model consistently declines to treat a class as an
>   exercise). See §6.
> - **A3 diagnostic — stale extraction, NOT fabrication.** Workout 106's `raw_text` matched the
>   current notes on all 6 rows except the sets digit (`3x`→`2x`). Traced to a re-log of workout
>   99 (whose notes read `3x15`), extraction, then a post-save notes edit; `PATCH /api/workouts/:id`
>   never re-extracts. **The `workouts` table has no audit trail** (no `created_at`/`updated_at`;
>   `ts` is client-supplied, overwritten on every edit, and shows a systematic ~300-minute offset
>   from DB-side `created_at`) — so this required structural inference, not a lookup. See §9.
> - **`format_notes` at temperature 0 — measured, partial fix.** Output is now stable (1 distinct
>   result across 3 identical calls) and the stray markdown `#` heading is gone. **But `Notes:` /
>   `None provided` REMAIN** — reproducibly, because the prompt itself mandates that section.
>   The render bug needs a prompt change too, not just temperature. See §9.
>
> **2026-07-19 session #30, part 2** (Progression: the recs could not get harder over time.
> Audit-report-first, gated at every step):
> - **Reported symptom:** "the recs don't get harder." **Confirmed — and the cause was NOT
>   truncation**, which was the standing assumption. Even at full length the prompt had no
>   baseline to progress from. Four independent causes, found by assembling the real prompt
>   from the real builders against live data:
>   1. **Roadmaps never entered the prompt at all.** Zero `roadmap` references in `fetchAI()`
>      or any of the 8 prompt builders. `weekly_targets[]`, `completion_signals[]`,
>      `exercise_gaps[]` — all generated, adapted weekly at real cost, rendered on the Profile
>      tab, and invisible to the coach.
>   2. **`buildExerciseHistory()` read only `best_weight`** — which is `null` for every
>      bodyweight/hold exercise this athlete does. A real 2:00 Dead Hang PR sat unused in
>      `best_duration_seconds` in the payload the client already had.
>   3. **Completed milestones were filtered out entirely** (`mgIsComplete`), so *hitting* a
>      target deleted the only progression signal in the prompt.
>   4. **The 7-day log carried no duration**, so recent hold performance was invisible.
> - **Fixed (B33a-d):** PERSONAL BEST clause reading `best_duration_seconds`/`best_reps`;
>   duration added to the recent log; achieved milestones now render as **BASELINES to work at
>   or above** with a progression instruction anchored to the achieved value; a
>   milestone-complete CTA in the Profile tab asks the athlete to set the next tier.
>   **Deliberately NOT auto-escalated** — some goals are open-ended, some are terminal rehab
>   targets. Before: `- Dead Hang: 58x logged, last 2026-07-19 1s`. After:
>   `- Dead Hang: 58 sessions logged, last 2026-07-19 (1 set) — PERSONAL BEST: 2:00 hold (120 seconds)`.
> - **Unit ambiguity (B33b) — three issues, not one.** Sets rendered as `<N>s`, so a 1-set Dead
>   Hang read as `1s` (one SECOND) on an exercise measured in seconds. Reps were `<N>r`. And a
>   `daily_habit` compared a DAY count against a minutes target (`56/2 Minutes`). All spelled
>   out, with `nUnit()` for correct singular/plural (the streak line had been rendering
>   `1 days` on every single-day streak).
> - **Roadmap emphasis (B33e) — the regex parser was built, tested and REJECTED.** Parsing
>   `weekly_targets` prose by pattern leaked session counts ("3-4 strength sessions") and
>   silently ate the three most actionable targets in the roadmap because `weighted` /
>   `bodyweight` matched a weight-tracking filter. Replaced with **Sonnet extraction into a
>   structured `roadmap.phases[].emphasis` field** (`ROADMAP_EMPHASIS_SYS`), cached once per
>   roadmap change, self-maintaining via `backfillMissingEmphasis()` after generate and adapt,
>   and emitted natively by both generation prompts. 9/9 phases backfilled, 0 failures.
> - **`buildRoadmapEmphasisContext()` wired into the prompt** between GOAL PRIORITIES and
>   ACTIVE CHALLENGES. Injects **emphasis only, never session counts** — the schedule owns
>   frequency and tracks it with real status (`0/1 [NEEDED]`), roadmap targets carry competing
>   counts with no status tracking at all. **Verified live:** all three generated options named
>   the phase they acted on in `goal_reasoning`, and all three programmed Dead Hang at the
>   proven `1×120 sec` floor with `+5-10s` progression — the ACHIEVED baseline driving real
>   prescriptions.
> - **Roadmap adaptation could not re-evaluate a phase PREMISE (D8).** Build Muscle sat in a
>   phase named "Progressive Overload (Paused)" whose first target began "Once training
>   resumes:" for weeks after training resumed. Four structural causes; all addressed — adapt
>   moved **Haiku → Sonnet** (measured ~0.39M input / 0.31M output tokens per YEAR, a few
>   dollars), **DATE ROLLOVER + PREMISE VALIDITY** checks added to the adapt prompt with the
>   conservative bias sentence kept verbatim, **`buildWeeklyReviewContext()`** replacing the
>   literal "(no notes)" string with computed evidence including a RESUMPTION SIGNAL, and
>   **`enforceSingleCurrentPhase()`** as a deterministic code invariant after adapt and generate.
> - **Two phases marked `current` on Fix Posture (D7)** — not a race (adapts 8 days apart). A
>   phase whose window expired by DATE stayed `current` because its `completion_signals` were
>   never met and the prompt had no date rule. Data corrected; invariant now enforced in code.
> - **Bugs found by verifying rather than assuming:** the per-goal roadmap prompt never
>   required `name` or `duration_weeks` (older roadmaps carried them by luck; adding emphasis
>   shifted attention and the model emitted `title`/`duration:"Weeks 1-5"` instead) — fixed
>   with an explicit JSON skeleton; the adapt prompt returned `duration_weeks: "4-6"`, a string
>   range whose `Number()` is NaN, collapsing every phase to today with no `end_date`; and
>   `?mode=regenerate` had to be added because the route hardcoded `"reset"`, which would have
>   wiped v5 and five adaptation entries.
> - **Hygiene:** `callAI()` and `callAISystem()` had **no timeout at all** — and
>   `extract-exercises` runs `callAI` on every workout save. Real `AbortController` added
>   (20-60s by model/output size). `max_ops` failed OPEN (`opCount > NaN` is always false).
>   Dead `goal_estimate` mapping dropped.
> - **DECLINED, with reasons** (so they don't resurface): (1) the regex emphasis parser —
>   unfixable in principle, patching `/weigh/` just relocates the failure; (2) shipping
>   `exercise_gaps` in the rec block — only 1 of 5 was free of session counts or non-training
>   content; (3) auto-generating the next milestone tier — wrong for terminal rehab targets;
>   (4) fixing the 6,000-char trim ladder as a progression fix — it was demoted once measurement
>   showed truncation was not the cause; (5) wiring up `goal_estimate` — dropped instead, no
>   feature wants it.
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

Supabase/Postgres. IDs on `profiles` and most child tables are `bigint`. **⚠ Correction (2026-07-22): `micro_goals.id` is an INTEGER, not a `uuid`** — verified against live production rows (ids `1` and `2`, returned as JSON numbers). This doc and `CLAUDE.md` both previously stated `uuid PRIMARY KEY DEFAULT gen_random_uuid()`, and the Engine v2 Phase 1 audit repeated the claim from them; all three were wrong. The uuid DDL still shown in `CLAUDE.md`'s "Supabase setup" snippet is historical and must not be used to recreate the table.

### `profiles`
Core user record. PIN-protected, all child data scoped by `profile_id`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint PK | |
| `name`, `pin`, `avatar_color` | text | `pin` is sha256-hashed |
| `profile_data` | jsonb | goals, injuries, schedule, equipment, `ai_prompt_context`, `onboarding_complete`, `avatar_image`, `settings.*`. **Long-term goals live here at `profile_data.goals[]` — there is no separate `goals` table.** Each goal carries `id` (uuid, backfilled by `ensureGoalIds()` on every profile GET) and, once a Living Goal Roadmap is built: `intake_questions[]` (`{question,key}`), `intake_answers[]` (`{question,key,answer}`), `intake_completed` (bool), `roadmap{}` (structured — `timeline_range`, `timeline_note`, `date_confidence`, ~~3 `near_term` + 2 `horizon`~~ **a VARIABLE number of `near_term` + `horizon`** `phases[]` since PT Brain Session A, `version`, `adaptation_log[]`; full shape in §7 + `CLAUDE.md`), `last_adapted_at` (ISO ts). **PT Brain additions (all additive jsonb, no DDL):** `goal_type`, `demand{}`, `estimate{}`, `tier`, `arc_transition_at` on the goal; `roadmap.estimate{}`, `roadmap.arc_state{}` and the immutable `roadmap.arc_origin` on the roadmap. Sibling keys `profile_data.capacity{}` and `profile_data.coexistence{}` live at the top level. Sanitized via `cleanProfileData()` on read+write (recursive and type-preserving, which is why the new nested keys survive). |
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
| `id` | **integer PK** | ⚠ **NOT uuid** — corrected 2026-07-22 against live data (see the section header). |
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
- `migrations/2026-07-22_v2_training_tables.sql` — **⚠ NOT RUN.** Engine v2: creates `training_blocks` + `planned_sessions` (RLS + `service_role_bypass`, `UNIQUE(profile_id,date,slot)`, partial unique index enforcing one active block per profile, `planned_sessions.workout_id` FK `ON DELETE SET NULL` so deleting a logged workout cannot erase the record that the session was planned). New tables only — no existing table touched. Nothing in Phase 2 reads them; needed from Phase 3 (planner) onward, so applying early is safe and inert.
- `migrations/2026-07-22_v2_profile_columns.sql` — **⚠ NOT RUN.** Engine v2: adds `profiles.v2_daily_cache` (jsonb) + `v2_daily_cache_date` (date) + `dossier` (jsonb) + `dossier_updated_at` (timestamptz). Deliberately NOT reusing `daily_recommendations` with an engine marker — see the §7 Engine v2 section. Invisible to v1 (`PROFILE_SELECT_BASE` is an explicit list and no `select=*` on `profiles` exists anywhere).
- `migrations/2026-07-22_v2_workouts_session_effort.sql` — **⚠ NOT RUN.** Engine v2: adds `workouts.session_effort` (text, nullable) + CHECK (`more_in_tank`|`about_right`|`brutal`). The one Phase 2 migration touching a shared table; additive and nullable. **No endpoint change is needed** — `POST /api/workouts` and `PATCH /api/workouts/:id` forward `req.body` verbatim to PostgREST, so the column is writable the moment it exists.
- `migrations/2026-07-22_v2_profile4_tiers_and_schedule_v3.sql` — **✅ RUN.** Engine v2 Phase 3: sets profile 4's goal tiers (2 drivers), `profile_data.schedule_v3` (`fill_policy`/`anchor_meta`, sibling of `schedule` so v1's `loadSchedule` reconstruction can't strip it) and `defaults`. Profile-4-scoped, idempotent.
- `migrations/2026-07-22_chat_proposals_v2_types.sql` — **⚠ NOT RUN.** Engine v2 Phase 7: adds `modify_planned_session`/`skip_planned_session`/`set_standing_preference` to `chat_proposals.type`'s CHECK. The Coach Chat propose→confirm→apply cycle for v2 session edits is gated on this — refusals and the read-side work without it (they never insert), but a valid session-edit proposal 23514-fails until it runs.
- `migrations/2026-07-22_clone_p1_to_p4_{wipe,copy,flags,verify}.sql` — **✅ RUN IN PRODUCTION 2026-07-22, verified.** Not schema migrations: a 4-file **data** operation seeding profile 4 (the designated Engine v2 test profile) with a clone of profile 1's training history. Run order is **verify §A (baseline) → wipe → copy → flags → verify §B–E**. Profile 1 is read-only throughout; wearable credentials/connections, `rejected_wearable_matches`, `dismissed_fitbit_activities`, chat tables and identity fields are all deliberately **not** copied, `workouts.wearable_activity_id` is forced NULL (UNIQUE partial index), the v1 rec caches are cleared, and the 6 malformed-date workouts (§6) are skipped. Cloned rows use a deterministic `+100000` id offset, so the pair is re-runnable; the copy script **aborts** if profile 4 is non-empty. Its `setval()` section is **mandatory** — skipping it eventually collides the shared identity sequences with profile 1's real inserts. **Verification result:** §B row parity OK on all 8 tables (workouts 76 vs 82 — the 6 malformed-date rows correctly skipped, everything else exact); §D 310 exercise rows / 69 distinct names / 65 distinct workouts / 0 null `workout_id`, FK check and both leak checks returned no rows; §E1 PASS on all 8 tables (profile 1 unchanged); §E3 profile 1 untouched, profile 4 correctly flagged. Baseline also corrected two API-derived figures: `daily_steps` and `daily_sleep` are **736** rows each (the REST endpoint had clamped steps to a 365-day window, and no listing endpoint exists for sleep at all), and `daily_checkins` is 12.

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
- Found live here, **✅ fixed 2026-07-19 (session #30)**: `exercises.duration_minutes` silently failed to insert for non-integer values — the column was `integer`. Widened to `numeric(6,2)` and the destroyed rows recovered. See §6.

### Goals & Milestones
- **6 goal types** — strength, distance, consistency, habit, skill, general
- **AI estimate scoring** per type; manual override (✏️) on every card
- **Auto-update on workout save** across all mutation paths
- **`last_computed_at`** timestamp on all goal cards; auto-refresh on workout save (`70dfa46`, `7c50f4d`)
- **Goal priority** — drag/arrow reorder, weights AI recs (#1 ~40% / #2 ~25% / #3 ~15%)
- **Living Goal Roadmaps + Macro Roadmap (backend)** — per-goal AI intake → phased roadmap (~~3 `near_term` + 2 `horizon`~~ **variable phase count since PT Brain Session A; MACRO is still 3+2**, Sonnet) and a structured `roadmap_data` macro roadmap tying all goals together. Both are grounded in the athlete's real logged training via `getGoalExerciseContext()` / `getFullExerciseContext()` and adapted weekly by the unified `maybeAdaptAllRoadmaps()` (**per-goal adapt runs on Sonnet since session #30; the macro adapt is Haiku** — this bullet previously said Haiku for both). `progress_pct` is computed on read (`computePhaseProgress()`, capped at 90), never stored — **superseded by earned position on new-shape per-goal roadmaps** (§7). Per-goal roadmap UI built (2026-05-26) and macro-roadmap UI built (2026-05-29) — see the next two bullets. (`b477682`, `bc46c57`)
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
| GET | `/api/debug/google-health-probe/:userId` (`?date=&allow_refresh=1&raw=1`) — **read-only by default**; returns token state + the UNSWALLOWED per-leg outcome for all 6 GH metrics with real HTTP status, plus `would_serve_google_health` (mirrors `/daily`'s `hasData` gate). `allow_refresh=1` is the only writing path. See CLAUDE.md → "Google Health Failure Propagation" |
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
| POST | `/api/debug/remerge-workout-exercises/:profileId/:workoutId` — **DRY RUN by default**, `&apply=1` to write, `&max_ops=N` (default 50), `&stop_on_error=0` to continue past a failure. Re-extracts ONE workout and MERGES into its existing `exercises` rows, keyed `(workout_id, catalogNormKey(name))`: absent→INSERT, differing→PATCH in place, equal→no-op, **not-reproduced→KEPT and reported, never deleted**. Idempotent (extraction runs at temperature 0). Returns the full plan, the complete `before` snapshot as a manual reversal basis, and `possible_near_duplicates` for human review. **NOT atomic** — PostgREST has no multi-statement transaction; see the session #30 banner. |

---

## 5. Wearable Provider Status

| Provider | Status | Notes |
|----------|--------|-------|
| **Fitbit** | ✅ Fully implemented | OAuth2 + auto-refresh, list/detail/TCX/intraday HR, full normalization |
| **Google Health (API v4)** | ✅ Implemented (biometrics only) | Google Health API v4 (cloud REST). OAuth2, HRV, RHR, sleep stages, steps, AZM, weight, exercise activities. Fitbit + Pixel Watch supported. **September 2026 deadline** for full Fitbit migration. (`2026-05-26`) |

| **Apple Health** | 🔲 Stub (TODO) | Needs iOS companion app pattern + Apple Developer account |
| **Samsung Health** | 🔲 Stub (TODO) | Galaxy devices via Samsung Health Data SDK |
| **Garmin** | 🔲 Stub (TODO) | Public API, **OAuth 1.0a** (differs from Fitbit's 2.0) |

> **⚠ Scope of the "GH is preferred" claim (corrected 2026-07-20, session #31).** GH is preferred over Fitbit in **`GET /api/profiles/:id/daily` ONLY** — and even there the preference is conditional on GH returning data for the `hasData` gate (hrv/rhr/sleep/steps), with sleep additionally falling back to Fitbit per-metric. Every other wearable path is still Fitbit-first or Fitbit-only:
> - `findWearableMatchOnSave()` tries **Fitbit first** and only reaches GH when there is no Fitbit connection at all — and `getValidWearableToken()` short-circuits Fitbit to the legacy `profiles.fitbit_*` columns, so on a profile with those populated GH is **never asked**. This, not a GH failure, is why profile 1 has 44 Fitbit-prefixed workouts and zero `google_health` ones.
> - `life-os-summary`'s live fallback is **Fitbit-only** — no GH branch exists in that endpoint at all.
> - `runFitbitBackfill()` and `backfill-wearable-history` are **Fitbit-only**; there is no GH historical backfill (§7).
>
> **Consequence for the Sept-2026 cutover — this reframes the remaining work.** The activity/matching side has **no Google Health implementation in practice**. Biometrics already run on GH today and will survive the Fitbit shutdown untouched. Workout auto-matching, the unmatched-activities card, and all historical backfill will **not**. The hard half of the migration is therefore an **activity-side GH build**, not a user reconnect campaign — see §7.

> **Universal API note:** On Android, **Google Health Connect** can unify Google/Samsung/most
> Android-14+ device data — activating one Health Connect adapter may cover multiple providers
> without separate Samsung/Pixel integrations. "Open Wearables" (Railway, ~$5/mo) is a longer-term
> unified option covering Garmin/Whoop/Oura/Polar/Apple (via iOS app).

---

## 6. Known Limitations

> **⚠ 2026-07-24 (session #34): every Engine v2 item in this section is now HISTORY of a PAUSED
> arc, not an open work queue.** v2 remains in the repo, flag-gated off; nothing was reverted. Read
> **"Rejected Approaches & Lessons — Engine v2 arc"** at the end of this section before proposing
> any fix to a v2 limitation below — four approaches are explicitly rejected and must not be
> re-proposed. Current-state entry: **"Engine v2 arc PAUSED — current state of record"**, directly
> below.

- **Engine v2 arc PAUSED — current state of record (2026-07-24, session #34).** Recorded so the
  next thread does not misread the v2 sections as in-flight work.
  - **v2 code REMAINS in the repo, flag-gated off** (`profile_data.engine_v2`). NOT deleted, NOT
    reverted, NO tables dropped (`training_blocks`, `planned_sessions` and the v2 profile columns
    all remain, with their migrations still applied). Preserved for possible future reference.
  - **Profile 4 was NOT flipped this session.** The revert audit/execution was scoped, then the
    athlete chose to pivot to forward design instead. **Honest current state: profile 4 is still
    `engine_v2 = true`, still carrying the cloned training history and the v2 writes** (blocks,
    planned sessions, `v2_daily_cache*`, `dossier*`, goal tiers, `schedule_v3`, `v2_preferences`).
    The nightly job and the v2 UI therefore still apply to it. **Formally decommissioning v2 —
    flipping the flag, deciding what to do with the v2 rows/tables — is a separate future task with
    its own scope**, deliberately not started.
  - **Profile 1 and every non-flagged profile are unaffected** and always were — v1 byte-identical
    throughout the arc, re-verified at every v2 session.
  - **The queued v2 work (B advancement, D within-phase ramp, the session-composition settings UI)
    is PARKED**, not cancelled, but is **no longer the next thing to build**. B's hard prerequisite
    (threshold plausibility) still stands if the arc is ever resumed.
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
- **✅ RESOLVED 2026-07-19 (session #30) — `exercises.duration_minutes` non-integer insert failure.** The "likely root cause" guessed below was **correct**: the column was `integer`. Confirmed by the pre-migration `information_schema` check (`data_type=integer, numeric_precision=32, numeric_scale=0`) and by the value distribution (59 rows with a duration, distinct set `{1,2,5,10,20,23,30,35,40,60}`, **zero** non-integer values ever stored). Fixed three ways, in order: per-row failures are now reported (`5deede2`), the column was widened to `numeric(6,2)` (`migrations/2026-07-19_exercises_duration_numeric.sql`, **run in production 2026-07-19**), and the affected workout card now shows an inline warning (`dbf3a02`). **23 destroyed rows across 17 workouts were quantified and 20 recovered** via the re-merge endpoint — see the session #30 banner and §9. Fractional durations now persist (22 rows as of close-out). The `strength_milestone` `parseDurationToSeconds(raw_text||notes)` workaround noted below was indeed built around this bug; it can stay (harmless, and `raw_text` remains the more faithful source), but it is no longer load-bearing.
- **10 recovered-workout rows are flagged for manual review, deliberately preserved (session #30).** The re-merge wrapper never deletes, so a row the re-extraction didn't reproduce is kept and reported rather than removed. Three categories: **(a) 1 rename** — wid 12 has both `Hip Rotation` (old) and `90/90 Hip Rotation` (new); `catalogNormKey` does not collapse them (`hiprotation` vs `90/90hiprotation`), so both coexist until resolved. **(b) 8 genuine orphans** whose source line no longer exists in the notes — wid 18 (`Thoracic Spine Extension`, `Hip Flexor Stretch`, `Shoulder Blade Retraction`), wid 71 (`Thoracic Spine Extension`, `Shoulder Blade Mobility`), wid 83 (`Hip Flexor`, `Shoulder`), wid 99 (`Lumbrical Pinky Isolation` — the only one carrying real set data, 3×12). These are real sessions recorded before a notes edit; deleting them would lose history. **(c) `MMA Class`** (wid 83) — still present in the notes as `**MMA Class — 60 minutes**` but the model consistently declines to extract a class as an exercise (4/4 runs). **Resolution is a user decision, not an auto-action.**
- **3 destroyed rows were NOT recoverable (session #30, accepted).** wid 106 `Figure-4 Stretch`, wid 72 `Elliptical` and `Indoor bike`. The extraction prompt's "Do not extract stretches, mobility work, or warm-ups…" rule is over-applied — and inconsistently, since `Figure Four Stretch` **is** extracted for wid 42. Prompt-level fix queued in §7; not a merge-wrapper defect.
- **The `workouts` table has no audit trail (found session #30).** No `created_at`, no `updated_at` — the full row is `id, date, type, notes, done, mobility, med, ts, profile_id, wearable_data, wearable_activity_id` (confirmed; the endpoint uses `select=*`). `ts` is client-supplied (`Date.now()` in `saveWorkout`) and **overwritten on every edit**, so it is a last-write stamp, not a creation stamp — and it shows a systematic **~300-minute offset** from DB-side `exercises.created_at` across 42 of 43 workouts, making it unusable for ordering. Consequence: "were these notes edited after extraction ran?" could only be answered by structural inference (`raw_text` vs current notes), not a lookup. Adding `created_at`/`updated_at` is queued in §9.
- **5 pre-existing rows had a `sets` value replaced with `null` during recovery — verified correct, recorded for transparency (session #30).** wid 71 `Push-Up`, wid 39 `Clamshell`, wid 32 `Dead Bug` + `Cat-Cow`, wid 18 `Push-Up`. In each case the notes genuinely state no set count (`"Push-ups - 10"`, `"Clamshells - 15 reps each side"`, `"Dead Bugs - 10 each side"`), so `null` is the faithful value and the prior number was stale. **One debatable case:** wid 18's `"Push-ups - 12 and then 4. Couldn't get to a full 12 for the second set"` arguably describes 2 sets; the extractor's own "omit when ambiguous" data-integrity rule produced `null`. Defensible, but flagged rather than buried.
- **`exercises.duration_minutes` silently fails to insert for non-integer values — found live 2026-07-16, NOT fixed (out of scope for the exercise-canonicalization session that discovered it).** Reproduced directly: logging a Dead Hang or Plank with a whole-number duration (e.g. "1 minute") inserts fine; the identical save with a fractional duration (0.75 for "45 seconds", 0.5 for "30 seconds") returns `count:0` from `POST /api/profiles/:id/extract-exercises` — the row is silently never written, no error surfaced to the client or logged distinctly from a normal skip. This is unrelated to the exercise-catalog work (catalog resolution never touches `duration_minutes`) but directly contradicts the extraction prompt's own hardcoded Dead Hang rule, which explicitly instructs fractional-minute values ("45 seconds → 0.75"). Almost certainly explains the pre-existing `CLAUDE.md` caveat that `strength_milestone`'s time-based tracking "prefers `parseDurationToSeconds(raw_text||notes)` over the often-mis-populated `duration_minutes` column" — that workaround was likely built around this exact bug without ever finding the root cause. **Likely root cause** (not confirmed — would need direct schema access to verify): `exercises.duration_minutes` is probably typed as an integer column in the live database, despite the app-level code and multiple docs treating it as free-precision numeric. **Fix, not attempted this session**: either a migration to widen the column to `numeric`, or have `extract-exercises` round to the nearest whole minute before insert (lossy — would break sub-minute hold tracking, the opposite of what the Dead Hang PR feature needs) — a real design decision, not a one-line patch, and out of scope for the session that found it.

- **Google Health `/daily` serve is all-or-nothing except sleep (session #31).** The `hasData`
  gate is a single OR over hrv/rhr/sleep/steps. If GH returns only *some* metrics it still wins
  the gate and serves, and the missing metrics come back `null` **even when Fitbit has them** —
  only **sleep** has a per-metric Fitbit fallback (added session #23). A GH day returning steps
  only would therefore blank HRV/RHR/sleep on the Today card. Not observed in production yet;
  structural, found by reading the gate.
- **`getValidWearableToken()` returns a cached GH access token whenever `now < expires_at`, with
  no upstream validation (session #31).** Local "valid" ≠ accepted by Google. GH access tokens
  last 1 hour, so a revoked-but-unexpired token reads healthy until its next refresh. The
  probe endpoint reports this distinctly (`served_from: cache | refreshed | expired_not_refreshed`).
- **Historical `daily_sleep` / `daily_steps` rows written before 2026-07-20 cannot have their
  `source` corrected (session #31).** Nothing recorded which provider wrote them, so no backfill
  is derivable from the data — the mislabel is permanent for those rows. Provenance is
  **forward-looking only**. Recent rows are the ones most likely to be wrong, since GH has been
  the serving provider while every write was hardcoded `"fitbit"`.
- **The time-budget heuristic is coarse by design and over-estimates stacked sessions
  (session #31).** A cardio block plus accessory work sums additively — the live reroll's
  Option 3 estimated 34 min against a declared 25. The **section sum is the primary gate**; the
  per-section heuristic is only a loose `>2x` / `<0.5x` sanity check, and the whole verifier is
  warn-only. Tightening it would be false precision, not a better signal.
- **`format_notes` writes a literal `"Notes: None"` placeholder into the notes column when the
  raw notes are empty (session #32).** The Haiku `format_notes` prompt (temp 0) emits the
  placeholder string rather than leaving the field blank, so the *stored* content is junk even
  though the render is correct (`renderLoggedNotesHtml` trims + suppresses it at display time).
  This is a data-flow write bug, not a render bug — **needs its own audit session** before any
  fix (must not corrupt legitimately-empty vs. populated notes).
- **Notes-only logged workouts exist where `extract-exercises` never produced rows (session
  #32).** Real structured data is trapped in the free-text `notes` column with no corresponding
  `exercises` rows — confirmed on a genuine 2026-06-22 session whose notes contain
  `"2×10 single-hand Dumbbell Rows 22.5lb"` and similar, none of which were extracted. This is a
  **silent extraction miss**, distinct from session #30's insert-*destruction* (that was rows
  written then killed by the integer-column bug; this is rows never written at all). **Needs an
  audit**: is it a one-off or a pattern, and can a safe re-extract backfill the trapped data
  without duplicating rows that DID extract?
- **The `'other'` category bucket collects exercises with no `main_category` (session #32).** In
  the grouped History render, catalog-thin moves like `Tabletop Lumbrical Curl` and
  `Pinky Abduction` fall into an `'other'` group because they carry no category. This is a
  **catalog data-completeness gap, not a code bug** — the grouping logic is correct; the source
  rows simply lack a category to group on.
- **Digit/paren-containing catalog names strip to a miss and render as plain, non-clickable text
  (session #32).** `splitExerciseName` (and the server `stripExerciseAnnotation` cut rule it
  mirrors) cut at the first digit/`@`/`(`, so a legitimate name like `"90/90 Hip Rotation"`
  strips to empty → no exact/alias match → not clickable. **Accepted parser limitation** — the
  same conservative rule is what guarantees a link is never a wrong match; the trade-off is a
  handful of digit-leading names stay plain.
- **✅ RESOLVED 2026-07-22 (Session 8) — all three Engine v2 close-out UX findings closed, verified
  live on profile 4 (real `v2_daily_cache` written through the new flatten boundary), profile 1
  byte-identical.** The findings were logged 2026-07-22 post-Phase-7 from live production
  screenshots; fixed in Session 8 alongside the alternate chip surface. Original text kept below.
  1. **Non-set-based segments as fake single sets — FIXED at the flatten boundary
     (`flattenExercise`, `server/v2Planner.js`).** A duration block now renders as
     "Yoga — 15 min", never "Yoga — 1 sets, 900s". Two signals drive it, because the model does
     NOT reliably type time work with a duration-based SEGMENT type — a yoga block was seen typed
     `skill` as well as `mobility`: (a) the parent segment type is time-based
     (`mobility`/`steady_state`/`active_recovery`/`sprint`/`interval_*`), OR (b) the exercise
     itself carries only a duration (a `time_seconds`, no reps, ≤1 set). Genuine multi-set work
     (sets≥2, or any sets×reps) is untouched, byte-identical. Applies to the primary AND every
     alternate (one boundary). The segment-type-only first cut was insufficient and was caught by
     the live re-run — see CLAUDE.md.
  2. **Doubled superset-rest parens — FIXED at the single composition site
     (`wrapRest`, `server/v2Planner.js:703`).** The inner "(between supersets)" is model-authored
     text inside `ex.rest`; the outer "(rest …)" is code, so wrapping produced the nested pair.
     `wrapRest` now unwraps a fully-wrapped value, strips a leading "rest", and demotes any inner
     parenthetical to ", …" → "(rest 90 s, between supersets)". A plain value ("90 s") passes
     through unchanged, so set-based output stays byte-identical. Covered by unit tests; not
     observed in the two live runs (no superset segment was generated), so the live screenshot of
     the fixed form is still pending a run that produces one.
  4. **v2 Today action buttons — styling pass DONE.** `.v2-var-go` moved off the Cornerman/AI
     token (it is an action control, not AI-generated content) onto a secondary/ghost treatment.
     The fully-ember session card and the "← Back to today" ghost link were deliberately left as-is
     (established v2 "coached primary" identity, not slop). All new CSS scoped under `#v2-today`.

  Original 2026-07-22 finding text (kept for the record):
  1. **Non-set-based segments render as fake single sets.** A `mobility` / `steady_state` /
     `active_recovery` segment that carries only a duration (a yoga block, a steady ride) renders
     through the discrete-exercise phrasing — e.g. "Yoga — 1 sets, 180s" — inherited from the
     sets×reps renderer. It should read as a duration block ("Yoga — 3 min"), not a fabricated
     single set. This is a **renderer / flatten-boundary bug** (`flattenExercise` in
     `server/v2Planner.js` and/or the `#v2-today` section render in `public/index.html`): those
     segment types need **segment-type-aware formatting** rather than the universal
     `sets/reps/time_seconds` template.
  2. **Doubled parenthetical in superset rest strings.** Variant output rendered
     "(rest 90 s (between supersets))" — nested parens from a string-template composition bug in
     how a superset segment's rest annotation is assembled. Not intentional copy; a **formatting
     bug** in the superset rendering path.
  4. **v2 Today card action buttons need a styling pass.** The bottom action button(s) on the v2
     Today card read inconsistently with the rest of the design system per live screenshot review.
     **UI polish** only.
- **Engine v2 Session 8 — deferred follow-ups (logged, not blocking):**
  1. **`dur_60` `noop_extend` alternate is dead weight in the cache.** Extending a session isn't a
     mechanical inverse of compression (adding volume is a judgment the code won't fake), so the
     "longer" alternate is just the primary relabeled — its real duration equals the primary's
     (**re-confirmed live 2026-07-24: labeled "60 min (primary as-is…)" while `session.duration_min`
     is 45**). Session 8 suppressed it from the chip row; **Session 12's folded-card layout carries
     the same suppression forward** (`v2VisibleAlternates`, unit-tested), so it is still never shown.
     The nightly still *writes* it into `v2_daily_cache.alternates`. Harmless (hidden, small), but
     the nightly could stop persisting a `noop_extend` at all (`v2BuildAlternates`, `server.js`) as
     a minor cleanup.
  2. **Superset double-paren fix has no live screenshot yet.** `wrapRest` is unit-tested, but
     neither Session-8 live re-run generated a `superset` segment, so the fixed
     "(rest 90 s, between supersets)" form hasn't been seen in a real cache. Confirm opportunistically
     on the next run that produces one.
  3. **Old-shape (`v:1`) caches are stale until a nightly re-run.** The flatten-boundary change bumped
     `v2_daily_cache.v` 1→2; `GET /api/v2/today` and the client treat a missing/older `v` as stale
     ("isn't ready yet"), so old-shape strings are never served. Profile 4 was force-re-run in
     Session 8; any other future v2 profile carrying a pre-deploy `v:1` cache self-heals on its next
     nightly run (or a `?force=1`).
- **Engine v2 Coach Chat: the model can pre-announce a proposal as "done" in its first stream leg,
  before the tool result is known (found + partially mitigated 2026-07-22, Phase 7).** The
  coach_chat tool loop streams the model's leg-1 text to the client BEFORE the tool executes, so if
  the model opens with "Done — changed X" and the tool then fails or is refused, the false claim is
  already on screen. The persona now instructs the model to phrase changes as *proposals needing
  confirmation* (never "done"/"applied") and to correct itself if a tool result reports failure —
  which handles the common case and the follow-up leg. But it **cannot fully prevent** a pre-announced
  leg-1 claim, because that text is already streamed. The safety property is unaffected (a failed
  tool never writes and never renders a card — proven). A complete fix would buffer the model's text
  until after the tool result resolves, a change to the streaming flow deferred as not worth the
  latency/complexity for a cosmetic wording issue.
- **"Mix Focus" (ex-"Full Override") rec quality — user reports the recs under that mode "aren't
  what I want" (session #32, PARKED).** This is separate from the session #32 display rename
  (which changed only the label, not the `mode:'total'` logic). May need a look at how the
  prompt generates workouts in total-override mode. **Parked — not yet scoped.**
- **✅ RESOLVED 2026-07-22 (Phase 3.5) — all four Phase 3 output defects closed and re-verified on
  a fresh generation.** (1) The unsourced-history problem is fixed by `buildRecencyState()` +
  a SOURCING RULE in the planner system prompt — regeneration contains zero "22-day"/"post-gap"/
  "layoff"/"returning from" text. (2) The `time` unit ambiguity is fixed at the schema
  (`time_seconds`, always seconds; a timed block's length lives on the segment) — regeneration
  emitted 0 bare `time` and 11 correct `time_seconds`. (3) The missing time-budget verifier is
  now the `session_time_budget` invariant — all 7 sessions summed exactly on regeneration.
  (4) Silently-unprescribed tiered goals are now caught by `tiered_goal_prescribed`, which **fired
  on the real regeneration** and correctly caught the pinky-rehab goal being prescribed but never
  tagged. The four original entries are kept below for the root-cause record.
- **Engine v2 `session.segments[].exercises[].time` carries NO UNIT — the `duration_minutes`
  overload repeating itself in the new schema (found 2026-07-22, Phase 3 first real plan).** In
  the generated week, `Indoor Bike time=20` means twenty MINUTES while `Dead Hang time=30` and
  `Plank time=30` mean thirty SECONDS. Same key, same JSON type, no way for any consumer to tell
  them apart without name-matching the exercise — which is exactly the heuristic v2 was built to
  stop relying on. **This is a SCHEMA defect, not a prompt defect**: no wording makes one integer
  field mean two units. Fix is to split into `time_seconds` / `duration_min`, or carry an explicit
  `time_unit`. Must be resolved before the renderer (Phase 6) or the autoregulator (Phase 4)
  consumes segments, or both will inherit the ambiguity.
- **Engine v2 has no time-budget verifier; segment minutes drift from the stated session length
  (found 2026-07-22).** On the first real plan, 4 of 7 sessions disagreed with themselves: two
  were 5 min UNDER their stated `duration_min` and two were 5 min OVER (30-min cardio sessions
  whose segments summed to 35). v1 has `verifyRecTimeBudget()` for exactly this and v2 has no
  equivalent — the invariant set checks volume, spacing and anchors but never asks whether the
  session's own parts add up to its own stated length. Small in absolute terms, but it is the
  precise complaint that started the v1 time-budget work ("a rec labelled 45 minutes contains ~12
  minutes of work"), and it will compound once the autoregulator starts editing segments.
- **⚠ Engine v2 SESSION CONTENT THINNESS — root cause named, mechanism landed, content NOT yet
  cleared (Session 9, 2026-07-22). DO NOT close this entry.** The exact v1 complaint reproduced in
  v2: a session labelled 45 min holding ~18-25 min of real work. **Root cause, stated plainly: the
  `session_time_budget` invariant checked two MODEL-AUTHORED numbers against each other — that the
  segment `duration_min` values SUM to the session's `duration_min` — and never asked whether the
  prescribed exercises could plausibly OCCUPY those minutes. It was structurally satisfiable by an
  empty session (the anchor sessions pass with zero exercises), and it actively INCENTIVISED the
  padding it should have caught: the model inflated segment `duration_min` to satisfy the sum
  instead of adding work.** (This retroactively qualifies the Phase 3.5 note above that the
  invariant "is now the session_time_budget invariant — all 7 sessions summed exactly": summing
  exactly was never the same as being fillable.) It was planner-wide, not one bad generation —
  audited across the whole week (2 of 5 non-anchor sessions under a 70% work floor; the cat_swap
  alternate worst at 47%). The screenshot that triggered this was the **cat_swap alternate viewed
  via the Session-8 chip**, not the autoregulated primary — but the defect is real in both the
  planner and the variant path. **What Session 9 landed (all verified live, profile 4):**
  `estimateSegmentWorkMinutes`/`estimateSessionWorkMinutes` (`server/coachingRules.js`, mirroring
  v1's per-SET model so the two engines can't disagree); `session_time_budget` strengthened to ALSO
  require estimated work ≥ `SESSION_WORK_FLOOR` (0.70) × stated duration for non-anchor sessions
  (anchors excluded off the no-prescribed-work property, NOT a category string); a new
  `"regenerate"` severity that reuses the planner's existing 2-attempt cap (no new retry mechanism)
  then persists the plan **flagged** rather than looping or blocking the nightly; and a prompt
  reframe on the planner AND the variant that KILLED the "segments MUST sum" line (the direct
  padding incentive) and injected `renderWorkBudgetGuidance` — the model now optimises against the
  same function the code enforces. Confirmed the floor fires on variant output too (a live category
  swap flagged at 65%). **HONEST LIVE RESULT — why this stays OPEN:** on a forced full re-plan the
  mechanism worked end-to-end (regenerated on attempt 2, persisted flagged), and the two **cardio**
  days rebuilt to genuinely full (0.99, real bike+yoga time blocks) — but the model STILL under-fills
  **rehab/posture-dominant strength sessions** even after a regeneration attempt (3 of 5 non-anchor
  sessions persisted flagged at 0.44-0.55). The flag-and-persist makes those VISIBLE in the invariant
  report instead of silently passing — the durable win — but the regenerated week does not clear the
  floor, so per the Session 9 brief this entry is NOT closed. **Open follow-up / decision:** whether
  the 0.70 floor is too aggressive for legitimately light rehab/posture work (the per-set mobility
  estimate of 1.0 min may under-count setup/transition/breathing overhead on mobility-dense sessions),
  or whether the model should shorten those sessions to an honest length, or whether a rehab-specific
  floor is warranted. Not tuned this session (0.70 was the approved starting value; reported the real
  week's scores against it rather than tuning blind).
  - **⚠ REFRAMED 2026-07-23 (Session 11 audit — READ THIS BEFORE TOUCHING THE FLOOR AGAIN).** The
    thinness is a **missing phase-progression model, not a duration-labeling problem, and not because
    rehab/posture work is inherently low-volume.** Sessions 9–10 built the CORRECT measuring
    instrument (`estimateSessionWorkMinutes` + the 0.70 floor) and pointed it at the WRONG root cause.
    The floor and estimator are right and STAY as-is — do not weaken, tune, special-case, or add a
    rehab-specific floor; every one of those hides the defect. **The real cause, confirmed against
    live profile-4 data + the persisted plan:** the planner is handed a goal name, a tier, a phase
    *label* and ≤4 prose `emphasis` bullets, and NOTHING actionable about how much work this phase of
    this arc calls for. The phase objects carry `weekly_targets` / `completion_signals` /
    `duration_weeks`, but none of those reach the planner, and none exist as a machine-readable
    volume/intensity envelope. So the model prescribes a thin, static, undifferentiated set of gentle
    movements (bodyweight 3×15/3×8 — it didn't even apply the "weighted glute bridges 10-20 lbs" its
    OWN emphasis named) and pads `duration_min`; the floor then catches the shortfall. Proof the
    thinness is not "correct low volume": the two thin days (51% / 44%) are driven by **`Build Muscle`,
    a DRIVER goal** — thinness tracks MODALITY (bodyweight/posture/rehab strength), not tier, so it is
    not a tier problem either. Phase advancement is purely calendar-based (`v2CurrentPhase` uses dates;
    `completion_signals` are evaluated by nothing), so the arc never gets harder. **The fix is the
    phase-aware prescription engine scoped in §7 (Session 11) — a code-enforced stage envelope sized
    to the slot, so a full session NATURALLY clears the floor.** When a goal genuinely cannot fill the
    slot at its stage, the stage's own fill expectation shortens the session deterministically — not
    the model padding, not the floor loosening.
  - **REJECTED (Session 10), logged so it is not re-proposed:** "honestly shorten the stated duration
    on light days," and the follow-up "fill the remainder with maintenance-tier work." Both hide the
    defect. Shortening the label to match thin content accepts a thin, undifferentiated prescription
    as correct when it is not — real PT/hypertrophy/endurance arcs fill 45–60 min and progress across
    weeks; the athlete confirmed doing genuine 45-min sessions in the early phase of this exact injury.
    Bolting maintenance filler onto a thin driver skeleton papers over the same gap. Shortening is only
    correct when it falls OUT of a stage's code-defined fill expectation (Session 11 proposal), never
    as a model-chosen relabel.
  - **A1 landed the evaluator (2026-07-23), NOT the fix — the entry STAYS OPEN.** A1 (the stage ladder,
    envelopes, and three-state exit-criteria evaluator; see `CLAUDE.md` → "Engine v2 — Phase-progression
    A1") is deliberately an EVALUATOR ONLY: it does not wire the envelope or `session_fill` into the
    planner and does not touch `estimateSegmentWorkMinutes`/`SESSION_WORK_FLOOR`/`session_time_budget`.
    **A2** is what closes this thinness entry (pass the envelope + week-position into the planner so a
    full session naturally clears the 0.70 floor). Do not close this until A2 ships.
  - **A2 shipped 2026-07-23 and SUBSTANTIALLY improved fill but did NOT fully clear the week — entry
    STAYS OPEN.** The effective-stage envelope is now in the planner + variant (see `CLAUDE.md` → "Engine
    v2 — Phase-progression A2"). Live before/after on profile 4 (floor 0.70, UNTOUCHED; anchors excluded):
    the headline thin strength day cleared **51%→79%**, the "other" day 55%→79%, cardio stayed full
    (99%→101%/90%, no regression). BUT one MIXED capacity-driver + rehab-maintenance strength day went
    only **44%→65%** — still under. Diagnosed from the rows: the model filled a Build-Muscle (capacity,
    fill 33) slot with low-density posture/rehab work (Cat-Cow, Clamshell, 90/90, Bird Dog, Chin Tuck at
    ~1.0 min/set) instead of the capacity envelope's loaded compound volume — it honored the envelope on
    the pure-capacity day (Push-Up 4×12, Dumbbell Row 4×12 → 79%) but not the mixed day. **This is model
    compliance on mixed rehab-heavy days, NOT a floor problem** — the floor was NOT touched,
    `session_time_budget` correctly flagged the day `regenerate`, the planner retried within its 2-attempt
    cap, and it persisted flagged (the designed flag-and-persist, now visible). **Candidate follow-ups
    (do NOT touch the floor):** a mixed-session rule that requires the driver's envelope volume before
    rehab accessories, or splitting a capacity driver and a rehab-maintenance goal onto separate days.
    Verdict comes with the within-phase ramp (D) or a dedicated mixed-session pass. No session escalated
    past the cleared stage (proven: all strength = capacity-level, medium intensity, 10-15 reps).
  - **Session 12 (2026-07-24) did NOT touch this entry.** The folded-card layout is display-only —
    `estimateSegmentWorkMinutes`, `SESSION_WORK_FLOOR`, `session_time_budget`, the driver-share
    invariant and the allocation contract are all untouched. What it DID add is that the two sessions
    still persisting flagged (07-26 driver share, 07-29 work floor) are now **visible to the athlete**
    as a `⚑` marker rather than only in the invariant report — the residual is surfaced, not fixed.
  - **SESSION COMPOSITION ALLOCATION shipped 2026-07-23 — the candidate follow-up above, built. CORE
    DEFECT FIXED; entry STAYS OPEN but heavily NARROWED.** The mixed-session starvation was a missing
    allocation contract; added a CODE-OWNED per-session allocation (tier-weighted, on
    `planned_sessions.session.allocation`) + a `driver_share_underfilled` invariant that requires the
    driver's modality to FILL its allocated minutes (absolute, `>= share_min × floor`), reusing the A1/A2
    envelopes + `classifyPattern`. Full record: `CLAUDE.md` → "Engine v2 — Session composition allocation".
    **Live re-plan on profile 4 (floor 0.70, UNTOUCHED): both headline mixed strength days now CLEAR the
    floor — 51%/44%/65% → 74% and 70%** — with the driver's resistance work filling its share (Push-Up
    4×10 / Dumbbell Row 4×12 / Overhead Press 3×12). Cardio full (96%/101%), no escalation. **Why the
    entry stays OPEN (the week does not 100% clear):** (a) 07-26 clears the floor but its driver-share
    still flags — the model chose low-density rehab-adjacent resistance (glute bridge / bird dog) on a
    Fix-Pubic-Osteitis-tagged day, real driver modality but too light to fill 19 min; (b) a short 20-min
    mind_body day sits at 66% (a low-fill mobility day overstated ~2 min — the "honestly shorten" case, a
    DIFFERENT phenomenon from mixed-session starvation). Both flagged-and-persisted, model-compliance on
    the margins. The allocation mechanism is the right fix and resolves the composition problem; full
    closure awaits better model compliance on rehab-tagged strength days (candidate: bias the driver
    share to loaded compounds via the envelope's rep-scheme) or the honest-shorten of low-fill days (D).
  - **⚠ SUPERSEDED BY THE 2026-07-24 PIVOT (session #34) — this entry is now HISTORY, not a work item.**
    The whole arc above chased thinness inside v2. The pivot re-frames the root cause one level higher:
    **the 0.70 work floor was itself the wrong gate.** It rewarded "technically fills the time," and the
    model satisfied it the cheap way — few exercises with inflated per-segment minutes — instead of
    prescribing rich multi-exercise blocks. Optimizing that proxy is what produced the sparse sessions
    the athlete rejected as a **depth regression from v1**. The floor is **REJECTED as a session-quality
    gate** (see "Rejected Approaches & Lessons — Engine v2 arc" at the end of this section); any future
    time/content reconciliation must enforce **DEPTH (real exercise count per block)**, not
    estimated-minutes-meets-stated-minutes. **Nothing here was reverted** — the floor, the estimator, the
    driver-share invariant and the allocation contract all remain in the flag-gated v2 code exactly as
    described above. The estimator functions themselves are on the SALVAGE list (reusable in v1 as a
    depth-enforcing content reconciler); the floor **as a gate** is not.
- **Engine v2 — metric-fits-pattern DONE in A2, threshold-plausibility is a BEFORE-B BLOCKER (2026-07-23).**
  The two A1 evaluator follow-ups (below) split: (1) **metric-fits-pattern — FIXED in A2.** `validateCriterion`
  now rejects a value metric that cannot fit its referent pattern's logged shape (hold-seconds on a
  rep-based pull-up), grounded in the four `exercises` columns via `PATTERN_VALUE_METRICS`; it rejects
  only impossible-by-shape pairs, never a loadable-but-unlogged data gap. Live: permanent shape-mismatch
  UNEVALUABLEs went to 0 (A1 had ≥1). (2) **Threshold PLAUSIBILITY — a BEFORE-B BLOCKER, deliberately NOT
  built now.** It is harder to do goal-agnostically and HARMLESS while advancement is disabled, but it is
  a SAFETY issue the moment B enables advancement: an implausibly HIGH threshold (the absurd 135-lb
  weighted chin tuck) is a permanent hold; an implausibly LOW one advances someone prematurely on a rehab
  arc. **B must not ship without a threshold-plausibility gate.**
- **Engine v2 A1 — the two original evaluator follow-ups (2026-07-23), for the record.**
  Both are surfaced HONESTLY by the three-state resolver (as UNEVALUABLE), never as a fabricated MET/UNMET,
  so neither is a correctness bug — they are authoring-quality gaps for a later pass. (1) **The authoring
  validator guarantees pattern∈envelope but NOT metric-fits-pattern.** The model authored e.g.
  `best_hold_seconds` on a rep-based `vertical_pull` (a pull-up has reps, not a hold) and `best_weight_lbs`
  on a bodyweight `hip_bridge` — valid by the envelope check, but the pattern's logged shape never
  produces that metric, so it resolves UNEVALUABLE forever. A pattern→plausible-metrics map in
  `validateCriterion` would reject these at authoring time (more machinery — a closed
  metric-per-pattern table). (2) **Threshold PLAUSIBILITY is unvalidated** — the model authored an
  absurd `best_weight_lbs gte 135` on a "Weighted Chin Tuck Hold" (a neck isometric no one loads to
  135 lb). A1 checks measurability, not clinical sanity of the number; that is a model-authoring/A2
  concern. Both are the reason A1's live UNEVALUABLE rate was 6/9 rather than lower — the constraint is
  working (0 out-of-envelope criteria), the residual is metric/threshold quality + patterns not yet in
  the log (which A2 prescribes).
- **Engine v2 `v2PersistPlan` re-plan collision — FIXED 2026-07-22 (Session 9), surfaced during the
  above verification.** A pre-existing bug independent of the content work: `v2PersistPlan` cleared
  only `status='planned'` rows before inserting a re-planned week, so a `modified` row (autoregulated
  or Coach-Chat-edited) under a now-SUPERSEDED block survived as an orphan. Across several re-plans
  (Sessions 3-9) these accumulated and collided on `UNIQUE(profile_id, date, slot)` — the insert
  23505'd and wrote **0 sessions**, leaving an empty active block. Fixed by clearing every
  NON-`completed` row in the target window (`status=eq.planned` → `status=neq.completed`): a full
  re-plan legitimately supersedes stale `planned`/`modified` edits (they belong to the block being
  replaced); only a genuinely `completed` row (a real logged workout) is history and is preserved.
  The nightly job never re-plans and the Coach Chat propose→confirm→apply cycle is untouched — this
  only changes what a full re-plan reclaims. Verified: post-fix re-plan wrote 7/7 sessions cleanly.
- **✅ Engine v2 — FOLDED-CARD ALTERNATES LAYOUT (2026-07-24, Session 12, DONE + DEPLOYED +
  live-verified). The Session-8 alternate chip row is SUPERSEDED.** Queued since Session 8 and built
  last on purpose, so it had good content (A2 + allocation) and real anchor-day alternates to lay
  out. **DISPLAY ONLY** — planner, autoregulator, invariants, stage/envelope logic, the allocation
  contract and the `planned_sessions` shape are all untouched; same `v2_daily_cache` source, zero
  writes, no schema change, no npm dependency; the whole diff is `public/index.html` + one test file.
  The primary renders expanded (ember) with each distinct alternate as a collapsed card showing
  resolved duration / category / rationale; tapping expands in place and folds the primary into its
  own card. Session 8's rules carried forward (real duration/category never the cache key,
  `noop_extend` suppressed, MIN VIABLE on the shortest duration variant, graceful degradation).
  Closes the §1.4 alternate-`why` weakness above. Full record: `CLAUDE.md` → "Engine v2 — Session 12".
  **Live-verified:** zero network across 8 toggles covering every card; `planned_sessions.updated_at`
  + digest and `v2_daily_cache` digest byte-identical before/after; both currently-flagged sessions
  (07-26 driver share, 07-29 work floor) render the `⚑` marker while the two `repaired` days do not;
  profile 1 `engine_v2:false` with 3 v1 options. 193 → **213 v2 tests**.
  - **⚠ ONE DEFERRED VERIFICATION — confirm the anchor-day render on a REAL cache after the
    2026-07-28 nightly.** 2026-07-24 was not an anchor day and **the nightly has no date override**
    (`v2NightlyForProfile` takes `today` from `localToday(profileRow)`), so a real anchor-day cache
    could not be produced without a server change, which was out of scope. The check therefore
    rendered a cache in the **exact shape `v2BuildAlternates` writes on an anchor day**
    (`miss_strength`/`miss_cardio`, `source:'model:generate'`, real session content) through the real
    deployed render path — heading, both `IF YOU MISS CLASS` tags, and the absence of MIN VIABLE all
    correct. The **discrimination itself is not in doubt** (existing `source`/`key` fields, unit
    tested); what is unconfirmed is the render against a genuinely nightly-written anchor cache.
    Same class as the Session-8 superset-double-paren item: confirm opportunistically.
- **Engine v2 category-vs-content validation — LOGGED follow-up (Session 9 audit §1.5, NOT built).**
  A session's `category` is model-authored and never validated against its prescribed content: the
  cat_swap stamped `strength` (later `mind_body`) on a session of yoga + wall slides + dead bugs.
  A code check could flag a `strength`-labelled session with no strength-pattern exercise (or a swap
  whose output category doesn't match its content). Deferred as the smaller, separate item it is.
- **✅ RESOLVED 2026-07-24 (Session 12) — Engine v2 alternate `why` display weakness (Session 9 audit
  §1.4).** Fixed exactly as this entry prescribed: the folded-card layout shows the short code-derived
  `rationale` in the COLLAPSED state and the alternate's real `session.why` when EXPANDED. Live on
  profile 4, the expanded `cat_swap` now reads *"Lower-body compound strength (capacity stage: 55–70%
  1RM, 10–15 reps, RPE 6–7) + injury-prehab stack. Glute-dominant patterns address quad dominance and
  anterior pelvic tilt…"* instead of the one-line rationale. Original text kept below for the record.
  > When viewing a cached alternate, `renderV2Today` shows the short code-derived `rationale` as the
  > why line and hides the alternate's genuinely richer `session.why`. Not a bug (Session 8 intended
  > the rationale as the collapsed-state summary), but the Workstream 2 folded-card layout should
  > show the rationale collapsed and the full `session.why` when expanded.
- **✅ Engine v2 — ANCHOR-DAY VARIANT GENERATE (2026-07-23, DONE + DEPLOYED + live-verified).** An
  insertion ahead of B and D (both still queued, unchanged), driven by a live usability failure: on an
  anchor day the variant surface returned nothing (an empty anchor has nothing to TRANSFORM). Added a
  GENERATE branch alongside TRANSFORM — when `!sessionHasPrescribedWork(primary)` (any anchor type, or a
  rest day), generate a REAL full session for the freed slot. **Anchors STAY the primary** (not
  overridable/demoted, no replacement primary written). Envelope-compliant (reuses A2's
  `renderEffectiveEnvelopesForPrompt`, cannot escalate — live sessions all `intensity:medium`),
  work-floor-bound, contraindication + CNS-adjacency + mat-load enforced through the rules module
  (contraindication fired live: a generated jog flagged vs the IT-band flag), week-aware
  (`v2WeekContext` + `enforceInvariants` over a mini-week), ephemeral (cache + plan byte-identical after
  5 requests — proven). Classifier now handles body-region / free-text category / miss-class. Nightly
  pre-generates 1-2 "if you miss class" alternates (driver modalities) via the shared path; matching
  category requests serve instantly (~2s vs ~15-20s on-demand). 184 v2 tests; profile 1 byte-identical.
  Full record in `CLAUDE.md` → "Engine v2 — Anchor-day variant GENERATE". **The strength generates flag
  the work floor at the SAME mixed capacity+rehab residual tracked OPEN in §6** (cardio generates pass).
  **The Workstream 2 folded-card layout is still queued and should come AFTER this** — it now has real
  anchor-day alternates (the pre-generated miss-class sessions) to lay out.
- **✅ Engine v2 — SESSION COMPOSITION ALLOCATION (2026-07-23, DONE + DEPLOYED + live-verified).** The
  last item that was keeping the §6 thinness entry open — the mixed capacity+rehab starvation, now
  named as a missing allocation contract. A CODE-OWNED per-session allocation (tier-weighted, stored on
  `planned_sessions.session.allocation`) + a `driver_share_underfilled` invariant enforcing the driver's
  modality FILL its allocated minutes (absolute), reusing the A1/A2 envelopes + `classifyPattern` — no
  new envelope system, `session_time_budget`/floor untouched. Applies to planner + variant + anchor-day
  generate (shared enforce path). Tier defaults (driver 3 / maintenance 1 / accessory 0.5); new users get
  sane equal composition automatically; preference seam `profile_data.session_composition.tier_weights`
  (v2-only, a later settings control writes it like the defaults picker — no UI built). Live: **both
  headline mixed strength days now CLEAR the floor (51%/44%/65% → 74%/70%)** with the driver's compound
  work filling its share; cardio full, no escalation, profile 1 byte-identical, 193 v2 tests. **§6 stays
  OPEN but heavily narrowed** — the week does not 100% clear (one strength day's driver-share still light
  on a rehab-tagged day; one short mobility day at 66%), both model-compliance on the margins. Full record:
  `CLAUDE.md` → "Engine v2 — Session composition allocation". **B, D, and the folded-card layout remain
  queued.**
- **Accessory-tier goals can be silently dropped with no invariant catching it (found
  2026-07-22).** `Daily Meditation` (accessory tier) appears in the generated plan only inside a
  segment's `intent` STRING ("Pinky accessory + meditation — daily accessory dose") and is never
  prescribed as an actual exercise. Nothing in the invariant set checks that every tiered goal
  received a real prescription, so an accessory goal can be acknowledged in prose and dropped in
  practice. Candidate invariant: every driver and accessory goal must appear in at least one
  session's `goal_tags` AND have at least one concrete exercise attached.
- **The planner asserted a specific quantitative fact that was NOT in its inputs (found
  2026-07-22).** The generated block states a "22-day gap" and builds the week around
  re-establishing cadence "post-gap day 1". The number is **correct** — profile 4's workouts do
  show exactly 22 days between 2026-06-22 and 2026-07-14 — but **nothing in the assembled prompt
  contains it**: the progression table carries per-exercise instance dates (whose own visible gap
  is ~32 days, not 22), the dossier carries `consistency: 4.4`, and no section states a workout-gap
  figure at all. So the model produced an unverifiable assertion that happened to be right. That is
  not a success — it is the same behaviour that would have produced a confidently wrong number.
  Compounding it, the gap is **historical and already closed** (7 sessions logged in the 9 days
  since, including the day of generation), yet the plan treats it as current. Two fixes, both real:
  surface a computed `days_since_last_workout` + recent-session-count explicitly so the model never
  has to infer one, and instruct it not to state training-history figures that are not given to it.
- **Engine v2 variant model paths run ~15s, materially over the sub-5s target (found 2026-07-22,
  Phase 5, ACCEPTED).** The deterministic paths (cache ~1.4s, code ~2s) meet sub-5s and cover the
  common duration cases. A model-generated variant (intensity/category/style/free-text) runs ~15s
  because it **generates a full structured session** (~1,500 output tokens on Haiku) — the cost is
  output generation, not prompt size (the prompt is already ~11k chars / ~3.2k input tokens, under
  the autoregulator's). Trimming the prompt further will not reach 5s. The durable fix is
  generating a DIFF against the primary rather than a whole session, a design change deferred to
  its own scope. Streaming means the user sees incremental progress in the meantime.
- **✅ RESOLVED 2026-07-22 (Phase 5) — the alternate-cache category swap.** The Phase 4 inline swap
  prompt produced nothing; rewiring the nightly swap through the shared `v2GenerateVariant` path
  fixed it (root cause: the swap was handed the flattened display session, not the structured one).
  The nightly job now yields 4 cache objects. Original entry kept below for the record.
- **Engine v2: the alternate-cache category swap silently produced no usable alternate on the
  first real nightly run (found 2026-07-22, Phase 4, ~~NOT fixed~~ — fixed in Phase 5, above).** The swap Haiku call
  ran (`model_calls:1`) but returned no parseable `session`, so the cache holds 3 objects (primary
  + two duration variants) instead of 4 — within the ≤4 budget, so nothing broke, but a Haiku call
  was spent for nothing. The two duration variants are code-derived and always succeed; only the
  swap depends on the model. Root cause not chased (parse vs shape vs the swap prompt). The natural
  place to harden it is Phase 5, where the on-demand variant endpoint reworks category-swap logic
  anyway — the nightly swap should likely call that shared path once it exists rather than its own
  inline prompt.
- **Engine v2: the planner prescribes work for a goal but omits it from `goal_tags` (found
  2026-07-22 on the Phase 3.5 regeneration, NOT fixed).** The `tiered_goal_prescribed` invariant
  fired correctly against the accessory-tier pinky-rehab goal — and inspection shows the work IS
  in the plan: `Pinky Abduction with Rubber Band`, `Tabletop Lumbrical Curl` and `Wrist Circles`
  on Friday, `Lumbrical Pinky Isolation` on Sunday. Those sessions are tagged
  `["Fix Posture", "Build Muscle"]` and `["Fix Posture", "Fix Pubic Osteitis"]` — the goal the
  exercises actually serve is missing from both. So this is a **mis-tagging** defect, not a
  dropped-goal defect, and it is narrower than the original Daily Meditation case (which really
  was prose-only). Consequence: any consumer that reasons over `goal_tags` — Coach Chat, goal
  progress, a future "what did I do for X this week" view — will under-report. The invariant
  cannot distinguish the two cases, and deliberately does not try: it flags, and a human reads it.
  A prompt change may reduce it but is unlikely to eliminate it; the durable fix is probably to
  derive `goal_tags` in code from the prescribed exercises rather than trusting the model to
  label its own work.
- **Engine v2 progression state: 34 of 40 exercises have <3 sessions in a 60-day window (found
  2026-07-22, Phase 2 audit against real cloned data).** 27 appear exactly once, 7 twice. They are
  flagged `insufficient_data` and their trend defaults to `flat`, which is honest — but it means
  **the majority of this athlete's logged exercises carry no usable progression signal at all.**
  The consequence for Phase 3: a planner that leans on measured progression will have real data
  for roughly 6 exercises and nothing for the rest. Not a bug — it is what the training history
  actually contains (a wide, rotating set of rehab/mobility movements plus a few consistent
  lifts). It does argue for the planner treating "no signal" as a first-class case rather than an
  edge case, and it is the strongest argument yet for the rotation rules' insistence that primary
  lifts stay fixed long enough to become measurable.
- **Engine v2 dossier lands at ~2,400 chars against a ~2,000 target (found 2026-07-22, accepted).**
  Driven almost entirely by 5 injury entries carrying long clinical histories. The builder now
  shortens injury DESCRIPTIONS before trimming any list, and never drops an injury for size (an
  injury removed for length is a safety problem, not a formatting one). It stays under the 2,600
  hard cap and warns explicitly when over target. Revisit if a profile with more injuries pushes
  past the hard cap.
- **`exercises.duration_minutes` is overloaded: it means BOTH hold duration and session length
  (found 2026-07-22 by running the v2 audit, worked around in v2 only).** For a Dead Hang it is a
  2-minute hold; for an MMA class it is a 60-minute session. Nothing in the schema distinguishes
  them. The v2 progression builder now disambiguates by `main_category`
  (cardio/martial_arts/sports/mind_body = session length; everything else = hold) — before that
  fix it reported "MMA Sparring PB 60:00 hold" and prescribed "+5-10 s hold" on a sparring
  session. **v1 is NOT fixed and still has this ambiguity**: `buildExerciseHistory()` and
  `buildLog()` in `public/index.html` both render any `duration_minutes` as a hold, so profile 1's
  daily-rec prompt currently describes MMA classes and bike sessions as holds too. Low severity
  (the model mostly infers the truth from the exercise name) but it is real, it is in the live v1
  prompt today, and the durable fix is a schema-level split rather than per-consumer heuristics.
- **6 of profile 1's workouts hold a TIME STRING in `workouts.date` (found 2026-07-22, profile-4
  clone audit) — production data bug, NOT fixed.** Workout ids **110 (`"10:12"`), 97 (`"12:52"`),
  95 (`"13:00"`), 88 (`"19:37"`), 82 (`"10:07"`), 77 (`"10:20"`)** — types Martial arts / Workout /
  Walk / Yoga / Martial Arts / Martial Arts. This is only possible because **`workouts.date` is a
  `text` column, not `date`** — a real `date` column would have rejected these outright. That
  column type is itself the root enabler and is not recorded anywhere else in the docs.
  **Consequences:** these 6 rows are invisible to every `date >= x` window query in the app, so
  they already contribute nothing to analytics, the weekly-volume summary, the variety analysis,
  the coaching briefs, or the daily-rec prompt — they inflate only the raw workout count (81 total
  vs 75 date-valid). All 6 have **zero child `exercises` rows**, which correlates with the
  session-#32 "notes-only logged workouts where `extract-exercises` silently produced no rows"
  item, though causation was not established. **Deliberately not repaired:** profile 1 was
  read-only for the clone task, and a repair would have to guess the intended date (`ts` is
  client-supplied, overwritten on every edit, and carries a systematic ~300-minute offset, so it
  is not a trustworthy source). The profile-4 clone **skips** them via a shape regex rather than a
  hardcoded id list, so a 7th such row is caught automatically. A real fix needs its own scope:
  decide the date source, repair the 6 rows, then consider whether `workouts.date` should become a
  real `date` column (which would require every one of the app's text-comparison date filters to
  be re-verified first).
- **`lpAiOptionToNotes()` (`public/index.html` ~11992) still reads `o.exercises` directly — missed
  in the session #31 sections migration (found 2026-07-22, NOT fixed).** Session #31 moved rec
  options from a flat `exercises[]` to `sections[]` and updated five consumers through the
  `recOptionSections()` / `recOptionExerciseStrings()` normalizers; this sixth consumer was not.
  Because a sectioned option has no top-level `exercises` key, `var exes = o.exercises || []`
  yields an empty array, so **"Save AI rec as template" and "AI rec → template" produce
  headline-only notes** (plus mobility) for every rec generated since that deploy — the exercise
  list is silently dropped. One-line fix (`recOptionExerciseStrings(o)`), but it is a write path
  into `workout_templates.notes_template`, so it is logged rather than opportunistically patched.
- **`GET /api/profiles/:id` is a read endpoint with a WRITE side effect (found 2026-07-22, by
  design but undocumented).** `ensureGoalIds()` (`server.js:990`) fires a fire-and-forget `PATCH`
  of the **entire `profile_data` column** whenever any goal lacks an `id`. In normal operation
  this is a one-time backfill per profile and a no-op thereafter — but it means a plain GET can
  rewrite a profile's most important jsonb column, so "just checking profile 1 in the browser" is
  not a read. Relevant any time a profile must be treated as strictly read-only (the profile-4
  clone audit deliberately never called this endpoint against profile 1 and inspected it via SQL
  `SELECT` instead). Also worth knowing: the PATCH writes `cleanProfileData(pd)`, so it
  simultaneously re-sanitizes every string in the column.

### ⚠ BUG 3 — roadmap adapt AND regenerate destroyed `arc_origin` + `arc_state`. ✅ FIXED (2026-07-27, session #42)

> **Found while ruling out BUG 2's candidate (c). It was in no document before session #42.**
> Shipped fix: `ae46a96`. No migration (jsonb, code-only).

- **Root cause.** `adaptGoalRoadmap` (`server.js:7019`) and `generateGoalRoadmapForGoal`
  (`:7696` regenerate branch and `:7711` reset branch) both rebuild `goal.roadmap` **from scratch**,
  so any Layer 2 field not named explicitly is silently destroyed. `arc_origin` and `arc_state`
  shipped in session #37 (Layer 2) and were never added to either carry-forward list.
- **Same bug class, same two sites, second occurrence.** Session #35 fixed exactly this for
  `roadmap.estimate` and left an explicit comment about it at the adapt site. The arc fields
  arrived two sessions later and repeated the pattern. **If a third Layer-2/3 field is ever added
  to `goal.roadmap`, add it to `carryArcForward`'s block at the same time.**
- **Live evidence.** Profile 4's "Bench press 175 lbs for a single" was regenerated
  **2026-07-26T02:47:22.417Z** (`adaptation_log` trigger `manual` — the athlete's inline regenerate,
  §7 ledger row 14) and now carries **neither field**, where ledger row 10 recorded
  `position 3.0 / re_ramping / re_ramp.since 2026-07-06`.
- **Why it is worse than it looks — it does NOT self-heal.** `arc_state` is a pure replay and
  returns on the next evaluation. **`arc_origin` does not**: it is re-pinned from
  `near[0].start_date`, and both writers call `assignNearTermDates(parsed.phases, today)` on freshly
  model-authored phases that carry **no** dates, so the phase calendar is rebuilt **from today**
  (measured: the bench goal's `near[0].start_date` is now `2026-07-26`, the regeneration day).
  Dropping `arc_origin` therefore walks the origin forward on every adapt/regenerate and discards
  every earned week — **session #37 bug #1 arriving through a different door**, which is precisely
  what pinning `arc_origin` was introduced to prevent. Because the weekly auto-adapt is
  fire-and-forget on every workout save once >7d stale, **no goal could accumulate earned arc
  across an adapt.**
- **Fix.** One shared `carryArcForward(prev, next)` — ONE implementation, TWO consumers, so the two
  writers cannot disagree. **Carry-if-present only**: a legacy roadmap has neither field and must
  not gain them, the same principle as `ensureGoalDefaults()` never fabricating a `demand`.
  Absent in ⇒ absent out.
- **Verified pre/post against the REAL shipped functions extracted from BOTH `git HEAD` and the
  working tree** (comment/string/template/regex-aware scanner + over-capture guard + mandatory
  re-parse per the arc close-out learning #2), frozen clock so wall-clock stamps cannot mask a
  diff, real profile-1 and profile-4 fixtures — **9/9 pass**: an arc goal keeps both fields
  byte-identical through adapt, regenerate AND reset; **a legacy goal (profile 1's real "Fix
  Posture") is byte-identical pre-fix vs post-fix on all three paths** with no fabricated keys;
  only the two arc keys are ever added and every other field is unchanged. Existing suites 213/213.
- **Blast radius on profile 1: none today, but it was a live blocker for the migration.** Profile 1
  has 3 legacy roadmaps with zero arc fields, so there was nothing to drop — but those roadmaps run
  this exact adapt path on every stale workout save, so **profile 1 would have inherited the bug the
  moment it was migrated.** That blocker is now closed (§7 → profile-1 migration decision).
- **Residual, NOT fixed:** the destroyed origin on the bench goal is **not recoverable** — see §7
  ledger row 28 and §9. The fix prevents recurrence; it does not restore what was already lost.

### ✅ BUG 2 — RESOLVED: NOT A BUG. Profile 4's Today page is behind the manual check-in gate (2026-07-27, session #42)

> **Diagnosed session #42. Candidate (a) — benign empty state — confirmed; (b) ruled out by
> measurement; (c) disproven in code.** Left as designed by decision; a backlog line is logged in §9.

- **Root cause, by design.** Profile 4 has `profile_data.fitbit === false` and **zero connected
  wearables** (all five providers `connected:false`), so `syncFitbit()` takes
  `if (pd.fitbit === false) { showManualCheckin('no_fitbit'); return; }`
  (`public/index.html:3845`). `showManualCheckin` has two branches, and **only the branch that
  finds a same-day `localStorage.ac_cache.manualCheckin`** sets `#ai-card` to `block` and calls
  `resolveAIRecs()` (`:3228`–`:3231`). The reset branch does neither, so `#ai-card` stays at its
  HTML default `display:none` (`:947`) and **no rec renders and none is requested.** Submitting the
  check-in (`:3314`–`:3320`) shows the card and fires
  `regenerateAIForContextChange('manual_checkin_submit')`.
- **Data agrees:** `GET /api/profiles/4/daily-recs` → `{recommendations:null, date:null,
  readiness:null}` — never populated, exactly as candidate (a) predicted (v2 never wrote them and
  the profile was flipped to v1 in Session A).
- **Candidate (b) RULED OUT BY MEASUREMENT.** The real shipped `fetchAI({auditOnly:true})` was run
  headless against profile 4's real `profile_data`: **all 11 top-level builders returned OK, zero
  throws**, and the full assembly completed at **untrimmed 28,947 → 27,193 / 28,000**, one rung
  (`historicalBrief->400`), **headroom 807**. The fully-arc'd profile pays the same single rung
  profile 1 pays. (Profile 4 carries 1 arc goal, not 3 — a three-arc profile is still heavier.)
- **Candidate (c) DISPROVEN IN CODE.** `grvRegenerateFromBanner()` (`:7800`) re-renders the roadmap
  view and the goal cards and calls **none** of `fetchAI` / `regenerateAIForContextChange` /
  `invalidateDailyRecsAndRefresh`; only *macro* roadmap regeneration has a rec trigger (`:6220`).
  A per-goal regenerate cannot remove a rendered rec. The timing was coincidence — **but the same
  regenerate did real damage of a different kind, which is BUG 3 above.**
- **Not shared with profile 1:** it has `fitbit: true` and takes `syncFitbit()`'s Fitbit path, so it
  never reaches `showManualCheckin('no_fitbit')`.

### PT Brain arc close-out — OPEN BUGS found after Session D (2026-07-27, session #41)

> **⚠ UPDATED 2026-07-27 (session #42): BUG 2 is RESOLVED as designed behaviour (see above) and
> BUG 1 has been fully audited with measured numbers (below) — the fix is designed and DEFERRED to
> its own session by decision. No limit bump was applied.** The original text is kept because the
> reasoning that framed the investigation is the useful record.

**BUG 1 — HTTP 413 on `GET`/`POST /api/profiles/1/goal-progress` (profile 1, live). ⚠ AUDITED
2026-07-27 (session #42) — see the AUDIT RESULT block immediately after this entry.**

- **Console, exactly as observed:** `Failed to load resource: the server responded with a status of
  413`, followed by `[Goals] Progress fetch error: SyntaxError: Unexpected token '<', "<!DOCTYPE "...
  is not valid JSON` at `index.html:11308`.
- **The parse error is NOT the bug.** The 413 is returned as an **HTML error page**, so the client's
  `JSON.parse` chokes on `<!DOCTYPE`. That `SyntaxError` is a *secondary symptom*. Fixing the client
  parse would hide the 413, not resolve it.
- **Impact:** goal progress numbers don't load. Everything else on the profile renders.
- **Hypothesis to CONFIRM, not assume:** a request body exceeding the default Express / body-parser
  limit (~100 kb). `profile_data.goals[]` has accumulated fields across all three PT Brain sessions
  — `goal_type`, `demand`, `estimate`, `roadmap.estimate`, `arc_origin`, `arc_state` — plus
  `profile_data.capacity` and `profile_data.coexistence`.
- **⚠ A SECOND, DIFFERENT CAUSE IS ALREADY ON RECORD AND THE TWO HAVE NEVER BEEN RECONCILED.** §9's
  pre-existing entry (opened session #36, observed on **profile 4**) attributes the same 413 to the
  CLIENT side: `fetchGoalProgress` (`public/index.html`) posts `workoutLog.slice(0, 90)` **plus every
  exercise session**. That is a different payload from accumulated `profile_data`. **Both are
  plausible and they are not mutually exclusive** — this is exactly why the first step is an audit,
  not a fix. See §9, where the two are now merged into one item.
- **⚠ ANOMALY WORTH RESOLVING IN THE AUDIT:** a 413 (`Payload Too Large`) on a **GET** would be
  unusual, since a GET carries no body. Confirm which verb actually 413s before reasoning from the
  reported pair.
- **⚠ FORWARD-LOOKING RISK — raising the limit is a BAND-AID.** Profile 1 currently has **ZERO arc
  goals**. When its roadmaps are migrated to the new shape (§7 → "Profile 1 migration — a flagged
  athlete decision"), `arc_state` lands on **every** goal and the payload grows again. **The likely
  correct fix is not sending the whole blob** — send aggregates, or let the server fetch its own
  data the way the roadmap endpoints already do.
- **FIRST STEP WHEN PICKED UP: an AUDIT of what that endpoint actually sends** (request body size,
  measured, per verb), not a limit bump.

#### BUG 1 — AUDIT RESULT (2026-07-27, session #42). Measured, read-only, zero writes. FIX DESIGNED, DEFERRED.

**1. The verb anomaly is RESOLVED: there is no GET route.** Only `app.post` at `server.js:2952`.
Measured live against production:

| request | result |
|---|---|
| `GET /api/profiles/1/goal-progress` | **404**, `text/html`, `<!DOCTYPE html>…Cannot GET` |
| `POST`, small body | **200**, `application/json` |

The reported "GET/POST" pair is **one endpoint written two ways, not two observations. Only the
POST can 413.** Both a stray GET and an oversized POST produce the identical client-side
`SyntaxError: Unexpected token '<'`, which is why they were conflated.

**2. The limit is the framework default, 100 KB.** `server.js:92` is `app.use(express.json());`
with **no options**, and no other body parser exists. Bracketed live: **101,357 B → 200**;
**103,405 B → 413 `text/html` "Payload Too Large"**. That HTML error body **is** the `<!DOCTYPE`
the client's `JSON.parse` chokes on — one cause, both symptoms.

**3. Real body size for profile 1: 207,357 B = 202.5 KB = 2.02× the limit.** Reconstructed
field-for-field from `fetchGoalProgress` (`public/index.html:11286`) using real read-only data
(60 workouts, 310 exercise rows across 69 distinct exercises, 8 goals):

| part | bytes | share |
|---|---|---|
| `exercises` (all rows, all-time) | 104,059 | 50.2% |
| `workoutLog` (60 rows) | 65,689 | 31.7% |
| `goals` (accumulated `profile_data`) | 37,483 | 18.1% |
| scalars | 90 | 0.0% |
| **TOTAL** | **207,357** | **2.02×** |

**4. The two competing causes are RECONCILED, and they are not equal.** The client blob
(`exercises` + `workoutLog`) is **169,748 B / 81.9%**, which is **1.66× the limit on its own** —
sufficient to 413 with zero goals; `exercises` alone already exceeds 100 KB. Accumulated
`profile_data.goals` is **18.1% and comfortably under the limit on its own**.
**⇒ the session-#36 client-side hypothesis (a) is the CAUSE; the session-#41 profile_data
hypothesis (b) is an AGGRAVATOR.** Removing all accumulated profile_data still leaves the endpoint
broken.

**5. Migration projection: ~4% worse, not the cause.** Measured per-goal on profile 4:
`arc_state`+`arc_origin` ≈ **311 B/goal**; `goal_type`+`demand`+`estimate` ≈ **771 B/goal**.
Profile 1's 8 goals → **+8,653 B → 216,010 B = 210.9 KB (2.11×)**. **Migration is not what breaks
this, and not migrating would not fix it.** (Not modelled: migration regenerates all 3 legacy
roadmaps, so `phases[]` churn is additional.)

**6. The real fix.** The handler (`:2952`–`:3090`) is **stateless — zero writes** — and consumes
the three big arrays only to compute scalar aggregates (max matching `weight_lbs`, total
`distance_miles`, longest cardio, a weekly-cardio count, a category tally).
**`var profileId = req.params.id` is assigned at `:2954` and never used again** — the server
already knows whose profile it is, and already has this exact pattern in
`getGoalExerciseContext()` / `getFullExerciseContext()` / `loadProfileWithGoals()`.
- **Step 1 (small, drop-in): stop sending `exercises` + `workoutLog`; the server fetches its own.**
  **202.5 KB → 37.6 KB.** The handler reads raw `exercises`/`workouts` row fields, so populating the
  same two variables server-side leaves the per-goal loop untouched (~20 lines + deleting two client
  fields).
- **Step 2: stop sending `goals` too**, reading `profile_data.goals` via
  `loadProfileWithGoals(profileId)` → **<1 KB**, permanently immune to the migration and to any
  future goal-field growth.
- **⚠ A limit bump is a STOPGAP ONLY and must never ship as the fix.** `express.json({limit:'1mb'})`
  would unblock today at 202 KB, but the payload grows with every logged exercise row forever — it
  is already 2× and the trend is monotonic. **None was applied this session, by decision.**

**BUG 2 — no workout rec renders on the Today page for profile 4 (Test #3). ✅ RESOLVED
2026-07-27 (session #42) — NOT A BUG; it is the designed manual check-in gate. Full diagnosis in
the "BUG 2 — RESOLVED" entry above; original text kept below as the record of the investigation.**

- **Observed** after the athlete regenerated a goal's roadmap on that profile. **Undiagnosed.**
- **NOT a general Layer 4 regression.** Profile 1 was checked immediately and is healthy — rec cards
  generate, capacity and profile cards load (see §7 ledger, newly verified live).
- **Candidate causes to rule out IN THIS ORDER when picked up:**
  1. **Benign empty state** — profile 4's `daily_recommendations*` were never populated, because v2
     never wrote them and the profile was flipped to v1 in Session A (session #36).
  2. **A generation failure specific to that profile's data shape** — it is the ONLY profile with
     new-shape goals, `arc_state`, `capacity` and `coexistence` all present simultaneously.
  3. **Fallout from the goal regeneration that immediately preceded it.**
- **First step:** the browser console on profile 4, then a **forced category-pill generation** — that
  separates a cache/render issue from a generation failure (the category path writes only `altRec`
  and never touches the stored daily cache).
- **⚠ THIS BLOCKS SESSION D ITEM (c).** Profile 4 is where that verification has to happen, so BUG 2
  is ordered ahead of it. See §7 ledger and the next-session pointer in `CLAUDE.md`.

### PT Brain Session D — Known Limitations (2026-07-25, session #40)

1. **The depth thresholds sit at ZERO MARGIN on 5 of 12 gated sections** — strength Mains 33/4,
   22/3, 15/3 and mobility Mains 30/4, 25/4. (The 6th Main, 18 min / 4 movements, carries +1.)
   Nothing is flagged today, but a section that drops **one** movement below anything ever accepted
   fires a warn. **Deliberate, not an oversight:** the same number is stated in the prompt (where it
   acts as a target, so setting it lower invites the depth regression this layer exists to prevent)
   and applied in the verifier (where at the line it is a tight tripwire). The prompt role dominates
   because the failure costs are asymmetric — a false warn is one console line, a low minimum is
   lost depth on every rec. Mitigated by reporting `margin` per section so an at-the-line pass is
   legible. **If real use produces recurring spurious warns, drop the `≥25` tier to 3 — do NOT
   raise any tier.**
2. **Prompt size overshot the Phase 1 projection.** Depth block **+641** chars (projected ~300,
   after tightening from an initial 919); arc block up to **935** (projected ~500 — that estimate
   did not budget for the mandated-verbatim ARC REALITY instruction, ~430 chars on its own).
   Profile 1 is unaffected in practice (**headroom 777, arc block 0 chars, no extra trim**), but a
   fully-arc'd profile exceeds the untrimmed 28,000 budget by ~158 and therefore pays one extra
   ladder rung (`coachingBrief→400`). That is the ladder working as designed, and it is bounded to
   a single rung — but it means a heavily-arc'd athlete trades some coaching-brief context for arc
   context. Revisit if a real profile ever carries 3 arc goals.
3. **The all-bare-section rule DOES fire on real content — Phase 1's "fires ZERO times" was
   measured on the mobility day only.** On the strength day it fires on 1 of 11 sections (Hand
   Rehab: three unquantified movements, declared 5 min → 4.0 → 5.0). Correct behaviour and tiny in
   magnitude, and it is the ONLY before/after time delta in either day — but the audit's stated
   basis for calling the rule inert was incomplete. Recorded so the claim is not repeated.
4. **The mobility-day fixture's exercise STRINGS are reconstructed, not verbatim.** Its section
   labels, declared minutes and movement counts are the real Phase 1 measurements (the audit
   recorded counts, not the 32 raw lines); the individual strings were rebuilt to those counts. The
   **strength day is fully verbatim.** Depth non-regression is a function of counts and strings
   being identical **between the two code versions**, which is unaffected — but the mobility day's
   absolute per-line time estimates are indicative, not measured.
5. **Item (c) is NOT verified live.** Driving a profile-4 goal into `re_ramping` and confirming a
   generated rec visibly reads as a re-ramp (lighter prescription, honest framing, no arc number
   that was not injected) needs a deploy plus a real model call. The block's **construction** is
   fully verified — verbatim ARC REALITY wording, legacy goals contribute nothing, zero arc goals
   yields an empty string with no header or placeholder, self-caps at 3, within its char cap — but
   the **model's response to it** is unverified. **This is the exact check to run first next
   session.**
6. **Movement counting is name-based and inherits the `splitExerciseName` limitation.** A
   digit-leading name ("90/90 Hip Rotation") strips to empty and falls back to the raw string, so it
   still counts as its own movement and is never lost — but two differently-annotated spellings of
   the same digit-leading movement would count as two. Same accepted parser trade-off already
   documented for AI-rec link matching.
7. **`loadCapacityFit()` now fires a GET on every Profile-tab switch.** Matches the existing
   `loadLibrary()`-on-library-switch convention and the endpoint is small and read-only, but it is
   one more request per switch. `renderCapacityCard()` in the boot fan-out deliberately does NOT
   fetch — it renders from already-loaded `currentProfileData.capacity`.

### PT Brain Session C — Known Limitations (2026-07-25, session #38)

1. **⚠ CORRECTED 2026-07-25 (session #39 Phase 1 audit) — this was a MISDIAGNOSIS. It is not a
   render-ordering problem and it is a one-liner.** Original text: *"`renderCapacityCard()` runs in
   the Profile render fan-out, but switching to the Profile tab with a freshly-loaded
   `profile_data.capacity` left the card `display:none` until something re-rendered it… it needs a
   render-ordering pass rather than another call site bolted on."*
   **The premise was wrong: `renderCapacityCard()` never ran in the Profile render fan-out at all.**
   Session A appended `renderCapacityCard(); loadCapacityFit();` after `renderFocusOverrideCard()`,
   and that call site landed **INSIDE `foPersist(fo, reason)`** (`public/index.html:6843`) — the
   **Focus-Override SAVE handler**. So the card renders only when a Focus Override is saved; never
   on boot, never on tab switch. The observed symptom (renders correctly once called) was the
   function working fine and simply not being called.
   **Fix: call both from `showTab()`'s existing `if (name === 'profile')` branch.** Leave the
   `foPersist` call in place — it is harmless. Scheduled with PT Brain Session D (Layer 4).
   **✅ FIXED AND SHIPPED in session #40**, and now **VERIFIED LIVE** (session #41): the athlete
   confirms the capacity card and the other profile cards load correctly on profile 1 both on boot
   and on tab switch. The correction landed in all three places it needed to — this entry, §9, and
   `CLAUDE.md` → "PT Brain — Session D" → A5. Kept here (not deleted) because the *misdiagnosis* is
   the useful record: a symptom of "renders correctly once called" means the function is fine and
   nothing is calling it — check the call site before theorising about render order.
2. **`capApplyDelta` runs before the decision is recorded.** Now idempotent (a `create` skips when
   the goal already has a linked target), so a failure between the two is recoverable — but the
   ordering itself is still apply-then-record. Writing the status first would need the server to
   own the apply, which would give the app a second schedule writer.
3. **Gate proposals re-run on every classification.** A gate the athlete *declined* is removed
   from the list, so the next classification can propose the same gate again. Confirmed gates
   persist correctly. A "declined" tombstone would stop the re-ask; not built.
4. **`targetServesGoal` is keyword-based.** It correctly refuses "Upper Body Strength" for a bench
   goal and correctly links "Wrist Rehab", but a target named in words the goal title doesn't use
   ("Pressing Work" for a bench goal) will fall through to `create`. That is the safe direction —
   an extra narrow target rather than a wrong attachment — but it is not semantic matching.
5. **SEQUENCE assumes one lead.** Two genuinely co-equal goals cannot both lead; the second drops
   to `min_viable`. Correct for the honest-tradeoff design, but worth knowing before Layer 4.
6. **Handoff only fires for the CURRENT `lead_goal_id`** and only once per lead (guarded by
   `handoff.lead_goal_id`). A profile that has never been classified has no lead, so no handoff
   can fire until the first classification runs.

### PT Brain Session B — Known Limitations (2026-07-25, session #37)

1. **⚠ PARTIALLY CLOSED by Session C (session #38) — restated 2026-07-27. Original text: *"Arc
   evaluation only runs on a workout SAVE."* That is no longer accurate.** Session C added
   **app-open arc evaluation** (`POST /api/profiles/:id/evaluate-arcs`, fired fire-and-forget from
   `bootApp`, server-gated on the existing 24h staleness, **zero AI calls** either way), so decay
   now accrues across a break instead of landing all at once on the next workout save.
   **WHAT REMAINS OPEN, precisely: nothing evaluates if the app is never opened.** An athlete who
   neither logs a workout nor opens the app still accrues no decay — which is a narrower gap than
   the original, but the same class. The admin sweep
   (`POST /api/debug/evaluate-arcs/:profileId`, dry-run default) forces it manually and is
   deliberately **still not wired to any interval**; a true time-based tick needs its own decision
   (the in-process hourly interval is unreliable on Render's Hobby plan — see the Engine v2 nightly
   notes). **Also note: only the FRESH/skip branch of app-open evaluation has been exercised live**
   — the stale branch is shipped-unverified (§7 ledger).
2. **Anchor and addon matching are structurally weaker than target matching, by necessity.**
   `activityMuscles()` returns `[]` for mobility/yoga/rehab/meditation, so those can never clear
   the exercises-table bar. Anchors fall back to weekday + category agreement, addons to
   day-level presence, empty-muscle targets to category agreement. Each is labelled
   `category`/`presence` in `arc_state.evidence` and **never called `precise`**, and the UI shows
   a link nudge below `precise` — but an athlete whose linked item is an addon is being tracked
   by "did you train at all that day".
3. **Tier 2 keyword matching is genuinely imprecise.** Weak tokens are dropped (`single`, `lbs`,
   pure digits) and it is intersected with done workouts, but it still substring-matches exercise
   names. Verified live: the unlinked rehab goal resolved `tier: 2, confidence: "keyword"`.
4. **`applyTimelineFlex` only adjusts `upcoming` phases.** An athlete deep into their LAST phase
   has nothing to flex, so the roadmap goes straight to `needs_regeneration`. That is the
   designed honest outcome, but it means a long final phase absorbs no drift at all.
5. **`arc_origin` is pinned at first evaluation, not at generation.** A roadmap generated weeks
   before Layer 2 shipped gets an origin of its first phase's `start_date` at first evaluation —
   correct — but a roadmap whose phases were resequenced before that first evaluation inherits
   the resequenced date. Only affects roadmaps straddling this deploy.
6. **Flex fires off `flex_streak >= 2` consecutive EVALUATIONS, not elapsed time.** Several
   workout saves in quick succession accumulate the streak faster than two real weeks would.
   The post-flex reset bounds the damage to one flex per two evaluations, but the streak is not
   time-aware.
7. **`recomputeRoadmapProgress` is not called by `GET /api/profiles/:id`**, so the raw profile
   payload shows `progress_pct: undefined` on non-current legacy phases. Pre-existing, unchanged
   by this session, and the goal endpoints do recompute — noted because it is visible when
   reading profile JSON directly.

### PT Brain Session A — Known Limitations (2026-07-25, session #36)

1. **The negotiation can loop when a goal is genuinely too big for the week.** Applying the
   `slower` or `sequence` lever re-posts to `/estimate`; if the result still doesn't fit, the
   athlete lands back on Step 4. Because `sequence` sets frequency to `min_viable` and
   `suggested.slower_frequency` is floored at `min_viable`, both levers become idempotent and
   the athlete can bounce between them. **There IS an exit — the `capacity` lever returns to
   Step 3 with the capacity controls open — but it is not signposted**, and a goal that cannot
   fit at any frequency cannot be created at all. Observed in test (c): after applying
   `sequence`, the week still needed 345 of 300 min. **Deliberately not fixed in Session A** —
   widening the resolution set is exactly what the bounded-three-lever design forbids. The
   likely fix is a `round` counter passed to `/negotiate` so the copy escalates ("time or hard
   capacity is the only remaining lever"), not a fourth lever.
2. **`/estimate` persists `goal_type`/`demand`/`capacity` before the fit check runs.** A goal
   whose negotiation the athlete abandons mid-flow keeps the demand it was last posted with, so
   it counts toward the capacity sum despite having no roadmap. Self-corrects the moment the
   athlete finishes or edits the goal. Accepted: the alternative is a draft/commit split that
   Session A doesn't need.
3. **`plan-setup` writes its proposal to the goal immediately.** This is what makes the dial lock
   server-authoritative (`/estimate` compares against a stored value), but it means merely
   *opening* the plan-setup step stamps a `goal_type` and `demand` on the goal even if the
   athlete backs out. Same self-correcting property as (2).
4. **A model that returns fewer near-term phases than the plan asked for is accepted, not
   padded.** `applyPhasePlanToPhases` redistributes the planned span across the phases it did
   return so the total stays honest, rather than fabricating an empty phase. Extra phases ARE
   dropped. Logged when it happens; not observed in any live run this session.
5. **`goal_ids` has no consumer.** Session A is write-side only by design — Layer 2 is the first
   reader. Until then a link is inert data, and nothing validates that a linked goal still
   exists (a deleted goal leaves a dangling id). Layer 2 must resolve dangling ids defensively.
6. **The capacity card is hidden until capacity exists.** Correct for a fresh profile, but it
   means there is no way to set capacity from the Profile tab *before* creating a goal — the
   first capture is inside goal intake by design. If that ordering ever needs to change, the
   card's `display:none` empty-state branch is the single place to edit.
7. **Profile 4's 8 cloned goals carry no `demand`**, so they contribute zero to the capacity sum
   and its readout reflects only the goals planned under the new shape. Correct behavior (we
   never invent a demand), but worth knowing when reading profile 4's numbers.

### Rejected Approaches & Lessons — Engine v2 arc (2026-07-24 pivot, session #34)

> **These four are REJECTED. Do not re-propose them.** Each is logged with its reason so the next
> working thread does not re-tread rejected ground. Full narrative: `CLAUDE.md` → "Strategic Pivot —
> Engine v2 paused, v1 is the go-forward engine".

1. **The 0.70 work-floor as a session-quality gate — REJECTED.** It incentivizes padding and sparse
   sessions: it measures a **proxy** (time-fill) rather than the goal (**content depth**). The model
   satisfied it the cheap way — few exercises with inflated per-segment minutes — which is precisely
   what produced the thin sessions the athlete rejected. **Any future time/content reconciliation
   must enforce DEPTH (real exercise count per block), not just estimated-minutes-meets-stated-
   minutes.** Note this rejects the floor **as a gate**, not the estimator functions behind it —
   those are on the salvage list below.
   - **EMPIRICAL CONFIRMATION ON REAL v1 CONTENT (added 2026-07-25, session #39 Phase 1 audit).**
     Profile 1's live, **athlete-ACCEPTED** rec estimates at **36/60, 23/45 and 18/30 minutes =
     60% / 51% / 60%** of stated time. **All three options would have FAILED a 0.70 work-floor** —
     on output the athlete actually wanted. This is direct measured evidence that the rejection was
     correct, not just reasoned: the floor would have condemned good content. **Standing constraint
     for Layer 4: the depth floor must never become a time floor by another name.** A depth rule is
     a count of distinct movements per section; it must never be expressed as, derived from, or
     tuned against a minutes-filled ratio.
2. **"Honestly shorten light/rehab days" (the Session 10 recommendation) — REJECTED.** Real PT
   protocols fill full sessions and progress across weeks; the athlete confirmed doing genuine
   45-minute sessions in the early phase of this exact injury. The thinness was a **missing
   progression model**, not a correct low volume, so shortening the label to match thin content
   accepts a thin prescription as correct when it is not.
3. **Bolting maintenance-tier filler onto a thin driver skeleton — REJECTED.** It starves the driver
   goal and papers over the same gap; this is the mixed-session under-fill that dogged the whole arc.
4. **Rebuilding v1's capability as a from-scratch parallel engine (the ENTIRE v2 strategy) —
   REJECTED as the strategy going forward.** **Lesson: ADD to v1.** v1 already produces the depth
   (a real 60-min rec with 16 exercises across 4 labeled sections, with autoregulation reasoning from
   HRV and weekly-target status) and already coexists multiple goals in a single session. Do not
   replace it.

**Context-check findings — settled, do not re-litigate.** Checked against the previous thread's
actual statements: (a) **v1 is NOT context-starved** — 13 ordered blocks, length guard raised
6000 → 28000 in session #17; the "can't see enough context" problem was **v2's PLANNER**. (b)
**"High randomness" was a real finding about the `extract_exercises` call** (temperature), **NOT**
about v1 daily-rec generation. (c) **"Doesn't scale as it learns" was a v2-PLANNER gap** (no
phase/progression context), not a v1 defect — though v1 genuinely lacks **persisted progression
memory**, which is the real forward-looking gap the next design targets.

**SALVAGE from v2 — carry these forward:**
- **⚠ `estimateSegmentWorkMinutes` / `estimateSessionWorkMinutes`** (`server/coachingRules.js`) —
  **EVALUATED AGAINST REAL CONTENT AND DELIBERATELY NOT PORTED (2026-07-25, session #39 Phase 1
  audit). Do not re-propose the port.** The salvage note below was written from inspection; the
  audit measured it and reached the opposite conclusion. Three findings:
  1. **The constants are identical by construction** — `coachingRules.js` derived them FROM v1:
     `WORK_MIN_PER_STRENGTH_SET 1.5 = REC_MIN_PER_SET`, `WORK_MIN_PER_MOBILITY_SET 1.0 =
     REC_MIN_PER_MOBILITY`, `WORK_MIN_REST_PER_HOLD 1.0 =` v1's "+1 min" per hold. There is no
     better arithmetic to import.
  2. **It reads STRUCTURED objects and parses no strings** (`ex.sets`, `ex.reps`, `ex.time_seconds`,
     `seg.type`, `seg.duration_min`). v1 rec sections carry **FREEFORM strings**
     ("Bench Press 3x8 @ 135lbs"), so porting means writing a string→structure parser to feed an
     estimator that computes what `estimateExerciseMinutes` already computes — **the parser IS the
     existing function's entire job.** The port would add a second implementation and a new failure
     surface to arrive back where v1 already is.
  3. **Its two genuine additions fire ZERO times ~~on real content~~ ON THE MOBILITY DAY.**
     ~~Measured on profile 1's live rec (32 exercise lines, 11 sections)~~ Measured on profile 1's
     live **mobility/yoga** rec (32 exercise lines, 11 sections): whole-segment-bare → declared
     minutes never applies (only **3/32 lines bare = 9%**, no section all-bare), and the
     segment-type mobility rate is redundant because `recIsMobilityish()` already catches every
     yoga/mobility name present.
     **⚠ CORRECTED 2026-07-27 (session #41) — the "ZERO times" claim was measured on an INCOMPLETE
     BASIS and contradicted §6 → Session D item 3.** On the **strength** day the all-bare rule fires
     on **1 of 11 sections** (Hand Rehab: `Wrist Circles` / `Reverse Prayer Stretch 30s` /
     `Slow Fist Open and Close`, declared 5 min → estimate 4.0 → 5.0). Correct behaviour, tiny in
     magnitude, and it is the **only** before/after time delta in either day. **This does NOT change
     the decision** — the port stays rejected on findings 1 and 2 (identical constants, no string
     parsing), which are structural and unaffected. What changes is the *stated basis*: the rule was
     taken because it is correct, not because it was inert.
  - **TAKEN INSTEAD:** the all-bare-section rule as a **3-line addition to the existing
    `estimateExercisesMinutes`**, not a port — now implementable because `sections[].minutes` has
    existed since session #31. **HARD INVARIANT: `estimateExerciseMinutes` stays ONE implementation
    with TWO consumers** (`buildTimeBudgetContext` for the prompt, `verifyRecTimeBudget` for the
    verifier) so they can never disagree.
  - Original salvage note, kept for the record: *hand-verified accurate; reusable in v1 as a
    DISPLAY/CONTENT RECONCILER enforcing depth, explicitly NOT as the rejected 0.70 gate.* The
    depth-reconciler INTENT stands and is Layer 4's job — it is the specific v2 **function** that is
    not being carried over.
- **The COEXIST / SEQUENCE / GATE framing and the honest-timeline idea** — genuinely new (neither v1
  nor v2 had them); the novel part of the next design.
- **NOT salvaged:** the single-plan model, the allocation invariant, and the alternate-card UI —
  either regressions, or solutions to problems v1 does not have.

---

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

> **⚠ 2026-07-24 (session #34) — the head of the queue changed.** The Engine v2 arc is **PAUSED**
> and its strategy rejected going forward; focus reverts to **v1**.
>
> **⚠ UPDATED 2026-07-25 (session #35) — the forward direction is now APPROVED as the North Star.**
> It is **"NEXT DIRECTION — the 'PT Brain'"** (below), and the pre-build audit that gated it has
> been run. **The next build session is Session A** (keystone join + Layer 1 + capacity + intake
> negotiation). The pre-existing priority list below (Fitbit→Google Health cutover work, etc.) is
> **unchanged and still valid** — the pivot removed the v2 items from the front of the queue, it did
> not re-order anything else.

**Priority order (updated 2026-07-18 after the session #29 daily_recs outage).** Items 1–3 were **deprioritized during the outage firefight** (profile 1's recs were failing — see the session #29 banner) but remain the active cycle; the Sept-2026 Fitbit shutdown deadline hasn't moved.

> **⚠ Sept-2026 framing corrected (session #31) — read before re-planning this list.** The
> migration is **not** primarily a user reconnect campaign. **Biometrics already run on Google
> Health today** (profile 1 verified serving `source:google_health`), so HRV/RHR/sleep/steps/AZM
> survive the Fitbit shutdown with no further work. The **hard half is the activity-side GH
> build**: `findWearableMatchOnSave()` is Fitbit-first and never asks GH, the unmatched-activities
> card is Fitbit-only, `life-os-summary`'s live fallback is Fitbit-only, and **no GH historical
> backfill exists**. Those are real builds, not reconsent prompts. See §5.

**Newly scoped this cycle (session #31), not yet ordered against the list below:**
- **(a) Workout-output FORMATTING redesign** — rec cards + the history/log view. Shimmy has
  flagged this twice; deliberately deferred to its own session both times. The sectioned rec
  shape shipped in session #31 is the **foundation** for it: options now carry real
  `sections[]` with labels and per-section minutes, so a formatting pass has structure to render
  rather than a flat string list. Explicitly out of scope until scoped on its own.
- **(b) History quick-view card** — workouts-first, sectioned, notes rendered at the end.
  **Gated on (a)** — the card is the surface the formatting work produces.
- **(c) `ai_prompt_context` regeneration on goal change** — the real underlying fix behind
  session #31's B13 workaround. Today `stripEmbeddedGoalsList()` removes the stale prose goal
  list **at daily_recs assembly time only**; the stored prose is still stale everywhere else it
  is consumed (Coach Chat snapshot, roadmap prompts, goal-progress prompts — see §9). The
  durable fix is regenerating (or de-duplicating) `ai_prompt_context` when `goals[]` is
  reordered or edited.

**Newly scoped this cycle (session #32), not yet ordered against the list below:**
- **(d) Editable default rec durations** — a control in **Settings → AI Coaching** to set the
  three default session lengths (currently hardcoded `REC_DEFAULT_LADDER = [60,45,30,15]`),
  persisted per-profile and read by `resolveOptionDurations`. The session #32 **⚙ deep-link
  already lands on the AI Coaching tab, but there is no control there yet** — this is the missing
  control. Touches the rec-generation data path (durations feed the skeleton, TIME BUDGET, and
  verifier), so **audit-first**. Would also need a persistence seam (per-profile setting) that
  the ephemeral `recLengthChoice` deliberately is not.

### THE "PT BRAIN" — ✅ SHIPPED, all four layers (designed session #35; built sessions #36–#40)

> **⚠ STATUS: SHIPPED — this is no longer future work.** ~~DESIGN TARGET — APPROVED AS NORTH STAR;
> BUILD PROCEEDS ONE LAYER PER SESSION.~~ The four-layer model was designed in full on paper
> (session #35), approved, and then **built one layer per session across sessions #36–#40. The arc
> is code-complete.** What remains is **verification**, not construction — see the consolidated
> ledger below, and the two open bugs in §6.
>
> **The design rationale below is DELIBERATELY RETAINED.** It is not a leftover plan: it is the
> record of *why the shape is what it is*, and several of its constraints (code owns every number
> the model would be judged on; the depth floor is content, never a time ratio; the resolution set
> is bounded to three levers) are load-bearing rules that future work must not quietly undo. **Read
> it as specification-of-record, not as a queue.**
>
> It is a **v1-based** design: v1 already produces the depth and already coexists multiple goals per
> session, so this **ADDED to v1** — it did not rebuild it in parallel (that approach is explicitly
> rejected, §6 → "Rejected Approaches & Lessons — Engine v2 arc", item 4). **Roadmap/goal CREATION
> stays on the Sonnet model (quality-critical), not Haiku** — the standing model-routing rule.

---

#### AS-BUILT — what shipped, where it lives, what is still open

**Keystone join — shipped Session A (#36), FIRST CONSUMED Session B (#37).**
`goal_ids: ["<goal uuid>", …]` on `frequency_targets[i]`, `anchors[day][i]` and `addons[i]`.
Additive jsonb, no DDL. Session A was **write-side only, by design**; Layer 2's qualifying-session
matching is the first reader.

| Layer | What shipped | Where it lives | Verified state | Still open |
|---|---|---|---|---|
| **1 — honest per-goal timeline** (#36) | Variable phase counts **derived in code** from an honest per-goal estimate; `goal_type` + `demand` + `estimate`; aggressiveness dial **code-gated by `goal_type`** (`rehab` LOCKED, server-authoritative); global `profile_data.capacity`; intake negotiation bounded to **three** levers | `server.js` — `derivePhasePlan`, `renderPhasePlanForPrompt`, `applyPhasePlanToPhases`, `resolvePhasePlanForGoal`, `ensureGoalDefaults`, `computeCapacityFit`, `enforcePhaseShape`, `mergeGoalsPreservingProtected`; routes `…/goals/:goalId/plan-setup`, `/estimate`, `/negotiate`, `GET …/capacity`. `public/index.html` — `#capacity-card`, `schedGoalPickerHtml`, `schedCarryGoalLinks` | **Verified live** on profile 4 (all three worked targets, dial override, negotiation levers) + 34 local assertions against the real shipped functions | §6 Session A items 1–7 (negotiation exit not signposted, write-before-commit, dangling `goal_ids`, macro still 3+2) |
| **2 — living adaptation** (#37) | `goal.roadmap.arc_state`; **earned position replacing time-elapsed**; gap decay by `goal_type`; re-ramp; **bidirectional** timeline flex; immutable `roadmap.arc_origin` | `server.js` — `computeArcState`, `applyTimelineFlex`, `ARC_DECAY_RATES`, `makeTargetMatcher` (factored out of `buildWeekSkeleton`, byte-identical), arc branch in `recomputeRoadmapProgress`, ARC STATE + ARC REALITY blocks in `adaptGoalRoadmap`. Fires fire-and-forget from `POST /api/workouts`, **zero AI calls** | **Verified live** on profile 4 (earned position, real 22-day-plus gap decay, `needs_regeneration`, legacy roadmaps correctly get no arc) + 41 unit tests | Decay contrast + flex SHORTEN unit-tested only (ledger); §6 Session B items 1–7 |
| **3 — coexistence engine** (#38) | **GATE → capacity (code) → COEXIST \| SEQUENCE** classifier; verdict at **`profile_data.coexistence`**; **propose-and-approve** schedule deltas applied through the single existing `schedPersist()` writer; app-open arc evaluation | `server.js` — `classifyCoexistence`, `buildScheduleDelta`, `targetServesGoal`, `POST …/evaluate-arcs`. `public/index.html` — `capApplyDelta` and the proposal UI | **Verified live** on profile 4 (verdict, delta, reject leaves schedule byte-identical, approve creates linked targets, gate confirm flips the verdict, macro regenerate leaves the verdict intact) + 16 unit tests | Handoff at ≥75%, derived-target-through-week-preview, stale branch of app-open eval (ledger); §6 Session C items 2–6 |
| **4 — session depth** (#40) | Content depth floor **`<8 EXEMPT · 8–14→2 · 15–24→3 · ≥25→4`**; depth reporting in `verifyRecTimeBudget` (**warn-only**); all-bare-section rule; **`buildArcStateContext()` as a protected tier**; `showTab` capacity-card fix | `public/index.html` ONLY — `REC_DEPTH_TIERS`, `recDepthFloorFor`, `recSectionMovementCount`, `recOptionDepth`, `buildSectionDepthContext` (inside `buildTimeBudgetContext`), `estimateExercisesMinutes(list, declaredMinutes)`, `buildArcStateContext`, `showTab` profile branch | Depth **non-regression verified** — 77 checks, two harnesses, real shipped functions extracted from both pre- and post-change files; profile 1 renders normally, athlete-confirmed | **Item (c) NOT verified live** — the single highest-value open check, now blocked by BUG 2; §6 Session D items 1–7 |

**Standing invariants this arc established — do not undo them:**
- **Code owns every number the model would otherwise be judged on** (phase counts, week budgets,
  capacity arithmetic, the dial lock, `position_week`). The model authors words. Direct lesson of
  the rejected v2 work-floor (§6, item 1): *a model must not optimize its own metric.*
- **The depth floor is a count of distinct movements per section. It must never be expressed as,
  derived from, or tuned against a minutes-filled ratio.**
- **`estimateExerciseMinutes` is ONE implementation with TWO consumers** (`buildTimeBudgetContext`
  for the prompt, `verifyRecTimeBudget` for the verifier) so they can never disagree.
- **Layer 3 proposes; it never writes.** The app has exactly one schedule writer, `schedPersist()`.
- **Per-goal roadmaps have variable phase counts. The MACRO roadmap still uses 3+2** — see the
  explicit distinction below.

#### ⚠ PER-GOAL vs MACRO — the easiest thing for a future session to get wrong

| | per-goal roadmap (`profile_data.goals[i].roadmap`) | MACRO roadmap (`profiles.roadmap_data`) |
|---|---|---|
| phase skeleton | **VARIABLE**, derived in code from `estimate` (3+2 retired Session A) | **STILL FIXED 3 `near_term` + 2 `horizon`** |
| `duration_weeks` | derived per phase, lands in `[2,6]` by construction; the **integer 4–6 clamp is retired** | still the original shape |
| progress | **earned position** (`arc_state`) on new-shape goals; time-elapsed **only** on legacy goals with no `arc_state` | still time-elapsed |
| `arc_state` | present on new-shape goals; **absent on legacy 3+2 goals**, which keep time-elapsed progress | **never** present |
| touched by Sessions A–D? | yes | **no** — `MACRO_ROADMAP_SYS` and `adaptMacroRoadmap` were deliberately untouched (§9) |

**Anywhere this doc or `CLAUDE.md` describes "3 near_term + 2 horizon", the integer 4–6
`duration_weeks` clamp, or time-elapsed `progress_pct` without qualification, it is describing
either the MACRO roadmap or a LEGACY per-goal roadmap — never current per-goal behaviour.**

#### PT Brain — consolidated verification ledger (as of 2026-07-27, session #41)

> **The single most important artifact of the close-out.** Shipped and verified are tracked
> **separately**. For every unverified row, the **exact check that closes it** is stated and is
> ready to run. **Do not chase any SHIPPED-UNVERIFIED row with synthetic data** — each one is
> specifically waiting on real data or a real model call.

| # | Layer | Item | State | How verified / EXACT check to close |
|---|---|---|---|---|
| 1 | Keystone | `goal_ids` round-trip survives PATCH + `cleanProfileData` + re-read | **VERIFIED LIVE** | Profile 4: link on a target AND an anchor, PATCH, re-read — both present |
| 2 | Keystone | `schedSaveAnchor` no longer destroys unknown keys | **VERIFIED LIVE** | Profile 4: renamed anchor to "MMA Class (renamed)", duration→75; both `goal_ids` preserved to the server |
| 3 | Keystone | Build-with-AI confirm + carry-forward | **VERIFIED LIVE** | Session #37, **real Haiku build**: confirm fired ("2 items linked"), 2 links carried forward by activity match; a renamed item correctly lost its link |
| 4 | L1 | Variable phase derivation (rehab `[4,3]`; bench `[6,5,5]`+1 horizon) | **VERIFIED LIVE** | Profile 4; budgets sum to the derived total in every case |
| 5 | L1 | Dial lock is **server**-authoritative | **VERIFIED LIVE** | Client sent `sessions_per_week:7` on a rehab goal → stored **5**, `dial_override_applied:true` |
| 6 | L1 | `derivePhasePlan` correctness | **VERIFIED BY TEST HARNESS** | 1..200 integer sweep + worked targets, asserted against the real shipped function |
| 7 | L1 | Capacity fit + negotiation (3 levers, order `slower,capacity,sequence`) | **VERIFIED LIVE** | Profile 4 marathon goal: 420/300 min, 7/3 hard → negotiation fired, `model_levers_valid:true` |
| 8 | L1 | `ensureGoalDefaults` never fabricates a `demand` | **VERIFIED LIVE** | 8 bare goals stayed bare; out-of-enum `goal_type` → `null`; string demand coerced |
| 9 | L2 | Earned position on clean linked weeks | **VERIFIED LIVE** | Profile 4 bench goal: `position 3`, `precise`, tier 1, via `target:Upper Body Strength` |
| 10 | L2 | Gap decay on a real 22-day-plus gap | **VERIFIED LIVE** | Hand-checked: peak 4.5 → Z=4 → `(4−1)×0.5` → position 3.0, `re_ramping`, `re_ramp.since 2026-07-06` |
| 11 | L2 | **Rehab-vs-skill decay CONTRAST** | **⚠ SHIPPED-UNVERIFIED** | Unit-tested against the real shipped `ARC_DECAY_RATES`/decay fn (Z=3 → rehab 3.0, endurance 2.0, strength 1.0, skill 0.2), **never exercised end-to-end on real data**. **Check:** on profile 4, take one `rehab` goal and one `skill` goal through the SAME real gap, then compare their `arc_state.position_week` drop — rehab must fall ~15× further than skill |
| 12 | L2 | Timeline flex **LENGTHEN** direction | **VERIFIED LIVE** | Profile 4: drift exceeded absorbable span → clamped → `needs_regeneration: true` |
| 13 | L2 | Timeline flex **SHORTEN** direction | **⚠ SHIPPED-UNVERIFIED** | 20 unit tests against the real shipped `applyTimelineFlex` (ahead `[6,5,5]` → phase 3 → `3`, estimate 16–28→14–26), **never on real data**. **Check:** drive a profile-4 goal genuinely AHEAD (`drift ≥ +2` sustained across 2 evaluations), then confirm an `upcoming` phase's `duration_weeks` shrinks, the phase COUNT is unchanged, every phase stays in `[2,6]`, and `flex_streak` resets |
| 14 | L2/L3 | **Loud `needs_regeneration` banner on a real drifted goal + inline regenerate** | **✅ NEWLY VERIFIED LIVE (2026-07-27)** | Athlete confirmed on profile 4, goal "Bench press 175 lbs for a single": the caution-bordered banner renders and the inline regenerate action works. **Closes the Session B/C item that had never been human-confirmed** |
| 15 | L2 | Week-preview unaffected by the matcher factoring | **VERIFIED LIVE** | Skeleton sha256 `5ef8579eefec6577…` identical before/after |
| 16 | L3 | Classification + delta + reject/approve | **VERIFIED LIVE** | Profile 4: `sequence`, 275/300 min, **4/3 hard**; reject → schedule byte-identical; approve → 2 targets created with correct `goal_ids` and explicit `stackable`; anchors untouched |
| 17 | L3 | GATE proposal + confirm | **VERIFIED LIVE** | Bench gated by wrist → confirm → 275→240 min, 4→3 hard, verdict flips to `gated_mixed` |
| 18 | L3 | `coexistence` survives a macro regenerate | **VERIFIED LIVE** | A real macro regenerate left `profile_data.coexistence` intact |
| 19 | L3 | **SEQUENCE handoff firing at ≥75% of the lead's arc** | **⚠ SHIPPED-UNVERIFIED** | Code path is wired and logged; **it has never been seen to fire** (the lead's arc is at week 0). **Check:** on profile 4, accumulate real qualifying sessions until the lead goal's `position_week / W ≥ 0.75`, then confirm a handoff proposal is produced exactly once (guarded by `handoff.lead_goal_id`) |
| 20 | L3 | **Derived target visible through the 7-day week preview** | **⚠ SHIPPED-UNVERIFIED** | **Check:** after approving a delta that CREATES a `frequency_target`, open the Schedule card and confirm that target is placed in `#week-preview-section` by `buildWeekSkeleton` with the correct day/duration and counts toward its done-vs-needed status |
| 21 | L3 | App-open arc evaluation — **fresh/skip** branch | **VERIFIED LIVE** | Repeat calls same day → `{skipped:true, reason:"fresh"}` |
| 22 | L3 | App-open arc evaluation — **STALE** branch | **⚠ SHIPPED-UNVERIFIED** | Only the fresh branch was exercised. **Check:** let >24h pass with no workout save on profile 4 (or back-date `last_evaluated`), open the app, and confirm the boot call actually re-evaluates — `arc_state.last_evaluated` advances and decay accrues **with zero AI calls** |
| 23 | L4 | Depth **non-regression** on profile 1 | **VERIFIED BY TEST HARNESS** | 77 checks, two harnesses, real shipped functions extracted from BOTH `HEAD` and post-change `public/index.html`; per-section counts/strings/declared minutes byte-identical: strength `[[3,4,4,3],[2,3,4,3],[2,3,3]]`, mobility `[[3,4,3,3,1],[2,4,3,1],[4,3]]`, legacy `[[4]]` |
| 24 | L4 | **Profile 1 renders normally post-Layer-4** | **✅ NEWLY VERIFIED LIVE (2026-07-27)** | Athlete confirmed: rec cards generate; capacity card and profile cards load correctly on boot AND on tab switch; no depth regression observed. This is the human confirmation behind row 23 |
| 25 | L4 | Depth table ratified against both a mobility and a strength day | **VERIFIED** | 12 gated sections, **zero flagged**; 5 sit at exactly zero margin (deliberate — §6 Session D item 1) |
| 26 | L4 | Prompt budget: profile 1 fits with no extra trim | **VERIFIED** | 27,223 / 28,000, headroom 777, arc block **0 chars** (profile 1 has 8 goals, ZERO arc goals) |
| 27 | L4 | Capacity card renders on boot + tab switch | **VERIFIED LIVE** | See row 24 (athlete-confirmed). Idempotent across 5 repeated calls against the real shipped function |
| 28 | **L4 — item (c)** | **A re-ramping goal produces a visibly lighter, rebuild-the-base rec** | **⚠ PARTIALLY CLOSED (2026-07-27, session #42) — criterion (iii) PASSES; (i) and (ii) STILL OPEN, and now blocked on DATA, not on BUG 2** | **No longer blocked by BUG 2** (resolved — designed check-in gate) and the generation path is proven: two REAL model calls were made on profile 4 through the **category path**, which `fetchAI` short-circuits into `altRec` and returns from **before** any `localStorage` write and before `cacheAIRecOnServer` — **provably write-free**, confirmed at runtime (zero non-GET calls besides `/api/ai`). **A** = arc block present (628 chars, prompt 27,120); **B** = identical state with the arc fields stripped in memory only (0 chars, 26,492); 628-char delta. **(iii) PASSES — but vacuously, and that is stated, not glossed:** the rec contains **no position / drift / week number at all**, so it cannot state one that was not injected; it does not prove the model would resist inventing a number while narrating progress. **(i)+(ii) cannot be judged from this pair** — the only arc goal on profile 4 is `stalled`, **not** `re_ramping`, so the block's re-ramp instruction never applied. Structurally the arc run came back marginally **denser**, not lighter (opt1 16 movements/~33 sets vs 14/~28), the three "rebuilding" hits are about **pubic osteitis** not the arc goal, and **the arc goal never appears in `goal_tags` in EITHER run**. **REMAINING CHECK, and it needs real data:** a goal must actually reach `re_ramping`, which `computeArcState` grants only when `preGapPeak > decayed` — i.e. a real earned peak followed by a gap. The wrist goal's peak is 0, so the back-dated-`last_evaluated` nudge **cannot** produce one (the replay is pure and deterministic; see row 22, which that nudge WOULD close). The bench goal could, but BUG 3 destroyed its `arc_origin` and it is **not recoverable** (see row 31). **Two honest routes: (1) let profile 4 accumulate real qualifying sessions on the bench goal until a genuine peak-then-gap forms — the BUG 3 fix now protects the origin; (2) the athlete states the bench roadmap's intended phase-1 start date as a product decision, after which the replay derives everything else from the real log.** |
| 29 | Arc | **BUG 1 — 413 on `/goal-progress` (profile 1)** | **🐞 OPEN BUG — FULLY AUDITED 2026-07-27 (session #42), FIX DESIGNED, DEFERRED by decision. No limit bump applied** | **Audited with measured numbers, read-only.** POST-only (**no GET route exists**; a GET 404s with an HTML page — same `<!DOCTYPE` symptom, different status). Limit is the `express.json()` default **100 KB** (`server.js:92`, no options), bracketed live at 101,357 B → 200 / 103,405 B → 413 `text/html`. Real body **207,357 B = 202.5 KB = 2.02×**, split **exercises 104,059 (50.2%) / workoutLog 65,689 (31.7%) / goals 37,483 (18.1%)**. **The §9 reconciliation is settled: the client blob is 81.9% and is 1.66× the limit on its own (the CAUSE); accumulated `profile_data` is 18.1% and under the limit on its own (an AGGRAVATOR).** Migration adds ~4% (+8,653 B → 2.11×) — not the cause, and not migrating would not fix it. **Fix designed:** the handler is stateless and `profileId` is assigned but never used — stop sending `exercises`+`workoutLog` and let the server fetch its own (**202.5 KB → 37.6 KB**, drop-in), then stop sending `goals` too (**<1 KB**, migration-proof). **This is the next session.** §6 → "BUG 1 — AUDIT RESULT"; §9 |
| 30 | Arc | **BUG 2 — no rec on Today for profile 4** | **✅ RESOLVED 2026-07-27 (session #42) — NOT A BUG** | Designed behaviour: profile 4 has `fitbit:false` and no wearable, so `syncFitbit()` → `showManualCheckin('no_fitbit')`, and only the branch finding a same-day `localStorage.ac_cache.manualCheckin` shows `#ai-card` and calls `resolveAIRecs()`. No check-in ⇒ no rec rendered and none requested. Candidate (b) ruled out by measurement (all 11 builders OK, assembly 27,193/28,000); candidate (c) disproven in code (`grvRegenerateFromBanner` has no rec trigger). **No longer blocks row 28.** §6 → "BUG 2 — RESOLVED" |
| 31 | **L2 — BUG 3** | **`arc_origin` + `arc_state` destroyed by roadmap adapt AND regenerate** | **✅ FIXED + VERIFIED (2026-07-27, session #42), `ae46a96`** | Found while ruling out BUG 2's candidate (c); in no document before. Both rebuild sites (`adaptGoalRoadmap:7019`, `generateGoalRoadmapForGoal:7696`/`:7711`) rebuilt `goal.roadmap` from scratch and dropped both fields — **the same bug class as the session-#35 `roadmap.estimate` drop, at the same two sites.** `arc_state` self-heals (pure replay) but **`arc_origin` does not** — it re-pins from `near[0].start_date` while both writers rebuild the calendar from today, so the origin walked forward on every adapt and discarded every earned week (session #37 bug #1 through a different door). **Live evidence:** the bench goal, regenerated 2026-07-26T02:47:22.417Z, lost both where row 10 recorded `position 3.0 / re_ramping / since 2026-07-06`. **Verified:** real shipped functions extracted from BOTH `git HEAD` and the working tree, frozen clock, real profile-1 + profile-4 fixtures, **9/9** — arc goal keeps both byte-identical through adapt/regenerate/reset; **legacy goal (profile 1 "Fix Posture") byte-identical pre vs post on all three paths**; only the two arc keys ever added. Suites 213/213. Profile 1 `profile_data` byte-identical pre vs post deploy. **Residual: the already-destroyed bench origin is NOT recoverable — see row 28 and §9.** |

**Profile 1 was byte-identical across Sessions A, B and C** — goals sha256 `0901b047d1c95f50…`
before and after each — and Session D was the first to change code it runs daily, which is why
depth non-regression was that session's primary success criterion (rows 23–24).

---

#### KEYSTONE JOIN — ✅ SHIPPED Session A (#36); FIRST CONSUMED Session B (#37)

> Design rationale below, retained. Session A was **write-side only by design** — nothing read
> `goal_ids` until Layer 2's qualifying-session matching.

Schedule items gain goal linkage:

- `profile_data.schedule.frequency_targets[i].goal_ids = ["<goal uuid>", …]`
- the **same optional field** on `anchors[day][i]` and on `addons[i]`

**Additive, jsonb-only, no DDL.** This is the join that lets roadmap phases inherit the schedule's
real done-vs-needed status tracking — closing the "**no status tracking at all**" gap named in the
Division-of-Labour paragraph of `CLAUDE.md` → "Goal Roadmap Emphasis in the Rec Prompt". Today the
schedule knows `Upper Body Strength 0/1 [NEEDED]` and the roadmap knows what to emphasize, and
nothing connects the two. Layer 2's earned-position math is computed from the log **through this
join**, so it cannot ship without it.

---

#### LAYER 1 — HONEST PER-GOAL TIMELINE (+ aggressiveness dial) — ✅ SHIPPED Session A (#36)

> **As-built refinement:** `estimate` lives in **two** places (`goal.estimate` = current;
> `goal.roadmap.estimate` = the copy taken at generation). See "Storage shape as built" below —
> the divergence is a feature, and it is how the UI honestly says "your roadmap is behind your
> current settings."

**New goal fields** (on `profile_data.goals[i]`):

- `goal_type` — `rehab | strength_load | endurance | skill | habit | body_comp`
- `demand` — `{ sessions_per_week, minutes_per_session, hard: bool, min_viable_sessions_per_week }`

**New roadmap field** (on `goals[i].roadmap`):

- `estimate` — `{ total_weeks_low, total_weeks_high, assumed_frequency, basis }`, where `basis` is
  the honest, plain-language **"why this long."**

**Phase count DERIVES from the estimate.** Near-term phases cover roughly the next **12–16 weeks**;
horizon phases cover the remainder. **The fixed 3 near_term + 2 horizon skeleton is retired** — a
6-week rehab goal gets ~2 near-term + 0 horizon; a 1-year goal gets 3+3. **Same generator, variable
output.** The existing phase-card UI is unchanged — only the card count varies.

**AGGRESSIVENESS DIAL.** `assumed_frequency` is user-settable at goal creation and editable later.
Changing it **re-estimates the timeline and re-runs the capacity check**. It is **CODE-GATED BY
`goal_type`**, not prompt-gated:

| `goal_type` | dial |
|---|---|
| `rehab` | **LOCKED.** Timeline moves only on real healing evidence via Layer 2 — **never on effort.** Show the honest reason in the UI. |
| `strength_load`, `endurance`, `body_comp` | available |
| `skill` | in between — more training helps, but the ceiling is real |

**This gate lives in code, not in a prompt.**

---

#### CAPACITY — global, on the profile, NOT per-goal — ✅ SHIPPED Session A (#36)

```
profile_data.capacity = { days_per_week, minutes_per_day, hard_sessions_per_week, protected_days[] }
```

**Two axes on purpose: time AND recoverable hard sessions.** CNS load is usually the binding
constraint, not the clock. **Captured at first goal creation, not at onboarding.**

---

#### INTAKE NEGOTIATION — Layer 3's conflict check, moved forward — ✅ SHIPPED Session A (#36)

After intake answers, **before roadmap generation**, code sums the new goal's `demand` plus all
existing goals' `demand` against `capacity`. If it doesn't fit, the AI surfaces the conflict and
negotiates using **EXACTLY three levers**:

1. **Go slower** — longer timeline at lower frequency.
2. **Add capacity** — more days or longer sessions ("at 30 min/day you get one of these; at 50 you
   get both").
3. **Sequence** — one leads, the other holds at `min_viable`.

**The resolution set is bounded to those three. The AI never freestyles another outcome.**

---

#### LAYER 2 — LIVING ADAPTATION (earned position, not elapsed time) — ✅ SHIPPED Session B (#37)

> **As-built additions not in the original design:** an **immutable `roadmap.arc_origin`** (pinned
> once at first evaluation — without it `applyTimelineFlex` → `resequenceNearTermDates` moved the
> replay start on every flex and wiped every earned week), and `goal.arc_transition_at`.
> **Applies to new-shape roadmaps only** — legacy 3+2 roadmaps get no `arc_state` and keep
> time-elapsed progress.

**New persisted object** `goals[i].roadmap.arc_state` — additive jsonb, no DDL:

```
{ position_week, calendar_week, drift,
  status: on_track|ahead|behind|stalled|re_ramping|paused,
  re_ramp: {from_week, target_week, started_date} | null,
  evidence: {qualifying_sessions_28d, expected_28d, longest_gap_days},
  last_evaluated }
```

**CORE RULE: the calendar does not advance you; doing the work does.**

- Week meets the phase's expected frequency → **+1**
- Partial, ≥50% → **+0.5**
- Zero → **0**, with decay after **2 consecutive zero weeks**
- A gap of N weeks steps position **BACK** by `f(N, goal_type)` — endurance ~1:1, strength ~1 per 2
  off, skill ~0, rehab fast — and sets `re_ramping`

**`position_week` is COMPUTED IN CODE, deterministically, from the log via the keystone join. The
AI never owns the number** — it narrates it and rewrites phase content when thresholds are crossed.
This is the direct lesson of the rejected v2 work-floor (§6, item 1): **a model must not optimize
its own progress metric.**

**Timeline flexes both directions.** Sustained drift **> +2** → pull remaining phases in; **< −2** →
spread them and say so in `timeline_note`. Actual frequency below `assumed_frequency` → stretch
proportionally with an honest note.

**Replaces time-elapsed `progress_pct`** with `position_week / total_weeks` (earned progress). Same
progress-bar UI, different number, plus a small `re_ramping` status chip.

---

#### LAYER 3 — COEXISTENCE ENGINE — ✅ SHIPPED Session C (#38)

> ~~**⚠ DESIGN DISCUSSION STILL REQUIRED BEFORE ITS BUILD SESSION — do NOT blind-build.**~~
> **That discussion happened and the layer shipped.** Two design questions the original left open
> were answered as follows, and both answers are load-bearing:
>
> - **⚠ STORAGE MOVED: the verdict lives at `profile_data.coexistence`, NOT
>   `profiles.roadmap_data.coexistence` as named below.** Phase 1 found `roadmap_data` is **null on
>   3 of 5 profiles**, and that **both** macro writers (`POST /roadmap-data`, `adaptMacroRoadmap`)
>   rebuild the column from a fixed key list and would have silently dropped the verdict on the next
>   regenerate — the Session A `roadmap.estimate` bug class, caught by inspection this time.
>   **Proven moot live:** a real macro regenerate left `coexistence` intact.
> - **⚠ "The verdict WRITES the schedule" (below) is NOT how it was built. It PROPOSES.** The
>   verdict produces a schedule **delta proposal**; *approving* is what applies it, through the
>   ordinary `schedPersist()` path — so the app still has **exactly one schedule writer** and
>   `goal_ids` round-trip like any athlete edit. Rejecting leaves the schedule byte-identical and
>   keeps `athlete_decision_required: true`. **Auto-apply is rejected for now** and is logged as a
>   possible future opt-in setting (below, "DO NOT BUILD").
>
> Also as-built: deltas touch **`frequency_targets` only** — anchors are the athlete's fixed
> commitments and are never read or written; addons are excluded because presence-level matching
> cannot verify them.

Classifier ordering: **GATE → capacity sum (code) → COEXIST | SEQUENCE.**

Verdict persisted at ~~`profiles.roadmap_data.coexistence`~~ **`profile_data.coexistence`**:

```
{ verdict, capacity_used, lead_goal_id, maintenance_goal_ids[], gated[],
  conflict_note, next_review, athlete_decision_required }
```

**SEQUENCE handoff fires at ~75% of the lead's arc.** ⚠ **Shipped and wired, but it has never been
seen to fire** — ledger row 19.

~~The verdict **WRITES the schedule**~~ **As built, the verdict PROPOSES a delta** (`times_per_week`
from the allocation; maintenance goals at `min_viable`) — **and the athlete controls the spectrum**:
set anchor days manually, let the AI fill fully, or anywhere in between. The AI adapts around
anchors and pushes missed work later, extending the existing 7-day-preview carry-forward.

~~**Open design items for that session: the write-vs-propose UX, and the spectrum control.**~~
**Both resolved — propose-and-approve, see the banner above.**

---

#### LAYER 4 — SESSION DEPTH — ✅ SHIPPED Session D (#40)

- ~~Swap `estimateExerciseMinutes`'s role for the salvaged, hand-verified
  `estimateSegmentWorkMinutes` (from `server/coachingRules.js` — §6 SALVAGE list).~~
  **⚠ SUPERSEDED by the session #39 Phase 1 audit (2026-07-25): the port was measured against real
  content and REJECTED.** The constants are identical by construction, and the v2 function parses no
  strings while v1 sections are freeform strings. ~~and its two genuine additions fire **zero
  times** on profile 1's real 32-line / 11-section rec.~~ **⚠ CORRECTED 2026-07-27:** the
  "fires zero times" measurement was taken on the **mobility day only** — on the strength day the
  all-bare rule fires on **1 of 11 sections**. The rejection stands regardless (it rests on the two
  structural findings, not on the rule being inert). **Kept the existing `estimateExerciseMinutes`**
  and took only the **all-bare-section rule as a 3-line addition**. **HARD INVARIANT held: one
  implementation, two consumers** (`buildTimeBudgetContext`, `verifyRecTimeBudget`). Full reasoning
  in §6 → SALVAGE list.
- ✅ **Depth floor expressed as CONTENT** — a minimum number of **distinct movements per section**,
  scaled to section minutes. **As built and ratified: `<8 EXEMPT · 8–14→2 · 15–24→3 · ≥25→4`**
  (`REC_DEPTH_TIERS` / `recDepthFloorFor`, `public/index.html`), validated against 12 gated sections
  across a mobility day and a strength day with **zero flagged**.
  **Explicitly NOT a time-fill ratio** — that is the rejected 0.70 gate (§6, item 1), and profile
  1's own **accepted** recs measure 60% / 51% / 60% of stated time, i.e. all three would have failed
  it.
- ✅ **Prompt-side first.** `verifyRecTimeBudget` **stays warn-only** — no regenerate loop was added.
  Per the North Star, add one only if a week of live use shows the prompt alone doesn't hold.
- ✅ **`arc_state` drives prescribed volume/intensity** via `buildArcStateContext()`, inserted beside
  `roadmapEmphasisContext` as a **protected tier**. ⚠ **The block's construction is verified; the
  model's response to it is NOT** — that is item (c), ledger row 28, the last open link in the
  Layer 2 → Layer 4 chain.

---

#### EXERCISE SELECTION — DECIDED

The AI **continues to prescribe from its own knowledge as free text**. The wger catalog is **NOT**
injected into the rec prompt and the model is **NOT** constrained to it — that is the same failure
shape as the rejected 0.70 gate (§6, item 1): optimizing the measurable at the cost of session
quality. **Improve exact/alias match rates and catalog top-ups for gaps instead.** Revisit only
after Layer 1 ships.

---

#### TEST STRATEGY

- ✅ **Profile 4 is the test bed**, `engine_v2` flipped **OFF** in Session A (#36). That was a
  **flag flip only** — **NOT** the full v2 decommission, which stays a separate parked task (§9).
- ✅ Profile 4 **kept its cloned real training history** (needed for Layer 2's gap/re-ramp math) and
  got **fresh-built goals under the new shape**. It is the only profile carrying new-shape goals,
  `arc_state`, `capacity` and `coexistence` simultaneously — which is also candidate cause (b) for
  BUG 2.
- 🔲 **Profile 1 has NOT migrated.** See the decision block directly below.

#### ⚠ PROFILE 1 MIGRATION — A FLAGGED ATHLETE DECISION, NOT A TASK

> **This is not queued work. It is a call the athlete has to make deliberately, with both costs on
> the table. Do not action it as part of another session's scope.**

Migrating profile 1's **three legacy 3+2 roadmaps** to the new shape is **the entire point of
Layers 1–3** — until it happens, the athlete's own profile gets none of the honest-timeline,
earned-position or coexistence behaviour, and its arc block contributes 0 chars to the daily rec.
It has **two known costs**, both real, neither a blocker:

1. **It overwrites roadmaps carrying real adaptation history.** Regeneration is how migration
   happens; those three roadmaps hold genuine `adaptation_log` entries and version history built up
   over months. (The Coach-Chat regen path preserves `version`/`adaptation_log` rather than
   resetting them — worth confirming which path a migration would take before running it.)
2. **It pushes the daily-rec prompt over budget.** Profile 1 currently sits at **27,223 / 28,000
   chars with the arc block contributing ZERO**, precisely because it has no arc goals. Migration
   **activates `buildArcStateContext()` on every top-3 goal** and pushes the prompt over, costing
   **one extra trim-ladder rung** (`coachingBrief 2343 → 400`, worth ~1,943 chars) on the heaviest
   days. That is the ladder working as designed and it is bounded to a single rung — but it means
   trading some coaching-brief context for arc context.

~~**⚠ It also likely worsens BUG 1.**~~ **⚠ SUPERSEDED BY MEASUREMENT — 2026-07-27, session #42.
The BUG 1 audit is done and it changes this input.** Original concern: `arc_state` would land on
every goal and grow exactly the payload the 413 is about.

**TWO NEW INPUTS, both measured, both making migration EASIER to justify than it was:**

1. **BUG 1 is NOT migration-caused, and migration does not meaningfully worsen it.** The real
   profile-1 POST body is **207,357 B = 202.5 KB = 2.02×** the 100 KB limit **today**, and the
   accumulated `profile_data.goals` is only **18.1% of it (37,483 B) — under the limit on its own**.
   The cause is the client blob (`exercises` + `workoutLog` = **81.9%**, already **1.66×** on its
   own). Migration adds a measured **+8,653 B → 210.9 KB (2.11×), i.e. ~4%**.
   **⇒ Not migrating does not fix BUG 1, and migrating does not cause it.** The two decisions are
   now independent. (Full numbers: §6 → "BUG 1 — AUDIT RESULT"; §7 ledger row 29.)
2. **A real blocker existed that nobody had identified, and it is NOW CLOSED.** Until session #42,
   **every weekly auto-adapt and every regenerate silently destroyed `arc_origin` + `arc_state`**
   (§6 → BUG 3; ledger row 31). Profile 1 was unaffected only because it has **zero** arc goals —
   it would have **inherited the bug on the first workout save after migrating**, and because
   `arc_origin` does not self-heal, its earned arc position would have been reset on essentially
   every save. **Migrating before the fix would have produced a Layer 2 that silently never
   worked.** Fixed and verified in session #42 (`ae46a96`), including a byte-identical
   non-regression check on profile 1's own three legacy roadmaps.

**Cost 2 above (the extra trim rung) still stands and is unchanged** — and session #42 added a
data point in its favour: profile 4, carrying **1** arc goal, assembled at **27,193 / 28,000 with
headroom 807 and only the usual `historicalBrief->400` rung** — it did **not** need the projected
`coachingBrief→400`. A three-arc profile is still heavier, so the single extra rung remains the
honest planning assumption for profile 1, not a certainty.

---

#### BUILD ORDER

| Session | Scope |
|---|---|
| **A** | ✅ **SHIPPED 2026-07-25 (session #36).** Keystone join + Layer 1 + capacity + intake negotiation |
| **B** | ✅ **SHIPPED 2026-07-25 (session #37).** Layer 2 — arc_state, gap decay + re-ramp, code-owned timeline flex, first consumer of `goal_ids` |
| **C** | ✅ **SHIPPED 2026-07-25 (session #38).** Layer 3 — classifier, verdict, propose-and-approve delta, handoff, app-open arc evaluation |
| **D (Layer 4)** | ✅ **SHIPPED 2026-07-25 (session #40).** Session depth — depth floor as CONTENT, arc-state block, all-bare-section rule, capacity-card fix. **The four-layer PT Brain arc is code-complete.** |
| **Close-out** | ✅ **2026-07-27 (session #41), documentation only.** Arc-level state consolidated; §7 promoted from design target to shipped; the consolidated verification ledger written; two post-Session-D bugs logged; two items newly verified live; doc contradictions resolved. |

> **⚠ NO NEW FEATURE WORK until Session D item (c) is closed (ledger row 28).** It is the last
> unproven link in the Layer 2 → Layer 4 chain and the entire athlete-facing payoff of the arc: a
> re-ramp that the athlete cannot *see* in their session is a re-ramp the arc did not deliver.
> **Order: diagnose BUG 2 → then BUG 1 → then close item (c).** BUG 2 comes first because profile 4
> is where item (c) has to be verified and it currently renders no rec at all.

#### Session D — decisions of record

- **The depth table is `<8 EXEMPT · 8–14→2 · 15–24→3 · ≥25→4`, ratified UNCHANGED against both a
  mobility day and a strength day (12 gated sections, zero flagged).**
- **Thresholds held AT the measured line, not dropped a notch.** The number is stated in the prompt
  (target role — a low minimum invites regression) and applied in the verifier (tripwire role — at
  the line it is tight). Prompt role wins on asymmetric cost. If spurious warns appear in real use,
  **drop `≥25` to 3; never raise a tier.** See §6 → Session D item 1.
- **`estimateSegmentWorkMinutes` was NOT ported** — measured and rejected (§6 SALVAGE). Only the
  all-bare-section rule was taken, as a 3-line addition. `estimateExerciseMinutes` remains ONE
  implementation with TWO consumers.
- **`verifyRecTimeBudget` stays warn-only.** No regenerate loop was added. Per the North Star, add
  one only if a week of live use shows the prompt alone does not hold.

#### Logged session #40 — DO NOT BUILD (four items, deliberately not built; scope stayed locked)

- **L1. SESSION PACING / CIRCUIT-STYLE ESTIMATION.** The estimator assumes straight-set training
  with per-set rest. This athlete trains Main blocks as **circuits**. Live example: Option 1's Main,
  4 movements × 3 sets, estimated ~33 min; the athlete's own math (~60s work + ~60s rest per
  movement, circuit) lands at **15–20 min**. So stated section time runs long against how the
  session is actually performed, which reads as "not dense enough". Likely shape of the fix: a
  **training-style preference** (straight sets vs circuit/superset) captured on the profile and
  consumed by **BOTH** `estimateExerciseMinutes` and the TIME BUDGET prompt block — which means it
  **must preserve the ONE-implementation / two-consumer invariant**. ⚠ This is a **TIME-calibration**
  issue, explicitly **NOT** a depth issue, and **NOT** a reason to revisit the rejected 0.70
  work-floor (§6). Medium value, no deadline.
- **L2. SECTION-LABEL MISPLACEMENT.** When a rec carries both an ADD-ON and a HAND REHAB section,
  hand-rehab movements land in ADD-ON anyway. Live: Option 1 put `Tabletop Lumbrical Curl` in ADD-ON
  while HAND REHAB existed below it; Option 2 put both `Tabletop Lumbrical Curl` **and**
  `Pinky Abduction` in ADD-ON while HAND REHAB existed. Athlete's read: those belong in HAND REHAB,
  and ADD-ON has room for 2–3 more posture/core movements in the same 10 min. This is section
  **ASSIGNMENT** (which header a movement goes under), separate from section **DEPTH** (how many per
  section) — **the depth floor does not fix it.** Fix is prompt-side guidance in the
  flexible-sections rules block: when a dedicated section exists for a movement class, route those
  movements there. Cheap, but **must not reintroduce the mandated-section padding trap** (§9
  "None provided" filler). Low effort, real polish value.
- **L3. COEXISTENCE-AWARENESS IS ABSENT FROM THE DAILY REC.** Layer 3's verdict
  (`profile_data.coexistence`: lead goal, maintenance goals, gates) reaches the **schedule** via
  approved deltas but never reaches `fetchAI`'s prompt. So a session serving a maintenance-tier goal
  during a SEQUENCE block is never framed as one, and a **gated** goal is not explicitly excluded
  from rec content. Architecturally this is the same move Layer 4 just made for `arc_state`: a
  small, self-capped, code-supplied **protected-tier block the model narrates but never authors**.
  Deliberately out of every session's scope so far — logged as the honest gap, not a defect. Would
  close the loop between Layers 2, 3 and 4.
- **L4. CATEGORY + INTENSITY IN ONE ACTION.** Today the category pills fire
  `filterRecsByCategory` → `fetchAI({alternative:{mode:'category'}})`, while intensity is a separate
  Low/Medium/High control in `#rec-controls` (`recIntensityChoice`). The athlete wants to pick them
  together — "Strength Hard", "Cardio Light". **FIRST STEP WHEN PICKED UP IS AN AUDIT, NOT A BUILD:**
  confirm whether `recIntensityChoice` reaches the category-override call path at all, since the
  category override prepends a CATEGORY OVERRIDE block that "takes priority over everything else in
  this message" and swaps `buildScheduleInstruction` for a suppressed note — **intensity may be
  getting drowned the same way the schedule once drowned the category filter. If it doesn't carry,
  that is a live bug, not a UX request.** Then design the combined control (likely an intensity
  choice surfaced on the category pill itself). **Same open question applies to SESSION LENGTH.**
  Reuses the existing `#rec-controls` surface; no new paradigm.

#### Session C — decisions of record

- **Verdict lives at `profile_data.coexistence`**, not `roadmap_data`. See the session #38 banner
  for why; the macro paths were not touched and the choice is proven live.
- **Propose, never write.** Approving applies the delta through `schedPersist()`. Rejecting
  stores the verdict, leaves the schedule byte-identical, and keeps
  `athlete_decision_required: true`. **Auto-apply is rejected for now** — revisit as an opt-in
  setting once the athlete has seen enough proposals to trust them.
- **Anchors are never in a delta.** Deltas touch `frequency_targets` only.
- **Addons are out of scope and stay untracked** — presence-level matching cannot verify them.
  **Related clarification (do NOT build):** a goal that genuinely needs only ~10 min/day belongs
  in the normal goal system as a **low-demand goal with its own tracked `frequency_target`**, not
  as an addon. It then appears in the roadmap and the capacity math like any other goal. Addons
  remain what they are: unverified extras layered onto other sessions.
- **Goal creation classifies in RECORD-ONLY mode** — the Session A negotiation was already the
  athlete's decision for that moment, so no proposal is produced there.

#### Also logged this session (DO NOT BUILD)

- **Auto-apply as an opt-in setting.** Once proposals have earned trust, a per-profile setting
  could apply low-risk deltas (frequency changes on already-linked targets) without asking, while
  still requiring approval for `create` and `link_existing`.

#### Storage shape as built (session #36 refinement, approved)

The North Star named `estimate` as a roadmap field. As built it lives in **two** places, because
the estimate is produced *before* the roadmap exists (it is what the phase plan is derived from):

| Location | Meaning |
|---|---|
| `goal.estimate` | the **current** estimate — what the dial reads and writes |
| `goal.roadmap.estimate` | a **copy taken at generation** — what *this roadmap* was actually built from |

They are normally identical and diverge only between a dial change and its regeneration
completing. That divergence is a **feature**: it is how the UI honestly says "your roadmap is
behind your current settings." A single field cannot express it. Verified live: after moving the
dial 2→3, `goal.estimate` read `16–28 @3x` while `roadmap.estimate` still read `16–32 @2x`.

#### Also logged this session (DO NOT BUILD — design items)

- **Goal completion behavior.** When a goal is accomplished, the athlete chooses: **stop
  entirely / hold at maintenance level / roll into a new higher goal.** Interacts with Layer 2
  `arc_state` (a completed goal's arc must stop advancing) and with the capacity sum (a goal held
  at maintenance still consumes budget; one that stops does not — today `DONE` is simply
  excluded). **Design before the Layer 2 build.** Related prior art: the **ACHIEVED MILESTONES**
  never-auto-escalate precedent (`CLAUDE.md` → "Progression Signals in the Daily Rec Prompt") —
  a completed milestone becomes a *baseline* to work at or above, and the app asks the athlete
  rather than inventing the next tier. The same principle should govern goal completion.
- **Ask-AI-to-optimize goal order.** Session #36's merge guard makes stored goal order
  authoritative (array order IS priority), so the Profile Builder can no longer silently re-rank
  goals. Deliberate reordering stays in the existing Prioritize UI. The wanted addition is an
  **explicit** action: ask the AI to propose an optimized order, **show the proposed order**
  before applying, and offer **one-tap revert** to the prior ranking.
- **Intake question overlap audit (logged session #37, DO NOT BUILD).** Step 3 now captures
  frequency and session duration **structurally** (`goal_type`, `demand`, `assumed_frequency`),
  but the older Haiku-generated intake questions still ask for the same things in prose ("how
  much time can you give this?"), so the athlete answers twice and the roadmap prompt receives
  both. Audit which questions are now redundant and trim them in a dedicated session. **Must not
  break existing `intake_answers`** — they are keyed by question `key` and are read back by the
  roadmap generator and the Step 3 plan-setup call.
- **`goal_ids` in the Build-with-AI schedule skeleton.** Deferred from session #36. The builder
  already has the athlete's goals in its prompt and could link at build time, but it is a Haiku
  call whose output would need its own validation (real goal UUIDs, no hallucinated ids). The
  G3 confirm + carry-forward guard ships instead. Cheap to add later.

### Engine v2 — Planner / Autoregulator (parallel build, feature-flagged)

> **⚠ ARC PAUSED 2026-07-24 (session #34) — this whole block is the RECORD of a completed-then-
> paused build, NOT an open queue.** The athlete judged the v2 sessions a **depth regression from
> v1**; focus reverts to v1 and the **v2 strategy itself is rejected going forward** (see the top
> banner, §6 → "Engine v2 arc PAUSED — current state of record" and "Rejected Approaches &
> Lessons"). **v2 code remains in the repo, flag-gated off — nothing deleted, nothing reverted, no
> tables dropped; profile 4 is still `engine_v2 = true`.** The queued items named throughout this
> block — **(B) advancement, (D) within-phase ramp, the session-composition settings UI** — are
> **PARKED, not next**. Do not start them without an explicit decision to resume the arc. The
> forward direction is the section directly above.

> **✅ ENGINE v2 COMPLETE (all 7 phases, 2026-07-22).** A feature-flagged two-cadence coaching
> engine running on profile 4, with profile 1 / all v1 profiles byte-identical throughout.
> **What it is:** a weekly **planner** (Sonnet) reconciles goals/tiers/schedule/roadmap-emphasis/
> injuries/rules into a persisted training block + a week of `planned_sessions`; a nightly
> **autoregulator** (Haiku) edits today's session against readiness + mat load + effort; an
> on-demand **variant** endpoint (Haiku, streamed) transforms today's session on request
> (cache/code/model routing); a flagged **UI** renders it all as a pure DB read; and **Coach Chat**
> is a concierge that sees all v2 state and proposes plan edits (confirm-first). Everything is
> rules-driven (`server/coachingRules.js`, one source consumed as prompt text AND code) with
> deterministic **invariants enforced in code** (97 unit tests across the rules/planner/variant
> harnesses).
>
> **The seven phases:** (1) audit; (2) migrations + rules module + progression/dossier builders +
> audit endpoint; (3) planner + block/session persistence + the first real plan; (3.5) correctness
> pass (computed recency, `time_seconds` schema fix, time-budget verifier, invariant proofs);
> (4) nightly job + autoregulator + ≤4-object alternate cache; (5) variant endpoint + conversational
> constraints; (6) flagged Today UI (today card, variant surface, week view, effort tap, defaults,
> tiers); (7) Coach Chat concierge.
>
> **Migrations to run (files in `migrations/`, all UNRUN except where noted):** the profile-4 clone
> set (✅ RUN + verified), `2026-07-22_v2_training_tables.sql`, `2026-07-22_v2_profile_columns.sql`,
> `2026-07-22_v2_workouts_session_effort.sql`, `2026-07-22_v2_profile4_tiers_and_schedule_v3.sql`,
> and `2026-07-22_chat_proposals_v2_types.sql` — **ALL ✅ RUN.** The Phase 7 apply cycle is verified
> end to end (proposal #24 on future session id 32: planned/45 → confirm → modified/30, segments
> compressed to sum 30, invariant clean, double-confirm 409, row untouched before confirmation).
>
> **✅ FIRST OPEN DECISION — single-plan vs. option-set — RESOLVED 2026-07-22 (Session 8): keep the
> single-coached-plan architecture.** The planner still emits one session per (date, slot), the
> autoregulator still edits that one session, all invariants still hold over the seven planned
> sessions — planner/autoregulator/`planned_sessions` shape were NOT changed. **The reasoning:** the
> gap was never architecture, it was PRESENTATION. `v2_daily_cache.alternates` already holds 2-3
> fully-formed, rules-validated, injury-aware sessions every morning (compressed durations derived
> in code + one model category-swap); the Today card simply never rendered them, so reaching a
> session already on the shelf cost the user a 1.4-15s variant request plus the mental cost of
> formulating it. Session 8 surfaces the cached alternates as an instant client-side chip swap
> (zero network, zero model call) and keeps the free-text/constraint variant surface as the escape
> hatch for anything not on the shelf. A coach gives you the plan; the alternates are "here are the
> ready variations I already prepared"; the variant surface is "want something else entirely". This
> gets v1's option-set *feel* without duplicating the planner into an option generator. See
> "Engine v2 — Phase 8 / Session 8" in CLAUDE.md. The three §6 UX findings this unblocked are now
> closed (below).
>
> **✅ THE PRESENTATION IS NOW FINISHED — Session 12 (2026-07-24) SUPERSEDED the Session-8 chip row
> with the folded-card alternates layout.** The chip row hid each alternate behind a tap and showed
> too little to decide from; v1's side-by-side comparability is now back without touching the
> single-plan architecture. Primary expanded, each distinct alternate a collapsed card showing
> resolved duration / category / rationale, tap to expand in place, one open at a time, the primary
> always one tap away. Also closes the §6 alternate-`why` weakness (collapsed = short rationale,
> expanded = the real `session.why`), gives anchor-day miss-class alternates their own legible
> "If you can't make it" grouping, and marks sessions that persisted while flagged. Display only,
> zero writes, 213 v2 tests. See "Engine v2 — Session 12" in CLAUDE.md.
> **~~Still queued behind it, unchanged: (B) advancement — with threshold plausibility as a HARD
> prerequisite (§6) — (D) the within-phase ramp, and the session-composition settings UI.~~
> ⚠ PARKED 2026-07-24 (session #34)** — all three are parked with the rest of the v2 arc, not next.
> B's threshold-plausibility prerequisite still stands if the arc is ever resumed.
>
> **UX findings from the 2026-07-22 close-out** (live profile-4 screenshots) are logged in §6:
> non-set-based segments render as fake single sets, doubled superset-rest parens, and a v2 Today
> card action-button styling pass. All deferred to the next session, after the design decision above.
>
> **Remaining logged follow-ups** (all in §6/§9, none blocking): sub-5s variant model paths need
> diff-generation not full-session generation (§6); `goal_tags` are model-labelled and under-report
> — derive in code from prescribed exercises (§9); the v1 `duration_minutes` overload (hold vs
> session length) is unfixed in v1 (§6); `refusals_preferences` capture is now DONE (Phase 7);
> the alternate-cache category swap needs a review after Phase 5 rewired it (resolved); one
> unexercised gap-decay floor is provably unreachable (documented, kept).

Replaces the single per-day "AI does everything" rec call with a two-cadence engine, for
`profile_data.engine_v2 = true` profiles only. **v1 stays live and byte-identical for every other
profile.** All v2 generation is server-side; the client renders cached output. Phase 1 (audit) is
complete — full current-state map, schema proposal, reuse inventory and shared-surface list were
produced 2026-07-22 and approved; see that session's report. Phasing:

- **Phase 1 — Audit.** ✅ Done 2026-07-22 (audit only, no code).
- **Phase 2 — Rules module + progression/dossier builders + audit endpoint.** ✅ **Done 2026-07-22, deployed, run live against profile 4.** Delivered: three unrun migration files (above); `server/coachingRules.js` (one source, consumed as prompt text AND as callable pure functions, every rule carrying an evidence marker); `server/v2Progression.js` (progression state in code, no table); `server/v2Dossier.js` (code-derived flags first, one small Haiku pass for prose only); `GET /api/v2/audit/:profileId` (admin-gated, read-only); and `v2CurrentPhase()`, the server-side roadmap phase resolver. **v1 isolation held** — the only `server.js` edits are three additive requires and one new route; no v1 function, prompt or endpoint changed, and a post-deploy smoke test of profile 1's workouts/exercises/daily-recs/micro-goals/providers endpoints all returned 200.
- **Phase 3 — Planner** (weekly, Sonnet) + block/session persistence + admin trigger. ✅ **Done
  2026-07-22 — one real plan generated against profile 4 and persisted (block id 1, 7 sessions).**
  Delivered: `server/coachingRules.test.js` (47 tests, closes the two gap-decay bands real data
  never reached); `establish_baseline` as a first-class progression action; the progression table
  resized **9,989 → 3,093 chars** by splitting on signal rather than truncating by recency;
  goal tiers + `profile_data.schedule_v3` sibling keys; `server/v2Planner.js`;
  `POST /api/v2/plan/:profileId` (admin-gated, streaming, Sonnet, capped at 2 attempts) and
  `GET /api/v2/plan/:profileId` with explicit readiness reporting.
  **First-generation result:** 1 attempt, 114 s wall clock, 5,426 input / 7,323 output tokens,
  **0 invariant violations and 0 repairs** — the invariant set is therefore SHIPPED BUT UNPROVEN
  against real output, since nothing fired. Four real defects found in the output are logged in §6
  (the `time` unit ambiguity, the missing time-budget verifier, silently-dropped accessory goals,
  and an unverifiable model-asserted statistic).
- **Phase 3.5 — Correctness pass on the planner output shape.** ✅ **Done 2026-07-22.** All four
  Phase 3 defects closed and re-verified on a fresh generation (block id 3). Added
  `buildRecencyState()`/`renderRecencyBlock()` + a system-prompt SOURCING RULE; changed the
  exercise time field to `time_seconds` at the schema; added the `session_time_budget`,
  `time_unit_resolvable` and `tiered_goal_prescribed` invariants; and added
  `server/v2Planner.test.js` (**27 tests**) proving every invariant against a deliberately
  corrupted fixture plus a zero-false-positive clean-plan case.
  **Regeneration:** 1 attempt, **101 s** (vs 114 s), **6,704 output tokens** (vs 7,323), 3,089
  cache-read input tokens, 7 sessions persisted. **1 invariant fired on real output** —
  `tiered_goal_prescribed` correctly caught the pinky-rehab goal being prescribed across 4
  exercises on 2 days but never tagged in any session's `goal_tags`. Remaining open item: that
  mis-tagging is a model behaviour a prompt change may not fully fix (§6).
- **Phase 4 — Nightly job + autoregulator** (Haiku) + alternate cache. ✅ **Done 2026-07-22 — a
  real nightly run against profile 4 produced a rules-driven autoregulation and wrote the cache.**
  `POST /api/v2/cron/nightly` (admin-gated primary trigger; hourly interval secondary because
  Render Hobby spins the interval host down), `server/v2Autoregulator.js`, `server/v2Readiness.js`,
  the ≤4-object alternate cache, and the `life-os-summary` v2 branch. **Autoregulator result:**
  decision `reduced_volume`, retention 1.0, 0 invariant problems, why = *"MAT LOAD rule: hard
  combat-sports session logged yesterday reduces next-day lower-body strength volume by ~2 sets;
  readiness at baseline so intensity and exercise selection unchanged"* — grounded in a real
  60-min MMA session logged 2026-07-21. Autoregulator prompt 15,890 chars (planner was ~19k),
  ~7,461 in / 2,735 out tokens, ~25 s. **Three bugs found by running it** (all fixed): the planner
  marked strength days `movable:false` (→ new `movable_only_for_anchors` invariant), the
  idempotency guard never fired because `loadV2Context` didn't select `v2_daily_cache_date`, and
  the category-swap alternate silently produced nothing (non-fatal, within budget — hardening
  deferred to Phase 5). **Verified:** idempotency skips in 1.4 s when the cache is fresh; the
  `withV2Lock` double-generate guard proven deterministically; morning-open is a pure DB read;
  v1/profile 1 byte-identical (life-os still serves readiness 72 + its `daily_recommendations`
  options).
  - **⚠ Render is on the Hobby (free) plan and spins down after ~15 minutes idle** (confirmed by
    Shimmy 2026-07-22). The in-process interval therefore **cannot be the primary nightly
    mechanism** — the service will usually be asleep when it should fire. Design from this
    assumption: the **admin-gated endpoint driven by an external cron is the real trigger** (the
    inbound request also wakes the service); the interval is a secondary path for when the service
    happens to already be warm.
  - **RE-TIERING ON PHASE COMPLETION — captured 2026-07-22 so it is not lost between sessions.**
    The current profile-4 tiering (drivers = Fix Posture + Fix Pubic Osteitis) is **temporary by
    design, not permanent**. Once a driver clears its current roadmap phase — or no longer needs to
    structure the whole week — the next planner run must **promote the highest-priority
    maintenance-tier goal to driver (Build Muscle is first in line) and demote the completed rehab
    goal to maintenance**. This belongs with the re-plan triggers (driver-tier goal change / phase
    completion), NOT with the planner itself. Deliberately not built in Phase 3.
- **◧ Engine v2 — PHASE-AWARE SESSION PRESCRIPTION (Session 11, 2026-07-23 — A1 + A2 ✅ DONE + DEPLOYED;
  B/C/D pending).** The architectural fix for the still-OPEN §6 session-content thinness entry.
  **A2 (envelope wired into the planner + variant) shipped 2026-07-23** — see `CLAUDE.md` → "Engine v2
  — Phase-progression A2". Live result on profile 4: the headline thin strength day cleared 51%→79%,
  cardio stayed full, and the metric-fits-pattern validator drove permanent shape-mismatch UNEVALUABLEs
  to 0 — BUT one MIXED capacity+rehab strength day still persisted at 65% (up from 44%; model filled a
  capacity slot with low-density rehab work), so the regenerated week does NOT fully clear the floor and
  the §6 entry stays OPEN. Floor untouched (0.70); no session escalated past the cleared stage (proven).
  **A1 (evaluator only) shipped 2026-07-23** — see `CLAUDE.md` → "Engine v2 — Phase-progression A1"
  for the full record. A1 built the stage ladder + code-owned envelopes (`server/coachingRules.js`),
  the three-state exit-criteria evaluator + tagged-referent authoring validator + effective-stage gate
  with advancement DISABLED (`server/v2Stages.js`, 42 tests / 165 v2 total), the cold-start floor table,
  the `POST /api/v2/backfill-stages` authoring endpoint, and the `/api/v2/audit` stage report. **Locked
  decisions (do not re-litigate — see CLAUDE.md):** three states not two (UNEVALUABLE ≠ UNMET); tagged
  referent `{type:"pattern"|"exercise"}` with pattern the default and exercise forced into the envelope;
  measurable-by-construction validated at authoring for both types; rejected fallbacks (a) advance-on-
  dwell-alone and (b) re-author-against-what-was-logged. **Live on profile 4:** backfill authored ~33
  criteria, 0 dropped as out-of-envelope; current-phase audit 2 MET / 1 UNMET / 6 UNEVALUABLE (all
  hand-verified; the high UNEVALUABLE rate is EXPECTED — measurability against the envelope is not
  evaluability against the log until A2 prescribes those patterns), all goals HOLD (never advance on
  absence). **Plan byte-identical** (profiles 1 & 4, across deploy AND the backfill write). **A1-scope
  redraw vs the original A/B/C/D below:** structured `exit_criteria` + the three-state evaluator moved
  from B INTO A1 (per the pre-build questions session); **A2** is now purely "wire the envelope +
  week-position-in-phase into the planner" (the thinness fix); **B** is now purely "ENABLE advancement +
  the dwell floor + wire the pain/deload safety-regression veto." **Audit-confirmed root cause:** the
  planner receives a phase LABEL + ≤4 prose `emphasis`
  bullets and nothing about how much work the current phase of a goal's arc calls for; phases carry
  `weekly_targets`/`completion_signals`/`duration_weeks` but none reach the planner as a machine-
  readable volume/intensity envelope, and phase advancement is purely calendar-based
  (`completion_signals` are evaluated by nothing). So the model prescribes a thin, static,
  undifferentiated set of movements and pads `duration_min`. Re-tiering does NOT fix it (thinness is on
  a driver goal already; it tracks modality, not tier). **Proposed mechanism (goal-agnostic):** a
  training-stage archetype ladder in `server/coachingRules.js`
  (`tissue_tolerance → capacity → load → power → return_to_sport`, + maintenance) that ANY goal maps
  its phases onto. Each stage carries a CODE-DEFINED envelope (working-set range, intensity band,
  rep-scheme family, modality mix, session-fill expectation sized to clear the 0.70 floor); the MODEL
  authors only exercise selection + load targets inside that envelope, and the model's stage suggestion
  is code-clamped — the exact code-enforced/model-authored split the work budget already uses. NO
  injury- or sport-specific content; the injury only changes which exercises fill the envelope.
  **Ordered build (REDRAWN — one scoped session each):** **(A1 ✅ DONE 2026-07-23)** stage ladder +
  code envelopes + the three-state exit-criteria evaluator (schema, tagged-referent authoring validator,
  MET/UNMET/UNEVALUABLE resolver, effective-stage gate with advancement DISABLED) + cold-start table +
  backfill + audit — the pure evaluator, plan byte-identical; **(A2 ✅ DONE 2026-07-23)** pass the effective-stage
  envelope (gate-clamped, never intended/calendar) AND the athlete's week-position-in-phase into the
  planner AND variant prompts + the code-driven honest-shorten rule → headline thin strength day cleared
  51%→79%, cardio stayed full, no escalation past the cleared stage (proven), metric-fits-pattern
  validator folded in (0 permanent shape-mismatch UNEVALUABLEs). PARTIAL: one mixed capacity+rehab day
  still 65% (§6 stays OPEN — model under-fills a capacity slot with rehab work on mixed days, NOT a floor
  issue; floor untouched); **(B — NEXT UP, 2026-07-24: the athlete-facing surface is finished, so B is the head of the queue)**
  ENABLE advancement — the dwell floor + apply the effective-stage verdict + wire the
  pain/deload safety-regression veto (time-elapsed alone must NEVER advance a rehab phase; persist a
  monotonic-non-rising `effective_stage`, which the A1 resolver already accepts as `prior_effective_stage`).
  **⚠ HARD PREREQUISITE: threshold plausibility (§6). B must not ship without a threshold-plausibility
  gate** — harmless while advancement is disabled, a safety issue the moment it is not;
  (C) make the catalog reachable at plan time (filtered subset in the prompt) + add a
  difficulty/progression-level column to `exercise_catalog` + phase-gate contraindications
  (wrong-now-vs-wrong-always, extending `AREA_TOKENS` to `{token, min_stage}`); (D) within-phase weekly
  ramp + wire RE-TIERING-ON-PHASE-COMPLETION (the note above) onto the new advancement trigger. **Cold
  start is first-class:** a driver goal with no roadmap (profile 4's `Stamina` today) gets a default
  stage by goal type + recency; a brand-new user maps to the bottom of the capacity band. All additive
  jsonb on `goals[i].roadmap.phases[]` + one nullable catalog column (unrun SQL file); profile 1 and
  non-flagged profiles byte-identical. **Constraints held during the audit:** no code, no migrations,
  no prompt/UI edits; `estimateSegmentWorkMinutes`/`SESSION_WORK_FLOOR`/`session_time_budget` untouched
  and STAY; profile 4 not re-tiered. Full audit report + proposal produced 2026-07-23.
- **Phase 5 — Variant endpoint** (Haiku, streamed) + conversational constraints. ✅ **Done
  2026-07-22 — all constraint classes run live against profile 4.** `server/v2Variant.js` (one
  shared implementation), `POST /api/v2/variant/:profileId` (streaming, ephemeral — never writes
  the cache or plan, proven by before/after check), and the nightly swap rewired to the same path
  (**nightly now yields 4 cache objects**). Routing: cache-first (zero call, ~1.4s) → code-only
  duration reduction (~2s) → model (intensity/category/style/free-text/readiness, ~15s). Free-text
  classified in code — "not feeling it" routes through the readiness rules (proven: trimmed
  intensity, didn't reroll), "same muscle different style" holds the pattern. **Hard rules proven
  live:** an injury-contraindicated request ("heavy sprint + adductor work" vs Pubic Osteitis) was
  REFUSED in prose with the safe session returned. Two new invariants (`constraint_honored`,
  `contraindication_free`); 21 variant tests incl. both conflict cases (97 v2 tests total).
  **Four bugs found by running it** (all fixed): server.js wasn't in the first commit (route
  404'd), `loadV2Context` didn't select `v2_daily_cache` (409), the variant read the flattened not
  the structured session (silent no-op compression), and "Glute Bridge" false-matched a neck
  contraindication. **Sub-5s met for the deterministic paths; model paths run ~15s** (output
  generation of a full session, not prompt size — see §6).
- **Phase 6 — Flagged UI**: week view, today card, variant surface, effort tap, defaults, tier selector. ✅ **Done 2026-07-22 — all six surfaces rendered live for profile 4 (state-injected past the PIN), zero console errors.** Behind `isV2Profile()` at the 7 audited seams; **the entire diff deletes exactly ONE v1 line** (the day-nav `fetchAI`, byte-identical on the v1 branch). New `GET /api/v2/today/:profileId` (pure DB read, un-gated); `POST /api/v2/variant` un-gated too (flagged shared-surface change — user-facing generation like `/api/ai`; CRON stays admin-gated). Today card renders the autoregulated session via the existing section renderer with the decision tag surfaced honestly ("VOLUME REDUCED TODAY"); variant surface replaces reroll+category+focus as one surface with instant-vs-generated handling and an ephemeral banner; week view marks anchors; effort tap **verified writing `session_effort` to the DB**; defaults + tier selector write `profile_data` with max-2-drivers enforced in the UI. CSS scoped to `#v2-*`/`.v2-*`, no global class redefined, no migration.
- **Phase 7 — Coach Chat concierge. ✅ Done 2026-07-22** (read-side, refusals, and v1-untouched
  verified live; the propose→confirm→**apply** cycle is **pending the unrun migration**
  `2026-07-22_chat_proposals_v2_types.sql` — see the completion note below). Extends the existing
  propose→confirm→apply pattern: a v2-aware snapshot section (tiers, today's session, the week's
  `planned_sessions` with `[id]`s + FIXED markers, dossier, recency, progression — 5,484 chars,
  total snapshot 10,461/20,000), three v2-only tools (`propose_session_change`,
  `propose_skip_session`, `propose_standing_preference`) offered only to flagged profiles, and
  code-enforced guards (future-only → prevents cache/plan desync; anchors immovable; injury
  contraindications; the Phase 3.5 invariant set re-run at apply time). Standing preferences write
  `profile_data.v2_preferences[]` and the dossier builder folds them into `refusals_preferences`,
  closing the Phase 2 deferred item. **Original design note (kept for the record):** Explicitly out of
  scope for Phases 1–6, recorded here so it isn't rediscovered as a surprise. **The gap:**
  `buildChatSnapshot()` currently reads only `daily_recommendations_readiness` and
  `daily_recommendations_date` off the profile row — it has **no visibility into any v2 state**.
  On a flagged profile the coach would therefore be blind to `planned_sessions`, the active
  `training_blocks` row, the athlete dossier, goal tiers (driver/maintenance/accessory),
  progression state, and the nightly autoregulator's decision + reasoning — while still narrating
  confidently from v1-shaped data that is no longer being written. **Target end state:** a
  concierge coach that can see all v2 state and *propose* writes to `planned_sessions` (move a
  session, swap a segment, change today's plan) through the **existing propose-never-
  silently-apply tool-use pattern** — a pending `chat_proposals` row plus an explicit confirm
  card, exactly as `propose_goal_update` / `propose_focus_override` / `propose_checkin_note` work
  today. **Known design questions, unanswered:** whether the v2 snapshot replaces or extends the
  v1 one on a flagged profile; the prompt-cache cost of a much larger snapshot (§6 item 5 already
  flags that any snapshot change invalidates the whole cached system block); and whether a
  session-mutating tool needs a stricter confirm than a goal edit does.

**Prerequisite: ✅ done.** Profile 4 is the designated `engine_v2` test profile and now holds a
verified clone of profile 1's training history (see §2 Migrations). Profile 4 deliberately has
**no wearable connection** — readiness comes from cloned historical `daily_sleep` rows plus
manual check-ins.

**Phase 2 measured output (profile 4, live, 2026-07-22)** — the numbers Phase 3 plans against:

| Section | Chars | Note |
|---|---|---|
| Rules (all 12 sections) | 6,654 | fixed cost, identical for every profile |
| Progression table | 9,989 | 40 exercises — the elastic section, will need a cap |
| Dossier (rendered) | 1,155 | serialized 2,401 vs a ~2,000 target |
| **Total** | **17,798** | before any planner-specific context |

Progression state: **40 exercises** from 89 rows in the 60-day window. Gap-decay branches that
actually fire on the cloned history: `<10 days` ×18, `4-6 weeks` ×11, `>6 weeks` ×11 — the
`2-3 weeks` and `10-14 days` bands did **not** fire at all. 22 exercises are >30 days stale.
Progression actions: 32 hold / 6 regress / 2 progress. Dossier flags: 5 injury, 4 stalled lifts,
8 neglected movements, 3 notable PBs, 2 fixed commitments, `novelty_pref` inferred `mostly_same`.
All 3 per-goal roadmaps plus the macro roadmap resolved cleanly via `date_window` with exactly one
stored `current` phase each — **the §9 D5/D7 divergence does not currently manifest on this data.**

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

> **⚠ THIS SUBSECTION DESCRIBES THE PRE-PT-BRAIN SHAPE. Read it with the corrections inline below.**
> The **PER-GOAL** roadmap's fixed 3+2 skeleton, its integer 4–6 `duration_weeks` clamp, and its
> time-elapsed `progress_pct` were **all retired in PT Brain Sessions A and B (sessions #36/#37)**.
> The **MACRO** roadmap (`profiles.roadmap_data`) still uses 3+2 and time-elapsed progress, and was
> deliberately left untouched. See "⚠ PER-GOAL vs MACRO" above for the authoritative side-by-side.
> Legacy per-goal roadmaps generated before Session A keep the old shape and get no `arc_state`.
- **Per-goal storage:** fields on each goal object in `profile_data.goals[]` jsonb — **no new tables**. New roadmap shape: `{ timeline_range, timeline_note, date_confidence, phases[], generated_at, version, adaptation_log[] }`. Phases = 3 `near_term` (duration_weeks, start/end dates, `weekly_targets[]`, `completion_signals[]`, status, progress_pct) + 2 `horizon` (`estimated_range`, `milestone`). Replaces the old `estimated_completion`/`date_note`/`summary` fields. See `CLAUDE.md` → "Living Goal Roadmaps (Per-Goal)".
- **Macro roadmap (new):** structured `profiles.roadmap_data` jsonb ties ALL goals into one phased plan (`goals_summary[]`, `exercise_gaps[]`, `exercise_highlights[]`, 3 near_term + 2 horizon phases with `goal_connections[]`). `GET/POST /api/profiles/:id/roadmap-data` (Sonnet generate, no intake gate). Legacy free-text `/roadmap` kept for the current client.
- **Exercise grounding:** `getGoalExerciseContext()` + `getFullExerciseContext()` inject the athlete's real logged training (best sets, trend, inactive exercises, category mix, consistency) into every generation/adaptation prompt.
- **Intake flow:** profile-aware (Haiku generates 4–6 targeted questions); `intake_completed` gate before per-goal generation.
- **Progress:** `computePhaseProgress()` estimates a current near-term phase's `progress_pct` from elapsed time (capped 90) + improving-trend bonus; recomputed on read, never stored. **⚠ SUPERSEDED FOR NEW-SHAPE PER-GOAL ROADMAPS (Session B, #37):** `recomputeRoadmapProgress` now branches — when `roadmap.arc_state` is present, phase status comes from **cumulative phase budgets vs EARNED position** (`position_week`, replayed from the log in code), not from elapsed time. The time-elapsed path is byte-identical and still correct for **legacy per-goal roadmaps (no `arc_state`) and for the MACRO roadmap**.
- **Adaptation:** per-goal check-in (user notes) + **unified** weekly auto-adaptation `maybeAdaptAllRoadmaps()` (fire-and-forget on workout save) that adapts both per-goal roadmaps AND the macro roadmap when >7 days stale, sharing one context fetch. Each adaptation increments `version` and appends to `adaptation_log`.
- **Model routing** (`CALL_TYPE_MODEL`): `goal_intake_questions`→Haiku, `goal_roadmap_generate`→Sonnet, **`goal_roadmap_adapt`→Sonnet** (⚠ **corrected 2026-07-27** — this doc and `CLAUDE.md` both still said Haiku; `server.js:2724` reads `goal_roadmap_adapt: MODEL_SONNET` and has since session #30, when adapt was promoted so it could judge phase **premise validity**), `macro_roadmap_generate`→Sonnet, `macro_roadmap_adapt`→Haiku. Session A (#36) additionally routes `goal_plan_setup` / `goal_timeline_estimate` / `goal_negotiate`→Sonnet.

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
~~Always 3 `near_term` (4–6 weeks, fixed dates, `weekly_targets`, `completion_signals`) + 2 `horizon` (milestone-based, `estimated_range`, no fixed dates).~~ **⚠ RETIRED FOR PER-GOAL ROADMAPS — Session A (#36).** Phase count and each phase's week budget are now **derived in code** by `derivePhasePlan(estimate)` and handed to the model as fixed slots: near-term span `min(W, 16)`, count `clamp(round(nearSpan/5), 1, 4)` with a floor of 2 once `nearSpan ≥ 5`, budgets integer-distributed remainder-front-loaded and **landing in `[2,6]` by construction**; horizon blocks `clamp(round(rem/12), 1, 3)`. So a 6-week rehab goal gets `[3,3]` + 0 horizon and a 16-week bench goal gets `[6,5,5]` + 1 horizon. The **3+2 shape above still applies to the MACRO roadmap and to legacy per-goal roadmaps generated before Session A** (`resolvePhasePlanForGoal` deliberately leaves those unclamped so a regenerate never silently shrinks them). `date_confidence`: high (<6 mo, clear metrics), medium (6–24 mo), low (multi-year / skill-dependent like belts). `progress_pct` computed on read, never stored.

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

- [ ] **Engine v2 is now flag-gated dormant code — a decommission decision is OUTSTANDING (added
  2026-07-24, session #34).** The arc is paused and its strategy rejected going forward (§6, §7),
  but **nothing was deleted or reverted, deliberately**: `server/coachingRules.js`,
  `v2Progression.js`, `v2Dossier.js`, `v2Planner.js`, `v2Autoregulator.js`, `v2Readiness.js`,
  `v2Variant.js`, `v2Stages.js`, their ~213 tests, the `/api/v2/*` routes, the nightly job + hourly
  interval, the flagged `#v2-*` UI, the v2 Coach Chat tools, and the `training_blocks` /
  `planned_sessions` tables + v2 profile columns (all migrations **run in production**) all remain.
  It is preserved for possible future reference and is inert for every non-flagged profile. **What
  is actually outstanding:** decide whether v2 is resumed, left dormant indefinitely, or formally
  decommissioned — and if decommissioned, what happens to the v2 rows/tables. **Do not delete
  anything opportunistically**; this is its own scoped task.
- [ ] **Profile 4 is still `engine_v2 = true` and still carries v2 data (added 2026-07-24, session
  #34).** The revert was scoped this session and deliberately not executed — the athlete pivoted to
  forward design instead. Consequences while it stays flagged: the nightly job still runs for it,
  the v2 UI still renders for it, and its cloned training history + v2 writes (blocks, planned
  sessions, `v2_daily_cache*`, `dossier*`, tiers, `schedule_v3`, `v2_preferences`) remain in place.
  Harmless for profile 1 and every other profile (v1 byte-identical throughout the arc, re-verified
  at every v2 session), but it means **profile 4 is not a clean v1 test profile** until flipped.
- [x] **✅ CLOSED as "will not port" — `estimateSegmentWorkMinutes` was evaluated against real
  content and deliberately NOT ported (resolved 2026-07-25, session #39 Phase 1 audit).** Opened
  2026-07-24 (session #34) as a salvage item on the assumption the v2 estimator was better. It is
  not: its constants were derived FROM v1 and are identical by construction; it reads STRUCTURED
  objects while v1 rec sections are FREEFORM strings (so a port needs a string parser to feed an
  estimator that duplicates `estimateExerciseMinutes`); and its two genuine additions fire **zero
  times** on profile 1's real 32-line / 11-section rec. **What was taken instead:** the
  all-bare-section rule as a **3-line addition** to the existing function. **The DEPTH-reconciler
  intent is unchanged and is Layer 4's job** — it is the v2 *function* that is not carried over, not
  the goal. Full reasoning in §6 → SALVAGE list. **Do not re-propose the port.**
- [x] **Drop the deprecated `fitbit_pending_imports` queue.** ✅ **Code + column both done 2026-07-17** — confirmed zero call sites (grep before removal), then deleted `diffAndQueueFitbitImports()`/`mapFitbitActivityType()`/`FITBIT_ACTIVITY_TYPE_MAP` and both endpoints from `server.js`. `migrations/2026-07-17_drop_fitbit_pending_imports.sql` **run in production** — column no longer exists.
- [x] **Retire the legacy text roadmap (now unblocked).** ✅ **Code + columns both done 2026-07-17** — confirmed no external consumer reads `profiles.roadmap`/`roadmap_updated_at` (neither `life-os-summary` nor `PROFILE_SELECT_BASE` select them), then removed `GET/POST /api/profiles/:id/roadmap`, `loadRoadmap`/`renderRoadmapContent`/`generateRoadmap`, and the hidden `#roadmap-card`. `migrations/2026-07-17_drop_legacy_roadmap.sql` **run in production** — both columns gone.
- [ ] **`ai_prompt_context` embeds a goal list that drifts from `goals[]` (found session #31).**
  The prose carries its own numbered `GOALS:` list written at onboarding/profile-builder time;
  reordering goals via Prioritize writes `goals[]` and never regenerates it, so the two diverge
  permanently — measured live they were nearly inverted. `stripEmbeddedGoalsList()` removes it
  **at daily_recs assembly time only**. The stored prose is **still stale wherever else
  `ai_prompt_context` is consumed**: `buildChatSnapshot()` (Coach Chat), the macro/per-goal
  roadmap prompts, and `POST /goal-progress` all read it raw (`server.js` ~2818, ~4848, ~5274,
  ~5818, ~5900, ~6811). Durable fix is §7 item (c) — regenerate or de-duplicate on goal change.
- [ ] **`upsertDailyVitals()` stamps `source` on the INSERT path only, never the PATCH (session
  #31) — intentional, documented so it isn't "fixed" by mistake.** A vitals-only write must not
  relabel an existing row whose *sleep* came from a different provider, since the column
  describes the sleep source. On a fresh row there is no sleep yet, so the vitals provider is
  the only honest value; the INSERT also relies on the column DEFAULT when no source is passed.
- [ ] **`format_notes` writes a literal `"Notes: None"` placeholder into the notes column when
  raw notes are empty (found session #32) — needs its own audit.** The Haiku `format_notes`
  prompt (temp 0) emits the placeholder string instead of leaving the field blank, so the
  *stored* notes are junk (the render is fine — `renderLoggedNotesHtml` trims + suppresses it).
  This is a write-side data-flow bug: a fix must distinguish a legitimately-empty notes field
  from a populated one and must not clobber existing good notes. **Audit-first, not a one-liner.**
- [ ] **Notes-only logged workouts where `extract-exercises` silently produced no rows (found
  session #32) — needs an audit.** Confirmed on a genuine 2026-06-22 session: real structured
  data (`"2×10 single-hand Dumbbell Rows 22.5lb"` and more) sits only in the free-text `notes`
  with **zero** corresponding `exercises` rows. Distinct from session #30's insert-*destruction*
  (rows written then killed by the integer-column bug) — this is rows **never written**. Audit
  scope: is it a one-off or a pattern across history, and can a safe re-extract backfill the
  trapped rows **without duplicating** rows that already extracted (no `updated_at` on `exercises`
  to lean on — see the audit-trail debt item)?
- [x] **✅ RESOLVED — `google-health-probe` kept, `source-constraint-probe` deleted (session #31
  hygiene pass).** Two debug endpoints were added session #31. `GET /api/debug/google-health-probe/:userId`
  (read-only by default; `allow_refresh=1` is the only writing path, and a failed refresh
  legitimately sets `needs_reconnect`) is **kept as a permanent diagnostic** — it answers a
  question `/daily` structurally cannot. `GET /api/debug/source-constraint-probe/:userId` was a
  one-time gate for the source-threading work; its verification is done and documented, so it was
  **removed**. Both had followed the existing `ADMIN_SECRET` pattern.
- [ ] **`wearables/google_health.js` `refreshToken()`'s `fetch(TOKEN_URL)` has no timeout /
  AbortController (found session #31, NOT fixed).** Every GH *data* leg is now bounded by
  `ghFetch()`'s 7s `GH_REQUEST_TIMEOUT_MS`, but the OAuth token-refresh POST is a plain `fetch`
  with no bound. Pre-existing, but newly reachable through the `google-health-probe?allow_refresh=1`
  path (and always reachable via the normal refresh triggered by any expired-token `/daily`). A
  hung Google token endpoint would hang the caller until the platform kills the request. The
  module-level GET retry wrapper does not cover it (it's a POST, and adds retry not timeout). Fix
  is an `AbortController` mirroring `ghFetch()`; flagged only this pass.
- [ ] **Engine v2: `goal_tags` are model-labelled and under-report (found 2026-07-22, Phase 3.5).**
  The planner prescribes work for a goal and then omits that goal from the session's `goal_tags`.
  Confirmed on a real generation: four pinky-rehab exercises across two days, with the pinky goal
  absent from both sessions' tags. The `tiered_goal_prescribed` invariant catches the symptom but
  cannot distinguish "prescribed but mis-tagged" from "genuinely dropped", and deliberately does
  not try — it flags, a human reads it.
  **Durable fix: derive `goal_tags` in CODE from the prescribed exercises rather than trusting the
  model to label its own output.** This is the same lesson as the roadmap-emphasis work, where a
  regex over model prose was built, tested and rejected in favour of structured extraction — asking
  a model to label its own output is a weaker contract than deriving the label from what it
  actually produced. Not built. **Must be resolved when Phase 7 (Coach Chat) or any goal-progress
  work starts reading `goal_tags`** — every such consumer will silently under-report until then.
- [ ] **Drop the redundant `saveWearableTokens` call** in the `/callback` OAuth handler — `saveProfileTokens` now mirrors into `wearable_connections`, so the explicit second write is redundant (idempotent, harmless).
- [ ] **Add `workouts.duration_minutes` column** so manual session durations count in analytics without relying on summed `exercises.duration_minutes`.
- [ ] **Rename `?max_intraday=` → `?max_calls=`** in `/api/debug/backfill-wearable-hr` (the budget now covers TCX **+** intraday calls, not just intraday). Keep `max_intraday` as an alias for back-compat.
- [ ] **Retire the legacy `tokens` table** path once confirmed no profile depends on it.
- [x] **✅ RESOLVED session #40 — the capacity card never rendered on boot or tab switch.** Session
  C logged this as needing "a render-ordering pass"; that diagnosis was wrong. `renderCapacityCard()`
  was never in the profile render fan-out at all — Session A's call landed inside `foPersist()`
  (`public/index.html:6843`), the Focus-Override **save** handler, so the card only ever appeared
  after saving an override. Now called from `showTab()`'s profile branch (with `loadCapacityFit()`)
  and from the profile render fan-out where it was meant to go. Verified idempotent across 5
  repeated calls against the real shipped function; empty state still hides correctly.
- [ ] **⚠ PROMPT CHAR-BUDGET PROJECTIONS IN THIS CODEBASE RUN SYSTEMATICALLY LOW — treat every char
  estimate as optimistic and MEASURE before shipping (recorded session #41).** Two independent
  data points, both understated: **Session D (#40)** projected depth `+300` / arc `+500` and
  actually shipped **+641 / +935** — the mandated-verbatim ARC REALITY instruction alone is ~430
  chars and was never budgeted for. **Session #31's audit was ~30% under** (~12,000 estimated vs
  ~17,400 real protected content) because it assumed no active Focus Override and could not measure
  `buildLog`/`buildExerciseHistory`/`dataBlock`, which are closures *inside* `fetchAI`. **The
  measurement tool already exists and should be used instead of estimating:**
  `fetchAI({auditOnly:true, onAudit})` assembles and reports the real prompt through the real
  builders **without calling the model**. Not a defect to fix — a standing practice to follow.
- [ ] **⚠ A GREEN TEST HARNESS CAN BE BROKEN — record this failure class (found session #40,
  recorded session #41).** Session D's function extractor over-captured **thousands of lines**
  because its brace scanner did not skip comments: an apostrophe in `// the model's own` opened a
  phantom string and swallowed the closing braces. **The functional tests passed anyway, at 48/49**
  — which is the danger. **A harness that reports near-green while silently mis-extracting is more
  dangerous than one that fails outright**, because it certifies code it never actually ran. Fixed
  with proper comment/string/template/regex-literal handling **plus an over-capture guard that
  throws** (no other column-0 `function` may appear inside a slice, and every slice must re-parse);
  re-run went 49/49. **This applies to every source-slicing harness in the repo** — the
  `v2FoldedCards.test.js` family and the Session D pair all use the same extraction discipline.
  Any new one must carry the same guard.
- [ ] **Layer 4 depth floor may need one tier dropped after real use (session #40).** 5 of 12 gated
  sections sit at exactly zero margin. Nothing is flagged today, but a one-movement dip warns. If
  spurious warns recur, **drop the `≥25` tier from 4 to 3 — never raise a tier** (raising imposes a
  new target on accepted content, the exact thing the floor must not do). §6 → Session D item 1.
- [~] **Arc evaluation has no time-based trigger — ⚠ PARTIALLY CLOSED by Session C (#38); restated
  2026-07-27.** ~~It hangs off `POST /api/workouts` only, so an athlete who stops logging never
  accrues decay.~~ Session C added **app-open arc evaluation**
  (`POST /api/profiles/:id/evaluate-arcs`, fire-and-forget from `bootApp`, server-gated on the
  existing 24h staleness, **zero AI calls**), so decay now accrues across a break instead of landing
  all at once on the next workout save. **WHAT REMAINS: nothing evaluates if the app is never
  opened.** An athlete who neither logs nor opens the app still accrues no decay — narrower than the
  original gap, same class. `POST /api/debug/evaluate-arcs/:profileId` (admin, dry-run default)
  forces it manually. Still deliberately not wired to an interval; a true time-based tick needs a
  decision on the mechanism (the in-process hourly interval is unreliable on Render's Hobby plan).
  **Also open: only the fresh/skip branch of app-open evaluation has been exercised live** — §7
  ledger row 22.
- [x] **✅ RESOLVED session #37 — F1: `resequenceNearTermDates` caller used the SERVER clock.**
  The admin repair endpoint now passes `localToday(loaded.profile)`, and `loadProfileWithGoals`
  selects `timezone` so every caller can resolve the athlete's day. Open since 2026-07-19.
- [x] **✅ RESOLVED session #37 — the negotiation loop.** A round counter (advisory, clamped
  1–9) escalates the framing toward capacity from round 2; the three levers and their order are
  unchanged. Verified live: round 2's `conflict_note` opens "You already applied a lever to get
  here, and the week still doesn't fit."
- [ ] **PT Brain Session A leftovers (session #36).** (a) The negotiation loop has no round
  counter — see §6 item 1; the fix is escalating copy, never a fourth lever. (b) `/estimate`
  and `/plan-setup` write before the athlete commits (§6 items 2–3) — a draft/commit split
  would close it. (c) `goal_ids` are never validated against live goals; Layer 2 must resolve
  dangling ids defensively. (d) The macro roadmap still hardcodes 3+2 in `MACRO_ROADMAP_SYS`
  (`server.js`) and `adaptMacroRoadmap` — deliberately out of Session A's scope, revisit with
  Layer 3.
- [ ] **`adaptGoalRoadmap`'s output size is not monitored.** Session #36 raised `max_tokens`
  2000 → 3000 after a live 3/3 reproduction of mid-array JSON truncation on a 5-phase roadmap.
  3000 covers today's shapes with headroom, but nothing *measures* how close a given adapt gets,
  and the failure mode is a silent `console.error` inside a fire-and-forget weekly trigger. A
  cheap guard: log output token usage per adapt and warn above ~80% of the cap. Same class as
  the §9 "5 silent-failure sites" item.
- [ ] **🐞 BUG 1 — goal-progress 413s. ⚠ AUDIT COMPLETE 2026-07-27 (session #42); FIX DESIGNED;
  DEFERRED to its own session by decision. No limit bump was applied. THIS IS THE NEXT SESSION.**
  Full audit in §6 → "BUG 1 — AUDIT RESULT"; ledger row 29. Settled findings, all measured:
  **POST-only** — there is **no GET route** (`app.post` at `server.js:2952` is the only one; a GET
  404s with an HTML page, which is the same `<!DOCTYPE` symptom at a different status, and is why
  the "GET/POST" pair in the original report was a notation, not two observations). The limit is
  the `express.json()` **default 100 KB** (`server.js:92`, no options), bracketed live at
  **101,357 B → 200 / 103,405 B → 413 `text/html`**. Real profile-1 body **207,357 B = 202.5 KB =
  2.02×**, split **exercises 104,059 B (50.2%) / workoutLog 65,689 B (31.7%) / goals 37,483 B
  (18.1%) / scalars 90 B**. **The two competing causes below are now RECONCILED: (a) is the cause
  (81.9%, and 1.66× the limit on its own), (b) is an aggravator (18.1%, under the limit on its
  own).** Migration adds ~4% (+8,653 B → 2.11×). **Fix:** the handler is stateless and
  `var profileId = req.params.id` is assigned at `:2954` and never used — stop sending
  `exercises`+`workoutLog` and let the server fetch its own (**202.5 KB → 37.6 KB**, a drop-in
  because the handler reads raw row fields), then stop sending `goals` too (**<1 KB**,
  migration-proof). A limit bump is a stopgap and must never ship as the fix.
  Original entry retained below for the record:
  - **Observed on profile 1, live:** `Failed to load resource: the server responded with a status
    of 413` on `GET`/`POST /api/profiles/1/goal-progress`, then
    `[Goals] Progress fetch error: SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid
    JSON` at `index.html:11308`. **The 413 is returned as an HTML error page, so the client's
    `JSON.parse` fails as a SECONDARY symptom — the parse error is NOT the bug.**
  - **Impact:** goal progress numbers don't load. Everything else on the profile renders.
  - **⚠ TWO COMPETING CAUSES, NEITHER CONFIRMED — this is why the first step is an audit.**
    (a) *Original session-#36 hypothesis, client-side:* `fetchGoalProgress` (`public/index.html`)
    posts `workoutLog.slice(0,90)` plus **every** exercise session, which exceeds the body limit on
    a profile with a full history — observed on profile 4 (a clone of profile 1's real log).
    (b) *New session-#41 hypothesis, profile-data-side:* the body exceeds the default
    Express/body-parser limit (~100 kb) because `profile_data.goals[]` has accumulated fields across
    all three PT Brain sessions — `goal_type`, `demand`, `estimate`, `roadmap.estimate`,
    `arc_origin`, `arc_state` — plus `profile_data.capacity` and `profile_data.coexistence`.
    **They are not mutually exclusive.**
  - **⚠ Anomaly to resolve in the audit:** a 413 on a **GET** would be unusual (no body). Confirm
    which verb actually 413s before reasoning from the reported pair.
  - **⚠ FORWARD-LOOKING RISK — raising the limit is a BAND-AID.** Profile 1 currently has **ZERO arc
    goals**; when its roadmaps are migrated to the new shape (§7 → "Profile 1 migration — a flagged
    athlete decision"), `arc_state` lands on **every** goal and the payload grows again. **The
    likely correct fix is not sending the whole blob** — send aggregates rather than raw rows, or
    let the server fetch its own data as the roadmap endpoints already do.
  - **FIRST STEP: an AUDIT of what that endpoint actually sends** (measured body size, per verb).
    Full detail in §6 → "PT Brain arc close-out — open bugs".
- [x] **✅ BUG 3 — roadmap adapt AND regenerate destroyed `arc_origin` + `arc_state`. FIXED
  2026-07-27 (session #42), `ae46a96`.** Found while ruling out BUG 2's candidate (c); in no
  document before. Both rebuild sites (`adaptGoalRoadmap:7019`, `generateGoalRoadmapForGoal:7696`
  and `:7711`) built `goal.roadmap` from scratch and dropped both Layer 2 fields — **the same bug
  class as the session-#35 `roadmap.estimate` drop, at the same two sites.** `arc_state` self-heals
  (pure replay); **`arc_origin` does not** — it re-pins from `near[0].start_date` while both writers
  call `assignNearTermDates(parsed.phases, today)` on dateless model-authored phases, rebuilding the
  calendar from today, so the origin walked forward on every adapt and discarded every earned week
  (session #37 bug #1 through a different door). Live evidence: profile 4's bench goal, regenerated
  2026-07-26T02:47:22.417Z, lost both. Fixed with one shared `carryArcForward(prev,next)` —
  carry-if-present only, so a legacy roadmap gains nothing. Verified 9/9 against the real shipped
  functions from BOTH `git HEAD` and the working tree with a frozen clock; profile 1's legacy
  output byte-identical pre vs post on adapt/regenerate/reset. **Standing note: if a third
  Layer-2/3 field is ever added to `goal.roadmap`, add it to `carryArcForward` at the same time —
  this is now the second occurrence of this exact class.**
- [ ] **The bench goal's destroyed `arc_origin` is NOT recoverable (residual of BUG 3, session
  #42).** Checked every field that could carry it — `roadmap` keys, `goal` keys, all 7
  `adaptation_log` entries, the phases — and nothing stores a prior phase snapshot or the origin.
  Ledger row 10's recorded facts (peak 4.5, `re_ramp.since 2026-07-06`) **bound** the origin to a
  multi-week range rather than determining it, so per §0.2 rule 5 it was **not guessed**. This is
  what currently blocks §7 ledger row 28 / item (c). **Two honest routes, both requiring a
  decision: (1) let profile 4 accumulate real qualifying sessions on the bench goal until a genuine
  peak-then-gap forms — the BUG 3 fix now protects the origin; (2) the athlete states the intended
  phase-1 start date as a product decision, after which the replay derives everything else from the
  real log.** Do not synthesise one.
- [ ] **UX: the MANUAL check-in is `localStorage`-only — per-device, per-day — and does not sync
  via `daily_checkins` (logged session #42; decision: leave as designed).** Unlike the *feeling*
  check-in, which persists to `daily_checkins` and syncs across devices, the manual check-in lives
  only in `localStorage.ac_cache.manualCheckin`. Consequence, and the whole of BUG 2: on a
  no-wearable profile a new day, a different device, or cleared storage re-shows the check-in gate,
  and **`#ai-card` stays hidden with no rec generated until it is submitted** (`showManualCheckin`,
  `public/index.html:3206`). Correct as designed for a single-device athlete; worth revisiting if
  no-wearable profiles ever become a real user segment. **Not a bug — do not "fix" it without a
  product decision.**
- [x] **✅ BUG 2 — RESOLVED 2026-07-27 (session #42): NOT A BUG.** No workout rec renders on the
  Today page for profile 4 because that profile has `fitbit:false` and no wearable, so
  `syncFitbit()` routes to `showManualCheckin('no_fitbit')` and only the branch that finds a
  same-day manual check-in shows `#ai-card` and calls `resolveAIRecs()` — the designed gate above.
  Candidate (b) was ruled out by measurement (all 11 `fetchAI` builders OK, assembly
  27,193/28,000, headroom 807) and candidate (c) disproven in code (`grvRegenerateFromBanner` calls
  no rec path; only *macro* regeneration does). It no longer blocks ledger row 28. Original entry
  retained below for the record:
- [ ] **🐞 BUG 2 — no workout rec renders on the Today page for profile 4 (Test #3). Found live
  after session #40's close-out; undiagnosed; logged session #41.** Observed right after the athlete
  regenerated a goal's roadmap on that profile. **NOT a general Layer 4 regression** — profile 1 was
  checked immediately and is healthy (rec cards generate, capacity and profile cards load).
  **Candidate causes to rule out in this order:** (a) benign empty state — profile 4's
  `daily_recommendations*` were never populated, because v2 never wrote them and the profile was
  flipped to v1 in Session A; (b) a generation failure specific to that profile's data shape — it is
  the only profile with new-shape goals, `arc_state`, `capacity` and `coexistence` all present;
  (c) fallout from the goal regeneration that immediately preceded it. **First step:** the browser
  console on profile 4, then a **forced category-pill generation** to separate a cache/render issue
  from a generation failure. **⚠ THIS BLOCKS the Session D item (c) verification** (§7 ledger row
  28) — profile 4 is where that check has to happen, so BUG 2 is ordered first. Full detail in §6.
- [ ] **Regenerate the logo with a transparent background.** `public/logo.png` currently has a solid (black) background; a transparent PNG would let the figure float on the app background instead of a black box. (Also tracked in §7 → Next up.)
- [ ] **Drive Fitbit → Google Health migration before the Sept-2026 shutdown.** The Google Health API v4 adapter is ✅ built (§3); the remaining work is getting every active Fitbit profile to reconnect via the reconsent banner so no one loses sync at cutover.
- [ ] **Drop the Fitbit adapter + legacy Fitbit paths after September 2026** once all active profiles have migrated to Google Health: remove the `profiles.fitbit_*` columns, the legacy `/auth` + `/callback` routes, `buildDailyData` / `runFitbitBackfill`, the `getValidProfileToken` Fitbit special-case inside `getValidWearableToken`, the Fitbit-first preference logic in `findWearableMatchOnSave` + the `unmatched-fitbit` endpoint, and the `wearables/fitbit.js` adapter.
- [ ] **Timezone verification — Google Health daily fetch.** The local-date fix (inline IIFE using `getFullYear`/`getMonth`/`getDate` instead of UTC `dateStr()`) appears to work, but logs still occasionally show a UTC date. Verify it applies correctly across timezone edge cases, particularly around midnight in negative-offset timezones.
- [ ] **Google Health weight returns null** in testing — verify once a user logs weight in the Fitbit/Google Health app. The `weightGrams / 453.592` lb conversion is implemented in `fetchDailyData`.
- [x] **`ON DELETE CASCADE` FK from `exercises.workout_id` → `workouts.id`.** ✅ **Migration run in production 2026-07-17** (`migrations/2026-07-17_exercises_workout_fk_cascade.sql`) — makes the orphaned-exercises bug class (fixed for `DELETE /api/workouts/:id` in session #11) structurally impossible even if a future endpoint deletes a workout some other way. The orphan report (`GET /api/debug/orphaned-exercises/:userId`) was run for every profile first, since the `ALTER TABLE` fails outright on any pre-existing orphan — profile 1 was cleaned in session #11, and its clean success confirms profiles 4/5/7/8 were orphan-free at run time too.
- [x] **Extend the same orphan-prevention fix to `DELETE /api/profiles/:id`** — ✅ **done 2026-07-17** (deletes `exercises` for the profile, then `workouts`, then the profile row). Deliberately kept independent of the FK above — see §6.
- [ ] **`recomputeRoadmapProgress()` / `assignNearTermDates()` run at READ time and never write back (D5/E6 — design approved, not yet built).** Both are called inside `GET /goals/:goalId`, `GET /roadmap-data`, and after `saveGoalToProfile()` in the check-in path — i.e. they mutate the in-memory object that is RETURNED while the object that was STORED keeps the raw model output. Consequence, observed live: the Goals tab rendered correct phase status while the stored `profile_data` the daily-rec prompt reads was wrong for weeks (see the two-current-phases item below). That divergence became load-bearing on 2026-07-19 when `buildRoadmapEmphasisContext()` started steering daily recs from stored phase state. **Do not create a second source of truth** — the fix is to persist the derived values, not to recompute in a second place.
- [ ] **`resequenceNearTermDates()` uses the SERVER clock, not the athlete's timezone (found 2026-07-19, F1).** It takes `ymdLocal(new Date())` where it should take `localToday(profile)` — the exact bug class session #6 fixed everywhere else. Live consequence, observed immediately after the Fix Pubic Osteitis repair: at 03:xx UTC the server date was 2026-07-20 while the athlete's Chicago date was still 2026-07-19, so the repair started the current phase "tomorrow" and the rec prompt resolved to the phase that had just completed for the remainder of that day. Self-resolves at local midnight, and the repair is one-time, so severity is low — but the same helper must take a profile before it is used again. **Same fix applies to the `today` argument in the admin endpoint that calls it.**
- [ ] **`assignNearTermDates()` cannot repair already-corrupted sequencing (found 2026-07-19, E7).** It sets `start_date` only `if (!p.start_date)` — deliberate ("fills only missing dates; preserves existing"), but it means once a bad adapt writes today's date onto every phase, the overlap is permanent. Live instance: Fix Pubic Osteitis' three near_term phases all carry `start_date: 2026-07-20` after an adapt returned `duration_weeks: "4-6"` (string range → `Number()` → NaN → weeks 0 → no end_date, every start pinned to today). The string-range hole is fixed both in the prompt and in `assignNearTermDates`, but the DATA needs a one-time re-sequence from the current phase forward. Needs a repair pass, not just the guard.
- [ ] **Roadmap adaptation could not re-evaluate a phase PREMISE (D8) — mitigated 2026-07-19, watch it.** Cause was structural, four parts: the adapt prompt's only advancement rule was "advance when completion_signals are met" (a completion test, never a premise test); `adaptGoalRoadmap` ran on Haiku while generation ran on Sonnet; the weekly auto-adapt passed the literal string "(no notes — automatic weekly review based on recent training)" so it had no signal a pause had ended; and the prompt's "keep phases that are still valid" bias had no stated exception. Live consequence: Build Muscle sat in a phase named "Progressive Overload (Paused)" whose first target began "Once training resumes:" for weeks after training resumed. Addressed by E1–E4 (Sonnet, DATE ROLLOVER + PREMISE VALIDITY checks, `buildWeeklyReviewContext()`, `enforceSingleCurrentPhase()`). Left open: the premise check is a prompt rule, so it is probabilistic — only the one-current-phase invariant is enforced in code. Re-check periodically that phase names/targets track reality.
- [ ] **Two phases marked `status:"current"` on one roadmap (D7, root cause shared with the item above).** Fix Posture carried both "Foundation & Awareness" (window 2026-05-28 → 2026-07-08) and "Strength & Integration" as `current`. NOT a race — adaptations were 8 days apart. The 2026-07-15 adapt advanced phase 2 but left phase 1 `current` because phase 1's window expired by DATE while its `completion_signals` were never met, and the prompt had no date-based rule. Stored data corrected by hand 2026-07-19; `enforceSingleCurrentPhase()` now enforces the invariant deterministically after both adapt and generate. **The data fix is not a fix for the class** — the read-time/write-time divergence above is what let it go unnoticed.
- [ ] **`maybeAdaptAllRoadmaps()` failures are invisible.** Fire-and-forget from `POST /api/workouts` (`server.js` ~2340) with `.catch(e => console.error(...))`; per-goal and macro failures inside it are `console.error` only. **Zero** references to `adapt_failed` / `last_adapt_error` / `adaptation_error` anywhere — nothing is persisted or surfaced. Partial mitigation by accident: `last_adapted_at` only advances on SUCCESS, so a failing goal stays stale and retries next save — but a persistently failing adapt would retry silently forever, and "not due" is indistinguishable from "failing". Same class as the A5 items.
- [ ] **`PATCH /api/workouts/:id` doesn't refresh stale `exercises` rows on a notes edit** — see §6 for the full gap. **Session #30 supplies the missing piece:** the re-merge endpoint (`/api/debug/remerge-workout-exercises/...`) *is* the replace-vs-diff answer — merge, never delete, keyed on `catalogNormKey`. Wiring `PATCH /api/workouts/:id` to fire it (fire-and-forget, like `maybeAdaptAllRoadmaps`) when `notes` actually changed would close this permanently. Not done — it turns an admin recovery tool into a hot path, which needs its own sign-off.
- [ ] **The 5 silent-failure sites found in session #30's A5 audit — same class as the extract-exercises bug, none fixed.** Each catches a failed write, logs it, and continues, while the response reports success with no failure counter: `runFitbitBackfill` steps (~`server.js:1751`) and body (~`:1795`) — `stepDays++`/`weightDays++` only increment on success, so a failure is indistinguishable from "no data"; `backfill-wearable-history` sleep (~`:8769`) and body_metrics (~`:8887`) — **no counter at all**; and steps (~`:8807`). All three history-backfill loops feed one summary that hardcodes `success:true` and reports `written/skipped/empty` with **no `failed` field**. Fix pattern is already written — mirror `extract-exercises`' `failures[]` + `partial_failure` (`5deede2`). Contrast: the wger seed/content/variation endpoints already do this correctly via an `errors` counter.
- [ ] **Add `created_at` / `updated_at` to the `workouts` table.** There is no audit trail today (see §6) — `ts` is client-supplied and overwritten on every edit, so "when was this row created vs last changed?" is unanswerable without structural inference. Blocked session #30's A3 diagnostic from being a lookup. Low effort, high diagnostic value.
- [ ] **`format_notes` render bugs need a PROMPT change, not just temperature (measured session #30).** Pinning `format_notes` to temperature 0 (`0fefbd6`) **did** stabilise output (1 distinct result across 3 identical calls) and **did** eliminate the stray markdown `#` heading. It did **NOT** remove `Notes:` / `None provided` — those are reproducibly emitted because the prompt itself says *"then a 'Notes:' section at the bottom"*, and the model fills it with a placeholder when there is no subjective content. The prompt needs "omit the Notes: section entirely when there is no subjective content". Separately, `renderLog()` (`public/index.html`) line-splits notes into `<li>` with no markdown handling at all, even though `parseMd()` already exists in the same file and is used for Coach Chat — so any markdown in stored notes leaks through verbatim.
- [ ] **Extraction prompt over-applies its "don't extract stretches/warm-ups" rule (found session #30).** Cost 3 unrecoverable rows: wid 106 `Figure-4 Stretch`, wid 72 `Elliptical` + `Indoor bike`. Inconsistent — `Figure Four Stretch` IS extracted for wid 42 from differently-worded notes. The rule's intent is "don't record a stretch as a *weighted* exercise", but it's suppressing the row entirely. Re-running the re-merge endpoint after a prompt fix would pick these up with no other change (it's idempotent and never deletes).
- [x] **✅ RESOLVED — `goal_estimate` is fully gone (confirmed session #31).** Was flagged as a dead `CALL_TYPE_MODEL` entry in session #30. A case-insensitive grep confirms `goal_estimate` now appears **nowhere** in `server.js` or `public/index.html` — absent from `CALL_TYPE_MODEL` and `CALL_TYPE_TEMPERATURE` both, and no call site. The "drop from both maps" work described here is already done; nothing outstanding.
- [ ] **Decide `daily_recs` temperature (Phase B).** Everything runs at the Anthropic default (1.0) unless pinned. `daily_recs` must **not** go to 0 — "Show me different options" would return the identical rec on every reroll. But 1.0 measurably loosens compliance with hard numeric constraints ("4–6 exercises MAX", and the duration budget Phase B adds); session #29's verbose-rec truncation is the same failure shape. Likely answer is ~0.6–0.7 plus client-side verification of the duration budget rather than trusting prompt compliance. Explicitly a Phase B decision, not actioned.
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
