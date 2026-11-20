// All settings come from environment variables (see .env.example).

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

module.exports = {
  port: toInt(process.env.PORT, 3000),
  weatherApiKey: process.env.WEATHER_API_KEY || '',
  weatherApiBaseUrl:
    process.env.WEATHER_API_BASE_URL ||
    'https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline',
  redisUrl: process.env.REDIS_URL || '',
  // How long a weather result stays in the cache (default: 1 hour).
  cacheTtlSeconds: toInt(process.env.CACHE_TTL_SECONDS, 60 * 60),
  // Rate limit: max requests per IP in each window (default: 60 per 15 minutes).
  rateLimitMax: toInt(process.env.RATE_LIMIT_MAX, 60),
  rateLimitWindowMs: toInt(process.env.RATE_LIMIT_WINDOW_MINUTES, 15) * 60 * 1000,
  // How long to wait for the weather service before giving up.
  upstreamTimeoutMs: toInt(process.env.UPSTREAM_TIMEOUT_MS, 8000),
};
