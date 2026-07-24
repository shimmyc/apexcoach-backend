"use strict";
/**
 * ENGINE v2 — TRAINING-STAGE EVALUATION (A1)
 * ==========================================
 * The EVALUATOR half of the phase-progression engine. coachingRules.js owns the
 * KNOWLEDGE (the stage ladder, the envelopes, the movement-pattern vocabulary,
 * the cold-start table); this module owns the INFERENCE and the DECISIONS built
 * on top of it:
 *
 *   - classifyPattern()        exercise name -> a movement-pattern token
 *   - validateCriterion()      authoring-time: is this exit criterion measurable
 *                              BY CONSTRUCTION against its phase's envelope?
 *   - resolveCriterion()       three-state: MET | UNMET | UNEVALUABLE
 *   - resolveEffectiveStage()  the pure gate — hold / advance_ready / regress,
 *                              with ADVANCEMENT DISABLED in A1
 *   - buildStageAuthoringPrompt()  the backfill authoring prompt (model-authored,
 *                                  code-clamped)
 *
 * DESIGN DECISIONS baked in here, per the A1 approval:
 *   - THREE STATES, never two. UNEVALUABLE (no data to measure) is distinct from
 *     UNMET (measured, short of target). Collapsing them is the permanent-HOLD
 *     bug the whole A1 scope exists to prevent.
 *   - TAGGED REFERENT: { type:"pattern"|"exercise", value, pattern? }. pattern is
 *     the default; exercise is allowed but must be forced into the envelope's
 *     prescribed set (validated the same way, via its declared pattern).
 *   - MEASURABLE BY CONSTRUCTION: a criterion is only valid if its referent's
 *     pattern is one the phase's (stage, modality-family) envelope prescribes.
 *   - REJECTED FALLBACKS (do not reintroduce): (a) advancing on dwell/adherence
 *     alone when criteria are unevaluable — that advances on absence of evidence;
 *     (b) re-authoring criteria against whatever the athlete happened to log —
 *     that lets avoidance redefine the target. Neither is implemented; both are
 *     recorded here so they are not re-proposed.
 *
 * v2-ONLY. Pure except where a `deps.callAISystem` is injected for the backfill.
 * No npm imports. No I/O of its own.
 */

var rules = require("./coachingRules");

var CRITERION_STATES = { MET: "MET", UNMET: "UNMET", UNEVALUABLE: "UNEVALUABLE" };

// ── Exercise name -> movement pattern ───────────────────────────────────────
// Keyword rules, ordered most-specific-first. Same shape and philosophy as
// inferModality()/inferWorkoutCategory(): a closed, auditable keyword map, NOT a
// prose parser. An unknown name returns null and therefore never matches a
// criterion — a miss is a safe "no data", never a false match.
//
// NOTE this is classification of a CANONICAL EXERCISE NAME (a closed-ish
// vocabulary the catalog already groups), which is tractable — unlike parsing a
// prose roadmap bullet, which the emphasis work correctly rejected as unfixable.

