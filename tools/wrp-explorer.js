"use strict";
/* WRP 2025 Data Explorer — columnar microdata + live PROJWT-weighted aggregation.
   Loads wrp_explorer.json (catalogue + manifest) and wrp_explorer.bin(.gz). */

const $ = s => document.querySelector(s);
const WRP = { very:'#e3076e', somewhat:'#00a7b3', not:'#00785c', dk:'#bdbdbd', refused:'#0d2240' };
const HEAT1 = ['#ffffff', '#e3076e'];          // metric_1 magenta scale
const HEAT2 = ['#eef1f4', '#0d2240'];          // metric_2 navy scale
const MAP_RAMP = ['#fbe0ec', '#e3076e', '#5c0b3a', '#0d2240']; // fuchsia → ink

let MAN, N, WEIGHT, STORE = {}, DIM = {}, Q = {}, M = {}, COUNTRIES = [], CREGION = null, CINCOME = null;
let ROWS = null; // current passing row indices (null = all)
const filters = {};           // dimKey -> Set(codes)
const ctrl = { question:'climate', breakdown1:'countrynew', breakdown2:'countrynew',
               metric1:'climate_very', metric2:'climate_other_very', right:'climate_other', sort:'metric1',
               profileScope:'all', k:4, colourBy:'cluster', clusterBy:'worry' };
let activeView = 'dist';

/* ---------- wave switching (loads a different manifest in-tool) ---------- */
const WAVES = {
  '2019':   { manifest:'data/wrp_explorer_2019.json',    bin:'data/wrp_explorer_2019.bin',    binGz:'data/wrp_explorer_2019.bin.gz',    label:'2019',  eyebrow:'World Risk Poll 2019',  lede:'Explore the 2019 World Risk Poll — worry, experienced harm and the greatest perceived source of risk. Filter by demographics, break the figures down, rank, map and compare. All figures are population-weighted.' },
  '2021':   { manifest:'data/wrp_explorer_2021.json',    bin:'data/wrp_explorer_2021.bin',    binGz:'data/wrp_explorer_2021.bin.gz',    label:'2021',  eyebrow:'World Risk Poll 2021',  lede:'Explore the 2021 World Risk Poll across worry, experienced harm, disaster resilience, trust and discrimination. Filter by demographics, break the figures down, rank, map and compare. All figures are population-weighted.' },
  '2023':   { manifest:'data/wrp_explorer_2023.json',    bin:'data/wrp_explorer_2023.bin',    binGz:'data/wrp_explorer_2023.bin.gz',    label:'2023',  eyebrow:'World Risk Poll 2023',  lede:'Explore the 2023 World Risk Poll across worry, experienced harm, disaster resilience, trust and discrimination. Filter by demographics, break the figures down, rank, map and compare. All figures are population-weighted.' },
  '2025':   { manifest:'data/wrp_explorer.json',         bin:'data/wrp_explorer.bin',         binGz:'data/wrp_explorer.bin.gz',         label:'2025',  eyebrow:'World Risk Poll 2025',  lede:'Explore the 2025 World Risk Poll across every theme — worry, experienced harm, disaster resilience, trust and discrimination. Filter by demographics, break the figures down, rank, map and compare. All figures are population-weighted.' },
  'trended':{ manifest:'data/wrp_explorer_trended.json', bin:'data/wrp_explorer_trended.bin', binGz:'data/wrp_explorer_trended.bin.gz', label:'2019–2025', eyebrow:'World Risk Poll — Trends', lede:'Cross-wave view: every respondent from 2019, 2021, 2023 and 2025 in a single dataset. Use the survey-year filter or breakdown to see how worry, experienced harm and resilience have moved over time. All figures are population-weighted.' },
  // "dataset" isn't a wave — it's a meta-view showing per-country coverage
  // across every wave. We special-case its load below: no manifest fetch.
  'dataset':{ manifest:null, label:'Datasets', eyebrow:'World Risk Poll — Dataset details', lede:'Country-level coverage across every wave of the World Risk Poll: how many respondents were surveyed in each country in each wave, and what each wave projects to in population terms.' },
};
function currentWave(){ const p=new URLSearchParams(location.search).get('wave'); return WAVES[p] ? p : '2025'; }
let WAVE = currentWave();
function buildWaveTabs(){
  document.querySelectorAll('#wave-tabs .seg-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.wave === WAVE);
    b.onclick = ()=>{
      const next = b.dataset.wave;
      if(next === WAVE) return;
      // reset transient UI state that may reference vanished slugs / metrics
      Object.keys(filters).forEach(k=>delete filters[k]);
      ROWS = null;
      // update URL and rebuild from the new manifest
      const u = new URL(location.href);
      if(next === '2025') u.searchParams.delete('wave'); else u.searchParams.set('wave', next);
      history.replaceState(null, '', u.toString());
      WAVE = next;
      switchWave();
    };
  });
}
function applyWaveChrome(){
  const w = WAVES[WAVE];
  document.getElementById('hero-eyebrow').textContent = w.eyebrow;
  document.getElementById('hero-lede').textContent = w.lede;
  document.body.classList.toggle('wave-trended', WAVE === 'trended');
  document.body.classList.toggle('wave-dataset', WAVE === 'dataset');
}
const TREND_VIEWS = ['trend-course', 'trend-map'];
const PERWAVE_VIEWS = ['dist','map','rel','sankey','profile','clusters'];
function isTrendView(v){ return TREND_VIEWS.includes(v); }
function defaultViewForWave(){ return WAVE === 'trended' ? 'trend-course' : 'dist'; }

function activeFilterCount(){ return Object.keys(filters).filter(k=>filters[k]&&filters[k].size).length; }
function updateFilterToggle(){ const fp=document.querySelector('.filters'), tf=$('#toggle-filters'); if(!fp||!tf) return;
  const c=fp.classList.contains('collapsed'), n=activeFilterCount();
  tf.textContent = c ? ('Show filters'+(n?` (${n})`:'')+' ▾') : 'Hide filters ▴'; }
let _rt; window.addEventListener('resize', ()=>{ clearTimeout(_rt); _rt=setTimeout(()=>{ if(typeof MAN!=='undefined' && MAN) render(); }, 160); });
// Robust: re-render the active view whenever the available width actually changes
// (window resize, devtools, zoom, layout reflow) — not all of these emit a window 'resize'.
let _lastW = 0;
function observeResize(){
  const m = document.querySelector('main'); if(!m) return; _lastW = m.clientWidth;
  if(!('ResizeObserver' in window)) return;
  let raf; new ResizeObserver(es=>{ const w = es[0].contentRect.width; if(Math.abs(w-_lastW) < 2) return; _lastW = w;
    cancelAnimationFrame(raf); raf = requestAnimationFrame(()=>{ if(MAN) render(); }); }).observe(m);
}

