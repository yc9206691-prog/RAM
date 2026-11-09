/**
 * IRIS ATLAS — Vercel AI endpoint: Gemini proxy
 * ============================================================================
 * This function is called ONLY by the Cloudflare Worker (backend.js), never by
 * a browser. The Gemini API key lives here and never leaves the server.
 *
 * Contract with the Worker (see callVercelGemini in backend.js):
 *   GET|POST  {AI_URL}?path=<gemini path>[&alt=..&pageSize=..&pageToken=..]
 *   headers   x-iris-proxy-secret: <GEMINI_PROXY_SECRET>
 *             x-iris-user: <supabase user id | 'neo'>
 *   health    GET {AI_URL}?health=1  ->  { ok, configured, model }
 *
 * Environment variables required on Vercel:
 *   GEMINI_API_KEY        - the Gemini key (server only, never sent to a client)
 *   GEMINI_PROXY_SECRET   - shared secret; must be identical to the Worker value
 * Optional:
 *   GEMINI_MODEL_DEFAULT  - used only for the health answer / model listing hint
 *   GEMINI_MAX_RPS        - soft per-instance request cap (default 30 per 10s)
 *
 * Safety rules implemented here:
 *   - constant-time shared-secret check, fails closed when unset
 *   - strict allow-list of Gemini paths (same regex as the Worker)
 *   - request body cap (4 MB) and upstream timeout
 *   - quota (429) and provider failures mapped to clean JSON, secrets redacted
 *   - no key or secret is ever echoed, logged or included in an error message
 * ============================================================================
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const PATH_RE = /^\/(v1beta|v1)\/models(\/[A-Za-z0-9._-]{1,80}(:(generateContent|streamGenerateContent|countTokens|embedContent|batchEmbedContents))?)?$/;
const PASS_QS = new Set(['alt', 'pageSize', 'pageToken']);
const MAX_BODY = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 110000;

/* ── helpers ─────────────────────────────────────────────────────────────── */
function jsonResponse(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }, extraHeaders || {})
  });
}

function redact(value) {
  return String(value == null ? '' : value)
    .replace(/key=[^&\s"']+/gi, 'key=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [redacted]')
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, '[redacted]')
    .slice(0, 300);
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(String(text));
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Constant-time comparison; a missing/empty secret never matches. */
async function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Very small per-instance rate guard. Vercel instances are ephemeral, so the
 *  real limit lives on the Worker (60/min per user); this is a backstop. */
const hits = new Map();
function allowInstanceRate(userId, limit) {
  const now = Date.now();
  const key = String(userId || 'anon').slice(0, 64);
  const entry = hits.get(key);
  if (!entry || now - entry.start > 10000) {
    hits.set(key, { start: now, n: 1 });
    if (hits.size > 500) hits.clear();
    return true;
  }
  entry.n += 1;
  return entry.n <= limit;
}

/* ── handler ─────────────────────────────────────────────────────────────── */
export default async function handler(request, res) {
  /* Vercel can invoke a Node function with the Web (Request) signature or with
     the classic (req, res) signature. Support both. */
  const isWeb = request && typeof request.headers?.get === 'function';
  if (isWeb) return handleWeb(request);
  return handleClassic(request, res);
}

async function handleWeb(request) {
  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method !== 'GET' && method !== 'POST') {
      return jsonResponse({ error: 'method_not_allowed', message: 'GET or POST only' }, 405, { Allow: 'GET, POST' });
    }

    const expectedSecret = process.env.GEMINI_PROXY_SECRET || '';
    const providedSecret = request.headers.get('x-iris-proxy-secret') || '';
    if (!expectedSecret) {
      return jsonResponse({ error: 'server_not_configured', message: 'GEMINI_PROXY_SECRET is not set on this deployment' }, 503);
    }
    if (!(await secretMatches(providedSecret, expectedSecret))) {
      return jsonResponse({ error: 'unauthorized', message: 'Invalid proxy credentials' }, 401);
    }

    const userId = (request.headers.get('x-iris-user') || 'unknown').slice(0, 64);
    const limit = Math.max(1, Number(process.env.GEMINI_MAX_RPS) || 30);
    if (!allowInstanceRate(userId, limit)) {
      return jsonResponse({ error: 'rate_limited', message: 'Too many requests from this instance, slow down' }, 429, { 'Retry-After': '10' });
    }

    const apiKey = process.env.GEMINI_API_KEY || '';

    /* health probe used by the Worker's cron/health checks */
    if (url.searchParams.get('health') === '1') {
      return jsonResponse({
        ok: true,
        configured: !!apiKey,
        model: process.env.GEMINI_MODEL_DEFAULT || 'gemini-2.5-flash'
      });
    }

    const path = url.searchParams.get('path') || '';
    if (!PATH_RE.test(path)) {
      return jsonResponse({ error: 'not_found', message: 'Unsupported Gemini endpoint' }, 404);
    }
    if (!apiKey) {
      return jsonResponse({ error: 'server_not_configured', message: 'GEMINI_API_KEY is not set on this deployment' }, 503);
    }

    let body;
    if (method === 'POST') {
      const declared = Number(request.headers.get('content-length') || 0);
      if (declared > MAX_BODY) {
        return jsonResponse({ error: 'payload_too_large', message: 'Request too large (limit 4 MB)' }, 413);
      }
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY) {
        return jsonResponse({ error: 'payload_too_large', message: 'Request too large (limit 4 MB)' }, 413);
      }
    }

    const target = new URL(GEMINI_BASE + path);
    for (const [k, v] of url.searchParams) {
      if (PASS_QS.has(k)) target.searchParams.set(k, String(v).slice(0, 200));
    }

    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: method === 'POST' ? body : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return jsonResponse(
        { error: timedOut ? 'ai_timeout' : 'ai_upstream_unreachable', message: timedOut ? 'Gemini did not answer in time' : 'Gemini is unreachable' },
        504
      );
    }

    return relay(upstream);
  } catch (err) {
    console.error('gemini_proxy_failed', redact(err && err.message));
    return jsonResponse({ error: 'internal_error', message: 'Unexpected server error' }, 500);
  }
}

