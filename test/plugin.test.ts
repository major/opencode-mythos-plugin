import { describe, expect, test } from "bun:test"
import type { SessionHttpRequest, SessionHttpResponse } from "@opencode/plugin/promise/session"
import { apiBaseURL, applyOAuthHeaders, createTokenSource, mergeBeta, parseProfile, type CredentialResult } from "../src/index"
import { fixtureCredentials, fixtureToken, runSetup, type HookRegistration } from "./helpers"

/** Finds the one registered hook with the given name. Fails the test when it is missing. */
function findHook(hooks: HookRegistration[], name: string): HookRegistration {
  const hook = hooks.find((candidate) => candidate.name === name)
  if (!hook) throw new Error(`Missing hook ${name}`)
  return hook
}

/** Builds the minimal http.request event shape the plugin reads. */
function httpEvent(headers: Record<string, string>, url = "https://api.anthropic.com/v1/messages"): SessionHttpRequest {
  return { request: new Request(url, { method: "POST", headers }) } as unknown as SessionHttpRequest
}

/** Builds the minimal http.response event shape the plugin reads. */
function responseEvent(status: number): SessionHttpResponse {
  return { response: new Response(null, { status }) } as unknown as SessionHttpResponse
}

/** Settles one pending provider call. Calls are settled in the order the provider received them. */
interface PendingCall {
  readonly resolve: (token: string) => void
  readonly reject: (error: Error) => void
}

/**
 * Credentials whose provider calls stay pending until the test settles them. `calls` records the
 * options of each call, and `pending` lists the settle functions in call order.
 */
function deferredCredentials(): { credentials: CredentialResult; calls: Array<{ forceRefresh?: boolean }>; pending: PendingCall[] } {
  const calls: Array<{ forceRefresh?: boolean }> = []
  const pending: PendingCall[] = []
  const credentials = fixtureCredentials({
    /** Records the call and returns a promise that only the test settles. */
    provider: (opts) => {
      calls.push({ ...opts })
      return new Promise<{ token: string; expiresAt: null }>((resolve, reject) => {
        pending.push({ resolve: (token) => resolve({ token, expiresAt: null }), reject })
      })
    },
  })
  return { credentials, calls, pending }
}

/** Waits one macrotask, so chained microtasks such as serialized provider calls have run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Runs the function and returns what it threw, or undefined when it did not throw. */
function captureError(run: () => unknown): Error | undefined {
  try {
    run()
  } catch (failure) {
    return failure as Error
  }
  return undefined
}

/**
 * Credentials whose provider records the options it receives on each call.
 * The first `failures` calls throw, which tests use to simulate a failed refresh.
 */
function recordingCredentials({ failures = 0 } = {}): { credentials: CredentialResult; calls: Array<{ forceRefresh?: boolean }> } {
  const calls: Array<{ forceRefresh?: boolean }> = []
  const credentials = fixtureCredentials({
    /** Records the options, then fails for the first `failures` calls and succeeds afterwards. */
    provider: async (opts) => {
      calls.push({ ...opts })
      if (calls.length <= failures) throw new Error(`refresh failed for ${fixtureToken}`)
      return { token: `token-${calls.length}`, expiresAt: null }
    },
  })
  return { credentials, calls }
}

