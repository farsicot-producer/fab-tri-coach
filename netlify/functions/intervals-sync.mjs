// netlify/functions/intervals-sync.mjs   →  GET /api/intervals-sync  (+ planifiée)
// ─────────────────────────────────────────────────────────────────────────
// Hub de données : tire activités + bien-être depuis l'API intervals.icu
// (qui agrège Garmin en pleine fidélité : charge, HRV nocturne, sommeil,
// FC repos, Training Readiness), calcule la branche CHARGE (ACWR + Foster) et
// la branche RÉCUP, puis stocke les deux dans le Blob. Les lecteurs
// load.mjs et wellness.mjs se contentent de relire.
//
// Invocable à la main via l'URL (test / backfill) ET planifiée (netlify.toml).
// Ne renvoie que des compteurs agrégés — aucune donnée perso dans la réponse.
//
// Variables d'environnement (Netlify → Site settings → Environment variables) :
//   INTERVALS_API_KEY    (obligatoire)  ta clé API intervals.icu (Developer Settings)
//   INTERVALS_ATHLETE_ID (optionnel)    défaut "0" = se résout depuis la clé
// ─────────────────────────────────────────────────────────────────────────
import { getStore } from "@netlify/blobs";

const STORE  = "tri";
const K_LOAD = "icu:charge";
const K_WELL = "icu:wellness";
const WINDOW_DAYS = 35;                 // assez pour la fenêtre ACWR 28 j + marge

const API_KEY    = process.env.INTERVALS_API_KEY;
const ATHLETE_ID = process.env.INTERVALS_ATHLETE_ID || "0";

// ── Seuils / paramètres (framework de ta note) ──
const SPORTS = { swim:0, bike:0, run:0 };

const iso   = d => d.toISOString().slice(0, 10);
const sum   = a => a.reduce((x, y) => x + y, 0);
const round = (n, d) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

function sportOf(type = "") {
  const t = String(type).toLowerCase();
  if (/run/.test(t))                 return "run";
  if (/ride|bike|cycl|spin/.test(t)) return "bike";
  if (/swim/.test(t))                return "swim";
  if (/weight|strength|core|yoga|workout|crossfit/.test(t)) return "strength";
  return "other";
}

async function icu(path) {
  const auth = "Basic " + Buffer.from("API_KEY:" + API_KEY).toString("base64");
  const r = await fetch("https://intervals.icu/api/v1/athlete/" + ATHLETE_ID + path, {
    headers: { Authorization: auth }, cache: "no-store"
  });
  if (!r.ok) throw new Error("ICU " + r.status + " on " + path);
  return r.json();
}

// ═══════════════════════ Branche CHARGE (depuis activités) ═══════════════════
function buildCharge(activities) {
  const today0 = new Date(); today0.setUTCHours(0, 0, 0, 0);
  const dayKey = d => new Date(d).toISOString().slice(0, 10);

  const dailies = {};
  const bySport = { ...SPORTS };
  let last = null;

  for (const a of activities) {
    const date = (a.start_date_local || "").slice(0, 10);
    if (!date) continue;
    const load = typeof a.icu_training_load === "number" ? a.icu_training_load : 0;
    dailies[date] = (dailies[date] || 0) + load;
    if (!last || a.start_date_local > last.start_date_local) last = a;
  }

  const dayLoad = off => {
    const d = new Date(today0); d.setUTCDate(d.getUTCDate() - off);
    return dailies[dayKey(d)] || 0;
  };
  const series7  = Array.from({ length: 7  }, (_, i) => dayLoad(i));
  const series28 = Array.from({ length: 28 }, (_, i) => dayLoad(i));

  const load7  = sum(series7);
  const load28 = sum(series28);
  const acwr   = load28 > 0 ? (load7 / 7) / (load28 / 28) : null;

  const mean7    = load7 / 7;
  const sd7      = Math.sqrt(sum(series7.map(x => (x - mean7) ** 2)) / 7);
  const monotony = sd7 > 0 ? mean7 / sd7 : null;
  const strain   = monotony != null ? load7 * monotony : null;

  // charge 7 j par sport
  const cut7 = new Date(today0); cut7.setUTCDate(cut7.getUTCDate() - 6);
  for (const a of activities) {
    const date = (a.start_date_local || "").slice(0, 10);
    if (date && new Date(date) >= cut7) {
      const sp = sportOf(a.type);
      if (bySport[sp] != null) bySport[sp] += (typeof a.icu_training_load === "number" ? a.icu_training_load : 0);
    }
  }

  // sortie longue : dérive = décorrélation FC/allure calculée par intervals.icu
  let longRun = { cardiacDrift: null, cadenceDrop: null };
  const runs7 = activities.filter(a => sportOf(a.type) === "run"
    && a.start_date_local && new Date(a.start_date_local.slice(0, 10)) >= cut7
    && (a.moving_time || 0) >= 2700);
  if (runs7.length) {
    const lr = runs7.sort((a, b) => (b.moving_time || 0) - (a.moving_time || 0))[0];
    if (typeof lr.decoupling === "number") longRun.cardiacDrift = round(lr.decoupling, 1);
  }

  return {
    updatedAt: new Date().toISOString(),
    lastActivity: last ? { date: (last.start_date_local || "").slice(0, 10), sport: sportOf(last.type) } : null,
    acwr:     round(acwr, 2),
    monotony: round(monotony, 2),
    strain:   round(strain, 0),
    load7:    round(load7, 0),
    load28:   round(load28, 0),
    bySport: {
      swim: { tss: round(bySport.swim, 0) },
      bike: { tss: round(bySport.bike, 0) },
      run:  { tss: round(bySport.run,  0) }
    },
    longRun
  };
}

