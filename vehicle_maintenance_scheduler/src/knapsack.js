'use strict';

/**
 * 0/1 Knapsack Solver
 *
 * Strategy:
 *  - Exact 2D DP  when N × W ≤ 1 000 000  → O(N×W) time, ~8 MB max
 *  - Greedy       otherwise                → O(N log N), handles millions of tasks
 *
 * NOTE: No external algorithm libraries used (pure JS per evaluation rules).
 */

const DP_THRESHOLD = 1_000_000;

/**
 * @param {Array<{TaskID:string,Duration:number,Impact:number}>} tasks
 * @param {number} capacity  available mechanic-hours
 * @returns {{ selected: Task[], totalImpact: number, algorithm: string }}
 */
function solve(tasks, capacity) {
  if (!tasks.length || capacity <= 0) return { selected: [], totalImpact: 0, algorithm: 'dp' };
  return tasks.length * capacity > DP_THRESHOLD
    ? greedySolve(tasks, capacity)
    : dpSolve(tasks, capacity);
}

function dpSolve(tasks, W) {
  const n  = tasks.length;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(W + 1));

  for (let i = 1; i <= n; i++) {
    const { Duration: d, Impact: imp } = tasks[i - 1];
    for (let w = 0; w <= W; w++) {
      dp[i][w] = dp[i - 1][w];
      if (w >= d) {
        const v = dp[i - 1][w - d] + imp;
        if (v > dp[i][w]) dp[i][w] = v;
      }
    }
  }

  const selected = [];
  let w = W;
  for (let i = n; i >= 1; i--) {
    if (dp[i][w] !== dp[i - 1][w]) {
      selected.push(tasks[i - 1]);
      w -= tasks[i - 1].Duration;
    }
  }

  return { selected, totalImpact: dp[n][W], algorithm: 'dp' };
}

function greedySolve(tasks, capacity) {
  const sorted = tasks
    .map(t => ({ ...t, _ratio: t.Duration > 0 ? t.Impact / t.Duration : 0 }))
    .sort((a, b) => b._ratio - a._ratio);

  const selected = [];
  let totalImpact = 0, rem = capacity;
  for (const t of sorted) {
    if (t.Duration <= rem) {
      const { _ratio, ...clean } = t;
      selected.push(clean);
      totalImpact += t.Impact;
      rem -= t.Duration;
    }
  }
  return { selected, totalImpact, algorithm: 'greedy' };
}

module.exports = { solve };
