"use strict";
/**
 * ENGINE v2 — ON-DEMAND VARIANT (Haiku, streamed, small context)
 * ==============================================================
 * The path a user hits when they want something OTHER than what is cached.
 * Transforms TODAY'S session (the autoregulated primary from v2_daily_cache)
 * under the dossier + rules. Ephemeral by design: it never overwrites
 * v2_daily_cache and never touches planned_sessions — asking to see something
 * different does not mutate the day's plan.
 *
 * ONE shared implementation, two callers:
 *   - POST /api/v2/variant/:profileId (the user path)
 *   - the nightly job's category-swap alternate (replaces Phase 4's inline
 *     prompt that produced nothing and wasted a call)
 *
 * Dependency-injected; no I/O of its own beyond what the caller hands in.
 */

var rules = require("./coachingRules");
var ar = require("./v2Autoregulator");

// ── Free-text intent classification (code, before any model call) ───────────
// "Shorter"/"Harder"/"Easier" map cleanly to STRUCTURED constraints — treating
// every phrasing as free-text would waste a model call on a deterministic case.
// "Not feeling it" is a READINESS signal, not a preference, and routes through
// the rules module's readiness/deload logic rather than a blind reroll.

var SHORTER_RE = /\b(shorter|quick(er)?|less time|short on time|cut it down|make it short)\b/i;
var LONGER_RE = /\b(longer|more time|extend|make it long)\b/i;
var HARDER_RE = /\b(harder|tough(er)?|more intense|push me|crank it|heavier)\b/i;
var EASIER_RE = /\b(easier|lighter|gentler|go easy|ease off|less intense)\b/i;
var NOT_FEELING_RE = /\b(not feeling|don'?t feel|can'?t face|no energy|drained|exhausted|wrecked|terrible|rough day|not into|change it|switch it)\b/i;
var SAME_MUSCLE_RE = /\b(same (muscle|group|pattern|focus)|different style|mix it up|vary|switch up the|other exercises)\b/i;

// Body-region requests ("upper body", "legs", "push day") are NOT in the category
// enum and are a common phrasing — they must classify to a `region` that shapes
// exercise selection. Ordered most-specific-first.
var REGION_RES = [
  { re: /\bupper body\b|\bupper\b/i, region: "upper_body" },
  { re: /\blower body\b|\bleg day\b|\blegs?\b|\bquads?\b|\bhamstrings?\b|\bglutes?\b/i, region: "lower_body" },
  { re: /\bpush( day)?\b/i, region: "push" },
  { re: /\bpull( day)?\b/i, region: "pull" },
  { re: /\barms?\b|\bbiceps?\b|\btriceps?\b/i, region: "arms" },
  { re: /\bcore\b|\babs\b|\bmidsection\b/i, region: "core" },
  { re: /\bfull body\b|\btotal body\b/i, region: "full_body" },
];
// Free-text CATEGORY ("give me cardio", "do strength instead") when the structured
// category field is absent. Maps to the same category enum the planner uses.
var CATEGORY_TEXT_RES = [
  { re: /\bcardio\b|\bconditioning\b|\brun(ning)?\b|\bbike\b|\bcycl|\browing\b|\bswim\b|\bhiit\b/i, category: "cardio" },
  { re: /\bstrength\b|\blift(ing)?\b|\bweights?\b|\bresistance\b|\bhypertrophy\b/i, category: "strength" },
  { re: /\byoga\b|\bmobility\b|\bstretch|\bmeditat|\bpilates\b|\bmind[-\s]?body\b|\bbreath/i, category: "mind_body" },
  { re: /\brehab\b|\bprehab\b|\bphysical therapy\b|\brecovery\b/i, category: "rehab" },
];
// A "I can't do my fixed commitment" signal — used for the GENERATE framing on an
// anchor day. Not load-bearing for routing (an anchor with no content routes to
// generate regardless), but it tells the model the athlete is MISSING the class.
var MISSED_RE = /\b(cancel(l)?ed|couldn'?t make|can'?t make|couldn'?t go|didn'?t make|missed|skip(ping|ped)?|sick|ill|out of town|no class|class is off)\b/i;

