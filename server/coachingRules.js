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

// ── 13. Training-stage ladder + envelopes (Engine v2, A1) ───────────────────
// A goal-agnostic archetype ladder that ANY goal's roadmap phases map onto. Each
// (stage, modality-family) has a CODE-OWNED envelope: the model authors only
// exercise selection + load targets INSIDE it. This is knowledge/data; it is
// consumed as code (envelopeFor / validation) AND as prompt text
// (renderStageEnvelopesForPrompt) so the model and code never disagree — the
// same dual-consumption discipline as the rest of this module.
//
// ⚠ A1 SCOPE: this is NOT wired into the planner prompt (that is A2) and does NOT
// enable phase advancement (that is B). Nothing below is added to SECTION_ORDER /
// renderRulesForPrompt, so the planner prompt is byte-identical to before A1.

// Ordered low -> high. `maintenance` is a PARALLEL track, deliberately NOT a rung
// on the linear ladder (you maintain an adaptation you already built; you do not
// "advance past" maintenance). It is handled specially by stage math below.
var STAGE_LADDER = ["tissue_tolerance", "capacity", "load", "power", "return_to_sport"];
var STAGES = STAGE_LADDER.concat(["maintenance"]);

var MODALITY_FAMILIES = ["resistance", "aerobic", "skill_mobility"];

/** Ladder index for advance/regress DIRECTION. maintenance is off-ladder -> -1. */
function stageIndex(stage) {
  return STAGE_LADDER.indexOf(stage);
}
/** Rank for pattern min_stage GATING only. maintenance ranks highest so a
 *  maintenance phase may reference any pattern it is holding (incl. power work). */
function patternStageRank(stage) {
  if (stage === "maintenance") return STAGE_LADDER.length; // above return_to_sport
  var i = STAGE_LADDER.indexOf(stage);
  return i < 0 ? 0 : i;
}
/** One rung down the ladder (safety-veto regression). Floor is tissue_tolerance.
 *  A maintenance phase regresses to the rebuild floor (tissue_tolerance) — the
 *  correct safety response to escalating pain while maintaining. */
function stageBelow(stage) {
  if (stage === "maintenance") return "tissue_tolerance";
  var i = STAGE_LADDER.indexOf(stage);
  if (i <= 0) return STAGE_LADDER[0];
  return STAGE_LADDER[i - 1];
}
function isStage(stage) { return STAGES.indexOf(stage) >= 0; }

// Movement-pattern vocabulary — the CLOSED referent vocabulary for exit_criteria.
// Each token belongs to exactly one modality-family (so a criterion's family is
// derivable from its pattern) and carries a `min_stage`: the earliest ladder
// stage at which the envelope prescribes it. `ballistic` / sprint / reactive work
// is gated to `power`+ so a criterion referencing it on a pre-power phase is
// caught as wrong-stage by the authoring validator. (This is the A1 seed of the
// `{token, min_stage}` gating the Phase-C contraindication work extends.)
var MOVEMENT_PATTERNS = {
  // resistance
  squat:             { family: "resistance", min_stage: "tissue_tolerance", label: "squat" },
  hinge:             { family: "resistance", min_stage: "tissue_tolerance", label: "hip hinge" },
  lunge:             { family: "resistance", min_stage: "tissue_tolerance", label: "lunge / split squat" },
  hip_bridge:        { family: "resistance", min_stage: "tissue_tolerance", label: "glute bridge / hip thrust" },
  horizontal_push:   { family: "resistance", min_stage: "tissue_tolerance", label: "horizontal press" },
  vertical_push:     { family: "resistance", min_stage: "tissue_tolerance", label: "overhead press" },
  horizontal_pull:   { family: "resistance", min_stage: "tissue_tolerance", label: "row" },
  vertical_pull:     { family: "resistance", min_stage: "tissue_tolerance", label: "pull-up / pulldown" },
  carry:             { family: "resistance", min_stage: "tissue_tolerance", label: "loaded carry" },
  core_brace:        { family: "resistance", min_stage: "tissue_tolerance", label: "anti-movement core" },
  isometric_hold:    { family: "resistance", min_stage: "tissue_tolerance", label: "isometric hold" },
  calf_raise:        { family: "resistance", min_stage: "tissue_tolerance", label: "calf raise" },
  direct_arm:        { family: "resistance", min_stage: "tissue_tolerance", label: "direct arm work" },
  ballistic:         { family: "resistance", min_stage: "power",            label: "ballistic / plyometric" },
  // aerobic
  steady_state:      { family: "aerobic", min_stage: "tissue_tolerance", label: "easy steady state" },
  long_duration:     { family: "aerobic", min_stage: "capacity",         label: "long slow distance" },
  tempo:             { family: "aerobic", min_stage: "capacity",         label: "tempo" },
  threshold:         { family: "aerobic", min_stage: "load",             label: "threshold intervals" },
  aerobic_interval:  { family: "aerobic", min_stage: "load",             label: "aerobic intervals" },
  sprint_interval:   { family: "aerobic", min_stage: "power",            label: "sprint / VO2 intervals" },
  // skill_mobility
  mobility_flow:     { family: "skill_mobility", min_stage: "tissue_tolerance", label: "mobility flow" },
  end_range_hold:    { family: "skill_mobility", min_stage: "tissue_tolerance", label: "end-range hold" },
  activation:        { family: "skill_mobility", min_stage: "tissue_tolerance", label: "activation" },
  breathing:         { family: "skill_mobility", min_stage: "tissue_tolerance", label: "breathing / bracing drill" },
  balance_stability: { family: "skill_mobility", min_stage: "tissue_tolerance", label: "balance / stability" },
  positional_drill:  { family: "skill_mobility", min_stage: "capacity",         label: "loaded positional drill" },
  reactive_control:  { family: "skill_mobility", min_stage: "power",            label: "reactive control" },
};

