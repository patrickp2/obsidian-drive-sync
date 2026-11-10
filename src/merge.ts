import { diff3Merge } from 'node-diff3';
import { bytes, fingerprint, markdown, type Content } from './content';

export const MERGE_BYTES = 256 * 1024;
export const MERGE_LINES = 2000;
// Keep terminators as part of each token, including CRLF and a missing final newline.
export const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
export function mergeable(path: string, content: Content): content is string {
  return markdown(path) && typeof content === 'string' && bytes(content).length <= MERGE_BYTES && lines(content).length <= MERGE_LINES;
}
export type MergeResult = { text: string } | { reason: 'overlapping edits' | 'note exceeds automatic merge limits' };
export function mergeText(base: string, local: string, remote: string): MergeResult {
  if (![base, local, remote].every(text => mergeable('note.md', text))) return { reason: 'note exceeds automatic merge limits' };
  const blocks = diff3Merge(lines(local), lines(base), lines(remote), { excludeFalseConflicts: true });
  if (blocks.some(block => 'conflict' in block)) return { reason: 'overlapping edits' };
  const text = blocks.flatMap(block => block.ok ?? []).join('');
  return mergeable('note.md', text) ? { text } : { reason: 'note exceeds automatic merge limits' };
}
/** Content-addressed, device-local snapshots. Never trust bytes without their hash. */
export interface SnapshotStore {
  put(text: string): Promise<string>;
  get(hash: string): Promise<string | null>;
  collect(keep: ReadonlySet<string>): Promise<void>;
}
export async function verifiedSnapshot(store: SnapshotStore | undefined, hash: string): Promise<string | null> {
  const text = await store?.get(hash);
  return text !== null && text !== undefined && mergeable('note.md', text) && await fingerprint(text) === hash ? text : null;
}
