import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransferBarrier, VALIDATION_MANIFEST, validateFixture } from '../src/validation';
import { fingerprint } from '../src/content';
test('transfer barrier only holds successful Drive content and cancellation rejects an uncheckpointed result', async () => {
  const gate = new TransferBarrier(); gate.arm('upload');
  await gate.after({ url: 'https://www.googleapis.com/drive/v3/files/a', method: 'GET' }, 200);
  await gate.after({ url: 'https://www.googleapis.com/upload/drive/v2/files/a', method: 'PUT' }, 412);
  assert.match(gate.status, /Armed/);
  const held = gate.after({ url: 'https://www.googleapis.com/upload/drive/v2/files/a', method: 'PUT' }, 200);
  assert.match(gate.status, /Held upload/); const failure = assert.rejects(held, /interruption/); gate.stop(); await failure;
  gate.arm('download');
  const downloaded = gate.after({ url: 'https://www.googleapis.com/drive/v3/files/a?alt=media', method: 'GET' }, 200);
  assert.match(gate.status, /Held download/); gate.release(); await downloaded;
});
test('synthetic manifest verifies exact bytes and rejects missing, changed, duplicate and unsafe paths', async () => {
  const p = 'Drive Sync validation/a.md'; const bytes = new TextEncoder().encode('synthetic bytes').buffer;
  let files = [p, VALIDATION_MANIFEST]; let expected = await fingerprint(bytes);
  const reader = { read: async () => JSON.stringify({ kind: 'drive-sync-synthetic-validation-v1', files: { [p]: expected } }), readBinary: async () => bytes, list: () => files };
  assert.match(await validateFixture(reader), /PASS: 1 files/);
  files = []; await assert.rejects(validateFixture(reader), /Missing/);
  files = [p, 'Drive Sync validation/a (conflict x).md']; await assert.rejects(validateFixture(reader), /unexpected/);
  files = [p]; expected = '0'.repeat(64); await assert.rejects(validateFixture(reader), /mismatch/);
  await assert.rejects(validateFixture({ ...reader, read: async () => JSON.stringify({kind:'drive-sync-synthetic-validation-v1',files:{'Drive Sync validation/../secret':'0'.repeat(64)}}) }), /Invalid/);
});
