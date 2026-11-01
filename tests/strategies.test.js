const { createStrategies, STRATEGY_NAMES } = require('../lib/strategies');
const { healthScore } = require('../lib/strategies/weighted');

const options = { cpuWeight: 0.6, lagWeight: 0.4, lagMaxMs: 200 };
const strategies = createStrategies(options);

const healthy = { id: 'a', cpu: 10, lag: 1 };
const loaded = { id: 'b', cpu: 90, lag: 150 };

describe('strategy registry', () => {
  test('exposes every strategy under its name', () => {
    STRATEGY_NAMES.forEach(name => {
      expect(strategies[name].name).toBe(name);
      expect(typeof strategies[name].weightOf).toBe('function');
    });
  });
});

describe('nginx directives', () => {
  test('round-robin uses the nginx default', () => {
    expect(strategies['round-robin'].balancing).toBe(null);
  });

  test('least-connections uses least_conn', () => {
    expect(strategies['least-connections'].balancing).toBe('least_conn;');
  });

  test('consistent-hash hashes the request key with ketama', () => {
    expect(strategies['consistent-hash'].balancing).toBe('hash $hash_key consistent;');
  });

  test('power-of-two picks two random servers and keeps the less busy', () => {
    expect(strategies['power-of-two'].balancing).toBe('random two least_conn;');
  });

  test('weighted relies on server weights only', () => {
    expect(strategies.weighted.balancing).toBe(null);
  });
});

describe('weights', () => {
  test('non-weighted strategies give every node the same weight', () => {
    ['round-robin', 'least-connections', 'consistent-hash', 'power-of-two'].forEach(name => {
      expect(strategies[name].weightOf(healthy)).toBe(strategies[name].weightOf(loaded));
    });
  });

  test('weighted favours the healthier node', () => {
    expect(strategies.weighted.weightOf(healthy)).toBeGreaterThan(strategies.weighted.weightOf(loaded));
  });

  test('weights are whole numbers of at least 1', () => {
    const weight = strategies.weighted.weightOf({ cpu: 100, lag: 10000 });
    expect(Number.isInteger(weight)).toBe(true);
    expect(weight).toBeGreaterThan(0);
  });

  test('identical nodes get identical weights', () => {
    expect(strategies.weighted.weightOf({ cpu: 40, lag: 20 })).toBe(strategies.weighted.weightOf({ cpu: 40, lag: 20 }));
  });
});

describe('health score', () => {
  test('is higher for a calmer node', () => {
    expect(healthScore(healthy, options)).toBeGreaterThan(healthScore(loaded, options));
  });

  test('never drops to zero', () => {
    expect(healthScore({ cpu: 100, lag: 10000 }, options)).toBeGreaterThan(0);
  });

  test('stays at or below 1', () => {
    expect(healthScore({ cpu: 0, lag: 0 }, options)).toBe(1);
  });
});
