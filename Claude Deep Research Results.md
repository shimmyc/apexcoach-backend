# The Coach's Reasoning, Encoded: A Programming-Engine Specification for AI Fitness Coaching

**Scope note:** This report maps expert coaching practice to database fields, decision rules, thresholds, and constraints. Every finding is tagged **[STRONG EVIDENCE]** (peer-reviewed meta-analytic/RCT support), **[COACHING CONSENSUS]** (widely taught in established systems, thinner direct evidence), or **[OPINION]** (individual practitioner view). Contested territory — HRV-guided training, wearable readiness scores, ACWR — is flagged explicitly.

---

## 1. Intake and the athlete model

**What a thorough intake covers (and what is theater):**

| Intake element | Encode as | Changes program? |
|---|---|---|
| Injury history (site, date, mechanism, current status) | Structured records, per body region | YES — durable constraint |
| Training age per modality (lifting, sport, conditioning) | Integer years + qualitative tier | YES — sets progression cadence |
| Equipment access (home/gym/travel) | Enum set, multi-select | YES — filters exercise pool |
| Hard schedule constraints (fixed sport days, work, family) | Weekly availability grid | YES — structures the week |
| Movement preferences/refusals ("never barbell back squat") | Exercise allow/deny list | YES — filters pool |
| Goal set + event date | Prioritized goal list + deadline | YES — sets macro structure |
| Baseline strength (est. or tested 1RM/rep maxes) | Per-lift load anchor | YES — sets starting loads |
| Movement screen (e.g., overhead squat, single-leg) | Flags for asymmetry/restriction | PARTIAL — mostly theater unless a flag triggers substitution |
| Body composition / girths | Optional | MOSTLY theater for programming |
| FMS composite score | Number | Largely theater — FMS does not predict injury well in most populations |

The FMS (Functional Movement Screen) composite score has weak predictive value for injury and should not drive programming; individual painful or grossly asymmetric findings are what matter, not the aggregate number. **[COACHING CONSENSUS / mixed evidence]**

**Durable vs. stale facts:**
- **Durable (steer programming for months):** injury history, structural limitations (e.g., anatomical hip impingement), equipment access, hard schedule constraints, movement refusals, training age, limb-length/leverage quirks, chronic conditions.
- **Stale quickly (re-check every 1–4 weeks):** current 1RM/estimated maxes, bodyweight, readiness/recovery state, life-stress level, current niggles, motivation/novelty appetite, sleep patterns.

**The running record a coach maintains:** logged loads/reps/RPE per session; PR history per lift; autoregulation notes ("felt heavy," "left knee cranky"); adherence pattern (which sessions get skipped); subjective wellness; and a short qualitative memory of preferences and life context. Encode: an immutable session log + a mutable "athlete state" object + a free-text coach-notes field the system can parse for flags.

**What an app never asks but should:** (1) *why* the athlete stopped a previous program; (2) which exercises they secretly hate/skip; (3) real (not aspirational) weekly time budget; (4) fixed immovable commitments; (5) what "feeling good" and "feeling wrecked" concretely look like for them.

**Training-age tiers — in programming terms, not labels** (Rippetoe/Baker framework, *Practical Programming for Strength Training*): **[COACHING CONSENSUS]**
- **Novice:** completes a full stress–recovery–adaptation cycle between sessions → progresses **session to session** (add load every workout). Linear progression, ~+2.5–5 lb upper / +5–10 lb lower per session.
- **Intermediate:** cycle takes ~one week → progresses **week to week**; needs planned light/heavy variation within the week; unloads are ~a week long with 10–20% reductions.
- **Advanced:** cycle takes weeks to months → progresses **monthly or longer**; needs block periodization and accumulated fatigue management.

**Readiness without wearables — highest-signal subjective questions:** A 1–5 or 1–10 self-report on (1) sleep quality last night, (2) muscle soreness, (3) energy/mood, (4) motivation to train, (5) perceived stress. Compress to a short daily wellness questionnaire; the validated Hooper-Mackinnon-style short scale (fatigue, sleep, stress, soreness) is defensible. Prior-night sleep and a first-set "readiness rep" (bar speed / how a warm-up load feels) carry the most signal.

---

## 2. Managing multiple competing goals

**Prioritize vs. sequence:** Coaches use a hybrid. One or two **priority goals** get concentrated resources; the rest are held at **maintenance** or run as **bolt-on accessories**. When goals interfere physiologically (e.g., max strength + high-volume endurance) or when an event looms, coaches **sequence** them into blocks (Issurin block periodization). When goals are compatible and no deadline dominates, they run **concurrently with weighted emphasis**. **[COACHING CONSENSUS]**

**A resource-consumption taxonomy for goals (encodable):**
1. **Structural goals** dictate the whole program skeleton (e.g., "peak for a powerlifting meet," "fight camp"). Only 1 at a time.
2. **Maintenance goals** need only a minimum effective dose to hold a quality (see MED table). Many can coexist.
3. **Bolt-on/accessory goals** (visible abs, grip, a lagging muscle) are appended as low-cost accessory work.

**Minimum effective dose to MAINTAIN each quality:** **[mixed: STRONG for strength/hypertrophy/aerobic, WEAKER for others]**

