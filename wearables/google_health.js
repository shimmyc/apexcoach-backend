/*
 * SETUP — Google Health API v4
 * This is the cloud REST API successor to the Fitbit Web API.
 * NOT the on-device Android Health Connect SDK (that has no cloud API).
 *
 * 1. Go to console.cloud.google.com → create or select a project
 * 2. Enable "Google Health API" in the API Library
 * 3. OAuth consent screen → set app name, support email
 *    Under Scopes: add the three googlehealth.* scopes below
 *    Under Audience → Test users: add each user's Gmail manually
 *    (required until Google restricted-scope review; cap = 100 users)
 * 4. Create OAuth 2.0 credentials → Web Application type
 *    Authorized redirect URIs:
 *      https://apexcoach-backend.onrender.com/callback/google_health
 *      http://localhost:3000/callback/google_health
 * 5. Set GOOGLE_HEALTH_CLIENT_ID and GOOGLE_HEALTH_CLIENT_SECRET on Render
 * 6. Do NOT add include_granted_scopes=true to the auth URL — breaks Health API
 * 7. Access tokens expire in 1 hour (vs Fitbit's 8h). Auto-refresh handled
 *    by getValidWearableToken in server.js.
 */

const fetch = require("node-fetch");

const PROVIDER = "google_health";

const BASE = "https://health.googleapis.com/v4";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

// Read-only scope bundle — covers everything ApexCoach needs
const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
].join(" ");

// ──────────────────────────────────────────────────────────────────────────
// Low-level helpers
// ──────────────────────────────────────────────────────────────────────────

