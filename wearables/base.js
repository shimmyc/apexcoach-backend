// Provider-agnostic interface for wearable adapters.
//
// Every concrete adapter (Fitbit, Google Health Connect, Apple Health,
// Samsung Health, Garmin) exports the same three async functions. Endpoint
// code in server.js NEVER imports a provider directly — it calls
// require("./wearables").getProviderAdapter(provider) and works with the
// returned shape. Adding a new provider = drop in a new file, register it
// in wearables/index.js, no other changes.
//
// ──────────────────────────────────────────────────────────────────────────
// Adapter contract
// ──────────────────────────────────────────────────────────────────────────
//
//   async fetchActivities(accessToken, startDate, endDate)
//     → NormalizedActivity[]
//     List every recorded workout/activity between startDate and endDate
//     (YYYY-MM-DD, inclusive on both ends). Empty array if none. Should
//     NOT throw on "no activities" — only on auth/network failure.
//
//   async fetchActivityDetail(accessToken, providerActivityId)
//     → NormalizedActivity
//     Full detail for a single activity. Many providers return less detail
//     in the list endpoint (no HR zones, no peak HR) and require a second
//     call. If the list response is already complete, this can re-derive
//     from a cached list — but it must always succeed for a valid id.
//
//   async refreshToken(refreshToken)
//     → { access_token, refresh_token, expires_at }
//     expires_at is epoch ms (matches the existing Fitbit storage shape).
//     Throws if the refresh token is rejected — caller surfaces this to
//     the UI as "reconnect required".
//
// ──────────────────────────────────────────────────────────────────────────
// NormalizedActivity shape (every provider maps to this)
// ──────────────────────────────────────────────────────────────────────────
//
//   {
//     provider: "fitbit" | "google_health" | "apple_health" | "samsung_health" | "garmin",
//     provider_activity_id: string,        // bare id, NO provider prefix
//     date: "YYYY-MM-DD",                  // local date the activity started
//     activity_type: string,               // provider-native label, e.g. "Outdoor Run", "MMA"
//     duration_minutes: number,            // rounded to nearest minute
//     steps: number | null,
//     calories: number | null,
//     avg_hr: number | null,
//     peak_hr: number | null,
//     active_zone_minutes: number | null,
//     zones: object | null,                // { fatBurn, cardio, peak } in minutes
//     raw: object                          // original provider payload — preserved verbatim
//   }
//
// The namespaced id used in the workouts table is built as
// `${provider}:${provider_activity_id}` — adapters return the bare id;
// the matching / persistence layer adds the prefix.

// ──────────────────────────────────────────────────────────────────────────
// Provider-agnostic keyword map
// ──────────────────────────────────────────────────────────────────────────
// Used by matchWearableToManual to score activity_type ↔ manual workout
// type/notes overlap. Keys are LOWERCASE substrings looked up against
// both the wearable's activity_type and the user's workout type+notes.
// Whichever side mentions the keyword, the other side scoring against
// the same canonical category gets +30.
//
// Extending: add new keywords HERE — adapters never reference categories
// directly. New providers only need to surface their native label
// strings; if a label isn't in this map, scoring falls back to
// duration-only.
const KEYWORD_MAP = {
  martial_arts: [
    "aerobics", "sport", "martial arts", "mma", "boxing", "kickboxing",
    "muay thai", "bjj", "jiu jitsu", "judo", "wrestling", "karate",
  ],
  walking: ["walk", "walking", "outdoor walk", "treadmill walk", "hike", "hiking"],
  cycling: ["bike", "cycling", "indoor cycling", "spinning", "outdoor bike", "spin"],
  running: ["run", "running", "outdoor run", "treadmill", "treadmill run", "jog"],
  swimming: ["swim", "swimming", "lap swim", "open water"],
  strength: ["weights", "strength", "strength training", "lifting", "weight training", "powerlifting"],
  mind_body: ["yoga", "pilates", "stretching", "meditation", "breathwork", "mobility"],
};

// Returns the canonical category for a text blob (activity_type or
// workout notes/type), or null if nothing matches. First match wins —
// keyword order inside each category list is most-specific-first.
function categorize(text) {
  if (!text) return null;
  var lower = String(text).toLowerCase();
  var cats = Object.keys(KEYWORD_MAP);
  for (var i = 0; i < cats.length; i++) {
    var kws = KEYWORD_MAP[cats[i]];
    for (var j = 0; j < kws.length; j++) {
      if (lower.indexOf(kws[j]) >= 0) return cats[i];
    }
  }
  return null;
}

// Score a single wearable activity against a single manual workout.
// Both must be the same date — caller is responsible for that filter.
//   duration within 15 min  → +40
//   duration within 30 min  → +20
//   keyword category match  → +30
// Caller treats score >= 40 as a candidate match.
function scorePair(normalizedActivity, manualWorkout) {
  var score = 0;

  // Duration component: only meaningful when the wearable actually
  // measured a duration. Manual workouts often have no duration field —
  // we fall back to 0 and skip the duration bonus entirely so the
  // manual side doesn't get an unearned +40.
  var actDur = Number(normalizedActivity.duration_minutes) || 0;
  var manDur = Number(manualWorkout.duration_minutes) || 0;
  if (actDur > 0 && manDur > 0) {
    var diff = Math.abs(actDur - manDur);
    if (diff <= 15) score += 40;
    else if (diff <= 30) score += 20;
  }

  // Keyword component: both directions count, but only once. If the
  // wearable says "MMA" and the manual workout type is "MMA Class +
  // BJJ", they both categorize to martial_arts and match.
  var actCat = categorize(normalizedActivity.activity_type);
  var manCat = categorize((manualWorkout.type || "") + " " + (manualWorkout.notes || ""));
  if (actCat && manCat && actCat === manCat) score += 30;

  return score;
}

// Walk every manual workout on the same date as the activity and pick
// the highest scorer ≥ 40. Returns { workout, score } or null.
// Never crosses dates — passing manualWorkouts pre-filtered to the
// activity's date is the contract.
function matchWearableToManual(normalizedActivity, manualWorkouts) {
  var date = normalizedActivity.date;
  if (!date || !Array.isArray(manualWorkouts) || !manualWorkouts.length) return null;
  var best = null;
  for (var i = 0; i < manualWorkouts.length; i++) {
    var w = manualWorkouts[i];
    if (!w || w.date !== date) continue;
    var s = scorePair(normalizedActivity, w);
    if (s >= 40 && (!best || s > best.score)) {
      best = { workout: w, score: s };
    }
  }
  return best;
}

module.exports = {
  KEYWORD_MAP: KEYWORD_MAP,
  categorize: categorize,
  scorePair: scorePair,
  matchWearableToManual: matchWearableToManual,
};
