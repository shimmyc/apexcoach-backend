"use strict";
/**
 * ENGINE v2 — PROGRESSION STATE BUILDER
 * =====================================
 * Computed in CODE at generation time. There is no progression table — this is
 * derived fresh from `exercises` every time it is needed, so it can never go
 * stale relative to the log.
 *
 * Per exercise trained in the last 60 days:
 *   - last 3-5 instances (date + top set: load x reps / hold seconds / distance)
 *   - trend: up | flat | down
 *   - days_since_last
 *   - all three PR fields (best weight, best reps, best hold seconds)
 *   - the gap-decay adjustment from the rules module
 *   - the modality it progresses under, and its progression decision
 *
 * DELIBERATE DUPLICATION (approved Phase 1 decision, do not "fix")
 * ---------------------------------------------------------------
 * `GET /api/profiles/:id/exercises` computes best_weight / best_reps /
 * best_duration_seconds inline (server.js ~3883-3894). This module recomputes
 * them independently rather than extracting a shared helper. Two reasons:
 *   1. v1 isolation outranks DRY — profile 1 must stay byte-identical, and
 *      refactoring a live v1 endpoint's internals to serve v2 is exactly the
 *      shared-surface edit the build rules forbid.
 *   2. The windows differ anyway. v1 aggregates all history; v2 wants a 60-day
 *      window, the last 3-5 instances in order, and a trend — none of which
 *      that endpoint produces.
 *
 * DEPENDENCIES are injected (`deps`) rather than imported, so this module has
 * no circular require against server.js and no I/O of its own beyond the fetch
 * it is handed.
 *   deps = { fetch, SUPABASE_URL, sbHeaders, localToday }
 */

var rules = require("./coachingRules");

var DEFAULT_WINDOW_DAYS = 60;
var MAX_INSTANCES = 5;
var MIN_INSTANCES = 3;

// ── Modality inference ──────────────────────────────────────────────────────
// Which progression rule applies to this exercise. Keyword-based on the
// canonical name plus the shape of the logged data — an exercise logged with a
// hold duration and no reps is isometric regardless of its name.

var BARBELL_HINTS = /\b(barbell|bench press|back squat|front squat|deadlift|overhead press|ohp|clean|snatch|row(?!ing)|rdl|romanian)\b/i;
var CONDITIONING_HINTS = /\b(run|running|jog|sprint|row(ing)?|bike|cycl|elliptical|swim|walk|hike|ruck|interval|conditioning|cardio|jump rope|skipping)\b/i;
var ISOMETRIC_HINTS = /\b(hang|dead hang|plank|hold|isometric|wall sit|l-sit|bridge hold)\b/i;

// Categories where `duration_minutes` means SESSION LENGTH, not a hold.
// This distinction is load-bearing and was found by running against real data:
// a 60-minute MMA class and a 20-minute yoga session were both being read as
// isometric HOLDS, producing "PB 60:00 hold" and a progression instruction of
// "+5-10 s hold" on a sparring session. Duration only means a hold for
// strength/rehab-style movements (dead hang, plank, wall sit).
var SESSION_DURATION_CATEGORIES = ["cardio", "martial_arts", "sports", "mind_body"];

function isSessionDurationCategory(category) {
  return SESSION_DURATION_CATEGORIES.indexOf(String(category || "").toLowerCase()) >= 0;
}

/**
 * @param {string} name
 * @param {object} agg — the aggregated exercise (to read data shape)
 * @returns {'barbell'|'dumbbell_machine_bodyweight'|'isometric'|'conditioning'}
 */
