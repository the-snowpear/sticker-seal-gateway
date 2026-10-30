// Request-body injection for the sticker seal.
//
// The gateway sits between sub2api and the upstream converters, so it only ever
// sees provider-native JSON on its way out. Three shapes show up in practice:
//
//   POST .../v1/chat/completions  -> OpenAI chat completions  (messages[].role/content)
//   POST .../v1/responses         -> OpenAI Responses API     (instructions + input[])
//   POST .../v1/messages          -> Anthropic Messages       (system + messages[])
//
// For every one of them the seal goes into the *system slot*: sticker A at the
// head, sticker B at the tail, the client's own system text in between. That
// keeps the message count identical to what the client sent, which matters
// because strict upstreams (DeepSeek included) reject or mis-order extra
// messages, and tool-call sequencing must not shift.
//
// Everything else — non-JSON bodies, unknown paths, oversized uploads, disabled
// upstreams — is passed through byte for byte.

import { createHash } from 'node:crypto';

/** Bytes of the prefix used for the "already sealed" idempotency check. */
const DEDUPE_WINDOW = 64;

/**
 * Rough input-token estimate.
 *
 * Calibrated against a measured DeepSeek-V4-Flash prompt: the 26,100-character
 * sticker billed 7,376 prompt tokens. CJK runs near 1.6 chars/token, Latin and
 * punctuation near 4 chars/token, which lands within a few percent on that
 * sample. Use it for budgeting, not for accounting.
 */
export function estimateTokens(text) {
  const value = String(text);
  let cjk = 0;
  let total = 0;
  for (const ch of value) {
    total += 1;
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x3040 && cp <= 0x30ff) || // kana
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
      (cp >= 0xff00 && cp <= 0xffef) // fullwidth forms
    ) {
      cjk += 1;
    }
  }
  return Math.ceil(cjk / 1.6) + Math.ceil((total - cjk) / 4);
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function isJsonContentType(contentType) {
  if (!contentType) return false;
  const value = String(contentType).toLowerCase();
  return value.includes('application/json') || value.includes('+json');
}

/** Strip query and hash so only the routing path is matched. */
function pathnameOf(path) {
  const raw = String(path ?? '');
  const cut = raw.search(/[?#]/);
  return cut === -1 ? raw : raw.slice(0, cut);
}

/**
 * Which provider shape is this request?
 * @returns {'chat'|'responses'|'anthropic'|null}
 */
export function detectShape(path) {
  const p = pathnameOf(path);
  if (p.endsWith('/chat/completions')) return 'chat';
  if (p.endsWith('/responses')) return 'responses';
  if (p.endsWith('/messages')) return 'anthropic';
  return null;
}

/** Pull plain text out of a system slot value for the dedupe probe. */
function systemText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
  }
  return '';
}

function alreadySealed(text, prefix) {
  if (!text || !prefix) return false;
  const head = prefix.slice(0, Math.min(DEDUPE_WINDOW, prefix.length));
  return text.startsWith(head);
}

function sealString(original, prefix, suffix) {
  const body = typeof original === 'string' ? original : '';
  if (!body.trim()) return `${prefix}\n\n${suffix}`;
  return `${prefix}\n\n${body}\n\n${suffix}`;
}

function sealBlocks(blocks, prefix, suffix, blockType) {
  const head = { type: blockType, text: prefix };
  const tail = { type: blockType, text: suffix };
  return [head, ...blocks, tail];
}

/** Simple `*` / `?` glob match, case-insensitive, anchored. */
function globMatch(pattern, value) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(String(value));
}

/** Empty allow-list means "every model". */
export function modelAllowed(modelAllow, model) {
  if (!Array.isArray(modelAllow) || modelAllow.length === 0) return true;
  if (!model) return false;
  return modelAllow.some((pattern) => globMatch(pattern, model));
}

/**
 * Apply the seal to an already-parsed JSON payload, in place.
 * @returns {{injected: boolean, reason: string}}
 */
