/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { Gesture } from 'vs/base/browser/touch';
import { Codicon } from 'vs/base/common/codicons';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { ThemeIcon } from 'vs/base/common/themables';
import { withNullAsUndefined } from 'vs/base/common/types';
import 'vs/css!./aiButtonsWidget';
import { ContentWidgetPositionPreference, ICodeEditor, IContentWidget, IContentWidgetPosition } from 'vs/editor/browser/editorBrowser';
import { EditorOption } from 'vs/editor/common/config/editorOptions';
import { IPosition } from 'vs/editor/common/core/position';
import { StringBuilder } from 'vs/editor/common/core/stringBuilder';
import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { computeIndentLevel } from 'vs/editor/common/model/utils';
import { aiChatCommandId, aiEditCommandId, autoFixCommandId, quickFixCommandId } from 'vs/editor/contrib/codeAction/browser/codeAction';
import { AiChatAction } from 'vs/editor/contrib/codeAction/browser/codeActionCommands';
import type { CodeActionSet, CodeActionTrigger } from 'vs/editor/contrib/codeAction/common/types';
import * as nls from 'vs/nls';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';

const _ttPolicy = window.trustedTypes?.createPolicy('aiButtonsWidget', { createHTML: value => value });

namespace aiButtonsState {

	export const enum Type {
		Hidden,
		Showing,
	}

	export const Hidden = { type: Type.Hidden } as const;

	export class Showing {
		readonly type = Type.Showing;

		// this is where the modal data is kept
		constructor(
			public readonly actions: CodeActionSet,
			public readonly trigger: CodeActionTrigger,
			public readonly editorPosition: IPosition,
			public readonly widgetPosition: IContentWidgetPosition,
		) { }
	}

	export type State = typeof Hidden | Showing;
}

export class AiButtonsWidget extends Disposable implements IEditorContribution, IContentWidget {

	public static readonly ID = 'editor.contrib.aiButtonsWidget';

	private static readonly _posPref = [ContentWidgetPositionPreference.EXACT];

	private readonly _domNode: HTMLElement;

	private readonly _onClick = this._register(new Emitter<{ x: number; y: number; actions: CodeActionSet; trigger: CodeActionTrigger }>());
	public readonly onClick = this._onClick.event;

	private _state: aiButtonsState.State = aiButtonsState.Hidden;

	private _chatKbLabel?: string;
	private _editKbLabel?: string;

	constructor(
		private readonly _editor: ICodeEditor,
		@IKeybindingService keybindingService: IKeybindingService
	) {
		super();

		this._domNode = dom.$('div.aiButtonsWidget');

		this._register(Gesture.ignoreTarget(this._domNode));

		this._editor.addContentWidget(this);

		this._register(this._editor.onDidChangeModelContent(_ => {
			// cancel when the line in question has been removed
			const editorModel = this._editor.getModel();
			if (this.state.type !== aiButtonsState.Type.Showing || !editorModel || this.state.editorPosition.lineNumber >= editorModel.getLineCount()) {
				this.hide();
			}
		}));

		this._register(dom.addStandardDisposableGenericMouseDownListener(this._domNode, e => {
			if (this.state.type !== aiButtonsState.Type.Showing) {
				return;
			}

			// Make sure that focus / cursor location is not lost when clicking widget icon
			this._editor.focus();
			e.preventDefault();
			// a bit of extra work to make sure the menu
			// doesn't cover the line-text
			const { top, height } = dom.getDomNodePagePosition(this._domNode);
			const lineHeight = this._editor.getOption(EditorOption.lineHeight);

			let pad = Math.floor(lineHeight / 3);
			if (this.state.widgetPosition.position !== null && this.state.widgetPosition.position.lineNumber < this.state.editorPosition.lineNumber) {
				pad += lineHeight;
			}

			this._onClick.fire({
				x: e.posx,
				y: top + height + pad,
				actions: this.state.actions,
				trigger: this.state.trigger,
			});
		}));

		this._register(dom.addDisposableListener(this._domNode, 'mouseenter', (e: MouseEvent) => {
			if ((e.buttons & 1) !== 1) {
				return;
			}
			// mouse enters lightbulb while the primary/left button
			// is being pressed -> hide the lightbulb
			this.hide();
		}));

		this._register(this._editor.onDidChangeConfiguration(e => {
			// hide when told to do so
			if (e.hasChanged(EditorOption.lightbulb) && !this._editor.getOption(EditorOption.lightbulb).enabled) {
				this.hide();
			}
		}));

		this._register(Event.runAndSubscribe(keybindingService.onDidUpdateKeybindings, () => {
			this._chatKbLabel = withNullAsUndefined(keybindingService.lookupKeybinding(aiChatCommandId)?.getLabel());
			this._editKbLabel = withNullAsUndefined(keybindingService.lookupKeybinding(aiEditCommandId)?.getLabel());

			this._renderButtons();
		}));
	}

