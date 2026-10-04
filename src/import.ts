import { equalContent, syncPath } from './content';
import type { LocalStore, RemoteRead } from './sync';
export interface ImportFile extends RemoteRead { name: string }
export async function importFiles(ids: string[], contained: Set<string>, read: (id: string) => Promise<ImportFile>, local: LocalStore): Promise<string[]> {
  const imported: string[] = [];
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid selected file.');
    if (contained.has(id)) continue; // Authorization is enough for files already in this sync tree.
    const file = await read(id);
    if (!syncPath(file.name) || file.name.includes('/')) throw new Error('Selected file has an unsupported name.');
    // Stable per-source directory makes retries safe and avoids basename collisions.
    const path = `Imported from Drive/${id}/${file.name}`;
    const existing = await local.read(path);
    if (equalContent(existing, file.content)) { imported.push(path); continue; }
    if (existing !== null || !await local.replace(path, null, file.content)) throw new Error(`Import preserved an existing local file: ${path}. Move it before importing this source again.`);
    imported.push(path);
  }
  return imported;
}
