import { Context, type Effect } from 'effect';

import type { CategoryCriteria } from '../domain/classification.js';
import type { AppError } from '../domain/library.js';

export class Collections extends Context.Service<
	Collections,
	{
		readonly extractCategoryCriteria: (
			input: string,
		) => Effect.Effect<CategoryCriteria, AppError>;
	}
>()('steam-categorizer/Collections') {}
