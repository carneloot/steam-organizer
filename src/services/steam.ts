import { Context, type Effect } from 'effect';

import type { AppError, SteamGame } from '../domain/library.js';

export class Steam extends Context.Service<
	Steam,
	{
		readonly fetchLibrary: (
			steamId: string,
		) => Effect.Effect<ReadonlyArray<SteamGame>, AppError>;
		readonly fetchGameDescription: (
			appid: number,
		) => Effect.Effect<string | null>;
	}
>()('steam-categorizer/Steam') {}
