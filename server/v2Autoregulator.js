"use strict";
/**
 * ENGINE v2 — AUTOREGULATOR (nightly, Haiku, server-side)
 * =======================================================
 * IT EDITS A PLAN. IT NEVER INVENTS ONE.
 *
 * Given today's already-planned session, it adjusts against readiness, recent
 * performance and effort feedback, and returns the SAME session modified —
 * plus a decision tag and a one-line why. If there is no planned session for
 * today it emits an explicit rest state rather than generating something.
 *
 * Dependency-injected; no I/O of its own.
 */

var rules = require("./coachingRules");

var DECISION_TAGS = rules.DECISION_TAGS;   // kept|reduced_volume|reduced_intensity|swapped|recovery

// ── Prompt ──────────────────────────────────────────────────────────────────

var SYSTEM =
  "You are the NIGHTLY AUTOREGULATOR for a personal strength & conditioning coach.\n\n" +
  "A weekly PLANNER has already written today's session. Your ONLY job is to decide whether it " +
  "should be adjusted for how the athlete is actually recovering, and to return the SAME session " +
  "with those adjustments applied.\n\n" +
  "YOU EDIT A PLAN. YOU DO NOT WRITE ONE.\n" +
  "- Keep the session's category. Keep its shape. Keep the exercises unless a rule requires a swap.\n" +
  "- You MAY reduce volume (sets), reduce load or intensity, swap an exercise for a safer or " +
  "lower-CNS variant, or convert the whole session to active recovery.\n" +
  "- You MAY NOT invent a session, change the category, or add training that was not planned.\n" +
  "- If the session is marked IMMOVABLE (a fixed class), you may NOT reshape it at all — you may " +
  "only annotate its `why`. Return its segments byte-identical.\n" +
  "- The most common correct answer is 'kept'. Do not manufacture a change to look useful.\n\n" +
  "EVERY modification must be justified by the supplied RULES VERDICT or the coaching rules — not " +
  "by your own judgment about how the athlete probably feels. Readiness is always relative to this " +
  "athlete's own baseline, never a population norm.\n\n" +
  "SOURCING RULE — NON-NEGOTIABLE:\n" +
  "State NO numeric fact about this athlete's training history that is not present in this prompt. " +
  "Do not compute gaps, streaks or session counts from dates you see. The TRAINING RECENCY block is " +
  "the only source for how recently they have trained.\n\n" +
  "OUTPUT CONTRACT — STRICT JSON ONLY. No prose, no markdown, no fences.\n" +
  "{\n" +
  '  "decision": "kept|reduced_volume|reduced_intensity|swapped|recovery",\n' +
  '  "why": "ONE line, plain language, naming the actual reason",\n' +
  '  "session": {\n' +
  '    "category": "unchanged from the input",\n' +
  '    "duration_min": 45, "intensity": "low|medium|high",\n' +
  '    "why": "one line",\n' +
  '    "goal_tags": ["unchanged from the input"],\n' +
  '    "segments": [ { "type": "<same enum as the input>", "duration_min": 10, "intent": "one line",\n' +
  '                    "params": {},\n' +
  '                    "exercises": [ { "name": "...", "sets": 3, "reps": 8, "time_seconds": null,\n' +
  '                                     "distance": null, "load": "...", "rest": "...", "notes": "..." } ] } ]\n' +
  "  }\n" +
  "}\n\n" +
  "SCHEMA RULES:\n" +
  "- `time_seconds` IS ALWAYS SECONDS. A 45-second hold is `time_seconds: 45`. There is no minutes " +
  "field on an exercise; a timed block's length goes on the segment's `duration_min`.\n" +
  "- Segment `duration_min` values MUST sum to the session's `duration_min`.\n" +
  "- Use the same segment `type` values that came in.\n";

/**
 * @param {object} ctx
 *   plannedSession   the session jsonb from planned_sessions (REQUIRED)
 *   isAnchor         boolean — movable === false
 *   readinessText, recencyText, dossierText, progressionText
 *   yesterdayEffort  'more_in_tank'|'about_right'|'brutal'|null
 *   matLoadNote      string|null
 *   rulesText        the relevant rule sections only
 */
