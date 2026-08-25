import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createLLMProvider,
  getLLMProvider,
  setLLMProviderForTests,
  shouldUseMockProvider,
} from "../src/lib/get-llm-provider";
import {
  LLMOutputError,
  LLMPromptError,
  LLMSchemaUnsupportedError,
  LLMTimeoutError,
  redactSensitive,
} from "../src/lib/llm-provider";
import { MockLLMProvider } from "../src/lib/providers/mock-provider";
import { RealLLMProvider, type ChatCompletionLike } from "../src/lib/providers/real-provider";
import { blockedLlmUrls, capturedLogText } from "./setup";

const demoSchema = z.object({
  category: z.string(),
  budget: z.number(),
});

const demoFixture = { category: "Sports", budget: 5000 };
const DEMO_PROMPT = "buy running shoes under 5000";

function fakeClient(create: ChatCompletionLike["chat"]["completions"]["create"]): ChatCompletionLike {
  return { chat: { completions: { create } } };
}

function completion(content: string | null) {
  return { choices: [{ message: { content } }] };
}

describe("MockLLMProvider", () => {
  it("returns identical schema-valid output across repeated calls with the same fixture key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new MockLLMProvider({
      fixtures: { [DEMO_PROMPT]: demoFixture },
    });

    const first = await provider.generateStructured({ prompt: DEMO_PROMPT, schema: demoSchema });
    const second = await provider.generateStructured({ prompt: DEMO_PROMPT, schema: demoSchema });

    expect(first).toEqual(demoFixture);
    expect(second).toEqual(demoFixture);
    expect(first).toEqual(second);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("retries exactly once on malformed JSON then throws LLMOutputError", async () => {
    const provider = new MockLLMProvider({
      rawByPrompt: {
        broken: ["not-json", "still-not-json"],
      },
    });

    await expect(
      provider.generateStructured({ prompt: "broken", schema: z.object({ ok: z.boolean() }) }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LLMOutputError);
      const output = err as LLMOutputError;
      expect(output.name).toBe("LLMOutputError");
      expect(output.rawOutput).toBe("still-not-json");
      expect(output.issue).toMatch(/malformed json/i);
      return true;
    });

    expect(provider.completeCalls).toHaveLength(2);
    expect(provider.completeCalls.map((call) => call.attempt)).toEqual([1, 2]);
  });

  it("retries exactly once on schema-mismatched JSON then throws LLMOutputError", async () => {
    const provider = new MockLLMProvider({
      rawByPrompt: {
        mismatch: ['{"nope":true}', '{"still":"wrong"}'],
      },
    });

    await expect(
      provider.generateStructured({ prompt: "mismatch", schema: z.object({ ok: z.boolean() }) }),
    ).rejects.toBeInstanceOf(LLMOutputError);
    expect(provider.completeCalls).toHaveLength(2);
  });

  it("returns the second attempt when the first payload fails schema validation", async () => {
    const provider = new MockLLMProvider({
      rawByPrompt: {
        recover: ["not-json", { ok: true }],
      },
    });

    await expect(
      provider.generateStructured({ prompt: "recover", schema: z.object({ ok: z.boolean() }) }),
    ).resolves.toEqual({ ok: true });
    expect(provider.completeCalls).toHaveLength(2);
  });

  it("produces LLMTimeoutError when the mock never resolves", async () => {
    const provider = new MockLLMProvider({ hangPrompts: ["never"] });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      await expect(
        provider.generateStructured({
          prompt: "never",
          schema: z.object({ ok: z.boolean() }),
          timeoutMs: 40,
        }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(LLMTimeoutError);
        expect((err as LLMTimeoutError).name).toBe("LLMTimeoutError");
        expect((err as LLMTimeoutError).timeoutMs).toBe(40);
        return true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rejects an empty prompt before invoking the completion", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new MockLLMProvider({ fixtures: { hi: { ok: true } } });

    await expect(
      provider.generateStructured({ prompt: "   ", schema: z.object({ ok: z.boolean() }) }),
    ).rejects.toBeInstanceOf(LLMPromptError);
    expect(provider.completeCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("RealLLMProvider", () => {
  it("validates structured JSON from the vendor adapter without a live network call", async () => {
    const create = vi.fn().mockResolvedValue(completion(JSON.stringify({ ok: true })));
    const provider = new RealLLMProvider({
      apiKey: "sk-test-not-a-real-key",
      client: fakeClient(create),
    });

    await expect(
      provider.generateStructured({ prompt: "ping", schema: z.object({ ok: z.boolean() }) }),
    ).resolves.toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries once on schema-invalid vendor output then throws LLMOutputError", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(completion("not-json"))
      .mockResolvedValueOnce(completion("still-not-json"));
    const provider = new RealLLMProvider({
      apiKey: "sk-test-not-a-real-key",
      client: fakeClient(create),
    });

    await expect(
      provider.generateStructured({ prompt: "ping", schema: z.object({ ok: z.boolean() }) }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LLMOutputError);
      expect((err as LLMOutputError).rawOutput).toBe("still-not-json");
      return true;
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty prompt before calling the vendor SDK", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const create = vi.fn();
    const injected = new RealLLMProvider({
      apiKey: "sk-test-not-a-real-key",
      client: fakeClient(create),
    });
    const live = new RealLLMProvider({ apiKey: "sk-test-not-a-real-key" });

    await expect(
      injected.generateStructured({ prompt: "", schema: z.object({ ok: z.boolean() }) }),
    ).rejects.toBeInstanceOf(LLMPromptError);
    await expect(
      live.generateStructured({ prompt: "   ", schema: z.object({ ok: z.boolean() }) }),
    ).rejects.toBeInstanceOf(LLMPromptError);
    expect(create).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("fails closed on schemas OpenAI structured output cannot represent", async () => {
    const create = vi.fn();
    const provider = new RealLLMProvider({
      apiKey: "sk-test-not-a-real-key",
      client: fakeClient(create),
    });

    await expect(
      provider.generateStructured({
        prompt: "ping",
        schema: z.object({ extra: z.record(z.string()) }),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LLMSchemaUnsupportedError);
      expect((err as Error).message).toMatch(/z\.record/i);
      return true;
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("times out a hanging vendor call with LLMTimeoutError", async () => {
    const create = vi.fn().mockImplementation((_body, options?: { signal?: AbortSignal }) => {
      return new Promise((_, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "APIUserAbortError" }));
        });
      });
    });
    const provider = new RealLLMProvider({
      apiKey: "sk-test-not-a-real-key",
      client: fakeClient(create),
    });

    await expect(
      provider.generateStructured({
        prompt: "ping",
        schema: z.object({ ok: z.boolean() }),
        timeoutMs: 40,
      }),
    ).rejects.toBeInstanceOf(LLMTimeoutError);
  });
});

describe("getLLMProvider factory", () => {
  afterEach(() => {
    setLLMProviderForTests(null);
  });

  it("selects the mock when NODE_ENV is test even if LLM_PROVIDER is openai", () => {
    const provider = createLLMProvider({
      NODE_ENV: "test",
      LLM_PROVIDER: "openai",
      LLM_PROVIDER_API_KEY: "sk-should-never-be-used",
    });
    expect(provider).toBeInstanceOf(MockLLMProvider);
    expect(shouldUseMockProvider({ NODE_ENV: "test", LLM_PROVIDER: "openai" })).toBe(true);
  });

  it("selects the mock when LLM_PROVIDER=mock", () => {
    const provider = createLLMProvider({
      NODE_ENV: "development",
      LLM_PROVIDER: "mock",
      LLM_PROVIDER_API_KEY: "sk-should-never-be-used",
    });
    expect(provider).toBeInstanceOf(MockLLMProvider);
  });

  it("selects the real OpenAI adapter outside tests when LLM_PROVIDER is openai", () => {
    const provider = createLLMProvider({
      NODE_ENV: "development",
      LLM_PROVIDER: "openai",
      LLM_PROVIDER_API_KEY: "sk-test-not-a-real-key",
    });
    expect(provider).toBeInstanceOf(RealLLMProvider);
  });

  it("returns the injected test provider from getLLMProvider", async () => {
    const mock = new MockLLMProvider({ fixtures: { [DEMO_PROMPT]: demoFixture } });
    setLLMProviderForTests(mock);
    const viaFactory = getLLMProvider();
    expect(viaFactory).toBe(mock);
    await expect(
      viaFactory.generateStructured({ prompt: DEMO_PROMPT, schema: demoSchema }),
    ).resolves.toEqual(demoFixture);
  });

  it("getLLMProvider() in NODE_ENV=test is the mock, never the live OpenAI adapter", () => {
    setLLMProviderForTests(null);
    const provider = getLLMProvider();
    expect(provider).toBeInstanceOf(MockLLMProvider);
    expect(provider).not.toBeInstanceOf(RealLLMProvider);
    expect(blockedLlmUrls()).toEqual([]);
  });
});

describe("secret redaction", () => {
  const originalDebug = process.env.DEBUG_LLM;

  beforeEach(() => {
    process.env.DEBUG_LLM = "true";
  });

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env.DEBUG_LLM;
    } else {
      process.env.DEBUG_LLM = originalDebug;
    }
    vi.restoreAllMocks();
  });

  it("never includes API key material in debug logs or redacted fields", async () => {
    const secret = "sk-secret-test-key-do-not-leak";
    const before = capturedLogText();

    const provider = new MockLLMProvider({ fixtures: { [DEMO_PROMPT]: demoFixture } });
    await provider.generateStructured({ prompt: DEMO_PROMPT, schema: demoSchema });

    const real = new RealLLMProvider({
      apiKey: secret,
      client: fakeClient(vi.fn().mockResolvedValue(completion(JSON.stringify({ ok: true })))),
    });
    await real.generateStructured({
      prompt: `ping with ${secret}`,
      schema: z.object({ ok: z.boolean() }),
    });

    const dumped = capturedLogText().slice(before.length);
    expect(dumped).not.toContain(secret);
    expect(dumped).toMatch(/\[redacted\]/);
    expect(redactSensitive({ apiKey: secret, prompt: `Bearer ${secret}` })).toEqual({
      apiKey: "[redacted]",
      prompt: "Bearer [redacted]",
    });
  });
});
