// normalize.mjs — parsing + agrégation + baselines (module pur, sans dépendance)
//
// Entrée : un payload Health Auto Export (schéma "JSON+CSV", à jour 2026).
//   { data: { metrics: [ { name, units, data: [ {date, qty | asleep | ...} ] } ], workouts: [...] } }
// Sortie : un dictionnaire { "YYYY-MM-DD": { date, sleep_h, resting_hr, hrv_ms, steps } }
//
// Tout est défensif : un champ manquant => null, jamais d'exception.

const DAY = 24 * 60 * 60 * 1000;

// "2026-06-11 06:00:00 +0000" ou "2026-06-11" -> "2026-06-11"
function dayKey(dateStr) {
  if (typeof dateStr !== "string") return null;
  const m = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function avg(arr) {
  const xs = arr.filter((x) => typeof x === "number" && !Number.isNaN(x));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sum(arr) {
  const xs = arr.filter((x) => typeof x === "number" && !Number.isNaN(x));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0);
}

// extrait la durée de sommeil (heures) d'un point de données, tous schémas confondus
function sleepHours(pt) {
  if (typeof pt.asleep === "number") return pt.asleep;
  if (typeof pt.totalSleep === "number") return pt.totalSleep;
  const stages = ["core", "deep", "rem"].map((k) => pt[k]).filter((x) => typeof x === "number");
  if (stages.length) return stages.reduce((a, b) => a + b, 0);
  if (typeof pt.qty === "number") return pt.qty; // certains exports mettent les heures dans qty
  return null;
}

// nom de métrique -> notre champ interne
function fieldFor(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("resting") && n.includes("heart")) return "resting_hr";
  if (n.includes("heart_rate_variability") || n === "hrv" || n.includes("variability")) return "hrv_ms";
  if (n.includes("sleep")) return "sleep_h";
  if (n.includes("step")) return "steps";
  return null;
}

// Parse un payload -> { dayKey: {resting_hr[], hrv_ms[], sleep_h[], steps[]} }  (valeurs brutes par jour)
function collect(payload) {
  const buckets = {};
  const metrics =
    payload && payload.data && Array.isArray(payload.data.metrics) ? payload.data.metrics : [];

  for (const metric of metrics) {
    const field = fieldFor(metric && metric.name);
    if (!field) continue;
    const points = Array.isArray(metric.data) ? metric.data : [];
    for (const pt of points) {
      const key = dayKey(pt && pt.date);
      if (!key) continue;
      buckets[key] = buckets[key] || { resting_hr: [], hrv_ms: [], sleep_h: [], steps: [] };
      if (field === "sleep_h") {
        const h = sleepHours(pt);
        if (h != null) buckets[key].sleep_h.push(h);
      } else if (typeof pt.qty === "number") {
        buckets[key][field].push(pt.qty);
      }
    }
  }
  return buckets;
}

// Agrège les valeurs brutes d'un jour en un enregistrement propre.
// FC repos & HRV : moyenne ; sommeil : somme des segments ; pas : somme.
export function aggregateDay(date, raw) {
  return {
    date,
    sleep_h: round1(sum(raw.sleep_h)),
    resting_hr: round1(avg(raw.resting_hr)),
    hrv_ms: round1(avg(raw.hrv_ms)),
    steps: sum(raw.steps),
  };
}

function round1(x) {
  return x == null ? null : Math.round(x * 10) / 10;
}

// Payload -> tableau d'enregistrements journaliers, triés par date croissante.
export function normalizePayload(payload) {
  const buckets = collect(payload);
  return Object.keys(buckets)
    .sort()
    .map((key) => aggregateDay(key, buckets[key]));
}

// Fusionne de nouveaux jours dans l'historique (un enregistrement par jour),
// le nouveau l'emporte sur l'ancien, puis tronque à `keepDays` jours glissants.
export function mergeHistory(existing, incoming, keepDays = 60) {
  const byDate = {};
  for (const rec of Array.isArray(existing) ? existing : []) {
    if (rec && rec.date) byDate[rec.date] = rec;
  }
  for (const rec of Array.isArray(incoming) ? incoming : []) {
    if (!rec || !rec.date) continue;
    const prev = byDate[rec.date] || {};
    // on ne remplace une valeur que si la nouvelle est non-nulle
    byDate[rec.date] = {
      date: rec.date,
      sleep_h: rec.sleep_h != null ? rec.sleep_h : prev.sleep_h ?? null,
      resting_hr: rec.resting_hr != null ? rec.resting_hr : prev.resting_hr ?? null,
      hrv_ms: rec.hrv_ms != null ? rec.hrv_ms : prev.hrv_ms ?? null,
      steps: rec.steps != null ? rec.steps : prev.steps ?? null,
    };
  }
  const sorted = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length <= keepDays) return sorted;
  return sorted.slice(sorted.length - keepDays);
}

// Moyenne d'un champ sur les N derniers jours qui possèdent une valeur.
function baseline(history, field, days) {
  if (!Array.isArray(history) || !history.length) return null;
  const cutoff = new Date(history[history.length - 1].date + "T00:00:00Z").getTime() - (days - 1) * DAY;
  const vals = history
    .filter((r) => new Date(r.date + "T00:00:00Z").getTime() >= cutoff)
    .map((r) => r[field])
    .filter((x) => typeof x === "number");
  return round1(avg(vals));
}

// Construit l'objet exposé par /api/health/latest, lu par le briefing.
export function buildLatest(history) {
  const list = Array.isArray(history) ? history : [];
  const last = list.length ? list[list.length - 1] : {};
  return {
    date: last.date ?? null,
    sleep_h: last.sleep_h ?? null,
    resting_hr: last.resting_hr ?? null,
    hrv_ms: last.hrv_ms ?? null,
    steps: last.steps ?? null,
    resting_hr_baseline_7d: baseline(list, "resting_hr", 7),
    hrv_baseline_30d: baseline(list, "hrv_ms", 30),
    days_in_history: list.length,
  };
}
