const mongoose = require('mongoose');
const MetricsSnapshot = require('./MetricsSnapshot');
const StrategyStat = require('./StrategyStat');
const Decision = require('./Decision');
const BanditState = require('./BanditState');

const report = label => err => console.error(`[control-plane] mongo ${label} failed: ${err.message}`);

const store = {
  up: () => mongoose.connection.readyState === 1,

  async saveSnapshot(doc) {
    if (!store.up()) return;
    await MetricsSnapshot.create(doc).catch(report('snapshot'));
  },

  async saveDecision(decision) {
    if (!store.up()) return;
    await Decision.create({
      timestamp: new Date(decision.ts),
      workloadClass: decision.workloadClass,
      features: decision.features,
      chosenStrategy: decision.strategy,
      reason: decision.reason,
      previousReward: decision.previousReward
    }).catch(report('decision'));
  },

  async saveStats(list) {
    if (!store.up()) return;
    const operations = list.map(stat => ({
      updateOne: { filter: { strategy: stat.strategy }, update: { $set: stat }, upsert: true }
    }));
    await StrategyStat.bulkWrite(operations).catch(report('stats'));
  },

  async loadStats() {
    if (!store.up()) return [];
    return StrategyStat.find().select('-_id').lean().catch(err => {
      report('load stats')(err);
      return [];
    });
  },

  async loadBandit() {
    if (!store.up()) return {};
    const rows = await BanditState.find().lean().catch(err => {
      report('load bandit')(err);
      return [];
    });
    const state = {};
    for (const row of rows) {
      state[row.workloadClass] = state[row.workloadClass] || {};
      state[row.workloadClass][row.strategy] = { count: row.count, mean: row.meanReward };
    }
    return state;
  },

  async saveBandit(table) {
    if (!store.up()) return;
    const operations = [];
    for (const [workloadClass, arms] of Object.entries(table)) {
      for (const [strategy, arm] of Object.entries(arms)) {
        operations.push({
          updateOne: {
            filter: { workloadClass, strategy },
            update: { $set: { count: arm.count, meanReward: arm.mean } },
            upsert: true
          }
        });
      }
    }
    await BanditState.bulkWrite(operations).catch(report('bandit'));
  },

  async clearStats() {
    if (store.up()) await StrategyStat.deleteMany({}).catch(report('clear stats'));
  },

  async clearBandit() {
    if (store.up()) await BanditState.deleteMany({}).catch(report('clear bandit'));
  },

  async loadDecisions(limit) {
    if (!store.up()) return [];
    const rows = await Decision.find().sort({ timestamp: -1 }).limit(limit).lean().catch(err => {
      report('load decisions')(err);
      return [];
    });
    return rows.map(row => ({
      ts: row.timestamp.getTime(),
      workloadClass: row.workloadClass,
      features: row.features,
      strategy: row.chosenStrategy,
      reason: row.reason,
      previousReward: row.previousReward
    }));
  }
};

module.exports = store;
