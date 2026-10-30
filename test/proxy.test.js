import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHandler, relayRaw, plan } from '../src/proxy.js';
import { init as initStats } from '../src/stats.js';

const PREFIX = '<<<PREFIX>>>';
const SUFFIX = '<<<SUFFIX>>>';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-proxy-'));
initStats(tmpDir);

const stickers = {
  prefix: PREFIX,
  suffix: SUFFIX,
  dedupe: true,
  max_body_bytes: 1024 * 1024,
};

/** Upstream stub: echoes back method, url, headers and the body it received. */
function startEcho() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url.startsWith('/sse')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: first\n\n');
        setTimeout(() => {
          res.write('data: second\n\n');
          res.end();
        }, 60);
        return;
      }
      const payload = JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function startGateway(target, override = {}) {
  const handler = createHandler({
    id: 'test',
    target,
    model_allow: override.model_allow ?? [],
    stickers: () => ({ ...stickers, ...override.stickers }),
  });
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function addr(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

async function call(url, { method = 'POST', headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

const echo = await startEcho();
const gateway = await startGateway(addr(echo));

test.after(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => echo.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('chat completions: the upstream receives the sealed body', async () => {
  const payload = {
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: 'original' },
      { role: 'user', content: 'describe the image' },
    ],
  };
  const out = await call(`${addr(gateway)}/v1/chat/completions`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(out.status, 200);
  const echoed = JSON.parse(out.text);
  assert.equal(echoed.method, 'POST');
  assert.equal(echoed.url, '/v1/chat/completions');
  const forwarded = JSON.parse(echoed.body);
  assert.equal(forwarded.model, 'deepseek-v4.1-flash');
  assert.equal(forwarded.messages.length, 2);
  assert.equal(forwarded.messages[0].content, `${PREFIX}\n\noriginal\n\n${SUFFIX}`);
  assert.equal(echoed.headers['content-length'], String(Buffer.byteLength(echoed.body)));
});

test('GET requests are piped through untouched', async () => {
  const out = await call(`${addr(gateway)}/v1/models`, { method: 'GET' });
  assert.equal(out.status, 200);
  const echoed = JSON.parse(out.text);
  assert.equal(echoed.method, 'GET');
  assert.equal(echoed.url, '/v1/models');
  assert.equal(echoed.body, '');
});

test('non-JSON bodies are passed through byte for byte', async () => {
  const raw = 'model=x&prompt=hi';
  const out = await call(`${addr(gateway)}/v1/chat/completions`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: raw,
  });
  const echoed = JSON.parse(out.text);
  assert.equal(echoed.body, raw);
});

test('unknown paths are passed through without parsing', async () => {
  const raw = JSON.stringify({ messages: [{ role: 'user', content: 'x' }] });
  const out = await call(`${addr(gateway)}/v1/embeddings`, {
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
  const echoed = JSON.parse(out.text);
  assert.equal(echoed.body, raw);
});

test('a declared oversize body is streamed through without injection', async () => {
  const raw = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(2048) }] });
  const small = await startGateway(addr(echo), { stickers: { max_body_bytes: 512 } });
  try {
    const out = await call(`${addr(small)}/v1/chat/completions`, {
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
    const echoed = JSON.parse(out.text);
    assert.equal(echoed.body, raw);
  } finally {
    await new Promise((r) => small.close(r));
  }
});

test('an undeclared oversize body is rejected with 413', async () => {
  const small = await startGateway(addr(echo), { stickers: { max_body_bytes: 512 } });
  try {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"m","messages":['));
        controller.enqueue(new TextEncoder().encode('"y".repeat(0)'.padEnd(4096, 'z')));
        controller.close();
      },
    });
    const res = await fetch(`${addr(small)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    });
    assert.equal(res.status, 413);
    const payload = await res.json();
    assert.equal(payload.error.type, 'payload_too_large');
  } finally {
    await new Promise((r) => small.close(r));
  }
});

test('model allow-list skips injection for non-matching models', async () => {
  const gated = await startGateway(addr(echo), { model_allow: ['deepseek-*'] });
  try {
    const raw = JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'x' }] });
    const out = await call(`${addr(gated)}/v1/chat/completions`, {
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
    const echoed = JSON.parse(out.text);
    assert.equal(echoed.body, raw);
  } finally {
    await new Promise((r) => gated.close(r));
  }
});

test('SSE responses stream through with the first chunk before the last is produced', async () => {
  const began = Date.now();
  const res = await fetch(`${addr(gateway)}/sse`);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const firstAt = Date.now();
  let text = decoder.decode(first.value, { stream: true });
  assert.ok(text.includes('data: first'));

  let done = false;
  while (!done) {
    const next = await reader.read();
    done = next.done;
    if (!done) text += decoder.decode(next.value, { stream: true });
  }
  text += decoder.decode();
  const totalAt = Date.now();

  assert.ok(text.includes('data: second'));
  assert.ok(firstAt - began < 200, `first chunk took ${firstAt - began}ms`);
  assert.ok(totalAt - firstAt >= 40, 'the stream was not buffered into one burst');
});

test('an unreachable upstream yields a typed 502', async () => {
  const dead = await startGateway('http://127.0.0.1:1');
  try {
    const out = await call(`${addr(dead)}/v1/chat/completions`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(out.status, 502);
    const payload = JSON.parse(out.text);
    assert.equal(payload.error.type, 'upstream_unreachable');
    assert.match(payload.error.message, /sticker-seal: upstream test unreachable/);
  } finally {
    await new Promise((r) => dead.close(r));
  }
});

test('relayRaw forwards a body and captures the answer', async () => {
  const result = await relayRaw(
    { id: 'test', target: addr(echo) },
    { path: '/v1/chat/completions', body: JSON.stringify({ model: 'm', messages: [] }) },
  );
  assert.equal(result.status, 200);
  const echoed = JSON.parse(result.body);
  assert.equal(echoed.url, '/v1/chat/completions');
  assert.ok(result.ms >= 0);
});

test('plan classifies requests before any body is read', () => {
  const base = { ...stickers };
  assert.equal(plan({ method: 'POST', url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } }, base).buffer, true);
  assert.equal(plan({ method: 'GET', url: '/v1/chat/completions', headers: {} }, base).reason, 'method');
  assert.equal(plan({ method: 'POST', url: '/v1/models', headers: { 'content-type': 'application/json' } }, base).reason, 'path-not-injected');
  assert.equal(plan({ method: 'POST', url: '/v1/chat/completions', headers: { 'content-type': 'text/plain' } }, base).reason, 'not-json');
  assert.equal(plan({ method: 'POST', url: '/v1/chat/completions', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }, base).reason, 'content-encoded');
  assert.equal(plan({ method: 'POST', url: '/v1/chat/completions', headers: { 'content-type': 'application/json', 'content-length': '999999999' } }, base).reason, 'oversize');
  assert.equal(plan({ method: 'POST', url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } }, { ...base, prefix: '' }).reason, 'stickers-empty');
});
