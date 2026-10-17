"""
Propose and apply human/safe crosswalk decisions for ambiguous matches.

Decisions file: data/processed/review/crosswalk_decisions.json
ETL reads this and treats status=accepted like auto-merges (so battles attach to COW).

Usage:
  python scripts/review_crosswalks.py propose   # write/update safe accepts
  python scripts/review_crosswalks.py status    # summarize
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
REVIEW = ROOT / "data" / "processed" / "review"
PUBLIC = ROOT / "app" / "public" / "data"
DECISIONS = REVIEW / "crosswalk_decisions.json"

ORDINAL_CANON = {
    "first": "first",
    "1st": "first",
    "second": "second",
    "2nd": "second",
    "third": "third",
    "3rd": "third",
    "fourth": "fourth",
    "4th": "fourth",
    "fifth": "fifth",
    "5th": "fifth",
    "ninth": "ninth",
    "9th": "ninth",
}
STOP = {"war", "wars", "of", "the", "and", "a", "an", "phase"}

# Hard false friends that fuzzy scores can still "pass"
BLOCKLIST = {
    ("wa:civil_war", "cow:1550"),  # American Civil War ≠ Central American War
    ("wa:ninth_russo_turkish_war", "cow:4"),  # Ninth ≠ First
}


def _tok(title: str) -> set[str]:
    s = re.sub(r"[^a-z0-9\s]", " ", str(title).lower())
    return {t for t in s.split() if t and t not in STOP and len(t) > 2 and t not in ORDINAL_CANON}


def _ords(title: str) -> set[str]:
    raw = set(re.findall(r"[a-z0-9]+", str(title).lower()))
    return {ORDINAL_CANON[t] for t in raw if t in ORDINAL_CANON}


def _plural_wars(title: str) -> bool:
    return "wars" in set(re.findall(r"[a-z0-9]+", str(title).lower()))


def load_decisions() -> dict:
    if not DECISIONS.exists():
        return {"version": 1, "updated_at": None, "decisions": []}
    return json.loads(DECISIONS.read_text(encoding="utf-8"))


def save_decisions(payload: dict) -> None:
    REVIEW.mkdir(parents=True, exist_ok=True)
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    DECISIONS.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def decision_index(payload: dict) -> dict[tuple[str, str], dict]:
    out = {}
    for d in payload.get("decisions", []):
        out[(str(d["left_id"]), str(d["right_id"]))] = d
    return out


def _is_safe_pair(
    *,
    left_id: str,
    right_id: str,
    left_title: str,
    right_title: str,
    conf: float,
    reason: str,
    lb: int,
    rb: int,
) -> tuple[bool, str]:
    """Return (ok, decided_by). Conservative: prefer empty COW targets."""
    if (left_id, right_id) in BLOCKLIST:
        return False, ""
    if lb <= 0:
        return False, ""
    if not right_id.startswith("cow:"):
        return False, ""

    ta, tb = _tok(left_title), _tok(right_title)
    if not (ta & tb):
        return False, ""

    lo, ro = _ords(left_title), _ords(right_title)
    if lo and ro and not (lo & ro):
        return False, ""
    # Bare name → ordinaled COW is often a phase mismatch
    if (not lo) and ro and conf < 0.84:
        return False, ""
    if _plural_wars(left_title) and (ro or not _plural_wars(right_title)) and conf < 0.90:
        return False, ""

    only_a, only_b = ta - tb, tb - ta
    subset = ta <= tb or tb <= ta

    # Prefer linking into empty COW; allow high-conf WA merge onto already-mapped COW
    if reason == "wa_to_cow" and rb > 0 and conf < 0.90:
        return False, ""
    # Don't dump a whole Atlas war onto a single COW "Phase N" slice
    if re.search(r"\bphase\b", right_title, re.I) and not re.search(r"\bphase\b", left_title, re.I):
        if conf < 0.92:
            return False, ""

    # v1: high confidence
    if conf >= 0.84:
        if only_a and only_b and conf < 0.88 and not subset:
            return False, ""
        return True, "auto_safe_v1"

    # v2: near-exact names, lower score but strong token overlap
    if conf >= 0.71:
        if not subset and only_a and only_b:
            return False, ""
        # Require most of the smaller title's tokens to match
        smaller, larger = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
        if not smaller or len(smaller & larger) < max(1, len(smaller) - 1):
            return False, ""
        # Prefer empty COW for v2
        if rb > 0:
            return False, ""
        return True, "auto_safe_v2"

    return False, ""


def propose_safe_accepts() -> list[dict]:
    amb_path = REVIEW / "ambiguous_matches.csv"
    if not amb_path.exists():
        raise SystemExit(f"Missing {amb_path} — run ETL first")
    amb = pd.read_csv(amb_path)
    wars_path = PUBLIC / "wars.json"
    if not wars_path.exists():
        wars_path = ROOT / "data" / "processed" / "exports" / "wars.json"
    wars = json.loads(wars_path.read_text(encoding="utf-8"))
    by_id = {w["war_id"]: w for w in wars}

    proposed: list[dict] = []
    for row in amb.itertuples():
        left_id = str(row.left_id)
        right_id = str(row.right_id)
        left = by_id.get(left_id)
        right = by_id.get(right_id)
        if not left or not right:
            continue
        conf = float(row.confidence)
        lb = int(left.get("battle_count") or 0)
        rb = int(right.get("battle_count") or 0)
        ok, decided_by = _is_safe_pair(
            left_id=left_id,
            right_id=right_id,
            left_title=str(row.left_title),
            right_title=str(row.right_title),
            conf=conf,
            reason=str(row.reason),
            lb=lb,
            rb=rb,
        )
        if not ok:
            continue
        proposed.append(
            {
                "left_id": left_id,
                "right_id": right_id,
                "left_title": str(row.left_title),
                "right_title": str(row.right_title),
                "confidence": round(conf, 3),
                "match_reason": str(row.reason),
                "status": "accepted",
                "decided_by": decided_by,
                "notes": f"safe accept: left_battles={lb} right_battles={rb}",
                "left_battles": lb,
                "right_battles": rb,
            }
        )
    return proposed


def cmd_propose() -> None:
    payload = load_decisions()
    idx = decision_index(payload)
    proposed = propose_safe_accepts()
    added = 0
    updated = 0
    for p in proposed:
        key = (p["left_id"], p["right_id"])
        if key in idx:
            prev = idx[key]
            if prev.get("status") == "rejected":
                continue  # never override human reject
            if prev.get("status") == "accepted" and prev.get("decided_by", "").startswith("human"):
                continue
            # refresh metadata but keep accepted
            prev.update({k: v for k, v in p.items() if k != "status"})
            prev["status"] = "accepted"
            updated += 1
        else:
            payload["decisions"].append(p)
            added += 1
    save_decisions(payload)
    accepts = [d for d in payload["decisions"] if d.get("status") == "accepted"]
    print(f"Proposed safe accepts: {len(proposed)}")
    print(f"Decisions file: +{added} new, {updated} refreshed")
    print(f"Total accepted decisions: {len(accepts)}")
    print(f"Wrote {DECISIONS}")


def cmd_status() -> None:
    payload = load_decisions()
    decisions = payload.get("decisions", [])
    by = {}
    for d in decisions:
        by[d.get("status", "?")] = by.get(d.get("status", "?"), 0) + 1
    print(f"Decisions: {len(decisions)}  {by}")
    print(f"Updated: {payload.get('updated_at')}")
    accepts = [d for d in decisions if d.get("status") == "accepted"]
    battles = sum(int(d.get("left_battles") or 0) for d in accepts)
    print(f"Accepted links: {len(accepts)} (~{battles} battle rows on left side before merge)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["propose", "status"])
    args = ap.parse_args()
    if args.command == "propose":
        cmd_propose()
    else:
        cmd_status()


if __name__ == "__main__":
    main()
