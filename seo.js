const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const STORE_CONTEXT = `TIENDA: Bucarest Art & Antiques, Santiago de Chile.
Antigüedades de lujo: muebles franceses, pinturas chilenas, alfombras persas, platería, cristalería, objetos de época.
El vendedor habla técnico; el comprador busca en lenguaje cotidiano.
Ejemplo: "Secretaire Luis XVI con marquetería siglo XIX" → comprador busca "escritorio antiguo de madera con tapa".`;

const SEO_RULES = `REGLAS ESTRICTAS:
• Metatítulo: MÁXIMO 60 caracteres. Keyword cotidiana que usaría el comprador en Google.
• Metadescripción: MÁXIMO 160 caracteres. Termina con "Envíos a todo Chile."
• Nunca uses lenguaje técnico, francés ni inglés.
• Incluye "Santiago" o "Providencia" solo si cabe naturalmente.
• Tono: lujoso y exclusivo, nunca genérico.
• Idioma: español.`;

async function callClaude(prompt) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Respuesta inválida de Claude');
  return JSON.parse(match[0]);
}

function extraBlock(extraRules) {
  return extraRules ? `\nINSTRUCCIONES ADICIONALES (prioridad alta):\n${extraRules}` : '';
}

async function generateSEO(product, extraRules = '') {
  const tags = Array.isArray(product.tags) ? product.tags.join(', ') : (product.tags || '');
  const json = await callClaude(`${STORE_CONTEXT}

PRODUCTO:
- Título: ${product.title}
- Descripción: ${product.description || '(sin descripción)'}
- Tipo: ${product.productType || '(sin tipo)'}
- Proveedor: ${product.vendor || '(sin datos)'}
- Tags: ${tags || '(sin tags)'}

${SEO_RULES}${extraBlock(extraRules)}

Responde SOLO con JSON: {"metaTitle":"...","metaDescription":"..."}`);

  return {
    productId: product.id, productGid: product.gid, productTitle: product.title,
    currentMetaTitle: product.currentMetaTitle, currentMetaDescription: product.currentMetaDescription,
    metaTitle: (json.metaTitle || '').substring(0, 60),
    metaDescription: (json.metaDescription || '').substring(0, 160),
  };
}

async function generateCollectionSEO(collection, extraRules = '') {
  const json = await callClaude(`${STORE_CONTEXT}

COLECCIÓN:
- Nombre: ${collection.title}
- Descripción: ${collection.description || '(sin descripción)'}

Genera SEO para la página de esta colección de antigüedades. El comprador busca categorías generales.

${SEO_RULES}${extraBlock(extraRules)}

Responde SOLO con JSON: {"metaTitle":"...","metaDescription":"..."}`);

  return {
    collectionId: collection.id, collectionGid: collection.gid, collectionTitle: collection.title,
    currentMetaTitle: collection.currentMetaTitle, currentMetaDescription: collection.currentMetaDescription,
    metaTitle: (json.metaTitle || '').substring(0, 60),
    metaDescription: (json.metaDescription || '').substring(0, 160),
  };
}

async function generateMetaobjectSEO(metaobject, extraRules = '') {
  const fieldsSummary = (metaobject.fields || []).slice(0, 6)
    .filter(f => f.value)
    .map(f => `${f.key}: ${String(f.value).substring(0, 100)}`)
    .join('\n');

  const json = await callClaude(`${STORE_CONTEXT}

METAOBJETO:
- Nombre: ${metaobject.displayName}
- Campos: ${fieldsSummary || '(sin campos con valor)'}

Genera SEO descriptivo basado en el nombre y campos del objeto.

${SEO_RULES}${extraBlock(extraRules)}

Responde SOLO con JSON: {"metaTitle":"...","metaDescription":"..."}`);

  return {
    metaobjectId: metaobject.id, metaobjectGid: metaobject.gid, metaobjectTitle: metaobject.displayName,
    currentMetaTitle: metaobject.currentMetaTitle, currentMetaDescription: metaobject.currentMetaDescription,
    metaTitle: (json.metaTitle || '').substring(0, 60),
    metaDescription: (json.metaDescription || '').substring(0, 160),
  };
}

async function generateArticleSEO(article, extraRules = '') {
  const tags = Array.isArray(article.tags) ? article.tags.join(', ') : (article.tags || '');
  const json = await callClaude(`${STORE_CONTEXT}

ARTÍCULO DE BLOG:
- Título: ${article.title}
- Blog: ${article.blogTitle || '(sin blog)'}
- Tags: ${tags || '(sin tags)'}

Genera SEO para este artículo del blog de una tienda de antigüedades de lujo.

${SEO_RULES}${extraBlock(extraRules)}

Responde SOLO con JSON: {"metaTitle":"...","metaDescription":"..."}`);

  return {
    articleId: article.id, articleGid: article.gid, articleTitle: article.title,
    currentMetaTitle: article.currentMetaTitle, currentMetaDescription: article.currentMetaDescription,
    metaTitle: (json.metaTitle || '').substring(0, 60),
    metaDescription: (json.metaDescription || '').substring(0, 160),
  };
}

async function generateAltText(image, extraRules = '') {
  const extra = extraRules ? `\nInstrucciones adicionales: ${extraRules}` : '';
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 120,
    messages: [{
      role: 'user',
      content: `Genera un alt text corto y descriptivo (máx 100 caracteres) para una imagen de este producto de antigüedades.
Producto: ${image.productTitle}
Tipo: ${image.productType || '(sin tipo)'}
Proveedor/Autor: ${image.vendor || '(sin datos)'}
Alt actual: ${image.currentAlt || '(vacío)'}${extra}

Responde SOLO con el texto del alt, sin comillas ni explicaciones. Idioma: español.`,
    }],
  });
  return response.content[0].text.trim().replace(/^["']|["']$/g, '').substring(0, 120);
}

module.exports = { generateSEO, generateCollectionSEO, generateMetaobjectSEO, generateArticleSEO, generateAltText };