function patternFamily(token) {
  var p = MOVEMENT_PATTERNS[token];
  return p ? p.family : null;
}
function isMovementPattern(token) { return !!MOVEMENT_PATTERNS[token]; }

/** All pattern tokens a (stage, family) envelope prescribes: family patterns whose
 *  min_stage is available at this stage. Pure, derived from MOVEMENT_PATTERNS. */
function prescribedPatterns(stage, family) {
  var rank = patternStageRank(stage);
  return Object.keys(MOVEMENT_PATTERNS).filter(function (tok) {
    var p = MOVEMENT_PATTERNS[tok];
    return p.family === family && patternStageRank(p.min_stage) <= rank;
  });
}

// The envelopes. Keyed [family][stage]. Every number is code-owned. `session_fill`
// is the target WORKING minutes for a nominal 45-minute slot at this stage/family —
// sized against the existing 0.70 work floor (server/v2Planner.js). A stage whose
// fill is deliberately LOW (tissue_tolerance, maintenance, mobility) is the code's
// way of saying "a full slot is NOT expected here — A2 shortens the session, it
// does not pad it" (the §6 thinness reframe, resolved by construction not by the
// model padding). NOTE: session_fill is DATA for A2; A1 neither reads it into the
// planner nor enforces it.
var STAGE_ENVELOPES = {
  resistance: {
    tissue_tolerance: { working_sets: [2, 4], duration_band: null, intensity_band: "RPE 4-6 / 40-55% 1RM or bodyweight", rep_scheme: "isometric holds 20-45s, or controlled 8-15 reps kept 3-4 reps shy of failure", modality_mix: "isometrics + low-load controlled patterns; NO ballistic", session_fill: 22, evidence: "established", note: "Tolerance is built with time-under-tension and control, not near-failure volume. A full 45-min slot is not expected — shorten the session rather than pad it." },
    capacity:         { working_sets: [3, 5], duration_band: null, intensity_band: "RPE 6-7 / 55-70% 1RM", rep_scheme: "10-15 reps at 1-3 RIR", modality_mix: "full-ROM base patterns, hypertrophy-oriented volume", session_fill: 33, evidence: "established" },
    load:             { working_sets: [3, 6], duration_band: null, intensity_band: "RPE 7-9 / 75-90% 1RM on primaries", rep_scheme: "3-8 reps, low RIR on primaries, back-off accessories", modality_mix: "heavy compound primaries + supporting accessories", session_fill: 34, evidence: "established" },
    power:            { working_sets: [3, 6], duration_band: null, intensity_band: "high velocity 30-60% 1RM (ballistic) or >85% (strength-speed)", rep_scheme: "1-5 explosive reps, full rest between sets", modality_mix: "ballistic + heavy strength; measured by output, not volume", session_fill: 30, evidence: "established", note: "Low-rep, long-rest work; quality over accumulated sets." },
    return_to_sport:  { working_sets: [3, 6], duration_band: null, intensity_band: "sport-specific loading, full ROM, reactive", rep_scheme: "sport-specific loading + plyometric progressions", modality_mix: "all patterns including ballistic + reactive", session_fill: 33, evidence: "established" },
    maintenance:      { working_sets: [1, 2], duration_band: null, intensity_band: ">=80% 1RM — intensity is the lever", rep_scheme: "1-2 hard sets, volume cut", modality_mix: "minimum effective dose; hold intensity, cut volume", session_fill: 15, evidence: "established", note: "MED: a maintenance slot is short by design." },
  },
  aerobic: {
    tissue_tolerance: { working_sets: null, duration_band: [10, 20], intensity_band: "very easy, zone 1, fully conversational", rep_scheme: "continuous easy effort", modality_mix: "low-impact steady state", session_fill: 15, evidence: "established", note: "Short, easy re-introduction of aerobic load; shorten the slot, do not pad." },
    capacity:         { working_sets: null, duration_band: [20, 45], intensity_band: "zone 2 aerobic base", rep_scheme: "continuous steady state, building duration", modality_mix: "steady state + long slow distance", session_fill: 30, evidence: "established" },
    load:             { working_sets: null, duration_band: [25, 50], intensity_band: "zone 3-4, tempo / threshold", rep_scheme: "tempo blocks + threshold intervals", modality_mix: "tempo, threshold, aerobic intervals", session_fill: 33, evidence: "established" },
    power:            { working_sets: null, duration_band: [20, 40], intensity_band: "zone 5, VO2 / anaerobic intervals", rep_scheme: "short hard intervals, full recovery", modality_mix: "sprint / VO2 intervals + threshold support", session_fill: 28, evidence: "established" },
    return_to_sport:  { working_sets: null, duration_band: [20, 60], intensity_band: "sport-specific work:rest ratios", rep_scheme: "game-simulation intervals", modality_mix: "sport-specific conditioning", session_fill: 33, evidence: "established" },
    maintenance:      { working_sets: null, duration_band: [13, 26], intensity_band: "intensity maintained, duration cut", rep_scheme: "2x/week, intensity held", modality_mix: "MED aerobic", session_fill: 15, evidence: "established" },
  },
  skill_mobility: {
    tissue_tolerance: { working_sets: [2, 4], duration_band: null, intensity_band: "pain-free end range, gentle", rep_scheme: "end-range holds 20-45s + activation 10-15 reps", modality_mix: "activation + mobility flow + breathing", session_fill: 18, evidence: "established", note: "Rehab/mobility slots are legitimately short — shorten the session, do not pad." },
    capacity:         { working_sets: [2, 5], duration_band: null, intensity_band: "loaded end range, controlled tempo", rep_scheme: "controlled reps + positional drills", modality_mix: "loaded mobility + positional drills", session_fill: 25, evidence: "contested", note: "Retention timelines for passive range are poorly characterised (mirrors MAINTENANCE_MED.mobility)." },
    load:             { working_sets: [3, 5], duration_band: null, intensity_band: "weighted end range under control", rep_scheme: "weighted mobility + stability under load", modality_mix: "loaded end-range strength", session_fill: 28, evidence: "contested" },
    power:            { working_sets: [3, 5], duration_band: null, intensity_band: "dynamic / reactive control", rep_scheme: "reactive stability + dynamic control drills", modality_mix: "reactive control + balance", session_fill: 25, evidence: "contested" },
    return_to_sport:  { working_sets: [3, 5], duration_band: null, intensity_band: "sport-position specific", rep_scheme: "sport-specific mobility + stability", modality_mix: "sport-position specific control", session_fill: 28, evidence: "contested" },
    maintenance:      { working_sets: [2, 3], duration_band: null, intensity_band: "true end range >=2x/week", rep_scheme: "end-range holds", modality_mix: "MED mobility", session_fill: 12, evidence: "contested" },
  },
};

