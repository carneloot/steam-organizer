import { Context, type Effect, Schema } from 'effect';

import type { CategoryCriteria } from '../domain/classification.js';

export class CollectionsDecodeError extends Schema.TaggedError<CollectionsDecodeError>()(
	'CollectionsDecodeError',
	{ message: Schema.String },
) {}
export class NoActiveCollectionsError extends Schema.TaggedError<NoActiveCollectionsError>()(
	'NoActiveCollectionsError',
	{ message: Schema.String },
) {}

export class Collections extends Context.Service<
	Collections,
	{
		readonly extractCategoryCriteria: (
			input: string,
		) => Effect.Effect<
			CategoryCriteria,
			CollectionsDecodeError | NoActiveCollectionsError
		>;
	}
>()('steam-categorizer/Collections') {}