| Quality | Maintenance freq | Maintenance volume | Intensity (key lever) | Detraining onset |
|---|---|---|---|---|
| Maximal strength | 1×/week | as little as 1 hard set/movement; ≥80% 1RM | **Intensity must stay high (≥80% 1RM)** | Meaningful loss after ~3–4 weeks; strength robust up to ~4 wk |
| Hypertrophy | 1–2×/week | ~6–10 sets/muscle/week (some maintain on 2–4 near-failure) | Sets must be near failure | Muscle mass loss begins ~3 weeks off |
| Aerobic capacity (VO2max) | 2×/week | volume can drop 60–90% | **Intensity is the preserving lever** | See Coyle data below |
| Anaerobic capacity | 1–2×/week | low | high intensity | ~10–20% loss; short-sprint ability well-retained even at 7 wk |
| Mobility/flexibility | 2×/week minimum | short holds | to end-range | ROM stays above baseline but small losses over 2–6 wk detraining; must keep some flexibility work |
| Motor skill | 1×/week+ touch | low | technical quality | Very durable — motor patterns persist months |
| Tendon/connective tissue | 2–3×/week loading | moderate | slow heavy or isometric load | Slow to build, slow to lose; adapts slower than muscle |

**VO2max detraining, precisely:** Per **Coyle et al. 1984** (*J Appl Physiol* 57(6):1857–1864), in 7 well-trained subjects VO2max fell **7% by day 12**, then ~9% more over the next 9 weeks for **~16% cumulative loss**; stroke volume dropped 10% and the mitochondrial enzymes citrate synthase/succinate dehydrogenase declined **~20% within the first 12 days**. Population figures commonly cited: VO2max ~4–14% loss at 2–4 weeks, and in runners ~6% at 4 wk, ~19% at 9 wk, ~20–25% at 11 wk. **[STRONG EVIDENCE]**

**Recovery cost of small daily add-ons:** 5–10 min of core, mobility, PT, or isometrics is essentially "free" (does not meaningfully tax systemic recovery) **until accumulated add-on volume competes with main-work recovery** — practically, when daily add-ons exceed ~15–20 min or start including near-failure sets that overlap the main muscle groups. Isometric holds and light mobility are lowest-cost; near-failure "accessory" sets count against that muscle's weekly volume landmark and stop being free once total sets approach MRV. **[COACHING CONSENSUS / OPINION]**

**How many goals can advance at once:** Coaching consensus and block-periodization logic (Issurin) converge on **1–3 concurrently advancing targets**; beyond ~3, concentration of load is too diluted for meaningful gains in trained individuals — the rest stall at maintenance. Issurin's core argument is that only highly concentrated loads produce remarkable gains in trained athletes, which is why complex simultaneous development fails at higher training ages. **[COACHING CONSENSUS]**

**Rehab targets differ from performance goals:** A rehab target takes **precedence over everything** when (a) pain exceeds tolerance thresholds (see §5 pain rules), (b) the injury is in a reactive/acute phase, or (c) continued loading risks structural worsening. It runs **in parallel** with performance work once pain is controlled (≤3/10, settling within 24h), loading is progressive, and the injured tissue tolerates the dose. Encode rehab as a hard gate: an active red-flag injury flag can override the planner and force modification.

---

## 3. Session structure taxonomy

| Structure | Defining parameters | Qualities developed | Recovery cost |
|---|---|---|---|
| Steady-state (continuous) | duration, intensity (%HRmax/zone) | Aerobic base | Low |
| Intervals — long (VO2max) | 3–5 min work : ~equal rest, 4–6 reps, ~90–100% | VO2max, aerobic power | High |
| Intervals — HIIT/short | 15–60 s : 1:1–1:4 rest | Anaerobic capacity, VO2max | High |
| Intervals — SIT (sprints) | 5–30 s all-out : long rest (1:>6) | Anaerobic power, neural | Very high |
| Circuits | stations, time/reps per station, rounds | Work capacity, muscular endurance | Moderate |
| EMOM | fixed reps at top of each minute, N minutes | Work capacity, pacing | Moderate |
| AMRAP | fixed time, max rounds/reps | Work capacity, conditioning | Moderate–high |
| Complexes | series of lifts, same implement, no rest | Power-endurance | High |
| Supersets | 2 exercises back-to-back (agonist/antagonist or same-muscle) | Time efficiency, hypertrophy | Moderate |
| Cluster sets | intra-set rests (e.g., 3×(3 reps, 15s rest)) | Strength/power at higher volume | Moderate |
| Straight sets | sets × reps at fixed load, full rest | Strength, hypertrophy | Depends on load/volume |
| Pyramid | ascending/descending load or reps | Hypertrophy, warm-up-integrated | Moderate |
| Skill-then-strength | technical block → strength block | Skill + strength | Moderate |
| Technical/skill-only | drilling, low load | Motor learning | Low (systemically) |
| Active recovery | very low intensity movement | Recovery, blood flow | Negative (aids recovery) |
| Mixed/hybrid | any combination | Multiple | Variable |

**Choosing structure for the SAME goal:** Determined by (in priority order) time available, fatigue/readiness state, equipment, training age, and phase of block. Example: for hypertrophy with limited time → supersets or cluster sets; fresh + full time → straight sets. For conditioning when fatigued → steady-state instead of intervals.

**Never program back-to-back / frequency caps:** **[COACHING CONSENSUS]**
- High-intensity interval/SIT sessions: ≤2–3×/week, never on consecutive days.
- Max-effort strength (≥90% 1RM) on the same lift: not on consecutive days; ~2–3 day spacing.
- Two systemically taxing sessions (heavy legs + hard rolling) should not stack day-over-day without a recovery buffer.

