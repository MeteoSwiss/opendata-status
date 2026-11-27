// Time limits of the live query (src/stac.mjs): a stalled request must never hold up the page.
// Run: node --test tests/stac.test.mjs
import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {measureWithDeadline, request, withDeadline} from '../src/stac.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// a server that never answers, but stops when the request is aborted (like the browser's fetch)
const stalledFetch = () => (url, {signal}) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
});

test('request: a stalled request is aborted after the time limit', async () => {
  globalThis.fetch = stalledFetch();
  const start = Date.now();
  await assert.rejects(request('https://example.org/x', {}, (r) => r.json(), 50), {name: 'AbortError'});
  assert.ok(Date.now() - start < 1000);
});

test('request: the time limit also covers reading the body', async () => {
  globalThis.fetch = (url, {signal}) => Promise.resolve({
    ok: true,
    json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  await assert.rejects(request('https://example.org/x', {}, (r) => r.json(), 50), /aborted/);
});

test('request: HTTP errors are errors', async () => {
  globalThis.fetch = () => Promise.resolve({ok: false, status: 503});
  await assert.rejects(request('https://example.org/x'), /HTTP 503/);
});

test('request: answer within the time limit, no request is cached', async () => {
  let options;
  globalThis.fetch = (url, o) => { options = o; return Promise.resolve({ok: true, json: () => Promise.resolve({a: 1})}); };
  assert.deepEqual(await request('https://example.org/x', {}, (r) => r.json(), 50), {a: 1});
  assert.equal(options.cache, 'no-store');
});

test('withDeadline: code that ignores the abort cannot hold up the result', async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 50, 'smn'), /smn: timeout after 50 ms/);
  assert.equal(await withDeadline(Promise.resolve(42), 50), 42);
});

test('measureWithDeadline: a stalled STAC API makes the measurement fail', async (tc) => {
  tc.mock.timers.enable({apis: ['setTimeout']}); // simulated clock: no real 20-second request timer
  globalThis.fetch = () => new Promise(() => {}); // never answers and ignores the abort as well
  const item = {key: 'smn', collection: 'ch.meteoschweiz.ogd-smn', metric: 'age'};
  const measuring = measureWithDeadline('https://example.org/api', item, 50);
  tc.mock.timers.tick(50);
  await assert.rejects(measuring, /smn: timeout/);
});
