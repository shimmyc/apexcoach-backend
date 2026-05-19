// Samsung Health adapter — STUB.
//
// Samsung Health has two integration paths; both are Android-only.
//
// ──────────────────────────────────────────────────────────────────────────
// Path A — Samsung Health Data SDK (preferred, Android-only)
// ──────────────────────────────────────────────────────────────────────────
// https://developer.samsung.com/health/data-android
// Native SDK reads workouts/HR/steps off the device. Same companion-app
// pattern as Google Health Connect — push sessions to our server, then
// this adapter reads them out for matching.
//
// Relevant data types:
//   ExerciseDataType            → activity_type (exercise_type enum),
//                                 start_time, end_time, duration_min, calorie
//   HeartRateDataType (filtered to exercise window) → avg_hr, peak_hr
//   StepDataType   (filtered to exercise window)   → steps
//
// Exercise type enum:
// https://developer.samsung.com/health/android/data/data-types/exercise.html
// — maps Samsung's int codes (1001 = Walking, 11007 = Running, etc.) to
// label strings; pass the label through to activity_type and let the
// keyword map in base.js handle scoring.
//
// ──────────────────────────────────────────────────────────────────────────
// Path B — Health Connect re-export (already covered)
// ──────────────────────────────────────────────────────────────────────────
// Samsung Health writes to Health Connect on Android 14+. If a user has
// both adapters connected we'd double-count, so the connect endpoint
// should soft-conflict (warn the user "you already have Health Connect
// — Samsung will duplicate"). Skip this adapter on those devices.

const PROVIDER = "samsung_health";

async function fetchActivities(/* accessToken, startDate, endDate */) {
  // TODO: SELECT FROM samsung_health_pending_sessions WHERE profile_token = $1
  //       AND start_date BETWEEN $startDate AND $endDate
  //       → map exercise rows to NormalizedActivity shape
  throw new Error("samsung_health adapter not implemented yet");
}

async function fetchActivityDetail(/* accessToken, providerActivityId */) {
  // TODO: SELECT FROM samsung_health_pending_sessions WHERE id = $1
  throw new Error("samsung_health adapter not implemented yet");
}

async function refreshToken(/* refreshTokenValue */) {
  throw new Error("samsung_health uses on-device companion app — no token refresh");
}

function buildAuthUrl(/* redirectUri, state */) {
  // TODO: Deep-link to the Android companion app's pairing screen.
  throw new Error("samsung_health buildAuthUrl not implemented yet");
}

module.exports = {
  provider: PROVIDER,
  label: "Samsung Health",
  fetchActivities: fetchActivities,
  fetchActivityDetail: fetchActivityDetail,
  refreshToken: refreshToken,
  buildAuthUrl: buildAuthUrl,
};
