#!/usr/bin/env python3
"""
garmin_moveiq.py — récupère les trajets Move IQ (vélo, marche…) détectés
automatiquement par la montre, et les envoie à l'app (/api/moveiq/ingest).

Lancé par la GitHub Action .github/workflows/garmin-moveiq.yml (aucune commande
à taper). Passe par l'API NON OFFICIELLE de Garmin Connect (bibliothèque
python-garminconnect) : peut cesser de fonctionner sans préavis.

Variables d'environnement :
  GARMIN_EMAIL, GARMIN_PASSWORD   identifiants Garmin Connect
  GARMINTOKENS                    dossier où garder la session (évite de se reconnecter à chaque fois)
  INGEST_URL                      ex. https://tri-coach-fab.netlify.app/api/moveiq/ingest
  INGEST_TOKEN                    même valeur que la variable Netlify INGEST_TOKEN
  DAYS                            nombre de jours relus (défaut 9 : couvre toute la semaine en cours)
  DEBUG_SAMPLE=1                  affiche les noms de champs bruts renvoyés par Garmin (jamais les valeurs)
"""
import json
import os
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Paris")

# Types Garmin → catégories affichées dans l'app
TYPE_MAP = {
    "cycling": "velo", "biking": "velo", "bike": "velo", "road_biking": "velo",
    "walking": "marche", "walk": "marche", "hiking": "marche",
    "running": "course", "run": "course",
    "swimming": "natation", "elliptical": "autre",
}


def norm_type(raw):
    s = str(raw or "").strip().lower().replace(" ", "_")
    if s in TYPE_MAP:
        return TYPE_MAP[s]
    for k, v in TYPE_MAP.items():
        if k in s:
            return v
    return "autre"


def first(d, *keys):
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return v
    return None


def parse_ts(v, assume_local):
    """Renvoie un datetime UTC à partir d'un epoch (s ou ms) ou d'une chaîne ISO Garmin."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        sec = v / 1000 if v > 10**11 else v
        return datetime.fromtimestamp(sec, tz=timezone.utc)
    s = str(v).replace("Z", "").split(".")[0]
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ if assume_local else timezone.utc)
    return dt.astimezone(timezone.utc)


def duration_sec(ev, start, end):
    if "durationInMilliseconds" in ev and ev["durationInMilliseconds"]:
        return float(ev["durationInMilliseconds"]) / 1000
    v = first(ev, "durationInSeconds", "duration", "elapsedDuration")
    if v is not None:
        v = float(v)
        # Garmin renvoie parfois des millisecondes dans « duration » :
        # au-delà de 20 000, on suppose des ms (20 000 s ≈ 5,5 h, improbable pour un trajet).
        return v / 1000 if v > 20000 else v
    if start and end:
        return (end - start).total_seconds()
    return None


def extract_events(payload):
    """La réponse peut être une liste, ou un objet contenant la liste."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k in ("events", "dailyEvents", "moveIQEvents", "autoActivities", "items"):
            if isinstance(payload.get(k), list):
                return payload[k]
    return []


def is_auto_detected(ev):
    """Garde les détections automatiques ; écarte ce qui est explicitement une activité enregistrée."""
    flag = str(first(ev, "eventType", "type", "source", "category") or "").upper()
    if not flag:
        return True
    if "MOVE" in flag or "AUTO" in flag or "DETECT" in flag:
        return True
    if "ACTIVITY" in flag or "MANUAL" in flag or "RECORDED" in flag:
        return False
    return True


def overlap(a0, a1, b0, b1):
    return max(0.0, (min(a1, b1) - max(a0, b0)).total_seconds())


def hr_avg(hr_payload, start, end):
    vals = (hr_payload or {}).get("heartRateValues") or []
    t0, t1 = start.timestamp() * 1000, end.timestamp() * 1000
    pts = [v[1] for v in vals if isinstance(v, (list, tuple)) and len(v) >= 2
           and v[1] and t0 <= v[0] <= t1]
    if not pts:
        return None, 0
    return round(sum(pts) / len(pts)), len(pts)


