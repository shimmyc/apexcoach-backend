const express = require("express");
const fetch   = require("node-fetch");
const path    = require("path");
const crypto  = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID      = process.env.FITBIT_CLIENT_ID;
const CLIENT_SECRET  = process.env.FITBIT_CLIENT_SECRET;
const REDIRECT_URI   = "https://apexcoach-backend.onrender.com/callback";
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function sbHeaders(prefer) {
  return {
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY,
    "Content-Type": "application/json",
    "Prefer": prefer || "return=representation",
  };
}

function hashPin(pin) {
  return crypto.createHash("sha256").update(String(pin)).digest("hex");
}

function cleanProfileData(obj) {
  if (typeof obj === "string") {
    return obj.replace(/\r\n\s*/g, " ").replace(/\r/g, " ").trim();
  }
  if (Array.isArray(obj)) {
    return obj.map(cleanProfileData);
  }
  if (obj && typeof obj === "object") {
    var cleaned = {};
    Object.keys(obj).forEach(function(key) {
      cleaned[key] = cleanProfileData(obj[key]);
    });
    return cleaned;
  }
  return obj;
}

// ── TOKEN STORAGE (legacy — used by /api/daily fallback) ──────────────────
async function loadTokens() {
  try {
    const res = await fetch(SUPABASE_URL + "/rest/v1/tokens?id=eq.1&select=*", {
      headers: sbHeaders(),
    });
    const rows = await res.json();
    if (rows && rows.length > 0) return rows[0];
  } catch (e) {
    console.error("loadTokens error:", e.message);
  }
  return {
    access_token:  process.env.FITBIT_ACCESS_TOKEN  || "",
    refresh_token: process.env.FITBIT_REFRESH_TOKEN || "",
    expires_at:    0,
  };
}

async function saveTokens(tokens) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/tokens?id=eq.1", {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify({
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at:    tokens.expires_at,
      }),
    });
  } catch (e) {
    console.error("saveTokens error:", e.message);
  }
}

async function refreshAccessToken() {
  const tokens = await loadTokens();
  const creds = Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");
  const res = await fetch("https://api.fitbit.com/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + creds,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=refresh_token&refresh_token=" + tokens.refresh_token,
  });
  if (!res.ok) throw new Error("Refresh failed: " + await res.text());
  const data = await res.json();
  const next = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + (data.expires_in * 1000) - 60000,
  };
  await saveTokens(next);
  return next.access_token;
}

async function getValidToken() {
  const tokens = await loadTokens();
  if (tokens.access_token && Date.now() < Number(tokens.expires_at)) {
    return tokens.access_token;
  }
  return await refreshAccessToken();
}

// ── PROFILE TOKEN STORAGE ─────────────────────────────────────────────────
async function loadProfileTokens(profileId) {
  try {
    console.log("[Fitbit] loadProfileTokens: reading from profiles table, id=" + profileId);
    const res = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId + "&select=fitbit_access_token,fitbit_refresh_token,fitbit_expires_at", {
      headers: sbHeaders(),
    });
    const rows = await res.json();
    if (rows && rows.length > 0) {
      var hasAccess = !!rows[0].fitbit_access_token;
      var hasRefresh = !!rows[0].fitbit_refresh_token;
      var expiresAt = rows[0].fitbit_expires_at || 0;
      var isExpired = Date.now() >= Number(expiresAt);
      console.log("[Fitbit] loadProfileTokens result: has_access=" + hasAccess + ", has_refresh=" + hasRefresh + ", expires_at=" + (expiresAt ? new Date(Number(expiresAt)).toISOString() : "none") + ", is_expired=" + isExpired);
      return {
        access_token:  rows[0].fitbit_access_token  || "",
        refresh_token: rows[0].fitbit_refresh_token || "",
        expires_at:    expiresAt,
      };
    }
    console.log("[Fitbit] loadProfileTokens: no profile found for id=" + profileId);
  } catch (e) {
    console.error("loadProfileTokens error:", e.message);
  }
  return { access_token: "", refresh_token: "", expires_at: 0 };
}

async function saveProfileTokens(profileId, tokens) {
  try {
    console.log("[Fitbit] saveProfileTokens: writing to profiles table, id=" + profileId);
    var patchRes = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId, {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify({
        fitbit_access_token:  tokens.access_token,
        fitbit_refresh_token: tokens.refresh_token,
        fitbit_expires_at:    tokens.expires_at,
      }),
    });
    console.log("[Fitbit] saveProfileTokens response status:", patchRes.status);
  } catch (e) {
    console.error("saveProfileTokens error:", e.message);
  }
}

async function refreshProfileToken(profileId) {
  const tokens = await loadProfileTokens(profileId);
  if (!tokens.refresh_token) throw new Error("No Fitbit refresh token for this profile. Please re-authorize.");
  const creds = Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");
  const res = await fetch("https://api.fitbit.com/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + creds,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=refresh_token&refresh_token=" + tokens.refresh_token,
  });
  if (!res.ok) throw new Error("Refresh failed: " + await res.text());
  const data = await res.json();
  const next = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + (data.expires_in * 1000) - 60000,
  };
  await saveProfileTokens(profileId, next);
  return next.access_token;
}

async function getValidProfileToken(profileId) {
  const tokens = await loadProfileTokens(profileId);
  if (tokens.access_token && Date.now() < Number(tokens.expires_at)) {
    console.log("[Fitbit] getValidProfileToken: token is VALID for profile " + profileId + ", using existing token");
    return tokens.access_token;
  }
  console.log("[Fitbit] getValidProfileToken: token is EXPIRED or MISSING for profile " + profileId + ", refreshing...");
  return await refreshProfileToken(profileId);
}

// ── FITBIT HELPERS ────────────────────────────────────────────────────────
async function fitGet(endpoint, token) {
  console.log("[Fitbit API] GET " + endpoint);
  const res = await fetch("https://api.fitbit.com" + endpoint, {
    headers: { "Authorization": "Bearer " + token },
  });
  if (!res.ok) {
    var errBody = await res.text();
    console.error("[Fitbit API] ERROR " + res.status + " for " + endpoint + ": " + errBody.substring(0, 200));
    throw new Error("Fitbit " + res.status + " for " + endpoint);
  }
  var data = await res.json();
  console.log("[Fitbit API] OK " + endpoint + " -> keys: " + Object.keys(data).join(","));
  return data;
}

function dateStr(offsetDays) {
  offsetDays = offsetDays || 0;
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

async function buildDailyData(token, overrideDate) {
  const today     = overrideDate || dateStr(0);
  const yesterday = overrideDate ? (() => { const d = new Date(overrideDate + 'T12:00:00'); d.setDate(d.getDate() - 1); return d.toISOString().slice(0,10); })() : dateStr(-1);
  const weekAgo   = overrideDate ? (() => { const d = new Date(overrideDate + 'T12:00:00'); d.setDate(d.getDate() - 7); return d.toISOString().slice(0,10); })() : dateStr(-7);

  const results = await Promise.all([
    fitGet("/1.2/user/-/sleep/date/" + today + ".json", token),
    fitGet("/1/user/-/activities/heart/date/" + today + "/1d.json", token),
    fitGet("/1/user/-/activities/heart/date/" + yesterday + "/1d.json", token),
    fitGet("/1/user/-/hrv/date/" + today + ".json", token),
    fitGet("/1/user/-/activities/date/" + yesterday + ".json", token),
    fitGet("/1/user/-/hrv/date/" + weekAgo + "/" + today + ".json", token).catch(function() { return { hrv: [] }; }),
    fitGet("/1/user/-/activities/heart/date/" + weekAgo + "/" + today + ".json", token).catch(function() { return { "activities-heart": [] }; }),
    fitGet("/1/user/-/sleep/date/" + today + ".json", token).catch(function() { return {}; }),
    fitGet("/1/user/-/body/log/weight/date/" + today + ".json", token).catch(function() { return { weight: [] }; }),
    fitGet("/1/user/-/body/log/fat/date/" + today + ".json", token).catch(function() { return { fat: [] }; }),
    // Activities list, sorted ascending after midnight today, limit 10.
    // Fitbit's `afterDate` is ISO YYYY-MM-DD. We filter to today only client-side.
    fitGet("/1/user/-/activities/list.json?afterDate=" + today + "&sort=asc&limit=10&offset=0", token).catch(function() { return { activities: [] }; }),
  ]);

  var sleep      = results[0];
  const heartToday = results[1];
  const heartYest  = results[2];
  var hrvToday   = results[3];
  const actYest    = results[4];
  const hrvWeek    = results[5];
  const heartWeek  = results[6];
  var sleepV1    = results[7];
  const bodyWeight = results[8];
  const bodyFat    = results[9];
  const activitiesList = results[10];

  var sleepArr    = sleep && sleep.sleep ? sleep.sleep : [];
  var sleepDate = today;

  // Fallback: if no sleep data for today, try yesterday (Fitbit stores sleep under start date)
  if (sleepArr.length === 0) {
    console.log("[Fitbit] No sleep data for today (" + today + "), trying yesterday (" + yesterday + ")");
    try {
      var sleepYest = await fitGet("/1.2/user/-/sleep/date/" + yesterday + ".json", token);
      sleepArr = sleepYest && sleepYest.sleep ? sleepYest.sleep : [];
      if (sleepArr.length > 0) {
        sleep = sleepYest;
        sleepDate = yesterday;
        console.log("[Fitbit] Found sleep data for yesterday (" + yesterday + "): " + sleepArr.length + " records");
        // Also update sleepV1 fallback
        sleepV1 = sleepYest;
      } else {
        console.log("[Fitbit] No sleep data for yesterday either");
      }
    } catch(e) {
      console.log("[Fitbit] Yesterday sleep fetch failed: " + e.message);
    }
  } else {
    console.log("[Fitbit] Found sleep data for today (" + today + "): " + sleepArr.length + " records");
  }

  const sleepRecord = sleepArr.find(function(s) { return s.isMainSleep; }) || sleepArr[0] || null;

  // Extract Fitbit sleep score from multiple possible locations
  var fitbitSleepScore = null;
  if (sleepRecord && typeof sleepRecord.score === 'number') {
    fitbitSleepScore = sleepRecord.score;
  }
  if (fitbitSleepScore === null && sleepV1) {
    var sleepV1Arr = sleepV1.sleep || [];
    var sleepV1Rec = sleepV1Arr.find(function(s) { return s.isMainSleep; }) || sleepV1Arr[0] || null;
    if (sleepV1Rec && typeof sleepV1Rec.score === 'number') {
      fitbitSleepScore = sleepV1Rec.score;
    }
  }
  if (fitbitSleepScore === null && sleep && typeof sleep.summary === 'object' && sleep.summary !== null && typeof sleep.summary.totalScore === 'number') {
    fitbitSleepScore = sleep.summary.totalScore;
  }

  const heartYestArr = heartYest && heartYest["activities-heart"] ? heartYest["activities-heart"] : [];
  const zones = heartYestArr[0] && heartYestArr[0].value ? heartYestArr[0].value.heartRateZones || [] : [];
  const heartTodayArr = heartToday && heartToday["activities-heart"] ? heartToday["activities-heart"] : [];
  if (heartTodayArr[0]) console.log("[Fitbit] RHR raw today:", JSON.stringify(heartTodayArr[0].value ? { restingHeartRate: heartTodayArr[0].value.restingHeartRate, hasZones: !!heartTodayArr[0].value.heartRateZones } : heartTodayArr[0]));
  var rhr = heartTodayArr[0] && heartTodayArr[0].value ? heartTodayArr[0].value.restingHeartRate || null : null;
  // Fallback: if no RHR for today, try yesterday's heart data
  if (rhr === null && heartYestArr[0] && heartYestArr[0].value && heartYestArr[0].value.restingHeartRate) {
    rhr = heartYestArr[0].value.restingHeartRate;
    console.log("[Fitbit] RHR fallback to yesterday: " + rhr);
  } else if (rhr !== null) {
    console.log("[Fitbit] RHR from today: " + rhr);
  } else {
    console.log("[Fitbit] RHR null - not available in today or yesterday data");
  }

  var hrvTodayArr = hrvToday && hrvToday.hrv ? hrvToday.hrv : [];
  var hrvDate = today;

  // Fallback: if no HRV data for today, try yesterday
  if (hrvTodayArr.length === 0) {
    console.log("[Fitbit] No HRV data for today (" + today + "), trying yesterday (" + yesterday + ")");
    try {
      var hrvYest = await fitGet("/1/user/-/hrv/date/" + yesterday + ".json", token);
      hrvTodayArr = hrvYest && hrvYest.hrv ? hrvYest.hrv : [];
      if (hrvTodayArr.length > 0) {
        hrvDate = yesterday;
        console.log("[Fitbit] Found HRV data for yesterday (" + yesterday + "): " + hrvTodayArr.length + " records");
      } else {
        console.log("[Fitbit] No HRV data for yesterday either");
      }
    } catch(e) {
      console.log("[Fitbit] Yesterday HRV fetch failed: " + e.message);
    }
  } else {
    console.log("[Fitbit] Found HRV data for today (" + today + "): " + hrvTodayArr.length + " records");
  }

  const hrv = hrvTodayArr[0] && hrvTodayArr[0].value ? hrvTodayArr[0].value.dailyRmssd || null : null;
  const heartWeekArr = heartWeek && heartWeek["activities-heart"] ? heartWeek["activities-heart"] : [];
  const rhrVals = heartWeekArr.map(function(d) { return d.value && d.value.restingHeartRate; }).filter(Boolean);
  const rhrHistory7Day = heartWeekArr.map(function(d) { return d.value && d.value.restingHeartRate ? d.value.restingHeartRate : null; }).filter(function(v) { return v !== null; });
  const hrvWeekArr = hrvWeek && hrvWeek.hrv ? hrvWeek.hrv : [];
  const hrvVals = hrvWeekArr.map(function(d) { return d.value && d.value.dailyRmssd; }).filter(Boolean);

  function findZone(name) {
    const z = zones.find(function(z) { return z.name === name; });
    return z ? z.minutes || 0 : 0;
  }

  console.log("[Fitbit] buildDailyData extracted: sleepRecord=" + (sleepRecord ? "yes" : "null") + ", rhr=" + rhr + ", hrv=" + hrv + ", fitbitSleepScore=" + fitbitSleepScore + ", steps=" + (actYest && actYest.summary ? actYest.summary.steps : "null"));
  if (!sleepRecord) console.log("[Fitbit] Sleep debug: sleepArr.length=" + sleepArr.length + ", raw sleep keys=" + (sleep ? Object.keys(sleep).join(",") : "null"));
  if (!rhr) console.log("[Fitbit] RHR debug: heartTodayArr.length=" + heartTodayArr.length + ", raw heartToday keys=" + (heartToday ? Object.keys(heartToday).join(",") : "null"));
  if (!hrv) console.log("[Fitbit] HRV debug: hrvTodayArr.length=" + hrvTodayArr.length + ", raw hrvToday keys=" + (hrvToday ? Object.keys(hrvToday).join(",") : "null"));

  return {
    date: today,
    data: {
      sleep: {
        hours:        sleepRecord ? +(sleepRecord.minutesAsleep / 60).toFixed(2) : null,
        efficiency:   sleepRecord ? sleepRecord.efficiency : null,
        minutesAwake: sleepRecord ? sleepRecord.minutesAwake : null,
        stages:       sleepRecord && sleepRecord.levels ? sleepRecord.levels.summary : null,
        fitbit_score: fitbitSleepScore,
      },
      rhr: rhr,
      hrv: hrv,
      prevZones: {
        peak:    findZone("Peak"),
        cardio:  findZone("Cardio"),
        fatBurn: findZone("Fat Burn"),
      },
      steps: actYest && actYest.summary ? actYest.summary.steps : null,
      stepsSummary: (function() {
        if (!actYest || !actYest.summary) return null;
        var s = actYest.summary;
        var distMiles = null;
        if (Array.isArray(s.distances)) {
          var totalDist = s.distances.find(function(d) { return d.activity === "total"; });
          if (totalDist && typeof totalDist.distance === "number") distMiles = +totalDist.distance.toFixed(2);
        }
        return {
          date: yesterday,
          steps: typeof s.steps === "number" ? s.steps : null,
          calories: typeof s.caloriesOut === "number" ? s.caloriesOut : null,
          distance_miles: distMiles,
          floors: typeof s.floors === "number" ? s.floors : null,
        };
      })(),
      todaysActivities: (function() {
        // Filter to activities that started today and shape into the
        // payload we'll persist for the import-prompt UI.
        var arr = activitiesList && activitiesList.activities ? activitiesList.activities : [];
        var todayPrefix = today; // YYYY-MM-DD
        var out = [];
        for (var ai = 0; ai < arr.length; ai++) {
          var a = arr[ai];
          var startISO = a.startTime || a.originalStartTime || null;
          if (!startISO) continue;
          // Fitbit returns ISO with timezone like 2026-04-24T10:32:00.000-04:00.
          // We trust the prefix for "today" matching, since the API was
          // already scoped via afterDate=today.
          if (String(startISO).indexOf(todayPrefix) !== 0) continue;
          var hrZones = a.heartRateZones || a.heartRateZonesNew || null;
          out.push({
            activityId: a.logId || a.activityId || null,
            name: a.activityName || a.name || "Activity",
            durationMinutes: a.duration ? Math.round(a.duration / 60000) : null,
            calories: typeof a.calories === "number" ? a.calories : null,
            steps: typeof a.steps === "number" ? a.steps : null,
            startTime: startISO,
            heartRateZones: hrZones,
            avgHeartRate: typeof a.averageHeartRate === "number" ? a.averageHeartRate : null,
          });
        }
        return out;
      })(),
      bodySummary: (function() {
        // Fitbit returns weight in kg by default (lbs only when locale en_US is set
        // on the user's account). The body/log endpoints expose `weight` (kg) AND
        // a separate `bmi` field. We re-derive weight_lbs and let the caller
        // recompute BMI from profile height (more reliable than Fitbit's BMI).
        var wRows = (bodyWeight && bodyWeight.weight) || [];
        var fRows = (bodyFat && bodyFat.fat) || [];
        var w = wRows.length ? wRows[wRows.length - 1] : null;
        var f = fRows.length ? fRows[fRows.length - 1] : null;
        if (!w && !f) return null;
        var weightLbs = null;
        if (w) {
          // Fitbit returns kg by default — the units endpoint can override but we
          // detect: if the value is suspiciously low (< 60), assume kg and convert;
          // otherwise treat as lbs. A typical adult lbs value is 100-300; a kg
          // value is 40-180. The split at 60 is safe for most adult users.
          var raw = typeof w.weight === "number" ? w.weight : null;
          if (raw !== null) {
            weightLbs = raw < 60 ? +(raw * 2.20462).toFixed(1) : +raw.toFixed(1);
          }
        }
        return {
          date: today,
          weight_lbs: weightLbs,
          body_fat_pct: f && typeof f.fat === "number" ? +f.fat.toFixed(2) : null,
        };
      })(),
      rolling7: {
        rhr: rhrVals.length ? Math.round(rhrVals.reduce(function(a,b){return a+b;},0) / rhrVals.length) : null,
        hrv: hrvVals.length ? +(hrvVals.reduce(function(a,b){return a+b;},0) / hrvVals.length).toFixed(1) : null,
      },
      rhrHistory7Day: rhrHistory7Day,
    },
  };
}

// ── OAUTH ──────────────────────────────────────────────────────────────────
app.get("/auth", function(req, res) {
  var profileId = req.query.profile_id || "";
  console.log("[OAuth] /auth called. profile_id=" + profileId);
  const url = "https://www.fitbit.com/oauth2/authorize?response_type=code&client_id=" + CLIENT_ID +
    "&redirect_uri=" + encodeURIComponent(REDIRECT_URI) +
    "&scope=" + encodeURIComponent("sleep heartrate activity profile") +
    "&state=" + encodeURIComponent(profileId);
  console.log("[OAuth] Redirecting to Fitbit with state=" + profileId);
  res.redirect(url);
});

app.get("/callback", async function(req, res) {
  const code = req.query.code;
  const rawState = req.query.state || "";
  const profileId = decodeURIComponent(rawState).trim();
  console.log("[OAuth] /callback received. code=" + (code ? "yes" : "no") + ", raw state='" + rawState + "', profileId='" + profileId + "'");
  if (!code) return res.status(400).send("No code.");
  try {
    const creds = Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");
    const resp = await fetch("https://api.fitbit.com/oauth2/token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + creds,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=authorization_code&code=" + code + "&redirect_uri=" + encodeURIComponent(REDIRECT_URI),
    });
    if (!resp.ok) return res.status(400).send("Failed: " + await resp.text());
    const data = await resp.json();
    const tokenData = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Date.now() + (data.expires_in * 1000) - 60000,
    };
    // Save to profile if profileId provided, otherwise legacy tokens table
    if (profileId) {
      console.log("[OAuth] Saving tokens to PROFILES table, id=" + profileId);
      await saveProfileTokens(profileId, tokenData);
      console.log("[OAuth] SUCCESS: Tokens saved to profile " + profileId + ". expires_at=" + new Date(tokenData.expires_at).toISOString());
      // First-connect 90-day backfill: fire-and-forget so the OAuth redirect
      // isn't held up by the data import. Idempotent — guarded by the
      // profile_data.settings.fitbit_backfilled flag.
      (async function() {
        try {
          var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId + "&select=profile_data", { headers: sbHeaders() });
          var pRows = await pr.json();
          var existing = (pRows && pRows[0] && pRows[0].profile_data) || {};
          var alreadyDone = existing.settings && existing.settings.fitbit_backfilled;
          if (alreadyDone) {
            console.log("[OAuth->Backfill] profile " + profileId + " already backfilled, skipping");
            return;
          }
          console.log("[OAuth->Backfill] kicking off 90-day backfill for profile " + profileId);
          var summary = await runFitbitBackfill(profileId, 90);
          var settings = Object.assign({}, existing.settings || {}, {
            fitbit_backfilled: true,
            fitbit_backfilled_at: new Date().toISOString(),
          });
          var merged = Object.assign({}, existing, { settings: settings });
          await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId, {
            method: "PATCH",
            headers: sbHeaders("return=minimal"),
            body: JSON.stringify({ profile_data: merged }),
          });
          console.log("[OAuth->Backfill] DONE profile=" + profileId + " stepDays=" + summary.stepDays + " weightDays=" + summary.weightDays);
        } catch (bfErr) {
          console.error("[OAuth->Backfill] FAILED profile=" + profileId + ": " + bfErr.message);
        }
      })();
    } else {
      console.log("[OAuth] WARNING: No profileId in state param. Saving to legacy tokens table.");
      await saveTokens(tokenData);
      console.log("[OAuth] Tokens saved to legacy tokens table.");
    }
    res.redirect("/");
  } catch (err) {
    console.error("[OAuth] ERROR in callback:", err.message);
    res.status(500).send(err.message);
  }
});

