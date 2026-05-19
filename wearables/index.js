// Wearable adapter registry + factory.
//
// To add a new provider:
//   1. Drop a new file at wearables/<provider>.js implementing the
//      contract documented in wearables/base.js.
//   2. Add the require + entry to SUPPORTED below.
//   3. Add any matching keywords to KEYWORD_MAP in wearables/base.js.
// No other code changes needed — endpoint handlers go through
// getProviderAdapter() and never reference providers directly.

const base = require("./base");

const SUPPORTED = [
  require("./fitbit"),
  require("./google_health"),
  require("./apple_health"),
  require("./samsung_health"),
  require("./garmin"),
];

var byProvider = {};
for (var i = 0; i < SUPPORTED.length; i++) {
  byProvider[SUPPORTED[i].provider] = SUPPORTED[i];
}

function getProviderAdapter(provider) {
  var adapter = byProvider[provider];
  if (!adapter) {
    throw new Error("Unknown wearable provider: " + provider);
  }
  return adapter;
}

function listProviders() {
  return SUPPORTED.map(function(a) {
    return { provider: a.provider, label: a.label };
  });
}

// Convenience: the namespaced id format used in workouts.wearable_activity_id.
// Adapters return the bare provider_activity_id; persistence layer prefixes.
function namespacedId(provider, providerActivityId) {
  return provider + ":" + providerActivityId;
}

module.exports = {
  getProviderAdapter: getProviderAdapter,
  listProviders: listProviders,
  namespacedId: namespacedId,
  // Re-export matcher + helpers from base so endpoint code only needs
  // one require.
  matchWearableToManual: base.matchWearableToManual,
  categorize: base.categorize,
  scorePair: base.scorePair,
  KEYWORD_MAP: base.KEYWORD_MAP,
};
