const path = require('path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { ApiError } = require('./weatherService');

function createApp({ weatherService, cache, config }) {
  const app = express();

  app.set('trust proxy', 1); // real client IPs behind Render's proxy (for rate limiting)
  app.disable('x-powered-by');

  // Basic security headers
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    next();
  });

  /* ---------------- API ---------------- */

  const limiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a few minutes and try again.' },
      }),
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', cache: cache.type, uptimeSeconds: Math.round(process.uptime()) });
  });

  app.get('/api/weather', limiter, async (req, res) => {
    const { location, unit } = req.query;
    const result = await weatherService.getWeather(location, unit);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  });

  // Also allow /api/weather/Lagos as a friendlier URL
  app.get('/api/weather/:location', limiter, async (req, res) => {
    const result = await weatherService.getWeather(req.params.location, req.query.unit);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API endpoint.' } });
  });

  /* ---------------- Frontend ---------------- */

  app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

  /* ---------------- Errors ---------------- */

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side.' } });
  });

  return app;
}

module.exports = { createApp };
