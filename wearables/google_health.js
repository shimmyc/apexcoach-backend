// Google Health Connect adapter — STUB.
//
// HIGH PRIORITY per the roadmap (next integration after Fitbit). Health
// Connect is the Android system-level health DB used by Samsung, Pixel,
// OnePlus, and most Android 14+ devices.
//
// ──────────────────────────────────────────────────────────────────────────
// Architecture note
// ──────────────────────────────────────────────────────────────────────────
// Health Connect is an on-device API, not a cloud REST API. The adapter
// model assumes a server-side fetch with an access token. Two paths:
//
//   A. Companion Android app reads via Health Connect SDK and pushes
//      sessions to a server endpoint we own. The "accessToken" here is
//      a session token issued by our server to the companion app, NOT a
//      Google OAuth token. fetchActivities then queries OUR DB for
//      pushed sessions in the date range.
//
//   B. Google Fit REST API (https://developers.google.com/fit/rest)
//      via OAuth — works server-side, but Google Fit was deprecated
//      in 2024 with sunset in 2026. Not viable for new builds.
//
// → Going with path A. The companion app posts to
//   POST /api/wearables/ingest/google_health with { profile_token, sessions: [...] }
//   and this adapter reads them back out for matching.
//
// ──────────────────────────────────────────────────────────────────────────
// Native Health Connect record types to map → NormalizedActivity
// ──────────────────────────────────────────────────────────────────────────
//   ExerciseSessionRecord     → activity_type, date, duration_minutes
//   HeartRateRecord           → avg_hr, peak_hr (aggregated over session window)
//   TotalCaloriesBurnedRecord → calories
//   StepsRecord               → steps
//   ActiveCaloriesBurnedRecord (alt for calories)
//
// Health Connect exercise type enum:
// https://developer.android.com/reference/androidx/health/connect/client/records/ExerciseSessionRecord
// — covers ~70 activity types; map their enum strings into our activity_type
// field verbatim, then the keyword map in base.js handles category matching.

const PROVIDER = "google_health";

async function fetchActivities(/* accessToken, startDate, endDate */) {
  // TODO: SELECT * FROM google_health_pending_sessions WHERE profile_token = $1
  //       AND start_date BETWEEN $startDate AND $endDate
  //       → map each row to NormalizedActivity shape
  throw new Error("google_health adapter not implemented yet");
}

async function fetchActivityDetail(/* accessToken, providerActivityId */) {
  // TODO: SELECT * FROM google_health_pending_sessions WHERE id = $1
  throw new Error("google_health adapter not implemented yet");
}

async function refreshToken(/* refreshTokenValue */) {
  // Path A: no OAuth refresh. Companion-app session tokens are issued
  // by us — refresh is "user re-opens the app". If we ever switch to a
  // Google OAuth path, this is where the token endpoint call goes.
  throw new Error("google_health uses on-device companion app — no token refresh");
}

function buildAuthUrl(/* redirectUri, state */) {
  // TODO: Return a deep-link to the companion app's pairing screen, OR
  // a Google OAuth URL if we change strategy. For now, the connect
  // endpoint should redirect users to install instructions.
  throw new Error("google_health buildAuthUrl not implemented yet");
}

module.exports = {
  provider: PROVIDER,
  label: "Google Health Connect",
  fetchActivities: fetchActivities,
  fetchActivityDetail: fetchActivityDetail,
  refreshToken: refreshToken,
  buildAuthUrl: buildAuthUrl,
};
