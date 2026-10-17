# Data layout

```
data/
  raw/
    hced/          HCED_Data_v3.csv (+ README)
    cow/           COW war CSVs (v4 / Intra v5.1) + MIDLOCA 2.1 + dyadic
    war-atlas/     wars.csv + battles.csv (+ LICENSE/README)
    ucdp/          UCDP GED 26.1 CSV (+ README)
  processed/
    exports/       SPA catalog GeoJSON/JSON (copied to app/public/data)
    qa/            progress_history.json
    review/        crosswalk_decisions.json + ambiguous/rejected queues
```

ETL reads raw CSVs + `review/crosswalk_decisions.json`, writes exports + public copies.
Raw downloads are kept; only CSVs the pipeline reads are required.