/**
 * The single envelope lookup. Returns a shallow copy with prescribed_patterns
 * attached (derived, never stored). Pure. Every (stage, family) pair exists.
 * @returns {object|null} null only for an unknown stage/family (a caller bug).
 */
function envelopeFor(stage, family) {
  if (!isStage(stage) || MODALITY_FAMILIES.indexOf(family) < 0) return null;
  var base = STAGE_ENVELOPES[family] && STAGE_ENVELOPES[family][stage];
  if (!base) return null;
  return {
    stage: stage,
    modality_family: family,
    working_sets: base.working_sets,
    duration_band: base.duration_band,
    intensity_band: base.intensity_band,
    rep_scheme: base.rep_scheme,
    modality_mix: base.modality_mix,
    session_fill: base.session_fill,
    prescribed_patterns: prescribedPatterns(stage, family),
    evidence: base.evidence,
    note: base.note || null,
  };
}

// Exit-criteria vocabulary — the CLOSED metric/comparator sets the authoring
// validator clamps to and the three-state resolver reads. `pr_field` names the
// progression-state field a metric reads (null for derived metrics resolved
// specially). `kind` drives resolution: value (read a PR), count (sessions in
// window), trend (the computed trend).
var CRITERION_METRICS = {
  best_hold_seconds:    { pr_field: "best_hold_seconds",    kind: "value", unit: "seconds" },
  best_weight_lbs:      { pr_field: "best_weight_lbs",      kind: "value", unit: "lbs" },
  best_reps:            { pr_field: "best_reps",            kind: "value", unit: "reps" },
  best_session_minutes: { pr_field: "best_session_minutes", kind: "value", unit: "minutes" },
  sessions_logged:      { pr_field: null,                   kind: "count", unit: "sessions" },
  trend:                { pr_field: null,                   kind: "trend", unit: null },
};
var CRITERION_COMPARATORS = ["gte", "lte", "eq", "trend_up", "trend_flat_or_up"];
function isCriterionMetric(m) { return !!CRITERION_METRICS[m]; }
function isCriterionComparator(c) { return CRITERION_COMPARATORS.indexOf(c) >= 0; }

