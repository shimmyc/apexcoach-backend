const express = require("express");
const fetch   = require("node-fetch");
const path    = require("path");
const crypto  = require("crypto");
const wearables = require("./wearables");

const app  = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID      = process.env.FITBIT_CLIENT_ID;
const CLIENT_SECRET  = process.env.FITBIT_CLIENT_SECRET;
const REDIRECT_URI   = "https://apexcoach-backend.onrender.com/callback";
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;

app.use(express.json());
// Serve static assets but disable browser caching for HTML — without this,
// Chrome/Render will hold an old index.html for the heuristic cache window
// (often 10% of last-modified age), which makes deployed UI changes look
// like they never shipped. Hashed JS/CSS aren't in play yet, so the only
// asset we strictly need to bust is .html.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: function(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store, must-revalidate");
    }
  }
}));

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
    // Mirror the rotated pair into wearable_connections so the new
    // provider-agnostic path (getValidWearableToken / sync-backlog / backfill)
    // never reads a refresh token that this profiles-side refresh just rotated
    // out from under it. Symmetric with saveWearableTokens, which mirrors the
    // other direction. Best-effort: a failure here must not break the core
    // profiles token save that the daily sync depends on.
    try {
      await fetch(SUPABASE_URL + "/rest/v1/wearable_connections?on_conflict=profile_id,provider", {
        method: "POST",
        headers: sbHeaders("return=minimal,resolution=merge-duplicates"),
        body: JSON.stringify({
          profile_id: parseInt(profileId, 10),
          provider: "fitbit",
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: tokens.expires_at,
          updated_at: new Date().toISOString(),
        }),
      });
    } catch (e) {
      console.warn("[Fitbit] saveProfileTokens wearable_connections mirror failed: " + e.message);
    }
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
      // Dual-write into wearable_connections so the new provider-agnostic
      // adapters pick this up without forcing a reconnect.
      try { await saveWearableTokens(profileId, "fitbit", tokenData); }
      catch (e) { console.warn("[OAuth] wearable_connections dual-write failed: " + e.message); }
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
var PROFILE_BODY_FIELDS = ["height_inches", "birth_date", "sex", "goal_weight_lbs", "goal_weight_timeline_months", "gym_access", "gym_type"];
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
    // Gym context — passed from the client out of currentProfileBody so the
    // AI scoring branches (distance + general) factor in equipment access.
    // Format: "Yes (Commercial gym)" / "No" / "Sometimes" / "" if unknown.
    var gymAccess = body.gym_access || null;
    var gymType = body.gym_type || null;
    var gymLine = '';
    if (gymAccess) {
      gymLine = 'Gym access: ' + gymAccess;
      if (gymAccess === 'yes' && gymType) gymLine += ' (' + gymType + ')';
    }

    // One stamp shared across all results in this request — the endpoint is
    // already stateless and recomputes live every call, so this just lets
    // the client render "Updated X ago" per card without rolling its own
    // clock against the localStorage ts.
    var computedAt = new Date().toISOString();

    var results = [];
    for (var gi = 0; gi < goals.length; gi++) {
      var g = goals[gi];
      var r = { index: gi, pct: 0, label: '', auto_tracked: false, source: 'manual', reasoning: '', last_computed_at: computedAt };

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
          var aiPrompt = "Athlete goal: " + g.title + " (" + (g.target_value || '?') + " " + (g.unit || 'miles') + ").\nTraining data last 90 days:\n- Longest cardio session: " + longestCardio + " minutes\n- Weekly cardio sessions: " + weeklyCardio + " avg\n- Daily steps avg: " + steps + "\n- Distance logged: " + totalDist + " miles\n- Manual progress reported: " + manualVal + " " + (g.unit || '') + (gymLine ? "\n- " + gymLine : "") + "\nEstimate 0-100% readiness. Return JSON only: {\"readiness_pct\": number, \"reasoning\": \"1 sentence\"}";
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
            var aiP = "Athlete goal: " + g.title + ".\nRecent workouts:\n" + recentLog + (gymLine ? "\n" + gymLine : "") + "\nEstimate 0-100% progress. Be conservative.\nReturn JSON only: {\"estimate_pct\": number, \"reasoning\": \"1 sentence\"}";
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

    var prompt = "STRICT RULE: Only extract exercises that are explicitly named in the raw text. Never infer, assume, or hallucinate exercises or weights that are not clearly stated. If a weight is ambiguous or missing, omit weight_lbs entirely. Do not extract stretches, mobility work, or warm-ups as weighted exercises unless they explicitly include sets, reps, and weight.\n\nExtract all exercises from these workout notes. For each exercise identify: name (normalized), category (one of: strength/combat/cardio/mobility/rehab/core/other), sets (number or null), reps (number or null), weight_lbs (number or null), distance_miles (number or null), duration_minutes (number or null), raw_text (original text snippet).\n\nCATEGORY GUIDE:\n- strength: weightlifting, resistance, dumbbell/barbell work, push-up, pull-up, dip, squat, lunge, row, dead hang (isometric grip/hang holds)\n- combat: MMA, boxing, sparring, martial arts, kicks, grappling, BJJ, pad work\n- cardio: running, elliptical, jumping jacks, cycling, rowing, burpee, jump rope\n- mobility: stretching, yoga, flexibility work\n- rehab: PT exercises, injury rehab, therapeutic (glute bridge, clamshell, cat-cow, hip flexor stretch)\n- core: plank, crunch, sit-up, leg raise, dead bug, bird dog, mountain climber, ab wheel, russian twist, windshield wiper - these are ALWAYS 'core' not 'strength'\n- other: anything else\n\nCRITICAL NORMALIZATION RULES:\n- Always use singular form: 'Glute Bridge' not 'Glute Bridges'\n- Capitalize first letter of each word\n- Use hyphens for compound exercises: 'Push-Up', 'Pull-Up', 'Sit-Up', 'Cat-Cow'\n- Remove trailing s from plural exercise names\n\nMANDATORY DEAD HANG RULE (NON-NEGOTIABLE):\n- ANY mention of \"dead hang\", \"dead hangs\", \"hang\" (when referring to a bar hold, not a noun/verb in unrelated context), \"bar hang\", \"passive hang\", \"hang hold\", or \"hanging\" (as an isometric exercise) MUST produce its own exercise object in the output array — even when it appears alongside many other exercises in the workout notes, even when listed as a single line, even when it has no sets/reps annotation. NEVER skip a dead-hang entry because the surrounding notes are long.\n- name MUST be \"Dead Hang\" (canonical) regardless of how the user phrased it (\"dead hangs\", \"bar hang\", \"hang hold\", etc).\n- category MUST be \"strength\".\n- duration_minutes MUST be populated whenever the raw text contains a duration (any of: \"Ns\", \"N seconds\", \"N sec\", \"N min\", \"M:SS\", \"Xm Ys\", \"X min Y sec\"). Compute it as total_seconds / 60 — examples: \"45 seconds\" → 0.75; \"1:42\" → 1.7; \"1 min 15 sec\" → 1.25; \"30s\" → 0.5; \"1m 42s\" → 1.7. Use the per-set (single-hold) duration, not the sum across sets.\n- sets MUST be populated if the raw text contains set notation (\"3x20s\", \"4x30 seconds\" → sets=3 or 4; per-set duration goes in duration_minutes). For a single hold with no set notation, sets=1.\n- raw_text MUST be the literal hang substring from the user's notes.\n- If the notes contain TWO separate dead hang entries (e.g. \"Dead Hang 0:45\" on one line and \"Dead Hang 0:30\" on another, or \"45s dead hang\" twice), produce TWO exercise objects — do not collapse into one.\n\nDATA INTEGRITY RULES (NON-NEGOTIABLE):\n- NEVER invent or assume weights, reps, sets, distances, or durations that are not explicitly stated in the raw text. The raw text is the only source of truth.\n- If a field is ambiguous, missing, or you are not 100% certain, OMIT it entirely (use null). Better to under-report than to fabricate.\n- Do NOT guess weights based on the exercise name (e.g. don't assume bench press is 135lb just because that's a common starting weight).\n- Do NOT carry over weights from one exercise to another — each exercise's fields must come from its own portion of the raw text.\n- Do NOT infer weight from words like 'heavy' or 'light' — those are not numeric values.\n- The raw_text field MUST be the literal substring from the user's notes that this exercise was extracted from. If the substring doesn't contain the weight, weight_lbs MUST be null.\n\nReturn ONLY a JSON array of exercise objects, no explanation.\nExample: [{\"name\":\"Glute Bridge\",\"category\":\"rehab\",\"sets\":3,\"reps\":12,\"weight_lbs\":null,\"distance_miles\":null,\"duration_minutes\":null,\"raw_text\":\"glute bridges 3x12\"},{\"name\":\"Dead Hang\",\"category\":\"strength\",\"sets\":4,\"reps\":null,\"weight_lbs\":null,\"distance_miles\":null,\"duration_minutes\":0.5,\"raw_text\":\"Dead Hangs 4x30s\"}]\nWorkout type: " + (body.type || "unknown") + "\nNotes: " + body.notes;

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
        grouped[ex.name] = { name: ex.name, category: ex.category, main_category: ex.main_category || ex.category, subcategory: ex.subcategory || 'general', count: 0, last_date: null, best_weight: null, best_reps: null, best_duration_seconds: null, sessions: [] };
      }
      var g = grouped[ex.name];
      g.count++;
      if (!g.last_date || ex.date > g.last_date) g.last_date = ex.date;
      if (ex.weight_lbs && (!g.best_weight || ex.weight_lbs > g.best_weight)) g.best_weight = ex.weight_lbs;
      if (ex.reps && (!g.best_reps || ex.reps > g.best_reps)) g.best_reps = ex.reps;
      // Best single hold in seconds — duration_minutes column first, else parsed
      // from raw_text/notes. Lets duration-based moves (Dead Hang) show a stat.
      var dm = numOrNull(ex.duration_minutes);
      var holdSec = dm != null ? Math.round(dm * 60) : (parseDurationToSeconds(ex.raw_text || '') || parseDurationToSeconds(ex.notes || ''));
      if (holdSec && (!g.best_duration_seconds || holdSec > g.best_duration_seconds)) g.best_duration_seconds = holdSec;
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

    // Gym access line for the prompt — same shape used by goal-progress.
    var gymLine = '';
    if (profile.gym_access) {
      gymLine = 'GYM ACCESS: ' + profile.gym_access;
      if (profile.gym_access === 'yes' && profile.gym_type) gymLine += ' (' + profile.gym_type + ')';
      gymLine += '\n\n';
    }

    const prompt = 'You are a personal fitness coach creating a realistic road map for this athlete based on their current progress and goals.\n\n' +
      'ATHLETE PROFILE:\n' + (pd.ai_prompt_context || pd.name || 'Athlete') + '\n\n' +
      gymLine +
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

