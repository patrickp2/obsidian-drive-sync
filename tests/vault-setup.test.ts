import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultSetup, projectConfig, type SetupChannel, type SetupPeer } from '../src/vault-setup';
const config = { clientId: 'synthetic.apps.googleusercontent.com', clientSecret: 'synthetic-project-secret' };
class Bus {
  channels = new Set<SetupChannel>(); messages: unknown[] = [];
  intercept?: (message: any) => unknown;
  channel(): SetupChannel {
    const ch: SetupChannel = { onmessage: null, postMessage: value => {
      this.messages.push(structuredClone(value));
      const msg = this.intercept ? this.intercept(structuredClone(value)) : value;
      if (!msg) return;
      for (const target of this.channels) if (target !== ch) queueMicrotask(() => target.onmessage?.(new MessageEvent('message', { data: structuredClone(msg) })));
    }, close: () => { this.channels.delete(ch); } };
    this.channels.add(ch); return ch;
  }
}
const discover = (receiver: VaultSetup) => new Promise<SetupPeer>(resolve => receiver.discover(resolve));
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
test('open-vault setup encrypts configuration, compares codes, and excludes tokens, folder and baseline', async () => {
  const bus = new Bus(); let approvalCode = '', receiverCode = ''; let approved = false;
  const source = new VaultSetup(bus.channel(), 'Work', () => true, () => {
    assert.equal(approved, true);
    return { ...config, folderId: 'never-transfer', refreshToken: 'never-transfer-token', syncState: 'never-transfer-state' };
  }, async (peer, code) => { assert.equal(peer.name, 'Personal'); approvalCode = code; approved = true; return true; });
  const target = new VaultSetup(bus.channel(), 'Personal', () => false, () => config, async () => false);
  try {
    const peer = await discover(target); assert.equal(peer.id, source.id);
    assert.deepEqual(await target.request(peer, c => { receiverCode = c; }), config);
    assert.equal(receiverCode, approvalCode); assert.match(receiverCode, /^[A-F0-9]{4} [A-F0-9]{4}$/);
    const wire = JSON.stringify(bus.messages);
    assert.equal(wire.includes(config.clientSecret), false); assert.equal(wire.includes(config.clientId), false);
    assert.equal(wire.includes('never-transfer'), false);
  } finally { source.close(); target.close(); }
});
test('cancel and unload abort source approval without exporting any configuration', async () => {
  for (const close of [false, true]) {
    const bus = new Bus(); let entered = false, aborted = false, read = false;
    const source = new VaultSetup(bus.channel(), 'Work', () => true, () => { read = true; return config; }, async (_p, _c, signal) => {
      entered = true; return new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(false); }, { once: true }));
    });
    const target = new VaultSetup(bus.channel(), 'Personal', () => false, () => config, async () => false);
    try {
      const peer = await discover(target); const request = target.request(peer, () => {});
      const rejected = assert.rejects(request, /cancelled|expired/);
      while (!entered) await tick();
      if (close) target.close(); else target.cancel();
      await rejected; await tick(); assert.equal(aborted, true); assert.equal(read, false);
      assert.equal(bus.messages.some((m: any) => m.type === 'result'), false);
    } finally { source.close(); target.close(); }
  }
});
test('declined and expired setup leave no result', async () => {
  const bus = new Bus(); let read = false;
  const source = new VaultSetup(bus.channel(), 'Work', () => true, () => { read = true; return config; }, async () => false, 100);
  const target = new VaultSetup(bus.channel(), 'Personal', () => false, () => config, async () => false, 100);
  try {
    await assert.rejects(target.request(await discover(target), () => {}), /cancelled|expired/);
    assert.equal(read, false);
    await assert.rejects(target.request({ id: crypto.randomUUID(), name: 'Closed vault' }, () => {}), /expired/);
  } finally { source.close(); target.close(); }
});
test('tampered ciphertext and replayed responses cannot complete another request', async () => {
  const bus = new Bus(); let original: unknown;
  const source = new VaultSetup(bus.channel(), 'Work', () => true, () => config, async () => true, 100);
  const target = new VaultSetup(bus.channel(), 'Personal', () => false, () => config, async () => false, 100);
  try {
    const peer = await discover(target);
    bus.intercept = (m: any) => { if (m.type === 'result') { original = structuredClone(m); m.ciphertext[0] ^= 1; } return m; };
    await assert.rejects(target.request(peer, () => {}), /expired/);
    bus.intercept = (m: any) => m.type === 'result' ? original : m;
    await assert.rejects(target.request(peer, () => {}), /expired/);
  } finally { source.close(); target.close(); }
});
test('project-only import never accepts account state and pending key generation can be cancelled', async () => {
  assert.deepEqual(projectConfig({ ...config, folderId: 'remote', accessToken: 'token' }), config);
  const bus = new Bus(); const target = new VaultSetup(bus.channel(), 'Personal', () => false, () => config, async () => false);
  const result = target.request({ id: crypto.randomUUID(), name: 'Work' }, () => {}); target.cancel();
  await assert.rejects(result, /cancelled/); assert.equal(bus.messages.length, 0); target.close();
});
