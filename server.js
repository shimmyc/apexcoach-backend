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

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});
app.use(express.json());

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
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res   = await fetch("https://api.fitbit.com/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${tokens.refresh_token}`,
  });
  if (!res.ok) throw new Error(`Refresh failed: ${await res.text()}`);
  const data = await res.json();
  const next = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + (data.expires_in * 1000) - 60000,
  };
  saveTokens(next);
  console.log("NEW_REFRESH_TOKEN=" + data.refresh_token);
  return next.access_token;
}

async function getValidToken() {
  const tokens = loadTokens();
  if (tokens.access_token && Date.now() < tokens.expires_at) return tokens.access_token;
  return await refreshAccessToken();
}

async function fitGet(endpoint, token) {
  const res = await fetch(`https://api.fitbit.com${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Fitbit ${res.status} for ${endpoint}`);
  return res.json();
}

function dateStr(offsetDays) {
  offsetDays = offsetDays || 0;
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

app.get("/auth", (req, res) => {
  const url = `https://www.fitbit.com/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent("sleep heartrate activity profile")}`;
  res.redirect(url);
});

app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No code.");
  try {
    const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const resp  = await fetch("https://api.fitbit.com/oauth2/token", {
      method: "POST",
      headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    });
    if (!resp.ok) return res.status(400).send(`Failed: ${await resp.text()}`);
    const data = await resp.json();
    saveTokens({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Date.now() + (data.expires_in * 1000) - 60000,
    });
    console.log("NEW_REFRESH_TOKEN=" + data.refresh_token);
    res.send(`
      <html>
      <body style="font-family:monospace;background:#080a0f;color:#e0e0e0;padding:40px;max-width:600px;margin:0 auto">
        <h2 style="color:#22c97a;margin-bottom:20px">ApexCoach Connected!</h2>
        <p style="color:#888;margin-bottom:20px">Copy the refresh token below and save it in Render as FITBIT_REFRESH_TOKEN — you only need to do this once.</p>
        <p style="color:#555;font-size:12px;margin-bottom:8px">REFRESH TOKEN:</p>
        <div style="background:#0d0f16;border:1px solid #22c97a33;padding:14px;border-radius:8px;word-break:break-all;color:#22c97a;font-size:13px;margin-bottom:20px">
          ${data.refresh_token}
        </div>
        <p style="color:#555;font-size:12px">Steps:</p>
        <ol style="color:#888;font-size:13px;line-height:2.2;padding-left:20px">
          <li>Copy the token above</li>
          <li>Go to Render dashboard</li>
          <li>Environment variables</li>
          <li>Set FITBIT_REFRESH_TOKEN to this value</li>
          <li>Save and redeploy</li>
          <li>Visit apexcoach-backend.onrender.com</li>
        </ol>
      </body>
      </html>
    `);
  } catch (err) { res.status(500).send(err.message); }
});

