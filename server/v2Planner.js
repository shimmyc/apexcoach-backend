"use strict";
/**
 * ENGINE v2 — PLANNER (weekly, Sonnet, server-side)
 * =================================================
 * Reconciles goals/tiers, schedule anchors, roadmap phase emphasis, injuries
 * and the coaching rules ONCE into a persisted training block plus a concrete
 * week of planned sessions with real loads and progression rules.
 *
 * This module is PROMPT ASSEMBLY + VALIDATION + PERSISTENCE SHAPING only. The
 * HTTP route, the Anthropic call and the streaming live in server.js so this
 * file stays dependency-injected and testable.
 *
 * DIVISION OF LABOUR (load-bearing, do not blur)
 * ----------------------------------------------
 * The SCHEDULE owns frequency and duration. The ROADMAP contributes EMPHASIS
 * ONLY — never session counts. Roadmap `weekly_targets` carry their own
 * competing weekly numbers with no status tracking at all, so injecting them
 * would put two different weekly frequencies into one prompt. This is the same
 * rule v1's buildRoadmapEmphasisContext() already follows.
 */

var rules = require("./coachingRules");

var MAX_DRIVERS = rules.MAX_DRIVERS;
var DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
var DAY_LABELS = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

// Categories treated as high-CNS for the consecutive-day spacing invariant.
var HIGH_CNS_CATEGORIES = ["strength", "martial_arts", "sports"];
var HIGH_CNS_INTENSITY = "high";

// Coarse whole-session working-set ceiling. See enforceInvariants() for why
// this is a proxy rather than the real per-muscle cap.
var SESSION_TOTAL_SET_CAP = 30;

/**
 * SCHEMA DECISION — exercise time is `time_seconds`, a separate field.
 *
 * Chosen over a single `time` + required `time_unit` pair. At the renderer
 * boundary (Phase 6) and in the autoregulator (Phase 4), a field named
 * `time_seconds` needs no sibling lookup and cannot be half-populated: a
 * consumer either has seconds or has nothing. A value+unit pair puts the burden
 * on every consumer to branch, and a MISSING unit degrades silently back into
 * exactly the ambiguity being fixed — which is how `duration_minutes` became a
 * two-meaning column in the first place.
 *
 * It also matches the vocabulary already in use: progression state exposes
 * `best_hold_seconds`, and the rules module's isometric increments are in
 * seconds. A cardio block's LENGTH is not an exercise property at all — it
 * belongs on the segment's `duration_min`.
 */
var EXERCISE_TIME_FIELD = "time_seconds";

// ── Tier resolution ─────────────────────────────────────────────────────────

/**
 * Resolve goal tiers for THIS BLOCK. Max 2 drivers: if more are marked, the
 * top 2 by existing priority (array order) stay drivers and the rest are
 * demoted to maintenance FOR THIS BLOCK ONLY.
 *
 * Returns the demotions explicitly so the planner can state them in the block
 * rationale. STORED GOALS ARE NEVER MUTATED — this is a per-block view.
 */
function resolveTiers(goals) {
  var list = (Array.isArray(goals) ? goals : []).map(function (g, i) {
    return {
      index: i,
      id: g.id || null,
      title: g.title || "(untitled)",
      status: g.status || null,
      declared_tier: g.tier || null,
      tier: g.tier || "maintenance",
      roadmap: g.roadmap || null,
    };
  });

  var declaredDrivers = list.filter(function (g) { return g.declared_tier === "driver"; });
  var demoted = [];

  if (declaredDrivers.length > MAX_DRIVERS) {
    // Array order IS priority order (goals[0] === priority #1).
    declaredDrivers.slice(MAX_DRIVERS).forEach(function (g) {
      g.tier = "maintenance";
      demoted.push({ title: g.title, from: "driver", to: "maintenance", reason: "more than " + MAX_DRIVERS + " drivers marked; kept the top " + MAX_DRIVERS + " by priority" });
    });
  }

  return {
    goals: list,
    drivers: list.filter(function (g) { return g.tier === "driver"; }),
    maintenance: list.filter(function (g) { return g.tier === "maintenance"; }),
    accessory: list.filter(function (g) { return g.tier === "accessory"; }),
    demoted: demoted,
    untiered: list.filter(function (g) { return !g.declared_tier; }).length,
  };
}