var PATTERN_RULES = [
  // --- skill / mobility (checked early: several names collide with resistance
  //     keywords, e.g. "glute bridge" vs a neck "bridge", "wall slide" vs "wall sit")
  { re: /\bcat[-\s]?cow\b|\bsun salutation\b|\byoga\b|\bmobility\b|\bflow\b|\barmbar\b(?=.*mobil)/i, pattern: "mobility_flow" },
  { re: /\bwall slide\b|\bband pull[-\s]?apart\b|\bclamshell\b|\bclam\b|\bmonster walk\b|\bscapular\b|\bchin tuck\b|\bactivation\b|\bglute activation\b|\bytwl\b|\bface[-\s]?down\b/i, pattern: "activation" },
  { re: /\bstretch\b|\bcouch stretch\b|\bhip flexor\b|\bpigeon\b|\bhamstring stretch\b/i, pattern: "end_range_hold" },
  { re: /\bbreath|\bdiaphragm|\b90\/90\b|\b90 90\b|\bbird[-\s]?dog\b(?=.*breath)/i, pattern: "breathing" },
  { re: /\bbalance\b|\bbosu\b|\bsingle[-\s]?leg (stand|balance)\b|\bstability\b/i, pattern: "balance_stability" },

  // --- core (anti-movement) ---
  { re: /\bdead ?bug\b|\bplank\b|\bpallof\b|\bhollow\b|\bbird[-\s]?dog\b|\banti[-\s]?rotation\b|\bside plank\b|\bab wheel\b|\bcrunch\b|\bsit[-\s]?up\b|\bleg raise\b|\bcopenhagen\b/i, pattern: "core_brace" },

  // --- isometric holds (grip/quad/shoulder isometrics) ---
  { re: /\bdead ?hang\b|\bbar hang\b|\bpassive hang\b|\bhang\b|\bwall sit\b|\bl[-\s]?sit\b|\bisometric\b|\bwall press\b/i, pattern: "isometric_hold" },

  // --- hip bridge ---
  { re: /\bglute bridge\b|\bhip thrust\b|\bbridge\b/i, pattern: "hip_bridge" },

  // --- ballistic / power (before squat/hinge so "power clean" isn't a hinge) ---
  { re: /\bbox jump\b|\bjump\b|\bplyo|\bbroad jump\b|\bhop\b|\bbound\b|\bthrow\b|\bslam\b|\bpower clean\b|\bhang clean\b|\bclean\b|\bsnatch\b|\bpush press\b(?=.*explos)/i, pattern: "ballistic" },

  // --- lower resistance ---
  { re: /\bdeadlift\b|\brdl\b|\bromanian\b|\bgood ?morning\b|\bhip hinge\b|\bkettlebell swing\b|\bkb swing\b|\bswing\b|\bhamstring curl\b|\bnordic\b/i, pattern: "hinge" },
  { re: /\bsquat\b|\bgoblet\b|\bpistol\b|\bleg press\b|\bhack squat\b|\bwall ball\b(?=.*squat)/i, pattern: "squat" },
  { re: /\blunge\b|\bsplit squat\b|\bbulgarian\b|\bstep[-\s]?up\b|\bstep up\b/i, pattern: "lunge" },
  { re: /\bcalf raise\b|\bcalf\b|\bsoleus\b|\bheel raise\b/i, pattern: "calf_raise" },

  // --- upper resistance ---
  { re: /\bpull[-\s]?up\b|\bpullup\b|\bchin[-\s]?up\b|\bchinup\b|\bpulldown\b|\blat pulldown\b/i, pattern: "vertical_pull" },
  { re: /\browing\b|\brow erg\b|\berg\b|\bski erg\b/i, pattern: "steady_state" }, // rowing MACHINE (cardio) before the pulling "row"
  { re: /\brow\b|\binverted row\b|\bface pull\b|\bseal row\b|\brear delt\b/i, pattern: "horizontal_pull" },
  { re: /\boverhead press\b|\bohp\b|\bshoulder press\b|\bmilitary press\b|\bpike push\b|\bpike press\b|\bhandstand\b/i, pattern: "vertical_push" },
  { re: /\bbench\b|\bpush[-\s]?up\b|\bpushup\b|\bchest press\b|\bfloor press\b|\bdip\b|\bdips\b|\bchest fly\b/i, pattern: "horizontal_push" },
  { re: /\bcarry\b|\bfarmer|\bsuitcase\b|\bwaiter\b|\brack walk\b/i, pattern: "carry" },
  { re: /\bcurl\b|\bbicep\b|\btricep\b|\bpushdown\b|\bskull ?crusher\b|\bextension\b(?=.*(tricep|arm))|\bkickback\b/i, pattern: "direct_arm" },

  // --- aerobic ---
  { re: /\bsprint\b|\bhiit\b(?=.*sprint)|\bvo2\b|\bassault bike\b(?=.*sprint)/i, pattern: "sprint_interval" },
  { re: /\bthreshold\b|\btempo run\b|\btempo\b/i, pattern: "tempo" },
  { re: /\binterval\b/i, pattern: "aerobic_interval" },
  { re: /\blong run\b|\blsd\b|\blong slow\b|\bdistance run\b/i, pattern: "long_duration" },
  { re: /\bbike\b|\bcycl|\bspin\b|\belliptical\b|\btreadmill\b|\bwalk\b|\bjog\b|\brun\b|\bswim\b|\bhike\b|\bstair|\bstepper\b|\bcardio\b/i, pattern: "steady_state" },
];

