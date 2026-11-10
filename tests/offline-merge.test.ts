import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine, StaleWrite, emptySyncState, type SyncState, type LocalStore, type RemoteStore } from '../src/sync';
import { fingerprint, equalContent, type Content } from '../src/content';
import { mergeText, mergeable, type SnapshotStore } from '../src/merge';
import { loadState, recordRename } from '../src/state';

const B = 'title\nunchanged\nend\n', L = 'phone\nunchanged\nend\n', R = 'title\nunchanged\ndesktop\n', M = 'phone\nunchanged\ndesktop\n';
function fixture() {
  const notes = new Map<string, Content>([['note.md', B]]), blobs = new Map<string, string>();
  let state = emptySyncState(), durable = structuredClone(state), remoteContent: Content = B, path = 'note.md', version = 1, updates = 0;
  let saves = 0, failSave = 0, failAfterSave = false, putFailure = false;
  let updateHook: (() => void) | undefined, replaceHook: (() => void) | undefined;
  const store: SnapshotStore = {
    put: async text => { if (putFailure) throw new Error('disk full'); const hash = await fingerprint(text); blobs.set(hash, text); return hash; },
    get: async hash => blobs.get(hash) ?? null,
    collect: async keep => { for (const hash of blobs.keys()) if (!keep.has(hash)) blobs.delete(hash); }
  };
  const local: LocalStore = {
    list: async () => [...notes.keys()], read: async p => notes.get(p) ?? null,
    replace: async (p, expected, content) => {
      const hook = replaceHook; replaceHook = undefined; hook?.();
      if (!equalContent(notes.get(p) ?? null, expected)) return false;
      notes.set(p, content); return true;
    },
    move: async (old, target, expected) => { if (notes.has(target) || !equalContent(notes.get(old) ?? null, expected)) return false; notes.delete(old); notes.set(target, expected); return true; }
  };
  const remote: RemoteStore = {
    list: async () => [{ id: 'file-id', path, version: String(version) }],
    read: async () => ({ content: remoteContent, etag: `"${version}"`, version: String(version) }),
    reserveId: async () => 'copy-id', create: async () => {},
    update: async (_file, content, etag) => {
      const previous = version; const hook = updateHook; updateHook = undefined; hook?.();
      if (etag !== `"${version}"`) throw new StaleWrite();
      assert.equal(version, previous); remoteContent = content; version++; updates++;
    },
    move: async (_f, target) => { path = target; version++; }
  };
  const save = async () => {
    saves++;
    if (saves === failSave && !failAfterSave) throw new Error('save interrupted');
    durable = structuredClone(state);
    if (saves === failSave) throw new Error('crash after save');
  };
  const run = () => new SyncEngine(local, remote, state, save, false, store).run();
  return { notes, blobs, store, remote, local, run, state: () => state, durable: () => durable,
    restart: () => { state = loadState(structuredClone(durable), ''); },
    remoteText: () => remoteContent, updateCount: () => updates,
    remoteEdit: (text: Content) => { remoteContent = text; version++; },
    saveFault: (offset: number, after = false) => { failSave = saves + offset; failAfterSave = after; },
    clearFault: () => { failSave = 0; putFailure = false; }, diskFull: () => { putFailure = true; },
    onUpdate: (hook: () => void) => { updateHook = hook; }, onReplace: (hook: () => void) => { replaceHook = hook; },
    loseReply: () => {
      const update = remote.update;
      remote.update = async (...args) => { await update(...args); remote.update = update; throw new Error('lost response'); };
    }
  };
}
async function setup() { const f = fixture(); await f.run(); return f; }
async function converge(f: ReturnType<typeof fixture>) { for (let n = 0; n < 4; n++) await f.run(); }

