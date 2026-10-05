import { bytes, markdown, mimeType, MAX_FILE_BYTES, type Content } from './content';
import { StaleWrite, syncPath, type RemoteFile, type RemoteRead, type RemoteStore } from './sync';
import type { ProbeRequest, ProbeResponse, ProbeTransport } from './drive-probe';
const API = 'https://www.googleapis.com/drive/v3/files';
const V2 = 'https://www.googleapis.com/drive/v2/files';
const FOLDER = 'application/vnd.google-apps.folder';
export interface DriveFolder { id: string; name: string }
export function folderIdentifier(value: string): string {
  let id = value.trim();
  if (id.startsWith('https://')) {
    const url = new URL(id);
    if (url.hostname !== 'drive.google.com' || url.username || url.password || url.port) throw new Error('Use a Google Drive folder link or folder ID.');
    id = url.pathname.match(/^\/(?:drive\/(?:u\/\d+\/)?)?folders\/([A-Za-z0-9_-]+)\/?$/)?.[1] ?? '';
  }
  if (id === 'root') throw new Error('Choose a folder inside My Drive, not the whole Drive.');
  return identifier(id);
}
function object(response: ProbeResponse): Record<string, any> {
  try { const data = JSON.parse(response.text); if (!data || typeof data !== 'object') throw new Error(); return data; }
  catch { throw new Error('Invalid response from Google Drive.'); }
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid Drive file identifier.');
  return value;
}
export class DriveStore implements RemoteStore {
  private folders = new Map<string, string>();
  constructor(private readonly send: ProbeTransport, readonly folderId: string) { identifier(folderId); this.folders.set('', folderId); }
  static async createFolder(send: ProbeTransport, name: string, id: string): Promise<string> {
    const response = await send({ url: API, method: 'POST', contentType: 'application/json',
      body: JSON.stringify({ id: identifier(id), name, mimeType: FOLDER, appProperties: { driveSyncRoot: '1' } }) });
    if (response.status !== 200 && response.status !== 201 && response.status !== 409) throw new Error(`Could not create the Drive folder (HTTP ${response.status}).`);
    return id;
  }
  static async reserveId(send: ProbeTransport): Promise<string> {
    const response = await send({ url: `${API}/generateIds?count=1&space=drive&type=files`, method: 'GET' });
    if (response.status !== 200) throw new Error(`Could not reserve a file ID (HTTP ${response.status}).`);
    return identifier(object(response).ids?.[0]);
  }
  static async folder(send: ProbeTransport, id: string): Promise<DriveFolder> {
    const response = await send({ url: `${API}/${identifier(id)}?fields=id,name,mimeType,trashed,capabilities(canAddChildren)`, method: 'GET' });
    if (response.status !== 200) throw new Error(`Could not open the Drive folder (HTTP ${response.status}).`);
    const data = object(response);
    if (data.mimeType !== FOLDER || data.trashed || data.capabilities?.canAddChildren !== true) throw new Error('Choose an available Drive folder where you can add files.');
    return { id: identifier(data.id), name: typeof data.name === 'string' ? data.name : id };
  }
  static async childFolders(send: ProbeTransport, parent = 'root'): Promise<DriveFolder[]> {
    identifier(parent);
    const result: DriveFolder[] = []; let page = ''; const seen = new Set<string>();
    do {
      const params = new URLSearchParams({ q: `'${parent}' in parents and trashed = false and mimeType = '${FOLDER}'`, fields: 'files(id,name),nextPageToken,incompleteSearch', pageSize: '1000', spaces: 'drive', orderBy: 'name' });
      if (page) params.set('pageToken', page);
      const response = await send({ url: `${API}?${params}`, method: 'GET' });
      if (response.status !== 200) throw new Error(`Could not list Drive folders (HTTP ${response.status}).`);
      const data = object(response);
      if (data.incompleteSearch || !Array.isArray(data.files)) throw new Error('Drive returned an incomplete folder listing.');
      for (const file of data.files) {
        if (typeof file.name !== 'string') throw new Error('Invalid Drive folder listing.');
        result.push({ id: identifier(file.id), name: file.name });
      }
      page = data.nextPageToken ?? '';
      if (typeof page !== 'string' || (page && seen.has(page))) throw new Error('Invalid Drive pagination.');
      seen.add(page);
    } while (page);
    return result;
  }
  reserveId(): Promise<string> { return DriveStore.reserveId(this.send); }
  private async request(request: ProbeRequest): Promise<ProbeResponse> {
    const response = await this.send(request);
    if (response.status === 412) throw new StaleWrite();
    if (response.status !== 200 && response.status !== 201) throw new Error(`Google Drive request failed (HTTP ${response.status}). No file was assumed deleted.`);
    return response;
  }
  async verifyRoot(): Promise<void> {
    await DriveStore.folder(this.send, this.folderId);
  }
  async list(): Promise<RemoteFile[]> {
    await this.verifyRoot();
    this.folders = new Map([['', this.folderId]]);
    const result: RemoteFile[] = []; const seenFolders = new Set<string>();
    const walk = async (folder: string, prefix: string) => {
      if (seenFolders.has(folder) || seenFolders.size > 1000) throw new Error('Drive folder structure is invalid or too large for this beta.');
      seenFolders.add(folder);
      const names = new Set<string>(); let page = ''; const pages = new Set<string>();
      do {
        const params = new URLSearchParams({ q: `'${folder}' in parents and trashed = false`, fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,version)', pageSize: '1000', spaces: 'drive' });
        if (page) params.set('pageToken', page);
        const data = object(await this.request({ url: `${API}?${params}`, method: 'GET' }));
        if (data.incompleteSearch || !Array.isArray(data.files)) throw new Error('Drive returned an incomplete folder listing.');
        for (const item of data.files) {
          const id = identifier(item.id); const name = item.name;
          if (typeof name !== 'string' || !name || /[\/\\\x00-\x1f\x7f:]/.test(name) || name.startsWith('.')) continue;
          if (names.has(name)) throw new Error(`Duplicate Drive name: ${prefix}${name}. Rename the duplicate before syncing.`);
          names.add(name);
          const path = prefix + name;
          if (item.mimeType === FOLDER) { this.folders.set(path, id); await walk(id, `${path}/`); }
          else if (syncPath(path) && !String(item.mimeType).startsWith('application/vnd.google-apps.')) result.push({ id, path, version: typeof item.version === 'string' ? item.version : undefined });
        }
        page = data.nextPageToken ?? '';
        if (typeof page !== 'string' || page && pages.has(page)) throw new Error('Invalid Drive pagination.');
        pages.add(page);
      } while (page);
    };
    await walk(this.folderId, ''); return result;
  }
  private async metadata(file: RemoteFile): Promise<{ etag: string; version?: string }> {
    const data = object(await this.request({ url: `${V2}/${identifier(file.id)}?fields=id,etag,title,labels,parents,fileSize,version`, method: 'GET', headers: { 'Cache-Control': 'no-cache' } }));
    if (data.labels?.trashed || typeof data.etag !== 'string' || !/^"[^"\r\n]+"$/.test(data.etag) || Number(data.fileSize) > MAX_FILE_BYTES) {
      throw new Error('File is trashed, too large, or has no strong write validator.');
    }
    const parentPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    const expectedParent = this.folders.get(parentPath);
    if (data.title !== file.path.split('/').at(-1) || !expectedParent || !Array.isArray(data.parents) ||
        data.parents.length !== 1 || data.parents[0]?.id !== expectedParent) throw new Error('A Drive file moved or was renamed during synchronization. Retry after reviewing the folder.');
    return { etag: data.etag, version: typeof data.version === 'string' ? data.version : undefined };
  }
  async read(file: RemoteFile): Promise<RemoteRead> {
    try {
      const before = await this.metadata(file);
      const response = await this.request({ url: `${API}/${identifier(file.id)}?alt=media`, method: 'GET', headers: { 'Cache-Control': 'no-cache' } });
      const content = markdown(file.path) ? response.text : response.arrayBuffer;
      if (content === undefined || bytes(content).byteLength > MAX_FILE_BYTES) throw new Error('Missing binary response or file exceeds 20 MB.');
      const after = await this.metadata(file);
      if (before.etag !== after.etag) throw new StaleWrite();
      return { content, etag: after.etag, version: after.version };
    } catch (error) {
      if (error instanceof StaleWrite) throw error;
      throw new Error(`Reading ${file.path}: ${error instanceof Error ? error.message : 'Drive request failed.'}`);
    }
  }
  private async parent(path: string): Promise<string> {
    const parts = path.split('/'); parts.pop(); let prefix = ''; let parent = this.folderId;
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      let id = this.folders.get(prefix);
      if (!id) {
        id = await this.reserveId();
        const response = await this.request({ url: API, method: 'POST', contentType: 'application/json', body: JSON.stringify({ id, name: part, mimeType: FOLDER, parents: [parent] }) });
        id = identifier(object(response).id); this.folders.set(prefix, id);
      }
      parent = id;
    }
    return parent;
  }
  async create(path: string, content: Content, id: string): Promise<void> {
    if (!syncPath(path)) throw new Error('Unsupported file path.');
    const parent = await this.parent(path); const boundary = `ds_${crypto.randomUUID()}`;
    const metadata = { id: identifier(id), name: path.split('/').at(-1), mimeType: mimeType(path), parents: [parent] };
    const head = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType(path)}\r\n\r\n`);
    const data = bytes(content); const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    if (data.byteLength > MAX_FILE_BYTES) throw new Error('File exceeds 20 MB.');
    const body = new Uint8Array(head.length + data.length + tail.length);
    body.set(head); body.set(data, head.length); body.set(tail, head.length + data.length);
    const response = await this.send({ url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', method: 'POST',
      contentType: `multipart/related; boundary=${boundary}`, body: body.buffer });
    if (![200, 201, 409].includes(response.status)) throw new Error(`Upload was not confirmed (HTTP ${response.status}); its reserved ID is retained for retry.`);
  }
  async missing(id: string): Promise<'trashed' | 'unavailable' | 'outside'> {
    const response = await this.send({ url: `${API}/${identifier(id)}?fields=id,trashed`, method: 'GET' });
    if (response.status === 404) return 'unavailable';
    if (response.status !== 200) throw new Error(`Could not verify missing file (HTTP ${response.status}).`);
    return object(response).trashed === true ? 'trashed' : 'outside';
  }
  async trash(file: RemoteFile, etag: string): Promise<void> {
    await this.changeMetadata(file, { labels: { trashed: true } }, etag);
  }
  async move(file: RemoteFile, path: string, etag: string): Promise<void> {
    if (!syncPath(path)) throw new Error('Unsupported destination path.');
    const oldParent = this.folders.get(file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '');
    if (!oldParent) throw new Error('Unknown source folder.');
    const parent = await this.parent(path);
    const query = parent === oldParent ? '' : `&addParents=${parent}&removeParents=${oldParent}`;
    await this.changeMetadata(file, { title: path.split('/').at(-1) }, etag, query);
  }
  private async changeMetadata(file: RemoteFile, body: object, etag: string, query = ''): Promise<void> {
    if (!/^"[^"\r\n]+"$/.test(etag)) throw new Error('A strong version validator is required.');
    await this.request({ url: `${V2}/${identifier(file.id)}?fields=id${query}`, method: 'PUT',
      contentType: 'application/json', headers: { 'If-Match': etag }, body: JSON.stringify(body) });
  }
  async update(file: RemoteFile, content: Content, etag: string): Promise<void> {
    if (!/^"[^"\r\n]+"$/.test(etag)) throw new Error('A strong version validator is required.');
    await this.request({ url: `https://www.googleapis.com/upload/drive/v2/files/${identifier(file.id)}?uploadType=media&fields=id`,
      method: 'PUT', headers: { 'If-Match': etag }, contentType: mimeType(file.path), body: content });
  }
}
