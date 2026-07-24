"use strict";
/**
 * ENGINE v2 — TRAINING-STAGE EVALUATION TEST HARNESS (A1)
 * =======================================================
 * TEST FILE, NOT PRODUCTION CODE. Plain `node --test`, zero dependencies.
 *
 *   node --test server/v2Stages.test.js
 *
 * This is the "prove the brain before wiring it to the hands" gate for A1. The
 * resolver, the authoring validator and the effective-stage gate are all pure, so
 * every state can be proven against fixtures with no DB and no model call. In
 * particular the two states that real profile-4 data does NOT reliably produce —
 * a criterion that is UNEVALUABLE, and the insufficient_data-with-a-value case —
 * are covered here rather than left to chance.
 */

var test = require("node:test");
var assert = require("node:assert");
var rules = require("./coachingRules");
var v2s = require("./v2Stages");

// ── 1. ENVELOPE LOOKUP — every (stage, modality-family) pair ────────────────

test("envelopeFor: every (stage, modality-family) pair resolves with a full envelope", function () {
  rules.STAGES.forEach(function (stage) {
    rules.MODALITY_FAMILIES.forEach(function (fam) {
      var e = rules.envelopeFor(stage, fam);
      assert.ok(e, stage + "/" + fam + " must resolve");
      assert.strictEqual(e.stage, stage);
      assert.strictEqual(e.modality_family, fam);
      assert.ok(Array.isArray(e.prescribed_patterns) && e.prescribed_patterns.length > 0, stage + "/" + fam + " has prescribed patterns");
      assert.ok(typeof e.session_fill === "number" && e.session_fill > 0, stage + "/" + fam + " has a session_fill");
      // exactly one of working_sets / duration_band is populated
      var hasSets = Array.isArray(e.working_sets);
      var hasDur = Array.isArray(e.duration_band);
      assert.ok(hasSets !== hasDur, stage + "/" + fam + " has exactly one of working_sets/duration_band");
      assert.ok(e.intensity_band && e.rep_scheme && e.modality_mix, stage + "/" + fam + " has band/scheme/mix");
    });
  });
});

test("envelopeFor: unknown stage or family returns null", function () {
  assert.strictEqual(rules.envelopeFor("nope", "resistance"), null);
  assert.strictEqual(rules.envelopeFor("load", "nope"), null);
});

test("prescribedPatterns: ballistic is gated to power+ for resistance", function () {
  assert.ok(rules.prescribedPatterns("tissue_tolerance", "resistance").indexOf("ballistic") < 0);
  assert.ok(rules.prescribedPatterns("capacity", "resistance").indexOf("ballistic") < 0);
  assert.ok(rules.prescribedPatterns("load", "resistance").indexOf("ballistic") < 0);
  assert.ok(rules.prescribedPatterns("power", "resistance").indexOf("ballistic") >= 0);
  assert.ok(rules.prescribedPatterns("return_to_sport", "resistance").indexOf("ballistic") >= 0);
  // maintenance may hold any pattern it built, including ballistic
  assert.ok(rules.prescribedPatterns("maintenance", "resistance").indexOf("ballistic") >= 0);
});

test("prescribedPatterns: aerobic intervals gated to load+, sprints to power+", function () {
  assert.ok(rules.prescribedPatterns("capacity", "aerobic").indexOf("threshold") < 0);
  assert.ok(rules.prescribedPatterns("load", "aerobic").indexOf("threshold") >= 0);
  assert.ok(rules.prescribedPatterns("load", "aerobic").indexOf("sprint_interval") < 0);
  assert.ok(rules.prescribedPatterns("power", "aerobic").indexOf("sprint_interval") >= 0);
});

// ── 2. PATTERN CLASSIFIER ───────────────────────────────────────────────────

test("classifyPattern: profile-4 signal-rich six classify cleanly", function () {
  assert.strictEqual(v2s.classifyPattern("Dead Hang"), "isometric_hold");
  assert.strictEqual(v2s.classifyPattern("Wall Slide"), "activation");
  assert.strictEqual(v2s.classifyPattern("Dead Bug"), "core_brace");
  assert.strictEqual(v2s.classifyPattern("Glute Bridge"), "hip_bridge");
  assert.strictEqual(v2s.classifyPattern("Indoor Bike"), "steady_state");
  assert.strictEqual(v2s.classifyPattern("Cat-Cow"), "mobility_flow");
});

