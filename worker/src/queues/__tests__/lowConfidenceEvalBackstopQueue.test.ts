import { describe, expect, it, vi, beforeEach } from "vitest";
import { createProductionBackstopDeps } from "../lowConfidenceEvalBackstopQueue";

const { mockFetchValidModelConfig } = vi.hoisted(() => ({
  mockFetchValidModelConfig: vi.fn(),
}));

vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@langfuse/shared/src/server")>();
  return {
    ...original,
    DefaultEvalModelService: {
      ...original.DefaultEvalModelService,
      fetchValidModelConfig: mockFetchValidModelConfig,
    },
  };
});

describe("createProductionBackstopDeps.fetchModelConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the adapter from the matched LLM API key, not the selected model config", async () => {
    // DefaultEvalModelService.fetchValidModelConfig's `config` never carries an
    // `adapter` field on either its explicit-provider or default-model path;
    // only the matched `apiKey` row has a real adapter. Regression for the
    // backstop reading a nonexistent `config.adapter` (always undefined),
    // which made every rescue fail with "Unsupported LLM adapter: undefined".
    mockFetchValidModelConfig.mockResolvedValue({
      valid: true,
      config: {
        provider: "langfuse-openrouter-key",
        model: "google/gemini-2.5-flash",
        apiKey: {
          adapter: "openai",
          secretKey: "encrypted-secret",
          extraHeaders: null,
          baseURL: "https://openrouter.ai/api/v1",
          config: null,
        },
      },
    });

    const deps = createProductionBackstopDeps();
    const result = await deps.fetchModelConfig("project-id");

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.config.adapter).toBe("openai");
      expect(result.config.model).toBe("google/gemini-2.5-flash");
    }
  });
});
