const roundRobin = require('./roundRobin');
const leastConnections = require('./leastConnections');
const weighted = require('./weighted');
const consistentHash = require('./consistentHash');
const powerOfTwo = require('./powerOfTwo');

const factories = [roundRobin, leastConnections, weighted, consistentHash, powerOfTwo];

function createStrategies(options = {}) {
  const strategies = {};
  for (const factory of factories) {
    const strategy = factory(options);
    strategies[strategy.name] = strategy;
  }
  return strategies;
}

const STRATEGY_NAMES = ['round-robin', 'least-connections', 'weighted', 'consistent-hash', 'power-of-two'];

module.exports = { createStrategies, STRATEGY_NAMES };
