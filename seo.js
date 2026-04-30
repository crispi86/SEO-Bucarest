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

// Quote chars (open / close) — straight, curly, guillemets, acute accent ´
const Q_OPEN  = '\u2018\u201c\u00ab\u00b4\'"`';
const Q_CLOSE = '\u2019\u201d\u00bb\'"`';
const RE_Q_OPEN  = new RegExp('[' + Q_OPEN  + ']');
const RE_QUOTE_STRICT = new RegExp('[' + Q_OPEN + '](.+?)[' + Q_CLOSE + ']+\\s*$', 's');
const RE_QUOTE_OPEN   = new RegExp('[' + Q_OPEN + '](.+)$', 's');

function parsePaintingTitle(title) {
  // Split on first dash (-, –, —) with optional surrounding spaces
  const dashMatch = title.match(/^(.+?)\s*[-–—]\s*(.+)$/s);
  if (!dashMatch) return null;
  const autor = dashMatch[1].trim();
  const rest  = dashMatch[2].trim();

  // Year at end
  const yearMatch = rest.match(/\s(\d{4})\s*$/);
  const año = yearMatch ? yearMatch[1] : null;
  let restNoYear = yearMatch ? rest.slice(0, yearMatch.index).trim() : rest;

  // Strip trailing parenthetical notes like (Copia), (Reproducción)
  restNoYear = restNoYear.replace(/\s*\([^)]*\)\s*$/, '').trim();

  // Theme: try strict match first (closing quote at end), then fallback for missing close quote
  let quoteMatch = RE_QUOTE_STRICT.exec(restNoYear);
  let tematica, restNoTheme;
  if (quoteMatch) {
    tematica    = quoteMatch[1].trim();
    restNoTheme = restNoYear.slice(0, quoteMatch.index).trim();
  } else if (RE_Q_OPEN.test(restNoYear)) {
    // Missing closing quote — take everything after the opening quote
    const openMatch = RE_QUOTE_OPEN.exec(restNoYear);
    tematica    = openMatch[1].trim();
    restNoTheme = restNoYear.slice(0, openMatch.index).trim();
  } else {
    // No quotes found — partial parse: keep what we have, mark as unquoted
    return { autor, raw: restNoYear, año, partial: true };
  }

  // Technique + optional support (after "sobre")
  const sobreIdx = restNoTheme.toLowerCase().indexOf(' sobre ');
  let tecnica, soporte;
  if (sobreIdx !== -1) {
    tecnica = restNoTheme.slice(0, sobreIdx).trim();
    soporte = restNoTheme.slice(sobreIdx + 7).trim();
  } else {
    tecnica = restNoTheme;
    soporte = null;
  }
  if (!autor || !tematica) return null;
  return { autor, tecnica, soporte, tematica, año };
}

async function generatePaintingSEO(product, extraRules = '') {
  const parsed = parsePaintingTitle(product.title);
  // No dash = not a painting format → fall back to regular product SEO
  if (!parsed) return generateSEO(product, extraRules);

  let json;

  if (parsed.partial) {
    // Title has no quotes — pass raw description to Claude, let it interpret
    json = await callClaude(`${STORE_CONTEXT}

PINTURA (título sin formato estándar):
- Autor: ${parsed.autor}
- Descripción del título: ${parsed.raw}${parsed.año ? ' (' + parsed.año + ')' : ''}

El título no usa el formato estándar. Interpreta la descripción para generar el mejor SEO posible.
INSTRUCCIONES:
Metatítulo (máx 60 caracteres): formato FIJO → "[Autor] - [descripción breve de la obra]". Autor siempre primero.
Metadescripción (máx 160 caracteres): texto natural con autor, técnica/temática inferida de la descripción. Incluye "pintura chilena" u "obra de arte chilena" si corresponde. Incluye "Santiago" o "Providencia" si cabe.
No inventes datos que no estén en la descripción del título.

${SEO_RULES}${extraBlock(extraRules)}

Responde SOLO con JSON: {"metaTitle":"...","metaDescription":"..."}`);
  } else {
    const { autor, tecnica, soporte, tematica, año } = parsed;
    json = await callClaude(`${STORE_CONTEXT}

PINTURA:
- Autor: ${autor}
- Técnica: ${tecnica}
- Soporte: ${soporte || '(no especificado, no inventar)'}
- Temática: ${tematica}
- Año: ${año || '(no especificado, no inventar)'}

INSTRUCCIONES ESPECÍFICAS PARA PINTURAS:
Metatítulo (máx 60 caracteres): formato FIJO, sin excepciones → "[Autor] - [Temática] - [Técnica]"
El autor siempre va primero. Nunca cambies el orden. Si no cabe todo, acorta la temática o la técnica, nunca el autor.
Metadescripción (máx 160 caracteres): texto natural que incluya técnica${soporte ? ', soporte' : ''}${año ? ', año' : ''}, autor y temática.
Suma términos de búsqueda: "pintura chilena" o "obra de arte chilena" según corresponda.
Incluye "Santiago" o "Providencia" si cabe naturalmente.
Si no hay soporte o año, NO los inventes ni los menciones.

${SEO_RULES}${extraBlock(extraRules)}

Responde SOLO con JSON: {"metaTitle":"...","metaDescription":"..."}`);
  }

  return {
    productId: product.id, productGid: product.gid, productTitle: product.title,
    currentMetaTitle: product.currentMetaTitle, currentMetaDescription: product.currentMetaDescription,
    metaTitle: (json.metaTitle || '').substring(0, 60),
    metaDescription: (json.metaDescription || '').substring(0, 160),
  };
}

async function generateFurnitureSEO(product, detectedStyle, extraRules = '') {
  const styleRule = detectedStyle
    ? `ESTILO OBLIGATORIO: "${detectedStyle}" — esta palabra EXACTA debe aparecer al final del metatítulo. No la cambies, no la omitas.`
    : 'No se detectó estilo — no inventes ninguno.';

  const tags = Array.isArray(product.tags) ? product.tags.join(', ') : (product.tags || '');

  const json = await callClaude(`${STORE_CONTEXT}

MUEBLE:
- Título: ${product.title}
- Descripción: ${product.description || '(sin descripción)'}
- Tags: ${tags || '(sin tags)'}

${styleRule}

METATÍTULO — máx 60 caracteres, orden FIJO:
[nombre del mueble] + [antiguo/antigua] + [origen: francesa/inglés/etc.] + [material: de madera/en caoba/etc.] + [estilo si aplica]
Ejemplos: "Cómoda antigua francesa de madera Luis XVI" / "Vitrina antigua inglesa de roble Victoriano"
NUNCA incluir medidas, dimensiones ni números de cm.

METADESCRIPCIÓN — máx 160 caracteres:
Texto natural y elegante. Menciona origen, estilo, material y antigüedad. Las medidas pueden ir aquí si aportan valor.

${SEO_RULES}${extraBlock(extraRules)}

Responde SOLO con JSON: {"metaTitle":"...","metaDescription":"..."}`);

  return {
    productId: product.id, productGid: product.gid, productTitle: product.title,
    currentMetaTitle: product.currentMetaTitle, currentMetaDescription: product.currentMetaDescription,
    metaTitle: (json.metaTitle || '').substring(0, 60),
    metaDescription: (json.metaDescription || '').substring(0, 160),
  };
}

module.exports = { generateSEO, generateCollectionSEO, generateMetaobjectSEO, generateArticleSEO, generateAltText, generatePaintingSEO, generateFurnitureSEO };
