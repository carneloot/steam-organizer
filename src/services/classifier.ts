import { Context, type Effect, Schema } from 'effect';

import type {
	CategoryCriteria,
	ClassificationGame,
} from '../domain/classification.js';
import type { ConfigurationError } from './app-config.js';

export class ClassificationRequestError extends Schema.TaggedError<ClassificationRequestError>()(
	'ClassificationRequestError',
	{ message: Schema.String },
) {}
export class ClassificationResponseError extends Schema.TaggedError<ClassificationResponseError>()(
	'ClassificationResponseError',
	{ message: Schema.String },
) {}
export class ClassificationTimeoutError extends Schema.TaggedError<ClassificationTimeoutError>()(
	'ClassificationTimeoutError',
	{ message: Schema.String },
) {}

export class Classifier extends Context.Service<
	Classifier,
	{
		readonly classifyGame: (
			game: ClassificationGame,
			criteria?: CategoryCriteria,
		) => Effect.Effect<
			string[],
			| ConfigurationError
			| ClassificationRequestError
			| ClassificationResponseError
			| ClassificationTimeoutError
		>;
	}
>()('steam-categorizer/Classifier') {}
