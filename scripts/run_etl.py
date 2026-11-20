"""
Full ETL pipeline: normalize → canonical wars → crosswalk → battles → theaters → export.
Run from repo root:  python scripts/run_etl.py
"""
from __future__ import annotations

import ast
import csv
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

import pandas as pd
from rapidfuzz import fuzz
from shapely import concave_hull, convex_hull
from shapely.geometry import MultiPoint, Point

# Allow `python scripts/run_etl.py`
sys.path.insert(0, str(Path(__file__).resolve().parent))
# Windows consoles default to a legacy code page; never crash on "≥", "–", etc.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")
from common import (  # noqa: E402
    APP_PUBLIC_DATA,
    EXPORTS,
    HCED_YEAR_GAP,
    RAW,
    REVIEW,
    COW_DATA_END_INTRA_V51,
    COW_DATA_END_V4,
    UCDP_WAR_THRESHOLD,
    append_progress_snapshot,
    build_provenance,
    circular_mean_lng,
    cluster_years_by_gap,
    cow_end_year,
    cow_join_sides,
    cow_numeric_deaths,
    cow_side_label,
    distinctive_war_tokens,
    ensure_dirs,
    era_bucket,
    format_cow_warnum,
    load_crosswalk_decisions,
    load_source_corrections,
    normalize_war_name,
    parse_year,
    point_feature,
    polygon_feature,
    resolve_cluster,
    slugify,
    ucdp_yearly_war_stats,
    unwrap_lngs,
    write_geojson,
    write_json,
    year_span_label,
)

# Max UCDP events shipped per conflict (keeps the browser payload small).
# Totals in wars.json always use *all* events, never this sample.
UCDP_EVENT_CAP = 400

# Run-level stats surfaced in catalog_meta.json
RUN_STATS: dict = {}

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))


def read_csv(path: Path, **kwargs) -> pd.DataFrame:
    """Read CSV trying utf-8 then latin-1 (COW/HCED often use Windows encodings)."""
    try:
        return pd.read_csv(path, encoding="utf-8", **kwargs)
    except UnicodeDecodeError:
        return pd.read_csv(path, encoding="latin-1", **kwargs)


# ---------------------------------------------------------------------------
# 01 Normalize
# ---------------------------------------------------------------------------

# Column names per source for each correctable field
CORRECTION_FIELDS = {
    "hced": {"id": "ID", "year": "Year", "war": "War", "lat": "Latitude", "lng": "Longitude"},
    "war_atlas": {"id": "slug", "year": "year", "war": "war_slug", "lat": "lat", "lng": "lng"},
}


def apply_source_corrections(df: pd.DataFrame, source: str) -> pd.DataFrame:
    """Apply review/source_corrections.json entries for one source (raw CSV stays untouched).

    Each correction must still match its documented original value; a stale
    correction (source updated upstream) is reported and skipped, never forced.
    """
    cols = CORRECTION_FIELDS[source]
    corrections = [c for c in load_source_corrections() if c.get("source", "hced") == source]
    df = df.copy()
    applied, stale = 0, []
    ids = df[cols["id"]].astype(str)
    for c in corrections:
        mask = ids == str(c["id"])
        if not mask.any():
            stale.append(f"{c['id']} (id not found)")
            continue
        field = str(c.get("field"))
        col = cols.get(field) if field != "id" else None
        if col is None:
            stale.append(f"{c['id']} (unknown field {c.get('field')!r})")
            continue
        current = str(df.loc[mask, col].iloc[0]).strip()
        if field in ("lat", "lng"):
            try:
                matches = abs(float(current) - float(c.get("from"))) < 1e-4
            except (TypeError, ValueError):
                matches = False
        else:
            matches = current == str(c.get("from")) or normalize_war_name(current) == normalize_war_name(
                str(c.get("from", ""))
            )
        if not matches:
            stale.append(f"{c['id']} ({col}={current!r}, expected {c.get('from')!r})")
            continue
        df[col] = df[col].astype(object)
        df.loc[mask, col] = c["to"]
        applied += 1
    RUN_STATS["source_corrections_applied"] = RUN_STATS.get("source_corrections_applied", 0) + applied
    print(f"  {source} source corrections applied: {applied}/{len(corrections)}")
    for s_ in stale:
        print(f"  WARNING stale correction skipped: {s_}")
    return df


def ingest_hced() -> pd.DataFrame:
    path = RAW / "hced" / "HCED_Data_v3.csv"
    df = read_csv(path, low_memory=False)
    df = df[df["ID"].notna() & (df["ID"].astype(str).str.strip() != "")]
    df = apply_source_corrections(df, "hced")
    df["lat"] = pd.to_numeric(df["Latitude"], errors="coerce")
    df["lng"] = pd.to_numeric(df["Longitude"], errors="coerce")
    df = df[df["lat"].between(-90, 90) & df["lng"].between(-180, 180)]
    df["year"] = df["Year"].map(parse_year)
    # HCED IDs end in the battle year ("Ionkovo1807"); use it only when Year is empty.
    id_year = df["ID"].astype(str).str.extract(r"(\d{3,4})(?:-\d{2,4})?$")[0].map(parse_year)
    missing = df["year"].isna() & id_year.notna()
    if missing.any():
        print(f"  HCED year taken from ID (Year field empty): {int(missing.sum())}")
    df.loc[missing, "year"] = id_year[missing]
    df["war_raw"] = df["War"].fillna("").astype(str)
    df["war_norm"] = df["war_raw"].map(normalize_war_name)
    df["name"] = df["Battle"].fillna("").astype(str)
    df["minor"] = pd.to_numeric(df["Minor"], errors="coerce").eq(1)
    df["source"] = "hced"
    df["event_id"] = "hced:" + df["ID"].astype(str)
    out = df[
        [
            "event_id",
            "source",
            "name",
            "year",
            "lat",
            "lng",
            "war_raw",
            "war_norm",
            "minor",
            "Country",
            "Theatre",
        ]
    ].rename(columns={"Country": "country", "Theatre": "theatre"})
    print(f"  HCED battles: {len(out)}")
    return out


def ingest_war_atlas() -> tuple[pd.DataFrame, pd.DataFrame]:
    wars = read_csv(RAW / "war-atlas" / "wars.csv")
    wars["start_year"] = wars["start_year"].map(parse_year)
    wars["end_year"] = wars["end_year"].map(parse_year)
    wars["title_norm"] = wars["title"].map(normalize_war_name)
    wars["war_id_src"] = "wa:" + wars["slug"].astype(str)

    battles = read_csv(RAW / "war-atlas" / "battles.csv")
    battles = apply_source_corrections(battles, "war_atlas")
    battles["year"] = battles["year"].map(parse_year)
    battles["lat"] = pd.to_numeric(battles["lat"], errors="coerce")
    battles["lng"] = pd.to_numeric(battles["lng"], errors="coerce")
    battles = battles[battles["lat"].between(-90, 90) & battles["lng"].between(-180, 180)]
    battles["war_norm"] = battles["war_slug"].fillna("").map(lambda s: normalize_war_name(s.replace("_", " ")))
    battles["event_id"] = "wa:" + battles["slug"].astype(str)
    battles["source"] = "war_atlas"
    battles["name"] = battles["title"]
    out_b = battles[
        [
            "event_id",
            "source",
            "name",
            "year",
            "lat",
            "lng",
            "war_slug",
            "war_norm",
            "coord_precision",
            "wikidata_qid",
        ]
    ]
    print(f"  War Atlas wars: {len(wars)}, battles: {len(out_b)}")
    return wars, out_b


def _cow_end(values, censor_year: int) -> dict:
    end, ongoing = cow_end_year(values, censor_year)
    return {"end_year": end, "ongoing_at_source_end": ongoing}


