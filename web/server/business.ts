import { Effect, Schema } from 'effect';

import { CategoryCriteria } from '../../src/domain/classification.js';
import {
	Library,
	AppId,
	SteamId,
	emptyLibrary,
	mergeLibrary,
	selectGames,
} from '../../src/domain/library.js';
import { Classifier } from '../../src/services/classifier.js';
import { LibraryService } from '../../src/services/library.js';
import { Steam } from '../../src/services/steam.js';
import { ImportInput, SyncInput, TagsInput, ClassifyInput } from '../shared.js';
import { HttpError } from './security.js';
import { type Env } from './services.js';
import { parseCollections, attachCollections } from './steam-collections.js';
import { Store, savedCriteria, type Document } from './store.js';
import { ensureStarted } from './workflow.js';

export const activeJob = (state: Document) =>
	state.job?.status === 'queued' || state.job?.status === 'running';
const PaidInput = Schema.Struct({
	appid: AppId,
	criteria: CategoryCriteria,
	requestId: Schema.String,
});

export function unlocked(state: Document) {
	if (activeJob(state))
		throw new HttpError(409, 'A classification job is active.');
	if (state.operation && state.operation.expiresAt > Date.now())
		throw new HttpError(409, 'An operation is active.');
	if (state.flight)
		throw new HttpError(
			409,
			'Paid outcome uncertain. Confirm recovery before continuing.',
		);
	return state;
}
export function recover(state: Document): Document {
	if (activeJob(state))
		throw new HttpError(409, 'A classification job is active.');
	if (state.operation && state.operation.expiresAt > Date.now())
		throw new HttpError(409, 'An operation is active.');
	if (state.result && state.flight)
		return applyResult(state, state.flight.requestId, state.flight.appid);
	return { ...state, operation: null, flight: null, result: null };
}
export const stateResponse = (state: Document, env: Env, identity: string) => ({
	library: state.library,
	identity,
	criteria: savedCriteria(state),
	job: state.job
		? {
				id: state.job.id,
				status: state.job.status,
				total: state.job.total,
				completed: state.job.completed,
				current: state.job.current,
				error: state.job.error,
			}
		: null,
	configured: { sync: !!env.STEAM_API_KEY, classify: !!env.TYPESAFE_API_KEY },
});
const decode = <A>(schema: Schema.Decoder<A>, body: unknown) =>
	Schema.decodeUnknownEffect(schema)(body).pipe(
		Effect.mapError(() => new HttpError(400, 'Invalid request body.')),
	);
const parseJson = (text: string) =>
	Effect.try({
		try: () => JSON.parse(text) as unknown,
		catch: () => new HttpError(400, 'Invalid JSON import.'),
	});

