module.exports = function powerOfTwo() {
  return {
    name: 'power-of-two',
    balancing: 'random two least_conn;',
    weightOf: () => 1
  };
};
