"use strict";
/**
 * Session #49 — porting the session-#48 layered matcher to the ARC's Tier-2
 * evidence path and to getGoalExerciseContext (roadmap grounding).
 *
 * WHAT WAS WRONG. #48 fixed the substring/tokenization defect for INTAKE ONLY,
 * on explicit instruction to leave the arc byte-identical. The same defect still
 * governed (a) which logged sessions count toward a goal's earned arc position
 * and (b) what grounds roadmap CONTENT. Measured on profile 1's real 332
 * exercise rows: a half-marathon goal matched Crunches x3 + Standing Oblique
 * Crunch x1 and ZERO runs, because `run` is a substring of "C-run-ches"; a bench
 * goal matched Overhead Press at 22.5 lb dumbbells.
 *
 * THE PORT IS NOT WHOLESALE, AND THAT IS THE POINT. The audit measured that
 * handing the arc the matcher's raw CATEGORY layer would have replaced one false
 * positive with a bigger one — 45 strength sessions for a bench goal, 25 cardio
 * sessions for a running goal with zero actual runs, and 4 phantom sessions each
 * for "Fix Posture" / "Fix Pubic Osteitis" / "Build Muscle" via hxAllCategories'
 * `other` fallback matching every uncategorised workout. So:
 *   intake  -> matched_dates  (both layers; it asks questions)
 *   arc     -> specific_dates (days that actually NAME the thing; it drives numbers)
 *   roadmap -> exercise layer only (best_set/trend are per-ROW arithmetic)
 *
 * These tests EXTRACT the real shipped functions out of server.js by source
 * slicing and evaluate them in a vm sandbox — the "run the actual code, never a
 * hand-copied duplicate" discipline. They run against BOTH file versions: the
 * working tree (post-port) and PRE_CHANGE_COMMIT (pre-port), so every claim is a
 * measured before/after rather than a one-sided assertion.
 *
 * Hardening per arc close-out learning #2 (a near-green harness that silently
 * mis-extracts is worse than one that fails outright): the brace scanner is
 * comment/string/template/regex aware, every slice is re-parsed, and an
 * over-capture guard rejects a slice that swallowed another top-level
 * declaration.
 *
 * Run: node --test server/arcMatcherPort.test.js
 */
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var { execFileSync } = require("child_process");

var ROOT = path.join(__dirname, "..");
var SERVER_PATH = path.join(ROOT, "server.js");

// PRE-CHANGE REFERENCE — pinned to the session-#48 close-out commit, NEVER to
// HEAD. Using HEAD works only while the change is uncommitted; the moment it
// lands, "before" silently becomes "after" and these tests assert the opposite
// of what they claim. (Session #44 was caught exactly that way.)
var PRE_CHANGE_COMMIT = "aff60c1";
var POST_PORT_MARKER = "function hxMatchGoalDays(";

var TREE = fs.readFileSync(SERVER_PATH, "utf8");
assert.ok(TREE.indexOf(POST_PORT_MARKER) >= 0, "working tree is missing the session-#49 port");