def ingest_cow() -> pd.DataFrame:
    rows = []

    inter = read_csv(RAW / "cow" / "Inter-StateWarData_v4.0.csv")
    for warnum, g in inter.groupby("WarNum"):
        states = [cow_side_label(s) for s in g["StateName"].dropna().unique()]
        states = sorted({s for s in states if s})
        rows.append(
            {
                "cow_warnum": format_cow_warnum(warnum),
                "title": g["WarName"].iloc[0],
                "war_type": 1,
                "war_class": "interstate",
                "start_year": parse_year(g["StartYear1"].min()),
                **_cow_end(g["EndYear1"], COW_DATA_END_V4),
                "participants": "; ".join(states),
                "deaths": cow_numeric_deaths(g["BatDeath"]).sum(min_count=1),
            }
        )

    extra = read_csv(RAW / "cow" / "Extra-StateWarData_v4.0.csv")
    for warnum, g in extra.groupby("WarNum"):
        sides = []
        for _, r in g.iterrows():
            label = cow_join_sides(r.get("SideA", ""), r.get("SideB", ""))
            if label:
                sides.append(label)
        rows.append(
            {
                "cow_warnum": format_cow_warnum(warnum),
                "title": g["WarName"].iloc[0],
                "war_type": int(g["WarType"].iloc[0]) if pd.notna(g["WarType"].iloc[0]) else None,
                "war_class": "extrastate",
                "start_year": parse_year(g["StartYear1"].min()),
                **_cow_end(g["EndYear1"], COW_DATA_END_V4),
                "participants": "; ".join(dict.fromkeys(sides)),
                "deaths": cow_numeric_deaths(g["BatDeath"]).sum(min_count=1),
            }
        )

    nonst = read_csv(RAW / "cow" / "Non-StateWarData_v4.0.csv")
    for warnum, g in nonst.groupby("WarNum"):
        r = g.iloc[0]
        rows.append(
            {
                "cow_warnum": format_cow_warnum(warnum),
                "title": r["WarName"],
                "war_type": int(r["WarType"]) if pd.notna(r["WarType"]) else None,
                "war_class": "nonstate",
                "start_year": parse_year(r["StartYear"]),
                **_cow_end(g["EndYear"], COW_DATA_END_V4),
                "participants": cow_join_sides(r.get("SideA1", ""), r.get("SideB1", "")),
                "deaths": cow_numeric_deaths(r.get("TotalCombatDeaths")),
            }
        )

    intra = read_csv(RAW / "cow" / "Intra-State-Wars-v5.1" / "INTRA-STATE WARS v5.1 CSV.csv")
    for warnum, g in intra.groupby("WarNum"):
        r = g.iloc[0]
        rows.append(
            {
                "cow_warnum": format_cow_warnum(warnum),
                "title": r["WarName"],
                "war_type": int(r["WarType"]) if pd.notna(r["WarType"]) else None,
                "war_class": "intrastate",
                "start_year": parse_year(r["StartYr1"]),
                **_cow_end(g["EndYr1"], COW_DATA_END_INTRA_V51),
                "participants": cow_join_sides(r.get("SideA", ""), r.get("SideB", "")),
                "deaths": cow_numeric_deaths(r.get("TotalBDeaths")),
            }
        )

    cow = pd.DataFrame(rows)
    # Keep typology overlaps distinct; preserve decimal Intra WarNums (502.1 ≠ 502).
    cow = cow.drop_duplicates(subset=["war_class", "cow_warnum"], keep="first")
    cow["title_norm"] = cow["title"].map(normalize_war_name)
    # Prefix class when the same WarNum appears in multiple typologies.
    # Re-format through format_cow_warnum so float64 columns don't yield "502.0" ids.
    dup_nums = cow["cow_warnum"].duplicated(keep=False)
    cow["war_id_src"] = [
        f"cow:{cls}:{format_cow_warnum(num)}" if is_dup else f"cow:{format_cow_warnum(num)}"
        for cls, num, is_dup in zip(cow["war_class"], cow["cow_warnum"], dup_nums)
    ]
    cow["definition_tier"] = "cow_war"
    print(f"  COW wars: {len(cow)}")
    return cow


def ingest_midloc() -> pd.DataFrame:
    a = read_csv(RAW / "cow" / "MIDLOC_2.1" / "MIDLOCA_2.1.csv")
    a["lat"] = pd.to_numeric(a["midloc2_ylatitude"], errors="coerce")
    a["lng"] = pd.to_numeric(a["midloc2_xlongitude"], errors="coerce")
    a = a[a["lat"].between(-90, 90) & a["lng"].between(-180, 180)]
    a["year"] = a["year"].map(parse_year)
    a["event_id"] = "midloca:" + a["dispnum"].astype(str)
    a["name"] = a["midloc2_location"].fillna(a["midloc2_measuringpoint"])
    a["event_kind"] = "mid_dispute"
    a["source"] = "midloc"
    out = a[["event_id", "source", "event_kind", "name", "year", "lat", "lng", "dispnum", "midloc2_precision"]]
    print(f"  MIDLOC disputes: {len(out)}")
    return out


