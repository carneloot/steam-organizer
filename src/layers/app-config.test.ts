import { assert, describe, it } from '@effect/vitest';
import { ConfigProvider, Effect, Redacted } from 'effect';

import { AppConfig } from '../services/app-config.js';
import { AppConfigLayer } from './app-config.js';

describe('AppConfig', () => {
	it.effect('loads both credentials as plain redacted values', () =>
		Effect.gen(function* () {
			const config = yield* AppConfig;
			assert.isNotNull(config.jevApiKey);
			assert.isNotNull(config.steamApiKey);
			if (config.jevApiKey === null || config.steamApiKey === null) return;
			assert.strictEqual(Redacted.value(config.jevApiKey), 'jev-secret');
			assert.strictEqual(Redacted.value(config.steamApiKey), 'steam-secret');
			assert.notInclude(JSON.stringify(config), 'jev-secret');
			assert.notInclude(JSON.stringify(config), 'steam-secret');
		}).pipe(
			Effect.provide(AppConfigLayer),
			Effect.provide(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						TYPESAFE_API_KEY: 'jev-secret',
						STEAM_API_KEY: 'steam-secret',
					}),
				),
			),
		),
	);
	it.effect('allows unset credentials for offline commands', () =>
		Effect.gen(function* () {
			const config = yield* AppConfig;
			assert.strictEqual(config.jevApiKey, null);
			assert.strictEqual(config.steamApiKey, null);
		}).pipe(
			Effect.provide(AppConfigLayer),
			Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
		),
	);
	it.effect.each(['TYPESAFE_API_KEY', 'STEAM_API_KEY'])(
		'rejects whitespace-only %s during layer construction',
		(name) =>
			Effect.gen(function* () {
				const error = yield* Effect.flatMap(AppConfig, () =>
					Effect.die('invalid configuration must fail before service use'),
				).pipe(
					Effect.provide(AppConfigLayer),
					Effect.provide(
						ConfigProvider.layer(
							ConfigProvider.fromUnknown({ [name]: ' \t ' }),
						),
					),
					Effect.flip,
				);
				assert.strictEqual(error._tag, 'ConfigurationError');
				assert.include(error.message, name);
			}),
	);
	it.effect(
		'reports configuration source failures without leaking values',
		() =>
			Effect.gen(function* () {
				const error = yield* Effect.flatMap(AppConfig, Effect.succeed).pipe(
					Effect.provide(AppConfigLayer),
					Effect.provide(
						ConfigProvider.layer(
							ConfigProvider.make(() =>
								Effect.fail(
									new ConfigProvider.SourceError({ message: 'do-not-log' }),
								),
							),
						),
					),
					Effect.flip,
				);
				assert.strictEqual(error._tag, 'ConfigurationError');
				assert.notInclude(JSON.stringify(error), 'do-not-log');
			}),
	);
});
