import type { Runtime, Update } from 'foldkit';

import { selectGames } from '../../src/domain/library.js';
import {
	api,
	decodeCriteria,
	DownloadCriteria,
	errorText,
	ParseCollections,
	ReadFile,
} from './commands.js';
import { activeJob, initialModel, Message, type Model } from './model.js';

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
	model: initialModel,
	commands: [api('state', undefined, 'load')],
});
export const update = (
	model: Model,
	message: Message,
): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		Changed: ({ field, value }) =>
			[
				'search',
				'category',
				'sort',
				'tags',
				'text',
				'steamId',
				'criteria',
			].includes(field)
				? { model: { ...model, [field]: value, confirmed: false } }
				: { model },
		ToggledConfirm: () => ({
			model: { ...model, confirmed: !model.confirmed },
		}),
		ToggledAll: () => ({
			model: { ...model, all: !model.all, confirmed: false },
		}),
		ToggledRecovery: () => ({
			model: { ...model, recoveryConfirmed: !model.recoveryConfirmed },
		}),
		Downloaded: () => ({
			model: { ...model, notice: 'Category draft downloaded.' },
		}),
		Selected: ({ appid }) => {
			const game = model.state?.library.games.find(
				(game) => game.appid === appid,
			);
			return game
				? { model: { ...model, selected: appid, tags: game.tags.join(', ') } }
				: { model };
		},
		Opened: ({ panel }) => ({
			model: {
				...model,
				panel,
				confirmed: false,
				all: panel === 'classify' ? false : model.all,
			},
		}),
		Reloaded: () =>
			model.pending || model.polling
				? { model }
				: {
						model: { ...model, pending: 'load' },
						commands: [api('state', undefined, 'load')],
					},
		Poll: () =>
			!activeJob(model) || model.pending || model.polling
				? { model }
				: {
						model: { ...model, polling: true },
						commands: [api('state', undefined, 'poll')],
					},
		Received: ({ state, action }) => {
			// A cancellation response supersedes any older in-flight state read.
			if (action === 'poll' && (!model.polling || model.pending))
				return { model: { ...model, polling: false } };
			const identityChanged = state.identity !== model.state?.identity;
			const libraryChanged =
				state.library.steamId !== model.state?.library.steamId;
			const base = identityChanged ? initialModel : model;
			return {
				model: {
					...base,
					state,
					loading: false,
					polling: false,
					pending: action === 'poll' ? base.pending : '',
					criteria:
						identityChanged || libraryChanged || action === 'criteria'
							? JSON.stringify(state.criteria, null, 2)
							: base.criteria,
					steamId:
						identityChanged ||
						libraryChanged ||
						action === 'sync' ||
						action === 'load'
							? (state.library.steamId ?? '')
							: base.steamId,
					error: action === 'poll' ? base.error : '',
					all: action === 'classify' ? false : base.all,
					confirmed: action === 'poll' ? base.confirmed : false,
					recoveryConfirmed: action === 'poll' ? base.recoveryConfirmed : false,
					notice:
						action === 'poll' || action === 'load'
							? base.notice
							: action === 'criteria'
								? 'Category definitions saved privately for this Steam library.'
								: action === 'classify'
									? 'Classification started on the server. You can close this tab.'
									: action === 'jobs/cancel'
										? 'Cancel requested. The current game will finish first.'
										: action === 'classify/recover'
											? 'Paid lock cleared. Start a new run explicitly if needed. Repeated classification may incur another charge.'
											: 'Saved successfully.',
				},
			};
		},
		Failed: ({ message, action }) => ({
			model: {
				...model,
				loading: false,
				polling: false,
				pending: action === 'poll' ? model.pending : '',
				error: message,
				recoveryConfirmed: false,
			},
		}),
		FileSelected: ({ files }) =>
			!files[0] || model.pending
				? { model }
				: {
						model: { ...model, pending: 'file' },
						commands: [ReadFile({ file: files[0] })],
					},
		FileRead: ({ text }) => {
			try {
				return {
					model: {
						...model,
						pending: '',
						confirmed: false,
						...(model.panel === 'criteria'
							? { criteria: JSON.stringify(decodeCriteria(text), null, 2) }
							: { text }),
						notice: 'File loaded into the draft. Review before submitting.',
					},
				};
			} catch (error) {
				return { model: { ...model, pending: '', error: errorText(error) } };
			}
		},
		ReceivedCriteria: ({ criteria }) => ({
			model: {
				...model,
				pending: '',
				panel: 'criteria',
				criteria: JSON.stringify(criteria, null, 2),
				notice:
					'Collection names loaded into the draft. Edit descriptions before saving.',
			},
		}),
		Submitted: ({ action }) => {
			if (
				model.pending ||
				(model.polling && action !== 'jobs/cancel') ||
				!model.state
			)
				return { model };
			try {
				if (action === 'download-criteria')
					return {
						model,
						commands: [DownloadCriteria({ text: model.criteria })],
					};
				if (action === 'collections')
					return {
						model: { ...model, pending: action },
						commands: [ParseCollections({ text: model.text })],
					};
				let body: unknown;
				if (action === 'jobs/cancel') {
					if (!activeJob(model)) return { model };
					body = {};
				} else {
					if (activeJob(model))
						throw new Error(
							'Finish or cancel classification before changing the library or saved criteria.',
						);
					switch (action) {
						case 'criteria':
							body = {
								steamId: model.state.library.steamId,
								criteria: decodeCriteria(model.criteria),
							};
							break;
						case 'classify/recover':
							if (!model.recoveryConfirmed)
								throw new Error(
									'Acknowledge that clearing an uncertain paid lock may cause duplicate charges.',
								);
							body = { confirm: true };
							break;
						case 'classify':
							if (!model.state.configured.classify) return { model };
							if (!model.confirmed)
								throw new Error(
									'Read and check the paid classification confirmation first.',
								);
							if (
								!selectGames(
									model.state.library,
									model.search,
									model.category,
								).some((game) => model.all || !game.reviewed)
							)
								throw new Error('No games in this scope need classification.');
							body = {
								steamId: model.state.library.steamId,
								search: model.search,
								category: model.category,
								all: model.all,
							};
							break;
						case 'tags':
							if (model.selected === null) return { model };
							body = {
								appid: model.selected,
								tags: [
									...new Set(
										model.tags
											.split(',')
											.map((tag) => tag.trim())
											.filter(Boolean),
									),
								],
							};
							break;
						case 'sync':
							if (!model.state.configured.sync) return { model };
							if (!model.confirmed)
								throw new Error('Read and check the confirmation first.');
							if (!/^\d{17}$/.test(model.steamId))
								throw new Error('Enter your own 17-digit Steam ID.');
							body = { steamId: model.steamId, confirm: true };
							break;
						case 'import':
						case 'restore':
						case 'steam-collections':
							if (!model.confirmed)
								throw new Error('Read and check the confirmation first.');
							if (!model.text.trim())
								throw new Error('Choose a file or paste JSON.');
							body = { text: model.text, confirm: true };
							break;
						default:
							return { model };
					}
				}
				return {
					model: { ...model, pending: action, error: '', notice: '' },
					commands: [api(action, body)],
				};
			} catch (error) {
				return { model: { ...model, error: errorText(error) } };
			}
		},
	});