// Category / modality fallbacks when no keyword matched.
var CATEGORY_PATTERN_FALLBACK = {
  cardio: "steady_state",
  mind_body: "mobility_flow",
  rehab: "activation",
};

/**
 * @param {string} name       canonical exercise name
 * @param {string} [category] main_category (cardio/strength/mind_body/rehab/...)
 * @param {string} [modality] inferModality() output (isometric/conditioning/...)
 * @returns {string|null} a MOVEMENT_PATTERNS token, or null when unclassifiable
 */
function classifyPattern(name, category, modality) {
  var n = String(name || "");
  for (var i = 0; i < PATTERN_RULES.length; i++) {
    if (PATTERN_RULES[i].re.test(n)) return PATTERN_RULES[i].pattern;
  }
  // Data-shape / modality hint before the coarse category fallback.
  if (modality === "isometric") return "isometric_hold";
  if (modality === "conditioning") return "steady_state";
  var cat = String(category || "").toLowerCase();
  if (CATEGORY_PATTERN_FALLBACK[cat]) return CATEGORY_PATTERN_FALLBACK[cat];
  return null; // unknown -> never matches a criterion (safe)
}

// ── Name normalisation (for type:"exercise" referent matching) ──────────────
function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ── Criterion schema + authoring validation ─────────────────────────────────

/** Resolve the movement-pattern a criterion is measured against. */
function criterionPattern(criterion) {
  var ref = criterion && criterion.referent;
  if (!ref) return null;
  if (ref.type === "pattern") return ref.value || null;
  if (ref.type === "exercise") return ref.pattern || null;
  return null;
}

/**
 * Authoring-time validation. A criterion is VALID only if it is measurable by
 * construction against its phase's (intendedStage, modality-family) envelope.
 *
 * @param {object} criterion
 * @param {string} intendedStage  the phase's stage
 * @returns {{valid:boolean, reasons:string[], resolved:object|null}}
 *   resolved = { pattern, family, envelope, forced_exercise? } when valid
 */
function validateCriterion(criterion, intendedStage) {
  var reasons = [];
  var c = criterion || {};
  var ref = c.referent;

  if (!rules.isStage(intendedStage)) {
    return { valid: false, reasons: ["phase intended_stage '" + intendedStage + "' is not a known stage"], resolved: null };
  }
  if (!ref || (ref.type !== "pattern" && ref.type !== "exercise")) {
    return { valid: false, reasons: ["referent.type must be 'pattern' or 'exercise'"], resolved: null };
  }
  if (!ref.value || typeof ref.value !== "string" || !ref.value.trim()) {
    reasons.push("referent.value is required and must be a non-empty string");
  }

  var pat = criterionPattern(c);
  if (ref.type === "exercise" && !ref.pattern) {
    reasons.push("an exercise-type referent must declare `pattern` (the movement pattern it trains) so it can be forced into the envelope");
  }
  if (!pat || !rules.isMovementPattern(pat)) {
    reasons.push("referent pattern '" + (pat || "(none)") + "' is not in the movement-pattern vocabulary");
    return { valid: false, reasons: reasons, resolved: null };
  }

  var family = rules.patternFamily(pat);
  var envelope = rules.envelopeFor(intendedStage, family);
  if (!envelope) {
    reasons.push("no envelope for (" + intendedStage + ", " + family + ")");
    return { valid: false, reasons: reasons, resolved: null };
  }
  // THE measurability-by-construction check (both referent types go through it).
  if (envelope.prescribed_patterns.indexOf(pat) < 0) {
    var mn = rules.MOVEMENT_PATTERNS[pat].min_stage;
    reasons.push("pattern '" + pat + "' is not prescribed at stage '" + intendedStage + "' (it needs stage '" + mn +
      "'+); the criterion is not measurable by construction and must be re-authored against a prescribed pattern");
  }

  // metric / comparator / threshold coherence
  if (!rules.isCriterionMetric(c.metric)) {
    reasons.push("metric '" + c.metric + "' is not a known criterion metric");
  } else {
    var m = rules.CRITERION_METRICS[c.metric];
    if (!rules.isCriterionComparator(c.comparator)) {
      reasons.push("comparator '" + c.comparator + "' is not a known comparator");
    } else {
      var isTrendCmp = c.comparator === "trend_up" || c.comparator === "trend_flat_or_up";
      if (m.kind === "trend" && !isTrendCmp) reasons.push("metric 'trend' requires a trend comparator (trend_up / trend_flat_or_up)");
      if (m.kind !== "trend" && isTrendCmp) reasons.push("a trend comparator cannot be used with a value/count metric");
      if (!isTrendCmp && (typeof c.threshold !== "number" || !isFinite(c.threshold))) {
        reasons.push("comparator '" + c.comparator + "' requires a numeric threshold");
      }
    }
    // METRIC-FITS-PATTERN (A2). A value metric the referent pattern's logged shape
    // can never produce is a permanent-hold bug — reject it at authoring, exactly
    // like an out-of-envelope referent. count/trend fit any pattern and pass.
    var fit = rules.metricFitsPattern(c.metric, pat);
    if (!fit.ok) reasons.push(fit.reason);
  }

  var valid = reasons.length === 0;
  return {
    valid: valid,
    reasons: reasons,
    resolved: valid ? {
      pattern: pat,
      family: family,
      envelope: envelope,
      forced_exercise: ref.type === "exercise" ? ref.value : null,
    } : null,
  };
}

