import { Context, type Effect } from 'effect';

import type {
	CategoryCriteria,
	ClassificationGame,
} from '../domain/classification.js';
import type { AppError } from '../domain/library.js';

export class Classifier extends Context.Service<
	Classifier,
	{
		readonly classifyGame: (
			game: ClassificationGame,
			criteria?: CategoryCriteria,
		) => Effect.Effect<string[], AppError>;
	}
>()('steam-categorizer/Classifier') {}
