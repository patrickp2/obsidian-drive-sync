import { App, Modal, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting, requestUrl } from 'obsidian';
import { AuthSession, type SecretStore, type Transport } from './auth';
import { CALLBACK_URL, PROTOCOL_ACTION, parseCallback, parseManualCallback } from './protocol';

interface Settings { clientId: string; clientSecretName: string; instanceId: string; prototypeAcknowledged: boolean }
const DEFAULTS: Settings = { clientId: '', clientSecretName: '', instanceId: '', prototypeAcknowledged: false };

// The encryption check is present in the inspected Obsidian 1.12.7 runtime but
// not yet in its public typings. Fail closed if a future runtime removes it.
type CheckedStorage = App['secretStorage'] & { isEncryptionAvailable?: () => boolean };
function secureStore(app: App): SecretStore {
  const check = () => {
    const storage = app.secretStorage as CheckedStorage | undefined;
    if (!storage || typeof storage.isEncryptionAvailable !== 'function' || !storage.isEncryptionAvailable()) {
      throw new Error('Encrypted Obsidian secret storage is required. Update Obsidian and check its Keychain settings.');
    }
    return storage;
  };
  return {
    get: key => check().getSecret(key),
    set: (key, value) => check().setSecret(key, value),
    // Public API has no deletion method. Empty the value rather than relying on
    // an undocumented delete method; the empty entry can be removed in Keychain.
    clear: key => check().setSecret(key, '')
  };
}
const transport: Transport = async (url, body) => {
  try {
    const result = await requestUrl({ url, method: 'POST', contentType: 'application/x-www-form-urlencoded',
      body: body.toString(), throw: false });
    let json: unknown = {};
    if (result.text) { try { json = JSON.parse(result.text); } catch { /* Never report the response body. */ } }
    return { status: result.status, json };
  } catch { throw new Error('Could not reach Google.'); }
};

