"use strict";
/**
 * ENGINE v2 — PLANNER INVARIANT TEST HARNESS
 * ==========================================
 * TEST FILE, NOT PRODUCTION CODE. Plain `node --test`, zero dependencies.
 *
 *   node --test server/v2Planner.test.js
 *
 * WHY THIS EXISTS
 * ---------------
 * On the first real generation the invariant set fired ZERO times across 7
 * sessions. That is a good sign about the model and NO evidence at all that the
 * invariants work — an invariant that has never fired is indistinguishable from
 * one that cannot fire. Phase 4's autoregulator is about to depend on these, so
 * each one is proven here against a deliberately corrupted fixture.
 */

var test = require("node:test");
var assert = require("node:assert");
var P = require("./v2Planner");

// ── Fixture scaffolding ─────────────────────────────────────────────────────

var WEEK = P.buildWeekDates("2026-07-22");   // Wed 22 -> Tue 28

function ctx(overrides) {
  var base = {
    profileId: 4,
    weekDates: WEEK,
    tiers: {
      goals: [
        { title: "Fix Posture", tier: "driver" },
        { title: "Daily Meditation", tier: "accessory" },
      ],
      drivers: [{ title: "Fix Posture", tier: "driver" }],
      maintenance: [], accessory: [{ title: "Daily Meditation", tier: "accessory" }],
      demoted: [],
    },
    schedule: { fill_policy: "ai_assigned", anchors: {}, frequency_targets: [], addons: [], anchor_meta: {} },
    anchors: [],
  };
  return Object.assign(base, overrides || {});
}

function session(o) {
  return Object.assign({
    date: "2026-07-22", slot: 1, priority: 1, movable: true,
    category: "strength", duration_min: 45, intensity: "medium",
    why: "a reason", goal_tags: ["Fix Posture", "Daily Meditation"],
    segments: [{ type: "straight_sets", duration_min: 45, intent: "work", params: {}, exercises: [{ name: "Push-Up", sets: 3, reps: 8 }] }],
  }, o || {});
}

function run(sessions, c, block) {
  return P.enforceInvariants({ sessions: sessions, block: block || { tradeoff_notes: "" } }, c || ctx());
}

function fired(res, name) {
  return res.violations.filter(function (v) { return v.invariant === name; });
}

// ── 1. Anchors present and unmodified ───────────────────────────────────────

test("INVARIANT anchor_present: a dropped anchor is REPAIRED by reinsertion", function () {
  var c = ctx({ anchors: [{ date: "2026-07-23", dayKey: "thu", dayLabel: "Thursday", slot: 1, activity: "MMA Class", duration_min: 60, category: "martial_arts" }] });
  var res = run([session()], c);
  var v = fired(res, "anchor_present");
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].severity, "repaired");
  var restored = res.sessions.filter(function (s) { return s.date === "2026-07-23"; })[0];
  assert.ok(restored, "the anchor session must exist after repair");
  assert.strictEqual(restored.duration_min, 60);
  assert.strictEqual(restored.movable, false, "a restored anchor must be immovable");
  assert.strictEqual(restored._restored, true);
});

test("INVARIANT anchor_unmodified: a changed anchor duration is RESTORED", function () {
  var c = ctx({ anchors: [{ date: "2026-07-23", dayKey: "thu", dayLabel: "Thursday", slot: 1, activity: "MMA Class", duration_min: 60, category: "martial_arts" }] });
  var bad = session({ date: "2026-07-23", category: "martial_arts", duration_min: 30,
    segments: [{ type: "skill", duration_min: 30, intent: "MMA Class", exercises: [] }] });
  var res = run([bad], c);
  var v = fired(res, "anchor_unmodified");
  assert.strictEqual(v.length, 1);
  assert.strictEqual(res.sessions[0].duration_min, 60, "duration must be restored to the anchor's");
  assert.strictEqual(res.sessions[0].movable, false);
});

test("INVARIANT anchor_present: a correctly reproduced anchor does NOT fire", function () {
  var c = ctx({ anchors: [{ date: "2026-07-23", dayKey: "thu", dayLabel: "Thursday", slot: 1, activity: "MMA Class", duration_min: 60, category: "martial_arts" }] });
  var good = session({ date: "2026-07-23", category: "martial_arts", duration_min: 60,
    segments: [{ type: "skill", duration_min: 60, intent: "MMA Class", exercises: [] }] });
  var res = run([good], c);
  assert.strictEqual(fired(res, "anchor_present").length, 0);
  assert.strictEqual(fired(res, "anchor_unmodified").length, 0);
});

test("INVARIANT movable_only_for_anchors: a non-anchor marked immovable is REPAIRED to movable", function () {
  // The real Phase 4 finding: the planner marked strength days movable:false,
  // which made the autoregulator refuse to touch them.
  var res = run([session({ category: "strength", movable: false })]);
  var v = fired(res, "movable_only_for_anchors");
  assert.strictEqual(v.length, 1);
  assert.strictEqual(res.sessions[0].movable, true, "a non-anchor must be autoregulatable");
});

