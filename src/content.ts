/** Files remain ordinary bytes in Drive. Only Markdown is decoded as text. */
export type Content = string | ArrayBuffer;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export function bytes(value: Content): Uint8Array<ArrayBuffer> {
  return typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
}
export function equalContent(a: Content | null, b: Content | null): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  const x = bytes(a), y = bytes(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
export async function fingerprint(content: Content): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(content)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function markdown(path: string): boolean { return /\.md$/i.test(path); }
export function syncPath(path: string): boolean {
  return !!path && path.length <= 1000 && path.split('/').every(part => !!part && !part.startsWith('.') &&
    !/[\\\x00-\x1f\x7f:]/.test(part) && !/[. ]$/.test(part) && !['__proto__', 'constructor', 'prototype'].includes(part));
}
export function conflictPath(path: string, hash: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
  return `${extension ? path.slice(0, -extension.length) : path} (conflict ${hash.slice(0, 16)})${extension}`;
}
export function mimeType(path: string): string {
  const ext = path.split('.').at(-1)?.toLowerCase();
  return ({ md: 'text/markdown', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', canvas: 'application/json', txt: 'text/plain' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
}
