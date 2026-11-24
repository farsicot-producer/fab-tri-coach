// moveiq-ingest.mjs — POST /api/moveiq/ingest
// Reçoit les trajets Move IQ envoyés par la GitHub Action (scripts/garmin_moveiq.py)
// et les fusionne dans l'historique 60 jours (Netlify Blobs, store « tri », clé garmin:moveiq).
import { getStore } from "@netlify/blobs";
import { mergeMoveIQ } from "./lib/moveiq.mjs";

const STORE = "tri";
const KEY = "garmin:moveiq";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const expected = process.env.INGEST_TOKEN;
  if (!expected) return json({ error: "server_misconfigured", detail: "INGEST_TOKEN manquant" }, 500);
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m || m[1].trim() !== expected) return json({ error: "unauthorized" }, 401);

  let payload;
  try { payload = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  if (!payload || !Array.isArray(payload.events)) return json({ error: "events_manquants" }, 400);

  const store = getStore({ name: STORE, consistency: "strong" });
  let existing = {};
  try { existing = (await store.get(KEY, { type: "json" })) || {}; } catch { existing = {}; }
  const merged = mergeMoveIQ(existing, payload);
  await store.setJSON(KEY, merged);
  return json({ ok: true, received: payload.events.length, in_history: merged.events.length });
};

function json(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}
