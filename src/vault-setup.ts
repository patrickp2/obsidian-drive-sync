import { validateConfig } from './pairing';
import type { ClientConfig } from './auth';

export interface SetupPeer { id: string; name: string }
export interface SetupChannel { postMessage(value: unknown): void; onmessage: ((event: MessageEvent) => void) | null; close(): void }
interface Identity { pair: CryptoKeyPair; publicKey: number[] }
interface Exchange { key: CryptoKey; aad: Uint8Array<ArrayBuffer>; code: string }
const bytes = (value: string) => new TextEncoder().encode(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const name = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const raw = (value: unknown, length?: number): value is number[] => Array.isArray(value) && value.length <= 4096 && (!length || value.length === length) && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
export function projectConfig(value: unknown): ClientConfig {
  const { clientId, clientSecret } = validateConfig(value);
  return { clientId, clientSecret };
}
async function identity(): Promise<Identity> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  return { pair, publicKey: Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))) };
}
async function exchange(local: Identity, remote: number[], transcript: unknown): Promise<Exchange> {
  const publicKey = await crypto.subtle.importKey('raw', new Uint8Array(remote), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const key = await crypto.subtle.deriveKey({ name: 'ECDH', public: publicKey }, local.pair.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const aad = bytes(JSON.stringify(transcript));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', aad));
  const code = Array.from(digest.slice(0, 4), n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { key, aad, code: `${code.slice(0, 4)} ${code.slice(4)}` };
}
/** Same-computer, same-origin discovery. Secrets travel only as one-use encrypted responses. */
export class VaultSetup {
  readonly id = crypto.randomUUID();
  private closed = false;
  private generation = 0;
  private outgoing?: { request: string; peer: string; abort: AbortController };
  private incoming?: { request: string; peer: SetupPeer; identity: Identity; ready?: Promise<Exchange>; offered: boolean;
    timer: ReturnType<typeof setTimeout>; resolve: (value: ClientConfig) => void; reject: (error: Error) => void; code: (value: string) => void };
  private discovery?: { nonce: string; found: (peer: SetupPeer) => void };
  constructor(private readonly channel: SetupChannel, readonly vaultName: string,
    private readonly available: () => boolean, private readonly config: () => ClientConfig,
    private readonly approve: (peer: SetupPeer, code: string, signal: AbortSignal) => Promise<boolean>,
    private readonly ttl = 120_000) {
    if (!name(vaultName)) throw new Error('Unsupported vault name.');
    channel.onmessage = event => { void this.receive(event.data).catch(() => { /* Ignore malformed or unauthenticated messages. */ }); };
  }
  discover(found: (peer: SetupPeer) => void): void {
    this.discovery = { nonce: crypto.randomUUID(), found };
    this.send({ type: 'discover', nonce: this.discovery.nonce });
  }
  stopDiscovery(): void { this.discovery = undefined; }
  async request(peer: SetupPeer, code: (value: string) => void): Promise<ClientConfig> {
    if (this.closed || this.incoming || !uuid(peer.id) || !name(peer.name) || peer.id === this.id) throw new Error('Setup is unavailable or already running.');
    const generation = ++this.generation;
    const request = crypto.randomUUID(); const keys = await identity();
    if (this.closed || this.incoming || generation !== this.generation) throw new Error('Setup was cancelled.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(), this.ttl);
      this.incoming = { request, peer, identity: keys, offered: false, timer, resolve, reject, code };
      this.send({ type: 'request', to: peer.id, request, name: this.vaultName, publicKey: keys.publicKey });
    });
  }
  cancel(): void {
    this.generation++;
    const pending = this.incoming; if (!pending) return;
    this.incoming = undefined; clearTimeout(pending.timer);
    this.send({ type: 'cancel', to: pending.peer.id, request: pending.request });
    pending.reject(new Error('Setup cancelled or expired. Try again with both vaults open.'));
  }
  close(): void {
    this.cancel(); this.outgoing?.abort.abort(); this.outgoing = undefined;
    this.stopDiscovery(); this.closed = true; this.channel.onmessage = null; this.channel.close();
  }
  private send(value: Record<string, unknown>): void { if (!this.closed) this.channel.postMessage({ ...value, from: this.id }); }
  private async receive(value: unknown): Promise<void> {
    if (this.closed || !value || typeof value !== 'object') return;
    const m = value as Record<string, unknown>;
    if (!uuid(m.from) || m.from === this.id) return;
    if (m.type === 'discover' && uuid(m.nonce) && this.available()) {
      this.send({ type: 'hello', to: m.from, nonce: m.nonce, name: this.vaultName }); return;
    }
    if (m.to !== this.id) return;
    if (m.type === 'hello' && this.discovery && this.discovery.nonce === m.nonce && name(m.name)) {
      this.discovery.found({ id: m.from, name: m.name }); return;
    }
    if (!uuid(m.request)) return;
    if (m.type === 'cancel' && this.outgoing?.request === m.request && this.outgoing.peer === m.from) { this.outgoing.abort.abort(); return; }
    if (m.type === 'request' && !this.outgoing && name(m.name) && raw(m.publicKey, 65) && this.available()) {
      const active = { request: m.request, peer: m.from, abort: new AbortController() }; this.outgoing = active;
      const timer = setTimeout(() => active.abort.abort(), this.ttl);
      try {
        const local = await identity();
        const encrypted = await exchange(local, m.publicKey, ['drive-sync-vault-setup-v1', m.request, m.from, this.id, m.name, this.vaultName, m.publicKey, local.publicKey]);
        if (active.abort.signal.aborted || this.closed) return;
        this.send({ type: 'offer', to: m.from, request: m.request, publicKey: local.publicKey });
        const approved = await this.approve({ id: m.from, name: m.name }, encrypted.code, active.abort.signal);
        if (active.abort.signal.aborted || this.closed) return;
        if (!approved) { this.send({ type: 'declined', to: m.from, request: m.request }); return; }
        const configuration = projectConfig(this.config());
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encrypted.aad }, encrypted.key, bytes(JSON.stringify(configuration)));
        if (!active.abort.signal.aborted && !this.closed) this.send({ type: 'result', to: m.from, request: m.request, iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) });
      } finally { clearTimeout(timer); active.abort.abort(); if (this.outgoing === active) this.outgoing = undefined; }
      return;
    }
    const pending = this.incoming;
    if (!pending || pending.request !== m.request || pending.peer.id !== m.from) return;
    if (m.type === 'declined') { this.cancel(); return; }
    if (m.type === 'offer' && !pending.offered && raw(m.publicKey, 65)) {
      pending.offered = true;
      pending.ready = exchange(pending.identity, m.publicKey, ['drive-sync-vault-setup-v1', pending.request, this.id, pending.peer.id, this.vaultName, pending.peer.name, pending.identity.publicKey, m.publicKey]);
      const derived = await pending.ready;
      if (this.incoming !== pending) return;
      pending.code(derived.code); return;
    }
    if (m.type === 'result' && pending.ready && raw(m.iv, 12) && raw(m.ciphertext)) {
      const encrypted = await pending.ready;
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(m.iv), additionalData: encrypted.aad }, encrypted.key, new Uint8Array(m.ciphertext));
      const configuration = projectConfig(JSON.parse(new TextDecoder().decode(decrypted)));
      if (this.incoming !== pending || this.closed) return;
      this.incoming = undefined; clearTimeout(pending.timer); pending.resolve(configuration);
    }
  }
}
