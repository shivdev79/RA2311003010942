'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const express = require('express');
const logger  = require('logging_middleware');
const config  = require('./config');
const { getPriorityInbox, streamNotifications } = require('./handler');

const app = express();
app.use(express.json());
app.use(logger.middleware());

// Stage 6 — Priority Inbox (working code)
app.get('/api/v1/notifications/priority', getPriorityInbox);

// Stage 1 — Real-time via SSE
app.get('/api/v1/notifications/stream', streamNotifications);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'notification_app_be' }));

app.listen(config.port, async () => {
  await logger.log('backend', 'info', 'config',
    `notifications started on port ${config.port}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET http://localhost:${config.port}/api/v1/notifications/priority?n=10`);
  console.log(`  GET http://localhost:${config.port}/api/v1/notifications/stream`);
  console.log(`  GET http://localhost:${config.port}/health`);
});
