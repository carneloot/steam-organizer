import { Config, Effect, Layer, Option, Schema } from 'effect';

import { AppConfig, ConfigurationError } from '../services/app-config.js';

const apiKey = Effect.fn('AppConfig.apiKey')(function* (name: string) {
	const key = yield* Config.option(
		Config.schema(
			Schema.Redacted(Schema.String.check(Schema.isPattern(/\S/))),
			name,
		),
	).pipe(
		Effect.mapError(
			() =>
				new ConfigurationError({
					message: `Cannot load ${name}. API keys must not be empty.`,
				}),
		),
	);
	return Option.getOrNull(key);
});

export const AppConfigLayer = Layer.effect(
	AppConfig,
	Effect.gen(function* () {
		const jevApiKey = yield* apiKey('TYPESAFE_API_KEY');
		const steamApiKey = yield* apiKey('STEAM_API_KEY');
		return AppConfig.of({
			jevApiKey,
			steamApiKey,
		});
	}),
);