// ── Schedule v3 resolution ──────────────────────────────────────────────────

/**
 * Read the live v2 schedule plus the v3 sibling keys.
 *
 * v3 keys live at `profile_data.schedule_v3`, NOT inside `profile_data.schedule`.
 * That is deliberate and load-bearing: loadSchedule() in public/index.html
 * RECONSTRUCTS currentSchedule with exactly {anchors, frequency_targets,
 * addons}, and schedPersist() writes that reconstruction back — so any key
 * placed INSIDE profile_data.schedule is silently destroyed the first time the
 * athlete edits their schedule in the v1 UI. A sibling at the profile_data
 * level survives, because schedPersist does
 * Object.assign({}, currentProfileData, {schedule: currentSchedule}).
 */
function resolveScheduleV3(profileData) {
  var pd = profileData || {};
  var sched = pd.schedule || {};
  var v3 = pd.schedule_v3 || {};
  return {
    anchors: (sched.anchors && typeof sched.anchors === "object") ? sched.anchors : {},
    frequency_targets: Array.isArray(sched.frequency_targets) ? sched.frequency_targets : [],
    addons: Array.isArray(sched.addons) ? sched.addons : [],
    anchor_meta: v3.anchor_meta || {},
    fill_policy: v3.fill_policy === "flexible" ? "flexible" : "ai_assigned",
    fill_policy_source: v3.fill_policy ? "explicit" : "default",
  };
}

/** Expand anchors into concrete dated commitments across the planning week. */
function anchorsForWeek(schedule, weekDates) {
  var out = [];
  weekDates.forEach(function (d) {
    var list = schedule.anchors[d.dayKey];
    if (!Array.isArray(list)) list = list ? [list] : [];
    list.forEach(function (a, i) {
      if (!a || !a.activity) return;
      var meta = (schedule.anchor_meta && schedule.anchor_meta[d.dayKey]) || {};
      out.push({
        date: d.date,
        dayKey: d.dayKey,
        dayLabel: d.dayLabel,
        slot: i + 1,
        activity: a.activity,
        duration_min: a.duration == null ? null : a.duration,
        category: meta.category || null,
        time: meta.time || null,
      });
    });
  });
  return out;
}

/** The 7 dates of the planning week, starting from `startDate` (athlete-local). */
function buildWeekDates(startDate) {
  var out = [];
  var base = new Date(String(startDate) + "T12:00:00");
  for (var i = 0; i < 7; i++) {
    var d = new Date(base);
    d.setDate(d.getDate() + i);
    var ymd = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    // JS getDay(): 0=Sun..6=Sat. DAY_KEYS is Mon-first.
    var idx = (d.getDay() + 6) % 7;
    out.push({ date: ymd, dayKey: DAY_KEYS[idx], dayLabel: DAY_LABELS[DAY_KEYS[idx]] });
  }
  return out;
}

// ── Prompt assembly ─────────────────────────────────────────────────────────

function renderTierBlock(tiers) {
  var L = ["GOALS BY TIER (drivers structure the week; maintenance gets its minimum effective dose; accessories bolt on):"];
  if (tiers.drivers.length) {
    L.push("DRIVERS (" + tiers.drivers.length + "):");
    tiers.drivers.forEach(function (g) { L.push("  - " + g.title + (g.status ? " [" + g.status + "]" : "")); });
  } else {
    L.push("DRIVERS: none marked — treat the top-priority maintenance goals as the week's structure and say so.");
  }
  if (tiers.maintenance.length) {
    L.push("MAINTENANCE (" + tiers.maintenance.length + "):");
    tiers.maintenance.forEach(function (g) { L.push("  - " + g.title + (g.status ? " [" + g.status + "]" : "")); });
  }
  if (tiers.accessory.length) {
    L.push("ACCESSORY (" + tiers.accessory.length + "):");
    tiers.accessory.forEach(function (g) { L.push("  - " + g.title); });
  }
  if (tiers.demoted.length) {
    L.push("DEMOTED FOR THIS BLOCK (state this explicitly in the block rationale):");
    tiers.demoted.forEach(function (d) { L.push("  - " + d.title + ": " + d.from + " -> " + d.to + " (" + d.reason + ")"); });
  }
  return L.join("\n");
}

