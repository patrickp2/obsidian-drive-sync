import { CALLBACK_URL, DRIVE_SCOPE, VAULT_ID_PATTERN, type AuthCallback } from './protocol';

export interface ClientConfig { clientId: string; clientSecret: string }
export interface SecretStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  clear(key: string): void;
}
export interface HttpResponse { status: number; json: unknown }
export type Transport = (url: string, body: URLSearchParams) => Promise<HttpResponse>;
export type AuthStatus = 'disconnected' | 'awaiting-browser' | 'connecting' | 'connected' | 'refreshing' | 'retrying' | 'test-complete' | 'needs-reconnect';
export interface AuthState { status: AuthStatus; message: string }
interface PendingLogin { state: string; verifier: string; createdAt: number; client: ClientConfig; verifyPkce?: 'wrong' | 'missing' }
interface Grant { clientId: string; refreshToken: string; scope: string }

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const LOGIN_TTL_MS = 10 * 60 * 1000;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function randomValue(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response from Google.');
  return value as Record<string, unknown>;
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 16384) throw new Error('Incomplete response from Google.');
  return value;
}

export class AuthSession {
  state: AuthState = { status: 'disconnected', message: 'Not connected.' };
  private pending: PendingLogin | null = null;
  private accessToken: string | null = null;
  private expiresAt = 0;
  private generation = 0;
  private refreshInFlight: Promise<void> | null = null;
  private exchangeInFlight = false;
  private stopped = false;
  private retryAt = 0;
  private retryDelay = 30_000;
  constructor(private readonly secrets: SecretStore, private readonly key: string,
    private readonly transport: Transport, private readonly getClient: () => ClientConfig,
    private readonly changed: (state: AuthState) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly getVaultId: () => string | undefined = () => undefined) {}

