const { createBus } = require('./natsClient');
const { createStrategies } = require('./strategies');

const safe = id => id.replace(/[^A-Za-z0-9_]/g, '_');

function parseNodes(text) {
  return text
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [id, ...rest] = entry.split('=');
      return { id, target: rest.join('=') };
    });
}

function renderNginxConfig({ strategy, nodes, port, agentPort, cookieName, cookieTtlSec, workers, maxFails, failTimeoutSec }) {
  const tuning = `max_fails=${maxFails} fail_timeout=${failTimeoutSec}s`;

  const balanced = [
    '        zone balanced 64k;',
    strategy.balancing ? `        ${strategy.balancing}` : null,
    ...nodes.map(node => `        server ${node.host} weight=${node.weight} ${tuning};`)
  ].filter(Boolean);

  const pinned = nodes
    .map(node =>
      [
        `    upstream pin_${safe(node.id)} {`,
        `        zone pin_${safe(node.id)} 64k;`,
        `        server ${node.host} ${tuning};`,
        ...nodes.filter(other => other.id !== node.id).map(other => `        server ${other.host} backup ${tuning};`),
        '    }'
      ].join('\n')
    )
    .join('\n\n');

  const pools = nodes.map(node => `        ${node.id} pin_${safe(node.id)};`).join('\n');
  const unchanged = nodes.map(node => `        "${node.id}|${node.id}" "";`).join('\n');

  return `worker_processes ${workers};
user nginx;
pid /tmp/nginx.pid;
error_log stderr warn;

events {
    worker_connections 8192;
}

http {
    access_log off;
    server_tokens off;
    client_body_temp_path /tmp/nginx/client_body;
    proxy_temp_path /tmp/nginx/proxy;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    map $arg_room $hash_user {
        ''      $arg_userId;
        default $arg_room;
    }

    map $hash_user $hash_key {
        ''      $remote_addr;
        default $hash_user;
    }

    map $cookie_${cookieName} $pool {
        default balanced;
${pools}
    }

    map "$cookie_${cookieName}|$upstream_http_x_node_id" $set_sticky {
        default "${cookieName}=$upstream_http_x_node_id; Path=/; Max-Age=${cookieTtlSec}; HttpOnly; SameSite=Lax";
        "~[|]$" "";
${unchanged}
    }

    upstream balanced {
${balanced.join('\n')}
    }

${pinned}

    server {
        listen ${port};

        location = /health {
            proxy_pass http://127.0.0.1:${agentPort}/health;
        }

        location / {
            proxy_pass http://$pool;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_next_upstream error timeout http_502 http_503;
            proxy_buffering off;
            proxy_request_buffering off;
            proxy_read_timeout 3600s;
            proxy_send_timeout 3600s;
            client_max_body_size 0;
            add_header Set-Cookie $set_sticky always;
            add_header X-LB-Strategy ${strategy.name} always;
        }
    }
}
`;
}

function renderBootstrapConfig({ port, agentPort }) {
  return `worker_processes 1;
user nginx;
pid /tmp/nginx.pid;
error_log stderr warn;

events {
    worker_connections 1024;
}

http {
    access_log off;
    server_tokens off;

    server {
        listen ${port};

        location = /health {
            proxy_pass http://127.0.0.1:${agentPort}/health;
        }

        location / {
            default_type application/json;
            return 503 '{"error":"gateway is starting or has no usable workers, open /health for details"}';
        }
    }
}
`;
}

function settleWeights(previous, next, delta) {
  const ids = Object.keys(next);
  const stable = ids.every(id => previous[id] !== undefined && Math.abs(previous[id] - next[id]) < delta);
  return stable ? Object.fromEntries(ids.map(id => [id, previous[id]])) : next;
}

