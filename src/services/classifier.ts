import { Context, type Effect } from 'effect';

import type {
	CategoryCriteria,
	ClassificationGame,
} from '../domain/classification.js';
import type { AppError } from '../domain/library.js';
import type { ConfigurationError } from './app-config.js';

export class Classifier extends Context.Service<
	Classifier,
	{
		readonly classifyGame: (
			game: ClassificationGame,
			criteria?: CategoryCriteria,
		) => Effect.Effect<string[], AppError | ConfigurationError>;
	}
>()('steam-categorizer/Classifier') {}