def main():
    from garminconnect import Garmin

    days = int(os.getenv("DAYS", "9"))
    debug = os.getenv("DEBUG_SAMPLE") == "1"
    tokens = os.path.expanduser(os.getenv("GARMINTOKENS") or "~/.garminconnect")

    g = Garmin(os.getenv("GARMIN_EMAIL"), os.getenv("GARMIN_PASSWORD"))
    g.login(tokens)
    try:
        g.client.dump(tokens)  # garde la session pour la prochaine exécution
    except Exception:
        pass

    today = datetime.now(TZ).date()
    dates = [today - timedelta(days=i) for i in range(days)]

    # Activités enregistrées sur la montre : pour ne pas compter deux fois un trajet chronométré.
    recorded = []
    try:
        for a in g.get_activities_by_date(dates[-1].isoformat(), today.isoformat()) or []:
            s = parse_ts(first(a, "startTimeGMT"), assume_local=False) or \
                parse_ts(first(a, "startTimeLocal"), assume_local=True)
            d = first(a, "duration", "elapsedDuration")
            if s and d:
                recorded.append((s, s + timedelta(seconds=float(d))))
    except Exception as e:
        print(f"[avertissement] activités enregistrées non lues : {e}", file=sys.stderr)

    out, fetched, seen_keys = [], [], set()
    for d in dates:
        ds = d.isoformat()
        try:
            raw = g.get_all_day_events(ds)
        except Exception as e:
            print(f"[avertissement] {ds} : événements non lus ({e})", file=sys.stderr)
            continue
        fetched.append(ds)
        evs = extract_events(raw)
        if debug:
            for ev in evs:
                if isinstance(ev, dict):
                    seen_keys.update(ev.keys())
        if not evs:
            continue
        try:
            hr = g.get_heart_rates(ds)
        except Exception:
            hr = None
        for ev in evs:
            if not isinstance(ev, dict) or not is_auto_detected(ev):
                continue
            start = parse_ts(first(ev, "startTimestampGMT", "startTimeGMT", "startTimeInSeconds"), False) \
                or parse_ts(first(ev, "startTimestampLocal", "startTimeLocal", "startTime"), True)
            end = parse_ts(first(ev, "endTimestampGMT", "endTimeGMT"), False) \
                or parse_ts(first(ev, "endTimestampLocal", "endTimeLocal", "endTime"), True)
            sec = duration_sec(ev, start, end)
            if not start or not sec or sec < 60:
                continue
            end = start + timedelta(seconds=sec)
            if any(overlap(start, end, r0, r1) > 0.5 * sec for r0, r1 in recorded):
                continue  # déjà une activité enregistrée
            avg, n = hr_avg(hr, start, end)
            out.append({
                "date": start.astimezone(TZ).date().isoformat(),
                "start": start.astimezone(TZ).strftime("%Y-%m-%dT%H:%M"),
                "type": norm_type(first(ev, "activityType", "activityTypeKey", "activityName", "subType")),
                "raw_type": str(first(ev, "activityType", "activityTypeKey", "activityName", "subType") or ""),
                "minutes": round(sec / 60),
                "hr_avg": avg,
                "hr_points": n,
            })

    if debug:
        print("Champs vus dans dailyEvents :", sorted(seen_keys))

    body = {"fetched_dates": fetched, "events": out,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    print(f"{len(out)} trajet(s) sur {len(fetched)} jour(s) relu(s).")

    url, tok = os.getenv("INGEST_URL"), os.getenv("INGEST_TOKEN")
    if not url or not tok:
        print(json.dumps(body, ensure_ascii=False, indent=2))
        print("INGEST_URL / INGEST_TOKEN absents : rien envoyé.", file=sys.stderr)
        return
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json",
                                          "authorization": f"Bearer {tok}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        print("Envoi :", r.status, r.read().decode()[:300])


if __name__ == "__main__":
    main()
