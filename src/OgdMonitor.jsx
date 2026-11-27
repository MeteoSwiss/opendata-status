import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import config from '../config.json';
import strings from './strings';
import styles from './styles.module.css';
import {currentStatus} from './rules.mjs';
import {fetchJson, measureWithDeadline} from './stac.mjs';
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
// The page rates at the current time, which advances every TICK_MS even when no query returns.
const TICK_MS = 30e3;
// The latest scheduled check counts for this long (it runs every 30 minutes); also the limit after
// which the page says that the scheduled check has stopped.
const CHECK_MAX_MS = 60 * 60e3;
const KNOWN = ['ok', 'warn', 'bad'];
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

  // live query per dataset: {m, measuredAt (start of the last successful query), failedAt}
  const [live, setLive] = useState({});
  const [history, setHistory] = useState(null); // {summary, items, latest, incidents, error, loadedAt}
  const [now, setNow] = useState(() => new Date());
  const liveMaxMs = 2 * refreshMinutes * 60e3; // a live result counts for two refresh intervals
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

  // Each dataset is queried on its own and updates the page as soon as it returns; a dataset whose
  // query is still running is skipped, so that stalled queries do not pile up.
  const running = useRef(new Set());
  const loadLive = useCallback(() => {
    config.items.forEach(async (c) => {
      if (running.current.has(c.key)) return;
      running.current.add(c.key);
      const started = new Date();
      try {
        const m = await measureWithDeadline(config.stac_api, c);
        setLive((prev) => ({...prev, [c.key]: {...prev[c.key], m, measuredAt: started}}));
      } catch {
        setLive((prev) => ({...prev, [c.key]: {...prev[c.key], failedAt: new Date()}}));
      } finally {
        running.current.delete(c.key);
        setNow(new Date());
      }
    });
  }, []);

  const historyRunning = useRef(false);
  const loadHistory = useCallback(async () => {
    if (historyRunning.current) return;
    historyRunning.current = true;
    try {
      const [summary, items, latest, incidentsDoc] = await Promise.all([
        fetchJson(`${dataUrl}/history.json`),
        fetchJson(`${dataUrl}/history_items.json`),
        // latest scheduled check: download test, and fallback when the live query fails
        fetchJson(`${dataUrl}/status.json`).catch(() => []),
        fetchJson(`${dataUrl}/incidents.json`).catch(() => null),
      ]);
      setHistory({summary, items, latest, incidents: incidentsDoc ? incidentsDoc.incidents : null, loadedAt: new Date()});
    } catch {
      // keep what was loaded before; its age shows in the notice about the scheduled check
      setHistory((prev) => (prev ? {...prev, error: true} : {error: true, summary: [], items: [], latest: []}));
    } finally {
      historyRunning.current = false;
    }
  }, [dataUrl]);

  useEffect(() => {
    const refresh = () => { setNow(new Date()); loadLive(); loadHistory(); };
    refresh();
    const tick = setInterval(() => setNow(new Date()), TICK_MS);
    const poll = setInterval(refresh, refreshMinutes * 60e3);
    // timers are throttled in background tabs and stop while the computer sleeps:
    // when the page becomes visible again, rate at the current time and query at once
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(tick); clearInterval(poll); document.removeEventListener('visibilitychange', onVisible); };
  }, [loadLive, loadHistory, refreshMinutes]);

  const rows = useMemo(() => {
    const latestByKey = Object.fromEntries(((history && history.latest) || []).map((x) => [x.key, x]));
    return config.items.map((c) => {
      const latest = latestByKey[c.key];
      const res = currentStatus(c, now, live[c.key], latest, {liveMaxMs, checkMaxMs: CHECK_MAX_MS});
      let cls = res.cls;
      // The browser only reads the catalog; whether the newest file can actually be downloaded is
      // tested by the scheduled check (every 30 min). A failed test from the last hour makes the
      // dataset down, even if the catalog looks fresh.
      const access = latest && latest.access;
      const recent = latest && now - new Date(latest.checked) < CHECK_MAX_MS;
      const noAccess = access && !access.ok && recent && ['ok', 'warn'].includes(cls) ? {...access, checked: new Date(latest.checked)} : null;
      if (noAccess) cls = 'bad';
      return {c, m: res.m, value: res.value, stalled: res.stalled, cls, noAccess, source: res.source, at: res.at};
    });
  }, [now, live, history, liveMaxMs]);

  // deep link: once the data are there, scroll to the opened group or dataset
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !window.location.hash || rows.every((r) => r.cls === 'checking')) return;
    scrolled.current = true;
    const el = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (el) requestAnimationFrame(() => el.scrollIntoView());
  }, [rows]);

  const monitored = rows.filter((r) => r.cls !== 'static' && r.cls !== 'pause');
  const realtime = monitored.filter((r) => r.c.realtime);
  const nOk = (a) => a.filter((r) => r.cls === 'ok').length;
  // status of several datasets: green only when every one has a current status and is up to date;
  // grey when there is no current status (still querying, failed or expired)
  const overall = (list) => {
    const known = list.filter((r) => KNOWN.includes(r.cls));
    if (!known.length) return list.some((r) => r.cls === 'checking') ? 'checking' : 'unknown';
    const ok = nOk(known);
    if (ok < known.length) return ok === 0 ? 'bad' : 'warn';
    return known.length === list.length ? 'ok' : 'unknown';
  };
  const rtOk = nOk(realtime);
  const monOk = nOk(monitored);
  const knownMon = monitored.filter((r) => KNOWN.includes(r.cls));
  const rtCls = overall(realtime);
  const allCls = overall(monitored);
  // headline dot: a known problem comes first (real-time datasets as they are, others as delayed),
  // then green only if everything is current and up to date, else grey
  const problem = (cls) => cls === 'warn' || cls === 'bad';
  const dotCls = problem(rtCls) ? rtCls : problem(allCls) ? 'warn'
    : rtCls === 'ok' && allCls === 'ok' ? 'ok' : [rtCls, allCls].includes('checking') ? 'checking' : 'unknown';
  // where the shown status comes from, and how old it is (oldest measurement per source)
  const oldest = (source) => {
    const ats = monitored.filter((r) => r.source === source).map((r) => +r.at);
    return ats.length ? new Date(Math.min(...ats)) : null;
  };
  const liveAt = oldest('live');
  const checkAt = oldest('check');
  const asOf = [liveAt && t.liveAt(fmtTime(liveAt, t, true)), checkAt && t.checkAt(fmtTime(checkAt, t, true))]
    .filter(Boolean).join(' · ') || t.noCurrent;

  const hist = history || {summary: [], items: []};
  const incidents = (history && history.incidents) || [];
  const byKey = Object.fromEntries(rows.map((r) => [r.c.key, r]));
  const sumRt = hist.summary.reduce((s, h) => s + h.realtime_ok, 0);
  const totRt = hist.summary.reduce((s, h) => s + h.realtime_total, 0);
  const avg30 = totRt ? sumRt / totRt : null;
  const allChecks = [...hist.summary.map((h) => +new Date(h.checked))];
  const firstEver = allChecks.length ? new Date(Math.min(...allChecks)) : now;
  // the scheduled check runs every 30 minutes: say so when it has stopped (e.g. workflow disabled)
  const lastCheck = allChecks.length ? new Date(Math.max(...allChecks)) : null;
  const checkOverdue = history && lastCheck && now - lastCheck > CHECK_MAX_MS;

  // short text of what was measured: latency or age of the newest data
  const describe = (r) => {
    if (r.noAccess) return t.notDownloadable(r.noAccess.host, r.noAccess.error || `HTTP ${r.noAccess.http_status}`);
    if (r.c.metric === 'latency') return r.stalled ? `${t.noNewData}, ${t.latShort(fmtAge(r.value, t))}` : t.latShort(fmtAge(r.value, t));
    return t.valAge(fmtAge(r.value, t, true));
  };

  const late = monitored.filter((r) => r.cls !== 'ok' && r.cls !== 'checking');
  const out = late.filter((r) => r.cls === 'bad');
  const delayed = late.filter((r) => r.cls === 'warn');
  const unknown = late.filter((r) => r.cls === 'unknown' || r.cls === 'stale');
  const unreachable = out.filter((r) => r.noAccess);
  const stale = out.filter((r) => !r.noAccess);
  const anyChecking = monitored.some((r) => r.cls === 'checking');
  const title = !late.length ? (anyChecking ? t.loading : t.allOk)
    : unknown.length === monitored.length ? t.noCurrent : [
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
    // the live query as the newest point (results of the scheduled check are in the history already)
    if (r.source === 'live') pts.push({t: r.at, cls: r.cls, text: `${t.status[r.cls]} · ${describe(r)} (${t.live} ${fmtClock(r.at, t)})`});
    return pts;
  };

  // one compact entry per dataset: title, key figure and status on one line, slim strip, details below
  const keyFigure = (r) => {
    if (r.c.monitoring_pending || r.value === null || r.value === undefined) return '–';
    return r.c.metric === 'latency' ? t.valLat(fmtAge(r.value, t)) : t.valAge(fmtAge(r.value, t, true));
  };
  const renderItem = (r) => (
      <div key={r.c.key} id={`monitor-${r.c.key}`}
        className={[styles.service, r.c.sub && styles.sub, !['ok', 'pause'].includes(r.cls) && styles.attention].filter(Boolean).join(' ')}>
        <div className={styles.row}>
          <div className={styles.name}>
            {r.c.doc ? <a href={docUrl(r.c.doc, locale)}>{name(r.c)}</a> : name(r.c)}
            {r.c.realtime && <span className={styles.tag}>{t.realtimeTag}</span>}
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
          : <Strip checks={itemChecks(r)} end={now} firstEver={firstEver} t={t}
              incidents={incidents.filter((x) => x.datasets.some((d) => d.key === r.c.key))} />}
        <p className={styles.statLine}>{segments(r.c.collection.replace('ch.meteoschweiz.', '') + ' · ' + (r.c.metric === 'latency'
          ? t.metaLat(fmtAge(r.c.ok_max_min, t), fmtTime(r.m.ref, t))
            + (r.m.run ? ` · ${r.m.run.complete ? t.allParams(r.m.run.expected) : t.someParams(r.m.run.files, r.m.run.expected)}` : '')
            + (r.stalled ? ` · ${t.noNewData}` : '')
            + (r.m.stations ? ` · ${t.stations(r.m.stations.ok, r.m.stations.total)}${r.m.stations.stale.length ? ` · ${t.staleList}${r.m.stations.stale.join(', ')}` : ''}` : '')
          : t.metaAge(fmtAge(r.c.ok_max_min, t), t.interval[r.c.interval])
            // the absolute time only where «published … ago» is long ago
            + (r.value >= 1440 && r.m.updated ? ` · ${t.lastPub(fmtTime(r.m.updated, t))}` : '')
            + (r.m.modelRun ? ` · ${t.modelRun(fmtTime(r.m.modelRun, t))}` : ''))
          + (r.noAccess ? ` · ${t.notDownloadable(r.noAccess.host, r.noAccess.error || `HTTP ${r.noAccess.http_status}`)} (${t.check} ${fmtClock(r.noAccess.checked, t)})` : '')
          + (r.c.season ? ` · ${t.pauseInfo}` : '')
          // the source per dataset only where it differs from the headline (some live, this one not)
          + (r.source === 'check' && liveAt ? ` · ${t.fromCheck(fmtClock(r.at, t))}` : '')
          + (r.cls === 'stale' && r.at ? ` · ${t.lastStatus(fmtTime(r.at, t))}` : ''))}</p>
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
    // the live query as the newest point, only when every dataset of the group has a current live result
    const rated = list.filter((r) => r.cls !== 'pause');
    if (rated.length && rated.every((r) => r.source === 'live' && KNOWN.includes(r.cls))) {
      const at = new Date(Math.min(...rated.map((r) => +r.at)));
      pts.push({
        t: at,
        ...summarize(rated.length, nOk(rated),
          rated.filter((r) => r.cls !== 'ok').map((r) => `${name(r.c)}: ${t.status[r.cls]}`),
          `${t.live} ${fmtClock(at, t)}`),
      });
    }
    return pts;
  };

  return (
    <div className={styles.monitor}>
      <div className={styles.headline}>
        <span className={`${styles.bigdot} ${styles[dotCls]}`} aria-hidden="true" />
        <div>
          <p className={styles.hlTitle}>{title}</p>
          {/* without any current status, say why instead of «0 of 6» */}
          {knownMon.length
            ? <p className={styles.muted}>{t.lead(rtOk, realtime.length, asOf)}</p>
            : !anyChecking && <p className={styles.muted}>{t.noCurrentLead}</p>}
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
        {history && history.error && !lastCheck && <p className={styles.notice}>{t.historyMissing(Boolean(liveAt))}</p>}
        {checkOverdue && <p className={styles.notice} role="status">{t.checkOverdue(fmtTime(lastCheck, t, true))}</p>}
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
            const cls = overall(rated);
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
                  <span className={`${styles.status} ${styles[cls]}`}>
                    {cls === 'ok' ? t.allCurrent
                      : !rated.some((r) => KNOWN.includes(r.cls)) ? t.status[cls === 'checking' ? 'checking' : 'stale']
                        : t.ofCurrent(ok, rated.length)}
                  </span>
                </div>
                <Strip checks={groupChecks(list)} end={now} firstEver={firstEver} t={t}
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
            <span className={styles.statLabel}>{t.kpiAvg}</span>
            <span className={`${styles.statValue} ${pctCls(avg30, 0.8)}`}>{fmtPct(avg30, t)}</span>
            <span className={styles.small}>{t.kpiAvgSub(hist.summary.length)}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t.kpiAll}</span>
            <span className={`${styles.statValue} ${pctCls(knownMon.length ? monOk / monitored.length : null, 0)}`}>{fmtPct(knownMon.length ? monOk / monitored.length : null, t)}</span>
            <span className={styles.small}>{knownMon.length ? t.kpiAllSub(monOk, monitored.length) : t.status.stale}</span>
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