/**
 * Resolve the request into a normalized intent. Structured fields win over
 * free-text where both are present (an explicit duration_min beats a vague
 * "shorter"). Returns { duration_min, intensity, category, style, readiness,
 * freeText, notes[] } — any of which may be null.
 */
function classifyRequest(body, primary) {
  body = body || {};
  var notes = [];
  var out = {
    duration_min: (typeof body.duration_min === "number" && body.duration_min > 0) ? body.duration_min : null,
    intensity: normIntensity(body.intensity),
    category: body.category || null,
    region: normRegion(body.region),  // structured region wins over text
    style_change: false,     // "same muscle group, different style"
    readiness_signal: false, // "not feeling it"
    missed_signal: false,    // "class got cancelled / couldn't make it"
    free_text: (body.constraint_text || "").trim() || null,
  };

  var txt = out.free_text || "";
  if (txt) {
    if (out.duration_min == null && SHORTER_RE.test(txt)) {
      out.duration_min = neighborDuration(primary, -1);
      notes.push("mapped 'shorter' -> " + out.duration_min + " min (structured)");
    } else if (out.duration_min == null && LONGER_RE.test(txt)) {
      out.duration_min = neighborDuration(primary, +1);
      notes.push("mapped 'longer' -> " + out.duration_min + " min");
    }
    if (out.intensity == null && HARDER_RE.test(txt)) { out.intensity = bumpIntensity(primary, +1); notes.push("mapped 'harder' -> intensity " + out.intensity); }
    else if (out.intensity == null && EASIER_RE.test(txt)) { out.intensity = bumpIntensity(primary, -1); notes.push("mapped 'easier' -> intensity " + out.intensity); }
    if (NOT_FEELING_RE.test(txt)) { out.readiness_signal = true; notes.push("'not feeling it' treated as a READINESS signal, routed through the rules module"); }
    if (SAME_MUSCLE_RE.test(txt)) { out.style_change = true; notes.push("'same focus, different style' — hold the pattern + primary, vary structure"); }
    // Body-region from free text (common phrasing; not in the category enum).
    if (!out.region) {
      for (var ri = 0; ri < REGION_RES.length; ri++) {
        if (REGION_RES[ri].re.test(txt)) { out.region = REGION_RES[ri].region; notes.push("region: " + out.region); break; }
      }
    }
    // Free-text category when the structured field is absent.
    if (!out.category) {
      for (var ci = 0; ci < CATEGORY_TEXT_RES.length; ci++) {
        if (CATEGORY_TEXT_RES[ci].re.test(txt)) { out.category = CATEGORY_TEXT_RES[ci].category; notes.push("category from text: " + out.category); break; }
      }
    }
    if (MISSED_RE.test(txt)) { out.missed_signal = true; notes.push("missed-commitment signal detected"); }
  }
  out.notes = notes;
  return out;
}

function normIntensity(v) {
  var s = String(v || "").toLowerCase();
  return (s === "low" || s === "medium" || s === "high") ? s : null;
}
var REGION_VALUES = { upper_body: 1, lower_body: 1, push: 1, pull: 1, arms: 1, core: 1, full_body: 1 };
function normRegion(v) {
  var s = String(v || "").toLowerCase().replace(/\s+/g, "_");
  return REGION_VALUES[s] ? s : null;
}
var IRANK = { low: 1, medium: 2, high: 3 };
var IBY = { 1: "low", 2: "medium", 3: "high" };
function bumpIntensity(primary, dir) {
  var cur = IRANK[String(primary && primary.intensity || "medium").toLowerCase()] || 2;
  return IBY[Math.max(1, Math.min(3, cur + dir))];
}
function neighborDuration(primary, dir) {
  var base = Number(primary && primary.duration_min) || 45;
  return Math.max(15, base + dir * 15);
}

// ── Whether the whole request is deterministically resolvable in CODE ────────
/**
 * A request is CODE-ONLY when it is a pure duration reduction with no other
 * constraint — the time-compression order fully determines the outcome, so no
 * model judgment is needed. Everything else (intensity change, category swap,
 * style change, free-text, a readiness signal, or a duration INCREASE — adding
 * volume is a judgment the code must not fake) needs the model.
 */