function applyToPayload(payload, shape, stickers) {
  const { prefix, suffix, dedupe } = stickers;

  if (shape === 'chat') {
    const messages = payload.messages;
    if (!Array.isArray(messages)) return { injected: false, reason: 'no-messages' };

    const index = messages.findIndex((m) => m && typeof m === 'object' && m.role === 'system');
    if (index === -1) {
      messages.unshift({ role: 'system', content: `${prefix}\n\n${suffix}` });
      return { injected: true, reason: 'inserted-system' };
    }

    const target = messages[index];
    if (dedupe && alreadySealed(systemText(target.content), prefix)) {
      return { injected: false, reason: 'already-sealed' };
    }

    if (Array.isArray(target.content)) {
      target.content = sealBlocks(target.content, prefix, suffix, 'text');
      return { injected: true, reason: 'prepended-to-system-blocks' };
    }
    if (target.content == null) {
      target.content = `${prefix}\n\n${suffix}`;
      return { injected: true, reason: 'filled-empty-system' };
    }
    if (typeof target.content !== 'string') {
      return { injected: false, reason: 'system-unrecognized' };
    }
    target.content = sealString(target.content, prefix, suffix);
    return { injected: true, reason: 'wrapped-system' };
  }

  if (shape === 'responses') {
    if (dedupe && alreadySealed(systemText(payload.instructions), prefix)) {
      return { injected: false, reason: 'already-sealed' };
    }
    if (typeof payload.instructions === 'string') {
      payload.instructions = sealString(payload.instructions, prefix, suffix);
      return { injected: true, reason: 'wrapped-instructions' };
    }
    const input = payload.input;
    const block = {
      role: 'system',
      content: [{ type: 'input_text', text: `${prefix}\n\n${suffix}` }],
    };
    if (Array.isArray(input)) {
      input.unshift(block);
      return { injected: true, reason: 'inserted-input-system' };
    }
    if (input == null) {
      payload.input = [block];
      return { injected: true, reason: 'inserted-input-system' };
    }
    return { injected: false, reason: 'input-unrecognized' };
  }

  if (shape === 'anthropic') {
    const system = payload.system;
    if (dedupe && alreadySealed(systemText(system), prefix)) {
      return { injected: false, reason: 'already-sealed' };
    }
    if (Array.isArray(system)) {
      payload.system = sealBlocks(system, prefix, suffix, 'text');
      return { injected: true, reason: 'prepended-to-system-blocks' };
    }
    if (system == null) {
      payload.system = `${prefix}\n\n${suffix}`;
      return { injected: true, reason: 'inserted-system' };
    }
    if (typeof system !== 'string') return { injected: false, reason: 'system-unrecognized' };
    payload.system = sealString(system, prefix, suffix);
    return { injected: true, reason: 'wrapped-system' };
  }

  return { injected: false, reason: 'unknown-shape' };
}

/**
 * Main entry point.
 *
 * @param {Buffer} raw                     request body as received
 * @param {object} opts
 * @param {string} opts.path               request path (query allowed)
 * @param {string} opts.contentType        request content-type header
 * @param {string} opts.prefix             sticker A
 * @param {string} opts.suffix             sticker B
 * @param {boolean} [opts.dedupe=true]     skip when already sealed
 * @param {number} [opts.maxBytes]         bodies above this are passed through
 * @param {string[]} [opts.modelAllow]     model globs; empty = all
 * @returns {{body: Buffer, injected: boolean, reason: string, shape: string|null,
 *            model: string|null, inputSha: string|null, outputSha: string|null}}
 */
export function inject(raw, opts) {
  const {
    path,
    contentType,
    prefix = '',
    suffix = '',
    dedupe = true,
    maxBytes = 128 * 1024 * 1024,
    modelAllow = [],
  } = opts ?? {};

  const base = {
    body: raw,
    injected: false,
    reason: 'passthrough',
    shape: null,
    model: null,
    inputSha: raw?.length ? sha256(raw) : null,
    outputSha: null,
  };

  if (!Buffer.isBuffer(raw) || raw.length === 0) return { ...base, reason: 'empty-body' };
  if (raw.length > maxBytes) return { ...base, reason: 'oversize' };
  if (!prefix || !suffix) return { ...base, reason: 'stickers-empty' };
  if (!isJsonContentType(contentType)) return { ...base, reason: 'not-json' };

  const shape = detectShape(path);
  if (!shape) return { ...base, reason: 'path-not-injected' };

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ...base, reason: 'invalid-json' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ...base, reason: 'not-object' };
  }

  const model = typeof payload.model === 'string' ? payload.model : null;
  if (!modelAllowed(modelAllow, model)) {
    return { ...base, shape, model, reason: 'model-filtered' };
  }

  const result = applyToPayload(payload, shape, { prefix, suffix, dedupe: dedupe !== false });
  if (!result.injected) return { ...base, shape, model, reason: result.reason };

  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    body,
    injected: true,
    reason: result.reason,
    shape,
    model,
    inputSha: base.inputSha,
    outputSha: sha256(body),
  };
}

export const __test__ = { isJsonContentType, pathnameOf, systemText, globMatch, sealString };