function renderScheduleBlock(schedule, weekDates, anchors) {
  var L = ["SCHEDULE (this owns FREQUENCY and DURATION — the roadmap does not):"];
  L.push("Fill policy: " + schedule.fill_policy +
    (schedule.fill_policy === "ai_assigned"
      ? " — YOU pin every session to a specific date."
      : " — treat unclaimed days as weekly targets; do not over-specify which day."));
  L.push("");
  L.push("PLANNING WEEK:");
  weekDates.forEach(function (d) { L.push("  " + d.date + " (" + d.dayLabel + ")"); });
  L.push("");
  if (anchors.length) {
    L.push("FIXED COMMITMENTS — these are IMMOVABLE. Reproduce each one exactly: same date, same activity, same duration. Do NOT break them into drills or movements, do NOT reschedule them, do NOT change their duration:");
    anchors.forEach(function (a) {
      L.push("  - " + a.date + " (" + a.dayLabel + "): " + a.activity +
        (a.duration_min ? " — " + a.duration_min + " min" : "") + (a.time ? " at " + a.time : ""));
    });
  } else {
    L.push("FIXED COMMITMENTS: none this week.");
  }
  L.push("");
  if (schedule.frequency_targets.length) {
    L.push("WEEKLY TARGETS (hit each the stated number of times across the week):");
    schedule.frequency_targets.forEach(function (t) {
      L.push("  - " + t.activity + ": " + (t.times_per_week || 1) + "x/week" +
        (t.duration ? ", ~" + t.duration + " min each" : "") +
        (t.suggested_day ? ", prefer " + t.suggested_day : "") +
        (t.stackable ? " (STACKABLE — may share a day with another session)" : " (not stackable — its own day)"));
    });
  }
  if (schedule.addons.length) {
    L.push("DAILY ADD-ONS (bolt on to existing sessions; these are the accessory dose):");
    schedule.addons.forEach(function (a) {
      L.push("  - " + a.activity + ": " + (a.duration || 5) + " min, " + (a.days_per_week || 5) + " days/week");
    });
  }
  return L.join("\n");
}

function renderEmphasisBlock(phaseResolutions) {
  if (!phaseResolutions || !phaseResolutions.length) return "";
  var L = ["ROADMAP PHASE EMPHASIS (WHAT to emphasise — never HOW MANY sessions; the schedule owns frequency):"];
  phaseResolutions.forEach(function (p) {
    if (!p.emphasis) return;
    var em = Array.isArray(p.emphasis) ? p.emphasis : [p.emphasis];
    L.push("  " + p.goal + " — current phase \"" + (p.phase_name || "?") + "\":");
    em.slice(0, 4).forEach(function (e) { L.push("    - " + e); });
  });
  return L.length > 1 ? L.join("\n") : "";
}

function renderMicroGoalsBlock(microGoals) {
  if (!microGoals || !microGoals.length) return "";
  var L = ["ACTIVE CHALLENGES (short-horizon commitments — daily habits are non-negotiable and must appear in the sessions of the days they apply to):"];
  microGoals.slice(0, 12).forEach(function (m) {
    L.push("  - " + m.title + " [" + m.type + "] " +
      (m.current_value != null && m.target_value != null ? m.current_value + "/" + m.target_value + " " + (m.target_unit || "") : ""));
  });
  return L.join("\n");
}

function renderDefaultsBlock(defaults) {
  var d = defaults || {};
  return "PROFILE DEFAULTS: default session length " + (d.duration_min || 45) +
    " min; default intensity " + (d.intensity || "auto") +
    ". Use these when neither an anchor nor a weekly target dictates otherwise.";
}

