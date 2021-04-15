/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from 'vs/base/common/event';
import { withNullAsUndefined } from 'vs/base/common/types';
import { URI, UriComponents } from 'vs/base/common/uri';
import { IChannel } from 'vs/base/parts/ipc/common/ipc';
import { IWorkbenchConfigurationService } from 'vs/workbench/services/configuration/common/configuration';
import { ILogService } from 'vs/platform/log/common/log';
import { IRemoteAuthorityResolverService } from 'vs/platform/remote/common/remoteAuthorityResolver';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { serializeEnvironmentVariableCollection } from 'vs/workbench/contrib/terminal/common/environmentVariableShared';
import { IConfigurationResolverService } from 'vs/workbench/services/configurationResolver/common/configurationResolver';
import { SideBySideEditor, EditorResourceAccessor } from 'vs/workbench/common/editor';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { Schemas } from 'vs/base/common/network';
import { ILabelService } from 'vs/platform/label/common/label';
import { IEnvironmentVariableService, ISerializableEnvironmentVariableCollection } from 'vs/workbench/contrib/terminal/common/environmentVariable';
import { IProcessDataEvent, IShellLaunchConfig, ITerminalDimensionsOverride, ITerminalEnvironment, ITerminalLaunchError, ITerminalsLayoutInfo, ITerminalsLayoutInfoById, TerminalShellType } from 'vs/platform/terminal/common/terminal';
import { ITerminalConfiguration, TERMINAL_CONFIG_SECTION } from 'vs/workbench/contrib/terminal/common/terminal';
import { IGetTerminalLayoutInfoArgs, IProcessDetails, IPtyHostProcessReplayEvent, ISetTerminalLayoutInfoArgs } from 'vs/platform/terminal/common/terminalProcess';

export const REMOTE_TERMINAL_CHANNEL_NAME = 'remoteterminal';

export interface IShellLaunchConfigDto {
	name?: string;
	executable?: string;
	args?: string[] | string;
	cwd?: string | UriComponents;
	env?: { [key: string]: string | null; };
	hideFromUser?: boolean;
}

export interface ISingleTerminalConfiguration<T> {
	userValue: T | undefined;
	value: T | undefined;
	defaultValue: T | undefined;
}

export interface ICompleteTerminalConfiguration {
	'terminal.integrated.automationShell.windows': ISingleTerminalConfiguration<string | string[]>;
	'terminal.integrated.automationShell.osx': ISingleTerminalConfiguration<string | string[]>;
	'terminal.integrated.automationShell.linux': ISingleTerminalConfiguration<string | string[]>;
	'terminal.integrated.shell.windows': ISingleTerminalConfiguration<string | string[]>;
	'terminal.integrated.shell.osx': ISingleTerminalConfiguration<string | string[]>;
	'terminal.integrated.shell.linux': ISingleTerminalConfiguration<string | string[]>;
	'terminal.integrated.shellArgs.windows': ISingleTerminalConfiguration<string | string[]>;
	'terminal.integrated.shellArgs.osx': ISingleTerminalConfiguration<string | string[]>;
	'terminal.integrated.shellArgs.linux': ISingleTerminalConfiguration<string | string[]>;
	'terminal.integrated.env.windows': ISingleTerminalConfiguration<ITerminalEnvironment>;
	'terminal.integrated.env.osx': ISingleTerminalConfiguration<ITerminalEnvironment>;
	'terminal.integrated.env.linux': ISingleTerminalConfiguration<ITerminalEnvironment>;
	'terminal.integrated.inheritEnv': boolean;
	'terminal.integrated.cwd': string;
	'terminal.integrated.detectLocale': 'auto' | 'off' | 'on';
}

export type ITerminalEnvironmentVariableCollections = [string, ISerializableEnvironmentVariableCollection][];

export interface IWorkspaceFolderData {
	uri: UriComponents;
	name: string;
	index: number;
}

