import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import config from '../config.json';
import strings from './strings';
import styles from './styles.module.css';

/**
 * OgdMonitor
 *
 * Shows how up to date the MeteoSwiss OGD collections are on the FSDI STAC API.
 *   - Current status: queried live from the browser on load and every `refreshMinutes`.
 *   - History (72 h strips, 30-day average): deployed with the page (data/); .github/workflows/status.yml
 *     runs the check every 30 minutes and keeps the history on the branch `monitor-data`.
 * Intervals and thresholds come from config.json (shared with the workflow).
 *
 * Usage:
 *   <OgdMonitor locale="de" />
 */

// History is deployed together with the page (folder data/, see .github/workflows/status.yml)
const DEFAULT_DATA_URL = './data';
const DOCS = 'https://opendatadocs.meteoswiss.ch';
// Link to the documentation page in the same language (English has no prefix)
const docUrl = (doc, locale) => `${DOCS}${locale === 'en' ? '' : '/' + locale}${doc}`;
const HOURS = 72;
const HOUR_MS = 3600e3;
const GOAL = 0.95;
const RANK = {ok: 1, warn: 2, bad: 3};
const GROUPS = ['A', 'B', 'C', 'D', 'E'];

// ---------- helpers ----------

const FILES = 'https://data.geo.admin.ch';

// Same rules as scripts/monitor/ogd_monitor.py: returns {cls, value} (value in minutes)
function classify(c, now, m) {
  if (c.ok_max_min === null) return {cls: 'static', value: null};
  if (c.metric === 'age') {
    if (!m.updated) return {cls: 'bad', value: null};
    const age = Math.max(0, (now - m.updated) / 60e3);
    return {cls: age <= c.ok_max_min ? 'ok' : age <= c.warn_max_min ? 'warn' : 'bad', value: age};
  }
  if (!m.ref || !m.available) return {cls: 'bad', value: null};
  const lat = Math.max(0, (m.available - m.ref) / 60e3);
  if ((now - m.ref) / 60e3 > c.interval_min + c.warn_max_min) return {cls: 'bad', value: lat, stalled: true};
  return {cls: lat <= c.ok_max_min ? 'ok' : lat <= c.warn_max_min ? 'warn' : 'bad', value: lat};
}

function refFromName(name, src) {
  if (!name.startsWith(src.prefix)) return null;
  const rest = name.slice(src.prefix.length);
  if (src.time === 'yyjjjhhmm') {
    const m = rest.match(/^(\d{2})(\d{3})(\d{2})(\d{2})/);
    if (!m) return null;
    return new Date(Date.UTC(2000 + +m[1], 0, +m[2], +m[3], +m[4]));
  }
  if (src.time === 'yyyymmddhhmm') {
    const m = rest.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : null;
  }
  return null;
}

function parseRef(s) {
  const t = (s || '').trim();
  let m = t.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]));
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return null;
}

