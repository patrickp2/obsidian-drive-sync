import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriveStore } from '../src/drive';
import { StaleWrite } from '../src/sync';
import type { ProbeRequest, ProbeResponse } from '../src/drive-probe';
const reply = (value: unknown, status = 200): ProbeResponse => ({ status, text: JSON.stringify(value), headers: {} });
test('replacement uploads use the live-tested v2 PUT and never retry stale writes unconditionally', async () => {
  const calls: ProbeRequest[] = [];
  const store = new DriveStore(async request => { calls.push(request); return reply({}, 412); }, 'root');
  await assert.rejects(store.update({ id: 'file', path: 'note.md' }, 'changed', '"known"'), StaleWrite);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.method, 'PUT');
  assert.match(calls[0]!.url, /upload\/drive\/v2\/files\/file\?uploadType=media/);
  assert.equal(calls[0]!.headers?.['If-Match'], '"known"');
  await assert.rejects(store.update({ id: 'file', path: 'note.md' }, 'changed', '*'));
  assert.equal(calls.length, 1);
});
test('remote reads reject moved files and content changed during download', async () => {
  let count = 0; let moved = true;
  const store = new DriveStore(async request => {
    if (request.url.includes('alt=media')) return { status: 200, text: 'note', headers: {} };
    return reply({ etag: `"${++count}"`, title: 'note.md', parents: [{ id: moved ? 'outside-root' : 'root' }], labels: { trashed: false }, fileSize: '4' });
  }, 'root');
  await assert.rejects(store.read({ id: 'file', path: 'note.md' }), /moved/);
  moved = false;
  await assert.rejects(store.read({ id: 'file', path: 'note.md' }), StaleWrite);
});
test('complete paginated listings are required; duplicates and incomplete search fail', async () => {
  let duplicate = false; let incomplete = false;
  const store = new DriveStore(async request => {
    if (request.url.includes('/root?')) return reply({ mimeType: 'application/vnd.google-apps.folder', appProperties: { driveSyncRoot: '1' } });
    if (request.url.includes('pageToken=second')) return reply({ files: [{ id: 'b', name: duplicate ? 'a.md' : 'b.md', mimeType: 'text/markdown' }] });
    return reply({ files: [{ id: 'a', name: 'a.md', mimeType: 'text/markdown' }], nextPageToken: 'second', incompleteSearch: incomplete });
  }, 'root');
  assert.equal((await store.list()).length, 2);
  duplicate = true; await assert.rejects(store.list(), /Duplicate/);
  duplicate = false; incomplete = true; await assert.rejects(store.list(), /incomplete/);
});
test('binary multipart transfers preserve arbitrary bytes and correct MIME', async () => {
  const calls: ProbeRequest[] = [];
  const store = new DriveStore(async request => { calls.push(request); return reply({ id: 'file' }); }, 'root');
  const data = Uint8Array.of(0, 255, 128, 13, 10).buffer;
  await store.create('photo.png', data, 'file');
  const body = new Uint8Array(calls[0]!.body as ArrayBuffer);
  const marker = new TextEncoder().encode('Content-Type: image/png\r\n\r\n');
  const at = body.findIndex((_, i) => marker.every((v, j) => body[i + j] === v));
  assert.ok(at > 0); assert.deepEqual(body.slice(at + marker.length, at + marker.length + 5), new Uint8Array(data));
});
test('metadata move and trash require strong If-Match and use v2 PUT', async () => {
  const calls: ProbeRequest[] = [];
  const store = new DriveStore(async request => { calls.push(request); return reply({}, 412); }, 'root');
  await assert.rejects(store.move({ id: 'file', path: 'a.md' }, 'b.md', '"old"'), StaleWrite);
  await assert.rejects(store.trash({ id: 'file', path: 'a.md' }, '"old"'), StaleWrite);
  assert.ok(calls.every(c => c.method === 'PUT' && c.url.includes('/drive/v2/files/file') && c.headers?.['If-Match'] === '"old"'));
  assert.equal(JSON.parse(calls[1]!.body as string).labels.trashed, true);
});
test('missing permission is distinct from confirmed Drive trash', async () => {
  let status = 404;
  const store = new DriveStore(async () => reply({ trashed: true }, status), 'root');
  assert.equal(await store.missing('file'), 'unavailable'); status = 403; await assert.rejects(store.missing('file'));
  status = 200; assert.equal(await store.missing('file'), 'trashed');
});