function buildAutoregulatorPrompt(ctx) {
  var parts = [];
  var sections = {};
  function add(name, text) {
    if (!text) return;
    parts.push(text);
    sections[name] = text.length;
  }

  add("today_session", "TODAY'S PLANNED SESSION (this is what you are editing):\n" +
    JSON.stringify(ctx.plannedSession, null, 1) +
    (ctx.isAnchor
      ? "\n\nTHIS SESSION IS IMMOVABLE (a fixed commitment). Return its segments EXACTLY as they are. You may only adjust its `why`. The only decisions available to you are 'kept'."
      : ""));
  add("readiness", ctx.readinessText);
  add("recency", ctx.recencyText);
  add("effort", ctx.yesterdayEffort
    ? "YESTERDAY'S EFFORT REPORT: \"" + ctx.yesterdayEffort + "\".\n" +
      "- 'more_in_tank' on two consecutive sessions of a lift is a progression trigger.\n" +
      "- 'brutal' means hold or reduce — it vetoes progression outright."
    : "YESTERDAY'S EFFORT REPORT: none submitted. Treat this as no signal — do not infer one.");
  add("mat_load", ctx.matLoadNote);
  add("dossier", ctx.dossierText);
  add("progression", ctx.progressionText);
  add("rules", ctx.rulesText);

  var user = parts.join("\n\n");
  sections._system = SYSTEM.length;
  sections._user = user.length;
  sections._total = SYSTEM.length + user.length;
  return { system: SYSTEM, user: user, sections: sections };
}

function extractJSON(raw) {
  var t = String(raw || "").trim();
  if (t.indexOf("```") >= 0) t = t.replace(/```+\s*json|```+/gi, "").trim();
  var s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; }
}

// ── "Is this a MODIFICATION, not a REPLACEMENT?" ────────────────────────────

function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function exerciseNames(session) {
  var out = [];
  ((session && session.segments) || []).forEach(function (seg) {
    (seg.exercises || []).forEach(function (ex) { if (ex && ex.name) out.push(normName(ex.name)); });
  });
  return out;
}

function totalSets(session) {
  var n = 0;
  ((session && session.segments) || []).forEach(function (seg) {
    (seg.exercises || []).forEach(function (ex) { n += Number(ex.sets) || 0; });
  });
  return n;
}

var INTENSITY_RANK = { low: 1, medium: 2, high: 3 };

/**
 * WHERE THE LINE IS.
 *
 * "A modification, not a replacement" needs a mechanical definition or it is
 * just a hope. The test is EXERCISE-NAME RETENTION between the planned session
 * and the returned one, with the required retention set by the decision tag —
 * because the tag is the model's own claim about how much it changed, and a
 * claim is checkable.
 *
 *   kept              -> the exercise SET must be unchanged (retention 1.0 both ways).
 *                        "kept" means kept.
 *   reduced_volume    -> >= 0.60 retained AND total sets must actually DECREASE.
 *   reduced_intensity -> >= 0.60 retained AND intensity lowered OR sets/loads reduced.
 *   swapped           -> >= 0.25 retained. A swap replaces SOME work, not all of it;
 *                        replacing everything is a new session wearing a tag.
 *   recovery          -> retention is NOT required (converting to active recovery
 *                        legitimately replaces the work) but intensity MUST be 'low'
 *                        and duration must not exceed the planned duration.
 *
 * Category is a hard invariant at every tag — changing it is writing a different
 * session, which the autoregulator may never do.
 *
 * Severity: a category change or a total-replacement-under-a-retention-tag is a
 * HARD REJECT (the caller reverts to the planned session — serving the plan is
 * always better than serving something invented). Everything else FLAGS.
 */
