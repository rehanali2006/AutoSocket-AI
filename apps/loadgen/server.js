require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { io } = require('socket.io-client');
const { env, envNumber } = require('../../lib');

const gatewayUrl = env('GATEWAY_URL');
const rooms = envNumber('LOADGEN_ROOMS');
const lifetimeMin = envNumber('CLIENT_LIFETIME_MIN_SEC');
const lifetimeMax = envNumber('CLIENT_LIFETIME_MAX_SEC');
const mixedScale = envNumber('MIXED_SCALE');

const between = (min, max) => min + Math.random() * (max - min);
const pool = crypto.randomBytes(Math.max(envNumber('IMAGE_MAX_BYTES'), envNumber('VIDEO_MAX_BYTES')));
const slice = (min, max) => pool.subarray(0, Math.floor(between(min, max)));

const kinds = {
  chat: {
    event: 'chat',
    clients: envNumber('LOADGEN_CHAT_CLIENTS'),
    intervalMs: envNumber('CHAT_INTERVAL_MS'),
    payload: () => ({ text: `hello ${crypto.randomBytes(6).toString('hex')}`, sentAt: Date.now() })
  },
  image: {
    event: 'image',
    clients: envNumber('LOADGEN_IMAGE_CLIENTS'),
    intervalMs: envNumber('IMAGE_INTERVAL_MS'),
    payload: () => slice(envNumber('IMAGE_MIN_BYTES'), envNumber('IMAGE_MAX_BYTES'))
  },
  video: {
    event: 'video-chunk',
    clients: envNumber('LOADGEN_VIDEO_CLIENTS'),
    intervalMs: envNumber('VIDEO_INTERVAL_MS'),
    payload: () => slice(envNumber('VIDEO_MIN_BYTES'), envNumber('VIDEO_MAX_BYTES'))
  }
};

const profiles = {
  chat: { chat: 1 },
  image: { image: 1 },
  video: { video: 1 },
  mixed: { chat: mixedScale, image: mixedScale, video: mixedScale }
};

let run = null;

function spawn(kind, current) {
  const spec = kinds[kind];
  const socket = io(gatewayUrl, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    query: { room: `room-${Math.floor(Math.random() * rooms)}`, userId: crypto.randomUUID() }
  });
  current.sockets.add(socket);

  let sendTimer = null;
  let ended = false;

  const end = delayMs => {
    if (ended) return;
    ended = true;
    clearTimeout(sendTimer);
    clearTimeout(lifeTimer);
    current.sockets.delete(socket);
    socket.close();
    if (!current.stopped) setTimeout(() => !current.stopped && spawn(kind, current), delayMs);
  };

  const lifeTimer = setTimeout(() => end(100 + Math.random() * 400), between(lifetimeMin, lifetimeMax) * 1000);

  const send = () => {
    if (ended || !socket.connected) return;
    socket.timeout(5000).emit(spec.event, spec.payload(), err => {
      if (err) current.errors += 1;
      else current.acks += 1;
      sendTimer = setTimeout(send, spec.intervalMs);
    });
  };

  socket.on('connect', send);
  socket.on('disconnect', () => end(1000));
  socket.on('connect_error', () => {
    current.errors += 1;
    end(1000);
  });
}

function stop() {
  if (!run) return;
  run.stopped = true;
  run.sockets.forEach(socket => socket.close());
  run.sockets.clear();
}

function start(profile) {
  stop();
  const current = { profile, stopped: false, sockets: new Set(), acks: 0, errors: 0, startedAt: Date.now() };
  run = current;

  let index = 0;
  for (const [kind, scale] of Object.entries(profiles[profile])) {
    const total = Math.max(1, Math.round(kinds[kind].clients * scale));
    for (let i = 0; i < total; i += 1) {
      setTimeout(() => !current.stopped && spawn(kind, current), index * 25);
      index += 1;
    }
  }
}

function status() {
  if (!run || run.stopped) return { running: false };
  return {
    running: true,
    profile: run.profile,
    clients: run.sockets.size,
    acks: run.acks,
    errors: run.errors,
    startedAt: run.startedAt
  };
}

const app = express();

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/status', (req, res) => res.json(status()));

app.post('/start/:profile', (req, res) => {
  if (!profiles[req.params.profile]) return res.status(400).json({ error: 'unknown profile' });
  start(req.params.profile);
  res.json(status());
});

app.post('/stop', (req, res) => {
  stop();
  res.json(status());
});

process.on('uncaughtException', err => console.error(`[loadgen] uncaught: ${err.message}`));

const port = envNumber('LOADGEN_PORT');
app.listen(port, () => console.log(`[loadgen] listening on ${port}`));