test("classifyPattern: rowing MACHINE (cardio) does not collide with a barbell row (pull)", function () {
  assert.strictEqual(v2s.classifyPattern("Rowing Machine"), "steady_state");
  assert.strictEqual(v2s.classifyPattern("Barbell Row"), "horizontal_pull");
});

test("classifyPattern: an unclassifiable name returns null (safe, never a false match)", function () {
  assert.strictEqual(v2s.classifyPattern("MMA Class"), null);
  assert.strictEqual(v2s.classifyPattern("Kickboxing"), null);
});

test("classifyPattern: modality/category fallback when no keyword matched", function () {
  assert.strictEqual(v2s.classifyPattern("Some Novel Hold", "strength", "isometric"), "isometric_hold");
  assert.strictEqual(v2s.classifyPattern("Some Novel Cardio", "cardio", "conditioning"), "steady_state");
  assert.strictEqual(v2s.classifyPattern("Some Novel Flow", "mind_body", null), "mobility_flow");
});

// ── 3. AUTHORING VALIDATION — both referent types ───────────────────────────

test("validateCriterion: valid pattern-type criterion inside the envelope", function () {
  var v = v2s.validateCriterion(
    { metric: "best_hold_seconds", comparator: "gte", threshold: 60, referent: { type: "pattern", value: "isometric_hold" } },
    "tissue_tolerance");
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.resolved.pattern, "isometric_hold");
  assert.strictEqual(v.resolved.family, "resistance");
  assert.strictEqual(v.resolved.forced_exercise, null);
});

test("validateCriterion: REJECT a pattern-type referent out of the envelope (ballistic @ capacity)", function () {
  var v = v2s.validateCriterion(
    { metric: "best_reps", comparator: "gte", threshold: 5, referent: { type: "pattern", value: "ballistic" } },
    "capacity");
  assert.strictEqual(v.valid, false);
  assert.ok(v.reasons.join(" ").indexOf("not prescribed at stage 'capacity'") >= 0);
});

test("validateCriterion: valid exercise-type criterion is forced into the prescribed set", function () {
  var v = v2s.validateCriterion(
    { metric: "best_reps", comparator: "gte", threshold: 12, referent: { type: "exercise", value: "Single-Leg Glute Bridge", pattern: "hip_bridge" } },
    "tissue_tolerance");
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.resolved.forced_exercise, "Single-Leg Glute Bridge");
});

test("validateCriterion: REJECT an exercise-type referent whose pattern is out of the envelope", function () {
  var v = v2s.validateCriterion(
    { metric: "best_reps", comparator: "gte", threshold: 3, referent: { type: "exercise", value: "Box Jump", pattern: "ballistic" } },
    "tissue_tolerance");
  assert.strictEqual(v.valid, false);
  assert.ok(v.reasons.join(" ").indexOf("not prescribed") >= 0);
});

test("validateCriterion: REJECT an exercise-type referent with no declared pattern", function () {
  var v = v2s.validateCriterion(
    { metric: "best_reps", comparator: "gte", threshold: 12, referent: { type: "exercise", value: "Mystery Move" } },
    "capacity");
  assert.strictEqual(v.valid, false);
  assert.ok(v.reasons.join(" ").indexOf("must declare `pattern`") >= 0);
});

test("validateCriterion: metric/comparator coherence is enforced", function () {
  // trend comparator with a value metric
  var a = v2s.validateCriterion({ metric: "best_reps", comparator: "trend_up", referent: { type: "pattern", value: "hip_bridge" } }, "capacity");
  assert.strictEqual(a.valid, false);
  // gte with no numeric threshold
  var b = v2s.validateCriterion({ metric: "best_reps", comparator: "gte", referent: { type: "pattern", value: "hip_bridge" } }, "capacity");
  assert.strictEqual(b.valid, false);
  // trend metric needs a trend comparator
  var c = v2s.validateCriterion({ metric: "trend", comparator: "gte", threshold: 1, referent: { type: "pattern", value: "hip_bridge" } }, "capacity");
  assert.strictEqual(c.valid, false);
});

