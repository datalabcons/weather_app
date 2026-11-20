// Tests use a fake fetch, so they run offline and never use up API quota.
// Run with: npm test

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { createApp } = require('../src/app');
const { createWeatherService } = require('../src/weatherService');
const { MemoryCache, ResilientCache } = require('../src/cache');
const { sampleResponse } = require('./fixtures');

const baseConfig = {
  weatherApiKey: 'test-key',
  weatherApiBaseUrl: 'https://weather.example/timeline',
  cacheTtlSeconds: 3600,
  rateLimitMax: 100,
  rateLimitWindowMs: 60_000,
  upstreamTimeoutMs: 500,
};

// A fake fetch that records calls and returns whatever the test sets up.
function fakeFetch() {
  const calls = [];
  let responder = (url) => jsonResponse(200, sampleResponse(decodeURIComponent(url.pathname.split('/')[2])));
  const fn = async (url, opts) => {
    calls.push(url);
    return responder(url, opts);
  };
  fn.calls = calls;
  fn.respondWith = (r) => {
    responder = r;
  };
  return fn;
}

function jsonResponse(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function startServer(overrides = {}) {
  const config = { ...baseConfig, ...overrides.config };
  const cache = overrides.cache || new MemoryCache();
  const fetchImpl = overrides.fetch || fakeFetch();
  const weatherService = createWeatherService({ cache, config, fetchImpl });
  const app = createApp({ weatherService, cache, config });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://localhost:${server.address().port}`;
  return { base, fetchImpl, close: () => server.close() };
}

describe('GET /api/weather', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await startServer();
  });
  afterEach(() => ctx.close());

  test('returns shaped weather data from the provider', async () => {
    const res = await fetch(`${ctx.base}/api/weather?location=Lagos`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();

    assert.strictEqual(body.location.resolvedAddress, 'Lagos, Lagos, Nigeria');
    assert.strictEqual(body.current.temp, 31.2);
    assert.strictEqual(body.units.temp, '°C');
    assert.strictEqual(body.daily.length, 7);
    assert.strictEqual(body.hourly.length, 24);
    assert.strictEqual(body.hourly[0].time, '14:00:00'); // starts from the current hour
    assert.strictEqual(body.meta.source, 'api');

    const calledUrl = ctx.fetchImpl.calls[0];
    assert.strictEqual(calledUrl.searchParams.get('key'), 'test-key');
    assert.strictEqual(calledUrl.searchParams.get('unitGroup'), 'metric');
  });

  test('second request is served from cache without calling the provider', async () => {
    await fetch(`${ctx.base}/api/weather?location=Lagos`);
    const res = await fetch(`${ctx.base}/api/weather?location=%20%20lagos%20`);
    const body = await res.json();

    assert.strictEqual(body.meta.source, 'cache');
    assert.ok(body.meta.expiresInSeconds > 0 && body.meta.expiresInSeconds <= 3600);
    assert.strictEqual(ctx.fetchImpl.calls.length, 1, 'provider should be called once');
  });

  test('different units are cached separately', async () => {
    await fetch(`${ctx.base}/api/weather?location=Lagos&unit=metric`);
    const res = await fetch(`${ctx.base}/api/weather?location=Lagos&unit=us`);
    const body = await res.json();
    assert.strictEqual(body.meta.source, 'api');
    assert.strictEqual(body.units.temp, '°F');
    assert.strictEqual(ctx.fetchImpl.calls.length, 2);
  });

  test('path-style URL works too', async () => {
    const res = await fetch(`${ctx.base}/api/weather/Abuja`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).location.query, 'Abuja');
  });

  test('missing location returns 400', async () => {
    const res = await fetch(`${ctx.base}/api/weather`);
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error.code, 'LOCATION_REQUIRED');
  });

  test('over-long location returns 400', async () => {
    const res = await fetch(`${ctx.base}/api/weather?location=${'a'.repeat(101)}`);
    assert.strictEqual(res.status, 400);
  });

  test('unknown place returns 404 with a friendly message', async () => {
    ctx.fetchImpl.respondWith(() => jsonResponse(400, 'Bad API Request:Invalid location parameter value.'));
    const res = await fetch(`${ctx.base}/api/weather?location=Notarealplace`);
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'LOCATION_NOT_FOUND');
    assert.match(body.error.message, /Notarealplace/);
  });

  test('bad API key becomes a 502 without leaking details', async () => {
    ctx.fetchImpl.respondWith(() => jsonResponse(401, 'No account found with API key test-key'));
    const res = await fetch(`${ctx.base}/api/weather?location=Lagos`);
    assert.strictEqual(res.status, 502);
    const text = await res.text();
    assert.doesNotMatch(text, /test-key/);
  });

  test('provider daily limit becomes a 503', async () => {
    ctx.fetchImpl.respondWith(() => jsonResponse(429, 'Too many requests'));
    const res = await fetch(`${ctx.base}/api/weather?location=Lagos`);
    assert.strictEqual(res.status, 503);
  });

  test('provider down becomes a 502', async () => {
    ctx.fetchImpl.respondWith(() => {
      throw new TypeError('fetch failed');
    });
    const res = await fetch(`${ctx.base}/api/weather?location=Lagos`);
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await res.json()).error.code, 'UPSTREAM_UNREACHABLE');
  });

  test('slow provider times out with a 504', async () => {
    ctx.fetchImpl.respondWith(
      (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        })
    );
    const res = await fetch(`${ctx.base}/api/weather?location=Lagos`);
    assert.strictEqual(res.status, 504);
  });

  test('failed requests are not cached', async () => {
    ctx.fetchImpl.respondWith(() => jsonResponse(500, 'oops'));
    await fetch(`${ctx.base}/api/weather?location=Lagos`);
    ctx.fetchImpl.respondWith(() => jsonResponse(200, sampleResponse('Lagos')));
    const res = await fetch(`${ctx.base}/api/weather?location=Lagos`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).meta.source, 'api');
  });
});