export interface ICreateTerminalProcessArguments {
	configuration: ICompleteTerminalConfiguration;
	resolvedVariables: { [name: string]: string; };
	envVariableCollections: ITerminalEnvironmentVariableCollections;
	shellLaunchConfig: IShellLaunchConfigDto;
	workspaceId: string;
	workspaceName: string;
	workspaceFolders: IWorkspaceFolderData[];
	activeWorkspaceFolder: IWorkspaceFolderData | null;
	activeFileResource: UriComponents | undefined;
	shouldPersistTerminal: boolean;
	cols: number;
	rows: number;
	isWorkspaceShellAllowed: boolean;
	resolverEnv: { [key: string]: string | null; } | undefined
}

export interface ICreateTerminalProcessResult {
	persistentTerminalId: number;
	resolvedShellLaunchConfig: IShellLaunchConfigDto;
}

export class RemoteTerminalChannelClient {

	public get onPtyHostExit(): Event<void> {
		return this._channel.listen<void>('$onPtyHostExitEvent');
	}
	public get onPtyHostStart(): Event<void> {
		return this._channel.listen<void>('$onPtyHostStartEvent');
	}
	public get onPtyHostUnresponsive(): Event<void> {
		return this._channel.listen<void>('$onPtyHostUnresponsiveEvent');
	}
	public get onPtyHostResponsive(): Event<void> {
		return this._channel.listen<void>('$onPtyHostResponsiveEvent');
	}
	public get onProcessData(): Event<{ id: number, event: IProcessDataEvent | string }> {
		return this._channel.listen<{ id: number, event: IProcessDataEvent | string }>('$onProcessDataEvent');
	}
	public get onProcessExit(): Event<{ id: number, event: number | undefined }> {
		return this._channel.listen<{ id: number, event: number | undefined }>('$onProcessExitEvent');
	}
	public get onProcessReady(): Event<{ id: number, event: { pid: number, cwd: string } }> {
		return this._channel.listen<{ id: number, event: { pid: number, cwd: string } }>('$onProcessReadyEvent');
	}
	public get onProcessReplay(): Event<{ id: number, event: IPtyHostProcessReplayEvent }> {
		return this._channel.listen<{ id: number, event: IPtyHostProcessReplayEvent }>('$onProcessReplayEvent');
	}
	public get onProcessTitleChanged(): Event<{ id: number, event: string }> {
		return this._channel.listen<{ id: number, event: string }>('$onProcessTitleChangedEvent');
	}
	public get onProcessShellTypeChanged(): Event<{ id: number, event: TerminalShellType | undefined }> {
		return this._channel.listen<{ id: number, event: TerminalShellType | undefined }>('$onProcessShellTypeChangedEvent');
	}
	public get onProcessOverrideDimensions(): Event<{ id: number, event: ITerminalDimensionsOverride | undefined }> {
		return this._channel.listen<{ id: number, event: ITerminalDimensionsOverride | undefined }>('$onProcessOverrideDimensionsEvent');
	}
	public get onProcessResolvedShellLaunchConfig(): Event<{ id: number, event: IShellLaunchConfig }> {
		return this._channel.listen<{ id: number, event: IShellLaunchConfig }>('$onProcessResolvedShellLaunchConfigEvent');
	}
	public get onProcessOrphanQuestion(): Event<{ id: number }> {
		return this._channel.listen<{ id: number }>('$onProcessOrphanQuestion');
	}
	public get onExecuteCommand(): Event<{ reqId: number, commandId: string, commandArgs: any[] }> {
		return this._channel.listen<{ reqId: number, commandId: string, commandArgs: any[] }>('$onExecuteCommand');
	}

