'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const express = require('express');
const logger  = require('logging_middleware');
const config  = require('./config');
const { startCache } = require('./cache');
const { scheduleHandler } = require('./handler');

const app = express();
app.use(express.json());
app.use(logger.middleware());

app.get('/api/v1/schedule', scheduleHandler);

// Cache status endpoint — useful for monitoring warm-up progress
app.get('/api/v1/cache-status', (req, res) => {
  const { cache } = require('./cache');
  res.json({
    ready:      cache.ready,
    loading:    cache.loading,
    tasks:      cache.tasks?.length ?? 0,
    depots:     cache.depots?.length ?? 0,
    loadedAt:   cache.loadedAt,
    error:      cache.error,
  });
});

app.get('/health', (_req, res) => {
  const { cache } = require('./cache');
  res.json({ status: 'ok', cacheReady: cache.ready });
});

// Kick off background task pre-fetch immediately on startup
startCache();

app.listen(config.port, async () => {
  await logger.log('backend', 'info', 'config',
    `scheduler started on port ${config.port}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET http://localhost:${config.port}/api/v1/schedule`);
  console.log(`  GET http://localhost:${config.port}/api/v1/cache-status`);
  console.log(`  GET http://localhost:${config.port}/health`);
  console.log(`\nWarm-up: fetching ~250k tasks in background...`);
});