test("validatePhaseCriteria: splits valid/invalid and collects forced exercises", function () {
  var split = v2s.validatePhaseCriteria([
    { metric: "best_hold_seconds", comparator: "gte", threshold: 60, referent: { type: "pattern", value: "isometric_hold" } },
    { metric: "best_reps", comparator: "gte", threshold: 12, referent: { type: "exercise", value: "Single-Leg Glute Bridge", pattern: "hip_bridge" } },
    { metric: "best_reps", comparator: "gte", threshold: 5, referent: { type: "pattern", value: "ballistic" } }, // out of envelope
  ], "tissue_tolerance");
  assert.strictEqual(split.valid_criteria.length, 2);
  assert.strictEqual(split.invalid_criteria.length, 1);
  assert.deepStrictEqual(split.forced_exercises, ["Single-Leg Glute Bridge"]);
});

// ── 4. THREE-STATE RESOLVER — every state, incl insufficient_data-with-value ─

var FIXTURE = {
  exercises: [
    { name: "Dead Hang", category: "strength", modality: "isometric", sessions_in_window: 5, insufficient_data: false, trend: "up",
      prs: { best_hold_seconds: 45, best_weight_lbs: null, best_reps: null, best_session_minutes: null } },
    { name: "Glute Bridge", category: "strength", modality: "dumbbell_machine_bodyweight", sessions_in_window: 2, insufficient_data: true, trend: "flat",
      prs: { best_hold_seconds: null, best_weight_lbs: null, best_reps: 12, best_session_minutes: null } },
    { name: "Indoor Bike", category: "cardio", modality: "conditioning", sessions_in_window: 4, insufficient_data: false, trend: "up",
      prs: { best_session_minutes: 30, best_hold_seconds: null, best_weight_lbs: null, best_reps: null } },
  ],
};
function resolve(c) { return v2s.resolveCriterion(c, FIXTURE); }

test("resolveCriterion: UNMET — value measured but short of threshold", function () {
  var r = resolve({ metric: "best_hold_seconds", comparator: "gte", threshold: 60, referent: { type: "pattern", value: "isometric_hold" } });
  assert.strictEqual(r.state, "UNMET");
  assert.strictEqual(r.observed, 45);
});

test("resolveCriterion: MET — value at/over threshold", function () {
  var r = resolve({ metric: "best_hold_seconds", comparator: "gte", threshold: 30, referent: { type: "pattern", value: "isometric_hold" } });
  assert.strictEqual(r.state, "MET");
});

test("resolveCriterion: UNEVALUABLE — pattern never logged (no data)", function () {
  var r = resolve({ metric: "best_reps", comparator: "gte", threshold: 10, referent: { type: "pattern", value: "vertical_pull" } });
  assert.strictEqual(r.state, "UNEVALUABLE");
  assert.ok(r.detail.indexOf("no data to measure") >= 0);
});

test("resolveCriterion: UNEVALUABLE — exercise-type referent never logged", function () {
  var r = resolve({ metric: "best_reps", comparator: "gte", threshold: 10, referent: { type: "exercise", value: "Weighted Pull-Up", pattern: "vertical_pull" } });
  assert.strictEqual(r.state, "UNEVALUABLE");
});

test("resolveCriterion: INSUFFICIENT_DATA WITH A VALUE — a THRESHOLD is still evaluable (the load-bearing case)", function () {
  // Glute Bridge has 2 sessions (insufficient_data true) but a best_reps of 12.
  // A value/threshold criterion MUST still resolve MET/UNMET off the point value.
  var met = resolve({ metric: "best_reps", comparator: "gte", threshold: 12, referent: { type: "pattern", value: "hip_bridge" } });
  assert.strictEqual(met.state, "MET");
  var unmet = resolve({ metric: "best_reps", comparator: "gte", threshold: 20, referent: { type: "pattern", value: "hip_bridge" } });
  assert.strictEqual(unmet.state, "UNMET");
});

test("resolveCriterion: INSUFFICIENT_DATA blocks a TREND criterion -> UNEVALUABLE", function () {
  var r = resolve({ metric: "trend", comparator: "trend_up", referent: { type: "pattern", value: "hip_bridge" } });
  assert.strictEqual(r.state, "UNEVALUABLE");
  assert.ok(r.detail.indexOf("resolve a trend") >= 0);
});

test("resolveCriterion: TREND resolvable and satisfied -> MET", function () {
  var r = resolve({ metric: "trend", comparator: "trend_up", referent: { type: "pattern", value: "isometric_hold" } });
  assert.strictEqual(r.state, "MET");
});

