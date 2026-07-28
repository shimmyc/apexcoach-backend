"use strict";
/**
 * PT BRAIN LAYER 1 — CAPACITY NEGOTIATION (session #45).
 *
 * The session #45 audit found FIVE independent defects behind "all three levers
 * fail", reproduced live on the sandbox profile:
 *
 *   1. The dial lock discarded ANY incoming sessions_per_week on a rehab goal,
 *      which silently turned `slower` and `sequence` into no-ops. Posted 3,
 *      stored 4, dial_override_applied:true, and the client never read the flag.
 *   2. The levers only ever moved the goal being created, but the binding axis
 *      was owned by a DIFFERENT goal — so no frequency was reachable that could
 *      resolve it.
 *   3. `model_levers_valid` checked only that the three lever KEYS were present.
 *      Not one number in the prose was validated ("needs 400 committed minutes"
 *      against a supplied 235, live, at model_levers_valid:true).
 *   4. Levers that provably could not close the gap were offered as choices.
 *   5. /estimate wrote on EVERY attempt, so an abandoned negotiation left the
 *      goal permanently altered — including a code-authored FALSE basis sentence
 *      after a change the dial lock had just discarded.
 *
 * These tests run the REAL SHIPPED code against BOTH file versions:
 *   - the working tree (post-fix), asserting the new behaviour
 *   - the commit pinned in PRE_FIX_COMMIT, asserting the OLD behaviour, so every
 *     test proves a real change instead of passing vacuously
 *
 * Hardening per arc close-out learning #2 (a near-green harness that silently
 * mis-extracts is worse than one that fails outright): every slice is re-parsed,
 * and an over-capture guard rejects a slice that swallowed another declaration.
 * The pre-fix reference is a PINNED COMMIT, never HEAD — the moment the fix is
 * committed, HEAD would silently become "post-fix" and invert these assertions
 * (session #44 was caught exactly that way).
 *
 * Run: node --test server/negotiation.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TREE = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const TREE_HTML = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");

const PRE_FIX_COMMIT = "80d83ed";
const POST_FIX_MARKER = "function dialLockAllows(";

let HEAD = null;
try {
  HEAD = execFileSync("git", ["show", PRE_FIX_COMMIT + ":server.js"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  assert.ok(HEAD.indexOf(POST_FIX_MARKER) < 0,
    "pin " + PRE_FIX_COMMIT + " already contains the fix — update PRE_FIX_COMMIT");
} catch (e) {
  if (/already contains the fix/.test(e.message)) throw e;
  HEAD = null;
}
assert.ok(TREE.indexOf(POST_FIX_MARKER) >= 0, "working tree is missing the session #45 negotiation fixes");

function slice(src, label, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  assert.ok(s >= 0, label + ": start marker not found: " + startMarker);
  const e = src.indexOf(endMarker, s + startMarker.length);
  assert.ok(e > s, label + ": end marker not found: " + endMarker);
  return src.slice(s, e);
}

/** Shared I/O boundary. Everything below it is REAL extracted code. */
function makeStubs(sandbox) {
  sandbox.console = console;
  sandbox.derivePhasePlan = function () { return { near_term: [], horizon: [] }; };
  sandbox.modelForCallType = function () { return "stub-model"; };
  sandbox.ensureGoalIds = function () { return false; };
  // Configured per test.
  sandbox.__ai = function () { return "{}"; };
  sandbox.callAISystem = async function (sys, user, max, model, timeoutMs) {
    sandbox.__lastAiTimeout = timeoutMs;
    sandbox.__lastAiUser = user;
    return sandbox.__ai(sys, user);
  };
  sandbox.__profile = null;
  sandbox.__saved = null;
  sandbox.loadProfileWithGoals = async function () {
    return { profile: { id: 9 }, profileData: JSON.parse(JSON.stringify(sandbox.__profile)) };
  };
  sandbox.saveGoalToProfile = async function (pid, profileData, idx, goal) {
    profileData.goals[idx] = goal;
    sandbox.__saved = JSON.parse(JSON.stringify(profileData));
    return goal;
  };
  const routes = {};
  sandbox.__routes = routes;
  sandbox.app = { post: function (p, h) { routes[p] = h; }, get: function (p, h) { routes["GET " + p] = h; } };
  return sandbox;
}

function buildSandbox(src, label, isPost) {
  const parts = [
    slice(src, label, 'var GOAL_TYPES = ["rehab"', "function ensureGoalDefaults(profileData) {"),
    slice(src, label, "function clampNum(v, lo, hi, fallback) {", "// THE FIT CHECK"),
    slice(src, label, "function computeCapacityFit(profileData, opts) {",
      isPost ? "// ── PT BRAIN · LAYER 1 — NEGOTIATION MACHINERY" : "// ── PT BRAIN · LAYER 3 — coexistence engine"),
    slice(src, label, "function numOrNull(v) {", "\n}\n") + "\n}\n",
    slice(src, label, "function findGoalById(profileData, goalId) {", "// Load a profile row"),
    slice(src, label, "function parseAIJson(text) {", "\n}\n") + "\n}\n",
    // The routes reference these prompt constants; they carry no declarations, so
    // they do not affect the over-capture guard.
    slice(src, label, "var PLAN_SETUP_SYS =", "// Clamp an AI plan-setup proposal"),
  ];
  const expected = ["clampNum", "computeCapacityFit", "findGoalById", "normalizeCapacity",
    "normalizeDemand", "numOrNull", "parseAIJson"];
  if (isPost) {
    parts.push(slice(src, label, "var NEGOTIATION_LEVERS = [", "// ── PT BRAIN · LAYER 3 — coexistence engine"));
    expected.push("isDemandLever", "dialLockAllows", "goalBaselineDemand", "goalPendingDemand", "resolveLeverTarget",
      "projectLeverOutcome", "buildLeverFacts", "leverTextNumbersValid", "buildCodeAuthoredLevers");
  }
  // The two routes under test.
  parts.push(slice(src, label, 'app.post("/api/profiles/:id/goals/:goalId/estimate"', "// STEP 4 — only reached"));
  parts.push(slice(src, label, 'app.post("/api/profiles/:id/goals/:goalId/negotiate"', "// ── PT BRAIN · LAYER 3 ROUTES"));

  const SRC = parts.join("\n");

  // OVER-CAPTURE GUARD — exactly the declarations we asked for, nothing else.
  const decls = (SRC.match(/^function\s+([A-Za-z0-9_$]+)/gm) || []).map((s) => s.split(/\s+/)[1]);
  assert.deepStrictEqual(decls.slice().sort(), expected.slice().sort(),
    label + ": extraction captured unexpected top-level functions: " + decls.join(","));

  const sandbox = makeStubs({});
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);   // mandatory re-parse
  assert.strictEqual(typeof sandbox.computeCapacityFit, "function", label + ": computeCapacityFit not extracted");
  assert.ok(sandbox.__routes["/api/profiles/:id/goals/:goalId/estimate"], label + ": estimate route not captured");
  assert.ok(sandbox.__routes["/api/profiles/:id/goals/:goalId/negotiate"], label + ": negotiate route not captured");
  return sandbox;
}