// Build the derived date-math block for a daily_habit goal. Returned as a
// `progress` object on the goal so the client can render without doing its
// own date math. Server is authoritative because `created_at` is a UTC
// timestamp; client-side math would drift for users near midnight.
//
// Effective start date = min(created_at::date, earliest matched session
// date). Users routinely create a habit goal AFTER they've been doing the
// activity for a while — anchoring start_date to the literal row creation
// would make days_completed exceed days_elapsed (mathematically nonsense)
// and force the percentage to cap at 100. Using the earlier of the two
// makes "X / Y days" naturally read with completed ≤ elapsed.
//
// Returns: start_date, days_elapsed, total_goal_days, days_completed
// (capped at days_elapsed), days_completed_pct (capped at 100), and
// timeline_pct (days_elapsed / total_goal_days * 100, or null when there
// is no end_date so the client can fall back to completion-% for the bar).
async function buildDailyHabitProgress(g, pid) {
  if (!g || g.type !== 'daily_habit') return null;
  if (!g.created_at) return null;
  var createdDateStr = String(g.created_at).split('T')[0];

  // Look up the earliest exercise row that matches this goal's title. The
  // table is ordered ascending so the first match is the earliest. We only
  // need the very first match — break out of the loop on hit.
  var earliestSessionDate = null;
  try {
    var exR = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid +
      "&select=name,date&order=date.asc&limit=5000", { headers: sbHeaders() });
    var exRows = await exR.json();
    if (Array.isArray(exRows)) {
      for (var i = 0; i < exRows.length; i++) {
        if (exRows[i].date && mgMatchesExercise(exRows[i].name, g.title || '')) {
          earliestSessionDate = exRows[i].date;
          break;
        }
      }
    }
  } catch (e) {
    // best-effort lookup — fall back to created_at on failure
  }

  var startDateStr = createdDateStr;
  if (earliestSessionDate && earliestSessionDate < createdDateStr) {
    startDateStr = earliestSessionDate;
  }

  var startDate = new Date(startDateStr + 'T00:00:00Z');
  var today = new Date();
  var todayStr = mgYmdLocal(today);
  var todayDate = new Date(todayStr + 'T00:00:00Z');
  var msPerDay = 86400000;
  // Inclusive day count — day 1 is the start date itself.
  var rawElapsed = Math.floor((todayDate - startDate) / msPerDay) + 1;
  if (rawElapsed < 1) rawElapsed = 1;
  var totalGoalDays = null;
  if (g.end_date) {
    var endDate = new Date(String(g.end_date).split('T')[0] + 'T00:00:00Z');
    var span = Math.floor((endDate - startDate) / msPerDay) + 1;
    if (span >= 1) totalGoalDays = span;
  }
  var daysElapsed = (totalGoalDays != null) ? Math.min(rawElapsed, totalGoalDays) : rawElapsed;
  var daysCompletedRaw = Number(g.current_value || 0);
  // Cap completed at elapsed. With the earliest-session anchor above this
  // should rarely trigger, but it guards the display against any future
  // edge case where the matcher returns a count > elapsed.
  var daysCompleted = Math.min(daysCompletedRaw, daysElapsed);
  var pct = daysElapsed > 0 ? Math.round((daysCompleted / daysElapsed) * 100) : 0;
  if (pct > 100) pct = 100;
  if (pct < 0) pct = 0;
  var timelinePct = null;
  if (totalGoalDays != null && totalGoalDays > 0) {
    timelinePct = Math.round((daysElapsed / totalGoalDays) * 100);
    if (timelinePct > 100) timelinePct = 100;
    if (timelinePct < 0) timelinePct = 0;
  }
  return {
    start_date: startDateStr,
    days_elapsed: daysElapsed,
    total_goal_days: totalGoalDays,
    days_completed: daysCompleted,
    days_completed_pct: pct,
    timeline_pct: timelinePct
  };
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
    // Single stamp for this GET so all cards share the same "computed at"
    // moment — lets the client render a consistent "Updated just now" line.
    const computedAt = new Date().toISOString();
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
      // Attach derived date-math for daily_habit cards. Server-computed so
      // the client doesn't have to reason about created_at UTC drift.
      if (g.type === 'daily_habit') {
        g.progress = await buildDailyHabitProgress(g, pid);
      }
      // Mark each active goal with the moment its current_value was
      // (re)computed on this request. Set unconditionally — we ran the
      // compute either way, even when the result equaled the stored value.
      g.last_computed_at = computedAt;
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

