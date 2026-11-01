require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { createController, parseNodes, env, envNumber } = require('../../lib');
const store = require('./models/store');
const pageRoutes = require('./routes/pages');
const apiRoutes = require('./routes/api');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const loadgenUrl = env('LOADGEN_URL');

const controller = createController({
  natsUrl: env('NATS_URL'),
  nodeIds: parseNodes(env('NODES')).map(node => node.id),
  store,
  options: {
    mode: env('SELECTOR_MODE'),
    strategy: env('STATIC_STRATEGY'),
    fallbackStrategy: env('FALLBACK_STRATEGY'),
    selectIntervalSec: envNumber('SELECT_INTERVAL_SEC'),
    minDwellSec: envNumber('MIN_DWELL_SEC'),
    hysteresis: envNumber('HYSTERESIS'),
    confirmWindows: envNumber('CLASS_CONFIRM_WINDOWS'),
    exploration: envNumber('BANDIT_EXPLORATION'),
    thresholds: {
      chatBytes: envNumber('CLASSIFY_CHAT_BYTES'),
      mediaBytes: envNumber('CLASSIFY_MEDIA_BYTES'),
      minMessagesPerSec: envNumber('CLASSIFY_MIN_MSGS_PER_SEC'),
      churnPerSec: envNumber('CLASSIFY_CHURN_PER_SEC')
    },
    reward: {
      weights: {
        latency: envNumber('REWARD_W_LATENCY'),
        error: envNumber('REWARD_W_ERROR'),
        balance: envNumber('REWARD_W_BALANCE')
      },
      ceilings: {
        p95Ms: envNumber('REWARD_P95_CEIL_MS'),
        errorRate: envNumber('REWARD_ERROR_CEIL'),
        cv: envNumber('REWARD_CV_CEIL')
      }
    },
    metricsStaleSec: envNumber('METRICS_STALE_SEC'),
    historyPoints: envNumber('HISTORY_POINTS'),
    decisionsShown: envNumber('DECISIONS_SHOWN'),
    flushSec: envNumber('STATS_FLUSH_SEC'),
    cpuWeight: envNumber('WEIGHT_CPU'),
    lagWeight: envNumber('WEIGHT_LAG'),
    lagMaxMs: envNumber('LAG_MAX_MS')
  }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiRoutes({ controller, loadgenUrl }));
app.use('/', pageRoutes({ store }));
app.get('/health', (req, res) => res.json({ status: 'ok', mongo: store.up() }));

let loadgen = { running: false };

async function pollLoadgen() {
  try {
    const response = await fetch(`${loadgenUrl}/status`, { signal: AbortSignal.timeout(1500) });
    loadgen = await response.json();
  } catch (err) {
    loadgen = { running: false, offline: true };
  }
}

io.on('connection', socket => socket.emit('history', controller.getHistory()));
controller.events.on('update', state => io.emit('state', { ...state, loadgen }));
controller.events.on('decision', decision => io.emit('decision', decision));

async function connectMongo() {
  mongoose.connection.on('disconnected', () => console.warn('[control-plane] mongo disconnected'));
  mongoose.connection.on('reconnected', () => console.log('[control-plane] mongo reconnected'));
  while (true) {
    try {
      await mongoose.connect(env('MONGO_URL'), { serverSelectionTimeoutMS: 3000 });
      console.log('[control-plane] mongo connected');
      return;
    } catch (err) {
      console.error(`[control-plane] mongo connect failed: ${err.message}`);
      await wait(2000);
    }
  }
}

process.on('uncaughtException', err => console.error(`[control-plane] uncaught: ${err.message}`));
process.on('unhandledRejection', err => console.error(`[control-plane] unhandled: ${err}`));

async function main() {
  const port = envNumber('CONTROL_PLANE_PORT');
  server.listen(port, () => console.log(`[control-plane] dashboard on ${port}`));
  setInterval(pollLoadgen, 2000);
  await connectMongo();
  await controller.start();
}

main();

process.on('SIGTERM', async () => {
  await controller.stop();
  server.close(() => process.exit(0));
});
