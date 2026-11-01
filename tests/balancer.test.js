const { createAdaptiveBalancer } = require('../lib/balancer');

const NODES = [
  { id: 'worker1', target: 'http://worker1:4000' },
  { id: 'worker2', target: 'http://worker2:4000' }
];

let clock;
const realNow = Date.now;

function fakeBus() {
  return {
    connected: true,
    handlers: {},
    published: [],
    subscribe(subject, handler) {
      this.handlers[subject] = handler;
    },
    publish(subject, payload) {
      this.published.push([subject, payload]);
      return true;
    },
    close: async () => {}
  };
}

function setup(options = {}) {
  const bus = fakeBus();
  const configs = [];
  const balancer = createAdaptiveBalancer({
    nodes: NODES,
    natsUrl: 'unused',
    bus,
    applyConfig: async text => {
      configs.push(text);
    },
    options: { minReloadSec: 0, weightDelta: 10, ...options }
  });
  const beat = strategy => bus.handlers['lb.strategy']({ strategy });
  const metrics = (nodeId, extra = {}) =>
    bus.handlers['lb.metrics.>']({ nodeId, cpuPercent: 10, eventLoopLagMs: 1, accepted: 0, ...extra });
  const last = () => configs[configs.length - 1];
  return { balancer, bus, configs, beat, metrics, last };
}

describe('adaptive balancer', () => {
  beforeEach(() => {
    clock = 1000000;
    Date.now = () => clock;
  });

  afterEach(() => {
    Date.now = realNow;
  });

  test('starts on round-robin across every node before any heartbeat', async () => {
    const { balancer, configs, last } = setup();
    await balancer.evaluate();
    expect(configs.length).toBe(1);
    expect(last()).toContain('worker1:4000');
    expect(last()).toContain('worker2:4000');
    expect(last()).toContain('X-LB-Strategy round-robin');
  });

  test('applies the strategy from the heartbeat once metrics are fresh', async () => {
    const { balancer, beat, metrics, last } = setup();
    beat('least-connections');
    metrics('worker1');
    metrics('worker2');
    await balancer.evaluate();
    expect(last()).toContain('        least_conn;');
    expect(last()).toContain('X-LB-Strategy least-connections');
  });

  test('weighted gives the calmer node the larger weight', async () => {
    const { balancer, beat, metrics, last } = setup();
    beat('weighted');
    metrics('worker1', { cpuPercent: 10, eventLoopLagMs: 1 });
    metrics('worker2', { cpuPercent: 90, eventLoopLagMs: 150 });
    await balancer.evaluate();
    const weight = id => Number(new RegExp(`server ${id}:4000 weight=(\\d+)`).exec(last())[1]);
    expect(weight('worker1')).toBeGreaterThan(weight('worker2'));
  });

  test('keeps the current weights when the change is small', async () => {
    const { balancer, beat, metrics, configs } = setup();
    beat('weighted');
    metrics('worker1', { cpuPercent: 10 });
    metrics('worker2', { cpuPercent: 40 });
    await balancer.evaluate();
    metrics('worker1', { cpuPercent: 12 });
    metrics('worker2', { cpuPercent: 42 });
    await balancer.evaluate();
    expect(configs.length).toBe(1);
  });

  test('drops a node whose metrics went stale', async () => {
    const { balancer, beat, metrics, last } = setup();
    beat('least-connections');
    metrics('worker1');
    metrics('worker2');
    await balancer.evaluate();
    clock += 6000;
    beat('least-connections');
    metrics('worker1');
    await balancer.evaluate();
    expect(last()).toContain('worker1:4000');
    expect(last()).not.toContain('worker2');
  });

  test('falls back to round-robin when the heartbeat goes stale', async () => {
    const { balancer, beat, metrics, last } = setup();
    beat('least-connections');
    metrics('worker1');
    metrics('worker2');
    await balancer.evaluate();
    expect(last()).toContain('least_conn;');
    clock += 6000;
    metrics('worker1');
    metrics('worker2');
    await balancer.evaluate();
    expect(last()).not.toContain('least_conn;');
    expect(last()).toContain('X-LB-Strategy round-robin');
  });

  test('does not reload when nothing changed', async () => {
    const { balancer, beat, metrics, configs } = setup();
    beat('power-of-two');
    metrics('worker1');
    metrics('worker2');
    await balancer.evaluate();
    await balancer.evaluate();
    await balancer.evaluate();
    expect(configs.length).toBe(1);
  });

  test('waits the minimum interval between reloads', async () => {
    const { balancer, beat, metrics, configs } = setup({ minReloadSec: 5 });
    beat('round-robin');
    metrics('worker1');
    metrics('worker2');
    await balancer.evaluate();
    beat('least-connections');
    await balancer.evaluate();
    expect(configs.length).toBe(1);
    clock += 6000;
    beat('least-connections');
    metrics('worker1');
    metrics('worker2');
    await balancer.evaluate();
    expect(configs.length).toBe(2);
  });

  test('survives a failed apply and retries', async () => {
    const bus = fakeBus();
    let calls = 0;
    const balancer = createAdaptiveBalancer({
      nodes: NODES,
      natsUrl: 'unused',
      bus,
      applyConfig: async () => {
        calls += 1;
        if (calls === 1) throw new Error('host not found');
      },
      options: { minReloadSec: 0 }
    });
    await balancer.evaluate();
    expect(balancer.health().lastError).toBe('host not found');
    await balancer.evaluate();
    expect(balancer.health().lastError).toBe(null);
    expect(calls).toBe(2);
  });

  test('publishes accepted requests per node under the applied strategy', async () => {
    const { balancer, bus, metrics } = setup();
    await balancer.evaluate();
    metrics('worker1', { accepted: 4 });
    metrics('worker2', { accepted: 2 });
    metrics('worker1', { accepted: 1 });
    balancer.publishRequests();
    const [subject, payload] = bus.published[0];
    expect(subject).toBe('lb.requests');
    expect(payload.strategies).toEqual({ 'round-robin': { worker1: 5, worker2: 2 } });
    balancer.publishRequests();
    expect(bus.published[1][1].strategies).toEqual({});
  });
});
