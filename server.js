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

// ── TOKEN STORAGE ──────────────────────────────────────────────────────────
function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch (e) {}
  return { access_token: process.env.FITBIT_ACCESS_TOKEN || "", refresh_token: process.env.FITBIT_REFRESH_TOKEN || "", expires_at: 0 };
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
  const next = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in * 1000) - 60000 };
  saveTokens(next);
  return next.access_token;
}

async function getValidToken() {
  const tokens = loadTokens();
  if (tokens.access_token && Date.now() < tokens.expires_at) return tokens.access_token;
  return await refreshAccessToken();
}

async function fitGet(endpoint, token) {
  const res = await fetch(`https://api.fitbit.com${endpoint}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Fitbit ${res.status} for ${endpoint}`);
  return res.json();
}

function dateStr(offsetDays = 0) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

// ── OAUTH ──────────────────────────────────────────────────────────────────
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
    saveTokens({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in * 1000) - 60000 });
    res.redirect("/");
  } catch (err) { res.status(500).send(err.message); }
});

// ── FITBIT DATA API ────────────────────────────────────────────────────────
app.get("/api/daily", async (req, res) => {
  try {
    const token = await getValidToken();
    const today = dateStr(0), yesterday = dateStr(-1), weekAgo = dateStr(-7);
    const [sleep, heartToday, heartYest, hrvToday, actYest, hrvWeek, heartWeek] = await Promise.all([
      fitGet(`/1.2/user/-/sleep/date/${today}.json`, token),
      fitGet(`/1/user/-/activities/heart/date/${today}/1d.json`, token),
      fitGet(`/1/user/-/activities/heart/date/${yesterday}/1d.json`, token),
      fitGet(`/1/user/-/hrv/date/${today}.json`, token),
      fitGet(`/1/user/-/activities/date/${yesterday}.json`, token),
      fitGet(`/1/user/-/hrv/date/${weekAgo}/${today}.json`, token).catch(() => ({ hrv: [] })),
      fitGet(`/1/user/-/activities/heart/date/${weekAgo}/${today}.json`, token).catch(() => ({ "activities-heart": [] })),
    ]);
    const sleepRecord = sleep?.sleep?.find(s => s.isMainSleep) ?? sleep?.sleep?.[0];
    const zones = heartYest?.["activities-heart"]?.[0]?.value?.heartRateZones ?? [];
    const rhrVals = (heartWeek?.["activities-heart"] ?? []).map(d => d.value?.restingHeartRate).filter(Boolean);
    const hrvVals = (hrvWeek?.hrv ?? []).map(d => d.value?.dailyRmssd).filter(Boolean);
    res.json({
      success: true, date: today,
      data: {
        sleep: { hours: sleepRecord ? +(sleepRecord.minutesAsleep/60).toFixed(2) : null, efficiency: sleepRecord?.efficiency ?? null, minutesAwake: sleepRecord?.minutesAwake ?? null, stages: sleepRecord?.levels?.summary ?? null },
        rhr: heartToday?.["activities-heart"]?.[0]?.value?.restingHeartRate ?? null,
        hrv: hrvToday?.hrv?.[0]?.value?.dailyRmssd ?? null,
        prevZones: { peak: zones.find(z=>z.name==="Peak")?.minutes??0, cardio: zones.find(z=>z.name==="Cardio")?.minutes??0, fatBurn: zones.find(z=>z.name==="Fat Burn")?.minutes??0 },
        steps: actYest?.summary?.steps ?? null,
        rolling7: { rhr: rhrVals.length ? Math.round(rhrVals.reduce((a,b)=>a+b,0)/rhrVals.length) : null, hrv: hrvVals.length ? +(hrvVals.reduce((a,b)=>a+b,0)/hrvVals.length).toFixed(1) : null },
      },
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post("/api/set-tokens", (req, res) => {
  const { access_token, refresh_token, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });
  saveTokens({ access_token, refresh_token, expires_at: Date.now() + (28800 * 1000) });
  res.json({ success: true });
});

// ── SERVE FRONTEND APP ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ApexCoach</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&family=DM+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#080a0f;color:#e0e0e0;font-family:'DM Sans',sans-serif;min-height:100vh}
  @keyframes pulse{0%,100%{opacity:.2}50%{opacity:1}}
  @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  .mono{font-family:'IBM Plex Mono',monospace}
  .oswald{font-family:'Oswald',sans-serif}
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
  .errBox{background:#e8454510;border:1px solid #e8454525;color:#e88;padding:12px 16px;border-radius:8px;font-size:13px}
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px}
  .modal{background:#0d0f16;border:1px solid #141618;border-radius:14px;padding:24px;width:100%;max-width:400px}
  select,textarea,input[type=text]{width:100%;background:#060810;border:1px solid #0e1016;color:#e0e0e0;padding:10px 12px;border-radius:6px;font-size:14px;margin-bottom:10px;outline:none;font-family:'DM Sans',sans-serif}
  select option{background:#0d0f16;color:#e0e0e0}
  .btnPri{background:#22c97a;color:#040605;border:none;padding:12px 22px;font-size:13px;font-weight:700;cursor:pointer;border-radius:6px}
  .btnSec{background:transparent;color:#555;border:1px solid #1a1c22;padding:12px 22px;font-size:13px;cursor:pointer;border-radius:6px}
  .weekGrid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
  .dayCard{background:#080a0f;border:1px solid #0a0c10;border-radius:10px;padding:10px 4px;text-align:center}
  .dayCard.today{background:#0e1018;border-color:#1a1c22}
  .dayCard.done{border-color:#22c97a33}
  .statsGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  input[type=checkbox]{accent-color:#22c97a;width:14px;height:14px;cursor:pointer}
</style>
</head>
<body>

<header>
  <div style="display:flex;align-items:baseline">
    <span class="logo">APEX</span><span class="logosub">COACH</span>
  </div>
  <nav>
    <button class="navBtn active" onclick="showTab('today')">today</button>
    <button class="navBtn" onclick="showTab('week')">week</button>
    <button class="navBtn" onclick="showTab('log')">log</button>
  </nav>
  <button class="syncBtn" onclick="syncFitbit()">↻ sync</button>
</header>

<main>
  <!-- TODAY TAB -->
  <div id="tab-today" class="tab active stack">
    <div>
      <div class="oswald" style="font-size:30px;font-weight:600;letter-spacing:1px;color:#fff" id="dow"></div>
      <div class="mono" style="font-size:11px;color:#444;letter-spacing:2px" id="dom"></div>
    </div>
    <div id="status-box" class="card" style="border-color:#22c97a22">
      <p class="mono" style="font-size:11px;color:#22c97a;letter-spacing:3px;animation:pulse 1.6s infinite">FETCHING FITBIT DATA...</p>
    </div>
    <div id="readiness-card" class="card" style="display:none"></div>
    <div id="ai-card" class="card" style="display:none">
      <p class="clabel">ai recommendation</p>
      <div id="ai-content"><p class="mono" style="font-size:11px;color:#22c97a;letter-spacing:3px;animation:pulse 1.6s infinite">ANALYZING YOUR DATA...</p></div>
    </div>
    <div id="log-area"></div>
  </div>

  <!-- WEEK TAB -->
  <div id="tab-week" class="tab stack">
    <div class="statsGrid" id="week-stats"></div>
    <div id="double-skip-warn" style="display:none;background:#f5a62310;border:1px solid #f5a62325;color:#f5a623;padding:10px 14px;border-radius:6px;font-size:13px">
      ⚡ Two misses in a row — today is non-negotiable. Even 15 min counts.
    </div>
    <div class="weekGrid" id="week-grid"></div>
    <div class="card" id="week-breakdown"></div>
  </div>

  <!-- LOG TAB -->
  <div id="tab-log" class="tab stack">
    <p class="mono" style="font-size:9px;color:#333;letter-spacing:3px" id="log-count">HISTORY — 0 SESSIONS</p>
    <div id="log-entries"></div>
  </div>
</main>

<!-- LOG MODAL -->
<div class="overlay" id="log-modal" style="display:none" onclick="closeModal()">
  <div class="modal" onclick="event.stopPropagation()">
    <p class="mono" style="font-size:10px;color:#555;letter-spacing:3px;margin-bottom:14px">LOG TODAY'S WORKOUT</p>
    <select id="wtype">
      <option value="">Choose type...</option>
      <option>MMA / Sparring</option><option>Strength – Upper</option><option>Strength – Lower</option>
      <option>Strength – Full Body</option><option>Conditioning / HIIT</option><option>Yoga / Mobility</option>
      <option>Active Recovery</option><option>Walking</option><option>Rest Day</option>
    </select>
    <textarea id="wnotes" rows="3" placeholder="Notes (optional)..."></textarea>
    <div style="display:flex;gap:20px;margin-bottom:16px">
      <label style="display:flex;align-items:center;cursor:pointer"><input type="checkbox" id="wdone" checked><span style="margin-left:6px;font-size:13px;color:#888">Completed</span></label>
      <label style="display:flex;align-items:center;cursor:pointer"><input type="checkbox" id="wmob"><span style="margin-left:6px;font-size:13px;color:#888">Mobility done</span></label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btnSec" onclick="closeModal()">Cancel</button>
      <button class="btnPri" onclick="saveWorkout()">Save</button>
    </div>
  </div>
</div>

<script>
// ── STATE ──────────────────────────────────────────────────────────────────
let fitData   = null;
let readiness = null;
let aiRec     = null;
let workoutLog = JSON.parse(localStorage.getItem('ac_log') || '[]');

const TIERS = {
  hard:     { label:'HARD TRAINING',  color:'#22c97a', range:'86–100' },
  moderate: { label:'MODERATE',       color:'#f5a623', range:'66–85'  },
  light:    { label:'LIGHT TRAINING', color:'#f07020', range:'46–65'  },
  recovery: { label:'RECOVERY ONLY',  color:'#e84545', range:'0–45'   },
};

// ── INIT ───────────────────────────────────────────────────────────────────
function ds(offset=0){const d=new Date();d.setDate(d.getDate()+offset);return d.toISOString().split('T')[0];}

document.getElementById('dow').textContent = new Date().toLocaleDateString('en-US',{weekday:'long'});
document.getElementById('dom').textContent = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric'});

renderWeek();
renderLog();
syncFitbit();

// ── FITBIT SYNC ────────────────────────────────────────────────────────────
async function syncFitbit() {
  document.getElementById('status-box').style.display = 'block';
  document.getElementById('status-box').innerHTML = '<p class="mono" style="font-size:11px;color:#22c97a;letter-spacing:3px;animation:pulse 1.6s infinite">FETCHING FITBIT DATA...</p>';

  // Check cache
  const cached = localStorage.getItem('ac_cache');
  if (cached) {
    const c = JSON.parse(cached);
    if (c.date === ds(0)) {
      fitData = c.fitData;
      readiness = computeReadiness(fitData);
      renderReadiness();
      document.getElementById('status-box').style.display = 'none';
      if (c.aiRec) { aiRec = c.aiRec; renderAI(); }
      else fetchAI();
      return;
    }
  }

  try {
    const res  = await fetch('/api/daily');
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    fitData   = json.data;
    readiness = computeReadiness(fitData);
    localStorage.setItem('ac_cache', JSON.stringify({ date: ds(0), fitData }));
    renderReadiness();
    document.getElementById('status-box').style.display = 'none';
    fetchAI();
  } catch(e) {
    document.getElementById('status-box').innerHTML = '<p style="color:#e87;font-size:13px">⚠ ' + e.message + ' — <button onclick="syncFitbit()" style="background:transparent;border:1px solid #333;color:#666;padding:4px 10px;cursor:pointer;border-radius:4px;font-size:11px;margin-top:8px">Retry</button></p>';
  }
}

// ── READINESS ──────────────────────────────────────────────────────────────
function computeReadiness(d) {
  const hours = d.sleep?.hours ?? 7;
  const eff   = d.sleep?.efficiency ?? 85;
  const sq    = Math.max(0, (eff/100)*25);
  const sc    = Math.min(25, 25*Math.pow(Math.min(hours,8)/8, 4));
  const baseRHR = d.rolling7?.rhr ?? d.rhr ?? 60;
  const baseHRV = d.rolling7?.hrv ?? d.hrv ?? 40;
  const rhrPts  = Math.max(0, Math.min(15, 15-(((d.rhr??baseRHR)-baseRHR)*1.5)));
  const hrvPts  = Math.max(0, Math.min(15, 15+(((d.hrv??baseHRV)-baseHRV)*0.4)));
  const ns      = rhrPts + hrvPts;
  const rec     = Math.max(0, 20-((d.prevZones?.peak??0)*1.5+(d.prevZones?.cardio??0)*0.8+(d.prevZones?.fatBurn??0)*0.2));
  let total     = sq+sc+ns+rec;
  if(hours<4) total=Math.min(total,40);
  else if(hours<5) total=Math.min(total,60);
  else if(hours<6) total=Math.min(total,80);
  const score = Math.round(Math.max(0,Math.min(100,total)));
  const tier  = score>=86?'hard':score>=66?'moderate':score>=46?'light':'recovery';
  return { score, tier, hours, breakdown:{ sleepQuality:Math.round(sq), sleepCliff:Math.round(sc), nervousSystem:Math.round(ns), recovery:Math.round(rec) }};
}

function renderReadiness() {
  const t = TIERS[readiness.tier];
  const card = document.getElementById('readiness-card');
  card.style.display = 'block';
  card.style.borderColor = t.color+'44';
  card.innerHTML = \`
    <p class="clabel">readiness score</p>
    <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:10px">
      <span class="oswald" style="font-size:76px;font-weight:700;line-height:1;color:\${t.color}">\${readiness.score}</span>
      <span style="color:#2a2c30;font-size:22px">/100</span>
    </div>
    <div style="display:inline-block;border:1px solid \${t.color}44;background:\${t.color}15;color:\${t.color};padding:3px 12px;border-radius:4px;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:3px;margin-bottom:18px">
      \${t.label} · \${t.range}
    </div>
    \${[['Sleep Quality',readiness.breakdown.sleepQuality,25],['Sleep Cliff',readiness.breakdown.sleepCliff,25],['Nervous System',readiness.breakdown.nervousSystem,30],['Recovery',readiness.breakdown.recovery,20]].map(([l,v,m])=>\`
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px">
      <span class="mono" style="font-size:9px;color:#444;width:110px;flex-shrink:0">\${l}</span>
      <div class="bar-track"><div class="bar-fill" style="width:\${(v/m)*100}%;background:\${t.color}"></div></div>
      <span class="mono" style="font-size:9px;color:#333;width:34px;text-align:right">\${v}/\${m}</span>
    </div>\`).join('')}
    <div style="display:flex;gap:16px;margin-top:14px;padding-top:14px;border-top:1px solid #0e1016;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#444;flex-wrap:wrap">
      <span>💤 \${fitData.sleep?.hours?.toFixed(1)}h · \${fitData.sleep?.efficiency}%</span>
      \${fitData.rhr?'<span>♥ '+fitData.rhr+'bpm</span>':''}
      \${fitData.hrv?'<span>~ HRV '+Math.round(fitData.hrv)+'</span>':''}
      \${fitData.steps?'<span>⊙ '+fitData.steps.toLocaleString()+' steps</span>':''}
    </div>
  \`;
  renderLogArea();
}

// ── AI ─────────────────────────────────────────────────────────────────────
async function fetchAI() {
  document.getElementById('ai-card').style.display = 'block';
  document.getElementById('ai-content').innerHTML = '<p class="mono" style="font-size:11px;color:#22c97a;letter-spacing:3px;animation:pulse 1.6s infinite">ANALYZING YOUR DATA...</p><p class="mono" style="font-size:10px;color:#333;letter-spacing:1px;margin-top:8px">cross-referencing sleep, hrv, training history</p>';

  const recent = workoutLog.slice(-7).map(w=>\`- \${w.date}: \${w.type}\${w.done?' ✓':' ✗'}\${w.mobility?' + Mobility':''}\${w.notes?' ('+w.notes+')':''}\`).join('\\n')||'No recent workouts logged yet.';
  const todayLabel = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});

  const prompt = \`You are an elite combat sports coach AI for Shimmy. Give a specific data-driven workout recommendation.

TODAY: \${todayLabel}
READINESS: \${readiness.score}/100 — \${readiness.tier.toUpperCase()}
BREAKDOWN: Sleep Quality \${readiness.breakdown.sleepQuality}/25, Sleep Cliff \${readiness.breakdown.sleepCliff}/25 (\${readiness.hours.toFixed(1)}h), Nervous System \${readiness.breakdown.nervousSystem}/30, Recovery \${readiness.breakdown.recovery}/20

LIVE FITBIT DATA:
- Sleep: \${fitData.sleep?.hours?.toFixed(1)}h, \${fitData.sleep?.efficiency}% efficiency, \${fitData.sleep?.minutesAwake}min awake
- Deep: \${fitData.sleep?.stages?.deep?.minutes}min (avg \${fitData.sleep?.stages?.deep?.thirtyDayAvgMinutes}), REM: \${fitData.sleep?.stages?.rem?.minutes}min (avg \${fitData.sleep?.stages?.rem?.thirtyDayAvgMinutes})
- RHR: \${fitData.rhr}bpm (7d avg \${fitData.rolling7?.rhr}), HRV: \${fitData.hrv} (7d avg \${fitData.rolling7?.hrv})
- Yesterday zones — Peak: \${fitData.prevZones?.peak}min, Cardio: \${fitData.prevZones?.cardio}min, Fat Burn: \${fitData.prevZones?.fatBurn}min
- Steps yesterday: \${fitData.steps?.toLocaleString()}

RECENT 7-DAY LOG:
\${recent}

ATHLETE PROFILE — SHIMMY:
- Primary: MMA / combat sports
- Goals: strength, stamina, fixing chronic hip/quad/groin tightness
- Rule: never miss twice, minimum viable option always available (10-15 min counts)
- Phase: building consistency (3-4x/week)
- Weekly framework: Lower+Core / Conditioning+MMA / Upper / Mobility / Full Body / Conditioning / Rest

Respond ONLY with raw JSON:
{"headline":"6-8 word punchy recommendation","workout":"specific workout name","duration":45,"intensity":"concise descriptor","reasoning":"2-3 sentences referencing today's specific numbers and recent pattern","exercises":["exercise + sets/reps","exercise + sets/reps","exercise + sets/reps","exercise + sets/reps","exercise + sets/reps"],"mobility":"one specific hip/groin/quad focus","minimum_viable":"if energy tanks, do this instead","warning":"one caution or null"}\`;

  try {
    const res  = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:1000, messages:[{role:'user',content:prompt}] })
    });
    const data = await res.json();
    const raw  = data.content?.[0]?.text ?? '{}';
    aiRec = JSON.parse(raw.replace(/\`\`\`json|\`\`\`/g,'').trim());
    const cached = JSON.parse(localStorage.getItem('ac_cache')||'{}');
    cached.aiRec = aiRec;
    localStorage.setItem('ac_cache', JSON.stringify(cached));
    renderAI();
  } catch(e) {
    document.getElementById('ai-content').innerHTML = '<p style="color:#e87;font-size:13px">AI error — <button onclick="fetchAI()" style="background:transparent;border:1px solid #333;color:#666;padding:4px 10px;cursor:pointer;border-radius:4px;font-size:11px">Retry</button></p>';
  }
}

function renderAI() {
  if (!aiRec) return;
  const t = TIERS[readiness.tier];
  document.getElementById('ai-card').style.display = 'block';
  document.getElementById('ai-content').innerHTML = \`
    <div class="oswald" style="font-size:22px;font-weight:600;letter-spacing:.5px;color:#fff;margin-bottom:3px">\${aiRec.headline}</div>
    <div class="mono" style="font-size:11px;color:#22c97a;margin-bottom:14px;letter-spacing:.5px">\${aiRec.workout} · \${aiRec.duration}min · \${aiRec.intensity}</div>
    <p style="font-size:14px;color:#888;line-height:1.75;margin-bottom:14px">\${aiRec.reasoning}</p>
    \${aiRec.warning?'<div style="background:#e8454512;border:1px solid #e8454528;color:#e87;padding:8px 12px;border-radius:6px;font-size:12px;margin-bottom:14px">⚠ '+aiRec.warning+'</div>':''}
    <div style="background:#060810;border-radius:8px;padding:14px;margin-bottom:14px">
      <p class="mono" style="font-size:9px;color:#2a2c30;letter-spacing:3px;margin-bottom:10px">TODAY'S PLAN</p>
      \${(aiRec.exercises||[]).map((ex,i)=>\`<div style="display:flex;gap:12px;padding:7px 0;border-bottom:1px solid #0a0c12;font-size:13px;align-items:flex-start"><span class="mono" style="font-size:9px;color:#1e2028;width:20px;flex-shrink:0;padding-top:2px">\${String(i+1).padStart(2,'0')}</span><span style="color:#ccc;line-height:1.5">\${ex}</span></div>\`).join('')}
    </div>
    \${aiRec.mobility?'<p style="font-size:13px;color:#4488bb;margin-bottom:12px;font-style:italic">🧘 '+aiRec.mobility+'</p>':''}
    \${aiRec.minimum_viable?'<div style="background:#f5a62310;border:1px solid #f5a62322;padding:10px 14px;border-radius:6px"><p class="mono" style="font-size:9px;color:#f5a623;letter-spacing:2px;margin-bottom:6px">MINIMUM VIABLE</p><p style="font-size:13px;color:#c8a060;line-height:1.65">'+aiRec.minimum_viable+'</p></div>':''}
  \`;
}

// ── LOG AREA ───────────────────────────────────────────────────────────────
function renderLogArea() {
  const todayEntry = workoutLog.find(w => w.date === ds(0));
  const el = document.getElementById('log-area');
  if (todayEntry) {
    el.innerHTML = '<div class="loggedPill">✓ logged: '+todayEntry.type+(todayEntry.mobility?' + mobility':'')+'</div>';
  } else {
    el.innerHTML = '<button class="logBtn" onclick="openModal()">+ log today\'s workout</button>';
  }
}

// ── MODAL ──────────────────────────────────────────────────────────────────
function openModal(){document.getElementById('log-modal').style.display='flex';}
function closeModal(){document.getElementById('log-modal').style.display='none';}
function saveWorkout(){
  const type = document.getElementById('wtype').value;
  if(!type) return;
  const entry = { date:ds(0), type, notes:document.getElementById('wnotes').value, done:document.getElementById('wdone').checked, mobility:document.getElementById('wmob').checked, ts:Date.now() };
  workoutLog.push(entry);
  localStorage.setItem('ac_log', JSON.stringify(workoutLog));
  closeModal();
  document.getElementById('wtype').value='';
  document.getElementById('wnotes').value='';
  document.getElementById('wdone').checked=true;
  document.getElementById('wmob').checked=false;
  renderLogArea();
  renderWeek();
  renderLog();
  if(readiness) fetchAI();
}

// ── WEEK TAB ───────────────────────────────────────────────────────────────
function renderWeek(){
  const days = Array.from({length:7},(_,i)=>{
    const d=new Date(); d.setDate(d.getDate()-(6-i));
    const str=d.toISOString().split('T')[0];
    const entry=workoutLog.find(w=>w.date===str);
    return{str,dow:d.toLocaleDateString('en-US',{weekday:'short'}),dom:d.getDate(),entry,today:i===6};
  });
  const done=days.filter(d=>d.entry?.done).length;
  const mob=days.filter(d=>d.entry?.mobility).length;
  const pct=Math.round((done/7)*100);
  const color=pct>=57?'#22c97a':pct>=43?'#f5a623':'#e84545';

  document.getElementById('week-stats').innerHTML=[
    [done,'workouts'],[mob,'mobility'],[pct+'%','consistency']
  ].map(([v,l])=>\`<div class="card" style="text-align:center;padding:14px"><div class="oswald" style="font-size:34px;font-weight:700;color:\${color}">\${v}</div><div class="mono" style="font-size:9px;color:#444;letter-spacing:2px;margin-top:4px">\${l.toUpperCase()}</div></div>\`).join('');

  const doubleSkip=days.slice(-2).every(d=>!d.entry?.done);
  document.getElementById('double-skip-warn').style.display=doubleSkip?'block':'none';

  document.getElementById('week-grid').innerHTML=days.map(d=>\`
    <div class="dayCard \${d.today?'today':''} \${d.entry?.done?'done':''}">
      <div class="mono" style="font-size:9px;color:#333;margin-bottom:3px">\${d.dow}</div>
      <div class="oswald" style="font-size:19px;color:\${d.today?'#fff':'#555'};margin-bottom:3px">\${d.dom}</div>
      \${d.entry?\`<div style="font-size:8px;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:2px">\${d.entry.type.split(/[– ]/)[0]}</div><div style="font-size:11px">\${d.entry.done?'<span style="color:#22c97a">✓</span>':'<span style="color:#e84545">✗</span>'}\${d.entry.mobility?'<span style="font-size:9px"> 🧘</span>':''}</div>\`:'<div style="color:#111;font-size:14px">—</div>'}
    </div>\`).join('');

  const types=workoutLog.filter(w=>{const d=new Date(w.date),s=new Date();s.setDate(s.getDate()-6);return d>=s;}).reduce((acc,w)=>{const c=w.type.split('–')[0].trim();acc[c]=(acc[c]||0)+1;return acc;},{});
  const entries=Object.entries(types);
  document.getElementById('week-breakdown').innerHTML='<p class="clabel">this week</p>'+(entries.length?entries.map(([t,n])=>\`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #0a0c10;font-size:13px;color:#999"><span>\${t}</span><span class="mono" style="font-size:11px;color:#22c97a">\${n}×</span></div>\`).join(''):'<p style="color:#2a2c30;font-size:13px;font-style:italic">No sessions logged.</p>');
}

// ── LOG TAB ────────────────────────────────────────────────────────────────
function renderLog(){
  const sorted=[...workoutLog].reverse().slice(0,60);
  document.getElementById('log-count').textContent='HISTORY — '+workoutLog.length+' SESSIONS';
  document.getElementById('log-entries').innerHTML=sorted.length?sorted.map(w=>\`
    <div class="card" style="padding:12px 16px;margin-bottom:10px">
      <div class="mono" style="font-size:10px;color:#333;margin-bottom:4px">\${w.date}</div>
      <div style="font-weight:500;font-size:15px;margin-bottom:4px;color:#ddd">\${w.type}</div>
      <div class="mono" style="font-size:11px">\${w.done?'<span style="color:#22c97a">✓ completed</span>':'<span style="color:#e84545">✗ skipped</span>'}\${w.mobility?'<span style="color:#4488bb"> · mobility ✓</span>':''}</div>
      \${w.notes?'<p style="font-size:12px;color:#333;margin-top:5px;font-style:italic">'+w.notes+'</p>':''}
    </div>\`).join(''):'<p style="color:#2a2c30;font-style:italic;text-align:center;padding:40px 0;font-size:14px">No sessions yet. Start with today!</p>';
}

// ── TAB SWITCHING ──────────────────────────────────────────────────────────
function showTab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.navBtn').forEach(b=>b.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  event.target.classList.add('active');
}
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`ApexCoach backend running on port ${PORT}`);
  const existing = loadTokens();
  if (!existing.refresh_token && process.env.FITBIT_REFRESH_TOKEN) {
    saveTokens({ access_token: process.env.FITBIT_ACCESS_TOKEN || "", refresh_token: process.env.FITBIT_REFRESH_TOKEN, expires_at: 0 });
  }
});
