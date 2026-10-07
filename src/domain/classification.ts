import { Schema } from 'effect';

import { Category, type Game } from './library.js';

export interface ClassificationGame extends Pick<Game, 'appid' | 'name'> {
	readonly description: string | null;
}

export const CategoryCriteria = Schema.Record(
	Schema.String,
	Schema.NonEmptyString.check(Schema.isTrimmed()),
).check(Schema.isMinProperties(1), Schema.isPropertyNames(Category));
export interface CategoryCriteria extends Schema.Schema.Type<
	typeof CategoryCriteria
> {}

export const defaultCategoryCriteria = {
	Action: 'Real-time combat or reflex-based action is a central mechanic.',
	Adventure:
		'Exploration and narrative-driven adventure are central mechanics.',
	RPG: 'Role-playing with character progression and customizable builds.',
	Strategy: 'Tactical or strategic planning is a central mechanic.',
	Simulation: 'Simulating real-world activities or managing systems.',
	Puzzle: 'Solving logical or spatial puzzles is a central mechanic.',
	Platformer: 'Jumping between platforms is a central mechanic.',
	Racing: 'Racing vehicles is a central mechanic.',
	Sports: 'Playing a sport is a central mechanic.',
	Horror: 'Designed to frighten players through horror themes and gameplay.',
	Roguelike:
		'Repeated runs with procedural variation and loss of run progress.',
	'Co-op': 'Supports players working together in cooperative gameplay.',
};
