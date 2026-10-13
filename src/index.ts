/**
 * Unofficial Mythos provider plugin for OpenCode.
 *
 * This is a community project. It is not affiliated with, endorsed by, or supported by the
 * OpenCode project or Anthropic. Product names are used only to describe compatibility.
 */
import { defaultCredentials } from "@anthropic-ai/sdk/lib/credentials/credential-chain"
import type { CredentialResult } from "@anthropic-ai/sdk/lib/credentials/types"
import { Model, Plugin, Provider } from "@opencode/plugin"

export type { CredentialResult }

/** Dependencies injected into the plugin so tests can avoid real profile files. */
export interface MythosDeps {
  /** Resolves Anthropic profile credentials, or null when no profile is configured. */
  readonly loadCredentials: (profile?: string) => Promise<CredentialResult | null>
}

/** Shares access tokens across requests. Concurrent callers share one provider call. */
export interface TokenSource {
  /** Returns a current access token. Only one provider call is in flight at a time. */
  get(): Promise<string>
  /** Marks the cached token as rejected so the next provider call forces a refresh. */
  invalidate(): void
}

const providerID = Provider.ID.make("mythos")
const anthropicProviderID = "anthropic"
const authBeta = "oauth-2025-04-20"
const apiHost = "https://api.anthropic.com"
/**
 * The native Anthropic driver. Header auth only works with this driver, so every Mythos model
 * (mirrored, template-based, or fallback) must name it.
 */
const packageName = "@opencode/ai/providers/anthropic"

/** Mythos models and the Anthropic model whose pricing and limits they reuse. */
const mythosModels = [
  { id: "claude-mythos-5-1", name: "Claude Mythos 5.1", template: "claude-fable-5-1" },
  { id: "claude-mythos-5", name: "Claude Mythos 5", template: "claude-fable-5" },
] as const

/** Builds the Mythos provider from ant profile credentials. Refresh is handled by the SDK. */
export function createMythosPlugin(deps: MythosDeps) {
  return Plugin.define({
    id: "opencode.provider.mythos",
    /**
     * Loads profile credentials, registers the Mythos provider, and installs the hooks that add the
     * bearer token and react to 401 responses. Registers nothing when no profile is configured.
     */
    async setup(ctx) {
      const profile = parseProfile(ctx.options?.profile)
      const credentials = await loadProfileCredentials(deps, profile)
      // Without a profile there is nothing to authenticate with, so Mythos stays unregistered.
      if (!credentials) return

      const baseURL = apiBaseURL(ctx.options?.baseURL ?? credentials.baseURL)
      const trustedOrigin = new URL(baseURL).origin
      const tokens = createTokenSource(credentials)

      // Activation "enabled" works without a stored OpenCode credential. Core gives the provider
      // Auth.none, so OpenCode sends no x-api-key. The http.request hook below adds the bearer token.
      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            id: providerID,
            name: "Mythos (unofficial)",
            activation: "enabled",
            package: packageName,
            headers: { "anthropic-beta": authBeta },
            settings: { baseURL },
          },
          models: buildModels(editor.get(anthropicProviderID)?.models),
        })
      })

      /**
       * Swaps the API key for the bearer token before each request. Never forwards credentials to a host
       * other than the configured one, even if a request was rerouted.
       */
      const onRequest = async (evt: { request: Request }) => {
        evt.request.headers.delete("x-api-key")
        const origin = new URL(evt.request.url).origin
        if (origin !== trustedOrigin) throw new Error(`Mythos: refusing to send credentials to ${origin}`)
        applyOAuthHeaders(evt.request.headers, await tokens.get(), credentials.extraHeaders)
      }

      /**
       * Marks the token as rejected on a 401. Invalidating makes the next request refresh it.
       * There is no automatic retry. That keeps this simple, because the next request uses a fresh token.
       */
      const onResponse = (evt: { response: Response }) => {
        if (evt.response.status === 401) tokens.invalidate()
      }

      await ctx.session.hook("http.request", onRequest, { providerID: "mythos" })
      await ctx.session.hook("http.response", onResponse, { providerID: "mythos" })
    },
  })
}

