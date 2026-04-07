const express = require("express");
const fetch   = require("node-fetch");
const fs      = require("fs");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID     = process.env.FITBIT_CLIENT_ID;
const CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET;
const REDIRECT_URI  = "https://apexcoach-backend.onrender.com/callback";
const TOKEN_FILE    = path.join("/tmp", "tokens.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch (e) {}
  return {
    access_token:  process.env.FITBIT_ACCESS_TOKEN  || "",
    refresh_token: process.env.FITBIT_REFRESH_TOKEN || "",
    expires_at:    0,
  };
}

function saveTokens(tokens) {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens)); } catch (e) {}
}

async function refreshAccessToken() {
  const tokens = loadTokens();
  console.log("Refreshing token...");
  const creds = Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");
  const res = await fetch("https://api.fitbit.com/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + creds,
      "Content-Type": "application/x-www-form-urlencoded"
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
  saveTokens(next);
  console.log("Token refreshed. New refresh token: " + data.refresh_token);
  return next.access_token;
}

async function getValidToken() {
  const tokens = loadTokens();
  if (tokens.access_token && Date.now() < tokens.expires_at) return tokens.access_token;
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
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=authorization_code&code=" + code + "&redirect_uri=" + encodeURIComponent(REDIRECT_URI),
    });
    if (!resp.ok) return res.status(400).send("Failed: " + await resp.text());
    const data = await resp.json();
    saveTokens({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Date.now() + (data.expires_in * 1000) - 60000,
    });
    console.log("OAuth complete. Refresh token: " + data.refresh_token);
    res.redirect("/success.html?token=" + data.refresh_token);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

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

app.get("/api/token-info", function(req, res) {
  const tokens = loadTokens();
  res.json({
    has_refresh_token: !!tokens.refresh_token,
    expires_at: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : "none",
  });
});

app.post("/api/set-tokens", function(req, res) {
  const body = req.body;
  if (body.secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });
  saveTokens({ access_token: body.access_token, refresh_token: body.refresh_token, expires_at: Date.now() + (28800 * 1000) });
  res.json({ success: true });
});

app.listen(PORT, function() {
  console.log("ApexCoach running on port " + PORT);
  const existing = loadTokens();
  if (!existing.refresh_token && process.env.FITBIT_REFRESH_TOKEN) {
    saveTokens({
      access_token:  process.env.FITBIT_ACCESS_TOKEN || "",
      refresh_token: process.env.FITBIT_REFRESH_TOKEN,
      expires_at:    0,
    });
    console.log("Initialized tokens from environment.");
  }
});
