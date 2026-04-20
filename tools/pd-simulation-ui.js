// PD Disaggregation Simulator - UI layer (rendering, charts, events, localStorage).
// Consumes a PDSimulator instance for read-only state + config.

(function(){
const UI_VERSION = '1.1.3';
const $ = id => document.getElementById(id);
// Show version in header (also cross-check simulator lib version)
(function showVer(){
  const lbl = document.getElementById('verLbl');
  if (!lbl) return;
  const simV = (window.PDSimulator && window.PDSimulator.VERSION) || '?';
  const pageV = window.PD_VERSION || '?';
  const ok = simV === UI_VERSION && simV === pageV;
  lbl.textContent = 'v' + UI_VERSION + (ok ? '' : ' (mismatch: page=' + pageV + ' sim=' + simV + ' ui=' + UI_VERSION + ')');
  if (!ok) lbl.style.color = '#f85149';
})();

// ===================== Config I/O =====================
// Snap DP/EP to {1, TP}: anything else snaps to TP.
function snap1TP(v, tp){ return v === 1 ? 1 : tp; }

function readConfig(){
  const pfTP = +$('c_pfTP').value;
  const pfDP = snap1TP(+$('c_pfDP').value, pfTP);
  const pfEP = snap1TP(+$('c_pfEP').value, pfTP);
  const dcTP = +$('c_dcTP').value;
  const dcDP = snap1TP(+$('c_dcDP').value, dcTP);
  const dcEP = snap1TP(+$('c_dcEP').value, dcTP);
  if (+$('c_pfDP').value !== pfDP) $('c_pfDP').value = pfDP;
  if (+$('c_pfEP').value !== pfEP) $('c_pfEP').value = pfEP;
  if (+$('c_dcDP').value !== dcDP) $('c_dcDP').value = dcDP;
  if (+$('c_dcEP').value !== dcEP) $('c_dcEP').value = dcEP;
  return {
    tot: +$('c_conc').value * 10, conc: +$('c_conc').value,
    isl: +$('c_isl').value, osl: +$('c_osl').value, rng: +$('c_range').value,
    pfN: +$('c_pfN').value, pfTP, pfDP, pfEP, pfL: +$('c_pfL').value,
    pcR: +$('c_pcR').value / 100, chk: +$('c_chk').value, pfMR: +$('c_pfMR').value,
    txP: +$('c_txP').value / 100,
    dcN: +$('c_dcN').value, dcTP, dcDP, dcEP, mrr: +$('c_mrr').value,
    tpot: +$('c_tpot').value, mt: +$('c_mt').value,
    spd: +$('c_spd').value,
  };
}

const cfgInputs = ['c_total','c_conc','c_isl','c_osl','c_range','c_pfN','c_pfTP','c_pfDP','c_pfEP','c_pfL','c_pcR','c_chk','c_pfMR','c_txP','c_dcN','c_dcTP','c_dcDP','c_dcEP','c_mrr','c_tpot','c_mt','c_spd'];
function saveCfg(){
  const o = {};
  for (const id of cfgInputs) o[id] = $(id).value;
  localStorage.setItem('pd_sim_cfg', JSON.stringify(o));
}
function loadCfg(){
  try {
    const o = JSON.parse(localStorage.getItem('pd_sim_cfg'));
    if (!o) return;
    // v1.0.0 -> v1.1.3 migration: DEP became DP; map old c_pfD/c_dcD to c_pfDP/c_dcDP
    if (o.c_pfD != null && o.c_pfDP == null) o.c_pfDP = o.c_pfD;
    if (o.c_dcD != null && o.c_dcDP == null) o.c_dcDP = o.c_dcD;
    for (const id of cfgInputs) if (o[id] != null) $(id).value = o[id];
  } catch(e){}
}

// ===================== Simulator =====================
let sim = null;
function newSim(){ sim = new PDSimulator(readConfig()); }

// ===================== Chart History (UI-owned) =====================
let CS;
function resetChartHistory(){
  const C = sim.config;
  CS = {
    ts: [], pq: [], tq: [], inf: [],
    pfr: [], pfrR: Array.from({ length: C.pfN * C.pfDP }, () => []),
    dr: [], drR: Array.from({ length: C.dcN * C.dcDP }, () => []),
    pfTps: [], dcTps: [],
    lastPfTok: 0, lastDcTok: 0,
    lr: 0,
  };
}
function sampleChartHistory(){
  const S = sim.state, T = sim.stats, C = sim.config;
  if (S.t - CS.lr < 500) return;
  CS.lr = S.t;

  let dr = 0;
  for (const g of S.dg) for (const rk of g.rk) dr += rk.length;
  let pq = S.pq.length;
  for (const nq of S.pfQ) for (const q of nq) pq += q.length;
  let pfr = 0;
  for (const nr of S.pfR) for (const rk of nr) if (rk.s === 'COMPUTING') for (const it of rk.run) if (it.take > 0) pfr++;
  let txC = 0;
  for (const no of S.pfOut) for (const ro of no) txC += ro.length;

  const dPf = (T.pfTok - CS.lastPfTok) / 0.5;
  const dDc = (T.dcTok - CS.lastDcTok) / 0.5;
  CS.lastPfTok = T.pfTok; CS.lastDcTok = T.dcTok;

  CS.ts.push(S.t / 1000);
  CS.pq.push(pq); CS.tq.push(txC); CS.dr.push(dr); CS.inf.push(S.inf);
  CS.pfr.push(pfr);
  CS.pfTps.push(dPf); CS.dcTps.push(dDc);
  for (let i = 0; i < C.pfN * C.pfDP; i++){
    const ni = Math.floor(i / C.pfDP), ri = i % C.pfDP;
    const rkI = S.pfR[ni][ri];
    CS.pfrR[i].push(rkI.s === 'COMPUTING' ? rkI.run.filter(it => it.take > 0).length : 0);
  }
  for (let i = 0; i < C.dcN * C.dcDP; i++){
    const gi = Math.floor(i / C.dcDP), ri = i % C.dcDP;
    CS.drR[i].push(S.dg[gi].rk[ri].length);
  }
}

// ===================== Canvas Rendering =====================
const vc = $('vc'), vx = vc.getContext('2d');
const dp = window.devicePixelRatio || 1;

function rsz(){
  const S = sim.state;
  const r = vc.parentElement.getBoundingClientRect();
  const dc = S.dg.length > 6 ? 3 : S.dg.length > 3 ? 2 : 1;
  const dr = Math.ceil(S.dg.length / dc);
  const pfRows = S.pfR.length;
  const h = Math.max(250, 50 + Math.max(pfRows * 56, dr * 64));
  vc.style.height = h + 'px';
  vc.width = r.width * dp;
  vc.height = h * dp;
  vx.setTransform(dp, 0, 0, dp, 0, 0);
}

function rr(c, x, y, w, h, r){
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function dArr(c, x1, y1, x2, y2, on){
  const S = sim.state;
  c.save();
  c.beginPath();
  c.moveTo(x1, y1); c.lineTo(x2, y2);
  if (on){
    c.strokeStyle = '#58a6ff55'; c.lineWidth = 2;
    c.setLineDash([7, 5]);
    c.lineDashOffset = -(S.t * .03) % 12;
  } else {
    c.strokeStyle = '#ffffff15'; c.lineWidth = 1; c.setLineDash([]);
  }
  c.stroke();
  const a = Math.atan2(y2 - y1, x2 - x1), L = 6;
  c.beginPath();
  c.moveTo(x2, y2);
  c.lineTo(x2 - L * Math.cos(a - .4), y2 - L * Math.sin(a - .4));
  c.lineTo(x2 - L * Math.cos(a + .4), y2 - L * Math.sin(a + .4));
  c.closePath();
  c.fillStyle = on ? '#58a6ff88' : '#ffffff33';
  c.fill();
  c.setLineDash([]);
  c.restore();
}

function dQ(c, n, x, y, w, h, col, lb){
  rr(c, x, y, w, h, 6);
  c.fillStyle = '#161b22'; c.fill();
  c.strokeStyle = '#30363d'; c.lineWidth = 1; c.stroke();
  const f = Math.min(1, n / 100);
  if (f > 0){
    const fh = (h - 4) * f;
    rr(c, x + 2, y + h - fh - 2, w - 4, fh, 4);
    c.fillStyle = col + '33'; c.fill();
  }
  c.fillStyle = '#e6edf3'; c.font = 'bold 14px system-ui';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(n, x + w / 2, y + h / 2);
  c.font = '9px system-ui'; c.fillStyle = '#8b949e'; c.textBaseline = 'alphabetic';
  c.fillText(lb, x + w / 2, y - 6);
}

function dCli(c, x, y, w, h){
  const S = sim.state, T = sim.stats, C = sim.config;
  c.font = '9px system-ui'; c.fillStyle = '#8b949e'; c.textAlign = 'center';
  c.fillText('Client', x + w / 2, y - 6);
  rr(c, x, y, w, h, 6);
  c.fillStyle = '#161b22'; c.fill();
  c.strokeStyle = S.done ? '#3fb95066' : '#bc8cff44';
  c.lineWidth = 1; c.stroke();
  const y1 = y + 14;
  c.fillStyle = '#bc8cff'; c.font = 'bold 11px system-ui'; c.textAlign = 'center';
  c.fillText(S.done ? 'DONE' : 'In-Flight', x + w / 2, y1);
  c.fillStyle = '#e6edf3'; c.font = 'bold 16px system-ui';
  c.fillText(S.inf, x + w / 2, y1 + 20);
  c.font = '9px system-ui'; c.fillStyle = '#8b949e';
  c.fillText('/' + C.conc, x + w / 2, y1 + 33);
  const by = y1 + 42, bh = 8;
  c.fillStyle = '#1c2333'; c.fillRect(x + 4, by, w - 8, bh);
  const pp = C.tot > 0 ? S.pool / C.tot : 0;
  if (pp > 0){ c.fillStyle = '#bc8cff55'; c.fillRect(x + 4, by, (w - 8) * pp, bh); }
  c.strokeStyle = '#30363d'; c.lineWidth = .5; c.strokeRect(x + 4, by, w - 8, bh);
  c.fillStyle = '#8b949e'; c.font = '9px system-ui';
  c.fillText('pool:' + S.pool + '/' + C.tot, x + w / 2, by + bh + 12);
  c.fillText('done:' + T.cc, x + w / 2, by + bh + 24);
}

function dRt(c, x, y, w, h){
  const my = y + h / 2, s = 16;
  c.save();
  c.translate(x + w / 2, my);
  c.rotate(Math.PI / 4);
  rr(c, -s, -s, s * 2, s * 2, 3);
  c.fillStyle = '#161b22'; c.fill();
  c.strokeStyle = '#58a6ff44'; c.lineWidth = 1; c.stroke();
  c.rotate(-Math.PI / 4);
  c.fillStyle = '#58a6ff'; c.font = 'bold 9px system-ui';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('RR', 0, 0);
  c.restore();
  c.fillStyle = '#8b949e'; c.font = '9px system-ui';
  c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  c.fillText('Router', x + w / 2, y - 6);
}

function dPF(c, x, y, w, h){
  const S = sim.state, C = sim.config;
  const nNodes = S.pfR.length;
  const gH = Math.min(52, (h - 5) / Math.max(1, nNodes) - 4);
  c.font = '9px system-ui'; c.fillStyle = '#8b949e'; c.textAlign = 'center';
  c.fillText('Prefill(TP'+C.pfTP+'/DP'+C.pfDP+'/EP'+C.pfEP+')', x + w / 2, y - 6);
  for (let ni = 0; ni < nNodes; ni++){
    const ranks = S.pfR[ni], bar = S.pfB[ni], gy = y + ni * (gH + 4);
    const anyComp = ranks.some(r => r.s === 'COMPUTING');
    rr(c, x, gy, w, gH, 5);
    c.fillStyle = anyComp ? '#0d1926' : '#0d1117'; c.fill();
    c.strokeStyle = anyComp ? '#58a6ff44' : '#30363d';
    c.lineWidth = 1; c.stroke();
    c.fillStyle = '#8b949e'; c.font = '9px system-ui'; c.textAlign = 'left';
    c.fillText('N' + (ni + 1), x + 4, gy + 12);
    if (anyComp && bar.bt > 0){
      const p = Math.min(1, (S.t - bar.cs) / bar.bt);
      c.fillStyle = '#58a6ff'; c.font = '9px system-ui'; c.textAlign = 'right';
      c.fillText(Math.round(p * 100) + '%', x + w - 4, gy + 12);
    }
    const cp = 24, gp = 2;
    const cw = Math.max(14, (w - cp - gp * (C.pfDP - 1)) / C.pfDP);
    const ch2 = gH - 20, cy = gy + 16;
    for (let ri = 0; ri < C.pfDP; ri++){
      const cx = x + cp + ri * (cw + gp), rk = ranks[ri], q = S.pfQ[ni][ri];
      if (rk.s === 'COMPUTING'){
        c.fillStyle = '#1c2333'; c.fillRect(cx, cy, cw, ch2);
        if (rk.run.length > 0){
          const p = bar.bt > 0 ? Math.min(1, (S.t - bar.cs) / bar.bt) : 0;
          c.fillStyle = '#58a6ff'; c.fillRect(cx, cy, cw * p, ch2);
        } else { c.fillStyle = '#58a6ff22'; c.fillRect(cx, cy, cw, ch2); }
      } else if (rk.s === 'START_WAIT' || rk.s === 'END_WAIT'){
        c.fillStyle = '#2d2a00'; c.fillRect(cx, cy, cw, ch2);
      } else {
        c.fillStyle = '#1c2333'; c.fillRect(cx, cy, cw, ch2);
      }
      c.strokeStyle = '#30363d'; c.lineWidth = .5; c.strokeRect(cx, cy, cw, ch2);
      if (rk.run.length > 0){
        c.fillStyle = '#fff'; c.font = 'bold 7px system-ui';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(rk.run.length, cx + cw / 2, cy + ch2 / 2);
        c.textBaseline = 'alphabetic';
      }
      if (q.length > 0){
        c.fillStyle = '#58a6ff'; c.font = 'bold 7px system-ui'; c.textAlign = 'center';
        c.fillText(q.length, cx + cw / 2, cy - 2);
      }
    }
  }
}

function dDC(c, x, y, w, h){
  const S = sim.state, C = sim.config;
  const gs = S.dg;
  const cols = gs.length > 6 ? 3 : gs.length > 3 ? 2 : 1;
  const rows = Math.ceil(gs.length / cols);
  const cW = (w - (cols - 1) * 6) / cols;
  const gH = Math.min(60, (h - 5) / rows - 4);
  c.font = '9px system-ui'; c.fillStyle = '#8b949e'; c.textAlign = 'center';
  c.fillText('Decode(TP'+C.dcTP+'/DP'+C.dcDP+'/EP'+C.dcEP+' x'+C.mrr+'/rank)', x + w / 2, y - 6);
  for (let i = 0; i < gs.length; i++){
    const g = gs[i], col = i % cols, row = Math.floor(i / cols);
    const gx = x + col * (cW + 6), gy = y + row * (gH + 4);
    let tr = 0, mrc = 0;
    for (const rk of g.rk){ tr += rk.length; if (rk.length > mrc) mrc = rk.length; }
    const mt = C.dcDP * C.mrr;
    const tp = mrc > 0 ? Math.max(C.mt, C.tpot * mrc / C.mrr) : 0;
    rr(c, gx, gy, cW, gH, 5);
    c.fillStyle = tr > 0 ? '#0b1a0b' : '#0d1117'; c.fill();
    c.strokeStyle = tr > 0 ? '#3fb95044' : '#30363d';
    c.lineWidth = 1; c.stroke();
    c.fillStyle = '#8b949e'; c.font = '8px system-ui'; c.textAlign = 'left';
    c.fillText('D' + (i + 1), gx + 3, gy + 9);
    c.textAlign = 'right';
    c.fillStyle = tr > 0 ? '#3fb950' : '#484f58';
    c.fillText(tr + '/' + mt, gx + cW - 3, gy + 9);
    if (tp > 0){
      c.fillStyle = '#8b949e'; c.font = '7px system-ui';
      c.fillText(tp.toFixed(0) + 'ms', gx + cW - 3, gy + 17);
    }
    const bp = 3, bg = 1;
    const bw = Math.max(4, (cW - 2 * bp - (C.dcDP - 1) * bg) / C.dcDP);
    const bh = gH - 20, by = gy + 18;
    for (let ri = 0; ri < C.dcDP; ri++){
      const bx = gx + bp + ri * (bw + bg), rk = g.rk[ri];
      c.fillStyle = '#1c2333'; c.fillRect(bx, by, bw, bh);
      if (rk.length > 0){
        const lh = Math.max(2, Math.min(bh / rk.length, 6));
        const usedH = lh * rk.length;
        const fy = by + bh - Math.min(usedH, bh);
        const sr = [...rk].sort((a, b) => (b.ot / b.osl) - (a.ot / a.osl));
        const drawN = Math.min(sr.length, Math.floor(bh / lh));
        for (let j = 0; j < drawN; j++){
          const p = sr[j].ot / sr[j].osl, ly = fy + j * lh, lw = bw * Math.min(1, p);
          c.fillStyle = 'hsl(130,55%,' + (18 + p * 38) + '%)';
          c.fillRect(bx, ly, lw, lh - .5);
        }
        if (sr.length > drawN){
          const ap = sr.slice(drawN).reduce((s, r) => s + r.ot / r.osl, 0) / (sr.length - drawN);
          c.fillStyle = 'hsl(130,55%,' + (18 + ap * 38) + '%)';
          c.fillRect(bx, by, bw, fy - by);
        }
        if (rk.length === mrc && mrc > 0){
          c.strokeStyle = '#3fb95088'; c.lineWidth = 1; c.strokeRect(bx, by, bw, bh);
        }
      }
      c.strokeStyle = '#30363d'; c.lineWidth = .3; c.strokeRect(bx, by, bw, bh);
    }
  }
}

function dOut(c, x, y, w, h){
  const S = sim.state, T = sim.stats, C = sim.config;
  c.font = '9px system-ui'; c.fillStyle = '#8b949e'; c.textAlign = 'center';
  c.fillText('Output', x + w / 2, y - 6);
  rr(c, x, y, w, h, 6);
  c.fillStyle = '#161b22'; c.fill();
  c.strokeStyle = '#30363d'; c.lineWidth = 1; c.stroke();
  c.fillStyle = '#3fb950'; c.font = 'bold 18px system-ui';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(T.cc, x + w / 2, y + h * .35);
  c.font = '9px system-ui'; c.fillStyle = '#8b949e';
  c.fillText('completed', x + w / 2, y + h * .52);
  if (T.cc > 0 && S.t > 0){
    c.fillText((T.cc / (S.t / 1000)).toFixed(2) + ' req/s', x + w / 2, y + h * .68);
  }
  c.fillStyle = '#3fb950'; c.font = '10px system-ui';
  c.fillText((C.tot > 0 ? (T.cc / C.tot * 100).toFixed(0) : 0) + '%', x + w / 2, y + h * .84);
  c.textBaseline = 'alphabetic';
}

function draw(){
  rsz();
  const S = sim.state, T = sim.stats, C = sim.config;
  const w = vc.width / dp, h = vc.height / dp, c = vx;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#0d1117'; c.fillRect(0, 0, w, h);
  const pd = 10, ty = 22, ch2 = h - ty - pd, gx = 8;
  const cliW = 68, qw = 50, rtw = 34, ow = 62;
  const fx = w - 2 * pd - cliW - qw * 2 - rtw - ow - gx * 6;
  const pw = fx * .25, dw = fx * .75;
  let cx2 = pd;
  const clX = cx2; cx2 += cliW + gx;
  const pqX = cx2; cx2 += qw + gx;
  const rtX = cx2; cx2 += rtw + gx;
  const pgX = cx2; cx2 += pw + gx;
  const tqX = cx2; cx2 += qw + gx;
  const dgX = cx2; cx2 += dw + gx;
  const oX = cx2;
  let pq = S.pq.length;
  for (const nq of S.pfQ) for (const q of nq) pq += q.length;
  const anyPfComp = S.pfR.some(nr => nr.some(rk => rk.s === 'COMPUTING'));
  let txC = 0;
  for (const no of S.pfOut) for (const ro of no) txC += ro.length;

  dCli(c, clX, ty, cliW, ch2);
  dQ(c, pq, pqX, ty, qw, ch2, '#58a6ff', 'PF Queue');
  dRt(c, rtX, ty, rtw, ch2);
  dPF(c, pgX, ty, pw, ch2);
  dQ(c, txC, tqX, ty, qw, ch2, '#d29922', 'KV Xfer');
  dDC(c, dgX, ty, dw, ch2);
  dOut(c, oX, ty, ow, ch2);

  const my = ty + ch2 / 2;
  dArr(c, clX + cliW, my, pqX, my, S.inf > 0);
  dArr(c, pqX + qw, my, rtX, my, pq > 0);
  dArr(c, rtX + rtw, my, pgX, my, pq > 0);
  dArr(c, pgX + pw, my, tqX, my, txC > 0 || anyPfComp);
  let hd = false;
  for (const g of S.dg) for (const rk of g.rk) if (rk.length){ hd = true; break; }
  dArr(c, tqX + qw, my, dgX, my, hd || txC > 0);
  dArr(c, dgX + dw, my, oX, my, T.cc > 0);

  if (T.cc > 0){
    const fy = ty + ch2 + 4;
    c.save();
    c.strokeStyle = '#3fb95033'; c.lineWidth = 1;
    c.setLineDash([4, 4]);
    c.lineDashOffset = (S.t * .02) % 8;
    c.beginPath();
    c.moveTo(oX + ow / 2, ty + ch2);
    c.lineTo(oX + ow / 2, fy);
    c.lineTo(clX + cliW / 2, fy);
    c.lineTo(clX + cliW / 2, ty + ch2);
    c.stroke();
    c.setLineDash([]);
    c.restore();
  }

  c.fillStyle = '#484f58'; c.font = '10px system-ui'; c.textAlign = 'center';
  const t = S.t / 1000, mm = Math.floor(t / 60), ss = (t % 60).toFixed(1);
  let st = 'Sim:' + mm + ':' + ss.padStart(4, '0') + ' | Speed:' + (+$('c_spd').value) + 'x';
  if (S.done) st += ' | ALL COMPLETED';
  c.fillText(st, w / 2, h - 3);
}

// ===================== Chart.js =====================
let ch1, ch1b, ch1c, ch2, ch3, ch4, ch5, ch6, ch7;
Chart.defaults.color = '#8b949e';
Chart.defaults.borderColor = '#21262d';
const copts = {
  responsive: true, maintainAspectRatio: false, animation: false,
  interaction: { mode: 'index', intersect: false },
  plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 12, filter: item => !item.text.startsWith('_') } } },
  scales: {
    x: { ticks: { font: { size: 8 }, maxTicksLimit: 10 } },
    y: { min: 0, ticks: { font: { size: 8 } }, grid: { color: '#21262d' } },
  },
};
function hsl(h, s, l, a){ return `hsla(${h},${s}%,${l}%,${a})`; }

