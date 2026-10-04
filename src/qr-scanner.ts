import jsQR from 'jsqr';
import { parseInvitation, type Invitation } from './pairing';

/** Decode locally; unrelated QR codes never navigate or issue a request. */
export function decodeInvitation(data: Uint8ClampedArray, width: number, height: number): Invitation | null {
  const code = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
  if (!code) return null;
  try { return parseInvitation(code.data); } catch { return null; }
}

export class PairingCamera {
  private stream?: MediaStream;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly video: HTMLVideoElement, private readonly found: (invitation: Invitation) => void) {}
  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Live camera is unavailable in this Obsidian version. Use Take QR photo below.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } });
    if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    this.video.srcObject = stream;
    this.video.muted = true; this.video.playsInline = true;
    try { await this.video.play(); } catch { this.stop(); throw new Error('Camera preview could not start. Use Take QR photo below.'); }
    if (this.stopped) return;
    const canvas = this.video.ownerDocument.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) { this.stop(); throw new Error('Camera preview is unavailable.'); }
    const scan = () => {
      if (this.stopped) return;
      if (this.video.videoWidth && this.video.videoHeight) {
        const scale = Math.min(1, 960 / this.video.videoWidth);
        canvas.width = Math.round(this.video.videoWidth * scale); canvas.height = Math.round(this.video.videoHeight * scale);
        context.drawImage(this.video, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const invitation = decodeInvitation(pixels.data, pixels.width, pixels.height);
        if (invitation) { this.stop(); this.found(invitation); return; }
      }
      this.timer = setTimeout(scan, 200);
    };
    scan();
  }
  stop(): void {
    this.stopped = true; clearTimeout(this.timer);
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
    this.video.srcObject = null;
  }
}

export async function invitationFromPhoto(file: File, document: Document): Promise<Invitation> {
  if (file.size > 20 * 1024 * 1024) throw new Error('Choose a QR photo smaller than 20 MB.');
  const image = document.createElement('img'); const url = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('This photo could not be opened.')); image.src = url; });
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext('2d'); if (!context) throw new Error('Photo scanning is unavailable.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const invitation = decodeInvitation(pixels.data, pixels.width, pixels.height);
    if (!invitation) throw new Error('No Drive Sync invitation found. Move closer and photograph the whole QR.');
    return invitation;
  } finally { image.src = ''; URL.revokeObjectURL(url); }
}
