function classify(features, thresholds) {
  if (features.messagesPerSec < thresholds.minMessagesPerSec) return 'idle';
  if (features.avgPayloadBytes >= thresholds.mediaBytes) return 'media-heavy';
  if (features.avgPayloadBytes <= thresholds.chatBytes) return 'chat-like';
  return features.connectionsPerSec >= thresholds.churnPerSec ? 'chat-like' : 'mixed';
}

module.exports = { classify };