const POST = buildSandbox(TREE, "working tree", true);
const PRE = HEAD ? buildSandbox(HEAD, "pre-fix " + PRE_FIX_COMMIT, false) : null;
const preOpts = { skip: PRE ? false : "pre-fix commit " + PRE_FIX_COMMIT + " unreachable (shallow clone?)" };

// ── FIXTURE: the sandbox profile exactly as the session #45 audit found it ────
const BENCH = "d43aa090-bench";
const SHOULDER = "556db4a5-shoulder";
const FIVEK = "5de4aed0-5k";

function fixture() {
  return {
    capacity: { days_per_week: 5, minutes_per_day: 60, hard_sessions_per_week: 2, protected_days: [] },
    goals: [
      { id: BENCH, title: "Bench Press 185lb", status: "IN PROGRESS", goal_type: "strength_load",
        demand: { sessions_per_week: 3, minutes_per_session: 45, hard: true, min_viable_sessions_per_week: 2 },
        estimate: { total_weeks_low: 12, total_weeks_high: 20, assumed_frequency: 3, basis: "bench basis." } },
      { id: SHOULDER, title: "Full Shoulder Recovery", status: "IN PROGRESS", goal_type: "rehab",
        demand: { sessions_per_week: 4, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 },
        estimate: { total_weeks_low: 12, total_weeks_high: 32, assumed_frequency: 4, basis: "shoulder basis." } },
      { id: FIVEK, title: "Run a sub 25m - 5k", status: "IN PROGRESS" },
    ],
  };
}

