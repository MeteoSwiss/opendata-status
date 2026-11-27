// History strip: one bar per hour for the last 72 hours, with a popup per hour and the click
// through to the incident behind a failed hour.
import React, {useMemo, useRef, useState} from 'react';
import {fmtClock, fmtTime} from './format';
import styles from './styles.module.css';

const HOURS = 72;
const HOUR_MS = 3600e3;
const RANK = {pause: 0, ok: 1, warn: 2, bad: 3};

export default function Strip({checks, end, firstEver, t, incidents = []}) {
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
      if (inBin.length) cls = inBin.reduce((w, c) => (RANK[c.cls] > RANK[w] ? c.cls : w), inBin[0].cls);
      else if (firstEver && to < firstEver) cls = 'pre';
      // incident behind a failed hour, for the click through to the incident list
      const inc = cls === 'bad' || cls === 'warn'
        ? incidents.find((x) => new Date(x.start) < to && (x.end ? new Date(x.end) : end) >= from)
        : null;
      out.push({from, to, cls, checks: inBin, inc});
    }
    return out;
  }, [checks, end, firstEver, incidents]);

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
    else if (ev.key === 'Enter' && sel >= 0 && bins[sel].inc) window.location.hash = `incident-${bins[sel].inc.id}`;
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
        onClick={(ev) => { const x = bins[index(ev)]; if (x && x.inc) window.location.hash = `incident-${x.inc.id}`; }}
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
          {b.inc && <p className={styles.toIncident}>{t.toIncident}</p>}
        </div>
      )}
      <div className={styles.labels}><span>{t.hoursAgo}</span><span>{t.now}</span></div>
    </div>
  );
}
