// netlify/functions/lib/coach-metrics.mjs
// ─────────────────────────────────────────────────────────────────────────
// Portage JavaScript fidèle de scripts/compute_metrics.py
// (skill « triathlon-coach », https://github.com/HenrikBrehm/triathlon-coach-skill)
//
// Copyright (c) HenrikBrehm — licence MIT (notice d'origine conservée,
// voir LICENSE du dépôt source). Portage JS : Fabrice Arsicot, 2026.
//
// Entrée : objet canonique { athlete, activities[], wellness[], races[] }.
// Sortie : { meta, per_activity, daily, pmc, weekly, intensity, acwr, monotony,
//            recovery, ramp, flags } — même contrat que le script Python.
// 100 % déterministe : pas de lecture d'horloge (today passé en paramètre).
//
// Formules (identiques au Python) :
//  - Charge par activité, première méthode calculable : reported | power_np |
//    power_avg | run_pace | swim_pace | hr_lthr | trimp_banister | srpe | none
//  - PMC (Coggan) : CTL k=1-e^(-1/42), ATL k=1-e^(-1/7), TSB = CTL(j-1) - ATL(j-1)
//  - ACWR : rolling 7/28 j + EWMA (Williams 2017), chronique < 10 → null
//  - Monotonie / contrainte (Foster 1998) par semaine ISO (≥ 4 j)
//  - Récup (Plews & Laursen) : HRV en ln, FC repos +3/+5 bpm, sommeil < 6,5 h / -1 h
//  - Dédoublonnage : même sport, |Δ départ| ≤ 300 s, durée à 10 % près
// ─────────────────────────────────────────────────────────────────────────

const K_CTL = 1 - Math.exp(-1 / 42);
const K_ATL = 1 - Math.exp(-1 / 7);
const LAMBDA_ACUTE = 2 / (7 + 1);
const LAMBDA_CHRONIC = 2 / (28 + 1);
const SRPE_TSS_PER_AU = 100 / 420;
const TRIMP_COEF = { M: [0.64, 1.92], F: [0.86, 1.67] };

const SOURCE_PRIORITY = ["garmin", "coros", "polar", "suunto", "wahoo", "whoop",
  "strava", "intervals.icu", "trainingpeaks", "other"];

const CANONICAL_ACTIVITY_FIELDS = [
  "id", "source", "sport", "start_time", "duration_sec", "moving_sec",
  "distance_m", "avg_hr_bpm", "max_hr_bpm", "avg_power_w",
  "normalized_power_w", "avg_pace_sec_per_km", "avg_pace_sec_per_100m",
  "tss_reported", "rpe", "time_in_hr_zones_sec", "time_in_power_zones_sec",
  "name",
];

const SPORTS = ["swim", "bike", "run", "strength", "other"];
const WEEKLY_SPORTS = ["swim", "bike", "run", "other"];

const INTENSITY_BANDS = {
  bike_if: [0.76, 0.90],
  pace_sr: [0.88, 0.97],
  hr_lthr: [0.90, 0.99],
};

const METHOD_NOTE = "Session-average classification assigns the whole session to " +
  "one bucket and underestimates the high-intensity share of " +
  "interval sessions; 80/20 target: low_pct >= ~75-80% of " +
  "classified time.";

const DAY_MS = 864e5;

// ------------------------------------------------------------------ helpers

export function r1(x) {
  if (x == null) return null;
  const v = Number(Number(x).toFixed(1));
  return Object.is(v, -0) ? 0 : v;
}

function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

// ISO datetime → ms UTC (heure naïve sans fuseau = UTC, comme le Python)
function parseDt(s) {
  if (typeof s !== "string") return null;
  let str = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(str)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str += "T00:00:00";
  str = str.replace(" ", "T");
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(str)) str += "Z";
  const t = Date.parse(str);
  return Number.isFinite(t) ? t : null;
}

