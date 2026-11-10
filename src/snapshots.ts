import type { DataAdapter } from 'obsidian';
import { fingerprint } from './content';
import { MERGE_BYTES, mergeable, type SnapshotStore } from './merge';

type SnapshotAdapter = Pick<DataAdapter, 'stat' | 'mkdir' | 'read' | 'write' | 'rename' | 'list' | 'remove'>;
const HASH = /^[a-f0-9]{64}$/;
export function snapshotStore(adapter: SnapshotAdapter, root: string): SnapshotStore {
  const path = (hash: string) => {
    if (!HASH.test(hash)) throw new Error('Invalid snapshot reference.');
    return `${root}/${hash}.txt`;
  };
  const get = async (hash: string): Promise<string | null> => {
    const file = path(hash), stat = await adapter.stat(file);
    if (!stat || stat.type !== 'file' || stat.size > MERGE_BYTES) return null;
    const text = await adapter.read(file);
    return mergeable('note.md', text) && await fingerprint(text) === hash ? text : null;
  };
  return {
    get,
    async put(text) {
      if (!mergeable('note.md', text)) throw new Error('Snapshot exceeds automatic merge limits.');
      const hash = await fingerprint(text), target = path(hash);
      if (await get(hash) !== null) return hash;
      // Parent is the already-installed plugin directory; mkdir only our own child.
      if (!await adapter.stat(root)) await adapter.mkdir(root);
      const temp = `${root}/${crypto.randomUUID()}.tmp`;
      await adapter.write(temp, text);
      if (await fingerprint(await adapter.read(temp)) !== hash) throw new Error('Merge snapshot could not be saved.');
      if (await adapter.stat(target)) {
        // The old blob failed verification. Only replace it with bytes proven
        // to have the exact content-address already referenced by the journal.
        await adapter.write(target, text);
      } else await adapter.rename(temp, target);
      if (await get(hash) === null) throw new Error('Merge snapshot could not be verified.');
      return hash;
    },
    async collect(keep) {
      if (!await adapter.stat(root)) return;
      const { files } = await adapter.list(root);
      for (const file of files) {
        const name = file.slice(root.length + 1);
        if (!file.startsWith(`${root}/`) || name.includes('/')) continue;
        if ((/^[a-f0-9]{64}\.txt$/.test(name) && !keep.has(name.slice(0, -4))) || /^[a-f0-9-]{36}\.tmp$/.test(name)) await adapter.remove(file);
      }
    }
  };
}
