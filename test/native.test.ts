import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import { Model, Provider } from "@opencode/plugin"
import { LanguageModel } from "@opencode/ai"
import { model as anthropicModel } from "@opencode/ai/providers/anthropic"
import { make } from "@opencode/ai/promise"
import { Auth, RequestExecutor } from "@opencode/ai/route"
import { createMythosPlugin, type CredentialResult } from "../src/index"

/** Fixture token only. Real credentials are never read in tests. */
const fixtureToken = "fixture-token"
const workspaceID = "wrkspc_fixture"
const baseURL = "https://mythos.example.test"

/** Canned Anthropic SSE stream that answers "Hello from Mythos". */
const sseBody =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-mythos-5-1","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from Mythos"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'

/** Builds a minimal Anthropic catalog entry for the given model id. */
function fixtureModel(id: string): Model.Info {
  return {
    ...Model.Info.default(Provider.ID.make("anthropic"), Model.ID.make(id)),
    name: id,
    limit: { context: 400_000, output: 64_000 },
  }
}

/** Anthropic catalog fixtures. The "-fast" entry is a mode alias whose wire model is "claude-opus-5-5". */
const fixtureModels: Model.Info[] = [
  fixtureModel("claude-fable-5-1"),
  { ...fixtureModel("claude-opus-5-5-fast"), modelID: Model.ID.make("claude-opus-5-5") },
]

/** Hook callback shape the plugin registers through session.hook. */
interface CapturedHook {
  readonly callback: (evt: { request: Request; response?: Response }) => Promise<void> | void
  readonly options: unknown
}

/** What the plugin registered through the fake host, plus a log of each token load. */
interface FakeHost {
  readonly added: Array<Parameters<ProviderEditor["add"]>[0]>
  readonly hooks: Map<string, CapturedHook>
  /** Options passed to each fixture token load, so tests can see forced refreshes. */
  readonly providerCalls: Array<{ forceRefresh?: boolean } | undefined>
}

/**
 * Runs plugin setup against a fake OpenCode context. Provider registration and session hooks
 * are captured so tests can drive them the way OpenCode core does. Each call gets its own
 * token load log and fixture credentials, so tests do not share state.
 */
async function setupPlugin(): Promise<FakeHost> {
  const added: FakeHost["added"] = []
  const hooks = new Map<string, CapturedHook>()
  const providerCalls: FakeHost["providerCalls"] = []
  const credentials: CredentialResult = {
    /** Records the load options and returns the fixture token. */
    provider: async (opts) => {
      providerCalls.push(opts)
      return { token: fixtureToken, expiresAt: null }
    },
    extraHeaders: { "anthropic-workspace-id": workspaceID },
  }
  const anthropic = new Map(
    fixtureModels.map(
      /** Keys each fixture model by its id. */
      (model) => [String(model.id), model],
    ),
  )
  const editor = {
    /** Returns the fixture anthropic provider, or undefined for any other provider id. */
    get: (id: string) =>
      id === "anthropic" ? { provider: Provider.Info.empty(Provider.ID.make("anthropic")), models: anthropic } : undefined,
    /** Records a provider registration made by the plugin. */
    add: (registration: FakeHost["added"][number]) => {
      added.push(registration)
    },
  } as unknown as ProviderEditor
  const ctx = {
    options: { baseURL },
    provider: {
      /** Applies the plugin's edit to the fake editor. */
      transform: async (edit: (editor: ProviderEditor) => void) => {
        edit(editor)
      },
    },
    session: {
      /** Stores the hook callback and its options by hook name. */
      hook: async (name: string, callback: CapturedHook["callback"], options: unknown) => {
        hooks.set(name, { callback, options })
      },
    },
  } as unknown as Context
  const plugin = createMythosPlugin({ loadCredentials: async () => credentials })
  await plugin.setup(ctx)
  return { added, hooks, providerCalls }
}

/** Returns the single provider registration made by the plugin, or throws if there is not exactly one. */
function registeredProvider(host: FakeHost) {
  if (host.added.length !== 1) throw new Error("Plugin did not register the Mythos provider")
  return host.added[0]
}

/** Provider settings the plugin registered. Read as a loose shape because the SDK type is wide. */
interface RegisteredInfo {
  readonly settings: { readonly baseURL: string }
  readonly headers: Record<string, string>
}

/**
 * Builds the runtime model like OpenCode core does for an enabled provider with no stored
 * credential: the Anthropic driver gets registered settings and headers but no apiKey or
 * authToken, and the route auth is replaced with Auth.none.
 */
function runtimeModel(modelInfo: Model.Info, info: RegisteredInfo) {
  const model = anthropicModel(String(modelInfo.modelID), {
    baseURL: info.settings.baseURL,
    headers: info.headers,
  })
  return LanguageModel.update(model, { route: model.route.with({ auth: Auth.none }) })
}

