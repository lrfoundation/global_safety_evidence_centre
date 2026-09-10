/* ============================================================
   Respondent Globe — Lloyd's Register Foundation / GSEC

   Every World Risk Poll respondent as one point of light, placed at a
   random point inside their own country.

   Sections, in order:
     CONST  — the ISO crosswalk and tunables
     DATA   — manifest + columnar binary decode
     GEO    — world-atlas load, polygon prep, rejection sampling
     SCENE  — three.js: sphere, land texture, atmosphere, stars, dots
     CAM    — hand-rolled spherical camera + flight easing
     PICK   — ray/sphere then nearest-dot over the typed array
     CARD   — respondent card rendering
     REEL   — the auto tour
     BOOT   — load sequence

   Served, not opened from disk: type="module" is fetched with CORS
   semantics, so file:// gives a blank page.
   ============================================================ */

import * as THREE from 'three';
import { REEL, SHORT_LABEL, GREATEST_SHORT, ANSWER_SHORT, HOMELAND } from './legends.js';

/* ---------- CONST ---------------------------------------------------- */

/* ISO 3166 numeric -> alpha-3. Lifted from wrp-explorer.js:748, which
   uses it for exactly this join. world-atlas keys features on numeric. */
const NUM2A3 = {"004":"AFG","008":"ALB","012":"DZA","016":"ASM","020":"AND","024":"AGO","028":"ATG","031":"AZE","032":"ARG","036":"AUS","040":"AUT","044":"BHS","048":"BHR","050":"BGD","051":"ARM","052":"BRB","056":"BEL","060":"BMU","064":"BTN","068":"BOL","070":"BIH","072":"BWA","076":"BRA","084":"BLZ","090":"SLB","096":"BRN","100":"BGR","104":"MMR","108":"BDI","112":"BLR","116":"KHM","120":"CMR","124":"CAN","132":"CPV","140":"CAF","144":"LKA","148":"TCD","152":"CHL","156":"CHN","158":"TWN","170":"COL","174":"COM","178":"COG","180":"COD","188":"CRI","191":"HRV","192":"CUB","196":"CYP","203":"CZE","204":"BEN","208":"DNK","212":"DMA","214":"DOM","218":"ECU","222":"SLV","226":"GNQ","231":"ETH","232":"ERI","233":"EST","242":"FJI","246":"FIN","250":"FRA","258":"PYF","262":"DJI","266":"GAB","268":"GEO","270":"GMB","275":"PSE","276":"DEU","288":"GHA","300":"GRC","308":"GRD","320":"GTM","324":"GIN","328":"GUY","332":"HTI","340":"HND","344":"HKG","348":"HUN","352":"ISL","356":"IND","360":"IDN","364":"IRN","368":"IRQ","372":"IRL","376":"ISR","380":"ITA","384":"CIV","388":"JAM","392":"JPN","398":"KAZ","400":"JOR","404":"KEN","408":"PRK","410":"KOR","414":"KWT","417":"KGZ","418":"LAO","422":"LBN","426":"LSO","428":"LVA","430":"LBR","434":"LBY","440":"LTU","442":"LUX","450":"MDG","454":"MWI","458":"MYS","462":"MDV","466":"MLI","470":"MLT","478":"MRT","480":"MUS","484":"MEX","496":"MNG","498":"MDA","499":"MNE","504":"MAR","508":"MOZ","512":"OMN","516":"NAM","524":"NPL","528":"NLD","540":"NCL","548":"VUT","554":"NZL","558":"NIC","562":"NER","566":"NGA","578":"NOR","586":"PAK","591":"PAN","598":"PNG","600":"PRY","604":"PER","608":"PHL","616":"POL","620":"PRT","624":"GNB","626":"TLS","630":"PRI","634":"QAT","642":"ROU","643":"RUS","646":"RWA","682":"SAU","686":"SEN","688":"SRB","694":"SLE","702":"SGP","703":"SVK","704":"VNM","705":"SVN","706":"SOM","710":"ZAF","716":"ZWE","724":"ESP","728":"SSD","729":"SDN","740":"SUR","748":"SWZ","752":"SWE","756":"CHE","760":"SYR","762":"TJK","764":"THA","768":"TGO","780":"TTO","784":"ARE","788":"TUN","792":"TUR","795":"TKM","800":"UGA","804":"UKR","807":"MKD","818":"EGY","826":"GBR","834":"TZA","840":"USA","854":"BFA","858":"URY","860":"UZB","862":"VEN","887":"YEM","894":"ZMB"};
const pad3 = s => ('00' + String(s)).slice(-3);

const DATA_DIR   = '../data/';
const MANIFEST   = DATA_DIR + 'wrp_explorer_trended.json';
const BIN_GZ     = DATA_DIR + 'wrp_explorer_trended.bin.gz';
const BIN_RAW    = DATA_DIR + 'wrp_explorer_trended.bin';
const WORLD_URLS = [
  'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json',
  'https://unpkg.com/world-atlas@2/countries-50m.json',
  'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json'
];

const WAVES    = [19, 21, 23, 25];
const R_DOT    = 1.004;   // clears the 96-segment sphere's facet sag (0.00054) 7x
const D_REST   = 3.4;
const D_CLOSE  = 2.35;
const SAMPLE_K = 64;      // sin-lat bucket rows
const MAX_TRY  = 64;

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Missingness is encoded differently by column family, and getting this
   wrong is silent:
     question columns  -> -1 (not asked that wave), 98 (DK), 99 (refused)
     0-100 indices     -> -1 only; 98 is a legitimate score
   Testing an index with `< 90` would quietly discard every score of 90+. */
const qOk = c => c > 0 && c < 90;
const iOk = c => c >= 0;

const fmt = n => n.toLocaleString('en-GB');

/* Deterministic RNG, so the tour is identical every run. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- state ---------------------------------------------------- */

const STORE = {};
let MAN = null, N = 0, COUNTRIES = [], Q = {}, DIM = {};
let positions = null, placedCount = 0;
let renderer, scene, camera, dots, dotGeo, dotMat, globeMesh, atmo, ring, stars;
let reel = [], reelIdx = -1, reelTimer = 0, selectedRow = -1;
let tourOn = true, spinOn = true, activeWave = -1, holdSpin = false;
const waveAlpha = [1, 1, 1, 1];

