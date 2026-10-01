// api/chat.js — Vercel serverless proxy
// Routes to OpenAI (if user supplied a key) or Groq (free default).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, openaiKey } = req.body || {};

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing messages array' });
  }

  const useUserKey = openaiKey && typeof openaiKey === 'string' && openaiKey.startsWith('sk-');

  const provider = useUserKey
    ? {
        name: 'OpenAI',
        url: 'https://api.openai.com/v1/chat/completions',
        key: openaiKey,
        model: 'gpt-4o-mini'
      }
    : {
        name: 'Groq',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        key: process.env.GROQ_API_KEY,
        model: 'openai/gpt-oss-120b'
      };

  if (!provider.key) {
    return res.status(500).json({
      error: 'Server is missing GROQ_API_KEY. Contact the site owner.'
    });
  }

  try {
    const upstream = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.key}`
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        stream: true,
        temperature: 0.3
      })
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      console.error(`${provider.name} error ${upstream.status}:`, detail.slice(0, 500));
      return res.status(upstream.status).json({
        error: `${provider.name} API error ${upstream.status}`
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    console.error('Proxy error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Proxy error: ' + err.message });
    } else {
      res.end();
    }
  }
}