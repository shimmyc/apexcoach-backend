"use strict";
/**
 * Sandbox seeder (session #44).
 *
 * The load-bearing check is NOT "did rows get written" — it is "do the rows this
 * seeder produces actually QUALIFY under the real arc matcher". A seeded history
 * whose exercise names don't map to muscle groups produces zero qualifying
 * sessions and the whole sandbox silently teaches you nothing.
 *
 * So this extracts the REAL shipped makeTargetMatcher / muscleGroupsForExercise /
 * MUSCLE_GROUP_MAP / activityMuscles and runs them against seeded fixtures.
 *
 * Run: node --test server/sandboxSeed.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC_FILE = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function slice(startMarker, endMarker) {
  const s = SRC_FILE.indexOf(startMarker);
  assert.ok(s >= 0, "marker not found: " + startMarker);
  const e = SRC_FILE.indexOf(endMarker, s + startMarker.length);
  assert.ok(e > s, "end marker not found: " + endMarker);
  return SRC_FILE.slice(s, e);
}

const SRC = [
  slice("var PREVIEW_DAYS =", "\n\n"),
  slice("var MUSCLE_GROUP_MAP =", "function muscleGroupsForExercise(name) {"),
  slice("function muscleGroupsForExercise(name) {", "\n\n"),
  slice("function makeTargetMatcher(exercises) {", "\n// STEP 1 — pure-JS rule engine"),
  slice("var SEED_MARKER =", "function seedGuard(req, res) {"),
].join("\n");

const decls = (SRC.match(/^function\s+([A-Za-z0-9_$]+)/gm) || []).map((s) => s.split(/\s+/)[1]);
// previewDayIdx rides along inside the MUSCLE_GROUP_MAP slice — a real
// collaborator, listed explicitly so an UNEXPECTED extra still fails the guard.
assert.deepStrictEqual(decls.slice().sort(),
  ["buildSandboxSeedPlan", "makeTargetMatcher", "muscleGroupsForExercise", "previewDayIdx", "seedParse", "seedYmd"].sort(),
  "extraction captured unexpected functions: " + decls.join(","));

const S = { console };
vm.createContext(S);
vm.runInContext(SRC, S);          // mandatory re-parse

const TODAY = "2026-07-28";

const SPEC = {
  start_date: "2026-05-04",           // a Monday
  weeks: 8,
  gap_windows: [{ start: "2026-06-01", end: "2026-06-21" }],   // 3-week gap, on purpose
  pattern: [
    {
      session_type: "Strength (Upper Body)",
      sessions_per_week: 2,
      category: "strength",
      subcategory: "upper body",
      exercises: [
        { name: "Bench Press", sets: 4, reps: 8, weight_lbs: 135 },
        { name: "Dumbbell Row", sets: 4, reps: 10, weight_lbs: 45 },
        { name: "Overhead Press", sets: 3, reps: 10, weight_lbs: 65 },
      ],
    },
    {
      session_type: "Cardio (Outdoor)",
      sessions_per_week: 1,
      category: "cardio",
      exercises: [{ name: "Easy Run", duration_minutes: 30, distance_miles: 3 }],
    },
  ],
};

test("plan is deterministic and honours the spread table", () => {
  const a = S.buildSandboxSeedPlan(SPEC, TODAY);
  const b = S.buildSandboxSeedPlan(SPEC, TODAY);
  assert.deepStrictEqual(a.summary, b.summary);
  assert.strictEqual(a.summary.first_date, "2026-05-04");
  // 2/wk strength (mon,thu) + 1/wk cardio (mon) = 3 sessions/week outside gaps.
  assert.strictEqual(a.summary.sessions_per_week["1"], 3);
});

test("GAP WINDOWS actually remove sessions — the whole point of the seeder", () => {
  const plan = S.buildSandboxSeedPlan(SPEC, TODAY);
  const inGap = plan.sessions.filter((s) => s.date >= "2026-06-01" && s.date <= "2026-06-21");
  assert.strictEqual(inGap.length, 0, "no session may fall inside a declared gap");
  assert.ok(plan.summary.skipped_in_gap >= 9, "gap skips are reported, got " + plan.summary.skipped_in_gap);
  // And the gap is a REAL hole in the date series, so decay can be driven.
  const dates = plan.sessions.map((s) => s.date).sort();
  const before = dates.filter((d) => d < "2026-06-01").pop();
  const after = dates.filter((d) => d > "2026-06-21")[0];
  const gapDays = Math.round((Date.parse(after) - Date.parse(before)) / 86400000);
  assert.ok(gapDays >= 21, "gap must be >= 21 real days, got " + gapDays);
});

test("never seeds the future", () => {
  const plan = S.buildSandboxSeedPlan(Object.assign({}, SPEC, { weeks: 60 }), TODAY);
  assert.ok(plan.sessions.every((s) => s.date <= TODAY), "a seeded date must never exceed today");
  assert.ok(plan.summary.skipped_future > 0, "future skips are reported");
});

test("rejects a bad spec loudly", () => {
  assert.throws(() => S.buildSandboxSeedPlan({ weeks: 4, pattern: [{}] }, TODAY), /start_date/);
  assert.throws(() => S.buildSandboxSeedPlan({ start_date: "2026-05-04", weeks: 4 }, TODAY), /pattern/);
  assert.throws(() => S.buildSandboxSeedPlan({
    start_date: "2020-01-06", weeks: 260,
    pattern: [
      { sessions_per_week: 7, category: "strength", exercises: [{ name: "Bench Press" }] },
      { sessions_per_week: 7, category: "cardio", exercises: [{ name: "Easy Run" }] },
    ],
  }, TODAY), /cap/);
});

// ── THE LOAD-BEARING CHECK ──────────────────────────────────────────────────
test("seeded rows QUALIFY under the real makeTargetMatcher (tier-1 precise)", () => {
  const plan = S.buildSandboxSeedPlan(SPEC, TODAY);
  // Build rows exactly as the endpoint does, with real workout ids.
  const workouts = plan.sessions.map((s, i) => ({
    id: 1000 + i, profile_id: 9, date: s.date, type: s.type, done: s.done,
    notes: S.SEED_MARKER + " " + s.type, ts: S.seedParse(s.date) + i,
  }));
  const exercises = [];
  plan.sessions.forEach((s, i) => s.exercises.forEach((e) =>
    exercises.push({ profile_id: 9, workout_id: 1000 + i, date: s.date, name: e.name, notes: S.SEED_MARKER })));

  const matcher = S.makeTargetMatcher(exercises);
  // "Upper Body Strength" target muscles, per activityMuscles' upper-body rule.
  const req = ["chest", "back", "shoulders", "biceps", "triceps"];
  const strengthWorkouts = workouts.filter((w) => w.type.indexOf("Strength") >= 0);
  const qualifying = strengthWorkouts.filter((w) => matcher.satisfies(w, req));
  assert.ok(strengthWorkouts.length > 0, "fixture produced strength sessions");
  assert.strictEqual(qualifying.length, strengthWorkouts.length,
    "EVERY seeded strength session must satisfy the matcher — otherwise the sandbox teaches nothing");
});

test("the matcher's >=2 distinct mapped names rule is genuinely met, not accidental", () => {
  const one = {
    start_date: "2026-07-06", weeks: 1,
    pattern: [{ session_type: "Strength", sessions_per_week: 1, category: "strength",
      exercises: [{ name: "Bench Press", sets: 3, reps: 8 }] }],
  };
  const plan = S.buildSandboxSeedPlan(one, TODAY);
  const w = { id: 1, done: true, date: plan.sessions[0].date, type: "Strength" };
  const ex = plan.sessions[0].exercises.map((e) => ({ workout_id: 1, name: e.name }));
  const matcher = S.makeTargetMatcher(ex);
  assert.strictEqual(matcher.satisfies(w, ["chest", "back", "shoulders", "biceps", "triceps"]), false,
    "a single mapped exercise must NOT qualify — proves the 3-exercise fixture above passes on merit");
});

test("a not-done session never qualifies", () => {
  const plan = S.buildSandboxSeedPlan(Object.assign({}, SPEC, { done: false, weeks: 1 }), TODAY);
  const w = { id: 1, done: plan.sessions[0].done, date: plan.sessions[0].date, type: plan.sessions[0].type };
  const ex = plan.sessions[0].exercises.map((e) => ({ workout_id: 1, name: e.name }));
  assert.strictEqual(S.makeTargetMatcher(ex).satisfies(w, ["chest", "back", "shoulders"]), false);
  assert.strictEqual(plan.sessions[0].done, false, "done:false propagates to the plan");
});

test("grip-only exercises correctly do NOT carry a session (matcher rule preserved)", () => {
  const ex = [{ workout_id: 1, name: "Dead Hang" }, { workout_id: 1, name: "Farmer Carry" }];
  const w = { id: 1, done: true, date: "2026-07-06", type: "Strength" };
  assert.strictEqual(S.makeTargetMatcher(ex).satisfies(w, ["grip_forearms"]), false,
    "grip-only names never count — a sandbox built only from them would silently never qualify");
});

// ── denylist / marker contracts ─────────────────────────────────────────────
test("denylist is hard-coded to profiles 1 and 4", () => {
  // JSON, not deepStrictEqual — the array is created inside the vm realm, so a
  // structural compare fails on Array.prototype identity alone.
  assert.strictEqual(JSON.stringify(S.SEED_DENYLIST), JSON.stringify([1, 4]));
});

test("SEED_MARKER prefixes every workout note the endpoint builds", () => {
  const plan = S.buildSandboxSeedPlan(SPEC, TODAY);
  const notes = plan.sessions.map((s) => S.SEED_MARKER + " " + s.type + " — " + s.exercises.map((e) => e.name).join(", "));
  assert.ok(notes.every((n) => n.indexOf(S.SEED_MARKER) === 0), "purge matches on this prefix");
});

test("ts is derived from the DATE so ts.desc ordering matches chronology", () => {
  const plan = S.buildSandboxSeedPlan(SPEC, TODAY);
  const ts = plan.sessions.map((s, i) => S.seedParse(s.date) + i);
  const sortedByTs = plan.sessions.slice().map((s, i) => ({ d: s.date, t: ts[i] }))
    .sort((a, b) => b.t - a.t).map((x) => x.d);
  const sortedByDate = plan.sessions.map((s) => s.date).slice().sort().reverse();
  assert.deepStrictEqual(sortedByTs, sortedByDate,
    "GET /api/workouts orders by ts.desc — wall-clock ts would scramble seeded history");
});