/**
 * Validate every criterion on a phase. Returns the split plus, for the
 * exercise-type valid ones, the list of exercises to FORCE into the envelope's
 * prescribed set (A2 consumes this; A1 only records it).
 */
function validatePhaseCriteria(criteria, intendedStage) {
  var valid = [], invalid = [], forced = [];
  (Array.isArray(criteria) ? criteria : []).forEach(function (c) {
    var v = validateCriterion(c, intendedStage);
    if (v.valid) {
      valid.push(c);
      if (v.resolved.forced_exercise) forced.push(v.resolved.forced_exercise);
    } else {
      invalid.push({ criterion: c, reasons: v.reasons });
    }
  });
  return { valid_criteria: valid, invalid_criteria: invalid, forced_exercises: forced };
}

// ── Three-state resolution against progression state ────────────────────────

/** Exercises in the progression state that the criterion's referent points at. */
function referentMatches(criterion, progressionState) {
  var exs = (progressionState && progressionState.exercises) || [];
  var ref = criterion.referent || {};
  if (ref.type === "exercise") {
    var want = normName(ref.value);
    return exs.filter(function (e) { return normName(e.name) === want; });
  }
  // pattern
  var pat = ref.value;
  return exs.filter(function (e) { return classifyPattern(e.name, e.category, e.modality) === pat; });
}

function prFieldValue(ex, field) {
  var v = ex && ex.prs ? ex.prs[field] : null;
  return (v === null || v === undefined) ? null : Number(v);
}

/**
 * Resolve a single criterion to MET | UNMET | UNEVALUABLE against a progression
 * state. This is where the three-state discipline lives.
 *
 * @returns {{state:string, detail:string, observed:(number|string|null),
 *            threshold:(number|null), matches:string[], metric:string}}
 */
