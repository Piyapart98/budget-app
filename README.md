# budget-app

Phone-facing frontend for the Budget Pipeline. Served via GitHub Pages at
`https://piyapart98.github.io/budget-app/`.

This repo contains only HTML + JS templates. All data (database.csv,
changelog.csv, goals.json, config.json) lives in the **private**
`budget-data` repo and is read/written from the browser using a fine-grained
Personal Access Token saved in localStorage.

OCR-based slip review still runs on the Mac (`run_pipeline.py`). The phone
handles entry, edit, delete, and the monthly report.

See `PHONE_SETUP.md` in the main project for the full architecture.
