// Regression cover for the connect/headers timeout split.
//
// The gateway used to call `proxyReq.setTimeout(CONNECT_TIMEOUT_MS, …)`, which
// in Node is a *socket inactivity* timer. A non-streaming upstream stays silent
// until the whole completion is ready, so any reply that took longer than the
// connect budget was killed and surfaced to the client as
// `502 upstream unreachable (upstream connect timeout)`.
//
// The env knobs keep the real timers at 10 s / 600 s in production; here they
// are shrunk so the "silence is not a dead socket" case runs in milliseconds.

process.env.SEAL_CONNECT_TIMEOUT_MS = '80';
process.env.SEAL_RESPONSE_TIMEOUT_MS = '5000';

const test = (await import('node:test')).test;
const assert = (await import('node:assert/strict')).default;
const http = (await import('node:http')).default;
const fs = (await import('node:fs')).default;
const os = (await import('node:os')).default;
const path = (await import('node:path')).default;

const { createHandler } = await import('../src/proxy.js');
const { init: initStats } = await import('../src/stats.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-timeout-'));
initStats(tmpDir);

const stickers = {
  prefix: '<<<PREFIX>>>',
  suffix: '<<<SUFFIX>>>',
  dedupe: true,
  max_body_bytes: 1024 * 1024,
};

/** Upstream that stays silent for `delayMs` before writing anything at all. */
function startSlowUpstream(delayMs) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, waited: delayMs }));
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function startProxy(target) {
  const handler = createHandler({
    id: 'slow',
    target,
    model_allow: [],
    stickers: () => stickers,
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function post(port, bodyObj) {
  const body = Buffer.from(JSON.stringify(bodyObj));
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-length': body.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* non-JSON body is fine for this assertion */
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', () => resolve({ status: 0, json: null, text: '' }));
    req.end(body);
  });
}

test('silence longer than the connect budget is not a connect failure', async () => {
  // 80 ms connect budget, upstream stays silent for 250 ms before headers.
  const upstream = await startSlowUpstream(250);
  const proxy = await startProxy(`http://127.0.0.1:${upstream.address().port}`);
  try {
    const res = await post(proxy.address().port, {
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.waited, 250);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('the injected body still reaches the upstream on a slow reply', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }, 200);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startProxy(`http://127.0.0.1:${upstream.address().port}`);
  try {
    const res = await post(proxy.address().port, {
      model: 'm',
      messages: [
        { role: 'system', content: 'you are a bot' },
        { role: 'user', content: 'hi' },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].messages[0].content, '<<<PREFIX>>>\n\nyou are a bot\n\n<<<SUFFIX>>>');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a genuinely dead upstream still fails fast', async () => {
  // Port 1 is reserved and nothing listens there.
  const proxy = await startProxy('http://127.0.0.1:1');
  try {
    const res = await post(proxy.address().port, {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(res.status, 502);
    assert.match(res.json.error.message, /upstream slow unreachable/);
  } finally {
    proxy.close();
  }
});
