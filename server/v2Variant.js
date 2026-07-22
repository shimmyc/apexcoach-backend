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
    style_change: false,     // "same muscle group, different style"
    readiness_signal: false, // "not feeling it"
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
  }
  out.notes = notes;
  return out;
}

function normIntensity(v) {
  var s = String(v || "").toLowerCase();
  return (s === "low" || s === "medium" || s === "high") ? s : null;
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
  if (intent.category || intent.intensity || intent.style_change || intent.readiness_signal) return null;
  if (intent.duration_min == null) return null;
  var hit = cache.alternates.filter(function (a) {
    return a.session && Number(a.session.duration_min) === Number(intent.duration_min);
  })[0];
  return hit ? hit.session : null;
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
  "trap": ["upright row", "heavy shrug", "behind neck"],
  "neck": ["upright row", "behind neck", "heavy shrug", "bridge"],
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
    "- Segment `duration_min` values MUST sum to the session `duration_min`.\n" +
    "- Set `refused:true` only when you are refusing a contraindicated request; still return a safe session.\n";

  var parts = [];
  var sections = {};
  function add(name, text) { if (!text) return; parts.push(text); sections[name] = text.length; }

  add("today", "TODAY'S SESSION (this is what you are transforming" + (isAnchor ? " — IMMOVABLE, a fixed commitment" : "") + "):\n" + JSON.stringify(primary, null, 1));

  // The concrete ask.
  var askLines = ["THE REQUEST:"];
  if (intent.free_text) askLines.push("- Free text: \"" + intent.free_text + "\"");
  if (intent.duration_min) askLines.push("- Target duration: ~" + intent.duration_min + " min (the session's segments must sum to about this).");
  if (intent.intensity) askLines.push("- Target intensity: " + intent.intensity + ".");
  if (intent.category) askLines.push("- Change the category to: " + intent.category + " (a genuinely different kind of session; keep the duration).");
  if (intent.style_change) askLines.push("- SAME focus / muscle group / movement pattern, DIFFERENT style: keep the primary compound and the trained pattern, vary the accessory selection, structure and segment types.");
  if (intent.readiness_signal) askLines.push("- The athlete says they are NOT FEELING IT. Treat this as a readiness signal per the RULES VERDICT below — reduce intensity or convert toward recovery per the rules, do not just reshuffle exercises.");
  add("request", askLines.join("\n"));

  if (ctx.readinessText) add("readiness", ctx.readinessText);
  if (ctx.recencyText) add("recency", ctx.recencyText);
  if (ctx.dossierText) add("dossier", ctx.dossierText);
  // Only the rule sections a variant actually needs — keeps context small.
  add("rules", rules.renderRulesForPrompt(["readiness", "deload", "interference", "time_compression", "volume", "pain"]));

  var user = parts.join("\n\n");
  sections._system = system.length;
  sections._user = user.length;
  sections._total = system.length + user.length;
  return { system: system, user: user, sections: sections };
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

  // Duration honored — within the same tolerance the time-budget verifier uses.
  if (intent.duration_min != null && !opts.isAnchor) {
    var stated = Number(session.duration_min) || 0;
    var tol = Math.max(5, Math.floor(intent.duration_min * 0.15)); // looser than the internal budget — a "~30 min" ask is approximate
    if (Math.abs(stated - intent.duration_min) > tol) {
      problems.push({ invariant: "constraint_honored", severity: "flagged", detail: "requested ~" + intent.duration_min + " min but the variant is " + stated + " min (tol " + tol + ")" });
    }
  }
  // Intensity honored.
  if (intent.intensity && !opts.isAnchor && !opts.refused) {
    if (String(session.intensity || "").toLowerCase() !== intent.intensity) {
      problems.push({ invariant: "constraint_honored", severity: "flagged", detail: "requested intensity " + intent.intensity + " but the variant is " + session.intensity });
    }
  }
  // Category honored.
  if (intent.category && !opts.isAnchor && !opts.refused) {
    if (String(session.category || "").toLowerCase() !== String(intent.category).toLowerCase()) {
      problems.push({ invariant: "constraint_honored", severity: "flagged", detail: "requested category " + intent.category + " but the variant is " + session.category });
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
  classifyRequest, isCodeOnly, matchCachedAlternate, contraindications,
  buildVariantPrompt, checkVariant,
  // re-exported for the caller's convenience
  compress: ar.compressSessionToDuration,
  extractJSON: ar.extractJSON,
};