var OUTPUT_CONTRACT =
  "OUTPUT CONTRACT — return STRICT JSON ONLY. No prose, no markdown, no code fences.\n" +
  "{\n" +
  '  "block": {\n' +
  '    "focus": "one line — what this block is FOR",\n' +
  '    "driver_goals": ["..."],\n' +
  '    "phase_note": "one line tying the block to the current roadmap phase emphasis",\n' +
  '    "weekly_structure_rationale": "2-3 sentences: why the week is shaped this way",\n' +
  '    "tradeoff_notes": "what you deliberately did NOT do, and any tier demotions"\n' +
  "  },\n" +
  '  "sessions": [\n' +
  "    {\n" +
  '      "date": "YYYY-MM-DD", "slot": 1, "priority": 1, "movable": true,\n' +
  '      "category": "strength|cardio|martial_arts|sports|mind_body|rehab|other",\n' +
  '      "duration_min": 45, "intensity": "low|medium|high",\n' +
  '      "why": "ONE line — why this session, today, for this athlete",\n' +
  '      "goal_tags": ["goal titles this serves"],\n' +
  '      "segments": [\n' +
  "        {\n" +
  '          "type": "one of: ' + rules.SEGMENT_TYPES.join(", ") + '",\n' +
  '          "duration_min": 10, "intent": "one line",\n' +
  '          "params": { "work_rest": "optional", "rounds": null, "stations": null },\n' +
  '          "exercises": [\n' +
  '            { "name": "Canonical Exercise Name", "sets": 3, "reps": 8, "time_seconds": null, "distance": null, "load": "135 lb", "rest": "90 s", "notes": "optional short cue" }\n' +
  "          ]\n" +
  "        }\n" +
  "      ]\n" +
  "    }\n" +
  "  ]\n" +
  "}\n\n" +
  "SEGMENT RULES:\n" +
  "- Emit ONLY the segments that actually apply. A 60-minute steady ride is ONE steady_state segment with no warmup and no cooldown. Do NOT pad a session with empty or token segments.\n" +
  "- A fixed commitment (an anchored class) is ONE segment of type 'skill' naming the activity, with NO exercise breakdown. Do not invent drills for it.\n" +
  "- Use `reps` OR `time_seconds` OR `distance` per exercise — whichever the movement is actually measured in. Leave the others null.\n" +
  "- **`time_seconds` IS ALWAYS SECONDS.** A 30-second dead hang is `time_seconds: 30`. A 2-minute plank is `time_seconds: 120`. There is NO minutes field on an exercise — never put minutes in it.\n" +
  "- For a TIMED BLOCK such as a 20-minute bike or a 30-minute run, the duration belongs on the SEGMENT's `duration_min`, and the exercise carries `time_seconds: null`. Do not express a cardio block's length as an exercise time.\n" +
  "- `load` is a string so it can carry bodyweight/band/RPE (\"bodyweight\", \"red band\", \"135 lb\").\n" +
  "- Every session MUST carry a non-empty `why`.\n" +
  "- A session's segment `duration_min` values MUST sum to the session's own `duration_min`. Check this before returning.\n" +
  "- Exercise names must be spelled out canonically (\"Dumbbell Bench Press\", never \"DB Bench\").\n" +
  "- Every goal listed under GOALS BY TIER must either appear in some session's `goal_tags` with real prescribed work, or be named explicitly in `block.tradeoff_notes` as deliberately not addressed this week. Mentioning a goal only inside a segment's `intent` text does NOT count as prescribing it.\n";

/**
 * Assemble the planner prompt. Returns { system, user, sections } — `sections`
 * is the per-section char count for the promptSections logging discipline.
 */
