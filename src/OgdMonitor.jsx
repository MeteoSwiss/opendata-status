import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import config from '../config.json';
import strings from './strings';
import styles from './styles.module.css';
import {classify} from './rules.mjs';
import {fetchJson, measure} from './stac';
import {fmtAge, fmtClock, fmtPct, fmtTime, segments} from './format';
import Strip from './Strip';
import Incidents from './Incidents';

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
const GOAL = 0.95;
const GROUPS = ['A', 'B', 'C', 'D', 'E'];

// Group to open for a deep link: #group-D or #monitor-<item key>
function groupFromHash() {
  if (typeof window === 'undefined') return [];
  const h = decodeURIComponent(window.location.hash.slice(1));
  if (h.startsWith('group-')) return [h.slice(6)];
  const item = config.items.find((c) => `monitor-${c.key}` === h);
  return item ? [item.group] : [];
}

export default function OgdMonitor({locale = 'en', dataUrl = DEFAULT_DATA_URL, refreshMinutes = 5}) {
  const t = strings(locale);
  const name = (c) => c.name[locale] || c.name.en;

  const [live, setLive] = useState(null); // {checked: Date, m: {key: measurement|undefined}}
  const [history, setHistory] = useState(null); // {summary: [], items: []} or {error}
  const [openGroups, setOpenGroups] = useState(() => new Set(groupFromHash()));
  const toggleGroup = (g) => setOpenGroups((prev) => {
    const next = new Set(prev);
    if (next.has(g)) next.delete(g); else next.add(g);
    return next;
  });
  useEffect(() => {
    const onHash = () => setOpenGroups((prev) => new Set([...prev, ...groupFromHash()]));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const loadLive = useCallback(async () => {
    const results = await Promise.allSettled(config.items.map((c) => measure(config.stac_api, c)));
    const m = {};
    config.items.forEach((c, i) => {
      m[c.key] = results[i].status === 'fulfilled' ? results[i].value : undefined; // undefined = query failed
    });
    setLive({checked: new Date(), m});
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const [summary, items, latest, incidentsDoc] = await Promise.all([
        fetchJson(`${dataUrl}/history.json`),
        fetchJson(`${dataUrl}/history_items.json`),
        // latest scheduled check, for its download test of the newest file per dataset
        fetchJson(`${dataUrl}/status.json`).catch(() => []),
        fetchJson(`${dataUrl}/incidents.json`).catch(() => null),
      ]);
      setHistory({summary, items, latest, incidents: incidentsDoc ? incidentsDoc.incidents : null});
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
      let cls = m === undefined && res.cls !== 'static' ? 'unknown' : res.cls;
      // The browser only reads the catalog; whether the newest file can actually be downloaded is
      // tested by the scheduled check (every 30 min). A failed test from the last hour makes the
      // dataset down, even if the catalog looks fresh.
      const latest = ((history && history.latest) || []).find((x) => x.key === c.key);
      const access = latest && latest.access;
      const recent = latest && live.checked - new Date(latest.checked) < 60 * 60e3;
      const noAccess = access && !access.ok && recent && ['ok', 'warn'].includes(cls) ? {...access, checked: new Date(latest.checked)} : null;
      if (noAccess) cls = 'bad';
      return {c, m: m || {}, value: res.value, stalled: res.stalled, cls, noAccess};
    });
  }, [live, history]);

  // deep link: once the data are there, scroll to the opened group or dataset
  const scrolled = useRef(false);
  useEffect(() => {
    if (!rows || scrolled.current || !window.location.hash) return;
    scrolled.current = true;
    const el = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (el) requestAnimationFrame(() => el.scrollIntoView());
  }, [rows]);

  if (!rows) return <p className={styles.loading}>{t.loading}</p>;

  const monitored = rows.filter((r) => r.cls !== 'static' && r.cls !== 'pause');
  const realtime = monitored.filter((r) => r.c.realtime);
  const nOk = (a) => a.filter((r) => r.cls === 'ok').length;
  const rtOk = nOk(realtime);
  const monOk = nOk(monitored);
  const problems = monitored.length - monOk;
  const rtCls = rtOk === realtime.length ? 'ok' : rtOk === 0 ? 'bad' : 'warn';
  const dotCls = rtCls === 'ok' && problems ? 'warn' : rtCls;

  const hist = history || {summary: [], items: []};
  const incidents = (history && history.incidents) || [];
  const byKey = Object.fromEntries(rows.map((r) => [r.c.key, r]));
  const sumRt = hist.summary.reduce((s, h) => s + h.realtime_ok, 0);
  const totRt = hist.summary.reduce((s, h) => s + h.realtime_total, 0);
  const avg30 = totRt ? sumRt / totRt : null;
  const allChecks = [...hist.summary.map((h) => +new Date(h.checked))];
  const firstEver = allChecks.length ? new Date(Math.min(...allChecks)) : live.checked;

  // short text of what was measured: latency or age of the newest data
  const describe = (r) => {
    if (r.noAccess) return t.notDownloadable(r.noAccess.host, r.noAccess.error || `HTTP ${r.noAccess.http_status}`);
    if (r.c.metric === 'latency') return r.stalled ? `${t.noNewData}, ${t.latShort(fmtAge(r.value, t))}` : t.latShort(fmtAge(r.value, t));
    return t.valAge(fmtAge(r.value, t));
  };

  const late = monitored.filter((r) => r.cls !== 'ok');
  const out = late.filter((r) => r.cls === 'bad');
  const delayed = late.filter((r) => r.cls === 'warn');
  const unknown = late.filter((r) => r.cls === 'unknown');
  const unreachable = out.filter((r) => r.noAccess);
  const stale = out.filter((r) => !r.noAccess);
  const title = !late.length ? t.allOk : [
    stale.length && t.noNew + stale.map((r) => `${name(r.c)} (${describe(r)})`).join(', '),
    unreachable.length && t.notDownloadableList + unreachable.map((r) => `${name(r.c)} (${r.noAccess.host})`).join(', '),
    delayed.length && t.delayedList + delayed.map((r) => name(r.c)).join(', '),
    unknown.length && t.unknownList + unknown.map((r) => name(r.c)).join(', '),
  ].filter(Boolean).join(' · ');

  const pctCls = (v, floor) => (v === null ? '' : v >= GOAL ? styles.ok : v >= floor ? styles.warn : styles.bad);
  const statusText = (cls) => t.status[cls];

  const itemChecks = (r) => {
    const pts = hist.items.filter((p) => p.key === r.c.key).map((p) => {
      const cls = p.status;
      const v = r.c.metric === 'latency' ? t.latShort(fmtAge(p.value_min, t)) : t.newest(fmtAge(p.value_min, t));
      const why = p.reason ? ` · ${t.reasons[p.reason] || p.reason}${p.detail ? ` (${p.detail})` : ''}` : '';
      return {t: new Date(p.checked), cls, text: `${t.status[cls] || cls} · ${v}${why}`};
    });
    if (r.cls !== 'unknown') pts.push({t: live.checked, cls: r.cls, text: `${t.status[r.cls]} · ${describe(r)} (${t.live})`});
    return pts;
  };

  // one compact entry per dataset: title, key figure and status on one line, slim strip, details below
  const keyFigure = (r) => {
    if (r.c.monitoring_pending || r.value === null || r.value === undefined) return '–';
    return r.c.metric === 'latency' ? t.valLat(fmtAge(r.value, t)) : t.valAge(fmtAge(r.value, t));
  };
  const renderItem = (r) => (
      <div key={r.c.key} id={`monitor-${r.c.key}`}
        className={[styles.service, r.c.sub && styles.sub, !['ok', 'pause'].includes(r.cls) && styles.attention].filter(Boolean).join(' ')}>
        <div className={styles.row}>
          <div className={styles.name}>
            {r.c.doc ? <a href={docUrl(r.c.doc, locale)}>{name(r.c)}</a> : name(r.c)}
          </div>
          <div className={styles.keyval}>
            <span className={styles.figure}>{keyFigure(r)}</span>
            {r.cls === 'ok'
              ? <span className={`${styles.status} ${styles.ok} ${styles.dotOnly}`} title={statusText('ok')}><span className={styles.srOnly}>{statusText('ok')}</span></span>
              : <span className={`${styles.status} ${styles[r.cls]}`}>{statusText(r.cls)}</span>}
          </div>
        </div>
        {r.c.monitoring_pending
          ? <p className={styles.pending}>{t.pending}</p>
          : <Strip checks={itemChecks(r)} end={live.checked} firstEver={firstEver} t={t}
              incidents={incidents.filter((x) => x.datasets.some((d) => d.key === r.c.key))} />}
        <p className={styles.statLine}>{segments(r.c.collection.replace('ch.meteoschweiz.', '') + ' · ' + (r.c.metric === 'latency'
          ? t.metaLat(fmtAge(r.c.ok_max_min, t), fmtTime(r.m.ref, t))
            + (r.m.run ? ` · ${r.m.run.complete ? t.allParams(r.m.run.expected) : t.someParams(r.m.run.files, r.m.run.expected)}` : '')
            + (r.stalled ? ` · ${t.noNewData}` : '')
            + (r.m.stations ? ` · ${t.stations(r.m.stations.ok, r.m.stations.total)}${r.m.stations.stale.length ? ` · ${t.staleList}${r.m.stations.stale.join(', ')}` : ''}` : '')
          : t.metaAge(t.interval[r.c.interval], fmtTime(r.m.updated, t))
            + (r.m.modelRun ? ` · ${t.modelRun(fmtTime(r.m.modelRun, t))}` : ''))
          + (r.noAccess ? ` · ${t.notDownloadable(r.noAccess.host, r.noAccess.error || `HTTP ${r.noAccess.http_status}`)} (${t.check} ${fmtClock(r.noAccess.checked, t)})` : '')
          + (r.c.season ? ` · ${t.pauseInfo}` : ''))}</p>
      </div>
  );

  // group strip: per check, green if all datasets of the group were up to date, red if none, else orange
  const groupChecks = (list) => {
    const byKey = new Map(list.map((r) => [r.c.key, r]));
    const byTime = new Map();
    for (const p of hist.items) {
      if (!byKey.has(p.key) || p.status === 'pause') continue;
      if (!byTime.has(p.checked)) byTime.set(p.checked, []);
      byTime.get(p.checked).push(p);
    }
    const summarize = (n, okN, off, when) => ({
      cls: okN === n ? 'ok' : okN === 0 ? 'bad' : 'warn',
      text: `${t.ofCurrent(okN, n)} (${when})${off.length ? ` · ${off.join(', ')}` : ''}`,
    });
    const pts = [...byTime].map(([checked, ps]) => ({
      t: new Date(checked),
      ...summarize(ps.length, ps.filter((p) => p.status === 'ok').length,
        ps.filter((p) => p.status !== 'ok').map((p) => `${name(byKey.get(p.key).c)}: ${t.status[p.status] || p.status}`),
        `${t.check} ${fmtClock(checked, t)}`),
    }));
    const rated = list.filter((r) => r.cls !== 'pause');
    pts.push({
      t: live.checked,
      ...summarize(rated.length, nOk(rated),
        rated.filter((r) => r.cls !== 'ok').map((r) => `${name(r.c)}: ${t.status[r.cls]}`),
        `${t.live} ${fmtClock(live.checked, t)}`),
    });
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
        <p className={styles.h2}>{t.overview}</p>
        <p className={`${styles.small} ${styles.sub2}`}>{t.overviewSub}</p>
        <div className={`${styles.legend} ${styles.legendTop}`}>
          {['ok', 'warn', 'bad', 'pause', 'empty', 'pre'].map((k) => (
            <span key={k}><i className={`${styles.swatch} ${styles[k]}`} />{t.legend[k]}</span>
          ))}
        </div>
        <p className={`${styles.small} ${styles.greenMeans}`}>{t.greenMeans}</p>
        {history && history.error && <p className={styles.notice}>{t.historyMissing}</p>}
        <div className={styles.bars}>
          {GROUPS.map((g) => {
            // order as in config.json (= order of the documentation)
            const list = rows.filter((r) => r.c.group === g && r.cls !== 'static');
            if (!list.length) {
              return (
                <div key={g} className={styles.bar} id={`group-${g}`}>
                  <div className={styles.barTitle}>
                    <span className={`${styles.barName} ${styles.muted}`}>{t.groups[g]}</span>
                    <small>{t.noneYet}</small>
                  </div>
                </div>
              );
            }
            const rated = list.filter((r) => r.cls !== 'pause');
            const ok = nOk(rated);
            const cls = ok === rated.length ? 'ok' : ok === 0 ? 'bad' : 'warn';
            const open = openGroups.has(g);
            return (
              <div key={g} className={styles.bar} id={`group-${g}`}>
                <div className={styles.row}>
                  <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={`group-${g}-list`} onClick={() => toggleGroup(g)}>
                    <span className={styles.chev} aria-hidden="true" />
                    <span className={styles.barTitle}>
                      <span className={styles.barName}>{t.groups[g]}</span>
                      <small>{t.nSets(list.length)}</small>
                    </span>
                  </button>
                  <span className={`${styles.status} ${styles[cls]}`}>{cls === 'ok' ? t.allCurrent : t.ofCurrent(ok, rated.length)}</span>
                </div>
                <Strip checks={groupChecks(list)} end={live.checked} firstEver={firstEver} t={t}
                  incidents={incidents.filter((x) => x.datasets.some((d) => list.some((r) => r.c.key === d.key)))} />
                {t.groupNote && t.groupNote[g] && (
                  <p className={styles.groupNote}>
                    {t.groupNote[g].pre}<a href={t.groupNote[g].url}>{t.groupNote[g].link}</a>{t.groupNote[g].post}
                  </p>
                )}
                <div id={`group-${g}-list`} className={styles.groupList} hidden={!open}>
                  {list.map(renderItem)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <Incidents incidents={history && history.incidents} byKey={byKey} name={name} t={t} />

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
          {t.how.map((p, i) => <p key={i}>{p}</p>)}
        </div>
      </details>
    </div>
  );
}
