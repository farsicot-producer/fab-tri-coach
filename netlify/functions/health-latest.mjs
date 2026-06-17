// health-latest.mjs — GET /api/health/latest
// Renvoie le dernier jour + les baselines, dans le format que le briefing attend.
// Auth : header "Authorization: Bearer <READ_TOKEN>"  OU  query "?token=<READ_TOKEN>"
// (l'auth par query existe exprès pour que le front/Claude puisse lire facilement).
import { getStore } from "@netlify/blobs";
import { buildLatest } from "./lib/normalize.mjs";

const STORE = "health";
const KEY = "history";

function suppliedToken(req) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const url = new URL(req.url);
  return url.searchParams.get("token");
}

export default async (req) => {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const expected = process.env.READ_TOKEN;
  if (!expected) return json({ error: "server_misconfigured", detail: "READ_TOKEN manquant" }, 500);
  if (suppliedToken(req) !== expected) return json({ error: "unauthorized" }, 401);

  const store = getStore({ name: STORE, consistency: "strong" });
  let history = [];
  try {
    history = (await store.get(KEY, { type: "json" })) || [];
  } catch {
    history = [];
  }

  // Mode diagnostic : ?debug=1 renvoie l'historique complet jour par jour,
  // pour voir exactement quelles métriques sont stockées à quelles dates.
  const url = new URL(req.url);
  if (url.searchParams.get("debug") === "1") {
    return json({ ...buildLatest(history), history });
  }

  return json(buildLatest(history));
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
