const express = require('express');
const { STRATEGY_NAMES } = require('../../../lib');

const NAMES = {
  'round-robin': 'Round Robin',
  'least-connections': 'Least Connections',
  weighted: 'Weighted Health',
  'consistent-hash': 'Consistent Hash',
  'power-of-two': 'Power of Two',
  adaptive: 'Adaptive (bandit)'
};

function markBest(rows, key, lowerIsBetter) {
  const ranked = rows.filter(row => row.windows > 0 && row[key] !== null);
  if (ranked.length < 2) return;
  const values = ranked.map(row => row[key]);
  const target = lowerIsBetter ? Math.min(...values) : Math.max(...values);
  ranked.forEach(row => {
    if (row[key] === target) row.best[key] = true;
  });
}

module.exports = function pageRoutes({ store }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.render('dashboard', { title: 'Adaptive Socket Balancer' });
  });

  router.get('/benchmark', async (req, res) => {
    const [stats, bandit] = await Promise.all([store.loadStats(), store.loadBandit()]);

    const rows = [...STRATEGY_NAMES, 'adaptive'].map(name => {
      const stat = stats.find(item => item.strategy === name) || {};
      const windows = stat.windows || 0;
      return {
        name,
        label: NAMES[name],
        windows,
        requests: stat.totalRequests || 0,
        avgReqPerSec: windows ? stat.totalRequests / windows : null,
        p95: windows ? stat.sumP95 / windows : null,
        errorRate: stat.sumMessages ? stat.sumErrors / stat.sumMessages : null,
        loadStd: windows ? stat.sumStd / windows : null,
        best: {}
      };
    });

    markBest(rows, 'avgReqPerSec', false);
    markBest(rows, 'p95', true);
    markBest(rows, 'errorRate', true);
    markBest(rows, 'loadStd', true);

    const arms = [];
    for (const [workloadClass, byStrategy] of Object.entries(bandit)) {
      for (const [strategy, arm] of Object.entries(byStrategy)) {
        if (arm.count > 0) arms.push({ workloadClass, label: NAMES[strategy] || strategy, count: arm.count, mean: arm.mean });
      }
    }
    arms.sort((a, b) => a.workloadClass.localeCompare(b.workloadClass) || b.mean - a.mean);

    res.render('benchmark', { title: 'Benchmark', rows, arms });
  });

  return router;
};