function createAdaptiveBalancer({ nodes, natsUrl, options = {}, applyConfig, bus = createBus(natsUrl, 'gateway') }) {
  const config = {
    port: 8080,
    agentPort: 9000,
    workers: 2,
    cookieName: 'lb_node',
    cookieTtlSec: 3600,
    strategyStaleSec: 5,
    metricsStaleSec: 5,
    fallbackStrategy: 'round-robin',
    maxFails: 2,
    failTimeoutSec: 5,
    minReloadSec: 2,
    weightDelta: 10,
    evaluateMs: 1000,
    publishMs: 1000,
    ...options
  };

  const strategies = createStrategies(config);
  const pool = new Map(nodes.map(node => [node.id, { id: node.id, host: new URL(node.target).host, cpu: 0, lag: 0, lastSeen: 0 }]));
  const counts = new Map();

  let beat = { strategy: null, at: 0 };
  let applied = { text: null, strategy: null, weights: {} };
  let lastApplyAt = 0;
  let applying = false;
  let reloads = 0;
  let lastError = null;
  let wasFallback = true;
  let timers = [];

  const isFallback = () => Date.now() - beat.at > config.strategyStaleSec * 1000 || !strategies[beat.strategy];

  bus.subscribe('lb.strategy', message => {
    if (!strategies[message.strategy]) return;
    if (message.strategy !== beat.strategy) console.log(`[gateway] strategy ${beat.strategy || 'none'} -> ${message.strategy}`);
    beat = { strategy: message.strategy, at: Date.now() };
  });

  bus.subscribe('lb.metrics.>', message => {
    const node = pool.get(message.nodeId);
    if (!node) return;
    node.cpu = message.cpuPercent;
    node.lag = message.eventLoopLagMs;
    node.lastSeen = Date.now();
    if (message.accepted > 0) {
      const name = applied.strategy || config.fallbackStrategy;
      if (!counts.has(name)) counts.set(name, new Map());
      const byNode = counts.get(name);
      byNode.set(node.id, (byNode.get(node.id) || 0) + message.accepted);
    }
  });

  function plan() {
    const now = Date.now();
    const all = [...pool.values()];
    const live = all.filter(node => now - node.lastSeen <= config.metricsStaleSec * 1000);
    const strategy = strategies[isFallback() || !live.length ? config.fallbackStrategy : beat.strategy];
    const members = live.length ? live : all;
    const raw = Object.fromEntries(members.map(node => [node.id, strategy.weightOf(node)]));
    const weights = settleWeights(applied.weights, raw, config.weightDelta);
    return {
      strategy,
      weights,
      nodes: members.map(node => ({ id: node.id, host: node.host, weight: weights[node.id] }))
    };
  }

  async function evaluate() {
    if (applying) return;
    const next = plan();
    const text = renderNginxConfig({ ...config, strategy: next.strategy, nodes: next.nodes });
    if (text === applied.text) return;
    if (applied.text && Date.now() - lastApplyAt < config.minReloadSec * 1000) return;

    applying = true;
    try {
      await applyConfig(text);
      applied = { text, strategy: next.strategy.name, weights: next.weights };
      lastApplyAt = Date.now();
      lastError = null;
      reloads += 1;
      console.log(`[gateway] nginx config applied: strategy=${next.strategy.name} nodes=${next.nodes.map(n => `${n.id}:${n.weight}`).join(',')}`);
    } catch (err) {
      if (lastError !== err.message) console.error(`[gateway] nginx apply failed: ${err.message}`);
      lastError = err.message;
    } finally {
      applying = false;
    }
  }

  function publishRequests() {
    const fallback = isFallback();
    if (fallback !== wasFallback) {
      console.warn(fallback ? `[gateway] strategy heartbeat missing, using ${config.fallbackStrategy}` : '[gateway] strategy heartbeat restored');
      wasFallback = fallback;
    }

    const strategiesPayload = {};
    for (const [name, byNode] of counts) strategiesPayload[name] = Object.fromEntries(byNode);

    const sent = bus.publish('lb.requests', {
      ts: Date.now(),
      activeStrategy: applied.strategy || config.fallbackStrategy,
      fallback,
      strategies: strategiesPayload
    });
    if (sent) counts.clear();
  }

  function health() {
    const now = Date.now();
    return {
      status: 'ok',
      nats: bus.connected,
      strategy: applied.strategy,
      fallback: isFallback(),
      reloads,
      lastError,
      nodes: [...pool.values()].map(node => ({ id: node.id, live: now - node.lastSeen <= config.metricsStaleSec * 1000 }))
    };
  }

  function start() {
    evaluate();
    timers = [setInterval(evaluate, config.evaluateMs), setInterval(publishRequests, config.publishMs)];
  }

  async function close() {
    timers.forEach(clearInterval);
    await bus.close();
  }

  return { start, close, evaluate, publishRequests, health };
}

module.exports = { createAdaptiveBalancer, renderNginxConfig, renderBootstrapConfig, parseNodes };
