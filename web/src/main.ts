import { Effect, Schema, Stream } from 'effect';
import { Command, Runtime, Subscription, Update } from 'foldkit';
import type { Document, HtmlBuilder } from 'foldkit/html';
import { defineMessageUnion } from 'foldkit/message';

import { CategoryCriteria } from '../../src/domain/classification.js';
import { AppId, categories, selectGames } from '../../src/domain/library.js';
import { CollectionsLayer } from '../../src/layers/collections.js';
import { Collections } from '../../src/services/collections.js';
import { AppState, ApiError } from '../shared.js';

export const Model = Schema.Struct({
	state: Schema.NullOr(AppState),
	loading: Schema.Boolean,
	pending: Schema.String,
	polling: Schema.Boolean,
	error: Schema.String,
	notice: Schema.String,
	search: Schema.String,
	category: Schema.String,
	sort: Schema.String,
	selected: Schema.NullOr(AppId),
	tags: Schema.String,
	panel: Schema.String,
	text: Schema.String,
	steamId: Schema.String,
	criteria: Schema.String,
	confirmed: Schema.Boolean,
	recoveryConfirmed: Schema.Boolean,
	all: Schema.Boolean,
});
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
	Changed: { field: Schema.String, value: Schema.String },
	ToggledConfirm: {},
	ToggledAll: {},
	ToggledRecovery: {},
	Downloaded: {},
	Selected: { appid: AppId },
	Opened: { panel: Schema.String },
	Submitted: { action: Schema.String },
	Reloaded: {},
	Poll: {},
	Received: { state: AppState, action: Schema.String },
	ReceivedCriteria: { criteria: CategoryCriteria },
	FileSelected: { files: Schema.Array(Schema.instanceOf(File)) },
	FileRead: { text: Schema.String },
	Failed: { message: Schema.String, action: Schema.String },
});
export type Message = typeof Message.Type;
const errorText = (error: unknown) =>
	error instanceof Error
		? error.message
		: 'Operation failed. Please try again.';
export const Api = Command.define('Api', {
	args: { path: Schema.String, body: Schema.String, action: Schema.String },
	messages: [Message.Received, Message.Failed],
	execute: ({ path, body, action }) =>
		Effect.gen(function* () {
			const response = yield* Effect.tryPromise({
				try: () =>
					fetch(`/api/${path}`, {
						method: body ? 'POST' : 'GET',
						credentials: 'same-origin',
						headers: body
							? {
									'Content-Type': 'application/json',
									'X-Requested-With': 'steam-organizer',
								}
							: {},
						...(body ? { body } : {}),
					}),
				catch: errorText,
			});
			if (response.status === 401 || response.status === 403)
				return yield* Effect.fail(
					'Your session expired or access was denied. Reload and sign in again.',
				);
			const data: unknown = yield* Effect.tryPromise({
				try: () => response.json(),
				catch: errorText,
			});
			if (!response.ok) {
				const error = yield* Schema.decodeUnknownEffect(ApiError)(data);
				return yield* Effect.fail(error.message);
			}
			const state = yield* Schema.decodeUnknownEffect(AppState)(data);
			return Message.Received({ state, action });
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(
					Message.Failed({
						message:
							typeof error === 'string'
								? error
								: 'The server returned an invalid response. Reload your session.',
						action,
					}),
				),
			),
		),
});
export const ParseCollections = Command.define('ParseCollections', {
	args: { text: Schema.String },
	messages: [Message.ReceivedCriteria, Message.Failed],
	execute: ({ text }) =>
		Effect.gen(function* () {
			const service = yield* Collections;
			return Message.ReceivedCriteria({
				criteria: yield* service.extractCategoryCriteria(text),
			});
		}).pipe(
			Effect.provide(CollectionsLayer),
			Effect.catch((error) =>
				Effect.succeed(
					Message.Failed({ message: error.message, action: 'collections' }),
				),
			),
		),
});
const decodeCriteria = (text: string) =>
	Schema.decodeUnknownSync(CategoryCriteria)(JSON.parse(text));
