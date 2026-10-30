// netlify/functions/lib/next-session-rules.mjs
// ─────────────────────────────────────────────────────────────────────────
// Matrice de décision « prochaine séance » — logique pure, sans I/O (testable).
//
// Principe : on ne fabrique pas une séance, on ajuste la séance PRÉVUE par le
// programme 30 semaines. Quatre issues, de la moins à la plus prudente :
//   0 maintenir · 1 alléger · 2 remplacer · 3 repos
// Chaque signal propose un niveau ; le plus prudent gagne (règle de l'app).
//
// Sources des règles : periodization-and-planning.md §4 et SKILL.md
// « Hard safety rules » du skill triathlon-coach (MIT), adaptées au plan :
//  - règle 0 (sécurité) → repos ;
//  - statut récup « alert » ou TSB < -25 → remplacer par du Z1–Z2 court ;
//  - statut récup « watch », ACWR 1,3–1,5, monotonie > 2, rampe > 8 → alléger
//    (aligné sur le feu orange de « Suivi data » : −10–15 %, sans intensité) ;
//  - 80/20 non respecté + séance qualité prévue → alléger (qualité → Z2).
// ─────────────────────────────────────────────────────────────────────────

export const STAGES = ["maintenir", "alleger", "remplacer", "repos"];
const LEVEL_OF_STAGE = ["vert", "orange", "rouge", "rouge"];
const SPORT_CANON = { natation: "swim", cap: "run", velo: "bike", ppg: "strength" };
const SPORT_LABEL = { natation: "Natation", cap: "Course", velo: "Vélo", ppg: "PPG" };

const fr = (n, d = 1) => (n == null ? "—" : (Math.round(n * 10 ** d) / 10 ** d).toLocaleString("fr-FR"));
const signed = (n, d = 1) => (n == null ? "—" : (n > 0 ? "+" : n < 0 ? "−" : "") + fr(Math.abs(n), d));
const round5 = m => Math.max(15, Math.round(m / 5) * 5);
const hm = sec => { const m = Math.round(sec / 60); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };

/**
 * @param {object} m        sortie de computeMetrics()
 * @param {object} planned  { id, sport: natation|cap|velo|ppg, type, minutes, name, zone }
 * @param {object} ctx      { symptom:bool, feel:"ok"|"fatigue", capIntensite:bool,
 *                            suivi:"vert"|"orange"|"rouge"|null  (verdict de la carte Suivi data) }
 */