test("resolveCriterion: value metric matched but that PR never recorded -> UNEVALUABLE", function () {
  // isometric_hold matched (Dead Hang) but it has no best_weight_lbs ever.
  var r = resolve({ metric: "best_weight_lbs", comparator: "gte", threshold: 100, referent: { type: "pattern", value: "isometric_hold" } });
  assert.strictEqual(r.state, "UNEVALUABLE");
});

test("resolveCriterion: count metric is always evaluable once matched", function () {
  var r = resolve({ metric: "sessions_logged", comparator: "gte", threshold: 4, referent: { type: "pattern", value: "isometric_hold" } });
  assert.strictEqual(r.state, "MET");
  assert.strictEqual(r.observed, 5);
});

test("resolveCriterion: best_session_minutes resolves for a conditioning pattern", function () {
  var met = resolve({ metric: "best_session_minutes", comparator: "gte", threshold: 20, referent: { type: "pattern", value: "steady_state" } });
  assert.strictEqual(met.state, "MET");
  assert.strictEqual(met.observed, 30);
});

// ── 5. COLD-START FLOORS — keyed by TYPE not injury ─────────────────────────

test("coldStartStage: rehab-type goal floors at tissue_tolerance", function () {
  var r = rules.coldStartStage("Fix Pubic Osteitis (rehab)");
  assert.strictEqual(r.stage, "tissue_tolerance");
  assert.strictEqual(r.family, "resistance");
});

test("coldStartStage: hypertrophy-type goal floors at capacity", function () {
  var r = rules.coldStartStage("Build Muscle");
  assert.strictEqual(r.stage, "capacity");
  assert.strictEqual(r.family, "resistance");
});

test("coldStartStage: endurance/stamina goal floors at capacity/aerobic", function () {
  var r = rules.coldStartStage("Improve Stamina for hikes");
  assert.strictEqual(r.stage, "capacity");
  assert.strictEqual(r.family, "aerobic");
});

test("coldStartStage: posture/mobility goal floors at tissue_tolerance/skill_mobility", function () {
  var r = rules.coldStartStage("Fix Posture");
  assert.strictEqual(r.stage, "tissue_tolerance");
  assert.strictEqual(r.family, "skill_mobility");
});

test("coldStartStage: experienced returner -> load", function () {
  assert.strictEqual(rules.coldStartStage("anything", { experiencedReturner: true }).stage, "load");
  assert.strictEqual(rules.coldStartStage("Returning to lifting after a break").stage, "load");
});

test("coldStartStage: no clear signal -> lowest plausible general stage (capacity/resistance)", function () {
  var r = rules.coldStartStage("");
  assert.strictEqual(r.stage, "capacity");
  assert.strictEqual(r.family, "resistance");
});

// ── 6. EFFECTIVE-STAGE RESOLVER — holds/regresses, NEVER rises ──────────────

function gate(intended, states, dwell, safety, prior) {
  return v2s.resolveEffectiveStage({
    intended_stage: intended, prior_effective_stage: prior,
    criteria_states: states, gate_inputs: { dwell_met: dwell, safety: safety || {} },
  });
}

test("effective-stage: all MET + dwell + safe -> advance_ready, but effective stays PINNED (advancement disabled)", function () {
  var r = gate("capacity", [{ state: "MET" }, { state: "MET" }], true);
  assert.strictEqual(r.verdict, "advance_ready");
  assert.strictEqual(r.effective_stage, "capacity"); // did NOT rise to 'load'
  assert.strictEqual(r.advancement_enabled, false);
});

test("effective-stage: even with a higher intended and a lower prior, effective NEVER rises", function () {
  // calendar advanced intended to 'load' but prior effective is 'capacity'. In A1
  // the calendar cannot move effective — it holds at the prior.
  var r = gate("load", [{ state: "MET" }], true, {}, "capacity");
  assert.strictEqual(r.effective_stage, "capacity");
  assert.notStrictEqual(r.effective_stage, "load");
});

test("effective-stage: UNEVALUABLE gates like UNMET -> HOLD (never advance on absence)", function () {
  var r = gate("tissue_tolerance", [{ state: "MET" }, { state: "UNEVALUABLE" }], true);
  assert.strictEqual(r.verdict, "hold");
  assert.strictEqual(r.criteria_summary.unevaluable, 1);
});

