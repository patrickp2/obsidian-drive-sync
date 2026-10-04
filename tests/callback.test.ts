import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const html = readFileSync('docs/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
function run(query: string, fragment = '') {
  const nodes: Record<string, any> = {
    status: { textContent: 'Start Google sign-in' },
    actions: { children: [] as any[], append(child: any) { this.children.push(child); } }
  };
  let ready!: () => void;
  let copied = '';
  const replacements: unknown[][] = [];
  vm.runInNewContext(script, { URLSearchParams,
    location: { search: query, hash: fragment, pathname: '/obsidian-drive-sync/' },
    history: { replaceState: (...args: unknown[]) => replacements.push(args) },
    navigator: { clipboard: { writeText: async (value: string) => { copied = value; } } },
    document: { addEventListener: (_: string, listener: () => void) => { ready = listener; },
      getElementById: (id: string) => nodes[id], createElement: (tag: string) => ({ tag,
        addEventListener(_event: string, listener: () => void) { this.click = listener; }, click: () => {} }) }
  });
  // Query removal must happen before the DOM callback, not after user interaction.
  assert.deepEqual(replacements[0]?.slice(1), ['', '/obsidian-drive-sync/']);
  ready();
  return { nodes, copied: () => copied };
}
test('generated callback CSP authorizes only its exact inline script and no network connections', () => {
  assert.ok(html.includes(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`));
  assert.ok(html.includes("connect-src 'none'"));
  assert.ok(html.includes('name="referrer" content="no-referrer"'));
  assert.equal(/<script[^>]+src=/.test(html), false);
});
test('callback removes credentials from address bar and produces a fixed Obsidian return link', async () => {
  const state = 'b'.repeat(43);
  const f = run(`?state=${state}&code=synthetic-code&redirect=https://attacker.invalid`);
  const [open, copy] = f.nodes.actions.children;
  assert.equal(new URL(open.href).hostname, 'drive-sync-auth');
  assert.equal(open.href.includes('attacker'), false);
  await copy.click(); assert.equal(f.copied(), open.href);
  assert.equal(f.nodes.status.textContent.includes('synthetic-code'), false);
});
test('invalid callbacks provide no return link and do not render raw values', () => {
  for (const query of ['?code=<img>', `?state=${'c'.repeat(43)}&code=x&code=y`]) {
    const f = run(query); assert.equal(f.nodes.actions.children.length, 0);
    assert.equal(f.nodes.status.textContent.includes('<img>'), false);
  }
  assert.equal(run('', '#code=x').nodes.actions.children.length, 0);
});
