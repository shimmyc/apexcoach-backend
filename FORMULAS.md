# ApexCoach Readiness Formulas

## V1 (Original)

**Total: 100 pts across 4 pillars**

### Sleep Quality (25 pts)
- `(efficiency / 100) * 25`

### Sleep Cliff (25 pts)
- `min(25, 25 * (min(hours, 8) / 8)^4)`
- Steep exponential penalty below 8h

### Nervous System (30 pts)
- RHR component (15 pts): `max(0, min(15, 15 - ((currentRHR - baseRHR) * 1.5)))`
- HRV component (15 pts): `max(0, min(15, 15 + ((currentHRV - baseHRV) * 0.4)))`
- Baselines from 7-day rolling averages

### Recovery (20 pts)
- `max(0, 20 - (peak * 1.5 + cardio * 0.8 + fatBurn * 0.2))`
- Based on previous day's heart rate zone minutes

### Hard Caps
- < 6h sleep: max score 80
- < 5h sleep: max score 60
- < 4h sleep: max score 40

### Tiers
- 86-100: HARD TRAINING
- 66-85: MODERATE
- 46-65: LIGHT
- 0-45: RECOVERY ONLY

---

## V2 (Current)

**Total: 100 pts across 6 pillars**

### HRV vs 7-Day Baseline (25 pts)
- At or above average: 25 pts
- Each point below average: -2 pts (min 0)
- `hrvDiff >= 0 ? 25 : max(0, 25 + hrvDiff * 2)`

### RHR vs 7-Day Baseline (20 pts)
- At or below average: 20 pts
- Each bpm above average: -3 pts (min 0)
- `rhrDiff <= 0 ? 20 : max(0, 20 - rhrDiff * 3)`

### Sleep Hours (20 pts)
| Hours | Points |
|-------|--------|
| 8+    | 20     |
| 7-8   | 17     |
| 6-7   | 12     |
| 5-6   | 6      |
| < 5   | 2      |

### Sleep Quality (15 pts) - Blended
- **With Fitbit sleep score:** `(efficiency/100) * 10 + (fitbit_score/100) * 5`
- **Without Fitbit score:** `(efficiency/100) * 15` (fallback)

### Deep/REM vs 30-Day Average (10 pts)
| Condition | Points |
|-----------|--------|
| Both at or above avg | 10 |
| One below avg | 5 |
| Both below avg | 2 |
| No data | 5 (neutral) |

### Sleep Pattern Proxy (10 pts)
- Since we lack 3-night history, proxy based on current night:
  - hours >= 7 AND efficiency >= 85: 10 pts
  - hours >= 6 AND efficiency >= 75: 6 pts
  - Otherwise: 3 pts

### Hard Caps
- < 6h sleep: max score 75
- < 5h sleep: max score 55
- < 4h sleep: max score 35

### Tiers (unchanged)
- 86-100: HARD TRAINING
- 66-85: MODERATE
- 46-65: LIGHT
- 0-45: RECOVERY ONLY
