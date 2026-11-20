require('dotenv').config();

const config = require('./src/config');
const { createCache } = require('./src/cache');
const { createWeatherService } = require('./src/weatherService');
const { createApp } = require('./src/app');

async function main() {
  if (!config.weatherApiKey) {
    console.warn('⚠️  WEATHER_API_KEY is not set. Weather requests will fail until you add it.');
  }

  const cache = await createCache(config.redisUrl);
  const weatherService = createWeatherService({ cache, config });
  const app = createApp({ weatherService, cache, config });

  const server = app.listen(config.port, () => {
    console.log(`Weather API running at http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    server.close();
    await cache.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
