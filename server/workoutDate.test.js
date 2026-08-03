// Session #47 — the malformed-`workouts.date` defect.
//
// Two things are proven here:
//   1. wearables/fitbit.js normalize() derives a correct `date` from BOTH Fitbit
//      shapes. The DETAIL shape (startDate + "HH:mm" startTime) is what produced
//      8 corrupt profile-1 rows; the LIST shape must stay byte-identical.
//   2. server.js isValidWorkoutDate() — the ONE validator now shared by all three
//      workout-insert paths — accepts real dates and rejects everything that was
//      ever observed in the corrupt rows.
//
// The adapter is `require`d directly (it is a plain CommonJS module), so this
// runs the REAL shipped function with no source slicing — the extraction bug
// class from the arc close-out (learning #2) does not apply here.
//
// Run: node --test server/workoutDate.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fitbit = require('../wearables/fitbit.js');

// ── Real fixtures ──────────────────────────────────────────────────────────
// Captured verbatim from production profile 1 on 2026-08-03 via
// GET /api/workouts/100143/full -> wearable_data.raw_response. This is the exact
// payload that produced `date: "10:14"`.
const DETAIL_SHAPE = {
  logId: 1898484359571015200,
  activityId: 90019,
  name: 'Martial arts',
  activityParentName: 'Martial arts',
  startDate: '2026-07-28',
  startTime: '10:14',
  hasStartTime: true,
  duration: 3641000,
  calories: 589,
  lastModified: '2026-07-28T16:15:02.340Z',
};

// The LIST endpoint's shape for the same activity — a full ISO datetime.
const LIST_SHAPE = {
  logId: 1898484359571015200,
  activityName: 'Martial arts',
  startTime: '2026-07-28T10:14:00.000-05:00',
  duration: 3641000,
  calories: 589,
};

test('DETAIL shape: date comes from startDate, NOT from slicing the time string', () => {
  const n = fitbit.normalize(DETAIL_SHAPE);
  assert.strictEqual(n.date, '2026-07-28');
  assert.notStrictEqual(n.date, '10:14', 'the exact corruption that shipped 8 rows');
  assert.match(n.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('DETAIL shape: start_time is recombined into a parseable wall-clock datetime', () => {
  const n = fitbit.normalize(DETAIL_SHAPE);
  assert.ok(!isNaN(Date.parse(n.start_time)),
    'was NaN before the fix, which is why fetchIntradayHr always bailed on this path');
  // Wall-clock HH:mm must survive — fetchIntradayHr reads it back out.
  assert.ok(n.start_time.indexOf('10:14') >= 0);
});

test('LIST shape: unchanged — full ISO datetime still slices to its date', () => {
  const n = fitbit.normalize(LIST_SHAPE);
  assert.strictEqual(n.date, '2026-07-28');
  assert.strictEqual(n.start_time, '2026-07-28T10:14:00.000-05:00',
    'the list path must be byte-identical to pre-fix behaviour');
});

test('both shapes agree on the date for the SAME activity', () => {
  assert.strictEqual(fitbit.normalize(DETAIL_SHAPE).date, fitbit.normalize(LIST_SHAPE).date);
});

test('unrecognised shape yields a NULL date, never a wrong one', () => {
  const n = fitbit.normalize({ logId: 1, activityName: 'X', startTime: 'garbage' });
  assert.strictEqual(n.date, null,
    'a null date is rejected by the insert guards; a wrong date is silent');
});

test('every real corrupt value, replayed through the fixed normalizer, now dates correctly', () => {
  // stored `date` -> the true date, from each row's own wearable_data.raw_response
  const rows = [
    ['10:20', '2026-05-28'], ['10:07', '2026-06-02'], ['19:37', '2026-06-09'],
    ['13:00', '2026-06-15'], ['12:52', '2026-07-14'], ['10:12', '2026-07-21'],
    ['10:14', '2026-07-28'], ['10:52', '2026-07-29'],
  ];
  for (const [startTime, startDate] of rows) {
    const n = fitbit.normalize({ logId: 1, name: 'X', startDate, startTime, duration: 60000 });
    assert.strictEqual(n.date, startDate, 'row that stored ' + startTime);
  }
});

// ── isValidWorkoutDate, extracted from the real shipped server.js ──────────
function grabFunction(src, name) {
  const marker = 'function ' + name + '(';
  const start = src.indexOf(marker);
  assert.ok(start >= 0, 'function ' + name + ' not found in server.js');
  let i = src.indexOf('{', start), depth = 0, end = -1;
  let inS = null, inC = null;
  for (; i < src.length; i++) {
    const c = src[i], n2 = src[i + 1];
    if (inC === 'line') { if (c === '\n') inC = null; continue; }
    if (inC === 'block') { if (c === '*' && n2 === '/') { inC = null; i++; } continue; }
    if (inS) { if (c === '\\') { i++; continue; } if (c === inS) inS = null; continue; }
    if (c === '/' && n2 === '/') { inC = 'line'; i++; continue; }
    if (c === '/' && n2 === '*') { inC = 'block'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, 'unbalanced braces extracting ' + name);
  const slice = src.slice(start, end);
  // Over-capture guard (arc close-out learning #2): no OTHER column-0
  // declaration may appear inside the slice, and the slice must re-parse.
  assert.ok(!/\n(?:async )?function [a-zA-Z_$]/.test(slice.slice(marker.length)),
    'over-captured: another top-level function is inside the ' + name + ' slice');
  assert.ok(!/\napp\.(get|post|patch|delete)\(/.test(slice), 'over-captured: an express route is inside the slice');
  new vm.Script(slice); // must re-parse standalone
  return slice;
}

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(grabFunction(serverSrc, 'isValidWorkoutDate') + '\nglobalThis.__f = isValidWorkoutDate;', ctx);
const isValidWorkoutDate = ctx.__f;

test('isValidWorkoutDate accepts real dates', () => {
  for (const d of ['2026-07-28', '2024-02-29', '2026-01-01', '2026-12-31']) {
    assert.strictEqual(isValidWorkoutDate(d), true, d);
  }
});

test('isValidWorkoutDate rejects every value observed in the corrupt rows', () => {
  for (const d of ['10:20', '10:07', '19:37', '13:00', '12:52', '10:12', '10:14', '10:52']) {
    assert.strictEqual(isValidWorkoutDate(d), false, d);
  }
});

test('isValidWorkoutDate rejects empty, null, and well-formed-but-impossible dates', () => {
  for (const d of [null, undefined, '', '2026-02-31', '2026-13-01', '2026-00-10', '2026-7-28', '2026-07-28T10:14', 'yesterday', 0, {}]) {
    assert.strictEqual(isValidWorkoutDate(d), false, JSON.stringify(d));
  }
});
