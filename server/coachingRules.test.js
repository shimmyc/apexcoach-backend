"use strict";
/**
 * ENGINE v2 — RULES MODULE TEST HARNESS
 * =====================================
 * TEST FILE, NOT PRODUCTION CODE. Plain `node --test`, zero dependencies.
 *
 *   node --test server/coachingRules.test.js
 *
 * WHY THIS EXISTS
 * ---------------
 * Running the Phase 2 audit against profile 4's real cloned history exercised
 * only 3 of the 5 gap-decay bands: `<10 days`, `4-6 weeks` and `>6 weeks` fired;
 * `10-14 days` and `2-3 weeks` NEVER EXECUTED against real data. Untested
 * branches in the module that decides how much load to take off a returning
 * athlete are exactly the wrong thing to ship on faith, and real data will not
 * cover them on any predictable schedule. Synthetic fixtures close them now.
 *
 * Covers: every gap-decay band boundary, every progressionDecision branch,
 * and the other pure decision functions.
 */

var test = require("node:test");
var assert = require("node:assert");
var r = require("./coachingRules");

// ── GAP DECAY — every band, including the two real data never reached ───────

test("gapDecay: <10 days band — no decay", function () {
  [0, 1, 5, 9].forEach(function (d) {
    var g = r.gapDecay(d);
    assert.strictEqual(g.band, "<10 days", "day " + d);
    assert.strictEqual(g.multiplier, 1.0, "day " + d + " multiplier");
    assert.strictEqual(g.per_exercise_stale, false);
  });
});

test("gapDecay: 10-14 days band — NEVER EXERCISED BY REAL DATA", function () {
  [10, 12, 14].forEach(function (d) {
    var g = r.gapDecay(d);
    assert.strictEqual(g.band, "10-14 days", "day " + d);
    assert.strictEqual(g.multiplier, 0.95, "day " + d + " multiplier");
    assert.strictEqual(g.evidence, "contested", "this band must stay marked contested");
    assert.ok(g.note && g.note.length > 0, "contested band must carry a note");
    assert.strictEqual(g.per_exercise_stale, false);
  });
});

test("gapDecay: 2-3 weeks band — NEVER EXERCISED BY REAL DATA", function () {
  [15, 20, 28].forEach(function (d) {
    var g = r.gapDecay(d);
    assert.strictEqual(g.band, "2-3 weeks", "day " + d);
    assert.strictEqual(g.multiplier, 0.925, "day " + d + " multiplier");
    assert.match(g.action, /5-10%/);
    assert.strictEqual(g.per_exercise_stale, false);
  });
});

test("gapDecay: 4-6 weeks band", function () {
  [29, 35, 42].forEach(function (d) {
    var g = r.gapDecay(d);
    assert.strictEqual(g.band, "4-6 weeks", "day " + d);
    assert.ok(g.multiplier <= 0.9, "day " + d + " should be at least -10%");
  });
});

test("gapDecay: >6 weeks band — conservative restart, NULL multiplier", function () {
  [43, 60, 400].forEach(function (d) {
    var g = r.gapDecay(d);
    assert.strictEqual(g.band, ">6 weeks", "day " + d);
    assert.strictEqual(g.multiplier, null, "a restart has no single multiplier");
    assert.match(g.action, /conservative restart/);
  });
});

test("gapDecay: band boundaries are exact and non-overlapping", function () {
  var boundaries = [
    [9, "<10 days"], [10, "10-14 days"],
    [14, "10-14 days"], [15, "2-3 weeks"],
    [28, "2-3 weeks"], [29, "4-6 weeks"],
    [42, "4-6 weeks"], [43, ">6 weeks"],
  ];
  boundaries.forEach(function (b) {
    assert.strictEqual(r.gapDecay(b[0]).band, b[1], "day " + b[0] + " -> " + b[1]);
  });
});

test("gapDecay: >30d per-exercise staleness caps the multiplier, never stacks", function () {
  var g35 = r.gapDecay(35);
  assert.strictEqual(g35.per_exercise_stale, true);
  // The 4-6 week band (0.85) is ALREADY more conservative than the -10% stale
  // floor, so the floor must not be applied on top of it.
  assert.strictEqual(g35.multiplier, 0.85, "must not double-count the same layoff");

  var g31 = r.gapDecay(31);
  assert.strictEqual(g31.per_exercise_stale, true);
  assert.strictEqual(g31.multiplier, 0.85,
    "31d sits in the 4-6wk band (0.85), which is already more conservative than the -10% stale floor");
});

