import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryPath, recoveryStorage } from '../src/recovery';
import { localStore } from '../src/local';
import type { Content } from '../src/content';

function fixture() {
  const files = new Map<string, Content>();
  const folders = new Set(['.trash', '.trash/drive-sync']);
  let beforeRename: (() => void) | undefined;
  const storage = recoveryStorage({
    stat: async path => folders.has(path) ? { type: 'folder', size: 0, ctime: 0, mtime: 0 } : files.has(path) ?
      { type: 'file', size: 5, ctime: 0, mtime: 0 } : null,
    mkdir: async path => { if (folders.has(path)) throw new Error('Folder already exists.'); folders.add(path); },
    read: async path => files.get(path) as string,
    readBinary: async path => files.get(path) as ArrayBuffer,
    rename: async (path, dest) => { assert.ok(!files.has(dest)); files.set(dest, files.get(path)!); files.delete(path); }
  });
  const ensure = (path: string) => storage.folders(path, async folder => {
    assert.ok(!folder.startsWith('.')); folders.add(folder);
  });
  const store = localStore({
    list: () => [...files.keys()].filter(path => !path.startsWith('.')),
    read: async path => recoveryPath(path) ? storage.read(path) : files.get(path) ?? null,
    create: async (path, content) => { await ensure(path); assert.ok(!files.has(path)); files.set(path, content); },
    rename: async (path, destination) => {
      await ensure(destination);
      if (recoveryPath(path)) return storage.restore(path, destination);
      beforeRename?.(); beforeRename = undefined;
      files.set(destination, files.get(path)!); files.delete(path);
    },
    process: async (path, update) => { files.set(path, update(files.get(path) as string)); },
    bufferMatches: () => true, active: () => true
  });
  return { store, files, folders, storage, race: (fn: () => void) => { beforeRename = fn; } };
}
test('existing hidden trash supports consecutive incoming moves and removals', async () => {
  const f = fixture(); f.files.set('a.md', 'A'); f.files.set('b.md', 'B');
  assert.equal(await f.store.move!('a.md', 'moved/a.md', 'A'), true);
  assert.equal(await f.store.trash!('b.md', 'B'), true);
  assert.deepEqual(await f.store.list(), ['moved/a.md']);
  assert.deepEqual([...f.files].filter(([path]) => recoveryPath(path)).map(([,data]) => data).sort(), ['A', 'B']);
});
test('hidden binary backup can be verified and restored after a late local edit', async () => {
  const f = fixture(), original = Uint8Array.of(0,255).buffer, late = Uint8Array.of(9,8).buffer;
  f.files.set('image.png', original); f.race(() => f.files.set('image.png', late));
  assert.equal(await f.store.replace('image.png', original, Uint8Array.of(1).buffer), false);
  assert.deepEqual(f.files.get('image.png'), late);
});
test('recovery cannot replace an occupied destination or traverse outside its namespace', async () => {
  const f = fixture(); f.files.set('a.md', 'new');
  await assert.rejects(f.storage.restore('.trash/drive-sync/test/a.md', 'a.md'), /occupied/);
  await assert.rejects(f.storage.read('.trash/drive-sync/../../.obsidian/data.json'), /Invalid/);
  f.files.set('collision', 'file');
  await assert.rejects(f.storage.folders('collision/a.md', async () => {}), /occupies/);
});