const el = id => document.getElementById(id);
const $loading = el('loading'), $fill = el('loading-fill'),
      $label = el('loading-label'), $sub = el('loading-sub');

function progress(pct, label, sub) {
  $fill.style.width = pct + '%';
  if (label !== undefined) $label.textContent = label;
  if (sub !== undefined) $sub.textContent = sub;
}
function fail(msg) {
  $loading.classList.add('err');
  $loading.classList.remove('done');
  $label.textContent = msg;
  $sub.textContent = 'The globe needs this to place respondents.';
}

/* ---------- DATA ----------------------------------------------------- */

/* Decode is the proven block from wrp-explorer.js:196-216: gzip first via
   DecompressionStream, raw .bin as fallback, then typed-array views at the
   manifest's byte offsets. i8 can view the buffer directly; i16/f32 must
   slice, because their offsets are not guaranteed to be aligned. */
async function loadWave() {
  MAN = await fetch(MANIFEST).then(r => {
    if (!r.ok) throw new Error('manifest ' + r.status);
    return r.json();
  });
  N = MAN.n;
  progress(12, 'Reaching ' + fmt(N) + ' responses', 'Downloading 9.7 MB');

  let buf;
  try {
    const res = await fetch(BIN_GZ);
    if (!res.ok) throw 0;
    if (!('DecompressionStream' in window)) throw 0;
    const ds = res.body.pipeThrough(new DecompressionStream('gzip'));
    buf = await new Response(ds).arrayBuffer();
  } catch (e) {
    buf = await fetch(BIN_RAW).then(r => {
      if (!r.ok) throw new Error('bin ' + r.status);
      return r.arrayBuffer();
    });
  }

  const view = c => {
    const o = c.off, l = c.len;
    if (c.dtype === 'i8')  return new Int8Array(buf, o, l);
    if (c.dtype === 'i16') return new Int16Array(buf.slice(o, o + l * 2));
    if (c.dtype === 'f32') return new Float32Array(buf.slice(o, o + l * 4));
  };
  MAN.columns.forEach(c => { STORE[c.key] = view(c); });
  COUNTRIES = MAN.countries;
  MAN.questions.forEach(q => { Q[q.key] = q; });
  MAN.dimensions.forEach(d => { DIM[d.key] = d; });
}

/* Answer label for a question key + code, straight from the manifest. */
function ansLabel(qkey, code) {
  const q = Q[qkey];
  if (!q) return null;
  const a = q.answers.find(x => x.code === code);
  return a ? a.label : null;
}
function ansColor(qkey, code) {
  const q = Q[qkey];
  if (!q) return '#e5006e';
  const a = q.answers.find(x => x.code === code);
  return (a && a.color) || '#e5006e';
}
function catLabel(dimKey, code) {
  const d = DIM[dimKey];
  if (!d || !d.cats) return null;
  const c = d.cats.find(x => x.code === code);
  return c ? c.label : null;
}

/* ---------- GEO ------------------------------------------------------ */

async function loadWorld() {
  for (const u of WORLD_URLS) {
    try {
      const t = await fetch(u).then(r => { if (!r.ok) throw 0; return r.json(); });
      return topojson.feature(t, t.objects.countries);
    } catch (e) { /* next */ }
  }
  throw new Error('world-atlas unreachable');
}

/* iso3 -> array of polygons (each an array of rings).

   Must ACCUMULATE, not assign: world-atlas id "036" is used twice, by
   Australia (42 polygons) and by Ashmore and Cartier Is. (1). A
   byId[f.id] = f map silently reduces Australia to a 5-vertex sliver in
   the Timor Sea and dumps a thousand dots there, with no error. */
function featuresByIso(world) {
  const map = new Map();
  for (const f of world.features) {
    let iso = f.id == null ? null : NUM2A3[pad3(f.id)];
    /* Kosovo has no ISO numeric code, so its feature carries no id at
       all and can only be matched by name. 4,088 respondents. */
    if (!iso && f.properties && f.properties.name === 'Kosovo') iso = 'XKX';
    if (!iso) continue;
    if (pad3(f.id) === '010') continue;               // Antarctica
    const polys = f.geometry.type === 'Polygon'
      ? [f.geometry.coordinates]
      : f.geometry.coordinates;
    if (!map.has(iso)) map.set(iso, []);
    const bucket = map.get(iso);
    for (const p of polys) bucket.push(p);
  }
  return map;
}

/* Signed spherical area of a ring, in steradians. Computed on raw degrees
   before the sin-lat transform, with dlon wrapped so antimeridian rings
   still integrate correctly. */
function ringArea(ring) {
  let total = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % n];
    let d = (lon2 - lon1) * Math.PI / 180;
    while (d >  Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    total += d * (2 + Math.sin(lat1 * Math.PI / 180) + Math.sin(lat2 * Math.PI / 180));
  }
  return Math.abs(total / 2);
}

/* Prepare one polygon for sampling.

   Everything is transformed once into (lon, sin lat) space. In that plane
   a uniform rectangle sample IS a uniform sphere sample, so equal-area
   placement falls out for free and point-in-polygon becomes a plain 2-D
   crossing test. */