test("gapDecay: the PER_EXERCISE_STALE floor is provably UNREACHABLE", function () {
  // Documenting a real finding rather than leaving it as silent dead code.
  // The floor only binds when a band multiplier is LOOSER than 0.90. Staleness
  // requires >30 days, and every band from 29 days up is already <= 0.85 (or
  // null). So the two conditions can never both hold: the floor is defensive
  // code that cannot currently fire. It is kept because it costs nothing and
  // would start mattering the moment the band thresholds are retuned — but it
  // must not be mistaken for an active rule.
  for (var d = 31; d <= 500; d++) {
    var g = r.gapDecay(d);
    if (g.multiplier === null) continue;          // >6 weeks: restart, no multiplier
    assert.ok(g.multiplier <= r.PER_EXERCISE_STALE_MULTIPLIER,
      "day " + d + ": band multiplier " + g.multiplier + " should already be at or below the stale floor");
  }
});

test("gapDecay: garbage input degrades to no-decay rather than throwing", function () {
  [null, undefined, NaN, -5, "abc"].forEach(function (v) {
    var g = r.gapDecay(v);
    assert.strictEqual(g.band, "<10 days", String(v));
    assert.strictEqual(g.multiplier, 1.0);
  });
});

// ── PROGRESSION DECISION — every branch ─────────────────────────────────────

test("progressionDecision: 'brutal' vetoes progression outright", function () {
  var d = r.progressionDecision({
    modality: "barbell", metPrescription: true, consecutiveMetSessions: 5,
    recentEfforts: ["brutal"], trend: "up", sessionsInWindow: 10,
  });
  assert.strictEqual(d.action, "hold", "brutal must beat every progression trigger");
  assert.match(d.reason, /brutal/);
});

test("progressionDecision: 2 consecutive 'more_in_tank' progresses", function () {
  var d = r.progressionDecision({
    modality: "barbell", metPrescription: false, consecutiveMetSessions: 0,
    recentEfforts: ["more_in_tank", "more_in_tank"], trend: "flat", sessionsInWindow: 5,
  });
  assert.strictEqual(d.action, "progress");
  assert.match(d.detail, /lb/);
});

test("progressionDecision: 1 'more_in_tank' is NOT enough", function () {
  var d = r.progressionDecision({
    modality: "barbell", metPrescription: false, consecutiveMetSessions: 0,
    recentEfforts: ["more_in_tank", "about_right"], trend: "flat", sessionsInWindow: 5,
  });
  assert.notStrictEqual(d.action, "progress");
});

test("progressionDecision: downward trend regresses", function () {
  var d = r.progressionDecision({
    modality: "dumbbell_machine_bodyweight", metPrescription: false,
    consecutiveMetSessions: 0, recentEfforts: [], trend: "down", sessionsInWindow: 6,
  });
  assert.strictEqual(d.action, "regress");
});

test("progressionDecision: met prescription 2x consecutively progresses", function () {
  var d = r.progressionDecision({
    modality: "isometric", metPrescription: true, consecutiveMetSessions: 2,
    recentEfforts: [], trend: "up", sessionsInWindow: 6,
  });
  assert.strictEqual(d.action, "progress");
  assert.match(d.detail, /s hold/);
});

test("progressionDecision: default is hold", function () {
  var d = r.progressionDecision({
    modality: "barbell", metPrescription: false, consecutiveMetSessions: 0,
    recentEfforts: [], trend: "flat", sessionsInWindow: 6,
  });
  assert.strictEqual(d.action, "hold");
});

test("progressionDecision: insufficient history is its OWN action, not hold", function () {
  var d = r.progressionDecision({
    modality: "dumbbell_machine_bodyweight", metPrescription: true,
    consecutiveMetSessions: 1, recentEfforts: [], trend: "flat", sessionsInWindow: 1,
  });
  assert.strictEqual(d.action, "establish_baseline",
    "'not enough history to know' must be distinguishable from 'deliberately holding load steady'");
  assert.notStrictEqual(d.action, "hold");
  assert.match(d.reason, /histor/i);
});

test("progressionDecision: insufficient history still yields to a 'brutal' report", function () {
  var d = r.progressionDecision({
    modality: "barbell", metPrescription: true, consecutiveMetSessions: 1,
    recentEfforts: ["brutal"], trend: "flat", sessionsInWindow: 1,
  });
  assert.strictEqual(d.action, "hold", "athlete-reported strain outranks a data-density rule");
});