function inferModality(name, agg) {
  var n = String(name || "");
  // Category first: a timed cardio/class/skill session progresses like
  // conditioning (duration then density), never like an isometric hold.
  if (agg && isSessionDurationCategory(agg.category)) return "conditioning";
  // Data shape next: a hold with no reps is isometric.
  if (agg && agg.best_duration_seconds && !agg.best_reps) return "isometric";
  if (agg && agg.has_distance && !agg.best_weight) return "conditioning";
  if (ISOMETRIC_HINTS.test(n)) return "isometric";
  if (CONDITIONING_HINTS.test(n)) return "conditioning";
  if (BARBELL_HINTS.test(n)) return "barbell";
  return "dumbbell_machine_bodyweight";
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function daysBetween(fromYmd, toYmd) {
  // Noon-anchored so a DST shift can never move the result by a day. Both
  // inputs are YYYY-MM-DD date-keys, never timestamps.
  var a = new Date(String(fromYmd) + "T12:00:00");
  var b = new Date(String(toYmd) + "T12:00:00");
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function fmtMMSS(totalSeconds) {
  var s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  var m = Math.floor(s / 60);
  var r = s % 60;
  return m + ":" + (r < 10 ? "0" : "") + r;
}

/**
 * A single logged row's "score" for trend purposes, and its display form.
 * Ordering is: weight x reps (volume-load) > reps > hold seconds > distance.
 * Only ever compares like with like — a row's score is only meaningful against
 * another row of the same metric, which is why `metric` travels with it.
 */
function topSetOf(row, category) {
  var w = num(row.weight_lbs);
  var reps = num(row.reps);
  var sets = num(row.sets);
  var durMin = num(row.duration_minutes);
  var dist = num(row.distance_miles);
  var sessionDuration = isSessionDurationCategory(category || row.main_category || row.category);
  var holdSec = (durMin != null && !sessionDuration) ? Math.round(durMin * 60) : null;

  // A timed cardio/class/skill session: report the session length as what it
  // is. Never a "hold", and never a hold PB.
  if (sessionDuration && durMin != null && w == null && reps == null) {
    return { metric: "session_minutes", score: durMin, display: Math.round(durMin) + " min session" };
  }

  if (w != null && reps != null) {
    return { metric: "load_x_reps", score: w * reps, display: w + " lb x " + reps + (sets ? " (" + sets + " sets)" : "") };
  }
  if (w != null) {
    return { metric: "load", score: w, display: w + " lb" };
  }
  if (holdSec != null) {
    return { metric: "hold_seconds", score: holdSec, display: fmtMMSS(holdSec) + " hold" };
  }
  if (dist != null) {
    return { metric: "distance_miles", score: dist, display: dist + " mi" };
  }
  if (reps != null) {
    return { metric: "reps", score: reps * (sets || 1), display: (sets ? sets + " x " : "") + reps + " reps" };
  }
  if (sets != null) {
    return { metric: "sets", score: sets, display: sets + " sets" };
  }
  return { metric: "none", score: null, display: "logged" };
}

/**
 * Trend across the instances, first-half vs second-half, comparing only rows
 * that share the dominant metric. Mirrors the approach getGoalExerciseContext()
 * already uses server-side, deliberately — a different trend definition in v2
 * would be a second source of truth about the same question.
 */
function computeTrend(instances) {
  var scored = instances
    .filter(function (i) { return i.top && i.top.score != null; })
    .slice()
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });   // oldest first
  if (scored.length < 2) return { trend: "flat", basis: "insufficient_data" };

  // Dominant metric = the one most rows use. Mixing load_x_reps with
  // hold_seconds would produce nonsense.
  var counts = {};
  scored.forEach(function (i) { counts[i.top.metric] = (counts[i.top.metric] || 0) + 1; });
  var dominant = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
  var same = scored.filter(function (i) { return i.top.metric === dominant; });
  if (same.length < 2) return { trend: "flat", basis: "insufficient_data" };

  var mid = Math.floor(same.length / 2);
  var firstHalf = same.slice(0, mid || 1);
  var secondHalf = same.slice(mid);
  var avg = function (arr) {
    return arr.reduce(function (s, i) { return s + i.top.score; }, 0) / arr.length;
  };
  var a = avg(firstHalf);
  var b = avg(secondHalf);
  if (!a) return { trend: "flat", basis: dominant };
  var pct = (b - a) / a;
  var trend = pct > 0.03 ? "up" : (pct < -0.03 ? "down" : "flat");
  return { trend: trend, basis: dominant, change_pct: Math.round(pct * 1000) / 10 };
}

// ── Main builder ────────────────────────────────────────────────────────────

/**
 * @param {object} deps  { fetch, SUPABASE_URL, sbHeaders, localToday }
 * @param {number|string} profileId
 * @param {object} [opts] { windowDays, today, effortByWorkoutId }
 * @returns {Promise<object>} progression state
 */
