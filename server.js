const express = require("express");
const fetch   = require("node-fetch");
const fs      = require("fs");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID     = process.env.FITBIT_CLIENT_ID;
const CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET;
const TOKEN_FILE    = path.join("/tmp", "tokens.json");

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

app.use(express.json());

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    }
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
  console.log("Refreshing Fitbit access token...");
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res   = await fetch("https://api.fitbit.com/oauth2/token", {
    method:  "POST",
    headers: {
      Authorization:  `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=refresh_token&refresh_token=${tokens.refresh_token}`,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }
  const data = await res.json();
  const next = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + (data.expires_in * 1000) - 60000,
  };
  saveTokens(next);
  console.log("Token refreshed successfully.");
  return next.access_token;
}

async function getValidToken() {
  const tokens = loadTokens();
  if (tokens.access_token && Date.now() < tokens.expires_at) {
    return tokens.access_token;
  }
  return await refreshAccessToken();
}

async function fitGet(endpoint, token) {
  const res = await fetch(`https://api.fitbit.com${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Fitbit API error ${res.status} for ${endpoint}`);
  return res.json();
}

function dateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

app.get("/api/daily", async (req, res) => {
  try {
    const token     = await getValidToken();
    const today     = dateStr(0);
    const yesterday = dateStr(-1);
    const weekAgo   = dateStr(-7);

    const [sleep, heartToday, heartYest, hrvToday, actYest, hrvWeek, heartWeek] =
      await Promise.all([
        fitGet(`/1.2/user/-/sleep/date/${today}.json`, token),
        fitGet(`/1/user/-/activities/heart/date/${today}/1d.json`, token),
        fitGet(`/1/user/-/activities/heart/date/${yesterday}/1d.json`, token),
        fitGet(`/1/user/-/hrv/date/${today}.json`, token),
        fitGet(`/1/user/-/activities/date/${yesterday}.json`, token),
        fitGet(`/1/user/-/hrv/date/${weekAgo}/${today}.json`, token).catch(() => ({ hrv: [] })),
        fitGet(`/1/user/-/activities/heart/date/${weekAgo}/${today}.json`, token).catch(() => ({ "activities-heart": [] })),
      ]);

    const sleepRecord     = sleep?.sleep?.find(s => s.isMainSleep) ?? sleep?.sleep?.[0];
    const sleepHours      = sleepRecord ? sleepRecord.minutesAsleep / 60 : null;
    const sleepEfficiency = sleepRecord?.efficiency ?? null;
    const minutesAwake    = sleepRecord?.minutesAwake ?? null;
    const sleepStages     = sleepRecord?.levels?.summary ?? null;
    const rhr             = heartToday?.["activities-heart"]?.[0]?.value?.restingHeartRate ?? null;
    const hrv             = hrvToday?.hrv?.[0]?.value?.dailyRmssd ?? null;
    const zones           = heartYest?.["activities-heart"]?.[0]?.value?.heartRateZones ?? [];
    const prevZones = {
      peak:    zones.find(z => z.name === "Peak")?.minutes    ?? 0,
      cardio:  zones.find(z => z.name === "Cardio")?.minutes  ?? 0,
      fatBurn: zones.find(z => z.name === "Fat Burn")?.minutes ?? 0,
    };
    const steps   = actYest?.summary?.steps ?? null;
    const rhrVals = (heartWeek?.["activities-heart"] ?? []).map(d => d.value?.restingHeartRate).filter(Boolean);
    const hrvVals = (hrvWeek?.hrv ?? []).map(d => d.value?.dailyRmssd).filter(Boolean);
    const rolling7 = {
      rhr: rhrVals.length ? Math.round(rhrVals.reduce((a,b) => a+b,0) / rhrVals.length) : null,
      hrv: hrvVals.length ? +(hrvVals.reduce((a,b) => a+b,0) / hrvVals.length).toFixed(1) : null,
    };

    res.json({
      success: true,
      date: today,
      data: { sleep: { hours: sleepHours ? +sleepHours.toFixed(2) : null, efficiency: sleepEfficiency, minutesAwake, stages: sleepStages }, rhr, hrv, prevZones, steps, rolling7 },
    });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({ status: "ApexCoach backend running", time: new Date().toISOString() });
});

app.post("/api/set-tokens", (req, res) => {
  const { access_token, refresh_token, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });
  saveTokens({ access_token, refresh_token, expires_at: Date.now() + (28800 * 1000) });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`ApexCoach backend running on port ${PORT}`);
  const existing = loadTokens();
  if (!existing.refresh_token && process.env.FITBIT_REFRESH_TOKEN) {
    saveTokens({ access_token: process.env.FITBIT_ACCESS_TOKEN || "", refresh_token: process.env.FITBIT_REFRESH_TOKEN, expires_at: 0 });
  }
});
