// Process entry point.
//
// Starts one reverse-proxy listener per enabled upstream plus the admin server
// that serves the GUI. Configuration changes made from the GUI are applied by
// reconciling the listener set in place — no container restart, no dropped
// sockets, and upstreams can be added or removed at runtime.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as config from './config.js';
import { createHandler } from './proxy.js';
import { createUiHandler } from './routes.js';
import { init as initStats, stats } from './stats.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '../public');

const JWT_SECRET = process.env.SUB2API_JWT_SECRET || '';
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'sticker-seal';

const listeners = new Map(); // id -> { server, listen, target }
const runtimeState = new Map(); // id -> { listening, error, since }

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function stickersReader() {
  return config.get().stickers;
}

function liveModelAllow(id) {
  const upstream = config.get().upstreams.find((u) => u.id === id);
  return upstream?.model_allow ?? [];
}

function markRuntime(id, patch) {
  runtimeState.set(id, { ...(runtimeState.get(id) ?? {}), ...patch });
}

function openListener(upstream) {
  const ref = {
    id: upstream.id,
    target: upstream.target,
    get model_allow() {
      return liveModelAllow(upstream.id);
    },
    stickers: stickersReader,
  };

  const server = http.createServer(createHandler(ref));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 0;

  server.on('error', (error) => {
    markRuntime(upstream.id, { listening: false, error: error.message, since: Date.now() });
    console.error(`[listener:${upstream.id}] ${error.message}`);
  });

  server.listen(upstream.listen, '0.0.0.0', () => {
    markRuntime(upstream.id, { listening: true, error: null, since: Date.now() });
    log(`[listener:${upstream.id}] :${upstream.listen} -> ${upstream.target}`);
  });

  listeners.set(upstream.id, { server, listen: upstream.listen, target: upstream.target });
}

function closeListener(id) {
  const entry = listeners.get(id);
  if (!entry) return;
  entry.server.close(() => log(`[listener:${id}] closed`));
  listeners.delete(id);
  markRuntime(id, { listening: false, error: null });
}

function reconcile() {
  const wanted = new Map(
    config.get().upstreams.filter((u) => u.enabled).map((u) => [u.id, u]),
  );

  for (const [id, entry] of [...listeners]) {
    const want = wanted.get(id);
    if (!want || want.listen !== entry.listen || want.target !== entry.target) {
      closeListener(id);
    }
  }
  for (const [id, want] of wanted) {
    if (!listeners.has(id)) openListener(want);
  }
}

let adminServer = null;

function saveConfigAndApply(candidate) {
  const saved = config.save(candidate);
  reconcile();
  return saved;
}

function startAdmin() {
  const cfg = config.get();
  const handler = createUiHandler({
    getConfig: () => config.get(),
    saveConfig: saveConfigAndApply,
    runtime: () => Object.fromEntries(runtimeState),
    stats: stats(),
    secret: JWT_SECRET,
    publicDir: PUBLIC_DIR,
    publicHost: PUBLIC_HOST,
  });

  adminServer = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      console.error(`[admin] unhandled: ${error.stack || error.message}`);
      if (!res.headersSent) res.writeHead(500).end('internal error');
      else res.destroy();
    });
  });

  adminServer.listen(cfg.admin.listen, '0.0.0.0', () => {
    log(`[admin] listening on :${cfg.admin.listen} — /_seal/`);
    if (!JWT_SECRET) {
      console.warn('[admin] SUB2API_JWT_SECRET is empty: every API call will be rejected (401)');
    }
    const missing = config.get().upstreams.filter((u) => u.enabled && !(runtimeState.get(u.id)?.listening));
    if (missing.length) {
      console.warn(`[admin] not listening yet: ${missing.map((u) => `${u.id}:${u.listen}`).join(', ')}`);
    }
  });
  adminServer.on('error', (error) => {
    console.error(`[admin] listen failed: ${error.message}`);
    process.exitCode = 1;
  });
}

export function start({ dataDir } = {}) {
  initStats(dataDir || config.DATA_DIR);
  config.load();
  reconcile();
  startAdmin();

  const shutdown = (signal) => {
    log(`[main] ${signal} received, shutting down`);
    for (const id of [...listeners.keys()]) closeListener(id);
    adminServer?.close();
    try {
      stats().flush();
    } catch {
      /* nothing to flush */
    }
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const cfg = config.get();
  log(`[main] sticker-seal-gateway ready — ${cfg.upstreams.length} upstream(s) configured, ` +
    `sticker ${[...cfg.stickers.prefix].length}+${[...cfg.stickers.suffix].length} chars`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) start();
