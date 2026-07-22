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
    session({ date: "2026-07-22", duration_min: 45, goal_tags: ["Fix Posture", "Daily Meditation"],
      segments: [{ type: "straight_sets", duration_min: 45, exercises: [{ name: "Push-Up", sets: 3, reps: 8 }] }] }),
    session({ date: "2026-07-23", category: "martial_arts", intensity: "high", duration_min: 60, movable: false, goal_tags: ["Fix Posture"],
      segments: [{ type: "skill", duration_min: 60, intent: "MMA Class", exercises: [] }] }),
  ];
  var res = run(clean, c);
  assert.deepStrictEqual(res.violations, [], "clean input must not trip anything: " + JSON.stringify(res.violations));
  assert.deepStrictEqual(res.repairs, []);
});
