import { syncPath } from './content';
import type { RemoteFile } from './sync';
import type { ProbeTransport } from './drive-probe';

export interface IndexedFile extends RemoteFile { parent: string }
export interface DriveIndex {
  format: 1; folderId: string; cursor: string;
  folders: Record<string, string>; files: IndexedFile[];
}
const ROOT = 'https://www.googleapis.com/drive/v3/';
const FOLDER = 'application/vnd.google-apps.folder';
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;

/** Invalid acceleration state is discarded; the authoritative sync baseline is not. */
export function loadDriveIndex(value: unknown, folderId: string): DriveIndex | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as DriveIndex;
  if (v.format !== 1 || v.folderId !== folderId || !token(v.cursor) || !v.folders ||
      Array.isArray(v.folders) || typeof v.folders !== 'object' || !Array.isArray(v.files) || v.folders[''] !== folderId) return;
  const folderIds = new Set<string>();
  for (const [path, folder] of Object.entries(v.folders)) {
    if ((path !== '' && !syncPath(path)) || !id(folder) || folderIds.has(folder)) return;
    folderIds.add(folder);
  }
  const ids = new Set<string>(); const paths = new Set<string>();
  for (const file of v.files) {
    if (!file || !id(file.id) || !syncPath(file.path) || !id(file.parent) || ids.has(file.id) || paths.has(file.path) ||
        v.folders[file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''] !== file.parent ||
        (file.version !== undefined && typeof file.version !== 'string')) return;
    ids.add(file.id); paths.add(file.path);
  }
  return structuredClone(v);
}
export async function startCursor(send: ProbeTransport): Promise<string> {
  const r = await send({ url: `${ROOT}changes/startPageToken?fields=startPageToken`, method: 'GET' });
  if (r.status !== 200) throw new Error(`Could not establish Drive checkpoint (HTTP ${r.status}).`);
  const cursor: unknown = JSON.parse(r.text).startPageToken;
  if (!token(cursor)) throw new Error('Invalid Drive checkpoint.');
  return cursor;
}

/** Stage the entire change batch. Caller persists cursor and snapshot together only
 * after validation. Structural folder changes request a fresh scoped listing. */
export async function advanceIndex(send: ProbeTransport, current: DriveIndex): Promise<DriveIndex | undefined> {
  const next = structuredClone(current);
  const files = new Map(next.files.map(file => [file.id, file]));
  const folderPaths = new Map(Object.entries(next.folders).map(([path, folder]) => [folder, path]));
  let page = current.cursor; const pages = new Set<string>();
  for (;;) {
    if (pages.has(page)) throw new Error('Repeated Drive change page.');
    pages.add(page);
    const query = new URLSearchParams({ pageToken: page, pageSize: '1000', spaces: 'drive', includeRemoved: 'true',
      fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,trashed,version))' });
    const r = await send({ url: `${ROOT}changes?${query}`, method: 'GET' });
    if (r.status === 410) return; // Rebuild, never turn a lost cursor into deletions.
    if (r.status !== 200) throw new Error(`Could not read Drive changes (HTTP ${r.status}).`);
    const data = JSON.parse(r.text);
    if (!data || !Array.isArray(data.changes)) throw new Error('Incomplete Drive change response.');
    for (const change of data.changes) {
      if (!change || !id(change.fileId)) throw new Error('Invalid Drive change entry.');
      const knownFolder = folderPaths.has(change.fileId);
      const file = change.file;
      if (change.removed === true || file?.trashed === true) {
        if (knownFolder) return;
        files.delete(change.fileId); continue;
      }
      if (!file || file.id !== change.fileId || !Array.isArray(file.parents) || typeof file.mimeType !== 'string') {
        // Loss of metadata for a known item needs a complete listing, not a guess.
        if (knownFolder || files.has(change.fileId)) return;
        continue;
      }
      const parent = file.parents.length === 1 ? file.parents[0] : undefined;
      const prefix = folderPaths.get(parent);
      if (knownFolder || (file.mimeType === FOLDER && prefix !== undefined)) return;
      if (prefix === undefined) { files.delete(change.fileId); continue; }
      if (typeof file.name !== 'string' || /[\/\\]/.test(file.name)) throw new Error('Invalid Drive filename.');
      const path = prefix ? `${prefix}/${file.name}` : file.name;
      if (!syncPath(path) || file.mimeType.startsWith('application/vnd.google-apps.')) {
        files.delete(change.fileId); continue;
      }
      files.set(change.fileId, { id: change.fileId, path, parent, version: typeof file.version === 'string' ? file.version : undefined });
    }
    if (data.nextPageToken !== undefined) {
      if (!token(data.nextPageToken)) throw new Error('Invalid Drive change page.');
      page = data.nextPageToken; continue;
    }
    if (!token(data.newStartPageToken)) throw new Error('Drive did not confirm the end of its change feed.');
    next.cursor = data.newStartPageToken; break;
  }
  next.files = [...files.values()];
  const paths = new Set(Object.keys(next.folders).filter(Boolean));
  for (const file of next.files) {
    if (paths.has(file.path)) throw new Error(`Duplicate Drive name: ${file.path}. Resolve before syncing.`);
    paths.add(file.path);
  }
  return next;
}
