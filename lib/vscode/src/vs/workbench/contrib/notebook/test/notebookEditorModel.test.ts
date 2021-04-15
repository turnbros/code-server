/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { isEqual } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { mock } from 'vs/base/test/common/mock';
import { IFileService } from 'vs/platform/files/common/files';
import { ILabelService } from 'vs/platform/label/common/label';
import { NullLogService } from 'vs/platform/log/common/log';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { ComplexNotebookEditorModel } from 'vs/workbench/contrib/notebook/common/notebookEditorModel';
import { IMainNotebookController, INotebookService } from 'vs/workbench/contrib/notebook/common/notebookService';
import { IBackupFileService } from 'vs/workbench/services/backup/common/backup';
import { IUntitledTextEditorService } from 'vs/workbench/services/untitled/common/untitledTextEditorService';
import { IWorkingCopy, IWorkingCopyService } from 'vs/workbench/services/workingCopy/common/workingCopyService';

suite('NotebookEditorModel', function () {

	const notebokService = new class extends mock<INotebookService>() { };
	const backupService = new class extends mock<IBackupFileService>() { };
	const notificationService = new class extends mock<INotificationService>() { };
	const untitledTextEditorService = new class extends mock<IUntitledTextEditorService>() { };
	const fileService = new class extends mock<IFileService>() {
		onDidFilesChange = Event.None;
	};
	const labelService = new class extends mock<ILabelService>() {
		getUriBasenameLabel(uri: URI) { return uri.toString(); }
	};

	const notebookDataProvider = new class extends mock<IMainNotebookController>() { };

	test('working copy uri', function () {
		if (1) {
			this.skip();
		}
		const r1 = URI.parse('foo-files:///my.nb');
		const r2 = URI.parse('bar-files:///my.nb');

		const copies: IWorkingCopy[] = [];
		const workingCopyService = new class extends mock<IWorkingCopyService>() {
			registerWorkingCopy(copy: IWorkingCopy) {
				copies.push(copy);
				return Disposable.None;
			}
		};

		new ComplexNotebookEditorModel(r1, 'fff', notebookDataProvider, notebokService, workingCopyService, backupService, fileService, notificationService, new NullLogService(), untitledTextEditorService, labelService);
		new ComplexNotebookEditorModel(r2, 'fff', notebookDataProvider, notebokService, workingCopyService, backupService, fileService, notificationService, new NullLogService(), untitledTextEditorService, labelService);

		assert.strictEqual(copies.length, 2);
		assert.strictEqual(!isEqual(copies[0].resource, copies[1].resource), true);
	});
});