// ── Metric-fits-pattern (A2 — folded A1 follow-up) ──────────────────────────
// A criterion whose METRIC does not fit its referent pattern's LOGGED SHAPE can
// NEVER evaluate no matter how much is trained — the permanent-hold bug arriving
// through a different door than the envelope check. Example found live: a
// `best_hold_seconds` criterion on `vertical_pull` (a pull-up logs reps, never a
// hold). The referent constraint guarantees measurability against the envelope;
// this guarantees the metric fits the pattern.
//
// The taxonomy is derived from what the LOG actually carries, not invented. The
// four VALUE metrics ARE the four measurable `exercises` columns:
//   reps          -> best_reps          (rep-based)
//   weight_lbs    -> best_weight_lbs    (load-based)
//   duration_min  -> best_hold_seconds  (hold, for strength/rehab categories)
//                 -> best_session_minutes (session length, for cardio/skill categories)
//   distance_mi   -> (no criterion metric today)
// Each pattern's set below is which of those columns that movement plausibly
// populates. sessions_logged (count) and trend are ALWAYS allowed — any pattern
// is logged as sessions, and a trend rides whatever dominant metric it produces.
//
// IMPORTANT distinction, load-bearing: this rejects a SHAPE mismatch (a pull-up
// can never be a hold), NOT a data gap. A `best_weight_lbs` criterion on
// `hip_bridge` is ALLOWED here (a hip thrust CAN be loaded) even if the athlete
// has so far logged only bodyweight bridges — that is a not-yet-logged data gap
// A2 closes by prescribing weighted bridges, and the resolver correctly reports
// it UNEVALUABLE-until-logged. Only impossible-by-shape pairs are rejected.
var PATTERN_VALUE_METRICS = {
  // resistance — rep + load
  squat:            ["best_reps", "best_weight_lbs"],
  hinge:            ["best_reps", "best_weight_lbs"],
  lunge:            ["best_reps", "best_weight_lbs"],
  hip_bridge:       ["best_reps", "best_weight_lbs"],
  horizontal_push:  ["best_reps", "best_weight_lbs"],
  vertical_push:    ["best_reps", "best_weight_lbs"],
  horizontal_pull:  ["best_reps", "best_weight_lbs"],
  vertical_pull:    ["best_reps", "best_weight_lbs"],
  calf_raise:       ["best_reps", "best_weight_lbs"],
  direct_arm:       ["best_reps", "best_weight_lbs"],
  ballistic:        ["best_reps", "best_weight_lbs"],
  carry:            ["best_weight_lbs", "best_session_minutes", "best_reps"], // load + time under load
  core_brace:       ["best_reps", "best_hold_seconds", "best_weight_lbs"],    // dead bug reps / plank holds / weighted
  isometric_hold:   ["best_hold_seconds", "best_weight_lbs"],                 // a hold, never reps
  // aerobic — session length (distance is not a criterion metric)
  steady_state:     ["best_session_minutes"],
  long_duration:    ["best_session_minutes"],
  tempo:            ["best_session_minutes"],
  threshold:        ["best_session_minutes"],
  aerobic_interval: ["best_session_minutes"],
  sprint_interval:  ["best_session_minutes"],
  // skill / mobility
  end_range_hold:   ["best_hold_seconds", "best_reps"],
  mobility_flow:    ["best_reps"],
  activation:       ["best_reps"],
  balance_stability:["best_reps", "best_hold_seconds"],
  positional_drill: ["best_reps"],
  reactive_control: ["best_reps"],
  breathing:        ["best_reps"],
};