describe("Mythos http.request hook", () => {
  test("registers the request and response hooks for the mythos provider only", async () => {
    // Act
    const { hooks } = await runSetup({ credentials: fixtureCredentials() })

    // Assert
    expect(hooks.map((hook) => hook.name)).toEqual(["http.request", "http.response"])
    expect(hooks.map((hook) => hook.options)).toEqual([{ providerID: "mythos" }, { providerID: "mythos" }])
  })

  test("swaps the API key for the bearer token and merges beta flags", async () => {
    // Arrange
    const { hooks } = await runSetup({ credentials: fixtureCredentials() })
    const event = httpEvent({ "x-api-key": "sk-should-go", "anthropic-beta": "foo" })

    // Act
    await findHook(hooks, "http.request").callback(event)

    // Assert
    const headers = event.request.headers
    expect(headers.get("x-api-key")).toBeNull()
    expect(headers.get("authorization")).toBe(`Bearer ${fixtureToken}`)
    expect(headers.get("anthropic-workspace-id")).toBe("ws_fixture")
    expect(headers.get("anthropic-beta")?.split(",")).toEqual(expect.arrayContaining(["foo", "oauth-2025-04-20"]))
  })

  test("uses the token returned by the SDK provider on every request", async () => {
    // Arrange
    const { credentials } = recordingCredentials()
    const { hooks } = await runSetup({ credentials })
    const first = httpEvent({})
    const second = httpEvent({})

    // Act
    await findHook(hooks, "http.request").callback(first)
    await findHook(hooks, "http.request").callback(second)

    // Assert
    expect(first.request.headers.get("authorization")).toBe("Bearer token-1")
    expect(second.request.headers.get("authorization")).toBe("Bearer token-2")
  })

  test("reports a sanitized error when the SDK provider fails", async () => {
    // Arrange
    const { credentials } = recordingCredentials({ failures: 1 })
    const { hooks } = await runSetup({ credentials })

    // Act
    const attempt = findHook(hooks, "http.request").callback(httpEvent({}))

    // Assert
    const error = await Promise.resolve(attempt).then(() => undefined, (failure: unknown) => failure as Error)
    expect(error?.message).toBe("Mythos: could not load Anthropic profile credentials. Run `ant auth login`.")
    expect(error?.message).not.toContain(fixtureToken)
  })

  test("sends the bearer token to the origin of the configured base URL", async () => {
    // Arrange
    const { hooks } = await runSetup({ options: { baseURL: "http://localhost:1234" }, credentials: fixtureCredentials() })
    const event = httpEvent({}, "http://localhost:1234/v1/messages")

    // Act
    await findHook(hooks, "http.request").callback(event)

    // Assert
    expect(event.request.headers.get("authorization")).toBe(`Bearer ${fixtureToken}`)
  })

  test.each([
    { name: "another host", url: "https://evil.example.test/v1/messages", origin: "https://evil.example.test" },
    { name: "the same host over plain http", url: "http://api.anthropic.com/v1/messages", origin: "http://api.anthropic.com" },
    { name: "the same host on another port", url: "https://api.anthropic.com:8443/v1/messages", origin: "https://api.anthropic.com:8443" },
  ])("refuses to send credentials to $name", async ({ url, origin }) => {
    // Arrange
    const { credentials, calls } = recordingCredentials()
    const { hooks } = await runSetup({ credentials })
    const event = httpEvent({ "x-api-key": "sk-should-go" }, url)

    // Act
    const attempt = findHook(hooks, "http.request").callback(event)

    // Assert
    await expect(attempt).rejects.toThrow(`Mythos: refusing to send credentials to ${origin}`)
    expect(event.request.headers.get("x-api-key")).toBeNull()
    expect(event.request.headers.get("authorization")).toBeNull()
    expect(calls).toEqual([])
  })
})

describe("Mythos http.response hook", () => {
  test.each([
    { status: 200 },
    { status: 403 },
    { status: 500 },
  ])("keeps the cached token after a $status response", async ({ status }) => {
    // Arrange
    const { credentials, calls } = recordingCredentials()
    const { hooks } = await runSetup({ credentials })

    // Act
    await findHook(hooks, "http.request").callback(httpEvent({}))
    await findHook(hooks, "http.response").callback(responseEvent(status))
    await findHook(hooks, "http.request").callback(httpEvent({}))

    // Assert
    expect(calls).toEqual([{ forceRefresh: false }, { forceRefresh: false }])
  })

  test("a 401 response forces a refresh on the next request", async () => {
    // Arrange
    const { credentials, calls } = recordingCredentials()
    const { hooks } = await runSetup({ credentials })

    // Act
    await findHook(hooks, "http.request").callback(httpEvent({}))
    await findHook(hooks, "http.response").callback(responseEvent(401))
    await findHook(hooks, "http.request").callback(httpEvent({}))

    // Assert
    expect(calls).toEqual([{ forceRefresh: false }, { forceRefresh: true }])
  })
})

