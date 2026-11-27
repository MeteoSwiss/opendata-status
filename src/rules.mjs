// Rating rules of the OGD monitor, shared with scripts/ogd_monitor.py.
// Pure functions without network or React, so that tests/cases.test.mjs can run them in Node.
// Every change here needs the same change in Python; tests/cases.json checks both.

// Start of the first month after the most recent seasonal break (null without a break)
export function pauseEnd(c, now) {
  const months = (c.season && c.season.pause_months) || [];
  if (!months.length) return null;
  let y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  for (let i = 0; i < 12; i++) {
    const prev = m === 1 ? 12 : m - 1;
    if (!months.includes(m) && months.includes(prev)) return new Date(Date.UTC(y, m - 1, 1));
    if (m === 1) { y -= 1; m = 12; } else m -= 1;
  }
  return null;
}

// Rates one measurement: {cls, value} (value in minutes; stalled: latency item without new data).
// m: {updated} for metric age, {ref, available} for metric latency.
export function classify(c, now, m) {
  if (c.ok_max_min === null) return {cls: 'static', value: null};
  if (((c.season && c.season.pause_months) || []).includes(now.getUTCMonth() + 1)) {
    // seasonal break (e.g. phenology in winter): measured, but not rated and not counted
    return {cls: 'pause', value: m.updated ? Math.max(0, (now - m.updated) / 60e3) : null};
  }
  if (c.metric === 'age') {
    if (!m.updated) return {cls: 'bad', value: null};
    const age = Math.max(0, (now - m.updated) / 60e3);
    // after a seasonal break, the expected interval runs from the end of the break
    const start = pauseEnd(c, now);
    const rated = start && m.updated < start ? Math.min(age, (now - start) / 60e3) : age;
    return {cls: rated <= c.ok_max_min ? 'ok' : rated <= c.warn_max_min ? 'warn' : 'bad', value: age};
  }
  if (!m.ref || !m.available) return {cls: 'bad', value: null};
  const lat = Math.max(0, (m.available - m.ref) / 60e3);
  if ((now - m.ref) / 60e3 > c.interval_min + c.warn_max_min) return {cls: 'bad', value: lat, stalled: true};
  return {cls: lat <= c.ok_max_min ? 'ok' : lat <= c.warn_max_min ? 'warn' : 'bad', value: lat};
}

// Reference time (UTC) encoded in an asset file name, or null
export function refFromName(name, src) {
  if (!name.startsWith(src.prefix)) return null;
  const rest = name.slice(src.prefix.length);
  if (src.time === 'yyjjjhhmm') { // e.g. rzc263141550vl.001.h5 -> 2026, day 314, 15:50
    const m = rest.match(/^(\d{2})(\d{3})(\d{2})(\d{2})/);
    return m ? new Date(Date.UTC(2000 + +m[1], 0, +m[2], +m[3], +m[4])) : null;
  }
  if (src.time === 'yyyymmddhhmm') { // e.g. vnut12.lssw.202611101500.tre200h0.csv
    const m = rest.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : null;
  }
  throw new Error(`unknown time format ${src.time}`);
}

// Reference time (UTC) of a reference_timestamp value in a CSV file, or null
export function parseRef(s) {
  const v = (s || '').trim();
  let m = v.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]));
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/) || v.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return null;
}

// Model run to rate with source.complete_run: {ref, available, run} or {}.
// runs: Map of reference time (ms) to the availability times (Date) of its files. A run is complete
// when it has as many files as the largest run (all parameters). If the newest run is still
// incomplete within the target, the previous complete run counts; beyond the target, the latency
// so far (now - reference time) counts and the run is marked incomplete.
export function selectRun(runs, now, okMaxMin) {
  if (!runs.size) return {};
  const expected = Math.max(...[...runs.values()].map((v) => v.length));
  const order = [...runs.keys()].sort((a, b) => b - a);
  const result = (k, complete) => ({
    ref: new Date(k),
    available: complete ? new Date(Math.max(...runs.get(k).map(Number))) : now,
    run: {files: runs.get(k).length, expected, complete},
  });
  if (runs.get(order[0]).length >= expected) return result(order[0], true);
  if ((now - order[0]) / 60e3 > okMaxMin) return result(order[0], false);
  const prev = order.slice(1).find((k) => runs.get(k).length >= expected);
  return prev !== undefined ? result(prev, true) : result(order[0], false);
}

// ---------- freshness (browser only) ----------
// The page always rates at the current time and only with measurements that are still current, so
// that it never keeps showing an old green result.

// Measurement of a row of status.json (latest scheduled check), in the form measure() returns
export function measurementFromCheck(row) {
  const d = (s) => (s ? new Date(s) : null);
  return {
    updated: d(row.updated),
    ref: d(row.ref_time),
    available: d(row.available),
    modelRun: d(row.model_run),
    run: row.run_files !== undefined ? {files: row.run_files, expected: row.run_files_expected, complete: row.run_complete} : undefined,
    stations: row.stations_total !== undefined ? {total: row.stations_total, ok: row.stations_ok, stale: row.stations_stale || []} : undefined,
  };
}

// Which measurement to rate for one item at time `now`:
//   1. the live query of the browser, if it succeeded within liveMaxMs;
//   2. else the latest scheduled check, if it ran within checkMaxMs and its measurement succeeded;
//   3. else nothing: cls 'checking' (first live query still running), 'unknown' (live query failed
//      recently) or 'stale' (all information expired).
// live: {m, measuredAt (last success), failedAt (last failure)} or undefined; check: row of status.json.
// Returns {source: 'live' | 'check' | null, m, at (time of the measurement), cls (only without measurement)}.
export function pickMeasurement(live, check, now, {liveMaxMs, checkMaxMs}) {
  const fresh = (at, maxMs) => Boolean(at) && now - at <= maxMs;
  if (live && fresh(live.measuredAt, liveMaxMs)) return {source: 'live', m: live.m, at: live.measuredAt};
  const checked = check && new Date(check.checked);
  if (check && check.reason !== 'check_failed' && fresh(checked, checkMaxMs)) {
    return {source: 'check', m: measurementFromCheck(check), at: checked};
  }
  const last = [live && live.measuredAt, checked].filter(Boolean).sort((a, b) => b - a)[0] || null;
  if (!live) return {source: null, m: {}, at: last, cls: last ? 'stale' : 'checking'};
  if (fresh(live.failedAt, liveMaxMs)) return {source: null, m: {}, at: last, cls: 'unknown'};
  return {source: null, m: {}, at: last, cls: last ? 'stale' : 'unknown'};
}

// Status of one item at time `now`: pickMeasurement plus classify. Returns {source, m, at, cls, value, stalled}.
export function currentStatus(c, now, live, check, limits) {
  const p = pickMeasurement(live, check, now, limits);
  if (c.ok_max_min === null) return {...p, cls: 'static', value: null};
  if (p.cls) return {...p, value: null};
  return {...p, ...classify(c, now, p.m)};
}
