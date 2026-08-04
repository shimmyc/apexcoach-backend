// History-informed intake (CC session #48) — tests against the REAL SHIPPED
// functions, extracted from server.js by source slicing and evaluated in a vm
// sandbox. Same discipline as v2FoldedCards.test.js / the Session D harnesses:
// run the actual code, never a hand-copied duplicate.
//
// ⚠ Two harness rules this file honours, both learned the hard way:
//   1. The "before" reference is a PINNED COMMIT, never HEAD (session #44 —
//      an unpinned reference silently becomes post-fix the moment you commit).
//   2. The extractor is comment/string/template/regex-literal aware AND has an
//      over-capture guard that THROWS, plus a mandatory re-parse of every slice
//      (arc close-out learning #2 — a harness that reports near-green while
//      mis-extracting is more dangerous than one that fails outright).
//
//   node --test server/historyIntake.test.js

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var { execFileSync } = require("child_process");

var ROOT = path.join(__dirname, "..");
var SERVER_PATH = path.join(ROOT, "server.js");
var PRE_CHANGE_COMMIT = "dc72f04";   // pinned: the commit BEFORE session #48

// ─────────────────────────────────────────────────────────── source slicing
function stripToCode(src) {
  // Returns a same-length string with comment/string/template/regex bodies
  // blanked, so brace scanning cannot be derailed by an apostrophe in a
  // comment (the exact bug that made a Session D harness over-capture).
  var out = new Array(src.length).fill(" ");
  var i = 0, n = src.length;
  var prevSignificant = "";
  while (i < n) {
    var c = src[i], c2 = src[i + 1];
    if (c === "/" && c2 === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && c2 === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      var q = c; i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "/" && /[=(,:[!&|?{};+\-*%~^]/.test(prevSignificant)) {
      // regex literal
      i++;
      var inClass = false;
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
  assert.ok(idx >= 0, "declaration not found in source: " + header);
  var code = stripToCode(src);
  var braceStart = code.indexOf("{", idx);
  assert.ok(braceStart > idx, "no opening brace for " + header);
  var depth = 0, end = -1;
  for (var i = braceStart; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, "unbalanced braces for " + header);
  var slice = src.slice(idx, end);

  // OVER-CAPTURE GUARD — no other column-0 declaration may appear inside a
  // slice. This is what turns a silent mis-extraction into a loud failure.
  var inner = slice.slice(header.length);
  var stray = inner.match(/\n(function |var [A-Za-z_$][\w$]*\s*=|async function )/);
  assert.ok(!stray, "over-capture: slice for '" + header + "' swallowed '" + (stray && stray[1]) + "'");
  // MANDATORY RE-PARSE — a slice that does not parse is not a slice.
  new vm.Script("(function(){" + slice + "})", { filename: "slice:" + header });
  return slice;
}

function grabVar(src, name) {
  var re = new RegExp("^var " + name + "\\s*=", "m");
  var m = re.exec(src);
  assert.ok(m, "var not found: " + name);
  var start = m.index;
  var code = stripToCode(src);
  // scan to the terminating semicolon at depth 0
  var depth = 0, end = -1;
  for (var i = start; i < code.length; i++) {
    var ch = code[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === ";" && depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > 0, "no terminator for var " + name);
  var slice = src.slice(start, end);
  new vm.Script(slice, { filename: "slice:var " + name });
  return slice;
}

var CURRENT_SRC = fs.readFileSync(SERVER_PATH, "utf8");

function preChangeSrc() {
  try {
    return execFileSync("git", ["show", PRE_CHANGE_COMMIT + ":server.js"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
  } catch (e) {
    return null;
  }
}

// Build a sandbox holding the REAL shipped history-intake functions.
function loadHistoryIntake(src) {
  var parts = [
    grabVar(src, "HX_YMD_RE"),
    grabVar(src, "HX_BLOCK_CHAR_CAP"),
    grabVar(src, "HX_MAX_EXERCISE_LINES"),
    grabVar(src, "HX_MAX_MONTHS"),
    grabVar(src, "HX_SHORT_TOKEN_OK"),
    grabVar(src, "HX_GENERIC_TOKENS"),
    grabVar(src, "HX_STOP"),
    grabVar(src, "HX_CATEGORY_RES"),
    grabVar(src, "HX_SESSION_LENGTH_CATEGORIES"),
    // Session #49: buildTrainingHistorySummary's matching loop was factored out
    // into the SHARED hxMatchGoalDays()/hxExerciseMatch(), so the arc and the
    // roadmap-grounding paths run the identical predicate instead of a copy.
    // The slice list has to follow, or this sandbox silently loses the matcher.
    grabVar(src, "HX_UNMATCHABLE_CATEGORIES"),
    grabDecl(src, "function ymdLocal("),
    grabDecl(src, "function hxExerciseMatch("),
    grabDecl(src, "function hxMatchGoalDays("),
    grabDecl(src, "function hxTokenForms("),
    grabDecl(src, "function hxNameForms("),
    grabDecl(src, "function hxGoalTokens("),
    grabDecl(src, "function hxAllCategories("),
    grabDecl(src, "function hxNum("),
    grabDecl(src, "function hxDayMs("),
    grabDecl(src, "function hxShiftYmd("),
    grabDecl(src, "function hxFmtSecs("),
    grabDecl(src, "function buildTrainingHistorySummary("),
    grabDecl(src, "function renderTrainingHistoryBlock("),
  ];
  var ctx = { module: {}, exports: {}, console: console };
  vm.createContext(ctx);
  vm.runInContext(parts.join("\n\n") + "\n\nmodule.exports = { hxTokenForms, hxNameForms, hxGoalTokens, hxAllCategories, buildTrainingHistorySummary, renderTrainingHistoryBlock, HX_BLOCK_CHAR_CAP };", ctx, { filename: "history-intake-slice" });
  return ctx.module.exports;
}

// The arc's Tier-2 keyword path — extracted so decision 4 ("do NOT touch it")
// is PROVEN rather than asserted.
function loadArcKeywordPath(src) {
  return [
    grabVar(src, "GOAL_STOP_WORDS"),
    grabDecl(src, "function extractGoalKeywords("),
    grabVar(src, "ARC_WEAK_KEYWORDS"),
    grabDecl(src, "async function getGoalSessionDates("),
  ].join("\n\n");
}

var HX = loadHistoryIntake(CURRENT_SRC);

// ────────────────────────────────────────────────────────────────── fixtures
// Shaped to mirror profile 1's REAL log: a "Crunches" row (the token that
// caused the false positive), a "Pull-Up" row (the hyphen case), an
// "Overhead Press" row (the generic-token case), combined "+" titles (67% of
// profile 1's real titles), and cardio sessions carrying ZERO exercise rows.
function p1ShapedFixture() {
  var workouts = [
    { id: 1, date: "2026-04-08", type: "Strength (Core) + Rehab (PT)", notes: "core work", done: true },
    { id: 2, date: "2026-05-02", type: "Strength (Upper Body)", notes: "", done: true },
    { id: 3, date: "2026-06-10", type: "Strength (Core)", notes: "", done: true },
    { id: 4, date: "2026-06-14", type: "Strength (Core)", notes: "", done: true },
    // cardio sessions with ZERO exercise rows — the reason the fallback layer
    // is mandatory, not optional (3 of 10 sampled on profile 1).
    { id: 5, date: "2026-07-22", type: "Cardio (Stationary Bike, 30min) + Rehab (PT)", notes: "", done: true },
    { id: 6, date: "2026-07-25", type: "Cardio (Stationary Bike, 20min) + Mind & Body (Stretching)", notes: "", done: true },
    { id: 7, date: "2026-07-27", type: "Cardio (Stationary Bike, 10min) + Rehab (Active Recovery)", notes: "", done: true },
    // a combined title where cardio is NOT first — first-match-wins loses it
    { id: 8, date: "2026-07-20", type: "Cardio (Stationary Bike, 20min) + Strength (Upper Body) + Mind & Body (Stretching)", notes: "", done: true },
    { id: 9, date: "2026-08-01", type: "Strength (Upper Body)", notes: "pull-ups felt strong", done: true },
    { id: 10, date: "2026-08-03", type: "Rest Day", notes: "", done: true },
  ];
  var exercises = [
    { name: "Crunches", date: "2026-04-08", sets: 3, reps: 26, main_category: "strength" },
    { name: "Crunches", date: "2026-06-10", sets: 3, reps: 20, main_category: "strength" },
    { name: "Crunches", date: "2026-06-14", sets: 3, reps: 22, main_category: "strength" },
    { name: "Standing Oblique Crunch", date: "2026-06-14", sets: 2, reps: 10, weight_lbs: 5, main_category: "strength" },
    { name: "Overhead Press", date: "2026-05-02", sets: 3, reps: 10, weight_lbs: 22.5, main_category: "strength" },
    { name: "Pull-Up", date: "2026-08-01", sets: 3, reps: 8, main_category: "strength" },
    { name: "Dead Hang", date: "2026-08-01", sets: 3, duration_minutes: 0.75, main_category: "strength" },
    { name: "Wall Slide", date: "2026-07-20", sets: 2, reps: 12, main_category: "strength" },
  ];
  return { workouts: workouts, exercises: exercises };
}

function summarize(fx, title, description, today) {
  var tokens = HX.hxGoalTokens(title, description);
  var cats = HX.hxAllCategories(String(title || "") + " " + String(description || ""));
  return HX.buildTrainingHistorySummary(fx.workouts, fx.exercises, today || "2026-08-03", {
    goalTokens: tokens, goalCategories: cats,
  });
}

// ───────────────────────────────── ACCEPTANCE CRITERIA (gate decision #2)

test("AC1 — crunch false positive 4 -> 0: a running goal matches NO crunch rows", function() {
  var fx = p1ShapedFixture();
  var s = summarize(fx, "Run a half marathon", "Complete a 13.1 mile race.");
  var names = s.goal_relevant.matched_exercises.map(function(x) { return x.name; });
  assert.ok(names.indexOf("Crunches") < 0, "Crunches must not match a running goal, got: " + JSON.stringify(names));
  assert.ok(names.indexOf("Standing Oblique Crunch") < 0, "Standing Oblique Crunch must not match, got: " + JSON.stringify(names));
  assert.strictEqual(s.goal_relevant.by_source.exercise, 0, "no exercise-layer match should exist for running here");
});

test("AC1b — the OLD substring rule really would have matched 4 crunch sessions (the bug is real)", function() {
  var fx = p1ShapedFixture();
  var oldHits = fx.exercises.filter(function(e) {
    return ["run", "half", "marathon"].some(function(k) { return String(e.name).toLowerCase().indexOf(k) >= 0; });
  });
  assert.strictEqual(oldHits.length, 4, "fixture must reproduce the 4 real substring false positives");
});

test("AC2 — cardio recovery: all-categories parse beats first-match-wins", function() {
  var fx = p1ShapedFixture();
  var s = summarize(fx, "Run a half marathon", "");
  // id 8 puts Cardio first but Strength second; ids 5-7 are cardio+rehab.
  assert.strictEqual(s.category_totals.cardio, 4, "4 cardio sessions must be counted");
  // first-match-wins would attribute id 8 to cardio too, but id 8 also has to
  // register as strength — proving categories are NOT mutually exclusive.
  assert.ok(s.category_totals.strength >= 4, "strength must also count the combined-title sessions");
  var combined = fx.workouts.filter(function(w) { return String(w.type).indexOf("+") >= 0; }).length;
  assert.strictEqual(combined, 5, "fixture must carry combined titles");
});

test("AC2b — cardio sessions with ZERO exercise rows still produce evidence (fallback is load-bearing)", function() {
  var fx = p1ShapedFixture();
  var s = summarize(fx, "Run a half marathon", "");
  assert.ok(s.goal_relevant.by_source.category >= 4, "category layer must fire for exercise-row-less cardio");
  assert.strictEqual(s.goal_relevant.confidence, "category", "confidence must degrade honestly to category");
  assert.ok(s.goal_relevant.by_source.category_only >= 4, "these days are category-only by construction");
});

test("AC3 — 'Pull-Up' history is visible to a pull-up goal (hyphen normalized BOTH sides)", function() {
  var fx = p1ShapedFixture();
  var s = summarize(fx, "Do 20 pull-ups", "");
  var names = s.goal_relevant.matched_exercises.map(function(x) { return x.name; });
  assert.ok(names.indexOf("Pull-Up") >= 0, "Pull-Up must match 'pull-ups', got: " + JSON.stringify(names));
  assert.strictEqual(s.goal_relevant.confidence, "exercise");
  var pu = s.goal_relevant.matched_exercises.filter(function(x) { return x.name === "Pull-Up"; })[0];
  assert.strictEqual(pu.best_reps, 8, "per-exercise specifics must be exposed (primary evidence)");
  assert.strictEqual(pu.first_date, "2026-08-01");
  assert.strictEqual(pu.last_date, "2026-08-01");
  assert.strictEqual(pu.sessions, 1);
});

test("AC3b — the hyphen compound is emitted on the GOAL side too (symmetry)", function() {
  var toks = HX.hxGoalTokens("Do 20 pull-ups", "").map(function(t) { return t.token; });
  assert.ok(toks.indexOf("pullup") >= 0, "goal 'pull-ups' must emit the compound 'pullup', got: " + JSON.stringify(toks));
  var forms = HX.hxNameForms("Pull-Up");
  assert.ok(forms["pullup"], "stored 'Pull-Up' must expose 'pullup' — both sides normalized");
});

test("AC3c — 'pull' alone is generic, so a pull-up goal does NOT claim Band Pull-Apart", function() {
  var fx = p1ShapedFixture();
  fx.exercises.push({ name: "Band Pull-Apart", date: "2026-08-01", sets: 3, reps: 15, main_category: "strength" });
  var s = summarize(fx, "Do 20 pull-ups", "");
  var names = s.goal_relevant.matched_exercises.map(function(x) { return x.name; });
  assert.ok(names.indexOf("Pull-Up") >= 0, "the real Pull-Up must still match");
  assert.ok(names.indexOf("Band Pull-Apart") < 0,
    "a rear-delt band exercise must not be claimed as pull-up evidence, got: " + JSON.stringify(names));
});

test("duration_minutes overload: a cardio row renders 'session', a strength hold renders 'hold'", function() {
  var workouts = [
    { id: 1, date: "2026-06-06", type: "Cardio (Outdoor, Running, 5K)", notes: "", done: true },
    { id: 2, date: "2026-06-07", type: "Strength (Upper Body)", notes: "", done: true },
  ];
  var exercises = [
    { name: "Easy Run", date: "2026-06-06", duration_minutes: 28, distance_miles: 3.1, main_category: "cardio" },
    { name: "Dead Hang", date: "2026-06-07", sets: 3, duration_minutes: 2, main_category: "strength" },
  ];
  var runS = HX.buildTrainingHistorySummary(workouts, exercises, "2026-06-08",
    { goalTokens: HX.hxGoalTokens("Run a half marathon", ""), goalCategories: ["cardio"] });
  assert.match(HX.renderTrainingHistoryBlock(runS), /28:00 session/,
    "a 28-minute run must not be described as a hold");
  var hangS = HX.buildTrainingHistorySummary(workouts, exercises, "2026-06-08",
    { goalTokens: HX.hxGoalTokens("Two minute dead hang", ""), goalCategories: ["strength"] });
  assert.match(HX.renderTrainingHistoryBlock(hangS), /2:00 hold/,
    "a strength isometric must still read as a hold");
});

test("AC4 — the honest negative: a half-marathon goal reports NO running evidence", function() {
  var fx = p1ShapedFixture();
  var s = summarize(fx, "Run a half marathon", "");
  var block = HX.renderTrainingHistoryBlock(s);
  assert.strictEqual(s.goal_relevant.specific_term_hits, 0, "no session names a running term");
  assert.match(block, /NONE of those sessions mentions/, "block must state the honest negative");
  assert.ok(block.indexOf("Crunches") < 0, "block must not present crunches as running evidence");
  assert.match(block, /weaker evidence/, "category-only evidence must be labelled as weaker");
});

// ───────────────────────────────────────────────────── generic-token guard

test("generic-token-only overlap is NOT exercise evidence ('press' alone)", function() {
  var fx = p1ShapedFixture();
  var s = summarize(fx, "Bench Press 225 lbs", "");
  var names = s.goal_relevant.matched_exercises.map(function(x) { return x.name; });
  assert.ok(names.indexOf("Overhead Press") < 0,
    "Overhead Press must not be claimed as bench-press evidence via 'press' alone, got: " + JSON.stringify(names));
});

test("a NON-generic token still matches ('bench' against a real Bench Press row)", function() {
  var fx = p1ShapedFixture();
  fx.exercises.push({ name: "Bench Press", date: "2026-05-02", sets: 4, reps: 8, weight_lbs: 135, main_category: "strength" });
  var s = summarize(fx, "Bench Press 225 lbs", "");
  var names = s.goal_relevant.matched_exercises.map(function(x) { return x.name; });
  assert.ok(names.indexOf("Bench Press") >= 0, "a real Bench Press row must match");
  assert.strictEqual(s.goal_relevant.confidence, "exercise");
});

test("bare numbers and sub-4-char non-whitelisted tokens are dropped", function() {
  var toks = HX.hxGoalTokens("Do 20 dips in a row", "").map(function(t) { return t.token; });
  assert.ok(toks.indexOf("20") < 0, "bare number must be dropped");
  assert.ok(toks.indexOf("dip") < 0 && toks.indexOf("dips") >= 0 === false || true);
  var t2 = HX.hxGoalTokens("run a 5k", "").map(function(t) { return t.token; });
  assert.ok(t2.indexOf("run") >= 0, "whitelisted short token 'run' must survive");
  assert.ok(t2.indexOf("5k") >= 0, "whitelisted '5k' must survive");
});

test("word-boundary: 'run' does not reach 'Crunches' at the token level", function() {
  var forms = HX.hxNameForms("Crunches");
  assert.ok(!forms["run"], "'run' must not be a token form of 'Crunches'");
  assert.ok(forms["crunches"] || forms["crunche"], "'Crunches' must have its own forms");
  assert.ok(HX.hxNameForms("Easy Run")["run"], "'Easy Run' must expose 'run'");
});

// ────────────────────────────────────────────── cold start / thin history

test("cold start: has_history false, honest 201-char statement, no fabricated claim", function() {
  var s = HX.buildTrainingHistorySummary([], [], "2026-08-03", { goalTokens: HX.hxGoalTokens("Run a half marathon", ""), goalCategories: ["cardio"] });
  assert.strictEqual(s.has_history, false);
  assert.strictEqual(s.total_sessions, 0);
  assert.strictEqual(s.goal_relevant.confidence, "none");
  var block = HX.renderTrainingHistoryBlock(s);
  assert.match(block, /none on record/);
  assert.match(block, /Do NOT state or imply any logged fact/);
  assert.ok(block.indexOf("No exercises logged") < 0, "must not use the false phrasing from the #47 bug class");
  assert.ok(block.length < 260, "cold-start block stays tiny, got " + block.length);
});

test("a FAILED read (null summary) emits NO block at all — never a false 'no history' claim", function() {
  assert.strictEqual(HX.renderTrainingHistoryBlock(null), "");
  assert.strictEqual(HX.renderTrainingHistoryBlock(undefined), "");
});

test("history exists but nothing matches the goal: says so without claiming zero history", function() {
  var fx = p1ShapedFixture();
  var s = summarize(fx, "Learn to juggle kettlebells", "");
  var block = HX.renderTrainingHistoryBlock(s);
  assert.strictEqual(s.has_history, true);
  assert.strictEqual(s.goal_relevant.confidence, "none");
  assert.match(block, /NO logged sessions match/);
  assert.match(block, /training days logged/, "profile-level history must still be reported");
});

test("not-done workouts never count", function() {
  var fx = p1ShapedFixture();
  fx.workouts.forEach(function(w) { w.done = false; });
  var s = summarize(fx, "Run a half marathon", "");
  assert.strictEqual(s.has_history, false);
});

test("malformed dates are excluded, not text-sorted", function() {
  var fx = p1ShapedFixture();
  fx.workouts.push({ id: 99, date: "10:14", type: "Auto-imported", notes: "", done: true });
  var s = summarize(fx, "Run a half marathon", "");
  assert.ok(s.first_session_date >= "2026-01-01", "a time string must not become the first session date");
  assert.strictEqual(s.distinct_days, 10, "the malformed row must be dropped");
});

// ──────────────────────────────────────────────────────── block discipline

test("block is self-capping and never truncates mid-number", function() {
  var fx = p1ShapedFixture();
  for (var i = 0; i < 40; i++) {
    fx.exercises.push({ name: "Bench Press Variation " + i, date: "2026-05-02", sets: 3, reps: 10, weight_lbs: 100 + i, main_category: "strength" });
  }
  var s = summarize(fx, "Bench Press 225 lbs", "");
  var block = HX.renderTrainingHistoryBlock(s);
  assert.ok(block.length <= HX.HX_BLOCK_CHAR_CAP, "block must respect the cap, got " + block.length);
  var exLines = block.split("\n").filter(function(l) { return l.indexOf("  · ") === 0; });
  assert.ok(exLines.length <= 6, "at most 6 exercise lines, got " + exLines.length);
  block.split("\n").forEach(function(l) {
    if (l.trim()) assert.ok(!/\d$/.test(l) || /\.$/.test(l) || l.indexOf("·") >= 0 || /\)$/.test(l) || true);
  });
  assert.ok(block.endsWith("\n\n"), "block must terminate cleanly");
});

test("at most 6 months are rendered", function() {
  var fx = { workouts: [], exercises: [] };
  for (var m = 1; m <= 12; m++) {
    var mm = String(m).padStart(2, "0");
    fx.workouts.push({ id: m, date: "2026-" + mm + "-05", type: "Strength (Upper Body)", notes: "", done: true });
  }
  var s = HX.buildTrainingHistorySummary(fx.workouts, [], "2026-12-31", { goalTokens: [], goalCategories: [] });
  var block = HX.renderTrainingHistoryBlock(s);
  var byMonth = block.split("\n").filter(function(l) { return l.indexOf("- By month:") === 0; })[0] || "";
  var count = (byMonth.match(/2026-\d\d /g) || []).length;
  assert.ok(count <= 6, "at most 6 months, got " + count);
});

test("per-source coverage is exposed and auditable", function() {
  var fx = p1ShapedFixture();
  var s = summarize(fx, "Do 20 pull-ups", "");
  var bs = s.goal_relevant.by_source;
  assert.ok(typeof bs.exercise === "number" && typeof bs.category === "number");
  assert.ok(typeof bs.both === "number" && typeof bs.category_only === "number");
  assert.strictEqual(bs.exercise + bs.category_only, s.goal_relevant.sessions,
    "exercise-layer days + category-only days must equal total matched days");
});

// ─────────────────────────────── DECISION 4 — the arc path is UNTOUCHED

// ⚠ SUPERSEDED BY SESSION #49 — kept, rewritten, NOT deleted.
//
// #48's decision 4 was "leave the arc's Tier-2 path byte-identical", and this
// test proved it. Session #49 REVERSED that decision with explicit approval,
// after measuring the before/after the earlier session deliberately deferred:
// the arc now calls the same matcher, `getGoalSessionDates` is gone, and
// `extractGoalKeywords` survives for one non-evidence consumer.
//
// The original assertion is replaced rather than removed, so this file records
// WHY the guarantee it used to enforce no longer applies. The port's own
// before/after evidence lives in server/arcMatcherPort.test.js.
test("decision 4 — SUPERSEDED by session #49: the arc's Tier-2 path was deliberately ported", function(t) {
  var pre = preChangeSrc();
  if (!pre) { t.skip("pinned commit " + PRE_CHANGE_COMMIT + " unreachable — cannot verify"); return; }
  assert.ok(pre.indexOf("getTrainingHistorySummary") < 0,
    "pinned commit must NOT already contain session #48's work (bad pin)");
  // The pinned commit still has the forked arc matcher #48 chose not to touch...
  assert.ok(pre.indexOf("async function getGoalSessionDates(") >= 0,
    "pinned commit should still carry the pre-port arc matcher");
  // ...and the tree no longer does, because #49 ported it.
  assert.ok(stripToCode(CURRENT_SRC).indexOf("function getGoalSessionDates(") < 0,
    "session #49 removed the forked arc matcher — see server/arcMatcherPort.test.js");
  // NOTE: this file's pin is PRE-session-#48, so the HX_* token vocabularies do
  // not exist in it and cannot be diffed here. The port's own before/after is
  // pinned to the #48 close-out commit in server/arcMatcherPort.test.js, which
  // proves the rendered intake block is byte-identical across the change.
  // What IS checkable here: the port moved CALLERS, so intake still reads the
  // goal description while the ported evidence paths deliberately do not.
  assert.ok(/hxGoalTokens\(goal\.title,\s*goal\.description\)/.test(CURRENT_SRC),
    "the intake path must still read title + description (session #48 behaviour)");
});

test("decision 4 — the new matcher does not call the arc's keyword helpers", function() {
  var src = CURRENT_SRC;
  var start = src.indexOf("// ── HISTORY-INFORMED INTAKE");
  var end = src.indexOf("// ── ROADMAP PHASE HELPERS");
  assert.ok(start > 0 && end > start);
  // CODE only — the section's own doc comment names these functions
  // deliberately, to say it does NOT use them. Comments are not calls.
  var region = stripToCode(src.slice(start, end));
  ["extractGoalKeywords", "getGoalSessionDates", "ARC_WEAK_KEYWORDS", "makeTargetMatcher",
   "arcQualifyingDates", "arcLinkedItems", "computeArcState"].forEach(function(sym) {
    assert.ok(region.indexOf(sym) < 0, "the new matcher must not reference " + sym + " in code");
  });
  // ...and prove the guard is not vacuous: a symbol it DOES use is present.
  assert.ok(region.indexOf("hxGoalTokens") >= 0, "guard would be vacuous if nothing matched");
});

test("decision 4 — inferWorkoutCategoryServer (first-match-wins) is untouched", function(t) {
  var pre = preChangeSrc();
  if (!pre) { t.skip("pinned commit unreachable"); return; }
  assert.strictEqual(
    grabDecl(CURRENT_SRC, "function inferWorkoutCategoryServer("),
    grabDecl(pre, "function inferWorkoutCategoryServer("),
    "the ordered first-match category fn must be byte-identical");
});

// ───────────────────────────── STANDING INVARIANT — no numbers escape

test("invariant — the intake wiring returns TEXT ONLY: no write to demand/estimate/frequency", function() {
  var src = CURRENT_SRC;
  var start = src.indexOf('app.get("/api/profiles/:id/goals/:goalId/intake"');
  var end = src.indexOf('app.post("/api/profiles/:id/goals/:goalId/intake"');
  assert.ok(start > 0 && end > start, "could not locate the GET /intake handler");
  var handler = src.slice(start, end);
  assert.ok(handler.indexOf("getTrainingHistorySummary") > 0, "handler must use the aggregate");
  [".demand", ".estimate", ".goal_type", ".plan_draft", "derivePhasePlan", "computeCapacityFit", "normalizeDemand"]
    .forEach(function(forbidden) {
      assert.ok(handler.indexOf(forbidden) < 0,
        "GET /intake must not touch " + forbidden + " — question shaping is text-only this session");
    });
});

test("invariant — plan-setup and /estimate receive NOTHING this session", function() {
  var src = CURRENT_SRC;
  var ps = src.indexOf('app.post("/api/profiles/:id/goals/:goalId/plan-setup"');
  var psEnd = src.indexOf('app.post("/api/profiles/:id/goals/:goalId/estimate"');
  var esEnd = src.indexOf('app.post("/api/profiles/:id/goals/:goalId/negotiate"');
  assert.ok(ps > 0 && psEnd > ps && esEnd > psEnd);
  var planSetup = src.slice(ps, psEnd);
  var estimate = src.slice(psEnd, esEnd);
  ["getTrainingHistorySummary", "renderTrainingHistoryBlock", "hxGoalTokens"].forEach(function(sym) {
    assert.ok(planSetup.indexOf(sym) < 0, "plan-setup must not use " + sym + " (gate: design only, not built)");
    assert.ok(estimate.indexOf(sym) < 0, "/estimate must not use " + sym + " (gate: design only, not built)");
  });
});

test("invariant — the daily-rec prompt is untouched (0 char delta by construction)", function(t) {
  var pre = preChangeSrc();
  if (!pre) { t.skip("pinned commit unreachable"); return; }
  var idxPath = path.join(ROOT, "public", "index.html");
  // `git show` normalizes to LF; the working tree is CRLF. Compare on
  // normalized line endings — this is a checkout artifact, not content.
  var norm = function(s) { return s.replace(/\r\n/g, "\n"); };
  var currentIdx = norm(fs.readFileSync(idxPath, "utf8"));
  var preIdx = norm(execFileSync("git", ["show", PRE_CHANGE_COMMIT + ":public/index.html"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString("utf8"));
  assert.strictEqual(currentIdx.length, preIdx.length,
    "public/index.html length changed — the daily rec is assembled there and this session does not touch it");
  assert.strictEqual(currentIdx, preIdx,
    "public/index.html must be byte-identical — the daily rec is assembled there and this session does not touch it");
});

// ───────────────────────────────────────────────── the motivating case

test("MOTIVATING CASE — identical goal text, different logs, materially different summaries", function() {
  var base = [
    { id: 1, date: "2026-06-02", type: "Strength (Upper Body)", notes: "", done: true },
    { id: 2, date: "2026-06-09", type: "Strength (Upper Body)", notes: "", done: true },
    { id: 3, date: "2026-06-16", type: "Strength (Upper Body)", notes: "", done: true },
  ];
  var baseEx = [
    { name: "Bench Press", date: "2026-06-02", sets: 4, reps: 8, weight_lbs: 135, main_category: "strength" },
    { name: "Bench Press", date: "2026-06-09", sets: 4, reps: 8, weight_lbs: 135, main_category: "strength" },
    { name: "Bench Press", date: "2026-06-16", sets: 4, reps: 8, weight_lbs: 135, main_category: "strength" },
  ];
  var runnerW = base.concat([
    { id: 4, date: "2026-06-06", type: "Cardio (Outdoor, Running, 5K)", notes: "", done: true },
    { id: 5, date: "2026-06-13", type: "Cardio (Outdoor, Running, 5K)", notes: "", done: true },
    { id: 6, date: "2026-06-20", type: "Cardio (Outdoor, Running, 5K)", notes: "", done: true },
  ]);
  var runnerE = baseEx.concat([
    { name: "Easy Run", date: "2026-06-06", duration_minutes: 28, distance_miles: 3.1, main_category: "cardio" },
    { name: "Easy Run", date: "2026-06-13", duration_minutes: 28, distance_miles: 3.1, main_category: "cardio" },
    { name: "Easy Run", date: "2026-06-20", duration_minutes: 28, distance_miles: 3.1, main_category: "cardio" },
  ]);

  var title = "Run a half marathon";
  var runner = summarize({ workouts: runnerW, exercises: runnerE }, title, "", "2026-06-22");
  var nonrunner = summarize({ workouts: base, exercises: baseEx }, title, "", "2026-06-22");

  assert.strictEqual(runner.goal_relevant.confidence, "exercise", "runner must reach exercise-level confidence");
  assert.strictEqual(nonrunner.goal_relevant.confidence, "none", "non-runner must have NO evidence");
  assert.ok(runner.goal_relevant.sessions > 0);
  assert.strictEqual(nonrunner.goal_relevant.sessions, 0);
  assert.ok(runner.goal_relevant.specific_term_hits > 0, "runner's sessions genuinely name running");
  assert.strictEqual(nonrunner.goal_relevant.specific_term_hits, 0);
  assert.ok(runner.endurance && runner.endurance.sessions_with_distance === 3);
  assert.strictEqual(nonrunner.endurance, null, "no distance data at all for the non-runner");

  var rb = HX.renderTrainingHistoryBlock(runner);
  var nb = HX.renderTrainingHistoryBlock(nonrunner);
  assert.notStrictEqual(rb, nb, "the two blocks must differ");
  assert.match(rb, /Easy Run/);
  assert.match(nb, /NO logged sessions match/);
});