export const DownloadCriteria = Command.define('DownloadCriteria', {
	args: { text: Schema.String },
	messages: [Message.Downloaded, Message.Failed],
	execute: ({ text }) =>
		Effect.try({
			try: () => {
				const criteria = decodeCriteria(text);
				const url = URL.createObjectURL(
					new Blob([JSON.stringify(criteria, null, 2)], {
						type: 'application/json',
					}),
				);
				const a = document.createElement('a');
				a.href = url;
				a.download = 'category-criteria.json';
				a.click();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
				return Message.Downloaded();
			},
			catch: errorText,
		}).pipe(
			Effect.catch((message) =>
				Effect.succeed(Message.Failed({ message, action: 'download' })),
			),
		),
});
export const ReadFile = Command.define('ReadFile', {
	args: { file: Schema.instanceOf(File) },
	messages: [Message.FileRead, Message.Failed],
	execute: ({ file }) =>
		Effect.tryPromise({
			try: async () => {
				if (file.size > 1024 * 1024)
					throw new Error('Choose a JSON file smaller than 1 MB.');
				return Message.FileRead({ text: await file.text() });
			},
			catch: errorText,
		}).pipe(
			Effect.catch((message) =>
				Effect.succeed(Message.Failed({ message, action: 'file' })),
			),
		),
});
const api = (path: string, body?: unknown, action = path) =>
	Api({ path, body: body === undefined ? '' : JSON.stringify(body), action });
