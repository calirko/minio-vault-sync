import { Notice, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
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
	private syncStatusBarTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		this.rebuildSync();

		this.addRibbonIcon('refresh-cw', 'MinIO vault sync', () => {
			new SetupModal(this.app, this).open();
		});

		this.addSettingTab(new MinioSyncSettingTab(this.app, this));

		this.syncStatusBarItem = this.addStatusBarItem();
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => this.requestSyncStatusBarUpdate()),
		);
		this.registerEvent(this.app.workspace.on('file-open', () => this.requestSyncStatusBarUpdate()));

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
				await this.runFullSyncWithNotice('manual');
			},
		});

		// Vault listeners are registered once the layout is ready to avoid the flood of
		// spurious "create" events Obsidian fires for the whole vault during startup.
		this.app.workspace.onLayoutReady(() => {
			this.registerVaultListeners();
			this.updateSyncStatusBar();
			void this.runFullSyncWithNotice('startup');
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
		if (this.syncStatusBarTimer !== null) {
			window.clearTimeout(this.syncStatusBarTimer);
			this.syncStatusBarTimer = null;
		}
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.orchestrator?.cancelPendingDebounces();
	}

	/**
	 * Runs a full sync and reports it the same way regardless of what triggered it — the
	 * automatic startup/periodic runs get the identical summary toast as "Sync now".
	 */
	private async runFullSyncWithNotice(trigger: 'manual' | 'startup' | 'periodic'): Promise<void> {
		if (!this.orchestrator) return;
		try {
			const summary = await this.orchestrator.runFullSync();
			if (summary.errors.length) console.error('MinIO sync: per-file errors', summary.errors);
			new Notice(
				`MinIO sync done: ${summary.pushed.length} pushed, ${summary.pulled.length} pulled, ${summary.conflicts.length} conflict(s), ${summary.errors.length} error(s)`,
			);
		} catch (err) {
			console.error(`MinIO sync: ${trigger} sync failed`, err);
			new Notice(`MinIO sync failed: ${(err as Error).message}`);
		} finally {
			this.updateSyncStatusBar();
		}
	}

	private registerVaultListeners() {
		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				if (!(file instanceof TFile)) return;
				if (this.orchestrator?.wasSelfWrite(file.path)) return;
				this.orchestrator?.scheduleDebouncedPush(file.path);
				this.requestSyncStatusBarUpdate();
			}),
		);
		this.registerEvent(
			this.app.vault.on('modify', (file: TAbstractFile) => {
				if (!(file instanceof TFile)) return;
				if (this.orchestrator?.wasSelfWrite(file.path)) return;
				this.orchestrator?.scheduleDebouncedPush(file.path);
				this.requestSyncStatusBarUpdate();
			}),
		);
		// Obsidian fires exactly one delete/rename event for a folder and none for the files
		// inside it, so folders need their own handling — otherwise deleting a folder silently
		// leaves every file in it live in the bucket, and the next full sync pulls them back.
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				if (this.orchestrator?.wasSelfWrite(file.path)) return;
				const done =
					file instanceof TFolder
						? this.orchestrator?.deleteFolder(file.path)
						: file instanceof TFile
							? this.orchestrator?.deleteSingleFile(file.path)
							: undefined;
				done
					?.catch((err) => {
						console.error(`MinIO sync: failed to delete ${file.path}`, err);
						new Notice(`MinIO sync: failed to delete ${file.path}: ${(err as Error).message}`);
					})
					.finally(() => this.updateSyncStatusBar());
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				if (this.orchestrator?.wasSelfWrite(file.path)) return;
				const done =
					file instanceof TFolder
						? this.orchestrator?.renameFolder(oldPath, file.path)
						: file instanceof TFile
							? this.orchestrator?.renameFile(oldPath, file.path)
							: undefined;
				done
					?.catch((err) => {
						console.error(`MinIO sync: failed to sync rename of ${file.path}`, err);
						new Notice(`MinIO sync: failed to sync rename of ${file.path}: ${(err as Error).message}`);
					})
					.finally(() => this.updateSyncStatusBar());
			}),
		);
	}

	/**
	 * Coalesces status-bar refreshes onto the next tick. Sync progress and vault events can
	 * fire many times a second, and each refresh reads the manifest off disk.
	 */
	private requestSyncStatusBarUpdate() {
		if (this.syncStatusBarTimer !== null) return;
		this.syncStatusBarTimer = window.setTimeout(() => {
			this.syncStatusBarTimer = null;
			this.updateSyncStatusBar();
		}, 200);
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

			this.orchestrator.onStateChange = () => this.requestSyncStatusBarUpdate();

			this.intervalId = window.setInterval(() => {
				void this.runFullSyncWithNotice('periodic');
			}, this.settings.syncIntervalMinutes * 60_000);
			this.registerInterval(this.intervalId);
		} else {
			this.orchestrator = null;
		}

		this.updateSyncStatusBar();
	}
}
