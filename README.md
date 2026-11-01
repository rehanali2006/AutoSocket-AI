# adaptive-socket-balancer

An nginx gateway and a small library that sit in front of any Socket.IO app. They watch live traffic and switch the load-balancing strategy for new connections automatically, so nobody has to pick one by hand.

## Run it

```
cp .env.example .env
docker compose up --build
```

| What | Where |
|---|---|
| Dashboard | http://localhost:3000 |
| Benchmark page | http://localhost:3000/benchmark |
| Gateway, nginx (point clients here) | http://localhost:8080 |
| NATS monitoring | http://localhost:8222 |

Use the buttons in the dashboard to start chat, image, video or mixed load. For plain HTTP load through the gateway:

```
docker compose exec loadgen npm run bench:ping
docker compose exec loadgen npm run bench:work
```

## How it works

```
clients -> nginx (gateway) -> worker1 / worker2 / worker3
              ^   |                  |
   lb.strategy|   |lb.requests       |lb.metrics.<node>
              |   v                  v
            control plane (NATS) -> MongoDB, dashboard
```

NATS core pub/sub is the only backplane. There is no LLM and no Redis anywhere.

- `lb.metrics.<nodeId>`: every worker, every second: connections, messages/sec, average payload, p95 latency, CPU, event-loop lag, errors, and how many new connections and HTTP requests it accepted.
- `lb.requests`: the gateway agent, every second: accepted requests per node under the strategy nginx was running.
- `lb.strategy`: the control plane, every second: the active strategy and workload class.

### The nginx gateway

The `gateway` container runs nginx plus a small Node agent. The agent listens to `lb.strategy` and `lb.metrics.>`, renders an nginx config for the chosen strategy, checks it with `nginx -t`, and reloads nginx. A reload is graceful: the old nginx workers finish their existing connections and only new connections use the new strategy. That is what "the strategy only chooses the node for new connections" means here.

| Strategy | What nginx does |
|---|---|
| round-robin | default upstream |
| least-connections | `least_conn;` |
| weighted | server `weight=` values from each worker's CPU and event-loop lag health score |
| consistent-hash | `hash $hash_key consistent;` on `room`, then `userId`, then client address |
| power-of-two | `random two least_conn;` |

Sticky sessions: nginx open source has no cookie stickiness, so the config pins a client with the `lb_node` cookie using a `map` to a per-node upstream group (the other nodes are `backup`, so a client still gets served if its node dies). The cookie is set from the `X-Node-Id` header that the workers add.

The agent only reloads when the rendered config actually changes, at most once per `NGINX_MIN_RELOAD_SEC`. Small weight changes (under `WEIGHT_RELOAD_DELTA`) are ignored so metrics noise does not cause reload storms. Workers with no fresh metrics are removed from the config.

To see it working:

```
curl -si localhost:8080/api/ping | grep -i "x-lb-strategy\|x-node-id"
docker compose exec gateway cat /tmp/nginx.conf
```

### Deciding the strategy

Every `SELECT_INTERVAL_SEC` seconds the control plane looks at the window it just collected:

1. A rule-based classifier (`lib/classifier.js`) labels the workload `chat-like`, `media-heavy` or `mixed` from average payload size, messages/sec and connections/sec. Thresholds are in `.env`.
2. The window gets a reward between 0 and 1: low p95 latency, low error rate and an even spread of connections across servers, weighted by `REWARD_W_*`.
3. A UCB1 bandit (`lib/bandit.js`) keeps one table per workload class. It tries every strategy once, then picks by mean reward plus an exploration bonus. State is stored in MongoDB and survives restarts.

### Safety rules

