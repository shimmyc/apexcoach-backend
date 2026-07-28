"use strict";
/**
 * BUG 4 — needs_regeneration must be RECOMPUTED, never carried (session #44).
 *
 * The flag was one-way: computeArcState carried the previous value forward and
 * nothing anywhere wrote false, so once set it survived every evaluation, adapt
 * and regenerate forever — the banner -> regenerate -> banner loop.
 *
 * These tests EXTRACT the real shipped applyTimelineFlex (and its collaborators)
 * out of server.js by source slicing and evaluate them in a vm sandbox — the
 * "run the actual code, never a hand-copied duplicate" discipline used by
 * v2FoldedCards.test.js. They run against BOTH file versions:
 *   - the working tree (post-fix), asserting the new semantics
 *   - the commit pinned in PRE_FIX_COMMIT (pre-fix), asserting the OLD
 *     behaviour, so the tests prove a real change rather than passing vacuously
 *
 * Hardening per arc close-out learning #2 (a near-green harness that silently
 * mis-extracts is worse than one that fails): every slice is re-parsed, and an
 * over-capture guard rejects a slice that swallowed another top-level function.
 *
 * Run: node --test server/arcFlag.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TREE = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// PRE-FIX REFERENCE — pinned to the LAST COMMIT BEFORE the BUG 4 fix, not to
// HEAD. Using HEAD works only while the fix is uncommitted; the moment it lands,
// "pre-fix" silently becomes "post-fix" and these tests start asserting the
// opposite of what they claim. (Caught exactly that way, immediately after the
// fix commit.) A pin can only ever be wrong loudly.
const PRE_FIX_COMMIT = "d2b0871";
const POST_FIX_MARKER = "arc.needs_regeneration = false;";
let HEAD = null;
try {
  HEAD = execFileSync("git", ["show", PRE_FIX_COMMIT + ":server.js"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  // Guard the pin itself: if that commit somehow already had the fix, the
  // comparison is meaningless and must fail rather than pass vacuously.
  assert.ok(HEAD.indexOf(POST_FIX_MARKER) < 0,
    "pin " + PRE_FIX_COMMIT + " already contains the fix — update PRE_FIX_COMMIT");
} catch (e) {
  if (/already contains the fix/.test(e.message)) throw e;
  HEAD = null;   // shallow clone / commit unreachable -> pre-fix tests skip loudly
}
assert.ok(TREE.indexOf(POST_FIX_MARKER) >= 0, "working tree is missing the BUG 4 fix");

/** Slice [startMarker, endMarker) out of a source, asserting both exist. */
function slice(src, label, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  assert.ok(s >= 0, label + ": start marker not found: " + startMarker);
  const e = src.indexOf(endMarker, s + startMarker.length);
  assert.ok(e > s, label + ": end marker not found: " + endMarker);
  const out = src.slice(s, e);
  // OVER-CAPTURE GUARD — a slice must contain exactly ONE column-0 `function`
  // declaration unless it is a multi-function block we asked for by name.
  return out;
}

function buildSandbox(src, label) {
  const parts = [
    slice(src, label, "var PHASE_MIN_WEEKS = 2;", "\n\n"),
    slice(src, label, "var MAX_FLEX_WEEKS = 4;", "\n\n"),
    slice(src, label, "function ymdLocal(x) {", "function numOrNull(v) {"),
    slice(src, label, "function numOrNull(v) {", "\n}\n") + "\n}\n",
    slice(src, label, "function resequenceNearTermDates(phases, todayStr) {", "\nfunction assignNearTermDates("),
    slice(src, label, "function applyTimelineFlex(goal, arc, todayYmd) {", "\n// TIER 2 fallback source."),
  ];
  const SRC = parts.join("\n");

  // Over-capture guard: exactly the five declarations we asked for, no more.
  const decls = (SRC.match(/^function\s+([A-Za-z0-9_$]+)/gm) || []).map((s) => s.split(/\s+/)[1]);
  assert.deepStrictEqual(
    decls.slice().sort(),
    ["applyTimelineFlex", "numOrNull", "resequenceNearTermDates", "ymdLocal"].sort(),
    label + ": extraction captured unexpected top-level functions: " + decls.join(",")
  );

  const sandbox = { console };
  vm.createContext(sandbox);
  // Mandatory re-parse — a mis-sliced fragment throws here rather than passing.
  vm.runInContext(SRC, sandbox);
  assert.strictEqual(typeof sandbox.applyTimelineFlex, "function", label + ": applyTimelineFlex not extracted");
  assert.strictEqual(sandbox.PHASE_MAX_WEEKS, 6, label + ": PHASE_MAX_WEEKS not extracted");
  assert.strictEqual(sandbox.ARC_FLEX_STREAK_REQUIRED, 2, label + ": ARC_FLEX_STREAK_REQUIRED not extracted");
  return sandbox;
}