**Warm-ups by session type (RAMP model — Jeffreys 2007, *Professional Strength and Conditioning* 6:12–18):** **[COACHING CONSENSUS]** RAMP = **R**aise, **A**ctivate, **M**obilize, **P**otentiate.
- **Heavy strength:** full RAMP + ramped warm-up sets to working load; potentiation matters most. ~10–15 min.
- **Conditioning:** Raise + brief mobilize; skip heavy potentiation. ~5–8 min.
- **Skill session:** movement-specific low-intensity drilling serves as warm-up; formal warm-up often unnecessary.
- **Static stretching before power/strength:** Per **Konrad et al. 2024** multilevel meta-analysis (*J Sport Health Sci*; 83 studies, 2,012 participants), the overall static-stretch strength decrement is **small (ES = −0.21, p = 0.003)** but reaches **ES = −0.84 (p = 0.004) for holds ≥60 s per bout**, and static stretching actually produced a **positive effect on subsequent jumping (ES = 0.15, p = 0.006)**. Practical rule: avoid long-duration (≥60 s) static holds of the prime movers immediately before heavy or maximal strength work; brief dynamic mobilization is preferred, but short static holds are not meaningfully harmful and may even help jump performance. **[STRONG EVIDENCE]**

**Session compression priority (60→30 min) — what to drop, in order:**
1. Drop accessory/isolation work first.
2. Drop secondary conditioning finishers.
3. Reduce volume of main work (fewer sets), keep intensity.
4. Shorten/compress warm-up (keep only ramp-to-load).
**Never drop:** the primary strength/skill stimulus of the session and the ramp needed to load it safely. Priority rule: preserve intensity of the #1 goal-relevant movement; sacrifice volume and accessories.

---

## 4. Exercise selection and rotation

**Decision logic for choosing an exercise (encodable cascade):**
1. Filter by equipment available.
2. Filter by pain/injury constraints (remove contraindicated patterns).
3. Filter by movement refusals/preferences.
4. Match to the target movement pattern and muscle for the slot.
5. Rank by stimulus-to-fatigue ratio for the goal.
6. Prefer exercises the athlete can load progressively and measure.
7. Break ties by novelty preference and enjoyment (adherence).

**Weekly movement-pattern coverage:** squat, hinge, horizontal push, vertical push, horizontal pull, vertical pull, carry/loaded gait, rotation/anti-rotation, locomotion. **Consequences of gaps:** persistent gaps create strength imbalances and raise injury risk (e.g., neglected hinge → weak posterior chain; neglected pulling → shoulder issues). Encode a weekly pattern-coverage checklist with a warning when a pattern is missing for >1–2 weeks.

**Substitution rules — what makes two exercises interchangeable:** same primary movement pattern, similar ROM and loading vector, comparable stability demand, and it can be progressed/measured similarly. A swap is a **downgrade** when it reduces loadability, trains a shorter ROM, removes a key stabilizing demand, or breaks progression continuity (loses the load history). Substitution triggers: equipment (equal-quality swap), pain (regress to pain-free variant), fatigue (lower systemic-cost variant), boredom (equal-quality variant — but warn that changing the exercise resets the progression baseline).

**Exercise order within a session:** **[COACHING CONSENSUS]**
1. Power/explosive/skill (fresh CNS) first.
2. Heavy compound multi-joint next.
3. Secondary compounds.
4. Isolation/accessory.
5. Conditioning/finishers last (unless conditioning is the priority goal — then it moves up).
Rule: the movement most dependent on the goal and most demanding of technique/CNS comes first.

**How often to change exercises, and what stays fixed:** Main lifts should stay constant long enough to progress and measure — typically for the whole block (4–8 weeks) or until stalled. Rotate accessories more freely (every 2–4 weeks). **What must stay constant for measurable progression:** the main lift, the load-tracking metric, and the rep scheme within a block. **Rotate freely:** accessory selection, tempo (with caution), session structure, and — between blocks — set/rep scheme.

**Volume distribution — weekly sets per muscle group (Israetel/RP landmarks):** **[COACHING CONSENSUS; the exact numbers are contested]**

| Landmark | Definition | Typical sets/muscle/week |
|---|---|---|
| MV (maintenance) | Keep what you have | ~4–8 |
| MEV (min. effective) | Minimum to grow | ~8–12 for most major muscles |
| MAV (max adaptive) | Fastest growth zone | ~12–20 |
| MRV (max recoverable) | Ceiling before regression | ~18–26 (varies sharply by muscle) |

Training-age branch: beginners grow on 6–10 sets/muscle/week; trained lifters generally 10–20. **These numbers are contested** — a vocal minority (e.g., minimalist 5×5 advocates) build substantial muscle on far less, and individual MRV varies widely with sleep, stress, nutrition, and age. Count compound-lift contributions as ~1.0 direct / ~0.5 indirect per assisting muscle to avoid double-counting.

---

## 5. Progression, autoregulation, and fatigue management

**Concrete progression rules by modality:** **[COACHING CONSENSUS unless noted]**

| Modality | Progression rule | Increment |
|---|---|---|
| Barbell lifts | When all prescribed reps completed at target RIR for the session, add load next session (novice) or next week (intermediate) | +2.5–5 lb upper, +5–10 lb lower |
| Dumbbell lifts | Same, but increments are chunkier | Next dumbbell up (often +5 lb/hand); bridge with added reps first (double progression) |
| Machine work | Double progression: add reps to top of range, then add load | +1 plate/pin increment |
| Bodyweight | Add reps → add tempo/pause → progress to harder leverage variant → add external load | +1–2 reps or harder variant |
| Isometric holds | Add time, then add load | +5–10 s or +5 lb |
| Conditioning | Add duration, then intensity/density (shorter rest) | +5–10% weekly volume cap heuristic |
| Mobility | Add ROM/hold time; progress to loaded end-range | +5–10 s holds, 2×/week min |
| Skill | Progress complexity/resistance/live-ness; not linear load | Coach-judged competency gates |

