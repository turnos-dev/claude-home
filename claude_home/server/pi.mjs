// Pi backend: only gateway MCP tools, never shell/files or the Supervisor token.
import { Agent } from '@earendil-works/pi-agent-core';
import { getProviders, getModels, streamSimple, getOAuthProviders, getOAuthProvider, getOAuthApiKey, loginWithProvider } from './pi-sdk.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const allowedModel = (m) => m.provider !== 'anthropic' && !/claude/i.test(m.id);
export function catalog() {
  return getProviders().filter((id) => !['amazon-bedrock', 'google-vertex'].includes(id)).map((id) => ({ id, oauth: !!getOAuthProvider(id), models: getModels(id).filter(allowedModel).map((m) => ({ id: m.id, name: m.name })) })).filter((p) => p.models.length);
}
const load = (file, fallback = {}) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
function save(file, value) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export function createPi({ dir, AgentClass = Agent, connect = async (spec) => {
  const client = new Client({ name: 'claude-home-pi', version: '1' });
  try { await client.connect(new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } })); return client; }
  catch (e) { await client.close(); throw e; }
} }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const authFile = `${dir}/auth.json`;
  let login;
  const valid = (provider) => { if (!catalog().some((p) => p.id === provider)) throw new Error('Unsupported Pi provider'); };
  function status(provider) {
    valid(provider);
    const auth = load(authFile)[provider];
    return { provider, loggedIn: auth?.type === 'oauth', apiKey: auth?.type === 'api_key', login: login?.provider === provider ? { url: login.url, instructions: login.instructions, prompt: login.prompt, promptOptions: login.promptOptions, error: login.error, pending: login.pending } : null };
  }
  function setKey(provider, key) {
    valid(provider);
    if (login?.pending) throw new Error('Finish or cancel the login first');
    const auth = load(authFile);
    if (key) auth[provider] = { type: 'api_key', key }; else delete auth[provider];
    save(authFile, auth);
    return status(provider);
  }
  function cancelLogin() {
    login?.controller.abort();
    login?.reject?.(new Error('Login cancelled'));
    if (login?.timer) clearTimeout(login.timer);
    login = undefined;
  }
  function startLogin(provider) {
    valid(provider);
    const oauth = getOAuthProviders().find((p) => p.id === provider);
    if (!oauth) throw new Error('This provider uses an API key');
    cancelLogin();
    const state = login = { provider, pending: true, controller: new AbortController() };
    const input = (prompt) => new Promise((resolve, reject) => {
      state.prompt = prompt.message; state.promptOptions = prompt.type === 'select' ? prompt.options : undefined; state.resolve = resolve; state.reject = reject;
      const aborted = () => { if (state.resolve === resolve) { state.resolve = undefined; state.prompt = undefined; state.promptOptions = undefined; } reject(new Error('Login prompt cancelled')); };
      if (prompt.signal?.aborted) return aborted();
      prompt.signal?.addEventListener('abort', aborted, { once: true });
    });
    state.timer = setTimeout(cancelLogin, 10 * 60_000);
    loginWithProvider(oauth, { signal: state.controller.signal, onAuth: (info) => Object.assign(state, info), onPrompt: input, getDeviceId: () => {
      const file = `${dir}/device.json`; const stored = load(file);
      if (stored.id) return stored.id;
      const id = randomUUID(); save(file, { id }); return id;
    } })
      .then((credentials) => { if (login === state) save(authFile, { ...load(authFile), [provider]: { type: 'oauth', ...credentials } }); })
      .catch((e) => { state.error = e.message; })
      .finally(() => { state.pending = false; state.prompt = undefined; state.promptOptions = undefined; state.resolve = undefined; clearTimeout(state.timer); });
    return status(provider);
  }
  function code(provider, value) {
    if (login?.provider !== provider || !login.resolve) throw new Error('No login waiting for input');
    const resolve = login.resolve; login.resolve = undefined; login.prompt = undefined; login.promptOptions = undefined; resolve(value);
    return status(provider);
  }
  const credentialQueues = new Map();
  async function readCredentials(provider, model, signal) {
    const auth = load(authFile), entry = auth[provider];
    if (!entry) throw new Error('Pi provider is not logged in. Open Settings and log in or add an API key.');
    if (entry.type === 'api_key') return { key: entry.key, model };
    const result = await getOAuthApiKey(provider, auth, signal);
    if (!result) throw new Error('Pi provider is not logged in');
    if (JSON.stringify(load(authFile)[provider]) !== JSON.stringify(entry)) throw new Error('Provider login changed; try again');
    save(authFile, { ...load(authFile), [provider]: { type: 'oauth', ...result.newCredentials } });
    return { key: result.apiKey, model: { ...model, ...(result.auth.baseUrl ? { baseUrl: result.auth.baseUrl } : {}), headers: { ...model.headers, ...result.auth.headers } } };
  }
  async function credentials(provider, model, signal) {
    const previous = credentialQueues.get(provider) || Promise.resolve();
    const job = previous.catch(() => {}).then(() => readCredentials(provider, model, signal));
    credentialQueues.set(provider, job);
    try { return await job; } finally { if (credentialQueues.get(provider) === job) credentialQueues.delete(provider); }
  }
  async function run({ s, text, sid, turn, systemPrompt }) {
    const model = getModels(s.piProvider).find((m) => m.id === s.piModel && allowedModel(m));
    if (!model) throw new Error('Select a valid Pi provider and model in Settings');
    const started = Date.now(), clients = [], toolsUsed = [];
    const controller = new AbortController();
    let agent, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); agent?.abort(); }, s.timeoutMs);
    const bounded = (promise) => Promise.race([promise, new Promise((_, reject) => {
      if (controller.signal.aborted) return reject(new Error('Pi request timed out'));
      controller.signal.addEventListener('abort', () => reject(new Error('Pi request timed out')), { once: true });
    })]);
    try {
      const credential = await bounded(credentials(s.piProvider, model, controller.signal));
      const tools = [];
      for (const [namespace, spec] of Object.entries(turn.servers)) {
        const pending = connect(spec);
        pending.then((client) => { if (controller.signal.aborted) client.close(); }).catch(() => {});
        const client = await bounded(pending); clients.push(client);
        let cursor;
        do {
          const page = await bounded(client.listTools(cursor ? { cursor } : {}));
          for (const tool of page.tools) {
            if (namespace === 'admin' && tool.name === 'continue_in_app') continue;
            tools.push({ name: `mcp__${namespace}__${tool.name}`, label: tool.name, description: tool.description || tool.name, parameters: tool.inputSchema,
              execute: async (_, args, signal) => {
                toolsUsed.push(namespace === 'admin' ? `admin.${tool.name}` : tool.name);
                const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal });
                if (result.isError) throw new Error(JSON.stringify(result.content));
                return { content: result.content.filter((c) => c.type === 'text' || c.type === 'image').map((c) => c.type === 'image' ? { type: 'image', data: c.data, mimeType: c.mimeType } : c), details: {} };
              } });
          }
          cursor = page.nextCursor;
        } while (cursor);
      }
      const id = /^pi:[0-9a-f-]{36}$/.test(sid || '') ? sid : `pi:${randomUUID()}`;
      const file = `${dir}/${id.slice(3)}.json`;
      const stored = sid ? load(file) : {};
      const history = stored.provider === s.piProvider && stored.model === s.piModel ? (stored.messages || []).filter((m) => m.role !== 'system') : [];
      agent = new AgentClass({ streamFn: streamSimple, initialState: { model: credential.model, systemPrompt: `${systemPrompt}\nThis is a Pi session, not Claude Code. Claude app handover and shell/files tools are unavailable.`, tools, messages: history, thinkingLevel: model.reasoning ? ({ default: 'off' }[s.effort] || s.effort || 'off') : 'off' }, getApiKey: () => credential.key, toolExecution: 'parallel' });
      await bounded(agent.prompt(await bounded(Promise.resolve(text))));
      if (timedOut) throw new Error('Pi request timed out');
      const last = agent.state.messages.findLast((m) => m.role === 'assistant');
      if (!last || ['error', 'aborted'].includes(last.stopReason)) throw new Error(last?.errorMessage || 'Pi returned no answer');
      save(file, { sid: id, provider: s.piProvider, model: s.piModel, updated: Date.now(), messages: agent.state.messages });
      return { sid: id, text: last.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim(), tools: toolsUsed, ms: Date.now() - started, grant: turn.grant };
    } finally { clearTimeout(timer); agent?.abort(); await Promise.allSettled(clients.map((c) => c.close())); }
  }
  function conversations() {
    return readdirSync(dir).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f)).map((f) => {
      const h = load(`${dir}/${f}`);
      const said = (h.messages || []).filter((m) => m.role === 'user').map((m) => m.content);
      return { sid: h.sid, updated: new Date(h.updated).toISOString(), backend: 'pi', provider: h.provider, model: h.model, userMessages: said };
    }).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 50);
  }
  return { conversations, run, status, setKey, startLogin, code, cancelLogin };
}
