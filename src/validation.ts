import { fingerprint } from './content';
import type { ProbeRequest } from './drive-probe';

export const VALIDATION_ROOT = 'Drive Sync validation';
export const VALIDATION_MANIFEST = `${VALIDATION_ROOT}/manifest.json`;
export interface ValidationReader { read(path: string): Promise<string>; readBinary(path: string): Promise<ArrayBuffer>; list(): string[] }
export async function validateFixture(reader: ValidationReader): Promise<string> {
  const data = JSON.parse(await reader.read(VALIDATION_MANIFEST)) as { kind?: string; files?: Record<string, string> };
  if (data.kind !== 'drive-sync-synthetic-validation-v1' || !data.files || typeof data.files !== 'object' || Array.isArray(data.files)) throw new Error('A synthetic validation manifest is required.');
  const entries = Object.entries(data.files);
  if (!entries.length || entries.length > 2500 || entries.some(([path, hash]) => !path.startsWith(`${VALIDATION_ROOT}/`) || path.split('/').some(p => !p || p === '.' || p === '..') || path.includes('\\') || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid synthetic manifest.');
  const actual = new Set(reader.list().filter(p => p.startsWith(`${VALIDATION_ROOT}/`) && p !== VALIDATION_MANIFEST));
  let bytes = 0;
  for (const [path, expected] of entries) {
    if (!actual.delete(path)) throw new Error(`Missing synthetic file: ${path}`);
    const content = await reader.readBinary(path); bytes += content.byteLength;
    if (await fingerprint(content) !== expected) throw new Error(`Synthetic checksum mismatch: ${path}`);
  }
  if (actual.size) throw new Error(`${actual.size} unexpected synthetic files; inspect for duplicates or conflicts.`);
  return `PASS: ${entries.length} files, ${bytes} bytes, all SHA-256 checksums match; no extra files.`;
}
/** A developer-only barrier after a real Google response, before engine checkpointing. No credentials or bodies are logged. */
export class TransferBarrier {
  private mode?: 'upload' | 'download';
  private pending?: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  status = 'No interruption armed.';
  constructor(private readonly changed: () => void = () => {}) {}
  arm(mode: 'upload' | 'download'): void {
    if (this.pending || this.mode) throw new Error('An interruption test is already armed.');
    this.mode = mode; this.status = `Armed: next successful ${mode} response.`; this.changed();
  }
  async after(request: ProbeRequest, status: number): Promise<void> {
    if (status < 200 || status >= 300 || !this.mode) return;
    const url = new URL(request.url);
    const upload = url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/upload/drive/') && ['POST', 'PUT'].includes(request.method);
    const download = url.hostname === 'www.googleapis.com' && request.method === 'GET' && url.searchParams.get('alt') === 'media';
    if (!(this.mode === 'upload' ? upload : download)) return;
    const mode = this.mode; this.mode = undefined;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.stop(), 120_000);
      this.pending = { resolve, reject, timer };
      this.status = `Held ${mode} response after Google success, before local checkpoint. Force-close the test app now, or release the response.`;
      this.changed();
    });
  }
  release(): void { this.mode = undefined; if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve(); this.pending = undefined; } this.status = 'Test barrier released.'; this.changed(); }
  stop(): void { this.mode = undefined; if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('Synthetic transfer interruption.')); this.pending = undefined; } this.status = 'Test barrier cancelled.'; this.changed(); }
}
