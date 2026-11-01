const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    timestamp: { type: Date, default: Date.now, index: true },
    workloadClass: String,
    features: { type: Object, default: {} },
    chosenStrategy: String,
    reason: String,
    previousReward: { type: Number, default: null }
  },
  { collection: 'decisions', versionKey: false, minimize: false }
);

module.exports = mongoose.model('Decision', schema);
