import { Effect, Layer, Schema } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { exportLibrary } from '../../src/domain/library.js';
import {
	ClassifyInput,
	CriteriaInput,
	ImportInput,
	RecoveryInput,
	SyncInput,
	TagsInput,
} from '../shared.js';
import * as Business from './business.js';
import { HttpError, json, readBody, requestError } from './security.js';
import { type Env } from './services.js';
import { Store } from './store.js';
import { reconcile } from './workflow.js';

export const apiHandler = (env: Env, identity: string) =>
	HttpRouter.toHttpEffect(
		Layer.effectDiscard(
			Effect.gen(function* () {
				const router = yield* HttpRouter.HttpRouter;
				const mutation = <Input, Error, Requirements>(
					schema: Schema.Codec<Input>,
					operation: (
						input: Input,
					) => Effect.Effect<unknown, Error, Requirements>,
				) =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const body = yield* Effect.tryPromise({
							try: () => readBody(request.source as Request),
							catch: requestError,
						});
						const input = yield* Schema.decodeUnknownEffect(schema)(body).pipe(
							Effect.mapError(
								() => new HttpError(400, 'Invalid request body.'),
							),
						);
						return HttpServerResponse.fromWeb(json(yield* operation(input)));
					});
				yield* router.add(
					'POST',
					'/api/jobs/cancel',
					mutation(Schema.Struct({}), () => Business.cancelJob(env, identity)),
				);
				yield* router.add(
					'POST',
					'/api/criteria',
					mutation(CriteriaInput, (input) =>
						Business.saveCriteria(input, env, identity),
					),
				);
				yield* router.add(
					'POST',
					'/api/tags',
					mutation(TagsInput, (input) =>
						Business.saveTags(input, env, identity),
					),
				);
				yield* router.add(
					'POST',
					'/api/classify/recover',
					mutation(RecoveryInput, () =>
						Business.recoverClassification(env, identity),
					),
				);
				yield* router.add(
					'POST',
					'/api/classify',
					mutation(ClassifyInput, (input) =>
						Business.startClassification(input, env, identity),
					),
				);
				yield* router.add(
					'POST',
					'/api/steam-collections',
					mutation(ImportInput, (input) =>
						Business.importCollections(input, env, identity),
					),
				);
				yield* router.add(
					'POST',
					'/api/import',
					mutation(ImportInput, (input) =>
						Business.importLibrary(input, env, identity),
					),
				);
				yield* router.add(
					'POST',
					'/api/restore',
					mutation(ImportInput, (input) =>
						Business.restoreLibrary(input, env, identity),
					),
				);
				yield* router.add(
					'POST',
					'/api/sync',
					mutation(SyncInput, (input) =>
						Business.syncLibrary(input, env, identity),
					),
				);
				yield* router.add(
					'GET',
					'/api/state',
					Effect.gen(function* () {
						yield* reconcile(env, identity).pipe(Effect.mapError(requestError));
						const store = yield* Store;
						const state = yield* store.getView();
						return HttpServerResponse.fromWeb(
							json(Business.stateResponse(state, env, identity)),
						);
					}),
				);
				yield* router.add(
					'GET',
					'/api/backup',
					Effect.gen(function* () {
						const store = yield* Store;
						const library = yield* store.getLibrary();
						return HttpServerResponse.fromWeb(json(library));
					}),
				);
				yield* router.add(
					'GET',
					'/api/export',
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const format = new URL(
							request.url,
							'http://localhost',
						).searchParams.get('format');
						if (format !== 'json' && format !== 'csv')
							return yield* Effect.fail(
								new HttpError(400, 'Unknown export format.'),
							);
						const store = yield* Store;
						const library = yield* store.getLibrary();
						return HttpServerResponse.text(exportLibrary(library, format), {
							headers: {
								'content-type':
									format === 'csv' ? 'text/csv' : 'application/json',
								'cache-control': 'no-store',
								'content-disposition': `attachment; filename="steam-library.${format}"`,
								'x-content-type-options': 'nosniff',
							},
						});
					}),
				);
				yield* router.add(
					'*',
					'/api/*',
					Effect.fail(new HttpError(404, 'Unknown API route.')),
				);
			}),
		),
	).pipe(Effect.flatten, Effect.provide(Store.layer(env.DB, identity)));