  private publish(status: AuthStatus, message: string): void {
    this.state = { status, message };
    this.changed(this.state);
  }
  private client(): ClientConfig {
    const result = this.getClient();
    if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(result.clientId) || !result.clientSecret.trim()) {
      throw new Error('Configure your Google web client ID and client secret first.');
    }
    return result;
  }
  private grant(): Grant | null {
    const raw = this.secrets.get(this.key);
    if (!raw) return null;
    try {
      const data = object(JSON.parse(raw));
      return { clientId: requiredString(data.clientId), refreshToken: requiredString(data.refreshToken), scope: requiredString(data.scope) };
    } catch { throw new Error('Saved connection is invalid. Disconnect and reconnect Google.'); }
  }
  async restore(): Promise<void> {
    try {
      if (this.grant()) await this.refresh();
    } catch {
      if (!['retrying', 'needs-reconnect'].includes(this.state.status)) this.publish('needs-reconnect', 'Could not restore Google access. Check your connection settings.');
    }
  }
  async begin(verifyPkce?: 'wrong' | 'missing'): Promise<string> {
    if (this.stopped || this.exchangeInFlight || this.refreshInFlight) throw new Error('Wait for the current connection request to finish.');
    const client = this.client();
    const generation = ++this.generation;
    this.pending = null;
    const vaultId = this.getVaultId();
    const state = randomValue() + (vaultId && VAULT_ID_PATTERN.test(vaultId) ? `.${vaultId}` : '');
    const verifier = randomValue();
    const challenge = await pkceChallenge(verifier);
    if (this.stopped || generation !== this.generation) throw new Error('Sign-in was cancelled.');
    this.pending = { state, verifier, createdAt: this.now(), client, verifyPkce };
    const params = new URLSearchParams({ client_id: client.clientId, redirect_uri: CALLBACK_URL,
      response_type: 'code', scope: DRIVE_SCOPE, state, code_challenge: challenge,
      code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' });
    this.publish('awaiting-browser', 'Finish connecting in your browser.');
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }
  async complete(response: AuthCallback): Promise<void> {
    const pending = this.pending;
    if (this.stopped || !pending || response.state !== pending.state) {
      throw new Error('This sign-in does not match a pending request on this device.');
    }
    // Consume before the first asynchronous operation: replay is rejected even
    // while a token exchange is in flight, or when its outcome is uncertain.
    this.pending = null;
    if (this.now() - pending.createdAt >= LOGIN_TTL_MS || this.now() < pending.createdAt) {
      this.publish('needs-reconnect', 'Sign-in expired. Start again.');
      throw new Error('Sign-in expired. Start again.');
    }
    if (response.error) {
      this.publish('needs-reconnect', response.error === 'access_denied' ? 'Google access was declined.' : 'Google sign-in failed. Try again.');
      return;
    }
    let current: ClientConfig;
    try {
      current = this.client();
      if (current.clientId !== pending.client.clientId || current.clientSecret !== pending.client.clientSecret) throw new Error();
    } catch {
      this.publish('needs-reconnect', 'Google configuration changed. Start sign-in again.');
      throw new Error('Google configuration changed. Start sign-in again.');
    }
    const generation = this.generation;
    this.exchangeInFlight = true;
    this.publish('connecting', 'Checking your Google connection.');
    let pkceStage = 'starting checks';
    try {
      const exchangeBody = new URLSearchParams({
        client_id: current.clientId, client_secret: current.clientSecret, code: response.code!,
        code_verifier: pending.verifier, grant_type: 'authorization_code', redirect_uri: CALLBACK_URL
      });
      if (pending.verifyPkce) {
        const mode = pending.verifyPkce;
        pkceStage = `${mode} verifier rejection`;
        const probe = new URLSearchParams(exchangeBody);
        if (mode === 'wrong') probe.set('code_verifier', randomValue());
        else probe.delete('code_verifier');
        const rejected = await this.transport(TOKEN_URL, probe);
        if (this.stopped || generation !== this.generation) return;
        if (rejected.status === 200) {
          pkceStage = `unexpected token issued for ${mode} verifier`;
          const token = requiredString(object(rejected.json).access_token);
          await this.transport(REVOKE_URL, new URLSearchParams({ token }));
          this.secrets.clear(this.key);
          this.accessToken = null;
          throw new Error('PKCE probe unexpectedly succeeded.');
        }
        const rejection = object(rejected.json);
        // Only report a passed test for a verifier-specific rejection. A generic
        // invalid/used code, network failure, or client error is inconclusive.
        if (rejected.status !== 400 || !['invalid_grant', 'invalid_request'].includes(String(rejection.error)) ||
            typeof rejection.error_description !== 'string' || !/verifier|code.challenge|pkce/i.test(rejection.error_description)) {
          throw new Error('PKCE rejection could not be established.');
        }
        this.publish('test-complete', `Google rejected the ${mode} PKCE verifier. Test passed; no new token saved.`);
        return;
      }
      pkceStage = 'correct verifier exchange';
      const result = await this.transport(TOKEN_URL, exchangeBody);
      if (this.stopped || generation !== this.generation) return;
      // Never carry a previous account's refresh grant into a new login.
      this.accept(result, current.clientId);

    } catch {
      const message = pending.verifyPkce ? `PKCE verification failed or was inconclusive at: ${pkceStage}. Reconnect before further testing.` : 'Could not complete sign-in. Start again.';
      if (!this.stopped && generation === this.generation) this.publish('needs-reconnect', message);
      throw new Error(message);
    } finally { this.exchangeInFlight = false; }
  }
  private accept(response: HttpResponse, clientId: string, previous?: Grant): void {
    if (response.status !== 200) throw new Error('Google rejected the connection request.');
    const data = object(response.json);
    const token = requiredString(data.access_token);
    if (data.token_type !== 'Bearer' || typeof data.expires_in !== 'number' ||
        !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Invalid Google token response.');
    const refreshToken = data.refresh_token === undefined && previous ? previous.refreshToken : requiredString(data.refresh_token);
    const scope = data.scope === undefined && previous ? previous.scope : requiredString(data.scope);
    if (!scope.split(' ').includes(DRIVE_SCOPE)) throw new Error('Required Google Drive permission was not granted.');
    const value = JSON.stringify({ clientId, refreshToken, scope } satisfies Grant);
    this.secrets.set(this.key, value);
    if (this.secrets.get(this.key) !== value) throw new Error('Could not retain the Google connection.');
    this.retryAt = 0;
    this.retryDelay = 30_000;
    this.accessToken = token;
    this.expiresAt = this.now() + data.expires_in * 1000;
    this.publish('connected', previous ? 'Google access refreshed successfully.' : 'Connected to Google.');
  }
  refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const operation = this.refreshOnce();
    this.refreshInFlight = operation;
    void operation.finally(() => { if (this.refreshInFlight === operation) this.refreshInFlight = null; }).catch(() => {});
    return operation;
  }
  private async refreshOnce(): Promise<void> {
    if (this.stopped || this.pending || this.exchangeInFlight) throw new Error('Finish the current sign-in first.');
    const grant = this.grant();
    const client = this.client();
    if (!grant || grant.clientId !== client.clientId) throw new Error('Connect Google on this device first.');
    if (!grant.scope.split(' ').includes(DRIVE_SCOPE)) {
      this.accessToken = null;
      this.publish('needs-reconnect', 'Reconnect Google to allow automatic syncing of files added in Drive.');
      throw new Error(this.state.message);
    }
    const generation = this.generation;
    this.publish('refreshing', 'Refreshing Google access.');
    try {
      const result = await this.transport(TOKEN_URL, new URLSearchParams({
        client_id: client.clientId, client_secret: client.clientSecret,
        refresh_token: grant.refreshToken, grant_type: 'refresh_token'
      }));
      if (this.stopped || generation !== this.generation) return;
      if (result.status === 400 && object(result.json).error === 'invalid_grant') {
        this.secrets.clear(this.key);
        this.accessToken = null;
        this.publish('needs-reconnect', 'Google access expired or was revoked. Reconnect to continue.');
        return;
      }
      this.accept(result, client.clientId, grant);
    } catch {
      if (!this.stopped && generation === this.generation) {
        this.retryAt = this.now() + this.retryDelay;
        this.retryDelay = Math.min(this.retryDelay * 2, 5 * 60_000);
        this.publish('retrying', 'Could not refresh Google access. Retrying automatically.');
      }
      throw new Error('Could not refresh Google access. Check your connection and try again.');
    }
  }
  async refreshIfNeeded(): Promise<void> {
    if ((this.state.status === 'connected' && this.expiresAt - this.now() < 60_000) ||
        (this.state.status === 'retrying' && this.now() >= this.retryAt)) await this.refresh();
  }
  async tokenForDrive(): Promise<string> {
    if (this.stopped || this.pending || this.exchangeInFlight) throw new Error('Finish connecting Google first.');
    if (!this.accessToken || this.expiresAt - this.now() < 60_000) await this.refresh();
    if (this.stopped || this.state.status !== 'connected' || !this.accessToken || this.expiresAt <= this.now()) {
      throw new Error('A working Google connection is required.');
    }
    return this.accessToken;
  }
  async disconnect(): Promise<void> {
    ++this.generation;
    this.pending = null;
    const token = this.grant()?.refreshToken ?? this.accessToken;
    this.accessToken = null;
    this.expiresAt = 0;
    this.secrets.clear(this.key);
    this.publish('disconnected', 'Disconnected on this device.');
    if (token) {
      try {
        const response = await this.transport(REVOKE_URL, new URLSearchParams({ token }));
        if (response.status !== 200) throw new Error();
      } catch {
        throw new Error('Local connection cleared. Google revocation was not confirmed; remove the app in your Google Account connections if needed.');
      }
    }
  }
  stop(): void {
    this.stopped = true;
    ++this.generation;
    this.pending = null;
    this.accessToken = null;
  }
}