test('one-device offline edits and accepted upload with lost reply do not create conflicts', async () => {
  const f = await setup(); f.notes.set('note.md', L); f.loseReply();
  await assert.rejects(f.run(), /lost response/); assert.equal(f.remoteText(), L);
  f.restart(); const next = L + 'another offline edit\n'; f.notes.set('note.md', next);
  const result = await f.run(); assert.equal(result.conflicts.length, 0); assert.deepEqual(result.recovered, ['note.md']);
  assert.equal(f.remoteText(), next); assert.equal(f.notes.get('note.md'), next); assert.equal(f.state().pendingWrites?.['note.md'], undefined);
});
test('independent offline edits merge quietly and converge to one ordinary Markdown note', async () => {
  const f = await setup(); f.notes.set('note.md', L); f.remoteEdit(R);
  const result = await f.run(); assert.deepEqual(result.merged, ['note.md']); assert.equal(result.conflicts.length, 0);
  assert.equal(f.notes.get('note.md'), M); assert.equal(f.remoteText(), M);
  await converge(f); assert.equal(f.notes.size, 1); assert.equal(f.blobs.size, 1);
});
test('lost merge upload reply recovers before subsequent phone edits are reconciled', async () => {
  const f = await setup(); f.notes.set('note.md', L); f.remoteEdit(R); f.loseReply(); await assert.rejects(f.run());
  f.restart(); f.notes.set('note.md', 'extra offline edit\n' + L);
  assert.equal((await f.run()).conflicts.length, 0); await converge(f);
  assert.equal(f.remoteText(), 'extra offline edit\n' + M); assert.equal(f.notes.get('note.md'), f.remoteText());
});
test('identical edits are not duplicated; overlapping edits and same-position insertions preserve both versions', async () => {
  const f = await setup(); f.notes.set('note.md', L); f.remoteEdit(L);
  assert.equal((await f.run()).conflicts.length, 0); assert.equal(f.updateCount(), 0);
  for (const other of ['desktop\nunchanged\nend\n', 'different insertion\n' + B]) {
    const g = await setup(); const phone = other.startsWith('different') ? 'phone insertion\n' + B : L;
    g.notes.set('note.md', phone); g.remoteEdit(other); const result = await g.run();
    assert.equal(result.conflicts.length, 1); assert.equal(g.notes.get(result.conflicts[0]!), phone);
    assert.equal(g.notes.get('note.md'), other); assert.equal(g.remoteText(), other);
    assert.equal(result.conflictDetails[0]?.reason, 'overlapping edits');
  }
});
test('missing or corrupt common snapshots never cause guessed merges', async () => {
  for (const corrupt of [false, true]) {
    const f = await setup(); const hash = f.state().baseline['note.md']!.snapshot!;
    if (corrupt) f.blobs.set(hash, 'tampered'); else f.blobs.delete(hash);
    f.notes.set('note.md', L); f.remoteEdit(R); const result = await f.run();
    assert.equal(result.conflicts.length, 1); assert.equal(result.conflictDetails[0]?.reason, 'common version unavailable');
    assert.equal(f.remoteText(), R); assert.equal(f.notes.get(result.conflicts[0]!), L);
  }
});
test('old baselines gain snapshots only from a confirmed common version', async () => {
  const f = await setup(); delete f.state().baseline['note.md']!.snapshot; f.blobs.clear();
  await f.run(); assert.ok(f.state().baseline['note.md']!.snapshot);
  delete f.state().baseline['note.md']!.snapshot; f.blobs.clear(); f.notes.set('note.md', L); f.remoteEdit(R);
  assert.equal((await f.run()).conflicts.length, 1);
});
test('a competing remote write during merge is guarded by ETag and is recomputed', async () => {
  const f = await setup(); f.notes.set('note.md', L); f.remoteEdit(R);
  const newer = R + 'new remote edit\n'; f.onUpdate(() => f.remoteEdit(newer));
  assert.equal((await f.run()).pending.length, 1); assert.equal(f.notes.get('note.md'), L); assert.equal(f.remoteText(), newer);
  await converge(f); assert.equal(f.remoteText(), M + 'new remote edit\n');
});
test('late phone edits during guarded local application survive merge recovery', async () => {
  const f = await setup(); f.notes.set('note.md', L); f.remoteEdit(R);
  f.onReplace(() => f.notes.set('note.md', 'late edit\n' + L));
  assert.equal((await f.run()).pending.length, 1); f.restart(); await converge(f);
  assert.equal(f.remoteText(), 'late edit\n' + M); assert.equal(f.notes.get('note.md'), f.remoteText());
});
test('missing merge journal snapshot stops recovery without overwriting either side', async () => {
  const f = await setup(); f.notes.set('note.md', L); f.remoteEdit(R); f.loseReply(); await assert.rejects(f.run()); f.restart();
  f.blobs.delete(f.state().pendingMerges!['note.md']!.localHash);
  const result = await f.run(); assert.match(result.pending[0]!, /snapshot unavailable/);
  assert.equal(f.notes.get('note.md'), L); assert.equal(f.remoteText(), M); assert.ok(f.state().pendingMerges?.['note.md']);
});
test('disk failure before the journal prevents remote or local merge writes', async () => {
  const f = await setup(); f.notes.set('note.md', L); f.remoteEdit(R); f.diskFull(); await assert.rejects(f.run(), /disk full/);
  assert.equal(f.remoteText(), R); assert.equal(f.notes.get('note.md'), L); assert.equal(f.updateCount(), 0);
});
for (const after of [false, true]) for (let point = 1; point <= 4; point++) test(`merge restart at save ${point}, ${after ? 'after' : 'before'} persistence, preserves all edits`, async () => {
  const f = await setup(); f.notes.set('note.md', L); f.remoteEdit(R); f.saveFault(point, after);
  await assert.rejects(f.run(), /save|crash/); f.clearFault(); f.restart(); await converge(f);
  assert.equal(f.notes.get('note.md'), M); assert.equal(f.remoteText(), M); assert.equal(f.notes.size, 1);
  assert.equal(Object.keys(f.state().pendingMerges ?? {}).length, 0);
});
test('retry in the same process persists a failed checkpoint before snapshot collection', async () => {
  const f = await setup(); f.notes.set('note.md', L); f.remoteEdit(R); f.saveFault(3);
  await assert.rejects(f.run()); f.clearFault(); await converge(f); f.restart(); await converge(f);
  assert.equal(f.notes.get('note.md'), M); assert.equal(f.remoteText(), M);
});
test('pending merge recovery follows a confirmed file rename', async () => {
  const f = await setup(); f.notes.set('note.md', L); f.remoteEdit(R); f.loseReply(); await assert.rejects(f.run());
  recordRename(f.state(), 'note.md', 'renamed.md'); f.notes.delete('note.md'); f.notes.set('renamed.md', L);
  await converge(f); assert.equal(f.notes.get('renamed.md'), M); assert.equal(f.remoteText(), M); assert.equal(f.state().pendingMerges?.['renamed.md'], undefined);
});
test('line merge preserves Unicode, CRLF, blank lines, and final-newline absence', () => {
  const base = 'α\r\n\r\n終', local = 'β\r\n\r\n終', remote = 'α\r\n\r\n末';
  assert.deepEqual(mergeText(base, local, remote), { text: 'β\r\n\r\n末' });
  assert.deepEqual(mergeText('', '', 'new'), { text: 'new' });
  assert.equal(mergeable('file.png', 'text'), false);
  assert.equal(mergeable('note.md', 'a'.repeat(256 * 1024 + 1)), false);
  assert.equal(mergeable('note.md', 'line\n'.repeat(2001)), false);
  assert.ok('reason' in mergeText(B, L, 'x'.repeat(256 * 1024 + 1)));
});

