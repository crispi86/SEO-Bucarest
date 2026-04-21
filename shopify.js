const https = require('https');

function graphqlRequest(query, variables = {}) {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const bodyStr = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const options = {
      hostname: process.env.SHOPIFY_SHOP,
      path: '/admin/api/2024-01/graphql.json',
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

const PRODUCT_FIELDS = `
  id title descriptionHtml tags vendor productType status
  variants(first: 1) { edges { node { sku price } } }
  seoTitle: metafield(namespace: "global", key: "title_tag") { value }
  seoDescription: metafield(namespace: "global", key: "description_tag") { value }
`;

function mapProduct(node) {
  return {
    id: node.id.replace('gid://shopify/Product/', ''),
    gid: node.id,
    title: node.title,
    description: (node.descriptionHtml || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 600),
    tags: node.tags || [],
    vendor: node.vendor || '',
    productType: node.productType || '',
    status: (node.status || 'draft').toLowerCase(),
    sku: node.variants?.edges?.[0]?.node?.sku || '',
    currentMetaTitle: node.seoTitle?.value || '',
    currentMetaDescription: node.seoDescription?.value || '',
  };
}

async function getProductsByCollection(collectionId, limit = 50, after = null) {
  const afterClause = after ? `, after: "${after}"` : '';
  const query = `{
    collection(id: "gid://shopify/Collection/${collectionId}") {
      products(first: ${limit}${afterClause}) {
        pageInfo { hasNextPage endCursor }
        edges { node { ${PRODUCT_FIELDS} } }
      }
    }
  }`;
  const result = await graphqlRequest(query);
  const products = (result?.data?.collection?.products?.edges || []).map(e => mapProduct(e.node));
  return { products, pageInfo: result?.data?.collection?.products?.pageInfo };
}

async function getProductsByQuery(queryStr, limit = 50, after = null) {
  const afterClause = after ? `, after: "${after}"` : '';
  const query = `{
    products(first: ${limit}, query: ${JSON.stringify(queryStr)}${afterClause}) {
      pageInfo { hasNextPage endCursor }
      edges { node { ${PRODUCT_FIELDS} } }
    }
  }`;
  const result = await graphqlRequest(query);
  const products = (result?.data?.products?.edges || []).map(e => mapProduct(e.node));
  return { products, pageInfo: result?.data?.products?.pageInfo };
}

async function getCollections() {
  const query = `{
    collections(first: 250) {
      edges { node { id title } }
    }
  }`;
  const result = await graphqlRequest(query);
  return (result?.data?.collections?.edges || [])
    .map(e => ({ id: e.node.id.replace('gid://shopify/Collection/', ''), title: e.node.title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

async function updateProductSEO(productGid, metaTitle, metaDescription) {
  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    metafields: [
      { ownerId: productGid, namespace: 'global', key: 'title_tag', value: metaTitle, type: 'single_line_text_field' },
      { ownerId: productGid, namespace: 'global', key: 'description_tag', value: metaDescription, type: 'single_line_text_field' },
    ],
  };
  const result = await graphqlRequest(mutation, variables);
  const errors = result?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join(', '));
  return true;
}

module.exports = { getProductsByCollection, getProductsByQuery, getCollections, updateProductSEO };