function buildPlannerPrompt(ctx) {
  var tiers = ctx.tiers;
  var schedule = ctx.schedule;
  var weekDates = ctx.weekDates;
  var anchors = ctx.anchors;

  var system =
    "You are the PLANNER for an elite, deeply personal AI strength & conditioning coach.\n\n" +
    "You run ONCE PER WEEK. Your job is to reconcile the athlete's goals, fixed commitments, " +
    "current rehab/roadmap phase, injury reality and measured training history into ONE concrete " +
    "week of sessions with REAL loads, sets, reps and progression — not suggestions, not options. " +
    "A separate nightly autoregulator will adjust today's session against readiness; it EDITS your " +
    "plan and never replaces it, so your plan must be specific enough to edit.\n\n" +
    "HARD REQUIREMENTS:\n" +
    "- Fixed commitments are immovable. Reproduce them exactly.\n" +
    "- Drivers structure the week. Maintenance goals get their minimum effective dose and no more. " +
    "Accessories bolt on to existing sessions.\n" +
    "- Respect every spacing, interference and volume rule you are given.\n" +
    "- Prescribe from the athlete's MEASURED history where it exists. Where it does not, say so by " +
    "prescribing conservatively — never invent a load for a movement with no logged baseline.\n" +
    "- Never program around an injury by ignoring it.\n" +
    "- You are not diagnosing anything. Never name a medical condition.\n\n" +
    "SOURCING RULE — NON-NEGOTIABLE:\n" +
    "State NO numeric fact about this athlete's training history that is not present in this prompt. " +
    "Do not compute gaps, streaks, session counts, week counts or elapsed time from the dates in the " +
    "progression table — that table shows only a sample of instances and any figure you derive from it " +
    "will be wrong. The TRAINING RECENCY block is the ONLY source for how recently and how consistently " +
    "this athlete has trained; if a number you want is not there, describe the situation in words instead " +
    "of producing a figure. In particular, any 'returning from a layoff' / 'post-gap' / 're-establishing " +
    "cadence' framing must be justified by the TRAINING RECENCY block: if it reports a gap as CLOSED, the " +
    "athlete is NOT currently returning from it.\n\n" +
    ctx.rulesText + "\n\n" + OUTPUT_CONTRACT;

  var parts = [];
  var sections = {};
  function add(name, text) {
    if (!text) return;
    parts.push(text);
    sections[name] = text.length;
  }

  add("athlete", "ATHLETE: " + (ctx.athleteName || "this athlete") + ". Planning week starts " +
    weekDates[0].date + " (" + weekDates[0].dayLabel + ") and runs through " + weekDates[6].date + ".");
  add("recency", ctx.recencyText);
  add("tiers", renderTierBlock(tiers));
  add("schedule", renderScheduleBlock(schedule, weekDates, anchors));
  add("emphasis", renderEmphasisBlock(ctx.phaseResolutions));
  add("dossier", ctx.dossierText);
  add("progression", ctx.progressionText);
  add("micro_goals", renderMicroGoalsBlock(ctx.microGoals));
  add("defaults", renderDefaultsBlock(ctx.defaults));

  var user = parts.join("\n\n");
  sections._system = system.length;
  sections._user = user.length;
  sections._total = system.length + user.length;
  sections._rules = ctx.rulesText.length;

  return { system: system, user: user, sections: sections };
}

// ── Post-generation invariants (CODE, not prompt rules) ─────────────────────

/**
 * Prompt rules are probabilistic; these are not. Same precedent as
 * enforceSingleCurrentPhase() — the rule that had to move from the prompt into
 * code because the model kept violating it.
 *
 * REPAIR for structural problems that are safe to fix mechanically.
 * FLAG for training-content problems that must not be silently rewritten.
 *
 * @returns {{sessions:Array, violations:Array, repairs:Array}}
 */
