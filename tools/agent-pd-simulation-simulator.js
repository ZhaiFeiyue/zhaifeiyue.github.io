// Agent PD Disaggregation Simulator - pure simulation engine, no DOM.
// Models multi-turn agent sessions with prefetch vs recompute decisions,
// KV offload/reload between turns, and tiered memory (HBM/DRAM/SSD).

(function(global){
const SIM_VERSION = '0.1.0';

class AgentPDSimulator {
  constructor(config) {
    this.cfg = { ...config };
    this._rid = 0;
    this._sid = 0;
    this._events = [];
    this.reset();
  }

  get state() { return this._s; }
  get stats() { return this._t; }
  get config() { return this.cfg; }

  setConfig(config) {
    this.cfg = { ...config };
    this.reset();
  }

  drainEvents() {
    const ev = this._events;
    this._events = [];
    return ev;
  }

  _emit(type, data) {
    this._events.push({ t: this._s.t, type, ...data });
  }

  _mkSession() {
    const C = this.cfg;
    const nTurns = Math.max(1, Math.round(C.nTurns * (0.8 + Math.random() * 0.4)));
    return {
      id: this._sid++,
      turns: nTurns,
      curTurn: 0,
      isl0: Math.round(C.isl * (C.rng + Math.random() * (1 - C.rng))),
      osl: Math.round(C.osl * (C.rng + Math.random() * (1 - C.rng))),
      accTokens: 0,
      pfWorker: -1,
      offloadedTokens: 0,
      offloadTier: 'none',
    };
  }

  _mkReq(session) {
    const C = this.cfg;
    const turn = session.curTurn;
    const islGrowth = turn * session.osl;
    const totalInput = session.isl0 + islGrowth;
    const localCached = turn === 0 ? 0 :
      (session.pfWorker >= 0 ? Math.min(session.accTokens, totalInput) : 0);
    const offloadedAvail = session.offloadedTokens;
    const newTokens = totalInput - localCached;

    return {
      id: this._rid++,
      sid: session.id,
      turn,
      isl: totalInput,
      osl: session.osl,
      newTokens,
      localCached,
      offloadedAvail,
      umbpMatched: 0,
      prefetchTokens: 0,
      recomputeTokens: 0,
      decision: 'pending',
      ct: this._s.t,
      ps: 0, pe: 0, pfDone: 0,
      fetchStart: 0, fetchEnd: 0,
      ds: 0, de: 0, ft: 0, ot: 0,
      dcNi: 0, dcRi: 0,
      pfNi: -1,
    };
  }

  reset() {
    const C = this.cfg;
    this._rid = 0;
    this._sid = 0;
    this._events = [];

    const S = {
      t: 0, pau: false, done: false,
      pool: C.totSessions, inf: 0,
      pq: [], ri: 0, dri: 0,
      sessions: new Map(),
      toolWait: [],
      comp: [],
      pfR: [], pfQ: [], pfB: [], pfOut: [],
      dg: [],
      tiers: { hbm: 0, dram: 0, ssd: 0 },
    };

    for (let ni = 0; ni < C.pfN; ni++) {
      S.pfR.push(Array.from({ length: C.pfDP }, () => ({
        s: 'FETCH', run: [], con: 0, ce: 0
      })));
      S.pfQ.push(Array.from({ length: C.pfDP }, () => []));
      S.pfB.push({ sc: 0, ec: 0, bt: 0, cs: 0 });
      S.pfOut.push(Array.from({ length: C.pfDP }, () => []));
    }

    for (let i = 0; i < C.dcN; i++) {
      S.dg.push({ rk: Array.from({ length: C.dcDP }, () => []), ls: 0, idle: true });
    }

    this._s = S;
    this._t = {
      pBM: 0, pTM: 0, pU: 0, pT: 0,
      dAM: 0, dTM: 0, dUS: 0, dTS: 0,
      cc: 0, sc: 0, lS: 0, tS: 0,
      pfTok: 0, dcTok: 0,
      prefetchCount: 0, recomputeCount: 0,
      prefetchTokensTotal: 0, recomputeTokensTotal: 0,
      prefetchTimeTotal: 0, recomputeTimeTotal: 0,
      offloadCount: 0, reloadCount: 0,
      offloadBytes: 0, reloadBytes: 0,
      turnCount: 0,
      tierHist: [],
    };

    const burst = Math.min(C.conc, S.pool);
    for (let i = 0; i < burst; i++) {
      const sess = this._mkSession();
      S.sessions.set(sess.id, sess);
      const req = this._mkReq(sess);
      S.pq.push(req);
      S.pool--;
      S.inf++;
      this._emit('session_start', { sid: sess.id });
    }
  }

  _prefetchDecision(req) {
    const C = this.cfg;
    const kvBytesPerTok = C.kvBytesPerToken;
    const fetchableTokens = Math.min(req.newTokens, req.umbpMatched);
    if (fetchableTokens < C.prefetchThreshold) return 'recompute';

    const tFetch = C.tFixedUmbp + fetchableTokens * kvBytesPerTok / (C.bwUmbp * 1e9);
    const tRecompute = fetchableTokens * C.flopsPerToken / (C.gpuThroughput * 1e12);

    if (tFetch * 1000 < tRecompute * 1000) {
      req.prefetchTokens = fetchableTokens;
      req.recomputeTokens = req.newTokens - fetchableTokens;
      return 'prefetch';
    }
    return 'recompute';
  }

  _calcPrefetchTime(nTokens) {
    const C = this.cfg;
    return C.tFixedUmbp + nTokens * C.kvBytesPerToken / (C.bwUmbp * 1e9) * 1000;
  }

  _calcPrefillTime(nTokens) {
    const C = this.cfg;
    if (nTokens <= 0) return 1;
    return Math.max(1, nTokens / C.pfTPS * 1000);
  }

  _onTurnComplete(req) {
    const S = this._s, T = this._t, C = this.cfg;
    T.turnCount++;
    const sess = S.sessions.get(req.sid);
    if (!sess) return;

    sess.accTokens = req.isl + req.osl;
    sess.curTurn++;

    this._emit('turn_complete', {
      sid: sess.id, turn: req.turn,
      ttft: req.ft - req.ct,
      decision: req.decision,
    });

    if (sess.curTurn >= sess.turns) {
      T.sc++;
      T.cc++;
      T.lS += req.de - sess.ct0;
      T.tS += req.ft - req.ct;
      S.inf--;
      S.sessions.delete(sess.id);
      this._emit('session_complete', { sid: sess.id, turns: sess.curTurn });

      if (S.pool > 0) {
        const newSess = this._mkSession();
        newSess.ct0 = S.t;
        S.sessions.set(newSess.id, newSess);
        const newReq = this._mkReq(newSess);
        S.pq.push(newReq);
        S.pool--;
        S.inf++;
        this._emit('session_start', { sid: newSess.id });
      }
      if (S.inf === 0 && S.pool === 0) S.done = true;
    } else {
      const offloadTokens = Math.round(sess.accTokens * C.offloadRatio);
      if (offloadTokens > 0 && C.bwOffload > 0) {
        const offloadTime = offloadTokens * C.kvBytesPerToken / (C.bwOffload * 1e9) * 1000;
        sess.offloadedTokens = offloadTokens;
        sess.offloadTier = 'dram';
        T.offloadCount++;
        T.offloadBytes += offloadTokens * C.kvBytesPerToken;
        S.tiers.dram += offloadTokens;
        this._emit('offload_start', {
          sid: sess.id, tokens: offloadTokens,
          duration: offloadTime,
        });
      }

      S.toolWait.push({
        sid: sess.id,
        readyAt: S.t + C.zPause,
      });
      this._emit('tool_call_start', { sid: sess.id, duration: C.zPause });
    }
  }

  tick(dt) {
    const C = this.cfg, S = this._s, T = this._t;
    if (S.done) return;
    S.t += dt;

    // === Tool-call wait → next turn ===
    for (let i = S.toolWait.length - 1; i >= 0; i--) {
      const tw = S.toolWait[i];
      if (S.t >= tw.readyAt) {
        const sess = S.sessions.get(tw.sid);
        if (sess) {
          const req = this._mkReq(sess);
          S.pq.push(req);
          this._emit('tool_call_end', { sid: sess.id });
        }
        S.toolWait.splice(i, 1);
      }
    }

    // === Router: assign PF + DC rank, make prefetch decision ===
    const totalPfRanks = C.pfN * C.pfDP;
    const totalDcRanks = C.dcN * C.dcDP;

    while (S.pq.length > 0) {
      const req = S.pq.shift();
      const sess = S.sessions.get(req.sid);

      const pfi = S.ri % totalPfRanks;
      const pfNi = Math.floor(pfi / C.pfDP);
      const pfRi = pfi % C.pfDP;
      req.pfNi = pfNi;
      S.ri++;

      const dfi = S.dri % totalDcRanks;
      req.dcNi = Math.floor(dfi / C.dcDP);
      req.dcRi = dfi % C.dcDP;
      S.dri++;

      if (sess && sess.pfWorker >= 0 && req.turn > 0) {
        req.pfNi = sess.pfWorker;
      }

      const remoteCacheTokens = req.turn > 0 ?
        Math.round(req.isl * C.umbpHitRate) : 0;
      req.umbpMatched = remoteCacheTokens;

      const decision = this._prefetchDecision(req);
      req.decision = decision;

      if (decision === 'prefetch') {
        T.prefetchCount++;
        T.prefetchTokensTotal += req.prefetchTokens;
        req.recomputeTokens = req.newTokens - req.prefetchTokens;
        const fetchTime = this._calcPrefetchTime(req.prefetchTokens);
        req.fetchStart = S.t;
        req.fetchEnd = S.t + fetchTime;
        T.prefetchTimeTotal += fetchTime;
        this._emit('prefetch_start', {
          rid: req.id, sid: req.sid, tokens: req.prefetchTokens,
          duration: fetchTime, pfNi: req.pfNi,
        });
      } else {
        T.recomputeCount++;
        req.recomputeTokens = req.newTokens;
        T.recomputeTokensTotal += req.newTokens;
      }

      if (sess) sess.pfWorker = req.pfNi;
      S.pfQ[req.pfNi][pfRi].push(req);
      req.ps = S.t;

      this._emit('req_routed', {
        rid: req.id, sid: req.sid, turn: req.turn,
        decision, pfNi: req.pfNi,
        dcNi: req.dcNi, dcRi: req.dcRi,
      });
    }

    // === Prefill Rank Actors (chunked, with prefetch wait) ===
    for (let ni = 0; ni < C.pfN; ni++) {
      const bar = S.pfB[ni];
      for (let ri = 0; ri < C.pfDP; ri++) {
        const rk = S.pfR[ni][ri];

        if (rk.s === 'FETCH') {
          const q = S.pfQ[ni][ri];
          for (let i = rk.run.length - 1; i >= 0; i--) {
            if (rk.run[i].rem <= 0) {
              const req = rk.run[i].r;
              const realT = this._calcPrefillTime(req.isl);
              S.pfOut[ni][ri].push({ r: req, te: S.t + realT * C.txP });
              rk.run.splice(i, 1);
              this._emit('kv_transfer_start', {
                rid: req.id, sid: req.sid,
                pfNi: ni, dcNi: req.dcNi,
                duration: realT * C.txP,
              });
            }
          }

          while (rk.run.length < C.pfMR && q.length > 0) {
            const req = q[0];
            if (req.decision === 'prefetch' && S.t < req.fetchEnd) break;
            q.shift();
            req.ps = S.t;

            const computeTokens = req.decision === 'prefetch' ?
              req.recomputeTokens : req.newTokens;
            const localHit = req.localCached;
            const effectiveNew = Math.max(0, req.isl - localHit -
              (req.decision === 'prefetch' ? req.prefetchTokens : 0));

            rk.run.push({ r: req, rem: effectiveNew });

            if (req.decision === 'prefetch') {
              this._emit('prefetch_complete', {
                rid: req.id, tokens: req.prefetchTokens,
              });
            }
          }

          let budget = C.chk;
          rk.con = 0;
          for (const item of rk.run) {
            if (budget <= 0) break;
            const take = Math.min(item.rem, budget);
            item.take = take;
            budget -= take;
            rk.con += take;
          }
          rk.s = 'START_WAIT';
          bar.sc++;
        }

        if (rk.s === 'COMPUTING' && S.t >= rk.ce) {
          rk.s = 'END_WAIT';
          bar.ec++;
        }
      }

      if (bar.sc === C.pfDP) {
        const cons = S.pfR[ni].map(r => r.con);
        const mx = Math.max(0, ...cons);
        const sumC = cons.reduce((a, b) => a + b, 0);
        bar.bt = mx > 0 ? Math.max(1, mx / C.pfTPS * 1000) : 0;
        bar.cs = S.t;
        bar.sc = 0;
        bar.rate = (mx > 0 && bar.bt > 0) ? sumC * 1000 / bar.bt : 0;
        if (mx > 0) { T.pU += sumC; T.pT += mx * C.pfDP; }
        for (const rk of S.pfR[ni]) {
          rk.ce = S.t + bar.bt;
          rk.s = bar.bt > 0 ? 'COMPUTING' : 'END_WAIT';
        }
        if (bar.bt === 0) bar.ec = C.pfDP;
      }

      if (bar.ec === C.pfDP) {
        bar.ec = 0;
        for (const rk of S.pfR[ni]) {
          for (const item of rk.run) { item.rem -= (item.take || 0); item.take = 0; }
          rk.s = 'FETCH';
        }
      }
    }

    // === KV Transfer Actor ===
    for (let ni = 0; ni < C.pfN; ni++) {
      for (let ri = 0; ri < C.pfDP; ri++) {
        const oq = S.pfOut[ni][ri];
        while (oq.length > 0 && S.t >= oq[0].te) {
          const req = oq[0].r;
          if (S.dg[req.dcNi].rk[req.dcRi].length < C.mrr) {
            oq.shift();
            req.pe = S.t;
            req.ds = S.t;
            req.ot = 0;
            S.dg[req.dcNi].rk[req.dcRi].push(req);
            this._emit('kv_transfer_complete', {
              rid: req.id, dcNi: req.dcNi,
            });
          } else break;
        }
      }
    }

    // === Decode Node Actors ===
    for (const g of S.dg) {
      let mrc = 0;
      for (const rk of g.rk) if (rk.length > mrc) mrc = rk.length;
      if (mrc === 0) { g.idle = true; g.ls = S.t; g.rate = 0; continue; }
      if (g.idle) { g.ls = S.t; g.idle = false; }

      let tp = Math.max(C.mt, C.tpot * mrc / C.mrr);
      let safe = 0;
      while (S.t - g.ls >= tp && safe < 500) {
        safe++;
        g.ls += tp;
        let sum = 0;
        for (const rk of g.rk) sum += rk.length;
        T.dUS += sum;
        T.dTS += mrc * C.dcDP;
        T.dcTok += sum;
        g.rate = tp > 0 ? sum * 1000 / tp : 0;

        for (let ri = 0; ri < g.rk.length; ri++) {
          for (let j = g.rk[ri].length - 1; j >= 0; j--) {
            const req = g.rk[ri][j];
            req.ot++;
            if (req.ot === 1) {
              req.ft = g.ls;
              T.pfTok += req.isl;
              this._emit('first_token', {
                rid: req.id, sid: req.sid, turn: req.turn,
                ttft: req.ft - req.ct,
              });
            }
            if (req.ot >= req.osl) {
              req.de = g.ls;
              this._onTurnComplete(req);
              g.rk[ri].splice(j, 1);
            }
          }
        }

        mrc = 0;
        for (const rk of g.rk) if (rk.length > mrc) mrc = rk.length;
        if (mrc === 0) { g.idle = true; break; }
        tp = Math.max(C.mt, C.tpot * mrc / C.mrr);
      }
    }

    // === Stats accumulators ===
    for (let ni = 0; ni < C.pfN; ni++) {
      for (let ri = 0; ri < C.pfDP; ri++) {
        T.pTM += dt;
        if (S.pfR[ni][ri].s === 'COMPUTING' &&
            S.pfR[ni][ri].run.some(it => it.take > 0)) T.pBM += dt;
      }
    }
    for (const g of S.dg) {
      let tot = 0;
      for (const rk of g.rk) tot += rk.length;
      T.dAM += tot * dt;
      T.dTM += C.dcDP * C.mrr * dt;
    }

    // Tier snapshot
    S.tiers.hbm = 0;
    S.tiers.dram = 0;
    for (const [, sess] of S.sessions) {
      S.tiers.hbm += sess.accTokens - sess.offloadedTokens;
      S.tiers.dram += sess.offloadedTokens;
    }
  }
}

global.AgentPDSimulator = AgentPDSimulator;
global.AgentPDSimulator.VERSION = SIM_VERSION;
})(typeof window !== 'undefined' ? window : globalThis);
