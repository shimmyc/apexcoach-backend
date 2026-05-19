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
// into the cross-provider NormalizedActivity shape.
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
  // Reshape to {fatBurn, cardio, peak} in minutes.
  var zonesRaw = activity.heartRateZones || activity.heartRateZonesNew || null;
  var zones = null;
  if (Array.isArray(zonesRaw) && zonesRaw.length) {
    zones = {};
    for (var i = 0; i < zonesRaw.length; i++) {
      var z = zonesRaw[i];
      if (!z || !z.name) continue;
      var key = String(z.name).toLowerCase().replace(/\s+/g, "");
      if (key === "fatburn") zones.fatBurn = z.minutes || 0;
      else if (key === "cardio") zones.cardio = z.minutes || 0;
      else if (key === "peak") zones.peak = z.minutes || 0;
    }
    if (azm === null) azm = (zones.fatBurn || 0) + (zones.cardio || 0) + (zones.peak || 0);
  }

  return {
    provider: PROVIDER,
    provider_activity_id: String(activity.logId || activity.activityId || ""),
    date: date,
    activity_type: activity.activityName || activity.name || "Activity",
    duration_minutes: durationMin,
    steps: typeof activity.steps === "number" ? activity.steps : null,
    calories: typeof activity.calories === "number" ? activity.calories : null,
    avg_hr: typeof activity.averageHeartRate === "number" ? activity.averageHeartRate : null,
    peak_hr: typeof activity.maxHeartRate === "number" ? activity.maxHeartRate
            : typeof activity.peakHeartRate === "number" ? activity.peakHeartRate
            : null,
    active_zone_minutes: azm,
    zones: zones,
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
  return out;
}

async function fetchActivityDetail(accessToken, providerActivityId) {
  // Fitbit's per-activity endpoint is /1/user/-/activities/{logId}.json
  // — returns the same shape as a list entry plus richer HR/zone data.
  var resp = await fitGet("/1/user/-/activities/" + providerActivityId + ".json", accessToken);
  // The endpoint sometimes wraps in {activityLog: {...}}, sometimes returns flat.
  var act = (resp && resp.activityLog) ? resp.activityLog : resp;
  return normalize(act);
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
};
