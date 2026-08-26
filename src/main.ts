import { Notice, Plugin, TAbstractFile, TFile } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	MinioSyncSettings,
	MinioSyncSettingTab,
} from './settings';
import { SyncEngine, TOMBSTONE_PREFIX } from './sync';
import { SyncOrchestrator } from './sync-orchestrator';
import { SetupModal } from './setup-modal';

function isConfigured(settings: MinioSyncSettings): boolean {
	return Boolean(
		settings.endpoint && settings.accessKey && settings.secretKey && settings.bucket,
	);
}

export default class MinioSyncPlugin extends Plugin {
	settings!: MinioSyncSettings;
	sync: SyncEngine | null = null;
	orchestrator: SyncOrchestrator | null = null;
	private intervalId: number | null = null;
	private syncStatusBarItem!: HTMLElement;
	private syncStatusToken = 0;

	async onload() {
		await this.loadSettings();
		this.rebuildSync();

		this.addRibbonIcon('refresh-cw', 'MinIO vault sync', () => {
			new SetupModal(this.app, this).open();
		});

		this.addSettingTab(new MinioSyncSettingTab(this.app, this));

		this.syncStatusBarItem = this.addStatusBarItem();
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => this.updateSyncStatusBar()),
		);

		this.addCommand({
			id: 'setup',
			name: 'Setup MinIO sync',
			callback: () => new SetupModal(this.app, this).open(),
		});

		this.addCommand({
			id: 'test-connection',
			name: 'Test MinIO connection',
			callback: async () => {
				if (!this.sync) {
					new Notice('MinIO sync is not set up yet. Run "Setup MinIO sync" first.');
					return;
				}
				try {
					await this.sync.testConnection();
					new Notice('MinIO connection OK');
				} catch (err) {
					console.error('MinIO sync: connection test failed', err);
					new Notice(`MinIO connection failed: ${(err as Error).message}`);
				}
			},
		});

		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: async () => {
				if (!this.orchestrator) {
					new Notice('MinIO sync is not set up yet. Run "Setup MinIO sync" first.');
					return;
				}
				try {
					const summary = await this.orchestrator.runFullSync();
					if (summary.errors.length) console.error('MinIO sync: per-file errors', summary.errors);
					new Notice(
						`MinIO sync done: ${summary.pushed.length} pushed, ${summary.pulled.length} pulled, ${summary.conflicts.length} conflict(s), ${summary.errors.length} error(s)`,
					);
				} catch (err) {
					console.error('MinIO sync: sync-now failed', err);
					new Notice(`MinIO sync failed: ${(err as Error).message}`);
				} finally {
					this.updateSyncStatusBar();
				}
			},
		});

		// Vault listeners are registered once the layout is ready to avoid the flood of
		// spurious "create" events Obsidian fires for the whole vault during startup.
		this.app.workspace.onLayoutReady(() => {
			this.registerVaultListeners();
			this.updateSyncStatusBar();
			this.orchestrator
				?.runFullSync()
				.then((summary) => {
					if (summary.errors.length) console.error('MinIO sync: per-file errors', summary.errors);
				})
				.catch((err) => {
					console.error('MinIO sync: startup sync failed', err);
					new Notice(`MinIO sync: startup sync failed: ${(err as Error).message}`);
				})
				.finally(() => this.updateSyncStatusBar());
		});

		// Best-effort: Obsidian does not guarantee this callback actually runs.
		this.registerEvent(
			this.app.workspace.on('quit', (tasks) => {
				tasks.add(async () => {
					try {
						await this.orchestrator?.runFullSync();
					} catch {
						// best-effort; nothing more we can do during shutdown
					}
				});
			}),
		);
	}

	onunload() {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.orchestrator?.cancelPendingDebounces();
	}

	private registerVaultListeners() {
		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				if (!(file instanceof TFile)) return;
				if (this.orchestrator?.wasSelfWrite(file.path)) return;
				this.orchestrator?.scheduleDebouncedPush(file.path);
				this.updateSyncStatusBar();
			}),
		);
		this.registerEvent(
			this.app.vault.on('modify', (file: TAbstractFile) => {
				if (!(file instanceof TFile)) return;
				if (this.orchestrator?.wasSelfWrite(file.path)) return;
				this.orchestrator?.scheduleDebouncedPush(file.path);
				this.updateSyncStatusBar();
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				if (!(file instanceof TFile)) return;
				if (this.orchestrator?.wasSelfWrite(file.path)) return;
				this.orchestrator
					?.deleteSingleFile(file.path)
					.catch((err) => {
						console.error(`MinIO sync: failed to delete ${file.path}`, err);
						new Notice(`MinIO sync: failed to delete ${file.path}: ${(err as Error).message}`);
					})
					.finally(() => this.updateSyncStatusBar());
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				if (!(file instanceof TFile)) return;
				if (this.orchestrator?.wasSelfWrite(file.path)) return;
				this.orchestrator
					?.renameFile(oldPath, file.path)
					.catch((err) => {
						console.error(`MinIO sync: failed to sync rename of ${file.path}`, err);
						new Notice(`MinIO sync: failed to sync rename of ${file.path}: ${(err as Error).message}`);
					})
					.finally(() => this.updateSyncStatusBar());
			}),
		);
	}

	/** Refreshes the status bar with a single word describing whether the active file is synced. */
	private updateSyncStatusBar() {
		if (!this.syncStatusBarItem) return;

		const token = ++this.syncStatusToken;
		const file = this.app.workspace.getActiveFile();

		if (!this.orchestrator || !file) {
			this.syncStatusBarItem.setText('');
			return;
		}

		this.orchestrator
			.getSyncStatus(file.path)
			.then((status) => {
				if (token !== this.syncStatusToken) return;
				this.syncStatusBarItem.setText(status === 'synced' ? 'Synced' : 'Unsynced');
			})
			.catch(() => {
				if (token !== this.syncStatusToken) return;
				this.syncStatusBarItem.setText('');
			});
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<MinioSyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.rebuildSync();
	}

	private rebuildSync() {
		this.sync = isConfigured(this.settings) ? new SyncEngine(this.settings) : null;

		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}

		if (this.sync) {
			// TOMBSTONE_PREFIX is excluded too: it's a reserved remote-only namespace, but if a
			// local folder ever exists at that exact path (however unlikely), it must never be
			// scanned/pushed/deleted through the normal sync path — that would corrupt tombstone
			// state instead of just being synced content.
			const excludePrefixes = [`${this.app.vault.configDir}/plugins/${this.manifest.id}`, TOMBSTONE_PREFIX];
			const manifestPath = `${excludePrefixes[0]}/sync-state.json`;
			this.orchestrator = new SyncOrchestrator(
				this.app,
				this.sync,
				manifestPath,
				this.settings.deviceNickname || 'device',
				excludePrefixes,
			);

			this.intervalId = window.setInterval(() => {
				this.orchestrator
					?.runFullSync()
					.then((summary) => {
						if (summary.errors.length) console.error('MinIO sync: per-file errors', summary.errors);
					})
					.catch((err) => {
						console.error('MinIO sync: periodic sync failed', err);
						new Notice(`MinIO sync: periodic sync failed: ${(err as Error).message}`);
					})
					.finally(() => this.updateSyncStatusBar());
			}, this.settings.syncIntervalMinutes * 60_000);
			this.registerInterval(this.intervalId);
		} else {
			this.orchestrator = null;
		}

		this.updateSyncStatusBar();
	}
}
