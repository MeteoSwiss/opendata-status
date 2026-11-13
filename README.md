# Open Data Status MeteoSwiss (beta)

Live: https://meteoswiss.github.io/opendata-status/

How up to date the MeteoSwiss open data are on the [STAC API](https://data.geo.admin.ch/api/stac/v1) of the Federal Spatial Data Infrastructure (FSDI). Documentation of the data: [opendatadocs.meteoswiss.ch](https://opendatadocs.meteoswiss.ch).

- **Current status**: queried live in the visitor's browser on load and every 5 minutes.
- **History** (72-hour strips, 30-day average): a GitHub Actions workflow checks every 30 minutes, keeps the history on the branch `monitor-data` and deploys the page with the fresh data to GitHub Pages.
- Languages: German, French, Italian, English (`?lang=de|fr|it|en`, default from the browser language).

## Structure

| Path | Purpose |
|:--|:--|
| `config.json` | Single configuration for page and check: monitored collections, group A–E, metric, intervals, thresholds, names in de/fr/it/en, documentation links |
| `src/` | Page (React, bundled with esbuild): `main.jsx` frame and language choice, `OgdMonitor.jsx` status logic, `strings.js` texts |
| `scripts/ogd_monitor.py` | Check for the history (Python standard library only) |
| `seed/` | Initial history (from 10 Nov 2026), used once when the branch `monitor-data` does not exist yet |
| `.github/workflows/status.yml` | Check, history, build and deployment |

## What is measured

Per item one of two metrics (`metric` in `config.json`):

- `age`: minutes since the newest item update of the collection.
- `latency`: publication latency, from the reference time of the newest data to its availability on STAC. If no new data arrive (reference time older than interval plus warning threshold), the item counts as down.

`ok_max_min` is the target, `warn_max_min` (3 × target) the limit between delayed and down. Items with `"realtime": true` count towards the real-time key figure. `"monitoring_pending": true` shows «Monitoring to follow» instead of the strip.

<!-- ## Setup

1. Settings › Pages › Build and deployment › Source: **GitHub Actions**.
2. Settings › Actions › General › Workflow permissions: **Read and write permissions** (unless the organisation only allows the `permissions` block in the workflow).
3. Do not protect the branch `monitor-data`; the workflow rewrites it on every run (force push).
4. Actions › «Open Data Status» › **Run workflow**. Afterwards it runs at minute 7 and 37 of every hour and on every push to `main`. -->

<!-- ## Local development

```bash
npm install
npm start            # http://localhost:8000, live status + history from ./data or ./seed
npm run build        # static page in dist/
python3 scripts/ogd_monitor.py --config config.json --data data   # one check into ./data
``` -->

## Notes

- GitHub may delay scheduled runs by a few minutes under load, and disables scheduled workflows in public repositories after 60 days without repository activity. If the history stops, check this first.
- Each page view sends about 25 small requests to the STAC API and data.geo.admin.ch, repeated every 5 minutes while the page is open. Raise `refreshMinutes` in `src/main.jsx` (prop of `OgdMonitor`) if needed.
- The history files are also public at `https://raw.githubusercontent.com/MeteoSwiss/opendata-status/monitor-data/` and on the page under `data/`.
