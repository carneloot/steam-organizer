import { it, expect } from '@effect/vitest';
import { Effect, Layer, Deferred, Exit, Fiber } from 'effect';

import { LibraryLayer } from '../../src/layers/library.js';
import { Classifier } from '../../src/services/classifier.js';
import { Steam } from '../../src/services/steam.js';
import { classifyOne, recover, unlocked, mutate } from './business.js';
import { authorize, readBody, HttpError } from './security.js';
import { type Env } from './services.js';
import { parseCollections, attachCollections } from './steam-collections.js';
import { initial, savedCriteria, Store, type Document } from './store.js';
import { reconcile } from './workflow.js';

it('reconciles queued claim-before-create and native termination, releasing failed creation', async () => {
	const db = fakeDb();
	const store = new Store(db, 'a@test');
	const claim = () =>
		Effect.runPromise(
			store.modify((s) => ({
				...s,
				job: {
					id: 'deterministic',
					status: 'queued',
					total: 0,
					completed: 0,
					current: null,
					error: null,
					steamId: null,
					ids: [],
					criteria: { Action: 'action' },
					cancel: false,
				},
			})),
		);
	const created: unknown[] = [];
	let status = 'queued';
	const binding = {
		create: async (input: unknown) => {
			created.push(input);
		},
		get: async () => ({ status: async () => ({ status }) }),
	};
	const env = { DB: db, CLASSIFICATION: binding } as unknown as Env;
	await claim();
	expect((await reconcile(env, 'a@test')).job?.status).toBe('queued');
	expect(created).toEqual([
		{ id: 'deterministic', params: { owner: 'a@test', id: 'deterministic' } },
	]);
	status = 'terminated';
	expect((await reconcile(env, 'a@test')).job?.status).toBe('failed');
	expect((await reconcile(env, 'b@test')).job).toBeUndefined();
	await claim();
	binding.create = async () => {
		throw new Error('start failed');
	};
	binding.get = async () => {
		throw new Error('missing');
	};
	expect((await reconcile(env, 'a@test')).job?.status).toBe('failed');
	const failed = (await Effect.runPromise(store.load())).state;
	expect(() => unlocked(failed)).not.toThrow();
});

