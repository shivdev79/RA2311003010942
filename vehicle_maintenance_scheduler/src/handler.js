'use strict';

const logger       = require('logging_middleware');
const { cache }    = require('./cache');
const { solve }    = require('./knapsack');

/**
 * GET /api/v1/schedule
 *
 * Runs 0/1 knapsack per depot using the pre-loaded in-memory cache.
 * With ~250 000 tasks the greedy algorithm (O(N log N)) is used.
 * Responds in <1s once the cache is warm.
 */
async function scheduleHandler(req, res) {
  await logger.log('backend', 'info', 'route', 'schedule request received');

  if (cache.error) {
    await logger.log('backend', 'error', 'handler', 'cache unavailable');
    return res.status(502).json({ error: 'Data unavailable: ' + cache.error });
  }

  if (!cache.ready) {
    await logger.log('backend', 'warn', 'handler', 'cache still loading');
    return res.status(503).json({
      error:   'Service warming up — tasks still loading, retry in 60s',
      loading: true,
    });
  }

  try {
    const { depots, tasks } = cache;

    const results = [];
    for (const depot of depots) {
      const { selected, totalImpact, algorithm } = solve(tasks, depot.MechanicHours);
      const totalDuration = selected.reduce((s, t) => s + t.Duration, 0);

      await logger.log('backend', 'info', 'service',
        `depot ${depot.ID}: impact=${Math.round(totalImpact)}`);

      results.push({
        depot_id:               depot.ID,
        mechanic_hours:         depot.MechanicHours,
        selected_tasks:         selected,
        total_duration:         totalDuration,
        total_impact:           totalImpact,
        algorithm,
      });
    }

    await logger.log('backend', 'info', 'route',
      `schedule done: ${results.length} depots`);

    res.json({
      depots_scheduled:       results.length,
      total_tasks_available:  tasks.length,
      cache_loaded_at:        cache.loadedAt,
      results,
    });

  } catch (err) {
    await logger.log('backend', 'error', 'handler',
      `schedule error: ${err.message}`.slice(0, 48));
    res.status(500).json({ error: err.message });
  }
}

module.exports = { scheduleHandler };