function prepPoly(rings) {
  let total = 0;
  for (const r of rings) total += r.length;

  const xy = new Float64Array(total * 2);
  const ringStart = new Int32Array(rings.length + 1);
  let k = 0;
  let lo = 180, hi = -180, slo = 1, shi = -1;

  for (let ri = 0; ri < rings.length; ri++) {
    ringStart[ri] = k;
    for (const [lon, lat] of rings[ri]) {
      const s = Math.sin(lat * Math.PI / 180);
      xy[k * 2] = lon; xy[k * 2 + 1] = s;
      if (lon < lo) lo = lon;
      if (lon > hi) hi = lon;
      if (s < slo) slo = s;
      if (s > shi) shi = s;
      k++;
    }
  }
  ringStart[rings.length] = k;

  /* Bucket the edges by sin-lat row. Without this, sampling Russia means
     testing a 4,894-vertex ring on every attempt. With it, each attempt
     touches only the edges that span the sampled row. */
  const h = (shi - slo) / SAMPLE_K || 1;
  const bucket = [];
  for (let i = 0; i < SAMPLE_K; i++) bucket.push([]);
  for (let ri = 0; ri < rings.length; ri++) {
    const a = ringStart[ri], b = ringStart[ri + 1];
    for (let i = a; i < b; i++) {
      const j = (i + 1 === b) ? a : i + 1;
      const y0 = xy[i * 2 + 1], y1 = xy[j * 2 + 1];
      if (y0 === y1) continue;
      let r0 = Math.floor((Math.min(y0, y1) - slo) / h);
      let r1 = Math.floor((Math.max(y0, y1) - slo) / h);
      r0 = Math.max(0, Math.min(SAMPLE_K - 1, r0));
      r1 = Math.max(0, Math.min(SAMPLE_K - 1, r1));
      for (let r = r0; r <= r1; r++) bucket[r].push(i, j);
    }
  }

  let area = ringArea(rings[0]);
  for (let ri = 1; ri < rings.length; ri++) area -= ringArea(rings[ri]);

  return {
    xy, ringStart, bucket, h,
    lo, hi, slo, shi,
    area: Math.max(area, 1e-12),
    cLon: (lo + hi) / 2,
    cLat: Math.asin(Math.max(-1, Math.min(1, (slo + shi) / 2))) * 180 / Math.PI
  };
}

/* Even-odd crossing test in (lon, sin lat) space. Holes and the outer ring
   share one edge pool, so a single parity count is correct: a point inside
   a hole picks up an odd extra crossing and flips back to outside. */
function pointInPoly(P, px, py) {
  let row = Math.floor((py - P.slo) / P.h);
  if (row < 0 || row >= SAMPLE_K) return false;
  const b = P.bucket[row], xy = P.xy;
  let inside = false;
  for (let n = 0; n < b.length; n += 2) {
    const i = b[n], j = b[n + 1];
    const xi = xy[i * 2], yi = xy[i * 2 + 1];
    const xj = xy[j * 2], yj = xy[j * 2 + 1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function samplePoly(P, rnd) {
  for (let t = 0; t < MAX_TRY; t++) {
    const px = P.lo + rnd() * (P.hi - P.lo);
    const py = P.slo + rnd() * (P.shi - P.slo);
    if (pointInPoly(P, px, py)) return [px, py];
  }
  return null;
}

/* Build per-country sampling sets, applying the HOMELAND filter that drops
   distant overseas territories before area weighting. */
function buildCountryGeo(geoByIso) {
  const out = new Map();
  for (const [iso, polys] of geoByIso) {
    let preps = polys.map(prepPoly);
    const box = HOMELAND[iso];
    if (box) {
      const keep = preps.filter(P =>
        P.cLon >= box[0] && P.cLon <= box[2] && P.cLat >= box[1] && P.cLat <= box[3]);
      if (keep.length) preps = keep;
    }
    let sum = 0;
    const cum = new Float64Array(preps.length);
    for (let i = 0; i < preps.length; i++) { sum += preps[i].area; cum[i] = sum; }
    out.set(iso, { preps, cum, sum });
  }
  return out;
}

function pickPoly(g, rnd) {
  const u = rnd() * g.sum;
  let lo = 0, hi = g.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (g.cum[mid] < u) lo = mid + 1; else hi = mid;
  }
  return g.preps[lo];
}

/* Place every respondent. Dot i IS row i — that alignment is what makes
   picking, colouring and the reel free downstream. Runs in rAF slices so
   the globe keeps spinning and the dots visibly rain in country by country. */
function placeDots(cgeo, onDone) {
  const rnd = mulberry32(20260910);
  const cc = STORE.country;

  /* Group rows by country so each country's polygon prep is touched once
     and the reveal reads as one country at a time. */
  const order = new Int32Array(N);
  const counts = new Int32Array(COUNTRIES.length);
  for (let i = 0; i < N; i++) if (cc[i] >= 0) counts[cc[i]]++;
  const starts = new Int32Array(COUNTRIES.length + 1);
  for (let g = 0; g < COUNTRIES.length; g++) starts[g + 1] = starts[g] + counts[g];
  const cursor = starts.slice();
  for (let i = 0; i < N; i++) if (cc[i] >= 0) order[cursor[cc[i]]++] = i;

  const missing = new Set();
  let idx = 0, fallbacks = 0;

  function chunk() {
    const t0 = performance.now();
    const stop = Math.min(N, idx + 6000);
    while (idx < stop && performance.now() - t0 < 14) {
      const row = order[idx];
      const g = cc[row];
      const iso = COUNTRIES[g] && COUNTRIES[g].iso3;
      const cg = iso ? cgeo.get(iso) : null;
      let lon = 0, sLat = 0, ok = false;

      if (cg && cg.preps.length) {
        const P = pickPoly(cg, rnd);
        const p = samplePoly(P, rnd);
        if (p) { lon = p[0]; sLat = p[1]; ok = true; }
        else {
          /* Exhausted the attempt cap: fall back to a vertex of the
             chosen ring rather than stalling or dropping the row. */
          const n = P.ringStart[1] || 1;
          const v = Math.floor(rnd() * n);
          lon = P.xy[v * 2]; sLat = P.xy[v * 2 + 1];
          ok = true; fallbacks++;
        }
      } else if (iso) {
        missing.add(iso);
      }

      if (ok) {
        const lat = Math.asin(Math.max(-1, Math.min(1, sLat)));
        const lam = lon * Math.PI / 180;
        const cl = Math.cos(lat);
        positions[row * 3]     = R_DOT * cl * Math.cos(lam);
        positions[row * 3 + 1] = R_DOT * Math.sin(lat);
        positions[row * 3 + 2] = -R_DOT * cl * Math.sin(lam);
        placedCount++;
      }  /* else: leave it parked beyond the far plane */
      idx++;
    }

    if (dotGeo) dotGeo.attributes.position.needsUpdate = true;
    const pct = 55 + 40 * (idx / N);
    progress(pct, 'Placing respondents', fmt(placedCount) + ' of ' + fmt(N));

    if (idx < N) requestAnimationFrame(chunk);
    else onDone({ missing: [...missing], fallbacks });
  }
  requestAnimationFrame(chunk);
}

/* ---------- land texture --------------------------------------------- */

/* Equirectangular canvas, used as the sphere's map. A texture rather than
   line geometry: 80k coastline vertices as lines shimmer and z-fight at
   grazing angles, and line width is unreliable across drivers. */
function drawLandCanvas(world, W = 4096, H = 2048) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  g.fillStyle = '#080b14';
  g.fillRect(0, 0, W, H);

  const X = lon => (lon + 180) / 360 * W;
  const Y = lat => (90 - lat) / 180 * H;

  g.beginPath();
  for (const f of world.features) {
    if (pad3(f.id) === '010') continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      for (const ring of poly) {
        for (let i = 0; i < ring.length; i++) {
          const x = X(ring[i][0]), y = Y(ring[i][1]);
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.closePath();
      }
    }
  }
  g.fillStyle = '#141b2b';
  g.fill('evenodd');
  g.strokeStyle = '#33405f';
  g.lineWidth = 1.6;
  g.stroke();

  g.strokeStyle = 'rgba(255,255,255,0.045)';
  g.lineWidth = 1;
  g.beginPath();
  for (let lon = -180; lon <= 180; lon += 15) { g.moveTo(X(lon), 0); g.lineTo(X(lon), H); }
  for (let lat = -75; lat <= 75; lat += 15) { g.moveTo(0, Y(lat)); g.lineTo(W, Y(lat)); }
  g.stroke();

  return cv;
}

/* ---------- SCENE ---------------------------------------------------- */

const PINK = new THREE.Color('#e5006e').convertSRGBToLinear();

function initScene() {
  const canvas = el('globe-canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);

  globeMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 128, 96),
    new THREE.MeshBasicMaterial({ color: 0x0a0e1a })
  );
  globeMesh.renderOrder = 0;
  scene.add(globeMesh);

  /* Atmosphere: a back-side shell with a fresnel falloff. Reads as an LRF
     rim light without tinting the planet itself. */
  atmo = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 48),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uPink: { value: PINK } },
      vertexShader: `
        varying vec3 vN; varying vec3 vV;
        void main(){
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uPink; varying vec3 vN; varying vec3 vV;
        void main(){
          float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
          float i = clamp(pow(f, 3.5), 0.0, 1.0);
          vec3 c = mix(vec3(0.16,0.10,0.29), uPink, 0.38);
          gl_FragColor = vec4(c * i * 1.1, i * 0.85);
        }`
    })
  );
  atmo.scale.setScalar(1.16);
  atmo.renderOrder = 2;
  scene.add(atmo);

  /* Stars */
  const sN = 2500, sp = new Float32Array(sN * 3), ss = new Float32Array(sN);
  const rnd = mulberry32(7);
  for (let i = 0; i < sN; i++) {
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    sp[i * 3] = 90 * r * Math.cos(th); sp[i * 3 + 1] = 90 * u; sp[i * 3 + 2] = 90 * r * Math.sin(th);
    ss[i] = 0.6 + rnd() * 1.6;
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  sg.setAttribute('aSize', new THREE.BufferAttribute(ss, 1));
  stars = new THREE.Points(sg, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uPR: { value: Math.min(devicePixelRatio, 2) } },
    vertexShader: `
      attribute float aSize; uniform float uPR; varying float vS;
      void main(){ vS = aSize; gl_PointSize = aSize * uPR;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying float vS;
      void main(){ float d = length(gl_PointCoord - 0.5); if(d > 0.5) discard;
        gl_FragColor = vec4(0.75,0.80,0.95, (1.0 - d*2.0) * 0.55); }`
  }));
  stars.renderOrder = -1;
  scene.add(stars);

  /* Pulse ring for the reel's current dot — a billboarded annulus. The
     in-shader size throb alone is invisible from the back of a room. */
  ring = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uT: { value: 0 }, uPink: { value: PINK } },
      vertexShader: `varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform float uT; uniform vec3 uPink; varying vec2 vUv;
        void main(){
          float d = length(vUv - 0.5) * 2.0;
          float p = fract(uT / 1.3);
          float r = mix(0.18, 1.0, p);
          float a = smoothstep(0.06, 0.0, abs(d - r)) * (1.0 - p);
          gl_FragColor = vec4(uPink, a * 0.9);
        }`
    })
  );
  ring.visible = false;
  ring.renderOrder = 3;
  scene.add(ring);

  resize();
  window.addEventListener('resize', resize);
}

