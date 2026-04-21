if (process.env.NODE_ENV !== 'production') require('dotenv').config();
process.on('uncaughtException', err => console.error('UNCAUGHT:', err));
process.on('unhandledRejection', err => console.error('UNHANDLED:', err));

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
// crypto se mantiene para generar jobIds
const shopify = require('./shopify');
const { generateSEO } = require('./seo');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Auth ──────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const shop = req.query.shop || '';
  if (!shop || shop === process.env.SHOPIFY_SHOP) return next();
  res.status(403).send('Acceso denegado');
}

app.get('/', (req, res) => res.send('Bucarest SEO Manager — OK'));

// ── Admin UI ──────────────────────────────────────────────────────────────────
app.get('/admin', requireAuth, (req, res) => {
  res.setHeader('Content-Security-Policy',
    `frame-ancestors https://${process.env.SHOPIFY_SHOP} https://admin.shopify.com`);
  res.send(adminUI(req.query.host || ''));
});

// ── API: Collections ──────────────────────────────────────────────────────────
app.get('/api/collections', async (req, res) => {
  try {
    res.json(await shopify.getCollections());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Products ─────────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const { collection_id, tag, title, limit = 50, after } = req.query;
    let result;
    if (collection_id) {
      result = await shopify.getProductsByCollection(collection_id, Number(limit), after || null);
    } else if (tag) {
      result = await shopify.getProductsByQuery(`tag:${tag}`, Number(limit), after || null);
    } else if (title) {
      result = await shopify.getProductsByQuery(`title:*${title}*`, Number(limit), after || null);
    } else {
      result = await shopify.getProductsByQuery('', Number(limit), after || null);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SEO: Queue job ────────────────────────────────────────────────────────────
const jobs = new Map();

app.post('/api/seo/queue', (req, res) => {
  const { products } = req.body;
  if (!products?.length) return res.status(400).json({ error: 'Sin productos' });
  const jobId = crypto.randomBytes(8).toString('hex');
  jobs.set(jobId, { products, status: 'pending' });
  res.json({ jobId });
});

// ── SEO: Stream results via SSE ───────────────────────────────────────────────
app.get('/api/seo/stream/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).send('Job no encontrado');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const { products } = job;
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    try {
      const result = await generateSEO(product);
      send({ ...result, index: i + 1, total: products.length });
    } catch (e) {
      send({ error: e.message, productId: product.id, productTitle: product.title, index: i + 1, total: products.length });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  send({ done: true });
  jobs.delete(req.params.jobId);
  res.end();
});

// ── SEO: Apply approved changes ───────────────────────────────────────────────
app.post('/api/seo/apply', async (req, res) => {
  const { items } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'Sin items' });

  const applied = [];
  const errors = [];

  for (const item of items) {
    try {
      await shopify.updateProductSEO(item.productGid, item.metaTitle, item.metaDescription);
      applied.push({ productId: item.productId, title: item.productTitle, metaTitle: item.metaTitle, metaDescription: item.metaDescription });
    } catch (e) {
      errors.push({ productId: item.productId, title: item.productTitle, error: e.message });
    }
    await new Promise(r => setTimeout(r, 200));
  }

  if (applied.length) saveLog({ date: new Date().toISOString(), applied, errors });
  res.json({ applied, errors });
});

// ── History ───────────────────────────────────────────────────────────────────
let history = [];
try { history = JSON.parse(fs.readFileSync('./log.json', 'utf8')); } catch { history = []; }

function saveLog(entry) {
  history.unshift(entry);
  if (history.length > 500) history.pop();
  try { fs.writeFileSync('./log.json', JSON.stringify(history, null, 2)); } catch {}
}

app.get('/api/history', (req, res) => res.json(history));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`SEO Manager corriendo en puerto ${PORT}`));

