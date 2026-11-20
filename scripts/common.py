"""Shared paths and helpers for WarsInAllWorld ETL."""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"
EXPORTS = PROCESSED / "exports"
QA = PROCESSED / "qa"
REVIEW = PROCESSED / "review"
APP_PUBLIC_DATA = ROOT / "app" / "public" / "data"


def ensure_dirs() -> None:
    for d in (EXPORTS, QA, REVIEW, APP_PUBLIC_DATA):
        d.mkdir(parents=True, exist_ok=True)


def slugify(text: str, max_len: int = 80) -> str:
    text = unicodedata.normalize("NFKD", str(text))
    text = text.encode("ascii", "ignore").decode("ascii")
    text = text.lower().strip()
    text = re.sub(r"[\[\]'\"{}]", "", text)
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    return text[:max_len] or "unknown"


def normalize_war_name(text: str) -> str:
    """Normalize HCED-style war strings and titles for matching."""
    if text is None:
        return ""
    s = str(text).strip()
    # HCED stores Python-list-like strings
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        parts = re.findall(r"['\"]([^'\"]+)['\"]", inner)
        s = parts[0] if parts else inner.strip("'\"")
    s = s.lower()
    s = re.sub(r"^(the|a|an)\s+", "", s)
    s = re.sub(r"[^\w\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def parse_year(value) -> int | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s or s.upper() in {"NA", "NAN", "NONE", "-8", "-9"}:
        return None
    m = re.match(r"^(-?\d+)", s)
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def format_cow_warnum(value) -> int | float | None:
    """Preserve Intra-State decimal WarNums (e.g. 502.1); ints stay ints."""
    if value is None or (isinstance(value, float) and value != value):  # NaN
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    if f == int(f):
        return int(f)
    return f


# COW end-date sentinel: -7 = "war ongoing at the end of the dataset".
# (-8 = not applicable, -9 = unknown.) Reading -7 as a year gives "7 BCE".
COW_ONGOING = -7
# Last year each COW war file covers — used as the censored end year.
COW_DATA_END_V4 = 2007
COW_DATA_END_INTRA_V51 = 2014


def cow_end_year(values, censor_year: int) -> tuple[int | None, bool]:
    """Latest COW end year across a war's rows, resolving the -7 'ongoing' code.

    Returns (end_year, ongoing). When any row is still ongoing (-7) the war's end
    is the dataset's last year and `ongoing` is True — right-censored, not ended.
    """
    years: list[int] = []
    ongoing = False
    if not isinstance(values, (list, tuple)):
        try:
            values = list(values)
        except TypeError:
            values = [values]
    for v in values:
        try:
            n = int(float(v))
        except (TypeError, ValueError):
            continue
        if n == COW_ONGOING:
            ongoing = True
        elif n > 0:
            years.append(n)
    if ongoing:
        return censor_year, True
    return (max(years) if years else None), False


def cow_side_label(value) -> str:
    """Blank COW missing-data sentinels used in SideA/SideB fields."""
    s = str(value or "").strip()
    if not s or s in {"-8", "-9", "nan", "NaN", "None", "NONE"}:
        return ""
    return s


def cow_join_sides(*sides: str) -> str:
    parts = [cow_side_label(s) for s in sides]
    parts = [p for p in parts if p]
    return " vs ".join(parts)


def cow_numeric_deaths(series_or_value):
    """Parse COW death columns; treat -8/-9 as missing. Series in → Series out; scalar → scalar."""
    import pandas as pd

    if isinstance(series_or_value, pd.Series):
        return pd.to_numeric(series_or_value, errors="coerce").replace([-8, -9], pd.NA)
    val = pd.to_numeric(pd.Series([series_or_value]), errors="coerce").replace([-8, -9], pd.NA).iloc[0]
    return None if pd.isna(val) else float(val)


def year_span_label(y0: int, y1: int) -> str:
    """Readable span for titles: '1835', '1939–1945', '1045 BCE', '220–200 BCE', '30 BCE–14'."""

    def fmt(y: int) -> str:
        return f"{abs(y)} BCE" if y < 0 else str(y)

    if y0 == y1:
        return fmt(y0)
    if y0 < 0 and y1 < 0:
        return f"{abs(y0)}–{abs(y1)} BCE"
    return f"{fmt(y0)}–{fmt(y1)}"


def era_bucket(year: int | None) -> str:
    if year is None:
        return "unknown"
    if year < 0:
        return "bce"
    if year < 500:
        return "0000_0499"
    if year < 1000:
        return "0500_0999"
    if year < 1500:
        return "1000_1499"
    if year < 1800:
        return "1500_1799"
    if year < 1900:
        return "1800_1899"
    if year < 2000:
        return "1900_1999"
    return "2000_present"


def sanitize_display_text(text) -> str:
    """Replace banned place-name wording in any user-facing string."""
    if text is None:
        return ""
    s = str(text)
    # Never display "Kurdistan" — use "Kurdish Groups" instead (any casing).
    s = re.sub(r"Kurdistan", "Kurdish Groups", s, flags=re.IGNORECASE)
    return s


def _sanitize_obj(obj):
    if isinstance(obj, str):
        return sanitize_display_text(obj)
    if isinstance(obj, list):
        return [_sanitize_obj(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _sanitize_obj(v) for k, v in obj.items()}
    return obj


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(_sanitize_obj(obj), f, ensure_ascii=False, separators=(",", ":"))


def write_geojson(path: Path, features: list[dict]) -> None:
    write_json(path, {"type": "FeatureCollection", "features": features})


# 5 decimal places ≈ 1 m — far finer than any source's geocoding precision,
# and keeps the shipped GeoJSON much smaller than raw float output.
COORD_DECIMALS = 5


def _round_coord(v: float) -> float:
    return round(float(v), COORD_DECIMALS)


def point_feature(lon: float, lat: float, props: dict) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [_round_coord(lon), _round_coord(lat)]},
        "properties": props,
    }


