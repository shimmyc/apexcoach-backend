"use strict";
/**
 * ENGINE v2 — COACHING RULES MODULE
 * =================================
 * ONE source of truth for the coaching rule set, consumed two ways:
 *   1. As PROMPT TEXT — `renderRulesForPrompt(sections)` emits the rules the
 *      planner / autoregulator / variant prompts are given.
 *   2. As CALLABLE CODE — the pure functions below are used directly by the
 *      progression builder, the resequencer and the dossier builder.
 *
 * The point of the dual consumption is that the model and the code can never
 * disagree about what a rule says. If a number changes, it changes once.
 *
 * v2-ONLY. Nothing in v1 requires this file. It has no dependencies, no I/O,
 * and no npm imports — every function here is pure.
 *
 * EVIDENCE MARKING (load-bearing, do not strip)
 * ---------------------------------------------
 * Every rule carries an `evidence` field:
 *   'established' — broad consensus in the S&C / sports-medicine literature
 *   'contested'   — real practitioner disagreement, or extrapolated from
 *                   limited data. `renderRulesForPrompt` prints these with an
 *                   explicit "(contested guidance)" marker so the model is told
 *                   the confidence level rather than being handed a number that
 *                   reads like settled fact.
 * This matters because the model will otherwise state a contested landmark to
 * the athlete with the same authority as a hard rule.
 */

// ── Enums shared with the session/segment schema ────────────────────────────

var SEGMENT_TYPES = [
  "warmup", "straight_sets", "superset", "cluster", "circuit", "emom", "amrap",
  "interval_long", "interval_short", "sprint", "steady_state", "complex",
  "skill", "mobility", "active_recovery", "cooldown",
];

var INTENSITIES = ["low", "medium", "high"];

var GOAL_TIERS = ["driver", "maintenance", "accessory"];
var MAX_DRIVERS = 2;

var EFFORT_VALUES = ["more_in_tank", "about_right", "brutal"];

var NOVELTY_PREFS = ["same", "mostly_same", "varied"];

var DECISION_TAGS = ["kept", "reduced_volume", "reduced_intensity", "swapped", "recovery"];

// ── 1. Maintenance minimum effective dose, per quality ──────────────────────
// The tier a goal drops to when it is not a driver. Intensity is the lever that
// preserves an adaptation on low volume — that is the through-line of all of
// these, and it is why every entry names intensity explicitly.

var MAINTENANCE_MED = {
  strength: {
    frequency_per_week: 1,
    dose: "1-2 hard sets at >=80% 1RM",
    lever: "intensity — load must stay heavy; volume is what gets cut",
    evidence: "established",
  },
  hypertrophy: {
    frequency_per_week: [1, 2],
    dose: "~6 hard sets per muscle per week, taken near failure",
    lever: "proximity to failure",
    evidence: "established",
  },
  aerobic: {
    frequency_per_week: 2,
    dose: "13-26 min per session with intensity maintained",
    lever: "intensity — duration can fall a long way if intensity holds",
    evidence: "established",
  },
  anaerobic: {
    frequency_per_week: 1,
    dose: "one interval session",
    lever: "intensity",
    evidence: "established",
  },
  mobility: {
    frequency_per_week: 2,
    dose: "end-range work, >=2x/week",
    lever: "reaching true end range, not total minutes",
    evidence: "contested",
    note: "Retention timelines for passive range are poorly characterised; 2x/week is a practical floor, not a demonstrated minimum.",
  },
  skill: {
    frequency_per_week: 1,
    dose: ">=1 quality touch per week",
    lever: "frequency — skill decays with time away, not with low volume",
    evidence: "established",
  },
  tendon: {
    frequency_per_week: [2, 3],
    dose: "heavy-slow resistance or long-duration isometrics",
    lever: "time under high load",
    evidence: "established",
  },
};

// ── 2. Accessory cost cap ───────────────────────────────────────────────────
// Accessories are supposed to be free. They stop being free when they start
// competing with the driver for recovery.

var ACCESSORY_COST = {
  free_bolt_on_minutes: [5, 10],
  flag_when_daily_addons_exceed_minutes: 15,
  hard_flag_minutes: 20,
  counts_toward_weekly_volume_when:
    "the add-on includes near-failure sets that overlap a driver goal's muscle group",
  evidence: "established",
};

/**
 * Are today's accessory add-ons still "free", or are they real training load?
 * @param {number} totalAddonMinutes
 * @param {boolean} overlapsDriverMuscleNearFailure
 * @returns {{status:'free'|'flag'|'counts', reason:string}}
 */
function assessAccessoryCost(totalAddonMinutes, overlapsDriverMuscleNearFailure) {
  var mins = Number(totalAddonMinutes) || 0;
  if (overlapsDriverMuscleNearFailure) {
    return {
      status: "counts",
      reason: "near-failure sets overlapping a driver muscle group — count these toward weekly volume, they are not a free bolt-on",
    };
  }
  if (mins > ACCESSORY_COST.hard_flag_minutes) {
    return { status: "counts", reason: "add-ons total " + mins + " min (> " + ACCESSORY_COST.hard_flag_minutes + ") — this is a session, not a bolt-on" };
  }
  if (mins > ACCESSORY_COST.flag_when_daily_addons_exceed_minutes) {
    return { status: "flag", reason: "add-ons total " + mins + " min — approaching the point where they compete with the driver" };
  }
  return { status: "free", reason: "add-ons total " + mins + " min — within the free bolt-on range" };
}

// ── 3. Progression, by modality ─────────────────────────────────────────────