function destroyCharts(){
  [ch1, ch1b, ch1c, ch2, ch3, ch4, ch5, ch6, ch7].forEach(c => c && c.destroy());
  ch1 = ch1b = ch1c = ch2 = ch3 = ch4 = ch5 = ch6 = ch7 = null;
}

function initCh(){
  const C = sim.config;
  ch1 = new Chart($('cc1').getContext('2d'), { type: 'line', data: { labels: [], datasets: [
    { label: 'In-Flight', data: [], borderColor: '#bc8cff', backgroundColor: '#bc8cff33', borderWidth: 2, pointRadius: 0, tension: .3, fill: true },
  ]}, options: { ...copts } });
  ch1b = new Chart($('cc1b').getContext('2d'), { type: 'line', data: { labels: [], datasets: [
    { label: 'PF Queue', data: [], borderColor: '#58a6ff', backgroundColor: '#58a6ff33', borderWidth: 2, pointRadius: 0, tension: .3, fill: true },
  ]}, options: { ...copts } });
  ch1c = new Chart($('cc1c').getContext('2d'), { type: 'line', data: { labels: [], datasets: [
    { label: 'KV Xfer', data: [], borderColor: '#d29922', backgroundColor: '#d2992233', borderWidth: 2, pointRadius: 0, tension: .3, fill: true },
  ]}, options: { ...copts } });
  const pfDS = [{ label: 'Total', data: [], borderColor: '#58a6ff', backgroundColor: '#58a6ff33', borderWidth: 2.5, pointRadius: 0, tension: .3, fill: true }];
  for (let i = 0; i < C.pfN * C.pfDP; i++){
    const ni = Math.floor(i / C.pfDP), ri = i % C.pfDP;
    pfDS.push({ label: '_N' + (ni + 1) + '.R' + ri, data: [], borderColor: hsl(210, 70, 50 + i * 30 / (C.pfN * C.pfDP), .7), borderWidth: 1, pointRadius: 0, tension: .3 });
  }
  ch2 = new Chart($('cc2').getContext('2d'), { type: 'line', data: { labels: [], datasets: pfDS }, options: { ...copts } });
  const dcDS = [{ label: 'Total', data: [], borderColor: '#3fb950', backgroundColor: '#3fb95033', borderWidth: 2.5, pointRadius: 0, tension: .3, fill: true }];
  for (let i = 0; i < C.dcN * C.dcDP; i++){
    const gi = Math.floor(i / C.dcDP), ri = i % C.dcDP;
    dcDS.push({ label: '_D' + (gi + 1) + '.R' + ri, data: [], borderColor: hsl(130, 50, 40 + i * 30 / (C.dcN * C.dcDP), .5), borderWidth: 1, pointRadius: 0, tension: .3 });
  }
  ch3 = new Chart($('cc3').getContext('2d'), { type: 'line', data: { labels: [], datasets: dcDS }, options: { ...copts } });
  const hopts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { title: { display: true, text: 'Length', font: { size: 9 } }, ticks: { font: { size: 8 } } },
      y: { title: { display: true, text: 'Count', font: { size: 9 } }, min: 0, ticks: { font: { size: 8 }, stepSize: 1 }, grid: { color: '#21262d' } },
    },
  };
  ch4 = new Chart($('cc4').getContext('2d'), { type: 'bar', data: { labels: [], datasets: [
    { data: [], backgroundColor: '#58a6ff88', borderColor: '#58a6ff', borderWidth: 1 },
  ]}, options: { ...hopts } });
  ch5 = new Chart($('cc5').getContext('2d'), { type: 'bar', data: { labels: [], datasets: [
    { data: [], backgroundColor: '#3fb95088', borderColor: '#3fb950', borderWidth: 1 },
  ]}, options: { ...hopts } });
  ch6 = new Chart($('cc6').getContext('2d'), { type: 'line', data: { labels: [], datasets: [
    { label: 'PF TPS', data: [], borderColor: '#58a6ff', backgroundColor: '#58a6ff33', borderWidth: 2, pointRadius: 0, tension: .3, fill: true },
  ]}, options: { ...copts } });
  ch7 = new Chart($('cc7').getContext('2d'), { type: 'line', data: { labels: [], datasets: [
    { label: 'DC TPS', data: [], borderColor: '#3fb950', backgroundColor: '#3fb95033', borderWidth: 2, pointRadius: 0, tension: .3, fill: true },
  ]}, options: { ...copts } });
}

