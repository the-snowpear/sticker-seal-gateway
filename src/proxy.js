// One HTTP listener per upstream. Transparent in, transparent out — the only
// change is the system slot of an injectable JSON body.
//
// Streaming matters: sub2api serves SSE straight from these upstreams, so the
// response is forwarded chunk by chunk with no buffering. Requests that cannot
// be injected (GET, non-JSON, unknown path, oversized, content-encoded) are
// piped through without ever materialising the body in memory.

import http from 'node:http';
import https from 'node:https';

import { inject, detectShape, estimateTokens } from './inject.js';
import { stats } from './stats.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const CONNECT_TIMEOUT_MS = 10_000;
const RESPONSE_TIMEOUT_MS = 600_000;
const TEST_BODY_LIMIT = 256 * 1024;

function forwardableHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'host') continue;
    if (lower === 'content-length') continue;
    out[key] = value;
  }
  return out;
}

function responseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function collect(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > cap) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ buf: overflow ? null : Buffer.concat(chunks), size, overflow }));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function oneOf(fn) {
  let done = false;
  return (...args) => {
    if (done) return;
    done = true;
    fn(...args);
  };
}

/** Decide up-front whether this request is even a candidate for injection. */
export function plan(req, stickers) {
  if (!stickers.prefix || !stickers.suffix) return { buffer: false, reason: 'stickers-empty' };
  if (req.method !== 'POST') return { buffer: false, reason: 'method' };

  const shape = detectShape(req.url);
  if (!shape) return { buffer: false, reason: 'path-not-injected' };

  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!type.includes('json')) return { buffer: false, reason: 'not-json' };

  const encoding = String(req.headers['content-encoding'] ?? 'identity').toLowerCase();
  if (encoding !== 'identity') return { buffer: false, reason: 'content-encoded' };

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > stickers.max_body_bytes) {
    return { buffer: false, reason: 'oversize' };
  }
  return { buffer: true, shape };
}

/**
 * Create the request handler for one upstream.
 * @param {{id: string, target: string, model_allow: string[], stickers: () => object}} upstream
 */
export function createHandler(upstream) {
  const isHttps = upstream.target.startsWith('https:');
  const transport = isHttps ? https : http;
  const agent = new (isHttps ? https : http).Agent({ keepAlive: true, maxSockets: 256 });

  return async function handle(req, res) {
    const stickers = upstream.stickers();
    const planned = plan(req, stickers);
    const url = new URL(req.url, upstream.target);
    const began = Date.now();

    const event = {
      method: req.method,
      path: req.url,
      model: null,
      shape: planned.shape ?? null,
      injected: false,
      reason: planned.reason ?? 'injected',
      inBytes: 0,
      outBytes: 0,
      upStatus: 0,
      ms: 0,
      error: null,
    };

    const record = oneOf(() => {
      event.ms = Date.now() - began;
      try {
        stats().record(upstream.id, event);
      } catch (error) {
        console.error(`[proxy:${upstream.id}] stats error: ${error.message}`);
      }
    });

    const proxyReq = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: forwardableHeaders(req.headers),
        agent,
      },
      (proxyRes) => {
        proxyRes.setTimeout(RESPONSE_TIMEOUT_MS);
        event.upStatus = proxyRes.statusCode ?? 0;
        if (!res.headersSent) {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, responseHeaders(proxyRes.headers));
          res.flushHeaders?.();
        }

        let bytes = 0;
        proxyRes.on('data', (chunk) => {
          bytes += chunk.length;
        });
        proxyRes.on('end', () => {
          event.outBytes = bytes;
          record();
        });
        proxyRes.on('aborted', () => {
          event.outBytes = bytes;
          event.error = 'upstream response aborted';
          record();
        });
        proxyRes.on('error', (error) => {
          event.outBytes = bytes;
          event.error = error.message;
          record();
          res.destroy(error);
        });
        proxyRes.pipe(res);
      },
    );

    proxyReq.setTimeout(CONNECT_TIMEOUT_MS, () => {
      proxyReq.destroy(new Error('upstream connect timeout'));
    });

    proxyReq.on('error', (error) => {
      event.error = error.message;
      record();
      if (!res.headersSent) {
        sendJson(res, 502, {
          error: {
            message: `sticker-seal: upstream ${upstream.id} unreachable (${error.message})`,
            type: 'upstream_unreachable',
            code: 'sticker_seal_upstream_unreachable',
          },
        });
      } else {
        res.destroy(error);
      }
    });

    res.on('close', record);

    if (!planned.buffer) {
      event.inBytes = Number(req.headers['content-length']) || 0;
      req.pipe(proxyReq);
      return;
    }

    let collected;
    try {
      collected = await collect(req, stickers.max_body_bytes);
    } catch (error) {
      proxyReq.destroy();
      event.error = error.message;
      event.reason = 'body-read-failed';
      record();
      if (!res.headersSent) {
        sendJson(res, 400, {
          error: { message: 'sticker-seal: request body read failed', type: 'bad_request' },
        });
      }
      return;
    }

    if (collected.overflow) {
      proxyReq.destroy();
      event.reason = 'oversize-stream';
      event.error = 'body exceeded max_body_bytes while streaming';
      record();
      if (!res.headersSent) {
        sendJson(res, 413, {
          error: {
            message: `sticker-seal: request body exceeds ${stickers.max_body_bytes} bytes; send a Content-Length header or a smaller body`,
            type: 'payload_too_large',
          },
        });
      }
      return;
    }

    const result = inject(collected.buf, {
      path: req.url,
      contentType: req.headers['content-type'],
      prefix: stickers.prefix,
      suffix: stickers.suffix,
      dedupe: stickers.dedupe,
      maxBytes: stickers.max_body_bytes,
      modelAllow: upstream.model_allow,
    });

    event.injected = result.injected;
    event.reason = result.reason;
    event.model = result.model;
    event.shape = result.shape ?? event.shape;
    event.inBytes = collected.size;
    event.inputSha = result.inputSha;
    event.outputSha = result.outputSha;
    if (result.injected) {
      event.injectedChars = stickers.prefix.length + stickers.suffix.length;
      event.extraTokens = estimateTokens(stickers.prefix) + estimateTokens(stickers.suffix);
    }

    proxyReq.setHeader('content-length', String(result.body.length));
    proxyReq.end(result.body);
  };
}

/**
 * Send one body straight at an upstream and collect the answer (bounded).
 * The GUI calls /preview first; this path never injects.
 */
export function relayRaw(upstream, { method = 'POST', path, headers = {}, body, timeout = RESPONSE_TIMEOUT_MS } = {}) {
  const url = new URL(path || '/v1/chat/completions', upstream.target);
  const transport = url.protocol === 'https:' ? https : http;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
  const began = Date.now();

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        method,
        path: `${url.pathname}${url.search}`,
        headers: { 'content-type': 'application/json', ...headers, 'content-length': String(payload.length) },
        timeout,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let truncated = false;
        res.on('data', (chunk) => {
          if (size >= TEST_BODY_LIMIT) {
            truncated = true;
            return;
          }
          const room = TEST_BODY_LIMIT - size;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, room));
            size += room;
            truncated = true;
          } else {
            chunks.push(chunk);
            size += chunk.length;
          }
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
            ms: Date.now() - began,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('test request timeout')));
    req.end(payload);
  });
}
