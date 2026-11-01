require('dotenv').config();
const http = require('http');
const { createAdaptiveBalancer, renderBootstrapConfig, parseNodes, env, envNumber } = require('../../lib');
const { createNginxProcess } = require('./nginx');

const nginx = createNginxProcess({ binary: env('NGINX_BIN'), configPath: env('NGINX_CONF_PATH') });

const balancer = createAdaptiveBalancer({
  nodes: parseNodes(env('NODES')),
  natsUrl: env('NATS_URL'),
  applyConfig: nginx.apply,
  options: {
    port: envNumber('GATEWAY_PORT'),
    agentPort: envNumber('GATEWAY_AGENT_PORT'),
    workers: envNumber('NGINX_WORKERS'),
    cookieName: env('STICKY_COOKIE'),
    cookieTtlSec: envNumber('STICKY_TTL_SEC'),
    strategyStaleSec: envNumber('STRATEGY_STALE_SEC'),
    metricsStaleSec: envNumber('METRICS_STALE_SEC'),
    fallbackStrategy: env('FALLBACK_STRATEGY'),
    maxFails: envNumber('NGINX_MAX_FAILS'),
    failTimeoutSec: envNumber('NGINX_FAIL_TIMEOUT_SEC'),
    minReloadSec: envNumber('NGINX_MIN_RELOAD_SEC'),
    weightDelta: envNumber('WEIGHT_RELOAD_DELTA'),
    cpuWeight: envNumber('WEIGHT_CPU'),
    lagWeight: envNumber('WEIGHT_LAG'),
    lagMaxMs: envNumber('LAG_MAX_MS')
  }
});

const agent = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(balancer.health()));
    return;
  }
  res.writeHead(404);
  res.end();
});

process.on('uncaughtException', err => console.error(`[gateway] uncaught: ${err.message}`));
process.on('unhandledRejection', err => console.error(`[gateway] unhandled: ${err}`));

agent.listen(envNumber('GATEWAY_AGENT_PORT'), '127.0.0.1', async () => {
  try {
    await nginx.apply(renderBootstrapConfig({ port: envNumber('GATEWAY_PORT'), agentPort: envNumber('GATEWAY_AGENT_PORT') }));
  } catch (err) {
    console.error(`[gateway] nginx failed to start: ${err.message}`);
    process.exit(1);
  }
  console.log(`[gateway] nginx on ${envNumber('GATEWAY_PORT')}, agent on ${envNumber('GATEWAY_AGENT_PORT')}`);
  balancer.start();
});

process.on('SIGTERM', async () => {
  await balancer.close();
  nginx.stop();
  agent.close(() => process.exit(0));
});