test("effective-stage: UNMET -> HOLD", function () {
  assert.strictEqual(gate("capacity", [{ state: "MET" }, { state: "UNMET" }], true).verdict, "hold");
});

test("effective-stage: dwell not met -> HOLD even if all criteria MET", function () {
  assert.strictEqual(gate("capacity", [{ state: "MET" }], false).verdict, "hold");
});

test("effective-stage: zero criteria -> HOLD (nothing proven)", function () {
  var r = gate("capacity", [], true);
  assert.strictEqual(r.verdict, "hold");
  assert.ok(r.reasons.join(" ").indexOf("no exit criteria") >= 0);
});

test("effective-stage: safety veto -> REGRESS one rung down", function () {
  var r = gate("load", [{ state: "MET" }], true, { regress: true, reason: "pain trending up week over week" });
  assert.strictEqual(r.verdict, "regress");
  assert.strictEqual(r.effective_stage, "capacity");
});

test("effective-stage: regression floors at tissue_tolerance", function () {
  var r = gate("tissue_tolerance", [{ state: "MET" }], true, { regress: true, reason: "neurological symptoms" });
  assert.strictEqual(r.effective_stage, "tissue_tolerance");
});

test("effective-stage: a regress verdict NEVER coincides with a rise", function () {
  rules.STAGE_LADDER.forEach(function (st) {
    var r = gate(st, [{ state: "MET" }], true, { regress: true, reason: "x" });
    assert.ok(rules.stageIndex(r.effective_stage) <= rules.stageIndex(st) || r.effective_stage === "tissue_tolerance",
      st + " regress must not rise");
  });
});

// ── 7. clampAuthoredPhase — code-clamps a model-authored phase ──────────────

test("clampAuthoredPhase: an out-of-enum stage clamps to the cold-start default", function () {
  var out = v2s.clampAuthoredPhase({ intended_stage: "banana", modality_family: "resistance", exit_criteria: [] },
    { stage: "tissue_tolerance", family: "resistance" });
  assert.strictEqual(out.intended_stage, "tissue_tolerance");
  assert.strictEqual(out.clamped, true);
});

test("clampAuthoredPhase: valid criteria pass, invalid ones are separated", function () {
  var out = v2s.clampAuthoredPhase({
    intended_stage: "tissue_tolerance", modality_family: "resistance",
    exit_criteria: [
      { metric: "best_hold_seconds", comparator: "gte", threshold: 60, referent: { type: "pattern", value: "isometric_hold" } },
      { metric: "best_reps", comparator: "gte", threshold: 5, referent: { type: "pattern", value: "ballistic" } },
    ],
  }, { stage: "capacity", family: "resistance" });
  assert.strictEqual(out.valid_criteria.length, 1);
  assert.strictEqual(out.invalid_criteria.length, 1);
});

// ── 8. METRIC-FITS-PATTERN (A2 — folded A1 follow-up) ───────────────────────

test("metricFitsPattern: rejects a value metric the pattern's logged shape can never produce", function () {
  assert.strictEqual(rules.metricFitsPattern("best_hold_seconds", "vertical_pull").ok, false); // a pull-up is never a hold
  assert.strictEqual(rules.metricFitsPattern("best_weight_lbs", "steady_state").ok, false);     // a bike has no weight
  assert.strictEqual(rules.metricFitsPattern("best_session_minutes", "squat").ok, false);       // a squat is not timed
  assert.strictEqual(rules.metricFitsPattern("best_reps", "isometric_hold").ok, false);         // you do not rep a hold
});

test("metricFitsPattern: allows a plausible-but-not-yet-logged metric (data gap, not shape mismatch)", function () {
  // A hip thrust CAN be loaded — allow it even if only bodyweight bridges are logged so far.
  assert.strictEqual(rules.metricFitsPattern("best_weight_lbs", "hip_bridge").ok, true);
  assert.strictEqual(rules.metricFitsPattern("best_hold_seconds", "isometric_hold").ok, true);
});

test("metricFitsPattern: count and trend fit ANY pattern", function () {
  rules.MODALITY_FAMILIES.forEach(function () {}); // no-op guard
  Object.keys(rules.MOVEMENT_PATTERNS).forEach(function (tok) {
    assert.strictEqual(rules.metricFitsPattern("sessions_logged", tok).ok, true, "sessions_logged fits " + tok);
    assert.strictEqual(rules.metricFitsPattern("trend", tok).ok, true, "trend fits " + tok);
  });
});

