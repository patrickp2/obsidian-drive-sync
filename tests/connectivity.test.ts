import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';

// Exercise the actual plugin scheduler and Drive/auth transports without an
// Obsidian installation, real credentials, sockets, or external requests.
const code = buildSync({ entryPoints: ['src/main.ts'], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['obsidian', 'node:http', 'node:os'] }).outputFiles[0]!.text;
const require = createRequire(import.meta.url);
async function fixture(online = true) {
  let now = 100_000; let requests = 0; let nextTimer = 0;
  const timers = new Map<number, { at: number; work: () => void }>();
  const navigator = { onLine: online };
  const document = { visibilityState: 'visible' };
  const json = (data: unknown, status = 200, headers = {}) => ({ status, headers, text: JSON.stringify(data), arrayBuffer: new ArrayBuffer(0) });
  const normal = async ({ url }: { url: string }) => {
    if (url.includes('/token')) return json({ access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 3600 });
    if (url.includes('/changes?')) return json({ changes: [], newStartPageToken: 'next' });
    if (url.includes('/startPageToken')) return json({ startPageToken: 'first' });
    if (url.includes('/files?')) return json({ files: [] });
    return json({ id: 'root-folder', name: 'Vault', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
  };
  let handler = normal;
  class Stub {}
  const module = { exports: {} as any };
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => name === 'obsidian' ? {
    Plugin: Stub, Modal: Stub, PluginSettingTab: Stub, TFile: Stub, MarkdownView: Stub,
    Platform: { isDesktopApp: false }, Notice: Stub, requestUrl: async (r: any) => { requests++; return handler(r); }
  } : require(name), navigator, document,
  window: { setTimeout: (work: () => void, delay: number) => { timers.set(++nextTimer, { at: now + delay, work }); return nextTimer; }, clearTimeout: (id: number) => timers.delete(id) },
  Date: class extends Date { static now() { return now; } },
  crypto, structuredClone, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
  // Native GET retries are immediate here; their bounds are tested separately.
  setTimeout: (work: () => void) => { work(); }, clearTimeout: () => {} });
  const p = new module.exports.default();
  p.settings = { syncEnabled: true, folderId: 'root-folder', syncState: { folderId: 'root-folder', baseline: {} },
    driveIndex: { format: 1, folderId: 'root-folder', cursor: 'first', folders: { '': 'root-folder' }, files: [] } };
  p.manifest = { id: 'drive-sync' };
  p.app = { vault: { configDir: '.obsidian', adapter: { write: async () => {} } } };
  p.auth = { state: { status: 'connected' }, tokenForDrive: async () => 'synthetic-token', resumeNetwork: () => {}, stop: () => {} };
  p.localIndex = { clear: () => {} };
  p.localStore = () => ({ list: async () => [], read: async () => null });
  p.saveData = async () => {};
  p.wasOffline = !online;
  return { p, navigator, document, timers, json, normal, calls: () => requests,
    handler: (next: typeof normal) => { handler = next; }, advance: (ms: number) => { now += ms; },
    settle: async () => { await p.running; await Promise.resolve(); },
    flush: async () => {
      if (timers.size) now = Math.max(now, Math.min(...[...timers.values()].map(t => t.at)));
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.work(); }
      await p.running;
    },
    tick: async (ms: number) => {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.work(); }
      await p.running;
    },
    delay: () => Math.min(...[...timers.values()].map(t => t.at - now)) };
}

test('offline edits and a queued full check stay pending without Google requests', async () => {
  const f = await fixture(false);
  f.p.dirty = true; f.p.schedule();
  await f.p.syncNow(true);
  await assert.rejects(f.p.authTransport('https://oauth2.googleapis.com/token', new URLSearchParams()));
  assert.equal(f.calls(), 0); assert.equal(f.timers.size, 0);
  assert.equal(f.p.dirty, true); assert.equal(f.p.fullRequested, true);
  assert.equal(f.p.syncMessage, 'Offline · changes saved locally');
  f.navigator.onLine = true; f.p.connectivityChanged(); await f.settle();
  assert.equal(f.p.fullRequested, false); assert.equal(f.p.syncMessage, 'Synced with Drive');
  assert.ok(f.calls() > 0); assert.equal(f.delay(), 60_000); assert.equal(f.timers.size, 1);
});

test('resume bypasses failed-network backoff but leaves Google Retry-After intact', async () => {
  const f = await fixture();
  f.handler(async () => { throw new Error('Connection lost'); });
  await f.p.syncNow(); assert.equal(f.p.retryAt, 130_000); assert.equal(f.calls(), 3);
  f.handler(f.normal); f.p.resumeNetwork(); await f.settle();
  assert.equal(f.p.syncMessage, 'Synced with Drive');
  f.handler(async () => f.json({}, 429, { 'Retry-After': '120' }));
  await f.p.syncNow(); const calls = f.calls();
  f.navigator.onLine = false; f.p.connectivityChanged();
  f.navigator.onLine = true; f.p.connectivityChanged(); await f.settle();
  await f.p.manualSync(); assert.equal(f.calls(), calls);
  f.advance(120_000); f.handler(f.normal); await f.p.syncNow();
  assert.equal(f.p.syncMessage, 'Synced with Drive');
});

