'use strict';

const projectRef = 'wospznckvryiihfzwwtn';
const backendOrigin = 'https://' + projectRef + '.supabase.co';
const siteOrigin = 'https://formora-qat.pages.dev';

function validateKey(key, role = 'anon') {
  if (!['anon', 'service_role'].includes(role) || typeof key !== 'string' || key.length > 2048) {
    throw new Error('A QAT project key with the required role is required.');
  }
  const segments = key.split('.');
  if (segments.length !== 3 || !segments.every(segment => /^[A-Za-z0-9_-]+$/.test(segment))
      || segments[2].length !== 43) throw new Error('Unsupported QAT key format.');
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch { throw new Error('Invalid QAT key metadata.'); }
  if (header?.alg !== 'HS256' || claims?.role !== role || claims?.ref !== projectRef
      || !Number.isSafeInteger(claims.exp) || claims.exp <= Date.now() / 1000) {
    throw new Error('The key does not belong to the isolated QAT project and required role.');
  }
  return key;
}

function validateBackend(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'anonKey,projectRef' || value.projectRef !== projectRef) {
    throw new Error('QAT configuration must contain only its isolated projectRef and public anonKey.');
  }
  return { projectRef, origin: backendOrigin, anonKey: validateKey(value.anonKey) };
}

module.exports = { projectRef, backendOrigin, siteOrigin, validateKey, validateBackend };