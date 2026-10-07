import { Context, type Effect, Schema } from 'effect';

import type { SteamGame } from '../domain/library.js';
import type { ConfigurationError } from './app-config.js';
import type { InvalidOwnedGamesError } from './library.js';

export class SteamRequestError extends Schema.TaggedError<SteamRequestError>()(
	'SteamRequestError',
	{ message: Schema.String },
) {}
export class SteamResponseError extends Schema.TaggedError<SteamResponseError>()(
	'SteamResponseError',
	{ message: Schema.String },
) {}
export class SteamTimeoutError extends Schema.TaggedError<SteamTimeoutError>()(
	'SteamTimeoutError',
	{ message: Schema.String },
) {}

export class Steam extends Context.Service<
	Steam,
	{
		readonly fetchLibrary: (
			steamId: string,
		) => Effect.Effect<
			ReadonlyArray<SteamGame>,
			| ConfigurationError
			| SteamRequestError
			| SteamResponseError
			| SteamTimeoutError
			| InvalidOwnedGamesError
		>;
		readonly fetchGameDescription: (
			appid: number,
		) => Effect.Effect<string | null>;
	}
>()('steam-categorizer/Steam') {}
