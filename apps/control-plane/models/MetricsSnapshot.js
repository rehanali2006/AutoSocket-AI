const mongoose = require('mongoose');
const { envNumber } = require('../../../lib');

const schema = new mongoose.Schema(
  {
    nodeId: { type: String, index: true },
    connections: Number,
    messagesPerSec: Number,
    avgPayloadBytes: Number,
    p95LatencyMs: Number,
    cpuPercent: Number,
    eventLoopLagMs: Number,
    errors: Number,
    timestamp: { type: Date, default: Date.now, expires: envNumber('SNAPSHOT_TTL_SEC') }
  },
  { collection: 'metrics_snapshots', versionKey: false }
);

module.exports = mongoose.model('MetricsSnapshot', schema);