function mkRes() {
  return {
    code: 200, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function callEstimate(sb, goalId, body) {
  const res = mkRes();
  await sb.__routes["/api/profiles/:id/goals/:goalId/estimate"](
    { params: { id: "9", goalId: goalId }, body: body }, res);
  return res;
}
async function callNegotiate(sb, goalId, body) {
  const res = mkRes();
  await sb.__routes["/api/profiles/:id/goals/:goalId/negotiate"](
    { params: { id: "9", goalId: goalId }, body: body || {} }, res);
  return res;
}
function savedGoal(sb, id) {
  if (!sb.__saved) return null;
  return sb.__saved.goals.filter((g) => g.id === id)[0] || null;
}
function estimateAI(low, high) {
  return () => JSON.stringify({ total_weeks_low: low, total_weeks_high: high, basis: "AI basis." });
}
function reset(sb, prof) {
  sb.__profile = prof || fixture();
  sb.__saved = null;
  sb.__ai = estimateAI(12, 24);
}

// ═════════════════════════════════════════════════════════════════════════════
// FIX 1 — the dial lock is lever-aware
// ═════════════════════════════════════════════════════════════════════════════
test("FIX 1: a negotiation lever MAY lower frequency on a dial-locked rehab goal", async () => {
  reset(POST);
  const r = await callEstimate(POST, SHOULDER, {
    goal_type: "rehab", lever: "sequence",
    demand: { sessions_per_week: 3, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 },
  });
  assert.strictEqual(r.body.demand.sessions_per_week, 3, "lever-driven decrease must be honoured");
  assert.strictEqual(r.body.dial_override_applied, false);
});

test("FIX 1: a lever may NOT raise frequency on a locked goal", async () => {
  reset(POST);
  const r = await callEstimate(POST, SHOULDER, {
    goal_type: "rehab", lever: "slower",
    demand: { sessions_per_week: 6, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 },
  });
  assert.strictEqual(r.body.demand.sessions_per_week, 4, "an increase must still be discarded");
  assert.strictEqual(r.body.dial_override_applied, true);
});

test("FIX 1: the MANUAL dial stays absolutely locked (no lever = no change, either direction)", async () => {
  reset(POST);
  const down = await callEstimate(POST, SHOULDER, {
    goal_type: "rehab",
    demand: { sessions_per_week: 2, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 2 },
  });
  assert.strictEqual(down.body.demand.sessions_per_week, 4, "manual decrease must be discarded");
  assert.strictEqual(down.body.dial_override_applied, true);
  reset(POST);
  const up = await callEstimate(POST, SHOULDER, {
    goal_type: "rehab",
    demand: { sessions_per_week: 7, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 },
  });
  assert.strictEqual(up.body.demand.sessions_per_week, 4);
  assert.strictEqual(up.body.dial_override_applied, true);
});

test("FIX 1: LEDGER ROW 5 preserved — the lock is still server-authoritative on a NEW goal", async () => {
  // Row 5 was verified when plan-setup COMMITTED its proposal. Fix 8 makes that a
  // draft, so the lock must now enforce against plan_draft.demand instead — or a
  // brand-new rehab goal would accept whatever frequency the client sent.
  const p = fixture();
  delete p.goals[1].demand;
  delete p.goals[1].estimate;
  p.goals[1].plan_draft = { goal_type: "rehab",
    demand: { sessions_per_week: 5, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 } };
  reset(POST, p);
  const r = await callEstimate(POST, SHOULDER, {
    goal_type: "rehab",
    demand: { sessions_per_week: 7, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 },
  });
  assert.strictEqual(r.body.demand.sessions_per_week, 5, "client sent 7, the stored draft baseline is 5");
  assert.strictEqual(r.body.dial_override_applied, true);
});

test("FIX 1: an UNLOCKED goal_type is unaffected — manual dial still moves freely", async () => {
  reset(POST);
  const r = await callEstimate(POST, BENCH, {
    goal_type: "strength_load",
    demand: { sessions_per_week: 2, minutes_per_session: 45, hard: true, min_viable_sessions_per_week: 2 },
  });
  assert.strictEqual(r.body.demand.sessions_per_week, 2);
  assert.strictEqual(r.body.dial_override_applied, false);
});

test("FIX 1 PRE-FIX: the sequence lever was silently discarded on a rehab goal (the live bug)", preOpts, async () => {
  reset(PRE);
  const r = await callEstimate(PRE, SHOULDER, {
    goal_type: "rehab", lever: "sequence",
    demand: { sessions_per_week: 3, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 },
  });
  assert.strictEqual(r.body.demand.sessions_per_week, 4,
    "pre-fix: posted 3, stored 4 — this is defect 1, reproduced live on 2026-07-28");
  assert.strictEqual(r.body.dial_override_applied, true);
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 2 — levers target the goal that owns the binding axis
// ═════════════════════════════════════════════════════════════════════════════
test("FIX 2: the binding axis is hard sessions, and it is owned by BENCH not the goal on screen", () => {
  const fit = POST.computeCapacityFit(fixture(), {});
  assert.strictEqual(fit.fits, false);
  assert.strictEqual(fit.minutes_over, 0, "time was never the problem");
  assert.strictEqual(fit.hard_over, 1);
  const t = POST.resolveLeverTarget(fit, SHOULDER);
  assert.strictEqual(t.goal_id, BENCH);
  assert.strictEqual(t.axis, "hard");
  assert.strictEqual(t.is_current_goal, false, "the goal being set up contributes ZERO hard sessions");
});

test("FIX 2: when the current goal DOES own the binding axis, it is the target", () => {
  const fit = POST.computeCapacityFit(fixture(), {});
  const t = POST.resolveLeverTarget(fit, BENCH);
  assert.strictEqual(t.goal_id, BENCH);
  assert.strictEqual(t.is_current_goal, true);
});

test("FIX 2: a resolved fit yields no target at all", () => {
  const p = fixture();
  p.capacity.hard_sessions_per_week = 3;
  const fit = POST.computeCapacityFit(p, {});
  assert.strictEqual(fit.fits, true);
  assert.strictEqual(POST.resolveLeverTarget(fit, SHOULDER), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 4 — a lever that cannot resolve is never offered
// ═════════════════════════════════════════════════════════════════════════════
test("FIX 4: slower/sequence on the SHOULDER goal provably cannot close a hard-session gap", () => {
  const p = fixture();
  const fit = POST.computeCapacityFit(p, {});
  const target = { goal_id: SHOULDER, title: "Full Shoulder Recovery", axis: "hard", is_current_goal: true,
    sessions_per_week: 4, minutes_per_session: 25, hard: false };
  ["slower", "sequence"].forEach((lever) => {
    const o = POST.projectLeverOutcome(p, fit, target, lever, {});
    assert.strictEqual(o.resolves, false, lever + " must not claim to resolve a gap it cannot touch");
    assert.ok(/hard session/.test(o.reason), lever + " reason must name the real blocker, got: " + o.reason);
  });
});

test("FIX 4: slower on the goal that OWNS the axis does resolve", () => {
  const p = fixture();
  const fit = POST.computeCapacityFit(p, {});
  const target = POST.resolveLeverTarget(fit, SHOULDER);
  const o = POST.projectLeverOutcome(p, fit, target, "slower", {});
  assert.strictEqual(o.resolves, true);
  assert.strictEqual(o.projected_frequency, 2, "bench 3 -> 2 hard sessions clears the cap of 2");
});

test("FIX 4: capacity always resolves, and code owns the required numbers", () => {
  const p = fixture();
  const fit = POST.computeCapacityFit(p, {});
  const o = POST.projectLeverOutcome(p, fit, POST.resolveLeverTarget(fit, SHOULDER), "capacity", {});
  assert.strictEqual(o.resolves, true);
  assert.strictEqual(o.delta.hard_from, 2);
  assert.strictEqual(o.delta.hard_to, 3, "the ACTUAL fix is one more hard slot, not one more day");
});

test("FIX 4: a lever already at min_viable reports that, rather than pretending to help", () => {
  const p = fixture();
  p.goals[0].demand.min_viable_sessions_per_week = 3;   // bench cannot go below 3
  const fit = POST.computeCapacityFit(p, {});
  const o = POST.projectLeverOutcome(p, fit, POST.resolveLeverTarget(fit, SHOULDER), "slower", {});
  assert.strictEqual(o.resolves, false);
  assert.ok(/minimum/.test(o.reason), "got: " + o.reason);
});

test("FIX 4: code-authored levers mark the unavailable ones and never make them tappable", () => {
  const p = fixture();
  const fit = POST.computeCapacityFit(p, {});
  const target = { goal_id: SHOULDER, title: "Full Shoulder Recovery", axis: "hard", is_current_goal: true,
    sessions_per_week: 4, minutes_per_session: 25, hard: false };
  const outcomes = POST.NEGOTIATION_LEVERS.map((l) => POST.projectLeverOutcome(p, fit, target, l, {}));
  const levers = POST.buildCodeAuthoredLevers(fit, target, outcomes, 1);
  // NOTE: assert.deepStrictEqual fails across vm realms (session #44 trap) —
  // compare a serialised form, never two arrays from different realms.
  assert.strictEqual(levers.map((l) => l.lever).join(","), "slower,capacity,sequence", "order is load-bearing");
  const by = {}; levers.forEach((l) => { by[l.lever] = l; });
  assert.strictEqual(by.slower.available, false);
  assert.strictEqual(by.sequence.available, false);
  assert.strictEqual(by.capacity.available, true);
  assert.ok(/Not available/.test(by.slower.detail));
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 3 — code owns every number in lever text
// ═════════════════════════════════════════════════════════════════════════════
test("FIX 3: the validator REJECTS the exact fabricated number observed live", () => {
  const p = fixture();
  const fit = POST.computeCapacityFit(p, {});
  const target = POST.resolveLeverTarget(fit, SHOULDER);
  const outcomes = POST.NEGOTIATION_LEVERS.map((l) => POST.projectLeverOutcome(p, fit, target, l, {}));
  const pack = POST.buildLeverFacts(fit, target, outcomes, p.goals[1], p);
  // Verbatim from the live 2026-07-28 reproduction, at model_levers_valid:true.
  const fabricated = [{ lever: "capacity", label: "Free Up More Days",
    detail: "You have 300 minutes across 5 days; adding 4x25 min of rehab needs 400 committed minutes." }];
  assert.strictEqual(POST.leverTextNumbersValid(fabricated, pack.allowed), false,
    "400 was never supplied — the whole set must be discarded");
});

test("FIX 3: text using only supplied numbers passes", () => {
  const p = fixture();
  const fit = POST.computeCapacityFit(p, {});
  const target = POST.resolveLeverTarget(fit, SHOULDER);
  const outcomes = POST.NEGOTIATION_LEVERS.map((l) => POST.projectLeverOutcome(p, fit, target, l, {}));
  const pack = POST.buildLeverFacts(fit, target, outcomes, p.goals[1], p);
  const ok = [{ lever: "capacity", label: "Make more room",
    detail: "You have 300 minutes across 5 days and 2 hard sessions; you need 3." }];
  assert.strictEqual(POST.leverTextNumbersValid(ok, pack.allowed), true);
});

test("FIX 3: numbers inside goal titles are allowed (185lb, 25m, 5k)", () => {
  const p = fixture();
  const fit = POST.computeCapacityFit(p, {});
  const target = POST.resolveLeverTarget(fit, SHOULDER);
  const outcomes = POST.NEGOTIATION_LEVERS.map((l) => POST.projectLeverOutcome(p, fit, target, l, {}));
  const pack = POST.buildLeverFacts(fit, target, outcomes, p.goals[1], p);
  assert.strictEqual(POST.leverTextNumbersValid(
    [{ lever: "slower", label: "x", detail: "Bench Press 185lb has to move." }], pack.allowed), true);
});

test("FIX 3: a fabricated number in the negotiate route falls back to code levers, not an error", async () => {
  reset(POST);
  POST.__ai = () => JSON.stringify({
    conflict_note: "You need 400 minutes.",
    options: [
      { lever: "slower", detail: "Drop to 9x/week." },
      { lever: "capacity", detail: "Add 12 more days." },
      { lever: "sequence", detail: "Hold at 8x." },
    ],
  });
  const r = await callNegotiate(POST, SHOULDER, {});
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.model_levers_valid, false);
  assert.strictEqual(r.body.options.length, 3);
  assert.ok(!/400/.test(JSON.stringify(r.body.options)), "fabricated prose must not reach the athlete");
  assert.ok(!/400/.test(r.body.conflict_note));
});

test("FIX 3 PRE-FIX: fabricated arithmetic sailed through at model_levers_valid:true", preOpts, async () => {
  reset(PRE);
  PRE.__ai = () => JSON.stringify({
    conflict_note: "note",
    options: [
      { lever: "slower", label: "a", detail: "needs 400 committed minutes" },
      { lever: "capacity", label: "b", detail: "b" },
      { lever: "sequence", label: "c", detail: "c" },
    ],
  });
  const r = await callNegotiate(PRE, SHOULDER, { round: 1 });
  assert.strictEqual(r.body.model_levers_valid, true, "pre-fix validated only lever KEYS");
  assert.ok(/400/.test(JSON.stringify(r.body.options)), "pre-fix: the fabricated number reached the athlete");
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 7 — the code-authored levers are the guaranteed floor
// ═════════════════════════════════════════════════════════════════════════════
test("FIX 7: an AI timeout still returns three honest levers, HTTP 200", async () => {
  reset(POST);
  POST.__ai = () => { throw new Error("AI call timed out after 18000ms"); };
  const r = await callNegotiate(POST, SHOULDER, {});
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.success, true);
  assert.strictEqual(r.body.model_levers_valid, false);
  assert.strictEqual(r.body.options.map((o) => o.lever).join(","), "slower,capacity,sequence");
  assert.ok(r.body.conflict_note.length > 0);
});

test("FIX 7: unparseable model output also falls through to code levers", async () => {
  reset(POST);
  POST.__ai = () => "I'm sorry, I can't help with that.";
  const r = await callNegotiate(POST, SHOULDER, {});
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.model_levers_valid, false);
  assert.strictEqual(r.body.options.length, 3);
});

test("FIX 7: a wrong-shape lever set falls through to code levers", async () => {
  reset(POST);
  POST.__ai = () => JSON.stringify({ conflict_note: "x", options: [{ lever: "drop_a_goal", detail: "d" }] });
  const r = await callNegotiate(POST, SHOULDER, {});
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.model_levers_valid, false);
  assert.strictEqual(r.body.options.map((o) => o.lever).join(","), "slower,capacity,sequence");
});

test("FIX 7: the negotiate AI call is bounded under Render's ~25s ceiling", async () => {
  reset(POST);
  POST.__ai = () => JSON.stringify({ conflict_note: "x", options: [] });
  await callNegotiate(POST, SHOULDER, {});
  assert.ok(POST.__lastAiTimeout > 0 && POST.__lastAiTimeout < 25000,
    "expected an explicit sub-25s timeout, got " + POST.__lastAiTimeout);
});

test("FIX 7 PRE-FIX: an AI failure 500'd the endpoint (the 'Could not load your options' card)", preOpts, async () => {
  reset(PRE);
  PRE.__ai = () => { throw new Error("AI call timed out after 60000ms"); };
  const r = await callNegotiate(PRE, SHOULDER, { round: 1 });
  assert.strictEqual(r.code, 500, "pre-fix: the code-authored fallback existed but was unreachable");
  assert.strictEqual(r.body.success, false);
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 8 — draft/commit: nothing is written until the week fits
// ═════════════════════════════════════════════════════════════════════════════
test("FIX 8: an unresolved lever leaves the goal's stored state BYTE-IDENTICAL", async () => {
  reset(POST);
  const before = JSON.stringify(fixture().goals[1]);
  const r = await callEstimate(POST, SHOULDER, {
    goal_type: "rehab", lever: "sequence",
    demand: { sessions_per_week: 3, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 },
    basis_note: "Starting at the minimum that still makes progress (3x/week).",
  });
  assert.strictEqual(r.body.committed, false);
  const g = savedGoal(POST, SHOULDER);
  const cmp = Object.assign({}, g);
  delete cmp.plan_draft; delete cmp.negotiation_round;
  assert.strictEqual(JSON.stringify(cmp), before, "goal_type/demand/estimate must be untouched");
  assert.ok(g.plan_draft, "the proposal is held as a draft instead");
  assert.strictEqual(g.negotiation_round, 1);
});

test("FIX 8: the false basis sentence is NEVER persisted after a discarded change", async () => {
  reset(POST);
  const r = await callEstimate(POST, SHOULDER, {
    goal_type: "rehab",
    demand: { sessions_per_week: 3, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 },
    basis_note: "Starting at the minimum that still makes progress (3x/week) while another goal leads.",
  });
  assert.strictEqual(r.body.dial_override_applied, true, "manual change discarded by the lock");
  const g = savedGoal(POST, SHOULDER);
  assert.ok(!/Starting at the minimum/.test(g.estimate.basis),
    "a note describing a change that did not happen must never reach the goal");
  assert.strictEqual(g.estimate.basis, "shoulder basis.", "estimate untouched entirely");
});

test("FIX 8 PRE-FIX: the discarded change still wrote a false basis onto the goal", preOpts, async () => {
  reset(PRE);
  const r = await callEstimate(PRE, SHOULDER, {
    goal_type: "rehab", lever: "sequence",
    demand: { sessions_per_week: 3, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 },
    basis_note: "Starting at the minimum that still makes progress (3x/week) while another goal leads.",
  });
  assert.strictEqual(r.body.dial_override_applied, true);
  const g = savedGoal(PRE, SHOULDER);
  assert.ok(/Starting at the minimum/.test(g.estimate.basis),
    "pre-fix: stored frequency stayed 4 while the basis claimed 3 — observed live on the sandbox");
  assert.strictEqual(g.estimate.assumed_frequency, 4);
});

test("FIX 8: a RESOLVING change commits, clears the draft and resets the round", async () => {
  reset(POST);
  // Two unresolved attempts first, so there is a round to reset.
  await callEstimate(POST, SHOULDER, { goal_type: "rehab", lever: "sequence",
    demand: { sessions_per_week: 3, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 } });
  POST.__profile = POST.__saved;
  assert.strictEqual(savedGoal(POST, SHOULDER).negotiation_round, 1);
  await callEstimate(POST, SHOULDER, { goal_type: "rehab", lever: "slower",
    demand: { sessions_per_week: 3, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 } });
  POST.__profile = POST.__saved;
  assert.strictEqual(savedGoal(POST, SHOULDER).negotiation_round, 2, "round counts levers actually applied");

  // Now resolve it by moving the goal that owns the axis.
  const r = await callEstimate(POST, BENCH, {
    goal_type: "strength_load", lever: "slower",
    demand: { sessions_per_week: 2, minutes_per_session: 45, hard: true, min_viable_sessions_per_week: 2 },
    basis_note: "Frequency lowered to 2x/week.",
    negotiating_goal_id: SHOULDER,
  });
  assert.strictEqual(r.body.committed, true);
  assert.strictEqual(r.body.fit.fits, true);
  const bench = savedGoal(POST, BENCH);
  assert.strictEqual(bench.demand.sessions_per_week, 2, "the target goal's demand is committed");
  assert.ok(/Frequency lowered to 2x\/week/.test(bench.estimate.basis), "basis_note lands only on commit");
  assert.strictEqual(bench.plan_draft, undefined);
  assert.strictEqual(savedGoal(POST, SHOULDER).negotiation_round, undefined,
    "resolution resets the round on the goal under negotiation, not just the one that moved");
});

test("FIX 8: plan-setup style drafts contribute ZERO to the capacity sum", () => {
  const p = fixture();
  delete p.goals[1].demand;                       // uncommitted goal
  p.goals[1].plan_draft = { goal_type: "rehab",
    demand: { sessions_per_week: 4, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 } };
  const fit = POST.computeCapacityFit(p, {});
  assert.strictEqual(fit.minutes_needed, 135, "only the committed bench goal counts");
  assert.ok(fit.excluded.some((e) => e.goal_id === SHOULDER && e.reason === "no_demand"));
});

test("FIX 8: the negotiate route still SEES the uncommitted goal, or the conflict would vanish", async () => {
  reset(POST);
  const p = fixture();
  delete p.goals[1].demand;
  p.goals[1].plan_draft = { goal_type: "rehab",
    demand: { sessions_per_week: 4, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 } };
  POST.__profile = p;
  POST.__ai = () => { throw new Error("no ai"); };
  const r = await callNegotiate(POST, SHOULDER, {});
  assert.strictEqual(r.body.fits, false);
  assert.strictEqual(r.body.fit.minutes_needed, 235, "the draft demand is injected as an override");
});

test("FIX 6/8: the negotiation judges the PENDING draft, not the old committed demand", async () => {
  // The roadmap-view stepper case: bench is COMMITTED at 2x (fits), and the
  // athlete has just asked for 3x, which is held as a draft. If /negotiate read
  // the committed value it would decide the week fits and never open the card —
  // fix 6 failing in exactly the scenario it exists for.
  const p = fixture();
  p.goals[0].demand.sessions_per_week = 2;                       // committed, fits
  p.goals[0].plan_draft = { goal_type: "strength_load",
    demand: { sessions_per_week: 3, minutes_per_session: 45, hard: true, min_viable_sessions_per_week: 2 } };
  reset(POST, p);
  assert.strictEqual(POST.computeCapacityFit(p, {}).fits, true, "the committed state fits — that is the trap");
  POST.__ai = () => { throw new Error("no ai"); };
  const r = await callNegotiate(POST, BENCH, {});
  assert.strictEqual(r.body.fits, false, "the pending 3x must be what is judged");
  assert.strictEqual(r.body.fit.hard_needed, 3);
  assert.strictEqual(r.body.target.goal_id, BENCH);
  assert.strictEqual(r.body.target.is_current_goal, true);
});

test("FIX 1: the dial lock still enforces against the COMMITTED value, not the draft", () => {
  // The mirror of the test above — the two accessors must not be collapsed.
  const g = { demand: { sessions_per_week: 4, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 },
    plan_draft: { demand: { sessions_per_week: 2, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 2 } } };
  assert.strictEqual(POST.goalBaselineDemand(g).sessions_per_week, 4, "lock baseline = committed");
  assert.strictEqual(POST.goalPendingDemand(g).sessions_per_week, 2, "fit check = pending draft");
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 5 — round state
// ═════════════════════════════════════════════════════════════════════════════
test("FIX 5: the round is read from storage and a plain re-render does not inflate it", async () => {
  reset(POST);
  POST.__ai = () => { throw new Error("no ai"); };
  const a = await callNegotiate(POST, SHOULDER, {});
  assert.strictEqual(a.body.levers_applied, 0);
  assert.strictEqual(a.body.round, 1);
  const b = await callNegotiate(POST, SHOULDER, {});
  assert.strictEqual(b.body.round, 1, "re-opening the card must not count as a round");
});

test("FIX 5: a client-supplied round is ignored (it used to be authoritative)", async () => {
  reset(POST);
  POST.__ai = () => { throw new Error("no ai"); };
  const r = await callNegotiate(POST, SHOULDER, { round: 9 });
  assert.strictEqual(r.body.round, 1, "the client can no longer inflate the narration");
});

test("FIX 5 PRE-FIX: the client's round number was taken at face value", preOpts, async () => {
  reset(PRE);
  PRE.__ai = () => { throw new Error("no ai"); };
  const r = await callNegotiate(PRE, SHOULDER, { round: 5 });
  // Pre-fix the AI failure 500s, so assert on the escalation input instead.
  assert.strictEqual(r.code, 500);
  reset(PRE);
  PRE.__ai = () => JSON.stringify({ conflict_note: "n",
    options: [{ lever: "slower", label: "a", detail: "d" }, { lever: "capacity", label: "b", detail: "d" }, { lever: "sequence", label: "c", detail: "d" }] });
  const r2 = await callNegotiate(PRE, SHOULDER, { round: 5 });
  assert.strictEqual(r2.body.round, 5, "pre-fix: whatever the client sent became the round");
});

// ═════════════════════════════════════════════════════════════════════════════
// THE 10-STEP SEQUENCE — must end RESOLVED through EACH lever independently
// ═════════════════════════════════════════════════════════════════════════════
async function replayToConflict(sb) {
  reset(sb);
  sb.__ai = () => { throw new Error("no ai — code levers"); };
  const neg = await callNegotiate(sb, SHOULDER, {});
  assert.strictEqual(neg.body.fits, false, "the observed conflict must reproduce");
  assert.strictEqual(neg.body.fit.hard_needed, 3);
  assert.strictEqual(neg.body.fit.hard_available, 2);
  assert.strictEqual(neg.body.target.goal_id, BENCH);
  return neg.body;
}

test("10-STEP REPLAY -> RESOLVED via the SLOWER lever", async () => {
  const neg = await replayToConflict(POST);
  const o = neg.outcomes.filter((x) => x.lever === "slower")[0];
  assert.strictEqual(o.resolves, true);
  POST.__ai = estimateAI(20, 40);
  const r = await callEstimate(POST, BENCH, {
    goal_type: "strength_load", lever: "slower", negotiating_goal_id: SHOULDER,
    demand: { sessions_per_week: o.projected_frequency, minutes_per_session: 45, hard: true, min_viable_sessions_per_week: 2 },
    basis_note: "Frequency lowered to 2x/week.",
  });
  assert.strictEqual(r.body.fit.fits, true, "RESOLVED");
  assert.strictEqual(r.body.committed, true);
});

test("10-STEP REPLAY -> RESOLVED via the SEQUENCE lever", async () => {
  const neg = await replayToConflict(POST);
  const o = neg.outcomes.filter((x) => x.lever === "sequence")[0];
  assert.strictEqual(o.resolves, true);
  POST.__ai = estimateAI(24, 52);
  const r = await callEstimate(POST, BENCH, {
    goal_type: "strength_load", lever: "sequence", negotiating_goal_id: SHOULDER,
    demand: { sessions_per_week: o.projected_frequency, minutes_per_session: 45, hard: true, min_viable_sessions_per_week: 2 },
    basis_note: "Held at the minimum while the other goal leads.",
  });
  assert.strictEqual(r.body.fit.fits, true, "RESOLVED");
  assert.strictEqual(r.body.committed, true);
});

test("10-STEP REPLAY -> RESOLVED via the CAPACITY lever", async () => {
  const neg = await replayToConflict(POST);
  const o = neg.outcomes.filter((x) => x.lever === "capacity")[0];
  assert.strictEqual(o.resolves, true);
  assert.strictEqual(o.required_capacity.hard_sessions_per_week, 3);
  POST.__ai = estimateAI(12, 24);
  const r = await callEstimate(POST, SHOULDER, {
    goal_type: "rehab", lever: "capacity",
    demand: { sessions_per_week: 4, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 },
    capacity: o.required_capacity,
  });
  assert.strictEqual(r.body.fit.fits, true, "RESOLVED");
  assert.strictEqual(r.body.committed, true);
  assert.strictEqual(r.body.capacity.hard_sessions_per_week, 3);
});

test("10-STEP REPLAY: the REHAB (locked) goal resolves through a lever too", async () => {
  // A conflict the rehab goal itself owns: make it hard, so lowering it resolves.
  const p = fixture();
  p.goals[0].demand.hard = false;                       // bench no longer hard
  p.goals[1].demand.hard = true;                        // shoulder owns the axis
  p.goals[1].demand.sessions_per_week = 4;
  p.goals[1].demand.min_viable_sessions_per_week = 2;   // sequence -> 2 clears the cap of 2
  reset(POST, p);
  POST.__ai = () => { throw new Error("no ai"); };
  const neg = await callNegotiate(POST, SHOULDER, {});
  assert.strictEqual(neg.body.fits, false);
  assert.strictEqual(neg.body.target.goal_id, SHOULDER);
  assert.strictEqual(neg.body.target.is_current_goal, true);
  const o = neg.body.outcomes.filter((x) => x.lever === "sequence")[0];
  assert.strictEqual(o.resolves, true, "sequence must be able to resolve on a LOCKED goal (fix 1)");
  POST.__ai = estimateAI(16, 36);
  const r = await callEstimate(POST, SHOULDER, {
    goal_type: "rehab", lever: "sequence",
    demand: { sessions_per_week: o.projected_frequency, minutes_per_session: 25, hard: true, min_viable_sessions_per_week: 3 },
    basis_note: "Held at its minimum.",
  });
  assert.strictEqual(r.body.dial_override_applied, false, "the lock must not eat a lever-driven decrease");
  assert.strictEqual(r.body.fit.fits, true, "RESOLVED on a dial-locked goal");
  assert.strictEqual(r.body.committed, true);
  assert.strictEqual(savedGoal(POST, SHOULDER).demand.sessions_per_week, 2,
    "the lever-driven decrease is what got stored on a dial-locked goal");
});

// ═════════════════════════════════════════════════════════════════════════════
// REGRESSION — capacity lever writing nothing without a stepper edit
// ═════════════════════════════════════════════════════════════════════════════
test("REGRESSION: re-posting IDENTICAL capacity changes nothing and does not resolve", async () => {
  reset(POST);
  POST.__ai = estimateAI(12, 24);
  const same = { days_per_week: 5, minutes_per_day: 60, hard_sessions_per_week: 2, protected_days: [] };
  const r = await callEstimate(POST, SHOULDER, {
    goal_type: "rehab",
    demand: { sessions_per_week: 4, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 },
    capacity: same,
  });
  assert.strictEqual(r.body.fit.fits, false, "an unedited capacity block cannot resolve anything");
  assert.strictEqual(r.body.fit.hard_available, 2);
  assert.strictEqual(r.body.committed, false);
  assert.strictEqual(JSON.stringify(r.body.capacity), JSON.stringify(same));
});

test("REGRESSION: raising DAYS alone does not fix a hard-session gap (the misdirection)", async () => {
  reset(POST);
  POST.__ai = estimateAI(12, 24);
  const r = await callEstimate(POST, SHOULDER, {
    goal_type: "rehab",
    demand: { sessions_per_week: 4, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 },
    capacity: { days_per_week: 6, minutes_per_day: 60, hard_sessions_per_week: 2, protected_days: [] },
  });
  assert.strictEqual(r.body.fit.fits, false, "'add a training day' was never the fix");
  assert.strictEqual(r.body.fit.hard_over, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// REGRESSION — step 6: the roadmap-view stepper corruption path
// ═════════════════════════════════════════════════════════════════════════════
test("STEP 6: a stepper change that does not fit no longer rewrites the stored goal", async () => {
  // Bench resolved to 2x/week with a roadmap built at 2x, exactly as step 5 left it.
  const p = fixture();
  p.goals[0].demand.sessions_per_week = 2;
  p.goals[0].estimate = { total_weeks_low: 20, total_weeks_high: 52, assumed_frequency: 2, basis: "built at 2x." };
  p.goals[0].roadmap = { estimate: { total_weeks_low: 20, total_weeks_high: 52, assumed_frequency: 2 }, phases: [{ type: "near_term" }] };
  reset(POST, p);
  const before = JSON.stringify(p.goals[0]);
  POST.__ai = estimateAI(12, 20);
  // The athlete taps "+" on the roadmap view: 2 -> 3.
  const r = await callEstimate(POST, BENCH, {
    goal_type: "strength_load",
    demand: { sessions_per_week: 3, minutes_per_session: 45, hard: true, min_viable_sessions_per_week: 2 },
  });
  assert.strictEqual(r.body.fit.fits, false, "3 hard vs a cap of 2 still does not fit");
  assert.strictEqual(r.body.committed, false);
  const g = savedGoal(POST, BENCH);
  const cmp = Object.assign({}, g); delete cmp.plan_draft; delete cmp.negotiation_round;
  assert.strictEqual(JSON.stringify(cmp), before,
    "the roadmap-view stepper must not silently rewrite demand/estimate when it does not fit");
  assert.strictEqual(g.demand.sessions_per_week, 2, "still 2x, matching the generated roadmap");
});

test("STEP 6 PRE-FIX: the stepper silently rewrote demand 2x -> 3x, orphaning the roadmap", preOpts, async () => {
  const p = fixture();
  p.goals[0].demand.sessions_per_week = 2;
  p.goals[0].estimate = { total_weeks_low: 20, total_weeks_high: 52, assumed_frequency: 2, basis: "built at 2x." };
  p.goals[0].roadmap = { estimate: { total_weeks_low: 20, total_weeks_high: 52, assumed_frequency: 2 }, phases: [{ type: "near_term" }] };
  reset(PRE, p);
  PRE.__ai = estimateAI(12, 20);
  const r = await callEstimate(PRE, BENCH, {
    goal_type: "strength_load",
    demand: { sessions_per_week: 3, minutes_per_session: 45, hard: true, min_viable_sessions_per_week: 2 },
  });
  assert.strictEqual(r.body.fit.fits, false);
  const g = savedGoal(PRE, BENCH);
  assert.strictEqual(g.demand.sessions_per_week, 3,
    "pre-fix: written anyway — this is what un-did step 5 and made step 7 claim 3 hard slots");
  assert.strictEqual(g.estimate.assumed_frequency, 3);
  assert.strictEqual(g.roadmap.estimate.assumed_frequency, 2, "roadmap left behind at 2x — the divergence measured live");
});

// ═════════════════════════════════════════════════════════════════════════════
// NON-REGRESSION — legacy / no-capacity goals
// ═════════════════════════════════════════════════════════════════════════════
test("NON-REGRESSION: a profile with NO capacity behaves identically pre vs post", preOpts, async () => {
  const noCap = { goals: [{ id: BENCH, title: "Bench Press 185lb", status: "IN PROGRESS", goal_type: "strength_load",
    demand: { sessions_per_week: 3, minutes_per_session: 45, hard: true, min_viable_sessions_per_week: 2 } }] };
  const body = { goal_type: "strength_load",
    demand: { sessions_per_week: 3, minutes_per_session: 45, hard: true, min_viable_sessions_per_week: 2 } };

  reset(POST, JSON.parse(JSON.stringify(noCap))); POST.__ai = estimateAI(12, 20);
  const a = await callEstimate(POST, BENCH, body);
  reset(PRE, JSON.parse(JSON.stringify(noCap))); PRE.__ai = estimateAI(12, 20);
  const b = await callEstimate(PRE, BENCH, body);

  assert.strictEqual(a.body.fit.has_capacity, false);
  assert.strictEqual(a.body.fit.fits, true, "no capacity => we cannot judge, so we never block");
  assert.strictEqual(JSON.stringify(a.body.estimate), JSON.stringify(b.body.estimate), "estimate identical pre vs post");
  assert.strictEqual(JSON.stringify(a.body.demand), JSON.stringify(b.body.demand), "demand identical pre vs post");
  assert.strictEqual(JSON.stringify(a.body.fit), JSON.stringify(b.body.fit), "fit identical pre vs post");
  assert.strictEqual(JSON.stringify(savedGoal(POST, BENCH)), JSON.stringify(savedGoal(PRE, BENCH)),
    "stored goal byte-identical pre vs post for a legacy/no-capacity goal");
});

test("NON-REGRESSION: a goal that fits on the first pass commits exactly as before", preOpts, async () => {
  const p = fixture();
  p.capacity.hard_sessions_per_week = 3;              // already fits
  const body = { goal_type: "rehab",
    demand: { sessions_per_week: 4, minutes_per_session: 25, hard: false, min_viable_sessions_per_week: 3 } };

  reset(POST, JSON.parse(JSON.stringify(p))); POST.__ai = estimateAI(12, 32);
  const a = await callEstimate(POST, SHOULDER, body);
  reset(PRE, JSON.parse(JSON.stringify(p))); PRE.__ai = estimateAI(12, 32);
  const b = await callEstimate(PRE, SHOULDER, body);

  assert.strictEqual(a.body.fit.fits, true);
  assert.strictEqual(a.body.committed, true);
  assert.strictEqual(JSON.stringify(savedGoal(POST, SHOULDER)), JSON.stringify(savedGoal(PRE, SHOULDER)),
    "the happy path is byte-identical pre vs post");
});

test("NON-REGRESSION: excluded statuses and no_demand goals are unchanged", () => {
  const p = fixture();
  p.goals[0].status = "PAUSED";
  const fit = POST.computeCapacityFit(p, {});
  assert.ok(fit.excluded.some((e) => e.goal_id === BENCH && e.reason === "status:PAUSED"));
  assert.ok(fit.excluded.some((e) => e.goal_id === FIVEK && e.reason === "no_demand"));
  assert.strictEqual(fit.hard_needed, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// CLIENT — the rendering half of fixes 4, 5 and 6
// ═════════════════════════════════════════════════════════════════════════════
function buildClientSandbox() {
  const parts = [
    slice(TREE_HTML, "index.html", "function grvEsc(", "\nfunction "),
    slice(TREE_HTML, "index.html", "function grvNegHostEl() {", "\nfunction grvStartNegotiation("),
    slice(TREE_HTML, "index.html", "function grvOfflineNegotiation(fit) {", "\nfunction grvRenderStep4("),
    slice(TREE_HTML, "index.html", "function grvRenderStep4() {", "\n// BOUNDED WRITES."),
  ];
  const SRC = parts.join("\n");
  const decls = (SRC.match(/^function\s+([A-Za-z0-9_$]+)/gm) || []).map((s) => s.split(/\s+/)[1]);
  assert.deepStrictEqual(decls.slice().sort(),
    ["grvEsc", "grvNegHostEl", "grvOfflineNegotiation", "grvRenderStep4"].sort(),
    "client extraction captured unexpected functions: " + decls.join(","));
  const host = { innerHTML: "" };
  // grvEsc escapes by round-tripping through a detached div's textContent, so the
  // sandbox needs a faithful stand-in for exactly that (& < > only — the same
  // characters a real textContent -> innerHTML round trip escapes).
  const mkDiv = () => ({
    _t: "",
    set textContent(v) { this._t = String(v == null ? "" : v); },
    get textContent() { return this._t; },
    get innerHTML() { return this._t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); },
  });
  const sandbox = {
    console,
    document: {
      getElementById: (id) => (id === "grv-negotiate-host" ? host : null),
      createElement: () => mkDiv(),
    },
    grvNegotiation: null,
    __host: host,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox;
}
const CLIENT = buildClientSandbox();

function renderStep4(neg) {
  CLIENT.grvNegotiation = neg;
  CLIENT.__host.innerHTML = "";
  CLIENT.grvRenderStep4();
  return CLIENT.__host.innerHTML;
}
const BASE_FIT = { minutes_needed: 235, minutes_available: 300, hard_needed: 3, hard_available: 2, hard_over: 1, minutes_over: 0, has_capacity: true };

test("CLIENT: the negotiation resolves a host in the ROADMAP view (fix 6)", () => {
  assert.strictEqual(CLIENT.grvNegHostEl(), CLIENT.__host,
    "with no #grv-personalize present it must fall back to #grv-negotiate-host");
});

test("CLIENT: renderGoalRoadmap emits the negotiation host", () => {
  assert.ok(TREE_HTML.indexOf("id=\"grv-negotiate-host\"") > 0,
    "the roadmap view must emit a container the negotiation can render into");
});

test("CLIENT: an unavailable lever renders non-tappable, with no onclick (fix 4)", () => {
  const html = renderStep4({
    fit: BASE_FIT, levers_applied: 0,
    target: { goal_id: BENCH, title: "Bench Press 185lb", axis: "hard", is_current_goal: false },
    conflict_note: "note",
    options: [
      { lever: "slower", available: false, label: "Go slower", detail: "Not available — still over by 1 hard session/week." },
      { lever: "capacity", available: true, label: "Make more room", detail: "Raise hard sessions from 2 to 3 per week." },
      { lever: "sequence", available: false, label: "Sequence them", detail: "Not available — still over by 1 hard session/week." },
    ],
  });
  const offBlocks = html.split("grv-lever-off").length - 1;
  assert.strictEqual(offBlocks, 2, "both unavailable levers render as disabled");
  assert.strictEqual(html.split("onclick=\"grvApplyLever").length - 1, 1, "only the resolving lever is tappable");
  assert.ok(/UNAVAILABLE/.test(html));
});

test("CLIENT: the athlete is told the gap belongs to a DIFFERENT goal (fix 2)", () => {
  const html = renderStep4({
    fit: BASE_FIT, levers_applied: 0,
    target: { goal_id: BENCH, title: "Bench Press 185lb", axis: "hard", is_current_goal: false },
    conflict_note: "note", options: [],
  });
  assert.ok(/belongs to <b>Bench Press 185lb<\/b>/.test(html), "must name the goal that actually owns the axis");
});

test("CLIENT: round copy is driven by the stored count, not a hardcoded 'once' (fix 5)", () => {
  const opts = [{ lever: "capacity", available: true, label: "Make more room", detail: "d" }];
  assert.ok(/only three ways/.test(renderStep4({ fit: BASE_FIT, levers_applied: 0, conflict_note: "", options: opts })));
  assert.ok(/one adjustment already/.test(renderStep4({ fit: BASE_FIT, levers_applied: 1, conflict_note: "", options: opts })));
  const three = renderStep4({ fit: BASE_FIT, levers_applied: 3, conflict_note: "", options: opts });
  assert.ok(/applied 3 adjustments already/.test(three), "got: " + three);
  assert.ok(!/once/.test(three), "the hardcoded 'once' is gone");
});

test("CLIENT: when nothing resolves, the copy says so honestly", () => {
  const html = renderStep4({
    fit: BASE_FIT, levers_applied: 2, conflict_note: "",
    options: [
      { lever: "slower", available: false, label: "a", detail: "d" },
      { lever: "capacity", available: false, label: "b", detail: "d" },
      { lever: "sequence", available: false, label: "c", detail: "d" },
    ],
  });
  assert.ok(/only thing that resolves this honestly/.test(html));
});

test("CLIENT: the offline floor derives every number from the server-computed fit", () => {
  const n = CLIENT.grvOfflineNegotiation(BASE_FIT);
  assert.ok(/over by 1 hard session a week/.test(n.conflict_note));
  assert.strictEqual(n.options.length, 3);
  assert.strictEqual(n.options.filter((o) => o.available).length, 1, "only capacity is safe to promise offline");
  assert.ok(!/could not load your options/i.test(JSON.stringify(n)));
});

test("CLIENT: the 'Could not load your options' dead-end is gone", () => {
  assert.ok(TREE_HTML.indexOf("Could not load your options") < 0,
    "the dead-end error path must not exist any more");
});
