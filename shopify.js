const https = require('https');
const SHOP = () => process.env.SHOPIFY_SHOP;
const TOKEN = () => process.env.SHOPIFY_ACCESS_TOKEN;

function graphqlRequest(query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SHOP(), path: '/admin/api/2024-01/graphql.json', method: 'POST',
      headers: { 'X-Shopify-Access-Token': TOKEN(), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.errors) {
            const errs = Array.isArray(parsed.errors) ? parsed.errors : [parsed.errors];
            const msg = errs.map(e => (typeof e === 'string' ? e : (e.message || JSON.stringify(e)))).join('; ');
            console.error('GraphQL errors:', msg);
            return reject(new Error('GraphQL: ' + msg));
          }
          resolve(parsed);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function restRequest(method, path, body = null) {
  const bodyStr = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SHOP(), path: `/admin/api/2024-01/${path}`, method,
      headers: { 'X-Shopify-Access-Token': TOKEN(), 'Content-Type': 'application/json', ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr); req.end();
  });
}

// ── PRODUCTS ──────────────────────────────────────────────────────────────────

const PRODUCT_FIELDS = `
  id handle title descriptionHtml tags vendor productType status totalInventory
  variants(first: 1) { edges { node { sku price } } }
  seo { title description }
`;

function mapProduct(node) {
  return {
    id: node.id.replace('gid://shopify/Product/', ''),
    gid: node.id,
    handle: node.handle || '',
    title: node.title,
    description: (node.descriptionHtml || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 600),
    tags: node.tags || [],
    vendor: node.vendor || '',
    productType: node.productType || '',
    status: (node.status || 'draft').toLowerCase(),
    sku: node.variants?.edges?.[0]?.node?.sku || '',
    totalInventory: node.totalInventory ?? 0,
    currentMetaTitle: node.seo?.title || '',
    currentMetaDescription: node.seo?.description || '',
  };
}

async function getProductsByCollection(collectionId, limit = 50, after = null) {
  const afterClause = after ? `, after: "${after}"` : '';
  const result = await graphqlRequest(`{
    collection(id: "gid://shopify/Collection/${collectionId}") {
      products(first: ${limit}${afterClause}) {
        pageInfo { hasNextPage endCursor }
        edges { node { ${PRODUCT_FIELDS} } }
      }
    }
  }`);
  return {
    products: (result?.data?.collection?.products?.edges || []).map(e => mapProduct(e.node)),
    pageInfo: result?.data?.collection?.products?.pageInfo,
  };
}

async function getProductsByQuery(queryStr, limit = 50, after = null) {
  const afterClause = after ? `, after: "${after}"` : '';
  const q = queryStr ? `, query: ${JSON.stringify(queryStr)}` : '';
  const result = await graphqlRequest(`{
    products(first: ${limit}${q}${afterClause}) {
      pageInfo { hasNextPage endCursor }
      edges { node { ${PRODUCT_FIELDS} } }
    }
  }`);
  return {
    products: (result?.data?.products?.edges || []).map(e => mapProduct(e.node)),
    pageInfo: result?.data?.products?.pageInfo,
  };
}

async function updateProductSEO(productGid, metaTitle, metaDescription) {
  const result = await graphqlRequest(`
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id seo { title description } }
        userErrors { field message }
      }
    }
  `, { input: { id: productGid, seo: { title: metaTitle, description: metaDescription } } });
  const errors = result?.data?.productUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join(', '));
  return true;
}

// ── COLLECTIONS ───────────────────────────────────────────────────────────────