// Les dates sont manipulées en nombre de jours depuis l'epoch (entiers)
function parseDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  if (new Date(t).toISOString().slice(0, 10) !== s) return null; // 2026-02-31 refusé
  return Math.round(t / DAY_MS);
}
const dayOfMs = ms => Math.floor(ms / DAY_MS);
export const isoOfDay = d => new Date(d * DAY_MS).toISOString().slice(0, 10);
// Lundi de la semaine ISO (1970-01-01 était un jeudi → décalage 3)
const weekStart = d => d - ((d + 3) % 7);

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fsum = a => a.reduce((x, y) => x + y, 0);
function pstdev(a) {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
}
// Format float « à la Python » dans les libellés (9 → "9.0")
const pf = x => { const v = r1(x); return Number.isInteger(v) ? v.toFixed(1) : String(v); };
const pyRepr = v => (v === undefined ? "None" : JSON.stringify(v).replace(/"/g, "'"));

// ----------------------------------------------------------- input handling

function prepareAthlete(raw, gaps) {
  let ath = raw.athlete;
  if (!ath || typeof ath !== "object" || Array.isArray(ath)) {
    gaps.push("athlete block missing; threshold-anchored load methods (power/pace/HR) unavailable");
    ath = {};
  }
  const sex = ath.sex === "M" || ath.sex === "F" ? ath.sex : null;
  const eff = {
    sex,
    ftp_w: num(ath.ftp_w),
    lthr_bpm: num(ath.lthr_bpm),
    hr_max_bpm: num(ath.hr_max_bpm),
    hr_rest_bpm: num(ath.hr_rest_bpm),
    threshold_pace_sec_per_km: num(ath.threshold_pace_sec_per_km),
    css_sec_per_100m: num(ath.css_sec_per_100m),
    lthr_estimated: false,
  };
  if (eff.lthr_bpm != null && ath.lthr_source === "estimated_from_hrmax") {
    eff.lthr_estimated = true;
    gaps.push("athlete.lthr_bpm supplied as an estimate (lthr_source=estimated_from_hrmax); " +
      "treated as the 0.90 x hr_max_bpm fallback, not a measured LTHR");
  }
  if (eff.lthr_bpm == null && eff.hr_max_bpm) {
    eff.lthr_bpm = 0.90 * eff.hr_max_bpm;
    eff.lthr_estimated = true;
    gaps.push("athlete.lthr_bpm missing; estimated as 0.90 x hr_max_bpm (lthr_source=estimated_from_hrmax)");
  }
  return eff;
}

function prepareActivities(raw, gaps) {
  let arr = raw.activities;
  if (!Array.isArray(arr)) {
    if (arr != null) gaps.push("activities is not an array; treated as empty");
    arr = [];
  }
  if (!arr.length) gaps.push("activities array empty");
  const out = [];
  arr.forEach((a, idx) => {
    if (!a || typeof a !== "object" || Array.isArray(a)) {
      gaps.push(`activities[${idx}] is not an object; skipped`);
      return;
    }
    let id = a.id;
    if (typeof id !== "string" || !id) {
      id = `unknown-${idx}`;
      gaps.push(`activity ${id}: missing required field 'id'; placeholder assigned`);
    }
    let source = a.source;
    if (typeof source !== "string" || !source) {
      source = "other";
      gaps.push(`activity ${id}: missing required field 'source'; set to 'other'`);
    }
    source = source.toLowerCase();
    let sport = a.sport;
    if (!SPORTS.includes(sport)) {
      gaps.push(`activity ${id}: missing or unknown sport ${pyRepr(a.sport)}; set to 'other'`);
      sport = "other";
    }
    const dt = parseDt(a.start_time);
    if (dt == null) gaps.push(`activity ${id}: missing or invalid start_time; excluded from time series`);
    const duration = num(a.duration_sec);
    const moving = num(a.moving_sec);
    if (duration == null && moving == null) gaps.push(`activity ${id}: missing required field 'duration_sec'`);
    const t_sec = moving != null ? moving : duration;
    const dist = num(a.distance_m);
    const notes = [];
    let run_pace = num(a.avg_pace_sec_per_km);
    if (run_pace == null && sport === "run" && dist && t_sec && dist > 0) {
      run_pace = t_sec / (dist / 1000);
      notes.push("avg pace derived from distance and moving time");
    }
    let swim_pace = num(a.avg_pace_sec_per_100m);
    if (swim_pace == null && sport === "swim" && dist && t_sec && dist > 0) {
      swim_pace = t_sec / (dist / 100);
      notes.push("avg pace derived from distance and moving time");
    }
    out.push({
      raw: a, id, source, sport, dt,
      date: dt != null ? dayOfMs(dt) : null,
      duration_sec: duration, t_sec, distance_m: dist,
      avg_hr_bpm: num(a.avg_hr_bpm),
      avg_power_w: num(a.avg_power_w),
      normalized_power_w: num(a.normalized_power_w),
      run_pace, swim_pace,
      tss_reported: num(a.tss_reported),
      rpe: num(a.rpe),
      notes,
    });
  });
  return out;
}

function prepareWellness(raw, gaps) {
  let arr = raw.wellness;
  if (!Array.isArray(arr)) {
    if (arr != null) gaps.push("wellness is not an array; treated as empty");
    arr = [];
  }
  if (!arr.length) gaps.push("no wellness data");
  const out = [];
  arr.forEach((w, idx) => {
    if (!w || typeof w !== "object" || Array.isArray(w)) {
      gaps.push(`wellness[${idx}] is not an object; skipped`);
      return;
    }
    const d = parseDate(w.date);
    if (d == null) {
      gaps.push(`wellness[${idx}]: missing or invalid date; skipped`);
      return;
    }
    out.push({
      date: d,
      hrv_rmssd_ms: num(w.hrv_rmssd_ms),
      resting_hr_bpm: num(w.resting_hr_bpm),
      sleep_sec: num(w.sleep_sec),
      recovery_score: num(w.recovery_score),
    });
  });
  out.sort((a, b) => a.date - b.date);
  return out;
}

// -------------------------------------------------------------------- dedup

const fieldCount = act => CANONICAL_ACTIVITY_FIELDS.filter(f => act.raw[f] != null).length;
function sourceRank(source) {
  const i = SOURCE_PRIORITY.indexOf(source);
  return i >= 0 ? i : SOURCE_PRIORITY.indexOf("other");
}
function isDuplicate(a, b) {
  if (a.sport !== b.sport || a.dt == null || b.dt == null) return false;
  if (Math.abs(a.dt - b.dt) / 1000 > 300) return false;
  const da = a.duration_sec, db = b.duration_sec;
  if (da == null || db == null) return false;
  const longer = Math.max(da, db);
  if (longer <= 0) return false;
  return Math.abs(da - db) <= 0.10 * longer;
}
function dedupWinner(a, b) {
  const fa = fieldCount(a), fb = fieldCount(b);
  if (fa !== fb) return fa > fb ? a : b;
  const ra = sourceRank(a.source), rb = sourceRank(b.source);
  if (ra !== rb) return ra < rb ? a : b;
  return a.id <= b.id ? a : b;
}
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function dedup(activities) {
  const acts = activities.slice().sort((x, y) =>
    ((x.dt ?? Infinity) - (y.dt ?? Infinity)) || cmpStr(x.id, y.id));
  const dropped = new Set();
  for (let i = 0; i < acts.length; i++) {
    if (dropped.has(acts[i].id)) continue;
    for (let j = i + 1; j < acts.length; j++) {
      if (dropped.has(acts[j].id)) continue;
      if (isDuplicate(acts[i], acts[j])) {
        const loser = dedupWinner(acts[i], acts[j]) === acts[i] ? acts[j] : acts[i];
        dropped.add(loser.id);
        if (loser === acts[i]) break;
      }
    }
  }
  return [acts.filter(a => !dropped.has(a.id)), [...dropped].sort(cmpStr)];
}

// ------------------------------------------------------------ load per spec

function loadForActivity(act, ath, gaps) {
  const t_h = act.t_sec ? act.t_sec / 3600 : null;
  const t_min = act.t_sec ? act.t_sec / 60 : null;

  if (act.tss_reported != null) return [act.tss_reported, "reported"];

  if (t_h) {
    if (act.normalized_power_w && ath.ftp_w) {
      const iff = act.normalized_power_w / ath.ftp_w;
      return [t_h * iff ** 2 * 100, "power_np"];
    }
    if (act.avg_power_w && ath.ftp_w) {
      const iff = act.avg_power_w / ath.ftp_w;
      act.notes.push("load from average power; underestimates variable rides");
      return [t_h * iff ** 2 * 100, "power_avg"];
    }
    if (act.sport === "run" && act.run_pace && ath.threshold_pace_sec_per_km) {
      const sr = ath.threshold_pace_sec_per_km / act.run_pace;
      act.notes.push("rTSS approximation from average pace; no NGP/grade adjustment");
      return [t_h * sr ** 2 * 100, "run_pace"];
    }
    if (act.sport === "swim" && act.swim_pace && ath.css_sec_per_100m) {
      const sr = ath.css_sec_per_100m / act.swim_pace;
      return [t_h * sr ** 3 * 100, "swim_pace"];
    }
    if (act.avg_hr_bpm && ath.lthr_bpm && !ath.lthr_estimated) {
      const ifhr = act.avg_hr_bpm / ath.lthr_bpm;
      act.notes.push("hrTSS from average HR vs LTHR; coarse estimate");
      return [t_h * ifhr ** 2 * 100, "hr_lthr"];
    }
    if (act.avg_hr_bpm && ath.hr_max_bpm && ath.hr_rest_bpm && ath.hr_max_bpm > ath.hr_rest_bpm) {
      let sex = ath.sex;
      if (sex == null) {
        sex = "M";
        act.notes.push("sex unknown; male TRIMP coefficients used");
      }
      const [a, k] = TRIMP_COEF[sex];
      const hrr = Math.max(0, (act.avg_hr_bpm - ath.hr_rest_bpm) / (ath.hr_max_bpm - ath.hr_rest_bpm));
      const trimp = t_min * hrr * a * Math.exp(k * hrr);
      const scale = 100 / (60 * 0.85 * a * Math.exp(k * 0.85));
      act.notes.push("Banister TRIMP scaled to TSS-equivalent (100 == 60 min @ HRr 0.85)");
      return [trimp * scale, "trimp_banister"];
    }
    if (act.avg_hr_bpm && ath.lthr_bpm && ath.lthr_estimated) {
      const ifhr = act.avg_hr_bpm / ath.lthr_bpm;
      act.notes.push("hrTSS from average HR vs LTHR estimated from HRmax (0.90 x HRmax); coarse estimate");
      return [t_h * ifhr ** 2 * 100, "hr_lthr"];
    }
    if (act.rpe) {
      act.notes.push("Foster session-RPE load; TSS-equivalent = AU x 100/420");
      return [act.rpe * t_min * SRPE_TSS_PER_AU, "srpe"];
    }
  }
  gaps.push(`activity ${act.id}: no usable load inputs; load_method=none, load_tss=0`);
  return [0, "none"];
}

// --------------------------------------------------------------- intensity

function bucket(value, band) {
  const [lowHi, modHi] = band;
  if (value < lowHi) return "low";
  if (value <= modHi) return "moderate";
  return "high";
}
function zoneBuckets(zones, n, lowIdx, modIdx) {
  const vals = [];
  for (let i = 0; i < n; i++) {
    const v = i < zones.length ? num(zones[i]) : null;
    vals.push(v && v > 0 ? v : 0);
  }
  const low = fsum(lowIdx.map(i => vals[i]));
  const mod = fsum(modIdx.map(i => vals[i]));
  return [low, mod, fsum(vals) - low - mod];
}
function dominant(b) {
  const names = ["low", "moderate", "high"];
  const best = Math.max(...b);
  if (best <= 0) return null;
  return names[b.indexOf(best)];
}
const hasPositive = z => Array.isArray(z) && z.some(v => num(v) && num(v) > 0);

function classifyActivity(act, ath) {
  const raw = act.raw;
  if (hasPositive(raw.time_in_power_zones_sec)) {
    const b = zoneBuckets(raw.time_in_power_zones_sec, 7, [0, 1], [2]);
    return [dominant(b), b, true];
  }
  if (hasPositive(raw.time_in_hr_zones_sec)) {
    const b = zoneBuckets(raw.time_in_hr_zones_sec, 5, [0, 1], [2]);
    return [dominant(b), b, true];
  }
  let rb = null;
  if (act.sport === "bike" && ath.ftp_w) {
    const p = act.normalized_power_w || act.avg_power_w;
    if (p) rb = [p / ath.ftp_w, INTENSITY_BANDS.bike_if];
  } else if (act.sport === "run" && ath.threshold_pace_sec_per_km && act.run_pace) {
    rb = [ath.threshold_pace_sec_per_km / act.run_pace, INTENSITY_BANDS.pace_sr];
  } else if (act.sport === "swim" && ath.css_sec_per_100m && act.swim_pace) {
    rb = [ath.css_sec_per_100m / act.swim_pace, INTENSITY_BANDS.pace_sr];
  }
  if (rb == null && act.avg_hr_bpm && ath.lthr_bpm) {
    rb = [act.avg_hr_bpm / ath.lthr_bpm, INTENSITY_BANDS.hr_lthr];
  }
  if (rb == null) return [null, [0, 0, 0], false];
  const cls = bucket(rb[0], rb[1]);
  const t = act.t_sec || 0;
  return [cls, ["low", "moderate", "high"].map(n => (n === cls ? t : 0)), false];
}

function intensitySummary(classified) {
  let low = 0, mod = 0, high = 0, zoneTime = 0, total = 0;
  for (const [act, , b, fromZone] of classified) {
    total += act.t_sec || 0;
    low += b[0]; mod += b[1]; high += b[2];
    if (fromZone) zoneTime += b[0] + b[1] + b[2];
  }
  const c = low + mod + high;
  return {
    basis: c > 0 && zoneTime >= 0.5 * c ? "time_in_zone" : "session_avg",
    low_sec: Math.round(low),
    moderate_sec: Math.round(mod),
    high_sec: Math.round(high),
    low_pct: c > 0 ? r1(low / c * 100) : null,
    classified_pct: total > 0 ? r1(c / total * 100) : null,
    method_note: METHOD_NOTE,
  };
}

// ------------------------------------------------------------- time series

function buildDaily(dated, today) {
  if (!dated.length || today == null) return [];
  const start = Math.min(...dated.map(a => a.date));
  const byDay = new Map();
  for (const a of dated) {
    const [l, n] = byDay.get(a.date) || [0, 0];
    byDay.set(a.date, [l + a.load_tss, n + 1]);
  }
  const s = [];
  for (let d = start; d <= today; d++) {
    const [l, n] = byDay.get(d) || [0, 0];
    s.push({ date: d, load_tss: l, n_sessions: n });
  }
  return s;
}

function computePmc(daily) {
  let ctl = 0, atl = 0;
  return daily.map(day => {
    const tsb = ctl - atl;
    ctl = ctl + (day.load_tss - ctl) * K_CTL;
    atl = atl + (day.load_tss - atl) * K_ATL;
    return { date: day.date, ctl, atl, tsb };
  });
}

function computeAcwr(daily, gaps) {
  const out = {
    rolling: { acute_7d_avg: null, chronic_28d_avg: null, ratio: null },
    ewma: { acute: null, chronic: null, ratio: null },
  };
  if (!daily.length) {
    gaps.push("acwr: no daily load series; not computed");
    return out;
  }
  const loads = daily.map(d => d.load_tss);
  const acute = mean(loads.slice(-7));
  const chronic = mean(loads.slice(-28));
  out.rolling.acute_7d_avg = acute;
  out.rolling.chronic_28d_avg = chronic;
  if (chronic >= 10) out.rolling.ratio = acute / chronic;
  else gaps.push("acwr: rolling chronic load < 10 TSS/day; ratio set to null");
  let ewA = loads[0], ewC = loads[0];
  for (const l of loads.slice(1)) {
    ewA = l * LAMBDA_ACUTE + ewA * (1 - LAMBDA_ACUTE);
    ewC = l * LAMBDA_CHRONIC + ewC * (1 - LAMBDA_CHRONIC);
  }
  out.ewma.acute = ewA;
  out.ewma.chronic = ewC;
  if (ewC >= 10) out.ewma.ratio = ewA / ewC;
  else gaps.push("acwr: ewma chronic load < 10 TSS/day; ratio set to null");
  return out;
}

function computeWeekly(dated, daily) {
  if (!daily.length) return [];
  const weeks = new Map();
  const last = weekStart(daily[daily.length - 1].date);
  for (let w = weekStart(daily[0].date); w <= last; w += 7) {
    const o = {};
    WEEKLY_SPORTS.forEach(s => { o[s] = { sessions: 0, duration_sec: 0, distance_m: 0, load_tss: 0 }; });
    weeks.set(w, o);
  }
  for (const a of dated) {
    const wk = weeks.get(weekStart(a.date));
    if (!wk) continue;
    const slot = wk[WEEKLY_SPORTS.includes(a.sport) ? a.sport : "other"];
    slot.sessions += 1;
    slot.duration_sec += a.duration_sec || a.t_sec || 0;
    slot.distance_m += a.distance_m || 0;
    slot.load_tss += a.load_tss;
  }
  return [...weeks.keys()].sort((a, b) => a - b).map(w => {
    const per_sport = {};
    let tl = 0, td = 0;
    for (const s of WEEKLY_SPORTS) {
      const slot = weeks.get(w)[s];
      per_sport[s] = {
        sessions: slot.sessions,
        duration_sec: Math.round(slot.duration_sec),
        distance_m: r1(slot.distance_m),
        load_tss: r1(slot.load_tss),
      };
      tl += slot.load_tss;
      td += slot.duration_sec;
    }
    return { week_start: isoOfDay(w), per_sport, total_load_tss: r1(tl), total_duration_sec: Math.round(td) };
  });
}

function computeMonotony(daily) {
  const byWeek = new Map();
  for (const d of daily) {
    const w = weekStart(d.date);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(d.load_tss);
  }
  const out = [];
  for (const w of [...byWeek.keys()].sort((a, b) => a - b)) {
    const loads = byWeek.get(w);
    if (loads.length < 4) continue;
    const sd = pstdev(loads);
    let monotony = null, strain = null;
    if (sd !== 0) {
      monotony = mean(loads) / sd;
      strain = fsum(loads) * monotony;
    }
    out.push({ week_start: isoOfDay(w), monotony, strain, _n_days: loads.length });
  }
  return out;
}

// ----------------------------------------------------------------- recovery

function windowVals(wellness, key, today, days) {
  const start = today - (days - 1);
  return wellness.filter(w => w.date >= start && w.date <= today && w[key] != null).map(w => w[key]);
}

function computeRecovery(wellness, today, gaps) {
  const rec = {
    hrv: { avg_7d: null, baseline_28d: null, baseline_sd: null, status: "no_data" },
    rhr: { avg_7d: null, baseline_28d: null, status: "no_data" },
    sleep: { avg_7d_sec: null, baseline_28d_sec: null, status: "no_data" },
    recovery_score_avg_7d: null,
  };
  if (!wellness.length || today == null) {
    gaps.push("recovery: no wellness series; all statuses no_data");
    return rec;
  }
  // HRV (Plews & Laursen) en ln(rMSSD)
  let v7 = windowVals(wellness, "hrv_rmssd_ms", today, 7).filter(v => v > 0);
  let v28 = windowVals(wellness, "hrv_rmssd_ms", today, 28).filter(v => v > 0);
  rec.hrv.avg_7d = mean(v7);
  rec.hrv.baseline_28d = mean(v28);
  rec.hrv.baseline_sd = v28.length >= 2 ? pstdev(v28) : null;
  if (v28.length >= 14 && v7.length) {
    const ln7 = mean(v7.map(Math.log));
    const ln28 = v28.map(Math.log);
    const m28 = mean(ln28), sd28 = pstdev(ln28);
    rec.hrv.status = ln7 < m28 - 0.75 * sd28 ? "alert" : ln7 < m28 - 0.5 * sd28 ? "watch" : "ok";
  } else {
    gaps.push("recovery.hrv: fewer than 14 days of HRV in the 28-day baseline window; status no_data");
  }
  // FC repos
  v7 = windowVals(wellness, "resting_hr_bpm", today, 7);
  v28 = windowVals(wellness, "resting_hr_bpm", today, 28);
  rec.rhr.avg_7d = mean(v7);
  rec.rhr.baseline_28d = mean(v28);
  if (v28.length >= 14 && v7.length) {
    const diff = mean(v7) - mean(v28);
    rec.rhr.status = diff >= 5 ? "alert" : diff >= 3 ? "watch" : "ok";
  } else {
    gaps.push("recovery.rhr: fewer than 14 days of resting HR in the 28-day baseline window; status no_data");
  }
  // Sommeil
  v7 = windowVals(wellness, "sleep_sec", today, 7);
  v28 = windowVals(wellness, "sleep_sec", today, 28);
  rec.sleep.avg_7d_sec = mean(v7);
  rec.sleep.baseline_28d_sec = mean(v28);
  if (v28.length >= 14 && v7.length) {
    const m7 = mean(v7);
    const short = m7 < 6.5 * 3600;
    const below = m7 < mean(v28) - 3600;
    rec.sleep.status = short && below ? "alert" : short || below ? "watch" : "ok";
  } else {
    gaps.push("recovery.sleep: fewer than 14 days of sleep data in the 28-day baseline window; status no_data");
  }
  rec.recovery_score_avg_7d = mean(windowVals(wellness, "recovery_score", today, 7));
  return rec;
}

// -------------------------------------------------------------------- flags

function computeFlags(acwr, monotony, ramp, pmc, recovery, windowDays, nKept, hasWellness) {
  const flags = [];
  const ew = acwr.ewma.ratio;
  if (ew != null) {
    if (ew > 1.5) flags.push({ code: "ACWR_HIGH", severity: "alert", detail: `EWMA ACWR ${pf(ew)} > 1.5` });
    else if (ew > 1.3) flags.push({ code: "ACWR_HIGH", severity: "warn", detail: `EWMA ACWR ${pf(ew)} > 1.3` });
    else if (ew < 0.8) flags.push({ code: "ACWR_LOW", severity: "info", detail: `EWMA ACWR ${pf(ew)} < 0.8 (undertraining/detraining)` });
  }
  const full = monotony.filter(m => m._n_days === 7);
  if (full.length) {
    const latest = full[full.length - 1];
    if (latest.monotony != null && latest.monotony > 2.0) {
      flags.push({ code: "MONOTONY_HIGH", severity: "warn", detail: `monotony ${pf(latest.monotony)} > 2.0 in week ${latest.week_start}` });
    }
  }
  const rv = ramp.ctl_ramp_per_week;
  if (rv != null) {
    if (rv > 10) flags.push({ code: "RAMP_HIGH", severity: "alert", detail: `CTL ramp ${pf(rv)}/week > 10` });
    else if (rv > 8) flags.push({ code: "RAMP_HIGH", severity: "warn", detail: `CTL ramp ${pf(rv)}/week > 8` });
  }
  if (pmc.length) {
    const tsb = pmc[pmc.length - 1].tsb;
    if (tsb < -30) flags.push({ code: "TSB_VERY_LOW", severity: "alert", detail: `TSB ${pf(tsb)} < -30` });
    else if (tsb < -25) flags.push({ code: "TSB_VERY_LOW", severity: "warn", detail: `TSB ${pf(tsb)} < -25` });
  }
  for (const [key, code, detail] of [
    ["hrv", "HRV_SUPPRESSED", "7-day ln(rMSSD) below 28-day baseline"],
    ["rhr", "RHR_ELEVATED", "7-day resting HR above 28-day baseline"],
    ["sleep", "SLEEP_DEGRADED", "7-day sleep below threshold/baseline"],
  ]) {
    const st = recovery[key].status;
    if (st === "watch") flags.push({ code, severity: "warn", detail });
    else if (st === "alert") flags.push({ code, severity: "alert", detail });
  }
  if (pmc.length && windowDays < 42) {
    flags.push({ code: "CTL_UNRELIABLE", severity: "info", detail: `data window ${windowDays} days < 42; CTL has not converged` });
  }
  if (nKept < 8 || !hasWellness) {
    flags.push({ code: "DATA_SPARSE", severity: "info", detail: `${nKept} activities in window${hasWellness ? "" : "; no wellness data"}` });
  }
  const pool = ["HRV_SUPPRESSED", "RHR_ELEVATED", "SLEEP_DEGRADED", "TSB_VERY_LOW", "ACWR_HIGH", "MONOTONY_HIGH"];
  const present = flags.map(f => f.code).filter(c => pool.includes(c));
  if (present.length >= 2) {
    flags.push({ code: "COMBINED_RECOVERY_ALERT", severity: "alert", detail: "concurrent signals: " + present.join(", ") });
  }
  return flags;
}

// ----------------------------------------------------------------- assembly

/**
 * @param {object} raw     objet canonique
 * @param {string} [todayIso] "YYYY-MM-DD" ; défaut = date max des données
 */
export function computeMetrics(raw, todayIso) {
  const gaps = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    gaps.push("input is not a JSON object; treated as empty");
    raw = {};
  }
  const ath = prepareAthlete(raw, gaps);
  const activities = prepareActivities(raw, gaps);
  const wellness = prepareWellness(raw, gaps);
  const nActivities = Array.isArray(raw.activities) ? raw.activities.length : 0;
  const sources = [...new Set(activities.map(a => a.source))].sort(cmpStr);

  const [kept, dropped] = dedup(activities);

  const cands = kept.filter(a => a.date != null).map(a => a.date).concat(wellness.map(w => w.date));
  const override = todayIso ? parseDate(todayIso) : null;
  const today = override ?? (cands.length ? Math.max(...cands) : null);
  if (today == null) gaps.push("no dated activities or wellness entries and no --today; time series not computed");

  const classified = [];
  for (const a of kept) {
    const [load, method] = loadForActivity(a, ath, gaps);
    a.load_tss = load;
    a.load_method = method;
    const [cls, b, fz] = classifyActivity(a, ath);
    a.intensity_class = cls;
    classified.push([a, cls, b, fz]);
  }

  let dated = kept.filter(a => a.date != null);
  if (today != null) {
    for (const a of dated) {
      if (a.date > today) gaps.push(`activity ${a.id}: dated after today; excluded from time series`);
    }
    dated = dated.filter(a => a.date <= today);
  }

  const daily = buildDaily(dated, today);
  const pmc = computePmc(daily);
  const weekly = computeWeekly(dated, daily);
  const intensity = intensitySummary(classified);
  const acwr = computeAcwr(daily, gaps);
  const monotony = computeMonotony(daily);
  const recovery = computeRecovery(wellness, today, gaps);

  let ramp;
  if (pmc.length && today != null) {
    const prior = pmc.find(p => p.date === today - 7);
    const ctlNow = pmc[pmc.length - 1].ctl;
    const ctl7 = prior ? prior.ctl : 0;
    ramp = { ctl_now: ctlNow, ctl_7d_ago: ctl7, ctl_ramp_per_week: ctlNow - ctl7 };
  } else {
    ramp = { ctl_now: null, ctl_7d_ago: null, ctl_ramp_per_week: null };
  }

  let windowDays = 0;
  if (daily.length) windowDays = today - daily[0].date + 1;
  else if (wellness.length && today != null) windowDays = today - wellness[0].date + 1;

  const flags = computeFlags(acwr, monotony, ramp, pmc, recovery, windowDays, dated.length, wellness.length > 0);

  const per_activity = kept.slice()
    .sort((x, y) => cmpStr(x.date != null ? isoOfDay(x.date) : "9999-12-31", y.date != null ? isoOfDay(y.date) : "9999-12-31") || cmpStr(x.id, y.id))
    .map(a => ({
      id: a.id,
      date: a.date != null ? isoOfDay(a.date) : null,
      sport: a.sport,
      duration_sec: a.duration_sec != null ? Math.trunc(a.duration_sec) : null,
      distance_m: r1(a.distance_m),
      load_tss: r1(a.load_tss),
      load_method: a.load_method,
      intensity_class: a.intensity_class,
      notes: a.notes,
    }));

  const r1obj = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r1(v)]));
  return {
    meta: {
      today: today != null ? isoOfDay(today) : null,
      window_days: windowDays,
      n_activities: nActivities,
      n_after_dedup: kept.length,
      sources,
      dropped_duplicates: dropped,
      data_gaps: [...new Set(gaps)].sort(cmpStr),
    },
    per_activity,
    daily: daily.map(d => ({ date: isoOfDay(d.date), load_tss: r1(d.load_tss), n_sessions: d.n_sessions })),
    pmc: pmc.map(p => ({ date: isoOfDay(p.date), ctl: r1(p.ctl), atl: r1(p.atl), tsb: r1(p.tsb) })),
    weekly,
    intensity,
    acwr: { rolling: r1obj(acwr.rolling), ewma: r1obj(acwr.ewma) },
    monotony: monotony.map(m => ({ week_start: m.week_start, monotony: r1(m.monotony), strain: r1(m.strain) })),
    recovery: {
      hrv: { avg_7d: r1(recovery.hrv.avg_7d), baseline_28d: r1(recovery.hrv.baseline_28d), baseline_sd: r1(recovery.hrv.baseline_sd), status: recovery.hrv.status },
      rhr: { avg_7d: r1(recovery.rhr.avg_7d), baseline_28d: r1(recovery.rhr.baseline_28d), status: recovery.rhr.status },
      sleep: { avg_7d_sec: r1(recovery.sleep.avg_7d_sec), baseline_28d_sec: r1(recovery.sleep.baseline_28d_sec), status: recovery.sleep.status },
      recovery_score_avg_7d: r1(recovery.recovery_score_avg_7d),
    },
    ramp: { ctl_now: r1(ramp.ctl_now), ctl_7d_ago: r1(ramp.ctl_7d_ago), ctl_ramp_per_week: r1(ramp.ctl_ramp_per_week) },
    flags,
  };
}
