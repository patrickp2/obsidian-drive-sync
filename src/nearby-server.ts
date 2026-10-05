import { privateAddress, seal, unseal, type Envelope } from './pairing';
import type { NearbyConfig, NearbyLink } from './nearby';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface NearbyServer extends NearbyLink { config: NearbyConfig }
export async function startNearbyServer(folderId: string, key: string, session: string, port: number,
  changed: () => void): Promise<NearbyServer> {
  const http = require('node:http') as typeof import('node:http');
  const os = require('node:os') as typeof import('node:os');
  const entries = Object.entries(os.networkInterfaces()).sort(([a], [b]) => Number(!/^en\d+$/.test(a)) - Number(!/^en\d+$/.test(b)));
  const address = entries.flatMap(([, entries]) => entries ?? []).find(e => !e.internal && e.family === 'IPv4' && privateAddress(e.address))?.address;
  if (!address) throw new Error('Nearby notifications need a private local network. Drive sync will keep working.');
  const waiters = new Map<string, () => void>();
  const seen = new Map<string, number>();
  let revision = crypto.randomUUID(); let closed = false; let minute = Date.now(); let requests = 0;
  const publish = () => { revision = crypto.randomUUID(); for (const wake of [...waiters.values()]) wake(); };
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const fail = (code: number) => { if (!response.headersSent) response.writeHead(code); response.end(); };
    const action = request.url === `/wait/${session}` ? 'wait' : request.url === `/notify/${session}` ? 'notify' : undefined;
    if (Date.now() - minute > 60_000) { minute = Date.now(); requests = 0; }
    if (closed || !action || request.method !== 'POST' || ++requests > 180) return fail(403);
    try {
      let body = '';
      for await (const part of request) { body += String(part); if (Buffer.byteLength(body) > 4096) { fail(413); request.destroy(); return; } }
      const context = `nearby:${folderId}:${session}:${action}`;
      const value = await unseal(key, context, 'request', JSON.parse(body) as Envelope) as { nonce?: string; time?: number; client?: string; revision?: string };
      if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce ?? '') || !/^[a-f0-9-]{36}$/.test(value.client ?? '') ||
          typeof value.revision !== 'string' || value.revision.length > 100 || typeof value.time !== 'number' ||
          Math.abs(Date.now() - value.time) > 60_000 || seen.has(value.nonce!)) return fail(403);
      for (const [nonce, time] of seen) if (Date.now() - time > 120_000) seen.delete(nonce);
      seen.set(value.nonce!, Date.now());
      if (action === 'notify') { publish(); changed(); }
      if (action === 'wait' && value.revision === revision) {
        if (waiters.size >= 16 || waiters.has(value.client!)) return fail(429);
        await new Promise<void>(resolve => {
          const wake = () => { clearTimeout(timer); waiters.delete(value.client!); response.off('close', wake); resolve(); };
          const timer = setTimeout(wake, 20_000);
          waiters.set(value.client!, wake); response.once('close', wake);
        });
      }
      if (closed || response.destroyed) return;
      const encrypted = await seal(key, context, 'response', { nonce: value.nonce, revision });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(encrypted));
    } catch { fail(403); }
  };
  const server = http.createServer((req, res) => { void handler(req, res); });
  server.requestTimeout = 10_000; server.headersTimeout = 5000; server.maxConnections = 24;
  const close = () => { closed = true; for (const wake of [...waiters.values()]) wake(); server.close(); server.closeAllConnections(); };
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, address, resolve); });
  } catch { close(); throw new Error('Nearby listener unavailable. Drive sync will keep working.'); }
  return { config: { address, port: (server.address() as { port: number }).port, session, key }, publish, close };
}
