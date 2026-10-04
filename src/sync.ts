export interface RemoteFile { id: string; path: string }
export interface RemoteRead { content: string; etag: string }
export interface Baseline { id: string; hash: string }
export interface SyncState {
  format: 1;
  baseline: Record<string, Baseline>;
  pendingCreates: Record<string, string>;
  deleted: Record<string, boolean>;
}
export const emptySyncState = (): SyncState => ({ format: 1, baseline: {}, pendingCreates: {}, deleted: {} });
export class StaleWrite extends Error { constructor() { super('Remote file changed during synchronization.'); } }
export interface RemoteStore {
  list(): Promise<RemoteFile[]>;
  read(file: RemoteFile): Promise<RemoteRead>;
  reserveId(): Promise<string>;
  create(path: string, content: string, id: string): Promise<void>;
  update(file: RemoteFile, content: string, etag: string): Promise<void>;
}
export interface LocalStore {
  list(): Promise<string[]>;
  read(path: string): Promise<string | null>;
  replace(path: string, expected: string | null, content: string): Promise<boolean>;
}
export interface SyncResult { uploaded: number; downloaded: number; conflicts: string[]; pending: string[] }
export async function fingerprint(content: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function syncPath(path: string): boolean {
  return path.length <= 1000 && /\.md$/i.test(path) && path.split('/').every(part => !!part && !part.startsWith('.') && !/[\\\x00-\x1f\x7f:]/.test(part));
}
export function conflictPath(path: string, hash: string): string {
  return `${path.slice(0, -3)} (conflict ${hash.slice(0, 16)}).md`;
}

/** No overlapping runs. State commits only follow confirmed operations; all writes use a content precondition. */
export class SyncEngine {
  private running: Promise<SyncResult> | null = null;
  private stopped = false;
  constructor(private readonly local: LocalStore, private readonly remote: RemoteStore,
    readonly state: SyncState, private readonly save: () => Promise<void>) {}
  stop(): void { this.stopped = true; }
  run(): Promise<SyncResult> {
    if (this.running) return this.running;
    const operation = this.execute(); this.running = operation;
    void operation.finally(() => { if (this.running === operation) this.running = null; }).catch(() => {});
    return operation;
  }
  private alive(): void { if (this.stopped) throw new Error('Synchronization stopped.'); }
  private async execute(): Promise<SyncResult> {
    this.alive();
    // Complete both listings before making any changes. Failed or duplicate listings abort the run.
    const [locals, remotes] = await Promise.all([this.local.list(), this.remote.list()]);
    const byPath = new Map<string, RemoteFile>();
    for (const remote of remotes) {
      if (!syncPath(remote.path)) throw new Error('Drive contains an unsupported Markdown path.');
      if (byPath.has(remote.path)) throw new Error(`Duplicate Drive filename: ${remote.path}. Resolve it before syncing.`);
      byPath.set(remote.path, remote);
    }
    const result: SyncResult = { uploaded: 0, downloaded: 0, conflicts: [], pending: [] };
    const paths = [...new Set([...locals.filter(syncPath), ...byPath.keys(), ...Object.keys(this.state.baseline)])].sort();
    for (const path of paths) {
      this.alive();
      const local = await this.local.read(path);
      const remote = byPath.get(path);
      const base = this.state.baseline[path];
      if (!remote) {
        // An absent result is never permission to delete anything. Deletions and
        // remote moves require a separate reviewed reconciliation step.
        if (base) { result.pending.push(`${path}: remote file missing or moved; no deletion applied.`); continue; }
        if (local === null) continue;
        let id = this.state.pendingCreates[path];
        if (!id) { id = await this.remote.reserveId(); this.state.pendingCreates[path] = id; await this.save(); }
        this.alive();
        await this.remote.create(path, local, id);
        // Compare the actual remote content after uncertain/retried creates.
        const confirmed = await this.remote.read({ id, path });
        if (confirmed.content !== local) { result.pending.push(`${path}: previous upload recovered; checking again on the next run.`); continue; }
        this.state.baseline[path] = { id, hash: await fingerprint(local) };
        delete this.state.pendingCreates[path]; delete this.state.deleted[path];
        await this.save(); result.uploaded++; continue;
      }
      const snapshot = await this.remote.read(remote);
      this.alive();
      const remoteHash = await fingerprint(snapshot.content);
      if (local === null) {
        if (base && this.state.deleted[path]) {
          result.pending.push(`${path}: local deletion needs review; remote copy preserved.`); continue;
        }
        if (await this.local.replace(path, null, snapshot.content)) {
          this.state.baseline[path] = { id: remote.id, hash: remoteHash }; await this.save(); result.downloaded++;
        } else result.pending.push(`${path}: changed locally during download.`);
        continue;
      }
      const localHash = await fingerprint(local);
      if (localHash === remoteHash) {
        this.state.baseline[path] = { id: remote.id, hash: remoteHash };
        delete this.state.pendingCreates[path]; delete this.state.deleted[path]; await this.save(); continue;
      }
      if (base?.id === remote.id && base.hash === remoteHash) {
        // The server rejects a write if it changed after this snapshot.
        if (await this.local.read(path) !== local) { result.pending.push(`${path}: changed locally during upload preparation.`); continue; }
        try { await this.remote.update(remote, local, snapshot.etag); }
        catch (error) { if (error instanceof StaleWrite) { result.pending.push(`${path}: newer remote edit detected; retrying safely.`); continue; } throw error; }
        this.alive();
        this.state.baseline[path] = { id: remote.id, hash: localHash };
        delete this.state.deleted[path]; await this.save(); result.uploaded++;
      } else if (base?.id === remote.id && base.hash === localHash) {
        if (await this.local.replace(path, local, snapshot.content)) {
          this.state.baseline[path] = { id: remote.id, hash: remoteHash }; await this.save(); result.downloaded++;
        } else result.pending.push(`${path}: changed locally during download.`);
      } else {
        // Preserve the local branch before applying the remote branch. Stable
        // content-derived names make retries idempotent after interruption.
        const copy = conflictPath(path, localHash);
        const existing = await this.local.read(copy);
        if (existing !== local && (existing !== null || !await this.local.replace(copy, null, local))) {
          result.pending.push(`${path}: could not safely create its conflict copy.`); continue;
        }
        result.conflicts.push(copy);
        if (await this.local.replace(path, local, snapshot.content)) {
          this.state.baseline[path] = { id: remote.id, hash: remoteHash }; await this.save(); result.downloaded++;
        } else result.pending.push(`${path}: changed while preserving a conflict; original kept.`);
      }
    }
    this.alive();
    return result;
  }
}
