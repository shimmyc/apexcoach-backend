"use strict";
/**
 * ENGINE v2 — ATHLETE DOSSIER BUILDER
 * ===================================
 * Builds the compact, structured athlete dossier persisted to
 * `profiles.dossier` (<= ~2k chars serialized). Maintained by the nightly job,
 * NEVER rebuilt per-call.
 *
 * THE LOAD-BEARING DESIGN RULE
 * ----------------------------
 * Every derived FLAG is computed in CODE from the log. The model is used for
 * exactly one thing — phrasing prose fields — and only AFTER the code-derived
 * flags are settled. The model never decides whether a lift is stalled, whether
 * a movement is neglected, or what the athlete's injuries are. That split is
 * what makes the human-feel strings ("haven't trained X in 5 weeks") trustworthy:
 * code detected it, the model only phrased it.
 *
 * REUSE
 * -----
 * `getFullExerciseContext()` already computes top exercises, inactive
 * exercises (>=6 weeks), category breakdown and consistency server-side. It is
 * passed in rather than reimplemented. Only what it does NOT provide is
 * computed here: stalled lifts, pain/injury flags, equipment/time reality,
 * novelty_pref, notable PBs and standing schedule constraints.
 *
 * DEPENDENCIES are injected:
 *   deps = { fetch, SUPABASE_URL, sbHeaders, localToday, callAISystem, MODEL_HAIKU }
 */

var rules = require("./coachingRules");

var DOSSIER_TARGET_CHARS = 2000;
var DOSSIER_HARD_CAP_CHARS = 2600;

