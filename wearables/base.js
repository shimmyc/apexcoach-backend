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
//   normalize(rawProviderActivity)   [OPTIONAL]
//     → NormalizedActivity
//     Synchronous mapper from a raw list/detail payload to NormalizedActivity.
//     Used by the merge/import path to backfill HR fields the detail endpoint
//     drops from the list activity. Providers that don't export it just skip
//     that backfill.
//
// ──────────────────────────────────────────────────────────────────────────
// NormalizedActivity shape (every provider maps to this)
// ──────────────────────────────────────────────────────────────────────────
//
//   {
//     provider: "fitbit" | "google_health" | "apple_health" | "samsung_health" | "garmin",
//     provider_activity_id: string,        // bare id, NO provider prefix
//     date: "YYYY-MM-DD",                  // local date the activity started
//     start_time: ISO string | null,       // full ISO with tz when available
//     activity_type: string,               // provider-native label, e.g. "Outdoor Run", "MMA"
//     duration_minutes: number,            // rounded to nearest minute
//     distance_miles: number | null,
//     elevation_gain: number | null,
//     steps: number | null,
//     calories: number | null,
//     avg_hr: number | null,
//     peak_hr: number | null,
//     min_hr: number | null,               // populated from intraday samples when available
//     active_zone_minutes: number | null,
//     zones: object | null,                // { fatBurn, cardio, peak, out_of_range, raw } in minutes
//     heart_rate_samples: Array<{t: epoch_ms, bpm: number}> | null,
//                                          // intraday HR over the activity window — capped at 600 samples
//     raw_response: object                 // original provider payload — preserved verbatim
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

// Activity type labels the wearable falls back to when it can't
// classify the session. Many wearables don't support niche activities
// (martial arts, rock climbing, rowing, dance, etc.) so users default
// to one of these — a generic type should never PREVENT a match.
var GENERIC_ACTIVITY_TYPES = [
  "workout", "sport", "exercise", "training", "activity", "generic workout",
];

// Score the duration component of a pairing.
//   ≤15 min apart  → 40 points
//   ≤30 min apart  → 20 points
//   >30 min apart  → 0 points
// Returns 0 if either side has no duration — manual logs often lack a
// duration field, and we can't penalize that. The activity-type and
// auto-match-by-date paths still apply.
function scoreDuration(actDuration, manDuration) {
  var a = Number(actDuration) || 0;
  var m = Number(manDuration) || 0;
  if (a <= 0 || m <= 0) return 0;
  var diff = Math.abs(a - m);
  if (diff <= 15) return 40;
  if (diff <= 30) return 20;
  return 0;
}

// Score the activity-type component of a pairing.
//   exact keyword match     → 30   ("walk" appears on both sides)
//   related (same category) → 20   ("cycling" vs "bike ride" — both → cycling)
//   generic wearable type   → 15   ("Workout" + anything on manual side)
//   no overlap              → 0
function scoreActivityType(activityType, manualText) {
  if (!activityType) return 0;
  var actLower = String(activityType).toLowerCase().trim();
  var manLower = String(manualText || "").toLowerCase();

  if (GENERIC_ACTIVITY_TYPES.indexOf(actLower) >= 0) {
    return manLower.trim() ? 15 : 0;
  }

  var actCat = categorize(actLower);
  if (!actCat) return 0;
  var manCat = categorize(manLower);
  if (manCat !== actCat) return 0;

  // Same canonical category — check whether both sides surface the SAME
  // keyword. If yes, exact (+30); otherwise related (+20).
  var kws = KEYWORD_MAP[actCat];
  for (var i = 0; i < kws.length; i++) {
    var kw = kws[i];
    if (actLower.indexOf(kw) >= 0 && manLower.indexOf(kw) >= 0) return 30;
  }
  return 20;
}

// Combined per-pair score used in the multi-workout-per-date case. The
// single-workout case bypasses this entirely (matchWearableToManual
// short-circuits to score 60 — see below).
//
// Score bands:
//   Exact keyword type match + ≤15min duration  → 70
//   Exact keyword type match + ≤30min duration  → 50
//   Related-category type + ≤15min duration     → 60
//   Related-category type + ≤30min duration     → 40
//   Generic wearable type + ≤30min duration     → 35  (the "+35 combined"
//                                                      signal — wearable
//                                                      didn't classify, so
//                                                      we lean on duration)
//   Generic + ≤15min duration                   → 55
//   Duration-only (no type signal) + ≤15min     → 40
function scorePair(normalizedActivity, manualWorkout) {
  var dur = scoreDuration(normalizedActivity.duration_minutes, manualWorkout.duration_minutes);
  var manualText = (manualWorkout.type || "") + " " + (manualWorkout.notes || "");
  var type = scoreActivityType(normalizedActivity.activity_type, manualText);
  return dur + type;
}

// Pick the best manual workout to pair with this wearable activity.
//
// Contract:
//   1. Same date only (no cross-date matching ever).
//   2. If exactly ONE manual workout exists on that date → auto-match
//      it with a flat score of 60. Reasoning: the wearable session and
//      the only logged session on the same day are almost certainly the
//      same workout regardless of type metadata. The user can still
//      Skip if they're separate. This unblocks niche-activity users
//      whose wearable returns "Workout" for everything.
//   3. If MULTIPLE workouts share that date → score each via scorePair,
//      return the top scorer ≥30. Threshold 30 is intentionally
//      permissive — bulk-match defaults to 70 so casual candidates
//      require human review.
//
// Returns: { manual_workout, wearable_activity, score, auto_matched? } | null
function matchWearableToManual(normalizedActivity, manualWorkouts) {
  if (!normalizedActivity || !normalizedActivity.date) return null;
  if (!Array.isArray(manualWorkouts) || !manualWorkouts.length) return null;
  var sameDate = manualWorkouts.filter(function(w) { return w && w.date === normalizedActivity.date; });
  if (!sameDate.length) return null;

  if (sameDate.length === 1) {
    return {
      manual_workout: sameDate[0],
      wearable_activity: normalizedActivity,
      score: 60,
      auto_matched: true,
    };
  }

  var best = null;
  for (var i = 0; i < sameDate.length; i++) {
    var w = sameDate[i];
    var s = scorePair(normalizedActivity, w);
    if (s >= 30 && (!best || s > best.score)) {
      best = { manual_workout: w, wearable_activity: normalizedActivity, score: s };
    }
  }
  return best;
}

module.exports = {
  KEYWORD_MAP: KEYWORD_MAP,
  GENERIC_ACTIVITY_TYPES: GENERIC_ACTIVITY_TYPES,
  categorize: categorize,
  scoreDuration: scoreDuration,
  scoreActivityType: scoreActivityType,
  scorePair: scorePair,
  matchWearableToManual: matchWearableToManual,
};