async function getCollections() {
  const result = await graphqlRequest(`{
    collections(first: 250) { edges { node { id title } } }
  }`);
  return (result?.data?.collections?.edges || [])
    .map(e => ({ id: e.node.id.replace('gid://shopify/Collection/', ''), title: e.node.title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

async function getCollectionsWithSEO(limit = 250, after = null) {
  const afterClause = after ? `, after: "${after}"` : '';
  const result = await graphqlRequest(`{
    collections(first: ${limit}${afterClause}) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id handle title
          descriptionHtml
          seo { title description }
        }
      }
    }
  }`);
  return {
    collections: (result?.data?.collections?.edges || []).map(e => ({
      id: e.node.id.replace('gid://shopify/Collection/', ''),
      gid: e.node.id,
      handle: e.node.handle || '',
      title: e.node.title,
      description: (e.node.descriptionHtml || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 400),
      currentMetaTitle: e.node.seo?.title || '',
      currentMetaDescription: e.node.seo?.description || '',
    })).sort((a, b) => a.title.localeCompare(b.title)),
    pageInfo: result?.data?.collections?.pageInfo,
  };
}

async function updateCollectionSEO(collectionGid, metaTitle, metaDescription) {
  const result = await graphqlRequest(`
    mutation collectionUpdate($input: CollectionInput!) {
      collectionUpdate(input: $input) {
        collection { id seo { title description } }
        userErrors { field message }
      }
    }
  `, { input: { id: collectionGid, seo: { title: metaTitle, description: metaDescription } } });
  const errors = result?.data?.collectionUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join(', '));
  return true;
}

// ── METAOBJECTS ───────────────────────────────────────────────────────────────

async function getMetaobjectTypes() {
  const result = await graphqlRequest(`{
    metaobjectDefinitions(first: 50) {
      edges { node { id type name } }
    }
  }`);
  console.log('getMetaobjectTypes raw:', JSON.stringify(result?.data), 'errors:', JSON.stringify(result?.errors));
  return (result?.data?.metaobjectDefinitions?.edges || []).map(e => ({
    id: e.node.id, type: e.node.type, name: e.node.name,
  }));
}

async function getMetaobjectsByType(type, limit = 50, after = null) {
  const afterClause = after ? `, after: "${after}"` : '';
  const result = await graphqlRequest(`{
    metaobjects(type: ${JSON.stringify(type)}, first: ${limit}${afterClause}) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id handle displayName
          fields { key value }
        }
      }
    }
  }`);
  return {
    metaobjects: (result?.data?.metaobjects?.edges || []).map(e => ({
      id: e.node.id.replace('gid://shopify/Metaobject/', ''),
      gid: e.node.id,
      handle: e.node.handle || '',
      displayName: e.node.displayName || e.node.handle || '',
      fields: e.node.fields || [],
      currentMetaTitle: (e.node.fields || []).find(f => f.key === 'seo_title')?.value || '',
      currentMetaDescription: (e.node.fields || []).find(f => f.key === 'seo_description')?.value || '',
    })),
    pageInfo: result?.data?.metaobjects?.pageInfo,
  };
}

async function updateMetaobjectSEO(metaobjectGid, metaTitle, metaDescription) {
  const result = await graphqlRequest(`
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value }
        userErrors { field message }
      }
    }
  `, {
    metafields: [
      { ownerId: metaobjectGid, namespace: 'global', key: 'title_tag', value: metaTitle, type: 'single_line_text_field' },
      { ownerId: metaobjectGid, namespace: 'global', key: 'description_tag', value: metaDescription, type: 'single_line_text_field' },
    ],
  });
  const errors = result?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join(', '));
  return true;
}

// ── BLOG ARTICLES ─────────────────────────────────────────────────────────────

async function getBlogArticles(searchQuery = '', limit = 50, after = null) {
  const afterClause = after ? `, after: "${after}"` : '';
  const qClause = searchQuery ? `, query: ${JSON.stringify(searchQuery)}` : '';
  const result = await graphqlRequest(`{
    articles(first: ${limit}${qClause}${afterClause}) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id handle title tags
          blog { title }
          seo { title description }
        }
      }
    }
  }`);
  return {
    articles: (result?.data?.articles?.edges || []).map(e => ({
      id: e.node.id.replace('gid://shopify/Article/', ''),
      gid: e.node.id,
      handle: e.node.handle || '',
      title: e.node.title,
      blogTitle: e.node.blog?.title || '',
      tags: e.node.tags || [],
      currentMetaTitle: e.node.seo?.title || '',
      currentMetaDescription: e.node.seo?.description || '',
    })),
    pageInfo: result?.data?.articles?.pageInfo,
  };
}

async function updateArticleSEO(articleGid, metaTitle, metaDescription) {
  const result = await graphqlRequest(`
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value }
        userErrors { field message }
      }
    }
  `, {
    metafields: [
      { ownerId: articleGid, namespace: 'global', key: 'title_tag', value: metaTitle, type: 'single_line_text_field' },
      { ownerId: articleGid, namespace: 'global', key: 'description_tag', value: metaDescription, type: 'single_line_text_field' },
    ],
  });
  const errors = result?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join(', '));
  return true;
}

// ── PRODUCT IMAGES ────────────────────────────────────────────────────────────

const IMAGE_PRODUCT_FIELDS = `
  id handle title vendor productType
  images(first: 20) { edges { node { id altText url } } }
`;

function mapImageProduct(node) {
  return {
    id: node.id.replace('gid://shopify/Product/', ''),
    gid: node.id,
    handle: node.handle || '',
    title: node.title,
    vendor: node.vendor || '',
    productType: node.productType || '',
    images: (node.images?.edges || []).map(e => ({
      id: e.node.id.replace('gid://shopify/ProductImage/', ''),
      gid: e.node.id,
      url: e.node.url,
      currentAlt: e.node.altText || '',
    })),
  };
}

async function getProductsWithImages(collectionId, queryStr, limit = 20, after = null) {
  const afterClause = after ? `, after: "${after}"` : '';
  let result;
  if (collectionId) {
    result = await graphqlRequest(`{
      collection(id: "gid://shopify/Collection/${collectionId}") {
        products(first: ${limit}${afterClause}) {
          pageInfo { hasNextPage endCursor }
          edges { node { ${IMAGE_PRODUCT_FIELDS} } }
        }
      }
    }`);
    return {
      products: (result?.data?.collection?.products?.edges || []).map(e => mapImageProduct(e.node)),
      pageInfo: result?.data?.collection?.products?.pageInfo,
    };
  }
  const q = queryStr ? `, query: ${JSON.stringify(queryStr)}` : '';
  result = await graphqlRequest(`{
    products(first: ${limit}${q}${afterClause}) {
      pageInfo { hasNextPage endCursor }
      edges { node { ${IMAGE_PRODUCT_FIELDS} } }
    }
  }`);
  return {
    products: (result?.data?.products?.edges || []).map(e => mapImageProduct(e.node)),
    pageInfo: result?.data?.products?.pageInfo,
  };
}

async function updateImageAlt(productId, imageId, altText) {
  const result = await restRequest('PUT', `products/${productId}/images/${imageId}.json`, {
    image: { id: Number(imageId), alt: altText },
  });
  if (!result.image) throw new Error('Error actualizando imagen');
  return true;
}

// ── URL MANAGEMENT ────────────────────────────────────────────────────────────

async function updateProductHandle(productGid, handle) {
  const result = await graphqlRequest(`
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id handle }
        userErrors { field message }
      }
    }
  `, { input: { id: productGid, handle } });
  const errors = result?.data?.productUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join(', '));
  return result.data.productUpdate.product.handle;
}