function resolveCriterion(criterion, progressionState) {
  var out = {
    id: criterion && criterion.id || null,
    metric: criterion && criterion.metric || null,
    comparator: criterion && criterion.comparator || null,
    threshold: (typeof criterion.threshold === "number") ? criterion.threshold : null,
    state: CRITERION_STATES.UNEVALUABLE,
    detail: "",
    observed: null,
    matches: [],
    referent: criterion.referent || null,
  };

  var mdef = rules.CRITERION_METRICS[criterion.metric];
  if (!mdef) { out.detail = "unknown metric"; return out; }

  var matches = referentMatches(criterion, progressionState);
  out.matches = matches.map(function (e) { return e.name; });

  if (!matches.length) {
    out.state = CRITERION_STATES.UNEVALUABLE;
    out.detail = criterion.referent && criterion.referent.type === "exercise"
      ? "'" + criterion.referent.value + "' has not been logged in the window — no data to measure"
      : "no logged exercise trains pattern '" + (criterion.referent && criterion.referent.value) + "' — no data to measure";
    return out;
  }

  // COUNT metric — always evaluable once there is >=1 match.
  if (mdef.kind === "count") {
    var totalSessions = matches.reduce(function (a, e) { return a + (Number(e.sessions_in_window) || 0); }, 0);
    out.observed = totalSessions;
    out.state = compareValue(totalSessions, criterion.comparator, out.threshold) ? CRITERION_STATES.MET : CRITERION_STATES.UNMET;
    out.detail = "sessions logged = " + totalSessions + " (" + criterion.comparator + " " + out.threshold + ")";
    return out;
  }

  // VALUE metric — a single logged instance yields a point value. insufficient_data
  // does NOT block a threshold: the athlete has a measured best; it just is not yet
  // a resolvable TREND. This is the load-bearing distinction from UNEVALUABLE.
  if (mdef.kind === "value") {
    var best = null;
    matches.forEach(function (e) {
      var v = prFieldValue(e, mdef.pr_field);
      if (v !== null && (best === null || v > best)) best = v;
    });
    if (best === null) {
      out.state = CRITERION_STATES.UNEVALUABLE;
      out.detail = "matching exercise(s) logged, but '" + criterion.metric + "' was never recorded for them — no data to measure";
      return out;
    }
    out.observed = best;
    out.state = compareValue(best, criterion.comparator, out.threshold) ? CRITERION_STATES.MET : CRITERION_STATES.UNMET;
    out.detail = "best " + criterion.metric + " = " + best + " " + (mdef.unit || "") + " (" + criterion.comparator + " " + out.threshold + ")";
    return out;
  }

  // TREND metric — requires a RESOLVABLE trend. If every match has
  // insufficient_data (<3 sessions), the trend cannot be measured -> UNEVALUABLE.
  if (mdef.kind === "trend") {
    var resolvable = matches.filter(function (e) { return !e.insufficient_data && e.trend; });
    if (!resolvable.length) {
      out.state = CRITERION_STATES.UNEVALUABLE;
      out.detail = "matching exercise(s) logged, but none has enough sessions to resolve a trend (< " +
        rules.MIN_SESSIONS_FOR_SIGNAL + " each) — no trend to measure";
      return out;
    }
    var wantUp = criterion.comparator === "trend_up";
    var ok = resolvable.some(function (e) {
      return wantUp ? e.trend === "up" : (e.trend === "up" || e.trend === "flat");
    });
    out.observed = resolvable.map(function (e) { return e.name + ":" + e.trend; }).join(", ");
    out.state = ok ? CRITERION_STATES.MET : CRITERION_STATES.UNMET;
    out.detail = "trend = [" + out.observed + "] (" + criterion.comparator + ")";
    return out;
  }

  out.detail = "unhandled metric kind";
  return out;
}

function compareValue(observed, comparator, threshold) {
  if (typeof threshold !== "number") return false;
  if (comparator === "gte") return observed >= threshold;
  if (comparator === "lte") return observed <= threshold;
  if (comparator === "eq") return observed === threshold;
  return false;
}

// ── Effective-stage resolver (the gate) ─────────────────────────────────────

/**
 * The pure gate. ADVANCEMENT IS DISABLED in A1: `effective_stage` never rises. It
 * pins to the calendar/intended stage on first run (prior_effective_stage null),
 * and thereafter can only HOLD or REGRESS. A computed `advance_ready` verdict is
 * REPORTED but NOT applied (that is Phase B).
 *
 * @param {object} o
 * @param {string} o.intended_stage
 * @param {string} [o.prior_effective_stage]  persisted effective stage, if any (B)
 * @param {Array}  o.criteria_states  results from resolveCriterion()
 * @param {object} o.gate_inputs      { dwell_met:bool, safety:{ regress:bool, reason?:string } }
 * @returns {{intended_stage, effective_stage, verdict, criteria_summary, gate_inputs, reasons}}
 */