function enforceInvariants(plan, ctx) {
  var violations = [];
  var repairs = [];
  var sessions = Array.isArray(plan.sessions) ? plan.sessions.slice() : [];
  var validDates = {};
  ctx.weekDates.forEach(function (d) { validDates[d.date] = true; });

  // 0. Drop sessions outside the planning week entirely.
  sessions = sessions.filter(function (s) {
    if (!s || !s.date || !validDates[s.date]) {
      violations.push({ invariant: "date_in_week", severity: "repaired", detail: "dropped a session dated " + ((s && s.date) || "(none)") + " — outside the planning week" });
      return false;
    }
    return true;
  });

  // 1. ANCHORS PRESENT AND UNMODIFIED.
  ctx.anchors.forEach(function (a) {
    var match = sessions.filter(function (s) {
      return s.date === a.date && String(s.category || "").length >= 0 &&
        JSON.stringify(s).toLowerCase().indexOf(String(a.activity).toLowerCase()) >= 0;
    })[0];
    if (!match) {
      // REPAIR: the anchor is a real commitment; a plan that drops it is wrong
      // in a way we can fix exactly, because we know precisely what it was.
      sessions.push({
        date: a.date, slot: a.slot, priority: 1, movable: false,
        category: a.category || "martial_arts",
        duration_min: a.duration_min || 60,
        intensity: "high",
        why: "Fixed commitment — restored by the planner's anchor invariant after the model omitted it.",
        goal_tags: [],
        segments: [{ type: "skill", duration_min: a.duration_min || 60, intent: a.activity, params: {}, exercises: [] }],
        _restored: true,
      });
      violations.push({ invariant: "anchor_present", severity: "repaired", detail: "anchor '" + a.activity + "' on " + a.date + " was missing — reinserted" });
      repairs.push("reinserted anchor " + a.activity + " on " + a.date);
    } else {
      if (a.duration_min && match.duration_min && match.duration_min !== a.duration_min) {
        violations.push({ invariant: "anchor_unmodified", severity: "repaired", detail: "anchor '" + a.activity + "' duration changed " + a.duration_min + " -> " + match.duration_min + "; restored" });
        match.duration_min = a.duration_min;
        repairs.push("restored anchor duration on " + a.date);
      }
      match.movable = false;
    }
  });

  // 2. ONE SESSION PER (date, slot).
  var seen = {};
  sessions.forEach(function (s) {
    s.slot = Number(s.slot) || 1;
    var key = s.date + "#" + s.slot;
    while (seen[key]) {
      s.slot++;
      key = s.date + "#" + s.slot;
      violations.push({ invariant: "unique_date_slot", severity: "repaired", detail: "slot collision on " + s.date + "; reassigned to slot " + s.slot });
      repairs.push("reassigned slot on " + s.date);
    }
    seen[key] = true;
  });

  // 3. NO TWO HIGH-CNS SESSIONS ON CONSECUTIVE DAYS.
  //    FLAGGED, never auto-rewritten: silently downgrading a session's
  //    intensity changes the training content, which is exactly the thing a
  //    mechanical repair must not do.
  var byDate = {};
  sessions.forEach(function (s) {
    var isHigh = HIGH_CNS_CATEGORIES.indexOf(String(s.category || "").toLowerCase()) >= 0 &&
      String(s.intensity || "").toLowerCase() === HIGH_CNS_INTENSITY;
    if (isHigh) byDate[s.date] = true;
  });
  ctx.weekDates.forEach(function (d, i) {
    if (i === 0) return;
    var prev = ctx.weekDates[i - 1].date;
    if (byDate[prev] && byDate[d.date]) {
      violations.push({
        invariant: "no_consecutive_high_cns", severity: "flagged",
        detail: "high-CNS sessions on consecutive days: " + prev + " and " + d.date,
      });
    }
  });

  // 4. PER-SESSION VOLUME CAP.
  //    COARSE PROXY, stated as such: the session schema carries no muscle tags,
  //    so the real "<=10 sets per MUSCLE per session" rule cannot be evaluated
  //    here. This checks total working sets per session against a whole-session
  //    ceiling instead. Wiring the exercise_catalog muscle data in would make
  //    it exact — deferred, see the Phase 3 report.
  sessions.forEach(function (s) {
    var total = 0;
    (s.segments || []).forEach(function (seg) {
      (seg.exercises || []).forEach(function (ex) { total += Number(ex.sets) || 0; });
    });
    if (total > SESSION_TOTAL_SET_CAP) {
      violations.push({
        invariant: "session_volume_cap", severity: "flagged",
        detail: s.date + " slot " + s.slot + ": " + total + " total working sets exceeds the coarse " + SESSION_TOTAL_SET_CAP + "-set whole-session ceiling",
      });
    }
  });

  // 5. EVERY SESSION CARRIES A `why`.
  sessions.forEach(function (s) {
    if (!s.why || !String(s.why).trim()) {
      s.why = "No rationale was generated for this session — review before using it.";
      violations.push({ invariant: "why_present", severity: "repaired", detail: s.date + " slot " + s.slot + " had no `why`; filled with a placeholder" });
      repairs.push("filled missing why on " + s.date);
    }
  });

  // 6. Segment type must be in the enum (repair to a safe default).
  sessions.forEach(function (s) {
    (s.segments || []).forEach(function (seg) {
      if (rules.SEGMENT_TYPES.indexOf(seg.type) < 0) {
        violations.push({ invariant: "segment_type_enum", severity: "repaired", detail: "unknown segment type '" + seg.type + "' on " + s.date + "; coerced to 'straight_sets'" });
        seg.type = "straight_sets";
        repairs.push("coerced segment type on " + s.date);
      }
    });
  });

  // 7. TIME VALUES MUST CARRY A RESOLVABLE UNIT.
  //    The first real plan emitted a bare `time` field meaning MINUTES on
  //    Indoor Bike (20) and SECONDS on Dead Hang/Plank (30) — the same key,
  //    the same type, two different units, 18 occurrences. That is the
  //    `duration_minutes` overload reproducing itself in the new schema, so it
  //    is fixed AT THE SCHEMA and guarded here rather than patched per consumer.
  //
  //    A legacy/unqualified `time` is REPAIRED only where the intent is
  //    unambiguous: a value on an exercise inside a timed cardio-style segment
  //    belongs on the SEGMENT (minutes), and anywhere else it is a hold in
  //    seconds. Anything that cannot be resolved is FLAGGED rather than guessed.
  var TIMED_BLOCK_SEGMENTS = ["steady_state", "interval_long", "interval_short", "sprint", "active_recovery"];
  sessions.forEach(function (s) {
    (s.segments || []).forEach(function (seg) {
      (seg.exercises || []).forEach(function (ex) {
        if (ex.time === undefined || ex.time === null) return;   // nothing legacy present
        var v = Number(ex.time);
        if (!isFinite(v)) {
          violations.push({ invariant: "time_unit_resolvable", severity: "flagged", detail: s.date + " " + ex.name + ": non-numeric `time` value " + JSON.stringify(ex.time) + " — cannot resolve a unit" });
          delete ex.time;
          return;
        }
        if (TIMED_BLOCK_SEGMENTS.indexOf(seg.type) >= 0) {
          // A timed block's length lives on the segment, in minutes.
          if (!seg.duration_min) seg.duration_min = v;
          violations.push({ invariant: "time_unit_resolvable", severity: "repaired", detail: s.date + " " + ex.name + ": bare `time` on a " + seg.type + " segment resolved to segment duration " + v + " min" });
          repairs.push("moved a timed-block length to the segment on " + s.date);
        } else {
          ex.time_seconds = v;
          violations.push({ invariant: "time_unit_resolvable", severity: "repaired", detail: s.date + " " + ex.name + ": bare `time` resolved to time_seconds=" + v });
          repairs.push("resolved a bare time value to seconds on " + s.date);
        }
        delete ex.time;
      });
    });
  });

  // 8. SESSION SEGMENTS MUST SUM TO THE SESSION'S STATED DURATION.
  //    v1 has verifyRecTimeBudget() for exactly this; v2 had no equivalent, and
  //    4 of 7 sessions in the first real plan disagreed with themselves.
  //
  //    Tolerance: max(2, floor(10% of stated)). Tight, because unlike a v1 rec
  //    (where minutes are ESTIMATED from exercise text by a coarse heuristic)
  //    the planner states segment durations explicitly — a mismatch is the model
  //    contradicting its own arithmetic, not estimation noise. The 2-minute floor
  //    stops churn on small rounding.
  //
  //    Repair DIRECTION matters: for an immovable anchor the stated duration is
  //    the real-world truth (a 60-minute class is 60 minutes) so the SEGMENT is
  //    corrected; everywhere else the segments are the concrete content and the
  //    header number is the derived one, so `duration_min` is corrected to match.
  sessions.forEach(function (s) {
    var segs = s.segments || [];
    if (!segs.length) return;
    var sum = segs.reduce(function (a, g) { return a + (Number(g.duration_min) || 0); }, 0);
    var stated = Number(s.duration_min) || 0;
    if (!stated || !sum) return;
    var tol = Math.max(2, Math.floor(stated * 0.10));
    var delta = sum - stated;
    if (Math.abs(delta) <= tol) return;

    if (s.movable === false && segs.length === 1) {
      segs[0].duration_min = stated;
      violations.push({ invariant: "session_time_budget", severity: "repaired", detail: s.date + ": anchored session segments summed " + sum + " vs stated " + stated + " min (tol " + tol + "); segment corrected to the anchor duration" });
      repairs.push("corrected anchored segment duration on " + s.date);
    } else {
      s.duration_min = sum;
      violations.push({ invariant: "session_time_budget", severity: "repaired", detail: s.date + ": segments summed " + sum + " vs stated " + stated + " min (tol " + tol + "); duration_min corrected to " + sum });
      repairs.push("corrected duration_min on " + s.date + " (" + stated + " -> " + sum + ")");
    }
  });

  // 9. EVERY TIERED GOAL MUST ACTUALLY BE PRESCRIBED.
  //    `Daily Meditation` (accessory) appeared in the first plan ONLY inside a
  //    segment's `intent` STRING and was never prescribed — acknowledged in
  //    prose, dropped in practice, and nothing caught it.
  //
  //    Deliberately a PRESENCE check, not a volume-adequacy judgment: a goal is
  //    satisfied by appearing in some session's goal_tags (on a session that has
  //    at least one segment), OR by being named in the block's tradeoff_notes,
  //    which is the legitimate "deliberately not addressed this week" escape.
  //    FLAGGED, never repaired — inventing work for an unaddressed goal is
  //    exactly the kind of content fabrication a mechanical repair must not do.
  var tradeoffs = String((plan.block && plan.block.tradeoff_notes) || "").toLowerCase();
  var taggedGoals = {};
  sessions.forEach(function (s) {
    if (!(s.segments || []).length) return;
    (s.goal_tags || []).forEach(function (t) { taggedGoals[String(t).toLowerCase().trim()] = true; });
  });
  (ctx.tiers.goals || []).forEach(function (g) {
    var title = String(g.title || "").toLowerCase().trim();
    if (!title) return;
    if (taggedGoals[title]) return;
    // Tolerate a partial name match in tradeoff_notes — goal titles can be long.
    var key = title.length > 28 ? title.slice(0, 28) : title;
    if (tradeoffs.indexOf(key) >= 0) return;
    violations.push({
      invariant: "tiered_goal_prescribed", severity: "flagged",
      detail: g.tier + "-tier goal \"" + g.title + "\" was neither tagged on any session nor named in tradeoff_notes — acknowledged nowhere, prescribed nowhere",
    });
  });

  sessions.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.slot || 1) - (b.slot || 1);
  });

  return { sessions: sessions, violations: violations, repairs: repairs };
}

