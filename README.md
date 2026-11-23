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
| `corrections.json` | Corrections of history entries that were measured wrongly; applied on every run, can be emptied once its entries are older than 30 days |
| `seed/` | Initial history (from 10 Nov 2026), used once when the branch `monitor-data` does not exist yet |
| `.github/workflows/status.yml` | Check, history, build and deployment |

## What is measured

Per item one of two metrics (`metric` in `config.json`):

- `age`: time since the newest data of the collection. Usually the item's last update; with `"source": {"kind": "newest_asset"}` the creation time of the newest file (used for radar hail).
- `latency`: publication latency, from the reference time of the newest data to its availability on the STAC API.
  - Reference time from the file name (radar, local forecasts) or from the newest `reference_timestamp` in a station's `*_now.csv` (single stations, pollen).
  - Availability is the `created` / `updated` time of the file on the STAC API. The HTTP `Last-Modified` is only a fallback: some files are rewritten without new data.
  - `"complete_run": true`: latency until the last file of a model run is available (all parameters).
  - `"aggregate": "median"`: latency of the station with the median latency among all current stations (pollen).
  - If no new data arrive (reference time older than interval plus warning threshold), the item counts as down.

Collections with one item per day (`YYYYMMDD-ch`) are read by item date, not by last update: an empty item for the next day appears early in the morning, and items from about a week ago are touched again.

`ok_max_min` is the target, `warn_max_min` the limit between delayed and down (usually 3 × target). Further options per item:

| Option | Effect |
|:--|:--|
| `"realtime": true` | Counts towards the real-time key figure |
| `"source": {"coverage": true}` | Additional line «x of y stations up to date» with the stations that are not; does not change the status |
| `"season": {"pause_months": [12, 1, 2]}` | No rating in these months (UTC), shown as «winter break»; afterwards the interval runs from the end of the break (phenology) |
| `"monitoring_pending": true` | «Monitoring to follow» instead of the strip |

Items in their winter break are still measured and shown in grey, but do not count towards the group status or the key figures.

## Page

- **Overview**: one strip per group A–E for the last 72 hours, one bar per hour. A bar is green when all datasets of the group were up to date, red when none was, otherwise orange.
- **Opening a group** shows its datasets with key figure, status and their own strip. Deep links open the group: `#group-D` or `#monitor-<key>`, e.g. `#monitor-radar-rzc`.
- **Notes**: the intro links to the operational status of geo.admin.ch, group A to the data availability of the ground-based stations.

## JSON endpoint

**https://meteoswiss.github.io/opendata-status/api/v1/status.json**, updated with every check (every 30 minutes). The live status on the page can be newer.

| Field | Content |
|:--|:--|
| `api_version` | `1`; fields are only added within a version |
| `checked` | Time of the check (UTC) |
| `status` | Overall status of all rated datasets: `ok`, `warn` (at least one delayed) or `bad` (at least one down) |
| `summary` | Datasets up to date (`monitored`, `realtime`) and the share of checks in the last 30 days in which all were up to date |
| `groups[]` | Status per group A–E with `total` and `ok` |
| `items[]` | One entry per dataset: `key`, `name` (de/fr/it/en), `group`, `collection`, `documentation`, `metric`, `interval`, `status` (`ok`, `warn`, `bad`, `pause`, `static`), `value_min` (age or latency in minutes), `target_min`, `limit_min`, `newest_data`, `available`, share of checks with status ok in the last 24 hours and 30 days (`ok_share_24h_pct`, `ok_share_30d_pct`), for pollen also `stations` |
| `links` | Page, history files and STAC API |

Example: `curl -s https://meteoswiss.github.io/opendata-status/api/v1/status.json | jq '.items[] | select(.status != "ok") | .key'`

The history is available as `data/history.json` (per check) and `data/history_items.json` (per check and dataset).

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
- Each page view sends about 40 small requests to the STAC API and data.geo.admin.ch (about 15 of them station files for the pollen median), repeated every 5 minutes while the page is open. If that is too much, raise `refreshMinutes` (prop of `OgdMonitor`, default 5, set it in `src/main.jsx`).
- The history files are also public at `https://raw.githubusercontent.com/MeteoSwiss/opendata-status/monitor-data/` and on the page under `data/`.