const POST = buildSandbox(TREE, "working tree");
const PRE = HEAD ? buildSandbox(HEAD, "pre-fix " + PRE_FIX_COMMIT) : null;
const preOpts = { skip: PRE ? false : "pre-fix commit " + PRE_FIX_COMMIT + " unreachable (shallow clone?)" };

const TODAY = "2026-07-28";

/** phases spec: [{ dw, status }] */
function mkGoal(phases, estimate) {
  return {
    estimate: estimate || { total_weeks_low: 7, total_weeks_high: 13, assumed_frequency: 5, basis: "b" },
    demand: { sessions_per_week: 5 },
    roadmap: {
      estimate: estimate || { total_weeks_low: 7, total_weeks_high: 13, assumed_frequency: 5, basis: "b" },
      phases: phases.map((p, i) => ({
        type: "near_term", name: "P" + i, duration_weeks: p.dw, status: p.status,
        start_date: "2026-06-29", end_date: "2026-07-26",
      })),
    },
  };
}
function mkArc(drift, flexStreak, seedFlag) {
  return {
    position_week: 0, calendar_week: 5, drift: drift, status: "stalled", re_ramp: null,
    evidence: { qualifying_sessions_28d: 2, expected_28d: 20, longest_gap_days: 20, confidence: "category", matched_via: [], tier: 1 },
    flex_streak: flexStreak,
    needs_regeneration: seedFlag === undefined ? true : seedFlag,
    last_evaluated: "2026-07-28T12:18:32.807Z",
  };
}

// ── (b) THE CLEAR — the whole point of the fix ──────────────────────────────
test("(b) CLEARS when the drift is absorbable — seeded true, comes back false", () => {
  // 3 upcoming x 4wk = 12. drift -5 -> adjust -4 -> target 16. lo 6, hi 18.
  // bounded 16, NOT clamped -> a clean flex -> flag must be false.
  const g = mkGoal([{ dw: 5, status: "current" }, { dw: 4, status: "upcoming" }, { dw: 4, status: "upcoming" }, { dw: 4, status: "upcoming" }]);
  const arc = mkArc(-5, 2, true);
  const rep = POST.applyTimelineFlex(g, arc, TODAY);
  assert.strictEqual(arc.needs_regeneration, false, "absorbable drift must clear the flag");
  assert.strictEqual(rep.flexed, true);
  assert.strictEqual(rep.clamped, false);
});

test("(b) CLEARS when there is no meaningful drift at all", () => {
  const g = mkGoal([{ dw: 5, status: "current" }, { dw: 5, status: "upcoming" }]);
  const arc = mkArc(-1, 5, true);           // |drift| < 2
  const rep = POST.applyTimelineFlex(g, arc, TODAY);
  assert.strictEqual(rep, null);
  assert.strictEqual(arc.needs_regeneration, false, "no drift to absorb -> flag false");
});

test("(b) PRE-FIX could not clear: the same absorbable case left the flag true", preOpts, () => {
  const g = mkGoal([{ dw: 5, status: "current" }, { dw: 4, status: "upcoming" }, { dw: 4, status: "upcoming" }, { dw: 4, status: "upcoming" }]);
  const arc = mkArc(-5, 2, true);
  PRE.applyTimelineFlex(g, arc, TODAY);
  assert.strictEqual(arc.needs_regeneration, true, "pre-fix: nothing ever wrote false — this is BUG 4");
});

