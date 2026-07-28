"use strict";
/**
 * Session #44 — regenerate in-flight guard + D3 banner copy.
 *
 * Extracts the real shipped grvRegenerateFromBanner / grvArcWeeks out of
 * public/index.html by source slicing and drives them in a vm sandbox, same
 * discipline as v2FoldedCards.test.js. A rename or deletion fails the extraction
 * rather than silently passing against a stale duplicate.
 *
 * Run: node --test server/regenGuard.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function slice(startMarker, endMarker) {
  const s = HTML.indexOf(startMarker);
  assert.ok(s >= 0, "marker not found: " + startMarker);
  const e = HTML.indexOf(endMarker, s + startMarker.length);
  assert.ok(e > s, "end marker not found: " + endMarker);
  return HTML.slice(s, e);
}

const SRC = [
  slice("// Earned position can be fractional", "function grvArcChipHtml(arc) {"),
  slice("// IN-FLIGHT GUARD (session #44).", "// PT Brain: the honest estimate"),
].join("\n");

// Over-capture guard + mandatory re-parse.
const decls = (SRC.match(/^function\s+([A-Za-z0-9_$]+)/gm) || []).map((s) => s.split(/\s+/)[1]);
assert.deepStrictEqual(decls.slice().sort(), ["grvArcWeeks", "grvRegenerateFromBanner"].sort(),
  "extraction captured unexpected functions: " + decls.join(","));

/** Sandbox with a controllable fetch. resolveWith/rejectWith settle it. */
function ctx(opts) {
  opts = opts || {};
  const calls = [];
  let settle = null;
  const sandbox = {
    console,
    currentProfileId: 4,
    grvGoalId: "g1",
    currentProfileData: { goals: [{ id: "g1", title: "Wrist" }] },
    grvFindGoal: (id) => (id === "g1" ? { id: "g1" } : null),
    grvContentEl: () => (opts.noContentEl ? null : { set innerHTML(v) { /* spinner */ } }),
    grvUpdateCachedGoal: () => {},
    renderGoalRoadmap: () => {},
    renderProfileGoals: () => {},
    grvShowFullError: (msg, retry) => { sandbox._errorShown = msg; sandbox._retryFn = retry; },
    document: {
      getElementById: (id) => (opts.button && id === "grv-regen-btn" ? opts.button : null),
    },
    fetch: (url) => {
      calls.push(url);
      return new Promise((res, rej) => { settle = { res, rej }; });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return {
    sandbox, calls,
    resolveWith: (body) => settle.res({ json: () => Promise.resolve(body) }),
    rejectWith: (e) => settle.rej(e || new Error("network")),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const OK = { success: true, goal: { id: "g1" } };

test("double-fire is impossible — the second call is dropped while in flight", async () => {
  const t = ctx();
  t.sandbox.grvRegenerateFromBanner();
  t.sandbox.grvRegenerateFromBanner();
  t.sandbox.grvRegenerateFromBanner();
  assert.strictEqual(t.calls.length, 1, "only one POST may be issued");
  assert.strictEqual(t.sandbox.grvRegenInFlight, true);
});

test("double-fire is impossible even when #grv-content is MISSING (the residual window)", async () => {
  // Without the guard this is the real exposure: `if (c)` skips, so the spinner
  // never replaces the banner and the button stays live in the DOM.
  const t = ctx({ noContentEl: true });
  t.sandbox.grvRegenerateFromBanner();
  t.sandbox.grvRegenerateFromBanner();
  assert.strictEqual(t.calls.length, 1);
});

test("guard RELEASES on success, so a later legitimate regenerate still works", async () => {
  const t = ctx();
  t.sandbox.grvRegenerateFromBanner();
  t.resolveWith(OK);
  await flush();
  assert.strictEqual(t.sandbox.grvRegenInFlight, false, "flag cleared after success");
  t.sandbox.grvRegenerateFromBanner();
  assert.strictEqual(t.calls.length, 2, "a second, sequential regenerate is allowed");
});

test("guard RELEASES on the grvShowFullError path — the Retry button is never stranded", async () => {
  const t = ctx();
  t.sandbox.grvRegenerateFromBanner();
  t.rejectWith();
  await flush();
  assert.strictEqual(t.sandbox._errorShown, "Could not regenerate — try again");
  assert.strictEqual(t.sandbox.grvRegenInFlight, false, "flag cleared after failure");
  t.sandbox._retryFn();                       // the real Retry closure
  assert.strictEqual(t.calls.length, 2, "Retry actually re-fires");
});

test("guard RELEASES when the server returns success:false (thrown, then caught)", async () => {
  const t = ctx();
  t.sandbox.grvRegenerateFromBanner();
  t.resolveWith({ success: false, error: "boom" });
  await flush();
  assert.strictEqual(t.sandbox.grvRegenInFlight, false);
});

test("guard RELEASES when the athlete navigated to another goal mid-flight", async () => {
  const t = ctx();
  t.sandbox.grvRegenerateFromBanner();
  t.sandbox.grvGoalId = "other";              // the `grvGoalId !== goalId` early return
  t.resolveWith(OK);
  await flush();
  assert.strictEqual(t.sandbox.grvRegenInFlight, false, "early return must still settle the flag");
});

test("a missing goal returns BEFORE the flag is set — it can never strand", () => {
  const t = ctx();
  t.sandbox.grvGoalId = "nope";
  t.sandbox.grvRegenerateFromBanner();
  assert.strictEqual(t.calls.length, 0);
  assert.strictEqual(t.sandbox.grvRegenInFlight, false);
});

test("the button is disabled on fire and re-enabled on settle", async () => {
  const button = { disabled: false, textContent: "Rebuild the phases anyway" };
  const t = ctx({ button });
  t.sandbox.grvRegenerateFromBanner();
  assert.strictEqual(button.disabled, true);
  assert.strictEqual(button.textContent, "Rebuilding…");
  t.resolveWith(OK);
  await flush();
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(button.textContent, "Rebuild the phases anyway");
});

// ── D3 copy ─────────────────────────────────────────────────────────────────
test("grvArcWeeks trims a trailing .0 and tolerates junk", () => {
  const t = ctx();
  const f = t.sandbox.grvArcWeeks;
  assert.strictEqual(f(0), "0");
  assert.strictEqual(f(5), "5");
  assert.strictEqual(f(3.0), "3");
  assert.strictEqual(f(4.5), "4.5");
  assert.strictEqual(f(2.25), "2.3");
  assert.strictEqual(f(null), "0");
  assert.strictEqual(f("x"), "0");
});

test("D3 copy shipped on BOTH readers, and the misleading old copy is gone", () => {
  assert.ok(HTML.includes("This plan is behind where you actually are"), "banner head");
  assert.ok(HTML.includes("Rebuild the phases anyway"), "CTA");
  assert.ok(HTML.includes("only logged sessions do that"), "banner body");
  assert.ok(HTML.includes("weeks earned. Only logged sessions move it."), "goal-card flag");
  assert.ok(!HTML.includes("Regenerate it to match reality"),
    "the old CTA promised something regenerate cannot deliver — must be gone");
  assert.ok(!HTML.includes("Regenerate this roadmap</button>"), "old button label must be gone");
  assert.ok(!HTML.includes("Roadmap needs regenerating &mdash; your training has drifted"),
    "old goal-card copy must be gone");
});