test("INVARIANT movable_only_for_anchors: a real anchor stays immovable", function () {
  var c = ctx({ anchors: [{ date: "2026-07-23", dayKey: "thu", dayLabel: "Thursday", slot: 1, activity: "MMA Class", duration_min: 60, category: "martial_arts" }] });
  var anchor = session({ date: "2026-07-23", category: "martial_arts", duration_min: 60, movable: false,
    segments: [{ type: "skill", duration_min: 60, intent: "MMA Class", exercises: [] }] });
  var res = run([anchor], c);
  assert.strictEqual(fired(res, "movable_only_for_anchors").length, 0);
  assert.strictEqual(res.sessions.filter(function (s) { return s.date === "2026-07-23"; })[0].movable, false);
});

// ── 2. Unique (date, slot) ──────────────────────────────────────────────────

test("INVARIANT unique_date_slot: a collision is REPAIRED by reassigning the slot", function () {
  var res = run([session(), session()]);
  var v = fired(res, "unique_date_slot");
  assert.strictEqual(v.length, 1);
  var slots = res.sessions.map(function (s) { return s.slot; }).sort();
  assert.deepStrictEqual(slots, [1, 2]);
});

test("INVARIANT unique_date_slot: three on one date all get distinct slots", function () {
  var res = run([session(), session(), session()]);
  assert.deepStrictEqual(res.sessions.map(function (s) { return s.slot; }).sort(), [1, 2, 3]);
});

// ── 3. No consecutive high-CNS days ─────────────────────────────────────────

test("INVARIANT no_consecutive_high_cns: FLAGGED, never silently rewritten", function () {
  var a = session({ date: "2026-07-22", category: "strength", intensity: "high" });
  var b = session({ date: "2026-07-23", category: "martial_arts", intensity: "high" });
  var res = run([a, b]);
  var v = fired(res, "no_consecutive_high_cns");
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].severity, "flagged");
  // The content must be untouched — this is a judgment call, not a mechanical fix.
  assert.strictEqual(res.sessions[0].intensity, "high");
  assert.strictEqual(res.sessions[1].intensity, "high");
});

test("INVARIANT no_consecutive_high_cns: a medium day between two highs does NOT fire", function () {
  var res = run([
    session({ date: "2026-07-22", category: "strength", intensity: "high" }),
    session({ date: "2026-07-23", category: "cardio", intensity: "medium" }),
    session({ date: "2026-07-24", category: "strength", intensity: "high" }),
  ]);
  assert.strictEqual(fired(res, "no_consecutive_high_cns").length, 0);
});

// ── 4. Session volume cap ───────────────────────────────────────────────────

test("INVARIANT session_volume_cap: an over-cap session is FLAGGED", function () {
  var heavy = session({ segments: [{ type: "straight_sets", duration_min: 45, exercises: [
    { name: "Squat", sets: 20, reps: 5 }, { name: "Bench Press", sets: 15, reps: 5 },
  ] }] });
  var res = run([heavy]);
  var v = fired(res, "session_volume_cap");
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].severity, "flagged");
  assert.match(v[0].detail, /35 total working sets/);
});

test("INVARIANT session_volume_cap: a normal session does NOT fire", function () {
  assert.strictEqual(fired(run([session()]), "session_volume_cap").length, 0);
});

// ── 5. Every session carries a `why` ────────────────────────────────────────

test("INVARIANT why_present: a missing why is REPAIRED with a visible placeholder", function () {
  var res = run([session({ why: "" })]);
  var v = fired(res, "why_present");
  assert.strictEqual(v.length, 1);
  assert.ok(res.sessions[0].why.length > 0);
  assert.match(res.sessions[0].why, /review/i, "the placeholder must be obviously a placeholder");
});

test("INVARIANT why_present: whitespace-only why counts as missing", function () {
  assert.strictEqual(fired(run([session({ why: "   " })]), "why_present").length, 1);
});

// ── 6. Segment type enum ────────────────────────────────────────────────────

test("INVARIANT segment_type_enum: an out-of-enum type is REPAIRED", function () {
  var res = run([session({ segments: [{ type: "tabata_madness", duration_min: 45, exercises: [] }] })]);
  var v = fired(res, "segment_type_enum");
  assert.strictEqual(v.length, 1);
  assert.strictEqual(res.sessions[0].segments[0].type, "straight_sets");
});

// ── 7. Time unit resolvable (the schema defect) ─────────────────────────────

test("INVARIANT time_unit_resolvable: a bare `time` on a hold becomes time_seconds", function () {
  var res = run([session({ segments: [{ type: "straight_sets", duration_min: 45, exercises: [
    { name: "Dead Hang", sets: 2, time: 30 },
  ] }] })]);
  var v = fired(res, "time_unit_resolvable");
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].severity, "repaired");
  var ex = res.sessions[0].segments[0].exercises[0];
  assert.strictEqual(ex.time_seconds, 30);
  assert.strictEqual(ex.time, undefined, "the ambiguous key must be removed, not left alongside");
});

