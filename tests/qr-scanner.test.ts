import { test } from 'node:test';
import assert from 'node:assert/strict';
import qrcode from 'qrcode-generator';
import { decodeInvitation, PairingCamera } from '../src/qr-scanner';
import { invitationLink, pairingKey } from '../src/pairing';
function pixels(text: string) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const scale = 5, margin = 4, size = (qr.getModuleCount() + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const row = Math.floor(y / scale) - margin, col = Math.floor(x / scale) - margin;
    if (row >= 0 && col >= 0 && row < qr.getModuleCount() && col < qr.getModuleCount() && qr.isDark(row, col)) {
      const i = (y * size + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  return { data, size };
}
test('camera decoder reads real invitation QR pixels and ignores unrelated or unsafe links', () => {
  const invitation = { address: '192.168.1.12', port: 54321, key: pairingKey(), session: crypto.randomUUID() };
  const image = pixels(invitationLink(invitation));
  assert.deepEqual(decodeInvitation(image.data, image.size, image.size), invitation);
  for (const text of ['https://example.com', invitationLink({ ...invitation, address: '8.8.8.8' })]) {
    const other = pixels(text); assert.equal(decodeInvitation(other.data, other.size, other.size), null);
  }
});
test('closing during camera permission promptly stops a late stream without scanning', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let resolve!: (stream: MediaStream) => void; let stopped = 0; let played = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise<MediaStream>(r => { resolve = r; }) } } });
  try {
    const video = { srcObject: null, play: async () => { played++; } } as unknown as HTMLVideoElement;
    const camera = new PairingCamera(video, () => assert.fail('A closed scanner must not continue pairing.'));
    const starting = camera.start(); camera.stop();
    resolve({ getTracks: () => [{ stop: () => { stopped++; } }] } as unknown as MediaStream);
    await starting; assert.equal(stopped, 1); assert.equal(played, 0); assert.equal(video.srcObject, null);
  } finally { if (original) Object.defineProperty(globalThis, 'navigator', original); else Reflect.deleteProperty(globalThis, 'navigator'); }
});
