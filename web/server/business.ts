import { Crypto, Effect, Schema } from 'effect';

import { CategoryCriteria } from '../../src/domain/classification.js';
import {
	Library,
	AppId,
	emptyLibrary,
	mergeLibrary,
	selectGames,
} from '../../src/domain/library.js';
import { Classifier } from '../../src/services/classifier.js';
import { LibraryService } from '../../src/services/library.js';
import { Steam } from '../../src/services/steam.js';
import {
	ImportInput,
	SyncInput,
	TagsInput,
	ClassifyInput,
	CriteriaInput,
} from '../shared.js';
import { HttpError } from './security.js';
import { type Env } from './services.js';
import { parseCollections, attachCollections } from './steam-collections.js';
import {
	Store,
	savedCriteria,
	type Document,
	type PaidState,
} from './store.js';
import { ensureStarted } from './workflow.js';

export const activeJob = (state: Document) =>
	state.job?.status === 'queued' || state.job?.status === 'running';
const PaidInput = Schema.Struct({
	appid: AppId,
	criteria: CategoryCriteria,
	requestId: Schema.String,
});

function jobIndex(state: Document, requestId: string) {
	const job = state.job;
	if (!job) return -1;
	return job.ids.findIndex(
		(_appid, index) => requestId === `${job.id}:${index}`,
	);
}
export function paidState(state: Document, requestId: string): PaidState {
	if (state.requests !== undefined && jobIndex(state, requestId) >= 0)
		return (
			state.requests[requestId] ?? {
				operation: null,
				flight: null,
				result: null,
				completed: null,
			}
		);
	return {
		operation: state.operation,
		flight: state.flight,
		result: state.result,
		completed: state.completed,
	};
}
function updatePaid(
	state: Document,
	requestId: string,
	paid: PaidState,
): Document {
	return state.requests !== undefined && jobIndex(state, requestId) >= 0
		? { ...state, requests: { ...state.requests, [requestId]: paid } }
		: { ...state, ...paid };
}

export function unlocked(state: Document) {
	if (activeJob(state))
		throw new HttpError(409, 'A classification job is active.');
	const requests = [state, ...Object.values(state.requests ?? {})];
	if (
		requests.some(
			(paid) => paid.operation && paid.operation.expiresAt > Date.now(),
		)
	)
		throw new HttpError(409, 'An operation is active.');
	if (requests.some((paid) => paid.flight))
		throw new HttpError(
			409,
			'Paid outcome uncertain. Confirm recovery before continuing.',
		);
	return state;
}
export function recover(state: Document): Document {
	if (activeJob(state))
		throw new HttpError(409, 'A classification job is active.');
	if (
		[state, ...Object.values(state.requests ?? {})].some(
			(paid) => paid.operation && paid.operation.expiresAt > Date.now(),
		)
	)
		throw new HttpError(409, 'An operation is active.');
	for (const [requestId, paid] of Object.entries(state.requests ?? {})) {
		if (paid.flight && paid.result)
			state = applyResult(state, requestId, paid.flight.appid);
		else
			state = updatePaid(state, requestId, {
				...paid,
				operation: null,
				flight: null,
				result: null,
			});
	}
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
	Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
		Effect.mapError(() => new HttpError(400, 'Invalid JSON import.')),
	);