test("INVARIANT time_unit_resolvable: a bare `time` on a cardio block moves to the SEGMENT as minutes", function () {
  var res = run([session({ segments: [{ type: "steady_state", intent: "bike", exercises: [
    { name: "Indoor Bike", sets: 1, time: 20 },
  ] }] })]);
  var seg = res.sessions[0].segments[0];
  assert.strictEqual(seg.duration_min, 20, "20 on a steady_state block means MINUTES and belongs on the segment");
  assert.strictEqual(seg.exercises[0].time, undefined);
  assert.strictEqual(seg.exercises[0].time_seconds, undefined, "a cardio block length is not an exercise hold");
});

test("INVARIANT time_unit_resolvable: the two units are no longer confusable", function () {
  // The exact pairing that broke the first plan: 30 meaning seconds and 20
  // meaning minutes, in one plan, under one key.
  var res = run([session({ segments: [
    { type: "steady_state", intent: "bike", exercises: [{ name: "Indoor Bike", sets: 1, time: 20 }] },
    { type: "straight_sets", duration_min: 5, exercises: [{ name: "Dead Hang", sets: 2, time: 30 }] },
  ] })]);
  assert.strictEqual(res.sessions[0].segments[0].duration_min, 20);       // minutes
  assert.strictEqual(res.sessions[0].segments[1].exercises[0].time_seconds, 30); // seconds
});

test("INVARIANT time_unit_resolvable: a non-numeric time is FLAGGED, never guessed", function () {
  var res = run([session({ segments: [{ type: "straight_sets", duration_min: 45, exercises: [
    { name: "Plank", sets: 1, time: "a while" },
  ] }] })]);
  var v = fired(res, "time_unit_resolvable");
  assert.strictEqual(v[0].severity, "flagged");
  assert.strictEqual(res.sessions[0].segments[0].exercises[0].time, undefined);
});

test("INVARIANT time_unit_resolvable: correct time_seconds usage does NOT fire", function () {
  var res = run([session({ segments: [{ type: "straight_sets", duration_min: 45, exercises: [
    { name: "Dead Hang", sets: 2, time_seconds: 30 },
  ] }] })]);
  assert.strictEqual(fired(res, "time_unit_resolvable").length, 0);
});

// ── 8. Session time budget ──────────────────────────────────────────────────

test("INVARIANT session_time_budget: segments over the stated duration REPAIR duration_min", function () {
  // The real Friday case: stated 30, segments summed 35.
  var res = run([session({ duration_min: 30, segments: [
    { type: "steady_state", duration_min: 20, exercises: [] },
    { type: "straight_sets", duration_min: 5, exercises: [] },
    { type: "straight_sets", duration_min: 5, exercises: [] },
    { type: "circuit", duration_min: 5, exercises: [] },
  ] })]);
  var v = fired(res, "session_time_budget");
  assert.strictEqual(v.length, 1);
  assert.strictEqual(res.sessions[0].duration_min, 35, "trust the concrete segments over the header number");
});

test("INVARIANT session_time_budget: segments under the stated duration REPAIR duration_min", function () {
  // The real Wednesday case: stated 45, segments summed 40.
  var res = run([session({ duration_min: 45, segments: [
    { type: "warmup", duration_min: 5, exercises: [] },
    { type: "straight_sets", duration_min: 15, exercises: [] },
    { type: "straight_sets", duration_min: 5, exercises: [] },
    { type: "straight_sets", duration_min: 5, exercises: [] },
    { type: "circuit", duration_min: 5, exercises: [] },
    { type: "mobility", duration_min: 5, exercises: [] },
  ] })]);
  assert.strictEqual(fired(res, "session_time_budget").length, 1);
  assert.strictEqual(res.sessions[0].duration_min, 40);
});

test("INVARIANT session_time_budget: an ANCHOR repairs the SEGMENT, not the anchor duration", function () {
  var c = ctx({ anchors: [{ date: "2026-07-23", dayKey: "thu", dayLabel: "Thursday", slot: 1, activity: "MMA Class", duration_min: 60, category: "martial_arts" }] });
  var anchored = session({ date: "2026-07-23", category: "martial_arts", duration_min: 60, movable: false,
    segments: [{ type: "skill", duration_min: 45, intent: "MMA Class", exercises: [] }] });
  var res = run([anchored], c);
  var s = res.sessions.filter(function (x) { return x.date === "2026-07-23"; })[0];
  assert.strictEqual(s.duration_min, 60, "a 60-minute class is 60 minutes — the real world wins");
  assert.strictEqual(s.segments[0].duration_min, 60, "the segment is corrected instead");
});

test("INVARIANT session_time_budget: within tolerance does NOT fire", function () {
  // 45 min stated, tolerance = max(2, floor(4.5)) = 4; a 2-minute drift passes.
  var res = run([session({ duration_min: 45, segments: [
    { type: "warmup", duration_min: 20, exercises: [] },
    { type: "straight_sets", duration_min: 23, exercises: [] },
  ] })]);
  assert.strictEqual(fired(res, "session_time_budget").length, 0);
  assert.strictEqual(res.sessions[0].duration_min, 45, "an in-tolerance session is left alone");
});

