import type { Context } from "@opencode/plugin/promise/plugin"
import type { ProviderEditor, ProviderRecord } from "@opencode/plugin/promise/provider"
import { Model, Provider } from "@opencode/plugin"
import { createMythosPlugin, type CredentialResult, type MythosDeps } from "../src/index"

/** Fixture token only. Real credentials are never used in tests. */
export const fixtureToken = "fixture-token"

/** Returns credentials shaped like the SDK result, backed by fixture values. Overrides replace any field. */
export function fixtureCredentials(overrides: Partial<CredentialResult> = {}): CredentialResult {
  return {
    /** Always returns the fixture token. */
    provider: async () => ({ token: fixtureToken, expiresAt: null }),
    extraHeaders: { "anthropic-workspace-id": "ws_fixture" },
    ...overrides,
  }
}

type USDPerMillion = Model.Info["cost"][number]["input"]

/** Builds an Anthropic model with explicit pricing and limits so tests can tell templates apart. */
export function anthropicModel(id: string, pricing: { input: number; output: number; context: number }): Model.Info {
  return {
    ...Model.Info.default(Provider.ID.make("anthropic"), Model.ID.make(id)),
    name: id,
    cost: [{ input: pricing.input as USDPerMillion, output: pricing.output as USDPerMillion, cache: { read: 0.1 as USDPerMillion, write: 1.25 as USDPerMillion } }],
    limit: { context: pricing.context, output: 64_000 },
  }
}

/** Anthropic list used by most tests: two Fable templates with distinct pricing and limits. */
export const defaultAnthropicModels = [
  anthropicModel("claude-fable-5", { input: 3, output: 15, context: 200_000 }),
  anthropicModel("claude-fable-5-1", { input: 5, output: 25, context: 400_000 }),
  anthropicModel("claude-haiku-5", { input: 1, output: 5, context: 100_000 }),
]

export type ProviderAdd = Parameters<ProviderEditor["add"]>[0]

/** One hook the plugin registered on the fake session domain. */
export interface HookRegistration {
  readonly name: string
  readonly callback: (evt: unknown) => Promise<void> | void
  readonly options: unknown
}

/** Inputs for {@link runSetup}. Unset fields use the defaults described on each field. */
export interface SetupInput {
  /** Plugin options, such as profile or baseURL. */
  readonly options?: Record<string, unknown>
  /** Credentials returned by the default loader. Null means no profile is configured. */
  readonly credentials: CredentialResult | null
  /** Replaces the default loader, for example to simulate a failing profile read. */
  readonly loadCredentials?: MythosDeps["loadCredentials"]
  /** Models in the fake Anthropic provider. Defaults to {@link defaultAnthropicModels}. */
  readonly anthropicModels?: readonly Model.Info[]
  /** When true, the fake editor has no Anthropic provider at all. */
  readonly withoutAnthropic?: boolean
}

/** What the fake host recorded after setup ran. */
export interface SetupResult {
  readonly providers: ProviderAdd[]
  readonly hooks: HookRegistration[]
  readonly loadedProfiles: Array<string | undefined>
}

/** Disposer for the fake host. Nothing needs undoing, so it does nothing. */
const noopDispose = async (): Promise<void> => undefined

/** Builds the Anthropic provider record the fake editor returns, or undefined when absent. */
function anthropicRecord(input: SetupInput): ProviderRecord | undefined {
  if (input.withoutAnthropic) return undefined
  const models = input.anthropicModels ?? defaultAnthropicModels
  return {
    provider: Provider.Info.empty(Provider.ID.make("anthropic")),
    models: new Map(models.map((model) => [String(model.id), model])),
  }
}

/**
 * Runs plugin setup against a fake host. The editor and session domains record what the
 * plugin registers, so tests can inspect the real plugin output without a running OpenCode.
 * Methods the plugin never calls throw, so an unexpected call fails the test loudly.
 */
export async function runSetup(input: SetupInput): Promise<SetupResult> {
  const providers: ProviderAdd[] = []
  const hooks: HookRegistration[] = []
  const loadedProfiles: Array<string | undefined> = []
  const anthropic = anthropicRecord(input)
  const editor: ProviderEditor = {
    /** Lists no other providers. The plugin only reads Anthropic. */
    list: () => [],
    /** Returns the Anthropic record, or undefined when the test models an absent provider. */
    get: (providerID) => (providerID === "anthropic" ? anthropic : undefined),
    /** Records the provider the plugin registers. */
    add: (registration) => {
      providers.push(registration)
    },
    /** Throws, because the plugin never updates providers. */
    update: () => {
      throw new Error("Unexpected provider update")
    },
    /** Throws, because the plugin never removes providers. */
    remove: () => {
      throw new Error("Unexpected provider removal")
    },
    models: {
      /** Throws, because the plugin adds models through add(). */
      set: () => {
        throw new Error("Unexpected model set")
      },
      /** Throws, because the plugin never edits single models. */
      update: () => {
        throw new Error("Unexpected model update")
      },
      /** Throws, because the plugin never removes models. */
      remove: () => {
        throw new Error("Unexpected model removal")
      },
    },
  }
  // Only the fields the plugin reads are faked. The full host context is not needed here.
  const context = {
    options: input.options ?? {},
    provider: {
      /** Applies the edit to the fake editor right away. */
      transform: async (edit: (editor: ProviderEditor) => void) => {
        edit(editor)
        return { dispose: noopDispose }
      },
    },
    session: {
      /** Records the hook name, callback, and options for the test to call later. */
      hook: async (name: string, callback: HookRegistration["callback"], options: unknown) => {
        hooks.push({ name, callback, options })
        return { dispose: noopDispose }
      },
    },
  } as unknown as Context
  /** Default loader: returns the credentials from the setup input. */
  const load = input.loadCredentials ?? (async () => input.credentials)
  const plugin = createMythosPlugin({
    /** Records the requested profile, then delegates to the configured loader. */
    loadCredentials: async (profile) => {
      loadedProfiles.push(profile)
      return load(profile)
    },
  })
  await plugin.setup(context)
  return { providers, hooks, loadedProfiles }
}
