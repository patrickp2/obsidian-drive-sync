export const OFFLINE_MESSAGE = 'Offline · changes saved locally';

export class NetworkUnavailable extends Error {
  constructor() { super('Could not reach Google. Changes remain saved locally.'); }
}
export class RequestCooldown extends Error {
  constructor(readonly until: number) { super('Google requests are waiting before retrying.'); }
}

/** Connectivity is a hint. A deliberate manual check may probe a stale offline signal. */
export class NetworkAccess {
  private probe?: symbol;
  retryAfter = 0;
  failures = 0;
  lastFailureWasNetwork = false;
  constructor(private readonly readOnline: () => boolean, private readonly now = Date.now) {}
  get offline(): boolean { return !this.readOnline() && !this.probe; }
  manualProbe(): () => void {
    const probe = this.probe = Symbol();
    return () => { if (this.probe === probe) this.probe = undefined; };
  }
  suspend(): void { this.probe = undefined; }
  assertAvailable(): void {
    if (this.offline) throw new NetworkUnavailable();
    if (this.now() < this.retryAfter) throw new RequestCooldown(this.retryAfter);
  }
  observe(status: number, headers: Record<string, string>): void {
    this.lastFailureWasNetwork = false;
    if (status < 400) return;
    const value = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1]?.trim();
    const until = value && /^\d+$/.test(value) ? this.now() + Number(value) * 1000 : value ? Date.parse(value) : NaN;
    if (Number.isFinite(until)) this.retryAfter = Math.max(this.retryAfter, until);
    if (status === 429 || status === 503) this.retryAfter = Math.max(this.retryAfter, this.now() + 30_000);
  }
  async request<T>(work: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    try { return await work(); }
    catch { this.failures++; this.lastFailureWasNetwork = true; throw new NetworkUnavailable(); }
  }
}