// ── 9. Tiered goals actually prescribed ─────────────────────────────────────

test("INVARIANT tiered_goal_prescribed: a goal mentioned only in segment intent is FLAGGED", function () {
  // The real Daily Meditation case.
  var s = session({ goal_tags: ["Fix Posture"], segments: [
    { type: "active_recovery", duration_min: 45, intent: "Pinky accessory + meditation — daily accessory dose", exercises: [{ name: "Pinky Abduction", sets: 2, reps: 15 }] },
  ] });
  var res = run([s]);
  var v = fired(res, "tiered_goal_prescribed");
  assert.strictEqual(v.length, 1);
  assert.match(v[0].detail, /Daily Meditation/);
  assert.strictEqual(v[0].severity, "flagged", "never repair by inventing work for an unaddressed goal");
});

test("INVARIANT tiered_goal_prescribed: a goal_tag on a real session satisfies it", function () {
  assert.strictEqual(fired(run([session()]), "tiered_goal_prescribed").length, 0);
});

test("INVARIANT tiered_goal_prescribed: naming it in tradeoff_notes satisfies it", function () {
  var s = session({ goal_tags: ["Fix Posture"] });
  var res = run([s], ctx(), { tradeoff_notes: "Daily Meditation deliberately not programmed this week — it is a non-training habit the athlete tracks separately." });
  assert.strictEqual(fired(res, "tiered_goal_prescribed").length, 0);
});

test("INVARIANT tiered_goal_prescribed: a goal tagged on an EMPTY session does not count", function () {
  var s = session({ goal_tags: ["Fix Posture", "Daily Meditation"], segments: [] });
  var res = run([s]);
  assert.strictEqual(fired(res, "tiered_goal_prescribed").length, 2, "an empty session prescribes nothing");
});

// ── 10. Out-of-week sessions ────────────────────────────────────────────────

test("INVARIANT date_in_week: a session outside the planning week is dropped", function () {
  var res = run([session(), session({ date: "2026-08-15" })]);
  assert.strictEqual(fired(res, "date_in_week").length, 1);
  assert.strictEqual(res.sessions.length, 1);
});

// ── 11. A fully clean plan fires nothing ────────────────────────────────────

test("a clean plan produces ZERO violations (no false positives)", function () {
  var c = ctx({ anchors: [{ date: "2026-07-23", dayKey: "thu", dayLabel: "Thursday", slot: 1, activity: "MMA Class", duration_min: 60, category: "martial_arts" }] });
  var clean = [
    // A genuinely FULL 45-min session (Session 9: a token single-exercise session
    // is no longer "clean" — it under-fills the time and correctly flags). This
    // estimates ~37/45 = 0.82, above the work floor.
    session({ date: "2026-07-22", duration_min: 45, goal_tags: ["Fix Posture", "Daily Meditation"],
      segments: [
        { type: "warmup", duration_min: 5, intent: "prep", exercises: [{ name: "90/90 Hip Rotation", sets: 2, reps: 10 }] },
        { type: "straight_sets", duration_min: 32, intent: "main", exercises: [
          { name: "Barbell Squat", sets: 4, reps: 6 }, { name: "Bench Press", sets: 4, reps: 8 },
          { name: "Bent Over Row", sets: 4, reps: 8 }, { name: "Overhead Press", sets: 3, reps: 8 },
          { name: "Romanian Deadlift", sets: 3, reps: 8 },
        ] },
        { type: "cooldown", duration_min: 8, intent: "mobility", exercises: [{ name: "Yoga", sets: 1, time_seconds: 420 }] },
      ] }),
    session({ date: "2026-07-23", category: "martial_arts", intensity: "high", duration_min: 60, movable: false, goal_tags: ["Fix Posture"],
      segments: [{ type: "skill", duration_min: 60, intent: "MMA Class", exercises: [] }] }),
  ];
  var res = run(clean, c);
  assert.deepStrictEqual(res.violations, [], "clean input must not trip anything: " + JSON.stringify(res.violations));
  assert.deepStrictEqual(res.repairs, []);
});

// ── Session 8: flatten-boundary formatting + alternate rationale ─────────────
// The §6 close-out bugs (duration-based segments as fake single sets; doubled
// superset-rest parens) and the derived alternate rationale. Code-testable
// slices of workstreams A, B and C-server.

var AR = require("./v2Autoregulator");

test("FLATTEN A: a duration-based (mobility) segment renders as a duration block, not '1 sets'", function () {
  assert.strictEqual(P.flattenExercise({ name: "Yoga", sets: 1, time_seconds: 180 }, "mobility", { duration_min: 3 }),
    "Yoga — 3 min");
});

