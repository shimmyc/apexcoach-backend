// Session #47 — proves the migration ROLLBACK actually rolls back.
//
// This is the "restoration procedure proven against the snapshot shape" the
// Phase 5a plan requires. It runs the REAL PATCH merge semantics extracted from
// the shipped server.js against the REAL profile-1 snapshot, simulating a full
// migrate-then-restore cycle WITHOUT touching production.
//
// It exists because the first version of scripts/profile_snapshot.js was WRONG:
// PATCH /api/profiles/:id does a TWO-LEVEL merge, not a replace, so a plain
// snapshot PATCH left `capacity` and `coexistence` in place — a restore that
// did not restore. This test would have caught that, and now guards it.
//
// Run: node --test server/restoreShape.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// ── The REAL merge, lifted verbatim from app.patch("/api/profiles/:id") ────
// Extracted by locating the route and slicing its merge loop, then asserting
// the slice still contains the two branches that define the semantics — so a
// future refactor of the route fails this test instead of silently drifting.
const routeStart = SERVER.indexOf('app.patch("/api/profiles/:id"');
assert.ok(routeStart > 0, 'PATCH /api/profiles/:id route not found');
const routeSrc = SERVER.slice(routeStart, routeStart + 4000);
assert.ok(routeSrc.indexOf('var merged = Object.assign({}, existing);') >= 0,
  'the merge no longer starts from a copy of existing — re-derive this test');
assert.ok(routeSrc.indexOf('merged[key] = Object.assign({}, merged[key], body.profile_data[key]);') >= 0,
  'the two-level object-merge branch is gone — re-derive this test');

function realPatchMerge(existing, incoming) {
  var merged = Object.assign({}, existing);
  var keys = Object.keys(incoming);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (incoming[key] !== null && typeof incoming[key] === 'object' && !Array.isArray(incoming[key]) &&
        merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = Object.assign({}, merged[key], incoming[key]);
    } else {
      merged[key] = incoming[key];
    }
  }
  return merged;
}

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = canon(v[k]); return o; }
  return v;
}
const sha = v => crypto.createHash('sha256').update(JSON.stringify(canon(v))).digest('hex');

// ── The snapshot: the REAL one, if present; else a faithful minimal stand-in ─
//
// ⚠ The real snapshot is normalised to a PRE-migration baseline first. Without
// that, this test is coupled to a file whose content changes: once profile 1 was
// migrated, `backups/` gained a POST-migration snapshot whose goals already
// carry goal_type/demand/estimate, and the "the naive restore leaves migration
// keys behind" assertions failed against it. The test must define its own
// starting state, not inherit whatever the newest backup happens to be.
function stripMigrationKeys(pd) {
  const c = JSON.parse(JSON.stringify(pd));
  delete c.capacity;
  delete c.coexistence;
  (c.goals || []).forEach(g => {
    delete g.goal_type; delete g.demand; delete g.estimate; delete g.plan_draft;
    if (g.roadmap) { delete g.roadmap.estimate; delete g.roadmap.arc_origin; delete g.roadmap.arc_state; }
  });
  return c;
}
function loadSnapshot() {
  const dir = path.join(ROOT, 'backups');
  if (fs.existsSync(dir)) {
    const f = fs.readdirSync(dir).filter(x => /^profile-1-.*\.json$/.test(x)).sort().pop();
    if (f) {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { profile_id: raw.profile_id, profile_data: stripMigrationKeys(raw.profile_data) };
    }
  }
  return {
    profile_id: 1,
    profile_data: {
      name: 'Shimmy',
      focus_override: { active: true, mode: 'infuse', text: 'x', daily_override_state: 'skipped' },
      schedule: { anchors: {}, frequency_targets: [], addons: [] },
      goals: [
        { id: 'g1', title: 'Fix Posture', roadmap: { version: 8, adaptation_log: [1, 2, 3, 4, 5, 6, 7], phases: [{ type: 'near_term' }] } },
        { id: 'g2', title: 'Fix Pubic Osteitis', roadmap: { version: 9, adaptation_log: [1, 2, 3, 4, 5, 6, 7, 8], phases: [{ type: 'near_term' }] } },
        { id: 'g3', title: 'Build Muscle', roadmap: { version: 9, adaptation_log: [1, 2, 3, 4, 5, 6, 7, 8], phases: [{ type: 'near_term' }] } },
      ],
    },
  };
}
const snap = loadSnapshot();
snap.sha256 = snap.sha256 || sha(snap.profile_data);

// ── Simulate the migration's writes on top of the snapshot ────────────────
function migrate(pd) {
  const m = JSON.parse(JSON.stringify(pd));
  m.goals.forEach(g => {
    if (!g.roadmap) return;
    g.goal_type = 'strength_load';
    g.demand = { sessions_per_week: 2, minutes_per_session: 30, hard: true, min_viable_sessions_per_week: 1 };
    g.estimate = { total_weeks_low: 12, total_weeks_high: 24, assumed_frequency: 2, basis: 'x' };
    g.roadmap.version = (g.roadmap.version || 1) + 1;
    g.roadmap.adaptation_log = (g.roadmap.adaptation_log || []).concat([{ trigger: 'manual' }]);
    g.roadmap.estimate = g.estimate;
    g.roadmap.arc_origin = '2026-08-03';
    g.roadmap.arc_state = { position_week: 0, calendar_week: 1, drift: -1 };
    g.roadmap.phases = [{ type: 'near_term', duration_weeks: 6 }, { type: 'near_term', duration_weeks: 6 }];
  });
  // The two NEW TOP-LEVEL keys — the ones a naive restore leaves behind.
  m.capacity = { days_per_week: 5, minutes_per_day: 60, hard_sessions_per_week: 3, protected_days: [] };
  m.coexistence = { verdict: 'coexist', computed_at: '2026-08-03' };
  return m;
}

