// Cache layer.
// Uses Redis when REDIS_URL is set. If Redis isn't configured or goes down,
// it falls back to an in-memory cache so the API keeps working.

const { createClient } = require('redis');

class MemoryCache {
  constructor() {
    this.store = new Map();
    this.type = 'memory';
  }

  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key, value, ttlSeconds) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async ttl(key) {
    const entry = this.store.get(key);
    if (!entry) return -2;
    return Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000));
  }

  isReady() {
    return true;
  }

  async close() {}
}

class RedisCache {
  constructor(client) {
    this.client = client;
    this.type = 'redis';
  }

  async get(key) {
    return this.client.get(key);
  }

  async set(key, value, ttlSeconds) {
    // SET with EX stores the value and its expiry in one step.
    await this.client.set(key, value, { EX: ttlSeconds });
  }

  async ttl(key) {
    return this.client.ttl(key);
  }

  isReady() {
    return this.client.isReady;
  }

  async close() {
    if (this.client.isOpen) await this.client.quit();
  }
}

// Wraps Redis so that any Redis error falls back to memory instead of
// failing the user's request. A cache is an optimisation, not a dependency.
class ResilientCache {
  constructor(primary, fallback) {
    this.primary = primary;
    this.fallback = fallback;
  }

  get type() {
    return this.primary.isReady() ? this.primary.type : this.fallback.type;
  }

  async run(method, ...args) {
    if (this.primary.isReady()) {
      try {
        return await this.primary[method](...args);
      } catch (err) {
        console.warn(`Redis ${method} failed, using memory cache: ${err.message}`);
      }
    }
    return this.fallback[method](...args);
  }

  get(key) {
    return this.run('get', key);
  }

  set(key, value, ttl) {
    return this.run('set', key, value, ttl);
  }

  ttl(key) {
    return this.run('ttl', key);
  }

  isReady() {
    return true;
  }

  async close() {
    await this.primary.close();
  }
}

async function createCache(redisUrl) {
  const memory = new MemoryCache();
  if (!redisUrl) {
    console.log('REDIS_URL not set: using in-memory cache.');
    return memory;
  }

  const client = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 5000,
      // Retry with a growing delay, capped at 10s.
      reconnectStrategy: (retries) => Math.min(retries * 500, 10000),
    },
  });
  client.on('error', (err) => console.warn(`Redis error: ${err.message}`));
  client.on('ready', () => console.log('Connected to Redis.'));

  try {
    await client.connect();
  } catch (err) {
    console.warn(`Could not connect to Redis (${err.message}). Using in-memory cache for now.`);
  }

  return new ResilientCache(new RedisCache(client), memory);
}

module.exports = { createCache, MemoryCache, RedisCache, ResilientCache };
