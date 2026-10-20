const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/static/common/app.js', 'utf8');

function environment({ native, denied = false, timestamp = Date.now() } = {}) {
  const requests = [];
  let watchSuccess, watchFailure;
  const fix = { coords: { latitude: -27.47, longitude: 153.03, altitude: 12, accuracy: 7 }, timestamp };
  const context = {
    window: { addEventListener() {}, pywebview: native ? { api: { native_location: native } } : undefined },
    document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; } },
    navigator: { geolocation: {
      getCurrentPosition(success, failure) { denied ? failure({ code: 1, message: 'Permission denied' }) : success(fix); },
      watchPosition(success, failure) { watchSuccess = success; watchFailure = failure; return 1; },
    } },
    localStorage: { getItem() { return 'browser-one'; }, setItem() {} },
    crypto: { randomUUID() { return 'new-browser'; } },
    setInterval() { return 1; }, clearInterval() {},
    fetch: async (path, options) => {
      requests.push({ path, options, body: options.body ? JSON.parse(options.body) : undefined });
      return { ok: true, json: async () => ({}) };
    },
    Date, Number, Promise, Error, Math, JSON, console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { api: context.window.issTracker, requests, context,
    update: () => watchSuccess(fix), fail: () => watchFailure({ message: 'Permission revoked' }) };
}

test('hosted browser uses its own provider without contacting server native endpoint', async () => {
  const env = environment();
  const fix = await env.api.setBrowserLocation();
  assert.equal(fix.provider, 'browser');
  assert.equal(fix.accuracy_m, 7);
  assert.ok(fix.timestamp.endsWith('Z'));
  assert.equal(env.requests[0].options.headers['X-OrbitDeck-Session'], 'browser-one');
  assert.equal(env.requests[0].path, '/api/v1/location');
  assert.ok(!env.requests.some((r) => r.path.includes('native-location')));
  env.update();
  await new Promise(setImmediate);
  assert.equal(env.requests.length, 2);
});

test('desktop provider failure falls through to browser permission/provider', async () => {
  const env = environment({ native: async () => { throw new Error('Native provider unavailable'); } });
  assert.equal((await env.api.setBrowserLocation()).provider, 'browser');
});

test('fresh desktop provider preserves timestamp and accuracy', async () => {
  const timestamp = Date.now();
  const env = environment({ native: async () => ({ lat: 1, lon: 2, accuracy_m: 25, timestamp: timestamp / 1000 }) });
  const fix = await env.api.setBrowserLocation();
  assert.equal(fix.provider, 'desktop');
  assert.equal(fix.accuracy_m, 25);
  assert.equal(new Date(fix.timestamp).getTime(), timestamp);
});

test('permission denial clears old server device fix and rejects', async () => {
  const env = environment({ denied: true });
  await assert.rejects(env.api.setBrowserLocation(), (e) => e.code === 1);
  assert.equal(env.requests[0].path, '/api/v1/location/device-unavailable');
  assert.equal(env.requests.length, 1);
});

test('permission revocation clears an already granted fix', async () => {
  const env = environment();
  await env.api.setBrowserLocation();
  await env.fail();
  assert.equal(env.requests.at(-1).path, '/api/v1/location/device-unavailable');
});

test('stale browser fix is rejected before publishing', async () => {
  const env = environment({ timestamp: Date.now() - 121000 });
  await assert.rejects(env.api.setBrowserLocation(), /stale/);
  assert.ok(env.requests.every((r) => r.path !== '/api/v1/location'));
});

test('stale desktop fix permits a fresh browser fallback', async () => {
  const env = environment({ native: async () => ({ lat: 1, lon: 2, timestamp: (Date.now() - 121000) / 1000 }) });
  assert.equal((await env.api.setBrowserLocation()).provider, 'browser');
});

test('status labels show unavailable without zero coordinates', () => {
  const env = environment();
  assert.equal(env.api.describeLocation({ available: false, lat: null, lon: null }), 'Location unavailable');
  assert.match(env.api.describeLocation({ available: true, source: 'radio_gps', lat: 0, lon: 0, age_seconds: 3, accuracy_m: 8 }), /Radio GPS: 0.0000, 0.0000.*3 s old.*8 m/);
});

test('cached fix age is recomputed rather than frozen at response time', () => {
  const env = environment();
  assert.equal(env.api.describeLocation({ available: true, source: 'radio_gps', lat: 1, lon: 2,
    timestamp: new Date(Date.now() - 31000).toISOString(), age_seconds: 1 }), 'Location unavailable (stale fix)');
});

test('APRS preview uses resolved station rather than the browsing device or last transmission', () => {
  const context = { window: {}, Number, Math, String };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('app/static/common/aprs-console.js', 'utf8'), context);
  const preview = context.window.OrbitDeckAprsConsole.buildPositionPreview;
  const state = { aprs: { settings: {}, runtime: { last_tx_text: 'old position' } }, location: {
    resolved: { lat: 50, lon: 50 }, stationResolved: { available: true, lat: 1, lon: 2 } } };
  assert.match(preview(state, ''), /0100.00N/);
  state.location.stationResolved = { available: false, lat: null, lon: null };
  assert.match(preview(state, ''), /unavailable/);
});
