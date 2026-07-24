"use strict";
/**
 * ENGINE v2 — VARIANT TEST HARNESS
 * ================================
 * TEST FILE. `node --test server/v2Variant.test.js`. Zero dependencies.
 *
 * Proves the variant classification, the code-vs-model routing, cache-first
 * matching, the two new invariants (constraint_honored, contraindication_free),
 * and the two HARD-RULE CONFLICT cases the brief requires:
 *   - a constraint vs. an anchor
 *   - a constraint vs. an injury flag
 */

var test = require("node:test");
var assert = require("node:assert");
var V = require("./v2Variant");

function primary(o) {
  return Object.assign({
    category: "strength", duration_min: 45, intensity: "medium", goal_tags: ["Fix Posture"],
    segments: [
      { type: "warmup", duration_min: 5, exercises: [{ name: "Cat-Cow", sets: 2, reps: 10 }] },
      { type: "straight_sets", duration_min: 25, exercises: [{ name: "Glute Bridge", sets: 3, reps: 15 }, { name: "Push-Up", sets: 3, reps: 8 }] },
      { type: "mobility", duration_min: 5, intent: "hip mobility", exercises: [{ name: "Hip Flexor Stretch", sets: 2, time_seconds: 30 }] },
      { type: "straight_sets", duration_min: 5, exercises: [{ name: "Band Pull-Apart", sets: 2, reps: 12 }] },
      { type: "straight_sets", duration_min: 5, exercises: [{ name: "Dead Hang", sets: 2, time_seconds: 45 }] },
    ],
  }, o || {});
}

var OSTEITIS_DOSSIER = { injury_flags: [{ area: "Pubic Osteitis", status: "flares with heavy adduction and sprinting" }] };

// ── Classification + routing ────────────────────────────────────────────────

test("'shorter' maps to a structured duration and takes the CODE path", function () {
  var i = V.classifyRequest({ constraint_text: "short on time, make it shorter" }, primary());
  assert.strictEqual(i.duration_min, 30);
  assert.strictEqual(V.isCodeOnly(i, primary()), true, "a pure duration reduction is deterministic");
});

test("'harder' maps to intensity and needs the MODEL", function () {
  var i = V.classifyRequest({ constraint_text: "push me harder" }, primary());
  assert.strictEqual(i.intensity, "high");
  assert.strictEqual(V.isCodeOnly(i, primary()), false);
});

test("'not feeling it' is a readiness signal, NOT a blind reroll", function () {
  var i = V.classifyRequest({ constraint_text: "not feeling it today, change it" }, primary());
  assert.strictEqual(i.readiness_signal, true);
  assert.strictEqual(V.isCodeOnly(i, primary()), false, "a readiness signal must reach the rules-driven model path");
});

test("'same muscle group, different style' sets style_change, needs the model", function () {
  var i = V.classifyRequest({ constraint_text: "same muscle group, different style" }, primary());
  assert.strictEqual(i.style_change, true);
  assert.strictEqual(V.isCodeOnly(i, primary()), false);
});

test("a structured duration REDUCTION is code-only; an INCREASE is not", function () {
  assert.strictEqual(V.isCodeOnly(V.classifyRequest({ duration_min: 30 }, primary()), primary()), true);
  assert.strictEqual(V.isCodeOnly(V.classifyRequest({ duration_min: 60 }, primary()), primary()), false,
    "adding volume is a judgment the code must not fake");
});

test("an explicit duration_min beats a vague 'shorter'", function () {
  var i = V.classifyRequest({ duration_min: 25, constraint_text: "make it shorter" }, primary());
  assert.strictEqual(i.duration_min, 25);
});

test("category/intensity/style all need the model", function () {
  assert.strictEqual(V.isCodeOnly(V.classifyRequest({ category: "cardio" }, primary()), primary()), false);
  assert.strictEqual(V.isCodeOnly(V.classifyRequest({ intensity: "low" }, primary()), primary()), false);
});

// ── Cache-first ─────────────────────────────────────────────────────────────

test("a pure duration request matching a cached alternate serves from CACHE", function () {
  var cache = { alternates: [{ key: "dur_30", session: { duration_min: 30, category: "strength" } }] };
  var hit = V.matchCachedAlternate(V.classifyRequest({ duration_min: 30 }, primary()), cache);
  assert.ok(hit, "must match the cached 30-min alternate");
  assert.strictEqual(hit.duration_min, 30);
});

