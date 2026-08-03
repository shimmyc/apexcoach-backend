// Session #47 — GET /api/workouts date-range params (?start_date=/?end_date=).
//
// Boots the REAL shipped server.js in-process with `node-fetch` stubbed via
// require.cache, and exercises the ACTUAL express route over HTTP against a real
// profile-1-shaped fixture. No source slicing, so the extraction bug class from
// the arc close-out does not apply.
//
// What is proven:
//   * absent params -> the outbound Supabase URL is BYTE-IDENTICAL to pre-change
//     (the backward-compatibility guarantee for every existing caller, including
//     loadWorkouts()'s limit=60 and the Log-past panel's offset paging);
//   * a range is translated to PostgREST date=gte./date=lte. filters;
//   * boundaries are INCLUSIVE on both ends;
//   * a malformed date is a 400, never a silently-ignored filter that would
//     return the wrong window;
//   * the default limit is untouched, so no prompt consumer's window changes.
//
// Run: node --test server/workoutsRange.test.js

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');

// ── Stub node-fetch BEFORE server.js is required ──────────────────────────
const calls = [];
// Fixture spans the real profile-1 window, incl. the April rows the athlete
// could not reach and one malformed-date row.
const FIXTURE = [
  { id: 100146, profile_id: 1, date: '2026-08-02', type: 'Strength', ts: 9 },
  { id: 100144, profile_id: 1, date: '2026-07-29', type: 'Walk', ts: 8 },
  { id: 60, profile_id: 1, date: '2026-05-09', type: 'Cardio', ts: 5 },
  { id: 30, profile_id: 1, date: '2026-04-30', type: 'Martial Arts', ts: 4 },
  { id: 10, profile_id: 1, date: '2026-04-07', type: 'Yoga', ts: 1 },
  { id: 77, profile_id: 1, date: '10:20', type: 'Martial Arts', ts: 2 },
];

function fakeFetch(url, opts) {
  calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
  const u = String(url);
  if (u.indexOf('/rest/v1/workouts') >= 0) {
    // Apply the gte/lte filters the route builds, so the assertions below are
    // about real filtering behaviour rather than a rubber-stamp.
    let rows = FIXTURE.slice();
    const gte = /[?&]date=gte\.([^&]+)/.exec(u);
    const lte = /[?&]date=lte\.([^&]+)/.exec(u);
    if (gte) rows = rows.filter(r => r.date >= decodeURIComponent(gte[1]));
    if (lte) rows = rows.filter(r => r.date <= decodeURIComponent(lte[1]));
    const lim = /[?&]limit=(\d+)/.exec(u);
    if (lim) rows = rows.slice(0, Number(lim[1]));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(rows), text: () => Promise.resolve(JSON.stringify(rows)) });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]), text: () => Promise.resolve('[]') });
}
require.cache[require.resolve('node-fetch')] = { id: require.resolve('node-fetch'), filename: require.resolve('node-fetch'), loaded: true, exports: fakeFetch };

process.env.PORT = process.env.PORT || '39471';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://stub.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'stub-key';

require(path.join(ROOT, 'server.js'));

const BASE = 'http://127.0.0.1:' + process.env.PORT;
function get(p) {
  return new Promise((res, rej) => {
    http.get(BASE + p, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} res({ status: r.statusCode, json: j, raw: d }); });
    }).on('error', rej);
  });
}
function lastWorkoutsUrl() {
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i].url.indexOf('/rest/v1/workouts') >= 0) return calls[i].url;
  return null;
}

test('no range params -> outbound URL is byte-identical to pre-change behaviour', async () => {
  calls.length = 0;
  const r = await get('/api/workouts?profile_id=1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(lastWorkoutsUrl(),
    'https://stub.supabase.co/rest/v1/workouts?select=*&order=ts.desc&limit=60&profile_id=eq.1',
    'any drift here changes the window every existing caller sees');
});

test('offset paging is unchanged', async () => {
  calls.length = 0;
  await get('/api/workouts?profile_id=1&limit=60&offset=60');
  assert.strictEqual(lastWorkoutsUrl(),
    'https://stub.supabase.co/rest/v1/workouts?select=*&order=ts.desc&limit=60&offset=60&profile_id=eq.1');
});

test('a date range becomes PostgREST gte/lte filters, default limit untouched', async () => {
  calls.length = 0;
  await get('/api/workouts?profile_id=1&start_date=2026-04-01&end_date=2026-04-30');
  const u = lastWorkoutsUrl();
  assert.ok(u.indexOf('&date=gte.2026-04-01') >= 0, u);
  assert.ok(u.indexOf('&date=lte.2026-04-30') >= 0, u);
  assert.ok(u.indexOf('limit=60') >= 0, 'default limit must not change');
});

test('April is reachable — the exact window the athlete could not see', async () => {
  const r = await get('/api/workouts?profile_id=1&limit=1000&start_date=2026-04-01&end_date=2026-04-30');
  assert.strictEqual(r.status, 200);
  const dates = r.json.workouts.map(w => w.date).sort();
  assert.deepStrictEqual(dates, ['2026-04-07', '2026-04-30']);
});

