import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NearbyClient, validateNearby } from '../src/nearby';
import { pairingKey, seal, unseal, validateConfig } from '../src/pairing';
const config = () => ({ address: '192.168.1.12', port: 32100, session: crypto.randomUUID(), key: pairingKey() });
test('nearby pairing accepts only private endpoints and excludes tokens', () => {
  const peer = config();
  assert.deepEqual(validateNearby(peer), peer);
  for (const invalid of [{}, { ...peer, address: '8.8.8.8' }, { ...peer, port: 80 }, { ...peer, key: 'wrong' }]) assert.throws(() => validateNearby(invalid));
  const copied = validateConfig({ clientId: 'test.apps.googleusercontent.com', clientSecret: 'synthetic', nearby: peer, refreshToken: 'never-copy' });
  assert.deepEqual(copied.nearby, peer); assert.equal('refreshToken' in copied, false);
});
test('nearby client authenticates response nonce and does not send file data or Google tokens', async () => {
  const peer = config(); let changes = 0;
  let done!: () => void; const completed = new Promise<void>(resolve => { done = resolve; });
  const client = new NearbyClient(peer, 'folder', async (url, body) => {
    assert.equal(url, `http://${peer.address}:${peer.port}/wait/${peer.session}`);
    const context = `nearby:folder:${peer.session}:wait`;
    const value = await unseal(peer.key, context, 'request', JSON.parse(body)) as { nonce: string };
    assert.deepEqual(Object.keys(value).sort(), ['client', 'nonce', 'revision', 'time']);
    return JSON.stringify(await seal(peer.key, context, 'response', { nonce: value.nonce, revision: 'new' }));
  }, () => { changes++; client.close(); done(); }, () => {});
  client.start(); await completed; assert.equal(changes, 1);
});
test('nearby client rejects replayed responses and ignores requests finishing after shutdown', async () => {
  for (const shutdown of [false, true]) {
    const peer = config(); let changes = 0;
    let done!: () => void; const completed = new Promise<void>(resolve => { done = resolve; });
    const client = new NearbyClient(peer, 'folder', async () => {
      if (shutdown) client.close();
      return JSON.stringify(await seal(peer.key, `nearby:folder:${peer.session}:wait`, 'response', { nonce: 'replayed', revision: 'new' }));
    }, () => { changes++; }, connected => { if (!connected) { done(); } });
    client.start(); await completed; client.close(); assert.equal(changes, 0);
  }
});
