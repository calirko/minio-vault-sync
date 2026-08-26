import { App, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
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

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Endpoint',
				desc: 'MinIO server host, e.g. minio.example.com',
				control: { type: 'text', key: 'endpoint', placeholder: 'minio.example.com' },
			},
			{
				name: 'Port',
				desc: 'MinIO server port, e.g. 9000',
				control: {
					type: 'number',
					key: 'port',
					validate: (value) => (Number.isFinite(value) ? undefined : 'Enter a valid port number'),
				},
			},
			{
				name: 'Use SSL',
				desc: 'Connect to the MinIO server over HTTPS instead of HTTP',
				control: { type: 'toggle', key: 'useSSL' },
			},
			{
				name: 'Access key',
				desc: 'Access key ID for the MinIO account used to sync this vault',
				control: { type: 'text', key: 'accessKey' },
			},
			{
				name: 'Secret key',
				desc: 'Secret access key for the MinIO account used to sync this vault',
				render: (setting) => {
					setting.addText((text) => {
						text.inputEl.type = 'password';
						text.setValue(this.plugin.settings.secretKey).onChange(async (value) => {
							this.plugin.settings.secretKey = value.trim();
							await this.plugin.saveSettings();
						});
					});
				},
			},
			{
				name: 'Bucket',
				desc: 'Name of the bucket this vault will be synced to',
				control: { type: 'text', key: 'bucket' },
			},
			{
				name: 'Device nickname',
				desc: "Prefix used to tag this device's copy of a file when a sync conflict is detected",
				control: { type: 'text', key: 'deviceNickname' },
			},
			{
				name: 'Sync interval (minutes)',
				desc: 'How often to run a full two-way sync while Obsidian is open',
				control: {
					type: 'number',
					key: 'syncIntervalMinutes',
					min: 1,
					validate: (value) => (Number.isFinite(value) && value >= 1 ? undefined : 'Must be at least 1 minute'),
				},
			},
		];
	}

	setControlValue(key: string, value: unknown): void | Promise<void> {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		if ((key === 'endpoint' || key === 'accessKey' || key === 'bucket') && typeof value === 'string') {
			settings[key] = value.trim();
		} else if (key === 'deviceNickname' && typeof value === 'string') {
			settings[key] = value.trim().replace(/\//g, '');
		} else {
			settings[key] = value;
		}
		return this.plugin.saveSettings();
	}
}