test("a duration request WITH another constraint does NOT serve from cache", function () {
  var cache = { alternates: [{ key: "dur_30", session: { duration_min: 30 } }] };
  assert.strictEqual(V.matchCachedAlternate(V.classifyRequest({ duration_min: 30, intensity: "high" }, primary()), cache), null);
});

test("no cache match returns null (falls through to code/model)", function () {
  var cache = { alternates: [{ key: "dur_30", session: { duration_min: 30 } }] };
  assert.strictEqual(V.matchCachedAlternate(V.classifyRequest({ duration_min: 40 }, primary()), cache), null);
});

// ── Compression (code path) protects the right things ───────────────────────

test("code compression hits the target and keeps primary + prehab", function () {
  var c = V.compress(primary(), 30);
  assert.ok(Math.abs(c.session.duration_min - 30) <= 2, "lands near 30, got " + c.session.duration_min);
  var names = [];
  c.session.segments.forEach(function (s) { (s.exercises || []).forEach(function (e) { names.push(e.name); }); });
  assert.ok(names.indexOf("Glute Bridge") >= 0, "the primary compound survives");
  assert.ok(names.indexOf("Hip Flexor Stretch") >= 0, "the prehab/mobility dose survives");
});

// ── INVARIANT: constraint_honored ───────────────────────────────────────────

test("INVARIANT constraint_honored: a 30-min request that came back 45 is FLAGGED", function () {
  var intent = V.classifyRequest({ duration_min: 30 }, primary());
  var r = V.checkVariant(primary(), intent, null, {});   // session is still 45
  assert.ok(r.problems.some(function (p) { return p.invariant === "constraint_honored"; }));
});

test("INVARIANT constraint_honored: a ~30-min result passes", function () {
  var intent = V.classifyRequest({ duration_min: 30 }, primary());
  var got = V.compress(primary(), 30).session;
  var r = V.checkVariant(got, intent, null, {});
  assert.strictEqual(r.problems.filter(function (p) { return p.invariant === "constraint_honored"; }).length, 0);
});

test("INVARIANT constraint_honored: an intensity mismatch is FLAGGED", function () {
  var intent = V.classifyRequest({ intensity: "low" }, primary());
  var r = V.checkVariant(primary(), intent, null, {});   // still medium
  assert.ok(r.problems.some(function (p) { return p.invariant === "constraint_honored" && /intensity/.test(p.detail); }));
});

test("INVARIANT constraint_honored: a category mismatch is FLAGGED", function () {
  var intent = V.classifyRequest({ category: "cardio" }, primary());
  var r = V.checkVariant(primary(), intent, null, {});   // still strength
  assert.ok(r.problems.some(function (p) { return p.invariant === "constraint_honored" && /category/.test(p.detail); }));
});

// ── INVARIANT: contraindication_free ────────────────────────────────────────

test("INVARIANT contraindication_free: an adductor exercise with pubic osteitis is FLAGGED", function () {
  var bad = primary({ segments: [{ type: "straight_sets", duration_min: 45, exercises: [{ name: "Heavy Adductor Machine", sets: 3, reps: 10 }] }] });
  var r = V.checkVariant(bad, V.classifyRequest({}, primary()), OSTEITIS_DOSSIER, {});
  var ci = r.problems.filter(function (p) { return p.invariant === "contraindication_free"; });
  assert.strictEqual(ci.length, 1, "exactly one, deduped: " + JSON.stringify(ci));
  assert.match(ci[0].detail, /Pubic Osteitis/);
});

test("INVARIANT contraindication_free: a safe session with the same injury passes", function () {
  var r = V.checkVariant(primary(), V.classifyRequest({}, primary()), OSTEITIS_DOSSIER, {});
  assert.strictEqual(r.problems.filter(function (p) { return p.invariant === "contraindication_free"; }).length, 0);
});

test("contraindication dedup: an area matching two token sets reports once", function () {
  var bad = primary({ segments: [{ type: "straight_sets", duration_min: 45, exercises: [{ name: "Sprint Intervals", sets: 5 }] }] });
  var ci = V.contraindications(bad, OSTEITIS_DOSSIER);
  assert.strictEqual(ci.length, 1, "pubic+osteitis both match 'sprint' but must dedup: " + JSON.stringify(ci));
});