def ingest_ucdp() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Stream UCDP: keep type_of_violence==1; build conflict aggregates + sampled events."""
    path = RAW / "ucdp" / "ged261" / "GEDEvent_v26_1.csv"
    usecols = [
        "id",
        "year",
        "type_of_violence",
        "conflict_new_id",
        "conflict_name",
        "latitude",
        "longitude",
        "where_prec",
        "country",
        "best",
    ]
    chunks: list[pd.DataFrame] = []
    for chunk in read_csv(path, usecols=usecols, chunksize=80_000, low_memory=False):
        chunk = chunk[chunk["type_of_violence"] == 1].copy()
        chunk["lat"] = pd.to_numeric(chunk["latitude"], errors="coerce")
        chunk["lng"] = pd.to_numeric(chunk["longitude"], errors="coerce")
        chunk = chunk[chunk["lat"].between(-90, 90) & chunk["lng"].between(-180, 180)]
        chunk["best"] = pd.to_numeric(chunk["best"], errors="coerce").fillna(0).astype(int)
        chunk["year"] = pd.to_numeric(chunk["year"], errors="coerce").astype("Int64")
        chunk["conflict_new_id"] = chunk["conflict_new_id"].astype(int).astype(str)
        chunks.append(
            chunk[
                [
                    "id",
                    "year",
                    "conflict_new_id",
                    "conflict_name",
                    "lat",
                    "lng",
                    "where_prec",
                    "country",
                    "best",
                ]
            ]
        )

    all_ev = pd.concat(chunks, ignore_index=True)
    conflicts = (
        all_ev.groupby("conflict_new_id", as_index=False)
        .agg(
            title=("conflict_name", "first"),
            start_year=("year", "min"),
            end_year=("year", "max"),
            deaths=("best", "sum"),
            event_count=("id", "count"),
            centroid_lat=("lat", "mean"),
            centroid_lng=("lng", circular_mean_lng),
        )
    )
    conflicts["title_norm"] = conflicts["title"].map(normalize_war_name)
    # UCDP war = ≥1,000 battle-related deaths in at least one calendar year.
    # (Earlier versions summed deaths over the whole conflict, which wrongly
    # promoted long low-intensity conflicts to "war".)
    yearly = ucdp_yearly_war_stats(all_ev, UCDP_WAR_THRESHOLD)
    conflicts = conflicts.merge(yearly, left_on="conflict_new_id", right_index=True, how="left")
    conflicts["warlike"] = conflicts["warlike"].fillna(False).astype(bool)
    cumulative_only = int(((conflicts["deaths"] >= UCDP_WAR_THRESHOLD) & ~conflicts["warlike"]).sum())
    RUN_STATS["ucdp_cumulative_only_excluded"] = cumulative_only
    conflicts["war_id_src"] = "ucdp:conflict:" + conflicts["conflict_new_id"].astype(str)
    conflicts["definition_tier"] = conflicts["warlike"].map(
        lambda w: "ucdp_warlike" if w else "ucdp_conflict"
    )

    # Ship at most UCDP_EVENT_CAP events per conflict (highest deaths first).
    # This is a display sample only — see events_total / deaths in wars.json.
    all_ev = all_ev.sort_values(["best", "id"], ascending=[False, True])
    events = all_ev.groupby("conflict_new_id", group_keys=False).head(UCDP_EVENT_CAP).copy()
    RUN_STATS["ucdp_event_cap"] = UCDP_EVENT_CAP
    RUN_STATS["ucdp_events_state_based_total"] = int(len(all_ev))
    events["event_id"] = "ucdp:" + events["id"].astype(str)
    events["source"] = "ucdp"
    events["name"] = events["conflict_name"]
    events["deaths_best"] = events["best"]
    events = events.rename(columns={"where_prec": "where_prec"})
    print(
        f"  UCDP conflicts: {len(conflicts)} (war-level in ≥1 year: {int(conflicts['warlike'].sum())}; "
        f"excluded because only cumulative deaths ≥{UCDP_WAR_THRESHOLD}: {cumulative_only}), "
        f"event samples: {len(events)}"
    )
    return conflicts, events


# ---------------------------------------------------------------------------
# 02 Canonical wars + crosswalk
# ---------------------------------------------------------------------------

def build_canonical_wars(
    cow: pd.DataFrame,
    wa_wars: pd.DataFrame,
    hced: pd.DataFrame,
    ucdp_conflicts: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    wars: list[dict] = []
    links: list[dict] = []
    ambiguous: list[dict] = []
    rejected: list[dict] = []
    review_decisions = load_crosswalk_decisions()
    if review_decisions:
        print(f"  Loaded {len(review_decisions)} crosswalk review decisions")

    # Index for fuzzy matching against COW + WA
    cow_index = [
        (row.war_id_src, row.title_norm, row.start_year, row.end_year, row.title)
        for row in cow.itertuples()
    ]
    wa_index = [
        (row.war_id_src, row.title_norm, row.start_year, row.end_year, row.title)
        for row in wa_wars.itertuples()
    ]

    # Generic tokens that inflate fuzzy scores between unrelated wars
    # ("seven years war" ≈ "ten years war", "chadian civil war" ≈ "cambodian civil war").
    def distinctive_tokens(norm: str) -> set[str]:
        return distinctive_war_tokens(norm)

    def years_overlap(a0, a1, b0, b1, pad: int = 2) -> bool:
        if a0 is None or b0 is None or (isinstance(a0, float) and pd.isna(a0)) or (
            isinstance(b0, float) and pd.isna(b0)
        ):
            return False
        a0, b0 = int(a0), int(b0)
        a1 = int(a1) if a1 is not None and not (isinstance(a1, float) and pd.isna(a1)) else a0
        b1 = int(b1) if b1 is not None and not (isinstance(b1, float) and pd.isna(b1)) else b0
        return not (a1 + pad < b0 or b1 + pad < a0)

    def years_compatible_for_merge(a0, a1, b0, b1) -> bool:
        """Stricter than candidate search — blocks century-spanning HCED aggregates."""
        if not years_overlap(a0, a1, b0, b1, pad=1):
            return False
        a0, b0 = int(a0), int(b0)
        a1 = int(a1) if a1 is not None and not (isinstance(a1, float) and pd.isna(a1)) else a0
        b1 = int(b1) if b1 is not None and not (isinstance(b1, float) and pd.isna(b1)) else b0
        # Starts (or ends) must be in the same historical neighborhood
        if abs(a0 - b0) <= 40 or abs(a1 - b1) <= 40:
            return True
        # Or one span mostly contains the other
        span_a, span_b = a1 - a0, b1 - b0
        if span_a >= 0 and span_b >= 0:
            inter = max(0, min(a1, b1) - max(a0, b0))
            shorter = max(1, min(span_a, span_b))
            if inter / shorter >= 0.5:
                return True
        return False

    def auto_merge_ok(
        left_norm: str,
        left_start,
        left_end,
        right_norm: str,
        right_start,
        right_end,
        score: float,
        right_id: str,
        right_title: str,
    ) -> bool:
        """Gate fuzzy auto-merges; false friends go to needs_review instead."""
        if score < 0.90:
            return False
        if not years_compatible_for_merge(left_start, left_end, right_start, right_end):
            return False
        ta, tb = distinctive_tokens(left_norm), distinctive_tokens(right_norm)
        if not ta or not tb:
            return score >= 0.97
        overlap = ta & tb
        if not overlap:
            return False
        only_a, only_b = ta - tb, tb - ta
        # Different proper nouns on both sides (american≠dominican, chad≠cambodia)
        if only_a and only_b and score < 0.97:
            return False
        return True

    def best_match(norm: str, start, end, pool, pad: int = 2):
        best = None
        best_score = 0.0
        best_meta = None
        for wid, tnorm, s, e, title in pool:
            if not tnorm or not norm:
                continue
            if not years_overlap(start, end, s, e, pad=pad):
                continue
            score = fuzz.token_sort_ratio(norm, tnorm) / 100.0
            if score > best_score:
                best_score = score
                best = (wid, title, score)
                best_meta = (tnorm, s, e)
        if best and best_meta:
            return (*best, best_meta[0], best_meta[1], best_meta[2])
        return None

    def looks_like_false_friend(
        left_norm: str,
        left_start,
        left_end,
        right_norm: str,
        right_start,
        right_end,
    ) -> bool:
        """True when distinctive tokens/years make an auto-merge unsafe."""
        if not years_compatible_for_merge(left_start, left_end, right_start, right_end):
            return True
        ta, tb = distinctive_tokens(left_norm), distinctive_tokens(right_norm)
        if not ta or not tb:
            return True
        if not (ta & tb):
            return True
        only_a, only_b = ta - tb, tb - ta
        if only_a and only_b:
            return True
        return False

    # Accepted decisions can retarget away from a wrong fuzzy best-match
    # (e.g. American Civil War → cow:572, not Central American cow:1550).
    accepted_by_left: dict[str, str] = {
        left: right for (left, right), st in review_decisions.items() if st == "accepted"
    }
    title_by_id: dict[str, str] = {wid: title for wid, _n, _s, _e, title in cow_index}

    def try_auto_or_review(
        *,
        left_source: str,
        left_id: str,
        left_title: str,
        left_norm: str,
        left_start,
        left_end,
        match,
        reason: str,
        on_auto,
        on_keep_separate,
    ):
        """Apply merge gate; call on_auto() or on_keep_separate(needs_review: bool)."""

        def _y(v):
            return None if v is None or (isinstance(v, float) and pd.isna(v)) else int(v)

        # Context saved with every link so merges can be audited by a human later
        ctx = {
            "left_title": left_title,
            "left_start": _y(left_start),
            "left_end": _y(left_end),
            "right_title": match[1] if match else None,
            "right_start": _y(match[4]) if match else None,
            "right_end": _y(match[5]) if match else None,
        }
        forced_right = accepted_by_left.get(left_id)
        if forced_right:
            title = title_by_id.get(forced_right, forced_right)
            score = float(match[2]) if match and match[0] == forced_right else 1.0
            links.append(
                {
                    **ctx,
                    # Reviewer-forced target can differ from the fuzzy best match
                    "right_title": title,
                    "right_start": None,
                    "right_end": None,
                    "left_source": left_source,
                    "left_id": left_id,
                    "right_source": forced_right.split(":")[0],
                    "right_id": forced_right,
                    "match_method": "review_accepted",
                    "confidence": round(score, 3),
                    "notes": f"review accepted → {title}",
                    "review_status": "accepted",
                }
            )
            on_auto(forced_right, title, score)
            return
        if not match:
            on_keep_separate(False)
            return
        wid, title, score, rnorm, rstart, rend = match
        decision = review_decisions.get((left_id, wid))
        if decision == "rejected":
            rejected.append(
                {
                    "left_id": left_id,
                    "left_title": left_title,
                    "right_id": wid,
                    "right_title": title,
                    "confidence": round(score, 3),
                    "reason": reason,
                }
            )
            links.append(
                {
                    **ctx,
                    "left_source": left_source,
                    "left_id": left_id,
                    "right_source": wid.split(":")[0],
                    "right_id": wid,
                    "match_method": "review_rejected",
                    "confidence": round(score, 3),
                    "notes": "review rejected",
                    "review_status": "rejected",
                }
            )
            on_keep_separate(False)
            return
        # Exact normalized title + close years → accept (rescues e.g. Sonderbund pad edge)
        exact_name = left_norm == rnorm and bool(left_norm)
        if exact_name and years_overlap(left_start, left_end, rstart, rend, pad=3):
            links.append(
                {
                    **ctx,
                    "left_source": left_source,
                    "left_id": left_id,
                    "right_source": wid.split(":")[0],
                    "right_id": wid,
                    "match_method": "exact_name_year",
                    "confidence": round(max(score, 0.99), 3),
                    "notes": f"exact name → {title}",
                    "review_status": "auto",
                }
            )
            on_auto(wid, title, score)
            return
        if score >= 0.90 and auto_merge_ok(
            left_norm, left_start, left_end, rnorm, rstart, rend, score, wid, title
        ):
            links.append(
                {
                    **ctx,
                    "left_source": left_source,
                    "left_id": left_id,
                    "right_source": wid.split(":")[0],
                    "right_id": wid,
                    "match_method": "fuzzy_name_year",
                    "confidence": round(score, 3),
                    "notes": f"matched to {title}",
                    "review_status": "auto",
                }
            )
            on_auto(wid, title, score)
            return
        if score >= 0.70:
            false_friend = looks_like_false_friend(
                left_norm, left_start, left_end, rnorm, rstart, rend
            )
            status = "rejected" if false_friend else "needs_review"
            note = "rejected_false_friend" if false_friend else "related_not_merged"
            if status == "needs_review":
                ambiguous.append(
                    {
                        "left_id": left_id,
                        "left_title": left_title,
                        "right_id": wid,
                        "right_title": title,
                        "confidence": round(score, 3),
                        "reason": reason,
                    }
                )
            else:
                rejected.append(
                    {
                        "left_id": left_id,
                        "left_title": left_title,
                        "right_id": wid,
                        "right_title": title,
                        "confidence": round(score, 3),
                        "reason": reason,
                    }
                )
            links.append(
                {
                    **ctx,
                    "left_source": left_source,
                    "left_id": left_id,
                    "right_source": wid.split(":")[0],
                    "right_id": wid,
                    "match_method": "fuzzy_name_year",
                    "confidence": round(score, 3),
                    "notes": note,
                    "review_status": status,
                }
            )
            on_keep_separate(status == "needs_review")
            return
        on_keep_separate(False)

    # 1) COW wars are primary for modern formal catalog
    for row in cow.itertuples():
        wars.append(
            {
                "war_id": row.war_id_src,
                "title": row.title,
                "start_year": row.start_year,
                "end_year": row.end_year if pd.notna(row.end_year) else row.start_year,
                "era_bucket": era_bucket(row.start_year),
                "definition_tier": "cow_war",
                "war_class": row.war_class,
                "sources": "cow",
                "cow_warnum": row.cow_warnum,
                "wa_slug": None,
                "ucdp_conflict_id": None,
                "wikidata_qid": None,
                "participant_summary": row.participants,
                "death_estimate": None if pd.isna(row.deaths) else float(row.deaths),
                "death_source": None if pd.isna(row.deaths) else "cow_battle_deaths",
                "ongoing_at_source_end": bool(row.ongoing_at_source_end),
                "title_norm": row.title_norm,
            }
        )

    cow_ids = {w["war_id"] for w in wars}

    # 2) War Atlas — merge into COW if high confidence, else keep
    # Phase-split donors: battles are year-routed later; do not keep a duplicate Atlas war
    # and do not merge the whole war onto a single COW phase.
    for row in wa_wars.itertuples():
        if str(row.slug) in PHASE_BATTLE_SPLITS:
            for _y0, _y1, target in PHASE_BATTLE_SPLITS[str(row.slug)]:
                for w in wars:
                    if w["war_id"] == target:
                        srcs = set((w["sources"] or "").split("|"))
                        srcs.add("war_atlas")
                        w["sources"] = "|".join(sorted(s for s in srcs if s))
                        if not w.get("wa_slug"):
                            w["wa_slug"] = row.slug
                        break
            links.append(
                {
                    "left_source": "war_atlas",
                    "left_id": row.war_id_src,
                    "right_source": "cow",
                    "right_id": "|".join(t for _a, _b, t in PHASE_BATTLE_SPLITS[str(row.slug)]),
                    "match_method": "phase_year_split",
                    "confidence": 1.0,
                    "notes": "battles routed by year onto COW phases; Atlas war not kept as separate catalog row",
                    "review_status": "accepted",
                }
            )
            continue

        m = best_match(row.title_norm, row.start_year, row.end_year, cow_index, pad=1)
        merged = {"done": False}

        def on_auto(wid, title, score, _row=row, _merged=merged):
            for w in wars:
                if w["war_id"] == wid:
                    w["wa_slug"] = _row.slug
                    w["wikidata_qid"] = _row.wikidata_qid
                    srcs = set((w["sources"] or "").split("|"))
                    srcs.add("war_atlas")
                    w["sources"] = "|".join(sorted(s for s in srcs if s))
                    break
            _merged["done"] = True

        def on_keep(_needs, _row=row, _merged=merged):
            wars.append(
                {
                    "war_id": _row.war_id_src,
                    "title": _row.title,
                    "start_year": _row.start_year,
                    "end_year": _row.end_year,
                    "era_bucket": era_bucket(_row.start_year),
                    "definition_tier": "atlas_curated",
                    "war_class": "modern_named",
                    "sources": "war_atlas",
                    "cow_warnum": None,
                    "wa_slug": _row.slug,
                    "ucdp_conflict_id": None,
                    "wikidata_qid": _row.wikidata_qid,
                    "participant_summary": None,
                    "death_estimate": None,
                    "title_norm": _row.title_norm,
                }
            )
            _merged["done"] = True

        try_auto_or_review(
            left_source="war_atlas",
            left_id=row.war_id_src,
            left_title=row.title,
            left_norm=row.title_norm,
            left_start=row.start_year,
            left_end=row.end_year,
            match=m,
            reason="wa_to_cow",
            on_auto=on_auto,
            on_keep_separate=on_keep,
        )

    # Rebuild indexes including WA-only wars for HCED/UCDP
    all_named = [
        (w["war_id"], w["title_norm"], w["start_year"], w["end_year"], w["title"])
        for w in wars
    ]

    # 3) HCED distinct war strings — split polluted multi-century bags by year gaps
    hced_valid = hced[hced["war_norm"].astype(str).str.len() > 0].copy()
    hced_cluster_count = 0
    # Every year-cluster of every HCED war name, *including* clusters that get
    # merged into an existing COW/Atlas war. attach_battles needs the full list.
    hced_cluster_index: dict[str, list[tuple[int, int, str]]] = defaultdict(list)
    for war_norm, grp in hced_valid.groupby("war_norm"):
        title_raw = grp["war_raw"].iloc[0]
        title_clean = normalize_war_name(title_raw)
        display = title_raw
        if str(display).startswith("["):
            try:
                parsed = ast.literal_eval(display)
                if isinstance(parsed, list) and parsed:
                    display = parsed[0]
            except Exception:
                display = title_clean
        years = [int(y) for y in grp["year"].dropna().tolist()]
        clusters = cluster_years_by_gap(years, gap=HCED_YEAR_GAP)
        if not clusters:
            continue
        multi = len(clusters) > 1
        if multi:
            hced_cluster_count += 1
        base_slug = slugify(title_clean or str(display))
        for y0, y1 in clusters:
            cluster_battles = grp[grp["year"].between(y0, y1)]
            if multi:
                wid = f"hced:{base_slug}:{y0}_{y1}"
                title_out = f"{display} ({year_span_label(int(y0), int(y1))})"
            else:
                wid = f"hced:{base_slug}"
                title_out = str(display)
            hced_cluster_index[war_norm].append((int(y0), int(y1), wid))
            m = best_match(title_clean, y0, y1, all_named, pad=5)
            skip_add = {"v": False}

            def on_auto_h(_wid, _title, _score, _skip=skip_add):
                _skip["v"] = True

            def on_keep_h(_needs, _skip=skip_add):
                _skip["v"] = False

            try_auto_or_review(
                left_source="hced",
                left_id=wid,
                left_title=title_out,
                left_norm=title_clean,
                left_start=y0,
                left_end=y1,
                match=m,
                reason="hced_to_existing",
                on_auto=on_auto_h,
                on_keep_separate=on_keep_h,
            )
            if skip_add["v"]:
                continue
            wars.append(
                {
                    "war_id": wid,
                    "title": title_out,
                    "start_year": y0,
                    "end_year": y1,
                    "era_bucket": era_bucket(y0),
                    "definition_tier": "hced_war_string",
                    "war_class": "ancient_named" if y0 < 1763 else "named_encyclopedia",
                    "sources": "hced",
                    "cow_warnum": None,
                    "wa_slug": None,
                    "ucdp_conflict_id": None,
                    "wikidata_qid": None,
                    "participant_summary": None,
                    "death_estimate": None,
                    "title_norm": title_clean,
                    "hced_norm": war_norm,
                    "hced_y0": y0,
                    "hced_y1": y1,
                    "hced_battle_n": int(len(cluster_battles)),
                }
            )

    if hced_cluster_count:
        print(f"  HCED year-gap splits: {hced_cluster_count} multi-cluster war names")

    all_named = [
        (w["war_id"], w["title_norm"], w["start_year"], w["end_year"], w["title"])
        for w in wars
    ]

    # 4) UCDP warlike conflicts
    for row in ucdp_conflicts.itertuples():
        if not row.warlike:
            continue
        m = best_match(row.title_norm, row.start_year, row.end_year, all_named, pad=2)
        skip_add = {"v": False}

        def on_auto_u(wid, title, score, _row=row, _skip=skip_add):
            for w in wars:
                if w["war_id"] == wid:
                    w["ucdp_conflict_id"] = _row.conflict_new_id
                    w["ucdp_peak_year_deaths"] = int(_row.peak_year_deaths)
                    w["ucdp_war_years"] = int(_row.war_years)
                    srcs = set((w["sources"] or "").split("|"))
                    srcs.add("ucdp")
                    w["sources"] = "|".join(sorted(s for s in srcs if s))
                    if w.get("death_estimate") is None:
                        w["death_estimate"] = float(_row.deaths)
                        w["death_source"] = "ucdp_best_total"
                    break
            _skip["v"] = True

        def on_keep_u(_needs, _row=row, _skip=skip_add):
            _skip["v"] = False

        try_auto_or_review(
            left_source="ucdp",
            left_id=row.war_id_src,
            left_title=row.title,
            left_norm=row.title_norm,
            left_start=row.start_year,
            left_end=row.end_year,
            match=m,
            reason="ucdp_to_existing",
            on_auto=on_auto_u,
            on_keep_separate=on_keep_u,
        )
        if skip_add["v"]:
            continue
        wars.append(
            {
                "war_id": row.war_id_src,
                "title": row.title,
                "start_year": row.start_year,
                "end_year": row.end_year,
                "era_bucket": era_bucket(row.start_year),
                "definition_tier": "ucdp_warlike",
                "war_class": "ucdp_state_based",
                "sources": "ucdp",
                "cow_warnum": None,
                "wa_slug": None,
                "ucdp_conflict_id": row.conflict_new_id,
                "wikidata_qid": None,
                "participant_summary": None,
                "death_estimate": float(row.deaths),
                "death_source": "ucdp_best_total",
                "ucdp_peak_year_deaths": int(row.peak_year_deaths),
                "ucdp_war_years": int(row.war_years),
                "title_norm": row.title_norm,
                "ucdp_centroid_lat": row.centroid_lat,
                "ucdp_centroid_lng": row.centroid_lng,
            }
        )

    wars_df = pd.DataFrame(wars)
    # Final safety: unique war_id (COW Extra-State previously emitted duplicates)
    before = len(wars_df)
    wars_df = wars_df.drop_duplicates(subset=["war_id"], keep="first")
    if len(wars_df) < before:
        print(f"  Deduped wars: {before} → {len(wars_df)}")
    # drop helper cols later
    links_df = pd.DataFrame(links)
    amb_df = pd.DataFrame(ambiguous)
    rej_df = pd.DataFrame(rejected)

    amb_df.to_csv(REVIEW / "ambiguous_matches.csv", index=False)
    rej_df.to_csv(REVIEW / "rejected_matches.csv", index=False)
    print(
        f"  Canonical wars: {len(wars_df)}, crosswalks: {len(links_df)}, "
        f"ambiguous: {len(amb_df)}, rejected: {len(rej_df)}"
    )
    return wars_df, links_df, amb_df, dict(hced_cluster_index)


# ---------------------------------------------------------------------------
# 03 Attach battles
# ---------------------------------------------------------------------------

# War Atlas (and similar) wars that COW splits into phases — route battles by year
# instead of dumping the whole Atlas war onto one phase.
PHASE_BATTLE_SPLITS: dict[str, list[tuple[int | None, int | None, str]]] = {
    # COW: phase 1 1960-65, phase 2 1965-75. Atlas spans ~1955-75.
    "vietnam": [
        (None, 1964, "cow:748"),
        (1965, None, "cow:163"),
    ],
    # COW: phase 1 ~1850-60, phase 2 1860-66. Atlas ~1851-64.
    "taiping_rebellion": [
        (None, 1860, "cow:1534"),
        (1861, None, "cow:567"),
    ],
}


def apply_phase_battle_split(war_id: str, year) -> str:
    """If war_id is a known multi-phase donor, send the event to the COW phase for that year."""
    wid = str(war_id)
    slug = wid[3:] if wid.startswith("wa:") else wid
    # Also accept bare slug keys
    rules = PHASE_BATTLE_SPLITS.get(slug) or PHASE_BATTLE_SPLITS.get(wid)
    if not rules:
        return wid
    y = None
    if year is not None and not (isinstance(year, float) and pd.isna(year)):
        try:
            y = int(year)
        except (TypeError, ValueError):
            y = None
    if y is None:
        return rules[-1][2]
    for y0, y1, target in rules:
        lo = -99999 if y0 is None else y0
        hi = 99999 if y1 is None else y1
        if lo <= y <= hi:
            return target
    return rules[-1][2]


def attach_battles(
    wars: pd.DataFrame,
    hced: pd.DataFrame,
    wa_battles: pd.DataFrame,
    ucdp_events: pd.DataFrame,
    links: pd.DataFrame,
    hced_cluster_index: dict[str, list[tuple[int, int, str]]],
    ucdp_conflicts: pd.DataFrame,
) -> tuple[pd.DataFrame, dict[str, dict]]:
    # Map source ids → canonical war_id (follow auto + accepted review merges)
    merge_map: dict[str, str] = {}
    if len(links):
        for row in links.itertuples():
            status = str(getattr(row, "review_status", "") or "")
            notes = str(getattr(row, "notes", "") or "")
            if status in {"auto", "accepted"} and "related_not_merged" not in notes:
                merge_map[str(row.left_id)] = str(row.right_id)

    war_by_norm = {}
    for row in wars.itertuples():
        war_by_norm[row.title_norm] = row.war_id
        hced_norm = getattr(row, "hced_norm", None)
        if isinstance(hced_norm, str) and hced_norm:
            war_by_norm[hced_norm] = row.war_id

    # Also map hced slug ids
    for row in wars.itertuples():
        if str(row.war_id).startswith("hced:"):
            war_by_norm[row.title_norm] = row.war_id

    def resolve_hced_war_id(war_norm: str, year) -> str:
        # Full cluster list (merged clusters included) — see resolve_cluster docstring.
        hit = resolve_cluster(hced_cluster_index.get(war_norm, []), year, merge_map)
        if hit is not None:
            return hit
        wid = war_by_norm.get(war_norm)
        if wid is None:
            wid = "hced:" + slugify(war_norm)
        return merge_map.get(wid, wid)

    # wa slug → war_id
    wa_slug_to_war = {}
    for row in wars.itertuples():
        if pd.notna(row.wa_slug) and row.wa_slug:
            wa_slug_to_war[row.wa_slug] = row.war_id
        if str(row.war_id).startswith("wa:"):
            wa_slug_to_war[row.war_id.replace("wa:", "", 1)] = row.war_id

    events = []

    for row in hced.itertuples():
        if bool(row.minor):
            continue
        wid = resolve_hced_war_id(row.war_norm, row.year)
        events.append(
            {
                "event_id": row.event_id,
                "war_id": wid,
                "source": "hced",
                "event_kind": "battle",
                "name": row.name,
                "year": row.year,
                "lat": row.lat,
                "lng": row.lng,
                "deaths_best": None,
                "geo_precision": None,
                "minor": bool(row.minor),
            }
        )

    for row in wa_battles.itertuples():
        wid = wa_slug_to_war.get(row.war_slug)
        if wid is None:
            wid = "wa:" + str(row.war_slug)
        wid = merge_map.get(wid, wid)
        # Year-split donors (Vietnam / Taiping): route even if donor war was not kept in catalog
        if str(row.war_slug) in PHASE_BATTLE_SPLITS:
            wid = apply_phase_battle_split(str(row.war_slug), row.year)
        else:
            wid = apply_phase_battle_split(wid, row.year)
        events.append(
            {
                "event_id": row.event_id,
                "war_id": wid,
                "source": "war_atlas",
                "event_kind": "battle",
                "name": row.name,
                "year": row.year,
                "lat": row.lat,
                "lng": row.lng,
                "deaths_best": None,
                "geo_precision": row.coord_precision,
                "minor": False,
            }
        )

    # UCDP: map conflict → war_id
    ucdp_to_war = {}
    for row in wars.itertuples():
        if pd.notna(row.ucdp_conflict_id) and row.ucdp_conflict_id:
            ucdp_to_war[str(row.ucdp_conflict_id)] = row.war_id
        if str(row.war_id).startswith("ucdp:conflict:"):
            ucdp_to_war[str(row.war_id).split(":")[-1]] = row.war_id
    if len(links):
        for row in links.itertuples():
            if row.left_source == "ucdp" and row.review_status in {"auto", "accepted"} and "related_not_merged" not in str(row.notes):
                cid = str(row.left_id).split(":")[-1]
                ucdp_to_war[cid] = row.right_id

    for row in ucdp_events.itertuples():
        wid = ucdp_to_war.get(str(row.conflict_new_id), f"ucdp:conflict:{row.conflict_new_id}")
        wid = merge_map.get(wid, wid)
        events.append(
            {
                "event_id": row.event_id,
                "war_id": wid,
                "source": "ucdp",
                "event_kind": "ucdp_event",
                "name": row.name,
                "year": row.year,
                "lat": row.lat,
                "lng": row.lng,
                "deaths_best": row.deaths_best,
                "geo_precision": row.where_prec,
                "minor": False,
            }
        )

    ev = pd.DataFrame(events)
    # Keep only events whose war_id exists in wars (or create soft orphans filter)
    valid_wars = set(wars["war_id"].astype(str))
    # Also accept merge targets
    ev["war_id"] = ev["war_id"].astype(str).map(lambda x: merge_map.get(x, x))
    ev = ev[ev["war_id"].isin(valid_wars)].copy()
    ev["geo_precision"] = ev["geo_precision"].map(lambda x: None if pd.isna(x) else str(x))
    ev["year"] = pd.to_numeric(ev["year"], errors="coerce")
    ev["deaths_best"] = pd.to_numeric(ev["deaths_best"], errors="coerce")

    # Full (unsampled) UCDP totals per catalog war: a war can absorb several
    # UCDP conflicts via the crosswalk, so sum over every linked conflict.
    ucdp_totals: dict[str, dict] = {}
    for row in ucdp_conflicts.itertuples():
        if not row.warlike:
            continue
        wid = ucdp_to_war.get(str(row.conflict_new_id), f"ucdp:conflict:{row.conflict_new_id}")
        wid = merge_map.get(wid, wid)
        if wid not in valid_wars:
            continue
        t = ucdp_totals.setdefault(wid, {"events_total": 0, "deaths_total": 0})
        t["events_total"] += int(row.event_count)
        t["deaths_total"] += int(row.deaths)
    shown = ev[ev["source"] == "ucdp"].groupby("war_id").size().to_dict()
    for wid, t in ucdp_totals.items():
        t["events_shown"] = int(shown.get(wid, 0))

    print(f"  Attached battles/events: {len(ev)}")
    return ev, ucdp_totals


# ---------------------------------------------------------------------------
# 04 Theaters
# ---------------------------------------------------------------------------

def _buffer_deg(km: float, lat: float) -> float:
    # rough degrees from km
    return km / (111.32 * max(0.2, abs(math.cos(math.radians(lat)))))


def widen_placeholder_spans(wars: pd.DataFrame, battles: pd.DataFrame) -> pd.DataFrame:
    """War Atlas writes end_year = start_year as a placeholder for wars it has not
    dated yet (e.g. Russo-Ukrainian War "2014–2014" with battles to 2025). Only for
    War-Atlas-only wars with such a single-year span whose own linked battles fall
    outside it, widen the span to cover those battles and flag it. Every other
    span is kept exactly as the source gives it.
    """
    wars = wars.copy()
    yrs = battles.dropna(subset=["year"]).groupby("war_id")["year"].agg(["min", "max"])
    wars["span_from_battles"] = False
    n = 0
    for i, row in wars.iterrows():
        if row["definition_tier"] != "atlas_curated" or row["war_id"] not in yrs.index:
            continue
        s0, s1 = row["start_year"], row["end_year"]
        if pd.isna(s0) or pd.isna(s1) or int(s0) != int(s1):
            continue
        lo, hi = int(yrs.loc[row["war_id"], "min"]), int(yrs.loc[row["war_id"], "max"])
        if lo >= int(s0) and hi <= int(s1):
            continue
        wars.at[i, "start_year"] = min(int(s0), lo)
        wars.at[i, "end_year"] = max(int(s1), hi)
        wars.at[i, "span_from_battles"] = True
        n += 1
    RUN_STATS["spans_widened_from_battles"] = n
    print(f"  War Atlas single-year placeholder spans widened to their battles: {n}")
    return wars


def derive_theaters(wars: pd.DataFrame, battles: pd.DataFrame) -> list[dict]:
    features = []
    by_war = battles.groupby("war_id")
    for war_id, g in by_war:
        pts = list(zip(g["lng"].astype(float), g["lat"].astype(float)))
        # unique rounded points
        uniq = sorted({(round(x, 4), round(y, 4)) for x, y in pts})
        # Pacific-spanning wars: build the hull in a continuous longitude range
        # instead of wrapping the polygon around the whole planet.
        if uniq:
            un_lngs = unwrap_lngs([x for x, _ in uniq])
            uniq = [(x2, y) for x2, (_x, y) in zip(un_lngs, uniq)]
        props_base = {
            "war_id": war_id,
            "point_count": len(uniq),
            "approximate": True,
        }
        if len(uniq) == 0:
            continue
        if len(uniq) == 1:
            lon, lat = uniq[0]
            r = _buffer_deg(75, lat)
            poly = Point(lon, lat).buffer(r, resolution=16)
            method = "buffer_merge"
            quality = "single_point_buffer"
        elif len(uniq) == 2:
            mp = MultiPoint(uniq)
            poly = mp.convex_hull.buffer(_buffer_deg(40, uniq[0][1]), resolution=12)
            method = "buffer_merge"
            quality = "sparse"
        else:
            mp = MultiPoint(uniq)
            try:
                if len(uniq) >= 5:
                    poly = concave_hull(mp, ratio=0.3)
                    method = "concave_hull"
                else:
                    poly = convex_hull(mp)
                    method = "convex_hull"
                if poly.is_empty or poly.geom_type == "Point":
                    poly = mp.convex_hull.buffer(_buffer_deg(40, uniq[0][1]))
                    method = "buffer_merge"
                quality = "ok" if len(uniq) >= 3 else "sparse"
            except Exception:
                poly = convex_hull(mp)
                method = "convex_hull"
                quality = "ok"

        if poly.geom_type == "Polygon":
            ring = list(poly.exterior.coords)
            features.append(
                polygon_feature(
                    ring,
                    {**props_base, "method": method, "quality_flag": quality},
                )
            )
        elif poly.geom_type == "MultiPolygon":
            for geom in poly.geoms:
                ring = list(geom.exterior.coords)
                features.append(
                    polygon_feature(
                        ring,
                        {**props_base, "method": method, "quality_flag": quality},
                    )
                )
    print(f"  Theater polygons: {len(features)}")
    return features


# ---------------------------------------------------------------------------
# 05 Export
# ---------------------------------------------------------------------------

def cow_midloc_centroids(midloc: pd.DataFrame) -> dict[float | int, tuple[float, float]]:
    """Map COW WarNum → mean MIDLOC lat/lng via dyadic war↔dispute link (centroid only)."""
    path = RAW / "cow" / "Dyadic-Interstate-War-Dataset" / "directed_dyadic_war.csv"
    if not path.exists():
        return {}
    dy = read_csv(path)
    if "warnum" not in dy.columns or "disno" not in dy.columns:
        return {}
    dy = dy[["warnum", "disno"]].dropna()
    dy["warnum"] = dy["warnum"].map(format_cow_warnum)
    dy["disno"] = pd.to_numeric(dy["disno"], errors="coerce")
    dy = dy.dropna()
    m = midloc.copy()
    m["dispnum"] = pd.to_numeric(m["dispnum"], errors="coerce")
    m = m.dropna(subset=["dispnum", "lat", "lng"])
    joined = dy.merge(m, left_on="disno", right_on="dispnum", how="inner")
    if joined.empty:
        return {}
    cents = joined.groupby("warnum").agg(lat=("lat", "mean"), lng=("lng", circular_mean_lng))
    out: dict[float | int, tuple[float, float]] = {}
    for warnum, r in cents.iterrows():
        key = format_cow_warnum(warnum)
        if key is None:
            continue
        out[key] = (float(r.lat), float(r.lng))
    print(f"  COW<-MIDLOC centroids: {len(out)}")
    return out


def _opt_int(v) -> int | None:
    if v is None or (isinstance(v, float) and pd.isna(v)) or v is pd.NA:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _opt_bool(v) -> bool:
    """True only for real truthy flags; NaN/None/pd.NA (non-COW rows) → False.

    Works for Python bools and numpy.bool_ alike (`x is True` fails for numpy).
    """
    if v is None or v is pd.NA or (isinstance(v, float) and pd.isna(v)):
        return False
    return bool(v)


def _opt_str(v) -> str | None:
    if v is None or (isinstance(v, float) and pd.isna(v)) or v is pd.NA:
        return None
    s = str(v)
    return s or None


def source_coverage(
    hced: pd.DataFrame,
    cow: pd.DataFrame,
    wa_wars: pd.DataFrame,
    wa_battles: pd.DataFrame,
    midloc: pd.DataFrame,
    ucdp_conflicts: pd.DataFrame,
) -> list[dict]:
    """Year span each source actually contributes (computed, not assumed).

    Trends near a boundary partly reflect which sources exist, not only real
    change in warfare — the About panel shows this table.
    """

    def span(series) -> tuple[int | None, int | None]:
        s = pd.to_numeric(series, errors="coerce").dropna()
        if s.empty:
            return None, None
        return int(s.min()), int(s.max())

    cow_formal = cow[cow["war_class"] != "intrastate"]
    cow_intra = cow[cow["war_class"] == "intrastate"]
    rows = [
        ("hced", "HCED v3 battles", span(hced["year"]), "Encyclopedia-derived battle list"),
        (
            "cow_formal",
            "COW inter-, extra-, non-state wars v4.0",
            (span(cow_formal["start_year"])[0], span(cow_formal["end_year"])[1]),
            "Formal war list (≥1,000 battle deaths)",
        ),
        (
            "cow_intra",
            "COW intra-state wars v5.1",
            (span(cow_intra["start_year"])[0], span(cow_intra["end_year"])[1]),
            "Civil, regional, intercommunal wars",
        ),
        ("war_atlas", "The War Atlas battles", span(wa_battles["year"]), "Curated from Wikidata/Wikipedia"),
        ("midloc", "MIDLOC v2.1", span(midloc["year"]), "Militarized disputes — not wars"),
        (
            "ucdp",
            "UCDP GED 26.1 (state-based events)",
            (span(ucdp_conflicts["start_year"])[0], span(ucdp_conflicts["end_year"])[1]),
            "Georeferenced events",
        ),
    ]
    return [{"id": i, "label": lbl, "from": a, "to": b, "note": note} for i, lbl, (a, b), note in rows]


def export_all(
    wars: pd.DataFrame,
    battles: pd.DataFrame,
    midloc: pd.DataFrame,
    theater_features: list[dict],
    links: pd.DataFrame,
    ucdp_totals: dict[str, dict],
    coverage: list[dict],
) -> None:
    # Aggregate battle counts onto wars
    counts = battles.groupby("war_id").size().to_dict()
    cents = battles.groupby("war_id").agg(lat=("lat", "mean"), lng=("lng", circular_mean_lng))
    midloc_by_warnum = cow_midloc_centroids(midloc)

    war_features = []
    wars_records = []
    for row in wars.itertuples():
        wid = row.war_id
        lat = cents.loc[wid, "lat"] if wid in cents.index else None
        lng = cents.loc[wid, "lng"] if wid in cents.index else None
        if lat is not None and (isinstance(lat, float) and pd.isna(lat)):
            lat, lng = None, None
        geo_source = "battles" if lat is not None else None
        if lat is None and hasattr(row, "ucdp_centroid_lat"):
            ulat = getattr(row, "ucdp_centroid_lat", None)
            ulng = getattr(row, "ucdp_centroid_lng", None)
            if ulat is not None and not (isinstance(ulat, float) and pd.isna(ulat)):
                lat, lng = ulat, ulng
                geo_source = "ucdp_centroid"
        cow_num = format_cow_warnum(getattr(row, "cow_warnum", None))
        if lat is None and cow_num is not None and cow_num in midloc_by_warnum:
            lat, lng = midloc_by_warnum[cow_num]
            geo_source = "midloc_dyadic"
        # Last resort: mean of known participant state centers (low confidence)
        if lat is None:
            from state_centers import participant_centroid

            pc = participant_centroid(getattr(row, "participant_summary", None))
            if pc is not None:
                lat, lng = pc
                geo_source = "participant_centroid"
        props = {
            "war_id": wid,
            "title": row.title,
            "start_year": None if pd.isna(row.start_year) else int(row.start_year),
            "end_year": None if pd.isna(row.end_year) else int(row.end_year),
            "era_bucket": era_bucket(None if pd.isna(row.start_year) else int(row.start_year)),
            "definition_tier": row.definition_tier,
            "war_class": row.war_class,
            "sources": row.sources,
            "cow_warnum": cow_num,
            "wa_slug": None if pd.isna(row.wa_slug) else row.wa_slug,
            "ucdp_conflict_id": None if pd.isna(row.ucdp_conflict_id) else str(row.ucdp_conflict_id),
            "wikidata_qid": None if pd.isna(row.wikidata_qid) else row.wikidata_qid,
            "participant_summary": None if pd.isna(row.participant_summary) else row.participant_summary,
            "death_estimate": None
            if pd.isna(row.death_estimate)
            else float(row.death_estimate),
            # cow_battle_deaths | ucdp_best_total — the two are not the same measure
            "death_source": _opt_str(getattr(row, "death_source", None)),
            "battle_count": int(counts.get(wid, 0)),
            # UCDP battle-related deaths over ALL linked events (not the map sample)
            "event_deaths": float(ucdp_totals[wid]["deaths_total"]) if wid in ucdp_totals else None,
            "ucdp_events_total": int(ucdp_totals[wid]["events_total"]) if wid in ucdp_totals else None,
            "ucdp_events_shown": int(ucdp_totals[wid]["events_shown"]) if wid in ucdp_totals else None,
            "ucdp_peak_year_deaths": _opt_int(getattr(row, "ucdp_peak_year_deaths", None)),
            "ucdp_war_years": _opt_int(getattr(row, "ucdp_war_years", None)),
            # COW code -7: still ongoing when the source dataset ends (end year is censored)
            "ongoing_at_source_end": _opt_bool(getattr(row, "ongoing_at_source_end", None)),
            # War Atlas placeholder span (start = end) widened to cover its own battles
            "span_from_battles": _opt_bool(getattr(row, "span_from_battles", None)),
            "geo_source": geo_source,
        }
        wars_records.append(props)
        if lat is not None and lng is not None and not (pd.isna(lat) or pd.isna(lng)):
            war_features.append(point_feature(float(lng), float(lat), props))
        else:
            war_features.append(
                {
                    "type": "Feature",
                    "geometry": None,
                    "properties": props,
                }
            )

    battle_features = [
        point_feature(
            float(r.lng),
            float(r.lat),
            {
                "event_id": r.event_id,
                "war_id": r.war_id,
                "source": r.source,
                "event_kind": r.event_kind,
                "name": r.name,
                "year": None if pd.isna(r.year) else int(r.year),
                "deaths_best": None if pd.isna(r.deaths_best) else int(r.deaths_best),
                "geo_precision": None if pd.isna(r.geo_precision) else str(r.geo_precision),
            },
        )
        for r in battles.itertuples()
    ]

    mid_features = [
        point_feature(
            float(r.lng),
            float(r.lat),
            {
                "event_id": r.event_id,
                "source": "midloc",
                "event_kind": r.event_kind,
                "name": r.name,
                "year": None if pd.isna(r.year) else int(r.year),
                "dispnum": int(r.dispnum) if pd.notna(r.dispnum) else None,
            },
        )
        for r in midloc.itertuples()
    ]

    # Client filters by year range from the wars list
    write_json(EXPORTS / "wars.json", wars_records)
    write_geojson(EXPORTS / "wars.geojson", war_features)
    write_geojson(EXPORTS / "battles.geojson", battle_features)
    write_geojson(EXPORTS / "theaters.geojson", theater_features)
    write_geojson(EXPORTS / "midloc.geojson", mid_features)

    citations = {
        "datasets": [
            {
                "id": "hced",
                "citation": "Miller, C., & Bakar, K. S. (2023). Conflict Events Worldwide Since 1468BC: Introducing the Historical Conflict Event Dataset. Journal of Conflict Resolution. Data: HCED v3.",
            },
            {
                "id": "cow",
                "citation": "Sarkees, M. R., & Wayman, F. W. (2010). Resort to War: 1816–2007. CQ Press. Correlates of War Project — Inter-State, Extra-State and Non-State War Data v4.0, and Directed Dyadic Inter-State War Data.",
            },
            {
                "id": "cow_intra",
                "citation": "Dixon, J. S., & Sarkees, M. R. (2016). A Guide to Intra-state Wars: An Examination of Civil, Regional, and Intercommunal Wars, 1816–2014. CQ Press. Correlates of War Project — Intra-State War Data v5.1.",
            },
            {
                "id": "ucdp",
                "citation": "Sundberg, R., & Melander, E. (2013). Introducing the UCDP Georeferenced Event Dataset. Journal of Peace Research, 50(4), 523–532. Data: UCDP Georeferenced Event Dataset (GED) Global version 26.1, Uppsala Conflict Data Program. CC BY 4.0.",
            },
            {
                "id": "war_atlas",
                "citation": "The War Atlas (2026). The War Atlas Open Dataset. https://thewaratlas.co/data — CC BY 4.0.",
            },
            {
                "id": "midloc",
                "citation": "Braithwaite, A. (2010). MIDLOC: Introducing the Militarized Interstate Dispute Location Dataset. Journal of Peace Research, 47(1), 91–98. Data: MIDLOC v2.1, Correlates of War Project.",
            },
        ]
    }
    write_json(EXPORTS / "citations.json", citations)

    # Review queues for the app (crosswalk quality)
    amb_path = REVIEW / "ambiguous_matches.csv"
    rej_path = REVIEW / "rejected_matches.csv"
    review_payload = {
        "ambiguous": [],
        "rejected": [],
        "accepted": [],
        "note": "Candidates that did not auto-merge. Prefer linking over inventing geography.",
    }
    decisions = load_crosswalk_decisions()
    accepted_pairs = {k for k, v in decisions.items() if v == "accepted"}
    if amb_path.exists():
        amb = pd.read_csv(amb_path).fillna("")
        # Drop pairs already accepted via decisions (no longer need review)
        if accepted_pairs:
            amb = amb[
                ~amb.apply(lambda r: (str(r.left_id), str(r.right_id)) in accepted_pairs, axis=1)
            ]
        review_payload["ambiguous"] = amb.to_dict(orient="records")
    if rej_path.exists():
        rej = pd.read_csv(rej_path).fillna("")
        review_payload["rejected"] = rej.to_dict(orient="records")
    if (REVIEW / "crosswalk_decisions.json").exists():
        try:
            dec = json.loads((REVIEW / "crosswalk_decisions.json").read_text(encoding="utf-8"))
            review_payload["accepted"] = [
                d for d in dec.get("decisions", []) if d.get("status") == "accepted"
            ]
        except (OSError, json.JSONDecodeError):
            pass

    # Coverage honesty by definition tier
    from collections import Counter

    tier_cov: dict[str, dict[str, int]] = {}
    for p in wars_records:
        t = str(p.get("definition_tier") or "unknown")
        bucket = tier_cov.setdefault(t, {"total": 0, "battles": 0, "proxy": 0, "unmapped": 0})
        bucket["total"] += 1
        bc = int(p.get("battle_count") or 0)
        gs = p.get("geo_source")
        if bc > 0:
            bucket["battles"] += 1
        elif gs:
            bucket["proxy"] += 1
        else:
            bucket["unmapped"] += 1
    geo_source_counts = Counter(p.get("geo_source") for p in wars_records)

    # Copy key exports into app/public/data for Vite
    import shutil

    APP_PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    # Only files the Vite SPA fetches — research exports stay under data/processed
    for name in [
        "wars.json",
        "wars.geojson",
        "battles.geojson",
        "theaters.geojson",
        "midloc.geojson",
        "citations.json",
    ]:
        src = EXPORTS / name
        if src.exists():
            shutil.copy2(src, APP_PUBLIC_DATA / name)
    # Remove formerly shipped unused public copies if present
    for stale in (
        "ucdp_summary.geojson",
        "crosswalks.csv",
        "crosswalk_review.json",
    ):
        stale_path = APP_PUBLIC_DATA / stale
        if stale_path.exists():
            stale_path.unlink()
    dest_shards = APP_PUBLIC_DATA / "events" / "by_war"
    if dest_shards.exists():
        shutil.rmtree(dest_shards)
    events_dir = APP_PUBLIC_DATA / "events"
    if events_dir.exists() and not any(events_dir.iterdir()):
        events_dir.rmdir()
    # Drop research-only exports left by older ETL runs
    for stale_export in ("ucdp_summary.geojson", "crosswalk_review.json", "crosswalks.csv"):
        p = EXPORTS / stale_export
        if p.exists():
            p.unlink()
    events_exports = EXPORTS / "events"
    if events_exports.exists():
        shutil.rmtree(events_exports)

    # Catalog meta (SPA) — no duplicate qa/summary.json
    qa = {
        "wars_total": len(wars_records),
        "wars_with_geo": sum(1 for f in war_features if f["geometry"]),
        "wars_with_battles": sum(1 for p in wars_records if int(p.get("battle_count") or 0) > 0),
        "wars_proxy_only": sum(
            1
            for p in wars_records
            if int(p.get("battle_count") or 0) == 0 and p.get("geo_source")
        ),
        "wars_unmapped": sum(
            1 for p in wars_records if int(p.get("battle_count") or 0) == 0 and not p.get("geo_source")
        ),
        "battles_total": len(battle_features),
        "theaters_total": len(theater_features),
        "midloc_total": len(mid_features),
        "crosswalks_total": len(links),
        "crosswalk_ambiguous": len(review_payload["ambiguous"]),
        "crosswalk_rejected": len(review_payload["rejected"]),
        "crosswalk_accepted_decisions": len(accepted_pairs),
        "definition_tiers": wars["definition_tier"].value_counts().to_dict(),
        "tier_coverage": tier_cov,
        "geo_source_counts": {str(k): int(v) for k, v in geo_source_counts.items()},
        "year_min": int(pd.Series([p["start_year"] for p in wars_records if p["start_year"] is not None]).min()),
        "year_max": int(pd.Series([p["end_year"] for p in wars_records if p["end_year"] is not None]).max()),
        "ucdp_war_rule": f"≥{UCDP_WAR_THRESHOLD:,} battle-related deaths in at least one calendar year",
        "ucdp_event_cap": RUN_STATS.get("ucdp_event_cap"),
        "ucdp_events_shown": int((battles["source"] == "ucdp").sum()),
        "ucdp_events_linked_total": int(sum(t["events_total"] for t in ucdp_totals.values())),
        "ucdp_cumulative_only_excluded": RUN_STATS.get("ucdp_cumulative_only_excluded"),
        "source_corrections_applied": RUN_STATS.get("source_corrections_applied", 0),
        "spans_widened_from_battles": RUN_STATS.get("spans_widened_from_battles", 0),
        "theaters_antimeridian": sum(
            1
            for f in theater_features
            if any(abs(pt[0]) > 180 for pt in f["geometry"]["coordinates"][0])
        ),
        "source_coverage": coverage,
        # SHA-256 of every input + software versions (verifiable build record)
        "build_provenance": build_provenance(),
    }
    write_json(EXPORTS / "catalog_meta.json", qa)
    hist = append_progress_snapshot(qa)
    shutil.copy2(EXPORTS / "catalog_meta.json", APP_PUBLIC_DATA / "catalog_meta.json")
    shutil.copy2(hist, APP_PUBLIC_DATA / "progress_history.json")
    print("  QA:", {k: qa[k] for k in ("wars_total", "wars_with_battles", "wars_proxy_only", "wars_unmapped", "crosswalk_ambiguous", "crosswalk_accepted_decisions")})
    cow = (qa.get("tier_coverage") or {}).get("cow_war") or {}
    if cow.get("total"):
        print(
            f"  COW progress: {cow.get('battles', 0)}/{cow['total']} with battles "
            f"({100.0 * cow.get('battles', 0) / cow['total']:.1f}%), "
            f"{cow.get('unmapped', 0)} unmapped"
        )


def main() -> None:
    ensure_dirs()
    print("01 Ingest / normalize...")
    hced = ingest_hced()
    wa_wars, wa_battles = ingest_war_atlas()
    cow = ingest_cow()
    midloc = ingest_midloc()
    ucdp_conflicts, ucdp_events = ingest_ucdp()

    print("02 Canonical wars + crosswalk...")
    wars, links, _amb, hced_clusters = build_canonical_wars(cow, wa_wars, hced, ucdp_conflicts)
    # Every crosswalk link (auto, accepted, rejected, needs_review) with titles + years,
    # so merge accuracy can be audited (scripts/audit_crosswalk.py).
    links.sort_values(["review_status", "left_id", "right_id"]).to_csv(
        REVIEW / "crosswalk_links.csv", index=False
    )

    print("03 Attach battles/events...")
    battles, ucdp_totals = attach_battles(
        wars, hced, wa_battles, ucdp_events, links, hced_clusters, ucdp_conflicts
    )

    wars = widen_placeholder_spans(wars, battles)

    print("04 Derive theaters...")
    theaters = derive_theaters(wars, battles)

    print("05 Export GeoJSON + app public data...")
    coverage = source_coverage(hced, cow, wa_wars, wa_battles, midloc, ucdp_conflicts)
    export_all(wars, battles, midloc, theaters, links, ucdp_totals, coverage)

    print("06 Validate exports...")
    from validate_exports import main as validate_main

    status = validate_main()
    if status != 0:
        raise SystemExit(status)
    print("Done.")


if __name__ == "__main__":
    main()
