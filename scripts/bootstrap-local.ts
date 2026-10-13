import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Result of checking one path in node_modules before linking. */
type LinkState = "missing" | "symlink" | "dangling" | "other"

/**
 * Reports what sits at `path` without following symbolic links.
 * Only a missing entry (ENOENT) maps to "missing". Other filesystem errors are rethrown.
 * A symlink whose target no longer exists is "dangling" so we never silently replace it.
 * @param path Absolute path inside node_modules to inspect.
 * @returns The state of the entry at `path`.
 */
function linkState(path: string): LinkState {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
    throw error
  }
  if (!stats.isSymbolicLink()) return "other"
  return existsSync(path) ? "symlink" : "dangling"
}

const checkout = process.argv[2]
if (!checkout) {
  throw new Error("Usage: bun run bootstrap:local /path/to/prepared/opencode-checkout")
}

const root = resolve(checkout)
const packages = join(root, "packages")
if (!existsSync(join(packages, "plugin/package.json"))) {
  throw new Error(`No prepared OpenCode checkout found at ${root}`)
}

for (const name of ["plugin", "ai", "schema"]) {
  const path = join(packages, name)
  const metadata = JSON.parse(await Bun.file(join(path, "package.json")).text())
  if (metadata.name !== `@opencode/${name}`) throw new Error(`Unexpected package at ${path}`)
  if (!metadata.exports?.["."]) throw new Error(`${metadata.name} has no package root export`)
}
const pluginMetadata = JSON.parse(await Bun.file(join(packages, "plugin/package.json")).text())
if (pluginMetadata.version !== "2.0.26") throw new Error(`Expected plugin 2.0.26, found ${pluginMetadata.version}`)
const workspace = JSON.parse(await Bun.file(join(root, "package.json")).text())
if (workspace.workspaces?.catalog?.effect !== "4.0.0-rc.118") {
  throw new Error("Prepared checkout does not use effect 4.0.0-rc.118")
}

const localModules = join(import.meta.dir, "..", "node_modules")
mkdirSync(join(localModules, "@opencode"), { recursive: true })
const resolvedEffect = import.meta.resolve("effect", join(packages, "plugin", "package.json"))
const effectPackage = dirname(dirname(fileURLToPath(resolvedEffect)))
for (const [name, target] of [
  ["@opencode/plugin", join(packages, "plugin")],
  ["@opencode/ai", join(packages, "ai")],
  ["@opencode/schema", join(packages, "schema")],
  ["effect", effectPackage],
] as const) {
  const link = join(localModules, name)
  const state = linkState(link)
  if (state === "dangling") {
    throw new Error(`Refusing to replace dangling link ${link}; remove it manually, then rerun.`)
  }
  if (state === "other") {
    throw new Error(`Refusing to replace existing ${link}; remove or correct it manually, then rerun.`)
  }
  if (state === "symlink") {
    if (realpathSync(link) !== realpathSync(target)) {
      throw new Error(`Refusing to replace existing ${link}; remove or correct it manually, then rerun.`)
    }
    continue
  }
  symlinkSync(target, link, "junction")
}
console.log(`Linked local OpenCode SDK packages from ${root}`)
