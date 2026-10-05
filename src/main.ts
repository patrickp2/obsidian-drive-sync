import { NetworkAccess, OFFLINE_MESSAGE } from './network';
import { finishUiAction } from './ui-action';
import { runLifecycleProbe } from './lifecycle-probe';
import type { AuthCallback } from './protocol';
import { loadState, recordRename, recordDeletion } from './state';
import { markdown, MAX_FILE_BYTES } from './content';
import { localStore } from './local';
import { recoveryPath, recoveryStorage } from './recovery';
import { App, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting, TFile, requestUrl, setIcon } from 'obsidian';
import { AuthSession, type SecretStore, type Transport } from './auth';
import { CALLBACK_URL, PROTOCOL_ACTION, parseCallback, parseManualCallback } from './protocol';
import { runDriveProbe, type ProbeReport, type ProbeTransport } from './drive-probe';
import { AddDeviceModal, ConnectDeviceModal, type PairingHost } from './pairing-ui';
import { validateInvitation, validateConfig, type Invitation } from './pairing';
import { DriveStore, folderIdentifier } from './drive';
import { FolderModal } from './folder-ui';
import { VaultSetup, projectConfig } from './vault-setup';
import { ReuseVaultSetupModal, approveVaultSetup } from './vault-setup-ui';
import { TransferBarrier, VALIDATION_MANIFEST, validateFixture } from './validation';
import { retryRead } from './read-retry';
import { ReconciliationRequired, loadDriveIndex, type DriveIndex } from './drive-index';
import { LocalIndex } from './local-index';
import { SyncEngine, syncPath, type SyncState, type LocalStore } from './sync';

