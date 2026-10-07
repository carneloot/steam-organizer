import { BrowserCrypto } from '@effect/platform-browser';
import { Layer, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { JevLayer } from '../../src/layers/jev.js';
import { LibraryLayer } from '../../src/layers/library.js';
import { SteamLayer } from '../../src/layers/steam.js';
import { AppConfig } from '../../src/services/app-config.js';
import { limiterLayer } from './rate-limit.js';

export interface Env {
	DB: D1Database;
	CLASSIFICATION: Workflow<{ owner: string; id: string }>;
	COORDINATOR: DurableObjectNamespace;
	STEAM_API_KEY?: string;
	TYPESAFE_API_KEY?: string;
	LOCAL_DEV?: string;
	ASSETS: Fetcher;
}
export function services(env: Env) {
	const dependencies = Layer.mergeAll(
		LibraryLayer,
		FetchHttpClient.layer,
		limiterLayer(env.COORDINATOR),
		Layer.succeed(
			AppConfig,
			AppConfig.of({
				steamApiKey: env.STEAM_API_KEY
					? Redacted.make(env.STEAM_API_KEY)
					: null,
				jevApiKey: env.TYPESAFE_API_KEY
					? Redacted.make(env.TYPESAFE_API_KEY)
					: null,
			}),
		),
	);
	return Layer.mergeAll(
		BrowserCrypto.layer,
		SteamLayer.pipe(Layer.provide(dependencies)),
		JevLayer.pipe(Layer.provide(dependencies)),
		LibraryLayer,
	);
}