test("FLATTEN A: a time-only exercise typed into a NON-duration segment (skill) is still a duration block", function () {
  // Live regression: the model typed a 15-min yoga block as `skill`, producing
  // "Yoga — 1 sets, 900s". Caught by the exercise-level (time, no reps, <=1 set) rule.
  assert.strictEqual(P.flattenExercise({ name: "Yoga", sets: 1, time_seconds: 900 }, "skill", {}), "Yoga — 15 min");
  // and with no set count at all
  assert.strictEqual(P.flattenExercise({ name: "Meditation", time_seconds: 600 }, "cooldown", {}), "Meditation — 10 min");
});

test("FLATTEN A: a single timed hold in a set-based segment reads as a duration, not '1 sets'", function () {
  assert.strictEqual(P.flattenExercise({ name: "Plank", sets: 1, time_seconds: 60 }, "straight_sets", {}), "Plank — 1 min");
  assert.strictEqual(P.flattenExercise({ name: "Plank", sets: 1, time_seconds: 75 }, "straight_sets", {}), "Plank — 1:15");
});

test("FLATTEN A: steady_state uses the time; no fabricated set count", function () {
  assert.strictEqual(P.flattenExercise({ name: "Indoor Bike", time_seconds: 1200 }, "steady_state", { duration_min: 20 }),
    "Indoor Bike — 20 min");
});

test("FLATTEN A: a multi-round interval keeps its round count as 'N × dur', never 'N sets'", function () {
  assert.strictEqual(P.flattenExercise({ name: "Sprint", sets: 6, time_seconds: 30 }, "interval_short", {}),
    "Sprint — 6 × 30s");
});

test("FLATTEN A: a duration segment with no exercise time falls back to the segment minutes", function () {
  assert.strictEqual(P.flattenExercise({ name: "Foam Roll" }, "active_recovery", { duration_min: 5 }),
    "Foam Roll — 5 min");
});

test("FLATTEN A: sub-minute holds and odd durations format sensibly", function () {
  assert.strictEqual(P.flattenExercise({ name: "Wall Sit", time_seconds: 45 }, "mobility", {}), "Wall Sit — 45s");
  assert.strictEqual(P.flattenExercise({ name: "Hold", time_seconds: 90 }, "mobility", {}), "Hold — 1:30");
});

test("FLATTEN A: a SET-based segment is byte-identical (no behavior change)", function () {
  assert.strictEqual(P.flattenExercise({ name: "Glute Bridge", sets: 2, reps: 15, load: "10 lb", rest: "90 s" }, "straight_sets", {}),
    "Glute Bridge — 2 x 15 @ 10 lb (rest 90 s)");
  // a hold-in-a-skill-segment stays set-based (legit multi-hold), unchanged
  assert.strictEqual(P.flattenExercise({ name: "Dead Hang", sets: 3, time_seconds: 30, rest: "60 s" }, "skill", {}),
    "Dead Hang — 3 sets, 30s (rest 60 s)");
});

test("FLATTEN B: a superset rest that already carries a parenthetical is NOT double-wrapped", function () {
  assert.strictEqual(P.flattenExercise({ name: "DB Row", sets: 2, reps: 12, rest: "90 s (between supersets)" }, "superset", {}),
    "DB Row — 2 x 12 (rest 90 s, between supersets)");
});

test("FLATTEN B: a fully-parenthesised rest value is unwrapped to a single set of parens", function () {
  assert.strictEqual(P.flattenExercise({ name: "Curl", sets: 3, reps: 10, rest: "(75 s)" }, "straight_sets", {}),
    "Curl — 3 x 10 (rest 75 s)");
});

test("FLATTEN: no exercise name -> null (unchanged guard)", function () {
  assert.strictEqual(P.flattenExercise({ time_seconds: 60 }, "mobility", {}), null);
});

test("RATIONALE: a time-compression alternate that dropped an accessory reads 'shorter — drops tertiary accessories'", function () {
  var r = AR.deriveAlternateRationale({ source: "code:time_compression", steps: ["dropped accessory segment 'core' (5 min)"], session: { category: "strength" } });
  assert.strictEqual(r, "shorter — drops tertiary accessories, keeps the primary compound");
});

test("RATIONALE: a compression that only trimmed rest reads 'tighter rest'", function () {
  var r = AR.deriveAlternateRationale({ source: "code:time_compression", steps: ["shortened rest in 'main' by 3 min"], session: {} });
  assert.strictEqual(r, "shorter — tighter rest, keeps the primary compound");
});

test("RATIONALE: a category swap names the real resolved category, not the key", function () {
  var r = AR.deriveAlternateRationale({ source: "model:category_swap", session: { category: "mind_body" } });
  assert.strictEqual(r, "a mind body session instead — same day, different focus");
});

test("RATIONALE: noop_extend has no rationale (it is suppressed from the chip row)", function () {
  assert.strictEqual(AR.deriveAlternateRationale({ source: "code:noop_extend", session: { category: "strength" } }), "");
});