function initDots() {
  positions = new Float32Array(N * 3);
  /* Park every dot beyond the far plane (400) until it is placed, so an
     unplaced row is clipped rather than drawn at the centre of the globe. */
  for (let i = 0; i < N; i++) positions[i * 3 + 1] = 9999;
  dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const seed = new Float32Array(N), wave = new Float32Array(N), flag = new Float32Array(N);
  const rnd = mulberry32(99);
  const yc = STORE.year_code;
  for (let i = 0; i < N; i++) {
    seed[i] = rnd();
    wave[i] = Math.max(0, WAVES.indexOf(yc[i]));
  }
  dotGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  dotGeo.setAttribute('aWave', new THREE.BufferAttribute(wave, 1));
  dotGeo.setAttribute('aFlag', new THREE.BufferAttribute(flag, 1));
  dotGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);

  dotMat = new THREE.ShaderMaterial({
    transparent: true, depthTest: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uSize:    { value: 0.0065 },
      uOpacity: { value: 0.13 },
      uPR:      { value: Math.min(devicePixelRatio, 2) },
      uProj:    { value: 900 },
      uTime:    { value: 0 },
      uCamPos:  { value: new THREE.Vector3() },
      uPink:    { value: PINK },
      uWaveA:   { value: new THREE.Vector4(1, 1, 1, 1) }
    },
    vertexShader: `
      attribute float aSeed; attribute float aWave; attribute float aFlag;
      uniform float uSize, uOpacity, uPR, uTime, uProj;
      uniform vec3 uCamPos; uniform vec4 uWaveA;
      varying float vA; varying float vHot;
      void main(){
        float wa = aWave < 0.5 ? uWaveA.x : (aWave < 1.5 ? uWaveA.y : (aWave < 2.5 ? uWaveA.z : uWaveA.w));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        /* Facing test, not a depth test: dots just past the limb project
           OUTSIDE the sphere silhouette, so depth alone would keep them.
           The smoothstep also dissolves them over ~20 degrees instead of
           popping at the edge. */
        float facing = dot(normalize(position), normalize(uCamPos - position));
        vA = smoothstep(-0.05, 0.30, facing) * uOpacity * wa;
        vHot = aFlag;
        float s = uSize * (0.80 + 0.45 * aSeed);
        if (aFlag > 0.5) s *= 3.0 + 1.6 * sin(uTime * 4.0);
        float px = s * uProj / max(0.001, -mv.z) * uPR;
        gl_PointSize = wa < 0.01 ? 0.0 : max(px, aFlag > 0.5 ? 6.0 : 0.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uPink; varying float vA; varying float vHot;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.50, 0.14, d);
        float core = pow(max(0.0, 1.0 - d * 2.0), 3.0);
        vec3 c = mix(uPink, vec3(1.0), vHot * 0.55);
        gl_FragColor = vec4(c * (0.85 + 0.55 * core), a * vA);
      }`
  });

  {
    const h = renderer.domElement.clientHeight || 700;
    dotMat.uniforms.uProj.value = (h / 2) / Math.tan(camera.fov * Math.PI / 360);
  }
  dots = new THREE.Points(dotGeo, dotMat);
  dots.frustumCulled = false;
  dots.renderOrder = 1;
  scene.add(dots);
}

