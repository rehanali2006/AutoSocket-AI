(() => {
  const LABELS = {
    'round-robin': 'Round Robin',
    'least-connections': 'Least Connections',
    weighted: 'Weighted Health',
    'consistent-hash': 'Consistent Hash',
    'power-of-two': 'Power of Two'
  };
  const SHORT = {
    'round-robin': 'Round Robin',
    'least-connections': 'Least Conn.',
    weighted: 'Weighted',
    'consistent-hash': 'Hash',
    'power-of-two': 'Power of 2'
  };
  const SHADES = ['#1d4ed8', '#3b82f6', '#93c5fd', '#dbeafe'];

  const $ = id => document.getElementById(id);
  const num = (value, digits = 0) =>
    Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const clock = ts => new Date(ts).toLocaleTimeString([], { hour12: false });
  const span = seconds => {
    const s = Math.floor(seconds);
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(v => String(v).padStart(2, '0')).join(':');
  };
  const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const field = (root, name) => root.querySelector(`[data-f="${name}"]`);
  const bar = (root, name, pct) => {
    field(root, name).style.width = `${Math.max(0, Math.min(100, pct))}%`;
  };

  let limit = 300;
  let points = [];
  let decisions = [];
  let built = false;

  const switchMarkers = {
    id: 'switchMarkers',
    afterDatasetsDraw(chart) {
      const marks = chart.$switches || [];
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !marks.length) return;
      ctx.save();
      ctx.strokeStyle = '#2f6bff';
      ctx.fillStyle = '#6f98ff';
      ctx.setLineDash([4, 4]);
      ctx.font = '10px ui-monospace, monospace';
      for (const mark of marks) {
        const x = scales.x.getPixelForValue(mark.index);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.fillText(mark.label, Math.min(x + 4, chartArea.right - 72), chartArea.top + 10);
      }
      ctx.restore();
    }
  };

  Chart.defaults.color = '#7b8294';
  Chart.defaults.borderColor = '#12151d';
  Chart.defaults.font.family = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  Chart.defaults.font.size = 11;

  function lineChart(id, color) {
    return new Chart($(id), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{ data: [], borderColor: color, backgroundColor: `${color}22`, fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 }]
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } }, y: { beginAtZero: true } }
      },
      plugins: [switchMarkers]
    });
  }

  const charts = {
    rate: lineChart('chart-rate', '#2f6bff'),
    latency: lineChart('chart-latency', '#9db8ff'),
    load: new Chart($('chart-load'), {
      type: 'bar',
      data: { labels: [], datasets: [] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } },
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true } }
      }
    })
  };

  function refreshLines() {
    const labels = points.map(p => clock(p.ts));
    const marks = [];
    points.forEach((p, i) => {
      if (i > 0 && p.strategy !== points[i - 1].strategy) marks.push({ index: i, label: SHORT[p.strategy] || p.strategy });
    });
    [[charts.rate, 'reqPerSec'], [charts.latency, 'p95']].forEach(([chart, key]) => {
      chart.data.labels = labels;
      chart.data.datasets[0].data = points.map(p => p[key]);
      chart.$switches = marks;
      chart.update('none');
    });
  }

  function refreshBars(state) {
    const ids = Object.keys(state.nodes).sort();
    charts.load.data.labels = state.strategies.map(s => SHORT[s.name]);
    charts.load.data.datasets = ids.map((id, i) => ({
      label: id,
      data: state.strategies.map(s => s.nodeRequests[id] || 0),
      backgroundColor: SHADES[i % SHADES.length],
      borderRadius: 3
    }));
    charts.load.update('none');
  }

  function buildCards(state) {
    const ids = Object.keys(state.nodes).sort();

    $('strategies').innerHTML = state.strategies.map(s => `
      <article class="card strategy" data-strategy="${s.name}">
        <header><h3>${LABELS[s.name]}</h3><span class="badge">ACTIVE</span></header>
        <div class="share"><b data-f="share">0</b><small>% of load</small></div>
        <dl>
          <div><dt>Avg req/s</dt><dd data-f="rps">0</dd></div>
          <div><dt>p95 (ms)</dt><dd data-f="p95">0</dd></div>
          <div><dt>Requests</dt><dd data-f="total">0</dd></div>
          <div><dt>Time active</dt><dd data-f="time">00:00:00</dd></div>
        </dl>
        <div class="minis">
          ${ids.map(id => `
            <div class="mini" data-node="${id}">
              <span>${id}</span><div class="bar"><i data-f="bar"></i></div><b data-f="pct">0%</b>
            </div>`).join('')}
        </div>
      </article>`).join('');

    const rows = [
      ['conn', 'Connections'],
      ['rps', 'Req / sec'],
      ['cpu', 'CPU'],
      ['lag', 'Loop lag'],
      ['health', 'Health']
    ];

    $('servers').innerHTML = ids.map(id => `
      <article class="card server" data-server="${id}">
        <header><h3>${id}</h3><span class="state"><i class="dot off" data-f="dot"></i><small data-f="state">offline</small></span></header>
        <div class="sub" data-f="sub">--</div>
        <div class="rows">
          ${rows.map(([key, name]) => `
            <div class="row"><span>${name}</span><div class="bar"><i data-f="${key}-bar"></i></div><b data-f="${key}">0</b></div>`).join('')}
        </div>
      </article>`).join('');

    built = true;
  }

  function renderStatuses(state) {
    const items = [
      ['NATS', state.status.nats],
      ['Mongo', state.status.mongo],
      ['Gateway', state.status.gateway],
      ...Object.entries(state.status.nodes).sort().map(([id, up]) => [id, up])
    ];
    $('statuses').innerHTML = items.map(([name, up]) => `<span><i class="dot ${up ? 'on' : 'off'}"></i>${name}</span>`).join('');
  }

  function renderStrategies(state) {
    for (const s of state.strategies) {
      const card = document.querySelector(`[data-strategy="${s.name}"]`);
      if (!card) continue;
      card.classList.toggle('active', s.active);
      field(card, 'share').textContent = num(s.sharePct, 1);
      field(card, 'rps').textContent = num(s.avgReqPerSec, 1);
      field(card, 'p95').textContent = num(s.avgP95, 1);
      field(card, 'total').textContent = num(s.totalRequests);
      field(card, 'time').textContent = span(s.activeSeconds);
      for (const mini of card.querySelectorAll('.mini')) {
        const pct = s.nodeShare[mini.dataset.node] || 0;
        bar(mini, 'bar', pct);
        field(mini, 'pct').textContent = `${Math.round(pct)}%`;
      }
    }
  }

  function renderServers(state) {
    const nodes = Object.values(state.nodes);
    const maxConn = Math.max(10, ...nodes.map(n => n.connections));
    const maxRps = Math.max(5, ...nodes.map(n => n.reqPerSec));

    for (const [id, n] of Object.entries(state.nodes)) {
      const card = document.querySelector(`[data-server="${id}"]`);
      if (!card) continue;
      field(card, 'dot').className = `dot ${n.online ? 'on' : 'off'}`;
      field(card, 'state').textContent = n.online ? 'online' : 'offline';
      field(card, 'sub').textContent = `${num(n.messagesPerSec)} msg/s  p95 ${num(n.p95LatencyMs, 1)}ms  err ${n.errors}`;
      field(card, 'conn').textContent = num(n.connections);
      field(card, 'rps').textContent = num(n.reqPerSec);
      field(card, 'cpu').textContent = `${num(n.cpuPercent, 0)}%`;
      field(card, 'lag').textContent = `${num(n.eventLoopLagMs, 1)}ms`;
      field(card, 'health').textContent = `${n.health}%`;
      bar(card, 'conn-bar', (n.connections / maxConn) * 100);
      bar(card, 'rps-bar', (n.reqPerSec / maxRps) * 100);
      bar(card, 'cpu-bar', n.cpuPercent);
      bar(card, 'lag-bar', (n.eventLoopLagMs / state.limits.lagMaxMs) * 100);
      bar(card, 'health-bar', n.health);
    }
  }

  function renderDecisions() {
    $('decisions').innerHTML = decisions.map(d => `
      <tr title="${escape(JSON.stringify(d.features || {}))}">
        <td class="mono">${clock(d.ts)}</td>
        <td>${escape(d.workloadClass)}</td>
        <td class="strategy-cell">${escape(LABELS[d.strategy] || d.strategy)}</td>
        <td>${escape(d.reason)}</td>
        <td class="mono">${d.previousReward === null || d.previousReward === undefined ? '--' : Number(d.previousReward).toFixed(3)}</td>
      </tr>`).join('');
  }

  function renderLoad(load) {
    document.querySelectorAll('button[data-profile]').forEach(button => {
      button.classList.toggle('running', Boolean(load.running) && load.profile === button.dataset.profile);
    });
    $('clients').textContent = num(load.clients || 0);
    if (load.offline) $('load-status').textContent = 'loadgen offline';
    else if (load.running) $('load-status').textContent = `${load.profile} / ${load.clients} clients / ${num(load.acks)} acks / ${num(load.errors)} errors`;
    else $('load-status').textContent = 'idle';
  }

  function render(state) {
    if (!built) buildCards(state);

    $('active-strategy').textContent = LABELS[state.strategy] || state.strategy;
    $('workload').textContent = state.workloadClass;
    $('mode').textContent = state.mode;
    $('uptime').textContent = span(state.uptimeSec);

    renderStatuses(state);
    renderStrategies(state);
    renderServers(state);
    renderLoad(state.loadgen || {});
    refreshBars(state);
  }

  async function callApi(path) {
    try {
      await fetch(path, { method: 'POST' });
    } catch (err) {
      $('load-status').textContent = 'request failed';
    }
  }

  document.querySelectorAll('button[data-profile]').forEach(button => {
    button.addEventListener('click', () => callApi(`/api/load/${button.dataset.profile}`));
  });
  $('stop').addEventListener('click', () => callApi('/api/load/stop'));

  const socket = io();

  socket.on('history', history => {
    limit = history.limit;
    points = history.points;
    decisions = history.decisions;
    refreshLines();
    renderDecisions();
  });

  socket.on('state', state => {
    render(state);
    if (state.point) {
      points.push(state.point);
      if (points.length > limit) points.shift();
      refreshLines();
    }
  });

  socket.on('decision', decision => {
    decisions = [decision, ...decisions].slice(0, 50);
    renderDecisions();
  });
})();
