/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { IQuickInputService, IQuickPickItem, QuickPickInput } from 'vs/platform/quickinput/common/quickInput';
import { CancelablePromise, createCancelablePromise } from 'vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, DisposableStore, dispose, IDisposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { ThemeIcon } from 'vs/platform/theme/common/themeService';
import { Memento } from 'vs/workbench/common/memento';
import { ICellViewModel, NOTEBOOK_HAS_MULTIPLE_KERNELS, NOTEBOOK_HAS_RUNNING_CELL, NOTEBOOK_INTERRUPTIBLE_KERNEL, NOTEBOOK_KERNEL_COUNT, getRanges } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { configureKernelIcon } from 'vs/workbench/contrib/notebook/browser/notebookIcons';
import { NotebookKernelProviderAssociation, NotebookKernelProviderAssociations, notebookKernelProviderAssociationsSettingId } from 'vs/workbench/contrib/notebook/browser/notebookKernelAssociation';
import { CellViewModel, NotebookViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/notebookViewModel';
import { cellIndexesToRanges, CellKind, ICellRange, INotebookKernel, NotebookCellExecutionState } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { NotebookProviderInfo } from 'vs/workbench/contrib/notebook/common/notebookProvider';

const NotebookEditorActiveKernelCache = 'workbench.editor.notebook.activeKernel';

export interface IKernelManagerDelegate {
	viewModel: NotebookViewModel | undefined;
	onDidChangeViewModel: Event<void>;
	getId(): string;
	getContributedNotebookProviders(resource?: URI): readonly NotebookProviderInfo[];
	getContributedNotebookProvider(viewType: string): NotebookProviderInfo | undefined;
	getNotebookKernels(viewType: string, resource: URI, token: CancellationToken): Promise<INotebookKernel[]>;
	loadKernelPreloads(extensionLocation: URI, kernel: INotebookKernel): Promise<void>;
}

export class NotebookEditorKernelManager extends Disposable {
	private _isDisposed: boolean = false;

	private _activeKernelExecuted: boolean = false;
	private _activeKernel: INotebookKernel | undefined = undefined;
	private readonly _onDidChangeKernel = this._register(new Emitter<void>());
	readonly onDidChangeKernel: Event<void> = this._onDidChangeKernel.event;
	private readonly _onDidChangeAvailableKernels = this._register(new Emitter<void>());
	readonly onDidChangeAvailableKernels: Event<void> = this._onDidChangeAvailableKernels.event;

	private _contributedKernelsComputePromise: CancelablePromise<INotebookKernel[]> | null = null;
	private _initialKernelComputationDone: boolean = false;

	private readonly _notebookHasMultipleKernels: IContextKey<boolean>;
	private readonly _notebookKernelCount: IContextKey<number>;
	private readonly _interruptibleKernel: IContextKey<boolean>;
	private readonly _someCellRunning: IContextKey<boolean>;

	private _cellStateListeners: IDisposable[] = [];
	private _executionCount = 0;
	private _viewModelDisposables: DisposableStore;

	get activeKernel() {
		return this._activeKernel;
	}

	set activeKernel(kernel: INotebookKernel | undefined) {
		if (this._isDisposed) {
			return;
		}

		if (!this._delegate.viewModel) {
			return;
		}

		if (this._activeKernel === kernel) {
			return;
		}

		this._interruptibleKernel.set(!!kernel?.implementsInterrupt);

		this._activeKernel = kernel;
		this._activeKernelResolvePromise = undefined;

		const memento = this._activeKernelMemento.getMemento(StorageScope.GLOBAL, StorageTarget.MACHINE);
		memento[this._delegate.viewModel.viewType] = this._activeKernel?.friendlyId;
		this._activeKernelMemento.saveMemento();
		this._onDidChangeKernel.fire();
		if (this._activeKernel) {
			this._delegate.loadKernelPreloads(this._activeKernel.extensionLocation, this._activeKernel);
		}
	}

	private _activeKernelResolvePromise: Promise<void> | undefined = undefined;

	private _multipleKernelsAvailable: boolean = false;

	get multipleKernelsAvailable() {
		return this._multipleKernelsAvailable;
	}

	set multipleKernelsAvailable(state: boolean) {
		this._multipleKernelsAvailable = state;
		this._onDidChangeAvailableKernels.fire();
	}

	private readonly _activeKernelMemento: Memento;

	constructor(
		private readonly _delegate: IKernelManagerDelegate,
		@IStorageService storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,) {
		super();

		this._activeKernelMemento = new Memento(NotebookEditorActiveKernelCache, storageService);

		this._notebookHasMultipleKernels = NOTEBOOK_HAS_MULTIPLE_KERNELS.bindTo(contextKeyService);
		this._notebookKernelCount = NOTEBOOK_KERNEL_COUNT.bindTo(contextKeyService);
		this._interruptibleKernel = NOTEBOOK_INTERRUPTIBLE_KERNEL.bindTo(contextKeyService);
		this._someCellRunning = NOTEBOOK_HAS_RUNNING_CELL.bindTo(contextKeyService);

		this._viewModelDisposables = this._register(new DisposableStore());
		this._register(this._delegate.onDidChangeViewModel(() => {
			this._viewModelDisposables.clear();
			this.initCellListeners();
		}));
	}

	private initCellListeners(): void {
		dispose(this._cellStateListeners);
		this._cellStateListeners = [];

		if (!this._delegate.viewModel) {
			return;
		}

		const addCellStateListener = (c: ICellViewModel) => {
			return (c as CellViewModel).onDidChangeState(e => {
				if (!e.runStateChanged) {
					return;
				}

				if (c.metadata?.runState === NotebookCellExecutionState.Pending) {
					this._executionCount++;
				} else if (c.metadata?.runState === NotebookCellExecutionState.Idle) {
					this._executionCount--;
				}

				this._someCellRunning.set(this._executionCount > 0);
			});
		};

		this._cellStateListeners = this._delegate.viewModel.viewCells.map(addCellStateListener);

		this._viewModelDisposables.add(this._delegate.viewModel.onDidChangeViewCells(e => {
			e.splices.reverse().forEach(splice => {
				const [start, deleted, newCells] = splice;
				const deletedCells = this._cellStateListeners.splice(start, deleted, ...newCells.map(addCellStateListener));
				dispose(deletedCells);
			});
		}));
	}

	public async setKernels(tokenSource: CancellationTokenSource) {
		if (!this._delegate.viewModel) {
			return;
		}

		if (this._activeKernel !== undefined && this._activeKernelExecuted) {
			// kernel already executed, we should not change it automatically
			return;
		}

		const provider = this._delegate.getContributedNotebookProvider(this._delegate.viewModel.viewType) || this._delegate.getContributedNotebookProviders(this._delegate.viewModel.uri)[0];
		const availableKernels = await this.beginComputeContributedKernels();

		if (tokenSource.token.isCancellationRequested) {
			return;
		}

		this._notebookKernelCount.set(availableKernels.length);
		if (availableKernels.length > 1) {
			this._notebookHasMultipleKernels.set(true);
			this.multipleKernelsAvailable = true;
		} else {
			this._notebookHasMultipleKernels.set(false);
			this.multipleKernelsAvailable = false;
		}

		const activeKernelStillExist = [...availableKernels].find(kernel => kernel.friendlyId === this.activeKernel?.friendlyId && this.activeKernel?.friendlyId !== undefined);

		if (activeKernelStillExist) {
			// the kernel still exist, we don't want to modify the selection otherwise user's temporary preference is lost
			return;
		}

		if (availableKernels.length) {
			return this._setKernelsFromProviders(provider, availableKernels, tokenSource);
		}

		this._initialKernelComputationDone = true;

		tokenSource.dispose();
	}

	async beginComputeContributedKernels() {
		if (this._contributedKernelsComputePromise) {
			return this._contributedKernelsComputePromise;
		}

		this._contributedKernelsComputePromise = createCancelablePromise(token => {
			return this._delegate.getNotebookKernels(this._delegate.viewModel!.viewType, this._delegate.viewModel!.uri, token);
		});

		const result = await this._contributedKernelsComputePromise;
		this._initialKernelComputationDone = true;
		this._contributedKernelsComputePromise = null;

		return result;
	}

	private async _setKernelsFromProviders(provider: NotebookProviderInfo, kernels: INotebookKernel[], tokenSource: CancellationTokenSource) {
		const rawAssociations = this._configurationService.getValue<NotebookKernelProviderAssociations>(notebookKernelProviderAssociationsSettingId) || [];
		const userSetKernelProvider = rawAssociations.filter(e => e.viewType === this._delegate.viewModel?.viewType)[0]?.kernelProvider;
		const memento = this._activeKernelMemento.getMemento(StorageScope.GLOBAL, StorageTarget.MACHINE);

		if (userSetKernelProvider) {
			const filteredKernels = kernels.filter(kernel => kernel.extension.value === userSetKernelProvider);

			if (filteredKernels.length) {
				const cachedKernelId = memento[provider.id];
				this.activeKernel =
					filteredKernels.find(kernel => kernel.isPreferred)
					|| filteredKernels.find(kernel => kernel.friendlyId === cachedKernelId)
					|| filteredKernels[0];
			} else {
				this.activeKernel = undefined;
			}

			if (this.activeKernel) {
				await this._delegate.loadKernelPreloads(this.activeKernel.extensionLocation, this.activeKernel);

				if (tokenSource.token.isCancellationRequested) {
					return;
				}

				this._activeKernelResolvePromise = this.activeKernel.resolve(this._delegate.viewModel!.uri, this._delegate.getId(), tokenSource.token);
				await this._activeKernelResolvePromise;

				if (tokenSource.token.isCancellationRequested) {
					return;
				}
			}

			memento[provider.id] = this._activeKernel?.friendlyId;
			this._activeKernelMemento.saveMemento();

			tokenSource.dispose();
			return;
		}

		// choose a preferred kernel
		const kernelsFromSameExtension = kernels.filter(kernel => kernel.extension.value === provider.providerExtensionId);
		if (kernelsFromSameExtension.length) {
			const cachedKernelId = memento[provider.id];

			const preferedKernel = kernelsFromSameExtension.find(kernel => kernel.isPreferred)
				|| kernelsFromSameExtension.find(kernel => kernel.friendlyId === cachedKernelId)
				|| kernelsFromSameExtension[0];
			this.activeKernel = preferedKernel;
			if (this.activeKernel) {
				await this._delegate.loadKernelPreloads(this.activeKernel.extensionLocation, this.activeKernel);
			}

			if (tokenSource.token.isCancellationRequested) {
				return;
			}

			await preferedKernel.resolve(this._delegate.viewModel!.uri, this._delegate.getId(), tokenSource.token);

			if (tokenSource.token.isCancellationRequested) {
				return;
			}

			memento[provider.id] = this._activeKernel?.friendlyId;
			this._activeKernelMemento.saveMemento();
			tokenSource.dispose();
			return;
		}

		// the provider doesn't have a builtin kernel, choose a kernel
		this.activeKernel = kernels[0];
		if (this.activeKernel) {
			await this._delegate.loadKernelPreloads(this.activeKernel.extensionLocation, this.activeKernel);
			if (tokenSource.token.isCancellationRequested) {
				return;
			}

			await this.activeKernel.resolve(this._delegate.viewModel!.uri, this._delegate.getId(), tokenSource.token);
			if (tokenSource.token.isCancellationRequested) {
				return;
			}
		}

		tokenSource.dispose();
	}

	private async _ensureActiveKernel() {
		if (this._activeKernel) {
			return;
		}

		if (this._activeKernelResolvePromise) {
			await this._activeKernelResolvePromise;

			if (this._activeKernel) {
				return;
			}
		}


		if (!this._initialKernelComputationDone) {
			await this.setKernels(new CancellationTokenSource());

			if (this._activeKernel) {
				return;
			}
		}

		// pick active kernel

		const picker = this._quickInputService.createQuickPick<(IQuickPickItem & { run(): void; kernelProviderId?: string })>();
		picker.placeholder = nls.localize('notebook.runCell.selectKernel', "Select a notebook kernel to run this notebook");
		picker.matchOnDetail = true;

		const tokenSource = new CancellationTokenSource();
		const availableKernels = await this.beginComputeContributedKernels();
		const picks: QuickPickInput<IQuickPickItem & { run(): void; kernelProviderId?: string; }>[] = availableKernels.map((a) => {
			return {
				id: a.friendlyId,
				label: a.label,
				picked: false,
				description:
					a.description
						? a.description
						: a.extension.value,
				detail: a.detail,
				kernelProviderId: a.extension.value,
				run: async () => {
					this.activeKernel = a;
					this._activeKernelResolvePromise = this.activeKernel.resolve(this._delegate.viewModel!.uri, this._delegate.getId(), tokenSource.token);
				},
				buttons: [{
					iconClass: ThemeIcon.asClassName(configureKernelIcon),
					tooltip: nls.localize('notebook.promptKernel.setDefaultTooltip', "Set as default kernel provider for '{0}'", this._delegate.viewModel!.viewType)
				}]
			};
		});

		picker.items = picks;
		picker.busy = false;

		const pickedItem = await new Promise<(IQuickPickItem & { run(): void; kernelProviderId?: string; }) | undefined>(resolve => {
			picker.onDidAccept(() => {
				resolve(picker.selectedItems.length === 1 ? picker.selectedItems[0] : undefined);
				picker.dispose();
			});

			picker.onDidTriggerItemButton(e => {
				const pick = e.item;
				const id = pick.id;
				resolve(pick); // open the view
				picker.dispose();

				// And persist the setting
				if (pick && id && pick.kernelProviderId) {
					const newAssociation: NotebookKernelProviderAssociation = { viewType: this._delegate.viewModel!.viewType, kernelProvider: pick.kernelProviderId };
					const currentAssociations = [...this._configurationService.getValue<NotebookKernelProviderAssociations>(notebookKernelProviderAssociationsSettingId)];

					// First try updating existing association
					for (let i = 0; i < currentAssociations.length; ++i) {
						const existing = currentAssociations[i];
						if (existing.viewType === newAssociation.viewType) {
							currentAssociations.splice(i, 1, newAssociation);
							this._configurationService.updateValue(notebookKernelProviderAssociationsSettingId, currentAssociations);
							return;
						}
					}

					// Otherwise, create a new one
					currentAssociations.unshift(newAssociation);
					this._configurationService.updateValue(notebookKernelProviderAssociationsSettingId, currentAssociations);
				}
			});

		});

		tokenSource.dispose();

		if (pickedItem) {
			await pickedItem.run();
		}

		return;
	}

	async cancelNotebookExecution(): Promise<void> {
		if (!this._delegate.viewModel) {
			return;
		}

		await this._ensureActiveKernel();

		const fullRange: ICellRange = {
			start: 0, end: this._delegate.viewModel.length
		};
		await this._activeKernel?.cancelNotebookCellExecution!(this._delegate.viewModel.uri, [fullRange]);
	}

	async executeNotebook(): Promise<void> {
		if (!this._delegate.viewModel) {
			return;
		}

		await this._ensureActiveKernel();
		if (!this.canExecuteNotebook()) {
			return;
		}

		const codeCellRanges = getRanges(this._delegate.viewModel.viewCells, cell => cell.cellKind === CellKind.Code);
		if (codeCellRanges.length) {
			this._activeKernelExecuted = true;
			await this._activeKernel?.executeNotebookCellsRequest(this._delegate.viewModel.uri, codeCellRanges);
		}
	}

	async cancelNotebookCellExecution(cell: ICellViewModel): Promise<void> {
		if (!this._delegate.viewModel) {
			return;
		}

		if (cell.cellKind !== CellKind.Code) {
			return;
		}

		const metadata = cell.getEvaluatedMetadata(this._delegate.viewModel.metadata);
		if (metadata.runState === NotebookCellExecutionState.Idle) {
			return;
		}

		await this._ensureActiveKernel();

		const idx = this._delegate.viewModel.getCellIndex(cell);
		const ranges = cellIndexesToRanges([idx]);
		await this._activeKernel?.cancelNotebookCellExecution!(this._delegate.viewModel.uri, ranges);
	}

	async executeNotebookCell(cell: ICellViewModel): Promise<void> {
		if (!this._delegate.viewModel) {
			return;
		}

		await this._ensureActiveKernel();
		if (!this.canExecuteCell(cell)) {
			throw new Error('Cell is not executable: ' + cell.uri);
		}

		if (!this.activeKernel) {
			return;
		}

		const idx = this._delegate.viewModel.getCellIndex(cell);
		const range = cellIndexesToRanges([idx]);
		this._activeKernelExecuted = true;
		await this._activeKernel!.executeNotebookCellsRequest(this._delegate.viewModel.uri, range);
	}

	private canExecuteNotebook(): boolean {
		if (!this.activeKernel) {
			return false;
		}

		if (!this._delegate.viewModel?.trusted) {
			return false;
		}

		return true;
	}

	private canExecuteCell(cell: ICellViewModel): boolean {
		if (!this.activeKernel) {
			return false;
		}

		if (cell.cellKind !== CellKind.Code) {
			return false;
		}

		if (!this.activeKernel.supportedLanguages) {
			return true;
		}

		if (this.activeKernel.supportedLanguages.includes(cell.language)) {
			return true;
		}

		return false;
	}
}