// ── PROFILES ──────────────────────────────────────────────────────────────
app.get("/api/profiles", async function(req, res) {
  try {
    var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?select=id,name,avatar_color&order=created_at.asc", {
      headers: sbHeaders(),
    });
    var data = await r.json();
    res.json({ success: true, profiles: Array.isArray(data) ? data : [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Top-level body columns surfaced alongside profile_data on every profile
// fetch/verify/patch response so the client can render the Body card and feed
// TDEE math into the AI prompt without a second round-trip.
var PROFILE_BODY_FIELDS = ["height_inches", "birth_date", "sex", "goal_weight_lbs", "goal_weight_timeline_months"];
function pickProfileBody(p) {
  var out = {};
  PROFILE_BODY_FIELDS.forEach(function(k) { out[k] = p && p[k] != null ? p[k] : null; });
  return out;
}
var PROFILE_SELECT_BASE = "id,name,avatar_color,profile_data,created_at," + PROFILE_BODY_FIELDS.join(",");

app.get("/api/profiles/:id", async function(req, res) {
  try {
    var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + req.params.id + "&select=" + PROFILE_SELECT_BASE, {
      headers: sbHeaders(),
    });
    var rows = await r.json();
    if (!rows || !rows.length) return res.json({ success: false, error: "Profile not found." });
    var p = rows[0];
    res.json({ success: true, profile: Object.assign({
      id: p.id, name: p.name, avatar_color: p.avatar_color,
      profile_data: cleanProfileData(p.profile_data || {}),
      created_at: p.created_at,
    }, pickProfileBody(p)) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/profiles", async function(req, res) {
  try {
    var body = req.body;
    if (!body.name || !body.pin || String(body.pin).length !== 4) {
      return res.status(400).json({ success: false, error: "Name and 4-digit PIN required." });
    }
    var r = await fetch(SUPABASE_URL + "/rest/v1/profiles", {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify({
        name: body.name,
        pin: hashPin(body.pin),
        avatar_color: body.avatar_color || "#22c97a",
        profile_data: cleanProfileData(body.profile_data || {}),
      }),
    });
    var data = await r.json();
    var profile = Array.isArray(data) ? data[0] : data;
    res.json({ success: true, profile: { id: profile.id, name: profile.name, avatar_color: profile.avatar_color } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/profiles/verify", async function(req, res) {
  try {
    var body = req.body;
    if (!body.id || !body.pin) {
      return res.status(400).json({ success: false, error: "Profile ID and PIN required." });
    }
    var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + body.id + "&select=pin," + PROFILE_SELECT_BASE, {
      headers: sbHeaders(),
    });
    var rows = await r.json();
    if (!rows || !rows.length) return res.json({ success: false, error: "Profile not found." });
    var profile = rows[0];
    if (profile.pin !== hashPin(body.pin)) return res.json({ success: false, error: "Incorrect PIN." });
    res.json({
      success: true,
      profile: Object.assign({
        id: profile.id,
        name: profile.name,
        avatar_color: profile.avatar_color,
        profile_data: cleanProfileData(profile.profile_data || {}),
        created_at: profile.created_at,
      }, pickProfileBody(profile)),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch("/api/profiles/:id", async function(req, res) {
  try {
    var profileId = req.params.id;
    var body = req.body;
    // Build update payload - supports name, avatar_color, profile_data,
    // and the dedicated body columns (height/dob/sex/goal weight + timeline).
    var updatePayload = {};
    if (body.name) updatePayload.name = body.name;
    if (body.avatar_color) updatePayload.avatar_color = body.avatar_color;
    PROFILE_BODY_FIELDS.forEach(function(k) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        var v = body[k];
        if (v === "" || v === undefined) v = null;
        updatePayload[k] = v;
      }
    });

    if (body.profile_data && typeof body.profile_data === 'object') {
      // Fetch existing profile_data for merge
      var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId + "&select=profile_data", {
        headers: sbHeaders(),
      });
      var rows = await r.json();
      if (!rows || !rows.length) return res.json({ success: false, error: "Profile not found." });
      var existing = rows[0].profile_data || {};
      var merged = Object.assign({}, existing);
      var keys = Object.keys(body.profile_data);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (body.profile_data[key] !== null && typeof body.profile_data[key] === 'object' && !Array.isArray(body.profile_data[key]) &&
            merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
          merged[key] = Object.assign({}, merged[key], body.profile_data[key]);
        } else {
          merged[key] = body.profile_data[key];
        }
      }
      updatePayload.profile_data = cleanProfileData(merged);
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ success: false, error: "Nothing to update." });
    }

    var r2 = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId, {
      method: "PATCH",
      headers: sbHeaders("return=representation"),
      body: JSON.stringify(updatePayload),
    });
    var updated = await r2.json();
    var profile = Array.isArray(updated) ? updated[0] : updated;
    res.json({ success: true, profile: Object.assign({
      id: profile.id, name: profile.name, avatar_color: profile.avatar_color,
      profile_data: profile.profile_data,
    }, pickProfileBody(profile)) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch("/api/profiles/:id/pin", async function(req, res) {
  try {
    var body = req.body;
    if (!body.old_pin || !body.new_pin || String(body.new_pin).length !== 4) {
      return res.status(400).json({ success: false, error: "Old PIN and new 4-digit PIN required." });
    }
    // Fetch current profile to verify old PIN
    var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + req.params.id + "&select=pin", {
      headers: sbHeaders(),
    });
    var rows = await r.json();
    if (!rows || !rows.length) return res.json({ success: false, error: "Profile not found." });
    if (rows[0].pin !== hashPin(body.old_pin)) {
      return res.json({ success: false, error: "Current PIN is incorrect." });
    }
    // Update to new PIN
    await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + req.params.id, {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify({ pin: hashPin(body.new_pin) }),
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── DELETE PROFILE ────────────────────────────────────────────────────────
app.delete("/api/profiles/:id", async function(req, res) {
  try {
    var body = req.body;
    if (!body.pin) {
      return res.status(400).json({ success: false, error: "PIN required to delete profile." });
    }
    // Verify PIN
    var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + req.params.id + "&select=pin", {
      headers: sbHeaders(),
    });
    var rows = await r.json();
    if (!rows || !rows.length) return res.json({ success: false, error: "Profile not found." });
    if (rows[0].pin !== hashPin(body.pin)) {
      return res.json({ success: false, error: "Incorrect PIN." });
    }
    // Delete all workouts for this profile
    await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + req.params.id, {
      method: "DELETE",
      headers: sbHeaders("return=minimal"),
    });
    // Delete the profile
    await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + req.params.id, {
      method: "DELETE",
      headers: sbHeaders("return=minimal"),
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── FITBIT DATA ────────────────────────────────────────────────────────────
// Legacy endpoint (uses tokens table)
app.get("/api/daily", async function(req, res) {
  try {
    const token = await getValidToken();
    const result = await buildDailyData(token);
    res.json({ success: true, date: result.date, data: result.data });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Per-profile endpoint (uses profile's fitbit tokens from profiles table)
app.get("/api/profiles/:id/daily", async function(req, res) {
  try {
    console.log("[Fitbit] /api/profiles/" + req.params.id + "/daily called - loading tokens from profiles table");
    const token = await getValidProfileToken(req.params.id);
    const dateParam = req.query.date || null;
    const result = await buildDailyData(token, dateParam);
    // Fire-and-forget: persist yesterday's steps and auto-track step micro-goals.
    // Do NOT block the daily response on this.
    var ss = result.data && result.data.stepsSummary;
    if (ss && ss.date && typeof ss.steps === "number") {
      upsertDailySteps(req.params.id, ss).then(function() {
        return autoTrackStepMicroGoals(req.params.id, ss.steps);
      }).catch(function(e) {
        console.error("[Steps] post-sync persistence failed:", e.message);
      });
    }
    // Fire-and-forget: persist today's weight / body fat from Fitbit if any.
    var bs = result.data && result.data.bodySummary;
    if (bs && bs.date && (typeof bs.weight_lbs === "number" || typeof bs.body_fat_pct === "number")) {
      upsertBodyMetrics(req.params.id, {
        date: bs.date,
        weight_lbs: bs.weight_lbs,
        body_fat_pct: bs.body_fat_pct,
        source: "fitbit",
      }).catch(function(e) {
        console.error("[Body] fitbit upsert failed:", e.message);
      });
    }
    // Diff today's Fitbit-tracked activities against existing workouts and
    // queue any that aren't already logged into profiles.fitbit_pending_imports.
    // Fire-and-forget so the daily response isn't held up.
    var todaysActs = result.data && result.data.todaysActivities;
    if (Array.isArray(todaysActs) && todaysActs.length) {
      diffAndQueueFitbitImports(req.params.id, result.date, todaysActs).catch(function(e) {
        console.error("[FitbitImport] queue failed:", e.message);
      });
    }
    res.json({ success: true, date: result.date, data: result.data });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── STEP HISTORY ──────────────────────────────────────────────────────────
async function upsertDailySteps(profileId, summary) {
  var payload = {
    profile_id: profileId,
    date: summary.date,
    steps: summary.steps,
    calories: summary.calories,
    distance_miles: summary.distance_miles,
    floors: summary.floors,
    source: "fitbit",
  };
  var r = await fetch(
    SUPABASE_URL + "/rest/v1/daily_steps?on_conflict=profile_id,date",
    {
      method: "POST",
      headers: sbHeaders("return=minimal,resolution=merge-duplicates"),
      body: JSON.stringify(payload),
    }
  );
  if (!r.ok) {
    var t = await r.text();
    throw new Error("daily_steps upsert " + r.status + ": " + t);
  }
  console.log("[Steps] upserted profile=" + profileId + " date=" + summary.date + " steps=" + summary.steps);
}

// When new step data lands, any active micro_goal that looks like a step/walk
// daily-habit (or explicitly has unit=steps) gets its current_value snapped to
// today's step count so the user doesn't have to log it manually.
async function autoTrackStepMicroGoals(profileId, stepCount) {
  try {
    var q = SUPABASE_URL + "/rest/v1/micro_goals?profile_id=eq." + profileId +
      "&is_active=eq.true&type=eq.daily_habit" +
      "&or=(title.ilike.*step*,title.ilike.*walk*,target_unit.eq.steps)" +
      "&select=id,title,target_unit";
    var r = await fetch(q, { headers: sbHeaders() });
    if (!r.ok) return;
    var rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return;
    for (var i = 0; i < rows.length; i++) {
      var mg = rows[i];
      await fetch(SUPABASE_URL + "/rest/v1/micro_goals?id=eq." + mg.id, {
        method: "PATCH",
        headers: sbHeaders("return=minimal"),
        body: JSON.stringify({ current_value: stepCount }),
      });
      console.log("[Steps] auto-tracked micro_goal id=" + mg.id + " title=\"" + mg.title + "\" -> " + stepCount);
    }
  } catch (e) {
    console.error("[Steps] autoTrackStepMicroGoals error:", e.message);
  }
}

// GET recent step history for a profile (default 30 days).
app.get("/api/profiles/:id/daily-steps", async function(req, res) {
  try {
    var pid = req.params.id;
    var days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    var cutoffStr = cutoff.toISOString().slice(0, 10);
    var r = await fetch(
      SUPABASE_URL + "/rest/v1/daily_steps?profile_id=eq." + pid +
        "&date=gte." + cutoffStr +
        "&select=date,steps,calories,distance_miles,floors,source" +
        "&order=date.desc",
      { headers: sbHeaders() }
    );
    var rows = await r.json();
    res.json({ success: true, steps: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── BODY METRICS (weight / body fat / BMI) ────────────────────────────────
function calcBmi(weightLbs, heightInches) {
  if (!weightLbs || !heightInches) return null;
  return +((weightLbs / (heightInches * heightInches)) * 703).toFixed(2);
}

async function getProfileHeightInches(profileId) {
  try {
    var r = await fetch(
      SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId + "&select=height_inches",
      { headers: sbHeaders() }
    );
    var rows = await r.json();
    if (!rows || !rows.length) return null;
    var h = rows[0].height_inches;
    return h && !isNaN(parseFloat(h)) ? parseFloat(h) : null;
  } catch (e) {
    return null;
  }
}

async function upsertBodyMetrics(profileId, entry) {
  // entry: { date, weight_lbs?, body_fat_pct?, source? }
  // Recompute BMI if we know the profile's height.
  var height = await getProfileHeightInches(profileId);
  var bmi = entry.weight_lbs ? calcBmi(entry.weight_lbs, height) : null;
  var payload = {
    profile_id: profileId,
    date: entry.date,
    weight_lbs: entry.weight_lbs == null ? null : entry.weight_lbs,
    body_fat_pct: entry.body_fat_pct == null ? null : entry.body_fat_pct,
    bmi: bmi,
    source: entry.source || "manual",
  };
  // Strip null fields so we don't blow away an existing weight when the user
  // logs body-fat-only (or vice versa). PostgREST treats omitted fields as
  // "leave alone" under merge-duplicates.
  Object.keys(payload).forEach(function(k) {
    if (payload[k] === null && k !== "bmi") delete payload[k];
  });
  // Always include profile_id + date so the conflict target resolves.
  payload.profile_id = profileId;
  payload.date = entry.date;

  var r = await fetch(
    SUPABASE_URL + "/rest/v1/body_metrics?on_conflict=profile_id,date",
    {
      method: "POST",
      headers: sbHeaders("return=representation,resolution=merge-duplicates"),
      body: JSON.stringify(payload),
    }
  );
  if (!r.ok) {
    var t = await r.text();
    throw new Error("body_metrics upsert " + r.status + ": " + t);
  }
  var data = await r.json();
  console.log("[Body] upserted profile=" + profileId + " date=" + entry.date +
    " weight=" + (entry.weight_lbs || "-") +
    " bf=" + (entry.body_fat_pct || "-") +
    " bmi=" + (bmi || "-") +
    " source=" + payload.source);
  return Array.isArray(data) ? data[0] : data;
}

app.get("/api/profiles/:id/body-metrics", async function(req, res) {
  try {
    var pid = req.params.id;
    var days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 730);
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    var cutoffStr = cutoff.toISOString().slice(0, 10);
    var r = await fetch(
      SUPABASE_URL + "/rest/v1/body_metrics?profile_id=eq." + pid +
        "&date=gte." + cutoffStr +
        "&select=date,weight_lbs,body_fat_pct,bmi,source" +
        "&order=date.desc",
      { headers: sbHeaders() }
    );
    var rows = await r.json();
    res.json({ success: true, metrics: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── FITBIT 90-DAY BACKFILL ────────────────────────────────────────────────
// Pulls 90 days of steps/weight/body-fat from Fitbit and upserts into
// daily_steps + body_metrics. Idempotent (on conflict do update).
async function runFitbitBackfill(profileId, days) {
  days = days || 90;
  var token = await getValidProfileToken(profileId);
  var height = await getProfileHeightInches(profileId);

  // Fitbit's `/Nd` ranges return arrays; on rare token-scope issues some
  // endpoints throw — wrap each independently so one failure doesn't kill
  // the whole backfill.
  var stepsRes  = await fitGet("/1/user/-/activities/steps/date/today/" + days + "d.json", token).catch(function() { return null; });
  var weightRes = await fitGet("/1/user/-/body/log/weight/date/today/" + days + "d.json", token).catch(function() { return null; });
  var fatRes    = await fitGet("/1/user/-/body/log/fat/date/today/"    + days + "d.json", token).catch(function() { return null; });

  // Steps come back as activities-steps[] of {dateTime, value}. Some days
  // legitimately read 0 steps (e.g. tracker not worn) — keep them so the
  // history chart shows the gap rather than implying data exists.
  var stepDays = 0;
  var stepsArr = stepsRes && stepsRes["activities-steps"] ? stepsRes["activities-steps"] : [];
  for (var i = 0; i < stepsArr.length; i++) {
    var sRow = stepsArr[i];
    var n = parseInt(sRow.value, 10);
    if (!sRow.dateTime || isNaN(n)) continue;
    try {
      await upsertDailySteps(profileId, {
        date: sRow.dateTime,
        steps: n,
        calories: null,
        distance_miles: null,
        floors: null,
      });
      stepDays++;
    } catch (e) {
      console.error("[Backfill] step upsert failed for " + sRow.dateTime + ": " + e.message);
    }
  }

  // Weight + fat logs are arrays of {date, time, weight|fat, ...}.
  // Group by date so we upsert one row per day even when there are
  // multiple weigh-ins in a day.
  var byDate = {};
  var weightArr = weightRes && weightRes.weight ? weightRes.weight : [];
  for (var w = 0; w < weightArr.length; w++) {
    var wr = weightArr[w];
    if (!wr.date) continue;
    var raw = typeof wr.weight === "number" ? wr.weight : parseFloat(wr.weight);
    if (isNaN(raw)) continue;
    // Same kg-vs-lbs heuristic as the daily sync: under 60 implies kg.
    var lbs = raw < 60 ? +(raw * 2.20462).toFixed(1) : +raw.toFixed(1);
    if (!byDate[wr.date]) byDate[wr.date] = {};
    // Last logged weight in the day wins.
    byDate[wr.date].weight_lbs = lbs;
  }
  var fatArr = fatRes && fatRes.fat ? fatRes.fat : [];
  for (var f = 0; f < fatArr.length; f++) {
    var fr = fatArr[f];
    if (!fr.date) continue;
    var pct = typeof fr.fat === "number" ? fr.fat : parseFloat(fr.fat);
    if (isNaN(pct)) continue;
    if (!byDate[fr.date]) byDate[fr.date] = {};
    byDate[fr.date].body_fat_pct = +pct.toFixed(2);
  }

  var weightDays = 0;
  var dateKeys = Object.keys(byDate);
  for (var d = 0; d < dateKeys.length; d++) {
    var key = dateKeys[d];
    var entry = byDate[key];
    try {
      await upsertBodyMetrics(profileId, {
        date: key,
        weight_lbs: entry.weight_lbs == null ? null : entry.weight_lbs,
        body_fat_pct: entry.body_fat_pct == null ? null : entry.body_fat_pct,
        source: "fitbit",
      });
      weightDays++;
    } catch (e) {
      console.error("[Backfill] body upsert failed for " + key + ": " + e.message);
    }
  }
  console.log("[Backfill] profile=" + profileId + " stepDays=" + stepDays + " weightDays=" + weightDays);
  return { stepDays: stepDays, weightDays: weightDays, height_inches_used: height };
}

// ── FITBIT WORKOUT AUTO-IMPORT ────────────────────────────────────────────
// Map common Fitbit activityName values into our workout-type taxonomy.
// Anything not in the table is kept verbatim — Claude's title generator will
// normalize it later if the user imports.
var FITBIT_ACTIVITY_TYPE_MAP = {
  "Run": "Cardio",
  "Outdoor Run": "Cardio",
  "Treadmill": "Cardio",
  "Walk": "Cardio",
  "Outdoor Walk": "Cardio",
  "Hike": "Cardio",
  "Bike": "Cardio",
  "Outdoor Bike": "Cardio",
  "Spinning": "Cardio",
  "Elliptical": "Cardio",
  "Swim": "Cardio",
  "Weights": "Strength",
  "Strength Training": "Strength",
  "Workout": "Strength",
  "Yoga": "Mind & Body",
  "Pilates": "Mind & Body",
  "Meditation": "Mind & Body",
  "Martial Arts": "Martial Arts",
  "MMA": "Martial Arts",
  "Boxing": "Martial Arts",
};
function mapFitbitActivityType(name) {
  if (!name) return "Workout";
  if (FITBIT_ACTIVITY_TYPE_MAP[name]) return FITBIT_ACTIVITY_TYPE_MAP[name];
  // Lowercase prefix fallbacks for things like "Outdoor Run (lap)" etc.
  var lower = String(name).toLowerCase();
  if (lower.indexOf("run") >= 0 || lower.indexOf("walk") >= 0 || lower.indexOf("hike") >= 0 || lower.indexOf("bike") >= 0 || lower.indexOf("swim") >= 0 || lower.indexOf("ellipt") >= 0) return "Cardio";
  if (lower.indexOf("strength") >= 0 || lower.indexOf("weight") >= 0 || lower.indexOf("lift") >= 0) return "Strength";
  if (lower.indexOf("yoga") >= 0 || lower.indexOf("pilates") >= 0 || lower.indexOf("medit") >= 0 || lower.indexOf("stretch") >= 0) return "Mind & Body";
  if (lower.indexOf("martial") >= 0 || lower.indexOf("mma") >= 0 || lower.indexOf("boxing") >= 0 || lower.indexOf("bjj") >= 0 || lower.indexOf("kickbox") >= 0) return "Martial Arts";
  return name; // Keep Fitbit's name as-is.
}

// Decide whether an activity is already represented either by an existing
// workout (source="fitbit_activity" + same activityName/date) OR by an
// already-pending import for the same activityId. Returns the new pending
// queue (pre-existing entries kept, new ones appended).
async function diffAndQueueFitbitImports(profileId, dateStr, activities) {
  // Existing workouts that match: fitbit_activity-source rows for today.
  var wRes = await fetch(
    SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + profileId +
      "&date=eq." + dateStr +
      "&select=type,notes",
    { headers: sbHeaders() }
  );
  var existingWorkouts = await wRes.json();
  if (!Array.isArray(existingWorkouts)) existingWorkouts = [];

  // Helper: do we already have a fitbit_activity workout matching this name?
  function matchesExistingWorkout(activityName) {
    var nameL = String(activityName || "").toLowerCase();
    for (var i = 0; i < existingWorkouts.length; i++) {
      var w = existingWorkouts[i];
      // Source is encoded as a marker in notes (we don't have a source col on
      // workouts). Belt-and-braces: also match on the type containing the
      // activity name to dedupe manual logs.
      if (w.notes && String(w.notes).indexOf("source: fitbit_activity") >= 0 &&
          String(w.type || "").toLowerCase().indexOf(nameL) >= 0) return true;
      if (String(w.type || "").toLowerCase() === nameL) return true;
    }
    return false;
  }

  var pRes = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId + "&select=fitbit_pending_imports", { headers: sbHeaders() });
  var pRows = await pRes.json();
  var existingPending = (pRows && pRows[0] && Array.isArray(pRows[0].fitbit_pending_imports)) ? pRows[0].fitbit_pending_imports : [];
  var existingIds = {};
  for (var ei = 0; ei < existingPending.length; ei++) {
    if (existingPending[ei] && existingPending[ei].activityId != null) existingIds[String(existingPending[ei].activityId)] = true;
  }

  var added = 0;
  var nextPending = existingPending.slice();
  for (var ai = 0; ai < activities.length; ai++) {
    var a = activities[ai];
    if (!a || !a.activityId) continue;
    if (existingIds[String(a.activityId)]) continue; // already pending
    if (matchesExistingWorkout(a.name)) continue;    // already imported as a workout
    nextPending.push(a);
    added++;
  }
  if (added === 0) return;

  await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId, {
    method: "PATCH",
    headers: sbHeaders("return=minimal"),
    body: JSON.stringify({ fitbit_pending_imports: nextPending }),
  });
  console.log("[FitbitImport] queued " + added + " new pending activity/activities for profile " + profileId);
}

// GET pending Fitbit imports for a profile (the client polls this on Today
// tab render).
app.get("/api/profiles/:id/fitbit-pending-imports", async function(req, res) {
  try {
    var pid = req.params.id;
    var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid + "&select=fitbit_pending_imports", { headers: sbHeaders() });
    var rows = await r.json();
    var pending = (rows && rows[0] && Array.isArray(rows[0].fitbit_pending_imports)) ? rows[0].fitbit_pending_imports : [];
    res.json({ success: true, pending: pending });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Import OR dismiss a pending Fitbit activity. Body: { activityId,
// action: "import" | "dismiss" }. On import we create a workouts row and
// remove from the pending list. On dismiss we just remove.
app.post("/api/profiles/:id/fitbit-import", async function(req, res) {
  try {
    var pid = req.params.id;
    var body = req.body || {};
    var activityId = body.activityId;
    var action = body.action || "import";
    if (!activityId) return res.status(400).json({ success: false, error: "activityId required" });

    var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid + "&select=fitbit_pending_imports", { headers: sbHeaders() });
    var pRows = await pr.json();
    var pending = (pRows && pRows[0] && Array.isArray(pRows[0].fitbit_pending_imports)) ? pRows[0].fitbit_pending_imports : [];
    var idx = -1;
    for (var i = 0; i < pending.length; i++) {
      if (pending[i] && String(pending[i].activityId) === String(activityId)) { idx = i; break; }
    }
    if (idx < 0) return res.status(404).json({ success: false, error: "Pending activity not found" });
    var act = pending[idx];

    var createdWorkout = null;
    if (action === "import") {
      var dateStr = act.startTime ? String(act.startTime).slice(0, 10) : (function() {
        var d = new Date(); var pad = function(n) { return String(n).padStart(2, "0"); };
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
      })();
      var noteParts = ["Auto-imported from Fitbit: " + (act.durationMinutes != null ? act.durationMinutes + " min" : "?")];
      if (act.calories != null) noteParts.push(act.calories + " cal burned");
      if (act.avgHeartRate != null) noteParts.push("avg HR: " + act.avgHeartRate + " bpm");
      var notes = noteParts.join(", ") + "\n[source: fitbit_activity, activityId=" + act.activityId + "]";
      var workoutPayload = {
        profile_id: parseInt(pid, 10),
        date: dateStr,
        type: mapFitbitActivityType(act.name),
        notes: notes,
        done: true,
        mobility: false,
        med: false,
        ts: Date.now(),
      };
      var wRes = await fetch(SUPABASE_URL + "/rest/v1/workouts", {
        method: "POST",
        headers: sbHeaders("return=representation"),
        body: JSON.stringify(workoutPayload),
      });
      if (!wRes.ok) {
        var t = await wRes.text();
        return res.status(wRes.status).json({ success: false, error: t });
      }
      var wRows = await wRes.json();
      createdWorkout = Array.isArray(wRows) ? wRows[0] : wRows;
      // Invalidate the progress brief — history changed.
      clearProgressBriefCache(pid);
    }

    // Remove from pending regardless of action.
    var nextPending = pending.slice(0, idx).concat(pending.slice(idx + 1));
    await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid, {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify({ fitbit_pending_imports: nextPending }),
    });

    res.json({ success: true, action: action, workout: createdWorkout, pending: nextPending });
  } catch (e) {
    console.error("[FitbitImport] action error:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/profiles/:id/fitbit-backfill", async function(req, res) {
  try {
    var pid = req.params.id;
    var days = Math.min(Math.max(parseInt(req.body && req.body.days, 10) || 90, 1), 365);
    var summary = await runFitbitBackfill(pid, days);
    // Mark as backfilled in profile_data.settings so we don't re-run on every
    // Fitbit reconnect (reconnects bump the flag too via OAuth callback).
    try {
      var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid + "&select=profile_data", { headers: sbHeaders() });
      var pRows = await pr.json();
      var existing = (pRows && pRows[0] && pRows[0].profile_data) || {};
      var settings = existing.settings || {};
      settings.fitbit_backfilled = true;
      settings.fitbit_backfilled_at = new Date().toISOString();
      var merged = Object.assign({}, existing, { settings: settings });
      await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid, {
        method: "PATCH",
        headers: sbHeaders("return=minimal"),
        body: JSON.stringify({ profile_data: merged }),
      });
    } catch (flagErr) {
      console.error("[Backfill] flag write failed:", flagErr.message);
    }
    res.json({ success: true, stepDays: summary.stepDays, weightDays: summary.weightDays });
  } catch (e) {
    console.error("[Backfill] error:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/profiles/:id/body-metrics", async function(req, res) {
  try {
    var pid = req.params.id;
    var body = req.body || {};
    var dateStr = body.date;
    if (!dateStr) {
      var d = new Date();
      var pad = function(n) { return String(n).padStart(2, "0"); };
      dateStr = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    }
    var weight = body.weight_lbs == null || body.weight_lbs === "" ? null : parseFloat(body.weight_lbs);
    var bf     = body.body_fat_pct == null || body.body_fat_pct === "" ? null : parseFloat(body.body_fat_pct);
    if (weight === null && bf === null) {
      return res.status(400).json({ success: false, error: "weight_lbs or body_fat_pct required" });
    }
    if (weight !== null && (isNaN(weight) || weight <= 0 || weight > 1000)) {
      return res.status(400).json({ success: false, error: "weight_lbs out of range" });
    }
    if (bf !== null && (isNaN(bf) || bf < 0 || bf > 75)) {
      return res.status(400).json({ success: false, error: "body_fat_pct out of range" });
    }
    var row = await upsertBodyMetrics(pid, {
      date: dateStr,
      weight_lbs: weight,
      body_fat_pct: bf,
      source: body.source || "manual",
    });
    res.json({ success: true, metric: row });
  } catch (e) {
    console.error("[Body] POST error:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── WORKOUT LOG ────────────────────────────────────────────────────────────
app.get("/api/workouts", async function(req, res) {
  try {
    var limit = req.query.limit || 60;
    var profileId = req.query.profile_id;
    var url = SUPABASE_URL + "/rest/v1/workouts?select=*&order=ts.desc&limit=" + limit;
    if (profileId) url += "&profile_id=eq." + profileId;
    var r = await fetch(url, { headers: sbHeaders() });
    var data = await r.json();
    res.json({ success: true, workouts: Array.isArray(data) ? data : [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── WORKOUT TEMPLATES ─────────────────────────────────────────────────────
// Saved routines users can drop into the log modal in one tap.
app.get("/api/profiles/:id/templates", async function(req, res) {
  try {
    var pid = req.params.id;
    var r = await fetch(
      SUPABASE_URL + "/rest/v1/workout_templates?profile_id=eq." + pid +
        "&select=id,name,type,notes_template,exercises,use_count,created_at" +
        "&order=use_count.desc,created_at.desc",
      { headers: sbHeaders() }
    );
    var rows = await r.json();
    res.json({ success: true, templates: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/profiles/:id/templates", async function(req, res) {
  try {
    var pid = req.params.id;
    var body = req.body || {};
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ success: false, error: "name required" });
    }
    var payload = {
      profile_id: parseInt(pid, 10),
      name: String(body.name).trim(),
      type: body.type || null,
      notes_template: body.notes_template || null,
      exercises: Array.isArray(body.exercises) ? body.exercises : (body.exercises || null),
      use_count: 0,
    };
    var r = await fetch(SUPABASE_URL + "/rest/v1/workout_templates", {
      method: "POST",
      headers: sbHeaders("return=representation"),
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      var t = await r.text();
      return res.status(r.status).json({ success: false, error: t });
    }
    var rows = await r.json();
    res.json({ success: true, template: Array.isArray(rows) ? rows[0] : rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch("/api/templates/:id", async function(req, res) {
  try {
    var tid = req.params.id;
    var body = req.body || {};
    var allowed = ["name", "type", "notes_template", "exercises", "use_count"];
    var payload = {};
    allowed.forEach(function(k) {
      if (Object.prototype.hasOwnProperty.call(body, k)) payload[k] = body[k];
    });
    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ success: false, error: "Nothing to update" });
    }
    var r = await fetch(SUPABASE_URL + "/rest/v1/workout_templates?id=eq." + tid, {
      method: "PATCH",
      headers: sbHeaders("return=representation"),
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      var t = await r.text();
      return res.status(r.status).json({ success: false, error: t });
    }
    var rows = await r.json();
    res.json({ success: true, template: Array.isArray(rows) ? rows[0] : rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete("/api/templates/:id", async function(req, res) {
  try {
    var tid = req.params.id;
    var r = await fetch(SUPABASE_URL + "/rest/v1/workout_templates?id=eq." + tid, {
      method: "DELETE",
      headers: sbHeaders("return=minimal"),
    });
    if (!r.ok) {
      var t = await r.text();
      return res.status(r.status).json({ success: false, error: t });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Full workout payload — row + all extracted exercises. Used by the
// re-log feature on the History tab to pre-fill the log modal with the
// original exercise list.
app.get("/api/workouts/:id/full", async function(req, res) {
  try {
    var wid = req.params.id;
    var wRes = await fetch(SUPABASE_URL + "/rest/v1/workouts?id=eq." + wid + "&select=*", { headers: sbHeaders() });
    var wRows = await wRes.json();
    if (!wRows || !wRows.length) return res.status(404).json({ success: false, error: "Workout not found" });
    var workout = wRows[0];
    var eRes = await fetch(
      SUPABASE_URL + "/rest/v1/exercises?workout_id=eq." + wid +
        "&select=id,name,category,main_category,subcategory,sets,reps,weight_lbs,distance_miles,duration_minutes,raw_text" +
        "&order=id.asc",
      { headers: sbHeaders() }
    );
    var exercises = await eRes.json();
    res.json({ success: true, workout: workout, exercises: Array.isArray(exercises) ? exercises : [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Look up the profile_id that owns a workouts row. Used to invalidate the
// progress-brief cache on PATCH/DELETE where the body doesn't carry profile_id.
async function getWorkoutProfileId(wid) {
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/workouts?id=eq." + wid + "&select=profile_id", { headers: sbHeaders() });
    const rows = await r.json();
    return rows && rows[0] ? rows[0].profile_id : null;
  } catch (e) {
    return null;
  }
}

app.post("/api/workouts", async function(req, res) {
  try {
    var body = req.body || {};
    // Validate optional date — must be YYYY-MM-DD and not in the future.
    // Past dates are allowed so users can log a missed session.
    if (body.date != null && body.date !== "") {
      var dateStr = String(body.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return res.status(400).json({ success: false, error: "Invalid date format (expected YYYY-MM-DD)" });
      }
      var parsed = new Date(dateStr + "T12:00:00");
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, error: "Invalid date" });
      }
      var now = new Date();
      var pad = function(n) { return String(n).padStart(2, "0"); };
      var todayStr = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
      if (dateStr > todayStr) {
        return res.status(400).json({ success: false, error: "Cannot log workouts for future dates" });
      }
    }
    var r = await fetch(SUPABASE_URL + "/rest/v1/workouts", {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify(body),
    });
    var data = await r.json();
    // Invalidate progress-brief cache — history changed (including past-date
    // logs, since the 14-day pattern analysis covers any date inside the
    // window). Daily-recommendations cache is intentionally NOT cleared here:
    // a workout logged for a past date doesn't change today's biometric or
    // schedule context.
    if (body.profile_id) clearProgressBriefCache(body.profile_id);
    res.json({ success: true, workout: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch("/api/workouts/:id", async function(req, res) {
  try {
    var id = req.params.id;
    // Capture profile_id before the update so we can invalidate afterward.
    var pid = (req.body && req.body.profile_id) || await getWorkoutProfileId(id);
    var r = await fetch(SUPABASE_URL + "/rest/v1/workouts?id=eq." + id, {
      method: "PATCH",
      headers: sbHeaders("return=representation"),
      body: JSON.stringify(req.body),
    });
    var data = await r.json();
    if (pid) clearProgressBriefCache(pid);
    res.json({ success: true, workout: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete("/api/workouts/:id", async function(req, res) {
  try {
    var id = req.params.id;
    var pid = await getWorkoutProfileId(id);
    await fetch(SUPABASE_URL + "/rest/v1/workouts?id=eq." + id, {
      method: "DELETE",
      headers: sbHeaders("return=minimal"),
    });
    if (pid) clearProgressBriefCache(pid);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── REFORMAT WORKOUT TITLES ───────────────────────────────────────────────
app.post("/api/profiles/:id/reformat-titles", async function(req, res) {
  try {
    var profileId = req.params.id;
    // Fetch all workouts with notes
    var wr = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + profileId + "&notes=neq.&notes=not.is.null&select=id,type,notes,date&order=date.desc&limit=10000", { headers: sbHeaders() });
    var workouts = await wr.json();
    if (!Array.isArray(workouts)) workouts = [];
    // Filter to only those with actual notes content
    workouts = workouts.filter(function(w) { return w.notes && w.notes.trim().length > 0; });
    console.log("[reformat-titles] Found " + workouts.length + " workouts with notes for profile " + profileId);

    var updated = 0;
    var batchSize = 5;
    for (var i = 0; i < workouts.length; i += batchSize) {
      var batch = workouts.slice(i, i + batchSize);
      var promises = batch.map(async function(w) {
        try {
          var titlePrompt = "Analyze these workout notes and generate a workout label using this exact hierarchy. Format: '[Main] ([Sub]) + [Main] ([Sub])' for multiple activities.\n\nTAXONOMY:\nSTRENGTH: Upper Body, Lower Body, Core, Full Body, Calisthenics, Olympic Lifting, Powerlifting\nCARDIO: Machine (Elliptical/Treadmill/Stairmaster/Rowing/Bike), Outdoor (Running/Walking/Hiking/Cycling), Class, HIIT, Jump Rope\nMARTIAL ARTS: Striking (Boxing/Kickboxing/Muay Thai), Grappling (BJJ/Wrestling/Judo), MMA\nSPORTS: Team, Racket, Water, Winter, Golf, Gymnastics, Rock Climbing\nMIND & BODY: Yoga, Pilates, Stretching, Breathwork, Meditation\nREHAB & RECOVERY: Physical Therapy, Foam Rolling, Active Recovery\nMIXED TRAINING: 3+ categories\nREST: Full Rest, Light Activity\n\nRULES: Use '+' separator. Max 3 categories. Include sub-category in parentheses. If duration mentioned note it.\n\nReturn ONLY the label. Maximum 8 words.\nWorkout notes: " + w.notes;
          var title = await callAI(titlePrompt, 100);
          title = title.trim().replace(/^["']|["']$/g, "");
          if (!title || title.length > 80) title = w.type || "Workout";
          // Update in Supabase
          await fetch(SUPABASE_URL + "/rest/v1/workouts?id=eq." + w.id, {
            method: "PATCH",
            headers: sbHeaders("return=minimal"),
            body: JSON.stringify({ type: title }),
          });
          updated++;
          return title;
        } catch (e) {
          console.error("[reformat-titles] Error on workout " + w.id + ":", e.message);
          return null;
        }
      });
      await Promise.all(promises);
    }
    console.log("[reformat-titles] Updated " + updated + "/" + workouts.length + " titles");
    res.json({ success: true, updated: updated, total: workouts.length });
  } catch (e) {
    console.error("[reformat-titles] Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── DEDUPLICATE WORKOUTS ──────────────────────────────────────────────────
app.post("/api/profiles/:id/dedupe-workouts", async function(req, res) {
  try {
    var profileId = req.params.id;
    var wr = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + profileId + "&select=id,date,ts,type,notes&order=date.desc,ts.desc&limit=10000", { headers: sbHeaders() });
    var workouts = await wr.json();
    if (!Array.isArray(workouts)) workouts = [];

    // Group by date+ts to find true duplicates (same date AND same timestamp)
    var seen = {};
    var dupeIds = [];
    for (var i = 0; i < workouts.length; i++) {
      var w = workouts[i];
      var key = w.date + '|' + (w.ts || 0);
      if (seen[key]) {
        // Keep the first one (earlier in the array = higher ID typically), delete this one
        dupeIds.push(w.id);
      } else {
        seen[key] = w.id;
      }
    }

    console.log("[dedupe] Found " + dupeIds.length + " duplicate workouts for profile " + profileId);
    var deleted = 0;
    for (var j = 0; j < dupeIds.length; j++) {
      var dr = await fetch(SUPABASE_URL + "/rest/v1/workouts?id=eq." + dupeIds[j], {
        method: "DELETE",
        headers: sbHeaders("return=minimal"),
      });
      if (dr.ok) deleted++;
    }
    console.log("[dedupe] Deleted " + deleted + " duplicates");
    res.json({ success: true, duplicates_found: dupeIds.length, deleted: deleted });
  } catch (e) {
    console.error("[dedupe] Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── MEDITATION LOG ─────────────────────────────────────────────────────────
app.get("/api/meditations", async function(req, res) {
  try {
    var profileId = req.query.profile_id;
    var url = SUPABASE_URL + "/rest/v1/workouts?select=date&med=eq.true&order=date.desc&limit=30";
    if (profileId) url += "&profile_id=eq." + profileId;
    var r = await fetch(url, { headers: sbHeaders() });
    var data = await r.json();
    var dates = Array.isArray(data) ? data.map(function(w) { return w.date; }) : [];
    res.json({ success: true, dates: dates });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── TOKEN INFO ─────────────────────────────────────────────────────────────
app.get("/api/token-info", async function(req, res) {
  var profileId = req.query.profile_id;
  if (profileId) {
    var tokens = await loadProfileTokens(profileId);
    res.json({
      source: "profiles table (id=" + profileId + ")",
      has_access_token: !!tokens.access_token,
      has_refresh_token: !!tokens.refresh_token,
      access_token_preview: tokens.access_token ? tokens.access_token.substring(0, 10) + "..." : "none",
      expires_at: tokens.expires_at ? new Date(Number(tokens.expires_at)).toISOString() : "none",
      is_expired: tokens.expires_at ? Date.now() >= Number(tokens.expires_at) : true,
    });
  } else {
    var tokens = await loadTokens();
    res.json({
      source: "legacy tokens table",
      has_refresh_token: !!tokens.refresh_token,
      expires_at: tokens.expires_at ? new Date(Number(tokens.expires_at)).toISOString() : "none",
    });
  }
});

// ── AI PROXY ───────────────────────────────────────────────────────────────
// ── COACHING MEMORY SYSTEM ────────────────────────────────────────────────
function formatWorkoutForAI(w) {
  return w.date + ": " + w.type + (w.done ? " (done)" : " (skipped)") + (w.mobility ? " +mobility" : "") + (w.med ? " +meditation" : "") + (w.notes ? " — " + w.notes : "");
}

// Model IDs — kept in one place so routing decisions live server-side.
var MODEL_SONNET = "claude-sonnet-4-20250514";
var MODEL_HAIKU  = "claude-haiku-4-5-20251001";

// callType → model. Cheap tasks (formatting, extraction, short classification)
// run on Haiku; intelligence-sensitive work (recs, briefs, roadmap, full profile
// generation) stays on Sonnet.
var CALL_TYPE_MODEL = {
  // Smart tasks — Sonnet
  daily_recs:        MODEL_SONNET,
  onboarding_profile: MODEL_SONNET,
  profile_builder:   MODEL_SONNET,
  coaching_brief:    MODEL_SONNET,
  historical_brief:  MODEL_SONNET,
  roadmap:           MODEL_SONNET,
  history_search:    MODEL_SONNET,
  // Cheap tasks — Haiku
  format_notes:      MODEL_HAIKU,
  workout_title:     MODEL_HAIKU,
  extract_exercises: MODEL_HAIKU,
  progress_brief:    MODEL_HAIKU,
  exercise_insight:  MODEL_HAIKU,
  goal_description:  MODEL_HAIKU,
  goal_estimate:     MODEL_HAIKU,
};

function modelForCallType(callType) {
  if (callType && CALL_TYPE_MODEL[callType]) return CALL_TYPE_MODEL[callType];
  // Default to Sonnet if callType is missing or unknown — preserves existing
  // behavior for any unmigrated caller, without letting the client pick.
  return MODEL_SONNET;
}

async function callAI(prompt, maxTokens, model) {
  var response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model || MODEL_SONNET,
      max_tokens: maxTokens || 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  var data = await response.json();
  return (data.content && data.content[0]) ? data.content[0].text : "";
}

app.get("/api/profiles/:id/brief", async function(req, res) {
  try {
    var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + req.params.id + "&select=coaching_brief,historical_brief,historical_brief_updated_at", {
      headers: sbHeaders(),
    });
    var rows = await r.json();
    if (!rows || !rows.length) return res.json({ success: false, error: "Profile not found." });
    var p = rows[0];
    res.json({ success: true, coaching_brief: p.coaching_brief, historical_brief: p.historical_brief, historical_brief_updated_at: p.historical_brief_updated_at });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/profiles/:id/generate-brief", async function(req, res) {
  try {
    var profileId = req.params.id;

    // Fetch profile data
    var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId + "&select=profile_data,historical_brief,historical_brief_updated_at", {
      headers: sbHeaders(),
    });
    var pRows = await pr.json();
    if (!pRows || !pRows.length) return res.json({ success: false, error: "Profile not found." });
    var profile = pRows[0];
    var profileContext = (profile.profile_data && profile.profile_data.ai_prompt_context) || "";

    // Fetch ALL workouts
    var wr = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + profileId + "&select=*&order=date.desc&limit=10000", {
      headers: sbHeaders(),
    });
    var allWorkouts = await wr.json();
    if (!Array.isArray(allWorkouts)) allWorkouts = [];

    var recent = allWorkouts.slice(0, 30);
    var historical = allWorkouts.slice(30);

    // Calculate streak
    var doneDates = {};
    allWorkouts.forEach(function(w) { if (w.done) doneDates[w.date] = true; });
    var streak = 0;
    var d = new Date();
    var check = d.toISOString().slice(0, 10);
    if (!doneDates[check]) { d.setDate(d.getDate() - 1); check = d.toISOString().slice(0, 10); }
    while (doneDates[check]) { streak++; d.setDate(d.getDate() - 1); check = d.toISOString().slice(0, 10); }

    var updatePayload = {};

    // CALL 1 - Historical Brief (if needed)
    var needsHistorical = !profile.historical_brief_updated_at ||
      (Date.now() - new Date(profile.historical_brief_updated_at).getTime() > 30 * 24 * 60 * 60 * 1000);

    var historicalBrief = profile.historical_brief || "";

    if (needsHistorical && historical.length > 0) {
      var histFormatted = historical.map(formatWorkoutForAI).join("\n");
      var histPrompt = "Analyze this athlete's complete workout history before their last 30 sessions and write a Historical Training Summary. Cover: overall consistency patterns, long-term exercise progressions, injury history from notes, seasonal patterns, what types of training they gravitate toward, any notable milestones or breakthroughs. Keep under 300 words. Write in third person coaching voice.\n\nHISTORICAL WORKOUTS:\n" + histFormatted;
      historicalBrief = await callAI(histPrompt, 800);
      updatePayload.historical_brief = historicalBrief;
      updatePayload.historical_brief_updated_at = new Date().toISOString();
    }

    // CALL 2 - Recent Coaching Brief (always)
    var recentFormatted = recent.map(formatWorkoutForAI).join("\n");
    var recentPrompt = "You are analyzing an athlete's recent 30 training sessions to write a Living Coaching Brief.\n\n" +
      "HISTORICAL CONTEXT:\n" + (historicalBrief || "No historical data yet.") + "\n\n" +
      "ATHLETE PROFILE:\n" + (profileContext || "No profile data.") + "\n\n" +
      "RECENT 30 SESSIONS:\n" + recentFormatted + "\n\n" +
      "Write a coaching brief covering:\n" +
      "- Recent pattern (last 14 days): session count, types, consistency %\n" +
      "- Exercise trends: any progressions or plateaus from notes\n" +
      "- Injury status: pain mentions in last 30 days, what's improving\n" +
      "- What's working: 2-3 observations\n" +
      "- What needs attention: 2-3 observations\n" +
      "- Current streak: " + streak + " days\n" +
      "Keep under 400 words. Be specific, reference actual dates and numbers.";

    var coachingBrief = await callAI(recentPrompt, 1000);
    updatePayload.coaching_brief = coachingBrief;

    // Save to Supabase
    await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId, {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify(updatePayload),
    });

    res.json({ success: true, coaching_brief: coachingBrief, historical_brief: historicalBrief });
  } catch (e) {
    console.error("generate-brief error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/profiles/:id/search-history", async function(req, res) {
  try {
    var profileId = req.params.id;
    var query = req.body.query;
    if (!query) return res.status(400).json({ success: false, error: "Query required." });

    // Fetch ALL workouts
    var wr = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + profileId + "&select=*&order=date.desc&limit=10000", {
      headers: sbHeaders(),
    });
    var allWorkouts = await wr.json();
    if (!Array.isArray(allWorkouts)) allWorkouts = [];

    var formatted = allWorkouts.map(formatWorkoutForAI).join("\n");
    var prompt = "Search this athlete's complete workout history and answer this specific question with exact dates, numbers, and context.\n\n" +
      "QUESTION: " + query + "\n\n" +
      "COMPLETE WORKOUT HISTORY (" + allWorkouts.length + " sessions):\n" + formatted + "\n\n" +
      "Answer concisely with specific data. If not found, say so.";

    var answer = await callAI(prompt, 600);
    res.json({ success: true, answer: answer });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GOAL PROGRESS ─────────────────────────────────────────────────────────
app.post("/api/profiles/:id/goal-progress", async function(req, res) {
  try {
    var profileId = req.params.id;
    var body = req.body;
    var goals = body.goals || [];
    var workouts = body.workoutLog || [];
    var exercises = body.exercises || [];
    var steps = body.fitbitSteps || 0;
    var currentBelt = body.current_belt || null;
    var medDays = body.medDays || 0;

    var results = [];
    for (var gi = 0; gi < goals.length; gi++) {
      var g = goals[gi];
      var r = { index: gi, pct: 0, label: '', auto_tracked: false, source: 'manual', reasoning: '' };

      if (g.type === 'strength') {
        var keywords = (g.title || '').toLowerCase().split(/\s+/);
        var maxW = 0;
        exercises.forEach(function(ex) {
          var nameL = (ex.name || '').toLowerCase();
          if (keywords.some(function(k) { return k.length > 3 && nameL.indexOf(k) >= 0; }) && ex.weight_lbs) {
            if (ex.weight_lbs > maxW) maxW = ex.weight_lbs;
          }
        });
        if (g.target_value && maxW) {
          r.pct = Math.min(100, Math.round((maxW / g.target_value) * 100));
          r.label = 'Best: ' + maxW + 'lbs / ' + g.target_value + 'lbs';
          r.auto_tracked = true; r.source = 'auto';
        } else if (g.current_value != null && g.target_value) {
          r.pct = Math.min(100, Math.round((g.current_value / g.target_value) * 100));
          r.label = g.current_value + ' / ' + g.target_value + (g.unit ? ' ' + g.unit : '');
          r.source = 'manual';
        }
      } else if (g.type === 'distance') {
        var totalDist = 0;
        var longestCardio = 0;
        var weeklyCardio = 0;
        var legExercises = [];
        exercises.forEach(function(ex) {
          if (ex.distance_miles) totalDist += ex.distance_miles;
          if (ex.duration_minutes && (ex.category === 'cardio' || ex.category === 'other')) {
            if (ex.duration_minutes > longestCardio) longestCardio = ex.duration_minutes;
          }
        });
        workouts.forEach(function(w) {
          if (w.done && (w.type.indexOf('Conditioning') >= 0 || w.type.indexOf('Walking') >= 0)) weeklyCardio++;
        });
        weeklyCardio = workouts.length > 0 ? Math.round(weeklyCardio / (workouts.length / 7)) : 0;
        var manualVal = g.current_value || 0;

        try {
          var aiPrompt = "Athlete goal: " + g.title + " (" + (g.target_value || '?') + " " + (g.unit || 'miles') + ").\nTraining data last 90 days:\n- Longest cardio session: " + longestCardio + " minutes\n- Weekly cardio sessions: " + weeklyCardio + " avg\n- Daily steps avg: " + steps + "\n- Distance logged: " + totalDist + " miles\n- Manual progress reported: " + manualVal + " " + (g.unit || '') + "\nEstimate 0-100% readiness. Return JSON only: {\"readiness_pct\": number, \"reasoning\": \"1 sentence\"}";
          var aiText = await callAI(aiPrompt, 200, MODEL_HAIKU);
          var aiJson = JSON.parse(aiText.substring(aiText.indexOf('{'), aiText.lastIndexOf('}') + 1));
          r.pct = Math.min(100, aiJson.readiness_pct || 0);
          r.reasoning = aiJson.reasoning || '';
          r.label = 'AI estimate: ' + r.pct + '%' + (totalDist ? ' | ' + totalDist.toFixed(1) + ' mi logged' : '');
          r.auto_tracked = true; r.source = 'ai';
        } catch (e) {
          if (manualVal && g.target_value) {
            r.pct = Math.min(100, Math.round((manualVal / g.target_value) * 100));
            r.label = manualVal + ' / ' + g.target_value + ' ' + (g.unit || '');
            r.source = 'manual';
          }
        }
      } else if (g.type === 'consistency') {
        var count = 0;
        var thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        var cutoff = thirtyDaysAgo.toISOString().slice(0, 10);
        workouts.forEach(function(w) {
          if (w.done && w.date >= cutoff) {
            var typeLow = (w.type || '').toLowerCase();
            var titleLow = (g.title || '').toLowerCase();
            if (titleLow.indexOf('mma') >= 0 && typeLow.indexOf('mma') >= 0) count++;
            else if (titleLow.indexOf('cardio') >= 0 && (typeLow.indexOf('conditioning') >= 0 || typeLow.indexOf('cardio') >= 0)) count++;
            else if (titleLow.indexOf('stamina') >= 0 && (typeLow.indexOf('mma') >= 0 || typeLow.indexOf('conditioning') >= 0 || typeLow.indexOf('cardio') >= 0)) count++;
            else count++;
          }
        });
        var target = (g.target_value || 4) * 4;
        r.pct = Math.min(100, Math.round((count / target) * 100));
        r.label = count + ' sessions this month / ' + target + ' target';
        r.auto_tracked = true; r.source = 'auto';
      } else if (g.type === 'habit') {
        r.pct = Math.min(100, Math.round((medDays / 30) * 100));
        r.label = medDays + '/30 days this month';
        r.auto_tracked = true; r.source = 'auto';
      } else if (g.type === 'skill') {
        var beltIds = ['white','yellow','orange','red','green1','green2','blue1','blue2','purple','brown1','brown2','brown3','black'];
        var beltIdx = beltIds.indexOf(currentBelt || 'white') + 1;
        r.pct = Math.round((beltIdx / 13) * 100);
        r.label = (currentBelt || 'white') + ' \u2192 Black Belt (' + beltIdx + '/13)';
        r.auto_tracked = true; r.source = 'auto';
      } else {
        // general goals - AI estimate
        if (g.current_value != null && g.current_value > 0) {
          r.pct = Math.min(100, g.current_value);
          r.label = 'Self-rated: ' + g.current_value + '%';
          r.source = 'manual';
        } else {
          try {
            var recentLog = workouts.slice(0, 10).map(function(w) { return w.date + ': ' + w.type + (w.notes ? ' (' + w.notes.substring(0, 50) + ')' : ''); }).join('\n');
            var aiP = "Athlete goal: " + g.title + ".\nRecent workouts:\n" + recentLog + "\nEstimate 0-100% progress. Be conservative.\nReturn JSON only: {\"estimate_pct\": number, \"reasoning\": \"1 sentence\"}";
            var aiT = await callAI(aiP, 200, MODEL_HAIKU);
            var aiJ = JSON.parse(aiT.substring(aiT.indexOf('{'), aiT.lastIndexOf('}') + 1));
            r.pct = Math.min(100, aiJ.estimate_pct || 0);
            r.reasoning = aiJ.reasoning || '';
            r.label = 'AI estimate: ' + r.pct + '%';
            r.source = 'ai';
          } catch (e) {
            r.label = 'No data yet';
          }
        }
      }
      results.push(r);
    }
    res.json({ success: true, progress: results });
  } catch (e) {
    console.error("goal-progress error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GOAL DESCRIPTION ──────────────────────────────────────────────────────
app.post("/api/profiles/:id/generate-goal-description", async function(req, res) {
  try {
    var body = req.body;
    if (!body.title) return res.status(400).json({ success: false, error: "Title required." });
    var prompt = "Write a single plain sentence describing this fitness goal. Be direct and simple, no motivational language, no exclamation marks. Maximum 15 words.\nExample: 'Hike 8 miles carrying Noam on your back without stopping.'\nGoal: " + body.title +
      (body.target_value ? "\nTarget: " + body.target_value + " " + (body.unit || "") : "") +
      "\nReturn ONLY the description text, no quotes, no explanation.";
    var text = await callAI(prompt, 200, MODEL_HAIKU);
    res.json({ success: true, description: text.trim() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── EXERCISE LIBRARY ──────────────────────────────────────────────────────
var CANONICAL_NAMES = {
  'cat and cow': 'Cat-Cow', 'cat cow': 'Cat-Cow', 'cat-cows': 'Cat-Cow',
  'windshield wipers': 'Windshield Wiper', 'windshield wiper': 'Windshield Wiper',
  'glute bridges': 'Glute Bridge', 'glute bridge': 'Glute Bridge',
  'clam shell': 'Clamshell', 'clamshells': 'Clamshell', 'clamshell': 'Clamshell',
  'push up': 'Push-Up', 'pushup': 'Push-Up', 'push ups': 'Push-Up', 'pushups': 'Push-Up', 'push-ups': 'Push-Up',
  'dead bugs': 'Dead Bug', 'dead bug': 'Dead Bug',
  'hip flexor stretch': 'Hip Flexor Stretch', 'hip flexor stretches': 'Hip Flexor Stretch',
  'dumbbell row': 'Dumbbell Row', 'dumbbell rows': 'Dumbbell Row',
  'bicep curl': 'Bicep Curl', 'bicep curls': 'Bicep Curl', 'dumbbell bicep curl': 'Bicep Curl', 'dumbbell bicep curls': 'Bicep Curl',
  'bird dog': 'Bird Dog', 'bird dogs': 'Bird Dog',
  'plank': 'Plank', 'planks': 'Plank',
  'squat': 'Squat', 'squats': 'Squat',
  'lunge': 'Lunge', 'lunges': 'Lunge',
  'burpee': 'Burpee', 'burpees': 'Burpee',
  'sit up': 'Sit-Up', 'sit ups': 'Sit-Up', 'situp': 'Sit-Up', 'situps': 'Sit-Up',
  'pull up': 'Pull-Up', 'pull ups': 'Pull-Up', 'pullup': 'Pull-Up', 'pullups': 'Pull-Up',
  'chin up': 'Chin-Up', 'chin ups': 'Chin-Up', 'chinup': 'Chin-Up', 'chinups': 'Chin-Up',
  'hang': 'Dead Hang', 'hangs': 'Dead Hang', 'dead hang': 'Dead Hang', 'dead hangs': 'Dead Hang',
  'hanging': 'Dead Hang', 'bar hang': 'Dead Hang', 'bar hangs': 'Dead Hang',
  'passive hang': 'Dead Hang', 'passive hangs': 'Dead Hang',
};

// Try to extract a canonical exercise name from a free-text title (e.g. a
// micro-goal title like "2-minute hang" or "Dead hang every day"). Used by
// the auto-tracker so a goal can be scoped to a specific exercise even when
// the user phrases it loosely. Returns null if nothing in the title matches
// a known canonical alias.
function extractCanonicalFromTitle(title) {
  if (!title) return null;
  var lower = String(title).toLowerCase();
  if (CANONICAL_NAMES[lower]) return CANONICAL_NAMES[lower];
  var tokens = lower.split(/[^a-z0-9-]+/).filter(function(t) { return t && t.length >= 3; });
  // Multi-word combos first (so "dead hang" beats just "hang")
  for (var i = 0; i < tokens.length - 1; i++) {
    var combo = tokens[i] + ' ' + tokens[i + 1];
    if (CANONICAL_NAMES[combo]) return CANONICAL_NAMES[combo];
  }
  for (var j = 0; j < tokens.length; j++) {
    if (CANONICAL_NAMES[tokens[j]]) return CANONICAL_NAMES[tokens[j]];
  }
  return null;
}

var CATEGORY_OVERRIDES = {
  'Plank': 'strength', 'Crunch': 'strength', 'Sit-Up': 'strength', 'Leg Raise': 'strength',
  'Mountain Climber': 'strength', 'Dead Bug': 'rehab', 'Bird Dog': 'rehab',
  'Ab Wheel': 'strength', 'Russian Twist': 'strength', 'Windshield Wiper': 'strength',
  'Push-Up': 'strength', 'Pull-Up': 'strength', 'Chin-Up': 'strength', 'Dip': 'strength',
  'Dead Hang': 'strength',
  'Burpee': 'cardio', 'Jumping Jack': 'cardio', 'Jump Rope': 'cardio',
  'Glute Bridge': 'rehab', 'Clamshell': 'rehab', 'Cat-Cow': 'rehab', 'Hip Flexor Stretch': 'rehab',
  'Foam Rolling': 'rehab', 'Foam Roll': 'rehab',
  'Boxing': 'martial_arts', 'Sparring': 'martial_arts', 'Shadow Boxing': 'martial_arts',
  'Bag Work': 'martial_arts', 'Pad Work': 'martial_arts',
  'Elliptical': 'cardio', 'Treadmill': 'cardio', 'Stairmaster': 'cardio',
  'Rowing Machine': 'cardio', 'Stationary Bike': 'cardio',
  'Running': 'cardio', 'Walking': 'cardio', 'Hiking': 'cardio',
  'Yoga': 'mind_body', 'Pilates': 'mind_body', 'Stretching': 'mind_body',
  'Meditation': 'mind_body', 'Breathwork': 'mind_body',
  'Squat': 'strength', 'Lunge': 'strength', 'Deadlift': 'strength',
  'Bench Press': 'strength', 'Overhead Press': 'strength',
};

var SUBCATEGORY_MAP = {
  'Plank': 'core', 'Crunch': 'core', 'Sit-Up': 'core', 'Leg Raise': 'core',
  'Mountain Climber': 'core', 'Ab Wheel': 'core', 'Russian Twist': 'core', 'Windshield Wiper': 'core',
  'Dead Bug': 'physical therapy', 'Bird Dog': 'physical therapy',
  'Push-Up': 'upper body', 'Pull-Up': 'upper body', 'Chin-Up': 'upper body', 'Dip': 'upper body',
  'Dead Hang': 'calisthenics',
  'Dumbbell Row': 'upper body', 'Bicep Curl': 'upper body', 'Bench Press': 'upper body', 'Overhead Press': 'upper body',
  'Squat': 'lower body', 'Lunge': 'lower body', 'Deadlift': 'lower body',
  'Burpee': 'hiit', 'Jumping Jack': 'hiit', 'Jump Rope': 'jump rope',
  'Glute Bridge': 'physical therapy', 'Clamshell': 'physical therapy',
  'Cat-Cow': 'physical therapy', 'Hip Flexor Stretch': 'physical therapy',
  'Foam Rolling': 'foam rolling', 'Foam Roll': 'foam rolling',
  'Boxing': 'striking', 'Shadow Boxing': 'striking', 'Bag Work': 'striking', 'Pad Work': 'striking',
  'Sparring': 'mma',
  'Elliptical': 'machine', 'Treadmill': 'machine', 'Stairmaster': 'machine',
  'Rowing Machine': 'machine', 'Stationary Bike': 'machine',
  'Running': 'outdoor', 'Walking': 'outdoor', 'Hiking': 'outdoor',
  'Yoga': 'yoga', 'Pilates': 'pilates', 'Stretching': 'stretching',
  'Meditation': 'meditation', 'Breathwork': 'breathwork',
};

function normalizeExerciseName(name) {
  if (!name) return name;
  var lower = name.toLowerCase().trim();
  if (CANONICAL_NAMES[lower]) return CANONICAL_NAMES[lower];
  if (lower.endsWith('s') && !lower.endsWith('ss')) {
    var singular = lower.slice(0, -1);
    if (CANONICAL_NAMES[singular]) return CANONICAL_NAMES[singular];
  }
  return name.trim();
}

function normalizeCategory(name, aiCategory) {
  if (CATEGORY_OVERRIDES[name]) return CATEGORY_OVERRIDES[name];
  // Map old categories to new taxonomy
  if (aiCategory === 'combat' || aiCategory === 'mma') return 'martial_arts';
  if (aiCategory === 'mobility') return 'mind_body';
  if (aiCategory === 'core') return 'strength';
  return aiCategory || 'other';
}

function getSubcategory(name, aiCategory, mainCategory) {
  if (SUBCATEGORY_MAP[name]) return SUBCATEGORY_MAP[name];
  // Infer from old AI category
  if (aiCategory === 'core') return 'core';
  if (aiCategory === 'combat' || aiCategory === 'mma') return 'general';
  if (aiCategory === 'mobility') return 'stretching';
  return 'general';
}

app.post("/api/profiles/:id/extract-exercises", async function(req, res) {
  try {
    var profileId = req.params.id;
    var body = req.body;
    if (!body.notes || !body.notes.trim()) {
      console.log("[extract-exercises] No notes provided, skipping");
      return res.json({ success: true, exercises: [], count: 0 });
    }

    console.log("[extract-exercises] Processing notes for profile " + profileId + ": " + body.notes.substring(0, 100) + "...");

    var prompt = "STRICT RULE: Only extract exercises that are explicitly named in the raw text. Never infer, assume, or hallucinate exercises or weights that are not clearly stated. If a weight is ambiguous or missing, omit weight_lbs entirely. Do not extract stretches, mobility work, or warm-ups as weighted exercises unless they explicitly include sets, reps, and weight.\n\nExtract all exercises from these workout notes. For each exercise identify: name (normalized), category (one of: strength/combat/cardio/mobility/rehab/core/other), sets (number or null), reps (number or null), weight_lbs (number or null), distance_miles (number or null), duration_minutes (number or null), raw_text (original text snippet).\n\nCATEGORY GUIDE:\n- strength: weightlifting, resistance, dumbbell/barbell work, push-up, pull-up, dip, squat, lunge, row\n- combat: MMA, boxing, sparring, martial arts, kicks, grappling, BJJ, pad work\n- cardio: running, elliptical, jumping jacks, cycling, rowing, burpee, jump rope\n- mobility: stretching, yoga, flexibility work\n- rehab: PT exercises, injury rehab, therapeutic (glute bridge, clamshell, cat-cow, hip flexor stretch)\n- core: plank, crunch, sit-up, leg raise, dead bug, bird dog, mountain climber, ab wheel, russian twist, windshield wiper - these are ALWAYS 'core' not 'strength'\n- other: anything else\n\nCRITICAL NORMALIZATION RULES:\n- Always use singular form: 'Glute Bridge' not 'Glute Bridges'\n- Capitalize first letter of each word\n- Use hyphens for compound exercises: 'Push-Up', 'Pull-Up', 'Sit-Up', 'Cat-Cow'\n- Remove trailing s from plural exercise names\n\nDATA INTEGRITY RULES (NON-NEGOTIABLE):\n- NEVER invent or assume weights, reps, sets, distances, or durations that are not explicitly stated in the raw text. The raw text is the only source of truth.\n- If a field is ambiguous, missing, or you are not 100% certain, OMIT it entirely (use null). Better to under-report than to fabricate.\n- Do NOT guess weights based on the exercise name (e.g. don't assume bench press is 135lb just because that's a common starting weight).\n- Do NOT carry over weights from one exercise to another — each exercise's fields must come from its own portion of the raw text.\n- Do NOT infer weight from words like 'heavy' or 'light' — those are not numeric values.\n- The raw_text field MUST be the literal substring from the user's notes that this exercise was extracted from. If the substring doesn't contain the weight, weight_lbs MUST be null.\n\nReturn ONLY a JSON array of exercise objects, no explanation.\nExample: [{\"name\":\"Glute Bridge\",\"category\":\"rehab\",\"sets\":3,\"reps\":12,\"weight_lbs\":null,\"distance_miles\":null,\"duration_minutes\":null,\"raw_text\":\"glute bridges 3x12\"}]\nWorkout type: " + (body.type || "unknown") + "\nNotes: " + body.notes;

    var aiText = await callAI(prompt, 1000, MODEL_HAIKU);
    console.log("[extract-exercises] Raw AI response: " + (aiText || "(empty)").substring(0, 300));

    var exercises = [];
    try {
      var startIdx = aiText.indexOf("[");
      var endIdx = aiText.lastIndexOf("]");
      if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
        console.error("[extract-exercises] No JSON array found in AI response");
        return res.json({ success: true, exercises: [], count: 0 });
      }
      var cleaned = aiText.substring(startIdx, endIdx + 1);
      exercises = JSON.parse(cleaned);
      if (!Array.isArray(exercises)) exercises = [];
    } catch (parseErr) {
      console.error("[extract-exercises] JSON parse error:", parseErr.message, "| Raw text:", aiText.substring(0, 200));
      return res.json({ success: true, exercises: [], count: 0 });
    }

    console.log("[extract-exercises] AI returned " + exercises.length + " exercises");

    // Insert into Supabase
    var inserted = 0;
    for (var i = 0; i < exercises.length; i++) {
      var ex = exercises[i];
      if (!ex.name) continue;
      ex.name = normalizeExerciseName(ex.name);
      var aiCat = ex.category;
      ex.category = normalizeCategory(ex.name, aiCat);
      ex.main_category = ex.category;
      ex.subcategory = getSubcategory(ex.name, aiCat, ex.category);
      var insertBody = {
        profile_id: parseInt(profileId),
        workout_id: body.workout_id ? parseInt(body.workout_id) : null,
        date: body.date,
        name: ex.name,
        category: ex.category,
        main_category: ex.main_category,
        subcategory: ex.subcategory,
        sets: ex.sets || null,
        reps: ex.reps || null,
        weight_lbs: ex.weight_lbs || null,
        distance_miles: ex.distance_miles || null,
        duration_minutes: ex.duration_minutes || null,
        notes: null,
        raw_text: ex.raw_text || null,
      };
      var insertRes = await fetch(SUPABASE_URL + "/rest/v1/exercises", {
        method: "POST",
        headers: sbHeaders("return=minimal"),
        body: JSON.stringify(insertBody),
      });
      if (insertRes.ok) {
        inserted++;
      } else {
        var errText = await insertRes.text();
        console.error("[extract-exercises] Supabase insert error for '" + ex.name + "':", insertRes.status, errText);
      }
    }
    console.log("[extract-exercises] Inserted " + inserted + "/" + exercises.length + " exercises into Supabase");
    res.json({ success: true, exercises: exercises, count: inserted });
  } catch (e) {
    console.error("[extract-exercises] Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── ADMIN: AUDIT BAD EXERCISE EXTRACTIONS ─────────────────────────────────
// Lookup helper for Bug 1 ("phantom 150lb bench press"). Hit this from a
// browser on Shimmy's session to find the offending row + its raw_text, then
// either DELETE that exact row or accept it. Filtered to one profile so a
// stray request can't blow away anyone else's data.
//
//   GET /api/profiles/:id/exercises/audit?name=Bench%20Press&min_weight=140
//   DELETE /api/profiles/:id/exercises/:exerciseId
app.get("/api/profiles/:id/exercises/audit", async function(req, res) {
  try {
    var pid = req.params.id;
    var name = req.query.name;
    var minWeight = req.query.min_weight ? parseFloat(req.query.min_weight) : null;
    var maxWeight = req.query.max_weight ? parseFloat(req.query.max_weight) : null;
    var url = SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid +
      "&select=id,workout_id,date,name,sets,reps,weight_lbs,raw_text,created_at" +
      "&order=date.desc";
    if (name) url += "&name=ilike." + encodeURIComponent("*" + name + "*");
    if (minWeight != null) url += "&weight_lbs=gte." + minWeight;
    if (maxWeight != null) url += "&weight_lbs=lte." + maxWeight;
    var r = await fetch(url, { headers: sbHeaders() });
    var rows = await r.json();
    res.json({ success: true, exercises: Array.isArray(rows) ? rows : [], count: Array.isArray(rows) ? rows.length : 0 });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete("/api/profiles/:id/exercises/:exerciseId", async function(req, res) {
  try {
    var pid = req.params.id;
    var eid = req.params.exerciseId;
    // Verify the row belongs to the profile before deleting.
    var check = await fetch(SUPABASE_URL + "/rest/v1/exercises?id=eq." + eid + "&profile_id=eq." + pid + "&select=id", { headers: sbHeaders() });
    var rows = await check.json();
    if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ success: false, error: "Not found for this profile" });
    var del = await fetch(SUPABASE_URL + "/rest/v1/exercises?id=eq." + eid, {
      method: "DELETE",
      headers: sbHeaders("return=minimal"),
    });
    if (!del.ok) {
      var t = await del.text();
      return res.status(del.status).json({ success: false, error: t });
    }
    res.json({ success: true, deletedId: eid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/profiles/:id/exercises", async function(req, res) {
  try {
    var profileId = req.params.id;
    var url = SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + profileId + "&select=*&order=date.desc";
    if (req.query.name) url += "&name=eq." + encodeURIComponent(req.query.name);
    if (req.query.category) url += "&category=eq." + encodeURIComponent(req.query.category);
    if (req.query.main_category) url += "&main_category=eq." + encodeURIComponent(req.query.main_category);
    if (req.query.subcategory) url += "&subcategory=eq." + encodeURIComponent(req.query.subcategory);
    if (req.query.limit) url += "&limit=" + req.query.limit;
    else url += "&limit=5000";
    var r = await fetch(url, { headers: sbHeaders() });
    var data = await r.json();
    var exercises = Array.isArray(data) ? data : [];

    // Group by name for summary
    var grouped = {};
    for (var i = 0; i < exercises.length; i++) {
      var ex = exercises[i];
      if (!grouped[ex.name]) {
        grouped[ex.name] = { name: ex.name, category: ex.category, main_category: ex.main_category || ex.category, subcategory: ex.subcategory || 'general', count: 0, last_date: null, best_weight: null, best_reps: null, sessions: [] };
      }
      var g = grouped[ex.name];
      g.count++;
      if (!g.last_date || ex.date > g.last_date) g.last_date = ex.date;
      if (ex.weight_lbs && (!g.best_weight || ex.weight_lbs > g.best_weight)) g.best_weight = ex.weight_lbs;
      if (ex.reps && (!g.best_reps || ex.reps > g.best_reps)) g.best_reps = ex.reps;
      g.sessions.push(ex);
    }

    var summary = Object.values(grouped).sort(function(a, b) { return b.count - a.count; });
    res.json({ success: true, exercises: summary, raw: exercises });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/profiles/:id/exercises/stats", async function(req, res) {
  try {
    var profileId = req.params.id;

    // Fetch all exercises
    var er = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + profileId + "&select=*&order=date.desc&limit=10000", { headers: sbHeaders() });
    var allEx = await er.json();
    if (!Array.isArray(allEx)) allEx = [];

    // Fetch all workouts for type frequency
    var wr = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + profileId + "&select=type,date,done&order=date.desc&limit=10000", { headers: sbHeaders() });
    var allWk = await wr.json();
    if (!Array.isArray(allWk)) allWk = [];

    // Workout type frequency
    var typeFreq = {};
    allWk.forEach(function(w) { if (w.done) { typeFreq[w.type] = (typeFreq[w.type] || 0) + 1; } });

    // Top exercises
    var exCount = {};
    allEx.forEach(function(ex) {
      if (!exCount[ex.name]) exCount[ex.name] = { name: ex.name, category: ex.category, main_category: ex.main_category || ex.category, subcategory: ex.subcategory || 'general', count: 0 };
      exCount[ex.name].count++;
    });
    var topEx = Object.values(exCount).sort(function(a, b) { return b.count - a.count; }).slice(0, 10);

    // Category breakdown (main_category counts)
    var catBreakdown = {};
    allEx.forEach(function(ex) {
      var mc = ex.main_category || ex.category || 'other';
      catBreakdown[mc] = (catBreakdown[mc] || 0) + 1;
    });

    // Subcategory breakdown
    var subBreakdown = {};
    allEx.forEach(function(ex) {
      var mc = ex.main_category || ex.category || 'other';
      var sc = ex.subcategory || 'general';
      if (!subBreakdown[mc]) subBreakdown[mc] = {};
      subBreakdown[mc][sc] = (subBreakdown[mc][sc] || 0) + 1;
    });

    // Personal records
    var prs = {};
    allEx.forEach(function(ex) {
      if (!prs[ex.name]) prs[ex.name] = { name: ex.name, max_weight: null, max_reps: null, max_distance: null };
      var p = prs[ex.name];
      if (ex.weight_lbs && (!p.max_weight || ex.weight_lbs > p.max_weight)) p.max_weight = ex.weight_lbs;
      if (ex.reps && (!p.max_reps || ex.reps > p.max_reps)) p.max_reps = ex.reps;
      if (ex.distance_miles && (!p.max_distance || ex.distance_miles > p.max_distance)) p.max_distance = ex.distance_miles;
    });

    // Weekly volume (last 12 weeks)
    var weeklyVol = {};
    var now = new Date();
    allEx.forEach(function(ex) {
      if (!ex.sets) return;
      var d = new Date(ex.date + "T12:00:00");
      var weekAgo = Math.floor((now - d) / (7 * 86400000));
      if (weekAgo < 12) {
        var weekStart = new Date(d);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        var key = weekStart.toISOString().slice(0, 10);
        weeklyVol[key] = (weeklyVol[key] || 0) + (ex.sets || 0);
      }
    });

    // Most active day
    var dayCount = [0,0,0,0,0,0,0];
    allWk.forEach(function(w) {
      if (w.done) {
        var d = new Date(w.date + "T12:00:00").getDay();
        dayCount[d]++;
      }
    });
    var dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    var mostActiveDay = dayNames[dayCount.indexOf(Math.max.apply(null, dayCount))];

    var totalSets = 0, totalReps = 0, totalWeight = 0;
    allEx.forEach(function(ex) {
      totalSets += (ex.sets || 0);
      totalReps += (ex.sets || 1) * (ex.reps || 0);
      totalWeight += (ex.sets || 1) * (ex.reps || 0) * (ex.weight_lbs || 0);
    });

    res.json({
      success: true,
      stats: {
        workout_type_frequency: typeFreq,
        top_exercises: topEx,
        personal_records: Object.values(prs),
        weekly_volume: weeklyVol,
        total_exercises_logged: allEx.length,
        unique_exercises: Object.keys(exCount).length,
        total_workouts: allWk.filter(function(w) { return w.done; }).length,
        most_active_day: mostActiveDay,
        total_sets: totalSets,
        total_reps: totalReps,
        total_weight: Math.round(totalWeight),
        category_breakdown: catBreakdown,
        subcategory_breakdown: subBreakdown,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/profiles/:id/exercises/:name", async function(req, res) {
  try {
    var profileId = req.params.id;
    var name = decodeURIComponent(req.params.name);
    var url = SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + profileId + "&name=eq." + encodeURIComponent(name) + "&select=*&order=date.asc&limit=5000";
    var r = await fetch(url, { headers: sbHeaders() });
    var history = await r.json();
    if (!Array.isArray(history)) history = [];

    var pr = { max_weight: null, max_reps: null, max_distance: null, max_sets: null };
    history.forEach(function(ex) {
      if (ex.weight_lbs && (!pr.max_weight || ex.weight_lbs > pr.max_weight)) pr.max_weight = ex.weight_lbs;
      if (ex.reps && (!pr.max_reps || ex.reps > pr.max_reps)) pr.max_reps = ex.reps;
      if (ex.distance_miles && (!pr.max_distance || ex.distance_miles > pr.max_distance)) pr.max_distance = ex.distance_miles;
      if (ex.sets && (!pr.max_sets || ex.sets > pr.max_sets)) pr.max_sets = ex.sets;
    });

    res.json({ success: true, exercise: name, history: history, pr: pr });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── DAILY CHECK-IN ───────────────────────────────────────────────────────
app.get("/api/profiles/:id/checkin", async function(req, res) {
  try {
    const pid = req.params.id;
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: "date query param required" });
    console.log("[Checkin] GET profile=" + pid + " date=" + date);
    const r = await fetch(
      SUPABASE_URL + "/rest/v1/daily_checkins?profile_id=eq." + pid + "&date=eq." + date + "&limit=1",
      { headers: sbHeaders() }
    );
    const rows = await r.json();
    console.log("[Checkin] GET result:", rows && rows.length ? "found" : "none");
    res.json({ checkin: (rows && rows.length) ? rows[0] : null });
  } catch (e) {
    console.error("[Checkin] GET error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/profiles/:id/checkin", async function(req, res) {
  try {
    const pid = req.params.id;
    const { date, energy, soreness, severity, checkin_text } = req.body;
    if (!date) return res.status(400).json({ error: "date is required" });
    const payload = {
      profile_id: pid,
      date: date,
      energy: energy || null,
      soreness: soreness || [],
      severity: severity || null,
      checkin_text: checkin_text || null,
    };
    console.log("[Checkin] POST profile=" + pid + " date=" + date + " energy=" + (energy || "none"));
    const r = await fetch(
      SUPABASE_URL + "/rest/v1/daily_checkins?on_conflict=profile_id,date",
      {
        method: "POST",
        headers: sbHeaders("return=representation,resolution=merge-duplicates"),
        body: JSON.stringify(payload),
      }
    );
    const data = await r.json();
    console.log("[Checkin] Upsert status=" + r.status + " result:", JSON.stringify(data).substring(0, 200));
    if (!r.ok) return res.status(r.status).json({ error: data });
    res.json({ success: true, checkin: data[0] || payload });
  } catch (e) {
    console.error("[Checkin] POST error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DAILY AI RECOMMENDATION CACHE ────────────────────────────────────────
// Stored on profiles: daily_recommendations (jsonb),
// daily_recommendations_date (date/text YYYY-MM-DD),
// daily_recommendations_readiness (int, readiness score used to generate).
app.get("/api/profiles/:id/daily-recs", async function(req, res) {
  try {
    const pid = req.params.id;
    const r = await fetch(
      SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid +
        "&select=daily_recommendations,daily_recommendations_date,daily_recommendations_readiness",
      { headers: sbHeaders() }
    );
    const rows = await r.json();
    if (!rows || !rows.length) return res.status(404).json({ error: "Profile not found" });
    res.json({
      success: true,
      recommendations: rows[0].daily_recommendations || null,
      date: rows[0].daily_recommendations_date || null,
      readiness: rows[0].daily_recommendations_readiness === undefined ? null : rows[0].daily_recommendations_readiness,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/profiles/:id/daily-recs", async function(req, res) {
  try {
    const pid = req.params.id;
    const { recommendations, readiness, date } = req.body || {};
    if (!recommendations || typeof recommendations !== "object") {
      return res.status(400).json({ error: "recommendations object required" });
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const fallbackDate = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    const recsWithMeta = Object.assign({}, recommendations, {
      generated_at: recommendations.generated_at || now.toISOString(),
    });
    const payload = {
      daily_recommendations: recsWithMeta,
      daily_recommendations_date: date || fallbackDate,
      daily_recommendations_readiness:
        typeof readiness === "number" ? Math.round(readiness) : null,
    };
    const r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid, {
      method: "PATCH",
      headers: sbHeaders("return=representation"),
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: text });
    }
    res.json({ success: true, recommendations: recsWithMeta, date: payload.daily_recommendations_date, readiness: payload.daily_recommendations_readiness });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PROGRESS BRIEF CACHE ─────────────────────────────────────────────────
// Mirrors the daily-recs cache pattern. Stored on profiles:
//   progress_brief jsonb, progress_brief_date date.
// Invalidated on any workout save/edit/delete so the next Today tab load
// regenerates against the new history.
app.get("/api/profiles/:id/progress-brief", async function(req, res) {
  try {
    const pid = req.params.id;
    const r = await fetch(
      SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid +
        "&select=progress_brief,progress_brief_date",
      { headers: sbHeaders() }
    );
    const rows = await r.json();
    if (!rows || !rows.length) return res.status(404).json({ error: "Profile not found" });
    res.json({
      success: true,
      brief: rows[0].progress_brief || null,
      date: rows[0].progress_brief_date || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/profiles/:id/progress-brief", async function(req, res) {
  try {
    const pid = req.params.id;
    const { brief, date } = req.body || {};
    if (!brief || typeof brief !== "object") {
      return res.status(400).json({ error: "brief object required" });
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const fallbackDate = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    const payload = {
      progress_brief: brief,
      progress_brief_date: date || fallbackDate,
    };
    const r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid, {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: text });
    }
    res.json({ success: true, brief: brief, date: payload.progress_brief_date });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fire-and-forget wipe used by workout mutations. Nulls progress brief only;
// daily recs have their own invalidation rules (readiness-based, check-in, etc).
async function clearProgressBriefCache(pid) {
  if (!pid) return;
  try {
    await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid, {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify({ progress_brief: null, progress_brief_date: null }),
    });
    console.log("[ProgressBrief] Cleared cache for profile " + pid);
  } catch (e) {
    console.warn("[ProgressBrief] clearProgressBriefCache failed:", e.message);
  }
}

// ── ROAD MAP ─────────────────────────────────────────────────────────────
app.get("/api/profiles/:id/roadmap", async function(req, res) {
  try {
    const pid = req.params.id;
    const r = await fetch(
      SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid + "&select=roadmap,roadmap_updated_at",
      { headers: sbHeaders() }
    );
    const rows = await r.json();
    if (!rows || !rows.length) return res.status(404).json({ error: "Profile not found" });
    res.json({ success: true, roadmap: rows[0].roadmap, roadmap_updated_at: rows[0].roadmap_updated_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/profiles/:id/roadmap", async function(req, res) {
  try {
    const pid = req.params.id;
    // Fetch profile
    const pRes = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid, { headers: sbHeaders() });
    const profiles = await pRes.json();
    if (!profiles || !profiles.length) return res.status(404).json({ error: "Profile not found" });
    const profile = profiles[0];
    const pd = profile.profile_data || {};
    const goals = pd.goals || [];
    const brief = (profile.coaching_brief || '').substring(0, 300);

    // Fetch last 30 workouts
    const wRes = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + pid + "&order=date.desc&limit=30", { headers: sbHeaders() });
    const workouts = await wRes.json();
    const doneCount = (workouts || []).filter(w => w.done).length;
    const types = {};
    (workouts || []).forEach(w => { if (w.type) types[w.type] = (types[w.type] || 0) + 1; });
    const typeStr = Object.entries(types).map(([k,v]) => k + ' x' + v).join(', ') || 'none logged';

    // Build goal context
    let goalCtx = '';
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i];
      goalCtx += (i + 1) + '. ' + (g.title || 'Untitled') + ' (' + (g.status || 'IN PROGRESS') + ')';
      if (g.target_value) goalCtx += ' — target: ' + g.target_value + ' ' + (g.unit || '');
      goalCtx += '\n';
    }

    // Build schedule from profile_data. Supports both legacy string-per-day
    // format and the new array-of-{activity, duration}-per-day format.
    let scheduleStr = '';
    if (pd.schedule) {
      const days = ['mon','tue','wed','thu','fri','sat','sun'];
      const dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
      const formatDay = (v) => {
        if (!v) return null;
        if (Array.isArray(v)) {
          const parts = v
            .filter((e) => e && e.activity)
            .map((e) => e.activity + (typeof e.duration === 'number' && e.duration > 0 ? ' (' + e.duration + ' min)' : ''));
          return parts.length ? parts.join(' + ') : null;
        }
        if (typeof v === 'string') {
          const s = v.trim();
          return (!s || s === 'Flexible') ? null : s;
        }
        return null;
      };
      days.forEach(function(d, i) {
        const f = formatDay(pd.schedule[d]);
        if (f) scheduleStr += dayNames[i] + ': ' + f + '\n';
      });
    }

    const prompt = 'You are a personal fitness coach creating a realistic road map for this athlete based on their current progress and goals.\n\n' +
      'ATHLETE PROFILE:\n' + (pd.ai_prompt_context || pd.name || 'Athlete') + '\n\n' +
      'GOAL PRIORITIES AND CURRENT PROGRESS:\n' + (goalCtx || 'No goals set yet.\n') + '\n' +
      'RECENT CONSISTENCY: ' + doneCount + ' sessions in last 30 days (~' + Math.round(doneCount / 4.3) + '/week). Types: ' + typeStr + '\n\n' +
      (scheduleStr ? 'ATHLETE\'S ACTUAL WEEKLY SCHEDULE (use this exactly, do not suggest different days):\n' + scheduleStr + '\nWhen writing the Weekly Blueprint section, build around these specific days. For example if Tuesday and Thursday are MMA days, the blueprint must show MMA on Tuesday and Thursday, not Monday or Saturday.\n\n' : '') +
      'COACHING BRIEF:\n' + (brief || 'No coaching brief yet.') + '\n\n' +
      'Generate a realistic road map with:\n\n' +
      'CURRENT STATUS (1 paragraph):\nWhere they are right now honestly - consistency, progress toward each goal, what\'s working.\n\n' +
      '30-DAY MILESTONES:\n- 3 specific achievable targets for next 30 days\n- One per top 3 goals\n- Concrete and measurable\n\n' +
      '90-DAY MILESTONES:\n- 3 specific targets for 90 days\n- Based on realistic progression from current pace\n\n' +
      '6-MONTH VISION:\n- Where they could realistically be in 6 months\n- If consistent at current pace vs if they hit targets\n\n' +
      '12-MONTH VISION:\n- Long term projection\n- Which goals could be achieved by then\n\n' +
      'WEEKLY BLUEPRINT:\n- Build around the athlete\'s ACTUAL schedule above — do not change their training days\n- Fill in recovery/rest days and add specific focus for each session\n- If no schedule provided, suggest an ideal split\n\n' +
      'BIGGEST RISK:\n- One honest assessment of what could derail progress\n- One specific mitigation strategy\n\n' +
      'Keep total response under 600 words. Be specific with numbers and dates. Be honest but encouraging. Use markdown formatting with ## headers.';

    console.log("[Roadmap] Generating for profile " + pid);
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL_SONNET, max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
    });
    const aiData = await aiRes.json();
    const roadmap = (aiData.content && aiData.content[0]) ? aiData.content[0].text : '';
    if (!roadmap) return res.status(500).json({ error: "AI returned empty response" });

    // Save to profiles
    const now = new Date().toISOString();
    await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid, {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify({ roadmap: roadmap, roadmap_updated_at: now }),
    });
    console.log("[Roadmap] Saved for profile " + pid);
    res.json({ success: true, roadmap: roadmap, roadmap_updated_at: now });
  } catch (e) {
    console.error("[Roadmap] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AI PROXY ──────────────────────────────────────────────────────────────
// The client sends a `callType` ("daily_recs", "format_notes", "workout_title",
// etc.) and the server picks the model. The client is no longer allowed to
// request an expensive model for a cheap task — if `model` is sent it's logged
// and dropped.
//
// Any string `system` prompt is automatically rewritten into a single-block
// array with `cache_control: {type: "ephemeral"}` so the prefix (tools + system)
// is cached on Anthropic's side and subsequent calls on the same prompt are
// billed at ~10% of input-token rate. See shared/prompt-caching.md.
app.post("/api/ai", async function(req, res) {
  const bodySize = JSON.stringify(req.body).length;
  const callType = req.body && req.body.callType;
  console.log("[AI] Request received, body size=" + bodySize + " bytes, callType=" + (callType || "(none)"));
  try {
    const forwarded = Object.assign({}, req.body);
    // Strip control fields that shouldn't hit Anthropic.
    delete forwarded.callType;

    // Server-side model selection. Ignore any client-sent model.
    const chosenModel = modelForCallType(callType);
    if (forwarded.model && forwarded.model !== chosenModel) {
      console.log("[AI] Overriding client-requested model '" + forwarded.model + "' with server-chosen '" + chosenModel + "' for callType=" + (callType || "(none)"));
    }
    forwarded.model = chosenModel;

    // Auto-cache the system prompt. If client sent a plain string, wrap it.
    // If client already sent a structured array, only add cache_control to the
    // last block if none of the blocks already have one (don't clobber).
    //
    // TTL: daily_recs uses 1-hour TTL because users check the app several
    // times a day and the system prompt is stable across sessions. 1h writes
    // cost 2× (vs 1.25× for 5m) but pay off after ~3 reads, which is typical.
    // All other callers get the 5-minute default.
    const cacheControl = callType === "daily_recs"
      ? { type: "ephemeral", ttl: "1h" }
      : { type: "ephemeral" };
    if (typeof forwarded.system === "string" && forwarded.system.length > 0) {
      forwarded.system = [{
        type: "text",
        text: forwarded.system,
        cache_control: cacheControl,
      }];
    } else if (Array.isArray(forwarded.system) && forwarded.system.length > 0) {
      const hasCache = forwarded.system.some(function(b) { return b && b.cache_control; });
      if (!hasCache) {
        const last = forwarded.system[forwarded.system.length - 1];
        if (last && typeof last === "object") last.cache_control = cacheControl;
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(forwarded),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    console.log("[AI] Anthropic response status=" + response.status + " model=" + chosenModel);
    const data = await response.json();
    if (data && data.usage) {
      console.log("[AI] usage: input=" + (data.usage.input_tokens || 0) +
        " output=" + (data.usage.output_tokens || 0) +
        " cache_write=" + (data.usage.cache_creation_input_tokens || 0) +
        " cache_read=" + (data.usage.cache_read_input_tokens || 0));
    }
    res.json(data);
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("[AI] Anthropic API timed out after 25s");
      res.status(504).json({ error: { message: "AI request timed out (25s)" } });
    } else {
      console.error("[AI] Error:", err.message);
      res.status(500).json({ error: { message: err.message } });
    }
  }
});

// ── MICRO GOALS (Active Challenges) ──────────────────────────────────────
// Supabase table: micro_goals
//   id uuid primary key default gen_random_uuid(),
//   profile_id uuid references profiles(id) on delete cascade,
//   title text,
//   type text,  -- daily_habit | weekly_frequency | cumulative_volume | strength_milestone | skill_technique | streak | recovery_balance
//   target_value numeric,
//   target_unit text,
//   period text,          -- daily | weekly | monthly | custom
//   end_date date null,
//   current_value numeric default 0,
//   is_active boolean default true,
//   created_at timestamp default now()

// Wipe cached daily recommendations for a profile so the next client fetch
// regenerates with fresh context (new micro-goals, etc.). Fire-and-forget.
async function clearDailyRecsCache(pid) {
  if (!pid) return;
  try {
    await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid, {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify({
        daily_recommendations: null,
        daily_recommendations_date: null,
        daily_recommendations_readiness: null
      })
    });
    console.log("[MicroGoal] Cleared daily recs cache for profile " + pid);
  } catch (e) {
    console.warn("[MicroGoal] clearDailyRecsCache failed:", e.message);
  }
}

// Look up the profile_id that owns a micro_goals row.
async function getMicroGoalProfileId(gid) {
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/micro_goals?id=eq." + gid + "&select=profile_id", { headers: sbHeaders() });
    const rows = await r.json();
    return rows && rows[0] ? rows[0].profile_id : null;
  } catch (e) {
    return null;
  }
}

function mgYmdLocal(d) {
  var p = function(n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function mgStartOfWeekLocal(now) {
  var d = new Date(now);
  d.setHours(0, 0, 0, 0);
  var day = d.getDay(); // 0=sun..6=sat
  var diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return d;
}

// Parse a free-text exercise note for the longest duration mentioned, in
// seconds. Handles common formats:
//   "80 seconds", "80 sec", "80s"
//   "1:20" (mm:ss)
//   "2 min", "2 minutes", "2.5 min"
//   "1 min 42 sec", "1m 42s" (combined — summed, not max'd)
// Returns 0 if nothing parseable is found. Used by strength_milestone goals
// where the unit is time-based (e.g. "2-minute hang", target=120 seconds).
function parseDurationToSeconds(text) {
  if (!text) return 0;
  var s = String(text).toLowerCase();
  var max = 0;
  var m;
  // Combined "X min Y sec" / "Xm Ys" — handle BEFORE the standalone patterns
  // so taking the max across patterns doesn't miss the sum (e.g. "1 min 42
  // sec" would otherwise return max(60, 42) = 60 instead of 102).
  var combinedRe = /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\s*(?:and\s+)?(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/g;
  while ((m = combinedRe.exec(s)) !== null) {
    var combo = parseFloat(m[1]) * 60 + parseFloat(m[2]);
    if (!isNaN(combo) && combo > max) max = combo;
  }
  // mm:ss — guard against years/timestamps by capping minutes at 999
  var mmssRe = /(\d{1,3}):([0-5]\d)\b/g;
  while ((m = mmssRe.exec(s)) !== null) {
    var sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    if (sec > max) max = sec;
  }
  // "N seconds" / "N sec" / "N secs" / bare "Ns" only when preceded by a digit boundary
  var secRe = /(\d+(?:\.\d+)?)\s*(?:seconds?|secs?)\b/g;
  while ((m = secRe.exec(s)) !== null) {
    var n = parseFloat(m[1]);
    if (!isNaN(n) && n > max) max = n;
  }
  // "Ns" (e.g. "30s") — only when followed by space/end, to avoid hitting
  // "60s music" or similar word boundaries. `x` is allowed as a leading
  // boundary so set notation like "4x25s" / "2x30s" extracts the per-set
  // duration (25, 30) — strength_milestone takes MAX across entries, so the
  // per-set value is the right "single best effort" to compare.
  var sShortRe = /(?:^|[\s,x])(\d+(?:\.\d+)?)s(?=$|[\s,.;])/g;
  while ((m = sShortRe.exec(s)) !== null) {
    var n2 = parseFloat(m[1]);
    if (!isNaN(n2) && n2 > max) max = n2;
  }
  // "N minutes" / "N min" / "N mins" — also "N-min" (hyphenated) like "2-min hang"
  var minRe = /(\d+(?:\.\d+)?)[\s-]*(?:minutes?|mins?)\b/g;
  while ((m = minRe.exec(s)) !== null) {
    var nm = parseFloat(m[1]) * 60;
    if (!isNaN(nm) && nm > max) max = nm;
  }
  return max;
}

function mgMatchesKeyword(haystack, needle) {
  if (!haystack || !needle) return false;
  var h = String(haystack).toLowerCase();
  var n = String(needle).toLowerCase().trim();
  if (!n) return false;
  var tokens = n.split(/[^a-z0-9]+/).filter(function(t) { return t.length >= 3; });
  if (!tokens.length) return h.indexOf(n) >= 0;
  return tokens.some(function(t) { return h.indexOf(t) >= 0; });
}

// Canonical-aware exercise matcher used by the micro-goal auto-tracker. If
// the goal title resolves to a known canonical exercise (e.g. "2-minute hang"
// → "Dead Hang"), accept either:
//   1. an EXACT canonical match after normalization, OR
//   2. the canonical name appearing as a whole-word substring of the
//      normalized name (bounded by non-letter chars on both sides).
// The substring branch admits row-name variants like "Dead Hang (Wide Grip)",
// "Dead Hang 60s", and "Wide-Grip Dead Hang Hold" — which the AI extractor
// produces when the user describes a hang with extra context — while still
// excluding "Hanging Leg Raise" (which doesn't contain "Dead Hang" anywhere).
// Strict equality alone was undercounting by ~50% of logged sessions.
function mgMatchesExercise(exName, title) {
  if (!exName || !title) return false;
  var canonical = extractCanonicalFromTitle(title);
  if (canonical) {
    var normEx = normalizeExerciseName(exName);
    if (normEx === canonical) return true;
    var nl = String(normEx).toLowerCase();
    var cl = String(canonical).toLowerCase();
    var idx = nl.indexOf(cl);
    while (idx >= 0) {
      var before = idx === 0 ? '' : nl.charAt(idx - 1);
      var afterPos = idx + cl.length;
      var after = afterPos >= nl.length ? '' : nl.charAt(afterPos);
      var beforeOk = !before || !/[a-z0-9]/.test(before);
      var afterOk = !after || !/[a-z0-9]/.test(after);
      if (beforeOk && afterOk) return true;
      idx = nl.indexOf(cl, idx + 1);
    }
    return false;
  }
  return mgMatchesKeyword(exName, title);
}

async function computeMicroGoalProgress(goal, pid) {
  var type = goal.type;
  var title = goal.title || '';
  var targetUnit = (goal.target_unit || '').toLowerCase();
  var startDate = goal.created_at ? String(goal.created_at).split('T')[0] : null;
  var now = new Date();
  var todayStr = mgYmdLocal(now);

  try {
    if (type === 'cumulative_volume') {
      var afterClause = startDate ? '&date=gte.' + startDate : '';
      var r = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid + afterClause + "&select=name,sets,reps,duration_minutes,distance_miles", { headers: sbHeaders() });
      var rows = await r.json();
      var total = 0;
      (rows || []).forEach(function(e) {
        if (!mgMatchesExercise(e.name, title)) return;
        if (targetUnit === 'minutes' || targetUnit === 'min' || targetUnit === 'mins') {
          total += Number(e.duration_minutes || 0);
        } else if (targetUnit === 'miles' || targetUnit === 'mi' || targetUnit === 'km') {
          total += Number(e.distance_miles || 0);
        } else {
          var sets = Number(e.sets || 1);
          var reps = Number(e.reps || 0);
          total += sets * reps;
        }
      });
      return total;
    }

    if (type === 'weekly_frequency') {
      var weekStart = mgYmdLocal(mgStartOfWeekLocal(now));
      var rw = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + pid + "&date=gte." + weekStart + "&done=eq.true&select=type,date", { headers: sbHeaders() });
      var wrows = await rw.json();
      var count = 0;
      (wrows || []).forEach(function(w) {
        if (mgMatchesKeyword(w.type, title) || mgMatchesKeyword(title, w.type)) count++;
      });
      return count;
    }

    if (type === 'streak') {
      // If the goal title names a specific exercise (e.g. "Dead hang every
      // day"), scope the streak to days where that exercise was logged.
      // Otherwise fall back to the legacy any-completed-workout streak.
      var streakCanonical = extractCanonicalFromTitle(title);
      var streakDates;
      if (streakCanonical) {
        var sxe = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid + "&order=date.desc&limit=2000&select=name,date", { headers: sbHeaders() });
        var sxrows = await sxe.json();
        streakDates = new Set();
        (sxrows || []).forEach(function(e) {
          if (mgMatchesExercise(e.name, title)) streakDates.add(e.date);
        });
      } else {
        var rs = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + pid + "&done=eq.true&order=date.desc&limit=400&select=date", { headers: sbHeaders() });
        var srows = await rs.json();
        streakDates = new Set((srows || []).map(function(w) { return w.date; }));
      }
      var streak = 0;
      var cursor = new Date(now);
      cursor.setHours(0, 0, 0, 0);
      // Allow yesterday to start the streak so a user who hasn't logged today
      // yet still sees their active streak. The streak BREAKS only when
      // yesterday is also missing.
      if (!streakDates.has(mgYmdLocal(cursor))) cursor.setDate(cursor.getDate() - 1);
      while (streakDates.has(mgYmdLocal(cursor))) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      }
      return streak;
    }

    if (type === 'daily_habit') {
      // daily_habit is a simple cumulative day-counter ("X days completed").
      // It has no target — the UI hides the target field — so streak logic
      // belongs to the dedicated `streak` type instead. Use the canonical
      // matcher so "did a hang" / "dead hangs" / "Dead Hang" all count.
      //
      // No date filter: every logged session should register, including any
      // logged on the same calendar day as goal creation (created_at is a UTC
      // timestamp; clipping by it dropped same-day-but-earlier rows for users
      // east of UTC) and any past-date workouts the user later log-corrected.
      // De-dup is per (exercise, calendar date) via the Set below.
      var rh2 = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid + "&select=name,date&order=date.desc&limit=5000", { headers: sbHeaders() });
      var hrows2 = await rh2.json();
      var days = new Set();
      (hrows2 || []).forEach(function(e) { if (e.date && mgMatchesExercise(e.name, title)) days.add(e.date); });
      return days.size;
    }

    if (type === 'strength_milestone') {
      // Time-based milestones (e.g. "2-minute hang", target=120 seconds) need
      // duration parsing rather than weight tracking. We scan duration_minutes
      // AND raw_text/notes since users often describe hangs as "80 seconds"
      // or "1:20" rather than entering a numeric duration_minutes value.
      var unit = targetUnit;
      var isTimeUnit = unit === 'seconds' || unit === 'sec' || unit === 'secs' || unit === 'second' ||
                       unit === 'minutes' || unit === 'min' || unit === 'mins' || unit === 'minute';

      if (isTimeUnit) {
        // Don't filter by main_category — calisthenics/rehab hangs may be
        // categorized differently from session to session. Order by date desc
        // and use a wide limit so older rows don't get clipped off by the
        // default 1000-row PostgREST cap.
        var rmt = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid + "&select=name,duration_minutes,raw_text,notes&order=date.desc&limit=5000", { headers: sbHeaders() });
        var mtrows = await rmt.json();
        var maxSec = 0;
        (mtrows || []).forEach(function(e) {
          if (!mgMatchesExercise(e.name, title)) return;
          // Prefer parsed raw_text/notes — they preserve the user's literal
          // entry ("1:42", "1 min 42 sec") and are immune to the AI extractor
          // occasionally writing the seconds value into duration_minutes.
          var rtSec = parseDurationToSeconds(e.raw_text || '');
          var ntSec = parseDurationToSeconds(e.notes || '');
          var parsed = Math.max(rtSec, ntSec);
          if (parsed > 0) {
            if (parsed > maxSec) maxSec = parsed;
            return;
          }
          // Fallback: trust duration_minutes only when no text-parse succeeded.
          var dm = Number(e.duration_minutes || 0);
          if (dm > 0) {
            var dmSec = dm * 60;
            if (dmSec > maxSec) maxSec = dmSec;
          }
        });
        if (unit === 'minutes' || unit === 'min' || unit === 'mins' || unit === 'minute') {
          return +(maxSec / 60).toFixed(2);
        }
        return Math.round(maxSec);
      }

      // Weight-based path (legacy)
      var rm = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid + "&main_category=eq.strength&select=name,weight_lbs", { headers: sbHeaders() });
      var mrows = await rm.json();
      var max = 0;
      (mrows || []).forEach(function(e) {
        if (!mgMatchesExercise(e.name, title)) return;
        var wt = Number(e.weight_lbs || 0);
        if (wt > max) max = wt;
      });
      return max;
    }

    if (type === 'recovery_balance') {
      var sevenAgo = new Date(now); sevenAgo.setDate(sevenAgo.getDate() - 6);
      var rr = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + pid + "&date=gte." + mgYmdLocal(sevenAgo) + "&done=eq.true&select=date", { headers: sbHeaders() });
      var rrows = await rr.json();
      var trained = new Set((rrows || []).map(function(w) { return w.date; }));
      var rest = 0;
      for (var i = 0; i < 7; i++) {
        var d = new Date(sevenAgo); d.setDate(d.getDate() + i);
        if (!trained.has(mgYmdLocal(d))) rest++;
      }
      return rest;
    }

    // skill_technique → manual only
    return null;
  } catch (e) {
    console.error("[MicroGoal] compute error:", e.message);
    return null;
  }
}

app.get("/api/profiles/:id/micro-goals", async function(req, res) {
  try {
    const pid = req.params.id;
    const includeInactive = req.query.include_inactive === '1';
    const filter = includeInactive ? '' : '&is_active=eq.true';
    const r = await fetch(SUPABASE_URL + "/rest/v1/micro_goals?profile_id=eq." + pid + filter + "&order=created_at.desc", { headers: sbHeaders() });
    const rows = await r.json();
    const goals = Array.isArray(rows) ? rows : [];
    const updates = [];
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i];
      if (!g.is_active) continue;
      const computed = await computeMicroGoalProgress(g, pid);
      if (computed !== null && computed !== undefined && Number(computed) !== Number(g.current_value || 0)) {
        g.current_value = computed;
        updates.push(fetch(SUPABASE_URL + "/rest/v1/micro_goals?id=eq." + g.id, {
          method: "PATCH",
          headers: sbHeaders("return=minimal"),
          body: JSON.stringify({ current_value: computed })
        }));
      }
    }
    if (updates.length) await Promise.all(updates);
    res.json({ success: true, micro_goals: goals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/profiles/:id/micro-goals", async function(req, res) {
  try {
    const pid = req.params.id;
    const body = req.body || {};
    const title = body.title;
    const type = body.type;
    const target_value = body.target_value;
    if (!title || !type || target_value === undefined || target_value === null) {
      return res.status(400).json({ error: "title, type, and target_value are required" });
    }
    const validTypes = ['daily_habit','weekly_frequency','cumulative_volume','strength_milestone','skill_technique','streak','recovery_balance'];
    if (validTypes.indexOf(type) < 0) return res.status(400).json({ error: "invalid type" });
    // daily_habit goals don't have a meaningful numeric target — force a
    // sentinel target_value=1 server-side regardless of what the client sent.
    // This makes the endpoint resilient to stale clients that still POST a
    // user-entered target for daily_habit.
    var resolvedTarget = type === 'daily_habit' ? 1 : Number(target_value);
    var resolvedUnit = type === 'daily_habit' ? null : (body.target_unit ? String(body.target_unit).slice(0, 40).trim() : null);
    const payload = {
      profile_id: pid,
      title: String(title).slice(0, 200).trim(),
      type: type,
      target_value: resolvedTarget,
      target_unit: resolvedUnit,
      period: body.period || 'custom',
      end_date: body.end_date || null,
      current_value: 0,
      is_active: true
    };
    const r = await fetch(SUPABASE_URL + "/rest/v1/micro_goals", {
      method: "POST",
      headers: sbHeaders("return=representation"),
      body: JSON.stringify(payload)
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    const rows = await r.json();
    const saved = Array.isArray(rows) ? rows[0] : rows;
    // Seed initial current_value from auto-tracking
    const computed = await computeMicroGoalProgress(saved, pid);
    if (computed !== null && computed !== undefined && Number(computed) !== 0) {
      saved.current_value = computed;
      await fetch(SUPABASE_URL + "/rest/v1/micro_goals?id=eq." + saved.id, {
        method: "PATCH",
        headers: sbHeaders("return=minimal"),
        body: JSON.stringify({ current_value: computed })
      });
    }
    // New challenge changes what the AI should recommend today — wipe the cache.
    await clearDailyRecsCache(pid);
    res.json({ success: true, micro_goal: saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/micro-goals/:id", async function(req, res) {
  try {
    const gid = req.params.id;
    const allowed = ['title','type','target_value','target_unit','period','end_date','current_value','is_active'];
    const payload = {};
    for (let i = 0; i < allowed.length; i++) {
      const k = allowed[i];
      if (req.body && req.body[k] !== undefined) payload[k] = req.body[k];
    }
    if (!Object.keys(payload).length) return res.status(400).json({ error: "nothing to update" });
    // Belt-and-braces: if the goal is being saved as daily_habit, override
    // target_value to 1 and target_unit to null so a stale client can't leave
    // a stray target on it.
    if (payload.type === 'daily_habit') {
      payload.target_value = 1;
      payload.target_unit = null;
    }
    const r = await fetch(SUPABASE_URL + "/rest/v1/micro_goals?id=eq." + gid, {
      method: "PATCH",
      headers: sbHeaders("return=representation"),
      body: JSON.stringify(payload)
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    const rows = await r.json();
    const updated = Array.isArray(rows) ? rows[0] : rows;
    // Edits (including manual progress/completion) alter AI context — clear cache.
    if (updated && updated.profile_id) await clearDailyRecsCache(updated.profile_id);
    res.json({ success: true, micro_goal: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/micro-goals/:id", async function(req, res) {
  try {
    const gid = req.params.id;
    const hard = req.query.hard === '1';
    // Resolve owner profile first so we can invalidate its cache either way.
    const ownerPid = await getMicroGoalProfileId(gid);
    if (hard) {
      const r = await fetch(SUPABASE_URL + "/rest/v1/micro_goals?id=eq." + gid, {
        method: "DELETE",
        headers: sbHeaders("return=minimal")
      });
      if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
      if (ownerPid) await clearDailyRecsCache(ownerPid);
      return res.json({ success: true, deleted: true });
    }
    const r = await fetch(SUPABASE_URL + "/rest/v1/micro_goals?id=eq." + gid, {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify({ is_active: false })
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    if (ownerPid) await clearDailyRecsCache(ownerPid);
    res.json({ success: true, archived: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DEBUG: Dead Hang matcher visibility (TEMPORARY) ──────────────────────
// Returns exactly what mgMatchesExercise sees for a given profile. Lets us
// confirm whether the auto-tracker is missing rows due to name variants,
// whether the max-duration row is being picked up correctly, and what the
// distinct-date count actually is. Pass ?title=... to test a different goal
// title; defaults to "Dead Hang every day" so the canonical matcher anchors
// on "Dead Hang". Remove this endpoint once the deploy is verified.
app.get("/api/debug/dead-hang/:userId", async function(req, res) {
  try {
    var pid = req.params.userId;
    var title = req.query.title ? String(req.query.title) : "Dead Hang every day";
    var canonical = extractCanonicalFromTitle(title);

    var url = SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid +
      "&select=id,name,date,duration_minutes,raw_text,notes,main_category,subcategory" +
      "&order=date.desc&limit=5000";
    var r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) {
      var errText = await r.text();
      return res.status(500).json({ error: "supabase fetch failed", status: r.status, body: errText });
    }
    var rows = await r.json();
    if (!Array.isArray(rows)) rows = [];

    var matched = [];
    var unmatched = [];
    var distinctDates = new Set();
    var maxSec = 0;
    var maxSource = null;

    rows.forEach(function(e) {
      var isMatch = mgMatchesExercise(e.name, title);
      var normalized = normalizeExerciseName(e.name);
      var rtSec = parseDurationToSeconds(e.raw_text || '');
      var ntSec = parseDurationToSeconds(e.notes || '');
      var dmSec = Number(e.duration_minutes || 0) * 60;
      var bestParsedSec = Math.max(rtSec, ntSec);
      var rowSec = bestParsedSec > 0 ? bestParsedSec : dmSec;

      var record = {
        id: e.id,
        name: e.name,
        normalized: normalized,
        date: e.date,
        duration_minutes: e.duration_minutes,
        raw_text: e.raw_text,
        notes: e.notes,
        main_category: e.main_category,
        subcategory: e.subcategory,
        parsed_seconds: {
          from_raw_text: rtSec,
          from_notes: ntSec,
          from_duration_minutes: dmSec,
          chosen: rowSec
        }
      };

      if (isMatch) {
        matched.push(record);
        if (e.date) distinctDates.add(e.date);
        if (rowSec > maxSec) {
          maxSec = rowSec;
          maxSource = {
            id: e.id,
            name: e.name,
            date: e.date,
            raw_text: e.raw_text,
            notes: e.notes,
            duration_minutes: e.duration_minutes,
            parsed_seconds: rowSec,
            parsed_mmss: Math.floor(rowSec / 60) + ":" + String(Math.round(rowSec % 60)).padStart(2, "0")
          };
        }
      } else if (e.name && /hang/i.test(e.name)) {
        // Surface near-miss rows so we can see if a hang variant is being
        // dropped by the matcher (lets us iterate on the boundary logic).
        unmatched.push(record);
      }
    });

    var distinctDatesArr = Array.from(distinctDates).sort().reverse();

    res.json({
      success: true,
      profile_id: pid,
      title: title,
      canonical_extracted: canonical,
      total_exercise_rows_fetched: rows.length,
      matched_row_count: matched.length,
      distinct_date_count: distinctDatesArr.length,
      distinct_dates: distinctDatesArr,
      max_duration: maxSource ? {
        seconds: maxSec,
        mmss: maxSource.parsed_mmss,
        source: {
          id: maxSource.id,
          exercise_name: maxSource.name,
          date: maxSource.date,
          raw_text: maxSource.raw_text,
          notes: maxSource.notes,
          duration_minutes: maxSource.duration_minutes
        }
      } : null,
      matched_rows: matched,
      near_miss_unmatched_rows_with_hang_in_name: unmatched
    });
  } catch (e) {
    console.error("[debug/dead-hang] error:", e);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

app.listen(PORT, function() {
  console.log("ApexCoach running on port " + PORT);
});
