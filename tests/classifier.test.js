const { classify } = require('../lib/classifier');

const thresholds = { chatBytes: 5000, mediaBytes: 500000, minMessagesPerSec: 1, churnPerSec: 50 };
const features = overrides => ({ messagesPerSec: 100, avgPayloadBytes: 200, connectionsPerSec: 2, ...overrides });

describe('classifier', () => {
  test('small payloads are chat-like', () => {
    expect(classify(features({ avgPayloadBytes: 200 }), thresholds)).toBe('chat-like');
  });

  test('large payloads are media-heavy', () => {
    expect(classify(features({ avgPayloadBytes: 1200000 }), thresholds)).toBe('media-heavy');
  });

  test('payloads in between are mixed', () => {
    expect(classify(features({ avgPayloadBytes: 80000 }), thresholds)).toBe('mixed');
  });

  test('heavy connection churn tips the middle band to chat-like', () => {
    expect(classify(features({ avgPayloadBytes: 80000, connectionsPerSec: 200 }), thresholds)).toBe('chat-like');
  });

  test('no traffic is idle', () => {
    expect(classify(features({ messagesPerSec: 0 }), thresholds)).toBe('idle');
  });

  test('boundaries are inclusive on the extremes', () => {
    expect(classify(features({ avgPayloadBytes: 5000 }), thresholds)).toBe('chat-like');
    expect(classify(features({ avgPayloadBytes: 500000 }), thresholds)).toBe('media-heavy');
  });
});
