// Compatibility boundary for Pi 1.x provider auth. Existing auth.json remains valid.
import { builtinProviders, getBuiltinModels as getModels, getBuiltinProviders as getProviders } from '@earendil-works/pi-ai/providers/all';
import { normalizeContext } from '@earendil-works/pi-ai';
export { getModels, getProviders };
export const streamSimple = (model, context, options) => providers.get(model.provider).streamSimple(model, normalizeContext(context), options);
const providers = new Map(builtinProviders().map((p) => [p.id, p]));
export const getOAuthProvider = (id) => providers.get(id)?.auth.oauth;
export const getOAuthProviders = () => [...providers.values()].filter((p) => p.auth.oauth).map((p) => ({ id: p.id, ...p.auth.oauth }));
export async function getOAuthApiKey(id, credentials, signal) {
  const oauth = getOAuthProvider(id);
  let credential = credentials[id];
  if (!oauth || credential?.type !== 'oauth') return null;
  if (Date.now() >= credential.expires) credential = await oauth.refresh(credential, signal);
  const auth = await oauth.toAuth(credential);
  return { apiKey: auth.apiKey, auth, newCredentials: credential };
}
export function loginWithProvider(provider, callbacks) {
  return provider.login({
    signal: callbacks.signal,
    prompt: (prompt) => {
      // Prefer device authorization on HA: no localhost redirect reachable from the phone.
      if (provider.id === 'openai-codex' && prompt.type === 'select' && prompt.options.some((o) => o.id === 'device_code')) return Promise.resolve('device_code');
      return callbacks.onPrompt(prompt);
    },
    notify: (event) => {
      if (event.type === 'auth_url') callbacks.onAuth(event);
      if (event.type === 'device_code') callbacks.onAuth({ url: event.verificationUri, instructions: `Enter this code on the provider's page: ${event.userCode}` });
      if (event.type === 'info') callbacks.onProgress?.(event.message);
    },
  }, { agentName: 'claude-home', getDeviceId: callbacks.getDeviceId });
}
