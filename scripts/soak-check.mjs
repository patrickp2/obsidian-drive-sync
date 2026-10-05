// Bounded test-fixture checks; never reads credential storage or touches other vaults.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';

const repo = resolve(import.meta.dirname, '..');
const root = resolve(repo, 'test-vaults/drive-sync-auth');
const prefix = 'Drive Sync validation/';
const manifestPath = resolve(root, prefix, 'manifest.json');
const logPath = resolve(repo, 'test-vaults/.drive-sync-soak.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.kind !== 'drive-sync-synthetic-validation-v1' || !manifest.files || Object.keys(manifest.files).length !== 259) throw new Error('Expected the disposable 259-file fixture.');
const paths = Object.keys(manifest.files);
if (paths.some(path => !path.startsWith(prefix) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..'))) throw new Error('Unsafe fixture path.');
const stateFile = resolve(root, '.obsidian/plugins/drive-sync/data.json');
const { folderId, syncState: state } = JSON.parse(await readFile(stateFile, 'utf8'));
if (folderId !== '1dooGLDVgYtptBobZcBuEw9ymaT1SEkve' || state.folderId !== folderId) throw new Error('The disposable test folder changed.');
const expected = new Set(paths);
async function walk(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not accepted in the fixture.');
    if (entry.isDirectory()) await walk(path);
    else if (path !== manifestPath && !expected.delete(relative(root, path))) throw new Error('Unexpected fixture file; inspect for duplicates/conflicts.');
  }
}
await walk(resolve(root, prefix));
if (expected.size) throw new Error('Fixture files are missing.');
let confirmed = 0;
for (const path of paths) {
  if (hash(await readFile(resolve(root, path))) !== manifest.files[path]) throw new Error(`Local checksum mismatch: ${path}`);
  if (state.baseline[path]?.hash === manifest.files[path]) confirmed++;
}
const ids = Object.values(state.baseline).map(item => item.id);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate baseline identity.');
const pending = ['pendingCreates', 'deleted', 'renames', 'moveTargets'].reduce((n, key) => n + Object.keys(state[key] ?? {}).length, 0);
let log;
try { log = JSON.parse(await readFile(logPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; log = { started: new Date().toISOString(), round: 0, checks: [] }; }
const now = new Date();
const result = { at: now.toISOString(), files: paths.length, confirmedDriveBaselines: confirmed, pending, round: log.round };
log.checks.push(result);
log.checks = log.checks.slice(-100);
if (process.argv.includes('--advance')) {
  if (confirmed !== paths.length || pending) throw new Error('Previous round has not converged; no new edits made.');
  if (log.lastAdvance && now - new Date(log.lastAdvance) < 12 * 60 * 60 * 1000) throw new Error('Wait twelve hours between soak rounds.');
  log.round++;
  for (let i = 0; i < 12; i++) {
    const path = `${prefix}Batch 00/Note ${String(i).padStart(4, '0')}.md`;
    if (!Object.hasOwn(manifest.files, path)) throw new Error('Expected test note is absent.');
    const content = await readFile(resolve(root, path), 'utf8') + `\nSoak round ${log.round}: ${now.toISOString()}\n`;
    await writeFile(resolve(root, path), content);
    manifest.files[path] = hash(content);
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  log.lastAdvance = now.toISOString();
  result.advancedToRound = log.round;
}
await writeFile(logPath, JSON.stringify(log, null, 2) + '\n');
console.log(JSON.stringify(result));
if (confirmed !== paths.length || pending) process.exitCode = 2;
