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
          if (parsed.errors?.length) {
            const msg = parsed.errors.map(e => e.message).join('; ');
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

module.exports = {
  getProductsByCollection, getProductsByQuery, updateProductSEO,
  getCollections, getCollectionsWithSEO, updateCollectionSEO,
  getMetaobjectTypes, getMetaobjectsByType, updateMetaobjectSEO,
  getBlogArticles, updateArticleSEO,
  getProductsWithImages, updateImageAlt,
};