var PROGRESSION = {
  barbell: {
    trigger: "all prescribed reps completed with effort at or above target for 2 CONSECUTIVE sessions",
    upper_increment_lbs: [2.5, 5],
    lower_increment_lbs: [5, 10],
    evidence: "established",
  },
  dumbbell_machine_bodyweight: {
    trigger: "reps reach the top of the prescribed range across all sets",
    method: "double progression — add reps to the top of the range, THEN increase load or move to a harder variant and reset reps to the bottom of the range",
    evidence: "established",
  },
  isometric: {
    trigger: "target hold achieved for the prescribed sets",
    method: "add 5-10 seconds first; only add load once the duration target is stable",
    increment_seconds: [5, 10],
    evidence: "established",
  },
  conditioning: {
    trigger: "prescribed session completed at target intensity",
    method: "increase volume 5-10% per week; add DURATION before DENSITY",
    weekly_increase_pct: [5, 10],
    evidence: "established",
  },
};

// Below this many sessions in the window there is no resolvable trend, and
// progressionDecision returns 'establish_baseline' instead of 'hold'.
var MIN_SESSIONS_FOR_SIGNAL = 3;

var EFFORT_PROGRESSION = {
  more_in_tank_consecutive_to_progress: 2,
  brutal_response: "hold the load, or reduce it — do not progress",
  null_effort_response: "no signal; fall back to the completion-based trigger for the modality",
  evidence: "established",
};

/**
 * Should this exercise progress, hold, or regress?
 * Pure. Consumed by the progression builder AND described in prompt text.
 *
 * @param {object} o
 * @param {'barbell'|'dumbbell_machine_bodyweight'|'isometric'|'conditioning'} o.modality
 * @param {boolean} o.metPrescription        — hit all prescribed reps/hold this session
 * @param {number}  o.consecutiveMetSessions — how many consecutive sessions met it
 * @param {string[]} o.recentEfforts         — most recent first: 'more_in_tank'|'about_right'|'brutal'|null
 * @param {'up'|'flat'|'down'} o.trend
 * @param {number} [o.sessionsInWindow] — below MIN_SESSIONS_FOR_SIGNAL this
 *        returns 'establish_baseline' rather than 'hold'
 * @returns {{action:'progress'|'hold'|'regress'|'establish_baseline', detail:string, reason:string}}
 */
function progressionDecision(o) {
  o = o || {};
  var efforts = Array.isArray(o.recentEfforts) ? o.recentEfforts : [];
  var rule = PROGRESSION[o.modality] || PROGRESSION.dumbbell_machine_bodyweight;

  // 'brutal' vetoes progression outright — the athlete's own report of the
  // session outranks a completion counter. Checked FIRST, ahead of the
  // data-density rule: a strain report is real information even when the
  // history is thin, and "hold" is the safe answer either way.
  if (efforts[0] === "brutal") {
    return {
      action: "hold",
      detail: EFFORT_PROGRESSION.brutal_response,
      reason: "last session reported 'brutal'",
    };
  }

  // NOT ENOUGH HISTORY TO KNOW — a first-class outcome, deliberately NOT 'hold'.
  // Measured on real data (profile 4, 2026-07-22): 34 of 40 exercises have
  // fewer than 3 sessions in a 60-day window, so this is the COMMON case, not
  // an edge case. Collapsing it into 'hold' would make "we have no idea yet"
  // indistinguishable from "we are deliberately keeping the load steady" —
  // two states that call for opposite coaching language, and that the
  // autoregulator and Coach Chat both have to explain differently.
  if ((o.sessionsInWindow || 0) < MIN_SESSIONS_FOR_SIGNAL) {
    return {
      action: "establish_baseline",
      detail: "treat this as baseline-finding: prescribe conservatively, log it properly, and let a real trend accumulate before progressing",
      reason: "only " + (o.sessionsInWindow || 0) + " session(s) in the window — insufficient history to resolve a trend",
    };
  }

  // Two consecutive 'more_in_tank' is an independent progression trigger, even
  // if the completion counter has not reached its own threshold.
  var moreInTank = 0;
  for (var i = 0; i < efforts.length; i++) {
    if (efforts[i] === "more_in_tank") moreInTank++; else break;
  }
  if (moreInTank >= EFFORT_PROGRESSION.more_in_tank_consecutive_to_progress) {
    return {
      action: "progress",
      detail: describeIncrement(o.modality),
      reason: moreInTank + " consecutive sessions reported 'more in the tank'",
    };
  }

  if (o.trend === "down") {
    return {
      action: "regress",
      detail: "reduce load and rebuild — see the deload rules if this is the 2nd-3rd such session",
      reason: "measured trend is down",
    };
  }

  if (o.metPrescription && (o.consecutiveMetSessions || 0) >= 2) {
    return { action: "progress", detail: describeIncrement(o.modality), reason: rule.trigger };
  }

  return { action: "hold", detail: "repeat the current prescription", reason: "progression trigger not yet met" };
}

function describeIncrement(modality) {
  var p = PROGRESSION[modality];
  if (!p) return "apply the modality's standard increment";
  if (modality === "barbell") {
    return "+" + p.upper_increment_lbs.join("-") + " lb upper / +" + p.lower_increment_lbs.join("-") + " lb lower";
  }
  if (modality === "isometric") return "+" + p.increment_seconds.join("-") + " s hold";
  if (modality === "conditioning") return "+" + p.weekly_increase_pct.join("-") + "% volume (duration before density)";
  return p.method;
}

