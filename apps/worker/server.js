require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { attachMetricsReporter, env, envNumber } = require('../../lib');

const nodeId = env('NODE_ID');
const port = envNumber('WORKER_PORT');
const workRounds = envNumber('WORK_ROUNDS');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: envNumber('MAX_PAYLOAD_BYTES') });

const reporter = attachMetricsReporter(io, {
  nodeId,
  natsUrl: env('NATS_URL'),
  cpuLimit: envNumber('CPU_LIMIT')
});

const digest = data => crypto.createHash('sha256').update(data).digest('hex');

function reply(ack, body) {
  if (typeof ack === 'function') ack({ node: nodeId, ...body });
}

app.use((req, res, next) => {
  res.setHeader('X-Node-Id', nodeId);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', nodeId, connections: io.engine.clientsCount });
});

app.use((req, res, next) => {
  reporter.accept();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    reporter.record({
      bytes: Number(req.headers['content-length'] || 0),
      latencyMs: Number(process.hrtime.bigint() - started) / 1e6
    });
  });
  next();
});

app.get('/api/ping', (req, res) => {
  res.json({ nodeId, ts: Date.now() });
});

app.get('/api/work', (req, res) => {
  crypto.pbkdf2Sync('adaptive', nodeId, workRounds, 32, 'sha256');
  res.json({ nodeId, ts: Date.now() });
});

io.on('connection', socket => {
  socket.on('chat', (message, ack) => {
    reply(ack, { ok: true, id: digest(JSON.stringify(message)).slice(0, 8) });
  });

  for (const event of ['image', 'video-chunk']) {
    socket.on(event, (data, ack) => {
      if (!Buffer.isBuffer(data)) {
        reporter.recordError();
        reply(ack, { ok: false });
        return;
      }
      reply(ack, { ok: true, bytes: data.length, sha: digest(data) });
    });
  }
});

process.on('uncaughtException', err => console.error(`[${nodeId}] uncaught: ${err.message}`));
process.on('unhandledRejection', err => console.error(`[${nodeId}] unhandled: ${err}`));

server.listen(port, () => console.log(`[${nodeId}] listening on ${port}`));

process.on('SIGTERM', async () => {
  await reporter.stop();
  server.close(() => process.exit(0));
});
