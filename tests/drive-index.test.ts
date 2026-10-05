import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceIndex, loadDriveIndex, type DriveIndex } from '../src/drive-index';
import { DriveStore } from '../src/drive';
const reply = (json: unknown, status = 200) => ({ status, text: JSON.stringify(json), headers: {} });
const initial = (): DriveIndex => ({ format: 1, folderId: 'root', cursor: 'before', folders: { '': 'root', Notes: 'sub' }, files: [{ id: 'note', path: 'Notes/a.md', parent: 'sub', version: '1' }] });
const file = (id: string, name: string, parent = 'sub', version = '2') => ({ fileId: id, file: { id, name, parents: [parent], mimeType: 'text/markdown', version } });
test('change feed stages all pages, includes external additions and ignores other vaults', async () => {
  const current = initial(); let count = 0;
  const next = await advanceIndex(async request => {
    assert.equal(new URL(request.url).searchParams.get('pageToken'), count++ ? 'page2' : 'before');
    return reply(count === 1 ? { changes: [file('note', 'renamed.md'), file('outside', 'private.md', 'elsewhere')], nextPageToken: 'page2' } : { changes: [file('new', 'external.md')], newStartPageToken: 'after' });
  }, current);
  assert.equal(count, 2); assert.equal(next?.cursor, 'after');
  assert.deepEqual(next?.files.map(f => f.path), ['Notes/renamed.md', 'Notes/external.md']);
  assert.deepEqual(current, initial());
});
test('failed or malformed final page never advances the saved cursor', async () => {
  for (const last of [reply({}, 503), reply({ changes: [] }), reply({ changes: [], nextPageToken: 'page2' })]) {
    const current = initial(); let count = 0;
    await assert.rejects(advanceIndex(async () => ++count === 1 ? reply({ changes: [file('note', 'changed.md')], nextPageToken: 'page2' }) : last, current));
    assert.deepEqual(current, initial());
  }
});
test('expired cursors and structural folder changes request a full rebuild', async () => {
  assert.equal(await advanceIndex(async () => reply({}, 410), initial()), undefined);
  for (const change of [{ fileId: 'sub', removed: true }, { fileId: 'root', removed: true }, { fileId: 'new-folder', file: { id: 'new-folder', name: 'Imported', parents: ['root'], mimeType: 'application/vnd.google-apps.folder' } }]) {
    assert.equal(await advanceIndex(async () => reply({ changes: [change], newStartPageToken: 'after' }), initial()), undefined);
  }
});
test('removed or moved-out files leave the index without asserting they were trashed', async () => {
  for (const change of [{ fileId: 'note', removed: true }, file('note', 'a.md', 'outside')]) {
    const next = await advanceIndex(async () => reply({ changes: [change], newStartPageToken: 'after' }), initial());
    assert.deepEqual(next?.files, []);
  }
});
test('duplicate paths abort the batch and damaged or foreign caches are rejected', async () => {
  await assert.rejects(advanceIndex(async () => reply({ changes: [file('duplicate', 'a.md')], newStartPageToken: 'after' }), initial()), /Duplicate/);
  assert.equal(loadDriveIndex(initial(), 'another-vault'), undefined);
  const bad = initial(); bad.files[0]!.parent = 'outside';
  assert.equal(loadDriveIndex(bad, 'root'), undefined);
  assert.deepEqual(loadDriveIndex(initial(), 'root'), initial());
});
test('idle indexed vault makes only root and change-feed requests, with no tree scan', async () => {
  const urls: string[] = []; let committed: DriveIndex | undefined;
  const store = new DriveStore(async request => {
    urls.push(request.url);
    if (request.url.includes('/files/root')) return reply({ id: 'root', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
    assert.ok(request.url.includes('/changes?'));
    return reply({ changes: [], newStartPageToken: 'after' });
  }, 'root', { current: initial(), commit: async value => { committed = value; } });
  assert.deepEqual(await store.list(), [{ id: 'note', path: 'Notes/a.md', version: '1' }]);
  assert.equal(urls.length, 2); assert.equal(committed?.cursor, 'after');
});
test('full reconciliation captures cursor before scanning and refuses a failed checkpoint', async () => {
  const order: string[] = [];
  const store = new DriveStore(async request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/root')) return reply({ id: 'root', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
    if (url.pathname.endsWith('/startPageToken')) { order.push('cursor'); return reply({ startPageToken: 'before-scan' }); }
    order.push('scan'); return reply({ files: [{ id: 'n', name: 'a.md', mimeType: 'text/markdown', version: '2' }] });
  }, 'root', { current: initial(), rebuild: true, commit: async value => { assert.equal(value.cursor, 'before-scan'); order.push('commit'); throw new Error('disk full'); } });
  await assert.rejects(store.list(), /disk full/);
  assert.deepEqual(order, ['cursor', 'scan', 'commit']);
});
