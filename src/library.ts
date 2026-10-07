import { Effect, Schema } from "effect"

export class AppError extends Schema.TaggedError<AppError>()("AppError", {
  message: Schema.String
}) {}

export const AppId = Schema.Int.check(Schema.isGreaterThan(0))
export const SteamId = Schema.String.check(Schema.isPattern(/^\d{17}$/))
export const Category = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^[^\x00-\x1f\x7f-\x9f]+$/)
)

export const SteamGame = Schema.Struct({
  appid: AppId,
  name: Schema.NonEmptyString,
  playtime_forever: Schema.Natural,
  playtime_2weeks: Schema.optionalKey(Schema.Natural)
})
export interface SteamGame extends Schema.Schema.Type<typeof SteamGame> {}

const uniqueAppIds = Schema.makeFilter<ReadonlyArray<{ readonly appid: number }>>(
  (games) => new Set(games.map((game) => game.appid)).size === games.length,
  { expected: "games with unique app IDs" }
)
export const SteamGames = Schema.Array(SteamGame).check(uniqueAppIds)
export const OwnedGamesResponse = Schema.Struct({
  response: Schema.Struct({
    game_count: Schema.optionalKey(Schema.Natural),
    games: Schema.optionalKey(SteamGames)
  })
})

export const Game = Schema.Struct({
  ...SteamGame.fields,
  tags: Schema.Array(Category).check(Schema.isUnique()),
  reviewed: Schema.Boolean
})
export interface Game extends Schema.Schema.Type<typeof Game> {}

export const Library = Schema.Struct({
  version: Schema.Literal(1),
  steamId: Schema.NullOr(SteamId),
  games: Schema.Array(Game).check(uniqueAppIds)
})
export interface Library extends Schema.Schema.Type<typeof Library> {}

export const emptyLibrary = (): Library => ({ version: 1, steamId: null, games: [] })

export const decodeImport = Effect.fn("Library.decodeImport")(function* (input: string) {
  const parsed = yield* Schema.decodeUnknownEffect(
    Schema.Union([SteamGames, OwnedGamesResponse]).pipe(Schema.fromJsonString)
  )(input).pipe(
    Effect.mapError(() => new AppError({
      message: "Invalid import. Expected a Steam GetOwnedGames response or an array of games with appid, name and playtime_forever. App IDs must be unique."
    }))
  )
  if ("response" in parsed) return yield* gamesFromResponse(parsed)
  return parsed
})

export const gamesFromResponse = Effect.fn("Steam.gamesFromResponse")(function* (
  payload: Schema.Schema.Type<typeof OwnedGamesResponse>
) {
  const { games, game_count } = payload.response
  if (games === undefined && game_count !== 0) {
    return yield* new AppError({
      message: "Steam did not return a library. Check the Steam ID, API key and Game details privacy settings. Your saved library was not changed."
    })
  }
  if (game_count !== undefined && game_count !== (games?.length ?? 0)) {
    return yield* new AppError({ message: "Steam returned an inconsistent game count. Your saved library was not changed." })
  }
  return games ?? []
})

export function mergeLibrary(previous: Library, games: ReadonlyArray<SteamGame>, steamId: string | null): Library {
  const byId = new Map(previous.games.map((game) => [game.appid, game]))
  return {
    version: 1,
    steamId,
    games: games.map((game) => ({
      ...game,
      tags: byId.get(game.appid)?.tags ?? [],
      reviewed: byId.get(game.appid)?.reviewed ?? false
    }))
  }
}

export function categories(game: Game): ReadonlyArray<string> {
  const progress = game.playtime_forever === 0
    ? "Unplayed"
    : game.playtime_forever < 120 ? "Sampled" : "Played"
  return [...new Set([
    progress,
    ...((game.playtime_2weeks ?? 0) > 0 ? ["Recently played"] : []),
    ...game.tags
  ])]
}

export function selectGames(library: Library, search = "", category = "", unreviewed = false): ReadonlyArray<Game> {
  return library.games.filter((game) =>
    game.name.toLowerCase().includes(search.toLowerCase()) &&
    (category === "" || categories(game).some((value) => value.toLowerCase() === category.toLowerCase())) &&
    (!unreviewed || !game.reviewed)
  ).sort((a, b) => a.name.localeCompare(b.name) || a.appid - b.appid)
}

export const updateGame = Effect.fn("Library.updateGame")(function* (
  library: Library,
  appid: number,
  update: (game: Game) => Game
) {
  if (!library.games.some((game) => game.appid === appid)) {
    return yield* new AppError({ message: `No game with app ID ${appid}. Use list to find an ID.` })
  }
  return { ...library, games: library.games.map((game) => game.appid === appid ? update(game) : game) }
})

export function exportLibrary(library: Library, format: "json" | "csv"): string {
  const games = selectGames(library).map((game) => ({ ...game, categories: categories(game) }))
  if (format === "json") return JSON.stringify({ ...library, games }, null, 2)
  const quote = (value: string | number | boolean) => `"${String(value).replaceAll('"', '""')}"`
  return [
    "appid,name,playtime_minutes,categories,tags,reviewed",
    ...games.map((game) => [
      game.appid, game.name, game.playtime_forever,
      game.categories.join("; "), game.tags.join("; "), game.reviewed
    ].map(quote).join(","))
  ].join("\n")
}

export function terminalText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
}
