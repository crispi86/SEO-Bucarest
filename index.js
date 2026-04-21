if (process.env.NODE_ENV !== 'production') require('dotenv').config();
process.on('uncaughtException', err => console.error('UNCAUGHT:', err));
process.on('unhandledRejection', err => console.error('UNHANDLED:', err));

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const shopify = require('./shopify');
const seo = require('./seo');

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

// ── Persistence ───────────────────────────────────────────────────────────────
let store = { processedIds: { products: [], collections: [], metaobjects: [], articles: [], images: [] }, history: [] };
try {
  const raw = JSON.parse(fs.readFileSync('./log.json', 'utf8'));
  if (Array.isArray(raw)) {
    store.history = raw;
    raw.forEach(e => (e.applied || []).forEach(a => { if (a.productId && !store.processedIds.products.includes(a.productId)) store.processedIds.products.push(a.productId); }));
  } else {
    store = { ...store, ...raw };
  }
} catch {}

const processedIds = {
  products: new Set(store.processedIds?.products || []),
  collections: new Set(store.processedIds?.collections || []),
  metaobjects: new Set(store.processedIds?.metaobjects || []),
  articles: new Set(store.processedIds?.articles || []),
  images: new Set(store.processedIds?.images || []),
};
let history = store.history || [];

function saveStore() {
  const data = {
    processedIds: Object.fromEntries(Object.entries(processedIds).map(([k, v]) => [k, [...v]])),
    history,
  };
  try { fs.writeFileSync('./log.json', JSON.stringify(data, null, 2)); } catch {}
}

app.get('/api/processed-ids', (req, res) => {
  res.json(Object.fromEntries(Object.entries(processedIds).map(([k, v]) => [k, [...v]])));
});

app.get('/api/history', (req, res) => res.json(history));

