/* api/chat.js - Secure Vercel Serverless Proxy */

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, model, stream, openaiKey } = req.body;

  // Determine which provider to use based on the presence of a user-provided key
  const useUserKey = Boolean(openaiKey && openaiKey.startsWith('sk-'));

  const provider = useUserKey
    ? {
        name: 'OpenAI',
        url: 'https://api.openai.com/v1/chat/completions',
        key: openaiKey,
        model: model || 'gpt-4o-mini',
      }
    : {
        name: 'Groq',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        key: process.env.GROQ_API_KEY,
        model: model || 'llama-3.3-70b-versatile',
      };

  try {
    const response = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.key}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        stream: stream ?? true,
        temperature: 0.3,
      }),
    });

    // If there's an error, forward it
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`${provider.name} API error:`, response.status, errorText);
      return res.status(response.status).json({
        error: `${provider.name} API error: ${response.status}`,
      });
    }

    // Set headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = response.body?.getReader();
    if (!reader) {
      return res.status(502).json({ error: 'No response stream from provider' });
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }

    res.end();
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