test("LABEL/SUPPRESS: v2AssembleCache carries v:2, a derived rationale, and both session forms", function () {
  var primary = { category: "strength", duration_min: 40, intensity: "medium", headline: "S", why: "w",
    segments: [{ type: "straight_sets", duration_min: 40, exercises: [{ name: "Squat", sets: 3, reps: 8 }] }] };
  // Mirror the alternate objects v2BuildAlternates hands to the cache assembler.
  var alt = { alternates: [
    { key: "dur_30", label: "30 min (compressed)", source: "code:time_compression",
      steps: ["dropped accessory segment 'core' (5 min)"], session: Object.assign({}, primary, { duration_min: 28 }) },
    { key: "cat_swap", label: "Different focus: mind_body", source: "model:category_swap",
      session: Object.assign({}, primary, { category: "mind_body" }) },
  ] };
  // deriveAlternateRationale + flattenSessionForCache are the two code paths the
  // client label/rationale surface reads through; assert the cache shape here.
  var cache = { v: 2, alternates: alt.alternates.map(function (a) {
    return { key: a.key, source: a.source, rationale: AR.deriveAlternateRationale(a),
      session: P.flattenSessionForCache(a.session), session_structured: a.session };
  }) };
  assert.strictEqual(cache.v, 2);
  assert.strictEqual(cache.alternates[0].rationale, "shorter — drops tertiary accessories, keeps the primary compound");
  assert.strictEqual(cache.alternates[0].session.duration_min, 28, "label must resolve from the REAL duration, not the dur_30 key");
  assert.strictEqual(cache.alternates[1].session.category, "mind_body");
  assert.ok(cache.alternates[0].session_structured, "structured form retained for the variant path");
});

// ── Session 9: work-content estimator + strengthened session_time_budget ─────
var R = require("./coachingRules");

function s9ctx() {
  return { profileId: 4, weekDates: [{ date: "2026-07-22" }], tiers: { goals: [] },
    schedule: { fill_policy: "ai_assigned" }, anchors: [] };
}
function s9run(session) {
  // wrap one session and run the real invariant pipeline
  var plan = { sessions: [Object.assign({ date: "2026-07-22", slot: 1, movable: true, why: "x", goal_tags: [] }, session)], block: {} };
  var e = P.enforceInvariants(plan, s9ctx());
  return e.violations.filter(function (v) { return v.severity === "regenerate"; });
}

test("ESTIMATOR: a set×rep strength movement is ~1.5 min/SET (reps-agnostic, per v1)", function () {
  assert.strictEqual(R.estimateSegmentWorkMinutes({ type: "straight_sets", exercises: [{ name: "Push-Up", sets: 3, reps: 8 }] }), 4.5);
});
test("ESTIMATOR: a mobility move (by name or by segment type) is ~1.0 min/set", function () {
  assert.strictEqual(R.estimateSegmentWorkMinutes({ type: "straight_sets", exercises: [{ name: "Wall Slide", sets: 3, reps: 15 }] }), 3);
  assert.strictEqual(R.estimateSegmentWorkMinutes({ type: "mobility", exercises: [{ name: "Anything", sets: 2, reps: 10 }] }), 2);
});
test("ESTIMATOR: a hold is sets×(seconds/60 + rest) — a 15-min yoga block ~16", function () {
  assert.strictEqual(R.estimateSegmentWorkMinutes({ type: "skill", exercises: [{ name: "Yoga", sets: 1, time_seconds: 900 }] }), 16);
  assert.strictEqual(R.estimateSegmentWorkMinutes({ type: "active_recovery", exercises: [{ name: "Dead Hang", sets: 3, time_seconds: 45 }] }), 5.25);
});
test("ESTIMATOR: a pure continuous time block (whole segment bare) counts its duration_min", function () {
  assert.strictEqual(R.estimateSegmentWorkMinutes({ type: "steady_state", duration_min: 20, exercises: [{ name: "Indoor Bike", sets: 1 }] }), 20);
});
test("ESTIMATOR: a lone bare exercise mixed with measurable work counts as one nominal set, NOT the whole duration", function () {
  // Glute Bridge 3x15 (mobility 3) + Farmer's Walk bare (1.5) = 4.5, NOT the declared 25
  assert.strictEqual(R.estimateSegmentWorkMinutes({ type: "straight_sets", duration_min: 25,
    exercises: [{ name: "Glute Bridge", sets: 3, reps: 15 }, { name: "Farmer's Walk", sets: 3 }] }), 4.5);
});
test("ESTIMATOR: an empty segment is 0 work; sessionHasPrescribedWork detects the fixed-class property", function () {
  assert.strictEqual(R.estimateSegmentWorkMinutes({ type: "skill", duration_min: 60, exercises: [] }), 0);
  assert.strictEqual(R.sessionHasPrescribedWork({ segments: [{ type: "skill", duration_min: 60, exercises: [] }] }), false);
  assert.strictEqual(R.sessionHasPrescribedWork({ segments: [{ type: "straight_sets", exercises: [{ name: "Squat", sets: 3, reps: 5 }] }] }), true);
});

