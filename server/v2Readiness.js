"use strict";
/**
 * ENGINE v2 — READINESS STATE
 * ===========================
 * Readiness computed against THIS ATHLETE'S OWN ROLLING BASELINE, never a
 * population absolute. That is a rules-module requirement, not a preference:
 * an HRV of 45 means nothing without knowing whose it is.
 *
 * NO WEARABLE DEPENDENCY. Profile 4 has no live wearable connection by design
 * (approved Phase 1 option (a)), so everything here is derived from stored
 * `daily_sleep` rows plus `daily_checkins`. No live provider call is made and
 * an absent or erroring wearable path cannot fail or block this.
 *
 * Dependency-injected: deps = { fetch, SUPABASE_URL, sbHeaders }.
 */

var rules = require("./coachingRules");

var BASELINE_WINDOW_DAYS = 30;

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function mean(arr) {
  var v = arr.filter(function (x) { return x != null; });
  if (!v.length) return null;
  return v.reduce(function (a, b) { return a + b; }, 0) / v.length;
}

function ymdMinus(today, days) {
  var d = new Date(String(today) + "T12:00:00");
  d.setDate(d.getDate() - days);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/**
 * @param {object} deps
 * @param {number|string} profileId
 * @param {object} opts { today }
 */
async function buildReadinessState(deps, profileId, opts) {
  opts = opts || {};
  var today = opts.today;
  if (!today) throw new Error("buildReadinessState requires opts.today");

  var since = ymdMinus(today, BASELINE_WINDOW_DAYS);
  var sleepRows = [];
  try {
    var r = await deps.fetch(deps.SUPABASE_URL + "/rest/v1/daily_sleep?profile_id=eq." +
      encodeURIComponent(profileId) + "&date=gte." + since +
      "&select=date,hours,score,deep_minutes,rem_minutes,light_minutes,wake_minutes,hrv,rhr" +
      "&order=date.desc&limit=60", { headers: deps.sbHeaders() });
    var d = await r.json();
    sleepRows = Array.isArray(d) ? d : [];
  } catch (e) {
    sleepRows = [];
  }

  var checkin = null;
  try {
    var cr = await deps.fetch(deps.SUPABASE_URL + "/rest/v1/daily_checkins?profile_id=eq." +
      encodeURIComponent(profileId) + "&order=date.desc&limit=3", { headers: deps.sbHeaders() });
    var cd = await cr.json();
    if (Array.isArray(cd) && cd.length) {
      // Only today's or yesterday's check-in is a readiness signal; older is history.
      var fresh = cd.filter(function (c) { return c.date === today || c.date === ymdMinus(today, 1); });
      checkin = fresh.length ? fresh[0] : null;
    }
  } catch (e) { /* non-fatal */ }

  if (!sleepRows.length) {
    return {
      available: false,
      today: today,
      reason: "no daily_sleep rows in the last " + BASELINE_WINDOW_DAYS + " days",
      checkin: checkin,
      modification: rules.readinessModification({
        score: null, personalBaseline: null,
        consecutiveBelowBaselineDays: 0,
        subjectiveState: checkin ? (checkin.energy || "") + " " + (checkin.checkin_text || "") : null,
      }),
    };
  }

  var latest = sleepRows[0];
  var hrvs = sleepRows.map(function (r2) { return num(r2.hrv); });
  var rhrs = sleepRows.map(function (r2) { return num(r2.rhr); });
  var scores = sleepRows.map(function (r2) { return num(r2.score); });

  var baseline = {
    hrv: mean(hrvs), rhr: mean(rhrs), sleep_score: mean(scores),
    window_days: BASELINE_WINDOW_DAYS, samples: sleepRows.length,
  };

  // Consecutive days at/below the personal HRV baseline, walking back from the
  // most recent row. Rows are date-desc; a missing day breaks nothing (a sync
  // gap is not evidence of a low day, so it simply ends the count).
  var consecutiveLowHrv = 0;
  if (baseline.hrv != null) {
    for (var i = 0; i < sleepRows.length; i++) {
      var h = num(sleepRows[i].hrv);
      if (h == null) break;
      if (h < baseline.hrv) consecutiveLowHrv++; else break;
    }
  }

  var latestScore = num(latest.score);
  var subjective = checkin
    ? [checkin.energy, checkin.severity, checkin.checkin_text].filter(Boolean).join(" ")
    : null;

  var modification = rules.readinessModification({
    score: latestScore,
    personalBaseline: baseline.sleep_score,
    consecutiveBelowBaselineDays: consecutiveLowHrv,
    subjectiveState: subjective,
  });

  return {
    available: true,
    today: today,
    latest: {
      date: latest.date,
      is_today: latest.date === today,
      sleep_score: latestScore,
      hours: num(latest.hours),
      hrv: num(latest.hrv),
      rhr: num(latest.rhr),
      deep_minutes: num(latest.deep_minutes),
    },
    baseline: baseline,
    deltas: {
      hrv_vs_baseline: (num(latest.hrv) != null && baseline.hrv != null) ? Math.round((num(latest.hrv) - baseline.hrv) * 10) / 10 : null,
      rhr_vs_baseline: (num(latest.rhr) != null && baseline.rhr != null) ? Math.round((num(latest.rhr) - baseline.rhr) * 10) / 10 : null,
      sleep_score_vs_baseline: (latestScore != null && baseline.sleep_score != null) ? Math.round((latestScore - baseline.sleep_score) * 10) / 10 : null,
    },
    consecutive_days_hrv_below_baseline: consecutiveLowHrv,
    checkin: checkin ? {
      date: checkin.date, energy: checkin.energy,
      soreness: checkin.soreness, severity: checkin.severity,
      text: checkin.checkin_text,
    } : null,
    modification: modification,
    source: "daily_sleep + daily_checkins (no live wearable call)",
  };
}

/** Compact prompt block. Every figure is relative to the athlete's own baseline. */
function renderReadinessBlock(rd) {
  if (!rd) return "READINESS: unavailable.";
  var L = ["READINESS (personal-baseline-relative — never compare these to population norms):"];
  if (!rd.available) {
    L.push("- No stored sleep data in the last 30 days. Treat readiness as UNKNOWN: do not assume it is good, and do not reduce load on an assumption either.");
  } else {
    var l = rd.latest, b = rd.baseline, d = rd.deltas;
    L.push("- Most recent sleep row: " + l.date + (l.is_today ? " (today)" : " (NOT today — this is the latest available, treat with that in mind)"));
    if (l.sleep_score != null) L.push("  sleep score " + l.sleep_score + " vs personal baseline " + (b.sleep_score == null ? "?" : Math.round(b.sleep_score)) + " (" + (d.sleep_score_vs_baseline > 0 ? "+" : "") + d.sleep_score_vs_baseline + ")");
    if (l.hrv != null) L.push("  HRV " + l.hrv + " vs baseline " + (b.hrv == null ? "?" : Math.round(b.hrv * 10) / 10) + " (" + (d.hrv_vs_baseline > 0 ? "+" : "") + d.hrv_vs_baseline + ")");
    if (l.rhr != null) L.push("  RHR " + l.rhr + " vs baseline " + (b.rhr == null ? "?" : Math.round(b.rhr * 10) / 10) + " (" + (d.rhr_vs_baseline > 0 ? "+" : "") + d.rhr_vs_baseline + " — higher is worse)");
    L.push("  baseline computed from " + b.samples + " night(s) in the last " + b.window_days + " days");
    L.push("- Consecutive days with HRV below personal baseline: " + rd.consecutive_days_hrv_below_baseline);
  }
  if (rd.checkin) {
    var c = rd.checkin;
    var sore = Array.isArray(c.soreness) ? c.soreness.join(", ") : (c.soreness || "");
    L.push("- Athlete check-in (" + c.date + "): energy " + (c.energy || "?") +
      (sore ? "; sore: " + sore + (c.severity ? " (" + c.severity + ")" : "") : "") +
      (c.text ? "; \"" + String(c.text).slice(0, 160) + "\"" : ""));
    L.push("  A subjective report of feeling wrecked VETOES a green wearable score. The athlete knows something the numbers do not.");
  } else {
    L.push("- No recent check-in submitted.");
  }
  L.push("- RULES VERDICT (computed in code, follow it): " + rd.modification.action +
    " [tag: " + rd.modification.tag + "] because " + rd.modification.reason + ".");
  return L.join("\n");
}

module.exports = { buildReadinessState, renderReadinessBlock, BASELINE_WINDOW_DAYS };