export function decide(m, planned, ctx = {}) {
  const reasons = [];
  const flag = code => m.flags.filter(f => f.code === code);
  const sev = code => {
    const order = { info: 0, warn: 1, alert: 2 };
    return flag(code).reduce((a, f) => (order[f.severity] > order[a] ? f.severity : a), "none");
  };
  let stage = 0;
  // stage : niveau proposé · signal : nom court · mesure : chiffre brut · lecture : interprétation
  const add = (st, signal, mesure, lecture) => {
    reasons.push({ stage: st, level: LEVEL_OF_STAGE[st], signal, mesure, lecture });
    if (st > stage) stage = st;
  };

  const pmcLast = m.pmc.length ? m.pmc[m.pmc.length - 1] : null;
  const tsb = pmcLast ? pmcLast.tsb : null;
  const acwr = m.acwr.ewma.ratio;
  const isQuality = planned.type === "quality" || ["z3", "z4", "z5"].includes(planned.zone);

  // ── Règle 0 : sécurité (terminale) ──
  if (ctx.symptom) add(3, "Cap médical", "symptômes signalés", "Douleur neuro / mollet : aucun travail qui la reproduit.");
  if (flag("COMBINED_RECOVERY_ALERT").length) {
    const FR = { HRV_SUPPRESSED: "HRV basse", RHR_ELEVATED: "FC repos haute", SLEEP_DEGRADED: "sommeil court",
      TSB_VERY_LOW: "TSB très bas", ACWR_HIGH: "ACWR élevé", MONOTONY_HIGH: "monotonie" };
    const codes = flag("COMBINED_RECOVERY_ALERT")[0].detail.replace("concurrent signals: ", "").split(", ");
    add(3, "Alerte combinée", codes.map(c => FR[c] || c).join(" + "),
      "Plusieurs signaux de surcharge en même temps : on récupère, on ne charge pas.");
  }
  if (sev("ACWR_HIGH") === "alert") add(3, "ACWR", fr(acwr, 2), "Charge des 7 derniers jours > 1,5 × ta charge habituelle : zone de risque.");

  // ── Règle 1 : récupération / fatigue profonde ──
  if (tsb != null && tsb < -25) add(2, "Fraîcheur (TSB)", signed(tsb), "Fatigue accumulée élevée.");
  const rec = m.recovery;
  const recLabel = {
    hrv: ["HRV 7 j", r => `${fr(r.avg_7d, 0)} ms vs ${fr(r.baseline_28d, 0)} ms (28 j)`],
    rhr: ["FC repos 7 j", r => `${fr(r.avg_7d, 0)} vs ${fr(r.baseline_28d, 0)} bpm (28 j) · ${signed(r.avg_7d - r.baseline_28d)}`],
    sleep: ["Sommeil 7 j", r => `${hm(r.avg_7d_sec)} vs ${hm(r.baseline_28d_sec)} (28 j)`],
  };
  for (const k of ["hrv", "rhr", "sleep"]) {
    const r = rec[k];
    if (r.status === "alert") add(2, recLabel[k][0], recLabel[k][1](r), "Récupération dégradée sur la semaine.");
    else if (r.status === "watch") add(1, recLabel[k][0], recLabel[k][1](r), "Récupération à surveiller : on enlève l'intensité.");
  }
  if (sev("RAMP_HIGH") === "alert") add(2, "Progression CTL", `${signed(m.ramp.ctl_ramp_per_week)} / sem.`, "Montée de charge trop rapide (> 10 / semaine).");

  // ── Signaux de charge → alléger ──
  if (sev("ACWR_HIGH") === "warn") add(1, "ACWR", fr(acwr, 2), "Charge récente au-dessus de la zone 0,8–1,3.");
  if (flag("MONOTONY_HIGH").length) add(1, "Monotonie", flag("MONOTONY_HIGH")[0].detail.match(/monotony ([\d.]+)/)?.[1]?.replace(".", ",") ?? "> 2",
    "Semaine trop uniforme : les jours faciles ne sont pas assez faciles.");
  if (sev("RAMP_HIGH") === "warn") add(1, "Progression CTL", `${signed(m.ramp.ctl_ramp_per_week)} / sem.`, "Montée de charge rapide (> 8 / semaine).");

  // ── Règle 3 : 80/20 — ne pas ajouter d'intensité si déjà trop ──
  const low = m.intensity.low_pct;
  if (isQuality && low != null && low < 75) {
    add(1, "Répartition 80/20", `${fr(low, 0)} % du temps en basse intensité`, "Trop de temps en intensité modérée/haute : la qualité passe en Z2.");
  }

  // ── Garde-fous de l'app ──
  if (ctx.feel === "fatigue") add(1, "Ressenti", "fatigue déclarée", "Ton ressenti passe avant les chiffres.");
  if (ctx.suivi === "rouge") add(2, "Verdict Suivi data", "feu rouge", "Le verdict du matin est au rouge : il s'impose à la séance.");
  else if (ctx.suivi === "orange") add(1, "Verdict Suivi data", "feu orange", "Le verdict du matin demande d'alléger.");
  if (ctx.capIntensite && isQuality) add(1, "Clairance cardiaque", "> 12 mois", "Intensité plafonnée tant qu'un contrôle n'a pas revalidé les blocs durs.");

  // ── Informations (ne changent pas la décision) ──
  const notes = [];
  const lastBy = lastSessionBySport(m);
  for (const [k, lbl] of [["swim", "natation"], ["bike", "vélo"], ["run", "course"]]) {
    const d = lastBy[k];
    if (d == null) notes.push(`Aucune séance de ${lbl} sur la fenêtre analysée.`);
    else if (d >= 14) notes.push(`Pas de ${lbl} depuis ${d} jours : à réintégrer en douceur.`);
  }
  if (sev("ACWR_LOW") !== "none") notes.push(`ACWR ${fr(acwr, 2)} < 0,8 : charge récente sous ton habitude (désentraînement possible).`);
  if (tsb != null && tsb > 15 && stage === 0) notes.push(`TSB ${signed(tsb)} : très frais, la séance prévue est absorbable.`);

  if (stage === 0) {
    reasons.push({ stage: 0, level: "vert", signal: "Synthèse", mesure: summaryLine(m), lecture: "Aucun signal ne demande d'ajustement." });
  }

  return {
    decision: STAGES[stage],
    level: LEVEL_OF_STAGE[stage],
    session: sessionFor(stage, planned, ctx),
    reasons: reasons.sort((a, b) => b.stage - a.stage),
    notes,
  };
}

function summaryLine(m) {
  const p = m.pmc.length ? m.pmc[m.pmc.length - 1] : null;
  const parts = [];
  if (p) parts.push(`TSB ${signed(p.tsb)}`);
  if (m.acwr.ewma.ratio != null) parts.push(`ACWR ${fr(m.acwr.ewma.ratio, 2)}`);
  if (m.intensity.low_pct != null) parts.push(`${fr(m.intensity.low_pct, 0)} % en basse intensité`);
  return parts.join(" · ") || "données limitées";
}