/** Turn a Gemini response into a clean answer for the Worker. */
function relay(upstream) {
  const status = upstream.status;
  const contentType = upstream.headers.get('content-type') || 'application/json';

  if (status === 429) {
    return jsonResponse({ error: 'quota_exceeded', message: 'Gemini quota or rate limit reached. Try again shortly.' }, 429, { 'Retry-After': upstream.headers.get('retry-after') || '30' });
  }
  if (status === 401 || status === 403) {
    return jsonResponse({ error: 'ai_credentials_rejected', message: 'Gemini rejected the API key on this deployment' }, 502);
  }
  if (status >= 500) {
    return jsonResponse({ error: 'ai_provider_error', message: 'Gemini returned HTTP ' + status }, 502);
  }
  if (!upstream.ok) {
    /* 4xx from Gemini: forward the JSON error, but never the URL (it has no key,
       yet keep the habit) and never the headers. */
    return upstream.clone().json()
      .then((j) => jsonResponse({
        error: 'ai_request_rejected',
        message: redact(j && j.error && j.error.message) || 'Gemini rejected the request (HTTP ' + status + ')',
        status
      }, status))
      .catch(() => jsonResponse({ error: 'ai_request_rejected', message: 'Gemini rejected the request (HTTP ' + status + ')' }, status));
  }

  /* success: stream straight through (needed for streamGenerateContent / SSE) */
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  return new Response(upstream.body, { status, headers });
}

/* ── classic (req, res) fallback, buffered ───────────────────────────────── */
async function handleClassic(req, res) {
  const chunks = [];
  let size = 0;
  await new Promise((resolve) => {
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', resolve);
    req.on('error', resolve);
  });
  const body = size > MAX_BODY ? null : Buffer.concat(chunks);
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', 'https://' + host);
  const webRequest = new Request(url.toString(), {
    method: (req.method || 'GET').toUpperCase(),
    headers: new Headers(
      Object.entries(req.headers).reduce((acc, [k, v]) => {
        if (typeof v === 'string') acc[k] = v;
        return acc;
      }, {})
    ),
    body: body && body.length && (req.method || '').toUpperCase() === 'POST' ? body : undefined
  });
  const response = await handleWeb(webRequest);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

export const config = { maxDuration: 120 };
