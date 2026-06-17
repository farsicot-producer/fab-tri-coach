// health-ingest.mjs — POST /api/health/ingest
// Reçoit les POST de Health Auto Export, normalise, fusionne dans l'historique 60 j (Netlify Blobs).
import { getStore } from "@netlify/blobs";
import { normalizePayload, mergeHistory } from "./lib/normalize.mjs";

const STORE = "health";
const KEY = "history";

function bearer(req) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export default async (req) => {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const expected = process.env.INGEST_TOKEN;
  if (!expected) return json({ error: "server_misconfigured", detail: "INGEST_TOKEN manquant" }, 500);
  if (bearer(req) !== expected) return json({ error: "unauthorized" }, 401);

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const incoming = normalizePayload(payload);

  const store = getStore({ name: STORE, consistency: "strong" });
  let existing = [];
  try {
    existing = (await store.get(KEY, { type: "json" })) || [];
  } catch {
    existing = [];
  }

  const merged = mergeHistory(existing, incoming, 60);
  await store.setJSON(KEY, merged);

  return json({
    ok: true,
    received_days: incoming.length,
    days_in_history: merged.length,
    latest_date: merged.length ? merged[merged.length - 1].date : null,
  });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
