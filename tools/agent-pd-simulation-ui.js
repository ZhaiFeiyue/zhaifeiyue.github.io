// Agent PD Simulator - UI layer: particle animation, canvas, charts, stats.
(function(){
const UI_VERSION = '0.1.0';
const $ = id => document.getElementById(id);

// ===================== Config =====================
function readConfig(){
  return {
    totSessions: +$('c_conc').value * 10,
    conc: +$('c_conc').value,
    nTurns: +$('c_nTurns').value,
    zPause: +$('c_zPause').value,
    isl: +$('c_isl').value,
    osl: +$('c_osl').value,
    rng: +$('c_range').value,
    pfN: +$('c_pfN').value,
    pfTP: +$('c_pfTP').value,
    pfDP: +$('c_pfDP').value,
    pfTPS: +$('c_pfTPS').value,
    chk: +$('c_chk').value,
    pfMR: +$('c_pfMR').value,
    txP: +$('c_txP').value / 100,
    dcN: +$('c_dcN').value,
    dcTP: +$('c_dcTP').value,
    dcDP: +$('c_dcDP').value,
    mrr: +$('c_mrr').value,
    tpot: +$('c_tpot').value,
    mt: +$('c_mt').value,
    bwUmbp: +$('c_bwUmbp').value,
    bwPcie: +$('c_bwPcie').value,
    tFixedUmbp: +$('c_tFixed').value,
    prefetchThreshold: +$('c_pfThresh').value,
    umbpHitRate: +$('c_umbpHit').value / 100,
    offloadRatio: +$('c_offload').value / 100,
    bwOffload: +$('c_bwOff').value,
    kvBytesPerToken: +$('c_kvB').value,
    flopsPerToken: +$('c_flops').value,
    gpuThroughput: +$('c_gpuTF').value,
    spd: +$('c_spd').value,
  };
}

const cfgIds = ['c_conc','c_nTurns','c_zPause','c_isl','c_osl','c_range',
  'c_pfN','c_pfTP','c_pfDP','c_pfTPS','c_chk','c_pfMR','c_txP',
  'c_dcN','c_dcTP','c_dcDP','c_mrr','c_tpot','c_mt',
  'c_bwUmbp','c_bwPcie','c_tFixed','c_pfThresh','c_umbpHit','c_offload','c_bwOff',
  'c_kvB','c_flops','c_gpuTF','c_spd'];

function saveCfg(){
  const o = {};
  for (const id of cfgIds) o[id] = $(id).value;
  localStorage.setItem('agent_pd_cfg', JSON.stringify(o));
}
function loadCfg(){
  try {
    const o = JSON.parse(localStorage.getItem('agent_pd_cfg'));
    if (!o) return;
    for (const id of cfgIds) if (o[id] != null) $(id).value = o[id];
  } catch(e){}
}

// ===================== Simulator =====================
let sim = null;
function newSim(){ sim = new AgentPDSimulator(readConfig()); }

// ===================== Particles =====================
let particles = [];

function spawnParticle(type, x1, y1, x2, y2, duration, data){
  const colors = {
    request: '#bc8cff', prefetch: '#39d2c0', offload: '#d29922',
    reload: '#3fb950', kv_transfer: '#58a6ff',
  };
  particles.push({
    type, x1, y1, x2, y2,
    t0: performance.now(), duration: Math.max(16, duration),
    color: colors[type] || '#e6edf3',
    size: type === 'request' ? 4 : 3,
    data: data || {},
    trail: [],
  });
}

function updateParticles(now){
  for (let i = particles.length - 1; i >= 0; i--){
    const p = particles[i];
    const prog = Math.min(1, (now - p.t0) / p.duration);
    if (prog >= 1) { particles.splice(i, 1); continue; }
    const ease = prog < 0.5 ? 2*prog*prog : 1-Math.pow(-2*prog+2,2)/2;
    p.cx = p.x1 + (p.x2 - p.x1) * ease;
    p.cy = p.y1 + (p.y2 - p.y1) * ease;
    p.trail.push({x: p.cx, y: p.cy, t: now});
    if (p.trail.length > 8) p.trail.shift();
  }
}

function drawParticles(c){
  for (const p of particles){
    if (p.cx == null) continue;
    for (let ti = 0; ti < p.trail.length; ti++){
      const t = p.trail[ti];
      const alpha = (ti + 1) / p.trail.length * 0.3;
      c.beginPath();
      c.arc(t.x, t.y, p.size * 0.6, 0, Math.PI * 2);
      c.fillStyle = p.color + Math.round(alpha * 255).toString(16).padStart(2,'0');
      c.fill();
    }
    c.save();
    c.shadowColor = p.color;
    c.shadowBlur = 8;
    c.beginPath();
    c.arc(p.cx, p.cy, p.size, 0, Math.PI * 2);
    c.fillStyle = p.color;
    c.fill();
    c.restore();
  }
}

// ===================== Layout positions (computed on resize) =====================
let L = {};
function computeLayout(w, h){
  const pd = 10, ty = 22, bh = h - ty - pd;
  const topH = bh * 0.55, botH = bh * 0.45;
  const gx = 8;
  const cliW = 60, qw = 40, rtw = 34, ow = 55;
  const fx = w - 2*pd - cliW - qw*2 - rtw - ow - gx*6;
  const pw = fx * 0.3, dw = fx * 0.7;
  let cx = pd;
  L.cli = {x: cx, y: ty, w: cliW, h: topH}; cx += cliW + gx;
  L.pq = {x: cx, y: ty, w: qw, h: topH}; cx += qw + gx;
  L.rt = {x: cx, y: ty, w: rtw, h: topH}; cx += rtw + gx;
  L.pf = {x: cx, y: ty, w: pw, h: topH}; cx += pw + gx;
  L.tq = {x: cx, y: ty, w: qw, h: topH}; cx += qw + gx;
  L.dc = {x: cx, y: ty, w: dw, h: topH}; cx += dw + gx;
  L.out = {x: cx, y: ty, w: ow, h: topH};

  const tierY = ty + topH + 15;
  const tierW = (w - 2*pd) / 3;
  L.hbm = {x: pd, y: tierY, w: tierW - 4, h: botH - 20, label: 'HBM (GPU)'};
  L.dram = {x: pd + tierW, y: tierY, w: tierW - 4, h: botH - 20, label: 'Host DRAM'};
  L.remote = {x: pd + tierW*2, y: tierY, w: tierW - 4, h: botH - 20, label: 'Remote DRAM'};
  L.my = ty + topH / 2;
}

// ===================== Canvas Drawing =====================
const vc = $('vc'), vx = vc.getContext('2d');
const dp = window.devicePixelRatio || 1;

function rsz(){
  const r = vc.parentElement.getBoundingClientRect();
  const h = 320;
  vc.style.height = h + 'px';
  vc.width = r.width * dp;
  vc.height = h * dp;
  vx.setTransform(dp, 0, 0, dp, 0, 0);
  computeLayout(r.width, h);
}

function rr(c, x, y, w, h, r){
  c.beginPath();
  c.moveTo(x+r, y); c.lineTo(x+w-r, y);
  c.quadraticCurveTo(x+w, y, x+w, y+r); c.lineTo(x+w, y+h-r);
  c.quadraticCurveTo(x+w, y+h, x+w-r, y+h); c.lineTo(x+r, y+h);
  c.quadraticCurveTo(x, y+h, x, y+h-r); c.lineTo(x, y+r);
  c.quadraticCurveTo(x, y, x+r, y); c.closePath();
}

function dArr(c, x1, y1, x2, y2, on){
  c.save();
  c.beginPath(); c.moveTo(x1,y1); c.lineTo(x2,y2);
  if (on){
    c.strokeStyle = '#58a6ff55'; c.lineWidth = 2;
    c.setLineDash([7,5]);
    c.lineDashOffset = -(sim.state.t * .03) % 12;
  } else {
    c.strokeStyle = '#ffffff15'; c.lineWidth = 1; c.setLineDash([]);
  }
  c.stroke();
  const a = Math.atan2(y2-y1, x2-x1), al = 6;
  c.beginPath();
  c.moveTo(x2, y2);
  c.lineTo(x2 - al*Math.cos(a-.4), y2 - al*Math.sin(a-.4));
  c.lineTo(x2 - al*Math.cos(a+.4), y2 - al*Math.sin(a+.4));
  c.closePath();
  c.fillStyle = on ? '#58a6ff88' : '#ffffff33'; c.fill();
  c.setLineDash([]); c.restore();
}

function dBox(c, b, n, col, lb, extra){
  rr(c, b.x, b.y, b.w, b.h, 6);
  c.fillStyle = '#161b22'; c.fill();
  c.strokeStyle = '#30363d'; c.lineWidth = 1; c.stroke();
  if (n > 0){
    const f = Math.min(1, n / 100);
    const fh = (b.h - 4) * f;
    rr(c, b.x+2, b.y+b.h-fh-2, b.w-4, fh, 4);
    c.fillStyle = col + '33'; c.fill();
  }
  c.fillStyle = '#e6edf3'; c.font = 'bold 14px system-ui';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(n, b.x+b.w/2, b.y+b.h/2 - (extra ? 8 : 0));
  if (extra){
    c.font = '9px system-ui'; c.fillStyle = '#8b949e';
    c.fillText(extra, b.x+b.w/2, b.y+b.h/2 + 10);
  }
  c.font = '9px system-ui'; c.fillStyle = '#8b949e'; c.textBaseline = 'alphabetic';
  c.fillText(lb, b.x+b.w/2, b.y-6);
}

function dTier(c, b, tokens, col){
  rr(c, b.x, b.y, b.w, b.h, 6);
  c.fillStyle = '#0d1117'; c.fill();
  c.strokeStyle = col + '44'; c.lineWidth = 1; c.stroke();
  c.font = '10px system-ui'; c.fillStyle = '#8b949e';
  c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  c.fillText(b.label, b.x+b.w/2, b.y-4);
  const maxTok = 100000;
  const f = Math.min(1, tokens / maxTok);
  if (f > 0){
    rr(c, b.x+3, b.y+b.h-f*(b.h-6)-3, b.w-6, f*(b.h-6), 3);
    c.fillStyle = col + '44'; c.fill();
  }
  c.fillStyle = col; c.font = 'bold 12px system-ui';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(tokens > 1000 ? (tokens/1000).toFixed(1)+'K' : tokens, b.x+b.w/2, b.y+b.h/2);
}

function dPrefill(c, b){
  const S = sim.state, C = sim.config;
  c.font = '9px system-ui'; c.fillStyle = '#8b949e'; c.textAlign = 'center';
  c.fillText('Prefill(x'+C.pfN+')', b.x+b.w/2, b.y-6);
  const gH = Math.min(40, (b.h-5)/Math.max(1,C.pfN)-4);
  for (let ni = 0; ni < C.pfN; ni++){
    const gy = b.y + ni*(gH+4);
    const anyComp = S.pfR[ni].some(r => r.s === 'COMPUTING');
    rr(c, b.x, gy, b.w, gH, 5);
    c.fillStyle = anyComp ? '#0d1926' : '#0d1117'; c.fill();
    c.strokeStyle = anyComp ? '#58a6ff44' : '#30363d';
    c.lineWidth = 1; c.stroke();
    c.fillStyle = '#8b949e'; c.font = '8px system-ui'; c.textAlign = 'left';
    c.fillText('P'+(ni+1), b.x+3, gy+10);
    if (anyComp){
      const bar = S.pfB[ni];
      const p = bar.bt > 0 ? Math.min(1, (S.t - bar.cs)/bar.bt) : 0;
      c.fillStyle = '#58a6ff'; c.font = '8px system-ui'; c.textAlign = 'right';
      c.fillText(Math.round(p*100)+'%', b.x+b.w-3, gy+10);
      c.fillStyle = '#1c2333';
      c.fillRect(b.x+3, gy+14, b.w-6, gH-18);
      c.fillStyle = '#58a6ff';
      c.fillRect(b.x+3, gy+14, (b.w-6)*p, gH-18);
    }
  }
}

function dDecode(c, b){
  const S = sim.state, C = sim.config;
  c.font = '9px system-ui'; c.fillStyle = '#8b949e'; c.textAlign = 'center';
  c.fillText('Decode(x'+C.dcN+')', b.x+b.w/2, b.y-6);
  const cols = C.dcN > 6 ? 3 : C.dcN > 3 ? 2 : 1;
  const rows = Math.ceil(C.dcN / cols);
  const cW = (b.w - (cols-1)*4) / cols;
  const gH = Math.min(50, (b.h-5)/rows-4);
  for (let i = 0; i < C.dcN; i++){
    const g = S.dg[i], col = i % cols, row = Math.floor(i / cols);
    const gx = b.x + col*(cW+4), gy = b.y + row*(gH+4);
    let tr = 0;
    for (const rk of g.rk) tr += rk.length;
    rr(c, gx, gy, cW, gH, 5);
    c.fillStyle = tr > 0 ? '#0b1a0b' : '#0d1117'; c.fill();
    c.strokeStyle = tr > 0 ? '#3fb95044' : '#30363d';
    c.lineWidth = 1; c.stroke();
    c.fillStyle = '#8b949e'; c.font = '8px system-ui'; c.textAlign = 'left';
    c.fillText('D'+(i+1), gx+3, gy+9);
    c.textAlign = 'right';
    c.fillStyle = tr > 0 ? '#3fb950' : '#484f58';
    c.fillText(tr+'/'+C.mrr*C.dcDP, gx+cW-3, gy+9);
    const barH = gH - 14, barY = gy + 12;
    c.fillStyle = '#1c2333'; c.fillRect(gx+3, barY, cW-6, barH);
    if (tr > 0){
      const f = Math.min(1, tr / (C.mrr * C.dcDP));
      c.fillStyle = '#3fb95066';
      c.fillRect(gx+3, barY + barH*(1-f), cW-6, barH*f);
    }
  }
}

function draw(){
  rsz();
  const S = sim.state, T = sim.stats, C = sim.config;
  const w = vc.width/dp, h = vc.height/dp, c = vx;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#0d1117'; c.fillRect(0, 0, w, h);

  let pq = S.pq.length;
  for (const nq of S.pfQ) for (const q of nq) pq += q.length;
  let txC = 0;
  for (const no of S.pfOut) for (const ro of no) txC += ro.length;
  let dr = 0;
  for (const g of S.dg) for (const rk of g.rk) dr += rk.length;

  dBox(c, L.cli, S.inf, '#bc8cff', 'Client', 'pool:'+S.pool);
  dBox(c, L.pq, pq, '#58a6ff', 'PF Queue');
  rr(c, L.rt.x, L.rt.y, L.rt.w, L.rt.h, 6);
  c.fillStyle = '#161b22'; c.fill();
  c.strokeStyle = '#58a6ff44'; c.lineWidth = 1; c.stroke();
  c.fillStyle = '#58a6ff'; c.font = 'bold 9px system-ui';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('RT', L.rt.x+L.rt.w/2, L.rt.y+L.rt.h/2);
  c.font = '9px system-ui'; c.fillStyle = '#8b949e'; c.textBaseline = 'alphabetic';
  c.fillText('Router', L.rt.x+L.rt.w/2, L.rt.y-6);

  dPrefill(c, L.pf);
  dBox(c, L.tq, txC, '#d29922', 'KV Xfer');
  dDecode(c, L.dc);
  dBox(c, L.out, T.sc, '#3fb950', 'Done', T.turnCount+' turns');

  const my = L.my;
  dArr(c, L.cli.x+L.cli.w, my, L.pq.x, my, S.inf > 0);
  dArr(c, L.pq.x+L.pq.w, my, L.rt.x, my, pq > 0);
  dArr(c, L.rt.x+L.rt.w, my, L.pf.x, my, pq > 0);
  dArr(c, L.pf.x+L.pf.w, my, L.tq.x, my, txC > 0);
  dArr(c, L.tq.x+L.tq.w, my, L.dc.x, my, dr > 0 || txC > 0);
  dArr(c, L.dc.x+L.dc.w, my, L.out.x, my, T.sc > 0);

  dTier(c, L.hbm, S.tiers.hbm, '#58a6ff');
  dTier(c, L.dram, S.tiers.dram, '#d29922');
  dTier(c, L.remote, 0, '#39d2c0');

  const pfMid = {x: L.pf.x+L.pf.w/2, y: L.pf.y+L.pf.h};
  const hbmMid = {x: L.hbm.x+L.hbm.w/2, y: L.hbm.y};
  const dramMid = {x: L.dram.x+L.dram.w/2, y: L.dram.y};
  const remoteMid = {x: L.remote.x+L.remote.w/2, y: L.remote.y};
  if (S.tiers.hbm > 0) dArr(c, pfMid.x, pfMid.y, hbmMid.x, hbmMid.y, true);
  if (S.tiers.dram > 0) dArr(c, hbmMid.x+40, hbmMid.y+L.hbm.h/2, dramMid.x-40, dramMid.y+L.dram.h/2, true);
  dArr(c, remoteMid.x, remoteMid.y, dramMid.x+L.dram.w/2+10, dramMid.y+L.dram.h/2, T.prefetchCount > 0);

  updateParticles(performance.now());
  drawParticles(c);

  c.fillStyle = '#484f58'; c.font = '10px system-ui'; c.textAlign = 'center';
  const t = S.t/1000, mm = Math.floor(t/60), ss = (t%60).toFixed(1);
  let st = 'Sim:'+mm+':'+ss.padStart(4,'0')+' | Speed:'+C.spd+'x';
  if (S.done) st += ' | ALL COMPLETED';
  c.fillText(st, w/2, h-3);
}

// ===================== Chart History =====================
let CS;
function resetChartHistory(){
  CS = {
    ts: [], pq: [], tq: [], pfr: [], dr: [], pfTps: [], dcTps: [],
    hbm: [], dram: [], ttfts: [], pfc: [], rcc: [],
    lr: 0,
  };
}

function sampleChartHistory(){
  const S = sim.state, T = sim.stats, C = sim.config;
  if (S.t - CS.lr < 500) return;
  CS.lr = S.t;
  let pq = S.pq.length;
  for (const nq of S.pfQ) for (const q of nq) pq += q.length;
  let txC = 0;
  for (const no of S.pfOut) for (const ro of no) txC += ro.length;
  let pfr = 0;
  for (const nr of S.pfR) for (const rk of nr) if (rk.s === 'COMPUTING') pfr++;
  let dr = 0;
  for (const g of S.dg) for (const rk of g.rk) dr += rk.length;
  let dPf = 0;
  for (let ni = 0; ni < S.pfR.length; ni++){
    if (S.pfR[ni].some(r => r.s === 'COMPUTING')) dPf += S.pfB[ni].rate || 0;
  }
  let dDc = 0;
  for (const g of S.dg) if (!g.idle) dDc += g.rate || 0;

  CS.ts.push(S.t/1000);
  CS.pq.push(pq); CS.tq.push(txC); CS.pfr.push(pfr); CS.dr.push(dr);
  CS.pfTps.push(dPf); CS.dcTps.push(dDc);
  CS.hbm.push(S.tiers.hbm); CS.dram.push(S.tiers.dram);
  CS.pfc.push(T.prefetchCount); CS.rcc.push(T.recomputeCount);
}

// ===================== Charts =====================
Chart.defaults.color = '#8b949e';
Chart.defaults.borderColor = '#21262d';
const copts = {
  responsive: true, maintainAspectRatio: false, animation: false,
  interaction: { mode: 'index', intersect: false },
  plugins: { legend: { labels: { font: { size: 9 }, boxWidth: 10 } } },
  scales: {
    x: { ticks: { font: { size: 8 }, maxTicksLimit: 8 } },
    y: { min: 0, ticks: { font: { size: 8 } }, grid: { color: '#21262d' } },
  },
};

let charts = {};
function initCharts(){
  for (const k of Object.keys(charts)) if (charts[k]) charts[k].destroy();
  charts.ttft = new Chart($('cc_ttft'), { type: 'bar', data: { labels: [], datasets: [
    { label: 'TTFT (ms)', data: [], backgroundColor: '#58a6ff88' },
  ]}, options: { ...copts, plugins: { ...copts.plugins, legend: { display: false } } } });
  charts.pfrc = new Chart($('cc_pf_rc'), { type: 'line', data: { labels: [], datasets: [
    { label: 'Prefetch', data: [], borderColor: '#39d2c0', borderWidth: 1.5, pointRadius: 0, fill: false },
    { label: 'Recompute', data: [], borderColor: '#d29922', borderWidth: 1.5, pointRadius: 0, fill: false },
  ]}, options: copts });
  charts.pfr = new Chart($('cc_pfr'), { type: 'line', data: { labels: [], datasets: [
    { label: 'PF Running', data: [], borderColor: '#58a6ff', borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: '#58a6ff22' },
  ]}, options: copts });
  charts.dr = new Chart($('cc_dr'), { type: 'line', data: { labels: [], datasets: [
    { label: 'DC Running', data: [], borderColor: '#3fb950', borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: '#3fb95022' },
  ]}, options: copts });
  charts.tier = new Chart($('cc_tier'), { type: 'line', data: { labels: [], datasets: [
    { label: 'HBM', data: [], borderColor: '#58a6ff', borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: '#58a6ff22' },
    { label: 'DRAM', data: [], borderColor: '#d29922', borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: '#d2992222' },
  ]}, options: copts });
  charts.tps = new Chart($('cc_tps'), { type: 'line', data: { labels: [], datasets: [
    { label: 'PF TPS', data: [], borderColor: '#58a6ff', borderWidth: 1.5, pointRadius: 0 },
    { label: 'DC TPS', data: [], borderColor: '#3fb950', borderWidth: 1.5, pointRadius: 0 },
  ]}, options: copts });
  charts.e2e = new Chart($('cc_e2e'), { type: 'bar', data: { labels: [], datasets: [
    { label: 'E2E (s)', data: [], backgroundColor: '#3fb95066' },
  ]}, options: { ...copts, plugins: { ...copts.plugins, legend: { display: false } } } });
  charts.q = new Chart($('cc_q'), { type: 'line', data: { labels: [], datasets: [
    { label: 'PF Queue', data: [], borderColor: '#58a6ff', borderWidth: 1.5, pointRadius: 0 },
    { label: 'KV Xfer', data: [], borderColor: '#d29922', borderWidth: 1.5, pointRadius: 0 },
  ]}, options: copts });
}

function updateCharts(){
  const maxPts = 200;
  const sl = Math.max(0, CS.ts.length - maxPts);
  const ts = CS.ts.slice(sl).map(v => v.toFixed(1));

  charts.pfrc.data.labels = ts;
  charts.pfrc.data.datasets[0].data = CS.pfc.slice(sl);
  charts.pfrc.data.datasets[1].data = CS.rcc.slice(sl);
  charts.pfrc.update();

  charts.pfr.data.labels = ts;
  charts.pfr.data.datasets[0].data = CS.pfr.slice(sl);
  charts.pfr.update();

  charts.dr.data.labels = ts;
  charts.dr.data.datasets[0].data = CS.dr.slice(sl);
  charts.dr.update();

  charts.tier.data.labels = ts;
  charts.tier.data.datasets[0].data = CS.hbm.slice(sl);
  charts.tier.data.datasets[1].data = CS.dram.slice(sl);
  charts.tier.update();

  charts.tps.data.labels = ts;
  charts.tps.data.datasets[0].data = CS.pfTps.slice(sl);
  charts.tps.data.datasets[1].data = CS.dcTps.slice(sl);
  charts.tps.update();

  charts.q.data.labels = ts;
  charts.q.data.datasets[0].data = CS.pq.slice(sl);
  charts.q.data.datasets[1].data = CS.tq.slice(sl);
  charts.q.update();
}

// ===================== Particle spawning from sim events =====================
function processSimEvents(){
  const events = sim.drainEvents();
  const C = sim.config;
  const spd = C.spd;
  for (const ev of events){
    const dur = (ev.duration || 100) / spd;
    switch(ev.type){
      case 'prefetch_start':
        spawnParticle('prefetch',
          L.remote.x+L.remote.w/2, L.remote.y+L.remote.h/2,
          L.dram.x+L.dram.w/2, L.dram.y+L.dram.h/2,
          dur, ev);
        break;
      case 'prefetch_complete':
        spawnParticle('reload',
          L.dram.x+L.dram.w/2, L.dram.y+L.dram.h/2,
          L.hbm.x+L.hbm.w/2, L.hbm.y+L.hbm.h/2,
          dur/2, ev);
        break;
      case 'offload_start':
        spawnParticle('offload',
          L.hbm.x+L.hbm.w/2, L.hbm.y+L.hbm.h/2,
          L.dram.x+L.dram.w/2, L.dram.y+L.dram.h/2,
          dur, ev);
        break;
      case 'kv_transfer_start':
        spawnParticle('kv_transfer',
          L.pf.x+L.pf.w, L.my,
          L.dc.x, L.my,
          dur, ev);
        break;
      case 'req_routed':
        spawnParticle('request',
          L.rt.x+L.rt.w, L.my,
          L.pf.x, L.my,
          50/spd, ev);
        break;
      case 'first_token': {
        const ttft = ev.ttft;
        const ttftData = charts.ttft.data;
        ttftData.labels.push('T'+ev.turn);
        ttftData.datasets[0].data.push(Math.round(ttft));
        if (ttftData.labels.length > 50){
          ttftData.labels.shift();
          ttftData.datasets[0].data.shift();
        }
        charts.ttft.update();
        break;
      }
      case 'session_complete': {
        const e2eData = charts.e2e.data;
        e2eData.labels.push('S'+ev.sid);
        const e2e = sim.state.comp.length > 0 ? 0 : 0;
        e2eData.datasets[0].data.push((ev.turns * sim.config.osl * sim.config.tpot / 1000).toFixed(1));
        if (e2eData.labels.length > 30){
          e2eData.labels.shift();
          e2eData.datasets[0].data.shift();
        }
        charts.e2e.update();
        break;
      }
    }
  }
}

// ===================== Stats Panel =====================
function updateStats(){
  const S = sim.state, T = sim.stats, C = sim.config;
  const t = S.t / 1000;
  const mm = Math.floor(t/60), ss = (t%60).toFixed(1);
  $('s_time').textContent = mm+':'+ss.padStart(4,'0');
  $('s_pool').textContent = S.pool;
  $('s_inf').textContent = S.inf;
  $('s_done').textContent = T.sc;
  $('s_turns').textContent = T.turnCount;
  $('s_pfc').textContent = T.prefetchCount;
  $('s_rcc').textContent = T.recomputeCount;
  const total = T.prefetchCount + T.recomputeCount;
  $('s_pfwr').textContent = total > 0 ? (T.prefetchCount/total*100).toFixed(0)+'%' : '-';
  $('s_pfavg').textContent = T.prefetchCount > 0 ?
    Math.round(T.prefetchTokensTotal / T.prefetchCount) : '-';

  let pq = S.pq.length;
  for (const nq of S.pfQ) for (const q of nq) pq += q.length;
  $('s_pq').textContent = pq;
  let txC = 0;
  for (const no of S.pfOut) for (const ro of no) txC += ro.length;
  $('s_tq').textContent = txC;
  $('s_tw').textContent = S.toolWait.length;

  $('s_pfu').textContent = T.pTM > 0 ? (T.pBM/T.pTM*100).toFixed(0)+'%' : '0%';
  $('s_dcu').textContent = T.dTM > 0 ? (T.dAM/T.dTM*100).toFixed(0)+'%' : '0%';
  $('s_ttft').textContent = T.turnCount > 0 && T.tS > 0 ?
    (T.tS / T.turnCount).toFixed(0)+'ms' : '-';
  $('s_e2e').textContent = T.sc > 0 ? (T.lS / T.sc / 1000).toFixed(1)+'s' : '-';
  $('s_tps').textContent = t > 0 && T.sc > 0 ?
    (T.sc / t).toFixed(2)+' sess/s' : '-';
  $('s_hbm').textContent = S.tiers.hbm;
  $('s_dram').textContent = S.tiers.dram;
  $('s_off').textContent = T.offloadCount;

  updateFormula();
}

function updateFormula(){
  const C = sim.config;
  const kvB = C.kvBytesPerToken;
  const tPrefetch1k = (C.tFixedUmbp + 1000 * kvB / (C.bwUmbp * 1e9) * 1000).toFixed(1);
  const tRecompute1k = (1000 * C.flopsPerToken / (C.gpuThroughput * 1e12) * 1000).toFixed(1);
  const breakEven = Math.round(C.tFixedUmbp * (C.gpuThroughput * 1e12) /
    (C.flopsPerToken - kvB / (C.bwUmbp * 1e9) * (C.gpuThroughput * 1e12)));
  const win = tPrefetch1k < tRecompute1k;
  $('f_model').innerHTML =
    'T_prefetch(1K tok) = <span class="'+(win?'fv':'fr')+'">'+tPrefetch1k+'ms</span><br>'+
    'T_recompute(1K tok) = <span class="'+(win?'fr':'fv')+'">'+tRecompute1k+'ms</span><br>'+
    'Break-even ~ '+(isFinite(breakEven) && breakEven > 0 ? breakEven+' tokens' : 'N/A')+'<br>'+
    '<span class="'+(win?'fv':'fr')+'">'+(win ? 'Prefetch wins at 1K tokens' : 'Recompute wins at 1K tokens')+'</span>';
}

// ===================== Main Loop =====================
let paused = false, lastFrame = 0, chartTimer = 0;

function loop(ts){
  if (!lastFrame) lastFrame = ts;
  const wall = ts - lastFrame;
  lastFrame = ts;

  draw();

  if (!paused && sim && !sim.state.done){
    const dt = wall * sim.config.spd;
    sim.tick(dt);
    processSimEvents();
    sampleChartHistory();
  }

  chartTimer += wall;
  if (chartTimer > 1000){
    chartTimer = 0;
    updateCharts();
    updateStats();
  }

  requestAnimationFrame(loop);
}

// ===================== Init =====================
loadCfg();
$('c_total').value = +$('c_conc').value * 10;
$('c_conc').addEventListener('input', () => {
  $('c_total').value = +$('c_conc').value * 10;
});

newSim();
resetChartHistory();
initCharts();
updateStats();

for (const id of cfgIds){
  $(id).addEventListener('change', () => {
    saveCfg();
    newSim();
    resetChartHistory();
    particles = [];
    initCharts();
    updateStats();
    lastFrame = 0;
  });
}

$('c_spd').addEventListener('change', () => {
  $('spdL').textContent = $('c_spd').value + 'x';
  sim.cfg.spd = +$('c_spd').value;
  saveCfg();
});

$('bP').addEventListener('click', () => {
  paused = !paused;
  $('bP').textContent = paused ? 'Resume' : 'Pause';
});

$('bR').addEventListener('click', () => {
  newSim();
  resetChartHistory();
  particles = [];
  initCharts();
  updateStats();
  lastFrame = 0;
  paused = false;
  $('bP').textContent = 'Pause';
});

requestAnimationFrame(loop);
})();
