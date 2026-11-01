module.exports = function leastConnections() {
  return {
    name: 'least-connections',
    balancing: 'least_conn;',
    weightOf: () => 1
  };
};
