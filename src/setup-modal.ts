import { App, Modal, Notice, Setting } from 'obsidian';
import type MinioSyncPlugin from './main';
import { MinioSyncSettings } from './settings';
import { SyncEngine } from './sync';

export class SetupModal extends Modal {
	private plugin: MinioSyncPlugin;
	private draft: MinioSyncSettings;

	constructor(app: App, plugin: MinioSyncPlugin) {
		super(app);
		this.plugin = plugin;
		this.draft = { ...plugin.settings };
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Set up MinIO sync' });

		new Setting(contentEl)
			.setName('Host')
			.setDesc('MinIO server host, e.g. minio.example.com')
			.addText((text) =>
				text
					.setValue(this.draft.endpoint)
					.onChange((value) => (this.draft.endpoint = value.trim())),
			);

		new Setting(contentEl).setName('Port').addText((text) =>
			text.setValue(String(this.draft.port)).onChange((value) => {
				const port = Number(value);
				if (!Number.isNaN(port)) this.draft.port = port;
			}),
		);

		new Setting(contentEl).setName('Bucket').addText((text) =>
			text
				.setValue(this.draft.bucket)
				.onChange((value) => (this.draft.bucket = value.trim())),
		);

		new Setting(contentEl).setName('Username').addText((text) =>
			text
				.setValue(this.draft.accessKey)
				.onChange((value) => (this.draft.accessKey = value.trim())),
		);

		new Setting(contentEl).setName('Password').addText((text) => {
			text.inputEl.type = 'password';
			text
				.setValue(this.draft.secretKey)
				.onChange((value) => (this.draft.secretKey = value.trim()));
		});

		new Setting(contentEl)
			.setName('Device nickname')
			.setDesc('Used to tag this device\'s files when a sync conflict is detected')
			.addText((text) =>
				text
					.setValue(this.draft.deviceNickname)
					.onChange((value) => (this.draft.deviceNickname = value.trim().replace(/\//g, ''))),
			);

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText('Test').onClick(async () => {
					btn.setDisabled(true);
					try {
						await new SyncEngine(this.draft).testConnection();
						new Notice('Connection OK');
					} catch (err) {
						new Notice(`Connection failed: ${(err as Error).message}`);
					} finally {
						btn.setDisabled(false);
					}
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText('Save')
					.setCta()
					.onClick(async () => {
						if (!this.draft.deviceNickname) {
							this.draft.deviceNickname = 'device';
							new Notice('No device nickname set — defaulting to "device".');
						}
						this.plugin.settings = this.draft;
						await this.plugin.saveSettings();
						this.close();
						new Notice('MinIO sync is set up.');
					}),
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}