function patternMetrics(token) { return PATTERN_VALUE_METRICS[token] || null; }

/**
 * Does this metric fit the pattern's logged shape? count (sessions_logged) and
 * trend always fit; a value metric must be one the pattern plausibly logs.
 * @returns {{ok:boolean, reason?:string}}
 */
function metricFitsPattern(metric, token) {
  var m = CRITERION_METRICS[metric];
  if (!m) return { ok: false, reason: "unknown metric '" + metric + "'" };
  if (m.kind !== "value") return { ok: true };   // count / trend fit any pattern
  var set = PATTERN_VALUE_METRICS[token];
  if (!set) return { ok: false, reason: "unknown pattern '" + token + "'" };
  if (set.indexOf(metric) >= 0) return { ok: true };
  return { ok: false, reason: "metric '" + metric + "' cannot be measured for pattern '" + token +
    "' — that movement logs " + set.join(" / ") + ", never " + metric + " (a shape mismatch, not a data gap)" };
}

// ── Cold-start default stage table (A1 item 6) ──────────────────────────────
// goal TYPE -> floor stage. Keyed by TYPE, NOT by injury: an injury changes which
// exercises fill the envelope, never which stage the goal starts at. A brand-new
// user with no history maps to the bottom of the plausible band for the type.
var COLD_START_RULES = [
  { match: /rehab|rehabilitation|post-?op|post-?surgery|prehab|injur|recover|tolerat|pain|osteitis|tendinop|physio|pt\b/i,
    stage: "tissue_tolerance", family: "resistance", basis: "rehab/injury-type goal -> tissue tolerance floor" },
  { match: /postur|mobilit|flexib|range of motion|\brom\b|stretch/i,
    stage: "tissue_tolerance", family: "skill_mobility", basis: "mobility/posture-type goal -> tissue tolerance (skill/mobility)" },
  { match: /experienc|returning|return to (lift|train)|advanced|comeback|get back/i,
    stage: "load", family: "resistance", basis: "self-reported experienced returner -> load" },
  { match: /endurance|stamina|cardio|aerobic|\brun|jog|\bhike|conditioning|\b5k\b|\b10k\b|marathon|cycl|\bbike\b|row(ing)?|swim/i,
    stage: "capacity", family: "aerobic", basis: "endurance/stamina-type goal -> capacity (aerobic)" },
  { match: /hypertroph|muscle|build|mass|strength|strong|tone|lean|novice|beginner|general fitness|fitness/i,
    stage: "capacity", family: "resistance", basis: "hypertrophy/general-strength-type goal -> capacity" },
];

/**
 * @param {string} goalTypeOrTitle — the goal's type/title text
 * @param {object} [opts] { experiencedReturner?:bool }
 * @returns {{stage:string, modality_family:string, basis:string}}
 */
