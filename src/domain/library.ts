import { Schema } from 'effect';

export const AppId = Schema.Int.check(Schema.isGreaterThan(0));
export const SteamId = Schema.String.check(Schema.isPattern(/^\d{17}$/));
export const Category = Schema.NonEmptyString.check(
	Schema.isTrimmed(),
	// oxlint-disable-next-line no-control-regex -- Tags must not contain terminal control characters.
	Schema.isPattern(/^[^\x00-\x1f\x7f-\x9f]+$/),
);

export const SteamGame = Schema.Struct({
	appid: AppId,
	name: Schema.NonEmptyString,
	playtime_forever: Schema.Natural,
	playtime_2weeks: Schema.optionalKey(Schema.Natural),
});
export type SteamGame = Schema.Schema.Type<typeof SteamGame>;

const uniqueAppIds = Schema.makeFilter<
	ReadonlyArray<{ readonly appid: number }>
>((games) => new Set(games.map((game) => game.appid)).size === games.length, {
	expected: 'games with unique app IDs',
});
export const SteamGames = Schema.Array(SteamGame).check(uniqueAppIds);
export const OwnedGamesResponse = Schema.Struct({
	response: Schema.Struct({
		game_count: Schema.optionalKey(Schema.Natural),
		games: Schema.optionalKey(SteamGames),
	}),
});

export const Game = Schema.Struct({
	...SteamGame.fields,
	tags: Schema.Array(Category).check(Schema.isUnique()),
	reviewed: Schema.Boolean,
});
export type Game = Schema.Schema.Type<typeof Game>;

export const Library = Schema.Struct({
	version: Schema.Literal(1),
	steamId: Schema.NullOr(SteamId),
	games: Schema.Array(Game).check(uniqueAppIds),
});
export type Library = Schema.Schema.Type<typeof Library>;

export const emptyLibrary = (): Library => ({
	version: 1,
	steamId: null,
	games: [],
});

export function mergeLibrary(
	previous: Library,
	games: ReadonlyArray<SteamGame>,
	steamId: string | null,
): Library {
	const byId = new Map(previous.games.map((game) => [game.appid, game]));
	return {
		version: 1,
		steamId,
		games: games.map((game) => ({
			...game,
			tags: byId.get(game.appid)?.tags ?? [],
			reviewed: byId.get(game.appid)?.reviewed ?? false,
		})),
	};
}

export function categories(game: Game): ReadonlyArray<string> {
	const progress =
		game.playtime_forever === 0
			? 'Unplayed'
			: game.playtime_forever < 120
				? 'Sampled'
				: 'Played';
	return [
		...new Set([
			progress,
			...((game.playtime_2weeks ?? 0) > 0 ? ['Recently played'] : []),
			...game.tags,
		]),
	];
}

export function selectGames(
	library: Library,
	search = '',
	category = '',
	unreviewed = false,
): ReadonlyArray<Game> {
	return library.games
		.filter(
			(game) =>
				game.name.toLowerCase().includes(search.toLowerCase()) &&
				(category === '' ||
					categories(game).some(
						(value) => value.toLowerCase() === category.toLowerCase(),
					)) &&
				(!unreviewed || !game.reviewed),
		)
		.sort((a, b) => a.name.localeCompare(b.name) || a.appid - b.appid);
}

export function exportLibrary(
	library: Library,
	format: 'json' | 'csv',
): string {
	const games = selectGames(library).map((game) => ({
		...game,
		categories: categories(game),
	}));
	if (format === 'json') return JSON.stringify({ ...library, games }, null, 2);
	const quote = (value: string | number | boolean) =>
		`"${String(value).replaceAll('"', '""')}"`;
	return [
		'appid,name,playtime_minutes,categories,tags,reviewed',
		...games.map((game) =>
			[
				game.appid,
				game.name,
				game.playtime_forever,
				game.categories.join('; '),
				game.tags.join('; '),
				game.reviewed,
			]
				.map(quote)
				.join(','),
		),
	].join('\n');
}

export function terminalText(value: string): string {
	// oxlint-disable-next-line no-control-regex -- Strip terminal control characters from displayed titles.
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}
