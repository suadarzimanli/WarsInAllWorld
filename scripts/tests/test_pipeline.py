"""Unit tests for ETL helpers. Run from the repo root:

    python -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd  # noqa: E402

from common import (  # noqa: E402
    build_provenance,
    sha256_file,
    circular_mean_lng,
    cluster_years_by_gap,
    cow_end_year,
    parse_year,
    point_feature,
    polygon_feature,
    resolve_cluster,
    ucdp_yearly_war_stats,
    unwrap_lngs,
    year_span_label,
)


class ParseYear(unittest.TestCase):
    def test_plain_and_range(self):
        self.assertEqual(parse_year("1944"), 1944)
        self.assertEqual(parse_year("1941-1942"), 1941)
        self.assertEqual(parse_year("-220"), -220)

    def test_missing(self):
        for v in (None, "", "NA", "nan", "-8", "-9"):
            self.assertIsNone(parse_year(v))


class CowEndYear(unittest.TestCase):
    def test_ongoing_code_is_censored_not_7_bce(self):
        # COW -7 = still ongoing at dataset end; must never become year -7.
        self.assertEqual(cow_end_year([2001, -7], 2007), (2007, True))

    def test_normal_end_and_missing_codes(self):
        self.assertEqual(cow_end_year([1999, 2003, -8, -9], 2007), (2003, False))
        self.assertEqual(cow_end_year([-9], 2007), (None, False))


class ResolveCluster(unittest.TestCase):
    def test_regression_merged_cluster_keeps_its_battles(self):
        # HCED "World War II": a one-battle 1835 cluster (source typo) and the
        # real 1939–45 cluster, which was merged into COW's WWII (cow:139).
        clusters = [(1835, 1835, "hced:world_war_ii:1835_1835"), (1939, 1945, "hced:world_war_ii:1939_1945")]
        merge_map = {"hced:world_war_ii:1939_1945": "cow:139"}
        self.assertEqual(resolve_cluster(clusters, 1944, merge_map), "cow:139")
        self.assertEqual(resolve_cluster(clusters, 1835, merge_map), "hced:world_war_ii:1835_1835")

    def test_nearest_cluster_for_out_of_range_year(self):
        clusters = [(100, 120, "a"), (500, 520, "b")]
        self.assertEqual(resolve_cluster(clusters, 130, {}), "a")
        self.assertEqual(resolve_cluster(clusters, 480, {}), "b")

    def test_empty(self):
        self.assertIsNone(resolve_cluster([], 1900, {}))


class Clusters(unittest.TestCase):
    def test_gap_split(self):
        self.assertEqual(cluster_years_by_gap([1835, 1939, 1944, 1945], 15), [(1835, 1835), (1939, 1945)])


class Longitudes(unittest.TestCase):
    def test_circular_mean_across_antimeridian(self):
        m = circular_mean_lng([179.0, -179.0])
        self.assertAlmostEqual(abs(m), 180.0, places=6)

    def test_circular_mean_ordinary(self):
        self.assertAlmostEqual(circular_mean_lng([10.0, 20.0]), 15.0, places=6)
        self.assertIsNone(circular_mean_lng([]))

    def test_unwrap_only_when_straddling(self):
        self.assertEqual(unwrap_lngs([10.0, 20.0]), [10.0, 20.0])
        self.assertEqual(unwrap_lngs([-120.0, -60.0, 30.0]), [-120.0, -60.0, 30.0])
        self.assertEqual(unwrap_lngs([170.0, -170.0]), [170.0, 190.0])

    def test_unwrap_recentres_on_main_world_copy(self):
        # Spanish-American War: Caribbean + Philippines/Guam
        out = unwrap_lngs([-82.0, -65.0, 120.0, 145.0])
        self.assertEqual(out, [-82.0, -65.0, -240.0, -215.0])
        mid = (min(out) + max(out)) / 2
        self.assertTrue(-180 <= mid <= 180)

    def test_unwrap_cuts_at_largest_gap(self):
        def span(xs):
            return max(xs) - min(xs)

        # Pacific + Europe: naive span 350°, shortest arc 195°
        out = unwrap_lngs([-10.0, 10.0, 175.0, -175.0])
        self.assertAlmostEqual(span(out), 195.0)
        # Result is always the same points modulo 360
        for a, b in zip([-10.0, 10.0, 175.0, -175.0], out):
            self.assertAlmostEqual((a - b) % 360, 0.0)


class UcdpWarRule(unittest.TestCase):
    def test_per_calendar_year_not_cumulative(self):
        ev = pd.DataFrame(
            {
                "conflict_new_id": ["low"] * 5 + ["war", "war"],
                "year": [2001, 2002, 2003, 2004, 2005, 2010, 2010],
                "best": [300, 300, 300, 300, 300, 600, 600],
            }
        )
        stats = ucdp_yearly_war_stats(ev)
        # 1,500 deaths over five years is NOT a war under UCDP's definition
        self.assertFalse(stats.loc["low", "warlike"])
        self.assertEqual(stats.loc["low", "war_years"], 0)
        # 1,200 deaths in one calendar year is
        self.assertTrue(stats.loc["war", "warlike"])
        self.assertEqual(stats.loc["war", "peak_year_deaths"], 1200)


class YearSpanLabel(unittest.TestCase):
    def test_labels(self):
        self.assertEqual(year_span_label(1835, 1835), "1835")
        self.assertEqual(year_span_label(1939, 1945), "1939–1945")
        self.assertEqual(year_span_label(-1045, -1045), "1045 BCE")
        self.assertEqual(year_span_label(-220, -200), "220–200 BCE")
        self.assertEqual(year_span_label(-30, 14), "30 BCE–14")


class Provenance(unittest.TestCase):
    def test_sha256_and_missing_files(self):
        import hashlib
        import tempfile

        from common import ROOT

        with tempfile.NamedTemporaryFile(dir=ROOT, delete=False, suffix=".tmp") as tmp:
            tmp.write(b"wars!")
        p = Path(tmp.name)
        try:
            self.assertEqual(sha256_file(p), hashlib.sha256(b"wars!").hexdigest())
            rec = build_provenance([p, ROOT / "does-not-exist.csv"])
            self.assertEqual(rec["inputs"][0]["bytes"], 5)
            self.assertTrue(rec["inputs"][1]["missing"])
            self.assertIn("pandas", rec["software"])
        finally:
            p.unlink()


class Features(unittest.TestCase):
    def test_coordinates_rounded(self):
        f = point_feature(6.083886812345, 50.775345512345, {})
        self.assertEqual(f["geometry"]["coordinates"], [6.08389, 50.77535])
        p = polygon_feature([(0.123456789, 1.0), (1.0, 1.0), (0.0, 0.0)], {})
        self.assertEqual(p["geometry"]["coordinates"][0][0], [0.12346, 1.0])


if __name__ == "__main__":
    unittest.main()