function lastSessionBySport(m) {
  const today = m.meta.today ? Date.parse(m.meta.today + "T00:00:00Z") : null;
  const out = { swim: null, bike: null, run: null };
  if (today == null) return out;
  for (const a of m.per_activity) {
    if (!a.date || !(a.sport in out)) continue;
    const d = Math.round((today - Date.parse(a.date + "T00:00:00Z")) / 864e5);
    if (d >= 0 && (out[a.sport] == null || d < out[a.sport])) out[a.sport] = d;
  }
  return out;
}

// Construit la séance recommandée à partir de la séance prévue
function sessionFor(stage, p, ctx) {
  const sport = p.sport;
  const base = { sport, sportLabel: SPORT_LABEL[sport] || sport, plannedName: p.name, plannedMinutes: p.minutes };
  const isQuality = p.type === "quality" || ["z3", "z4", "z5"].includes(p.zone);

  if (stage === 0) {
    return { ...base, name: p.name, minutes: p.minutes, zone: p.zone, type: p.type, change: "Séance prévue, sans modification." };
  }
  if (stage === 1) {
    const minutes = round5(p.minutes * 0.85);
    if (sport === "ppg") return { ...base, name: "Gainage + mobilité, volume réduit", minutes, zone: null, type: "mobility", change: "Volume −15 %, garde les arrêts sur douleur." };
    if (sport === "natation") {
      return { ...base, name: isQuality || /seuil|lactate/i.test(p.name) ? "Endurance souple — sans séries au seuil" : p.name, minutes, zone: "z2", type: "endurance",
        change: isQuality ? "Séries intenses retirées, volume −15 %." : "Volume −15 %, allure confortable." };
    }
    const lbl = sport === "cap" ? `${minutes}' Z2 continu` : "Sortie Z2 souple";
    return { ...base, name: isQuality ? lbl : p.name, minutes, zone: p.zone === "z1" ? "z1" : "z2", type: "endurance",
      change: isQuality ? "Qualité transformée en endurance Z2, volume −15 %." : "Volume −15 %, reste en Z2." };
  }
  if (stage === 2) {
    const minutes = Math.min(40, Math.max(20, round5(p.minutes * 0.5)));
    if (sport === "velo") return { ...base, name: "Vélo souple Z1", minutes: Math.min(45, Math.max(30, minutes)), zone: "z1", type: "endurance", change: "Remplacée par du pédalage de récupération." };
    if (sport === "ppg") return { ...base, name: "Mobilité douce", minutes: 15, zone: null, type: "mobility", change: "Gainage retiré, mobilité indolore seulement." };
    // Course ou natation → natation technique (le moins traumatisant), vélo Z1 en alternative
    return { ...base, sport: "natation", sportLabel: "Natation", name: "Natation technique (éducatifs, sans chrono)", minutes, zone: "z1", type: "technique",
      change: sport === "cap" ? "Course remplacée : pas d'impact aujourd'hui." : "Séance remplacée par de la technique.",
      alternative: "ou 30–45 min de vélo souple en Z1" };
  }
  // stage 3 : repos
  return { ...base, sport: null, sportLabel: "Repos", name: ctx.symptom ? "Mobilité indolore 15 min au plus" : "Ou Z1 très souple ≤ 30 min, sans course à pied",
    minutes: 0, zone: null, type: "rest", change: "Séance prévue reportée. Ne la rattrape pas." };
}

// Traduit les lacunes de données en phrases courtes (section « Données »)
export function gapsFr(m, ctx = {}) {
  const g = m.meta.data_gaps.join(" | ");
  const out = [];
  if (m.recovery.hrv.status === "no_data") out.push("HRV non disponible (Fenix 5) : récupération lue sur FC repos + sommeil.");
  if (/lthr_bpm missing|lthr_source=estimated/.test(g)) out.push("FC seuil estimée à 90 % de la FC max.");
  if (ctx.noFcMax) out.push("FC max non renseignée dans Réglages : classification d'intensité limitée.");
  if (!ctx.css) out.push("CSS natation inconnue : intensité natation non classée.");
  if (m.flags.some(f => f.code === "CTL_UNRELIABLE")) out.push(`Historique ${m.meta.window_days} j < 42 j : forme (CTL) pas encore fiable.`);
  if (m.flags.some(f => f.code === "DATA_SPARSE")) out.push("Peu de données sur la fenêtre : décision à prendre avec prudence.");
  if (m.recovery.sleep.status === "no_data") out.push("Sommeil : moins de 14 nuits sur 28 j, statut non évalué.");
  if (m.recovery.rhr.status === "no_data") out.push("FC repos : moins de 14 jours sur 28 j, statut non évalué.");
  if (m.intensity.basis === "session_avg") out.push("Intensité classée sur la moyenne de séance : sous-estime la part intense des fractionnés.");
  return out;
}
