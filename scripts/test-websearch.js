if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

(async () => {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      messages: [{ role: 'user', content: 'Busca en Google: "cómoda antigua francesa precio Chile"' }],
    });
    const used = response.content.some(b => b.type === 'tool_use' && b.name === 'web_search');
    console.log(used ? '✓ Web search disponible' : '✗ Web search no se activó');
    console.log('stop_reason:', response.stop_reason);
  } catch (e) {
    console.error('✗ Error:', e.message);
  }
})();
