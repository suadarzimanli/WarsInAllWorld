"""Approximate capital / political-center coordinates for common COW state names.

Used only as a last-resort war location when no battles / MIDLOC / UCDP centroid exist.
Always exported as geo_source=participant_centroid (low confidence).
"""
from __future__ import annotations

import re

# Rough political centers (lat, lng). Not borders — only for weak map pins.
STATE_CENTERS: dict[str, tuple[float, float]] = {
    "united states of america": (38.9, -77.0),
    "united states": (38.9, -77.0),
    "usa": (38.9, -77.0),
    "united kingdom": (51.5, -0.1),
    "england": (51.5, -0.1),
    "france": (48.9, 2.3),
    "germany": (52.5, 13.4),
    "prussia": (52.5, 13.4),
    "austria": (48.2, 16.4),
    "austria-hungary": (48.2, 16.4),
    "hungary": (47.5, 19.0),
    "italy": (41.9, 12.5),
    "spain": (40.4, -3.7),
    "portugal": (38.7, -9.1),
    "netherlands": (52.4, 4.9),
    "belgium": (50.8, 4.4),
    "switzerland": (46.9, 7.4),
    "sweden": (59.3, 18.1),
    "norway": (59.9, 10.7),
    "denmark": (55.7, 12.6),
    "russia": (55.8, 37.6),
    "soviet union": (55.8, 37.6),
    "ussr": (55.8, 37.6),
    "poland": (52.2, 21.0),
    "czechoslovakia": (50.1, 14.4),
    "czech republic": (50.1, 14.4),
    "slovakia": (48.1, 17.1),
    "romania": (44.4, 26.1),
    "bulgaria": (42.7, 23.3),
    "greece": (37.9, 23.7),
    "turkey": (39.9, 32.9),
    "ottoman empire": (41.0, 29.0),
    "yugoslavia": (44.8, 20.5),
    "serbia": (44.8, 20.5),
    "croatia": (45.8, 15.9),
    "bosnia": (43.9, 18.4),
    "albania": (41.3, 19.8),
    "ukraine": (50.5, 30.5),
    "finland": (60.2, 24.9),
    "ireland": (53.3, -6.3),
    "china": (39.9, 116.4),
    "japan": (35.7, 139.7),
    "korea": (37.6, 127.0),
    "north korea": (39.0, 125.8),
    "south korea": (37.6, 127.0),
    "vietnam": (21.0, 105.8),
    "north vietnam": (21.0, 105.8),
    "south vietnam": (10.8, 106.7),
    "india": (28.6, 77.2),
    "pakistan": (33.7, 73.1),
    "bangladesh": (23.8, 90.4),
    "afghanistan": (34.5, 69.2),
    "iran": (35.7, 51.4),
    "iraq": (33.3, 44.4),
    "syria": (33.5, 36.3),
    "lebanon": (33.9, 35.5),
    "israel": (31.8, 35.2),
    "egypt": (30.0, 31.2),
    "libya": (32.9, 13.2),
    "tunisia": (36.8, 10.2),
    "algeria": (36.8, 3.1),
    "morocco": (34.0, -6.8),
    "sudan": (15.5, 32.5),
    "ethiopia": (9.0, 38.7),
    "somalia": (2.0, 45.3),
    "kenya": (-1.3, 36.8),
    "uganda": (0.3, 32.6),
    "tanzania": (-6.2, 35.7),
    "congo": (-4.3, 15.3),
    "democratic republic of the congo": (-4.3, 15.3),
    "zaire": (-4.3, 15.3),
    "angola": (-8.8, 13.2),
    "mozambique": (-25.9, 32.6),
    "south africa": (-25.7, 28.2),
    "nigeria": (9.1, 7.5),
    "ghana": (5.6, -0.2),
    "mexico": (19.4, -99.1),
    "canada": (45.4, -75.7),
    "cuba": (23.1, -82.4),
    "brazil": (-15.8, -47.9),
    "argentina": (-34.6, -58.4),
    "chile": (-33.4, -70.7),
    "peru": (-12.0, -77.0),
    "colombia": (4.7, -74.1),
    "venezuela": (10.5, -66.9),
    "bolivia": (-16.5, -68.1),
    "paraguay": (-25.3, -57.6),
    "uruguay": (-34.9, -56.2),
    "australia": (-35.3, 149.1),
    "new zealand": (-41.3, 174.8),
    "indonesia": (-6.2, 106.8),
    "philippines": (14.6, 121.0),
    "thailand": (13.8, 100.5),
    "burma": (16.8, 96.2),
    "myanmar": (16.8, 96.2),
    "cambodia": (11.6, 104.9),
    "laos": (17.9, 102.6),
    "malaysia": (3.1, 101.7),
    "singapore": (1.3, 103.8),
}


def _norm_state(name: str) -> str:
    s = str(name).lower().strip()
    s = re.sub(r"\s*\(.*?\)\s*", " ", s)
    s = re.sub(r"[^\w\s\-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def participant_centroid(participant_summary: str | None) -> tuple[float, float] | None:
    """Mean of known participant state centers, or None if nothing matches."""
    if not participant_summary or not str(participant_summary).strip():
        return None
    parts = re.split(r"[;|/]+", str(participant_summary))
    pts: list[tuple[float, float]] = []
    for raw in parts:
        key = _norm_state(raw)
        if not key:
            continue
        if key in STATE_CENTERS:
            pts.append(STATE_CENTERS[key])
            continue
        # Soft contains match for longer names
        for k, xy in STATE_CENTERS.items():
            if k in key or key in k:
                pts.append(xy)
                break
    if not pts:
        return None
    lat = sum(p[0] for p in pts) / len(pts)
    lng = sum(p[1] for p in pts) / len(pts)
    return (lat, lng)
