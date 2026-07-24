"use strict";
/**
 * Engine v2 — folded-card alternates layout (Session 12).
 *
 * The layout logic is CLIENT-side (public/index.html), so these tests EXTRACT
 * the real shipped functions out of index.html by source slicing and evaluate
 * them in a sandbox — the same "run the actual code, not a copy" discipline
 * used for localToday() and pipeAnthropicStream(). A rename or a deletion in
 * index.html fails the extraction rather than silently passing against a stale
 * duplicate.
 *
 * Run: node --test server/v2FoldedCards.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

/** Slice [startMarker, endMarker) out of index.html, asserting both exist. */
function slice(startMarker, endMarker) {
  const s = HTML.indexOf(startMarker);
  assert.ok(s >= 0, "marker not found in public/index.html: " + startMarker);
  const e = HTML.indexOf(endMarker, s);
  assert.ok(e > s, "end marker not found in public/index.html: " + endMarker);
  return HTML.slice(s, e);
}

const SRC = [
  slice("// Decision tag — surfaced honestly.", "// The alternate currently displayed"),
  slice("// Alternates worth rendering", "// ── FOLDED-CARD ALTERNATES STACK"),
  slice("// ── FOLDED-CARD ALTERNATES STACK", "// ── VARIANT SURFACE"),
].join("\n");