test("progressionDecision: every modality yields a concrete increment", function () {
  ["barbell", "dumbbell_machine_bodyweight", "isometric", "conditioning"].forEach(function (m) {
    var d = r.progressionDecision({
      modality: m, metPrescription: true, consecutiveMetSessions: 2,
      recentEfforts: [], trend: "up", sessionsInWindow: 8,
    });
    assert.strictEqual(d.action, "progress", m);
    assert.ok(d.detail && d.detail.length > 3, m + " must state a real increment, not 'add more'");
    assert.doesNotMatch(d.detail, /add more/i, m);
  });
});

test("progressionDecision: unknown modality falls back without throwing", function () {
  var d = r.progressionDecision({
    modality: "nonsense", metPrescription: true, consecutiveMetSessions: 2,
    recentEfforts: [], trend: "up", sessionsInWindow: 8,
  });
  assert.ok(d.action);
});

// ── OTHER DECISION FUNCTIONS ────────────────────────────────────────────────

test("readinessModification: subjective state vetoes a green wearable score", function () {
  var d = r.readinessModification({ score: 95, personalBaseline: 60, subjectiveState: "feeling brutal today" });
  assert.strictEqual(d.tag, "reduced_intensity");
  assert.match(d.reason, /vetoes/);
});

test("readinessModification: 3 consecutive below-baseline days -> recovery", function () {
  var d = r.readinessModification({ score: 40, personalBaseline: 60, consecutiveBelowBaselineDays: 3 });
  assert.strictEqual(d.tag, "recovery");
});

test("readinessModification: a single low day modifies, never cancels", function () {
  var d = r.readinessModification({ score: 55, personalBaseline: 60, consecutiveBelowBaselineDays: 1 });
  assert.strictEqual(d.tag, "reduced_intensity");
  assert.doesNotMatch(d.action, /cancel/i);
});

test("readinessModification: at/above baseline proceeds", function () {
  var d = r.readinessModification({ score: 70, personalBaseline: 60, consecutiveBelowBaselineDays: 0 });
  assert.strictEqual(d.tag, "kept");
});

test("painCheck: neurological symptoms always redirect", function () {
  var d = r.painCheck({ painDuringOrAfter: 1, settlesByNextMorning: true, neurologicalSymptoms: true });
  assert.strictEqual(d.redirect, true);
  assert.strictEqual(d.ok, false);
});

test("painCheck: worsening week over week redirects", function () {
  var d = r.painCheck({ painDuringOrAfter: 3, settlesByNextMorning: true, trendingUpWeekOverWeek: true });
  assert.strictEqual(d.redirect, true);
});

test("painCheck: pain >5/10 regresses load but does NOT redirect", function () {
  var d = r.painCheck({ painDuringOrAfter: 7, settlesByNextMorning: true });
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.redirect, false);
  assert.match(d.action, /20%|substitute/);
});

test("painCheck: pain that does not settle by morning regresses", function () {
  var d = r.painCheck({ painDuringOrAfter: 3, settlesByNextMorning: false });
  assert.strictEqual(d.ok, false);
});

test("painCheck: within tolerance -> continue", function () {
  var d = r.painCheck({ painDuringOrAfter: 4, settlesByNextMorning: true, trendingUpWeekOverWeek: false });
  assert.strictEqual(d.ok, true);
});

test("painCheck: redirect language never names a diagnosis", function () {
  var d = r.painCheck({ painDuringOrAfter: 2, neurologicalSymptoms: true });
  assert.doesNotMatch(d.action, /tendinopathy|tear|strain|impingement|syndrome/i);
  assert.match(d.action, /physio|doctor/i);
});

test("deloadDecision: multi-day fatigue triggers", function () {
  var d = r.deloadDecision({ multiDayFatigue: true });
  assert.strictEqual(d.deload, true);
  assert.ok(d.shape);
});

test("deloadDecision: stalling WITH good recovery context triggers", function () {
  var d = r.deloadDecision({ stalledOrRegressedSessions: 3, adequateRecoveryContext: true });
  assert.strictEqual(d.deload, true);
});

test("deloadDecision: stalling with POOR recovery context does NOT deload", function () {
  var d = r.deloadDecision({ stalledOrRegressedSessions: 3, adequateRecoveryContext: false });
  assert.strictEqual(d.deload, false, "a deload does not fix a sleep debt");
  assert.match(d.reason, /sleep|recovery/i);
});

