// netlify/functions/lib/access.mjs
// Contrôle d'accès aux données de l'app. Le code n'est stocké que dans la variable
// d'environnement Netlify ACCESS_CODE et sur les appareils où il a été saisi.
// Sans ACCESS_CODE, tout accès est refusé.
import { createHash, timingSafeEqual } from "node:crypto";

const sha = v => createHash("sha256").update(String(v)).digest();

function suppliedCode(req) {
  const header = req.headers.get("x-access-code");
  if (header) { try { return decodeURIComponent(header); } catch { return header; } }
  const bearer = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return bearer ? bearer[1].trim() : "";
}

export function isAuthorized(req) {
  const expected = process.env.ACCESS_CODE;
  if (!expected) return false;
  const supplied = suppliedCode(req);
  return !!supplied && timingSafeEqual(sha(supplied), sha(expected));
}
