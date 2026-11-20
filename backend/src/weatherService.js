// Talks to the 3rd-party weather API (Visual Crossing), checks the cache
// first, and reshapes the response into a smaller, frontend-friendly format.

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const UNITS = {
  metric: { temp: '°C', speed: 'km/h', distance: 'km', precip: 'mm', pressure: 'mb' },
  us: { temp: '°F', speed: 'mph', distance: 'mi', precip: 'in', pressure: 'mb' },
};

function normaliseLocation(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function validateLocation(location) {
  if (!location) {
    throw new ApiError(400, 'Please provide a location, e.g. ?location=Lagos', 'LOCATION_REQUIRED');
  }
  if (location.length > 100) {
    throw new ApiError(400, 'Location must be 100 characters or fewer.', 'LOCATION_TOO_LONG');
  }
}

function cacheKey(location, unit) {
  return `weather:${unit}:${location.toLowerCase()}`;
}

// Keep only the fields the app needs, so we cache and send less data.
function shapeResponse(data, unit) {
  const cur = data.currentConditions || {};
  const today = (data.days && data.days[0]) || {};

  const pickHour = (h) => ({
    time: h.datetime,
    epoch: h.datetimeEpoch,
    temp: h.temp,
    icon: h.icon,
    conditions: h.conditions,
    precipProb: h.precipprob,
  });

  // Next 24 hours starting from the current hour (spans today and tomorrow).
  const nowEpoch = cur.datetimeEpoch || 0;
  const allHours = (data.days || []).slice(0, 2).flatMap((d) => d.hours || []);
  const next24 = allHours.filter((h) => h.datetimeEpoch > nowEpoch - 3600).slice(0, 24);

  return {
    location: {
      query: data.address,
      resolvedAddress: data.resolvedAddress,
      timezone: data.timezone,
      latitude: data.latitude,
      longitude: data.longitude,
    },
    unit,
    units: UNITS[unit],
    summary: data.description || today.description || '',
    current: {
      time: cur.datetime,
      temp: cur.temp,
      feelsLike: cur.feelslike,
      humidity: cur.humidity,
      dewPoint: cur.dew,
      windSpeed: cur.windspeed,
      windGust: cur.windgust,
      windDir: cur.winddir,
      pressure: cur.pressure,
      visibility: cur.visibility,
      cloudCover: cur.cloudcover,
      uvIndex: cur.uvindex,
      precipProb: cur.precipprob ?? today.precipprob,
      conditions: cur.conditions,
      icon: cur.icon,
      sunrise: cur.sunrise || today.sunrise,
      sunset: cur.sunset || today.sunset,
    },
    hourly: next24.map(pickHour),
    daily: (data.days || []).slice(0, 7).map((d) => ({
      date: d.datetime,
      tempMax: d.tempmax,
      tempMin: d.tempmin,
      precipProb: d.precipprob,
      conditions: d.conditions,
      description: d.description,
      icon: d.icon,
      sunrise: d.sunrise,
      sunset: d.sunset,
      uvIndex: d.uvindex,
      windSpeed: d.windspeed,
      humidity: d.humidity,
    })),
  };
}

async function readUpstreamError(res) {
  const text = await res.text().catch(() => '');
  return text.slice(0, 200);
}

function createWeatherService({ cache, config, fetchImpl = globalThis.fetch }) {
  async function fetchFromProvider(location, unit) {
    if (!config.weatherApiKey) {
      throw new ApiError(500, 'The server is missing its weather API key.', 'MISSING_API_KEY');
    }

    const url = new URL(`${config.weatherApiBaseUrl}/${encodeURIComponent(location)}/next7days`);
    url.searchParams.set('unitGroup', unit);
    url.searchParams.set('include', 'current,days,hours');
    url.searchParams.set('contentType', 'json');
    url.searchParams.set('key', config.weatherApiKey);

    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(config.upstreamTimeoutMs) });
    } catch (err) {
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      throw new ApiError(
        timedOut ? 504 : 502,
        timedOut
          ? 'The weather service took too long to respond. Please try again.'
          : 'Could not reach the weather service. Please try again later.',
        timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE'
      );
    }

    if (!res.ok) {
      const detail = await readUpstreamError(res);
      if (res.status === 400 || res.status === 404) {
        throw new ApiError(404, `We couldn't find a place called "${location}".`, 'LOCATION_NOT_FOUND');
      }
      if (res.status === 401) {
        console.error(`Weather API rejected the key: ${detail}`);
        throw new ApiError(502, 'The weather service rejected our API key.', 'UPSTREAM_AUTH');
      }
      if (res.status === 429) {
        throw new ApiError(503, 'The weather service is busy (daily limit reached). Try again later.', 'UPSTREAM_LIMIT');
      }
      console.error(`Weather API error ${res.status}: ${detail}`);
      throw new ApiError(502, 'The weather service returned an error. Please try again later.', 'UPSTREAM_ERROR');
    }

    return res.json();
  }

  async function getWeather(rawLocation, rawUnit = 'metric') {
    const location = normaliseLocation(rawLocation);
    validateLocation(location);
    const unit = rawUnit === 'us' ? 'us' : 'metric';
    const key = cacheKey(location, unit);

    // 1. Check the cache
    const cached = await cache.get(key);
    if (cached) {
      const entry = JSON.parse(cached);
      const ttl = await cache.ttl(key);
      return {
        ...entry.data,
        meta: { source: 'cache', cachedAt: entry.cachedAt, expiresInSeconds: ttl, cacheType: cache.type },
      };
    }

    // 2-4. Not cached: call the weather service and reshape the result
    const raw = await fetchFromProvider(location, unit);
    const data = shapeResponse(raw, unit);

    // 5. Save to the cache with an expiry
    const cachedAt = new Date().toISOString();
    await cache.set(key, JSON.stringify({ data, cachedAt }), config.cacheTtlSeconds);

    return {
      ...data,
      meta: { source: 'api', cachedAt, expiresInSeconds: config.cacheTtlSeconds, cacheType: cache.type },
    };
  }

  return { getWeather };
}

module.exports = { createWeatherService, ApiError, shapeResponse, normaliseLocation };
