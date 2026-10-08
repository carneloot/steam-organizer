import { NodeCrypto } from '@effect/platform-node';
import {
	WorkflowStep,
	WorkflowStepContext,
	type WorkflowTaskOptions,
} from 'alchemy/Cloudflare/Workflows';
import { Effect, Layer, type Scope } from 'effect';
import { expect, it } from 'vitest';

import {
	Classifier,
	ClassificationRequestError,
} from '../../src/services/classifier.js';
import { Steam } from '../../src/services/steam.js';
import { classifyOne } from './business.js';
import { HttpError } from './security.js';
import { Store } from './store.js';
import { seedLibrary, testDb } from './test-db.js';
import {
	ensureStarted,
	runClassification,
	type WorkflowServices,
} from './workflow.js';

const step = WorkflowStep.of({
	do: <T, E>(
		options: WorkflowTaskOptions<
			T,
			WorkflowStepContext | Scope.Scope,
			unknown,
			E
		>,
	) => {
		expect(options.retries?.limit).toBe(0);
		return options.effect.pipe(
			Effect.provideService(WorkflowStepContext, {
				step: { name: options.name, count: 1 },
				attempt: 1,
				config: options,
			}),
			Effect.scoped,
		);
	},
	sleep: () => Effect.die('Unexpected sleep'),
	sleepUntil: () => Effect.die('Unexpected sleepUntil'),
	waitForEvent: () => Effect.die('Unexpected waitForEvent'),
});
const run = (id: string, operations: WorkflowServices) =>
	Effect.runPromise(
		runClassification(id, operations).pipe(
			Effect.provideService(WorkflowStep, step),
		),
	);
