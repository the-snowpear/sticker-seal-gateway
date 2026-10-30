// Persistent gateway configuration.
//
// One JSON file, written atomically, kept next to the container's data volume.
// A corrupt file never takes traffic down: it is set aside and the built-in
// defaults (no stickers, no enabled upstreams) take over, which makes the
// gateway a pass-through until someone fixes it from the GUI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export const DATA_DIR = process.env.DATA_DIR || path.join(repoRoot, 'data');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STICKER_DEFAULTS = path.join(repoRoot, 'defaults/stickers.json');
const UPSTREAM_DEFAULTS = path.join(repoRoot, 'defaults/upstreams.json');

const PROXY_PORT_MIN = 9000;
const PROXY_PORT_MAX = 9100;
const MAX_STICKER_BYTES = 256 * 1024;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export class ConfigError extends Error {}

function coerceStickerText(value, field) {
  if (typeof value !== 'string') throw new ConfigError(`${field} must be a string`);
  if (Buffer.byteLength(value, 'utf8') > MAX_STICKER_BYTES) {
    throw new ConfigError(`${field} exceeds ${MAX_STICKER_BYTES} bytes`);
  }
  return value;
}

function normalizeStickers(input = {}) {
  return {
    prefix: coerceStickerText(input.prefix ?? '', 'stickers.prefix'),
    suffix: coerceStickerText(input.suffix ?? '', 'stickers.suffix'),
    dedupe: input.dedupe !== false,
    max_body_bytes: Number.isFinite(input.max_body_bytes) && input.max_body_bytes > 0
      ? Math.floor(input.max_body_bytes)
      : 128 * 1024 * 1024,
  };
}

function normalizeTarget(target) {
  let url;
  try {
    url = new URL(String(target));
  } catch {
    throw new ConfigError(`invalid target URL: ${target}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`target must be http(s): ${target}`);
  }
  return url.origin;
}

function normalizeUpstream(raw, seenIds, takenPorts) {
  const id = String(raw.id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
    throw new ConfigError(`invalid upstream id: ${JSON.stringify(raw.id)}`);
  }
  if (seenIds.has(id)) throw new ConfigError(`duplicate upstream id: ${id}`);
  seenIds.add(id);

  const listen = Number(raw.listen);
  if (!Number.isInteger(listen) || listen < PROXY_PORT_MIN || listen > PROXY_PORT_MAX) {
    throw new ConfigError(`upstream ${id}: listen must be ${PROXY_PORT_MIN}-${PROXY_PORT_MAX}`);
  }
  if (takenPorts.has(listen)) throw new ConfigError(`duplicate listen port: ${listen}`);
  takenPorts.add(listen);

  const modelAllow = Array.isArray(raw.model_allow)
    ? raw.model_allow.map((v) => String(v).trim()).filter(Boolean)
    : [];

  const accountId = raw.account_id == null || raw.account_id === ''
    ? null
    : Number(raw.account_id);
  if (accountId != null && (!Number.isInteger(accountId) || accountId <= 0)) {
    throw new ConfigError(`upstream ${id}: account_id must be a positive integer`);
  }

  const previous = raw.previous_base_url == null || raw.previous_base_url === ''
    ? null
    : normalizeTarget(raw.previous_base_url);

  return {
    id,
    name: String(raw.name ?? id).slice(0, 64),
    listen,
    target: normalizeTarget(raw.target),
    enabled: raw.enabled !== false,
    model_allow: modelAllow,
    account_id: accountId,
    previous_base_url: previous,
  };
}

export function normalizeUpstreams(list) {
  if (!Array.isArray(list)) throw new ConfigError('upstreams must be an array');
  if (list.length > 20) throw new ConfigError('at most 20 upstreams');
  const seenIds = new Set();
  const takenPorts = new Set();
  return list.map((raw) => normalizeUpstream(raw, seenIds, takenPorts));
}

function seedConfig() {
  const stickers = fs.existsSync(STICKER_DEFAULTS) ? readJson(STICKER_DEFAULTS) : {};
  const upstreams = fs.existsSync(UPSTREAM_DEFAULTS) ? readJson(UPSTREAM_DEFAULTS) : [];
  return {
    version: 1,
    stickers: normalizeStickers(stickers),
    upstreams: normalizeUpstreams(upstreams),
    admin: {
      listen: Number(process.env.ADMIN_PORT) || 6030,
      sub2api_base: process.env.SUB2API_BASE || 'http://sub2api:8080',
    },
  };
}

function normalizeConfig(raw) {
  return {
    version: 1,
    stickers: normalizeStickers(raw?.stickers ?? {}),
    upstreams: normalizeUpstreams(raw?.upstreams ?? []),
    admin: {
      listen: Number(raw?.admin?.listen) || Number(process.env.ADMIN_PORT) || 6030,
      sub2api_base: String(raw?.admin?.sub2api_base ?? process.env.SUB2API_BASE ?? 'http://sub2api:8080'),
    },
  };
}

let current = null;

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(CONFIG_PATH)) {
    current = seedConfig();
    writeJsonAtomic(CONFIG_PATH, current);
    return current;
  }

  try {
    current = normalizeConfig(readJson(CONFIG_PATH));
    return current;
  } catch (error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const aside = `${CONFIG_PATH}.bak.${stamp}`;
    try {
      fs.renameSync(CONFIG_PATH, aside);
    } catch {
      /* the unreadable file stays where it is; defaults still load */
    }
    console.error(`[config] ${CONFIG_PATH} unusable (${error.message}); moved to ${aside}, loading defaults`);
    current = seedConfig();
    writeJsonAtomic(CONFIG_PATH, current);
    return current;
  }
}

export function get() {
  if (!current) load();
  return current;
}

/** Validate a candidate config without touching disk or runtime. */
export function validate(candidate) {
  return normalizeConfig(candidate);
}

export function save(candidate) {
  const normalized = normalizeConfig(candidate);
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.prev`);
    } catch {
      /* a failed backup must not block a legitimate save */
    }
  }
  writeJsonAtomic(CONFIG_PATH, normalized);
  current = normalized;
  return normalized;
}

/** Sticker text only — the hot path reads this on every request. */
export function stickers() {
  return get().stickers;
}