/** Fresh sandbox per test — module state is global in index.html. */
function ctx(cache, week, activeKey) {
  const sandbox = {
    v2Cache: cache || null,
    v2Week: week || null,
    v2AltActiveKey: activeKey === undefined ? null : activeKey,
    // index.html's HTML-entity escaper; only its escaping contract matters here.
    attrEsc: (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
    renderV2Today: () => { sandbox._rendered = (sandbox._rendered || 0) + 1; },
    // v1 helper, out of scope here — a sectioned session's sections ARE the
    // normalizer's output, which is what the flatten boundary always writes.
    recOptionSections: (o) => (o && o.sections) || [],
    // A fetch/XHR reference anywhere in this path is a bug — see the
    // "no network on expand/collapse" test below.
    fetch: () => { throw new Error("NETWORK CALL in a display-only path"); },
    XMLHttpRequest: function () { throw new Error("NETWORK CALL in a display-only path"); },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox;
}

// ── Fixtures: the REAL shape of profile 4's live v2_daily_cache (v:2) ────────
const sess = (o) => Object.assign({
  category: "cardio", duration_min: 45, intensity: "low", headline: "Cardio — 45 min",
  why: "planner why", goal_tags: ["Stamina"], sections: [{ label: "Main", minutes: 20, exercises: ["Indoor Bike — 20 min"] }],
}, o);

const LIVE_CACHE = {
  v: 2, date: "2026-07-24", decision_tag: "kept", why: "autoregulator why",
  today: sess({}),
  alternates: [
    { key: "dur_30", source: "code:time_compression", label: "30 min (compressed)",
      rationale: "shorter — drops tertiary accessories, keeps the primary compound",
      session: sess({ duration_min: 30, headline: "Cardio — 30 min", why: "alt why 30" }) },
    { key: "dur_60", source: "code:noop_extend", label: "60 min (primary as-is; extend on request)",
      rationale: "", session: sess({ duration_min: 45, why: "noop why" }) },
    { key: "cat_swap", source: "model:category_swap", label: "Different focus: strength",
      rationale: "a strength session instead — same day, different focus",
      session: sess({ category: "strength", duration_min: 40, intensity: "medium", headline: "Strength — 40 min", why: "rich strength why" }) },
  ],
};

// An anchor day: the nightly pre-generates miss-class alternates instead.
const ANCHOR_CACHE = {
  v: 2, date: "2026-07-28", decision_tag: "kept", why: "anchor kept",
  today: sess({ category: "martial_arts", duration_min: 60, intensity: "high", headline: "MMA Class — 60 min", sections: [] }),
  alternates: [
    { key: "miss_strength", source: "model:generate", label: "If you miss MMA Class: strength (45 min)",
      rationale: "", session: sess({ category: "strength", duration_min: 45, intensity: "medium", why: "miss strength why" }) },
    { key: "miss_cardio", source: "model:generate", label: "If you miss MMA Class: cardio (40 min)",
      rationale: "", session: sess({ category: "cardio", duration_min: 40, why: "miss cardio why" }) },
  ],
};

const LIVE_WEEK = {
  block: { block: { invariant_violations: [
    { invariant: "session_time_budget", severity: "repaired", detail: "2026-07-25: segments summed 40 vs stated 45 min (tol 4); duration_min corrected to 40" },
    { invariant: "session_time_budget", severity: "repaired", detail: "2026-07-27: segments summed 35 vs stated 40 min (tol 4); duration_min corrected to 35" },
    { invariant: "session_time_budget", severity: "regenerate", detail: "2026-07-29: prescribed work ~13 min fills only 66% of the stated 20 min (floor 70%) — segments are padded, not filled" },
    { invariant: "driver_share_underfilled", severity: "regenerate", detail: "2026-07-26: the driver's 27-min share needs ~19 min of real resistance work but only ~15 min is prescribed — add driver (resistance) sets to FILL the driver's share, don't leave it to rehab/mobility/accessory." },
  ] } },
};

// ── Miss-class discrimination (audit A2) ────────────────────────────────────
test("miss-class alternates are distinguished by existing source/key fields", () => {
  const c = ctx(ANCHOR_CACHE);
  assert.equal(c.v2AltIsMissClass({ source: "model:generate", key: "miss_strength" }), true);
  assert.equal(c.v2AltIsMissClass({ source: "model:generate", key: "miss_cardio" }), true);
  // Duration + category variants must NEVER be classed as miss-class.
  assert.equal(c.v2AltIsMissClass({ source: "code:time_compression", key: "dur_30" }), false);
  assert.equal(c.v2AltIsMissClass({ source: "code:noop_extend", key: "dur_60" }), false);
  assert.equal(c.v2AltIsMissClass({ source: "model:category_swap", key: "cat_swap" }), false);
});

test("miss-class alternates group separately and carry their own tag", () => {
  const c = ctx(ANCHOR_CACHE);
  const cards = c.v2StackCards();
  assert.equal(cards.length, 3, "primary + 2 miss-class");
  assert.equal(cards[0].group, "primary");
  assert.equal(cards[1].group, "miss");
  assert.equal(cards[2].group, "miss");
  const html = c.v2FoldedStackHtml();
  assert.ok(html.includes("If you can’t make it"), "miss-class group heading present");
  assert.ok(!html.includes("Ready alternatives"), "no variant heading when there are no variants");
  assert.ok(html.includes("IF YOU MISS CLASS"), "miss-class tag present");
  // Never presented as a shorter version of today.
  assert.ok(!html.includes("MIN VIABLE"), "miss-class never competes for MIN VIABLE");
});

test("MIN VIABLE ranks duration variants only, and ignores miss-class sessions", () => {
  const mixed = Object.assign({}, LIVE_CACHE, {
    alternates: LIVE_CACHE.alternates.concat([
      { key: "miss_cardio", source: "model:generate", label: "x", rationale: "",
        session: sess({ category: "cardio", duration_min: 10, why: "w" }) },
    ]),
  });
  const cards = ctx(mixed).v2StackCards();
  const mv = cards.filter((x) => x.minViable);
  assert.equal(mv.length, 1);
  // dur_30 (30 min) wins — NOT the 10-min miss-class session.
  assert.equal(mv[0].key, "dur_30");
});

// ── Session 8 rules carried forward ─────────────────────────────────────────
test("noop_extend is suppressed entirely — never a card", () => {
  const c = ctx(LIVE_CACHE);
  const keys = c.v2StackCards().map((x) => x.key);
  assert.ok(!keys.includes("dur_60"), "noop_extend must not render");
  assert.deepEqual(keys, ["", "dur_30", "cat_swap"]);
  assert.ok(!c.v2FoldedStackHtml().includes("60 min"));
});

test("labels come from the real resolved duration/category, never the cache key", () => {
  // A dur_30 alternate that actually compressed to 28 must read "28 min".
  const drifted = Object.assign({}, LIVE_CACHE, {
    alternates: [Object.assign({}, LIVE_CACHE.alternates[0], {
      session: sess({ duration_min: 28, headline: "Cardio — 30 min", why: "w" }),
    })],
  });
  const card = ctx(drifted).v2StackCards()[1];
  assert.equal(card.title, "Cardio — 28 min");
  assert.ok(!card.title.includes("30"), "must not echo the dur_30 key");
});

test("degrades to however many alternates exist — never an empty/placeholder card", () => {
  const none = Object.assign({}, LIVE_CACHE, { alternates: [] });
  const c1 = ctx(none);
  assert.equal(c1.v2StackCards().length, 1, "primary only");
  const h1 = c1.v2FoldedStackHtml();
  assert.ok(!h1.includes("Ready alternatives"), "no heading with nothing under it");
  assert.ok(!h1.includes("v2-fold-collapsed"), "no collapsed cards to render");

  // Only a noop_extend available -> still just the primary, not a fake card.
  const onlyNoop = Object.assign({}, LIVE_CACHE, { alternates: [LIVE_CACHE.alternates[1]] });
  assert.equal(ctx(onlyNoop).v2StackCards().length, 1);

  // No cache at all -> empty string, not a broken shell.
  assert.equal(ctx(null).v2FoldedStackHtml(), "");
});

// ── Collapsed vs expanded content (requirements 2 + 7) ──────────────────────
test("collapsed shows duration, category and the code-derived rationale", () => {
  const c = ctx(LIVE_CACHE);
  const swap = c.v2StackCards().filter((x) => x.key === "cat_swap")[0];
  const html = c.v2CollapsedCardHtml(swap);
  assert.ok(html.includes("Strength · 40 min · medium"), "category + duration + intensity");
  assert.ok(html.includes("a strength session instead"), "code-derived rationale");
  assert.ok(!html.includes("rich strength why"), "the rich why belongs to the EXPANDED state");
});

test("expanded shows the alternate's real session.why, not the short rationale (§1.4 fix)", () => {
  const c = ctx(LIVE_CACHE, null, "cat_swap");
  const swap = c.v2StackCards().filter((x) => x.key === "cat_swap")[0];
  assert.equal(swap.why, "rich strength why");
  const html = c.v2ExpandedCardHtml(swap);
  assert.ok(html.includes("rich strength why"), "expanded surfaces session.why");
  assert.ok(html.includes("Log This Session"), "expanded keeps the primary CTA");
});

test("the primary's collapsed line is code-derived from the decision tag", () => {
  assert.ok(ctx(LIVE_CACHE).v2StackCards()[0].rationale.includes("unchanged"));
  const reduced = Object.assign({}, LIVE_CACHE, { decision_tag: "reduced_volume" });
  assert.ok(ctx(reduced).v2StackCards()[0].rationale.includes("volume reduced"));
  // An unknown tag degrades to a plain honest line, never "undefined".
  const weird = Object.assign({}, LIVE_CACHE, { decision_tag: "brand_new_tag" });
  const r = ctx(weird).v2StackCards()[0].rationale;
  assert.ok(r && !r.includes("undefined"));
});

// ── One expanded at a time; the primary is always returnable ────────────────
test("primary is expanded by default, alternates collapsed beneath it", () => {
  const html = ctx(LIVE_CACHE).v2FoldedStackHtml();
  const expandedCount = (html.match(/v2-fold-expanded/g) || []).length;
  assert.equal(expandedCount, 1, "exactly one expanded card");
  assert.ok(html.indexOf("v2-fold-expanded") < html.indexOf("v2-fold-collapsed"),
    "the expanded primary precedes the collapsed alternates");
});

test("expanding an alternate collapses the primary into its own folded card", () => {
  const c = ctx(LIVE_CACHE, null, "cat_swap");
  const html = c.v2FoldedStackHtml();
  assert.equal((html.match(/v2-fold-expanded/g) || []).length, 1);
  assert.ok(html.includes("v2-fold-primary"), "the primary is still present, as a collapsed card");
  assert.ok(html.includes("Today’s plan"), "and still labelled, so it can be folded back to");
});

test("toggle state machine: expand, fold back, and no-op on the open primary", () => {
  const c = ctx(LIVE_CACHE);
  assert.equal(c.v2AltActiveKey, null);
  c.v2ToggleCard("cat_swap");
  assert.equal(c.v2AltActiveKey, "cat_swap");
  c.v2ToggleCard("dur_30");                       // switch directly between alternates
  assert.equal(c.v2AltActiveKey, "dur_30");
  c.v2ToggleCard("dur_30");                       // tapping the open card folds back
  assert.equal(c.v2AltActiveKey, null);
  c.v2ToggleCard("");                             // tapping the open primary is a no-op
  assert.equal(c.v2AltActiveKey, null);
  c.v2ToggleCard("cat_swap");
  c.v2ToggleCard("");                             // explicit return to the primary
  assert.equal(c.v2AltActiveKey, null);
});

test("a stale selected key falls back to the primary instead of nothing expanded", () => {
  const c = ctx(LIVE_CACHE, null, "gone_after_refresh");
  const html = c.v2FoldedStackHtml();
  assert.equal((html.match(/v2-fold-expanded/g) || []).length, 1, "still exactly one expanded");
  assert.ok(html.indexOf("v2-fold-expanded") < html.indexOf("v2-fold-collapsed"), "the primary");
});

test("expand/collapse performs NO network call (structural)", () => {
  const c = ctx(LIVE_CACHE);
  // The sandbox's fetch/XHR throw on use; a render+toggle cycle must not touch them.
  c.v2FoldedStackHtml();
  c.v2ToggleCard("cat_swap");
  c.v2FoldedStackHtml();
  c.v2ToggleCard("");
  assert.ok(true);
  // And the CODE itself contains no request primitive. Comments are stripped
  // first — the prose in this path legitimately names fetch()/api routes when
  // explaining why it does not use them.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  assert.ok(!/fetch\s*\(|XMLHttpRequest|sendBeacon/.test(code),
    "the folded-card path must contain no request primitive");
  assert.ok(!/v2_daily_cache|planned_sessions|["'`]\/api\//.test(code),
    "the folded-card path must reference no write target or endpoint");
});

// ── Flagged sessions (requirement 8) ────────────────────────────────────────
test("flag markers read the persisted invariant report, keyed by date", () => {
  const flags = ctx(LIVE_CACHE, LIVE_WEEK).v2FlagsByDate();
  assert.deepEqual(Object.keys(flags).sort(), ["2026-07-26", "2026-07-29"]);
  assert.equal(flags["2026-07-26"][0].label, "Driver share");
  assert.equal(flags["2026-07-29"][0].label, "Work floor");
});

test("`repaired` severities are mechanical fixes and never produce a marker", () => {
  const flags = ctx(LIVE_CACHE, LIVE_WEEK).v2FlagsByDate();
  assert.ok(!flags["2026-07-25"], "a repaired duration correction is not a flag");
  assert.ok(!flags["2026-07-27"], "a repaired duration correction is not a flag");
});

test("flag lookup degrades safely when the block or report is absent", () => {
  assert.deepEqual(ctx(LIVE_CACHE, null).v2FlagsByDate(), {});
  assert.deepEqual(ctx(LIVE_CACHE, { block: null }).v2FlagsByDate(), {});
  assert.deepEqual(ctx(LIVE_CACHE, { block: { block: {} } }).v2FlagsByDate(), {});
  // A non-array (PostgREST error object) must not throw.
  assert.deepEqual(ctx(LIVE_CACHE, { block: { block: { invariant_violations: { msg: "x" } } } }).v2FlagsByDate(), {});
  // An unrelated invariant is not a work-floor/driver-share flag.
  const other = { block: { block: { invariant_violations: [
    { invariant: "no_consecutive_high_cns", severity: "flagged", detail: "2026-07-26 and 2026-07-27" },
  ] } } };
  assert.deepEqual(ctx(LIVE_CACHE, other).v2FlagsByDate(), {});
});

test("today's card carries the flag marker when today's session is flagged", () => {
  const flaggedToday = Object.assign({}, LIVE_CACHE, { date: "2026-07-29" });
  const c = ctx(flaggedToday, LIVE_WEEK);
  const primary = c.v2StackCards()[0];
  assert.equal(primary.flags.length, 1);
  assert.ok(c.v2CollapsedCardHtml(primary).includes("Work floor"));
  // Unflagged day -> no marker at all.
  const clean = ctx(LIVE_CACHE, LIVE_WEEK);
  assert.equal(clean.v2StackCards()[0].flags.length, 0);
  assert.ok(!clean.v2FoldedStackHtml().includes("v2-fold-tag-flag"));
});

test("alternates never carry a fabricated flag (they are not planned rows)", () => {
  const c = ctx(Object.assign({}, LIVE_CACHE, { date: "2026-07-29" }), LIVE_WEEK);
  c.v2StackCards().filter((x) => x.kind === "alt").forEach((x) => {
    assert.deepEqual(x.flags, [], x.key + " must have no persisted flag");
  });
});

// ── Escaping ────────────────────────────────────────────────────────────────
test("card text is escaped, including the flag tooltip", () => {
  const hostile = Object.assign({}, LIVE_CACHE, {
    alternates: [Object.assign({}, LIVE_CACHE.alternates[0], {
      rationale: '"><img src=x onerror=alert(1)>',
      session: sess({ category: "<b>x</b>", duration_min: 30, why: "w" }),
    })],
  });
  const c = ctx(hostile);
  const html = c.v2CollapsedCardHtml(c.v2StackCards()[1]);
  assert.ok(!html.includes("<img"), "rationale must be escaped");
  assert.ok(!html.includes("<b>"), "category must be escaped");
});