// ── Small helpers ───────────────────────────────────────────────────────────

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function daysBetween(fromYmd, toYmd) {
  var a = new Date(String(fromYmd) + "T12:00:00");
  var b = new Date(String(toYmd) + "T12:00:00");
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function trim(s, n) {
  s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── Code-derived flag builders ──────────────────────────────────────────────

/**
 * Injury / pain flags from profile_data.injuries plus recent check-in soreness.
 * Structured as {area, status, aggravators, last_user_report}.
 * NOTE: `status` is descriptive only and is never a diagnosis — the strings are
 * deliberately about LOAD TOLERANCE, matching the Silbernagel rules.
 */
function buildInjuryFlags(profileData, checkins, today) {
  var out = [];
  var injuries = (profileData && profileData.injuries) || [];

  injuries.forEach(function (inj) {
    var area, detail;
    if (typeof inj === "string") { area = inj; detail = ""; }
    else { area = inj.area || inj.name || inj.title || "unspecified"; detail = inj.notes || inj.description || inj.status || ""; }
    out.push({
      area: trim(area, 60),
      status: trim(detail, 90) || "declared in profile, no recent report",
      aggravators: trim((inj && inj.aggravators) || "", 80) || null,
      last_user_report: null,
    });
  });

  // Fold in the most recent check-in soreness per area.
  (checkins || []).forEach(function (c) {
    var sore = c.soreness;
    if (!sore) return;
    if (typeof sore === "string") { try { sore = JSON.parse(sore); } catch (e) { sore = [sore]; } }
    if (!Array.isArray(sore)) return;
    sore.forEach(function (areaName) {
      if (!areaName || String(areaName).toLowerCase() === "none") return;
      var age = daysBetween(c.date, today);
      var existing = out.filter(function (f) {
        return f.area.toLowerCase().indexOf(String(areaName).toLowerCase()) >= 0 ||
               String(areaName).toLowerCase().indexOf(f.area.toLowerCase()) >= 0;
      })[0];
      var report = String(areaName) + (c.severity ? " (" + c.severity + ")" : "") +
        (age != null ? ", " + age + "d ago" : "");
      if (existing) {
        if (!existing.last_user_report) existing.last_user_report = report;
      } else {
        out.push({
          area: trim(String(areaName), 60),
          status: "reported sore in a check-in, not a declared injury",
          aggravators: null,
          last_user_report: report,
        });
      }
    });
  });

  return out.slice(0, 8);
}

/**
 * Stalled lifts: trained recently enough to still be live, but no progression
 * for > STALL_WEEKS_FOR_STALLED_FLAG weeks. Driven entirely off the progression
 * state so the two can never disagree.
 */
function buildStalledLifts(progressionState) {
  var stallDays = rules.STALL_WEEKS_FOR_STALLED_FLAG * 7;
  var out = [];
  (progressionState.exercises || []).forEach(function (e) {
    if (e.insufficient_data) return;
    if (e.trend === "up") return;
    if (e.sessions_in_window < 2) return;
    var span = null;
    if (e.instances.length >= 2) {
      span = daysBetween(e.instances[e.instances.length - 1].date, e.instances[0].date);
    }
    if (span != null && span >= stallDays) {
      out.push({
        name: e.name,
        trend: e.trend,
        weeks_flat: Math.round((span / 7) * 10) / 10,
        sessions: e.sessions_in_window,
      });
    }
  });
  return out.slice(0, 8);
}

/** Neglected movements: untouched > NEGLECT_WEEKS_FOR_FLAG weeks. */
function buildNeglected(fullExerciseContext) {
  var out = [];
  var inactive = (fullExerciseContext && fullExerciseContext.inactive_exercises) || [];
  inactive.forEach(function (i) {
    var weeks = num(i.weeks_since_last);
    if (weeks != null && weeks >= rules.NEGLECT_WEEKS_FOR_FLAG) {
      out.push({ name: i.name, weeks_since_last: weeks });
    }
  });
  out.sort(function (a, b) { return b.weeks_since_last - a.weeks_since_last; });
  return out.slice(0, 8);
}

/** Notable PBs — only ones that actually carry a number. */
function buildNotablePBs(progressionState) {
  var out = [];
  (progressionState.exercises || []).forEach(function (e) {
    var p = e.prs || {};
    if (p.best_hold_seconds) out.push({ name: e.name, pb: p.best_hold_display + " hold", metric: "hold" });
    else if (p.best_weight_lbs) out.push({ name: e.name, pb: p.best_weight_lbs + " lb", metric: "load" });
    else if (p.best_reps) out.push({ name: e.name, pb: p.best_reps + " reps", metric: "reps" });
  });
  return out.slice(0, 10);
}

/** Equipment / location / time reality — from profile_data + top-level columns. */
function buildEquipmentReality(profileData, profileRow) {
  var pd = profileData || {};
  var eq = pd.equipment;
  if (Array.isArray(eq)) eq = eq.join(", ");
  return {
    equipment: trim(eq || "", 160) || null,
    gym_access: (profileRow && profileRow.gym_access) || null,
    gym_type: (profileRow && profileRow.gym_type) || null,
    typical_day: trim(pd.typical_day || "", 140) || null,
    weekly_target: pd.weekly_target == null ? null : pd.weekly_target,
  };
}

/** Standing schedule constraints, read off the live v2 schedule shape. */
function buildScheduleConstraints(profileData) {
  var sched = (profileData && profileData.schedule) || {};
  var anchors = sched.anchors || {};
  var out = [];
  Object.keys(anchors).forEach(function (day) {
    var list = anchors[day];
    if (!Array.isArray(list)) list = list ? [list] : [];
    list.forEach(function (a) {
      if (!a) return;
      out.push({
        day: day,
        activity: trim(a.activity || "", 50),
        duration_min: a.duration == null ? null : a.duration,
      });
    });
  });
  var targets = Array.isArray(sched.frequency_targets) ? sched.frequency_targets : [];
  return {
    anchors: out.slice(0, 10),
    weekly_targets: targets.slice(0, 8).map(function (t) {
      return { activity: trim(t.activity || "", 50), times_per_week: t.times_per_week || null };
    }),
    fill_policy: sched.fill_policy || null,
  };
}

/**
 * novelty_pref — explicit setting if present, otherwise INFERRED from how much
 * exercise variety the athlete actually shows. Inference is marked as such so
 * the planner knows it is a guess, not a stated preference.
 */
function resolveNoveltyPref(profileData, progressionState) {
  var explicit = profileData && (profileData.novelty_pref || (profileData.defaults && profileData.defaults.novelty_pref));
  if (explicit && rules.NOVELTY_PREFS.indexOf(explicit) >= 0) {
    return { value: explicit, source: "explicit" };
  }
  var n = progressionState.exercise_count || 0;
  var value = n > 40 ? "varied" : (n < 15 ? "same" : "mostly_same");
  return { value: value, source: "inferred_from_" + n + "_distinct_exercises_in_60d" };
}

// ── Main builder ────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {number|string} profileId
 * @param {object} ctx
 *   ctx.today                 athlete-local YYYY-MM-DD (REQUIRED)
 *   ctx.profileRow            the profiles row (profile_data + body columns)
 *   ctx.progressionState      output of buildProgressionState()
 *   ctx.fullExerciseContext   output of getFullExerciseContext()
 *   ctx.checkins              recent daily_checkins rows
 *   ctx.withProse             boolean — run the Haiku prose pass
 * @returns {Promise<object>} { dossier, serialized, chars, prose_used, warnings }
 */
async function buildDossier(deps, profileId, ctx) {
  ctx = ctx || {};
  if (!ctx.today) throw new Error("buildDossier requires ctx.today (athlete-local date via localToday())");

  var profileRow = ctx.profileRow || {};
  var pd = profileRow.profile_data || {};
  var ps = ctx.progressionState || { exercises: [], exercise_count: 0 };
  var warnings = [];

  var novelty = resolveNoveltyPref(pd, ps);

  var dossier = {
    v: 1,
    generated_for: ctx.today,
    injury_flags: buildInjuryFlags(pd, ctx.checkins, ctx.today),
    refusals_preferences: [],           // prose pass may fill; code has no source for this yet
    equipment_time_reality: buildEquipmentReality(pd, profileRow),
    novelty_pref: novelty.value,
    novelty_pref_source: novelty.source,
    stalled_lifts: buildStalledLifts(ps),
    neglected_movements: buildNeglected(ctx.fullExerciseContext),
    notable_pbs: buildNotablePBs(ps),
    schedule_constraints: buildScheduleConstraints(pd),
    consistency: (ctx.fullExerciseContext && ctx.fullExerciseContext.consistency) || null,
    category_mix: (ctx.fullExerciseContext && ctx.fullExerciseContext.category_breakdown) || null,
  };

  // ── Prose pass (Haiku), AFTER the code flags are settled ──────────────────
  // Only phrases what code already detected. It is given the flags and asked
  // for short human-readable lines; it is explicitly told not to add facts.
  var proseUsed = false;
  if (ctx.withProse && deps.callAISystem) {
    try {
      var sys = "You write two SHORT fields for an athlete dossier used by a coaching engine. " +
        "You are given facts ALREADY DERIVED FROM THE ATHLETE'S TRAINING LOG BY CODE. " +
        "Your ONLY job is phrasing. Do NOT add, infer, or invent any fact that is not in the input — " +
        "no new injuries, no new exercises, no numbers that are not given to you. " +
        "Return STRICT JSON only: {\"summary\":\"...\",\"coaching_notes\":\"...\"}. " +
        "summary: at most 220 characters, one or two sentences describing this athlete's current training reality. " +
        "coaching_notes: at most 220 characters, the two or three things a coach should keep front of mind. " +
        "Plain language. No markdown. No preamble.";
      var user = JSON.stringify({
        injury_flags: dossier.injury_flags,
        stalled_lifts: dossier.stalled_lifts,
        neglected_movements: dossier.neglected_movements,
        notable_pbs: dossier.notable_pbs.slice(0, 5),
        consistency: dossier.consistency,
        equipment_time_reality: dossier.equipment_time_reality,
      });
      var raw = await deps.callAISystem(sys, user, 400, deps.MODEL_HAIKU);
      var parsed = null;
      try {
        var t = String(raw || "").trim();
        if (t.indexOf("```") >= 0) t = t.replace(/```+\s*json|```+/gi, "").trim();
        var s = t.indexOf("{"), e2 = t.lastIndexOf("}");
        if (s >= 0 && e2 > s) parsed = JSON.parse(t.slice(s, e2 + 1));
      } catch (pe) { parsed = null; }
      if (parsed && (parsed.summary || parsed.coaching_notes)) {
        dossier.summary = trim(parsed.summary || "", 240);
        dossier.coaching_notes = trim(parsed.coaching_notes || "", 240);
        proseUsed = true;
      } else {
        warnings.push("prose pass returned unparseable output; dossier written without prose fields");
      }
    } catch (e) {
      warnings.push("prose pass failed (non-fatal): " + e.message);
    }
  }

  // ── Size discipline ──────────────────────────────────────────────────────
  // Trim the elastic lists first, never the injury flags — an injury dropped
  // for length is a safety problem, not a formatting one.
  var serialized = JSON.stringify(dossier);
  var trimOrder = ["notable_pbs", "neglected_movements", "stalled_lifts"];
  var ti = 0;
  while (serialized.length > DOSSIER_HARD_CAP_CHARS && ti < trimOrder.length) {
    var key = trimOrder[ti];
    if (Array.isArray(dossier[key]) && dossier[key].length > 3) {
      dossier[key] = dossier[key].slice(0, 3);
      warnings.push("trimmed " + key + " to 3 entries for size");
    } else {
      ti++;
    }
    serialized = JSON.stringify(dossier);
  }
  if (serialized.length > DOSSIER_HARD_CAP_CHARS) {
    warnings.push("dossier still " + serialized.length + " chars after trimming — over the " +
      DOSSIER_HARD_CAP_CHARS + " hard cap. Injury flags and schedule constraints are never trimmed.");
  } else if (serialized.length > DOSSIER_TARGET_CHARS) {
    warnings.push("dossier " + serialized.length + " chars — over the ~" + DOSSIER_TARGET_CHARS +
      " target but under the hard cap; acceptable.");
  }

  return {
    dossier: dossier,
    serialized: serialized,
    chars: serialized.length,
    prose_used: proseUsed,
    warnings: warnings,
  };
}

/** Compact prompt rendering of a dossier. */
function renderDossierForPrompt(dossier) {
  if (!dossier) return "ATHLETE DOSSIER: none built yet.";
  var L = ["ATHLETE DOSSIER (code-derived flags; refreshed nightly, not per call):"];
  if (dossier.summary) L.push("- " + dossier.summary);
  if (dossier.injury_flags && dossier.injury_flags.length) {
    L.push("- Injury/pain: " + dossier.injury_flags.map(function (f) {
      return f.area + " (" + f.status + (f.last_user_report ? "; last reported " + f.last_user_report : "") + ")";
    }).join("; "));
  }
  var eq = dossier.equipment_time_reality || {};
  var eqBits = [];
  if (eq.equipment) eqBits.push(eq.equipment);
  if (eq.gym_access) eqBits.push("gym access: " + eq.gym_access + (eq.gym_type ? " (" + eq.gym_type + ")" : ""));
  if (eq.weekly_target) eqBits.push("weekly target: " + eq.weekly_target);
  if (eqBits.length) L.push("- Equipment/time: " + eqBits.join("; "));
  L.push("- Novelty preference: " + dossier.novelty_pref + " (" + dossier.novelty_pref_source + ")");
  if (dossier.stalled_lifts && dossier.stalled_lifts.length) {
    L.push("- Stalled (>" + rules.STALL_WEEKS_FOR_STALLED_FLAG + " wk no progression): " +
      dossier.stalled_lifts.map(function (s) { return s.name + " (" + s.weeks_flat + " wk " + s.trend + ")"; }).join("; "));
  }
  if (dossier.neglected_movements && dossier.neglected_movements.length) {
    L.push("- Neglected (>" + rules.NEGLECT_WEEKS_FOR_FLAG + " wk untouched): " +
      dossier.neglected_movements.map(function (n) { return n.name + " (" + n.weeks_since_last + " wk)"; }).join("; "));
  }
  if (dossier.notable_pbs && dossier.notable_pbs.length) {
    L.push("- Notable PBs: " + dossier.notable_pbs.map(function (p) { return p.name + " " + p.pb; }).join("; "));
  }
  var sc = dossier.schedule_constraints || {};
  if (sc.anchors && sc.anchors.length) {
    L.push("- Fixed commitments: " + sc.anchors.map(function (a) {
      return a.day + " " + a.activity + (a.duration_min ? " " + a.duration_min + "min" : "");
    }).join("; "));
  }
  if (dossier.coaching_notes) L.push("- Coach note: " + dossier.coaching_notes);
  return L.join("\n");
}

module.exports = {
  buildDossier,
  renderDossierForPrompt,
  DOSSIER_TARGET_CHARS,
  DOSSIER_HARD_CAP_CHARS,
  // exported for testing / reuse
  buildInjuryFlags, buildStalledLifts, buildNeglected, buildNotablePBs,
  buildEquipmentReality, buildScheduleConstraints, resolveNoveltyPref,
};
