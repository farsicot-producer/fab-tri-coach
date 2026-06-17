// health-sync.js — glue front : lit /api/health/latest et pré-remplit le Briefing du jour.
//
// ⚠️ Le READ_TOKEN est ici visible dans le code du navigateur (cf. note sécurité du guide).
//    Ce sont tes données de bien-être, pas des données critiques — mais sois-en conscient.
//    Remplace la valeur ci-dessous par ton vrai READ_TOKEN (le même que dans Netlify).
(function () {
  "use strict";

  var READ_TOKEN = "REMPLACE_PAR_TON_READ_TOKEN";
  var ENDPOINT = "/api/health/latest";

  // Champ du backend  ->  id de l'input dans le briefing
  var MAP = {
    sleep_h: "sleep",
    resting_hr: "rhr",
    resting_hr_baseline_7d: "rhrBase",
    hrv_ms: "hrv",
    hrv_baseline_30d: "hrvBase",
  };

  function setIfPresent(id, value) {
    var el = document.getElementById(id);
    if (el && value != null && value !== "") el.value = value;
  }

  function fill(data) {
    Object.keys(MAP).forEach(function (field) {
      setIfPresent(MAP[field], data[field]);
    });
    // si une fonction run() existe dans le briefing, on relance le calcul
    if (typeof window.run === "function") {
      try { window.run(); } catch (e) { /* silencieux */ }
    }
  }

  function load() {
    if (READ_TOKEN === "REMPLACE_PAR_TON_READ_TOKEN") {
      console.warn("[health-sync] READ_TOKEN non configuré — pré-remplissage ignoré.");
      return;
    }
    fetch(ENDPOINT + "?token=" + encodeURIComponent(READ_TOKEN), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(fill)
      .catch(function (e) {
        console.warn("[health-sync] lecture impossible :", e.message);
      });
  }

  // expose un rappel manuel + auto-chargement
  window.healthSync = load;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
})();
