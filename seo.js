const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const STORE_CONTEXT = `TIENDA: Bucarest Art & Antiques, Santiago de Chile.
Antigüedades de lujo: muebles franceses, pinturas chilenas, alfombras persas, platería, cristalería, objetos de época.
El vendedor habla técnico; el comprador busca en lenguaje cotidiano.
Ejemplo: "Secretaire Luis XVI con marquetería siglo XIX" → comprador busca "escritorio antiguo de madera con tapa".`;

const SEO_RULES = `REGLAS ESTRICTAS:
• Metatítulo: MÁXIMO 60 caracteres. Úsalos todos o lo más cerca posible. Keyword cotidiana que usaría el comprador en Google.
• Metadescripción: MÁXIMO 160 caracteres. Úsalos todos o lo más cerca posible.
• Nunca uses lenguaje técnico, francés ni inglés.
• Incluye "Santiago" o "Providencia" solo si cabe naturalmente.
• Tono: lujoso y elegante, nunca genérico.
• Idioma: español.
• NUNCA uses "Envíos a todo Chile." ni ninguna variante de esa frase.
• NUNCA uses las palabras exclusivo, única, único, irrepetible, excepcional, singular, inigualable, de colección, coleccionista, coleccionismo, ni sus sinónimos.
• NUNCA menciones "Bucarest Art & Antiques" ni "disponible en Bucarest Art & Antiques".
• NUNCA digas "traído desde Francia" ni variantes; usa simplemente "francés" o "europeo".
• Suma términos funcionales y de tamaño que la gente busca en Google (ej: alfombra mediana, escritorio para el living, silla de comedor antigua, mesa de centro de madera).`;

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

// ── PAINTING PARSER & SEO ─────────────────────────────────────────────────────

function parsePaintingTitle(title) {
  // Split on first dash (-, –, —) with optional surrounding spaces
  const dashMatch = title.match(/^(.+?)\s*[-–—]\s*(.+)$/s);
  if (!dashMatch) return null;
  const autor = dashMatch[1].trim();
  const rest = dashMatch[2].trim();
  // Year at end
  const yearMatch = rest.match(/\s(\d{4})\s*$/);
  const año = yearMatch ? yearMatch[1] : null;
  const restNoYear = yearMatch ? rest.slice(0, yearMatch.index).trim() : rest;
  // Theme in any quote style: straight ' " or curly \u2018\u2019\u201c\u201d or guillemets «»
  const quoteMatch = restNoYear.match(/[\u2018\u201c\u00ab'"]([^\u2019\u201d\u00bb'"]+)[\u2019\u201d\u00bb'"]+\s*$/);
  if (!quoteMatch) return null;
  const tematica = quoteMatch[1].trim();
  const restNoTheme = restNoYear.slice(0, quoteMatch.index).trim();
  // Technique + optional support
  const sobreIdx = restNoTheme.toLowerCase().indexOf(' sobre ');
  let tecnica, soporte;
  if (sobreIdx !== -1) {
    tecnica = restNoTheme.slice(0, sobreIdx).trim();
    soporte = restNoTheme.slice(sobreIdx + 7).trim();
  } else {
    tecnica = restNoTheme;
    soporte = null;
  }
  if (!autor || !tecnica || !tematica) return null;
  return { autor, tecnica, soporte, tematica, año };
}

async function generatePaintingSEO(product, extraRules = '') {
  const parsed = parsePaintingTitle(product.title);
  if (!parsed) {
    throw new Error('Revisión manual requerida: el título no sigue el formato de pintura esperado (Autor - Técnica [sobre Soporte] \'Temática\' [Año]).');
  }
  const { autor, tecnica, soporte, tematica, año } = parsed;

  const json = await callClaude(`${STORE_CONTEXT}

PINTURA:
- Autor: ${autor}
- Técnica: ${tecnica}
- Soporte: ${soporte || '(no especificado, no inventar)'}
- Temática: ${tematica}
- Año: ${año || '(no especificado, no inventar)'}

INSTRUCCIONES ESPECÍFICAS PARA PINTURAS:
Metatítulo (máx 60 caracteres): sigue este formato → "[Temática] - [Autor] - Pintura [Técnica]"
Si el autor es muy conocido en Chile, puede ir primero. Usa lenguaje cotidiano.
Metadescripción (máx 160 caracteres): texto natural que incluya técnica${soporte ? ', soporte' : ''}${año ? ', año' : ''}, autor y temática.
Suma términos de búsqueda: "pintura chilena" o "obra de arte chilena" según corresponda.
Incluye "Santiago" o "Providencia" si cabe naturalmente.
Si no hay soporte o año, NO los inventes ni los menciones.

${SEO_RULES}${extraBlock(extraRules)}

Responde SOLO con JSON: {"metaTitle":"...","metaDescription":"..."}`);

  return {
    productId: product.id, productGid: product.gid, productTitle: product.title,
    currentMetaTitle: product.currentMetaTitle, currentMetaDescription: product.currentMetaDescription,
    metaTitle: (json.metaTitle || '').substring(0, 60),
    metaDescription: (json.metaDescription || '').substring(0, 160),
  };
}

module.exports = { generateSEO, generateCollectionSEO, generateMetaobjectSEO, generateArticleSEO, generateAltText, generatePaintingSEO };