function assertIsModification(planned, adjusted, decision) {
  var problems = [];
  var hardReject = false;

  var pNames = exerciseNames(planned);
  var aNames = exerciseNames(adjusted);
  var pSet = {}; pNames.forEach(function (n) { pSet[n] = true; });
  var retainedCount = aNames.filter(function (n) { return pSet[n]; }).length;
  var retention = pNames.length ? (retainedCount / pNames.length) : 1;

  if (String(planned.category || "") !== String(adjusted.category || "")) {
    problems.push({
      check: "category_unchanged", severity: "rejected",
      detail: "category changed " + planned.category + " -> " + adjusted.category + " — the autoregulator may never change a session's category",
    });
    hardReject = true;
  }

  var minRetention = { kept: 1, reduced_volume: 0.6, reduced_intensity: 0.6, swapped: 0.25, recovery: 0 };
  var need = minRetention[decision];
  if (need === undefined) {
    problems.push({ check: "decision_tag_enum", severity: "flagged", detail: "unknown decision tag '" + decision + "'" });
    need = 0.6;
  }

  if (decision === "kept") {
    var sameCount = pNames.length === aNames.length;
    if (!sameCount || retention < 1) {
      problems.push({
        check: "kept_means_kept", severity: "flagged",
        detail: "decision is 'kept' but the exercise set changed (retention " + Math.round(retention * 100) + "%, " + pNames.length + " -> " + aNames.length + " exercises)",
      });
    }
  } else if (retention < need) {
    var sev = retention === 0 && decision !== "recovery" ? "rejected" : "flagged";
    if (sev === "rejected") hardReject = true;
    problems.push({
      check: "is_modification_not_replacement", severity: sev,
      detail: "decision '" + decision + "' requires >=" + Math.round(need * 100) + "% of the planned exercises retained; only " + Math.round(retention * 100) + "% were",
    });
  }

  // The tag must describe what actually happened.
  var pSets = totalSets(planned), aSets = totalSets(adjusted);
  if (decision === "reduced_volume" && aSets >= pSets) {
    problems.push({ check: "tag_matches_change", severity: "flagged", detail: "decision 'reduced_volume' but total sets did not decrease (" + pSets + " -> " + aSets + ")" });
  }
  if (decision === "reduced_intensity") {
    var pi = INTENSITY_RANK[String(planned.intensity || "").toLowerCase()] || 0;
    var ai = INTENSITY_RANK[String(adjusted.intensity || "").toLowerCase()] || 0;
    if (ai >= pi && aSets >= pSets) {
      problems.push({ check: "tag_matches_change", severity: "flagged", detail: "decision 'reduced_intensity' but neither intensity nor volume went down" });
    }
  }
  if (decision === "recovery") {
    if (String(adjusted.intensity || "").toLowerCase() !== "low") {
      problems.push({ check: "recovery_is_low_intensity", severity: "flagged", detail: "decision 'recovery' but intensity is '" + adjusted.intensity + "'" });
    }
    if (Number(adjusted.duration_min) > Number(planned.duration_min)) {
      problems.push({ check: "recovery_not_longer", severity: "flagged", detail: "decision 'recovery' but the session got longer (" + planned.duration_min + " -> " + adjusted.duration_min + " min)" });
    }
  }

  return { problems: problems, hardReject: hardReject, retention: Math.round(retention * 100) / 100 };
}

/**
 * An anchored session must come back byte-identical apart from `why`.
 * Checked structurally rather than trusting the prompt instruction.
 */
function assertAnchorUntouched(planned, adjusted) {
  var problems = [];
  var a = JSON.stringify(planned.segments || []);
  var b = JSON.stringify(adjusted.segments || []);
  if (a !== b) {
    problems.push({ check: "anchor_segments_untouched", severity: "rejected", detail: "an immovable session's segments were modified — reverting to the planned session" });
  }
  if (Number(planned.duration_min) !== Number(adjusted.duration_min)) {
    problems.push({ check: "anchor_duration_untouched", severity: "rejected", detail: "an immovable session's duration was changed " + planned.duration_min + " -> " + adjusted.duration_min });
  }
  return problems;
}

// ── Duration variants derived IN CODE (time-compression order) ──────────────

/**
 * Shrink a session to a target duration using the rules module's time
 * compression priority order, in code — the rules FULLY determine the outcome
 * here, so there is no judgment for a model to add:
 *   1. drop tertiary accessories
 *   2. superset the secondary work (modelled as a rest reduction on those segments)
 *   3. shorten rest
 *   4. NEVER drop the primary compound or the injury-prehab dose
 *
 * "Primary" = the first non-warmup working segment. "Prehab" = a segment whose
 * intent or type marks it as mobility/rehab/prehab. Everything else is
 * droppable, lowest-value last-first.
 */
var PROTECTED_SEGMENT_TYPES = ["warmup", "cooldown", "mobility", "active_recovery"];
var PREHAB_HINT = /(prehab|rehab|posture|mobil|stretch|activation|hip flexor|groin)/i;