function coldStartStage(goalTypeOrTitle, opts) {
  opts = opts || {};
  var t = String(goalTypeOrTitle || "");
  if (opts.experiencedReturner) {
    return { stage: "load", family: "resistance", basis: "explicitly flagged experienced returner -> load" };
  }
  for (var i = 0; i < COLD_START_RULES.length; i++) {
    if (COLD_START_RULES[i].match.test(t)) {
      return { stage: COLD_START_RULES[i].stage, family: COLD_START_RULES[i].family, basis: COLD_START_RULES[i].basis };
    }
  }
  // No clear signal -> the lowest plausible stage for a general goal.
  return { stage: "capacity", family: "resistance", basis: "no clear type signal -> lowest plausible general stage (capacity/resistance)" };
}

/**
 * Render the stage ladder + envelopes as prompt text. Built for A2's planner and
 * the backfill authoring prompt; NOT part of renderRulesForPrompt, so the current
 * planner prompt is unchanged. @param {string[]} [families] subset to render.
 */
function renderStageEnvelopesForPrompt(families) {
  var fams = Array.isArray(families) && families.length ? families : MODALITY_FAMILIES;
  var L = ["TRAINING-STAGE ENVELOPES (the code owns these ranges; author exercise selection + loads INSIDE them):",
    "Stages, low to high: " + STAGE_LADDER.join(" -> ") + " (plus maintenance, a parallel track)."];
  fams.forEach(function (fam) {
    L.push("");
    L.push(fam.toUpperCase() + ":");
    STAGES.forEach(function (stage) {
      var e = envelopeFor(stage, fam);
      if (!e) return;
      var vol = e.working_sets ? (e.working_sets[0] + "-" + e.working_sets[1] + " working sets")
        : (e.duration_band ? (e.duration_band[0] + "-" + e.duration_band[1] + " min") : "n/a");
      L.push("  - " + stage + ": " + vol + "; " + e.intensity_band + "; " + e.rep_scheme +
        "; mix: " + e.modality_mix + "; target working fill ~" + e.session_fill + " min/45" +
        (e.evidence === "contested" ? " [CONTESTED" + (e.note ? " — " + e.note : "") + "]" : (e.note ? " (" + e.note + ")" : "")));
    });
  });
  return L.join("\n");
}

/** Per-family char counts of the stage-envelope text, for the promptSections discipline. */
function stageEnvelopeLengths(families) {
  var fams = Array.isArray(families) && families.length ? families : MODALITY_FAMILIES;
  var out = {};
  fams.forEach(function (fam) { out[fam] = renderStageEnvelopesForPrompt([fam]).length; });
  out._total = renderStageEnvelopesForPrompt(fams).length;
  return out;
}

/**
 * A2 — render the per-goal EFFECTIVE-STAGE envelopes for the planner / variant.
 * The stage passed in is the GATE-CLAMPED effective stage (never intended, never
 * the calendar phase), so with advancement disabled it is the current cleared
 * stage: the envelope fills the current stage's sessions and can never escalate.
 *
 * The `session_fill` line is how the §6 thinness is resolved by construction: a
 * low-fill stage (tissue_tolerance / maintenance / mobility) states an HONESTLY
 * SHORT session driven by the code envelope — NOT the model relabelling thin
 * content, and NOT the floor loosening.
 *
 * @param {Array} goalEnvelopes  [{ goal, tier, effective_stage, modality_family,
 *                                  week_pos:{weeks_elapsed, floor_weeks} }]
 */
