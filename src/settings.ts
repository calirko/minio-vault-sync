import { App, PluginSettingTab, Setting } from 'obsidian';
import type MinioSyncPlugin from './main';

export interface MinioSyncSettings {
	endpoint: string;
	port: number;
	useSSL: boolean;
	accessKey: string;
	secretKey: string;
	bucket: string;
	/** Prefix used for conflict-renamed files, e.g. "laptop__note.md". */
	deviceNickname: string;
	/** Cadence for the periodic full two-way sync. */
	syncIntervalMinutes: number;
}

export const DEFAULT_SETTINGS: MinioSyncSettings = {
	endpoint: '',
	port: 9000,
	useSSL: true,
	accessKey: '',
	secretKey: '',
	bucket: '',
	deviceNickname: '',
	syncIntervalMinutes: 5,
};

export class MinioSyncSettingTab extends PluginSettingTab {
	plugin: MinioSyncPlugin;

	constructor(app: App, plugin: MinioSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Endpoint')
			.setDesc('MinIO server host, e.g. minio.example.com')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.endpoint)
					.onChange(async (value) => {
						this.plugin.settings.endpoint = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Port')
			.setDesc('MinIO server port, e.g. 9000')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.port))
					.onChange(async (value) => {
						const port = Number(value);
						if (!Number.isNaN(port)) {
							this.plugin.settings.port = port;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName('Use SSL')
			.setDesc('Connect to the MinIO server over HTTPS instead of HTTP')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useSSL)
					.onChange(async (value) => {
						this.plugin.settings.useSSL = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Access key')
			.setDesc('Access key ID for the MinIO account used to sync this vault')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.accessKey)
					.onChange(async (value) => {
						this.plugin.settings.accessKey = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Secret key')
			.setDesc('Secret access key for the MinIO account used to sync this vault')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setValue(this.plugin.settings.secretKey)
					.onChange(async (value) => {
						this.plugin.settings.secretKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Bucket')
			.setDesc('Name of the bucket this vault will be synced to')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.bucket)
					.onChange(async (value) => {
						this.plugin.settings.bucket = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Device nickname')
			.setDesc('Prefix used to tag this device\'s copy of a file when a sync conflict is detected')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.deviceNickname)
					.onChange(async (value) => {
						this.plugin.settings.deviceNickname = value.trim().replace(/\//g, '');
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Sync interval (minutes)')
			.setDesc('How often to run a full two-way sync while Obsidian is open')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.syncIntervalMinutes))
					.onChange(async (value) => {
						const minutes = Number(value);
						if (Number.isFinite(minutes) && minutes >= 1) {
							this.plugin.settings.syncIntervalMinutes = minutes;
							await this.plugin.saveSettings();
						}
					}),
			);
	}
}