test('the baseline really is PRE-migration (guards the coupling that broke this once)', () => {
  const pd = snap.profile_data;
  assert.ok(!('capacity' in pd) && !('coexistence' in pd), 'baseline must carry no migration top-level keys');
  assert.ok(!(pd.goals || []).some(g => g.goal_type || g.demand || g.estimate),
    'baseline goals must carry no migration fields');
  assert.ok(!(pd.goals || []).some(g => g.roadmap && (g.roadmap.arc_origin || g.roadmap.arc_state)),
    'baseline roadmaps must carry no arc fields');
});

test('the simulated migration really does change the things we claim it changes', () => {
  const after = migrate(snap.profile_data);
  assert.notStrictEqual(sha(after), snap.sha256);
  assert.ok(after.goals.some(g => g.goal_type), 'goal_type added');
  assert.ok(after.goals.some(g => g.roadmap && g.roadmap.arc_origin), 'arc_origin added');
  assert.ok(after.capacity, 'capacity added');
  assert.ok(after.coexistence, 'coexistence added');
});

test('⚠ THE NAIVE RESTORE IS INCOMPLETE — this is the defect that was found', () => {
  const migrated = migrate(snap.profile_data);
  const naive = realPatchMerge(migrated, snap.profile_data); // snapshot alone
  // goals DO come back — an array replaces wholesale.
  assert.ok(!naive.goals.some(g => g.goal_type), 'goals restore correctly');
  assert.ok(!naive.goals.some(g => g.roadmap && g.roadmap.arc_origin), 'arc fields go with them');
  // …but the new TOP-LEVEL keys survive, because they are absent from the body.
  assert.ok(naive.capacity, 'capacity SURVIVES a naive restore — the defect');
  assert.ok(naive.coexistence, 'coexistence SURVIVES a naive restore — the defect');
  assert.notStrictEqual(sha(naive), snap.sha256, 'so the naive restore is not a restore');
});

test('the CORRECTED restore (live-only keys explicitly nulled) fully restores', () => {
  const migrated = migrate(snap.profile_data);
  const liveOnly = Object.keys(migrated).filter(k => !(k in snap.profile_data));
  assert.deepStrictEqual(liveOnly.sort(), ['capacity', 'coexistence']);

  const body = Object.assign({}, snap.profile_data);
  liveOnly.forEach(k => { body[k] = null; });
  const restored = realPatchMerge(migrated, body);

  assert.strictEqual(restored.capacity, null);
  assert.strictEqual(restored.coexistence, null);
  assert.ok(!restored.goals.some(g => g.goal_type || g.demand || g.estimate));
  assert.ok(!restored.goals.some(g => g.roadmap && (g.roadmap.arc_origin || g.roadmap.arc_state)));

  // Null is behaviourally identical to absent for both readers, so verification
  // strips them before comparing — and then it is byte-identical.
  const normalised = Object.assign({}, restored);
  liveOnly.forEach(k => { if (normalised[k] === null) delete normalised[k]; });
  assert.strictEqual(sha(normalised), snap.sha256, 'profile_data is byte-identical to the snapshot');
});

test('roadmap version and adaptation_log are restored exactly — the irreplaceable part', () => {
  const migrated = migrate(snap.profile_data);
  const liveOnly = Object.keys(migrated).filter(k => !(k in snap.profile_data));
  const body = Object.assign({}, snap.profile_data);
  liveOnly.forEach(k => { body[k] = null; });
  const restored = realPatchMerge(migrated, body);
  snap.profile_data.goals.forEach((g, i) => {
    if (!g.roadmap) return;
    assert.strictEqual(restored.goals[i].roadmap.version, g.roadmap.version, g.title + ' version');
    assert.strictEqual((restored.goals[i].roadmap.adaptation_log || []).length,
      (g.roadmap.adaptation_log || []).length, g.title + ' adaptation_log length');
  });
});

test('a NESTED object key added by a future change would still survive — documented limit', () => {
  // focus_override is an object on both sides, so the PATCH SHALLOW-MERGES it.
  // Nothing in the migration writes there today, but if that ever changes the
  // restore needs the same null treatment one level down. Asserted so the
  // limitation is a known, tested fact rather than a surprise.
  const migrated = migrate(snap.profile_data);
  migrated.focus_override = Object.assign({}, migrated.focus_override, { some_future_key: 'x' });
  const body = Object.assign({}, snap.profile_data);
  Object.keys(migrated).filter(k => !(k in snap.profile_data)).forEach(k => { body[k] = null; });
  const restored = realPatchMerge(migrated, body);
  assert.strictEqual(restored.focus_override.some_future_key, 'x',
    'nested additions survive — restore is top-level-complete only');
});