	constructor(
		private readonly _remoteAuthority: string,
		private readonly _channel: IChannel,
		@IWorkbenchConfigurationService private readonly _configurationService: IWorkbenchConfigurationService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationResolverService private readonly _resolverService: IConfigurationResolverService,
		@IEnvironmentVariableService private readonly _environmentVariableService: IEnvironmentVariableService,
		@IRemoteAuthorityResolverService private readonly _remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@ILogService private readonly _logService: ILogService,
		@IEditorService private readonly _editorService: IEditorService,
		@ILabelService private readonly _labelService: ILabelService,
	) { }

	private _readSingleTerminalConfiguration<T>(key: string): ISingleTerminalConfiguration<T> {
		const result = this._configurationService.inspect<T>(key);
		return {
			userValue: result.userValue,
			value: result.value,
			defaultValue: result.defaultValue,
		};
	}

	restartPtyHost(): Promise<void> {
		return this._channel.call('$restartPtyHost', []);
	}

	public async createProcess(shellLaunchConfig: IShellLaunchConfigDto, activeWorkspaceRootUri: URI | undefined, shouldPersistTerminal: boolean, cols: number, rows: number, isWorkspaceShellAllowed: boolean): Promise<ICreateTerminalProcessResult> {
		// Be sure to first wait for the remote configuration
		await this._configurationService.whenRemoteConfigurationLoaded();

		const terminalConfig = this._configurationService.getValue<ITerminalConfiguration>(TERMINAL_CONFIG_SECTION);
		const configuration: ICompleteTerminalConfiguration = {
			'terminal.integrated.automationShell.windows': this._readSingleTerminalConfiguration('terminal.integrated.automationShell.windows'),
			'terminal.integrated.automationShell.osx': this._readSingleTerminalConfiguration('terminal.integrated.automationShell.osx'),
			'terminal.integrated.automationShell.linux': this._readSingleTerminalConfiguration('terminal.integrated.automationShell.linux'),
			'terminal.integrated.shell.windows': this._readSingleTerminalConfiguration('terminal.integrated.shell.windows'),
			'terminal.integrated.shell.osx': this._readSingleTerminalConfiguration('terminal.integrated.shell.osx'),
			'terminal.integrated.shell.linux': this._readSingleTerminalConfiguration('terminal.integrated.shell.linux'),
			'terminal.integrated.shellArgs.windows': this._readSingleTerminalConfiguration('terminal.integrated.shellArgs.windows'),
			'terminal.integrated.shellArgs.osx': this._readSingleTerminalConfiguration('terminal.integrated.shellArgs.osx'),
			'terminal.integrated.shellArgs.linux': this._readSingleTerminalConfiguration('terminal.integrated.shellArgs.linux'),
			'terminal.integrated.env.windows': this._readSingleTerminalConfiguration('terminal.integrated.env.windows'),
			'terminal.integrated.env.osx': this._readSingleTerminalConfiguration('terminal.integrated.env.osx'),
			'terminal.integrated.env.linux': this._readSingleTerminalConfiguration('terminal.integrated.env.linux'),
			'terminal.integrated.inheritEnv': terminalConfig.inheritEnv,
			'terminal.integrated.cwd': terminalConfig.cwd,
			'terminal.integrated.detectLocale': terminalConfig.detectLocale
		};

		// We will use the resolver service to resolve all the variables in the config / launch config
		// But then we will keep only some variables, since the rest need to be resolved on the remote side
		const resolvedVariables = Object.create(null);
		const lastActiveWorkspace = activeWorkspaceRootUri ? withNullAsUndefined(this._workspaceContextService.getWorkspaceFolder(activeWorkspaceRootUri)) : undefined;
		let allResolvedVariables: Map<string, string> | undefined = undefined;
		try {
			allResolvedVariables = await this._resolverService.resolveWithInteraction(lastActiveWorkspace, {
				shellLaunchConfig,
				configuration
			});
		} catch (err) {
			this._logService.error(err);
		}
		if (allResolvedVariables) {
			for (const [name, value] of allResolvedVariables.entries()) {
				if (/^config:/.test(name) || name === 'selectedText' || name === 'lineNumber') {
					resolvedVariables[name] = value;
				}
			}
		}

		const envVariableCollections: ITerminalEnvironmentVariableCollections = [];
		for (const [k, v] of this._environmentVariableService.collections.entries()) {
			envVariableCollections.push([k, serializeEnvironmentVariableCollection(v.map)]);
		}

		const resolverResult = await this._remoteAuthorityResolverService.resolveAuthority(this._remoteAuthority);
		const resolverEnv = resolverResult.options && resolverResult.options.extensionHostEnv;

		const workspace = this._workspaceContextService.getWorkspace();
		const workspaceFolders = workspace.folders;
		const activeWorkspaceFolder = activeWorkspaceRootUri ? this._workspaceContextService.getWorkspaceFolder(activeWorkspaceRootUri) : null;

		const activeFileResource = EditorResourceAccessor.getOriginalUri(this._editorService.activeEditor, {
			supportSideBySide: SideBySideEditor.PRIMARY,
			filterByScheme: [Schemas.file, Schemas.userData, Schemas.vscodeRemote]
		});

		const args: ICreateTerminalProcessArguments = {
			configuration,
			resolvedVariables,
			envVariableCollections,
			shellLaunchConfig,
			workspaceId: workspace.id,
			workspaceName: this._labelService.getWorkspaceLabel(workspace),
			workspaceFolders,
			activeWorkspaceFolder,
			activeFileResource,
			shouldPersistTerminal,
			cols,
			rows,
			isWorkspaceShellAllowed,
			resolverEnv
		};
		return await this._channel.call<ICreateTerminalProcessResult>('$createProcess', args);
	}