// ── 4. Gap decay ────────────────────────────────────────────────────────────
// Ordered longest-first so the first match wins.

var GAP_DECAY = [
  { min_days: 43, label: ">6 weeks",   load_multiplier: null, rebuild_sessions: null,
    action: "conservative restart — re-establish the movement before chasing the old number", evidence: "established" },
  { min_days: 29, label: "4-6 weeks",  load_multiplier: 0.85, load_reduction_pct: [10, 20], rebuild_weeks: [2, 4],
    action: "reduce working load 10-20%, rebuild over 2-4 weeks", evidence: "established" },
  { min_days: 15, label: "2-3 weeks",  load_multiplier: 0.925, load_reduction_pct: [5, 10], rebuild_sessions: [1, 2],
    action: "reduce working load 5-10%, rebuild over 1-2 sessions", evidence: "established" },
  { min_days: 10, label: "10-14 days", load_multiplier: 0.95, load_reduction_pct: [0, 5], rebuild_sessions: [1],
    action: "small reduction if the lift feels off; otherwise resume", evidence: "contested",
    note: "The 10-14 day band is a judgement call — detraining evidence at this timescale is weak and highly individual." },
  { min_days: 0,  label: "<10 days",   load_multiplier: 1.0, load_reduction_pct: [0, 0],
    action: "no decay — resume as prescribed", evidence: "established" },
];

// Separate, per-EXERCISE rule. Applies on top of the banded decay above.
//
// ⚠ THE MULTIPLIER FLOOR IS CURRENTLY UNREACHABLE — proven by test, documented
// rather than deleted. It only binds when a band multiplier is LOOSER than
// 0.90, but staleness requires >30 days and every band from 29 days upward is
// already <= 0.85 (or null for a restart). So the two conditions can never both
// hold. It is kept because it costs nothing and would immediately start
// mattering if the band thresholds are retuned — but it is defensive code, not
// an active rule, and must not be read as one. The `per_exercise_stale` FLAG
// itself IS reachable and is used: it appends the -10% note to the action text
// and is surfaced in the progression state.
var PER_EXERCISE_STALE_DAYS = 30;
var PER_EXERCISE_STALE_MULTIPLIER = 0.90;

/**
 * @param {number} daysSinceLast
 * @returns {{band:string, multiplier:number|null, action:string, evidence:string, note?:string, per_exercise_stale:boolean}}
 */
function gapDecay(daysSinceLast) {
  var d = Number(daysSinceLast);
  if (!isFinite(d) || d < 0) d = 0;
  var band = GAP_DECAY[GAP_DECAY.length - 1];
  for (var i = 0; i < GAP_DECAY.length; i++) {
    if (d >= GAP_DECAY[i].min_days) { band = GAP_DECAY[i]; break; }
  }
  var stale = d > PER_EXERCISE_STALE_DAYS;
  var mult = band.load_multiplier;
  // The per-exercise >30d rule is applied as a floor, not multiplied on top of
  // a band that is already more conservative — stacking them would double-count
  // the same layoff.
  if (stale && mult !== null && mult > PER_EXERCISE_STALE_MULTIPLIER) {
    mult = PER_EXERCISE_STALE_MULTIPLIER;
  }
  return {
    band: band.label,
    multiplier: mult,
    action: band.action + (stale ? " (also >30 days on this specific exercise: cap the working baseline at -10%)" : ""),
    evidence: band.evidence,
    note: band.note,
    per_exercise_stale: stale,
  };
}

// ── 5. Deload ───────────────────────────────────────────────────────────────

var DELOAD = {
  triggers: [
    "2-3 consecutive stalled or regressed sessions on a lift, WITH adequate recovery context (i.e. the stall is not explained by sleep/illness/life load)",
    "multi-day fatigue signals — readiness below personal baseline several days running, or repeated 'brutal' effort reports",
  ],
  shape: { volume_reduction_pct: [40, 50], intensity: "held", duration: "~1 week" },
  note: "Volume is what drops. Holding intensity is what preserves the adaptation through the deload — a deload that cuts both is just a lost week.",
  evidence: "established",
};

var STALL_WEEKS_FOR_STALLED_FLAG = 3;   // dossier: "stalled lift"
var NEGLECT_WEEKS_FOR_FLAG = 6;         // dossier: "neglected movement"
var MISSED_SESSIONS_FOR_REPLAN = 3;     // >=3 consecutive missed -> planner regresses one microcycle

/**
 * @param {object} o
 * @param {number} o.stalledOrRegressedSessions
 * @param {boolean} o.adequateRecoveryContext
 * @param {boolean} o.multiDayFatigue
 * @returns {{deload:boolean, reason:string, shape:object|null}}
 */
function deloadDecision(o) {
  o = o || {};
  if (o.multiDayFatigue) {
    return { deload: true, reason: "multi-day fatigue signals", shape: DELOAD.shape };
  }
  if ((o.stalledOrRegressedSessions || 0) >= 2 && o.adequateRecoveryContext) {
    return {
      deload: true,
      reason: o.stalledOrRegressedSessions + " consecutive stalled/regressed sessions with adequate recovery context",
      shape: DELOAD.shape,
    };
  }
  if ((o.stalledOrRegressedSessions || 0) >= 2 && !o.adequateRecoveryContext) {
    return {
      deload: false,
      reason: "stalling, but recovery context is poor — fix sleep/load first; a deload does not fix a sleep debt",
      shape: null,
    };
  }
  return { deload: false, reason: "no deload trigger met", shape: null };
}

