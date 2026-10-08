import type { HtmlBuilder } from 'foldkit/html';

import { activeJob, Message, type Model } from '../model.js';

export const controls = (model: Model, html: HtmlBuilder<Message>) => {
	const busy = !!model.pending;
	const locked = busy || activeJob(model);
	const button = (
		label: string,
		message: Message,
		disabled = false,
		className = '',
	) =>
		html.button(
			[
				html.Type('button'),
				html.OnClick(message),
				html.Disabled(disabled),
				html.Class(className),
			],
			[label],
		);
	const open = (panel: string, label: string) =>
		button(label, Message.Opened({ panel }), busy);
	const action = (name: string, label: string, disabled = locked) =>
		button(
			model.pending === name ? 'Working…' : label,
			Message.Submitted({ action: name }),
			disabled,
			[
				'criteria',
				'classify',
				'sync',
				'import',
				'restore',
				'steam-collections',
			].includes(name)
				? 'primary'
				: '',
		);
	const field = (
		name: 'search' | 'tags' | 'steamId',
		label: string,
		disabled = false,
	) =>
		html.label(
			[],
			[
				label,
				html.input([
					html.Type(name === 'search' ? 'search' : 'text'),
					html.Value(model[name]),
					html.OnInput((value) => Message.Changed({ field: name, value })),
					html.Disabled(disabled),
				]),
			],
		);
	const textarea = (name: 'text' | 'criteria', label: string) =>
		html.label(
			[],
			[
				label,
				html.textarea([
					html.Rows(12),
					html.Value(model[name]),
					html.OnInput((value) => Message.Changed({ field: name, value })),
					html.Disabled(busy),
					html.Spellcheck(false),
				]),
			],
		);
	const check = (
		label: string,
		checked: boolean,
		message: Message,
		disabled = locked,
	) =>
		html.label(
			[html.Class('check')],
			[
				html.input([
					html.Type('checkbox'),
					html.Checked(checked),
					html.OnClick(message),
					html.Disabled(disabled),
				]),
				label,
			],
		);
	const confirm = (label: string) =>
		check(label, model.confirmed, Message.ToggledConfirm());
	const file = () =>
		html.label(
			[],
			[
				'Choose a JSON file',
				html.input([
					html.Type('file'),
					html.Accept('.json,application/json'),
					html.Disabled(busy),
					html.OnFileChange((files) => Message.FileSelected({ files })),
				]),
			],
		);
	return { button, open, action, field, textarea, check, confirm, file };
};