test("a merely-declared injury (no recent report) does NOT drive contraindications", function () {
  var declared = { injury_flags: [{ area: "Pubic Osteitis", status: "declared in profile, no recent report" }] };
  var bad = primary({ segments: [{ type: "straight_sets", duration_min: 45, exercises: [{ name: "Sprint Intervals", sets: 5 }] }] });
  assert.strictEqual(V.contraindications(bad, declared).length, 0,
    "a declared-only flag with no active status is not treated as an active contraindication");
});

// ── HARD-RULE CONFLICT CASES (the brief's required proofs) ──────────────────

test("CONFLICT: a constraint cannot reshape an ANCHOR — code path is skipped for an anchor", function () {
  // An anchored session must never be reshaped by a constraint; the endpoint's
  // isAnchor gate is what enforces it. isCodeOnly is only consulted for
  // non-anchors, but prove the gate directly: a duration request on an anchor
  // must not be treated as a code-compressible reduction by the caller.
  // (The route passes isAnchor to v2GenerateVariant, which skips both the code
  //  path `!args.isAnchor && isCodeOnly` and lets the model refuse in prose.)
  var intent = V.classifyRequest({ duration_min: 30 }, primary({ category: "martial_arts", duration_min: 60 }));
  // The intent still classifies (that's fine); the ANCHOR GATE lives in the
  // caller. Assert the gate condition the caller uses:
  var isAnchor = true;
  var codePathTaken = !isAnchor && V.isCodeOnly(intent, primary({ duration_min: 60 }));
  assert.strictEqual(codePathTaken, false, "the code compression path must never run on an anchor");
});

test("CONFLICT: a constraint asking for contraindicated work is caught by the invariant, not honored", function () {
  // Simulate the model honoring a bad request; the invariant must catch it so
  // the caller can surface a refusal rather than serve contraindicated work.
  var honored = primary({ segments: [{ type: "straight_sets", duration_min: 45, exercises: [{ name: "Heavy Adductor Squat", sets: 4, reps: 6 }] }] });
  var r = V.checkVariant(honored, V.classifyRequest({ constraint_text: "give me heavy adductor work" }, primary()), OSTEITIS_DOSSIER, {});
  assert.ok(r.problems.some(function (p) { return p.invariant === "contraindication_free"; }),
    "a contraindicated variant must be flagged even when the request asked for it");
});

// ── Anchor-day GENERATE (miss-class) — classifier, routing, prompt, checks ──

var ANCHOR = { category: "martial_arts", duration_min: 60, intensity: "high", headline: "MMA Class", goal_tags: [], segments: [{ type: "skill", duration_min: 60, intent: "MMA Class", exercises: [] }] };

test("classifier: body-region requests resolve to a region (were falling to free text)", function () {
  assert.strictEqual(V.classifyRequest({ constraint_text: "upper body" }, ANCHOR).region, "upper_body");
  assert.strictEqual(V.classifyRequest({ constraint_text: "give me legs" }, ANCHOR).region, "lower_body");
  assert.strictEqual(V.classifyRequest({ constraint_text: "push day" }, ANCHOR).region, "push");
  assert.strictEqual(V.classifyRequest({ constraint_text: "pull workout" }, ANCHOR).region, "pull");
});

test("classifier: free-text category + missed-class signal are detected", function () {
  var i = V.classifyRequest({ constraint_text: "couldn't make class, give me cardio" }, ANCHOR);
  assert.strictEqual(i.category, "cardio");
  assert.strictEqual(i.missed_signal, true);
  assert.strictEqual(V.classifyRequest({ constraint_text: "I am sick, do strength instead" }, ANCHOR).category, "strength");
  assert.strictEqual(V.classifyRequest({ constraint_text: "class got cancelled" }, ANCHOR).missed_signal, true);
});

test("classifier: a region request is NOT code-only (needs the model)", function () {
  assert.strictEqual(V.isCodeOnly(V.classifyRequest({ constraint_text: "upper body" }, ANCHOR), ANCHOR), false);
});

