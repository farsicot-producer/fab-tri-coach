// netlify/functions/wellness.mjs   →  GET /api/wellness
// ─────────────────────────────────────────────────────────────────────────
// Lecteur mince : renvoie la branche RÉCUP calculée par intervals-sync.mjs
// depuis les données wellness intervals.icu (sommeil, FC repos + base 7 j,
// HRV enfin remplie, Training Readiness). Destiné à remplacer /api/health/latest
// pour la branche Récup du module (bascule côté front à faire ensuite).
//
// Forme renvoyée (compatible avec ce que lit déjà le front) :
//   { date, sleep_h, resting_hr, resting_hr_baseline_7d, hrv, hrv_baseline_7d,
//     readiness, steps, pmc:{ctl,atl,tsb} }
// ─────────────────────────────────────────────────────────────────────────
import { getStore } from "@netlify/blobs";

const STORE = "tri";
const KEY   = "icu:wellness";

export default async (req) => {
  if (process.env.READ_TOKEN) {
    const url = req && req.url ? new URL(req.url) : null;
    const tok = url ? url.searchParams.get("token") : null;
    if (tok !== process.env.READ_TOKEN) return json({ error: "unauthorized" }, 401);
  }
  const store = getStore({ name: STORE, consistency: "strong" });
  const well  = await store.get(KEY, { type: "json" });
  return json(well || { empty: true });
};

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
