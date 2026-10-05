import { fingerprint, type Content } from './content';

/** Memory-only content fingerprints. Restart/resume/full reconciliation clears
 * them. Stat checks plus event generations invalidate same-size, same-time edits. */
export class LocalIndex {
  private epoch = 0;
  private generations = new Map<string, number>();
  private entries = new Map<string, { stamp: string; hash: string; generation: number; epoch: number }>();
  constructor(private readonly stat: (path: string) => string | undefined) {}
  clear(): void { this.epoch++; this.entries.clear(); this.generations.clear(); }
  invalidate(path: string): void {
    this.generations.set(path, (this.generations.get(path) ?? 0) + 1);
    this.entries.delete(path);
    for (const child of this.entries.keys()) if (child.startsWith(`${path}/`)) this.entries.delete(child);
  }
  matches(path: string, hash: string): boolean {
    const entry = this.entries.get(path);
    return !!entry && entry.epoch === this.epoch && entry.generation === (this.generations.get(path) ?? 0) &&
      entry.hash === hash && entry.stamp === this.stat(path);
  }
  async read(path: string, read: () => Promise<Content | null>): Promise<Content | null> {
    const epoch = this.epoch, generation = this.generations.get(path) ?? 0, stamp = this.stat(path);
    const content = await read();
    if (content === null || stamp === undefined) { this.entries.delete(path); return content; }
    const hash = await fingerprint(content);
    if (epoch === this.epoch && generation === (this.generations.get(path) ?? 0) && stamp === this.stat(path)) {
      this.entries.set(path, { stamp, hash, generation, epoch });
    }
    return content;
  }
}
