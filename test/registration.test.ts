import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { Host } from "@opencode/plugin/host"
import type { Plugin } from "@opencode/plugin/promise/plugin"
import { Model } from "@opencode/plugin"
import { anthropicModel, defaultAnthropicModels, fixtureCredentials, runSetup } from "./helpers"

const nativePackage = "@opencode/ai/providers/anthropic"

describe("Mythos plugin host loading", () => {
  test("resolves the package and exposes the plugin id", async () => {
    // Arrange
    const directory = fileURLToPath(new URL("../", import.meta.url))
    const entrypoints = Host.resolve({ directory })

    // Act
    const loaded = await Host.load(entrypoints.server!)

    // Assert
    expect(entrypoints.server).toBeDefined()
    expect((loaded as { default: Plugin }).default.id).toBe("opencode.provider.mythos")
  })
})

describe("Mythos provider registration", () => {
  test("registers provider info and cloned Anthropic models with Mythos templates", async () => {
    // Arrange
    const options = { profile: "work", baseURL: "  https://mythos.example.test/v1/// " }

    // Act
    const result = await runSetup({ options, credentials: fixtureCredentials() })

    // Assert
    expect(result.loadedProfiles).toEqual(["work"])
    expect(result.providers).toHaveLength(1)
    const [registration] = result.providers
    expect(registration.info).toMatchObject({
      id: "mythos",
      name: "Mythos (unofficial)",
      activation: "enabled",
      package: nativePackage,
      headers: { "anthropic-beta": "oauth-2025-04-20" },
      settings: { baseURL: "https://mythos.example.test/v1" },
    })
    expect(registration.info).not.toHaveProperty("integrationID")
    const models = registration.models
    expect(models.map((model) => String(model.id))).toEqual(["claude-fable-5", "claude-fable-5-1", "claude-haiku-5", "claude-mythos-5-1", "claude-mythos-5"])
    expect(models.every((model) => String(model.providerID) === "mythos")).toBe(true)
  })

  test("keeps the source model id and wire modelID for mirrored Anthropic aliases", async () => {
    // Arrange
    const alias = { ...anthropicModel("claude-opus-5-5-fast", { input: 2, output: 10, context: 200_000 }), modelID: Model.ID.make("claude-opus-5-5") }

    // Act
    const { providers } = await runSetup({ credentials: fixtureCredentials(), anthropicModels: [alias] })
    const model = providers[0].models.find((candidate) => String(candidate.id) === "claude-opus-5-5-fast")

    // Assert
    expect(model).toMatchObject({ id: "claude-opus-5-5-fast", modelID: "claude-opus-5-5", providerID: "mythos" })
  })

  test.each([
    { id: "claude-mythos-5-1", name: "Claude Mythos 5.1", template: "claude-fable-5-1" },
    { id: "claude-mythos-5", name: "Claude Mythos 5", template: "claude-fable-5" },
  ])("$id copies pricing and limits from $template", async ({ id, name, template }) => {
    // Arrange
    const source = defaultAnthropicModels.find((model) => String(model.id) === template)!

    // Act
    const { providers } = await runSetup({ credentials: fixtureCredentials() })
    const model = providers[0].models.find((candidate) => String(candidate.id) === id)

    // Assert
    expect(model).toMatchObject({ id, modelID: id, name, family: "mythos", providerID: "mythos", cost: source.cost, limit: source.limit })
  })

  test("enforces the native package on mirrored, template, and fallback models", async () => {
    // Arrange
    const foreign = { ...anthropicModel("claude-fable-5", { input: 3, output: 15, context: 200_000 }), package: "@example/other-provider" }

    // Act
    const { providers } = await runSetup({ credentials: fixtureCredentials(), anthropicModels: [foreign] })

    // Assert
    const models = providers[0].models
    expect(models.map((model) => String(model.id))).toEqual(["claude-fable-5", "claude-mythos-5-1", "claude-mythos-5"])
    expect(models.map((model) => model.package)).toEqual([nativePackage, nativePackage, nativePackage])
  })

  test("does not duplicate a Mythos model already present in the Anthropic list", async () => {
    // Arrange
    const native = { ...anthropicModel("claude-mythos-5", { input: 9, output: 9, context: 1 }), name: "Native Mythos 5" }
    const existing = [...defaultAnthropicModels, native]

    // Act
    const { providers } = await runSetup({ credentials: fixtureCredentials(), anthropicModels: existing })

    // Assert
    const ids = providers[0].models.map((model) => String(model.id))
    expect(ids.filter((id) => id === "claude-mythos-5")).toHaveLength(1)
    expect(providers[0].models.find((model) => String(model.id) === "claude-mythos-5")?.name).toBe("Native Mythos 5")
  })

  test.each([
    { name: "an empty Anthropic list", options: { anthropicModels: [] } },
    { name: "an absent Anthropic provider", options: { withoutAnthropic: true } },
  ])("falls back to two static Mythos models for $name", async ({ options }) => {
    // Act
    const { providers } = await runSetup({ credentials: fixtureCredentials(), ...options })

    // Assert
    const models = providers[0].models
    expect(models.map((model) => String(model.id))).toEqual(["claude-mythos-5-1", "claude-mythos-5"])
    expect(models.every((model) => model.family === "mythos" && model.limit.context > 0 && model.cost.length === 0 && model.package === nativePackage)).toBe(true)
  })

  test("registers nothing when no profile credentials are available", async () => {
    // Act
    const result = await runSetup({ credentials: null })

    // Assert
    expect(result.providers).toEqual([])
    expect(result.hooks).toEqual([])
  })

  test("hides the cause when the profile loader fails", async () => {
    // Arrange
    const secret = "sk-fixture-secret"
    /** Fails like a broken profile file whose error text contains a secret. */
    const loadCredentials = async () => {
      throw new Error(`cannot read profile with ${secret}`)
    }

    // Act
    const attempt = runSetup({ credentials: null, loadCredentials })

    // Assert
    const error = await attempt.then(() => undefined, (failure: unknown) => failure as Error)
    expect(error?.message).toBe("Mythos: could not read the Anthropic profile configuration. Run `ant auth login`.")
    expect(error?.message).not.toContain(secret)
    expect(error?.cause).toBeUndefined()
  })

  test.each([
    { profile: "" },
    { profile: "   " },
    { profile: 42 },
  ])("rejects invalid profile option $profile", async ({ profile }) => {
    // Act
    const attempt = runSetup({ options: { profile }, credentials: fixtureCredentials() })

    // Assert
    await expect(attempt).rejects.toThrow("Invalid profile")
  })
})
