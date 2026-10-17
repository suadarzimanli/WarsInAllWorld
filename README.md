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
pip install -r requirements.txt
python scripts/run_etl.py
```

Optional crosswalk review: `python scripts/review_crosswalks.py propose`, then re-run ETL.

---

## Data and methods (summary)

- **Sources:** HCED, Correlates of War (wars + MIDLOC), War Atlas, UCDP GED (warlike / conflict layers)
- **ETL** merges wars, attaches battles/events, derives approximate theaters, writes GeoJSON/JSON packs
- **Coverage honesty:** battles vs proxy centroid vs unmapped, with tier breakdowns in Filters / Numbers
- **Filters:** year range (including open ends / all years), definition mode, spatial coverage, search
- **Display:** point layers or equal-area **heat** (Relative within filters vs Absolute vs catalog peak at zoom)
- **Deep links:** war selection, era handoff from Numbers, optional `?lat=&lng=` focus fly-to

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
    run_etl.py            Full catalog pipeline
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

This repository is intended for **academic and educational use**.

It is licensed under **Creative Commons Attribution 4.0 International (CC BY 4.0)** — see [LICENSE](LICENSE).

If you use or reference this work, **please cite the author** (see [CITATION.cff](CITATION.cff) for machine-readable metadata).

Please also cite the **underlying datasets** when you reuse their content (listed in `app/public/data/citations.json` and the About panel).

> © 2026 — Research project by *Suad Arzimanli*