// Measures one configured item live: {updated} for age, {ref, available} for latency
async function measure(api, c) {
  if (c.metric === 'age') {
    const f = await fetchNewest(api, c.collection);
    return {updated: f ? new Date(f.properties.updated) : null};
  }
  if (c.source.kind === 'asset_name' && c.source.complete_run) {
    // a model run is available once its last file (all parameters) is there
    const runs = new Map();
    (await fetchNewestN(api, c.collection, 2)).forEach((f) => {
      Object.entries(f.assets).forEach(([name, a]) => {
        const ref = refFromName(name, c.source);
        if (!ref) return;
        const k = +ref;
        if (!runs.has(k)) runs.set(k, []);
        runs.get(k).push(new Date(a.created || a.updated));
      });
    });
    if (!runs.size) return {};
    const expected = Math.max(...[...runs.values()].map((v) => v.length));
    const order = [...runs.keys()].sort((a, b) => b - a);
    const run = (k, complete) => ({
      ref: new Date(k),
      available: complete ? new Date(Math.max(...runs.get(k).map(Number))) : new Date(),
      run: {files: runs.get(k).length, expected, complete},
    });
    if (runs.get(order[0]).length >= expected) return run(order[0], true);
    if ((Date.now() - order[0]) / 60e3 > c.ok_max_min) return run(order[0], false);
    const prev = order.slice(1).find((k) => runs.get(k).length >= expected);
    return prev ? run(prev, true) : run(order[0], false);
  }
  if (c.source.kind === 'asset_name') {
    const f = await fetchNewest(api, c.collection);
    let best = null;
    Object.entries(f ? f.assets : {}).forEach(([name, a]) => {
      const ref = refFromName(name, c.source);
      if (ref && (!best || ref > best.ref)) best = {ref, available: new Date(a.created || a.updated)};
    });
    return best || {};
  }
  // station_now_csv
  let station = c.source.station;
  if (station === 'latest') {
    const f = await fetchNewest(api, c.collection);
    if (!f) return {};
    station = f.id;
  }
  const short = c.collection.replace('ch.meteoschweiz.', '');
  const r = await fetch(`${FILES}/${c.collection}/${station}/${short}_${station}_${c.source.suffix || 't_now'}.csv`, {cache: 'no-store'});
  if (!r.ok) throw new Error(`CSV ${r.status}`);
  const lm = r.headers.get('Last-Modified');
  const lines = (await r.text()).split(/\r?\n/).filter((l) => l.trim());
  const i = lines[0].split(';').indexOf('reference_timestamp');
  let ref = null;
  lines.slice(1).forEach((l) => {
    const v = parseRef(l.split(';')[i]);
    if (v && (!ref || v > ref)) ref = v;
  });
  return {ref, available: lm ? new Date(lm) : null};
}

