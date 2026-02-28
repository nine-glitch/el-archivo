// api/proxy.js — Vercel Edge Function
// Protege la API key de Anthropic y agrega rate limiting por IP

export const config = { runtime: 'edge' };

// Rate limit: máximo de requests por IP por ventana de tiempo
const RATE_LIMIT = 20;        // requests
const WINDOW_MS = 60 * 60 * 1000; // 1 hora

// In-memory store (se resetea por instancia — suficiente para limitar abuso masivo)
const rateLimitStore = new Map();

function getRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  if (entry.count >= RATE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count };
}

export default async function handler(req) {
  // Solo POST
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // CORS — solo permitir tu dominio
  const origin = req.headers.get('origin') || '';
  const allowedOrigins = [
    'https://contaleacarlitos.vercel.app',
    'https://heycarlitos.app',
    'http://localhost:3000', // para desarrollo local
  ];

  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Rate limiting por IP
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const { allowed, remaining } = getRateLimit(ip);

  if (!allowed) {
    return new Response(
      JSON.stringify({ error: 'Demasiadas requests. Esperá un rato antes de seguir.' }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Leer body
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Body inválido' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Validar que el modelo sea el correcto — no permitir que el cliente use modelos más caros
  const allowedModels = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
  if (!allowedModels.includes(body.model)) {
    body.model = 'claude-sonnet-4-6';
  }

  // Limitar max_tokens para evitar respuestas enormes
  if (!body.max_tokens || body.max_tokens > 1500) {
    body.max_tokens = 1000;
  }

  // Llamar a Anthropic con la key del servidor
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'API key no configurada' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-RateLimit-Remaining': String(remaining),
      },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Error conectando con Anthropic' }),
      { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
