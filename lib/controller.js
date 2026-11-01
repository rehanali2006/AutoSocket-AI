const { EventEmitter } = require('events');
const { createBus } = require('./natsClient');
const { STRATEGY_NAMES } = require('./strategies');
const { healthScore } = require('./strategies/weighted');
const { classify } = require('./classifier');
const { createBandit, computeReward } = require('./bandit');

const TICK_MS = 1000;
const ADAPTIVE_KEY = 'adaptive';

const sum = values => values.reduce((total, value) => total + value, 0);
const percent = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);
const round = value => Math.round(value * 100) / 100;
const show = value => (Number.isFinite(value) ? value.toFixed(3) : 'untried');

const emptyStat = strategy => ({
  strategy,
  windows: 0,
  totalRequests: 0,
  activeSeconds: 0,
  sumP95: 0,
  sumErrors: 0,
  sumMessages: 0,
  sumStd: 0,
  nodeRequests: {}
});

const emptyWindow = () => ({ seconds: 0, messages: 0, bytes: 0, requests: 0, p95Weighted: 0, errors: 0, cvSum: 0 });

function summarize(live) {
  const messages = sum(live.map(m => m.messagesPerSec));
  const weighted = field => (messages > 0 ? sum(live.map(m => m[field] * m.messagesPerSec)) / messages : 0);
  const counts = live.map(m => m.connections);
  const mean = counts.length ? sum(counts) / counts.length : 0;
  const variance = counts.length ? sum(counts.map(count => (count - mean) ** 2)) / counts.length : 0;
  const errors = sum(live.map(m => m.errors));
  const std = Math.sqrt(variance);

  return {
    connections: sum(counts),
    messagesPerSec: messages,
    avgPayloadBytes: weighted('avgPayloadBytes'),
    p95: weighted('p95LatencyMs'),
    errors,
    errorRate: Math.min(1, errors / Math.max(messages, 1)),
    connStd: std,
    connCv: std / Math.max(mean, 1)
  };
}

function windowFeatures(w) {
  const seconds = Math.max(w.seconds, 1);
  return {
    messagesPerSec: round(w.messages / seconds),
    avgPayloadBytes: w.messages ? Math.round(w.bytes / w.messages) : 0,
    connectionsPerSec: round(w.requests / seconds),
    p95: w.messages ? round(w.p95Weighted / w.messages) : 0,
    errorRate: Math.min(1, w.errors / Math.max(w.messages, 1)),
    connCv: round(w.cvSum / seconds)
  };
}