function resolveEffectiveStage(o) {
  o = o || {};
  var intended = o.intended_stage;
  var states = Array.isArray(o.criteria_states) ? o.criteria_states : [];
  var gate = o.gate_inputs || {};
  var safety = gate.safety || {};

  var counts = { MET: 0, UNMET: 0, UNEVALUABLE: 0 };
  states.forEach(function (s) { if (counts[s.state] !== undefined) counts[s.state]++; });
  var total = states.length;

  // First-run pin: effective = intended. Advancement disabled means effective can
  // never exceed the pinned baseline. A persisted prior (Phase B) would cap it.
  var base = rules.isStage(o.prior_effective_stage) ? o.prior_effective_stage : intended;
  var reasons = [];
  var verdict, effective;

  if (safety.regress) {
    verdict = "regress";
    effective = rules.stageBelow(base);
    reasons.push("SAFETY REGRESSION: " + (safety.reason || "a safety veto fired") + " — dropped " + base + " -> " + effective);
  } else {
    // ADVANCE-READY requires: dwell met AND safety clear AND every criterion MET,
    // with at least one criterion. UNEVALUABLE gates exactly like UNMET for the
    // advance decision — advancing on absence of evidence is forbidden.
    var allMet = total > 0 && counts.MET === total;
    if (gate.dwell_met && allMet) {
      verdict = "advance_ready";
      effective = base; // DISABLED: report readiness, do not raise the stage
      reasons.push("all " + total + " criteria MET, dwell met, safety clear — ADVANCE-READY (advancement disabled in A1: effective stage held at " + base + ")");
    } else {
      verdict = "hold";
      effective = base;
      if (total === 0) reasons.push("HOLD: no exit criteria authored — nothing proven, so advancement is impossible (never advance on absence of evidence)");
      if (counts.UNEVALUABLE > 0) reasons.push("HOLD: " + counts.UNEVALUABLE + " criterion/criteria UNEVALUABLE — the plan is not yet generating the evidence they need; re-author or check the envelope prescribes the movement (never advance on absence)");
      if (counts.UNMET > 0) reasons.push("HOLD: " + counts.UNMET + " criterion/criteria UNMET — still working the phase");
      if (!gate.dwell_met) reasons.push("HOLD: dwell floor not yet met");
    }
  }

  return {
    intended_stage: intended,
    effective_stage: effective,
    verdict: verdict,
    advancement_enabled: false,
    criteria_summary: { total: total, met: counts.MET, unmet: counts.UNMET, unevaluable: counts.UNEVALUABLE },
    gate_inputs: { dwell_met: !!gate.dwell_met, safety: safety },
    reasons: reasons,
  };
}

// ── Backfill authoring prompt (model-authored, code-clamped) ────────────────

/**
 * Build the prompt that asks the model to (1) map each existing roadmap phase to
 * an intended_stage from the enum, and (2) author structured, measurable-by-
 * construction exit_criteria for each phase. The output is validated by
 * validateCriterion(); invalid criteria are regenerated within the caller's
 * existing attempt cap, then dropped-and-flagged.
 *
 * @param {object} goal   { title, type?, roadmap:{phases:[...]} }
 * @param {object} [opts] { coldStart?:{stage,family,basis}, retryNote?:string }
 * @returns {{system:string, user:string}}
 */
