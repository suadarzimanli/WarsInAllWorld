"""
Audit the accuracy of cross-dataset war merges.

The ETL merges the same war across sources (e.g. HCED "1st Italian War of
Independence" → War Atlas "First Italian War of Independence") by fuzzy name +
year matching, plus "safe accepts" proposed by review_crosswalks.py. This tool
lets a human check every machine merge and reports precision.

Usage (from repo root, after run_etl.py has written review/crosswalk_links.csv):
  python scripts/audit_crosswalk.py export   # create/refresh review/merge_audit.csv
  python scripts/audit_crosswalk.py score    # precision + 95% CI → qa/merge_audit_summary.json

Fill the `verdict` column in merge_audit.csv with:
  correct   — same war (or the left record is clearly a phase/part of the right war)
  wrong     — different wars merged by mistake
  unsure    — cannot decide from the record; excluded from precision
Existing verdicts are preserved when you re-export.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pandas as pd  # noqa: E402

from common import QA, REVIEW  # noqa: E402

LINKS = REVIEW / "crosswalk_links.csv"
AUDIT = REVIEW / "merge_audit.csv"
SUMMARY = QA / "merge_audit_summary.json"
AUDIT_COLS = [
    "left_id",
    "right_id",
    "left_title",
    "left_start",
    "left_end",
    "right_title",
    "right_start",
    "right_end",
    "match_method",
    "confidence",
    "review_status",
    "verdict",
    "reviewer",
    "note",
]
VERDICTS = {"correct", "wrong", "unsure"}


def wilson_interval(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson score interval for a proportion k/n (well-behaved near 0 and 1)."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def cmd_export() -> None:
    links = pd.read_csv(LINKS)
    merged = links[links["review_status"].isin(["auto", "accepted"])].copy()
    merged = merged[merged["match_method"] != "phase_year_split"]  # hand-coded rule, not a match
    for c in AUDIT_COLS:
        if c not in merged.columns:
            merged[c] = ""
    merged = merged[AUDIT_COLS]
    if AUDIT.exists():
        old = pd.read_csv(AUDIT, dtype=str).fillna("")
        keep = old.set_index(["left_id", "right_id"])[["verdict", "reviewer", "note"]]
        merged = merged.drop(columns=["verdict", "reviewer", "note"]).join(
            keep, on=["left_id", "right_id"]
        )
        merged[["verdict", "reviewer", "note"]] = merged[["verdict", "reviewer", "note"]].fillna("")
        # Keep judged merges that the pipeline no longer makes (e.g. a wrong merge
        # fixed after the audit) so the measured precision stays an honest record
        # of the pipeline as audited, not silently improved by deleting errors.
        current = set(zip(merged["left_id"].astype(str), merged["right_id"].astype(str)))
        not_current = pd.Series(
            [(a, b) not in current for a, b in zip(old["left_id"], old["right_id"])], index=old.index
        )
        gone = old[not_current & (old["verdict"].str.strip() != "")].copy()
        if len(gone):
            gone["review_status"] = "removed_after_audit"
            merged = pd.concat([merged, gone[AUDIT_COLS]], ignore_index=True)
    merged = merged.sort_values(["match_method", "left_id"])
    merged.to_csv(AUDIT, index=False)
    done = (merged["verdict"].astype(str).str.strip() != "").sum()
    print(f"Wrote {AUDIT.relative_to(REVIEW.parents[2])}: {len(merged)} merges, {done} already judged")


def cmd_score() -> int:
    df = pd.read_csv(AUDIT, dtype=str).fillna("")
    df["verdict"] = df["verdict"].str.strip().str.lower()
    bad = sorted(set(df["verdict"]) - VERDICTS - {""})
    if bad:
        print(f"Unknown verdicts: {bad} (use correct / wrong / unsure)")
        return 1

    def block(sub: pd.DataFrame) -> dict:
        judged = sub[sub["verdict"].isin(["correct", "wrong"])]
        k, n = int((judged["verdict"] == "correct").sum()), len(judged)
        lo, hi = wilson_interval(k, n)
        return {
            "merges": int(len(sub)),
            "judged": n,
            "correct": k,
            "wrong": int(n - k),
            "unsure": int((sub["verdict"] == "unsure").sum()),
            "unjudged": int((sub["verdict"] == "").sum()),
            "precision": round(k / n, 4) if n else None,
            "ci95": [round(lo, 4), round(hi, 4)] if n else None,
        }

    reviewers = sorted(r for r in set(df["reviewer"]) if r)
    summary = {
        "what": "Precision of machine merges between source war lists (share of judged merges that join the same war).",
        "reviewers": reviewers,
        "overall": block(df),
        "by_method": {m: block(g) for m, g in df.groupby("match_method")},
        "wrong_merges": df[df["verdict"] == "wrong"][
            ["left_id", "left_title", "right_id", "right_title", "note"]
        ].to_dict(orient="records"),
    }
    QA.mkdir(parents=True, exist_ok=True)
    SUMMARY.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    o = summary["overall"]
    if o["judged"]:
        print(
            f"Precision {o['precision']:.1%} ({o['correct']}/{o['judged']}), "
            f"95% CI {o['ci95'][0]:.1%}–{o['ci95'][1]:.1%}; unsure {o['unsure']}, unjudged {o['unjudged']}"
        )
    else:
        print("No verdicts yet — fill the `verdict` column in merge_audit.csv")
    for m, b in summary["by_method"].items():
        if b["judged"]:
            print(f"  {m}: {b['precision']:.1%} ({b['correct']}/{b['judged']})")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["export", "score"])
    args = ap.parse_args()
    if args.command == "export":
        cmd_export()
    else:
        raise SystemExit(cmd_score())


if __name__ == "__main__":
    main()
