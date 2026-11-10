import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotStore } from '../src/snapshots';
import { fingerprint } from '../src/content';
function fixture() {
  const root = '.obsidian/plugins/drive-sync/merge-snapshots';
  const files = new Map<string, string>(), folders = new Set<string>();
  let badWrite = false;
  const adapter = {
    stat: async (path: string) => files.has(path) ? { type: 'file' as const, size: Buffer.byteLength(files.get(path)!) } : folders.has(path) ? { type: 'folder' as const, size: 0 } : null,
    mkdir: async (path: string) => { folders.add(path); },
    read: async (path: string) => { if (!files.has(path)) throw new Error('missing'); return files.get(path)!; },
    write: async (path: string, text: string) => { files.set(path, badWrite ? 'truncated' : text); },
    rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
    list: async () => ({ files: [...files.keys()], folders: [] }),
    remove: async (path: string) => { files.delete(path); }
  };
  return { root, files, store: snapshotStore(adapter as any, root), corruptWrites: () => { badWrite = true; } };
}
test('snapshot adapter verifies writes, repairs proven bytes, and rejects unsafe references', async () => {
  const f = fixture(), content = 'Unicode α\r\n終'; const hash = await f.store.put(content);
  assert.equal(hash, await fingerprint(content)); assert.equal(await f.store.get(hash), content);
  assert.equal(await f.store.put(content), hash); assert.equal(f.files.size, 1);
  f.files.set(`${f.root}/${hash}.txt`, 'corrupt'); assert.equal(await f.store.get(hash), null);
  await f.store.put(content); assert.equal(await f.store.get(hash), content);
  await assert.rejects(f.store.get('../escape'), /Invalid snapshot/);
});
test('failed snapshot verification never publishes a referenced blob', async () => {
  const f = fixture(); f.corruptWrites(); const hash = await fingerprint('candidate');
  await assert.rejects(f.store.put('candidate'), /could not be saved/);
  assert.equal(await f.store.get(hash), null);
});
test('collection retains all referenced blobs and removes only generated files inside its directory', async () => {
  const f = fixture(), keep = await f.store.put('keep'), obsolete = await f.store.put('obsolete');
  f.files.set(`${f.root}/${crypto.randomUUID()}.tmp`, 'incomplete write');
  f.files.set(`${f.root}/user-file.txt`, 'untouched'); f.files.set('outside.txt', 'untouched');
  f.files.set(`${f.root}/../outside.txt`, 'untouched');
  await f.store.collect(new Set([keep]));
  assert.equal(await f.store.get(keep), 'keep'); assert.equal(await f.store.get(obsolete), null);
  assert.ok(f.files.has(`${f.root}/user-file.txt`)); assert.ok(f.files.has('outside.txt')); assert.ok(f.files.has(`${f.root}/../outside.txt`));
  assert.equal([...f.files.keys()].filter(path => path.endsWith('.tmp')).length, 0);
});

test('snapshot adapter works with real filesystem persistence across store instances', async () => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-merge-snapshots-')), root = path.join(dir, 'merge-snapshots');
  const adapter = {
    stat: async (file: string) => { try { const s = await fs.stat(file); return { type: s.isDirectory() ? 'folder' : 'file', size: s.size }; } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; } },
    mkdir: async (file: string) => { await fs.mkdir(file); }, read: (file: string) => fs.readFile(file, 'utf8'),
    write: (file: string, text: string) => fs.writeFile(file, text), rename: fs.rename, remove: fs.unlink,
    list: async (folder: string) => ({ files: (await fs.readdir(folder)).map(name => path.join(folder, name)), folders: [] })
  };
  try {
    const first = snapshotStore(adapter as any, root), hash = await first.put('persisted α\r\n');
    const restarted = snapshotStore(adapter as any, root); assert.equal(await restarted.get(hash), 'persisted α\r\n');
    await fs.writeFile(path.join(root, `${hash}.txt`), 'damaged'); assert.equal(await restarted.get(hash), null);
    await restarted.put('persisted α\r\n'); assert.equal(await restarted.get(hash), 'persisted α\r\n');
    await restarted.collect(new Set([hash])); assert.deepEqual(await fs.readdir(root), [`${hash}.txt`]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
