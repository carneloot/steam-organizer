import { expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { vi } from 'vitest';

import { Store } from './store.js';
import { seedLibrary, testDb, testStore } from './test-db.js';

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
const library = { version: 1 as const, steamId: null, games };
const selection = { steamId: null, search: '', category: '', all: true };
const claim = (store: Store['Service'], index: number) => {
	const game = games[index === 0 ? 1 : 0];
	return store.claimRequest({
		jobId: 'job',
		index,
		appid: game.appid,
		name: game.name,
		steamId: null,
		operationId: `lease-${index}`,
	});
};
const fixture = Effect.fnUntraced(function* () {
	const { db, sqlite, queries } = testDb();
	const store = yield* testStore(db, 'owner');
	yield* seedLibrary(store, library);
	yield* store.saveCriteria({ steamId: null, criteria: { Puzzle: 'Puzzles' } });
	yield* store.startJob('job', selection);
	return { db, sqlite, store, queries };
});

it.effect(
	'round-trips ordered games and job snapshots without legacy bookkeeping',
	() =>
		Effect.gen(function* () {
			const { store, db, sqlite } = yield* fixture();
			expect(yield* store.getLibrary()).toEqual(library);
			expect(yield* store.getGame(620)).toEqual({
				game: games[0],
				steamId: null,
			});
			expect(yield* store.getGame(999)).toBeNull();
			expect(yield* store.getJob()).toEqual({
				id: 'job',
				status: 'queued',
				total: 2,
				completed: 0,
				current: null,
				error: null,
				steamId: null,
				ids: [9, 620],
				criteria: { Puzzle: 'Puzzles' },
				cancel: false,
			});
			expect(yield* store.getRequest('job:0')).toBeNull();
			expect(
				(yield* (yield* testStore(db, 'other')).getView()).library.games,
			).toEqual([]);
			expect(
				sqlite.prepare('SELECT count(*) AS count FROM library_games').get(),
			).toEqual({ count: 2 });
		}),
);

it.effect(
	'screen and library reads omit the ledger; narrow mutations never load the library',
	() =>
		Effect.gen(function* () {
			const { store, queries } = yield* fixture();
			queries.length = 0;
			yield* store.getView();
			expect(queries).toHaveLength(4);
			expect(queries.join('\n')).not.toContain('classification_requests');
			queries.length = 0;
			yield* store.getLibrary();
			expect(queries).toHaveLength(2);
			expect(queries.join('\n')).not.toMatch(
				/classification_|category_criteria/,
			);
			queries.length = 0;
			yield* store.saveTags({ appid: 9, tags: ['Manual'] });
			expect(queries).toHaveLength(2);
			expect(queries.every((sql) => sql.startsWith('UPDATE'))).toBe(true);
			queries.length = 0;
			yield* store.cancelJob();
			expect(queries).toHaveLength(1);
			expect(queries[0]).toContain('UPDATE classification_jobs');
		}),
);

it.effect(
	'composed SQL fragments bind quoted values without leaking across owners',
	() =>
		Effect.gen(function* () {
			const { db } = testDb();
			const owner = "owner' OR 1=1 --";
			const id = "job'); DELETE FROM classification_requests; --";
			const name = "Nine'); DELETE FROM library_games; --";
			const tag = "Puzzle'); UPDATE libraries SET revision=0; --";
			const store = yield* testStore(db, owner);
			const other = yield* testStore(db, 'other');
			const prepare = vi.spyOn(db, 'prepare');
			yield* seedLibrary(other, library);
			yield* seedLibrary(store, { ...library, games: [{ ...games[1], name }] });
			yield* store.saveCriteria({ steamId: null, criteria: { [tag]: name } });
			yield* store.startJob(id, selection);
			expect(
				yield* store.claimRequest({
					jobId: id,
					index: 0,
					appid: 9,
					name,
					steamId: null,
					operationId: 'lease',
				}),
			).toBe(true);
			yield* store.saveResult(`${id}:0`, 'lease', [tag]);
			yield* store.applyResult(`${id}:0`);
			expect((yield* store.getGame(9))?.game.tags).toEqual([tag]);
			expect((yield* store.getJob())?.completed).toBe(1);
			expect((yield* store.getView()).criteria).toEqual({ [tag]: name });
			expect(yield* other.getLibrary()).toEqual(library);
			expect(yield* other.getJob()).toBeNull();
			const queries = prepare.mock.calls.map(([query]) => query).join('\n');
			for (const value of [owner, id, name, tag])
				expect(queries).not.toContain(value);
			prepare.mockRestore();
		}),
);

it.effect(
	'only one competing paid claim succeeds, while different games claim independently',
	() =>
		Effect.gen(function* () {
			const { store } = yield* fixture();
			const exits = yield* Effect.forEach(
				[0, 0],
				(index) => Effect.exit(claim(store, index)),
				{ concurrency: 'unbounded' },
			);
			expect(exits.filter(Exit.isSuccess)).toHaveLength(1);
			expect(exits.filter(Exit.isFailure)).toHaveLength(1);
			expect(yield* claim(store, 1)).toBe(true);
			expect(yield* store.getRequest('job:0')).toMatchObject({
				appid: 9,
				operationId: 'lease-0',
				tags: null,
				completed: false,
			});
			expect(yield* store.getRequest('job:1')).toMatchObject({
				appid: 620,
				operationId: 'lease-1',
				tags: null,
				completed: false,
			});
		}),
);

it.effect(
	'identical request IDs remain isolated across owners, including recovery',
	() =>
		Effect.gen(function* () {
			const { store, db } = yield* fixture();
			const other = yield* testStore(db, 'other');
			yield* seedLibrary(other, library);
			yield* other.startJob('job', selection);
			yield* claim(store, 0);
			yield* claim(other, 0);
			yield* store.saveResult('job:0', 'lease-0', ['Private']);
			yield* store.applyResult('job:0');
			yield* store.failJob('job', 'Stopped');
			yield* store.recoverRequests('recover');
			expect((yield* store.getGame(9))?.game.tags).toEqual(['Private']);
			expect((yield* other.getGame(9))?.game).toEqual(games[1]);
			expect((yield* other.getJob())?.completed).toBe(0);
			expect(yield* other.getRequest('job:0')).toMatchObject({
				completed: false,
				tags: null,
				operationId: 'lease-0',
			});
		}),
);

it.effect('competing job starts atomically admit only one job', () =>
	Effect.gen(function* () {
		const { db } = testDb();
		const store = yield* testStore(db, 'owner');
		yield* seedLibrary(store, library);
		const exits = yield* Effect.forEach(
			['one', 'two'],
			(id) => Effect.exit(store.startJob(id, selection)),
			{ concurrency: 'unbounded' },
		);
		expect(exits.filter(Exit.isSuccess)).toHaveLength(1);
		expect(exits.filter(Exit.isFailure)).toHaveLength(1);
		expect((yield* store.getJob())?.ids).toEqual([9, 620]);
	}),
);

it('job selection retries a stale library snapshot rather than selecting games with outdated tags', async () => {
	const { db } = testDb();
	const store = await Effect.runPromise(testStore(db, 'owner'));
	await Effect.runPromise(
		seedLibrary(store, {
			...library,
			games: games.map((game) => ({ ...game, tags: ['Select'] })),
		}),
	);
	const batch = db.batch.bind(db);
	let edited = false;
	db.batch = async <T>(statements: D1PreparedStatement[]) => {
		const result = await batch<T>(statements);
		if (!edited) {
			edited = true;
			await Effect.runPromise(store.saveTags({ appid: 9, tags: [] }));
		}
		return result;
	};
	await Effect.runPromise(
		store.startJob('job', { ...selection, category: 'Select' }),
	);
	expect((await Effect.runPromise(store.getJob()))?.ids).toEqual([620]);
});

it.effect(
	'out-of-order concurrent applies atomically merge tags, increment progress once and retain completion markers',
	() =>
		Effect.gen(function* () {
			const { store, queries } = yield* fixture();
			yield* claim(store, 0);
			yield* claim(store, 1);
			yield* store.saveTags({ appid: 620, tags: ['Z', 'Custom', 'A'] });
			yield* store.saveResult('job:1', 'lease-1', [
				'Custom',
				'M',
				'Z',
				'B',
				'M',
			]);
			yield* store.applyResult('job:1');
			expect((yield* store.getGame(620))?.game.tags).toEqual([
				'Z',
				'Custom',
				'A',
				'M',
				'B',
			]);
			expect((yield* store.getJob())?.completed).toBe(1);
			yield* store.saveTags({ appid: 620, tags: ['Edited after completion'] });
			yield* store.saveResult('job:0', 'lease-0', []);
			queries.length = 0;
			yield* Effect.all(
				[
					store.applyResult('job:0'),
					store.applyResult('job:1'),
					store.applyResult('job:0'),
				],
				{ concurrency: 'unbounded' },
			);
			expect(queries).toHaveLength(12);
			expect(queries.every((sql) => sql.startsWith('UPDATE'))).toBe(true);
			expect((yield* store.getJob())?.completed).toBe(2);
			expect((yield* store.getGame(9))?.game).toEqual({
				...games[1],
				reviewed: true,
			});
			expect((yield* store.getGame(620))?.game.tags).toEqual([
				'Edited after completion',
			]);
			for (const id of ['job:0', 'job:1'])
				expect(yield* store.getRequest(id)).toMatchObject({
					completed: true,
					tags: null,
					operationId: null,
				});
		}),
);

it.effect(
	'a failed progress write rolls back the game and preserves its paid checkpoint',
	() =>
		Effect.gen(function* () {
			const { store, sqlite } = yield* fixture();
			yield* claim(store, 0);
			yield* store.saveResult('job:0', 'lease-0', ['Saved']);
			sqlite.exec(
				"CREATE TRIGGER fail_job BEFORE UPDATE ON classification_jobs BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
			);
			expect(
				Exit.isFailure(yield* Effect.exit(store.applyResult('job:0'))),
			).toBe(true);
			expect((yield* store.getGame(9))?.game).toEqual(games[1]);
			expect((yield* store.getJob())?.completed).toBe(0);
			expect(yield* store.getRequest('job:0')).toMatchObject({
				tags: ['Saved'],
				completed: false,
			});
			sqlite.exec('DROP TRIGGER fail_job');
			yield* store.applyResult('job:0');
			expect((yield* store.getGame(9))?.game.tags).toEqual(['Saved']);
			expect((yield* store.getJob())?.completed).toBe(1);
		}),
);

it.effect(
	'new jobs cannot erase active or uncertain requests; recovery applies saved results and retains completed entries',
	() =>
		Effect.gen(function* () {
			const { store } = yield* fixture();
			yield* claim(store, 0);
			yield* claim(store, 1);
			yield* store.saveResult('job:1', 'lease-1', ['Recovered']);
			yield* store.failJob('job', 'Stopped');
			expect(
				Exit.isFailure(yield* Effect.exit(store.recoverRequests('recover'))),
			).toBe(true);
			expect(
				Exit.isFailure(yield* Effect.exit(store.startJob('new', selection))),
			).toBe(true);
			yield* store.releaseRequest('job:0', 'lease-0');
			yield* store.releaseRequest('job:1', 'lease-1');
			expect(
				Exit.isFailure(yield* Effect.exit(store.startJob('new', selection))),
			).toBe(true);
			expect(yield* store.getRequest('job:0')).not.toBeNull();
			yield* store.recoverRequests('recover');
			expect(yield* store.getRequest('job:0')).toBeNull();
			expect(yield* store.getRequest('job:1')).toMatchObject({
				completed: true,
			});
			expect((yield* store.getJob())?.completed).toBe(1);
			expect((yield* store.getGame(620))?.game.tags).toEqual([
				'Custom',
				'Recovered',
			]);
			yield* store.startJob('new', selection);
			expect(yield* store.getRequest('job:1')).toBeNull();
			expect((yield* store.getJob())?.completed).toBe(0);
		}),
);

it.effect(
	'stale or mismatched lease holders cannot save, release or replace another operation',
	() =>
		Effect.gen(function* () {
			const { store } = yield* fixture();
			yield* claim(store, 0);
			expect(
				Exit.isFailure(
					yield* Effect.exit(store.saveResult('job:0', 'wrong', ['Wrong'])),
				),
			).toBe(true);
			yield* store.releaseRequest('job:0', 'wrong');
			expect((yield* store.getRequest('job:0'))?.operationId).toBe('lease-0');
			yield* store.releaseRequest('job:0', 'lease-0');
			yield* store.failJob('job', 'Stopped');
			yield* store.recoverRequests('recover');
			const snapshot = yield* store.claimLibrary('replace');
			yield* store.releaseLibrary('wrong');
			expect(
				Exit.isFailure(yield* Effect.exit(store.claimLibrary('other'))),
			).toBe(true);
			expect(
				Exit.isFailure(
					yield* Effect.exit(
						store.replaceLibrary(library, 'wrong', snapshot.revision),
					),
				),
			).toBe(true);
			yield* store.saveTags({ appid: 9, tags: ['During import'] });
			expect(
				Exit.isFailure(
					yield* Effect.exit(
						store.replaceLibrary(library, 'replace', snapshot.revision),
					),
				),
			).toBe(true);
			expect((yield* store.getGame(9))?.game.tags).toEqual(['During import']);
			yield* store.releaseLibrary('replace');
		}),
);

it.effect(
	'expired requests remain uncertain and block replacement until explicit recovery',
	() =>
		Effect.gen(function* () {
			const { store, sqlite } = yield* fixture();
			yield* claim(store, 0);
			yield* store.failJob('job', 'Stopped');
			sqlite.exec('UPDATE classification_requests SET operation_expires_at=0');
			expect(Exit.isFailure(yield* Effect.exit(claim(store, 0)))).toBe(true);
			expect(
				Exit.isFailure(yield* Effect.exit(store.claimLibrary('replace'))),
			).toBe(true);
			yield* store.recoverRequests('recover');
			expect(yield* store.getRequest('job:0')).toBeNull();
			yield* store.claimLibrary('replace');
		}),
);

it.effect(
	'large replacements remove obsolete rows, preserve order and isolate owners',
	() =>
		Effect.gen(function* () {
			const { db } = testDb();
			const store = yield* testStore(db, 'owner');
			const other = yield* testStore(db, 'other');
			yield* seedLibrary(store, library);
			yield* seedLibrary(other, library);
			const replacement = {
				...library,
				steamId: '76561198000000002',
				games: Array.from({ length: 1500 }, (_, i) => ({
					...games[1],
					appid: 2000 - i,
					name: `Game ${i}`,
				})),
			};
			yield* seedLibrary(store, replacement);
			expect(yield* store.getLibrary()).toEqual(replacement);
			expect(yield* store.getGame(9)).toBeNull();
			expect(yield* other.getLibrary()).toEqual(library);
			yield* seedLibrary(store, { ...library, games: [] });
			expect((yield* store.getLibrary()).games).toEqual([]);
		}),
);

it('actual D1 executes targeted batches and rolls back a failed multi-table apply', async () => {
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
		const store = await Effect.runPromise(
			testStore(db as unknown as D1Database, 'owner'),
		);
		await Effect.runPromise(seedLibrary(store, library));
		await Effect.runPromise(store.startJob('job', selection));
		await Effect.runPromise(claim(store, 0));
		await Effect.runPromise(store.saveResult('job:0', 'lease-0', ['Saved']));
		await db
			.prepare(
				"CREATE TRIGGER fail_job BEFORE UPDATE ON classification_jobs BEGIN SELECT RAISE(ABORT,'injected failure'); END",
			)
			.run();
		await expect(
			Effect.runPromise(store.applyResult('job:0')),
		).rejects.toThrow();
		expect((await Effect.runPromise(store.getGame(9)))?.game).toEqual(games[1]);
		expect((await Effect.runPromise(store.getJob()))?.completed).toBe(0);
		expect(await Effect.runPromise(store.getRequest('job:0'))).toMatchObject({
			tags: ['Saved'],
			completed: false,
		});
		await db.prepare('DROP TRIGGER fail_job').run();
		await Effect.runPromise(store.applyResult('job:0'));
		expect((await Effect.runPromise(store.getGame(9)))?.game.tags).toEqual([
			'Saved',
		]);
		expect((await Effect.runPromise(store.getJob()))?.completed).toBe(1);
		expect(await Effect.runPromise(store.getRequest('job:0'))).toMatchObject({
			tags: null,
			completed: true,
		});
	} finally {
		await runtime.dispose();
	}
}, 30_000);
