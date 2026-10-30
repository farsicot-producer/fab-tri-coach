// netlify/functions/next-session.mjs   →  GET /api/next-session
// ─────────────────────────────────────────────────────────────────────────
// Recommandation pour la PROCHAINE SÉANCE du programme.
//
// 1. Tire 90 j d'activités + bien-être depuis intervals.icu (même clé API
//    que intervals-sync.mjs).
// 2. Normalise dans le schéma canonique du skill triathlon-coach (MIT).
// 3. Calcule CTL/ATL/TSB, ACWR (EWMA + 7/28), monotonie, 80/20, statuts récup
//    avec lib/coach-metrics.mjs (portage JS fidèle de compute_metrics.py).
// 4. Applique la matrice de décision sur la séance prévue envoyée par le front
//    (lib/next-session-rules.mjs) : maintenir · alléger · remplacer · repos.
//
// Paramètres (query) :
//   token     READ_TOKEN si défini côté Netlify (même garde que /api/load)
//   sport     natation | cap | velo | ppg        (séance prévue)
//   type      endurance | technique | quality | mobility | strength
//   minutes   durée prévue
//   name      intitulé prévu        zone   z1..z5 (mainZone() du front)
//   id        identifiant séance (wNsK), renvoyé tel quel
//   symptom=1 cap médical coché     cap=1  clairance cardiaque périmée
//   feel=fatigue                    ressenti du jour (optionnel)
//   suivi=vert|orange|rouge         verdict de la carte Suivi data (le plus prudent gagne)
//   fcmax, ftp, pace (m:ss /km)     seuils saisis dans Réglages
//   debug=1   renvoie aussi la sortie complète du moteur
//
// Variables d'environnement : INTERVALS_API_KEY (obligatoire),
// INTERVALS_ATHLETE_ID (optionnel, défaut "0"), READ_TOKEN (optionnel).
// ─────────────────────────────────────────────────────────────────────────
import { computeMetrics } from "./lib/coach-metrics.mjs";
import { decide, gapsFr } from "./lib/next-session-rules.mjs";

const API_KEY = process.env.INTERVALS_API_KEY;
const ATHLETE_ID = process.env.INTERVALS_ATHLETE_ID || "0";
const WINDOW_DAYS = 90;   // ≥ 42 j pour que la CTL converge
const TZ = "Europe/Paris";

const todayParis = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const isoMinus = (iso, d) => new Date(Date.parse(iso + "T00:00:00Z") - d * 864e5).toISOString().slice(0, 10);
const numOrNull = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

function sportOf(type = "") {
  const t = String(type).toLowerCase();
  if (/run/.test(t)) return "run";
  if (/ride|bike|cycl|spin/.test(t)) return "bike";
  if (/swim/.test(t)) return "swim";
  if (/weight|strength|core|yoga|workout|crossfit|pilates/.test(t)) return "strength";
  return "other";
}

async function icu(path) {
  const auth = "Basic " + Buffer.from("API_KEY:" + API_KEY).toString("base64");
  const r = await fetch("https://intervals.icu/api/v1/athlete/" + ATHLETE_ID + path, {
    headers: { Authorization: auth }, cache: "no-store",
  });
  if (!r.ok) throw new Error("ICU " + r.status + " on " + path.split("?")[0]);
  return r.json();
}

// intervals.icu → schéma canonique
function toActivity(a) {
  const startLocal = a.start_date_local || a.start_date;     // date locale = jour d'entraînement
  const hrZones = Array.isArray(a.icu_hr_zone_times) && a.icu_hr_zone_times.length === 5 ? a.icu_hr_zone_times : undefined;
  const out = {
    id: "icu-" + a.id,
    source: "intervals.icu",
    sport: sportOf(a.type),
    start_time: startLocal ? String(startLocal).replace(/Z$/, "") : null,
    duration_sec: numOrNull(a.elapsed_time) ?? numOrNull(a.moving_time),
    moving_sec: numOrNull(a.moving_time),
    distance_m: numOrNull(a.distance),
    avg_hr_bpm: numOrNull(a.average_heartrate),
    max_hr_bpm: numOrNull(a.max_heartrate),
    avg_power_w: numOrNull(a.icu_average_watts),
    normalized_power_w: numOrNull(a.icu_weighted_avg_watts),
    tss_reported: numOrNull(a.icu_training_load),
    rpe: numOrNull(a.icu_rpe),
    name: a.name || null,
  };
  if (hrZones) out.time_in_hr_zones_sec = hrZones;
  return out;
}

