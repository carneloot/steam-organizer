import { Cause, Crypto, Effect, Schema } from 'effect';

import { CategoryCriteria } from '../../src/domain/classification.js';
import {
	Library,
	emptyLibrary,
	mergeLibrary,
} from '../../src/domain/library.js';
import {
	Classifier,
	ClassificationDeferred,
	ClassificationRequestError,
	ClassificationResponseError,
	ClassificationTimeoutError,
} from '../../src/services/classifier.js';
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
import { Store, type View } from './store.js';
import { ensureStarted } from './workflow.js';

export const stateResponse = (state: View, env: Env, identity: string) => ({
	library: state.library,
	identity,
	criteria: state.criteria,
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
const respond = (store: Store['Service'], env: Env, identity: string) =>
	store
		.getView()
		.pipe(Effect.map((view) => stateResponse(view, env, identity)));
const decode = <A>(schema: Schema.Decoder<A>, body: unknown) =>
	Schema.decodeUnknownEffect(schema)(body).pipe(
		Effect.mapError(() => new HttpError(400, 'Invalid request body.')),
	);
const parseJson = (text: string) =>
	Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
		Effect.mapError(() => new HttpError(400, 'Invalid JSON import.')),
	);

export const classifyOne = Effect.fn('Organizer.classifyOne')(
	function* (input: {
		jobId: string;
		index: number;
		appid: number;
		criteria: CategoryCriteria;
	}) {
		const store = yield* Store;
		const requestId = `${input.jobId}:${input.index}`;
		const request = yield* store.getRequest(requestId);
		if (
			request &&
			(request.appid !== input.appid || request.jobId !== input.jobId)
		)
			return yield* Effect.fail(
				new HttpError(409, 'Request ID reused for a different game.'),
			);
		if (request?.completed) return;
		if (request?.tags !== null && request?.tags !== undefined)
			return yield* store.applyResult(requestId);
		if (request)
			return yield* Effect.fail(
				new HttpError(
					409,
					request.expiresAt !== null && request.expiresAt > Date.now()
						? 'An operation is active.'
						: 'Paid outcome uncertain. Confirm recovery before continuing.',
				),
			);
		const selected = yield* store.getGame(input.appid);
		if (!selected)
			return yield* Effect.fail(new HttpError(404, 'Game missing.'));
		const steam = yield* Steam;
		const crypto = yield* Crypto.Crypto;
		yield* Effect.logInfo('Classification game started', {
			jobId: input.jobId,
			index: input.index,
			appid: input.appid,
			name: selected.game.name,
		});
		const description = yield* steam.fetchGameDescription(input.appid);
		const operationId = yield* crypto.randomUUIDv4;
		const claimed = yield* store.claimRequest({
			...input,
			name: selected.game.name,
			steamId: selected.steamId,
			operationId,
		});
		if (!claimed) return yield* store.applyResult(requestId);
		let stage = 'provider';
		return yield* Effect.gen(function* () {
			const classifier = yield* Classifier;
			const tags = yield* classifier.classifyGame(
				{ ...selected.game, description },
				input.criteria,
			);
			stage = 'save-result';
			yield* store.saveResult(requestId, operationId, tags);
			stage = 'apply-result';
			yield* store.applyResult(requestId);
			yield* Effect.logInfo('Classification game completed', {
				jobId: input.jobId,
				appid: input.appid,
				name: selected.game.name,
			});
		}).pipe(
			Effect.timeout('45 seconds'),
			Effect.catchCause((cause) =>
				Effect.gen(function* () {
					const error = Cause.squash(cause);
					if (
						Schema.is(ClassificationDeferred)(error) ||
						(Schema.is(ClassificationRequestError)(error) &&
							error.status === 429)
					) {
						// A pre-send deferral or explicit 429 rejection has no uncertain paid result.
						yield* store.discardRejectedRequest(requestId, operationId);
						return yield* error;
					}
					const detail = Schema.is(
						Schema.Union([
							ClassificationRequestError,
							ClassificationResponseError,
							ClassificationTimeoutError,
						]),
					)(error)
						? error.message
						: error instanceof HttpError
							? error.message
							: 'Classification or result persistence failed.';
					yield* Effect.logError('Classification game failed', {
						jobId: input.jobId,
						index: input.index,
						appid: input.appid,
						name: selected.game.name,
						stage,
						...(Schema.is(ClassificationRequestError)(error)
							? { status: error.status, requestId: error.requestId }
							: {}),
						detail,
					});
					return yield* Effect.fail(
						new HttpError(
							409,
							`${selected.game.name} (appid ${input.appid}, ${stage}): ${detail} Paid outcome uncertain. No request was repeated. Retry the same request to apply a saved result, or confirm recovery.`,
						),
					);
				}),
			),
			Effect.ensuring(
				store.releaseRequest(requestId, operationId).pipe(Effect.orDie),
			),
		);
	},
);

export const cancelJob = Effect.fn('Organizer.cancelJob')(function* (
	env: Env,
	identity: string,
) {
	const store = yield* Store;
	yield* store.cancelJob();
	return yield* respond(store, env, identity);
});
export const saveCriteria = Effect.fn('Organizer.saveCriteria')(function* (
	input: typeof CriteriaInput.Type,
	env: Env,
	identity: string,
) {
	const store = yield* Store;
	yield* store.saveCriteria(input);
	return yield* respond(store, env, identity);
});
export const saveTags = Effect.fn('Organizer.saveTags')(function* (
	input: typeof TagsInput.Type,
	env: Env,
	identity: string,
) {
	const store = yield* Store;
	yield* store.saveTags(input);
	return yield* respond(store, env, identity);
});
export const recoverClassification = Effect.fn(
	'Organizer.recoverClassification',
)(function* (env: Env, identity: string) {
	const store = yield* Store;
	const crypto = yield* Crypto.Crypto;
	yield* store.recoverRequests(yield* crypto.randomUUIDv4);
	return yield* respond(store, env, identity);
});
export const startClassification = Effect.fn('Organizer.startClassification')(
	function* (input: typeof ClassifyInput.Type, env: Env, identity: string) {
		const store = yield* Store;
		if (!env.TYPESAFE_API_KEY)
			return yield* Effect.fail(
				new HttpError(400, 'Classification is not configured.'),
			);
		const crypto = yield* Crypto.Crypto;
		const id = yield* crypto.randomUUIDv4;
		yield* store.startJob(id, input);
		yield* ensureStarted(env.CLASSIFICATION, identity, id).pipe(
			Effect.catch(() =>
				store.failJob(id, 'Classification could not start. Try a new job.'),
			),
		);
		return yield* respond(store, env, identity);
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
	const store = yield* Store;
	const crypto = yield* Crypto.Crypto;
	const operationId = yield* crypto.randomUUIDv4;
	const snapshot = yield* store.claimLibrary(operationId);
	return yield* Effect.gen(function* () {
		const imported = yield* loadLibrary(snapshot.library);
		yield* store.replaceLibrary(imported, operationId, snapshot.revision);
		return yield* respond(store, env, identity);
	}).pipe(
		Effect.ensuring(store.releaseLibrary(operationId).pipe(Effect.orDie)),
	);
});
export const importCollections = (
	input: typeof ImportInput.Type,
	env: Env,
	identity: string,
) =>
	replaceLibrary(env, identity, (previous) =>
		Effect.try({
			try: () => attachCollections(previous, parseCollections(input.text)),
			catch: () => new HttpError(400, 'Invalid Steam collections file.'),
		}),
	);
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