function compressSessionToDuration(session, targetMin) {
  var out = JSON.parse(JSON.stringify(session));
  var segs = out.segments || [];
  if (!segs.length) { out.duration_min = targetMin; return { session: out, steps: ["no segments to compress"] }; }

  var steps = [];
  var plan = rules.timeCompressionPlan(targetMin, out.duration_min || segs.reduce(function (a, s) { return a + (Number(s.duration_min) || 0); }, 0));
  if (!plan.compress) {
    out.duration_min = targetMin;
    return { session: out, steps: ["target >= current; no compression needed"] };
  }

  // Identify the primary working segment (first non-warmup with exercises) and
  // any prehab segments. These are never dropped.
  var primaryIdx = -1;
  for (var i = 0; i < segs.length; i++) {
    if (PROTECTED_SEGMENT_TYPES.indexOf(segs[i].type) < 0 && (segs[i].exercises || []).length) { primaryIdx = i; break; }
  }
  var isProtected = function (seg, idx) {
    if (idx === primaryIdx) return true;
    if (PREHAB_HINT.test(String(seg.intent || "") + " " + String(seg.type || ""))) return true;
    return false;
  };

  var sum = function () { return (out.segments || []).reduce(function (a, s) { return a + (Number(s.duration_min) || 0); }, 0); };

  // Step 1 — drop tertiary accessories, from the END backwards (later segments
  // are the accessory tail by construction of how the planner builds a session).
  for (var j = out.segments.length - 1; j >= 0 && sum() > targetMin; j--) {
    if (isProtected(out.segments[j], j)) continue;
    if (out.segments.length <= 2) break;
    var dropped = out.segments.splice(j, 1)[0];
    steps.push("dropped accessory segment '" + (dropped.intent || dropped.type) + "' (" + dropped.duration_min + " min)");
    if (j < primaryIdx) primaryIdx--;
  }

  // Step 3 — shorten rest (modelled as trimming remaining non-protected
  // segments proportionally, never below 5 minutes).
  if (sum() > targetMin) {
    var over = sum() - targetMin;
    for (var k = out.segments.length - 1; k >= 0 && over > 0; k--) {
      if (isProtected(out.segments[k], k)) continue;
      var cur = Number(out.segments[k].duration_min) || 0;
      var canTrim = Math.max(0, cur - 5);
      var trim = Math.min(canTrim, over);
      if (trim > 0) {
        out.segments[k].duration_min = cur - trim;
        over -= trim;
        steps.push("shortened rest in '" + (out.segments[k].intent || out.segments[k].type) + "' by " + trim + " min");
      }
    }
  }

  // Last resort — trim the primary itself rather than lie about the duration.
  if (sum() > targetMin && primaryIdx >= 0 && out.segments[primaryIdx]) {
    var over2 = sum() - targetMin;
    var p = Number(out.segments[primaryIdx].duration_min) || 0;
    var t2 = Math.min(over2, Math.max(0, p - 5));
    if (t2 > 0) {
      out.segments[primaryIdx].duration_min = p - t2;
      steps.push("trimmed the primary block by " + t2 + " min (target could not be met otherwise; the compound itself was NOT dropped)");
    }
  }

  out.duration_min = sum();
  out.why = (out.why || "") + " [Shortened to ~" + targetMin + " min: " + plan.steps.join("; ") + ". " + plan.protect + "]";
  return { session: out, steps: steps, protect: plan.protect };
}

/**
 * A one-line, code-derived rationale for a cache alternate — from the
 * compression STEPS (duration variants) or the swap category (model swap). No
 * model call. `code:noop_extend` returns "" (the chip surface suppresses it).
 * Consumed at the cache-write boundary (v2AssembleCache).
 */
function deriveAlternateRationale(a) {
  if (!a) return "";
  if (a.source === "code:time_compression") {
    var steps = a.steps || [];
    var dropped = steps.some(function (t) { return /dropped accessory/i.test(t); });
    var trimmed = steps.some(function (t) { return /shortened rest|trimmed the primary/i.test(t); });
    if (dropped) return "shorter — drops tertiary accessories, keeps the primary compound";
    if (trimmed) return "shorter — tighter rest, keeps the primary compound";
    return "shorter — keeps the primary compound and prehab";
  }
  if (a.source === "model:category_swap") {
    var cat = (a.session && a.session.category) ? String(a.session.category).replace(/_/g, " ") : "different";
    return "a " + cat + " session instead — same day, different focus";
  }
  return "";
}

module.exports = {
  SYSTEM, buildAutoregulatorPrompt, extractJSON,
  assertIsModification, assertAnchorUntouched,
  compressSessionToDuration, deriveAlternateRationale,
  exerciseNames, totalSets,
  DECISION_TAGS,
};
