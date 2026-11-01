const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    workloadClass: String,
    strategy: String,
    count: { type: Number, default: 0 },
    meanReward: { type: Number, default: 0 }
  },
  { collection: 'bandit_state', versionKey: false }
);

schema.index({ workloadClass: 1, strategy: 1 }, { unique: true });

module.exports = mongoose.model('BanditState', schema);
