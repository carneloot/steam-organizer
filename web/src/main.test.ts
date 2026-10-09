import { Effect, Stream } from 'effect';
import * as Scene from 'foldkit/scene';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppState, Job } from '../shared.js';
import {
	Api,
	DownloadCriteria,
	ParseCollections,
	ReadFile,
} from './commands.js';
import { initialModel, Message, type Model } from './model.js';
import { subscriptions } from './subscriptions.js';
import { update } from './update.js';
import { view } from './views/view.js';

const state: AppState = {
	identity: 'alice@example.com',
	criteria: { RPG: 'Role playing' },
	job: null,
	library: {
		version: 1,
		steamId: '76561198000000001',
		games: [
			{
				appid: 10,
				name: 'Test game',
				playtime_forever: 0,
				reviewed: false,
				tags: ['RPG'],
			},
		],
	},
	configured: { sync: true, classify: true },
};
const job: Job = {
	id: 'server-job',
	status: 'running',
	total: 1,
	completed: 0,
	current: 'Test game',
	error: null,
};
const ready = (): Model =>
	update(initialModel, Message.Received({ state, action: 'load' })).model;
const submit = (model: Model, action: string) =>
	update(model, Message.Submitted({ action }));
const body = (result: ReturnType<typeof submit>) =>
	JSON.parse(String(result.commands?.[0]?.args?.body));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('server-owned criteria and classification', () => {
	it('loads server identity, criteria and actual job without browser storage or commands', () => {
		const storage = vi.fn(() => {
			throw new Error('Storage is forbidden');
		});
		vi.stubGlobal('localStorage', { getItem: storage, setItem: storage });
		const result = update(
			initialModel,
			Message.Received({ state: { ...state, job }, action: 'load' }),
		);
		expect(result.model.state).toEqual({ ...state, job });
		expect(result.model.criteria).toBe(JSON.stringify(state.criteria, null, 2));
		expect(result.model.steamId).toBe(state.library.steamId);
		expect(result.commands).toBeUndefined();
		expect(storage).not.toHaveBeenCalled();
	});
	it('saves decoded draft with the active library Steam ID, not the input', () => {
		const result = submit(
			{
				...ready(),
				steamId: '76561198000000099',
				criteria: '{"Cozy":"Relaxing"}',
			},
			'criteria',
		);
		expect(result.commands?.[0]?.args?.path).toBe('criteria');
		expect(body(result)).toEqual({
			steamId: state.library.steamId,
			criteria: { Cozy: 'Relaxing' },
		});
		expect(
			submit({ ...ready(), criteria: 'not json' }, 'criteria').commands,
		).toBeUndefined();
	});
	it('starts exactly one server job with scope and no per-game request IDs', () => {
		const model = {
			...ready(),
			confirmed: true,
			search: 'Test',
			category: 'RPG',
		};
		const result = submit(model, 'classify');
		expect(body(result)).toEqual({
			steamId: state.library.steamId,
			search: 'Test',
			category: 'RPG',
			all: false,
		});
		expect(submit(result.model, 'classify').commands).toBeUndefined();
		const received = update(
			result.model,
			Message.Received({ state: { ...state, job }, action: 'classify' }),
		);
		expect(received.commands).toBeUndefined();
		expect(
			submit({ ...received.model, confirmed: true }, 'classify').commands,
		).toBeUndefined();
	});
	it('defaults each explicit run to unreviewed and requires renewed consent for all', () => {
		const opened = update(
			{ ...ready(), all: true, confirmed: true },
			Message.Opened({ panel: 'classify' }),
		).model;
		expect(opened.all).toBe(false);
		const toggled = update(
			{ ...opened, confirmed: true },
			Message.ToggledAll(),
		).model;
		expect(toggled.confirmed).toBe(false);
		expect(submit(toggled, 'classify').commands).toBeUndefined();
		expect(body(submit({ ...toggled, confirmed: true }, 'classify')).all).toBe(
			true,
		);
	});
	it('polls only active jobs, prevents overlap, and preserves every unsaved field', () => {
		const model = {
			...ready(),
			state: { ...state, job },
			criteria: 'unsaved criteria',
			tags: 'unsaved tags',
			search: 'Test',
			selected: 10,
			text: 'unsaved import',
			confirmed: true,
		};
		const poll = update(model, Message.Poll());
		expect(poll.commands?.[0]?.args).toEqual({
			path: 'state',
			body: '',
			action: 'poll',
		});
		expect(update(poll.model, Message.Poll()).commands).toBeUndefined();
		const received = update(
			poll.model,
			Message.Received({
				state: {
					...state,
					job: { ...job, completed: 1, status: 'complete' },
					criteria: { Other: 'Server definition' },
				},
				action: 'poll',
			}),
		);
		for (const key of [
			'criteria',
			'tags',
			'search',
			'selected',
			'text',
			'confirmed',
		] as const)
			expect(received.model[key]).toBe(model[key]);
		expect(received.model.state?.criteria).toEqual({
			Other: 'Server definition',
		});
		expect(update(received.model, Message.Poll()).commands).toBeUndefined();
		expect(subscriptions.job.modelToDependencies(model)).toEqual({
			identity: state.identity,
			jobId: job.id,
		});
		expect(subscriptions.job.modelToDependencies(received.model).jobId).toBe(
			'',
		);
	});
	it('inactive subscription emits no ticks', async () => {
		const messages = await Effect.runPromise(
			Stream.runCollect(
				subscriptions.job.dependenciesToStream({
					identity: state.identity,
					jobId: '',
				}),
			),
		);
		expect(Array.from(messages)).toEqual([]);
	});
	it('resets private drafts when identity changes and synchronizes imported Steam ID', () => {
		const model = {
			...ready(),
			criteria: 'private draft',
			tags: 'private tag',
			selected: 10,
		};
		const changed = update(
			model,
			Message.Received({
				state: { ...state, identity: 'friend@example.com' },
				action: 'load',
			}),
		).model;
		expect(changed.tags).toBe('');
		expect(changed.selected).toBeNull();
		expect(changed.criteria).toBe(JSON.stringify(state.criteria, null, 2));
		const imported = update(
			model,
			Message.Received({
				state: { ...state, library: { ...state.library, steamId: null } },
				action: 'import',
			}),
		).model;
		expect(imported.steamId).toBe('');
	});
	it('cancels through the server and never automatically recovers or retries paid work', () => {
		const model = { ...ready(), state: { ...state, job } };
		const cancelled = submit(model, 'jobs/cancel');
		expect(cancelled.commands?.[0]?.args?.path).toBe('jobs/cancel');
		expect(body(cancelled)).toEqual({});
		const duringPoll = submit(
			update(model, Message.Poll()).model,
			'jobs/cancel',
		);
		expect(duringPoll.commands?.[0]?.args?.path).toBe('jobs/cancel');
		const stopped = update(
			duringPoll.model,
			Message.Received({
				state: { ...state, job: { ...job, status: 'cancelled' } },
				action: 'jobs/cancel',
			}),
		).model;
		expect(
			update(
				stopped,
				Message.Received({ state: { ...state, job }, action: 'poll' }),
			).model.state?.job?.status,
		).toBe('cancelled');
		const failed = update(
			{ ...ready(), pending: 'classify' },
			Message.Failed({ message: 'Uncertain outcome', action: 'classify' }),
		);
		expect(failed.commands).toBeUndefined();
		expect(submit(failed.model, 'classify/recover').commands).toBeUndefined();
		const recovery = submit(
			{ ...failed.model, recoveryConfirmed: true },
			'classify/recover',
		);
		expect(body(recovery)).toEqual({ confirm: true });
		const received = update(
			recovery.model,
			Message.Received({ state, action: 'classify/recover' }),
		);
		expect(received.commands).toBeUndefined();
	});
	it('offline imports, restores and criteria work without keys', () => {
		const offline = {
			...ready(),
			state: { ...state, configured: { sync: false, classify: false } },
			confirmed: true,
			text: '[]',
		};
		for (const action of ['import', 'restore', 'steam-collections', 'criteria'])
			expect(submit(offline, action).commands?.[0]?.args?.path).toBe(action);
		expect(submit(offline, 'classify').commands).toBeUndefined();
	});
	it('decodes API responses and handles authentication failure', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ ...state, job })),
		);
		const received = await Effect.runPromise(
			Api({ path: 'state', body: '', action: 'load' }).effect,
		);
		expect(received).toEqual(
			Message.Received({ state: { ...state, job }, action: 'load' }),
		);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 401 })),
		);
		expect(
			(
				await Effect.runPromise(
					Api({ path: 'state', body: '', action: 'load' }).effect,
				)
			)._tag,
		).toBe('Failed');
	});
	it('retains the 1 MB frontend file limit and local parsing', async () => {
		const result = await Effect.runPromise(
			ReadFile({ file: new File(['x'.repeat(1024 * 1024 + 1)], 'large.json') })
				.effect,
		);
		expect(result._tag).toBe('Failed');
		expect(
			submit({ ...ready(), text: '{}' }, 'collections').commands?.[0]?.name,
		).toBe(ParseCollections({ text: '{}' }).name);
	});
	it('parses collection names and category files into drafts without saving', async () => {
		const text = JSON.stringify([
			[
				'user-collections.1',
				{ value: JSON.stringify({ name: 'Cozy', added: [10] }) },
			],
		]);
		const parsed = await Effect.runPromise(ParseCollections({ text }).effect);
		const draft = update(ready(), parsed);
		expect(JSON.parse(draft.model.criteria)).toHaveProperty('Cozy');
		expect(draft.model.state?.criteria).toEqual(state.criteria);
		expect(draft.commands).toBeUndefined();
		const file = new File(['{"Custom":"Description"}'], 'criteria.json');
		const imported = update(
			{ ...ready(), panel: 'criteria' },
			await Effect.runPromise(ReadFile({ file }).effect),
		);
		expect(JSON.parse(imported.model.criteria)).toEqual({
			Custom: 'Description',
		});
		expect(imported.commands).toBeUndefined();
	});
	it('downloads a validated Blob without server or storage', async () => {
		const click = vi.fn();
		vi.stubGlobal('document', {
			createElement: () => ({ click, href: '', download: '' }),
		});
		const create = vi
			.spyOn(URL, 'createObjectURL')
			.mockReturnValue('blob:test');
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		await Effect.runPromise(
			DownloadCriteria({ text: ready().criteria }).effect,
		);
		expect(create.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
		expect(click).toHaveBeenCalledOnce();
	});
});

