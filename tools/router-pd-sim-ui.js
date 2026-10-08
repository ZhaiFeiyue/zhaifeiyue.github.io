// Router PD Simulator — UI: router compare (Pareto) + live animated details.
(function () {
  const UI_VERSION = '0.1.0';
  const $ = id => document.getElementById(id);
  const Sim = window.RouterPDSimulator;
  (function ver() {
    const l = $('verLbl'); if (!l) return;
    const ok = Sim && Sim.VERSION === UI_VERSION && window.RPD_VERSION === UI_VERSION;
    l.textContent = 'v' + UI_VERSION + (ok ? '' : ' (mismatch)'); if (!ok) l.style.color = '#f85149';
  })();

  const ROUTERS = (Sim && Sim.ROUTERS) || ['round_robin', 'random', 'power_of_two', 'cache_aware', 'consistent_hashing'];
  const RLABEL = { round_robin: 'Round Robin', random: 'Random', power_of_two: 'Power-of-2', cache_aware: 'Cache-Aware', consistent_hashing: 'Consistent Hash' };
  const RCOLOR = { round_robin: '#58a6ff', random: '#8b949e', power_of_two: '#3fb950', cache_aware: '#bc8cff', consistent_hashing: '#d29922' };
  const DEFAULT_ON = new Set(['round_robin', 'power_of_two', 'cache_aware']);

  // ---- router checkboxes ----
  $('routerOpts').innerHTML = ROUTERS.map(r =>
    `<label class="rt-opt" style="border-color:${RCOLOR[r]}66"><input type="checkbox" data-rt="${r}" ${DEFAULT_ON.has(r) ? 'checked' : ''}><span style="color:${RCOLOR[r]}">${RLABEL[r]}</span></label>`).join('');
  const selRouters = () => [...document.querySelectorAll('#routerOpts input:checked')].map(i => i.dataset.rt);

  // ---- config ----
  function baseCfg() {
    return {
      isl: +$('c_isl').value, osl: +$('c_osl').value, rng: +$('c_range').value,
      nGroups: +$('c_grp').value, prefixRatio: +$('c_pfx').value / 100,
      pfN: +$('c_pfN').value, pfTP: +$('c_pfTP').value, pfDP: +$('c_pfDP').value,
      pfTPS: +$('c_pfTPS').value, chk: +$('c_chk').value, pfMR: +$('c_pfMR').value, txP: +$('c_txP').value / 100,
      dcN: +$('c_dcN').value, dcTP: +$('c_dcTP').value, dcDP: +$('c_dcDP').value,
      mrr: +$('c_mrr').value, tpot: +$('c_tpot').value, mt: +$('c_mt').value, pcR: 0,
    };
  }
  function cfgFor(router, conc) { return { ...baseCfg(), router, conc, tot: conc * 8 }; }
  function slo() {
    return {
      ttftP: $('c_ttftP').value, ttftThr: +$('c_ttftThr').value,
      tpotP: $('c_tpotP').value, tpotThr: +$('c_tpotThr').value,
    };
  }
  function concList() {
    const s = Math.max(1, +$('c_cStart').value), e = Math.max(s, +$('c_cEnd').value), st = Math.max(1, +$('c_cStep').value);
    const out = []; for (let c = s; c <= e; c += st) out.push(c); return out;
  }

  // ---- Pareto chart ----
  Chart.defaults.color = '#8b949e'; Chart.defaults.borderColor = '#21262d';
  let pareto = null;
  const RESULTS = {}; // router -> [points]

  function opPoint(pts, S) {
    let best = null;
    for (const p of pts) {
      if (p.ttft[S.ttftP] <= S.ttftThr && p.tpot[S.tpotP] <= S.tpotThr) {
        if (!best || p.tputPerGpu > best.tputPerGpu) best = p;
      }
    }
    return best;
  }

  function renderPareto() {
    const S = slo();
    const ds = [];
    for (const r of Object.keys(RESULTS)) {
      const pts = RESULTS[r].slice().sort((a, b) => a.interactivity - b.interactivity);
      ds.push({
        label: RLABEL[r], data: pts.map(p => ({ x: p.interactivity, y: p.tputPerGpu, conc: p.conc })),
        borderColor: RCOLOR[r], backgroundColor: RCOLOR[r], showLine: true, tension: .2,
        borderWidth: 2, pointRadius: 3, pointHoverRadius: 5,
      });
      const op = opPoint(pts, S);
      if (op) ds.push({ label: '_op_' + r, data: [{ x: op.interactivity, y: op.tputPerGpu }], borderColor: RCOLOR[r], backgroundColor: RCOLOR[r], pointStyle: 'rectRot', pointRadius: 9, pointHoverRadius: 11, showLine: false });
    }
    const data = { datasets: ds };
    const opts = {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { labels: { font: { size: 11 }, filter: i => !i.text.startsWith('_op_') } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.x.toFixed(1)} tok/s/user, ${c.parsed.y.toFixed(1)} tok/s/gpu${c.raw.conc ? ' (c' + c.raw.conc + ')' : ''}` } },
      },
      scales: {
        x: { title: { display: true, text: 'tok/s/user (interactivity →)', font: { size: 11 } }, ticks: { font: { size: 9 } }, grid: { color: '#21262d' } },
        y: { title: { display: true, text: 'tok/s/gpu (efficiency ↑)', font: { size: 11 } }, min: 0, ticks: { font: { size: 9 } }, grid: { color: '#21262d' } },
      },
    };
    if (pareto) { pareto.data = data; pareto.options = opts; pareto.update('none'); }
    else pareto = new Chart($('paretoChart').getContext('2d'), { type: 'scatter', data, options: opts });
  }

  function renderTable() {
    const S = slo(), tb = $('cmpTable').querySelector('tbody');
    tb.innerHTML = Object.keys(RESULTS).map(r => {
      const pts = RESULTS[r]; const op = opPoint(pts, S);
      const hit = pts.length ? (pts.reduce((s, p) => s + p.cacheHitRate, 0) / pts.length * 100).toFixed(0) : '0';
      if (!op) return `<tr><td class="rt" style="color:${RCOLOR[r]}">${RLABEL[r]}</td><td colspan="3" style="color:#6e7681">无满足 SLO 点</td><td>${hit}%</td></tr>`;
      return `<tr><td class="rt" style="color:${RCOLOR[r]}">${RLABEL[r]}</td><td>${op.interactivity.toFixed(1)}</td><td>${op.tputPerGpu.toFixed(1)}</td><td>${hit}%</td><td>c${op.conc}</td></tr>`;
    }).join('');
  }

  // ---- Launch (headless sweep with progress) ----
  let launching = false;
  async function launch() {
    if (launching) return;
    const routers = selRouters();
    if (!routers.length) { $('launchHint').textContent = '请至少勾选一个 router'; return; }
    launching = true; $('btnLaunch').disabled = true; $('launchHint').textContent = '';
    for (const k of Object.keys(RESULTS)) delete RESULTS[k];
    const concs = concList();
    const total = routers.length * concs.length; let done = 0;
    $('prog').classList.add('on'); $('progLbl').textContent = '';
    for (const r of routers) {
      RESULTS[r] = [];
      for (const c of concs) {
        const sim = new Sim(cfgFor(r, c));
        const m = sim.runToEnd();
        if (m) RESULTS[r].push(m);
        done++;
        $('progBar').style.width = (done / total * 100) + '%';
        $('progLbl').textContent = `跑 sim ${done}/${total} — ${RLABEL[r]} @ conc ${c}`;
        renderPareto(); renderTable();
        await new Promise(res => setTimeout(res, 0)); // yield so UI paints
      }
    }
    $('progLbl').textContent = `完成 ${total} 次 sim（${routers.length} router × ${concs.length} 并发点）`;
    setTimeout(() => $('prog').classList.remove('on'), 800);
    launching = false; $('btnLaunch').disabled = false;
    // populate details router dropdown
    $('d_router').innerHTML = routers.map(r => `<option value="${r}">${RLABEL[r]}</option>`).join('');
  }
  $('btnLaunch').addEventListener('click', launch);
  $('c_ttftThr').addEventListener('change', () => { renderPareto(); renderTable(); });
  $('c_tpotThr').addEventListener('change', () => { renderPareto(); renderTable(); });
  $('c_ttftP').addEventListener('change', () => { renderPareto(); renderTable(); });
  $('c_tpotP').addEventListener('change', () => { renderPareto(); renderTable(); });

  // ===================== Details animation =====================
  const vc = $('vc'), vx = vc.getContext('2d'), dp = window.devicePixelRatio || 1;
  let dsim = null, dplaying = false, dlast = 0;

  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function arr(c, x1, y1, x2, y2, on, t) {
    c.save(); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2);
    c.strokeStyle = on ? '#58a6ff55' : '#ffffff15'; c.lineWidth = on ? 2 : 1;
    if (on) { c.setLineDash([7, 5]); c.lineDashOffset = -(t * .03) % 12; }
    c.stroke(); const a = Math.atan2(y2 - y1, x2 - x1), L = 6;
    c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - L * Math.cos(a - .4), y2 - L * Math.sin(a - .4)); c.lineTo(x2 - L * Math.cos(a + .4), y2 - L * Math.sin(a + .4)); c.closePath();
    c.fillStyle = on ? '#58a6ff88' : '#ffffff33'; c.fill(); c.setLineDash([]); c.restore();
  }
  function box(c, x, y, w, h, fill, stroke) { rr(c, x, y, w, h, 6); c.fillStyle = fill; c.fill(); c.strokeStyle = stroke; c.lineWidth = 1; c.stroke(); }

  function drsz() {
    const r = vc.parentElement.getBoundingClientRect();
    const rows = Math.max(dsim.state.pfR.length, Math.ceil(dsim.state.dg.length / (dsim.state.dg.length > 4 ? 2 : 1)));
    const h = Math.max(230, 50 + rows * 46);
    vc.style.height = h + 'px'; vc.width = r.width * dp; vc.height = h * dp; vx.setTransform(dp, 0, 0, dp, 0, 0);
  }
  function ddraw() {
    if (!dsim) return; drsz();
    const S = dsim.state, C = dsim.config, c = vx, w = vc.width / dp, h = vc.height / dp;
    c.clearRect(0, 0, w, h); c.fillStyle = '#0d1117'; c.fillRect(0, 0, w, h);
    const ty = 24, ch = h - ty - 14, gx = 8, pd = 8;
    const cliW = 64, rtw = 40, qw = 40, ow = 56;
    const fx = w - 2 * pd - cliW - rtw - qw * 2 - ow - gx * 6; const pw = fx * .32, dw = fx * .68;
    let x = pd; const clX = x; x += cliW + gx; const pqX = x; x += qw + gx; const rtX = x; x += rtw + gx;
    const pgX = x; x += pw + gx; const tqX = x; x += qw + gx; const dgX = x; x += dw + gx; const oX = x;
    let pq = S.pq.length; for (const nq of S.pfQ) for (const q of nq) pq += q.length;
    let tx = 0; for (const no of S.pfOut) for (const ro of no) tx += ro.length;
    // client
    box(c, clX, ty, cliW, ch, '#161b22', S.done ? '#3fb95066' : '#bc8cff44');
    c.fillStyle = '#8b949e'; c.font = '9px system-ui'; c.textAlign = 'center'; c.fillText('Client', clX + cliW / 2, ty - 6);
    c.fillStyle = '#bc8cff'; c.font = 'bold 11px system-ui'; c.fillText(S.done ? 'DONE' : 'In-Flight', clX + cliW / 2, ty + 18);
    c.fillStyle = '#e6edf3'; c.font = 'bold 16px system-ui'; c.fillText(S.inf, clX + cliW / 2, ty + 40);
    c.fillStyle = '#8b949e'; c.font = '9px system-ui'; c.fillText('done:' + dsim.stats.cc + '/' + C.tot, clX + cliW / 2, ty + 58);
    // queue
    box(c, pqX, ty, qw, ch, '#161b22', '#30363d'); c.fillStyle = '#e6edf3'; c.font = 'bold 13px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(pq, pqX + qw / 2, ty + ch / 2); c.textBaseline = 'alphabetic';
    c.fillStyle = '#8b949e'; c.font = '9px system-ui'; c.fillText('PF Q', pqX + qw / 2, ty - 6);
    // router (show algorithm)
    c.save(); c.translate(rtX + rtw / 2, ty + ch / 2); c.rotate(Math.PI / 4); box(c, -15, -15, 30, 30, '#161b22', '#58a6ff66'); c.rotate(-Math.PI / 4);
    c.fillStyle = '#58a6ff'; c.font = 'bold 8px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle';
    const abbr = { round_robin: 'RR', random: 'RND', power_of_two: 'P2', cache_aware: 'CACHE', consistent_hashing: 'HASH' }[S.router] || 'RR';
    c.fillText(abbr, 0, 0); c.restore(); c.textBaseline = 'alphabetic';
    c.fillStyle = '#8b949e'; c.font = '9px system-ui'; c.textAlign = 'center'; c.fillText('Router', rtX + rtw / 2, ty - 6);
    // PF nodes
    c.fillStyle = '#8b949e'; c.font = '9px system-ui'; c.fillText('Prefill × ' + C.pfN, pgX + pw / 2, ty - 6);
    const nH = Math.min(42, (ch - 4) / C.pfN - 4);
    for (let ni = 0; ni < C.pfN; ni++) {
      const gy = ty + ni * (nH + 4), anyComp = S.pfR[ni].some(r => r.s === 'COMPUTING');
      box(c, pgX, gy, pw, nH, anyComp ? '#0d1926' : '#0d1117', anyComp ? '#58a6ff44' : '#30363d');
      c.fillStyle = '#8b949e'; c.font = '9px system-ui'; c.textAlign = 'left'; c.fillText('P' + (ni + 1), pgX + 4, gy + 12);
      let nq = 0; for (const q of S.pfQ[ni]) nq += q.length; let run = 0; for (const rk of S.pfR[ni]) run += rk.run.length;
      c.textAlign = 'right'; c.fillStyle = '#58a6ff'; c.fillText('run:' + run + ' q:' + nq, pgX + pw - 4, gy + 12);
      const cached = S.nodeSeen[ni] ? S.nodeSeen[ni].size : 0;
      c.fillStyle = '#bc8cff'; c.font = '8px system-ui'; c.fillText('cache grp:' + cached, pgX + pw - 4, gy + nH - 4);
      if (anyComp && S.pfB[ni].bt > 0) { const p = Math.min(1, (S.t - S.pfB[ni].cs) / S.pfB[ni].bt); c.fillStyle = '#58a6ff'; c.fillRect(pgX + 4, gy + nH - 10, (pw - 8) * p, 4); }
    }
    // xfer
    box(c, tqX, ty, qw, ch, '#161b22', '#30363d'); c.fillStyle = '#e6edf3'; c.font = 'bold 13px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(tx, tqX + qw / 2, ty + ch / 2); c.textBaseline = 'alphabetic';
    c.fillStyle = '#d29922'; c.font = '9px system-ui'; c.fillText('KV Tx', tqX + qw / 2, ty - 6);
    // DC nodes
    const cols = C.dcN > 4 ? 2 : 1, rows = Math.ceil(C.dcN / cols); const cW = (dw - (cols - 1) * 5) / cols, dH = Math.min(46, (ch - 4) / rows - 4);
    c.fillStyle = '#8b949e'; c.font = '9px system-ui'; c.textAlign = 'center'; c.fillText('Decode × ' + C.dcN, dgX + dw / 2, ty - 6);
    for (let i = 0; i < C.dcN; i++) {
      const g = S.dg[i], col = i % cols, row = (i / cols) | 0, gx2 = dgX + col * (cW + 5), gy = ty + row * (dH + 4);
      let tr = 0, mrc = 0; for (const rk of g.rk) { tr += rk.length; if (rk.length > mrc) mrc = rk.length; }
      box(c, gx2, gy, cW, dH, tr > 0 ? '#0b1a0b' : '#0d1117', tr > 0 ? '#3fb95044' : '#30363d');
      c.fillStyle = '#8b949e'; c.font = '8px system-ui'; c.textAlign = 'left'; c.fillText('D' + (i + 1), gx2 + 3, gy + 10);
      c.textAlign = 'right'; c.fillStyle = tr > 0 ? '#3fb950' : '#484f58'; c.fillText(tr + '/' + (C.dcDP * C.mrr), gx2 + cW - 3, gy + 10);
      const bw = cW - 8, by = gy + 16, bh = dH - 22; c.fillStyle = '#1c2333'; c.fillRect(gx2 + 4, by, bw, bh);
      const f = Math.min(1, tr / (C.dcDP * C.mrr)); c.fillStyle = '#3fb95066'; c.fillRect(gx2 + 4, by, bw * f, bh);
    }
    // output
    box(c, oX, ty, ow, ch, '#161b22', '#30363d'); c.fillStyle = '#3fb950'; c.font = 'bold 16px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(dsim.stats.cc, oX + ow / 2, ty + ch / 2); c.textBaseline = 'alphabetic';
    c.fillStyle = '#8b949e'; c.font = '9px system-ui'; c.fillText('Output', oX + ow / 2, ty - 6);
    // arrows
    const my = ty + ch / 2;
    arr(c, clX + cliW, my, pqX, my, S.inf > 0, S.t); arr(c, pqX + qw, my, rtX, my, pq > 0, S.t); arr(c, rtX + rtw, my, pgX, my, pq > 0, S.t);
    arr(c, pgX + pw, my, tqX, my, tx > 0, S.t); arr(c, tqX + qw, my, dgX, my, tx > 0, S.t); arr(c, dgX + dw, my, oX, my, dsim.stats.cc > 0, S.t);
    c.fillStyle = '#484f58'; c.font = '10px system-ui'; c.textAlign = 'center';
    c.fillText('Sim ' + (S.t / 1000).toFixed(1) + 's · ' + (RLABEL[S.router] || S.router) + (S.done ? ' · DONE' : ''), w / 2, h - 3);
  }
  function dStatsRender() {
    if (!dsim) return; const m = dsim.metrics() || {};
    const cells = [
      ['tok/s/user', m.interactivity ? m.interactivity.toFixed(1) : '-'],
      ['tok/s/gpu', m.tputPerGpu ? m.tputPerGpu.toFixed(1) : '-'],
      ['TTFT p50', m.ttft ? (m.ttft.p50).toFixed(0) + 'ms' : '-'],
      ['TPOT avg', m.tpotMs ? m.tpotMs.toFixed(1) + 'ms' : '-'],
      ['E2E p50', m.e2eP50 ? m.e2eP50.toFixed(2) + 's' : '-'],
      ['缓存命中', m.cacheHitRate != null ? (m.cacheHitRate * 100).toFixed(0) + '%' : '-'],
      ['PF Bubble', m.pfBubble != null ? (m.pfBubble * 100).toFixed(0) + '%' : '-'],
      ['DC 利用', m.dcUtil != null ? (m.dcUtil * 100).toFixed(0) + '%' : '-'],
      ['完成', (m.completed || 0) + ''],
    ];
    $('dstats').innerHTML = cells.map(([l, v]) => `<div class="dstat"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');
  }
  function dnew() {
    const r = $('d_router').value || selRouters()[0] || 'round_robin';
    dsim = new Sim(cfgFor(r, Math.max(1, +$('d_conc').value)));
    ddraw(); dStatsRender();
  }
  function dloop(ts) {
    if (!dlast) dlast = ts; const rdt = Math.min(ts - dlast, 100); dlast = ts;
    if (dplaying && dsim && !dsim.state.done) {
      const spd = +$('d_spd').value, sdt = rdt * spd, n = Math.min(Math.ceil(sdt), 4000), step = sdt / n;
      for (let i = 0; i < n; i++) dsim.tick(step);
    }
    ddraw();
    if (dplaying) dStatsRender();
    if (dplaying && dsim && dsim.state.done) { dplaying = false; $('d_play').textContent = '▶ Play'; dStatsRender(); }
    requestAnimationFrame(dloop);
  }
  $('d_play').addEventListener('click', () => { if (!dsim || dsim.state.done) dnew(); dplaying = !dplaying; $('d_play').textContent = dplaying ? '⏸ Pause' : '▶ Play'; });
  $('d_reset').addEventListener('click', () => { dplaying = false; $('d_play').textContent = '▶ Play'; dnew(); });
  $('d_router').addEventListener('change', () => { dplaying = false; $('d_play').textContent = '▶ Play'; dnew(); });
  $('d_conc').addEventListener('change', () => { dplaying = false; $('d_play').textContent = '▶ Play'; dnew(); });
  $('detailsBox').addEventListener('toggle', function () { if (this.open && !dsim) dnew(); });

  // init router dropdown + details sim lazily
  $('d_router').innerHTML = ROUTERS.filter(r => DEFAULT_ON.has(r)).map(r => `<option value="${r}">${RLABEL[r]}</option>`).join('');
  requestAnimationFrame(dloop);
})();
