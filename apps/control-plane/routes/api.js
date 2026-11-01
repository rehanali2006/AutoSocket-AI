const express = require('express');

const PROFILES = ['chat', 'image', 'video', 'mixed'];

module.exports = function apiRoutes({ controller, loadgenUrl }) {
  const router = express.Router();

  async function callLoadgen(path) {
    const response = await fetch(`${loadgenUrl}${path}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    return response.json();
  }

  router.get('/state', (req, res) => res.json(controller.getState()));
  router.get('/history', (req, res) => res.json(controller.getHistory()));

  router.post('/reset/stats', async (req, res) => {
    await controller.resetStats();
    res.json({ ok: true });
  });

  router.post('/reset/bandit', async (req, res) => {
    await controller.resetBandit();
    res.json({ ok: true });
  });

  router.post('/load/stop', async (req, res) => {
    try {
      res.json(await callLoadgen('/stop'));
    } catch (err) {
      res.status(502).json({ error: 'loadgen unreachable' });
    }
  });

  router.post('/load/:profile', async (req, res) => {
    if (!PROFILES.includes(req.params.profile)) return res.status(400).json({ error: 'unknown profile' });
    try {
      res.json(await callLoadgen(`/start/${req.params.profile}`));
    } catch (err) {
      res.status(502).json({ error: 'loadgen unreachable' });
    }
  });

  return router;
};