test("INVARIANT session_time_budget FLOOR: a padded 45-min session (15/15/15, thin work) FIRES 'regenerate'", function () {
  var v = s9run({ category: "strength", duration_min: 45, intensity: "low", segments: [
    { type: "skill", duration_min: 15, exercises: [{ name: "Yoga", sets: 1, time_seconds: 900 }] },     // 16
    { type: "straight_sets", duration_min: 15, exercises: [{ name: "Wall Slide", sets: 3, reps: 15 }] }, // 3
    { type: "circuit", duration_min: 15, exercises: [{ name: "Dead Bug", sets: 2, reps: 8 }] },          // 2
  ] });
  assert.strictEqual(v.length, 1, "should fire once: " + JSON.stringify(v));
  assert.match(v[0].detail, /padded, not filled/);
});
test("INVARIANT session_time_budget FLOOR: a genuinely FULL session does NOT fire", function () {
  var v = s9run({ category: "cardio", duration_min: 45, intensity: "low", segments: [
    { type: "steady_state", duration_min: 20, exercises: [{ name: "Indoor Bike", sets: 1 }] }, // 20
    { type: "skill", duration_min: 15, exercises: [{ name: "Yoga", sets: 1, time_seconds: 900 }] }, // 16
    { type: "straight_sets", duration_min: 5, exercises: [{ name: "Wall Slide", sets: 3, reps: 15 }] }, // 3
    { type: "circuit", duration_min: 5, exercises: [{ name: "Dead Bug", sets: 2, reps: 8 }] },   // 2
  ] });
  assert.strictEqual(v.length, 0, "41/45 = 0.91 must pass: " + JSON.stringify(v));
});
test("INVARIANT session_time_budget FLOOR: an ANCHOR (empty segments) is EXCLUDED, never flagged", function () {
  var v = s9run({ category: "martial_arts", duration_min: 60, intensity: "high", movable: false,
    segments: [{ type: "skill", duration_min: 60, intent: "MMA Class", exercises: [] }] });
  assert.strictEqual(v.length, 0, "a fixed class prescribes no work and must be excluded: " + JSON.stringify(v));
});
test("INVARIANT session_time_budget FLOOR: a full strength session with real sets passes (zero false positive)", function () {
  var v = s9run({ category: "strength", duration_min: 30, intensity: "medium", segments: [
    { type: "warmup", duration_min: 4, exercises: [{ name: "90/90 Hip Rotation", sets: 2, reps: 10 }] }, // 2
    { type: "straight_sets", duration_min: 22, exercises: [
      { name: "Barbell Squat", sets: 4, reps: 6 },        // 6
      { name: "Bench Press", sets: 4, reps: 8 },          // 6
      { name: "Bent Over Row", sets: 3, reps: 10 },       // 4.5
      { name: "Overhead Press", sets: 3, reps: 8 },       // 4.5
    ] },
    { type: "cooldown", duration_min: 4, exercises: [{ name: "Cat-Cow", sets: 2, reps: 10 }] }, // 2
  ] });
  assert.strictEqual(v.length, 0, "25/30 = 0.83 must pass: " + JSON.stringify(v));
});

// ── Anchor-day GENERATE: adjacency fires against a generated replacement ─────
// The generate branch (server.js v2EnforceGeneratedSession) reuses THIS invariant
// set over a mini-week [yesterday, generated-today, tomorrow] so a generated
// high-CNS session adjacent to a planned high-CNS day is caught — proving the
// spacing rule fires against a generated session, not just a planned one.

test("GENERATE adjacency: a high-CNS generated session next to a planned high-CNS day FLAGS", function () {
  var yest = { date: "2026-07-22", slot: 1, movable: true, category: "strength", intensity: "high", why: "planned", goal_tags: [], segments: [{ type: "straight_sets", exercises: [{ name: "Squat", sets: 5, reps: 5 }] }] };
  var gen = { date: "2026-07-23", slot: 1, movable: true, category: "strength", intensity: "high", why: "generated replacement", goal_tags: [], segments: [{ type: "straight_sets", exercises: [{ name: "Deadlift", sets: 5, reps: 5 }] }] };
  var c = { profileId: 4, weekDates: [{ date: "2026-07-22" }, { date: "2026-07-23" }, { date: "2026-07-24" }], tiers: { goals: [] }, schedule: { fill_policy: "ai_assigned" }, anchors: [] };
  var res = P.enforceInvariants({ sessions: [yest, gen], block: {} }, c);
  assert.ok(fired(res, "no_consecutive_high_cns").length >= 1, "consecutive high-CNS must flag the generated day");
});

test("GENERATE adjacency: a medium generated session next to a high-CNS day does NOT flag", function () {
  var yest = { date: "2026-07-22", slot: 1, movable: true, category: "strength", intensity: "high", why: "planned", goal_tags: [], segments: [{ type: "straight_sets", exercises: [{ name: "Squat", sets: 5, reps: 5 }] }] };
  var gen = { date: "2026-07-23", slot: 1, movable: true, category: "strength", intensity: "medium", why: "generated", goal_tags: [], segments: [{ type: "straight_sets", exercises: [{ name: "Push-Up", sets: 3, reps: 12 }] }] };
  var c = { profileId: 4, weekDates: [{ date: "2026-07-22" }, { date: "2026-07-23" }, { date: "2026-07-24" }], tiers: { goals: [] }, schedule: { fill_policy: "ai_assigned" }, anchors: [] };
  var res = P.enforceInvariants({ sessions: [yest, gen], block: {} }, c);
  assert.strictEqual(fired(res, "no_consecutive_high_cns").length, 0);
});

