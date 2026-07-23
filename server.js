const express = require("express");
const rawFetch = require("node-fetch");
const https   = require("https");
const path    = require("path");
const crypto  = require("crypto");
const wearables = require("./wearables");

// ── ENGINE v2 (feature-flagged, profile_data.engine_v2 === true) ───────────
// v2-only modules. Nothing in the v1 path requires or calls these; they are
// reached exclusively from the /api/v2/* routes. Pure/injected-dependency
// design (they receive { fetch, SUPABASE_URL, sbHeaders, ... }) so there is no
// circular require against this file.
const v2Rules       = require("./server/coachingRules");
const v2Progression = require("./server/v2Progression");
const v2Dossier     = require("./server/v2Dossier");
const v2Planner     = require("./server/v2Planner");
const v2Readiness   = require("./server/v2Readiness");
const v2Autoregulator = require("./server/v2Autoregulator");
const v2Variant     = require("./server/v2Variant");

// Forces a fresh TCP/TLS connection — Render's node-fetch pool has a
// compatibility issue with Fitbit's token endpoint that causes Premature
// close on pooled sockets.
const fitbitTokenAgent = new https.Agent({ keepAlive: false });

// Same mitigation, applied to Anthropic streaming calls (2026-07 — daily_recs
// intermittently completed server-side (upstream body finished, res.end()
// reached) with the client never observing termination, hitting its 90s hard
// cap instead of a clean close). A pooled/reused keep-alive socket is the
// same class of Render+node-fetch issue documented above for Fitbit; this is
// a precedented, low-risk mitigation (a fresh TLS handshake per call is
// negligible next to multi-second Sonnet generation time). Not proven to be
// the root cause with certainty — see the "response FINISHED"/"response
// CLOSED" logs in pipeAnthropicStream() for confirmation if this recurs.
const anthropicStreamAgent = new https.Agent({ keepAlive: false });

// Retry wrapper for transient network flakiness ("Premature close" /
// ECONNRESET / ETIMEDOUT / EPIPE) seen intermittently against multiple
// external hosts (Supabase, Fitbit). GET-ONLY: non-GET requests can have
// side effects and must never be silently re-sent, so they pass straight
// through. Propagates from this single import point to every call site.
function isTransientFetchError(err) {
  if (!err) return false;
  const msg = String(err.message || "");
  if (msg.includes("Premature close")) return true;
  return err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "EPIPE";
}

async function fetch(url, options) {
  const method = ((options && options.method) || "GET").toUpperCase();
  if (method !== "GET") return rawFetch(url, options); // never retry side-effecting requests

  const delays = [250, 500]; // up to 2 retries after the initial attempt
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await rawFetch(url, options);
      // "Premature close" fires during BODY consumption, after fetch() has
      // already resolved — so eagerly read the full body here, inside the
      // retry loop, then hand callers a buffered Response-like object.
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        headers: res.headers,
        text: async () => text,
        json: async () => JSON.parse(text),
      };
    } catch (err) {
      lastErr = err;
      if (attempt < delays.length && isTransientFetchError(err)) {
        console.log(`[FetchRetry] ${method} ${url} failed (attempt ${attempt + 1}), retrying...`);
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      throw err; // non-transient, or out of retries — preserve original error
    }
  }
  throw lastErr;
}

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
    // Force uncompressed responses — node-fetch intermittently throws
    // "Invalid response body: Premature close" decompressing Supabase's
    // Cloudflare-fronted Brotli/gzip streams. curl from the same container
    // succeeds 100%, so this is isolated to node-fetch's decompression path.
    "Accept-Encoding": "identity",
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
    agent: fitbitTokenAgent,
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

// ── TOKEN REFRESH SERIALIZATION ───────────────────────────────────────────
// OAuth refresh tokens are single-use: Fitbit (and Google Health) rotate the
// refresh token on every successful exchange, invalidating the previous one.
// getValidProfileToken / getValidWearableToken are called from several
// endpoints that can fire concurrently on app boot (daily fetch, unmatched,
// sync-backlog, life-os-summary, …). Two callers that both see an expired
// token would each POST the SAME refresh token; whichever loses the race then
// holds a now-dead token and its save clobbers the winner's fresh one — the
// suspected cause of the 2026-07-17 Fitbit token death.
//
// This map serializes refreshes per (provider:profileId): the first caller
// starts the refresh, everyone else awaits the same in-flight promise and
// receives the same fresh access token. Non-refresh (valid-token) reads never
// touch this — only the actual refresh is serialized. In-process only, which
// is sufficient here (single Render web instance); a multi-instance deploy
// would need a DB/row lock instead.
var _refreshLocks = {};
function withRefreshLock(key, fn) {
  if (_refreshLocks[key]) return _refreshLocks[key];
  var p = Promise.resolve().then(fn);
  _refreshLocks[key] = p;
  return p.finally(function() {
    if (_refreshLocks[key] === p) delete _refreshLocks[key];
  });
}

// Best-effort write of the wearable_connections.needs_reconnect health flag.
// NEVER throws and NEVER blocks a token save: a failure (including the column
// not existing yet, before the 2026-07-17 migration is applied) is logged and
// swallowed. Set true on a definitive invalid_grant / RECONNECT_REQUIRED;
// cleared to false on any successful (re)connect or refresh.
async function setNeedsReconnect(profileId, provider, value) {
  try {
    await fetch(
      SUPABASE_URL + "/rest/v1/wearable_connections?profile_id=eq." + profileId
        + "&provider=eq." + provider,
      {
        method: "PATCH",
        headers: sbHeaders("return=minimal"),
        body: JSON.stringify({ needs_reconnect: !!value }),
      }
    );
  } catch (e) {
    console.warn("[Wearables] setNeedsReconnect(" + provider + "=" + value + ") failed (non-fatal): " + e.message);
  }
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
      // Fresh tokens just landed → this connection is healthy again. Cleared
      // separately (not folded into the upsert body) so a missing
      // needs_reconnect column can never break the token mirror itself.
      setNeedsReconnect(profileId, "fitbit", false);
    } catch (e) {
      console.warn("[Fitbit] saveProfileTokens wearable_connections mirror failed: " + e.message);
    }
  } catch (e) {
    console.error("saveProfileTokens error:", e.message);
  }
}

// Public entry — serialized per profile so concurrent callers share ONE
// refresh instead of each spending the single-use refresh token (see
// withRefreshLock). The actual work lives in _doRefreshProfileToken.
async function refreshProfileToken(profileId) {
  return withRefreshLock("fitbit:" + profileId, function() {
    return _doRefreshProfileToken(profileId);
  });
}

async function _doRefreshProfileToken(profileId) {
  const tokens = await loadProfileTokens(profileId);
  if (!tokens.refresh_token) throw new Error("No Fitbit refresh token for this profile. Please re-authorize.");
  const creds = Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");

  // This POST is excluded from the generic GET-only retry wrapper, but it IS
  // safe to retry on transient network / body-read failures ("Premature
  // close" etc.). Guard: Fitbit rotates the refresh token on every successful
  // exchange, so a non-2xx response (especially 400 invalid_grant) means the
  // original request already succeeded server-side and the token is spent —
  // stop immediately instead of retrying into a confusing invalid_grant loop.
  const delays = [250, 500]; // up to 2 retries after the initial attempt
  let data;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await rawFetch("https://api.fitbit.com/oauth2/token", {
        method: "POST",
        headers: {
          "Authorization": "Basic " + creds,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=refresh_token&refresh_token=" + tokens.refresh_token,
        agent: fitbitTokenAgent,
      });
      const text = await res.text(); // "Premature close" fires here, not on the fetch
      if (!res.ok) {
        if (res.status === 400 && /invalid_grant/i.test(text)) {
          console.error("[Fitbit] Refresh token already rotated or invalid — re-auth required");
          // Persist the health flag so the providers endpoint / UI can surface
          // "Reconnect required" instead of silently failing. Best-effort.
          setNeedsReconnect(profileId, "fitbit", true);
        }
        // Non-2xx is a server-side rejection, not a network blip — do not retry.
        throw new Error("Refresh failed: " + text);
      }
      data = JSON.parse(text);
      break;
    } catch (err) {
      if (attempt < delays.length && isTransientFetchError(err)) {
        console.log(`[FetchRetry] POST https://api.fitbit.com/oauth2/token failed (attempt ${attempt + 1}), retrying...`);
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      throw err; // invalid_grant / non-2xx / non-transient / out of retries — preserve for caller fallback
    }
  }
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
// Per-call timeout so a single slow/hung Fitbit request can never stall the
// parent endpoint into a platform 504. The AbortController actually cancels the
// in-flight fetch (unlike a bare Promise.race), freeing the socket.
const FITBIT_TIMEOUT_MS = 8000;
async function fitGet(endpoint, token, timeoutMs) {
  console.log("[Fitbit API] GET " + endpoint);
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs || FITBIT_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.fitbit.com" + endpoint, {
      headers: { "Authorization": "Bearer " + token },
      signal: controller.signal,
    });
    if (!res.ok) {
      var errBody = await res.text();
      console.error("[Fitbit API] ERROR " + res.status + " for " + endpoint + ": " + errBody.substring(0, 200));
      throw new Error("Fitbit " + res.status + " for " + endpoint);
    }
    var data = await res.json();
    console.log("[Fitbit API] OK " + endpoint + " -> keys: " + Object.keys(data).join(","));
    return data;
  } catch (e) {
    if (e && e.name === "AbortError") {
      console.error("[Fitbit API] TIMEOUT after " + (timeoutMs || FITBIT_TIMEOUT_MS) + "ms for " + endpoint);
      throw new Error("Fitbit timeout for " + endpoint);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function dateStr(offsetDays) {
  offsetDays = offsetDays || 0;
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

// Returns YYYY-MM-DD for the ATHLETE's own calendar day, in their IANA
// timezone (profiles.timezone, captured client-side via
// Intl.DateTimeFormat().resolvedOptions().timeZone on boot) — falls back to
// UTC when unset, so behavior is provably unchanged for any profile that
// hasn't captured one yet. offsetDays shifts by whole calendar days (negative
// = past), covering "today"/"yesterday"/"N days ago" with one function.
//
// This is the fix for a recurring bug class in this codebase (2026-07-15):
// dateStr() above is UTC (toISOString()); ymdLocal() and several inline
// getFullYear/getMonth/getDate IIFEs (the Google Health daily sync, the
// week-preview builder, ...) use the Node PROCESS's own OS timezone, which on
// Render is UTC too — neither has ever represented the athlete's real day.
// localToday() is the ONLY athlete-timezone-aware date helper; dateStr()/
// ymdLocal() stay as they are and remain correct for non-athlete-specific
// things (OAuth token expiry, audit timestamps, the legacy single-tenant
// /api/daily endpoint which predates the profile/timezone concept entirely).
//
// Uses Intl.DateTimeFormat (built into Node, no npm dependency) with the
// `timeZone` option, which resolves any IANA identifier correctly regardless
// of the server process's own OS timezone. en-CA formats as YYYY-MM-DD
// directly, avoiding manual field assembly.
function localToday(profile, offsetDays) {
  var tz = (profile && profile.timezone) || "UTC";
  var fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch (e) {
    console.warn("[Timezone] localToday: invalid timezone '" + tz + "' on profile " + (profile && profile.id) + ", falling back to UTC:", e && e.message);
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  var todayInTz = fmt.format(new Date());
  if (!offsetDays) return todayInTz;
  // Shift by whole calendar days from the athlete's "today", not from the
  // server's instant — parse it as a UTC-noon anchor (matches the
  // "T12:00:00" pattern already used throughout this file for safe YMD
  // arithmetic) and shift via UTC-date-math, immune to DST since we're only
  // ever moving whole calendar days, never wall-clock hours.
  var d = new Date(todayInTz + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// Minimal profile fetch for callers that only need the athlete's timezone
// (localToday()'s fallback-to-UTC-when-null makes this safe to call even for
// profiles that haven't captured one yet — the caller never needs to check).
async function getProfileTimezone(profileId) {
  var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId + "&select=id,timezone", { headers: sbHeaders() });
  var rows = await r.json();
  return (Array.isArray(rows) && rows[0]) || {};
}

// Server-side mirror of estimateSleepScore() in public/index.html — the
// personal regression sleep-score model (R²=0.883, MAE=2.45; see FORMULAS.md).
// Keep the two in sync. Returns null when there's no stage data to score.
function estimateSleepScore(deepMinutes, remMinutes, lightMinutes, awakeMinutes) {
  if (!deepMinutes && !remMinutes && !lightMinutes) return null;
  var asleepMinutes = (deepMinutes||0) + (remMinutes||0) + (lightMinutes||0);
  var durationPenalty = Math.max(0, (300 - asleepMinutes) * 0.3);
  var raw = 0.1558 * (deepMinutes||0)
          + 0.0935 * (remMinutes||0)
          + 0.0607 * (lightMinutes||0)
          - 0.1143 * (awakeMinutes||0)
          - durationPenalty
          + 49.77;
  return Math.max(1, Math.min(100, Math.round(raw)));
}

// timezone (IANA string, may be null/undefined) is threaded in by callers so
// "today" reflects the athlete's own calendar day, not the server's — see
// localToday(). Falls back to UTC when not provided, so any call site that
// hasn't been updated to pass it (the legacy single-tenant /api/daily
// endpoint, which has no profile_id to look a timezone up for) behaves
// exactly as before.
async function buildDailyData(token, overrideDate, timezone) {
  const tzProfile = { timezone: timezone };
  const today     = overrideDate || localToday(tzProfile);
  const yesterday = overrideDate ? (() => { const d = new Date(overrideDate + 'T12:00:00'); d.setDate(d.getDate() - 1); return d.toISOString().slice(0,10); })() : localToday(tzProfile, -1);
  const weekAgo   = overrideDate ? (() => { const d = new Date(overrideDate + 'T12:00:00'); d.setDate(d.getDate() - 7); return d.toISOString().slice(0,10); })() : localToday(tzProfile, -7);

  // Every Fitbit fetch is non-fatal: on any error (403/401/500/timeout) the
  // call resolves to the empty shape its consumer expects, so a single failing
  // metric degrades to null rather than rejecting the whole batch and 500ing the
  // endpoint. The extractors below already treat these empties as "no data".
  const results = await Promise.all([
    fitGet("/1.2/user/-/sleep/date/" + today + ".json", token).catch(function() { return {}; }),
    fitGet("/1/user/-/activities/heart/date/" + today + "/1d.json", token).catch(function() { return { "activities-heart": [] }; }),
    fitGet("/1/user/-/activities/heart/date/" + yesterday + "/1d.json", token).catch(function() { return { "activities-heart": [] }; }),
    fitGet("/1/user/-/hrv/date/" + today + ".json", token).catch(function() { return { hrv: [] }; }),
    fitGet("/1/user/-/activities/date/" + yesterday + ".json", token).catch(function() { return {}; }),
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

  // Computed personal sleep score — the value ApexCoach's UI shows and Life OS
  // consumes (NOT Fitbit's own score). Derived from the stage breakdown via the
  // same model as estimateSleepScore() in public/index.html.
  var sleepLevelsSummary = sleepRecord && sleepRecord.levels ? sleepRecord.levels.summary : null;
  var computedSleepScore = sleepLevelsSummary
    ? estimateSleepScore(
        sleepLevelsSummary.deep  ? sleepLevelsSummary.deep.minutes  : 0,
        sleepLevelsSummary.rem   ? sleepLevelsSummary.rem.minutes   : 0,
        sleepLevelsSummary.light ? sleepLevelsSummary.light.minutes : 0,
        sleepLevelsSummary.wake  ? sleepLevelsSummary.wake.minutes  : 0
      )
    : null;

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
        score:        computedSleepScore,
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
      // Persisted nightly to daily_sleep (see upsertDailySleep). Keyed under
      // `today` so Life OS's `date = today` fast-path lookup hits. Carries the
      // computed score (not Fitbit's) plus the morning HRV/RHR snapshot so the
      // cached path can return all three without a live Fitbit call.
      sleepSummary: (function() {
        if (!sleepRecord && hrv === null && rhr === null) return null;
        var sum = sleepLevelsSummary;
        return {
          date: today,
          hours: sleepRecord ? +(sleepRecord.minutesAsleep / 60).toFixed(2) : null,
          score: computedSleepScore,
          deep_minutes:  sum && sum.deep  ? (sum.deep.minutes  || 0) : null,
          rem_minutes:   sum && sum.rem   ? (sum.rem.minutes   || 0) : null,
          light_minutes: sum && sum.light ? (sum.light.minutes || 0) : null,
          wake_minutes:  sum && sum.wake  ? (sum.wake.minutes  || 0) : null,
          hrv: hrv,
          rhr: rhr,
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

// Empty wearable snapshot returned (HTTP 200) when no wearable data is
// available — e.g. Fitbit token refresh failed, every Fitbit call errored, or
// the live fetch timed out. Shape mirrors the success payload (all null/empty)
// so the client renders the "no biometrics" state and still generates a
// recommendation from profile + manual check-in data instead of erroring.
function emptyWearableData() {
  return {
    sleep: null,
    rhr: null,
    hrv: null,
    prevZones: { peak: 0, cardio: 0, fatBurn: 0 },
    steps: null,
    stepsSummary: null,
    todaysActivities: [],
    bodySummary: null,
    sleepSummary: null,
    rolling7: { rhr: null, hrv: null },
    rhrHistory7Day: [],
    source: "unavailable",
  };
}

// Bound any promise with a hard timeout so a hung upstream (e.g. the Google
// Health adapter, whose fetches carry no AbortController) can never stall the
// parent endpoint into a 504. The underlying work is abandoned, not cancelled —
// fitGet cancels its own socket via AbortController; for others the orphaned
// promise simply resolves later and is ignored.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(function(_, reject) {
      setTimeout(function() {
        reject(new Error((label || "operation") + " timed out after " + ms + "ms"));
      }, ms);
    }),
  ]);
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
      agent: fitbitTokenAgent,
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

// Google Health API v4 OAuth callback (additive — does NOT touch /callback).
// Exchanges the auth code for tokens, stores them in wearable_connections,
// records the Google Health user identity in provider_metadata, then redirects.
// Registered on TWO routes below: /callback/google_health and
// /api/wearables/callback/google_health (the path POST /api/wearables/connect
// generates for non-Fitbit providers). The token-exchange redirect_uri is
// derived from req.path so it matches whichever route Google redirected to —
// Google requires an exact match with the redirect_uri sent at authorize time.
// Migration: migrations/2026-05-26_google_health.sql adds provider_metadata.
async function handleGoogleHealthCallback(req, res) {
  var code = req.query.code;
  var profileId = decodeURIComponent(req.query.state || "").trim();
  console.log("[google_health] " + req.path + " received. code=" + (code ? "yes" : "no") + ", profileId='" + profileId + "'");
  if (!code || !profileId) return res.redirect("/?error=google_health_connect_failed");
  try {
    var redirectUri = (process.env.RENDER_URL || "https://apexcoach-backend.onrender.com") + req.path;
    var tokenBody = "grant_type=authorization_code"
      + "&code=" + encodeURIComponent(code)
      + "&redirect_uri=" + encodeURIComponent(redirectUri)
      + "&client_id=" + encodeURIComponent(process.env.GOOGLE_HEALTH_CLIENT_ID || "")
      + "&client_secret=" + encodeURIComponent(process.env.GOOGLE_HEALTH_CLIENT_SECRET || "");
    var resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    if (!resp.ok) {
      var errText = await resp.text();
      console.error("[google_health] token exchange failed (" + resp.status + "): " + errText.substring(0, 200));
      return res.redirect("/?error=google_health_connect_failed");
    }
    var data = await resp.json();
    var tokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in * 1000) - 60000,
    };
    // Look up the stable Google Health identity (best-effort).
    var identity = null;
    try {
      identity = await wearables.getProviderAdapter("google_health").getIdentity(tokenData.access_token);
    } catch (e) {
      console.warn("[google_health] getIdentity failed: " + e.message);
    }
    await saveWearableTokens(profileId, "google_health", tokenData);
    // Persist the identity into wearable_connections.provider_metadata (jsonb).
    if (identity) {
      try {
        await fetch(SUPABASE_URL + "/rest/v1/wearable_connections?profile_id=eq." + profileId + "&provider=eq.google_health", {
          method: "PATCH",
          headers: sbHeaders("return=minimal"),
          body: JSON.stringify({ provider_metadata: identity }),
        });
      } catch (e) {
        console.warn("[google_health] provider_metadata write failed: " + e.message);
      }
    }
    console.log("[google_health] Connected profile " + profileId + ", healthUserId: " + (identity ? identity.healthUserId : "unknown"));
    res.redirect("/");
  } catch (err) {
    console.error("[google_health] callback error: " + err.message);
    res.redirect("/?error=google_health_connect_failed");
  }
}

app.get("/callback/google_health", handleGoogleHealthCallback);
app.get("/api/wearables/callback/google_health", handleGoogleHealthCallback);

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
var PROFILE_SELECT_BASE = "id,name,avatar_color,profile_data,created_at,timezone," + PROFILE_BODY_FIELDS.join(",");

app.get("/api/profiles/:id", async function(req, res) {
  try {
    var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + req.params.id + "&select=" + PROFILE_SELECT_BASE, {
      headers: sbHeaders(),
    });
    var rows = await r.json();
    if (!rows || !rows.length) return res.json({ success: false, error: "Profile not found." });
    var p = rows[0];
    var pd = cleanProfileData(p.profile_data || {});
    // Backfill stable goal ids; persist (fire-and-forget) only if any were added.
    if (ensureGoalIds(pd)) {
      fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + req.params.id, {
        method: "PATCH",
        headers: sbHeaders("return=minimal"),
        body: JSON.stringify({ profile_data: pd }),
      }).catch(function(e) { console.error("[Goals] ensureGoalIds persist failed:", e.message); });
    }
    res.json({ success: true, profile: Object.assign({
      id: p.id, name: p.name, avatar_color: p.avatar_color,
      profile_data: pd,
      created_at: p.created_at, timezone: p.timezone || null,
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
        created_at: profile.created_at, timezone: profile.timezone || null,
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
    // Silent capture (2026-07-15): the client sends this on boot/profile load
    // when its Intl-detected timezone differs from what's stored — see
    // localToday() for why this exists. No UI; PATCH is just extended to
    // accept it like any other top-level column.
    if (Object.prototype.hasOwnProperty.call(body, "timezone")) {
      updatePayload.timezone = body.timezone || null;
    }
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
      var cleanedMerged = cleanProfileData(merged);
      ensureGoalIds(cleanedMerged); // newly added goals always get a stable id
      updatePayload.profile_data = cleanedMerged;
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
      profile_data: profile.profile_data, timezone: profile.timezone || null,
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
    // Delete all exercises for this profile (2026-07-17, ROADMAP §9 — mirrors
    // the session #11 DELETE /api/workouts/:id fix, same root cause. Stays
    // independent of the exercises_workout_id_fkey CASCADE migration: a
    // cascade from workouts can never reach an exercises row whose
    // workout_id is null, and extract-exercises can insert one).
    await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + req.params.id, {
      method: "DELETE",
      headers: sbHeaders("return=minimal"),
    });
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
    const result = await withTimeout(buildDailyData(token), 25000, "buildDailyData");
    res.json({ success: true, date: result.date, data: result.data });
  } catch (err) {
    // Non-fatal: degrade to an empty wearable snapshot (200) on any Fitbit
    // token/API/timeout failure rather than 500ing.
    console.error("[Fitbit] /api/daily failed (non-fatal), returning empty wearable data:", err.message);
    res.json({ success: true, date: dateStr(0), data: emptyWearableData(), fitbit_error: true });
  }
});

// Per-profile endpoint (uses profile's fitbit tokens from profiles table)
app.get("/api/profiles/:id/daily", async function(req, res) {
  try {
    // Athlete's timezone (2026-07-15) — one lightweight fetch, reused for both
    // the Google Health and Fitbit branches below via localToday(). Non-fatal:
    // defaults to {} → UTC fallback inside localToday() on any read failure.
    const profileTz = await getProfileTimezone(req.params.id).catch(function() { return {}; });

    // ── Google Health API v4 (cloud REST — Fitbit Web API successor) ──
    // Preferred over Fitbit when connected (Fitbit Web API shuts down Sep 2026).
    // Fully additive + non-fatal: any failure falls through to the Fitbit path
    // below with existing behavior 100% unchanged. NOTE: ghDate (not "dateStr")
    // — dateStr is the module-level helper fn; shadowing it here would TDZ-throw.
    let ghToken = null;
    try {
      ghToken = await getValidWearableToken(req.params.id, "google_health");
    } catch (e) {
      // 2026-07-20: was a fully empty catch. A dead or absent Google Health
      // connection skipped this entire branch with no trace whatsoever, which
      // is half of why "GH is broken" and "GH was never connected" looked
      // identical from outside. Still non-fatal — we fall through to Fitbit
      // exactly as before; this only makes the skip visible.
      console.warn("[google_health] token unavailable for profile " + req.params.id +
        " (code=" + ((e && e.code) || "none") + "): " + ((e && e.message) || e) +
        " — skipping Google Health, falling through to Fitbit");
    }

    if (ghToken) {
      try {
        const ghAdapter = wearables.getProviderAdapter("google_health");
        // ATHLETE's local today (2026-07-15 fix) — the previous version of this
        // comment claimed getFullYear/getMonth/getDate matched "the app's local
        // time", but that's the Node PROCESS's own OS timezone (UTC on Render),
        // not the athlete's — same bug as dateStr()'s toISOString(), just a
        // different symptom. localToday() uses the athlete's actual IANA
        // timezone (profiles.timezone), falling back to UTC when unset.
        const ghDate = req.query.date || localToday(profileTz);
        // Hard 8s cap — the GH adapter's fetches have no AbortController, so a
        // hung upstream would otherwise stall the endpoint into a 504. On
        // timeout this throws and falls through to the Fitbit path below.
        const ghData = await withTimeout(
          ghAdapter.fetchDailyData(ghToken, ghDate, { label: "daily" }), 8000, "google_health fetchDailyData"
        );

        // 2026-07-20 — surface a definitive auth failure. The adapter's own
        // Promise.allSettled means a 401 never propagates out of
        // fetchDailyData, so it never reached getValidWearableToken's catch
        // and setNeedsReconnect(…, "google_health", true) was unreachable by
        // construction: the flag could not become true no matter how dead the
        // connection was. The adapter now reports the verdict (token rejected
        // AND zero legs succeeded); transient failures never set it.
        // Best-effort and fire-and-forget — mirrors the Fitbit path, never
        // blocks or fails /daily, and does not change the fallback below.
        const ghDiag = ghData && ghData._diagnostics;
        if (ghDiag && ghDiag.auth_failure) {
          console.error("[google_health] DEFINITIVE auth failure for profile " + req.params.id +
            " on " + ghDate + " (" + ghDiag.rejected_count + "/" + ghDiag.legs.length +
            " legs rejected, 0 fulfilled) — flagging needs_reconnect");
          setNeedsReconnect(req.params.id, "google_health", true);
        }

        // Only serve Google Health if it actually returned something this day;
        // otherwise fall through to Fitbit (e.g. a brand-new GH connection with
        // nothing synced yet, or an empty/stale day).
        const hasData = ghData.hrv !== null || ghData.rhr !== null ||
                        ghData.sleep !== null || ghData.steps !== null;
        if (hasData) {
          // Fire-and-forget persistence (mirrors the Fitbit path below).
          if (ghData.steps != null) {
            upsertDailySteps(req.params.id, {
              date: ghDate, steps: ghData.steps,
              calories: null, distance_miles: null, floors: null,
              source: "google_health",
            }).catch(function(e){ console.error("[google_health] steps upsert:", e.message); });
            autoTrackStepMicroGoals(req.params.id, ghData.steps)
              .catch(function(e){ console.error("[google_health] step micro-goals:", e.message); });
          }
          if (ghData.weight) {
            upsertBodyMetrics(req.params.id, {
              date: ghDate, weight_lbs: ghData.weight.weight_lbs,
              body_fat_pct: ghData.weight.body_fat_pct, source: "google_health",
            }).catch(function(e){ console.error("[google_health] weight upsert:", e.message); });
          }
          // Per-metric sleep fallback: GH returned other metrics but no sleep
          // yet (reconciliation lag — GH ingests last night's wearable sleep
          // session later than daily HRV/RHR/steps). Try Fitbit for the same
          // date before giving up; profile 1's Fitbit is still connected and is
          // often ahead of GH on last night's sleep. Bounded (6s) + fully
          // non-fatal: withTimeout REJECTS on timeout, so a slow Fitbit lands in
          // this catch exactly like an error — ghData.sleep stays null and
          // /daily proceeds without hanging (never blocks the response).
          // Tracks WHICH provider the sleep on this row actually came from, so
          // daily_sleep.source can be labelled truthfully below. The row can
          // legitimately hold Fitbit sleep alongside Google Health HRV/RHR when
          // the fallback fires; `source` is labelled by the SLEEP source, since
          // the column lives on daily_sleep and the consumer question is where
          // the sleep came from. Deliberately NOT a second column.
          let ghSleepProvider = "google_health";
          if (!ghData.sleep) {
            try {
              const fbToken = await getValidProfileToken(req.params.id);
              const fbSleep = await withTimeout(
                fetchFitbitSleepForDate(fbToken, ghDate), 6000, "fitbit sleep fallback"
              );
              if (fbSleep && fbSleep.hours != null) {
                ghData.sleep = fbSleep;
                ghSleepProvider = "fitbit";
                console.log("[google_health] sleep fell back to Fitbit for " + ghDate);
              }
            } catch (e) {
              console.warn("[google_health] Fitbit sleep fallback failed (non-fatal): " + e.message);
            }
          }

          // estimateSleepScore returns null when stage minutes are absent (CLASSIC sleep).
          const ghSleepScore = ghData.sleep ? estimateSleepScore(
            ghData.sleep.deep_minutes, ghData.sleep.rem_minutes,
            ghData.sleep.light_minutes, ghData.sleep.wake_minutes
          ) : null;
          if (ghData.sleep) {
            upsertDailySleep(req.params.id, {
              date: ghDate,
              hours: ghData.sleep.hours,
              score: ghSleepScore,
              deep_minutes: ghData.sleep.deep_minutes,
              rem_minutes: ghData.sleep.rem_minutes,
              light_minutes: ghData.sleep.light_minutes,
              wake_minutes: ghData.sleep.wake_minutes,
              hrv: ghData.hrv,
              rhr: ghData.rhr,
              source: ghSleepProvider,
            }).catch(function(e){ console.error("[google_health] sleep upsert:", e.message); });
          } else if (ghData.hrv != null || ghData.rhr != null) {
            // Decouple HRV/RHR from sleep — persist vitals even when sleep is
            // still unavailable (GH lag AND no Fitbit fallback), WITHOUT
            // clobbering any existing sleep row (upsertDailyVitals only writes
            // hrv/rhr). Previously these were written ONLY inside the sleep
            // upsert, so a sleep-less morning dropped HRV/RHR too.
            upsertDailyVitals(req.params.id, {
              date: ghDate, hrv: ghData.hrv, rhr: ghData.rhr,
              source: "google_health",
            }).catch(function(e){ console.error("[google_health] vitals upsert:", e.message); });
          }

          // Build the response in the shape the client expects (mirrors buildDailyData).
          // sleep.stages must be the Fitbit NESTED shape — { deep: { minutes }, ... } —
          // NOT flat numbers. The frontend readers (renderReadiness, computeReadiness,
          // and the AI-prompt builder) all read `stages.<stage>.minutes` (Fitbit's
          // levels.summary shape); emitting bare numbers here made `.minutes` undefined,
          // which blanked the sleep card and zeroed deep-sleep in the readiness formula
          // (was masked while GH's token was dead and /daily fell through to Fitbit).
          // thirtyDayAvgMinutes is absent for GH — the frontend already treats it as
          // optional (`|| '?'` / `|| 0`), so its absence is safe.
          const responseData = {
            sleep: ghData.sleep ? {
              hours: ghData.sleep.hours,
              stages: {
                deep:  { minutes: ghData.sleep.deep_minutes },
                rem:   { minutes: ghData.sleep.rem_minutes },
                light: { minutes: ghData.sleep.light_minutes },
                wake:  { minutes: ghData.sleep.wake_minutes },
              },
              score: ghSleepScore,
              fitbit_score: null,
            } : null,
            rhr: ghData.rhr,
            hrv: ghData.hrv,
            // ghData.activeZoneMinutes is { peak, cardio, fatBurn, total } (or null).
            prevZones: ghData.activeZoneMinutes ? {
              peak: ghData.activeZoneMinutes.peak,
              cardio: ghData.activeZoneMinutes.cardio,
              fatBurn: ghData.activeZoneMinutes.fatBurn,
            } : null,
            steps: ghData.steps,
            activeZoneMinutes: ghData.activeZoneMinutes ? ghData.activeZoneMinutes.total : null,
            stepsSummary: ghData.steps != null ? {
              date: ghDate, steps: ghData.steps,
              calories: null, distance_miles: null, floors: null,
            } : null,
            todaysActivities: [],
            bodySummary: ghData.weight ? {
              date: ghDate, weight_lbs: ghData.weight.weight_lbs,
              body_fat_pct: ghData.weight.body_fat_pct,
            } : null,
            sleepSummary: ghData.sleep ? {
              date: ghDate,
              hours: ghData.sleep.hours,
              score: ghSleepScore,
              deep_minutes: ghData.sleep.deep_minutes,
              rem_minutes: ghData.sleep.rem_minutes,
              light_minutes: ghData.sleep.light_minutes,
              wake_minutes: ghData.sleep.wake_minutes,
              hrv: ghData.hrv,
              rhr: ghData.rhr,
            } : null,
            rolling7: { rhr: null, hrv: null },
            rhrHistory7Day: [],
            source: "google_health",
          };

          console.log("[google_health] daily served profile=" + req.params.id + " date=" + ghDate + " hrv=" + ghData.hrv + " rhr=" + ghData.rhr + " steps=" + ghData.steps + " azm=" + (ghData.activeZoneMinutes ? ghData.activeZoneMinutes.total : null));
          // 2026-07-20: last_synced_at previously only ever moved when someone
          // opened the Wearable Sync bulk-review modal (its sole writer was
          // computeWearableBacklog), so Google Health read as never-synced while
          // it was in fact the serving provider every day. Stamping it on a
          // successful serve makes the field mean what its name implies.
          // Fire-and-forget; stampLastSynced never throws.
          stampLastSynced(req.params.id, "google_health");
          return res.json({ success: true, date: ghDate, data: responseData });
        }
        // This line used to read only "no data" — indistinguishable between a
        // genuinely quiet day and a provider that failed on every leg. The leg
        // counts disambiguate it: rejected=0 means GH really had nothing;
        // rejected>0 means GH failed and the per-leg errors are logged above.
        console.log("[google_health] no data for " + ghDate + " — falling through to Fitbit" +
          (ghDiag ? " (legs fulfilled=" + ghDiag.fulfilled_count + " rejected=" + ghDiag.rejected_count + ")" : ""));
        // No Google Health data this day → fall through to the Fitbit path below.
      } catch (e) {
        // Reachable via the outer 8s withTimeout or an unexpected throw — NOT
        // via a per-leg HTTP error, which allSettled handles inside the adapter.
        console.error("[google_health] fetchDailyData failed (falling through to Fitbit):",
          "code=" + ((e && e.code) || "none"), e.message);
      }
    }

    console.log("[Fitbit] /api/profiles/" + req.params.id + "/daily called - loading tokens from profiles table");
    const dateParam = req.query.date || null;
    // Non-fatal Fitbit fetch: a token/refresh failure, an API error, or a
    // timeout must NOT 500/504 this endpoint. On any failure we return a 200
    // with an empty wearable snapshot so the client still generates a
    // recommendation from profile + manual data. (buildDailyData's individual
    // calls already degrade to null internally; this guards the token step and
    // any unexpected throw, and bounds the whole build so it can't hang.)
    let result;
    try {
      const token = await getValidProfileToken(req.params.id);
      result = await withTimeout(buildDailyData(token, dateParam, profileTz.timezone), 25000, "buildDailyData");
    } catch (fitbitErr) {
      console.error("[Fitbit] daily fetch failed (non-fatal) for profile " + req.params.id + ", returning empty wearable data:", fitbitErr.message);
      return res.json({ success: true, date: dateParam || localToday(profileTz), data: emptyWearableData(), fitbit_error: true });
    }
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
    // Fire-and-forget: persist last night's sleep (hours + computed score +
    // stage minutes + morning HRV/RHR) so Life OS gets an instant,
    // Fitbit-independent copy for the rest of the day.
    var sl = result.data && result.data.sleepSummary;
    if (sl && sl.date && (typeof sl.hours === "number" || typeof sl.score === "number" || typeof sl.hrv === "number" || typeof sl.rhr === "number")) {
      upsertDailySleep(req.params.id, sl).catch(function(e) {
        console.error("[Sleep] daily upsert failed:", e.message);
      });
    }
    // NOTE: no pending-imports queue write here — the Today-tab "Unmatched
    // Fitbit Activities" card (GET /api/profiles/:id/unmatched-fitbit)
    // computes unmatched activities on demand over the last 7 days instead
    // (2026-07-17: the old fitbit_pending_imports queue + its endpoints were
    // removed entirely, see ROADMAP.md §9).
    // Same rationale as the Google Health serve above — a successful Fitbit
    // serve is a real sync and should move last_synced_at. Not reached on the
    // fitbitErr path, which returns emptyWearableData() earlier.
    stampLastSynced(req.params.id, "fitbit");
    res.json({ success: true, date: result.date, data: result.data });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Loud failure for provenance writes (2026-07-20). daily_sleep/daily_steps
// upserts are fire-and-forget, so a rejected write would otherwise lose the row
// behind a generic one-line catch — the exact shape of the duration_minutes
// data loss (session #30), where a per-row failure was logged and the endpoint
// still reported success. A constraint rejection on `source` specifically is
// called out by name so it can never be mistaken for "no data today".
// 23514 = check_violation, 22P02 = invalid_text_representation (PostgREST
// surfaces both as a 400 with the code in the JSON body).
function logProvenanceWriteFailure(table, profileId, date, source, status, body) {
  var txt = String(body || "");
  var constraintish = status === 400 &&
    (txt.indexOf("23514") !== -1 || txt.indexOf("22P02") !== -1 ||
     txt.indexOf("check constraint") !== -1 || txt.indexOf("invalid input value") !== -1);
  console.error(
    "[Provenance] " + (constraintish ? "CONSTRAINT REJECTED" : "WRITE FAILED") +
    " table=" + table + " profile=" + profileId + " date=" + date +
    " source=\"" + source + "\" status=" + status + " body=" + txt.substring(0, 300)
  );
  if (constraintish) {
    console.error(
      "[Provenance] ROW LOST — \"" + source + "\" appears to be rejected by a constraint on " +
      table + ".source. This write is fire-and-forget, so the data is NOT retried. " +
      "Widen the constraint before writing this value again."
    );
  }
}

// ── STEP HISTORY ──────────────────────────────────────────────────────────
async function upsertDailySteps(profileId, summary) {
  var payload = {
    profile_id: profileId,
    date: summary.date,
    steps: summary.steps,
    calories: summary.calories,
    distance_miles: summary.distance_miles,
    floors: summary.floors,
    // Threaded from the real provider (2026-07-20). Was hardcoded "fitbit",
    // which mislabelled every Google-Health-sourced row. Defaults to "fitbit"
    // so every caller that passes no source is byte-identical to before.
    source: summary.source || "fitbit",
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
    logProvenanceWriteFailure("daily_steps", profileId, summary.date, payload.source, r.status, t);
    throw new Error("daily_steps upsert " + r.status + ": " + t);
  }
  console.log("[Steps] upserted profile=" + profileId + " date=" + summary.date + " steps=" + summary.steps);
}

// ── DAILY SLEEP ─────────────────────────────────────────────────────────────
// Persist last night's sleep (hours + computed personal score + stage minutes)
// plus the morning HRV/RHR snapshot so Life OS — and any other reader — gets it
// instantly without a live Fitbit call, surviving Render cold starts / Vercel
// timeouts after the first successful sync each day. profile_id + date unique;
// upserted on conflict (later syncs overwrite a partial early-morning row).
async function upsertDailySleep(profileId, summary) {
  var payload = {
    profile_id: profileId,
    date: summary.date,
    hours: summary.hours,
    score: summary.score,
    deep_minutes: summary.deep_minutes,
    rem_minutes: summary.rem_minutes,
    light_minutes: summary.light_minutes,
    wake_minutes: summary.wake_minutes,
    hrv: summary.hrv,
    rhr: summary.rhr,
    // Threaded from the real provider (2026-07-20). Was hardcoded "fitbit".
    // Callers that pass no source still write "fitbit" — unchanged behavior.
    source: summary.source || "fitbit",
  };
  var r = await fetch(
    SUPABASE_URL + "/rest/v1/daily_sleep?on_conflict=profile_id,date",
    {
      method: "POST",
      headers: sbHeaders("return=minimal,resolution=merge-duplicates"),
      body: JSON.stringify(payload),
    }
  );
  if (!r.ok) {
    var t = await r.text();
    logProvenanceWriteFailure("daily_sleep", profileId, summary.date, payload.source, r.status, t);
    throw new Error("daily_sleep upsert " + r.status + ": " + t);
  }
  console.log("[Sleep] upserted profile=" + profileId + " date=" + summary.date + " score=" + summary.score + " hours=" + summary.hours);
}

// Persist HRV/RHR into daily_sleep WITHOUT touching sleep columns, so a decoupled
// vitals write (GH returned HRV/RHR but no sleep) can never clobber an existing
// sleep row for the day. GET-then-PATCH (or INSERT if absent) rather than a
// partial merge-upsert, so clobber-safety doesn't depend on PostgREST's
// partial-merge column semantics — the PATCH body only ever holds hrv/rhr.
async function upsertDailyVitals(profileId, summary) {
  var patch = {};
  if (summary.hrv != null) patch.hrv = summary.hrv;
  if (summary.rhr != null) patch.rhr = summary.rhr;
  if (!Object.keys(patch).length) return; // nothing to persist
  var scope = "profile_id=eq." + profileId + "&date=eq." + encodeURIComponent(summary.date);
  var gr = await fetch(SUPABASE_URL + "/rest/v1/daily_sleep?" + scope + "&select=id&limit=1", { headers: sbHeaders() });
  var rows = await gr.json();
  var exists = Array.isArray(rows) && rows.length > 0;
  if (exists) {
    var pr = await fetch(SUPABASE_URL + "/rest/v1/daily_sleep?" + scope, {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify(patch),
    });
    if (!pr.ok) { var t = await pr.text(); throw new Error("daily_sleep vitals PATCH " + pr.status + ": " + t); }
  } else {
    // `source` goes on the INSERT only — deliberately NEVER into the PATCH
    // body above. A vitals-only write must not relabel an existing row whose
    // SLEEP came from a different provider (the column describes the sleep
    // source). On a fresh row there is no sleep yet, so stamping the vitals
    // provider is the only honest value available.
    var insert = Object.assign(
      { profile_id: profileId, date: summary.date, source: summary.source || "fitbit" },
      patch
    );
    var ir = await fetch(SUPABASE_URL + "/rest/v1/daily_sleep", {
      method: "POST",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify(insert),
    });
    if (ir.status === 409) {
      // Lost a race to a concurrent insert of the same (profile_id,date) — the
      // row now exists, so PATCH only our vitals onto it (still no sleep touch).
      var pr2 = await fetch(SUPABASE_URL + "/rest/v1/daily_sleep?" + scope, {
        method: "PATCH", headers: sbHeaders("return=minimal"), body: JSON.stringify(patch),
      });
      if (!pr2.ok) { var t2 = await pr2.text(); throw new Error("daily_sleep vitals PATCH(after 409) " + pr2.status + ": " + t2); }
    } else if (!ir.ok) {
      var t3 = await ir.text(); throw new Error("daily_sleep vitals INSERT " + ir.status + ": " + t3);
    }
  }
  console.log("[Vitals] upserted profile=" + profileId + " date=" + summary.date + " hrv=" + summary.hrv + " rhr=" + summary.rhr + " (existing=" + exists + ")");
}

// Lean one-date Fitbit sleep fetch — the per-metric fallback used by the GH
// /daily branch when Google Health returns other metrics but no sleep yet.
// Returns the same shape the GH adapter produces ({hours, deep/rem/light/
// wake_minutes}) or null. NEVER throws: internal failures resolve to null, so an
// outer withTimeout() race can't leave a rejected orphan promise behind. Fitbit
// files a sleep log under its wake/end date (matching GH's "sleep that ended
// today"); we also try date-1 as a safety net.
async function fetchFitbitSleepForDate(token, date) {
  function pickMain(resp) {
    var arr = (resp && resp.sleep) || [];
    if (!arr.length) return null;
    return arr.find(function(s){ return s.isMainSleep; }) || arr[0] || null;
  }
  function shape(rec) {
    if (!rec) return null;
    var lv = rec.levels && rec.levels.summary ? rec.levels.summary : null;
    var asleepMin = typeof rec.minutesAsleep === "number" ? rec.minutesAsleep : null;
    if (asleepMin == null) return null;
    return {
      hours: +(asleepMin / 60).toFixed(2),
      deep_minutes:  lv && lv.deep  ? lv.deep.minutes  : null,
      rem_minutes:   lv && lv.rem   ? lv.rem.minutes   : null,
      light_minutes: lv && lv.light ? lv.light.minutes : null,
      wake_minutes:  lv && lv.wake  ? lv.wake.minutes  : null,
    };
  }
  var rec = null;
  try { rec = pickMain(await fitGet("/1.2/user/-/sleep/date/" + date + ".json", token)); } catch (e) { rec = null; }
  if (!rec) {
    var prev = null;
    try { var d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); prev = d.toISOString().slice(0, 10); } catch (e) { prev = null; }
    if (prev) { try { rec = pickMain(await fitGet("/1.2/user/-/sleep/date/" + prev + ".json", token)); } catch (e) { rec = null; } }
  }
  return shape(rec);
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

// ── UNMATCHED FITBIT ACTIVITIES (Today-tab convenience card) ────────────────
// Replaces the legacy fitbit_pending_imports queue with a smarter card: surfaces
// Fitbit activities from the last 7 days that aren't yet linked to a workout and
// haven't been dismissed, and (when a same-day manual workout exists) offers to
// match them to it instead of always creating a duplicate. Routes through the
// provider-agnostic wearable adapter — the merge/import actions reuse
// /api/wearables/merge|import. Dismissals are stored globally on the profile
// (profiles.dismissed_fitbit_activities jsonb) because rejected_wearable_matches
// requires a NOT NULL workout_id and a dismissal here isn't tied to one workout.

// GET /api/profiles/:id/unmatched-fitbit
// → { activities: [{ provider, provider_activity_id, activity_type,
//      duration_minutes, avg_hr, calories, start_time, date, same_day_workouts }] }
// Never 500s on a Fitbit failure: returns { activities: [], error: "fitbit_unavailable" }.
app.get("/api/profiles/:id/unmatched-fitbit", async function(req, res) {
  var pid = req.params.id;
  try {
    // 1. Token + provider — try Fitbit first (existing behavior), then fall back
    //    to Google Health. Skip silently (empty list) if neither is connected.
    //    Everything below is provider-agnostic (namespacedId(provider,...) etc.).
    var provider = null;
    var token = null;
    try {
      token = await getValidWearableToken(pid, "fitbit");
      if (token) provider = "fitbit";
    } catch (e) { /* no Fitbit — try Google Health */ }
    if (!token) {
      try {
        token = await getValidWearableToken(pid, "google_health");
        if (token) provider = "google_health";
      } catch (e) { /* no Google Health either */ }
    }
    if (!token || !provider) return res.json({ activities: [] });

    // 2. Window: 7 days ago → today (local dates, matching the rest of the app).
    var pad = function(n) { return String(n).padStart(2, "0"); };
    var fmt = function(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
    var todayDate = new Date();
    var startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    var todayStr = fmt(todayDate);
    var startStr = fmt(startDate);

    // 3. Fitbit activities for the window — non-fatal on failure.
    var adapter = wearables.getProviderAdapter(provider);
    var activities;
    try {
      activities = await adapter.fetchActivities(token, startStr, todayStr);
    } catch (e) {
      console.warn("[UnmatchedFitbit] fetchActivities failed:", e && e.message);
      return res.json({ activities: [], error: "fitbit_unavailable" });
    }
    if (!Array.isArray(activities)) activities = [];

    // 4. This profile's workouts in the window — used both to find already-linked
    //    activities (wearable_activity_id) and to surface same-day match targets.
    var wRes = await fetch(
      SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + pid
        + "&date=gte." + startStr + "&date=lte." + todayStr
        + "&select=id,date,type,done,wearable_activity_id",
      { headers: sbHeaders() }
    );
    var workouts = await wRes.json();
    if (!Array.isArray(workouts)) workouts = [];
    var syncedSet = {};
    workouts.forEach(function(w) {
      if (w.wearable_activity_id) syncedSet[w.wearable_activity_id] = true;
    });

    // 5. Rejected pairings — filtered by profile_id ONLY (not workout_id), so a
    //    session the user split off from any workout stays out of this card too.
    var rejectedSet = {};
    try {
      var rRes = await fetch(
        SUPABASE_URL + "/rest/v1/rejected_wearable_matches?profile_id=eq." + pid
          + "&select=wearable_activity_id",
        { headers: sbHeaders() }
      );
      var rejected = await rRes.json();
      (Array.isArray(rejected) ? rejected : []).forEach(function(r) {
        if (r.wearable_activity_id) rejectedSet[r.wearable_activity_id] = true;
      });
    } catch (e) { /* non-fatal */ }

    // 5b. Dismissed activities — stored as namespaced "fitbit:<id>" strings on
    //     the profile. Degrades to empty if the column hasn't been migrated yet.
    var dismissedSet = {};
    try {
      var dRes = await fetch(
        SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid + "&select=dismissed_fitbit_activities",
        { headers: sbHeaders() }
      );
      var dRows = await dRes.json();
      var dismissedArr = (dRows && dRows[0] && Array.isArray(dRows[0].dismissed_fitbit_activities))
        ? dRows[0].dismissed_fitbit_activities : [];
      dismissedArr.forEach(function(id) { dismissedSet[String(id)] = true; });
    } catch (e) { /* column may not exist yet — treat as none dismissed */ }

    // 6. Build the response. An activity is "unmatched" when it isn't already
    //    linked, rejected, or dismissed. same_day_workouts = this profile's
    //    completed manual (not-yet-linked) workouts on the activity's date.
    var out = [];
    for (var i = 0; i < activities.length; i++) {
      var act = activities[i];
      if (!act || act.provider_activity_id == null || act.provider_activity_id === "") continue;
      var nsId = wearables.namespacedId(provider, act.provider_activity_id);
      if (syncedSet[nsId] || rejectedSet[nsId] || dismissedSet[nsId]) continue;
      var sameDay = workouts.filter(function(w) {
        return w.date === act.date && w.done && !w.wearable_activity_id;
      }).map(function(w) {
        return { id: w.id, type: w.type, date: w.date };
      });
      out.push({
        provider: provider,
        provider_activity_id: act.provider_activity_id,
        activity_type: act.activity_type,
        duration_minutes: act.duration_minutes,
        avg_hr: act.avg_hr,
        calories: act.calories,
        start_time: act.start_time || null,
        date: act.date,
        same_day_workouts: sameDay,
      });
    }
    res.json({ activities: out });
  } catch (e) {
    console.error("[UnmatchedFitbit] error:", e.message);
    // Even an unexpected error degrades to an empty card rather than a 500.
    res.json({ activities: [], error: "fitbit_unavailable" });
  }
});

// POST /api/profiles/:id/dismiss-fitbit-activity
// body: { provider_activity_id }  → { dismissed: true }
// Appends the namespaced "fitbit:<id>" to profiles.dismissed_fitbit_activities so
// the activity never reappears in the unmatched-fitbit card (across all workouts).
app.post("/api/profiles/:id/dismiss-fitbit-activity", async function(req, res) {
  var pid = req.params.id;
  try {
    var body = req.body || {};
    var rawId = body.provider_activity_id;
    if (rawId == null || rawId === "") {
      return res.status(400).json({ success: false, error: "provider_activity_id required" });
    }
    // Provider-agnostic: derive the provider from (a) an explicit body.provider,
    // (b) a "<provider>:<id>" prefix already on the id, else default to fitbit
    // (back-compat). Store the namespaced "<provider>:<id>" so it matches the keys
    // the GET endpoint filters on — works for fitbit AND google_health.
    var s = String(rawId);
    var KNOWN_PROVIDERS = ["fitbit", "google_health"];
    var provider = null;
    if (body.provider && KNOWN_PROVIDERS.indexOf(body.provider) >= 0) {
      provider = body.provider;
    } else {
      for (var ki = 0; ki < KNOWN_PROVIDERS.length; ki++) {
        if (s.indexOf(KNOWN_PROVIDERS[ki] + ":") === 0) { provider = KNOWN_PROVIDERS[ki]; break; }
      }
      if (!provider) provider = "fitbit";
    }
    var bare = s.indexOf(provider + ":") === 0 ? s.slice(provider.length + 1) : s;
    var nsId = wearables.namespacedId(provider, bare);

    var pr = await fetch(
      SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid + "&select=dismissed_fitbit_activities",
      { headers: sbHeaders() }
    );
    var pRows = await pr.json();
    var existing = (pRows && pRows[0] && Array.isArray(pRows[0].dismissed_fitbit_activities))
      ? pRows[0].dismissed_fitbit_activities : [];
    if (existing.indexOf(nsId) < 0) {
      existing = existing.concat([nsId]);
      await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid, {
        method: "PATCH",
        headers: sbHeaders("return=minimal"),
        body: JSON.stringify({ dismissed_fitbit_activities: existing }),
      });
    }
    res.json({ dismissed: true });
  } catch (e) {
    console.error("[DismissFitbit] error:", e.message);
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
    // Optional pagination (2026-07-17): additive + backward-compatible — absent
    // offset means offset 0, so every existing caller is unaffected. Used by the
    // Today "Log past workout" panel's "See more" to page past the default 60.
    var offset = parseInt(req.query.offset, 10);
    if (!isNaN(offset) && offset > 0) url += "&offset=" + offset;
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

// ── Auto-import on save ─────────────────────────────────────────────────────
// After a manual workout is saved, opportunistically check whether the user's
// Fitbit recorded an activity on the SAME date that looks like the same
// session, and return the single best candidate so the client can PROMPT the
// user to link it (never silently auto-attached). Fully additive: any failure
// returns null and the save proceeds normally. The POST handler caps this with
// a 4s Promise.race so it can never slow the save down.
async function findWearableMatchOnSave(profileId, workout) {
  if (!profileId || !workout || !workout.date) return null;

  // 1. Token + provider — try Fitbit first (existing behavior), then fall back
  //    to Google Health when there's no Fitbit connection. Never both. Skip
  //    silently if neither is connected (RECONNECT_REQUIRED / no token). The rest
  //    of the matching logic is provider-agnostic (works on NormalizedActivity).
  var provider = null;
  var token = null;
  try {
    token = await getValidWearableToken(profileId, "fitbit");
    if (token) provider = "fitbit";
  } catch (e) { /* no Fitbit — try Google Health below */ }
  if (!token) {
    try {
      token = await getValidWearableToken(profileId, "google_health");
      if (token) provider = "google_health";
    } catch (e) { /* no Google Health either */ }
  }
  if (!token || !provider) return null;

  var adapter = wearables.getProviderAdapter(provider);
  var date = workout.date;

  // 2. Fetch the day's activities (start_date = end_date = the workout's date).
  var activities = await adapter.fetchActivities(token, date, date);
  if (!Array.isArray(activities) || !activities.length) return null;

  // 3a. Drop activities already matched to one of this profile's workouts
  //     (deduped by the namespaced "provider:id" stored in wearable_activity_id).
  var syncedSet = {};
  try {
    var syncedRes = await fetch(
      SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + profileId
        + "&date=eq." + date
        + "&wearable_activity_id=not.is.null&select=wearable_activity_id",
      { headers: sbHeaders() }
    );
    var syncedRows = await syncedRes.json();
    (Array.isArray(syncedRows) ? syncedRows : []).forEach(function(w) {
      if (w.wearable_activity_id) syncedSet[w.wearable_activity_id] = true;
    });
  } catch (e) { /* non-fatal — worst case we re-suggest an already-linked one */ }

  // 3b. Drop activities the user already rejected for THIS workout.
  var rejectedSet = {};
  try {
    var rejRes = await fetch(
      SUPABASE_URL + "/rest/v1/rejected_wearable_matches?profile_id=eq." + profileId
        + "&workout_id=eq." + workout.id
        + "&select=wearable_activity_id",
      { headers: sbHeaders() }
    );
    var rejRows = await rejRes.json();
    (Array.isArray(rejRows) ? rejRows : []).forEach(function(r) {
      if (r.wearable_activity_id) rejectedSet[r.wearable_activity_id] = true;
    });
  } catch (e) { /* non-fatal */ }

  // 4. Score each remaining activity against the just-saved workout using the
  //    existing matcher; keep candidates scoring >= 40 (the existing threshold).
  var candidates = [];
  for (var i = 0; i < activities.length; i++) {
    var act = activities[i];
    var nsId = wearables.namespacedId(provider, act.provider_activity_id);
    if (syncedSet[nsId] || rejectedSet[nsId]) continue;
    var match = wearables.matchWearableToManual(act, [workout]);
    if (match && match.score >= 40) {
      candidates.push({ activity: act, score: match.score });
    }
  }
  if (!candidates.length) return null;

  // 5. Best candidate only.
  candidates.sort(function(a, b) { return (b.score || 0) - (a.score || 0); });
  var top = candidates[0];
  var a = top.activity;

  // 6. Trim to the wearable_match response shape the client prompt consumes.
  //    (avg_hr is always present as a key, so the merge endpoint's mergeListHr
  //    treats this object as already-normalized and backfills HR from it.)
  return {
    provider: provider,
    provider_activity_id: a.provider_activity_id,
    activity_type: a.activity_type,
    duration_minutes: a.duration_minutes,
    avg_hr: a.avg_hr,
    calories: a.calories,
    score: top.score,
    start_time: a.start_time || null,
  };
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
      // Athlete's timezone (2026-07-15) — this "todayStr" used to be the
      // server's own OS-local getters (UTC-equivalent on Render). Real bug for
      // POSITIVE-UTC-offset athletes specifically: in their morning, if the
      // server (UTC) is still on the prior calendar day, a legitimately
      // same-day log would get wrongly rejected as "future". Negative-offset
      // athletes (e.g. the Chicago Coach Chat repro) don't hit this exact
      // failure mode, but it's the same root cause — closing it while in here.
      var profileTz = body.profile_id ? await getProfileTimezone(body.profile_id).catch(function() { return {}; }) : {};
      var todayStr = localToday(profileTz);
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
    // Fire-and-forget weekly roadmap maintenance — adapts BOTH per-goal roadmaps
    // and the structured macro roadmap when >7 days stale (shared context fetch).
    if (body.profile_id) maybeAdaptAllRoadmaps(body.profile_id).catch(function(e) { console.error("Roadmap adaptation error:", e); });

    // Auto-import on save: opportunistically look for a same-day Fitbit activity
    // that matches this workout and surface it under `wearable_match` so the
    // client can prompt to link it. Awaited so it rides the response, but capped
    // at 4s and fully non-fatal — it must never delay or break the save.
    var savedRow = Array.isArray(data) ? data[0] : data;
    if (body.profile_id && savedRow && savedRow.id && savedRow.date) {
      try {
        var wearableMatch = await Promise.race([
          findWearableMatchOnSave(body.profile_id, savedRow),
          new Promise(function(resolve) { setTimeout(function() { resolve(null); }, 4000); }),
        ]);
        if (wearableMatch) savedRow.wearable_match = wearableMatch;
      } catch (e) {
        console.warn("[AutoImport] wearable match lookup failed:", e && e.message);
      }
    }
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
    // Delete child exercises rows FIRST (same profile-ownership guard the
    // single-exercise DELETE endpoint already uses) so a deleted workout
    // never leaves orphaned exercises rows behind — real bug found live
    // 2026-07-16, see CLAUDE.md/ROADMAP.md. No FK/cascade migration added;
    // an explicit delete here is simpler and the guardrail for this fix was
    // no schema changes (an ON DELETE CASCADE FK is flagged as a future
    // hardening option, not applied).
    if (pid) {
      await fetch(SUPABASE_URL + "/rest/v1/exercises?workout_id=eq." + id + "&profile_id=eq." + pid, {
        method: "DELETE",
        headers: sbHeaders("return=minimal"),
      });
    }
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
var MODEL_SONNET = "claude-sonnet-4-6";
var MODEL_HAIKU  = "claude-haiku-4-5-20251001";

// callType → model. Cheap tasks (formatting, extraction, short classification)
// run on Haiku; intelligence-sensitive work (recs, briefs, roadmap, full profile
// generation) stays on Sonnet.
// Temperature by callType (2026-07-19). ONLY deterministic-intent tasks appear
// here — identical input must produce identical output, or the feature is
// unreliable. Everything absent keeps the Anthropic default (1.0).
//
// Why this exists: no temperature was ever set anywhere, so every call ran at
// 1.0. Measured on workout 87 — 4 identical extraction calls at the default
// returned 3 DIFFERENT results (7 / 8 / 4 rows); at temperature 0, 4 identical
// calls returned 1 identical result. Same class of instability applies to
// titling, note formatting and structured-JSON builders.
//
// DELIBERATELY ABSENT (generative — variety is a feature, not a defect):
//   daily_recs      — "Show me different options" must actually differ; pinning
//                     to 0 would return the identical rec on every reroll.
//   coach_chat, coaching_brief, historical_brief, roadmap/goal/macro generators
//                   — prose and planning, where sampling variety is wanted.
// daily_recs' constraint-compliance (exercise count, duration budget) is a
// Phase B decision; a mid-range value (~0.6-0.7) is the likely answer there,
// not 0.
var CALL_TYPE_TEMPERATURE = {
  extract_exercises: 0,   // parse notes -> rows; also set directly in callAI
  workout_title:     0,   // classification of notes into a fixed taxonomy
  format_notes:      0,   // reformatting, not authoring
  schedule_builder:  0,   // structured JSON out of fixed answers
};

var CALL_TYPE_MODEL = {
  // Smart tasks — Sonnet
  daily_recs:        MODEL_SONNET,
  onboarding_profile: MODEL_SONNET,
  profile_builder:   MODEL_SONNET,
  coaching_brief:    MODEL_SONNET,
  historical_brief:  MODEL_SONNET,
  roadmap:           MODEL_SONNET,
  history_search:    MODEL_SONNET,
  goal_roadmap_generate: MODEL_SONNET,
  macro_roadmap_generate: MODEL_SONNET,
  coach_chat:        MODEL_SONNET,
  // Cheap tasks — Haiku
  format_notes:      MODEL_HAIKU,
  goal_intake_questions: MODEL_HAIKU,
  // E1: goal roadmap adapt moved to Sonnet — it judges phase-premise validity,
  // which now steers the daily rec prompt. macro_roadmap_adapt stays on Haiku
  // for now; its output (exercise_gaps) is not yet consumed by the rec prompt
  // and is queued separately (ROADMAP §9, D9).
  goal_roadmap_adapt:    MODEL_SONNET,
  macro_roadmap_adapt:   MODEL_HAIKU,
  workout_title:     MODEL_HAIKU,
  extract_exercises: MODEL_HAIKU,
  progress_brief:    MODEL_HAIKU,
  exercise_insight:  MODEL_HAIKU,
  goal_description:  MODEL_HAIKU,
  schedule_builder:  MODEL_HAIKU,
  schedule_preview:  MODEL_HAIKU,
  chat_summarize:    MODEL_HAIKU,
};

function modelForCallType(callType) {
  if (callType && CALL_TYPE_MODEL[callType]) return CALL_TYPE_MODEL[callType];
  // Default to Sonnet if callType is missing or unknown — preserves existing
  // behavior for any unmigrated caller, without letting the client pick, but
  // warn loudly since this silently bills at Sonnet rates for a typo'd/new
  // callType that was never added to the map above.
  console.warn("[AI] Unknown callType '" + callType + "' — defaulting to Sonnet. Add it to CALL_TYPE_MODEL if this is intentional.");
  return MODEL_SONNET;
}

// Shared cache_control wrapping — used by the /api/ai proxy (client-sent
// system prompts) AND server-assembled prompts like coach chat. daily_recs
// and coach_chat get the 1h TTL (checked repeatedly within a session/day);
// everything else gets the 5-minute default. See /api/ai for the TTL economics
// comment.
function wrapSystemWithCache(system, callType) {
  var useLongTtl = callType === "daily_recs" || callType === "coach_chat";
  var cacheControl = useLongTtl ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  if (typeof system === "string" && system.length > 0) {
    return [{ type: "text", text: system, cache_control: cacheControl }];
  } else if (Array.isArray(system) && system.length > 0) {
    var hasCache = system.some(function(b) { return b && b.cache_control; });
    if (!hasCache) {
      var last = system[system.length - 1];
      if (last && typeof last === "object") last.cache_control = cacheControl;
    }
    return system;
  }
  return system;
}

// `temperature` is optional and omitted entirely when not passed, so every
// existing caller keeps the Anthropic default (1.0) and is byte-for-byte
// unaffected. Pass 0 for extraction/parsing tasks where identical input must
// yield identical output — measured 2026-07-19 on workout 87: at the default,
// 4 identical calls produced 3 DIFFERENT results (7 / 8 / 4 / 8 rows); at
// temperature 0, 4 identical calls produced 1 identical result (8 rows, same
// sets/reps/durations). See ROADMAP §0.4 / session #30.
// Ceiling for a NON-STREAMED model call, derived from output size + model.
// callAI() had no timeout at all before 2026-07-19, which mattered most on the
// hot path: extract-exercises runs it on every workout save, so a hung upstream
// call hung the save. Values are generous multiples of observed latency — this
// is a hang guard, not a latency target.
//   Haiku  <=200 tok  20s   (titles, goal descriptions, exercise insights)
//   Haiku   >200 tok  30s   (extract-exercises, 1000 tok — observed ~2-4s)
//   Sonnet <=200 tok  30s
//   Sonnet  >200 tok  60s   (coaching/historical briefs, history search)
// Streaming paths (daily_recs, coach_chat) are NOT affected — they have their
// own idle/cap timers in pipeAnthropicStream and the client.
function aiTimeoutMs(maxTokens, model) {
  var small = (maxTokens || 1000) <= 200;
  if (model === MODEL_HAIKU) return small ? 20000 : 30000;
  return small ? 30000 : 60000;
}

async function callAI(prompt, maxTokens, model, temperature, timeoutMs) {
  var payload = {
    model: model || MODEL_SONNET,
    max_tokens: maxTokens || 1000,
    messages: [{ role: "user", content: prompt }],
  };
  if (typeof temperature === "number") payload.temperature = temperature;
  // Real abort, not just a Promise.race — race leaves the upstream request
  // running and the socket held. withTimeout() (used elsewhere for provider
  // calls) is fine where the promise can't be cancelled; here it can be.
  var ms = typeof timeoutMs === "number" ? timeoutMs : aiTimeoutMs(maxTokens, model);
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, ms);
  try {
    var response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    var data = await response.json();
    return (data.content && data.content[0]) ? data.content[0].text : "";
  } catch (e) {
    // Callers already treat "" as "no usable AI output" and degrade (the title
    // falls back to "Workout", extraction returns an empty list, briefs skip).
    // Surfacing a throw here would turn a slow upstream into a 500 on the save
    // path, which is strictly worse than the existing empty-string contract.
    var aborted = e && (e.name === "AbortError" || /abort/i.test(e.message || ""));
    console.error("[AI] callAI " + (aborted ? "TIMED OUT after " + ms + "ms" : "failed") +
      " (model=" + (model || MODEL_SONNET) + ", max_tokens=" + (maxTokens || 1000) + "): " + (e && e.message));
    return "";
  } finally {
    clearTimeout(timer);
  }
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

// ── EXERCISE CATALOG (canonicalization, 2026-07-15) ──────────────────────
// Generalizes the CANONICAL_NAMES hand-fix above into a catalog-backed
// system. Deliberately layered ON TOP of normalizeExerciseName(), not a
// replacement: normalizeExerciseName() still runs FIRST in the
// extract-exercises loop below and stays authoritative for every name it
// already covers (Dead Hang, Push-Up, etc.) — this only activates for names
// normalizeExerciseName() didn't already fully resolve, so it can never
// disagree with the existing hand-fix. The micro-goal auto-tracker
// (mgMatchesExercise / extractCanonicalFromTitle) re-derives canonicalization
// from CANONICAL_NAMES at READ time regardless of what's stored, so writing
// a catalog-resolved canonical name here is always safe: identical to today
// when it matches what normalizeExerciseName() would have produced, a pure
// improvement when it resolves a variant CANONICAL_NAMES doesn't know.

// lowercase, singularize EACH WORD (trailing 's' unless 'ss'), then strip
// hyphens/spaces — the exact normalization Part 3 of the design spec calls
// for. Used for both save-time exact/alias matching and the wger seed's
// dedup-on-insert check, so the two paths can never disagree about what
// counts as "the same name" already covered by an existing catalog row.
//
// Real bug fixed 2026-07-16, found live post-wger-seed: this used to
// lowercase+strip FIRST, then strip a trailing 's' off the whole
// concatenated string — so it only ever caught a plural on the LAST word
// ("push ups" -> "pushup", matching "Push-Up", only because "ups" happens
// to be last). A plural on any OTHER word was invisible: "Biceps Curl" ->
// "bicepscurl" vs "Bicep Curl" -> "bicepcurl" never collided, since the
// combined string's last character ('l') was never 's' regardless of the
// FIRST word's plural. Fixed by stemming per-word before joining. Verified
// against the existing behavior this must not regress (all still match):
// "push ups"/"pushups"/"Push-Up", "Jumping Jack"/"Jumping Jacks", "Sit-Up"/
// "Sit-Ups", "Dead Hang"/"Dead Hangs", "Hang Clean"/"Hang Cleans" — plus the
// new case this exists for: "Bicep Curl"/"Biceps Curl", "Tricep Extension"/
// "Triceps Extension", "Glute Bridge"/"Glutes Bridge". Known remaining gap,
// not chased (would need real English stemming, e.g. a Porter stemmer, for
// one extra word — out of proportion to the risk): "-es" plurals on
// sibilant-ending words ("Press" -> "Presses") still produce different keys
// ("benchpress" vs "benchpresse") — but that pair is still caught by the
// FUZZY layer (similarity 0.91, well over the 0.82 threshold), so it costs
// one confirm-chip tap instead of being silently exact, never a silent
// merge failure.
function catalogNormKey(name) {
  if (!name) return '';
  var words = String(name).toLowerCase().split(/[-\s]+/).filter(Boolean);
  var stemmed = words.map(function(w) {
    if (w.length > 2 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  });
  return stemmed.join('');
}

// Levenshtein edit distance (no npm dependency — the codebase has no
// existing fuzzy-match utility to reuse, confirmed by audit before writing
// this). Standard two-row DP, O(m*n) time / O(n) space.
function levenshteinDistance(a, b) {
  a = a || ''; b = b || '';
  var m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  var prev = new Array(n + 1), curr = new Array(n + 1);
  for (var j = 0; j <= n; j++) prev[j] = j;
  for (var i = 1; i <= m; i++) {
    curr[0] = i;
    for (var j2 = 1; j2 <= n; j2++) {
      var cost = a.charAt(i - 1) === b.charAt(j2 - 1) ? 0 : 1;
      curr[j2] = Math.min(prev[j2] + 1, curr[j2 - 1] + 1, prev[j2 - 1] + cost);
    }
    var tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}
// 0..1, 1 = identical. Length-normalized so short and long names are judged
// on a comparable scale.
function levenshteinSimilarity(a, b) {
  var maxLen = Math.max((a || '').length, (b || '').length);
  if (!maxLen) return 1;
  return 1 - (levenshteinDistance(a, b) / maxLen);
}

// Threshold for auto-applying a fuzzy match (still shows a confirm chip —
// see Part 4 — just doesn't escalate to the Haiku fallback). Requires both a
// high similarity ratio AND a minimum key length, so short names ("Row" vs
// "Bow") can't false-positive off a single-character edit.
var CATALOG_FUZZY_MIN_SIMILARITY = 0.82;
var CATALOG_FUZZY_MIN_KEY_LEN = 4;

// Lightweight catalog fetch for matching — only the fields resolution needs,
// not the phase-2 family/muscle-group/equipment columns. Cached per
// extract-exercises call (fetched once, reused for every exercise in that
// save), not globally, so a mid-session catalog edit (e.g. a Part 4 "change"
// picker creating a custom row) is visible on the very next save.
async function fetchExerciseCatalogForMatching() {
  var r = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?select=id,canonical_name,aliases&limit=10000", { headers: sbHeaders() });
  var rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

// ── EXERCISE CATALOG PHASE 2 (Library rollups / muscle filter / heatmap) ──
// Separate fetch from fetchExerciseCatalogForMatching() above — that one
// deliberately excludes family/muscle-group columns to stay lean on the hot
// save-time path (see its own comment); this one is read-only, called only
// from GET /api/profiles/:id/exercises and GET /api/analytics/muscle-volume,
// neither of which is in that hot path.
async function fetchExerciseCatalogWithMuscleData() {
  var r = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?select=id,canonical_name,aliases,family,muscle_groups_primary,muscle_groups_secondary&limit=10000", { headers: sbHeaders() });
  var rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

// Indexes catalog rows by catalogNormKey() over canonical_name AND every
// alias — the SAME normalization save-time matching uses (reused, never
// reimplemented), so a lookup here can never disagree with what
// resolveExerciseCatalog() would say. This is a plain O(1) index lookup over
// ALREADY-CANONICAL stored exercises.name values, not fuzzy/Haiku resolution
// — every name reaching this index was already fully resolved at save time.
function buildCatalogMuscleIndex(catalogRows) {
  var index = {};
  catalogRows.forEach(function(row) {
    var entry = { id: row.id, family: row.family || null, muscle_groups_primary: row.muscle_groups_primary || [], muscle_groups_secondary: row.muscle_groups_secondary || [] };
    var ck = catalogNormKey(row.canonical_name);
    if (ck) index[ck] = entry;
    (row.aliases || []).forEach(function(a) {
      var ak = catalogNormKey(a);
      if (ak && !index[ak]) index[ak] = entry; // canonical_name wins on a collision
    });
  });
  return index;
}

// Creates a new source:'custom' catalog row for a genuinely new exercise.
// Read-only callers (fuzzy/exact matching) never call this — only the Haiku
// "declare it new" branch and the Part 4 "keep as typed" picker action do.
async function createCustomCatalogEntry(canonicalName, category) {
  var r = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog", {
    method: "POST",
    headers: sbHeaders("return=representation"),
    body: JSON.stringify({
      canonical_name: canonicalName,
      aliases: [],
      category: ['strength', 'cardio', 'martial_arts', 'sports', 'mind_body', 'rehab', 'other'].indexOf(category) >= 0 ? category : 'other',
      source: 'custom',
    }),
  });
  var rows = await r.json();
  // A concurrent save creating the same name races the UNIQUE(canonical_name)
  // constraint — on conflict, just re-read the existing row rather than
  // failing the save over a benign race.
  if (!r.ok) {
    var existing = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?canonical_name=eq." + encodeURIComponent(canonicalName) + "&select=id,canonical_name", { headers: sbHeaders() });
    var existingRows = await existing.json();
    return (Array.isArray(existingRows) && existingRows[0]) || null;
  }
  return Array.isArray(rows) ? rows[0] : rows;
}

// Haiku fallback for a name that missed both exact/alias and fuzzy matching.
// Deliberately a SEPARATE small call, not folded into the main
// extract-exercises prompt (audited before building): the main prompt runs
// unconditionally on every save regardless of whether any name is actually
// ambiguous, and the catalog is large (1900+ MuscleWiki entries once
// seeded) — stuffing it into that prompt would bloat every single save's
// token cost even on the common all-exact-match case Part 3 is supposed to
// keep instant/free. A small supplementary call, invoked only for the
// leftover handful of genuinely ambiguous names per save (typically zero),
// keeps token cost proportional to actual ambiguity instead.
async function haikuResolveExerciseName(rawName, candidates) {
  var candidateList = candidates.map(function(c) { return c.canonical_name; }).join(', ') || '(none)';
  var prompt = "An exercise-logging app extracted the raw name \"" + rawName + "\" from a workout. " +
    "Here are the closest existing catalog entries by spelling similarity: " + candidateList + ". " +
    "Does \"" + rawName + "\" refer to the SAME exercise as one of those candidates (just a different spelling/phrasing), " +
    "or is it a genuinely DIFFERENT exercise? Be conservative — a wrong merge (e.g. treating \"hang clean\" as \"Dead Hang\") is worse than creating a new entry. " +
    "Respond with ONLY one line: either the exact candidate name if it's the same exercise, or \"NEW: <Proper Case Exercise Name>\" if it's different. No explanation.";
  var text = await callAI(prompt, 60, MODEL_HAIKU);
  var trimmed = (text || '').trim();
  if (!trimmed) return null;
  var newMatch = /^NEW:\s*(.+)$/i.exec(trimmed);
  if (newMatch) return { isNew: true, name: newMatch[1].trim().replace(/["']/g, '') };
  var exactCandidate = candidates.find(function(c) { return c.canonical_name.toLowerCase() === trimmed.toLowerCase(); });
  if (exactCandidate) return { isNew: false, row: exactCandidate };
  return null; // Haiku returned something unparseable — treat as unresolved, never guess.
}

// Main resolution entry point. Never throws — any internal failure (catalog
// fetch down, Haiku error, malformed response) degrades to
// { canonicalName: name, method: 'unavailable' }, i.e. exactly today's
// pre-catalog behavior (whatever normalizeExerciseName() already produced),
// so a save NEVER blocks on this. `method` distinguishes two very different
// "didn't confidently resolve" cases for the frontend chip (Part 4):
// 'unavailable' (the catalog system itself failed — stay SILENT, no chip,
// since spamming a chip on every save because the table's briefly
// unreachable would be worse than the fragmentation problem this fixes) vs
// 'unmatched' (the catalog is fine, Haiku ran and genuinely couldn't decide
// — show a chip, this is a real new-to-the-app exercise worth flagging).
// Read-only EXACT/ALIAS resolution — the top-confidence tier ONLY (no fuzzy,
// no Haiku, no writes). Returns { canonical_name, method:'exact'|'alias' } or
// null. Extracted from resolveExerciseCatalog's own step-1 block (which now
// calls this) so the save-time path and the read-only display-time linking
// path (resolve-batch, below) share ONE implementation and can never drift —
// a link is only ever emitted when the name normalizes identically to a
// catalog canonical_name or alias, the same bar as save-time method:'exact'/
// 'alias'. Never the fuzzy/Haiku tiers (those are exactly what can mis-merge).
function matchCatalogExactAlias(name, catalog) {
  var key = catalogNormKey(name);
  if (!key) return null;
  var exactRow = catalog.find(function(row) {
    if (catalogNormKey(row.canonical_name) === key) return true;
    return (row.aliases || []).some(function(a) { return catalogNormKey(a) === key; });
  });
  if (!exactRow) return null;
  var isAliasHit = catalogNormKey(exactRow.canonical_name) !== key;
  return { canonical_name: exactRow.canonical_name, method: isAliasHit ? 'alias' : 'exact' };
}

// Strips a trailing set/rep/weight/duration annotation off a freeform AI-rec
// exercise line ("Bench Press 3x8 @ 135lbs" -> "Bench Press") so the leading
// exercise NAME can be exact/alias-matched. CONSERVATIVE by design: the name
// is everything before the first digit / '@' / '(' / spaced separator
// (-,–,—,:); catalog exercise names are word-only so this never truncates a
// real name, and a line that leads with a number ("3 rounds of burpees") or is
// a compound ("Superset: A + B") yields something that simply misses the
// exact/alias match -> stays plain text. Never guesses.
function stripExerciseAnnotation(raw) {
  if (!raw) return '';
  var s = String(raw).trim();
  var cut = s.search(/[\d@(]|\s[-–—:]\s/);
  var name = (cut >= 0 ? s.slice(0, cut) : s);
  return name.replace(/[\s,;:+\-–—]+$/, '').trim();
}

async function resolveExerciseCatalog(name, category, requestCache) {
  var result = { canonicalName: name, method: 'unavailable', typedName: null, candidates: [] };
  try {
    if (!requestCache.catalog) requestCache.catalog = await fetchExerciseCatalogForMatching();
    var catalog = requestCache.catalog;
    if (!catalog.length) return result; // empty/unseeded catalog -> unavailable, silent fallback

    var key = catalogNormKey(name);
    if (!key) return result;

    // 1. Exact / alias match — shared with the read-only resolve-batch endpoint
    // via matchCatalogExactAlias (single implementation, never reimplemented).
    var exactMatch = matchCatalogExactAlias(name, catalog);
    if (exactMatch) {
      var isAliasHit = exactMatch.method === 'alias';
      return { canonicalName: exactMatch.canonical_name, method: exactMatch.method, typedName: isAliasHit ? name : null, candidates: [] };
    }

    // 2. Fuzzy match — score every canonical_name + alias, keep the best.
    var best = null, bestScore = 0;
    catalog.forEach(function(row) {
      var names = [row.canonical_name].concat(row.aliases || []);
      names.forEach(function(n) {
        var score = levenshteinSimilarity(key, catalogNormKey(n));
        if (score > bestScore) { bestScore = score; best = row; }
      });
    });
    if (best && key.length >= CATALOG_FUZZY_MIN_KEY_LEN && bestScore >= CATALOG_FUZZY_MIN_SIMILARITY) {
      return { canonicalName: best.canonical_name, method: 'fuzzy', typedName: name, candidates: [] };
    }

    // 3. Haiku fallback — top 3 fuzzy candidates (even sub-threshold ones)
    // as context, regardless of whether step 2 found anything usable.
    var scored = catalog.map(function(row) {
      var names = [row.canonical_name].concat(row.aliases || []);
      var s = Math.max.apply(null, names.map(function(n) { return levenshteinSimilarity(key, catalogNormKey(n)); }));
      return { row: row, score: s };
    }).sort(function(a, b) { return b.score - a.score; }).slice(0, 3);
    var candidateRows = scored.map(function(s) { return s.row; });

    var haikuResult = await haikuResolveExerciseName(name, candidateRows);
    if (!haikuResult) return { canonicalName: name, method: 'unmatched', typedName: name, candidates: candidateRows.map(function(r) { return r.canonical_name; }) };
    if (haikuResult.isNew) {
      var created = await createCustomCatalogEntry(haikuResult.name, category);
      var finalName = (created && created.canonical_name) || haikuResult.name;
      // Cache the new row for the rest of THIS save's loop, so two variants
      // of the same brand-new exercise in one workout don't create two rows.
      requestCache.catalog.push({ id: created && created.id, canonical_name: finalName, aliases: [] });
      return { canonicalName: finalName, method: 'custom', typedName: name, candidates: [] };
    }
    return { canonicalName: haikuResult.row.canonical_name, method: 'haiku', typedName: name, candidates: [] };
  } catch (e) {
    console.error("[ExerciseCatalog] resolution failed for '" + name + "':", e && e.message);
    return result; // unavailable — silent fallback, save proceeds unaffected
  }
}

// The "nothing to insert" result for extract-exercises. Kept identical in shape
// to the normal response (2026-07-19) so every caller sees one stable contract —
// previously these early returns omitted the counters entirely, which made the
// no-exercises case indistinguishable from an older server that couldn't report
// failures at all.
function emptyExtractResult() {
  return {
    success: true, exercises: [], count: 0,
    attempted: 0, failed: 0, partial_failure: false, failures: [],
  };
}

// Turns a raw PostgREST error body into a short, human-readable cause for a
// failed exercises INSERT (2026-07-19). Purely descriptive — it never changes
// control flow. The numeric case is the one that has actually bitten: the
// extraction prompt emits fractional minutes (0.5 / 0.75 / 1.25) that an
// integer duration_minutes column rejects outright.
// See migrations/2026-07-19_exercises_duration_numeric.sql.
function classifyInsertFailure(errText, ex) {
  var t = String(errText || "").toLowerCase();
  var dm = ex && ex.duration_minutes;
  var fractional = typeof dm === "number" && isFinite(dm) && dm % 1 !== 0;
  if (fractional && (t.indexOf("invalid input syntax for type integer") >= 0 ||
                     t.indexOf("invalid input syntax") >= 0 ||
                     t.indexOf("numeric") >= 0 || t.indexOf("integer") >= 0)) {
    return "fractional_duration_rejected";
  }
  if (fractional) return "possible_fractional_duration";
  if (t.indexOf("duplicate key") >= 0) return "duplicate";
  if (t.indexOf("foreign key") >= 0) return "fk_violation";
  if (t.indexOf("violates check constraint") >= 0) return "check_constraint";
  if (t.indexOf("null value in column") >= 0) return "not_null_violation";
  return "unknown";
}

// Shared extraction step (2026-07-19). Builds the extraction prompt, calls the
// model, and parses the JSON array out of the reply. Factored out of the
// extract-exercises endpoint so the recovery/re-merge endpoint runs the EXACT
// same prompt, model and temperature — one implementation, no drift between the
// live save path and a recovery pass.
// Returns { list: [...] } or { error: "...", list: [] }. Never throws.
async function extractExercisesFromNotes(body) {
  var prompt = "STRICT RULE: Only extract exercises that are explicitly named in the raw text. Never infer, assume, or hallucinate exercises or weights that are not clearly stated. If a weight is ambiguous or missing, omit weight_lbs entirely. Do not extract stretches, mobility work, or warm-ups as weighted exercises unless they explicitly include sets, reps, and weight.\n\nExtract all exercises from these workout notes. For each exercise identify: name (normalized), category (one of: strength/combat/cardio/mobility/rehab/core/other), sets (number or null), reps (number or null), weight_lbs (number or null), distance_miles (number or null), duration_minutes (number or null), raw_text (original text snippet).\n\nCATEGORY GUIDE:\n- strength: weightlifting, resistance, dumbbell/barbell work, push-up, pull-up, dip, squat, lunge, row, dead hang (isometric grip/hang holds)\n- combat: MMA, boxing, sparring, martial arts, kicks, grappling, BJJ, pad work\n- cardio: running, elliptical, jumping jacks, cycling, rowing, burpee, jump rope\n- mobility: stretching, yoga, flexibility work\n- rehab: PT exercises, injury rehab, therapeutic (glute bridge, clamshell, cat-cow, hip flexor stretch)\n- core: plank, crunch, sit-up, leg raise, dead bug, bird dog, mountain climber, ab wheel, russian twist, windshield wiper - these are ALWAYS 'core' not 'strength'\n- other: anything else\n\nCRITICAL NORMALIZATION RULES:\n- Always use singular form: 'Glute Bridge' not 'Glute Bridges'\n- Capitalize first letter of each word\n- Use hyphens for compound exercises: 'Push-Up', 'Pull-Up', 'Sit-Up', 'Cat-Cow'\n- Remove trailing s from plural exercise names\n\nMANDATORY DEAD HANG RULE (NON-NEGOTIABLE):\n- ANY mention of \"dead hang\", \"dead hangs\", \"hang\" (when referring to a bar hold, not a noun/verb in unrelated context), \"bar hang\", \"passive hang\", \"hang hold\", or \"hanging\" (as an isometric exercise) MUST produce its own exercise object in the output array — even when it appears alongside many other exercises in the workout notes, even when listed as a single line, even when it has no sets/reps annotation. NEVER skip a dead-hang entry because the surrounding notes are long.\n- name MUST be \"Dead Hang\" (canonical) regardless of how the user phrased it (\"dead hangs\", \"bar hang\", \"hang hold\", etc).\n- category MUST be \"strength\".\n- duration_minutes MUST be populated whenever the raw text contains a duration (any of: \"Ns\", \"N seconds\", \"N sec\", \"N min\", \"M:SS\", \"Xm Ys\", \"X min Y sec\"). Compute it as total_seconds / 60 — examples: \"45 seconds\" → 0.75; \"1:42\" → 1.7; \"1 min 15 sec\" → 1.25; \"30s\" → 0.5; \"1m 42s\" → 1.7. Use the per-set (single-hold) duration, not the sum across sets.\n- sets MUST be populated if the raw text contains set notation (\"3x20s\", \"4x30 seconds\" → sets=3 or 4; per-set duration goes in duration_minutes). For a single hold with no set notation, sets=1.\n- raw_text MUST be the literal hang substring from the user's notes.\n- If the notes contain TWO separate dead hang entries (e.g. \"Dead Hang 0:45\" on one line and \"Dead Hang 0:30\" on another, or \"45s dead hang\" twice), produce TWO exercise objects — do not collapse into one.\n\nDATA INTEGRITY RULES (NON-NEGOTIABLE):\n- NEVER invent or assume weights, reps, sets, distances, or durations that are not explicitly stated in the raw text. The raw text is the only source of truth.\n- If a field is ambiguous, missing, or you are not 100% certain, OMIT it entirely (use null). Better to under-report than to fabricate.\n- Do NOT guess weights based on the exercise name (e.g. don't assume bench press is 135lb just because that's a common starting weight).\n- Do NOT carry over weights from one exercise to another — each exercise's fields must come from its own portion of the raw text.\n- Do NOT infer weight from words like 'heavy' or 'light' — those are not numeric values.\n- The raw_text field MUST be the literal substring from the user's notes that this exercise was extracted from. If the substring doesn't contain the weight, weight_lbs MUST be null.\n\nReturn ONLY a JSON array of exercise objects, no explanation.\nExample: [{\"name\":\"Glute Bridge\",\"category\":\"rehab\",\"sets\":3,\"reps\":12,\"weight_lbs\":null,\"distance_miles\":null,\"duration_minutes\":null,\"raw_text\":\"glute bridges 3x12\"},{\"name\":\"Dead Hang\",\"category\":\"strength\",\"sets\":4,\"reps\":null,\"weight_lbs\":null,\"distance_miles\":null,\"duration_minutes\":0.5,\"raw_text\":\"Dead Hangs 4x30s\"}]\nWorkout type: " + (body.type || "unknown") + "\nNotes: " + body.notes;
  // temperature 0: extraction is deterministic-intent — identical notes must
  // yield identical rows, or re-running it silently adds/drops exercises.
  // Measured 2026-07-19 (workout 87): default temp gave 3 different results
  // across 4 identical calls (7/8/4/8 rows); temperature 0 gave 1 result x4.
  var aiText = await callAI(prompt, 1000, MODEL_HAIKU, 0);
  console.log("[extract-exercises] Raw AI response: " + (aiText || "(empty)").substring(0, 300));
  try {
    var startIdx = aiText.indexOf("[");
    var endIdx = aiText.lastIndexOf("]");
    if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
      return { error: "No JSON array found in AI response", list: [] };
    }
    var parsed = JSON.parse(aiText.substring(startIdx, endIdx + 1));
    return { list: Array.isArray(parsed) ? parsed : [] };
  } catch (parseErr) {
    return { error: "JSON parse error: " + parseErr.message + " | raw: " + String(aiText).substring(0, 200), list: [] };
  }
}

app.post("/api/profiles/:id/extract-exercises", async function(req, res) {
  try {
    var profileId = req.params.id;
    var body = req.body;
    if (!body.notes || !body.notes.trim()) {
      console.log("[extract-exercises] No notes provided, skipping");
      return res.json(emptyExtractResult());
    }

    console.log("[extract-exercises] Processing notes for profile " + profileId + ": " + body.notes.substring(0, 100) + "...");

    var extracted = await extractExercisesFromNotes(body);
    if (extracted.error) {
      console.error("[extract-exercises] " + extracted.error);
      return res.json(emptyExtractResult());
    }
    var exercises = extracted.list;

    console.log("[extract-exercises] AI returned " + exercises.length + " exercises");

    // Insert into Supabase
    var inserted = 0;
    // Per-row insert failures (2026-07-19). Previously a failed INSERT was
    // logged to console.error and the loop continued, while the response still
    // reported success:true with no indication a row had been dropped — so a
    // rejected row was destroyed silently and neither the client nor the user
    // ever learned. Failures are now collected and returned in the response.
    // The loop still CONTINUES on failure (partial saves are intentional).
    var failures = [];
    var catalogRequestCache = {}; // shared across this call's loop — see resolveExerciseCatalog
    for (var i = 0; i < exercises.length; i++) {
      var ex = exercises[i];
      if (!ex.name) continue;
      // normalizeExerciseName() stays authoritative and runs FIRST, unchanged
      // — the catalog resolution below only activates for names it didn't
      // already fully resolve (see the "EXERCISE CATALOG" section above for
      // why this ordering can never disagree with the existing hand-fix).
      ex.name = normalizeExerciseName(ex.name);
      var aiCat = ex.category;
      ex.category = normalizeCategory(ex.name, aiCat);
      ex.main_category = ex.category;
      ex.subcategory = getSubcategory(ex.name, aiCat, ex.category);

      var catalogMatch = await resolveExerciseCatalog(ex.name, ex.category, catalogRequestCache);
      ex.name = catalogMatch.canonicalName;
      // Surfaced in the response (not persisted as a column) so Part 4's
      // frontend chip can decide, per exercise, whether to show a confirm
      // chip. Standing rule (2026-07-16): only 'exact' saves silently —
      // 'alias' hits are a genuine variant-vs-generic merge decision (e.g.
      // "Curl" -> Bicep Curl), not a cosmetic normalization, and must always
      // be confirmed, same as fuzzy/haiku/custom. 'unavailable' is the one
      // other silent case (the catalog itself failed/is empty — showing a
      // chip on every save because the table's briefly unreachable would be
      // worse than the fragmentation problem this feature fixes).
      ex.catalog_match = { method: catalogMatch.method, typed_name: catalogMatch.typedName };

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
        headers: sbHeaders("return=representation"),
        body: JSON.stringify(insertBody),
      });
      if (insertRes.ok) {
        inserted++;
        var insertedRows = await insertRes.json();
        var insertedRow = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;
        if (insertedRow && insertedRow.id) ex.id = insertedRow.id; // lets the frontend chip target the exact row for "change"
      } else {
        var errText = await insertRes.text();
        console.error("[extract-exercises] Supabase insert error for '" + ex.name + "':", insertRes.status, errText);
        // Surface it instead of swallowing it. Marked on the exercise object
        // too, so a caller iterating `exercises` can flag the exact entry.
        ex.insert_failed = true;
        failures.push({
          name: ex.name,
          raw_text: ex.raw_text || null,
          duration_minutes: ex.duration_minutes == null ? null : ex.duration_minutes,
          status: insertRes.status,
          error: String(errText || "").slice(0, 300),
          reason: classifyInsertFailure(errText, ex),
        });
      }
    }
    var attempted = exercises.filter(function(e) { return e && e.name; }).length;
    console.log(
      "[extract-exercises] Inserted " + inserted + "/" + attempted + " exercises into Supabase" +
      (failures.length ? " — " + failures.length + " FAILED: " + failures.map(function(f) { return f.name; }).join(", ") : "")
    );
    // `success` stays true on a PARTIAL save: rows did land, and both existing
    // callers gate real work on it (the confirm chip, and Import History's
    // running total) — flipping it would discard correct results. Total loss
    // (something to insert, nothing landed) IS reported as success:false.
    // `partial_failure` is the flag a caller should check to surface a warning.
    res.json({
      success: !(attempted > 0 && inserted === 0),
      exercises: exercises,
      count: inserted,
      attempted: attempted,
      failed: failures.length,
      partial_failure: failures.length > 0,
      failures: failures,
    });
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

// GET /api/exercise-catalog?q=push — search for the Part 4 "change" picker.
// Not profile-scoped (the catalog is global, not per-athlete). Plain ilike
// substring search on canonical_name; small enough result sets that a
// full-text/fuzzy search isn't warranted here (that's what save-time
// resolveExerciseCatalog() is for — this is just a manual browse/search).
app.get("/api/exercise-catalog", async function(req, res) {
  try {
    var q = (req.query.q || "").trim();
    // Extended for the Library "Guide" browse view (Exercise Canonicalization
    // phase 2 continuation, 2026-07-16): family/muscle_groups_primary/
    // secondary/equipment added, additive/read-only, no schema change. The
    // original confirm-chip search (?q=, capped 50, sans these fields being
    // load-bearing there) is unchanged in shape/behavior — it just gets a few
    // extra harmless fields now too. ?all=1 bypasses the 50 cap for Guide's
    // one bulk load of the whole ~880-row catalog (still capped at 2000 as a
    // sane ceiling, comfortably above current catalog size).
    var all = req.query.all === "1";
    var limit = all ? 2000 : (parseInt(req.query.limit, 10) || 50);
    var offset = parseInt(req.query.offset, 10) || 0;
    var url = SUPABASE_URL + "/rest/v1/exercise_catalog?select=id,canonical_name,category,is_duration_based,family,muscle_groups_primary,muscle_groups_secondary,equipment&order=canonical_name.asc&limit=" + limit + "&offset=" + offset;
    if (q) url += "&canonical_name=ilike." + encodeURIComponent("*" + q + "*");
    var r = await fetch(url, { headers: sbHeaders() });
    var rows = await r.json();
    res.json({ success: true, results: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/exercise-catalog/resolve-batch  { names: ["Bench Press 3x8 @135", …] }
// Read-only, display-time linking for AI-rec exercise lines (renderAI,
// public/index.html). For each freeform string: strip its set/rep/weight
// annotation (stripExerciseAnnotation), then EXACT/ALIAS match ONLY (shared
// matchCatalogExactAlias — the same top-confidence tier as save-time
// method:'exact'/'alias'). Deliberately does NOT call resolveExerciseCatalog:
// that path's Haiku fallback CREATES source:'custom' rows, and a browse
// surface must never spawn catalog rows just from someone viewing a rec. So:
// NO fuzzy, NO Haiku, NO writes. A miss returns null → the client renders
// plain text, never a low-confidence link. Not admin-gated (normal user flow).
// Fully non-fatal: any failure returns empty results → everything stays plain
// text, exactly as before this feature existed.
app.post("/api/exercise-catalog/resolve-batch", async function(req, res) {
  try {
    var names = Array.isArray(req.body && req.body.names) ? req.body.names : [];
    var results = {};
    if (!names.length) return res.json({ success: true, results: results, matched: 0, total: 0 });
    var catalog = await fetchExerciseCatalogForMatching();
    names.forEach(function(raw) {
      if (typeof raw !== "string" || raw in results) return; // skip non-strings + dedupe
      var clean = stripExerciseAnnotation(raw);
      var match = clean ? matchCatalogExactAlias(clean, catalog) : null;
      results[raw] = match ? match.canonical_name : null; // keyed by the RAW string the client holds
    });
    var keys = Object.keys(results);
    var matched = keys.filter(function(k) { return results[k]; }).length;
    res.json({ success: true, results: results, matched: matched, total: keys.length });
  } catch (e) {
    console.error("[ResolveBatch] failed (non-fatal):", e.message);
    res.json({ success: true, results: {}, matched: 0, total: 0 }); // degrade → all plain text
  }
});

// POST /api/exercise-catalog/confirm-alias
// Body: { canonical_name, typed_name }. Fired by the Part 4 confirm chip
// (ecDismissChip(), public/index.html) when the athlete confirms — tap or
// 8s auto-dismiss, treated identically — an alias/fuzzy/haiku/custom match.
// Persists what they actually typed as an alias on the resolved catalog row
// so the SAME typed variant hits the free exact/alias path next time instead
// of repeating fuzzy/Haiku resolution. Not admin-gated (a normal user-flow
// side effect, not a curation tool). Idempotent, silent-fail, never blocks
// the chip UI: no-op if the row doesn't exist, if typed_name normalizes
// identically to canonical_name (nothing to add — covers the 'alias' method,
// which is already an alias by construction), or if it's already present.
app.post("/api/exercise-catalog/confirm-alias", async function(req, res) {
  try {
    var b = req.body || {};
    var canonicalName = b.canonical_name;
    var typedName = b.typed_name;
    if (!canonicalName || !typedName) return res.json({ success: true, action: "skipped" });
    var key = catalogNormKey(typedName);
    if (!key || key === catalogNormKey(canonicalName)) return res.json({ success: true, action: "skipped" });

    var r = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?canonical_name=eq." + encodeURIComponent(canonicalName) + "&select=id,aliases", { headers: sbHeaders() });
    var rows = await r.json();
    var row = Array.isArray(rows) && rows[0];
    if (!row) return res.json({ success: true, action: "skipped" });

    var aliases = row.aliases || [];
    var already = aliases.some(function(a) { return catalogNormKey(a) === key; });
    if (already) return res.json({ success: true, action: "already_present" });

    var patchRes = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + row.id, {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify({ aliases: aliases.concat([typedName]), updated_at: new Date().toISOString() }),
    });
    if (!patchRes.ok) return res.json({ success: true, action: "failed" });
    res.json({ success: true, action: "added", canonical_name: canonicalName, alias: typedName });
  } catch (e) {
    console.error("[ConfirmAlias] failed:", e.message);
    res.json({ success: true, action: "failed" }); // never surfaces as an error to the confirm-chip UI
  }
});

// PATCH /api/profiles/:id/exercises/:exerciseId — the Part 4 "change" action
// on an already-saved exercise row. Two modes via body:
//   { canonical_name }        -> rename the row to an EXISTING catalog entry
//                                 (picked from the GET /api/exercise-catalog
//                                 search above).
//   { keep_as_typed: true }   -> the athlete rejects every suggestion; creates
//                                 a new source:'custom' catalog row from
//                                 whatever they originally typed and renames
//                                 the exercise row to match. This is the ONLY
//                                 place besides the Haiku "declare it new"
//                                 branch that creates a custom catalog entry
//                                 — both go through the same
//                                 createCustomCatalogEntry() helper, so a
//                                 manually-confirmed custom exercise and an
//                                 AI-declared one are indistinguishable rows.
// A wrong silent merge is worse than one tap (per the design brief) — this
// endpoint is the "one tap" undo path, not a bulk operation.
app.patch("/api/profiles/:id/exercises/:exerciseId", async function(req, res) {
  try {
    var pid = req.params.id;
    var eid = req.params.exerciseId;
    var body = req.body || {};
    var check = await fetch(SUPABASE_URL + "/rest/v1/exercises?id=eq." + eid + "&profile_id=eq." + pid + "&select=id,name,category", { headers: sbHeaders() });
    var rows = await check.json();
    var existingRow = Array.isArray(rows) && rows[0];
    if (!existingRow) return res.status(404).json({ success: false, error: "Not found for this profile" });

    var newName;
    if (body.keep_as_typed) {
      var typed = (body.typed_name || existingRow.name || "").trim();
      if (!typed) return res.status(400).json({ success: false, error: "typed_name required for keep_as_typed" });
      var created = await createCustomCatalogEntry(typed, existingRow.category);
      newName = (created && created.canonical_name) || typed;
    } else if (body.canonical_name) {
      newName = String(body.canonical_name).trim();
      if (!newName) return res.status(400).json({ success: false, error: "canonical_name required" });
    } else {
      return res.status(400).json({ success: false, error: "canonical_name or keep_as_typed required" });
    }

    var patchRes = await fetch(SUPABASE_URL + "/rest/v1/exercises?id=eq." + eid, {
      method: "PATCH",
      headers: sbHeaders("return=representation"),
      body: JSON.stringify({ name: newName }),
    });
    if (!patchRes.ok) {
      var t = await patchRes.text();
      return res.status(patchRes.status).json({ success: false, error: t });
    }
    var patched = await patchRes.json();
    res.json({ success: true, exercise: Array.isArray(patched) ? patched[0] : patched });
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

    // Phase-2 catalog attach (family/muscle groups) for Library rollups,
    // muscle-group filtering, and the muscle heatmap — see "Exercise
    // Canonicalization" phase 2 in CLAUDE.md. Never blocks the response: any
    // failure just leaves these null on every row, the same 'unavailable'
    // degrade philosophy resolveExerciseCatalog() itself uses.
    try {
      var catalogRows = await fetchExerciseCatalogWithMuscleData();
      var catalogIndex = buildCatalogMuscleIndex(catalogRows);
      summary.forEach(function(g) {
        var match = catalogIndex[catalogNormKey(g.name)];
        g.family = match ? match.family : null;
        g.muscle_groups_primary = match ? match.muscle_groups_primary : null;
        g.muscle_groups_secondary = match ? match.muscle_groups_secondary : null;
      });
    } catch (e) {
      console.error("[Library] catalog attach failed (non-fatal):", e.message);
      summary.forEach(function(g) { g.family = null; g.muscle_groups_primary = null; g.muscle_groups_secondary = null; });
    }

    res.json({ success: true, exercises: summary, raw: exercises });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/profiles/:id/exercises/stats", async function(req, res) {
  try {
    var profileId = req.params.id;

    // Profile (timezone only) fetched alongside — anchors the "last 12
    // weeks" weekly-volume cutoff below via localToday() instead of the
    // server's own instant.
    var profilePromise = getProfileTimezone(profileId);

    // Fetch all exercises
    var er = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + profileId + "&select=*&order=date.desc&limit=10000", { headers: sbHeaders() });
    var allEx = await er.json();
    if (!Array.isArray(allEx)) allEx = [];

    // Fetch all workouts for type frequency
    var wr = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + profileId + "&select=type,date,done&order=date.desc&limit=10000", { headers: sbHeaders() });
    var allWk = await wr.json();
    if (!Array.isArray(allWk)) allWk = [];

    var statsProfile = await profilePromise;

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

    // Weekly volume (last 12 weeks). Anchored to the athlete's local "today"
    // (localToday()), noon-anchored like the exercise-date parse below, so
    // the 12-week cutoff can't drift a day off from a server-vs-athlete
    // timezone mismatch. weekStart's key is now read via ymdLocal() (local
    // Date components) instead of toISOString() (UTC) for consistency with
    // how weekStart itself was built via local setDate()/getDay() mutation —
    // previously harmless only because Render's OS timezone happens to be UTC.
    var weeklyVol = {};
    var now = new Date(localToday(statsProfile, 0) + "T12:00:00");
    allEx.forEach(function(ex) {
      if (!ex.sets) return;
      var d = new Date(ex.date + "T12:00:00");
      var weekAgo = Math.floor((now - d) / (7 * 86400000));
      if (weekAgo < 12) {
        var weekStart = new Date(d);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        var key = ymdLocal(weekStart);
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

    // Catalog attach (Feature 2, 2026-07-16 continuation) — powers the
    // per-exercise muscle diagram on the Library detail view. Same non-fatal
    // degrade philosophy as the grouped /exercises endpoint's own attach:
    // any failure just leaves these null, never blocks the response.
    var family = null, muscleP = null, muscleS = null;
    var category = null, description = null, images = null, variations = null;
    try {
      var catalogRows = await fetchExerciseCatalogWithMuscleData();
      var catalogIndex = buildCatalogMuscleIndex(catalogRows);
      var match = catalogIndex[catalogNormKey(name)];
      if (match) {
        family = match.family; muscleP = match.muscle_groups_primary; muscleS = match.muscle_groups_secondary;
        // How-to content (description/images/category) is fetched ONLY for the
        // matched row — a single targeted query, so the shared catalog index
        // (used by the grouped /exercises endpoint over ~865 rows) stays lean
        // and never carries the large description text. Non-fatal.
        try {
          var cr = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + match.id + "&select=category,description,images", { headers: sbHeaders() });
          var crow = ((await cr.json()) || [])[0];
          if (crow) { category = crow.category || null; description = crow.description || null; images = Array.isArray(crow.images) ? crow.images : null; }
        } catch (e2) { console.error("[ExerciseDetail] content fetch failed (non-fatal):", e2.message); }

        // Variations (session #27) — resolved at READ time against the LIVE
        // catalog via wger's own variation_group key, so merged/renamed rows
        // resolve to their current names and deleted ones never appear (no dead
        // links) — the group-key approach gives that for free. Kept as its OWN
        // query + try/catch so a pre-migration missing column can't take down
        // the content attach above (that select would otherwise error and null
        // out description/images). Returns null unless there's ≥1 live sibling.
        try {
          var vgr = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + match.id + "&select=variation_group", { headers: sbHeaders() });
          var vgRow = ((await vgr.json()) || [])[0];
          var groupKey = vgRow && vgRow.variation_group;
          if (groupKey) {
            var sibR = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?variation_group=eq." + encodeURIComponent(groupKey) + "&id=neq." + match.id + "&select=canonical_name&order=canonical_name.asc", { headers: sbHeaders() });
            var sibs = await sibR.json();
            if (Array.isArray(sibs) && sibs.length) {
              var sibNames = sibs.map(function(s) { return s.canonical_name; }).filter(Boolean);
              if (sibNames.length) variations = sibNames;
            }
          }
        } catch (e3) { console.error("[ExerciseDetail] variations fetch failed (non-fatal):", e3.message); }
      }
    } catch (e) {
      console.error("[ExerciseDetail] catalog attach failed (non-fatal):", e.message);
    }

    res.json({ success: true, exercise: name, history: history, pr: pr, family: family, muscle_groups_primary: muscleP, muscle_groups_secondary: muscleS, category: category, description: description, images: images, variations: variations });
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

// ── LIFE OS INTEGRATION (read-only daily summary) ─────────────────────────
// Single aggregated read for the separate Life OS app. The DB-backed fields
// are fast (one PostgREST read of the profile row + one of today's workouts);
// the Fitbit block is best-effort behind a hard timeout, so a slow or failing
// wearable call degrades to null sleep/hrv/rhr instead of failing the whole
// response.
//
// Auth (fails closed): requires either X-Life-OS-Key == LIFE_OS_API_KEY, or
// the existing admin secret (X-Admin-Secret header or ?secret= == ADMIN_SECRET)
// for server-to-server calls. If NEITHER env var is configured the endpoint
// refuses to serve data (503) rather than exposing it unauthenticated.
//
// Optional ?date=YYYY-MM-DD overrides "today" (caller's local date) for the
// freshness check + Fitbit fetch; defaults to the server's local date, matching
// how /daily-recs stamps daily_recommendations_date.
app.get("/api/profiles/:id/life-os-summary", async function(req, res) {
  // ── auth gate ──
  var lifeKey = process.env.LIFE_OS_API_KEY;
  var adminKey = process.env.ADMIN_SECRET;
  if (!lifeKey && !adminKey) {
    return res.status(503).json({ error: "integration not configured" });
  }
  var gotLife = req.headers["x-life-os-key"];
  var gotAdmin = req.headers["x-admin-secret"] || req.query.secret;
  var authorized = (lifeKey && gotLife === lifeKey) || (adminKey && gotAdmin === adminKey);
  if (!authorized) return res.status(401).json({ error: "unauthorized" });

  try {
    var pid = req.params.id;
    var dateParam = req.query.date || null;
    // Athlete's timezone (2026-07-15) — was previously computed via the
    // server's own OS-local getters (UTC-equivalent on Render), same bug
    // class as the Coach Chat "today" fix. Non-fatal: defaults to {} → UTC
    // fallback inside localToday() so a DB hiccup here can't break the whole
    // endpoint (dateParam, the external caller's own override, still wins
    // when provided, unaffected by any of this).
    var profileTz = await getProfileTimezone(pid).catch(function() { return {}; });
    var today = dateParam || localToday(profileTz);

    // ── DB read 1: cached readiness + planned workouts off the profile row ──
    var readiness = null;
    var readinessFresh = false;
    var planned = [];
    try {
      // v2 columns are selected too, but tolerated-absent: an unrun v2 migration
      // makes PostgREST return an error OBJECT, so fall back to the v1-only
      // select. This keeps the external Life OS feed working through the
      // deploy/migration window regardless of ordering.
      var v2Select = "daily_recommendations,daily_recommendations_date,daily_recommendations_readiness,profile_data,v2_daily_cache,v2_daily_cache_date";
      var pr = await fetch(
        SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(pid) + "&select=" + v2Select,
        { headers: sbHeaders() }
      );
      var prows = await pr.json();
      if (!Array.isArray(prows)) {
        pr = await fetch(
          SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(pid) +
            "&select=daily_recommendations,daily_recommendations_date,daily_recommendations_readiness,profile_data",
          { headers: sbHeaders() }
        );
        prows = await pr.json();
      }
      if (!prows || !prows.length) return res.status(404).json({ error: "Profile not found" });
      var prow = prows[0];
      var isV2 = prow.profile_data && prow.profile_data.engine_v2 === true;

      if (isV2) {
        // ENGINE v2 branch (approved Phase 1 decision). A v2 profile's
        // daily_recommendations columns are intentionally EMPTY, so reading them
        // would serve the external app a stale/blank plan. Read the v2 cache
        // instead. Read-only; no shape leak — planned[] stays {headline,category,
        // duration}. readiness stays null: v2 readiness is baseline-relative and
        // has no single 0-100 score to hand out here, and inventing one would be
        // worse than null (Life OS already treats readiness as optional).
        var freshV2 = prow.v2_daily_cache_date === today;
        readinessFresh = freshV2;
        if (freshV2 && prow.v2_daily_cache && prow.v2_daily_cache.today) {
          var t = prow.v2_daily_cache.today;
          planned = [{
            headline: t.headline || (t.category ? (String(t.category) + " session") : null),
            category: t.category || null,
            duration: (typeof t.duration_min === "number") ? t.duration_min : null,
          }];
        }
      } else {
        // v1 path — unchanged.
        readinessFresh = prow.daily_recommendations_date === today;
        if (readinessFresh) {
          readiness = (typeof prow.daily_recommendations_readiness === "number")
            ? prow.daily_recommendations_readiness : null;
          var opts = (prow.daily_recommendations && Array.isArray(prow.daily_recommendations.options))
            ? prow.daily_recommendations.options : [];
          planned = opts.map(function(o) {
            return {
              headline: o.headline || null,
              category: o.category || o.type || null,
              duration: (typeof o.duration === "number") ? o.duration
                : (typeof o.duration_minutes === "number" ? o.duration_minutes : null),
            };
          });
        }
      }
    } catch (e) {
      console.error("[LifeOS] profile read failed:", e.message);
      // DB hiccup shouldn't 500 the integration — leave readiness null / plan [].
    }

    // ── DB read 2: today's workouts → done flag + type ──
    var workoutDone = false;
    var workoutType = null;
    try {
      var wr = await fetch(
        SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + encodeURIComponent(pid) +
          "&date=eq." + encodeURIComponent(today) + "&select=type,done,ts&order=ts.desc",
        { headers: sbHeaders() }
      );
      var wrows = await wr.json();
      if (Array.isArray(wrows) && wrows.length) {
        // Prefer a completed workout's type; else fall back to the latest logged.
        var doneRow = wrows.find(function(w) { return w.done === true; });
        workoutDone = !!doneRow;
        workoutType = (doneRow || wrows[0]).type || null;
      }
    } catch (e) {
      console.error("[LifeOS] workouts read failed:", e.message);
    }

    // ── sleep / hrv / rhr ──
    var sleep = { hours: null, score: null };
    var hrv = null;
    var rhr = null;

    // Fast path: serve from daily_sleep if we already persisted today's row
    // (after the first successful Fitbit sync). No live Fitbit call, so cold
    // starts / Fitbit slowness can't null these out once a row exists.
    var sleepFromDb = false;
    var num = function(v) { return v == null ? null : (isNaN(Number(v)) ? null : Number(v)); };
    try {
      var sr = await fetch(
        SUPABASE_URL + "/rest/v1/daily_sleep?profile_id=eq." + encodeURIComponent(pid) +
          "&date=eq." + encodeURIComponent(today) +
          "&select=hours,score,hrv,rhr&limit=1",
        { headers: sbHeaders() }
      );
      var srows = await sr.json();
      if (Array.isArray(srows) && srows.length) {
        var srow = srows[0];
        sleep = { hours: num(srow.hours), score: num(srow.score) };
        hrv = num(srow.hrv);
        rhr = num(srow.rhr);
        sleepFromDb = true;
        console.log("[LifeOS] sleep served from daily_sleep (date=" + today + ")");
      }
    } catch (e) {
      console.error("[LifeOS] daily_sleep read failed:", e.message);
    }

    // Fallback: live Fitbit call (best-effort, hard 7s timeout) → then upsert
    // to daily_sleep so subsequent calls today take the fast path above.
    if (!sleepFromDb) {
      var timer = null;
      try {
        var token = await getValidProfileToken(pid);
        var dailyPromise = buildDailyData(token, dateParam, profileTz.timezone);
        dailyPromise.catch(function() {}); // swallow a late rejection if we time out first
        var fit = await Promise.race([
          dailyPromise,
          new Promise(function(_, reject) {
            timer = setTimeout(function() { reject(new Error("fitbit timeout")); }, 7000);
          }),
        ]);
        clearTimeout(timer);
        if (fit && fit.data) {
          var d = fit.data;
          sleep = {
            hours: (d.sleep && typeof d.sleep.hours === "number") ? d.sleep.hours : null,
            score: (d.sleep && typeof d.sleep.score === "number") ? d.sleep.score : null,
          };
          hrv = (typeof d.hrv === "number") ? d.hrv : null;
          rhr = (typeof d.rhr === "number") ? d.rhr : null;
          // Persist for next time (fire-and-forget — don't delay the response).
          var sl = d.sleepSummary;
          if (sl && sl.date && (sleep.hours != null || sleep.score != null || hrv != null || rhr != null)) {
            upsertDailySleep(pid, sl).catch(function(e) {
              console.error("[LifeOS] daily_sleep upsert failed:", e.message);
            });
          }
        }
      } catch (e) {
        clearTimeout(timer);
        console.error("[LifeOS] fitbit fetch failed/timeout:", e.message);
        // sleep/hrv/rhr stay null — don't fail the response on a wearable problem.
      }
    }

    res.json({
      date: today,
      readiness: readiness,
      readiness_fresh: readinessFresh,
      sleep: sleep,
      hrv: hrv,
      rhr: rhr,
      workout_done: workoutDone,
      workout_type: workoutType,
      planned_workouts: planned,
    });
  } catch (e) {
    console.error("[LifeOS] summary failed:", e.message);
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

// ── EXERCISE CONTEXT HELPERS (roadmap generation + adaptation) ───────────────
// Shared by the per-goal and macro roadmap endpoints to ground AI prompts in
// the athlete's actual logged training. All aggregation is done in Node after a
// PostgREST fetch; numeric columns are coerced via numOrNull(). Dates are
// YYYY-MM-DD local strings (matching the rest of the app).

function ymdNDaysAgo(n) {
  var d = new Date();
  d.setDate(d.getDate() - n);
  return ymdLocal(d); // ymdLocal() is a hoisted function declaration below
}
function weeksSinceYmd(dateStr) {
  if (!dateStr) return null;
  var t = Date.parse(String(dateStr).slice(0, 10) + "T12:00:00");
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (7 * 86400000));
}

// Stop words stripped from goal titles before keyword matching against exercise
// names. Keeps the meaningful nouns ("bench", "muscle", "belt", "hike").
var GOAL_STOP_WORDS = {
  the:1, a:1, an:1, and:1, or:1, to:1, of:1, for:1, in:1, on:1, at:1, by:1, with:1,
  my:1, your:1, his:1, her:1, get:1, getting:1, gain:1, build:1, building:1,
  improve:1, improving:1, better:1, more:1, less:1, do:1, doing:1, be:1, become:1,
  reach:1, hit:1, goal:1, goals:1, want:1, wanting:1, able:1, work:1, working:1,
  into:1, up:1, out:1, per:1, week:1, day:1, daily:1, weekly:1, every:1, some:1,
};
function extractGoalKeywords(title) {
  return String(title || "")
    .toLowerCase()
    .split(/\s+/)
    .map(function(w) { return w.replace(/[^a-z0-9]/g, ""); })
    .filter(function(w) { return w.length >= 3 && !GOAL_STOP_WORDS[w]; });
}

// Per-goal exercise summary over the last N days, filtered to exercises whose
// name partial-matches any goalKeyword (case-insensitive). Returns a compact
// object fed straight into roadmap prompts.
async function getGoalExerciseContext(profileId, goalKeywords, days) {
  days = days || 90;
  var since = ymdNDaysAgo(days);
  var r = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + profileId +
    "&date=gte." + since +
    "&select=name,date,sets,reps,weight_lbs,duration_minutes,distance_miles&order=date.asc&limit=5000",
    { headers: sbHeaders() });
  var rows = await r.json();
  if (!Array.isArray(rows)) rows = [];
  var kws = (goalKeywords || []).map(function(k) { return String(k).toLowerCase(); }).filter(Boolean);
  var matched = kws.length ? rows.filter(function(ex) {
    var n = String(ex.name || "").toLowerCase();
    return kws.some(function(k) { return n.indexOf(k) >= 0; });
  }) : [];
  if (!matched.length) {
    return { total_sessions: 0, last_session_date: null, best_set: null, recent_volume: [], trend: "insufficient_data", weeks_since_last: null };
  }

  // Per-day rollup (matched is asc by date). Tracks max metric values per day.
  var dayMap = {};
  var order = [];
  matched.forEach(function(ex) {
    var d = ex.date;
    if (!d) return;
    if (!dayMap[d]) { dayMap[d] = { date: d, sets: 0, reps: null, weight_lbs: null, duration_minutes: null }; order.push(d); }
    var slot = dayMap[d];
    slot.sets += (numOrNull(ex.sets) || 0);
    var rp = numOrNull(ex.reps); if (rp != null && (slot.reps == null || rp > slot.reps)) slot.reps = rp;
    var w = numOrNull(ex.weight_lbs); if (w != null && (slot.weight_lbs == null || w > slot.weight_lbs)) slot.weight_lbs = w;
    var dm = numOrNull(ex.duration_minutes); if (dm != null && (slot.duration_minutes == null || dm > slot.duration_minutes)) slot.duration_minutes = dm;
  });
  var distinctDays = order;
  var lastDate = distinctDays[distinctDays.length - 1];

  // Personal best across all matched rows.
  var best_set = { weight_lbs: null, reps: null, duration_minutes: null };
  matched.forEach(function(ex) {
    var w = numOrNull(ex.weight_lbs), rp = numOrNull(ex.reps), dm = numOrNull(ex.duration_minutes);
    if (w != null && (best_set.weight_lbs == null || w > best_set.weight_lbs)) best_set.weight_lbs = w;
    if (rp != null && (best_set.reps == null || rp > best_set.reps)) best_set.reps = rp;
    if (dm != null && (best_set.duration_minutes == null || dm > best_set.duration_minutes)) best_set.duration_minutes = dm;
  });

  // recent_volume — last 3 sessions: { date, sets, reps, weight_lbs }.
  var recent_volume = distinctDays.slice(-3).map(function(d) {
    var s = dayMap[d];
    return { date: s.date, sets: s.sets, reps: s.reps, weight_lbs: s.weight_lbs };
  });

  // Trend — has max weight (or reps, or duration) increased over the period?
  // Compare the best metric in the first half of sessions vs the second half.
  var trend = "insufficient_data";
  if (distinctDays.length >= 2) {
    var metricType = best_set.weight_lbs != null ? "weight_lbs"
                   : best_set.reps != null ? "reps" : "duration_minutes";
    var bestIn = function(daysArr) {
      var hi = null;
      daysArr.forEach(function(d) { var v = dayMap[d][metricType]; if (v != null && (hi == null || v > hi)) hi = v; });
      return hi;
    };
    var mid = Math.ceil(distinctDays.length / 2);
    var early = bestIn(distinctDays.slice(0, mid));
    var late = bestIn(distinctDays.slice(mid));
    if (early == null || late == null) trend = "plateauing";
    else if (late > early) trend = "improving";
    else if (late < early) trend = "declining";
    else trend = "plateauing";
  }

  return {
    total_sessions: distinctDays.length,
    last_session_date: lastDate,
    best_set: best_set,
    recent_volume: recent_volume,
    trend: trend,
    weeks_since_last: weeksSinceYmd(lastDate),
  };
}

// Overall training picture over the last N days: top exercises, ones that have
// gone stale, category mix, and consistency. Used to give roadmaps a holistic
// view of what the athlete is (and isn't) actually doing.
async function getFullExerciseContext(profileId, days) {
  days = days || 60;
  var since = ymdNDaysAgo(days);
  var er = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + profileId +
    "&date=gte." + since +
    "&select=name,date,sets,reps,weight_lbs,duration_minutes,main_category,category&order=date.desc&limit=5000",
    { headers: sbHeaders() });
  var ex = await er.json();
  if (!Array.isArray(ex)) ex = [];
  var wr = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + profileId +
    "&date=gte." + since + "&select=date,type,done&order=date.desc&limit=2000",
    { headers: sbHeaders() });
  var wk = await wr.json();
  if (!Array.isArray(wk)) wk = [];

  // Per-exercise aggregation.
  var byName = {};
  ex.forEach(function(e) {
    var nm = e.name;
    if (!nm) return;
    if (!byName[nm]) byName[nm] = { name: nm, days: {}, last_date: null, best_set: { weight_lbs: null, reps: null, duration_minutes: null } };
    var g = byName[nm];
    if (e.date) { g.days[e.date] = true; if (!g.last_date || e.date > g.last_date) g.last_date = e.date; }
    var w = numOrNull(e.weight_lbs), rp = numOrNull(e.reps), dm = numOrNull(e.duration_minutes);
    if (w != null && (g.best_set.weight_lbs == null || w > g.best_set.weight_lbs)) g.best_set.weight_lbs = w;
    if (rp != null && (g.best_set.reps == null || rp > g.best_set.reps)) g.best_set.reps = rp;
    if (dm != null && (g.best_set.duration_minutes == null || dm > g.best_set.duration_minutes)) g.best_set.duration_minutes = dm;
  });
  var list = Object.keys(byName).map(function(nm) {
    var g = byName[nm];
    return { name: nm, total_sessions: Object.keys(g.days).length, last_date: g.last_date, best_set: g.best_set, weeks_since_last: weeksSinceYmd(g.last_date) };
  });

  var top_exercises = list.slice().sort(function(a, b) { return b.total_sessions - a.total_sessions; }).slice(0, 10)
    .map(function(g) { return { name: g.name, last_date: g.last_date, total_sessions: g.total_sessions, best_set: g.best_set }; });
  var inactive_exercises = list.filter(function(g) { return g.weeks_since_last != null && g.weeks_since_last >= 6; })
    .map(function(g) { return { name: g.name, weeks_since_last: g.weeks_since_last }; });

  // Category breakdown — distinct completed-workout days per inferred category
  // (captures cardio / martial-arts sessions that never produce exercise rows).
  var catDates = {};
  wk.forEach(function(w) {
    if (!w.done || !w.date) return;
    var c = inferWorkoutCategoryServer(w.type);
    if (!catDates[c]) catDates[c] = {};
    catDates[c][w.date] = true;
  });
  var category_breakdown = {};
  Object.keys(catDates).forEach(function(c) { category_breakdown[c] = Object.keys(catDates[c]).length; });

  // Consistency — distinct completed-workout days per week over the window.
  var doneDates = {};
  wk.forEach(function(w) { if (w.done && w.date) doneDates[w.date] = true; });
  var weeks = Math.max(1, days / 7);
  var consistency = Math.round((Object.keys(doneDates).length / weeks) * 10) / 10;

  return {
    top_exercises: top_exercises,
    inactive_exercises: inactive_exercises,
    category_breakdown: category_breakdown,
    consistency: consistency,
  };
}

// ── ROADMAP PHASE HELPERS ────────────────────────────────────────────────────

// Assign sequential start/end dates to near-term phases (in order) when the AI
// didn't supply them, so time-based progress can be computed. Horizon phases are
// left dateless. Mutates the phases array in place.
// opts.resequence (default OFF, 2026-07-19 F1): normal operation PRESERVES any
// existing start_date, which is correct — but it means a bad adapt that pinned
// every phase to the same date can never be repaired, because there is no
// missing field left to fill. The flag rebuilds the calendar forward from the
// CURRENT phase using duration_weeks, and back-dates already-completed phases so
// they end before it. Repair-only: never set on the normal adapt/generate paths.
function resequenceNearTermDates(phases, todayStr) {
  var near = (phases || []).filter(function(p) { return p && p.type === "near_term"; });
  if (!near.length) return [];
  var weeksOf = function(p) {
    var w = Number(p.duration_weeks);
    if (!Number.isFinite(w)) { var m = String(p.duration_weeks == null ? "" : p.duration_weeks).match(/\d+/); w = m ? Number(m[0]) : 0; }
    return Number.isFinite(w) && w > 0 ? w : 5;   // sane default so repair never stalls
  };
  var DAY = 86400000;
  var ymd = function(ms) { return ymdLocal(new Date(ms)); };
  var curIdx = near.findIndex(function(p) { return p.status === "current"; });
  if (curIdx < 0) curIdx = 0;

  var changes = [];
  var record = function(p, s0, e0) {
    if (p.start_date !== s0 || p.end_date !== e0) {
      changes.push({ phase: p.name || "(unnamed)", from: (s0 || "?") + " -> " + (e0 || "?"), to: p.start_date + " -> " + p.end_date });
    }
  };

  // Current phase onward: contiguous forward from today.
  var cursor = Date.parse((todayStr || new Date().toISOString().slice(0, 10)) + "T00:00:00");
  for (var i = curIdx; i < near.length; i++) {
    var p = near[i], s0 = p.start_date, e0 = p.end_date;
    var endMs = cursor + weeksOf(p) * 7 * DAY;
    p.start_date = ymd(cursor);
    p.end_date = ymd(endMs - DAY);
    p.duration_weeks = weeksOf(p);
    record(p, s0, e0);
    cursor = endMs;
  }
  // Completed phases: back-date so each ends before the current phase begins.
  var back = Date.parse(near[curIdx].start_date + "T00:00:00");
  for (var j = curIdx - 1; j >= 0; j--) {
    var q = near[j], qs0 = q.start_date, qe0 = q.end_date;
    var qEnd = back - DAY;
    var qStart = qEnd - (weeksOf(q) * 7 * DAY) + DAY;
    q.end_date = ymd(qEnd);
    q.start_date = ymd(qStart);
    q.duration_weeks = weeksOf(q);
    record(q, qs0, qe0);
    back = qStart;
  }
  return changes;
}

function assignNearTermDates(phases, todayStr) {
  if (!Array.isArray(phases)) return;
  var cursor = Date.parse((todayStr || new Date().toISOString().slice(0, 10)) + "T00:00:00");
  if (isNaN(cursor)) cursor = Date.now();
  phases.forEach(function(p) {
    if (!p || p.type === "horizon") return;
    // Tolerate a model returning a range ("4-6") or a string ("5 weeks") rather
    // than an integer — take the first number present. A bare Number() on "4-6"
    // is NaN, which silently collapsed weeks to 0: no end_date computed, and
    // every phase's start_date pinned to today. Observed live 2026-07-19.
    var weeks = Number(p.duration_weeks);
    if (!Number.isFinite(weeks)) {
      var m = String(p.duration_weeks == null ? "" : p.duration_weeks).match(/\d+/);
      weeks = m ? Number(m[0]) : 0;
      if (weeks > 0) p.duration_weeks = weeks;   // normalise in place so it stores as an integer
    }
    if (!Number.isFinite(weeks) || weeks < 0) weeks = 0;
    if (!p.start_date) p.start_date = ymdLocal(new Date(cursor));
    var startMs = Date.parse(String(p.start_date).slice(0, 10) + "T00:00:00");
    if (isNaN(startMs)) { startMs = cursor; p.start_date = ymdLocal(new Date(cursor)); }
    var endMs = startMs + weeks * 7 * 86400000;
    if (!p.end_date && weeks > 0) p.end_date = ymdLocal(new Date(endMs - 86400000)); // inclusive last day
    cursor = endMs;
  });
}

// Estimate a current near-term phase's progress_pct (0-100). We can't verify
// free-text completion_signals programmatically, so we base it on time elapsed
// (capped at 90 so it never auto-completes) plus a small bonus when the goal's
// exercise trend is improving. Returns null for horizon phases.
function computePhaseProgress(phase, exerciseContext) {
  if (!phase || phase.type === "horizon") return null;
  var pct = 0;
  if (phase.start_date && phase.duration_weeks) {
    var startMs = Date.parse(String(phase.start_date).slice(0, 10) + "T00:00:00");
    var totalMs = Number(phase.duration_weeks) * 7 * 86400000;
    if (!isNaN(startMs) && totalMs > 0) pct = Math.round(((Date.now() - startMs) / totalMs) * 100);
  }
  if (pct < 0) pct = 0;
  if (pct > 90) pct = 90;
  if (exerciseContext && exerciseContext.trend === "improving") pct = Math.min(90, pct + 10);
  return pct;
}

// Recompute near-term phase status + progress_pct on read (don't store).
// Status is DERIVED FROM DATES (assigned by assignNearTermDates) rather than
// trusted from the AI, which tends to return everything as "upcoming":
//   end_date < today                  => complete
//   start_date <= today <= end_date   => current (only the FIRST such phase)
//   start_date > today                => upcoming
// Then current phases get a fresh time-based estimate, complete = 100, upcoming
// = 0. Horizon phases are left untouched. Mutates phases in place and returns it.
function recomputeRoadmapProgress(roadmap, exerciseContext) {
  if (!roadmap || !Array.isArray(roadmap.phases)) return roadmap;
  var todayMs = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00");
  var foundCurrent = false;
  roadmap.phases.forEach(function(p) {
    if (!p || p.type === "horizon") return;
    var startMs = p.start_date ? Date.parse(String(p.start_date).slice(0, 10) + "T00:00:00") : NaN;
    var endMs = p.end_date ? Date.parse(String(p.end_date).slice(0, 10) + "T00:00:00") : NaN;
    if (!isNaN(startMs) || !isNaN(endMs)) {
      if (!isNaN(endMs) && endMs < todayMs) {
        p.status = "complete";
      } else if (!foundCurrent && (isNaN(startMs) || startMs <= todayMs) && (isNaN(endMs) || endMs >= todayMs)) {
        p.status = "current";
        foundCurrent = true;
      } else {
        p.status = "upcoming";
      }
    }
    if (p.status === "current") p.progress_pct = computePhaseProgress(p, exerciseContext);
    else if (p.status === "complete") p.progress_pct = 100;
    else p.progress_pct = (typeof p.progress_pct === "number") ? p.progress_pct : 0;
  });
  return roadmap;
}

// ── MACRO ROADMAP (structured, profiles.roadmap_data) ────────────────────────
// Replaces the legacy free-text profiles.roadmap blob with a structured jsonb
// that ties ALL goals into one phased plan. The legacy GET/POST /roadmap (text)
// endpoints are kept for the current client; nothing writes profiles.roadmap
// from the new system. Client migrates to /roadmap-data when its UI is built.

var MACRO_ROADMAP_SYS = "You are an elite fitness coach building a comprehensive macro training roadmap that ties together ALL of an athlete's goals. Return ONLY valid JSON (no prose, no markdown fences) with EXACTLY this shape:\n" +
"{\n" +
'  "timeline_range": "8-15 months",  // overall range as a string\n' +
'  "timeline_note": "one honest sentence about what that range depends on",\n' +
'  "goals_summary": ["Goal title A", "Goal title B"],  // REQUIRED non-empty array of SHORT strings — one entry per athlete goal this roadmap covers, using the goal titles\n' +
'  "phases": [\n' +
'    // EXACTLY 3 near-term phases (type "near_term") THEN EXACTLY 2 horizon phases (type "horizon"), in that order\n' +
'    { "name": "Phase name", "type": "near_term", "duration_weeks": 5, "name": "short descriptive phase name, REQUIRED", "duration_weeks": 5, "weekly_targets": ["2-4 concrete items spanning ALL goals"], "emphasis": ["2-4 short imperative training-emphasis phrases, NO session counts, KEEP load/rep-scheme language"], "completion_signals": ["how you know this phase is done"], "goal_connections": ["which goals this phase advances"], "status": "upcoming" },\n' +
'    { "name": "Phase name", "type": "horizon", "milestone": "the concrete milestone reached at this horizon (REQUIRED non-empty string)", "estimated_range": "a time range string like \\"6-12 months\\" (REQUIRED non-empty string)", "status": "upcoming" }\n' +
"  ],\n" +
'  "exercise_gaps": ["specific things missing from training, be direct e.g. \\"No lower body strength in 5 weeks\\""],\n' +
'  "exercise_highlights": ["what is working"]\n' +
"}\n" +
"HARD REQUIREMENTS: (1) goals_summary MUST be a non-empty array of strings covering every goal listed. (2) EVERY horizon phase MUST include both a non-empty \"milestone\" string AND a non-empty \"estimated_range\" string — never omit or blank them. (3) duration_weeks is a number 4-6 for near-term phases. Do NOT include start_date/end_date — those are computed server-side. Use evidence-based timelines. Be concise and scannable, not an essay; each phase max 3 sentences total.";

// GET the structured macro roadmap. progress_pct recomputed on read.
app.get("/api/profiles/:id/roadmap-data", async function(req, res) {
  try {
    var pid = req.params.id;
    var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid + "&select=roadmap_data,roadmap_data_updated_at", { headers: sbHeaders() });
    var rows = await r.json();
    if (!rows || !rows.length) return res.status(404).json({ success: false, error: "Profile not found" });
    var rd = rows[0].roadmap_data;
    if (!rd) return res.json({ success: true, roadmap_data: null });
    try {
      var ctx = await getFullExerciseContext(pid, 90);
      recomputeRoadmapProgress(rd, ctx);
    } catch (e) { recomputeRoadmapProgress(rd, null); }
    res.json({ success: true, roadmap_data: rd, roadmap_data_updated_at: rows[0].roadmap_data_updated_at });
  } catch (e) {
    console.error("[MacroRoadmap] GET error:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST — generate a fresh structured macro roadmap (Sonnet). No intake gate;
// can be generated anytime.
app.post("/api/profiles/:id/roadmap-data", async function(req, res) {
  try {
    var pid = req.params.id;
    var pRes = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid + "&select=profile_data,coaching_brief", { headers: sbHeaders() });
    var profiles = await pRes.json();
    if (!profiles || !profiles.length) return res.status(404).json({ success: false, error: "Profile not found" });
    var pd = profiles[0].profile_data || {};
    var goals = Array.isArray(pd.goals) ? pd.goals : [];
    var brief = (profiles[0].coaching_brief || "").substring(0, 600);
    var ctxStr = (pd.ai_prompt_context || "").substring(0, 1000);
    var today = new Date().toISOString().slice(0, 10);

    var fullEx = await getFullExerciseContext(pid, 90);

    var wRes = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + pid + "&order=date.desc&limit=30&select=date,type", { headers: sbHeaders() });
    var workouts = await wRes.json();
    if (!Array.isArray(workouts)) workouts = [];
    var workoutsStr = workouts.map(function(w) { return w.date + ": " + (w.type || "Workout"); }).join("\n");

    var goalsStr = goals.map(function(g, i) {
      return (i + 1) + ". " + (g.title || "Untitled") + " (" + (g.type || "general") + ")" + (g.description ? " — " + g.description : "");
    }).join("\n");

    // Per-goal exercise context (keyed off each goal's title keywords).
    var perGoalCtx = "";
    for (var gi = 0; gi < goals.length; gi++) {
      var gx = await getGoalExerciseContext(pid, extractGoalKeywords(goals[gi].title), 90);
      perGoalCtx += (goals[gi].title || "Untitled") + ": " + JSON.stringify(gx) + "\n";
    }

    var userMsg = "GOALS:\n" + (goalsStr || "none") + "\n\n" +
      "FULL EXERCISE CONTEXT:\n" + JSON.stringify(fullEx) + "\n\n" +
      "PER-GOAL EXERCISE CONTEXT:\n" + (perGoalCtx || "none") + "\n\n" +
      "COACHING BRIEF:\n" + (brief || "none") + "\n\n" +
      "RECENT 30 WORKOUTS:\n" + (workoutsStr || "none") + "\n\n" +
      "PROFILE:\n" + (ctxStr || "none") + "\n\n" +
      "Today: " + today + "\n\nBuild a macro roadmap that ties all goals together into a cohesive training plan.";

    var text = await callAISystem(MACRO_ROADMAP_SYS, userMsg, 2500, MODEL_SONNET);
    var parsed = parseAIJson(text);
    if (!parsed || !Array.isArray(parsed.phases)) throw new Error("AI returned an invalid macro roadmap");
    assignNearTermDates(parsed.phases, today);

    var now = new Date().toISOString();
    var roadmapData = {
      timeline_range: parsed.timeline_range || null,
      timeline_note: parsed.timeline_note || null,
      goals_summary: Array.isArray(parsed.goals_summary) ? parsed.goals_summary : [],
      phases: parsed.phases,
      exercise_gaps: Array.isArray(parsed.exercise_gaps) ? parsed.exercise_gaps : [],
      exercise_highlights: Array.isArray(parsed.exercise_highlights) ? parsed.exercise_highlights : [],
      generated_at: now,
      version: 1,
      adaptation_log: [],
    };
    await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid, {
      method: "PATCH", headers: sbHeaders("return=minimal"),
      body: JSON.stringify({ roadmap_data: roadmapData, roadmap_data_updated_at: now }),
    });
    recomputeRoadmapProgress(roadmapData, fullEx);
    console.log("[MacroRoadmap] generated for profile " + pid + " — raw roadmap_data: " + JSON.stringify(roadmapData));
    res.json({ success: true, roadmap_data: roadmapData, roadmap_data_updated_at: now });
  } catch (e) {
    console.error("[MacroRoadmap] generate error:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 7-DAY SMART SCHEDULE PREVIEW ─────────────────────────────────────────────
// POST /api/profiles/:id/week-preview  body: { schedule (v2), readiness }
// Builds a deterministic ROLLING 7-day skeleton (today … today+6) from the v2
// schedule + the athlete's recent training (anchors locked, frequency targets
// placed by a recovery-aware rule engine, add-ons attached to training days,
// rest elsewhere), then asks Haiku for per-day coaching notes. Frequency-target
// satisfaction is counted from the start of the current Mon–Sun week so a target
// met earlier this week stays met, and one missed earlier this week carries
// forward and gets placed in the rolling window. Generic: no hardcoded
// assumptions. Capped at 6s on the AI step; returns the skeleton on
// timeout/failure so the card always renders.
var PREVIEW_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
var PREVIEW_DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
// Mon-first index (0=mon … 6=sun) for a JS Date (getDay: 0=Sun..6=Sat).
function previewDayIdx(d) { return (d.getDay() + 6) % 7; }

// Monday 00:00 of the week containing `d` (local server time).
function previewMondayOf(d) {
  var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var dow = t.getDay(); // 0=Sun..6=Sat
  t.setDate(t.getDate() + ((dow === 0) ? -6 : (1 - dow)));
  return t;
}

// Normalize a v2 anchor day value into an array of {activity, duration}.
function previewNormalizeAnchor(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(function(a) { return a && a.activity; });
  if (typeof v === "object" && v.activity) return [v];
  if (typeof v === "string" && v.trim()) return [{ activity: v.trim(), duration: null }];
  return [];
}

// Generic keyword → muscle-group lookup. Maps an exercise NAME to the specific
// muscle groups it works. Keyword `.` is a regex wildcard so "push.up" matches
// "push up" / "push-up" / "pushup". Zero user-specific assumptions.
var MUSCLE_GROUP_MAP = {
  chest:         ["press", "push.up", "pushup", "fly", "dip", "pec"],
  back:          ["row", "pull.up", "pullup", "chin", "lat", "deadlift", "cable", "seated.row", "back"],
  shoulders:     ["press", "lateral", "front.raise", "overhead", "shoulder", "delt", "ohp"],
  biceps:        ["curl", "bicep", "hammer", "chin"],
  triceps:       ["tricep", "pushdown", "extension", "skull", "dip", "close.grip"],
  core:          ["plank", "crunch", "sit.up", "ab", "core", "dead.bug", "bird.dog", "pallof", "hollow"],
  glutes:        ["glute", "bridge", "hip.thrust", "deadlift", "squat", "lunge", "step.up", "carry"],
  quads:         ["squat", "lunge", "leg.press", "step.up", "quad", "extension", "carry"],
  hamstrings:    ["deadlift", "curl", "hamstring", "hinge", "nordic", "rdl"],
  calves:        ["calf", "raise", "jump", "run", "walk", "hike"],
  grip_forearms: ["hang", "carry", "farmer", "grip", "forearm", "wrist", "dead.hang"],
};
// Precompiled { group: [RegExp,...] } so we don't rebuild regexes per call.
var MUSCLE_GROUP_RE = (function() {
  var out = {};
  Object.keys(MUSCLE_GROUP_MAP).forEach(function(g) {
    out[g] = MUSCLE_GROUP_MAP[g].map(function(k) { return new RegExp(k); });
  });
  return out;
})();
var ALL_MAJOR_MUSCLES = ["chest", "back", "shoulders", "biceps", "triceps", "glutes", "quads", "hamstrings", "core"];

// Which muscle groups an exercise NAME works (any keyword regex hit).
function muscleGroupsForExercise(name) {
  var n = String(name || "").toLowerCase();
  if (!n) return [];
  var out = [];
  Object.keys(MUSCLE_GROUP_RE).forEach(function(g) {
    var res = MUSCLE_GROUP_RE[g];
    for (var i = 0; i < res.length; i++) { if (res[i].test(n)) { out.push(g); break; } }
  });
  return out;
}

// Which muscle groups a scheduled ACTIVITY (e.g. "Upper Body Strength", "MMA
// Class", "Run") requires for recovery purposes. Generic keyword-based; returns
// [] when no constraint applies (e.g. mobility/yoga/rehab).
function activityMuscles(activity) {
  var a = String(activity || "").toLowerCase();
  var set = {};
  function add(arr) { arr.forEach(function(m) { set[m] = true; }); }
  if (/(full|total)/.test(a)) add(ALL_MAJOR_MUSCLES);
  if (/(upper|push|pull|chest|back|arm)/.test(a)) add(["chest", "back", "shoulders", "biceps", "triceps"]);
  if (/(lower|leg|squat|hinge)/.test(a)) add(["glutes", "quads", "hamstrings"]);
  if (/(core|\bab\b|abs)/.test(a)) add(["core"]);
  if (/(cardio|run|hike|walk)/.test(a)) add(["calves"]);
  if (/(mma|martial|grapple|bjj|boxing)/.test(a)) add(["shoulders", "core", "grip_forearms"]);
  return Object.keys(set);
}

// STEP 1 — pure-JS rule engine. Returns the 7-day skeleton array.
function buildWeekSkeleton(schedule, workouts, exercises, today) {
  schedule = schedule || {};
  var anchors = (schedule.anchors && typeof schedule.anchors === "object") ? schedule.anchors : {};
  var targets = Array.isArray(schedule.frequency_targets) ? schedule.frequency_targets : [];
  var addons = Array.isArray(schedule.addons) ? schedule.addons : [];

  var todayStr = ymdLocal(today);
  var todayMs = Date.parse(todayStr + "T00:00:00");
  var WIN48 = 48 * 3600000;
  // Start of the current Mon–Sun week (for carry-forward done-counting only).
  var weekStartMs = Date.parse(ymdLocal(previewMondayOf(today)) + "T00:00:00");

  // ROLLING WINDOW: today … today+6. Each day's dayKey/dayLabel is its ACTUAL
  // weekday (anchors are keyed by weekday), so the array starts at today.
  var days = [];
  var dateMs = [];
  var base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  for (var i = 0; i < 7; i++) {
    var d = new Date(base); d.setDate(base.getDate() + i);
    var dateStr = ymdLocal(d);
    var pIdx = previewDayIdx(d);
    dateMs.push(Date.parse(dateStr + "T00:00:00"));
    days.push({ dayKey: PREVIEW_DAYS[pIdx], date: dateStr, dayLabel: PREVIEW_DAY_LABELS[pIdx], planned: [], done: false, actual_workout: null, recovery_notes: [] });
  }

  // first done workout per date (for the day-level done flag + display label).
  var doneByDate = {};
  (workouts || []).forEach(function(w) { if (w && w.date && w.done && !doneByDate[w.date]) doneByDate[w.date] = w; });

  // Distinct exercise NAMES per workout_id, each pre-classified to its muscle
  // groups via MUSCLE_GROUP_MAP. Done-counting uses THIS (the exercises table),
  // never workout.type — the AI-generated title is polluted by micro-goal
  // exercises (e.g. a Dead-Hang-only session gets titled "Strength (Upper Body)").
  var exGroupsByWorkout = {}; // wid -> { name(lc): groups[] }
  (exercises || []).forEach(function(e) {
    if (!e || e.workout_id == null) return;
    var nm = String(e.name || "").toLowerCase().trim();
    if (!nm) return;
    var bucket = exGroupsByWorkout[e.workout_id] = exGroupsByWorkout[e.workout_id] || {};
    if (!bucket[nm]) bucket[nm] = muscleGroupsForExercise(e.name);
  });
  function isGripOnly(groups) { return groups.length === 1 && groups[0] === "grip_forearms"; }
  // A workout counts toward a target only when it is done AND its exercises
  // contain >= 2 DISTINCT names mapping to the target's required muscle groups,
  // EXCLUDING grip_forearms-only exercises (Dead Hang, farmer carry, bar hang…).
  function workoutSatisfiesTarget(w, reqMuscles) {
    if (!w || w.done !== true || !reqMuscles || !reqMuscles.length) return false;
    var bucket = exGroupsByWorkout[w.id];
    if (!bucket) return false;
    var n = 0;
    Object.keys(bucket).forEach(function(nm) {
      var g = bucket[nm];
      if (!g.length || isGripOnly(g)) return; // unmapped or grip-only never counts
      if (g.some(function(mg) { return reqMuscles.indexOf(mg) >= 0; })) n++;
    });
    return n >= 2;
  }

  // (e) MUSCLE-GROUP RECOVERY MAP — most-recent worked time (ms) per specific
  // muscle group, from each exercise row of ACTUAL (done) workouts in the last
  // 7 days, classified via MUSCLE_GROUP_MAP. Flat 48h window, presence-based.
  var muscleRecovery = {}; // group -> ms last worked
  (exercises || []).forEach(function(e) {
    if (!e || !e.date) return;
    var ms = Date.parse(e.date + "T00:00:00");
    if (isNaN(ms) || ms > todayMs || (todayMs - ms) > 7 * 86400000) return;
    if (!doneByDate[e.date]) return; // only count exercises from actual (done) workouts
    muscleGroupsForExercise(e.name).forEach(function(g) {
      if (!muscleRecovery[g] || ms > muscleRecovery[g]) muscleRecovery[g] = ms;
    });
  });
  // For an activity at candidate time candMs: which required muscle groups were
  // worked within 48h. Returns the conflicting group list ([] = fully recovered).
  function recentConflicts(activity, candMs) {
    var req = activityMuscles(activity);
    var hits = [];
    req.forEach(function(mg) {
      var last = muscleRecovery[mg];
      if (last != null && (candMs - last) < WIN48) hits.push(mg);
    });
    return { required: req, conflicts: hits };
  }

  // (a) ANCHORS — locked; never move. Keyed by the day's actual weekday.
  for (var i = 0; i < 7; i++) {
    previewNormalizeAnchor(anchors[days[i].dayKey]).forEach(function(a) {
      days[i].planned.push({ activity: a.activity, type: "anchor", duration: a.duration || null, category: inferWorkoutCategoryServer(a.activity) });
    });
  }

  function hasAnchor(i) { return days[i].planned.some(function(p) { return p.type === "anchor"; }); }
  function isHardDay(dayObj) { return dayObj.planned.some(function(p) { return ["strength", "martial_arts", "cardio"].indexOf(p.category) >= 0; }); }
  function adjacentHard(i) {
    var prev = i > 0 ? days[i - 1] : null, next = i < 6 ? days[i + 1] : null;
    return !!((prev && isHardDay(prev)) || (next && isHardDay(next)));
  }

  // CARRY-FORWARD done-counting: ALL done workouts from the START of the current
  // Mon–Sun week through the end of the rolling window. This way a target met
  // earlier this week stays met (not re-placed), and one missed Mon→yesterday
  // carries forward as unmet and gets placed in the rolling window. Every done
  // row counts (not one-per-date) so a strength session logged as a 2nd workout
  // on an anchor day still counts.
  var windowEndMs = dateMs[6];
  var weekDone = (workouts || []).filter(function(w) {
    if (!w || w.done !== true || !w.date) return false;
    var ms = Date.parse(w.date + "T00:00:00");
    return !isNaN(ms) && ms >= weekStartMs && ms <= windowEndMs;
  });

  // (b) FREQUENCY TARGETS.
  // CAP: at most ONE NON-STACKABLE frequency target per day (anchors never count
  // toward the cap). Targets flagged `stackable:true` (e.g. yoga / mobility /
  // light work) may ADDITIONALLY share a day that already has an anchor or a
  // non-stackable target — coached as a combined block. A day can hold multiple
  // stackable targets but only one non-stackable. Missing flag → false (safe).
  var dayNonStackable = {}; // idx -> true once a non-stackable freq target sits there
  var targetDiag = [];
  function dayIdxForDate(dateStr) { for (var i = 0; i < 7; i++) { if (days[i].date === dateStr) return i; } return -1; }
  function dayIdxForKey(key) { for (var i = 0; i < 7; i++) { if (days[i].dayKey === key) return i; } return -1; }
  function targetStackable(t) { return !!(t && t.stackable === true); }
  function hasNonStackable(i) { return !!dayNonStackable[i]; }
  function isTrainingDay(i) { return hasAnchor(i) || hasNonStackable(i); }
  // Category rank for placement order: strength/martial_arts (0) < cardio (1) <
  // mind_body/rehab (2) < other (3). Derived from the target ACTIVITY (schedule).
  function catRank(activity) {
    var c = inferWorkoutCategoryServer(activity);
    if (c === "strength" || c === "martial_arts") return 0;
    if (c === "cardio") return 1;
    if (c === "mind_body" || c === "rehab") return 2;
    return 3;
  }
  // (3) Placement order: NON-STACKABLE targets first (so stackable ones can land
  // on the training days they create), then suggested_day-present, then
  // times_per_week ascending, then category rank.
  var orderedTargets = targets.filter(function(t) { return t && t.activity; }).slice().sort(function(a, b) {
    var ka = targetStackable(a) ? 1 : 0, kb = targetStackable(b) ? 1 : 0;
    if (ka !== kb) return ka - kb;
    var sa = PREVIEW_DAYS.indexOf(a.suggested_day) >= 0 ? 0 : 1;
    var sb = PREVIEW_DAYS.indexOf(b.suggested_day) >= 0 ? 0 : 1;
    if (sa !== sb) return sa - sb;
    var ta = Number(a.times_per_week) || 1, tb = Number(b.times_per_week) || 1;
    if (ta !== tb) return ta - tb;
    return catRank(a.activity) - catRank(b.activity);
  });

  orderedTargets.forEach(function(target) {
    var tpw = Number(target.times_per_week) || 1;
    var cat = inferWorkoutCategoryServer(target.activity);
    var stackable = targetStackable(target);
    var reqMuscles = activityMuscles(target.activity);
    // (1) DONE-COUNTING via the exercises table (never workout.type).
    var qualifying = weekDone.filter(function(w) { return workoutSatisfiesTarget(w, reqMuscles); });
    var doneCount = qualifying.length;

    // (2) Surface completed targets on the day(s) they happened (done:true) IF
    // that day is inside the rolling window. Completions earlier this week (not
    // in the window) still count toward doneCount but aren't drawn.
    var placedDates = {};
    qualifying.forEach(function(w) {
      var di = dayIdxForDate(w.date);
      if (di < 0 || placedDates[w.date]) return;
      var already = days[di].planned.some(function(p) { return p.type === "frequency_target" && p.activity === target.activity; });
      if (!already) days[di].planned.push({ activity: target.activity, type: "frequency_target", duration: target.duration || null, category: cat, stackable: stackable, done: true });
      placedDates[w.date] = true;
      if (!stackable) dayNonStackable[di] = true; // occupies the day's single non-stackable slot
    });

    var slots = Math.max(0, tpw - doneCount);
    var placedFuture = [];
    var placedIdx = {}; // never place the same target twice on one day
    for (var s = 0; s < slots; s++) {
      var bestIdx = -1;
      if (!stackable) {
        // (4) GUARANTEED PLACEMENT (non-stackable): available = non-anchor day with
        // no non-stackable target yet. Highest-scoring day even if negative; only
        // skip when zero available days remain.
        var sugIdx = dayIdxForKey(target.suggested_day);
        if (sugIdx >= 0 && !hasAnchor(sugIdx) && !hasNonStackable(sugIdx) && !placedIdx[sugIdx]) {
          bestIdx = sugIdx;
        } else {
          var bestScore = -Infinity;
          for (var i = 0; i < 7; i++) {
            if (hasAnchor(i) || hasNonStackable(i) || placedIdx[i]) continue;
            var dk = days[i].dayKey;
            var score = 0;
            if (!adjacentHard(i)) score += 30;
            var rc = recentConflicts(target.activity, dateMs[i]);
            if (rc.required.length) score += (rc.conflicts.length ? -20 : 20);
            if (dk === "wed" || dk === "thu") score += 10;
            if (score > bestScore) { bestScore = score; bestIdx = i; }
          }
        }
        if (bestIdx < 0) break;
        dayNonStackable[bestIdx] = true;
      } else {
        // STACKABLE: prefer a training day (anchor or non-stackable target) it can
        // share; fall back to an open day only if no training day is available.
        var sugIdx2 = dayIdxForKey(target.suggested_day);
        if (sugIdx2 >= 0 && isTrainingDay(sugIdx2) && !placedIdx[sugIdx2]) {
          bestIdx = sugIdx2;
        } else {
          var bestTrain = -Infinity, fbScore = -Infinity, fbIdx = -1;
          for (var j = 0; j < 7; j++) {
            if (placedIdx[j]) continue;
            var dk2 = days[j].dayKey;
            var sc = (dk2 === "wed" || dk2 === "thu") ? 10 : 0;
            if (isTrainingDay(j)) { if (sc > bestTrain) { bestTrain = sc; bestIdx = j; } }
            else if (sc > fbScore) { fbScore = sc; fbIdx = j; }
          }
          if (bestIdx < 0) bestIdx = fbIdx; // no training day left → use a rest day
        }
        if (bestIdx < 0) break;
        // stackable does NOT occupy the non-stackable slot (multiple allowed).
      }
      days[bestIdx].planned.push({ activity: target.activity, type: "frequency_target", duration: target.duration || null, category: cat, stackable: stackable });
      placedIdx[bestIdx] = true;
      placedFuture.push(days[bestIdx].date);
    }
    targetDiag.push({ activity: target.activity, category: cat, stackable: stackable, tpw: tpw, doneCount: doneCount, met: doneCount >= tpw, qualifying_dates: qualifying.map(function(w) { return w.date; }), placed: placedFuture });
  });

  // (c) ADDONS — attach to EVERY training day (has an anchor OR a frequency target).
  for (var i = 0; i < 7; i++) {
    var isTraining = days[i].planned.some(function(p) { return p.type === "anchor" || p.type === "frequency_target"; });
    if (!isTraining) continue;
    addons.forEach(function(ad) {
      if (ad && ad.activity) days[i].planned.push({ activity: ad.activity, type: "addon", duration: ad.duration || null, category: inferWorkoutCategoryServer(ad.activity) });
    });
  }

  // (d) REST — any still-empty day.
  for (var i = 0; i < 7; i++) {
    if (!days[i].planned.length) days[i].planned.push({ activity: "Rest", type: "rest", duration: null, category: "rest" });
  }

  // per-day done / actual_workout + recovery_notes (specific muscle conflicts).
  // A day is "done" only when a completed workout exists AND the date is BEFORE
  // today (today shows the • indicator instead). actual_workout is still surfaced
  // for today so the user sees what they logged.
  for (var i = 0; i < 7; i++) {
    var w = doneByDate[days[i].date];
    if (w) {
      days[i].actual_workout = { type: w.type || "Workout" };
      if (dateMs[i] < todayMs) days[i].done = true;
    }
    var seen = {};
    days[i].planned.forEach(function(p) {
      if (p.type !== "anchor" && p.type !== "frequency_target") return;
      recentConflicts(p.activity, dateMs[i]).conflicts.forEach(function(mg) {
        if (!seen[mg]) { seen[mg] = true; days[i].recovery_notes.push(mg + " worked <48h prior"); }
      });
    });
  }

  // (5) LOGGING — full skeleton + which targets are met + per-day recovery flags.
  try {
    var recStr = Object.keys(muscleRecovery).map(function(g) { return g + "=" + ymdLocal(new Date(muscleRecovery[g])); }).join(", ") || "none";
    var lines = days.map(function(dd) {
      var acts = dd.planned.map(function(p) { return p.activity + "[" + p.type + "]"; }).join(", ");
      return "    " + dd.dayKey + " " + dd.date + " | done=" + dd.done + (dd.actual_workout ? "(" + dd.actual_workout.type + ")" : "") +
        " | " + acts + (dd.recovery_notes.length ? " | recovery: " + dd.recovery_notes.join("; ") : "");
    });
    var tgtLines = targetDiag.map(function(t) {
      return "    " + t.activity + " [" + t.category + (t.stackable ? ",stackable" : "") + "] " + t.doneCount + "/" + t.tpw + " met=" + t.met +
        (t.qualifying_dates.length ? " done@" + t.qualifying_dates.join(",") : "") +
        (t.placed && t.placed.length ? " placed@" + t.placed.join(",") : "");
    });
    console.log("[WeekPreview] skeleton:\n" + lines.join("\n") +
      "\n  frequency targets:\n" + (tgtLines.join("\n") || "    none") +
      "\n  muscle recovery (last 7d): " + recStr);
  } catch (e) { /* logging is best-effort */ }

  return days;
}

// STEP 2 — Haiku coaching notes. Returns { week_note, days:[{dayKey,coaching_note}] }.
async function enrichWeekPreviewWithCoaching(skeleton, pd, workouts, readiness, microGoals, today) {
  var sys = "You are an expert personal trainer and strength & conditioning coach. You think in terms of weekly periodization, muscle recovery, and progressive overload. You know that adjacent hard sessions on the same muscle group cause overtraining. You know MMA and martial arts tax the nervous system similarly to heavy strength work. You write like a real coach — direct, specific, encouraging without being sycophantic. Stackable sessions (yoga, mobility, light work) paired with a main session should be coached as a combined block, not two separate hard efforts. The plan is a ROLLING 7-day window starting today (it is NOT a Monday–Sunday week) — frame the week_note around 'this week'/'the next 7 days' generically. Return ONLY valid JSON: { \"week_note\": string (ONE sentence big-picture coaching note for this week), \"days\": [ { \"dayKey\": \"mon\", \"coaching_note\": string, max 12 words, specific, coach voice } ] } with EXACTLY one entry per day, one for each dayKey present in the skeleton (all 7 weekdays appear once). For rest days, give a short recovery cue. Keep it scannable.";
  var ctxStr = (pd && pd.ai_prompt_context ? String(pd.ai_prompt_context) : "").substring(0, 600);
  var dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var last7 = (workouts || []).slice(0, 12).map(function(w) { return w.date + ": " + (w.type || "Workout") + (w.done ? " (done)" : " (planned)"); }).join("\n");
  var mgTitles = (microGoals || []).map(function(m) { return m && m.title; }).filter(Boolean).join(", ");
  var skel = skeleton.map(function(d) {
    var acts = d.planned.map(function(p) { return p.activity + (p.type !== "rest" ? " [" + p.type + (p.stackable ? ",stackable" : "") + "]" : ""); }).join(", ");
    return d.dayKey + " (" + d.date + "): " + acts +
      (d.done ? " — DONE: " + ((d.actual_workout && d.actual_workout.type) || "") : "") +
      (d.recovery_notes && d.recovery_notes.length ? " — recovery: " + d.recovery_notes.join("; ") : "");
  }).join("\n");
  var userMsg = "7-DAY PLAN SKELETON (rule-engine output):\n" + skel + "\n\n" +
    "ATHLETE PROFILE (goals/injuries):\n" + (ctxStr || "none") + "\n\n" +
    "LAST WORKOUTS:\n" + (last7 || "none") + "\n\n" +
    "TODAY: " + ymdLocal(today) + " (" + dayNames[today.getDay()] + ")\n" +
    "READINESS TODAY: " + (readiness != null ? readiness + "/100" : "unknown") + "\n" +
    "ACTIVE MICRO-GOALS: " + (mgTitles || "none") + "\n\n" +
    "Write the week_note and a coaching_note for EACH of the 7 days. Factor in recovery windows, periodization, today's readiness, and the athlete's goals.";
  var text = await callAISystem(sys, userMsg, 700, MODEL_HAIKU);
  return parseAIJson(text);
}

app.post("/api/profiles/:id/week-preview", async function(req, res) {
  try {
    var pid = req.params.id;
    var body = req.body || {};
    var schedule = body.schedule || {};
    var readiness = (body.readiness != null && isFinite(Number(body.readiness))) ? Number(body.readiness) : null;

    // Athlete's timezone (2026-07-15) — "today" here used to be the server's
    // own OS-local getters (UTC-equivalent on Render), same bug class as the
    // Coach Chat "today" fix, and this endpoint is even more exposure-prone
    // since it determines which WEEKDAY is "today" for anchor matching in the
    // whole rolling schedule preview. Sequenced before the workouts/exercises
    // queries below (previously fetched in parallel with this) since they
    // need sinceStr, which depends on it — one extra round-trip, acceptable
    // given this endpoint is client-cached (localStorage.ac_schedule_preview)
    // and not in a tight per-message loop.
    var profileRow = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid + "&select=profile_data,timezone", { headers: sbHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(rows) { return (Array.isArray(rows) && rows[0]) || {}; })
      .catch(function() { return {}; });
    var pd = profileRow.profile_data || {};
    var todayStr = localToday(profileRow);
    var today = new Date(todayStr + "T12:00:00"); // noon-anchored local Date for buildWeekSkeleton's day-of-week arithmetic
    var sinceStr = localToday(profileRow, -14);

    var results = await Promise.all([
      fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + pid + "&date=gte." + sinceStr + "&select=id,date,type,done&order=date.desc&limit=200", { headers: sbHeaders() }),
      fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid + "&date=gte." + sinceStr + "&select=workout_id,date,name,main_category,subcategory&order=date.desc&limit=1000", { headers: sbHeaders() }),
      fetch(SUPABASE_URL + "/rest/v1/micro_goals?profile_id=eq." + pid + "&is_active=eq.true&select=title&limit=20", { headers: sbHeaders() }),
    ]);
    var workouts = await results[0].json(); if (!Array.isArray(workouts)) workouts = [];
    var exercises = await results[1].json(); if (!Array.isArray(exercises)) exercises = [];
    var microGoals = await results[2].json(); if (!Array.isArray(microGoals)) microGoals = [];

    var skeleton = buildWeekSkeleton(schedule, workouts, exercises, today);

    // STEP 2 — non-fatal Haiku enrichment, capped at 6s (return skeleton on timeout/fail).
    var enriched = null;
    try {
      enriched = await Promise.race([
        enrichWeekPreviewWithCoaching(skeleton, pd, workouts, readiness, microGoals, today),
        new Promise(function(resolve) { setTimeout(function() { resolve(null); }, 6000); }),
      ]);
    } catch (e) { enriched = null; }

    var weekNote = (enriched && enriched.week_note) ? enriched.week_note : null;
    if (enriched && Array.isArray(enriched.days)) {
      var noteByKey = {};
      enriched.days.forEach(function(d) { if (d && d.dayKey) noteByKey[d.dayKey] = d.coaching_note || ""; });
      skeleton.forEach(function(d) { if (noteByKey[d.dayKey]) d.coaching_note = noteByKey[d.dayKey]; });
    }
    res.json({ success: true, week: skeleton, week_note: weekNote, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error("[WeekPreview] error:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Adapt the structured macro roadmap via Haiku (used by the unified weekly
// trigger). Updates exercise_gaps / exercise_highlights and phase statuses;
// preserves the 3 near_term + 2 horizon structure. progress_pct is recomputed on
// read, not trusted from the AI. Returns the new roadmap_data object.
async function adaptMacroRoadmap(roadmapData, fullExCtx, workouts, trigger) {
  var today = new Date().toISOString().slice(0, 10);
  var workoutsStr = (workouts || []).map(function(w) { return w.date + ": " + (w.type || "Workout"); }).join("\n");
  var sys = "You are an elite fitness coach adapting an athlete's macro training roadmap based on their recent training. Return ONLY valid JSON with the same shape as the existing macro roadmap: { timeline_range, timeline_note, goals_summary, phases, exercise_gaps, exercise_highlights }. Update exercise_gaps and exercise_highlights to reflect the latest training. Advance phase status (upcoming -> current -> complete) when completion_signals are met, and keep the 3 near_term + 2 horizon structure. Only change what the recent training justifies. Be concise.";
  var userMsg = "CURRENT MACRO ROADMAP:\n" + JSON.stringify(roadmapData) + "\n\n" +
    "FULL EXERCISE CONTEXT:\n" + JSON.stringify(fullExCtx) + "\n\n" +
    "RECENT WORKOUTS (last 10):\n" + (workoutsStr || "none") + "\n\n" +
    "Today: " + today + "\n\nAdapt the macro roadmap based on recent training.";
  var text = await callAISystem(sys, userMsg, 2500, MODEL_HAIKU);
  var parsed = parseAIJson(text);
  if (!parsed || !Array.isArray(parsed.phases)) throw new Error("AI returned an invalid adapted macro roadmap");
  assignNearTermDates(parsed.phases, today);
  var prev = roadmapData || {};
  var now = new Date().toISOString();
  var log = Array.isArray(prev.adaptation_log) ? prev.adaptation_log.slice() : [];
  log.push({ date: now, summary: parsed.timeline_note || "Macro roadmap adapted", trigger: trigger });
  return {
    timeline_range: parsed.timeline_range || prev.timeline_range || null,
    timeline_note: parsed.timeline_note || prev.timeline_note || null,
    goals_summary: Array.isArray(parsed.goals_summary) ? parsed.goals_summary : (prev.goals_summary || []),
    phases: parsed.phases,
    exercise_gaps: Array.isArray(parsed.exercise_gaps) ? parsed.exercise_gaps : (prev.exercise_gaps || []),
    exercise_highlights: Array.isArray(parsed.exercise_highlights) ? parsed.exercise_highlights : (prev.exercise_highlights || []),
    generated_at: prev.generated_at || now,
    version: (typeof prev.version === "number" ? prev.version : 1) + 1,
    adaptation_log: log,
  };
}

// ── LIVING GOAL ROADMAPS ────────────────────────────────────────────────────
// Per-goal roadmaps stored as fields on each goal object inside
// profile_data.goals[] (jsonb on profiles) — no new tables. Each goal can carry:
//   id, intake_questions[], intake_answers[], intake_completed,
//   roadmap { phases[], estimated_completion, date_confidence, date_note,
//             summary, generated_at, version, adaptation_log[] },
//   last_adapted_at
// Phase: { name, description, duration_weeks, completion_signals[], status }
// adaptation_log entry: { date, summary, trigger: 'weekly'|'checkin'|'manual' }

// Goals historically had no stable id. Assign a uuid (in place) to any goal
// missing one. Returns true if it added any, so the caller can persist.
function ensureGoalIds(profileData) {
  if (!profileData || typeof profileData !== "object" || !Array.isArray(profileData.goals)) return false;
  var changed = false;
  profileData.goals.forEach(function(g) {
    if (g && typeof g === "object" && !g.id) { g.id = crypto.randomUUID(); changed = true; }
  });
  return changed;
}

// Find a goal by id in profile_data.goals[]. Returns { goal, index }; throws a
// 404-tagged error when absent (route catch maps e.status → HTTP status).
function findGoalById(profileData, goalId) {
  var goals = (profileData && Array.isArray(profileData.goals)) ? profileData.goals : [];
  for (var i = 0; i < goals.length; i++) {
    if (goals[i] && goals[i].id === goalId) return { goal: goals[i], index: i };
  }
  var err = new Error("Goal not found");
  err.status = 404;
  throw err;
}

// Load a profile row + its profile_data (with goal ids ensured in memory).
// Throws a 404-tagged error if missing. Returns { profile, profileData }.
async function loadProfileWithGoals(profileId) {
  var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId + "&select=id,profile_data,coaching_brief", { headers: sbHeaders() });
  var rows = await r.json();
  if (!rows || !rows.length) { var err = new Error("Profile not found"); err.status = 404; throw err; }
  var profileData = rows[0].profile_data || {};
  ensureGoalIds(profileData);
  return { profile: rows[0], profileData: profileData };
}

// Write the updated goal back into profile_data.goals[index] and PATCH the full
// profile_data. cleanProfileData only collapses \r\n (not bare \n), so AI text
// formatting survives.
async function saveGoalToProfile(profileId, profileData, goalIndex, updatedGoal) {
  profileData.goals[goalIndex] = updatedGoal;
  await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId, {
    method: "PATCH",
    headers: sbHeaders("return=minimal"),
    body: JSON.stringify({ profile_data: cleanProfileData(profileData) }),
  });
  return updatedGoal;
}

// Generic sibling of saveGoalToProfile for any other top-level profile_data
// key (used by Coach Chat's focus-override proposal apply). Same safe
// pattern: profileData must already be a FULL load (e.g. from
// loadProfileWithGoals), so writing it back whole is correct — writing only
// {profile_data: {[key]: value}} directly to Supabase here would REPLACE the
// whole profile_data column and destroy every other key (goals, schedule,
// ai_prompt_context, ...). This is not a hypothetical: an earlier draft of
// the focus-override proposal apply logic made exactly that mistake before
// it was caught in review.
async function saveProfileDataField(profileId, profileData, key, value) {
  profileData[key] = value;
  await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId, {
    method: "PATCH",
    headers: sbHeaders("return=minimal"),
    body: JSON.stringify({ profile_data: cleanProfileData(profileData) }),
  });
  return value;
}

// Direct Anthropic call with a separate system prompt + single user message.
// Mirrors callAI() but adds the top-level `system` field.
// Same abort discipline as callAI() (2026-07-19). Originally rated lower risk
// because its callers (roadmap generate/adapt) are background/fire-and-forget —
// but once roadmap output feeds the daily rec prompt, a hung generator becomes a
// stale roadmap becomes a wrong workout, so it needs the same ceiling.
// NOTE: unlike callAI(), this THROWS on error rather than returning "". That is
// deliberate and unchanged — its callers (generateGoalRoadmapForGoal,
// maybeAdaptAllRoadmaps, parseAIJson consumers) branch on the throw to decide
// whether to write a roadmap at all. Returning "" here would let an empty
// generation overwrite a good roadmap.
async function callAISystem(system, userMsg, maxTokens, model, timeoutMs) {
  var ms = typeof timeoutMs === "number" ? timeoutMs : aiTimeoutMs(maxTokens || 1500, model);
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, ms);
  try {
    var response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || MODEL_SONNET,
        max_tokens: maxTokens || 1500,
        system: system,
        messages: [{ role: "user", content: userMsg }],
      }),
      signal: controller.signal,
    });
    var data = await response.json();
    if (data && data.error) throw new Error(data.error.message || "Anthropic error");
    return (data.content && data.content[0]) ? data.content[0].text : "";
  } catch (e) {
    if (e && (e.name === "AbortError" || /abort/i.test(e.message || ""))) {
      console.error("[AI] callAISystem TIMED OUT after " + ms + "ms (model=" + (model || MODEL_SONNET) + ")");
      throw new Error("AI call timed out after " + ms + "ms");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Extract the first JSON value (object or array) from an AI response, tolerating
// ```json fences and surrounding prose.
function parseAIJson(text) {
  if (!text) throw new Error("Empty AI response");
  var t = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  var firstObj = t.indexOf("{"), firstArr = t.indexOf("[");
  var start, endChar;
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) { start = firstArr; endChar = "]"; }
  else { start = firstObj; endChar = "}"; }
  if (start === -1) throw new Error("No JSON found in AI response");
  var end = t.lastIndexOf(endChar);
  if (end < start) throw new Error("Malformed JSON in AI response");
  return JSON.parse(t.substring(start, end + 1));
}

// Adapt an existing goal.roadmap via Haiku. `notes` is the athlete's check-in
// (empty for weekly auto-adaptation). Returns the new roadmap object — version
// incremented, generated_at preserved, adaptation_log appended.
// ── ROADMAP EMPHASIS EXTRACTION (2026-07-19) ──────────────────────────────
// weekly_targets[] are written for a human and mix three things: WHAT to
// emphasize, HOW MANY sessions, and non-training admin (nutrition, tracking,
// subjective observation). Only the first is useful to the daily rec prompt —
// the SCHEDULE already owns session counts, and injecting a second set of
// weekly numbers would put two contradictory frequencies in one prompt.
//
// A regex pass over this prose was built, tested and REJECTED: it leaked counts
// ("3-4 strength sessions") and, worse, silently dropped the three most
// actionable targets in the whole roadmap because "weighted" / "bodyweight"
// matched a weight-tracking filter. Parsing human prose by pattern is
// unfixable in principle, so the model that understands the content does it.
//
// Sonnet, not Haiku: deciding what counts as training emphasis is a judgment
// call, and this runs once per goal per roadmap-change (not per rec), so the
// cost delta is negligible.
var ROADMAP_EMPHASIS_SYS =
  "You extract TRAINING EMPHASIS from a coaching roadmap's weekly targets.\n\n" +
  "Return ONLY valid JSON: {\"emphasis\": [\"...\", \"...\"]} — no prose, no markdown fences.\n\n" +
  "For each weekly target, decide what the athlete's sessions should EMPHASIZE, and express it as a short imperative phrase (3-12 words).\n\n" +
  "RULES:\n" +
  "1. DROP session counts and frequencies entirely. \"3-4 strength sessions per week (posterior chain focus)\" -> \"posterior chain focus in strength work\". Never output a number of sessions, days, or times per week. A separate system owns scheduling.\n" +
  "2. PRESERVE load, weight and progression language — this is the most actionable content. \"Progress to weighted glute bridges (10-20 lbs)\" -> \"weighted glute bridges, 10-20 lbs\". \"goblet squats with light weight\" -> \"goblet squats, light weight\". \"Achieve 3x20 bodyweight squats\" -> \"bodyweight squats toward 3x20\". Set x rep schemes, pound figures and hold durations are emphasis, NOT session counts — keep them.\n" +
  "3. DROP anything a workout generator cannot act on: nutrition and protein targets, journaling or pain-tracking, subjective observations (\"notice improved carryover\", \"visibly larger\"), and life-context maintenance (\"posture during wedding gigs\").\n" +
  "4. DROP stale framing. If a target is conditioned on a state that has passed (\"Once training resumes: ...\"), output the underlying instruction without the condition.\n" +
  "5. Merge near-duplicates. Prefer fewer, sharper items. Output at most 4.\n" +
  "6. If a phase yields nothing actionable, return an empty array.\n\n" +
  "Output only the emphasis array for the targets given.";

// Returns emphasis[] for one phase's weekly_targets. Never throws — a failure
// yields null so the caller can leave the phase uncached and fall back.
async function extractPhaseEmphasis(goalTitle, phase) {
  var targets = (phase && phase.weekly_targets) || [];
  if (!targets.length) return [];
  try {
    var userMsg = "GOAL: " + (goalTitle || "Untitled") + "\n" +
      "PHASE: " + (phase.name || "Untitled phase") + "\n\n" +
      "WEEKLY TARGETS:\n" + targets.map(function(t, i) { return (i + 1) + ". " + t; }).join("\n");
    var text = await callAISystem(ROADMAP_EMPHASIS_SYS, userMsg, 500, MODEL_SONNET);
    var parsed = parseAIJson(text);
    if (!parsed || !Array.isArray(parsed.emphasis)) return null;
    return parsed.emphasis
      .filter(function(e) { return typeof e === "string" && e.trim(); })
      .map(function(e) { return e.trim(); })
      .slice(0, 4);
  } catch (e) {
    console.error("[RoadmapEmphasis] extraction failed for '" + goalTitle + "' / '" + (phase && phase.name) + "': " + e.message);
    return null;
  }
}

// ── WEEKLY AUTO-ADAPT CONTEXT (E3, 2026-07-19) ────────────────────────────
// The weekly auto-adapt previously passed the literal string "(no notes —
// automatic weekly review based on recent training)" as the athlete check-in,
// giving the model no way to detect that a training pause had ENDED. That is
// precisely what let Build Muscle sit in a phase named "Progressive Overload
// (Paused)" — with a target beginning "Once training resumes:" — for weeks
// after training had in fact resumed.
//
// Computed from the workouts already fetched for the adapt call: NO extra API
// call, no model call, ~250 chars. The resumption line is the load-bearing one.
function buildWeeklyReviewContext(workouts) {
  var rows = (workouts || []).filter(function(w) { return w && w.date; })
    .slice().sort(function(a, b) { return a.date < b.date ? 1 : -1; });   // newest first
  if (!rows.length) return "AUTOMATIC WEEKLY REVIEW — no athlete check-in. No workouts logged in the reviewed window.";

  var today = new Date().toISOString().slice(0, 10);
  var dayMs = 86400000;
  var daysBetween = function(a, b) { return Math.round((Date.parse(b + "T00:00:00") - Date.parse(a + "T00:00:00")) / dayMs); };

  var last14 = rows.filter(function(w) { return daysBetween(w.date, today) <= 14; }).length;
  var prev14 = rows.filter(function(w) { var d = daysBetween(w.date, today); return d > 14 && d <= 28; }).length;

  // Largest gap between consecutive logged sessions in the window.
  var gap = { days: 0, from: null, to: null };
  for (var i = 0; i < rows.length - 1; i++) {
    var d = daysBetween(rows[i + 1].date, rows[i].date);
    if (d > gap.days) gap = { days: d, from: rows[i + 1].date, to: rows[i].date };
  }

  var byCat = {};
  rows.forEach(function(w) {
    var c = inferWorkoutCategoryServer ? inferWorkoutCategoryServer(w.type) : (w.type || "other");
    byCat[c] = (byCat[c] || 0) + 1;
  });
  var catStr = Object.keys(byCat).map(function(k) { return k + " x" + byCat[k]; }).join(", ") || "none";

  var lines = [
    "AUTOMATIC WEEKLY REVIEW — no athlete check-in. Recent training evidence:",
    "- Sessions in last 14 days: " + last14 + " (previous 14 days: " + prev14 + ")",
    "- Categories trained: " + catStr,
  ];
  if (gap.days >= 7) lines.push("- Longest gap in window: " + gap.days + " days (" + gap.from + " -> " + gap.to + ")");
  // The signal the premise-validity check needs: training restarted after a break.
  if (gap.days >= 10 && daysBetween(gap.to, today) <= 21) {
    lines.push("- RESUMPTION SIGNAL: training resumed " + gap.to + " after a " + gap.days + "-day gap. Any phase premised on a pause, layoff or injury break is likely STALE.");
  } else if (prev14 === 0 && last14 > 0 && daysBetween(rows[rows.length - 1].date, today) >= 28) {
    // Only claim "nothing in the prior window" when the data actually REACHES
    // back that far. The adapt call is given the last ~10 workouts, so for a
    // consistent athlete that window is often ~14 days — prev14 would read 0
    // simply because there is no older data, producing a permanent false
    // resumption signal and inviting spurious phase rewrites. Absence of
    // evidence is not evidence of absence.
    lines.push("- RESUMPTION SIGNAL: no sessions in the prior 14-day window but " + last14 + " since. Any phase premised on a pause or layoff is likely STALE.");
  }
  return lines.join("\n");
}

// ── ONE-CURRENT-PHASE INVARIANT (E4, 2026-07-19) ──────────────────────────
// Deterministic backstop for the DATE ROLLOVER rule added to the adapt prompt.
// Prompt rules are probabilistic: Fix Posture sat with TWO phases marked
// "current" for weeks (an adapt advanced phase 2 without completing phase 1,
// because phase 1's window expired by DATE while its completion_signals were
// never met) and nothing caught it — the Goals tab rendered correctly because
// recomputeRoadmapProgress() derives status on read, while the stored data the
// rec prompt reads stayed wrong. Enforced in code, not hoped for in a prompt.
//
// Rule: at most one near_term phase may be "current". If several are, the LAST
// (furthest along) wins and earlier ones are marked complete. Returns a list of
// corrections for logging; mutates phases in place.
function enforceSingleCurrentPhase(phases) {
  var near = (phases || []).filter(function(p) { return p && p.type === "near_term"; });
  var currentIdx = [];
  near.forEach(function(p, i) { if (p.status === "current") currentIdx.push(i); });
  if (currentIdx.length <= 1) return [];
  var keep = currentIdx[currentIdx.length - 1];
  var fixed = [];
  currentIdx.forEach(function(i) {
    if (i === keep) return;
    fixed.push({ phase: near[i].name || "(unnamed)", from: "current", to: "complete" });
    near[i].status = "complete";
    near[i].progress_pct = 100;
  });
  return fixed;
}

// Fills emphasis[] on any near_term phase that lacks it. Used after generate and
// after adapt so the field is self-maintaining — D1's one-time backfill only
// covers roadmaps that existed on 2026-07-19.
async function backfillMissingEmphasis(goalTitle, phases) {
  for (var i = 0; i < (phases || []).length; i++) {
    var ph = phases[i];
    if (!ph || ph.type !== "near_term") continue;
    if (Array.isArray(ph.emphasis) && ph.emphasis.length) continue;
    var e = await extractPhaseEmphasis(goalTitle, ph);
    if (e) ph.emphasis = e;
  }
}

async function adaptGoalRoadmap(goal, notes, workouts, trigger, goalExCtx) {
  var today = new Date().toISOString().slice(0, 10);
  var workoutsStr = (workouts || []).map(function(w) { return w.date + ": " + (w.type || "Workout"); }).join("\n");
  var sys = "You are a fitness coach adapting an athlete's training roadmap for a specific goal based on their recent training and (optionally) a check-in. Return ONLY valid JSON with the same shape as the existing roadmap: { timeline_range: string, timeline_note: string, date_confidence: 'high'|'medium'|'low', phases: [...] }. Preserve the structure: 3 near_term phases (type: 'near_term', each with name, duration_weeks, weekly_targets, emphasis and completion_signals — never drop name or duration_weeks) followed by 2 horizon phases (type: 'horizon', milestone-based). duration_weeks MUST be a single INTEGER (e.g. 5), never a string and never a range like \"4-6\" — phases are sequenced on a calendar from it. " +
    "Advance phase status (upcoming -> current -> complete) when completion_signals are met. Keep phases that are still valid — only change what the recent training or check-in justifies. Be concise.\n\n" +
    "ALSO run two checks that are NOT completion tests:\n" +
    "1. DATE ROLLOVER: if a phase's end_date has passed, it must not remain \"current\" — mark it \"complete\" and make the next phase \"current\", even if its completion_signals were never met. Exactly one near_term phase may be \"current\".\n" +
    "2. PREMISE VALIDITY: each phase's name and targets assume a context (an injury flare, a training pause, a deload, a travel block). If the recent training evidence shows that context has ENDED — e.g. the athlete has resumed training after a documented pause — rewrite that phase's name and targets to drop the stale premise. Do not silently keep a phase whose framing is no longer true. If the premise still holds, leave the phase alone.\n\n" +
    "These two checks are the ONLY reasons to change a phase that its completion_signals have not justified. Everything else: keep what is valid.";
  var userMsg = "GOAL: " + (goal.title || "Untitled") + "\n\n" +
    "CURRENT ROADMAP:\n" + JSON.stringify(goal.roadmap) + "\n\n" +
    "EXERCISE CONTEXT FOR THIS GOAL:\n" + (goalExCtx ? JSON.stringify(goalExCtx) : "none") + "\n\n" +
    "ATHLETE CHECK-IN:\n" + (notes || buildWeeklyReviewContext(workouts)) + "\n\n" +
    "RECENT WORKOUTS (last 10):\n" + (workoutsStr || "none") + "\n\n" +
    "Today: " + today + "\n\nAdapt the roadmap based on this evidence.";
  // E1 (2026-07-19): Sonnet, not Haiku. This call now decides whether a phase's
  // PREMISE still holds — the judgment that steers the daily rec prompt's
  // GOAL ROADMAP EMPHASIS block. Generation already used Sonnet; adapt running
  // a cheaper model on a harder judgment was backwards. Measured cost: ~7.5k
  // input + <=6k output tokens per weekly run across all goals with roadmaps
  // (~0.39M input / 0.31M output per YEAR), so the ~3x delta is a few dollars
  // annually and scales with goals, not with recs or users.
  var text = await callAISystem(sys, userMsg, 2000, MODEL_SONNET);
  var parsed = parseAIJson(text);
  if (!parsed || !Array.isArray(parsed.phases)) throw new Error("AI returned an invalid adapted roadmap");
  assignNearTermDates(parsed.phases, today); // fills only missing dates; preserves existing
  // Keep emphasis[] in step with the adapted targets. The adapt prompt now asks
  // for it, but the adapt model is Haiku and may omit it — and a roadmap that
  // predates the field has none at all. Backfill any near_term phase missing it
  // so the daily-rec block never silently loses its emphasis for a goal.
  // Non-fatal by construction: extractPhaseEmphasis returns null on failure and
  // the phase is simply left without emphasis rather than blocking the adapt.
  await backfillMissingEmphasis(goal.title, parsed.phases);
  // E4: deterministic one-current-phase invariant, run AFTER the model so it
  // catches the DATE ROLLOVER prompt rule failing to fire.
  var fixedPhases = enforceSingleCurrentPhase(parsed.phases);
  if (fixedPhases.length) {
    console.warn("[Roadmap] enforceSingleCurrentPhase corrected " + fixedPhases.length +
      " phase(s) for '" + (goal.title || "?") + "': " +
      fixedPhases.map(function(f) { return f.phase + " current->complete"; }).join("; "));
  }

  var prev = goal.roadmap || {};
  var now = new Date().toISOString();
  var log = Array.isArray(prev.adaptation_log) ? prev.adaptation_log.slice() : [];
  log.push({ date: now, summary: parsed.timeline_note || "Roadmap adapted", trigger: trigger });
  return {
    timeline_range: parsed.timeline_range || prev.timeline_range || null,
    timeline_note: parsed.timeline_note || prev.timeline_note || null,
    date_confidence: parsed.date_confidence || prev.date_confidence || null,
    phases: parsed.phases,
    generated_at: prev.generated_at || now,           // preserve original generation time
    version: (typeof prev.version === "number" ? prev.version : 1) + 1,
    adaptation_log: log,
  };
}

// Fire-and-forget weekly maintenance, called after a workout save. Adapts BOTH
// the per-goal roadmaps AND the structured macro roadmap when each is >7 days
// stale, sharing a single profile load, one full-exercise-context fetch, and one
// workouts fetch. A single profile PATCH writes everything at the end.
async function maybeAdaptAllRoadmaps(profileId) {
  if (!profileId) return;
  var r = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId + "&select=id,profile_data,coaching_brief,roadmap_data,roadmap_data_updated_at", { headers: sbHeaders() });
  var rows = await r.json();
  if (!rows || !rows.length) return;
  var profileData = rows[0].profile_data || {};
  var roadmapData = rows[0].roadmap_data || null;
  var rdUpdatedAt = rows[0].roadmap_data_updated_at || null;
  var goals = Array.isArray(profileData.goals) ? profileData.goals : [];

  var WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  var nowMs = Date.now();
  var isStale = function(ts) {
    if (!ts) return true;
    var t = Date.parse(ts);
    return isNaN(t) || (nowMs - t) > WEEK_MS;
  };

  var dueGoals = goals.filter(function(g) {
    return g && g.intake_completed && g.roadmap && isStale(g.last_adapted_at);
  });
  var macroDue = !!(roadmapData && isStale(rdUpdatedAt));
  if (!dueGoals.length && !macroDue) return;

  // Shared context — fetched once for every adaptation below.
  var fullEx = null;
  try { fullEx = await getFullExerciseContext(profileId, 60); } catch (e) { /* non-fatal */ }
  var wRes = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + profileId + "&order=date.desc&limit=10&select=date,type", { headers: sbHeaders() });
  var workouts = await wRes.json();
  if (!Array.isArray(workouts)) workouts = [];

  var goalsChanged = false;
  for (var i = 0; i < dueGoals.length; i++) {
    var g = dueGoals[i]; // same object reference as in profileData.goals
    try {
      var gx = null;
      try { gx = await getGoalExerciseContext(profileId, extractGoalKeywords(g.title), 90); } catch (e) { /* non-fatal */ }
      g.roadmap = await adaptGoalRoadmap(g, "", workouts, "weekly", gx);
      g.last_adapted_at = new Date().toISOString();
      goalsChanged = true;
    } catch (e) {
      console.error("[Roadmap] weekly goal adapt failed for goal " + (g.id || "?") + ": " + e.message);
    }
  }

  var macroChanged = false;
  var newMacro = roadmapData;
  if (macroDue) {
    try {
      newMacro = await adaptMacroRoadmap(roadmapData, fullEx || {}, workouts, "weekly");
      macroChanged = true;
    } catch (e) {
      console.error("[Roadmap] weekly macro adapt failed for profile " + profileId + ": " + e.message);
    }
  }

  if (!goalsChanged && !macroChanged) return;

  var patch = {};
  if (goalsChanged) patch.profile_data = cleanProfileData(profileData);
  if (macroChanged) { patch.roadmap_data = newMacro; patch.roadmap_data_updated_at = new Date().toISOString(); }
  await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId, {
    method: "PATCH",
    headers: sbHeaders("return=minimal"),
    body: JSON.stringify(patch),
  });
  console.log("[Roadmap] weekly adapted " + dueGoals.length + " goal(s)" + (macroChanged ? " + macro" : "") + " for profile " + profileId);
}

// GET intake questions for a goal — generates them (Haiku) on first call.
app.get("/api/profiles/:id/goals/:goalId/intake", async function(req, res) {
  try {
    var loaded = await loadProfileWithGoals(req.params.id);
    var found = findGoalById(loaded.profileData, req.params.goalId);
    var goal = found.goal;

    if (goal.intake_completed) {
      return res.json({ success: true, intake_questions: goal.intake_questions || [], intake_answers: goal.intake_answers || [], intake_completed: true });
    }
    if (Array.isArray(goal.intake_questions) && goal.intake_questions.length) {
      return res.json({ success: true, intake_questions: goal.intake_questions, intake_answers: goal.intake_answers || [], intake_completed: false });
    }

    var ctx = (loaded.profileData.ai_prompt_context || "").substring(0, 800);
    var sys = "You are a fitness coach generating intake questions to build a personalized roadmap for a specific goal. Return ONLY a JSON array of question objects with shape { question: string, key: string } where key is a short camelCase identifier. Generate 4-6 questions that are targeted to THIS goal — do not ask about things already in the athlete profile. Focus on specifics: current baseline, obstacles, time availability for this goal, what success looks like to them.";
    var userMsg = "Goal: " + (goal.title || "Untitled") + " (" + (goal.type || "general") + ")\n" +
      "Description: " + (goal.description || "none") + "\n" +
      "Athlete profile summary: " + ctx + "\n\nGenerate intake questions for this specific goal.";
    var text = await callAISystem(sys, userMsg, 800, MODEL_HAIKU);
    var questions = parseAIJson(text);
    if (!Array.isArray(questions)) throw new Error("AI did not return a question array");
    questions = questions.filter(function(q) { return q && q.question; }).map(function(q, i) {
      return { question: String(q.question), key: q.key ? String(q.key) : ("q" + (i + 1)) };
    });

    goal.intake_questions = questions;
    if (!Array.isArray(goal.intake_answers)) goal.intake_answers = [];
    goal.intake_completed = false;
    await saveGoalToProfile(req.params.id, loaded.profileData, found.index, goal);
    res.json({ success: true, intake_questions: questions, intake_answers: [], intake_completed: false });
  } catch (e) {
    console.error("[GoalRoadmap] intake GET error:", e.message);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

// POST intake answers — completes the intake.
app.post("/api/profiles/:id/goals/:goalId/intake", async function(req, res) {
  try {
    var answers = (req.body && Array.isArray(req.body.answers)) ? req.body.answers : null;
    if (!answers) return res.status(400).json({ success: false, error: "answers array required" });
    var loaded = await loadProfileWithGoals(req.params.id);
    var found = findGoalById(loaded.profileData, req.params.goalId);
    var goal = found.goal;
    var questions = Array.isArray(goal.intake_questions) ? goal.intake_questions : [];

    // Index submitted answers by key; rebuild the full list with question text
    // preserved from intake_questions.
    var byKey = {};
    answers.forEach(function(a) { if (a && a.key != null) byKey[String(a.key)] = a.answer; });
    var intakeAnswers = questions.map(function(q) {
      return { question: q.question, key: q.key, answer: byKey[q.key] != null ? String(byKey[q.key]) : "" };
    });

    goal.intake_answers = intakeAnswers;
    goal.intake_completed = true;
    await saveGoalToProfile(req.params.id, loaded.profileData, found.index, goal);
    res.json({ success: true, intake_completed: true, intake_answers: intakeAnswers });
  } catch (e) {
    console.error("[GoalRoadmap] intake POST error:", e.message);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

// Shared core for building a goal's roadmap via Sonnet, grounded in the
// athlete's actual logged training. Two callers, two write semantics:
//   mode:"reset"      — the cold-start POST /roadmap below: version:1,
//                        adaptation_log:[] (this goal has never had one).
//   mode:"regenerate" — Coach Chat's post-goal-update regen offer (see
//                        applyProposal()'s "regenerate_goal_roadmap"
//                        branch): same generation, but increments the
//                        EXISTING version and appends to adaptation_log
//                        instead of wiping it, since the goal already had
//                        roadmap history worth keeping. Falls back to
//                        "reset" semantics if the goal has no prior
//                        roadmap to increment from.
// Requires intake_completed (always true for a goal that already has a
// roadmap, since that's the only way one could have been generated).
// Returns the updated goal; throws (with .status set for the 400 case) on
// failure — callers decide how to surface it.
async function generateGoalRoadmapForGoal(profileId, goalId, mode) {
  var loaded = await loadProfileWithGoals(profileId);
  var found = findGoalById(loaded.profileData, goalId);
  var goal = found.goal;
  if (!goal.intake_completed) {
    var e0 = new Error("Intake must be completed before generating a roadmap");
    e0.status = 400;
    throw e0;
  }

  var wRes = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + profileId + "&order=date.desc&limit=20&select=date,type", { headers: sbHeaders() });
  var workouts = await wRes.json();
  if (!Array.isArray(workouts)) workouts = [];

  var today = new Date().toISOString().slice(0, 10);
  var ctx = (loaded.profileData.ai_prompt_context || "").substring(0, 1200);
  var brief = (loaded.profile.coaching_brief || "").substring(0, 400);
  var answersStr = (goal.intake_answers || []).map(function(a) { return a.question + ": " + a.answer; }).join("\n");
  var workoutsStr = workouts.map(function(w) { return w.date + ": " + (w.type || "Workout"); }).join("\n");

  // Ground the roadmap in actual logged training: this goal's exercise history
  // + the overall training picture.
  var goalExCtx = await getGoalExerciseContext(profileId, extractGoalKeywords(goal.title), 90);
  var fullEx = await getFullExerciseContext(profileId, 60);

  var sys = "You are an elite fitness coach building a personalized training roadmap. Return ONLY valid JSON matching this exact shape: { timeline_range: string (e.g. '3-6 months' or '8-15 years'), timeline_note: string (1-2 sentences: realistic range for this goal type based on evidence, narrowed by their specific starting point and training frequency), date_confidence: 'high'|'medium'|'low', phases: [...] }. Use 3 near-term phases then 2 horizon phases. Use EXACTLY these JSON keys — do not rename or substitute them (\"title\" and \"duration\" are WRONG):\nnear_term phase: { \"name\": \"Foundation & Awareness\", \"type\": \"near_term\", \"duration_weeks\": 5, \"weekly_targets\": [\"2-3 specific actionable items\"], \"emphasis\": [\"2-4 short imperative phrases\"], \"completion_signals\": [\"2-3 measurable achievements\"], \"status\": \"current\" }\nhorizon phase: { \"name\": \"Full Activity Return\", \"type\": \"horizon\", \"milestone\": \"what defines this\", \"estimated_range\": \"9-14 months\", \"status\": \"upcoming\" }\nname and duration_weeks are REQUIRED on every near_term phase. duration_weeks must be an INTEGER (4-6), never a string like \"Weeks 1-5\". Each near_term phase must ALSO include emphasis: an array of 2-4 short imperative phrases (3-12 words) naming what the athlete's sessions should EMPHASIZE in that phase. emphasis is consumed by the daily recommendation engine, so: NEVER include session counts or weekly frequencies in it (a separate scheduling system owns those), ALWAYS preserve load, weight, rep-scheme and hold-duration language (\"weighted glute bridges 10-20 lbs\", \"bodyweight squats toward 3x20\"), and EXCLUDE anything a workout generator cannot act on (nutrition, journaling, subjective observations, life-context reminders). Use evidence-based timelines — strength research, weight loss rates, skill acquisition data. Widen the range rather than narrow it when uncertain. Be concise — each phase description maximum 2 sentences. The first near_term phase status is 'current', rest are 'upcoming'.";
  var userMsg = "GOAL: " + (goal.title || "Untitled") + " (" + (goal.type || "general") + ")\n" +
    "DESCRIPTION: " + (goal.description || "none") + "\n\n" +
    "INTAKE ANSWERS:\n" + (answersStr || "none") + "\n\n" +
    "EXERCISE CONTEXT FOR THIS GOAL:\n" + JSON.stringify(goalExCtx) + "\n\n" +
    "OVERALL TRAINING PICTURE:\n" + JSON.stringify(fullEx) + "\n\n" +
    "RECENT WORKOUTS (last 20):\n" + (workoutsStr || "none") + "\n\n" +
    "ATHLETE PROFILE:\n" + (ctx || "none") + "\n\n" +
    "COACHING BRIEF:\n" + (brief || "none") + "\n\n" +
    "Today's date: " + today + "\n\nBuild a realistic, phased roadmap for this specific goal.";

  var text = await callAISystem(sys, userMsg, 2500, MODEL_SONNET);
  var parsed = parseAIJson(text);
  if (!parsed || !Array.isArray(parsed.phases)) throw new Error("AI returned an invalid roadmap");
  assignNearTermDates(parsed.phases, today);
  // emphasis[] is requested natively by the generation prompt now; backfill any
  // phase the model omitted so the daily-rec block is never missing it.
  await backfillMissingEmphasis(goal.title, parsed.phases);
  // E4: deterministic one-current-phase invariant, run AFTER the model so it
  // catches the DATE ROLLOVER prompt rule failing to fire.
  var fixedPhases = enforceSingleCurrentPhase(parsed.phases);
  if (fixedPhases.length) {
    console.warn("[Roadmap] enforceSingleCurrentPhase corrected " + fixedPhases.length +
      " phase(s) for '" + (goal.title || "?") + "': " +
      fixedPhases.map(function(f) { return f.phase + " current->complete"; }).join("; "));
  }

  var now = new Date().toISOString();
  var prevRoadmap = goal.roadmap;
  if (mode === "regenerate" && prevRoadmap) {
    goal.roadmap = {
      timeline_range: parsed.timeline_range || null,
      timeline_note: parsed.timeline_note || null,
      date_confidence: parsed.date_confidence || null,
      phases: parsed.phases,
      generated_at: now,
      version: (prevRoadmap.version || 1) + 1,
      adaptation_log: (prevRoadmap.adaptation_log || []).concat([{
        date: now,
        summary: "Roadmap regenerated via Coach Chat after a goal update.",
        trigger: "manual",
      }]),
    };
  } else {
    goal.roadmap = {
      timeline_range: parsed.timeline_range || null,
      timeline_note: parsed.timeline_note || null,
      date_confidence: parsed.date_confidence || null,
      phases: parsed.phases,
      generated_at: now,
      version: 1,
      adaptation_log: [],
    };
  }
  goal.last_adapted_at = now;
  await saveGoalToProfile(profileId, loaded.profileData, found.index, goal);
  recomputeRoadmapProgress(goal.roadmap, goalExCtx);
  return goal;
}

// POST generate the initial roadmap (Sonnet). Requires completed intake.
app.post("/api/profiles/:id/goals/:goalId/roadmap", async function(req, res) {
  try {
    // Default stays "reset" (version -> 1, adaptation_log cleared) so the
    // existing Profile-tab Generate/Regenerate button is unchanged. Opt in to
    // "regenerate" to rebuild the phases while PRESERVING version history and
    // the adaptation log — the right mode when a goal already has real history
    // and only its phase content has gone stale.
    var rmMode = req.query.mode === "regenerate" ? "regenerate" : "reset";
    var goal = await generateGoalRoadmapForGoal(req.params.id, req.params.goalId, rmMode);
    res.json({ success: true, goal: goal });
  } catch (e) {
    console.error("[GoalRoadmap] generate error:", e.message);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

// POST a check-in — adapts the roadmap (Haiku) from the athlete's reflection.
app.post("/api/profiles/:id/goals/:goalId/checkin", async function(req, res) {
  try {
    var notes = (req.body && req.body.notes != null) ? String(req.body.notes) : "";
    var loaded = await loadProfileWithGoals(req.params.id);
    var found = findGoalById(loaded.profileData, req.params.goalId);
    var goal = found.goal;
    if (!goal.roadmap) return res.status(400).json({ success: false, error: "No roadmap to adapt — generate one first" });

    var wRes = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + req.params.id + "&order=date.desc&limit=10&select=date,type", { headers: sbHeaders() });
    var workouts = await wRes.json();
    if (!Array.isArray(workouts)) workouts = [];

    var goalExCtx = null;
    try { goalExCtx = await getGoalExerciseContext(req.params.id, extractGoalKeywords(goal.title), 90); } catch (e) { /* non-fatal */ }
    goal.roadmap = await adaptGoalRoadmap(goal, notes, workouts, "checkin", goalExCtx);
    goal.last_adapted_at = new Date().toISOString();
    await saveGoalToProfile(req.params.id, loaded.profileData, found.index, goal);
    recomputeRoadmapProgress(goal.roadmap, goalExCtx);
    res.json({ success: true, goal: goal });
  } catch (e) {
    console.error("[GoalRoadmap] checkin error:", e.message);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

// GET a single goal (with roadmap, intake, etc.) without fetching the full
// profile. progress_pct is recomputed on read (not stored).
app.get("/api/profiles/:id/goals/:goalId", async function(req, res) {
  try {
    var loaded = await loadProfileWithGoals(req.params.id);
    var found = findGoalById(loaded.profileData, req.params.goalId);
    var goal = found.goal;
    if (goal && goal.roadmap) {
      try {
        var gx = await getGoalExerciseContext(req.params.id, extractGoalKeywords(goal.title), 90);
        recomputeRoadmapProgress(goal.roadmap, gx);
      } catch (e) { recomputeRoadmapProgress(goal.roadmap, null); }
    }
    res.json({ success: true, goal: goal });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

// Pump ONE Anthropic streaming (SSE) response leg, writing text deltas
// straight to `res` as plain text (forwarding ONLY the text, so the client
// reassembles the exact string it previously read from data.content[0].text
// — no SSE parsing needed on the frontend) and collecting any tool_use blocks
// (their JSON input arrives as incremental input_json_delta events, parsed
// once the block closes). Does NOT touch response headers and does NOT call
// res.end() — callers own the response lifecycle so this can run more than
// once per response (coach_chat's tool loop, see pipeAnthropicToolStream) or
// exactly once (daily_recs, via pipeAnthropicStream). A per-chunk idle
// timeout aborts a hung upstream, freshly armed for each leg.
async function pumpAnthropicLeg(upstream, controller, res, label, sse) {
  let buffer = "";
  let usage = null;
  let wroteAny = false;
  let idleTimer = null;
  let legText = "";
  let stopReason = null;
  let toolBlocks = {}; // content_block index -> {id, name, inputJson, input}
  const armIdle = function() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function() {
      try { controller.abort(); } catch (e) {}
    }, 20000);
  };
  armIdle();

  try {
    for await (const chunk of upstream.body) {
      armIdle();
      buffer += chunk.toString("utf8");
      // SSE frames are newline-delimited; content text is JSON-escaped inside
      // the data line, so splitting transport on "\n" is safe.
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.indexOf("data:") !== 0) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let evt;
        try { evt = JSON.parse(payload); } catch (e) { continue; }
        if (evt.type === "content_block_start" && evt.content_block && evt.content_block.type === "tool_use") {
          toolBlocks[evt.index] = { id: evt.content_block.id, name: evt.content_block.name, inputJson: "" };
        } else if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
          res.write(sse ? sseFrame(evt.delta.text) : evt.delta.text);
          legText += evt.delta.text;
          wroteAny = true;
        } else if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "input_json_delta" && toolBlocks[evt.index]) {
          toolBlocks[evt.index].inputJson += (evt.delta.partial_json || "");
        } else if (evt.type === "content_block_stop" && toolBlocks[evt.index]) {
          try { toolBlocks[evt.index].input = JSON.parse(toolBlocks[evt.index].inputJson || "{}"); }
          catch (e) { toolBlocks[evt.index].input = {}; toolBlocks[evt.index].parseError = true; }
        } else if (evt.type === "message_start" && evt.message && evt.message.usage) {
          usage = evt.message.usage;
        } else if (evt.type === "message_delta") {
          if (evt.usage) usage = Object.assign({}, usage || {}, evt.usage);
          if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
        } else if (evt.type === "error") {
          console.error("[AI] stream error event:", JSON.stringify(evt.error || evt));
        }
      }
    }
  } catch (err) {
    console.error("[AI] " + label + " leg read error:", err && err.message);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }

  var toolUses = Object.keys(toolBlocks).map(function(k) { return toolBlocks[k]; }).filter(function(t) { return t.id && t.name; });
  return { legText: legText, usage: usage, wroteAny: wroteAny, stopReason: stopReason, toolUses: toolUses };
}

// Sets response headers + the finish/close observability logging exactly
// once per streamed response. "stream complete" (logged in
// finalizeAnthropicStream below) only means the upstream Anthropic body
// finished and res.end() was CALLED — it says nothing about whether the
// response actually finished flushing to the socket or the connection
// actually closed. Node's 'finish' event fires once all buffered data has
// been handed to the OS; 'close' fires once the underlying connection is
// fully torn down. Logging both separately lets a future incident show
// whether end() was reached but never actually flushed (proxy/socket issue)
// vs never reached at all (a real code bug) — see the 2026-07-15 daily_recs
// streaming-termination investigation in ROADMAP.md.
// One SSE data frame carrying arbitrary model text. JSON-encoded so embedded
// newlines/quotes can't break SSE's newline-delimited framing; the client
// JSON.parses each frame's payload and concatenates. Used only on the
// daily_recs path (session #29) to try to defeat Render's response buffering —
// text/plain is buffered and delivered in one burst at completion (measured
// TTFB == total), which the SSE content-type is meant to disable so bytes flow
// incrementally and the client's idle timer works as designed.
function sseFrame(text) {
  return "data: " + JSON.stringify(text) + "\n\n";
}

function startAnthropicStreamResponse(res, label, sse) {
  res.set({
    "Content-Type": sse ? "text/event-stream; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no", // don't let a proxy buffer the stream
    "Connection": "keep-alive",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  // Prime the SSE connection with a comment frame so the client sees bytes
  // immediately (and any buffering proxy is forced to start flushing).
  if (sse) { try { res.write(": ok\n\n"); } catch (e) {} }
  var resFinished = false;
  res.on("finish", function() {
    resFinished = true;
    console.log("[AI] " + label + " response FINISHED (fully flushed to socket)");
  });
  res.on("close", function() {
    console.log("[AI] " + label + " response CLOSED (connection torn down), finished=" + resFinished);
  });
}

// Logs the final usage + "stream complete" lines and ends the response — the
// single finalize point shared by both streaming paths below so the log
// format (and the finish/close observability) never drifts between them.
function finalizeAnthropicStream(res, label, usage, wroteAny, sse) {
  if (usage) {
    console.log("[AI] usage (stream): input=" + (usage.input_tokens || 0) +
      " output=" + (usage.output_tokens || 0) +
      " cache_write=" + (usage.cache_creation_input_tokens || 0) +
      " cache_read=" + (usage.cache_read_input_tokens || 0));
  }
  console.log("[AI] " + label + " stream complete, wroteAny=" + wroteAny);
  try {
    // SSE terminal marker so the client knows the model text ended cleanly
    // (vs a dropped connection). Harmless on the raw path (never sent).
    if (sse) { try { res.write("data: [DONE]\n\n"); } catch (e) {} }
    res.end();
  } catch (endErr) {
    console.error("[AI] " + label + " res.end() threw:", endErr && endErr.message);
  }
}

// Single-leg streaming path — used by daily_recs, which never sends tools.
// External behavior is UNCHANGED from before the 2026-07-15 tool-use
// refactor (same call site, same signature, same return value): sets
// headers, pumps exactly one Anthropic leg, logs usage + stream-complete,
// ends the response, returns the accumulated text.
async function pipeAnthropicStream(upstream, controller, res, label) {
  label = label || "daily_recs";
  // daily_recs uses SSE (session #29) to defeat Render's response buffering.
  // coach_chat keeps the raw text/plain path via pipeAnthropicToolStream, which
  // calls these same helpers without the sse flag.
  var sse = true;
  startAnthropicStreamResponse(res, label, sse);
  var leg = await pumpAnthropicLeg(upstream, controller, res, label, sse);
  finalizeAnthropicStream(res, label, leg.usage, leg.wroteAny, sse);
  return leg.legText;
}

// Multi-leg streaming path for coach_chat's tool use. Loops: pump a leg; if
// the model's stop_reason is "tool_use", call loopCtx.onToolUse(toolUses) to
// execute them (v1: this NEVER writes real data — it only creates pending
// chat_proposals rows, see executeProposalTool()) and get back tool_result
// content blocks, then loopCtx.fetchNextLeg(...) to re-POST to Anthropic with
// those results appended and continue. Capped at CHAT_MAX_TOOL_LEGS. Text
// from every leg is written to the client and concatenated as it arrives,
// exactly like the single-leg path — there is no hidden or suppressed model
// text. loopCtx.onBeforeFinalize (if provided) runs after the loop ends and
// may return a trailing string (the server-authored proposal marker, never
// model-generated) appended to the stream before it closes.
async function pipeAnthropicToolStream(initialUpstream, controller, res, label, loopCtx) {
  startAnthropicStreamResponse(res, label);
  var fullText = "";
  var usage = null;
  var wroteAny = false;
  var upstream = initialUpstream;
  var legCount = 0;
  var lastLeg = null;

  while (upstream && legCount < CHAT_MAX_TOOL_LEGS) {
    legCount++;
    var leg = await pumpAnthropicLeg(upstream, controller, res, label);
    fullText += leg.legText;
    if (leg.usage) usage = leg.usage;
    wroteAny = wroteAny || leg.wroteAny;
    lastLeg = leg;

    if (leg.stopReason !== "tool_use" || !leg.toolUses.length) break;

    var toolOutcome = await loopCtx.onToolUse(leg.toolUses).catch(function(e) {
      console.error("[AI] " + label + " onToolUse failed:", e && e.message);
      return null;
    });
    if (!toolOutcome) break;

    upstream = await loopCtx.fetchNextLeg(leg, toolOutcome.toolResultBlocks).catch(function(e) {
      console.error("[AI] " + label + " fetchNextLeg failed:", e && e.message);
      return null;
    });
    if (!upstream || !upstream.ok) break;
  }

  if (loopCtx.onBeforeFinalize) {
    var marker = await loopCtx.onBeforeFinalize().catch(function(e) {
      console.error("[AI] " + label + " onBeforeFinalize failed:", e && e.message);
      return "";
    });
    if (marker) {
      res.write(marker);
      fullText += marker;
      wroteAny = true;
    }
  }

  finalizeAnthropicStream(res, label, usage, wroteAny);
  return { fullText: fullText, legCount: legCount, finalStopReason: lastLeg && lastLeg.stopReason };
}

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
//
// daily_recs is STREAMED (Anthropic SSE → plain text) so the response survives
// Render's idle-connection close; all other callTypes use the single-shot
// JSON path unchanged.
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

    // Server-side temperature selection, same authority as model above: a
    // deterministic-intent callType is pinned to 0 and the client cannot
    // override it. Anything NOT in the map is left untouched and keeps the
    // Anthropic default — generative call types (daily_recs, coach_chat, the
    // brief/roadmap writers) are deliberately absent. See CALL_TYPE_TEMPERATURE.
    var pinnedTemp = CALL_TYPE_TEMPERATURE[callType];
    if (typeof pinnedTemp === "number") {
      if (forwarded.temperature !== undefined && forwarded.temperature !== pinnedTemp) {
        console.log("[AI] Overriding client temperature " + forwarded.temperature + " with server-pinned " + pinnedTemp + " for callType=" + callType);
      }
      forwarded.temperature = pinnedTemp;
    }

    // Auto-cache the system prompt. If client sent a plain string, wrap it.
    // If client already sent a structured array, only add cache_control to the
    // last block if none of the blocks already have one (don't clobber).
    //
    // TTL: daily_recs (and coach_chat) use 1-hour TTL because users check in
    // several times a day/session and the prompt is stable across those calls.
    // 1h writes cost 2× (vs 1.25× for 5m) but pay off after ~3 reads, which is
    // typical. All other callers get the 5-minute default. See
    // wrapSystemWithCache() for the shared logic (also used by coach chat,
    // which assembles its own system prompt server-side, bypassing this proxy).
    forwarded.system = wrapSystemWithCache(forwarded.system, callType);

    // Only daily_recs streams — bytes flow continuously to the client so the
    // request doesn't sit idle long enough for Render to close it.
    const wantStream = callType === "daily_recs";
    if (wantStream) forwarded.stream = true;

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
      agent: anthropicStreamAgent,
    });
    console.log("[AI] Anthropic response status=" + response.status + " model=" + chosenModel + (wantStream ? " (streaming)" : ""));

    if (wantStream) {
      // Headers are in; the short request timeout no longer applies — the pump
      // installs its own per-chunk idle timeout.
      clearTimeout(timeoutId);
      if (!response.ok) {
        // Upstream failed before streaming — surface as JSON like the
        // non-streaming path so the client's r.ok check catches it.
        const errData = await response.json().catch(function() {
          return { error: { message: "Anthropic error " + response.status } };
        });
        console.error("[AI] daily_recs upstream error status=" + response.status);
        return res.status(response.status).json(errData);
      }
      return await pipeAnthropicStream(response, controller, res, "daily_recs");
    }

    clearTimeout(timeoutId);
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

// ── AI COACH CHAT ─────────────────────────────────────────────────────────
// One persistent thread per profile for open-ended coaching conversation
// (tweaking workouts/goals/schedule, asking questions) — distinct from the
// structured daily_recs cards and the one-shot "Ask Your History" search.
//
// Unlike daily_recs, whose prompt is assembled CLIENT-side from browser state
// already loaded by page-load fetches (buildScheduleInstruction() etc. in
// public/index.html), chat is a server-driven endpoint with no client state to
// draw on — so buildChatSnapshot() below re-fetches a compact athlete snapshot
// from Supabase on every send, mirroring the pattern getFullExerciseContext()/
// getGoalExerciseContext() already use (independent fetch → compact aggregate
// text), not a duplicate of the client prompt builders.
//
// Streaming reuses pipeAnthropicStream() (see daily_recs above) so Sonnet's
// generation time survives Render's idle-connection window. Because chat
// streams, it doesn't carry daily_recs' non-streamed 25s-Anthropic-timeout
// pressure that forced the 6000-char prompt trim in the June reliability
// pass — CHAT_CHAR_GUARD below is sized for prompt quality/cost, not a race
// against a timeout.
// Shared expert-reasoning core (2026-07-15) — the same S&C-coach reasoning
// standard and sports-medicine-informed (non-diagnostic) judgment injected
// into BOTH coaching prompts: here (appended into CHAT_SYSTEM_PERSONA below)
// and client-side in public/index.html's buildSystemPrompt() (its own copy,
// var EXPERT_REASONING_CORE, defined right before that function — no shared
// module system exists between this Node backend and the static HTML/JS
// frontend, so this is a deliberate duplicate, not a bug. KEEP BOTH COPIES IN
// SYNC — if you edit one, edit the other the same way. This is an ADDITION to
// each prompt's existing personalization/voice text, not a rewrite of it.
var EXPERT_REASONING_CORE =
  "EXPERT REASONING STANDARD: reason like a veteran strength & conditioning coach, not a generic assistant. Manage weekly load and recovery deliberately — weigh advice against actual recent volume and frequency from their real log, not a vague sense they've \"been training a lot.\" Apply progressive overload with real specifics: name the actual increment (+5-10lbs, +1-2 reps, +5-10s hold), not \"add more.\" Know when to hold a load steady (a plateau isn't automatically a signal to push harder) versus when to call a deload (accumulated fatigue, declining performance, readiness trending down). Respect interference effects — never stack two high-CNS sessions (heavy strength, hard sparring, max-effort conditioning) back-to-back without a lighter day between. Treat readiness, HRV, and RHR as autoregulation inputs that change the plan — not color commentary you mention then ignore.\n\n" +
  "Sports-medicine-informed judgment, explicitly NOT diagnosing. Use load-tolerance logic on pain: pain that warms up and eases with movement differs from pain that builds or worsens under load — determine which before suggesting how to train around or rehab an issue. If something suggests more than training management — persistent/worsening pain, anything neurological (numbness, tingling, weakness, radiating pain) — say so plainly, name why, and point to a PT or physician. Never name a specific diagnosis.";

// LENGTH IS LOAD-BEARING, not just style. Anthropic will not create/read a
// prompt cache entry for a system block under its per-model minimum cacheable
// length — 1024 tokens for Sonnet (the model coach_chat uses), 2048 for
// Haiku (per Anthropic's prompt-caching docs). Fixed 2026-07-15: coach_chat
// was logging cache_write=0/cache_read=0 on every call — not a bug in
// wrapSystemWithCache() (verified structurally identical to daily_recs' path)
// but because CHAT_SYSTEM_PERSONA + a deliberately condensed athlete snapshot
// (Part A's fix) was landing well under 1024 tokens for a typical athlete
// (~270 tokens measured against a realistic 8-goal test profile). The fix
// belongs in this STABLE, athlete-independent block, not in snapshot
// padding — padding the snapshot would make caching depend on how much data
// a given athlete happens to have, which is exactly the kind of unreliable
// lever this avoids. Currently ~4950 characters (~1200+ tokens by a
// conservative 4 chars/token estimate) — comfortably over the 1024-token
// floor with margin for tokenizer variance. Keep it above ~4500 characters;
// if you trim this content, re-check the threshold isn't broken again
// (usage log's cache_write/cache_read on a first vs. repeat message is the
// real test — see "Verifying prompt caching" in CLAUDE.md).
var CHAT_SYSTEM_PERSONA =
  "You are ApexCoach's AI coach — the same coaching intelligence that generates this athlete's daily workout recommendations, now available for open-ended conversation. You are not a generic fitness chatbot: you know this specific athlete's real training history, goals, biometrics, and schedule, and every response should read like it comes from someone who has actually been paying attention to their training, not from a template.\n\n" +
  "WHAT YOU KNOW: the ATHLETE SNAPSHOT below (rebuilt fresh for this message, never stale) contains, when present: a TODAY line stating the athlete's current calendar date in their own timezone — when you need to say or reason about \"today\", use that exact date; never assert, compute, or guess a date yourself, and never assume UTC or your own sense of \"now\" — the athlete's actual local day is not something you can infer, only what TODAY states; the athlete's name and profile context (injuries, equipment, training environment); ALL of their long-term goals in priority order — not just the top few, every goal listed is real and current, including ones that might seem minor, like a specific injury or mobility target; their active short-horizon challenges with live progress; a standing Focus Override directive if one is currently active — this is the athlete's own explicit instruction about what to emphasize right now, treat it as a strong signal, not a suggestion you can ignore; their weekly training schedule (fixed sessions, frequency targets, add-ons); today's readiness score if one has been generated yet; their latest cached sleep, HRV, RHR, steps, and weight; and a condensed log of the last 7 days of actual training, INCLUDING anything logged moments ago (this log is rebuilt fresh on every message, not cached). If a section is missing from the snapshot, the athlete genuinely has no data there yet — don't invent it, and don't apologize for its absence, just work with what's actually there. IMPORTANT: only the biometrics (sleep/HRV/RHR/steps/weight) are cache-based, from the last wearable sync — logged workouts are never wearable-synced, they appear the instant they're saved. If the athlete says they just logged something and you don't see it, the honest answer is \"I don't see it yet\" — never guess at a \"sync\" or similar mechanism as the reason; if it's genuinely missing, say so plainly and suggest they check the entry saved correctly, don't fabricate an explanation for why.\n\n" +
  "HOW TO TALK: conversational, direct, and specific — reference real numbers, real exercise names, and real dates when they're relevant to the question. Plain text with light markdown (short lists, bold for emphasis) is fine and usually clearer than dense paragraphs; you are NOT required to return JSON or any fixed structure here, unlike the daily recommendation cards elsewhere in the app. Match the athlete's register — casual questions get casual answers, precise technical questions get precise answers. Never pad a short answer with disclaimers, safety boilerplate, or \"as an AI\" framing — get to the point.\n\n" +
  "WHAT YOU CAN AND CAN'T DO: you can PROPOSE changes, each via a tool call, and each requires the athlete's explicit confirmation before anything is actually written — you never apply a change yourself: updating an existing goal's target/timeline/notes/active-paused state (propose_goal_update — this only updates a goal that already exists, it cannot create or delete one), setting/updating/clearing the standing Focus Override (propose_focus_override), and logging a free-text check-in note (propose_checkin_note). When you call one of these, say what you're PROPOSING and why in your reply — describe it as something you're proposing that they need to confirm, NOT as something already done: never say \"done\", \"updated\", \"changed\", or \"applied\" for a change that is still just a proposal. The app renders the actual confirm/cancel card, you don't need to ask them to \"confirm in the app\" yourself, just explain the change naturally. CRITICAL: if a tool result tells you a change could NOT be prepared, was refused, or failed, do NOT claim it succeeded — say plainly in your reply that it didn't go through and why; never leave a false success claim standing for a change that didn't actually happen. Everything else — creating or deleting goals, editing workouts or exercises, changing the weekly schedule, adjusting settings — you have no tool for; tell them exactly where in the app to make that change (for example, \"update that under Profile > Schedule\") and never imply you've already made an edit you haven't made. You also don't have live wearable data beyond what's in the snapshot — no live Fitbit or Google Health call happens per message, only the last cached sync — so if they ask about something more current than the snapshot's timestamp, say so plainly instead of guessing.\n\n" +
  "ONE MORE CARD YOU DON'T CREATE: when a goal-update proposal you made gets confirmed and that goal already has a roadmap, the app automatically shows the athlete a separate card offering to regenerate it — this happens on its own, not from anything you call. Thread history may show a system note about this alongside the athlete's confirmation. If the athlete asks about that card, just explain simply that a roadmap can drift out of sync after a goal change and the app offers to refresh it — you don't need to do anything else about it.\n\n" +
  "COACHING JUDGMENT: weigh advice against injuries and physical limitations mentioned in their profile context — never suggest something that would aggravate a known issue. Treat their active challenges and any standing Focus Override as close to non-negotiable unless the athlete is explicitly asking you to reconsider them. When discussing schedule or workout changes, reason from what's actually in their schedule and recent training log, not generic fitness advice divorced from their real data. If a question falls genuinely outside what the snapshot covers — nutrition specifics, something with zero connection to their logged data — answer as a knowledgeable coach would, but be upfront that you're reasoning generally rather than from their specific numbers.\n\n" +
  EXPERT_REASONING_CORE + "\n\n" +
  "CONVERSATION MEMORY: this is a persistent, ongoing thread, not a one-shot exchange — the athlete may return to it days or weeks apart. Recent turns appear below as normal conversation history; once a thread gets long, its older portion gets folded into a short running summary (you'll see it as \"EARLIER IN THIS CONVERSATION (summarized)\" after the snapshot, when present) rather than kept verbatim — treat that summary as reliable background, not something to re-litigate or ask the athlete to repeat. Don't re-introduce yourself or re-explain what you are partway through an existing thread; pick up naturally from where the conversation left off, the way an actual coach who remembers the last conversation would.\n\n" +
  "VOICE CALIBRATION, concretely: if asked \"should I train today?\" a bad answer is a generic essay on recovery science; a good answer opens with a direct read of their actual readiness/sleep/HRV from the snapshot and what it means for THEM today, in a sentence or two, before any elaboration they didn't ask for. If asked about a specific goal, name it and its current status rather than describing goals in the abstract. If they vent about a bad session or an injury flare-up, acknowledge it briefly like a person would, then move to something useful — don't clinically dissect their feelings. You're a knowledgeable training partner who happens to have their full history in front of them, not a customer-support agent working from a script.";

// Combined system-snapshot + thread-history budget for one chat call. Chat
// streams (see above), so this is NOT sized against a non-streamed-timeout
// constraint like daily_recs' 6000-char guard — it's a deliberate cap on
// prompt size/cost. Tune here if it's too tight/loose in practice.
var CHAT_CHAR_GUARD = 20000;
// Athlete snapshot (profile/goals/challenges/schedule/biometrics/recent
// training) is built to fit within this on its own, leaving the rest of
// CHAT_CHAR_GUARD for thread history. This is a SOFT cap: only the elastic
// sections (recent-exercise log, then profile context) are trimmed to hit it,
// and hitting it always logs a warning (see buildChatSnapshot). Goals/
// challenges/focus-override/schedule/biometrics are never cut to make this
// number — see CHAT_SNAPSHOT_HARD_CAP for the real backstop.
var CHAT_SNAPSHOT_CHAR_CAP = 5000;
// Absolute ceiling. If trimming the elastic sections isn't enough to get
// under this, lowest-priority goals are dropped one at a time (from the tail
// of the priority-ordered list) until under budget — each drop is logged
// loudly. This should never fire in practice; if it does, CHAT_SNAPSHOT_CHAR_CAP
// is too tight for this athlete's goal/challenge count and should be raised.
var CHAT_SNAPSHOT_HARD_CAP = 8000;
// Once a thread has more than this many messages since the last summary
// cutoff, fire-and-forget summarization folds the older portion into
// chat_threads.summary and advances the cutoff, always leaving the most
// recent CHAT_SUMMARIZE_KEEP_TAIL messages verbatim.
var CHAT_SUMMARIZE_TRIGGER = 24;
var CHAT_SUMMARIZE_KEEP_TAIL = 20;

// ── COACH CHAT TOOL USE (2026-07-15) ─────────────────────────────────────
// v1 write scope, deliberately narrow: update an EXISTING goal, set/clear the
// standing Focus Override, log a free-text check-in note. Explicitly NOT
// supported: creating/deleting goals, editing workouts/exercises, schedule
// changes — the persona (WHAT YOU CAN AND CAN'T DO, above) tells the model to
// redirect those to the app. No tool ever writes real data directly — see
// pipeAnthropicToolStream()/executeProposalTool() below: a tool call only
// ever creates a PENDING chat_proposals row; the actual write happens later,
// only after the athlete confirms via a dedicated endpoint.
var COACH_CHAT_TOOLS = [
  {
    name: "propose_goal_update",
    description: "Propose an update to one of the athlete's EXISTING long-term goals: target value/unit, target date, notes, or active/paused state. Cannot create or delete a goal. Not applied immediately — the athlete sees a confirm/cancel card and must confirm before anything changes.",
    input_schema: {
      type: "object",
      properties: {
        goal_id: { type: "string", description: "The id of the goal to update — read it from the GOALS section of the athlete snapshot, never guess it." },
        target_value: { type: "number", description: "New target value, only if changing it." },
        unit: { type: "string", description: "Unit for target_value (e.g. lbs, miles, reps), only if changing it." },
        target_date: { type: "string", description: "New target date as YYYY-MM-DD, only if changing it." },
        notes: { type: "string", description: "New/updated free-text notes (replaces the goal's description), only if changing it." },
        active: { type: "boolean", description: "true to reactivate the goal, false to pause it, only if changing it." },
        reason: { type: "string", description: "One plain sentence explaining why this change makes sense right now — shown to the athlete on the confirmation card." }
      },
      required: ["goal_id", "reason"]
    }
  },
  {
    name: "propose_focus_override",
    description: "Propose setting, updating, or clearing the athlete's standing Focus Override (a time-boxed directive that reshapes daily recommendations). Not applied immediately — the athlete sees a confirm/cancel card.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "clear"], description: "'set' to create or update the override, 'clear' to turn it off entirely." },
        text: { type: "string", description: "The focus directive text — required when action is 'set'." },
        mode: { type: "string", enum: ["replace", "boost", "sprinkle", "infuse", "total"], description: "Override mode — required when action is 'set'. See the FOCUS OVERRIDE line in the athlete snapshot for the current mode if updating one already active." },
        start_date: { type: "string", description: "YYYY-MM-DD, defaults to today if omitted." },
        end_date: { type: "string", description: "YYYY-MM-DD, defaults to 90 days out if omitted." },
        reason: { type: "string", description: "One plain sentence explaining why — shown on the confirmation card." }
      },
      required: ["action", "reason"]
    }
  },
  {
    name: "propose_checkin_note",
    description: "Propose logging a free-text note to today's check-in (how a session felt, a symptom to track, context for tomorrow). Does not touch structured energy/soreness/severity fields — those are only set from the app's check-in form. Not applied immediately — the athlete sees a confirm/cancel card.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "The free-text note to log." }
      },
      required: ["note"]
    }
  }
];
// NOTE: roadmap regeneration after a goal update is NOT a model-callable
// tool (there is no propose_roadmap_regen here) — it's auto-created
// server-side by maybeAutoOfferRoadmapRegen() when a confirmed update_goal
// proposal's goal already has a roadmap. Live verification (2026-07-15)
// found the model-initiated version unreliable: three different prompt
// strategies all produced the model narrating an offer in text without ever
// actually emitting the tool_use call. See maybeAutoOfferRoadmapRegen()'s
// comment for the full account. computeRoadmapRegenProposal() /
// applyProposal()'s "regenerate_goal_roadmap" branch are still the exact
// same functions — only the trigger moved from a tool call to a direct
// server-side call after confirm.

// ENGINE v2 — session/preference tools, offered ONLY to a flagged profile
// (see buildCoachChatTools). A v1 profile never sees these, so a v1 Coach Chat
// call sends the exact same COACH_CHAT_TOOLS array as before (byte-identical).
var COACH_CHAT_TOOLS_V2 = [
  {
    name: "propose_session_change",
    description: "Propose a change to ONE of the athlete's FUTURE planned sessions (not today's — for today, tell them to use the 'want something else' variation buttons on the Today card, which are ephemeral and don't alter the plan). You can swap an exercise, adjust volume or intensity, or change a MOVABLE session's category. You CANNOT change a session marked FIXED (an immovable commitment). Not applied immediately — the athlete confirms a card first.",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "integer", description: "The [id N] of the planned session to change — read it from THIS WEEK'S PLANNED SESSIONS in the snapshot. Must be a future date, never today or a past date." },
        change_summary: { type: "string", description: "One plain sentence describing the change in athlete-facing terms (e.g. 'swap the barbell rows for dumbbell rows', 'drop to 30 minutes', 'make it lower intensity')." },
        new_category: { type: "string", description: "Only if changing the session's category (movable sessions only). One of: strength, cardio, martial_arts, sports, mind_body, rehab, other." },
        new_intensity: { type: "string", enum: ["low", "medium", "high"], description: "Only if changing intensity." },
        new_duration_min: { type: "integer", description: "Only if changing the session length." },
        exercise_swaps: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } }, description: "Only if swapping specific exercises — each {from: currentName, to: replacementName}." },
        reason: { type: "string", description: "One plain sentence explaining why this change makes sense — shown on the confirmation card." }
      },
      required: ["session_id", "change_summary", "reason"]
    }
  },
  {
    name: "propose_skip_session",
    description: "Propose marking a FUTURE planned session as skipped or rescheduled. Cannot skip a FIXED session. Not applied immediately — the athlete confirms first.",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "integer", description: "The [id N] of the future planned session, from the snapshot." },
        action: { type: "string", enum: ["skip", "reschedule"], description: "'skip' marks it skipped; 'reschedule' moves it to a new date." },
        new_date: { type: "string", description: "YYYY-MM-DD — required when action is 'reschedule'. Must be within this planning week and in the future." },
        reason: { type: "string", description: "One plain sentence — shown on the confirmation card." }
      },
      required: ["session_id", "action", "reason"]
    }
  },
  {
    name: "propose_standing_preference",
    description: "Propose recording a STANDING training preference the athlete states in conversation (e.g. 'I never want to train legs on Mondays', 'I prefer dumbbells over barbells', 'no running, my knee hates it'). This is remembered and factored into future planning. Not applied immediately — the athlete confirms first.",
    input_schema: {
      type: "object",
      properties: {
        preference: { type: "string", description: "The preference in the athlete's own terms, as a short standing rule." },
        reason: { type: "string", description: "One plain sentence — shown on the confirmation card (usually just restating what they asked for)." }
      },
      required: ["preference", "reason"]
    }
  }
];

// Coach Chat tools for a given profile. v1 (or a v2 migration not yet run) gets
// the exact original array; a flagged profile also gets the v2 session tools.
function buildCoachChatTools(isV2) {
  return isV2 ? COACH_CHAT_TOOLS.concat(COACH_CHAT_TOOLS_V2) : COACH_CHAT_TOOLS;
}

// Appended to the system persona for a flagged profile. Tells the model about
// the v2 session tools, the today-vs-future rule (which prevents cache/plan
// desync), and the no-re-planning boundary.
var CHAT_PERSONA_V2_ADDENDUM =
  "\n\nENGINE v2 — THIS ATHLETE IS ON THE v2 PLANNING ENGINE. The ENGINE v2 STATE section of the snapshot shows today's autoregulated session, this week's planned sessions (each with an [id]), the dossier, goal tiers, progression and recency. You have THREE extra proposal tools for this athlete: propose_session_change, propose_skip_session, propose_standing_preference. Rules you must follow:\n" +
  "- These edit FUTURE planned sessions only. NEVER propose a change to today's session — if the athlete wants today to be different, tell them to tap the variation buttons ('Shorter', 'Not feeling it', etc.) on the Today card, which show an alternative without changing their actual plan.\n" +
  "- NEVER propose changing a session marked FIXED — those are immovable commitments (like a class). If asked, explain it's a fixed commitment and offer to change the work around it on another day instead.\n" +
  "- NEVER propose something that conflicts with an active injury flag in the dossier. Refuse it in plain language and say why.\n" +
  "- You propose edits to individual sessions. You do NOT re-plan the week or regenerate the block — if the athlete wants a fresh plan, tell them the plan refreshes overnight, or that a bigger change is best done by adjusting their goals/schedule.\n" +
  "- Every proposal is still confirm-first: the athlete sees a card and must confirm before anything changes. Say what you're proposing and why, naturally.";

// Hard cap on Anthropic call legs within one coach_chat send (1 initial call +
// up to N tool-result continuations). Guards against a runaway tool loop —
// should never be hit in practice with the simple, non-chaining write tools.
var CHAT_MAX_TOOL_LEGS = 4;

// Compact, provider-agnostic reading of the v2 schedule shape (see "Weekly
// Schedule (v2)" in CLAUDE.md) into one line — NOT a reimplementation of
// buildScheduleInstruction()'s anchor-lock/variety-analysis logic, which is
// client-only and enforces same-day scheduling rules daily_recs needs; chat
// just needs the athlete's schedule to be visible to the model.
function formatScheduleForChat(schedule) {
  if (!schedule) return "";
  var DAY_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  var parts = [];

  var anchors = schedule.anchors || {};
  var anchorBits = [];
  Object.keys(anchors).forEach(function(day) {
    var acts = anchors[day];
    if (!Array.isArray(acts)) return;
    acts.forEach(function(a) {
      if (a && a.activity) anchorBits.push((DAY_LABEL[day] || day) + " " + a.activity + (a.duration ? " (" + a.duration + "min)" : ""));
    });
  });
  if (anchorBits.length) parts.push("Fixed: " + anchorBits.join(", "));

  var targets = Array.isArray(schedule.frequency_targets) ? schedule.frequency_targets : [];
  if (targets.length) {
    parts.push("Targets: " + targets.map(function(t) {
      return t.activity + " " + t.times_per_week + "x/week" + (t.suggested_day ? " (suggested " + (DAY_LABEL[t.suggested_day] || t.suggested_day) + ")" : "");
    }).join(", "));
  }

  var addons = Array.isArray(schedule.addons) ? schedule.addons : [];
  if (addons.length) {
    parts.push("Add-ons: " + addons.map(function(a) {
      return a.activity + " " + (a.duration || "?") + "min x" + (a.days_per_week || "?") + "/week";
    }).join(", "));
  }

  return parts.join(" | ");
}

// One line per exercise row, newest first — matches the condensed
// "DATE: EXERCISE (SETS x REPS @ WEIGHT)" format the June daily-recs
// prompt-trim landed on (see ROADMAP.md 2026-06-18 session), reused here for
// consistency even though chat isn't under the same size pressure. Also
// returns the distinct workout_ids represented, so buildTodayWorkoutFallback
// (below) can tell which of today's workouts DON'T have exercise rows yet.
// `profile` (used for its .timezone) is passed in by buildChatSnapshot, which
// already has it loaded — this avoids a second profile fetch. localToday()
// falls back to UTC if profile/timezone is missing, so this stays correct
// even called with `profile` undefined.
async function buildRecentExerciseLog(profileId, days, profile) {
  var since = localToday(profile, -(days || 7));
  var r = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + profileId +
    "&date=gte." + since +
    "&select=name,date,sets,reps,weight_lbs,duration_minutes,distance_miles,workout_id&order=date.desc&limit=200",
    { headers: sbHeaders() });
  var rows = await r.json();
  if (!Array.isArray(rows)) return { lines: [], workoutIds: [] };
  var workoutIds = [];
  var lines = rows.map(function(e) {
    if (e.workout_id != null && workoutIds.indexOf(e.workout_id) === -1) workoutIds.push(e.workout_id);
    var bits = [];
    if (e.sets != null && e.reps != null) bits.push(e.sets + "x" + e.reps);
    else if (e.reps != null) bits.push(e.reps + " reps");
    if (e.weight_lbs != null) bits.push("@ " + e.weight_lbs + "lbs");
    if (e.duration_minutes != null) bits.push(e.duration_minutes + "min");
    if (e.distance_miles != null) bits.push(e.distance_miles + "mi");
    return e.date + ": " + e.name + (bits.length ? " (" + bits.join(" ") + ")" : "");
  });
  return { lines: lines, workoutIds: workoutIds };
}

// Fixes a real gap (2026-07-15): exercise rows are extracted ASYNCHRONOUSLY
// after a workout save completes — the client's saveWorkoutToSupabase() fires
// POST /api/workouts, then, only once THAT resolves, fires a SEPARATE
// POST .../extract-exercises call as its own follow-up chain (see
// public/index.html). That extraction call runs its own Haiku request, so
// there's a real multi-second window (or longer/never, if extraction fails or
// the notes don't parse into anything recognizable) where a workout is fully
// saved in `workouts` but has ZERO rows in `exercises` yet.
// buildRecentExerciseLog() only reads `exercises`, so during that window a
// just-logged session is invisible to chat — reproduced 2026-07-15: the model
// filled the gap with a fabricated "you may need to sync" explanation, which
// is doubly wrong since workouts are logged directly, never wearable-synced.
// This reads today's raw `workouts` rows directly and adds a fallback line
// for any that AREN'T yet represented in the exercises the query above found
// (cross-referenced by workout_id) — so a just-logged session is visible
// immediately, and the fallback line naturally stops appearing on the next
// message once extraction actually completes and its exercises show up.
async function buildTodayWorkoutFallback(profileId, today, extractedWorkoutIds) {
  var r = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + profileId +
    "&date=eq." + today + "&select=id,type,notes,done&order=ts.desc",
    { headers: sbHeaders() });
  var rows = await r.json();
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(function(w) { return w.id != null && extractedWorkoutIds.indexOf(w.id) === -1; })
    .map(function(w) {
      var notesSnippet = (w.notes || "").trim();
      if (notesSnippet.length > 200) notesSnippet = notesSnippet.slice(0, 200) + "…";
      return today + ": " + (w.type || "Workout") + (w.done === false ? " (not marked done)" : "") +
        (notesSnippet ? " — " + notesSnippet : "") + " [logged just now, not yet broken into exercise data]";
    });
}

// One condensed line per long-term goal (profile_data.goals[]), using only
// already-stored fields (title/type/target_value/current_value/unit/status) —
// NOT a fresh AI-computed progress %, which is what POST /goal-progress does.
// Recomputing that per chat message would mean an extra AI call on every
// send; this trades precision for staying DB-only, consistent with the
// biometrics section below.
function formatGoalLineForChat(g, idx) {
  var line = (idx + 1) + ") " + (g.title || "Untitled") + (g.type ? " [" + g.type + "]" : "");
  if (g.target_value != null) {
    line += " — " + (g.current_value != null ? g.current_value : 0) + "/" + g.target_value + (g.unit ? " " + g.unit : "");
  } else if (g.current_value != null) {
    line += " — " + g.current_value + (g.unit ? " " + g.unit : "%");
  } else if (g.status) {
    line += " — " + g.status;
  }
  // has-roadmap marker: lets the model decide whether propose_roadmap_regen
  // is even offerable for this goal (never offer for a roadmap-less goal).
  if (g.roadmap) line += " [has roadmap v" + (g.roadmap.version || 1) + "]";
  // id: was previously MISSING from this line despite propose_goal_update's
  // tool description telling the model to "read it from the GOALS section
  // ... never guess it" — a real pre-existing gap (found 2026-07-15 while
  // wiring up propose_roadmap_regen, which also needs goal_id). Fixed here
  // since both tools depend on it.
  line += " (id: " + g.id + ")";
  return line;
}

// One condensed line per active micro-goal (Active Challenge).
function formatChallengeLineForChat(m) {
  var unit = m.target_unit ? " " + m.target_unit : "";
  return "- " + m.title + " [" + (m.type || "?") + "] — " + (m.current_value != null ? m.current_value : 0) + "/" + m.target_value + unit;
}

// Mirrors resolveFocusOverride()'s STANDING-DIRECTIVE branch in
// public/index.html (not the per-call 'force'/'total'/'skip' daily flags,
// which only apply to the daily-recs card, not chat): active + text + today
// inside [start_date, end_date]. profile_data.focus_override is already
// fetched as part of the profile row (PROFILE_SELECT_BASE selects the whole
// profile_data column) — this was a pure omission, not missing data.
function summarizeFocusOverrideForChat(pd, today) {
  var fo = pd && pd.focus_override;
  if (!fo || !fo.active || !fo.text) return "";
  var start = fo.start_date || "";
  var end = fo.end_date || "9999-99-99";
  if (today < start || today > end) return "";
  var scopeTxt = (fo.scope === "all" || fo.scope === undefined) ? "all goals" : "specific goals only";
  var mode = fo.mode || "infuse";
  var MODE_NOTE = {
    replace: "replaces normal goal-priority weighting",
    boost: "boosted ~60-70% above normal goal weighting",
    sprinkle: "1-2 non-anchored sessions/week nudged toward this, goal weighting otherwise unchanged",
    infuse: "woven into whatever's already planned, schedule/category unchanged",
    total: "bypasses even the fixed schedule — the only mode that can override a locked commitment",
  };
  return "FOCUS OVERRIDE (standing directive, active " + start + " to " + end + ", mode: " + mode +
    " — " + (MODE_NOTE[mode] || mode) + ", scope: " + scopeTxt + "): " + fo.text;
}

// Server-side athlete snapshot for chat — profile/goals/challenges/focus
// override/schedule (from profile_data, one fetch) + latest cached biometrics
// (daily_sleep/daily_steps/body_metrics — DB-first, same philosophy as the
// life-os-summary fast path: no live Fitbit/Google Health call, so chat never
// blocks on or gets taken down by a wearable-API outage) + a condensed 7-day
// exercise log.
// NOTE: zone/active-minutes aren't persisted anywhere in the schema (only
// held transiently in the /daily response as prevZones) — omitted here rather
// than adding a live wearable call per chat message, which would reintroduce
// the class of latency/outage risk the June hardening pass fixed. Flagged as
// a known gap, not silently dropped.
//
// CAP DISCIPLINE (2026-07 fix — see ROADMAP.md changelog): goals/challenges/
// focus-override/schedule/biometrics are NEVER truncated to hit
// CHAT_SNAPSHOT_CHAR_CAP — only the exercise log and (as a second resort)
// profile context are elastic. If the athlete's goal/challenge count is large
// enough to blow even CHAT_SNAPSHOT_HARD_CAP, lowest-priority goals are
// dropped one at a time (never a mid-string slice) and every drop is logged.
// A prior version silently sliced goals to the first 5 regardless of budget —
// that bug (not a cap issue at all) is what this rewrite fixes.
async function buildChatSnapshot(profileId, opts) {
  opts = opts || {};

  var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId +
    "&select=" + PROFILE_SELECT_BASE + ",daily_recommendations_readiness,daily_recommendations_date",
    { headers: sbHeaders() });
  var prows = await pr.json();
  var profile = (Array.isArray(prows) && prows[0]) || {};
  // Athlete's timezone (2026-07-15 fix — the original reported bug this whole
  // pass stems from): "today" must be computed AFTER the profile fetch above,
  // not before, since it now depends on profile.timezone. PROFILE_SELECT_BASE
  // already includes timezone, so this is free — no extra round-trip.
  var today = localToday(profile);
  var pd = profile.profile_data || {};
  var goals = Array.isArray(pd.goals) ? pd.goals : [];

  var mgPromise = fetch(SUPABASE_URL + "/rest/v1/micro_goals?profile_id=eq." + profileId +
    "&is_active=eq.true&select=title,type,target_value,target_unit,current_value&order=created_at.desc&limit=50",
    { headers: sbHeaders() }).then(function(r) { return r.json(); }).catch(function() { return []; });
  var sleepPromise = fetch(SUPABASE_URL + "/rest/v1/daily_sleep?profile_id=eq." + profileId +
    "&select=date,hours,score,hrv,rhr&order=date.desc&limit=1",
    { headers: sbHeaders() }).then(function(r) { return r.json(); }).catch(function() { return []; });
  // 30-day sleep trend (2026-07-17) — separate from sleepPromise above (which
  // stays a lean single-row fetch for the existing "LATEST BIOMETRICS" line).
  // One query, non-fatal: a failure resolves to [] exactly like every other
  // promise here, which naturally omits the SLEEP HISTORY block below rather
  // than blocking the send.
  var sleepHistoryPromise = fetch(SUPABASE_URL + "/rest/v1/daily_sleep?profile_id=eq." + profileId +
    "&date=gte." + localToday(profile, -30) +
    "&select=date,hours,score,deep_minutes,rem_minutes&order=date.asc",
    { headers: sbHeaders() }).then(function(r) { return r.json(); }).catch(function(e) {
      console.warn("[Chat] sleep-history fetch failed for profile " + profileId + ": " + e.message);
      return [];
    });
  var stepsPromise = fetch(SUPABASE_URL + "/rest/v1/daily_steps?profile_id=eq." + profileId +
    "&select=date,steps&order=date.desc&limit=1",
    { headers: sbHeaders() }).then(function(r) { return r.json(); }).catch(function() { return []; });
  var bodyPromise = fetch(SUPABASE_URL + "/rest/v1/body_metrics?profile_id=eq." + profileId +
    "&select=date,weight_lbs,bmi&order=date.desc&limit=1",
    { headers: sbHeaders() }).then(function(r) { return r.json(); }).catch(function() { return []; });
  var exLogPromise = buildRecentExerciseLog(profileId, 7, profile).catch(function() { return { lines: [], workoutIds: [] }; });

  var microGoals = await mgPromise;
  if (!Array.isArray(microGoals)) microGoals = [];
  var sleepRows = await sleepPromise, stepsRows = await stepsPromise, bodyRows = await bodyPromise;
  var sleepHistoryRows = await sleepHistoryPromise;
  if (!Array.isArray(sleepHistoryRows)) sleepHistoryRows = [];
  var exLogResult = await exLogPromise;
  var exLines = exLogResult.lines;
  var todayFallbackLines = await buildTodayWorkoutFallback(profileId, today, exLogResult.workoutIds).catch(function() { return []; });
  // Prepend — exLines is already newest-first (order=date.desc), and "today"
  // is definitionally the newest possible date, so this preserves that
  // invariant without needing any change to the trim logic below.
  exLines = todayFallbackLines.concat(exLines);
  var sleep = (Array.isArray(sleepRows) && sleepRows[0]) || null;
  var steps = (Array.isArray(stepsRows) && stepsRows[0]) || null;
  var body = (Array.isArray(bodyRows) && bodyRows[0]) || null;

  // Priority-ordered, one line per goal, ALL goals — no count cap (see the
  // CAP DISCIPLINE note above; a hardcoded slice(0,5) here was the actual bug
  // behind "chat only sees ~4-5 of my goals"). Kept as an array (not
  // pre-joined) so the hard-cap last-resort below can drop from the tail.
  var goalLines = goals.map(formatGoalLineForChat);
  var challengeLines = microGoals.map(formatChallengeLineForChat);
  var foTxt = summarizeFocusOverrideForChat(pd, today);
  var schedTxt = formatScheduleForChat(pd.schedule);

  var coreLines = []; // never trimmed except by the hard-cap goal-drop last resort
  if (goalLines.length) coreLines.push("GOALS (priority order):\n" + goalLines.join("\n"));
  if (challengeLines.length) coreLines.push("ACTIVE CHALLENGES:\n" + challengeLines.join("\n"));
  if (foTxt) coreLines.push(foTxt);
  if (schedTxt) coreLines.push("SCHEDULE: " + schedTxt);
  if (profile.daily_recommendations_date === today && profile.daily_recommendations_readiness != null) {
    coreLines.push("TODAY'S READINESS: " + profile.daily_recommendations_readiness + "/100");
  }
  if (sleep) {
    var sd = sleep.date === today ? "today" : sleep.date;
    var bioBits = [];
    if (sleep.hrv != null) bioBits.push("HRV " + sleep.hrv + "ms");
    if (sleep.rhr != null) bioBits.push("RHR " + sleep.rhr + "bpm");
    if (sleep.hours != null) bioBits.push("Sleep " + sleep.hours + "h (score " + (sleep.score != null ? sleep.score : "n/a") + ")");
    if (bioBits.length) coreLines.push("LATEST BIOMETRICS (" + sd + "): " + bioBits.join(", "));
  }
  if (steps && steps.steps != null) coreLines.push("LATEST STEPS (" + steps.date + "): " + steps.steps);
  if (body && (body.weight_lbs != null || body.bmi != null)) {
    coreLines.push("LATEST WEIGHT (" + body.date + "): " +
      (body.weight_lbs != null ? body.weight_lbs + "lbs" : "n/a") +
      (body.bmi != null ? " (BMI " + body.bmi + ")" : ""));
  }
  // Sleep trend (2026-07-17) — one compact line per day, oldest first (matches
  // sleepHistoryRows' own date.asc order). Days with a daily_sleep row but
  // every selected field null (rare) are skipped entirely rather than
  // emitting an empty "DATE:" line; days with NO row at all (a wearable-sync
  // gap) are never fabricated as zeros — the header says so explicitly so
  // the model doesn't misread a gap as "no sleep that night."
  if (sleepHistoryRows.length) {
    var shLines = sleepHistoryRows.map(function(r) {
      var bits = [];
      if (r.hours != null) bits.push(r.hours + "h");
      if (r.score != null) bits.push("s" + r.score);
      if (r.deep_minutes != null) bits.push("d" + r.deep_minutes + "m");
      if (r.rem_minutes != null) bits.push("r" + r.rem_minutes + "m");
      return bits.length ? (r.date + " " + bits.join(" ")) : null;
    }).filter(Boolean);
    if (shLines.length) {
      coreLines.push("SLEEP HISTORY (30d, h=hrs s=score d=deep-min r=rem-min; a date not listed = wearable-sync gap, not zero sleep):\n" + shLines.join("\n"));
    }
  }

  var ctxCap = 600; // elastic (tier 2, after the exercise log) — see below
  var buildHeader = function() {
    // Always present (2026-07-15) so the persona's "use the snapshot's stated
    // date" instruction always has something concrete to point to — before
    // this, a date only appeared in the snapshot via "TODAY'S READINESS",
    // which is conditional on a same-day daily rec existing.
    var h = ["TODAY: " + today, "ATHLETE: " + (profile.name || "Unknown")];
    var ctx = (pd.ai_prompt_context || "").trim();
    if (ctx) h.push("PROFILE CONTEXT: " + (ctx.length > ctxCap ? ctx.slice(0, ctxCap) + "…" : ctx));
    return h.concat(coreLines).join("\n");
  };

  var header = buildHeader();
  var budgetForLog = Math.max(0, CHAT_SNAPSHOT_CHAR_CAP - header.length - 40);
  var logBlock = "";
  if (exLines.length) {
    var kept = exLines.slice();
    while (kept.join("\n").length > budgetForLog && kept.length > 1) kept.shift(); // drop oldest lines first (array is newest-first, so shift = drop oldest tail)
    logBlock = "\nRECENT TRAINING (last 7 days):\n" + kept.join("\n");
  }

  var snapshot = header + logBlock;

  // Soft cap: exercise-log trim above is the only "normal" lever. If core
  // content alone (goals/challenges/override/schedule/biometrics) pushes past
  // it, that's worth knowing about but NOT worth silently cutting — log and
  // move on.
  if (snapshot.length > CHAT_SNAPSHOT_CHAR_CAP) {
    console.warn("[Chat] snapshot for profile " + profileId + " exceeded soft cap (" +
      snapshot.length + "/" + CHAT_SNAPSHOT_CHAR_CAP + " chars) even after trimming the exercise log — " +
      goalLines.length + " goals, " + challengeLines.length + " challenges. Not truncating; see hard cap.");
  }

  // Hard cap: last-resort trims, in order — (1) shrink profile context
  // further, (2) drop lowest-priority goals from the tail one at a time.
  // Every drop is logged; this should basically never fire.
  if (snapshot.length > CHAT_SNAPSHOT_HARD_CAP) {
    ctxCap = 200;
    header = buildHeader();
    snapshot = header + logBlock;
  }
  while (snapshot.length > CHAT_SNAPSHOT_HARD_CAP && goalLines.length > 0) {
    var dropped = goalLines.pop();
    console.warn("[Chat] snapshot for profile " + profileId + " still over HARD cap (" +
      CHAT_SNAPSHOT_HARD_CAP + ") after context trim — dropping lowest-priority goal from this call's " +
      "snapshot: \"" + dropped + "\". Raise CHAT_SNAPSHOT_CHAR_CAP/HARD_CAP if this recurs.");
    coreLines = [];
    if (goalLines.length) coreLines.push("GOALS (priority order):\n" + goalLines.join("\n"));
    if (challengeLines.length) coreLines.push("ACTIVE CHALLENGES:\n" + challengeLines.join("\n"));
    if (foTxt) coreLines.push(foTxt);
    if (schedTxt) coreLines.push("SCHEDULE: " + schedTxt);
    if (profile.daily_recommendations_date === today && profile.daily_recommendations_readiness != null) {
      coreLines.push("TODAY'S READINESS: " + profile.daily_recommendations_readiness + "/100");
    }
    header = buildHeader();
    snapshot = header + logBlock;
  }

  // Always-on, lightweight visibility (not a full dump — see the ?debug=1
  // path in the send handler for that) so this class of bug is never silent
  // again without spamming logs on every message.
  console.log("[Chat] snapshot for profile " + profileId + ": " + snapshot.length + " chars, " +
    goals.length + " goals, " + microGoals.length + " challenges" + (foTxt ? ", focus override active" : ""));

  // ENGINE v2: a flagged profile gets an appended v2 section (plan, dossier,
  // tiers, progression, recency). PURE APPEND — the v1 snapshot above is
  // byte-identical for a v1 profile, which never enters this branch. Its own
  // fetches are separate from the v1 query, so v1's snapshot build is untouched.
  if (pd.engine_v2 === true) {
    try {
      var v2Section = await buildV2ChatSnapshotSection(profileId, profile, today);
      if (v2Section) {
        snapshot += "\n\n" + v2Section;
        console.log("[Chat] v2 snapshot section for profile " + profileId + ": " + v2Section.length + " chars (total now " + snapshot.length + ")");
      }
    } catch (e) {
      console.warn("[Chat] v2 snapshot section failed (non-fatal, plain reply): " + (e && e.message));
    }
  }

  if (opts.debug) {
    console.log("[Chat] ---- FULL SNAPSHOT DUMP (profile " + profileId + ") ----\n" + snapshot + "\n---- END SNAPSHOT DUMP ----");
  }

  return snapshot;
}

// ── ENGINE v2 — Coach Chat snapshot section (flagged profiles only) ─────────
// Gives Coach Chat visibility into the v2 plan, dossier, tiers, progression and
// recency. Compact by construction — the progression table is rendered with a
// smaller signal cap here than the planner uses (it shares a prompt with thread
// history), and its size is reported.
async function buildV2ChatSnapshotSection(profileId, profile, today) {
  // Profile-side v2 columns (dossier + cache) via a targeted read, tolerant of
  // an unrun v2 migration (PostgREST returns an error object → skip the section).
  var vr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId +
    "&select=dossier,v2_daily_cache,v2_daily_cache_date", { headers: sbHeaders() });
  var vrows = await vr.json();
  if (!Array.isArray(vrows) || !vrows.length) return "";
  var vrow = vrows[0];
  var pd = profile.profile_data || {};

  var L = ["ENGINE v2 STATE (this athlete is on the v2 planning engine):"];

  // Goal tiers.
  var goals = Array.isArray(pd.goals) ? pd.goals : [];
  var tierBits = goals.filter(function (g) { return g && g.tier; }).map(function (g) { return g.title + " [" + g.tier + "]"; });
  if (tierBits.length) L.push("GOAL TIERS: " + tierBits.join("; "));

  // Today's autoregulated session from the cache.
  var cacheFresh = vrow.v2_daily_cache_date === today;
  var cache = cacheFresh ? vrow.v2_daily_cache : null;
  if (cache && cache.today) {
    var t = cache.today;
    var tag = cache.decision_tag && cache.decision_tag !== "kept" ? " [ADJUSTED: " + cache.decision_tag + "]" : " [as planned]";
    L.push("TODAY'S SESSION" + tag + ": " + (t.headline || t.category) + " — " + (t.duration_min || "?") + " min, " + (t.intensity || "?") + " intensity.");
    if (cache.why) L.push("  why: " + cache.why);
  } else {
    L.push("TODAY'S SESSION: not generated yet for " + today + ".");
  }

  // The planned week (active block).
  try {
    var br = await fetch(SUPABASE_URL + "/rest/v1/training_blocks?profile_id=eq." + profileId +
      "&status=eq.active&order=start_date.desc&limit=1&select=id,block", { headers: sbHeaders() });
    var brows = await br.json();
    var block = Array.isArray(brows) && brows.length ? brows[0] : null;
    if (block) {
      if (block.block && block.block.focus) L.push("BLOCK FOCUS: " + block.block.focus);
      var sr = await fetch(SUPABASE_URL + "/rest/v1/planned_sessions?profile_id=eq." + profileId +
        "&block_id=eq." + block.id + "&order=date.asc,slot.asc&select=id,date,slot,status,movable,session", { headers: sbHeaders() });
      var srows = await sr.json();
      if (Array.isArray(srows) && srows.length) {
        var wk = srows.map(function (s) {
          var sess = s.session || {};
          return "  " + s.date + " [id " + s.id + "]" + (s.movable === false ? " (FIXED, immovable)" : "") + ": " +
            (sess.category || "?") + " " + (sess.duration_min || "?") + "min " + (sess.intensity || "") + " · " + (s.status || "planned");
        });
        L.push("THIS WEEK'S PLANNED SESSIONS (each carries an [id N] — use it when proposing a change; a session marked FIXED is an immovable commitment and cannot be changed):\n" + wk.join("\n"));
      }
    }
  } catch (e) { /* non-fatal */ }

  // Dossier (nightly-built, stored). Rendered via the same helper the prompts use.
  if (vrow.dossier) {
    L.push(v2Dossier.renderDossierForPrompt(vrow.dossier));
  }

  // Progression + recency — computed fresh (small windows). Progression table
  // is capped tighter here (shares the chat budget with thread history).
  var deps = { fetch: fetch, SUPABASE_URL: SUPABASE_URL, sbHeaders: sbHeaders, localToday: localToday };
  try {
    var recency = await v2Progression.buildRecencyState(deps, profileId, { today: today });
    var recencyText = v2Progression.renderRecencyBlock(recency);
    if (recencyText) L.push(recencyText);
  } catch (e) { /* non-fatal */ }
  try {
    var progression = await v2Progression.buildProgressionState(deps, profileId, { today: today });
    var progText = v2Progression.renderProgressionTable(progression, { maxSignal: 10, includeTail: true });
    if (progText) L.push(progText);
  } catch (e) { /* non-fatal */ }

  L.push("SOURCING RULE (v2): every training figure above is real and computed. State no training-history number that is not present in this snapshot.");
  L.push("GOAL-TAG CAVEAT: a session's goal_tags can under-report which goals its exercises serve. When the athlete asks what they did for a goal, reason from the actual EXERCISES in the plan, not the tags alone — do not claim a goal was untrained if exercises that clearly serve it are present.");

  return L.join("\n");
}

function buildChatSystemPrompt(snapshot, summary, isV2) {
  // The v2 addendum is appended to the persona (the STABLE, cache-friendly part)
  // rather than the snapshot, so a v2 profile's cached system prefix stays
  // stable across messages. A v1 profile passes isV2 falsy → byte-identical.
  var persona = isV2 ? (CHAT_SYSTEM_PERSONA + CHAT_PERSONA_V2_ADDENDUM) : CHAT_SYSTEM_PERSONA;
  var sys = persona + "\n\nATHLETE SNAPSHOT:\n" + snapshot;
  if (summary) sys += "\n\nEARLIER IN THIS CONVERSATION (summarized):\n" + summary;
  return sys;
}

// Enforces CHAT_CHAR_GUARD by dropping the OLDEST messages first — snapshot
// (system) is never trimmed here (it's capped independently during
// construction); this only trims thread history, and always keeps at least
// the newest (just-sent) message. Drops complete user+assistant turn-pairs
// together so the Anthropic Messages API's strict alternation stays valid.
function enforceChatCharGuard(systemText, messages, limit) {
  limit = limit || CHAT_CHAR_GUARD;
  var msgs = messages.slice();
  var totalLen = function() { return systemText.length + JSON.stringify(msgs).length; };
  while (totalLen() > limit && msgs.length > 1) {
    if (msgs.length > 2 && msgs[0].role === "user" && msgs[1] && msgs[1].role === "assistant") {
      msgs.splice(0, 2);
    } else {
      msgs.splice(0, 1);
    }
  }
  return { system: systemText, messages: msgs, trimmed: msgs.length < messages.length };
}

// ── Chat thread/message persistence (Supabase: chat_threads, chat_messages) ─
// One thread per profile (UNIQUE profile_id) — see the migration SQL
// delivered separately. Full message history is kept in chat_messages
// forever; summarization (below) only changes what's SENT to the model on
// future calls (summary_through_message_id), it never deletes rows.

async function getChatThread(profileId) {
  var r = await fetch(SUPABASE_URL + "/rest/v1/chat_threads?profile_id=eq." + profileId +
    "&select=id,summary,summary_through_message_id&limit=1", { headers: sbHeaders() });
  var rows = await r.json();
  return (Array.isArray(rows) && rows.length) ? rows[0] : null;
}

async function getOrCreateChatThread(profileId) {
  var existing = await getChatThread(profileId);
  if (existing) return existing;
  var cr = await fetch(SUPABASE_URL + "/rest/v1/chat_threads", {
    method: "POST",
    headers: sbHeaders("return=representation"),
    body: JSON.stringify({ profile_id: Number(profileId) }),
  });
  var created = await cr.json();
  return Array.isArray(created) ? created[0] : created;
}

async function insertChatMessage(threadId, role, content) {
  var r = await fetch(SUPABASE_URL + "/rest/v1/chat_messages", {
    method: "POST",
    headers: sbHeaders("return=representation"),
    body: JSON.stringify({ thread_id: threadId, role: role, content: content }),
  });
  var rows = await r.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function fetchChatMessagesAfter(threadId, afterId) {
  var q = SUPABASE_URL + "/rest/v1/chat_messages?thread_id=eq." + threadId +
    (afterId ? "&id=gt." + afterId : "") +
    "&select=id,role,content,created_at&order=id.asc&limit=200";
  var r = await fetch(q, { headers: sbHeaders() });
  var rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

async function fetchAllChatMessages(threadId) {
  var r = await fetch(SUPABASE_URL + "/rest/v1/chat_messages?thread_id=eq." + threadId +
    "&select=id,role,content,created_at&order=id.asc&limit=500", { headers: sbHeaders() });
  var rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

// Fire-and-forget, called after a response finishes streaming (never awaited
// by the request that triggered it — matches maybeAdaptAllRoadmaps()'s
// pattern). Folds everything older than the most recent CHAT_SUMMARIZE_KEEP_TAIL
// messages into chat_threads.summary via Haiku, then advances
// summary_through_message_id. If a send races ahead of this finishing, the
// char guard's oldest-first trim in enforceChatCharGuard() is the stopgap —
// no send ever blocks on summarization.
async function summarizeChatThreadIfNeeded(threadId) {
  // getChatThread() looks up by profile_id, so fetch by thread id directly here.
  var tr = await fetch(SUPABASE_URL + "/rest/v1/chat_threads?id=eq." + threadId +
    "&select=id,summary,summary_through_message_id", { headers: sbHeaders() });
  var trows = await tr.json();
  if (!Array.isArray(trows) || !trows.length) return;
  var thread = trows[0];

  var pending = await fetchChatMessagesAfter(threadId, thread.summary_through_message_id);
  if (pending.length <= CHAT_SUMMARIZE_TRIGGER) return;

  var toFold = pending.slice(0, pending.length - CHAT_SUMMARIZE_KEEP_TAIL);
  if (!toFold.length) return;
  var newCutoffId = toFold[toFold.length - 1].id;

  var transcript = toFold.map(function(m) { return (m.role === "user" ? "Athlete" : "Coach") + ": " + m.content; }).join("\n");
  var sys = "Summarize this segment of an ongoing coaching chat in under 150 words. Preserve concrete facts: numbers, decisions, and commitments, and anything the athlete asked to be remembered. Write it as a compact reference note for the coach, not a message to the athlete.";
  var userMsg = (thread.summary ? "EXISTING SUMMARY (fold this in, don't just append):\n" + thread.summary + "\n\n" : "") +
    "NEW MESSAGES TO SUMMARIZE:\n" + transcript;

  var newSummary;
  try {
    newSummary = await callAISystem(sys, userMsg, 400, MODEL_HAIKU);
  } catch (e) {
    console.error("[Chat] summarize call failed:", e && e.message);
    return;
  }
  if (!newSummary || !newSummary.trim()) return;

  await fetch(SUPABASE_URL + "/rest/v1/chat_threads?id=eq." + threadId, {
    method: "PATCH",
    headers: sbHeaders("return=minimal"),
    body: JSON.stringify({ summary: newSummary.trim(), summary_through_message_id: newCutoffId, updated_at: new Date().toISOString() }),
  });
  console.log("[Chat] summarized thread " + threadId + " through message " + newCutoffId + " (" + toFold.length + " messages folded)");
}

// ── COACH CHAT TOOL-USE: proposal compute + apply ────────────────────────
// v1 write scope, deliberately narrow (see COACH_CHAT_TOOLS above): update an
// EXISTING goal, set/clear the standing Focus Override, log a free-text
// check-in note. A tool call NEVER writes real data directly — the compute*
// functions below only READ current state and describe the proposed change
// (before/after "changes" list); createChatProposal() persists that as a
// PENDING row; applyProposal() (called only from POST
// .../chat/proposals/:id/confirm, after the athlete explicitly confirms)
// performs the actual write, reusing the same helpers the rest of the app
// already uses for these fields — loadProfileWithGoals/findGoalById/
// saveGoalToProfile (the exact helpers the Living Goal Roadmap endpoints
// use) for goals, saveProfileDataField for focus_override (mirroring the
// client's own foSave()/foPersist() shape), and a fetch-then-merge upsert for
// daily_checkins so a note never wipes out today's energy/soreness/severity
// logged from the app's own check-in form.

// Reads the goal, returns { goal_id, title, changes:[{field,label,before,after}], reason }.
// Only fields present in `input` and actually different from the current
// value produce a change entry. Throws (404-tagged) if the goal id is wrong —
// caught by executeProposalTool() and turned into a plain tool_result, not a
// crash.
async function computeGoalUpdateProposal(profileId, input) {
  var loaded = await loadProfileWithGoals(profileId);
  var found = findGoalById(loaded.profileData, input.goal_id);
  var g = found.goal;
  var changes = [];
  if (input.target_value !== undefined && input.target_value !== g.target_value) {
    changes.push({ field: "target_value", label: "target", before: g.target_value != null ? g.target_value : null, after: input.target_value });
  }
  if (input.unit !== undefined && input.unit !== g.unit) {
    changes.push({ field: "unit", label: "unit", before: g.unit || null, after: input.unit });
  }
  if (input.target_date !== undefined && input.target_date !== g.target_date) {
    changes.push({ field: "target_date", label: "target date", before: g.target_date || null, after: input.target_date });
  }
  if (input.notes !== undefined && input.notes !== g.description) {
    changes.push({ field: "description", label: "notes", before: g.description || null, after: input.notes });
  }
  if (input.active !== undefined) {
    var newStatus = input.active ? "IN PROGRESS" : "PAUSED";
    if (newStatus !== (g.status || "IN PROGRESS")) {
      changes.push({ field: "status", label: "status", before: g.status || "IN PROGRESS", after: newStatus });
    }
  }
  return { goal_id: g.id, title: g.title || "Untitled goal", changes: changes, reason: input.reason || "" };
}

async function computeFocusOverrideProposal(profileId, input) {
  var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId + "&select=profile_data,timezone", { headers: sbHeaders() });
  var rows = await pr.json();
  var profileRow = (Array.isArray(rows) && rows[0]) || {};
  var pd = profileRow.profile_data || {};
  var existing = pd.focus_override || null;

  if (input.action === "clear") {
    if (!existing || !existing.active) {
      var noop = new Error("No active Focus Override to clear.");
      noop.noop = true;
      throw noop;
    }
    return {
      title: "Focus Override",
      changes: [{ field: "active", label: "active", before: true, after: false }],
      reason: input.reason || "",
      _fo: Object.assign({}, existing, { active: false, daily_override_state: null }),
    };
  }

  // action === "set"
  var next = {
    active: true,
    text: input.text !== undefined ? input.text : (existing && existing.text) || "",
    mode: input.mode || (existing && existing.mode) || "infuse",
    scope: (existing && existing.scope) || "all",
    start_date: input.start_date || (existing && existing.start_date) || localToday(profileRow),
    end_date: input.end_date || (existing && existing.end_date) || localToday(profileRow, 90),
    daily_override_state: null,
  };
  var changes = [];
  if (!existing || !existing.active) {
    changes.push({ field: "active", label: "standing directive", before: "off", after: next.text + " (" + next.mode + ")" });
  } else {
    ["text", "mode", "start_date", "end_date"].forEach(function(f) {
      if (next[f] !== existing[f]) changes.push({ field: f, label: f.replace("_", " "), before: existing[f] || null, after: next[f] });
    });
  }
  return { title: "Focus Override", changes: changes, reason: input.reason || "", _fo: next };
}

// Read-only like the others above: validates the goal exists and actually
// has a roadmap to regenerate (defensive backstop — CHAT_SYSTEM_PERSONA +
// the has-roadmap marker in formatGoalLineForChat() should already keep the
// model from calling this on a roadmap-less goal, but a noop here matches
// computeFocusOverrideProposal's "clear when nothing active" pattern rather
// than silently creating a confusing proposal). Does NOT call Sonnet itself —
// the actual regeneration only happens in applyProposal(), after confirm.
async function computeRoadmapRegenProposal(profileId, input) {
  var loaded = await loadProfileWithGoals(profileId);
  var found = findGoalById(loaded.profileData, input.goal_id);
  var g = found.goal;
  if (!g.roadmap) {
    var noop = new Error("\"" + (g.title || "This goal") + "\" doesn't have a roadmap yet — nothing to regenerate.");
    noop.noop = true;
    throw noop;
  }
  return {
    goal_id: g.id,
    title: "Regenerate roadmap for \"" + (g.title || "Untitled goal") + "\"",
    changes: [{
      field: "roadmap",
      label: "roadmap",
      before: "v" + (g.roadmap.version || 1) + " (generated " + (g.roadmap.generated_at ? g.roadmap.generated_at.slice(0, 10) : "unknown") + ")",
      after: "newly generated from your updated goal",
    }],
    reason: input.reason || "",
  };
}

async function computeCheckinNoteProposal(profileId, input) {
  // Athlete's timezone (2026-07-15) — was dateStr(0) (UTC). Stored on the
  // returned payload as _today so applyProposal() (called later, at confirm
  // time) writes the SAME date key this function read, rather than
  // recomputing localToday() a second time — strictly more correct in the
  // (extremely unlikely) case a confirm lands right at a midnight boundary.
  var profileRow = await getProfileTimezone(profileId).catch(function() { return {}; });
  var today = localToday(profileRow);
  var cr = await fetch(SUPABASE_URL + "/rest/v1/daily_checkins?profile_id=eq." + profileId + "&date=eq." + today + "&limit=1", { headers: sbHeaders() });
  var rows = await cr.json();
  var existingRow = (Array.isArray(rows) && rows[0]) || null;
  var existingText = (existingRow && existingRow.checkin_text) || "";
  var note = (input.note || "").trim();
  var mergedText = existingText ? (existingText + "\n" + note) : note;
  return {
    title: "Today's check-in note",
    changes: [{ field: "checkin_text", label: "note", before: existingText || null, after: mergedText }],
    reason: "",
    _existingRow: existingRow,
    _mergedText: mergedText,
    _today: today,
  };
}

// Persists a pending proposal row. message_id is nullable and filled in
// later — see backfillProposalMessageIds() — because the assistant's
// chat_messages row (which this proposal is attached to for display) isn't
// saved until after the whole stream finishes, but the proposal itself is
// created mid-stream, as soon as the tool call happens.
// ── ENGINE v2 — session/preference proposal computation (READ-ONLY) ─────────
// Every guard here fires at PROPOSAL time, in code, before a card is ever
// created — so a disallowed change can't even become a pending proposal, let
// alone be applied. A guard failure throws {noop:true} so executeProposalTool
// returns a plain refusal to the model instead of creating a proposal.

function _chatNoop(msg) { var e = new Error(msg); e.noop = true; return e; }

// Load a planned session and enforce the shared hard rules (future-only,
// not-an-anchor). Returns { row, sessionData, dossier }.
async function _loadPlannedSessionForProposal(profileId, sessionId, today) {
  var sr = await fetch(SUPABASE_URL + "/rest/v1/planned_sessions?id=eq." + encodeURIComponent(sessionId) +
    "&profile_id=eq." + profileId + "&select=id,date,slot,status,movable,session,block_id", { headers: sbHeaders() });
  var rows = await sr.json();
  var row = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!row) throw _chatNoop("I couldn't find that planned session — it may have already changed. Ask them to reopen the plan.");
  // FUTURE-ONLY. Today's session is owned by the ephemeral variant surface + the
  // autoregulator; letting chat write today's planned_sessions row would desync
  // it from today's cache. Past sessions are history.
  if (row.date <= today) {
    throw _chatNoop(row.date === today
      ? "That's today's session — I can't change the plan for today. Tell the athlete to use the variation buttons on the Today card, which show an alternative without altering their plan."
      : "That session is in the past and can't be changed.");
  }
  // ANCHOR — immovable, same rule the planner and autoregulator obey.
  if (row.movable === false) {
    throw _chatNoop("That's a fixed commitment (an anchored session) — it can't be modified. Offer to adjust the work around it on another day instead.");
  }
  // Load the dossier for the injury check.
  var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId + "&select=dossier", { headers: sbHeaders() });
  var prows = await pr.json();
  var dossier = (Array.isArray(prows) && prows[0] && prows[0].dossier) || null;
  return { row: row, sessionData: row.session || {}, dossier: dossier };
}

// Apply the requested edits to a copy of the session and return the modified
// session. Pure — does not write.
function _applySessionEdits(sessionData, input) {
  var s = JSON.parse(JSON.stringify(sessionData));
  var changes = [];
  if (input.new_category && String(input.new_category) !== String(s.category)) {
    changes.push({ field: "category", label: "category", before: s.category, after: input.new_category });
    s.category = input.new_category;
  }
  if (input.new_intensity && String(input.new_intensity) !== String(s.intensity)) {
    changes.push({ field: "intensity", label: "intensity", before: s.intensity, after: input.new_intensity });
    s.intensity = input.new_intensity;
  }
  if (input.new_duration_min && Number(input.new_duration_min) !== Number(s.duration_min)) {
    var target = Number(input.new_duration_min);
    changes.push({ field: "duration_min", label: "duration", before: s.duration_min, after: target });
    // A duration change must ACTUALLY reshape the segments — setting only the
    // top-level duration_min leaves the segments summing to the old length, and
    // the time-budget invariant then correctly reverts it on apply (found live
    // in the Phase 7 demo). A REDUCTION runs the rules module's time-compression
    // order (protects the primary compound + prehab); an increase just sets the
    // number (adding volume is a judgment the code won't fabricate — the segment
    // sum then drives duration_min via the invariant, so an "increase" is a
    // no-op on segments, which the invariant will flag/normalise honestly).
    if (target < Number(s.duration_min)) {
      var comp = v2Autoregulator.compressSessionToDuration(s, target);
      s = comp.session;
      s.duration_min = comp.session.duration_min;   // the real compressed length (~target)
    } else {
      s.duration_min = target;
    }
  }
  if (Array.isArray(input.exercise_swaps) && input.exercise_swaps.length) {
    input.exercise_swaps.forEach(function (sw) {
      if (!sw || !sw.from || !sw.to) return;
      var swapped = false;
      (s.segments || []).forEach(function (seg) {
        (seg.exercises || []).forEach(function (ex) {
          if (ex && ex.name && ex.name.toLowerCase() === String(sw.from).toLowerCase()) { ex.name = sw.to; swapped = true; }
        });
      });
      if (swapped) changes.push({ field: "exercise", label: "exercise swap", before: sw.from, after: sw.to });
    });
  }
  return { session: s, changes: changes };
}

async function computeSessionChangeProposal(profileId, input, today) {
  var loaded = await _loadPlannedSessionForProposal(profileId, input.session_id, today);
  var edited = _applySessionEdits(loaded.sessionData, input);
  if (!edited.changes.length) {
    throw _chatNoop("That change matches what's already planned for that day — nothing to confirm.");
  }
  // INJURY CHECK — refuse a change that introduces contraindicated work.
  var ci = v2Variant.contraindications(edited.session, loaded.dossier);
  if (ci.length) {
    throw _chatNoop("I can't propose that — it would add " + ci[0].exercise + ", which conflicts with the athlete's " +
      ci[0].injury_area + ". Tell them plainly and suggest a safer alternative.");
  }
  return {
    title: input.change_summary || "session change",
    changes: edited.changes,
    reason: input.reason || "",
    _session_id: loaded.row.id,
    _date: loaded.row.date,
    _new_session: edited.session,   // the fully-edited session to write on confirm
  };
}

async function computeSkipSessionProposal(profileId, input, today) {
  var loaded = await _loadPlannedSessionForProposal(profileId, input.session_id, today);
  var action = input.action === "reschedule" ? "reschedule" : "skip";
  var changes;
  if (action === "reschedule") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.new_date || ""))) throw _chatNoop("A reschedule needs a valid new date.");
    if (String(input.new_date) <= today) throw _chatNoop("The new date has to be in the future.");
    changes = [{ field: "date", label: "move to", before: loaded.row.date, after: input.new_date }];
  } else {
    changes = [{ field: "status", label: "status", before: loaded.row.status || "planned", after: "skipped" }];
  }
  return {
    title: (loaded.sessionData.category || "session") + " on " + loaded.row.date,
    changes: changes, reason: input.reason || "",
    _session_id: loaded.row.id, _action: action, _new_date: input.new_date || null,
  };
}

async function computeStandingPreferenceProposal(profileId, input) {
  var pref = (input.preference || "").trim();
  if (!pref) throw _chatNoop("There's no preference text to record.");
  return {
    title: "standing preference",
    changes: [{ field: "preference", label: "remember", before: null, after: pref }],
    reason: input.reason || pref,
    _preference: pref,
  };
}

async function createChatProposal(threadId, toolUseId, type, payload) {
  var r = await fetch(SUPABASE_URL + "/rest/v1/chat_proposals", {
    method: "POST",
    headers: sbHeaders("return=representation"),
    body: JSON.stringify({ thread_id: threadId, tool_use_id: toolUseId, type: type, payload: payload, status: "pending" }),
  });
  var rows = await r.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function backfillProposalMessageIds(proposalIds, messageId) {
  if (!proposalIds.length) return;
  await fetch(SUPABASE_URL + "/rest/v1/chat_proposals?id=in.(" + proposalIds.join(",") + ")", {
    method: "PATCH",
    headers: sbHeaders("return=minimal"),
    body: JSON.stringify({ message_id: messageId }),
  });
}

// Dispatches one tool_use block: computes the proposed change (read-only),
// creates a pending chat_proposals row, and returns the tool_result content
// the model needs to finish its turn gracefully. NEVER writes real data.
async function executeProposalTool(toolUse, profileId, threadId, _chatToday) {
  var input = toolUse.input || {};
  try {
    var proposal, type;
    if (toolUse.name === "propose_goal_update") {
      type = "update_goal";
      proposal = await computeGoalUpdateProposal(profileId, input);
    } else if (toolUse.name === "propose_focus_override") {
      type = "set_focus_override";
      proposal = await computeFocusOverrideProposal(profileId, input);
    } else if (toolUse.name === "propose_checkin_note") {
      type = "log_checkin_note";
      proposal = await computeCheckinNoteProposal(profileId, input);
    } else if (toolUse.name === "propose_session_change") {
      type = "modify_planned_session";
      proposal = await computeSessionChangeProposal(profileId, input, _chatToday);
    } else if (toolUse.name === "propose_skip_session") {
      type = "skip_planned_session";
      proposal = await computeSkipSessionProposal(profileId, input, _chatToday);
    } else if (toolUse.name === "propose_standing_preference") {
      type = "set_standing_preference";
      proposal = await computeStandingPreferenceProposal(profileId, input);
    } else {
      return { resultContent: "Unknown tool '" + toolUse.name + "' — not available.", proposalId: null };
    }

    if (!proposal.changes.length) {
      return { resultContent: "No actual change detected (the proposed values match what's already set) — nothing to confirm.", proposalId: null };
    }

    var row = await createChatProposal(threadId, toolUse.id, type, proposal);
    var changeSummary = proposal.changes.map(function(c) {
      return c.label + ": " + (c.before == null ? "(none)" : c.before) + " -> " + c.after;
    }).join("; ");
    return {
      resultContent: "Proposal #" + row.id + " created (" + changeSummary + "). This is PENDING — the athlete will see a confirm/cancel card and must confirm before it's applied. Do not say it's been done.",
      proposalId: row.id,
    };
  } catch (e) {
    if (e.noop) {
      return { resultContent: e.message, proposalId: null };
    }
    console.error("[Chat] executeProposalTool failed for " + toolUse.name + ":", e && e.message);
    return { resultContent: "Couldn't prepare that change: " + (e.message || "unknown error") + ". Tell the athlete plainly and suggest they try again or use the app directly.", proposalId: null };
  }
}

// Applies a CONFIRMED proposal — the only place in this whole tool-use
// feature that writes real data. Called only from
// POST .../chat/proposals/:id/confirm, after the athlete has explicitly
// confirmed via the in-thread card. Returns { autoOfferGoal } — set only for
// a confirmed "update_goal" whose goal already has a roadmap, so the confirm
// handler can auto-create the roadmap-regen offer (see that handler for why
// this is server-triggered rather than model-tool-call-triggered).
async function applyProposal(proposal, profileId) {
  var payload = proposal.payload;
  var autoOfferGoal = null;
  if (proposal.type === "update_goal") {
    var loaded = await loadProfileWithGoals(profileId);
    var found = findGoalById(loaded.profileData, payload.goal_id);
    var g = found.goal;
    payload.changes.forEach(function(c) { g[c.field] = c.after; });
    await saveGoalToProfile(profileId, loaded.profileData, found.index, g);
    if (g.roadmap) autoOfferGoal = g;
  } else if (proposal.type === "set_focus_override") {
    var loaded2 = await loadProfileWithGoals(profileId); // full profile_data load, any key
    await saveProfileDataField(profileId, loaded2.profileData, "focus_override", payload._fo);
  } else if (proposal.type === "log_checkin_note") {
    // Reuse the SAME date computeCheckinNoteProposal resolved (not a fresh
    // dateStr(0)/localToday() call) — see that function's comment.
    var checkinPayload = {
      profile_id: profileId,
      date: payload._today,
      energy: (payload._existingRow && payload._existingRow.energy) || null,
      soreness: (payload._existingRow && payload._existingRow.soreness) || [],
      severity: (payload._existingRow && payload._existingRow.severity) || null,
      checkin_text: payload._mergedText,
    };
    await fetch(SUPABASE_URL + "/rest/v1/daily_checkins?on_conflict=profile_id,date", {
      method: "POST",
      headers: sbHeaders("return=minimal,resolution=merge-duplicates"),
      body: JSON.stringify(checkinPayload),
    });
  } else if (proposal.type === "modify_planned_session") {
    // Re-verify the hard rules AT APPLY TIME against fresh data — the row could
    // have changed between proposal and confirm (become an anchor, moved to
    // today, etc.). Reject rather than write if anything shifted.
    var pTz = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId + "&select=timezone,dossier", { headers: sbHeaders() });
    var pRows = await pTz.json();
    var pRow = (Array.isArray(pRows) && pRows[0]) || {};
    var todayApply = localToday(pRow);
    var freshSr = await fetch(SUPABASE_URL + "/rest/v1/planned_sessions?id=eq." + payload._session_id +
      "&profile_id=eq." + profileId + "&select=id,date,movable,status", { headers: sbHeaders() });
    var freshRows = await freshSr.json();
    var fresh = Array.isArray(freshRows) && freshRows.length ? freshRows[0] : null;
    if (!fresh) throw new Error("That planned session no longer exists.");
    if (fresh.date <= todayApply) throw new Error("That session is now today or in the past and can no longer be changed here.");
    if (fresh.movable === false) throw new Error("That session is now a fixed commitment and can't be changed.");
    var newSession = payload._new_session;
    // INVARIANT SET (Phase 3.5) on the confirmed session, plus the injury check.
    // A confirmed change that would violate an invariant is caught BEFORE the write.
    var enforced = v2Planner.enforceInvariants(
      { sessions: [{ date: fresh.date, slot: 1, movable: true, category: newSession.category, duration_min: newSession.duration_min, intensity: newSession.intensity, why: newSession.why || "Adjusted via Coach Chat.", goal_tags: newSession.goal_tags, segments: newSession.segments }], block: {} },
      { profileId: Number(profileId), weekDates: [{ date: fresh.date }], tiers: { goals: [] }, schedule: { fill_policy: "ai_assigned" }, anchors: [] }
    );
    var rejected = enforced.violations.filter(function (v) { return v.severity === "rejected"; });
    if (rejected.length) throw new Error("The change would break a plan rule (" + rejected[0].invariant + ") — not applied.");
    var ci2 = v2Variant.contraindications(newSession, pRow.dossier);
    if (ci2.length) throw new Error("The change would add " + ci2[0].exercise + ", contraindicated by " + ci2[0].injury_area + " — not applied.");
    var cleaned = enforced.sessions[0];
    var writeSession = Object.assign({}, newSession, { category: cleaned.category, duration_min: cleaned.duration_min, intensity: cleaned.intensity, why: cleaned.why, segments: cleaned.segments });
    await fetch(SUPABASE_URL + "/rest/v1/planned_sessions?id=eq." + payload._session_id, {
      method: "PATCH", headers: sbHeaders("return=minimal"),
      body: JSON.stringify({ session: writeSession, status: "modified", updated_at: new Date().toISOString() }),
    });
  } else if (proposal.type === "skip_planned_session") {
    var body = payload._action === "reschedule"
      ? { date: payload._new_date, status: "planned", updated_at: new Date().toISOString() }
      : { status: "skipped", updated_at: new Date().toISOString() };
    await fetch(SUPABASE_URL + "/rest/v1/planned_sessions?id=eq." + payload._session_id +
      "&profile_id=eq." + profileId, {
      method: "PATCH", headers: sbHeaders("return=minimal"), body: JSON.stringify(body),
    });
  } else if (proposal.type === "set_standing_preference") {
    // Stored in profile_data.v2_preferences[]; the dossier builder folds these
    // into refusals_preferences on its next nightly run (closing the Phase 2
    // deferred item — see v2Dossier.buildDossier).
    var loadedP = await loadProfileWithGoals(profileId);
    var prefs = Array.isArray(loadedP.profileData.v2_preferences) ? loadedP.profileData.v2_preferences.slice() : [];
    prefs.push({ text: payload._preference, added: new Date().toISOString() });
    await saveProfileDataField(profileId, loadedP.profileData, "v2_preferences", prefs);
  } else if (proposal.type === "regenerate_goal_roadmap") {
    // Unlike every other proposal type, this is a live Sonnet call — slow
    // (a few seconds) and can genuinely fail (Anthropic error, invalid JSON,
    // etc.). If it throws, the caller (POST .../confirm) returns a 500 and
    // leaves the proposal status "pending" (the PATCH to "confirmed" below
    // it never runs) — so a retry is just the athlete confirming the same
    // card again, not a parallel flow. mode:"regenerate" reuses the full
    // generation path but increments version/appends adaptation_log instead
    // of resetting them, since this goal already had roadmap history.
    await generateGoalRoadmapForGoal(profileId, payload.goal_id, "regenerate");
  }
  return { autoOfferGoal: autoOfferGoal };
}

// POST a chat message — streams the reply (see pipeAnthropicStream above) and
// persists both sides of the turn. The athlete snapshot is rebuilt fresh on
// every call (see buildChatSnapshot) rather than cached, so it's never stale
// mid-conversation; the resulting system prompt is still cache_control-
// wrapped (via wrapSystemWithCache), so repeat calls within the TTL window
// still hit Anthropic's prompt cache as long as the snapshot text is
// unchanged between them.
//
// DEBUG: pass ?debug=1 to inspect exactly what the model would see — returns
// the assembled system prompt + message array (+ char counts) as JSON instead
// of calling Anthropic. No message is persisted and no API call is made, so
// it's free to use repeatedly. Also triggers a full snapshot dump to the
// server console (buildChatSnapshot's opts.debug) for log-based inspection
// when you don't have easy access to the JSON response. This is a permanent
// capability, not a one-off — snapshot-completeness bugs are expected to
// recur as new context sources get added.
app.post("/api/profiles/:id/chat/message", async function(req, res) {
  var profileId = req.params.id;
  var debug = req.query && req.query.debug === "1";
  var text = ((req.body && req.body.text) || "").trim();
  if (!text) return res.status(400).json({ error: { message: "text is required" } });
  if (text.length > 4000) return res.status(400).json({ error: { message: "Message too long (max 4000 characters)" } });

  try {
    var thread = await getOrCreateChatThread(profileId);
    var history = await fetchChatMessagesAfter(thread.id, thread.summary_through_message_id);

    // ENGINE v2 flag for this profile — decides the tool set, the persona
    // addendum, and whether the snapshot carries the v2 section. A v1 profile
    // resolves isV2Chat=false and every branch below is byte-identical to before.
    var chatProfileRow = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + profileId + "&select=profile_data,timezone", { headers: sbHeaders() }).then(function(r){return r.json();}).catch(function(){return [];});
    var chatPd = (Array.isArray(chatProfileRow) && chatProfileRow[0] && chatProfileRow[0].profile_data) || {};
    var isV2Chat = chatPd.engine_v2 === true;
    var chatToday = localToday((Array.isArray(chatProfileRow) && chatProfileRow[0]) || {});

    var snapshot = await buildChatSnapshot(profileId, { debug: debug });
    var systemText = buildChatSystemPrompt(snapshot, thread.summary, isV2Chat);

    var messages = history.map(function(m) { return { role: m.role, content: m.content }; });
    messages.push({ role: "user", content: text });

    var guarded = enforceChatCharGuard(systemText, messages, CHAT_CHAR_GUARD);
    var system = wrapSystemWithCache(guarded.system, "coach_chat");

    if (debug) {
      // Return the ACTUAL wrapped structure (post cache_control), not the
      // pre-wrap string — this must be exactly what gets sent to Anthropic,
      // or the debug endpoint is useless for diagnosing caching issues like
      // the 2026-07-15 cache_write=0 bug this endpoint helped confirm.
      var systemCharsRaw = guarded.system.length; // for the ~1024-token cache-minimum estimate
      return res.json({
        debug: true,
        snapshot: snapshot,
        snapshot_chars: snapshot.length,
        system: system,
        system_chars_raw: systemCharsRaw,
        system_est_tokens: Math.round(systemCharsRaw / 4),
        cache_control_present: Array.isArray(system) && system.some(function(b) { return b && b.cache_control; }),
        messages: guarded.messages,
        messages_chars: JSON.stringify(guarded.messages).length,
        combined_chars: systemCharsRaw + JSON.stringify(guarded.messages).length,
        char_guard: CHAT_CHAR_GUARD,
        trimmed_history: guarded.trimmed,
      });
    }

    await insertChatMessage(thread.id, "user", text);

    var model = modelForCallType("coach_chat");
    var anthropicHeaders = {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    };
    var postToAnthropic = function(msgs, signal) {
      return fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: anthropicHeaders,
        body: JSON.stringify({ model: model, max_tokens: 1500, stream: true, system: system, messages: msgs, tools: buildCoachChatTools(isV2Chat) }),
        signal: signal,
        agent: anthropicStreamAgent,
      });
    };

    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, 25000);
    var upstream = await postToAnthropic(guarded.messages, controller.signal);
    clearTimeout(timeoutId);

    if (!upstream.ok) {
      var errData = await upstream.json().catch(function() {
        return { error: { message: "Anthropic error " + upstream.status } };
      });
      console.error("[Chat] upstream error status=" + upstream.status);
      return res.status(upstream.status).json(errData);
    }

    // Running message history for this call — grows as tool legs happen.
    // Each leg that calls a tool appends the assistant's own turn (its text +
    // tool_use blocks, reconstructed from what pumpAnthropicLeg captured —
    // this must accurately reflect what was actually generated, since
    // Anthropic requires the tool_result turn to follow the exact tool_use
    // turn it responds to) followed by our tool_result turn, before the next
    // leg is fetched.
    var runningMessages = guarded.messages.slice();
    var proposalIdsThisCall = [];

    var result = await pipeAnthropicToolStream(upstream, controller, res, "coach_chat", {
      onToolUse: async function(toolUses) {
        var toolResultBlocks = [];
        for (var i = 0; i < toolUses.length; i++) {
          var outcome = await executeProposalTool(toolUses[i], profileId, thread.id, chatToday);
          if (outcome.proposalId) proposalIdsThisCall.push(outcome.proposalId);
          toolResultBlocks.push({ type: "tool_result", tool_use_id: toolUses[i].id, content: outcome.resultContent });
        }
        return { toolResultBlocks: toolResultBlocks };
      },
      fetchNextLeg: async function(leg, toolResultBlocks) {
        var assistantContent = [];
        if (leg.legText) assistantContent.push({ type: "text", text: leg.legText });
        leg.toolUses.forEach(function(t) {
          assistantContent.push({ type: "tool_use", id: t.id, name: t.name, input: t.input || {} });
        });
        runningMessages.push({ role: "assistant", content: assistantContent });
        runningMessages.push({ role: "user", content: toolResultBlocks });
        var nextController = new AbortController();
        return postToAnthropic(runningMessages, nextController.signal);
      },
      onBeforeFinalize: async function() {
        if (!proposalIdsThisCall.length) return "";
        var pr = await fetch(SUPABASE_URL + "/rest/v1/chat_proposals?id=in.(" + proposalIdsThisCall.join(",") + ")&select=id,type,status,payload", { headers: sbHeaders() });
        var proposals = await pr.json();
        if (!Array.isArray(proposals) || !proposals.length) return "";
        return "\n\n[[APEXCOACH_PROPOSALS]]\n" + JSON.stringify(proposals) + "\n[[/APEXCOACH_PROPOSALS]]";
      },
    });

    var fullText = result.fullText;
    if (fullText && fullText.trim()) {
      var savedMsg = await insertChatMessage(thread.id, "assistant", fullText.trim());
      if (proposalIdsThisCall.length && savedMsg && savedMsg.id) {
        backfillProposalMessageIds(proposalIdsThisCall, savedMsg.id).catch(function(e) {
          console.error("[Chat] backfillProposalMessageIds failed:", e && e.message);
        });
      }
      summarizeChatThreadIfNeeded(thread.id).catch(function(e) {
        console.error("[Chat] summarize error:", e && e.message);
      });
    }
  } catch (err) {
    console.error("[Chat] send error:", err && err.message);
    if (!res.headersSent) {
      if (err && err.name === "AbortError") {
        res.status(504).json({ error: { message: "Chat request timed out" } });
      } else {
        res.status(500).json({ error: { message: (err && err.message) || "Chat request failed" } });
      }
    } else {
      try { res.end(); } catch (e) {}
    }
  }
});

// GET full thread history for initial render. Returns ALL messages (not just
// the post-summary-cutoff tail sent to the model) so the UI can show the
// complete conversation; summary_through_message_id is included so the client
// could visually mark the summarized portion later if desired (not done yet).
// Also returns ALL proposals for the thread (any status) — a stored assistant
// message may contain a frozen [[APEXCOACH_PROPOSALS]] marker with
// status:"pending" baked in from when it streamed, but the CURRENT status
// (confirmed/canceled since then) only lives here. The client must always
// prefer this array's status over whatever's embedded in the marker text —
// this is what keeps a confirm/cancel card correct across a page refresh.
app.get("/api/profiles/:id/chat/thread", async function(req, res) {
  try {
    var thread = await getChatThread(req.params.id);
    if (!thread) return res.json({ thread_id: null, summary: null, summary_through_message_id: null, messages: [], proposals: [] });
    var messages = await fetchAllChatMessages(thread.id);
    var pr = await fetch(SUPABASE_URL + "/rest/v1/chat_proposals?thread_id=eq." + thread.id + "&select=id,type,status,payload,created_at&order=id.asc", { headers: sbHeaders() });
    var proposals = await pr.json();
    res.json({
      thread_id: thread.id,
      summary: thread.summary || null,
      summary_through_message_id: thread.summary_through_message_id || null,
      messages: messages.map(function(m) { return { role: m.role, content: m.content, created_at: m.created_at }; }),
      proposals: Array.isArray(proposals) ? proposals : [],
    });
  } catch (err) {
    console.error("[Chat] thread fetch error:", err && err.message);
    res.status(500).json({ error: { message: "Failed to load chat thread" } });
  }
});

// Confirm/cancel a pending proposal. Both are simple, fast, synchronous
// endpoints — NEITHER makes a live Anthropic call. Confirm executes the
// actual write (applyProposal) and marks the proposal confirmed; cancel just
// marks it canceled. Both insert a short synthetic note into chat_messages
// (role:"user") so the thread history stays coherent — the model's "graceful
// acknowledgment" of a confirm/cancel happens naturally on the athlete's next
// real message, which now has that note in context, rather than triggering a
// second live model turn from a button click (extra latency/cost for a
// deterministic, unambiguous outcome). This is a deliberate design choice,
// not an oversight — see the Part B design note in CLAUDE.md.
async function loadProposalForProfile(profileId, proposalId) {
  var pr = await fetch(SUPABASE_URL + "/rest/v1/chat_proposals?id=eq." + proposalId + "&select=id,thread_id,type,status,payload", { headers: sbHeaders() });
  var rows = await pr.json();
  var proposal = Array.isArray(rows) && rows[0];
  if (!proposal) { var e = new Error("Proposal not found"); e.status = 404; throw e; }
  var thread = await getChatThread(profileId);
  if (!thread || thread.id !== proposal.thread_id) { var e2 = new Error("Proposal does not belong to this profile"); e2.status = 403; throw e2; }
  return proposal;
}

// Auto-creates a pending "regenerate_goal_roadmap" proposal right after a
// confirmed goal-update, when that goal already has a roadmap — server-
// triggered, not model-tool-call-triggered. Live verification (2026-07-15,
// real chat session) found the model-initiated design unreliable: three
// different prompt strategies (soft ask, explicit "don't ask first", a blunt
// mechanical if/then rule) all produced the model narrating the offer in
// text ("I'll queue it up", "confirm that card") without ever actually
// calling the propose_roadmap_regen tool — zero proposals created across 3
// confirmed goal-updates, while propose_goal_update itself fired correctly
// all 3 times in the same session, ruling out a plumbing bug. Switched to
// this deterministic trigger instead. Still reuses the exact same
// chat_proposals/applyProposal infrastructure and still requires the
// athlete's explicit confirm before any regeneration happens — only WHO
// creates the pending proposal changed, not the safety model. Dedup-guards
// against creating a second pending offer for the same goal (e.g. several
// small edits confirmed in a row) so cards don't pile up unconfirmed.
async function maybeAutoOfferRoadmapRegen(threadId, profileId, goal) {
  try {
    var existing = await fetch(SUPABASE_URL + "/rest/v1/chat_proposals?thread_id=eq." + threadId + "&type=eq.regenerate_goal_roadmap&status=eq.pending&select=id,payload", { headers: sbHeaders() });
    var existingRows = await existing.json();
    var alreadyPending = Array.isArray(existingRows) && existingRows.some(function(r) { return r.payload && r.payload.goal_id === goal.id; });
    if (alreadyPending) return null;

    var proposalData = await computeRoadmapRegenProposal(profileId, {
      goal_id: goal.id,
      reason: "Automatically offered — this goal's roadmap may now be out of date after the update.",
    });
    // tool_use_id is NOT NULL in chat_proposals (migrations/2026-07-15_chat_proposals.sql)
    // — it was designed assuming every proposal originates from a model tool
    // call. This one doesn't, so a synthetic sentinel stands in; caught live
    // (2026-07-15) as a real 23502 not-null-constraint error on the first
    // attempt, not by reading the schema. Also needed migrations/2026-07-15_
    // chat_proposals_regen_type.sql — the type CHECK constraint didn't allow
    // this value either (a second real error caught live, run manually).
    var row = await createChatProposal(threadId, "server:auto-offer-roadmap-regen", "regenerate_goal_roadmap", proposalData);
    // createChatProposal() doesn't check r.ok — a Supabase insert error comes
    // back as an error object, not an array, so `row` would be that object
    // rather than a real proposal row (caught live, see the notes above).
    // Guard here rather than fixing createChatProposal() globally, to keep
    // this fix scoped to the one caller that actually hit it.
    if (!row || !row.id) {
      console.error("[Chat] auto-offer roadmap regen: createChatProposal returned no row for goal " + goal.id + ":", JSON.stringify(row));
      return null;
    }
    await insertChatMessage(threadId, "user",
      "[The app automatically offered to regenerate the roadmap for \"" + (goal.title || "this goal") +
      "\" since it was just updated — this was not something you proposed, just acknowledge it naturally if asked.]");
    return row;
  } catch (e) {
    // Non-fatal: the goal update itself already succeeded and is confirmed;
    // a failed auto-offer just means no regen card this time, not a broken
    // confirm. computeRoadmapRegenProposal's own noop (no roadmap) lands here
    // too, harmlessly.
    console.error("[Chat] auto-offer roadmap regen failed for goal " + goal.id + ":", e && e.message);
    return null;
  }
}

app.post("/api/profiles/:id/chat/proposals/:proposalId/confirm", async function(req, res) {
  var profileId = req.params.id;
  try {
    var proposal = await loadProposalForProfile(profileId, req.params.proposalId);
    if (proposal.status !== "pending") {
      return res.status(409).json({ error: { message: "Proposal is already " + proposal.status + "." } });
    }
    var applyResult = await applyProposal(proposal, profileId);
    await fetch(SUPABASE_URL + "/rest/v1/chat_proposals?id=eq." + proposal.id, {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify({ status: "confirmed", resolved_at: new Date().toISOString() }),
    });
    var summary = proposal.payload && proposal.payload.title;
    await insertChatMessage(proposal.thread_id, "user", "[Athlete confirmed the proposed change" + (summary ? " to \"" + summary + "\"" : "") + ".]");

    var followUpProposal = null;
    if (applyResult && applyResult.autoOfferGoal) {
      followUpProposal = await maybeAutoOfferRoadmapRegen(proposal.thread_id, profileId, applyResult.autoOfferGoal);
    }
    res.json({ success: true, status: "confirmed", follow_up_proposal: followUpProposal });
  } catch (err) {
    console.error("[Chat] proposal confirm error:", err && err.message);
    res.status(err.status || 500).json({ error: { message: err.message || "Failed to confirm proposal" } });
  }
});

app.post("/api/profiles/:id/chat/proposals/:proposalId/cancel", async function(req, res) {
  var profileId = req.params.id;
  try {
    var proposal = await loadProposalForProfile(profileId, req.params.proposalId);
    if (proposal.status !== "pending") {
      return res.status(409).json({ error: { message: "Proposal is already " + proposal.status + "." } });
    }
    await fetch(SUPABASE_URL + "/rest/v1/chat_proposals?id=eq." + proposal.id, {
      method: "PATCH",
      headers: sbHeaders("return=minimal"),
      body: JSON.stringify({ status: "canceled", resolved_at: new Date().toISOString() }),
    });
    var summary = proposal.payload && proposal.payload.title;
    await insertChatMessage(proposal.thread_id, "user", "[Athlete declined the proposed change" + (summary ? " to \"" + summary + "\"" : "") + ".]");
    res.json({ success: true, status: "canceled" });
  } catch (err) {
    console.error("[Chat] proposal cancel error:", err && err.message);
    res.status(err.status || 500).json({ error: { message: err.message || "Failed to cancel proposal" } });
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

// Detects an exercise entry that states a TARGET / aspiration rather than an
// achieved effort, e.g. "Dead Hang - work toward 2:00 goal". Without this
// guard parseDurationToSeconds reads the goal time ("2:00") as a logged hold
// and pegs a time-based strength_milestone at 100%. Deliberately narrow so a
// real log ("Dead Hang 1m 42s") is never excluded.
function mgIsAspirationalEntry(text) {
  if (!text) return false;
  var s = String(text).toLowerCase();
  return /(work(?:ing)?\s+toward|aim(?:ing)?\s+for|trying\s+for|build(?:ing)?\s+(?:up\s+)?to|shooting\s+for|\bgoal\b|\btarget\b)/.test(s);
}

// All lowercase alias phrases that canonicalize to `canonical` (reverse lookup
// over CANONICAL_NAMES), plus the canonical name itself. Used to scan free-text
// workout notes for a logged exercise the AI extractor failed to pull into its
// own exercises row.
function mgCanonicalAliases(canonical) {
  if (!canonical) return [];
  var cl = String(canonical).toLowerCase();
  var out = [cl];
  Object.keys(CANONICAL_NAMES).forEach(function(k) {
    if (String(CANONICAL_NAMES[k]).toLowerCase() === cl) out.push(k);
  });
  return out.filter(function(v, i) { return out.indexOf(v) === i; });
}

// Does a free-text workout (notes + type) mention the goal's canonical
// exercise? Backstops the exercises-table day count for the daily_habit /
// streak trackers: when the extractor misses a hang buried in multi-exercise
// notes, the workout text still proves the session happened. Alias phrases are
// matched on word boundaries; a bare "hang"/"hanging" that's really part of a
// different movement (e.g. "hanging leg raise") is rejected unless an explicit
// dead-hang phrase is also present.
function mgWorkoutTextMatches(text, title) {
  if (!text) return false;
  var h = String(text).toLowerCase();
  var canonical = extractCanonicalFromTitle(title);
  if (!canonical) return mgMatchesKeyword(text, title);
  var aliases = mgCanonicalAliases(canonical);
  var hasExplicitHang = /\b(dead\s*hangs?|bar\s*hangs?|passive\s*hangs?)\b/.test(h);
  for (var i = 0; i < aliases.length; i++) {
    var a = aliases[i];
    var re = new RegExp('(^|[^a-z0-9])' + a.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '([^a-z0-9]|$)');
    if (!re.test(h)) continue;
    // Bare hang/hangs/hanging that is actually another move ("hanging leg
    // raise", "hanging knee raise") doesn't count unless a real dead-hang
    // phrase is also in the text.
    if (/^hang(?:s|ing)?$/.test(a) &&
        /\bhang(?:ing|s)?\s+(?:leg|knee|oblique|windshield|toes?[\s-]*to)/.test(h) &&
        !hasExplicitHang) {
      continue;
    }
    return true;
  }
  return false;
}

// Distinct YYYY-MM-DD days a daily_habit/streak goal was satisfied, unioning
// (a) days with a matching exercises row and (b) days a workout's notes/type
// mention the exercise even though no exercises row was extracted. Returns
// { days:Set, fromExercise:Set, fromWorkout:Set } so callers (and the debug
// endpoint) can see where each day came from.
async function mgHabitDaySources(pid, title) {
  var fromExercise = new Set();
  var fromWorkout = new Set();
  var exR = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid + "&select=name,date&order=date.desc&limit=5000", { headers: sbHeaders() });
  var exRows = await exR.json();
  (Array.isArray(exRows) ? exRows : []).forEach(function(e) {
    if (e.date && mgMatchesExercise(e.name, title)) fromExercise.add(e.date);
  });
  var wkR = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + pid + "&select=date,type,notes&order=date.desc&limit=5000", { headers: sbHeaders() });
  var wkRows = await wkR.json();
  (Array.isArray(wkRows) ? wkRows : []).forEach(function(w) {
    if (!w.date) return;
    if (fromExercise.has(w.date)) return; // already counted via an exercise row
    if (mgWorkoutTextMatches((w.type || '') + ' \n ' + (w.notes || ''), title)) fromWorkout.add(w.date);
  });
  var days = new Set(fromExercise);
  fromWorkout.forEach(function(d) { days.add(d); });
  return { days: days, fromExercise: fromExercise, fromWorkout: fromWorkout };
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
      // De-dup is per calendar date via the Set below.
      //
      // Count days from BOTH the exercises table AND workout notes — the AI
      // extractor sometimes misses an exercise buried in a long multi-exercise
      // note (e.g. a single "Dead hang" line in a 6-exercise session), which
      // silently dropped real habit days from the count. `mgHabitDaySources`
      // unions the two so an un-extracted-but-logged session still counts.
      var habitSrc = await mgHabitDaySources(pid, title);
      return habitSrc.days.size;
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
          // Ignore aspirational/goal-statement rows ("Dead Hang - work toward
          // 2:00 goal"): the duration parser would otherwise read the TARGET
          // time as an achieved hold and peg the milestone at 100%. A real
          // logged effort ("Dead Hang 1m 42s") has no goal/target phrasing.
          if (mgIsAspirationalEntry(e.raw_text) || mgIsAspirationalEntry(e.notes)) return;
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

      // Rep-based milestones (e.g. "20 consecutive push-ups", unit 'reps') —
      // the best SINGLE-SET rep count across matching exercises. Not summed:
      // cumulative_volume already covers totals; a milestone is the best single
      // effort. No main_category filter — bodyweight rep work is sometimes
      // categorized 'other'/'calisthenics' rather than 'strength'.
      var isRepUnit = unit === 'reps' || unit === 'rep';
      if (isRepUnit) {
        var rrp = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid + "&select=name,reps&order=date.desc&limit=5000", { headers: sbHeaders() });
        var rprows = await rrp.json();
        var maxReps = 0;
        (rprows || []).forEach(function(e) {
          if (!mgMatchesExercise(e.name, title)) return;
          var rp = Number(e.reps || 0);
          if (rp > maxReps) maxReps = rp;
        });
        return maxReps;
      }

      // Distance milestones (e.g. "run 5 miles", unit 'miles'/'km') — the
      // longest SINGLE-SESSION distance. distance_miles is the stored unit; km
      // targets convert from miles. No main_category filter (runs/rucks/hikes
      // are cardio, not strength).
      var isMile = unit === 'miles' || unit === 'mile' || unit === 'mi';
      var isKm = unit === 'km' || unit === 'kilometer' || unit === 'kilometers' || unit === 'kilometre' || unit === 'kilometres' || unit === 'kms';
      if (isMile || isKm) {
        var rds = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid + "&select=name,distance_miles&order=date.desc&limit=5000", { headers: sbHeaders() });
        var rdrows = await rds.json();
        var maxMiles = 0;
        (rdrows || []).forEach(function(e) {
          if (!mgMatchesExercise(e.name, title)) return;
          var ds = Number(e.distance_miles || 0);
          if (ds > maxMiles) maxMiles = ds;
        });
        if (isKm) return +(maxMiles * 1.609344).toFixed(2);
        return +maxMiles.toFixed(2);
      }

      // Weight-based path (default). lbs is the stored unit; kg targets convert
      // from the stored lbs so current_value reads in the goal's own unit.
      var isKg = unit === 'kg' || unit === 'kgs' || unit === 'kilo' || unit === 'kilos' || unit === 'kilogram' || unit === 'kilograms';
      var rm = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + pid + "&main_category=eq.strength&select=name,weight_lbs", { headers: sbHeaders() });
      var mrows = await rm.json();
      var max = 0;
      (mrows || []).forEach(function(e) {
        if (!mgMatchesExercise(e.name, title)) return;
        var wt = Number(e.weight_lbs || 0);
        if (wt > max) max = wt;
      });
      if (isKg) return +(max * 0.45359237).toFixed(2);
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
  // Fresh tokens → connection healthy again. Cleared separately (not folded
  // into the upsert body) so a missing needs_reconnect column can never break
  // the token write itself.
  setNeedsReconnect(profileId, provider, false);
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
  // Serialize the refresh per (provider:profileId) so concurrent callers share
  // ONE exchange instead of each spending the single-use refresh token (see
  // withRefreshLock). tokens.refresh_token captured above is only ever used by
  // the caller that actually runs this fn; everyone else awaits its result.
  return withRefreshLock(provider + ":" + profileId, async function() {
    var adapter = wearables.getProviderAdapter(provider);
    var fresh;
    try {
      fresh = await adapter.refreshToken(tokens.refresh_token);
    } catch (refreshErr) {
      refreshErr.code = refreshErr.code || "RECONNECT_REQUIRED";
      // Definitive auth failure → persist the health flag for the UI. Best-effort.
      setNeedsReconnect(profileId, provider, true);
      throw refreshErr;
    }
    await saveWearableTokens(profileId, provider, fresh);
    return fresh.access_token;
  });
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
// → { providers: [{ provider, label, connected, needs_reconnect, status, last_synced_at }] }
//   status: 'connected' | 'needs_reconnect' | 'disconnected'.
//   connected reflects real token health (a row whose last refresh hit
//   invalid_grant reports connected:false / status:'needs_reconnect'), NOT
//   mere row existence — so the UI and the sync modal stop treating a dead
//   token as a live connection. needs_reconnect is only ever set on a
//   definitive auth failure, never a transient blip, so this doesn't flap.
app.get("/api/wearables/providers/:userId", async function(req, res) {
  try {
    var pid = req.params.userId;
    // Select needs_reconnect too; fall back to a column-less select if the
    // 2026-07-17 migration hasn't been applied yet (PostgREST 400s an unknown
    // column) so the endpoint never breaks in the pre-migration window —
    // every row then reads as healthy (needs_reconnect defaults false).
    var selectBase = "profile_id=eq." + pid + "&select=provider,last_synced_at,token_expires_at";
    var connRes = await fetch(
      SUPABASE_URL + "/rest/v1/wearable_connections?" + selectBase + ",needs_reconnect",
      { headers: sbHeaders() }
    );
    var conns = await connRes.json();
    if (!Array.isArray(conns)) {
      // Most likely the needs_reconnect column doesn't exist yet — retry the
      // original, column-less shape.
      var retryRes = await fetch(
        SUPABASE_URL + "/rest/v1/wearable_connections?" + selectBase,
        { headers: sbHeaders() }
      );
      conns = await retryRes.json();
    }
    var byProvider = {};
    (Array.isArray(conns) ? conns : []).forEach(function(c) { byProvider[c.provider] = c; });

    var all = wearables.listProviders();
    var out = all.map(function(p) {
      var c = byProvider[p.provider];
      var needsReconnect = !!(c && c.needs_reconnect);
      var status = !c ? "disconnected" : (needsReconnect ? "needs_reconnect" : "connected");
      return {
        provider: p.provider,
        label: p.label,
        // Backward-compatible field: true only when a row exists AND its token
        // is healthy. Existing consumers (sync modal, GH reconsent banner)
        // keep reading .connected and now correctly drop a dead connection.
        connected: status === "connected",
        needs_reconnect: needsReconnect,
        status: status,
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

async function performReject(profileId, workoutId, provider, namespacedActivityId, listActivity, createStandalone) {
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
  // By default reject also preserves the wearable session as its own standalone
  // workout — the user said "these are separate sessions", not "throw away the
  // wearable data". The auto-import-on-save flow passes create_standalone:false
  // to skip that: there it only wants the rejection recorded so the pairing
  // won't resurface, without adding a second workout to the day.
  if (createStandalone === false) {
    return { workout: null, wearable_activity_id: ids.ns };
  }
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
    // create_standalone defaults to true (existing behavior); only an explicit
    // false skips the standalone-workout creation (auto-import-on-save flow).
    var out = await performReject(req.params.userId, b.workout_id, provider, b.wearable_activity_id, b.list_activity, b.create_standalone);
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

// GET /api/debug/google-health-probe/:userId?secret=ADMIN_SECRET
//     [&date=YYYY-MM-DD] [&allow_refresh=1] [&raw=1]
//
// Answers the one question the normal /daily path structurally cannot: is
// Google Health actually executing for this profile? /daily can't answer it
// because the adapter's Promise.allSettled turns every failure — including a
// 401 — into a null metric, and the hasData gate then reports the whole thing
// as "no data, falling through to Fitbit". This returns the UNSWALLOWED
// result: token state, and per-leg outcome for all six metrics with the real
// HTTP status and message.
//
// READ-ONLY BY DEFAULT. Writes no table and does not mutate connection state.
// If the stored access token is expired it reports exactly that and STOPS,
// because refreshing writes (saveWearableTokens). Pass allow_refresh=1 to opt
// into a real refresh through the app's own getValidWearableToken path — that
// is the ONLY option here that writes, and note that a failed refresh will
// also set needs_reconnect=true (that is getValidWearableToken's existing,
// correct behavior, not something this endpoint adds).
app.get("/api/debug/google-health-probe/:userId", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var gotGhp = req.headers["x-admin-secret"] || req.query.secret;
      if (gotGhp !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var pid = req.params.userId;
    var allowRefresh = req.query.allow_refresh === "1";
    var profileTz = await getProfileTimezone(pid).catch(function() { return {}; });
    var probeDate = req.query.date || localToday(profileTz);

    // ── Step 1: token acquisition, reported rather than swallowed ──
    var stored = await loadWearableTokens(pid, "google_health");
    var now = Date.now();
    var expiresAt = Number(stored.expires_at) || 0;
    var tokenReport = {
      connection_row_present: !!(stored.access_token || stored.refresh_token),
      has_access_token: !!stored.access_token,
      has_refresh_token: !!stored.refresh_token,
      expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      expired: !expiresAt || now >= expiresAt,
      seconds_until_expiry: expiresAt ? Math.round((expiresAt - now) / 1000) : null,
      served_from: null,
      error: null,
    };
    function stop(note) {
      return res.json({
        success: true, profile_id: pid, date: probeDate,
        token: tokenReport, legs: null, parsed: null,
        would_serve_google_health: false, note: note,
      });
    }
    if (!tokenReport.connection_row_present) {
      tokenReport.served_from = "none";
      return stop("No google_health row in wearable_connections for this profile — nothing to probe.");
    }

    var token = null;
    if (!tokenReport.expired && stored.access_token) {
      token = stored.access_token;
      tokenReport.served_from = "cache";
    } else if (allowRefresh) {
      try {
        token = await getValidWearableToken(pid, "google_health");
        tokenReport.served_from = "refreshed";
      } catch (e) {
        tokenReport.served_from = "refresh_failed";
        tokenReport.error = { code: (e && e.code) || null, message: String((e && e.message) || e).substring(0, 300) };
        return stop("Refresh failed — the refresh token is rejected. This is a definitive auth failure; " +
          "getValidWearableToken will have set needs_reconnect=true. Reconnect Google Health.");
      }
    } else {
      tokenReport.served_from = "expired_not_refreshed";
      return stop("Stored access token is expired. Re-run with &allow_refresh=1 to refresh and probe " +
        "(that path WRITES new tokens, and on failure sets needs_reconnect=true).");
    }

    // ── Step 2: the six legs, unswallowed ──
    // Each leg is capped at 7s inside the adapter; this outer cap bounds the
    // whole probe (six in parallel + one possible 429 retry).
    var ghAdapter = wearables.getProviderAdapter("google_health");
    var probe = await withTimeout(
      ghAdapter.fetchDailyData(token, probeDate, { label: "probe", include_raw: req.query.raw === "1" }),
      20000, "google_health probe"
    );
    var diag = (probe && probe._diagnostics) || {};
    // Mirrors /daily's own hasData gate exactly, so this reports what /daily
    // WOULD have done with this same result.
    var wouldServe = probe.hrv !== null || probe.rhr !== null ||
                     probe.sleep !== null || probe.steps !== null;

    res.json({
      success: true,
      profile_id: pid,
      date: probeDate,
      token: tokenReport,
      auth_failure: !!diag.auth_failure,
      legs_fulfilled: diag.fulfilled_count,
      legs_rejected: diag.rejected_count,
      legs: diag.legs || null,
      parsed: {
        hrv: probe.hrv, rhr: probe.rhr, steps: probe.steps,
        activeZoneMinutes: probe.activeZoneMinutes,
        sleep: probe.sleep, weight: probe.weight,
      },
      would_serve_google_health: wouldServe,
      note: wouldServe
        ? "/daily would SERVE Google Health for this date."
        : "/daily would fall through to Fitbit for this date. Check legs_rejected to tell a dead provider from a quiet day.",
    });
  } catch (e) {
    console.error("[google_health probe] failed:", e.message);
    res.status(500).json({ success: false, error: e.message, code: (e && e.code) || null });
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
// POST /api/debug/test-vitals-upsert/:userId?secret=ADMIN_SECRET
// Verifies the clobber-safety invariant behind the GH sleep-decoupling fix:
// writing HRV/RHR via upsertDailyVitals must NOT null out an existing sleep row.
// Uses a throwaway date (1970-01-01, isolated from all real data) and cleans up
// ── ADMIN: ONE-TIME PHASE RE-SEQUENCE REPAIR (F1) ─────────────────────────
//   POST /api/debug/resequence-roadmap/:profileId/:goalId?secret=...&apply=1
// DRY RUN by default. Repairs a roadmap whose near_term phases share the same
// start_date (an adapt that returned a non-integer duration_weeks pinned every
// phase to today — see ROADMAP §9). Only touches start_date / end_date /
// duration_weeks; names, targets, emphasis, status and adaptation_log are not
// modified. Deliberately NOT wired into adapt/generate — repair only.
app.post("/api/debug/resequence-roadmap/:profileId/:goalId", async function(req, res) {
  if (process.env.ADMIN_SECRET) {
    var gotR = req.query.secret || req.headers["x-admin-secret"];
    if (gotR !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
  }
  var applyR = req.query.apply === "1" || req.query.apply === "true";
  try {
    var loaded = await loadProfileWithGoals(req.params.profileId);
    var found = findGoalById(loaded.profileData, req.params.goalId);
    var goal = found.goal;
    if (!goal || !goal.roadmap || !Array.isArray(goal.roadmap.phases)) {
      return res.status(404).json({ success: false, error: "goal or roadmap not found" });
    }
    var snap = function() {
      return goal.roadmap.phases.filter(function(p) { return p.type === "near_term"; })
        .map(function(p) { return { name: p.name, status: p.status, start_date: p.start_date, end_date: p.end_date, duration_weeks: p.duration_weeks, emphasis_count: (p.emphasis || []).length }; });
    };
    var before = JSON.parse(JSON.stringify(snap()));
    var changes = resequenceNearTermDates(goal.roadmap.phases, ymdLocal(new Date()));
    var after = snap();
    var payload = {
      success: true, dry_run: !applyR, goal: goal.title,
      roadmap_version: goal.roadmap.version,
      adaptation_log_entries: (goal.roadmap.adaptation_log || []).length,
      changes: changes, before: before, after: after,
    };
    if (!applyR) return res.json(payload);
    await saveGoalToProfile(req.params.profileId, loaded.profileData, found.index, goal);
    payload.applied = true;
    res.json(payload);
  } catch (e) {
    console.error("[Resequence] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── ADMIN: BACKFILL roadmap.phases[].emphasis ─────────────────────────────
//   POST /api/debug/extract-roadmap-emphasis/:profileId?secret=...&apply=1
// DRY RUN by default. Fills `emphasis` on every near_term phase of every goal
// that has a roadmap, for roadmaps generated before emphasis became a native
// output field. Idempotent: `&force=1` re-extracts phases that already have it.
// Only ever writes profile_data.goals[].roadmap.phases[i].emphasis — no other
// field is touched, so a bad run cannot damage roadmap content.
app.post("/api/debug/extract-roadmap-emphasis/:profileId", async function(req, res) {
  if (process.env.ADMIN_SECRET) {
    var gotE = req.query.secret || req.headers["x-admin-secret"];
    if (gotE !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
  }
  var pid = parseInt(req.params.profileId, 10);
  var applyE = req.query.apply === "1" || req.query.apply === "true";
  var force = req.query.force === "1" || req.query.force === "true";
  try {
    var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid + "&select=profile_data", { headers: sbHeaders() });
    var prows = await pr.json();
    var pdata = Array.isArray(prows) && prows[0] && prows[0].profile_data;
    if (!pdata) return res.status(404).json({ success: false, error: "profile not found" });
    var goals = Array.isArray(pdata.goals) ? pdata.goals : [];

    var report = [], changed = 0, failed = 0;
    for (var gi = 0; gi < goals.length; gi++) {
      var g = goals[gi];
      if (!g.roadmap || !Array.isArray(g.roadmap.phases)) continue;
      var phaseOut = [];
      for (var pi = 0; pi < g.roadmap.phases.length; pi++) {
        var ph = g.roadmap.phases[pi];
        if (ph.type !== "near_term") continue;
        if (Array.isArray(ph.emphasis) && !force) {
          phaseOut.push({ phase: ph.name, status: ph.status, skipped: "already has emphasis", emphasis: ph.emphasis });
          continue;
        }
        var emph = await extractPhaseEmphasis(g.title, ph);
        if (emph === null) {
          failed++;
          phaseOut.push({ phase: ph.name, status: ph.status, error: "extraction failed — left uncached" });
          continue;
        }
        phaseOut.push({ phase: ph.name, status: ph.status, weekly_targets: ph.weekly_targets || [], emphasis: emph });
        if (applyE) { ph.emphasis = emph; changed++; }
      }
      report.push({ goal_id: g.id, goal: g.title, phases: phaseOut });
    }

    if (!applyE) return res.json({ success: true, dry_run: true, profile_id: pid, failed: failed, goals: report });
    if (changed) {
      var wr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid, {
        method: "PATCH", headers: sbHeaders("return=minimal"),
        body: JSON.stringify({ profile_data: pdata }),
      });
      if (!wr.ok) {
        var werr = await wr.text();
        return res.status(500).json({ success: false, error: "write failed: " + werr.slice(0, 300), goals: report });
      }
    }
    res.json({ success: true, dry_run: false, profile_id: pid, phases_written: changed, failed: failed, goals: report });
  } catch (e) {
    console.error("[RoadmapEmphasis] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── ADMIN: RE-MERGE ONE WORKOUT'S EXERCISE ROWS ───────────────────────────
// Recovery pass for exercise rows destroyed by the pre-2026-07-19 integer
// duration_minutes column (see migrations/2026-07-19_exercises_duration_numeric.sql),
// and for rows left stale by a notes edit (extract-exercises never re-runs on
// PATCH). Re-extracts one workout and MERGES the result into the existing rows.
//
//   POST /api/debug/remerge-workout-exercises/:profileId/:workoutId?secret=...
//        &apply=1     -> actually write. WITHOUT it this is a DRY RUN (default).
//        &max_ops=N   -> refuse to write if the plan exceeds N operations.
//
// STRATEGY — merge, never delete. Keyed on (workout_id, catalogNormKey(name)):
//   predicted key absent from existing      -> INSERT
//   key matches, any field differs          -> PATCH in place
//   key matches, all fields equal           -> no-op
//   existing row not reproduced             -> KEEP, report under `flagged_kept`
// A row is NEVER deleted. Re-extraction is not perfectly reliable across
// re-phrasings, so deleting anything it failed to reproduce would risk
// destroying real history to fix a smaller problem.
//
// IDEMPOTENT: extraction runs at temperature 0 (deterministic — measured), so a
// second run predicts the same names, matches the rows the first run wrote, and
// reports all no-ops.
//
// NOT ATOMIC — stated plainly rather than implied. PostgREST exposes no
// multi-statement transaction, so "transactional per workout" is not achievable
// over this interface. Instead: dry-run is the default, the full pre-state is
// captured and returned (`before`) so any change can be reversed by hand, ops
// run in a fixed order, and `stop_on_error` (default true) aborts the moment a
// write fails so a failure can never cascade through the rest of the plan.
function exFieldsDiffer(existing, pred) {
  var n = function(v) { return v == null || v === "" ? null : Number(v); };
  return n(existing.sets) !== n(pred.sets) ||
         n(existing.reps) !== n(pred.reps) ||
         n(existing.weight_lbs) !== n(pred.weight_lbs) ||
         n(existing.distance_miles) !== n(pred.distance_miles) ||
         n(existing.duration_minutes) !== n(pred.duration_minutes);
}

app.post("/api/debug/remerge-workout-exercises/:profileId/:workoutId", async function(req, res) {
  if (process.env.ADMIN_SECRET) {
    var got0 = req.query.secret || req.headers["x-admin-secret"];
    if (got0 !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
  }
  var pid = parseInt(req.params.profileId, 10);
  var wid = parseInt(req.params.workoutId, 10);
  var apply = req.query.apply === "1" || req.query.apply === "true";
  // FAIL CLOSED on a malformed max_ops. parseInt("abc") is NaN, and
  // `opCount > NaN` is always false — which silently DISABLED the plan-size
  // guard entirely. A bad value must clamp to the default, never remove the cap.
  var maxOps = 50;
  if (req.query.max_ops !== undefined) {
    var parsedMax = parseInt(req.query.max_ops, 10);
    if (!Number.isFinite(parsedMax) || parsedMax < 0) {
      return res.status(400).json({ success: false, error: "max_ops must be a non-negative integer" });
    }
    maxOps = parsedMax;
  }
  // "false"/"no" now read as false; previously ANY value except "0" was truthy,
  // so stop_on_error=false quietly left it enabled.
  var soe = String(req.query.stop_on_error === undefined ? "" : req.query.stop_on_error).toLowerCase();
  var stopOnError = !(soe === "0" || soe === "false" || soe === "no");
  try {
    // 1. Workout must exist AND belong to this profile.
    var wr = await fetch(SUPABASE_URL + "/rest/v1/workouts?id=eq." + wid + "&profile_id=eq." + pid + "&select=*", { headers: sbHeaders() });
    var wrows = await wr.json();
    var workout = Array.isArray(wrows) && wrows[0];
    if (!workout) return res.status(404).json({ success: false, error: "workout not found for this profile" });
    if (!workout.notes || !String(workout.notes).trim()) {
      return res.json({ success: true, workout_id: wid, skipped: "no notes to extract from" });
    }

    // 2. Snapshot existing rows (this is the `before` state / manual undo basis).
    var er = await fetch(SUPABASE_URL + "/rest/v1/exercises?workout_id=eq." + wid + "&profile_id=eq." + pid +
      "&select=id,name,category,main_category,subcategory,sets,reps,weight_lbs,distance_miles,duration_minutes,raw_text", { headers: sbHeaders() });
    var existingRows = await er.json();
    if (!Array.isArray(existingRows)) existingRows = [];

    // 3. Re-extract using the SAME prompt + model + temperature as the live
    //    save path, by delegating to the same helper it uses.
    var predicted = await extractExercisesFromNotes({ type: workout.type, notes: workout.notes });
    if (predicted.error) return res.status(502).json({ success: false, error: "extraction failed: " + predicted.error });

    // 4. Normalise predicted rows exactly as extract-exercises does.
    var catalogRequestCache = {};
    var normalised = [];
    for (var i = 0; i < predicted.list.length; i++) {
      var p = predicted.list[i];
      if (!p || !p.name) continue;
      // identical normalisation order to the live save path (aiCat is the
      // model's ORIGINAL category, which getSubcategory needs unmodified)
      p.name = normalizeExerciseName(p.name);
      var aiCat = p.category;
      p.category = normalizeCategory(p.name, aiCat);
      p.main_category = p.category;
      p.subcategory = getSubcategory(p.name, aiCat, p.category);
      var cm = await resolveExerciseCatalog(p.name, p.category, catalogRequestCache);
      p.name = cm.canonicalName;
      normalised.push(p);
    }

    // 5. Build the plan.
    var existingByKey = {};
    existingRows.forEach(function(r) {
      var k = catalogNormKey(r.name);
      if (!existingByKey[k]) existingByKey[k] = r;   // first row wins as merge target
    });
    var seenKeys = {};
    var plan = { insert: [], patch: [], noop: [], flagged_kept: [] };
    normalised.forEach(function(p) {
      var k = catalogNormKey(p.name);
      if (seenKeys[k]) { return; }   // duplicate key within one extraction (e.g. 2x Dead Hang) — first only
      seenKeys[k] = true;
      var ex = existingByKey[k];
      if (!ex) { plan.insert.push({ key: k, pred: p }); return; }
      if (exFieldsDiffer(ex, p)) plan.patch.push({ key: k, id: ex.id, from: ex, to: p });
      else plan.noop.push({ key: k, id: ex.id, name: ex.name });
    });
    existingRows.forEach(function(r) {
      var k = catalogNormKey(r.name);
      if (!seenKeys[k]) plan.flagged_kept.push({ id: r.id, name: r.name, sets: r.sets, reps: r.reps, duration_minutes: r.duration_minutes, raw_text: r.raw_text });
    });

    // 6. Near-duplicate guard. catalogNormKey does NOT collapse spelling variants
    //    ("Indoor Bike" vs "Indoor Bicycle", "Hip Rotation" vs "90/90 Hip
    //    Rotation"), so a kept row and a newly inserted row can be the same
    //    exercise under two names. REPORTED ONLY — never auto-merged, never
    //    auto-deleted; resolving these is a human decision.
    var finalNames = existingRows.map(function(r) { return r.name; })
      .concat(plan.insert.map(function(x) { return x.pred.name; }));
    var nearDupes = [];
    for (var a = 0; a < finalNames.length; a++) {
      for (var b = a + 1; b < finalNames.length; b++) {
        var ka = catalogNormKey(finalNames[a]), kb = catalogNormKey(finalNames[b]);
        if (ka === kb) continue;
        var sim = levenshteinSimilarity(ka, kb);
        if (sim >= 0.72 || ka.indexOf(kb) >= 0 || kb.indexOf(ka) >= 0) {
          nearDupes.push({ a: finalNames[a], b: finalNames[b], similarity: Math.round(sim * 100) / 100 });
        }
      }
    }

    var opCount = plan.insert.length + plan.patch.length;
    var summary = {
      success: true, applied: false, workout_id: wid, profile_id: pid, date: workout.date,
      existing_count: existingRows.length,
      predicted_count: normalised.length,
      projected_count: existingRows.length + plan.insert.length,
      ops: { insert: plan.insert.length, patch: plan.patch.length, noop: plan.noop.length, kept: plan.flagged_kept.length },
      plan: {
        insert: plan.insert.map(function(x) { return { name: x.pred.name, sets: x.pred.sets, reps: x.pred.reps, duration_minutes: x.pred.duration_minutes, raw_text: x.pred.raw_text }; }),
        patch: plan.patch.map(function(x) { return { id: x.id, name: x.from.name,
          from: { sets: x.from.sets, reps: x.from.reps, duration_minutes: x.from.duration_minutes },
          to: { sets: x.to.sets, reps: x.to.reps, duration_minutes: x.to.duration_minutes } }; }),
        noop: plan.noop,
        flagged_kept: plan.flagged_kept,
      },
      possible_near_duplicates: nearDupes,
      before: existingRows,
    };

    if (!apply) { summary.dry_run = true; return res.json(summary); }
    if (opCount > maxOps) {
      summary.dry_run = true; summary.refused = "plan has " + opCount + " ops, exceeds max_ops=" + maxOps;
      return res.status(409).json(summary);
    }

    // 7. Apply.
    var results = { inserted: [], patched: [], failed: [] };
    for (var pi = 0; pi < plan.patch.length; pi++) {
      var pt = plan.patch[pi];
      var pbody = {
        sets: pt.to.sets || null, reps: pt.to.reps || null,
        weight_lbs: pt.to.weight_lbs || null, distance_miles: pt.to.distance_miles || null,
        duration_minutes: pt.to.duration_minutes == null ? null : pt.to.duration_minutes,
        raw_text: pt.to.raw_text || null,
      };
      var pres = await fetch(SUPABASE_URL + "/rest/v1/exercises?id=eq." + pt.id, {
        method: "PATCH", headers: sbHeaders("return=representation"), body: JSON.stringify(pbody),
      });
      if (pres.ok) results.patched.push({ id: pt.id, name: pt.from.name });
      else {
        var pterr = await pres.text();
        results.failed.push({ op: "patch", id: pt.id, name: pt.from.name, status: pres.status, error: pterr.slice(0, 300), reason: classifyInsertFailure(pterr, pt.to) });
        if (stopOnError) break;
      }
    }
    if (!(stopOnError && results.failed.length)) {
      for (var ii = 0; ii < plan.insert.length; ii++) {
        var np = plan.insert[ii].pred;
        var ibody = {
          profile_id: pid, workout_id: wid, date: workout.date,
          name: np.name, category: np.category, main_category: np.main_category, subcategory: np.subcategory,
          sets: np.sets || null, reps: np.reps || null, weight_lbs: np.weight_lbs || null,
          distance_miles: np.distance_miles || null,
          duration_minutes: np.duration_minutes == null ? null : np.duration_minutes,
          notes: null, raw_text: np.raw_text || null,
        };
        var ires = await fetch(SUPABASE_URL + "/rest/v1/exercises", {
          method: "POST", headers: sbHeaders("return=representation"), body: JSON.stringify(ibody),
        });
        if (ires.ok) {
          var irow = await ires.json();
          results.inserted.push({ id: (Array.isArray(irow) ? irow[0] : irow || {}).id, name: np.name, duration_minutes: ibody.duration_minutes });
        } else {
          var ierr = await ires.text();
          results.failed.push({ op: "insert", name: np.name, status: ires.status, error: ierr.slice(0, 300), reason: classifyInsertFailure(ierr, np) });
          if (stopOnError) break;
        }
      }
    }
    summary.applied = true;
    summary.results = results;
    summary.after_count = existingRows.length + results.inserted.length;
    res.json(summary);
  } catch (e) {
    console.error("[Remerge] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// after itself, so it can be run safely before the real vitals path ever fires.
// Returns { clobbered, before, after } — clobbered:true means switch to a
// different write strategy before trusting the real path.
app.post("/api/debug/test-vitals-upsert/:userId", async function(req, res) {
  if (process.env.ADMIN_SECRET) {
    var got = req.query.secret || req.headers["x-admin-secret"];
    if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
  }
  var pid = parseInt(req.params.userId, 10);
  var testDate = "1970-01-01";
  var scope = "profile_id=eq." + pid + "&date=eq." + testDate;
  try {
    // 1. Seed a full sleep row (known sleep + vitals).
    await upsertDailySleep(pid, {
      date: testDate, hours: 7.5, score: 88,
      deep_minutes: 100, rem_minutes: 90, light_minutes: 200, wake_minutes: 20,
      hrv: 55, rhr: 60,
    });
    var b = await (await fetch(SUPABASE_URL + "/rest/v1/daily_sleep?" + scope + "&select=hours,score,deep_minutes,rem_minutes,light_minutes,wake_minutes,hrv,rhr", { headers: sbHeaders() })).json();
    var before = Array.isArray(b) ? b[0] : null;

    // 2. Vitals-only write with DIFFERENT hrv/rhr — must update vitals, keep sleep.
    await upsertDailyVitals(pid, { date: testDate, hrv: 99, rhr: 42 });
    var a = await (await fetch(SUPABASE_URL + "/rest/v1/daily_sleep?" + scope + "&select=hours,score,deep_minutes,rem_minutes,light_minutes,wake_minutes,hrv,rhr", { headers: sbHeaders() })).json();
    var after = Array.isArray(a) ? a[0] : null;

    // 3. Clean up the throwaway row.
    await fetch(SUPABASE_URL + "/rest/v1/daily_sleep?" + scope, { method: "DELETE", headers: sbHeaders("return=minimal") });

    var sleepSurvived = !!after && after.hours === 7.5 && after.deep_minutes === 100 &&
      after.rem_minutes === 90 && after.light_minutes === 200 && after.wake_minutes === 20 && after.score === 88;
    var vitalsUpdated = !!after && after.hrv === 99 && after.rhr === 42;
    res.json({
      success: true,
      clobbered: !sleepSurvived,
      sleep_survived: sleepSurvived,
      vitals_updated: vitalsUpdated,
      before: before, after: after,
    });
  } catch (e) {
    // Best-effort cleanup even on failure.
    try { await fetch(SUPABASE_URL + "/rest/v1/daily_sleep?" + scope, { method: "DELETE", headers: sbHeaders("return=minimal") }); } catch (e2) {}
    res.status(500).json({ success: false, error: e.message });
  }
});

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

// ── FITBIT FULL-HISTORY BACKFILL (2026-07-17) ─────────────────────────────
// Pulls historical sleep/HRV/RHR/steps/weight/body-fat via Fitbit's RANGE
// endpoints (never per-day calls) and upserts into daily_sleep/daily_steps/
// body_metrics. Two purposes, same mechanism: (1) pull ~2 years of pre-app
// Fitbit history before the Sept 2026 API shutdown makes it unreachable,
// (2) fill the confirmed mid-June->mid-July 2026 daily_sleep gap (dead
// tokens during an outage). Just pick start_date/end_date accordingly.
//
// Max spans below are each individually verified against Fitbit's own docs
// (not assumed): sleep 100d, HRV 30d, RHR (activities/heart) 365d,
// steps 1095d, weight 31d, body fat 30d. Chunked one day short of each
// documented limit as a safety margin against off-by-one ambiguity in "max
// span" — EXCEPT rhr, see below.
//
// RHR QUIRK (confirmed live, 2026-07-17): the documented 365d max for
// activities/heart is real (the range call doesn't error), but Fitbit
// silently omits value.restingHeartRate from every entry once the queried
// span gets long — a full 2-year backfill chunked at the (then-)364d max
// wrote 0 of 677 RHR values, while the exact same merge code, re-run over a
// 32-day verification window, wrote 25/25. heartRateZones still comes back
// fine at any span; it's specifically restingHeartRate that's span-limited,
// and it isn't documented anywhere. Chunked to 29d — same as HRV, which
// shares a documented 30d limit and was the working hypothesis for why RHR
// would behave the same — with a permanent per-chunk diagnostic log line
// (entries returned vs. entries actually carrying restingHeartRate) so any
// future drift in Fitbit's real limit shows up immediately instead of
// silently writing zero rows again.
//
// Admin-gated exactly like backfill-wearable-hr above. max_calls defaults to
// 100, NOT Infinity like backfill-wearable-hr — deliberate deviation, an
// accidental-unbounded-call guard against a slow/large date range eating the
// whole 150/hr Fitbit budget in one call (a full 2-year pull is ~85 calls
// total across all six metrics, so 100 covers most single windows anyway).
// All Fitbit calls (across every metric) share ONE budget + ONE ~1req/sec
// throttle. One failed chunk logs and continues — never aborts the run.
//
// NEVER OVERWRITES BETTER DATA. daily_sleep in particular is fed by three
// independent Fitbit endpoints (sleep detail, HRV, RHR) but is one row per
// date — upsertDailySleep() always writes all 8 fields, so it can't safely
// be called more than once per date. This merges all three sources plus
// whatever already exists in the row into a single payload before the one
// upsert call per date. Per-field rules:
//   - sleep detail (hours/score/deep/rem/light/wake): existing row wins
//     outright if it already has deep_minutes (real stage data beats
//     anything a range re-pull could offer); otherwise write the new fetch
//     and recompute score via estimateSleepScore. Hours-only fallback rows
//     (older Fitbit devices without stage data) are stored as-is.
//   - HRV / RHR: independent gap-fill — each only writes when the existing
//     row has that field null, regardless of what happened to the other.
//   - steps: existing wins if a steps count is already present (preserves
//     calories/distance/floors already on that row, which the range steps
//     endpoint doesn't carry); otherwise write steps and carry over whatever
//     calories/distance/floors the existing row (if any) already had.
//   - weight / body fat: independent gap-fill, same shape as HRV/RHR. Every
//     body_metrics write resolves an "effective weight" (existing-or-new)
//     before calling upsertBodyMetrics(), even for a body-fat-only write —
//     upsertBodyMetrics() recomputes bmi from whatever weight_lbs is IN the
//     payload, and a body-fat-only call with no weight in the payload would
//     otherwise send bmi:null and clobber an existing BMI (see CLAUDE.md).
var FITBIT_HISTORY_MAX_SPAN = { sleep: 99, hrv: 29, rhr: 29, steps: 1094, weight: 30, bodyfat: 29 };

function chunkDateRange(startDate, endDate, maxSpanDays) {
  var chunks = [];
  var cur = new Date(startDate + "T12:00:00Z");
  var end = new Date(endDate + "T12:00:00Z");
  while (cur <= end) {
    var chunkEnd = new Date(cur);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxSpanDays);
    if (chunkEnd > end) chunkEnd = new Date(end);
    chunks.push({ start: cur.toISOString().slice(0, 10), end: chunkEnd.toISOString().slice(0, 10) });
    cur = new Date(chunkEnd);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return chunks;
}

app.post("/api/debug/backfill-wearable-history/:userId", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var pid = req.params.userId;
    var startDate = req.query.start_date;
    var endDate = req.query.end_date;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: "start_date and end_date required (YYYY-MM-DD)" });
    }

    var maxCalls = parseInt(req.query.max_calls, 10);
    if (!(maxCalls > 0)) maxCalls = 100;
    var apiCalls = 0;
    var budgetHit = false;
    var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

    // Optional ?metrics=rhr or ?metrics=rhr,hrv — scopes which Fitbit fetch
    // loops run, for a cheap re-run of just the metric(s) that need it (e.g.
    // after the RHR chunking fix below). Defaults to all six, unchanged from
    // a plain call. Only gates the FETCH loops; the merge/write logic below
    // already no-ops correctly on an empty *ByDate object, so nothing else
    // needs to change for a scoped run to be safe.
    var metricsParam = req.query.metrics;
    var wantMetrics = metricsParam
      ? metricsParam.split(",").map(function(s) { return s.trim(); }).filter(Boolean)
      : ["sleep", "hrv", "rhr", "steps", "weight", "bodyfat"];
    function wantMetric(m) { return wantMetrics.indexOf(m) !== -1; }

    var token = await getValidProfileToken(pid);

    // Throttled Fitbit GET counted against the shared budget. Never throws —
    // logs and returns null on any failure so one bad chunk can't abort the run.
    async function budgetedFitGet(endpoint) {
      if (apiCalls >= maxCalls) { budgetHit = true; return null; }
      if (apiCalls > 0) await sleep(1000);
      apiCalls++;
      try {
        return await fitGet(endpoint, token);
      } catch (e) {
        console.warn("[HistoryBackfill] chunk failed for " + endpoint + ": " + e.message);
        return null;
      }
    }

    // ── Bulk-read existing rows once up front (Supabase reads don't count
    // against the Fitbit budget) — the source of truth for "is this worse?" ──
    var existingSleepR = await fetch(SUPABASE_URL + "/rest/v1/daily_sleep?profile_id=eq." + pid +
      "&date=gte." + startDate + "&date=lte." + endDate +
      "&select=date,hours,score,deep_minutes,rem_minutes,light_minutes,wake_minutes,hrv,rhr", { headers: sbHeaders() });
    var existingSleepRows = await existingSleepR.json();
    var existingSleep = {};
    (Array.isArray(existingSleepRows) ? existingSleepRows : []).forEach(function(r) { existingSleep[r.date] = r; });

    var existingStepsR = await fetch(SUPABASE_URL + "/rest/v1/daily_steps?profile_id=eq." + pid +
      "&date=gte." + startDate + "&date=lte." + endDate +
      "&select=date,steps,calories,distance_miles,floors", { headers: sbHeaders() });
    var existingStepsRows = await existingStepsR.json();
    var existingSteps = {};
    (Array.isArray(existingStepsRows) ? existingStepsRows : []).forEach(function(r) { existingSteps[r.date] = r; });

    var existingBodyR = await fetch(SUPABASE_URL + "/rest/v1/body_metrics?profile_id=eq." + pid +
      "&date=gte." + startDate + "&date=lte." + endDate +
      "&select=date,weight_lbs,body_fat_pct", { headers: sbHeaders() });
    var existingBodyRows = await existingBodyR.json();
    var existingBody = {};
    (Array.isArray(existingBodyRows) ? existingBodyRows : []).forEach(function(r) { existingBody[r.date] = r; });

    // ── Fetch: sleep detail ──────────────────────────────────────────────
    var sleepByDate = {};
    var sleepResumeFrom = null;
    if (wantMetric("sleep")) {
      var sleepChunks = chunkDateRange(startDate, endDate, FITBIT_HISTORY_MAX_SPAN.sleep);
      for (var si = 0; si < sleepChunks.length; si++) {
        var sc = sleepChunks[si];
        var sData = await budgetedFitGet("/1.2/user/-/sleep/date/" + sc.start + "/" + sc.end + ".json");
        if (sData === null && budgetHit) { sleepResumeFrom = sc.start; break; }
        if (!sData || !Array.isArray(sData.sleep)) continue;
        sData.sleep.forEach(function(entry) {
          if (!entry.isMainSleep || !entry.dateOfSleep) return;
          var summary = entry.levels && entry.levels.summary;
          sleepByDate[entry.dateOfSleep] = {
            hours: typeof entry.minutesAsleep === "number" ? +(entry.minutesAsleep / 60).toFixed(2) : null,
            deep_minutes: summary && summary.deep ? summary.deep.minutes : null,
            rem_minutes: summary && summary.rem ? summary.rem.minutes : null,
            light_minutes: summary && summary.light ? summary.light.minutes : null,
            wake_minutes: summary && summary.wake ? summary.wake.minutes : null,
          };
        });
      }
    }

    // ── Fetch: HRV ───────────────────────────────────────────────────────
    var hrvByDate = {};
    var hrvResumeFrom = null;
    if (wantMetric("hrv")) {
      var hrvChunks = chunkDateRange(startDate, endDate, FITBIT_HISTORY_MAX_SPAN.hrv);
      for (var hi = 0; hi < hrvChunks.length; hi++) {
        var hc = hrvChunks[hi];
        var hData = await budgetedFitGet("/1/user/-/hrv/date/" + hc.start + "/" + hc.end + ".json");
        if (hData === null && budgetHit) { hrvResumeFrom = hc.start; break; }
        if (!hData || !Array.isArray(hData.hrv)) continue;
        hData.hrv.forEach(function(entry) {
          if (!entry.dateTime || !entry.value) return;
          hrvByDate[entry.dateTime] = entry.value.dailyRmssd != null ? entry.value.dailyRmssd : null;
        });
      }
    }

    // ── Fetch: RHR ───────────────────────────────────────────────────────
    var rhrByDate = {};
    var rhrResumeFrom = null;
    if (wantMetric("rhr")) {
      var rhrChunks = chunkDateRange(startDate, endDate, FITBIT_HISTORY_MAX_SPAN.rhr);
      for (var ri = 0; ri < rhrChunks.length; ri++) {
        var rc = rhrChunks[ri];
        var rData = await budgetedFitGet("/1/user/-/activities/heart/date/" + rc.start + "/" + rc.end + ".json");
        if (rData === null && budgetHit) { rhrResumeFrom = rc.start; break; }
        var rArr = (rData && rData["activities-heart"]) || [];
        // Permanent diagnostic — see the RHR QUIRK comment above the endpoint.
        var rWithRhr = rArr.filter(function(e) { return e.value && e.value.restingHeartRate != null; }).length;
        console.log("[HistoryBackfill] RHR chunk " + rc.start + ".." + rc.end + ": " + rArr.length + " days returned, " + rWithRhr + " carrying restingHeartRate");
        rArr.forEach(function(entry) {
          if (!entry.dateTime || !entry.value) return;
          rhrByDate[entry.dateTime] = entry.value.restingHeartRate != null ? entry.value.restingHeartRate : null;
        });
      }
    }

    // ── Merge sleep + HRV + RHR into ONE upsert per date ────────────────
    var sleepDetailWritten = 0, sleepDetailSkipped = 0, sleepDetailEmpty = 0;
    var hrvWritten = 0, hrvSkipped = 0, hrvEmpty = 0;
    var rhrWritten = 0, rhrSkipped = 0, rhrEmpty = 0;
    var allSleepDates = {};
    Object.keys(sleepByDate).forEach(function(d) { allSleepDates[d] = true; });
    Object.keys(hrvByDate).forEach(function(d) { allSleepDates[d] = true; });
    Object.keys(rhrByDate).forEach(function(d) { allSleepDates[d] = true; });
    var dateList = Object.keys(allSleepDates).sort();
    for (var di = 0; di < dateList.length; di++) {
      var date = dateList[di];
      var existing = existingSleep[date] || null;
      var newSleep = sleepByDate[date] || null;
      var newHrv = hrvByDate.hasOwnProperty(date) ? hrvByDate[date] : null;
      var newRhr = rhrByDate.hasOwnProperty(date) ? rhrByDate[date] : null;

      var existingHasDetail = !!(existing && existing.deep_minutes != null);
      var useHours, useScore, useDeep, useRem, useLight, useWake;
      var sleepGapFilled = false;
      if (existingHasDetail) {
        sleepDetailSkipped++;
        useHours = existing.hours; useDeep = existing.deep_minutes; useRem = existing.rem_minutes;
        useLight = existing.light_minutes; useWake = existing.wake_minutes; useScore = existing.score;
      } else if (newSleep) {
        sleepDetailWritten++; sleepGapFilled = true;
        useHours = newSleep.hours; useDeep = newSleep.deep_minutes; useRem = newSleep.rem_minutes;
        useLight = newSleep.light_minutes; useWake = newSleep.wake_minutes;
        useScore = estimateSleepScore(newSleep.deep_minutes, newSleep.rem_minutes, newSleep.light_minutes, newSleep.wake_minutes);
      } else {
        sleepDetailEmpty++;
        useHours = existing ? existing.hours : null; useDeep = existing ? existing.deep_minutes : null;
        useRem = existing ? existing.rem_minutes : null; useLight = existing ? existing.light_minutes : null;
        useWake = existing ? existing.wake_minutes : null; useScore = existing ? existing.score : null;
      }

      var useHrv, hrvGapFilled = false;
      if (existing && existing.hrv != null) { hrvSkipped++; useHrv = existing.hrv; }
      else if (newHrv != null) { hrvWritten++; hrvGapFilled = true; useHrv = newHrv; }
      else { hrvEmpty++; useHrv = existing ? existing.hrv : null; }

      var useRhr, rhrGapFilled = false;
      if (existing && existing.rhr != null) { rhrSkipped++; useRhr = existing.rhr; }
      else if (newRhr != null) { rhrWritten++; rhrGapFilled = true; useRhr = newRhr; }
      else { rhrEmpty++; useRhr = existing ? existing.rhr : null; }

      if (!sleepGapFilled && !hrvGapFilled && !rhrGapFilled) continue; // nothing new for this date

      try {
        await upsertDailySleep(pid, {
          date: date, hours: useHours, score: useScore,
          deep_minutes: useDeep, rem_minutes: useRem, light_minutes: useLight, wake_minutes: useWake,
          hrv: useHrv, rhr: useRhr,
        });
      } catch (e) {
        console.error("[HistoryBackfill] daily_sleep upsert failed for " + date + ": " + e.message);
      }
    }

    // ── Steps ────────────────────────────────────────────────────────────
    var stepsByDate = {};
    var stepsResumeFrom = null;
    if (wantMetric("steps")) {
      var stepsChunks = chunkDateRange(startDate, endDate, FITBIT_HISTORY_MAX_SPAN.steps);
      for (var pi = 0; pi < stepsChunks.length; pi++) {
        var pc = stepsChunks[pi];
        var pData = await budgetedFitGet("/1/user/-/activities/steps/date/" + pc.start + "/" + pc.end + ".json");
        if (pData === null && budgetHit) { stepsResumeFrom = pc.start; break; }
        var pArr = (pData && pData["activities-steps"]) || [];
        pArr.forEach(function(entry) {
          var n = parseInt(entry.value, 10);
          if (!entry.dateTime || isNaN(n)) return;
          stepsByDate[entry.dateTime] = n;
        });
      }
    }
    var stepsWritten = 0, stepsSkipped = 0, stepsEmpty = 0;
    var stepDates = Object.keys(stepsByDate).sort();
    for (var pdi = 0; pdi < stepDates.length; pdi++) {
      var pdate = stepDates[pdi];
      var existingStepRow = existingSteps[pdate] || null;
      if (existingStepRow && existingStepRow.steps != null) { stepsSkipped++; continue; }
      var newStepCount = stepsByDate[pdate];
      try {
        await upsertDailySteps(pid, {
          date: pdate,
          steps: newStepCount,
          calories: existingStepRow ? existingStepRow.calories : null,
          distance_miles: existingStepRow ? existingStepRow.distance_miles : null,
          floors: existingStepRow ? existingStepRow.floors : null,
        });
        stepsWritten++;
      } catch (e) {
        console.error("[HistoryBackfill] daily_steps upsert failed for " + pdate + ": " + e.message);
      }
    }
    // Dates in range with neither an existing row nor a fetched value never
    // entered stepsByDate/existingSteps at all — not counted as "empty" per
    // date (would require enumerating every calendar day); the resume_from
    // + budget_hit fields are what tell you if the range was cut short.
    stepsEmpty = 0;

    // ── Weight + body fat → body_metrics ────────────────────────────────
    var weightByDate = {};
    var weightResumeFrom = null;
    if (wantMetric("weight")) {
      var weightChunks = chunkDateRange(startDate, endDate, FITBIT_HISTORY_MAX_SPAN.weight);
      for (var wi = 0; wi < weightChunks.length; wi++) {
        var wc = weightChunks[wi];
        var wData = await budgetedFitGet("/1/user/-/body/log/weight/date/" + wc.start + "/" + wc.end + ".json");
        if (wData === null && budgetHit) { weightResumeFrom = wc.start; break; }
        var wArr = (wData && wData.weight) || [];
        wArr.forEach(function(entry) {
          if (!entry.date) return;
          var raw = typeof entry.weight === "number" ? entry.weight : parseFloat(entry.weight);
          if (isNaN(raw)) return;
          // Fitbit returns kg for metric-locale accounts, lbs for US accounts;
          // anything under 60 can only be kg for an adult bodyweight reading.
          weightByDate[entry.date] = raw < 60 ? +(raw * 2.20462).toFixed(1) : +raw.toFixed(1);
        });
      }
    }

    var bodyfatByDate = {};
    var bodyfatResumeFrom = null;
    if (wantMetric("bodyfat")) {
      var bodyfatChunks = chunkDateRange(startDate, endDate, FITBIT_HISTORY_MAX_SPAN.bodyfat);
      for (var fi = 0; fi < bodyfatChunks.length; fi++) {
        var fc = bodyfatChunks[fi];
        var fData = await budgetedFitGet("/1/user/-/body/log/fat/date/" + fc.start + "/" + fc.end + ".json");
        if (fData === null && budgetHit) { bodyfatResumeFrom = fc.start; break; }
        var fArr = (fData && fData.fat) || [];
        fArr.forEach(function(entry) {
          if (!entry.date) return;
          var pct = typeof entry.fat === "number" ? entry.fat : parseFloat(entry.fat);
          if (isNaN(pct)) return;
          bodyfatByDate[entry.date] = +pct.toFixed(2);
        });
      }
    }

    var weightWritten = 0, weightSkipped = 0, weightEmpty = 0;
    var bodyfatWritten = 0, bodyfatSkipped = 0, bodyfatEmpty = 0;
    var allBodyDates = {};
    Object.keys(weightByDate).forEach(function(d) { allBodyDates[d] = true; });
    Object.keys(bodyfatByDate).forEach(function(d) { allBodyDates[d] = true; });
    var bodyDateList = Object.keys(allBodyDates).sort();
    for (var bdi = 0; bdi < bodyDateList.length; bdi++) {
      var bdate = bodyDateList[bdi];
      var existingB = existingBody[bdate] || null;
      var newWeight = weightByDate.hasOwnProperty(bdate) ? weightByDate[bdate] : null;
      var newBf = bodyfatByDate.hasOwnProperty(bdate) ? bodyfatByDate[bdate] : null;

      var weightGapFilled = false, bfGapFilled = false;
      var effectiveWeight;
      if (existingB && existingB.weight_lbs != null) { weightSkipped++; effectiveWeight = existingB.weight_lbs; }
      else if (newWeight != null) { weightWritten++; weightGapFilled = true; effectiveWeight = newWeight; }
      else { weightEmpty++; effectiveWeight = existingB ? existingB.weight_lbs : null; }

      var effectiveBf;
      if (existingB && existingB.body_fat_pct != null) { bodyfatSkipped++; effectiveBf = existingB.body_fat_pct; }
      else if (newBf != null) { bodyfatWritten++; bfGapFilled = true; effectiveBf = newBf; }
      else { bodyfatEmpty++; effectiveBf = existingB ? existingB.body_fat_pct : null; }

      if (!weightGapFilled && !bfGapFilled) continue; // nothing new for this date

      try {
        // weight_lbs always carries the EFFECTIVE (existing-or-new) value, even
        // on a body-fat-only write — upsertBodyMetrics() recomputes bmi from
        // whatever weight_lbs is in the payload, so omitting it here would send
        // bmi:null and clobber an existing BMI. See the header comment above.
        await upsertBodyMetrics(pid, { date: bdate, weight_lbs: effectiveWeight, body_fat_pct: effectiveBf, source: "fitbit" });
      } catch (e) {
        console.error("[HistoryBackfill] body_metrics upsert failed for " + bdate + ": " + e.message);
      }
    }

    var summary = {
      success: true,
      profile_id: pid,
      range: { start_date: startDate, end_date: endDate },
      api_calls_used: apiCalls,
      max_calls: maxCalls,
      budget_hit: budgetHit,
      sleep: { written: sleepDetailWritten, skipped: sleepDetailSkipped, empty: sleepDetailEmpty, resume_from: sleepResumeFrom },
      hrv: { written: hrvWritten, skipped: hrvSkipped, empty: hrvEmpty, resume_from: hrvResumeFrom },
      rhr: { written: rhrWritten, skipped: rhrSkipped, empty: rhrEmpty, resume_from: rhrResumeFrom },
      steps: { written: stepsWritten, skipped: stepsSkipped, empty: stepsEmpty, resume_from: stepsResumeFrom },
      weight: { written: weightWritten, skipped: weightSkipped, empty: weightEmpty, resume_from: weightResumeFrom },
      bodyfat: { written: bodyfatWritten, skipped: bodyfatSkipped, empty: bodyfatEmpty, resume_from: bodyfatResumeFrom },
    };
    console.log("[HistoryBackfill] profile=" + pid + " range=" + startDate + ".." + endDate +
      " apiCalls=" + apiCalls + "/" + maxCalls + " budgetHit=" + budgetHit +
      " sleep(w/s/e)=" + sleepDetailWritten + "/" + sleepDetailSkipped + "/" + sleepDetailEmpty +
      " hrv(w/s/e)=" + hrvWritten + "/" + hrvSkipped + "/" + hrvEmpty +
      " rhr(w/s/e)=" + rhrWritten + "/" + rhrSkipped + "/" + rhrEmpty +
      " steps(w/s)=" + stepsWritten + "/" + stepsSkipped +
      " weight(w/s/e)=" + weightWritten + "/" + weightSkipped + "/" + weightEmpty +
      " bodyfat(w/s/e)=" + bodyfatWritten + "/" + bodyfatSkipped + "/" + bodyfatEmpty);
    res.json(summary);
  } catch (e) {
    console.error("[HistoryBackfill] fatal error:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── WGER EXERCISE CATALOG SEED (2026-07-16) ───────────────────────────────
// wger.de is a free, keyless, open (CC-BY-SA 4.0) exercise database — see
// https://wger.de/api/v2/. Replaces the MuscleWiki seed below, which was
// built across two sessions but never actually run (its API requires a paid
// $10/mo key that was never obtained) — retired rather than kept dormant,
// per audit. musclewiki_id is kept on the table as a future MuscleWiki
// VIDEO-streaming layer (paid-user/beta stage, see ROADMAP.md §7) is a
// separate concern from data seeding. wger's CC-BY-SA license requires
// attribution — see public/index.html Profile tab footer.
//
// Confirmed live before writing this (not from memory/docs): the
// `exerciseinfo` endpoint (NOT the bare `exercise` list, which omits names
// entirely) returns each exercise base FULLY denormalized in one call —
// category, muscles, muscles_secondary, equipment, and a translations[]
// array (one entry per language, each with its own name + aliases[]) — so,
// unlike MuscleWiki's list-then-per-item-detail split, no separate throttled
// detail fetch is needed here. 842 total exercises as of this session.
//
// wger's reference vocab (category/muscle/equipment) is small (8/15/11
// entries) and stable by id — confirmed live via GET /api/v2/exercisecategory,
// /muscle, /equipment and hardcoded here rather than re-fetched every run.
// Mapped onto THIS APP'S existing conventions (not wger's raw vocab) so
// seeded rows integrate with what's already there:
//   category -> exercise_catalog.category's real enum. wger is a pure
//   gym-exercise database (no martial_arts/sports/mind_body/rehab) — every
//   category maps to 'strength' except Cardio.
var WGER_CATEGORY_MAP = {
  10: "strength", // Abs
  8: "strength",  // Arms
  12: "strength", // Back
  14: "strength", // Calves
  15: "cardio",   // Cardio
  11: "strength", // Chest
  9: "strength",  // Legs
  13: "strength", // Shoulders
};
//   muscle -> the SAME muscle-group vocabulary MUSCLE_GROUP_MAP already uses
//   (chest/back/shoulders/biceps/triceps/core/glutes/quads/hamstrings/
//   calves/grip_forearms) — required so wger-seeded rows work with the
//   existing week-preview recovery scorer and phase-2 rollups identically to
//   every other row. wger has no dedicated grip/forearm muscle, so that
//   group is never populated from this map — accurate, not a gap.
var WGER_MUSCLE_MAP = {
  1: "biceps",      // Biceps brachii
  2: "shoulders",   // Anterior deltoid
  3: "chest",       // Serratus anterior (closest major group; approximation)
  4: "chest",       // Pectoralis major
  5: "triceps",     // Triceps brachii
  6: "core",        // Rectus abdominis
  7: "calves",      // Gastrocnemius
  8: "glutes",      // Gluteus maximus
  9: "back",        // Trapezius (grouped with back; approximation)
  10: "quads",      // Quadriceps femoris
  11: "hamstrings", // Biceps femoris
  12: "back",       // Latissimus dorsi
  13: "biceps",     // Brachialis (elbow flexor, grouped with biceps)
  14: "core",       // Obliquus externus abdominis
  15: "calves",     // Soleus
};
//   equipment -> light label cleanup only (not a controlled vocabulary
//   elsewhere in the app, so this is cosmetic, not semantic mapping).
var WGER_EQUIPMENT_MAP = {
  1: "Barbell", 2: "EZ-Bar", 3: "Dumbbell", 4: "Mat", 5: "Swiss Ball",
  6: "Pull-Up Bar", 7: "Bodyweight", 8: "Bench", 9: "Incline Bench",
  10: "Kettlebell", 11: "Resistance Band",
};
function wgerMapMuscles(list) {
  return (Array.isArray(list) ? list : [])
    .map(function(m) { return WGER_MUSCLE_MAP[m.id]; })
    .filter(function(g, i, arr) { return g && arr.indexOf(g) === i; }); // dedup
}
function wgerMapEquipment(list) {
  return (Array.isArray(list) ? list : [])
    .map(function(e) { return WGER_EQUIPMENT_MAP[e.id] || e.name; })
    .filter(function(g, i, arr) { return g && arr.indexOf(g) === i; });
}

// POST /api/debug/seed-exercise-catalog?secret=ADMIN_SECRET&max_calls=N
// One-time (re-runnable), idempotent bulk seed of exercise_catalog from
// wger.de — no key required. `max_calls` caps how many exercises are
// actually WRITTEN this run (default 1000, comfortably covers the full
// ~842) — not pages, so a small value (`?max_calls=10`) is a safe dry run
// without needing partial-run bookkeeping (a re-run just refreshes already-
// written rows via wger_id and continues, see below).
//
// MERGE-SAFE against everything already in the catalog (critical — these
// rows are already referenced by real exercises.name history, e.g. "Bicep
// Curl", "Dumbbell Curl", "Close Grip Push-Up", "Hang Clean" all predate
// this seed). For each wger exercise, checked in this order:
//   1. An existing row already has this EXACT wger_id (a re-run) -> REFRESH
//      that row's muscle/equipment/family data only where currently empty,
//      union any new aliases. canonical_name untouched.
//   2. Else the wger name or any of its aliases normalizes (catalogNormKey —
//      the SAME normalization save-time matching uses) to an EXISTING row's
//      canonical_name or an existing alias -> MERGE: fill only EMPTY fields
//      (family, muscle_groups_primary/secondary, equipment), union aliases
//      (deduped), set wger_id. The existing canonical_name and its current
//      aliases WIN — never overwritten. Only rows that don't already have
//      their OWN wger_id are eligible merge targets (keeps wger_id 1:1).
//   3. Else INSERT a new source:'wger' row.
// Every merge decision (case 2) is returned in full in `merges` — the
// case that actually needs a human to be able to check it; inserts/
// refreshes are summarized by count only (up to ~800 of them, and low-risk
// by construction — a fresh row, never overwriting anything).
app.post("/api/debug/seed-exercise-catalog", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var maxCalls = req.query.max_calls ? parseInt(req.query.max_calls, 10) : 1000;
    var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

    // Capped-retry-with-backoff for non-2xx responses (rate limits, 5xx) —
    // the global fetch() override (top of this file) already retries bare
    // transient network errors for GETs; this adds the higher-level layer
    // that wrapper doesn't cover. Non-fatal: returns null after exhausting
    // attempts so one bad page never aborts the whole run.
    async function wgerGet(url) {
      var delays = [500, 1000, 2000];
      for (var attempt = 0; attempt <= delays.length; attempt++) {
        try {
          var r = await fetch(url);
          if (r.ok) return await r.json();
          if (attempt === delays.length) {
            console.error("[WgerSeed] " + url + " failed after retries: " + r.status);
            return null;
          }
        } catch (e) {
          if (attempt === delays.length) {
            console.error("[WgerSeed] " + url + " threw after retries:", e.message);
            return null;
          }
        }
        await sleep(delays[attempt]);
      }
      return null;
    }

    // Load current catalog once — same shape fetchExerciseCatalogForMatching
    // uses, plus wger_id for the re-run refresh path.
    var existingR = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?select=id,canonical_name,aliases,family,muscle_groups_primary,muscle_groups_secondary,equipment,wger_id&limit=10000", { headers: sbHeaders() });
    var existingRows = await existingR.json();
    if (!Array.isArray(existingRows)) {
      return res.status(500).json({ success: false, error: "exercise_catalog table not reachable — has migrations/2026-07-15_exercise_catalog.sql been run?" });
    }
    var byWgerId = {};
    existingRows.forEach(function(r) { if (r.wger_id) byWgerId[r.wger_id] = r; });

    // Phase 1: fetch every exercise, paginated, ~1/sec between PAGE fetches
    // (the only throttled network call — each page is already fully
    // detailed, no separate per-item fetch, unlike the old MuscleWiki seed).
    var allItems = [];
    var offset = 0, limit = 100, pageCalls = 0;
    while (true) {
      var page = await wgerGet("https://wger.de/api/v2/exerciseinfo/?format=json&language=2&limit=" + limit + "&offset=" + offset);
      pageCalls++;
      if (!page || !Array.isArray(page.results)) break;
      allItems = allItems.concat(page.results);
      if (!page.next) break;
      offset += limit;
      await sleep(1000); // ~1/sec throttle, be a good citizen to a free public API
    }

    var fetched = 0, inserted = 0, refreshed = 0, mergedCount = 0, skipped = 0, errors = 0;
    var merges = [];
    var i = 0;

    for (; i < allItems.length && (inserted + refreshed + mergedCount) < maxCalls; i++) {
      var item = allItems[i];
      try {
        var translations = Array.isArray(item.translations) ? item.translations : [];
        var en = translations.find(function(t) { return t.language === 2; });
        if (!en || !en.name) { skipped++; continue; } // no English translation — nothing to seed
        fetched++;

        var wgerName = en.name.trim();
        var wgerAliases = (Array.isArray(en.aliases) ? en.aliases : [])
          .map(function(a) { return a.alias; }).filter(Boolean);
        var wgerId = String(item.id);
        var category = WGER_CATEGORY_MAP[item.category && item.category.id] || "strength";
        var primaryMuscles = wgerMapMuscles(item.muscles);
        var secondaryMuscles = wgerMapMuscles(item.muscles_secondary);
        var equipment = wgerMapEquipment(item.equipment);
        // Same family heuristic the old MuscleWiki seed used: strip a
        // leading modifier so "Incline Push Up"/"Decline Push Up" group
        // under "Push Up" (phase-2 consumption only, not load-bearing now).
        var family = wgerName.replace(/^(incline|decline|close[\s-]grip|wide[\s-]grip|narrow|reverse|single[\s-]arm|banded|assisted|weighted)\s+/i, "").trim() || wgerName;

        // 1. Re-run refresh — this exact wger item already has a row.
        if (byWgerId[wgerId]) {
          var existingByWger = byWgerId[wgerId];
          var refreshAliases = (existingByWger.aliases || []).slice();
          wgerAliases.concat([wgerName]).forEach(function(a) {
            var k = catalogNormKey(a);
            if (k && k !== catalogNormKey(existingByWger.canonical_name) && !refreshAliases.some(function(x) { return catalogNormKey(x) === k; })) refreshAliases.push(a);
          });
          await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + existingByWger.id, {
            method: "PATCH",
            headers: sbHeaders("return=minimal"),
            body: JSON.stringify({
              aliases: refreshAliases,
              family: existingByWger.family || family,
              muscle_groups_primary: (existingByWger.muscle_groups_primary && existingByWger.muscle_groups_primary.length) ? existingByWger.muscle_groups_primary : primaryMuscles,
              muscle_groups_secondary: (existingByWger.muscle_groups_secondary && existingByWger.muscle_groups_secondary.length) ? existingByWger.muscle_groups_secondary : secondaryMuscles,
              equipment: (existingByWger.equipment && existingByWger.equipment.length) ? existingByWger.equipment : equipment,
              updated_at: new Date().toISOString(),
            }),
          });
          refreshed++;
          continue;
        }

        // 2. Textual collision against an existing (pre-wger, or not-yet-
        // wger-tagged) row — MERGE, never duplicate. Checks the wger name
        // AND every wger alias against each candidate row's canonical_name
        // + aliases. Rows that already have their OWN wger_id are excluded
        // so wger_id stays 1:1 with a catalog row.
        var candidateKeys = [catalogNormKey(wgerName)].concat(wgerAliases.map(catalogNormKey));
        var collision = existingRows.find(function(row) {
          if (row.wger_id) return false;
          var rowKeys = [catalogNormKey(row.canonical_name)].concat((row.aliases || []).map(catalogNormKey));
          return candidateKeys.some(function(k) { return k && rowKeys.indexOf(k) >= 0; });
        });

        if (collision) {
          var newAliases = (collision.aliases || []).slice();
          candidateKeys.forEach(function(k, idx) {
            var raw = idx === 0 ? wgerName : wgerAliases[idx - 1];
            if (k && k !== catalogNormKey(collision.canonical_name) && !newAliases.some(function(x) { return catalogNormKey(x) === k; })) newAliases.push(raw);
          });
          var mergePatch = { aliases: newAliases, wger_id: wgerId, updated_at: new Date().toISOString() };
          // Fill-empty-only — existing curated data always wins.
          if (!collision.family) mergePatch.family = family;
          if (!collision.muscle_groups_primary || !collision.muscle_groups_primary.length) mergePatch.muscle_groups_primary = primaryMuscles;
          if (!collision.muscle_groups_secondary || !collision.muscle_groups_secondary.length) mergePatch.muscle_groups_secondary = secondaryMuscles;
          if (!collision.equipment || !collision.equipment.length) mergePatch.equipment = equipment;
          await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + collision.id, {
            method: "PATCH",
            headers: sbHeaders("return=minimal"),
            body: JSON.stringify(mergePatch),
          });
          collision.wger_id = wgerId; // keep local cache consistent for later iterations
          collision.aliases = newAliases;
          mergedCount++;
          merges.push({ wger_name: wgerName, matched_canonical_name: collision.canonical_name, decision: "merged" });
        } else {
          var insRes = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog", {
            method: "POST",
            headers: sbHeaders("return=representation"),
            body: JSON.stringify({
              canonical_name: wgerName,
              aliases: wgerAliases,
              family: family,
              muscle_groups_primary: primaryMuscles,
              muscle_groups_secondary: secondaryMuscles,
              equipment: equipment,
              category: category,
              is_duration_based: false,
              source: "wger",
              wger_id: wgerId,
            }),
          });
          if (insRes.ok) {
            var insRows = await insRes.json();
            var insRow = Array.isArray(insRows) ? insRows[0] : insRows;
            if (insRow) { existingRows.push(insRow); byWgerId[wgerId] = insRow; }
            inserted++;
          } else {
            errors++;
            console.error("[WgerSeed] insert failed for '" + wgerName + "':", await insRes.text());
          }
        }
      } catch (e) {
        errors++;
        console.error("[WgerSeed] item failed:", e.message);
      }
    }

    res.json({
      success: true,
      status: "ran",
      total_listed: allItems.length,
      fetched: fetched,
      inserted: inserted,
      merged: mergedCount,
      refreshed: refreshed,
      skipped: skipped,
      errors: errors,
      page_api_calls: pageCalls,
      remaining_after_this_run: Math.max(0, allItems.length - i),
      merges: merges,
      category_map: WGER_CATEGORY_MAP,
      muscle_map: WGER_MUSCLE_MAP,
      equipment_map: WGER_EQUIPMENT_MAP,
    });
  } catch (e) {
    console.error("[WgerSeed] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Sanitize wger description HTML to a strict, attribute-free tag allowlist so
// the stored value is safe to render with a plain innerHTML later (no runtime
// sanitizer dependency). Keeps only p/ul/ol/li/br/strong/b/em/i; strips ALL
// attributes and every other tag (retaining inner text); drops script/style
// blocks entirely. Because no attributes ever survive, no event handlers or
// javascript: URIs can pass through. Returns null for empty/text-less input.
function sanitizeWgerHtml(html) {
  if (!html) return null;
  var s = String(html);
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ""); // drop these tag+contents
  var ALLOWED = { p: 1, ul: 1, ol: 1, li: 1, br: 1, strong: 1, b: 1, em: 1, i: 1 };
  s = s.replace(/<\/?([a-zA-Z0-9]+)\b[^>]*?>/g, function(m, name) {
    var lower = String(name).toLowerCase();
    if (!ALLOWED[lower]) return "";                 // non-allowed tag → drop, keep inner text
    if (lower === "br") return "<br>";
    return (/^<\//.test(m) ? "</" : "<") + lower + ">"; // bare, attribute-free tag
  });
  s = s.replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
  var textOnly = s.replace(/<[^>]+>/g, "").trim();
  return textOnly.length ? s : null;
}

// POST /api/debug/seed-exercise-content?secret=ADMIN_SECRET&max_calls=N&force=1
// Populates exercise_catalog.description + images from wger's exerciseinfo API,
// matched to our rows by the wger_id we already store (UPDATE only — no name
// matching, no inserts). Fill-if-null by default (idempotent / re-runnable);
// ?force=1 overwrites. VIDEO is out of scope (never read). Requires the
// 2026-07-17_exercise_catalog_content.sql migration (adds the two columns).
// Same bulk-fetch shape as seed-exercise-catalog (~9 pages @ limit=100,
// ~1 req/sec, capped retry). Returns real coverage counts.
app.post("/api/debug/seed-exercise-content", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var force = req.query.force === "1" || req.query.force === "true";
    var maxCalls = req.query.max_calls ? parseInt(req.query.max_calls, 10) : 2000;
    var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

    async function wgerGet(url) {
      var delays = [500, 1000, 2000];
      for (var attempt = 0; attempt <= delays.length; attempt++) {
        try {
          var r = await fetch(url);
          if (r.ok) return await r.json();
          if (attempt === delays.length) { console.error("[WgerContent] " + url + " failed: " + r.status); return null; }
        } catch (e) {
          if (attempt === delays.length) { console.error("[WgerContent] " + url + " threw:", e.message); return null; }
        }
        await sleep(delays[attempt]);
      }
      return null;
    }

    // Load our wger-linked rows (only these can be matched by wger_id). Select
    // description/images too so fill-if-null can skip already-populated rows.
    var existingR = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?select=id,canonical_name,wger_id,description,images&wger_id=not.is.null&limit=10000", { headers: sbHeaders() });
    var existingRows = await existingR.json();
    if (!Array.isArray(existingRows)) {
      return res.status(500).json({ success: false, error: "exercise_catalog not reachable, or the content migration (description/images columns) hasn't been run" });
    }
    var byWgerId = {};
    existingRows.forEach(function(r) { if (r.wger_id) byWgerId[String(r.wger_id)] = r; });

    // Fetch every wger English exercise (paginated).
    var allItems = [], offset = 0, limit = 100, pageCalls = 0;
    while (true) {
      var page = await wgerGet("https://wger.de/api/v2/exerciseinfo/?format=json&language=2&limit=" + limit + "&offset=" + offset);
      pageCalls++;
      if (!page || !Array.isArray(page.results)) break;
      allItems = allItems.concat(page.results);
      if (!page.next) break;
      offset += limit;
      await sleep(1000);
    }

    var wgerLinkedRows = existingRows.length;
    var matched = 0, descriptions_written = 0, images_written = 0;
    var skipped_have_content = 0, wger_had_no_content = 0, writes = 0, errors = 0;

    for (var i = 0; i < allItems.length && writes < maxCalls; i++) {
      var item = allItems[i];
      var row = byWgerId[String(item.id)];
      if (!row) continue; // wger exercise we didn't seed into the catalog — skip
      matched++;
      try {
        var translations = Array.isArray(item.translations) ? item.translations : [];
        var en = translations.find(function(t) { return t.language === 2; }) || translations[0] || {};
        var desc = sanitizeWgerHtml(en.description);
        var images = (Array.isArray(item.images) ? item.images : [])
          .filter(function(im) { return im && im.image; })
          .map(function(im) { return { url: im.image, is_main: !!im.is_main, license_author: im.license_author || null }; });

        var patch = {};
        var haveDesc = row.description != null && String(row.description).trim() !== "";
        var haveImgs = Array.isArray(row.images) && row.images.length > 0;
        if (desc && (force || !haveDesc)) patch.description = desc;
        if (images.length && (force || !haveImgs)) patch.images = images;

        if (!desc && !images.length) { wger_had_no_content++; continue; }
        if (!Object.keys(patch).length) { skipped_have_content++; continue; } // wger had content but row already populated

        var pr = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + row.id, {
          method: "PATCH",
          headers: sbHeaders("return=minimal"),
          body: JSON.stringify(patch),
        });
        if (!pr.ok) { errors++; console.error("[WgerContent] PATCH " + row.id + " failed: " + pr.status); continue; }
        writes++;
        if (patch.description) descriptions_written++;
        if (patch.images) images_written++;
      } catch (e) {
        errors++;
        console.error("[WgerContent] row " + (row && row.id) + " threw:", e.message);
      }
    }

    console.log("[WgerContent] wger_linked_rows=" + wgerLinkedRows + " matched=" + matched +
      " desc_written=" + descriptions_written + " img_written=" + images_written +
      " skipped_have=" + skipped_have_content + " wger_no_content=" + wger_had_no_content +
      " errors=" + errors + " pages=" + pageCalls + " force=" + force);
    res.json({
      success: true,
      force: force,
      wger_english_total: allItems.length,
      our_wger_linked_rows: wgerLinkedRows,
      matched_to_wger: matched,
      descriptions_written: descriptions_written,
      images_written: images_written,
      skipped_already_populated: skipped_have_content,
      wger_had_no_content: wger_had_no_content,
      errors: errors,
      page_api_calls: pageCalls,
    });
  } catch (e) {
    console.error("[WgerContent] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/debug/seed-exercise-variations?secret=ADMIN_SECRET&max_calls=N&force=1
// Populates exercise_catalog.variation_group from wger's exerciseinfo API,
// matched to our rows by wger_id (UPDATE only — no name matching, no inserts).
// wger's OWN grouping key: each item carries a `variation_group` UUID; items
// sharing it are variants of each other. We store that UUID verbatim and
// resolve siblings at READ time (see GET /api/profiles/:id/exercises/:name) so
// merges/renames/deletes self-heal — mirroring the source model rather than
// denormalizing an id-array. Fill-if-null by default (idempotent); ?force=1
// overwrites. Requires the 2026-07-18_exercise_catalog_variation_group.sql
// migration (adds the column). Same bulk-fetch shape as the content seed.
app.post("/api/debug/seed-exercise-variations", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var force = req.query.force === "1" || req.query.force === "true";
    var maxCalls = req.query.max_calls ? parseInt(req.query.max_calls, 10) : 2000;
    var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

    async function wgerGet(url) {
      var delays = [500, 1000, 2000];
      for (var attempt = 0; attempt <= delays.length; attempt++) {
        try {
          var r = await fetch(url);
          if (r.ok) return await r.json();
          if (attempt === delays.length) { console.error("[WgerVar] " + url + " failed: " + r.status); return null; }
        } catch (e) {
          if (attempt === delays.length) { console.error("[WgerVar] " + url + " threw:", e.message); return null; }
        }
        await sleep(delays[attempt]);
      }
      return null;
    }

    // Only wger-linked rows can be matched by wger_id. Select variation_group
    // so fill-if-null can skip already-populated rows — this SELECT is also the
    // migration guard: if the column doesn't exist the query errors and we bail
    // with a clear message rather than silently writing nothing.
    var existingR = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?select=id,canonical_name,wger_id,variation_group&wger_id=not.is.null&limit=10000", { headers: sbHeaders() });
    var existingRows = await existingR.json();
    if (!Array.isArray(existingRows)) {
      return res.status(500).json({ success: false, error: "exercise_catalog not reachable, or the variation_group migration (2026-07-18_exercise_catalog_variation_group.sql) hasn't been run" });
    }
    var byWgerId = {};
    existingRows.forEach(function(r) { if (r.wger_id) byWgerId[String(r.wger_id)] = r; });

    var allItems = [], offset = 0, limit = 100, pageCalls = 0;
    while (true) {
      var page = await wgerGet("https://wger.de/api/v2/exerciseinfo/?format=json&language=2&limit=" + limit + "&offset=" + offset);
      pageCalls++;
      if (!page || !Array.isArray(page.results)) break;
      allItems = allItems.concat(page.results);
      if (!page.next) break;
      offset += limit;
      await sleep(1000);
    }

    var wgerLinkedRows = existingRows.length;
    var matched = 0, groups_written = 0, wger_had_no_group = 0, skipped_have_group = 0, writes = 0, errors = 0;

    for (var i = 0; i < allItems.length && writes < maxCalls; i++) {
      var item = allItems[i];
      var row = byWgerId[String(item.id)];
      if (!row) continue; // wger exercise we didn't seed — skip
      matched++;
      try {
        var vg = item.variation_group != null ? String(item.variation_group) : null;
        if (!vg) { wger_had_no_group++; continue; } // wger item has no variation group (~78% of items)
        var haveVg = row.variation_group != null && String(row.variation_group).trim() !== "";
        if (haveVg && !force) { skipped_have_group++; continue; }

        var pr = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + row.id, {
          method: "PATCH",
          headers: sbHeaders("return=minimal"),
          body: JSON.stringify({ variation_group: vg }),
        });
        if (!pr.ok) { errors++; console.error("[WgerVar] PATCH " + row.id + " failed: " + pr.status); continue; }
        writes++;
        groups_written++;
      } catch (e) {
        errors++;
        console.error("[WgerVar] row " + (row && row.id) + " threw:", e.message);
      }
    }

    console.log("[WgerVar] wger_linked=" + wgerLinkedRows + " matched=" + matched +
      " groups_written=" + groups_written + " skipped_have=" + skipped_have_group +
      " wger_no_group=" + wger_had_no_group + " errors=" + errors + " pages=" + pageCalls + " force=" + force);
    res.json({
      success: true,
      force: force,
      wger_english_total: allItems.length,
      our_wger_linked_rows: wgerLinkedRows,
      matched_to_wger: matched,
      variation_groups_written: groups_written,
      skipped_already_populated: skipped_have_group,
      wger_had_no_group: wger_had_no_group,
      errors: errors,
      page_api_calls: pageCalls,
    });
  } catch (e) {
    console.error("[WgerVar] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/debug/exercise-canonicalization-report/:userId?secret=ADMIN_SECRET
// Part 5 (reviewed backfill, NOT auto-applied): a Haiku pass over every
// DISTINCT historical exercises.name value for one profile, proposing a
// variants -> canonical mapping. Reuses resolveExerciseCatalog() — the EXACT
// SAME function save-time matching calls — rather than a separate
// reimplementation, so the backfill proposal can never disagree with what a
// fresh save would resolve to today. Output is a human-reviewable grouped
// report (variant names + row counts merging into each canonical target);
// this endpoint only READS, it never writes exercises.name. The separate
// POST .../apply-exercise-canonicalization/:userId below does the actual
// rewrite, and is NOT called by this session's verification — the user
// reviews this report first.
app.get("/api/debug/exercise-canonicalization-report/:userId", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var pid = req.params.userId;
    var maxHaiku = req.query.max_haiku ? parseInt(req.query.max_haiku, 10) : 100;

    var exR = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + encodeURIComponent(pid) + "&select=name,category&limit=50000", { headers: sbHeaders() });
    var exRows = await exR.json();
    if (!Array.isArray(exRows)) exRows = [];

    var counts = {}; // raw stored name -> {count, category}
    exRows.forEach(function(e) {
      if (!e.name) return;
      if (!counts[e.name]) counts[e.name] = { count: 0, category: e.category };
      counts[e.name].count++;
    });
    var distinctNames = Object.keys(counts);

    var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
    var requestCache = {};
    var haikuCalls = 0;
    var byCanonical = {}; // canonical_name -> { total_rows, variants: [{name,count,method}] }
    var unresolved = [];

    for (var i = 0; i < distinctNames.length; i++) {
      var name = distinctNames[i];
      var willUseHaiku = false;
      // Cheap pre-check (mirrors resolveExerciseCatalog's own exact/alias/
      // fuzzy steps) just to decide whether this iteration is about to spend
      // a throttled Haiku call, so the cap below only limits Haiku usage,
      // not the free exact/alias/fuzzy majority.
      if (!requestCache.catalog) requestCache.catalog = await fetchExerciseCatalogForMatching();
      var key = catalogNormKey(name);
      var hasExact = requestCache.catalog.some(function(row) {
        return catalogNormKey(row.canonical_name) === key || (row.aliases || []).some(function(a) { return catalogNormKey(a) === key; });
      });
      if (!hasExact) {
        var bestScore = 0;
        requestCache.catalog.forEach(function(row) {
          [row.canonical_name].concat(row.aliases || []).forEach(function(n) {
            var s = levenshteinSimilarity(key, catalogNormKey(n));
            if (s > bestScore) bestScore = s;
          });
        });
        if (!(key.length >= CATALOG_FUZZY_MIN_KEY_LEN && bestScore >= CATALOG_FUZZY_MIN_SIMILARITY)) willUseHaiku = true;
      }
      if (willUseHaiku) {
        if (haikuCalls >= maxHaiku) { unresolved.push(name); continue; }
        haikuCalls++;
        if (haikuCalls > 1) await sleep(1000); // ~1/sec throttle on the Haiku-backed portion only
      }

      var resolved = await resolveExerciseCatalog(name, counts[name].category, requestCache);
      if (resolved.method === "unavailable" || resolved.method === "unmatched") {
        unresolved.push(name);
        continue;
      }
      // This is a REPORT — never actually create a custom catalog row for a
      // "would resolve as new" name; that's a real write, deferred to the
      // apply step (or a real future save) after the user reviews this.
      // resolveExerciseCatalog()'s 'custom' branch already created one via
      // createCustomCatalogEntry() above (it doesn't know it's being called
      // from a report) — this is a known, accepted side effect: the new
      // catalog row itself is harmless/inert until something actually
      // resolves to it, but flagged here rather than silently glossed over.
      var canon = resolved.canonicalName;
      if (canon === name) continue; // already correct, nothing to report
      if (!byCanonical[canon]) byCanonical[canon] = { canonical_name: canon, total_rows: 0, variants: [] };
      byCanonical[canon].total_rows += counts[name].count;
      byCanonical[canon].variants.push({ name: name, rows: counts[name].count, method: resolved.method });
    }

    var mergeList = Object.values(byCanonical).sort(function(a, b) { return b.total_rows - a.total_rows; });
    res.json({
      success: true,
      profile_id: pid,
      distinct_names_checked: distinctNames.length,
      haiku_calls_used: haikuCalls,
      unresolved: unresolved, // names Haiku couldn't confidently place — left as-is, not part of any proposed merge
      merge_list: mergeList,
      total_rows_affected: mergeList.reduce(function(s, g) { return s + g.total_rows; }, 0),
      note: "READ-ONLY report. No exercises.name rows were changed. Review merge_list, edit as needed, then POST the (possibly edited) mapping to /api/debug/apply-exercise-canonicalization/" + pid,
    });
  } catch (e) {
    console.error("[CanonicalizationReport] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/debug/apply-exercise-canonicalization/:userId?secret=ADMIN_SECRET
// Body: { mapping: [{ from_name, to_canonical_name }, ...] } — the
// (possibly hand-edited) merge_list from the GET report above, flattened to
// one entry per variant. Rewrites exercises.name for every row currently
// stored under from_name to to_canonical_name, scoped to this profile only.
// Only touches the name column — sets/reps/weight_lbs/date/workout_id/etc.
// are all preserved untouched, so everything the micro-goal tracker and
// analytics depend on survives; mgMatchesExercise/extractCanonicalFromTitle
// re-derive canonicalization from the (now-corrected) stored name at READ
// time exactly as they do for any other row, no special-casing needed.
// NOT CALLED this session — built and syntax-verified only, per explicit
// instruction to defer running it until the report above has been reviewed.
app.post("/api/debug/apply-exercise-canonicalization/:userId", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got2 = req.query.secret || req.headers["x-admin-secret"];
      if (got2 !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var pid2 = req.params.userId;
    var mapping = (req.body && Array.isArray(req.body.mapping)) ? req.body.mapping : [];
    if (!mapping.length) return res.status(400).json({ success: false, error: "mapping (array) required" });

    var results = [];
    for (var i = 0; i < mapping.length; i++) {
      var entry = mapping[i];
      if (!entry || !entry.from_name || !entry.to_canonical_name || entry.from_name === entry.to_canonical_name) {
        results.push({ from_name: entry && entry.from_name, updated: 0, skipped: true });
        continue;
      }
      try {
        var patchRes = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + encodeURIComponent(pid2) + "&name=eq." + encodeURIComponent(entry.from_name), {
          method: "PATCH",
          headers: sbHeaders("return=representation"),
          body: JSON.stringify({ name: entry.to_canonical_name }),
        });
        if (!patchRes.ok) {
          results.push({ from_name: entry.from_name, to_canonical_name: entry.to_canonical_name, updated: 0, error: await patchRes.text() });
          continue;
        }
        var patchedRows = await patchRes.json();
        results.push({ from_name: entry.from_name, to_canonical_name: entry.to_canonical_name, updated: Array.isArray(patchedRows) ? patchedRows.length : 0 });
      } catch (e) {
        results.push({ from_name: entry.from_name, to_canonical_name: entry.to_canonical_name, updated: 0, error: e.message });
      }
    }
    res.json({ success: true, profile_id: pid2, results: results, total_updated: results.reduce(function(s, r) { return s + (r.updated || 0); }, 0) });
  } catch (e) {
    console.error("[ApplyCanonicalization] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/debug/orphaned-exercises/:userId?secret=ADMIN_SECRET
// Read-only report: exercises rows for this profile whose workout_id no
// longer references an existing workouts row — the signature of the
// pre-fix DELETE /api/workouts/:id bug (deleted the workout, left its
// exercises rows behind). Report-first, delete-second — same pattern as
// the exercise-canonicalization backfill (GET report -> human review ->
// POST the reviewed ids to the cleanup endpoint below). Never writes.
app.get("/api/debug/orphaned-exercises/:userId", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var pid = req.params.userId;

    var exR = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + encodeURIComponent(pid) + "&select=id,name,date,workout_id&order=date.desc&limit=50000", { headers: sbHeaders() });
    var exercises = await exR.json();
    if (!Array.isArray(exercises)) exercises = [];

    var wR = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + encodeURIComponent(pid) + "&select=id&limit=50000", { headers: sbHeaders() });
    var workouts = await wR.json();
    var validIds = {};
    (Array.isArray(workouts) ? workouts : []).forEach(function(w) { validIds[w.id] = true; });

    // Only rows with a non-null workout_id are ever flagged — a null
    // workout_id predates that column's use, not this bug's signature, so
    // it's left alone rather than guessed at.
    var orphaned = exercises.filter(function(ex) { return ex.workout_id != null && !validIds[ex.workout_id]; });

    var groups = {};
    orphaned.forEach(function(ex) {
      var key = ex.name + "|" + ex.date;
      if (!groups[key]) groups[key] = { name: ex.name, date: ex.date, workout_id: ex.workout_id, count: 0, ids: [] };
      groups[key].count++;
      groups[key].ids.push(ex.id);
    });

    var groupList = Object.values(groups).sort(function(a, b) { return a.date < b.date ? 1 : -1; });
    res.json({
      success: true,
      profile_id: pid,
      orphaned_count: orphaned.length,
      groups: groupList,
      note: "READ-ONLY report. No rows deleted. Review groups (drop any ids you want to keep), then POST {ids:[...]} to /api/debug/delete-orphaned-exercises/" + pid,
    });
  } catch (e) {
    console.error("[OrphanedExercises] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/debug/delete-orphaned-exercises/:userId?secret=ADMIN_SECRET
// Body: { ids: [...] } — the (possibly hand-edited) id list from the GET
// report above. Re-verifies each id fresh server-side (belongs to this
// profile AND its workout_id still doesn't exist) before deleting, rather
// than trusting the caller's list blindly — same "fetch fresh, never trust
// the caller" discipline as /api/debug/exercise-catalog-merge.
app.post("/api/debug/delete-orphaned-exercises/:userId", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var pid = req.params.userId;
    var ids = (req.body && Array.isArray(req.body.ids))
      ? req.body.ids.map(function(x) { return parseInt(x, 10); }).filter(function(x) { return !isNaN(x); })
      : [];
    if (!ids.length) return res.status(400).json({ success: false, error: "ids (array) required" });

    var exR = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + encodeURIComponent(pid) + "&id=in.(" + ids.join(",") + ")&select=id,workout_id", { headers: sbHeaders() });
    var rows = await exR.json();
    if (!Array.isArray(rows)) rows = [];

    var wR = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + encodeURIComponent(pid) + "&select=id&limit=50000", { headers: sbHeaders() });
    var workouts = await wR.json();
    var validIds = {};
    (Array.isArray(workouts) ? workouts : []).forEach(function(w) { validIds[w.id] = true; });

    var toDelete = rows.filter(function(ex) { return ex.workout_id != null && !validIds[ex.workout_id]; }).map(function(ex) { return ex.id; });
    var skipped = ids.length - toDelete.length;
    if (!toDelete.length) return res.json({ success: true, deleted: 0, skipped: skipped });

    var del = await fetch(SUPABASE_URL + "/rest/v1/exercises?id=in.(" + toDelete.join(",") + ")", {
      method: "DELETE",
      headers: sbHeaders("return=minimal"),
    });
    if (!del.ok) {
      var t = await del.text();
      return res.status(del.status).json({ success: false, error: t });
    }
    res.json({ success: true, deleted: toDelete.length, skipped: skipped });
  } catch (e) {
    console.error("[DeleteOrphanedExercises] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/debug/exercise-catalog-upsert?secret=ADMIN_SECRET
// Body: { canonical_name (required), family, category, aliases, muscle_groups_primary,
//         muscle_groups_secondary, equipment, is_duration_based, source }
// Manual catalog curation utility — upserts by canonical_name (creates if
// missing, updates only the fields provided if it already exists). Added
// for the 2026-07-15 backfill review: "Dumbbell Curl" was explicitly kept
// OUT of the Bicep Curl merge (a real distinct exercise) but still needed
// its own catalog row with family:'Bicep Curl' so phase 2's rollups group
// it correctly — no existing endpoint could set `family` on a catalog row
// (createCustomCatalogEntry(), the Haiku-fallback path's own writer,
// deliberately doesn't take one — it's a save-time helper, not a curation
// tool). General-purpose enough to reuse for any future manual catalog fix,
// not a one-off script, since family/muscle-group heuristics (see the
// MuscleWiki seed's modifier-stripping guess) will predictably need
// occasional manual correction.
app.post("/api/debug/exercise-catalog-upsert", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var b = req.body || {};
    if (!b.canonical_name) return res.status(400).json({ success: false, error: "canonical_name required" });

    var existingR = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?canonical_name=eq." + encodeURIComponent(b.canonical_name) + "&select=id", { headers: sbHeaders() });
    var existingRows = await existingR.json();
    var existing = Array.isArray(existingRows) && existingRows[0];

    var fields = {};
    ["family", "category", "aliases", "muscle_groups_primary", "muscle_groups_secondary", "equipment", "is_duration_based", "source", "musclewiki_id"].forEach(function(k) {
      if (Object.prototype.hasOwnProperty.call(b, k)) fields[k] = b[k];
    });

    if (existing) {
      fields.updated_at = new Date().toISOString();
      var patchRes = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + existing.id, {
        method: "PATCH",
        headers: sbHeaders("return=representation"),
        body: JSON.stringify(fields),
      });
      if (!patchRes.ok) return res.status(patchRes.status).json({ success: false, error: await patchRes.text() });
      var patched = await patchRes.json();
      return res.json({ success: true, action: "updated", row: Array.isArray(patched) ? patched[0] : patched });
    } else {
      fields.canonical_name = b.canonical_name;
      var insRes = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog", {
        method: "POST",
        headers: sbHeaders("return=representation"),
        body: JSON.stringify(fields),
      });
      if (!insRes.ok) return res.status(insRes.status).json({ success: false, error: await insRes.text() });
      var inserted = await insRes.json();
      return res.json({ success: true, action: "created", row: Array.isArray(inserted) ? inserted[0] : inserted });
    }
  } catch (e) {
    console.error("[CatalogUpsert] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/debug/exercise-catalog/:id?secret=ADMIN_SECRET
// Removes one catalog row by id — for cleaning up a bad/test entry (e.g. a
// made-up exercise name that shouldn't live in the shared catalog). No
// cascade needed: exercises.name is a plain text column, not a foreign key
// into exercise_catalog, so deleting a catalog row never touches any
// already-saved exercise row (it just stops being a match target for
// future saves).
app.delete("/api/debug/exercise-catalog/:id", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var id = req.params.id;
    var check = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + encodeURIComponent(id) + "&select=id,canonical_name", { headers: sbHeaders() });
    var rows = await check.json();
    if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ success: false, error: "Not found" });
    var del = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + encodeURIComponent(id), {
      method: "DELETE",
      headers: sbHeaders("return=minimal"),
    });
    if (!del.ok) return res.status(del.status).json({ success: false, error: await del.text() });
    res.json({ success: true, deleted: rows[0].canonical_name });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/debug/exercise-catalog-dupes?secret=ADMIN_SECRET
// Read-only near-duplicate audit, built in direct response to the real bug
// found live post-wger-seed (see catalogNormKey()'s comment): a mid-string
// plural could let two rows both claim to be "the same exercise" without
// actually colliding under the (now-fixed) normalization. Reusable, not a
// one-off — any future seed/backfill could reintroduce fragmentation the
// same way, so this stays as a general-purpose admin tool alongside
// exercise-catalog-upsert/DELETE (which are what you'd use to actually
// resolve a cluster this reports: PATCH the winning row's aliases to
// include the loser's canonical_name + aliases, DELETE the loser).
//
// For every row, indexes BOTH its canonical_name and each of its aliases
// under catalogNormKey() into one shared map; any key that ends up
// referencing 2+ DISTINCT row ids is a cluster — same logic save-time
// matching itself uses to decide "is this the same exercise", just run
// once across the whole table instead of per-save.
app.get("/api/debug/exercise-catalog-dupes", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var r = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?select=id,canonical_name,aliases,source,family,muscle_groups_primary,muscle_groups_secondary,equipment,wger_id,musclewiki_id,created_at&order=id.asc&limit=10000", { headers: sbHeaders() });
    var rows = await r.json();
    if (!Array.isArray(rows)) return res.status(500).json({ success: false, error: "exercise_catalog table not reachable" });
    var rowById = {};
    rows.forEach(function(row) { rowById[row.id] = row; });

    var byKey = {};
    rows.forEach(function(row) {
      var ck = catalogNormKey(row.canonical_name);
      if (!byKey[ck]) byKey[ck] = [];
      byKey[ck].push({ id: row.id, canonical_name: row.canonical_name, source: row.source, via: "canonical_name", text: row.canonical_name });
      (row.aliases || []).forEach(function(a) {
        var ak = catalogNormKey(a);
        if (!ak || ak === ck) return; // an alias identical to its own row's key isn't interesting
        if (!byKey[ak]) byKey[ak] = [];
        byKey[ak].push({ id: row.id, canonical_name: row.canonical_name, source: row.source, via: "alias", text: a });
      });
    });

    var clusters = [];
    Object.keys(byKey).forEach(function(k) {
      var entries = byKey[k];
      var distinct = entries.filter(function(e, i, arr) { return arr.findIndex(function(x) { return x.id === e.id; }) === i; });
      if (distinct.length > 1) clusters.push({ key: k, rows: distinct });
    });
    // Oldest row first within a cluster is usually the "original" (lowest
    // id = created earliest) — a hint for review, not an automatic verdict;
    // the caller decides which row actually wins. Each row is enriched with
    // its FULL current data (not just the one colliding alias) so a merge
    // decision can be acted on directly via exercise-catalog-upsert without
    // a second round-trip to look up what would otherwise get clobbered.
    clusters.forEach(function(c) {
      c.rows.sort(function(a, b) { return a.id - b.id; });
      c.rows.forEach(function(entry) {
        var full = rowById[entry.id];
        entry.all_aliases = (full && full.aliases) || [];
        entry.family = full && full.family;
        entry.muscle_groups_primary = (full && full.muscle_groups_primary) || [];
        entry.muscle_groups_secondary = (full && full.muscle_groups_secondary) || [];
        entry.equipment = (full && full.equipment) || [];
        entry.wger_id = full && full.wger_id;
      });
    });

    res.json({ success: true, total_rows: rows.length, cluster_count: clusters.length, clusters: clusters });
  } catch (e) {
    console.error("[CatalogDupeScan] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/debug/exercise-catalog-merge?secret=ADMIN_SECRET
// Body: { winner_id, loser_id, retitle_canonical_name? }. Merges loser INTO
// winner for a confirmed exercise-catalog-dupes cluster. Fetches BOTH rows
// fresh from the DB rather than trusting anything the caller supplies about
// their current content — a merge command only needs to name the two rows,
// so it can never accidentally clobber data the caller didn't know about
// (the exact gap a hand-built PATCH would risk: exercise-catalog-upsert
// REPLACES the aliases array wholesale, so it needs the winner's full
// current list to union into, not overwrite).
//   - aliases: union of winner's current aliases + loser's canonical_name +
//     loser's aliases, deduped via catalogNormKey, excluding anything that
//     already matches the winner's own canonical key.
//   - family/muscle_groups_primary/secondary/equipment/wger_id: fill-EMPTY-
//     only from the loser — winner's existing data always wins on conflict.
//   - optional retitle_canonical_name renames the winner in the same call
//     (e.g. "Side bend" -> "Side Bend").
//   - loser row is deleted after the winner is successfully patched (no
//     cascade concern — exercises.name is plain text, not an FK).
// General-purpose, not a one-off — built for the wger near-dupe cleanup
// (2026-07-16) but the same shape any future duplicate cluster needs.
// Shared merge core (used by the merge endpoint AND the batched cleanup below).
// Fetches both rows fresh (never trusts caller-supplied data), unions array data
// (muscles/equipment/images) + aliases, fills description/family/wger_id only
// when the winner lacks them, deletes the loser BEFORE patching the winner (frees
// the unique wger_id), and optionally retitles the winner. Returns
// { ok, status:'merged'|'not_found'|'error', winner?, deleted_loser?, error? }.
async function mergeCatalogRowsById(winnerId, loserId, retitle) {
  if (!winnerId || !loserId || String(winnerId) === String(loserId)) return { ok: false, status: "error", error: "winner and loser must be distinct" };
  var wr = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + encodeURIComponent(winnerId) + "&select=*", { headers: sbHeaders() });
  var winner = ((await wr.json()) || [])[0];
  var lr = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + encodeURIComponent(loserId) + "&select=*", { headers: sbHeaders() });
  var loser = ((await lr.json()) || [])[0];
  if (!winner || !loser) return { ok: false, status: "not_found", error: "winner or loser row not found" };

  var winnerKey = catalogNormKey(winner.canonical_name);
  var newAliases = (winner.aliases || []).slice();
  function addAlias(text) {
    var k = catalogNormKey(text);
    if (!k || k === winnerKey) return;
    if (newAliases.some(function(a) { return catalogNormKey(a) === k; })) return;
    newAliases.push(text);
  }
  addAlias(loser.canonical_name);
  (loser.aliases || []).forEach(addAlias);

  // UNION array data across the pair — winner keeps everything it has AND absorbs
  // the loser's extras, so a merge never drops a freshly-seeded/enriched side.
  function unionArr(a, b2) {
    var out = (Array.isArray(a) ? a : []).slice();
    (Array.isArray(b2) ? b2 : []).forEach(function(x) { if (out.indexOf(x) < 0) out.push(x); });
    return out;
  }
  var patch = { aliases: newAliases, updated_at: new Date().toISOString() };
  if (!winner.family && loser.family) patch.family = loser.family; // family: winner authoritative
  var mp = unionArr(winner.muscle_groups_primary, loser.muscle_groups_primary);
  if (mp.length > (winner.muscle_groups_primary || []).length) patch.muscle_groups_primary = mp;
  var ms = unionArr(winner.muscle_groups_secondary, loser.muscle_groups_secondary);
  if (ms.length > (winner.muscle_groups_secondary || []).length) patch.muscle_groups_secondary = ms;
  var eq = unionArr(winner.equipment, loser.equipment);
  if (eq.length > (winner.equipment || []).length) patch.equipment = eq;
  var wImgs = Array.isArray(winner.images) ? winner.images : [];
  var lImgs = Array.isArray(loser.images) ? loser.images : [];
  if (lImgs.length) {
    var seenUrl = {}, mergedImgs = [];
    wImgs.concat(lImgs).forEach(function(im) { if (im && im.url && !seenUrl[im.url]) { seenUrl[im.url] = 1; mergedImgs.push(im); } });
    if (mergedImgs.length > wImgs.length) patch.images = mergedImgs;
  }
  // description: scalar prose can't merge — winner wins, loser fills only a gap.
  if ((!winner.description || !String(winner.description).trim()) && loser.description) patch.description = loser.description;
  if (!winner.wger_id && loser.wger_id) patch.wger_id = loser.wger_id;
  if (retitle && retitle !== winner.canonical_name) patch.canonical_name = retitle;

  // Delete loser BEFORE patching winner — frees a unique wger_id the winner may
  // be taking over (else both briefly hold it, tripping the unique index).
  var delRes = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + loser.id, { method: "DELETE", headers: sbHeaders("return=minimal") });
  if (!delRes.ok) return { ok: false, status: "error", error: "loser delete failed, winner untouched: " + (await delRes.text()) };
  var patchRes = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + winner.id, { method: "PATCH", headers: sbHeaders("return=representation"), body: JSON.stringify(patch) });
  if (!patchRes.ok) return { ok: false, status: "error", error: "loser " + loser.id + " deleted but winner patch failed; loser snapshot: " + JSON.stringify(loser) + " | " + (await patchRes.text()) };
  var pr = await patchRes.json();
  return { ok: true, status: "merged", winner: Array.isArray(pr) ? pr[0] : pr, deleted_loser: { id: loser.id, canonical_name: loser.canonical_name } };
}

app.post("/api/debug/exercise-catalog-merge", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var b = req.body || {};
    var out = await mergeCatalogRowsById(b.winner_id, b.loser_id, b.retitle_canonical_name);
    if (!out.ok) return res.status(out.status === "not_found" ? 404 : 400).json({ success: false, error: out.error });
    res.json({ success: true, winner: out.winner, deleted_loser: out.deleted_loser });
  } catch (e) {
    console.error("[CatalogMerge] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Curated one-off wger-noise cleanup plan (2026-07-17, session #25), reviewed
// and approved. Resolved by canonical_name at run time (no fragile ids); a
// rename whose target already exists is auto-converted to a merge.
var CATALOG_CLEANUP_PLAN = {
  // {from, to}: rename canonical_name (→ merge if `to` already exists).
  renames: [
    // HD-suffix strips (Jumping Jack HD is a collision → handled in merges).
    { from: "Bench Dips On Floor HD", to: "Bench Dips On Floor" },
    { from: "Bodyweight lunge HD", to: "Bodyweight Lunge" },
    { from: "Bodyweight Squat HD", to: "Bodyweight Squat" },
    { from: "High Knee Skips HD", to: "High Knee Skips" },
    // Foreign-language renames (the 2 with English dupes are deletes below).
    { from: "Back extensión", to: "Back Extension" },
    { from: "Elevación lateral polea", to: "Cable Lateral Raise" },
    { from: "Military Press mit SZ-Bar", to: "Military Press EZ-Bar" },
    // Abbreviation expansions (NB left as-is; Extention→Extension fixed).
    { from: "Alternative DB Gorilla rows", to: "Alternative Dumbbell Gorilla Rows" },
    { from: "Biceps Curls With SZ-bar", to: "Biceps Curls With EZ-Bar" },
    { from: "DB Cross Body Hammer Curls", to: "Dumbbell Cross Body Hammer Curls" },
    { from: "DB Underhand bench press", to: "Dumbbell Underhand Bench Press" },
    { from: "DB Upper Chest Variation", to: "Dumbbell Upper Chest Variation" },
    { from: "DB Wrist Extension", to: "Dumbbell Wrist Extension" },
    { from: "Elbows Tucked DB Bench Press", to: "Elbows Tucked Dumbbell Bench Press" },
    { from: "High-Cable Cross Tricep Extention - NB", to: "High-Cable Cross Tricep Extension - NB" },
    { from: "Incline DB Y-Raise", to: "Incline Dumbbell Y-Raise" },
    { from: "Incline OHP DB", to: "Incline Overhead Press Dumbbell" },
    { from: "Lat Pull DB", to: "Lat Pull Dumbbell" },
    { from: "Pin Bench Press BB", to: "Pin Bench Press Barbell" },
    { from: "Pin OHP", to: "Pin Overhead Press" },
    { from: "Push OHP", to: "Push Overhead Press" },
    { from: "Shoulder Raise Side and Front DB", to: "Shoulder Raise Side and Front Dumbbell" },
    { from: "Skullcrusher SZ-bar", to: "Skullcrusher EZ-Bar" },
    { from: "Upright Row, SZ-bar", to: "Upright Row, EZ-Bar" },
  ],
  // {winner, loser, retitle?}: loser merged into winner (data unioned), winner
  // optionally retitled. Order matters — the 3-way calf-raise runs sequentially.
  merges: [
    { winner: "Jumping Jack", loser: "Jumping Jack HD" },
    { winner: "Bulgarian split squats left", loser: "Bulgarian split squats right", retitle: "Bulgarian Split Squat" },
    { winner: "Split squats left", loser: "Split squats right", retitle: "Split Squat" },
    { winner: "Side split squats left", loser: "Side split squats right", retitle: "Side Split Squat" },
    { winner: "Pistol Squat", loser: "Pistol squats right" },
    { winner: "Quadruped thoracic rotation left", loser: "Quadruped thoracic rotation right", retitle: "Quadruped Thoracic Rotation" },
    { winner: "Side Plank", loser: "Side plank right" },
    { winner: "Standing biceps stretch left", loser: "Standing biceps stretch right", retitle: "Standing Biceps Stretch" },
    { winner: "Triceps stretch left", loser: "Triceps stretch right", retitle: "Triceps Stretch" },
    { winner: "Left levator scapulae stretch", loser: "Right levator scapulae stretch", retitle: "Levator Scapulae Stretch" },
    { winner: "Left neck stretch", loser: "Right neck stretch", retitle: "Neck Stretch" },
    { winner: "Calf raises, left leg", loser: "Calf raises, right leg" },
    { winner: "Calf raises, left leg", loser: "Calf raises, one legged", retitle: "Single-Leg Calf Raise" },
  ],
  deletes: [
    "Curl De Muñeca Con Barra",       // English dupe of "Barbell Wrist Curl"
    "Jalón al pecho con agarre ancho", // English dupe of "Wide-Grip Lat Pulldown"
    "Lying Dumbbell Row SS Seated Shrug", // logged superset, not a single exercise
  ],
  familyFixes: [{ name: "Dead Hang", family: "Dead Hang" }], // was "Deadhang" typo
  // Deliberately untouched (flagged, not guessed): "Kreis Press DB" + "Low-Cable
  // Cross-Over - NB" (ambiguous — "NB"/"Kreis" not confidently expandable),
  // "Kettlebell One Legged Deadlift" (a real named exercise, not l/r noise).
};

// POST /api/debug/exercise-catalog-cleanup?secret=ADMIN_SECRET[&dry_run=1]
// Runs CATALOG_CLEANUP_PLAN in one call: renames (→ merge on collision), merges
// (via mergeCatalogRowsById — unions data), deletes, family fixes. Resolves
// everything by canonical_name against a live index it maintains as it mutates,
// so it's idempotent-ish (a re-run skips already-done ops as not_found). Pass
// ?dry_run=1 to preview every resolved action without writing. Returns a full
// per-op report + final row count.
app.post("/api/debug/exercise-catalog-cleanup", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var dryRun = req.query.dry_run === "1" || req.query.dry_run === "true";

    var allR = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?select=id,canonical_name&limit=10000", { headers: sbHeaders() });
    var allRows = await allR.json();
    if (!Array.isArray(allRows)) return res.status(500).json({ success: false, error: "exercise_catalog not reachable" });
    var startCount = allRows.length;
    // Live index by normKey → {id, canonical_name}; maintained as we mutate.
    var idx = {};
    allRows.forEach(function(r) { idx[catalogNormKey(r.canonical_name)] = { id: r.id, canonical_name: r.canonical_name }; });
    var find = function(name) { return idx[catalogNormKey(name)]; };

    var report = { renamed: [], merged: [], deleted: [], family_fixed: [], not_found: [], errors: [] };

    // Renames (collision → merge).
    for (var ri = 0; ri < CATALOG_CLEANUP_PLAN.renames.length; ri++) {
      var op = CATALOG_CLEANUP_PLAN.renames[ri];
      var src = find(op.from);
      if (!src) { report.not_found.push({ action: "rename", from: op.from }); continue; }
      var tgt = find(op.to);
      if (tgt && tgt.id !== src.id) {
        // Target already exists → merge src into it (collision-safe).
        if (dryRun) { report.merged.push({ dry_run: true, via: "rename-collision", winner: op.to, loser: op.from }); continue; }
        var mres = await mergeCatalogRowsById(tgt.id, src.id, null);
        if (!mres.ok) { report.errors.push({ action: "rename→merge", from: op.from, to: op.to, error: mres.error }); continue; }
        delete idx[catalogNormKey(op.from)];
        report.merged.push({ via: "rename-collision", winner: op.to, loser: op.from });
        continue;
      }
      if (dryRun) { report.renamed.push({ dry_run: true, from: op.from, to: op.to }); continue; }
      var prn = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + src.id, {
        method: "PATCH", headers: sbHeaders("return=minimal"),
        body: JSON.stringify({ canonical_name: op.to, updated_at: new Date().toISOString() }),
      });
      if (!prn.ok) { report.errors.push({ action: "rename", from: op.from, to: op.to, error: await prn.text() }); continue; }
      delete idx[catalogNormKey(op.from)];
      idx[catalogNormKey(op.to)] = { id: src.id, canonical_name: op.to };
      report.renamed.push({ from: op.from, to: op.to });
    }

    // Merges (sequential — later ops may depend on earlier retitles).
    for (var mi = 0; mi < CATALOG_CLEANUP_PLAN.merges.length; mi++) {
      var mop = CATALOG_CLEANUP_PLAN.merges[mi];
      var w = find(mop.winner), l = find(mop.loser);
      if (!w || !l) { report.not_found.push({ action: "merge", winner: mop.winner, loser: mop.loser, winner_found: !!w, loser_found: !!l }); continue; }
      if (dryRun) { report.merged.push({ dry_run: true, winner: mop.winner, loser: mop.loser, retitle: mop.retitle || null }); continue; }
      var mr = await mergeCatalogRowsById(w.id, l.id, mop.retitle);
      if (!mr.ok) { report.errors.push({ action: "merge", winner: mop.winner, loser: mop.loser, error: mr.error }); continue; }
      delete idx[catalogNormKey(mop.loser)];
      if (mop.retitle) { delete idx[catalogNormKey(mop.winner)]; idx[catalogNormKey(mop.retitle)] = { id: w.id, canonical_name: mop.retitle }; }
      report.merged.push({ winner: mop.retitle || mop.winner, loser: mop.loser });
    }

    // Deletes.
    for (var di = 0; di < CATALOG_CLEANUP_PLAN.deletes.length; di++) {
      var dname = CATALOG_CLEANUP_PLAN.deletes[di];
      var drow = find(dname);
      if (!drow) { report.not_found.push({ action: "delete", name: dname }); continue; }
      if (dryRun) { report.deleted.push({ dry_run: true, name: dname }); continue; }
      var dres = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + drow.id, { method: "DELETE", headers: sbHeaders("return=minimal") });
      if (!dres.ok) { report.errors.push({ action: "delete", name: dname, error: await dres.text() }); continue; }
      delete idx[catalogNormKey(dname)];
      report.deleted.push({ name: dname, id: drow.id });
    }

    // Family fixes.
    for (var fi = 0; fi < CATALOG_CLEANUP_PLAN.familyFixes.length; fi++) {
      var fop = CATALOG_CLEANUP_PLAN.familyFixes[fi];
      var frow = find(fop.name);
      if (!frow) { report.not_found.push({ action: "family_fix", name: fop.name }); continue; }
      if (dryRun) { report.family_fixed.push({ dry_run: true, name: fop.name, family: fop.family }); continue; }
      var fres = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + frow.id, {
        method: "PATCH", headers: sbHeaders("return=minimal"),
        body: JSON.stringify({ family: fop.family, updated_at: new Date().toISOString() }),
      });
      if (!fres.ok) { report.errors.push({ action: "family_fix", name: fop.name, error: await fres.text() }); continue; }
      report.family_fixed.push({ name: fop.name, family: fop.family });
    }

    var finalCount = startCount;
    if (!dryRun) {
      var endR = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?select=id&limit=10000", { headers: sbHeaders() });
      var endRows = await endR.json();
      finalCount = Array.isArray(endRows) ? endRows.length : null;
    }
    res.json({
      success: true,
      dry_run: dryRun,
      start_row_count: startCount,
      final_row_count: dryRun ? null : finalCount,
      counts: {
        renamed: report.renamed.length, merged: report.merged.length,
        deleted: report.deleted.length, family_fixed: report.family_fixed.length,
        not_found: report.not_found.length, errors: report.errors.length,
      },
      left_as_is: ["Kreis Press DB", "Low-Cable Cross-Over - NB", "Kettlebell One Legged Deadlift"],
      report: report,
    });
  } catch (e) {
    console.error("[CatalogCleanup] fatal:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/debug/exercise-catalog-remove-alias?secret=ADMIN_SECRET
// Body: { id, alias }. Removes ONE alias (matched via catalogNormKey, so
// case/hyphen/space variants of the same text all match) from a row without
// touching anything else on it. The fix for a cluster that should NOT
// merge — two genuinely different exercises that happen to share an
// upstream-sourced alias, e.g. a generic movement-pattern name ("Hip
// Hinge") wrongly aliased onto one specific loaded exercise ("Good
// Morning") — same safety class as "hang clean" never silently absorbing
// into "Dead Hang" (see CLAUDE.md "Exercise Canonicalization"). No-op
// (not an error) if the alias isn't present, so it's safe to call twice.
app.post("/api/debug/exercise-catalog-remove-alias", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.headers["x-admin-secret"];
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var b = req.body || {};
    if (!b.id || !b.alias) return res.status(400).json({ success: false, error: "id and alias required" });
    var r = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + encodeURIComponent(b.id) + "&select=id,canonical_name,aliases", { headers: sbHeaders() });
    var rows = await r.json();
    var row = Array.isArray(rows) && rows[0];
    if (!row) return res.status(404).json({ success: false, error: "row not found" });
    var targetKey = catalogNormKey(b.alias);
    var remaining = (row.aliases || []).filter(function(a) { return catalogNormKey(a) !== targetKey; });
    if (remaining.length === (row.aliases || []).length) return res.json({ success: true, action: "not_present", canonical_name: row.canonical_name, aliases: row.aliases });
    var patchRes = await fetch(SUPABASE_URL + "/rest/v1/exercise_catalog?id=eq." + row.id, {
      method: "PATCH",
      headers: sbHeaders("return=representation"),
      body: JSON.stringify({ aliases: remaining, updated_at: new Date().toISOString() }),
    });
    if (!patchRes.ok) return res.status(patchRes.status).json({ success: false, error: await patchRes.text() });
    var patched = await patchRes.json();
    res.json({ success: true, action: "removed", row: Array.isArray(patched) ? patched[0] : patched });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
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
// shapes a workouts-table row (matches the "Auto-imported from..." notes
// format used elsewhere for consistency in the History tab), and inserts.
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

// Standard Fitbit HR-zone floors (bpm) — the lowest heart rate that counts as
// having ENTERED each zone. Used to estimate a peak-HR floor when a session has
// no measured/sampled peak but did record minutes in a zone. (The 4 standard
// thresholds are 108/132/163/185; 132 is the moderate/vigorous internal split
// and isn't a zone floor we estimate from.)
var FITBIT_ZONE_FLOOR = { peak: 185, vigorous: 163, moderate: 108 };

// Pull HR / calories / duration out of a workout's wearable_data JSONB blob.
// Returns nulls when the column/field is absent so everything degrades to N/A
// when no wearable is connected. peak_hr_est=true marks a zone-derived estimate
// (a lower-bound "floor") rather than a measured/sampled peak.
function wearableMetrics(wd) {
  if (!wd || typeof wd !== "object") return { minutes: null, calories: null, avg_hr: null, peak_hr: null, peak_hr_est: false };
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
  // Last resort: estimate a peak-HR floor from the highest zone the session
  // entered. zones = { fatBurn (moderate), cardio (vigorous), peak } minutes.
  var peakEst = false;
  if (peak == null && wd.zones && typeof wd.zones === "object") {
    var z = wd.zones;
    if (numOrNull(z.peak) > 0)         { peak = FITBIT_ZONE_FLOOR.peak;     peakEst = true; }
    else if (numOrNull(z.cardio) > 0)  { peak = FITBIT_ZONE_FLOOR.vigorous; peakEst = true; }
    else if (numOrNull(z.fatBurn) > 0) { peak = FITBIT_ZONE_FLOOR.moderate; peakEst = true; }
  }
  return {
    minutes: numOrNull(wd.duration_minutes),
    calories: numOrNull(wd.calories),
    avg_hr: numOrNull(wd.avg_hr),
    peak_hr: peak,
    peak_hr_est: peakEst,
  };
}
// Fallback metrics parsed from a workout's free-text notes. Historical rows
// created by the old fitbit-import endpoint (removed 2026-07-17, see
// ROADMAP.md §9) stored HR / calories / duration in the notes string ONLY —
// they never populated the wearable_data column — so without this, HR shows
// N/A for every one of those older auto-imported sessions still on file.
function notesMetrics(notes) {
  var out = { minutes: null, calories: null, avg_hr: null, peak_hr: null, peak_hr_est: false };
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
    peak_hr_est: wm.peak_hr != null ? wm.peak_hr_est : false,
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
//
// `profile` (timezone) anchors "today" via localToday() instead of the
// server's own instant — a positive-UTC-offset athlete (e.g. Sydney) whose
// morning the server clock hasn't reached yet would otherwise have the
// "not found -> check yesterday" fallback below skip an extra real day in
// the wrong direction, undercounting the streak. Passing profile:null (or
// a profile with timezone unset) falls back to UTC inside localToday(),
// so behavior is unchanged for any profile that hasn't captured one yet.
function currentStreakFromDates(dateSet, profile) {
  var streak = 0, offset = 0, check = localToday(profile, offset);
  if (!dateSet.has(check)) { offset -= 1; check = localToday(profile, offset); }
  while (dateSet.has(check)) { streak++; offset -= 1; check = localToday(profile, offset); }
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
    // Profile (timezone only) fetched alongside — used for the current-streak
    // "today" anchor below (localToday()); it doesn't gate anything else here.
    var wBase = SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + encodeURIComponent(pid) + "&order=date.asc&limit=20000";
    var wRange = allTime ? "" : "&date=gte." + prevStart + "&date=lte." + endDate;
    var profilePromise = getProfileTimezone(pid);
    var wr = await fetch(wBase + "&select=id,date,type,done,notes,wearable_activity_id,wearable_data" + wRange, { headers: sbHeaders() });
    if (!wr.ok) wr = await fetch(wBase + "&select=id,date,type,done,notes" + wRange, { headers: sbHeaders() });
    var workouts = await wr.json();
    if (!Array.isArray(workouts)) workouts = [];
    var streakProfile = await profilePromise;

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
      var totalMin = 0, totalCal = 0, calCount = 0, totalSessions = 0, hrAll = [], peakHrAll = null, peakHrAllEst = false;
      workouts.forEach(function(w) {
        if (!inWindow(w.date, lo, hi)) return;
        var cat = inferWorkoutCategoryServer(w.type);
        var wm = sessionMetrics(w);
        var minutes = wm.minutes != null ? wm.minutes : (durByWorkout[w.id] || 0);
        if (!acts[cat]) acts[cat] = { type: cat, label: CATEGORY_PRETTY_SERVER[cat] || cat, total_sessions: 0, total_minutes: 0, _calSum: 0, _calCount: 0, _hr: [], peak_hr: null, peak_hr_est: false, sessions: [] };
        var a = acts[cat];
        a.total_sessions++;
        a.total_minutes += minutes;
        if (wm.calories != null) { a._calSum += wm.calories; a._calCount++; }
        if (wm.avg_hr != null) { a._hr.push(wm.avg_hr); hrAll.push(wm.avg_hr); }
        // Track the max peak per activity + overall, carrying its estimated
        // flag. On a tie a measured value beats an estimate.
        if (wm.peak_hr != null) {
          var pk = wm.peak_hr, pkEst = wm.peak_hr_est;
          if (a.peak_hr == null || pk > a.peak_hr || (pk === a.peak_hr && a.peak_hr_est && !pkEst)) { a.peak_hr = pk; a.peak_hr_est = pkEst; }
          if (peakHrAll == null || pk > peakHrAll || (pk === peakHrAll && peakHrAllEst && !pkEst)) { peakHrAll = pk; peakHrAllEst = pkEst; }
        }
        a.sessions.push({ date: w.date, duration: minutes || null, avg_hr: wm.avg_hr, peak_hr: wm.peak_hr, peak_hr_est: wm.peak_hr_est, calories: wm.calories });
        totalMin += minutes;
        if (wm.calories != null) { totalCal += wm.calories; calCount++; }
        totalSessions++;
        if (w.done) { doneDates.add(w.date); dayOfWeek[new Date(w.date + "T12:00:00").getDay()]++; }
      });
      return { acts: acts, doneDates: doneDates, dayOfWeek: dayOfWeek, totalMin: totalMin, totalCal: totalCal, calCount: calCount, totalSessions: totalSessions, hrAll: hrAll, peakHrAll: peakHrAll, peakHrAllEst: peakHrAllEst };
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
        peak_hr_est: a.peak_hr_est,
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
      peak_hr_est: cur.peakHrAllEst,
      most_active_day_of_week: mostActiveDay,
      current_streak: currentStreakFromDates(cur.doneDates, streakProfile),
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

// GET /api/analytics/muscle-volume/:userId?days=7|30|90
// Weighted per-muscle-group training volume over a rolling window, for the
// Library Dashboard muscle heatmap (Exercise Canonicalization phase 2).
// Read-only, non-fatal: ANY failure (profile fetch, exercises fetch, catalog
// fetch) degrades to all-zero groups with a 200, matching the analytics
// endpoints' own graceful-degrade convention — never a 500 for this card.
var MUSCLE_HEATMAP_GROUPS = ["chest", "back", "shoulders", "biceps", "triceps", "core", "glutes", "quads", "hamstrings", "calves", "grip_forearms"];
app.get("/api/analytics/muscle-volume/:userId", async function(req, res) {
  var pid = req.params.userId;
  var reqDays = parseInt(req.query.days, 10);
  var windowDays = [7, 30, 90].indexOf(reqDays) >= 0 ? reqDays : 30;
  var zeroGroups = function() {
    var g = {};
    MUSCLE_HEATMAP_GROUPS.forEach(function(k) { g[k] = { weighted_sets: 0, intensity: 0 }; });
    return g;
  };
  try {
    var profile = await getProfileTimezone(pid);
    var startDate = localToday(profile, -windowDays);

    var er = await fetch(SUPABASE_URL + "/rest/v1/exercises?profile_id=eq." + encodeURIComponent(pid) +
      "&date=gte." + startDate + "&select=name,sets,date&limit=20000", { headers: sbHeaders() });
    var exRows = await er.json();
    if (!Array.isArray(exRows)) exRows = [];

    var catalogRows = await fetchExerciseCatalogWithMuscleData();
    var catalogIndex = buildCatalogMuscleIndex(catalogRows);

    var weighted = {};
    MUSCLE_HEATMAP_GROUPS.forEach(function(k) { weighted[k] = 0; });
    exRows.forEach(function(ex) {
      var match = catalogIndex[catalogNormKey(ex.name || "")];
      if (!match) return; // no catalog data for this name — contributes nothing, not an error
      var setCount = numOrNull(ex.sets) || 1;
      (match.muscle_groups_primary || []).forEach(function(g) { if (weighted.hasOwnProperty(g)) weighted[g] += setCount * 1.0; });
      (match.muscle_groups_secondary || []).forEach(function(g) { if (weighted.hasOwnProperty(g)) weighted[g] += setCount * 0.5; });
    });

    var maxWeighted = Math.max.apply(null, MUSCLE_HEATMAP_GROUPS.map(function(k) { return weighted[k]; }));
    var groups = {};
    MUSCLE_HEATMAP_GROUPS.forEach(function(k) {
      groups[k] = {
        weighted_sets: Math.round(weighted[k] * 10) / 10,
        intensity: maxWeighted > 0 ? Math.round((weighted[k] / maxWeighted) * 100) / 100 : 0,
      };
    });

    res.json({ success: true, window_days: windowDays, groups: groups });
  } catch (e) {
    console.error("[MuscleVolume] failed (non-fatal):", e.message);
    res.json({ success: true, window_days: windowDays, groups: zeroGroups() });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ENGINE v2 — PHASE 2  (feature-flagged; v1 is untouched by everything below)
// ══════════════════════════════════════════════════════════════════════════
// Read-only in this phase. The planner/autoregulator/variant endpoints arrive
// in Phases 3-5. Nothing here writes; nothing here is reachable from the v1
// client. Every date key goes through localToday()/getProfileTimezone().

/**
 * Server-side current-phase resolver for a goal roadmap.
 *
 * `rmCurrentPhase()` in public/index.html is CLIENT-only, so the planner (which
 * runs server-side) needs its own. This mirrors that resolution order rather
 * than inventing a second one:
 *   1. the near_term phase whose [start_date, end_date] window contains today
 *   2. else the LAST phase stored as status:'current' (some roadmaps carry two
 *      — see ROADMAP.md §9 D7)
 *   3. else the first phase with no end_date that has started
 *
 * ⚠ KNOWN LIVE DIVERGENCE (ROADMAP.md §9, D5). `recomputeRoadmapProgress()` and
 * `assignNearTermDates()` run at READ time and never write back, so the STORED
 * phases[] this function reads can disagree with what the Goals tab renders.
 * That divergence is exactly what let two phases sit marked 'current' for weeks.
 * This resolver therefore prefers the DATE window over the stored status, and
 * reports which basis it used so a caller can see when the two disagree.
 */
function v2CurrentPhase(roadmap, todayYmd) {
  if (!roadmap || !Array.isArray(roadmap.phases) || !roadmap.phases.length) {
    return { phase: null, basis: "no_roadmap", index: -1, disagreement: false };
  }
  var phases = roadmap.phases;
  var near = [];
  for (var i = 0; i < phases.length; i++) {
    if (phases[i] && phases[i].type === "near_term") near.push({ p: phases[i], i: i });
  }
  if (!near.length) return { phase: null, basis: "no_near_term_phases", index: -1, disagreement: false };

  var byDate = null;
  for (var j = 0; j < near.length; j++) {
    var p = near[j].p;
    if (p.start_date && p.end_date && todayYmd >= p.start_date && todayYmd <= p.end_date) {
      byDate = near[j];
      break;
    }
  }

  var byStatus = null, statusCount = 0;
  for (var k = 0; k < near.length; k++) {
    if (near[k].p.status === "current") { byStatus = near[k]; statusCount++; }
  }

  var chosen = byDate || byStatus;
  var basis = byDate ? "date_window" : (byStatus ? "stored_status" : null);

  if (!chosen) {
    for (var m = 0; m < near.length; m++) {
      var q = near[m].p;
      if (q.start_date && !q.end_date && todayYmd >= q.start_date) { chosen = near[m]; basis = "open_ended_started"; break; }
    }
  }
  if (!chosen) return { phase: null, basis: "unresolved", index: -1, disagreement: statusCount > 1 };

  return {
    phase: chosen.p,
    index: chosen.i,
    basis: basis,
    disagreement: !!(byDate && byStatus && byDate.i !== byStatus.i),
    multiple_current_stored: statusCount > 1,
    stored_current_count: statusCount,
  };
}

/**
 * GET /api/v2/audit/:profileId — admin-gated, READ-ONLY, writes nothing.
 *
 * The Phase 2 proof: assembles the progression state, the dossier the builder
 * WOULD write (never persisted here), the resolved rules sections and the
 * resolved roadmap phases, and reports character counts for each so the
 * prompt-size discipline is measurable from day one.
 *
 * ?prose=1        also runs the dossier's single small Haiku prose pass
 *                 (the ONLY thing in this endpoint that costs money).
 * ?window=N       progression window in days (default 60).
 * ?sections=a,b   subset of rule sections to render.
 */
app.get("/api/v2/audit/:profileId", async function(req, res) {
  var started = Date.now();
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.get("X-Admin-Secret");
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var pid = req.params.profileId;

    // Profile row. NOTE: this is a direct PostgREST read, deliberately NOT
    // `GET /api/profiles/:id` — that endpoint fire-and-forget PATCHes
    // profile_data via ensureGoalIds() (a read with a write side effect, see
    // ROADMAP.md §6), which must never fire from an audit path.
    // `dossier` / `dossier_updated_at` land with 2026-07-22_v2_profile_columns.sql,
    // which is applied MANUALLY and may not have been run yet. PostgREST 400s
    // an unknown column and returns an error OBJECT rather than an array — so
    // without this fallback the audit reports a misleading "Profile not found"
    // on a profile that exists. Same defensive shape the wearables providers
    // endpoint uses for needs_reconnect. (Found by running this endpoint, not
    // by reading it.)
    var baseSelect = "id,name,timezone,profile_data,gym_access,gym_type,roadmap_data";
    var v2ColumnsPresent = true;
    var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(pid) +
      "&select=" + baseSelect + ",dossier,dossier_updated_at",
      { headers: sbHeaders() });
    var prows = await pr.json();
    if (!Array.isArray(prows)) {
      v2ColumnsPresent = false;
      var pr2 = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(pid) +
        "&select=" + baseSelect, { headers: sbHeaders() });
      prows = await pr2.json();
    }
    if (!Array.isArray(prows) || !prows.length) {
      return res.status(404).json({ success: false, error: "Profile not found" });
    }
    var profileRow = prows[0];
    var pd = profileRow.profile_data || {};
    var today = localToday(profileRow);
    var engineV2 = pd.engine_v2 === true;

    var windowDays = Math.min(Math.max(parseInt(req.query.window, 10) || v2Progression.DEFAULT_WINDOW_DAYS, 7), 365);

    // Effort feedback, keyed by workout id, for the progression decisions.
    // The column may not exist yet (its migration is unrun) — degrade quietly.
    var effortByWorkoutId = {};
    try {
      var wr = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + encodeURIComponent(pid) +
        "&select=id,session_effort&limit=5000", { headers: sbHeaders() });
      var wrows = await wr.json();
      if (Array.isArray(wrows)) {
        wrows.forEach(function(w) { if (w && w.session_effort) effortByWorkoutId[w.id] = w.session_effort; });
      }
    } catch (e) {
      // session_effort column not migrated yet — not an error for this audit.
    }

    var deps = {
      fetch: fetch,
      SUPABASE_URL: SUPABASE_URL,
      sbHeaders: sbHeaders,
      localToday: localToday,
      callAISystem: callAISystem,
      MODEL_HAIKU: MODEL_HAIKU,
    };

    var progression = await v2Progression.buildProgressionState(deps, pid, {
      today: today, windowDays: windowDays, effortByWorkoutId: effortByWorkoutId,
    });

    // Reused as-is, not reimplemented (approved Phase 1 decision).
    var fullCtx = await getFullExerciseContext(pid, 90).catch(function(e) {
      console.warn("[v2Audit] getFullExerciseContext failed (non-fatal):", e.message);
      return null;
    });

    var checkins = [];
    try {
      var cr = await fetch(SUPABASE_URL + "/rest/v1/daily_checkins?profile_id=eq." + encodeURIComponent(pid) +
        "&order=date.desc&limit=14", { headers: sbHeaders() });
      var crows = await cr.json();
      if (Array.isArray(crows)) checkins = crows;
    } catch (e) { /* non-fatal */ }

    var dossierOut = await v2Dossier.buildDossier(deps, pid, {
      today: today,
      profileRow: profileRow,
      progressionState: progression,
      fullExerciseContext: fullCtx,
      checkins: checkins,
      withProse: req.query.prose === "1",
    });

    // Roadmap phase resolution, per goal that has one, plus the macro roadmap.
    var goals = Array.isArray(pd.goals) ? pd.goals : [];
    var phaseResolutions = goals.filter(function(g) { return g && g.roadmap; }).map(function(g) {
      var r = v2CurrentPhase(g.roadmap, today);
      return {
        goal: g.title, goal_id: g.id, tier: g.tier || null,
        roadmap_version: g.roadmap.version || null,
        basis: r.basis,
        disagreement: r.disagreement,
        multiple_current_stored: !!r.multiple_current_stored,
        stored_current_count: r.stored_current_count || 0,
        phase_name: r.phase ? (r.phase.name || r.phase.title || null) : null,
        phase_window: r.phase ? ((r.phase.start_date || "?") + " -> " + (r.phase.end_date || "?")) : null,
        emphasis: r.phase ? (r.phase.emphasis || null) : null,
      };
    });
    var macroPhase = profileRow.roadmap_data ? v2CurrentPhase(profileRow.roadmap_data, today) : null;

    var sections = req.query.sections ? String(req.query.sections).split(",").map(function(s) { return s.trim(); }) : null;
    var rulesText = v2Rules.renderRulesForPrompt(sections);
    var progressionText = v2Progression.renderProgressionTable(progression);
    var dossierText = v2Dossier.renderDossierForPrompt(dossierOut.dossier);

    // promptSections discipline, from day one — same pattern as the v1 client's
    // fetchAI() logging. These are the numbers that make prompt-size drift
    // visible before it becomes a truncation bug.
    var promptSections = {
      rules: rulesText.length,
      progression_table: progressionText.length,
      dossier: dossierText.length,
      dossier_serialized: dossierOut.chars,
      _total: rulesText.length + progressionText.length + dossierText.length,
      _rules_by_section: v2Rules.rulesSectionLengths(sections),
    };
    console.log("[v2Audit] profile " + pid + " (engine_v2=" + engineV2 + ") sections", JSON.stringify(promptSections));

    res.json({
      success: true,
      profile: { id: profileRow.id, name: profileRow.name, timezone: profileRow.timezone || null, engine_v2: engineV2 },
      today: today,
      elapsed_ms: Date.now() - started,
      progression: progression,
      dossier: {
        would_write: dossierOut.dossier,
        chars: dossierOut.chars,
        target_chars: v2Dossier.DOSSIER_TARGET_CHARS,
        hard_cap_chars: v2Dossier.DOSSIER_HARD_CAP_CHARS,
        prose_used: dossierOut.prose_used,
        warnings: dossierOut.warnings,
        persisted: false,
        currently_stored_at: profileRow.dossier_updated_at || null,
        storage_columns_migrated: v2ColumnsPresent,
      },
      roadmap_phases: { per_goal: phaseResolutions, macro: macroPhase },
      rendered: { rules: rulesText, progression_table: progressionText, dossier: dossierText },
      prompt_sections: promptSections,
    });
  } catch (e) {
    console.error("[v2Audit] failed:", e && e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * Shared v2 context loader — everything the planner (and later the
 * autoregulator) needs about a profile. Read-only.
 *
 * Reads the profile via direct PostgREST, NEVER `GET /api/profiles/:id`
 * (ensureGoalIds write-on-read, ROADMAP §6).
 */
async function loadV2Context(pid, opts) {
  opts = opts || {};
  var baseSelect = "id,name,timezone,profile_data,gym_access,gym_type,roadmap_data";
  // v2_daily_cache_date is REQUIRED for the nightly idempotency guard — without
  // it the guard reads undefined and every non-forced run (including every
  // hourly interval tick) does a full 2-call generation instead of a cheap
  // no-op. Found by testing: a non-force run took 25s instead of skipping.
  // v2_daily_cache (the object) is needed by the variant endpoint, which
  // transforms the autoregulated primary; v2_daily_cache_date by the nightly
  // idempotency guard. Both must be selected or their readers get undefined.
  var v2Cols = ",dossier,dossier_updated_at,v2_daily_cache,v2_daily_cache_date";
  var v2ColumnsPresent = true;
  var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(pid) +
    "&select=" + baseSelect + v2Cols, { headers: sbHeaders() });
  var prows = await pr.json();
  if (!Array.isArray(prows)) {
    v2ColumnsPresent = false;
    var pr2 = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(pid) +
      "&select=" + baseSelect, { headers: sbHeaders() });
    prows = await pr2.json();
  }
  if (!Array.isArray(prows) || !prows.length) return null;

  var profileRow = prows[0];
  var pd = profileRow.profile_data || {};
  var today = localToday(profileRow);

  var effortByWorkoutId = {};
  try {
    var wr = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + encodeURIComponent(pid) +
      "&select=id,session_effort&limit=5000", { headers: sbHeaders() });
    var wrows = await wr.json();
    if (Array.isArray(wrows)) wrows.forEach(function(w) { if (w && w.session_effort) effortByWorkoutId[w.id] = w.session_effort; });
  } catch (e) { /* session_effort migration may be unrun */ }

  var deps = {
    fetch: fetch, SUPABASE_URL: SUPABASE_URL, sbHeaders: sbHeaders,
    localToday: localToday, callAISystem: callAISystem, MODEL_HAIKU: MODEL_HAIKU,
  };

  var progression = await v2Progression.buildProgressionState(deps, pid, {
    today: today, effortByWorkoutId: effortByWorkoutId,
  });
  // Computed recency — the ONLY sanctioned source of training-history figures.
  // See buildRecencyState() for why this exists (the model fabricated a
  // "22-day gap" that was correct but underivable from its inputs).
  var recency = await v2Progression.buildRecencyState(deps, pid, { today: today })
    .catch(function(e) { return { available: false, error: e.message }; });
  var fullCtx = await getFullExerciseContext(pid, 90).catch(function() { return null; });

  var checkins = [];
  try {
    var cr = await fetch(SUPABASE_URL + "/rest/v1/daily_checkins?profile_id=eq." + encodeURIComponent(pid) +
      "&order=date.desc&limit=14", { headers: sbHeaders() });
    var crows = await cr.json();
    if (Array.isArray(crows)) checkins = crows;
  } catch (e) { /* non-fatal */ }

  var microGoals = [];
  try {
    var mr = await fetch(SUPABASE_URL + "/rest/v1/micro_goals?profile_id=eq." + encodeURIComponent(pid) +
      "&is_active=eq.true&limit=50", { headers: sbHeaders() });
    var mrows = await mr.json();
    if (Array.isArray(mrows)) microGoals = mrows;
  } catch (e) { /* non-fatal */ }

  // Prefer the STORED dossier (built nightly); rebuild only if absent, and
  // never with the prose pass on a planning path — prose is the nightly job's
  // job, not something to pay for on every plan.
  var dossierObj = profileRow.dossier || null;
  var dossierBuilt = null;
  if (!dossierObj) {
    dossierBuilt = await v2Dossier.buildDossier(deps, pid, {
      today: today, profileRow: profileRow, progressionState: progression,
      fullExerciseContext: fullCtx, checkins: checkins, withProse: false,
    });
    dossierObj = dossierBuilt.dossier;
  }

  var goals = Array.isArray(pd.goals) ? pd.goals : [];
  var phaseResolutions = goals.filter(function(g) { return g && g.roadmap; }).map(function(g) {
    var r = v2CurrentPhase(g.roadmap, today);
    return {
      goal: g.title, goal_id: g.id, tier: g.tier || null,
      basis: r.basis, disagreement: r.disagreement,
      phase_name: r.phase ? (r.phase.name || r.phase.title || null) : null,
      emphasis: r.phase ? (r.phase.emphasis || null) : null,
    };
  });

  return {
    profileRow: profileRow, profileData: pd, today: today,
    v2ColumnsPresent: v2ColumnsPresent,
    progression: progression, fullExerciseContext: fullCtx,
    checkins: checkins, microGoals: microGoals,
    dossier: dossierObj, dossierBuilt: dossierBuilt, recency: recency,
    phaseResolutions: phaseResolutions,
    engineV2: pd.engine_v2 === true,
  };
}

/**
 * POST /api/v2/plan/:profileId — admin-gated, STREAMING, Sonnet.
 *
 * Generates one training block plus a full week of planned sessions, enforces
 * the code invariants, and persists both. Streaming is required: Render kills a
 * non-streamed request at 25s and a full week of Sonnet output runs well past
 * that. Reuses the same stream helpers as daily_recs/coach_chat.
 *
 * The persistence RESULT is appended to the stream inside an
 * [[APEXCOACH_V2_PLAN_RESULT]] marker — the same server-authored-marker pattern
 * coach_chat uses for tool proposals, because once the response is streaming we
 * can no longer send a JSON body.
 *
 * ?dry_run=1  generate + validate but DO NOT persist.
 * ?start=YYYY-MM-DD  override the week start (default: the athlete's today).
 */
app.post("/api/v2/plan/:profileId", async function(req, res) {
  var started = Date.now();
  var pid = req.params.profileId;
  var controller = new AbortController();
  var streaming = false;
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.get("X-Admin-Secret");
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }

    var ctxData = await loadV2Context(pid);
    if (!ctxData) return res.status(404).json({ success: false, error: "Profile not found" });
    if (!ctxData.engineV2) {
      return res.status(400).json({ success: false, error: "profile_data.engine_v2 is not true for this profile — the planner refuses to run against a v1 profile" });
    }

    var startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.start || "")) ? String(req.query.start) : ctxData.today;
    var weekDates = v2Planner.buildWeekDates(startDate);
    var tiers = v2Planner.resolveTiers(ctxData.profileData.goals);
    var schedule = v2Planner.resolveScheduleV3(ctxData.profileData);
    var anchors = v2Planner.anchorsForWeek(schedule, weekDates);

    var rulesText = v2Rules.renderRulesForPrompt();
    var progressionText = v2Progression.renderProgressionTable(ctxData.progression);
    var recencyText = v2Progression.renderRecencyBlock(ctxData.recency);
    var dossierText = v2Dossier.renderDossierForPrompt(ctxData.dossier);

    var prompt = v2Planner.buildPlannerPrompt({
      athleteName: ctxData.profileRow.name,
      tiers: tiers, schedule: schedule, weekDates: weekDates, anchors: anchors,
      phaseResolutions: ctxData.phaseResolutions,
      dossierText: dossierText, progressionText: progressionText, recencyText: recencyText,
      microGoals: ctxData.microGoals,
      defaults: ctxData.profileData.defaults,
      rulesText: rulesText,
    });

    console.log("[v2Plan] profile " + pid + " week " + weekDates[0].date + ".." + weekDates[6].date +
      " promptSections " + JSON.stringify(prompt.sections));

    var ctx = {
      profileId: Number(pid), weekDates: weekDates, tiers: tiers,
      schedule: schedule, anchors: anchors,
    };

    // ── Stream, with a CAPPED retry (max 2 attempts total, no storms) ───────
    var MAX_ATTEMPTS = 2;
    var attempt = 0, plan = null, usage = null, wroteAny = false, rawLen = 0;
    v2StartStream(res, "v2_plan");
    streaming = true;

    // Retry on EITHER an unparseable response OR a work-floor "regenerate" flag,
    // within the same 2-attempt cap (no new retry mechanism). On the final
    // attempt whatever we have is persisted — flagged if still thin — rather than
    // looping or blocking the nightly.
    var enforced = null, lastReason = null, thinDetails = [];
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      var userMsg = prompt.user;
      if (attempt > 1) {
        if (lastReason === "thin") {
          userMsg += "\n\nRETRY: the previous plan UNDER-FILLED these sessions — the prescribed work did not occupy the stated duration: " +
            thinDetails.join("; ") + ". Add real sets / exercises / rounds so each session's SESSION WORK BUDGET is met, or shorten the session (and its segments) to an honest length. Do NOT inflate segment duration_min. Return ONLY the JSON object.";
        } else {
          userMsg += "\n\nRETRY: the previous response could not be parsed as JSON. Return ONLY the JSON object described in the output contract — no prose, no markdown fences, nothing before '{' or after '}'.";
        }
        try { res.write(": retry " + attempt + "\n\n"); } catch (e) {}
      }
      var upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL_SONNET,
          max_tokens: 8000,
          stream: true,
          system: wrapSystemWithCache(prompt.system, "v2_plan"),
          messages: [{ role: "user", content: userMsg }],
        }),
        signal: controller.signal,
        agent: anthropicStreamAgent,
      });
      if (!upstream.ok) {
        var errTxt = await upstream.text().catch(function() { return "upstream error " + upstream.status; });
        console.error("[v2Plan] upstream error " + upstream.status + ": " + errTxt.slice(0, 300));
        break;
      }
      var leg = await pumpAnthropicLeg(upstream, controller, res, "v2_plan", true);
      usage = leg.usage || usage;
      wroteAny = wroteAny || leg.wroteAny;
      rawLen = leg.legText.length;
      var candidate = v2Planner.extractPlanJSON(leg.legText);
      if (!candidate) {
        lastReason = "parse";
        console.warn("[v2Plan] attempt " + attempt + " produced unparseable JSON (" + rawLen + " chars)");
        continue;
      }
      // enforceInvariants repairs in place; the work-floor check flags "regenerate".
      var candEnforced = v2Planner.enforceInvariants(candidate, ctx);
      plan = candidate; enforced = candEnforced;   // latest good-parse plan is the persist-anyway basis
      var thin = candEnforced.violations.filter(function (v) { return v.severity === "regenerate"; });
      if (!thin.length) break;
      lastReason = "thin";
      thinDetails = thin.map(function (v) { return v.detail; });
      console.warn("[v2Plan] attempt " + attempt + ": " + thin.length + " session(s) under the work floor — " +
        (attempt < MAX_ATTEMPTS ? "regenerating" : "out of attempts, persisting flagged"));
    }

    var result;
    if (!plan) {
      result = { success: false, error: "could not parse a plan after " + attempt + " attempt(s)", attempts: attempt };
    } else {
      var shaped = v2Planner.toPersistenceShape(plan, enforced, ctx);
      var stillThin = enforced.violations.filter(function (v) { return v.severity === "regenerate"; });
      console.log("[v2Plan] invariants: " + enforced.violations.length + " violation(s), " +
        enforced.repairs.length + " repair(s), " + stillThin.length + " still under work floor after " + attempt + " attempt(s) — " + JSON.stringify(enforced.violations));

      var persisted = { block_id: null, sessions_written: 0, skipped: req.query.dry_run === "1" };
      if (req.query.dry_run !== "1") {
        persisted = await v2PersistPlan(shaped, ctx);
      }
      result = {
        success: true,
        attempts: attempt,
        regenerated_for_thinness: lastReason === "thin" || stillThin.length > 0,
        persisted_while_flagged: stillThin.length > 0,
        week: { start: weekDates[0].date, end: weekDates[6].date },
        block: shaped.block_row.block,
        sessions: shaped.session_rows,
        invariants: { violations: enforced.violations, repairs: enforced.repairs },
        persisted: persisted,
        prompt_sections: prompt.sections,
        usage: usage,
        raw_chars: rawLen,
        elapsed_ms: Date.now() - started,
      };
    }

    try {
      res.write(sseFrame("\n[[APEXCOACH_V2_PLAN_RESULT]]\n" + JSON.stringify(result) + "\n[[/APEXCOACH_V2_PLAN_RESULT]]"));
    } catch (e) {}
    finalizeAnthropicStream(res, "v2_plan", usage, wroteAny, true);
  } catch (e) {
    console.error("[v2Plan] failed:", e && e.message);
    if (streaming) {
      try { res.write(sseFrame("\n[[APEXCOACH_V2_PLAN_RESULT]]\n" + JSON.stringify({ success: false, error: e.message }) + "\n[[/APEXCOACH_V2_PLAN_RESULT]]")); } catch (e2) {}
      try { res.end(); } catch (e3) {}
    } else {
      res.status(500).json({ success: false, error: e.message });
    }
  }
});

/** Headers for a v2 SSE stream — thin wrapper so the label is consistent. */
function v2StartStream(res, label) {
  startAnthropicStreamResponse(res, label, true);
}

/**
 * Persist a generated plan. Supersedes any existing active block for the
 * profile, then writes the new block + its sessions.
 *
 * Idempotency: planned sessions are keyed UNIQUE(profile_id, date, slot), so
 * re-planning the same week must clear that window first rather than collide.
 * Clears every NON-completed row in the window (Session 9 fix). It previously
 * cleared only `status='planned'`, so a `modified` row (an autoregulated or
 * Coach-Chat-edited session) under a now-SUPERSEDED block survived as an orphan
 * and, once a few had accumulated across re-plans, collided on
 * (profile_id, date, slot) — the new plan's insert 23505'd and wrote 0 sessions.
 * A full re-plan legitimately supersedes those stale edits (they belong to the
 * block being replaced); only a genuinely `completed` row (a real logged
 * workout) is history and is preserved. The nightly job never re-plans, and the
 * Coach Chat propose→confirm→apply cycle is untouched — this only changes what a
 * full re-plan reclaims.
 */
async function v2PersistPlan(shaped, ctx) {
  var out = { block_id: null, sessions_written: 0, superseded_blocks: 0, cleared_sessions: 0, errors: [] };

  try {
    var sup = await fetch(SUPABASE_URL + "/rest/v1/training_blocks?profile_id=eq." + ctx.profileId +
      "&status=eq.active", {
        method: "PATCH", headers: sbHeaders("return=representation"),
        body: JSON.stringify({ status: "superseded", updated_at: new Date().toISOString() }),
      });
    var supRows = await sup.json();
    if (Array.isArray(supRows)) out.superseded_blocks = supRows.length;
  } catch (e) { out.errors.push("supersede: " + e.message); }

  try {
    var del = await fetch(SUPABASE_URL + "/rest/v1/planned_sessions?profile_id=eq." + ctx.profileId +
      "&date=gte." + ctx.weekDates[0].date + "&date=lte." + ctx.weekDates[6].date +
      "&status=neq.completed", { method: "DELETE", headers: sbHeaders("return=representation") });
    var delRows = await del.json();
    if (Array.isArray(delRows)) out.cleared_sessions = delRows.length;
  } catch (e) { out.errors.push("clear: " + e.message); }

  try {
    var br = await fetch(SUPABASE_URL + "/rest/v1/training_blocks", {
      method: "POST", headers: sbHeaders("return=representation"),
      body: JSON.stringify(shaped.block_row),
    });
    var brows = await br.json();
    if (!Array.isArray(brows) || !brows.length) {
      out.errors.push("block insert: " + JSON.stringify(brows).slice(0, 300));
      return out;
    }
    out.block_id = brows[0].id;
  } catch (e) { out.errors.push("block insert: " + e.message); return out; }

  try {
    var rows = shaped.session_rows.map(function(r) { return Object.assign({}, r, { block_id: out.block_id }); });
    var sr = await fetch(SUPABASE_URL + "/rest/v1/planned_sessions", {
      method: "POST", headers: sbHeaders("return=representation"),
      body: JSON.stringify(rows),
    });
    var srows = await sr.json();
    if (Array.isArray(srows)) out.sessions_written = srows.length;
    else out.errors.push("session insert: " + JSON.stringify(srows).slice(0, 400));
  } catch (e) { out.errors.push("session insert: " + e.message); }

  return out;
}

/**
 * GET /api/v2/plan/:profileId — read back the active block + its sessions,
 * AND report readiness so a caller can tell WHY a plan is missing.
 *
 * `{block:null, sessions:[]}` alone is ambiguous — it reads identically whether
 * the tables exist and are empty or the migration has not been run at all
 * (PostgREST returns an error OBJECT for a missing relation, which
 * Array.isArray() rejects the same way as an empty result). `ready` therefore
 * reports each precondition separately, so "not planned yet" is never confused
 * with "cannot plan yet".
 */
app.get("/api/v2/plan/:profileId", async function(req, res) {
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.get("X-Admin-Secret");
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var pid = req.params.profileId;

    var br = await fetch(SUPABASE_URL + "/rest/v1/training_blocks?profile_id=eq." + encodeURIComponent(pid) +
      "&status=eq.active&order=start_date.desc&limit=1", { headers: sbHeaders() });
    var brows = await br.json();
    var blocksTablePresent = Array.isArray(brows);
    var block = blocksTablePresent && brows.length ? brows[0] : null;

    var sr = await fetch(SUPABASE_URL + "/rest/v1/planned_sessions?profile_id=eq." + encodeURIComponent(pid) +
      (block ? "&block_id=eq." + block.id : "") + "&order=date.asc,slot.asc", { headers: sbHeaders() });
    var srows = await sr.json();
    var sessionsTablePresent = Array.isArray(srows);

    // Profile-side preconditions.
    var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(pid) +
      "&select=profile_data", { headers: sbHeaders() });
    var prows = await pr.json();
    var pd = (Array.isArray(prows) && prows.length && prows[0].profile_data) || {};
    var goals = Array.isArray(pd.goals) ? pd.goals : [];
    var drivers = goals.filter(function(g) { return g && g.tier === "driver"; }).length;

    var ready = {
      training_blocks_table: blocksTablePresent,
      planned_sessions_table: sessionsTablePresent,
      engine_v2_flag: pd.engine_v2 === true,
      goals_tiered: goals.filter(function(g) { return g && g.tier; }).length + "/" + goals.length,
      drivers: drivers,
      schedule_v3: !!pd.schedule_v3,
      defaults: !!pd.defaults,
    };
    ready.can_generate = blocksTablePresent && sessionsTablePresent && ready.engine_v2_flag;
    ready.will_be_meaningful = ready.can_generate && drivers > 0 && !!pd.schedule_v3;

    res.json({
      success: true,
      ready: ready,
      block: block,
      sessions: sessionsTablePresent ? srows : [],
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ENGINE v2 — PHASE 4: nightly job + autoregulator + alternate cache
// ══════════════════════════════════════════════════════════════════════════

// Concurrency lock for the nightly job — deliberately a SEPARATE map from
// _refreshLocks (the OAuth token map), same shape. The interval tick and a
// manual admin trigger must never double-generate for one profile.
var _v2Locks = {};
function withV2Lock(key, fn) {
  if (_v2Locks[key]) return _v2Locks[key];
  var p = Promise.resolve().then(fn);
  _v2Locks[key] = p;
  return p.finally(function () { if (_v2Locks[key] === p) delete _v2Locks[key]; });
}

/**
 * Run one Haiku call, non-streamed to the client (this is a server-side batch
 * job, not a user-facing request), with a capped single retry on unparseable
 * JSON. Returns { obj, usage, raw, attempts }.
 */
async function v2HaikuJSON(system, user, maxTokens, label) {
  var attempts = 0, obj = null, usage = null, raw = "";
  while (attempts < 2 && !obj) {
    attempts++;
    var u = attempts > 1 ? user + "\n\nRETRY: return ONLY the JSON object, nothing before '{' or after '}'." : user;
    var resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL_HAIKU, max_tokens: maxTokens,
        system: wrapSystemWithCache(system, label),
        messages: [{ role: "user", content: u }],
      }),
      agent: anthropicStreamAgent,
    });
    if (!resp.ok) {
      var et = await resp.text().catch(function () { return "err " + resp.status; });
      console.warn("[" + label + "] upstream " + resp.status + ": " + et.slice(0, 200));
      break;
    }
    var data = await resp.json();
    usage = data.usage || usage;
    raw = (data.content && data.content[0] && data.content[0].text) || "";
    obj = v2Autoregulator.extractJSON(raw);
  }
  return { obj: obj, usage: usage, raw: raw, attempts: attempts };
}

/**
 * Autoregulate today's planned session for one profile. Returns the adjusted
 * session + decision + the invariant/modification report. Pure orchestration —
 * all the rules live in the modules.
 */
async function v2Autoregulate(ctx) {
  var planned = ctx.plannedSession;     // the .session jsonb
  var plannedRow = ctx.plannedRow;      // the full planned_sessions row (for movable)
  var isAnchor = plannedRow && plannedRow.movable === false;

  // Yesterday's effort, and a mat-load note, from recent workouts.
  var yEffort = ctx.yesterdayEffort || null;
  var matNote = ctx.matLoadNote || null;

  var rulesText = v2Rules.renderRulesForPrompt(["readiness", "progression", "deload", "interference", "gap_decay"]);
  var prompt = v2Autoregulator.buildAutoregulatorPrompt({
    plannedSession: planned, isAnchor: isAnchor,
    readinessText: ctx.readinessText, recencyText: ctx.recencyText,
    dossierText: ctx.dossierText, progressionText: ctx.progressionText,
    yesterdayEffort: yEffort, matLoadNote: matNote, rulesText: rulesText,
  });

  console.log("[v2Autoreg] profile " + ctx.profileId + " sections " + JSON.stringify(prompt.sections));

  var res = await v2HaikuJSON(prompt.system, prompt.user, 3000, "v2_autoregulate");
  if (!res.obj || !res.obj.session) {
    // Non-fatal: fall back to the planned session UNCHANGED. Serving the plan is
    // always better than serving nothing or something invented.
    return {
      decision: "kept", why: "Autoregulator produced no usable output; today's planned session is used as written.",
      session: planned, usage: res.usage, sections: prompt.sections,
      fell_back: true, problems: [{ check: "autoregulator_output", severity: "flagged", detail: "no parseable session after " + res.attempts + " attempt(s)" }],
    };
  }

  var adjusted = res.obj.session;
  var decision = String(res.obj.decision || "kept");
  var problems = [];

  // Anchor integrity — structural, not trusting the prompt.
  if (isAnchor) {
    var ap = v2Autoregulator.assertAnchorUntouched(planned, adjusted);
    if (ap.some(function (p) { return p.severity === "rejected"; })) {
      return { decision: "kept", why: "Fixed commitment — kept exactly as planned.", session: planned, usage: res.usage, sections: prompt.sections, reverted: true, problems: ap };
    }
    problems = problems.concat(ap);
  }

  // Modification-not-replacement.
  var mod = v2Autoregulator.assertIsModification(planned, adjusted, decision);
  problems = problems.concat(mod.problems);
  if (mod.hardReject) {
    return { decision: "kept", why: "Autoregulator output was a replacement, not a modification; reverted to the planned session.", session: planned, usage: res.usage, sections: prompt.sections, reverted: true, problems: problems, retention: mod.retention };
  }

  // Reuse the Phase 3.5 invariant set on the single adjusted session.
  var enforced = v2Planner.enforceInvariants(
    { sessions: [Object.assign({}, plannedRow, { session: undefined, date: plannedRow.date, slot: plannedRow.slot, movable: plannedRow.movable, category: adjusted.category, duration_min: adjusted.duration_min, intensity: adjusted.intensity, why: adjusted.why, goal_tags: adjusted.goal_tags, segments: adjusted.segments })], block: {} },
    { profileId: ctx.profileId, weekDates: [{ date: plannedRow.date }], tiers: { goals: [] }, schedule: { fill_policy: "ai_assigned" }, anchors: [] }
  );
  var cleaned = enforced.sessions[0] || {};
  problems = problems.concat(enforced.violations);

  return {
    decision: decision,
    why: res.obj.why || adjusted.why || "adjusted",
    session: {
      category: cleaned.category, duration_min: cleaned.duration_min, intensity: cleaned.intensity,
      why: cleaned.why, goal_tags: cleaned.goal_tags, segments: cleaned.segments,
    },
    usage: res.usage, sections: prompt.sections, problems: problems, retention: mod.retention,
  };
}

/**
 * Build the <=4 alternate cache objects. Duration variants are derived in CODE
 * (the rules module's time-compression order fully determines the outcome); the
 * category swap is the ONE that needs model judgment.
 */
async function v2BuildAlternates(ctx, primarySession) {
  var out = { primary: null, alternates: [], model_calls: 0, code_derived: 0, usage: [] };

  var defaultMin = (ctx.defaults && ctx.defaults.duration_min) || 45;
  out.primary = { key: "primary", label: "As planned (" + (primarySession.duration_min || defaultMin) + " min)", source: "autoregulator", session: primarySession };

  // Neighboring durations relative to the DEFAULT (e.g. 45 -> 30 and 60), not
  // relative to today's possibly-anchored duration.
  var neighbors = [defaultMin - 15, defaultMin + 15].filter(function (m) { return m >= 15 && m !== primarySession.duration_min; });
  neighbors.forEach(function (target) {
    if (out.alternates.length >= 3) return;
    if (target < (primarySession.duration_min || defaultMin)) {
      var c = v2Autoregulator.compressSessionToDuration(primarySession, target);
      out.alternates.push({ key: "dur_" + target, label: target + " min (compressed)", source: "code:time_compression", steps: c.steps, session: c.session });
      out.code_derived++;
    } else {
      // Extending is NOT a mechanical inverse of compression (adding volume is a
      // judgment call the code should not fake). A longer variant just restates
      // the primary with a note; a real longer session is Phase 5 variant work.
      out.alternates.push({ key: "dur_" + target, label: target + " min (primary as-is; extend on request)", source: "code:noop_extend", session: Object.assign({}, primarySession) });
      out.code_derived++;
    }
  });

  // One category swap — the judgment call, now via the SHARED variant path
  // (Phase 5), not a second inline prompt. The Phase 4 inline version produced
  // nothing and wasted a call; routing through v2GenerateVariant means the swap
  // gets the same dossier/readiness context, contraindication check and
  // invariants as the user-facing endpoint. Only if there is budget for a 4th
  // object AND today is not an immovable anchor (a fixed class can't be swapped).
  if (out.alternates.length < 3 && !ctx.isAnchorToday) {
    var swapCategory = ctx.swapCategory || (primarySession.category === "strength" ? "mind_body" : (primarySession.category === "cardio" ? "strength" : "mind_body"));
    var swap = await v2GenerateVariant({
      profileId: ctx.profileId, body: { category: swapCategory }, dossier: ctx.dossierObj,
      cacheObj: null, primary: primarySession, isAnchor: false, today: ctx.today,
      readinessText: ctx.readinessText, recencyText: ctx.recencyText, dossierText: ctx.dossierText,
      stream: false,
    });
    out.model_calls++;
    if (swap.usage) out.usage.push({ call: "category_swap", usage: swap.usage });
    if (swap.session && !swap.error) {
      out.alternates.push({ key: "cat_swap", label: "Different focus: " + (swap.session.category || swapCategory), source: "model:category_swap", session: swap.session, why: swap.why, problems: swap.problems });
    } else {
      out.swap_error = swap.error || "no session";
    }
  }

  return out;
}

/**
 * Flatten the primary + alternates to renderer-ready strings and assemble the
 * cache object written to profiles.v2_daily_cache.
 */
function v2AssembleCache(alt, decision, today) {
  var flat = function (s) { return v2Planner.flattenSessionForCache(s); };
  return {
    // v:2 (Session 8) — the flatten boundary now renders duration-based segments
    // as duration blocks. A v-mismatched (or v-less) cache is treated as stale by
    // GET /api/v2/today and the client, so old-shape strings are never served.
    v: 2,
    date: today,
    generated_at: new Date().toISOString(),
    decision_tag: decision.decision,
    why: decision.why,
    // `today` is the FLATTENED display shape (sections[] of strings) that the v1
    // renderer and morning-open read. `today_session` is the STRUCTURED session
    // (segments[] with exercise objects) that the variant endpoint transforms —
    // compression and the model both need structure, not display strings.
    today: flat(decision.session),
    today_session: decision.session,
    alternates: alt.alternates.slice(0, 3).map(function (a) {
      // `rationale` is derived here from the compression steps / swap category
      // (the steps themselves are not persisted). The chip surface reads it.
      return { key: a.key, label: a.label, source: a.source, rationale: v2Autoregulator.deriveAlternateRationale(a),
        session: flat(a.session), session_structured: a.session };
    }),
  };
}

/**
 * The full nightly pipeline for ONE profile. Serialised by withV2Lock.
 * Ordering: recency -> progression -> dossier -> today's planned row ->
 * autoregulate -> alternates -> single cache write.
 */
async function v2NightlyForProfile(pid, opts) {
  opts = opts || {};
  var t0 = Date.now();
  var out = { profile_id: Number(pid), stages: {}, usage: {}, tokens: { input: 0, output: 0 } };

  return withV2Lock("nightly:" + pid, async function () {
    var ctxData = await loadV2Context(pid);
    if (!ctxData) { out.status = "error"; out.reason = "profile not found"; return out; }
    if (!ctxData.engineV2) { out.status = "skipped"; out.reason = "engine_v2 not true"; return out; }

    var today = ctxData.today;
    out.today = today;

    // Idempotency — athlete-local date, not the server's UTC date.
    if (!opts.force && ctxData.profileRow.v2_daily_cache_date === today) {
      out.status = "skipped"; out.reason = "cache already fresh for " + today;
      out.elapsed_ms = Date.now() - t0;
      return out;
    }

    var deps = { fetch: fetch, SUPABASE_URL: SUPABASE_URL, sbHeaders: sbHeaders, localToday: localToday, callAISystem: callAISystem, MODEL_HAIKU: MODEL_HAIKU };

    // recency + progression already computed in loadV2Context; readiness is new.
    var readiness = await v2Readiness.buildReadinessState(deps, pid, { today: today }).catch(function (e) { return { available: false, error: e.message }; });
    out.stages.readiness = { available: readiness.available, tag: readiness.modification && readiness.modification.tag };

    var progressionText = v2Progression.renderProgressionTable(ctxData.progression);
    var recencyText = v2Progression.renderRecencyBlock(ctxData.recency);
    var dossierText = v2Dossier.renderDossierForPrompt(ctxData.dossier);
    var readinessText = v2Readiness.renderReadinessBlock(readiness);

    // Today's planned session.
    var psr = await fetch(SUPABASE_URL + "/rest/v1/planned_sessions?profile_id=eq." + pid +
      "&date=eq." + today + "&order=slot.asc", { headers: sbHeaders() });
    var pRows = await psr.json();
    var todayRow = Array.isArray(pRows) && pRows.length ? pRows[0] : null;
    out.stages.planned_session = todayRow ? { found: true, slot: todayRow.slot, category: todayRow.session && todayRow.session.category, movable: todayRow.movable } : { found: false };

    var cacheObj, decision;
    if (!todayRow) {
      // No planned session -> explicit rest state. NEVER generate one.
      decision = { decision: "recovery", why: "No session was planned for today — this is a rest day.", session: { category: "rest", duration_min: 0, intensity: "low", why: "Rest day — nothing planned.", goal_tags: [], segments: [] } };
      cacheObj = { v: 2, date: today, generated_at: new Date().toISOString(), decision_tag: "recovery", why: decision.why, today: { category: "rest", duration_min: 0, intensity: "low", headline: "Rest day", why: decision.why, goal_tags: [], sections: [] }, alternates: [], no_planned_session: true };
      out.stages.autoregulator = { skipped: "no planned session" };
      out.stages.alternates = { skipped: "no planned session" };
    } else {
      // Yesterday's effort + mat-load.
      var yEffort = null, matNote = null;
      try {
        var yr = await fetch(SUPABASE_URL + "/rest/v1/workouts?profile_id=eq." + pid + "&date=eq." +
          v2YesterdayLocal(ctxData.profileRow) + "&select=session_effort,type", { headers: sbHeaders() });
        var yRows = await yr.json();
        if (Array.isArray(yRows) && yRows.length) {
          yEffort = yRows[0].session_effort || null;
          if (yRows.some(function (w) { return /mma|spar|bjj|grappl|jiu|kickbox|box|martial/i.test(String(w.type || "")); })) {
            matNote = "MAT LOAD: a hard combat-sports session was logged yesterday. Reduce next-day lower-body strength volume by ~2 sets and do not stack another high-CNS session today.";
          }
        }
      } catch (e) { /* non-fatal */ }

      var autoreg = await v2Autoregulate({
        profileId: pid, plannedSession: todayRow.session, plannedRow: todayRow,
        readinessText: readinessText, recencyText: recencyText, dossierText: dossierText,
        progressionText: progressionText, yesterdayEffort: yEffort, matLoadNote: matNote,
      });
      decision = autoreg;
      out.stages.autoregulator = { decision: autoreg.decision, why: autoreg.why, retention: autoreg.retention, fell_back: !!autoreg.fell_back, reverted: !!autoreg.reverted, problems: autoreg.problems, sections: autoreg.sections };
      if (autoreg.usage) { out.usage.autoregulator = autoreg.usage; out.tokens.input += autoreg.usage.input_tokens || 0; out.tokens.output += autoreg.usage.output_tokens || 0; }

      var isAnchorToday = todayRow.movable === false;
      var alt = await v2BuildAlternates({ profileId: pid, defaults: ctxData.profileData.defaults, dossierText: dossierText, dossierObj: ctxData.dossier, readinessText: readinessText, recencyText: recencyText, today: today, isAnchorToday: isAnchorToday }, decision.session);
      out.stages.alternates = { count: alt.alternates.length, model_calls: alt.model_calls, code_derived: alt.code_derived, swap_error: alt.swap_error || null, breakdown: alt.alternates.map(function (a) { return { key: a.key, source: a.source, problems: (a.problems || []).length }; }) };
      (alt.usage || []).forEach(function (u) { out.tokens.input += (u.usage.input_tokens || 0); out.tokens.output += (u.usage.output_tokens || 0); });
      out.usage.alternates = alt.usage;

      cacheObj = v2AssembleCache(alt, decision, today);
    }

    // SINGLE cache write.
    var wr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + pid, {
      method: "PATCH", headers: sbHeaders("return=minimal"),
      body: JSON.stringify({ v2_daily_cache: cacheObj, v2_daily_cache_date: today }),
    });
    out.stages.cache_write = { ok: wr.ok, status: wr.status };
    if (!wr.ok) { out.status = "error"; out.reason = "cache write failed: " + (await wr.text().catch(function () { return wr.status; })); return out; }

    out.status = "succeeded";
    out.elapsed_ms = Date.now() - t0;
    return out;
  });
}

function v2YesterdayLocal(profileRow) {
  var d = new Date(localToday(profileRow) + "T12:00:00");
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/**
 * Shared variant logic — ONE implementation used by BOTH the on-demand endpoint
 * and the nightly category-swap alternate (Phase 5 replaces Phase 4's inline
 * swap prompt that produced nothing). Resolves cache-first, then code-only,
 * then the model. Ephemeral: it NEVER writes v2_daily_cache or planned_sessions.
 *
 * @param {object} args { profileId, body, ctxData, readinessText, dossierText,
 *                        progressionText, recencyText, cacheObj, primary,
 *                        isAnchor }
 * @returns {Promise<object>} { session, why, path, refused, problems, usage,
 *                              sections, intent }
 */
async function v2GenerateVariant(args) {
  var primary = args.primary;
  var intent = v2Variant.classifyRequest(args.body || {}, primary);
  var dossier = args.ctxData ? args.ctxData.dossier : args.dossier;

  // 1. CACHE-FIRST — a pure duration swap matching a cached alternate: zero call.
  var cached = v2Variant.matchCachedAlternate(intent, args.cacheObj);
  if (cached) {
    var cCheck = v2Variant.checkVariant(cached, intent, dossier, { isAnchor: args.isAnchor });
    return { session: cached, why: "Served from today's cache — this duration was already prepared.", path: "cache", refused: false, problems: cCheck.problems, usage: null, sections: { _total: 0 }, intent: intent };
  }

  // 2. CODE-ONLY — a pure duration REDUCTION: the time-compression order fully
  //    determines it, so no model judgment is needed. An anchor can't be
  //    reshaped, so this path is skipped for an anchored session.
  if (!args.isAnchor && v2Variant.isCodeOnly(intent, primary)) {
    var comp = v2Variant.compress(primary, intent.duration_min);
    var codeCheck = v2Variant.checkVariant(comp.session, intent, dossier, { isAnchor: false });
    return {
      session: comp.session,
      why: "Shortened to ~" + intent.duration_min + " min in code: " + comp.steps.join("; ") + ". The primary compound and prehab were kept.",
      path: "code", refused: false, problems: codeCheck.problems, usage: null,
      sections: { _total: 0 }, intent: intent, steps: comp.steps,
    };
  }

  // 3. MODEL — everything else (intensity, category, style, free-text, readiness
  //    signal, or a duration increase). Streamed Haiku, small context.
  var prompt = v2Variant.buildVariantPrompt({
    intent: intent, primary: primary, isAnchor: args.isAnchor,
    readinessText: args.readinessText, recencyText: args.recencyText, dossierText: args.dossierText,
  });
  console.log("[v2Variant] profile " + args.profileId + " sections " + JSON.stringify(prompt.sections));

  var gen;
  if (args.stream && args.res) {
    // User path — stream to the client.
    var upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL_HAIKU, max_tokens: 3000, stream: true, system: wrapSystemWithCache(prompt.system, "v2_variant"), messages: [{ role: "user", content: prompt.user }] }),
      signal: args.controller.signal, agent: anthropicStreamAgent,
    });
    if (!upstream.ok) {
      var et = await upstream.text().catch(function () { return "err " + upstream.status; });
      return { error: "upstream " + upstream.status + ": " + et.slice(0, 200), path: "model", sections: prompt.sections };
    }
    var leg = await pumpAnthropicLeg(upstream, args.controller, args.res, "v2_variant", true);
    gen = { obj: v2Variant.extractJSON(leg.legText), usage: leg.usage, raw: leg.legText };
  } else {
    // Nightly path — non-streamed Haiku, capped single retry.
    gen = await v2HaikuJSON(prompt.system, prompt.user, 3000, "v2_variant");
  }

  if (!gen.obj || !gen.obj.session) {
    return { error: "no parseable variant", path: "model", usage: gen.usage, sections: prompt.sections, intent: intent };
  }

  var session = gen.obj.session;
  var refused = gen.obj.refused === true;

  // Reuse the planner's structural invariants on the single variant session.
  var enforced = v2Planner.enforceInvariants(
    { sessions: [{ date: args.today, slot: 1, movable: args.isAnchor ? false : true, category: session.category, duration_min: session.duration_min, intensity: session.intensity, why: session.why || gen.obj.why, goal_tags: session.goal_tags, segments: session.segments }], block: {} },
    { profileId: args.profileId, weekDates: [{ date: args.today }], tiers: { goals: [] }, schedule: { fill_policy: "ai_assigned" }, anchors: args.isAnchor ? [{ date: args.today, slot: 1, activity: (primary.headline || primary.category || ""), duration_min: primary.duration_min, category: primary.category }] : [] }
  );
  var cleaned = enforced.sessions.filter(function (s) { return !s._restored; })[0] || enforced.sessions[0];
  var vCheck = v2Variant.checkVariant(cleaned, intent, dossier, { isAnchor: args.isAnchor, refused: refused });

  return {
    session: { category: cleaned.category, duration_min: cleaned.duration_min, intensity: cleaned.intensity, why: cleaned.why, goal_tags: cleaned.goal_tags, segments: cleaned.segments },
    why: gen.obj.why || session.why || "adjusted",
    path: "model", refused: refused,
    problems: enforced.violations.concat(vCheck.problems),
    usage: gen.usage, sections: prompt.sections, intent: intent,
  };
}

/**
 * GET /api/v2/today/:profileId — the browser's v2 read path. PURE DB READ, no
 * model call, NOT admin-gated (it is user-facing, exactly like the v1
 * /daily-recs read). Returns the cached autoregulated session + alternates +
 * the planned week for the flagged Today UI. A non-v2 profile gets
 * {engine_v2:false} so the client can fall back to v1 without a second call.
 */
app.get("/api/v2/today/:profileId", async function (req, res) {
  try {
    var pid = req.params.profileId;
    var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(pid) +
      "&select=profile_data,timezone,v2_daily_cache,v2_daily_cache_date", { headers: sbHeaders() });
    var prows = await pr.json();
    if (!Array.isArray(prows)) {
      // v2 columns not migrated — behave as a non-v2 profile.
      return res.json({ success: true, engine_v2: false });
    }
    if (!prows.length) return res.status(404).json({ success: false, error: "Profile not found" });
    var prow = prows[0];
    var pd = prow.profile_data || {};
    if (pd.engine_v2 !== true) return res.json({ success: true, engine_v2: false });

    var today = localToday(prow);
    // Cache is fresh only if it is today's AND written by the current flatten
    // boundary (v:2, Session 8). A missing/older `v` holds old-shape display
    // strings, so it is treated as stale — same as no cache (the client shows
    // the "isn't ready yet" state until a nightly re-run rewrites it).
    var cacheVersionOk = !!(prow.v2_daily_cache && prow.v2_daily_cache.v === 2);
    var fresh = (prow.v2_daily_cache_date === today) && cacheVersionOk;

    // The planned week (active block) — pure read, same as GET /api/v2/plan.
    var block = null, sessions = [];
    try {
      var br = await fetch(SUPABASE_URL + "/rest/v1/training_blocks?profile_id=eq." + encodeURIComponent(pid) +
        "&status=eq.active&order=start_date.desc&limit=1", { headers: sbHeaders() });
      var brows = await br.json();
      block = Array.isArray(brows) && brows.length ? brows[0] : null;
      if (block) {
        var sr = await fetch(SUPABASE_URL + "/rest/v1/planned_sessions?profile_id=eq." + encodeURIComponent(pid) +
          "&block_id=eq." + block.id + "&order=date.asc,slot.asc", { headers: sbHeaders() });
        var srows = await sr.json();
        if (Array.isArray(srows)) sessions = srows;
      }
    } catch (e) { /* non-fatal — the today card still renders from the cache */ }

    res.json({
      success: true, engine_v2: true, today: today,
      cache_fresh: fresh,
      cache: fresh ? (prow.v2_daily_cache || null) : null,
      cache_date: prow.v2_daily_cache_date || null,
      defaults: pd.defaults || null,
      block: block ? { id: block.id, start_date: block.start_date, end_date: block.end_date, block: block.block } : null,
      sessions: sessions.map(function (s) {
        return { date: s.date, slot: s.slot, status: s.status, movable: s.movable, priority: s.priority,
          category: s.session && s.session.category, duration_min: s.session && s.session.duration_min,
          intensity: s.session && s.session.intensity, why: s.session && s.session.why,
          session: s.session };
      }),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/v2/variant/:profileId — streaming, Haiku. NOT admin-gated: it is a
 * user-facing generation endpoint, the same posture as the v1 /api/ai proxy and
 * /daily-recs (open generation endpoints; the app is PIN-gated at the profile
 * selector, not per-API). The real guard is the engine_v2 check below — this
 * refuses any profile not flagged for v2. The nightly CRON endpoint stays
 * admin-gated (server-to-server).
 * Ephemeral: never writes v2_daily_cache or planned_sessions.
 */
app.post("/api/v2/variant/:profileId", async function (req, res) {
  var t0 = Date.now();
  var pid = req.params.profileId;
  var controller = new AbortController();
  var streaming = false;
  try {
    var ctxData = await loadV2Context(pid);
    if (!ctxData) return res.status(404).json({ success: false, error: "Profile not found" });
    if (!ctxData.engineV2) return res.status(400).json({ success: false, error: "engine_v2 not true for this profile" });

    // The variant transforms the AUTOREGULATED primary from the cache, not the
    // raw planned_sessions row.
    var cacheObj = ctxData.profileRow.v2_daily_cache || null;
    if (!cacheObj || !cacheObj.today || ctxData.profileRow.v2_daily_cache_date !== ctxData.today) {
      return res.status(409).json({ success: false, error: "no fresh v2_daily_cache for today — run the nightly job first", cache_date: ctxData.profileRow.v2_daily_cache_date, today: ctxData.today });
    }
    // Transform the STRUCTURED autoregulated session (compression + the model
    // need segments, not the flattened display strings). Older caches without
    // today_session fall back to the flattened shape (degrades to model-only,
    // since compression can't operate on it — logged, not silently wrong).
    var primary = cacheObj.today_session || cacheObj.today;
    if (!cacheObj.today_session) console.warn("[v2Variant] cache lacks today_session (pre-Phase-5 cache) — code compression unavailable until the next nightly run");
    var isAnchor = primary.category === "martial_arts" || primary.category === "sports";
    // The cache doesn't carry movable; re-derive anchor status from today's planned row.
    try {
      var psr = await fetch(SUPABASE_URL + "/rest/v1/planned_sessions?profile_id=eq." + pid + "&date=eq." + ctxData.today + "&order=slot.asc&select=movable", { headers: sbHeaders() });
      var pRows = await psr.json();
      if (Array.isArray(pRows) && pRows.length) isAnchor = pRows[0].movable === false;
    } catch (e) { /* fall back to the category heuristic */ }

    var progressionText = v2Progression.renderProgressionTable(ctxData.progression);
    var recencyText = v2Progression.renderRecencyBlock(ctxData.recency);
    var dossierText = v2Dossier.renderDossierForPrompt(ctxData.dossier);
    var deps = { fetch: fetch, SUPABASE_URL: SUPABASE_URL, sbHeaders: sbHeaders };
    var readiness = await v2Readiness.buildReadinessState(deps, pid, { today: ctxData.today }).catch(function () { return null; });
    var readinessText = v2Readiness.renderReadinessBlock(readiness);

    // Resolve. Cache/code paths return WITHOUT streaming; only the model path streams.
    var body = req.body || {};
    var intent = v2Variant.classifyRequest(body, primary);
    var cachedHit = v2Variant.matchCachedAlternate(intent, cacheObj);
    var codeHit = !isAnchor && v2Variant.isCodeOnly(intent, primary);

    if (cachedHit || codeHit) {
      // Non-model path — plain JSON, no stream.
      var result0 = await v2GenerateVariant({ profileId: pid, body: body, ctxData: ctxData, cacheObj: cacheObj, primary: primary, isAnchor: isAnchor, today: ctxData.today });
      return res.json({ success: true, path: result0.path, why: result0.why, refused: !!result0.refused, session: v2Planner.flattenSessionForCache(result0.session), problems: result0.problems, intent: result0.intent, elapsed_ms: Date.now() - t0, ephemeral: true });
    }

    // Model path — stream.
    v2StartStream(res, "v2_variant");
    streaming = true;
    var result = await v2GenerateVariant({
      profileId: pid, body: body, ctxData: ctxData, cacheObj: cacheObj, primary: primary,
      isAnchor: isAnchor, today: ctxData.today,
      readinessText: readinessText, recencyText: recencyText, dossierText: dossierText, progressionText: progressionText,
      stream: true, res: res, controller: controller,
    });

    var payload = result.error
      ? { success: false, error: result.error, ephemeral: true }
      : { success: true, path: result.path, why: result.why, refused: !!result.refused, session: v2Planner.flattenSessionForCache(result.session), problems: result.problems, intent: result.intent, prompt_sections: result.sections, usage: result.usage, elapsed_ms: Date.now() - t0, ephemeral: true };
    try { res.write(sseFrame("\n[[APEXCOACH_V2_VARIANT_RESULT]]\n" + JSON.stringify(payload) + "\n[[/APEXCOACH_V2_VARIANT_RESULT]]")); } catch (e) {}
    finalizeAnthropicStream(res, "v2_variant", result.usage, true, true);
  } catch (e) {
    console.error("[v2Variant] failed:", e && e.message);
    if (streaming) { try { res.write(sseFrame("\n[[APEXCOACH_V2_VARIANT_RESULT]]\n" + JSON.stringify({ success: false, error: e.message }) + "\n[[/APEXCOACH_V2_VARIANT_RESULT]]")); res.end(); } catch (e2) {} }
    else res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/v2/cron/nightly — admin-gated. The PRIMARY nightly mechanism, since
 * Render's Hobby plan spins the interval's host down; an external cron hits this.
 * ?profile_id= scopes; default = every engine_v2 profile. ?force=1 bypasses the
 * per-profile idempotency guard.
 */
app.post("/api/v2/cron/nightly", async function (req, res) {
  var t0 = Date.now();
  try {
    if (process.env.ADMIN_SECRET) {
      var got = req.query.secret || req.get("X-Admin-Secret");
      if (got !== process.env.ADMIN_SECRET) return res.status(403).json({ success: false, error: "forbidden" });
    }
    var ids = [];
    if (req.query.profile_id) {
      ids = [req.query.profile_id];
    } else {
      // Every engine_v2 profile. profile_data->>engine_v2 filter via PostgREST.
      var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?profile_data->>engine_v2=eq.true&select=id", { headers: sbHeaders() });
      var rows = await pr.json();
      ids = Array.isArray(rows) ? rows.map(function (r) { return r.id; }) : [];
    }

    var force = req.query.force === "1";
    var results = [];
    // Per-profile isolation: one failure must not abort the others.
    for (var i = 0; i < ids.length; i++) {
      try {
        var r = await v2NightlyForProfile(ids[i], { force: force });
        results.push(r);
      } catch (e) {
        results.push({ profile_id: Number(ids[i]), status: "error", reason: e.message });
      }
    }

    var summary = {
      processed: results.length,
      succeeded: results.filter(function (r) { return r.status === "succeeded"; }).length,
      skipped: results.filter(function (r) { return r.status === "skipped"; }).length,
      failed: results.filter(function (r) { return r.status === "error"; }).length,
      total_input_tokens: results.reduce(function (a, r) { return a + ((r.tokens && r.tokens.input) || 0); }, 0),
      total_output_tokens: results.reduce(function (a, r) { return a + ((r.tokens && r.tokens.output) || 0); }, 0),
      wall_ms: Date.now() - t0,
    };
    console.log("[v2Cron] nightly summary " + JSON.stringify(summary));
    res.json({ success: true, summary: summary, results: results });
  } catch (e) {
    console.error("[v2Cron] failed:", e && e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// In-process hourly interval — SECONDARY only. On Render's Hobby plan the host
// spins down when idle, so this frequently will not fire; the system is fully
// correct without it (the admin endpoint is the real trigger). Each tick runs
// the same per-profile pipeline, which is idempotent on the athlete-local date
// and serialised by withV2Lock, so a tick that overlaps a manual trigger cannot
// double-generate.
var _v2IntervalStarted = false;
function startV2NightlyInterval() {
  if (_v2IntervalStarted) return;
  _v2IntervalStarted = true;
  setInterval(async function () {
    try {
      var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?profile_data->>engine_v2=eq.true&select=id", { headers: sbHeaders() });
      var rows = await pr.json();
      var ids = Array.isArray(rows) ? rows.map(function (r) { return r.id; }) : [];
      for (var i = 0; i < ids.length; i++) {
        // force:false — the idempotency guard skips a profile already fresh for
        // its own local date, so most hourly ticks are cheap no-ops.
        await v2NightlyForProfile(ids[i], { force: false }).catch(function (e) {
          console.warn("[v2Interval] profile " + ids[i] + " failed (non-fatal): " + e.message);
        });
      }
    } catch (e) {
      console.warn("[v2Interval] tick failed (non-fatal): " + e.message);
    }
  }, 3600000); // hourly
  console.log("[v2Interval] hourly nightly interval armed (secondary path; Render Hobby spin-down makes the admin cron primary)");
}

const httpServer = app.listen(PORT, function() {
  console.log("ApexCoach running on port " + PORT);
  startV2NightlyInterval();
});
// Standard mitigation for Node apps behind a reverse proxy (Render): the
// proxy's own idle-connection timeout is commonly ~60s. If Node's keep-alive
// timeout is shorter (default 5s) or close to the proxy's, the proxy can race
// a new request onto a connection Node is already closing, or hold a
// keep-alive connection whose eventual teardown looks like exactly the kind
// of "response completed server-side but the client never saw termination"
// symptom investigated in the 2026-07-15 daily_recs streaming bug (see
// ROADMAP.md). headersTimeout must exceed keepAliveTimeout (Node requirement).
httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 66000;
