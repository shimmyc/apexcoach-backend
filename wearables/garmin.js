// Garmin Connect adapter — STUB.
//
// Garmin Connect IQ has a public REST API (no companion app needed)
// using OAuth 1.0a (NOT OAuth 2.0 — different signing). Apply at
// https://developer.garmin.com/gc-developer-program/. Requires a
// developer agreement; not invite-only like Whoop, but not instant either.
//
// ──────────────────────────────────────────────────────────────────────────
// Garmin Health API endpoints
// ──────────────────────────────────────────────────────────────────────────
// Base: https://apis.garmin.com/wellness-api/rest/
//
// List activities:
//   GET /activities?uploadStartTimeInSeconds={epoch}&uploadEndTimeInSeconds={epoch}
//   Returns Garmin Activity Summary records:
//     activityId, activityType, startTimeInSeconds, durationInSeconds,
//     averageHeartRateInBeatsPerMinute, maxHeartRateInBeatsPerMinute,
//     activeKilocalories, steps
//   Map → NormalizedActivity:
//     date = (startTimeInSeconds → YYYY-MM-DD in user's timezone)
//     duration_minutes = durationInSeconds / 60
//     activity_type = activityType (Garmin enum: "RUNNING", "MMA",
//                     "STRENGTH_TRAINING", "CYCLING", ~70 values)
//
// Activity detail (laps + per-second HR):
//   GET /activityDetails/{activityId}
//
// Activity type enum reference:
// https://developer.garmin.com/gc-developer-program/health-api/
//
// ──────────────────────────────────────────────────────────────────────────
// OAuth 1.0a flow (different from Fitbit's OAuth 2.0!)
// ──────────────────────────────────────────────────────────────────────────
// 1. POST /oauth-service/oauth/request_token → request token
// 2. Redirect to https://connect.garmin.com/oauthConfirm?oauth_token=...
// 3. Callback receives oauth_verifier
// 4. POST /oauth-service/oauth/access_token → user access token + secret
//
// Token "refresh" — Garmin OAuth 1.0a tokens DO NOT expire automatically.
// They're valid until the user revokes access. refreshToken() here is
// a no-op that returns the existing token unchanged, OR throws
// RECONNECT_REQUIRED if Garmin returns 401 on a fetch (then the user
// re-runs the full OAuth dance).
//
// Implementation note: the existing wearable_connections token_expires_at
// column can be left null for Garmin rows; the auto-refresh logic in
// server.js should treat null expiry as "never refresh, just retry".

const PROVIDER = "garmin";

async function fetchActivities(/* accessToken, startDate, endDate */) {
  // TODO: GET /wellness-api/rest/activities with epoch range derived from
  //       startDate/endDate, OAuth 1.0a signed with the consumer key/secret
  //       (env: GARMIN_CONSUMER_KEY, GARMIN_CONSUMER_SECRET) and the
  //       user's access token + token secret (stored in
  //       wearable_connections.access_token + a new token_secret column
  //       OR encoded as JSON in access_token).
  throw new Error("garmin adapter not implemented yet");
}

async function fetchActivityDetail(/* accessToken, providerActivityId */) {
  // TODO: GET /wellness-api/rest/activityDetails/{providerActivityId}
  throw new Error("garmin adapter not implemented yet");
}

async function refreshToken(/* refreshTokenValue */) {
  // Garmin OAuth 1.0a tokens don't expire — no-op until a 401 forces
  // full reconnection.
  throw new Error("garmin tokens are non-expiring — reconnect required if revoked");
}

function buildAuthUrl(/* redirectUri, state */) {
  // TODO: Step 1 of OAuth 1.0a (request token), then redirect to the
  // oauthConfirm URL. This is more involved than Fitbit's single
  // authorize call — needs a request_token round-trip first.
  throw new Error("garmin buildAuthUrl not implemented yet");
}

module.exports = {
  provider: PROVIDER,
  label: "Garmin",
  fetchActivities: fetchActivities,
  fetchActivityDetail: fetchActivityDetail,
  refreshToken: refreshToken,
  buildAuthUrl: buildAuthUrl,
};
