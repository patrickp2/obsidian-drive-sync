import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startNearbyServer } from '../../src/nearby-server';
import { pairingKey, seal, unseal } from '../../src/pairing';

test('real nearby listener wakes on desktop and mobile events; rejects replay, wrong vault and wrong key', async t => {
  const key = pairingKey(), session = crypto.randomUUID(); let changed = 0;
  const server = await startNearbyServer('synthetic-folder', key, session, 0, () => { changed++; });
  t.after(() => server.close());
  const origin = `http://${server.config.address}:${server.config.port}`;
  const request = async (action: string, revision = '', requestKey = key, folder = 'synthetic-folder') => {
    const context = `nearby:${folder}:${session}:${action}`;
    const nonce = pairingKey();
    const body = JSON.stringify(await seal(requestKey, context, 'request', { nonce, client: crypto.randomUUID(), time: Date.now(), revision }));
    const send = () => fetch(`${origin}/${action}/${session}`, { method: 'POST', body, signal: AbortSignal.timeout(3000) });
    return { nonce, context, send };
  };
  const first = await request('wait'); const response = await first.send(); assert.equal(response.status, 200);
  const initial = await unseal(key, first.context, 'response', await response.json()) as { nonce: string; revision: string };
  assert.equal(initial.nonce, first.nonce);
  assert.equal((await first.send()).status, 403);
  assert.equal((await (await request('wait', '', pairingKey())).send()).status, 403);
  assert.equal((await (await request('wait', '', key, 'other-vault')).send()).status, 403);
  const waiting = await request('wait', initial.revision); const pending = waiting.send();
  server.publish();
  const next = await unseal(key, waiting.context, 'response', await (await pending).json()) as { revision: string };
  assert.notEqual(next.revision, initial.revision);
  for (let i = 0; i < 2; i++) assert.equal((await (await request('notify')).send()).status, 200);
  assert.equal(changed, 2, 'closely spaced mobile writes must both trigger the desktop');
});
