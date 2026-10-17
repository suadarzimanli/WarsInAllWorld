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


def point_feature(lon: float, lat: float, props: dict) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": props,
    }


def polygon_feature(coords: list, props: dict) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [coords]},
        "properties": props,
    }


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

