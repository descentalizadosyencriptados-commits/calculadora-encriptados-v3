
// ══ MATH ══
const sq = x => Math.sqrt(Math.max(0, x));

function calcL(amtA, amtB, p, plo, phi) {
  // amtA = token A (volatile), amtB = token B (quote)
  // price = amtB per amtA
  if (p <= plo || p >= phi) return 0;
  const sp=sq(p), sl=sq(plo), sh=sq(phi);
  const Lx = amtA * sp * sh / (sh - sp);
  const Ly = amtB / (sp - sl);
  return Math.min(Lx, Ly);
}

function amountsAt(L, p, plo, phi) {
  const sp=sq(p), sl=sq(plo), sh=sq(phi);
  if (p <= plo) return { a: L*(sh-sl)/(sl*sh), b: 0 };           // 100% token A
  if (p >= phi) return { a: 0,                 b: L*(sh-sl) };    // 100% token B
  return { a: L*(sh-sp)/(sp*sh), b: L*(sp-sl) };
}

// Value in USD: a_usd = amtA * priceInUSD_A, b_usd = amtB * priceInUSD_B
// For single-quote pairs (A/USDC), priceA_usd = pNow, priceB_usd = 1
// For volatile pairs (ETH/BTC), we track in terms of token B value
// Strategy: always express "recovery target" in token B units
// This makes it universal — recovery = same token B value as initial deposit

// Solve P_HIGH such that when price = phi, exit value in B = target
// Exit: 100% token B → L*(sqrt(phi)-sqrt(plo)) = targetB
// → sqrt(phi) = targetB/L + sqrt(plo) → phi = (targetB/L + sqrt(plo))²
function solvePhiForTargetB(L, plo, targetB) {
  if (L <= 0 || targetB <= 0) return null;
  const v = targetB / L + sq(plo);
  return v * v;
}

// Given total capital in B-units at pNow, open position with plo fixed
// all token A (convert everything to A at pNow, since we exited below)
// amtA_total = total_B / pNow  (all capital as token A)
// Then L = amtA * sqrt(plo) * sqrt(phi) / (sqrt(phi) - sqrt(plo))
// And exit_B = L*(sqrt(phi)-sqrt(plo)) = amtA * sqrt(plo) * sqrt(phi)
// For exit_B = targetB:
//   amtA_total * sqrt(plo) * sqrt(phi) = targetB
//   sqrt(phi) = targetB / (amtA_total * sqrt(plo))
//   phi = [targetB / (amtA_total * sqrt(plo))]²
function solvePhiFullA(amtA_total, plo, targetB) {
  if (amtA_total <= 0 || plo <= 0 || targetB <= 0) return null;
  const v = targetB / (amtA_total * sq(plo));
  return v * v;
}

function calcLfullA(amtA, plo, phi) {
  // position opened 100% token A at exactly plo
  const sl = sq(plo), sh = sq(phi);
  if (sh <= sl) return 0;
  return amtA * sl * sh / (sh - sl);
}

// ══ FORMAT ══
const f$ = (n, d=2, sym='$') => {
  if (isNaN(n) || n === null || n === undefined) return '—';
  const neg=n<0, a=Math.abs(n);
  const s = a>=1e9?(a/1e9).toFixed(2)+'B':a>=1e6?(a/1e6).toFixed(2)+'M':
            a>=1000?a.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):a.toFixed(d);
  return (neg?'-':'') + sym + s;
};
const fT = (n, sym, d=4) => {
  if (isNaN(n)||n===null) return '—';
  const neg=n<0,a=Math.abs(n);
  return (neg?'-':'')+a.toFixed(d)+' '+sym;
};
const fp  = n => (n>=0?'+':'') + (n*100).toFixed(2) + '%';
const fd$ = (n,d=2) => (n>=0?'+':'-') + '$' + Math.abs(n).toFixed(d);
const cls = n => n >= 0 ? 'green' : 'red';
const g   = id => document.getElementById(id);

// ══ STATE ══
let S = {};
let history = []; // array of rebalance snapshots

function tokA()  { return 'ETH'; }
function tokB()  { return 'USDC'; }

