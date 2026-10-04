import { App, Modal, Platform, Setting, requestUrl } from 'obsidian';
import qrcode from 'qrcode-generator';
import { invitationLink, parseInvitation, receivePairing, type Invitation, type PairingConfig } from './pairing';
import { startPairing, type PairingServer } from './pairing-server';
import { PairingCamera, invitationFromPhoto } from './qr-scanner';

export interface PairingHost {
  config: () => PairingConfig;
  accept: (config: PairingConfig) => Promise<void>;
  connected: () => boolean;
  beginSignIn: () => Promise<string>;
  subscribe: (listener: () => void) => () => void;
  registerCleanup: (cleanup: () => void) => void;
}
function step(el: HTMLElement, number: number, title: string, text: string): void {
  el.empty();
  el.createEl('p', { text: `Step ${number} of 4`, cls: 'drive-sync-step' });
  el.createEl('h3', { text: title });
  el.createEl('p', { text, attr: { role: 'status', 'aria-live': 'polite' } });
}
export class AddDeviceModal extends Modal {
  private server?: PairingServer;
  private closed = false;
  private approval?: (approved: boolean) => void;
  constructor(app: App, private readonly host: PairingHost) { super(app); }
  onOpen(): void {
    this.setTitle('Add device');
    void this.prepare();
    this.host.registerCleanup(() => this.close());
  }
  private async prepare(): Promise<void> {
    this.server?.close(); this.contentEl.empty();
    const status = this.contentEl.createEl('p', { text: 'Preparing invitation…', attr: { role: 'status' } });
    try {
      if (!Platform.isDesktopApp) throw new Error('Start Add device on your desktop.');
      this.server = await startPairing(this.host.config(), (message, phase) => {
        if (this.closed) return;
        if (phase === 'sent' || phase === 'expired') {
          this.contentEl.empty();
          this.contentEl.createEl('h3', { text: phase === 'sent' ? 'Device paired' : 'Invitation expired' });
          this.contentEl.createEl('p', { text: phase === 'sent' ? 'Continue on your phone. It will use its own Google sign-in.' : 'Create a new QR when your phone is ready.' });
          new Setting(this.contentEl).addButton(b => b.setButtonText(phase === 'sent' ? 'Done' : 'New invitation').setCta().onClick(() => { if (phase === 'sent') this.close(); else void this.prepare(); }));
          this.approval?.(false); this.approval = undefined;
        } else status.setText(message);
      }, () => new Promise(resolve => {
        this.approval = resolve;
        this.contentEl.empty();
        this.contentEl.createEl('h3', { text: 'Approve your phone' });
        this.contentEl.createEl('p', { text: 'Approve only if you just scanned this invitation on your own device. This transfers the Google client configuration and sync folder; each device keeps its own Google tokens.' });
        new Setting(this.contentEl).addButton(b => b.setButtonText('Approve device').setCta().onClick(() => {
          b.setDisabled(true); this.approval = undefined; resolve(true);
          this.contentEl.empty(); this.contentEl.createEl('p', { text: 'Sending encrypted configuration…' });
        })).addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));
      }));
      if (this.closed) { this.server.close(); return; }
      status.setText('On your phone, open Drive Sync → Connect to existing device → Scan QR. Keep both devices on the same Wi-Fi.');
      const link = invitationLink(this.server.invitation);
      const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
      this.contentEl.createEl('img', { cls: 'drive-sync-pair-qr', attr: { src: qr.createDataURL(5, 12), alt: 'One-time device pairing invitation', width: '320', height: '320' } });
      this.contentEl.createEl('p', { text: 'This private invitation expires in three minutes. Approve the request here after scanning.' });
      const fallback = this.contentEl.createEl('details'); fallback.createEl('summary', { text: 'Other ways to connect' });
      fallback.createEl('p', { text: 'You can also scan with the Camera app, or paste a one-time invitation in Obsidian.' });
      new Setting(fallback).addButton(b => b.setButtonText('Copy pairing invitation').onClick(() => { void navigator.clipboard.writeText(link); }));
    } catch (error) { status.setText(error instanceof Error ? error.message : 'Could not start pairing.'); }
  }
  onClose(): void { this.closed = true; this.approval?.(false); this.approval = undefined; this.server?.close(); this.contentEl.empty(); }
}
export class ConnectDeviceModal extends Modal {
  private busy = false;
  private closed = false;
  private camera?: PairingCamera;
  private unsubscribe?: () => void;
  private waitingForGoogle = false;
  private operation = 0;
  private readonly visibility = () => {
    if (this.contentEl.ownerDocument.visibilityState === 'hidden' && this.camera) {
      this.operation++; this.camera.stop(); this.camera = undefined;
      this.showScan('Camera paused. Tap Scan QR to continue.');
    }
  };
  constructor(app: App, private readonly host: PairingHost, private readonly finished: () => void) { super(app); }
  onOpen(): void {
    this.setTitle('Connect this device');
    this.contentEl.ownerDocument.addEventListener('visibilitychange', this.visibility);
    this.showScan();
    this.unsubscribe = this.host.subscribe(() => { if (this.waitingForGoogle && this.host.connected()) this.showReady(); });
    this.host.registerCleanup(() => this.close());
  }
  private showScan(message?: string): void {
    this.camera?.stop(); this.camera = undefined; this.busy = false;
    step(this.contentEl, 1, 'Scan your desktop', 'Open Add device on your desktop, then scan its QR here. Both devices must be on the same Wi-Fi.');
    const video = this.contentEl.createEl('video', { cls: 'drive-sync-camera', attr: { playsinline: '', muted: '' } }); video.hidden = true;
    const status = this.contentEl.createEl('p', { text: message ?? 'The camera reads the QR on this device. No images are saved or uploaded.', attr: { role: 'status', 'aria-live': 'polite' } });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Scan QR').setCta().onClick(() => {
      this.camera?.stop(); video.hidden = false; b.setDisabled(true);
      const operation = ++this.operation;
      const camera = this.camera = new PairingCamera(video, invitation => this.useInvitation(invitation));
      void camera.start().then(() => {
        if (!this.closed && operation === this.operation) status.setText('Point the camera at the whole desktop QR.');
      }).catch(() => {
        camera.stop(); if (this.closed || operation !== this.operation) return;
        video.hidden = true; b.setDisabled(false); status.setText('Live camera is unavailable or permission was declined. Use Take QR photo, or allow camera access in iOS Settings.');
      });
    }));
    const photo = this.contentEl.createEl('input', { attr: { type: 'file', accept: 'image/*', capture: 'environment', 'aria-label': 'Take a photo of the desktop QR' } }); photo.hidden = true;
    photo.addEventListener('change', () => {
      const file = photo.files?.[0]; photo.value = ''; if (!file) return;
      const operation = ++this.operation;
      this.camera?.stop(); video.hidden = true; status.setText('Reading QR photo…');
      void invitationFromPhoto(file, this.contentEl.ownerDocument).then(invitation => {
        if (!this.closed && operation === this.operation) this.useInvitation(invitation);
      }).catch(error => { if (!this.closed && operation === this.operation) status.setText(error instanceof Error ? error.message : 'Could not read the QR.'); });
    });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Take QR photo').onClick(() => { this.camera?.stop(); this.camera = undefined; photo.click(); }));
    const fallback = this.contentEl.createEl('details'); fallback.createEl('summary', { text: 'Paste an invitation instead' });
    let invitation = '';
    new Setting(fallback).setName('Pairing invitation').addText(t => { t.inputEl.type = 'password'; t.inputEl.autocomplete = 'off'; t.onChange(value => { invitation = value; }); });
    new Setting(fallback).addButton(b => b.setButtonText('Continue').onClick(() => {
      try { const parsed = parseInvitation(invitation); invitation = ''; this.useInvitation(parsed); }
      catch { status.setText('Paste a complete Drive Sync pairing invitation.'); }
    }));
  }
  useInvitation(invitation: Invitation): void {
    if (this.closed || this.busy) return;
    this.camera?.stop(); this.camera = undefined; this.busy = true;
    const operation = ++this.operation;
    step(this.contentEl, 2, 'Approve on your desktop', 'The QR was read. Choose Approve device on your desktop to continue.');
    void (async () => {
      try {
        const config = await receivePairing(invitation, async (url, body) => {
          const response = await requestUrl({ url, method: 'POST', body, contentType: 'application/json', throw: false });
          if (response.status !== 200) throw new Error('The invitation expired or was declined. Open a new invitation on desktop and scan again.');
          return response.text;
        });
        if (this.closed || operation !== this.operation) return;
        await this.host.accept(config);
        if (this.closed || operation !== this.operation) return;
        this.busy = false;
        if (this.host.connected()) this.showReady(); else this.showGoogle();
      } catch {
        if (!this.closed && operation === this.operation) this.showScan('Could not complete pairing. Check the same Wi-Fi and desktop approval, then scan a new invitation.');
      }
    })();
  }
  private showGoogle(): void {
    this.waitingForGoogle = true;
    step(this.contentEl, 3, 'Sign in to Google', 'Your configuration is ready. Sign in to the same Google account as your desktop. Your Google tokens stay on this device.');
    const status = this.contentEl.createEl('p', { attr: { role: 'status' } });
    let url: string | undefined;
    new Setting(this.contentEl).addButton(b => {
      const prepare = () => {
        b.setDisabled(true).setButtonText('Preparing sign-in…');
        void this.host.beginSignIn().then(value => { if (!this.closed) { url = value; b.setButtonText('Continue to Google').setDisabled(false); } })
          .catch(() => { if (!this.closed) { status.setText('Could not prepare sign-in. Try again.'); b.setButtonText('Try again').setDisabled(false); } });
      };
      b.setCta().onClick(() => {
        if (url) { window.open(url, '_blank'); status.setText('Finish in your browser, then return here.'); }
        else prepare();
      });
      prepare();
    });
  }
  private showReady(): void {
    this.waitingForGoogle = false;
    step(this.contentEl, 4, 'Setup complete', 'This device is connected. Drive Sync will check your Markdown notes automatically. The sync indicator shows when the first check finishes.');
    new Setting(this.contentEl).addButton(b => b.setButtonText('Done').setCta().onClick(() => this.close()));
  }
  onClose(): void { this.closed = true; this.operation++; this.camera?.stop(); this.unsubscribe?.(); this.contentEl.ownerDocument.removeEventListener('visibilitychange', this.visibility); this.contentEl.empty(); this.finished(); }
}