def polygon_feature(coords: list, props: dict) -> dict:
    ring = [[_round_coord(x), _round_coord(y)] for x, y in coords]
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": props,
    }


# ---------------------------------------------------------------------------
# Build provenance
# ---------------------------------------------------------------------------

# Every file the ETL reads. Recorded with SHA-256 so anyone can verify exactly
# which inputs produced a given catalog.
ETL_INPUT_FILES = [
    RAW / "hced" / "HCED_Data_v3.csv",
    RAW / "war-atlas" / "wars.csv",
    RAW / "war-atlas" / "battles.csv",
    RAW / "cow" / "Inter-StateWarData_v4.0.csv",
    RAW / "cow" / "Extra-StateWarData_v4.0.csv",
    RAW / "cow" / "Non-StateWarData_v4.0.csv",
    RAW / "cow" / "Intra-State-Wars-v5.1" / "INTRA-STATE WARS v5.1 CSV.csv",
    RAW / "cow" / "Dyadic-Interstate-War-Dataset" / "directed_dyadic_war.csv",
    RAW / "cow" / "MIDLOC_2.1" / "MIDLOCA_2.1.csv",
    RAW / "ucdp" / "ged261" / "GEDEvent_v26_1.csv",
    REVIEW / "crosswalk_decisions.json",
    REVIEW / "source_corrections.json",
]


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    import hashlib

    h = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def build_provenance(files: list[Path] | None = None) -> dict:
    """Input checksums + software versions for this build (no timestamp, so
    identical inputs give an identical record)."""
    import platform

    files = ETL_INPUT_FILES if files is None else files
    inputs = []
    for p in files:
        rel = p.relative_to(ROOT).as_posix()
        if p.exists():
            inputs.append({"path": rel, "bytes": p.stat().st_size, "sha256": sha256_file(p)})
        else:
            inputs.append({"path": rel, "missing": True})
    software = {"python": platform.python_version()}
    for mod in ("pandas", "numpy", "shapely", "rapidfuzz"):
        try:
            software[mod] = __import__(mod).__version__
        except Exception:  # pragma: no cover - optional
            software[mod] = None
    return {"inputs": inputs, "software": software}


# ---------------------------------------------------------------------------
# Longitude helpers (antimeridian-safe)
# ---------------------------------------------------------------------------

