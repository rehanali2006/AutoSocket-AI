require('dotenv').config();
const autocannon = require('autocannon');
const { env, envNumber } = require('../../lib');

const path = process.argv[2] || '/api/ping';

autocannon(
  {
    url: `${env('GATEWAY_URL')}${path}`,
    connections: envNumber('BENCH_CONNECTIONS'),
    duration: envNumber('BENCH_DURATION_SEC')
  },
  (err, result) => {
    if (err) {
      console.error(err.message);
      process.exit(1);
    }
    console.log(JSON.stringify({
      path,
      requestsPerSec: result.requests.average,
      latencyAvgMs: result.latency.average,
      latencyP99Ms: result.latency.p99,
      errors: result.errors,
      timeouts: result.timeouts,
      non2xx: result.non2xx
    }, null, 2));
  }
);