// ── Admin UI HTML ─────────────────────────────────────────────────────────────
function adminUI(host) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bucarest — SEO Manager</title>
  <link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@300;400;500;600&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/@shopify/app-bridge@3"></script>
  <script>
    (function() {
      var host = new URLSearchParams(location.search).get('host') || '${host}';
      if (host && window['app-bridge']) {
        window.__shopifyApp = window['app-bridge'].default({
          apiKey: '${process.env.SHOPIFY_API_KEY}',
          host: host,
        });
      }
    })();
  </script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:"Hanken Grotesk",sans-serif;background:#faf9f7;color:#333;font-size:14px}
    .sidebar{position:fixed;top:0;left:0;width:220px;height:100vh;background:#1a1a1a;padding:28px 20px;display:flex;flex-direction:column;gap:8px}
    .sidebar-logo{color:#fff;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:24px;opacity:0.7}
    .nav-btn{background:none;border:none;color:#aaa;font-size:13px;padding:10px 14px;text-align:left;cursor:pointer;border-radius:4px;width:100%;font-family:inherit;transition:all 0.15s}
    .nav-btn:hover,.nav-btn.active{background:#2a2a2a;color:#fff}
    .nav-btn.active{color:#c9a96e}
    .main{margin-left:220px;padding:40px 48px;min-height:100vh}
    .page{display:none}.page.active{display:block}
    h1{font-size:24px;font-weight:400;color:#1a1a1a;margin-bottom:6px}
    .subtitle{color:#999;font-size:13px;margin-bottom:32px}
    .card{background:#fff;border:1px solid #e8e2d9;padding:28px 32px;margin-bottom:20px}
    .section-label{font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:#9a7f5a;margin-bottom:12px;display:block}
    label{display:flex;flex-direction:column;gap:6px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#666}
    input,select{padding:10px 14px;border:1px solid #ddd6cc;background:#fdfcfb;font-size:14px;font-family:inherit;outline:none;color:#1a1a1a;transition:border-color 0.2s}
    input:focus,select:focus{border-color:#9a7f5a}
    .filter-row{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
    .filter-btn{padding:8px 16px;border:1px solid #ddd6cc;background:#fff;font-size:12px;cursor:pointer;font-family:inherit;letter-spacing:0.06em;text-transform:uppercase;transition:all 0.15s;color:#666}
    .filter-btn.active{border-color:#9a7f5a;background:#faf8f5;color:#9a7f5a}
    .filter-panel{display:none}.filter-panel.active{display:block}
    .product-list{max-height:340px;overflow-y:auto;border:1px solid #e8e2d9;background:#fdfcfb}
    .product-table{width:100%;border-collapse:collapse}
    .product-table thead th{font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9a7f5a;padding:8px 12px;border-bottom:2px solid #e8e2d9;text-align:left;background:#fdfcfb;position:sticky;top:0}
    .product-table tbody tr{border-bottom:1px solid #f0ece6;transition:background 0.1s;cursor:pointer}
    .product-table tbody tr:hover{background:#faf8f5}
    .product-table tbody td{padding:10px 12px;font-size:13px;color:#333;vertical-align:middle}
    .product-table td input[type=checkbox]{width:16px;height:16px;accent-color:#9a7f5a;cursor:pointer}
    .status-badge{font-size:10px;letter-spacing:0.08em;text-transform:uppercase;padding:2px 7px;border-radius:10px}
    .status-active{background:#e6f4ea;color:#2d6a2d}
    .status-draft{background:#f0f0f0;color:#888}
    .meta-current{font-size:11px;color:#aaa;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .selected-count{font-size:12px;color:#9a7f5a;margin:10px 0}
    .select-all-btn{background:none;border:none;font-size:12px;color:#9a7f5a;cursor:pointer;font-family:inherit;padding:10px 0;text-decoration:underline}
    .btn-row{display:flex;gap:12px;margin-top:24px;flex-wrap:wrap;align-items:center}
    .btn{padding:13px 28px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;border:none;cursor:pointer;font-family:inherit;transition:all 0.2s}
    .btn-primary{background:#1a1a1a;color:#fff}.btn-primary:hover{background:#9a7f5a}
    .btn-secondary{background:#fff;color:#555;border:1px solid #ddd6cc}.btn-secondary:hover{border-color:#9a7f5a;color:#9a7f5a}
    .btn-approve{background:#e6f4ea;color:#2d6a2d;border:1px solid #b8d8bc;padding:6px 14px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;font-family:inherit;transition:all 0.15s}
    .btn-reject{background:#fff5f5;color:#c0392b;border:1px solid #f5c0c0;padding:6px 14px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;font-family:inherit;transition:all 0.15s}
    .btn-approve.active{background:#2d6a2d;color:#fff}
    .btn-reject.active{background:#c0392b;color:#fff}
    .btn:disabled{opacity:0.5;cursor:not-allowed}
    .loading{display:none;font-size:13px;color:#999;margin-top:12px}
    .msg{padding:12px 16px;font-size:13px;margin-top:16px;display:none}
    .msg.ok{background:#f0faf0;border:1px solid #b8e0b8;color:#2d6a2d}
    .msg.err{background:#fff5f5;border:1px solid #f5c0c0;color:#c0392b}
    .progress-wrap{display:none;margin-top:20px}
    .progress-bar{height:4px;background:#e8e2d9;border-radius:2px;overflow:hidden;margin-bottom:8px}
    .progress-fill{height:100%;background:#9a7f5a;transition:width 0.3s;width:0%}
    .progress-label{font-size:12px;color:#999}
    .results-section{display:none;margin-top:32px}
    .results-section h2{font-size:16px;font-weight:500;color:#1a1a1a;margin-bottom:4px}
    .results-section .results-subtitle{font-size:12px;color:#999;margin-bottom:16px}
    .results-table-wrap{overflow-x:auto;border:1px solid #e8e2d9}
    .results-table{width:100%;border-collapse:collapse;background:#fff}
    .results-table thead th{font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9a7f5a;padding:10px 14px;border-bottom:2px solid #e8e2d9;text-align:left;background:#fdfcfb;white-space:nowrap}
    .results-table tbody tr{border-bottom:1px solid #f0ece6}
    .results-table tbody tr.rejected{opacity:0.4}
    .results-table tbody td{padding:10px 14px;font-size:13px;vertical-align:top}
    .results-table td.td-product{min-width:150px;max-width:200px}
    .product-title-sm{font-weight:500;color:#1a1a1a;margin-bottom:2px}
    .product-sku-sm{font-size:11px;color:#aaa}
    .seo-input{width:100%;padding:7px 10px;border:1px solid #ddd6cc;background:#fdfcfb;font-size:13px;font-family:inherit;outline:none;color:#1a1a1a;transition:border-color 0.2s;resize:none}
    .seo-input:focus{border-color:#9a7f5a}
    .char-count{font-size:11px;margin-top:3px}
    .char-ok{color:#2d6a2d}.char-warn{color:#b45300}.char-over{color:#c0392b}
    .td-actions{white-space:nowrap;min-width:120px}
    .apply-bar{display:flex;align-items:center;gap:16px;margin-top:20px;padding:16px 20px;background:#fff;border:1px solid #e8e2d9}
    .apply-count{font-size:13px;color:#555}
    .history-table{width:100%;border-collapse:collapse}
    .history-table thead th{font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9a7f5a;padding:8px 12px;border-bottom:2px solid #e8e2d9;text-align:left}
    .history-table tbody tr{border-bottom:1px solid #f0ece6}
    .history-table tbody td{padding:10px 12px;font-size:13px;color:#333}
    .history-empty{padding:32px;text-align:center;color:#aaa;font-size:13px}
    .badge-count{display:inline-block;background:#9a7f5a;color:#fff;font-size:10px;padding:1px 6px;border-radius:8px;margin-left:6px}
  </style>
</head>
<body>

<div class="sidebar">
  <div class="sidebar-logo">Bucarest SEO</div>
  <button class="nav-btn active" onclick="showPage('seo', this)">Optimizar SEO</button>
  <button class="nav-btn" onclick="showPage('history', this)">Historial</button>
</div>

<div class="main">

  <!-- SEO OPTIMIZER -->
  <div class="page active" id="page-seo">
    <h1>SEO Manager</h1>
    <p class="subtitle">Genera metatítulos y metadescripciones optimizados con Claude para tus productos.</p>

    <div class="card">
      <span class="section-label">Seleccionar productos</span>
      <div class="filter-row" id="seo-filters">
        <button class="filter-btn active" onclick="setFilter('collection', this)">Por colección</button>
        <button class="filter-btn" onclick="setFilter('tag', this)">Por tag</button>
        <button class="filter-btn" onclick="setFilter('title', this)">Por título</button>
      </div>

      <div id="filter-collection" class="filter-panel active">
        <label>Colección
          <select id="sel-collection" onchange="loadProducts()"><option value="">Seleccione…</option></select>
        </label>
      </div>
      <div id="filter-tag" class="filter-panel">
        <label>Tag
          <input id="inp-tag" placeholder="Ej: pintura" oninput="debounce(loadProducts, 600)">
        </label>
      </div>
      <div id="filter-title" class="filter-panel">
        <label>Título contiene
          <input id="inp-title" placeholder="Ej: silla" oninput="debounce(loadProducts, 600)">
        </label>
      </div>

      <div class="loading" id="products-loading" style="display:none;margin-top:12px">Cargando productos…</div>
      <div id="products-list" style="margin-top:12px"></div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="selected-count" id="sel-count"></div>
        <button class="select-all-btn" id="btn-select-all" onclick="toggleSelectAll()" style="display:none">Seleccionar todos</button>
      </div>
    </div>

    <div class="btn-row">
      <button class="btn btn-primary" id="btn-generate" onclick="startGeneration()" disabled>Generar SEO con Claude</button>
      <span id="generate-hint" style="font-size:12px;color:#aaa">Seleccione al menos un producto</span>
    </div>

    <div class="progress-wrap" id="progress-wrap">
      <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
      <div class="progress-label" id="progress-label">Iniciando…</div>
    </div>

    <div class="results-section" id="results-section">
      <h2>Propuestas de SEO</h2>
      <p class="results-subtitle" id="results-subtitle"></p>
      <div class="results-table-wrap">
        <table class="results-table">
          <thead>
            <tr>
              <th>Producto</th>
              <th>Meta título actual</th>
              <th style="min-width:220px">Meta título propuesto <span style="opacity:0.5;font-size:9px">máx 60 car.</span></th>
              <th style="min-width:280px">Meta descripción propuesta <span style="opacity:0.5;font-size:9px">máx 160 car.</span></th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody id="results-tbody"></tbody>
        </table>
      </div>
      <div class="apply-bar" id="apply-bar">
        <span class="apply-count" id="apply-count">0 aprobadas</span>
        <button class="btn btn-primary" id="btn-apply" onclick="applyApproved()">Aplicar aprobadas en Shopify</button>
        <div class="msg" id="apply-msg" style="margin:0"></div>
      </div>
    </div>

    <div class="msg" id="seo-msg"></div>
  </div>

  <!-- HISTORIAL -->
  <div class="page" id="page-history">
    <h1>Historial de cambios</h1>
    <p class="subtitle">Registro de optimizaciones SEO aplicadas.</p>
    <div class="card" style="padding:0">
      <div id="history-content" class="history-empty">Cargando…</div>
    </div>
  </div>

</div>

<script>
// ── State ─────────────────────────────────────────────────────────────────────
let allProducts = [];
let results = [];
let currentFilter = 'collection';

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const res = await fetch('/api/collections');
  const cols = await res.json();
  const sel = document.getElementById('sel-collection');
  cols.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = c.title;
    sel.appendChild(opt);
  });
}

// ── Navigation ────────────────────────────────────────────────────────────────
function showPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'history') loadHistory();
}

// ── Filters ───────────────────────────────────────────────────────────────────
function setFilter(type, btn) {
  currentFilter = type;
  document.querySelectorAll('#seo-filters .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.filter-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('filter-' + type).classList.add('active');
  document.getElementById('products-list').innerHTML = '';
  document.getElementById('sel-count').textContent = '';
  document.getElementById('btn-select-all').style.display = 'none';
  allProducts = [];
  updateGenerateBtn();
}

let debounceTimer;
function debounce(fn, ms) { clearTimeout(debounceTimer); debounceTimer = setTimeout(fn, ms); }

// ── Load products ─────────────────────────────────────────────────────────────
async function loadProducts() {
  const loading = document.getElementById('products-loading');
  const list = document.getElementById('products-list');
  loading.style.display = 'block';
  list.innerHTML = '';
  allProducts = [];
  updateGenerateBtn();

  let url = '/api/products?limit=50&';
  if (currentFilter === 'collection') {
    const col = document.getElementById('sel-collection').value;
    if (!col) { loading.style.display = 'none'; return; }
    url += 'collection_id=' + col;
  } else if (currentFilter === 'tag') {
    const tag = document.getElementById('inp-tag').value.trim();
    if (!tag) { loading.style.display = 'none'; return; }
    url += 'tag=' + encodeURIComponent(tag);
  } else if (currentFilter === 'title') {
    const t = document.getElementById('inp-title').value.trim();
    if (!t) { loading.style.display = 'none'; return; }
    url += 'title=' + encodeURIComponent(t);
  }

  try {
    const res = await fetch(url);
    const data = await res.json();
    allProducts = data.products || [];
    loading.style.display = 'none';
    renderProductTable();
  } catch(e) {
    loading.style.display = 'none';
    list.innerHTML = '<p style="padding:12px;color:#c00;font-size:13px">Error cargando productos.</p>';
  }
}

function renderProductTable() {
  const list = document.getElementById('products-list');
  if (!allProducts.length) {
    list.innerHTML = '<p style="padding:12px;color:#999;font-size:13px">No se encontraron productos.</p>';
    document.getElementById('btn-select-all').style.display = 'none';
    return;
  }
  list.innerHTML = \`<table class="product-table">
    <thead><tr>
      <th style="width:36px"></th>
      <th>Título</th>
      <th>SKU</th>
      <th>Meta título actual</th>
      <th>Estado</th>
    </tr></thead>
    <tbody>
      \${allProducts.map(p => \`<tr onclick="toggleRow(this)">
        <td><input type="checkbox" name="seo_product" value="\${p.id}" data-gid="\${p.gid}" onchange="updateCount();event.stopPropagation()"></td>
        <td>\${p.title}</td>
        <td style="font-size:11px;color:#999">\${p.sku || '—'}</td>
        <td><span class="meta-current">\${p.currentMetaTitle || '(sin meta título)'}</span></td>
        <td><span class="status-badge \${p.status === 'active' ? 'status-active' : 'status-draft'}">\${p.status === 'active' ? 'Activo' : 'Borrador'}</span></td>
      </tr>\`).join('')}
    </tbody>
  </table>\`;
  document.getElementById('btn-select-all').style.display = 'block';
  updateCount();
}

function toggleRow(tr) {
  const cb = tr.querySelector('input[type=checkbox]');
  cb.checked = !cb.checked;
  updateCount();
}

function updateCount() {
  const all = document.querySelectorAll('[name="seo_product"]');
  const checked = Array.from(all).filter(c => c.checked).length;
  const btn = document.getElementById('btn-select-all');
  document.getElementById('sel-count').textContent = all.length + ' producto(s) — ' + checked + ' seleccionado(s)';
  if (btn) btn.textContent = checked === all.length && all.length > 0 ? 'Deseleccionar todos' : 'Seleccionar todos';
  updateGenerateBtn();
}

function updateGenerateBtn() {
  const checked = document.querySelectorAll('[name="seo_product"]:checked').length;
  const btn = document.getElementById('btn-generate');
  const hint = document.getElementById('generate-hint');
  btn.disabled = !checked;
  hint.textContent = checked ? checked + ' producto(s) listo(s) para generar' : 'Seleccione al menos un producto';
}

function toggleSelectAll() {
  const checkboxes = document.querySelectorAll('[name="seo_product"]');
  const allChecked = Array.from(checkboxes).every(c => c.checked);
  checkboxes.forEach(c => c.checked = !allChecked);
  updateCount();
}

// ── SEO Generation ────────────────────────────────────────────────────────────
async function startGeneration() {
  const checkboxes = Array.from(document.querySelectorAll('[name="seo_product"]:checked'));
  const selectedIds = checkboxes.map(c => c.value);
  const selectedProducts = allProducts.filter(p => selectedIds.includes(p.id));

  if (!selectedProducts.length) return;

  results = [];
  document.getElementById('results-tbody').innerHTML = '';
  document.getElementById('results-section').style.display = 'none';
  document.getElementById('progress-wrap').style.display = 'block';
  document.getElementById('btn-generate').disabled = true;
  document.getElementById('seo-msg').style.display = 'none';

  try {
    const { jobId } = await fetch('/api/seo/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ products: selectedProducts }),
    }).then(r => r.json());

    const es = new EventSource('/api/seo/stream/' + jobId);

    es.onmessage = function(e) {
      const data = JSON.parse(e.data);
      if (data.done) {
        es.close();
        document.getElementById('progress-wrap').style.display = 'none';
        document.getElementById('btn-generate').disabled = false;
        updateGenerateBtn();
        showResults();
        return;
      }
      updateProgress(data.index, data.total);
      if (!data.error) {
        results.push({ ...data, approved: true });
        appendResultRow(data, results.length - 1);
      } else {
        appendErrorRow(data);
      }
      updateApplyCount();
    };

    es.onerror = function() {
      es.close();
      document.getElementById('progress-wrap').style.display = 'none';
      document.getElementById('btn-generate').disabled = false;
      updateGenerateBtn();
      showMsg('seo', 'Error en la generación. Intente nuevamente.', 'err');
    };

  } catch(e) {
    document.getElementById('progress-wrap').style.display = 'none';
    document.getElementById('btn-generate').disabled = false;
    updateGenerateBtn();
    showMsg('seo', 'Error: ' + e.message, 'err');
  }
}

function updateProgress(index, total) {
  const pct = Math.round((index / total) * 100);
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-label').textContent = 'Procesando ' + index + ' de ' + total + ' productos…';
}

function showResults() {
  const section = document.getElementById('results-section');
  section.style.display = 'block';
  document.getElementById('results-subtitle').textContent = results.length + ' propuesta(s) generada(s). Revisa y edita antes de aplicar.';
  updateApplyCount();
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function appendResultRow(data, idx) {
  const tbody = document.getElementById('results-tbody');
  const tr = document.createElement('tr');
  tr.id = 'result-row-' + idx;
  tr.innerHTML = \`
    <td class="td-product">
      <div class="product-title-sm">\${escHtml(data.productTitle)}</div>
    </td>
    <td style="max-width:180px">
      <span class="meta-current">\${escHtml(data.currentMetaTitle || '(sin meta título)')}</span>
    </td>
    <td>
      <input class="seo-input" type="text" maxlength="70" value="\${escHtml(data.metaTitle)}"
        oninput="updateCharCount(this, 60, 'tc-title-\${idx}')" id="inp-title-\${idx}">
      <div class="char-count" id="tc-title-\${idx}"></div>
    </td>
    <td>
      <textarea class="seo-input" maxlength="200" rows="3"
        oninput="updateCharCount(this, 160, 'tc-desc-\${idx}')" id="inp-desc-\${idx}">\${escHtml(data.metaDescription)}</textarea>
      <div class="char-count" id="tc-desc-\${idx}"></div>
    </td>
    <td class="td-actions">
      <div style="display:flex;gap:6px;flex-direction:column">
        <button class="btn-approve active" id="btn-approve-\${idx}" onclick="setApproval(\${idx}, true)">Aprobar</button>
        <button class="btn-reject" id="btn-reject-\${idx}" onclick="setApproval(\${idx}, false)">Rechazar</button>
      </div>
    </td>
  \`;
  tbody.appendChild(tr);
  updateCharCount(document.getElementById('inp-title-' + idx), 60, 'tc-title-' + idx);
  updateCharCount(document.getElementById('inp-desc-' + idx), 160, 'tc-desc-' + idx);
}

function appendErrorRow(data) {
  const tbody = document.getElementById('results-tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = \`
    <td class="td-product"><div class="product-title-sm">\${escHtml(data.productTitle)}</div></td>
    <td colspan="3" style="color:#c0392b;font-size:12px">Error: \${escHtml(data.error)}</td>
    <td>—</td>
  \`;
  tbody.appendChild(tr);
}

function setApproval(idx, approved) {
  results[idx].approved = approved;
  document.getElementById('btn-approve-' + idx).classList.toggle('active', approved);
  document.getElementById('btn-reject-' + idx).classList.toggle('active', !approved);
  const row = document.getElementById('result-row-' + idx);
  row.classList.toggle('rejected', !approved);
  updateApplyCount();
}

function updateCharCount(input, limit, counterId) {
  const len = input.value.length;
  const el = document.getElementById(counterId);
  if (!el) return;
  let cls = 'char-ok';
  if (len > limit) cls = 'char-over';
  else if (len > limit * 0.85) cls = 'char-warn';
  el.className = 'char-count ' + cls;
  el.textContent = len + ' / ' + limit;
}

function updateApplyCount() {
  const n = results.filter(r => r.approved).length;
  document.getElementById('apply-count').textContent = n + ' propuesta(s) aprobada(s)';
  document.getElementById('btn-apply').disabled = n === 0;
}

// ── Apply ─────────────────────────────────────────────────────────────────────
async function applyApproved() {
  const toApply = results
    .map((r, idx) => ({
      ...r,
      metaTitle: (document.getElementById('inp-title-' + idx)?.value || r.metaTitle).trim(),
      metaDescription: (document.getElementById('inp-desc-' + idx)?.value || r.metaDescription).trim(),
    }))
    .filter(r => r.approved);

  if (!toApply.length) return;

  const btn = document.getElementById('btn-apply');
  btn.disabled = true;
  btn.textContent = 'Aplicando…';

  try {
    const res = await fetch('/api/seo/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: toApply }),
    }).then(r => r.json());

    const msg = document.getElementById('apply-msg');
    const ok = res.applied.length;
    const err = res.errors.length;
    msg.className = 'msg ' + (err ? 'err' : 'ok');
    msg.textContent = ok + ' producto(s) actualizados en Shopify.' + (err ? ' ' + err + ' error(es).' : '');
    msg.style.display = 'block';
    btn.textContent = 'Aplicar aprobadas en Shopify';
    btn.disabled = false;
  } catch(e) {
    showMsg('seo', 'Error al aplicar: ' + e.message, 'err');
    btn.textContent = 'Aplicar aprobadas en Shopify';
    btn.disabled = false;
  }
}

// ── History ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  const container = document.getElementById('history-content');
  try {
    const data = await fetch('/api/history').then(r => r.json());
    if (!data.length) {
      container.className = 'history-empty';
      container.textContent = 'Aún no hay cambios registrados.';
      return;
    }
    container.className = '';
    container.innerHTML = \`<table class="history-table">
      <thead><tr>
        <th style="padding:12px">Fecha</th>
        <th>Aplicados</th>
        <th>Errores</th>
        <th>Productos</th>
      </tr></thead>
      <tbody>
        \${data.map(entry => \`<tr>
          <td style="padding:10px 12px;white-space:nowrap">\${new Date(entry.date).toLocaleString('es-CL')}</td>
          <td>\${entry.applied.length}</td>
          <td>\${entry.errors?.length || 0}</td>
          <td style="font-size:12px;color:#666">\${entry.applied.map(a => a.title).join(', ')}</td>
        </tr>\`).join('')}
      </tbody>
    </table>\`;
  } catch(e) {
    container.textContent = 'Error cargando historial.';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showMsg(prefix, text, type) {
  const el = document.getElementById(prefix + '-msg');
  el.textContent = text; el.className = 'msg ' + type; el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 6000);
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

init();
</script>
</body>
</html>`;
}
