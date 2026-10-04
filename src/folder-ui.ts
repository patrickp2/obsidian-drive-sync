import { App, Modal, Setting } from 'obsidian';
import type { DriveFolder } from './drive';

export interface FolderHost {
  children(id: string): Promise<DriveFolder[]>;
  preview(idOrLink: string): Promise<{ folder: DriveFolder; files: number }>;
  connect(id: string): Promise<void>;
}
/** A single panel, with explicit folder selection before any vault changes. */
export class FolderModal extends Modal {
  private generation = 0;
  private trail: DriveFolder[] = [{ id: 'root', name: 'My Drive' }];
  constructor(app: App, private readonly host: FolderHost) { super(app); }
  onOpen(): void { void this.browse(); }
  onClose(): void { this.generation++; this.contentEl.empty(); }
  private async browse(): Promise<void> {
    const generation = ++this.generation;
    const folder = this.trail.at(-1)!;
    this.setTitle('Choose a Drive folder'); this.contentEl.empty();
    this.contentEl.createEl('p', { text: this.trail.map(f => f.name).join(' / ') });
    const message = this.contentEl.createEl('p', { text: 'Loading folders…', attr: { role: 'status' } });
    try {
      const children = await this.host.children(folder.id);
      if (generation !== this.generation) return;
      message.setText('Choose the folder for this vault. Its notes and attachments will sync in both directions, including files added through Google Drive.');
      const navigation = new Setting(this.contentEl);
      if (this.trail.length > 1) {
        navigation.addButton(b => b.setButtonText('Back').onClick(() => { this.trail.pop(); void this.browse(); }));
        navigation.addButton(b => b.setButtonText('Use this folder').setCta().onClick(() => void this.preview(folder.id)));
      }
      let link = '';
      new Setting(this.contentEl).setName('Or open a folder link').addText(t => t.setPlaceholder('Google Drive folder link or ID').onChange(value => { link = value; }))
        .addButton(b => b.setButtonText('Open').onClick(() => void this.preview(link)));
      if (!children.length) this.contentEl.createEl('p', { text: 'No subfolders here.' });
      for (const child of children) new Setting(this.contentEl).setName(child.name).addButton(b => b.setButtonText('Open folder').onClick(() => { this.trail.push(child); void this.browse(); }));
    } catch (error) { if (generation === this.generation) message.setText(error instanceof Error ? error.message : 'Could not list folders.'); }
  }
  private async preview(value: string): Promise<void> {
    const generation = ++this.generation;
    this.setTitle('Connect this folder'); this.contentEl.empty();
    const message = this.contentEl.createEl('p', { text: 'Checking folder…', attr: { role: 'status' } });
    try {
      const { folder, files } = await this.host.preview(value);
      if (generation !== this.generation) return;
      message.setText(`Connect “${folder.name}” to the local vault “${this.app.vault.getName()}”? This folder contains ${files} supported files. Existing local files will also upload; differing versions are preserved as conflict copies.`);
      this.contentEl.createEl('p', { text: `Folder ID: ${folder.id}` });
      this.contentEl.createEl('p', { text: 'Google grants access to all Drive files. The plugin limits synchronization to this folder and its subfolders.' });
      new Setting(this.contentEl).addButton(b => b.setButtonText('Back').onClick(() => void this.browse()))
        .addButton(b => b.setButtonText('Connect this folder').setCta().onClick(async () => {
          b.setDisabled(true);
          try { await this.host.connect(folder.id); if (generation === this.generation) this.close(); }
          catch (error) { if (generation === this.generation) { message.setText(error instanceof Error ? error.message : 'Could not connect folder.'); b.setDisabled(false); } }
        }));
    } catch (error) {
      if (generation !== this.generation) return;
      message.setText(error instanceof Error ? error.message : 'Could not open folder.');
      new Setting(this.contentEl).addButton(b => b.setButtonText('Back').onClick(() => void this.browse()));
    }
  }
}
