// Formatting of durations, times, percentages and status lines (time zone Europe/Zurich).
import React from 'react';
import styles from './styles.module.css';

// ago: after «vor» (German dative: «vor 2 Tagen»)
export function fmtAge(min, t, ago = false) {
  if (min === null || min === undefined || Number.isNaN(min)) return t.unit.noData;
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} ${t.unit.min}`;
  if (m < 48 * 60) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return `${h} ${t.unit.h}${r ? ` ${r} ${t.unit.min}` : ''}`;
  }
  return `${Math.round(m / 1440)} ${ago ? t.unit.daysAgo : t.unit.days}`;
}

export function fmtTime(date, t, withYear = false) {
  if (!date) return '–';
  const o = {timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'};
  if (withYear) o.year = 'numeric';
  return new Date(date).toLocaleString(t.intl, o);
}

// Time span; on the same day the date only once: «27.11., 04:38–11:14»
export function fmtRange(start, end, t) {
  const day = (d) => new Date(d).toLocaleDateString(t.intl, {timeZone: 'Europe/Zurich'});
  if (end && day(start) === day(end)) return `${fmtTime(start, t)}–${fmtClock(end, t)}`;
  return `${fmtTime(start, t)} – ${end ? fmtTime(end, t) : ''}`;
}

export function fmtClock(date, t) {
  return new Date(date).toLocaleTimeString(t.intl, {timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit'});
}

export function fmtPct(v, t) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  const n = (Math.round(v * 1000) / 10).toLocaleString(t.intl);
  return t.intl === 'en-GB' ? `${n}%` : `${n} %`;
}

// Split a status line at " · " so that each part wraps as a whole on narrow screens.
export function segments(text) {
  return text.split(' · ').map((part, i) => (
    <React.Fragment key={i}>{i > 0 && ' '}<span className={styles.seg}>{i > 0 && '· '}{part}</span></React.Fragment>
  ));
}