def circular_mean_lng(lngs) -> float | None:
    """Mean longitude on the circle, in [-180, 180].

    A plain arithmetic mean of 179 and -179 gives 0 (the wrong side of the
    planet). Averaging unit vectors gives ±180, which is correct.
    """
    import math

    vals = [float(v) for v in lngs if v is not None and v == v]
    if not vals:
        return None
    sx = sum(math.cos(math.radians(v)) for v in vals)
    sy = sum(math.sin(math.radians(v)) for v in vals)
    if abs(sx) < 1e-12 and abs(sy) < 1e-12:
        # Perfectly balanced around the globe — no meaningful centre; fall back.
        return sum(vals) / len(vals)
    return math.degrees(math.atan2(sy, sx))


def unwrap_lngs(lngs: list[float]) -> list[float]:
    """Express longitudes on the shortest continuous arc that contains them all.

    Used before building hull polygons: points at 170°E and 170°W are 20° apart,
    but a hull built in [-180, 180] would wrap the whole planet. We cut the
    circle at the largest empty gap between points; if that gap already
    contains the antimeridian the input is returned unchanged. Otherwise points
    west of the cut get +360, and the result is recentred so its midpoint lies in
    [-180, 180]; values may run past ±180 — Leaflet and Cesium both draw those.
    """
    if len(lngs) < 2:
        return list(lngs)
    xs = sorted(set(float(v) for v in lngs))
    if len(xs) < 2:
        return list(lngs)
    # Gap between consecutive points, plus the wrap-around gap across ±180.
    best_gap = 360.0 - (xs[-1] - xs[0])  # wrap gap: cutting here = no change
    cut_after = None
    for a, b in zip(xs, xs[1:]):
        if b - a > best_gap:
            best_gap = b - a
            cut_after = a
    if cut_after is None:
        return list(lngs)
    out = [v + 360.0 if v <= cut_after else v for v in lngs]
    # Keep the arc's midpoint inside [-180, 180] so the shape lands on the main
    # world copy (Caribbean + Philippines: -240..-65 rather than 120..295).
    if (min(out) + max(out)) / 2 > 180:
        out = [v - 360.0 for v in out]
    return out


# ---------------------------------------------------------------------------
# UCDP war threshold
# ---------------------------------------------------------------------------

UCDP_WAR_THRESHOLD = 1000


def ucdp_yearly_war_stats(events, threshold: int = UCDP_WAR_THRESHOLD):
    """Per-conflict peak calendar-year deaths and number of war-level years.

    UCDP's war definition is ≥1,000 battle-related deaths in a *single calendar
    year*, not summed over the whole conflict. `events` needs columns
    conflict_new_id, year, best. Returns a DataFrame indexed by conflict_new_id
    with peak_year_deaths, war_years, warlike.
    """
    import pandas as pd

    yearly = events.groupby(["conflict_new_id", "year"])["best"].sum()
    out = pd.DataFrame(
        {
            "peak_year_deaths": yearly.groupby(level=0).max(),
            "war_years": (yearly >= threshold).groupby(level=0).sum(),
        }
    )
    out["war_years"] = out["war_years"].astype(int)
    out["warlike"] = out["peak_year_deaths"] >= threshold
    return out


# ---------------------------------------------------------------------------
# HCED source corrections + cluster routing
# ---------------------------------------------------------------------------

def load_source_corrections() -> list[dict]:
    """Documented, per-record fixes for clear errors in raw source rows."""
    path = REVIEW / "source_corrections.json"
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return [c for c in raw.get("corrections", []) if c.get("id")]


def resolve_cluster(
    clusters: list[tuple[int, int, str]],
    year,
    merge_map: dict[str, str],
) -> str | None:
    """Pick the cluster war_id for a battle year, following merges.

    `clusters` must contain *every* year-cluster of a war name — including
    clusters that were merged into another catalog war. Dropping merged
    clusters sends their battles to the nearest surviving cluster (the bug that
    put 427 WWII battles on a one-battle "World War II (1835)" record).
    """
    if not clusters:
        return None
    if year is None or (isinstance(year, float) and year != year):
        wid = clusters[0][2]
        return merge_map.get(wid, wid)
    y = int(year)
    for y0, y1, wid in clusters:
        if y0 <= y <= y1:
            return merge_map.get(wid, wid)
    best = min(clusters, key=lambda c: min(abs(y - c[0]), abs(y - c[1])))
    return merge_map.get(best[2], best[2])