describe("createTokenSource", () => {
  test("shares one in-flight provider call between concurrent callers", async () => {
    // Arrange
    const { credentials, calls } = recordingCredentials()
    const source = createTokenSource(credentials)

    // Act
    const tokens = await Promise.all(Array.from({ length: 5 }, () => source.get()))

    // Assert
    expect(calls).toHaveLength(1)
    expect(new Set(tokens)).toEqual(new Set(["token-1"]))
  })

  test("calls the provider again once the previous call has settled", async () => {
    // Arrange
    const { credentials, calls } = recordingCredentials()
    const source = createTokenSource(credentials)

    // Act
    const first = await source.get()
    const second = await source.get()

    // Assert
    expect([first, second]).toEqual(["token-1", "token-2"])
    expect(calls).toHaveLength(2)
  })

  test("forces one refresh after invalidate, then returns to normal reads", async () => {
    // Arrange
    const { credentials, calls } = recordingCredentials()
    const source = createTokenSource(credentials)

    // Act
    source.invalidate()
    await source.get()
    await source.get()

    // Assert
    expect(calls).toEqual([{ forceRefresh: true }, { forceRefresh: false }])
  })

  test("keeps the forced refresh pending when that call fails", async () => {
    // Arrange
    const { credentials, calls } = recordingCredentials({ failures: 1 })
    const source = createTokenSource(credentials)
    source.invalidate()

    // Act
    await expect(source.get()).rejects.toThrow("Mythos: could not load Anthropic profile credentials.")
    await source.get()

    // Assert
    expect(calls).toEqual([{ forceRefresh: true }, { forceRefresh: true }])
  })

  test("a get() after invalidate waits for the older in-flight call, then forces a refresh", async () => {
    // Arrange
    const { credentials, calls, pending } = deferredCredentials()
    const source = createTokenSource(credentials)
    const before = source.get()
    source.invalidate()

    // Act
    const after = source.get()
    await flush()
    const callsWhileOldPending = [...calls]
    pending[0].resolve("old-token")
    const beforeToken = await before
    await flush()
    const callsAfterOldSettled = [...calls]
    pending[1].resolve("new-token")
    const afterToken = await after

    // Assert
    expect(callsWhileOldPending).toEqual([{ forceRefresh: false }])
    expect(beforeToken).toBe("old-token")
    expect(callsAfterOldSettled).toEqual([{ forceRefresh: false }, { forceRefresh: true }])
    expect(afterToken).toBe("new-token")
  })

  test("concurrent get() calls after invalidate share one forced call", async () => {
    // Arrange
    const { credentials, calls, pending } = deferredCredentials()
    const source = createTokenSource(credentials)
    source.invalidate()

    // Act
    const first = source.get()
    const second = source.get()
    await flush()
    pending[0].resolve("new-token")

    // Assert
    await expect(Promise.all([first, second])).resolves.toEqual(["new-token", "new-token"])
    expect(calls).toEqual([{ forceRefresh: true }])
  })

  test("an invalidate() during a forced call keeps the next call forced", async () => {
    // Arrange
    const { credentials, calls, pending } = deferredCredentials()
    const source = createTokenSource(credentials)
    source.invalidate()
    const first = source.get()
    await flush()

    // Act
    source.invalidate()
    pending[0].resolve("possibly-stale-token")
    await first
    const second = source.get()
    await flush()
    pending[1].resolve("fresh-token")

    // Assert
    await expect(second).resolves.toBe("fresh-token")
    expect(calls).toEqual([{ forceRefresh: true }, { forceRefresh: true }])
  })

  test("throws a sanitized error without a cause", async () => {
    // Arrange
    const { credentials } = recordingCredentials({ failures: 1 })
    const source = createTokenSource(credentials)

    // Act
    const error = await source.get().then(() => undefined, (failure: unknown) => failure as Error)

    // Assert
    expect(error?.message).toBe("Mythos: could not load Anthropic profile credentials. Run `ant auth login`.")
    expect(error?.message).not.toContain(fixtureToken)
    expect(error?.cause).toBeUndefined()
  })
})

