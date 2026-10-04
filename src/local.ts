import { equalContent, markdown, syncPath, type Content } from './content';
import type { LocalStore } from './sync';
export interface VaultPort {
  list(): string[];
  read(path: string): Promise<Content | null>;
  create(path: string, content: Content): Promise<void>;
  rename(path: string, destination: string): Promise<void>;
  process(path: string, update: (current: string) => string): Promise<void>;
  bufferMatches(path: string, expected: Content): boolean;
  active(): boolean;
}
/** Binary replacements and propagated removals keep the actual old file in
 * vault-local recovery trash, including any late writer's bytes. Never delete. */
export function localStore(port: VaultPort): LocalStore {
  const active = (path: string) => port.active() && syncPath(path);
  const restore = async (backup: string, path: string) => {
    if (await port.read(path) === null) await port.rename(backup, path);
  };
  const retire = async (path: string, expected: Content): Promise<string | null> => {
    if (!active(path) || !port.bufferMatches(path, expected) || !equalContent(await port.read(path), expected)) return null;
    const backup = `.trash/drive-sync/${crypto.randomUUID()}/${path}`;
    await port.rename(path, backup);
    if (!equalContent(await port.read(backup), expected) || !port.active()) {
      await restore(backup, path); return null;
    }
    return backup;
  };
  return {
    list: async () => port.list().filter(syncPath), read: path => port.read(path),
    replace: async (path, expected, content) => {
      if (!active(path)) return false;
      if (expected === null) {
        if (await port.read(path) !== null || !active(path)) return false;
        try { await port.create(path, content); return true; }
        catch (error) { if (await port.read(path) !== null) return false; throw error; }
      }
      if (markdown(path) && typeof expected === 'string' && typeof content === 'string') {
        const changed = new Error('Local content changed.');
        try {
          await port.process(path, current => {
            if (!active(path) || current !== expected || !port.bufferMatches(path, expected)) throw changed;
            return content;
          });
          return true;
        } catch (error) { if (error === changed) return false; throw error; }
      }
      const backup = await retire(path, expected);
      if (!backup) return false;
      try {
        if (!active(path) || await port.read(path) !== null) { await restore(backup, path); return false; }
        await port.create(path, content); return true;
      } catch (error) { await restore(backup, path); throw error; }
    },
    trash: async (path, expected) => !!await retire(path, expected),
    move: async (path, destination, expected) => {
      if (!active(destination) || await port.read(destination) !== null) return false;
      const backup = await retire(path, expected);
      if (!backup) return false;
      try {
        if (!active(destination) || await port.read(destination) !== null) { await restore(backup, path); return false; }
        await port.create(destination, expected); return true;
      } catch (error) { await restore(backup, path); throw error; }
    }
  };
}