**Double progression** (grow reps within a range, then add load and reset reps) is the workhorse for intermediates and for dumbbell/machine/bodyweight work.

**Training gaps — decayed-load rule (3× in 10 days vs 3× in 40 days):** After a layoff, re-prescribe below last load and re-ramp. Heuristics: **[OPINION / COACHING CONSENSUS — numbers approximate]**
- <7–10 days off: no adjustment; resume as planned.
- 2–3 weeks off: reduce working load ~5–10% and rebuild over 1–2 sessions.
- 4–6 weeks off: reduce ~10–20%; rebuild over 2–4 weeks.
- >6–8 weeks: restart near a conservative baseline and re-ramp; expect faster recovery than initial acquisition.
Branch by movement type (skill-dependent lifts decay slower in strength but need technical re-grooving; conditioning decays fastest) and training age (higher training age → faster re-acquisition; "muscle memory" holds up to ~6–12 months). Regain is roughly **half the time it took to build**; previously-trained strength returns in weeks not months.

**Deload triggers and content:** **[COACHING CONSENSUS]**
- **Planned:** every 4–8 weeks (intermediate/advanced 4–6; beginners 6–8, or often not needed).
- **Reactive triggers:** performance drops ≥2 consecutive sessions on the same lift; disrupted sleep + irritability; joint niggles; motivation collapse.
- **Content:** reduce **volume ~30–50%** as primary lever; reduce **intensity ~10–20%** secondarily; keep movement patterns and neural drive (train at RPE 6–7, keep some singles/doubles at ~80–85% for skill). **Do not fully rest** — maintaining ~30–40% of volume retains strength better than complete rest. Duration 5–7 days (extend to 9–10 if performance dipped ≥2 sessions or wellness poor). Planned deloads are proactive/scheduled; reactive deloads respond to accumulated fatigue signals and often mean you waited too long.

**Hold-steady decision:** After **2 consecutive stalled sessions** on a lift (failed to hit prescribed reps at target RIR), hold the load (repeat) rather than progress. Intervention order if still stalled: (1) repeat load, (2) reduce volume slightly / add a rep-target, (3) small back-off then re-approach (~10% "reset"), (4) swap to a variant, (5) deload the lift.

**RPE/RIR reliability:** **[STRONG EVIDENCE]** Experienced lifters (>1 yr) rate RIR far more accurately than novices; accuracy is highest **near failure** (0–3 RIR) and degrades at higher RIR (5+). Per **Zourdos et al. 2016** (*J Strength Cond Res* 30(1):267–275, 29 squatters), the RIR-based RPE/velocity inverse correlation was **r = −0.88 in experienced vs. r = −0.77 in novice** squatters, and experienced lifters rated a 1RM more accurately (RPE 9.80 ± 0.18 vs. 8.96 ± 0.43, p = 0.023); experienced-squatter RPE SD at 100% 1RM was 0.32 vs. 1.18 at 60%. Implication: **novices should not autoregulate load solely on RIR** until calibrated; prescribe %1RM or fixed loads with RIR as a secondary check. Simplest usable scale: a **single per-session sRPE (0–10)** is enough for load monitoring; **per-set RIR** is needed for fine load autoregulation. Tradeoff: a single post-session rating is cheap and adequate for weekly load trends but misses within-session load-selection errors that per-set RIR catches.

**Session-RPE (Foster method) for load quantification:** **[STRONG EVIDENCE]** Foster et al. (2001, *J Strength Cond Res* 15(1):109–115). Ask "How was your workout?" on the CR-10 (0–10) scale ~30 minutes post-session; **Session Load (AU) = sRPE × duration (min)**. Example: 87 min × RPE 4 = 348 AU. Derivatives (Foster 1998, *Med Sci Sports Exerc* 30:1164–1168): **Monotony** = weekly mean daily load ÷ SD of daily load; **Strain** = weekly total load × monotony. High monotony + high load associates with overtraining/illness. This is the most defensible, low-tech load metric for an app.

**HRV / RHR / sleep modifications — CONTESTED TERRITORY:** **[WEAK/CONTESTED EVIDENCE]** The best meta-analytic evidence, **Manresa-Rocamora et al. 2021** (*Int J Environ Res Public Health* 18:10299), found HRV-guided training superior only for vagal HRV — **"SMD+ = 0.50 (95% CI 0.09, 0.91)"** — but **not for resting HR (SMD+ = 0.04, CI −0.34–0.43)**, and non-significant for maximal aerobic capacity (SMD+ = 0.20, CI −0.07–0.47) and endurance performance (SMD+ = 0.20, CI −0.09–0.48). Wearable "readiness/recovery" scores are proprietary, largely unvalidated against performance outcomes, and commercially motivated. **Use trends, not single days; use personal rolling baselines, not population norms.** Defensible thresholds (frame as heuristics, not settled science):

| Signal | Threshold (relative to personal baseline) | Modification |
|---|---|---|
| HRV (RMSSD, morning) | Drop >~1 SD below rolling 7-day baseline, sustained ≥2 days | Reduce intensity/volume of hard session; keep easy work |
| HRV suppression | >20–30% below baseline persisting >48h | Convert to recovery/deload |
| Resting HR | Elevated >~5–7 bpm above baseline | Caution flag; reduce high-intensity |
| Sleep | <~6h or markedly poor vs. need | Cut volume ~20%; avoid max effort |

