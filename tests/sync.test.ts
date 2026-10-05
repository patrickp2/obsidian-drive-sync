import { equalContent, type Content } from '../src/content';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordRename } from '../src/state';
import { SyncEngine, StaleWrite, emptySyncState, type LocalStore, type RemoteStore, type RemoteFile } from '../src/sync';
function fixture() {
  const files = new Map<string, { id: string; content: Content; version: number }>();
  const trashed = new Map<string, Content>();
  let next = 0; let failList = false; let race: (() => void) | undefined;
  const remote: RemoteStore = {
    list: async () => { if (failList) throw new Error('offline'); return [...files].map(([path, f]) => ({ path, id: f.id })); },
    read: async f => { const row = files.get(f.path)!; return { content: row.content, etag: `"${row.version}"` }; },
    missing: async id => trashed.has(id) ? 'trashed' : 'unavailable',
    trash: async (file, etag) => {
      race?.(); race = undefined;
      const row = files.get(file.path)!;
      if (etag !== `"${row.version}"`) throw new StaleWrite();
      trashed.set(row.id, row.content); files.delete(file.path);
    },
    move: async (file, path, etag) => {
      const row = files.get(file.path)!;
      if (etag !== `"${row.version}"`) throw new StaleWrite();
      if (files.has(path)) throw new Error('occupied');
      files.delete(file.path); files.set(path, { ...row, version: row.version + 1 });
    },
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
    const notes = new Map<string, Content>(); const state = emptySyncState(); let applyRace: (() => void) | undefined;
    let saves = 0;
    const local: LocalStore = {
      list: async () => [...notes.keys()], read: async path => notes.get(path) ?? null,
      trash: async (path, expected) => {
        applyRace?.(); applyRace = undefined;
        if (!equalContent(notes.get(path) ?? null, expected)) return false;
        notes.delete(path); return true;
      },
      move: async (path, destination, expected) => {
        if (notes.has(destination) || !equalContent(notes.get(path) ?? null, expected)) return false;
        notes.set(destination, expected); notes.delete(path); return true;
      },
      replace: async (path, expected, content) => {
        applyRace?.(); applyRace = undefined;
        if (!equalContent(notes.get(path) ?? null, expected)) return false;
        notes.set(path, content); return true;
      }
    };
    const make = () => new SyncEngine(local, remote, state, async () => { saves++; });
    return { notes, state, engine: make(), restart: make, race: (fn: () => void) => { applyRace = fn; }, saves: () => saves };
  }
  return { files, trashed, remote, device, offline: (value: boolean) => { failList = value; }, race: (fn: () => void) => { race = fn; } };
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
test('intentional local deletion moves an unchanged remote to trash', async () => {
  const f = fixture(); const a = f.device(); a.notes.set('note.md', 'A'); await a.engine.run();
  a.notes.delete('note.md'); a.state.deleted['note.md'] = true;
  assert.equal((await a.engine.run()).pending.length, 0); assert.equal(f.files.has('note.md'), false); assert.equal(f.trashed.size, 1); assert.equal(a.notes.has('note.md'), false);
});
test('attachments preserve exact non-text bytes and their extensions through conflicts', async () => {
  const f = fixture(), a = f.device(), b = f.device();
  const first = Uint8Array.of(0, 255, 128, 13, 10).buffer;
  a.notes.set('images/photo.png', first); await a.engine.run(); await b.engine.run();
  assert.deepEqual(b.notes.get('images/photo.png'), first);
  a.notes.set('images/photo.png', Uint8Array.of(1, 255).buffer);
  b.notes.set('images/photo.png', Uint8Array.of(2, 255).buffer);
  await a.engine.run(); const result = await b.engine.run();
  assert.match(result.conflicts[0]!, /\.png$/);
  assert.deepEqual(b.notes.get(result.conflicts[0]!), Uint8Array.of(2, 255).buffer);
});
test('two vaults with the same paths never share baselines or remote changes', async () => {
  const work = fixture(), personal = fixture();
  const w = work.device(), p = personal.device();
  w.notes.set('note.md', 'work'); p.notes.set('note.md', 'personal');
  await Promise.all([w.engine.run(), p.engine.run()]);
  w.notes.set('note.md', 'work edit'); await w.engine.run(); await p.engine.run();
  assert.equal(p.notes.get('note.md'), 'personal'); assert.equal(personal.files.get('note.md')!.content, 'personal');
});
test('local rename preserves Drive identity and remote rename reaches the other device', async () => {
  const f = fixture(), a = f.device(), b = f.device();
  a.notes.set('old.md', 'A'); await a.engine.run(); await b.engine.run();
  const id = f.files.get('old.md')!.id;
  a.notes.delete('old.md'); a.notes.set('Folder/new.md', 'B'); a.state.renames = { 'old.md': 'Folder/new.md' };
  await a.engine.run(); await a.restart().run(); await b.engine.run();
  assert.equal(f.files.get('Folder/new.md')!.id, id); assert.equal(f.files.size, 1);
  assert.equal(b.notes.get('Folder/new.md'), 'B'); assert.equal(b.notes.has('old.md'), false);
});
test('unknown rename outcome is recovered by file ID after restart', async () => {
  const f = fixture(), a = f.device(); a.notes.set('old.md', 'A'); await a.engine.run();
  a.notes.delete('old.md'); a.notes.set('new.md', 'A'); a.state.renames = { 'old.md': 'new.md' };
  const move = f.remote.move!; f.remote.move = async (...args) => { await move(...args); throw new Error('lost response'); };
  await assert.rejects(a.engine.run()); await a.restart().run();
  assert.equal(f.files.size, 1); assert.equal(a.state.baseline['old.md'], undefined); assert.ok(a.state.baseline['new.md']);
});
for (const destination of ['final.md', 'old.md']) test(`rename during an uncertain move converges to ${destination} without duplicates`, async () => {
  const f = fixture(), a = f.device(), b = f.device();
  a.notes.set('old.md', 'A'); await a.engine.run(); await b.engine.run();
  const id = f.files.get('old.md')!.id;
  a.notes.delete('old.md'); a.notes.set('middle.md', 'A'); recordRename(a.state, 'old.md', 'middle.md');
  const move = f.remote.move!;
  f.remote.move = async (...args) => {
    await move(...args);
    a.notes.delete('middle.md'); a.notes.set(destination, 'A'); recordRename(a.state, 'middle.md', destination);
    throw new Error('lost reply');
  };
  await assert.rejects(a.engine.run()); f.remote.move = move;
  await a.restart().run();
  assert.equal(a.notes.has('middle.md'), false);
  await a.restart().run(); await b.engine.run();
  assert.deepEqual([...f.files.keys()], [destination]); assert.equal(f.files.get(destination)!.id, id);
  assert.deepEqual([...a.notes.keys()], [destination]); assert.deepEqual([...b.notes.keys()], [destination]);
  assert.deepEqual(Object.keys(a.state.baseline), [destination]);
});
test('competing rename from another device never downloads a duplicate identity', async () => {
  const f = fixture(), a = f.device(); a.notes.set('old.md', 'A'); await a.engine.run();
  const file = f.files.get('old.md')!; f.files.delete('old.md'); f.files.set('theirs.md', file);
  a.notes.delete('old.md'); a.notes.set('mine.md', 'A'); recordRename(a.state, 'old.md', 'mine.md');
  const result = await a.engine.run(); assert.equal(result.pending.length, 1);
  assert.deepEqual([...a.notes.keys()], ['mine.md']); assert.deepEqual(Object.keys(a.state.baseline), ['old.md']);
});
test('rename collision preserves both files and blocks content writes to either path', async () => {
  const f = fixture(), a = f.device(); a.notes.set('old.md', 'A'); a.notes.set('new.md', 'B'); await a.engine.run();
  a.notes.delete('old.md'); a.notes.set('new.md', 'A'); a.state.renames = { 'old.md': 'new.md' };
  const r = await a.engine.run(); assert.equal(r.pending.length, 1); assert.equal(f.files.get('new.md')!.content, 'B'); assert.equal(f.files.get('old.md')!.content, 'A');
});
test('remote trash preserves a concurrently edited local branch', async () => {
  const f = fixture(), a = f.device(), b = f.device(); a.notes.set('note.md', 'A'); await a.engine.run(); await b.engine.run();
  a.notes.delete('note.md'); a.state.deleted['note.md'] = true; b.notes.set('note.md', 'offline edit');
  await a.engine.run(); const r = await b.engine.run();
  assert.equal(b.notes.get(r.conflicts[0]!), 'offline edit'); assert.equal(b.notes.has('note.md'), false);
  await b.engine.run(); await a.engine.run(); assert.ok([...a.notes.values()].includes('offline edit'));
});
test('local delete versus remote edit restores the edit, including a last-moment race', async () => {
  const f = fixture(), a = f.device(); a.notes.set('note.md', 'A'); await a.engine.run();
  a.notes.delete('note.md'); a.state.deleted['note.md'] = true;
  f.race(() => { const row = f.files.get('note.md')!; row.content = 'new edit'; row.version++; });
  assert.equal((await a.engine.run()).pending.length, 1); await a.engine.run();
  assert.equal(a.notes.get('note.md'), 'new edit'); assert.equal(f.trashed.size, 0);
});
test('trash success with a lost response recovers without resurrecting the file', async () => {
  const f = fixture(), a = f.device(); a.notes.set('note.md', 'A'); await a.engine.run();
  a.notes.delete('note.md'); a.state.deleted['note.md'] = true;
  const trash = f.remote.trash!; f.remote.trash = async (...args) => { await trash(...args); throw new Error('network lost'); };
  await assert.rejects(a.engine.run()); await a.restart().run(); assert.equal(f.files.size, 0); assert.equal(Object.keys(a.state.baseline).length, 0);
});
test('two thousand files survive restart and interrupted updates without duplicates', async () => {
  const f = fixture(), a = f.device(), b = f.device();
  for (let i = 0; i < 2000; i++) a.notes.set(`notes/${i}.md`, `note ${i}`);
  await a.engine.run(); await b.engine.run(); assert.equal(b.notes.size, 2000);
  a.notes.set('notes/1.md', 'edited'); const update = f.remote.update;
  f.remote.update = async (...args) => { await update(...args); throw new Error('force close after upload'); };
  await assert.rejects(a.engine.run()); await a.restart().run(); await b.engine.run();
  assert.equal(b.notes.get('notes/1.md'), 'edited'); assert.equal(f.files.size, 2000);
});
test('case-colliding remote names abort before any local writes', async () => {
  const f = fixture(), a = f.device();
  f.files.set('NOTE.md', { id: 'a', content: 'A', version: 1 }); f.files.set('note.md', { id: 'b', content: 'B', version: 1 });
  await assert.rejects(a.engine.run(), /collision/); assert.equal(a.notes.size, 0);
});
test('unchanged listed versions avoid downloading contents again', async () => {
  const f = fixture(), a = f.device(); a.notes.set('note.md', 'A'); await a.engine.run();
  f.remote.list = async () => [{ id: f.files.get('note.md')!.id, path: 'note.md', version: '1' }];
  const read = f.remote.read; let reads = 0;
  f.remote.read = async file => { reads++; return { ...await read(file), version: '1' }; };
  await a.engine.run(); await a.engine.run(); assert.equal(reads, 1);
  a.notes.set('note.md', 'local edit'); await a.engine.run(); assert.equal(reads, 2);
});
test('deletion while the first upload is in flight is not forgotten', async () => {
  const f = fixture(), a = f.device(); a.notes.set('note.md', 'A');
  const create = f.remote.create;
  f.remote.create = async (...args) => { await create(...args); a.notes.delete('note.md'); a.state.deleted['note.md'] = true; };
  await a.engine.run(); assert.equal(a.state.deleted['note.md'], true);
  await a.engine.run(); assert.equal(f.files.size, 0); assert.equal(f.trashed.size, 1);
});

test('warm fingerprints skip unchanged contents, while full reconciliation detects an otherwise missed edit', async () => {
  const f = fixture(); const a = f.device(); a.notes.set('note.md', 'baseline'); await a.engine.run();
  const row = f.files.get('note.md')!;
  f.remote.list = async () => [{ id: row.id, path: 'note.md', version: String(row.version) }];
  a.state.baseline['note.md']!.version = String(row.version);
  let localReads = 0; let remoteReads = 0;
  const local: LocalStore = {
    list: async () => [...a.notes.keys()],
    read: async path => { localReads++; return a.notes.get(path) ?? null; },
    unchanged: () => true,
    replace: async (path, expected, value) => { if (!equalContent(a.notes.get(path) ?? null, expected)) return false; a.notes.set(path, value); return true; }
  };
  const read = f.remote.read; f.remote.read = async file => { remoteReads++; return read(file); };
  await new SyncEngine(local, f.remote, a.state, async () => {}).run();
  assert.equal(localReads, 0); assert.equal(remoteReads, 0);
  // Simulate a missed local event with unchanged metadata/fingerprint hint.
  a.notes.set('note.md', 'missed local edit');
  const result = await new SyncEngine(local, f.remote, a.state, async () => {}, true).run();
  assert.ok(localReads > 0); assert.ok(remoteReads > 0);
  assert.equal(result.uploaded, 1); assert.equal(row.content, 'missed local edit');
});
test('a changed remote version overrides a warm local fingerprint and preserves both edited branches', async () => {
  const f = fixture(); const a = f.device(); a.notes.set('note.md', 'baseline'); await a.engine.run();
  const row = f.files.get('note.md')!; a.state.baseline['note.md']!.version = '1';
  f.remote.list = async () => [{ id: row.id, path: 'note.md', version: String(row.version) }];
  row.content = 'remote edit'; row.version++;
  a.notes.set('note.md', 'local edit');
  const local: LocalStore = {
    list: async () => [...a.notes.keys()], read: async path => a.notes.get(path) ?? null,
    unchanged: () => true,
    replace: async (path, expected, value) => { if (!equalContent(a.notes.get(path) ?? null, expected)) return false; a.notes.set(path, value); return true; }
  };
  const result = await new SyncEngine(local, f.remote, a.state, async () => {}).run();
  assert.equal(a.notes.get('note.md'), 'remote edit');
  assert.equal(a.notes.get(result.conflicts[0]!), 'local edit');
});
