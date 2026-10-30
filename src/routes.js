// Admin surface: the JSON API the embedded GUI talks to, plus the static SPA.
//
// Everything lives under /_seal/. Only /_seal/api/health is unauthenticated —
// every other API call needs the operator's own sub2api admin JWT, which the
// panel hands to the iframe as ?token=.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { authenticate } from './auth.js';
import { inject, estimateTokens } from './inject.js';
import { relayRaw } from './proxy.js';
import * as sub2api from './sub2api.js';
import { Sub2APIError } from './sub2api.js';
import { ConfigError } from './config.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const API_BODY_LIMIT = 32 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > API_BODY_LIMIT) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function stickersView(stickers) {
  return {
    ...stickers,
    prefix_chars: [...stickers.prefix].length,
    suffix_chars: [...stickers.suffix].length,
    prefix_bytes: Buffer.byteLength(stickers.prefix, 'utf8'),
    suffix_bytes: Buffer.byteLength(stickers.suffix, 'utf8'),
    extra_tokens: estimateTokens(stickers.prefix) + estimateTokens(stickers.suffix),
  };
}

/**
 * @param {object} ctx
 * @param {() => object} ctx.getConfig
 * @param {(candidate: object) => object} ctx.saveConfig
 * @param {() => object} ctx.runtime          live listener state, keyed by upstream id
 * @param {object} ctx.stats
 * @param {string} ctx.secret                 sub2api JWT secret
 * @param {string} ctx.publicDir
 * @param {string} ctx.publicHost             hostname sub2api uses to reach this gateway
 */
