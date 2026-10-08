// Router PD Simulator — multi-P / multi-D with a pluggable sglang-style router.
// Extends the PD disaggregation model with selectable routing algorithms and a
// prefix-cache-affinity model, so different routers yield different Pareto points.
// Pure logic, no DOM. Exposes RouterPDSimulator: reset(), tick(dt), runToEnd(), state, stats, config.

(function (global) {
  const SIM_VERSION = '0.1.0';

  // Routing algorithms. Each returns a prefill node index for a request.
  // `ctx` = { pfN, counter, req, nodeSeen (per-node Set of prefix groups), nodeLoad (per-node queued reqs) }.
  const ROUTERS = {
    round_robin: (ctx) => ctx.counter % ctx.pfN,
    random: (ctx) => (Math.random() * ctx.pfN) | 0,
    power_of_two: (ctx) => {
      const a = (Math.random() * ctx.pfN) | 0;
      let b = (Math.random() * ctx.pfN) | 0;
      if (b === a) b = (b + 1) % ctx.pfN;
      return ctx.nodeLoad[a] <= ctx.nodeLoad[b] ? a : b;
    },
    // Sticky by prefix group → same conversation lands on the same node (prefix cache hit).
    cache_aware: (ctx) => ctx.req.grp % ctx.pfN,
    // Hash the group id (stable, spreads groups) — sticky but hash-based.
    consistent_hashing: (ctx) => {
      let h = 2166136261 ^ ctx.req.grp;
      h = Math.imul(h, 16777619); h ^= h >>> 13;
      return (h >>> 0) % ctx.pfN;
    },
  };

  class RouterPDSimulator {
    constructor(config) {
      this.cfg = { ...config };
      if (!this.cfg.cacheCap) this.cfg.cacheCap = Math.max(1, Math.ceil((this.cfg.nGroups || 1) / (this.cfg.pfN || 1)));
      this._rid = 0; this.reset();
    }
    get state() { return this._s; }
    get stats() { return this._t; }
    get config() { return this.cfg; }
    setConfig(config) { this.cfg = { ...config }; this.reset(); }

    _mkReq() {
      const C = this.cfg, S = this._s;
      const isl = Math.round(C.isl * (C.rng + Math.random() * (1 - C.rng)));
      const osl = Math.round(C.osl * (C.rng + Math.random() * (1 - C.rng)));
      return {
        id: this._rid++, isl, osl,
        grp: (Math.random() * Math.max(1, C.nGroups)) | 0, // prefix group (shared-prefix conversation)
        ct: S.t, ps: 0, pe: 0, ds: 0, ft: 0, de: 0, ot: 0, dcNi: 0, dcRi: 0, hit: 0,
      };
    }

    reset() {
      const C = this.cfg;
      this._rid = 0;
      const S = {
        t: 0, done: false, pool: C.tot, inf: 0,
        pq: [], ri: 0, dri: 0, comp: [],
        pfR: [], pfQ: [], pfB: [], pfOut: [],
        nodeSeen: Array.from({ length: C.pfN }, () => new Map()), // LRU: prefix group -> last-use tick (finite cap)
        nodeLoad: Array.from({ length: C.pfN }, () => 0),
        dg: [], router: C.router in ROUTERS ? C.router : 'round_robin',
      };
      for (let ni = 0; ni < C.pfN; ni++) {
        S.pfR.push(Array.from({ length: C.pfDP }, () => ({ s: 'FETCH', run: [], con: 0, ce: 0 })));
        S.pfQ.push(Array.from({ length: C.pfDP }, () => []));
        S.pfB.push({ sc: 0, ec: 0, bt: 0, cs: 0, rate: 0 });
        S.pfOut.push(Array.from({ length: C.pfDP }, () => []));
      }
      for (let i = 0; i < C.dcN; i++) S.dg.push({ rk: Array.from({ length: C.dcDP }, () => []), ls: 0, idle: true, rate: 0 });
      this._s = S;
      this._t = { pBM: 0, pTM: 0, pU: 0, pT: 0, dAM: 0, dTM: 0, dUS: 0, dTS: 0, cc: 0, lS: 0, tS: 0, pfTok: 0, dcTok: 0, hits: 0, savedTok: 0 };
      const burst = Math.min(C.conc, S.pool);
      for (let i = 0; i < burst; i++) { S.pq.push(this._mkReq()); S.pool--; S.inf++; }
    }

    _onComp(r) {
      const S = this._s, T = this._t;
      T.cc++; T.lS += r.de - r.ct; T.tS += r.ft - r.ct;
      S.comp.push(r); S.inf--;
      if (S.pool > 0) { S.pq.push(this._mkReq()); S.pool--; S.inf++; }
      if (S.inf === 0 && S.pool === 0) S.done = true;
    }

    // Route one request to a prefill node (by algorithm) + a decode rank (round-robin).
    _route(req) {
      const C = this.cfg, S = this._s, T = this._t;
      const ni = ROUTERS[S.router]({ pfN: C.pfN, counter: S.ri, req, nodeSeen: S.nodeSeen, nodeLoad: S.nodeLoad }) % C.pfN;
      // Prefix cache (finite, LRU per node): hit only if this node still holds the group's prefix.
      // Sticky routers (cache_aware/hash) keep few groups per node → high hit; scatter routers thrash it.
      const lru = S.nodeSeen[ni], cap = Math.max(1, C.cacheCap | 0);
      req.hit = lru.has(req.grp) ? C.prefixRatio : 0;
      lru.delete(req.grp); lru.set(req.grp, S.t);       // refresh recency
      while (lru.size > cap) { const oldest = lru.keys().next().value; lru.delete(oldest); } // evict LRU
      // Spread within the node's DP ranks by least-loaded.
      let ri = 0, best = Infinity;
      for (let r = 0; r < C.pfDP; r++) { const l = S.pfQ[ni][r].length; if (l < best) { best = l; ri = r; } }
      S.pfQ[ni][ri].push(req);
      S.nodeLoad[ni]++;
      S.ri++;
      const totalDcRanks = C.dcN * C.dcDP;
      const dfi = S.dri % totalDcRanks;
      req.dcNi = (dfi / C.dcDP) | 0; req.dcRi = dfi % C.dcDP; S.dri++;
    }

    tick(dt) {
      const C = this.cfg, S = this._s, T = this._t;
      if (S.done) return;
      S.t += dt;
      while (S.pq.length > 0) this._route(S.pq.shift());

      for (let ni = 0; ni < C.pfN; ni++) {
        const bar = S.pfB[ni];
        for (let ri = 0; ri < C.pfDP; ri++) {
          const rk = S.pfR[ni][ri];
          if (rk.s === 'FETCH') {
            const q = S.pfQ[ni][ri];
            for (let i = rk.run.length - 1; i >= 0; i--) {
              if (rk.run[i].rem <= 0) {
                const req = rk.run[i].r;
                const realT = req.isl / C.pfTPS * 1000;
                S.pfOut[ni][ri].push({ r: req, te: S.t + realT * C.txP });
                rk.run.splice(i, 1); S.nodeLoad[ni] = Math.max(0, S.nodeLoad[ni] - 1);
              }
            }
            while (rk.run.length < C.pfMR && q.length > 0) {
              const req = q.shift();
              req.ps = S.t;
              const eff = Math.round(req.isl * (1 - req.hit)); // prefix-cache reduces prefill tokens
              if (req.hit > 0) { T.hits++; T.savedTok += req.isl - eff; }
              rk.run.push({ r: req, rem: eff });
            }
            let budget = C.chk; rk.con = 0;
            for (const item of rk.run) { if (budget <= 0) break; const take = Math.min(item.rem, budget); item.take = take; budget -= take; rk.con += take; }
            rk.s = 'START_WAIT'; bar.sc++;
          }
          if (rk.s === 'COMPUTING' && S.t >= rk.ce) { rk.s = 'END_WAIT'; bar.ec++; }
        }
        if (bar.sc === C.pfDP) {
          const cons = S.pfR[ni].map(r => r.con);
          const mx = Math.max(0, ...cons), sumC = cons.reduce((a, b) => a + b, 0);
          bar.bt = mx > 0 ? Math.max(20, mx / C.pfTPS * 1000) : 0; bar.cs = S.t; bar.sc = 0;
          bar.rate = (mx > 0 && bar.bt > 0) ? sumC * 1000 / bar.bt : 0;
          if (mx > 0) { T.pU += sumC; T.pT += mx * C.pfDP; }
          for (const rk of S.pfR[ni]) { rk.ce = S.t + bar.bt; rk.s = bar.bt > 0 ? 'COMPUTING' : 'END_WAIT'; }
          if (bar.bt === 0) bar.ec = C.pfDP;
        }
        if (bar.ec === C.pfDP) {
          bar.ec = 0;
          for (const rk of S.pfR[ni]) { for (const item of rk.run) { item.rem -= (item.take || 0); item.take = 0; } rk.s = 'FETCH'; }
        }
      }

      for (let ni = 0; ni < C.pfN; ni++) for (let ri = 0; ri < C.pfDP; ri++) {
        const oq = S.pfOut[ni][ri];
        while (oq.length > 0 && S.t >= oq[0].te) {
          const req = oq[0].r;
          if (S.dg[req.dcNi].rk[req.dcRi].length < C.mrr) { oq.shift(); req.pe = S.t; req.ds = S.t; req.ot = 0; S.dg[req.dcNi].rk[req.dcRi].push(req); }
          else break;
        }
      }

      for (const g of S.dg) {
        let mrc = 0; for (const rk of g.rk) if (rk.length > mrc) mrc = rk.length;
        if (mrc === 0) { g.idle = true; g.ls = S.t; g.rate = 0; continue; }
        if (g.idle) { g.ls = S.t; g.idle = false; }
        let tp = Math.max(C.mt, C.tpot * mrc / C.mrr), safe = 0;
        while (S.t - g.ls >= tp && safe < 500) {
          safe++; g.ls += tp;
          let sum = 0; for (const rk of g.rk) sum += rk.length;
          T.dUS += sum; T.dTS += mrc * C.dcDP; T.dcTok += sum;
          g.rate = tp > 0 ? sum * 1000 / tp : 0;
          for (let ri = 0; ri < g.rk.length; ri++) for (let j = g.rk[ri].length - 1; j >= 0; j--) {
            const req = g.rk[ri][j]; req.ot++;
            if (req.ot === 1) { req.ft = g.ls; T.pfTok += req.isl; }
            if (req.ot >= req.osl) { req.de = g.ls; this._onComp(req); g.rk[ri].splice(j, 1); }
          }
          mrc = 0; for (const rk of g.rk) if (rk.length > mrc) mrc = rk.length;
          if (mrc === 0) { g.idle = true; break; }
          tp = Math.max(C.mt, C.tpot * mrc / C.mrr);
        }
      }

      for (let ni = 0; ni < C.pfN; ni++) for (let ri = 0; ri < C.pfDP; ri++) {
        T.pTM += dt;
        if (S.pfR[ni][ri].s === 'COMPUTING' && S.pfR[ni][ri].run.some(it => it.take > 0)) T.pBM += dt;
      }
      for (const g of S.dg) { let tot = 0; for (const rk of g.rk) tot += rk.length; T.dAM += tot * dt; T.dTM += C.dcDP * C.mrr * dt; }
    }

    // Headless: run to completion, return Pareto-style metrics.
    runToEnd(maxSteps = 200000) {
      const step = 50; let n = 0;
      while (!this._s.done && n < maxSteps) { this.tick(step); n++; }
      return this.metrics();
    }

    metrics() {
      const C = this.cfg, S = this._s, T = this._t;
      const comp = S.comp;
      if (!comp.length) return null;
      // per-request TPOT (ms) = decode span / (osl-1)
      const tpots = comp.filter(r => r.osl > 1).map(r => (r.de - r.ft) / (r.osl - 1));
      const ttfts = comp.map(r => r.ft - r.ct);
      const e2es = comp.map(r => r.de - r.ct).sort((a, b) => a - b);
      const avgTpot = tpots.reduce((a, b) => a + b, 0) / (tpots.length || 1);
      const firstSend = comp.reduce((m, r) => Math.min(m, r.ct), Infinity);
      const lastEnd = comp.reduce((m, r) => Math.max(m, r.de), -Infinity);
      const e2eCost = (lastEnd - firstSend) / 1000 || 1;
      const sumOSL = comp.reduce((s, r) => s + r.osl, 0);
      const totalGPU = C.pfN * C.pfTP + C.dcN * C.dcTP;
      const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
      const sTt = [...ttfts].sort((a, b) => a - b), sTp = [...tpots].sort((a, b) => a - b);
      return {
        router: S.router, conc: C.conc,
        interactivity: 1000 / (avgTpot || 1),        // tok/s/user
        tputPerGpu: sumOSL / e2eCost / totalGPU,      // output tok/s/gpu
        tputTotal: sumOSL / e2eCost,
        ttftMs: sTt[Math.floor(sTt.length * .5)] || 0,
        tpotMs: avgTpot,
        ttft: { p50: pct(sTt, .5), p90: pct(sTt, .9), p99: pct(sTt, .99) },
        tpot: { p50: pct(sTp, .5), p90: pct(sTp, .9), p99: pct(sTp, .99) },
        e2eP50: pct(e2es, .5) / 1000, e2eP99: pct(e2es, .99) / 1000,
        cacheHitRate: T.cc ? T.hits / T.cc : 0,
        pfBubble: T.pT > 0 ? (1 - T.pU / T.pT) : 0,
        dcUtil: T.dTM > 0 ? T.dAM / T.dTM : 0,
        completed: T.cc, gpus: totalGPU,
      };
    }
  }

  global.RouterPDSimulator = RouterPDSimulator;
  global.RouterPDSimulator.VERSION = SIM_VERSION;
  global.RouterPDSimulator.ROUTERS = Object.keys(ROUTERS);
})(typeof window !== 'undefined' ? window : globalThis);