export const classifyOne = Effect.fn('Organizer.classifyOne')(function* (
	store: Pick<Store, 'load' | 'modify'>,
	input: typeof PaidInput.Type,
) {
	let state = (yield* store.load()).state;
	if (state.completed?.requestId === input.requestId) {
		if (state.completed.appid !== input.appid)
			return yield* Effect.fail(
				new HttpError(409, 'Request ID reused for a different game.'),
			);
		return state;
	}
	if (
		state.flight?.requestId === input.requestId &&
		state.result?.requestId === input.requestId &&
		state.flight.appid === input.appid
	)
		return yield* store.modify((current) =>
			applyResult(current, input.requestId, input.appid),
		);
	const game = state.library.games.find((game) => game.appid === input.appid);
	if (!game) return yield* Effect.fail(new HttpError(404, 'Game missing.'));
	const description = yield* (yield* Steam).fetchGameDescription(input.appid);
	const operationId = crypto.randomUUID();
	state = yield* store.modify((current) => {
		if (current.completed?.requestId === input.requestId) {
			if (current.completed.appid !== input.appid)
				throw new HttpError(409, 'Request ID reused for a different game.');
			return current;
		}
		if (
			state.job &&
			(current.job?.id !== state.job.id ||
				!activeJob(current) ||
				input.requestId !== `${current.job.id}:${current.job.completed}` ||
				current.job.ids[current.job.completed] !== input.appid)
		)
			throw new HttpError(409, 'Job is no longer active at this game.');
		if (
			activeJob(current) &&
			!input.requestId.startsWith(`${current.job!.id}:`)
		)
			throw new HttpError(409, 'A classification job is active.');
		unlocked({ ...current, job: null });
		if (
			current.library.steamId !== state.library.steamId ||
			!current.library.games.some(
				(candidateGame) =>
					candidateGame.appid === input.appid &&
					candidateGame.name === game.name,
			)
		)
			throw new HttpError(409, 'Library changed. Try again.');
		return {
			...current,
			flight: { requestId: input.requestId, appid: input.appid },
			operation: { id: operationId, expiresAt: Date.now() + 120_000 },
		};
	});
	if (state.completed?.requestId === input.requestId) return state;
	const paid = Effect.gen(function* () {
		const tags = yield* (yield* Classifier).classifyGame(
			{ ...game, description },
			input.criteria,
		);
		yield* store.modify((current) => {
			if (
				current.operation?.id !== operationId ||
				current.flight?.requestId !== input.requestId
			)
				throw new HttpError(409, 'Classification lease lost.');
			return {
				...current,
				result: { requestId: input.requestId, appid: input.appid, tags },
			};
		});
		return yield* store.modify((current) =>
			applyResult(current, input.requestId, input.appid),
		);
	});
	return yield* paid.pipe(
		Effect.timeout('45 seconds'),
		Effect.catchCause(() =>
			Effect.fail(
				new HttpError(
					409,
					'Paid outcome uncertain. No request was repeated. Retry the same request to apply a saved result, or confirm recovery.',
				),
			),
		),
		Effect.ensuring(
			store
				.modify((current) =>
					current.operation?.id === operationId
						? { ...current, operation: null }
						: current,
				)
				.pipe(Effect.orDie),
		),
	);
});
export function applyResult(
	current: Document,
	requestId: string,
	appid: number,
): Document {
	if (
		current.flight?.requestId !== requestId ||
		current.flight.appid !== appid ||
		current.result?.requestId !== requestId ||
		current.result.appid !== appid
	)
		return current;
	const tags = current.result.tags;
	return {
		...current,
		flight: null,
		result: null,
		operation: null,
		completed: { requestId, appid },
		...(current.job &&
		requestId === `${current.job.id}:${current.job.completed}`
			? {
					job: {
						...current.job,
						completed: current.job.completed + 1,
						current: null,
					},
				}
			: {}),
		library: {
			...current.library,
			games: current.library.games.map((game) =>
				game.appid === appid
					? {
							...game,
							tags: [...new Set([...game.tags, ...tags])],
							reviewed: true,
						}
					: game,
			),
		},
	};
}
export const mutate = Effect.fn('Organizer.mutate')(function* (
	path: string,
	body: unknown,
	env: Env,
	identity: string,
) {
	const store = new Store(env.DB, identity);
	const respond = (state: Document) => stateResponse(state, env, identity);
	if (path === '/api/jobs/cancel') {
		yield* decode(Schema.Struct({}), body);
		return respond(
			yield* store.modify((state) =>
				activeJob(state)
					? { ...state, job: { ...state.job!, cancel: true } }
					: state,
			),
		);
	}
	if (path === '/api/criteria') {
		const input = yield* decode(
			Schema.Struct({
				steamId: Schema.NullOr(SteamId),
				criteria: CategoryCriteria,
			}),
			body,
		);
		return respond(
			yield* store.modify((state) => {
				unlocked(state);
				if (state.library.steamId !== input.steamId)
					throw new HttpError(
						409,
						'Steam account changed. Reload before saving categories.',
					);
				return {
					...state,
					criteriaBySteamId: {
						...state.criteriaBySteamId,
						[input.steamId ?? 'offline']: input.criteria,
					},
				};
			}),
		);
	}
	if (path === '/api/tags') {
		const input = yield* decode(TagsInput, body);
		return respond(
			yield* store.modify((state) => ({
				...state,
				library: {
					...state.library,
					games: state.library.games.map((game) =>
						game.appid === input.appid ? { ...game, tags: input.tags } : game,
					),
				},
			})),
		);
	}
	if (path === '/api/classify/recover') {
		yield* decode(Schema.Struct({ confirm: Schema.Literal(true) }), body);
		return respond(yield* store.modify(recover));
	}
	if (path === '/api/classify') {
		const input = yield* decode(ClassifyInput, body);
		if (!env.TYPESAFE_API_KEY)
			return yield* Effect.fail(
				new HttpError(400, 'Classification is not configured.'),
			);
		const id = crypto.randomUUID();
		const claimed = yield* store.modify((state) => {
			unlocked(state);
			if (input.steamId !== state.library.steamId)
				throw new HttpError(409, 'Steam account changed.');
			const ids = selectGames(
				state.library,
				input.search,
				input.category,
				!input.all,
			).map((game) => game.appid);
			if (ids.length > 500)
				throw new HttpError(400, 'Select at most 500 games per job.');
			return {
				...state,
				job: {
					id,
					ids,
					criteria: savedCriteria(state),
					steamId: state.library.steamId,
					cancel: false,
					status: 'queued',
					total: ids.length,
					completed: 0,
					current: null,
					error: null,
				},
			};
		});
		return respond(
			yield* Effect.tryPromise(() =>
				ensureStarted(env.CLASSIFICATION, identity, id),
			).pipe(
				Effect.as(claimed),
				Effect.catch(() =>
					store.modify((state) =>
						state.job?.id === id && activeJob(state)
							? {
									...state,
									job: {
										...state.job,
										status: 'failed',
										current: null,
										error: 'Classification could not start. Try a new job.',
									},
								}
							: state,
					),
				),
			),
		);
	}
	if (path === '/api/steam-collections') {
		const input = yield* decode(ImportInput, body);
		const collections = yield* Effect.try({
			try: () => parseCollections(input.text),
			catch: () => new HttpError(400, 'Invalid Steam collections file.'),
		});
		return respond(
			yield* store.modify((state) => ({
				...unlocked(state),
				library: attachCollections(state.library, collections),
			})),
		);
	}
	if (path !== '/api/import' && path !== '/api/restore' && path !== '/api/sync')
		return yield* Effect.fail(new HttpError(404, 'Unknown API route.'));
	const operationId = crypto.randomUUID();
	const snapshot = yield* store.modify((state) => ({
		...unlocked(state),
		operation: { id: operationId, expiresAt: Date.now() + 120_000 },
	}));
	return yield* Effect.gen(function* () {
		let imported: Library;
		if (path === '/api/import' || path === '/api/restore') {
			const input = yield* decode(ImportInput, body);
			const value = yield* parseJson(input.text);
			if (
				path === '/api/restore' ||
				(typeof value === 'object' && value !== null && 'version' in value)
			)
				imported = yield* decode(Library, value);
			else
				imported = mergeLibrary(
					snapshot.library,
					yield* (yield* LibraryService).decodeImport(input.text),
					snapshot.library.steamId,
				);
		} else {
			const input = yield* decode(SyncInput, body);
			const previous =
				snapshot.library.steamId === null ||
				snapshot.library.steamId === input.steamId
					? snapshot.library
					: emptyLibrary();
			imported = mergeLibrary(
				previous,
				yield* (yield* Steam).fetchLibrary(input.steamId),
				input.steamId,
			);
		}
		return respond(
			yield* store.modify((state) => {
				if (state.flight || state.operation?.id !== operationId)
					throw new HttpError(409, 'Library changed. Try again.');
				return { ...state, library: imported, operation: null };
			}),
		);
	}).pipe(
		Effect.ensuring(
			store
				.modify((state) =>
					state.operation?.id === operationId
						? { ...state, operation: null }
						: state,
				)
				.pipe(Effect.orDie),
		),
	);
});