/** Loads profile credentials through the SDK default chain, using the public API host and the global fetch. */
const loadDefaultCredentials = (profile?: string) => defaultCredentials({ baseURL: apiHost, fetch: globalThis.fetch }, profile)

/** Default plugin export wired to the real ant profile credential chain. */
const MythosPlugin = createMythosPlugin({ loadCredentials: loadDefaultCredentials })

export default MythosPlugin

/**
 * Loads profile credentials. Any failure is replaced with a fixed message, because SDK errors can
 * include local paths or secret values.
 */
async function loadProfileCredentials(deps: MythosDeps, profile: string | undefined): Promise<CredentialResult | null> {
  try {
    return await deps.loadCredentials(profile)
  } catch {
    throw new Error("Mythos: could not read the Anthropic profile configuration. Run `ant auth login`.")
  }
}

/** Validates the optional profile name. Undefined means use the SDK default profile. */
export function parseProfile(input: unknown): string | undefined {
  if (input === undefined) return undefined
  if (typeof input !== "string" || !input.trim()) throw new Error("Invalid profile")
  return input.trim()
}

/**
 * Creates a token source around SDK credentials. Concurrent get() calls share one in-flight provider
 * call. After it settles, the next get() calls the provider again, and the SDK decides whether to reuse
 * or refresh its token. After invalidate(), the next provider call forces a refresh. That flag clears
 * only after a successful call, so a failed forced refresh is retried.
 *
 * Edge case: invalidate() can arrive while a normal call is still in flight. That call may hold a
 * token the server rejected, so invalidate() detaches it. Later get() calls never join it. Each new
 * call waits for the previous one to settle, so the SDK never runs two refreshes at once (refresh
 * tokens rotate). The previous call's outcome is ignored.
 */
export function createTokenSource(credentials: CredentialResult): TokenSource {
  let current: Promise<string> | undefined
  let settled: Promise<void> = Promise.resolve()
  let forceRefresh = false
  let invalidations = 0

  /**
   * Calls the SDK provider once. Errors never include the cause text. A forced call clears the flag
   * only when no invalidate() ran during it, because that token may already be stale.
   */
  async function callProvider(force: boolean): Promise<string> {
    const invalidationsAtStart = invalidations
    try {
      const { token } = await credentials.provider({ forceRefresh: force })
      if (force && invalidations === invalidationsAtStart) forceRefresh = false
      return token
    } catch {
      throw new Error("Mythos: could not load Anthropic profile credentials. Run `ant auth login`.")
    }
  }

  /**
   * Starts a provider call after the previous call settles. The force flag is read now, so a call
   * made after invalidate() is forced. The next call waits on this one, whatever its outcome.
   */
  function startLoad(): Promise<string> {
    const force = forceRefresh
    const load = settled.then(() => callProvider(force))
    settled = load.then(noop, noop)
    return load
  }

  return {
    /**
     * Returns the current call, or starts one. The current call is cleared when it settles, unless
     * invalidate() already detached it.
     */
    get() {
      if (!current) {
        const load = startLoad()
        current = load
        /** Forgets this call once it settles, unless invalidate() already replaced it. */
        const clear = () => {
          if (current === load) current = undefined
        }
        load.then(clear, clear)
      }
      return current
    },
    /** Forces the next provider call to refresh. Detaches the current call so new callers do not join it. */
    invalidate() {
      forceRefresh = true
      invalidations += 1
      current = undefined
    },
  }
}

/** Does nothing. Used to turn a promise's outcome into a settled signal. */
function noop(): void {}

/**
 * Builds the Mythos model list. Anthropic models are mirrored under the Mythos provider with their
 * source id and wire modelID. Each Mythos model missing from that list comes from its Anthropic
 * template when one exists, or from static fallback metadata otherwise.
 */