// ═══════════════════════ Branche RÉCUP (depuis wellness) ═════════════════════
function buildWellness(wellness) {
  const desc = wellness.slice().sort((a, b) => (a.id < b.id ? 1 : -1)); // récent -> ancien
  const latest = f => { for (const w of desc) if (w[f] != null) return w[f]; return null; };
  const base7  = f => {
    const v = [];
    for (const w of desc) { if (w[f] != null) { v.push(w[f]); if (v.length >= 7) break; } }
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  const sleepSecs = latest("sleepSecs");
  const rhr  = latest("restingHR");
  const hrv  = latest("hrv") != null ? latest("hrv") : latest("hrvSDNN");
  const ctl  = latest("ctl");
  const atl  = latest("atl");

  return {
    updatedAt: new Date().toISOString(),
    date: desc.length ? desc[0].id : null,
    sleep_h: sleepSecs != null ? round(sleepSecs / 3600, 1) : null,
    resting_hr: rhr != null ? Math.round(rhr) : null,
    resting_hr_baseline_7d: base7("restingHR") != null ? Math.round(base7("restingHR")) : null,
    hrv: hrv != null ? Math.round(hrv) : null,
    hrv_baseline_7d: base7("hrv") != null ? Math.round(base7("hrv")) : null,
    readiness: latest("readiness"),
    steps: latest("steps"),
    pmc: (ctl != null && atl != null) ? { ctl: round(ctl, 1), atl: round(atl, 1), tsb: round(ctl - atl, 1) } : null
  };
}

// ═══════════════════════════════ Handler ════════════════════════════════════
export default async (req) => {
  if (!API_KEY) {
    return json({ ok: false, error: "INTERVALS_API_KEY manquant (variable d'environnement Netlify)" }, 500);
  }
  try {
    const newest = iso(new Date());
    const oldest = iso(new Date(Date.now() - WINDOW_DAYS * 864e5));

    const [activities, wellness] = await Promise.all([
      icu(`/activities?oldest=${oldest}&newest=${newest}` +
          `&fields=id,name,type,start_date_local,moving_time,distance,icu_training_load,decoupling,average_heartrate,average_cadence`),
      icu(`/wellness?oldest=${oldest}&newest=${newest}`)
    ]);

    const charge   = buildCharge(Array.isArray(activities) ? activities : []);
    const wellObj  = buildWellness(Array.isArray(wellness) ? wellness : []);

    const store = getStore({ name: STORE, consistency: "strong" });
    await store.setJSON(K_LOAD, charge);
    await store.setJSON(K_WELL, wellObj);

    return json({
      ok: true,
      activities: Array.isArray(activities) ? activities.length : 0,
      wellnessDays: Array.isArray(wellness) ? wellness.length : 0,
      load7: charge.load7, acwr: charge.acwr,
      hrv: wellObj.hrv, sleep_h: wellObj.sleep_h
    });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 502);
  }
};

// Planification (toutes les 2 h) — voir aussi netlify.toml
export const config = { schedule: "0 */2 * * *" };

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