// ── 6. Readiness modification ───────────────────────────────────────────────
// ALWAYS relative to this athlete's own baseline. Population absolutes are
// explicitly forbidden — an HRV of 45 means nothing without knowing whose.

var READINESS = {
  single_low_day: {
    action: "reduce intensity 10-20% OR trim volume",
    never: "never auto-cancel a session on one below-baseline day",
    evidence: "established",
  },
  hrv_below_baseline_consecutive_days: 3,
  hrv_sustained_low: {
    action: "swap high-CNS work for active recovery",
    evidence: "contested",
    note: "HRV-guided training outperforms fixed programming in several trials, but the 3-day threshold specifically is a practical convention, not a validated cutoff.",
  },
  subjective_veto: {
    rule: "a subjective report of 'brutal' or 'terrible' VETOES a green wearable score",
    rationale: "the wearable did not sleep badly, get sick, or have a hard week — the athlete did",
    evidence: "established",
  },
  baseline_rule: "compare against this athlete's own rolling baseline, never a population norm",
};

/**
 * @param {object} o
 * @param {number|null} o.score                 — today's readiness
 * @param {number|null} o.personalBaseline      — this athlete's own baseline
 * @param {number} o.consecutiveBelowBaselineDays
 * @param {string|null} o.subjectiveState       — free text or 'brutal'/'terrible'
 * @returns {{action:string, tag:string, reason:string}}
 */
function readinessModification(o) {
  o = o || {};
  var subj = (o.subjectiveState || "").toLowerCase();
  if (subj.indexOf("brutal") >= 0 || subj.indexOf("terrible") >= 0 || subj.indexOf("wrecked") >= 0) {
    return {
      action: "treat today as a low-readiness day regardless of the wearable score",
      tag: "reduced_intensity",
      reason: "subjective state vetoes a green wearable score",
    };
  }
  if ((o.consecutiveBelowBaselineDays || 0) >= READINESS.hrv_below_baseline_consecutive_days) {
    return {
      action: READINESS.hrv_sustained_low.action,
      tag: "recovery",
      reason: o.consecutiveBelowBaselineDays + " consecutive days below personal baseline",
    };
  }
  if (o.score != null && o.personalBaseline != null && o.score < o.personalBaseline) {
    return {
      action: READINESS.single_low_day.action,
      tag: "reduced_intensity",
      reason: "single day below personal baseline — modify, never cancel",
    };
  }
  return { action: "proceed as planned", tag: "kept", reason: "readiness at or above personal baseline" };
}

// ── 7. Pain (Silbernagel-style load-tolerance rules) ────────────────────────
// NOT diagnostic. The redirect language is deliberately plain and names a real
// professional rather than implying a diagnosis.

var PAIN = {
  acceptable_during_or_after_max: 5,       // out of 10
  must_settle_by: "baseline by the next morning",
  must_not: "trend upward week over week",
  violation_response: "regress load or range of motion by ~20%, or substitute the movement",
  redirect_when: [
    "pain persists despite load management",
    "pain is worsening week over week",
    "any neurological symptom — numbness, tingling, weakness, radiating pain",
  ],
  redirect_language:
    "this is worth getting looked at by a physio or doctor — describe what you feel and when it happens; do not attempt a diagnosis",
  evidence: "established",
  note: "Silbernagel's tendon-pain monitoring model. Validated for tendinopathy specifically; applied more broadly here as a practical load-tolerance heuristic.",
};

/**
 * @param {object} o
 * @param {number} o.painDuringOrAfter  — 0-10
 * @param {boolean} o.settlesByNextMorning
 * @param {boolean} o.trendingUpWeekOverWeek
 * @param {boolean} o.neurologicalSymptoms
 * @returns {{ok:boolean, action:string, redirect:boolean, reason:string}}
 */
function painCheck(o) {
  o = o || {};
  if (o.neurologicalSymptoms) {
    return { ok: false, action: PAIN.redirect_language, redirect: true, reason: "neurological symptoms reported" };
  }
  if (o.trendingUpWeekOverWeek) {
    return { ok: false, action: PAIN.redirect_language, redirect: true, reason: "pain trending up week over week" };
  }
  var over = (Number(o.painDuringOrAfter) || 0) > PAIN.acceptable_during_or_after_max;
  var lingers = o.settlesByNextMorning === false;
  if (over || lingers) {
    return {
      ok: false,
      action: PAIN.violation_response,
      redirect: false,
      reason: over ? "pain above 5/10 during or after loading" : "pain has not settled to baseline by the next morning",
    };
  }
  return { ok: true, action: "training may continue as prescribed", redirect: false, reason: "within the load-tolerance rules" };
}

// ── 8. Interference and spacing ─────────────────────────────────────────────

var INTERFERENCE = {
  strength_plus_hard_conditioning_same_day_min_gap_hours: 3,
  strength_plus_hard_conditioning_preferred_gap_hours: 6,
  order_rule: "when skill is the priority, lift AFTER the skill session",
  sparring_and_heavy_lower: "hard sparring and heavy lower-body work should not fall on consecutive days without a buffer",
  high_intensity_intervals_per_week_max: 3,
  high_intensity_intervals_min_per_week: 2,
  no_consecutive_day_hiit: true,
  same_lift_at_90pct_min_days_apart: [2, 3],
  true_recovery_days_per_week_min: 1,
  evidence: "established",
};