test('missing API key gives a clear error', async () => {
  const ctx = await startServer({ config: { weatherApiKey: '' } });
  const res = await fetch(`${ctx.base}/api/weather?location=Lagos`);
  assert.strictEqual(res.status, 500);
  assert.strictEqual((await res.json()).error.code, 'MISSING_API_KEY');
  ctx.close();
});

test('rate limiter returns 429 after the limit', async () => {
  const ctx = await startServer({ config: { rateLimitMax: 2 } });
  await fetch(`${ctx.base}/api/weather?location=Lagos`);
  await fetch(`${ctx.base}/api/weather?location=Lagos`);
  const res = await fetch(`${ctx.base}/api/weather?location=Lagos`);
  assert.strictEqual(res.status, 429);
  assert.strictEqual((await res.json()).error.code, 'RATE_LIMITED');
  assert.ok(res.headers.get('ratelimit'));
  ctx.close();
});

test('health endpoint and frontend are served', async () => {
  const ctx = await startServer();
  const health = await (await fetch(`${ctx.base}/api/health`)).json();
  assert.strictEqual(health.status, 'ok');
  assert.strictEqual(health.cache, 'memory');

  const page = await fetch(`${ctx.base}/`);
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /Skycast/);

  assert.strictEqual((await fetch(`${ctx.base}/api/nope`)).status, 404);
  ctx.close();
});

test('cache falls back to memory when Redis errors', async () => {
  const brokenRedis = {
    type: 'redis',
    isReady: () => true,
    get: async () => {
      throw new Error('connection lost');
    },
    set: async () => {
      throw new Error('connection lost');
    },
    ttl: async () => {
      throw new Error('connection lost');
    },
    close: async () => {},
  };
  const cache = new ResilientCache(brokenRedis, new MemoryCache());
  const ctx = await startServer({ cache });

  const first = await fetch(`${ctx.base}/api/weather?location=Lagos`);
  assert.strictEqual(first.status, 200);
  const second = await (await fetch(`${ctx.base}/api/weather?location=Lagos`)).json();
  assert.strictEqual(second.meta.source, 'cache');
  assert.strictEqual(ctx.fetchImpl.calls.length, 1);
  ctx.close();
});