function resize() {
  const s = el('stage');
  const w = s.clientWidth, h = s.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  if (dotMat) dotMat.uniforms.uProj.value = (h / 2) / Math.tan(camera.fov * Math.PI / 360);
  applyViewOffset();
}

/* ---------- CAM ------------------------------------------------------ */

const CAM = {
  lat: 12, lon: 0, dist: D_REST,
  sLat: 0, sLon: 0, sDist: 0, fLat: 0, fLon: 0, fDist: 0,
  t0: 0, dur: 0, flying: false,
  spin: REDUCED ? 0 : 0.055,
  offX: 0, offXT: 0
};

function applyViewOffset() {
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  if (Math.abs(CAM.offX) < 0.5) camera.clearViewOffset();
  else camera.setViewOffset(w, h, CAM.offX, 0, w, h);
  camera.updateProjectionMatrix();
}

function updateCamera(dt) {
  if (CAM.flying) {
    const p = Math.min(1, (performance.now() - CAM.t0) / CAM.dur);
    const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    CAM.lat  = CAM.sLat  + (CAM.fLat  - CAM.sLat)  * e;
    CAM.lon  = CAM.sLon  + (CAM.fLon  - CAM.sLon)  * e;
    CAM.dist = CAM.sDist + (CAM.fDist - CAM.sDist) * e;
    if (p >= 1) CAM.flying = false;
  } else if (spinOn && !holdSpin) {
    CAM.lon += CAM.spin * dt * 180 / Math.PI * 0.35;
  }

  CAM.offX += (CAM.offXT - CAM.offX) * Math.min(1, dt * 5);
  applyViewOffset();

  const la = CAM.lat * Math.PI / 180, lo = CAM.lon * Math.PI / 180;
  const cl = Math.cos(la);
  camera.position.set(
    CAM.dist * cl * Math.cos(lo),
    CAM.dist * Math.sin(la),
    -CAM.dist * cl * Math.sin(lo)
  );
  camera.lookAt(0, 0, 0);
}

function flyTo(lat, lon, dist, ms) {
  CAM.sLat = CAM.lat; CAM.sLon = CAM.lon; CAM.sDist = CAM.dist;
  CAM.fLat = lat;
  /* shortest arc in longitude */
  let d = ((lon - CAM.lon + 540) % 360) - 180;
  CAM.fLon = CAM.lon + d;
  CAM.fDist = dist;
  CAM.t0 = performance.now();
  CAM.dur = REDUCED ? 400 : (ms || 2200);
  CAM.flying = true;
}

function xyzToLatLon(x, y, z) {
  const r = Math.sqrt(x * x + y * y + z * z);
  const lat = Math.asin(y / r) * 180 / Math.PI;
  const lon = Math.atan2(-z, x) * 180 / Math.PI;
  return [lat, lon];
}

/* drag + wheel */
function initControls() {
  const cv = el('globe-canvas');
  let down = false, px = 0, py = 0, moved = 0;

  cv.addEventListener('pointerdown', e => {
    down = true; moved = 0; px = e.clientX; py = e.clientY;
    cv.setPointerCapture(e.pointerId); cv.classList.add('dragging');
  });
  cv.addEventListener('pointermove', e => {
    if (down) {
      const dx = e.clientX - px, dy = e.clientY - py;
      moved += Math.abs(dx) + Math.abs(dy);
      px = e.clientX; py = e.clientY;
      CAM.lon -= dx * 0.25;
      CAM.lat = Math.max(-85, Math.min(85, CAM.lat + dy * 0.25));
      CAM.flying = false;
      manual();
    } else {
      hoverAt(e.clientX, e.clientY);
    }
  });
  cv.addEventListener('pointerup', e => {
    down = false; cv.classList.remove('dragging');
    if (moved < 5) clickAt(e.clientX, e.clientY);
  });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    CAM.dist = Math.max(1.5, Math.min(8, CAM.dist * (1 + Math.sign(e.deltaY) * 0.08)));
    CAM.flying = false;
    manual();
  }, { passive: false });

  window.addEventListener('keydown', e => {
    if (e.key === ' ') { e.preventDefault(); setTour(!tourOn); }
    else if (e.key === 'ArrowRight') { manual(); advanceReel(); }
    else if (e.key === 'ArrowLeft')  { manual(); reelIdx -= 2; advanceReel(); }
    else if (e.key === 'Escape') closeCard();
    else if (e.key === 'r' || e.key === 'R') { flyTo(12, CAM.lon, D_REST, 900); }
    else if (e.key === 'f' || e.key === 'F') toggleFull();
    else if (e.key === '+' || e.key === '=') dotMat.uniforms.uSize.value = Math.min(0.05, dotMat.uniforms.uSize.value * 1.15);
    else if (e.key === '-' || e.key === '_') dotMat.uniforms.uSize.value = Math.max(0.001, dotMat.uniforms.uSize.value / 1.15);
    else if (e.key === '[') dotMat.uniforms.uOpacity.value = Math.max(0.1, dotMat.uniforms.uOpacity.value - 0.06);
    else if (e.key === ']') dotMat.uniforms.uOpacity.value = Math.min(1.5, dotMat.uniforms.uOpacity.value + 0.06);
  });
}

