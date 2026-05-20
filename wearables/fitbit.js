// Fitbit adapter — full implementation.
//
// Reuses the OAuth credentials already configured for the legacy Fitbit
// integration (env: FITBIT_CLIENT_ID / FITBIT_CLIENT_SECRET). Token
// storage lives in the wearable_connections table; the surrounding
// endpoint code handles load/save/refresh — this module only owns the
// outbound HTTP and the normalization mapping.

const fetch = require("node-fetch");

const PROVIDER = "fitbit";
const FITBIT_BASE = "https://api.fitbit.com";
const TOKEN_URL = FITBIT_BASE + "/oauth2/token";

function basicAuth() {
  var id = process.env.FITBIT_CLIENT_ID;
  var secret = process.env.FITBIT_CLIENT_SECRET;
  return Buffer.from(id + ":" + secret).toString("base64");
}

async function fitGet(endpoint, token) {
  var res = await fetch(FITBIT_BASE + endpoint, {
    headers: { "Authorization": "Bearer " + token },
  });
  if (!res.ok) {
    var body = await res.text();
    var err = new Error("Fitbit " + res.status + " for " + endpoint + ": " + body.substring(0, 200));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Normalize one /activities/list.json or /activities/{id}.json entry
// into the cross-provider NormalizedActivity shape. Detail enrichment
// (intraday HR, min/peak from samples) happens in fetchActivityDetail
// — list rows are normalized as far as the list endpoint can take them.
function normalize(activity) {
  if (!activity) return null;
  var startISO = activity.startTime || activity.originalStartTime || null;
  var date = startISO ? String(startISO).slice(0, 10) : null;
  // Fitbit's duration is in milliseconds.
  var durationMin = activity.duration ? Math.round(activity.duration / 60000) : null;

  // Zone minutes can live in `activeZoneMinutes.totalMinutes` (newer
  // accounts) or be summed from heartRateZones[]. Try both.
  var azm = null;
  if (activity.activeZoneMinutes && typeof activity.activeZoneMinutes.totalMinutes === "number") {
    azm = activity.activeZoneMinutes.totalMinutes;
  }

  // Zones come back as either heartRateZones[] or heartRateZonesNew[].
  // Reshape to {fatBurn, cardio, peak} in minutes, but ALSO keep the
  // raw zone array so per-provider variations (out-of-range, custom
  // zones, calorie subtotals) survive into wearable_data.zones_raw.
  var zonesRaw = activity.heartRateZones || activity.heartRateZonesNew || null;
  var zones = null;
  if (Array.isArray(zonesRaw) && zonesRaw.length) {
    zones = { fatBurn: 0, cardio: 0, peak: 0, out_of_range: 0, raw: zonesRaw };
    for (var i = 0; i < zonesRaw.length; i++) {
      var z = zonesRaw[i];
      if (!z || !z.name) continue;
      var key = String(z.name).toLowerCase().replace(/\s+/g, "");
      if (key === "fatburn") zones.fatBurn = z.minutes || 0;
      else if (key === "cardio") zones.cardio = z.minutes || 0;
      else if (key === "peak") zones.peak = z.minutes || 0;
      else if (key === "outofrange") zones.out_of_range = z.minutes || 0;
    }
    if (azm === null) azm = zones.fatBurn + zones.cardio + zones.peak;
  }

  return {
    provider: PROVIDER,
    provider_activity_id: String(activity.logId || activity.activityId || ""),
    date: date,
    start_time: startISO,
    activity_type: activity.activityName || activity.name || "Activity",
    duration_minutes: durationMin,
    distance_miles: typeof activity.distance === "number" ? +activity.distance.toFixed(2) : null,
    elevation_gain: typeof activity.elevationGain === "number" ? activity.elevationGain : null,
    steps: typeof activity.steps === "number" ? activity.steps : null,
    calories: typeof activity.calories === "number" ? activity.calories : null,
    avg_hr: typeof activity.averageHeartRate === "number" ? activity.averageHeartRate : null,
    peak_hr: typeof activity.maxHeartRate === "number" ? activity.maxHeartRate
            : typeof activity.peakHeartRate === "number" ? activity.peakHeartRate
            : null,
    min_hr: null,                  // populated by intraday enrichment
    active_zone_minutes: azm,
    zones: zones,
    heart_rate_samples: null,      // populated by intraday enrichment — array of { t, bpm }
    raw_response: activity,
    // Legacy alias kept so older callers that read `raw` still work.
    raw: activity,
  };
}

// List activities between startDate and endDate (inclusive, YYYY-MM-DD).
// Fitbit's list endpoint uses `afterDate` + sort=asc + limit/offset, so we
// page until either the cursor passes endDate or we run out of results.
// 100 is the API max for limit.
async function fetchActivities(accessToken, startDate, endDate) {
  var out = [];
  var offset = 0;
  var limit = 100;
  var safety = 0;
  while (safety++ < 10) {
    var url = "/1/user/-/activities/list.json?afterDate=" + startDate
      + "&sort=asc&limit=" + limit + "&offset=" + offset;
    var resp = await fitGet(url, accessToken);
    var arr = resp && resp.activities ? resp.activities : [];
    if (!arr.length) break;
    var stop = false;
    for (var i = 0; i < arr.length; i++) {
      var n = normalize(arr[i]);
      if (!n || !n.date) continue;
      if (n.date > endDate) { stop = true; break; }
      if (n.date < startDate) continue;  // afterDate is inclusive, defensive
      out.push(n);
    }
    if (stop || arr.length < limit) break;
    offset += limit;
  }
  // Each item is a full NormalizedActivity — the list endpoint carries
  // averageHeartRate / heartRateZones / calories, which normalize() maps to
  // avg_hr / peak_hr / zones / calories AND keeps verbatim in raw_response.
  // The merge/import path uses these to backfill the HR fields that the
  // /activities/{id}.json detail endpoint omits.
  return out;
}

async function fetchActivityDetail(accessToken, providerActivityId) {
  // Fitbit's per-activity endpoint is /1/user/-/activities/{logId}.json
  // — returns the same shape as a list entry plus richer HR/zone data.
  var resp = await fitGet("/1/user/-/activities/" + providerActivityId + ".json", accessToken);
  var act = (resp && resp.activityLog) ? resp.activityLog : resp;
  var normalized = normalize(act);
  if (!normalized) return null;

  // Intraday HR enrichment. The /heart/date/{d}/1d/1min/time/.../json
  // endpoint requires the "Personal" app type AND the heartrate scope on
  // the token (which the legacy OAuth flow grants). Network/permission
  // failure is non-fatal — we just leave heart_rate_samples = null.
  try {
    var samples = await fetchIntradayHr(accessToken, normalized);
    if (samples && samples.length) {
      normalized.heart_rate_samples = samples;
      // Re-derive min / peak from the samples — these are more accurate
      // than the activity-level rollups, which average over the entire
      // session including cooldown.
      var lo = Infinity, hi = -Infinity;
      for (var i = 0; i < samples.length; i++) {
        var v = samples[i].bpm;
        if (typeof v === "number") {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (isFinite(lo)) normalized.min_hr = lo;
      if (isFinite(hi) && (!normalized.peak_hr || hi > normalized.peak_hr)) normalized.peak_hr = hi;
    }
  } catch (e) {
    // Personal-tier limitation: intraday HR may be denied. Swallow.
    normalized.heart_rate_samples = null;
  }
  return normalized;
}

// Windowed intraday HR fetch — pulls per-minute bpm for the activity's
// time range only (not the whole day) to keep the payload small.
//
// Endpoint:
//   GET /1/user/-/activities/heart/date/{date}/1d/1min/time/{HH:mm}/{HH:mm}.json
//   → response.activities-heart-intraday.dataset[] = [{ time: "HH:mm:ss", value: bpm }]
//
// We translate start_time + duration_minutes into the HH:mm window.
async function fetchIntradayHr(accessToken, normalized) {
  if (!normalized.start_time || !normalized.duration_minutes) return null;
  // The start_time is ISO with timezone; we only need the wall-clock
  // hours/minutes since the endpoint is scoped by date.
  var startMs = Date.parse(normalized.start_time);
  if (isNaN(startMs)) return null;
  var endMs = startMs + normalized.duration_minutes * 60000;
  var startISO = new Date(startMs).toISOString();
  var endISO = new Date(endMs).toISOString();
  var startHHMM = startISO.slice(11, 16);
  var endHHMM = endISO.slice(11, 16);
  var url = "/1/user/-/activities/heart/date/" + normalized.date
    + "/1d/1min/time/" + startHHMM + "/" + endHHMM + ".json";
  var resp = await fitGet(url, accessToken);
  var ds = resp && resp["activities-heart-intraday"] && resp["activities-heart-intraday"].dataset;
  if (!Array.isArray(ds) || !ds.length) return null;
  // Compact shape — { t: epoch_ms, bpm } so consumers can chart without
  // re-parsing time strings. Cap at 600 samples (10 hours @ 1/min) to
  // keep the JSONB column reasonable even for very long sessions.
  var out = [];
  for (var i = 0; i < ds.length && i < 600; i++) {
    var row = ds[i];
    if (!row || !row.time || typeof row.value !== "number") continue;
    var t = Date.parse(normalized.date + "T" + row.time);
    if (isNaN(t)) continue;
    out.push({ t: t, bpm: row.value });
  }
  return out;
}

async function refreshToken(refreshTokenValue) {
  if (!refreshTokenValue) {
    var e = new Error("No Fitbit refresh token — reconnect required");
    e.code = "RECONNECT_REQUIRED";
    throw e;
  }
  var res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(refreshTokenValue),
  });
  if (!res.ok) {
    var body = await res.text();
    var err = new Error("Fitbit token refresh failed (" + res.status + "): " + body.substring(0, 200));
    err.code = "RECONNECT_REQUIRED";
    err.status = res.status;
    throw err;
  }
  var data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // 60s safety buffer matches the legacy convention so existing
    // getValidProfileToken() refreshes line up.
    expires_at: Date.now() + (data.expires_in * 1000) - 60000,
  };
}

// OAuth authorize URL for the connect endpoint to redirect to.
function buildAuthUrl(redirectUri, state) {
  return "https://www.fitbit.com/oauth2/authorize?response_type=code"
    + "&client_id=" + encodeURIComponent(process.env.FITBIT_CLIENT_ID || "")
    + "&redirect_uri=" + encodeURIComponent(redirectUri)
    + "&scope=" + encodeURIComponent("sleep heartrate activity profile weight")
    + "&state=" + encodeURIComponent(state || "");
}

module.exports = {
  provider: PROVIDER,
  label: "Fitbit",
  fetchActivities: fetchActivities,
  fetchActivityDetail: fetchActivityDetail,
  refreshToken: refreshToken,
  buildAuthUrl: buildAuthUrl,
  // Exposed so the HR backfill can pull intraday peak HR for an already-synced
  // activity using only the start_time + duration stored in wearable_data
  // (no second detail fetch). Optional in the adapter contract.
  fetchIntradayHr: fetchIntradayHr,
  // Exposed so the merge/import path can normalize a raw list activity passed
  // back from the client (the HR-loss fix). Optional in the adapter contract.
  normalize: normalize,
};