function calcLfromCapital(capitalB, p, plo, phi) {
  if (capitalB <= 0 || p <= plo || p >= phi || plo <= 0 || phi <= plo) return 0;
  const sp = sq(p), sl = sq(plo), sh = sq(phi);
  const denom = 2*sp - sl - sp*sp/sh;
  return denom > 0 ? capitalB / denom : 0;
}

function onInput() {
  const capital = +g('iCapital').value || 0;
  const p0 = +g('iP0').value || 1;
  const plo = +g('iPLo').value || 1;
  const phi = +g('iPHi').value || 1;
  const initB = capital;
  g('dInitVal').textContent = f$(initB, 2, '$');
  const halfW = p0 > 0 ? (phi - plo) / (2 * p0) * 100 : 0;
  g('dWidth').textContent = halfW > 0 ? '±' + halfW.toFixed(1) + '%' : '—';

  const L0 = calcLfromCapital(initB, p0, plo, phi);
  if (L0 > 0) {
    const startAmounts = amountsAt(L0, p0, plo, phi);
    g('initSummary').textContent =
      `≈ ${fT(startAmounts.a, tokA())} + ${f$(startAmounts.b, 2, '')} ${tokB()} @ ${fmtP(p0)}`;
  } else {
    g('initSummary').textContent = 'Ingresá Capital y rango válidos; el precio de entrada debe quedar dentro de P_LOW y P_HIGH.';
  }
}

function updateSlider(el) {
  const pct = (+el.min + (+el.value - +el.min));
  const range = +el.max - +el.min;
  const filled = ((+el.value - +el.min) / range * 100).toFixed(1);
  el.style.setProperty('--pct', filled + '%');
  g('injectPctLbl').textContent = el.value + '% extra';
}

function run() {
  const capital = +g('iCapital').value;
  const p0 = +g('iP0').value;
  const plo0 = +g('iPLo').value;
  const phi0 = +g('iPHi').value;
  const pNow = +g('iPNow').value;
  const injectPct = +g('injectPct').value/100;
  if (!capital || !p0 || !plo0 || !phi0 || plo0 >= phi0 || pNow <= 0 || p0 <= plo0 || p0 >= phi0) return;
  onInput();

  const initB = capital;
  const L0 = calcLfromCapital(initB, p0, plo0, phi0);
  if (!L0) return;

  const initial = amountsAt(L0, p0, plo0, phi0);
  const amtA0 = initial.a;
  const amtB0 = initial.b;

  // What we have after price moved
  const cur = amountsAt(L0, pNow, plo0, phi0);
  const curA = cur.a;
  const curB_raw = cur.b;
  const curB = curB_raw;
  const curVal_B = curA*pNow + curB;

  const exitedLow  = pNow <= plo0;
  const exitedHigh = pNow >= phi0;
  const inRange    = !exitedLow && !exitedHigh;

  // ── STRATEGY A: no injection ──
  // Convert everything to token A at current price
  // (since if exited low → 100% A already; fees in B → convert to A)
  const A_totalA = curA + curB / pNow;  // all capital as token A
  const A_plo = exitedHigh ? pNow * 0.995 : pNow * 1.005;
  // Recovery target = initB (original capital in token B)
  const A_phi    = solvePhiFullA(A_totalA, A_plo, initB);
  if (!A_phi || A_phi <= A_plo) {
    g('panelA').innerHTML='<div class="empty"><span>⚠️</span>No se puede calcular P_HIGH para este escenario. Verificá los valores.</div>';
    return;
  }
  const A_L      = calcLfullA(A_totalA, A_plo, A_phi);
  const A_exitB  = A_L * (sq(A_phi) - sq(A_plo));
  const A_width  = (A_phi - A_plo) / A_plo * 100;
  const A_pnl    = A_exitB - initB;

  // ── STRATEGY B: buy more token A ──
  // Buy injectPct more token A at current price
  const B_extraA    = curA * injectPct;
  const B_cost_B    = B_extraA * pNow;        // cost in token B
  const B_totalA    = curA + B_extraA;
  const B_totalA_all = B_totalA + curB / pNow;
  const B_plo       = A_plo; // same P_LOW
  // Recovery target B = initB + B_cost_B  (recover EVERYTHING: initial + injected)
  const B_targetB   = initB + B_cost_B;
  const B_phi       = solvePhiFullA(B_totalA_all, B_plo, B_targetB);
  if (!B_phi || B_phi <= B_plo) {
    g('panelB').innerHTML='<div class="empty"><span>⚠️</span>No se puede calcular. Ajustá el % de inyección.</div>';
    return;
  }
  const B_L         = calcLfullA(B_totalA_all, B_plo, B_phi);
  const B_exitB     = B_L * (sq(B_phi) - sq(B_plo));
  const B_width     = (B_phi - B_plo) / B_plo * 100;
  const B_pnl       = B_exitB - B_targetB;    // should be ≈0 by construction
  const B_pnl_net   = B_exitB - initB;         // vs original capital only

  // Preview
  g('injectPreview').innerHTML =
    `Comprás <strong class="green">${fT(B_extraA, tokA())}</strong> = <strong>${f$(B_cost_B,2,'')} ${tokB()}</strong> al precio ${f$(pNow,2,'')} ${tokB()}/${tokA()} · Total ${tokA()} en posición: <strong class="cyan">${fT(B_totalA_all, tokA())}</strong>`;

  S = {
    capital: initB,
    p0, plo0, phi0, pNow, injectPct,
    amtA0, amtB0,
    initB, L0, curA, curB, curVal_B,
    exitedLow, exitedHigh, inRange,
    A_plo, A_phi, A_L, A_totalA, A_exitB, A_width, A_pnl,
    B_extraA, B_cost_B, B_totalA_all, B_plo, B_phi, B_L,
    B_exitB, B_width, B_pnl, B_pnl_net, B_targetB,
    tA: tokA(), tB: tokB(),
  };

  renderAll();
}