const game = {
	appid: 1,
	name: 'Game',
	playtime_forever: 0,
	tags: ['Custom'],
	reviewed: false,
};
const library = { version: 1 as const, steamId: null, games: [game] };
const input = {
	appid: 1,
	requestId: 'request',
	criteria: { Action: 'action games' },
};
it.effect(
	'classify claims filtered saved snapshot, returns before charging, isolates active jobs and releases start failures',
	() =>
		Effect.gen(function* () {
			const db = fakeDb();
			const captured: { id: string; params: { owner: string; id: string } }[] =
				[];
			const binding = {
				create: async (value: (typeof captured)[number]) => {
					captured.push(value);
				},
				get: async () => {
					throw new Error('missing');
				},
			};
			const env = {
				DB: db,
				TYPESAFE_API_KEY: 'test',
				CLASSIFICATION: binding,
			} as unknown as Env;
			const store = new Store(db, 'owner');
			yield* store.modify((s) => ({
				...s,
				criteriaBySteamId: { offline: { Mine: 'saved' } },
				library: {
					...library,
					games: [
						game,
						{ ...game, appid: 2, name: 'Different' },
						{ ...game, appid: 3, reviewed: true },
					],
				},
			}));
			const layer = Layer.mergeAll(
				LibraryLayer,
				steamLayer,
				Layer.succeed(
					Classifier,
					Classifier.of({
						classifyGame: () => Effect.die('browser must not charge'),
					}),
				),
			);
			const run = (owner = 'owner') =>
				mutate(
					'/api/classify',
					{ steamId: null, search: 'game', category: 'Custom', all: false },
					env,
					owner,
				).pipe(Effect.provide(layer));
			const response = yield* run();
			expect(response.job?.status).toBe('queued');
			const claimed = (yield* store.load()).state.job!;
			expect(claimed.ids).toEqual([1]);
			expect(claimed.criteria).toEqual({ Mine: 'saved' });
			expect(captured[0]).toEqual({
				id: claimed.id,
				params: { owner: 'owner', id: claimed.id },
			});
			expect(Exit.isFailure(yield* Effect.exit(run()))).toBe(true);
			expect((yield* run('another')).job?.status).toBe('queued');
			yield* store.modify((s) => ({
				...s,
				job: { ...s.job!, status: 'cancelled' },
			}));
			binding.create = async () => {
				throw new Error('unavailable');
			};
			expect((yield* run()).job?.status).toBe('failed');
			const failed = (yield* store.load()).state;
			expect(() => unlocked(failed)).not.toThrow();
		}),
);
it.effect(
	'criteria follow owner and Steam account; stale tabs cannot save; jobs guard one owner but allow tags',
	() =>
		Effect.gen(function* () {
			const db = fakeDb();
			const env = { DB: db } as Env;
			const a = new Store(db, 'a@test'),
				b = new Store(db, 'b@test');
			const first = '76561198000000001',
				second = '76561198000000002';
			const layer = Layer.mergeAll(
				LibraryLayer,
				steamLayer,
				Layer.succeed(
					Classifier,
					Classifier.of({ classifyGame: () => Effect.succeed([]) }),
				),
			);
			const run = (path: string, body: unknown, owner = 'a@test') =>
				mutate(path, body, env, owner).pipe(Effect.provide(layer));
			yield* a.modify((s) => ({
				...s,
				library: { ...library, steamId: first },
			}));
			yield* b.modify((s) => ({
				...s,
				library: { ...library, steamId: first },
			}));
			yield* run('/api/criteria', {
				steamId: first,
				criteria: { Mine: 'first' },
			});
			yield* run(
				'/api/criteria',
				{ steamId: first, criteria: { Other: 'private' } },
				'b@test',
			);
			yield* run('/api/sync', { steamId: second, confirm: true });
			expect(
				Exit.isFailure(
					yield* Effect.exit(
						run('/api/criteria', {
							steamId: first,
							criteria: { Wrong: 'stale' },
						}),
					),
				),
			).toBe(true);
			yield* run('/api/criteria', {
				steamId: second,
				criteria: { Second: 'second' },
			});
			yield* run('/api/sync', { steamId: first, confirm: true });
			expect(savedCriteria((yield* a.load()).state)).toEqual({ Mine: 'first' });
			expect(savedCriteria((yield* b.load()).state)).toEqual({
				Other: 'private',
			});
			yield* a.modify((s) => ({
				...s,
				job: {
					id: 'job',
					status: 'running',
					total: 1,
					completed: 0,
					current: 'Game',
					error: null,
					steamId: first,
					ids: [1],
					criteria: savedCriteria(s),
					cancel: false,
				},
			}));
			for (const path of [
				'/api/criteria',
				'/api/import',
				'/api/restore',
				'/api/sync',
				'/api/classify/recover',
			])
				expect(
					Exit.isFailure(
						yield* Effect.exit(
							run(path, {
								steamId: first,
								criteria: { Mine: 'no' },
								text: JSON.stringify(library),
								confirm: true,
							}),
						),
					),
				).toBe(true);
			yield* run('/api/tags', { appid: 1, tags: ['Edited'] });
			expect((yield* a.load()).state.library.games[0]?.tags).toEqual([
				'Edited',
			]);
			yield* run(
				'/api/criteria',
				{ steamId: first, criteria: { Other: 'updated' } },
				'b@test',
			);
			yield* run('/api/jobs/cancel', {});
			expect((yield* a.load()).state.job?.cancel).toBe(true);
		}),
);
function fixture() {
	let state: Document = { ...initial(), library };
	const store: Pick<Store, 'load' | 'modify'> = {
		load: () => Effect.succeed({ state, revision: 0 }),
		modify: (f) =>
			Effect.try({
				try: () => {
					state = f(state);
					return state;
				},
				catch: (e) =>
					e instanceof HttpError ? e : new HttpError(500, 'save failed'),
			}),
	};
	return {
		store,
		get: () => state,
		set: (s: Document) => {
			state = s;
		},
	};
}
const steamLayer = Layer.succeed(
	Steam,
	Steam.of({
		fetchGameDescription: () => Effect.succeed('description'),
		fetchLibrary: () => Effect.succeed([game]),
	}),
);
function fakeDb(): D1Database {
	const rows = new Map<string, { document: string; revision: number }>();
	return {
		prepare: (sql: string) => {
			let values: unknown[] = [];
			return {
				bind(...args: unknown[]) {
					values = args;
					return this;
				},
				first: async () => rows.get(String(values[0])) ?? null,
				run: async () => {
					if (sql.startsWith('INSERT')) {
						const owner = String(values[0]);
						if (!rows.has(owner))
							rows.set(owner, { document: String(values[1]), revision: 0 });
					}
					if (sql.startsWith('UPDATE')) {
						const row = rows.get(String(values[1]));
						if (row && row.revision === values[2]) {
							row.document = String(values[0]);
							row.revision++;
							return { meta: { changes: 1 } };
						}
					}
					return { meta: { changes: 0 } };
				},
			};
		},
	} as unknown as D1Database;
}
it.effect(
	'concurrent same request charges once, preserves edits, and replays completed state',
	() =>
		Effect.gen(function* () {
			const f = fixture();
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			let calls = 0;
			const classifier = Layer.succeed(
				Classifier,
				Classifier.of({
					classifyGame: () =>
						Effect.gen(function* () {
							calls++;
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(release);
							return ['Action'];
						}),
				}),
			);
			const run = classifyOne(f.store, input).pipe(
				Effect.provide(Layer.merge(steamLayer, classifier)),
			);
			const first = yield* run.pipe(Effect.forkScoped);
			yield* Deferred.await(entered);
			expect(() => recover(f.get())).toThrow('active');
			expect(() => unlocked(f.get())).toThrow('active');
			expect(Exit.isFailure(yield* Effect.exit(run))).toBe(true);
			f.set({
				...f.get(),
				library: { ...library, games: [{ ...game, tags: ['Edited'] }] },
			});
			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(first);
			yield* run;
			expect(calls).toBe(1);
			expect(f.get().library.games[0]?.tags).toEqual(['Edited', 'Action']);
			expect(JSON.stringify(f.get())).not.toContain('action games');
		}),
);
it.effect(
	'unknown paid outcome blocks retries/import and supports consent recovery',
	() =>
		Effect.gen(function* () {
			const f = fixture();
			let calls = 0;
			const classifier = Layer.succeed(
				Classifier,
				Classifier.of({
					classifyGame: () =>
						Effect.sync(() => {
							calls++;
							throw new Error('secret provider detail');
						}),
				}),
			);
			const run = classifyOne(f.store, input).pipe(
				Effect.provide(Layer.merge(steamLayer, classifier)),
			);
			expect(Exit.isFailure(yield* Effect.exit(run))).toBe(true);
			expect(f.get().flight?.requestId).toBe('request');
			expect(Exit.isFailure(yield* Effect.exit(run))).toBe(true);
			expect(calls).toBe(1);
			expect(() => unlocked(f.get())).toThrow('uncertain');
			expect(recover(f.get()).flight).toBe(null);
		}),
);
it.effect('saved paid result applies without provider call', () =>
	Effect.gen(function* () {
		const f = fixture();
		f.set({
			...f.get(),
			flight: { requestId: 'request', appid: 1 },
			result: { requestId: 'request', appid: 1, tags: ['RPG'] },
		});
		const classifier = Layer.succeed(
			Classifier,
			Classifier.of({ classifyGame: () => Effect.die('must not charge') }),
		);
		yield* classifyOne(f.store, input).pipe(
			Effect.provide(Layer.merge(steamLayer, classifier)),
		);
		expect(f.get().library.games[0]?.tags).toEqual(['Custom', 'RPG']);
	}),
);
it.effect(
	'D1 owner isolation and CLI import preserve tags/reviewed, ignoring categories',
	() =>
		Effect.gen(function* () {
			const db = fakeDb();
			const env = { DB: db } as Env;
			const text = JSON.stringify({
				...library,
				games: [{ ...game, reviewed: true, categories: ['ignored'] }],
			});
			yield* mutate('/api/import', { text, confirm: true }, env, 'a@test').pipe(
				Effect.provide(
					Layer.mergeAll(
						LibraryLayer,
						steamLayer,
						Layer.succeed(
							Classifier,
							Classifier.of({ classifyGame: () => Effect.succeed([]) }),
						),
					),
				),
			);
			const a = (yield* new Store(db, 'a@test').load()).state;
			const b = (yield* new Store(db, 'b@test').load()).state;
			expect(a.library.games[0]).toEqual({ ...game, reviewed: true });
			expect(b.library.games).toEqual([]);
			yield* new Store(db, 'b@test').modify((s) => ({
				...s,
				flight: { requestId: 'b', appid: 2 },
			}));
			expect((yield* new Store(db, 'a@test').load()).state.flight).toBe(null);
		}),
);
it('imports added-minus-removed static membership, excludes dynamic/deleted/unrelated', () => {
	const text = JSON.stringify([
		['unrelated', null],
		['user-collections.deleted', { is_deleted: true, value: 'bad' }],
		[
			'user-collections.static',
			{
				value: JSON.stringify({
					name: ' Favorite ',
					added: [1, 2, 3],
					removed: [2],
				}),
			},
		],
		[
			'user-collections.dynamic',
			{
				value: JSON.stringify({ name: 'Dynamic', added: [1], filterSpec: {} }),
			},
		],
	]);
	expect(parseCollections(text)).toEqual([
		{ name: 'Favorite', appids: [1, 3] },
	]);
	expect(
		attachCollections(library, parseCollections(text)).games[0]?.tags,
	).toEqual(['Custom', 'Favorite']);
	for (const value of [
		'bad',
		JSON.stringify({ name: ' ', added: [1] }),
		JSON.stringify({ name: 'x', added: ['1'] }),
	])
		expect(() =>
			parseCollections(JSON.stringify([['user-collections.x', { value }]])),
		).toThrow();
});
it('accepts any verified Access email normalized but never a raw header', async () => {
	expect(
		await authorize(
			new Request('https://app.test'),
			{},
			{ access: { getIdentity: async () => ({ email: ' Friend@Test ' }) } },
		),
	).toBe('friend@test');
	await expect(
		authorize(
			new Request('https://app.test', {
				headers: { 'cf-access-authenticated-user-email': 'friend@test' },
			}),
			{},
			{},
		),
	).rejects.toThrow();
	expect(
		await authorize(new Request('http://localhost'), { LOCAL_DEV: 'true' }, {}),
	).toBe('local@example.test');
	await expect(
		authorize(new Request('https://app.test'), { LOCAL_DEV: 'true' }, {}),
	).rejects.toThrow();
});
it('retains same-origin CSRF checks', async () => {
	await expect(
		readBody(
			new Request('https://app.test/api/import', {
				method: 'POST',
				headers: {
					origin: 'https://evil.test',
					'content-type': 'application/json',
					'x-requested-with': 'steam-organizer',
				},
				body: '{}',
			}),
		),
	).rejects.toThrow();
});
it.effect(
	'a failed apply retains the paid checkpoint and retries without charging',
	() =>
		Effect.gen(function* () {
			const f = fixture();
			let writes = 0,
				calls = 0;
			const store: Pick<Store, 'load' | 'modify'> = {
				load: f.store.load,
				modify: (update) =>
					Effect.suspend(() =>
						++writes === 3
							? Effect.fail(new HttpError(503, 'save failed'))
							: f.store.modify(update),
					),
			};
			const classifier = Layer.succeed(
				Classifier,
				Classifier.of({
					classifyGame: () =>
						Effect.sync(() => {
							calls++;
							return ['Action'];
						}),
				}),
			);
			const run = classifyOne(store, input).pipe(
				Effect.provide(Layer.merge(steamLayer, classifier)),
			);
			expect(Exit.isFailure(yield* Effect.exit(run))).toBe(true);
			expect(f.get().result?.tags).toEqual(['Action']);
			yield* run;
			expect(calls).toBe(1);
			expect(f.get().completed?.requestId).toBe(input.requestId);
		}),
);
it.effect('D1 CAS admits one concurrent paid claim per owner', () =>
	Effect.gen(function* () {
		const db = fakeDb();
		const store = new Store(db, 'a@test');
		const claim = (requestId: string) =>
			Effect.exit(
				store.modify((s) => ({
					...unlocked(s),
					flight: { requestId, appid: 1 },
				})),
			);
		const exits = yield* Effect.all([claim('one'), claim('two')], {
			concurrency: 'unbounded',
		});
		expect(exits.filter(Exit.isSuccess)).toHaveLength(1);
		expect(exits.filter(Exit.isFailure)).toHaveLength(1);
	}),
);
it.effect(
	'imports require confirmation, guard active/uncertain paid flights, and switch accounts without old tags',
	() =>
		Effect.gen(function* () {
			const db = fakeDb();
			const env = { DB: db } as Env;
			const store = new Store(db, 'a@test');
			const layer = Layer.mergeAll(
				LibraryLayer,
				steamLayer,
				Layer.succeed(
					Classifier,
					Classifier.of({ classifyGame: () => Effect.succeed([]) }),
				),
			);
			const run = (path: string, body: unknown) =>
				mutate(path, body, env, 'a@test').pipe(Effect.provide(layer));
			yield* store.modify((s) => ({
				...s,
				library: { ...library, steamId: '76561198000000001' },
			}));
			expect(
				Exit.isFailure(
					yield* Effect.exit(
						run('/api/import', { text: '[]', confirm: false }),
					),
				),
			).toBe(true);
			yield* run('/api/sync', { steamId: '76561198000000002', confirm: true });
			expect((yield* store.load()).state.library.games[0]?.tags).toEqual([]);
			yield* store.modify((s) => ({
				...s,
				flight: { requestId: 'paid', appid: 1 },
				operation: { id: 'lease', expiresAt: Date.now() + 120000 },
			}));
			for (const path of ['/api/import', '/api/sync', '/api/classify/recover'])
				expect(
					Exit.isFailure(
						yield* Effect.exit(
							run(path, {
								text: '[]',
								steamId: '76561198000000002',
								confirm: true,
							}),
						),
					),
				).toBe(true);
			yield* store.modify((s) => ({ ...s, operation: null }));
			expect(
				Exit.isFailure(
					yield* Effect.exit(run('/api/import', { text: '[]', confirm: true })),
				),
			).toBe(true);
			yield* run('/api/classify/recover', { confirm: true });
			yield* run('/api/import', {
				text: JSON.stringify({ response: { games: [game] } }),
				confirm: true,
			});
			yield* run('/api/steam-collections', {
				text: JSON.stringify([
					[
						'user-collections.x',
						{ value: JSON.stringify({ name: 'Static', added: [1, 99] }) },
					],
				]),
				confirm: true,
			});
			expect((yield* store.load()).state.library.games[0]?.tags).toEqual([
				'Static',
			]);
		}),
);
