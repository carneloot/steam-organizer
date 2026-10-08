import { NodeCrypto } from '@effect/platform-node';
import { it, expect } from '@effect/vitest';
import { Effect, Layer, Deferred, Exit, Fiber, Schema } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { vi } from 'vitest';

import { LibraryLayer } from '../../src/layers/library.js';
import { Classifier } from '../../src/services/classifier.js';
import { Steam } from '../../src/services/steam.js';
import { AppState } from '../shared.js';
import { apiHandler } from './api.js';
import { classifyOne } from './business.js';
import { authorize, readBody, HttpError } from './security.js';
import { type Env } from './services.js';
import { parseCollections, attachCollections } from './steam-collections.js';
import { Store } from './store.js';
import { seedLibrary, testDb, testStore } from './test-db.js';
import { reconcile } from './workflow.js';

const mutate = Effect.fnUntraced(function* (
	path: string,
	body: unknown,
	env: Env,
	owner: string,
) {
	const request = new Request(`http://localhost${path}`, {
		method: 'POST',
		headers: {
			origin: 'http://localhost',
			'content-type': 'application/json',
			'x-requested-with': 'steam-organizer',
		},
		body: JSON.stringify(body),
	});
	const response = yield* apiHandler(env, owner).pipe(
		Effect.provideService(
			HttpServerRequest.HttpServerRequest,
			HttpServerRequest.fromWeb(request),
		),
	);
	const text = yield* Effect.promise(() =>
		HttpServerResponse.toWeb(response).text(),
	);
	return yield* Schema.decodeEffect(Schema.fromJsonString(AppState))(text);
});
const game = {
	appid: 1,
	name: 'Game',
	playtime_forever: 0,
	tags: ['Custom'],
	reviewed: false,
};
const library = { version: 1 as const, steamId: null, games: [game] };
const selection = { steamId: null, search: '', category: '', all: true };
const input = {
	jobId: 'job',
	index: 0,
	appid: 1,
	criteria: { Action: 'action games' },
};
const steamLayer = Layer.merge(
	NodeCrypto.layer,
	Layer.succeed(
		Steam,
		Steam.of({
			fetchGameDescription: () => Effect.succeed('description'),
			fetchLibrary: () => Effect.succeed([game]),
		}),
	),
);
const apiLayer = Layer.mergeAll(
	LibraryLayer,
	steamLayer,
	Layer.succeed(
		Classifier,
		Classifier.of({
			classifyGame: () => Effect.die('browser must not charge'),
		}),
	),
);
const fixture = Effect.fnUntraced(function* (ids: number[] = [1]) {
	const { db, sqlite, queries } = testDb();
	const store = yield* testStore(db, 'owner');
	yield* seedLibrary(store, {
		...library,
		games: ids.map((appid) => ({ ...game, appid })),
	});
	yield* store.startJob('job', selection);
	return { store, db, sqlite, queries };
});

it('reconciles queued claims and native termination without reading any games', async () => {
	const { db } = testDb();
	const store = await Effect.runPromise(testStore(db, 'owner'));
	const created: unknown[] = [];
	let status = 'queued';
	const binding = {
		create: async (value: unknown) => {
			created.push(value);
		},
		get: async () => ({ status: async () => ({ status }) }),
	};
	const env = { DB: db, CLASSIFICATION: binding } as unknown as Env;
	await Effect.runPromise(store.startJob('job', selection));
	const prepare = vi.spyOn(db, 'prepare');
	await Effect.runPromise(
		reconcile(env, 'owner').pipe(Effect.provideService(Store, store)),
	);
	expect(prepare.mock.calls.map(([sql]) => sql).join('\n')).not.toContain(
		'library_games',
	);
	prepare.mockRestore();
	expect((await Effect.runPromise(store.getJob()))?.status).toBe('queued');
	expect(created).toEqual([
		{ id: 'job', params: { owner: 'owner', id: 'job' } },
	]);
	status = 'terminated';
	await Effect.runPromise(
		reconcile(env, 'owner').pipe(Effect.provideService(Store, store)),
	);
	expect((await Effect.runPromise(store.getJob()))?.status).toBe('failed');
	const other = await Effect.runPromise(testStore(db, 'other'));
	await Effect.runPromise(
		reconcile(env, 'other').pipe(Effect.provideService(Store, other)),
	);
	expect(await Effect.runPromise(other.getJob())).toBeNull();
	await Effect.runPromise(store.startJob('next', selection));
	binding.create = async () => {
		throw new Error('start failed');
	};
	binding.get = async () => {
		throw new Error('missing');
	};
	await Effect.runPromise(
		reconcile(env, 'owner').pipe(Effect.provideService(Store, store)),
	);
	expect((await Effect.runPromise(store.getJob()))?.status).toBe('failed');
	await Effect.runPromise(store.claimLibrary('unlocked'));
});