export const initialModel: Model = {
	state: null,
	loading: true,
	pending: '',
	polling: false,
	error: '',
	notice: '',
	search: '',
	category: '',
	sort: 'name',
	selected: null,
	tags: '',
	panel: '',
	text: '',
	steamId: '',
	criteria: '',
	confirmed: false,
	recoveryConfirmed: false,
	all: false,
};
export const activeJob = (model: Model) =>
	!!model.state?.job && ['queued', 'running'].includes(model.state.job.status);
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
			const game = model.state?.library.games.find((g) => g.appid === appid);
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
								).some((g) => model.all || !g.reviewed)
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
											.map((t) => t.trim())
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
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
	job: entry(
		{ identity: Schema.String, jobId: Schema.String },
		{
			modelToDependencies: (model) => ({
				identity: model.state?.identity ?? '',
				jobId: activeJob(model) ? model.state!.job!.id : '',
			}),
			dependenciesToStream: ({ jobId }) =>
				jobId
					? Stream.tick('2 seconds').pipe(Stream.map(() => Message.Poll()))
					: Stream.empty,
		},
	),
}));

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
	const state = model.state;
	const busy = !!model.pending;
	const locked = busy || activeJob(model);
	const button = (
		label: string,
		message: Message,
		disabled = false,
		cls = '',
	) =>
		h.button(
			[
				h.Type('button'),
				h.OnClick(message),
				h.Disabled(disabled),
				h.Class(cls),
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
		h.label(
			[],
			[
				label,
				h.input([
					h.Type(name === 'search' ? 'search' : 'text'),
					h.Value(model[name]),
					h.OnInput((value) => Message.Changed({ field: name, value })),
					h.Disabled(disabled),
				]),
			],
		);
	const textarea = (name: 'text' | 'criteria', label: string) =>
		h.label(
			[],
			[
				label,
				h.textarea([
					h.Rows(12),
					h.Value(model[name]),
					h.OnInput((value) => Message.Changed({ field: name, value })),
					h.Disabled(busy),
					h.Spellcheck(false),
				]),
			],
		);
	const check = (
		label: string,
		checked: boolean,
		message: Message,
		disabled = locked,
	) =>
		h.label(
			[h.Class('check')],
			[
				h.input([
					h.Type('checkbox'),
					h.Checked(checked),
					h.OnClick(message),
					h.Disabled(disabled),
				]),
				label,
			],
		);
	const confirm = (label: string) =>
		check(label, model.confirmed, Message.ToggledConfirm());
	const file = () =>
		h.label(
			[],
			[
				'Choose a JSON file',
				h.input([
					h.Type('file'),
					h.Accept('.json,application/json'),
					h.Disabled(busy),
					h.OnFileChange((files) => Message.FileSelected({ files })),
				]),
			],
		);
	const games = state
		? [...selectGames(state.library, model.search, model.category)]
		: [];
	if (model.sort === 'playtime')
		games.sort((a, b) => b.playtime_forever - a.playtime_forever);
	const selected = state?.library.games.find((g) => g.appid === model.selected);
	const nav = (name: string, label = name) =>
		button(
			`${label}  ${state ? selectGames(state.library, '', name).length : 0}`,
			Message.Changed({ field: 'category', value: name }),
			false,
			model.category === name ? 'nav selected' : 'nav',
		);
	const titles: Record<string, string> = {
		import: 'Import Steam or CLI JSON',
		restore: 'Restore a library backup',
		sync: 'Sync your Steam library',
		criteria: 'Category definitions',
		collections: 'Import collection names as definitions',
		'steam-collections': 'Import Steam collection memberships',
		classify: 'Classify games',
	};
	const panel = model.panel;
	const panelContent =
		panel === 'criteria'
			? [
					h.p(
						[],
						[
							`Category definitions are saved privately for ${state?.library.steamId ? `Steam ID ${state.library.steamId}` : 'this offline library'}, under your sign-in. They follow this library across browsers. Unsaved drafts stay in this tab.`,
						],
					),
					h.p(
						[h.Class('muted')],
						[
							'Use a JSON object mapping category names to nonempty descriptions, for example { "Cozy": "Relaxing games without time pressure." }. Automatic playtime categories cannot be edited.',
						],
					),
					file(),
					textarea('criteria', 'Category names and descriptions'),
					action('criteria', 'Save criteria', locked || !state),
					action('download-criteria', 'Download criteria JSON', busy),
					open('collections', 'Import collection names'),
				]
			: panel === 'sync'
				? [
						field('steamId', 'Your 17-digit Steam ID', locked),
						h.p(
							[],
							[
								'Everyone enters their own Steam ID. API keys stay on the server.',
							],
						),
						confirm(
							'Replace my library with my owned Steam games. Matching tags are preserved.',
						),
						action(
							'sync',
							'Sync Steam library',
							locked || !model.confirmed || !state?.configured.sync,
						),
					]
				: panel === 'classify'
					? [
							h.p(
								[],
								[
									`Scope: ${games.length} matching games. Only unreviewed games are included by default. Saved category definitions are snapshotted when you start. One game runs at a time.`,
								],
							),
							h.p(
								[h.Class('muted')],
								[
									'Classification continues on the server after this tab closes. Reopen to see saved progress. Failed runs do not retry paid work automatically.',
								],
							),
							check(
								'Include reviewed games. Reclassification may incur another charge.',
								model.all,
								Message.ToggledAll(),
							),
							confirm(
								'Send game names and descriptions for paid TypeSafe classification. Charges may apply.',
							),
							action(
								'classify',
								'Start classification',
								locked || !model.confirmed || !state?.configured.classify,
							),
						]
					: panel
						? [
								file(),
								textarea('text', 'JSON contents'),
								h.p(
									[],
									[
										panel === 'collections' || panel === 'steam-collections'
											? 'Steam file: userdata/<account-id>/config/cloudstorage/cloud-storage-namespace-1.json. Dynamic filters cannot be reconstructed.'
											: 'Accepts Steam GetOwnedGames JSON, raw game arrays, CLI Library files, and CLI export JSON. CLI tags and review flags are preserved.',
									],
								),
								...(panel === 'collections'
									? [
											h.p(
												[],
												[
													'Names become an editable local draft only. No library games or tags change.',
												],
											),
											action(panel, 'Load editable draft', busy),
										]
									: [
											confirm(
												panel === 'steam-collections'
													? 'Attach static memberships as tags to matching existing games only. Do not replace the library or create unknown games.'
													: 'Replace the library and remove games absent from this file. Imported tags and review flags are preserved.',
											),
											action(
												panel,
												panel === 'steam-collections'
													? 'Attach memberships'
													: 'Confirm import',
												locked || !model.confirmed,
											),
										]),
							]
						: [];
	const job = state?.job;
	return {
		title: 'Steam library organizer',
		body: h.div(
			[h.Class('workspace')],
			[
				h.aside(
					[h.Class('sidebar')],
					[
						h.div([h.Class('wordmark')], ['S / O']),
						h.p([h.Class('eyebrow')], ['YOUR COLLECTION']),
						h.h2([], ['Your library']),
						h.nav(
							[h.AriaLabel('Library categories')],
							[
								nav('', 'All games'),
								h.h3([], ['Automatic']),
								...['Unplayed', 'Sampled', 'Played', 'Recently played'].map(
									(n) => nav(n),
								),
								h.h3([], ['Editable tags']),
								...[
									...new Set(state?.library.games.flatMap((g) => g.tags) ?? []),
								]
									.sort()
									.map((n) => nav(n)),
							],
						),
						h.div(
							[h.Class('sidebar-footer')],
							[
								h.p([], ['Share the organizer with friends.']),
								h.p(
									[h.Class('muted')],
									[
										'Each authenticated identity has an isolated library, category definitions, and jobs.',
									],
								),
							],
						),
					],
				),
				h.main(
					[],
					[
						h.header(
							[],
							[
								h.div(
									[],
									[
										h.p([h.Class('eyebrow')], ['STEAM / LIBRARY ORGANIZER']),
										h.h1([], [model.category || 'All games']),
										h.p(
											[h.Class('muted')],
											[
												`${state?.library.games.length ?? 0} games in your collection`,
											],
										),
									],
								),
								h.div(
									[h.Class('actions')],
									[open('import', 'Import'), open('sync', 'Sync Steam')],
								),
							],
						),
						h.div(
							[h.Class('utility')],
							[
								open('criteria', 'Category criteria'),
								open('classify', 'Classify'),
								open('steam-collections', 'Steam memberships'),
								open('restore', 'Restore backup'),
								h.a([h.Href('/api/export?format=json')], ['Export JSON']),
								h.a([h.Href('/api/export?format=csv')], ['Export CSV']),
								h.a([h.Href('/api/backup')], ['Download backup']),
							],
						),
						...(state && !state.configured.sync
							? [
									h.p(
										[h.Class('muted')],
										[
											'Steam sync needs a server API key. Offline imports and category definitions are still available.',
										],
									),
								]
							: []),
						...(state && !state.configured.classify
							? [
									h.p(
										[h.Class('muted')],
										[
											'Classification needs server TypeSafe credentials. Offline imports and category definitions are still available.',
										],
									),
								]
							: []),
						...(model.error
							? [
									h.div(
										[h.Role('alert'), h.Class('feedback error')],
										[
											model.error,
											button('Retry loading', Message.Reloaded(), busy),
										],
									),
								]
							: []),
						...(model.notice
							? [h.p([h.Role('status'), h.Class('feedback')], [model.notice])]
							: []),
						...(job
							? [
									h.section(
										[h.Class('job'), h.AriaLabel('Classification progress')],
										[
											h.p(
												[h.Role('status')],
												[
													`Classification ${job.status} · ${job.completed} / ${job.total}${job.current ? ` · ${job.current}` : ''}`,
												],
											),
											h.progress([
												h.Max(String(job.total || 1)),
												h.Value(String(job.completed)),
											]),
											...(job.error
												? [h.p([h.Role('alert')], [job.error])]
												: []),
											...(activeJob(model)
												? [
														action(
															'jobs/cancel',
															'Cancel at game boundary',
															busy,
														),
													]
												: []),
											...(job.status === 'failed'
												? [
														check(
															'I understand that clearing an uncertain paid lock can cause duplicate charges. Do not do this for an ordinary network retry.',
															model.recoveryConfirmed,
															Message.ToggledRecovery(),
															busy,
														),
														action(
															'classify/recover',
															'Clear uncertain paid lock',
															busy || !model.recoveryConfirmed,
														),
													]
												: []),
										],
									),
								]
							: []),
						...(panel
							? [
									h.section(
										[h.Class('panel')],
										[
											h.div(
												[h.Class('panel-heading')],
												[
													h.h2([], [titles[panel] ?? panel]),
													open('', 'Close panel'),
												],
											),
											h.form(
												[
													h.Class('panel-fields'),
													h.OnSubmit(Message.Submitted({ action: panel })),
												],
												panelContent,
											),
										],
									),
								]
							: []),
						h.div(
							[h.Class('filters')],
							[
								field('search', 'Search games'),
								h.label(
									[],
									[
										'Sort by',
										h.select(
											[
												h.Value(model.sort),
												h.OnChange((value) =>
													Message.Changed({ field: 'sort', value }),
												),
											],
											[
												h.option([h.Value('name')], ['Title A–Z']),
												h.option([h.Value('playtime')], ['Most played']),
											],
										),
									],
								),
							],
						),
						...(model.loading
							? [
									h.section(
										[h.Class('empty'), h.Role('status')],
										[h.h2([], ['Loading your library…'])],
									),
								]
							: !state
								? [
										h.section(
											[h.Class('empty')],
											[
												h.h2([], ['Library unavailable']),
												button('Retry', Message.Reloaded(), busy),
											],
										),
									]
								: !state.library.games.length
									? [
											h.section(
												[h.Class('empty')],
												[
													h.p([h.Class('eyebrow')], ['A CLEAN SHELF']),
													h.h2([], ['Make room for your next game.']),
													h.p(
														[],
														[
															'Import Steam or CLI JSON, or sync your own Steam ID to begin.',
														],
													),
												],
											),
										]
									: !games.length
										? [
												h.section(
													[h.Class('empty')],
													[
														h.h2([], ['No matching games']),
														h.p([], ['Try a different title or category.']),
													],
												),
											]
										: [
												h.div(
													[h.Class('table-wrap')],
													[
														h.table(
															[],
															[
																h.thead(
																	[],
																	[
																		h.tr(
																			[],
																			[
																				'Game',
																				'Playtime',
																				'Automatic',
																				'Tags',
																			].map((label) =>
																				h.th([h.Scope('col')], [label]),
																			),
																		),
																	],
																),
																h.tbody(
																	[],
																	games.map((game) =>
																		h.tr(
																			[
																				h.Class(
																					game.appid === model.selected
																						? 'row-selected'
																						: '',
																				),
																			],
																			[
																				h.td(
																					[],
																					[
																						button(
																							game.name,
																							Message.Selected({
																								appid: game.appid,
																							}),
																							busy,
																							'game-title',
																						),
																						h.small(
																							[],
																							[
																								`#${game.appid} · ${game.reviewed ? 'Reviewed' : 'Not reviewed'}`,
																							],
																						),
																					],
																				),
																				h.td(
																					[],
																					[
																						`${(game.playtime_forever / 60).toFixed(1)} h`,
																					],
																				),
																				h.td(
																					[],
																					[
																						categories({
																							...game,
																							tags: [],
																						}).join(' · '),
																					],
																				),
																				h.td([], [game.tags.join(', ') || '—']),
																			],
																		),
																	),
																),
															],
														),
													],
												),
											]),
						...(selected
							? [
									h.section(
										[h.Class('panel')],
										[
											h.h2([], [selected.name]),
											h.p(
												[],
												[
													'Separate tags with commas. Saving tags does not mark this game reviewed. Automatic playtime categories cannot be edited.',
												],
											),
											h.form(
												[h.OnSubmit(Message.Submitted({ action: 'tags' }))],
												[
													field('tags', 'Tags', locked),
													h.button(
														[
															h.Type('submit'),
															h.Disabled(locked),
															h.Class('primary'),
														],
														['Save tags'],
													),
												],
											),
										],
									),
								]
							: []),
						h.footer(
							[],
							[
								'Libraries and category definitions are private to your sign-in. Classification continues after the tab closes.',
							],
						),
					],
				),
			],
		),
	};
};
