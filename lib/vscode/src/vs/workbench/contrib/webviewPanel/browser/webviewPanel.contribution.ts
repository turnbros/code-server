/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { registerAction2 } from 'vs/platform/actions/common/actions';
import { EditorOverride, ITextEditorOptions } from 'vs/platform/editor/common/editor';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { Registry } from 'vs/platform/registry/common/platform';
import { EditorDescriptor, Extensions as EditorExtensions, IEditorRegistry } from 'vs/workbench/browser/editor';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from 'vs/workbench/common/contributions';
import { Extensions as EditorInputExtensions, IEditorInput, IEditorInputFactoryRegistry } from 'vs/workbench/common/editor';
import { IEditorGroup, IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { IEditorService, IOpenEditorOverride } from 'vs/workbench/services/editor/common/editorService';
import { LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { HideWebViewEditorFindCommand, ReloadWebviewAction, ShowWebViewEditorFindWidgetAction, WebViewEditorFindNextCommand, WebViewEditorFindPreviousCommand } from './webviewCommands';
import { WebviewEditor } from './webviewEditor';
import { WebviewInput } from './webviewEditorInput';
import { WebviewEditorInputFactory } from './webviewEditorInputFactory';
import { IWebviewWorkbenchService, WebviewEditorService } from './webviewWorkbenchService';

(Registry.as<IEditorRegistry>(EditorExtensions.Editors)).registerEditor(EditorDescriptor.create(
	WebviewEditor,
	WebviewEditor.ID,
	localize('webview.editor.label', "webview editor")),
	[new SyncDescriptor(WebviewInput)]);

class WebviewPanelContribution implements IWorkbenchContribution {
	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupService: IEditorGroupsService,
	) {
		this.editorService.overrideOpenEditor({
			open: (editor, options, group) => this.onEditorOpening(editor, options, group)
		});
	}

	private onEditorOpening(
		editor: IEditorInput,
		options: ITextEditorOptions | undefined,
		group: IEditorGroup
	): IOpenEditorOverride | undefined {
		if (!(editor instanceof WebviewInput) || editor.getTypeId() !== WebviewInput.typeId) {
			return undefined;
		}

		if (group.isOpened(editor)) {
			return undefined;
		}

		let previousGroup: IEditorGroup | undefined;
		const groups = this.editorGroupService.groups;
		for (const group of groups) {
			if (group.isOpened(editor)) {
				previousGroup = group;
				break;
			}
		}

		if (!previousGroup) {
			return undefined;
		}

		previousGroup.closeEditor(editor);

		return {
			override: this.editorService.openEditor(editor, { ...options, override: EditorOverride.DISABLED }, group)
		};
	}
}

const workbenchContributionsRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchContributionsRegistry.registerWorkbenchContribution(WebviewPanelContribution, LifecyclePhase.Starting);

Registry.as<IEditorInputFactoryRegistry>(EditorInputExtensions.EditorInputFactories).registerEditorInputFactory(
	WebviewEditorInputFactory.ID,
	WebviewEditorInputFactory);

registerSingleton(IWebviewWorkbenchService, WebviewEditorService, true);


registerAction2(ShowWebViewEditorFindWidgetAction);
registerAction2(HideWebViewEditorFindCommand);
registerAction2(WebViewEditorFindNextCommand);
registerAction2(WebViewEditorFindPreviousCommand);
registerAction2(ReloadWebviewAction);