test("deloadDecision: shape cuts volume and HOLDS intensity", function () {
  var d = r.deloadDecision({ multiDayFatigue: true });
  assert.strictEqual(d.shape.intensity, "held");
  assert.ok(d.shape.volume_reduction_pct[0] >= 40);
});

test("timeCompressionPlan: never drops the primary compound or prehab", function () {
  var p = r.timeCompressionPlan(20, 60);
  assert.strictEqual(p.compress, true);
  assert.match(p.protect, /NEVER/);
  assert.strictEqual(p.steps[0], "drop tertiary accessories", "accessories go first");
});

test("timeCompressionPlan: no compression when time is sufficient", function () {
  assert.strictEqual(r.timeCompressionPlan(60, 45).compress, false);
  assert.strictEqual(r.timeCompressionPlan(45, 45).compress, false);
});

test("timeCompressionPlan: deeper deficit escalates further down the order", function () {
  assert.strictEqual(r.timeCompressionPlan(57, 60).steps.length, 1);
  assert.ok(r.timeCompressionPlan(30, 60).steps.length >= 3);
});

test("rotationPolicy: primaries are never rotated for novelty", function () {
  r.NOVELTY_PREFS.forEach(function (pref) {
    var p = r.rotationPolicy(pref, 3);
    assert.match(p.primaries, /fixed/i, pref);
  });
});

test("rotationPolicy: novelty preference drives accessory rotation", function () {
  assert.strictEqual(r.rotationPolicy("same", 4).mayRotateAccessoriesNow, false);
  assert.strictEqual(r.rotationPolicy("varied", 1).mayRotateAccessoriesNow, true);
  assert.strictEqual(r.rotationPolicy("mostly_same", 2).mayRotateAccessoriesNow, true);
  assert.strictEqual(r.rotationPolicy("mostly_same", 3).mayRotateAccessoriesNow, false);
});

test("rotationPolicy: unknown preference falls back to mostly_same", function () {
  assert.strictEqual(r.rotationPolicy("nonsense", 2).accessories, r.ROTATION.by_novelty_pref.mostly_same);
});

test("assessAccessoryCost: near-failure overlap with a driver always counts", function () {
  var a = r.assessAccessoryCost(5, true);
  assert.strictEqual(a.status, "counts", "5 minutes is short, but the overlap is what matters");
});

test("assessAccessoryCost: short bolt-ons are free", function () {
  assert.strictEqual(r.assessAccessoryCost(8, false).status, "free");
});

test("assessAccessoryCost: escalates flag -> counts with duration", function () {
  assert.strictEqual(r.assessAccessoryCost(18, false).status, "flag");
  assert.strictEqual(r.assessAccessoryCost(25, false).status, "counts");
});

// ── PROMPT RENDERING ────────────────────────────────────────────────────────

test("renderRulesForPrompt: renders all sections by default", function () {
  var txt = r.renderRulesForPrompt();
  assert.ok(txt.length > 3000);
  r.SECTION_ORDER.forEach(function (s) {
    assert.ok(r.rulesSectionLengths()[s] > 0, s + " must render something");
  });
});

test("renderRulesForPrompt: honours a section subset", function () {
  var txt = r.renderRulesForPrompt(["pain"]);
  assert.match(txt, /PAIN/);
  assert.doesNotMatch(txt, /VOLUME CAPS/);
});

test("renderRulesForPrompt: contested rules are MARKED as contested", function () {
  var txt = r.renderRulesForPrompt();
  assert.match(txt, /CONTESTED GUIDANCE/,
    "contested guidance must never render as settled fact");
  // The volume landmarks are the highest-risk contested claim — the model will
  // otherwise state MEV/MAV numbers to an athlete with full authority.
  var vol = r.renderRulesForPrompt(["volume"]);
  assert.match(vol, /CONTESTED GUIDANCE/);
});

test("renderRulesForPrompt: unknown section names are ignored, not fatal", function () {
  assert.doesNotThrow(function () { r.renderRulesForPrompt(["nope", "pain"]); });
});

test("evidence markers exist on every contested constant", function () {
  [r.VOLUME, r.MAT_LOAD, r.MAINTENANCE_MED.mobility, r.READINESS.hrv_sustained_low].forEach(function (o) {
    assert.strictEqual(o.evidence, "contested");
    assert.ok(o.note && o.note.length > 20, "a contested rule must explain WHY it is contested");
  });
});
