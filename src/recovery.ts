import type { DataAdapter } from 'obsidian';
import { markdown, MAX_FILE_BYTES, type Content } from './content';

export const recoveryPath = (path: string): boolean => path.startsWith('.trash/drive-sync/') &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..') && !path.includes('\\');

/** Hidden recovery files are absent from Obsidian's indexed Vault API. */
export function recoveryStorage(adapter: Pick<DataAdapter, 'stat' | 'mkdir' | 'read' | 'readBinary' | 'rename'>) {
  return {
    async folders(path: string, createVisible: (path: string) => Promise<unknown>): Promise<void> {
      const parts = path.split('/'); parts.pop(); let folder = '';
      for (const part of parts) {
        folder = folder ? `${folder}/${part}` : part;
        const existing = await adapter.stat(folder);
        if (existing) {
          if (existing.type !== 'folder') throw new Error(`A file occupies the folder path: ${folder}`);
          continue;
        }
        try {
          if (recoveryPath(path)) await adapter.mkdir(folder);
          else await createVisible(folder);
        } catch (error) {
          if ((await adapter.stat(folder))?.type !== 'folder') throw error;
        }
      }
    },
    async read(path: string): Promise<Content | null> {
      if (!recoveryPath(path)) throw new Error('Invalid recovery path.');
      const stat = await adapter.stat(path);
      if (!stat) return null;
      if (stat.type !== 'file' || stat.size > MAX_FILE_BYTES) throw new Error('Unsupported recovery file.');
      return markdown(path) ? adapter.read(path) : adapter.readBinary(path);
    },
    async restore(path: string, destination: string): Promise<void> {
      if (!recoveryPath(path) || await adapter.stat(destination)) throw new Error('Recovery destination is occupied.');
      await adapter.rename(path, destination);
    }
  };
}
