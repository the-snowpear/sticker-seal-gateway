// Admin authentication for the GUI.
//
// The sub2api panel embeds CustomPageView in an iframe and appends its own
// session JWT as `?token=`. The gateway shares the sub2api JWT secret, verifies
// the signature locally and only lets `role === "admin"` through — no second
// login, and a stale or tampered token is rejected on the spot.

import { createHmac, timingSafeEqual } from 'node:crypto';

const CLOCK_SKEW_SECONDS = 60;

function base64UrlDecode(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(data, secret) {
  return base64UrlEncode(createHmac('sha256', secret).update(data).digest());
}

/**
 * Verify an HS256 JWT.
 * @returns {{ok: true, claims: object} | {ok: false, reason: string}}
 */
export function verifyJwt(token, secret) {
  if (!secret) return { ok: false, reason: 'secret-not-configured' };
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing-token' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad-header' };
  }
  if (header.alg !== 'HS256') return { ok: false, reason: 'unsupported-alg' };

  const expected = sign(`${headerB64}.${payloadB64}`, secret);
  const given = signatureB64;
  if (expected.length !== given.length) return { ok: false, reason: 'bad-signature' };
  if (!timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given, 'utf8'))) {
    return { ok: false, reason: 'bad-signature' };
  }

  let claims;
  try {
    claims = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad-payload' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp + CLOCK_SKEW_SECONDS < now) {
    return { ok: false, reason: 'expired' };
  }
  if (claims.role !== 'admin') return { ok: false, reason: 'not-admin' };

  return { ok: true, claims };
}

/** Pull the bearer token out of a request. Accepts `?token=` as a fallback for the iframe bootstrap. */
export function tokenFromRequest(req, url) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1].trim();
  const fromQuery = url?.searchParams?.get('token');
  return fromQuery ? fromQuery.trim() : '';
}

export function authenticate(req, url, secret) {
  const token = tokenFromRequest(req, url);
  const result = verifyJwt(token, secret);
  return { ...result, token };
}
