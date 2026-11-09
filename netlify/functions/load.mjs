// netlify/functions/load.mjs   →  GET /api/load
// ─────────────────────────────────────────────────────────────────────────
// Lecteur mince : renvoie la branche CHARGE calculée par intervals-sync.mjs
// et stockée dans le Blob. Même contrat que le module « Suivi data » attend.
// (Remplace la version qui calculait le TRIMP depuis Apple Health.)
// ─────────────────────────────────────────────────────────────────────────
import { getStore } from "@netlify/blobs";
import { isAuthorized } from "./lib/access.mjs";

const STORE = "tri";
const KEY   = "icu:charge";

export default async (req) => {
  if (!isAuthorized(req)) return json({ error: "unauthorized" }, 401);
  const store  = getStore({ name: STORE, consistency: "strong" });
  const charge = await store.get(KEY, { type: "json" });
  return json(charge || { empty: true });
};

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
