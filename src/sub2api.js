// Thin client over the sub2api admin API.
//
// The GUI hands us the operator's own JWT, so every call here runs with the
// operator's permissions and lands in sub2api's audit log — the gateway never
// holds a credential of its own.
//
// Two contracts matter:
//   * GET /admin/accounts/:id returns credentials with sensitive sub-keys
//     (api_key / token / cookie …) stripped, everything else intact.
//   * PUT /admin/accounts/:id is a merge that keeps sensitive sub-keys from the
//     stored row but replaces *non-sensitive* ones wholesale. So a base_url flip
//     must resend the redacted credentials map, or model_mapping and friends
//     would be dropped on the floor.

import { get as getConfig } from './config.js';

class Sub2APIError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'Sub2APIError';
    this.status = status;
    this.body = body;
  }
}

function baseUrl() {
  return getConfig().admin.sub2api_base.replace(/\/+$/, '');
}

async function call(path, { token, method = 'GET', body } = {}) {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }

  if (!res.ok) {
    const message = parsed?.message || parsed?.error || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Sub2APIError(message, res.status, parsed);
  }
  if (parsed && typeof parsed === 'object' && 'code' in parsed && parsed.code !== 0) {
    throw new Sub2APIError(parsed.message || `code ${parsed.code}`, res.status, parsed);
  }
  return parsed?.data ?? parsed;
}

export async function listAccounts({ token, page = 1, pageSize = 100, platform, type, search } = {}) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (platform) params.set('platform', platform);
  if (type) params.set('type', type);
  if (search) params.set('search', search);
  const data = await call(`/api/v1/admin/accounts?${params.toString()}`, { token });
  return Array.isArray(data?.items) ? data.items : [];
}

export async function getAccount({ token, id }) {
  return call(`/api/v1/admin/accounts/${encodeURIComponent(id)}`, { token });
}

/** Read the live base URL of one account. */
export async function readBaseUrl({ token, id }) {
  const account = await getAccount({ token, id });
  const credentials = account?.credentials ?? {};
  const value = credentials.base_url ?? credentials.api_base ?? null;
  return { account, credentials, baseUrl: value };
}

/**
 * Point one account at a new base URL, keeping every other credential intact.
 * @returns {Promise<{before: string|null, after: string}>}
 */
export async function setBaseUrl({ token, id, baseUrl: nextBaseUrl }) {
  const { credentials, baseUrl: before } = await readBaseUrl({ token, id });
  if (!credentials || typeof credentials !== 'object') {
    throw new Sub2APIError('account has no credentials object', 0, null);
  }
  if (before === nextBaseUrl) return { before, after: nextBaseUrl, unchanged: true };

  const patched = { ...credentials, base_url: nextBaseUrl };
  await call(`/api/v1/admin/accounts/${encodeURIComponent(id)}`, {
    token,
    method: 'PUT',
    body: { credentials: patched },
  });
  return { before, after: nextBaseUrl, unchanged: false };
}

export { Sub2APIError };
