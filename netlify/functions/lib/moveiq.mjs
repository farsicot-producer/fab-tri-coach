// netlify/functions/lib/moveiq.mjs — module pur (testable sans Netlify)
// Fusion de l'historique des trajets Move IQ et cumul sur une période.

export const TYPES = ["velo", "marche", "course", "natation", "autre"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Remplace les jours relus par le script, garde les autres, coupe à `keepDays`.
export function mergeMoveIQ(existing, incoming, keepDays = 60, today = new Date()) {
  const fetched = new Set((incoming.fetched_dates || []).filter(d => ISO.test(d)));
  const kept = (existing.events || []).filter(e => !fetched.has(e.date));
  const fresh = (incoming.events || []).filter(e => e && ISO.test(e.date) && Number(e.minutes) > 0)
    .map(e => ({
      date: e.date,
      start: String(e.start || ""),
      type: TYPES.includes(e.type) ? e.type : "autre",
      raw_type: String(e.raw_type || "").slice(0, 40),
      minutes: Math.round(Number(e.minutes)),
      hr_avg: Number.isFinite(e.hr_avg) ? Math.round(e.hr_avg) : null,
      hr_points: Number.isFinite(e.hr_points) ? e.hr_points : 0,
    }));
  const cutoff = new Date(today.getTime() - keepDays * 864e5).toISOString().slice(0, 10);
  const events = [...kept, ...fresh].filter(e => e.date >= cutoff)
    .sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date));
  const days = new Set([...(existing.fetched_dates || []), ...fetched]);
  return {
    events,
    fetched_dates: [...days].filter(d => d >= cutoff).sort(),
    updated_at: incoming.generated_at || new Date().toISOString(),
  };
}

// Cumul entre deux dates incluses (YYYY-MM-DD).
export function summarize(hist, from, to) {
  const evs = (hist.events || []).filter(e => e.date >= from && e.date <= to);
  const byType = {};
  for (const e of evs) {
    const t = byType[e.type] || (byType[e.type] = { count: 0, minutes: 0 });
    t.count++; t.minutes += e.minutes;
  }
  // FC moyenne pondérée par la durée, seulement sur les trajets qui ont des points FC.
  const withHr = evs.filter(e => e.hr_avg != null && e.hr_points >= 2);
  const hrMin = withHr.reduce((a, e) => a + e.minutes, 0);
  const hr_avg = hrMin ? Math.round(withHr.reduce((a, e) => a + e.hr_avg * e.minutes, 0) / hrMin) : null;
  const covered = (hist.fetched_dates || []).filter(d => d >= from && d <= to).length;
  return {
    from, to,
    count: evs.length,
    minutes: evs.reduce((a, e) => a + e.minutes, 0),
    by_type: byType,
    hr_avg, hr_coverage_minutes: hrMin,
    days_covered: covered,
    updated_at: hist.updated_at || null,
    events: evs,
  };
}