var MAT_LOAD = {
  trigger: "a logged hard BJJ / sparring session",
  next_day_lower_body_set_reduction: 2,
  blocks: "stacking another high-CNS session the same day or the next day",
  evidence: "contested",
  note: "The direction is well supported (combat sports carry high systemic and eccentric load); the specific '-2 sets' figure is a practical convention chosen for this athlete, not a literature value.",
};

// ── 9. Volume caps ──────────────────────────────────────────────────────────

var VOLUME = {
  per_session_sets_per_muscle_max: 10,
  overflow_action: "move the excess to another day rather than extending the session",
  weekly_landmarks: { MV: [4, 8], MEV: [8, 12], MAV: [12, 20], MRV: [18, 26] },
  evidence: "contested",
  note: "MV/MEV/MAV/MRV landmarks are a useful planning vocabulary but are NOT settled science — the underlying numbers vary widely between individuals and the framework itself is disputed. Treat as a starting range to be adjusted from this athlete's own response, never as a target to hit.",
};

// ── 10. Time compression ────────────────────────────────────────────────────
// Ordered. Apply top-down when a session must be shortened.

var TIME_COMPRESSION_ORDER = [
  { step: 1, action: "drop tertiary accessories" },
  { step: 2, action: "superset the secondary work" },
  { step: 3, action: "shorten rest periods" },
  { step: 4, action: "NEVER drop the primary compound or the injury-prehab dose", never: true },
];

/**
 * @param {number} availableMinutes
 * @param {number} plannedMinutes
 * @returns {{compress:boolean, steps:string[], protect:string}}
 */
function timeCompressionPlan(availableMinutes, plannedMinutes) {
  var avail = Number(availableMinutes) || 0;
  var planned = Number(plannedMinutes) || 0;
  if (!planned || avail >= planned) {
    return { compress: false, steps: [], protect: "nothing to compress" };
  }
  var deficit = planned - avail;
  var ratio = deficit / planned;
  var steps = [TIME_COMPRESSION_ORDER[0].action];
  if (ratio > 0.15) steps.push(TIME_COMPRESSION_ORDER[1].action);
  if (ratio > 0.3) steps.push(TIME_COMPRESSION_ORDER[2].action);
  return {
    compress: true,
    steps: steps,
    protect: TIME_COMPRESSION_ORDER[3].action,
  };
}

// ── 10b. Session work-content plausibility ──────────────────────────────────
// The session_time_budget invariant (server/v2Planner.js) checks not just that
// a session's segment minutes SUM to its stated length, but that the PRESCRIBED
// WORK can plausibly occupy that length. Before this, the invariant compared two
// model-authored numbers to each other (segment minutes vs session minutes),
// which the model trivially satisfied by INFLATING segment duration_min — so a
// "45 min" session could hold ~18 min of real work and still pass (ROADMAP §6,
// Session 9). Consumed BOTH as code (estimateSegmentWorkMinutes backs the
// invariant) AND as prompt text (renderWorkBudgetGuidance), so the model
// optimises against the SAME function the code enforces.
//
// The model mirrors v1's estimateExerciseMinutes (public/index.html) — per SET,
// not per rep — so the two engines never disagree. Divergences documented at
// estimateSegmentWorkMinutes.
var WORK_MIN_PER_STRENGTH_SET = 1.5;   // = v1 REC_MIN_PER_SET (one working set incl. rest)
var WORK_MIN_PER_MOBILITY_SET = 1.0;   // = v1 REC_MIN_PER_MOBILITY
var WORK_MIN_REST_PER_HOLD    = 1.0;   // = v1 "+1 min" per hold (sets*(hold+1))
var SESSION_WORK_FLOOR        = 0.70;  // a non-anchor session's estimated work must be >= this * stated duration

// v1's recIsMobilityish, extended with the moves this athlete's plans actually use.
var WORK_MOBILITY_RE = /stretch|mobility|cat-cow|cat cow|slide|pull-apart|chin tuck|dead bug|clamshell|bridge|rotation|breath|foam roll|band|hang|90\/90|hollow|lumbrical|pinky|clam/i;
var WORK_MOBILITY_SEG_TYPES = { mobility: 1, active_recovery: 1, warmup: 1, cooldown: 1 };

function workIsMobilityRate(exName, segType) {
  if (segType && WORK_MOBILITY_SEG_TYPES[segType]) return true;
  return WORK_MOBILITY_RE.test(String(exName || ""));
}

/**
 * Estimate the plausible WORKING minutes a segment's prescribed exercises
 * occupy — NOT the model-declared duration_min (which is what padding inflates).
 * Pure. Mirrors v1's per-SET model (estimateExerciseMinutes, public/index.html).
 *
 *   - timed hold/effort (time_seconds):  sets × (time_seconds/60) + sets × rest
 *   - set × rep movement (reps):         sets × per-set-minutes (mobility vs strength)
 *   - a segment whose exercises ALL lack reps AND time (a pure time block — a
 *     bike, a run) IS its declared duration_min: the continuous block is the work.
 *   - a lone bare exercise mixed with measurable ones counts as one nominal set.
 *   - an empty segment is 0 work (an anchor's fixed class is excluded upstream,
 *     by its no-prescribed-work property, not here).
 *
 * Deliberate divergences from v1 (reported per the Session 9 brief):
 *   (i)   v1 parses freeform strings ("3x8"); this reads the STRUCTURED fields —
 *         same model, cleaner input, no regex on the numbers.
 *   (ii)  v1 has no "bare time-block segment -> duration_min" case (its cardio
 *         line carries "20min" inline); v2 needs it because a cardio block's
 *         length lives on seg.duration_min with time_seconds:null.
 *   (iii) v1 adds a flat REC_WARMUP_MIN (5) per session for transitions; this does
 *         NOT — warm-up is its own segment here and is estimated normally, and a
 *         flat session bonus would only mask thinness. The floor tolerates setup.
 *   (iv)  the brief sketched "sets×reps×tempo" (per rep); v1 is per SET and
 *         reps-agnostic, and consistency with v1 was chosen over the sketch so
 *         the two engines cannot disagree.
 */