test('offline/online during an in-flight request cannot reinstall the old retry delay', async () => {
  const f = await fixture();
  let finish!: (value: any) => void;
  f.handler(() => new Promise(resolve => { finish = resolve; }));
  const running = f.p.syncNow();
  for (let n = 0; n < 20 && !finish; n++) await Promise.resolve();
  assert.ok(finish);
  f.navigator.onLine = false; f.p.connectivityChanged();
  f.navigator.onLine = true; f.p.connectivityChanged();
  f.handler(f.normal); finish(await f.normal({ url: '/files/root-folder' }));
  await running; await f.flush();
  assert.equal(f.p.retryAt, 0); assert.equal(f.p.syncMessage, 'Synced with Drive');
});

test('manual sync can probe an offline hint without re-enabling automatic requests', async () => {
  const f = await fixture(false);
  await f.p.manualSync(); assert.ok(f.calls() > 0);
  const calls = f.calls(); await f.p.syncNow();
  assert.equal(f.calls(), calls); assert.equal(f.p.syncMessage, 'Offline · changes saved locally');
});

test('idle checks consume deltas every 60 seconds; a saved edit resets the countdown', async () => {
  const f = await fixture(); await f.p.syncNow(); const requests = f.calls();
  assert.equal(f.timers.size, 1); assert.equal(f.delay(), 60_000);
  await f.tick(59_999); assert.equal(f.calls(), requests);
  await f.tick(1); assert.equal(f.calls(), requests + 2); assert.equal(f.delay(), 60_000);
  await f.tick(30_000); f.p.dirty = true; f.p.schedule(); assert.equal(f.timers.size, 1); assert.equal(f.delay(), 1500);
  await f.tick(1499); assert.equal(f.calls(), requests + 2);
  await f.tick(1); assert.equal(f.calls(), requests + 4); assert.equal(f.delay(), 60_000);
  // Many idle cycles use only root metadata + changes feed, never file listings.
  for (let i = 0; i < 60; i++) await f.tick(60_000);
  assert.equal(f.calls(), requests + 124); assert.equal(f.timers.size, 1);
});

test('edits during sync queue one follow-up; background/resume and pause control the timer', async () => {
  const f = await fixture(); await f.p.syncNow();
  let finish!: (value: any) => void;
  f.handler(() => new Promise(resolve => { finish = resolve; }));
  const running = f.p.syncNow();
  for (let i = 0; i < 20 && !finish; i++) await Promise.resolve();
  f.p.dirty = true; f.p.schedule(); f.p.schedule(); assert.equal(f.timers.size, 0);
  f.handler(f.normal); finish(await f.normal({ url: '/files/root-folder' })); await running;
  assert.equal(f.delay(), 1500); await f.flush(); assert.equal(f.p.dirty, false); assert.equal(f.delay(), 60_000);
  const calls = f.calls(); f.document.visibilityState = 'hidden'; f.p.visibilityChanged();
  f.p.dirty = true; f.p.schedule(); await f.tick(120_000); await f.p.syncNow();
  assert.equal(f.calls(), calls); assert.equal(f.timers.size, 0);
  f.document.visibilityState = 'visible'; f.p.visibilityChanged(); await f.settle();
  assert.ok(f.calls() > calls); assert.equal(f.delay(), 60_000);
  await f.p.setSyncEnabled(false); assert.equal(f.timers.size, 0);
  await f.p.setSyncEnabled(true); assert.equal(f.delay(), 60_000);
  f.p.onunload(); assert.equal(f.timers.size, 0);
});

test('missed offline event still blocks the scheduled request and waits for connectivity recovery', async () => {
  const f = await fixture(); await f.p.syncNow(); const calls = f.calls();
  f.navigator.onLine = false; await f.tick(60_000);
  assert.equal(f.calls(), calls); assert.equal(f.timers.size, 0);
  f.p.connectivityChanged(); f.navigator.onLine = true; f.p.connectivityChanged(); await f.settle();
  assert.equal(f.calls(), calls + 2); assert.equal(f.delay(), 60_000);
});

test('expired checkpoint stops automatic work until manual full reconciliation', async () => {
  const f = await fixture(); f.handler(async r => r.url.includes('/changes?') ? f.json({}, 410) : f.normal(r));
  await f.p.syncNow(); assert.equal(f.p.syncMessage, 'Full reconciliation required'); assert.equal(f.timers.size, 0);
  const calls = f.calls(); f.p.resumeNetwork(); await f.settle(); assert.equal(f.calls(), calls);
  f.handler(f.normal); await f.p.manualSync(true); assert.equal(f.p.syncMessage, 'Synced with Drive'); assert.equal(f.delay(), 60_000);
});


test('background/resume during a request catches up without keeping the interruption backoff', async () => {
  const f = await fixture(); let finish!: (value: any) => void;
  f.handler(() => new Promise(resolve => { finish = resolve; }));
  const running = f.p.syncNow();
  for (let i = 0; i < 20 && !finish; i++) await Promise.resolve();
  f.document.visibilityState = 'hidden'; f.p.visibilityChanged();
  f.document.visibilityState = 'visible'; f.p.visibilityChanged();
  f.handler(f.normal); finish(await f.normal({ url: '/files/root-folder' })); await running;
  assert.equal(f.p.retryAt, 0); assert.equal(f.delay(), 1500);
  await f.flush(); assert.equal(f.p.syncMessage, 'Synced with Drive'); assert.equal(f.delay(), 60_000);
});

test('reconnect-required grants stop automatic retries until sign-in is restored', async () => {
  const f = await fixture(); await f.p.syncNow();
  f.p.auth.state.status = 'needs-reconnect'; f.p.dirty = true; f.p.schedule();
  assert.equal(f.timers.size, 0); assert.equal(f.p.syncMessage, 'Reconnect Google');
});