test('BOUNDARIES ARE INCLUSIVE on both ends', async () => {
  // Range == exactly the two edge dates. Both must come back.
  const r = await get('/api/workouts?profile_id=1&limit=1000&start_date=2026-04-07&end_date=2026-04-30');
  assert.deepStrictEqual(r.json.workouts.map(w => w.date).sort(), ['2026-04-07', '2026-04-30']);

  // One day inside each edge -> both excluded.
  const r2 = await get('/api/workouts?profile_id=1&limit=1000&start_date=2026-04-08&end_date=2026-04-29');
  assert.deepStrictEqual(r2.json.workouts.map(w => w.date), []);

  // A single-day range returns exactly that day.
  const r3 = await get('/api/workouts?profile_id=1&limit=1000&start_date=2026-04-07&end_date=2026-04-07');
  assert.deepStrictEqual(r3.json.workouts.map(w => w.date), ['2026-04-07']);
});

test('start_date alone and end_date alone each work', async () => {
  const a = await get('/api/workouts?profile_id=1&limit=1000&start_date=2026-07-01');
  assert.deepStrictEqual(a.json.workouts.map(w => w.date).sort(), ['2026-07-29', '2026-08-02']);
  const b = await get('/api/workouts?profile_id=1&limit=1000&end_date=2026-04-30');
  // '10:20' is present, and that is CORRECT — see the next test.
  assert.ok(b.json.workouts.some(w => w.date === '2026-04-07'));
  assert.ok(b.json.workouts.some(w => w.date === '2026-04-30'));
});

test('LEXICOGRAPHIC EDGE: a malformed-date row sorts BELOW every real date', async () => {
  // `workouts.date` is a `text` column, so gte/lte are string comparisons.
  // That is exactly right for zero-padded YYYY-MM-DD, but it means a corrupt
  // TIME string like '10:20' compares as less than any '2026-…' date:
  //   '10:20' <= '2026-04-30'  -> TRUE   ('1' < '2')
  //   '10:20' >= '2026-04-01'  -> FALSE
  // Consequences, both intentional and both verified here:
  //   * a TWO-SIDED range (what the UI always sends) EXCLUDES them;
  //   * a one-sided end_date-only range INCLUDES them.
  // The server deliberately does NOT filter these out: it reports what is
  // stored, and the client (historyDateIsValid) excludes them from date-keyed
  // surfaces while SURFACING THE COUNT, so corrupt rows are never silently
  // disappeared. The case vanishes entirely once
  // migrations/2026-08-03_repair_malformed_workout_dates.sql is run.
  const oneSided = await get('/api/workouts?profile_id=1&limit=1000&end_date=2026-04-30');
  assert.ok(oneSided.json.workouts.some(w => w.date === '10:20'),
    'one-sided end_date includes it — lexicographic, and worth knowing');

  const twoSided = await get('/api/workouts?profile_id=1&limit=1000&start_date=2026-04-01&end_date=2026-04-30');
  assert.ok(!twoSided.json.workouts.some(w => w.date === '10:20'),
    'a two-sided range — every range the UI sends — excludes it');
  assert.deepStrictEqual(twoSided.json.workouts.map(w => w.date).sort(), ['2026-04-07', '2026-04-30']);
});

test('a malformed range param is a 400, not a silently-ignored filter', async () => {
  for (const q of ['start_date=10:14', 'end_date=10:14', 'start_date=2026-13-01', 'start_date=April', 'end_date=2026-02-31']) {
    const r = await get('/api/workouts?profile_id=1&' + q);
    assert.strictEqual(r.status, 400, q + ' should be rejected');
    assert.strictEqual(r.json.success, false);
  }
});

test('empty range params are ignored, matching the offset convention', async () => {
  calls.length = 0;
  const r = await get('/api/workouts?profile_id=1&start_date=&end_date=');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(lastWorkoutsUrl(),
    'https://stub.supabase.co/rest/v1/workouts?select=*&order=ts.desc&limit=60&profile_id=eq.1');
});

test('a malformed-DATE row is returned as data, not filtered server-side', async () => {
  // The server stays honest about what is stored; excluding it is the CLIENT's
  // job (historyDateIsValid), so the count can be surfaced to the athlete.
  const r = await get('/api/workouts?profile_id=1&limit=1000');
  assert.ok(r.json.workouts.some(w => w.date === '10:20'));
});

test('the dedupe endpoint is DRY RUN by default and deletes nothing', async () => {
  calls.length = 0;
  const r = await new Promise((res, rej) => {
    const req = http.request(BASE + '/api/profiles/1/dedupe-workouts', { method: 'POST' }, rr => {
      let d = ''; rr.on('data', c => d += c); rr.on('end', () => res({ status: rr.statusCode, json: JSON.parse(d) }));
    });
    req.on('error', rej); req.end();
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.dry_run, true);
  assert.strictEqual(r.json.deleted, 0);
  assert.ok(Array.isArray(r.json.would_delete));
  assert.strictEqual(calls.filter(c => c.method === 'DELETE').length, 0,
    'a dry run must issue ZERO deletes');
});

test.after(() => process.exit(0));
