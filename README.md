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
4. Pose `INGEST_TOKEN` et `ACCESS_CODE` dans les variables Netlify, puis redéploie.
5. Saisis le code d'accès une fois sur chaque appareil, à l'ouverture de l'app. Il ne doit jamais être écrit dans le code.

## Endpoints

- `POST /api/health/ingest` — header `Authorization: Bearer <INGEST_TOKEN>`
- `GET  /api/health/latest` — header `Authorization: Bearer <ACCESS_CODE>`
  Renvoie : `date, sleep_h, resting_hr, hrv_ms, steps, resting_hr_baseline_7d, hrv_baseline_30d, days_in_history`.

## Note

Garmin remonte rarement la VFC (HRV) dans Apple Santé : `hrv_ms` sera souvent `null`.
C'est géré proprement — le briefing s'appuie alors sur le sommeil et la FC repos.

## Trajets du quotidien (Move IQ)

Les trajets à vélo ou à pied que la montre détecte toute seule (Move IQ) ne passent pas
par intervals.icu. Une GitHub Action les récupère sur Garmin Connect et les affiche dans
le Bilan (carte « Trajets du quotidien »). Ils ne comptent **ni** dans l'objectif de la
semaine **ni** dans la condition physique.

```
.github/workflows/garmin-moveiq.yml   lancement 2 fois par jour (+ bouton manuel)
scripts/garmin_moveiq.py              lecture Garmin Connect (API non officielle) → POST
netlify/functions/moveiq-ingest.mjs   POST /api/moveiq/ingest  (Bearer INGEST_TOKEN)
netlify/functions/moveiq.mjs          GET  /api/moveiq?from=&to=  (code d'accès)
netlify/functions/lib/moveiq.mjs      fusion 60 j + cumul (module pur)
```

Mise en route : GitHub › Settings › Secrets and variables › Actions, créer
`GARMIN_EMAIL`, `GARMIN_PASSWORD` et `INGEST_TOKEN` (même valeur que dans Netlify),
puis Actions › « Trajets Move IQ » › Run workflow.

Limite : l'API Garmin Connect utilisée n'est pas officielle. Elle peut être bloquée ou
changer sans préavis ; la carte affiche alors « Données indisponibles ».
