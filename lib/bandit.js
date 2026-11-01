const WORKLOAD_CLASSES = ['chat-like', 'media-heavy', 'mixed'];

const clamp = value => Math.min(Math.max(value, 0), 1);

function createBandit({ strategies, exploration = 1, state = {} }) {
  const table = {};
  for (const cls of WORKLOAD_CLASSES) {
    table[cls] = {};
    for (const strategy of strategies) {
      const saved = (state[cls] && state[cls][strategy]) || {};
      table[cls][strategy] = { count: saved.count || 0, mean: saved.mean || 0 };
    }
  }

  const totalPulls = cls => strategies.reduce((sum, strategy) => sum + table[cls][strategy].count, 0);

  function scores(cls) {
    const total = totalPulls(cls);
    const result = {};
    for (const strategy of strategies) {
      const arm = table[cls][strategy];
      result[strategy] = arm.count === 0 ? Infinity : arm.mean + exploration * Math.sqrt((2 * Math.log(total)) / arm.count);
    }
    return result;
  }

  function select(cls) {
    const current = scores(cls);
    let best = strategies[0];
    for (const strategy of strategies) {
      if (current[strategy] > current[best]) best = strategy;
    }
    return best;
  }

  function update(cls, strategy, reward) {
    const arm = table[cls][strategy];
    arm.count += 1;
    arm.mean += (reward - arm.mean) / arm.count;
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(table));
  }

  return { scores, select, update, snapshot };
}

function computeReward(features, { weights, ceilings }) {
  const latency = 1 - clamp(features.p95 / ceilings.p95Ms);
  const errors = 1 - clamp(features.errorRate / ceilings.errorRate);
  const balance = 1 - clamp(features.connCv / ceilings.cv);
  const total = weights.latency + weights.error + weights.balance;
  return (weights.latency * latency + weights.error * errors + weights.balance * balance) / total;
}

module.exports = { createBandit, computeReward, WORKLOAD_CLASSES };
