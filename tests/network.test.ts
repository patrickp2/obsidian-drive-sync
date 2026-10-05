import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkAccess, NetworkUnavailable, RequestCooldown } from '../src/network';
import { retryRead } from '../src/read-retry';

test('offline blocks requests; an explicit probe is scoped and can be interrupted', async () => {
  let online = false; let calls = 0;
  const network = new NetworkAccess(() => online);
  const send = () => network.request(async () => ++calls);
  await assert.rejects(send(), NetworkUnavailable); assert.equal(calls, 0);
  const finish = network.manualProbe();
  assert.equal(await send(), 1);
  network.suspend();
  await assert.rejects(send(), NetworkUnavailable);
  finish();
  online = true;
  assert.equal(await send(), 2);
});

test('going offline during a bounded read retry prevents the next native request', async () => {
  let online = true; let calls = 0;
  const network = new NetworkAccess(() => online);
  await assert.rejects(retryRead('GET', () => network.request(async () => {
    calls++; throw new Error('Lost connection');
  }), () => !network.offline, async () => { online = false; }));
  assert.equal(calls, 1);
});

test('Google cooldown survives offline/online transitions and manual probes', async () => {
  let now = 100_000; let online = true; let calls = 0;
  const network = new NetworkAccess(() => online, () => now);
  network.observe(429, { 'Retry-After': '120' });
  online = false; network.suspend(); online = true;
  const finish = network.manualProbe();
  await assert.rejects(network.request(async () => ++calls), RequestCooldown);
  now += 119_999;
  await assert.rejects(network.request(async () => ++calls), RequestCooldown);
  now++;
  assert.equal(await network.request(async () => ++calls), 1);
  finish();
  network.observe(503, { 'retry-after': new Date(now + 90_000).toUTCString() });
  assert.equal(network.retryAfter, now + 90_000);
  network.observe(200, {}); assert.equal(network.retryAfter, now + 90_000);
});
