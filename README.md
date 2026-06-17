# tri-health-backend

Backend santé pour `tri-coach-fab` : reçoit les données de Health Auto Export,
garde 60 jours glissants dans Netlify Blobs, et les expose au Briefing du jour.

## Contenu

```
netlify.toml                          routage /api/* + dossier des fonctions
package.json                          dépendance @netlify/blobs (type: module)
netlify/functions/health-ingest.mjs   POST /api/health/ingest  (reçoit Health Auto Export)
netlify/functions/health-latest.mjs   GET  /api/health/latest  (lu par le briefing)
netlify/functions/lib/normalize.mjs   parsing + agrégation + baselines (module pur)
public/health-sync.js                 glue front : pré-remplit le briefing
test/run.mjs                          test du parseur (node test/run.mjs)
```

## Déploiement

Tout se fait depuis le navigateur, via GitHub → Netlify (zéro Node.js, zéro Terminal).
Suis **`guide-github-zero-terminal.md`**.

En bref :
1. Réunis ces fichiers **avec** ton site existant (`index.html`, etc.) dans un seul dossier,
   en respectant l'arborescence ci-dessus.
2. Pousse le tout sur un dépôt GitHub (interface web).
3. Relie ce dépôt à ton site Netlify (Build & deploy → Link repository).
4. Pose `INGEST_TOKEN` et `READ_TOKEN` dans les variables Netlify, puis redéploie.
5. Mets ton `READ_TOKEN` dans `public/health-sync.js` (constante en haut du fichier).

## Endpoints

- `POST /api/health/ingest` — header `Authorization: Bearer <INGEST_TOKEN>`
- `GET  /api/health/latest` — header `Authorization: Bearer <READ_TOKEN>` **ou** `?token=<READ_TOKEN>`
  Renvoie : `date, sleep_h, resting_hr, hrv_ms, steps, resting_hr_baseline_7d, hrv_baseline_30d, days_in_history`.

## Note

Garmin remonte rarement la VFC (HRV) dans Apple Santé : `hrv_ms` sera souvent `null`.
C'est géré proprement — le briefing s'appuie alors sur le sommeil et la FC repos.
