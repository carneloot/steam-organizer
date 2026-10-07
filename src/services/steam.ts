import { Context, type Effect } from 'effect';

import type { AppError, SteamGame } from '../domain/library.js';
import type { ConfigurationError } from './app-config.js';

export class Steam extends Context.Service<
	Steam,
	{
		readonly fetchLibrary: (
			steamId: string,
		) => Effect.Effect<ReadonlyArray<SteamGame>, AppError | ConfigurationError>;
		readonly fetchGameDescription: (
			appid: number,
		) => Effect.Effect<string | null>;
	}
>()('steam-categorizer/Steam') {}