function buildStageAuthoringPrompt(goal, opts) {
  opts = opts || {};
  var patternsByFamily = {};
  rules.MODALITY_FAMILIES.forEach(function (f) { patternsByFamily[f] = []; });
  Object.keys(rules.MOVEMENT_PATTERNS).forEach(function (tok) {
    var p = rules.MOVEMENT_PATTERNS[tok];
    patternsByFamily[p.family].push(tok + " (from " + p.min_stage + ")");
  });

  var system =
    "You assign each phase of an athlete's goal roadmap to a TRAINING STAGE and author its EXIT CRITERIA.\n\n" +
    "STAGES (low to high): " + rules.STAGE_LADDER.join(" -> ") + ", plus 'maintenance' (a parallel track).\n" +
    "MODALITY FAMILIES: " + rules.MODALITY_FAMILIES.join(", ") + ".\n\n" +
    rules.renderStageEnvelopesForPrompt() + "\n\n" +
    "MOVEMENT-PATTERN VOCABULARY (a criterion's referent must use one of these; the tag in parentheses is the earliest stage that prescribes it):\n" +
    rules.MODALITY_FAMILIES.map(function (f) { return "  " + f + ": " + patternsByFamily[f].join(", "); }).join("\n") + "\n\n" +
    "EXIT-CRITERIA RULES — measurable by construction, NON-NEGOTIABLE:\n" +
    "- A criterion is an objective, machine-checkable gate that proves the phase's work was DONE, evaluated against the athlete's logged training.\n" +
    "- referent is a TAGGED UNION. PREFER type 'pattern':\n" +
    '    { "type":"pattern", "value":"<one movement-pattern token>" }\n' +
    "  Use type 'exercise' ONLY for a genuinely athlete-legible named milestone, and you MUST also declare the pattern it trains:\n" +
    '    { "type":"exercise", "value":"Canonical Exercise Name", "pattern":"<movement-pattern token>" }\n' +
    "- The referent's pattern MUST be one this phase's stage prescribes (see the tags above). A pattern that needs a higher stage is INVALID and will be rejected.\n" +
    "- metric is one of: " + Object.keys(rules.CRITERION_METRICS).join(", ") + ".\n" +
    "- comparator is one of: " + rules.CRITERION_COMPARATORS.join(", ") + ". Use trend_up / trend_flat_or_up ONLY with metric 'trend'; gte/lte/eq need a numeric threshold.\n" +
    "- Author 1-3 criteria per near_term phase. Horizon phases may have 0-1. Every criterion must be reachable within the phase's own emphasis.\n" +
    "- Do NOT invent training-history numbers. Thresholds are TARGETS to reach, not claims about the past.\n\n" +
    "OUTPUT: STRICT JSON ONLY, no prose, no fences:\n" +
    '{ "phases": [ { "phase_index": 0, "phase_name": "...", "intended_stage": "<stage>", "modality_family": "<family>", "exit_criteria": [ { "id": "c1", "metric": "...", "comparator": "...", "threshold": 0, "referent": { "type": "pattern", "value": "..." }, "rationale": "one line" } ] } ] }';

  var phases = (goal.roadmap && Array.isArray(goal.roadmap.phases)) ? goal.roadmap.phases : [];
  var U = ["GOAL: " + (goal.title || "(untitled)") + (goal.type ? " [type: " + goal.type + "]" : "")];
  if (opts.coldStart) {
    U.push("COLD-START DEFAULT (use as the floor when a phase gives no clearer signal): stage '" + opts.coldStart.stage +
      "', family '" + opts.coldStart.family + "' (" + opts.coldStart.basis + ").");
  }
  U.push("");
  U.push("PHASES (assign a stage + author criteria for each):");
  phases.forEach(function (p, i) {
    var em = p.emphasis ? (Array.isArray(p.emphasis) ? p.emphasis.join("; ") : p.emphasis) : "(no emphasis recorded)";
    U.push("  [" + i + "] \"" + (p.name || p.title || "phase " + i) + "\" type=" + (p.type || "?") +
      (p.duration_weeks ? " ~" + p.duration_weeks + "w" : "") + " | emphasis: " + em);
  });
  if (opts.retryNote) { U.push(""); U.push("PREVIOUS ATTEMPT REJECTED: " + opts.retryNote + " Re-author only the invalid criteria, keeping every referent pattern within the stage's prescribed set."); }

  return { system: system, user: U.join("\n\n") };
}

/**
 * Clamp a model-authored phase-stage assignment: force intended_stage into the
 * enum (cold-start default on miss), force modality_family into the enum, and
 * validate its criteria. Pure — no I/O.
 *
 * @returns {{intended_stage, modality_family, valid_criteria, invalid_criteria, forced_exercises, clamped:bool}}
 */
function clampAuthoredPhase(authored, coldStart) {
  var cs = coldStart || { stage: "capacity", family: "resistance" };
  var stage = rules.isStage(authored && authored.intended_stage) ? authored.intended_stage : cs.stage;
  var fam = rules.MODALITY_FAMILIES.indexOf(authored && authored.modality_family) >= 0 ? authored.modality_family : cs.family;
  var clamped = !authored || authored.intended_stage !== stage || authored.modality_family !== fam;
  var split = validatePhaseCriteria(authored && authored.exit_criteria, stage);
  return {
    intended_stage: stage,
    modality_family: fam,
    valid_criteria: split.valid_criteria,
    invalid_criteria: split.invalid_criteria,
    forced_exercises: split.forced_exercises,
    clamped: clamped,
  };
}

module.exports = {
  CRITERION_STATES,
  classifyPattern, normName,
  criterionPattern, validateCriterion, validatePhaseCriteria,
  referentMatches, resolveCriterion, compareValue,
  resolveEffectiveStage,
  buildStageAuthoringPrompt, clampAuthoredPhase,
};