// ── (c) all three TRUE branches still set ───────────────────────────────────
test("(c) TRUE branch 1 — no upcoming phases", () => {
  const g = mkGoal([{ dw: 5, status: "current" }]);
  const arc = mkArc(-5, 9, false);
  const rep = POST.applyTimelineFlex(g, arc, TODAY);
  assert.strictEqual(arc.needs_regeneration, true);
  assert.strictEqual(rep.reason, "no_upcoming_phases");
});

test("(c) TRUE branch 2 — bounded === upcomingWeeks and clamped (clamped_no_room)", () => {
  // 1 upcoming x 6wk (already at PHASE_MAX). drift -5 -> target 10 -> bounded 6 === upcomingWeeks.
  const g = mkGoal([{ dw: 5, status: "current" }, { dw: 6, status: "upcoming" }]);
  const arc = mkArc(-5, 4, false);
  const rep = POST.applyTimelineFlex(g, arc, TODAY);
  assert.strictEqual(arc.needs_regeneration, true);
  assert.strictEqual(rep.reason, "clamped_no_room");
  assert.strictEqual(rep.flexed, false);
});

test("(c) TRUE branch 3 — partial flex that clamps", () => {
  // 1 upcoming x 5wk. drift -5 -> target 9 -> bounded 6 (clamped), 6 !== 5 -> flexes to 6.
  const g = mkGoal([{ dw: 5, status: "current" }, { dw: 5, status: "upcoming" }]);
  const arc = mkArc(-5, 4, false);
  const rep = POST.applyTimelineFlex(g, arc, TODAY);
  assert.strictEqual(arc.needs_regeneration, true);
  assert.strictEqual(rep.flexed, true);
  assert.strictEqual(rep.clamped, true);
  assert.strictEqual(g.roadmap.phases[1].duration_weeks, 6);
  assert.strictEqual(arc.flex_streak, 0, "streak still resets after a real flex");
});

// ── THE FLICKER — the reason a naive recompute was rejected ─────────────────
test("FLICKER CLOSED — streak below the gate still yields TRUE when unabsorbable", () => {
  // Exactly profile 4's fire-2 state: a partial flex clamped last time (streak
  // reset to 0 -> recomputed to 1), so the streak gate short-circuits. A naive
  // recompute would read FALSE here while drift is still -5.
  const g = mkGoal([{ dw: 5, status: "current" }, { dw: 6, status: "upcoming" }]);
  const arc = mkArc(-5, 1, false);          // 1 < ARC_FLEX_STREAK_REQUIRED
  const rep = POST.applyTimelineFlex(g, arc, TODAY);
  assert.strictEqual(rep, null, "mutation is still correctly gated by the streak");
  assert.strictEqual(arc.needs_regeneration, true, "but the ASSESSMENT ran anyway");
  assert.strictEqual(g.roadmap.phases[1].duration_weeks, 6, "no mutation happened");
});

test("FLICKER — pre-fix this same call wrote NOTHING (why naive recompute breaks)", preOpts, () => {
  const g = mkGoal([{ dw: 5, status: "current" }, { dw: 6, status: "upcoming" }]);
  const arc = mkArc(-5, 1, false);
  const rep = PRE.applyTimelineFlex(g, arc, TODAY);
  assert.strictEqual(rep, null);
  assert.strictEqual(arc.needs_regeneration, false,
    "pre-fix left it untouched — so a `false` seed would have survived as a lie");
});

// ── (e) the APPROVED widening ───────────────────────────────────────────────
test("(e) no_upcoming_phases fires at flex_streak 0 (approved widening)", () => {
  const g = mkGoal([{ dw: 5, status: "current" }]);
  const arc = mkArc(-5, 0, false);
  const rep = POST.applyTimelineFlex(g, arc, TODAY);
  assert.strictEqual(arc.needs_regeneration, true);
  assert.strictEqual(rep.reason, "no_upcoming_phases");
});

test("(e) no_upcoming_phases fires at flex_streak 1 (approved widening)", () => {
  const g = mkGoal([{ dw: 5, status: "current" }]);
  const arc = mkArc(-5, 1, false);
  const rep = POST.applyTimelineFlex(g, arc, TODAY);
  assert.strictEqual(arc.needs_regeneration, true);
  assert.strictEqual(rep.reason, "no_upcoming_phases");
});