function isCodeOnly(intent, primary) {
  if (intent.category) return false;
  if (intent.region) return false;   // a region request needs exercise selection (model)
  if (intent.intensity) return false;
  if (intent.style_change || intent.readiness_signal) return false;
  if (intent.free_text && !intent.notes.length) return false; // unmapped free text -> model
  if (intent.free_text && (intent.style_change || intent.readiness_signal)) return false;
  if (intent.duration_min == null) return false;
  var base = Number(primary && primary.duration_min) || 45;
  return intent.duration_min < base;   // a REDUCTION only
}

/**
 * Cache-first resolution. If the request is a pure duration swap matching a
 * cached alternate, return that alternate with zero model call.
 * @returns {object|null} the matching cached alternate's session, or null.
 */
function matchCachedAlternate(intent, cache) {
  if (!cache || !Array.isArray(cache.alternates)) return null;
  // Only a pure duration request (nothing else) can be served from a cached
  // duration alternate.
  if (intent.category || intent.region || intent.intensity || intent.style_change || intent.readiness_signal) return null;
  if (intent.duration_min == null) return null;
  // Match by the alternate's INTENT (its `dur_<N>` key), then fall back to the
  // actual duration within a small tolerance. A "dur_30" alternate compresses
  // to ~28 min (the segment floor), so an exact-minutes match on a request for
  // 30 would miss the very alternate that was prepared for it.
  var wantKey = "dur_" + Number(intent.duration_min);
  // Only serve from cache when the prepared alternate's ACTUAL duration is
  // genuinely near the request. This excludes the `dur_60` no-op-extend
  // alternate (which is just the primary relabeled and does not actually reach
  // 60) — serving that as a 60-minute session would be dishonest; that request
  // correctly falls through to a real generation.
  var near = function (a) {
    var s = a.session_structured || a.session;
    if (!s) return false;
    var tol = Math.max(3, Math.floor(intent.duration_min * 0.1));
    return Math.abs(Number(s.duration_min) - Number(intent.duration_min)) <= tol;
  };
  var byKey = cache.alternates.filter(function (a) { return a.key === wantKey && near(a); })[0];
  var hit = byKey || cache.alternates.filter(near)[0];
  // Prefer the structured form so the caller can re-flatten uniformly; fall
  // back to the flattened one for older caches.
  return hit ? (hit.session_structured || hit.session) : null;
}

// ── Contraindication check (dossier injury flags) ───────────────────────────
/**
 * A very conservative keyword guard: an exercise is contraindicated when its
 * name overlaps a body-area token from an active injury flag whose status is
 * not merely "declared". Deliberately over-inclusive on FLAG (it reports), and
 * it never silently rewrites — the caller decides. This mirrors the rules
 * module's stance that a constraint asking for something contraindicated is
 * refused, not honored.
 */
