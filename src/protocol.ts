export const CALLBACK_URL = 'https://patrickp2.github.io/obsidian-drive-sync/';
export const PROTOCOL_ACTION = 'drive-sync-auth';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type AuthCallback = { state: string; code: string; error?: never } |
  { state: string; error: 'access_denied' | 'authorization_failed'; code?: never };

// Shared by the static page and plugin. Never reflect arbitrary error descriptions,
// redirect targets, or additional Google response parameters into Obsidian.
export function parseCallback(params: URLSearchParams): AuthCallback {
  for (const key of ['state', 'code', 'error', 'iss']) {
    if (params.getAll(key).length > 1) throw new Error('Invalid sign-in response.');
  }
  const state = params.get('state') ?? '';
  if (!STATE_PATTERN.test(state)) throw new Error('Invalid sign-in state.');
  const issuer = params.get('iss');
  if (issuer !== null && issuer !== 'https://accounts.google.com') {
    throw new Error('Invalid sign-in issuer.');
  }
  const code = params.get('code');
  const error = params.get('error');
  if (code !== null && error !== null) throw new Error('Ambiguous sign-in response.');
  if (error !== null) {
    if (!error) throw new Error('Invalid sign-in response.');
    return { state, error: error === 'access_denied' ? 'access_denied' : 'authorization_failed' };
  }
  if (!code || code.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(code)) {
    throw new Error('Missing or invalid authorization code.');
  }
  return { state, code };
}

export function callbackUri(response: AuthCallback): string {
  const params = new URLSearchParams({ state: response.state });
  if (response.code) params.set('code', response.code);
  else params.set('error', response.error!);
  return `obsidian://${PROTOCOL_ACTION}?${params}`;
}

export function parseManualCallback(value: string): AuthCallback {
  const url = new URL(value.trim());
  if (url.protocol !== 'obsidian:' || url.hostname !== PROTOCOL_ACTION ||
      url.username || url.password || url.port || url.pathname || url.hash) {
    throw new Error('Paste the return link from the sign-in page.');
  }
  return parseCallback(url.searchParams);
}