function toggleFull() {
  const s = el('stage');
  if (!document.fullscreenElement) s.requestFullscreen && s.requestFullscreen();
  else document.exitFullscreen();
  setTimeout(resize, 120);
}

/* ---------- PICK ----------------------------------------------------- */

const _ray = new THREE.Raycaster();
const _v = new THREE.Vector3();

/* Analytic ray/unit-sphere intersection, near root only — that point is on
   the visible hemisphere by construction, so back-facing dots are excluded
   with no extra test. Then one flat pass over the position array. */
function pickAt(cx, cy) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((cx - rect.left) / rect.width) * 2 - 1,
    -((cy - rect.top) / rect.height) * 2 + 1
  );
  _ray.setFromCamera(ndc, camera);
  const o = _ray.ray.origin, d = _ray.ray.direction;
  const b = 2 * (o.x * d.x + o.y * d.y + o.z * d.z);
  const c = o.x * o.x + o.y * o.y + o.z * o.z - R_DOT * R_DOT;
  const disc = b * b - 4 * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / 2;
  if (t < 0) return -1;
  const hx = o.x + d.x * t, hy = o.y + d.y * t, hz = o.z + d.z * t;

  /* screen radius -> world radius at this distance */
  const h = rect.height;
  const rWorld = (16 / h) * 2 * Math.tan(camera.fov * Math.PI / 360) * CAM.dist;
  const r2max = rWorld * rWorld;

  let best = -1, bd = Infinity;
  const p = positions, yc = STORE.year_code;
  for (let i = 0; i < N; i++) {
    if (activeWave >= 0 && yc[i] !== activeWave) continue;
    const j = i * 3;
    const dx = p[j] - hx, dy = p[j + 1] - hy, dz = p[j + 2] - hz;
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd < bd) { bd = dd; best = i; }
  }
  return bd <= r2max ? best : -1;
}

let hoverPending = false;
function hoverAt(cx, cy) {
  if (hoverPending || !positions) return;
  hoverPending = true;
  requestAnimationFrame(() => {
    hoverPending = false;
    const r = pickAt(cx, cy);
    el('globe-canvas').classList.toggle('over-dot', r >= 0);
  });
}

function clickAt(cx, cy) {
  if (!positions) return;
  const r = pickAt(cx, cy);
  if (r < 0) return;
  manual();
  showCard(r, null);
  const [lat, lon] = xyzToLatLon(positions[r * 3], positions[r * 3 + 1], positions[r * 3 + 2]);
  flyTo(lat, lon, Math.min(CAM.dist, D_CLOSE), 1100);
}

/* ---------- CARD ----------------------------------------------------- */

/* Country names in the manifest that need a definite article in prose. */
const THE = new Set(['United Kingdom', 'United States', 'Netherlands', 'Philippines',
  'Dominican Republic', 'Czech Republic', 'Gambia', 'Comoros', 'Maldives',
  'Central African Republic', 'United Arab Emirates']);
const theCountry = n => (THE.has(n) ? 'the ' + n : n);

