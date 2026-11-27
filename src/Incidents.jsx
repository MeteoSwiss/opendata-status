import React, {useEffect, useState} from 'react';
import {fmtAge, fmtClock, fmtRange, segments} from './format';
import styles from './styles.module.css';

// Consecutive reference times (ISO strings) as ranges «06:00–09:00», at most three, in local time
function ranges(list, intervalMin, t) {
  const ts = list.map((v) => new Date(v)).sort((a, b) => a - b);
  const out = [];
  ts.forEach((d) => {
    const last = out[out.length - 1];
    if (last && d - last[1] <= intervalMin * 60e3) last[1] = d;
    else out.push([d, d]);
  });
  const text = out.slice(0, 3).map(([a, b]) => (+a === +b ? fmtClock(a, t) : `${fmtClock(a, t)}–${fmtClock(b, t)}`)).join(', ');
  return text + (out.length > 3 ? ', …' : '') + t.bf.clock;
}

// After an incident: what was delivered late, what is incomplete, what is still missing
function describeBackfill(b, t) {
  const parts = [];
  if (b.late.length) parts.push(t.bf.late(b.unit, b.late.length, ranges(b.late, b.interval_min, t), fmtAge(b.max_delay_min, t)));
  if (b.incomplete.length) {
    const first = b.incomplete[0];
    parts.push(t.bf.incomplete(b.unit, b.incomplete.length, ranges(b.incomplete.map((x) => x.ref), b.interval_min, t), first.files, b.files_expected));
  }
  if (b.missing.length) parts.push(t.bf.missing(b.unit, b.missing.length, ranges(b.missing, b.interval_min, t)));
  if (!parts.length) parts.push(t.bf.allOnTime(b.unit));
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

// Incidents of the last 30 days, built by the scheduled check from the history (incidents.json)
export default function Incidents({incidents, byKey, name, t}) {
  const [all, setAll] = useState(false);
  const [target, setTarget] = useState(() => (typeof window === 'undefined' ? '' : window.location.hash.slice(1)));
  useEffect(() => {
    const onHash = () => setTarget(window.location.hash.slice(1));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const SHOW = 5;
  const idx = (incidents || []).findIndex((x) => `incident-${x.id}` === target);
  useEffect(() => {
    if (idx < 0) return;
    const el = document.getElementById(target);
    if (el) requestAnimationFrame(() => el.scrollIntoView({block: 'center'}));
  }, [target, idx]);
  if (!incidents) return null;
  const list = all || idx >= SHOW ? incidents : incidents.slice(0, SHOW);
  return (
    <div className={styles.section} id="incidents">
      <p className={styles.h2}>{t.incidentsTitle}</p>
      <p className={`${styles.small} ${styles.sub2}`}>{t.incidentsSub}</p>
      {!incidents.length && <p className={styles.small}>{t.noIncidents}</p>}
      <ol className={styles.incidents}>
        {list.map((x) => {
          // «no new data» is replaced by what was delivered late or is missing, once that is assessed
          const covered = (r) => r === 'no_new_data' && x.datasets.filter((d) => d.reasons.includes(r)).every((d) => d.backfill);
          const reasons = [...new Set(x.datasets.flatMap((d) => d.reasons))].filter((r) => !covered(r));
          // «30/32» (files of an incomplete model run) as «30 of 32 files»
          const details = [...new Set(x.datasets.flatMap((d) => d.details))]
            .map((d) => { const f = /^(\d+)\/(\d+)$/.exec(d); return f ? t.filesOf(f[1], f[2]) : d; });
          return (
            <li key={x.id} id={`incident-${x.id}`}
              className={[styles.incident, `incident-${x.id}` === target && styles.target].filter(Boolean).join(' ')}>
              <div className={styles.row}>
                <span className={styles.incWhen}>
                  {x.ongoing ? `${fmtRange(new Date(x.start), null, t)}${t.ongoing}` : fmtRange(new Date(x.start), new Date(x.end), t)}
                </span>
                <span className={`${styles.status} ${styles[x.severity]}`}>{t.status[x.severity]}</span>
              </div>
              <p className={styles.incWhat}>
                {x.datasets.map((d) => (byKey[d.key] ? name(byKey[d.key].c) : d.key)).join(', ')}
              </p>
              <p className={styles.statLine}>{segments([
                `${t.duration} ${fmtAge(x.duration_min, t)}${x.ongoing ? ` (${t.ongoing})` : ''}`,
                `${t.layerLabel}${t.layers[x.layer]}${x.hosts ? ` (${x.hosts.join(', ')})` : ''}`,
                reasons.length ? reasons.map((r) => t.reasons[r] || r).join(', ')
                  : x.datasets.some((d) => d.backfill) ? null : t.reasons.unknown,
                ...details.slice(0, 2),
              ].filter(Boolean).join(' · '))}</p>
              {x.datasets.some((d) => d.backfill) && (
                <ul className={styles.backfill}>
                  {x.datasets.filter((d) => d.backfill).map((d) => (
                    <li key={d.key}>{byKey[d.key] ? name(byKey[d.key].c) : d.key}{t.bf.colon}{describeBackfill(d.backfill, t)}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      {!all && incidents.length > list.length && (
        <button type="button" className={styles.more} onClick={() => setAll(true)}>{t.showAll(incidents.length)}</button>
      )}
    </div>
  );
}