export const classifyOne = Effect.fn('Organizer.classifyOne')(function* (
	store: Pick<Store, 'load' | 'modify'>,
	input: typeof PaidInput.Type,
) {
	let state = (yield* store.load()).state;
	let paidRequest = paidState(state, input.requestId);
	if (paidRequest.completed?.requestId === input.requestId) {
		if (paidRequest.completed.appid !== input.appid)
			return yield* Effect.fail(
				new HttpError(409, 'Request ID reused for a different game.'),
			);
		return state;
	}
	if (
		paidRequest.flight?.requestId === input.requestId &&
		paidRequest.result?.requestId === input.requestId &&
		paidRequest.flight.appid === input.appid
	)
		return yield* store.modify((current) =>
			applyResult(current, input.requestId, input.appid),
		);
	const game = state.library.games.find((game) => game.appid === input.appid);
	if (!game) return yield* Effect.fail(new HttpError(404, 'Game missing.'));
	const steam = yield* Steam;
	const crypto = yield* Crypto.Crypto;
	const description = yield* steam.fetchGameDescription(input.appid);
	const operationId = yield* crypto.randomUUIDv4;
	state = yield* store.modify((current) => {
		const paid = paidState(current, input.requestId);
		if (paid.completed?.requestId === input.requestId) {
			if (paid.completed.appid !== input.appid)
				throw new HttpError(409, 'Request ID reused for a different game.');
			return current;
		}
		if (
			state.job &&
			(current.job?.id !== state.job.id ||
				!activeJob(current) ||
				current.job.ids[jobIndex(current, input.requestId)] !== input.appid ||
				(current.requests === undefined &&
					input.requestId !== `${current.job.id}:${current.job.completed}`))
		)
			throw new HttpError(409, 'Job is no longer active at this game.');
		if (
			activeJob(current) &&
			!input.requestId.startsWith(`${current.job!.id}:`)
		)
			throw new HttpError(409, 'A classification job is active.');
		if (current.job?.cancel) return current;
		unlocked({ ...current, ...paid, job: null, requests: {} });
		if (
			current.library.steamId !== state.library.steamId ||
			!current.library.games.some(
				(candidateGame) =>
					candidateGame.appid === input.appid &&
					candidateGame.name === game.name,
			)
		)
			throw new HttpError(409, 'Library changed. Try again.');
		return updatePaid(current, input.requestId, {
			...paid,
			flight: { requestId: input.requestId, appid: input.appid },
			operation: { id: operationId, expiresAt: Date.now() + 120_000 },
		});
	});
	paidRequest = paidState(state, input.requestId);
	if (state.job?.cancel || paidRequest.completed?.requestId === input.requestId)
		return state;
	const paid = Effect.gen(function* () {
		const classifier = yield* Classifier;
		const tags = yield* classifier.classifyGame(
			{ ...game, description },
			input.criteria,
		);
		yield* store.modify((current) => {
			const paid = paidState(current, input.requestId);
			if (
				paid.operation?.id !== operationId ||
				paid.flight?.requestId !== input.requestId
			)
				throw new HttpError(409, 'Classification lease lost.');
			return updatePaid(current, input.requestId, {
				...paid,
				result: { requestId: input.requestId, appid: input.appid, tags },
			});
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
					paidState(current, input.requestId).operation?.id === operationId
						? updatePaid(current, input.requestId, {
								...paidState(current, input.requestId),
								operation: null,
							})
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
	const paid = paidState(current, requestId);
	if (
		paid.flight?.requestId !== requestId ||
		paid.flight.appid !== appid ||
		paid.result?.requestId !== requestId ||
		paid.result.appid !== appid
	)
		return current;
	const tags = paid.result.tags;
	return {
		...updatePaid(current, requestId, {
			operation: null,
			flight: null,
			result: null,
			completed: { requestId, appid },
		}),
		...(current.job &&
		(current.requests !== undefined ||
			requestId === `${current.job.id}:${current.job.completed}`) &&
		current.job.ids[jobIndex(current, requestId)] === appid
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
export const cancelJob = Effect.fn('Organizer.cancelJob')(function* (
	env: Env,
	identity: string,
) {
	const store = new Store(env.DB, identity);
	const respond = (state: Document) => stateResponse(state, env, identity);
	return respond(
		yield* store.modify((state) =>
			activeJob(state)
				? { ...state, job: { ...state.job!, cancel: true } }
				: state,
		),
	);
});
export const saveCriteria = Effect.fn('Organizer.saveCriteria')(function* (
	input: typeof CriteriaInput.Type,
	env: Env,
	identity: string,
) {
	const store = new Store(env.DB, identity);
	const respond = (state: Document) => stateResponse(state, env, identity);
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
});
export const saveTags = Effect.fn('Organizer.saveTags')(function* (
	input: typeof TagsInput.Type,
	env: Env,
	identity: string,
) {
	const store = new Store(env.DB, identity);
	const respond = (state: Document) => stateResponse(state, env, identity);
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
});
export const recoverClassification = Effect.fn(
	'Organizer.recoverClassification',
)(function* (env: Env, identity: string) {
	const store = new Store(env.DB, identity);
	return stateResponse(yield* store.modify(recover), env, identity);
});
export const startClassification = Effect.fn('Organizer.startClassification')(
	function* (input: typeof ClassifyInput.Type, env: Env, identity: string) {
		const store = new Store(env.DB, identity);
		const respond = (state: Document) => stateResponse(state, env, identity);
		if (!env.TYPESAFE_API_KEY)
			return yield* Effect.fail(
				new HttpError(400, 'Classification is not configured.'),
			);
		const crypto = yield* Crypto.Crypto;
		const id = yield* crypto.randomUUIDv4;
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
				requests: {},
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
			yield* ensureStarted(env.CLASSIFICATION, identity, id).pipe(
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
	},
);
export const importCollections = Effect.fn('Organizer.importCollections')(
	function* (input: typeof ImportInput.Type, env: Env, identity: string) {
		const store = new Store(env.DB, identity);
		const respond = (state: Document) => stateResponse(state, env, identity);
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
	},
);
const replaceLibrary = Effect.fn('Organizer.replaceLibrary')(function* <
	Error,
	Requirements,
>(
	env: Env,
	identity: string,
	loadLibrary: (
		previous: Library,
	) => Effect.Effect<Library, Error, Requirements>,
) {
	const store = new Store(env.DB, identity);
	const crypto = yield* Crypto.Crypto;
	const operationId = yield* crypto.randomUUIDv4;
	const snapshot = yield* store.modify((state) => ({
		...unlocked(state),
		operation: { id: operationId, expiresAt: Date.now() + 120_000 },
	}));
	return yield* Effect.gen(function* () {
		const imported = yield* loadLibrary(snapshot.library);
		return stateResponse(
			yield* store.modify((state) => {
				if (state.flight || state.operation?.id !== operationId)
					throw new HttpError(409, 'Library changed. Try again.');
				return { ...state, library: imported, operation: null };
			}),
			env,
			identity,
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
export const importLibrary = (
	input: typeof ImportInput.Type,
	env: Env,
	identity: string,
) =>
	replaceLibrary(env, identity, (previous) =>
		Effect.gen(function* () {
			const value = yield* parseJson(input.text);
			if (typeof value === 'object' && value !== null && 'version' in value)
				return yield* decode(Library, value);
			const libraryService = yield* LibraryService;
			return mergeLibrary(
				previous,
				yield* libraryService.decodeImport(input.text),
				previous.steamId,
			);
		}),
	);
export const restoreLibrary = (
	input: typeof ImportInput.Type,
	env: Env,
	identity: string,
) =>
	replaceLibrary(env, identity, () =>
		decode(Schema.fromJsonString(Library), input.text),
	);
export const syncLibrary = (
	input: typeof SyncInput.Type,
	env: Env,
	identity: string,
) =>
	replaceLibrary(env, identity, (previous) =>
		Effect.gen(function* () {
			const steam = yield* Steam;
			const ownedGames = yield* steam.fetchLibrary(input.steamId);
			const library =
				previous.steamId === null || previous.steamId === input.steamId
					? previous
					: emptyLibrary();
			return mergeLibrary(library, ownedGames, input.steamId);
		}),
	);