function lower(s) {
  if (!s) return s;
  return /^[A-Z]{2,}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function shortAnswer(qkey, code) {
  if (ANSWER_SHORT[qkey] && ANSWER_SHORT[qkey][code]) return ANSWER_SHORT[qkey][code];
  if (qkey === 'greatest') return GREATEST_SHORT[code] || 'something else';
  return lower(ansLabel(qkey, code) || '');
}

/* The headline sentence. Built to match the brief's example exactly:
   "Nobby Solano thinks climate change is a very serious threat and is
    most concerned about road traffic." */
function sentenceFor(row, name, avoid) {
  const av = avoid || [];
  const parts = [];
  const climate = STORE[Q.climate.col][row];
  const greatest = STORE[Q.greatest.col][row];

  if (!av.includes('climate') && qOk(climate)) {
    parts.push('thinks climate change is <b>' + shortAnswer('climate', climate) + '</b>');
  }
  if (qOk(greatest)) {
    if (greatest === 23) parts.push('says <b>nothing</b> in daily life feels like a real risk');
    else if (greatest === 22) parts.push('names something else entirely as the greatest risk to their safety');
    else parts.push('is most concerned about <b>' + shortAnswer('greatest', greatest) + '</b>');
  }

  if (parts.length < 2) {
    for (const k of ['crime', 'water', 'food', 'work', 'mental_health', 'traffic']) {
      if (parts.length >= 2) break;
      if (av.includes(k) || !Q[k]) continue;
      const c = STORE[Q[k].col][row];
      if (!qOk(c)) continue;
      parts.push('says they are <b>' + shortAnswer(k, c) + '</b> that ' +
        SHORT_LABEL[k].replace(/^Worried about /, '').toLowerCase() + ' could cause them serious harm');
    }
  }
  if (!parts.length) return name + ' answered the World Risk Poll.';
  return name + ' ' + parts.join(', and ') + '.';
}

/* Up to three quoted answers as the evidence under the sentence. */
function evidenceRows(row, avoid) {
  const av = avoid || [];
  const pref = ['greatest', 'climate', 'safer_5yr', 'fin_res', 'crime', 'weather',
                'water', 'food', 'work', 'traffic', 'mental_health', 'govt_cares'];
  const out = [];
  for (const k of pref) {
    if (out.length >= 3) break;
    if (av.includes(k) || !Q[k]) continue;
    const c = STORE[Q[k].col][row];
    if (!qOk(c)) continue;
    let text = ansLabel(k, c);
    if (k === 'greatest') text = GREATEST_SHORT[c] || text;
    out.push({ label: SHORT_LABEL[k] || Q[k].label, text, color: ansColor(k, c) });
  }
  return out;
}

function demoLine(row) {
  const bits = [];
  const g = STORE.country[row];
  if (COUNTRIES[g]) bits.push(COUNTRIES[g].name);
  const gen = catLabel('gender', STORE.Gender[row]);
  const age = catLabel('age_5', STORE.AgeGroups5[row]);
  if (gen && age) bits.push(gen + ', ' + age);
  else if (age) bits.push(age);
  const urb = STORE.Urbanicity[row];
  if (urb > 0 && urb !== 9) {
    const u = catLabel('urban_rural', urb);
    if (u) bits.push(lower(u.replace(/^A /, '')));
  }
  return bits.join(' · ');
}

function meter(label, val) {
  if (!iOk(val)) return '';
  return '<div class="meter-row"><div class="meter-head"><span>' + label +
    '</span><b>' + val + '/100</b></div><div class="meter-track">' +
    '<div class="meter-fill" style="width:' + val + '%"></div></div></div>';
}

function showCard(row, legend) {
  selectedRow = row;
  const g = STORE.country[row];
  const year = STORE.year_code[row];
  const country = COUNTRIES[g] ? COUNTRIES[g].name : '';
  const avoid = legend && legend.avoid;

  el('card-eyebrow').textContent = 'World Risk Poll 20' + year + ' · ' + country;
  el('card-name').textContent = legend ? legend.name : 'Respondent ' + fmt(row);
  el('card-club').textContent = legend ? legend.club : '';
  el('card-club').style.display = legend ? '' : 'none';
  el('card-demo').textContent = demoLine(row);

  const name = legend ? legend.name : 'This respondent';
  el('card-quote').innerHTML = sentenceFor(row, name, avoid);

  el('card-rows').innerHTML = evidenceRows(row, avoid).map(r =>
    '<div class="qrow"><div class="qchip" style="background:' + r.color + '"></div>' +
    '<div><div class="qlabel">' + r.label + '</div><div class="qans">' + r.text + '</div></div></div>'
  ).join('');

  el('card-meters').innerHTML =
    meter('Worry index', STORE.worry_index_published[row]) +
    meter('Resilience index', STORE.resilience_index[row]);

  el('card-note').innerHTML = legend
    ? 'A real, anonymous World Risk Poll response from ' + theCountry(country) +
      '. The name is an illustrative persona — a Newcastle United legend from the same country — not the respondent.'
    : 'A real, anonymous World Risk Poll response from ' + theCountry(country) + '.';

  const card = el('card');
  card.hidden = false;
  card.classList.remove('leaving');
  holdSpin = true;
  CAM.offXT = -Math.round(renderer.domElement.clientWidth * 0.16);

  const flag = dotGeo.attributes.aFlag;
  flag.array.fill(0);
  flag.array[row] = 1;
  flag.needsUpdate = true;
  ring.visible = true;
}

function closeCard() {
  const card = el('card');
  if (card.hidden) return;
  card.classList.add('leaving');
  setTimeout(() => { card.hidden = true; }, 320);
  CAM.offXT = 0;
  holdSpin = false;
  selectedRow = -1;
  ring.visible = false;
  if (dotGeo) {
    dotGeo.attributes.aFlag.array.fill(0);
    dotGeo.attributes.aFlag.needsUpdate = true;
  }
}

/* ---------- REEL ----------------------------------------------------- */

/* Pick one real respondent per legend. Prefers the most recent wave that
   asked the questions the card wants, and scores for a card that actually
   says something: a definite opinion beats "somewhat worried about
   everything", and an unusual greatest-risk beats the country's modal one. */
function buildReel() {
  const rnd = mulberry32(4242);
  const cc = STORE.country, yc = STORE.year_code;
  const isoToIdx = new Map();
  COUNTRIES.forEach((c, i) => isoToIdx.set(c.iso3, i));

  const out = [];
  for (const L of REEL) {
    const g = isoToIdx.get(L.iso3);
    if (g === undefined) { console.warn('reel: no country for', L.iso3); continue; }

    /* modal greatest-risk for this country, to reward the unusual answer */
    const freq = new Map();
    for (let i = 0; i < N; i++) {
      if (cc[i] !== g) continue;
      const v = STORE[Q.greatest.col][i];
      if (qOk(v)) freq.set(v, (freq.get(v) || 0) + 1);
    }
    let modal = -1, mc = 0;
    for (const [k, v] of freq) if (v > mc) { mc = v; modal = k; }

    let best = -1, bestScore = -1e9;
    for (let i = 0; i < N; i++) {
      if (cc[i] !== g) continue;
      const cl = STORE[Q.climate.col][i], gr = STORE[Q.greatest.col][i];
      if (!qOk(gr)) continue;
      if (STORE.Gender[i] <= 0 || STORE.AgeGroups5[i] <= 0) continue;
      const avoidClimate = L.avoid && L.avoid.includes('climate');
      if (!avoidClimate && !qOk(cl)) continue;

      let s = 0;
      s += (yc[i] - 19) * 0.6;                       // prefer recent waves
      if (!avoidClimate && (cl === 1 || cl === 3)) s += 2;
      if (gr === 22 || gr === 23) s -= 5;      // 'other' / 'nothing' make a dead card
      if (gr !== modal) s += 1.5;
      const ri = STORE.resilience_index[i];
      if (iOk(ri) && (ri >= 80 || ri <= 25)) s += 1;
      if (iOk(STORE.worry_index_published[i])) s += 0.5;
      s += rnd() * 0.4;
      if (s > bestScore) { bestScore = s; best = i; }
    }
    if (best >= 0) out.push({ ...L, row: best });
    else console.warn('reel: no eligible respondent for', L.iso3);
  }
  return out;
}

function advanceReel() {
  if (!reel.length) return;
  reelIdx = (reelIdx + 1 + reel.length) % reel.length;
  const e = reel[reelIdx];
  const r = e.row;
  closeCard();
  const [lat, lon] = xyzToLatLon(positions[r * 3], positions[r * 3 + 1], positions[r * 3 + 2]);
  flyTo(lat, lon, D_CLOSE, 2200);
  setTimeout(() => showCard(r, e), REDUCED ? 200 : 1500);
  reelTimer = performance.now() + (REDUCED ? 6000 : 10500);
}

function setTour(on) {
  tourOn = on;
  el('btn-tour').textContent = on ? 'Pause tour' : 'Resume tour';
  el('btn-tour').classList.toggle('off', !on);
  el('pill').classList.toggle('show', !on);
  if (on) reelTimer = performance.now() + 600;
}
function manual() {
  el('stage-hint').classList.add('hide');
  if (tourOn) setTour(false);
}

/* ---------- reticle -------------------------------------------------- */

function drawReticle() {
  const svg = el('reticle');
  if (selectedRow < 0 || el('card').hidden) { svg.innerHTML = ''; return; }
  const p = _v.set(positions[selectedRow * 3], positions[selectedRow * 3 + 1], positions[selectedRow * 3 + 2]).clone();
  const world = p.clone();
  p.project(camera);
  const rect = renderer.domElement.getBoundingClientRect();
  const x = (p.x * 0.5 + 0.5) * rect.width;
  const y = (-p.y * 0.5 + 0.5) * rect.height;

  /* hide when the dot is round the back */
  const toCam = camera.position.clone().sub(world);
  if (world.dot(toCam) < 0) { svg.innerHTML = ''; return; }

  const card = el('card').getBoundingClientRect();
  const cx = card.left - rect.left, cy = card.top - rect.top + 40;
  svg.setAttribute('viewBox', '0 0 ' + rect.width + ' ' + rect.height);
  svg.innerHTML =
    '<line x1="' + x + '" y1="' + y + '" x2="' + cx + '" y2="' + cy +
    '" stroke="#e5006e" stroke-width="1" opacity="0.5"/>' +
    '<circle cx="' + x + '" cy="' + y + '" r="5" fill="none" stroke="#e5006e" stroke-width="1.2" opacity="0.9"/>';
}

/* ---------- waves ---------------------------------------------------- */

function initWaveUI() {
  const box = el('hud-waves');
  const mk = (label, val) => {
    const b = document.createElement('button');
    b.className = 'wave-btn' + (val === -1 ? ' on' : '');
    b.textContent = label;
    b.onclick = () => {
      activeWave = val;
      [...box.children].forEach(c => c.classList.remove('on'));
      b.classList.add('on');
    };
    box.appendChild(b);
  };
  mk('All waves', -1);
  WAVES.forEach(w => mk('20' + w, w));
}

/* ---------- loop ----------------------------------------------------- */

let last = performance.now();
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  updateCamera(dt);

  if (dotMat) {
    dotMat.uniforms.uTime.value = now / 1000;
    dotMat.uniforms.uCamPos.value.copy(camera.position);
    for (let i = 0; i < 4; i++) {
      const want = (activeWave < 0 || WAVES[i] === activeWave) ? 1 : 0;
      waveAlpha[i] += (want - waveAlpha[i]) * Math.min(1, dt * 4);
    }
    dotMat.uniforms.uWaveA.value.set(waveAlpha[0], waveAlpha[1], waveAlpha[2], waveAlpha[3]);
  }

  if (ring.visible && selectedRow >= 0) {
    ring.position.set(positions[selectedRow * 3], positions[selectedRow * 3 + 1], positions[selectedRow * 3 + 2]);
    ring.lookAt(camera.position);
    ring.scale.setScalar(0.22);
    ring.material.uniforms.uT.value = now / 1000;
  }

  if (tourOn && reel.length && now > reelTimer) advanceReel();

  drawReticle();
  renderer.render(scene, camera);
}

