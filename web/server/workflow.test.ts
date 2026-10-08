import {
	WorkflowStep,
	WorkflowStepContext,
	type WorkflowTaskOptions,
} from 'alchemy/Cloudflare/Workflows';
import { Effect, type Scope } from 'effect';
import { expect, it } from 'vitest';

import { applyResult, recover, unlocked } from './business.js';
import { HttpError } from './security.js';
import { initial, type Document } from './store.js';
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
function fixture(ids = [1, 2], parallel = false) {
	let state: Document = {
		...initial(),
		...(parallel ? { requests: {} } : {}),
		library: {
			version: 1,
			steamId: null,
			games: ids.map((appid) => ({
				appid,
				name: `Game ${appid}`,
				playtime_forever: 0,
				tags: [],
				reviewed: false,
			})),
		},
		job: {
			id: 'job',
			status: 'queued',
			total: ids.length,
			completed: 0,
			current: null,
			error: null,
			cancel: false,
			steamId: null,
			ids,
			criteria: { Action: 'action' },
		},
	};
	let calls = 0;
	const operations: WorkflowServices = {
		load: () => Effect.sync(() => state),
		modify: (update) =>
			Effect.sync(() => {
				state = update(state);
				return state;
			}),
		classify: (input) =>
			Effect.sync(() => {
				calls++;
				state = applyResult(
					state.requests === undefined
						? {
								...state,
								flight: input,
								result: { ...input, tags: ['Action'] },
							}
						: {
								...state,
								requests: {
									...state.requests,
									[input.requestId]: {
										operation: null,
										completed: null,
										flight: input,
										result: { ...input, tags: ['Action'] },
									},
								},
							},
					input.requestId,
					input.appid,
				);
				return state;
			}),
	};
	return {
		operations,
		get: () => state,
		calls: () => calls,
		set: (next: Document) => {
			state = next;
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
it('runs at most three games concurrently and replays out-of-order completions without charging again', async () => {
	const testFixture = fixture([1, 2, 3, 4, 5], true);
	const classify = testFixture.operations.classify;
	const entered = Array.from({ length: 5 }, gate);
	const release = Array.from({ length: 5 }, gate);
	const saved = Array.from({ length: 5 }, gate);
	const started: number[] = [];
	testFixture.operations.classify = (input) =>
		Effect.gen(function* () {
			started.push(input.appid);
			entered[input.appid - 1]!.open();
			yield* Effect.promise(() => release[input.appid - 1]!.promise);
			const state = yield* classify(input);
			saved[input.appid - 1]!.open();
			return state;
		});
	const running = run('job', testFixture.operations);
	await Promise.all(entered.slice(0, 3).map((item) => item.promise));
	expect(started).toEqual([1, 2, 3]);
	release[2]!.open();
	await saved[2]!.promise;
	expect(testFixture.get().job?.completed).toBe(1);
	expect(testFixture.get().library.games.map((game) => game.reviewed)).toEqual([
		false,
		false,
		true,
		false,
		false,
	]);
	expect(started).toEqual([1, 2, 3]);
	// Stop this pass after draining the batch, then replay without a step journal.
	testFixture.set({
		...testFixture.get(),
		job: { ...testFixture.get().job!, cancel: true },
	});
	release[0]!.open();
	release[1]!.open();
	await running;
	expect(testFixture.get().job?.status).toBe('cancelled');
	expect(testFixture.get().job?.completed).toBe(3);
	testFixture.set({
		...testFixture.get(),
		job: { ...testFixture.get().job!, cancel: false, status: 'running' },
	});
	const replay = run('job', testFixture.operations);
	await Promise.all(entered.slice(3).map((item) => item.promise));
	expect(started).toEqual([1, 2, 3, 4, 5]);
	release[4]!.open();
	release[3]!.open();
	await replay;
	expect(testFixture.calls()).toBe(5);
	expect(testFixture.get().job?.completed).toBe(5);
	expect(testFixture.get().job?.status).toBe('complete');
	expect(testFixture.get().library.games.every((game) => game.reviewed)).toBe(
		true,
	);
});
it('drains successful in-flight games on failure and recovers each uncertain request', async () => {
	const testFixture = fixture([1, 2, 3, 4], true);
	const classify = testFixture.operations.classify;
	const entered = gate();
	const release = gate();
	let count = 0;
	testFixture.operations.classify = (input) =>
		Effect.gen(function* () {
			if (++count === 3) entered.open();
			yield* Effect.promise(() => release.promise);
			if (input.appid === 2) return yield* classify(input);
			testFixture.set({
				...testFixture.get(),
				requests: {
					...testFixture.get().requests,
					[input.requestId]: {
						operation: null,
						flight: input,
						result: null,
						completed: null,
					},
				},
			});
			return yield* Effect.fail(new HttpError(409, 'provider lost'));
		});
	const running = run('job', testFixture.operations);
	const rejected = expect(running).rejects.toThrow('provider lost');
	await entered.promise;
	release.open();
	await rejected;
	expect(count).toBe(3);
	expect(testFixture.get().job?.status).toBe('failed');
	expect(testFixture.get().job?.completed).toBe(1);
	expect(testFixture.get().library.games[1]?.reviewed).toBe(true);
	expect(() => unlocked(testFixture.get())).toThrow('uncertain');
	const state = testFixture.get();
	testFixture.set({
		...state,
		requests: {
			...state.requests,
			'job:0': {
				...state.requests!['job:0']!,
				operation: { id: 'still-saving', expiresAt: Date.now() + 120_000 },
				result: { requestId: 'job:0', appid: 1, tags: ['Recovered'] },
			},
		},
	});
	expect(() => recover(testFixture.get())).toThrow('active');
	testFixture.set({
		...testFixture.get(),
		requests: {
			...testFixture.get().requests,
			'job:0': { ...testFixture.get().requests!['job:0']!, operation: null },
		},
	});
	const recovered = recover(testFixture.get());
	expect(recovered.job?.completed).toBe(2);
	expect(recovered.library.games[0]?.tags).toEqual(['Recovered']);
	expect(recovered.library.games[2]?.reviewed).toBe(false);
	expect(
		Object.values(recovered.requests ?? {}).every(
			(paid) => paid.flight === null,
		),
	).toBe(true);
	expect(() => unlocked(recovered)).not.toThrow();
});
it('replays without a journal using atomic persisted index, preserving tag edits', async () => {
	const testFixture = fixture();
	const classify = testFixture.operations.classify;
	testFixture.operations.classify = (input) =>
		Effect.gen(function* () {
			const state = yield* classify(input);
			if (input.appid === 1)
				return yield* Effect.fail(new HttpError(409, 'journal lost'));
			return state;
		});
	await expect(run('job', testFixture.operations)).rejects.toThrow(
		'journal lost',
	);
	expect(testFixture.get().job?.completed).toBe(1);
	testFixture.set({
		...testFixture.get(),
		job: { ...testFixture.get().job!, status: 'running' },
		library: {
			...testFixture.get().library,
			games: testFixture.get().library.games.map((game) => ({
				...game,
				tags: [...game.tags, 'Edited'],
			})),
		},
	});
	testFixture.operations.classify = classify;
	await run('job', testFixture.operations);
	expect(testFixture.calls()).toBe(2);
	expect(testFixture.get().job?.status).toBe('complete');
	expect(testFixture.get().library.games[1]?.tags).toEqual([
		'Edited',
		'Action',
	]);
});
it('cancels at next boundary after saving the in-flight game', async () => {
	const testFixture = fixture();
	const classify = testFixture.operations.classify;
	testFixture.operations.classify = (input) =>
		Effect.gen(function* () {
			testFixture.set({
				...testFixture.get(),
				job: { ...testFixture.get().job!, cancel: true },
			});
			return yield* classify(input);
		});
	await run('job', testFixture.operations);
	expect(testFixture.calls()).toBe(1);
	expect(testFixture.get().job?.status).toBe('cancelled');
	expect(testFixture.get().job?.completed).toBe(1);
});
it('failed step preserves uncertain flight and requires consent recovery', async () => {
	const testFixture = fixture();
	testFixture.operations.classify = (input) =>
		Effect.gen(function* () {
			testFixture.set({ ...testFixture.get(), flight: input });
			return yield* Effect.fail(new HttpError(409, 'provider lost'));
		});
	await expect(run('job', testFixture.operations)).rejects.toThrow();
	expect(testFixture.get().job?.status).toBe('failed');
	expect(() => unlocked(testFixture.get())).toThrow('uncertain');
	expect(recover(testFixture.get()).flight).toBe(null);
});
it('active job blocks recovery and mutation, terminal delayed workflow cannot charge', async () => {
	const testFixture = fixture();
	expect(() => unlocked(testFixture.get())).toThrow('active');
	expect(() => recover(testFixture.get())).toThrow('active');
	testFixture.set({
		...testFixture.get(),
		job: { ...testFixture.get().job!, status: 'failed' },
	});
	await run('job', testFixture.operations);
	expect(testFixture.calls()).toBe(0);
});
it('creation failure checks deterministic instance before propagating, accepting lost responses', async () => {
	const ids: string[] = [];
	const createError = new Error('create lost');
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
