import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriveStore, folderIdentifier } from '../src/drive';
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
    if (request.url.includes('/root?')) return reply({ id: 'root', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
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
test('existing folders and externally added files are listed only inside the chosen tree', async () => {
  const queries: string[] = [];
  const store = new DriveStore(async request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/chosen')) return reply({ id: 'chosen', name: 'Existing vault', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
    const q = url.searchParams.get('q')!; queries.push(q);
    if (q.startsWith("'chosen'")) return reply({ files: [{ id: 'sub', name: 'Notes', mimeType: 'application/vnd.google-apps.folder' }] });
    assert.ok(q.startsWith("'sub'"));
    return reply({ files: [{ id: 'external-file', name: 'added-in-drive.md', mimeType: 'text/markdown', version: '1' }] });
  }, 'chosen');
  assert.deepEqual(await store.list(), [{ id: 'external-file', path: 'Notes/added-in-drive.md', version: '1' }]);
  assert.equal(queries.length, 2);
});
test('folder browser paginates metadata and rejects read-only or trashed choices', async () => {
  let trashed = false; let writable = false;
  const send = async (request: ProbeRequest) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/folder')) return reply({ id: 'folder', mimeType: 'application/vnd.google-apps.folder', trashed, capabilities: { canAddChildren: writable } });
    assert.match(url.searchParams.get('q')!, /'root' in parents/);
    return reply(url.searchParams.has('pageToken') ? { files: [{ id: 'b', name: 'B' }] } : { files: [{ id: 'a', name: 'A' }], nextPageToken: 'next' });
  };
  assert.deepEqual(await DriveStore.childFolders(send), [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  await assert.rejects(DriveStore.folder(send, 'folder')); writable = true; trashed = true;
  await assert.rejects(DriveStore.folder(send, 'folder')); trashed = false;
  assert.equal((await DriveStore.folder(send, 'folder')).id, 'folder');
  assert.equal(folderIdentifier('https://drive.google.com/drive/u/0/folders/abc-123?usp=sharing'), 'abc-123');
  assert.throws(() => folderIdentifier('https://evil.example/folders/abc'));
  assert.throws(() => folderIdentifier('root'));
});