describe('Scene states and consent', () => {
	it('renders loading, empty, unavailable and populated tag editing', () => {
		Scene.scene(
			{ update, view },
			Scene.given(initialModel),
			Scene.expect(Scene.role('status')).toContainText('Loading your library'),
		);
		Scene.scene(
			{ update, view },
			Scene.given({ ...ready(), state: null }),
			Scene.expect(
				Scene.role('heading', { name: 'Library unavailable' }),
			).toExist(),
		);
		Scene.scene(
			{ update, view },
			Scene.given({
				...ready(),
				state: { ...state, library: { ...state.library, games: [] } },
			}),
			Scene.expect(
				Scene.role('heading', { name: 'Make room for your next game.' }),
			).toExist(),
		);
		Scene.scene(
			{ update, view },
			Scene.given(ready()),
			Scene.click(Scene.role('button', { name: 'Test game' })),
			Scene.expect(Scene.label('Tags')).toHaveValue('RPG'),
			Scene.expect(
				Scene.text(/Saving tags does not mark this game reviewed/),
			).toExist(),
		);
	});
	it('explains server persistence and cross-browser private criteria', () => {
		Scene.scene(
			{ update, view },
			Scene.given({ ...ready(), panel: 'criteria' }),
			Scene.expect(
				Scene.text(/They follow this library across browsers/),
			).toExist(),
			Scene.expect(
				Scene.role('button', { name: 'Save criteria' }),
			).toBeEnabled(),
		);
		Scene.scene(
			{ update, view },
			Scene.given({ ...ready(), panel: 'classify' }),
			Scene.expect(
				Scene.text(
					/Classification continues on the server after this tab closes/,
				),
			).toExist(),
			Scene.expect(
				Scene.role('button', { name: 'Start classification' }),
			).toBeDisabled(),
		);
	});
	it.each(['failed', 'complete', 'cancelled'] as const)(
		'gates duplicate-charge recovery for %s jobs with unsuccessful games',
		(status) => {
			Scene.scene(
				{ update, view },
				Scene.given({
					...ready(),
					state: {
						...state,
						job: { ...job, status, error: null },
					},
				}),
				Scene.expect(
					Scene.text(new RegExp(`Classification ${status}`)),
				).toExist(),
				Scene.expect(
					Scene.role('button', { name: 'Clear uncertain paid lock' }),
				).toBeDisabled(),
			);
		},
	);
	it('requires consent for static memberships', () => {
		Scene.scene(
			{ update, view },
			Scene.given({ ...ready(), panel: 'steam-collections' }),
			Scene.expect(
				Scene.text(/Dynamic filters cannot be reconstructed/),
			).toExist(),
			Scene.expect(
				Scene.role('button', { name: 'Attach memberships' }),
			).toBeDisabled(),
		);
	});
});
