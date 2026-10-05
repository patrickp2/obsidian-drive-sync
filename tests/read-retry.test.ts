import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryRead } from '../src/read-retry';

test('transient read failures retry, while uncertain writes are never replayed', async () => {
  let calls = 0; const delays: number[] = [];
  assert.equal(await retryRead('GET', async () => { if (++calls < 3) throw new Error('Connection lost'); return 'bytes'; }, () => true, async ms => { delays.push(ms); }), 'bytes');
  assert.equal(calls, 3); assert.deepEqual(delays, [250, 1000]);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    calls = 0;
    await assert.rejects(retryRead(method, async () => { calls++; throw new Error('Uncertain outcome'); }, () => true, async () => { throw new Error('Unexpected retry'); }), /Uncertain outcome/);
    assert.equal(calls, 1);
  }
});
test('read retry is bounded, stops after unload, and does not retry HTTP responses', async () => {
  let calls = 0;
  await assert.rejects(retryRead('GET', async () => { calls++; throw new Error('Offline'); }, () => true, async () => {}), /Offline/);
  assert.equal(calls, 3);
  let active = true; calls = 0;
  await assert.rejects(retryRead('GET', async () => { calls++; throw new Error('Offline'); }, () => active, async () => { active = false; }), /unloaded/);
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(await retryRead('GET', async () => { calls++; return 401; }, () => true, async () => {}), 401);
  assert.equal(calls, 1);
});
