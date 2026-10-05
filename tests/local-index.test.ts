import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalIndex } from '../src/local-index';
import { fingerprint } from '../src/content';
test('local fingerprints invalidate on stat changes, same-stat edit events and resume', async () => {
  let stamp = 'same'; const index = new LocalIndex(() => stamp); const hash = await fingerprint('one');
  await index.read('a.md', async () => 'one'); assert.equal(index.matches('a.md', hash), true);
  stamp = 'changed'; assert.equal(index.matches('a.md', hash), false);
  await index.read('a.md', async () => 'one'); index.invalidate('a.md'); assert.equal(index.matches('a.md', hash), false);
  await index.read('a.md', async () => 'one'); index.clear(); assert.equal(index.matches('a.md', hash), false);
});
test('edits or resume while content is being read cannot populate a stale fingerprint', async () => {
  for (const clear of [false, true]) {
    const index = new LocalIndex(() => 'same'); let release!: (value: string) => void;
    const pending = index.read('a.md', () => new Promise(resolve => { release = resolve; }));
    if (clear) index.clear(); else index.invalidate('a.md');
    release('before'); await pending;
    assert.equal(index.matches('a.md', await fingerprint('before')), false);
  }
});