// ── DEBUG: rows on specific suspected-missing dates (TEMPORARY) ──────────
// For each hardcoded date, returns every exercises row + the parent workout
// notes/type, so we can see exactly what exercise names the AI extractor
// stored on the days the daily_habit counter is missing. Once we see the
// names, we know what variants mgMatchesExercise needs to admit.
app.get("/api/debug/missing-dates/:userId", async function(req, res) {
  try {
    var pid = req.params.userId;
    var dates = [
      '2026-04-12','2026-04-13','2026-04-17','2026-04-20','2026-04-22',
      '2026-04-23','2026-04-25','2026-04-26','2026-04-27','2026-05-01',
      '2026-05-04','2026-05-10','2026-05-12','2026-05-13','2026-05-14',
      '2026-05-15','2026-05-16','2026-05-17'
    ];
    var dateFilter = "date=in.(" + dates.join(",") + ")";

    var exUrl = SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid + "&" + dateFilter +
      "&select=id,workout_id,date,name,raw_text,notes,duration_minutes,sets,reps,main_category,subcategory" +
      "&order=date.asc&limit=5000";
    var wkUrl = SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + pid + "&" + dateFilter +
      "&select=id,date,type,notes,done&order=date.asc&limit=5000";

    var exR = await fetch(exUrl, { headers: sbHeaders() });
    var wkR = await fetch(wkUrl, { headers: sbHeaders() });
    if (!exR.ok) {
      var et = await exR.text();
      return res.status(500).json({ error: "exercises fetch failed", status: exR.status, body: et });
    }
    if (!wkR.ok) {
      var wt = await wkR.text();
      return res.status(500).json({ error: "workouts fetch failed", status: wkR.status, body: wt });
    }
    var exRows = await exR.json();
    var wkRows = await wkR.json();
    if (!Array.isArray(exRows)) exRows = [];
    if (!Array.isArray(wkRows)) wkRows = [];

    // Group both by date
    var byDate = {};
    dates.forEach(function(d) {
      byDate[d] = { date: d, workouts: [], exercises: [], hang_mentioned_in_workout_notes: false };
    });
    wkRows.forEach(function(w) {
      if (!byDate[w.date]) byDate[w.date] = { date: w.date, workouts: [], exercises: [], hang_mentioned_in_workout_notes: false };
      byDate[w.date].workouts.push({
        id: w.id,
        type: w.type,
        done: w.done,
        notes: w.notes
      });
      if (w.notes && /hang/i.test(w.notes)) {
        byDate[w.date].hang_mentioned_in_workout_notes = true;
      }
    });
    exRows.forEach(function(e) {
      if (!byDate[e.date]) byDate[e.date] = { date: e.date, workouts: [], exercises: [], hang_mentioned_in_workout_notes: false };
      byDate[e.date].exercises.push({
        id: e.id,
        workout_id: e.workout_id,
        exercise_name: e.name,
        raw_text: e.raw_text,
        notes: e.notes,
        duration_minutes: e.duration_minutes,
        sets: e.sets,
        reps: e.reps,
        main_category: e.main_category,
        subcategory: e.subcategory
      });
    });

    // Summary signals — which dates have zero exercises, which have a hang
    // mention in workout notes but no matching exercise row, etc.
    var datesWithNoExercises = [];
    var datesWithHangInNotesButNoHangExercise = [];
    dates.forEach(function(d) {
      var b = byDate[d];
      if (!b.exercises.length) datesWithNoExercises.push(d);
      var anyHangExercise = b.exercises.some(function(ex) { return ex.exercise_name && /hang/i.test(ex.exercise_name); });
      if (b.hang_mentioned_in_workout_notes && !anyHangExercise) {
        datesWithHangInNotesButNoHangExercise.push(d);
      }
    });

    res.json({
      success: true,
      profile_id: pid,
      dates_queried: dates,
      total_exercises_rows: exRows.length,
      total_workouts_rows: wkRows.length,
      summary: {
        dates_with_no_exercises: datesWithNoExercises,
        dates_with_hang_in_workout_notes_but_no_hang_exercise_row: datesWithHangInNotesButNoHangExercise
      },
      by_date: dates.map(function(d) { return byDate[d]; })
    });
  } catch (e) {
    console.error("[debug/missing-dates] error:", e);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ── DEBUG: one-shot Dead Hang backfill (TEMPORARY) ───────────────────────
// Inserts the missing Dead Hang exercise rows from the manual audit. Each
// row is keyed by workout_id; the workout's date is read live from the
// workouts table so we don't have to encode it here. Idempotent: if a
// Dead Hang exercise row already exists for a given workout_id, the entry
// is skipped (workouts 26 and 47 each have multiple Dead Hangs, but the
// idempotency check is on "any Dead Hang row for this workout" — so a
// re-run is a no-op once a workout has been backfilled). Gated behind
// POST so an accidental browser GET can't trigger it. Remove once the
// data is correct.
app.post("/api/debug/dead-hang-backfill/:userId", async function(req, res) {
  try {
    var pid = parseInt(req.params.userId, 10);
    if (!pid || isNaN(pid)) return res.status(400).json({ error: "userId must be numeric" });

    // Per-workout backfill spec. duration_minutes is per-hold (single-set).
    // sets reflects the set count from the raw text when stated.
    var spec = [
      { workout_id: 10, rows: [{ sets: 3, duration_minutes: 17 / 60, raw_text: "Dead hangs - 3 x 15-20 seconds" }] },
      { workout_id: 13, rows: [{ sets: 3, duration_minutes: 20 / 60, raw_text: "Dead hangs - 3x20 seconds" }] },
      { workout_id: 22, rows: [{ sets: 4, duration_minutes: 30 / 60, raw_text: "Dead hangs - 4x30 seconds" }] },
      { workout_id: 26, rows: [
        { sets: 1, duration_minutes: 45 / 60, raw_text: "45 second dead hang" },
        { sets: 1, duration_minutes: 45 / 60, raw_text: "45 second dead hang" }
      ]},
      { workout_id: 28, rows: [{ sets: 4, duration_minutes: 30 / 60, raw_text: "Dead Hang 4x30 seconds" }] },
      { workout_id: 29, rows: [{ sets: 1, duration_minutes: 45 / 60, raw_text: "Dead Hang – 45 seconds" }] },
      { workout_id: 31, rows: [{ sets: 4, duration_minutes: 30 / 60, raw_text: "Dead Hangs 4x30s" }] },
      { workout_id: 32, rows: [{ sets: 1, duration_minutes: 45 / 60, raw_text: "Dead Hangs - 45s" }] },
      { workout_id: 34, rows: [{ sets: 1, duration_minutes: 30 / 60, raw_text: "Dead Hang - 30 seconds" }] },
      { workout_id: 39, rows: [{ sets: 1, duration_minutes: 52 / 60, raw_text: "Hang Hold - 52 seconds" }] },
      { workout_id: 42, rows: [{ sets: 1, duration_minutes: 45 / 60, raw_text: "Dead Hang - 45s" }] },
      { workout_id: 47, rows: [
        { sets: 1, duration_minutes: 45 / 60, raw_text: "Dead Hang 0:45" },
        { sets: 1, duration_minutes: 30 / 60, raw_text: "Dead Hang 0:30" }
      ]},
      { workout_id: 49, rows: [{ sets: 1, duration_minutes: 45 / 60, raw_text: "Dead Hang 45 seconds" }] },
      { workout_id: 50, rows: [{ sets: 1, duration_minutes: 65 / 60, raw_text: "Dead hang - 65 seconds" }] },
      { workout_id: 51, rows: [{ sets: 1, duration_minutes: 75 / 60, raw_text: "Dead Hang - 1 min 15 sec" }] },
      { workout_id: 52, rows: [{ sets: 1, duration_minutes: 102 / 60, raw_text: "Dead Hang 1m 42s" }] },
      { workout_id: 54, rows: [{ sets: 1, duration_minutes: 45 / 60, raw_text: "Dead Hang: 45 seconds" }] },
      { workout_id: 55, rows: [{ sets: 1, duration_minutes: 45 / 60, raw_text: "Dead Hang 45 seconds" }] }
    ];

    var ids = spec.map(function(s) { return s.workout_id; });

    // Single round-trip lookup for the parent workouts (date + ownership).
    var wkUrl = SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + pid +
      "&id=in.(" + ids.join(",") + ")&select=id,date,profile_id";
    var wkR = await fetch(wkUrl, { headers: sbHeaders() });
    if (!wkR.ok) {
      var wkErrText = await wkR.text();
      return res.status(500).json({ error: "workouts fetch failed", status: wkR.status, body: wkErrText });
    }
    var workouts = await wkR.json();
    if (!Array.isArray(workouts)) workouts = [];
    var workoutsById = {};
    workouts.forEach(function(w) { workoutsById[w.id] = w; });

    // Single round-trip for existing Dead Hang rows on those workouts —
    // anything name ILIKE %hang% counts as "already backfilled" for that
    // workout so we don't risk double-inserting on a second run.
    var exUrl = SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid +
      "&workout_id=in.(" + ids.join(",") + ")&name=ilike.*hang*&select=id,workout_id,name";
    var exR = await fetch(exUrl, { headers: sbHeaders() });
    if (!exR.ok) {
      var exErrText = await exR.text();
      return res.status(500).json({ error: "exercises fetch failed", status: exR.status, body: exErrText });
    }
    var existingRows = await exR.json();
    if (!Array.isArray(existingRows)) existingRows = [];
    var existingByWorkout = {};
    existingRows.forEach(function(e) {
      if (!existingByWorkout[e.workout_id]) existingByWorkout[e.workout_id] = [];
      existingByWorkout[e.workout_id].push(e);
    });

    var inserted = [];
    var skipped = [];
    var errors = [];

    for (var i = 0; i < spec.length; i++) {
      var entry = spec[i];
      var wk = workoutsById[entry.workout_id];
      if (!wk) {
        skipped.push({ workout_id: entry.workout_id, reason: "workout not found for this profile" });
        continue;
      }
      if (existingByWorkout[entry.workout_id] && existingByWorkout[entry.workout_id].length) {
        skipped.push({
          workout_id: entry.workout_id,
          reason: "already has hang-like exercise row(s)",
          existing: existingByWorkout[entry.workout_id]
        });
        continue;
      }

      for (var j = 0; j < entry.rows.length; j++) {
        var rowSpec = entry.rows[j];
        // exercises.duration_minutes is an integer column — fractional minutes
        // (e.g. 0.75 for a 45-second hold) are rejected by Postgres. The PR
        // scanner already prefers parseDurationToSeconds(raw_text) over the
        // duration_minutes column, so we store null here and let the literal
        // raw_text ("Dead Hang 1m 42s", "Dead Hang 0:45", etc.) carry the
        // exact duration without truncation.
        var insertBody = {
          profile_id: pid,
          workout_id: entry.workout_id,
          date: wk.date,
          name: "Dead Hang",
          category: "strength",
          main_category: "strength",
          subcategory: "calisthenics",
          sets: rowSpec.sets,
          reps: null,
          weight_lbs: null,
          distance_miles: null,
          duration_minutes: null,
          notes: null,
          raw_text: rowSpec.raw_text
        };
        var insRes = await fetch(SUPABASE_URL + "/rest/v1/exercises", {
          method: "POST",
          headers: sbHeaders("return=representation"),
          body: JSON.stringify(insertBody)
        });
        if (insRes.ok) {
          var insBody = await insRes.json();
          inserted.push({
            workout_id: entry.workout_id,
            date: wk.date,
            duration_minutes: insertBody.duration_minutes,
            raw_text: insertBody.raw_text,
            inserted_id: Array.isArray(insBody) && insBody[0] ? insBody[0].id : null
          });
        } else {
          var insErr = await insRes.text();
          errors.push({
            workout_id: entry.workout_id,
            raw_text: rowSpec.raw_text,
            status: insRes.status,
            body: insErr
          });
        }
      }
    }

    res.json({
      success: true,
      profile_id: pid,
      planned_workouts: ids.length,
      inserted_count: inserted.length,
      skipped_count: skipped.length,
      error_count: errors.length,
      inserted: inserted,
      skipped: skipped,
      errors: errors
    });
  } catch (e) {
    console.error("[debug/dead-hang-backfill] error:", e);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// WEARABLES — provider-agnostic activity sync + workout matching
// ──────────────────────────────────────────────────────────────────────────
// All endpoints route through wearables.getProviderAdapter(provider). The
// adapter contract is documented in wearables/base.js. Adding a new
// provider requires zero changes here — only a new file in wearables/.

// All wearables endpoints return live state and must never be served
// from cache. Two things together prevent 304-with-empty-body:
//   1. no-store / no-cache response headers so the browser doesn't
//      retain anything for future revalidation.
//   2. stripping If-None-Match / If-Modified-Since on the way in —
//      Express's default req.fresh check would otherwise short-circuit
//      to 304 when a browser sends a stale ETag from a previous deploy.
app.use("/api/wearables", function(req, res, next) {
  delete req.headers["if-none-match"];
  delete req.headers["if-modified-since"];
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// ── token helpers (wearable_connections, with legacy fallback for Fitbit) ──
async function loadWearableTokens(profileId, provider) {
  try {
    var r = await fetch(
      SUPABASE_URL + "/rest/v1/wearable_connections?profile_id=eq." + profileId
        + "&provider=eq." + provider
        + "&select=access_token,refresh_token,token_expires_at,last_synced_at",
      { headers: sbHeaders() }
    );
    var rows = await r.json();
    if (rows && rows.length) {
      return {
        access_token: rows[0].access_token || "",
        refresh_token: rows[0].refresh_token || "",
        expires_at: rows[0].token_expires_at || 0,
        last_synced_at: rows[0].last_synced_at || null,
      };
    }
  } catch (e) {
    console.warn("[Wearables] loadWearableTokens(" + provider + ") read failed: " + e.message);
  }
  // Fall back to legacy profiles.fitbit_* so users connected before the
  // migration backfill ran still work. (The migration SQL covers this for
  // existing rows, but the fallback is cheap insurance.)
  if (provider === "fitbit") {
    try {
      var pr = await fetch(
        SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId
          + "&select=fitbit_access_token,fitbit_refresh_token,fitbit_expires_at",
        { headers: sbHeaders() }
      );
      var pRows = await pr.json();
      if (pRows && pRows.length && pRows[0].fitbit_access_token) {
        return {
          access_token: pRows[0].fitbit_access_token,
          refresh_token: pRows[0].fitbit_refresh_token || "",
          expires_at: pRows[0].fitbit_expires_at || 0,
          last_synced_at: null,
        };
      }
    } catch (e) {
      console.warn("[Wearables] legacy fitbit fallback failed: " + e.message);
    }
  }
  return { access_token: "", refresh_token: "", expires_at: 0, last_synced_at: null };
}

async function saveWearableTokens(profileId, provider, tokens) {
  var payload = {
    profile_id: parseInt(profileId, 10),
    provider: provider,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: tokens.expires_at,
    updated_at: new Date().toISOString(),
  };
  await fetch(SUPABASE_URL + "/rest/v1/wearable_connections?on_conflict=profile_id,provider", {
    method: "POST",
    headers: sbHeaders("return=minimal,resolution=merge-duplicates"),
    body: JSON.stringify(payload),
  });
  // Mirror Fitbit tokens to profiles.fitbit_* so the legacy buildDailyData
  // / runFitbitBackfill paths keep working without changes.
  if (provider === "fitbit") {
    try {
      await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId, {
        method: "PATCH",
        headers: sbHeaders("return=minimal"),
        body: JSON.stringify({
          fitbit_access_token: tokens.access_token,
          fitbit_refresh_token: tokens.refresh_token,
          fitbit_expires_at: tokens.expires_at,
        }),
      });
    } catch (e) {
      console.warn("[Wearables] legacy fitbit mirror failed: " + e.message);
    }
  }
}

async function stampLastSynced(profileId, provider) {
  try {
    await fetch(
      SUPABASE_URL + "/rest/v1/wearable_connections?profile_id=eq." + profileId
        + "&provider=eq." + provider,
      {
        method: "PATCH",
        headers: sbHeaders("return=minimal"),
        body: JSON.stringify({ last_synced_at: new Date().toISOString() }),
      }
    );
  } catch (e) { /* non-fatal */ }
}

// Auto-refreshes if the stored token is expired. Throws an error with
// code RECONNECT_REQUIRED if refresh fails — the endpoint handler maps
// that to a 401 so the UI can show "reconnect your <provider>" instead
// of a generic 500.
async function getValidWearableToken(profileId, provider) {
  // Fitbit: the live, continually-rotated token lives in profiles.fitbit_*.
  // The daily sync (getValidProfileToken → refreshProfileToken) refreshes it
  // there every day, and Fitbit ROTATES the refresh_token on each refresh,
  // invalidating the previous one. saveProfileTokens writes that rotation back
  // ONLY to profiles.fitbit_*, never to wearable_connections — so the copy
  // cached in wearable_connections goes stale and any refresh attempt off it
  // fails with a 400 (invalid_grant) → RECONNECT_REQUIRED, even while the daily
  // sync keeps working. Use the same source as the daily sync; fall back to
  // wearable_connections only when profiles.fitbit_* has never been populated
  // (e.g. a user connected purely via the newer wearable flow).
  if (provider === "fitbit") {
    var legacy = await loadProfileTokens(profileId);
    if (legacy.access_token || legacy.refresh_token) {
      return await getValidProfileToken(profileId);
    }
  }

  var tokens = await loadWearableTokens(profileId, provider);
  if (tokens.access_token && Date.now() < Number(tokens.expires_at)) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) {
    var e1 = new Error("No " + provider + " connection — user must connect first");
    e1.code = "RECONNECT_REQUIRED";
    throw e1;
  }
  var adapter = wearables.getProviderAdapter(provider);
  var fresh;
  try {
    fresh = await adapter.refreshToken(tokens.refresh_token);
  } catch (refreshErr) {
    refreshErr.code = refreshErr.code || "RECONNECT_REQUIRED";
    throw refreshErr;
  }
  await saveWearableTokens(profileId, provider, fresh);
  return fresh.access_token;
}

// Maps RECONNECT_REQUIRED errors → 401 with a structured payload the UI
// can branch on; everything else → 500.
function sendWearableError(res, err, provider) {
  var msg = err && err.message ? err.message : "Unknown error";
  if (err && err.code === "RECONNECT_REQUIRED") {
    return res.status(401).json({
      success: false,
      error: msg,
      code: "RECONNECT_REQUIRED",
      provider: provider || null,
    });
  }
  if (err && /not implemented/i.test(msg)) {
    return res.status(501).json({ success: false, error: msg, provider: provider || null });
  }
  console.error("[Wearables] error:", msg);
  return res.status(500).json({ success: false, error: msg, provider: provider || null });
}

// ── endpoints ─────────────────────────────────────────────────────────────

// GET /api/wearables/providers/:userId
// → { providers: [{ provider, label, connected, last_synced_at }] }
app.get("/api/wearables/providers/:userId", async function(req, res) {
  try {
    var pid = req.params.userId;
    var connRes = await fetch(
      SUPABASE_URL + "/rest/v1/wearable_connections?profile_id=eq." + pid
        + "&select=provider,last_synced_at,token_expires_at",
      { headers: sbHeaders() }
    );
    var conns = await connRes.json();
    var byProvider = {};
    (Array.isArray(conns) ? conns : []).forEach(function(c) { byProvider[c.provider] = c; });

    var all = wearables.listProviders();
    var out = all.map(function(p) {
      var c = byProvider[p.provider];
      return {
        provider: p.provider,
        label: p.label,
        connected: !!c,
        last_synced_at: c ? c.last_synced_at : null,
      };
    });
    res.json({ success: true, providers: out });
  } catch (e) {
    sendWearableError(res, e);
  }
});

// POST /api/wearables/connect/:provider
// body: { profile_id }
// → { auth_url } that the client should open to complete OAuth. The
// provider's callback writes tokens (Fitbit reuses the existing /callback
// which dual-writes to wearable_connections — see OAuth callback above).
app.post("/api/wearables/connect/:provider", async function(req, res) {
  var provider = req.params.provider;
  try {
    var profileId = (req.body && req.body.profile_id) || null;
    if (!profileId) return res.status(400).json({ success: false, error: "profile_id required" });
    var adapter = wearables.getProviderAdapter(provider);
    var redirectUri = (req.headers["x-forwarded-proto"] || "https") + "://"
      + req.headers.host + (provider === "fitbit" ? "/callback" : "/api/wearables/callback/" + provider);
    var url = adapter.buildAuthUrl(redirectUri, String(profileId));
    res.json({ success: true, auth_url: url, provider: provider });
  } catch (e) {
    sendWearableError(res, e, provider);
  }
});

// POST /api/wearables/disconnect/:provider
// body: { profile_id }
app.post("/api/wearables/disconnect/:provider", async function(req, res) {
  var provider = req.params.provider;
  try {
    var profileId = (req.body && req.body.profile_id) || null;
    if (!profileId) return res.status(400).json({ success: false, error: "profile_id required" });
    await fetch(
      SUPABASE_URL + "/rest/v1/wearable_connections?profile_id=eq." + profileId
        + "&provider=eq." + provider,
      { method: "DELETE", headers: sbHeaders("return=minimal") }
    );
    // For Fitbit, also clear the legacy mirror columns so the user is
    // fully disconnected from both code paths.
    if (provider === "fitbit") {
      await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId, {
        method: "PATCH",
        headers: sbHeaders("return=minimal"),
        body: JSON.stringify({
          fitbit_access_token: null,
          fitbit_refresh_token: null,
          fitbit_expires_at: null,
        }),
      });
    }
    res.json({ success: true, provider: provider });
  } catch (e) {
    sendWearableError(res, e, provider);
  }
});

// Parse the optional ?activity_types= filter. Accepts either a JSON-
// encoded array or a comma-separated string. Returns null when the
// param is absent / empty so callers can short-circuit the filter.
function parseActivityTypesParam(raw) {
  if (raw == null || raw === "") return null;
  try {
    var parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(function(s) { return String(s).toLowerCase().trim(); }).filter(Boolean);
    }
  } catch (e) { /* not JSON, fall through to CSV */ }
  return String(raw).split(",").map(function(s) { return s.toLowerCase().trim(); }).filter(Boolean);
}

// Shared backlog computation — used by /sync-backlog (which serves it
// as JSON) and /bulk-action (which acts on the result). The activity_
// _types filter is case-insensitive. Returns { matched, unmatched,
// already_synced, activity_types } where matched is sorted by score desc.
async function computeWearableBacklog(profileId, provider, startDate, endDate, activityTypesFilter) {
  var adapter = wearables.getProviderAdapter(provider);
  var token = await getValidWearableToken(profileId, provider);
  var activities = await adapter.fetchActivities(token, startDate, endDate);
  await stampLastSynced(profileId, provider);

  // Distinct activity types BEFORE filtering — the UI needs the full
  // list so users can re-enable a type they previously hid.
  var distinctTypes = {};
  for (var ai = 0; ai < activities.length; ai++) {
    var t = activities[ai] && activities[ai].activity_type;
    if (t) distinctTypes[t] = true;
  }

  if (activityTypesFilter && activityTypesFilter.length) {
    activities = activities.filter(function(a) {
      return activityTypesFilter.indexOf(String(a.activity_type || "").toLowerCase()) >= 0;
    });
  }

  var wRes = await fetch(
    SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + profileId
      + "&date=gte." + startDate + "&date=lte." + endDate
      + "&select=id,date,type,notes,wearable_activity_id",
    { headers: sbHeaders() }
  );
  var workouts = await wRes.json();
  if (!Array.isArray(workouts)) workouts = [];

  var alreadySyncedIds = {};
  workouts.forEach(function(w) {
    if (w.wearable_activity_id) alreadySyncedIds[w.wearable_activity_id] = true;
  });

  var rRes = await fetch(
    SUPABASE_URL + "/rest/v1/rejected_wearable_matches?profile_id=eq." + profileId
      + "&select=workout_id,wearable_activity_id",
    { headers: sbHeaders() }
  );
  var rejected = await rRes.json();
  if (!Array.isArray(rejected)) rejected = [];
  var rejectedSet = {};
  rejected.forEach(function(r) { rejectedSet[r.wearable_activity_id + "|" + r.workout_id] = true; });

  var manualPool = workouts.filter(function(w) { return !w.wearable_activity_id; });

  var matched = [];
  var unmatched = [];
  var alreadySynced = [];

  for (var i = 0; i < activities.length; i++) {
    var act = activities[i];
    var nsId = wearables.namespacedId(provider, act.provider_activity_id);
    if (alreadySyncedIds[nsId]) {
      alreadySynced.push({ activity: act, wearable_activity_id: nsId });
      continue;
    }
    var sameDate = manualPool.filter(function(w) { return w.date === act.date; });
    var best = wearables.matchWearableToManual(act, sameDate);
    if (best && !rejectedSet[nsId + "|" + best.manual_workout.id]) {
      matched.push({
        activity: act,
        wearable_activity_id: nsId,
        workout: best.manual_workout,
        score: best.score,
      });
    } else {
      unmatched.push({ activity: act, wearable_activity_id: nsId });
    }
  }

  matched.sort(function(a, b) { return (b.score || 0) - (a.score || 0); });

  return {
    matched: matched,
    unmatched: unmatched,
    already_synced: alreadySynced,
    activity_types: Object.keys(distinctTypes).sort(),
  };
}

// GET /api/wearables/sync-backlog/:userId
//   ?provider=fitbit&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&activity_types=...
// Idempotent — running it twice returns the same shape; nothing is written.
app.get("/api/wearables/sync-backlog/:userId", async function(req, res) {
  var provider = req.query.provider;
  try {
    var startDate = req.query.start_date;
    var endDate = req.query.end_date;
    if (!provider || !startDate || !endDate) {
      return res.status(400).json({ success: false, error: "provider, start_date, end_date required" });
    }
    var filter = parseActivityTypesParam(req.query.activity_types);
    var result = await computeWearableBacklog(req.params.userId, provider, startDate, endDate, filter);
    res.json(Object.assign({ success: true, provider: provider }, result));
  } catch (e) {
    sendWearableError(res, e, provider);
  }
});

// GET /api/wearables/activity-types/:userId?provider=&start_date=&end_date=
// Returns the distinct activity_type values surfaced by the provider in
// the given window. Drives the modal's activity-type checkbox list so
// users can pre-filter before running a full sync.
app.get("/api/wearables/activity-types/:userId", async function(req, res) {
  var provider = req.query.provider;
  try {
    var startDate = req.query.start_date;
    var endDate = req.query.end_date;
    if (!provider || !startDate || !endDate) {
      return res.status(400).json({ success: false, error: "provider, start_date, end_date required" });
    }
    var adapter = wearables.getProviderAdapter(provider);
    var token = await getValidWearableToken(req.params.userId, provider);
    var activities = await adapter.fetchActivities(token, startDate, endDate);
    var seen = {};
    for (var i = 0; i < activities.length; i++) {
      var t = activities[i] && activities[i].activity_type;
      if (t) seen[t] = true;
    }
    res.json({ success: true, provider: provider, activity_types: Object.keys(seen).sort() });
  } catch (e) {
    sendWearableError(res, e, provider);
  }
});

// Strip a "provider:" prefix from a namespaced id and return both forms.
function splitNamespacedId(provider, id) {
  var s = String(id || "");
  var bare = s.indexOf(provider + ":") === 0 ? s.slice(provider.length + 1) : s;
  return { bare: bare, ns: wearables.namespacedId(provider, bare) };
}

// ── action helpers (shared by single + bulk endpoints) ────────────────

// The /activities/{id}.json detail endpoint drops HR fields that the list
// endpoint (fetchActivities) carries. When a list activity is available at
// merge/import time, fill the detail's MISSING HR fields from it (detail wins
// for anything it already has). listActivity may be an already-normalized
// activity (from the sync-backlog response) or a raw provider list entry.
function mergeListHr(adapter, detail, listActivity) {
  if (!detail || !listActivity || typeof listActivity !== "object") return detail;
  var ln = ("avg_hr" in listActivity || "peak_hr" in listActivity)
    ? listActivity
    : (typeof adapter.normalize === "function" ? adapter.normalize(listActivity) : null);
  if (!ln) return detail;
  ["avg_hr", "peak_hr", "calories", "active_zone_minutes"].forEach(function(f) {
    if (detail[f] == null && ln[f] != null) detail[f] = ln[f];
  });
  if (detail.zones == null && ln.zones != null) detail.zones = ln.zones;
  return detail;
}

async function performMerge(profileId, workoutId, provider, namespacedActivityId, listActivity) {
  var ids = splitNamespacedId(provider, namespacedActivityId);
  var adapter = wearables.getProviderAdapter(provider);
  var token = await getValidWearableToken(profileId, provider);
  var detail = await adapter.fetchActivityDetail(token, ids.bare);
  if (!detail) throw new Error("Activity not found on provider");
  mergeListHr(adapter, detail, listActivity);
  var patchRes = await fetch(SUPABASE_URL + "/rest/v1/workouts?id=eq." + workoutId, {
    method: "PATCH",
    headers: sbHeaders("return=representation"),
    body: JSON.stringify({ wearable_data: detail, wearable_activity_id: ids.ns }),
  });
  var rows = await patchRes.json();
  clearProgressBriefCache(profileId);
  return { workout: Array.isArray(rows) ? rows[0] : rows, wearable_activity_id: ids.ns };
}

async function performReject(profileId, workoutId, provider, namespacedActivityId, listActivity) {
  var ids = splitNamespacedId(provider, namespacedActivityId);
  await fetch(SUPABASE_URL + "/rest/v1/rejected_wearable_matches", {
    method: "POST",
    headers: sbHeaders("return=minimal,resolution=merge-duplicates"),
    body: JSON.stringify({
      profile_id: parseInt(profileId, 10),
      workout_id: parseInt(workoutId, 10),
      provider: provider,
      wearable_activity_id: ids.ns,
    }),
  });
  // Reject still creates a standalone — the user said "these are
  // separate sessions", not "throw away the wearable data".
  var created = await createWearableWorkout(profileId, provider, ids.ns, listActivity);
  return { workout: created, wearable_activity_id: ids.ns };
}

async function performImport(profileId, provider, namespacedActivityId, listActivity) {
  var ids = splitNamespacedId(provider, namespacedActivityId);
  var created = await createWearableWorkout(profileId, provider, ids.ns, listActivity);
  return { workout: created, wearable_activity_id: ids.ns };
}

// POST /api/wearables/merge/:userId
// body: { workout_id, provider, wearable_activity_id }
app.post("/api/wearables/merge/:userId", async function(req, res) {
  var b = req.body || {};
  var provider = b.provider;
  try {
    if (!b.workout_id || !provider || !b.wearable_activity_id) {
      return res.status(400).json({ success: false, error: "workout_id, provider, wearable_activity_id required" });
    }
    var out = await performMerge(req.params.userId, b.workout_id, provider, b.wearable_activity_id, b.list_activity);
    res.json(Object.assign({ success: true }, out));
  } catch (e) {
    sendWearableError(res, e, provider);
  }
});

// POST /api/wearables/reject/:userId
// body: { workout_id, provider, wearable_activity_id }
app.post("/api/wearables/reject/:userId", async function(req, res) {
  var b = req.body || {};
  var provider = b.provider;
  try {
    if (!b.workout_id || !provider || !b.wearable_activity_id) {
      return res.status(400).json({ success: false, error: "workout_id, provider, wearable_activity_id required" });
    }
    var out = await performReject(req.params.userId, b.workout_id, provider, b.wearable_activity_id, b.list_activity);
    res.json(Object.assign({ success: true }, out));
  } catch (e) {
    sendWearableError(res, e, provider);
  }
});

// POST /api/wearables/import/:userId
// body: { provider, wearable_activity_id }
app.post("/api/wearables/import/:userId", async function(req, res) {
  var b = req.body || {};
  var provider = b.provider;
  try {
    if (!provider || !b.wearable_activity_id) {
      return res.status(400).json({ success: false, error: "provider, wearable_activity_id required" });
    }
    var out = await performImport(req.params.userId, provider, b.wearable_activity_id, b.list_activity);
    res.json(Object.assign({ success: true }, out));
  } catch (e) {
    sendWearableError(res, e, provider);
  }
});

// POST /api/debug/backfill-wearable-hr/:userId?provider=fitbit[&secret=ADMIN_SECRET][&max_intraday=N]
// One-time HR repair for already-synced workouts, in two passes:
//   Pass 1 (avg_hr): for rows whose wearable_data.avg_hr is null, re-reads HR
//     from the LIST endpoint (which carries averageHeartRate, unlike the detail
//     endpoint that originally populated these rows) and fills the missing
//     avg_hr / calories / active_zone_minutes / zones.
//   Pass 2 (peak_hr): for rows still missing peak_hr, derives it from intraday
//     HR — reusing heart_rate_samples already stored when present (no API call),
//     otherwise fetching the activity's intraday HR window from the provider and
//     taking the max bpm (also stores heart_rate_samples, capped at 600). The
//     LIST endpoint never carries maxHeartRate, so this is the only way to get
//     peak_hr. Throttled to ~1 provider call/sec; non-fatal per session.
// ?max_intraday=N caps provider calls per run (PATCHes persist as they go, so
// re-running continues). Returns { checked, updated, skipped, errors,
// updated_peak_hr, peak_hr_skipped, peak_hr_errors }. Idempotent.
app.post("/api/debug/backfill-wearable-hr/:userId", async function(req, res) {
  var provider = req.query.provider || "fitbit";
  try {
    // Light guard: when ADMIN_SECRET is configured, require it.
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var pid = req.params.userId;
    var adapter = wearables.getProviderAdapter(provider);

    var wr = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + encodeURIComponent(pid) +
      "&wearable_activity_id=not.is.null&select=id,date,wearable_activity_id,wearable_data&limit=5000", { headers: sbHeaders() });
    var rows = await wr.json();
    if (!Array.isArray(rows)) rows = [];

    var token = await getValidWearableToken(pid, provider);

    // Helpers shared by both passes.
    var maxBpm = function(samples) {
      var hi = null;
      for (var k = 0; k < samples.length; k++) {
        var v = (samples[k] && typeof samples[k].bpm === "number") ? samples[k].bpm : null;
        if (v != null && (hi == null || v > hi)) hi = v;
      }
      return hi;
    };
    var patchWearableData = async function(id, wd) {
      var pr = await fetch(SUPABASE_URL + "/rest/v1/workouts?id=eq." + id, {
        method: "PATCH", headers: sbHeaders("return=minimal"),
        body: JSON.stringify({ wearable_data: wd }),
      });
      return pr.ok;
    };

    // ── Pass 1: fill avg_hr / calories / zones from the LIST endpoint ──────
    // The list carries averageHeartRate; the detail endpoint that first
    // populated these rows dropped it. Only rows missing avg_hr need this.
    var targets = rows.filter(function(w) {
      var wd = w.wearable_data;
      return !wd || typeof wd !== "object" || wd.avg_hr == null;
    });
    var updated = 0, skipped = 0, errors = 0;
    if (targets.length) {
      var dates = targets.map(function(w) { return w.date; }).filter(Boolean).sort();
      var activities = await adapter.fetchActivities(token, dates[0], dates[dates.length - 1]);
      var byId = {};
      activities.forEach(function(a) { if (a && a.provider_activity_id != null) byId[String(a.provider_activity_id)] = a; });
      for (var i = 0; i < targets.length; i++) {
        var w = targets[i];
        try {
          var bareId = splitNamespacedId(provider, w.wearable_activity_id).bare;
          var ln = byId[String(bareId)];
          if (!ln || (ln.avg_hr == null && ln.peak_hr == null)) { skipped++; continue; } // list has no HR either
          var wd = (w.wearable_data && typeof w.wearable_data === "object") ? w.wearable_data : {};
          var changed = false;
          ["avg_hr", "peak_hr", "calories", "active_zone_minutes"].forEach(function(f) {
            if (wd[f] == null && ln[f] != null) { wd[f] = ln[f]; changed = true; }
          });
          if (wd.zones == null && ln.zones != null) { wd.zones = ln.zones; changed = true; }
          if (!changed) { skipped++; continue; }
          if (await patchWearableData(w.id, wd)) updated++; else errors++;
        } catch (e) { errors++; }
      }
    }

    // ── Pass 2: derive peak_hr ────────────────────────────────────────────
    // peak_hr is NEVER on the list endpoint (no maxHeartRate), so pass 1 can't
    // fill it. For each wearable row still missing peak_hr, mirror the priority
    // chain in fetchActivityDetail:
    //   (a) reuse heart_rate_samples already stored on the row  — free
    //   (b) TCX export (MaximumHeartRateBpm)  — Server-type apps, needs only id
    //   (c) intraday HR window (max bpm)      — Personal-type apps, needs window
    // The optional ?max_intraday=N budget + the ~1/sec throttle apply to ALL
    // provider calls (TCX + intraday), since both count against Fitbit's rate
    // limit. Every call is non-fatal; PATCHes persist as they go so re-running
    // continues where it left off. peak_hr_from_* counts show which path works.
    var updated_peak_hr = 0, peak_hr_skipped = 0, peak_hr_errors = 0;
    var peak_hr_from_samples = 0, peak_hr_from_tcx = 0, peak_hr_from_intraday = 0;
    var hasIntraday = typeof adapter.fetchIntradayHr === "function";
    var hasTcx = typeof adapter.fetchActivityTcxPeakHr === "function";
    var maxCalls = parseInt(req.query.max_intraday, 10);
    if (!(maxCalls > 0)) maxCalls = Infinity;
    var apiCalls = 0;
    var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

    for (var j = 0; j < rows.length; j++) {
      var pw = rows[j];
      var pwd = (pw.wearable_data && typeof pw.wearable_data === "object") ? pw.wearable_data : null;
      if (!pwd || pwd.peak_hr != null) { peak_hr_skipped++; continue; } // no wearable_data, or already has peak

      // (a) Derive from samples already on the row — no provider call.
      if (Array.isArray(pwd.heart_rate_samples) && pwd.heart_rate_samples.length) {
        var hiLocal = maxBpm(pwd.heart_rate_samples);
        if (hiLocal != null) {
          pwd.peak_hr = hiLocal;
          if (await patchWearableData(pw.id, pwd)) { updated_peak_hr++; peak_hr_from_samples++; } else peak_hr_errors++;
        } else { peak_hr_skipped++; }
        continue;
      }

      var bareId = splitNamespacedId(provider, pw.wearable_activity_id).bare;

      // (b) TCX peak HR — Server-type apps. Needs only the activity id, so it
      // works even for rows without a stored start_time/duration window.
      if (hasTcx && bareId && apiCalls < maxCalls) {
        if (apiCalls > 0) await sleep(1000); // ~1 req/sec across all provider calls
        apiCalls++;
        try {
          var tcxPeak = await adapter.fetchActivityTcxPeakHr(token, bareId);
          if (tcxPeak != null) {
            pwd.peak_hr = tcxPeak;
            if (await patchWearableData(pw.id, pwd)) { updated_peak_hr++; peak_hr_from_tcx++; } else peak_hr_errors++;
            continue;
          }
          // TCX returned no peak → fall through to intraday below.
        } catch (e) {
          console.warn("[Backfill] TCX HR failed for workout " + pw.id + ": " + e.message);
          // non-fatal → fall through to intraday below.
        }
      }

      // (c) Intraday HR — Personal-type apps. Requires the activity time window.
      if (!hasIntraday || !pwd.start_time || pwd.duration_minutes == null) { peak_hr_skipped++; continue; }
      if (apiCalls >= maxCalls) { peak_hr_skipped++; continue; }
      if (apiCalls > 0) await sleep(1000); // ~1 req/sec across all provider calls
      apiCalls++;
      try {
        var samples = await adapter.fetchIntradayHr(token, {
          date: pwd.date || pw.date,
          start_time: pwd.start_time,
          duration_minutes: pwd.duration_minutes,
        });
        if (!samples || !samples.length) { peak_hr_skipped++; continue; }
        var hi = maxBpm(samples);
        if (hi == null) { peak_hr_skipped++; continue; }
        pwd.peak_hr = hi;
        pwd.heart_rate_samples = samples; // adapter caps at 600 samples
        if (await patchWearableData(pw.id, pwd)) { updated_peak_hr++; peak_hr_from_intraday++; } else peak_hr_errors++;
      } catch (e) {
        peak_hr_errors++;
        console.warn("[Backfill] intraday HR failed for workout " + pw.id + ": " + e.message);
      }
    }

    console.log("[Backfill] wearable-hr profile=" + pid + " checked=" + rows.length +
      " targets=" + targets.length + " updated=" + updated + " skipped=" + skipped + " errors=" + errors +
      " | peak_hr: updated=" + updated_peak_hr + " (samples=" + peak_hr_from_samples +
      " tcx=" + peak_hr_from_tcx + " intraday=" + peak_hr_from_intraday + ")" +
      " skipped=" + peak_hr_skipped + " errors=" + peak_hr_errors + " providerCalls=" + apiCalls);
    res.json({
      success: true,
      checked: rows.length,
      updated: updated, skipped: skipped, errors: errors,
      updated_peak_hr: updated_peak_hr,
      peak_hr_from_samples: peak_hr_from_samples,
      peak_hr_from_tcx: peak_hr_from_tcx,
      peak_hr_from_intraday: peak_hr_from_intraday,
      peak_hr_skipped: peak_hr_skipped, peak_hr_errors: peak_hr_errors,
    });
  } catch (e) {
    sendWearableError(res, e, provider);
  }
});

// POST /api/wearables/bulk-action/:userId
// body: {
//   action: "match_all" | "import_all" | "skip_all",
//   provider, start_date, end_date,
//   filter_activity_types?: string[],
//   score_threshold?: number   // match_all only, default 70
// }
// Re-derives the backlog over the requested window (so it acts on the
// live state, not a stale client snapshot), applies the action, and
// returns the recomputed remaining queue + per-action counts.
app.post("/api/wearables/bulk-action/:userId", async function(req, res) {
  var b = req.body || {};
  var provider = b.provider;
  try {
    var action = b.action;
    var validActions = ["match_all", "import_all", "skip_all"];
    if (validActions.indexOf(action) < 0) {
      return res.status(400).json({ success: false, error: "action must be one of " + validActions.join(", ") });
    }
    if (!provider || !b.start_date || !b.end_date) {
      return res.status(400).json({ success: false, error: "provider, start_date, end_date required" });
    }
    var threshold = typeof b.score_threshold === "number" ? b.score_threshold : 70;
    var typesFilter = null;
    if (Array.isArray(b.filter_activity_types) && b.filter_activity_types.length) {
      typesFilter = b.filter_activity_types.map(function(s) { return String(s).toLowerCase().trim(); });
    }

    var backlog = await computeWearableBacklog(req.params.userId, provider, b.start_date, b.end_date, typesFilter);

    var acted = 0;
    var failed = 0;
    var errors = [];

    if (action === "match_all") {
      // Only auto-merge candidates >= threshold. The reason for the
      // default 70 floor: anything below that is just "same date,
      // similar duration" which is too easy to get wrong without human
      // review.
      for (var i = 0; i < backlog.matched.length; i++) {
        var m = backlog.matched[i];
        if ((m.score || 0) < threshold) continue;
        try {
          await performMerge(req.params.userId, m.workout.id, provider, m.wearable_activity_id, m.activity);
          acted++;
        } catch (e) { failed++; errors.push(e.message); }
      }
    } else if (action === "import_all") {
      for (var j = 0; j < backlog.unmatched.length; j++) {
        var u = backlog.unmatched[j];
        try {
          await performImport(req.params.userId, provider, u.wearable_activity_id, u.activity);
          acted++;
        } catch (e) { failed++; errors.push(e.message); }
      }
    } else if (action === "skip_all") {
      // Skips EVERY pending match in scope. Caller can pre-filter via
      // filter_activity_types to scope this down to e.g. "skip all the
      // Treadmill matches".
      for (var k = 0; k < backlog.matched.length; k++) {
        var s = backlog.matched[k];
        try {
          await performReject(req.params.userId, s.workout.id, provider, s.wearable_activity_id, s.activity);
          acted++;
        } catch (e) { failed++; errors.push(e.message); }
      }
    }

    // Recompute so the client sees the post-action state without a
    // separate round-trip. Same window + filter — guarantees the UI's
    // counter stays consistent.
    var fresh = await computeWearableBacklog(req.params.userId, provider, b.start_date, b.end_date, typesFilter);
    res.json({
      success: true,
      action: action,
      acted: acted,
      failed: failed,
      errors: errors.slice(0, 5),  // cap error spam in the payload
      provider: provider,
      matched: fresh.matched,
      unmatched: fresh.unmatched,
      already_synced: fresh.already_synced,
      activity_types: fresh.activity_types,
    });
  } catch (e) {
    sendWearableError(res, e, provider);
  }
});

// Shared by /reject and /import. Fetches the detail through the adapter,
// shapes a workouts-table row (mirrors the existing /fitbit-import notes
// format for consistency in the History tab), and inserts.
async function createWearableWorkout(profileId, provider, namespacedActivityId, listActivity) {
  var bareId = namespacedActivityId.indexOf(provider + ":") === 0
    ? namespacedActivityId.slice(provider.length + 1)
    : namespacedActivityId;
  var adapter = wearables.getProviderAdapter(provider);
  var token = await getValidWearableToken(profileId, provider);
  var detail = await adapter.fetchActivityDetail(token, bareId);
  if (!detail) throw new Error("Activity not found on provider");
  mergeListHr(adapter, detail, listActivity); // fill HR the detail endpoint dropped

  var noteParts = ["Auto-imported from " + provider + ": "
    + (detail.duration_minutes != null ? detail.duration_minutes + " min" : "?")];
  if (detail.calories != null) noteParts.push(detail.calories + " cal burned");
  if (detail.avg_hr != null) noteParts.push("avg HR: " + detail.avg_hr + " bpm");
  var notes = noteParts.join(", ")
    + "\n[source: " + provider + "_activity, activityId=" + bareId + "]";

  var payload = {
    profile_id: parseInt(profileId, 10),
    date: detail.date,
    type: detail.activity_type || "Workout",
    notes: notes,
    done: true,
    mobility: false,
    med: false,
    ts: Date.now(),
    wearable_data: detail,
    wearable_activity_id: namespacedActivityId,
  };
  var wRes = await fetch(SUPABASE_URL + "/rest/v1/workouts", {
    method: "POST",
    headers: sbHeaders("return=representation"),
    body: JSON.stringify(payload),
  });
  if (!wRes.ok) {
    var t = await wRes.text();
    throw new Error("workout insert failed: " + t);
  }
  var rows = await wRes.json();
  clearProgressBriefCache(profileId);
  return Array.isArray(rows) ? rows[0] : rows;
}

// ─────────────────────────────────────────────────────────────────────────
// ANALYTICS  —  Workout Analytics Dashboard + Library Exercise Analytics
// ─────────────────────────────────────────────────────────────────────────
// Server-side mirror of the client inferWorkoutCategory() in index.html so the
// activity-stats endpoint buckets workouts the same way the rest of the app
// does. Keep the two in sync if the taxonomy changes.
function inferWorkoutCategoryServer(workoutType) {
  if (!workoutType) return "other";
  var t = String(workoutType).toLowerCase();
  if (/rest|recovery day|day off|off day/.test(t)) return "rest";
  if (/\b(mma|bjj|jiu.?jitsu|muay|boxing|kickbox|martial|spar|wrestling|judo|grappl|striking)\b/.test(t)) return "martial_arts";
  if (/\b(strength|lift|weights?|squat|deadlift|bench|press|row|powerlift|olympic|calisthenic|upper|lower|full body|pushup|pullup|chinup)\b/.test(t)) return "strength";
  if (/\b(cardio|run|jog|walk|hike|cycle|bike|elliptic|treadmill|swim|row|erg|hiit|conditioning|jump rope)\b/.test(t)) return "cardio";
  if (/\b(yoga|pilates|stretch|mobility|meditat|breath|mind ?body)\b/.test(t)) return "mind_body";
  if (/\b(pt|physical therapy|rehab|foam roll|active recovery)\b/.test(t)) return "rehab";
  if (/\b(tennis|basketball|soccer|volleyball|golf|ski|snowboard|surf|climb|sport)\b/.test(t)) return "sports";
  return "other";
}
var CATEGORY_PRETTY_SERVER = {
  strength: "Strength", cardio: "Cardio", martial_arts: "Martial Arts",
  sports: "Sports", mind_body: "Mind & Body", rehab: "Rehab",
  rest: "Rest", other: "Other",
};

var YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
function validYmd(s) { return typeof s === "string" && YMD_RE.test(s); }
function ymdLocal(x) {
  return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
}
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

// Pull HR / calories / duration out of a workout's wearable_data JSONB blob.
// Returns nulls when the column/field is absent so everything degrades to N/A
// when no wearable is connected.
function wearableMetrics(wd) {
  if (!wd || typeof wd !== "object") return { minutes: null, calories: null, avg_hr: null, peak_hr: null };
  // peak_hr is stored only when intraday enrichment ran at import time. The
  // Fitbit LIST endpoint (the backfill's only source) carries averageHeartRate
  // but NOT maxHeartRate, so backfilled rows get avg_hr while peak_hr stays
  // null. When the explicit field is absent, recover peak HR from the
  // per-minute intraday samples if they were captured. NOTE: wd.zones.peak is
  // *minutes spent in the peak zone*, NOT a bpm value — never read it as peak_hr.
  var peak = numOrNull(wd.peak_hr);
  if (peak == null && Array.isArray(wd.heart_rate_samples)) {
    var hi = null;
    for (var i = 0; i < wd.heart_rate_samples.length; i++) {
      var s = wd.heart_rate_samples[i];
      var v = numOrNull(s && s.bpm);
      if (v != null && (hi == null || v > hi)) hi = v;
    }
    peak = hi;
  }
  return {
    minutes: numOrNull(wd.duration_minutes),
    calories: numOrNull(wd.calories),
    avg_hr: numOrNull(wd.avg_hr),
    peak_hr: peak,
  };
}
// Fallback metrics parsed from a workout's free-text notes. Legacy Fitbit
// auto-imports (/api/profiles/:id/fitbit-import) store HR / calories / duration
// in the notes string ONLY — they never populate the wearable_data column — so
// without this, HR shows N/A for every auto-imported session.
function notesMetrics(notes) {
  var out = { minutes: null, calories: null, avg_hr: null, peak_hr: null };
  if (!notes) return out;
  var s = String(notes);
  var hr = s.match(/avg(?:erage)?\s*hr:?\s*(\d{2,3})\b/i);
  if (hr) out.avg_hr = parseInt(hr[1], 10);
  var cal = s.match(/(\d{1,5})\s*cal(?:orie)?s?\s*burned/i);
  if (cal) out.calories = parseInt(cal[1], 10);
  // Only trust a bare "N min" as duration when the note is a Fitbit import —
  // free-text workout notes mention minutes for all sorts of reasons.
  if (/fitbit/i.test(s)) {
    var mins = s.match(/(\d{1,4})\s*min\b/i);
    if (mins) out.minutes = parseInt(mins[1], 10);
  }
  return out;
}
// Combined per-workout metrics: wearable_data first, notes as fallback.
function sessionMetrics(w) {
  var wm = wearableMetrics(w.wearable_data);
  var nm = notesMetrics(w.notes);
  return {
    minutes: wm.minutes != null ? wm.minutes : nm.minutes,
    calories: wm.calories != null ? wm.calories : nm.calories,
    avg_hr: wm.avg_hr != null ? wm.avg_hr : nm.avg_hr,
    peak_hr: wm.peak_hr != null ? wm.peak_hr : nm.peak_hr,
  };
}

// Longest run of consecutive calendar days inside a Set of YYYY-MM-DD strings.
function longestStreakFromDates(dateSet) {
  var dates = Array.from(dateSet).sort();
  if (!dates.length) return 0;
  var longest = 1, run = 1;
  for (var i = 1; i < dates.length; i++) {
    var gap = Math.round((new Date(dates[i] + "T12:00:00") - new Date(dates[i - 1] + "T12:00:00")) / 86400000);
    if (gap === 1) { run++; if (run > longest) longest = run; }
    else if (gap > 1) { run = 1; }
  }
  return longest;
}
// Current streak: consecutive done-days ending today (or yesterday if nothing
// logged yet today). Mirrors the streak math used elsewhere in server.js.
function currentStreakFromDates(dateSet) {
  var streak = 0, d = new Date(), check = ymdLocal(d);
  if (!dateSet.has(check)) { d.setDate(d.getDate() - 1); check = ymdLocal(d); }
  while (dateSet.has(check)) { streak++; d.setDate(d.getDate() - 1); check = ymdLocal(d); }
  return streak;
}
// up if curr beats prev by >5%, down if below by >5%, else stable. pct is the
// rounded % change (null when there's no previous baseline to compare against).
function trendOf(curr, prev) {
  curr = Number(curr) || 0;
  if (prev === null || prev === undefined || !isFinite(prev) || prev === 0) {
    return { current: curr, previous: (prev == null ? null : prev), pct: null, direction: curr > 0 ? "up" : "stable" };
  }
  var pct = Math.round(((curr - prev) / prev) * 100);
  return { current: curr, previous: prev, pct: pct, direction: pct > 5 ? "up" : pct < -5 ? "down" : "stable" };
}

// GET /api/analytics/activity-stats/:userId?start_date=&end_date=
// Per-activity-type + overall workout aggregates, with current-vs-previous
// same-length-period trends. Defaults to all-time when no dates are given.
app.get("/api/analytics/activity-stats/:userId", async function(req, res) {
  try {
    var pid = req.params.userId;
    var startDate = validYmd(req.query.start_date) ? req.query.start_date : null;
    var endDate = validYmd(req.query.end_date) ? req.query.end_date : null;
    var allTime = !startDate || !endDate;

    // Previous comparison window: same length, immediately before the current one.
    var prevStart = null, prevEnd = null;
    if (!allTime) {
      var s = new Date(startDate + "T12:00:00");
      var e = new Date(endDate + "T12:00:00");
      var days = Math.round((e - s) / 86400000) + 1; // inclusive
      var pe = new Date(s); pe.setDate(pe.getDate() - 1);
      var ps = new Date(pe); ps.setDate(ps.getDate() - (days - 1));
      prevEnd = ymdLocal(pe); prevStart = ymdLocal(ps);
    }

    // One workouts query covering prev+current (or all-time). wearable_data may
    // not exist if the wearables migration hasn't run — fall back gracefully.
    var wBase = SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + encodeURIComponent(pid) + "&order=date.asc&limit=20000";
    var wRange = allTime ? "" : "&date=gte." + prevStart + "&date=lte." + endDate;
    var wr = await fetch(wBase + "&select=id,date,type,done,notes,wearable_activity_id,wearable_data" + wRange, { headers: sbHeaders() });
    if (!wr.ok) wr = await fetch(wBase + "&select=id,date,type,done,notes" + wRange, { headers: sbHeaders() });
    var workouts = await wr.json();
    if (!Array.isArray(workouts)) workouts = [];

    // Diagnostic: how many sessions carry HR and from where. Confirms wearable_data
    // is read correctly (it is) vs. simply being absent. wearable-synced sessions
    // have wearable_activity_id set — if those lack wearable_data.avg_hr, the gap is
    // that Fitbit didn't return averageHeartRate for the activity (no HR strap data),
    // not a query bug. Legacy Fitbit auto-imports carry HR in notes only (notesMetrics).
    var diag = { total: workouts.length, withWearableData: 0, withWearableHR: 0, withNotesHR: 0, withActivityId: 0, activityIdWithHR: 0 };
    workouts.forEach(function(w) {
      var hasW = !!(w.wearable_data && typeof w.wearable_data === "object");
      var hasHrW = hasW && numOrNull(w.wearable_data.avg_hr) != null;
      if (hasW) diag.withWearableData++;
      if (hasHrW) diag.withWearableHR++;
      else if (notesMetrics(w.notes).avg_hr != null) diag.withNotesHR++;
      if (w.wearable_activity_id) { diag.withActivityId++; if (hasHrW) diag.activityIdWithHR++; }
    });
    console.log("[Analytics] activity-stats profile=" + pid +
      " range=" + (allTime ? "all-time" : (startDate + ".." + endDate)) +
      " workouts=" + diag.total + " withWearableData=" + diag.withWearableData +
      " withWearableHR=" + diag.withWearableHR + " withNotesHR=" + diag.withNotesHR +
      " wearableActivityId=" + diag.withActivityId + " activityId+HR=" + diag.activityIdWithHR);

    // Exercise durations for the same window fill in manual sessions that have
    // no wearable_data. Summed per workout_id.
    var exBase = SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + encodeURIComponent(pid) +
      "&select=workout_id,date,duration_minutes&order=date.asc&limit=50000";
    var exUrl = exBase + (allTime ? "" : "&date=gte." + prevStart + "&date=lte." + endDate);
    var er = await fetch(exUrl, { headers: sbHeaders() });
    var exRows = await er.json();
    if (!Array.isArray(exRows)) exRows = [];
    var durByWorkout = {};
    exRows.forEach(function(ex) {
      var m = numOrNull(ex.duration_minutes);
      if (m && ex.workout_id != null) durByWorkout[ex.workout_id] = (durByWorkout[ex.workout_id] || 0) + m;
    });

    function inWindow(dateStr, lo, hi) { return (!lo || dateStr >= lo) && (!hi || dateStr <= hi); }

    function aggregate(lo, hi) {
      var acts = {}, doneDates = new Set(), dayOfWeek = [0, 0, 0, 0, 0, 0, 0];
      var totalMin = 0, totalCal = 0, calCount = 0, totalSessions = 0, hrAll = [], peakHrAll = null;
      workouts.forEach(function(w) {
        if (!inWindow(w.date, lo, hi)) return;
        var cat = inferWorkoutCategoryServer(w.type);
        var wm = sessionMetrics(w);
        var minutes = wm.minutes != null ? wm.minutes : (durByWorkout[w.id] || 0);
        if (!acts[cat]) acts[cat] = { type: cat, label: CATEGORY_PRETTY_SERVER[cat] || cat, total_sessions: 0, total_minutes: 0, _calSum: 0, _calCount: 0, _hr: [], peak_hr: null, sessions: [] };
        var a = acts[cat];
        a.total_sessions++;
        a.total_minutes += minutes;
        if (wm.calories != null) { a._calSum += wm.calories; a._calCount++; }
        if (wm.avg_hr != null) { a._hr.push(wm.avg_hr); hrAll.push(wm.avg_hr); }
        if (wm.peak_hr != null) { a.peak_hr = a.peak_hr == null ? wm.peak_hr : Math.max(a.peak_hr, wm.peak_hr); peakHrAll = peakHrAll == null ? wm.peak_hr : Math.max(peakHrAll, wm.peak_hr); }
        a.sessions.push({ date: w.date, duration: minutes || null, avg_hr: wm.avg_hr, peak_hr: wm.peak_hr, calories: wm.calories });
        totalMin += minutes;
        if (wm.calories != null) { totalCal += wm.calories; calCount++; }
        totalSessions++;
        if (w.done) { doneDates.add(w.date); dayOfWeek[new Date(w.date + "T12:00:00").getDay()]++; }
      });
      return { acts: acts, doneDates: doneDates, dayOfWeek: dayOfWeek, totalMin: totalMin, totalCal: totalCal, calCount: calCount, totalSessions: totalSessions, hrAll: hrAll, peakHrAll: peakHrAll };
    }
    function mean(arr) { return arr.length ? Math.round(arr.reduce(function(x, y) { return x + y; }, 0) / arr.length) : null; }

    var cur = aggregate(allTime ? null : startDate, allTime ? null : endDate);
    var prev = allTime ? null : aggregate(prevStart, prevEnd);

    var dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    var activities = Object.keys(cur.acts).map(function(cat) {
      var a = cur.acts[cat];
      var avgHr = mean(a._hr);
      var prevA = (prev && prev.acts[cat]) ? prev.acts[cat] : null;
      var prevAvgHr = prevA ? mean(prevA._hr) : null;
      var recent = a.sessions.slice().sort(function(p, q) { return p.date < q.date ? 1 : p.date > q.date ? -1 : 0; }).slice(0, 10);
      return {
        type: a.type,
        label: a.label,
        total_sessions: a.total_sessions,
        total_minutes: Math.round(a.total_minutes),
        avg_min_per_session: a.total_sessions ? Math.round(a.total_minutes / a.total_sessions) : null,
        avg_hr: avgHr,
        peak_hr: a.peak_hr,
        total_calories: a._calCount ? Math.round(a._calSum) : null,
        avg_calories_per_session: a._calCount ? Math.round(a._calSum / a._calCount) : null,
        trend_minutes: trendOf(a.total_minutes, prevA ? prevA.total_minutes : null),
        trend_avg_hr: trendOf(avgHr || 0, prevAvgHr),
        recent_sessions: recent,
      };
    }).sort(function(p, q) { return q.total_minutes - p.total_minutes; });

    var mostActiveDay = cur.totalSessions ? dayNames[cur.dayOfWeek.indexOf(Math.max.apply(null, cur.dayOfWeek))] : null;
    var overall = {
      total_workout_minutes: Math.round(cur.totalMin),
      total_sessions: cur.totalSessions,
      total_calories: cur.totalCal ? Math.round(cur.totalCal) : null,
      avg_min_per_session: cur.totalSessions ? Math.round(cur.totalMin / cur.totalSessions) : null,
      avg_calories_per_session: cur.calCount ? Math.round(cur.totalCal / cur.calCount) : null,
      avg_hr: mean(cur.hrAll),
      peak_hr: cur.peakHrAll,
      most_active_day_of_week: mostActiveDay,
      current_streak: currentStreakFromDates(cur.doneDates),
      longest_streak: longestStreakFromDates(cur.doneDates),
    };

    var comparison = null;
    if (prev) {
      comparison = {
        total_minutes: trendOf(cur.totalMin, prev.totalMin),
        total_sessions: trendOf(cur.totalSessions, prev.totalSessions),
        total_calories: trendOf(cur.totalCal, prev.totalCal),
        avg_hr: trendOf(mean(cur.hrAll) || 0, mean(prev.hrAll)),
      };
    }

    res.json({
      success: true,
      range: { start: startDate, end: endDate, all_time: allTime, previous_start: prevStart, previous_end: prevEnd },
      overall: overall,
      comparison: comparison,
      activities: activities,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/analytics/exercise-stats/:userId/:exerciseName?start_date=&end_date=
// Per-day + all-time stats for a single exercise. daily_data is sorted asc for
// charting. Weight fields (max_weight_ever, estimated_1rm via Epley) are only
// populated when the exercise has logged weight.
app.get("/api/analytics/exercise-stats/:userId/:exerciseName", async function(req, res) {
  try {
    var pid = req.params.userId;
    var name = decodeURIComponent(req.params.exerciseName);
    var startDate = validYmd(req.query.start_date) ? req.query.start_date : null;
    var endDate = validYmd(req.query.end_date) ? req.query.end_date : null;
    var allTime = !startDate || !endDate;

    var url = SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + encodeURIComponent(pid) +
      "&name=eq." + encodeURIComponent(name) +
      "&select=date,sets,reps,weight_lbs,duration_minutes,distance_miles,raw_text,notes&order=date.asc&limit=10000";
    if (!allTime) url += "&date=gte." + startDate + "&date=lte." + endDate;
    var r = await fetch(url, { headers: sbHeaders() });
    var rows = await r.json();
    if (!Array.isArray(rows)) rows = [];

    var byDay = {}, bestSingleSet = 0, maxWeightEver = null, est1rm = null;
    var hasReps = false, hasDuration = false, bestHoldSec = 0;
    rows.forEach(function(ex) {
      var reps = numOrNull(ex.reps) || 0;
      var setsRaw = numOrNull(ex.sets);
      var weight = numOrNull(ex.weight_lbs);
      // Per-hold/per-set duration in seconds: duration_minutes column first, else
      // parse it out of raw_text / notes (e.g. "Dead Hang 3x30s", "Plank 60 sec").
      var durMin = numOrNull(ex.duration_minutes);
      var holdSec = durMin != null ? Math.round(durMin * 60)
        : (parseDurationToSeconds(ex.raw_text || "") || parseDurationToSeconds(ex.notes || ""));
      var sets = setsRaw != null ? setsRaw : ((reps || holdSec) ? 1 : 0); // reps OR a hold = at least 1 set
      var d = ex.date;
      if (!byDay[d]) byDay[d] = { date: d, highest_set: 0, total_reps: 0, total_sets: 0, max_weight: null, highest_hold: 0, total_seconds: 0 };
      var day = byDay[d];
      if (reps > day.highest_set) day.highest_set = reps;
      day.total_reps += sets * reps;
      day.total_sets += sets;
      if (holdSec > day.highest_hold) day.highest_hold = holdSec;
      day.total_seconds += sets * holdSec;
      if (weight != null && (day.max_weight == null || weight > day.max_weight)) day.max_weight = weight;
      if (reps > 0) { hasReps = true; if (reps > bestSingleSet) bestSingleSet = reps; }
      if (holdSec > 0) { hasDuration = true; if (holdSec > bestHoldSec) bestHoldSec = holdSec; }
      if (weight != null) {
        if (maxWeightEver == null || weight > maxWeightEver) maxWeightEver = weight;
        if (reps > 0) { var e1 = weight * (1 + reps / 30); if (est1rm == null || e1 > est1rm) est1rm = e1; }
      }
    });

    // Duration-based exercise = has hold/duration data and no reps (Dead Hang,
    // Plank, etc.). The UI switches its axes/labels/stats to seconds for these.
    var isDurationBased = hasDuration && !hasReps;
    var isWeightBased = maxWeightEver != null;

    var daily = Object.keys(byDay).sort().map(function(k) { return byDay[k]; });
    var totalReps = daily.reduce(function(s, d) { return s + d.total_reps; }, 0);
    var totalSets = daily.reduce(function(s, d) { return s + d.total_sets; }, 0);
    var totalSeconds = daily.reduce(function(s, d) { return s + d.total_seconds; }, 0);
    var bestVolDay = null, bestDurDay = null;
    daily.forEach(function(d) {
      if (!bestVolDay || d.total_reps > bestVolDay.total_reps) bestVolDay = { date: d.date, total_reps: d.total_reps };
      if (!bestDurDay || d.total_seconds > bestDurDay.total_seconds) bestDurDay = { date: d.date, total_seconds: d.total_seconds };
    });

    res.json({
      success: true,
      exercise: name,
      range: { start: startDate, end: endDate, all_time: allTime },
      daily_data: daily,
      aggregate: {
        total_reps: totalReps,
        avg_reps_per_set: totalSets ? Math.round((totalReps / totalSets) * 10) / 10 : null,
        best_single_set: bestSingleSet || null,
        best_volume_day: bestVolDay,
        total_sessions: daily.length,
        is_weight_based: isWeightBased,
        max_weight_ever: maxWeightEver,
        estimated_1rm: est1rm != null ? Math.round(est1rm) : null,
        is_duration_based: isDurationBased,
        total_seconds: totalSeconds,
        avg_seconds_per_set: totalSets ? Math.round((totalSeconds / totalSets) * 10) / 10 : null,
        best_hold_seconds: bestHoldSec || null,
        best_duration_day: bestDurDay,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, function() {
  console.log("ApexCoach running on port " + PORT);
});
