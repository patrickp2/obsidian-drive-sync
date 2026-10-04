import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localStore, type VaultPort } from '../src/local';
import { type Content, equalContent } from '../src/content';
function fixture() {
  const files = new Map<string, Content>(); let late: (() => void) | undefined; let closed = false;
  const port: VaultPort = {
    list: () => [...files.keys()], read: async path => files.get(path) ?? null,
    create: async (path, data) => { if (files.has(path)) throw new Error('exists'); files.set(path, data); },
    rename: async (path, dest) => { late?.(); late = undefined; if (files.has(dest) || !files.has(path)) throw new Error('occupied or missing'); files.set(dest, files.get(path)!); files.delete(path); },
    process: async (path, update) => { late?.(); late = undefined; files.set(path, update(files.get(path) as string)); },
    bufferMatches: () => true, active: () => !closed
  };
  return { files, port, store: localStore(port), race: (fn: () => void) => { late = fn; }, close: () => { closed = true; } };
}
test('binary replacement retains the prior exact bytes in excluded recovery trash', async () => {
  const f = fixture(), a = Uint8Array.of(255, 0).buffer, b = Uint8Array.of(128, 1).buffer;
  f.files.set('image.png', a); assert.equal(await f.store.replace('image.png', a, b), true);
  assert.ok([...f.files.entries()].some(([path, data]) => path.startsWith('.trash/drive-sync/') && equalContent(data, a)));
  assert.deepEqual(await f.store.list(), ['image.png']); assert.deepEqual(f.files.get('image.png'), b);
});
test('late binary edit during retirement is restored, not overwritten', async () => {
  const f = fixture(), a = Uint8Array.of(0).buffer, late = Uint8Array.of(255).buffer;
  f.files.set('image.png', a); f.race(() => f.files.set('image.png', late));
  assert.equal(await f.store.replace('image.png', a, Uint8Array.of(3).buffer), false);
  assert.deepEqual(f.files.get('image.png'), late);
});
test('interruption after retirement restores the source and writes no replacement', async () => {
  const f = fixture(), a = Uint8Array.of(0).buffer;
  f.files.set('image.png', a); f.race(() => f.close());
  assert.equal(await f.store.replace('image.png', a, Uint8Array.of(3).buffer), false);
  assert.deepEqual(f.files.get('image.png'), a);
});
test('trash and move never overwrite a late edit or an occupied destination', async () => {
  const f = fixture(); f.files.set('a.md', 'A'); f.race(() => f.files.set('a.md', 'late'));
  assert.equal(await f.store.trash!('a.md', 'A'), false); assert.equal(f.files.get('a.md'), 'late');
  f.files.set('b.md', 'B'); assert.equal(await f.store.move!('a.md', 'b.md', 'late'), false);
  assert.equal(f.files.get('b.md'), 'B');
});
test('unsaved Markdown buffers prevent downloads and propagated trash', async () => {
  const f = fixture(); f.files.set('a.md', 'A'); f.port.bufferMatches = () => false;
  assert.equal(await f.store.replace('a.md', 'A', 'B'), false); assert.equal(await f.store.trash!('a.md', 'A'), false);
  assert.equal(f.files.get('a.md'), 'A');
});
