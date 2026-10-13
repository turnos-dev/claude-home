import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { catalog, createPi, allowedModel } from './pi.mjs';

const settings = { piProvider: 'openai', piModel: 'gpt-4o', effort: 'low', timeoutMs: 1000 };
function fixture(AgentClass) {
  const dir = mkdtempSync(`${tmpdir()}/pi-test-`);
  const calls = [], clients = [];
  const pi = createPi({ dir, AgentClass, connect: async (spec) => {
    const client = { closed: false, listTools: async () => ({ tools: [{ name: spec.admin ? 'continue_in_app' : 'switch', inputSchema: { type: 'object', properties: {} } }] }),
      callTool: async (...args) => { calls.push(args); return { content: [{ type: 'text', text: 'OK' }] }; }, close: async () => { client.closed = true; } };
    clients.push(client); return client;
  } });
  pi.setKey('openai', 'test-key');
  const turn = { grant: 'turn-grant', servers: { ha: {}, admin: { admin: true } } };
  return { pi, dir, calls, clients, turn };
}
class FakeAgent {
  constructor(options) { this.options = options; this.state = options.initialState; FakeAgent.last = this; }
  async prompt(text) {
    this.state.messages.push({ role: 'user', content: text });
    await this.state.tools[0].execute('call', {}, new AbortController().signal);
    this.state.messages.push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Light is on.' }] });
  }
  abort() { this.aborted = true; }
}
test('catalog keeps Claude separate and includes subscription providers', () => {
  assert.equal(allowedModel({ provider: 'anthropic', id: 'anything' }), false);
  assert.equal(allowedModel({ provider: 'github-copilot', id: 'claude-sonnet-4' }), false);
  const providers = catalog();
  assert.ok(providers.find((p) => p.id === 'openai-codex').oauth);
  assert.ok(providers.find((p) => p.id === 'github-copilot').oauth);
  assert.ok(!providers.some((p) => p.id === 'anthropic'));
});
test('gateway tools, persistence, resume and credential redaction', async () => {
  const f = fixture(FakeAgent);
  const first = await f.pi.run({ s: settings, text: 'hello', turn: f.turn, systemPrompt: 'Home assistant' });
  assert.match(first.sid, /^pi:/); assert.equal(first.text, 'Light is on.');
  assert.deepEqual(first.tools, ['switch']);
  assert.equal(FakeAgent.last.state.tools.length, 1); // handover excluded
  assert.equal(FakeAgent.last.options.getApiKey(), 'test-key');
  assert.ok(f.clients.every((c) => c.closed));
  assert.equal(f.calls[0][0].name, 'switch');
  assert.equal(f.pi.status('openai').apiKey, true);
  assert.ok(!JSON.stringify(f.pi.status('openai')).includes('test-key'));
  assert.equal(statSync(`${f.dir}/auth.json`).mode & 0o777, 0o600);
  const next = await f.pi.run({ s: settings, text: 'follow up', sid: first.sid, turn: f.turn, systemPrompt: 'Home assistant' });
  assert.equal(first.sid, next.sid);
  assert.equal(FakeAgent.last.state.messages.length, 4);
  assert.ok(!readFileSync(`${f.dir}/${first.sid.slice(3)}.json`, 'utf8').includes('test-key'));
});
test('missing auth and invalid model fail without exposing tools', async () => {
  const f = fixture(FakeAgent); f.pi.setKey('openai', '');
  await assert.rejects(f.pi.run({ s: settings, text: 'hi', turn: f.turn }), /not logged in/);
  assert.equal(f.clients.length, 0);
  await assert.rejects(f.pi.run({ s: { ...settings, piModel: 'invalid' }, turn: f.turn }), /valid Pi/);
  assert.throws(() => f.pi.setKey('anthropic', 'key'), /Unsupported/);
});
test('timeout aborts agent, closes tools and does not save a partial turn', async () => {
  class SlowAgent extends FakeAgent { async prompt() { return new Promise(() => {}); } }
  const f = fixture(SlowAgent);
  await assert.rejects(f.pi.run({ s: { ...settings, timeoutMs: 30 }, text: 'hi', turn: f.turn, systemPrompt: '' }), /timed out/);
  assert.ok(FakeAgent.last.aborted);
  assert.ok(f.clients.every((c) => c.closed));
  assert.deepEqual(readdirSync(f.dir), ['auth.json']);
});
test('model errors do not save a partial conversation', async () => {
  class ErrorAgent extends FakeAgent { async prompt() { this.state.messages.push({ role: 'assistant', stopReason: 'error', errorMessage: 'provider failed' }); } }
  const f = fixture(ErrorAgent);
  await assert.rejects(f.pi.run({ s: settings, text: 'hi', turn: f.turn, systemPrompt: '' }), /provider failed/);
  assert.ok(f.clients.every((c) => c.closed));
  assert.deepEqual(readdirSync(f.dir), ['auth.json']);
});

test('real Pi Agent validates MCP schema and runs a tool round trip', async () => {
  const { Agent } = await import('@mariozechner/pi-agent-core');
  const { createAssistantMessageEventStream } = await import('@mariozechner/pi-ai');
  let round = 0;
  class LocalAgent extends Agent {
    constructor(options) {
      super({ ...options, streamFn: (model) => {
        const stream = createAssistantMessageEventStream();
        const tool = round++ === 0;
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: tool ? [{ type: 'toolCall', id: 'call-1', name: 'mcp__ha__switch', arguments: {} }] : [{ type: 'text', text: 'Done.' }],
          stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); return stream;
      } });
    }
  }
  const f = fixture(LocalAgent);
  const result = await f.pi.run({ s: settings, text: 'switch it on', turn: f.turn, systemPrompt: '' });
  assert.equal(result.text, 'Done.');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(result.tools, ['switch']);
});