def cluster_years_by_gap(years: list[int], gap: int = 15) -> list[tuple[int, int]]:
    """Split sorted years into contiguous clusters when consecutive gaps exceed `gap`."""
    ys = sorted({int(y) for y in years if y is not None})
    if not ys:
        return []
    clusters: list[tuple[int, int]] = []
    start = prev = ys[0]
    for y in ys[1:]:
        if y - prev > gap:
            clusters.append((start, prev))
            start = y
        prev = y
    clusters.append((start, prev))
    return clusters


HCED_YEAR_GAP = 15

# Tokens that inflate fuzzy similarity between unrelated wars
CROSSWALK_STOPWORDS = frozenset(
    {
        "war",
        "wars",
        "of",
        "the",
        "a",
        "an",
        "and",
        "or",
        "to",
        "in",
        "on",
        "for",
        "first",
        "second",
        "third",
        "fourth",
        "fifth",
        "1st",
        "2nd",
        "3rd",
        "4th",
        "5th",
        "civil",
        "conflict",
        "conflicts",
        "battle",
        "battles",
        "campaign",
        "campaigns",
        "rebellion",
        "rebellions",
        "revolt",
        "revolts",
        "revolution",
        "revolutions",
        "independence",
        "invasion",
        "occupation",
        "crisis",
        "years",
        "year",
    }
)


def distinctive_war_tokens(norm: str) -> set[str]:
    return {t for t in str(norm or "").lower().split() if t not in CROSSWALK_STOPWORDS and len(t) > 2}


def load_crosswalk_decisions() -> dict[tuple[str, str], str]:
    """Map (left_id, right_id) → accepted|rejected from review decisions file."""
    path = REVIEW / "crosswalk_decisions.json"
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    out: dict[tuple[str, str], str] = {}
    for d in raw.get("decisions", []):
        left = str(d.get("left_id") or "")
        right = str(d.get("right_id") or "")
        status = str(d.get("status") or "").lower()
        if left and right and status in {"accepted", "rejected"}:
            out[(left, right)] = status
    return out


def append_progress_snapshot(qa: dict) -> Path:
    """Append a dated coverage snapshot for COW / catalog progress tracking."""
    hist_path = QA / "progress_history.json"
    QA.mkdir(parents=True, exist_ok=True)
    history: list = []
    if hist_path.exists():
        try:
            history = json.loads(hist_path.read_text(encoding="utf-8"))
            if not isinstance(history, list):
                history = []
        except (OSError, json.JSONDecodeError):
            history = []
    from datetime import datetime, timezone

    tier = (qa.get("tier_coverage") or {}).get("cow_war") or {}
    snap = {
        "at": datetime.now(timezone.utc).isoformat(),
        "wars_total": qa.get("wars_total"),
        "wars_with_battles": qa.get("wars_with_battles"),
        "wars_proxy_only": qa.get("wars_proxy_only"),
        "wars_unmapped": qa.get("wars_unmapped"),
        "crosswalks_total": qa.get("crosswalks_total"),
        "crosswalk_ambiguous": qa.get("crosswalk_ambiguous"),
        "crosswalk_accepted_decisions": qa.get("crosswalk_accepted_decisions"),
        "cow_total": tier.get("total"),
        "cow_with_battles": tier.get("battles"),
        "cow_proxy": tier.get("proxy"),
        "cow_unmapped": tier.get("unmapped"),
        "cow_pct_with_battles": round(100.0 * tier["battles"] / tier["total"], 2)
        if tier.get("total")
        else None,
    }
    # Avoid duplicate consecutive identical metrics (same day spam)
    if history:
        prev = {k: v for k, v in history[-1].items() if k != "at"}
        cur = {k: v for k, v in snap.items() if k != "at"}
        if prev != cur:
            history.append(snap)
        else:
            history[-1] = snap
    else:
        history.append(snap)
    hist_path.write_text(json.dumps(history, indent=2), encoding="utf-8")
    return hist_path

