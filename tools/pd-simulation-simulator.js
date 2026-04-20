// PD Disaggregation Simulator - pure simulation, no DOM.
// Exposes a Simulator class with: reset(), tick(dt), state, config.

(function(global){
const SIM_VERSION = '1.1.4';
class Simulator {
  constructor(config){
    this.cfg = { ...config };
    this._rid = 0;
    this.reset();
  }

  get state(){ return this._s; }
  get stats(){ return this._t; }
  get config(){ return this.cfg; }

  setConfig(config){
    this.cfg = { ...config };
    this.reset();
  }

  _mkReq(){
    const C = this.cfg, S = this._s;
    return {
      id: this._rid++,
      isl: Math.round(C.isl * (C.rng + Math.random() * (1 - C.rng))),
      osl: Math.round(C.osl * (C.rng + Math.random() * (1 - C.rng))),
      ct: S.t, ps: 0, pe: 0, ds: 0, ft: 0, de: 0, ot: 0, dcNi: 0, dcRi: 0,
    };
  }

  reset(){
    const C = this.cfg;
    this._rid = 0;
    const S = {
      t: 0, pau: false, done: false,
      pool: C.tot, inf: 0,
      pq: [], ri: 0, dri: 0, comp: [],
      pfR: [], pfQ: [], pfB: [], pfOut: [],
      dg: [],
    };
    for (let ni = 0; ni < C.pfN; ni++){
      S.pfR.push(Array.from({ length: C.pfDP }, () => ({ s: 'FETCH', run: [], con: 0, ce: 0 })));
      S.pfQ.push(Array.from({ length: C.pfDP }, () => []));
      S.pfB.push({ sc: 0, ec: 0, bt: 0, cs: 0 });
      S.pfOut.push(Array.from({ length: C.pfDP }, () => []));
    }
    for (let i = 0; i < C.dcN; i++){
      S.dg.push({ rk: Array.from({ length: C.dcDP }, () => []), ls: 0, idle: true });
    }
    this._s = S;
    this._t = {
      pBM: 0, pTM: 0, pU: 0, pT: 0,
      dAM: 0, dTM: 0, dUS: 0, dTS: 0,
      cc: 0, lS: 0, tS: 0,
      pfTok: 0, dcTok: 0,
    };
    // Initial burst: fill the client in-flight window
    const burst = Math.min(C.conc, S.pool);
    for (let i = 0; i < burst; i++){
      S.pq.push(this._mkReq());
      S.pool--; S.inf++;
    }
  }

  _onComp(r){
    const S = this._s, T = this._t;
    T.cc++; T.lS += r.de - r.ct; T.tS += r.ft - r.ct;
    S.comp.push(r); S.inf--;
    if (S.pool > 0){
      S.pq.push(this._mkReq());
      S.pool--; S.inf++;
    }
    if (S.inf === 0 && S.pool === 0) S.done = true;
  }

  // Advance simulation by dt ms.
  tick(dt){
    const C = this.cfg, S = this._s, T = this._t;
    if (S.done) return;
    S.t += dt;

    // === Router Actor: assign PF rank + DC rank (independent round-robins) ===
    const totalPfRanks = C.pfN * C.pfDP, totalDcRanks = C.dcN * C.dcDP;
    while (S.pq.length > 0){
      const req = S.pq.shift();
      const pfi = S.ri % totalPfRanks;
      S.pfQ[Math.floor(pfi / C.pfDP)][pfi % C.pfDP].push(req);
      S.ri++;
      const dfi = S.dri % totalDcRanks;
      req.dcNi = Math.floor(dfi / C.dcDP);
      req.dcRi = dfi % C.dcDP;
      S.dri++;
    }

    // === Prefill Rank Actors (chunked prefill with barrier per node) ===
    for (let ni = 0; ni < C.pfN; ni++){
      const bar = S.pfB[ni];
      for (let ri = 0; ri < C.pfDP; ri++){
        const rk = S.pfR[ni][ri];
        if (rk.s === 'FETCH'){
          const q = S.pfQ[ni][ri];
          for (let i = rk.run.length - 1; i >= 0; i--){
            if (rk.run[i].rem <= 0){
              const req = rk.run[i].r;
              const realT = req.isl / C.isl * C.pfL;
              S.pfOut[ni][ri].push({ r: req, te: S.t + realT * C.txP });
              rk.run.splice(i, 1);
            }
          }
          while (rk.run.length < C.pfMR && q.length > 0){
            const req = q.shift();
            req.ps = S.t;
            rk.run.push({ r: req, rem: Math.round(req.isl * (1 - C.pcR)) });
          }
          let budget = C.chk;
          rk.con = 0;
          for (const item of rk.run){
            if (budget <= 0) break;
            const take = Math.min(item.rem, budget);
            item.take = take;
            budget -= take;
            rk.con += take;
          }
          rk.s = 'START_WAIT';
          bar.sc++;
        }
        if (rk.s === 'COMPUTING' && S.t >= rk.ce){
          rk.s = 'END_WAIT';
          bar.ec++;
        }
      }
      if (bar.sc === C.pfDP){
        const cons = S.pfR[ni].map(r => r.con);
        const mx = Math.max(0, ...cons);
        const sumC = cons.reduce((a, b) => a + b, 0);
        bar.bt = mx > 0 ? Math.max(20, mx / C.isl * C.pfL) : 0;
        bar.cs = S.t;
        bar.sc = 0;
        if (mx > 0){ T.pU += sumC; T.pT += mx * C.pfDP; }
        for (const rk of S.pfR[ni]){
          rk.ce = S.t + bar.bt;
          rk.s = bar.bt > 0 ? 'COMPUTING' : 'END_WAIT';
        }
        if (bar.bt === 0) bar.ec = C.pfDP;
      }
      if (bar.ec === C.pfDP){
        bar.ec = 0;
        for (const rk of S.pfR[ni]){
          for (const item of rk.run){ item.rem -= (item.take || 0); item.take = 0; }
          rk.s = 'FETCH';
        }
      }
    }

    // === Transfer KV Actor: place into pre-assigned DC rank when transfer done ===
    for (let ni = 0; ni < C.pfN; ni++){
      for (let ri = 0; ri < C.pfDP; ri++){
        const oq = S.pfOut[ni][ri];
        while (oq.length > 0 && S.t >= oq[0].te){
          const req = oq[0].r;
          if (S.dg[req.dcNi].rk[req.dcRi].length < C.mrr){
            oq.shift();
            req.pe = S.t; req.ds = S.t; req.ot = 0;
            S.dg[req.dcNi].rk[req.dcRi].push(req);
          } else break;
        }
      }
    }

    // === Decode Node Actors (independent timer per node) ===
    for (const g of S.dg){
      let mrc = 0;
      for (const rk of g.rk) if (rk.length > mrc) mrc = rk.length;
      if (mrc === 0){ g.idle = true; g.ls = S.t; continue; }
      if (g.idle){ g.ls = S.t; g.idle = false; }
      let tp = Math.max(C.mt, C.tpot * mrc / C.mrr);
      let safe = 0;
      while (S.t - g.ls >= tp && safe < 500){
        safe++;
        g.ls += tp;
        let sum = 0;
        for (const rk of g.rk) sum += rk.length;
        T.dUS += sum; T.dTS += mrc * C.dcDP; T.dcTok += sum;
        for (let ri = 0; ri < g.rk.length; ri++){
          for (let j = g.rk[ri].length - 1; j >= 0; j--){
            const req = g.rk[ri][j];
            req.ot++;
            if (req.ot === 1){ req.ft = g.ls; T.pfTok += req.isl; }
            if (req.ot >= req.osl){
              req.de = g.ls;
              this._onComp(req);
              g.rk[ri].splice(j, 1);
            }
          }
        }
        mrc = 0;
        for (const rk of g.rk) if (rk.length > mrc) mrc = rk.length;
        if (mrc === 0){ g.idle = true; break; }
        tp = Math.max(C.mt, C.tpot * mrc / C.mrr);
      }
    }

    // === Stats accumulators (time-weighted) ===
    for (let ni = 0; ni < C.pfN; ni++){
      for (let ri = 0; ri < C.pfDP; ri++){
        T.pTM += dt;
        if (S.pfR[ni][ri].s === 'COMPUTING' && S.pfR[ni][ri].run.some(it => it.take > 0)) T.pBM += dt;
      }
    }
    for (const g of S.dg){
      let tot = 0;
      for (const rk of g.rk) tot += rk.length;
      T.dAM += tot * dt;
      T.dTM += C.dcDP * C.mrr * dt;
    }
  }
}

global.PDSimulator = Simulator;
global.PDSimulator.VERSION = SIM_VERSION;
})(typeof window !== 'undefined' ? window : globalThis);