Be explicit in-app: this evidence is weak and oversold by wearable companies; a good subjective wellness questionnaire is at least as defensible.

**Composite readiness score — what commercial systems use and what's defensible:** WHOOP (per its developer docs and patents) combines HRV (most heavily weighted), RHR, respiratory rate, sleep performance, plus skin temp/SpO2, benchmarked to **personal baseline**, output 0–100 banded **Green ≥67 / Yellow 34–66 / Red ≤33**. WHOOP's patent (US 11,541,201) describes each variable weighted **"about 1% to about 95%"** — i.e., weights are tunable/undisclosed. **Defensible construction:** a personal-baseline z-score blend weighting **subjective wellness ≥ HRV > sleep > RHR**, with recent training load (sRPE-based CTL/ATL) as context. Do not over-trust any single-day composite. WHOOP member averages for context: HRV ~65ms men / 62ms women; RHR ~55 men / 59 women; average daily recovery ~58%.

**Load-monitoring frameworks — TSS/CTL/ATL/TSB and ACWR:** The Banister impulse-response lineage (TSS, and Coggan's CTL/ATL/TSB) is the endurance-industry standard: **CTL ("Fitness") = 42-day exponentially weighted moving average of daily TSS; ATL ("Fatigue") = 7-day EWMA; TSB ("Form") = CTL − ATL.** Recursive form: `CTL_today = CTL_yesterday + (TSS_today − CTL_yesterday)/42`. TSB of roughly +5 to +15 indicates freshness/peak; sustained below ~−30 is a fatigue warning. **[COACHING CONSENSUS in endurance]**

**ACWR — largely discredited as originally sold:** **[STRONG EVIDENCE against]** Impellizzeri et al. (2020, 2021, *Sports Medicine*) and Lolli et al. (2019) showed the acute:chronic workload ratio suffers **mathematical coupling**, lacks causal interpretation, and produces inconsistent results; substituting contrived/random chronic-load values reproduced the same "injury association" (OR ~1.95 with average CL; OR 1.16–2.07 with random CLs), proving the ratio adds no predictive value beyond acute load. Impellizzeri's group requested retraction/correction of the widely-republished "sweet spot" figure. **Do not build injury prediction on ACWR.** Use absolute load, week-to-week change caps (~≤10% weekly increase as a soft heuristic, itself contested), and monotony/strain instead.

**Concurrent-training interference — real rules:** **[STRONG EVIDENCE]** Per the **Wilson et al. 2012 meta-analysis** (*J Strength Cond Res* 26(8):2293–2307; 21 studies, 422 effect sizes), strength-alone vs. concurrent produced SMDs of **1.76 vs. 1.44 (strength), 1.23 vs. 0.85 (hypertrophy), and 0.91 vs. 0.55 (power)** — i.e., a real but moderate blunting. Crucially, **running (not cycling) drove the significant decrements**, and endurance **frequency (r = −0.26 to −0.35) and duration (r = −0.29 to −0.75) were negatively correlated** with gains. The effect is minimal at moderate volumes and practically irrelevant for most recreational athletes. Rules:
- Separate strength and endurance by **≥6 hours** (some say 3h minimum) to minimize acute interference; ideally different sessions/days.
- If same session, **strength before endurance** to protect neuromuscular quality (small effect).
- **Running interferes more than cycling** (eccentric load, muscle damage); **HIIT interferes less than long moderate cardio**.
- Interference grows with high endurance volume/frequency.

**Load-tolerance rules for training around pain (physio consensus):** **[STRONG EVIDENCE — tendinopathy]** Silbernagel pain-monitoring model + BJSM 2019 tendinopathy consensus:
- Pain **≤3/10** during loading is acceptable if it doesn't progressively worsen (some protocols allow up to 5/10 if it settles).
- **24-hour rule:** if pain is elevated the next morning above pre-session baseline, the prior session exceeded current tolerance → reduce load/volume ~30% next session.
- **Trend over days matters more than any single day.**
- Loading continuum: isometrics (pain relief, e.g., 5×45s at 40–70% MVC) → slow heavy isotonic → energy storage → plyometric/return to sport.
- **Immediate referral / stop:** sharp escalating pain, joint instability/giving way, neurological symptoms (numbness, radiating pain, weakness), night pain, red-flag signs (unexplained swelling, systemic symptoms), or trauma with suspected structural tear.

---

## 6. Combat sports and skill-based training

**Programming S&C around BJJ/MMA (Joel Jamieson, *Ultimate MMA Conditioning*):** **[COACHING CONSENSUS]** Mat time imposes heavy, poorly-quantified mixed aerobic/anaerobic and eccentric load. Jamieson's approach: assess energy-system profile first (his BioForce framework: Test→Assess→Program→Train→retest), then build aerobic base ("cardiac output" work) before layering anaerobic power/capacity, tapering high-intensity conditioning to end ~1 week before competition.

**Accounting for unlogged sparring/rolling:** Treat every hard sparring/rolling session as a **high-load conditioning + eccentric-stress session** in the weekly budget. Encode: prompt the athlete to log mat sessions with duration + sRPE (Foster method) so rolling contributes to weekly load (AU). A hard roll is easily 300–600+ AU and should reduce planned conditioning volume that week.

**Sequencing mat time and lifting:** **[COACHING CONSENSUS]**
- Same day: lift **after** skill if skill is priority; separate by ≥6h if possible.
- Hard sparring and heavy lower-body strength should not stack on consecutive days without a recovery buffer.
- Minimum: keep at least one genuine recovery day/week even in-season.

**Camp vs. off-season:** Off-season → build strength/hypertrophy and aerobic base (higher lifting volume). Camp (6–8 weeks out) → shift to conditioning specificity and power maintenance, reduce lifting volume to maintenance (1–2×/week, keep intensity), peak conditioning, then **taper**: cut volume 40–60% in the final ~1–2 weeks while keeping some intensity/sharpness; Jamieson ends hard conditioning ~1 week before the fight.

**Common grappling/striking injuries & standard prehab:** **[COACHING CONSENSUS]**
- **Neck** (cranks, chokes, bridging): isometric neck strengthening, controlled resistance, postural work.
- **Shoulder** (kimura/armbar leverage): rotator-cuff external rotation (band, progress 1→5 kg), scapular control (band pull-aparts, scapular push-ups).
- **Knee** (leg locks, guard, heel hooks — MCL/ACL/meniscus/posterolateral corner): quad/hamstring strength, VMO activation, joint stability.
- **Elbow/fingers** (grip fighting): grip and forearm strengthening, wrist/finger loading.
- **Low back**: anti-rotation (Pallof press), dead bugs, planks, hinge strength.
Standard prehab: CARs (controlled articular rotations), rotator-cuff + scapular work, neck isometrics, hip mobility.

**Serious amateur (job + family) vs. competitive athlete:** Simplify: fewer weekly sessions (2–3 lifts), full-body or upper/lower splits, autoregulated volume, minimal specialized peaking. **Never cut:** the injury-prehab dose, adequate recovery day(s), and the one or two main strength movements that preserve the training base. The amateur's program must survive an unpredictable schedule — build in flexibility and a fixed non-negotiable minimum.

---

## 7. Macro structure — long-term goals into weekly plans

**Decomposing a 6–12 month goal:** **[COACHING CONSENSUS]** Backward-plan from the event. Use **block periodization** (Issurin): sequence of **Accumulation** (high volume, low intensity/specificity, ~2–6 wk, typically ~4) → **Transmutation** (reduced volume, higher intensity/specificity, ~2–4 wk) → **Realization** (taper/peak, low volume, highest specificity, ~1–3 wk). A full accumulation→transmutation→realization cycle = one "stage" ~8–12 weeks; stack stages across the macrocycle. Exploit **residual training effects** — a trained quality decays over a known window (e.g., aerobic base ~25–35 days), which sets how far out a block can be placed before the quality must be refreshed.

**Block-transition triggers:** primarily **calendar** (block length set by residual windows and the event date), refined by **performance milestones** and **athlete state**. When a milestone isn't met on schedule: extend the current block 1–2 weeks (if fatigue is the limiter, deload then retest), or lower the target and proceed (if the timeline is fixed by the event). Encode both a scheduled block end and a milestone check; on miss, branch to extend-or-proceed based on whether the event date is movable.

**Block → week → session distribution rules:** **[COACHING CONSENSUS]**
- Spacing between similar hard sessions: ≥48h for the same quality/muscle; ≥72h for max-effort.
- Place hardest sessions when the athlete is freshest and away from fixed-commitment fatigue.
- ≥1 rest/active-recovery day per week; avoid 3+ consecutive hard days.

**Building around immovable commitments (e.g., BJJ Tue/Thu evening):** **[COACHING CONSENSUS]**
- Treat fixed sport days as hard sessions in the load budget.
- **Day before a hard fixed session:** keep light or skill/easy — don't pre-fatigue.
- **Day after:** recovery, mobility, or a non-competing quality (e.g., upper-body if mat time hammered legs/grip); avoid stacking another max session.
- Place heavy lower-body strength on days maximally distant from mat days.

**End-of-block re-evaluation:** re-test key metrics (estimated maxes, conditioning benchmark, bodyweight, pain status), review adherence and logged loads, and compare to block goals; use this to set the next block's emphasis and starting loads.

**Plan vs. reality — missed-session handling:** **[COACHING CONSENSUS / OPINION]**
- **1 missed session:** let it go or shift the priority stimulus to the next available day; don't cram.
- **Missed a few in a week:** redistribute only the priority work; drop accessories.
- **Chronic misses (e.g., <~50% adherence over 2–3 weeks, or the same session type repeatedly skipped):** **re-plan** — the program doesn't fit the life. Reduce frequency to what's realistic.
- After illness or >1 week off: resume with reduced load (see §5 decay rules), don't "make up" volume.
Encode a rolling adherence rate; if it drops below a threshold (~2/3 of planned sessions over a 2–3 week window), trigger a re-plan rather than daily patching.

---

## 8. The human element — what makes coaching feel coached

**Behaviors reducible to trigger→response (encodable "coaching feel"):** **[OPINION / behavior-change evidence]**
- Long absence detected → welcome-back message + explicitly reduced re-entry load ("we'll rebuild, not restart").
- Past injury on file + today loads that region → proactive check-in ("how's the knee before we load it?").
- PR achieved → acknowledge it and reference history ("best squat in 4 months").
- Repeated skip of one exercise → surface it ("you've skipped these — want a swap?").
- Mid-session failed reps / high reported RPE → offer real-time modification.

**Novelty preferences:** Some want identical sessions (comfort, measurable progress), some want constant variety, most want a **stable core + rotating accessories**. Accommodating novelty has a **measurable cost only when it changes the main lifts** (resets progression baselines, muddies measurement); rotating accessories costs essentially nothing. Novelty/variety uniquely supports intrinsic motivation (SDT literature: novelty-variety "is strongly correlated with autonomy and competence experiences"). Encode a per-user novelty setting that governs accessory rotation rate while keeping main lifts fixed within a block.

**"Same muscle, something different today":** Change the **exercise variation, implement, or set/rep structure**; hold constant the **target muscle/pattern, the intended stimulus (load zone, proximity to failure), and weekly volume**. Warn if the swap loses progression tracking on a main lift.

**"I'm not feeling it today" — options and choice logic:**
- **Push** if objective readiness is fine and it's likely motivational inertia (offer a reduced warm-up commitment: "just do the first work set").
- **Modify** (reduce volume/intensity, autoregulate down) if moderately fatigued — most common correct answer.
- **Cancel/active-recovery** if readiness signals are genuinely poor (poor sleep + elevated RHR + high soreness) or pain flags.
Encode: cross-reference the subjective report with readiness data and recent load to pick push/modify/cancel.

**Push vs. back off beyond biometrics — the tells:** technical breakdown under load, bar speed cratering, rising session RPE at same loads across sessions, mood/irritability, sleep disruption, lingering soreness, loss of appetite for training. Multiple concurrent tells → back off.

**Adherence & behavior-change evidence:** **[STRONG EVIDENCE — SDT]** Self-Determination Theory (Ryan & Deci; Kinnafick, Thøgersen-Ntoumani & Duda 2014): sustained exercise requires **autonomy** (choice/options, personal reasons), **competence** (structure, positive feedback, achievable goals), and **relatedness** (connection/support). Autonomy is especially pivotal for *maintaining* and *re-adopting* after lapse ("autonomy was particularly pertinent in facilitating adherence"); competence and relatedness drive initial adoption. Practical encodables: offer choice (exercise swaps, session options), calibrate difficulty to be achievable (avoid demoralizing failure), give positive feedback and progress visibility, use implementation intentions ("when/where" plans) and habit anchors, keep sessions time-realistic. Difficulty miscalibration (too hard) and time burden are primary dropout causes.

**Explaining reasoning:** A brief rationale improves adherence (competence/autonomy support), but athletes want **dose-appropriate** explanation — a one-line "why" per prescription, expandable on demand, not a lecture. Encode a short "why this" string per session with optional detail.

**Scope boundaries and handoff:** Coaching scope ends at **medical diagnosis/treatment, clinical nutrition, clinical mental health, and prescription of drugs.** Handoff triggers: red-flag pain/injury → physio/physician; disordered-eating signals → clinician; persistent mood/sleep pathology → medical/mental-health referral. The app should give general guidance (sleep hygiene, protein targets) but explicitly refer out on red flags and never diagnose.

---

## 9. How this typically goes wrong

**Common automated-programming mistakes a good human avoids:** **[OPINION / COACHING CONSENSUS]**
- Treating every workout as warmup→work→cooldown regardless of goal.
- Progressing load on a schedule the athlete's recovery can't support (ignoring stall signals).
- Not counting unlogged load (rolling, manual labor, life stress) → over-prescribing.
- Over-trusting a single-day wearable readiness score.
- Resetting progression by silently swapping main lifts for "variety."
- No graceful degradation when a session is cut short or missed.
- Ignoring pain rules; pushing through the 24-hour-rule violation.
- Population-average thresholds instead of personal baselines.

**Template vs. individualized — which gaps software CAN close:**
- **Closeable:** load autoregulation from logged performance; volume-landmark tracking; readiness-based daily adjustment; substitution for equipment/pain; adherence-driven re-planning; movement-pattern balance checks. (Fitbod already does muscle-recovery-weighted selection + dynamic 1RM estimation; TrainerRoad does per-zone progression levels + post-session survey adaptation.)
- **Hard to close:** reading technical breakdown live, interpreting ambiguous "not feeling it," building genuine relatedness, judging when to break the rules.

**Genuinely automation-resistant parts:** real-time technique correction, nuanced pain interpretation, the trust/relationship that drives adherence, and context no sensor captures (a stressful week, a nagging fear after injury). These need human-in-the-loop or conservative defaults.

**What commercial platforms persist vs. generate (publicly described):** **[COMPANY DOCS / PATENTS]**
- **Fitbod:** persists per-muscle recovery % (0–100, full recovery modeled at ~6–7 days), dynamically estimated 1RM per lift, user equipment, exercise preferences (recommend more/less/never), and feedback. Generates each session on the fly via an "Exercise Selector" + "Capability Recommender," scoring exercises by muscle freshness; bakes in evidence-based rep/set targets (hypertrophy 6–12 reps, 10–20 sets/muscle/wk; strength 1–5 reps, 3–5 min rest). Accessory muscles capped at 1–2 exercises/session.
- **TrainerRoad Adaptive Training:** persists per-athlete **Progression Levels (1–10) across 7 power zones** (Endurance, Tempo, Sweet Spot, Threshold, VO2 Max, Anaerobic, Sprint) and objective **Workout Levels (1–10)** for ~3,000+ workouts. Generates difficulty-matched sessions by comparing the two; a **1–5 post-workout Intensity Survey** (anchors keyed to "could you do one more interval set" — 1 Easy / 2 Moderate / 3 Hard / 4 Very Hard / 5 Max) plus power-vs-target data adjusts Progression Levels after each session. The survey is weighted against objective data and does *not* by itself move athlete levels. Newer "TrainerRoad AI" runs "hundreds of simulations" over a rolling 4-week window using power + HR + RPE + schedule/goals. Built on an internal ML system trained on millions of activities. (Note: some third-party reviews cite a "1–10" RPE; TrainerRoad's own docs specify the 1–5 scale — treat 1–5 as authoritative.)
- **Endurance platforms (Athletica, TriDot, TrainingPeaks lineage):** persist load state via the **Banister impulse-response / TSS model** — CTL (42-day EWMA of TSS = "Fitness"), ATL (7-day EWMA = "Fatigue"), TSB (= "Form"). Athletica uses an explicitly "modified Banister (1975)" model and decomposes a plugged-in race date into a plan from ~2 years of imported Garmin/Strava data (founder Paul Laursen, Athletes Compass podcast). TriDot uses proprietary **Normalized Training Stress (NTS)** + **EnviroNorm** environmental normalization (temp/humidity/elevation/wind/terrain) + optional DNA-based **Physiogenomix** (20+ genes → Training Intensity Response, Aerobic Potential, Recovery Rate, Injury Predisposition); core "FitLogic" optimization is patent-filed (2011) but formulas undisclosed.
- **WHOOP:** persists HRV/RHR/respiratory-rate/sleep against personal baseline; generates a 0–100 recovery score (Green ≥67 / Yellow 34–66 / Red ≤33) with undisclosed tunable weights (patent: "about 1%–95%" per variable).

---

## Closing deliverables

### A. The 15 rules to encode first, ranked by impact

1. **Progression cadence by training age:** novices add load session-to-session (+2.5–5 lb upper / +5–10 lb lower); intermediates week-to-week; advanced monthly/block. *(Highest impact — wrong cadence breaks everything.)*
2. **Double progression as the default:** hit top of rep range at target RIR → add load, reset reps.
3. **Hold-then-intervene on stalls:** 2 consecutive failed sessions → repeat load; escalate (reduce volume → 10% reset → variant → deload).
4. **Session-RPE load accounting:** every session (including logged mat time) gets sRPE × minutes = AU; roll into weekly load, monotony, strain, and CTL/ATL.
5. **Pain gate (24-hour rule):** ≤3/10 during loading and settling within 24h = proceed; worse-next-morning = cut load ~30%; red flags = stop/refer.
6. **Volume landmarks per muscle:** keep weekly sets within MEV–MRV (≈8–20 for trained), drop to MV (~4–8) on deload.
7. **Deload logic:** every 4–8 weeks or on reactive triggers; cut volume 30–50%, intensity 10–20%, keep patterns; don't fully rest.
8. **Readiness modifies, doesn't dictate:** subjective wellness + trend-based HRV/RHR/sleep (personal baseline) can down-regulate today's session; never trust one day; label as weak evidence.
9. **Concurrent-training spacing:** strength ≥6h from hard endurance; strength-before-endurance if same session; cap hard interval days ≤2–3/wk, never consecutive; treat running as higher-interference than cycling.
10. **Build around fixed commitments:** treat sport days as hard sessions; day-before = easy, day-after = recovery/non-competing quality.
11. **Exercise-order rule:** power/skill → heavy compound → secondary → isolation → conditioning (unless conditioning is the priority).
12. **Substitution equivalence check:** same pattern/ROM/loading vector/progressability, else flag as downgrade and warn about lost progression history.
13. **Maintenance MED for non-priority goals:** hold qualities on minimum dose (strength 1×/wk ≥80%; aerobic 2×/wk high intensity; mobility 2×/wk) while 1–3 priority goals advance.
14. **Adherence-triggered re-plan:** rolling adherence <~2/3 of planned sessions over 2–3 weeks → reduce frequency/re-plan, don't patch daily.
15. **Decayed-load re-entry:** scale load by time off (<10d none; 2–3wk −5–10%; 4–6wk −10–20%; >6–8wk restart+ramp), branch by training age.

### B. The 5 data points an app must collect that most don't — and how

1. **Unlogged load (sparring, manual labor, sport).** *Collect:* one-tap "did you do anything hard today?" + duration + 0–10 RPE → sRPE AU. Low burden, huge accuracy gain.
2. **Immovable fixed commitments.** *Collect:* a one-time weekly grid tap ("mark your fixed hard days"). Structures the whole week.
3. **Movement refusals / hated exercises.** *Collect:* passive learning from skips/swaps + a one-time "any exercises you refuse to do?" Reduces silent non-adherence.
4. **Personal definitions of "good" and "wrecked."** *Collect:* at onboarding, two sliders/anchoring questions to calibrate the subjective wellness scale to the individual.
5. **Why the last program failed.** *Collect:* single onboarding multiple-choice ("too long / too hard / boring / life got busy / injury"). Directly informs difficulty and session-length defaults.

### C. The 5 rules where confidence is lowest, and what would resolve them

1. **Exact HRV/RHR/sleep thresholds → session modification.** Evidence is weak and device-specific (Manresa-Rocamora 2021 shows benefit only for vagal HRV, not performance). *Resolution:* within-app A/B of readiness-gated vs. fixed programming on performance and adherence, using personal baselines.
2. **Recovery cost / "free" ceiling of daily micro-dosed add-ons.** Mostly opinion. *Resolution:* controlled study of add-on volume vs. main-lift performance and systemic fatigue markers.
3. **Decayed-load re-entry percentages by time-off × training age × movement type.** Heuristic, not well-quantified. *Resolution:* mine large logged-training datasets for post-layoff performance to fit decay/re-acquisition curves.
4. **Exact weekly sets/muscle (MEV/MAV/MRV) by individual.** Contested numbers, high inter-individual variance. *Resolution:* individualized dose-response auto-titration within the app (progress volume until performance/recovery degrade, then back off).
5. **Adherence threshold that should trigger a full re-plan vs. adjustment.** The ~2/3 figure is a reasoned guess. *Resolution:* survival analysis on dropout vs. re-plan timing across a user base to find the adherence inflection point.