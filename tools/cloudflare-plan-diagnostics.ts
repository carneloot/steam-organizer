import { Effect, Layer } from 'effect';
import * as HttpClient from 'effect/http/HttpClient';

// Emit only fixed templates, never path components taken from requests.
const routes = [
	'/zones',
	'/zones/:id/workers/routes',
	'/zones/:id/workers/routes/:id',
	'/accounts/:id/workers/subdomain',
	'/accounts/:id/workers/subdomain/edge-preview',
	'/accounts/:id/workers/scripts',
	'/accounts/:id/workers/scripts/:id',
	'/accounts/:id/workers/scripts/:id/settings',
	'/accounts/:id/workers/scripts/:id/subdomain',
	'/accounts/:id/workers/scripts/:id/edge-preview',
	'/accounts/:id/workers/scripts/:id/schedules',
	'/accounts/:id/workers/domains',
	'/accounts/:id/workers/domains/:id',
	'/accounts/:id/workflows/:id',
	'/accounts/:id/workers/durable_objects/namespaces',
	'/accounts/:id/d1/database',
	'/accounts/:id/d1/database/:id',
	'/accounts/:id/access/apps',
	'/accounts/:id/access/apps/:id',
	'/accounts/:id/access/apps/:id/policies',
	'/accounts/:id/access/apps/:id/policies/:id',
	'/accounts/:id/access/identity_providers',
	'/accounts/:id/access/identity_providers/:id',
	'/accounts/:id/secrets_store/stores',
	'/accounts/:id/secrets_store/stores/:id/secrets',
	'/user/tokens/verify',
].map((template) => ({
	template: `/client/v4${template}`,
	pattern: new RegExp(`^/client/v4${template.replaceAll(':id', '[^/]+')}$`),
}));

export const cloudflarePlanDiagnostics = Layer.effect(
	HttpClient.HttpClient,
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		return HttpClient.transform(client, (responseEffect, request) => {
			if (!request.url.startsWith('https://api.cloudflare.com/client/v4/')) {
				return responseEffect;
			}
			const path = new URL(request.url).pathname;
			const route =
				routes.find(({ pattern }) => pattern.test(path))?.template ??
				'/client/v4/[unrecognized-route]';
			const operation = `Cloudflare API ${request.method} ${route}`;
			return responseEffect.pipe(
				Effect.tap((response) =>
					Effect.logInfo(`${operation}: HTTP ${response.status}`),
				),
				Effect.tapError(() =>
					Effect.logWarning(`${operation}: transport failure`),
				),
			);
		});
	}),
);
