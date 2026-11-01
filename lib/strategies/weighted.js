function healthScore(node, { cpuWeight = 0.6, lagWeight = 0.4, lagMaxMs = 200 } = {}) {
  const cpu = Math.min(Math.max(node.cpu || 0, 0), 100) / 100;
  const lag = Math.min(Math.max(node.lag || 0, 0) / lagMaxMs, 1);
  return Math.max(0.05, 1 - (cpuWeight * cpu + lagWeight * lag));
}

function weighted(options = {}) {
  return {
    name: 'weighted',
    balancing: null,
    weightOf: node => Math.max(1, Math.round(healthScore(node, options) * 100))
  };
}

module.exports = weighted;
module.exports.healthScore = healthScore;
