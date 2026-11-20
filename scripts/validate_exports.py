"""
Validate the exported catalog (data/processed/exports) before it ships.

Run automatically at the end of run_etl.py, or on its own:
    python scripts/validate_exports.py

Hard checks (exit code 1 on failure):
  - wars.json is a list with unique war_id and start_year <= end_year
  - every battle/event points at a war that exists
  - wars.battle_count equals the number of shipped events per war
  - coordinates are in range (theater rings may run to ±360 when they cross
    the antimeridian — that is intentional)
  - the share of events dated outside their war's span stays under a threshold

Report-only checks are written to data/processed/qa/validation_report.json.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# Windows consoles default to a legacy code page; never crash on "≥", "–", etc.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")
from common import EXPORTS, QA, REVIEW  # noqa: E402

# Events more than this many years outside their war's span count as misdated/misrouted.
SPAN_PAD_YEARS = 5
# Fail the run if more than this share of events falls outside its war span.
# (Before the HCED cluster-routing fix this was ~2.5%, i.e. 1,085 events.)
MAX_OUT_OF_SPAN_SHARE = 0.005

REQUIRED_WAR_FIELDS = (
    "war_id",
    "title",
    "start_year",
    "end_year",
    "definition_tier",
    "sources",
    "battle_count",
)


def _reviewed_set(section: str, key: str) -> set[str]:
    path = REVIEW / "source_corrections.json"
    if not path.exists():
        return set()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    return set((raw.get(section) or {}).get(key) or [])


def _reviewed_no_change() -> set[str]:
    """Year-split war ids a human has checked and confirmed as genuine."""
    path = REVIEW / "source_corrections.json"
    if not path.exists():
        return set()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    return set((raw.get("reviewed_no_change") or {}).get("war_ids") or [])


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    import math

    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(min(1.0, math.sqrt(a)))


# A war counts as "compact" when this share of its points lies within COMPACT_KM
# of its centre; a point beyond OUTLIER_KM from that centre is then suspicious.
COMPACT_SHARE, COMPACT_KM, OUTLIER_KM = 0.8, 1500.0, 4000.0


def _location_outliers(battles: list[dict]) -> list[dict]:
    """Events far from an otherwise compact war — typical of sign flips or bad geocodes."""
    from statistics import median

    from common import circular_mean_lng

    by_war: dict[str, list[tuple[float, float, dict]]] = {}
    for f in battles:
        p = f.get("properties") or {}
        if p.get("source") == "ucdp":  # UCDP events are precisely georeferenced
            continue
        lng, lat = f["geometry"]["coordinates"]
        by_war.setdefault(p.get("war_id"), []).append((lat, lng, p))
    out = []
    for wid, pts in by_war.items():
        if len(pts) < 2:
            continue
        clat = median(lat for lat, _, _ in pts)
        clng = circular_mean_lng([lng for _, lng, _ in pts])
        dists = [(_haversine_km(lat, lng, clat, clng), lat, lng, p) for lat, lng, p in pts]
        near = sum(1 for d, *_ in dists if d <= COMPACT_KM)
        if near / len(dists) < COMPACT_SHARE:
            continue  # genuinely spread-out war (e.g. world wars) — not judged here
        for d, lat, lng, p in dists:
            if d > OUTLIER_KM:
                out.append(
                    {
                        "war_id": wid,
                        "event_id": p.get("event_id"),
                        "name": p.get("name"),
                        "lat": lat,
                        "lng": lng,
                        "km_from_war_centre": round(d),
                    }
                )
    return out


def _load(name: str, exports: Path):
    return json.loads((exports / name).read_text(encoding="utf-8"))


def validate(exports: Path = EXPORTS) -> dict:
    errors: list[str] = []
    warnings: list[str] = []

    wars = _load("wars.json", exports)
    battles = _load("battles.geojson", exports)["features"]
    theaters = _load("theaters.geojson", exports)["features"]

    if not isinstance(wars, list) or not wars:
        errors.append("wars.json is empty or not a list")
        return {"errors": errors, "warnings": warnings}

    # --- events: one id per event (views count and de-duplicate by id) -------
    eids = [f.get("properties", {}).get("event_id") for f in battles]
    dup_e = [k for k, n in Counter(eids).items() if n > 1]
    if dup_e:
        errors.append(f"duplicate event_id in battles.geojson: {dup_e[:10]}")

    # --- wars -----------------------------------------------------------------
    ids = [w.get("war_id") for w in wars]
    dup = [k for k, n in Counter(ids).items() if n > 1]
    if dup:
        errors.append(f"duplicate war_id: {dup[:10]}")
    for w in wars:
        missing = [f for f in REQUIRED_WAR_FIELDS if f not in w]
        if missing:
            errors.append(f"{w.get('war_id')}: missing fields {missing}")
        s, e = w.get("start_year"), w.get("end_year")
        if s is not None and e is not None and s > e:
            errors.append(f"{w['war_id']}: start_year {s} > end_year {e}")
    by_id = {w["war_id"]: w for w in wars}

    # --- battles / events ----------------------------------------------------------
    per_war = Counter()
    out_of_span: list[dict] = []
    bad_coords = 0
    orphans = 0
    for f in battles:
        p = f.get("properties") or {}
        wid = p.get("war_id")
        war = by_id.get(wid)
        if war is None:
            orphans += 1
            continue
        per_war[wid] += 1
        lng, lat = (f.get("geometry") or {}).get("coordinates", [None, None])
        if lat is None or lng is None or not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
            bad_coords += 1
        y, s = p.get("year"), war.get("start_year")
        e = war.get("end_year") if war.get("end_year") is not None else s
        if y is not None and s is not None and not (s - SPAN_PAD_YEARS <= y <= e + SPAN_PAD_YEARS):
            out_of_span.append(
                {"event_id": p.get("event_id"), "year": y, "war_id": wid, "war_span": [s, e]}
            )
    if orphans:
        errors.append(f"{orphans} events reference a war_id that does not exist")
    if bad_coords:
        errors.append(f"{bad_coords} events have out-of-range coordinates")

    mismatched = [
        w["war_id"] for w in wars if int(w.get("battle_count") or 0) != per_war.get(w["war_id"], 0)
    ]
    if mismatched:
        errors.append(f"battle_count disagrees with shipped events for {len(mismatched)} wars, e.g. {mismatched[:5]}")

    share = len(out_of_span) / max(1, len(battles))
    if share > MAX_OUT_OF_SPAN_SHARE:
        errors.append(
            f"{len(out_of_span)} events ({share:.2%}) fall >{SPAN_PAD_YEARS}y outside their war's span "
            f"(limit {MAX_OUT_OF_SPAN_SHARE:.1%}) — likely a routing or source-year problem"
        )
    elif out_of_span:
        warnings.append(
            f"{len(out_of_span)} events ({share:.2%}) fall >{SPAN_PAD_YEARS}y outside their war's span (see report)"
        )

    # --- crosswalk decisions must still point at records the ETL produces ----------
    # Source corrections can rename HCED year-split ids; a reviewed merge keyed on
    # the old id then silently stops applying and the war is duplicated.
    links_path = REVIEW / "crosswalk_links.csv"
    dec_path = REVIEW / "crosswalk_decisions.json"
    if links_path.exists() and dec_path.exists():
        import csv

        with links_path.open(encoding="utf-8") as fh:
            seen = {row["left_id"] for row in csv.DictReader(fh)}
        decisions = json.loads(dec_path.read_text(encoding="utf-8")).get("decisions", [])
        for d in decisions:
            if d.get("left_id") in seen:
                continue
            msg = f"stale crosswalk decision ({d.get('status')}): {d.get('left_id')} → {d.get('right_id')} no longer matches any record"
            if d.get("status") == "accepted":
                errors.append(msg + " — the merge no longer applies (war duplicated?)")
            else:
                warnings.append(msg)

    # --- build provenance: committed inputs must match the recorded checksums ----
    prov = (_load("catalog_meta.json", exports).get("build_provenance") or {}).get("inputs") or []
    if not prov:
        errors.append("catalog_meta.json has no build_provenance record")
    from common import ROOT, sha256_file

    for rec in prov:
        path = ROOT / rec["path"]
        if rec.get("missing") or not path.exists():
            continue  # e.g. the 260 MB UCDP CSV is not in git — cannot re-check in CI
        if sha256_file(path) != rec.get("sha256"):
            errors.append(f"input changed since the catalog was built: {rec['path']} (re-run run_etl.py)")

    # --- theaters ----------------------------------------------------------------
    bad_rings = 0
    for f in theaters:
        ring = (f.get("geometry") or {}).get("coordinates", [[]])[0]
        if len(ring) < 4:
            bad_rings += 1
            continue
        if any(not (-90 <= y <= 90) or not (-360 <= x <= 360) for x, y in ring):
            bad_rings += 1
        if f["properties"].get("war_id") not in by_id:
            bad_rings += 1
    if bad_rings:
        errors.append(f"{bad_rings} theater polygons are invalid or orphaned")

    # --- review queue: tiny HCED year-split records ---------------------------------
    # A "War X (y0–y1)" record with 1–2 events, where another record with the same
    # base name has ≥10× more, is usually a source dating/labelling error.
    base_counts: dict[str, list[tuple[str, int]]] = {}
    for w in wars:
        if w["war_id"].startswith("hced:") and w["war_id"].count(":") == 2:
            base = w["war_id"].split(":")[1]
            base_counts.setdefault(base, []).append((w["war_id"], int(w.get("battle_count") or 0)))
    reviewed_ok = _reviewed_no_change()
    suspects = []
    for base, rows in base_counts.items():
        top = max(n for _, n in rows)
        for wid, n in rows:
            if wid in reviewed_ok:
                continue
            if 0 < n <= 2 and top >= 10 * n and top >= 10:
                suspects.append({"war_id": wid, "battles": n, "largest_sibling_battles": top})

    # --- review queue: location outliers (sign flips, wrong-continent geocodes) -------
    reviewed_loc = _reviewed_set("reviewed_location_ok", "event_ids")
    location_outliers = [o for o in _location_outliers(battles) if o["event_id"] not in reviewed_loc]
    if location_outliers:
        warnings.append(
            f"{len(location_outliers)} events sit far from an otherwise compact war (possible geocoding errors; see report)"
        )

    return {
        "errors": errors,
        "warnings": warnings,
        "location_outliers": location_outliers,
        "counts": {
            "wars": len(wars),
            "events": len(battles),
            "theaters": len(theaters),
            "events_out_of_span": len(out_of_span),
        },
        "events_out_of_span_by_war": Counter(r["war_id"] for r in out_of_span).most_common(25),
        "events_out_of_span_sample": out_of_span[:100],
        "hced_split_review_queue": suspects,
    }


def main() -> int:
    report = validate()
    QA.mkdir(parents=True, exist_ok=True)
    (QA / "validation_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    for w in report["warnings"]:
        print(f"  WARN  {w}")
    for e in report["errors"]:
        print(f"  ERROR {e}")
    if report.get("hced_split_review_queue"):
        print(f"  Review queue (tiny HCED year-splits): {len(report['hced_split_review_queue'])} — see qa/validation_report.json")
    if report["errors"]:
        print("  Validation FAILED")
        return 1
    print(f"  Validation passed: {report['counts']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