var AREA_TOKENS = {
  "pubic": ["adduct", "groin", "sprint", "heavy squat", "box jump", "sled"],
  "osteitis": ["adduct", "groin", "sprint", "heavy squat"],
  "quad": ["sprint", "deep squat", "lunge jump", "plyometric"],
  "it band": ["run", "sprint", "lunge jump"],
  "concussion": ["sprint", "heavy overhead", "inversion", "rotational jump"],
  // Tokens are matched as substrings, so they must be SPECIFIC enough not to
  // catch an unrelated movement. "bridge" alone matched "Glute Bridge" (a hip
  // exercise central to this athlete's osteitis rehab) against a NECK flag on
  // every session — a false positive that erodes the flag's value. A neck
  // bridge is the real contraindication, so the token is qualified.
  "trap": ["upright row", "heavy shrug", "behind neck"],
  "neck": ["upright row", "behind neck", "heavy shrug", "neck bridge", "wrestler bridge"],
  "pelvic": ["heavy squat", "sprint", "box jump"],
};
function contraindications(session, dossier) {
  var flags = (dossier && dossier.injury_flags) || [];
  var active = flags.filter(function (f) {
    return f && String(f.status || "").toLowerCase().indexOf("declared in profile, no recent report") < 0;
  });
  var hits = [];
  var names = [];
  ((session && session.segments) || []).forEach(function (seg) {
    (seg.exercises || []).forEach(function (ex) { if (ex && ex.name) names.push(ex.name); });
  });
  var seen = {};
  active.forEach(function (f) {
    var area = String(f.area || "").toLowerCase();
    Object.keys(AREA_TOKENS).forEach(function (token) {
      if (area.indexOf(token) < 0) return;
      AREA_TOKENS[token].forEach(function (bad) {
        names.forEach(function (n) {
          if (String(n).toLowerCase().indexOf(bad) >= 0) {
            // Dedup on (exercise, injury area): the same area can match multiple
            // token sets ("pubic osteitis" hits both 'pubic' and 'osteitis'),
            // which would otherwise report the same conflict several times.
            var key = String(n).toLowerCase() + "|" + area;
            if (seen[key]) return;
            seen[key] = true;
            hits.push({ exercise: n, injury_area: f.area, conflict: bad });
          }
        });
      });
    });
  });
  return hits;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

function buildVariantPrompt(ctx) {
  var intent = ctx.intent;
  var primary = ctx.primary;
  var isAnchor = ctx.isAnchor;

  var system =
    "You produce ONE variant of an athlete's session that has ALREADY been planned and adjusted for " +
    "today. You are transforming it to meet a specific request — NOT writing a new session from " +
    "scratch and NOT re-planning the week.\n\n" +
    "HARD RULES YOU CANNOT OVERRIDE, whatever the request:\n" +
    "- If the session is an IMMOVABLE fixed commitment, you may not reshape it. Return its segments " +
    "exactly and explain in `why` that the request can only apply to the work around a fixed class.\n" +
    "- Injury/pain flags in the dossier are non-negotiable. If the request asks for something " +
    "contraindicated by an active injury, REFUSE it in the `why` line and return the safe session — " +
    "do not honor it.\n" +
    "- Respect the coaching rules given: volume caps, interference/spacing, per-session ceilings.\n" +
    "- Keep the injury-prehab dose and the primary compound unless a rule requires otherwise.\n\n" +
    "SOURCING RULE: state no training-history number that is not in this prompt.\n\n" +
    "OUTPUT CONTRACT — STRICT JSON ONLY, no prose/markdown/fences:\n" +
    "{\n" +
    '  "why": "ONE line: what changed AND what you deliberately held constant (and any refusal)",\n' +
    '  "refused": false,\n' +
    '  "session": { "category": "...", "duration_min": 45, "intensity": "low|medium|high",\n' +
    '    "why": "one line", "goal_tags": [...],\n' +
    '    "segments": [ { "type": "<segment enum>", "duration_min": 10, "intent": "one line", "params": {},\n' +
    '      "exercises": [ { "name": "...", "sets": 3, "reps": 8, "time_seconds": null, "distance": null, "load": "...", "rest": "...", "notes": "..." } ] } ] }\n' +
    "}\n\n" +
    "- `time_seconds` IS ALWAYS SECONDS; a timed block's length goes on the segment `duration_min`.\n" +
    // Session 9: a category swap used to delete the one genuine time block (a
    // bike) and inflate the remaining accessory segments' duration_min to refill
    // the total — passing the old sum rule while holding ~18 min of real work in
    // a "45 min" session. Content must fill the time; see the WORK BUDGET below.
    "- FILL THE TIME WITH REAL WORK — do NOT pad segment `duration_min` to hit a total. Each segment's minutes must be occupied by its prescribed sets/exercises/rounds (see the SESSION WORK BUDGET below). If a category change removes a long time block (e.g. a bike), replace it with enough real work to fill the duration, or shorten the session honestly — never leave inflated, empty minutes.\n" +
    "- Set `refused:true` only when you are refusing a contraindicated request; still return a safe session.\n";

  var parts = [];
  var sections = {};
  function add(name, text) { if (!text) return; parts.push(text); sections[name] = text.length; }

  // Compact JSON (no pretty-print) — the pretty-printed session was ~4.4k
  // chars, roughly a third of the whole prompt. Haiku reads compact JSON fine.
  add("today", "TODAY'S SESSION (this is what you are transforming" + (isAnchor ? " — IMMOVABLE, a fixed commitment" : "") + "):\n" + JSON.stringify(primary));

  // The concrete ask.
  var askLines = ["THE REQUEST:"];
  if (intent.free_text) askLines.push("- Free text: \"" + intent.free_text + "\"");
  if (intent.duration_min) askLines.push("- Target duration: ~" + intent.duration_min + " min (the session should run about this long, FILLED with real work — not padded to it).");
  if (intent.intensity) askLines.push("- Target intensity: " + intent.intensity + ".");
  if (intent.category) askLines.push("- Change the category to: " + intent.category + " (a genuinely different kind of session; keep the duration).");
  if (intent.region) askLines.push("- Focus the session on this BODY REGION: " + intent.region.replace(/_/g, " ") + " (bias exercise selection toward this region while staying inside the envelope).");
  if (intent.style_change) askLines.push("- SAME focus / muscle group / movement pattern, DIFFERENT style: keep the primary compound and the trained pattern, vary the accessory selection, structure and segment types.");
  if (intent.readiness_signal) askLines.push("- The athlete says they are NOT FEELING IT. Treat this as a readiness signal per the RULES VERDICT below — reduce intensity or convert toward recovery per the rules, do not just reshuffle exercises.");
  add("request", askLines.join("\n"));

  if (ctx.readinessText) add("readiness", ctx.readinessText);
  if (ctx.recencyText) add("recency", ctx.recencyText);
  if (ctx.dossierText) add("dossier", ctx.dossierText);
  // Only the rule sections a variant actually needs — keeps context small.
  add("rules", rules.renderRulesForPrompt(["readiness", "deload", "interference", "time_compression", "volume", "pain"]));
  // A2: the SAME effective-stage envelopes the planner used, so a category swap
  // refills to the right stage's volume/intensity — it must not delete real work
  // (e.g. a bike) and backfill with padding, and must not escalate past the stage.
  if (ctx.envelopeText) add("envelope", ctx.envelopeText);
  // The same work-budget guidance the planner uses AND the server enforces — a
  // swap must fill the time with real work, not inflate segment minutes.
  add("work_budget", rules.renderWorkBudgetGuidance());

  var user = parts.join("\n\n");
  sections._system = system.length;
  sections._user = user.length;
  sections._total = system.length + user.length;
  return { system: system, user: user, sections: sections };
}

// ── GENERATE prompt (anchor day / no-content primary) ───────────────────────
/**
 * When today's primary has NO prescribable content (a fixed-commitment anchor —
 * a class, a team practice — or a rest day), a variant cannot TRANSFORM it. If
 * the athlete says they can't do it, we GENERATE a real, full replacement session
 * for the freed time. The anchor row is NOT changed — this is an ephemeral
 * alternative for today only.
 *
 * Envelope-compliant (the SAME renderEffectiveEnvelopesForPrompt block the planner
 * uses — advancement disabled, so it can never escalate past the cleared stage),
 * work-floor-bound, contraindication- and spacing-aware (week context fed in).
 *
 * @param {object} ctx { intent, freedMinutes, anchorActivity, envelopeText,
 *                        weekContextText, matLoadNote, dossierText, readinessText,
 *                        recencyText, progressionText }
 */
function buildGeneratePrompt(ctx) {
  var intent = ctx.intent;
  var freed = ctx.freedMinutes;

  var system =
    "You build ONE real, full training session for an athlete who CANNOT do their scheduled fixed " +
    "commitment today (a class / practice / standing commitment) and has asked for a replacement. " +
    "You are NOT reshaping the commitment and NOT re-planning the week — you are generating a single " +
    "alternative session for the freed time, for today only. It will not be saved to the plan.\n\n" +
    "HARD RULES YOU CANNOT OVERRIDE:\n" +
    "- The session runs for the FREED TIME: " + freed + " minutes. Fill it with real work — do not pad, " +
    "do not shorten it below what the envelope calls for.\n" +
    "- STAY INSIDE THE EFFECTIVE-STAGE ENVELOPE below. You choose exercises and loads; the code owns the " +
    "volume/intensity bands. You may NOT escalate past the stage shown (no heavier/faster than its band).\n" +
    "- Injury/pain flags in the dossier are non-negotiable. If the request asks for contraindicated work, " +
    "REFUSE that part in `why` and build the safe session instead (set refused:true).\n" +
    "- Respect spacing/interference and mat-load rules against WHAT IS PLANNED AROUND TODAY (below): do not " +
    "create back-to-back high-CNS days, and reduce lower-body volume the day after a hard combat session.\n" +
    "- You are not diagnosing anything; never name a medical condition.\n\n" +
    "SOURCING RULE: state no training-history number that is not in this prompt.\n\n" +
    "OUTPUT CONTRACT — STRICT JSON ONLY, no prose/markdown/fences:\n" +
    "{\n" +
    '  "why": "ONE line: what this replacement is and any refusal",\n' +
    '  "refused": false,\n' +
    '  "session": { "category": "strength|cardio|mind_body|rehab|other", "duration_min": ' + freed + ', "intensity": "low|medium|high",\n' +
    '    "why": "one line", "goal_tags": [...],\n' +
    '    "segments": [ { "type": "<segment enum>", "duration_min": 10, "intent": "one line", "params": {},\n' +
    '      "exercises": [ { "name": "...", "sets": 3, "reps": 8, "time_seconds": null, "distance": null, "load": "...", "rest": "...", "notes": "..." } ] } ] }\n' +
    "}\n\n" +
    "- `time_seconds` IS ALWAYS SECONDS; a timed block's length goes on the segment `duration_min`.\n" +
    "- FILL THE TIME WITH REAL WORK — each segment's minutes must be occupied by its prescribed sets/exercises/rounds (see the SESSION WORK BUDGET). Never leave inflated, empty minutes.\n" +
    "- Set `refused:true` only when refusing a contraindicated request; still return a safe session.\n";

  var parts = [];
  var sections = {};
  function add(name, text) { if (!text) return; parts.push(text); sections[name] = text.length; }

  add("context", "SITUATION: the athlete's scheduled fixed commitment today" +
    (ctx.anchorActivity ? " (" + ctx.anchorActivity + ")" : "") + " is not happening" +
    (intent.missed_signal ? " (they said so)" : "") + ". Build a full " + freed + "-minute replacement.");

  var askLines = ["THE REQUEST:"];
  if (intent.free_text) askLines.push("- Free text: \"" + intent.free_text + "\"");
  if (intent.category) askLines.push("- Category: " + intent.category + ".");
  if (intent.region) askLines.push("- Body region focus: " + intent.region.replace(/_/g, " ") + " (bias exercise selection to this region, inside the envelope).");
  if (intent.intensity) askLines.push("- Requested intensity: " + intent.intensity + " (but never above the envelope's band).");
  if (intent.readiness_signal) askLines.push("- The athlete is NOT FEELING IT — treat as a readiness signal (reduce intensity / lean recovery per the rules).");
  if (!intent.category && !intent.region && !intent.free_text) askLines.push("- No specific ask — build a balanced session serving the athlete's driver goals for the freed time.");
  add("request", askLines.join("\n"));

  add("envelope", ctx.envelopeText);
  if (ctx.weekContextText) add("week_context", ctx.weekContextText);
  if (ctx.matLoadNote) add("mat_load", ctx.matLoadNote);
  if (ctx.readinessText) add("readiness", ctx.readinessText);
  if (ctx.recencyText) add("recency", ctx.recencyText);
  if (ctx.progressionText) add("progression", ctx.progressionText);
  if (ctx.dossierText) add("dossier", ctx.dossierText);
  add("rules", rules.renderRulesForPrompt(["readiness", "deload", "interference", "time_compression", "volume", "pain", "progression"]));
  add("work_budget", rules.renderWorkBudgetGuidance());

  var user = parts.join("\n\n");
  sections._system = system.length;
  sections._user = user.length;
  sections._total = system.length + user.length;
  return { system: system, user: user, sections: sections };
}

/**
 * Serve a PRE-GENERATED anchor alternate instantly on a matching CATEGORY request
 * (the nightly pre-builds "miss_<category>" sessions). Region/free-text still
 * generate on-demand. Returns the structured session, or null.
 */
function matchGeneratedAlternate(intent, cache) {
  if (!cache || !Array.isArray(cache.alternates)) return null;
  if (!intent.category || intent.region || intent.duration_min || intent.intensity) return null;
  var want = String(intent.category).toLowerCase();
  var hit = cache.alternates.filter(function (a) {
    if (String(a.source || "").indexOf("generate") < 0) return false;
    var s = a.session_structured || a.session;
    return s && String(s.category || "").toLowerCase() === want;
  })[0];
  return hit ? (hit.session_structured || hit.session) : null;
}

// ── Variant-specific invariants ─────────────────────────────────────────────
/**
 * Run against the variant output. Reuses the planner's structural invariants
 * (anchor integrity, segment enum, time_seconds, why, time-budget) via the
 * caller, and adds the two variant-only checks:
 *   - constraint_honored: the output reflects the requested constraint
 *   - contraindication_free: no exercise conflicts with an active injury flag
 * Both FLAG, never silently pass — same discipline as the planner set.
 *
 * @returns {{problems:Array}}
 */
function checkVariant(session, intent, dossier, opts) {
  opts = opts || {};
  var problems = [];
  // The constraint checks are skipped for an IMMOVABLE anchor being transformed
  // (nothing was reshaped), but they RUN for a GENERATED replacement — a generated
  // session must honor the request and fill the freed slot.
  var checkConstraints = !opts.isAnchor || opts.generated;

  // Duration honored. For a generated session the target is the FREED slot
  // duration; for a transform it is the requested duration.
  var wantDur = opts.generated ? (opts.freedMinutes || null) : (intent.duration_min != null ? intent.duration_min : null);
  if (wantDur != null && checkConstraints) {
    var stated = Number(session.duration_min) || 0;
    var tol = Math.max(5, Math.floor(wantDur * 0.15)); // looser than the internal budget — a "~30 min" ask is approximate
    if (Math.abs(stated - wantDur) > tol) {
      problems.push({ invariant: "constraint_honored", severity: "flagged", detail: (opts.generated ? "freed slot is ~" : "requested ~") + wantDur + " min but the session is " + stated + " min (tol " + tol + ")" });
    }
  }
  // Intensity honored.
  if (intent.intensity && checkConstraints && !opts.refused) {
    if (String(session.intensity || "").toLowerCase() !== intent.intensity) {
      problems.push({ invariant: "constraint_honored", severity: "flagged", detail: "requested intensity " + intent.intensity + " but the session is " + session.intensity });
    }
  }
  // Category honored.
  if (intent.category && checkConstraints && !opts.refused) {
    if (String(session.category || "").toLowerCase() !== String(intent.category).toLowerCase()) {
      problems.push({ invariant: "constraint_honored", severity: "flagged", detail: "requested category " + intent.category + " but the session is " + session.category });
    }
  }

  // Contraindication — a variant must never introduce work conflicting with an
  // active injury flag. This one is the safety net: even a 'refused' variant
  // must not itself contain contraindicated work.
  var ci = contraindications(session, dossier);
  ci.forEach(function (h) {
    problems.push({ invariant: "contraindication_free", severity: "flagged", detail: h.exercise + " conflicts with injury flag '" + h.injury_area + "' (matched '" + h.conflict + "')" });
  });

  return { problems: problems, contraindications: ci };
}

module.exports = {
  classifyRequest, isCodeOnly, matchCachedAlternate, matchGeneratedAlternate, contraindications,
  buildVariantPrompt, buildGeneratePrompt, checkVariant,
  normRegion,
  // re-exported for the caller's convenience
  compress: ar.compressSessionToDuration,
  extractJSON: ar.extractJSON,
};