async function buildProgressionState(deps, profileId, opts) {
  opts = opts || {};
  var windowDays = opts.windowDays || DEFAULT_WINDOW_DAYS;
  var today = opts.today;                       // athlete-local YYYY-MM-DD, supplied by the caller
  var effortByWorkoutId = opts.effortByWorkoutId || {};

  if (!today) throw new Error("buildProgressionState requires opts.today (athlete-local date via localToday())");

  var cutoff = new Date(String(today) + "T12:00:00");
  cutoff.setDate(cutoff.getDate() - (windowDays - 1));
  var cutoffStr = cutoff.getFullYear() + "-" +
    String(cutoff.getMonth() + 1).padStart(2, "0") + "-" +
    String(cutoff.getDate()).padStart(2, "0");

  var url = deps.SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + encodeURIComponent(profileId) +
    "&date=gte." + cutoffStr +
    "&select=id,workout_id,date,name,category,main_category,sets,reps,weight_lbs,distance_miles,duration_minutes" +
    "&order=date.desc&limit=5000";

  var rows = [];
  try {
    var r = await deps.fetch(url, { headers: deps.sbHeaders() });
    var data = await r.json();
    rows = Array.isArray(data) ? data : [];
  } catch (e) {
    // Non-fatal, same degrade philosophy as the rest of this codebase: an empty
    // progression state is honest ("we know nothing"), a thrown error would
    // take down whatever is generating.
    return {
      window_days: windowDays, today: today, cutoff: cutoffStr,
      exercises: [], exercise_count: 0, error: e.message,
    };
  }

  // Group by canonical name.
  var byName = {};
  rows.forEach(function (row) {
    if (!row || !row.name) return;
    var g = byName[row.name];
    if (!g) {
      g = byName[row.name] = {
        name: row.name,
        category: row.main_category || row.category || null,
        instances: [],
        best_weight: null, best_reps: null, best_duration_seconds: null,
        best_session_minutes: null,
        has_distance: false,
      };
    }
    var w = num(row.weight_lbs);
    var reps = num(row.reps);
    var durMin = num(row.duration_minutes);
    var dist = num(row.distance_miles);
    if (w != null && (g.best_weight === null || w > g.best_weight)) g.best_weight = w;
    if (reps != null && (g.best_reps === null || reps > g.best_reps)) g.best_reps = reps;
    if (durMin != null) {
      // Session length and hold duration are tracked SEPARATELY. Collapsing
      // them is what produced "MMA Sparring PB 60:00 hold" against real data.
      if (isSessionDurationCategory(g.category)) {
        if (g.best_session_minutes === null || durMin > g.best_session_minutes) g.best_session_minutes = durMin;
      } else {
        var sec = Math.round(durMin * 60);
        if (g.best_duration_seconds === null || sec > g.best_duration_seconds) g.best_duration_seconds = sec;
      }
    }
    if (dist != null) g.has_distance = true;

    g.instances.push({
      date: row.date,
      workout_id: row.workout_id,
      top: topSetOf(row, g.category),
      effort: effortByWorkoutId[row.workout_id] || null,
    });
  });

  var out = [];
  Object.keys(byName).forEach(function (name) {
    var g = byName[name];

    // One instance per DATE (the top set of that day), newest first.
    var byDate = {};
    g.instances.forEach(function (i) {
      var cur = byDate[i.date];
      if (!cur || (i.top.score != null && cur.top.score != null && i.top.score > cur.top.score)) {
        byDate[i.date] = i;
      } else if (!cur) {
        byDate[i.date] = i;
      }
    });
    var dated = Object.keys(byDate).sort().reverse().map(function (d) { return byDate[d]; });
    var recent = dated.slice(0, MAX_INSTANCES);

    var lastDate = dated.length ? dated[0].date : null;
    var daysSince = lastDate ? daysBetween(lastDate, today) : null;
    var decay = rules.gapDecay(daysSince == null ? 0 : daysSince);
    var trendInfo = computeTrend(recent);
    var modality = inferModality(name, g);

    // Effort history, newest first, for the progression decision.
    var efforts = recent.map(function (i) { return i.effort; });

    // "Met prescription" is not knowable from the log alone — the log records
    // what was DONE, never what was PRESCRIBED. So it is inferred conservatively
    // from the trend, and the reason string says so rather than implying the
    // system knows something it does not.
    var metPrescription = trendInfo.trend === "up" || trendInfo.trend === "flat";
    var consecutiveMet = trendInfo.trend === "up" ? 2 : (trendInfo.trend === "flat" ? 1 : 0);

    var decision = rules.progressionDecision({
      modality: modality,
      metPrescription: metPrescription,
      consecutiveMetSessions: consecutiveMet,
      recentEfforts: efforts,
      trend: trendInfo.trend,
    });

    out.push({
      name: name,
      category: g.category,
      modality: modality,
      sessions_in_window: dated.length,
      last_date: lastDate,
      days_since_last: daysSince,
      instances: recent.map(function (i) {
        return { date: i.date, top_set: i.top.display, metric: i.top.metric, effort: i.effort };
      }),
      trend: trendInfo.trend,
      trend_basis: trendInfo.basis,
      trend_change_pct: trendInfo.change_pct === undefined ? null : trendInfo.change_pct,
      prs: {
        best_weight_lbs: g.best_weight,
        best_reps: g.best_reps,
        best_hold_seconds: g.best_duration_seconds,
        best_hold_display: g.best_duration_seconds ? fmtMMSS(g.best_duration_seconds) : null,
        best_session_minutes: g.best_session_minutes,
      },
      gap_decay: {
        band: decay.band,
        multiplier: decay.multiplier,
        action: decay.action,
        per_exercise_stale: decay.per_exercise_stale,
        evidence: decay.evidence,
      },
      progression: decision,
      insufficient_data: dated.length < MIN_INSTANCES,
    });
  });

  // Most recently trained first — the planner cares most about what is live.
  out.sort(function (a, b) {
    if (!a.last_date) return 1;
    if (!b.last_date) return -1;
    return a.last_date < b.last_date ? 1 : (a.last_date > b.last_date ? -1 : 0);
  });

  return {
    window_days: windowDays,
    today: today,
    cutoff: cutoffStr,
    exercise_count: out.length,
    raw_row_count: rows.length,
    exercises: out,
  };
}