function renderEffectiveEnvelopesForPrompt(goalEnvelopes) {
  var list = Array.isArray(goalEnvelopes) ? goalEnvelopes.filter(Boolean) : [];
  if (!list.length) return "";
  // Drivers first (they structure the week), then maintenance. NB: `|| 1` would
  // treat driver's rank of 0 as falsy — use an explicit null check.
  var order = { driver: 0, maintenance: 1, accessory: 2 };
  var rank = function (t) { return order[t] != null ? order[t] : 1; };
  list = list.slice().sort(function (a, b) { return rank(a.tier) - rank(b.tier); });

  var L = ["EFFECTIVE-STAGE ENVELOPES (fill each goal's sessions to ITS envelope — you choose exercises + loads INSIDE these code-owned bands; you do NOT change the bands, and you do NOT escalate past the stage shown):"];
  list.forEach(function (ge) {
    var e = envelopeFor(ge.effective_stage, ge.modality_family);
    if (!e) return;
    var vol = e.working_sets ? (e.working_sets[0] + "-" + e.working_sets[1] + " working sets per exercise")
      : (e.duration_band ? (e.duration_band[0] + "-" + e.duration_band[1] + " min continuous") : "n/a");
    var wp = "";
    if (ge.week_pos && ge.week_pos.weeks_elapsed != null) {
      wp = " (week " + (ge.week_pos.weeks_elapsed + 1) + " of ~" + (ge.week_pos.floor_weeks || "?") + " in this phase)";
    }
    L.push("- " + ge.goal + " [" + (ge.tier || "maintenance") + ", " + ge.modality_family +
      "] — current cleared stage: " + ge.effective_stage + wp + ". " +
      vol + "; " + e.intensity_band + "; " + e.rep_scheme + "; mix: " + e.modality_mix +
      ". Target real working content ~" + e.session_fill + " min per 45-min slot.");
  });
  L.push("SESSION-FILL RULE (this is how a session gets an honest length, and it REPLACES any instinct to pad or to relabel):");
  L.push("- A session serving a goal at capacity / load / power / return_to_sport should FILL a full slot with real work (enough sets/exercises to occupy the target working minutes above). Add sets and exercises, never empty minutes.");
  L.push("- A session serving ONLY a low-fill stage (tissue_tolerance, maintenance, or a mobility stage) is HONESTLY SHORT: set its duration_min to roughly its envelope's target working content, do NOT stretch it to a default length, and do NOT bolt on maintenance/accessory filler to reach one. The code says these stages fill less; a short honest session is correct here.");
  return L.join("\n");
}

// ── Session composition allocation (closes the §6 mixed-session thinness) ────
// A session serving multiple goals had NO allocation contract: nothing said how
// much of the slot belonged to the driver vs maintenance/accessory work, and
// nothing enforced that the driver's share was filled with driver-appropriate
// work FIRST. The model filled a Build-Muscle (capacity/resistance) slot with
// low-density rehab work (cat-cow / clamshell / 90-90 = skill_mobility) and the
// session came in thin. This adds a CODE-OWNED per-session allocation; the model
// fills exercises inside each share; a new invariant (v2Planner) enforces that
// the driver's modality actually fills its share.
//
// Reuses the A1/A2 envelopes (a goal's modality_family comes from its effective
// envelope) — this is "which envelopes apply and in what proportion", NOT a new
// envelope system.

// Default tier weights. Overridable per-profile via
// profile_data.session_composition.tier_weights (the preference SEAM — read only
// on the v2 path; a later settings control writes it, exactly like the Phase-6
// defaults picker writes profile_data.defaults). Untiered goals resolve to
// maintenance upstream (resolveTiers), so a NEW USER with zero config gets equal
// maintenance shares — sane composition automatically, no driver privileged.
var ALLOCATION_TIER_WEIGHTS = { driver: 3, maintenance: 1, accessory: 0.5 };

function resolveAllocationWeights(pref) {
  var w = { driver: ALLOCATION_TIER_WEIGHTS.driver, maintenance: ALLOCATION_TIER_WEIGHTS.maintenance, accessory: ALLOCATION_TIER_WEIGHTS.accessory };
  var tw = pref && pref.tier_weights;
  if (tw && typeof tw === "object") {
    ["driver", "maintenance", "accessory"].forEach(function (k) {
      if (typeof tw[k] === "number" && isFinite(tw[k]) && tw[k] >= 0) w[k] = tw[k];
    });
  }
  return w;
}

function allocNormTitle(t) { return String(t || "").toLowerCase().trim(); }

/** goal title -> { goal, tier, modality_family }, from v2GoalEnvelopes output. */
function buildGoalIndex(goalEnvelopes) {
  var idx = {};
  (Array.isArray(goalEnvelopes) ? goalEnvelopes : []).forEach(function (ge) {
    if (ge && ge.goal) idx[allocNormTitle(ge.goal)] = { goal: ge.goal, tier: ge.tier || "maintenance", modality_family: ge.modality_family || null };
  });
  return idx;
}

/**
 * The CODE-OWNED per-session allocation. Splits the slot's minutes across the
 * goals the session serves, by tier weight. Pure.
 *
 * @param {string[]} goalTags   the session's goal_tags (model-authored — see A2:
 *                              robust because the check keys off MODALITY dominance)
 * @param {number} durationMin
 * @param {object} goalIndex    from buildGoalIndex()
 * @param {object} weights      from resolveAllocationWeights()
 * @returns {Array} [{goal, tier, modality_family, weight, share_fraction, share_min}]
 */