function createController({ natsUrl, nodeIds, options, store }) {
  const bus = createBus(natsUrl, 'control-plane');
  const events = new EventEmitter();
  const startedAt = Date.now();
  const staleMs = Math.max(options.metricsStaleSec * 1000, 1000);
  const adaptive = options.mode === 'adaptive';
  const weights = { cpuWeight: options.cpuWeight, lagWeight: options.lagWeight, lagMaxMs: options.lagMaxMs };
  const newBandit = state => createBandit({ strategies: STRATEGY_NAMES, exploration: options.exploration, state });

  const nodes = new Map();
  const stats = new Map([...STRATEGY_NAMES, ADAPTIVE_KEY].map(name => [name, emptyStat(name)]));
  const history = [];
  let decisions = [];
  let timers = [];

  let active = STRATEGY_NAMES.includes(options.strategy) ? options.strategy : options.fallbackStrategy;
  let workloadClass = 'unclassified';
  let degraded = false;
  let bandit = newBandit();
  let window = emptyWindow();
  let ticksSinceSelect = 0;
  let lastSwitchAt = Date.now();
  let pending = { cls: null, count: 0 };
  let idleLogged = false;
  let gateway = { at: 0, strategy: null, fallback: false };
  let lastRequests = { at: 0, byNode: {}, total: 0 };

  const published = () => (degraded ? options.fallbackStrategy : active);
  const liveNodes = () => [...nodes.values()].filter(m => Date.now() - m.receivedAt <= staleMs);
  const requestsNow = () => (Date.now() - lastRequests.at <= 2500 ? lastRequests : { byNode: {}, total: 0 });

  bus.subscribe('lb.metrics.>', message => {
    if (!message.nodeId) return;
    nodes.set(message.nodeId, { ...message, receivedAt: Date.now() });
    store.saveSnapshot({ ...message, timestamp: new Date() });
  });

  bus.subscribe('lb.requests', message => {
    const byNode = {};
    let total = 0;
    for (const [name, counts] of Object.entries(message.strategies || {})) {
      const stat = stats.get(name);
      if (!stat) continue;
      for (const [id, count] of Object.entries(counts)) {
        for (const target of adaptive ? [stat, stats.get(ADAPTIVE_KEY)] : [stat]) {
          target.nodeRequests[id] = (target.nodeRequests[id] || 0) + count;
          target.totalRequests += count;
        }
        byNode[id] = (byNode[id] || 0) + count;
        total += count;
      }
    }
    gateway = { at: Date.now(), strategy: message.activeStrategy, fallback: Boolean(message.fallback) };
    lastRequests = { at: Date.now(), byNode, total };
  });

  function recordDecision(partial) {
    const decision = { ts: Date.now(), workloadClass, features: {}, previousReward: null, ...partial };
    decisions = [decision, ...decisions].slice(0, options.decisionsShown);
    console.log(
      `[decision] class=${decision.workloadClass} strategy=${decision.strategy} reward=${decision.previousReward === null ? '-' : decision.previousReward.toFixed(3)} reason="${decision.reason}" features=${JSON.stringify(decision.features)}`
    );
    store.saveDecision(decision);
    events.emit('decision', decision);
  }

  function select() {
    const features = windowFeatures(window);
    window = emptyWindow();
    const detected = classify(features, options.thresholds);

    if (detected === 'idle') {
      if (!idleLogged) {
        idleLogged = true;
        workloadClass = 'idle';
        recordDecision({ strategy: active, features, reason: 'hold: no traffic in window' });
      }
      return;
    }
    idleLogged = false;

    const reward = computeReward(features, options.reward);
    bandit.update(detected, active, reward);
    store.saveBandit(bandit.snapshot());
    const decide = (strategy, reason) => recordDecision({ strategy, features, previousReward: reward, reason });

    if (detected !== workloadClass) {
      const first = workloadClass === 'unclassified' || workloadClass === 'idle';
      pending = pending.cls === detected ? { cls: detected, count: pending.count + 1 } : { cls: detected, count: 1 };
      if (!first && pending.count < options.confirmWindows) {
        decide(active, `hold: confirming ${detected} (${pending.count}/${options.confirmWindows})`);
        return;
      }
      workloadClass = detected;
    }
    pending = { cls: null, count: 0 };

    const scores = bandit.scores(workloadClass);
    const best = bandit.select(workloadClass);

    if (best === active) {
      decide(active, `hold: ${active} is best for ${workloadClass} (${show(scores[active])})`);
      return;
    }

    const dwellLeft = Math.ceil(options.minDwellSec - (Date.now() - lastSwitchAt) / 1000);
    if (dwellLeft > 0) {
      decide(active, `hold: dwell ${dwellLeft}s left before switching to ${best}`);
      return;
    }

    const untried = scores[best] === Infinity;
    const gain = scores[best] - scores[active];
    if (!untried && Number.isFinite(gain) && gain < options.hysteresis) {
      decide(active, `hold: hysteresis, ${best} gain ${gain.toFixed(3)} below ${options.hysteresis}`);
      return;
    }

    const from = active;
    active = best;
    lastSwitchAt = Date.now();
    decide(best, untried ? `explore: ${best} untried for ${workloadClass}` : `ucb: ${best} ${show(scores[best])} beats ${from} ${show(scores[from])}`);
  }

  function enterFallback() {
    degraded = true;
    window = emptyWindow();
    ticksSinceSelect = 0;
    recordDecision({ strategy: options.fallbackStrategy, reason: `fallback: worker metrics missing, using ${options.fallbackStrategy}` });
  }

  function leaveFallback() {
    degraded = false;
    lastSwitchAt = Date.now();
    recordDecision({ strategy: active, reason: `recovered: metrics back, resuming ${active}` });
  }

  function account(stat, totals, hasLoad) {
    stat.activeSeconds += 1;
    if (!hasLoad) return;
    stat.windows += 1;
    stat.sumP95 += totals.p95;
    stat.sumErrors += totals.errors;
    stat.sumMessages += totals.messagesPerSec;
    stat.sumStd += totals.connStd;
  }

  function tick() {
    const live = liveNodes();
    if (!live.length && !degraded && Date.now() - startedAt > staleMs) enterFallback();
    if (live.length && degraded) leaveFallback();

    const totals = summarize(live);
    const reqPerSec = requestsNow().total;
    const hasLoad = totals.messagesPerSec > 0 || reqPerSec > 0;

    account(stats.get(published()), totals, hasLoad);
    if (adaptive) account(stats.get(ADAPTIVE_KEY), totals, hasLoad);

    if (adaptive && !degraded) {
      window.seconds += 1;
      window.messages += totals.messagesPerSec;
      window.bytes += totals.avgPayloadBytes * totals.messagesPerSec;
      window.requests += reqPerSec;
      window.p95Weighted += totals.p95 * totals.messagesPerSec;
      window.errors += totals.errors;
      window.cvSum += totals.connCv;
      ticksSinceSelect += 1;
      if (ticksSinceSelect >= options.selectIntervalSec) {
        ticksSinceSelect = 0;
        select();
      }
    }

    bus.publish('lb.strategy', { strategy: published(), workloadClass, ts: Date.now() });

    history.push({ ts: Date.now(), reqPerSec, p95: totals.p95, strategy: published() });
    if (history.length > options.historyPoints) history.shift();

    events.emit('update', getState());
  }

  function getState() {
    const now = Date.now();
    const ids = [...new Set([...nodeIds, ...nodes.keys()])];
    const requests = requestsNow();
    const totals = summarize(liveNodes());
    const current = published();
    const allRequests = sum(STRATEGY_NAMES.map(name => stats.get(name).totalRequests));

    const nodeState = {};
    for (const id of ids) {
      const m = nodes.get(id);
      const online = Boolean(m) && now - m.receivedAt <= staleMs;
      nodeState[id] = {
        online,
        connections: online ? m.connections : 0,
        messagesPerSec: online ? m.messagesPerSec : 0,
        p95LatencyMs: online ? m.p95LatencyMs : 0,
        cpuPercent: online ? m.cpuPercent : 0,
        eventLoopLagMs: online ? m.eventLoopLagMs : 0,
        errors: online ? m.errors : 0,
        reqPerSec: requests.byNode[id] || 0,
        health: online ? Math.round(healthScore({ cpu: m.cpuPercent, lag: m.eventLoopLagMs }, weights) * 100) : 0
      };
    }

    const strategies = STRATEGY_NAMES.map(name => {
      const stat = stats.get(name);
      const nodeTotal = sum(Object.values(stat.nodeRequests));
      return {
        name,
        active: name === current,
        sharePct: percent(stat.totalRequests, allRequests),
        avgReqPerSec: stat.windows ? stat.totalRequests / stat.windows : 0,
        avgP95: stat.windows ? stat.sumP95 / stat.windows : 0,
        totalRequests: stat.totalRequests,
        activeSeconds: stat.activeSeconds,
        nodeRequests: stat.nodeRequests,
        nodeShare: Object.fromEntries(ids.map(id => [id, percent(stat.nodeRequests[id] || 0, nodeTotal)]))
      };
    });

    return {
      ts: now,
      uptimeSec: Math.floor((now - startedAt) / 1000),
      mode: options.mode,
      strategy: current,
      workloadClass,
      gatewayStrategy: gateway.strategy,
      gatewayFallback: gateway.fallback,
      limits: { lagMaxMs: options.lagMaxMs },
      status: {
        nats: bus.connected,
        mongo: store.up(),
        gateway: now - gateway.at <= 3000,
        nodes: Object.fromEntries(ids.map(id => [id, nodeState[id].online]))
      },
      nodes: nodeState,
      totals: { ...totals, reqPerSec: requests.total },
      strategies,
      point: history[history.length - 1] || null
    };
  }

  async function start() {
    for (const saved of await store.loadStats()) {
      if (!stats.has(saved.strategy)) continue;
      stats.set(saved.strategy, { ...emptyStat(saved.strategy), ...saved, nodeRequests: { ...saved.nodeRequests } });
    }
    bandit = newBandit(await store.loadBandit());
    decisions = await store.loadDecisions(options.decisionsShown);

    if (options.strategy !== active) console.warn(`[control-plane] unknown strategy "${options.strategy}", using ${active}`);
    console.log(`[control-plane] mode=${options.mode} initial strategy=${active}`);

    recordDecision({
      strategy: active,
      reason: adaptive ? `start: adaptive mode, initial strategy ${active}` : 'start: static strategy from STATIC_STRATEGY'
    });

    timers = [
      setInterval(tick, TICK_MS),
      setInterval(() => store.saveStats([...stats.values()]), options.flushSec * 1000)
    ];
  }

  async function stop() {
    timers.forEach(clearInterval);
    await store.saveStats([...stats.values()]);
    await bus.close();
  }

  async function resetStats() {
    for (const name of stats.keys()) stats.set(name, emptyStat(name));
    await store.clearStats();
  }

  async function resetBandit() {
    bandit = newBandit();
    await store.clearBandit();
  }

  return {
    events,
    start,
    stop,
    getState,
    resetStats,
    resetBandit,
    getHistory: () => ({ limit: options.historyPoints, points: [...history], decisions })
  };
}

module.exports = { createController };
