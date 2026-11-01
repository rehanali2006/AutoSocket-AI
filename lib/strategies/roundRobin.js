module.exports = function roundRobin() {
  return {
    name: 'round-robin',
    balancing: null,
    weightOf: () => 1
  };
};