/* ---------- BOOT ----------------------------------------------------- */

async function boot() {
  initScene();
  initControls();
  initWaveUI();
  loop();

  el('card-close').onclick = closeCard;
  el('btn-tour').onclick = () => setTour(!tourOn);
  el('btn-spin').onclick = () => {
    spinOn = !spinOn;
    el('btn-spin').textContent = spinOn ? 'Pause spin' : 'Resume spin';
    el('btn-spin').classList.toggle('off', !spinOn);
  };
  el('btn-full').onclick = toggleFull;

  let world;
  try {
    progress(5, 'Reaching the World Risk Poll…', '');
    const pWorld = loadWorld();
    const pWave = loadWave();
    world = await pWorld;
    progress(30, 'Drawing ' + world.features.length + ' countries', '');
    const tex = new THREE.CanvasTexture(drawLandCanvas(world));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    globeMesh.material = new THREE.MeshBasicMaterial({ map: tex });
    await pWave;
  } catch (e) {
    console.error(e);
    fail('The country boundary file could not be reached.');
    return;
  }

  progress(50, 'Preparing ' + fmt(COUNTRIES.length) + ' countries', '');
  const geoByIso = featuresByIso(world);

  const unmatched = COUNTRIES.filter(c => !geoByIso.has(c.iso3)).map(c => c.iso3);
  if (unmatched.length) console.warn('No polygon for:', unmatched.join(', '));

  const cgeo = buildCountryGeo(geoByIso);
  el('stat-n').textContent = fmt(N);

  initDots();
  placeDots(cgeo, ({ missing, fallbacks }) => {
    reel = buildReel();
    $loading.classList.add('done');

    const dq = 'Placed ' + fmt(placedCount) + ' of ' + fmt(N) + ' respondents' +
      (missing.length ? ' · no boundary for ' + missing.join(', ') : '') +
      (fallbacks ? ' · ' + fmt(fallbacks) + ' edge placements' : '') +
      ' · ' + reel.length + ' in the tour';
    el('data-quality').textContent = dq;
    console.log('[globe]', dq);

    reelTimer = performance.now() + 3500;
    setTimeout(() => el('stage-hint').classList.add('hide'), 12000);
  });

  /* console handle — a module scope otherwise hides all of this */
  window.GLOBE = { CAM, STORE, MAN, get positions() { return positions; }, flyTo, showCard,
    reel: () => reel, scene: () => scene, globeMesh: () => globeMesh, dotMat: () => dotMat, renderer: () => renderer };
}

boot().catch(e => { console.error('[boot] failed:', e); fail('Something went wrong loading the globe.'); });