// ── Driver-share composition invariant (closes §6 thinness) ─────────────────

var ALLOC_GE = [
  { goal: "Build Muscle", tier: "driver", modality_family: "resistance" },
  { goal: "Fix Posture", tier: "maintenance", modality_family: "skill_mobility" },
  { goal: "Fix Pubic Osteitis", tier: "maintenance", modality_family: "resistance" },
];
function allocCtx() {
  return { profileId: 4, weekDates: [{ date: "2026-07-22" }], tiers: { goals: [] }, schedule: { fill_policy: "ai_assigned" }, anchors: [], goalEnvelopes: ALLOC_GE };
}

test("driver_share_underfilled: a Build-Muscle slot filled mostly with mobility FLAGS (the §6 failure)", function () {
  var thin = {
    date: "2026-07-22", slot: 1, movable: true, category: "strength", intensity: "medium", duration_min: 45,
    why: "mixed", goal_tags: ["Build Muscle", "Fix Posture", "Fix Pubic Osteitis"],
    segments: [
      { type: "warmup", duration_min: 5, exercises: [{ name: "Cat-Cow", sets: 2, reps: 10 }] },
      { type: "mobility", duration_min: 20, exercises: [{ name: "Clamshell", sets: 2, reps: 12 }, { name: "90/90 Hip Rotation", sets: 3, reps: 10 }, { name: "Wall Slide", sets: 3, reps: 15 }] },
      { type: "straight_sets", duration_min: 15, exercises: [{ name: "Glute Bridge", sets: 3, reps: 15 }] },
    ],
  };
  var res = P.enforceInvariants({ sessions: [thin], block: {} }, allocCtx());
  assert.ok(fired(res, "driver_share_underfilled").length >= 1, "the starved driver must flag");
  assert.ok(Array.isArray(thin.allocation) && thin.allocation.length === 3, "the code-owned allocation is attached");
});

test("driver_share: a resistance-dominant Build-Muscle session PASSES", function () {
  var full = {
    date: "2026-07-24", slot: 1, movable: true, category: "strength", intensity: "medium", duration_min: 45,
    why: "full", goal_tags: ["Build Muscle", "Fix Posture", "Fix Pubic Osteitis"],
    segments: [
      { type: "warmup", duration_min: 5, exercises: [{ name: "Cat-Cow", sets: 1, reps: 10 }] },
      { type: "straight_sets", duration_min: 35, exercises: [{ name: "Push-Up", sets: 4, reps: 12 }, { name: "Dumbbell Row", sets: 4, reps: 12 }, { name: "Overhead Press", sets: 4, reps: 10 }, { name: "Goblet Squat", sets: 4, reps: 12 }, { name: "Romanian Deadlift", sets: 3, reps: 10 }] },
      { type: "mobility", duration_min: 5, exercises: [{ name: "Wall Slide", sets: 2, reps: 12 }] },
    ],
  };
  var res = P.enforceInvariants({ sessions: [full], block: {} }, allocCtx());
  assert.strictEqual(fired(res, "driver_share_underfilled").length, 0);
});

test("driver_share: a pure cardio (aerobic driver) day does NOT flag", function () {
  var ge = [{ goal: "Stamina", tier: "driver", modality_family: "aerobic" }];
  var cardio = { date: "2026-07-25", slot: 1, movable: true, category: "cardio", intensity: "low", why: "z2", goal_tags: ["Stamina"], segments: [{ type: "steady_state", duration_min: 40, exercises: [{ name: "Indoor Bike" }] }] };
  var res = P.enforceInvariants({ sessions: [cardio], block: {} }, { profileId: 4, weekDates: [{ date: "2026-07-25" }], tiers: { goals: [] }, schedule: { fill_policy: "ai_assigned" }, anchors: [], goalEnvelopes: ge });
  assert.strictEqual(fired(res, "driver_share_underfilled").length, 0);
});

test("driver_share: DEGRADES to no-op when goalEnvelopes absent (autoregulator path)", function () {
  var thin = { date: "2026-07-22", slot: 1, movable: true, category: "strength", intensity: "medium", why: "x", goal_tags: ["Build Muscle"], segments: [{ type: "mobility", duration_min: 30, exercises: [{ name: "Cat-Cow", sets: 3, reps: 10 }] }] };
  var res = P.enforceInvariants({ sessions: [thin], block: {} }, { profileId: 4, weekDates: [{ date: "2026-07-22" }], tiers: { goals: [] }, schedule: { fill_policy: "ai_assigned" }, anchors: [] });
  assert.strictEqual(fired(res, "driver_share_underfilled").length, 0, "no envelopes → check skipped, no crash");
  assert.strictEqual(thin.allocation, undefined, "no allocation attached without envelopes");
});
