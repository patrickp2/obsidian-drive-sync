import { App, Modal, Setting } from 'obsidian';
import type { ClientConfig } from './auth';
import type { SetupPeer, VaultSetup } from './vault-setup';

export function approveVaultSetup(app: App, peer: SetupPeer, code: string, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => new Approval(app, peer, code, signal, resolve).open());
}
class Approval extends Modal {
  private approved = false;
  private readonly aborted = () => this.close();
  constructor(app: App, private peer: SetupPeer, private code: string, private signal: AbortSignal, private finish: (approved: boolean) => void) { super(app); }
  onOpen(): void {
    if (this.signal.aborted) { this.close(); return; }
    this.signal.addEventListener('abort', this.aborted, { once: true });
    this.setTitle('Approve Google setup reuse');
    this.contentEl.createEl('p', { text: `“${this.peer.name}” wants to reuse the Google client configuration from “${this.app.vault.getName()}”.` });
    this.contentEl.createEl('p', { text: `Check that both vaults show: ${this.code}` });
    this.contentEl.createEl('p', { text: 'Approve only the vault you just selected. Its Google sign-in, Drive folder, and sync history remain separate.' });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Approve setup').setCta().onClick(() => { this.approved = true; this.close(); }))
      .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));
  }
  onClose(): void { this.signal.removeEventListener('abort', this.aborted); this.contentEl.empty(); this.finish(this.approved && !this.signal.aborted); }
}
export class ReuseVaultSetupModal extends Modal {
  private closed = false;
  private requesting = false;
  constructor(app: App, private broker: VaultSetup, private accept: (config: ClientConfig) => Promise<void>, private done: () => void) { super(app); }
  onOpen(): void { this.setTitle('Reuse Google setup from another vault'); this.browse(); }
  private browse(): void {
    this.contentEl.empty(); this.requesting = false;
    this.contentEl.createEl('p', { text: 'Keep the configured vault open in another Obsidian window on this computer. Choose it here, then approve the matching code in that vault. Nothing is copied through Drive or the clipboard.' });
    const status = this.contentEl.createEl('p', { text: 'Looking for open vaults…', attr: { role: 'status' } });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Refresh vaults').onClick(() => this.browse()));
    const peers = this.contentEl.createDiv(); const seen = new Set<string>();
    this.broker.discover(peer => {
      if (this.closed || this.requesting || seen.has(peer.id)) return;
      seen.add(peer.id); status.setText('Choose the vault whose Google project you want to reuse.');
      new Setting(peers).setName(peer.name).addButton(b => b.setButtonText('Use this Google setup').setCta().onClick(() => this.request(peer)));
    });
  }
  private request(peer: SetupPeer): void {
    this.requesting = true; this.broker.stopDiscovery(); this.contentEl.empty();
    const status = this.contentEl.createEl('p', { text: `Requesting approval in “${peer.name}”…`, attr: { role: 'status' } });
    void this.broker.request(peer, code => {
      if (!this.closed) status.setText(`Check code ${code} in “${peer.name}”, then choose Approve setup there. This request expires in two minutes.`);
    }).then(async config => {
      if (this.closed) return;
      await this.accept(config);
      if (this.closed) return;
      this.contentEl.empty();
      this.contentEl.createEl('p', { text: 'Google project configuration is saved in this vault’s Keychain. Sign in to Google for this vault, then choose or create its own Drive folder.' });
      new Setting(this.contentEl).addButton(b => b.setButtonText('Done').setCta().onClick(() => this.close()));
    }).catch(error => {
      if (this.closed) return;
      status.setText(error instanceof Error ? error.message : 'Setup could not be reused.');
      new Setting(this.contentEl).addButton(b => b.setButtonText('Try again').onClick(() => this.browse()));
    });
  }
  onClose(): void { this.closed = true; this.broker.stopDiscovery(); this.broker.cancel(); this.contentEl.empty(); this.done(); }
}