/* ---------- load ---------- */
async function load(){
  try{
    const cfg = WAVES[WAVE];
    applyWaveChrome();
    // The dataset-details view doesn't have a manifest — skip the binary load.
    if(WAVE === 'dataset'){
      $('#status').classList.add('hidden');
      $('#app').classList.remove('hidden');
      activeView = 'dataset';
      document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active', v.id === 'view-dataset'));
      buildWaveTabs();
      renderDataset();
      return;
    }
    document.getElementById('status').classList.remove('hidden');
    document.getElementById('status').classList.remove('err');
    document.getElementById('status').textContent = `Loading World Risk Poll ${cfg.label} data…`;
    // wipe stale state — switching wave must not leak metric/dim keys from another wave
    STORE = {}; DIM = {}; Q = {}; M = {}; COUNTRIES = [];
    MAN = await fetch(cfg.manifest).then(r=>{ if(!r.ok) throw new Error('manifest '+r.status); return r.json(); });
    let buf;
    try{
      const res = await fetch(cfg.binGz);
      if(!res.ok) throw 0;
      if('DecompressionStream' in window){
        const ds = res.body.pipeThrough(new DecompressionStream('gzip'));
        buf = await new Response(ds).arrayBuffer();
      } else { throw 0; }
    }catch(e){
      buf = await fetch(cfg.bin).then(r=>{ if(!r.ok) throw new Error('bin '+r.status); return r.arrayBuffer(); });
    }
    N = MAN.n;
    const view = (c)=>{ const o=c.off, l=c.len;
      if(c.dtype==='i8') return new Int8Array(buf, o, l);
      if(c.dtype==='i16') return new Int16Array(buf.slice(o, o+l*2));
      if(c.dtype==='f32') return new Float32Array(buf.slice(o, o+l*4));
    };
    MAN.columns.forEach(c=> STORE[c.key] = view(c));
    WEIGHT = view(MAN.weight);
    COUNTRIES = MAN.countries;
    CREGION = new Int8Array(COUNTRIES.length).fill(-1); CINCOME = new Int8Array(COUNTRIES.length).fill(-1);
    MAN.dimensions.forEach(d=> DIM[d.key]=d);
    // Resolve region / income-group columns via the manifest's dimension list — the
    // raw column key varies across waves (2025 uses RegionLRF/wbi, others use
    // GlobalRegion/CountryIncomeLevel2023). Skip silently if a wave has neither.
    { const cc=STORE['country'];
      const rg = (DIM['GlobalRegion'] && STORE[DIM['GlobalRegion'].col]) || null;
      const wb = (DIM['CountryIncome'] && STORE[DIM['CountryIncome'].col]) || null;
      if(cc && (rg || wb)){
        for(let i=0;i<N;i++){ const g=cc[i]; if(g<0) continue;
          if(rg && CREGION[g]<0 && rg[i]>0) CREGION[g]=rg[i];
          if(wb && CINCOME[g]<0 && wb[i]>0) CINCOME[g]=wb[i]; } } }
    MAN.questions.forEach(q=> Q[q.key]=q);
    MAN.metrics.forEach(m=> M[m.key]=m);
    // hero stats — update from manifest (was hard-coded for 2025)
    const ctry = document.getElementById('stat-countries');   if(ctry) ctry.textContent = String((MAN.countries||[]).length);
    const resp = document.getElementById('stat-respondents'); if(resp) resp.textContent = N.toLocaleString();
    const note = document.getElementById('wave-note');        if(note) note.textContent = `${(MAN.countries||[]).length} countries · ${N.toLocaleString()} respondents · ${(MAN.questions||[]).length} questions`;
    // make sure ctrl points at something valid for this wave's catalogue
    pickInitialCtrl();
    // and the active view is appropriate for the wave (trended has its own two)
    if(WAVE === 'trended' && !isTrendView(activeView)) activeView = 'trend-course';
    if(WAVE !== 'trended' && (isTrendView(activeView) || activeView === 'dataset')) activeView = 'dist';
    document.querySelectorAll('#view-tabs .seg-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===activeView));
    document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active', v.id === 'view-'+activeView));
    $('#status').classList.add('hidden');
    $('#app').classList.remove('hidden');
    buildFilters(); buildTabs(); buildWaveTabs(); render(); observeResize();
    $('#dl-svg').onclick = dlChartSVG; $('#dl-png').onclick = dlChartPNG; $('#dl-csv').onclick = dlCSV;
  }catch(e){
    const s=$('#status'); s.classList.add('err'); s.classList.remove('hidden');
    s.textContent='Could not load the '+WAVES[WAVE].label+' dataset ('+e.message+'). Run scripts/build_explorer_wave.py and serve the tools folder.';
    $('#app').classList.add('hidden');
    // wave tabs still need to be clickable even on load failure
    buildWaveTabs();
  }
}

/* Re-load everything against the now-current WAVE. Called when user clicks a wave tab. */
async function switchWave(){
  await load();
}

/* When a wave is loaded, the previous ctrl.* slugs may refer to vanished questions
   or metrics. Pick the first available item so views render instead of throwing. */
function pickInitialCtrl(){
  const qkeys = MAN.questions.map(q=>q.key);
  const mkeys = MAN.metrics.map(m=>m.key);
  const dkeys = MAN.dimensions.filter(d=>d.type==='country'||d.cats).map(d=>d.key);
  const pick = (cur, list, fallback) => list.includes(cur) ? cur : (list[0] || fallback);
  ctrl.question   = pick(ctrl.question,   qkeys, 'climate');
  ctrl.right      = pick(ctrl.right,      qkeys, ctrl.question);
  // prefer the climate-very metric when it exists; otherwise the first metric
  const wantedM1 = ['climate_very','climate_concerned','food_very', mkeys[0]];
  ctrl.metric1   = wantedM1.find(k => k && mkeys.includes(k)) || mkeys[0];
  ctrl.metric2   = mkeys.find(k => k !== ctrl.metric1) || ctrl.metric1;
  ctrl.breakdown1 = pick(ctrl.breakdown1, dkeys, 'countrynew');
  ctrl.breakdown2 = pick(ctrl.breakdown2, dkeys, 'countrynew');
  ctrl.profileScope = 'all';
}

/* ---------- hover tooltip (delegated; works for string-built and d3-built SVG) ---------- */
function showTip(main, sub, x, y){ const t=document.getElementById('tip'); if(!t) return;
  t.innerHTML = '<b></b>' + (sub ? '<div class="m"></div>' : '');
  t.querySelector('b').textContent = main || ''; if(sub) t.querySelector('.m').textContent = sub;
  const w = t.offsetWidth || 200; let lx = x + 14; if(lx + w + 10 > window.innerWidth) lx = x - w - 14;
  t.style.left = Math.max(4, lx) + 'px'; t.style.top = (y + 14) + 'px'; t.style.opacity = 1; }
function hideTip(){ const t=document.getElementById('tip'); if(t) t.style.opacity = 0; }
document.addEventListener('mousemove', e=>{ const el = (e.target && e.target.closest) ? e.target.closest('[data-tip]') : null;
  if(el) showTip(el.getAttribute('data-tip'), el.getAttribute('data-sub') || '', e.clientX, e.clientY); else hideTip(); });

/* ---------- helpers ---------- */
const col = k => STORE[k];
function forEachRow(fn){ if(ROWS){ for(let k=0;k<ROWS.length;k++) fn(ROWS[k]); } else { for(let i=0;i<N;i++) fn(i); } }
function computeRows(){
  const active = Object.keys(filters).filter(k=>filters[k] && filters[k].size).map(k=>({arr:col(DIM[k].col), set:filters[k]}));
  if(!active.length){ ROWS=null; return; }
  const out=[]; for(let i=0;i<N;i++){ let ok=true; for(let j=0;j<active.length;j++){ if(!active[j].set.has(active[j].arr[i])){ ok=false; break; } } if(ok) out.push(i); }
  ROWS = Int32Array.from(out);
}
const isMean = m => m.kind==='mean';
function valueFn(m){
  const a = col(m.col);
  if(isMean(m)) return i=>{ const v=a[i]; return v<0?null:v/100; };
  const s = new Set(m.num); return i=>{ const v=a[i]; return v<0?null:(s.has(v)?1:0); };
}
function fmtMetric(m,v){ if(v==null||isNaN(v)) return '–'; return isMean(m)? String(Math.round(v*100)) : v.toFixed(1)+'%'; }

/* group code -> label for a breakdown dim */
function groupLabel(dimKey, code){
  const d=DIM[dimKey];
  if(d.type==='country') return COUNTRIES[code] ? COUNTRIES[code].name : '?';
  const c=(d.cats||[]).find(c=>c.code===code); return c?c.label:String(code);
}

/* per-group metric (returns Map code->value in display units: % or 0-1) */
function metricByGroup(m, dimKey){
  const bd=col(DIM[dimKey].col), w=WEIGHT, agg=new Map();
  if(isMean(m)){ const v=col(m.col);
    forEachRow(i=>{ const x=v[i]; if(x<0) return; const g=bd[i]; if(g<0) return; let e=agg.get(g); if(!e){e=[0,0];agg.set(g,e);} e[0]+=w[i]*(x/100); e[1]+=w[i]; });
    const out=new Map(); agg.forEach((e,g)=>out.set(g, e[1]? e[0]/e[1] : NaN)); return out;
  }
  const q=col(m.col), num=new Set(m.num);
  forEachRow(i=>{ const a=q[i]; if(a<0) return; const g=bd[i]; if(g<0) return; let e=agg.get(g); if(!e){e=[0,0];agg.set(g,e);} e[1]+=w[i]; if(num.has(a)) e[0]+=w[i]; });
  const out=new Map(); agg.forEach((e,g)=>out.set(g, e[1]? e[0]/e[1]*100 : NaN)); return out;
}
/* full answer distribution of a question per group: Map(g -> {total, counts:Map(code->w)}) */
function distribution(qKey, dimKey){
  const q=col(Q[qKey].col), bd=col(DIM[dimKey].col), w=WEIGHT, groups=new Map();
  forEachRow(i=>{ const a=q[i]; if(a<0) return; const g=bd[i]; if(g<0) return;
    let e=groups.get(g); if(!e){e={total:0,counts:new Map()};groups.set(g,e);} e.total+=w[i]; e.counts.set(a,(e.counts.get(a)||0)+w[i]); });
  return groups;
}
/* weighted respondent-level R^2 between two metrics, within current filter */
function r2(m1,m2){
  const f1=valueFn(m1), f2=valueFn(m2), w=WEIGHT;
  let sw=0,sx=0,sy=0,sxx=0,syy=0,sxy=0;
  forEachRow(i=>{ const x=f1(i); if(x==null) return; const y=f2(i); if(y==null) return; const wi=w[i]; sw+=wi; sx+=wi*x; sy+=wi*y; sxx+=wi*x*x; syy+=wi*y*y; sxy+=wi*x*y; });
  if(sw<=0) return NaN; const mx=sx/sw,my=sy/sw, cov=sxy/sw-mx*my, vx=sxx/sw-mx*mx, vy=syy/sw-my*my;
  if(vx<=0||vy<=0) return NaN; const r=cov/Math.sqrt(vx*vy); return r*r;
}
/* weighted joint distribution of two questions (for Sankey + table) */
function crosstab(aKey,bKey){
  const a=col(Q[aKey].col), b=col(Q[bKey].col), w=WEIGHT, m=new Map(); let total=0;
  forEachRow(i=>{ const x=a[i], y=b[i]; if(x<0||y<0) return; const k=x+'|'+y; m.set(k,(m.get(k)||0)+w[i]); total+=w[i]; });
  return {m, total};
}

/* ---------- colour helpers ---------- */
function lerp(a,b,t){ const pa=hx(a),pb=hx(b); return `rgb(${Math.round(pa[0]+(pb[0]-pa[0])*t)},${Math.round(pa[1]+(pb[1]-pa[1])*t)},${Math.round(pa[2]+(pb[2]-pa[2])*t)})`; }
function hx(h){ h=h.replace('#',''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
function rampColor(stops,t){ t=Math.max(0,Math.min(1,t)); const seg=1/(stops.length-1); let i=Math.min(stops.length-2,Math.floor(t/seg)); return lerp(stops[i],stops[i+1],(t-i*seg)/seg); }

/* ---------- UI: filters ---------- */
function buildFilters(){
  const grid=$('#filters-grid'); grid.innerHTML='';
  MAN.dimensions.forEach(d=>{
    const wrap=document.createElement('div'); wrap.className='filt';
    const btn=document.createElement('button'); btn.className='filt-btn'; btn.innerHTML=`<span class="fl">${d.label}</span><span class="fv">All</span>`;
    const pop=document.createElement('div'); pop.className='filt-pop hidden';
    const cats = d.type==='country' ? COUNTRIES.map((c,i)=>({code:i,label:c.name})) : (d.cats||[]);
    cats.forEach(c=>{
      const lab=document.createElement('label'); const cb=document.createElement('input'); cb.type='checkbox'; cb.value=c.code;
      cb.onchange=()=>{ const set=filters[d.key]||(filters[d.key]=new Set()); if(cb.checked) set.add(c.code); else set.delete(c.code); if(!set.size) delete filters[d.key];
        const n=filters[d.key]?filters[d.key].size:0; btn.querySelector('.fv').textContent = n? n+' selected':'All'; btn.classList.toggle('on', !!n);
        computeRows(); render(); };
      lab.appendChild(cb); lab.appendChild(document.createTextNode(' '+c.label)); pop.appendChild(lab);
    });
    btn.onclick=(e)=>{ e.stopPropagation(); document.querySelectorAll('.filt-pop').forEach(p=>{ if(p!==pop) p.classList.add('hidden'); }); pop.classList.toggle('hidden'); };
    wrap.appendChild(btn); wrap.appendChild(pop); grid.appendChild(wrap);
  });
  $('#clear-filters').onclick=()=>{ Object.keys(filters).forEach(k=>delete filters[k]);
    document.querySelectorAll('.filt-pop input').forEach(cb=>cb.checked=false);
    document.querySelectorAll('.filt-btn').forEach(b=>{ b.classList.remove('on'); b.querySelector('.fv').textContent='All'; });
    computeRows(); render(); };
  const fp=document.querySelector('.filters');
  $('#toggle-filters').onclick=()=>{ fp.classList.toggle('collapsed'); updateFilterToggle(); };
  if(window.innerWidth<760) fp.classList.add('collapsed');
  updateFilterToggle();
  document.addEventListener('click', ()=>document.querySelectorAll('.filt-pop').forEach(p=>p.classList.add('hidden')));
}

/* ---------- UI: control bar (per view) ---------- */
function opt(val,label,sel){ return `<option value="${val}"${val===sel?' selected':''}>${label}</option>`; }
function selectField(id,label,options,val){
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}">${options.map(o=>opt(o[0],o[1],val)).join('')}</select></div>`;
}
/* Searchable combobox — for long dropdowns (questions, metrics) where the
   user wants to type a keyword instead of scrolling 80+ items. */
function comboField(id, label, options, val){
  const cur = options.find(o => o[0] === val);
  const optsHTML = options.map(o => `<div class="combo-opt" data-val="${esc(o[0])}">${esc(o[1])}</div>`).join('');
  return `<div class="field">
    <label for="${id}">${label}</label>
    <div class="combo" data-id="${id}">
      <input type="text" class="combo-input" id="${id}" value="${esc(cur ? cur[1] : '')}" data-current="${esc(val)}" placeholder="Type to search…" autocomplete="off" spellcheck="false">
      <div class="combo-list hidden">${optsHTML}</div>
    </div>
  </div>`;
}
function bindCombo(id, onChange){
  const wrap = document.querySelector(`.combo[data-id="${id}"]`); if(!wrap) return;
  const input = wrap.querySelector('.combo-input');
  const list  = wrap.querySelector('.combo-list');
  const opts  = [...list.querySelectorAll('.combo-opt')];
  let activeIdx = -1;
  const open = ()=>{ list.classList.remove('hidden'); };
  const close= ()=>{ list.classList.add('hidden'); activeIdx=-1; };
  const applyFilter = (q)=>{ const needle = (q||'').trim().toLowerCase();
    opts.forEach(o=>{ const m = !needle || o.textContent.toLowerCase().includes(needle); o.classList.toggle('hide', !m); });
    activeIdx = opts.findIndex(o => !o.classList.contains('hide')); highlight(); };
  const highlight = ()=>{ opts.forEach((o,i)=>o.classList.toggle('active', i===activeIdx));
    const a = opts[activeIdx]; if(a){ const r = a.offsetTop; if(r < list.scrollTop || r+a.offsetHeight > list.scrollTop+list.clientHeight) list.scrollTop = r - 20; } };
  const pick = (o)=>{ const v = o.dataset.val; input.value = o.textContent; input.dataset.current = v; close(); onChange(v); };
  // On focus: show ALL options (don't filter by the current label) and select
  // the text so the first keystroke replaces it. Filter only kicks in on input.
  input.addEventListener('focus', ()=>{ input.select(); applyFilter(''); open(); });
  input.addEventListener('input', ()=>{ applyFilter(input.value); open(); });
  input.addEventListener('keydown', e=>{
    if(e.key === 'ArrowDown'){ e.preventDefault(); open();
      for(let i=activeIdx+1; i<opts.length; i++){ if(!opts[i].classList.contains('hide')){ activeIdx=i; break; } } highlight(); }
    else if(e.key === 'ArrowUp'){ e.preventDefault();
      for(let i=activeIdx-1; i>=0; i--){ if(!opts[i].classList.contains('hide')){ activeIdx=i; break; } } highlight(); }
    else if(e.key === 'Enter'){ e.preventDefault(); if(activeIdx>=0) pick(opts[activeIdx]); }
    else if(e.key === 'Escape'){ close(); input.value = (options=>{ const cur = opts.find(o => o.dataset.val === input.dataset.current); return cur ? cur.textContent : ''; })(); }
  });
  opts.forEach(o => o.addEventListener('mousedown', e => { e.preventDefault(); pick(o); }));
  document.addEventListener('mousedown', e=>{ if(!wrap.contains(e.target)) close(); });
}
const qOpts = ()=>MAN.questions.map(q=>[q.key,q.label]);
const mOpts = ()=>MAN.metrics.map(m=>[m.key,m.label]);
const dOpts = ()=>MAN.dimensions.filter(d=>d.type==='country'||d.cats).map(d=>[d.key,d.label]);
function buildControls(){
  const cb=$('#controlbar'); let h='';
  if(activeView==='dist'){
    h+=comboField('c-question','Question',qOpts(),ctrl.question);
    h+=selectField('c-bd1','Breakdown',dOpts(),ctrl.breakdown1);
    h+=comboField('c-m1','Metric 1 (rank / heat)',mOpts(),ctrl.metric1);
    h+=comboField('c-m2','Metric 2',mOpts(),ctrl.metric2);
  } else if(activeView==='map'){
    h+=comboField('c-m1','Metric 1 (map colour)',mOpts(),ctrl.metric1);
    h+=comboField('c-m2','Metric 2',mOpts(),ctrl.metric2);
  } else if(activeView==='rel'){
    h+=comboField('c-m1','Metric 1 (x)',mOpts(),ctrl.metric1);
    h+=comboField('c-m2','Metric 2 (y)',mOpts(),ctrl.metric2);
    h+=selectField('c-bd2','Breakdown',dOpts(),ctrl.breakdown2);
  } else if(activeView==='sankey'){
    h+=comboField('c-question','Question (left)',qOpts(),ctrl.question);
    h+=comboField('c-right','Question (right)',qOpts(),ctrl.right);
  } else if(activeView==='profile'){
    h+=comboField('c-m1','Metric',mOpts(),ctrl.metric1);
    const sp=ctrl.profileScope||'all', o=(v,t)=>`<option value="${v}"${v===sp?' selected':''}>${esc(t)}</option>`,
      og=(label,opts)=>`<optgroup label="${label}">${opts}</optgroup>`;
    const scopeSel = og('Global', o('all','All countries'))
      + og('By income group', (DIM['CountryIncome'].cats||[]).map(c=>o('inc:'+c.code,c.label)).join(''))
      + og('By global region', (DIM['GlobalRegion'].cats||[]).map(c=>o('reg:'+c.code,c.label)).join(''))
      + og('By country', COUNTRIES.map((c,i)=>o('c:'+i,c.name)).join(''));
    h+=`<div class="field"><label for="c-pscope">Scope</label><select id="c-pscope">${scopeSel}</select></div>`;
  } else if(activeView==='clusters'){
    h+=selectField('c-clusterby','Cluster by',[['worry','Worry'],['experience','Experience'],['both','Worry + experience']],ctrl.clusterBy);
    h+=selectField('c-k','Clusters (k)',[['2','2'],['3','3'],['4','4'],['5','5'],['6','6']],String(ctrl.k));
    h+=selectField('c-colour','Colour by',[['cluster','Cluster'],['region','Global region'],['income','Income group']].concat(MAN.metrics.map(m=>['m:'+m.key, m.label])),ctrl.colourBy);
  } else if(activeView==='trend-course'){
    h+=comboField('c-question','Question',qOpts(),ctrl.question);
  } else if(activeView==='trend-map'){
    h+=comboField('c-m1','Metric',mOpts(),ctrl.metric1);
    const years = (DIM['year']||{cats:[]}).cats.map(c=>[String(c.code), c.label]);
    if(!ctrl.tmFromYear || !years.find(y=>y[0]===String(ctrl.tmFromYear))) ctrl.tmFromYear = years[0] ? +years[0][0] : null;
    if(!ctrl.tmToYear   || !years.find(y=>y[0]===String(ctrl.tmToYear)))   ctrl.tmToYear   = years[years.length-1] ? +years[years.length-1][0] : null;
    h+=selectField('c-tm-from','From wave',years,String(ctrl.tmFromYear));
    h+=selectField('c-tm-to',  'To wave',  years,String(ctrl.tmToYear));
  }
  cb.innerHTML=h;
  // Two binders: native <select> uses onchange; the searchable combobox
  // calls a supplied onChange via bindCombo and stores the slug as data-current.
  const bind=(id,key)=>{
    const el=$('#'+id); if(!el) return;
    const combo = el.closest('.combo');
    if(combo){ bindCombo(id, v=>{ ctrl[key]=v; render(); }); }
    else     { el.onchange=()=>{ ctrl[key]=el.value; render(); }; }
  };
  bind('c-question','question'); bind('c-bd1','breakdown1'); bind('c-bd2','breakdown2');
  bind('c-m1','metric1'); bind('c-m2','metric2'); bind('c-right','right');
  const pscope=$('#c-pscope'); if(pscope) pscope.onchange=()=>{ ctrl.profileScope=pscope.value; render(); };
  const kk=$('#c-k'); if(kk) kk.onchange=()=>{ ctrl.k=+kk.value; render(); };
  const colb=$('#c-colour'); if(colb) colb.onchange=()=>{ ctrl.colourBy=colb.value; render(); };
  const clb=$('#c-clusterby'); if(clb) clb.onchange=()=>{ ctrl.clusterBy=clb.value; render(); };
  const tmf=$('#c-tm-from');   if(tmf) tmf.onchange=()=>{ ctrl.tmFromYear=+tmf.value; render(); };
  const tmt=$('#c-tm-to');     if(tmt) tmt.onchange=()=>{ ctrl.tmToYear  =+tmt.value; render(); };
}

/* ---------- UI: tabs ---------- */
function buildTabs(){
  document.querySelectorAll('#view-tabs .seg-btn').forEach(b=>{
    b.onclick=()=>{ activeView=b.dataset.view;
      document.querySelectorAll('#view-tabs .seg-btn').forEach(x=>x.classList.toggle('active',x===b));
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      $('#view-'+activeView).classList.add('active'); render(); };
  });
}

/* ---------- downloads: chart (SVG/PNG) + aggregated data (CSV) ---------- */
let lastExport = null;   // {name, cols, rows} set by each render
function csvNum(m, v){ if(v==null || isNaN(v)) return ''; return isMean(m) ? v.toFixed(3) : v.toFixed(1); }
function toCSV(cols, rows){ const q=v=>{ v=(v==null?'':String(v)); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
  return [cols.map(q).join(','), ...rows.map(r=>r.map(q).join(','))].join('\r\n'); }
function dlBlob(name, blob){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1500); }
function activeSvgEl(){ return document.querySelector({dist:'#dist-chart',map:'#map-svg',rel:'#rel-scatter',sankey:'#sankey-svg',profile:'#profile-svg',clusters:'#cluster-svg','trend-course':'#tc-chart','trend-map':'#tm-svg'}[activeView]); }
function svgSerialized(svg){ const c=svg.cloneNode(true); c.setAttribute('xmlns','http://www.w3.org/2000/svg');
  const w=svg.getAttribute('width'), h=svg.getAttribute('height'); if(!c.getAttribute('viewBox') && w) c.setAttribute('viewBox',`0 0 ${w} ${h}`);
  return '<?xml version="1.0" encoding="UTF-8"?>\n'+new XMLSerializer().serializeToString(c); }
function svgWH(svg){ const vb=(svg.getAttribute('viewBox')||'').split(/[ ,]+/).map(Number); if(vb.length===4 && vb[2]) return [vb[2],vb[3]];
  const r=svg.getBoundingClientRect(); return [Math.max(1,r.width),Math.max(1,r.height)]; }
function baseName(){ return (lastExport && lastExport.name) || ('wrp_'+activeView); }
function dlChartSVG(){ const svg=activeSvgEl(); if(svg) dlBlob(baseName()+'.svg', new Blob([svgSerialized(svg)],{type:'image/svg+xml'})); }
function dlChartPNG(){ const svg=activeSvgEl(); if(!svg) return; const wh=svgWH(svg), scale=2, img=new Image();
  img.onload=()=>{ const cv=document.createElement('canvas'); cv.width=wh[0]*scale; cv.height=wh[1]*scale; const ctx=cv.getContext('2d');
    ctx.setTransform(scale,0,0,scale,0,0); ctx.fillStyle='#fff'; ctx.fillRect(0,0,wh[0],wh[1]); ctx.drawImage(img,0,0); cv.toBlob(b=>dlBlob(baseName()+'.png', b)); };
  img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svgSerialized(svg)); }
function dlCSV(){ if(!lastExport) return; dlBlob(baseName()+'.csv', new Blob(['﻿'+toCSV(lastExport.cols, lastExport.rows)],{type:'text/csv;charset=utf-8'})); }

/* ---------- render dispatch ---------- */
function render(){ buildControls(); updateFilterToggle();
  if(activeView==='dist') renderDist();
  else if(activeView==='map') renderMap();
  else if(activeView==='rel') renderRel();
  else if(activeView==='sankey') renderSankey();
  else if(activeView==='profile') renderProfile();
  else if(activeView==='clusters') renderClusters();
  else if(activeView==='trend-course') renderTrendCourse();
  else if(activeView==='trend-map')    renderTrendMap();
  else if(activeView==='dataset')      renderDataset();
}

/* ---------- View 1: ranked distribution ---------- */
function renderDist(){
  const q=Q[ctrl.question], bd=ctrl.breakdown1, m1=M[ctrl.metric1], m2=M[ctrl.metric2];
  const groups=distribution(ctrl.question, bd);
  const g1=metricByGroup(m1,bd), g2=metricByGroup(m2,bd);
  let keys=[...groups.keys()];
  keys.sort((a,b)=> (g1.get(b)??-1)-(g1.get(a)??-1));
  $('#dist-title').textContent = q.label + ' — by ' + DIM[bd].label;
  const stack = stackOrder(q);
  // legend follows the actual stacking order (top → bottom of bar)
  $('#dist-legend').innerHTML = stack.map(a=>`<span class="k"><span class="sw" style="background:${a.color}"></span>${a.label}</span>`).join('');
  // chart
  const svg=$('#dist-chart'); const H=460, pad={t:8,r:8,b:96,l:34};
  const cw=Math.max(360, (svg.parentElement && svg.parentElement.clientWidth) || 760);
  const barW=Math.max(2, Math.min(56, Math.floor((cw-pad.l-pad.r)/Math.max(1,keys.length))));
  const W=pad.l+pad.r+keys.length*barW; const plotH=H-pad.t-pad.b;
  let s=`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DM Sans, system-ui, sans-serif" xmlns="http://www.w3.org/2000/svg">`;
  for(let p=0;p<=100;p+=25){ const y=pad.t+plotH*(1-p/100); s+=`<line x1="${pad.l}" y1="${y}" x2="${W-pad.r}" y2="${y}" stroke="#e4e4ea"/><text x="${pad.l-6}" y="${y+3}" font-size="10" fill="#6c6c78" text-anchor="end">${p}%</text>`; }
  const labelEvery=Math.ceil(keys.length/45);
  keys.forEach((g,i)=>{ const e=groups.get(g), x=pad.l+i*barW; let cy=pad.t;
    stack.forEach(a=>{ const w=e.counts.get(a.code)||0; const frac=e.total?w/e.total:0; const hh=frac*plotH;
      if(hh>0) s+=`<rect x="${x+0.5}" y="${cy.toFixed(1)}" width="${barW-1}" height="${hh.toFixed(1)}" fill="${a.color}" data-tip="${esc(groupLabel(bd,g))}" data-sub="${esc(a.label)}: ${(frac*100).toFixed(1)}%"/>`; cy+=hh; });
    if(i%labelEvery===0){ const lx=x+barW/2, ly=H-pad.b+10; s+=`<text x="${lx}" y="${ly}" font-size="9" fill="#2a2a35" text-anchor="end" transform="rotate(-55 ${lx} ${ly})">${esc(groupLabel(bd,g).slice(0,18))}</text>`; }
  });
  s+='</svg>'; svg.outerHTML=s.replace('<svg','<svg id="dist-chart"');
  // table
  const max1=Math.max(...keys.map(k=>g1.get(k)||0),0.0001), max2=Math.max(...keys.map(k=>g2.get(k)||0),0.0001);
  let rows=keys.map((g,i)=>{ const v1=g1.get(g), v2=g2.get(g);
    return `<tr><td class="rank">${i+1}</td><td class="name">${esc(groupLabel(bd,g))}</td>`+
      `<td class="num heat" style="background:${rampColor(HEAT1,(v1||0)/max1)};color:${(v1||0)/max1>0.6?'#fff':'#1b222c'}">${fmtMetric(m1,v1)}</td>`+
      `<td class="num heat" style="background:${rampColor(HEAT2,(v2||0)/max2)};color:${(v2||0)/max2>0.5?'#fff':'#1b222c'}">${fmtMetric(m2,v2)}</td></tr>`; }).join('');
  $('#dist-table-card').innerHTML = `<div class="sec-label">Ranking</div><div class="tbl-scroll"><table class="dt"><thead><tr><th class="rank"></th><th>${DIM[bd].label}</th><th class="num">${shortMetric(m1)}</th><th class="num">${shortMetric(m2)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  lastExport = { name:`wrp_${ctrl.question}_by_${bd}`,
    cols:[DIM[bd].label, ...q.answers.map(a=>a.label+' (%)'), m1.key+' (%)', m2.key],
    rows: keys.map(g=>{ const e=groups.get(g); return [groupLabel(bd,g), ...q.answers.map(a=>(e.total?(e.counts.get(a.code)||0)/e.total*100:0).toFixed(1)), csvNum(m1,g1.get(g)), csvNum(m2,g2.get(g))]; }) };
}
const shortMetric = m => m.key;

/* Reorder a question's answers for stacked bars so that:
   - "concern / yes / experienced" answers go at the top  (substantive codes minus the last one)
   - DK / Refused / N/A sit in the MIDDLE                  (codes ≥ 90)
   - "no concern / no / not experienced" goes at the bottom (the last substantive code)
   Stacking is top → bottom, so this puts the worry block above the neutral block
   above the no-worry block, which is what readers actually want to compare. */
function stackOrder(q){
  const subs = (q.answers || []).filter(a => a.code < 90);
  const specials = (q.answers || []).filter(a => a.code >= 90);
  if(subs.length < 2) return q.answers || [];
  const noConcern = subs[subs.length - 1];
  const concern   = subs.slice(0, -1);
  return [...concern, ...specials, noConcern];
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ---------- View 2: map ---------- */
let WORLD=null;
const NUM2A3={"004":"AFG","008":"ALB","012":"DZA","016":"ASM","020":"AND","024":"AGO","028":"ATG","031":"AZE","032":"ARG","036":"AUS","040":"AUT","044":"BHS","048":"BHR","050":"BGD","051":"ARM","052":"BRB","056":"BEL","060":"BMU","064":"BTN","068":"BOL","070":"BIH","072":"BWA","076":"BRA","084":"BLZ","090":"SLB","096":"BRN","100":"BGR","104":"MMR","108":"BDI","112":"BLR","116":"KHM","120":"CMR","124":"CAN","132":"CPV","140":"CAF","144":"LKA","148":"TCD","152":"CHL","156":"CHN","158":"TWN","170":"COL","174":"COM","178":"COG","180":"COD","188":"CRI","191":"HRV","192":"CUB","196":"CYP","203":"CZE","204":"BEN","208":"DNK","214":"DOM","218":"ECU","222":"SLV","226":"GNQ","231":"ETH","232":"ERI","233":"EST","242":"FJI","246":"FIN","250":"FRA","262":"DJI","266":"GAB","268":"GEO","270":"GMB","275":"PSE","276":"DEU","288":"GHA","300":"GRC","304":"GRL","320":"GTM","324":"GIN","328":"GUY","332":"HTI","340":"HND","344":"HKG","348":"HUN","352":"ISL","356":"IND","360":"IDN","364":"IRN","368":"IRQ","372":"IRL","376":"ISR","380":"ITA","384":"CIV","388":"JAM","392":"JPN","398":"KAZ","400":"JOR","404":"KEN","408":"PRK","410":"KOR","414":"KWT","417":"KGZ","418":"LAO","422":"LBN","426":"LSO","428":"LVA","430":"LBR","434":"LBY","440":"LTU","442":"LUX","446":"MAC","450":"MDG","454":"MWI","458":"MYS","462":"MDV","466":"MLI","470":"MLT","478":"MRT","480":"MUS","484":"MEX","496":"MNG","498":"MDA","499":"MNE","504":"MAR","508":"MOZ","512":"OMN","516":"NAM","524":"NPL","528":"NLD","554":"NZL","558":"NIC","562":"NER","566":"NGA","578":"NOR","586":"PAK","591":"PAN","598":"PNG","600":"PRY","604":"PER","608":"PHL","616":"POL","620":"PRT","624":"GNB","626":"TLS","630":"PRI","634":"QAT","642":"ROU","643":"RUS","646":"RWA","682":"SAU","686":"SEN","688":"SRB","694":"SLE","702":"SGP","703":"SVK","704":"VNM","705":"SVN","706":"SOM","710":"ZAF","716":"ZWE","724":"ESP","728":"SSD","729":"SDN","748":"SWZ","752":"SWE","756":"CHE","760":"SYR","762":"TJK","764":"THA","768":"TGO","780":"TTO","784":"ARE","788":"TUN","792":"TUR","795":"TKM","800":"UGA","804":"UKR","807":"MKD","818":"EGY","826":"GBR","834":"TZA","840":"USA","854":"BFA","858":"URY","860":"UZB","862":"VEN","887":"YEM","894":"ZMB"};
const pad3=s=>('00'+String(s)).slice(-3);
async function ensureWorld(){ if(WORLD) return WORLD;
  for(const u of ['https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json','https://unpkg.com/world-atlas@2/countries-110m.json']){
    try{ const t=await fetch(u).then(r=>{if(!r.ok)throw 0;return r.json();}); WORLD=topojson.feature(t,t.objects.countries); return WORLD; }catch(e){} }
  return null;
}
async function renderMap(){
  const m1=M[ctrl.metric1], m2=M[ctrl.metric2];
  const byIdx=metricByGroup(m1,'countrynew');           // country index -> value
  const iso2val=new Map(); byIdx.forEach((v,idx)=>{ const iso=COUNTRIES[idx]&&COUNTRIES[idx].iso3; if(iso) iso2val.set(iso,v); });
  $('#map-title').textContent = (m1.label)+' — by country';
  const world=await ensureWorld(); const svg=d3.select('#map-svg'); svg.selectAll('*').remove();
  if(!world){ svg.append('text').attr('x',360).attr('y',190).attr('text-anchor','middle').attr('fill','#6c6c78').text('Map unavailable (offline)'); }
  else{
    const W=720,H=380, proj=d3.geoNaturalEarth1().fitExtent([[6,6],[W-6,H-6]],{type:'Sphere'}), path=d3.geoPath(proj);
    const vals=[...iso2val.values()].filter(v=>!isNaN(v)); const lo=Math.min(...vals), hi=Math.max(...vals);
    svg.append('path').attr('class','map-sphere').attr('fill','#eef1f4').attr('d',path({type:'Sphere'}));
    svg.selectAll('path.c').data(world.features.filter(f=>pad3(f.id)!=='010')).enter().append('path')
      .attr('d',path).attr('class',f=>{ const iso=NUM2A3[pad3(f.id)]; return iso2val.has(iso)?'map-land':'map-land-nodata'; })
      .attr('fill',f=>{ const iso=NUM2A3[pad3(f.id)]; if(!iso2val.has(iso)) return '#fff'; return rampColor(MAP_RAMP,(iso2val.get(iso)-lo)/(hi-lo||1)); })
      .attr('data-tip', f=> (f.properties&&f.properties.name)||'')
      .attr('data-sub', f=>{ const iso=NUM2A3[pad3(f.id)]; return iso2val.has(iso)? m1.label+': '+fmtMetric(m1,iso2val.get(iso)) : 'No data'; });
    $('#map-legend').innerHTML = `<span>${fmtMetric(m1,lo)}</span><span class="bar" style="background:linear-gradient(to right,${MAP_RAMP.join(',')})"></span><span>${fmtMetric(m1,hi)}</span>`;
  }
  // table (paginated handled simply: scroll)
  const g2=metricByGroup(m2,'countrynew'); let keys=[...byIdx.keys()].sort((a,b)=>(byIdx.get(b)??-1)-(byIdx.get(a)??-1));
  const max1=Math.max(...keys.map(k=>byIdx.get(k)||0),1e-4), max2=Math.max(...keys.map(k=>g2.get(k)||0),1e-4);
  const rows=keys.map((g,i)=>`<tr><td class="rank">${i+1}</td><td class="name">${esc(COUNTRIES[g].name)}</td>`+
     `<td class="num heat" style="background:${rampColor(HEAT1,(byIdx.get(g)||0)/max1)};color:${(byIdx.get(g)||0)/max1>0.6?'#fff':'#1b222c'}">${fmtMetric(m1,byIdx.get(g))}</td>`+
     `<td class="num heat" style="background:${rampColor(HEAT2,(g2.get(g)||0)/max2)};color:${(g2.get(g)||0)/max2>0.5?'#fff':'#1b222c'}">${fmtMetric(m2,g2.get(g))}</td></tr>`).join('');
  $('#map-table-card').innerHTML=`<div class="sec-label">Ranking</div><div class="tbl-scroll"><table class="dt"><thead><tr><th class="rank"></th><th>Country</th><th class="num">${m1.key}</th><th class="num">${m2.key}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  lastExport = { name:`wrp_map_${ctrl.metric1}`, cols:['Country','ISO3', m1.key, m2.key],
    rows: keys.map(g=>[COUNTRIES[g].name, COUNTRIES[g].iso3||'', csvNum(m1,byIdx.get(g)), csvNum(m2,g2.get(g))]) };
}

/* ---------- View 3: relationship ---------- */
function renderRel(){
  const m1=M[ctrl.metric1], m2=M[ctrl.metric2], bd=ctrl.breakdown2;
  const g1=metricByGroup(m1,bd), g2=metricByGroup(m2,bd);
  const pts=[...g1.keys()].filter(g=>g2.has(g)).map(g=>({g,x:g1.get(g),y:g2.get(g)})).filter(p=>!isNaN(p.x)&&!isNaN(p.y));
  $('#rel-title').textContent = `${m1.key} (x) vs ${m2.key} (y) — by ${DIM[bd].label}`;
  const cw=Math.max(420, ($('#rel-scatter').parentElement.clientWidth)||640);
  const W=cw, H=Math.min(460, Math.max(360, Math.round(cw*0.6))), pad={t:14,r:14,b:40,l:46}; const pw=W-pad.l-pad.r, ph=H-pad.t-pad.b;
  const xmax=Math.max(...pts.map(p=>p.x),isMean(m1)?1:100), ymax=Math.max(...pts.map(p=>p.y),isMean(m2)?1:100);
  const X=v=>pad.l+v/xmax*pw, Y=v=>pad.t+ph*(1-v/ymax);
  let s=`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DM Sans,system-ui,sans-serif" xmlns="http://www.w3.org/2000/svg">`;
  for(let t=0;t<=1.0001;t+=0.25){ const gx=X(t*xmax),gy=Y(t*ymax); s+=`<line x1="${pad.l}" y1="${gy}" x2="${W-pad.r}" y2="${gy}" stroke="#eef1f4"/><line x1="${gx}" y1="${pad.t}" x2="${gx}" y2="${H-pad.b}" stroke="#eef1f4"/>`;
    s+=`<text x="${pad.l-6}" y="${gy+3}" font-size="10" fill="#6c6c78" text-anchor="end">${isMean(m2)?Math.round(t*ymax*100):(Math.round(t*ymax))+'%'}</text>`;
    s+=`<text x="${gx}" y="${H-pad.b+14}" font-size="10" fill="#6c6c78" text-anchor="middle">${isMean(m1)?Math.round(t*xmax*100):(Math.round(t*xmax))+'%'}</text>`; }
  // OLS trend on the points
  if(pts.length>1){ const mx=d3.mean(pts,p=>p.x),my=d3.mean(pts,p=>p.y); let sxy=0,sxx=0; pts.forEach(p=>{sxy+=(p.x-mx)*(p.y-my);sxx+=(p.x-mx)**2;}); const b=sxx?sxy/sxx:0,a=my-b*mx;
    s+=`<line class="trend" x1="${X(0)}" y1="${Y(a)}" x2="${X(xmax)}" y2="${Y(a+b*xmax)}"/>`; }
  pts.forEach(p=>{ s+=`<circle class="scatter-pt" cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3.6" fill="#e3076e" fill-opacity="0.7" data-tip="${esc(groupLabel(bd,p.g))}" data-sub="${m1.key}: ${fmtMetric(m1,p.x)} · ${m2.key}: ${fmtMetric(m2,p.y)}"></circle>`; });
  s+=`<text x="${W/2}" y="${H-4}" font-size="10" fill="#6c6c78" text-anchor="middle">${m1.key}</text>`;
  s+='</svg>'; $('#rel-scatter').outerHTML=s.replace('<svg','<svg id="rel-scatter"');
  // R^2 (respondent-level)
  const R=r2(m1,m2); $('#rel-r2').textContent = isNaN(R)?'–':R.toFixed(2);
  $('#rel-explain').innerHTML = `<h4>What is R²</h4><p>R² measures how strongly the two selected metrics move together across <b>individual respondents</b> (0–1). 0.7–1.0 strong · 0.4–0.7 moderate · 0.1–0.4 weak · below 0.1 negligible.</p><h4>Keep in mind</h4><p>It is computed across respondents, not the country averages plotted left. A high R² means the two move together — not that one causes the other.</p>`;
  // odds ratio per group — diverging, log scale around OR = 1 (magenta above, teal below)
  const UP='#e3076e', DOWN='#00a7b3';
  const keys=[...g1.keys()].filter(g=>g2.has(g));
  const odds=keys.map(g=>{ const p1=(g1.get(g)||0)/(isMean(m1)?1:100), p2=(g2.get(g)||0)/(isMean(m2)?1:100);
    const o1=p1/((1-p1)||1e-9), o2=p2/((1-p2)||1e-9); return {g, ratio:(o2>0?o1/o2:NaN), p1,p2}; })
    .filter(o=>o.ratio>0 && isFinite(o.ratio));
  odds.sort((a,b)=>b.ratio-a.ratio);
  const ocw=Math.max(360, ($('#rel-odds').parentElement.clientWidth)||760);
  const OH=340, opad={t:14,r:10,b:66,l:42}; const oph=OH-opad.t-opad.b, mid=opad.t+oph/2;
  const maxAbs=Math.max(0.3, ...odds.map(o=>Math.abs(Math.log(o.ratio))));
  const obw=Math.max(2, Math.min(26, Math.floor((ocw-opad.l-opad.r)/Math.max(1,odds.length))));
  const OW=opad.l+opad.r+odds.length*obw, yOf=l=> mid - (l/maxAbs)*(oph/2);
  let os=`<svg width="${OW}" height="${OH}" viewBox="0 0 ${OW} ${OH}" font-family="DM Sans,system-ui,sans-serif" xmlns="http://www.w3.org/2000/svg">`;
  [8,4,2,1,0.5,0.25,0.125].forEach(t=>{ const l=Math.log(t); if(Math.abs(l)>maxAbs+1e-9) return; const y=yOf(l);
    os+=`<line x1="${opad.l}" y1="${y.toFixed(1)}" x2="${OW-opad.r}" y2="${y.toFixed(1)}" stroke="${t===1?'#0d2240':'#eef1f4'}" stroke-width="${t===1?1.2:1}"/>`;
    os+=`<text x="${opad.l-5}" y="${(y+3).toFixed(1)}" font-size="9" fill="#6c6c78" text-anchor="end">${t>=1?t:'1/'+Math.round(1/t)}</text>`; });
  odds.forEach((o,i)=>{ const x=opad.l+i*obw, y=yOf(Math.log(o.ratio)), up=o.ratio>=1, ry=up?y:mid, rh=Math.max(0.6,Math.abs(y-mid));
    os+=`<rect x="${(x+0.5).toFixed(1)}" y="${ry.toFixed(1)}" width="${(obw-1).toFixed(1)}" height="${rh.toFixed(1)}" fill="${up?UP:DOWN}" data-tip="${esc(groupLabel(bd,o.g))}" data-sub="OR ${o.ratio.toFixed(2)} · ${m1.key} ${(o.p1*100).toFixed(1)}% vs ${m2.key} ${(o.p2*100).toFixed(1)}%"/>`;
    if(i%Math.ceil(odds.length/40)===0){ const lx=x+obw/2, ly=OH-opad.b+10; os+=`<text x="${lx}" y="${ly}" font-size="8" fill="#2a2a35" text-anchor="end" transform="rotate(-55 ${lx} ${ly})">${esc(groupLabel(bd,o.g).slice(0,16))}</text>`; } });
  os+='</svg>'; $('#rel-odds').outerHTML=os.replace('<svg','<svg id="rel-odds"');
  const maxLog=maxAbs||1;
  const otab=odds.map(o=>{ const tt=Math.abs(Math.log(o.ratio))/maxLog, up=o.ratio>=1;
    return `<tr><td class="name">${esc(groupLabel(bd,o.g))}</td><td class="num">${(o.p2*100).toFixed(1)}%</td><td class="num heat" style="background:${rampColor(up?['#ffffff',UP]:['#ffffff',DOWN],tt)};color:${tt>0.6?'#fff':'#1b222c'}">${o.ratio.toFixed(2)}</td><td class="num">${(o.p1*100).toFixed(1)}%</td></tr>`; }).join('');
  $('#odds-table-card').innerHTML=`<div class="tbl-scroll"><table class="dt"><thead><tr><th>${DIM[bd].label}</th><th class="num">${m2.key}</th><th class="num">ratio</th><th class="num">${m1.key}</th></tr></thead><tbody>${otab}</tbody></table></div>`;
  $('#odds-explain').innerHTML=`<div class="explain" style="margin-top:0.7rem">
    <h4>How to read the odds ratio</h4>
    <p>For each <b>${esc(DIM[bd].label).toLowerCase()}</b> we compare two things side by side: the share who say <b>${esc(m1.label)}</b> and the share who say <b>${esc(m2.label)}</b>. The bar shows how many <b>times more likely</b> one answer is than the other — for example a bar of <b>2</b> means the first answer is twice as common as the second.</p>
    <p><span style="color:${UP};font-weight:700">Magenta (above 1)</span> = <b>${esc(m1.label)}</b> is the more common answer · <span style="color:${DOWN};font-weight:700">teal (below 1)</span> = <b>${esc(m2.label)}</b> is more common · <b>1.0</b> = the two answers are equally likely. Bars sit on a <b>log scale</b>, so being "twice as likely" (2×) and "half as likely" (½×) sit the same distance from the baseline — i.e. equal-looking bars mean equal-sized gaps in either direction.</p>
    <p class="muted-note" style="margin-top:0.4rem">It's a way of measuring <b>how out-of-step</b> two responses are within the same group. The bigger the bar, the wider the gap between the two answers for that group.</p>
  </div>`;
  lastExport = { name:`wrp_rel_${ctrl.metric1}_vs_${ctrl.metric2}`,
    cols:[DIM[bd].label, m1.key+' (%)', m2.key+' (%)', 'odds_ratio'],
    rows: odds.map(o=>[groupLabel(bd,o.g), (o.p1*100).toFixed(1), (o.p2*100).toFixed(1), o.ratio.toFixed(3)]) };
}

/* ---------- View 4: sankey ---------- */
function renderSankey(){
  const aKey=ctrl.question, bKey=ctrl.right, qa=Q[aKey], qb=Q[bKey];
  const {m,total}=crosstab(aKey,bKey);
  $('#sankey-title').textContent = `${qa.label}  →  ${qb.label}`;
  // namespaced nodes: left = L:<code>, right = R:<code> (no loops)
  const nodes=[], nidx=new Map();
  qa.answers.forEach(a=>{ nidx.set('L:'+a.code, nodes.length); nodes.push({name:'This person — '+a.label, color:a.color}); });
  qb.answers.forEach(a=>{ nidx.set('R:'+a.code, nodes.length); nodes.push({name:'Most others — '+a.label, color:a.color}); });
  const links=[]; m.forEach((w,k)=>{ const [x,y]=k.split('|'); const si=nidx.get('L:'+x), ti=nidx.get('R:'+y); if(si==null||ti==null) return; links.push({source:si,target:ti,value:w}); });
  const svg=d3.select('#sankey-svg'); svg.selectAll('*').remove();
  const W=Math.max(420, (document.getElementById('sankey-svg').parentElement.clientWidth)||760), H=460;
  svg.attr('width',W).attr('height',H).attr('viewBox',`0 0 ${W} ${H}`).attr('font-family','DM Sans,system-ui,sans-serif');
  if(!links.length||!window.d3 || !d3.sankey){ svg.append('text').attr('x',W/2).attr('y',H/2).attr('text-anchor','middle').attr('fill','#6c6c78').text('No data for this pair'); }
  else{
    const sk=d3.sankey().nodeWidth(14).nodePadding(12).extent([[6,10],[W-6,H-10]]);
    const graph=sk({nodes:nodes.map(d=>Object.assign({},d)), links:links.map(d=>Object.assign({},d))});
    svg.append('g').selectAll('path').data(graph.links).enter().append('path').attr('class','sankey-link')
      .attr('d',d3.sankeyLinkHorizontal()).attr('stroke',d=>d.source.color).attr('stroke-width',d=>Math.max(1,d.width))
      .attr('fill','none').attr('stroke-opacity',0.45)
      .attr('data-tip',d=>d.source.name+' → '+d.target.name).attr('data-sub',d=>(total?(d.value/total*100).toFixed(1):'0')+'% of respondents');
    const node=svg.append('g').selectAll('g').data(graph.nodes).enter().append('g').attr('class','sankey-node');
    node.append('rect').attr('x',d=>d.x0).attr('y',d=>d.y0).attr('width',d=>d.x1-d.x0).attr('height',d=>Math.max(1,d.y1-d.y0)).attr('fill',d=>d.color)
      .attr('stroke','#fff').attr('stroke-width',1)
      .attr('data-tip',d=>d.name).attr('data-sub',d=> total? (d.value/total*100).toFixed(1)+'% of respondents':'');
    node.append('text').attr('class','sankey-label').attr('x',d=>d.x0<W/2?d.x1+5:d.x0-5).attr('y',d=>(d.y0+d.y1)/2).attr('dy','0.35em').attr('text-anchor',d=>d.x0<W/2?'start':'end').text(d=>d.name.replace(/^.*— /,''));
  }
  // table
  const rows=[...m.entries()].map(([k,w])=>{ const [x,y]=k.split('|'); return {x:+x,y:+y,pct:total?w/total*100:0}; }).sort((a,b)=>b.pct-a.pct);
  const lab=(ans,c)=>{ const a=ans.find(z=>z.code===c); return a?a.label:c; };
  const tb=rows.map(r=>`<tr><td>${esc(lab(qb.answers,r.y))}</td><td>${esc(lab(qa.answers,r.x))}</td><td class="num heat" style="background:${rampColor(HEAT1,r.pct/(rows[0].pct||1))};color:${r.pct/(rows[0].pct||1)>0.6?'#fff':'#1b222c'}">${r.pct.toFixed(1)}%</td></tr>`).join('');
  $('#sankey-table-card').innerHTML=`<div class="sec-label">Crosstab</div><div class="tbl-scroll"><table class="dt"><thead><tr><th>Most others</th><th>This person</th><th class="num">% resp.</th></tr></thead><tbody>${tb}</tbody></table></div>`;
  lastExport = { name:`wrp_sankey_${ctrl.question}_to_${ctrl.right}`,
    cols:[qa.label, qb.label, '% respondents'],
    rows: rows.map(r=>[lab(qa.answers,r.x), lab(qb.answers,r.y), r.pct.toFixed(2)]) };
}

/* ---------- View 5: demographic profile ---------- */
function profileAgg(metric, dimCol, scopeCol, scopeCode){
  const bd=dimCol?col(dimCol):null, sc=(scopeCol && scopeCode!=null)?col(scopeCol):null, w=WEIGHT, mean=isMean(metric), arr=col(metric.col), num=mean?null:new Set(metric.num), agg=new Map();
  forEachRow(i=>{ if(sc && sc[i]!==scopeCode) return; const a=arr[i]; if(a<0) return; const g=bd?bd[i]:0; if(bd && g<0) return;
    let e=agg.get(g); if(!e){e=[0,0,0]; agg.set(g,e);} const wi=w[i]; e[1]+=wi; e[2]++; if(mean) e[0]+=wi*(a/100); else if(num.has(a)) e[0]+=wi; });
  return agg; }
function aggVal(e, mean){ return (e && e[1]) ? (mean ? e[0]/e[1] : e[0]/e[1]*100) : NaN; }
function renderProfile(){
  const m=M[ctrl.metric1], mean=isMean(m), sp=ctrl.profileScope||'all';
  let scopeCol=null, scopeCode=null, scopeLabel='All countries';
  if(sp.indexOf('inc:')===0){ scopeCol='wbi'; scopeCode=+sp.slice(4); scopeLabel='Income group: '+(((DIM['CountryIncome'].cats||[]).find(c=>c.code===scopeCode)||{}).label||sp); }
  else if(sp.indexOf('reg:')===0){ scopeCol='RegionLRF'; scopeCode=+sp.slice(4); scopeLabel=((DIM['GlobalRegion'].cats||[]).find(c=>c.code===scopeCode)||{}).label||sp; }
  else if(sp.indexOf('c:')===0){ scopeCol='country'; scopeCode=+sp.slice(2); scopeLabel=COUNTRIES[scopeCode]?COUNTRIES[scopeCode].name:sp; }
  const dimKeys=['gender','age_5','income_quintiles','education','urban_rural','employment'].filter(k=>DIM[k]);
  const oe=profileAgg(m,null,scopeCol,scopeCode).get(0), overall=aggVal(oe,mean);
  const data=dimKeys.map(k=>{ const d=DIM[k], agg=profileAgg(m,d.col,scopeCol,scopeCode);
    const cats=(d.cats||[]).map(c=>{ const e=agg.get(c.code); return {label:c.label, v:aggVal(e,mean), n:e?e[2]:0}; }).filter(c=>!isNaN(c.v));
    return {label:d.label, cats}; });
  let maxV=overall||0; data.forEach(d=>d.cats.forEach(c=>{ if(c.v>maxV) maxV=c.v; }));
  if(!isFinite(maxV)||maxV<=0) maxV=mean?1:100; maxV*=1.12;
  // Adapt column count and cell width to the container so text stays at native size
  // (no SVG scaling) — labels fit, bars fill the card, no big blank gutter on wide screens.
  const host = document.getElementById('profile-svg').parentElement;
  const avail = Math.max(360, (host && host.clientWidth) || 760);
  const pad=14;
  const cols = avail >= 1180 ? 3 : avail >= 720 ? 2 : 1;
  const cellW = Math.max(320, Math.floor((avail - pad) / cols));
  const labW = 150, barMax = cellW - labW - 64, headerH = 44;
  const cellH=28+Math.max(...data.map(d=>d.cats.length),1)*23+14, rowsN=Math.ceil(data.length/cols);
  const W=cols*cellW+pad, H=headerH+rowsN*cellH+pad+4, xOf=v=>labW+(v/maxV)*barMax;
  let s=`<svg id="profile-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block" font-family="DM Sans,system-ui,sans-serif" xmlns="http://www.w3.org/2000/svg">`;
  s+=`<text x="${pad}" y="${pad+13}" font-size="14" font-weight="800" fill="#0d2240">${esc(m.label)}</text>`;
  s+=`<text x="${pad}" y="${pad+31}" font-size="12" fill="#6c6c78">${esc(scopeLabel)} · overall ${fmtMetric(m,overall)} (dashed line) · by demographic</text>`;
  data.forEach((d,di)=>{ const cx=pad+(di%cols)*cellW, cy=pad+headerH+Math.floor(di/cols)*cellH;
    s+=`<text x="${cx}" y="${cy+12}" font-size="12" font-weight="800" fill="#0d2240">${esc(d.label)}</text>`;
    const ox=(cx+xOf(overall)).toFixed(1); s+=`<line x1="${ox}" y1="${cy+20}" x2="${ox}" y2="${cy+26+d.cats.length*23}" stroke="#0d2240" stroke-dasharray="3 3" stroke-width="1"/>`;
    d.cats.forEach((c,i)=>{ const ry=cy+28+i*23, bw=Math.max(1,xOf(c.v)-labW), up=c.v>=overall, small=c.n<30;
      s+=`<text x="${cx+labW-6}" y="${ry+12}" font-size="10.5" fill="#2a2a35" text-anchor="end">${esc(String(c.label).slice(0,22))}</text>`;
      s+=`<rect x="${cx+labW}" y="${ry+3}" width="${bw.toFixed(1)}" height="14" rx="2" fill="${up?'#e3076e':'#00a7b3'}"${small?' opacity="0.4"':''} data-tip="${esc(d.label)} · ${esc(c.label)}" data-sub="${fmtMetric(m,c.v)} (n=${c.n})${small?' · small base':''}"/>`;
      s+=`<text x="${(cx+labW+bw+5).toFixed(1)}" y="${ry+14}" font-size="10" fill="#2a2a35">${fmtMetric(m,c.v)}</text>`; }); });
  s+='</svg>'; $('#profile-svg').outerHTML=s;
  $('#profile-title').textContent=`${m.label} — ${scopeLabel}`;
  const trows=[['(overall)','', fmtMetric(m,overall), oe?oe[2]:0]];
  data.forEach(d=>d.cats.forEach(c=>trows.push([d.label,c.label, fmtMetric(m,c.v), c.n])));
  $('#profile-table-card').innerHTML=`<div class="sec-label">Values</div><div class="tbl-scroll"><table class="dt"><thead><tr><th>Dimension</th><th>Group</th><th class="num">${m.key}</th><th class="num">n</th></tr></thead><tbody>${trows.map(r=>`<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="num">${r[2]}</td><td class="num">${r[3]}</td></tr>`).join('')}</tbody></table></div>`;
  const csvRows=[['(overall)','', csvNum(m,overall), oe?oe[2]:0]];
  data.forEach(d=>d.cats.forEach(c=>csvRows.push([d.label,c.label, csvNum(m,c.v), c.n])));
  lastExport={ name:`wrp_profile_${ctrl.metric1}_${sp.replace(':','-')}`, cols:['Dimension','Group',m.key,'base_n'], rows:csvRows };
}

/* ---------- View 6: dynamic clusters (k-means on the worry profile) ---------- */
function kmeans(rows, k, iters){
  const n=rows.length, d=rows[0].length;
  const order=rows.map((r,i)=>i).sort((a,b)=>rows[a][0]-rows[b][0]); // deterministic init (stable across renders)
  let cent=[]; for(let j=0;j<k;j++) cent.push(rows[order[Math.floor(j*(n-1)/((k-1)||1))]].slice());
  const assign=new Array(n).fill(0);
  for(let it=0; it<iters; it++){
    for(let i=0;i<n;i++){ let best=0,bd=Infinity; for(let j=0;j<k;j++){ let q,sm=0; for(q=0;q<d;q++){ const dd=rows[i][q]-cent[j][q]; sm+=dd*dd; } if(sm<bd){bd=sm;best=j;} } assign[i]=best; }
    const sum=Array.from({length:k},()=>new Array(d).fill(0)), cnt=new Array(k).fill(0);
    for(let i=0;i<n;i++){ cnt[assign[i]]++; for(let q=0;q<d;q++) sum[assign[i]][q]+=rows[i][q]; }
    for(let j=0;j<k;j++) if(cnt[j]) for(let q=0;q<d;q++) cent[j][q]=sum[j][q]/cnt[j];
  }
  return assign;
}
function renderClusters(){
  const WORRY_F=['climate_very','food_very','water_very','crime_very','weather_very','wildfires_very','air_very','mental_health_very','traffic_very','work_very'];
  const EXP_F=['exp_food','exp_water','exp_crime','exp_weather','exp_prolonged_weather','exp_wildfires','exp_air','exp_traffic','exp_mental_health','exp_work'];
  const basis=ctrl.clusterBy||'worry';
  const FEAT=(basis==='experience'?EXP_F : basis==='both'?WORRY_F.concat(EXP_F) : WORRY_F).filter(k=>M[k]);
  const basisLabel=basis==='experience'?'experienced-harm' : basis==='both'?'worry & experience' : 'worry';
  const FEATURE_LABEL={
    climate_very:'climate change as a threat', food_very:'food safety', water_very:'water safety',
    crime_very:'violent crime', weather_very:'severe weather', wildfires_very:'wildfires',
    air_very:'air quality', mental_health_very:'mental health', traffic_very:'road traffic',
    work_very:'safety at work',
    exp_food:'harm from food', exp_water:'harm from water', exp_crime:'harm from violent crime',
    exp_weather:'harm from severe weather', exp_prolonged_weather:'harm from prolonged weather',
    exp_wildfires:'harm from wildfires', exp_air:'harm from the air',
    exp_traffic:'harm from traffic', exp_mental_health:'harm to mental health', exp_work:'harm at work',
  };
  const featLabel=k=>FEATURE_LABEL[k] || k.replace('_very','').replace(/^exp_/,'');
  const maps=FEAT.map(k=>metricByGroup(M[k],'countrynew'));
  const idxs=[...maps[0].keys()].filter(ix=>maps.every(mp=>mp.has(ix)&&!isNaN(mp.get(ix))));
  const raw=idxs.map(ix=>maps.map(mp=>mp.get(ix)));
  const d=FEAT.length, mu=new Array(d).fill(0), sd=new Array(d).fill(0);
  raw.forEach(r=>r.forEach((v,q)=>mu[q]+=v)); for(let q=0;q<d;q++) mu[q]/=(raw.length||1);
  raw.forEach(r=>r.forEach((v,q)=>sd[q]+=(v-mu[q])**2)); for(let q=0;q<d;q++) sd[q]=Math.sqrt(sd[q]/(raw.length||1))||1;
  const z=raw.map(r=>r.map((v,q)=>(v-mu[q])/sd[q]));
  const k=Math.max(2,Math.min(ctrl.k||4, z.length||2)), assign=z.length?kmeans(z,k,40):[];
  const CL=['#e3076e','#00a7b3','#7a50de','#f07800','#00785c','#b07d00'];
  // similarity map: bubbles pulled toward their cluster centroid, packed by collision (no axes)
  const REGCOL=['#e3076e','#00a7b3','#7a50de','#f07800','#00785c','#b07d00','#2f6fb5','#d91424','#1aa088','#067acc','#af640c','#0a891f','#bf153d','#8c7500','#6c6c78'];
  const INCCOL={1:'#0d2240',2:'#2f6fb5',3:'#00a7b3',4:'#e3076e',9:'#bdbdbd'};
  const cb=ctrl.colourBy||'cluster';
  const W=Math.max(420,($('#cluster-svg').parentElement.clientWidth)||720), H=720, cx0=W/2, cy0=H/2;
  const rB=Math.max(6,Math.min(13,Math.sqrt((W*H)/((idxs.length||1)*7))));
  const Rr=Math.min(W,H)*(k<=2?0.22:0.32);   // push anchors a little further apart so the clusters separate cleanly
  const anchors=Array.from({length:k},(_,j)=>({x:cx0+Rr*Math.cos(2*Math.PI*j/k-Math.PI/2), y:cy0+Rr*Math.sin(2*Math.PI*j/k-Math.PI/2)}));
  const nodes=idxs.map((ix,i)=>{ const a=anchors[assign[i]], ang=i*2.399963; return {ix,cl:assign[i],x:a.x+Math.cos(ang)*18,y:a.y+Math.sin(ang)*18}; });
  const sim=d3.forceSimulation(nodes)
    .force('x',d3.forceX(d=>anchors[d.cl].x).strength(0.18))
    .force('y',d3.forceY(d=>anchors[d.cl].y).strength(0.18))
    .force('collide',d3.forceCollide(rB+3).strength(1))
    .force('charge',d3.forceManyBody().strength(-26).distanceMax(rB*10))
    .stop();
  const mnX=rB+6, mxX=W-rB-6, mnY=rB+6, mxY=H-rB-6;   // keep every bubble inside the frame each tick
  for(let it=0; it<450; it++){ sim.tick(); for(let q=0;q<nodes.length;q++){ const nd=nodes[q];
    nd.x = nd.x<mnX?mnX:(nd.x>mxX?mxX:nd.x); nd.y = nd.y<mnY?mnY:(nd.y>mxY?mxY:nd.y); } }
  const regLabel=c=>{ const x=(DIM['GlobalRegion'].cats||[]).find(z=>z.code===c); return x?x.label:''; };
  let colourOf, legendHTML='', tipExtra=()=>'';
  if(cb==='region'){ const present=[...new Set(nodes.map(n=>CREGION[n.ix]).filter(c=>c>0))].sort((a,b)=>a-b);
    colourOf=n=>{ const c=CREGION[n.ix]; return c>0?REGCOL[(c-1)%REGCOL.length]:'#e9e9ee'; };
    legendHTML=present.map(c=>`<span class="k"><span class="sw" style="background:${REGCOL[(c-1)%REGCOL.length]}"></span>${esc(regLabel(c))}</span>`).join(''); }
  else if(cb==='income'){ const cats=DIM['CountryIncome'].cats||[], present=new Set(nodes.map(n=>CINCOME[n.ix]).filter(c=>c>0));
    colourOf=n=>{ const c=CINCOME[n.ix]; return INCCOL[c]||'#e9e9ee'; };
    legendHTML=cats.filter(c=>present.has(c.code)).map(c=>`<span class="k"><span class="sw" style="background:${INCCOL[c.code]||'#ccc'}"></span>${esc(c.label)}</span>`).join(''); }
  else if(cb.startsWith('m:')){ const m=M[cb.slice(2)], vb=metricByGroup(m,'countrynew'), vals=[...vb.values()].filter(v=>!isNaN(v)), lo=Math.min(...vals), hi=Math.max(...vals);
    colourOf=n=>{ const v=vb.get(n.ix); return (v==null||isNaN(v))?'#e9e9ee':rampColor(MAP_RAMP,(v-lo)/(hi-lo||1)); };
    tipExtra=n=>` · ${m.key} ${fmtMetric(m,vb.get(n.ix))}`;
    legendHTML=`<span class="k">${fmtMetric(m,lo)}</span><span class="sw" style="width:150px;height:12px;border-radius:2px;background:linear-gradient(to right,${MAP_RAMP.join(',')})"></span><span class="k">${fmtMetric(m,hi)}</span>`; }
  else { colourOf=n=>CL[n.cl%CL.length]; legendHTML=Array.from({length:k},(_,j)=>`<span class="k"><span class="sw" style="background:${CL[j%CL.length]}"></span>Cluster ${j+1}</span>`).join(''); }
  let s=`<svg id="cluster-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DM Sans,system-ui,sans-serif" xmlns="http://www.w3.org/2000/svg">`;
  nodes.forEach(n=>{ const reg=CREGION[n.ix]>0?regLabel(CREGION[n.ix]):''; s+=`<circle class="scatter-pt" cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${rB.toFixed(1)}" fill="${colourOf(n)}" fill-opacity="0.88" data-tip="${esc(COUNTRIES[n.ix].name)}" data-sub="Cluster ${n.cl+1}${reg?' · '+esc(reg):''}${tipExtra(n)}"/>`; });
  s+='</svg>'; $('#cluster-svg').outerHTML=s; $('#cluster-legend').innerHTML=legendHTML;
  $('#cluster-title').textContent=`Country clusters by ${basisLabel} profile — coloured by ${cb==='cluster'?'cluster':cb==='region'?'global region':cb==='income'?'income group':M[cb.slice(2)].key}`;
  $('#cluster-note').innerHTML=`Bubbles that sit together share a similar ${basisLabel} profile across ${FEAT.length} indicators (k-means, k=${k}, standardised). Position reflects similarity — there are no axes. Use “Cluster by” to switch the basis, and “Colour by” to overlay region, income group or any response.`;
  const byCl=Array.from({length:k},()=>[]); idxs.forEach((ix,i)=>byCl[assign[i]].push(i));
  let html='<div class="sec-label">Clusters</div>';
  byCl.forEach((members,ci)=>{ if(!members.length) return;
    const mz=new Array(d).fill(0); members.forEach(i=>z[i].forEach((v,q)=>mz[q]+=v)); for(let q=0;q<d;q++) mz[q]/=members.length;
    // pick the two indicators where this cluster deviates most from the global average
    // (in either direction) — gives a more honest "what makes this group distinctive".
    const top=mz.map((v,q)=>[q,v]).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).slice(0,2);
    const tagsHi=top.filter(([,v])=>v>=0).map(([q])=>featLabel(FEAT[q]));
    const tagsLo=top.filter(([,v])=>v<0).map(([q])=>featLabel(FEAT[q]));
    const bits=[];
    if(tagsHi.length) bits.push('higher than average on '+tagsHi.join(' and '));
    if(tagsLo.length) bits.push('lower than average on '+tagsLo.join(' and '));
    const distinctive = bits.join('; ');
    const names=members.map(i=>COUNTRIES[idxs[i]].name).sort();
    html+=`<div style="margin-bottom:0.95rem">
      <div style="font-weight:700;color:#0d2240"><span class="dot" style="background:${CL[ci%CL.length]}"></span> Cluster ${ci+1} <span style="color:#6c6c78;font-weight:500">· ${members.length} countries</span></div>
      <div style="font-size:12.5px;color:#2a2a35;margin-top:2px"><b>Distinctive pattern:</b> ${esc(distinctive)}.</div>
      <div style="font-size:12px;color:#6c6c78;line-height:1.5;margin-top:3px">${names.map(esc).join(', ')}</div>
    </div>`; });
  $('#cluster-list').innerHTML=html;
  const explainEl=document.getElementById('cluster-explain');
  if(explainEl){ explainEl.innerHTML=`<div class="sec-label">About this chart</div>
    <div class="explain explain-grid">
      <section>
        <h4>What this shows</h4>
        <p>Each country is sorted into one of ${k} groups so that countries in the same group share the most <b>similar ${basisLabel} pattern</b> across the ${FEAT.length} indicators. It is not about who scores highest overall, but the <i>shape</i> of their responses — which items stand out for them relative to everyone else. Use <b>Cluster by</b> to base the grouping on worry, experienced harm, or both.</p>
      </section>
      <section>
        <h4>How to read it</h4>
        <p>Each bubble is a country, and bubbles that <b>sit close together</b> have a similar ${basisLabel} profile. The layout uses all ${FEAT.length} indicators at once, so there are no axes — position only reflects similarity. By default colour marks the cluster; switch <b>Colour by</b> to shade the bubbles by region, income group or any individual response, to see whether the data‑driven groups line up with those.</p>
      </section>
      <section>
        <h4>Keep in mind</h4>
        <p>This is a way of <b>describing</b> the data, not a ranking or a verdict — the groups have no order, and a country near the edge of a blob could reasonably belong to either side. Figures are standardised, so the groups reflect <b>relative</b> patterns, not absolute levels. Change the number of groups or any filter above and the clustering recalculates; the colour overlay updates instantly.</p>
      </section>
    </div>`; }
  lastExport={ name:`wrp_clusters_${basis}_k${k}`, cols:['Country','ISO3','cluster',...FEAT], rows:idxs.map((ix,i)=>[COUNTRIES[ix].name, COUNTRIES[ix].iso3||'', assign[i]+1, ...raw[i].map(v=>v.toFixed(1))]) };
}

