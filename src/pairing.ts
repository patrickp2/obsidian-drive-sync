export interface PairingConfig { clientId: string; clientSecret: string; folderId?: string }
export interface Invitation { address: string; port: number; session: string; key: string }
export interface Envelope { iv: string; ciphertext: string }
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid pairing data.');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
}
export function pairingKey(): string { return encode(crypto.getRandomValues(new Uint8Array(32))); }
export function privateAddress(value: string): boolean {
  const parts = value.split('.').map(Number);
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) && parts.every(p => p >= 0 && p <= 255) &&
    (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31));
}
export function validateInvitation(input: Record<string, string>): Invitation {
  const port = Number(input.port);
  if (!privateAddress(input.address ?? '') || !Number.isInteger(port) || port < 1024 || port > 65535 ||
      !/^[a-f0-9-]{36}$/.test(input.session ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(input.key ?? '')) {
    throw new Error('Invalid or unsupported pairing invitation.');
  }
  return { address: input.address!, port, session: input.session!, key: input.key! };
}
export function invitationLink(invitation: Invitation): string {
  return `obsidian://drive-sync-pair?${new URLSearchParams({ ...invitation, port: String(invitation.port) })}`;
}
export function parseInvitation(value: string): Invitation {
  const url = new URL(value.trim());
  if (url.protocol !== 'obsidian:' || url.hostname !== 'drive-sync-pair' || url.pathname || url.username || url.password || url.hash) {
    throw new Error('Use the pairing invitation shown on your desktop.');
  }
  for (const field of ['address', 'port', 'session', 'key']) {
    if (url.searchParams.getAll(field).length !== 1) throw new Error('Invalid pairing invitation.');
  }
  return validateInvitation(Object.fromEntries(url.searchParams));
}
export function validateConfig(value: unknown): PairingConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid desktop configuration.');
  const config = value as Record<string, unknown>;
  if (typeof config.clientId !== 'string' || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(config.clientId) ||
      typeof config.clientSecret !== 'string' || !config.clientSecret.trim() || config.clientSecret.length > 1024 ||
      (config.folderId !== undefined && (typeof config.folderId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(config.folderId)))) {
    throw new Error('Invalid desktop configuration.');
  }
  // Copy only configuration; tokens and other fields are never imported.
  return { clientId: config.clientId, clientSecret: config.clientSecret, ...(config.folderId ? { folderId: config.folderId as string } : {}) };
}
export async function seal(key: string, session: string, direction: 'request' | 'response', value: unknown): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey('raw', decode(key), 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode(`drive-sync-pair:${session}:${direction}`) }, aes, new TextEncoder().encode(JSON.stringify(value)));
  return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function unseal(key: string, session: string, direction: 'request' | 'response', envelope: Envelope): Promise<unknown> {
  try {
    if (typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 16384) throw new Error();
    const aes = await crypto.subtle.importKey('raw', decode(key), 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv),
      additionalData: new TextEncoder().encode(`drive-sync-pair:${session}:${direction}`) }, aes, decode(envelope.ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch { throw new Error('Pairing could not be authenticated. Start a new invitation.'); }
}

export async function receivePairing(invitation: Invitation,
  send: (url: string, body: string) => Promise<string>): Promise<PairingConfig> {
  const nonce = pairingKey();
  const request = await seal(invitation.key, invitation.session, 'request', { nonce });
  let response: string;
  try { response = await send(`http://${invitation.address}:${invitation.port}/pair/${invitation.session}`, JSON.stringify(request)); }
  catch { throw new Error('Could not reach your desktop. Use the same local network, keep the invitation open, and allow local-network access if prompted.'); }
  let value: unknown;
  try { value = await unseal(invitation.key, invitation.session, 'response', JSON.parse(response) as Envelope); }
  catch { throw new Error('Pairing failed or expired. Create a new desktop invitation.'); }
  if (!value || typeof value !== 'object' || (value as { nonce?: unknown }).nonce !== nonce) throw new Error('Pairing response did not match this device.');
  return validateConfig((value as { config?: unknown }).config);
}
