// moveiq.mjs — GET /api/moveiq?from=YYYY-MM-DD&to=YYYY-MM-DD
// Cumul des trajets du quotidien (Move IQ) sur la période, lu par le Bilan.
// Ne nourrit ni l'objectif de la semaine ni la condition physique.
import { getStore } from "@netlify/blobs";
import { isAuthorized } from "./lib/access.mjs";
import { summarize } from "./lib/moveiq.mjs";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export default async (req) => {
  if (!isAuthorized(req)) return json({ error: "unauthorized" }, 401);
  const u = new URL(req.url);
  const from = u.searchParams.get("from"), to = u.searchParams.get("to");
  if (!ISO.test(from || "") || !ISO.test(to || "")) return json({ error: "from_to_requis" }, 400);
  const store = getStore({ name: "tri", consistency: "strong" });
  const hist = await store.get("garmin:moveiq", { type: "json" });
  if (!hist) return json({ empty: true });
  return json(summarize(hist, from, to));
};

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