it.effect(
	'classify claims the filtered saved snapshot, returns before charging and releases start failures',
	() =>
		Effect.gen(function* () {
			const { db } = testDb();
			const store = yield* testStore(db, 'owner');
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
			yield* seedLibrary(store, {
				...library,
				games: [
					game,
					{ ...game, appid: 2, name: 'Different' },
					{ ...game, appid: 3, reviewed: true },
				],
			});
			yield* store.saveCriteria({ steamId: null, criteria: { Mine: 'saved' } });
			const run = (owner = 'owner') =>
				mutate(
					'/api/classify',
					{ steamId: null, search: 'game', category: 'Custom', all: false },
					env,
					owner,
				).pipe(Effect.provide(apiLayer));
			expect((yield* run()).job?.status).toBe('queued');
			const job = (yield* store.getJob())!;
			expect(job.ids).toEqual([1]);
			expect(job.criteria).toEqual({ Mine: 'saved' });
			expect(captured[0]).toEqual({
				id: job.id,
				params: { owner: 'owner', id: job.id },
			});
			expect(Exit.isFailure(yield* Effect.exit(run()))).toBe(true);
			expect((yield* run('other')).job?.status).toBe('queued');
			yield* store.cancelJob();
			yield* store.finishJob(job.id);
			binding.create = async () => {
				throw new Error('unavailable');
			};
			expect((yield* run()).job?.status).toBe('failed');
			yield* store.claimLibrary('unlocked');
		}),
);

