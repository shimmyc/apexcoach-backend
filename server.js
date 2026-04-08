const express = require("express");
const fetch   = require("node-fetch");
const path    = require("path");

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

// ── TOKEN STORAGE ──────────────────────────────────────────────────────────
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
    console.log("Tokens saved to Supabase.");
  } catch (e) {
    console.error("saveTokens error:", e.message);
  }
}

async function refreshAccessToken() {
  const tokens = await loadTokens();
  console.log("Refreshing token...");
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

async function fitGet(endpoint, token) {
  const res = await fetch("https://api.fitbit.com" + endpoint, {
    headers: { "Authorization": "Bearer " + token },
  });
  if (!res.ok) throw new Error("Fitbit " + res.status + " for " + endpoint);
  return res.json();
}

function dateStr(offsetDays) {
  offsetDays = offsetDays || 0;
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

// ── OAUTH ──────────────────────────────────────────────────────────────────
app.get("/auth", function(req, res) {
  const url = "https://www.fitbit.com/oauth2/authorize?response_type=code&client_id=" + CLIENT_ID +
    "&redirect_uri=" + encodeURIComponent(REDIRECT_URI) +
    "&scope=" + encodeURIComponent("sleep heartrate activity profile");
  res.redirect(url);
});

app.get("/callback", async function(req, res) {
  const code = req.query.code;
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
    await saveTokens({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Date.now() + (data.expires_in * 1000) - 60000,
    });
    console.log("OAuth complete. Tokens saved to Supabase.");
    res.redirect("/");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ── FITBIT DATA ────────────────────────────────────────────────────────────
app.get("/api/daily", async function(req, res) {
  try {
    const token     = await getValidToken();
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
    ]);

    const sleep      = results[0];
    const heartToday = results[1];
    const heartYest  = results[2];
    const hrvToday   = results[3];
    const actYest    = results[4];
    const hrvWeek    = results[5];
    const heartWeek  = results[6];

    const sleepArr    = sleep && sleep.sleep ? sleep.sleep : [];
    const sleepRecord = sleepArr.find(function(s) { return s.isMainSleep; }) || sleepArr[0] || null;
    const heartYestArr = heartYest && heartYest["activities-heart"] ? heartYest["activities-heart"] : [];
    const zones = heartYestArr[0] && heartYestArr[0].value ? heartYestArr[0].value.heartRateZones || [] : [];
    const heartTodayArr = heartToday && heartToday["activities-heart"] ? heartToday["activities-heart"] : [];
    const rhr = heartTodayArr[0] && heartTodayArr[0].value ? heartTodayArr[0].value.restingHeartRate || null : null;
    const hrvTodayArr = hrvToday && hrvToday.hrv ? hrvToday.hrv : [];
    const hrv = hrvTodayArr[0] && hrvTodayArr[0].value ? hrvTodayArr[0].value.dailyRmssd || null : null;
    const heartWeekArr = heartWeek && heartWeek["activities-heart"] ? heartWeek["activities-heart"] : [];
    const rhrVals = heartWeekArr.map(function(d) { return d.value && d.value.restingHeartRate; }).filter(Boolean);
    const hrvWeekArr = hrvWeek && hrvWeek.hrv ? hrvWeek.hrv : [];
    const hrvVals = hrvWeekArr.map(function(d) { return d.value && d.value.dailyRmssd; }).filter(Boolean);

    function findZone(name) {
      const z = zones.find(function(z) { return z.name === name; });
      return z ? z.minutes || 0 : 0;
    }

    res.json({
      success: true,
      date: today,
      data: {
        sleep: {
          hours:        sleepRecord ? +(sleepRecord.minutesAsleep / 60).toFixed(2) : null,
          efficiency:   sleepRecord ? sleepRecord.efficiency : null,
          minutesAwake: sleepRecord ? sleepRecord.minutesAwake : null,
          stages:       sleepRecord && sleepRecord.levels ? sleepRecord.levels.summary : null,
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
      },
    });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── WORKOUT LOG ────────────────────────────────────────────────────────────
app.get("/api/workouts", async function(req, res) {
  try {
    var limit = req.query.limit || 60;
    var r = await fetch(SUPABASE_URL + "/rest/v1/workouts?select=*&order=ts.desc&limit=" + limit, {
      headers: sbHeaders(),
    });
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

// ── MEDITATION LOG ─────────────────────────────────────────────────────────
app.get("/api/meditations", async function(req, res) {
  try {
    var r = await fetch(SUPABASE_URL + "/rest/v1/workouts?select=date&med=eq.true&order=date.desc&limit=30", {
      headers: sbHeaders(),
    });
    var data = await r.json();
    var dates = Array.isArray(data) ? data.map(function(w) { return w.date; }) : [];
    res.json({ success: true, dates: dates });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── TOKEN INFO ─────────────────────────────────────────────────────────────
app.get("/api/token-info", async function(req, res) {
  const tokens = await loadTokens();
  res.json({
    has_refresh_token: !!tokens.refresh_token,
    expires_at: tokens.expires_at ? new Date(Number(tokens.expires_at)).toISOString() : "none",
  });
});

// ── AI PROXY ───────────────────────────────────────────────────────────────
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