function toWellness(w) {
  let sleep = numOrNull(w.sleepSecs);
  if (sleep != null && sleep <= 24) sleep = sleep * 3600;    // certaines réponses en heures
  return {
    date: w.id,
    hrv_rmssd_ms: numOrNull(w.hrv),                          // rMSSD ; hrvSDNN volontairement ignoré
    resting_hr_bpm: numOrNull(w.restingHR),
    sleep_sec: sleep,
    sleep_score: numOrNull(w.sleepScore),
    recovery_score: numOrNull(w.readiness),
  };
}

function parsePace(v) {
  const m = /^\s*(\d{1,2}):([0-5]?\d)\s*$/.exec(String(v || ""));
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };

export default async (req) => {
  const url = new URL(req.url);
  const q = k => url.searchParams.get(k);

  if (process.env.READ_TOKEN && q("token") !== process.env.READ_TOKEN) return json({ ok: false, error: "unauthorized" }, 401);
  if (!API_KEY) return json({ ok: false, error: "INTERVALS_API_KEY manquant (variable d'environnement Netlify)" }, 500);

  const planned = {
    id: q("id") || null,
    sport: ["natation", "cap", "velo", "ppg"].includes(q("sport")) ? q("sport") : null,
    type: q("type") || "endurance",
    minutes: Math.max(0, parseInt(q("minutes"), 10) || 0),
    name: (q("name") || "").slice(0, 80),
    zone: /^z[1-5]$/.test(q("zone") || "") ? q("zone") : "z2",
  };
  if (!planned.sport || !planned.minutes) return json({ ok: false, error: "séance prévue manquante (sport, minutes)" }, 400);
  const ctx = {
    symptom: q("symptom") === "1",
    capIntensite: q("cap") === "1",
    feel: q("feel") === "fatigue" ? "fatigue" : "ok",
    suivi: ["vert", "orange", "rouge"].includes(q("suivi")) ? q("suivi") : null,
  };

  try {
    const today = todayParis();
    const oldest = isoMinus(today, WINDOW_DAYS);
    const [acts, well] = await Promise.all([
      icu(`/activities?oldest=${oldest}&newest=${today}` +
        `&fields=id,name,type,start_date_local,start_date,elapsed_time,moving_time,distance,average_heartrate,max_heartrate,` +
        `icu_average_watts,icu_weighted_avg_watts,icu_training_load,icu_rpe,icu_hr_zone_times`),
      icu(`/wellness?oldest=${oldest}&newest=${today}`),
    ]);
    const wellness = (Array.isArray(well) ? well : []).map(toWellness).filter(w => w.date);

    // Seuils : ceux saisis dans l'app ; FC repos = médiane 28 j mesurée
    const fcmax = parseInt(q("fcmax"), 10) || null;
    const rhrs = wellness.filter(w => w.date >= isoMinus(today, 28) && w.resting_hr_bpm).map(w => w.resting_hr_bpm);
    const athlete = {
      sex: "M",
      hr_max_bpm: fcmax,
      hr_rest_bpm: median(rhrs),
      ftp_w: parseInt(q("ftp"), 10) || null,
      threshold_pace_sec_per_km: parsePace(q("pace")),
      css_sec_per_100m: null,
      lthr_bpm: null,
      lthr_source: null,
    };

    const canonical = { athlete, activities: (Array.isArray(acts) ? acts : []).map(toActivity), wellness, races: [] };
    const m = computeMetrics(canonical, today);
    const d = decide(m, planned, ctx);
    const pmc = m.pmc.length ? m.pmc[m.pmc.length - 1] : {};

    const body = {
      ok: true,
      generatedAt: new Date().toISOString(),
      today,
      planned,
      ...d,
      // Valeurs MESURÉES (sortie du moteur), séparées des interprétations ci-dessus
      metrics: {
        ctl: pmc.ctl ?? null, atl: pmc.atl ?? null, tsb: pmc.tsb ?? null,
        acwr_ewma: m.acwr.ewma.ratio, acwr_rolling: m.acwr.rolling.ratio,
        monotony: m.monotony.length ? m.monotony[m.monotony.length - 1].monotony : null,
        ctl_ramp_week: m.ramp.ctl_ramp_per_week,
        low_pct: m.intensity.low_pct, intensity_basis: m.intensity.basis,
        recovery: { hrv: m.recovery.hrv.status, rhr: m.recovery.rhr.status, sleep: m.recovery.sleep.status },
      },
      flags: m.flags,
      gaps: gapsFr(m, { noFcMax: !fcmax, css: null }),
      source: { name: "intervals.icu", window_days: m.meta.window_days, activities: m.meta.n_after_dedup },
      engine: "triathlon-coach compute_metrics (portage JS, MIT)",
    };
    if (q("debug")) body.debug = { metrics: m, canonical_athlete: athlete };
    return json(body);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 502);
  }
};

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