async function updateCollectionHandle(collectionGid, handle) {
  const result = await graphqlRequest(`
    mutation collectionUpdate($input: CollectionInput!) {
      collectionUpdate(input: $input) {
        collection { id handle }
        userErrors { field message }
      }
    }
  `, { input: { id: collectionGid, handle } });
  const errors = result?.data?.collectionUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join(', '));
  return result.data.collectionUpdate.collection.handle;
}

async function createRedirect(path, target) {
  const result = await graphqlRequest(`
    mutation urlRedirectCreate($urlRedirect: UrlRedirectInput!) {
      urlRedirectCreate(urlRedirect: $urlRedirect) {
        urlRedirect { id path target }
        userErrors { field message }
      }
    }
  `, { urlRedirect: { path, target } });
  const errors = result?.data?.urlRedirectCreate?.userErrors || [];
  if (errors.length) console.warn('Redirect warn:', errors.map(e => e.message).join(', '));
  return true;
}

function detectMimeType(url) {
  const ext = (url.split('?')[0].toLowerCase().split('.').pop() || '');
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/jpeg';
}

function fetchImageBytes(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchImageBytes(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function uploadToStaged(targetUrl, parameters, imageData, mimeType, filename) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
    const parts = [];
    // Add all parameters from Shopify as form fields (must come before the file)
    for (const p of parameters) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`
      ));
    }
    // Add the file field last
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    ));
    parts.push(imageData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const parsed = new URL(targetUrl);
    console.log(`[upload] POST ${parsed.hostname} params=${parameters.map(p=>p.name).join(',')} size=${body.length} file=${filename} mime=${mimeType}`);
    const req = https.request({
      hostname: parsed.hostname, port: parsed.port || 443,
      path: parsed.pathname + parsed.search, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const resp = Buffer.concat(chunks).toString();
        console.log(`[upload] response ${res.statusCode}: ${resp.slice(0, 500)}`);
        if (res.statusCode < 300 || res.statusCode === 303 || res.statusCode === 201) resolve(resp);
        else reject(new Error(`Upload HTTP ${res.statusCode}: ${resp.slice(0, 500)}`));
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function getProductMediaGidByUrl(productGid, imageUrl) {
  const cleanUrl = imageUrl.split('?')[0];
  const result = await graphqlRequest(`{
    product(id: ${JSON.stringify(productGid)}) {
      media(first: 50) { edges { node { id ... on MediaImage { image { url } } } } }
    }
  }`);
  const edge = (result?.data?.product?.media?.edges || []).find(e => {
    const u = e.node?.image?.url;
    return u && u.split('?')[0] === cleanUrl;
  });
  return edge?.node?.id || null;
}

async function renameAndUpdateImage(productGid, imageUrl, newFilename, altText) {
  const mimeType = detectMimeType(imageUrl);
  const mediaGid = await getProductMediaGidByUrl(productGid, imageUrl);
  if (!mediaGid) throw new Error('No se encontró el media de la imagen en el producto');
  const imageData = await fetchImageBytes(imageUrl);
  const staged = await graphqlRequest(`
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }
  `, { input: [{ filename: newFilename, mimeType, resource: 'IMAGE', fileSize: String(imageData.length) }] });
  const errs = staged?.data?.stagedUploadsCreate?.userErrors || [];
  if (errs.length) throw new Error('Staged upload: ' + errs.map(e => e.message).join(', '));
  const target = staged?.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error('No se obtuvo staged target');
  console.log(`[staged] url=${target.url} resourceUrl=${target.resourceUrl} params=${JSON.stringify(target.parameters)}`);
  await uploadToStaged(target.url, target.parameters, imageData, mimeType, newFilename);
  const createResult = await graphqlRequest(`
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id status }
        mediaUserErrors { field message }
      }
    }
  `, { productId: productGid, media: [{ originalSource: target.resourceUrl, mediaContentType: 'IMAGE', alt: altText || '' }] });
  const mediaErrs = createResult?.data?.productCreateMedia?.mediaUserErrors || [];
  if (mediaErrs.length) throw new Error('Create media: ' + mediaErrs.map(e => e.message).join(', '));
  const newMedia = createResult?.data?.productCreateMedia?.media?.[0];
  if (!newMedia) throw new Error('No se creó el media');
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const check = await graphqlRequest(`{ product(id: ${JSON.stringify(productGid)}) { media(first: 50) { edges { node { id status } } } } }`);
    const m = (check?.data?.product?.media?.edges || []).find(e => e.node.id === newMedia.id);
    if (m?.node?.status === 'READY') break;
    if (m?.node?.status === 'FAILED') throw new Error('La imagen falló al procesarse en Shopify');
  }
  await graphqlRequest(`
    mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds userErrors { field message }
      }
    }
  `, { productId: productGid, mediaIds: [mediaGid] }).catch(e => console.warn('Delete media warn:', e.message));
  return { mediaId: newMedia.id };
}

async function getImagesWithoutAlt(daysAgo = 90) {
  const since = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const images = [];
  let cursor = null;
  do {
    const result = await getProductsWithImages(null, `created_at:>=${since}`, 50, cursor);
    for (const product of result.products) {
      for (const img of product.images) {
        if (!img.currentAlt) {
          images.push({ ...img, productId: product.id, productGid: product.gid, productTitle: product.title, vendor: product.vendor, productType: product.productType });
        }
      }
    }
    cursor = result.pageInfo?.hasNextPage ? result.pageInfo.endCursor : null;
  } while (cursor);
  return images;
}

async function getProductsWithoutSEO(daysAgo = 90) {
  const since = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let all = [];
  let cursor = null;
  do {
    const result = await getProductsByQuery(`created_at:>=${since}`, 250, cursor);
    result.products.filter(p => !p.currentMetaTitle).forEach(p => all.push(p));
    cursor = result.pageInfo?.hasNextPage ? result.pageInfo.endCursor : null;
  } while (cursor);
  return all.sort((a, b) => b.id.localeCompare(a.id));
}

async function getCollectionsWithoutSEO(daysAgo = 90) {
  const since = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await graphqlRequest(`{
    collections(first: 250, query: "created_at:>=${since}") {
      edges {
        node {
          id handle title descriptionHtml
          seo { title description }
        }
      }
    }
  }`);
  return (result?.data?.collections?.edges || [])
    .map(e => ({
      id: e.node.id.replace('gid://shopify/Collection/', ''),
      gid: e.node.id,
      handle: e.node.handle || '',
      title: e.node.title,
      description: (e.node.descriptionHtml || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 400),
      currentMetaTitle: e.node.seo?.title || '',
      currentMetaDescription: e.node.seo?.description || '',
    }))
    .filter(c => !c.currentMetaTitle);
}

async function getArticlesWithoutSEO(daysAgo = 90) {
  const since = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await graphqlRequest(`{
    articles(first: 250, query: "created_at:>=${since}") {
      edges {
        node {
          id handle title
          blog { title }
          seo { title description }
        }
      }
    }
  }`);
  return (result?.data?.articles?.edges || [])
    .map(e => ({
      id: e.node.id.replace('gid://shopify/Article/', ''),
      gid: e.node.id,
      handle: e.node.handle || '',
      title: e.node.title,
      blogTitle: e.node.blog?.title || '',
      currentMetaTitle: e.node.seo?.title || '',
      currentMetaDescription: e.node.seo?.description || '',
    }))
    .filter(a => !a.currentMetaTitle);
}

module.exports = {
  graphqlRequest,
  getProductsByCollection, getProductsByQuery, updateProductSEO,
  getCollections, getCollectionsWithSEO, updateCollectionSEO,
  getMetaobjectTypes, getMetaobjectsByType, updateMetaobjectSEO,
  getBlogArticles, updateArticleSEO,
  getProductsWithImages, updateImageAlt,
  updateProductHandle, updateCollectionHandle, createRedirect,
  getProductsWithoutSEO,
  getCollectionsWithoutSEO,
  getArticlesWithoutSEO,
  getImagesWithoutAlt,
  renameAndUpdateImage,
};
