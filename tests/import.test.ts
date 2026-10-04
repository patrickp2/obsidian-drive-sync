import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importFiles } from '../src/import';
import { loadState } from '../src/state';
import { emptySyncState, type LocalStore } from '../src/sync';
import { type Content } from '../src/content';
import { parseCallback, callbackUri } from '../src/protocol';
test('explicit selection IDs survive the fixed callback; malformed/duplicate fields fail', () => {
  const response = parseCallback(new URLSearchParams({ state: 'a'.repeat(43), code: 'code', picked_file_ids: 'a,b,a' }));
  assert.ok(!response.error);
  assert.deepEqual(response.pickedFileIds, ['a', 'b']);
  assert.equal(new URL(callbackUri(response)).searchParams.get('picked_file_ids'), 'a,b');
  assert.throws(() => parseCallback(new URLSearchParams(`state=${'a'.repeat(43)}&code=x&picked_file_ids=a&picked_file_ids=b`)));
  assert.throws(() => parseCallback(new URLSearchParams({ state: 'a'.repeat(43), code: 'x', picked_file_ids: '../../bad' })));
});
test('imports are repeatable, preserve existing local edits, and do not duplicate files already in the root', async () => {
  const files = new Map<string, Content>();
  const local: LocalStore = { list: async () => [...files.keys()], read: async p => files.get(p) ?? null, replace: async (p, _, data) => { files.set(p, data); return true; } };
  let reads = 0;
  const read = async () => { reads++; return { name: 'note.md', etag: '"tag"', content: 'original' }; };
  await importFiles(['inside', 'outside'], new Set(['inside']), read, local); assert.equal(reads, 1); assert.equal(files.size, 1);
  await importFiles(['outside'], new Set(), read, local); assert.equal(files.size, 1);
  files.set('Imported from Drive/outside/note.md', 'local edit');
  await assert.rejects(importFiles(['outside'], new Set(), read, local), /preserved/);
  assert.equal(files.get('Imported from Drive/outside/note.md'), 'local edit');
});
test('state migrates without losing old baselines and cannot cross Drive roots', () => {
  const state = emptySyncState(); state.baseline['note.md'] = { id: 'file', hash: 'a'.repeat(64) };
  const migrated = loadState(state, 'root-a'); assert.deepEqual(migrated.baseline, state.baseline);
  assert.throws(() => loadState(migrated, 'root-b'), /another Drive folder/);
  assert.throws(() => loadState({ ...state, renames: { 'note.md': '../escape' } }, 'root-a'));
});
test('folder renames, rename chains, and deletion during a rename retain intent', async () => {
  const { recordRename, recordDeletion } = await import('../src/state');
  const s = emptySyncState(); s.baseline['Folder/a.md'] = { id: 'file', hash: 'a'.repeat(64) };
  recordRename(s, 'Folder', 'Moved'); recordRename(s, 'Moved', 'Again');
  assert.equal(s.renames?.['Folder/a.md'], 'Again/a.md');
  recordDeletion(s, 'Again'); assert.equal(s.deleted['Folder/a.md'], true); assert.equal(s.renames?.['Folder/a.md'], undefined);
  s.pendingCreates['new.md'] = 'pending'; recordRename(s, 'new.md', 'renamed.md');
  assert.equal(s.renames?.['new.md'], 'renamed.md'); recordRename(s, 'renamed.md', 'new.md'); assert.equal(s.renames?.['new.md'], undefined);
});
