import { pairingKey, privateAddress, seal, unseal, validateConfig, type Invitation, type PairingConfig, type Envelope } from './pairing';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';

export interface PairingServer { invitation: Invitation; close: () => void }
// Loaded only on desktop; Node modules must remain external to the mobile bundle.
export async function startPairing(config: PairingConfig, status: (message: string) => void,
  approve: () => Promise<boolean>): Promise<PairingServer> {
  const http = require('node:http') as typeof import('node:http');
  const os = require('node:os') as typeof import('node:os');
  const entries = Object.entries(os.networkInterfaces()).sort(([a], [b]) => Number(!/^en\d+$/.test(a)) - Number(!/^en\d+$/.test(b)));
  const address = entries.flatMap(([, entries]) => entries ?? []).find(entry => !entry.internal && entry.family === 'IPv4' && privateAddress(entry.address))?.address;
  if (!address) throw new Error('Connect this Mac to a private local network before adding a device.');
  const sharedConfig = validateConfig(config);
  const session = crypto.randomUUID(); const key = pairingKey();
  let consumed = false; let closed = false; let attempts = 0;
  const expires = Date.now() + 3 * 60_000;
  let timer: ReturnType<typeof setTimeout>;
  let server: Server;
  const close = () => { closed = true; clearTimeout(timer); server.close(); server.closeAllConnections(); };
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const fail = (code: number) => { response.writeHead(code, { 'Content-Type': 'text/plain' }); response.end('Pairing unavailable.'); };
    if (closed || consumed || Date.now() > expires || ++attempts > 16 || request.method !== 'POST' || request.url !== `/pair/${session}`) return fail(403);
    try {
      let body = '';
      for await (const part of request) {
        body += String(part);
        if (Buffer.byteLength(body) > 4096) { fail(413); request.destroy(); return; }
      }
      const value = await unseal(key, session, 'request', JSON.parse(body) as Envelope);
      if (closed || consumed || Date.now() > expires || !value || typeof value !== 'object' ||
          !/^[A-Za-z0-9_-]{43}$/.test(String((value as { nonce?: unknown }).nonce))) return fail(403);
      consumed = true;
      status('A device scanned the invitation. Approve it on this Mac to share your configuration.');
      const accepted = await approve();
      if (!accepted || closed || Date.now() > expires) { fail(403); close(); return; }
      const encrypted = await seal(key, session, 'response', { nonce: (value as { nonce: string }).nonce, config: sharedConfig });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(encrypted), () => {
        status('Configuration sent. Complete Google sign-in on the other device.'); close();
      });
    } catch { if (!response.headersSent) fail(403); }
  };
  server = http.createServer((request, response) => { void handler(request, response); });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 4;
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('Could not start a temporary local pairing listener.')));
    server.listen(0, address, resolve);
  });
  timer = setTimeout(() => { status('Invitation expired. Open Add device to start again.'); close(); }, 3 * 60_000);
  const port = (server.address() as { port: number }).port;
  return { invitation: { address, port, session, key }, close };
}
