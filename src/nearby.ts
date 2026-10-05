import { pairingKey, privateAddress, seal, unseal, type Envelope } from './pairing';

export interface NearbyConfig { address: string; port: number; session: string; key: string }
export function validateNearby(value: unknown): NearbyConfig {
  const v = value as NearbyConfig;
  if (!v || typeof v.address !== 'string' || !privateAddress(v.address) || !Number.isInteger(v.port) || v.port < 1024 || v.port > 65535 ||
      !/^[a-f0-9-]{36}$/.test(v.session) || !/^[A-Za-z0-9_-]{43}$/.test(v.key)) throw new Error('Invalid nearby-device configuration.');
  return { address: v.address, port: v.port, session: v.session, key: v.key };
}
export type NearbySend = (url: string, body: string) => Promise<string>;
export interface NearbyLink { publish(): void; close(): void }
/** Authenticated local long-poll: the desktop holds the request until a write
 * occurs. No Google credentials or file data cross this connection. */
export class NearbyClient implements NearbyLink {
  private closed = false;
  private revision = '';
  private readonly client = crypto.randomUUID();
  private timer?: ReturnType<typeof setTimeout>;
  private notifying = false;
  private pending = false;
  constructor(private readonly config: NearbyConfig, private readonly folderId: string,
    private readonly send: NearbySend, private readonly changed: () => void,
    private readonly status: (connected: boolean) => void) { validateNearby(config); }
  start(): void { void this.wait(); }
  private async request(action: 'wait' | 'notify'): Promise<string> {
    const nonce = pairingKey();
    const context = `nearby:${this.folderId}:${this.config.session}:${action}`;
    const request = await seal(this.config.key, context, 'request', { nonce, time: Date.now(), client: this.client, revision: this.revision });
    const body = await this.send(`http://${this.config.address}:${this.config.port}/${action}/${this.config.session}`, JSON.stringify(request));
    const response = await unseal(this.config.key, context, 'response', JSON.parse(body) as Envelope) as { nonce?: string; revision?: string };
    if (!response || response.nonce !== nonce || typeof response.revision !== 'string' || response.revision.length > 100) throw new Error('Invalid nearby notification.');
    return response.revision;
  }
  private async wait(): Promise<void> {
    if (this.closed) return;
    let delay = 0;
    try {
      const revision = await this.request('wait');
      if (this.closed) return;
      this.status(true);
      if (revision !== this.revision) { this.revision = revision; this.changed(); }
    } catch { if (!this.closed) this.status(false); delay = 30_000; }
    if (!this.closed) this.timer = setTimeout(() => { void this.wait(); }, delay);
  }
  publish(): void {
    if (this.closed) return;
    this.pending = true;
    if (this.notifying) return;
    this.notifying = true;
    void (async () => {
      try {
        while (this.pending && !this.closed) { this.pending = false; await this.request('notify'); }
      } catch { if (!this.closed) this.status(false); }
      finally { this.notifying = false; }
    })();
  }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.status(false); }
}
