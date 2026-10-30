import test from 'node:test';
import assert from 'node:assert/strict';

import { inject, detectShape, modelAllowed, estimateTokens, __test__ } from '../src/inject.js';

const PREFIX = '# A head\n你是主人的人偶。';
const SUFFIX = '## B tail\n这段是封印。';

const CT = 'application/json';

const json = (value) => Buffer.from(JSON.stringify(value), 'utf8');
const parse = (buf) => JSON.parse(buf.toString('utf8'));

function run(payload, path = '/v1/chat/completions', extra = {}) {
  const raw = json(payload);
  const out = inject(raw, { path, contentType: CT, prefix: PREFIX, suffix: SUFFIX, ...extra });
  return { out, body: out.injected ? parse(out.body) : payload };
}

test('detectShape matches the three provider shapes and rejects everything else', () => {
  assert.equal(detectShape('/v1/chat/completions'), 'chat');
  assert.equal(detectShape('/v1/chat/completions?beta=true'), 'chat');
  assert.equal(detectShape('http://wb-proxy:8788/v1/chat/completions'), 'chat');
  assert.equal(detectShape('/v1/responses'), 'responses');
  assert.equal(detectShape('/v1/messages#frag'), 'anthropic');
  assert.equal(detectShape('/v1/models'), null);
  assert.equal(detectShape('/v1/embeddings'), null);
  assert.equal(detectShape('/v1/messages/count_tokens'), null);
  assert.equal(detectShape(undefined), null);
});

test('chat: wraps the existing system message and keeps the message count', () => {
  const payload = {
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: '你是助手。' },
      { role: 'user', content: '看图' },
    ],
  };
  const { out, body } = run(payload);
  assert.equal(out.injected, true);
  assert.equal(out.reason, 'wrapped-system');
  assert.equal(out.shape, 'chat');
  assert.equal(out.model, 'deepseek-v4.1-flash');
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, `${PREFIX}\n\n你是助手。\n\n${SUFFIX}`);
  assert.equal(body.messages[1].content, '看图');
});

test('chat: inserts a system message at index 0 when the client sent none', () => {
  const payload = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const { out, body } = run(payload);
  assert.equal(out.reason, 'inserted-system');
  assert.equal(body.messages.length, 2);
  assert.deepEqual(body.messages[0], { role: 'system', content: `${PREFIX}\n\n${SUFFIX}` });
  assert.equal(body.messages[1].role, 'user');
});

test('chat: handles a system message whose content is a block array', () => {
  const payload = {
    model: 'm',
    messages: [
      { role: 'system', content: [{ type: 'text', text: '原系统' }] },
      { role: 'user', content: 'go' },
    ],
  };
  const { out, body } = run(payload);
  assert.equal(out.reason, 'prepended-to-system-blocks');
  const blocks = body.messages[0].content;
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { type: 'text', text: PREFIX });
  assert.deepEqual(blocks[1], { type: 'text', text: '原系统' });
  assert.deepEqual(blocks[2], { type: 'text', text: SUFFIX });
});

test('chat: a null system content is filled instead of concatenated', () => {
  const payload = { model: 'm', messages: [{ role: 'system', content: null }, { role: 'user', content: 'x' }] };
  const { out, body } = run(payload);
  assert.equal(out.reason, 'filled-empty-system');
  assert.equal(body.messages[0].content, `${PREFIX}\n\n${SUFFIX}`);
});

test('chat: only the first system message is touched, later ones stay byte-identical', () => {
  const second = { role: 'system', content: '第二条系统，保持不动' };
  const payload = {
    model: 'm',
    messages: [
      { role: 'system', content: '第一条' },
      { role: 'system', content: second.content },
      { role: 'user', content: 'q' },
    ],
  };
  const { body } = run(payload);
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[1].content, second.content);
});

test('chat: unrelated fields survive untouched', () => {
  const payload = {
    model: 'm',
    stream: true,
    temperature: 0.3,
    tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
  };
  const { body } = run(payload);
  assert.equal(body.stream, true);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.tools[0].function.name, 'f');
  assert.equal(body.model, 'm');
});

