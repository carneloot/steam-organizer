import { assert, describe, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("CLI integration", () => {
  it("imports, tags, filters, refreshes, exports and untags in separate processes", () => {
    const directory = mkdtempSync(join(tmpdir(), "steam-cli-"))
    const file = join(directory, "library.json")
    const run = (...args: ReadonlyArray<string>) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--file", file, ...args], {
        encoding: "utf8", timeout: 10_000
      })
      assert.strictEqual(result.status, 0, result.stderr)
      return result.stdout
    }
    try {
      assert.include(run("import", "examples/games.json"), "Imported 4 games")
      run("tag", "620", "Co-op", "Favorites", "Co-op")
      const tagged = run("list", "--category", "favorites", "--search", "PORTAL", "--json")
      assert.deepStrictEqual(JSON.parse(tagged).map((game: { appid: number; tags: string[] }) => ({
        appid: game.appid, tags: game.tags
      })), [{ appid: 620, tags: ["Co-op", "Favorites"] }])
      run("import", "examples/games.json")
      assert.include(run("list", "--category", "Favorites"), "Portal 2")
      assert.include(run("categories"), "Favorites\t1")
      assert.deepStrictEqual(JSON.parse(run("export")).games.find((game: { appid: number }) => game.appid === 620).tags, ["Co-op", "Favorites"])
      assert.include(run("export", "--format", "csv"), '"Co-op; Favorites"')
      run("untag", "620", "Favorites")
      assert.strictEqual(run("list", "--category", "Favorites", "--json").trim(), "[]")
      const before = readFileSync(file, "utf8")
      const failure = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--file", file, "tag", "999", "Favorites"], { encoding: "utf8" })
      assert.strictEqual(failure.status, 1)
      assert.include(failure.stdout + failure.stderr, "No game with app ID 999")
      assert.strictEqual(readFileSync(file, "utf8"), before)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