let lcu = 0;
function uCh(now){
  if (now - lcu < 250) return;
  lcu = now;
  const S = sim.state;
  const lb = CS.ts.map(t => t.toFixed(1));
  ch1.data.labels = lb; ch1.data.datasets[0].data = [...CS.inf]; ch1.update('none');
  ch1b.data.labels = lb; ch1b.data.datasets[0].data = [...CS.pq]; ch1b.update('none');
  ch1c.data.labels = lb; ch1c.data.datasets[0].data = [...CS.tq]; ch1c.update('none');
  ch2.data.labels = lb; ch2.data.datasets[0].data = [...CS.pfr];
  for (let i = 0; i < CS.pfrR.length; i++) ch2.data.datasets[1 + i].data = [...CS.pfrR[i]];
  ch2.update('none');
  ch3.data.labels = lb; ch3.data.datasets[0].data = [...CS.dr];
  for (let i = 0; i < CS.drR.length; i++) ch3.data.datasets[1 + i].data = [...CS.drR[i]];
  ch3.update('none');
  ch6.data.labels = lb; ch6.data.datasets[0].data = [...CS.pfTps]; ch6.update('none');
  ch7.data.labels = lb; ch7.data.datasets[0].data = [...CS.dcTps]; ch7.update('none');
  if (S.comp.length > 0){
    const nBins = 20;
    function mkHist(vals, nb){
      if (!vals.length) return { labels: [], counts: [] };
      const mn = Math.min(...vals), mx = Math.max(...vals), bw = Math.max(1, (mx - mn) / nb);
      const counts = new Array(nb).fill(0), labels = [];
      for (const v of vals){ const bi = Math.min(nb - 1, Math.floor((v - mn) / bw)); counts[bi]++; }
      for (let i = 0; i < nb; i++) labels.push(Math.round(mn + bw * (i + .5)));
      return { labels, counts };
    }
    const ih = mkHist(S.comp.map(r => r.isl), nBins);
    ch4.data.labels = ih.labels; ch4.data.datasets[0].data = ih.counts; ch4.update('none');
    const oh = mkHist(S.comp.map(r => r.osl), nBins);
    ch5.data.labels = oh.labels; ch5.data.datasets[0].data = oh.counts; ch5.update('none');
  }
}