test('chat: a non-array messages field is left alone', () => {
  const { out } = run({ model: 'm', messages: 'oops' });
  assert.equal(out.injected, false);
  assert.equal(out.reason, 'no-messages');
});

test('responses: wraps a string instructions field', () => {
  const { out, body } = run(
    { model: 'm', instructions: '你是 Codex。', input: [{ role: 'user', content: 'x' }] },
    '/v1/responses',
  );
  assert.equal(out.reason, 'wrapped-instructions');
  assert.equal(body.instructions, `${PREFIX}\n\n你是 Codex。\n\n${SUFFIX}`);
  assert.equal(body.input.length, 1);
});

test('responses: inserts a system input item when instructions are absent', () => {
  const { out, body } = run({ model: 'm', input: [{ role: 'user', content: 'x' }] }, '/v1/responses');
  assert.equal(out.reason, 'inserted-input-system');
  assert.equal(body.input.length, 2);
  assert.equal(body.input[0].role, 'system');
  assert.equal(body.input[0].content[0].type, 'input_text');
  assert.ok(body.input[0].content[0].text.startsWith(PREFIX));
  assert.ok(body.input[0].content[0].text.endsWith(SUFFIX));
});

test('responses: creates the input array when the request has neither field', () => {
  const { out, body } = run({ model: 'm' }, '/v1/responses');
  assert.equal(out.reason, 'inserted-input-system');
  assert.equal(body.input.length, 1);
});

test('anthropic: wraps a string system', () => {
  const { out, body } = run(
    { model: 'claude', system: '你是 Claude Code。', messages: [{ role: 'user', content: 'hi' }] },
    '/v1/messages',
  );
  assert.equal(out.reason, 'wrapped-system');
  assert.equal(body.system, `${PREFIX}\n\n你是 Claude Code。\n\n${SUFFIX}`);
});

test('anthropic: wraps a block-array system', () => {
  const { out, body } = run(
    { model: 'claude', system: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }], messages: [] },
    '/v1/messages',
  );
  assert.equal(out.reason, 'prepended-to-system-blocks');
  assert.equal(body.system.length, 3);
  assert.deepEqual(body.system[1].cache_control, { type: 'ephemeral' });
});

test('anthropic: creates the system field when missing', () => {
  const { out, body } = run({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }, '/v1/messages');
  assert.equal(out.reason, 'inserted-system');
  assert.equal(body.system, `${PREFIX}\n\n${SUFFIX}`);
});

test('dedupe skips a request that already carries the seal', () => {
  const seeded = { model: 'm', messages: [{ role: 'system', content: `${PREFIX}\n\n已有` }] };
  const { out } = run(seeded);
  assert.equal(out.injected, false);
  assert.equal(out.reason, 'already-sealed');
});

test('dedupe can be turned off and then the seal stacks', () => {
  const seeded = { model: 'm', messages: [{ role: 'system', content: `${PREFIX}\n\n已有` }] };
  const { out, body } = run(seeded, '/v1/chat/completions', { dedupe: false });
  assert.equal(out.injected, true);
  assert.ok(body.messages[0].content.startsWith(PREFIX));
  assert.equal(body.messages[0].content.startsWith(`${PREFIX}\n\n${PREFIX}`), true);
});

test('an oversized body is passed through untouched', () => {
  const raw = Buffer.alloc(2048, 0x7b);
  const out = inject(raw, { path: '/v1/chat/completions', contentType: CT, prefix: PREFIX, suffix: SUFFIX, maxBytes: 1024 });
  assert.equal(out.injected, false);
  assert.equal(out.reason, 'oversize');
  assert.equal(out.body, raw);
});

test('non-JSON content types and empty stickers short-circuit', () => {
  const payload = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
  assert.equal(run(payload, '/v1/chat/completions', { contentType: 'multipart/form-data' }).out.reason, 'not-json');
  assert.equal(run(payload, '/v1/chat/completions', { prefix: '' }).out.reason, 'stickers-empty');
});