	public attachToProcess(id: number): Promise<void> {
		return this._channel.call('$attachToProcess', [id]);
	}

	public listProcesses(reduceGraceTime: boolean): Promise<IProcessDetails[]> {
		return this._channel.call('$listProcesses', [reduceGraceTime]);
	}

	public start(id: number): Promise<ITerminalLaunchError | void> {
		return this._channel.call('$start', [id]);
	}
	public input(id: number, data: string): Promise<void> {
		return this._channel.call('$input', [id, data]);
	}
	public acknowledgeDataEvent(id: number, charCount: number): Promise<void> {
		return this._channel.call('$acknowledgeDataEvent', [id, charCount]);
	}
	public shutdown(id: number, immediate: boolean): Promise<void> {
		return this._channel.call('$shutdown', [id, immediate]);
	}
	public resize(id: number, cols: number, rows: number): Promise<void> {
		return this._channel.call('$resize', [id, cols, rows]);
	}
	public getInitialCwd(id: number): Promise<string> {
		return this._channel.call('$getInitialCwd', [id]);
	}
	public getCwd(id: number): Promise<string> {
		return this._channel.call('$getCwd', [id]);
	}
	public orphanQuestionReply(id: number): Promise<void> {
		return this._channel.call('$orphanQuestionReply', [id]);
	}

	public sendCommandResult(reqId: number, isError: boolean, payload: any): Promise<void> {
		return this._channel.call<void>('$sendCommandResult', [reqId, isError, payload]);
	}

	public setTerminalLayoutInfo(layout: ITerminalsLayoutInfoById): Promise<void> {
		const workspace = this._workspaceContextService.getWorkspace();
		const args: ISetTerminalLayoutInfoArgs = {
			workspaceId: workspace.id,
			tabs: layout.tabs
		};
		return this._channel.call<void>('$setTerminalLayoutInfo', args);
	}

	public getTerminalLayoutInfo(): Promise<ITerminalsLayoutInfo | undefined> {
		const workspace = this._workspaceContextService.getWorkspace();
		const args: IGetTerminalLayoutInfoArgs = {
			workspaceId: workspace.id,
		};
		return this._channel.call<ITerminalsLayoutInfo>('$getTerminalLayoutInfo', args);
	}
}
