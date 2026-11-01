const { attachMetricsReporter } = require('./metricsReporter');
const { createAdaptiveBalancer, renderNginxConfig, renderBootstrapConfig, parseNodes } = require('./balancer');
const { createController } = require('./controller');
const { createStrategies, STRATEGY_NAMES } = require('./strategies');
const { createBandit, computeReward } = require('./bandit');
const { classify } = require('./classifier');
const { createBus } = require('./natsClient');

function env(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Missing environment variable ${name}`);
  return value;
}

function envNumber(name) {
  const value = Number(env(name));
  if (Number.isNaN(value)) throw new Error(`Environment variable ${name} must be a number`);
  return value;
}

module.exports = {
  attachMetricsReporter,
  createAdaptiveBalancer,
  renderNginxConfig,
  renderBootstrapConfig,
  createController,
  createStrategies,
  createBandit,
  computeReward,
  classify,
  createBus,
  parseNodes,
  STRATEGY_NAMES,
  env,
  envNumber
};