- Cooldown: no switch within `MIN_DWELL_SEC` of the previous one.
- Hysteresis: a switch needs a score gain of at least `HYSTERESIS`, and a new workload class must be seen `CLASS_CONFIRM_WINDOWS` windows in a row.
- Fallback: the gateway agent switches nginx to round-robin when the `lb.strategy` heartbeat is older than `STRATEGY_STALE_SEC`, or when no worker metrics are fresh. The control plane does the same when metrics disappear.
- NATS and MongoDB connections retry forever. Writes are skipped while Mongo is down.
- Every decision is logged with its features and reason, shown in the dashboard and stored in `decisions`.

Set `SELECTOR_MODE=static` and `STATIC_STRATEGY=<name>` to pin one strategy.

## Use it in your own app

Your Socket.IO server:

```js
const { attachMetricsReporter } = require('./lib');

attachMetricsReporter(io, { nodeId: 'app-1', natsUrl: process.env.NATS_URL });
```

The gateway agent (`apps/gateway/server.js` has the full version, including the nginx process helper):

```js
const { createAdaptiveBalancer, parseNodes } = require('./lib');
const { createNginxProcess } = require('./apps/gateway/nginx');

const nginx = createNginxProcess({ binary: 'nginx', configPath: '/tmp/nginx.conf' });
const balancer = createAdaptiveBalancer({ nodes: parseNodes(process.env.NODES), natsUrl: process.env.NATS_URL, applyConfig: nginx.apply });
balancer.start();
```

You also need the control plane running (it publishes `lb.strategy`). Without it the gateway stays on round-robin.

## Benchmark guide

Run the same mixed load against each strategy, then against adaptive mode, and read `/benchmark`.

```
docker compose up -d --build
curl -X POST localhost:3000/api/reset/stats
curl -X POST localhost:3000/api/reset/bandit

for s in round-robin least-connections weighted consistent-hash power-of-two; do
  sed -i "s/^SELECTOR_MODE=.*/SELECTOR_MODE=static/;s/^STATIC_STRATEGY=.*/STATIC_STRATEGY=$s/" .env
  docker compose up -d --force-recreate control-plane
  sleep 20
  curl -X POST localhost:3000/api/load/mixed
  sleep 120
  curl -X POST localhost:3000/api/load/stop
  sleep 10
done

sed -i "s/^SELECTOR_MODE=.*/SELECTOR_MODE=adaptive/" .env
docker compose up -d --force-recreate control-plane
sleep 20
curl -X POST localhost:3000/api/load/mixed
sleep 900
curl -X POST localhost:3000/api/load/stop
```

Then open http://localhost:3000/benchmark. All numbers there come from your own run; this repo does not ship any.

## Tests

```
npm install
npm test
```

Jest covers every strategy, the nginx config renderer, the gateway agent (fallback, stale nodes, reload throttling), the classifier, the bandit and the reward function. GitHub Actions (`.github/workflows/ci.yml`) installs, runs the tests and builds the Docker image.

## Layout

```
lib/        strategies, classifier, bandit, controller, metrics reporter, balancer (nginx config + agent), NATS client
apps/       worker, gateway (nginx process + agent), control-plane (routes, models, views, public), loadgen
tests/      Jest tests
```

## Limits

- The strategy only picks the node for new connections. Existing sockets stay where they are. After a reload, old nginx workers stay alive until their last socket closes, so many reloads with very long-lived sockets leave old workers around.
- Request counts come from the workers (new connections plus HTTP requests they accepted), attributed to the strategy nginx was running at that moment. nginx only logs a WebSocket when it closes, so the access log would have arrived too late for a live dashboard.
- Cross-node room broadcast is not implemented. A room's members on different workers will not see each other's messages. This is a possible future extension (for example a NATS-based Socket.IO adapter).
- Worker p95 latency is measured from message receipt to the next event-loop turn after its handlers run. Time spent in async handlers is not included.
- "Consistent hash" uses rendezvous hashing, which has the same stability property without a ring.
- I could not run `nginx -t` while building this, so the generated config is covered by unit tests on its text. The gateway also runs `nginx -t` on every config before reloading and keeps the old one if the test fails.
