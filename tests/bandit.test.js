const { createBandit, computeReward } = require('../lib/bandit');

const strategies = ['one', 'two', 'three'];
const reward = { weights: { latency: 0.5, error: 0.2, balance: 0.3 }, ceilings: { p95Ms: 500, errorRate: 0.05, cv: 1 } };

describe('bandit', () => {
  test('tries every strategy once, in order, before using scores', () => {
    const bandit = createBandit({ strategies });
    const tried = [];
    for (let i = 0; i < 3; i += 1) {
      const pick = bandit.select('chat-like');
      tried.push(pick);
      bandit.update('chat-like', pick, 0.5);
    }
    expect(tried).toEqual(['one', 'two', 'three']);
  });

  test('settles on the best arm once every arm is tried', () => {
    const bandit = createBandit({ strategies });
    bandit.update('mixed', 'one', 0.2);
    bandit.update('mixed', 'two', 0.9);
    bandit.update('mixed', 'three', 0.4);
    expect(bandit.select('mixed')).toBe('two');
  });

  test('exploration bonus eventually revisits a neglected arm', () => {
    const bandit = createBandit({ strategies });
    bandit.update('mixed', 'one', 0.6);
    bandit.update('mixed', 'two', 0.62);
    bandit.update('mixed', 'three', 0.58);
    for (let i = 0; i < 200; i += 1) bandit.update('mixed', 'two', 0.62);
    expect(bandit.select('mixed')).not.toBe('two');
  });

  test('keeps a running mean per arm', () => {
    const bandit = createBandit({ strategies });
    bandit.update('mixed', 'one', 0.2);
    bandit.update('mixed', 'one', 0.6);
    expect(bandit.snapshot().mixed.one).toEqual({ count: 2, mean: 0.4 });
  });

  test('workload classes learn independently', () => {
    const bandit = createBandit({ strategies });
    bandit.update('chat-like', 'one', 0.9);
    expect(bandit.snapshot()['media-heavy'].one.count).toBe(0);
  });

  test('restores from a saved snapshot', () => {
    const first = createBandit({ strategies });
    first.update('mixed', 'two', 0.7);
    const second = createBandit({ strategies, state: first.snapshot() });
    expect(second.snapshot().mixed.two).toEqual({ count: 1, mean: 0.7 });
  });
});

describe('reward', () => {
  test('perfect metrics give a reward of 1', () => {
    expect(computeReward({ p95: 0, errorRate: 0, connCv: 0 }, reward)).toBeCloseTo(1, 5);
  });

  test('worst metrics give a reward of 0', () => {
    expect(computeReward({ p95: 9999, errorRate: 1, connCv: 5 }, reward)).toBeCloseTo(0, 5);
  });

  test('lower latency scores higher', () => {
    const fast = computeReward({ p95: 20, errorRate: 0, connCv: 0.2 }, reward);
    const slow = computeReward({ p95: 300, errorRate: 0, connCv: 0.2 }, reward);
    expect(fast).toBeGreaterThan(slow);
  });

  test('better balance scores higher', () => {
    const even = computeReward({ p95: 50, errorRate: 0, connCv: 0.05 }, reward);
    const skewed = computeReward({ p95: 50, errorRate: 0, connCv: 0.8 }, reward);
    expect(even).toBeGreaterThan(skewed);
  });
});
