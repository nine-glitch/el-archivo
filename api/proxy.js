// api/proxy.js — Vercel Edge Function
// Retry automático + fallback Anthropic ↔ OpenRouter

export const config = { runtime: 'edge' };

const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;
const rateLimitStore = new Map();

function getRateLimit(id) {
  const now = Date.now();
  const entry = rateLimitStore.get(id);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    rateLimitStore.set(id, { count: 1, windowStart: now });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  if (entry.count >= RATE_LIMIT) return { allowed: false, remaining: 0 };
  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count };
}

function buildAnthropicRequest(body, key) {
  const b = { ...body };
  const allowedModels = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
  if (!allowedModels.includes(b.model)) b.model = 'claude-sonnet-4-6';
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: b,
  };
}

function buildOpenRouterRequest(body, key) {
  const msgs = (body.messages || []).map(m => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : m.content
  }));
  return {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://contaleacarlitos.vercel.app',
      'X-Title': 'Contale a Carlitos',
    },
    body: {
      model: 'anthropic/claude-sonnet-4-5',
      max_tokens: body.max_tokens,
      messages: msgs,
    },
  };
}

function normalizeResponse(data, isOpenRouter) {
  if (isOpenRouter && data.choices?.[0]?.message?.content) {
    return { content: [{ type: 'text', text: data.choices[0].message.content }] };
  }
  return data;
}

async function callWithRetry(requestFn, maxRetries = 3, delayMs = 800) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { url, headers, body } = requestFn();
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (response.status === 429 || response.status >= 500) {
        lastError = { status: response.status };
        if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const allowedOrigins = [
    'https://contaleacarlitos.vercel.app',
    'https://heycarlitos.app',
    'http://localhost:3000',
  ];
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-user-id',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const userId = req.headers.get('x-user-id') || req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const { allowed, remaining } = getRateLimit(userId);
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: 'rate_limit', message: 'Demasiadas requests. Esperá un rato.' }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Body inválido' }), { status: 400, headers: corsHeaders }); }

  if (!body.max_tokens || body.max_tokens > 1500) body.max_tokens = 1000;

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (!anthropicKey && !openrouterKey) {
    return new Response(
      JSON.stringify({ error: 'no_key', message: 'API key no configurada' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const providers = [];
  if (anthropicKey) providers.push({ name: 'anthropic', fn: () => buildAnthropicRequest(body, anthropicKey) });
  if (openrouterKey) providers.push({ name: 'openrouter', fn: () => buildOpenRouterRequest(body, openrouterKey) });

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      const response = await callWithRetry(provider.fn, 3, 800);
      const data = await response.json();
      const finalData = normalizeResponse(data, provider.name === 'openrouter');
      return new Response(JSON.stringify(finalData), {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-RateLimit-Remaining': String(remaining), 'X-Provider': provider.name },
      });
    } catch (err) {
      if (i === providers.length - 1) {
        return new Response(
          JSON.stringify({ error: 'all_providers_failed', message: 'Carlitos no puede responder ahora. Intentá en un momento.' }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }
  }
}
