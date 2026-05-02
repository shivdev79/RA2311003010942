'use strict';

const axios  = require('axios');
const logger = require('logging_middleware');
const config = require('./config');
const { PriorityInbox } = require('./priority-inbox');

const api = axios.create({
  baseURL: config.apiBaseURL,
  timeout: 30_000,
});

api.interceptors.request.use(async req => {
  const token = await logger._ensureToken();
  req.headers['Authorization'] = `Bearer ${token}`;
  return req;
});

async function fetchNotifications() {
  const { data } = await api.get('/notifications');
  return data.notifications || [];
}

/**
 * GET /api/v1/notifications/priority?n=10|15|20
 * Returns top-N notifications ranked by type priority then recency.
 */
async function getPriorityInbox(req, res) {
  const { requestID } = req;
  const allowed = [10, 15, 20];
  let n = parseInt(req.query.n, 10);
  if (!allowed.includes(n)) n = 10;

  await logger.log('backend', 'info', 'handler',
    `priority inbox n=${n}`);

  try {
    const notifications = await fetchNotifications();
    await logger.log('backend', 'info', 'service',
      `notifications fetched: ${notifications.length}`);

    const inbox = new PriorityInbox(n);
    for (const notif of notifications) inbox.add(notif);

    const top = inbox.getTopN().map(({ ID, Type, Message, Timestamp, _score }) => ({
      id:             ID,
      type:           Type,
      message:        Message,
      timestamp:      Timestamp,
      priority_score: _score,
    }));

    await logger.log('backend', 'info', 'handler',
      `priority inbox returned: ${top.length}`);

    res.json({ top_n: n, count: top.length, notifications: top });

  } catch (err) {
    await logger.log('backend', 'error', 'handler',
      `priority inbox error: ${err.message}`.slice(0, 48));
    res.status(502).json({ error: err.message });
  }
}

/**
 * GET /api/v1/notifications/stream
 * SSE — pushes a refreshed top-10 priority inbox every 10 seconds.
 */
async function streamNotifications(req, res) {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  await logger.log('backend', 'info', 'handler', 'sse client connected');

  const push = async () => {
    try {
      const notifications = await fetchNotifications();
      const inbox = new PriorityInbox(10);
      for (const n of notifications) inbox.add(n);
      res.write(`event: notifications\ndata: ${JSON.stringify(inbox.getTopN())}\n\n`);
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    }
  };

  await push();
  const interval = setInterval(push, 10_000);

  req.on('close', async () => {
    clearInterval(interval);
    await logger.log('backend', 'info', 'handler', 'sse client disconnected');
  });
}

module.exports = { getPriorityInbox, streamNotifications };