/** Split a validated plan into the DB row shapes. */
function toPersistenceShape(plan, enforced, ctx) {
  var block = plan.block || {};
  return {
    block_row: {
      profile_id: ctx.profileId,
      status: "active",
      start_date: ctx.weekDates[0].date,
      end_date: ctx.weekDates[6].date,
      block: {
        focus: block.focus || null,
        driver_goals: block.driver_goals || ctx.tiers.drivers.map(function (g) { return g.title; }),
        phase_note: block.phase_note || null,
        weekly_structure_rationale: block.weekly_structure_rationale || null,
        tradeoff_notes: block.tradeoff_notes || null,
        tier_demotions: ctx.tiers.demoted,
        fill_policy: ctx.schedule.fill_policy,
        generated_at: new Date().toISOString(),
        invariant_violations: enforced.violations,
        invariant_repairs: enforced.repairs,
      },
    },
    session_rows: enforced.sessions.map(function (s) {
      return {
        profile_id: ctx.profileId,
        date: s.date,
        slot: s.slot || 1,
        status: "planned",
        priority: Number(s.priority) || 100,
        movable: s.movable === false ? false : true,
        session: {
          category: s.category || "other",
          duration_min: Number(s.duration_min) || null,
          intensity: s.intensity || "medium",
          why: s.why,
          goal_tags: Array.isArray(s.goal_tags) ? s.goal_tags : [],
          segments: Array.isArray(s.segments) ? s.segments : [],
          restored_by_invariant: !!s._restored,
        },
      };
    }),
  };
}

/** Tolerant JSON extraction — same approach as the v1 client's extractRecJSON. */
function extractPlanJSON(raw) {
  var t = String(raw || "").trim();
  if (t.indexOf("```") >= 0) t = t.replace(/```+\s*json|```+/gi, "").trim();
  var s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; }
}

module.exports = {
  resolveTiers, resolveScheduleV3, anchorsForWeek, buildWeekDates,
  buildPlannerPrompt, enforceInvariants, toPersistenceShape, extractPlanJSON,
  renderTierBlock, renderScheduleBlock, renderEmphasisBlock,
  DAY_KEYS, DAY_LABELS, SESSION_TOTAL_SET_CAP, HIGH_CNS_CATEGORIES,
};