app.get("/api/daily", async (req, res) => {
  try {
    const token     = await getValidToken();
    const today     = dateStr(0);
    const yesterday = dateStr(-1);
    const weekAgo   = dateStr(-7);

    const [sleep, heartToday, heartYest, hrvToday, actYest, hrvWeek, heartWeek] = await Promise.all([
      fitGet(`/1.2/user/-/sleep/date/${today}.json`, token),
      fitGet(`/1/user/-/activities/heart/date/${today}/1d.json`, token),
      fitGet(`/1/user/-/activities/heart/date/${yesterday}/1d.json`, token),
      fitGet(`/1/user/-/hrv/date/${today}.json`, token),
      fitGet(`/1/user/-/activities/date/${yesterday}.json`, token),
      fitGet(`/1/user/-/hrv/date/${weekAgo}/${today}.json`, token).catch(() => ({ hrv: [] })),
      fitGet(`/1/user/-/activities/heart/date/${weekAgo}/${today}.json`, token).catch(() => ({ "activities-heart": [] })),
    ]);

    const sleepRecord = sleep && sleep.sleep ? (sleep.sleep.find(s => s.isMainSleep) || sleep.sleep[0]) : null;
    const zones       = (heartYest && heartYest["activities-heart"] && heartYest["activities-heart"][0]) ? heartYest["activities-heart"][0].value.heartRateZones : [];
    const rhrVals     = (heartWeek["activities-heart"] || []).map(d => d.value && d.value.restingHeartRate).filter(Boolean);
    const hrvVals     = (hrvWeek.hrv || []).map(d => d.value && d.value.dailyRmssd).filter(Boolean);

    res.json({
      success: true,
      date:    today,
      data: {
        sleep: {
          hours:        sleepRecord ? +(sleepRecord.minutesAsleep / 60).toFixed(2) : null,
          efficiency:   sleepRecord ? sleepRecord.efficiency : null,
          minutesAwake: sleepRecord ? sleepRecord.minutesAwake : null,
          stages:       sleepRecord && sleepRecord.levels ? sleepRecord.levels.summary : null,
        },
        rhr:  (heartToday["activities-heart"] && heartToday["activities-heart"][0]) ? heartToday["activities-heart"][0].value.restingHeartRate : null,
        hrv:  (hrvToday.hrv && hrvToday.hrv[0]) ? hrvToday.hrv[0].value.dailyRmssd : null,
        prevZones: {
          peak:    (zones.find(z => z.name === "Peak")     || {}).minutes || 0,
          cardio:  (zones.find(z => z.name === "Cardio")   || {}).minutes || 0,
          fatBurn: (zones.find(z => z.name === "Fat Burn") || {}).minutes || 0,
        },
        steps:   actYest && actYest.summary ? actYest.summary.steps : null,
        rolling7: {
          rhr: rhrVals.length ? Math.round(rhrVals.reduce((a,b) => a+b, 0) / rhrVals.length) : null,
          hrv: hrvVals.length ? +(hrvVals.reduce((a,b) => a+b, 0) / hrvVals.length).toFixed(1) : null,
        },
      },
    });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/token-info", (req, res) => {
  const tokens = loadTokens();
  res.json({ refresh_token: tokens.refresh_token, expires_at: new Date(tokens.expires_at).toISOString() });
});

app.post("/api/set-tokens", (req, res) => {
  const { access_token, refresh_token, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });
  saveTokens({ access_token, refresh_token, expires_at: Date.now() + (28800 * 1000) });
  res.json({ success: true });
});

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ApexCoach</title>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&family=DM+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080a0f;color:#e0e0e0;font-family:'DM Sans',sans-serif;min-height:100vh}
@keyframes pulse{0%,100%{opacity:.2}50%{opacity:1}}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
header{display:flex;align-items:center;justify-content:space-between;padding:13px 20px;border-bottom:1px solid #0d0f14;background:#080a0f;position:sticky;top:0;z-index:10}
.logo{font-family:'Oswald',sans-serif;font-size:20px;font-weight:700;color:#22c97a;letter-spacing:2px}
.logosub{font-family:'IBM Plex Mono',monospace;font-size:10px;color:#141618;letter-spacing:3px;margin-left:4px}
nav{display:flex;gap:2px}
.navBtn{background:transparent;border:none;color:#333;padding:6px 13px;font-size:12px;cursor:pointer;letter-spacing:2px;font-family:'IBM Plex Mono',monospace;border-radius:4px;transition:all .15s}
.navBtn.active{color:#22c97a;background:#22c97a10}
.syncBtn{background:transparent;border:1px solid #0e1016;color:#333;padding:5px 10px;font-size:12px;cursor:pointer;font-family:'IBM Plex Mono',monospace;border-radius:4px}
main{max-width:620px;margin:0 auto;padding:22px 16px 80px}
.stack{display:flex;flex-direction:column;gap:14px}
.card{background:#0d0f16;border:1px solid #0e1016;border-radius:10px;padding:18px;transition:border-color .4s}
.clabel{font-family:'IBM Plex Mono',monospace;font-size:9px;color:#2a2c30;letter-spacing:3px;margin-bottom:12px}
.tab{display:none}.tab.active{display:flex;flex-direction:column;gap:14px;animation:fadeUp .35s ease}
.bar-track{flex:1;height:3px;background:#0e1016;border-radius:2px;overflow:hidden}
.bar-fill{height:100%;border-radius:2px;transition:width .9s cubic-bezier(.4,0,.2,1)}
.logBtn{background:#22c97a10;border:1px solid #22c97a25;color:#22c97a;padding:14px;font-size:11px;letter-spacing:3px;cursor:pointer;font-family:'IBM Plex Mono',monospace;border-radius:8px;width:100%}
.loggedPill{font-family:'IBM Plex Mono',monospace;font-size:11px;color:#22c97a;letter-spacing:2px;padding:13px;background:#22c97a08;border:1px solid #22c97a20;border-radius:8px;text-align:center}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px}
.modal{background:#0d0f16;border:1px solid #141618;border-radius:14px;padding:24px;width:100%;max-width:400px}
select,textarea{width:100%;background:#060810;border:1px solid #0e1016;color:#e0e0e0;padding:10px 12px;border-radius:6px;font-size:14px;margin-bottom:10px;outline:none;font-family:'DM Sans',sans-serif}
select option{background:#0d0f16;color:#e0e0e0}
.btnPri{background:#22c97a;color:#040605;border:none;padding:12px 22px;font-size:13px;font-weight:700;cursor:pointer;border-radius:6px}
.btnSec{background:transparent;color:#555;border:1px solid #1a1c22;padding:12px 22px;font-size:13px;cursor:pointer;border-radius:6px}
.weekGrid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
.statsGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
input[type=checkbox]{accent-color:#22c97a;width:14px;height:14px;cursor:pointer}
.mono{font-family:'IBM Plex Mono',monospace}
.oswald{font-family:'Oswald',sans-serif}
</style>
</head>
<body>
<header>
  <div style="display:flex;align-items:baseline">
    <span class="logo">APEX</span><span class="logosub">COACH</span>
  </div>
  <nav>
    <button class="navBtn active" onclick="showTab('today',this)">today</button>
    <button class="navBtn" onclick="showTab('week',this)">week</button>
    <button class="navBtn" onclick="showTab('log',this)">log</button>
  </nav>
  <button class="syncBtn" onclick="syncFitbit()">sync</button>
</header>
<main>
  <div id="tab-today" class="tab active stack">
    <div>
      <div class="oswald" id="dow" style="font-size:30px;font-weight:600;letter-spacing:1px;color:#fff"></div>
      <div class="mono" id="dom" style="font-size:11px;color:#444;letter-spacing:2px"></div>
    </div>
    <div id="status-box" class="card" style="border-color:#22c97a22">
      <p class="mono" style="font-size:11px;color:#22c97a;letter-spacing:3px;animation:pulse 1.6s infinite">FETCHING FITBIT DATA...</p>
    </div>
    <div id="readiness-card" class="card" style="display:none"></div>
    <div id="ai-card" class="card" style="display:none">
      <p class="clabel">ai recommendation</p>
      <div id="ai-content"></div>
    </div>
    <div id="log-area"></div>
  </div>
  <div id="tab-week" class="tab stack">
    <div class="statsGrid" id="week-stats"></div>
    <div id="double-skip-warn" style="display:none;background:#f5a62310;border:1px solid #f5a62325;color:#f5a623;padding:10px 14px;border-radius:6px;font-size:13px">
      Two misses in a row - today is non-negotiable. Even 15 min counts.
    </div>
    <div class="weekGrid" id="week-grid"></div>
    <div class="card" id="week-breakdown"></div>
  </div>
  <div id="tab-log" class="tab stack">
    <p class="mono" id="log-count" style="font-size:9px;color:#333;letter-spacing:3px">HISTORY - 0 SESSIONS</p>
    <div id="log-entries"></div>
  </div>
</main>
<div class="overlay" id="log-modal" style="display:none" onclick="closeModal()">
  <div class="modal" onclick="event.stopPropagation()">
    <p class="mono" style="font-size:10px;color:#555;letter-spacing:3px;margin-bottom:14px">LOG TODAY'S WORKOUT</p>
    <select id="wtype">
      <option value="">Choose type...</option>
      <option>MMA / Sparring</option>
      <option>Strength - Upper</option>
      <option>Strength - Lower</option>
      <option>Strength - Full Body</option>
      <option>Conditioning / HIIT</option>
      <option>Yoga / Mobility</option>
      <option>Active Recovery</option>
      <option>Walking</option>
      <option>Rest Day</option>
    </select>
    <textarea id="wnotes" rows="3" placeholder="Notes (optional)..."></textarea>
    <div style="display:flex;gap:20px;margin-bottom:16px">
      <label style="display:flex;align-items:center;cursor:pointer">
        <input type="checkbox" id="wdone" checked>
        <span style="margin-left:6px;font-size:13px;color:#888">Completed</span>
      </label>
      <label style="display:flex;align-items:center;cursor:pointer">
        <input type="checkbox" id="wmob">
        <span style="margin-left:6px;font-size:13px;color:#888">Mobility done</span>
      </label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btnSec" onclick="closeModal()">Cancel</button>
      <button class="btnPri" onclick="saveWorkout()">Save</button>
    </div>
  </div>
</div>
<script>
var fitData = null;
var readiness = null;
var aiRec = null;
var workoutLog = JSON.parse(localStorage.getItem('ac_log') || '[]');
var TIERS = {
  hard:     { label:'HARD TRAINING',  color:'#22c97a', range:'86-100' },
  moderate: { label:'MODERATE',       color:'#f5a623', range:'66-85'  },
  light:    { label:'LIGHT TRAINING', color:'#f07020', range:'46-65'  },
  recovery: { label:'RECOVERY ONLY',  color:'#e84545', range:'0-45'   }
};
document.getElementById('dow').textContent = new Date().toLocaleDateString('en-US', {weekday:'long'});
document.getElementById('dom').textContent = new Date().toLocaleDateString('en-US', {month:'long', day:'numeric'});
renderWeek();
renderLog();
syncFitbit();
function ds(offset) {
  offset = offset || 0;
  var d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split('T')[0];
}
function syncFitbit() {
  document.getElementById('status-box').style.display = 'block';
  document.getElementById('status-box').innerHTML = '<p class="mono" style="font-size:11px;color:#22c97a;letter-spacing:3px;animation:pulse 1.6s infinite">FETCHING FITBIT DATA...</p>';
  var cached = localStorage.getItem('ac_cache');
  if (cached) {
    var c = JSON.parse(cached);
    if (c.date === ds(0)) {
      fitData = c.fitData;
      readiness = computeReadiness(fitData);
      renderReadiness();
      document.getElementById('status-box').style.display = 'none';
      if (c.aiRec) { aiRec = c.aiRec; renderAI(); }
      else { fetchAI(); }
      return;
    }
  }
  fetch('/api/daily')
    .then(function(r) { return r.json(); })
    .then(function(json) {
      if (!json.success) throw new Error(json.error);
      fitData = json.data;
      readiness = computeReadiness(fitData);
      localStorage.setItem('ac_cache', JSON.stringify({ date: ds(0), fitData: fitData }));
      renderReadiness();
      document.getElementById('status-box').style.display = 'none';
      fetchAI();
    })
    .catch(function(e) {
      document.getElementById('status-box').innerHTML = '<p style="color:#e87;font-size:13px">Error: ' + e.message + '</p><br><button onclick="syncFitbit()" style="background:transparent;border:1px solid #333;color:#666;padding:4px 10px;cursor:pointer;border-radius:4px;font-size:11px;margin-top:8px">Retry</button><br><br><a href="/auth" style="color:#22c97a;font-size:11px;font-family:monospace">Re-authorize Fitbit</a>';
    });
}
function computeReadiness(d) {
  var hours = (d.sleep && d.sleep.hours) ? d.sleep.hours : 7;
  var eff   = (d.sleep && d.sleep.efficiency) ? d.sleep.efficiency : 85;
  var sq    = Math.max(0, (eff / 100) * 25);
  var sc    = Math.min(25, 25 * Math.pow(Math.min(hours, 8) / 8, 4));
  var baseRHR = (d.rolling7 && d.rolling7.rhr) ? d.rolling7.rhr : (d.rhr || 60);
  var baseHRV = (d.rolling7 && d.rolling7.hrv) ? d.rolling7.hrv : (d.hrv || 40);
  var rhrPts  = Math.max(0, Math.min(15, 15 - (((d.rhr || baseRHR) - baseRHR) * 1.5)));
  var hrvPts  = Math.max(0, Math.min(15, 15 + (((d.hrv || baseHRV) - baseHRV) * 0.4)));
  var ns      = rhrPts + hrvPts;
  var peak    = (d.prevZones && d.prevZones.peak)    ? d.prevZones.peak    : 0;
  var cardio  = (d.prevZones && d.prevZones.cardio)  ? d.prevZones.cardio  : 0;
  var fatBurn = (d.prevZones && d.prevZones.fatBurn) ? d.prevZones.fatBurn : 0;
  var rec     = Math.max(0, 20 - (peak * 1.5 + cardio * 0.8 + fatBurn * 0.2));
  var total   = sq + sc + ns + rec;
  if (hours < 4) total = Math.min(total, 40);
  else if (hours < 5) total = Math.min(total, 60);
  else if (hours < 6) total = Math.min(total, 80);
  var score = Math.round(Math.max(0, Math.min(100, total)));
  var tier  = score >= 86 ? 'hard' : score >= 66 ? 'moderate' : score >= 46 ? 'light' : 'recovery';
  return { score: score, tier: tier, hours: hours, breakdown: { sleepQuality: Math.round(sq), sleepCliff: Math.round(sc), nervousSystem: Math.round(ns), recovery: Math.round(rec) } };
}
function renderReadiness() {
  var t = TIERS[readiness.tier];
  var card = document.getElementById('readiness-card');
  card.style.display = 'block';
  card.style.borderColor = t.color + '44';
  var bars = [['Sleep Quality', readiness.breakdown.sleepQuality, 25], ['Sleep Cliff', readiness.breakdown.sleepCliff, 25], ['Nervous System', readiness.breakdown.nervousSystem, 30], ['Recovery', readiness.breakdown.recovery, 20]];
  var barsHTML = '';
  for (var i = 0; i < bars.length; i++) {
    barsHTML += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:9px"><span class="mono" style="font-size:9px;color:#444;width:110px;flex-shrink:0">' + bars[i][0] + '</span><div class="bar-track"><div class="bar-fill" style="width:' + ((bars[i][1]/bars[i][2])*100) + '%;background:' + t.color + '"></div></div><span class="mono" style="font-size:9px;color:#333;width:34px;text-align:right">' + bars[i][1] + '/' + bars[i][2] + '</span></div>';
  }
  var vitals = '';
  if (fitData.sleep && fitData.sleep.hours) vitals += '<span>sleep ' + fitData.sleep.hours.toFixed(1) + 'h</span> ';
  if (fitData.rhr)   vitals += '<span>heart ' + fitData.rhr + 'bpm</span> ';
  if (fitData.hrv)   vitals += '<span>HRV ' + Math.round(fitData.hrv) + '</span> ';
  if (fitData.steps) vitals += '<span>' + fitData.steps.toLocaleString() + ' steps</span>';
  card.innerHTML = '<p class="clabel">readiness score</p><div style="display:flex;align-items:baseline;gap:6px;margin-bottom:10px"><span class="oswald" style="font-size:76px;font-weight:700;line-height:1;color:' + t.color + '">' + readiness.score + '</span><span style="color:#2a2c30;font-size:22px">/100</span></div><div style="display:inline-block;border:1px solid ' + t.color + '44;background:' + t.color + '15;color:' + t.color + ';padding:3px 12px;border-radius:4px;font-family:IBM Plex Mono,monospace;font-size:10px;letter-spacing:3px;margin-bottom:18px">' + t.label + ' ' + t.range + '</div>' + barsHTML + '<div style="display:flex;gap:16px;margin-top:14px;padding-top:14px;border-top:1px solid #0e1016;font-family:IBM Plex Mono,monospace;font-size:11px;color:#444;flex-wrap:wrap">' + vitals + '</div>';
  document.getElementById('ai-card').style.display = 'block';
  renderLogArea();
}
function fetchAI() {
  document.getElementById('ai-content').innerHTML = '<p class="mono" style="font-size:11px;color:#22c97a;letter-spacing:3px;animation:pulse 1.6s infinite">ANALYZING YOUR DATA...</p>';
  var recent = '';
  var slice = workoutLog.slice(-7);
  for (var i = 0; i < slice.length; i++) {
    var w = slice[i];
    recent += '- ' + w.date + ': ' + w.type + (w.done ? ' done' : ' skipped') + (w.mobility ? ' + mobility' : '') + (w.notes ? ' (' + w.notes + ')' : '') + '\n';
  }
  if (!recent) recent = 'No recent workouts logged yet.';
  var today = new Date().toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric'});
  var sleep = fitData.sleep || {};
  var stages = sleep.stages || {};
  var deep = stages.deep || {};
  var rem = stages.rem || {};
  var pz = fitData.prevZones || {};
  var r7 = fitData.rolling7 || {};
  var prompt = 'You are an elite combat sports coach AI for Shimmy. Give a specific data-driven workout recommendation.\n\nTODAY: ' + today + '\nREADINESS: ' + readiness.score + '/100 - ' + readiness.tier.toUpperCase() + '\nSleep Quality: ' + readiness.breakdown.sleepQuality + '/25, Sleep Cliff: ' + readiness.breakdown.sleepCliff + '/25 (' + readiness.hours.toFixed(1) + 'h), Nervous System: ' + readiness.breakdown.nervousSystem + '/30, Recovery: ' + readiness.breakdown.recovery + '/20\n\nLIVE FITBIT DATA:\n- Sleep: ' + (sleep.hours ? sleep.hours.toFixed(1) : '?') + 'h, ' + (sleep.efficiency || '?') + '% efficiency\n- Deep: ' + (deep.minutes || '?') + 'min (avg ' + (deep.thirtyDayAvgMinutes || '?') + '), REM: ' + (rem.minutes || '?') + 'min (avg ' + (rem.thirtyDayAvgMinutes || '?') + ')\n- RHR: ' + (fitData.rhr || '?') + 'bpm (7d avg ' + (r7.rhr || '?') + '), HRV: ' + (fitData.hrv || '?') + ' (7d avg ' + (r7.hrv || '?') + ')\n- Yesterday zones - Peak: ' + (pz.peak || 0) + 'min, Cardio: ' + (pz.cardio || 0) + 'min, Fat Burn: ' + (pz.fatBurn || 0) + 'min\n- Steps yesterday: ' + (fitData.steps ? fitData.steps.toLocaleString() : '?') + '\n\nRECENT 7-DAY LOG:\n' + recent + '\nATHLETE PROFILE - SHIMMY:\n- Primary: MMA / combat sports\n- Goals: strength, stamina, fixing chronic hip/quad/groin tightness\n- Rule: never miss twice, minimum viable option always available\n- Phase: building consistency 3-4x/week\n\nRespond ONLY with raw JSON no markdown:\n{"headline":"6-8 word punchy recommendation","workout":"specific workout","duration":45,"intensity":"descriptor","reasoning":"2-3 sentences with specific numbers","exercises":["ex + sets/reps","ex + sets/reps","ex + sets/reps","ex + sets/reps","ex + sets/reps"],"mobility":"hip/groin/quad focus","minimum_viable":"fallback option","warning":"one caution or null"}';
  fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    var raw = (data.content && data.content[0]) ? data.content[0].text : '{}';
    aiRec = JSON.parse(raw.replace(/```json|```/g, '').trim());
    var cached = JSON.parse(localStorage.getItem('ac_cache') || '{}');
    cached.aiRec = aiRec;
    localStorage.setItem('ac_cache', JSON.stringify(cached));
    renderAI();
  })
  .catch(function(e) {
    document.getElementById('ai-content').innerHTML = '<p style="color:#e87;font-size:13px">AI error - <button onclick="fetchAI()" style="background:transparent;border:1px solid #333;color:#666;padding:4px 10px;cursor:pointer;border-radius:4px;font-size:11px">Retry</button></p>';
  });
}
function renderAI() {
  if (!aiRec) return;
  var exHTML = '';
  var exes = aiRec.exercises || [];
  for (var i = 0; i < exes.length; i++) {
    exHTML += '<div style="display:flex;gap:12px;padding:7px 0;border-bottom:1px solid #0a0c12;font-size:13px;align-items:flex-start"><span class="mono" style="font-size:9px;color:#1e2028;width:20px;flex-shrink:0;padding-top:2px">0' + (i+1) + '</span><span style="color:#ccc;line-height:1.5">' + exes[i] + '</span></div>';
  }
  document.getElementById('ai-content').innerHTML = '<div class="oswald" style="font-size:22px;font-weight:600;color:#fff;margin-bottom:3px">' + aiRec.headline + '</div><div class="mono" style="font-size:11px;color:#22c97a;margin-bottom:14px">' + aiRec.workout + ' - ' + aiRec.duration + 'min - ' + aiRec.intensity + '</div><p style="font-size:14px;color:#888;line-height:1.75;margin-bottom:14px">' + aiRec.reasoning + '</p>' + (aiRec.warning ? '<div style="background:#e8454512;border:1px solid #e8454528;color:#e87;padding:8px 12px;border-radius:6px;font-size:12px;margin-bottom:14px">Warning: ' + aiRec.warning + '</div>' : '') + '<div style="background:#060810;border-radius:8px;padding:14px;margin-bottom:14px"><p class="mono" style="font-size:9px;color:#2a2c30;letter-spacing:3px;margin-bottom:10px">TODAY\'S PLAN</p>' + exHTML + '</div>' + (aiRec.mobility ? '<p style="font-size:13px;color:#4488bb;margin-bottom:12px;font-style:italic">Mobility: ' + aiRec.mobility + '</p>' : '') + (aiRec.minimum_viable ? '<div style="background:#f5a62310;border:1px solid #f5a62322;padding:10px 14px;border-radius:6px"><p class="mono" style="font-size:9px;color:#f5a623;letter-spacing:2px;margin-bottom:6px">MINIMUM VIABLE</p><p style="font-size:13px;color:#c8a060;line-height:1.65">' + aiRec.minimum_viable + '</p></div>' : '');
}
function renderLogArea() {
  var todayEntry = null;
  var today = ds(0);
  for (var i = 0; i < workoutLog.length; i++) {
    if (workoutLog[i].date === today) { todayEntry = workoutLog[i]; break; }
  }
  var el = document.getElementById('log-area');
  if (todayEntry) {
    el.innerHTML = '<div class="loggedPill">done: ' + todayEntry.type + (todayEntry.mobility ? ' + mobility' : '') + '</div>';
  } else {
    el.innerHTML = '<button class="logBtn" onclick="openModal()">+ log today\'s workout</button>';
  }
}
function openModal()  { document.getElementById('log-modal').style.display = 'flex'; }
function closeModal() { document.getElementById('log-modal').style.display = 'none'; }
function saveWorkout() {
  var type = document.getElementById('wtype').value;
  if (!type) return;
  var entry = { date: ds(0), type: type, notes: document.getElementById('wnotes').value, done: document.getElementById('wdone').checked, mobility: document.getElementById('wmob').checked, ts: Date.now() };
  workoutLog.push(entry);
  localStorage.setItem('ac_log', JSON.stringify(workoutLog));
  closeModal();
  document.getElementById('wtype').value = '';
  document.getElementById('wnotes').value = '';
  document.getElementById('wdone').checked = true;
  document.getElementById('wmob').checked = false;
  renderLogArea();
  renderWeek();
  renderLog();
  if (readiness && fitData) fetchAI();
}
function renderWeek() {
  var days = [];
  for (var i = 0; i < 7; i++) {
    var d = new Date(); d.setDate(d.getDate() - (6 - i));
    var str = d.toISOString().split('T')[0];
    var entry = null;
    for (var j = 0; j < workoutLog.length; j++) { if (workoutLog[j].date === str) { entry = workoutLog[j]; break; } }
    days.push({ str: str, dow: d.toLocaleDateString('en-US',{weekday:'short'}), dom: d.getDate(), entry: entry, today: i === 6 });
  }
  var done = 0, mob = 0;
  for (var i = 0; i < days.length; i++) { if (days[i].entry && days[i].entry.done) done++; if (days[i].entry && days[i].entry.mobility) mob++; }
  var pct = Math.round((done / 7) * 100);
  var color = pct >= 57 ? '#22c97a' : pct >= 43 ? '#f5a623' : '#e84545';
  var statsHTML = '';
  var stats = [[done,'workouts'],[mob,'mobility'],[pct+'%','consistency']];
  for (var i = 0; i < stats.length; i++) { statsHTML += '<div class="card" style="text-align:center;padding:14px"><div class="oswald" style="font-size:34px;font-weight:700;color:' + color + '">' + stats[i][0] + '</div><div class="mono" style="font-size:9px;color:#444;letter-spacing:2px;margin-top:4px">' + stats[i][1].toUpperCase() + '</div></div>'; }
  document.getElementById('week-stats').innerHTML = statsHTML;
  var lastTwo = days.slice(-2);
  var doubleSkip = (!lastTwo[0].entry || !lastTwo[0].entry.done) && (!lastTwo[1].entry || !lastTwo[1].entry.done);
  document.getElementById('double-skip-warn').style.display = doubleSkip ? 'block' : 'none';
  var gridHTML = '';
  for (var i = 0; i < days.length; i++) {
    var d = days[i];
    gridHTML += '<div style="background:' + (d.today?'#0e1018':'#080a0f') + ';border:1px solid ' + (d.entry&&d.entry.done?'#22c97a33':d.today?'#1a1c22':'#0a0c10') + ';border-radius:10px;padding:10px 4px;text-align:center"><div class="mono" style="font-size:9px;color:#333;margin-bottom:3px">' + d.dow + '</div><div class="oswald" style="font-size:19px;color:' + (d.today?'#fff':'#555') + ';margin-bottom:3px">' + d.dom + '</div>';
    if (d.entry) { gridHTML += '<div style="font-size:8px;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:2px">' + d.entry.type.split(' ')[0] + '</div><div style="font-size:11px">' + (d.entry.done ? '<span style="color:#22c97a">done</span>' : '<span style="color:#e84545">skip</span>') + (d.entry.mobility ? ' M' : '') + '</div>'; }
    else { gridHTML += '<div style="color:#111;font-size:14px">-</div>'; }
    gridHTML += '</div>';
  }
  document.getElementById('week-grid').innerHTML = gridHTML;
  var cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 6);
  var types = {};
  for (var i = 0; i < workoutLog.length; i++) { var w = workoutLog[i]; if (new Date(w.date) >= cutoff) { var cat = w.type.split(' ')[0]; types[cat] = (types[cat] || 0) + 1; } }
  var entries = Object.keys(types);
  var bdHTML = '<p class="clabel">this week</p>';
  if (entries.length) { for (var i = 0; i < entries.length; i++) { bdHTML += '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #0a0c10;font-size:13px;color:#999"><span>' + entries[i] + '</span><span class="mono" style="font-size:11px;color:#22c97a">' + types[entries[i]] + 'x</span></div>'; } }
  else { bdHTML += '<p style="color:#2a2c30;font-size:13px;font-style:italic">No sessions logged.</p>'; }
  document.getElementById('week-breakdown').innerHTML = bdHTML;
}
function renderLog() {
  var sorted = workoutLog.slice().reverse().slice(0, 60);
  document.getElementById('log-count').textContent = 'HISTORY - ' + workoutLog.length + ' SESSIONS';
  if (!sorted.length) { document.getElementById('log-entries').innerHTML = '<p style="color:#2a2c30;font-style:italic;text-align:center;padding:40px 0;font-size:14px">No sessions yet.</p>'; return; }
  var html = '';
  for (var i = 0; i < sorted.length; i++) {
    var w = sorted[i];
    html += '<div class="card" style="padding:12px 16px;margin-bottom:10px"><div class="mono" style="font-size:10px;color:#333;margin-bottom:4px">' + w.date + '</div><div style="font-weight:500;font-size:15px;margin-bottom:4px;color:#ddd">' + w.type + '</div><div class="mono" style="font-size:11px">' + (w.done ? '<span style="color:#22c97a">completed</span>' : '<span style="color:#e84545">skipped</span>') + (w.mobility ? '<span style="color:#4488bb"> + mobility</span>' : '') + '</div>' + (w.notes ? '<p style="font-size:12px;color:#333;margin-top:5px;font-style:italic">' + w.notes + '</p>' : '') + '</div>';
  }
  document.getElementById('log-entries').innerHTML = html;
}
function showTab(name, btn) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.navBtn').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log("ApexCoach backend running on port " + PORT);
  const existing = loadTokens();
  if (!existing.refresh_token && process.env.FITBIT_REFRESH_TOKEN) {
    saveTokens({ access_token: process.env.FITBIT_ACCESS_TOKEN || "", refresh_token: process.env.FITBIT_REFRESH_TOKEN, expires_at: 0 });
    console.log("Initialized tokens from env.");
  }
});
