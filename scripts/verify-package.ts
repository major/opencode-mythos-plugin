/**
 * Packs the plugin, installs the tarball like OpenCode does, and loads it by package name.
 *
 * Checks that:
 * - the published files contain the built entry point
 * - an install does not pull in OpenCode or Effect (the host provides them)
 * - OpenCode's host resolver finds the `./server` export and the plugin loads
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Host } from "@opencode/plugin/host"

const root = join(import.meta.dir, "..")
const metadata = JSON.parse(await Bun.file(join(root, "package.json")).text())
const name: string = metadata.name

/** Runs a command and fails loudly with its output when it exits non-zero. */
function run(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${result.stderr.toString()}`)
  return result.stdout.toString()
}

const scratchBase = process.env.OPENCODE_TMP ?? join(process.env.HOME ?? tmpdir(), ".cache/opencode-tmp/opencode")
mkdirSync(scratchBase, { recursive: true })
const scratch = mkdtempSync(join(scratchBase, "mythos-pack-"))
try {
  const tarball = run(["npm", "pack", "--json", "--pack-destination", scratch], root)
  const [packed] = JSON.parse(tarball) as { filename: string; files: { path: string }[] }[]
  const files = packed.files.map((file) => file.path)
  if (!files.includes("dist/index.js")) throw new Error(`dist/index.js missing from package: ${files.join(", ")}`)

  const install = join(scratch, "install")
  mkdirSync(install)
  await Bun.write(join(install, "package.json"), "{}")
  run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", join(scratch, packed.filename)], install)

  // OpenCode supplies these at runtime, so a plain install must not fetch them.
  for (const hostPackage of ["@opencode/plugin", "@opencode/ai", "@opencode/schema", "effect"]) {
    if (existsSync(join(install, "node_modules", hostPackage))) {
      throw new Error(`${hostPackage} was installed; it must stay an optional peer`)
    }
  }

  // Stand in for the host by linking the local dev copies the plugin imports.
  mkdirSync(join(install, "node_modules/@opencode"), { recursive: true })
  for (const hostPackage of ["@opencode/plugin", "effect"]) {
    symlinkSync(join(root, "node_modules", hostPackage), join(install, "node_modules", hostPackage), "junction")
  }

  const entrypoints = Host.resolve({ directory: install, name })
  if (!entrypoints.server?.endsWith("/dist/index.js")) {
    throw new Error(`server entry did not resolve to dist/index.js: ${entrypoints.server}`)
  }
  const loaded = (await Host.load(entrypoints.server)) as { default?: { id?: string } }
  if (loaded.default?.id !== "opencode.provider.mythos") throw new Error("Loaded module has no Mythos plugin export")
  console.log(`OK: ${packed.filename} installs and loads as ${name}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