/* ---------- Trends view 1: stacked time course (single question, distribution per year) ---------- */
function renderTrendCourse(){
  const q = Q[ctrl.question]; if(!q){ return; }
  const yearDim = DIM['year']; if(!yearDim){ $('#tc-title').textContent = 'Time course (year dimension missing)'; return; }
  const groups = distribution(ctrl.question, 'year');   // Map(code → {total, counts:Map(answerCode→w)})
  const years = [...groups.keys()].sort((a,b)=>a-b);
  if(!years.length){ $('#tc-title').textContent = q.label + ' — no data'; return; }
  const yearLabel = code => { const c = (yearDim.cats||[]).find(c=>c.code===code); return c ? c.label : String(code); };

  $('#tc-title').textContent = q.label + ' — by wave';
  const stack = stackOrder(q);
  $('#tc-legend').innerHTML = stack.map(a=>`<span class="k"><span class="sw" style="background:${a.color}"></span>${esc(a.label)}</span>`).join('');

  const host = document.getElementById('tc-chart').parentElement;
  const W = Math.max(640, (host && host.clientWidth) || 900);
  const H = 460, pad = {t:10, r:18, b:46, l:48};
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const slotW = pw / years.length;
  const barW = Math.min(180, Math.max(40, slotW * 0.62));

  let s = `<svg id="tc-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DM Sans,system-ui,sans-serif" xmlns="http://www.w3.org/2000/svg">`;
  for(let p=0; p<=100; p+=25){
    const y = pad.t + ph * (1 - p/100);
    s += `<line x1="${pad.l}" y1="${y}" x2="${W-pad.r}" y2="${y}" stroke="#e4e4ea"/>`;
    s += `<text x="${pad.l-8}" y="${y+3}" font-size="10" fill="#6c6c78" text-anchor="end">${p}%</text>`;
  }
  const xCentre = i => pad.l + slotW * i + slotW/2;
  const bars = years.map((yr, i)=>{
    const e = groups.get(yr); const cx = xCentre(i), x = cx - barW/2;
    let acc = pad.t;
    const segs = stack.map(a=>{
      const w = e.counts.get(a.code)||0;
      const frac = e.total ? w / e.total : 0;
      const h = frac * ph;
      const seg = {a, frac, h, y0: acc, y1: acc + h};
      acc += h;
      return seg;
    });
    return {yr, e, cx, x, segs};
  });
  // Connecting ribbons between adjacent waves so the eye reads the trend
  for(let i=0; i<bars.length-1; i++){
    const A = bars[i], B = bars[i+1];
    const x1 = A.x + barW, x2 = B.x;
    A.segs.forEach((sa, k)=>{ const sb = B.segs[k]; if(!sa || !sb || (sa.frac===0 && sb.frac===0)) return;
      const path = `M ${x1} ${sa.y0.toFixed(1)} L ${x2} ${sb.y0.toFixed(1)} L ${x2} ${sb.y1.toFixed(1)} L ${x1} ${sa.y1.toFixed(1)} Z`;
      s += `<path d="${path}" fill="${sa.a.color}" fill-opacity="0.16"/>`;
    });
  }
  bars.forEach((b)=>{
    b.segs.forEach(seg=>{
      if(seg.h <= 0.1) return;
      s += `<rect x="${b.x.toFixed(1)}" y="${seg.y0.toFixed(1)}" width="${barW.toFixed(1)}" height="${seg.h.toFixed(1)}" fill="${seg.a.color}" data-tip="${esc(yearLabel(b.yr))} — ${esc(seg.a.label)}" data-sub="${(seg.frac*100).toFixed(1)}% of respondents"/>`;
    });
    s += `<text x="${b.cx.toFixed(1)}" y="${(H - pad.b + 16).toFixed(1)}" font-size="12" fill="#2a2a35" text-anchor="middle" font-weight="700">${esc(yearLabel(b.yr))}</text>`;
    s += `<text x="${b.cx.toFixed(1)}" y="${(H - pad.b + 32).toFixed(1)}" font-size="10" fill="#6c6c78" text-anchor="middle">n = ${Math.round(b.e.total).toLocaleString()}</text>`;
  });
  s += '</svg>'; $('#tc-chart').outerHTML = s;

  $('#tc-note').textContent = "Bars sum to 100% within each wave. Don't know / Refused are kept in the denominator. Ribbons connect equivalent answer bands across waves so the eye reads the trend; the n underneath each bar is the unweighted respondent count for that wave.";

  lastExport = { name:`wrp_trend_course_${ctrl.question}`,
    cols:['Wave', 'Answer', 'Percent'],
    rows: bars.flatMap(b => b.segs.map(seg => [yearLabel(b.yr), seg.a.label, (seg.frac*100).toFixed(2)])) };
}

