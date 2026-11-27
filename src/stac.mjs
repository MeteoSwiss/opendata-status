// Live measurement in the browser: STAC API queries and the measurement of one configured item.
// The rating rules are in rules.mjs (shared with scripts/ogd_monitor.py).
import {parseRef, refFromName, selectRun} from './rules.mjs';

const FILES = 'https://data.geo.admin.ch';
// A request that takes longer is aborted; a measurement (several requests) that takes longer fails.
// So a stalled request can never hold up the page: the dataset then shows "unknown".
export const REQUEST_TIMEOUT_MS = 20e3;
export const MEASURE_TIMEOUT_MS = 60e3;

// fetch with a time limit that also covers reading the body. read(response) returns the result.
export async function request(url, options = {}, read = (r) => r.json(), ms = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {cache: 'no-store', ...options, signal: ctrl.signal});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await read(r);
  } finally {
    clearTimeout(timer);
  }
}

// Rejects when `promise` has not settled within ms (for code that cannot be aborted)
export function withDeadline(promise, ms, label = 'deadline') {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timeout after ${ms} ms`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Measures one item with a time limit for the whole measurement
export function measureWithDeadline(api, c, ms = MEASURE_TIMEOUT_MS) {
  return withDeadline(measure(api, c), ms, c.key);
}

// Measures one configured item live: {updated} for age, {ref, available} for latency
export async function measure(api, c) {
  if (c.metric === 'age') {
    if (c.source && c.source.kind === 'newest_asset') {
      // age of the newest file in the newest daily item (e.g. radar hail)
      const times = (await fetchDated(api, c.collection, 1)).flatMap((f) =>
        Object.values(f.assets).map((a) => a.created || a.updated).filter(Boolean).map((v) => +new Date(v)));
      return {updated: times.length ? new Date(Math.max(...times)) : null};
    }
    // most recently updated item that holds files: empty placeholder items (e.g. for the next month)
    // are created ahead of time and would make the data look fresh
    const f = (await fetchNewestN(api, c.collection, 6)).find((x) => Object.keys(x.assets || {}).length);
    // forecast models: the run the newest files belong to (their reference time)
    const run = f && f.properties['forecast:reference_datetime'];
    return {updated: f ? new Date(f.properties.updated) : null, modelRun: run ? new Date(run) : null};
  }
  if (c.source.kind === 'asset_name' && c.source.complete_run) {
    // a model run is available once its last file (all parameters) is there
    const runs = new Map();
    (await fetchDated(api, c.collection, 2)).forEach((f) => {
      Object.entries(f.assets).forEach(([name, a]) => {
        const ref = refFromName(name, c.source);
        if (!ref) return;
        if (!runs.has(+ref)) runs.set(+ref, []);
        runs.get(+ref).push(new Date(a.created || a.updated));
      });
    });
    return selectRun(runs, new Date(), c.ok_max_min);
  }
  if (c.source.kind === 'asset_name') {
    // today and, after midnight, yesterday
    let best = null;
    (await fetchDated(api, c.collection, 2)).forEach((f) => Object.entries(f.assets).forEach(([name, a]) => {
      const ref = refFromName(name, c.source);
      if (ref && (!best || ref > best.ref)) best = {ref, available: new Date(a.created || a.updated)};
    }));
    return best || {};
  }
  // station_now_csv: availability is the asset's "updated" time on the STAC API (Last-Modified only as
  // fallback: pollen files are rewritten between updates without new data)
  const suffix = c.source.suffix || 't_now';
  const nowAsset = (f) => {
    const e = Object.entries((f && f.assets) || {}).find(([k]) => k.endsWith(`_${suffix}.csv`));
    return e ? e[1] : null;
  };
  const assetTime = (a) => (a && (a.updated || a.created) ? new Date(a.updated || a.created) : null);
  let station = c.source.station;
  const all = station === 'latest' || c.source.coverage ? await fetchAllItems(api, c.collection) : null;

  let stations;
  if (c.source.coverage) {
    const limit = (c.interval_min + c.warn_max_min) * 60e3;
    const withFile = all.filter((f) => nowAsset(f));
    const stale = withFile
      .filter((f) => { const u = assetTime(nowAsset(f)); return !u || Date.now() - u > limit; })
      .map((f) => (f.properties && f.properties.title) || f.id.toUpperCase())
      .sort();
    stations = {total: withFile.length, ok: withFile.length - stale.length, stale};
  }

  const short = c.collection.replace('ch.meteoschweiz.', '');
  const measureStation = async (feature) => {
    const {lm, text} = await request(`${FILES}/${c.collection}/${feature.id}/${short}_${feature.id}_${suffix}.csv`, {},
      async (r) => ({lm: r.headers.get('Last-Modified'), text: await r.text()}));
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const i = lines[0].split(';').indexOf('reference_timestamp');
    let ref = null;
    lines.slice(1).forEach((l) => {
      const v = parseRef(l.split(';')[i]);
      if (v && (!ref || v > ref)) ref = v;
    });
    const available = assetTime(nowAsset(feature));
    const modified = lm ? new Date(lm) : null;
    if (!available) return {ref, available: modified};
    // The CDN keeps some files for up to two hours (pollen: max-age=7200), so this copy can be older
    // than the update on the STAC API. Then estimate the newest reference time as the start of the
    // interval in which the update happened.
    if (modified && available - modified > 60e3) {
      const step = c.interval_min * 60e3;
      const estimate = new Date(Math.floor(available / step) * step);
      if (!ref || estimate > ref) ref = estimate;
    }
    return {ref, available};
  };

  if (station !== 'latest') {
    const feature = await fetchJson(`${api}/collections/${c.collection}/items/${station}`);
    return {...(await measureStation(feature)), stations};
  }
  const cands = all.filter((f) => assetTime(nowAsset(f)));
  if (!cands.length) return {stations};
  if (c.source.aggregate !== 'median') {
    const newest = cands.sort((a, b) => assetTime(nowAsset(b)) - assetTime(nowAsset(a)))[0];
    return {...(await measureStation(newest)), stations};
  }
  // median over the current stations: one late station does not make the whole dataset late
  const limit = (c.interval_min + c.warn_max_min) * 60e3;
  const current = cands.filter((f) => Date.now() - assetTime(nowAsset(f)) <= limit);
  const results = await Promise.allSettled((current.length ? current : cands).map(measureStation));
  const measured = results
    .filter((x) => x.status === 'fulfilled' && x.value.ref && x.value.available)
    .map((x) => x.value)
    .sort((a, b) => (a.available - a.ref) - (b.available - b.ref));
  if (!measured.length) return {stations};
  return {...measured[Math.floor((measured.length - 1) / 2)], stations};
}

// STAC item search (POST /search)
async function search(api, query) {
  const body = await request(`${api}/search`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(query),
  });
  return body.features || [];
}

// Newest n items of a collection (used for model runs that may span two daily items)
function fetchNewestN(api, id, n) {
  return search(api, {collections: [id], limit: n, sortby: [{field: 'properties.updated', direction: 'desc'}]});
}

// Newest non-empty items of a collection with one item per day ("YYYYMMDD-ch"), newest first.
// The last update alone does not name the newest data: early in the morning an empty item for the
// next day appears, and items from about a week ago are touched again.
async function fetchDated(api, id, n) {
  const fs = (await fetchNewestN(api, id, 6)).filter((f) => Object.keys(f.assets || {}).length);
  fs.sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
  return fs.slice(0, n);
}

// All items (stations) of a collection in one request (at most 100)
function fetchAllItems(api, id) {
  return search(api, {collections: [id], limit: 100});
}

export function fetchJson(url) {
  return request(url);
}
