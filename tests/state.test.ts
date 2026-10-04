import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadState } from '../src/state';
import { emptySyncState } from '../src/sync';
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