function computeSessionAllocation(goalTags, durationMin, goalIndex, weights) {
  weights = weights || ALLOCATION_TIER_WEIGHTS;
  var dur = Number(durationMin) || 0;
  var entries = [];
  var seen = {};
  (Array.isArray(goalTags) ? goalTags : []).forEach(function (t) {
    var g = goalIndex[allocNormTitle(t)];
    if (!g) return;
    if (seen[allocNormTitle(t)]) return;
    seen[allocNormTitle(t)] = true;
    var w = (typeof weights[g.tier] === "number") ? weights[g.tier] : weights.maintenance;
    entries.push({ goal: g.goal, tier: g.tier, modality_family: g.modality_family, weight: w });
  });
  if (!entries.length) {
    // No known goals tagged — the whole slot is general work; no driver to enforce.
    return [{ goal: null, tier: "general", modality_family: null, weight: 1, share_fraction: 1, share_min: dur }];
  }
  var sumW = entries.reduce(function (a, e) { return a + e.weight; }, 0) || 1;
  entries.forEach(function (e) { e.share_fraction = e.weight / sumW; e.share_min = Math.round(e.share_fraction * dur); });
  return entries;
}

/** Prompt guidance — the model fills within the allocation; the code enforces it. */
function renderAllocationGuidance(goalEnvelopes, weights) {
  weights = weights || ALLOCATION_TIER_WEIGHTS;
  var L = ["SESSION COMPOSITION — allocate a multi-goal session's minutes, and FILL THE DRIVER'S SHARE FIRST (the code enforces this):"];
  L.push("- When a session serves more than one goal, split its minutes by tier weight: driver x" + weights.driver + ", maintenance x" + weights.maintenance + ", accessory x" + weights.accessory + " (normalized). The DRIVER goal gets the majority of the slot.");
  L.push("- Fill the driver's share with the DRIVER GOAL'S OWN envelope work (its modality — resistance / aerobic / skill_mobility) FIRST, to its ALLOCATED MINUTES. The code checks this in absolute terms: the driver's share-minutes must hold real driver-modality work (roughly 1 working set ~= 1.5 min). A 27-min driver share needs ~18 real working sets of driver work, NOT 3-4 token sets padded out with rehab. Only after the driver's minutes are genuinely filled do maintenance/accessory movements get the remainder.");
  L.push("- An accessory/mobility movement occupying the driver's share is WRONG: a resistance-driver (e.g. Build Muscle) session filled mostly with cat-cow / clamshell / 90-90 (skill_mobility) STARVES the driver and will be REJECTED and regenerated. Put the driver's compound/loaded work in first — enough sets to FILL its minutes — and rehab/mobility is the small remainder, not the bulk.");
  var drivers = (Array.isArray(goalEnvelopes) ? goalEnvelopes : []).filter(function (g) { return g.tier === "driver"; });
  if (drivers.length) {
    L.push("- This athlete's DRIVER goal(s) and the modality that must fill their share: " +
      drivers.map(function (g) { return g.goal + " -> " + g.modality_family; }).join("; ") + ".");
  }
  return L.join("\n");
}

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
  // training-stage ladder + envelopes (A1)
  STAGE_LADDER, STAGES, MODALITY_FAMILIES, MOVEMENT_PATTERNS, STAGE_ENVELOPES,
  stageIndex, patternStageRank, stageBelow, isStage,
  patternFamily, isMovementPattern, prescribedPatterns, envelopeFor,
  CRITERION_METRICS, CRITERION_COMPARATORS, isCriterionMetric, isCriterionComparator,
  PATTERN_VALUE_METRICS, patternMetrics, metricFitsPattern,
  COLD_START_RULES, coldStartStage,
  renderStageEnvelopesForPrompt, stageEnvelopeLengths, renderEffectiveEnvelopesForPrompt,
  // session composition allocation (closes §6 mixed-session thinness)
  ALLOCATION_TIER_WEIGHTS, resolveAllocationWeights, buildGoalIndex,
  computeSessionAllocation, renderAllocationGuidance,
};
