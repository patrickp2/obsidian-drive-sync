import { equalContent, fingerprint, syncPath, conflictPath, type Content } from './content';
export { fingerprint, syncPath, conflictPath } from './content';
export interface RemoteFile { id: string; path: string; version?: string }
export interface RemoteRead { content: Content; etag: string; version?: string }
export interface Baseline { id: string; hash: string; version?: string }
export interface SyncState {
  format: 1;
  baseline: Record<string, Baseline>;
  pendingCreates: Record<string, string>;
  deleted: Record<string, boolean>;
  renames?: Record<string, string>;
  moveTargets?: Record<string, string>;
  folderId?: string;
}
export const emptySyncState = (): SyncState => ({ format: 1, baseline: {}, pendingCreates: {}, deleted: {} });
export class StaleWrite extends Error { constructor() { super('Remote file changed during synchronization.'); } }
export interface RemoteStore {
  list(): Promise<RemoteFile[]>;
  read(file: RemoteFile): Promise<RemoteRead>;
  reserveId(): Promise<string>;
  create(path: string, content: Content, id: string): Promise<void>;
  update(file: RemoteFile, content: Content, etag: string): Promise<void>;
  move?(file: RemoteFile, path: string, etag: string): Promise<void>;
  trash?(file: RemoteFile, etag: string): Promise<void>;
  missing?(id: string): Promise<'trashed' | 'unavailable' | 'outside'>;
}
export interface LocalStore {
  list(): Promise<string[]>;
  read(path: string): Promise<Content | null>;
  unchanged?(path: string, hash: string): boolean;
  move?(path: string, destination: string, expected: Content): Promise<boolean>;
  trash?(path: string, expected: Content): Promise<boolean>;
  replace(path: string, expected: Content | null, content: Content): Promise<boolean>;
}
export interface SyncResult { uploaded: number; downloaded: number; conflicts: string[]; pending: string[] }
/** No overlapping runs. State commits only follow confirmed operations; all writes use a content precondition. */
export class SyncEngine {
  private running: Promise<SyncResult> | null = null;
  private stopped = false;
  constructor(private readonly local: LocalStore, private readonly remote: RemoteStore,
    readonly state: SyncState, private readonly save: () => Promise<void>, private readonly verifyAll = false) {}
  stop(): void { this.stopped = true; }
  run(): Promise<SyncResult> {
    if (this.running) return this.running;
    const operation = this.execute(); this.running = operation;
    void operation.finally(() => { if (this.running === operation) this.running = null; }).catch(() => {});
    return operation;
  }
  private alive(): void { if (this.stopped) throw new Error('Synchronization stopped.'); }
  private async reconcileMoves(locals: string[], remotes: RemoteFile[], result: SyncResult): Promise<Set<string>> {
    const blocked = new Set<string>();
    const byId = new Map(remotes.map(f => [f.id, f]));
    const journal = this.state.renames ??= {};
    const sent = this.state.moveTargets ??= {};
    for (const [old, base] of Object.entries(this.state.baseline)) {
      this.alive();
      const remote = byId.get(base.id);
      const intended = journal[old];
      const target = intended ?? (remote?.path !== old ? remote?.path : undefined);
      if (!target) continue;
      if (target === old && remote?.path === old) {
        if (intended) { delete journal[old]; delete sent[old]; await this.save(); }
        continue;
      }
      blocked.add(old); blocked.add(target);
      if (remote) blocked.add(remote.path);
      const pending = (why: string) => result.pending.push(`${old} → ${target}: ${why}`);
      if (!remote) { pending('remote file unavailable; move kept for review.'); continue; }
      if (intended && remote.path !== old && remote.path !== target && sent[old] !== remote.path) { pending('both devices chose different destinations.'); continue; }
      if (remotes.some(f => f.path === target && f.id !== base.id) || (this.state.baseline[target] && this.state.baseline[target]!.id !== base.id)) {
        pending('destination already exists; neither file overwritten.'); continue;
      }
      if (remote.path !== target && intended) {
        if (!this.remote.move) { pending('remote moves unavailable.'); continue; }
        const snapshot = await this.remote.read(remote);
        this.alive();
        if (journal[old] !== intended) { pending('destination changed locally; checking again.'); continue; }
        // Persist the attempted destination before sending. A second rename can
        // arrive while this request is in flight, including after a lost reply.
        sent[old] = target; await this.save(); this.alive();
        try { await this.remote.move(remote, target, snapshot.etag); }
        catch (error) { if (error instanceof StaleWrite) { pending('remote changed; retrying.'); continue; } throw error; }
        // Do not transfer the baseline yet. A new complete listing confirms an
        // uncertain move and catches name collisions introduced by another device.
        pending('move sent; verifying on the next check.'); continue;
      }
      const oldContent = await this.local.read(old);
      if (journal[old] !== intended) { pending('destination changed locally; checking again.'); continue; }
      if (oldContent !== null) {
        if (await this.local.read(target) !== null || !await this.local.move?.(old, target, oldContent)) {
          pending('local destination occupied or source changed.'); continue;
        }
        locals.push(target);
      } else if (!intended && this.state.deleted[old]) {
        // Concurrent remote rename and local delete: retain the renamed file.
        result.conflicts.push(target);
      }
      this.state.baseline[target] = base;
      delete this.state.baseline[old]; delete this.state.deleted[old]; delete journal[old];
      delete sent[old];
      if (this.state.pendingCreates[old]) { this.state.pendingCreates[target] = this.state.pendingCreates[old]!; delete this.state.pendingCreates[old]; }
      await this.save(); blocked.delete(target);
    }
    return blocked;
  }
  private async execute(): Promise<SyncResult> {
    this.alive();
    // Complete both listings before making any changes. Failed or duplicate listings abort the run.
    const [locals, remotes] = await Promise.all([this.local.list(), this.remote.list()]);
    const byPath = new Map<string, RemoteFile>();
    const portable = new Map<string, string>();
    for (const path of [...locals.filter(syncPath), ...remotes.map(f => f.path)]) {
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        const key = prefix.normalize('NFC').toLocaleLowerCase('en-US');
        const previous = portable.get(key);
        if (previous && previous !== prefix) throw new Error(`Case or Unicode filename collision: ${previous} / ${prefix}. Rename one before syncing.`);
        portable.set(key, prefix);
      }
    }
    for (const remote of remotes) {
      if (!syncPath(remote.path)) throw new Error('Drive contains an unsupported file path.');
      if (byPath.has(remote.path)) throw new Error(`Duplicate Drive filename: ${remote.path}. Resolve it before syncing.`);
      byPath.set(remote.path, remote);
    }
    const result: SyncResult = { uploaded: 0, downloaded: 0, conflicts: [], pending: [] };
    const blocked = await this.reconcileMoves(locals, remotes, result);
    const paths = [...new Set([...locals.filter(syncPath), ...byPath.keys(), ...Object.keys(this.state.baseline)])].sort();
    for (const path of paths) {
      this.alive();
      if (blocked.has(path)) continue;
      const remote = byPath.get(path);
      const base = this.state.baseline[path];
      if (!this.verifyAll && base?.id === remote?.id && remote?.version && base?.version === remote.version &&
          !this.state.deleted[path] && !this.state.pendingCreates[path] && this.local.unchanged?.(path, base.hash)) continue;
      const local = await this.local.read(path);
      // Rename events can arrive after the initial listing/reconciliation.
      // Never download an intermediate destination as an unrelated new file.
      if (Object.entries(this.state.renames ?? {}).some(([source, target]) =>
        target === path || (this.state.baseline[source] && (source === path || this.state.baseline[source]!.id === remote?.id)))) continue;
      if (!remote) {
        if (base) {
          // A 404, lost permission, or move outside the root is never deletion evidence.
          const missing = await this.remote.missing?.(base.id);
          this.alive();
          if (missing !== 'trashed') { result.pending.push(`${path}: remote file missing or moved; no deletion applied.`); continue; }
          if (local !== null) {
            if (await fingerprint(local) !== base.hash) {
              // An edit beats a concurrent deletion. Keep it under a distinct name.
              const copy = conflictPath(path, await fingerprint(local));
              const existing = await this.local.read(copy);
              if (!equalContent(existing, local) && (existing !== null || !await this.local.replace(copy, null, local))) {
                result.pending.push(`${path}: could not preserve edit after remote deletion.`); continue;
              }
              result.conflicts.push(copy);
            }
            if (!await this.local.trash?.(path, local)) { result.pending.push(`${path}: could not move local file to recovery trash.`); continue; }
          }
          delete this.state.baseline[path]; delete this.state.deleted[path]; delete this.state.pendingCreates[path];
          await this.save(); continue;
        }
        if (local === null) continue;
        let id = this.state.pendingCreates[path];
        if (!id) { id = await this.remote.reserveId(); this.state.pendingCreates[path] = id; await this.save(); }
        this.alive();
        await this.remote.create(path, local, id);
        // Compare the actual remote content after uncertain/retried creates.
        const confirmed = await this.remote.read({ id, path });
        if (!equalContent(confirmed.content, local)) { result.pending.push(`${path}: previous upload recovered; checking again on the next run.`); continue; }
        this.state.baseline[path] = { id, hash: await fingerprint(local), version: confirmed.version };
        delete this.state.pendingCreates[path];
        if (await this.local.read(path) !== null) delete this.state.deleted[path];
        await this.save(); result.uploaded++; continue;
      }
      if (!this.verifyAll && base?.id === remote.id && remote.version && base.version === remote.version && local !== null && await fingerprint(local) === base.hash) continue;
      const snapshot = await this.remote.read(remote);
      this.alive();
      const remoteHash = await fingerprint(snapshot.content);
      if (local === null) {
        if (base && this.state.deleted[path]) {
          if (base.id === remote.id && base.hash === remoteHash && this.remote.trash) {
            // Recheck local absence after the network request; restore/edit wins.
            if (await this.local.read(path) !== null) { result.pending.push(`${path}: restored locally during deletion.`); continue; }
            try { await this.remote.trash(remote, snapshot.etag); }
            catch (error) { if (error instanceof StaleWrite) { result.pending.push(`${path}: remote changed before deletion; retrying.`); continue; } throw error; }
            delete this.state.baseline[path]; delete this.state.deleted[path]; await this.save(); continue;
          }
          if (!this.remote.trash) { result.pending.push(`${path}: local deletion needs review; remote copy preserved.`); continue; }
          // The other device edited the file after our baseline. Restore that edit.
          result.conflicts.push(path);
          delete this.state.deleted[path];
        }
        if (await this.local.replace(path, null, snapshot.content)) {
          this.state.baseline[path] = { id: remote.id, hash: remoteHash, version: snapshot.version }; await this.save(); result.downloaded++;
        } else result.pending.push(`${path}: changed locally during download.`);
        continue;
      }
      const localHash = await fingerprint(local);
      if (localHash === remoteHash) {
        if (base?.id === remote.id && base.hash === remoteHash && base.version === snapshot.version &&
            !this.state.pendingCreates[path] && !this.state.deleted[path]) continue;
        this.state.baseline[path] = { id: remote.id, hash: remoteHash, version: snapshot.version };
        delete this.state.pendingCreates[path];
        if (await this.local.read(path) !== null) delete this.state.deleted[path]; await this.save(); continue;
      }
      if (base?.id === remote.id && base.hash === remoteHash) {
        // The server rejects a write if it changed after this snapshot.
        if (!equalContent(await this.local.read(path), local)) { result.pending.push(`${path}: changed locally during upload preparation.`); continue; }
        try { await this.remote.update(remote, local, snapshot.etag); }
        catch (error) { if (error instanceof StaleWrite) { result.pending.push(`${path}: newer remote edit detected; retrying safely.`); continue; } throw error; }
        this.alive();
        this.state.baseline[path] = { id: remote.id, hash: localHash };
        if (await this.local.read(path) !== null) delete this.state.deleted[path];
        await this.save(); result.uploaded++;
      } else if (base?.id === remote.id && base.hash === localHash) {
        if (await this.local.replace(path, local, snapshot.content)) {
          this.state.baseline[path] = { id: remote.id, hash: remoteHash, version: snapshot.version }; await this.save(); result.downloaded++;
        } else result.pending.push(`${path}: changed locally during download.`);
      } else {
        // Preserve the local branch before applying the remote branch. Stable
        // content-derived names make retries idempotent after interruption.
        const copy = conflictPath(path, localHash);
        const existing = await this.local.read(copy);
        if (!equalContent(existing, local) && (existing !== null || !await this.local.replace(copy, null, local))) {
          result.pending.push(`${path}: could not safely create its conflict copy.`); continue;
        }
        result.conflicts.push(copy);
        if (await this.local.replace(path, local, snapshot.content)) {
          this.state.baseline[path] = { id: remote.id, hash: remoteHash, version: snapshot.version }; await this.save(); result.downloaded++;
        } else result.pending.push(`${path}: changed while preserving a conflict; original kept.`);
      }
    }
    this.alive();
    return result;
  }
}
