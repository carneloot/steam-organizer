import { Context, type Effect, Schema } from 'effect';

import type {
	CategoryCriteria,
	ClassificationGame,
} from '../domain/classification.js';
import type { ConfigurationError } from './app-config.js';

export class ClassificationDeferred extends Schema.TaggedError<ClassificationDeferred>()(
	'ClassificationDeferred',
	{ message: Schema.String, retryAfterMs: Schema.Finite },
) {}

export class ClassificationRequestError extends Schema.TaggedError<ClassificationRequestError>()(
	'ClassificationRequestError',
	{
		message: Schema.String,
		status: Schema.optionalKey(Schema.Finite),
		retryAfterMs: Schema.optionalKey(Schema.Finite),
		requestId: Schema.optionalKey(Schema.String),
	},
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
			| ClassificationDeferred
			| ClassificationRequestError
			| ClassificationResponseError
			| ClassificationTimeoutError
		>;
	}
>()('steam-categorizer/Classifier') {}