/** A request as it would be sent on the wire after the http.request hook ran. */
interface WireRequest {
  readonly url: string
  readonly headers: Headers
  readonly body: { readonly model?: string }
}

/**
 * Fake HTTP layer. Each request is converted to a web Request, passed through the captured
 * http.request hook (which mutates headers in place), recorded, and answered with canned SSE.
 */
function interceptedHttp(host: FakeHost, wire: WireRequest[]) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(
      /** Runs the captured hook on each request, then answers it with canned SSE. */
      (req) =>
        Effect.gen(function* () {
          // A URL conversion failure is a test bug, not an HTTP error, so it fails the test directly.
          const request = yield* HttpClientRequest.toWeb(req).pipe(Effect.orDie)
          const hook = host.hooks.get("http.request")
          if (!hook) throw new Error("Plugin did not register an http.request hook")
          yield* Effect.promise(async () => {
            /** Runs the captured hook, which mutates the request headers in place. */
            await hook.callback({ request })
          })
          const body = yield* Effect.promise(
            /** Reads the JSON body from a copy so the request stays readable. */
            () => request.clone().json(),
          )
          wire.push({ url: request.url, headers: new Headers(request.headers), body })
          const response = new Response(sseBody, { headers: { "content-type": "text/event-stream" } })
          return HttpClientResponse.fromWeb(req, response)
        }),
    ),
  )
}

/** Runs one generation through the runtime model with the intercepted HTTP layer. */
async function generate(host: FakeHost, modelInfo: Model.Info, wire: WireRequest[]) {
  const info = registeredProvider(host).info as unknown as RegisteredInfo
  const executor = RequestExecutor.layer.pipe(Layer.provide(interceptedHttp(host, wire)))
  const client = make({ layer: executor })
  return client.llm.generate({
    model: runtimeModel(modelInfo, info),
    prompt: "Say hello",
  })
}

/** Looks up a registered Mythos model by id, or fails the test. */
function registeredModel(host: FakeHost, id: string): Model.Info {
  const found = registeredProvider(host).models.find(
    /** Matches a registered model by its string id. */
    (candidate) => String(candidate.id) === id,
  )
  if (!found) throw new Error(`Plugin did not register ${id}`)
  return found
}

describe("native Anthropic driver with the Mythos auth path", () => {
  test("generates Claude Mythos 5.1 with OAuth bearer auth from the hook", async () => {
    // Arrange
    const host = await setupPlugin()
    const modelInfo = registeredModel(host, "claude-mythos-5-1")
    const wire: WireRequest[] = []

    // Act
    const result = await generate(host, modelInfo, wire)

    // Assert
    expect(wire).toHaveLength(1)
    const [request] = wire
    expect(new URL(request.url).origin).toBe(baseURL)
    expect(new URL(request.url).pathname).toBe("/v1/messages")
    expect(request.headers.get("authorization")).toBe(`Bearer ${fixtureToken}`)
    expect(request.headers.get("x-api-key")).toBeNull()
    expect(request.headers.get("anthropic-workspace-id")).toBe(workspaceID)
    expect(request.headers.get("anthropic-beta")).toContain("oauth-2025-04-20")
    expect(result.text).toBe("Hello from Mythos")
  })

  test.each([
    ["claude-mythos-5-1", "claude-mythos-5-1"],
    ["claude-opus-5-5-fast", "claude-opus-5-5"],
  ])("sends registered model %s to the wire as %s", async (registeredID, wireModelID) => {
    // Arrange
    const host = await setupPlugin()
    const modelInfo = registeredModel(host, registeredID)
    const wire: WireRequest[] = []

    // Act
    await generate(host, modelInfo, wire)

    // Assert
    expect(wire).toHaveLength(1)
    expect(wire[0].body.model).toBe(wireModelID)
  })

  test("forces a token refresh on the request after a 401 response", async () => {
    // Arrange
    const host = await setupPlugin()
    const modelInfo = registeredModel(host, "claude-mythos-5-1")
    const responseHook = host.hooks.get("http.response")
    if (!responseHook) throw new Error("http.response hook is not registered")
    const unauthorized = new Request(`${baseURL}/v1/messages`, { method: "POST" })
    const wire: WireRequest[] = []

    // Act
    await responseHook.callback({ request: unauthorized, response: new Response(null, { status: 401 }) })
    await generate(host, modelInfo, wire)

    // Assert
    expect(wire).toHaveLength(1)
    expect(wire[0].headers.get("authorization")).toBe(`Bearer ${fixtureToken}`)
    expect(host.providerCalls).toEqual([{ forceRefresh: true }])
  })
})