function estimateSegmentWorkMinutes(seg) {
  if (!seg) return 0;
  var exs = seg.exercises || [];
  if (!exs.length) return 0;
  var total = 0, bare = 0;
  var segMob = !!(seg.type && WORK_MOBILITY_SEG_TYPES[seg.type]);
  exs.forEach(function (ex) {
    var sets = Number(ex.sets) || 1;
    if (ex.time_seconds) {
      total += sets * (Number(ex.time_seconds) / 60) + sets * WORK_MIN_REST_PER_HOLD;
    } else if (ex.reps) {
      total += sets * (workIsMobilityRate(ex.name, seg.type) ? WORK_MIN_PER_MOBILITY_SET : WORK_MIN_PER_STRENGTH_SET);
    } else {
      bare++;
    }
  });
  if (bare === exs.length) {
    // The WHOLE segment is a pure continuous time block (a bike/run): its
    // declared length is real work.
    return Number(seg.duration_min) || total;
  }
  if (bare) total += bare * (segMob ? WORK_MIN_PER_MOBILITY_SET : WORK_MIN_PER_STRENGTH_SET);
  return total;
}

/** Sum estimated working minutes across a session's segments. Pure. */
function estimateSessionWorkMinutes(session) {
  return ((session && session.segments) || []).reduce(function (a, s) {
    return a + estimateSegmentWorkMinutes(s);
  }, 0);
}

/** Does a session prescribe any actual work? A fixed class (anchor) does not, and
 *  is therefore excluded from the work floor — off this property, not a category. */
function sessionHasPrescribedWork(session) {
  return ((session && session.segments) || []).some(function (s) { return (s.exercises || []).length > 0; });
}

/** Prompt text for the work budget — the model optimises against the SAME
 *  function estimateSegmentWorkMinutes enforces. Injected into the planner and
 *  the variant prompts (not the general rules block). */
function renderWorkBudgetGuidance() {
  return [
    "SESSION WORK BUDGET — fill the time with real work, never pad the numbers:",
    "- A session's stated duration must be backed by prescribed work that plausibly OCCUPIES it. The server estimates working minutes and REJECTS (and regenerates) a plan whose prescribed work is under " + Math.round(SESSION_WORK_FLOOR * 100) + "% of the stated duration.",
    "- Estimate the way the server does, per SEGMENT — reps do NOT add time, SETS do:",
    "    - a set×rep movement ≈ " + WORK_MIN_PER_STRENGTH_SET + " min per SET (" + WORK_MIN_PER_MOBILITY_SET + " min for mobility/posture). So \"3x8\" ≈ " + (3 * WORK_MIN_PER_STRENGTH_SET) + " min, NOT 15.",
    "    - a timed hold/effort ≈ sets × (seconds/60 + ~" + WORK_MIN_REST_PER_HOLD + " min rest). A \"3×45s\" dead hang ≈ " + (3 * (0.75 + WORK_MIN_REST_PER_HOLD)).toFixed(1) + " min.",
    "    - a GENUINE continuous time block (a steady bike or run) IS its segment duration_min — that is real work; keep it.",
    "- A segment's duration_min must NOT exceed the plausible work of its exercises. If a segment would be mostly empty time, ADD real sets / exercises / rounds to fill it — do NOT inflate duration_min to hit a total. If you genuinely cannot fill the time, shorten the segment AND the session to an honest length instead.",
    "- This REPLACES any 'segments must sum to the session length' rule: content drives the minutes; the stated minutes never license padding.",
  ].join("\n");
}

// ── 11. Rotation ────────────────────────────────────────────────────────────

var ROTATION = {
  primary_lift_fixed_min_weeks: 4,
  primary_lift_fixed_max_weeks: 6,
  primary_rule: "primary lifts stay fixed within a block — progression has to stay MEASURABLE, and you cannot measure progress on a lift you keep swapping",
  never: "never rotate a primary lift for the sake of novelty",
  by_novelty_pref: {
    same:        "do not rotate accessories",
    mostly_same: "rotate accessories every 2-3 weeks",
    varied:      "rotate accessories freely and vary segment structures too",
  },
  evidence: "established",
};

/**
 * @param {'same'|'mostly_same'|'varied'} noveltyPref
 * @param {number} weeksIntoBlock
 * @returns {{primaries:string, accessories:string, mayRotateAccessoriesNow:boolean}}
 */
function rotationPolicy(noveltyPref, weeksIntoBlock) {
  var pref = NOVELTY_PREFS.indexOf(noveltyPref) >= 0 ? noveltyPref : "mostly_same";
  var w = Number(weeksIntoBlock) || 0;
  var may = false;
  if (pref === "varied") may = true;
  else if (pref === "mostly_same") may = w > 0 && w % 2 === 0;
  return {
    primaries: "fixed for " + ROTATION.primary_lift_fixed_min_weeks + "-" + ROTATION.primary_lift_fixed_max_weeks + " weeks — " + ROTATION.primary_rule,
    accessories: ROTATION.by_novelty_pref[pref],
    mayRotateAccessoriesNow: may,
  };
}

