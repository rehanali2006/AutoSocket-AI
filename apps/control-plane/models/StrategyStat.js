const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    strategy: { type: String, unique: true },
    windows: { type: Number, default: 0 },
    totalRequests: { type: Number, default: 0 },
    activeSeconds: { type: Number, default: 0 },
    sumP95: { type: Number, default: 0 },
    sumErrors: { type: Number, default: 0 },
    sumMessages: { type: Number, default: 0 },
    sumStd: { type: Number, default: 0 },
    nodeRequests: { type: Object, default: {} }
  },
  { collection: 'strategy_stats', versionKey: false, minimize: false }
);

module.exports = mongoose.model('StrategyStat', schema);