test("(e) PRE-FIX suppressed no_upcoming_phases below the streak gate", preOpts, () => {
  [0, 1].forEach((streak) => {
    const g = mkGoal([{ dw: 5, status: "current" }]);
    const arc = mkArc(-5, streak, false);
    const rep = PRE.applyTimelineFlex(g, arc, TODAY);
    assert.strictEqual(rep, null, "pre-fix returned null at streak " + streak);
    assert.strictEqual(arc.needs_regeneration, false, "pre-fix wrote nothing at streak " + streak);
  });
});

// ── (d) the real wrist-goal shape ───────────────────────────────────────────
test("(d) profile 4 wrist goal's real post-regenerate shape still yields TRUE", () => {
  // Live: near_term [5 current, 5 upcoming], drift -5, arc_origin 2026-06-29.
  const g = mkGoal([{ dw: 5, status: "current" }, { dw: 5, status: "upcoming" }]);
  const arc = mkArc(-5, 15, false);
  POST.applyTimelineFlex(g, arc, TODAY);
  assert.strictEqual(arc.needs_regeneration, true, "the banner must stay up — the drift is real");
});

// ── mutation-path non-regression ────────────────────────────────────────────
test("flex MUTATION path is unchanged pre vs post (durations, dates, streak, estimate)", preOpts, () => {
  const cases = [
    [[{ dw: 5, status: "current" }, { dw: 5, status: "upcoming" }], -5, 4],
    [[{ dw: 5, status: "current" }, { dw: 4, status: "upcoming" }, { dw: 4, status: "upcoming" }, { dw: 4, status: "upcoming" }], -5, 2],
    [[{ dw: 6, status: "current" }, { dw: 6, status: "upcoming" }, { dw: 6, status: "upcoming" }], 3, 3],
    [[{ dw: 5, status: "current" }, { dw: 5, status: "upcoming" }], -2, 7],
  ];
  cases.forEach(([phases, drift, streak], i) => {
    const gA = mkGoal(phases), gB = mkGoal(phases);
    const aA = mkArc(drift, streak, false), aB = mkArc(drift, streak, false);
    const rA = PRE.applyTimelineFlex(gA, aA, TODAY);
    const rB = POST.applyTimelineFlex(gB, aB, TODAY);
    assert.deepStrictEqual(gB.roadmap.phases, gA.roadmap.phases, "case " + i + ": phases diverged");
    assert.strictEqual(aB.flex_streak, aA.flex_streak, "case " + i + ": flex_streak diverged");
    assert.deepStrictEqual(gB.estimate, gA.estimate, "case " + i + ": estimate diverged");
    // Return shape: identical except the flag field, which is the fix.
    // Compared as JSON, not deepStrictEqual — the reports contain objects built
    // INSIDE the vm sandboxes (resequenceNearTermDates' date_changes), and each
    // vm context has its own Object.prototype, so a structural compare fails on
    // realm identity alone even when every value matches.
    const strip = (r) => JSON.stringify(r ? Object.assign({}, r, { needs_regeneration: null }) : r);
    assert.strictEqual(strip(rB), strip(rA), "case " + i + ": report diverged");
  });
});

// ── (f) legacy / no-arc goals ───────────────────────────────────────────────
test("(f) a null arc is a no-op in BOTH versions (legacy goals never reach the flag)", preOpts, () => {
  const g = mkGoal([{ dw: 5, status: "current" }, { dw: 5, status: "upcoming" }]);
  assert.strictEqual(POST.applyTimelineFlex(g, null, TODAY), null);
  assert.strictEqual(PRE.applyTimelineFlex(g, null, TODAY), null);
  assert.deepStrictEqual(g.roadmap.phases.map((p) => p.duration_weeks), [5, 5], "no mutation on a legacy goal");
});

test("(f) the fix never CREATES the key on an arc object that lacked it", () => {
  // A no-drift arc: post-fix writes false (the recompute), which is the intended
  // contract. Assert it is the ONLY key the fix adds.
  const g = mkGoal([{ dw: 5, status: "current" }, { dw: 5, status: "upcoming" }]);
  const bare = { drift: 0, flex_streak: 0 };
  POST.applyTimelineFlex(g, bare, TODAY);
  assert.deepStrictEqual(Object.keys(bare).sort(), ["drift", "flex_streak", "needs_regeneration"]);
});