test("validateCriterion: a metric/pattern SHAPE MISMATCH is rejected at authoring (the permanent-hold bug closed)", function () {
  // This is exactly the A1 live failure: hold-seconds on a rep-based pattern.
  var v = v2s.validateCriterion(
    { metric: "best_hold_seconds", comparator: "gte", threshold: 90, referent: { type: "pattern", value: "vertical_pull" } },
    "capacity");
  assert.strictEqual(v.valid, false);
  assert.ok(v.reasons.join(" ").indexOf("shape mismatch") >= 0);
});

test("validateCriterion: a plausible-but-unlogged metric still passes authoring (resolves UNEVALUABLE until logged, A2 fixes)", function () {
  var v = v2s.validateCriterion(
    { metric: "best_weight_lbs", comparator: "gte", threshold: 20, referent: { type: "pattern", value: "hip_bridge" } },
    "capacity");
  assert.strictEqual(v.valid, true);
});

test("every MOVEMENT_PATTERN has a PATTERN_VALUE_METRICS entry (no pattern is un-checkable)", function () {
  Object.keys(rules.MOVEMENT_PATTERNS).forEach(function (tok) {
    assert.ok(Array.isArray(rules.patternMetrics(tok)) && rules.patternMetrics(tok).length > 0, tok + " has value metrics");
  });
});

// ── 9. EFFECTIVE-STAGE ENVELOPE RENDER (A2) ─────────────────────────────────

test("renderEffectiveEnvelopesForPrompt: renders the stage it is GIVEN (the effective stage), not a higher one", function () {
  var block = rules.renderEffectiveEnvelopesForPrompt([
    { goal: "Build Muscle", tier: "driver", effective_stage: "capacity", modality_family: "resistance", week_pos: { weeks_elapsed: 1, floor_weeks: 8 } },
  ]);
  assert.ok(block.indexOf("current cleared stage: capacity") >= 0);
  assert.ok(block.indexOf("3-5 working sets") >= 0);      // capacity/resistance band
  assert.ok(block.indexOf("week 2 of ~8") >= 0);          // week position surfaced
  assert.ok(block.indexOf("load") < 0 || block.indexOf("load / power") >= 0); // does not silently escalate to a 'load' envelope
});

test("renderEffectiveEnvelopesForPrompt: a low-fill stage carries the honest-shorten rule, drivers sort first, empty in -> empty out", function () {
  assert.strictEqual(rules.renderEffectiveEnvelopesForPrompt([]), "");
  var block = rules.renderEffectiveEnvelopesForPrompt([
    { goal: "Fix Pubic Osteitis", tier: "maintenance", effective_stage: "tissue_tolerance", modality_family: "resistance", week_pos: { weeks_elapsed: 0, floor_weeks: 5 } },
    { goal: "Build Muscle", tier: "driver", effective_stage: "capacity", modality_family: "resistance", week_pos: { weeks_elapsed: 1, floor_weeks: 8 } },
  ]);
  // driver sorts before maintenance
  assert.ok(block.indexOf("Build Muscle") < block.indexOf("Fix Pubic Osteitis"));
  assert.ok(block.indexOf("HONESTLY SHORT") >= 0);
  assert.ok(block.indexOf("~22 min") >= 0); // tissue_tolerance/resistance fill
});

test("envelope render reflects the effective stage the gate produced (advancement disabled => never above intended)", function () {
  // A goal whose intended is 'load' but effective was HELD at 'capacity' must render
  // the capacity envelope, never load — the envelope draws from effective only.
  var eff = v2s.resolveEffectiveStage({
    intended_stage: "load", prior_effective_stage: "capacity",
    criteria_states: [{ state: "MET" }], gate_inputs: { dwell_met: true, safety: {} },
  });
  assert.strictEqual(eff.effective_stage, "capacity");
  var block = rules.renderEffectiveEnvelopesForPrompt([
    { goal: "G", tier: "driver", effective_stage: eff.effective_stage, modality_family: "resistance", week_pos: { weeks_elapsed: 3, floor_weeks: 6 } },
  ]);
  assert.ok(block.indexOf("current cleared stage: capacity") >= 0);
  assert.ok(block.indexOf("cleared stage: load") < 0);
});
