#!/usr/bin/env node
/**
 * Profile snapshot + restore — the mandatory backup/rollback for the profile-1
 * migration (session #47).
 *
 *   node scripts/profile_snapshot.js snapshot 1
 *       Writes backups/profile-<id>-<utc>.json and prints its sha256.
 *       Read-only against production.
 *
 *   node scripts/profile_snapshot.js verify <file>
 *       Re-reads the sha and validates the snapshot's SHAPE against the
 *       invariants a restore depends on. No network.
 *
 *   node scripts/profile_snapshot.js diff <file> <profileId>
 *       Shows exactly which profile_data paths differ between the snapshot and
 *       production right now. Read-only. This is how you inspect blast radius
 *       mid-migration.
 *
 *   node scripts/profile_snapshot.js restore <file> [--apply]
 *       DRY RUN by default: prints the exact PATCH body and the diff it would
 *       apply. --apply performs the single PATCH that puts profile_data back.
 *
 * ⚠ HOW THE RESTORE ACTUALLY HAS TO WORK — read this before changing it.
 *   PATCH /api/profiles/:id does a TWO-LEVEL merge (server.js, the
 *   `merged[key] = Object.assign({}, merged[key], body.profile_data[key])`
 *   branch), NOT a wholesale replace:
 *     - a key present in the PATCH body whose value is a plain object on BOTH
 *       sides is SHALLOW-MERGED one level deeper;
 *     - a key present in the body with any other value (array, scalar, null)
 *       REPLACES;
 *     - a key ABSENT from the body is left untouched.
 *   So sending the snapshot alone is NOT a complete restore: `goals` comes back
 *   correctly (it is an array, so it replaces, taking every
 *   goal_type/demand/estimate/arc_state with it), but any NEW TOP-LEVEL KEY the
 *   migration introduced — `capacity`, `coexistence` — is absent from the
 *   snapshot and would therefore SURVIVE.
 *   The restore below fixes that by explicitly sending every live-only
 *   top-level key as `null`. `capacity`/`coexistence` are both read
 *   truthiness-first (`normalizeCapacity(pd.capacity)`,
 *   `pd.coexistence && ...`), so null is behaviourally identical to absent —
 *   which is why verification compares null and absent as equal rather than
 *   demanding a byte-identical sha.
 *
 * SCOPE: profile_data ONLY. The migration writes nothing else — no workouts, no
 * exercises, no top-level columns — so nothing else needs restoring. Verified in
 * the Phase 5a audit.
 *
 * BACKUPS ARE GITIGNORED (backups/) and must never be committed: profile_data
 * contains the athlete's full profile, including the base64 avatar.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = process.env.APEX_HOST || 'apexcoach-backend.onrender.com';
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

function req(method, p, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      host: HOST, path: p, method,
      headers: Object.assign({ accept: 'application/json' },
        data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
    }, x => {
      const c = []; x.on('data', d => c.push(d));
      x.on('end', () => {
        const s = Buffer.concat(c).toString('utf8');
        let j = null; try { j = JSON.parse(s); } catch (e) {}
        res({ status: x.statusCode, json: j, raw: s });
      });
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

// Canonical (recursively key-sorted) so a jsonb round-trip, which reorders
// object keys, cannot produce a phantom mismatch — ROADMAP §9, session #43.
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = canon(v[k]); return o; }
  return v;
}
const sha = v => crypto.createHash('sha256').update(JSON.stringify(canon(v))).digest('hex');

function diffPaths(a, b, p, out) {
  const aa = Array.isArray(a), ba = Array.isArray(b);
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null || aa !== ba) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: p, before: a, after: b });
    return out;
  }
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) diffPaths(a[k], b[k], p + '.' + k, out);
  return out;
}

// The invariants a restore depends on. If any fail, DO NOT MIGRATE.
function validateShape(snap) {
  const errs = [];
  if (!snap || typeof snap !== 'object') errs.push('snapshot is not an object');
  if (!snap.profile_id) errs.push('missing profile_id');
  const pd = snap.profile_data;
  if (!pd || typeof pd !== 'object') errs.push('missing profile_data object');
  else {
    if (!Array.isArray(pd.goals)) errs.push('profile_data.goals is not an array');
    else {
      pd.goals.forEach((g, i) => {
        if (!g || typeof g !== 'object') errs.push('goals[' + i + '] is not an object');
        else if (!g.id) errs.push('goals[' + i + '] (' + (g.title || '?') + ') has no id — restore matches by id');
      });
      const ids = pd.goals.map(g => g && g.id);
      if (new Set(ids).size !== ids.length) errs.push('duplicate goal ids — restore would be ambiguous');
    }
    if (!pd.schedule) errs.push('profile_data.schedule missing — the keystone join lives here');
  }
  if (snap.sha256 && snap.sha256 !== sha(pd)) errs.push('sha256 does not match profile_data — snapshot is corrupt');
  return errs;
}

function summarize(pd) {
  return {
    goal_count: (pd.goals || []).length,
    goals_with_roadmap: (pd.goals || []).filter(g => g.roadmap).length,
    roadmap_versions: (pd.goals || []).filter(g => g.roadmap).map(g => g.title + ' v' + g.roadmap.version + ' log' + ((g.roadmap.adaptation_log || []).length)),
    migration_keys_present: {
      any_goal_type: (pd.goals || []).some(g => g.goal_type),
      any_demand: (pd.goals || []).some(g => g.demand),
      any_estimate: (pd.goals || []).some(g => g.estimate),
      any_arc_state: (pd.goals || []).some(g => g.roadmap && g.roadmap.arc_state),
      capacity: pd.capacity !== undefined,
      coexistence: pd.coexistence !== undefined,
    },
    top_level_keys: Object.keys(pd).sort(),
  };
}

(async () => {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  const apply = process.argv.includes('--apply');

  if (cmd === 'snapshot') {
    const pid = arg1 || '1';
    const r = await req('GET', '/api/profiles/' + pid);
    if (r.status !== 200) throw new Error('read failed: HTTP ' + r.status);
    const profile = r.json.profile || r.json;
    const pd = profile.profile_data;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snap = {
      profile_id: Number(pid),
      taken_at: new Date().toISOString(),
      host: HOST,
      sha256: sha(pd),
      note: 'Pre-migration snapshot (session #47). profile_data ONLY — the migration writes nothing else.',
      summary: summarize(pd),
      profile_data: pd,
    };
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, 'profile-' + pid + '-' + stamp + '.json');
    fs.writeFileSync(file, JSON.stringify(snap, null, 2));
    console.log('SNAPSHOT WRITTEN');
    console.log('  file   :', file);
    console.log('  bytes  :', fs.statSync(file).size);
    console.log('  sha256 :', snap.sha256);
    console.log('  summary:', JSON.stringify(snap.summary, null, 2));
    const errs = validateShape(snap);
    console.log(errs.length ? '  ⚠ SHAPE ERRORS: ' + errs.join('; ') : '  shape: OK — restorable');
    if (errs.length) process.exit(2);
    return;
  }

  if (cmd === 'verify') {
    const snap = JSON.parse(fs.readFileSync(arg1, 'utf8'));
    const errs = validateShape(snap);
    console.log('file       :', arg1);
    console.log('taken_at   :', snap.taken_at);
    console.log('stored sha :', snap.sha256);
    console.log('recomputed :', sha(snap.profile_data));
    console.log('sha matches:', snap.sha256 === sha(snap.profile_data));
    console.log('summary    :', JSON.stringify(snap.summary, null, 2));
    console.log(errs.length ? 'SHAPE ERRORS: ' + errs.join('; ') : 'SHAPE OK — this snapshot can be restored');
    process.exit(errs.length ? 2 : 0);
  }

  if (cmd === 'diff') {
    const snap = JSON.parse(fs.readFileSync(arg1, 'utf8'));
    const pid = arg2 || snap.profile_id;
    const r = await req('GET', '/api/profiles/' + pid);
    const live = (r.json.profile || r.json).profile_data;
    const d = diffPaths(canon(snap.profile_data), canon(live), 'profile_data', []);
    console.log('snapshot sha:', snap.sha256);
    console.log('live sha    :', sha(live));
    console.log('differing paths:', d.length);
    d.forEach(x => console.log('  ' + x.path + '\n      snapshot: ' + JSON.stringify(x.before).slice(0, 200) + '\n      live    : ' + JSON.stringify(x.after).slice(0, 200)));
    return;
  }

  if (cmd === 'restore') {
    const snap = JSON.parse(fs.readFileSync(arg1, 'utf8'));
    const errs = validateShape(snap);
    if (errs.length) { console.error('REFUSING — snapshot shape invalid: ' + errs.join('; ')); process.exit(2); }
    const pid = snap.profile_id;
    const r = await req('GET', '/api/profiles/' + pid);
    const live = (r.json.profile || r.json).profile_data;
    const d = diffPaths(canon(snap.profile_data), canon(live), 'profile_data', []);
    // Keys the migration ADDED at the top level. Absent from the snapshot, so a
    // plain PATCH would leave them in place — they must be nulled explicitly.
    const liveOnly = Object.keys(live).filter(k => !(k in snap.profile_data));
    const body = Object.assign({}, snap.profile_data);
    liveOnly.forEach(k => { body[k] = null; });

    console.log('RESTORE profile ' + pid + ' from ' + arg1);
    console.log('  snapshot sha:', snap.sha256);
    console.log('  live sha    :', sha(live));
    console.log('  paths that would change back:', d.length);
    d.slice(0, 60).forEach(x => console.log('    ' + x.path));
    console.log('  live-only top-level keys to be NULLED:', liveOnly.length ? liveOnly.join(', ') : '(none)');
    if (!apply) {
      console.log('\nDRY RUN — nothing was sent. Re-run with --apply to perform the restore.');
      console.log('PATCH body would be: { "profile_data": <snapshot, ' +
        JSON.stringify(snap.profile_data).length + ' bytes' +
        (liveOnly.length ? ', plus ' + liveOnly.length + ' key(s) set to null' : '') + '> }');
      return;
    }
    const pr = await req('PATCH', '/api/profiles/' + pid, { profile_data: body });
    console.log('  PATCH status:', pr.status);
    const after = await req('GET', '/api/profiles/' + pid);
    const back = (after.json.profile || after.json).profile_data;
    // A nulled key is behaviourally identical to an absent one for every reader
    // (capacity/coexistence are both truthiness-gated), so verification strips
    // nulls that the snapshot did not have before comparing.
    const normalised = Object.assign({}, back);
    liveOnly.forEach(k => { if (normalised[k] === null) delete normalised[k]; });
    const okSha = sha(normalised) === snap.sha256;
    const residual = Object.keys(back).filter(k => !(k in snap.profile_data) && back[k] !== null);
    console.log('  post-restore sha (nulls normalised):', sha(normalised));
    console.log('  residual migration keys still non-null:', residual.length ? residual.join(', ') : '(none)');
    console.log(okSha && !residual.length
      ? '  RESTORE VERIFIED — profile_data is back to the snapshot'
      : '  ⚠ RESTORE DID NOT MATCH — investigate before doing anything else');
    process.exit(okSha && !residual.length ? 0 : 3);
  }

  console.log('usage: profile_snapshot.js snapshot <id> | verify <file> | diff <file> [id] | restore <file> [--apply]');
  process.exit(1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
