import { expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';

import { initial, Store, type Document, type PaidState } from './store.js';
import { testDb } from './test-db.js';

const games = [
	{
		appid: 620,
		name: 'Portal 2',
		playtime_forever: 401,
		playtime_2weeks: 0,
		tags: ['Custom'],
		reviewed: true,
	},
	{ appid: 9, name: 'Nine', playtime_forever: 0, tags: [], reviewed: false },
] as const;
const job = {
	id: 'job',
	status: 'running' as const,
	total: 2,
	completed: 0,
	current: 'Portal 2',
	error: null,
	steamId: null,
	ids: [620, 9],
	criteria: { Puzzle: 'Puzzles' },
	cancel: false,
};
const emptyPaid: PaidState = {
	operation: null,
	flight: null,
	result: null,
	completed: null,
};
const legacy: Document = {
	...initial(),
	library: { version: 1, steamId: '76561198000000001', games },
	job,
	criteriaBySteamId: {
		offline: { Offline: 'Local' },
		'76561198000000001': { Puzzle: 'Saved definition' },
	},
	operation: { id: 'lease', expiresAt: 123456 },
	flight: { requestId: 'paid', appid: 620 },
	result: { requestId: 'paid', appid: 620, tags: ['Puzzle'] },
	completed: { requestId: 'earlier', appid: 9 },
};
const concurrent: Document = {
	...initial(),
	library: { version: 1, steamId: null, games: [games[1], games[0]] },
	job: { ...job, completed: 1, cancel: true, error: 'Interrupted' },
	requests: {
		'job:0': { ...emptyPaid, completed: { requestId: 'job:0', appid: 620 } },
		'job:1': {
			...emptyPaid,
			flight: { requestId: 'job:1', appid: 9 },
			result: { requestId: 'job:1', appid: 9, tags: ['Saved'] },
		},
		uncertain: {
			...emptyPaid,
			operation: { id: 'other-lease', expiresAt: 999999 },
			flight: { requestId: 'uncertain', appid: 9 },
		},
	},
};

it.effect(
	'round-trips state fields, order, owners and absent versus empty ledgers',
	() =>
		Effect.gen(function* () {
			const { db, sqlite } = testDb();
			const documents = {
				legacy,
				concurrent,
				empty: { ...initial(), job: null, requests: {}, criteriaBySteamId: {} },
				absent: initial(),
			};
			for (const [owner, document] of Object.entries(documents)) {
				yield* new Store(db, owner).modify(() => document);
			}
			for (const [owner, state] of Object.entries(documents)) {
				expect(yield* new Store(db, owner).load()).toEqual({
					revision: 1,
					state,
				});
			}
			expect(
				sqlite
					.prepare(
						'SELECT owner,appid,position FROM library_games ORDER BY owner,position',
					)
					.all(),
			).toEqual([
				{ owner: 'concurrent', appid: 9, position: 0 },
				{ owner: 'concurrent', appid: 620, position: 1 },
				{ owner: 'legacy', appid: 620, position: 0 },
				{ owner: 'legacy', appid: 9, position: 1 },
			]);
		}),
);

it.effect(
	'a tag edit writes only that game; job and lease updates do not rewrite games',
	() =>
		Effect.gen(function* () {
			const { db, sqlite } = testDb();
			const store = new Store(db, 'owner');
			yield* store.modify(() => concurrent);
			sqlite.exec(`CREATE TABLE writes (appid INTEGER);
			CREATE TRIGGER track_games AFTER UPDATE ON library_games BEGIN INSERT INTO writes VALUES(new.appid); END;`);
			yield* store.modify((state) => ({
				...state,
				library: {
					...state.library,
					games: state.library.games.map((game) =>
						game.appid === 9 ? { ...game, tags: ['Edited'] } : game,
					),
				},
			}));
			yield* store.modify((state) => ({
				...state,
				job: { ...job, completed: 2 },
				operation: { id: 'claim', expiresAt: 123 },
			}));
			expect(sqlite.prepare('SELECT appid FROM writes').all()).toEqual([
				{ appid: 9 },
			]);
			expect((yield* store.load()).state.library.games).toEqual([
				{ ...games[1], tags: ['Edited'] },
				games[0],
			]);
		}),
);

it.effect(
	'concurrent completions retry stale batches without losing tags, job counts or request markers',
	() =>
		Effect.gen(function* () {
			const { db } = testDb();
			const store = new Store(db, 'owner');
			yield* store.modify(() => ({
				...initial(),
				library: { version: 1, steamId: null, games },
				job,
				requests: {},
			}));
			let updates = 0;
			yield* Effect.forEach(
				[620, 9],
				(appid) =>
					store.modify((state) => {
						updates++;
						return {
							...state,
							library: {
								...state.library,
								games: state.library.games.map((game) =>
									game.appid === appid
										? {
												...game,
												tags: [...game.tags, `Tag ${appid}`],
												reviewed: true,
											}
										: game,
								),
							},
							job: { ...job, completed: (state.job?.completed ?? 0) + 1 },
							requests: {
								...state.requests,
								[`job:${appid}`]: {
									...emptyPaid,
									completed: { requestId: `job:${appid}`, appid },
								},
							},
						};
					}),
				{ concurrency: 'unbounded' },
			);
			const { state, revision } = yield* store.load();
			expect(updates).toBeGreaterThan(2);
			expect(revision).toBe(3);
			expect(state.library.games.map((game) => game.tags)).toEqual([
				['Custom', 'Tag 620'],
				['Tag 9'],
			]);
			expect(state.job?.completed).toBe(2);
			expect(state.requests).toEqual({
				'job:620': {
					...emptyPaid,
					completed: { requestId: 'job:620', appid: 620 },
				},
				'job:9': { ...emptyPaid, completed: { requestId: 'job:9', appid: 9 } },
			});
		}),
);

it.effect(
	'failed job persistence rolls back earlier game writes and retains paid results',
	() =>
		Effect.gen(function* () {
			const { db, sqlite } = testDb();
			const store = new Store(db, 'owner');
			yield* store.modify(() => concurrent);
			const before = yield* store.load();
			sqlite.exec(
				`CREATE TRIGGER fail_job BEFORE UPDATE ON classification_jobs BEGIN SELECT RAISE(ABORT,'injected failure'); END;`,
			);
			const apply = store.modify((state) => ({
				...state,
				library: {
					...state.library,
					games: [{ ...games[1], tags: ['Applied'], reviewed: true }, games[0]],
				},
				job: { ...job, completed: 2 },
				requests: {
					'job:1': {
						...emptyPaid,
						completed: { requestId: 'job:1', appid: 9 },
					},
				},
			}));
			expect(Exit.isFailure(yield* Effect.exit(apply))).toBe(true);
			expect(yield* store.load()).toEqual(before);
			sqlite.exec('DROP TRIGGER fail_job');
			yield* apply;
			expect((yield* store.load()).state).toMatchObject({
				job: { completed: 2 },
				requests: { 'job:1': { result: null, completed: { appid: 9 } } },
			});
		}),
);

it.effect(
	'large replacements remove obsolete rows, preserve order and isolate owners',
	() =>
		Effect.gen(function* () {
			const { db, sqlite } = testDb();
			const store = new Store(db, 'owner');
			yield* store.modify(() => ({
				...concurrent,
				criteriaBySteamId: { offline: { Old: 'Replaced' } },
			}));
			yield* new Store(db, 'other').modify(() => legacy);
			const replacement: Document = {
				...initial(),
				job: null,
				requests: {},
				criteriaBySteamId: {},
				library: {
					version: 1,
					steamId: '76561198000000002',
					games: Array.from({ length: 1500 }, (_, index) => ({
						...games[1],
						appid: 2000 - index,
						name: `Game ${index}`,
					})),
				},
			};
			yield* store.modify(() => replacement);
			expect((yield* store.load()).state).toEqual(replacement);
			expect((yield* new Store(db, 'other').load()).state).toEqual(legacy);
			expect(
				sqlite
					.prepare(
						"SELECT count(*) AS count FROM classification_requests WHERE owner='owner'",
					)
					.get(),
			).toEqual({ count: 0 });
			expect(
				sqlite
					.prepare(
						"SELECT count(*) AS count FROM classification_jobs WHERE owner='owner'",
					)
					.get(),
			).toEqual({ count: 0 });
			yield* store.modify(() => initial());
			expect((yield* store.load()).state).toEqual(initial());
		}),
);

it('D1 initializes the schema and atomically rolls back multi-table failures', async () => {
	const runtime = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: 'export default { fetch() { return new Response("ok") } }',
			compatibilityDate: '2026-10-07',
			d1Databases: ['DB'],
		}),
	);
	try {
		const db = await runtime.getD1Database('DB');
		const sql = await readFile('web/migrations/0001_state.sql', 'utf8');
		await db.batch(
			sql
				.split(';')
				.filter((sql) => sql.trim())
				.map((sql) => db.prepare(sql)),
		);
		const store = new Store(db as unknown as D1Database, 'concurrent');
		await Effect.runPromise(store.modify(() => concurrent));
		await Effect.runPromise(
			new Store(db as unknown as D1Database, 'legacy').modify(() => legacy),
		);
		expect(await Effect.runPromise(store.load())).toEqual({
			revision: 1,
			state: concurrent,
		});
		expect(
			(
				await Effect.runPromise(
					new Store(db as unknown as D1Database, 'legacy').load(),
				)
			).state,
		).toEqual(legacy);
		await db
			.prepare(
				`CREATE TRIGGER fail_metadata BEFORE UPDATE ON libraries BEGIN SELECT RAISE(ABORT,'injected failure'); END`,
			)
			.run();
		await expect(
			Effect.runPromise(store.modify(() => legacy)),
		).rejects.toThrow();
		expect(await Effect.runPromise(store.load())).toEqual({
			revision: 1,
			state: concurrent,
		});
		await db.prepare('DROP TRIGGER fail_metadata').run();
		await Effect.runPromise(store.modify(() => legacy));
		expect(await Effect.runPromise(store.load())).toEqual({
			revision: 2,
			state: legacy,
		});
	} finally {
		await runtime.dispose();
	}
}, 30_000);
