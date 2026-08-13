// netlify/functions/load.mjs   →  GET /api/load
// ─────────────────────────────────────────────────────────────────────────
// Lit les séances stockées par workouts-ingest.mjs et calcule la branche
// CHARGE : charge quotidienne (TRIMP de Banister), charge 7 j / 28 j, ACWR,
// monotonie + strain de Foster, charge par sport, dérive cardiaque de la
// sortie longue. Renvoie exactement le contrat attendu par le module front.
// ─────────────────────────────────────────────────────────────────────────
import { getStore } from "@netlify/blobs";

const STORE = "tri";        // ⚠️ même store que workouts-ingest.mjs
const KEY   = "workouts";

// ── Paramètres physiologiques — À AJUSTER À TES VALEURS RÉELLES ──
const HR_REST = 52;   // FC de repos vraie (au réveil, pas la "FC repos" quotidienne).
const HR_MAX  = 172;  // FC max MESURÉE. 172 = placeholder Tanaka (208-0,7×52). Remplace-la.
const SEXE    = "M";

// Repli quand la FC est absente/inexploitable (natation surtout) : charge par minute
const FALLBACK_LOAD_PER_MIN = 6.0;
const STRENGTH_LOAD_PER_MIN = 3.0;

// ── TRIMP de Banister : durée × réserve FC × pondération exponentielle ──
function trimp(durMin, hrAvg) {
  if (!durMin || hrAvg == null) return 0;
  const hrr = Math.max(0, Math.min(1, (hrAvg - HR_REST) / (HR_MAX - HR_REST)));
  const k = SEXE === "F" ? 1.67 : 1.92;
  const c = SEXE === "F" ? 0.86 : 0.64;
  return durMin * hrr * c * Math.exp(k * hrr);
}

// Charge d'une séance, avec repli si FC douteuse
function loadOf(w) {
  const hrOk = w.hrAvg != null && w.hrAvg > 90;          // <90 = capteur suspect
  if (w.sport === "strength") return (w.durMin || 0) * STRENGTH_LOAD_PER_MIN;
  if (!hrOk)                  return (w.durMin || 0) * FALLBACK_LOAD_PER_MIN;
  return trimp(w.durMin, w.hrAvg);
}

const dayKey = d => new Date(d).toISOString().slice(0, 10);
const sum    = a => a.reduce((x, y) => x + y, 0);
const round  = (n, d) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

export default async () => {
  const store = getStore({ name: STORE, consistency: "strong" });
  const blob  = await store.get(KEY, { type: "json" });
  const map   = blob?.workouts || {};
  const workouts = Object.values(map);

  if (!workouts.length) {
    return json({ updatedAt: new Date().toISOString(), empty: true });
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);

  // charge par jour + dernière séance
  const dailies = {};
  let last = null;
  for (const w of workouts) {
    dailies[w.date] = (dailies[w.date] || 0) + loadOf(w);
    if (!last || new Date(w.start) > new Date(last.start)) last = w;
  }

  // séries continues (0 les jours sans séance) — indispensable pour la monotonie
  const dayLoad = off => {
    const d = new Date(today); d.setDate(d.getDate() - off);
    return dailies[dayKey(d)] || 0;
  };
  const series7  = Array.from({ length: 7  }, (_, i) => dayLoad(i));
  const series28 = Array.from({ length: 28 }, (_, i) => dayLoad(i));

  const load7  = sum(series7);
  const load28 = sum(series28);
  const acwr   = load28 > 0 ? (load7 / 7) / (load28 / 28) : null;   // moyenne aiguë / moyenne chronique

  // Foster : monotonie = moyenne/écart-type sur 7 j ; strain = charge7 × monotonie
  const mean7    = load7 / 7;
  const sd7      = Math.sqrt(sum(series7.map(x => (x - mean7) ** 2)) / 7);
  const monotony = sd7 > 0 ? mean7 / sd7 : null;
  const strain   = monotony != null ? load7 * monotony : null;

  // charge 7 j par sport
  const cut7 = new Date(today); cut7.setDate(cut7.getDate() - 6);
  const bySport = { swim: 0, bike: 0, run: 0 };
  for (const w of workouts) {
    if (new Date(w.date) >= cut7 && bySport[w.sport] != null) bySport[w.sport] += loadOf(w);
  }

  // sortie longue : dérive cardiaque (%) + chute de cadence (spm)
  let longRun = { cardiacDrift: null, cadenceDrop: null };
  const runs7 = workouts.filter(w => w.sport === "run" && new Date(w.date) >= cut7 && (w.durMin || 0) >= 45);
  if (runs7.length) {
    const lr = runs7.sort((a, b) => (b.durMin || 0) - (a.durMin || 0))[0];
    longRun.cardiacDrift = splitDelta(lr.hrSamples, "pct");   // dérive FC en %
    longRun.cadenceDrop  = splitDelta(lr.cadence,  "drop");   // chute cadence en spm
  }

  return json({
    updatedAt:    new Date().toISOString(),
    lastActivity: last ? { date: last.date, sport: last.sport } : null,
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
  });
};

// Compare la 1re moitié à la 2e moitié d'une série temporelle.
// mode "pct"  → (fin-début)/début ×100  (dérive cardiaque)
// mode "drop" → début-fin               (chute de cadence)
function splitDelta(samples, mode) {
  if (!Array.isArray(samples) || samples.length < 10) return null;
  const s = samples
    .map(p => ({ t: new Date(p.t).getTime(), v: p.v }))
    .filter(p => p.v)
    .sort((a, b) => a.t - b.t);
  if (s.length < 10) return null;
  const mid   = s[0].t + (s[s.length - 1].t - s[0].t) / 2;
  const early = s.filter(p => p.t <  mid);
  const late  = s.filter(p => p.t >= mid);
  if (!early.length || !late.length) return null;
  const avg = a => a.reduce((x, p) => x + p.v, 0) / a.length;
  const e = avg(early), l = avg(late);
  if (mode === "pct")  return e > 0 ? round((l - e) / e * 100, 1) : null;
  if (mode === "drop") return round(Math.max(0, e - l), 0);
  return null;
}

function json(o) {
  return new Response(JSON.stringify(o), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