export function createUiHandler(ctx) {
  const startedAt = Date.now();

  function state() {
    const cfg = ctx.getConfig();
    const live = ctx.runtime();
    const counters = ctx.stats.snapshot().counters;
    return {
      gateway: {
        version: pkg.version,
        node: process.version,
        started_at: new Date(startedAt).toISOString(),
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        public_host: ctx.publicHost,
        sub2api_base: cfg.admin.sub2api_base,
      },
      stickers: stickersView(cfg.stickers),
      upstreams: cfg.upstreams.map((u) => ({
        ...u,
        listening: Boolean(live[u.id]?.listening),
        listen_error: live[u.id]?.error ?? null,
        url_for_sub2api: `http://${ctx.publicHost}:${u.listen}`,
        counters: counters[u.id] ?? null,
      })),
      today: ctx.stats.snapshot().day,
    };
  }

  async function handleApi(req, res, url, routePath) {
    const route = `${req.method} ${routePath}`;

    if (route === 'GET /health') {
      return sendJson(res, 200, { ok: true, version: pkg.version });
    }

    const auth = authenticate(req, url, ctx.secret);
    if (!auth.ok) {
      return sendJson(res, 401, {
        error: { message: `unauthorized (${auth.reason})`, type: 'unauthorized' },
      });
    }
    const token = auth.token;

    switch (route) {
      case 'GET /state':
        return sendJson(res, 200, state());

      case 'GET /accounts': {
        const platform = url.searchParams.get('platform') || undefined;
        const type = url.searchParams.get('type') || undefined;
        const search = url.searchParams.get('search') || undefined;
        const items = await sub2api.listAccounts({ token, platform, type, search, pageSize: 100 });
        const slim = items.map((item) => ({
          id: item.id,
          name: item.name,
          platform: item.platform,
          type: item.type,
          status: item.status,
          schedulable: item.schedulable,
          base_url: item.credentials?.base_url ?? item.credentials?.api_base ?? null,
          group_ids: item.group_ids ?? [],
        }));
        return sendJson(res, 200, { items: slim });
      }

      case 'GET /events':
        return sendJson(res, 200, {
          items: ctx.stats.recent(Number(url.searchParams.get('limit')) || 100),
        });

      case 'PUT /stickers': {
        const body = await readJsonBody(req);
        const cfg = ctx.getConfig();
        const candidate = {
          ...cfg,
          stickers: {
            ...cfg.stickers,
            ...(typeof body.prefix === 'string' ? { prefix: body.prefix } : {}),
            ...(typeof body.suffix === 'string' ? { suffix: body.suffix } : {}),
            ...(typeof body.dedupe === 'boolean' ? { dedupe: body.dedupe } : {}),
            ...(Number.isFinite(body.max_body_bytes) ? { max_body_bytes: body.max_body_bytes } : {}),
          },
        };
        const saved = ctx.saveConfig(candidate);
        return sendJson(res, 200, { ok: true, stickers: stickersView(saved.stickers) });
      }

      case 'PUT /upstreams': {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.upstreams)) {
          return sendJson(res, 400, { error: { message: 'upstreams must be an array', type: 'bad_request' } });
        }
        const cfg = ctx.getConfig();
        const saved = ctx.saveConfig({ ...cfg, upstreams: body.upstreams });
        return sendJson(res, 200, { ok: true, upstreams: saved.upstreams });
      }

      case 'POST /preview': {
        const body = await readJsonBody(req);
        const cfg = ctx.getConfig();
        const upstream = cfg.upstreams.find((u) => u.id === body.upstream_id);
        if (!upstream) return sendJson(res, 404, { error: { message: 'unknown upstream', type: 'not_found' } });

        const raw = typeof body.body === 'string' ? body.body : JSON.stringify(body.body ?? {}, null, 2);
        const buf = Buffer.from(raw, 'utf8');
        const result = inject(buf, {
          path: body.path || '/v1/chat/completions',
          contentType: 'application/json',
          prefix: cfg.stickers.prefix,
          suffix: cfg.stickers.suffix,
          dedupe: cfg.stickers.dedupe,
          maxBytes: cfg.stickers.max_body_bytes,
          modelAllow: upstream.model_allow,
        });
        return sendJson(res, 200, {
          injected: result.injected,
          reason: result.reason,
          shape: result.shape,
          model: result.model,
          input_sha256: result.inputSha,
          output_sha256: result.outputSha,
          original: raw,
          transformed: result.body.toString('utf8'),
        });
      }

      case 'POST /test': {
        const body = await readJsonBody(req);
        const cfg = ctx.getConfig();
        const upstream = cfg.upstreams.find((u) => u.id === body.upstream_id);
        if (!upstream) return sendJson(res, 404, { error: { message: 'unknown upstream', type: 'not_found' } });
        const outgoing = typeof body.body === 'string' ? body.body : JSON.stringify(body.body ?? {});
        try {
          const result = await relayRaw(upstream, {
            path: body.path || '/v1/chat/completions',
            headers: body.headers ?? {},
            body: outgoing,
          });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 502, {
            error: { message: `upstream call failed: ${error.message}`, type: 'upstream_error' },
          });
        }
      }

      case 'POST /attach': {
        const body = await readJsonBody(req);
        const cfg = ctx.getConfig();
        const upstream = cfg.upstreams.find((u) => u.id === body.upstream_id);
        if (!upstream) return sendJson(res, 404, { error: { message: 'unknown upstream', type: 'not_found' } });
        const accountId = Number(body.account_id ?? upstream.account_id);
        if (!Number.isInteger(accountId) || accountId <= 0) {
          return sendJson(res, 400, {
            error: { message: 'upstream has no account_id; pass one explicitly', type: 'bad_request' },
          });
        }

        const target = `http://${ctx.publicHost}:${upstream.listen}`;
        const result = await sub2api.setBaseUrl({ token, id: accountId, baseUrl: target });

        const next = {
          ...cfg,
          upstreams: cfg.upstreams.map((u) =>
            u.id === upstream.id
              ? { ...u, account_id: accountId, previous_base_url: result.before ?? u.previous_base_url }
              : u,
          ),
        };
        ctx.saveConfig(next);
        return sendJson(res, 200, { ok: true, before: result.before, after: result.after, account_id: accountId });
      }

      case 'POST /detach': {
        const body = await readJsonBody(req);
        const cfg = ctx.getConfig();
        const upstream = cfg.upstreams.find((u) => u.id === body.upstream_id);
        if (!upstream) return sendJson(res, 404, { error: { message: 'unknown upstream', type: 'not_found' } });
        if (!upstream.previous_base_url) {
          return sendJson(res, 400, {
            error: { message: 'no previous base_url recorded for this upstream', type: 'bad_request' },
          });
        }
        const accountId = Number(body.account_id ?? upstream.account_id);
        const result = await sub2api.setBaseUrl({ token, id: accountId, baseUrl: upstream.previous_base_url });
        return sendJson(res, 200, { ok: true, before: result.before, after: result.after, account_id: accountId });
      }

      default:
        return sendJson(res, 404, { error: { message: `no route for ${route}`, type: 'not_found' } });
    }
  }

  function serveStatic(req, res, pathname) {
    let rel = pathname.replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const full = path.join(ctx.publicDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(ctx.publicDir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let data;
    try {
      data = fs.readFileSync(full);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
    });
    res.end(data);
  }

  /**
   * The path the app sees depends on how it is reached:
   *   direct            -> /_seal/api/state, /_seal/app.js
   *   behind nginx      -> /api/state, /app.js   (proxy_pass with a trailing
   *                        slash strips the /seal/ mount prefix, matching how
   *                        /wb2api/ and /cc2api/ are wired on this host)
   * Both spellings resolve to the same routes.
   */
  function normalize(pathname) {
    if (pathname === '/_seal') return '/';
    if (pathname.startsWith('/_seal/')) return pathname.slice('/_seal'.length);
    return pathname;
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://gateway.local');
    const pathname = normalize(url.pathname);

    if (pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, url, pathname.slice('/api'.length));
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (error instanceof ConfigError) {
          sendJson(res, 400, { error: { message: error.message, type: 'config_invalid' } });
          return;
        }
        if (error instanceof Sub2APIError) {
          sendJson(res, error.status && error.status >= 400 ? error.status : 502, {
            error: { message: error.message, type: 'sub2api_error' },
          });
          return;
        }
        console.error(`[admin] ${req.method} ${url.pathname} failed: ${error.stack || error.message}`);
        sendJson(res, 500, { error: { message: error.message, type: 'internal' } });
      }
      return;
    }
    serveStatic(req, res, pathname);
  };
}

export { stickersView };