// ===================== Stats panel =====================
function fmtT(v){ return v > 1000 ? (v / 1000).toFixed(1) + 'K' : v.toFixed(0); }

function uSt(){
  const S = sim.state, T = sim.stats, C = sim.config;
  const t = S.t / 1000;
  $('s0').textContent = Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
  $('s1').textContent = S.pool + '/' + C.tot;
  $('s2').textContent = S.inf + '/' + C.conc;
  $('s3').textContent = T.cc + '/' + C.tot;
  $('s4').textContent = (S.t > 0 ? (T.cc / (S.t / 1000)) : 0).toFixed(2) + ' req/s';
  let pq = S.pq.length;
  for (const nq of S.pfQ) for (const q of nq) pq += q.length;
  $('s5').textContent = pq;
  let txS = 0;
  for (const no of S.pfOut) for (const ro of no) txS += ro.length;
  $('s6').textContent = txS;
  let dr = 0;
  for (const g of S.dg) for (const rk of g.rk) dr += rk.length;
  $('s7').textContent = dr + '/' + (C.dcN * C.dcDP * C.mrr);
  $('s8').textContent = (T.pTM > 0 ? (T.pBM / T.pTM * 100) : 0).toFixed(1) + '%';
  $('s9').textContent = (T.pT > 0 ? ((1 - T.pU / T.pT) * 100) : 0).toFixed(1) + '%';
  const pfTPS = S.t > 0 ? (T.pfTok / (S.t / 1000)) : 0;
  const dcTPS = S.t > 0 ? (T.dcTok / (S.t / 1000)) : 0;
  const pfGPU = C.pfN * C.pfDP, dcGPU = C.dcN * C.dcDP;
  $('sh').textContent = fmtT(pfTPS) + ' / ' + fmtT(pfTPS / pfGPU);
  $('si').textContent = fmtT(dcTPS) + ' / ' + fmtT(dcTPS / dcGPU);
  $('sa').textContent = (T.dTM > 0 ? (T.dAM / T.dTM * 100) : 0).toFixed(1) + '%';
  $('sb').textContent = (T.dTS > 0 ? ((1 - T.dUS / T.dTS) * 100) : 0).toFixed(1) + '%';
  if (T.cc > 0){
    $('sc').textContent = (T.lS / T.cc / 1000).toFixed(2) + 's';
    $('sd').textContent = (T.tS / T.cc).toFixed(0) + 'ms';
    const lats = S.comp.map(r => r.de - r.ct).sort((a, b) => a - b);
    const p50 = lats[Math.floor(lats.length * .5)] / 1000;
    const p99 = lats[Math.min(lats.length - 1, Math.floor(lats.length * .99))] / 1000;
    $('sf').textContent = p50.toFixed(2) + 's';
    $('sg').textContent = p99.toFixed(2) + 's';
  } else {
    $('sc').textContent = '-'; $('sd').textContent = '-';
    $('sf').textContent = '-'; $('sg').textContent = '-';
  }
  if (S.comp.length > 0){
    const firstSend = S.comp.reduce((m, r) => Math.min(m, r.ct), Infinity);
    const lastEnd = S.comp.reduce((m, r) => Math.max(m, r.de), -Infinity);
    const e2eCost = (lastEnd - firstSend) / 1000;
    $('sj').textContent = e2eCost.toFixed(2) + 's';
    const sumISL = S.comp.reduce((s, r) => s + r.isl, 0);
    const sumOSL = S.comp.reduce((s, r) => s + r.osl, 0);
    const ePF = sumISL / e2eCost, eDC = sumOSL / e2eCost, eAll = (sumISL + sumOSL) / e2eCost;
    const pfTotalGPU = C.pfN * C.pfTP, dcTotalGPU = C.dcN * C.dcTP;
    $('sk').textContent = e2eCost > 0 ? fmtT(ePF) + ' / ' + fmtT(ePF / pfTotalGPU) : '-';
    $('sl').textContent = e2eCost > 0 ? fmtT(eDC) + ' / ' + fmtT(eDC / dcTotalGPU) : '-';
    $('sm').textContent = e2eCost > 0 ? fmtT(eAll) + ' / ' + fmtT(eAll / (pfTotalGPU + dcTotalGPU)) : '-';
  } else {
    $('sj').textContent = '-'; $('sk').textContent = '-';
    $('sl').textContent = '-'; $('sm').textContent = '-';
  }
  $('se').textContent = (C.dcN * C.dcDP * C.mrr / (C.osl * C.tpot / 1000)).toFixed(1) + ' req/s';
}