function fmtAge(min, t) {
  if (min === null || min === undefined || Number.isNaN(min)) return t.unit.noData;
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} ${t.unit.min}`;
  if (m < 48 * 60) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return `${h} ${t.unit.h}${r ? ` ${r} ${t.unit.min}` : ''}`;
  }
  return `${Math.round(m / 1440)} ${t.unit.days}`;
}

function fmtTime(date, t, withYear = false) {
  if (!date) return '–';
  const o = {timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'};
  if (withYear) o.year = 'numeric';
  return new Date(date).toLocaleString(t.intl, o);
}

function fmtClock(date, t) {
  return new Date(date).toLocaleTimeString(t.intl, {timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit'});
}

function fmtPct(v, t) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  const n = (Math.round(v * 1000) / 10).toLocaleString(t.intl);
  return t.intl === 'en-GB' ? `${n}%` : `${n} %`;
}

// Newest n items of a collection (used for model runs that may span two daily items)
async function fetchNewestN(api, id, n) {
  const r = await fetch(`${api}/search`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    cache: 'no-store',
    body: JSON.stringify({collections: [id], limit: n, sortby: [{field: 'properties.updated', direction: 'desc'}]}),
  });
  if (!r.ok) throw new Error(`STAC ${r.status}`);
  return (await r.json()).features || [];
}

// Newest item of a collection; requests for the same collection within one check are shared
const pending = new Map();
function fetchNewest(api, id) {
  if (!pending.has(id)) {
    pending.set(id, fetch(`${api}/search`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      cache: 'no-store',
      body: JSON.stringify({collections: [id], limit: 1, sortby: [{field: 'properties.updated', direction: 'desc'}]}),
    }).then((r) => {
      if (!r.ok) throw new Error(`STAC ${r.status}`);
      return r.json();
    }).then((j) => (j.features || [])[0] || null));
  }
  return pending.get(id);
}

async function fetchJson(url) {
  const r = await fetch(url, {cache: 'no-store'});
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// ---------- history strip ----------

function Strip({checks, end, firstEver, t}) {
  const [sel, setSel] = useState(-1);
  const ref = useRef(null);
  const bins = useMemo(() => {
    const out = [];
    // bars aligned to full hours; the last bar is the current hour
    const top = Math.floor(+end / HOUR_MS) * HOUR_MS;
    for (let i = 0; i < HOURS; i++) {
      const from = new Date(top - (HOURS - 1 - i) * HOUR_MS);
      const to = new Date(+from + HOUR_MS);
      const inBin = checks.filter((c) => c.t >= from && c.t < to);
      let cls = '';
      if (inBin.length) cls = inBin.reduce((w, c) => (RANK[c.cls] > RANK[w] ? c.cls : w), 'ok');
      else if (firstEver && to < firstEver) cls = 'pre';
      out.push({from, to, cls, checks: inBin});
    }
    return out;
  }, [checks, end, firstEver]);

  const nBad = bins.filter((b) => b.cls === 'bad').length;
  const nWarn = bins.filter((b) => b.cls === 'warn').length;
  const index = (ev) => {
    const r = ref.current.getBoundingClientRect();
    return Math.min(HOURS - 1, Math.max(0, Math.floor(((ev.clientX - r.left) / r.width) * HOURS)));
  };
  const onKey = (ev) => {
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); setSel((s) => Math.max(0, (s < 0 ? HOURS : s) - 1)); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); setSel((s) => Math.min(HOURS - 1, s < 0 ? HOURS - 1 : s + 1)); }
    else if (ev.key === 'Escape') setSel(-1);
  };
  const b = sel >= 0 ? bins[sel] : null;
  const left = sel >= 0 ? `clamp(0px, calc(${((sel + 0.5) / HOURS) * 100}% - 140px), calc(100% - 280px))` : 0;

  return (
    <div className={styles.history}>
      <div
        ref={ref}
        className={styles.strip}
        role="img"
        tabIndex={0}
        aria-label={t.stripLabel(nBad, nWarn)}
        onPointerMove={(ev) => setSel(index(ev))}
        onPointerDown={(ev) => setSel(index(ev))}
        onPointerLeave={(ev) => { if (ev.pointerType === 'mouse') setSel(-1); }}
        onFocus={() => setSel((s) => (s < 0 ? HOURS - 1 : s))}
        onBlur={() => setSel(-1)}
        onKeyDown={onKey}>
        {bins.map((bin, i) => (
          <div key={i} className={[styles.bin, bin.cls && styles[bin.cls], i === sel && styles.sel].filter(Boolean).join(' ')} />
        ))}
      </div>
      {b && (
        <div className={styles.pop} style={{left}}>
          <p className={styles.muted}>{fmtTime(b.from, t)} – {fmtClock(b.to, t)}</p>
          {b.checks.length
            ? b.checks.map((c, k) => <p key={k}>{c.text}</p>)
            : <p>{b.cls === 'pre' ? t.pre : t.noCheck}</p>}
        </div>
      )}
      <div className={styles.labels}><span>{t.hoursAgo}</span><span>{t.now}</span></div>
    </div>
  );
}

// ---------- main component ----------

// Split a status line at " · " so that each part wraps as a whole on narrow screens.
function segments(text) {
  return text.split(' · ').map((part, i) => (
    <React.Fragment key={i}>{i > 0 && ' '}<span className={styles.seg}>{i > 0 && '· '}{part}</span></React.Fragment>
  ));
}

export default function OgdMonitor({locale = 'en', dataUrl = DEFAULT_DATA_URL, refreshMinutes = 5}) {
  const t = strings(locale);
  const name = (c) => c.name[locale] || c.name.en;

  const [live, setLive] = useState(null); // {checked: Date, m: {key: measurement|undefined}}
  const [history, setHistory] = useState(null); // {summary: [], items: []} or {error}

  const loadLive = useCallback(async () => {
    pending.clear();
    const results = await Promise.allSettled(config.items.map((c) => measure(config.stac_api, c)));
    const m = {};
    config.items.forEach((c, i) => {
      m[c.key] = results[i].status === 'fulfilled' ? results[i].value : undefined; // undefined = query failed
    });
    setLive({checked: new Date(), m});
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const [summary, items] = await Promise.all([
        fetchJson(`${dataUrl}/history.json`),
        fetchJson(`${dataUrl}/history_items.json`),
      ]);
      setHistory({summary, items});
    } catch (e) {
      setHistory({error: true, summary: [], items: []});
    }
  }, [dataUrl]);

  useEffect(() => {
    loadLive();
    loadHistory();
    const id = setInterval(() => { loadLive(); loadHistory(); }, refreshMinutes * 60e3);
    return () => clearInterval(id);
  }, [loadLive, loadHistory, refreshMinutes]);

  const rows = useMemo(() => {
    if (!live) return null;
    return config.items.map((c) => {
      const m = live.m[c.key];
      const res = classify(c, live.checked, m || {});
      const cls = m === undefined && res.cls !== 'static' ? 'unknown' : res.cls;
      return {c, m: m || {}, value: res.value, stalled: res.stalled, cls};
    });
  }, [live]);

  if (!rows) return <p className={styles.loading}>{t.loading}</p>;

  const monitored = rows.filter((r) => r.cls !== 'static');
  const realtime = monitored.filter((r) => r.c.realtime);
  const nOk = (a) => a.filter((r) => r.cls === 'ok').length;
  const rtOk = nOk(realtime);
  const monOk = nOk(monitored);
  const problems = monitored.length - monOk;
  const rtCls = rtOk === realtime.length ? 'ok' : rtOk === 0 ? 'bad' : 'warn';
  const dotCls = rtCls === 'ok' && problems ? 'warn' : rtCls;

  const hist = history || {summary: [], items: []};
  const sumRt = hist.summary.reduce((s, h) => s + h.realtime_ok, 0);
  const totRt = hist.summary.reduce((s, h) => s + h.realtime_total, 0);
  const avg30 = totRt ? sumRt / totRt : null;
  const allChecks = [...hist.summary.map((h) => +new Date(h.checked))];
  const firstEver = allChecks.length ? new Date(Math.min(...allChecks)) : live.checked;

  // short text of what was measured: latency or age of the newest data
  const describe = (r) => {
    if (r.c.metric === 'latency') return r.stalled ? `${t.noNewData}, ${t.latShort(fmtAge(r.value, t))}` : t.latShort(fmtAge(r.value, t));
    return t.since + fmtAge(r.value, t);
  };

  const late = monitored.filter((r) => r.cls !== 'ok');
  const out = late.filter((r) => r.cls === 'bad');
  const delayed = late.filter((r) => r.cls === 'warn');
  const unknown = late.filter((r) => r.cls === 'unknown');
  const title = !late.length ? t.allOk : [
    out.length && t.noNew + out.map((r) => `${name(r.c)} (${describe(r)})`).join(', '),
    delayed.length && t.delayedList + delayed.map((r) => name(r.c)).join(', '),
    unknown.length && t.unknownList + unknown.map((r) => name(r.c)).join(', '),
  ].filter(Boolean).join(' · ');

  const pctCls = (v, floor) => (v === null ? '' : v >= GOAL ? styles.ok : v >= floor ? styles.warn : styles.bad);
  const statusText = (cls) => t.status[cls];

  // history checks for the real-time strip, plus the live check
  const rtChecks = hist.summary.map((h) => ({
    t: new Date(h.checked),
    cls: h.realtime_ok === h.realtime_total ? 'ok' : h.realtime_ok === 0 ? 'bad' : 'warn',
    text: `${t.ofCurrent(h.realtime_ok, h.realtime_total)} (${t.check} ${fmtClock(h.checked, t)})`,
  }));
  rtChecks.push({t: live.checked, cls: rtCls, text: `${t.ofCurrent(rtOk, realtime.length)} (${t.live} ${fmtClock(live.checked, t)})`});

  const itemChecks = (r) => {
    const pts = hist.items.filter((p) => p.key === r.c.key).map((p) => {
      const cls = p.status;
      const v = r.c.metric === 'latency' ? t.latShort(fmtAge(p.value_min, t)) : t.newest(fmtAge(p.value_min, t));
      return {t: new Date(p.checked), cls, text: `${t.status[cls] || cls} · ${v}`};
    });
    if (r.cls !== 'unknown') pts.push({t: live.checked, cls: r.cls, text: `${t.status[r.cls]} · ${describe(r)} (${t.live})`});
    return pts;
  };

  return (
    <div className={styles.monitor}>
      <div className={styles.headline}>
        <span className={`${styles.bigdot} ${styles[dotCls]}`} aria-hidden="true" />
        <div>
          <p className={styles.hlTitle}>{title}</p>
          <p className={styles.muted}>{t.lead(rtOk, realtime.length, fmtTime(live.checked, t, true))}</p>
        </div>
      </div>

      <div className={styles.section}>
        <p className={styles.h2}>{t.keyFigures}</p>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t.kpiRt}</span>
            <span className={`${styles.statValue} ${pctCls(realtime.length ? rtOk / realtime.length : null, 0.8)}`}>{fmtPct(realtime.length ? rtOk / realtime.length : null, t)}</span>
            <span className={styles.small}>{t.kpiRtSub}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t.kpiAvg}</span>
            <span className={`${styles.statValue} ${pctCls(avg30, 0.8)}`}>{fmtPct(avg30, t)}</span>
            <span className={styles.small}>{t.kpiAvgSub(hist.summary.length)}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t.kpiAll}</span>
            <span className={`${styles.statValue} ${pctCls(monitored.length ? monOk / monitored.length : null, 0)}`}>{fmtPct(monitored.length ? monOk / monitored.length : null, t)}</span>
            <span className={styles.small}>{t.kpiAllSub(monOk, monitored.length)}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t.kpiBad}</span>
            <span className={`${styles.statValue} ${problems ? styles.bad : styles.ok}`}>{problems}</span>
            <span className={styles.small}>{t.kpiBadSub}</span>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.row}>
          <p className={styles.h2} style={{margin: 0}}>{t.realtime}</p>
          <span className={`${styles.status} ${styles[rtCls]}`}>{rtCls === 'ok' ? t.allCurrent : t.ofCurrent(rtOk, realtime.length)}</span>
        </div>
        <p className={styles.small} style={{marginTop: 6}}>{t.realtimeSub}</p>
        {history && history.error && <p className={styles.notice}>{t.historyMissing}</p>}
        <Strip checks={rtChecks} end={live.checked} firstEver={firstEver} t={t} />
      </div>

      <div className={styles.section}>
        <p className={styles.h2}>{t.datasets}</p>
        {GROUPS.map((g) => {
          // order as in config.json (= order of the documentation)
          const list = rows.filter((r) => r.c.group === g && r.cls !== 'static');
          return (
            <div key={g} className={styles.group}>
              <p className={styles.h3}>{t.groups[g]}</p>
              {!list.length && <p className={styles.small}>{t.noneYet}</p>}
              {list.map((r) => (
                <div key={r.c.key} className={r.c.sub ? `${styles.service} ${styles.sub}` : styles.service} id={`monitor-${r.c.key}`}>
                  <div className={styles.row}>
                    <div className={styles.name}>
                      {r.c.doc ? <a href={docUrl(r.c.doc, locale)}>{name(r.c)}</a> : name(r.c)}
                      <small>{r.c.collection.replace('ch.meteoschweiz.', '')}</small>
                    </div>
                    <span className={`${styles.status} ${styles[r.cls]}`}>{statusText(r.cls)}</span>
                  </div>
                  {r.c.monitoring_pending
                    ? <p className={styles.pending}>{t.pending}</p>
                    : <Strip checks={itemChecks(r)} end={live.checked} firstEver={firstEver} t={t} />}
                  <p className={styles.statLine}>{segments(r.c.metric === 'latency'
                    ? t.latLine(r.value === null || r.value === undefined ? '–' : fmtAge(r.value, t), fmtAge(r.c.ok_max_min, t), fmtTime(r.m.ref, t))
                      + (r.m.run ? ` · ${r.m.run.complete ? t.allParams(r.m.run.expected) : t.someParams(r.m.run.files, r.m.run.expected)}` : '')
                      + (r.stalled ? ` · ${t.noNewData}` : '')
                    : t.line(t.interval[r.c.interval], fmtTime(r.m.updated, t), fmtAge(r.value, t)))}</p>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <details className={styles.details}>
        <summary>{t.staticTitle}</summary>
        <div className={styles.detailBody}>
          <p className={styles.muted}>{t.staticSub}</p>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>{t.dataset}</th><th>{t.lastChange}</th></tr></thead>
              <tbody>
                {rows.filter((r) => r.cls === 'static').map((r) => (
                  <tr key={r.c.key}><td>{r.c.doc ? <a href={docUrl(r.c.doc, locale)}>{name(r.c)}</a> : name(r.c)}</td><td>{fmtTime(r.m.updated, t, true)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      <details className={styles.details}>
        <summary>{t.howTitle}</summary>
        <div className={styles.detailBody}>
          <div className={styles.legend}>
            {['ok', 'warn', 'bad', 'empty', 'pre'].map((k) => (
              <span key={k}><i className={`${styles.swatch} ${styles[k]}`} />{t.legend[k]}</span>
            ))}
          </div>
          {t.how.map((p, i) => <p key={i}>{p}</p>)}
        </div>
      </details>
    </div>
  );
}