export function buildModels(anthropicModels: ReadonlyMap<string, Model.Info> | undefined): Model.Info[] {
  const models: Model.Info[] = []
  const seen = new Set<string>()
  for (const source of anthropicModels?.values() ?? []) {
    models.push(mirror(source))
    seen.add(String(source.id))
  }
  for (const mythos of mythosModels) {
    if (seen.has(mythos.id)) continue
    const template = anthropicModels?.get(mythos.template)
    models.push(template ? fromTemplate(template, mythos.id, mythos.name) : fallbackModel(mythos.id, mythos.name))
  }
  return models
}

/**
 * Deep-copies an Anthropic model under the Mythos provider. The id and modelID are kept, because
 * modelID is the name the API receives. The package is forced to the native driver.
 */
function mirror(source: Model.Info): Model.Info {
  return { ...structuredClone(source), providerID, package: packageName }
}

/**
 * Clones an Anthropic template into a Mythos model that keeps its pricing and limits. Both id and
 * modelID become the Mythos id, because that is the name sent to the API.
 */
function fromTemplate(template: Model.Info, id: string, name: string): Model.Info {
  const modelID = Model.ID.make(id)
  return { ...mirror(template), id: modelID, modelID, name, family: Model.Family.make("mythos") }
}

/**
 * Creates static metadata for a Mythos model when no Anthropic template exists. Fields that match
 * Model.Info.default (cost, variants, time) are left to the default.
 */
function fallbackModel(modelID: string, name: string): Model.Info {
  const id = Model.ID.make(modelID)
  return {
    ...Model.Info.default(providerID, id),
    name,
    package: packageName,
    family: Model.Family.make("mythos"),
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 200_000, output: 32_000 },
    status: "active",
    enabled: true,
  } satisfies Model.Info
}

/**
 * Replaces the API key header with the OAuth bearer token and the SDK's extra headers.
 * Existing anthropic-beta values are kept and the OAuth beta is added when missing.
 */
export function applyOAuthHeaders(headers: Headers, token: string, extraHeaders: Record<string, string>): void {
  headers.delete("x-api-key")
  headers.set("authorization", `Bearer ${token}`)
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (name.toLowerCase() === "anthropic-beta") headers.set(name, mergeBeta(headers.get(name), value))
    else headers.set(name, value)
  }
  headers.set("anthropic-beta", mergeBeta(headers.get("anthropic-beta"), authBeta))
}

/** Joins comma-separated anthropic-beta values without duplicates or dropped entries. */
export function mergeBeta(existing: string | null, addition: string): string {
  const values = [...(existing ?? "").split(","), ...addition.split(",")].map((value) => value.trim()).filter(Boolean)
  return [...new Set(values)].join(",")
}

/**
 * Resolves the optional API base URL with the Anthropic /v1 convention. Plain http is accepted
 * only for loopback hosts, so credentials are never sent in clear text to another machine.
 */
export function apiBaseURL(input?: unknown): string {
  if (input !== undefined && typeof input !== "string") throw new Error("Invalid API base URL")
  const raw = typeof input === "string" ? input.trim() : ""
  const base = raw || apiHost
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error("Invalid API base URL")
  }
  if (!isAllowedBaseURL(url)) throw new Error("Invalid API base URL")
  const path = url.pathname.replace(/\/+$/, "")
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`
  return url.toString().replace(/\/$/, "")
}

/**
 * Accepts https for any host and http only for loopback hosts. Rejects URLs that carry
 * credentials, a query string, or a fragment.
 */
function isAllowedBaseURL(url: URL): boolean {
  if (url.username || url.password || url.search || url.hash) return false
  if (url.protocol === "https:") return true
  return url.protocol === "http:" && isLoopbackHost(url.hostname)
}

/**
 * True for localhost, *.localhost, 127.0.0.0/8, and [::1]. The URL parser already lowercases
 * hostnames, writes IPv6 hosts in brackets, and expands shorthand IPv4 such as 127.1.
 */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true
  if (hostname === "[::1]") return true
  const octets = hostname.split(".")
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}
