"use strict";
/* WRP 2025 Data Explorer — columnar microdata + live PROJWT-weighted aggregation.
   Loads wrp_explorer.json (catalogue + manifest) and wrp_explorer.bin(.gz). */

const $ = s => document.querySelector(s);
const WRP = { very:'#e3076e', somewhat:'#00a7b3', not:'#00785c', dk:'#bdbdbd', refused:'#0d2240' };
const HEAT1 = ['#ffffff', '#e3076e'];          // metric_1 magenta scale
const HEAT2 = ['#eef1f4', '#0d2240'];          // metric_2 navy scale
const MAP_RAMP = ['#fbe0ec', '#e3076e', '#5c0b3a', '#0d2240']; // fuchsia → ink

let MAN, N, WEIGHT, STORE = {}, DIM = {}, Q = {}, M = {}, COUNTRIES = [];
let ROWS = null; // current passing row indices (null = all)
const filters = {};           // dimKey -> Set(codes)
const ctrl = { question:'climate', breakdown1:'countrynew', breakdown2:'countrynew',
               metric1:'climate_very', metric2:'climate_other_very', right:'climate_other', sort:'metric1' };
let activeView = 'dist';

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
    MAN = await fetch('data/wrp_explorer.json').then(r=>{ if(!r.ok) throw new Error('manifest '+r.status); return r.json(); });
    let buf;
    try{
      const res = await fetch('data/wrp_explorer.bin.gz');
      if(!res.ok) throw 0;
      if('DecompressionStream' in window){
        const ds = res.body.pipeThrough(new DecompressionStream('gzip'));
        buf = await new Response(ds).arrayBuffer();
      } else { throw 0; }
    }catch(e){
      buf = await fetch('data/wrp_explorer.bin').then(r=>{ if(!r.ok) throw new Error('bin '+r.status); return r.arrayBuffer(); });
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
    MAN.dimensions.forEach(d=> DIM[d.key]=d);
    MAN.questions.forEach(q=> Q[q.key]=q);
    MAN.metrics.forEach(m=> M[m.key]=m);
    $('#status').classList.add('hidden');
    $('#app').classList.remove('hidden');
    buildFilters(); buildTabs(); render(); observeResize();
  }catch(e){
    const s=$('#status'); s.classList.add('err'); s.textContent='Could not load the dataset ('+e.message+'). Run build_explorer_data.py and serve the tools folder.';
  }
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
function fmtMetric(m,v){ if(v==null||isNaN(v)) return '–'; return isMean(m)? v.toFixed(2) : v.toFixed(1)+'%'; }

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
const qOpts = ()=>MAN.questions.map(q=>[q.key,q.label]);
const mOpts = ()=>MAN.metrics.map(m=>[m.key,m.label]);
const dOpts = ()=>MAN.dimensions.filter(d=>d.type==='country'||d.cats).map(d=>[d.key,d.label]);
function buildControls(){
  const cb=$('#controlbar'); let h='';
  if(activeView==='dist'){
    h+=selectField('c-question','Question',qOpts(),ctrl.question);
    h+=selectField('c-bd1','Breakdown',dOpts(),ctrl.breakdown1);
    h+=selectField('c-m1','Metric 1 (rank / heat)',mOpts(),ctrl.metric1);
    h+=selectField('c-m2','Metric 2',mOpts(),ctrl.metric2);
  } else if(activeView==='map'){
    h+=selectField('c-m1','Metric 1 (map colour)',mOpts(),ctrl.metric1);
    h+=selectField('c-m2','Metric 2',mOpts(),ctrl.metric2);
  } else if(activeView==='rel'){
    h+=selectField('c-m1','Metric 1 (x)',mOpts(),ctrl.metric1);
    h+=selectField('c-m2','Metric 2 (y)',mOpts(),ctrl.metric2);
    h+=selectField('c-bd2','Breakdown',dOpts(),ctrl.breakdown2);
  } else if(activeView==='sankey'){
    h+=selectField('c-question','Question (left)',qOpts(),ctrl.question);
    h+=selectField('c-right','Question (right)',qOpts(),ctrl.right);
  }
  cb.innerHTML=h;
  const bind=(id,key)=>{ const el=$('#'+id); if(el) el.onchange=()=>{ ctrl[key]=el.value; render(); }; };
  bind('c-question','question'); bind('c-bd1','breakdown1'); bind('c-bd2','breakdown2');
  bind('c-m1','metric1'); bind('c-m2','metric2'); bind('c-right','right');
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

/* ---------- render dispatch ---------- */
function render(){ buildControls(); updateFilterToggle();
  if(activeView==='dist') renderDist();
  else if(activeView==='map') renderMap();
  else if(activeView==='rel') renderRel();
  else if(activeView==='sankey') renderSankey();
}

/* ---------- View 1: ranked distribution ---------- */
function renderDist(){
  const q=Q[ctrl.question], bd=ctrl.breakdown1, m1=M[ctrl.metric1], m2=M[ctrl.metric2];
  const groups=distribution(ctrl.question, bd);
  const g1=metricByGroup(m1,bd), g2=metricByGroup(m2,bd);
  let keys=[...groups.keys()];
  keys.sort((a,b)=> (g1.get(b)??-1)-(g1.get(a)??-1));
  $('#dist-title').textContent = q.label + ' — by ' + DIM[bd].label;
  // legend
  $('#dist-legend').innerHTML = q.answers.map(a=>`<span class="k"><span class="sw" style="background:${a.color}"></span>${a.label}</span>`).join('');
  // chart
  const svg=$('#dist-chart'); const H=460, pad={t:8,r:8,b:96,l:34};
  const cw=Math.max(360, (svg.parentElement && svg.parentElement.clientWidth) || 760);
  const barW=Math.max(2, Math.min(56, Math.floor((cw-pad.l-pad.r)/Math.max(1,keys.length))));
  const W=pad.l+pad.r+keys.length*barW; const plotH=H-pad.t-pad.b;
  let s=`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DM Sans, system-ui, sans-serif" xmlns="http://www.w3.org/2000/svg">`;
  for(let p=0;p<=100;p+=25){ const y=pad.t+plotH*(1-p/100); s+=`<line x1="${pad.l}" y1="${y}" x2="${W-pad.r}" y2="${y}" stroke="#e4e4ea"/><text x="${pad.l-6}" y="${y+3}" font-size="10" fill="#6c6c78" text-anchor="end">${p}%</text>`; }
  const labelEvery=Math.ceil(keys.length/45);
  keys.forEach((g,i)=>{ const e=groups.get(g), x=pad.l+i*barW; let cy=pad.t;
    q.answers.forEach(a=>{ const w=e.counts.get(a.code)||0; const frac=e.total?w/e.total:0; const hh=frac*plotH;
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
}
const shortMetric = m => m.key;
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
    svg.append('path').attr('class','map-sphere').attr('d',path({type:'Sphere'}));
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
    s+=`<text x="${pad.l-6}" y="${gy+3}" font-size="10" fill="#6c6c78" text-anchor="end">${isMean(m2)?(t*ymax).toFixed(1):(Math.round(t*ymax))+'%'}</text>`;
    s+=`<text x="${gx}" y="${H-pad.b+14}" font-size="10" fill="#6c6c78" text-anchor="middle">${isMean(m1)?(t*xmax).toFixed(1):(Math.round(t*xmax))+'%'}</text>`; }
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
  $('#odds-explain').innerHTML=`<p class="muted-note"><b>Understanding the odds ratio.</b> How many times more likely a <b>${m1.key}</b> response is versus a <b>${m2.key}</b> response. <span style="color:${UP};font-weight:700">Above 1</span> = ${m1.key} more likely; <span style="color:${DOWN};font-weight:700">below 1</span> = ${m2.key} more likely; 1.0 = balanced. Plotted on a log scale, so 2× and ½× sit equal distances from the baseline.</p>`;
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
      .attr('data-tip',d=>d.source.name+' → '+d.target.name).attr('data-sub',d=>(total?(d.value/total*100).toFixed(1):'0')+'% of respondents');
    const node=svg.append('g').selectAll('g').data(graph.nodes).enter().append('g').attr('class','sankey-node');
    node.append('rect').attr('x',d=>d.x0).attr('y',d=>d.y0).attr('width',d=>d.x1-d.x0).attr('height',d=>Math.max(1,d.y1-d.y0)).attr('fill',d=>d.color)
      .attr('data-tip',d=>d.name).attr('data-sub',d=> total? (d.value/total*100).toFixed(1)+'% of respondents':'');
    node.append('text').attr('class','sankey-label').attr('x',d=>d.x0<W/2?d.x1+5:d.x0-5).attr('y',d=>(d.y0+d.y1)/2).attr('dy','0.35em').attr('text-anchor',d=>d.x0<W/2?'start':'end').text(d=>d.name.replace(/^.*— /,''));
  }
  // table
  const rows=[...m.entries()].map(([k,w])=>{ const [x,y]=k.split('|'); return {x:+x,y:+y,pct:total?w/total*100:0}; }).sort((a,b)=>b.pct-a.pct);
  const lab=(ans,c)=>{ const a=ans.find(z=>z.code===c); return a?a.label:c; };
  const tb=rows.map(r=>`<tr><td>${esc(lab(qb.answers,r.y))}</td><td>${esc(lab(qa.answers,r.x))}</td><td class="num heat" style="background:${rampColor(HEAT1,r.pct/(rows[0].pct||1))};color:${r.pct/(rows[0].pct||1)>0.6?'#fff':'#1b222c'}">${r.pct.toFixed(1)}%</td></tr>`).join('');
  $('#sankey-table-card').innerHTML=`<div class="sec-label">Crosstab</div><div class="tbl-scroll"><table class="dt"><thead><tr><th>Most others</th><th>This person</th><th class="num">% resp.</th></tr></thead><tbody>${tb}</tbody></table></div>`;
}

load();
