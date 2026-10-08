import { it } from '@effect/vitest';
import { Effect, Layer, Logger } from 'effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientError from 'effect/http/HttpClientError';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import { expect } from 'vitest';

import { cloudflarePlanDiagnostics } from './cloudflare-plan-diagnostics.js';

it.effect(
	'logs the operation and status without identifiers, headers, queries, or bodies',
	() => {
		const messages: Array<unknown> = [];
		const client = HttpClient.make((request) =>
			Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					new Response('response-secret', {
						status: 403,
						headers: { 'x-secret': 'response-header-secret' },
					}),
				),
			),
		);
		return Effect.gen(function* () {
			const diagnosticClient = yield* HttpClient.HttpClient;
			const request = HttpClientRequest.post(
				'https://api.cloudflare.com/client/v4/accounts/account-secret/access/identity_providers/provider-secret?token=query-secret',
			).pipe(
				HttpClientRequest.bearerToken('bearer-secret'),
				HttpClientRequest.bodyText('request-body-secret'),
			);
			const response = yield* diagnosticClient.execute(request);
			expect(response.status).toBe(403);
			expect(yield* response.text).toBe('response-secret');
			yield* diagnosticClient.get(
				'https://api.cloudflare.com/client/v4/accounts/workers/access/identity_providers/policies',
			);
			expect(messages.flat()).toEqual([
				'Cloudflare API POST /client/v4/accounts/:id/access/identity_providers/:id: HTTP 403',
				'Cloudflare API GET /client/v4/accounts/:id/access/identity_providers/:id: HTTP 403',
			]);
		}).pipe(
			Effect.provide([
				cloudflarePlanDiagnostics.pipe(
					Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
				),
				Logger.layer([Logger.make(({ message }) => messages.push(message))]),
			]),
		);
	},
);

it.effect(
	'preserves transport failures without logging their secret-bearing error',
	() => {
		const messages: Array<unknown> = [];
		const client = HttpClient.make((request) =>
			Effect.fail(
				new HttpClientError.HttpClientError({
					reason: new HttpClientError.TransportError({
						request,
						cause: 'private-error-secret',
					}),
				}),
			),
		);
		return Effect.gen(function* () {
			const diagnosticClient = yield* HttpClient.HttpClient;
			const error = yield* Effect.flip(
				diagnosticClient.get(
					'https://api.cloudflare.com/client/v4/zones?name=private-domain-secret',
				),
			);
			expect(error.reason).toMatchObject({ cause: 'private-error-secret' });
			expect(error.request.url).toBe(
				'https://api.cloudflare.com/client/v4/zones?name=private-domain-secret',
			);
			expect(messages.flat()).toEqual([
				'Cloudflare API GET /client/v4/zones: transport failure',
			]);
		}).pipe(
			Effect.provide([
				cloudflarePlanDiagnostics.pipe(
					Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
				),
				Logger.layer([Logger.make(({ message }) => messages.push(message))]),
			]),
		);
	},
);

it.effect(
	'leaves non-Cloudflare traffic unlogged and successful responses unchanged',
	() => {
		const messages: Array<unknown> = [];
		const client = HttpClient.make((request) =>
			Effect.succeed(HttpClientResponse.fromWeb(request, new Response('ok'))),
		);
		return Effect.gen(function* () {
			const diagnosticClient = yield* HttpClient.HttpClient;
			const response = yield* diagnosticClient.get(
				'https://api.cloudflare.com.evil.test/client/v4/accounts/private-secret',
			);
			expect(yield* response.text).toBe('ok');
			expect(messages).toEqual([]);
			yield* diagnosticClient.get(
				'https://api.cloudflare.com/client/v4/accounts/account-secret/d1/database/database-secret',
			);
			yield* diagnosticClient.get(
				'https://api.cloudflare.com/client/v4/accounts/account-secret/unknown-private-operation/other-secret',
			);
			expect(messages.flat()).toEqual([
				'Cloudflare API GET /client/v4/accounts/:id/d1/database/:id: HTTP 200',
				'Cloudflare API GET /client/v4/[unrecognized-route]: HTTP 200',
			]);
		}).pipe(
			Effect.provide([
				cloudflarePlanDiagnostics.pipe(
					Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
				),
				Logger.layer([Logger.make(({ message }) => messages.push(message))]),
			]),
		);
	},
);
