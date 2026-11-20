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
                   + source_corrections.json (documented per-record fixes to raw rows)
    qa/            progress_history.json + validation_report.json
```

ETL reads raw CSVs + `review/crosswalk_decisions.json` + `review/source_corrections.json`, writes exports + public copies, then runs `scripts/validate_exports.py`.
Raw downloads are kept; only CSVs the pipeline reads are required.