describe("applyOAuthHeaders", () => {
  test.each([
    { name: "adds the beta when absent", existing: null, expected: "oauth-2025-04-20" },
    { name: "keeps other beta values", existing: "foo", expected: "foo,oauth-2025-04-20" },
    { name: "does not duplicate the beta", existing: "oauth-2025-04-20, bar", expected: "oauth-2025-04-20,bar" },
  ])("$name", ({ existing, expected }) => {
    // Arrange
    const headers = new Headers(existing === null ? {} : { "anthropic-beta": existing })

    // Act
    applyOAuthHeaders(headers, fixtureToken, {})

    // Assert
    expect(headers.get("anthropic-beta")).toBe(expected)
  })
})

describe("Mythos helpers", () => {
  test("leaves an absent profile undefined so the SDK default applies", () => {
    expect(parseProfile(undefined)).toBeUndefined()
  })

  test("trims a configured profile name", () => {
    expect(parseProfile(" work ")).toBe("work")
  })

  test.each([
    { existing: null, addition: "a", expected: "a" },
    { existing: "a, b", addition: "b,c", expected: "a,b,c" },
    { existing: "", addition: "a", expected: "a" },
  ])("merges beta $existing + $addition", ({ existing, addition, expected }) => {
    expect(mergeBeta(existing, addition)).toBe(expected)
  })

  test.each([
    { name: "the default API host", input: undefined, expected: "https://api.anthropic.com/v1" },
    { name: "a trailing slash after /v1", input: "https://example.test/v1/", expected: "https://example.test/v1" },
    { name: "a bare https host", input: "https://example.test", expected: "https://example.test/v1" },
    { name: "a localhost http host", input: "http://localhost:1234/api/", expected: "http://localhost:1234/api/v1" },
    { name: "an IPv4 loopback host", input: "http://127.0.0.1:8080", expected: "http://127.0.0.1:8080/v1" },
    { name: "another 127.x.y.z address", input: "http://127.255.0.9/", expected: "http://127.255.0.9/v1" },
    { name: "a *.localhost host", input: "http://app.localhost:3000", expected: "http://app.localhost:3000/v1" },
    { name: "an IPv6 loopback host", input: "http://[::1]:4000", expected: "http://[::1]:4000/v1" },
  ])("accepts $name", ({ input, expected }) => {
    // Act
    const result = apiBaseURL(input)

    // Assert
    expect(result).toBe(expected)
  })

  test.each([
    { name: "a non-string value", input: 42 },
    { name: "a file URL", input: "file:///etc/passwd" },
    { name: "an unparsable URL", input: "not a url" },
    { name: "plain http to a remote host", input: "http://example.test" },
    { name: "plain http to a private LAN address", input: "http://10.0.0.5:8080" },
    { name: "plain http to a localhost look-alike", input: "http://localhost.example.test" },
    { name: "plain http to a loopback-looking DNS name", input: "http://127.0.0.1.example.test" },
    { name: "plain http to an IPv6 address other than ::1", input: "http://[::2]:8080" },
    { name: "credentials in the URL", input: "https://user:pw@example.test" },
    { name: "a query string", input: "https://example.test/?key=1" },
    { name: "a fragment", input: "https://example.test/#x" },
  ])("rejects $name", ({ input }) => {
    // Act
    const error = captureError(() => apiBaseURL(input))

    // Assert
    expect(error?.message).toContain("Invalid API base URL")
  })
})
