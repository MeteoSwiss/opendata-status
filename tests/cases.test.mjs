// Shared test cases (tests/cases.json) against src/rules.mjs, the rules of the live status in the browser.
// The same cases run against scripts/ogd_monitor.py in tests/test_cases.py.
// Run: node tests/cases.test.mjs   (or npm test; Node 18+, no dependencies)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {classify, parseRef, pauseEnd, refFromName, selectRun} from '../src/rules.mjs';

const read = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const CASES = read('./cases.json');
const CONFIG = Object.fromEntries(read('../config.json').items.map((c) => [c.key, c]));

const item = (v) => (typeof v === 'string' ? CONFIG[v] : v);
const t = (s) => (s ? new Date(s) : null);
// same format as iso() in scripts/ogd_monitor.py
const iso = (d) => (d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : null);

test('classify', async (tc) => {
  for (const c of CASES.classify) {
    await tc.test(c.name, () => {
      const r = classify(item(c.item), t(c.now), {updated: t(c.updated), ref: t(c.ref), available: t(c.available)});
      assert.equal(r.cls, c.expect.status);
      if (c.expect.value === null) assert.equal(r.value, null);
      else assert.ok(Math.abs(r.value - c.expect.value) <= 0.1, `value ${r.value}, expected ${c.expect.value}`);
    });
  }
});

test('pauseEnd', async (tc) => {
  for (const c of CASES.pause_end) {
    await tc.test(c.name, () => assert.equal(iso(pauseEnd(item(c.item), t(c.now))), c.expect));
  }
});

test('refFromName', async (tc) => {
  for (const c of CASES.ref_time_from_name) {
    await tc.test(c.name, () => {
      if (c.expect === 'error') assert.throws(() => refFromName(c.file, c.source));
      else assert.equal(iso(refFromName(c.file, c.source)), c.expect);
    });
  }
});

test('parseRef', async (tc) => {
  for (const c of CASES.parse_ref) {
    await tc.test(JSON.stringify(c.value), () => assert.equal(iso(parseRef(c.value)), c.expect));
  }
});

test('selectRun', async (tc) => {
  for (const c of CASES.select_run) {
    await tc.test(c.name, () => {
      const runs = new Map(Object.entries(c.runs).map(([k, vs]) => [+t(k), vs.map(t)]));
      const r = selectRun(runs, t(c.now), c.ok_max_min);
      const got = r.ref ? {ref: iso(r.ref), available: iso(r.available), run: r.run} : null;
      assert.deepEqual(got, c.expect);
    });
  }
});
