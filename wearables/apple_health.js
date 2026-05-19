// Apple Health / HealthKit adapter — STUB.
//
// HealthKit is iOS-only and has no server-side REST API. Like Health
// Connect, it requires a companion iOS app reading via the HKHealthStore
// API and pushing sessions to our server. Requires Apple Developer
// Account ($99/yr) and an actual iOS build — gated until that exists.
//
// ──────────────────────────────────────────────────────────────────────────
// Native HealthKit types to map → NormalizedActivity
// ──────────────────────────────────────────────────────────────────────────
//   HKWorkout                       → activity_type (HKWorkoutActivityType
//                                     enum: ~80 values), startDate,
//                                     endDate, duration_minutes, totalEnergyBurned
//   HKQuantityTypeIdentifierHeartRate (statistics aggregator over
//     workout interval) → avg_hr, peak_hr
//   HKQuantityTypeIdentifierStepCount (filtered to workout interval) → steps
//
// HKWorkoutActivityType enum:
// https://developer.apple.com/documentation/healthkit/hkworkoutactivitytype
// — map the .rawValue (int) or the descriptive name to our activity_type
// field. Examples: "Running", "Cycling", "MartialArts", "Yoga".
//
// ──────────────────────────────────────────────────────────────────────────
// Ingest pattern
// ──────────────────────────────────────────────────────────────────────────
// iOS companion app POSTs to /api/wearables/ingest/apple_health with
// { profile_token, workouts: [...] }. The adapter then reads from the
// resulting apple_health_pending_sessions table (mirrors the Google
// Health Connect approach).
//
// Alternative: Open Wearables iOS SDK
// (https://openwearables.org). Unified API across Apple/Garmin/Samsung
// etc. — Phase 2 candidate, but adds a Railway deployment dependency
// ($5/mo) and another vendor. Defer.

const PROVIDER = "apple_health";

async function fetchActivities(/* accessToken, startDate, endDate */) {
  // TODO: SELECT FROM apple_health_pending_sessions WHERE profile_token = $1
  //       AND start_date BETWEEN $startDate AND $endDate
  //       → map HKWorkout rows to NormalizedActivity shape
  throw new Error("apple_health adapter not implemented yet");
}

async function fetchActivityDetail(/* accessToken, providerActivityId */) {
  // TODO: SELECT FROM apple_health_pending_sessions WHERE id = $1
  throw new Error("apple_health adapter not implemented yet");
}

async function refreshToken(/* refreshTokenValue */) {
  // Companion-app session tokens — no OAuth refresh.
  throw new Error("apple_health uses on-device companion app — no token refresh");
}

function buildAuthUrl(/* redirectUri, state */) {
  // TODO: Universal Link to the iOS companion app's pairing screen.
  throw new Error("apple_health buildAuthUrl not implemented yet");
}

module.exports = {
  provider: PROVIDER,
  label: "Apple Health",
  fetchActivities: fetchActivities,
  fetchActivityDetail: fetchActivityDetail,
  refreshToken: refreshToken,
  buildAuthUrl: buildAuthUrl,
};
