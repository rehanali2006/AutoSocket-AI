module.exports = function consistentHash() {
  return {
    name: 'consistent-hash',
    balancing: 'hash $hash_key consistent;',
    weightOf: () => 1
  };
};