async function fixture(ids = [1, 2]) {
	const { db, sqlite } = testDb();
	const store = new Store(db, 'owner');
	await Effect.runPromise(
		seedLibrary(store, {
			version: 1,
			steamId: null,
			games: ids.map((appid) => ({
				appid,
				name: `Game ${appid}`,
				playtime_forever: 0,
				tags: [],
				reviewed: false,
			})),
		}),
	);
	await Effect.runPromise(
		store.saveCriteria({ steamId: null, criteria: { Action: 'action' } }),
	);
	await Effect.runPromise(
		store.startJob('job', {
			steamId: null,
			search: '',
			category: '',
			all: true,
		}),
	);
	let provider: (
		appid: number,
	) => Effect.Effect<string[], ClassificationRequestError> = () =>
		Effect.succeed(['Action']);
	const calls: number[] = [];
	const layer = Layer.mergeAll(
		NodeCrypto.layer,
		Layer.succeed(
			Steam,
			Steam.of({
				fetchLibrary: () => Effect.succeed([]),
				fetchGameDescription: () => Effect.succeed('description'),
			}),
		),
		Layer.succeed(
			Classifier,
			Classifier.of({
				classifyGame: (game) =>
					Effect.suspend(() => {
						calls.push(game.appid);
						return provider(game.appid);
					}),
			}),
		),
	);
	const operations: WorkflowServices = {
		getJob: store.getJob,
		beginBatch: store.beginBatch,
		shouldClassify: store.shouldClassify,
		finishJob: store.finishJob,
		failJob: store.failJob,
		classify: (input) => classifyOne(store, input).pipe(Effect.provide(layer)),
	};
	return {
		store,
		sqlite,
		operations,
		calls,
		get: () => Effect.runPromise(store.getView()),
		setProvider: (next: typeof provider) => {
			provider = next;
		},
	};
}
function gate() {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

it('runs three games concurrently and replays out-of-order completions without charging again', async () => {
	const test = await fixture([1, 2, 3, 4, 5]);
	const entered = Array.from({ length: 5 }, gate),
		release = Array.from({ length: 5 }, gate),
		saved = Array.from({ length: 5 }, gate);
	test.setProvider((appid) =>
		Effect.gen(function* () {
			entered[appid - 1]!.open();
			yield* Effect.promise(() => release[appid - 1]!.promise);
			return ['Action'];
		}),
	);
	const classify = test.operations.classify;
	test.operations.classify = (input) =>
		classify(input).pipe(
			Effect.tap(() => Effect.sync(() => saved[input.appid - 1]!.open())),
		);
	const running = run('job', test.operations);
	await Promise.all(entered.slice(0, 3).map((item) => item.promise));
	expect(test.calls).toEqual([1, 2, 3]);
	release[2]!.open();
	await saved[2]!.promise;
	expect((await test.get()).job?.completed).toBe(1);
	expect((await test.get()).library.games.map((game) => game.reviewed)).toEqual(
		[false, false, true, false, false],
	);
	expect(test.calls).toEqual([1, 2, 3]);
	await Effect.runPromise(test.store.cancelJob());
	release[0]!.open();
	release[1]!.open();
	await running;
	expect((await test.get()).job).toMatchObject({
		status: 'cancelled',
		completed: 3,
	});
	// Simulate losing the workflow journal while durable results and manual edits survive.
	test.sqlite.exec("UPDATE classification_jobs SET cancel=0,status='running'");
	await Effect.runPromise(
		test.store.saveTags({ appid: 3, tags: ['Edited after completion'] }),
	);
	const replay = run('job', test.operations);
	await Promise.all(entered.slice(3).map((item) => item.promise));
	expect(test.calls).toEqual([1, 2, 3, 4, 5]);
	release[4]!.open();
	release[3]!.open();
	await replay;
	expect((await test.get()).job).toMatchObject({
		status: 'complete',
		completed: 5,
	});
	expect((await test.get()).library.games.every((game) => game.reviewed)).toBe(
		true,
	);
	expect((await Effect.runPromise(test.store.getGame(3)))?.game.tags).toEqual([
		'Edited after completion',
	]);
	for (let i = 0; i < 5; i++)
		expect(
			await Effect.runPromise(test.store.getRequest(`job:${i}`)),
		).toMatchObject({ completed: true, appid: i + 1 });
});

it('drains successful in-flight siblings before failing, preserves uncertain requests and requires consent recovery', async () => {
	const test = await fixture([1, 2, 3, 4]);
	const entered = [gate(), gate(), gate()],
		release = [gate(), gate(), gate()];
	test.setProvider((appid) =>
		Effect.gen(function* () {
			entered[appid - 1]!.open();
			yield* Effect.promise(() => release[appid - 1]!.promise);
			if (appid === 2) return ['Action'];
			return yield* new ClassificationRequestError({
				message: 'provider lost',
			});
		}),
	);
	const running = run('job', test.operations);
	const rejected = expect(running).rejects.toThrow('Paid outcome uncertain');
	await Promise.all(entered.map((item) => item.promise));
	release[0]!.open();
	release[2]!.open();
	expect((await test.get()).job?.status).toBe('running');
	await expect(
		Effect.runPromise(test.store.recoverRequests('recover')),
	).rejects.toThrow('active');
	release[1]!.open();
	await rejected;
	expect(test.calls).toEqual([1, 2, 3]);
	expect((await test.get()).job).toMatchObject({
		status: 'failed',
		completed: 1,
	});
	expect((await test.get()).library.games[1]?.reviewed).toBe(true);
	await expect(
		Effect.runPromise(test.store.claimLibrary('replace')),
	).rejects.toThrow('uncertain');
	await Effect.runPromise(test.store.recoverRequests('recover'));
	expect(await Effect.runPromise(test.store.getRequest('job:0'))).toBeNull();
	expect(await Effect.runPromise(test.store.getRequest('job:2'))).toBeNull();
	expect(await Effect.runPromise(test.store.getRequest('job:1'))).toMatchObject(
		{ completed: true },
	);
	await Effect.runPromise(test.store.claimLibrary('replace'));
});

it('journal failure after an atomic save cannot charge completed games or overwrite tag edits on replay', async () => {
	const test = await fixture();
	const classify = test.operations.classify;
	test.operations.classify = (input) =>
		classify(input).pipe(
			Effect.andThen(
				input.appid === 1
					? Effect.fail(new HttpError(409, 'journal lost'))
					: Effect.void,
			),
		);
	await expect(run('job', test.operations)).rejects.toThrow('journal lost');
	expect((await test.get()).job?.completed).toBe(2);
	test.sqlite.exec("UPDATE classification_jobs SET status='running'");
	await Effect.runPromise(test.store.saveTags({ appid: 1, tags: ['Edited'] }));
	test.operations.classify = classify;
	await run('job', test.operations);
	expect(test.calls).toHaveLength(2);
	expect((await test.get()).job).toMatchObject({
		status: 'complete',
		completed: 2,
	});
	expect((await Effect.runPromise(test.store.getGame(1)))?.game.tags).toEqual([
		'Edited',
	]);
});

it('active jobs block recovery; a terminal delayed workflow cannot charge or change a newer job', async () => {
	const test = await fixture();
	await expect(
		Effect.runPromise(test.store.recoverRequests('recover')),
	).rejects.toThrow('active');
	await expect(
		Effect.runPromise(test.store.claimLibrary('replace')),
	).rejects.toThrow('active');
	await Effect.runPromise(test.store.failJob('job', 'Stopped'));
	await run('job', test.operations);
	expect(test.calls).toEqual([]);
	await Effect.runPromise(
		test.store.startJob('new', {
			steamId: null,
			search: '',
			category: '',
			all: true,
		}),
	);
	await expect(run('job', test.operations)).rejects.toThrow('Job missing');
	expect((await test.get()).job).toMatchObject({ id: 'new', status: 'queued' });
});

it('creation failure checks the deterministic instance, accepting a lost response without duplicate creation', async () => {
	const ids: string[] = [],
		createError = new Error('create lost');
	const binding = {
		create: async ({ id }: { id: string }) => {
			ids.push(id);
			throw createError;
		},
		get: async (id: string) => {
			ids.push(id);
			return { status: async () => ({ status: 'running' }) };
		},
	};
	await Effect.runPromise(
		ensureStarted(
			binding as unknown as Parameters<typeof ensureStarted>[0],
			'owner',
			'job',
		),
	);
	expect(ids).toEqual(['job', 'job']);
	binding.get = async () => {
		throw new Error('missing');
	};
	await expect(
		Effect.runPromise(
			ensureStarted(
				binding as unknown as Parameters<typeof ensureStarted>[0],
				'owner',
				'job',
			),
		),
	).rejects.toHaveProperty('cause', createError);
});