/* ---------- Trends view 2: per-country change between two waves on one metric ---------- */
function metricByCountryAndYear(metric, yearCode){
  const bd = col(DIM['countrynew'].col), yr = col(DIM['year'].col), w = WEIGHT, agg = new Map();
  if(isMean(metric)){
    const v = col(metric.col);
    forEachRow(i=>{ if(yr[i] !== yearCode) return; const x = v[i]; if(x < 0) return; const g = bd[i]; if(g < 0) return;
      let e = agg.get(g); if(!e){ e=[0,0]; agg.set(g,e); } e[0] += w[i] * (x/100); e[1] += w[i]; });
    const out = new Map(); agg.forEach((e,g)=>out.set(g, e[1] ? e[0]/e[1] : NaN)); return out;
  }
  const q = col(metric.col), num = new Set(metric.num);
  forEachRow(i=>{ if(yr[i] !== yearCode) return; const a = q[i]; if(a < 0) return; const g = bd[i]; if(g < 0) return;
    let e = agg.get(g); if(!e){ e=[0,0]; agg.set(g,e); } e[1] += w[i]; if(num.has(a)) e[0] += w[i]; });
  const out = new Map(); agg.forEach((e,g)=>out.set(g, e[1] ? e[0]/e[1]*100 : NaN)); return out;
}

