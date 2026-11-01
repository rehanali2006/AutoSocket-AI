const { renderNginxConfig, renderBootstrapConfig } = require('../lib/balancer');
const { createStrategies } = require('../lib/strategies');

const strategies = createStrategies({});
const nodes = [
  { id: 'worker1', host: 'worker1:4000', weight: 1 },
  { id: 'worker2', host: 'worker2:4000', weight: 1 },
  { id: 'worker3', host: 'worker3:4000', weight: 1 }
];

const settings = { port: 8080, agentPort: 9000, cookieName: 'lb_node', cookieTtlSec: 3600, workers: 2, maxFails: 2, failTimeoutSec: 5 };
const render = (name, list = nodes) => renderNginxConfig({ ...settings, strategy: strategies[name], nodes: list });

describe('nginx config', () => {
  test('listens on the gateway port and exposes the agent health check', () => {
    const text = render('round-robin');
    expect(text).toContain('listen 8080;');
    expect(text).toContain('proxy_pass http://127.0.0.1:9000/health;');
  });

  test('forwards websocket upgrades', () => {
    const text = render('round-robin');
    expect(text).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(text).toContain('proxy_http_version 1.1;');
  });

  test('round-robin adds no balancing directive', () => {
    const text = render('round-robin');
    expect(text).not.toContain('least_conn');
    expect(text).not.toContain('hash $hash_key');
    expect(text).not.toContain('random two');
  });

  test('each strategy writes its own directive into the balanced upstream', () => {
    expect(render('least-connections')).toContain('        least_conn;');
    expect(render('consistent-hash')).toContain('        hash $hash_key consistent;');
    expect(render('power-of-two')).toContain('        random two least_conn;');
  });

  test('tags responses with the active strategy', () => {
    expect(render('weighted')).toContain('add_header X-LB-Strategy weighted always;');
  });

  test('writes the server weights', () => {
    const weighted = [
      { ...nodes[0], weight: 80 },
      { ...nodes[1], weight: 20 }
    ];
    const text = render('weighted', weighted);
    expect(text).toContain('server worker1:4000 weight=80 max_fails=2 fail_timeout=5s;');
    expect(text).toContain('server worker2:4000 weight=20 max_fails=2 fail_timeout=5s;');
  });

  test('pins a client to its node by cookie and keeps the others as backup', () => {
    const text = render('round-robin');
    expect(text).toContain('map $cookie_lb_node $pool {');
    expect(text).toContain('worker1 pin_worker1;');
    expect(text).toContain('upstream pin_worker1 {');
    expect(text).toContain('server worker2:4000 backup max_fails=2 fail_timeout=5s;');
  });

  test('sets the sticky cookie only when it is missing or wrong', () => {
    const text = render('round-robin');
    expect(text).toContain('default "lb_node=$upstream_http_x_node_id;');
    expect(text).toContain('"worker2|worker2" "";');
    expect(text).toContain('add_header Set-Cookie $set_sticky always;');
  });

  test('hashes on room, then user id, then client address', () => {
    const text = render('consistent-hash');
    expect(text).toContain('map $arg_room $hash_user');
    expect(text).toContain('$arg_userId;');
    expect(text).toContain('$remote_addr;');
  });

  test('only mentions the nodes it was given', () => {
    const text = render('round-robin', [nodes[0]]);
    expect(text).toContain('worker1:4000');
    expect(text).not.toContain('worker2');
  });

  test('is deterministic', () => {
    expect(render('weighted')).toBe(render('weighted'));
  });

  test('uses the configured cookie name and worker count', () => {
    const text = renderNginxConfig({ ...settings, cookieName: 'my_node', workers: 4, strategy: strategies['round-robin'], nodes });
    expect(text).toContain('worker_processes 4;');
    expect(text).toContain('map $cookie_my_node $pool {');
  });
});

describe('bootstrap config', () => {
  const text = renderBootstrapConfig({ port: 8080, agentPort: 9000 });

  test('always listens so the port never answers with an empty response', () => {
    expect(text).toContain('listen 8080;');
  });

  test('exposes the agent health check', () => {
    expect(text).toContain('proxy_pass http://127.0.0.1:9000/health;');
  });

  test('answers everything else with a readable 503', () => {
    expect(text).toContain('return 503');
    expect(text).not.toContain('upstream');
  });
});
