import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthSession, pkceChallenge, type HttpResponse, type Transport } from '../src/auth';
import { CALLBACK_URL, DRIVE_SCOPE, callbackUri, parseCallback, parseManualCallback } from '../src/protocol';

const client = { clientId: 'synthetic-client.apps.googleusercontent.com', clientSecret: 'synthetic-client-secret' };
const success = (patch: Record<string, unknown> = {}): HttpResponse => ({ status: 200, json: {
  access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token',
  token_type: 'Bearer', expires_in: 3600, scope: DRIVE_SCOPE, ...patch
} });
function fixture() {
  const values = new Map<string, string>();
  const calls: { url: string; body: URLSearchParams }[] = [];
  let now = 100_000;
  let handler: Transport = async () => success();
  const session = new AuthSession({ get: key => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); }, clear: key => { values.delete(key); } },
  'grant', async (url, body) => { calls.push({ url, body }); return handler(url, body); },
  () => client, () => {}, () => now);
  return { values, calls, session, setHandler: (next: Transport) => { handler = next; },
    advance: (ms: number) => { now += ms; } };
}
async function authorize(f: ReturnType<typeof fixture>) {
  const url = new URL(await f.session.begin());
  await f.session.complete({ state: url.searchParams.get('state')!, code: 'synthetic-code' });
  return url;
}
test('PKCE S256 matches the RFC 7636 test vector', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
test('authorization keeps the verifier and client secret out of the browser URL', async () => {
  const f = fixture(); const url = await authorize(f);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK_URL);
  assert.equal(url.searchParams.get('scope'), DRIVE_SCOPE);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(url.searchParams.has('code_verifier'), false);
  const verifier = f.calls[0]!.body.get('code_verifier')!;
  assert.equal(await pkceChallenge(verifier), url.searchParams.get('code_challenge'));
  assert.equal(f.session.state.status, 'connected');
  assert.equal(f.values.get('grant')!.includes('synthetic-access-token'), false);
});
test('incorrect, expired, and reused state never trigger token exchange', async () => {
  const f = fixture(); const url = new URL(await f.session.begin());
  const state = url.searchParams.get('state')!;
  await assert.rejects(f.session.complete({ state: 'wrong', code: 'synthetic-code' }), /pending/);
  assert.equal(f.calls.length, 0);
  f.advance(10 * 60_000);
  await assert.rejects(f.session.complete({ state, code: 'synthetic-code' }), /expired/);
  assert.equal(f.calls.length, 0);
  const next = await authorize(f);
  await assert.rejects(f.session.complete({ state: next.searchParams.get('state')!, code: 'synthetic-code' }), /pending/);
  assert.equal(f.calls.length, 1);
});
test('replay while exchange is in flight is rejected', async () => {
  const f = fixture(); let finish!: (value: HttpResponse) => void;
  f.setHandler(() => new Promise(resolve => { finish = resolve; }));
  const state = new URL(await f.session.begin()).searchParams.get('state')!;
  const exchange = f.session.complete({ state, code: 'synthetic-code' });
  await assert.rejects(f.session.complete({ state, code: 'synthetic-code' }), /pending/);
  assert.equal(f.calls.length, 1); finish(success()); await exchange;
});
test('refresh retains the previous refresh token when Google omits it', async () => {
  const f = fixture(); await authorize(f);
  f.setHandler(async () => success({ refresh_token: undefined, scope: undefined }));
  await f.session.refresh();
  assert.equal(JSON.parse(f.values.get('grant')!).refreshToken, 'synthetic-refresh-token');
  assert.equal(f.calls[1]!.body.get('grant_type'), 'refresh_token');
  assert.equal(f.calls[1]!.body.has('code_verifier'), false);
});
test('concurrent refresh requests share one network operation', async () => {
  const f = fixture(); await authorize(f); let finish!: (value: HttpResponse) => void;
  f.setHandler(() => new Promise(resolve => { finish = resolve; }));
  const first = f.session.refresh(); const second = f.session.refresh();
  assert.equal(first, second); assert.equal(f.calls.length, 2);
  finish(success()); await first;
});
test('a revoked grant produces a reconnect state and clears the unusable grant', async () => {
  const f = fixture(); await authorize(f);
  f.setHandler(async () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'DO NOT DISPLAY PROVIDER TEXT' } }));
  await f.session.refresh(); assert.equal(f.session.state.status, 'needs-reconnect');
  assert.equal(f.values.size, 0); assert.equal(f.session.state.message.includes('PROVIDER'), false);
});
test('a failed refresh preserves the grant for a later retry', async () => {
  const f = fixture(); await authorize(f);
  f.setHandler(async () => { throw new Error('secret-response-body'); });
  await assert.rejects(f.session.refresh(), /Could not refresh/);
  assert.equal(f.values.size, 1); assert.equal(f.session.state.message.includes('secret-response'), false);
});
test('new login cannot borrow a refresh token from the previous account', async () => {
  const f = fixture(); await authorize(f);
  f.setHandler(async () => success({ refresh_token: undefined }));
  await assert.rejects(authorize(f), /Could not complete/);
  assert.equal(f.session.state.status, 'needs-reconnect');
});
test('missing permission is rejected', async () => {
  const f = fixture(); f.setHandler(async () => success({ scope: 'openid' }));
  await assert.rejects(authorize(f), /Could not complete/); assert.equal(f.values.size, 0);
});
test('disconnect during refresh prevents the late result from restoring access', async () => {
  const f = fixture(); await authorize(f); let finish!: (value: HttpResponse) => void;
  f.setHandler((url) => url.endsWith('/revoke') ? Promise.resolve({ status: 200, json: {} }) : new Promise(resolve => { finish = resolve; }));
  const pending = f.session.refresh(); await f.session.disconnect();
  finish(success()); await pending;
  assert.equal(f.values.size, 0); assert.equal(f.session.state.status, 'disconnected');
  assert.equal(f.calls.at(-1)!.url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(f.calls.at(-1)!.url.includes('token='), false);
});
test('plugin unload invalidates pending callbacks and in-flight results', async () => {
  const f = fixture(); let finish!: (value: HttpResponse) => void;
  f.setHandler(() => new Promise(resolve => { finish = resolve; }));
  const state = new URL(await f.session.begin()).searchParams.get('state')!;
  const pending = f.session.complete({ state, code: 'synthetic-code' });
  f.session.stop(); finish(success()); await pending; assert.equal(f.values.size, 0);
  await assert.rejects(f.session.complete({ state, code: 'synthetic-code' }), /pending/);
});
test('denial consumes state without token exchange', async () => {
  const f = fixture(); const state = new URL(await f.session.begin()).searchParams.get('state')!;
  await f.session.complete({ state, error: 'access_denied' }); assert.equal(f.calls.length, 0);
  await assert.rejects(f.session.complete({ state, code: 'synthetic-code' }), /pending/);
});
test('callback rejects ambiguity and strips untrusted redirect/error fields', () => {
  const state = 'a'.repeat(43);
  for (const raw of [`code=x`, `state=${state}&code=x&code=y`, `state=${state}&code=x&error=denied`,
    `state=${state}&code=x&iss=https://attacker.invalid`, `state=${state}&code=%0a`, `state=${state}&error=`]) {
    assert.throws(() => parseCallback(new URLSearchParams(raw)));
  }
  const response = parseCallback(new URLSearchParams({ state, code: 'synthetic/code', redirect: 'https://attacker.invalid' }));
  const uri = callbackUri(response); assert.equal(uri.includes('attacker'), false);
  assert.deepEqual(parseManualCallback(uri), response);
  const denied = parseCallback(new URLSearchParams({ state, error: '<script>bad</script>', error_description: '<img onerror=bad>' }));
  assert.deepEqual(denied, { state, error: 'authorization_failed' });
  assert.throws(() => parseManualCallback(`https://attacker.invalid/?state=${state}&code=x`));
  assert.throws(() => parseManualCallback(`obsidian://other-action?state=${state}&code=x`));
});

test('temporary refresh failure retries with backoff and recovers without sign-in', async () => {
  const f = fixture(); await authorize(f);
  f.setHandler(async () => { throw new Error('offline'); });
  await assert.rejects(f.session.refresh());
  assert.equal(f.session.state.status, 'retrying');
  await f.session.refreshIfNeeded(); assert.equal(f.calls.length, 2);
  f.advance(30_000); await assert.rejects(f.session.refreshIfNeeded());
  f.advance(30_000); await f.session.refreshIfNeeded(); assert.equal(f.calls.length, 3);
  f.advance(30_000); f.setHandler(async () => success());
  await f.session.refreshIfNeeded(); assert.equal(f.session.state.status, 'connected');
  assert.equal(f.calls.length, 4);
});

test('callback routes only to the vault ID bound into state', () => {
  const state = 'a'.repeat(43) + '.0123456789abcdef';
  const response = parseCallback(new URLSearchParams({state, code: 'synthetic-code', vault: 'attacker-vault', path: '/untrusted'}));
  const uri = new URL(callbackUri(response));
  assert.equal(uri.searchParams.get('vault'), '0123456789abcdef');
  assert.equal(uri.searchParams.has('path'), false);
  assert.deepEqual(parseManualCallback(uri.toString()), response);
  for (const suffix of ['.vault-name', '.0123456789abcdef.extra', '.abcd']) {
    assert.throws(() => parseCallback(new URLSearchParams({state: 'a'.repeat(43) + suffix, code: 'synthetic-code'})));
  }
});
test('routing state retains a random nonce and rejects a changed vault ID', async () => {
  const session = new AuthSession({get: () => null, set: () => {}, clear: () => {}}, 'grant',
    async () => { throw new Error('must not exchange'); }, () => client, () => {}, Date.now, () => '0123456789abcdef');
  const state = new URL(await session.begin()).searchParams.get('state')!;
  assert.match(state, /^[A-Za-z0-9_-]{43}\.0123456789abcdef$/);
  await assert.rejects(session.complete({state: state.replace('0123456789abcdef','fedcba9876543210'), code: 'synthetic-code'}), /pending/);
});

test('PKCE probes use fresh codes and require verifier-specific rejection', async () => {
  const f = fixture();
  f.setHandler(async () => ({status: 400, json: {error: 'invalid_grant', error_description: 'Invalid code_verifier'}}));
  for (const mode of ['wrong', 'missing'] as const) {
    const state = new URL(await f.session.begin(mode)).searchParams.get('state')!;
    await f.session.complete({state, code: `synthetic-${mode}-code`});
    assert.equal(f.session.state.status, 'test-complete');
  }
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.body.has('code_verifier'), true);
  assert.equal(f.calls[1]!.body.has('code_verifier'), false);
  assert.notEqual(f.calls[0]!.body.get('code'), f.calls[1]!.body.get('code'));
  assert.equal(f.values.size, 0);
});
test('generic invalid-code errors do not pass a PKCE probe', async () => {
  const f = fixture();
  f.setHandler(async () => ({status: 400, json: {error: 'invalid_grant', error_description: 'Expired code'}}));
  const state = new URL(await f.session.begin('missing')).searchParams.get('state')!;
  await assert.rejects(f.session.complete({state, code: 'synthetic-code'}), /inconclusive/);
  assert.equal(f.session.state.status, 'needs-reconnect');
});
test('PKCE probe never stores a token issued for an invalid verifier', async () => {
  const f = fixture();
  const state = new URL(await f.session.begin('wrong')).searchParams.get('state')!;
  await assert.rejects(f.session.complete({state, code: 'synthetic-code'}), /PKCE verification/);
  assert.equal(f.values.size, 0);
  assert.ok(f.calls[1]!.url.endsWith('/revoke'));
  assert.equal(f.session.state.status, 'needs-reconnect');
});

test('Drive token access refreshes expiry and refuses a revoked or stopped session', async () => {
  const f = fixture(); await authorize(f);
  assert.equal(await f.session.tokenForDrive(), 'synthetic-access-token');
  assert.equal(f.calls.length, 1);
  f.advance(3600_000);
  f.setHandler(async () => success({ access_token: 'renewed-access-token' }));
  assert.equal(await f.session.tokenForDrive(), 'renewed-access-token');
  f.advance(3600_000);
  f.setHandler(async () => ({ status: 400, json: { error: 'invalid_grant' } }));
  await assert.rejects(f.session.tokenForDrive(), /working Google connection/);
  f.session.stop();
  await assert.rejects(f.session.tokenForDrive(), /Finish connecting/);
});
