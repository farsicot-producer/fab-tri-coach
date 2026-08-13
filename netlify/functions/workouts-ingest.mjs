// netlify/functions/workouts-ingest.mjs   →  POST /api/workouts-ingest
// ─────────────────────────────────────────────────────────────────────────
// Reçoit le POST de Health Auto Export (catégorie "Workouts") et stocke les
// séances dans un Blob roulant, dédoublonné, fenêtre 60 jours.
// AUCUN calcul ici : cette fonction ne fait qu'ingérer et normaliser.
// La charge (TRIMP, ACWR, monotony…) est calculée à la lecture par load.mjs.
// ─────────────────────────────────────────────────────────────────────────
import { getStore } from "@netlify/blobs";

const STORE       = "tri";      // ⚠️ doit être le MÊME store que load.mjs
const KEY         = "workouts";
const WINDOW_DAYS = 60;

// ── Parse un horodatage HAE "2026-08-11 07:00:00 +0200" en Date ──
function parseHAEDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  let d = new Date(s);
  if (!isNaN(d)) return d;                       // déjà ISO ?
  const m = String(s).match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{2}):?(\d{2})?/
  );
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}:${m[8] || "00"}`;
    d = new Date(iso);
    if (!isNaN(d)) return d;
  }
  return null;
}

// HAE emballe souvent les valeurs numériques dans { qty, units }
function num(x) {
  if (x == null) return null;
  if (typeof x === "object") return num(x.qty ?? x.value ?? x.Avg ?? x.avg);
  const n = Number(x);
  return isNaN(n) ? null : n;
}

function sportOf(name = "") {
  const n = String(name).toLowerCase();
  if (/run|course|trail|jog/.test(n))        return "run";
  if (/cycl|bike|vélo|velo|spin/.test(n))    return "bike";
  if (/swim|nage|natation/.test(n))          return "swim";
  if (/strength|core|gainage|muscu|functional/.test(n)) return "strength";
  return "other";
}

// FC moyenne + échantillons (pour la dérive cardiaque)
function extractHR(w) {
  const direct = num(w.avgHeartRate) ?? num(w.averageHeartRate) ?? num(w.heartRateAverage);
  const hrData = w.heartRateData || w.heartRate || [];
  let samples = [];
  if (Array.isArray(hrData)) {
    samples = hrData
      .map(p => ({ t: parseHAEDate(p.date || p.startDate || p.time), v: num(p.Avg ?? p.avg ?? p.qty ?? p.value ?? p.Max) }))
      .filter(p => p.t && p.v);
  }
  let avg = direct;
  if (avg == null && samples.length) avg = samples.reduce((a, p) => a + p.v, 0) / samples.length;
  return { avg: avg != null ? Math.round(avg) : null, samples };
}

// Cadence (course) si présente — sinon []
function extractCadence(w) {
  const cd = w.stepCadence || w.runningCadence || w.cadence || [];
  if (!Array.isArray(cd)) return [];
  return cd
    .map(p => ({ t: parseHAEDate(p.date || p.time), v: num(p.qty ?? p.Avg ?? p.value) }))
    .filter(p => p.t && p.v);
}

function normalize(w) {
  const start = parseHAEDate(w.start || w.startDate);
  const end   = parseHAEDate(w.end   || w.endDate);
  if (!start) return null;

  let durMin = start && end ? (end - start) / 60000 : null;
  if ((durMin == null || durMin <= 0) && w.duration != null) {
    const d = num(w.duration);                   // HAE : durée en secondes
    if (d != null) durMin = d / 60;
  }
  if (durMin == null || durMin <= 0) durMin = null;

  const sport   = sportOf(w.name || w.workoutType || w.type);
  const hr      = extractHR(w);
  const cadence = extractCadence(w);

  let distKm = num(w.distance);
  const units = (w.distance && w.distance.units) || "";
  if (distKm != null && /mi/i.test(units)) distKm *= 1.60934;

  return {
    id:        `${sport}|${start.toISOString()}`,   // clé de dédoublonnage
    start:     start.toISOString(),
    date:      start.toISOString().slice(0, 10),
    sport,
    durMin:    durMin != null ? Math.round(durMin * 10) / 10 : null,
    hrAvg:     hr.avg,
    hrSamples: hr.samples.map(p => ({ t: p.t.toISOString(), v: p.v })),
    cadence:   cadence.map(p => ({ t: p.t.toISOString(), v: p.v })),
    distKm:    distKm != null ? Math.round(distKm * 100) / 100 : null,
    kcal:      num(w.activeEnergyBurned)
  };
}

export default async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  let body;
  try { body = await req.json(); }
  catch { return new Response("Bad JSON", { status: 400 }); }

  const raw = body?.data?.workouts || body?.workouts || (Array.isArray(body) ? body : []);
  if (!Array.isArray(raw)) {
    return json({ ok: false, reason: "no workouts array in payload" });
  }

  // consistency: "strong" → lecture garantie à jour juste après écriture
  const store = getStore({ name: STORE, consistency: "strong" });
  const prev  = (await store.get(KEY, { type: "json" })) || { workouts: {} };
  const map   = prev.workouts || {};

  let added = 0;
  for (const w of raw) {
    const n = normalize(w);
    if (!n) continue;
    if (!map[n.id]) added++;
    map[n.id] = n;                                // écrase = met à jour
  }

  // purge fenêtre 60 j
  const cutoff = Date.now() - WINDOW_DAYS * 864e5;
  for (const id of Object.keys(map)) {
    if (new Date(map[id].start).getTime() < cutoff) delete map[id];
  }

  await store.setJSON(KEY, { workouts: map, updatedAt: new Date().toISOString() });

  return json({ ok: true, received: raw.length, added, stored: Object.keys(map).length });
};

function json(o) {
  return new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
}
