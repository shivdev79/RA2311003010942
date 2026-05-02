'use strict';

const axios  = require('axios');
const logger = require('logging_middleware');
const config = require('./config');

const api = axios.create({
  baseURL: config.apiBaseURL,
  timeout: 30_000,
});

api.interceptors.request.use(async req => {
  const token = await logger._ensureToken();
  req.headers['Authorization'] = `Bearer ${token}`;
  return req;
});

// ── In-memory cache ───────────────────────────────────────────────────────────
const cache = {
  depots:   null,
  tasks:    null,
  ready:    false,
  loading:  false,
  loadedAt: null,
  progress: 0,   // tasks fetched so far (for status endpoint)
  error:    null,
};

const WORKERS     = 100;           // simultaneous page requests
const REFRESH_MS  = 10 * 60 * 1000; // re-fetch every 10 minutes

async function fetchDepots() {
  const { data } = await api.get('/depots');
  return data.depots;
}

/**
 * Sliding-window fetch: keeps WORKERS requests in-flight at all times.
 * Much faster than batch fetching because we never stall waiting for
 * the slowest request in a batch.
 *
 * Stops when WORKERS consecutive pages all come back empty.
 */
async function fetchAllTasks() {
  const allTasks = [];
  let nextPage  = 1;
  let stopped   = false;

  cache.progress = 0;

  async function worker() {
    while (!stopped) {
      const page = nextPage++; // safe: JS is single-threaded
      try {
        const { data } = await api.get('/vehicles', { params: { page } });
        const tasks = data.vehicles || data.tasks ||
                      (Array.isArray(data) ? data : []);
        if (tasks.length === 0) {
          stopped = true;
          return;
        }
        allTasks.push(...tasks);
        cache.progress = allTasks.length;
      } catch {
        stopped = true;
        return;
      }
    }
  }

  // Launch WORKERS concurrent workers
  await Promise.all(Array.from({ length: WORKERS }, () => worker()));

  return allTasks;
}

async function populateCache() {
  if (cache.loading) return;
  cache.loading = true;
  cache.error   = null;

  const start = Date.now();
  await logger.log('backend', 'info', 'cache', 'cache load started');
  console.log('[CACHE] Loading depots and tasks...');

  try {
    const [depots, tasks] = await Promise.all([fetchDepots(), fetchAllTasks()]);

    cache.depots   = depots;
    cache.tasks    = tasks;
    cache.ready    = true;
    cache.loadedAt = new Date();

    const sec = ((Date.now() - start) / 1000).toFixed(1);
    await logger.log('backend', 'info', 'cache',
      `cache ready: ${tasks.length} tasks`);
    console.log(`[CACHE] Ready — ${depots.length} depots, ${tasks.length} tasks in ${sec}s`);

  } catch (err) {
    cache.error = err.message;
    await logger.log('backend', 'error', 'cache',
      `cache error: ${err.message}`.slice(0, 48));
    console.error('[CACHE] Error:', err.message);
  } finally {
    cache.loading = false;
  }
}

function startCache() {
  populateCache();
  setInterval(populateCache, REFRESH_MS);
}

module.exports = { cache, startCache };
