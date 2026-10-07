import { Context, type Effect, Schema } from 'effect';

import type { Library } from '../domain/library.js';

export class LibraryReadError extends Schema.TaggedError<LibraryReadError>()(
	'LibraryReadError',
	{ message: Schema.String },
) {}
export class InvalidLibraryError extends Schema.TaggedError<InvalidLibraryError>()(
	'InvalidLibraryError',
	{ message: Schema.String },
) {}
export class LibraryLockedError extends Schema.TaggedError<LibraryLockedError>()(
	'LibraryLockedError',
	{ message: Schema.String },
) {}
export class LibraryWriteError extends Schema.TaggedError<LibraryWriteError>()(
	'LibraryWriteError',
	{ message: Schema.String },
) {}

export class LibraryStore extends Context.Service<
	LibraryStore,
	{
		readonly load: (
			file: string,
		) => Effect.Effect<Library, LibraryReadError | InvalidLibraryError>;
		readonly modify: <E, R>(
			file: string,
			update: (library: Library) => Effect.Effect<Library, E, R>,
		) => Effect.Effect<
			Library,
			| E
			| LibraryReadError
			| InvalidLibraryError
			| LibraryLockedError
			| LibraryWriteError,
			R
		>;
	}
>()('steam-categorizer/LibraryStore') {}