// ── API: Collections (filter list) ───────────────────────────────────────────
app.get('/api/collections', async (req, res) => {
  try { res.json(await shopify.getCollections()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Products ─────────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const { collection_id, tag, title, limit = 50, after } = req.query;
    let result;
    if (collection_id) result = await shopify.getProductsByCollection(collection_id, Number(limit), after || null);
    else if (tag) result = await shopify.getProductsByQuery(`tag:${tag}`, Number(limit), after || null);
    else if (title) result = await shopify.getProductsByQuery(`title:*${title}*`, Number(limit), after || null);
    else result = await shopify.getProductsByQuery('', Number(limit), after || null);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Collections with SEO ─────────────────────────────────────────────────
app.get('/api/collections/seo', async (req, res) => {
  try { res.json(await shopify.getCollectionsWithSEO(250)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Metaobjects ──────────────────────────────────────────────────────────
app.get('/api/metaobjects/types', async (req, res) => {
  try {
    const types = await shopify.getMetaobjectTypes();
    console.log('Metaobject types:', JSON.stringify(types));
    res.json(types);
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/metaobjects', async (req, res) => {
  try {
    const { type, limit = 50, after } = req.query;
    if (!type) return res.status(400).json({ error: 'Falta type' });
    res.json(await shopify.getMetaobjectsByType(type, Number(limit), after || null));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Blog Articles ────────────────────────────────────────────────────────
app.get('/api/articles', async (req, res) => {
  try {
    const { search, limit = 50, after } = req.query;
    res.json(await shopify.getBlogArticles(search ? `title:*${search}*` : '', Number(limit), after || null));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Product Images ───────────────────────────────────────────────────────
app.get('/api/images', async (req, res) => {
  try {
    const { collection_id, tag, title, limit = 20, after } = req.query;
    let queryStr = '';
    if (tag) queryStr = `tag:${tag}`;
    else if (title) queryStr = `title:*${title}*`;
    const result = await shopify.getProductsWithImages(collection_id || null, queryStr, Number(limit), after || null);
    const images = [];
    for (const product of result.products) {
      for (const img of product.images) {
        images.push({ ...img, productId: product.id, productGid: product.gid, productTitle: product.title, vendor: product.vendor, productType: product.productType, handle: product.handle });
      }
    }
    res.json({ images, pageInfo: result.pageInfo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SEO Queue & Stream ────────────────────────────────────────────────────────
const jobs = new Map();

app.post('/api/seo/queue', (req, res) => {
  const { type, items } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'Sin items' });
  const jobId = crypto.randomBytes(8).toString('hex');
  jobs.set(jobId, { type, items });
  res.json({ jobId });
});

app.get('/api/seo/stream/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).send('Job no encontrado');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const { type, items } = job;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      let result;
      if (type === 'products') result = await seo.generateSEO(item);
      else if (type === 'collections') result = await seo.generateCollectionSEO(item);
      else if (type === 'metaobjects') result = await seo.generateMetaobjectSEO(item);
      else if (type === 'articles') result = await seo.generateArticleSEO(item);
      else if (type === 'images') result = { ...item, altText: await seo.generateAltText(item) };
      send({ ...result, index: i + 1, total: items.length });
    } catch (e) {
      send({ error: e.message, itemTitle: item.productTitle || item.collectionTitle || item.metaobjectTitle || item.articleTitle || item.productTitle || '(sin nombre)', index: i + 1, total: items.length });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  send({ done: true });
  jobs.delete(req.params.jobId);
  res.end();
});

// ── SEO Apply ─────────────────────────────────────────────────────────────────
app.post('/api/seo/apply', async (req, res) => {
  const { type, items } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'Sin items' });

  const applied = [], errors = [];

  for (const item of items) {
    try {
      if (type === 'products') {
        await shopify.updateProductSEO(item.productGid, item.metaTitle, item.metaDescription);
        processedIds.products.add(item.productId);
        applied.push({ id: item.productId, title: item.productTitle, metaTitle: item.metaTitle, metaDescription: item.metaDescription });
      } else if (type === 'collections') {
        await shopify.updateCollectionSEO(item.collectionGid, item.metaTitle, item.metaDescription);
        processedIds.collections.add(item.collectionId);
        applied.push({ id: item.collectionId, title: item.collectionTitle, metaTitle: item.metaTitle, metaDescription: item.metaDescription });
      } else if (type === 'metaobjects') {
        await shopify.updateMetaobjectSEO(item.metaobjectGid, item.metaTitle, item.metaDescription);
        processedIds.metaobjects.add(item.metaobjectId);
        applied.push({ id: item.metaobjectId, title: item.metaobjectTitle, metaTitle: item.metaTitle, metaDescription: item.metaDescription });
      } else if (type === 'articles') {
        await shopify.updateArticleSEO(item.articleGid, item.metaTitle, item.metaDescription);
        processedIds.articles.add(item.articleId);
        applied.push({ id: item.articleId, title: item.articleTitle, metaTitle: item.metaTitle, metaDescription: item.metaDescription });
      } else if (type === 'images') {
        await shopify.updateImageAlt(item.productId, item.imageId, item.altText);
        processedIds.images.add(item.imageId);
        applied.push({ id: item.imageId, title: item.productTitle, altText: item.altText });
      }
    } catch (e) {
      errors.push({ id: item.productId || item.collectionId || item.metaobjectId || item.articleId || item.imageId, title: item.productTitle || item.collectionTitle || item.metaobjectTitle || item.articleTitle, error: e.message });
    }
    await new Promise(r => setTimeout(r, 200));
  }

  if (applied.length) {
    history.unshift({ date: new Date().toISOString(), type, applied, errors });
    if (history.length > 500) history.pop();
    saveStore();
  }
  res.json({ applied, errors });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`SEO Manager corriendo en puerto ${PORT}`));

// ── Admin UI ──────────────────────────────────────────────────────────────────
function adminUI(host) {
  const shopDomain = (process.env.SHOPIFY_SHOP || '').replace('.myshopify.com', '');
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bucarest — SEO Manager</title>
  <link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@300;400;500;600&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/@shopify/app-bridge@3"></script>
  <script>(function(){var h=new URLSearchParams(location.search).get('host')||'${host}';if(h&&window['app-bridge'])window.__shopifyApp=window['app-bridge'].default({apiKey:'${process.env.SHOPIFY_API_KEY}',host:h});})();</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:"Hanken Grotesk",sans-serif;background:#faf9f7;color:#333;font-size:14px}
    .sidebar{position:fixed;top:0;left:0;width:200px;height:100vh;background:#1a1a1a;padding:24px 16px;display:flex;flex-direction:column;gap:4px;overflow-y:auto}
    .sidebar-logo{color:#fff;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:20px;opacity:0.7}
    .nav-section{font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:#555;padding:12px 14px 6px;margin-top:4px}
    .nav-btn{background:none;border:none;color:#aaa;font-size:13px;padding:9px 14px;text-align:left;cursor:pointer;border-radius:4px;width:100%;font-family:inherit;transition:all 0.15s;display:flex;align-items:center;gap:8px}
    .nav-btn:hover{background:#2a2a2a;color:#fff}
    .nav-btn.active{background:#2a2a2a;color:#c9a96e}
    .nav-dot{width:6px;height:6px;border-radius:50%;background:#555;flex-shrink:0;transition:background 0.15s}
    .nav-btn.active .nav-dot,.nav-btn:hover .nav-dot{background:#c9a96e}
    .main{margin-left:200px;padding:36px 44px;min-height:100vh}
    .page{display:none}.page.active{display:block}
    h1{font-size:22px;font-weight:400;color:#1a1a1a;margin-bottom:4px}
    .subtitle{color:#999;font-size:13px;margin-bottom:28px}
    .card{background:#fff;border:1px solid #e8e2d9;padding:24px 28px;margin-bottom:16px}
    .section-label{font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:#9a7f5a;margin-bottom:10px;display:block}
    label{display:flex;flex-direction:column;gap:5px;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#666}
    input,select{padding:9px 12px;border:1px solid #ddd6cc;background:#fdfcfb;font-size:13px;font-family:inherit;outline:none;color:#1a1a1a;transition:border-color 0.2s;width:100%}
    input:focus,select:focus{border-color:#9a7f5a}
    .filter-row{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
    .filter-btn{padding:7px 14px;border:1px solid #ddd6cc;background:#fff;font-size:11px;cursor:pointer;font-family:inherit;letter-spacing:0.06em;text-transform:uppercase;transition:all 0.15s;color:#666}
    .filter-btn.active{border-color:#9a7f5a;background:#faf8f5;color:#9a7f5a}
    .filter-panel{display:none}.filter-panel.active{display:block}
    .seo-filter{display:flex;gap:6px;margin:10px 0}
    .seo-filter-btn{padding:4px 12px;border:1px solid #ddd6cc;background:#fff;font-size:11px;cursor:pointer;font-family:inherit;letter-spacing:0.06em;text-transform:uppercase;border-radius:12px;color:#666;transition:all 0.15s}
    .seo-filter-btn.active{border-color:#9a7f5a;background:#faf8f5;color:#9a7f5a}
    .tbl-wrap{max-height:320px;overflow-y:auto;border:1px solid #e8e2d9;background:#fdfcfb}
    .tbl{width:100%;border-collapse:collapse}
    .tbl thead th{font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#9a7f5a;padding:7px 10px;border-bottom:2px solid #e8e2d9;text-align:left;background:#fdfcfb;position:sticky;top:0;white-space:nowrap}
    .tbl tbody tr{border-bottom:1px solid #f0ece6;transition:background 0.1s;cursor:pointer}
    .tbl tbody tr:hover{background:#faf8f5}
    .tbl tbody td{padding:8px 10px;font-size:12px;color:#333;vertical-align:middle}
    .tbl td input[type=checkbox]{width:15px;height:15px;accent-color:#9a7f5a;cursor:pointer}
    .status-badge{font-size:9px;letter-spacing:0.08em;text-transform:uppercase;padding:2px 6px;border-radius:10px;white-space:nowrap}
    .s-active{background:#e6f4ea;color:#2d6a2d}.s-draft{background:#f0f0f0;color:#888}
    .seo-done{color:#2d6a2d;font-weight:600}.seo-none{color:#ddd}
    .meta-ok{color:#2d6a2d}.meta-no{color:#ddd}
    .url-link{color:#9a7f5a;text-decoration:none;font-size:11px}.url-link:hover{text-decoration:underline}
    .thumb{width:40px;height:40px;object-fit:cover;border:1px solid #e8e2d9;border-radius:2px}
    .sel-row{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
    .sel-count{font-size:12px;color:#9a7f5a}
    .sel-all-btn{background:none;border:none;font-size:12px;color:#9a7f5a;cursor:pointer;font-family:inherit;text-decoration:underline}
    .btn-row{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap;align-items:center}
    .btn{padding:11px 24px;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;border:none;cursor:pointer;font-family:inherit;transition:all 0.2s}
    .btn-primary{background:#1a1a1a;color:#fff}.btn-primary:hover{background:#9a7f5a}
    .btn-secondary{background:#fff;color:#555;border:1px solid #ddd6cc}.btn-secondary:hover{border-color:#9a7f5a;color:#9a7f5a}
    .btn:disabled{opacity:0.45;cursor:not-allowed}
    .btn-hint{font-size:11px;color:#aaa}
    .progress-wrap{display:none;margin-top:16px}
    .progress-bar{height:3px;background:#e8e2d9;border-radius:2px;overflow:hidden;margin-bottom:6px}
    .progress-fill{height:100%;background:#9a7f5a;transition:width 0.3s;width:0%}
    .progress-lbl{font-size:11px;color:#999}
    .results-section{display:none;margin-top:28px}
    .results-section h2{font-size:15px;font-weight:500;color:#1a1a1a;margin-bottom:3px}
    .results-subtitle{font-size:11px;color:#999;margin-bottom:14px}
    .results-wrap{overflow-x:auto;border:1px solid #e8e2d9}
    .rtbl{width:100%;border-collapse:collapse;background:#fff}
    .rtbl thead th{font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#9a7f5a;padding:9px 12px;border-bottom:2px solid #e8e2d9;text-align:left;background:#fdfcfb;white-space:nowrap}
    .rtbl tbody tr{border-bottom:1px solid #f0ece6}
    .rtbl tbody tr.rejected td{opacity:0.35}
    .rtbl tbody td{padding:9px 12px;font-size:12px;vertical-align:top}
    .rtbl td.td-name{min-width:130px;max-width:180px;font-weight:500}
    .rtbl td.td-cur{min-width:130px;max-width:160px;font-size:11px;color:#aaa}
    .seo-inp{width:100%;padding:6px 9px;border:1px solid #ddd6cc;background:#fdfcfb;font-size:12px;font-family:inherit;outline:none;color:#1a1a1a;transition:border-color 0.2s;resize:none}
    .seo-inp:focus{border-color:#9a7f5a}
    .char-c{font-size:10px;margin-top:2px}
    .c-ok{color:#2d6a2d}.c-warn{color:#b45300}.c-over{color:#c0392b}
    .td-act{white-space:nowrap;min-width:110px}
    .btn-ap{padding:5px 12px;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;font-family:inherit;transition:all 0.15s;border:1px solid #b8d8bc;background:#e6f4ea;color:#2d6a2d}
    .btn-rj{padding:5px 12px;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;font-family:inherit;transition:all 0.15s;border:1px solid #f5c0c0;background:#fff5f5;color:#c0392b}
    .btn-ap.on{background:#2d6a2d;color:#fff}.btn-rj.on{background:#c0392b;color:#fff}
    .apply-bar{display:flex;align-items:center;gap:14px;margin-top:16px;padding:14px 18px;background:#fff;border:1px solid #e8e2d9}
    .apply-count{font-size:12px;color:#555}
    .msg{padding:10px 14px;font-size:12px;margin-top:12px}
    .msg.ok{background:#f0faf0;border:1px solid #b8e0b8;color:#2d6a2d}
    .msg.err{background:#fff5f5;border:1px solid #f5c0c0;color:#c0392b}
    .empty-msg{padding:20px;text-align:center;color:#aaa;font-size:12px}
    .htbl{width:100%;border-collapse:collapse}
    .htbl thead th{font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#9a7f5a;padding:9px 12px;border-bottom:2px solid #e8e2d9;text-align:left}
    .htbl tbody tr{border-bottom:1px solid #f0ece6}
    .htbl tbody td{padding:9px 12px;font-size:12px;color:#333}
    .type-badge{font-size:9px;padding:2px 7px;border-radius:10px;text-transform:uppercase;letter-spacing:0.06em;background:#faf8f5;border:1px solid #ddd6cc;color:#9a7f5a}
  </style>
</head>
<body>
<div class="sidebar">
  <div class="sidebar-logo">Bucarest SEO</div>
  <button class="nav-btn active" onclick="showPage('products',this)"><span class="nav-dot"></span>Productos</button>
  <button class="nav-btn" onclick="showPage('collections',this)"><span class="nav-dot"></span>Colecciones</button>
  <button class="nav-btn" onclick="showPage('metaobjects',this)"><span class="nav-dot"></span>Metaobjetos</button>
  <button class="nav-btn" onclick="showPage('articles',this)"><span class="nav-dot"></span>Blog</button>
  <button class="nav-btn" onclick="showPage('images',this)"><span class="nav-dot"></span>Imágenes</button>
  <div class="nav-section">Sistema</div>
  <button class="nav-btn" onclick="showPage('history',this)"><span class="nav-dot"></span>Historial</button>
</div>
<div class="main">

<!-- PRODUCTOS -->
<div class="page active" id="page-products">
  <h1>Productos</h1>
  <p class="subtitle">Optimiza metatítulo y metadescripción de tus productos.</p>
  <div class="card">
    <span class="section-label">Filtrar productos</span>
    <div class="filter-row" id="pf-filters">
      <button class="filter-btn active" onclick="setPF('collection',this)">Por colección</button>
      <button class="filter-btn" onclick="setPF('tag',this)">Por tag</button>
      <button class="filter-btn" onclick="setPF('title',this)">Por título</button>
      <span style="color:#e8e2d9;margin:0 4px;align-self:center">|</span>
      <div id="p-seo-filter-top" style="display:flex;gap:6px;align-items:center">
        <button class="seo-filter-btn active" data-f="all" onclick="setPSeoFilter('all',this)">Todos</button>
        <button class="seo-filter-btn" data-f="done" onclick="setPSeoFilter('done',this)">Con SEO</button>
        <button class="seo-filter-btn" data-f="none" onclick="setPSeoFilter('none',this)">Sin SEO</button>
      </div>
    </div>
    <div id="pf-collection" class="filter-panel active"><label>Colección<select id="p-col" onchange="loadProducts()"><option value="">Seleccione…</option></select></label></div>
    <div id="pf-tag" class="filter-panel"><label>Tag<input id="p-tag" placeholder="Ej: pintura" oninput="debounce(loadProducts,600)"></label></div>
    <div id="pf-title" class="filter-panel"><label>Título contiene<input id="p-title" placeholder="Ej: silla" oninput="debounce(loadProducts,600)"></label></div>
    <div id="p-loading" class="empty-msg" style="display:none">Cargando…</div>
    <div id="p-extra-filters" style="display:none">
      <div style="display:flex;gap:24px;flex-wrap:wrap;margin:10px 0;padding:10px 0;border-top:1px solid #f0ece6">
        <div>
          <div style="font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:6px">SEO</div>
          <div class="seo-filter" id="p-seo-filter">
            <button class="seo-filter-btn active" data-f="all" onclick="setPSeoFilter('all',this)">Todos</button>
            <button class="seo-filter-btn" data-f="done" onclick="setPSeoFilter('done',this)">Con SEO</button>
            <button class="seo-filter-btn" data-f="none" onclick="setPSeoFilter('none',this)">Sin SEO</button>
          </div>
        </div>
        <div>
          <div style="font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:6px">Estado</div>
          <div class="seo-filter" id="p-status-filter">
            <button class="seo-filter-btn active" onclick="setPStatusFilter('all',this)">Todos</button>
            <button class="seo-filter-btn" onclick="setPStatusFilter('active',this)">Activo</button>
            <button class="seo-filter-btn" onclick="setPStatusFilter('draft',this)">Borrador</button>
          </div>
        </div>
        <div>
          <div style="font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:6px">Existencias</div>
          <div class="seo-filter" id="p-stock-filter">
            <button class="seo-filter-btn active" onclick="setPStockFilter('all',this)">Todos</button>
            <button class="seo-filter-btn" onclick="setPStockFilter('available',this)">Disponible</button>
            <button class="seo-filter-btn" onclick="setPStockFilter('soldout',this)">Sin stock</button>
          </div>
        </div>
      </div>
    </div>
    <div id="p-list"></div>
    <div class="sel-row"><span class="sel-count" id="p-count"></span><button class="sel-all-btn" id="p-selall" onclick="selAll('p')" style="display:none">Seleccionar todos</button></div>
  </div>
  <div class="btn-row">
    <button class="btn btn-primary" id="p-gen-btn" onclick="startGen('products')" disabled>Generar SEO con Claude</button>
    <span class="btn-hint" id="p-hint">Seleccione productos</span>
  </div>
  <div class="progress-wrap" id="p-prog"><div class="progress-bar"><div class="progress-fill" id="p-pfill"></div></div><div class="progress-lbl" id="p-plbl"></div></div>
  <div class="results-section" id="p-results">
    <h2>Propuestas</h2><p class="results-subtitle" id="p-rsub"></p>
    <div class="results-wrap"><table class="rtbl"><thead><tr><th>Producto</th><th>Meta título actual</th><th style="min-width:200px">Meta título propuesto <span style="opacity:0.4;font-size:8px">≤60</span></th><th style="min-width:260px">Meta descripción propuesta <span style="opacity:0.4;font-size:8px">≤160</span></th><th>Acción</th></tr></thead><tbody id="p-rtbody"></tbody></table></div>
    <div class="apply-bar"><span class="apply-count" id="p-acount">0 aprobadas</span><button class="btn btn-primary" id="p-apply-btn" onclick="applyAll('products')" disabled>Aplicar en Shopify</button><div id="p-apply-msg"></div></div>
  </div>
  <div id="p-msg"></div>
</div>

<!-- COLECCIONES -->
<div class="page" id="page-collections">
  <h1>Colecciones</h1>
  <p class="subtitle">Optimiza metatítulo y metadescripción de tus colecciones.</p>
  <div class="card">
    <button class="btn btn-secondary" onclick="loadCollectionsSEO()" style="margin-bottom:14px">Cargar colecciones</button>
    <div id="c-loading" class="empty-msg" style="display:none">Cargando…</div>
    <div id="c-seo-filter" style="display:none;margin:10px 0 4px;padding-top:10px;border-top:1px solid #f0ece6">
      <div style="font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:6px">SEO</div>
      <div class="seo-filter"><button class="seo-filter-btn active" onclick="setSeoFilter('collections','all',this)">Todos</button><button class="seo-filter-btn" onclick="setSeoFilter('collections','done',this)">Con SEO</button><button class="seo-filter-btn" onclick="setSeoFilter('collections','none',this)">Sin SEO</button></div>
    </div>
    <div id="c-list"></div>
    <div class="sel-row"><span class="sel-count" id="c-count"></span><button class="sel-all-btn" id="c-selall" onclick="selAll('c')" style="display:none">Seleccionar todos</button></div>
  </div>
  <div class="btn-row">
    <button class="btn btn-primary" id="c-gen-btn" onclick="startGen('collections')" disabled>Generar SEO con Claude</button>
    <span class="btn-hint" id="c-hint">Cargue las colecciones primero</span>
  </div>
  <div class="progress-wrap" id="c-prog"><div class="progress-bar"><div class="progress-fill" id="c-pfill"></div></div><div class="progress-lbl" id="c-plbl"></div></div>
  <div class="results-section" id="c-results">
    <h2>Propuestas</h2><p class="results-subtitle" id="c-rsub"></p>
    <div class="results-wrap"><table class="rtbl"><thead><tr><th>Colección</th><th>Meta título actual</th><th style="min-width:200px">Meta título propuesto</th><th style="min-width:260px">Meta descripción propuesta</th><th>Acción</th></tr></thead><tbody id="c-rtbody"></tbody></table></div>
    <div class="apply-bar"><span class="apply-count" id="c-acount">0 aprobadas</span><button class="btn btn-primary" id="c-apply-btn" onclick="applyAll('collections')" disabled>Aplicar en Shopify</button><div id="c-apply-msg"></div></div>
  </div>
  <div id="c-msg"></div>
</div>

<!-- METAOBJETOS -->
<div class="page" id="page-metaobjects">
  <h1>Metaobjetos</h1>
  <p class="subtitle">Optimiza SEO de tus metaobjetos con página pública.</p>
  <div class="card">
    <label style="margin-bottom:14px">Tipo de metaobjeto<select id="mo-type" onchange="loadMetaobjects()"><option value="">Seleccione tipo…</option></select></label>
    <div id="mo-loading" class="empty-msg" style="display:none">Cargando…</div>
    <div id="mo-seo-filter" style="display:none;margin:10px 0 4px;padding-top:10px;border-top:1px solid #f0ece6">
      <div style="font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:6px">SEO</div>
      <div class="seo-filter"><button class="seo-filter-btn active" onclick="setSeoFilter('metaobjects','all',this)">Todos</button><button class="seo-filter-btn" onclick="setSeoFilter('metaobjects','done',this)">Con SEO</button><button class="seo-filter-btn" onclick="setSeoFilter('metaobjects','none',this)">Sin SEO</button></div>
    </div>
    <div id="mo-list"></div>
    <div class="sel-row"><span class="sel-count" id="mo-count"></span><button class="sel-all-btn" id="mo-selall" onclick="selAll('mo')" style="display:none">Seleccionar todos</button></div>
  </div>
  <div class="btn-row">
    <button class="btn btn-primary" id="mo-gen-btn" onclick="startGen('metaobjects')" disabled>Generar SEO con Claude</button>
    <span class="btn-hint" id="mo-hint">Seleccione un tipo</span>
  </div>
  <div class="progress-wrap" id="mo-prog"><div class="progress-bar"><div class="progress-fill" id="mo-pfill"></div></div><div class="progress-lbl" id="mo-plbl"></div></div>
  <div class="results-section" id="mo-results">
    <h2>Propuestas</h2><p class="results-subtitle" id="mo-rsub"></p>
    <div class="results-wrap"><table class="rtbl"><thead><tr><th>Metaobjeto</th><th>Meta título actual</th><th style="min-width:200px">Meta título propuesto</th><th style="min-width:260px">Meta descripción propuesta</th><th>Acción</th></tr></thead><tbody id="mo-rtbody"></tbody></table></div>
    <div class="apply-bar"><span class="apply-count" id="mo-acount">0 aprobadas</span><button class="btn btn-primary" id="mo-apply-btn" onclick="applyAll('metaobjects')" disabled>Aplicar en Shopify</button><div id="mo-apply-msg"></div></div>
  </div>
  <div id="mo-msg"></div>
</div>

<!-- BLOG -->
<div class="page" id="page-articles">
  <h1>Blog</h1>
  <p class="subtitle">Optimiza metatítulo y metadescripción de tus artículos.</p>
  <div class="card">
    <div style="display:flex;gap:10px;margin-bottom:14px">
      <input id="art-search" placeholder="Buscar por título…" oninput="debounce(loadArticles,600)" style="flex:1">
      <button class="btn btn-secondary" onclick="loadArticles()" style="white-space:nowrap;padding:9px 16px">Cargar todos</button>
    </div>
    <div id="art-loading" class="empty-msg" style="display:none">Cargando…</div>
    <div id="art-seo-filter" style="display:none;margin:10px 0 4px;padding-top:10px;border-top:1px solid #f0ece6">
      <div style="font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:6px">SEO</div>
      <div class="seo-filter"><button class="seo-filter-btn active" onclick="setSeoFilter('articles','all',this)">Todos</button><button class="seo-filter-btn" onclick="setSeoFilter('articles','done',this)">Con SEO</button><button class="seo-filter-btn" onclick="setSeoFilter('articles','none',this)">Sin SEO</button></div>
    </div>
    <div id="art-list"></div>
    <div class="sel-row"><span class="sel-count" id="art-count"></span><button class="sel-all-btn" id="art-selall" onclick="selAll('art')" style="display:none">Seleccionar todos</button></div>
  </div>
  <div class="btn-row">
    <button class="btn btn-primary" id="art-gen-btn" onclick="startGen('articles')" disabled>Generar SEO con Claude</button>
    <span class="btn-hint" id="art-hint">Seleccione artículos</span>
  </div>
  <div class="progress-wrap" id="art-prog"><div class="progress-bar"><div class="progress-fill" id="art-pfill"></div></div><div class="progress-lbl" id="art-plbl"></div></div>
  <div class="results-section" id="art-results">
    <h2>Propuestas</h2><p class="results-subtitle" id="art-rsub"></p>
    <div class="results-wrap"><table class="rtbl"><thead><tr><th>Artículo</th><th>Meta título actual</th><th style="min-width:200px">Meta título propuesto</th><th style="min-width:260px">Meta descripción propuesta</th><th>Acción</th></tr></thead><tbody id="art-rtbody"></tbody></table></div>
    <div class="apply-bar"><span class="apply-count" id="art-acount">0 aprobadas</span><button class="btn btn-primary" id="art-apply-btn" onclick="applyAll('articles')" disabled>Aplicar en Shopify</button><div id="art-apply-msg"></div></div>
  </div>
  <div id="art-msg"></div>
</div>

<!-- IMÁGENES -->
<div class="page" id="page-images">
  <h1>Imágenes</h1>
  <p class="subtitle">Genera alt text optimizado para Google Images — muy valioso para pinturas y piezas únicas.</p>
  <div style="background:#fdfbf7;border:1px solid #e8dfd0;border-left:3px solid #c9a96e;padding:12px 16px;margin-bottom:16px;font-size:12px;color:#7a6240">
    <strong style="display:block;margin-bottom:3px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase">Formato del alt text</strong>
    El alt text se genera con el formato: <em>Título del producto — Vendor/Autor</em>. Esto optimiza la visibilidad en Google Images para pinturas y piezas únicas.
  </div>
  <div class="card">
    <span class="section-label">Filtrar productos</span>
    <div class="filter-row" id="imgf-filters">
      <button class="filter-btn active" onclick="setImgF('collection',this)">Por colección</button>
      <button class="filter-btn" onclick="setImgF('tag',this)">Por tag</button>
      <button class="filter-btn" onclick="setImgF('title',this)">Por título</button>
      <span style="color:#e8e2d9;margin:0 4px;align-self:center">|</span>
      <div id="img-seo-filter-top" style="display:flex;gap:6px;align-items:center">
        <button class="seo-filter-btn active" data-f="all" onclick="setSeoFilter('images','all',this)">Todos</button>
        <button class="seo-filter-btn" data-f="done" onclick="setSeoFilter('images','done',this)">Con alt</button>
        <button class="seo-filter-btn" data-f="none" onclick="setSeoFilter('images','none',this)">Sin alt</button>
      </div>
    </div>
    <div id="imgf-collection" class="filter-panel active"><label>Colección<select id="img-col" onchange="loadImages()"><option value="">Seleccione…</option></select></label></div>
    <div id="imgf-tag" class="filter-panel"><label>Tag<input id="img-tag" placeholder="Ej: pintura" oninput="debounce(loadImages,600)"></label></div>
    <div id="imgf-title" class="filter-panel"><label>Título<input id="img-title" placeholder="Ej: óleo" oninput="debounce(loadImages,600)"></label></div>
    <div id="img-loading" class="empty-msg" style="display:none">Cargando imágenes…</div>
    <div id="img-seo-filter" style="display:none;margin:10px 0 4px;padding-top:10px;border-top:1px solid #f0ece6">
      <div style="font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:6px">Alt text</div>
      <div class="seo-filter"><button class="seo-filter-btn active" data-f="all" onclick="setSeoFilter('images','all',this)">Todos</button><button class="seo-filter-btn" data-f="done" onclick="setSeoFilter('images','done',this)">Con alt</button><button class="seo-filter-btn" data-f="none" onclick="setSeoFilter('images','none',this)">Sin alt</button></div>
    </div>
    <div id="img-list"></div>
    <div class="sel-row"><span class="sel-count" id="img-count"></span><button class="sel-all-btn" id="img-selall" onclick="selAll('img')" style="display:none">Seleccionar todas</button></div>
  </div>
  <div class="btn-row">
    <button class="btn btn-primary" id="img-gen-btn" onclick="startGen('images')" disabled>Generar alt text con Claude</button>
    <span class="btn-hint" id="img-hint">Seleccione imágenes</span>
  </div>
  <div class="progress-wrap" id="img-prog"><div class="progress-bar"><div class="progress-fill" id="img-pfill"></div></div><div class="progress-lbl" id="img-plbl"></div></div>
  <div class="results-section" id="img-results">
    <h2>Alt text propuesto</h2><p class="results-subtitle" id="img-rsub"></p>
    <div class="results-wrap"><table class="rtbl"><thead><tr><th>Imagen</th><th>Producto</th><th>Alt actual</th><th style="min-width:220px">Alt propuesto <span style="opacity:0.4;font-size:8px">≤120</span></th><th>Acción</th></tr></thead><tbody id="img-rtbody"></tbody></table></div>
    <div class="apply-bar"><span class="apply-count" id="img-acount">0 aprobadas</span><button class="btn btn-primary" id="img-apply-btn" onclick="applyAll('images')" disabled>Aplicar en Shopify</button><div id="img-apply-msg"></div></div>
  </div>
  <div id="img-msg"></div>
</div>

<!-- HISTORIAL -->
<div class="page" id="page-history">
  <h1>Historial</h1>
  <p class="subtitle">Registro de optimizaciones SEO aplicadas.</p>
  <div class="card" style="padding:0"><div id="hist-content" class="empty-msg">Cargando…</div></div>
</div>

</div><!-- /main -->

<script>
// ── State ─────────────────────────────────────────────────────────────────────
const sections = {
  products:    { prefix:'p',   items:[], results:[], seoFilter:'all', statusFilter:'all', stockFilter:'all' },
  collections: { prefix:'c',   items:[], results:[], seoFilter:'all' },
  metaobjects: { prefix:'mo',  items:[], results:[], seoFilter:'all' },
  articles:    { prefix:'art', items:[], results:[], seoFilter:'all' },
  images:      { prefix:'img', items:[], results:[], seoFilter:'all' },
};
let processedIds = { products:new Set(), collections:new Set(), metaobjects:new Set(), articles:new Set(), images:new Set() };
let pFilterType = 'collection';
let imgFilterType = 'collection';
const SHOP = '${shopDomain}';

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const [cols, pids] = await Promise.all([
    fetch('/api/collections').then(r=>r.json()),
    fetch('/api/processed-ids').then(r=>r.json()),
  ]);
  Object.keys(pids).forEach(k => processedIds[k] = new Set(pids[k]));
  ['p-col','img-col'].forEach(id => {
    const sel = document.getElementById(id);
    cols.forEach(c => { const o = document.createElement('option'); o.value=c.id; o.textContent=c.title; sel.appendChild(o); });
  });
}

// ── Navigation ────────────────────────────────────────────────────────────────
function showPage(name, btn) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  btn.classList.add('active');
  if (name==='history') loadHistory();
  if (name==='metaobjects') loadMetaobjectTypes();
}

// ── Shared utils ──────────────────────────────────────────────────────────────
let dbTimer;
function debounce(fn,ms){clearTimeout(dbTimer);dbTimer=setTimeout(fn,ms);}

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function charCount(inp, limit, cid) {
  const n = inp.value.length;
  const el = document.getElementById(cid); if(!el) return;
  el.className='char-c '+(n>limit?'c-over':n>limit*0.85?'c-warn':'c-ok');
  el.textContent=n+'/'+limit;
}

function updateSelCount(prefix) {
  const all = document.querySelectorAll('[name="'+prefix+'_item"]');
  const n = Array.from(all).filter(c=>c.checked).length;
  const el = document.getElementById(prefix+'-count');
  const btn = document.getElementById(prefix+'-selall');
  if (el) el.textContent = all.length + ' elemento(s) — ' + n + ' seleccionado(s)';
  if (btn) btn.textContent = n===all.length&&all.length>0?'Deseleccionar todos':'Seleccionar todos';
  return n;
}

function selAll(prefix) {
  const all = document.querySelectorAll('[name="'+prefix+'_item"]');
  const allChecked = Array.from(all).every(c=>c.checked);
  all.forEach(c=>c.checked=!allChecked);
  afterSelChange(prefix);
}

function toggleRow(tr, prefix) {
  const cb = tr.querySelector('input[type=checkbox]');
  cb.checked = !cb.checked;
  afterSelChange(prefix);
}

function afterSelChange(prefix) {
  const n = updateSelCount(prefix);
  const genBtn = document.getElementById(prefix+'-gen-btn');
  const hint = document.getElementById(prefix+'-hint');
  if (genBtn) { genBtn.disabled = !n; if(hint) hint.textContent = n ? n+' elemento(s) listo(s)' : 'Seleccione elementos'; }
}

function showSectionMsg(prefix, text, type) {
  const el = document.getElementById(prefix+'-msg');
  if (!el) return;
  el.className='msg '+type; el.textContent=text; el.style.display='block';
  setTimeout(()=>el.style.display='none', 6000);
}

function updateApplyCount(prefix, results) {
  const n = results.filter(r=>r.approved).length;
  const el = document.getElementById(prefix+'-acount');
  const btn = document.getElementById(prefix+'-apply-btn');
  if (el) el.textContent = n + ' aprobada(s)';
  if (btn) btn.disabled = !n;
}

// ── Products ──────────────────────────────────────────────────────────────────
function setPF(type, btn) {
  pFilterType = type;
  document.querySelectorAll('#pf-filters .filter-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
  document.querySelectorAll('[id^="pf-"]').forEach(p=>p.classList.remove('active'));
  document.getElementById('pf-'+type).classList.add('active');
  sections.products.items=[]; sections.products.seoFilter='all'; sections.products.statusFilter='all'; sections.products.stockFilter='all';
  document.getElementById('p-list').innerHTML=''; document.getElementById('p-count').textContent=''; document.getElementById('p-selall').style.display='none'; document.getElementById('p-extra-filters').style.display='none';
  document.querySelectorAll('#p-seo-filter .seo-filter-btn, #p-seo-filter-top .seo-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.f === 'all'));
  ['p-status-filter','p-stock-filter'].forEach(id => document.querySelectorAll('#'+id+' .seo-filter-btn').forEach((b,i)=>{b.classList.toggle('active',i===0);}));
  afterSelChange('p');
}

function setPSeoFilter(f, btn) {
  sections.products.seoFilter = f;
  document.querySelectorAll('#p-seo-filter .seo-filter-btn, #p-seo-filter-top .seo-filter-btn')
    .forEach(b => b.classList.toggle('active', b.dataset.f === f));
  renderProductTable(sections.products.items);
}

function setSeoFilter(type, f, btn) {
  sections[type].seoFilter = f;
  const prefix = typeMap[type];
  document.querySelectorAll('#'+prefix+'-seo-filter .seo-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.f === f));
  const topEl = document.getElementById(prefix+'-seo-filter-top');
  if (topEl) topEl.querySelectorAll('.seo-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.f === f));
  if (type==='collections') renderCollTable();
  else if (type==='metaobjects') renderMOTable();
  else if (type==='articles') renderArtTable();
  else if (type==='images') renderImgTable();
}

function setPStatusFilter(f, btn) {
  sections.products.statusFilter = f;
  document.querySelectorAll('#p-status-filter .seo-filter-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
  renderProductTable(sections.products.items);
}

function setPStockFilter(f, btn) {
  sections.products.stockFilter = f;
  document.querySelectorAll('#p-stock-filter .seo-filter-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
  renderProductTable(sections.products.items);
}

async function loadProducts() {
  const load = document.getElementById('p-loading');
  load.style.display='block'; document.getElementById('p-list').innerHTML=''; sections.products.items=[];
  let url='/api/products?limit=50&';
  if(pFilterType==='collection'){const v=document.getElementById('p-col').value;if(!v){load.style.display='none';return;}url+='collection_id='+v;}
  else if(pFilterType==='tag'){const v=document.getElementById('p-tag').value.trim();if(!v){load.style.display='none';return;}url+='tag='+encodeURIComponent(v);}
  else if(pFilterType==='title'){const v=document.getElementById('p-title').value.trim();if(!v){load.style.display='none';return;}url+='title='+encodeURIComponent(v);}
  try{const d=await fetch(url).then(r=>r.json());sections.products.items=d.products||[];load.style.display='none';renderProductTable(sections.products.items);}
  catch(e){load.style.display='none';document.getElementById('p-list').innerHTML='<p class="empty-msg">Error cargando productos.</p>';}
}

function renderProductTable(products) {
  const { seoFilter, statusFilter, stockFilter } = sections.products;
  let filtered = products;
  if (seoFilter === 'done')   filtered = filtered.filter(p => processedIds.products.has(p.id));
  else if (seoFilter === 'none') filtered = filtered.filter(p => !processedIds.products.has(p.id));
  if (statusFilter === 'active') filtered = filtered.filter(p => p.status === 'active');
  else if (statusFilter === 'draft') filtered = filtered.filter(p => p.status !== 'active');
  if (stockFilter === 'available') filtered = filtered.filter(p => p.totalInventory > 0);
  else if (stockFilter === 'soldout') filtered = filtered.filter(p => p.totalInventory <= 0);

  const list=document.getElementById('p-list');
  const extraFilters=document.getElementById('p-extra-filters');
  if(extraFilters) extraFilters.style.display=products.length?'block':'none';
  if(!filtered.length){list.innerHTML='<p class="empty-msg">No hay productos en este filtro.</p>';document.getElementById('p-selall').style.display='none';afterSelChange('p');return;}
  list.innerHTML=\`<table class="tbl"><thead><tr><th style="width:30px"></th><th style="width:30px">SEO</th><th>Título</th><th>SKU</th><th>URL</th><th>Meta desc.</th><th>Estado</th></tr></thead><tbody>
    \${filtered.map(p=>\`<tr onclick="toggleRow(this,'p')">
      <td><input type="checkbox" name="p_item" value="\${p.id}" data-gid="\${p.gid}" data-obj='\${esc(JSON.stringify(p))}' onchange="afterSelChange('p');event.stopPropagation()"></td>
      <td class="\${processedIds.products.has(p.id)?'seo-done':'seo-none'}">\${processedIds.products.has(p.id)?'✓':'—'}</td>
      <td>\${esc(p.title)}</td>
      <td style="color:#aaa">\${esc(p.sku||'—')}</td>
      <td><a class="url-link" href="https://\${SHOP}.myshopify.com/products/\${p.handle}" target="_blank" onclick="event.stopPropagation()">/\${esc(p.handle)}</a></td>
      <td class="\${p.currentMetaDescription?'meta-ok':'meta-no'}">\${p.currentMetaDescription?'✓':'✗'}</td>
      <td><span class="status-badge \${p.status==='active'?'s-active':'s-draft'}">\${p.status==='active'?'Activo':'Borrador'}</span></td>
    </tr>\`).join('')}
  </tbody></table>\`;
  document.getElementById('p-selall').style.display='block';
  afterSelChange('p');
}

// ── Collections ───────────────────────────────────────────────────────────────
async function loadCollectionsSEO() {
  const load=document.getElementById('c-loading'); load.style.display='block'; document.getElementById('c-list').innerHTML=''; sections.collections.items=[];
  try{const d=await fetch('/api/collections/seo').then(r=>r.json());sections.collections.items=d.collections||[];load.style.display='none';renderCollTable();}
  catch(e){load.style.display='none';document.getElementById('c-list').innerHTML='<p class="empty-msg">Error cargando.</p>';}
}

function renderCollTable() {
  const f=sections.collections.seoFilter;
  const sf=document.getElementById('c-seo-filter'); if(sf) sf.style.display=sections.collections.items.length?'block':'none';
  const items = f==='done' ? sections.collections.items.filter(c=>processedIds.collections.has(c.id))
              : f==='none' ? sections.collections.items.filter(c=>!processedIds.collections.has(c.id))
              : sections.collections.items;
  const list=document.getElementById('c-list');
  if(!items.length){list.innerHTML='<p class="empty-msg">No hay colecciones en este filtro.</p>';document.getElementById('c-selall').style.display='none';afterSelChange('c');return;}
  list.innerHTML=\`<table class="tbl"><thead><tr><th style="width:30px"></th><th style="width:30px">SEO</th><th>Colección</th><th>URL</th><th>Meta título</th><th>Meta desc.</th></tr></thead><tbody>
    \${items.map(c=>\`<tr onclick="toggleRow(this,'c')">
      <td><input type="checkbox" name="c_item" value="\${c.id}" data-obj='\${esc(JSON.stringify(c))}' onchange="afterSelChange('c');event.stopPropagation()"></td>
      <td class="\${processedIds.collections.has(c.id)?'seo-done':'seo-none'}">\${processedIds.collections.has(c.id)?'✓':'—'}</td>
      <td>\${esc(c.title)}</td>
      <td><a class="url-link" href="https://\${SHOP}.myshopify.com/collections/\${c.handle}" target="_blank" onclick="event.stopPropagation()">/collections/\${esc(c.handle)}</a></td>
      <td class="\${c.currentMetaTitle?'meta-ok':'meta-no'}">\${c.currentMetaTitle?'✓':'✗'}</td>
      <td class="\${c.currentMetaDescription?'meta-ok':'meta-no'}">\${c.currentMetaDescription?'✓':'✗'}</td>
    </tr>\`).join('')}
  </tbody></table>\`;
  document.getElementById('c-selall').style.display='block';
  afterSelChange('c');
}

// ── Metaobjects ───────────────────────────────────────────────────────────────
let moTypesLoaded = false;
async function loadMetaobjectTypes() {
  if (moTypesLoaded) return;
  const sel = document.getElementById('mo-type');
  sel.disabled = true;
  const hint = document.getElementById('mo-hint');
  if (hint) hint.textContent = 'Cargando tipos…';
  try {
    const types = await fetch('/api/metaobjects/types').then(r => r.json());
    sel.innerHTML = '<option value="">Seleccione tipo…</option>';
    if (!types.length) {
      sel.innerHTML = '<option value="">Sin metaobjetos definidos</option>';
      if (hint) hint.textContent = 'No se encontraron tipos de metaobjetos';
    } else {
      types.forEach(t => {
        const o = document.createElement('option');
        o.value = t.type; o.textContent = t.name || t.type;
        sel.appendChild(o);
      });
      if (hint) hint.textContent = types.length + ' tipo(s) disponible(s)';
      moTypesLoaded = true;
    }
  } catch(e) {
    sel.innerHTML = '<option value="">Error al cargar — reintente</option>';
    if (hint) hint.textContent = 'Error: ' + e.message;
    moTypesLoaded = false;
  }
  sel.disabled = false;
}

async function loadMetaobjects() {
  const type=document.getElementById('mo-type').value; if(!type) return;
  const load=document.getElementById('mo-loading'); load.style.display='block'; document.getElementById('mo-list').innerHTML=''; sections.metaobjects.items=[];
  try{const d=await fetch('/api/metaobjects?type='+encodeURIComponent(type)).then(r=>r.json());sections.metaobjects.items=d.metaobjects||[];load.style.display='none';renderMOTable();}
  catch(e){load.style.display='none';}
}

function renderMOTable() {
  const f=sections.metaobjects.seoFilter;
  const sf=document.getElementById('mo-seo-filter'); if(sf) sf.style.display=sections.metaobjects.items.length?'block':'none';
  const items = f==='done' ? sections.metaobjects.items.filter(m=>processedIds.metaobjects.has(m.id))
              : f==='none' ? sections.metaobjects.items.filter(m=>!processedIds.metaobjects.has(m.id))
              : sections.metaobjects.items;
  const list=document.getElementById('mo-list');
  if(!items.length){list.innerHTML='<p class="empty-msg">No hay metaobjetos en este filtro.</p>';afterSelChange('mo');return;}
  list.innerHTML=\`<table class="tbl"><thead><tr><th style="width:30px"></th><th style="width:30px">SEO</th><th>Nombre</th><th>Meta título</th></tr></thead><tbody>
    \${items.map(m=>\`<tr onclick="toggleRow(this,'mo')">
      <td><input type="checkbox" name="mo_item" value="\${m.id}" data-obj='\${esc(JSON.stringify(m))}' onchange="afterSelChange('mo');event.stopPropagation()"></td>
      <td class="\${processedIds.metaobjects.has(m.id)?'seo-done':'seo-none'}">\${processedIds.metaobjects.has(m.id)?'✓':'—'}</td>
      <td>\${esc(m.displayName)}</td>
      <td class="\${m.currentMetaTitle?'meta-ok':'meta-no'}">\${m.currentMetaTitle?'✓':'✗'}</td>
    </tr>\`).join('')}
  </tbody></table>\`;
  document.getElementById('mo-selall').style.display='block';
  afterSelChange('mo');
}

// ── Articles ──────────────────────────────────────────────────────────────────
async function loadArticles() {
  const s=document.getElementById('art-search').value.trim();
  const load=document.getElementById('art-loading'); load.style.display='block'; document.getElementById('art-list').innerHTML=''; sections.articles.items=[];
  try{const d=await fetch('/api/articles?limit=50'+(s?'&search='+encodeURIComponent(s):'')).then(r=>r.json());sections.articles.items=d.articles||[];load.style.display='none';renderArtTable();}
  catch(e){load.style.display='none';}
}

function renderArtTable() {
  const f=sections.articles.seoFilter;
  const sf=document.getElementById('art-seo-filter'); if(sf) sf.style.display=sections.articles.items.length?'block':'none';
  const items = f==='done' ? sections.articles.items.filter(a=>processedIds.articles.has(a.id))
              : f==='none' ? sections.articles.items.filter(a=>!processedIds.articles.has(a.id))
              : sections.articles.items;
  const list=document.getElementById('art-list');
  if(!items.length){list.innerHTML='<p class="empty-msg">No hay artículos en este filtro.</p>';afterSelChange('art');return;}
  list.innerHTML=\`<table class="tbl"><thead><tr><th style="width:30px"></th><th style="width:30px">SEO</th><th>Artículo</th><th>Blog</th><th>Meta título</th><th>Meta desc.</th></tr></thead><tbody>
    \${items.map(a=>\`<tr onclick="toggleRow(this,'art')">
      <td><input type="checkbox" name="art_item" value="\${a.id}" data-obj='\${esc(JSON.stringify(a))}' onchange="afterSelChange('art');event.stopPropagation()"></td>
      <td class="\${processedIds.articles.has(a.id)?'seo-done':'seo-none'}">\${processedIds.articles.has(a.id)?'✓':'—'}</td>
      <td>\${esc(a.title)}</td>
      <td style="color:#aaa;font-size:11px">\${esc(a.blogTitle)}</td>
      <td class="\${a.currentMetaTitle?'meta-ok':'meta-no'}">\${a.currentMetaTitle?'✓':'✗'}</td>
      <td class="\${a.currentMetaDescription?'meta-ok':'meta-no'}">\${a.currentMetaDescription?'✓':'✗'}</td>
    </tr>\`).join('')}
  </tbody></table>\`;
  document.getElementById('art-selall').style.display='block';
  afterSelChange('art');
}

// ── Images ────────────────────────────────────────────────────────────────────
function setImgF(type, btn) {
  imgFilterType=type;
  document.querySelectorAll('#imgf-filters .filter-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
  document.querySelectorAll('[id^="imgf-"]').forEach(p=>p.classList.remove('active'));
  document.getElementById('imgf-'+type).classList.add('active');
  sections.images.items=[]; document.getElementById('img-list').innerHTML=''; document.getElementById('img-count').textContent=''; document.getElementById('img-selall').style.display='none';
  afterSelChange('img');
}

async function loadImages() {
  const load=document.getElementById('img-loading'); load.style.display='block'; document.getElementById('img-list').innerHTML=''; sections.images.items=[];
  let url='/api/images?limit=20&';
  if(imgFilterType==='collection'){const v=document.getElementById('img-col').value;if(!v){load.style.display='none';return;}url+='collection_id='+v;}
  else if(imgFilterType==='tag'){const v=document.getElementById('img-tag').value.trim();if(!v){load.style.display='none';return;}url+='tag='+encodeURIComponent(v);}
  else if(imgFilterType==='title'){const v=document.getElementById('img-title').value.trim();if(!v){load.style.display='none';return;}url+='title='+encodeURIComponent(v);}
  try{const d=await fetch(url).then(r=>r.json());sections.images.items=d.images||[];load.style.display='none';renderImgTable();}
  catch(e){load.style.display='none';}
}

function renderImgTable() {
  const f=sections.images.seoFilter;
  const sf=document.getElementById('img-seo-filter'); if(sf) sf.style.display=sections.images.items.length?'block':'none';
  const items = f==='done' ? sections.images.items.filter(i=>processedIds.images.has(i.id))
              : f==='none' ? sections.images.items.filter(i=>!processedIds.images.has(i.id) && !i.currentAlt)
              : sections.images.items;
  const list=document.getElementById('img-list');
  if(!items.length){list.innerHTML='<p class="empty-msg">No hay imágenes en este filtro.</p>';afterSelChange('img');return;}
  list.innerHTML=\`<table class="tbl"><thead><tr><th style="width:30px"></th><th style="width:30px">SEO</th><th>Imagen</th><th>Producto</th><th>Alt actual</th></tr></thead><tbody>
    \${items.map(img=>\`<tr onclick="toggleRow(this,'img')">
      <td><input type="checkbox" name="img_item" value="\${img.id}" data-obj='\${esc(JSON.stringify(img))}' onchange="afterSelChange('img');event.stopPropagation()"></td>
      <td class="\${processedIds.images.has(img.id)?'seo-done':'seo-none'}">\${processedIds.images.has(img.id)?'✓':'—'}</td>
      <td><img src="\${esc(img.url)}" class="thumb" loading="lazy"></td>
      <td>\${esc(img.productTitle)}</td>
      <td style="font-size:11px;color:\${img.currentAlt?'#555':'#ccc'}">\${img.currentAlt||'(sin alt)'}</td>
    </tr>\`).join('')}
  </tbody></table>\`;
  document.getElementById('img-selall').style.display='block';
  afterSelChange('img');
}

// ── SEO Generation (shared) ───────────────────────────────────────────────────
const typeMap = { products:'p', collections:'c', metaobjects:'mo', articles:'art', images:'img' };
const nameMap = { products:'p_item', collections:'c_item', metaobjects:'mo_item', articles:'art_item', images:'img_item' };

async function startGen(type) {
  const prefix = typeMap[type];
  const checkboxes = Array.from(document.querySelectorAll('[name="'+nameMap[type]+'"]:checked'));
  const items = checkboxes.map(c => JSON.parse(c.dataset.obj));
  if (!items.length) return;

  sections[type].results = [];
  document.getElementById(prefix+'-rtbody').innerHTML='';
  document.getElementById(prefix+'-results').style.display='none';
  document.getElementById(prefix+'-prog').style.display='block';
  document.getElementById(prefix+'-gen-btn').disabled=true;
  if(document.getElementById(prefix+'-msg')) document.getElementById(prefix+'-msg').style.display='none';

  try {
    const {jobId} = await fetch('/api/seo/queue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,items})}).then(r=>r.json());
    const es = new EventSource('/api/seo/stream/'+jobId);
    es.onmessage = e => {
      const data = JSON.parse(e.data);
      if (data.done) {
        es.close();
        document.getElementById(prefix+'-prog').style.display='none';
        document.getElementById(prefix+'-gen-btn').disabled=false;
        afterSelChange(prefix);
        showGenResults(type);
        return;
      }
      updateProg(prefix, data.index, data.total);
      if (!data.error) { sections[type].results.push({...data, approved:true}); appendResult(type, data, sections[type].results.length-1); }
      else { appendErrResult(prefix, data); }
      updateApplyCount(prefix, sections[type].results);
    };
    es.onerror = () => { es.close(); document.getElementById(prefix+'-prog').style.display='none'; document.getElementById(prefix+'-gen-btn').disabled=false; afterSelChange(prefix); showSectionMsg(prefix,'Error en la generación.','err'); };
  } catch(e) {
    document.getElementById(prefix+'-prog').style.display='none';
    document.getElementById(prefix+'-gen-btn').disabled=false;
    afterSelChange(prefix);
    showSectionMsg(prefix,'Error: '+e.message,'err');
  }
}

function updateProg(prefix, idx, total) {
  document.getElementById(prefix+'-pfill').style.width=Math.round(idx/total*100)+'%';
  document.getElementById(prefix+'-plbl').textContent='Procesando '+idx+' de '+total+'…';
}

function showGenResults(type) {
  const prefix=typeMap[type]; const n=sections[type].results.length;
  const sec=document.getElementById(prefix+'-results'); sec.style.display='block';
  document.getElementById(prefix+'-rsub').textContent=n+' propuesta(s) generada(s). Revisa y edita antes de aplicar.';
  updateApplyCount(prefix, sections[type].results);
  sec.scrollIntoView({behavior:'smooth',block:'start'});
}

function appendResult(type, data, idx) {
  const prefix=typeMap[type];
  const tbody=document.getElementById(prefix+'-rtbody');
  const tr=document.createElement('tr'); tr.id=prefix+'-rr-'+idx;

  if (type === 'images') {
    tr.innerHTML=\`
      <td><img src="\${esc(data.url)}" class="thumb"></td>
      <td class="td-name">\${esc(data.productTitle)}</td>
      <td class="td-cur">\${esc(data.currentAlt||'(sin alt)')}</td>
      <td><input class="seo-inp" type="text" maxlength="125" value="\${esc(data.altText)}" oninput="charCount(this,120,'\${prefix}-cc-\${idx}')" id="\${prefix}-ai-\${idx}"><div class="char-c" id="\${prefix}-cc-\${idx}"></div></td>
      <td class="td-act"><div style="display:flex;gap:5px;flex-direction:column"><button class="btn-ap on" id="\${prefix}-ba-\${idx}" onclick="setApp('\${type}',\${idx},true)">Aprobar</button><button class="btn-rj" id="\${prefix}-br-\${idx}" onclick="setApp('\${type}',\${idx},false)">Rechazar</button></div></td>
    \`;
    tbody.appendChild(tr);
    const inp=document.getElementById(prefix+'-ai-'+idx); if(inp) charCount(inp,120,prefix+'-cc-'+idx);
  } else {
    tr.innerHTML=\`
      <td class="td-name">\${esc(data.productTitle||data.collectionTitle||data.metaobjectTitle||data.articleTitle)}</td>
      <td class="td-cur">\${esc(data.currentMetaTitle||'(sin meta título)')}</td>
      <td><input class="seo-inp" type="text" maxlength="65" value="\${esc(data.metaTitle)}" oninput="charCount(this,60,'\${prefix}-ct-\${idx}')" id="\${prefix}-ti-\${idx}"><div class="char-c" id="\${prefix}-ct-\${idx}"></div></td>
      <td><textarea class="seo-inp" maxlength="165" rows="3" oninput="charCount(this,160,'\${prefix}-cd-\${idx}')" id="\${prefix}-di-\${idx}">\${esc(data.metaDescription)}</textarea><div class="char-c" id="\${prefix}-cd-\${idx}"></div></td>
      <td class="td-act"><div style="display:flex;gap:5px;flex-direction:column"><button class="btn-ap on" id="\${prefix}-ba-\${idx}" onclick="setApp('\${type}',\${idx},true)">Aprobar</button><button class="btn-rj" id="\${prefix}-br-\${idx}" onclick="setApp('\${type}',\${idx},false)">Rechazar</button></div></td>
    \`;
    tbody.appendChild(tr);
    const ti=document.getElementById(prefix+'-ti-'+idx); if(ti) charCount(ti,60,prefix+'-ct-'+idx);
    const di=document.getElementById(prefix+'-di-'+idx); if(di) charCount(di,160,prefix+'-cd-'+idx);
  }
}

function appendErrResult(prefix, data) {
  const tbody=document.getElementById(prefix+'-rtbody');
  const tr=document.createElement('tr');
  tr.innerHTML=\`<td colspan="5" style="color:#c0392b;font-size:11px;padding:8px 12px">Error en "\${esc(data.itemTitle||'?')}": \${esc(data.error)}</td>\`;
  tbody.appendChild(tr);
}

function setApp(type, idx, approved) {
  sections[type].results[idx].approved=approved;
  const prefix=typeMap[type];
  document.getElementById(prefix+'-ba-'+idx).classList.toggle('on',approved);
  document.getElementById(prefix+'-br-'+idx).classList.toggle('on',!approved);
  document.getElementById(prefix+'-rr-'+idx).classList.toggle('rejected',!approved);
  updateApplyCount(prefix, sections[type].results);
}

// ── Apply ─────────────────────────────────────────────────────────────────────
async function applyAll(type) {
  const prefix=typeMap[type];
  const toApply = sections[type].results
    .map((r,idx) => {
      if (!r.approved) return null;
      if (type==='images') return {...r, altText:(document.getElementById(prefix+'-ai-'+idx)?.value||r.altText).trim()};
      return {...r, metaTitle:(document.getElementById(prefix+'-ti-'+idx)?.value||r.metaTitle).trim(), metaDescription:(document.getElementById(prefix+'-di-'+idx)?.value||r.metaDescription).trim()};
    })
    .filter(Boolean);

  if (!toApply.length) return;
  const btn=document.getElementById(prefix+'-apply-btn'); btn.disabled=true; btn.textContent='Aplicando…';

  try {
    const res=await fetch('/api/seo/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,items:toApply})}).then(r=>r.json());
    const msgEl=document.getElementById(prefix+'-apply-msg');
    msgEl.className='msg '+(res.errors.length?'err':'ok');
    msgEl.textContent=res.applied.length+' actualizado(s) en Shopify.'+(res.errors.length?' '+res.errors.length+' error(es).':'');
    msgEl.style.display='block';
    // Update checkmarks in table
    res.applied.forEach(a => { if(a.id) processedIds[type].add(a.id); });
    if (type==='products') renderProductTable(sections.products.items);
    else if (type==='collections') renderCollTable();
  } catch(e) { showSectionMsg(prefix,'Error al aplicar: '+e.message,'err'); }

  btn.textContent='Aplicar en Shopify'; btn.disabled=false;
}

// ── History ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  const container=document.getElementById('hist-content');
  try {
    const data=await fetch('/api/history').then(r=>r.json());
    if (!data.length){container.className='empty-msg';container.textContent='Aún no hay cambios registrados.';return;}
    const typeLabels={products:'Productos',collections:'Colecciones',metaobjects:'Metaobjetos',articles:'Blog',images:'Imágenes'};
    container.className='';
    container.innerHTML=\`<table class="htbl"><thead><tr><th style="padding:10px 12px">Fecha</th><th>Tipo</th><th>Aplicados</th><th>Errores</th><th>Elementos</th></tr></thead><tbody>
      \${data.map(e=>\`<tr>
        <td style="padding:9px 12px;white-space:nowrap">\${new Date(e.date).toLocaleString('es-CL')}</td>
        <td><span class="type-badge">\${typeLabels[e.type]||e.type||'—'}</span></td>
        <td>\${e.applied.length}</td>
        <td>\${e.errors?.length||0}</td>
        <td style="font-size:11px;color:#666;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${e.applied.slice(0,5).map(a=>a.title).join(', ')}\${e.applied.length>5?' …':''}</td>
      </tr>\`).join('')}
    </tbody></table>\`;
  } catch(e){container.textContent='Error cargando historial.';}
}

init();
</script>
</body>
</html>`;
}
