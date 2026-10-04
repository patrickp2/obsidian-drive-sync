import { App, Modal, Platform, Setting, requestUrl } from 'obsidian';
import qrcode from 'qrcode-generator';
import { invitationLink, parseInvitation, receivePairing, type Invitation, type PairingConfig } from './pairing';
import { startPairing, type PairingServer } from './pairing-server';

export interface PairingHost {
  config: () => PairingConfig;
  accept: (config: PairingConfig) => Promise<void>;
  registerCleanup: (cleanup: () => void) => void;
}
class ApproveDeviceModal extends Modal {
  private done = false;
  constructor(app: App, private readonly resolve: (approved: boolean) => void) { super(app); }
  onOpen(): void {
    this.setTitle('Approve your other device');
    this.contentEl.createEl('p', { text: 'Approve only if you just scanned this Mac’s pairing QR on your own device. This shares your Google client configuration. The other device still signs in to Google separately.' });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Approve device').setCta().onClick(() => { this.done = true; this.resolve(true); this.close(); }))
      .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));
  }
  onClose(): void { if (!this.done) this.resolve(false); this.contentEl.empty(); }
}
export class AddDeviceModal extends Modal {
  private server?: PairingServer;
  private closed = false;
  private approval?: ApproveDeviceModal;
  constructor(app: App, private readonly host: PairingHost) { super(app); }
  onOpen(): void {
    this.setTitle('Add device');
    const status = this.contentEl.createEl('p', { text: 'Preparing a three-minute invitation…', attr: { role: 'status' } });
    void (async () => {
      try {
        if (!Platform.isDesktopApp) throw new Error('Start Add device on your desktop.');
        this.server = await startPairing(this.host.config(), message => status.setText(message), () => new Promise(resolve => {
          this.approval = new ApproveDeviceModal(this.app, resolve); this.approval.open();
        }));
        this.host.registerCleanup(() => { this.server?.close(); this.approval?.close(); });
        if (this.closed) { this.server.close(); return; }
        status.setText('On the same local network, scan this QR with your phone’s Camera and open it in Obsidian. Then approve the request on this Mac.');
        const link = invitationLink(this.server.invitation);
        const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
        this.contentEl.createEl('img', { attr: { src: qr.createDataURL(5, 12), alt: 'One-time device pairing invitation', width: '320', height: '320' } });
        this.contentEl.createEl('p', { text: 'Keep this invitation private. It expires after three minutes and closes when you leave this panel. Only encrypted configuration crosses the local network.' });
        new Setting(this.contentEl).addButton(b => b.setButtonText('Copy pairing invitation').onClick(() => { void navigator.clipboard.writeText(link); }));
      } catch (error) { status.setText(error instanceof Error ? error.message : 'Could not start pairing.'); }
    })();
  }
  onClose(): void { this.closed = true; this.server?.close(); this.approval?.close(); this.contentEl.empty(); }
}
export class ConnectDeviceModal extends Modal {
  private busy = false;
  constructor(app: App, private readonly host: PairingHost, private readonly invitation?: Invitation) { super(app); }
  onOpen(): void {
    this.setTitle('Connect to existing device');
    this.contentEl.createEl('p', { text: 'Open Add device on your desktop. On the same local network, scan its QR with your phone’s Camera and open the invitation in Obsidian. You can also paste the one-time invitation below.' });
    let invitation = '';
    if (!this.invitation) new Setting(this.contentEl).setName('Pairing invitation').addText(t => {
      t.inputEl.type = 'password'; t.inputEl.autocomplete = 'off'; t.onChange(value => { invitation = value; });
    });
    const status = this.contentEl.createEl('p', { attr: { role: 'status' } });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Connect to desktop').setCta().onClick(() => {
      if (this.busy) return; this.busy = true; b.setDisabled(true);
      void (async () => {
        try {
          const request = this.invitation ?? parseInvitation(invitation);
          invitation = '';
          status.setText('Connecting… approve this device on your desktop when prompted.');
          const config = await receivePairing(request, async (url, body) => {
            const response = await requestUrl({ url, method: 'POST', body, contentType: 'application/json', throw: false });
            if (response.status !== 200) throw new Error('Pairing rejected.');
            return response.text;
          });
          await this.host.accept(config);
          status.setText('Configuration received. Close this panel and sign in to Google on this device.');
          b.setButtonText('Connected');
        } catch (error) { status.setText(error instanceof Error ? error.message : 'Pairing failed.'); b.setDisabled(false); }
        finally { this.busy = false; }
      })();
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}