// ===================== Reset / Pause =====================
let paused = false;
function fullReset(){
  newSim();
  resetChartHistory();
  destroyCharts();
  initCh();
  paused = false;
  $('bP').textContent = 'Pause';
}

// ===================== Events =====================
loadCfg();
$('spdL').textContent = $('c_spd').value + 'x';
function syncTotal(){ $('c_total').value = +$('c_conc').value * 10; }
syncTotal();
$('c_conc').addEventListener('input', syncTotal);
for (const id of cfgInputs) $(id).addEventListener('change', saveCfg);
$('c_spd').addEventListener('change', () => {
  $('spdL').textContent = $('c_spd').value + 'x';
  saveCfg();
});
$('bP').addEventListener('click', () => {
  paused = !paused;
  $('bP').textContent = paused ? 'Resume' : 'Pause';
});
$('bR').addEventListener('click', () => {
  saveCfg();
  fullReset();
});

// ===================== Main Loop =====================
let lft = 0;
function loop(ts){
  if (!lft) lft = ts;
  const realDt = Math.min(ts - lft, 100);
  lft = ts;
  if (!paused && !sim.state.done){
    const speed = +$('c_spd').value;
    const simDt = realDt * speed;
    const n = Math.min(Math.ceil(simDt), 5000);
    const step = simDt / n;
    for (let i = 0; i < n; i++) sim.tick(step);
  }
  sampleChartHistory();
  draw();
  uCh(ts);
  uSt();
  requestAnimationFrame(loop);
}

// ===================== Init =====================
fullReset();
requestAnimationFrame(loop);
})();
