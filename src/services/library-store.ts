import { Context, type Effect } from 'effect';

import type { AppError, Library } from '../domain/library.js';

export class LibraryStore extends Context.Service<
	LibraryStore,
	{
		readonly load: (file: string) => Effect.Effect<Library, AppError>;
		readonly modify: (
			file: string,
			update: (library: Library) => Effect.Effect<Library, AppError>,
		) => Effect.Effect<Library, AppError>;
	}
>()('steam-categorizer/LibraryStore') {}
