import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine, StaleWrite, emptySyncState, type LocalStore, type RemoteStore, type RemoteFile } from '../src/sync';
function fixture() {
  const files = new Map<string, { id: string; content: string; version: number }>();
  let next = 0; let failList = false; let race: (() => void) | undefined;
  const remote: RemoteStore = {
    list: async () => { if (failList) throw new Error('offline'); return [...files].map(([path, f]) => ({ path, id: f.id })); },
    read: async f => { const row = files.get(f.path)!; return { content: row.content, etag: `"${row.version}"` }; },
    reserveId: async () => `id-${++next}`,
    create: async (path, content, id) => { if (![...files.values()].some(f => f.id === id)) files.set(path, { id, content, version: 1 }); },
    update: async (f, content, etag) => {
      race?.(); race = undefined;
      const row = files.get(f.path)!;
      if (etag !== `"${row.version}"`) throw new StaleWrite();
      row.content = content; row.version++;
    }
  };
  function device() {
    const notes = new Map<string, string>(); const state = emptySyncState(); let applyRace: (() => void) | undefined;
    let saves = 0;
    const local: LocalStore = {
      list: async () => [...notes.keys()], read: async path => notes.get(path) ?? null,
      replace: async (path, expected, content) => {
        applyRace?.(); applyRace = undefined;
        if ((notes.get(path) ?? null) !== expected) return false;
        notes.set(path, content); return true;
      }
    };
    const make = () => new SyncEngine(local, remote, state, async () => { saves++; });
    return { notes, state, engine: make(), restart: make, race: (fn: () => void) => { applyRace = fn; }, saves: () => saves };
  }
  return { files, remote, device, offline: (value: boolean) => { failList = value; }, race: (fn: () => void) => { race = fn; } };
}
test('desktop to mobile and back uses ordinary files and a persisted baseline', async () => {
  const f = fixture(); const mac = f.device(); const phone = f.device();
  mac.notes.set('Folder/Note.md', 'A'); await mac.engine.run(); await phone.engine.run();
  assert.equal(phone.notes.get('Folder/Note.md'), 'A');
  phone.notes.set('Folder/Note.md', 'B'); await phone.engine.run(); await mac.engine.run();
  assert.equal(mac.notes.get('Folder/Note.md'), 'B');
  mac.notes.set('Folder/Note.md', 'C'); await mac.restart().run(); await phone.engine.run();
  assert.equal(phone.notes.get('Folder/Note.md'), 'C'); assert.equal(f.files.size, 1);
});
test('offline edits on both devices preserve both branches as normal Markdown files', async () => {
  const f = fixture(); const a = f.device(); const b = f.device();
  a.notes.set('note.md', 'baseline'); await a.engine.run(); await b.engine.run();
  a.notes.set('note.md', 'desktop'); b.notes.set('note.md', 'phone');
  await a.engine.run(); const result = await b.engine.run();
  assert.equal(b.notes.get('note.md'), 'desktop'); assert.equal(b.notes.get(result.conflicts[0]!), 'phone');
  await b.engine.run(); await a.engine.run();
  assert.ok([...a.notes.values()].includes('phone')); assert.ok([...a.notes.values()].includes('desktop'));
  assert.equal(f.files.size, 2);
});
test('remote write between inspection and upload cannot be overwritten', async () => {
  const f = fixture(); const a = f.device(); a.notes.set('note.md', 'A'); await a.engine.run();
  a.notes.set('note.md', 'C'); f.race(() => { const r = f.files.get('note.md')!; r.content = 'B'; r.version++; });
  const result = await a.engine.run();
  assert.equal(f.files.get('note.md')!.content, 'B'); assert.equal(a.notes.get('note.md'), 'C'); assert.equal(result.pending.length, 1);
  const next = await a.engine.run(); assert.equal(a.notes.get(next.conflicts[0]!), 'C'); assert.equal(a.notes.get('note.md'), 'B');
});
test('local edit during download is retained and becomes a conflict on retry', async () => {
  const f = fixture(); const a = f.device(); a.notes.set('note.md', 'A'); await a.engine.run();
  const remote = f.files.get('note.md')!; remote.content = 'B'; remote.version++;
  a.race(() => a.notes.set('note.md', 'C'));
  assert.equal((await a.engine.run()).pending.length, 1); assert.equal(a.notes.get('note.md'), 'C');
  const next = await a.engine.run(); assert.equal(a.notes.get(next.conflicts[0]!), 'C');
});
test('failed listing makes no changes and missing files never trigger deletion', async () => {
  const f = fixture(); const a = f.device(); a.notes.set('note.md', 'A'); await a.engine.run(); const saves = a.saves();
  a.notes.set('note.md', 'B'); f.offline(true); await assert.rejects(a.engine.run(), /offline/);
  assert.equal(a.saves(), saves); assert.equal(f.files.get('note.md')!.content, 'A');
  f.offline(false); f.files.clear(); assert.equal((await a.engine.run()).pending.length, 1); assert.equal(a.notes.get('note.md'), 'B');
});
test('initial differing files are preserved without choosing a timestamp winner', async () => {
  const f = fixture(); const a = f.device(); a.notes.set('note.md', 'local'); f.files.set('note.md', { id: 'remote', content: 'remote', version: 1 });
  const r = await a.engine.run(); assert.equal(a.notes.get(r.conflicts[0]!), 'local'); assert.equal(a.notes.get('note.md'), 'remote');
});
test('unknown upload outcome retries its reserved ID instead of duplicating', async () => {
  const f = fixture(); const a = f.device(); a.notes.set('note.md', 'A');
  const create = f.remote.create; let once = true;
  f.remote.create = async (...args) => { await create(...args); if (once) { once = false; throw new Error('connection dropped'); } };
  await assert.rejects(a.engine.run()); assert.ok(a.state.pendingCreates['note.md']);
  await a.restart().run(); assert.equal(f.files.size, 1); assert.equal(Object.keys(a.state.pendingCreates).length, 0);
});
test('concurrent sync requests share one operation and stopped engines cannot run', async () => {
  const f = fixture(); const a = f.device(); assert.equal(a.engine.run(), a.engine.run());
  await a.engine.run(); a.engine.stop(); await assert.rejects(a.engine.run(), /stopped/);
});
test('intentional local deletion preserves remote pending review', async () => {
  const f = fixture(); const a = f.device(); a.notes.set('note.md', 'A'); await a.engine.run();
  a.notes.delete('note.md'); a.state.deleted['note.md'] = true;
  assert.equal((await a.engine.run()).pending.length, 1); assert.equal(f.files.get('note.md')!.content, 'A'); assert.equal(a.notes.has('note.md'), false);
});