	override dispose(): void {
		super.dispose();
		this._editor.removeContentWidget(this);
	}

	getId(): string {
		return 'aiButtonsWidget';
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IContentWidgetPosition | null {
		return this._state.type === aiButtonsState.Type.Showing ? this._state.widgetPosition : null;
	}

	public update(actions: CodeActionSet, trigger: CodeActionTrigger, atPosition: IPosition) {
		if (actions.validActions.length <= 0) {
			return this.hide();
		}

		const options = this._editor.getOptions();
		if (!options.get(EditorOption.lightbulb).enabled) {
			return this.hide();
		}

		const model = this._editor.getModel();
		if (!model) {
			return this.hide();
		}

		const { lineNumber, column } = model.validatePosition(atPosition);

		// CONTROLS WHERE THE MODAL IS RENDERED
		const tabSize = model.getOptions().tabSize;
		const fontInfo = options.get(EditorOption.fontInfo);
		const lineContent = model.getLineContent(lineNumber);
		const indent = computeIndentLevel(lineContent, tabSize);
		const lineHasSpace = fontInfo.spaceWidth * indent > 22;
		const isFolded = (lineNumber: number) => {
			return lineNumber > 2 && this._editor.getTopForLineNumber(lineNumber) === this._editor.getTopForLineNumber(lineNumber - 1);
		};

		let effectiveLineNumber = lineNumber;
		if (!lineHasSpace) {
			if (lineNumber > 1 && !isFolded(lineNumber - 1)) {
				effectiveLineNumber -= 2;
			} else if (!isFolded(lineNumber + 1)) {
				effectiveLineNumber += 1;
			} else if (column * fontInfo.spaceWidth < 22) {
				// cannot show lightbulb above/below and showing
				// it inline would overlay the cursor...
				return this.hide();
			}
		}

		this.state = new aiButtonsState.Showing(actions, trigger, atPosition, {
			position: { lineNumber: effectiveLineNumber, column: 2 },
			preference: AiButtonsWidget._posPref
		});

		// tells the editor to actually render the widget
		this._editor.layoutContentWidget(this);
	}

	public hide(): void {
		if (this.state === aiButtonsState.Hidden) {
			return;
		}

		this.state = aiButtonsState.Hidden;
		this._editor.layoutContentWidget(this);
	}

	private get state(): aiButtonsState.State { return this._state; }

	private set state(value) {
		this._state = value;
		this._renderButtons();
	}

	private _renderButtons(): void {
		if (this.state.type === aiButtonsState.Type.Showing) {

			const container = document.createElement('div');
			container.className = 'ai-code-actions-container';

			// TODO: abstract this into a general implementation
			const chatButton = document.createElement('button');
			const editButton = document.createElement('button');
			chatButton.className = 'ai-code-action';
			editButton.className = 'ai-code-action';



			chatButton.append(`Chat`);
			chatButton.append(nls.localize('chatCodeActionWithKb', "{0}", this._chatKbLabel! || ''));
			editButton.append(`Edit`);
			editButton.append(nls.localize('chatCodeActionWithKb', "{0}", this._chatKbLabel! || ''));


			container.append(chatButton);
			container.append(editButton);

			this._domNode.replaceChildren(container);
		}
	}

}