it.effect(
	'criteria follow owner and account; stale tabs cannot save; active jobs block replacement but allow tag edits',
	() =>
		Effect.gen(function* () {
			const { db } = testDb();
			const env = { DB: db } as Env;
			const owner = yield* testStore(db, 'owner');
			const other = yield* testStore(db, 'other');
			const first = '76561198000000001',
				second = '76561198000000002';
			const run = (path: string, body: unknown, identity = 'owner') =>
				mutate(path, body, env, identity).pipe(Effect.provide(apiLayer));
			yield* seedLibrary(owner, { ...library, steamId: first });
			yield* seedLibrary(other, { ...library, steamId: first });
			yield* run('/api/criteria', {
				steamId: first,
				criteria: { Mine: 'first' },
			});
			yield* run(
				'/api/criteria',
				{ steamId: first, criteria: { Other: 'private' } },
				'other',
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
			expect((yield* owner.getView()).criteria).toEqual({ Mine: 'first' });
			expect((yield* other.getView()).criteria).toEqual({ Other: 'private' });
			yield* owner.startJob('job', { ...selection, steamId: first });
			for (const path of [
				'/api/criteria',
				'/api/import',
				'/api/restore',
				'/api/sync',
				'/api/steam-collections',
				'/api/classify/recover',
			]) {
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
			}
			yield* Effect.all(
				[
					run('/api/tags', { appid: 1, tags: ['Edited'] }),
					run('/api/tags', { appid: 1, tags: ['Other edit'] }, 'other'),
				],
				{ concurrency: 'unbounded' },
			);
			expect((yield* owner.getGame(1))?.game.tags).toEqual(['Edited']);
			expect((yield* other.getGame(1))?.game.tags).toEqual(['Other edit']);
			yield* run(
				'/api/criteria',
				{ steamId: first, criteria: { Other: 'updated' } },
				'other',
			);
			yield* run('/api/jobs/cancel', {});
			expect((yield* owner.getJob())?.cancel).toBe(true);
		}),
);

it.effect(
	'competing calls charge once, preserve edits and replay completed requests without reading games',
	() =>
		Effect.gen(function* () {
			const { store, queries } = yield* fixture();
			const entered = yield* Deferred.make<void>(),
				release = yield* Deferred.make<void>();
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
			const run = classifyOne(input).pipe(
				Effect.provideService(Store, store),
				Effect.provide(Layer.merge(steamLayer, classifier)),
			);
			const first = yield* run.pipe(Effect.forkScoped);
			yield* Deferred.await(entered);
			expect(
				Exit.isFailure(yield* Effect.exit(store.recoverRequests('recover'))),
			).toBe(true);
			expect(Exit.isFailure(yield* Effect.exit(run))).toBe(true);
			yield* store.saveTags({ appid: 1, tags: ['Edited'] });
			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(first);
			expect((yield* store.getGame(1))?.game.tags).toEqual([
				'Edited',
				'Action',
			]);
			yield* store.saveTags({ appid: 1, tags: ['After completion'] });
			queries.length = 0;
			yield* run;
			expect(queries).toHaveLength(1);
			expect(queries[0]).toContain('classification_requests');
			expect(calls).toBe(1);
			expect((yield* store.getGame(1))?.game.tags).toEqual([
				'After completion',
			]);
			expect((yield* store.getJob())?.completed).toBe(1);
		}),
);

it.effect(
	'cancellation during description lookup prevents the atomic paid claim',
	() =>
		Effect.gen(function* () {
			const { store } = yield* fixture();
			const entered = yield* Deferred.make<void>(),
				release = yield* Deferred.make<void>();
			const steam = Layer.succeed(
				Steam,
				Steam.of({
					fetchLibrary: () => Effect.succeed([game]),
					fetchGameDescription: () =>
						Effect.gen(function* () {
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(release);
							return 'description';
						}),
				}),
			);
			const running = yield* classifyOne(input).pipe(
				Effect.provideService(Store, store),
				Effect.provide(
					Layer.mergeAll(
						NodeCrypto.layer,
						steam,
						Layer.succeed(
							Classifier,
							Classifier.of({
								classifyGame: () => Effect.die('must not charge'),
							}),
						),
					),
				),
				Effect.forkScoped,
			);
			yield* Deferred.await(entered);
			yield* store.cancelJob();
			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(running);
			expect(yield* store.getRequest('job:0')).toBeNull();
			expect((yield* store.getJob())?.completed).toBe(0);
		}),
);

it.effect(
	'a failed apply retains the checkpoint and retries without a second provider call',
	() =>
		Effect.gen(function* () {
			const { store, sqlite } = yield* fixture();
			let calls = 0;
			sqlite.exec(
				"CREATE TRIGGER fail_job BEFORE UPDATE ON classification_jobs BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
			);
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
			const run = classifyOne(input).pipe(
				Effect.provideService(Store, store),
				Effect.provide(Layer.merge(steamLayer, classifier)),
			);
			expect(Exit.isFailure(yield* Effect.exit(run))).toBe(true);
			expect(yield* store.getRequest('job:0')).toMatchObject({
				tags: ['Action'],
				completed: false,
				operationId: null,
			});
			expect((yield* store.getGame(1))?.game.tags).toEqual(['Custom']);
			sqlite.exec('DROP TRIGGER fail_job');
			yield* run;
			expect(calls).toBe(1);
			expect(yield* store.getRequest('job:0')).toMatchObject({
				tags: null,
				completed: true,
			});
		}),
);

it.effect(
	'unknown outcomes block retry, import and new jobs until confirmed recovery',
	() =>
		Effect.gen(function* () {
			const { store, db } = yield* fixture();
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
			const run = classifyOne(input).pipe(
				Effect.provideService(Store, store),
				Effect.provide(Layer.merge(steamLayer, classifier)),
			);
			expect(Exit.isFailure(yield* Effect.exit(run))).toBe(true);
			expect(Exit.isFailure(yield* Effect.exit(run))).toBe(true);
			expect(calls).toBe(1);
			expect(yield* store.getRequest('job:0')).toMatchObject({
				appid: 1,
				tags: null,
				completed: false,
				operationId: null,
			});
			yield* store.failJob('job', 'Stopped');
			const env = { DB: db } as Env;
			for (const [path, body] of [
				['/api/import', { text: '[]', confirm: true }],
				['/api/classify/recover', { confirm: false }],
			] as const)
				expect(
					Exit.isFailure(
						yield* Effect.exit(
							mutate(path, body, env, 'owner').pipe(Effect.provide(apiLayer)),
						),
					),
				).toBe(true);
			expect(
				Exit.isFailure(yield* Effect.exit(store.startJob('new', selection))),
			).toBe(true);
			yield* mutate(
				'/api/classify/recover',
				{ confirm: true },
				env,
				'owner',
			).pipe(Effect.provide(apiLayer));
			expect(yield* store.getRequest('job:0')).toBeNull();
			yield* store.startJob('new', selection);
		}),
);

it.effect(
	'a request ID cannot be reused for a different game or an unselected index',
	() =>
		Effect.gen(function* () {
			const { store } = yield* fixture([1, 2]);
			const classifier = Layer.succeed(
				Classifier,
				Classifier.of({ classifyGame: () => Effect.succeed(['Action']) }),
			);
			yield* classifyOne(input).pipe(
				Effect.provideService(Store, store),
				Effect.provide(Layer.merge(steamLayer, classifier)),
			);
			for (const changed of [
				{ ...input, appid: 2 },
				{ ...input, index: 2 },
			]) {
				expect(
					Exit.isFailure(
						yield* Effect.exit(
							classifyOne(changed).pipe(
								Effect.provideService(Store, store),
								Effect.provide(apiLayer),
							),
						),
					),
				).toBe(true);
			}
			expect((yield* store.getJob())?.completed).toBe(1);
		}),
);

it.effect(
	'CLI imports preserve reviewed tags and ignore derived categories; account switches and collections stay isolated',
	() =>
		Effect.gen(function* () {
			const { db } = testDb();
			const env = { DB: db } as Env;
			const store = yield* testStore(db, 'owner');
			const run = (path: string, body: unknown) =>
				mutate(path, body, env, 'owner').pipe(Effect.provide(apiLayer));
			expect(
				Exit.isFailure(
					yield* Effect.exit(
						run('/api/import', { text: '[]', confirm: false }),
					),
				),
			).toBe(true);
			yield* run('/api/import', {
				text: JSON.stringify({
					...library,
					steamId: '76561198000000001',
					games: [{ ...game, reviewed: true, categories: ['ignored'] }],
				}),
				confirm: true,
			});
			expect((yield* store.getGame(1))?.game).toEqual({
				...game,
				reviewed: true,
			});
			expect(
				(yield* (yield* testStore(db, 'other')).getLibrary()).games,
			).toEqual([]);
			yield* run('/api/sync', { steamId: '76561198000000002', confirm: true });
			expect((yield* store.getGame(1))?.game.tags).toEqual([]);
			yield* run('/api/steam-collections', {
				text: JSON.stringify([
					[
						'user-collections.x',
						{ value: JSON.stringify({ name: 'Static', added: [1, 99] }) },
					],
				]),
				confirm: true,
			});
			expect((yield* store.getGame(1))?.game.tags).toEqual(['Static']);
		}),
);

it('imports added-minus-removed static membership and excludes dynamic/deleted/unrelated collections', () => {
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
it('accepts verified normalized Access email but never a raw header', async () => {
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
	).rejects.toThrow(HttpError);
});