interface Settings {
  clientId: string; clientSecretName: string; instanceId: string;
  folderId: string; folderPending: boolean; syncEnabled: boolean; syncState: SyncState;
  driveIndex?: DriveIndex;
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
export default class DriveSyncPlugin extends Plugin {
  declare settings: Settings;
  auth!: AuthSession;
  syncMessage = 'Set up Google to begin.';
  lastChecked = '';
  details: string[] = [];
  private statusEl?: HTMLElement;
  private ribbonStatus?: HTMLElement;
  private ribbonIcon = '';
  private listeners = new Set<() => void>();
  private unloaded = false;
  private saveTail: Promise<void> = Promise.resolve();
  private timer?: number;
  private nextCheck = 0;
  private running?: Promise<void>;
  private dirty = false;
  private retryAt = 0;
  private failures = 0;
  private retryIsNetwork = false;
  private recoveryEpoch = 0;
  private suspensionEpoch = 0;
  private readonly network = new NetworkAccess(() => navigator.onLine !== false);
  private wasOffline = false;
  private engine?: SyncEngine;
  private probeRunning = false;
  private pairingModal?: ConnectDeviceModal;
  private vaultSetup?: VaultSetup;
  private reuseModal?: ReuseVaultSetupModal;
  private localIndex!: LocalIndex;
  private fullRequested = false;
  private reconciliationRequired = false;
  readonly validationBarrier = new TransferBarrier(() => this.updateStatus());
  probeReport?: ProbeReport;
  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<Settings> | null;
    this.settings = {
      clientId: typeof saved?.clientId === 'string' ? saved.clientId : '',
      clientSecretName: typeof saved?.clientSecretName === 'string' ? saved.clientSecretName : '',
      instanceId: typeof saved?.instanceId === 'string' && /^[a-f0-9-]{36}$/.test(saved.instanceId) ? saved.instanceId : crypto.randomUUID(),
      folderId: typeof saved?.folderId === 'string' && /^[A-Za-z0-9_-]+$/.test(saved.folderId) ? saved.folderId : '',
      folderPending: saved?.folderPending === true,
      syncEnabled: saved?.syncEnabled === true, syncState: loadState(saved?.syncState, saved?.folderId ?? ''),
    };
    try {
      this.settings.driveIndex = loadDriveIndex(JSON.parse(await this.app.vault.adapter.read(this.indexPath())), this.settings.folderId);
    } catch { /* First setup builds an index; established vaults request manual recovery. */ }
    this.localIndex = new LocalIndex(path => {
      const file = this.app.vault.getAbstractFileByPath(path);
      return file instanceof TFile ? `${file.stat.mtime}:${file.stat.ctime}:${file.stat.size}` : undefined;
    });
    await this.saveSettings();
    const secrets = secureStore(this.app);
    this.auth = new AuthSession(secrets, `drive-sync-${this.settings.instanceId}`, this.authTransport, () => ({
      clientId: this.settings.clientId.trim(), clientSecret: secrets.get(this.settings.clientSecretName) ?? ''
    }), () => this.updateStatus(), Date.now, () => (this.app as App & { appId?: string }).appId);
    if (Platform.isDesktopApp) {
      this.statusEl = this.addStatusBarItem(); this.statusEl.addClass('drive-sync-status');
      this.registerDomEvent(this.statusEl, 'click', () => this.showConnection());
      if (typeof BroadcastChannel !== 'undefined' && this.app.vault.getName().length <= 200 && !/[\x00-\x1f\x7f]/.test(this.app.vault.getName())) {
        this.vaultSetup = new VaultSetup(new BroadcastChannel('drive-sync-vault-setup-v1'), this.app.vault.getName(),
          () => !!this.settings.clientId && !!secrets.get(this.settings.clientSecretName),
          () => projectConfig({ clientId: this.settings.clientId, clientSecret: secrets.get(this.settings.clientSecretName) }),
          (peer, code, signal) => approveVaultSetup(this.app, peer, code, signal));
        this.register(() => this.vaultSetup?.close());
      }
    }
    this.ribbonStatus = this.addRibbonIcon('cloud', 'Drive Sync status', () => this.showConnection());
    this.ribbonStatus.addClass('drive-sync-ribbon');
    this.addCommand({ id: 'show-connection', name: 'Show sync status', callback: () => this.showConnection() });
    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.manualSync() });
    this.addCommand({ id: 'full-reconciliation', name: 'Full reconciliation', callback: () => void this.manualSync(true) });
    this.addCommand({ id: 'test-drive-edits', name: 'Developer: test disposable Drive files', callback: () => new DriveProbeModal(this.app, this).open() });
    this.addCommand({ id: 'validate-fixture', name: 'Developer: synthetic vault validation', callback: () => new ValidationModal(this.app, this).open() });
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, params => {
      void this.run(async () => { await this.completeSignIn(parseCallback(new URLSearchParams(params))); });
    });
    this.registerObsidianProtocolHandler('drive-sync-pair', params => {
      void this.run(async () => { this.showPairing(validateInvitation(params)); });
    });
    this.addSettingTab(new DriveSyncSettings(this.app, this));
    const changed = () => { this.dirty = true; this.schedule(); };
    this.registerEvent(this.app.vault.on('modify', f => { if (f instanceof TFile && syncPath(f.path)) { this.localIndex.invalidate(f.path); changed(); } }));
    this.registerEvent(this.app.vault.on('create', f => { if (f instanceof TFile && syncPath(f.path)) { this.localIndex.invalidate(f.path); changed(); } }));
    this.registerEvent(this.app.vault.on('delete', f => {
      if (!syncPath(f.path)) return;
      this.localIndex.clear();
      recordDeletion(this.settings.syncState, f.path);
      void this.run(() => this.saveSettings(), false); changed();
    }));
    this.registerEvent(this.app.vault.on('rename', (f, old) => {
      if (!syncPath(old) || !syncPath(f.path)) return;
      this.localIndex.clear();
      recordRename(this.settings.syncState, old, f.path);
      void this.run(() => this.saveSettings(), false); changed();
    }));
    this.wasOffline = this.network.offline;
    this.registerDomEvent(window, 'offline', () => this.connectivityChanged());
    this.registerDomEvent(window, 'online', () => this.connectivityChanged());
    this.registerDomEvent(document, 'visibilitychange', () => {
      this.visibilityChanged();
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      void this.run(async () => { await this.auth.restore(); await this.syncNow(); }, false);
    });
    this.updateStatus();
  }
  onunload(): void {
    this.unloaded = true; this.engine?.stop(); this.auth?.stop();
    this.validationBarrier.stop();
    if (this.timer) window.clearTimeout(this.timer);
    this.listeners.clear();
  }
  saveSettings(): Promise<void> {
    // The tree cache has its own checkpoint file. Do not copy/rewrite a huge
    // remote index for every individual file's recovery journal checkpoint.
    const { driveIndex: _index, ...settings } = this.settings;
    const snapshot = structuredClone(settings);
    const save = this.saveTail.catch(() => {}).then(() => this.saveData(snapshot)); this.saveTail = save; return save;
  }
  private indexPath(): string { return `${this.app.vault.configDir}/plugins/${this.manifest.id}/remote-index.json`; }
  async run(work: () => Promise<void>, notify = true): Promise<void> {
    try { await work(); } catch (error) {
      if (notify) new Notice(error instanceof Error ? error.message : 'Operation could not be completed.', 9000);
    }
    this.updateStatus();
  }
  private setMessage(message: string): void { this.syncMessage = message; this.updateStatus(); }
  private visibilityChanged(): void {
    if (document.visibilityState === 'visible') { this.localIndex.clear(); this.resumeNetwork(); }
    else {
      this.suspensionEpoch++; this.engine?.stop();
      if (this.timer) { window.clearTimeout(this.timer); this.timer = undefined; }
    }
  }
  private connectivityChanged(): void {
    const offline = navigator.onLine === false;
    if (offline === this.wasOffline) return;
    this.wasOffline = offline;
    if (!offline) { this.resumeNetwork(); return; }
    this.pauseOffline();
  }
  private pauseOffline(): void {
    this.suspensionEpoch++;
    this.network.suspend(); this.engine?.stop();
    if (this.timer) { window.clearTimeout(this.timer); this.timer = undefined; }
    if (this.settings.syncEnabled && this.settings.folderId) this.setMessage(OFFLINE_MESSAGE);
  }
  private resumeNetwork(): void {
    // Sample again on resume in case WebView missed an event while suspended.
    this.wasOffline = navigator.onLine === false;
    if (this.wasOffline) { this.pauseOffline(); return; }
    if (this.unloaded) return;
    this.recoveryEpoch++;
    this.clearNetworkRetry();
    if (document.visibilityState !== 'visible') return;
    if (this.running) this.dirty = true;
    else void this.syncNow();
  }
  private clearNetworkRetry(): void {
    this.auth.resumeNetwork();
    if (this.retryIsNetwork) { this.retryAt = 0; this.failures = 0; this.retryIsNetwork = false; }
  }
  async manualSync(full = false): Promise<void> {
    // An explicit check can test a stale offline hint, but never bypass Google's cooldown.
    if (this.running) await this.running;
    if (this.unloaded) return;
    const finish = this.network.manualProbe();
    this.clearNetworkRetry();
    try { await this.syncNow(full); }
    finally {
      finish();
      if (this.network.offline) this.schedule();
    }
  }
  private schedule(): void {
    if (this.timer) { window.clearTimeout(this.timer); this.timer = undefined; }
    if (this.unloaded || !this.settings.syncEnabled || !this.settings.folderId || this.settings.folderPending ||
        this.running || document.visibilityState !== 'visible' || (this.reconciliationRequired && !this.fullRequested)) return;
    if (this.network.offline) { this.setMessage(OFFLINE_MESSAGE); return; }
    if (this.auth.state.status === 'needs-reconnect') { this.setMessage('Reconnect Google'); return; }
    const now = Date.now();
    const due = this.dirty ? now + 1500 : this.nextCheck || now + 60_000;
    const ready = Math.max(due, this.retryAt, this.network.retryAfter);
    if (this.dirty) this.setMessage(ready > now + 1500 ? 'Sync incomplete · retrying' : 'Changes pending');
    // One timer: local edits debounce, otherwise wait 60 seconds after success.
    // Resume/online perform an immediate check and replace this timer.
    this.timer = window.setTimeout(() => { this.timer = undefined; void this.syncNow(); }, Math.max(0, ready - now));
  }
  private authTransport: Transport = async (url, body) => {
    const result = await this.network.request(() => requestUrl({ url, method: 'POST', contentType: 'application/x-www-form-urlencoded', body: body.toString(), throw: false }));
    this.network.observe(result.status, result.headers);
    let json: unknown = {};
    if (result.text) { try { json = JSON.parse(result.text); } catch { /* Never report provider text. */ } }
    return { status: result.status, json };
  };
  private driveTransport: ProbeTransport = async request => {
    if (this.unloaded) throw new Error('Plugin unloaded.');
    this.network.assertAvailable();
    const token = await this.auth.tokenForDrive();
    if (this.unloaded) throw new Error('Plugin unloaded.');
    const send = async (accessToken: string) => {
      const response = await retryRead(request.method, () => this.network.request(() => requestUrl({ ...request, headers: { ...request.headers, Authorization: `Bearer ${accessToken}` }, throw: false })), () => !this.unloaded && !this.network.offline && Date.now() >= this.network.retryAfter);
      this.network.observe(response.status, response.headers);
      return response;
    };
    let response = await send(token);
    if (response.status === 401) {
      // One refresh/retry only. Invalid grants surface Reconnect; never loop on 401.
      await this.auth.refresh();
      const refreshed = await this.auth.tokenForDrive();
      if (this.unloaded) throw new Error('Plugin unloaded.');
      response = await send(refreshed);
    }
    await this.validationBarrier.after(request, response.status);
    return { status: response.status, headers: response.headers, text: response.text, arrayBuffer: response.arrayBuffer };
  };
  async createSyncFolder(): Promise<void> {
    await this.auth.tokenForDrive();
    if (!this.settings.folderId) { this.settings.folderId = await DriveStore.reserveId(this.driveTransport); this.settings.folderPending = true; await this.saveSettings(); }
    await DriveStore.createFolder(this.driveTransport, `Obsidian Drive Sync - ${this.app.vault.getName()}`, this.settings.folderId);
    await new DriveStore(this.driveTransport, this.settings.folderId).verifyRoot();
    this.settings.folderPending = false; this.settings.syncEnabled = true; await this.saveSettings(); await this.syncNow();
  }
  chooseSyncFolder(): void {
    new FolderModal(this.app, {
      children: id => DriveStore.childFolders(this.driveTransport, id),
      preview: async value => {
        const id = folderIdentifier(value);
        const folder = await DriveStore.folder(this.driveTransport, id);
        return { folder, files: (await new DriveStore(this.driveTransport, id).list()).length };
      },
      connect: async id => {
        if (this.settings.folderId && this.settings.folderId !== id) throw new Error('This vault already has a Drive folder. Use a separate local vault for another folder.');
        await new DriveStore(this.driveTransport, id).list();
        this.settings.syncState = loadState(this.settings.syncState, id);
        this.settings.folderId = id; this.settings.folderPending = false; this.settings.syncEnabled = true;
        await this.saveSettings(); await this.syncNow();
      }
    }).open();
  }
  async setSyncEnabled(enabled: boolean): Promise<void> {
    this.settings.syncEnabled = enabled;
    if (!enabled) { this.engine?.stop(); if (this.timer) { window.clearTimeout(this.timer); this.timer = undefined; } }
    await this.saveSettings();

    if (enabled) await this.syncNow(); else this.setMessage('Paused');
  }
  private localStore(): LocalStore {
    const recovery = recoveryStorage(this.app.vault.adapter);
    const folders = (path: string) => recovery.folders(path, folder => this.app.vault.createFolder(folder));
    const excluded = (path: string) => path === this.app.vault.configDir || path.startsWith(`${this.app.vault.configDir}/`);
    const store = localStore({
      list: () => this.app.vault.getFiles().map(f => f.path).filter(path => path !== this.app.vault.configDir && !path.startsWith(`${this.app.vault.configDir}/`)),
      read: async path => {
        if (excluded(path)) throw new Error('Obsidian configuration is excluded from sync.');
        if (recoveryPath(path)) return recovery.read(path);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) return null;
        if (!(file instanceof TFile) || file.stat.size > MAX_FILE_BYTES) throw new Error(`Unsupported or oversized file (20 MB limit): ${path}`);
        return markdown(path) ? this.app.vault.read(file) : this.app.vault.readBinary(file);
      },
      create: async (path, content) => {
        if (excluded(path)) throw new Error('Obsidian configuration is excluded from sync.');
        await folders(path);
        if (typeof content === 'string') await this.app.vault.create(path, content);
        else await this.app.vault.createBinary(path, content);
      },
      rename: async (path, destination) => {
        if (excluded(path) || excluded(destination)) throw new Error('Obsidian configuration is excluded from sync.');
        if (recoveryPath(path)) { await folders(destination); await recovery.restore(path, destination); return; }
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error('Source file changed.');
        await folders(destination); await this.app.vault.rename(file, destination);
      },
      process: async (path, update) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error('Source file changed.');
        await this.app.vault.process(file, update);
      },
      bufferMatches: (path, expected) => this.app.workspace.getLeavesOfType('markdown').every(leaf => {
        const view = leaf.view;
        return !(view instanceof MarkdownView) || view.file?.path !== path || view.editor.getValue() === expected;
      }),
      active: () => !this.unloaded && this.settings.syncEnabled
    });
    const read = store.read;
    store.read = path => this.localIndex.read(path, () => read(path));
    store.unchanged = (path, hash) => this.localIndex.matches(path, hash);
    return store;
  }
  syncNow(full = false): Promise<void> {
    if (full) this.fullRequested = true;
    if (this.running) return full ? this.running.then(() => this.syncNow()) : this.running;
    if (this.unloaded || document.visibilityState !== 'visible') return Promise.resolve();
    if (!this.settings.folderId || this.settings.folderPending) { this.setMessage(this.auth.state.status === 'connected' ? 'Connected · choose a sync folder' : 'Connect Google to begin'); return Promise.resolve(); }
    if (!this.settings.syncEnabled) { this.setMessage('Paused'); return Promise.resolve(); }
    if (this.network.offline) { this.setMessage(OFFLINE_MESSAGE); return Promise.resolve(); }
    if (Date.now() < Math.max(this.retryAt, this.network.retryAfter)) { this.dirty = true; this.schedule(); return Promise.resolve(); }
    if (this.reconciliationRequired && !this.fullRequested) { this.setMessage('Full reconciliation required'); return Promise.resolve(); }
    if (this.timer) { window.clearTimeout(this.timer); this.timer = undefined; }
    const verifyAll = this.fullRequested; this.fullRequested = false;
    if (verifyAll) this.localIndex.clear();
    this.dirty = false; this.setMessage(verifyAll ? 'Full reconciliation…' : 'Syncing…');
    if (this.settings.syncState.folderId && this.settings.syncState.folderId !== this.settings.folderId) { this.setMessage('Sync folder does not match this vault’s saved state'); return Promise.resolve(); }
    this.settings.syncState.folderId = this.settings.folderId;
    const remote = new DriveStore(this.driveTransport, this.settings.folderId, {
      current: this.settings.driveIndex, rebuild: verifyAll,
      commit: async index => {
        // Cursor and snapshot are one record; interrupted writes rebuild safely.
        await this.app.vault.adapter.write(this.indexPath(), JSON.stringify(index));
        this.settings.driveIndex = index;
      }
    });
    const engine = new SyncEngine(this.localStore(), remote, this.settings.syncState, () => this.saveSettings(), verifyAll);
    this.engine = engine;
    const networkFailures = this.network.failures;
    const recoveryEpoch = this.recoveryEpoch;
    const suspensionEpoch = this.suspensionEpoch;
    const run = (async () => {
      try {
        if (!verifyAll && !this.settings.driveIndex && Object.keys(this.settings.syncState.baseline).length) throw new ReconciliationRequired();
        const result = await engine.run();
        this.reconciliationRequired = false;
        this.failures = 0; this.retryAt = 0; this.retryIsNetwork = false;
        this.nextCheck = Date.now() + 60_000;
        if (this.unloaded || !this.settings.syncEnabled) return;
        if (this.network.offline) { this.setMessage(OFFLINE_MESSAGE); return; }
        this.details = [...result.pending, ...result.conflicts.map(path => `Preserved conflict: ${path}`)];
        this.lastChecked = new Date().toLocaleTimeString();
        this.setMessage(result.pending.length ? `${result.pending.length} items need attention` : result.conflicts.length ? 'Conflicts preserved' : this.dirty ? 'Checking new changes…' : 'Synced with Drive');
        if (result.conflicts.length) new Notice('Drive Sync preserved both edits in conflict copies.', 8000);
      } catch (error) {
        if (error instanceof ReconciliationRequired) {
          this.reconciliationRequired = true; this.dirty = false;
          this.details = [error.message]; this.setMessage('Full reconciliation required'); return;
        }
        if (verifyAll) this.fullRequested = true;
        if (!this.unloaded && this.settings.syncEnabled) {
          if (this.network.offline) { this.setMessage(OFFLINE_MESSAGE); return; }
          this.retryIsNetwork = (this.network.failures !== networkFailures && this.network.lastFailureWasNetwork) || suspensionEpoch !== this.suspensionEpoch;
          // A request already in flight can fail after the recovery event. Do not
          // let that old network failure put the newly connected device back to sleep.
          if (this.retryIsNetwork && recoveryEpoch !== this.recoveryEpoch) {
            this.clearNetworkRetry(); this.dirty = true; return;
          }
          this.retryAt = Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(this.failures++, 4));
          this.dirty = true;
          this.details = [error instanceof Error ? error.message : 'Request failed; retrying.'];
          this.setMessage(this.auth.state.status === 'needs-reconnect' ? 'Reconnect Google' : 'Sync incomplete · retrying');
        }
      }
    })();
    this.running = run;
    void run.finally(() => { this.running = undefined; this.schedule(); });
    return run;
  }
  pairingHost(): PairingHost {
    return {
      config: async () => {
        if (!this.settings.folderId || this.settings.folderPending) throw new Error('Choose the desktop sync folder before adding a device.');
        return validateConfig({ clientId: this.settings.clientId, clientSecret: secureStore(this.app).get(this.settings.clientSecretName), folderId: this.settings.folderId, vaultName: this.app.vault.getName() });
      },
      accept: async config => {
        if (this.settings.clientId && this.settings.clientId !== config.clientId) throw new Error('This vault uses a different Google client. Use an empty vault to pair it.');
        if (this.settings.folderId && this.settings.folderId !== config.folderId) throw new Error('This vault already uses a different sync folder. Use an empty vault.');
        if (!config.folderId) throw new Error('Desktop has no sync folder configured.');
        const store = secureStore(this.app); const key = `drive-client-${this.settings.instanceId}`;
        store.set(key, config.clientSecret);
        if (store.get(key) !== config.clientSecret) throw new Error('Could not store paired configuration.');
        this.settings.clientId = config.clientId; this.settings.clientSecretName = key;
        this.settings.folderId = config.folderId; this.settings.folderPending = false; this.settings.syncEnabled = true;
        await this.saveSettings();
        if (this.auth.state.status === 'connected') void this.syncNow();
        else this.setMessage('Configuration received · sign in to Google');
      },
      connected: () => this.auth.state.status === 'connected',
      beginSignIn: () => this.auth.begin(),
      subscribe: listener => this.subscribe(listener),
      registerCleanup: cleanup => this.register(cleanup)
    };
  }
  showPairing(invitation?: Invitation): void {
    if (!this.pairingModal) {
      this.pairingModal = new ConnectDeviceModal(this.app, this.pairingHost(), () => { this.pairingModal = undefined; });
      this.pairingModal.open();
    }
    if (invitation) this.pairingModal.useInvitation(invitation);
  }
  reuseGoogleSetup(): void {
    if (!this.vaultSetup) { new Notice('Vault setup sharing is unavailable in this environment. Use Google project configuration.'); return; }
    if (this.reuseModal) return;
    if (this.settings.folderId || this.auth.state.status !== 'disconnected') { new Notice('Reuse setup in a new, disconnected vault before selecting its Drive folder.'); return; }
    this.reuseModal = new ReuseVaultSetupModal(this.app, this.vaultSetup, async input => {
      if (this.unloaded || this.settings.folderId || this.auth.state.status !== 'disconnected') throw new Error('Reuse setup in a new, disconnected vault before selecting its Drive folder.');
      const config = projectConfig(input);
      const store = secureStore(this.app); const key = `drive-client-${this.settings.instanceId}`;
      store.set(key, config.clientSecret);
      if (store.get(key) !== config.clientSecret) throw new Error('Could not save Google configuration in this vault’s Keychain.');
      this.settings.clientId = config.clientId; this.settings.clientSecretName = key;
      await this.saveSettings(); this.setMessage('Configuration received · sign in to Google');
    }, () => { this.reuseModal = undefined; });
    this.reuseModal.open();
    this.register(() => this.reuseModal?.close());
  }
  async completeSignIn(response: AuthCallback): Promise<void> {
    await this.auth.complete(response);
    this.retryAt = 0;
    await this.syncNow();
  }
  async connect(verifyPkce?: 'wrong' | 'missing'): Promise<void> {
    const url = await this.auth.begin(verifyPkce);
    if (Platform.isMobileApp) new BrowserSignInModal(this.app, url).open(); else window.open(url, '_blank');
  }
  async testDrive(progress: (message: string) => void): Promise<ProbeReport> {
    if (this.probeRunning || this.unloaded) throw new Error('A test is already running or the plugin is unloading.');
    this.probeRunning = true;
    try {
      const edits = await runDriveProbe(this.driveTransport, progress, 'v2');
      if (!edits.passed) return this.probeReport = edits;
      const lifecycle = await runLifecycleProbe(this.driveTransport, progress);
      return this.probeReport = { ...lifecycle, checks: [...edits.checks, ...lifecycle.checks], cleanup: `${edits.cleanup} ${lifecycle.cleanup}` };
    }
    finally { this.probeRunning = false; }
  }
  showConnection(): void { new ConnectionModal(this.app, this).open(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private updateStatus(): void {
    if (!this.auth) return;
    this.statusEl?.setText(`Drive: ${this.syncMessage}`);
    if (this.ribbonStatus) {
      const attention = this.auth.state.status === 'needs-reconnect' || (!this.network.offline && this.retryAt > 0) || this.details.length > 0 || this.syncMessage === 'Sync folder does not match this vault’s saved state';
      const busy = ['Syncing…', 'Full reconciliation…', 'Changes pending', 'Checking new changes…'].includes(this.syncMessage);
      const icon = this.syncMessage === OFFLINE_MESSAGE ? 'cloud-off' : attention ? 'cloud-alert' : this.syncMessage === 'Paused' ? 'pause' : busy ? 'refresh-cw' : 'cloud';
      if (icon !== this.ribbonIcon) { setIcon(this.ribbonStatus, icon); this.ribbonIcon = icon; }
      this.ribbonStatus.toggleClass('drive-sync-needs-attention', attention);
      this.ribbonStatus.setAttribute('aria-label', `Drive Sync: ${this.syncMessage}. Show sync status`);
    }
    for (const listener of [...this.listeners]) listener();
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
    this.setTitle(`Drive Sync · ${this.app.vault.getName()}`);
    const status = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    const details = this.contentEl.createEl('pre'); details.style.whiteSpace = 'pre-wrap';
    const render = () => { status.setText(this.plugin.syncMessage); details.setText([this.plugin.auth.state.message, this.plugin.lastChecked ? `Last completed check: ${this.plugin.lastChecked}` : '', ...this.plugin.details].filter(Boolean).join('\n')); };
    render(); this.unsubscribe = this.plugin.subscribe(render);
    new Setting(this.contentEl).addButton(b => b.setButtonText('Sync now').setCta().onClick(() => void this.plugin.manualSync()))
      .addButton(b => b.setButtonText(this.plugin.settings.syncEnabled ? 'Pause' : 'Resume').onClick(() => void this.plugin.run(async () => {
        await this.plugin.setSyncEnabled(!this.plugin.settings.syncEnabled); b.setButtonText(this.plugin.settings.syncEnabled ? 'Pause' : 'Resume');
      })));
    this.contentEl.createEl('p', { text: 'Syncs notes and attachments up to 20 MB per file. Removals go to Drive trash or this vault’s .trash/drive-sync folder. Lost access never triggers deletion.' });
    const advanced = this.contentEl.createEl('details'); advanced.createEl('summary', { text: 'Connection and diagnostics' });
    new Setting(advanced).setName('Full reconciliation').setDesc('Recovery check: rebuilds indexes and reads every file on both sides. Existing conflict copies and deletion protections remain in effect; large vaults can take time.')
      .addButton(b => b.setButtonText('Full reconciliation').onClick(() => {
        b.setDisabled(true); void this.plugin.run(() => finishUiAction(this.plugin.manualSync(true), () => b.setDisabled(false)));
      }));
    new Setting(advanced).addButton(b => b.setButtonText('Sign in to Google').onClick(() => void this.plugin.run(() => this.plugin.connect())))
      .addButton(b => b.setButtonText('Test refresh').onClick(() => void this.plugin.run(() => this.plugin.auth.refresh())));
    new Setting(advanced).addButton(b => b.setButtonText('Paste return link').onClick(() => { this.close(); new ReturnLinkModal(this.app, this.plugin).open(); }))
      .addButton(b => b.setButtonText('Run disposable file test').onClick(() => { this.close(); new DriveProbeModal(this.app, this.plugin).open(); }));
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
      void this.plugin.run(async () => { await this.plugin.completeSignIn(parseManualCallback(submitted)); });
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
    el.createEl('p', { text: 'Your own Google project, normal files in Drive, and a separate local vault on each device. Each device signs in separately; no sync server is needed.' });
    if (Platform.isMobileApp && !this.plugin.settings.folderId) new Setting(el).setName('Set up from desktop').setDesc('Transfer Google configuration and the sync folder over your local network.')
      .addButton(b => b.setButtonText('Connect to existing device').setCta().onClick(() => this.plugin.showPairing()));
    if (Platform.isDesktopApp && !this.plugin.settings.folderId) new Setting(el).setName('Reuse Google setup from another vault')
      .setDesc('Use an open vault on this computer. Approve the transfer there, then sign in and select this vault’s own Drive folder.')
      .addButton(b => b.setButtonText('Choose vault').onClick(() => this.plugin.reuseGoogleSetup()));
    const connection = new Setting(el).setName('Google connection').setDesc(this.plugin.auth.state.message)
      .addButton(b => b.setButtonText('Sign in to Google').onClick(() => void this.plugin.run(() => this.plugin.connect())));
    if ((!this.plugin.settings.folderId || this.plugin.settings.folderPending) && Platform.isDesktopApp) new Setting(el).setName('Sync folder').setDesc('Choose an existing Google Drive folder or create a new one for this vault. Files added through Drive are included automatically.')
      .addButton(b => b.setButtonText('Choose existing folder').setCta().onClick(() => this.plugin.chooseSyncFolder()))
      .addButton(b => b.setButtonText('Create sync folder').onClick(() => void this.plugin.run(async () => { await this.plugin.createSyncFolder(); this.display(); })));
    if (this.plugin.settings.folderId && !this.plugin.settings.folderPending) {
      new Setting(el).setName(`Google Drive folder · ${this.app.vault.getName()}`).addButton(b => b.setButtonText('Open folder in Drive').onClick(() => window.open(`https://drive.google.com/drive/folders/${this.plugin.settings.folderId}`, '_blank')));
      new Setting(el).setName('Automatic sync').setDesc('Uploads saved edits automatically. Checks Drive changes on open, resume, and reconnection, then every 60 seconds while active and online.')
        .addToggle(t => t.setValue(this.plugin.settings.syncEnabled).onChange(value => void this.plugin.run(() => this.plugin.setSyncEnabled(value))));
      if (Platform.isDesktopApp) new Setting(el).setName('Set up your phone').setDesc('Share Google project configuration and this vault’s Drive folder with your phone using a QR code. Each device keeps its own Google sign-in.')
        .addButton(b => b.setButtonText('Add device').setCta().onClick(() => new AddDeviceModal(this.app, this.plugin.pairingHost()).open()));
    }
    const status = new Setting(el).setName('Sync status').setDesc(this.plugin.syncMessage).addButton(b => b.setButtonText('View details').onClick(() => this.plugin.showConnection()));
    const displayedFolder = this.plugin.settings.folderId;
    const displayedClient = this.plugin.settings.clientId + this.plugin.settings.clientSecretName;
    this.unsubscribe = this.plugin.subscribe(() => { if (displayedFolder !== this.plugin.settings.folderId || displayedClient !== this.plugin.settings.clientId + this.plugin.settings.clientSecretName) { this.display(); return; } connection.setDesc(this.plugin.auth.state.message); status.setDesc(this.plugin.syncMessage); });
    const config = el.createEl('details'); config.open = !this.plugin.settings.clientId && Platform.isDesktopApp;
    config.createEl('summary', { text: Platform.isDesktopApp ? 'Google project configuration' : 'Advanced Google configuration' });
    if (Platform.isMobileApp && this.plugin.settings.folderId) new Setting(config).addButton(b => b.setButtonText('Pair with desktop again').onClick(() => this.plugin.showPairing()));
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
    config.createEl('p', { text: 'Google grants access to all Drive files. This plugin synchronizes only the folder selected for this vault; that restriction is enforced by the plugin, not the token. External Google projects in Testing commonly require sign-in again after seven days.' });
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
class ValidationModal extends Modal {
  private unsubscribe?: () => void;
  constructor(app: App, private readonly plugin: DriveSyncPlugin) { super(app); }
  onOpen(): void {
    this.setTitle(`Synthetic validation · ${this.app.vault.getName()}`);
    this.contentEl.createEl('p', { text: 'Developer checks for disposable vaults only. A synthetic validation manifest is required to arm an interruption. The barrier holds a successful Google response before the sync engine checkpoints it; no credentials or file contents are logged.' });
    const output = this.contentEl.createEl('p', { attr: { role: 'status' } });
    const barrier = this.contentEl.createEl('p', { attr: { role: 'status' } });
    const render = () => barrier.setText(this.plugin.validationBarrier.status);
    this.unsubscribe = this.plugin.subscribe(render); render();
    const work = (fn: () => Promise<void>) => { void fn().catch(e => output.setText(e instanceof Error ? e.message : 'Validation failed.')); };
    const requireFixture = async () => {
      const manifest = JSON.parse(await this.app.vault.adapter.read(VALIDATION_MANIFEST));
      if (manifest.kind !== 'drive-sync-synthetic-validation-v1') throw new Error('Synthetic fixture manifest required.');
    };
    new Setting(this.contentEl).addButton(b => b.setButtonText('Verify all fixture checksums').onClick(() => work(async () => {
      b.setDisabled(true); output.setText('Checking local file bytes…');
      try { output.setText(await validateFixture({ read: p => this.app.vault.adapter.read(p), readBinary: p => this.app.vault.adapter.readBinary(p), list: () => this.app.vault.getFiles().map(f => f.path) })); }
      finally { b.setDisabled(false); }
    })));
    for (const mode of ['upload', 'download'] as const) new Setting(this.contentEl).addButton(b => b.setButtonText(`Hold next ${mode} response`).onClick(() => work(async () => { await requireFixture(); this.plugin.validationBarrier.arm(mode); })));
    new Setting(this.contentEl).addButton(b => b.setButtonText('Create synthetic upload note').onClick(() => work(async () => {
      await requireFixture();
      const path = `Drive Sync interruption ${crypto.randomUUID()}.md`;
      await this.app.vault.create(path, '# Synthetic interruption test\n\nCreated on this device to test recovery after Google accepts an upload.\n');
      output.setText(`Created ${path}`);
    })));
    new Setting(this.contentEl).addButton(b => b.setButtonText('Release response').onClick(() => this.plugin.validationBarrier.release()))
      .addButton(b => b.setButtonText('Cancel barrier').onClick(() => this.plugin.validationBarrier.stop()));
  }
  onClose(): void { this.unsubscribe?.(); this.contentEl.empty(); }
}