// ── 12. Missed sessions ─────────────────────────────────────────────────────

var MISSED_SESSIONS = {
  handled_by: "the CODE resequencer — no AI involved",
  method: "redistribute movable sessions across the remaining days by priority and the spacing rules; drop the lowest-priority session when the week cannot fit; log every decision",
  consecutive_missed_for_replan: MISSED_SESSIONS_FOR_REPLAN,
  replan_action: "the next planner run regresses loads by one microcycle",
  evidence: "established",
};

// ── Prompt rendering ────────────────────────────────────────────────────────

var SECTION_ORDER = [
  "maintenance_med", "accessory_cost", "progression", "gap_decay", "deload",
  "readiness", "pain", "interference", "volume", "time_compression",
  "rotation", "missed_sessions",
];

function fmtRange(r) {
  if (Array.isArray(r)) return r.join("-");
  return String(r);
}

function evidenceSuffix(obj) {
  if (!obj || obj.evidence !== "contested") return "";
  return " [CONTESTED GUIDANCE" + (obj.note ? " — " + obj.note : "") + "]";
}

var SECTION_RENDERERS = {
  maintenance_med: function () {
    var lines = ["MAINTENANCE MINIMUM EFFECTIVE DOSE (what a non-driver goal still gets):"];
    Object.keys(MAINTENANCE_MED).forEach(function (k) {
      var m = MAINTENANCE_MED[k];
      lines.push("- " + k + ": " + fmtRange(m.frequency_per_week) + "x/week, " + m.dose +
        ". Lever: " + m.lever + "." + evidenceSuffix(m));
    });
    return lines.join("\n");
  },

  accessory_cost: function () {
    return [
      "ACCESSORY COST CAP:",
      "- " + fmtRange(ACCESSORY_COST.free_bolt_on_minutes) + " min bolt-ons are free and do not need justifying.",
      "- Flag when daily add-ons exceed ~" + ACCESSORY_COST.flag_when_daily_addons_exceed_minutes + "-" + ACCESSORY_COST.hard_flag_minutes + " min.",
      "- Add-ons COUNT toward weekly volume when " + ACCESSORY_COST.counts_toward_weekly_volume_when + ".",
    ].join("\n");
  },

  progression: function () {
    var lines = ["PROGRESSION (use real increments, never 'add more'):"];
    lines.push("- barbell: " + PROGRESSION.barbell.trigger + " -> +" +
      fmtRange(PROGRESSION.barbell.upper_increment_lbs) + " lb upper / +" +
      fmtRange(PROGRESSION.barbell.lower_increment_lbs) + " lb lower.");
    lines.push("- dumbbell/machine/bodyweight: " + PROGRESSION.dumbbell_machine_bodyweight.method + ".");
    lines.push("- isometric: " + PROGRESSION.isometric.method + ".");
    lines.push("- conditioning: " + PROGRESSION.conditioning.method + ".");
    lines.push("- effort feedback: '" + EFFORT_VALUES[0] + "' on " +
      EFFORT_PROGRESSION.more_in_tank_consecutive_to_progress +
      " consecutive sessions of a lift -> progress it. '" + EFFORT_VALUES[2] + "' -> " +
      EFFORT_PROGRESSION.brutal_response + ". No answer -> " + EFFORT_PROGRESSION.null_effort_response + ".");
    return lines.join("\n");
  },

  gap_decay: function () {
    var lines = ["GAP DECAY (time off since the exercise was last trained):"];
    GAP_DECAY.slice().reverse().forEach(function (b) {
      lines.push("- " + b.label + ": " + b.action + evidenceSuffix(b));
    });
    lines.push("- any single exercise untrained >" + PER_EXERCISE_STALE_DAYS +
      " days: cap its working baseline at -10%.");
    return lines.join("\n");
  },

  deload: function () {
    return [
      "DELOAD:",
      "- Trigger on either: " + DELOAD.triggers.join("; or "),
      "- Shape: volume -" + fmtRange(DELOAD.shape.volume_reduction_pct) + "%, intensity " +
        DELOAD.shape.intensity + ", " + DELOAD.shape.duration + ".",
      "- " + DELOAD.note,
    ].join("\n");
  },

  readiness: function () {
    return [
      "READINESS MODIFICATION (" + READINESS.baseline_rule + "):",
      "- Single below-baseline day: " + READINESS.single_low_day.action + ". " + READINESS.single_low_day.never + ".",
      "- Below personal baseline " + READINESS.hrv_below_baseline_consecutive_days +
        " consecutive days: " + READINESS.hrv_sustained_low.action + "." + evidenceSuffix(READINESS.hrv_sustained_low),
      "- " + READINESS.subjective_veto.rule + " — " + READINESS.subjective_veto.rationale + ".",
    ].join("\n");
  },

  pain: function () {
    return [
      "PAIN (load-tolerance rules — NOT a diagnosis, never name a condition):",
      "- Training may continue if pain is <=" + PAIN.acceptable_during_or_after_max +
        "/10 during or after, settles to " + PAIN.must_settle_by + ", and does " + PAIN.must_not + ".",
      "- If any of those is violated: " + PAIN.violation_response + ".",
      "- Redirect to a professional when: " + PAIN.redirect_when.join("; ") + ".",
      "- Redirect wording: \"" + PAIN.redirect_language + "\"." + evidenceSuffix(PAIN),
    ].join("\n");
  },

  interference: function () {
    return [
      "INTERFERENCE AND SPACING:",
      "- Strength + hard conditioning same day: >=" + INTERFERENCE.strength_plus_hard_conditioning_same_day_min_gap_hours +
        " h apart (prefer " + INTERFERENCE.strength_plus_hard_conditioning_preferred_gap_hours + " h).",
      "- " + INTERFERENCE.order_rule + ".",
      "- " + INTERFERENCE.sparring_and_heavy_lower + ".",
      "- High-intensity intervals: " + INTERFERENCE.high_intensity_intervals_min_per_week + "-" +
        INTERFERENCE.high_intensity_intervals_per_week_max + "x/week max, never on consecutive days.",
      "- Same lift at >=90% 1RM: " + fmtRange(INTERFERENCE.same_lift_at_90pct_min_days_apart) + " days apart minimum.",
      "- At least " + INTERFERENCE.true_recovery_days_per_week_min + " true recovery day per week.",
      "- Mat load: " + MAT_LOAD.trigger + " reduces next-day lower-body volume by " +
        MAT_LOAD.next_day_lower_body_set_reduction + " sets and blocks " + MAT_LOAD.blocks + "." + evidenceSuffix(MAT_LOAD),
    ].join("\n");
  },

  volume: function () {
    return [
      "VOLUME CAPS:",
      "- <=" + VOLUME.per_session_sets_per_muscle_max + " sets per muscle per session; " + VOLUME.overflow_action + ".",
      "- Weekly landmarks: MV " + fmtRange(VOLUME.weekly_landmarks.MV) + ", MEV " + fmtRange(VOLUME.weekly_landmarks.MEV) +
        ", MAV " + fmtRange(VOLUME.weekly_landmarks.MAV) + ", MRV " + fmtRange(VOLUME.weekly_landmarks.MRV) +
        " sets/muscle/week." + evidenceSuffix(VOLUME),
    ].join("\n");
  },

  time_compression: function () {
    return "TIME COMPRESSION (in this order when a session must be shortened):\n" +
      TIME_COMPRESSION_ORDER.map(function (s) { return "- " + s.step + ". " + s.action; }).join("\n");
  },

  rotation: function () {
    return [
      "ROTATION:",
      "- Primary lifts: fixed " + ROTATION.primary_lift_fixed_min_weeks + "-" + ROTATION.primary_lift_fixed_max_weeks +
        " weeks within a block. " + ROTATION.primary_rule + ". " + ROTATION.never + ".",
      "- Accessories, by the athlete's novelty preference: " +
        Object.keys(ROTATION.by_novelty_pref).map(function (k) {
          return k + " = " + ROTATION.by_novelty_pref[k];
        }).join("; ") + ".",
    ].join("\n");
  },

  missed_sessions: function () {
    return [
      "MISSED SESSIONS:",
      "- Handled by " + MISSED_SESSIONS.handled_by + ": " + MISSED_SESSIONS.method + ".",
      "- " + MISSED_SESSIONS.consecutive_missed_for_replan + " consecutive missed sessions: " + MISSED_SESSIONS.replan_action + ".",
    ].join("\n");
  },
};