/**
 * Compact prompt table. One line per exercise — this is what the planner and
 * autoregulator actually see, so it must stay dense.
 * @param {object} state
 * @param {number} [limit]
 */
function renderProgressionTable(state, limit) {
  if (!state || !state.exercises || !state.exercises.length) {
    return "PROGRESSION STATE: no exercises logged in the last " +
      ((state && state.window_days) || DEFAULT_WINDOW_DAYS) + " days.";
  }
  var list = limit ? state.exercises.slice(0, limit) : state.exercises;
  var lines = ["PROGRESSION STATE (last " + state.window_days + " days, " + state.exercise_count + " exercises):"];
  list.forEach(function (e) {
    var bits = [];
    bits.push(e.name);
    bits.push(e.sessions_in_window + (e.sessions_in_window === 1 ? " session" : " sessions"));
    bits.push("last " + (e.last_date || "?") + " (" + (e.days_since_last == null ? "?" : e.days_since_last) + "d ago)");
    var recent = e.instances.map(function (i) {
      return i.date + " " + i.top_set + (i.effort ? " [" + i.effort + "]" : "");
    }).join(" | ");
    if (recent) bits.push("recent: " + recent);
    bits.push("trend " + e.trend);
    var pr = [];
    if (e.prs.best_weight_lbs) pr.push(e.prs.best_weight_lbs + " lb");
    if (e.prs.best_reps) pr.push(e.prs.best_reps + " reps");
    if (e.prs.best_hold_display) pr.push(e.prs.best_hold_display + " hold");
    if (e.prs.best_session_minutes) pr.push(Math.round(e.prs.best_session_minutes) + " min longest session");
    if (pr.length) bits.push("PB " + pr.join(" / "));
    // A >6-week gap has a NULL multiplier (conservative restart, no single
    // number applies) — it must still be printed, or the longest layoffs would
    // be the only ones the prompt never hears about.
    if (e.gap_decay.multiplier === null) {
      bits.push("gap-decay: " + e.gap_decay.band + " — " + e.gap_decay.action);
    } else if (e.gap_decay.multiplier < 1) {
      bits.push("gap-decay x" + e.gap_decay.multiplier + " (" + e.gap_decay.band + ")");
    }
    bits.push("-> " + e.progression.action + ": " + e.progression.detail);
    lines.push("- " + bits.join(" · "));
  });
  return lines.join("\n");
}

module.exports = {
  buildProgressionState,
  renderProgressionTable,
  inferModality,
  topSetOf,
  computeTrend,
  DEFAULT_WINDOW_DAYS,
};