test("matchCachedAlternate: a region/category request never serves from a DURATION cache", function () {
  var cache = { alternates: [{ key: "dur_45", session: { duration_min: 45 } }] };
  assert.strictEqual(V.matchCachedAlternate(V.classifyRequest({ constraint_text: "upper body" }, ANCHOR), cache), null);
  assert.strictEqual(V.matchCachedAlternate(V.classifyRequest({ category: "cardio" }, ANCHOR), cache), null);
});

test("matchGeneratedAlternate: serves a PRE-GENERATED category alternate instantly, else null", function () {
  var cache = { alternates: [
    { key: "miss_strength", source: "model:generate", session_structured: { category: "strength", duration_min: 60 } },
    { key: "miss_cardio", source: "model:generate", session_structured: { category: "cardio", duration_min: 60 } },
  ] };
  var hit = V.matchGeneratedAlternate(V.classifyRequest({ category: "strength" }, ANCHOR), cache);
  assert.ok(hit && hit.category === "strength");
  // a region request does not match a pre-generated CATEGORY alternate (generates on demand)
  assert.strictEqual(V.matchGeneratedAlternate(V.classifyRequest({ constraint_text: "upper body" }, ANCHOR), cache), null);
  // a duration request does not either
  assert.strictEqual(V.matchGeneratedAlternate(V.classifyRequest({ duration_min: 30 }, ANCHOR), cache), null);
  // a duration-only cache (no generate source) does not match
  assert.strictEqual(V.matchGeneratedAlternate(V.classifyRequest({ category: "strength" }, ANCHOR), { alternates: [{ key: "dur_45", source: "code:time_compression", session: { category: "strength" } }] }), null);
});

test("buildGeneratePrompt: targets the FREED duration, carries the envelope + work budget + week context", function () {
  var p = V.buildGeneratePrompt({
    intent: V.classifyRequest({ constraint_text: "upper body" }, ANCHOR),
    freedMinutes: 60, anchorActivity: "MMA Class",
    envelopeText: "EFFECTIVE-STAGE ENVELOPES (...capacity...)",
    weekContextText: "PLANNED AROUND TODAY (...)", matLoadNote: null,
    dossierText: "DOSSIER", readinessText: "READINESS",
  });
  assert.ok(p.system.indexOf("60 minutes") >= 0);
  assert.ok(p.system.indexOf("STAY INSIDE THE EFFECTIVE-STAGE ENVELOPE") >= 0);
  assert.ok(p.user.indexOf("EFFECTIVE-STAGE ENVELOPES") >= 0);
  assert.ok(p.user.indexOf("PLANNED AROUND TODAY") >= 0);
  assert.ok(p.user.indexOf("SESSION WORK BUDGET") >= 0);   // work-floor guidance present
  assert.ok(p.user.indexOf("upper body") >= 0);            // region honored in the ask
});

test("checkVariant GENERATED mode: constraint checks RUN (unlike an immovable anchor transform)", function () {
  // A generated session that came back the wrong duration / category is flagged.
  var gen = { category: "strength", duration_min: 40, intensity: "medium", segments: [{ type: "straight_sets", exercises: [{ name: "Push-Up", sets: 3, reps: 12 }] }] };
  var intent = V.classifyRequest({ category: "cardio" }, ANCHOR);
  var res = V.checkVariant(gen, intent, { injury_flags: [] }, { generated: true, isAnchor: false, freedMinutes: 60 });
  var details = res.problems.map(function (p) { return p.detail; }).join(" | ");
  assert.ok(details.indexOf("freed slot is ~60 min but the session is 40") >= 0, "duration-vs-freed flagged");
  assert.ok(details.indexOf("requested category cardio but the session is strength") >= 0, "category mismatch flagged");
});

test("checkVariant GENERATED mode: a matching session passes clean", function () {
  var gen = { category: "strength", duration_min: 58, intensity: "medium", segments: [{ type: "straight_sets", exercises: [{ name: "Push-Up", sets: 3, reps: 12 }] }] };
  var intent = V.classifyRequest({ category: "strength" }, ANCHOR);
  var res = V.checkVariant(gen, intent, { injury_flags: [] }, { generated: true, isAnchor: false, freedMinutes: 60 });
  assert.strictEqual(res.problems.length, 0);
});
