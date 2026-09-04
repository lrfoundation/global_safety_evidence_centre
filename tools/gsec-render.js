/*
 * gsec-render.js — shared rendering + export module for the GSEC tools suite.
 *
 * Used by Chart Studio, Map Studio and Flow Studio for: the JSON export schema
 * (Section 1 of report-studio-plan.md), a self-contained SVG hover-tooltip
 * pattern, and small helpers (esc/toast/copy/download) that were previously
 * duplicated verbatim in each tool. Also used by Report Studio to reconstitute
 * a chart block from pasted JSON.
 *
 * Exposes a single global: window.GSEC
 */
(function(global){
"use strict";

/* ---------- Shared palette (Foundation + World Risk Poll data colours) ---------- */
var PINK = '#e5006e';
var SEQ = ['#e5006e','#0a0a14','#b00055','#6c6c78','#f48fb8','#2a2a35','#ec4f93','#9a9aa3'];
var NEUT = ['#c2c2c9','#9a9aa3','#6c6c78','#45454f','#2a2a35','#161620'];
/* World Risk Poll data colours, ordered C1, C3, C2, C4, C5, C6, C7, C8 */
var WRP = ['#e3076e','#00a7b2','#00785c','#f07800','#7a50de','#8cab00','#bdbdbd','#bf153d'];
/* LRF data colours: seven main hues first, then their dark variants */
var LRF = ['#8f47eb','#067acc','#0a891f','#af640c','#d91424','#0a8484','#8c7500',
           '#6022a7','#094f83','#0e591c','#7f3e14','#a4101c','#105051','#685204'];
var INK = '#0a0a14', INK_SOFT = '#2a2a35', MUTED = '#6c6c78', LINE = '#e4e4ea';

var PALETTES = { sequence: SEQ, wrp: WRP, lrf: LRF, neutral: NEUT };

/* ---------- Small shared helpers ---------- */
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function slug(title, fallback){
  var base = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  return base || fallback || 'gsec-export';
}

function toast(msg, opts){
  opts = opts || {};
  var elId = opts.elId || 'toast', textId = opts.textId || 'toast-text', duration = opts.duration || 1800;
  var t = document.getElementById(elId);
  if(!t) return;
  var textEl = document.getElementById(textId);
  if(textEl) textEl.textContent = msg; else t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._gsecTimer);
  t._gsecTimer = setTimeout(function(){ t.classList.remove('show'); }, duration);
}

function copyText(text, okMsg, failMsg, toastOpts){
  navigator.clipboard.writeText(text).then(function(){
    toast(okMsg || 'Copied', toastOpts);
  }, function(){
    toast(failMsg || 'Copy failed', toastOpts);
  });
}

function downloadText(text, filename, mime){
  var blob = new Blob([text], { type: mime || 'text/plain' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
}

/* ---------- Section 1 shared JSON schema ---------- */
/**
 * Build a schema-version-1.0 export object.
 * opts: { sourceTool, chartType, title, unit, scale, paletteVersion, series, notes }
 * series: array of { id, label, value, tooltip, meta }
 */
function buildExport(opts){
  opts = opts || {};
  return {
    schemaVersion: '1.0',
    sourceTool: opts.sourceTool || '',
    chartType: opts.chartType || '',
    title: opts.title || '',
    generatedAt: opts.generatedAt || new Date().toISOString(),
    styleTokens: {
      paletteVersion: opts.paletteVersion || 'lrf-foundation-1',
      unit: opts.unit || '',
      scale: opts.scale || 'linear'
    },
    series: (opts.series || []).map(function(s){
      return {
        id: s.id != null ? String(s.id) : '',
        label: s.label || '',
        value: (s.value === null || s.value === undefined) ? null : Number(s.value),
        tooltip: s.tooltip || undefined,
        meta: s.meta || undefined
      };
    }),
    notes: opts.notes || undefined
  };
}

function exportJSONString(opts){ return JSON.stringify(buildExport(opts), null, 2); }

function copyExportJSON(opts, toastOpts){
  copyText(exportJSONString(opts), 'JSON copied to clipboard', 'Copy failed', toastOpts);
}

function downloadExportJSON(opts, filenameBase){
  var name = slug(filenameBase || opts.title, 'gsec-chart') + '.json';
  downloadText(exportJSONString(opts), name, 'application/json');
}

/* ---------- Self-contained SVG hover-tooltip pattern ----------
 * A tooltip that survives a copy/paste of the raw SVG string, because the CSS
 * that drives it (:hover + sibling) is embedded inside the SVG's own <style>,
 * not on the host page. Degrades to "no tooltip" if a data point has no note —
 * callers should only call hoverGroup() when a tooltip string is present.
 */
var TIP_STYLE_ID = 'gsec-tip-style';
function tipStyleBlock(){
  return '<style>.gsec-hz{cursor:pointer;}.gsec-tip{opacity:0;pointer-events:none;transition:opacity .12s;}' +
         '.gsec-hz:hover+.gsec-tip{opacity:1;}</style>';
}

/** Measure an approximate text width in SVG px for a given font size (DM Sans-ish average). */
function approxTextWidth(s, size){ return String(s).length * size * 0.56; }

/**
 * Wrap a hoverable shape with a self-contained tooltip box.
 * shapeSvg: the SVG markup for the hoverable shape (rect/path/circle...).
 * tipX, tipY: anchor point for the tooltip (its top-left-ish corner; auto-flips if it would run off the right edge).
 * title/sub: tooltip text lines. canvasW: total SVG width, used to flip the box left if it would overflow.
 */
function hoverGroup(shapeSvg, tipX, tipY, title, sub, canvasW){
  if(!title && !sub) return shapeSvg; // no tooltip content — render the shape plainly
  var pad = 8, lh = 15, fsTitle = 11.5, fsSub = 10.5;
  var lines = [];
  if(title) lines.push({ text: String(title), size: fsTitle, weight: 700 });
  if(sub) lines.push({ text: String(sub), size: fsSub, weight: 400 });
  var w = 0;
  lines.forEach(function(l){ w = Math.max(w, approxTextWidth(l.text, l.size)); });
  w = Math.min(260, w + pad * 2);
  var h = lines.length * lh + pad * 1.6;
  var flip = canvasW && (tipX + w + 6 > canvasW);
  var bx = flip ? tipX - w - 6 : tipX + 6;
  var by = tipY - h - 6;
  var textSvg = '';
  lines.forEach(function(l, i){
    textSvg += '<text x="' + (bx + pad) + '" y="' + (by + pad + (i + 0.8) * lh - 4) + '" font-size="' + l.size +
      '" font-weight="' + l.weight + '" fill="' + (i === 0 ? '#ffffff' : '#e9e9ee') + '">' + esc(l.text) + '</text>';
  });
  var box = '<g class="gsec-tip"><rect x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + w.toFixed(1) +
    '" height="' + h.toFixed(1) + '" rx="4" fill="' + INK + '" fill-opacity="0.94"/>' + textSvg + '</g>';
  return '<g class="gsec-hz">' + shapeSvg + '</g>' + box;
}

/** Ensure the tooltip <style> block is present once in a built SVG string (call before the closing </svg>). */
function ensureTipStyle(svgHead){ return svgHead + tipStyleBlock(); }

/* ---------- Minimal chart reconstitution for Report Studio ----------
 * Renders a compact, self-contained SVG straight from a Section-1 JSON export.
 * Not a byte-for-byte reproduction of the originating tool's renderer — it is a
 * faithful, simplified re-render (same palette, same values, same tooltips)
 * sized to fit a report column. Falls back to a labelled value list for chart
 * types it does not know how to draw geometrically (e.g. a map without its
 * source boundary data).
 */
function colorsFor(paletteVersion, n){
  var key = 'sequence';
  if(/wrp/i.test(paletteVersion || '')) key = 'wrp';
  else if(/lrf/i.test(paletteVersion || '')) key = 'lrf';
  var ramp = PALETTES[key] || SEQ, out = [];
  for(var i = 0; i < n; i++) out.push(ramp[i % ramp.length]);
  return out;
}

function fmtVal(v, unit, decimals){
  if(v === null || v === undefined || isNaN(v)) return '';
  var s = Number(v).toFixed(decimals != null ? decimals : (Math.abs(v) < 10 ? 1 : 0));
  return s + (unit || '');
}

function renderFromJSON(json, opts){
  opts = opts || {};
  var W = opts.width || 640, H = opts.height || 400;
  var series = (json.series || []).filter(function(s){ return s.value !== null && s.value !== undefined; });
  var unit = (json.styleTokens && json.styleTokens.unit) || '';
  var colors = colorsFor(json.styleTokens && json.styleTokens.paletteVersion, Math.max(1, series.length));

  function head(){
    var s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H +
      '" font-family="DM Sans, system-ui, -apple-system, Segoe UI, sans-serif"><rect width="' + W + '" height="' + H + '" fill="#ffffff"/>';
    var top = 8;
    if(json.title){ s += '<text x="14" y="24" font-size="15" font-weight="600" fill="' + INK + '">' + esc(json.title) + '</text>'; top = 34; }
    return { svg: s, top: top };
  }

  if(!series.length){
    var h0 = head();
    return h0.svg + '<text x="' + (W/2) + '" y="' + (H/2) + '" font-size="13" fill="' + MUTED + '" text-anchor="middle">No data in this chart export</text></svg>';
  }

  var type = json.chartType || '';
  var isDonut = (type === 'donut');
  var isMapLike = (type === 'world-map' || type === 'country-map');

  var h = head();
  var svg = h.svg, top = h.top;
  var bottom = json.notes ? H - 20 : H - 8;

  if(isDonut){
    var total = series.reduce(function(a,s){ return a + Math.max(0, s.value); }, 0) || 1;
    var cx = W * 0.34, cy = top + (bottom - top) / 2, ro = Math.min((bottom-top)/2 - 6, cx - 12, 120), ri = ro * 0.6;
    var ang = 0;
    series.forEach(function(s, i){
      var frac = Math.max(0, s.value) / total, sweep = frac * 360, a0 = ang, a1 = ang + sweep;
      function polar(r, a){ var rad=(a-90)*Math.PI/180; return [cx+r*Math.cos(rad), cy+r*Math.sin(rad)]; }
      var p1=polar(ro,a0), p2=polar(ro,a1-0.4), p3=polar(ri,a1-0.4), p4=polar(ri,a0);
      var large=(a1-a0)>180?1:0;
      var d = 'M'+p1[0].toFixed(2)+','+p1[1].toFixed(2)+' A'+ro+','+ro+' 0 '+large+' 1 '+p2[0].toFixed(2)+','+p2[1].toFixed(2)+
              ' L'+p3[0].toFixed(2)+','+p3[1].toFixed(2)+' A'+ri+','+ri+' 0 '+large+' 0 '+p4[0].toFixed(2)+','+p4[1].toFixed(2)+' Z';
      var shape = '<path d="' + d + '" fill="' + colors[i] + '"/>';
      var mid = polar((ro+ri)/2, (a0+a1)/2);
      svg += hoverGroup(shape, mid[0], mid[1], s.label, s.tooltip || fmtVal(s.value, unit), W);
      ang = a1;
    });
    // simple legend list to the right
    var lx = W * 0.62, ly = top + 6;
    series.forEach(function(s, i){
      svg += '<rect x="' + lx + '" y="' + ly + '" width="10" height="10" fill="' + colors[i] + '"/>' +
        '<text x="' + (lx + 15) + '" y="' + (ly + 9) + '" font-size="11" fill="' + INK_SOFT + '">' + esc(s.label) + ' — ' + esc(fmtVal(s.value, unit)) + '</text>';
      ly += 18;
    });
  } else if(isMapLike){
    // No boundary geometry travels in the JSON export, so a literal choropleth
    // can't be redrawn here — fall back to a ranked, coloured value list that
    // still carries every region's value and tooltip faithfully.
    var vals = series.map(function(s){ return s.value; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var rowH = Math.min(22, (bottom - top - 4) / series.length);
    series.slice(0, Math.floor((bottom-top)/rowH)).forEach(function(s, i){
      var frac = hi > lo ? (s.value - lo) / (hi - lo) : 1;
      var col = colors[Math.round(frac * (colors.length - 1))];
      var y = top + i * rowH;
      var barW = (W - 220) * Math.max(0.04, frac);
      var shape = '<rect x="150" y="' + (y+3) + '" width="' + barW.toFixed(1) + '" height="' + (rowH-8) + '" fill="' + col + '"/>';
      svg += '<text x="146" y="' + (y+rowH-8) + '" font-size="11" fill="' + INK_SOFT + '" text-anchor="end">' + esc(s.label) + '</text>';
      svg += hoverGroup(shape, 150 + barW, y + rowH/2, s.label, s.tooltip || fmtVal(s.value, unit), W);
      svg += '<text x="' + (156+barW) + '" y="' + (y+rowH-8) + '" font-size="10.5" fill="' + MUTED + '">' + esc(fmtVal(s.value, unit)) + '</text>';
    });
  } else {
    // bar-like fallback: one bar per series entry (covers bar/funnel/flow-stage/etc.)
    var vmax = Math.max.apply(null, series.map(function(s){ return Math.abs(s.value); })) || 1;
    var plotLeft = 12, plotRight = W - 12, plotW = plotRight - plotLeft;
    var rowH2 = (bottom - top - 4) / series.length;
    series.forEach(function(s, i){
      var y = top + i * rowH2;
      var w2 = Math.max(2, (Math.abs(s.value) / vmax) * (plotW * 0.6));
      var shape = '<rect x="' + plotLeft + '" y="' + (y+4) + '" width="' + w2.toFixed(1) + '" height="' + Math.max(6, rowH2 - 10) + '" fill="' + colors[i % colors.length] + '"/>';
      svg += hoverGroup(shape, plotLeft + w2, y + rowH2/2, s.label, s.tooltip || fmtVal(s.value, unit), W);
      svg += '<text x="' + (plotLeft + w2 + 6) + '" y="' + (y + rowH2/2 + 4) + '" font-size="10.5" fill="' + INK_SOFT + '">' + esc(s.label) + ' ' + esc(fmtVal(s.value, unit)) + '</text>';
    });
  }

  if(json.notes) svg += '<text x="14" y="' + (H-6) + '" font-size="10" fill="' + MUTED + '">' + esc(json.notes) + '</text>';
  svg += tipStyleBlock() + '</svg>';
  return svg;
}

/* ---------- Export ---------- */
global.GSEC = {
  PINK: PINK, SEQ: SEQ, NEUT: NEUT, WRP: WRP, LRF: LRF,
  INK: INK, INK_SOFT: INK_SOFT, MUTED: MUTED, LINE: LINE,
  esc: esc, slug: slug, toast: toast, copyText: copyText, downloadText: downloadText,
  buildExport: buildExport, exportJSONString: exportJSONString,
  copyExportJSON: copyExportJSON, downloadExportJSON: downloadExportJSON,
  hoverGroup: hoverGroup, tipStyleBlock: tipStyleBlock, approxTextWidth: approxTextWidth,
  renderFromJSON: renderFromJSON
};

})(window);