export default class DriveSyncPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  auth!: AuthSession;
  private statusEl?: HTMLElement;
  private listeners = new Set<() => void>();
  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<Settings> | null;
    this.settings = {
      clientId: typeof saved?.clientId === 'string' ? saved.clientId : '',
      clientSecretName: typeof saved?.clientSecretName === 'string' ? saved.clientSecretName : '',
      instanceId: typeof saved?.instanceId === 'string' && /^[a-f0-9-]{36}$/.test(saved.instanceId) ? saved.instanceId : crypto.randomUUID(),
      prototypeAcknowledged: saved?.prototypeAcknowledged === true
    };
    await this.saveSettings();
    const secrets = secureStore(this.app);
    this.auth = new AuthSession(secrets, `drive-sync-${this.settings.instanceId}`, transport, () => ({
      clientId: this.settings.clientId.trim(), clientSecret: secrets.get(this.settings.clientSecretName) ?? ''
    }), () => this.updateStatus(), Date.now, () => {
      // Obsidian's runtime vault ID avoids putting vault names or paths in OAuth
      // state. This is not public API; absence retains the manual fallback.
      return (this.app as App & { appId?: string }).appId;
    });
    if (Platform.isDesktopApp) {
      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass('drive-sync-status');
      this.registerDomEvent(this.statusEl, 'click', () => this.showConnection());
    }
    this.addRibbonIcon('cloud', 'Drive Sync connection', () => this.showConnection());
    this.addCommand({ id: 'show-connection', name: 'Show connection status', callback: () => this.showConnection() });
    this.addCommand({ id: 'connect-google', name: 'Connect Google (authentication prototype)', callback: () => void this.run(() => this.connect()) });
    this.addCommand({ id: 'complete-sign-in', name: 'Paste sign-in return link', callback: () => new ReturnLinkModal(this.app, this).open() });
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, params => {
      // No URI, token, or provider response is logged.
      void this.run(async () => { await this.auth.complete(parseCallback(new URLSearchParams(params))); });
    });
    this.addSettingTab(new DriveSyncSettings(this.app, this));
    this.updateStatus();
    if (this.settings.prototypeAcknowledged) void this.run(() => this.auth.restore(), false);
    this.registerInterval(window.setInterval(() => { if (this.settings.prototypeAcknowledged) void this.run(() => this.auth.refreshIfNeeded(), false); }, 30_000));
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') if (this.settings.prototypeAcknowledged) void this.run(() => this.auth.refreshIfNeeded(), false);
    });
  }
  onunload(): void { this.auth?.stop(); this.listeners.clear(); }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  async run(work: () => Promise<void>, notify = true): Promise<void> {
    try { await work(); } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection could not be completed.';
      if (notify) new Notice(message, 9000);
    }
    this.updateStatus();
  }
  async connect(): Promise<void> {
    if (!this.settings.prototypeAcknowledged) throw new Error('Open Drive Sync settings and acknowledge this authentication-only prototype first.');
    window.open(await this.auth.begin(), '_blank');
  }
  showConnection(): void { new ConnectionModal(this.app, this).open(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private updateStatus(): void {
    const state = this.auth?.state;
    if (!state) return;
    this.statusEl?.setText(`Drive: ${state.status === 'connected' ? 'connected · sync disabled' : state.status.replaceAll('-', ' ')}`);
    for (const listener of this.listeners) listener();
  }
}

class ConnectionModal extends Modal {
  private unsubscribe?: () => void;
  constructor(app: App, private readonly plugin: DriveSyncPlugin) { super(app); }
  onOpen(): void {
    this.setTitle('Drive Sync');
    const status = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    const render = () => status.setText(this.plugin.auth.state.message);
    render();
    this.unsubscribe = this.plugin.subscribe(render);
    this.contentEl.createEl('p', { text: 'Authentication test only. This build does not read, upload, change, or delete your notes.' });
    new Setting(this.contentEl).setName('Google connection').addButton(button => button.setButtonText('Connect').onClick(() => void this.plugin.run(() => this.plugin.connect())))
      .addButton(button => button.setButtonText('Test refresh').onClick(() => void this.plugin.run(() => this.plugin.auth.refresh())));
    new Setting(this.contentEl).setName('Finish sign-in manually').setDesc('Use only if the browser could not return to Obsidian.')
      .addButton(button => button.setButtonText('Paste return link').onClick(() => new ReturnLinkModal(this.app, this.plugin).open()));
    new Setting(this.contentEl).setName('Disconnect and revoke access')
      .setDesc('Clears this device’s refresh token and asks Google to revoke the grant. Other devices using this Google project may also need to reconnect.')
      .addButton(button => button.setButtonText('Disconnect').onClick(() => void this.plugin.run(() => this.plugin.auth.disconnect())));
  }
  onClose(): void { this.unsubscribe?.(); this.contentEl.empty(); }
}

class ReturnLinkModal extends Modal {
  constructor(app: App, private readonly plugin: DriveSyncPlugin) { super(app); }
  onOpen(): void {
    this.setTitle('Finish Google sign-in');
    this.contentEl.createEl('p', { text: 'Paste the return link from the callback page. It is used once and is not saved in settings.' });
    let value = '';
    const field = new Setting(this.contentEl).setName('Return link');
    field.addText(text => {
      text.inputEl.type = 'password'; text.inputEl.autocomplete = 'off';
      text.onChange(next => { value = next; });
    });
    new Setting(this.contentEl).addButton(button => button.setButtonText('Finish sign-in').setCta().onClick(() => {
      const submitted = value; value = ''; this.close();
      void this.plugin.run(async () => this.plugin.auth.complete(parseManualCallback(submitted)));
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}

class DriveSyncSettings extends PluginSettingTab {
  constructor(app: App, private readonly plugin: DriveSyncPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl('p', { text: 'Authentication prototype — synchronization is disabled. Use a disposable test vault. Google web-client compatibility and the real iPhone handoff still require validation.' });
    new Setting(containerEl).setName('Enable authentication testing').setDesc('Use only your own dedicated Google project with billing disabled. A web client secret on a device cannot be treated as confidential.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.prototypeAcknowledged).onChange(async value => {
        this.plugin.settings.prototypeAcknowledged = value; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName('Google OAuth client ID').setDesc('Your own web application client. This public identifier is saved in plugin settings.')
      .addText(text => text.setValue(this.plugin.settings.clientId).onChange(async value => {
        this.plugin.settings.clientId = value.trim(); await this.plugin.saveSettings();
      }));
    try {
      secureStore(this.app).get(`drive-sync-${this.plugin.settings.instanceId}`);
      new Setting(containerEl).setName('Client secret').setDesc('Select or create an entry in Obsidian’s device-local Keychain. Only the entry name is saved in plugin settings.')
        .addComponent(el => new SecretComponent(this.app, el).setValue(this.plugin.settings.clientSecretName).onChange(async value => {
          this.plugin.settings.clientSecretName = value ?? ''; await this.plugin.saveSettings();
        }));
    } catch {
      containerEl.createEl('p', { text: 'Encrypted secret storage is unavailable. Authentication is blocked; no plaintext fallback is used.', cls: 'drive-sync-warning' });
    }
    new Setting(containerEl).setName('Authorized redirect URI').setDesc(CALLBACK_URL);
    new Setting(containerEl).setName('Requested Google permission').setDesc('drive.file: files created by this app or explicitly opened with it. This is not access to your entire Drive. Existing-folder import is not implemented.');
    new Setting(containerEl).setName('Connection status').setDesc(this.plugin.auth.state.message)
      .addButton(button => button.setButtonText('Open connection').onClick(() => this.plugin.showConnection()));
    containerEl.createEl('p', { text: 'Google projects left in External / Testing commonly issue refresh grants that expire after seven days for Drive access. Production setup and actual device persistence are separate validation steps.' });
  }
}
