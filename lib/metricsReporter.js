const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');
const { createBus } = require('./natsClient');

const LOOP_RESOLUTION_MS = 10;
const MAX_LATENCY_SAMPLES = 5000;

function measure(value, depth = 0) {
  if (value === null || value === undefined || typeof value === 'function') return 0;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (typeof value === 'object' && depth < 3) {
    let total = 0;
    for (const key of Object.keys(value)) total += key.length + measure(value[key], depth + 1);
    return total;
  }
  return 8;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const round = value => Math.round(value * 100) / 100;
const freshWindow = () => ({ messages: 0, bytes: 0, latencies: [], errors: 0, accepted: 0 });

function attachMetricsReporter(io, { nodeId, natsUrl, cpuLimit = os.cpus().length, intervalMs = 1000 }) {
  const bus = createBus(natsUrl, nodeId);
  const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loop.enable();

  let window = freshWindow();
  let lastCpu = process.cpuUsage();
  let lastTick = process.hrtime.bigint();

  function record({ bytes = 0, latencyMs = 0 }) {
    window.messages += 1;
    window.bytes += bytes;
    if (window.latencies.length < MAX_LATENCY_SAMPLES) window.latencies.push(latencyMs);
  }

  function recordError() {
    window.errors += 1;
  }

  function accept() {
    window.accepted += 1;
  }

  io.on('connection', socket => {
    socket.onAny((event, ...args) => {
      const started = process.hrtime.bigint();
      const bytes = measure(args);
      setImmediate(() => {
        record({ bytes, latencyMs: Number(process.hrtime.bigint() - started) / 1e6 });
      });
    });
    socket.on('error', recordError);
  });

  if (io.engine) {
    io.engine.on('connection_error', recordError);
    io.engine.on('connection', accept);
    io.engine.on('headers', headers => {
      headers['X-Node-Id'] = nodeId;
    });
  }

  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const cpu = process.cpuUsage();
    const elapsedUs = Number(now - lastTick) / 1000;
    const usedUs = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
    const seconds = elapsedUs / 1e6;
    const current = window;

    window = freshWindow();
    lastCpu = cpu;
    lastTick = now;

    const lag = Number.isFinite(loop.mean) ? Math.max(0, loop.mean / 1e6 - LOOP_RESOLUTION_MS) : 0;
    loop.reset();

    bus.publish(`lb.metrics.${nodeId}`, {
      nodeId,
      ts: Date.now(),
      connections: io.engine ? io.engine.clientsCount : 0,
      messagesPerSec: round(current.messages / seconds),
      avgPayloadBytes: current.messages ? Math.round(current.bytes / current.messages) : 0,
      p95LatencyMs: round(percentile(current.latencies, 95)),
      cpuPercent: round(Math.min(100, (usedUs / elapsedUs / cpuLimit) * 100)),
      eventLoopLagMs: round(lag),
      errors: current.errors,
      accepted: current.accepted
    });
  }, intervalMs);

  return {
    record,
    recordError,
    accept,
    stop() {
      clearInterval(timer);
      loop.disable();
      return bus.close();
    }
  };
}

module.exports = { attachMetricsReporter };