async function renderTrendMap(){
  const m = M[ctrl.metric1]; if(!m){ return; }
  const yearDim = DIM['year']; if(!yearDim){ $('#tm-title').textContent = 'Change between waves (year dimension missing)'; return; }
  const fromC = ctrl.tmFromYear, toC = ctrl.tmToYear;
  if(!fromC || !toC || fromC === toC){ $('#tm-title').textContent = 'Pick two different waves to compare'; return; }
  const yLab = code => { const c = (yearDim.cats||[]).find(c=>c.code===code); return c ? c.label : String(code); };
  $('#tm-title').textContent = `${m.label} — change from ${yLab(fromC)} to ${yLab(toC)}`;

  const a = metricByCountryAndYear(m, fromC), b = metricByCountryAndYear(m, toC);
  const deltas = new Map();
  a.forEach((va, g)=>{ const vb = b.get(g); if(va==null || vb==null || isNaN(va) || isNaN(vb)) return; deltas.set(g, vb - va); });
  const iso2val = new Map(); deltas.forEach((d, idx)=>{ const iso = COUNTRIES[idx] && COUNTRIES[idx].iso3; if(iso) iso2val.set(iso, d); });
  const vals = [...iso2val.values()];
  const maxAbs = Math.max(0.5, ...vals.map(Math.abs));

  const DIVERGE = ['#0d6e6e', '#7fc5c3', '#f4eef0', '#e89cbf', '#9b0b50'];
  const colour = d => { const t = Math.max(-1, Math.min(1, d / maxAbs)); return rampColor(DIVERGE, (t + 1) / 2); };

  const world = await ensureWorld();
  const svg = d3.select('#tm-svg'); svg.selectAll('*').remove();
  if(!world){ svg.append('text').attr('x', 360).attr('y', 190).attr('text-anchor','middle').attr('fill', '#6c6c78').text('Map unavailable (offline)'); }
  else{
    const W = 720, H = 380, proj = d3.geoNaturalEarth1().fitExtent([[6,6],[W-6,H-6]], {type:'Sphere'}), path = d3.geoPath(proj);
    svg.append('path').attr('class','map-sphere').attr('fill','#eef1f4').attr('d', path({type:'Sphere'}));
    svg.selectAll('path.c').data(world.features.filter(f=>pad3(f.id)!=='010')).enter().append('path')
      .attr('d', path).attr('class', f=>{ const iso = NUM2A3[pad3(f.id)]; return iso2val.has(iso) ? 'map-land' : 'map-land-nodata'; })
      .attr('fill', f=>{ const iso = NUM2A3[pad3(f.id)]; if(!iso2val.has(iso)) return '#fff'; return colour(iso2val.get(iso)); })
      .attr('data-tip', f=> (f.properties && f.properties.name) || '')
      .attr('data-sub', f=>{ const iso = NUM2A3[pad3(f.id)]; if(!iso2val.has(iso)) return 'No data';
        const d = iso2val.get(iso); const sign = d >= 0 ? '+' : ''; return `${m.label}: ${sign}${isMean(m) ? Math.round(d*100) : d.toFixed(1)+' pp'} (${yLab(fromC)} → ${yLab(toC)})`; });
  }

  const fmtDelta = d => (d >= 0 ? '+' : '') + (isMean(m) ? String(Math.round(d*100)) : d.toFixed(1) + ' pp');
  $('#tm-legend').innerHTML =
    `<span>${fmtDelta(-maxAbs)}</span>` +
    `<span class="bar" style="background:linear-gradient(to right,${DIVERGE.join(',')})"></span>` +
    `<span>${fmtDelta(maxAbs)}</span>` +
    `<span style="margin-left:1rem;color:var(--lrf-muted)">0 = no change</span>`;
  $('#tm-note').textContent = isMean(m)
    ? `Change in ${m.label.replace(/\s*\(0[–-]100\)\s*$/,'')} between the two waves, on the 0–100 index scale. ${[...iso2val].length} countries with data in both waves.`
    : `Change in percentage points between the two waves. ${[...iso2val].length} countries with data in both waves. A +5 pp shift means an extra 5 in 100 respondents now picking that answer.`;

  const keys = [...deltas.keys()].sort((a,b)=>deltas.get(b)-deltas.get(a));
  const rows = keys.map((g,i)=>{
    const d = deltas.get(g), va = a.get(g), vb = b.get(g), t = Math.max(0, Math.min(1, Math.abs(d) / maxAbs));
    const up = d >= 0;
    return `<tr>
      <td class="rank">${i+1}</td>
      <td class="name">${esc(COUNTRIES[g].name)}</td>
      <td class="num">${fmtMetric(m, va)}</td>
      <td class="num">${fmtMetric(m, vb)}</td>
      <td class="num heat" style="background:${rampColor(up?['#ffffff','#9b0b50']:['#ffffff','#0d6e6e'], t)};color:${t>0.55?'#fff':'#1b222c'}">${fmtDelta(d)}</td>
    </tr>`;
  }).join('');
  $('#tm-table-card').innerHTML = `<div class="sec-label">Change ranking</div>
    <div class="tbl-scroll">
      <table class="dt"><thead><tr>
        <th class="rank"></th><th>Country</th>
        <th class="num">${yLab(fromC)}</th>
        <th class="num">${yLab(toC)}</th>
        <th class="num">Δ</th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>`;

  lastExport = { name:`wrp_change_${ctrl.metric1}_${fromC}_to_${toC}`,
    cols:['Country','ISO3', yLab(fromC), yLab(toC), 'delta'],
    rows: keys.map(g=>[COUNTRIES[g].name, COUNTRIES[g].iso3||'', csvNum(m, a.get(g)), csvNum(m, b.get(g)), (deltas.get(g)).toFixed(3)]) };
}

