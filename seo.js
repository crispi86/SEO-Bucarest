const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateSEO(product) {
  const tags = Array.isArray(product.tags) ? product.tags.join(', ') : (product.tags || '');

  const prompt = `Eres experto en SEO para antigüedades de lujo en Chile.

TIENDA: Bucarest Art & Antiques, Santiago de Chile
CONTEXTO: El vendedor habla técnico, el comprador busca en lenguaje cotidiano.
Ejemplo: vendedor → "Secretaire Luis XVI con marquetería siglo XIX"; comprador busca → "escritorio antiguo de madera con tapa".

PRODUCTO:
- Título: ${product.title}
- Descripción: ${product.description || '(sin descripción)'}
- Tipo: ${product.productType || '(sin tipo)'}
- Proveedor/Origen: ${product.vendor || '(sin datos)'}
- Tags: ${tags || '(sin tags)'}

GENERA metatítulo y metadescripción para Google en español.

REGLAS ESTRICTAS:
• Metatítulo: MÁXIMO 60 caracteres. Usa keyword cotidiana que usaría el comprador en Google.
• Metadescripción: MÁXIMO 160 caracteres. Termina con "Envíos a todo Chile."
• Nunca uses lenguaje técnico, francés ni inglés.
• Incluye "Santiago" o "Providencia" solo si cabe naturalmente.
• Tono: lujoso y exclusivo, nunca genérico.
• Idioma: español.

Responde SOLO con JSON válido, sin texto adicional:
{"metaTitle":"...","metaDescription":"..."}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Respuesta inválida de Claude');
  const json = JSON.parse(match[0]);

  return {
    productId: product.id,
    productGid: product.gid,
    productTitle: product.title,
    currentMetaTitle: product.currentMetaTitle,
    currentMetaDescription: product.currentMetaDescription,
    metaTitle: (json.metaTitle || '').substring(0, 60),
    metaDescription: (json.metaDescription || '').substring(0, 160),
  };
}

module.exports = { generateSEO };