var PRE = null;
try {
  PRE = execFileSync("git", ["show", PRE_CHANGE_COMMIT + ":server.js"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  // Guard the pin itself: if that commit already had the port, every before/after
  // comparison below is meaningless and must fail loudly rather than pass.
  assert.ok(PRE.indexOf(POST_PORT_MARKER) < 0,
    "pin " + PRE_CHANGE_COMMIT + " already contains the port — update PRE_CHANGE_COMMIT");
  assert.ok(PRE.indexOf("async function getGoalSessionDates(") >= 0,
    "pin " + PRE_CHANGE_COMMIT + " is missing the pre-port getGoalSessionDates — wrong pin");
} catch (e) {
  if (/already contains the port|wrong pin/.test(e.message)) throw e;
  PRE = null;   // unreachable commit -> before/after tests skip LOUDLY, see below
}

// ─────────────────────────────────────────────────────────── source slicing
function stripToCode(src) {
  var out = new Array(src.length).fill(" ");
  var i = 0, n = src.length, prevSignificant = "";
  while (i < n) {
    var c = src[i], c2 = src[i + 1];
    if (c === "/" && c2 === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && c2 === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      var q = c; i++;
      while (i < n) { if (src[i] === "\\") { i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    if (c === "/" && /[=(,:[!&|?{};+\-*%~^]/.test(prevSignificant)) {
      i++; var inClass = false;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { i++; break; }
        else if (src[i] === "\n") break;
        i++;
      }
      while (i < n && /[gimsuy]/.test(src[i])) i++;
      continue;
    }
    out[i] = c;
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out.join("");
}

function grabDecl(src, header) {
  var idx = src.indexOf(header);
  assert.ok(idx >= 0, "declaration not found: " + header);
  var code = stripToCode(src);
  var braceStart = code.indexOf("{", idx);
  assert.ok(braceStart > idx, "no opening brace for " + header);
  var depth = 0, end = -1;
  for (var i = braceStart; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, "unbalanced braces for " + header);
  var out = src.slice(idx, end);
  // OVER-CAPTURE GUARD — turns a silent mis-extraction into a loud failure.
  var stray = out.slice(header.length).match(/\n(function |async function |var [A-Za-z_$][\w$]*\s*=)/);
  assert.ok(!stray, "over-capture: '" + header + "' swallowed '" + (stray && stray[1]) + "'");
  new vm.Script("(function(){" + out + "})", { filename: "slice:" + header });   // MANDATORY RE-PARSE
  return out;
}

function grabVar(src, name) {
  var m = new RegExp("^var " + name + "\\s*=", "m").exec(src);
  assert.ok(m, "var not found: " + name);
  var start = m.index, code = stripToCode(src), depth = 0, end = -1;
  for (var i = start; i < code.length; i++) {
    var ch = code[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === ";" && depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > 0, "no terminator for var " + name);
  var out = src.slice(start, end);
  new vm.Script(out, { filename: "slice:var " + name });
  return out;
}

// ─────────────────────────────────────────────────────── sandbox assembly
var SHARED_HX = [
  "HX_YMD_RE", "HX_BLOCK_CHAR_CAP", "HX_MAX_EXERCISE_LINES", "HX_MAX_MONTHS",
  "HX_SHORT_TOKEN_OK", "HX_GENERIC_TOKENS", "HX_STOP", "HX_CATEGORY_RES",
  "HX_SESSION_LENGTH_CATEGORIES",
];
var SHARED_FNS = [
  "function ymdLocal(", "function numOrNull(", "function weeksSinceYmd(", "function ymdNDaysAgo(",
  "function hxTokenForms(", "function hxNameForms(", "function hxGoalTokens(",
  "function hxAllCategories(", "function hxNum(", "function hxDayMs(", "function hxShiftYmd(",
  "function hxFmtSecs(", "function buildTrainingHistorySummary(", "function renderTrainingHistoryBlock(",
];

/** Sandbox with a fetch stub that serves `exRows` to any /exercises read. */
function makeSandbox(src, extraVars, extraFns, exRows) {
  var parts = [];
  SHARED_HX.concat(extraVars || []).forEach(function (v) { parts.push(grabVar(src, v)); });
  SHARED_FNS.concat(extraFns || []).forEach(function (f) { parts.push(grabDecl(src, f)); });
  var ctx = vm.createContext({
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Array: Array, Object: Object, RegExp: RegExp, isFinite: isFinite, isNaN: isNaN,
    parseInt: parseInt, parseFloat: parseFloat, Promise: Promise,
    SUPABASE_URL: "https://stub", sbHeaders: function () { return {}; },
    fetch: function (u) {
      var m = /date=gte\.([^&]+)/.exec(String(u));
      var since = m ? m[1] : "0000-00-00";
      var rows = (exRows || []).filter(function (e) { return e.date && e.date >= since; });
      return Promise.resolve({ json: function () { return Promise.resolve(rows); } });
    },
  });
  vm.runInContext(parts.join("\n\n"), ctx, { filename: "extracted" });
  return ctx;
}

function callIn(ctx, expr, args) {
  ctx.__args = args;
  return vm.runInContext(expr + ".apply(null, __args)", ctx);
}

// ⚠ assert.deepStrictEqual FAILS ACROSS VM REALMS — a sandbox array's prototype
// is not this realm's Array.prototype, so even [] vs [] throws "same structure
// but not reference-equal". Documented in ROADMAP §9 (session #45) and hit again
// here. Compare a serialised form.
function eq(actual, expected, msg) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), msg);
}

// ────────────────────────────────────────────────────────────── fixtures
// Rows transcribed from profile 1's REAL production log (the exact rows the
// audit measured), plus the uncategorised junk workouts that drive the phantom
// -session regression, plus a runner pair reproducing the #48 motivating case.
var TODAY = "2026-08-04";
var P1_EX = [
  // the half-marathon false positives — `run` inside "C-run-ches"
  { name: "Crunches", date: "2026-06-10", reps: 25, main_category: "strength" },
  { name: "Crunches", date: "2026-04-25", reps: 25, main_category: "strength" },
  { name: "Crunches", date: "2026-04-08", reps: 26, main_category: "strength" },
  { name: "Standing Oblique Crunch", date: "2026-06-14", sets: 2, reps: 10, weight_lbs: 5, main_category: "strength" },
  // the bench false positive — a different lift reached through generic `press`
  { name: "Overhead Press", date: "2026-06-10", sets: 2, reps: 8, weight_lbs: 12.5, main_category: "strength" },
  { name: "Overhead Press", date: "2026-05-22", sets: 3, reps: 10, weight_lbs: 12.5, main_category: "strength" },
  { name: "Overhead Press", date: "2026-05-02", sets: 3, weight_lbs: 22.5, main_category: "strength" },
  // the true positive the hyphen asymmetry was hiding
  { name: "Pull-Up", date: "2026-06-10", sets: 2, main_category: "strength" },
  // a movement-FAMILY word that must NOT reach a pull-up goal through `pull`
  { name: "Band Pull-Apart", date: "2026-06-10", sets: 3, reps: 12, main_category: "strength" },
];
var P1_WK = [
  { id: 1, date: "2026-06-10", done: true, type: "Strength (Upper Body) + Strength (Core)", notes: "" },
  { id: 2, date: "2026-06-14", done: true, type: "Strength (Core)", notes: "" },
  { id: 3, date: "2026-05-22", done: true, type: "Strength (Upper Body)", notes: "" },
  { id: 4, date: "2026-05-02", done: true, type: "Strength (Upper Body)", notes: "" },
  { id: 5, date: "2026-04-25", done: true, type: "Strength (Core)", notes: "" },
  { id: 6, date: "2026-04-08", done: true, type: "Strength (Core)", notes: "" },
  // real cardio, and NOT a run — this is the 25-vs-0 case
  { id: 7, date: "2026-07-25", done: true, type: "Cardio (Stationary Bike, 20min) + Mind & Body (Stretching)", notes: "" },
  { id: 8, date: "2026-07-29", done: true, type: "Cardio (Outdoor, Walking, 50m) + Rehab (Physical Therapy)", notes: "" },
  // the FOUR uncategorised junk sessions that hxAllCategories resolves to ["other"]
  { id: 9, date: "2026-05-20", done: true, type: "Test Workout", notes: "" },
  { id: 10, date: "2026-06-22", done: true, type: "Workout", notes: "" },
  { id: 11, date: "2026-05-06", done: true, type: "Workout", notes: "" },
  { id: 12, date: "2026-04-12", done: true, type: "Walking", notes: "" },
];

// #48 motivating case: identical structure, differing by exactly 20 runs.
function runnerFixture(withRuns) {
  var wk = [], ex = [];
  for (var i = 0; i < 20; i++) {
    var d = "2026-06-" + String(i + 1).padStart(2, "0");
    wk.push({ id: 100 + i, date: d, done: true, type: "Cardio (Outdoor, Running)", notes: withRuns ? "Easy Run 3 miles" : "Stationary bike" });
    if (withRuns) ex.push({ name: "Easy Run", date: d, distance_miles: 3.1, duration_minutes: 28, main_category: "cardio" });
  }
  // a cardio session that logs ZERO exercise rows — the reason the category
  // layer is mandatory rather than optional
  wk.push({ id: 200, date: "2026-07-02", done: true, type: "Cardio (Outdoor, Running)", notes: withRuns ? "Long run, 6 miles" : "Elliptical" });
  return { workouts: wk, exercises: ex };
}

// ═══════════════════════════════════════════════════ A. ONE IMPLEMENTATION
test("A1 — getGoalSessionDates is GONE; no forked matcher survives", function () {
  var code = stripToCode(TREE);
  assert.ok(code.indexOf("function getGoalSessionDates(") < 0,
    "the pre-port arc matcher is still declared");
  // Comments may still NAME it (they explain the port). Comments are not calls.
  assert.ok(code.indexOf("getGoalSessionDates(") < 0,
    "getGoalSessionDates is still CALLED somewhere");
  // Positive assertion so the guard above cannot pass vacuously.
  assert.ok(TREE.indexOf("getGoalSessionDates") >= 0,
    "expected the historical name to survive in comments — check the guard is meaningful");
});

test("A2 — exactly ONE hxMatchGoalDays and ONE hxExerciseMatch declaration", function () {
  var code = stripToCode(TREE);
  ["function hxMatchGoalDays(", "function hxExerciseMatch("].forEach(function (h) {
    var n = code.split(h).length - 1;
    assert.strictEqual(n, 1, h + " declared " + n + " times — a fork");
  });
});

test("A3 — all three consumers CALL the shared matcher rather than reimplement it", function () {
  var summary = stripToCode(grabDecl(TREE, "function buildTrainingHistorySummary("));
  var arc = stripToCode(grabDecl(TREE, "function arcKeywordDates("));
  var gx = stripToCode(grabDecl(TREE, "async function getGoalExerciseContext("));
  assert.ok(summary.indexOf("hxMatchGoalDays(") >= 0, "intake no longer calls the shared matcher");
  assert.ok(arc.indexOf("hxMatchGoalDays(") >= 0, "arc no longer calls the shared matcher");
  assert.ok(gx.indexOf("hxExerciseMatch(") >= 0, "roadmap grounding no longer calls the shared predicate");
  // The old duplicated loop must be gone from the intake aggregate.
  assert.ok(summary.indexOf("var exerciseDays = {}") < 0,
    "buildTrainingHistorySummary still carries its own copy of the matching loop");
});

test("A4 — extractGoalKeywords has exactly ONE live consumer (targetServesGoal, out of scope)", function () {
  var code = stripToCode(TREE);
  var calls = code.split("extractGoalKeywords(").length - 1;
  assert.strictEqual(calls, 2, "expected 1 declaration + 1 call site, saw " + calls);
  var t = stripToCode(grabDecl(TREE, "function targetServesGoal("));
  assert.ok(t.indexOf("extractGoalKeywords(") >= 0,
    "the one remaining consumer should be targetServesGoal (ROADMAP row 54)");
});

test("A5 — no evidence path reaches the legacy matcher", function () {
  ["function arcKeywordDates(", "async function getGoalExerciseContext("].forEach(function (h) {
    var body = stripToCode(grabDecl(TREE, h));
    assert.ok(body.indexOf("extractGoalKeywords(") < 0, h + " still calls extractGoalKeywords");
    assert.ok(body.indexOf(".indexOf(k)") < 0, h + " still does raw substring matching");
  });
});

// ════════════════════════════════ B. ARC EVIDENCE RULE (D1) — before/after
function arcDates(src, goal, wk, ex) {
  var ctx = makeSandbox(src, ["HX_UNMATCHABLE_CATEGORIES"], ["function hxExerciseMatch(", "function hxMatchGoalDays(", "function arcKeywordDates("]);
  return callIn(ctx, "arcKeywordDates", [goal, wk, ex]);
}
async function arcDatesPre(goal, wk, ex) {
  var ctx = makeSandbox(PRE, ["GOAL_STOP_WORDS", "ARC_WEAK_KEYWORDS"],
    ["function extractGoalKeywords(", "async function getGoalSessionDates("], ex);
  var doneDates = {};
  wk.forEach(function (w) { if (w.done && w.date) doneDates[w.date] = true; });
  var out = await callIn(ctx, "getGoalSessionDates", [1, goal.title, "0000-00-00"]);
  return out.filter(function (d) { return doneDates[d]; });   // the arc's own intersect
}

test("B1 — AC1: the crunch false positive goes 4 -> 0 for a half-marathon goal", async function () {
  var goal = { title: "Run a half marathon" };
  if (PRE) {
    var before = await arcDatesPre(goal, P1_WK, P1_EX);
    assert.strictEqual(before.length, 4,
      "expected the pre-port matcher to produce the 4 measured crunch sessions, saw " + before.length);
  } else {
    console.warn("SKIPPED pre-port half of B1 — commit " + PRE_CHANGE_COMMIT + " unreachable");
  }
  var after = arcDates(TREE, goal, P1_WK, P1_EX);
  assert.strictEqual(after.dates.length, 0,
    "a running goal must earn NOTHING from crunch sessions, saw " + JSON.stringify(after.dates));
});

test("B2 — AC4: the honest negative. Real cardio exists, but none of it is running", function () {
  var after = arcDates(TREE, { title: "Run a half marathon" }, P1_WK, P1_EX);
  // P1_WK carries two genuine cardio sessions. The raw CATEGORY set would have
  // credited both; the specific-term rule correctly credits neither, because
  // neither session names a run.
  assert.strictEqual(after.dates.length, 0);
  eq(after.matched_via, [], "a category-only cardio day must not be reported as evidence");
});

test("B3 — AC2: a REAL runner's runs are recovered, incl. a session with zero exercise rows", function () {
  var f = runnerFixture(true);
  var after = arcDates(TREE, { title: "Run a half marathon" }, f.workouts, f.exercises);
  assert.strictEqual(after.dates.length, 21,
    "20 logged runs + 1 run-only-in-notes session, saw " + after.dates.length);
  assert.ok(after.dates.indexOf("2026-07-02") >= 0,
    "the cardio session with NO exercise rows must still count — this is why the category layer is mandatory");
  assert.ok(after.matched_via.some(function (v) { return /^exercise:/.test(v); }), after.matched_via);
});

test("B3b — the non-runner half of the pair earns nothing from the same 21 cardio sessions", function () {
  var f = runnerFixture(false);
  var after = arcDates(TREE, { title: "Run a half marathon" }, f.workouts, f.exercises);
  assert.strictEqual(after.dates.length, 0,
    "21 cardio sessions with zero runs must not earn a running goal any position");
});

test("B4 — AC3: 'Pull-Up' is visible to a pull-up goal, and 'Band Pull-Apart' is not", function () {
  var goal = { title: "Do 20 pull-ups" };
  var after = arcDates(TREE, goal, P1_WK, P1_EX);
  eq(after.dates, ["2026-06-10"]);
  assert.ok(after.matched_via.indexOf("exercise:Pull-Up") >= 0, after.matched_via);
  assert.ok(!after.matched_via.some(function (v) { return /Pull-Apart/.test(v); }),
    "`pull` is a movement-FAMILY word and must not carry a match on its own");
});

test("B5 — a bench goal stops earning position from Overhead Press", async function () {
  var goal = { title: "Bench press 225 lbs" };
  if (PRE) {
    var before = await arcDatesPre(goal, P1_WK, P1_EX);
    assert.strictEqual(before.length, 3, "expected the 3 measured Overhead Press sessions");
  }
  var after = arcDates(TREE, goal, P1_WK, P1_EX);
  assert.strictEqual(after.dates.length, 0,
    "a different lift reached through the generic token `press` is not bench evidence");
});

// ═════════════════════════════ C. THE PHANTOM-SESSION REGRESSION (D1 guard)
test("C1 — the three real goals match ZERO uncategorised workouts, not 4 each", function () {
  ["Fix Posture", "Fix Pubic Osteitis", "Build Muscle"].forEach(function (title) {
    var after = arcDates(TREE, { title: title }, P1_WK, P1_EX);
    assert.strictEqual(after.dates.length, 0,
      title + " matched " + JSON.stringify(after.dates) + " — hxAllCategories' `other` fallback leaked back in");
  });
});

test("C2 — the guard is doing real work: without it those goals WOULD match 4 each", function () {
  // Prove the regression is live, not hypothetical: run the same shared matcher
  // with the unmatchable-category filter bypassed and confirm it produces the
  // exact phantom set the audit measured.
  var ctx = makeSandbox(TREE, ["HX_UNMATCHABLE_CATEGORIES"], ["function hxExerciseMatch(", "function hxMatchGoalDays("]);
  var tokens = callIn(ctx, "hxGoalTokens", ["Fix Posture", ""]);
  var withGuard = callIn(ctx, "hxMatchGoalDays", [P1_WK, P1_EX, tokens, ["other"]]);
  vm.runInContext("HX_UNMATCHABLE_CATEGORIES = {};", ctx);   // bypass, sandbox-local only
  var without = callIn(ctx, "hxMatchGoalDays", [P1_WK, P1_EX, tokens, ["other"]]);
  assert.strictEqual(withGuard.matched_dates.length, 0);
  assert.strictEqual(without.matched_dates.length, 4,
    "expected the 4 measured junk sessions (Test Workout / Workout x2 / Walking), saw " + without.matched_dates.length);
});

test("C3 — 'rest' is unmatchable too: absence of training is never evidence", function () {
  var ctx = makeSandbox(TREE, ["HX_UNMATCHABLE_CATEGORIES"], ["function hxExerciseMatch(", "function hxMatchGoalDays("]);
  var rest = [{ id: 1, date: "2026-06-01", done: true, type: "Rest Day", notes: "" }];
  var tokens = callIn(ctx, "hxGoalTokens", ["Recovery and rest", ""]);
  var m = callIn(ctx, "hxMatchGoalDays", [rest, [], tokens, ["rest"]]);
  assert.strictEqual(m.matched_dates.length, 0);
});

// ═════════════════════════ D. ROADMAP GROUNDING (D2) — exercise layer only
function gxSandbox(src, exRows) {
  return makeSandbox(src, ["HX_UNMATCHABLE_CATEGORIES", "GOAL_STOP_WORDS"],
    ["function hxExerciseMatch(", "function hxMatchGoalDays(", "function extractGoalKeywords(", "async function getGoalExerciseContext("], exRows);
}

test("D1 — a bench goal is no longer grounded in a 12.5 lb Overhead Press", async function () {
  if (PRE) {
    var ctxPre = makeSandbox(PRE, ["GOAL_STOP_WORDS"], ["function extractGoalKeywords(", "async function getGoalExerciseContext("], P1_EX);
    var kws = callIn(ctxPre, "extractGoalKeywords", ["Bench press 225 lbs"]);
    var before = await callIn(ctxPre, "getGoalExerciseContext", [1, kws, 3650]);
    assert.strictEqual(before.total_sessions, 3);
    assert.strictEqual(before.best_set.weight_lbs, 22.5,
      "the pre-port grounding fed a bench roadmap a 22.5 lb dumbbell press");
  }
  var ctx = gxSandbox(TREE, P1_EX);
  var toks = callIn(ctx, "hxGoalTokens", ["Bench press 225 lbs", ""]);
  var after = await callIn(ctx, "getGoalExerciseContext", [1, toks, 3650]);
  assert.strictEqual(after.total_sessions, 0);
  assert.strictEqual(after.best_set, null);
  assert.strictEqual(after.trend, "insufficient_data");
});

test("D2 — a running goal is no longer grounded in a 5 lb x 25 crunch", async function () {
  if (PRE) {
    var ctxPre = makeSandbox(PRE, ["GOAL_STOP_WORDS"], ["function extractGoalKeywords(", "async function getGoalExerciseContext("], P1_EX);
    var kws = callIn(ctxPre, "extractGoalKeywords", ["Run a half marathon"]);
    var before = await callIn(ctxPre, "getGoalExerciseContext", [1, kws, 3650]);
    assert.strictEqual(before.total_sessions, 4);
    assert.strictEqual(before.best_set.reps, 26);
  }
  var ctx = gxSandbox(TREE, P1_EX);
  var toks = callIn(ctx, "hxGoalTokens", ["Run a half marathon", ""]);
  var after = await callIn(ctx, "getGoalExerciseContext", [1, toks, 3650]);
  assert.strictEqual(after.total_sessions, 0);
  assert.strictEqual(after.best_set, null);
  assert.strictEqual(after.trend, "insufficient_data");
});

test("D3 — a category-only match NEVER produces a null-filled object that reads as evidence", async function () {
  // "Run a half marathon" matches 2 genuine cardio sessions at CATEGORY level in
  // the arc's matcher. getGoalExerciseContext must still report the honest zero
  // shape, not a row-less object carrying a last_session_date or a trend.
  var ctx = gxSandbox(TREE, P1_EX);
  var toks = callIn(ctx, "hxGoalTokens", ["Run a half marathon", ""]);
  var out = await callIn(ctx, "getGoalExerciseContext", [1, toks, 3650]);
  eq(out, {
    total_sessions: 0, last_session_date: null, best_set: null,
    recent_volume: [], trend: "insufficient_data", weeks_since_last: null,
  });
});

test("D4 — a REAL match still grounds correctly (the port is not just a mute button)", async function () {
  var ctx = gxSandbox(TREE, P1_EX);
  var toks = callIn(ctx, "hxGoalTokens", ["Do 20 pull-ups", ""]);
  var out = await callIn(ctx, "getGoalExerciseContext", [1, toks, 3650]);
  assert.strictEqual(out.total_sessions, 1);
  assert.strictEqual(out.last_session_date, "2026-06-10");
});

// ════════════════════════ E. INTAKE UNCHANGED — comparison, not assertion
test("E1 — the rendered intake block is BYTE-IDENTICAL pre vs post on the runner pair", function () {
  if (!PRE) { console.warn("SKIPPED E1 — commit " + PRE_CHANGE_COMMIT + " unreachable"); return; }
  var pre = makeSandbox(PRE, [], []);
  var post = makeSandbox(TREE, ["HX_UNMATCHABLE_CATEGORIES"], ["function hxExerciseMatch(", "function hxMatchGoalDays("]);
  [true, false].forEach(function (withRuns) {
    var f = runnerFixture(withRuns);
    var args = ["Run a half marathon", ""];
    var toksPre = callIn(pre, "hxGoalTokens", args);
    var toksPost = callIn(post, "hxGoalTokens", args);
    var catsPre = callIn(pre, "hxAllCategories", ["Run a half marathon "]);
    var catsPost = callIn(post, "hxAllCategories", ["Run a half marathon "]);
    var sPre = callIn(pre, "buildTrainingHistorySummary", [f.workouts, f.exercises, TODAY, { goalTokens: toksPre, goalCategories: catsPre }]);
    var sPost = callIn(post, "buildTrainingHistorySummary", [f.workouts, f.exercises, TODAY, { goalTokens: toksPost, goalCategories: catsPost }]);
    var bPre = callIn(pre, "renderTrainingHistoryBlock", [sPre]);
    var bPost = callIn(post, "renderTrainingHistoryBlock", [sPost]);
    assert.strictEqual(bPost, bPre,
      "the intake block moved for the " + (withRuns ? "runner" : "non-runner") + " fixture");
    assert.ok(bPost.length > 200, "block should be non-trivial — check the fixture, not the code");
  });
});

test("E2 — #48's runner-vs-non-runner asymmetry still holds after the port", function () {
  var post = makeSandbox(TREE, ["HX_UNMATCHABLE_CATEGORIES"], ["function hxExerciseMatch(", "function hxMatchGoalDays("]);
  var toks = callIn(post, "hxGoalTokens", ["Run a half marathon", ""]);
  var cats = callIn(post, "hxAllCategories", ["Run a half marathon "]);
  var runner = callIn(post, "buildTrainingHistorySummary", [runnerFixture(true).workouts, runnerFixture(true).exercises, TODAY, { goalTokens: toks, goalCategories: cats }]);
  var non = callIn(post, "buildTrainingHistorySummary", [runnerFixture(false).workouts, runnerFixture(false).exercises, TODAY, { goalTokens: toks, goalCategories: cats }]);
  assert.strictEqual(runner.goal_relevant.confidence, "exercise");
  assert.strictEqual(non.goal_relevant.confidence, "category");
  assert.ok(runner.goal_relevant.specific_term_hits > 0);
  assert.strictEqual(non.goal_relevant.specific_term_hits, 0);
  assert.ok(runner.endurance, "runner endurance view should be populated");
  assert.strictEqual(non.endurance, null, "non-runner endurance view must be null, never a fabricated zero");
});

test("E3 — the new date sets are ADDITIVE and agree with the counts they replaced", function () {
  var post = makeSandbox(TREE, ["HX_UNMATCHABLE_CATEGORIES"], ["function hxExerciseMatch(", "function hxMatchGoalDays("]);
  var toks = callIn(post, "hxGoalTokens", ["Run a half marathon", ""]);
  var cats = callIn(post, "hxAllCategories", ["Run a half marathon "]);
  var f = runnerFixture(true);
  var s = callIn(post, "buildTrainingHistorySummary", [f.workouts, f.exercises, TODAY, { goalTokens: toks, goalCategories: cats }]);
  var gr = s.goal_relevant;
  assert.strictEqual(gr.specific_dates.length, gr.specific_term_hits, "specific_dates must agree with its own count");
  assert.strictEqual(gr.matched_dates.length, gr.sessions, "matched_dates must agree with `sessions`");
  assert.strictEqual(gr.exercise_dates.length, gr.by_source.exercise);
  assert.strictEqual(gr.category_dates.length, gr.by_source.category);
  // The arc reads specific_dates; it must be a SUBSET of what intake counted.
  gr.specific_dates.forEach(function (d) {
    assert.ok(gr.matched_dates.indexOf(d) >= 0, "specific_dates leaked a day intake never matched: " + d);
  });
});

// ═════════════════════════════════════ F. LABELS STAY BYTE-COMPATIBLE (D1)
test("F1 — tier 2 still reports tier:2 / confidence:'keyword'; only matched_via is new", function () {
  // ⚠ The LABEL checks must read the RAW slice: stripToCode() blanks string
  // bodies by design, so `confidence: "keyword"` becomes `confidence: "       "`
  // and a literal search there can never match. Identifier/call checks use the
  // stripped form so a comment can never satisfy them.
  var raw = grabDecl(TREE, "function arcQualifyingDates(");
  var code = stripToCode(raw);
  assert.ok(raw.indexOf('confidence: "keyword"') >= 0, "the tier-2 confidence label changed");
  assert.ok(code.indexOf("tier: 2") >= 0, "the tier-2 label changed");
  assert.ok(code.indexOf("opts.keywordVia") >= 0, "matched_via is not being populated on tier 2");
});

// ══════════════════════════ G. THE DESCRIPTION FIREHOSE (found in verification)
// The first cut of this port passed `hxGoalTokens(title, description)` into both
// evidence paths, matching what intake does. Measured against profile 1's real
// goals that made matching WORSE, not better: a goal description here is
// freeform coaching prose (the pinky goal's is ~2,000 words), so tokenising it
// injects ordinary English. Both pre-port paths read the TITLE only; so do both
// post-port paths. These tests pin that down so it cannot silently regress.
var FIREHOSE_EX = [
  { name: "Reverse Lunge", date: "2026-06-01", main_category: "strength" },
  { name: "Thoracic Extension Over Foam Roller", date: "2026-06-01", main_category: "rehab" },
  { name: "Band Pull-Apart", date: "2026-06-01", main_category: "strength" },
  { name: "Tabletop Lumbrical Curl", date: "2026-06-01", main_category: "rehab" },
];
var FIREHOSE_WK = [
  { id: 1, date: "2026-06-01", done: true, type: "Rehab (Physical Therapy)", notes: "" },
  { id: 2, date: "2026-06-02", done: true, type: "Martial Arts (MMA) + Strength (Full Body) + Cardio (HIIT)", notes: "" },
];

test("G1 — a prose description does NOT leak ordinary English into arc evidence", function () {
  // Real shapes: the pinky goal's description names a reverse prayer stretch and
  // a rubber band; "Stamina" says "Full MMA rounds without gassing".
  var pinky = {
    title: "Fix smartphone pinky with lumbrical weakness",
    description: "Release — wrist circles, reverse prayer stretch, shake out. Strengthen — finger " +
      "abduction with rubber band, tabletop lumbrical curls. Stop 10-15 degrees short of full lockout " +
      "and hold 2-3 sec over the range.",
  };
  var got = arcDates(TREE, pinky, FIREHOSE_WK, FIREHOSE_EX);
  var via = JSON.stringify(got.matched_via);
  assert.ok(via.indexOf("Reverse Lunge") < 0, "`reverse` from the description reached a LEG exercise: " + via);
  assert.ok(via.indexOf("Foam Roller") < 0, "the PREPOSITION `over` reached an exercise: " + via);
  assert.ok(via.indexOf("Band Pull-Apart") < 0, "`band` from the description reached a back exercise: " + via);
  assert.ok(via.indexOf("Tabletop Lumbrical Curl") >= 0, "the real title match should survive: " + via);
});

test("G2 — 'Stamina' does not earn position from every 'Full Body' session", function () {
  var stamina = { title: "Stamina", description: "Full MMA rounds without gassing. Better cardio baseline." };
  var got = arcDates(TREE, stamina, FIREHOSE_WK, FIREHOSE_EX);
  eq(got.dates, [], "`full` and `without` from the description matched real sessions: " + JSON.stringify(got.matched_via));
});

test("G3 — both evidence paths read the TITLE only; intake still reads both", function () {
  // ⚠ These checks read the RAW source: an empty string literal is exactly what
  // stripToCode() blanks, so `hxGoalTokens(title, "")` would read as
  // `hxGoalTokens(title,   )` in the stripped form and never match. (Second time
  // this trap fired in this file — see F1.) A comment cannot satisfy them because
  // each pattern requires the full call shape.
  var arc = grabDecl(TREE, "function arcKeywordDates(");
  assert.ok(/\n\s*var tokens = hxGoalTokens\(title, ""\);/.test(arc), "arcKeywordDates must not tokenise the description");
  assert.ok(/\n\s*var cats = hxAllCategories\(title\);/.test(arc), "arcKeywordDates must not category-parse the description");
  // Every getGoalExerciseContext call site passes an empty description.
  var code = TREE;
  var callSites = code.match(/getGoalExerciseContext\([^)]*hxGoalTokens\([^)]*\)/g) || [];
  assert.strictEqual(callSites.length, 5, "expected 5 grounding call sites, saw " + callSites.length);
  callSites.forEach(function (s) {
    assert.ok(/hxGoalTokens\([^,]+,\s*""\)/.test(s), "grounding call site tokenises the description: " + s);
  });
  // ...and the INTAKE path deliberately still reads both (shipped + verified #48).
  assert.ok(/hxGoalTokens\(goal\.title,\s*goal\.description\)/.test(code),
    "the intake path should be unchanged from session #48");
});

test("F2 — the arc consumes specific_dates, NOT the raw category set", function () {
  var body = stripToCode(grabDecl(TREE, "function arcKeywordDates("));
  assert.ok(/dates:\s*m\.specific_dates/.test(body),
    "arcKeywordDates must return the specific-term day set — the raw category set over-credits");
  assert.ok(body.indexOf("m.matched_dates") < 0,
    "arcKeywordDates must not return matched_dates (that is intake's rule, not the arc's)");
});