/* ---------- Dataset details: per-country wave coverage ---------- */
let COUNTRY_WAVES = null;
async function ensureCountryWaves(){
  if(COUNTRY_WAVES) return COUNTRY_WAVES;
  try{
    COUNTRY_WAVES = await fetch('data/country_waves.json', {cache:'no-store'}).then(r=>r.json());
  }catch(e){ COUNTRY_WAVES = {waves:[], countries:[]}; }
  return COUNTRY_WAVES;
}
function fmtPop(n){
  if(n == null || isNaN(n) || n === 0) return '—';
  if(n >= 1e9) return (n/1e9).toFixed(2)+' bn';
  if(n >= 1e6) return (n/1e6).toFixed(1)+' m';
  if(n >= 1e3) return (n/1e3).toFixed(0)+' k';
  return String(n);
}
function fmtN(n){ return (n==null||isNaN(n)||n===0) ? '—' : Math.round(n).toLocaleString(); }
async function renderDataset(){
  const data = await ensureCountryWaves();
  const waves = data.waves || [];
  $('#ds-title').textContent = 'Country coverage across all World Risk Poll waves';
  const ths  = waves.map(w => `<th class="num" colspan="2">${esc(w)}</th>`).join('');
  const ths2 = waves.map(() => `<th class="num">Sample n</th><th class="num">Pop. (PROJWT)</th>`).join('');
  const head = `<thead>
    <tr><th rowspan="2">Country</th>${ths}<th class="num" rowspan="2">Waves<br>(of ${waves.length})</th><th class="num" rowspan="2">Total<br>respondents</th></tr>
    <tr>${ths2}</tr>
  </thead>`;

  const list = data.countries || [];
  const rowFor = (c)=>{
    let wavesIn = 0, totalN = 0;
    const cells = waves.map(w => {
      const cell = (c.by_wave||{})[w];
      if(cell && cell.n > 0){ wavesIn++; totalN += cell.n;
        return `<td class="num">${fmtN(cell.n)}</td><td class="num">${fmtPop(cell.pop)}</td>`; }
      return `<td class="absent">—</td><td class="absent">—</td>`;
    });
    return {wavesIn, totalN, html: `<tr data-name="${esc((c.name||'').toLowerCase())}">
      <td class="name">${esc(c.name)}</td>${cells.join('')}
      <td class="num">${wavesIn}</td>
      <td class="num">${fmtN(totalN)}</td>
    </tr>`};
  };
  const rows = list.map(rowFor);
  const tbody = `<tbody>${rows.map(r=>r.html).join('')}</tbody>`;

  const totalsByWave = waves.map(w=>{
    const wsum = list.reduce((acc,c)=>{ const x=(c.by_wave||{})[w]; if(x){ acc.n+=x.n||0; acc.pop+=x.pop||0; } return acc; }, {n:0, pop:0});
    return `<td class="num">${fmtN(wsum.n)}</td><td class="num">${fmtPop(wsum.pop)}</td>`;
  }).join('');
  const grandN = rows.reduce((a,r)=>a+r.totalN, 0);
  const foot = `<tfoot><tr><td class="name">All countries</td>${totalsByWave}<td class="num">—</td><td class="num">${fmtN(grandN)}</td></tr></tfoot>`;

  $('#ds-table').innerHTML = head + tbody + foot;
  const presentByWave = waves.map(w => ({w, c: list.filter(c => (c.by_wave||{})[w] && c.by_wave[w].n>0).length}));
  $('#ds-summary').textContent = `${list.length} countries across ${waves.length} waves — ${presentByWave.map(p=>`${p.c} in ${p.w}`).join(' · ')}`;
  $('#ds-note').textContent = "Sample n = unweighted respondent count. Pop. (PROJWT) = sum of population-projection weights, which approximates the country's adult population for that wave. A '—' means the country was not surveyed in that wave.";

  const search = $('#ds-search');
  const apply = ()=>{ const q = (search.value || '').trim().toLowerCase();
    document.querySelectorAll('#ds-table tbody tr').forEach(tr=>{
      tr.style.display = (!q || tr.dataset.name.includes(q)) ? '' : 'none';
    }); };
  search.oninput = apply;
  apply();

  lastExport = { name: 'wrp_country_coverage',
    cols: ['Country', ...waves.flatMap(w=>[`n_${w}`, `pop_${w}`]), 'waves_present', 'total_respondents'],
    rows: list.map(c=>{
      let wavesIn=0, totalN=0;
      const cells = waves.flatMap(w=>{ const x=(c.by_wave||{})[w];
        if(x && x.n>0){ wavesIn++; totalN+=x.n; return [x.n, x.pop]; }
        return ['', '']; });
      return [c.name, ...cells, wavesIn, totalN];
    }) };
}

load();
