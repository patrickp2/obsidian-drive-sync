import { App, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting, TFile, requestUrl } from 'obsidian';
import { AuthSession, type SecretStore, type Transport } from './auth';
import { CALLBACK_URL, PROTOCOL_ACTION, parseCallback, parseManualCallback } from './protocol';
import { runDriveProbe, type ProbeReport, type ProbeTransport } from './drive-probe';
import { AddDeviceModal, ConnectDeviceModal, type PairingHost } from './pairing-ui';
import { validateInvitation, validateConfig } from './pairing';
import { DriveStore } from './drive';
import { SyncEngine, emptySyncState, syncPath, type SyncState, type LocalStore } from './sync';

interface Settings {
  clientId: string; clientSecretName: string; instanceId: string;
  folderId: string; folderPending: boolean; syncEnabled: boolean; syncState: SyncState;
}
type CheckedStorage = App['secretStorage'] & { isEncryptionAvailable?: () => boolean };
function secureStore(app: App): SecretStore {
  const check = () => {
    const storage = app.secretStorage as CheckedStorage | undefined;
    if (!storage || typeof storage.isEncryptionAvailable !== 'function' || !storage.isEncryptionAvailable()) {
      throw new Error('Encrypted Obsidian secret storage is required. Update Obsidian and check Keychain.');
    }
    return storage;
  };
  return { get: key => check().getSecret(key), set: (key, value) => check().setSecret(key, value), clear: key => check().setSecret(key, '') };
}
const transport: Transport = async (url, body) => {
  try {
    const result = await requestUrl({ url, method: 'POST', contentType: 'application/x-www-form-urlencoded', body: body.toString(), throw: false });
    let json: unknown = {};
    if (result.text) { try { json = JSON.parse(result.text); } catch { /* Never report provider text. */ } }
    return { status: result.status, json };
  } catch { throw new Error('Could not reach Google.'); }
};
function loadState(value: unknown): SyncState {
  if (value === undefined) return emptySyncState();
  const state = value as SyncState;
  if (!state || state.format !== 1 || !state.baseline || !state.pendingCreates || !state.deleted) throw new Error('Sync state is invalid. Automatic sync has not started.');
  for (const [path, base] of Object.entries(state.baseline)) {
    if (!syncPath(path) || !base || !/^[A-Za-z0-9_-]+$/.test(base.id) || !/^[a-f0-9]{64}$/.test(base.hash)) throw new Error('Sync baseline is invalid.');
  }
  for (const [path, id] of Object.entries(state.pendingCreates)) if (!syncPath(path) || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Pending upload state is invalid.');
  return state;
}

export default class DriveSyncPlugin extends Plugin {
  declare settings: Settings;
  auth!: AuthSession;
  syncMessage = 'Set up Google to begin.';
  lastChecked = '';
  details: string[] = [];
  private statusEl?: HTMLElement;
  private mobileStatus?: HTMLElement;
  private listeners = new Set<() => void>();
  private unloaded = false;
  private saveTail: Promise<void> = Promise.resolve();
  private timer?: number;
  private running?: Promise<void>;
  private dirty = false;
  private engine?: SyncEngine;
  private probeRunning = false;
  probeReport?: ProbeReport;
  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<Settings> | null;
    this.settings = {
      clientId: typeof saved?.clientId === 'string' ? saved.clientId : '',
      clientSecretName: typeof saved?.clientSecretName === 'string' ? saved.clientSecretName : '',
      instanceId: typeof saved?.instanceId === 'string' && /^[a-f0-9-]{36}$/.test(saved.instanceId) ? saved.instanceId : crypto.randomUUID(),
      folderId: typeof saved?.folderId === 'string' && /^[A-Za-z0-9_-]+$/.test(saved.folderId) ? saved.folderId : '',
      folderPending: saved?.folderPending === true,
      syncEnabled: saved?.syncEnabled === true, syncState: loadState(saved?.syncState)
    };
    await this.saveSettings();
    const secrets = secureStore(this.app);
    this.auth = new AuthSession(secrets, `drive-sync-${this.settings.instanceId}`, transport, () => ({
      clientId: this.settings.clientId.trim(), clientSecret: secrets.get(this.settings.clientSecretName) ?? ''
    }), () => this.updateStatus(), Date.now, () => (this.app as App & { appId?: string }).appId);
    if (Platform.isDesktopApp) {
      this.statusEl = this.addStatusBarItem(); this.statusEl.addClass('drive-sync-status');
      this.registerDomEvent(this.statusEl, 'click', () => this.showConnection());
    }
    const ribbon = this.addRibbonIcon('cloud', 'Drive Sync status', () => this.showConnection());
    this.subscribe(() => ribbon.setAttribute('aria-label', `Drive Sync: ${this.syncMessage}`));
    if (Platform.isMobileApp) {
      this.mobileStatus = this.app.workspace.containerEl.createEl('button', { cls: 'drive-sync-mobile-status', attr: { 'aria-label': 'Drive Sync status' } });
      this.registerDomEvent(this.mobileStatus, 'click', () => this.showConnection());
    }
    this.addCommand({ id: 'show-connection', name: 'Show sync status', callback: () => this.showConnection() });
    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.syncNow() });
    this.addCommand({ id: 'test-drive-edits', name: 'Developer: test disposable Drive files', callback: () => new DriveProbeModal(this.app, this).open() });
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, params => {
      void this.run(async () => { await this.auth.complete(parseCallback(new URLSearchParams(params))); await this.syncNow(); });
    });
    this.registerObsidianProtocolHandler('drive-sync-pair', params => {
      void this.run(async () => { new ConnectDeviceModal(this.app, this.pairingHost(), validateInvitation(params)).open(); });
    });
    this.addSettingTab(new DriveSyncSettings(this.app, this));
    const changed = () => { this.dirty = true; this.schedule(); };
    this.registerEvent(this.app.vault.on('modify', f => { if (f instanceof TFile && syncPath(f.path)) changed(); }));
    this.registerEvent(this.app.vault.on('create', f => { if (f instanceof TFile && syncPath(f.path)) changed(); }));
    this.registerEvent(this.app.vault.on('delete', f => {
      if (f instanceof TFile && syncPath(f.path)) { this.settings.syncState.deleted[f.path] = true; void this.run(() => this.saveSettings(), false); changed(); }
    }));
    this.registerEvent(this.app.vault.on('rename', (f, old) => {
      if (f instanceof TFile) { if (syncPath(old)) this.settings.syncState.deleted[old] = true; void this.run(() => this.saveSettings(), false); changed(); }
    }));
    this.registerInterval(window.setInterval(() => { if (this.settings.syncEnabled) void this.syncNow(); }, 30_000));
    this.registerDomEvent(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') { this.setMessage('Checking Drive…'); void this.syncNow(); } });
    this.app.workspace.onLayoutReady(() => { void this.run(async () => { await this.auth.restore(); await this.syncNow(); }, false); });
    this.updateStatus();
  }
  onunload(): void {
    this.unloaded = true; this.engine?.stop(); this.auth?.stop();
    if (this.timer) window.clearTimeout(this.timer);
    this.mobileStatus?.remove(); this.listeners.clear();
  }
  saveSettings(): Promise<void> {
    const snapshot = structuredClone(this.settings);
    const save = this.saveTail.catch(() => {}).then(() => this.saveData(snapshot)); this.saveTail = save; return save;
  }
  async run(work: () => Promise<void>, notify = true): Promise<void> {
    try { await work(); } catch (error) {
      if (notify) new Notice(error instanceof Error ? error.message : 'Operation could not be completed.', 9000);
    }
    this.updateStatus();
  }
  private setMessage(message: string): void { this.syncMessage = message; this.updateStatus(); }
  private schedule(): void {
    if (this.unloaded || !this.settings.syncEnabled || !this.settings.folderId) return;
    if (!this.running) this.setMessage('Changes pending');
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = undefined; void this.syncNow(); }, 1500);
  }
  private driveTransport: ProbeTransport = async request => {
    if (this.unloaded) throw new Error('Plugin unloaded.');
    const token = await this.auth.tokenForDrive();
    if (this.unloaded) throw new Error('Plugin unloaded.');
    const response = await requestUrl({ ...request, headers: { ...request.headers, Authorization: `Bearer ${token}` }, throw: false });
    return { status: response.status, headers: response.headers, text: response.text };
  };
  async createSyncFolder(): Promise<void> {
    await this.auth.tokenForDrive();
    if (!this.settings.folderId) { this.settings.folderId = await DriveStore.reserveId(this.driveTransport); this.settings.folderPending = true; await this.saveSettings(); }
    await DriveStore.createFolder(this.driveTransport, `Obsidian Drive Sync - ${this.app.vault.getName()}`, this.settings.folderId);
    await new DriveStore(this.driveTransport, this.settings.folderId).verifyRoot();
    this.settings.folderPending = false; this.settings.syncEnabled = true; await this.saveSettings(); await this.syncNow();
  }
  async setSyncEnabled(enabled: boolean): Promise<void> {
    this.settings.syncEnabled = enabled;
    if (!enabled) this.engine?.stop();
    await this.saveSettings();
    if (enabled) await this.syncNow(); else this.setMessage('Paused');
  }
  private localStore(): LocalStore {
    const read = async (path: string): Promise<string | null> => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) return null;
      if (!(file instanceof TFile) || !syncPath(path) || file.stat.size > 5 * 1024 * 1024) throw new Error(`Unsupported or oversized Markdown file: ${path}`);
      return this.app.vault.read(file);
    };
    const bufferMatches = (path: string, expected: string) => this.app.workspace.getLeavesOfType('markdown').every(leaf => {
      const view = leaf.view;
      return !(view instanceof MarkdownView) || view.file?.path !== path || view.editor.getValue() === expected;
    });
    return {
      list: async () => this.app.vault.getMarkdownFiles().map(f => f.path).filter(syncPath), read,
      replace: async (path, expected, content) => {
        if (this.unloaded || !this.settings.syncEnabled || !syncPath(path)) return false;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (expected === null) {
          if (file) return false;
          const parts = path.split('/'); parts.pop(); let folder = '';
          for (const part of parts) { folder = folder ? `${folder}/${part}` : part; if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder); }
          try { await this.app.vault.create(path, content); return true; }
          catch (error) { if (this.app.vault.getAbstractFileByPath(path)) return false; throw error; }
        }
        if (!(file instanceof TFile) || !bufferMatches(path, expected)) return false;
        const changed = new Error('Local content changed.');
        try {
          await this.app.vault.process(file, current => {
            if (this.unloaded || !this.settings.syncEnabled || current !== expected || !bufferMatches(path, expected)) throw changed;
            return content;
          });
          return true;
        } catch (error) { if (error === changed) return false; throw error; }
      }
    };
  }
  syncNow(): Promise<void> {
    if (this.running) return this.running;
    if (this.unloaded) return Promise.resolve();
    if (!this.settings.folderId || this.settings.folderPending) { this.setMessage(this.auth.state.status === 'connected' ? 'Connected · choose a sync folder' : 'Connect Google to begin'); return Promise.resolve(); }
    if (!this.settings.syncEnabled) { this.setMessage('Paused'); return Promise.resolve(); }
    this.dirty = false; this.setMessage('Syncing…');
    const engine = new SyncEngine(this.localStore(), new DriveStore(this.driveTransport, this.settings.folderId), this.settings.syncState, () => this.saveSettings());
    this.engine = engine;
    const run = (async () => {
      try {
        const result = await engine.run();
        if (this.unloaded || !this.settings.syncEnabled) return;
        this.details = [...result.pending, ...result.conflicts.map(path => `Preserved conflict: ${path}`)];
        this.lastChecked = new Date().toLocaleTimeString();
        this.setMessage(result.pending.length ? `${result.pending.length} items need attention` : result.conflicts.length ? 'Conflicts preserved' : this.dirty ? 'Checking new changes…' : 'Synced with Drive');
        if (result.conflicts.length) new Notice('Drive Sync preserved both edits in Markdown conflict copies.', 8000);
      } catch (error) {
        if (!this.unloaded && this.settings.syncEnabled) {
          this.details = [error instanceof Error ? error.message : 'Request failed; retrying.'];
          this.setMessage(this.auth.state.status === 'needs-reconnect' ? 'Reconnect Google' : 'Sync incomplete · retrying');
        }
      }
    })();
    this.running = run;
    void run.finally(() => { this.running = undefined; if (this.dirty) this.schedule(); });
    return run;
  }
  pairingHost(): PairingHost {
    return {
      config: () => {
        if (!this.settings.folderId || this.settings.folderPending) throw new Error('Create the desktop sync folder before adding a device.');
        return validateConfig({ clientId: this.settings.clientId, clientSecret: secureStore(this.app).get(this.settings.clientSecretName), folderId: this.settings.folderId });
      },
      accept: async config => {
        if (this.settings.clientId && this.settings.clientId !== config.clientId) throw new Error('This vault uses a different Google client. Use an empty test vault to pair it.');
        if (this.settings.folderId && this.settings.folderId !== config.folderId) throw new Error('This vault already uses a different sync folder. Use an empty vault.');
        if (!config.folderId) throw new Error('Desktop has no sync folder configured.');
        const store = secureStore(this.app); const key = `drive-client-${this.settings.instanceId}`;
        store.set(key, config.clientSecret);
        if (store.get(key) !== config.clientSecret) throw new Error('Could not store paired configuration.');
        this.settings.clientId = config.clientId; this.settings.clientSecretName = key;
        this.settings.folderId = config.folderId; this.settings.folderPending = false; this.settings.syncEnabled = true;
        await this.saveSettings(); this.setMessage('Configuration received · sign in to Google');
      },
      registerCleanup: cleanup => this.register(cleanup)
    };
  }
  async connect(verifyPkce?: 'wrong' | 'missing'): Promise<void> {
    const url = await this.auth.begin(verifyPkce);
    if (Platform.isMobileApp) new BrowserSignInModal(this.app, url).open(); else window.open(url, '_blank');
  }
  async testDrive(progress: (message: string) => void): Promise<ProbeReport> {
    if (this.probeRunning || this.unloaded) throw new Error('A test is already running or the plugin is unloading.');
    this.probeRunning = true;
    try { return this.probeReport = await runDriveProbe(this.driveTransport, progress, 'v2'); }
    finally { this.probeRunning = false; }
  }
  showConnection(): void { new ConnectionModal(this.app, this).open(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private updateStatus(): void {
    if (!this.auth) return;
    this.statusEl?.setText(`Drive: ${this.syncMessage}`);
    this.mobileStatus?.setText(`Drive: ${this.syncMessage}`);
    for (const listener of this.listeners) listener();
  }
}
class BrowserSignInModal extends Modal {
  constructor(app: App, private readonly url: string) { super(app); }
  onOpen(): void {
    this.setTitle('Continue to Google');
    this.contentEl.createEl('p', { text: 'Sign in in your browser, then return to this Obsidian vault.' });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Continue to Google').setCta().onClick(() => { window.open(this.url, '_blank'); this.close(); }));
  }
  onClose(): void { this.contentEl.empty(); }
}
class ConnectionModal extends Modal {
  private unsubscribe?: () => void;
  constructor(app: App, private readonly plugin: DriveSyncPlugin) { super(app); }
  onOpen(): void {
    this.setTitle('Drive Sync');
    const status = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    const details = this.contentEl.createEl('pre'); details.style.whiteSpace = 'pre-wrap';
    const render = () => { status.setText(this.plugin.syncMessage); details.setText([this.plugin.auth.state.message, this.plugin.lastChecked ? `Last completed check: ${this.plugin.lastChecked}` : '', ...this.plugin.details].filter(Boolean).join('\n')); };
    render(); this.unsubscribe = this.plugin.subscribe(render);
    new Setting(this.contentEl).addButton(b => b.setButtonText('Sync now').setCta().onClick(() => void this.plugin.syncNow()))
      .addButton(b => b.setButtonText(this.plugin.settings.syncEnabled ? 'Pause' : 'Resume').onClick(() => void this.plugin.run(async () => {
        await this.plugin.setSyncEnabled(!this.plugin.settings.syncEnabled); b.setButtonText(this.plugin.settings.syncEnabled ? 'Pause' : 'Resume');
      })));
    this.contentEl.createEl('p', { text: 'This beta syncs Markdown files up to 5 MB. Attachments and deletion propagation are not enabled; missing files are preserved for review.' });
    const advanced = this.contentEl.createEl('details'); advanced.createEl('summary', { text: 'Connection and diagnostics' });
    new Setting(advanced).addButton(b => b.setButtonText('Sign in to Google').onClick(() => void this.plugin.run(() => this.plugin.connect())))
      .addButton(b => b.setButtonText('Test refresh').onClick(() => void this.plugin.run(() => this.plugin.auth.refresh())));
    new Setting(advanced).addButton(b => b.setButtonText('Paste return link').onClick(() => new ReturnLinkModal(this.app, this.plugin).open()))
      .addButton(b => b.setButtonText('Run disposable file test').onClick(() => new DriveProbeModal(this.app, this.plugin).open()));
    new Setting(advanced).setName('Disconnect and revoke access').setDesc('May also require other devices using this Google project to reconnect.')
      .addButton(b => b.setButtonText('Disconnect').onClick(() => void this.plugin.run(async () => { await this.plugin.setSyncEnabled(false); await this.plugin.auth.disconnect(); })));
  }
  onClose(): void { this.unsubscribe?.(); this.contentEl.empty(); }
}
class ReturnLinkModal extends Modal {
  constructor(app: App, private readonly plugin: DriveSyncPlugin) { super(app); }
  onOpen(): void {
    this.setTitle('Finish Google sign-in'); let value = '';
    new Setting(this.contentEl).setName('Return link').addText(t => { t.inputEl.type = 'password'; t.inputEl.autocomplete = 'off'; t.onChange(next => { value = next; }); });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Finish sign-in').setCta().onClick(() => {
      const submitted = value; value = ''; this.close();
      void this.plugin.run(async () => { await this.plugin.auth.complete(parseManualCallback(submitted)); await this.plugin.syncNow(); });
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}
class DriveSyncSettings extends PluginSettingTab {
  private unsubscribe?: () => void;
  constructor(app: App, private readonly plugin: DriveSyncPlugin) { super(app, plugin); }
  hide(): void { this.unsubscribe?.(); }
  display(): void {
    this.unsubscribe?.(); const el = this.containerEl; el.empty();
    el.createEl('h2', { text: 'Drive Sync' });
    el.createEl('p', { text: 'Your own Google project, a normal Markdown folder in Drive, and a separate local vault on each device. Use a disposable vault while this beta is being validated.' });
    if (Platform.isMobileApp) new Setting(el).setName('Set up from desktop').setDesc('Transfer Google configuration and the sync folder over your local network.')
      .addButton(b => b.setButtonText('Connect to existing device').setCta().onClick(() => new ConnectDeviceModal(this.app, this.plugin.pairingHost()).open()));
    const connection = new Setting(el).setName('Google connection').setDesc(this.plugin.auth.state.message)
      .addButton(b => b.setButtonText('Sign in to Google').onClick(() => void this.plugin.run(() => this.plugin.connect())));
    if ((!this.plugin.settings.folderId || this.plugin.settings.folderPending) && Platform.isDesktopApp) new Setting(el).setName('Sync folder').setDesc('Create a dedicated folder in Google Drive and begin syncing this test vault’s Markdown files.')
      .addButton(b => b.setButtonText('Create sync folder').setCta().onClick(() => void this.plugin.run(async () => { await this.plugin.createSyncFolder(); this.display(); })));
    if (this.plugin.settings.folderId && !this.plugin.settings.folderPending) {
      new Setting(el).setName('Google Drive folder').addButton(b => b.setButtonText('Open folder in Drive').onClick(() => window.open(`https://drive.google.com/drive/folders/${this.plugin.settings.folderId}`, '_blank')));
      new Setting(el).setName('Automatic sync').setDesc('Runs after saved edits, on resume, and every 30 seconds while Obsidian is open.')
        .addToggle(t => t.setValue(this.plugin.settings.syncEnabled).onChange(value => void this.plugin.run(() => this.plugin.setSyncEnabled(value))));
      if (Platform.isDesktopApp) new Setting(el).setName('Set up your phone').addButton(b => b.setButtonText('Add device').setCta().onClick(() => new AddDeviceModal(this.app, this.plugin.pairingHost()).open()));
    }
    const status = new Setting(el).setName('Sync status').setDesc(this.plugin.syncMessage).addButton(b => b.setButtonText('View details').onClick(() => this.plugin.showConnection()));
    this.unsubscribe = this.plugin.subscribe(() => { connection.setDesc(this.plugin.auth.state.message); status.setDesc(this.plugin.syncMessage); });
    const config = el.createEl('details'); config.open = !this.plugin.settings.clientId && Platform.isDesktopApp;
    config.createEl('summary', { text: Platform.isDesktopApp ? 'Google project configuration' : 'Advanced Google configuration' });
    config.createEl('p', { text: 'Configure your own Google OAuth web client once on desktop. Add device transfers this configuration to your phone. Tokens stay on each device.' });
    new Setting(config).setName('Client ID').addText(t => t.setValue(this.plugin.settings.clientId).onChange(value => {
      if (this.plugin.settings.syncEnabled) { new Notice('Pause sync before changing Google configuration.'); return; }
      this.plugin.settings.clientId = value.trim(); void this.plugin.run(() => this.plugin.saveSettings(), false);
    }));
    try {
      secureStore(this.app).get(`drive-sync-${this.plugin.settings.instanceId}`);
      new Setting(config).setName('Client secret').setDesc('Stored in this device’s Obsidian Keychain.')
        .addComponent(target => new SecretComponent(this.app, target).setValue(this.plugin.settings.clientSecretName).onChange(value => {
          this.plugin.settings.clientSecretName = value ?? ''; void this.plugin.run(() => this.plugin.saveSettings(), false);
        }));
    } catch { config.createEl('p', { text: 'Encrypted secret storage is unavailable. Update Obsidian before connecting.' }); }
    new Setting(config).setName('Redirect URI').setDesc(CALLBACK_URL);
    config.createEl('p', { text: 'Scope: drive.file — app-created or explicitly authorized files. Existing-folder import is not supported. External Google projects in Testing commonly require sign-in again after seven days.' });
  }
}
class DriveProbeModal extends Modal {
  constructor(app: App, private readonly plugin: DriveSyncPlugin) { super(app); }
  onOpen(): void {
    this.setTitle('Disposable Drive file test');
    this.contentEl.createEl('p', { text: 'Creates synthetic Drive files, tests competing edits, and moves its test resources to trash. Keep Obsidian open until cleanup finishes.' });
    const output = this.contentEl.createEl('pre', { attr: { role: 'status' } }); output.style.whiteSpace = 'pre-wrap';
    const render = (r: ProbeReport) => output.setText([r.passed ? 'File API checks passed.' : 'File API checks did not all pass.', ...r.checks, r.cleanup].join('\n\n'));
    if (this.plugin.probeReport) render(this.plugin.probeReport);
    new Setting(this.contentEl).addButton(b => b.setButtonText('Run disposable file test').setCta().onClick(() => {
      b.setDisabled(true); void this.plugin.run(async () => { try { render(await this.plugin.testDrive(message => output.setText(message))); } finally { b.setDisabled(false); } });
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}