// ── RANGE VIZ ──
function makeRangeViz(pNow, plo, phi, pinColor) {
  const minP = Math.min(pNow, plo) * 0.85;
  const maxP = Math.max(pNow, phi) * 1.10;
  const span = maxP - minP;
  const px   = p => ((p-minP)/span*100).toFixed(2)+'%';
  const inR  = pNow>=plo && pNow<=phi;
  const fill = inR
    ? 'linear-gradient(90deg,rgba(0,240,128,.3),rgba(0,207,255,.3))'
    : 'linear-gradient(90deg,rgba(255,176,32,.25),rgba(0,207,255,.2))';
  const nowLbl = pNow <= plo ? 'actual (entrará)' : 'actual';
  return `<div class="rviz">
    <div class="rtrack">
      <div class="rfill" style="left:${px(plo)};width:${((phi-plo)/span*100).toFixed(2)}%;background:${fill};"></div>
      <div class="rpin" style="left:${px(pNow)};background:${pinColor};color:${pinColor};"></div>
      <span class="rtick" style="left:${px(plo)}">${fmtP(plo)}</span>
      <span class="rtick" style="left:${px(phi)}">${fmtP(phi)}</span>
      <span class="rtick" style="left:${px(pNow)};color:${pinColor};font-weight:700;">${nowLbl}</span>
    </div>
    <div class="rlabels">
      <span>P_LOW <strong class="amber">${fmtP(plo)}</strong></span>
      <span class="txt2" style="font-size:8px;">P_NOW <strong style="color:var(--txt)">${fmtP(pNow)}</strong></span>
      <span>P_HIGH <strong style="color:${pinColor}">${fmtP(phi)}</strong></span>
    </div>
  </div>`;
}

function fmtP(p) {
  // smart formatting for price
  if (p >= 1000) return '$'+p.toLocaleString('en-US',{maximumFractionDigits:0});
  if (p >= 1)    return '$'+p.toFixed(2);
  return '$'+p.toFixed(6);
}

