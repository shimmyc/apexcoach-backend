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

async function buildDailyData(token) {
  const today     = dateStr(0);
  const yesterday = dateStr(-1);
  const weekAgo   = dateStr(-7);

  const results = await Promise.all([
    fitGet("/1.2/user/-/sleep/date/" + today + ".json", token),
    fitGet("/1/user/-/activities/heart/date/" + today + "/1d.json", token),
    fitGet("/1/user/-/activities/heart/date/" + yesterday + "/1d.json", token),
    fitGet("/1/user/-/hrv/date/" + today + ".json", token),
    fitGet("/1/user/-/activities/date/" + yesterday + ".json", token),
    fitGet("/1/user/-/hrv/date/" + weekAgo + "/" + today + ".json", token).catch(function() { return { hrv: [] }; }),
    fitGet("/1/user/-/activities/heart/date/" + weekAgo + "/" + today + ".json", token).catch(function() { return { "activities-heart": [] }; }),
    fitGet("/1/user/-/sleep/date/" + today + ".json", token).catch(function() { return {}; }),
  ]);

  var sleep      = results[0];
  const heartToday = results[1];
  const heartYest  = results[2];
  var hrvToday   = results[3];
  const actYest    = results[4];
  const hrvWeek    = results[5];
  const heartWeek  = results[6];
  var sleepV1    = results[7];

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

app.get("/api/profiles/:id", async function(req, res) {
  try {
    var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + req.params.id + "&select=id,name,avatar_color,profile_data", {
      headers: sbHeaders(),
    });
    var rows = await r.json();
    if (!rows || !rows.length) return res.json({ success: false, error: "Profile not found." });
    var p = rows[0];
    res.json({ success: true, profile: { id: p.id, name: p.name, avatar_color: p.avatar_color, profile_data: cleanProfileData(p.profile_data || {}) } });
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
    var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + body.id + "&select=id,name,avatar_color,pin,profile_data", {
      headers: sbHeaders(),
    });
    var rows = await r.json();
    if (!rows || !rows.length) return res.json({ success: false, error: "Profile not found." });
    var profile = rows[0];
    if (profile.pin !== hashPin(body.pin)) return res.json({ success: false, error: "Incorrect PIN." });
    res.json({
      success: true,
      profile: {
        id: profile.id,
        name: profile.name,
        avatar_color: profile.avatar_color,
        profile_data: cleanProfileData(profile.profile_data || {}),
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch("/api/profiles/:id", async function(req, res) {
  try {
    var profileId = req.params.id;
    var body = req.body;
    // Build update payload - supports name, avatar_color, and profile_data
    var updatePayload = {};
    if (body.name) updatePayload.name = body.name;
    if (body.avatar_color) updatePayload.avatar_color = body.avatar_color;

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
    res.json({ success: true, profile: { id: profile.id, name: profile.name, avatar_color: profile.avatar_color, profile_data: profile.profile_data } });
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
    const result = await buildDailyData(token);
    res.json({ success: true, date: result.date, data: result.data });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
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

app.post("/api/workouts", async function(req, res) {
  try {
    var r = await fetch(SUPABASE_URL + "/rest/v1/workouts", {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify(req.body),
    });
    var data = await r.json();
    res.json({ success: true, workout: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch("/api/workouts/:id", async function(req, res) {
  try {
    var id = req.params.id;
    var r = await fetch(SUPABASE_URL + "/rest/v1/workouts?id=eq." + id, {
      method: "PATCH",
      headers: sbHeaders("return=representation"),
      body: JSON.stringify(req.body),
    });
    var data = await r.json();
    res.json({ success: true, workout: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete("/api/workouts/:id", async function(req, res) {
  try {
    var id = req.params.id;
    await fetch(SUPABASE_URL + "/rest/v1/workouts?id=eq." + id, {
      method: "DELETE",
      headers: sbHeaders("return=minimal"),
    });
    res.json({ success: true });
  } catch (e) {
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

async function callAI(prompt, maxTokens) {
  var response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
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

// ── EXERCISE LIBRARY ──────────────────────────────────────────────────────
app.post("/api/profiles/:id/extract-exercises", async function(req, res) {
  try {
    var profileId = req.params.id;
    var body = req.body;
    if (!body.notes || !body.notes.trim()) return res.json({ success: true, exercises: [] });

    var prompt = "Extract all exercises from these workout notes. For each exercise identify: name (normalized, e.g. 'Glute Bridge' not 'glute bridges'), category (one of: strength/cardio/mobility/mma/rehab/other), sets (number or null), reps (number or null), weight_lbs (number or null), distance_miles (number or null), duration_minutes (number or null), raw_text (original text snippet).\nReturn ONLY a JSON array of exercise objects, no explanation.\nExample: [{\"name\":\"Glute Bridge\",\"category\":\"rehab\",\"sets\":3,\"reps\":12,\"weight_lbs\":null,\"distance_miles\":null,\"duration_minutes\":null,\"raw_text\":\"glute bridges 3x12\"}]\nWorkout type: " + (body.type || "unknown") + "\nNotes: " + body.notes;

    var aiText = await callAI(prompt, 1000);
    var exercises = [];
    try {
      var cleaned = aiText.indexOf("[") >= 0 ? aiText.substring(aiText.indexOf("["), aiText.lastIndexOf("]") + 1) : "[]";
      exercises = JSON.parse(cleaned);
    } catch (e) {
      console.error("Exercise parse error:", e.message);
      return res.json({ success: true, exercises: [] });
    }

    // Insert into Supabase
    for (var i = 0; i < exercises.length; i++) {
      var ex = exercises[i];
      await fetch(SUPABASE_URL + "/rest/v1/exercises", {
        method: "POST",
        headers: sbHeaders("return=minimal"),
        body: JSON.stringify({
          profile_id: parseInt(profileId),
          workout_id: body.workout_id || null,
          date: body.date,
          name: ex.name,
          category: ex.category || "other",
          sets: ex.sets || null,
          reps: ex.reps || null,
          weight_lbs: ex.weight_lbs || null,
          distance_miles: ex.distance_miles || null,
          duration_minutes: ex.duration_minutes || null,
          notes: null,
          raw_text: ex.raw_text || null,
        }),
      });
    }
    res.json({ success: true, exercises: exercises });
  } catch (e) {
    console.error("extract-exercises error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/profiles/:id/exercises", async function(req, res) {
  try {
    var profileId = req.params.id;
    var url = SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + profileId + "&select=*&order=date.desc";
    if (req.query.name) url += "&name=eq." + encodeURIComponent(req.query.name);
    if (req.query.category) url += "&category=eq." + encodeURIComponent(req.query.category);
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
        grouped[ex.name] = { name: ex.name, category: ex.category, count: 0, last_date: null, best_weight: null, best_reps: null, sessions: [] };
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
      if (!exCount[ex.name]) exCount[ex.name] = { name: ex.name, category: ex.category, count: 0 };
      exCount[ex.name].count++;
    });
    var topEx = Object.values(exCount).sort(function(a, b) { return b.count - a.count; }).slice(0, 10);

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

// ── AI PROXY ──────────────────────────────────────────────────────────────
app.post("/api/ai", async function(req, res) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, function() {
  console.log("ApexCoach running on port " + PORT);
});
