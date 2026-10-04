import { emptySyncState, type SyncState } from './sync';
import { syncPath } from './content';
export function loadState(value: unknown, folderId: string): SyncState {
  if (value === undefined) return { ...emptySyncState(), folderId };
  const state = value as SyncState;
  const record = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v);
  if (!state || state.format !== 1 || !record(state.baseline) || !record(state.pendingCreates) || !record(state.deleted) || (state.renames !== undefined && !record(state.renames))) throw new Error('Sync state is invalid. Automatic sync has not started.');
  if (state.folderId && state.folderId !== folderId) throw new Error('This sync state belongs to another Drive folder. Automatic sync has not started.');
  for (const [path, base] of Object.entries(state.baseline)) {
    if (!syncPath(path) || !base || !/^[A-Za-z0-9_-]+$/.test(base.id) || !/^[a-f0-9]{64}$/.test(base.hash)) throw new Error('Sync baseline is invalid.');
  }
  for (const [path, id] of Object.entries(state.pendingCreates)) if (!syncPath(path) || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Pending upload state is invalid.');
  for (const [path, deleted] of Object.entries(state.deleted)) if (!syncPath(path) || typeof deleted !== 'boolean') throw new Error('Deletion state is invalid.');
  for (const [path, target] of Object.entries(state.renames ?? {})) if (!syncPath(path) || typeof target !== 'string' || !syncPath(target)) throw new Error('Rename state is invalid.');
  return { ...state, folderId, renames: state.renames ?? {} };
}
/** Record observed file and folder events before any network reconciliation. */
export function recordRename(state: SyncState, old: string, destination: string): void {
  if (!syncPath(old) || !syncPath(destination)) return;
  const journal = state.renames ??= {};
  for (const source of new Set([...Object.keys(state.baseline), ...Object.keys(state.pendingCreates)])) {
    const current = journal[source] ?? source;
    if (current === old || current.startsWith(`${old}/`)) {
      const target = destination + current.slice(old.length);
      if (target === source) delete journal[source]; else journal[source] = target;
    }
  }
}
export function recordDeletion(state: SyncState, path: string): void {
  if (!syncPath(path)) return;
  for (const source of new Set([...Object.keys(state.baseline), ...Object.keys(state.pendingCreates)])) {
    const current = state.renames?.[source] ?? source;
    if (current === path || current.startsWith(`${path}/`)) {
      state.deleted[source] = true;
      if (state.renames) delete state.renames[source];
    }
  }
}