for (const after of [false, true]) for (let point = 1; point <= 3; point++) test(`upload restart at save ${point}, ${after ? 'after' : 'before'} persistence, retains the next offline edit`, async () => {
  const f = await setup(); f.notes.set('note.md', L); f.saveFault(point, after);
  await assert.rejects(f.run(), /save|crash/); f.clearFault(); f.restart();
  const next = L + 'more phone work\n'; f.notes.set('note.md', next); await converge(f);
  assert.equal(f.remoteText(), next); assert.equal(f.notes.get('note.md'), next); assert.equal(f.notes.size, 1);
});
test('snapshot disk failure after accepted upload recovers from the durable journal', async () => {
  const f = await setup(); f.notes.set('note.md', L); f.onUpdate(() => f.diskFull());
  await assert.rejects(f.run(), /disk full/); assert.equal(f.remoteText(), L);
  f.clearFault(); f.restart(); f.notes.set('note.md', L + 'more phone work\n'); await converge(f);
  assert.equal(f.notes.get('note.md'), f.remoteText()); assert.equal(f.notes.size, 1);
});
test('overlapping late edits during merge recovery keep a conflict copy instead of guessing', async () => {
  const f = await setup(); f.notes.set('note.md', L); f.remoteEdit(R); f.loseReply(); await assert.rejects(f.run()); f.restart();
  const late = 'phone\nunchanged\nlate phone replacement\n'; f.notes.set('note.md', late);
  const result = await f.run(); assert.equal(result.conflicts.length, 1);
  assert.equal(f.notes.get(result.conflicts[0]!), late); assert.equal(f.notes.get('note.md'), M);
});
test('an unaccepted upload followed by a competing remote edit retains the original common base', async () => {
  const f = await setup(); f.notes.set('note.md', L);
  const update = f.remote.update; f.remote.update = async () => { throw new Error('offline before upload'); };
  await assert.rejects(f.run()); f.remote.update = update; f.restart(); f.remoteEdit(R);
  await converge(f); assert.equal(f.notes.get('note.md'), M); assert.equal(f.remoteText(), M); assert.equal(f.notes.size, 1);
});