/**
 * Render rule sections as prompt text.
 * @param {string[]} [sections] — subset of SECTION_ORDER; omit for all.
 * @returns {string}
 */
function renderRulesForPrompt(sections) {
  var want = Array.isArray(sections) && sections.length ? sections : SECTION_ORDER;
  var out = [];
  want.forEach(function (name) {
    var r = SECTION_RENDERERS[name];
    if (r) out.push(r());
  });
  return out.join("\n\n");
}

/** Per-section character counts — for the promptSections logging discipline. */
function rulesSectionLengths(sections) {
  var want = Array.isArray(sections) && sections.length ? sections : SECTION_ORDER;
  var out = {};
  want.forEach(function (name) {
    var r = SECTION_RENDERERS[name];
    if (r) out[name] = r().length;
  });
  out._total = renderRulesForPrompt(want).length;
  return out;
}

module.exports = {
  // enums / schema vocabulary
  SEGMENT_TYPES, INTENSITIES, GOAL_TIERS, MAX_DRIVERS, EFFORT_VALUES,
  NOVELTY_PREFS, DECISION_TAGS,
  // constants
  MAINTENANCE_MED, ACCESSORY_COST, PROGRESSION, EFFORT_PROGRESSION,
  MIN_SESSIONS_FOR_SIGNAL,
  GAP_DECAY, PER_EXERCISE_STALE_DAYS, PER_EXERCISE_STALE_MULTIPLIER,
  DELOAD, STALL_WEEKS_FOR_STALLED_FLAG, NEGLECT_WEEKS_FOR_FLAG,
  MISSED_SESSIONS_FOR_REPLAN, READINESS, PAIN, INTERFERENCE, MAT_LOAD,
  VOLUME, TIME_COMPRESSION_ORDER, ROTATION, MISSED_SESSIONS,
  // work-content plausibility (Session 9)
  WORK_MIN_PER_STRENGTH_SET, WORK_MIN_PER_MOBILITY_SET, WORK_MIN_REST_PER_HOLD,
  SESSION_WORK_FLOOR,
  // pure functions
  assessAccessoryCost, progressionDecision, describeIncrement, gapDecay,
  deloadDecision, readinessModification, painCheck, timeCompressionPlan,
  rotationPolicy,
  estimateSegmentWorkMinutes, estimateSessionWorkMinutes, sessionHasPrescribedWork,
  workIsMobilityRate, renderWorkBudgetGuidance,
  // prompt rendering
  SECTION_ORDER, renderRulesForPrompt, rulesSectionLengths,
};