function sleepMs(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function reconnectError(msg) {
  var e = new Error(msg);
  e.code = "RECONNECT_REQUIRED";
  e.status = 401;
  return e;
}

// GET ${BASE}${path}?{params}. 401 → RECONNECT_REQUIRED; 429 → wait 1s + retry
// once; other non-2xx → throw with status + body. Returns parsed JSON.
async function ghGet(token, path, params) {
  params = params || {};
  var qs = Object.keys(params)
    .filter(function (k) { return params[k] != null; })
    .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); })
    .join("&");
  var url = BASE + path + (qs ? "?" + qs : "");
  var opts = { headers: { "Authorization": "Bearer " + token } };

  var res = await fetch(url, opts);
  if (res.status === 401) throw reconnectError("Google Health 401 for " + path + " — reconnect required");
  if (res.status === 429) {
    await sleepMs(1000);
    res = await fetch(url, opts);
    if (res.status === 401) throw reconnectError("Google Health 401 for " + path + " — reconnect required");
  }
  if (!res.ok) {
    var body = await res.text();
    var err = new Error("Google Health " + res.status + " for " + path + ": " + body.substring(0, 200));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// POST ${BASE}${path} with a JSON body. Same error handling as ghGet.
async function ghPost(token, path, body) {
  var url = BASE + path;
  function doPost() {
    return fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body || {}),
    });
  }
  var res = await doPost();
  if (res.status === 401) throw reconnectError("Google Health 401 for " + path + " — reconnect required");
  if (res.status === 429) {
    await sleepMs(1000);
    res = await doPost();
    if (res.status === 401) throw reconnectError("Google Health 401 for " + path + " — reconnect required");
  }
  if (!res.ok) {
    var errBody = await res.text();
    var err = new Error("Google Health " + res.status + " for " + path + ": " + errBody.substring(0, 200));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ──────────────────────────────────────────────────────────────────────────
// Mapping helpers
// ──────────────────────────────────────────────────────────────────────────

// Strips a trailing "s" off a protobuf duration string ("120s") → 120 (number).
function parseDurationSeconds(s) {
  if (s == null) return null;
  var str = String(s).trim();
  if (str.charAt(str.length - 1) === "s") str = str.slice(0, -1);
  var v = parseFloat(str);
  return isFinite(v) ? v : null;
}

// UTC ISO timestamp → local YYYY-MM-DD. Applies startUtcOffset ("-18000s")
// when present; otherwise falls back to the server's local date.
function localDateFromUTC(isoString, utcOffset) {
  if (!isoString) return null;
  var ms = Date.parse(isoString);
  if (isNaN(ms)) return null;
  var offsetSec = utcOffset != null ? parseDurationSeconds(utcOffset) : null;
  if (offsetSec != null && isFinite(offsetSec)) {
    var shifted = new Date(ms + offsetSec * 1000);
    var y = shifted.getUTCFullYear();
    var m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
    var d = String(shifted.getUTCDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }
  try {
    return new Date(ms).toLocaleDateString("en-CA"); // en-CA → YYYY-MM-DD
  } catch (e) {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function durationMinutes(start, end) {
  if (!start || !end) return null;
  var diff = new Date(end) - new Date(start);
  if (isNaN(diff)) return null;
  return Math.round(diff / 60000);
}

// Health Connect HR-zone durations → ApexCoach zone-minute shape (seconds).
function buildZones(heartRateZoneDurations) {
  if (!heartRateZoneDurations) return null;
  return {
    peak: parseDurationSeconds(heartRateZoneDurations.peakTime),
    cardio: parseDurationSeconds(heartRateZoneDurations.vigorousTime),
    fatBurn: parseDurationSeconds(heartRateZoneDurations.moderateTime),
    outOfRange: parseDurationSeconds(heartRateZoneDurations.lightTime),
  };
}

const EXERCISE_TYPE_MAP = {
  WALKING: "Walk", RUNNING: "Run", BIKING: "Cycling",
  SWIMMING: "Swimming", HIKING: "Hike", YOGA: "Yoga",
  PILATES: "Pilates", WORKOUT: "Workout", HIIT: "HIIT",
  WEIGHTLIFTING: "Weightlifting", STRENGTH_TRAINING: "Strength Training",
  OTHER: "Workout",
};

function mapExerciseType(exerciseType, displayName) {
  // Many wearables file niche sessions (MMA/BJJ/boxing) as OTHER/WORKOUT but
  // keep a descriptive displayName — preserve it so the keyword matcher works.
  if (displayName && /martial arts|mma|bjj|kickbox|boxing/i.test(displayName)) {
    return displayName;
  }
  if (exerciseType && EXERCISE_TYPE_MAP[exerciseType]) return EXERCISE_TYPE_MAP[exerciseType];
  if (displayName) return displayName;
  if (exerciseType) {
    return String(exerciseType).replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  return "Workout";
}

// One exercise DataPoint → NormalizedActivity (see wearables/base.js).
function normalizeExercise(dp) {
  if (!dp) return null;
  var ex = dp.exercise || {};
  var ms = ex.metricsSummary || {};
  var interval = ex.interval || {};
  var distMeters = typeof ms.distanceMillimeters === "number" ? ms.distanceMillimeters / 1000 : null;
  return {
    provider: PROVIDER,
    provider_activity_id: dp.name ? String(dp.name).split("/").pop() : (dp.id || null),
    date: localDateFromUTC(interval.startTime, dp.startUtcOffset),
    start_time: interval.startTime || null,
    activity_type: mapExerciseType(ex.exerciseType, ex.displayName),
    duration_minutes: durationMinutes(interval.startTime, interval.endTime),
    distance_miles: distMeters != null ? +(distMeters / 1609.344).toFixed(2) : null,
    elevation_gain: null,
    steps: parseInt(ms.steps, 10) || null,
    calories: typeof ms.caloriesKcal === "number" ? ms.caloriesKcal : (parseFloat(ms.caloriesKcal) || null),
    avg_hr: parseInt(ms.averageHeartRateBeatsPerMinute, 10) || null,
    peak_hr: null, // not in summary; fetchActivityDetail backfills from HR samples
    min_hr: null,
    active_zone_minutes: parseInt(ms.activeZoneMinutes, 10) || null,
    zones: buildZones(ms.heartRateZoneDurations),
    heart_rate_samples: null,
    raw_response: dp,
    raw: dp, // legacy alias (matches fitbit adapter)
  };
}

// ──────────────────────────────────────────────────────────────────────────
// OAuth
// ──────────────────────────────────────────────────────────────────────────

function buildAuthUrl(redirectUri, profileId) {
  var params = {
    client_id: process.env.GOOGLE_HEALTH_CLIENT_ID || "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline", // required to receive a refresh_token
    state: profileId || "",
    // NB: deliberately no include_granted_scopes / prompt=consent (see SETUP §6)
  };
  var qs = Object.keys(params)
    .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); })
    .join("&");
  return AUTH_URL + "?" + qs;
}

async function refreshToken(refreshTokenValue) {
  if (!refreshTokenValue) throw reconnectError("No Google Health refresh token — reconnect required");
  var body = "grant_type=refresh_token"
    + "&client_id=" + encodeURIComponent(process.env.GOOGLE_HEALTH_CLIENT_ID || "")
    + "&client_secret=" + encodeURIComponent(process.env.GOOGLE_HEALTH_CLIENT_SECRET || "")
    + "&refresh_token=" + encodeURIComponent(refreshTokenValue);
  var res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body,
  });
  if (!res.ok) {
    var text = await res.text();
    var err = new Error("Google Health token refresh failed (" + res.status + "): " + text.substring(0, 200));
    if (res.status >= 400 && res.status < 500) err.code = "RECONNECT_REQUIRED";
    err.status = res.status;
    throw err;
  }
  var data = await res.json();
  return {
    access_token: data.access_token,
    // Google sometimes omits refresh_token on refresh — keep the old one if absent
    refresh_token: data.refresh_token || refreshTokenValue,
    expires_at: Date.now() + (data.expires_in * 1000) - 60000,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Activities (cross-provider matching path)
// ──────────────────────────────────────────────────────────────────────────

async function fetchActivities(token, startDate, endDate) {
  var filter = 'exercise.interval.start_time >= "' + startDate + 'T00:00:00Z"'
    + ' AND exercise.interval.start_time <= "' + endDate + 'T23:59:59Z"';
  var out = [];
  var pageToken = null;
  var safety = 0;
  do {
    var params = { filter: filter };
    if (pageToken) params.page_token = pageToken;
    var resp = await ghGet(token, "/users/me/dataTypes/exercise/dataPoints", params);
    var pts = (resp && resp.dataPoints) || [];
    for (var i = 0; i < pts.length; i++) {
      var n = normalizeExercise(pts[i]);
      if (n && n.date) out.push(n);
    }
    pageToken = resp && resp.nextPageToken ? resp.nextPageToken : null;
  } while (pageToken && safety++ < 20);
  return out;
}

async function fetchActivityDetail(token, activityId) {
  var dp = await ghGet(token, "/users/me/dataTypes/exercise/dataPoints/" + encodeURIComponent(activityId), {});
  var normalized = normalizeExercise(dp);
  if (!normalized) return null;

  // peak_hr isn't in the summary — derive it from the per-sample heart-rate
  // series over the exercise interval. Non-fatal: any failure leaves it null.
  try {
    var interval = (dp.exercise && dp.exercise.interval) || {};
    if (interval.startTime && interval.endTime) {
      var hrFilter = 'heart_rate.sample_time.physical_time >= "' + interval.startTime + '"'
        + ' AND heart_rate.sample_time.physical_time <= "' + interval.endTime + '"';
      var hrResp = await ghGet(token, "/users/me/dataTypes/heart-rate/dataPoints", { filter: hrFilter });
      var hrPts = (hrResp && hrResp.dataPoints) || [];
      var hi = null;
      for (var i = 0; i < hrPts.length; i++) {
        var bpmRaw = hrPts[i].heartRate && hrPts[i].heartRate.beatsPerMinute;
        var v = typeof bpmRaw === "number" ? bpmRaw : parseFloat(bpmRaw);
        if (isFinite(v) && (hi == null || v > hi)) hi = v;
      }
      if (hi != null) normalized.peak_hr = Math.round(hi);
    }
  } catch (e) {
    // peak_hr stays null
  }
  return normalized;
}

// ──────────────────────────────────────────────────────────────────────────
// Daily biometric summary (replaces buildDailyData for Google Health users)
// ──────────────────────────────────────────────────────────────────────────

function addDay(ymd) {
  var d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Picks the main night-sleep DataPoint and reduces it to the stage shape the
// readiness/sleep math expects. Returns null when there's no sleep at all.
function parseSleep(resp) {
  var pts = (resp && resp.dataPoints) || [];
  if (!pts.length) return null;

  var main = null;
  for (var i = 0; i < pts.length; i++) {
    var meta = pts[i].sleep && pts[i].sleep.metadata;
    if (meta && meta.main === true && meta.nap !== true) { main = pts[i]; break; }
  }
  if (!main) {
    var bestMin = -1;
    for (var j = 0; j < pts.length; j++) {
      var sm = pts[j].sleep && pts[j].sleep.summary;
      var asleep = sm && sm.minutesAsleep != null ? parseFloat(sm.minutesAsleep) : 0;
      if (isFinite(asleep) && asleep > bestMin) { bestMin = asleep; main = pts[j]; }
    }
  }
  if (!main) return null;

  var summary = (main.sleep && main.sleep.summary) || {};
  var stages = summary.stagesSummary || [];
  function stageMin(type) {
    for (var k = 0; k < stages.length; k++) {
      if (stages[k] && stages[k].type === type) {
        var m = parseFloat(stages[k].minutes);
        return isFinite(m) ? m : null;
      }
    }
    return null;
  }
  var asleepMin = summary.minutesAsleep != null ? parseFloat(summary.minutesAsleep) : null;
  var hours = (asleepMin != null && isFinite(asleepMin)) ? +(asleepMin / 60).toFixed(2) : null;
  var deep = stageMin("DEEP");
  var rem = stageMin("REM");
  var light = stageMin("LIGHT");
  var wake = stageMin("AWAKE");

  // Full STAGES sleep (DEEP+REM+LIGHT present) → return stage minutes. CLASSIC
  // sleep (only ASLEEP/RESTLESS) → hours only, stage minutes null.
  if (deep != null && rem != null && light != null) {
    return {
      hours: hours,
      deep_minutes: deep,
      rem_minutes: rem,
      light_minutes: light,
      wake_minutes: wake,
      asleep_minutes: (asleepMin != null && isFinite(asleepMin)) ? asleepMin : null,
    };
  }
  return {
    hours: hours,
    deep_minutes: null,
    rem_minutes: null,
    light_minutes: null,
    wake_minutes: null,
    asleep_minutes: (asleepMin != null && isFinite(asleepMin)) ? asleepMin : null,
  };
}

async function fetchDailyData(token, ymd) {
  var nextDay = addDay(ymd);
  var parts = String(ymd).split("-");
  var Y = parseInt(parts[0], 10);
  var M = parseInt(parts[1], 10);
  var D = parseInt(parts[2], 10);

  // 1. HRV (Daily type — Daily types don't support the "=" filter operator, so
  //    list with page_size=1 and rely on the API returning the most recent
  //    daily record; its date is verified against `ymd` below before use.)
  var hrvP = ghGet(token, "/users/me/dataTypes/daily-heart-rate-variability/dataPoints", {
    page_size: 1,
  });
  // 2. RHR (Daily type — same page_size=1 / most-recent approach as HRV.)
  var rhrP = ghGet(token, "/users/me/dataTypes/daily-resting-heart-rate/dataPoints", {
    page_size: 1,
  });
  // 3. Sleep (Session type — reconcile for wearable data)
  var sleepP = ghGet(token, "/users/me/dataTypes/sleep/dataPoints:reconcile", {
    dataSourceFamily: "users/me/dataSourceFamilies/google-wearables",
    filter: 'sleep.interval.civil_end_time >= "' + ymd + '" AND sleep.interval.civil_end_time < "' + nextDay + '"',
  });
  // 4 + 5. Steps + Active Zone Minutes (dailyRollUp — POST)
  var rollupBody = {
    range: {
      start: { date: { year: Y, month: M, day: D }, time: { hours: 0 } },
      end: { date: { year: Y, month: M, day: D }, time: { hours: 23, minutes: 59, seconds: 59 } },
    },
    windowSizeDays: 1,
  };
  var stepsP = ghPost(token, "/users/me/dataTypes/steps/dataPoints:dailyRollUp", rollupBody);
  var azmP = ghPost(token, "/users/me/dataTypes/active-zone-minutes/dataPoints:dailyRollUp", rollupBody);
  // 6. Weight (list)
  var weightP = ghGet(token, "/users/me/dataTypes/weight/dataPoints", {
    filter: 'weight.sample_time.physical_time >= "' + ymd + 'T00:00:00Z" AND weight.sample_time.physical_time < "' + nextDay + 'T00:00:00Z"',
  });

  var settled = await Promise.allSettled([hrvP, rhrP, sleepP, stepsP, azmP, weightP]);
  var hrvRes = settled[0], rhrRes = settled[1], sleepRes = settled[2];
  var stepsRes = settled[3], azmRes = settled[4], weightRes = settled[5];

  // Debug: log the raw response (or error) from each parallel call so we can
  // see exactly what each Google Health endpoint returned for this date.
  function _ghLog(label, r) {
    if (r.status === "fulfilled") {
      console.log("[google_health] " + label + " raw: " + JSON.stringify(r.value).slice(0, 200));
    } else {
      var msg = r.reason && r.reason.message ? r.reason.message : String(r.reason);
      console.log("[google_health] " + label + " error: " + String(msg).slice(0, 200));
    }
  }
  _ghLog("hrv", hrvRes);
  _ghLog("rhr", rhrRes);
  _ghLog("sleep", sleepRes);
  _ghLog("steps", stepsRes);
  _ghLog("azm", azmRes);

  // Daily records carry their calendar date either as a "YYYY-MM-DD" string or
  // a { year, month, day } object — at the dataPoint level or nested under the
  // daily payload. Normalize to "YYYY-MM-DD" so we can compare against `ymd`.
  function _dailyDate(dp, payload) {
    var d = (dp && dp.date) || (payload && payload.date) || null;
    if (!d) return null;
    if (typeof d === "string") return d.slice(0, 10);
    if (typeof d === "object" && d.year) {
      return d.year + "-" + String(d.month || 1).padStart(2, "0") + "-" + String(d.day || 1).padStart(2, "0");
    }
    return null;
  }

  // HRV — use the most recent daily record only if it's for `ymd`. If the
  // record's date can't be determined, use it anyway (page_size=1 → most recent).
  var hrv = null;
  if (hrvRes.status === "fulfilled") {
    var hpts = (hrvRes.value && hrvRes.value.dataPoints) || [];
    if (hpts.length && hpts[0].dailyHeartRateVariability) {
      var hrvPayload = hpts[0].dailyHeartRateVariability;
      var hrvDate = _dailyDate(hpts[0], hrvPayload);
      if (hrvDate && hrvDate !== ymd) {
        console.log("[google_health] hrv skipped — record date " + hrvDate + " != " + ymd);
      } else {
        var hv = hrvPayload.averageHeartRateVariabilityMilliseconds;
        var hvn = typeof hv === "number" ? hv : parseFloat(hv);
        hrv = isFinite(hvn) ? hvn : null;
      }
    }
  }
  // RHR — same most-recent-with-date-check approach.
  var rhr = null;
  if (rhrRes.status === "fulfilled") {
    var rpts = (rhrRes.value && rhrRes.value.dataPoints) || [];
    if (rpts.length && rpts[0].dailyRestingHeartRate) {
      var rhrPayload = rpts[0].dailyRestingHeartRate;
      var rhrDate = _dailyDate(rpts[0], rhrPayload);
      if (rhrDate && rhrDate !== ymd) {
        console.log("[google_health] rhr skipped — record date " + rhrDate + " != " + ymd);
      } else {
        var rv = parseInt(rhrPayload.beatsPerMinute, 10);
        rhr = isFinite(rv) ? rv : null;
      }
    }
  }
  // Sleep
  var sleepData = sleepRes.status === "fulfilled" ? parseSleep(sleepRes.value) : null;
  // Steps — dailyRollUp responses live in `rollupDataPoints`. The count may be
  // nested as rollupDataPoints[0].steps.count OR directly as rollupDataPoints[0].count
  // depending on the rollup shape — try both, and log the raw item.
  var steps = null;
  if (stepsRes.status === "fulfilled") {
    var stepsRollup = stepsRes.value && stepsRes.value.rollupDataPoints;
    console.log('[google_health] steps rollupDataPoints[0]:', JSON.stringify(stepsRollup && stepsRollup[0]).slice(0, 300));
    var stepsItem = stepsRollup && stepsRollup[0];
    var stepsVal = (stepsItem && stepsItem.steps && stepsItem.steps.count != null) ? stepsItem.steps.count
                 : (stepsItem && stepsItem.count != null) ? stepsItem.count
                 : null;
    if (stepsVal != null) {
      var sv = parseInt(stepsVal, 10);
      steps = isFinite(sv) ? sv : null;
    }
  }
  // Active Zone Minutes — dailyRollUp → `rollupDataPoints`; one item per zone.
  // Each item's value may be nested as activeZoneMinutes.activeZoneMinutes OR be
  // the activeZoneMinutes field directly — try both, summing across all items.
  var activeZoneMinutes = null;
  if (azmRes.status === "fulfilled") {
    var azmRollup = (azmRes.value && azmRes.value.rollupDataPoints) || [];
    console.log('[google_health] azm rollupDataPoints[0]:', JSON.stringify(azmRollup[0]).slice(0, 300));
    var sum = 0, any = false;
    for (var i = 0; i < azmRollup.length; i++) {
      var azmObj = azmRollup[i] && azmRollup[i].activeZoneMinutes;
      var val = (azmObj && azmObj.activeZoneMinutes != null) ? azmObj.activeZoneMinutes
              : (azmObj != null && typeof azmObj !== "object") ? azmObj
              : null;
      if (val != null) {
        var av = parseInt(val, 10);
        if (isFinite(av)) { sum += av; any = true; }
      }
    }
    activeZoneMinutes = any ? sum : null;
  }
  // Weight — most recent sample in the window.
  var weightData = null;
  if (weightRes.status === "fulfilled") {
    var wpts = (weightRes.value && weightRes.value.dataPoints) || [];
    if (wpts.length) {
      var wlast = wpts[wpts.length - 1];
      var grams = wlast.weight && wlast.weight.weightGrams;
      var gn = typeof grams === "number" ? grams : parseFloat(grams);
      if (isFinite(gn)) weightData = { weight_lbs: +(gn / 453.592).toFixed(1), body_fat_pct: null };
    }
  }

  return {
    hrv: hrv,
    rhr: rhr,
    steps: steps,
    activeZoneMinutes: activeZoneMinutes,
    sleep: sleepData || null,
    weight: weightData || null,
    source: "google_health",
  };
}

// Stable per-user identity (used to key/verify connections). Best-effort.
async function getIdentity(token) {
  try {
    var resp = await ghGet(token, "/users/me/identity", {});
    return {
      healthUserId: (resp && resp.healthUserId) || null,
      legacyUserId: (resp && resp.legacyUserId) || null,
    };
  } catch (e) {
    return null;
  }
}

// Optional contract method: normalize a raw list/detail payload (used by the
// merge/import path). Pass-through if already normalized.
function normalize(rawActivity) {
  if (!rawActivity) return null;
  if (rawActivity.provider) return rawActivity;
  return normalizeExercise(rawActivity);
}

module.exports = {
  provider: PROVIDER,
  label: "Google Health",
  fetchActivities: fetchActivities,
  fetchActivityDetail: fetchActivityDetail,
  fetchDailyData: fetchDailyData,
  refreshToken: refreshToken,
  buildAuthUrl: buildAuthUrl,
  getIdentity: getIdentity,
  normalize: normalize,
};
