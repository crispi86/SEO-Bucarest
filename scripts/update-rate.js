/**
 * Actualiza el metacampo bucarest.usd_rate en la tienda Shopify.
 * Ejecutado diariamente por GitHub Actions.
 *
 * Lógica:
 *   - Obtiene tipo de cambio real USD→CLP desde frankfurter.app
 *   - Aplica factor de depreciación (para cubrir comisión PayPal)
 *   - Guarda CLP_ajustados_por_USD en el metacampo
 *   - En Liquid: usd = (price / 100) / usd_rate
 *
 * Ejemplo: mercado 1 USD = 950 CLP, factor 1.08
 *   → se guarda 879.63 CLP/USD
 *   → producto a $95.000 CLP se muestra como USD 108
 */

const https = require('https');

const DEPRECIATION_FACTOR = 1.08; // +8% para cubrir comisión PayPal
const SHOP = (process.env.SHOPIFY_SHOP || '').trim();
const TOKEN = (process.env.SHOPIFY_ACCESS_TOKEN || '').trim();

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'bucarest-rate-updater/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function graphql(query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SHOP,
      path: '/admin/api/2024-01/graphql.json',
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function getCurrentRate() {
  const result = await graphql(`{
    shop { metafield(namespace: "bucarest", key: "usd_rate") { value } }
  }`);
  return result?.data?.shop?.metafield?.value || null;
}

async function saveRate(rate) {
  const result = await graphql(`
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value }
        userErrors { field message }
      }
    }
  `, {
    metafields: [{
      ownerId: `gid://shopify/Shop/1`, // se sobreescribe con el ID real abajo
      namespace: 'bucarest',
      key: 'usd_rate',
      value: String(rate),
      type: 'number_decimal',
    }],
  });
  const errors = result?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join(', '));
  return true;
}

async function getShopId() {
  const result = await graphql(`{ shop { id } }`);
  return result?.data?.shop?.id;
}

async function main() {
  console.log('Consultando tipo de cambio USD→CLP...');
  let clpPerUsd;

  try {
    const data = await get('https://api.frankfurter.app/latest?from=USD&to=CLP');
    clpPerUsd = data?.rates?.CLP;
    if (!clpPerUsd || clpPerUsd <= 0) throw new Error('Respuesta inválida: ' + JSON.stringify(data));
    console.log(`Tipo de cambio de mercado: 1 USD = ${clpPerUsd} CLP`);
  } catch (e) {
    console.error('Error al obtener tipo de cambio:', e.message);
    const prev = await getCurrentRate();
    if (prev) {
      console.log(`Manteniendo valor anterior: ${prev}`);
    } else {
      console.log('Sin valor anterior. No se actualiza el metacampo.');
    }
    process.exit(0);
  }

  const adjustedRate = clpPerUsd / DEPRECIATION_FACTOR;
  console.log(`Factor de depreciación: ${DEPRECIATION_FACTOR} → tasa ajustada: ${adjustedRate.toFixed(4)} CLP/USD`);

  const shopId = await getShopId();
  if (!shopId) throw new Error('No se pudo obtener el ID de la tienda');

  const body = JSON.stringify({
    metafields: [{
      ownerId: shopId,
      namespace: 'bucarest',
      key: 'usd_rate',
      value: adjustedRate.toFixed(4),
      type: 'number_decimal',
    }],
  });

  const result = await graphql(`
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value }
        userErrors { field message }
      }
    }
  `, {
    metafields: [{
      ownerId: shopId,
      namespace: 'bucarest',
      key: 'usd_rate',
      value: adjustedRate.toFixed(4),
      type: 'number_decimal',
    }],
  });

  const errors = result?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join(', '));

  const saved = result?.data?.metafieldsSet?.metafields?.[0]?.value;
  console.log(`✅ Metacampo actualizado: bucarest.usd_rate = ${saved}`);
}

main().catch(e => { console.error('Error fatal:', e.message); process.exit(1); });
