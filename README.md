# Wars In All World

Interactive **research atlas** of recorded wars: timeline filters, battle and theater geography on **Map** and **Globe**, and a **Numbers** page that shows how counting and era windows change the story.

The application is a browser over **geocoded records we ingested** from public conflict datasets—not a complete history of all wars, and not proof that any region “had the most war.”

**Research / educational project** — missing battle geography usually means **no battle layer in the sources**, not a code bug. Third-party datasets keep their own licenses and citation requirements (see in-app About and `app/public/data/citations.json`).

---

## Live application

**https://suadarzimanli.github.io/WarsInAllWorld/**

| Route | What |
|--|--|
| `/map` | Leaflet map — points, theaters, heat |
| `/globe` | 3D Cesium globe |
| `/insights` | Numbers — catalog digest, era filter, open on map |

---

## Run locally

```bash
git clone https://github.com/suadarzimanli/WarsInAllWorld.git
cd WarsInAllWorld/app
npm install
npm run dev
```

Open the URL Vite prints (usually **http://localhost:5173**).

Catalog files under `app/public/data/` are already included for the web app. You do **not** need Python to explore the atlas.

From `app/`: `npm test` (Vitest), `npm run lint`, `npm run build`, `npm run preview`.

### Optional — regenerate catalog data

```bash
# From repo root. Requires GEDEvent_v26_1.csv under data/raw/ucdp/ged261/
# (not in git; ~261 MB — over GitHub’s file limit). Keep it locally for ETL only.
pip install -r requirements.txt   # pinned versions
python scripts/run_etl.py
```

Optional crosswalk review: `python scripts/review_crosswalks.py propose`, then re-run ETL.

---

## Data and methods (summary)

- **Sources:** HCED v3, Correlates of War (inter-, extra-, non-state v4.0; intra-state v5.1; MIDLOC v2.1), The War Atlas, UCDP GED 26.1 (state-based violence)
- **ETL** merges wars across sources (fuzzy name + year crosswalk, with a human-reviewed decision file), attaches battles/events, derives approximate theaters, writes GeoJSON/JSON packs
- **What counts as a war differs by source** — COW: ≥1,000 battle deaths; UCDP: ≥1,000 battle-related deaths **in at least one calendar year**; HCED/Atlas: named wars with no threshold. The *definition* filter keeps comparisons like-for-like
- **Coverage honesty:** battles vs proxy centroid vs unmapped, with tier breakdowns in Filters / Numbers; the About panel lists the year span each source actually covers
- **UCDP sample:** at most 400 events per conflict ship to the browser (deadliest first); death totals and event counts in each war's detail use *all* events
- **COW ongoing wars:** the source code `-7` ("still ongoing when the dataset ends") becomes the dataset's last year with an `ongoing_at_source_end` flag — never "7 BCE"
- **Antimeridian-safe:** war centroids use a circular mean; Pacific-spanning theater outlines are built on one continuous longitude range
- **Filters:** year range (including open ends / all years), definition mode, spatial coverage, search
- **Display:** point layers or equal-area **heat** (Relative within filters vs Absolute vs catalog peak at zoom)
- **Deep links:** war selection, era handoff from Numbers, optional `?lat=&lng=` focus fly-to

## Data quality and validation

- **Source corrections** — clear errors in individual raw records (a WWII battle dated 1835, Königgrätz labelled "Seven Years War", Syracuse geocoded to New York, …) are fixed at build time from [`data/processed/review/source_corrections.json`](data/processed/review/source_corrections.json). Every entry records the original value and the reason; raw files are never edited, and a correction whose original value no longer matches is skipped with a warning.
- **Export validation** — [`scripts/validate_exports.py`](scripts/validate_exports.py) runs at the end of every ETL run and in CI. It fails the build on structural problems (orphan events, wrong `battle_count`, out-of-range coordinates, end year before start year, or more than 0.5 % of events dated outside their war) and writes review queues to `data/processed/qa/validation_report.json` (year-split records, location outliers such as sign-flipped longitudes).
- **Merge accuracy audit** — [`scripts/audit_crosswalk.py`](scripts/audit_crosswalk.py) exports every machine merge between source war lists to `data/processed/review/merge_audit.csv` for a reviewer to mark `correct` / `wrong` / `unsure`, and reports precision with a 95 % Wilson interval (`data/processed/qa/merge_audit_summary.json`). **Draft result:** 224 of 226 judged machine merges correct (99.1 %, 95 % CI 96.8–99.8 %); both errors were then fixed. The verdicts were drafted by an AI assistant and still need confirmation by a human reviewer before the figure is cited. Precision only — missed merges (recall) are not measured. Merges added by the later manual review of the ambiguous queue are listed but deliberately left unjudged, so they do not inflate the figure.
- **Build provenance** — `catalog_meta.json` records the SHA-256 and size of every input file and the software versions used; CI re-checks the committed inputs against it. `.gitattributes` stops Git from rewriting those files' line endings.
- **Placeholder spans** — The War Atlas gives some wars a one-year placeholder span (start = end, e.g. ongoing wars). Only for those, the span is widened to cover the war's own battles and flagged `span_from_battles`.
- **Known remaining issues** — about 0.1 % of events (mostly battles a source files under a neighbouring war, e.g. the 1815 Vendée rising under the 1793–96 war), one unresolved geocode (Arroyo Grande, placed in California), and 4 ambiguous merges left for a human (Finnish War 1918, Taiping Rebellion and Vietnam War vs COW's phase splits, UCDP Abkhazia) — all listed in the validation report.

## Tests

```bash
# App: lint, typecheck, unit tests + checks on the shipped catalog in app/public/data
cd app && npm run lint && npx tsc -b && npm test

# ETL: unit tests + validation of the committed exports (from repo root)
python -m unittest discover -s scripts/tests -v
python scripts/validate_exports.py
```

CI runs all of these on every push and pull request; the Pages deploy only runs if they pass.

---

## Application features

- Shared Map ↔ Globe explorer state (years, layers, selection, heat mode)
- War list with progressive loading, dossier, share URL, filtered JSON export
- Theater outlines when a war is selected; orphan-selection banner when filters hide the war
- Numbers digest: era chips, top wars, regional/tier breakdowns, open on Map/Globe
- First-run About dialog; in-app citations for source datasets
- GitHub Pages deploy via Actions (`VITE_BASE` set for project sites)

---

## Project structure

```
WarsInAllWorld/
  README.md
  LICENSE
  CITATION.cff
  requirements.txt
  .github/workflows/pages.yml
  app/                    Vite + React + TypeScript
    public/data/          Catalog served to the SPA (~18 MB)
    src/
      components/         Map, Globe, Chrome, Numbers, About, …
      lib/                data loaders, URL state, heat, digest, tests
  scripts/
    run_etl.py            Full catalog pipeline (ends by running validate_exports.py)
    validate_exports.py   Export checks + review queues
    audit_crosswalk.py    Merge-accuracy audit (export / score)
    tests/                ETL unit tests (unittest)
    common.py
    state_centers.py
    review_crosswalks.py
  data/
    raw/                  Source CSVs (UCDP GED CSV gitignored — too large)
    processed/            Exports, QA progress, crosswalk review
```

Stack: **Python** (ETL) · **Vite / React / TypeScript** · **Leaflet** · **Cesium**.

---

## Deploy

`app/public/data/` is committed so deploys do not need Python on the host.

**GitHub Pages:** push to GitHub → **Settings → Pages → Source: GitHub Actions**.  
Site: `https://suadarzimanli.github.io/WarsInAllWorld/`

**Vercel:** root directory `app` (see `app/vercel.json` for SPA rewrites).

```bash
cd app
npm run build   # output: app/dist/
```

---

## License and citation

- **Code** (`app/`, `scripts/`, workflows): **MIT** — see [LICENSE](LICENSE).
- **Derived catalog data** (`data/processed/`, `app/public/data/`): **CC BY 4.0** — see [LICENSE-DATA](LICENSE-DATA).
- **Source datasets** in `data/raw/` keep their own licenses and citation requirements.

If you use or reference this work, **please cite the author** (see [CITATION.cff](CITATION.cff)) **and the underlying datasets** (listed in `app/public/data/citations.json` and the About panel).

> © 2026 — Research project by *Suad Arzimanli*