test('paths outside the three shapes are passed through', () => {
  const out = inject(json({ model: 'm' }), { path: '/v1/models', contentType: CT, prefix: PREFIX, suffix: SUFFIX });
  assert.equal(out.reason, 'path-not-injected');
  assert.equal(out.outputSha, null);
});

test('invalid JSON never reaches the injection step', () => {
  const raw = Buffer.from('{"model": "m", "messages": [', 'utf8');
  const out = inject(raw, { path: '/v1/chat/completions', contentType: CT, prefix: PREFIX, suffix: SUFFIX });
  assert.equal(out.injected, false);
  assert.equal(out.reason, 'invalid-json');
  assert.equal(out.body, raw);
});

test('model allow-list gates injection with globs', () => {
  assert.equal(modelAllowed([], 'anything'), true);
  assert.equal(modelAllowed(['deepseek-*'], 'deepseek-v4.1-flash'), true);
  assert.equal(modelAllowed(['deepseek-*'], 'gpt-5.5'), false);
  assert.equal(modelAllowed(['gpt-5.?'], 'gpt-5.5'), true);

  const payload = { model: 'gpt-5.5', messages: [{ role: 'user', content: 'x' }] };
  const { out } = run(payload, '/v1/chat/completions', { modelAllow: ['deepseek-*'] });
  assert.equal(out.injected, false);
  assert.equal(out.reason, 'model-filtered');
  assert.equal(out.model, 'gpt-5.5');
});

test('hashes are stable and differ once the seal is applied', () => {
  const payload = { model: 'm', messages: [{ role: 'system', content: 's' }] };
  const raw = json(payload);
  const out = inject(raw, { path: '/v1/chat/completions', contentType: CT, prefix: PREFIX, suffix: SUFFIX });
  assert.equal(out.inputSha.length, 64);
  assert.equal(out.outputSha.length, 64);
  assert.notEqual(out.inputSha, out.outputSha);
});

test('CJK stickers survive the round trip byte-exactly', () => {
  const payload = { model: 'm', messages: [{ role: 'system', content: '中文系统' }] };
  const { body } = run(payload);
  assert.equal(body.messages[0].content.includes('主人的人偶'), true);
  assert.equal(body.messages[0].content.includes('这段是封印'), true);
  assert.equal(Buffer.from(body.messages[0].content, 'utf8').toString('utf8'), body.messages[0].content);
});

test('estimateTokens splits CJK from Latin like the real tokenizer', () => {
  assert.equal(estimateTokens(''), 0);
  // Latin runs ~4 chars per token, CJK ~1.6.
  assert.equal(estimateTokens('abcdefghij'), Math.ceil(10 / 4));
  assert.equal(estimateTokens('一二三四五六七八九十'.repeat(10)), Math.ceil(100 / 1.6));
  assert.equal(estimateTokens('ab中文'), Math.ceil(2 / 4) + Math.ceil(2 / 1.6));
  // Calibration sample: the shipped sticker billed 7,376 prompt tokens.
  const sticker = 'a'.repeat(22571) + '中'.repeat(3529);
  const estimated = estimateTokens(sticker);
  assert.ok(estimated > 6500 && estimated < 9200, `estimate drifted: ${estimated}`);
});

test('internal helpers behave', () => {
  assert.equal(__test__.isJsonContentType('application/json; charset=utf-8'), true);
  assert.equal(__test__.isJsonContentType('application/problem+json'), true);
  assert.equal(__test__.isJsonContentType('text/plain'), false);
  assert.equal(__test__.pathnameOf('/a/b?c=d'), '/a/b');
  assert.equal(__test__.globMatch('deepseek-*-flash', 'deepseek-v4.1-flash'), true);
  assert.equal(__test__.globMatch('deepseek-*', 'DeepSeek-V4'), true);
  assert.equal(__test__.sealString('', 'A', 'B'), 'A\n\nB');
});