function renderAll() {
  const s = S;
  if (!s.initB) return;

  // Status
  let narr, pill, hdrCls, hdrTxt;
  const sym = s.tB === 'USDC'||s.tB==='DAI'||s.tB==='USDT' ? '$' : '';
  if (s.exitedLow) {
    narr = `El precio cayó a <strong class="red">${fmtP(s.pNow)}</strong>, bajo P_LOW (<strong>${fmtP(s.plo0)}</strong>). Pool salió por abajo → tenés <strong class="cyan">${fT(s.curA, s.tA)}</strong> + <strong class="gold">${fT(s.curB, s.tB)}</strong> (fees). Rango inactivo.`;
    pill = `<span class="pill pill-r"><span class="dot"></span>SALIDA INFERIOR → 100% ${s.tA}</span>`;
    hdrCls='pill pill-r'; hdrTxt='PRECIO CAÍDO';
  } else if (s.exitedHigh) {
    narr = `El precio subió a <strong class="amber">${fmtP(s.pNow)}</strong>, sobre P_HIGH (<strong>${fmtP(s.phi0)}</strong>). Pool salió por arriba → tenés <strong class="gold">${fT(s.curB, s.tB)}</strong> puro. Rango inactivo.`;
    pill = `<span class="pill pill-a"><span class="dot"></span>SALIDA SUPERIOR → 100% ${s.tB}</span>`;
    hdrCls='pill pill-a'; hdrTxt='PRECIO SUBIÓ';
  } else {
    narr = `El precio está en <strong class="green">${fmtP(s.pNow)}</strong>, dentro del rango <strong>${fmtP(s.plo0)}–${fmtP(s.phi0)}</strong>. Pool activo.`;
    pill = `<span class="pill pill-g"><span class="dot"></span>EN RANGO</span>`;
    hdrCls='pill pill-g'; hdrTxt='EN RANGO';
  }
  g('sitNarr').innerHTML = narr;
  g('sitPill').innerHTML = pill;
  const hp = g('hdrPill');
  hp.className = hdrCls; hp.innerHTML = '<span class="dot"></span>'+hdrTxt;

  // ── PANEL A ──
  g('panelA').innerHTML = `
    <div style="font-size:9px;color:var(--txt2);line-height:1.8;margin-bottom:10px;
      background:var(--bg2);border:1px solid var(--line);border-radius:7px;padding:10px 12px;">
      Convertís todo a <strong class="cyan">${s.tA}</strong>: 
      ${fT(s.curA, s.tA)} + ${fT(s.curB, s.tB)} ÷ ${fmtP(s.pNow)} = 
      <strong class="cyan">${fT(s.A_totalA, s.tA)} total</strong>. 
      Ponés P_LOW justo sobre el precio actual. La herramienta calcula el P_HIGH exacto para recuperar 
      <strong class="gold">${fT(s.initB, s.tB)}</strong>.
    </div>

    ${makeRangeViz(s.pNow, s.A_plo, s.A_phi, 'var(--amber)')}

    <div class="answer ans-amber">
      <div class="answer-ttl" style="color:var(--amber);">📐 P_HIGH necesario para recuperar capital inicial</div>
      <div class="answer-big amber">${fmtP(s.A_phi)}</div>
      <div class="answer-sub">
        Cuando el precio llegue a <strong>${fmtP(s.A_phi)}</strong> tu pool sale 100% ${s.tB} con 
        <strong>${fT(s.A_exitB, s.tB)}</strong> — igual a tu capital original 
        <strong>${fT(s.initB, s.tB)}</strong>.
      </div>
    </div>

    <div class="sg">
      <div class="st"><div class="slb">P_LOW (entrada)</div>
        <div class="svl amber">${fmtP(s.A_plo)}</div>
        <div class="ssb">${s.exitedLow?'justo sobre precio actual':s.exitedHigh?'justo bajo precio actual':'en rango'}</div></div>
      <div class="st"><div class="slb">P_HIGH (objetivo)</div>
        <div class="svl green">${fmtP(s.A_phi)}</div>
        <div class="ssb">sale aquí = capital recuperado</div></div>
      <div class="st"><div class="slb">Amplitud del rango</div>
        <div class="svl cyan">${s.A_width.toFixed(1)}%</div>
        <div class="ssb">desde P_LOW hasta P_HIGH</div></div>
      <div class="st"><div class="slb">${s.tA} en posición</div>
        <div class="svl cyan">${s.A_totalA.toFixed(4)}</div>
        <div class="ssb">sin comprar más</div></div>
    </div>

    <div class="sg">
      <div class="st"><div class="slb">Liquidez L</div>
        <div class="svl cyan">${s.A_L.toFixed(4)}</div>
        <div class="ssb">vs L₀ = ${s.L0.toFixed(4)}</div></div>
      <div class="st"><div class="slb">${s.tB} al salir por P_HIGH</div>
        <div class="svl green">${fT(s.A_exitB, s.tB, 2)}</div>
        <div class="ssb">= capital inicial ✓</div></div>
    </div>

    <div class="gline"></div>
    <div style="font-size:9px;">
      <div class="sumrow"><span class="sumk">Capital invertido total</span><span class="sumv gold">${fT(s.initB, s.tB, 2)}</span></div>
      <div class="sumrow"><span class="sumk">Inyección extra</span><span class="sumv txt2">—</span></div>
      <div class="sumrow"><span class="sumk">${s.tB} al salir por P_HIGH</span><span class="sumv green">${fT(s.A_exitB, s.tB, 2)}</span></div>
      <div class="sumrow"><span class="sumk">Ganancia / Pérdida</span>
        <span class="sumv ${cls(s.A_pnl)}">${fd$(s.A_pnl)} (${fp(s.A_pnl/s.initB)})</span></div>
    </div>

    <div style="margin-top:10px;display:flex;gap:8px;">
      <button class="btn btn-ghost" style="font-size:9px;flex:1;" onclick="addToHistory('A')">
        ＋ Guardar como rebalanceo
      </button>
    </div>
  `;

  // ── PANEL B ──
  g('panelB').innerHTML = `
    <div style="font-size:9px;color:var(--txt2);line-height:1.8;margin-bottom:10px;
      background:var(--bg2);border:1px solid var(--line);border-radius:7px;padding:10px 12px;">
      Comprás <strong class="green">${fT(s.B_extraA, s.tA)}</strong> más al precio caído 
      (<strong class="amber">${fT(s.B_cost_B, s.tB, 2)}</strong>). Con más ${s.tA} total, 
      el rango puede ser <strong>más estrecho</strong>. Target de salida: 
      <strong class="gold">${fT(s.B_targetB, s.tB, 2)}</strong> (inicial + inyectado).
    </div>

    <div class="ibox">
      <div class="ib-ttl" style="color:var(--green);">💉 Operación de compra</div>
      <div class="irow">
        <div class="itok"><div class="itok-sym">${s.tA} actual</div>
          <div class="itok-val cyan">${s.curA.toFixed(4)}</div>
          <div class="itok-usd">${fT(s.curA*s.pNow, s.tB, 2)}</div></div>
        <div class="iop">+</div>
        <div class="itok" style="border-color:var(--green2);">
          <div class="itok-sym">comprar ${s.tA}</div>
          <div class="itok-val green">${s.B_extraA.toFixed(4)}</div>
          <div class="itok-usd">${fT(s.B_cost_B, s.tB, 2)}</div></div>
        <div class="iop">=</div>
        <div class="itok" style="border-color:var(--gold2);">
          <div class="itok-sym">total ${s.tA}</div>
          <div class="itok-val gold">${s.B_totalA_all.toFixed(4)}</div>
          <div class="itok-usd">${fT(s.B_totalA_all*s.pNow, s.tB, 2)}</div></div>
      </div>
    </div>

    ${makeRangeViz(s.pNow, s.B_plo, s.B_phi, 'var(--green)')}

    <div class="answer ans-green">
      <div class="answer-ttl" style="color:var(--green);">📐 P_HIGH con rango más estrecho</div>
      <div class="answer-big green">${fmtP(s.B_phi)}</div>
      <div class="answer-sub">
        Con más ${s.tA}, P_HIGH es <strong>${fmtP(s.A_phi - s.B_phi)}</strong> más bajo que Estrategia A. 
        Rango <strong>${s.B_width.toFixed(1)}%</strong> vs <strong>${s.A_width.toFixed(1)}%</strong>. 
        Salís con <strong>${fT(s.B_exitB, s.tB, 2)}</strong> = inicial + inyectado ✓
      </div>
    </div>

    <div class="sg">
      <div class="st"><div class="slb">P_LOW</div>
        <div class="svl amber">${fmtP(s.B_plo)}</div></div>
      <div class="st"><div class="slb">P_HIGH (objetivo)</div>
        <div class="svl green">${fmtP(s.B_phi)}</div>
        <div class="ssb">${fmtP(s.A_phi-s.B_phi)} menos que A</div></div>
      <div class="st"><div class="slb">Amplitud del rango</div>
        <div class="svl cyan">${s.B_width.toFixed(1)}%</div>
        <div class="ssb">más estrecho = más fees</div></div>
      <div class="st"><div class="slb">Liquidez L</div>
        <div class="svl cyan">${s.B_L.toFixed(4)}</div>
        <div class="ssb">vs A: ${s.A_L.toFixed(4)}</div></div>
    </div>

    <div class="gline"></div>
    <div style="font-size:9px;">
      <div class="sumrow"><span class="sumk">Capital inicial</span><span class="sumv gold">${fT(s.initB, s.tB, 2)}</span></div>
      <div class="sumrow"><span class="sumk">${s.tA} extra comprado</span><span class="sumv green">${fT(s.B_extraA, s.tA)} = ${fT(s.B_cost_B, s.tB, 2)}</span></div>
      <div class="sumrow"><span class="sumk">Total a recuperar</span><span class="sumv amber">${fT(s.B_targetB, s.tB, 2)}</span></div>
      <div class="sumrow"><span class="sumk">${s.tB} al salir por P_HIGH</span><span class="sumv green">${fT(s.B_exitB, s.tB, 2)}</span></div>
      <div class="sumrow"><span class="sumk">Ganancia neta vs inicial</span>
        <span class="sumv ${cls(s.B_pnl_net)}">${fd$(s.B_pnl_net)} (${fp(s.B_pnl_net/s.initB)})</span></div>
    </div>

    <div style="margin-top:10px;display:flex;gap:8px;">
      <button class="btn btn-green" style="font-size:9px;flex:1;" onclick="addToHistory('B')">
        ＋ Guardar como rebalanceo
      </button>
    </div>
  `;

  // ── COMPARATIVA ──
  const diffPhi   = s.A_phi - s.B_phi;
  const diffWidth = s.A_width - s.B_width;

  g('compareSection').innerHTML = `
    <div class="verdict">
      <div>
        <div class="vm">
          Estrategia B tiene P_HIGH <span class="green">${fmtP(diffPhi)} más bajo</span> — 
          llega al objetivo antes y farmea con rango más estrecho
        </div>
        <div class="vs">
          A: P_HIGH = <strong class="amber">${fmtP(s.A_phi)}</strong> · 
          Amplitud = <strong>${s.A_width.toFixed(1)}%</strong>
          &nbsp;|&nbsp;
          B: P_HIGH = <strong class="green">${fmtP(s.B_phi)}</strong> · 
          Amplitud = <strong>${s.B_width.toFixed(1)}%</strong>
          &nbsp;(${diffWidth.toFixed(1)}% más estrecho)
        </div>
      </div>
      <div>
        <div class="vn-lbl">P_HIGH más bajo por</div>
        <div class="vn-val green">${fmtP(diffPhi)}</div>
      </div>
    </div>

    <div class="card">
      <div class="ch">
        <div class="ci ci-g">⚖</div>
        <div class="ct">Comparativa al salir por P_HIGH de cada estrategia</div>
      </div>
      <div style="overflow-x:auto;">
        <table class="ctable">
          <thead>
            <tr>
              <th>Concepto</th>
              <th style="text-align:right;color:var(--amber);">A — Sin inyección</th>
              <th style="text-align:right;color:var(--green);">B — Con inyección (${+g('injectPct').value}% extra)</th>
              <th style="text-align:right;">Ventaja B</th>
            </tr>
          </thead>
          <tbody>
            ${tr('Capital inicial',         fT(s.initB,s.tB,2),               fT(s.initB,s.tB,2),             '—')}
            ${tr(s.tA+' extra comprado',   '—',                                fT(s.B_extraA,s.tA)+'= '+fT(s.B_cost_B,s.tB,2), `<span class="amber">+${fT(s.B_cost_B,s.tB,2)}</span>`)}
            ${tr('Total a recuperar',       fT(s.initB,s.tB,2),                fT(s.B_targetB,s.tB,2),         `<span class="amber">+${fT(s.B_cost_B,s.tB,2)}</span>`)}
            ${tr(s.tA+' en posición',       fT(s.A_totalA,s.tA),               fT(s.B_totalA_all,s.tA),        `<span class="green">+${fT(s.B_extraA,s.tA)}</span>`)}
            ${tr('P_LOW',                   fmtP(s.A_plo),                     fmtP(s.B_plo),                  'igual')}
            ${tr('P_HIGH calculado',        `<strong class="amber">${fmtP(s.A_phi)}</strong>`, `<strong class="green">${fmtP(s.B_phi)}</strong>`, `<span class="green">−${fmtP(diffPhi)} más bajo</span>`)}
            ${tr('Amplitud del rango',      s.A_width.toFixed(1)+'%',          s.B_width.toFixed(1)+'%',       `<span class="green">−${diffWidth.toFixed(1)}% (más estrecho)</span>`)}
            ${tr('Liquidez L',              s.A_L.toFixed(4),                  s.B_L.toFixed(4),               `<span class="${cls(s.B_L-s.A_L)}">${s.B_L>s.A_L?'+':''}${(s.B_L-s.A_L).toFixed(4)}</span>`)}
            ${tr(s.tB+' al salir',          `<strong class="green">${fT(s.A_exitB,s.tB,2)}</strong>`,`<strong class="green">${fT(s.B_exitB,s.tB,2)}</strong>`,'—')}
            ${tr('Ganancia neta vs inicial',`<span class="${cls(s.A_pnl)}">${fd$(s.A_pnl)} (${fp(s.A_pnl/s.initB)})</span>`,`<span class="${cls(s.B_pnl_net)}">${fd$(s.B_pnl_net)} (${fp(s.B_pnl_net/s.initB)})</span>`,'—')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  g('predictSection').innerHTML = makePredictSection(s);
}

function predictStep(plo) {
  if (plo < 2500) return 100;
  if (plo < 5000) return 200;
  return 300;
}

function makePredictSection(s) {
  const step = predictStep(s.plo0);
  const scenarios = [];
  for (let i = 1; i <= 4; i++) {
    const price = s.plo0 - step * i;
    if (price <= 0) break;
    scenarios.push(makePredictScenario(s, price, i, step));
  }
  if (!scenarios.length) {
    return `<div class="card"><div class="empty"><span>📉</span>No hay escenarios de caída disponibles para el rango actual.</div></div>`;
  }
  const rows = scenarios.map(row => `
      <tr>
        <td><strong>${row.label}</strong><div class="sub">Caída de ${f$(row.diff,0,'')} respecto a P_LOW</div></td>
        <td><strong>${fmtP(row.A_phi)}</strong><div class="sub">P_HIGH break-even</div></td>
        <td><strong>${f$(row.B_inject,2,'')}</strong><div class="sub">USD a inyectar</div></td>
        <td><strong>${fmtP(row.B_plo)} → ${fmtP(row.B_phi)}</strong><div class="sub">Mismo ancho % que el rango original</div></td>
      </tr>`).join('');
  return `
    <div class="card predict-card">
      <div class="predict-header">
        <div>
          <div class="predict-title">Proyección Predictiva Automatizada</div>
          <div class="predict-sub">Escenarios de caída por tramos de ${f$(step,0,'')} ${s.tB} bajo P_LOW.</div>
        </div>
        <div class="predict-badge">Estrategias A / B</div>
      </div>
      <div style="overflow-x:auto;">
        <table class="predict-table">
          <thead>
            <tr>
              <th>Escenario</th>
              <th>P_HIGH Sin inyección</th>
              <th>Inyección USD</th>
              <th>Nuevos límites</th>
            </tr>
          </thead>
          <tbody>${rows}
          </tbody>
        </table>
      </div>
    </div>`;
}

function makePredictScenario(s, price, index, step) {
  const raw = amountsAt(s.L0, price, s.plo0, s.phi0);
  const curA = raw.a;
  const curB = raw.b;
  const totalA = curA + (curB / price || 0);
  const A_phi = solvePhiFullA(totalA, price, s.initB);
  const widthRatio = (s.phi0 - s.plo0) / s.plo0;
  const B_plo = price;
  const B_phi = price * (1 + widthRatio);
  const neededA = s.initB / (Math.sqrt(price) * Math.sqrt(B_phi));
  const B_inject = Math.max(0, (neededA - totalA) * price);
  return {
    label: `${index}° tramo: ${fmtP(price)} (${step>0?'-'+f$(step*index,0,''):''})`,
    diff: s.plo0 - price,
    A_phi: A_phi || 0,
    B_inject,
    B_plo,
    B_phi,
    widthRatio,
    totalA,
  };
}

function tr(label, a, b, d='—') {
  return `<tr>
    <td class="ck">${label}</td>
    <td class="cv">${a}</td>
    <td class="cv">${b}</td>
    <td class="cd">${d}</td>
  </tr>`;
}

// ── HISTORY ──
function addToHistory(which) {
  if (!S.initB) return;
  const snap = {
    n: history.length+1,
    which,
    capital: S.initB,
    pNow: S.pNow,
    plo:  which==='A' ? S.A_plo : S.B_plo,
    phi:  which==='A' ? S.A_phi : S.B_phi,
    L:    which==='A' ? S.A_L   : S.B_L,
    exitB: which==='A' ? S.A_exitB : S.B_exitB,
    totalA: which==='A' ? S.A_totalA : S.B_totalA_all,
    injected: which==='B' ? S.B_cost_B : 0,
    target: which==='A' ? S.initB : S.B_targetB,
    width: which==='A' ? S.A_width : S.B_width,
    tA: S.tA, tB: S.tB,
  };
  history.push(snap);
  renderHistory();
}

function renderHistory() {
  if (history.length === 0) {
    g('histSection').innerHTML = `<div style="background:var(--bg1);border:1px dashed var(--line2);border-radius:10px;
      padding:12px 16px;font-size:9px;color:var(--txt3);text-align:center;margin-bottom:16px;">
      Los rebalanceos que simules aparecerán aquí. Podés encadenar múltiples rebalanceos.
    </div>`;
    return;
  }
  let html = '<div class="history">';
  history.forEach((h, i) => {
    const color = h.which==='A' ? 'var(--amber)' : 'var(--green)';
    const label = h.which==='A' ? 'Sin inyección' : 'Con inyección';
    html += `<div class="hist-item" onclick="loadSnapshot(${i})">
      <div class="hist-n">#${h.n} — ${label}</div>
      <div class="hist-v" style="color:${color};">P_HIGH = ${fmtP(h.phi)}</div>
      <div class="hist-s">${fmtP(h.plo)} → ${fmtP(h.phi)} · ${h.width.toFixed(1)}%</div>
      <div class="hist-s" style="color:var(--txt3);">Entrada a ${fmtP(h.pNow)}</div>
    </div>`;
  });
  html += `<div class="hist-item" style="cursor:pointer;border-color:var(--red2);color:var(--red);" onclick="clearHistory()">
    <div class="hist-n">LIMPIAR</div>
    <div style="font-size:18px;text-align:center;">🗑</div>
  </div>`;
  html += '</div>';
  g('histSection').innerHTML = html;
}

function loadSnapshot(i) {
  const h = history[i];
  g('iCapital').value = h.capital;
  g('iP0').value = h.pNow;
  g('iPLo').value = h.plo.toFixed(4);
  g('iPHi').value = h.phi.toFixed(4);
  g('iPNow').value = h.pNow;
  onInput();
  run();
  window.scrollTo({top:0,behavior:'smooth'});
}

function clearHistory() { history=[]; renderHistory(); }

function reset() {
  [['iCapital',5000],['iP0',2500],['iPLo',2000],['iPHi',3000],
   ['iPNow',1500],['injectPct',50]].forEach(([id,v])=>g(id).value=v);
  history=[];
  updateSlider(g('injectPct'));
  onInput(); run();
}

// init
updateSlider(g('injectPct'));
onInput();
run();

