import { describe, expect, it, vi } from "vitest";
import { LLMAdapter } from "@langfuse/shared/src/server";
import {
  runLowConfidenceBackstop,
  type BackstopConfig,
  type BackstopDeps,
  type BackstopModelConfig,
  type BackstopScore,
} from "../lowConfidenceBackstop";
import { type BackstopRubricEntry } from "../backstopRubric";

const MODEL_CONFIG: BackstopModelConfig = {
  adapter: LLMAdapter.OpenAI,
  model: "google/gemini-2.5-flash",
  secretKey: "encrypted",
  extraHeaders: null,
  baseURL: "https://openrouter.ai/api/v1",
  config: null,
};

const RUBRIC: Record<string, BackstopRubricEntry> = {
  rework_reason: {
    scoreName: "rework_reason",
    kind: "choice",
    dataType: "CATEGORICAL",
    options: ["Not rework", "Misunderstood", "Incomplete"],
    instructions: "Why was work redone?",
  },
  // Effort-hour question: present in the map on purpose to prove it is always
  // excluded from the active rubric.
  effort_estimate_hours: {
    scoreName: "effort_estimate_hours",
    kind: "score",
    dataType: "NUMERIC",
    levels: ["0", "1", "2"],
    instructions: "Estimate hours.",
  },
};

function makeScore(partial: Partial<BackstopScore> = {}): BackstopScore {
  return {
    id: "s1",
    name: "rework_reason",
    value: 0,
    stringValue: "Not rework",
    dataType: "CATEGORICAL",
    traceId: "t1",
    observationId: "o1",
    environment: "default",
    metadata: { typesafe: { questionId: "rework_reason", confidence: 0.29 } },
    ...partial,
  };
}

function makeDeps(
  scores: BackstopScore[],
  overrides: Partial<BackstopDeps> = {},
): BackstopDeps {
  return {
    listCandidateScores: vi.fn(async () => scores),
    fetchObservationIO: vi.fn(async () => ({ input: "in", output: "out" })),
    fetchModelConfig: vi.fn(async () => ({
      valid: true as const,
      config: MODEL_CONFIG,
    })),
    judge: vi.fn(async () => ({
      choice: "Misunderstood",
      reasoning: "redone",
    })),
    uploadScore: vi.fn(async () => {}),
    enqueueScoreIngestion: vi.fn(async () => {}),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeConfig(partial: Partial<BackstopConfig> = {}): BackstopConfig {
  return {
    projectIds: ["p1"],
    confidenceThreshold: 0.3,
    lookbackMinutes: 120,
    maxPerRun: 50,
    dryRun: false,
    model: "google/gemini-2.5-flash",
    rubric: RUBRIC,
    ...partial,
  };
}

describe("runLowConfidenceBackstop", () => {
  it("skips scores whose confidence is at or above the threshold", async () => {
    const scores = [
      makeScore({
        metadata: {
          typesafe: { questionId: "rework_reason", confidence: 0.9 },
        },
      }),
    ];
    const deps = makeDeps(scores);

    const result = await runLowConfidenceBackstop(makeConfig(), deps);

    expect(result.rescued).toBe(0);
    expect(result.skipped).toBe(1);
    expect(deps.uploadScore).not.toHaveBeenCalled();
    expect(deps.enqueueScoreIngestion).not.toHaveBeenCalled();
  });

  it("skips scores already carrying rescued_from_jev metadata", async () => {
    const scores = [
      makeScore({
        metadata: {
          typesafe: { questionId: "rework_reason", confidence: 0.1 },
          rescued_from_jev: { original_value: "Not rework" },
        },
      }),
    ];
    const deps = makeDeps(scores);

    const result = await runLowConfidenceBackstop(makeConfig(), deps);

    expect(result.rescued).toBe(0);
    expect(result.skipped).toBe(1);
    expect(deps.judge).not.toHaveBeenCalled();
    expect(deps.uploadScore).not.toHaveBeenCalled();
  });

  it("excludes effort-hour questions even when present in the rubric", async () => {
    const scores = [
      makeScore({
        id: "s-hours",
        name: "effort_estimate_hours",
        dataType: "NUMERIC",
        stringValue: null,
        value: 3,
        metadata: {
          typesafe: { questionId: "effort_estimate_hours", confidence: 0.05 },
        },
      }),
    ];
    const deps = makeDeps(scores);

    const result = await runLowConfidenceBackstop(makeConfig(), deps);

    expect(result.rescued).toBe(0);
    expect(deps.judge).not.toHaveBeenCalled();
    expect(deps.uploadScore).not.toHaveBeenCalled();
  });

  it("records a per-score error and continues when the judge returns an out-of-options choice", async () => {
    const scores = [
      makeScore({ id: "bad" }),
      makeScore({ id: "good", observationId: "o2" }),
    ];
    const judge = vi
      .fn()
      .mockResolvedValueOnce({ choice: "Not an option", reasoning: "x" })
      .mockResolvedValueOnce({ choice: "Misunderstood", reasoning: "y" });
    const deps = makeDeps(scores, { judge });

    const result = await runLowConfidenceBackstop(makeConfig(), deps);

    expect(result.errors).toBe(1);
    expect(result.rescued).toBe(1);
    expect(deps.uploadScore).toHaveBeenCalledTimes(1);
    const uploadArg = (deps.uploadScore as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(uploadArg.scoreId).toBe("good");
  });

  it("upserts in place with provenance on the happy path", async () => {
    const scores = [makeScore()];
    const deps = makeDeps(scores);

    const result = await runLowConfidenceBackstop(makeConfig(), deps);

    expect(result.rescued).toBe(1);
    expect(deps.uploadScore).toHaveBeenCalledTimes(1);
    expect(deps.enqueueScoreIngestion).toHaveBeenCalledTimes(1);

    const uploadArg = (deps.uploadScore as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const enqueueArg = (deps.enqueueScoreIngestion as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];

    // Same id as the original score => upsert, not a second score.
    expect(uploadArg.scoreId).toBe("s1");
    expect(uploadArg.event.body.id).toBe("s1");
    expect(enqueueArg.scoreId).toBe("s1");
    expect(uploadArg.eventId).toBe(enqueueArg.eventId);

    expect(uploadArg.event.body.value).toBe("Misunderstood");
    expect(uploadArg.event.body.dataType).toBe("CATEGORICAL");

    const rescued = uploadArg.event.body.metadata.rescued_from_jev;
    expect(rescued.original_value).toBe("Not rework");
    expect(rescued.original_confidence).toBe(0.29);
    expect(rescued.model).toBe("google/gemini-2.5-flash");
    expect(rescued.threshold).toBe(0.3);
    // Original typesafe block is preserved.
    expect(uploadArg.event.body.metadata.typesafe.questionId).toBe(
      "rework_reason",
    );
  });

  it("writes nothing in dry-run mode", async () => {
    const scores = [makeScore()];
    const deps = makeDeps(scores);

    const result = await runLowConfidenceBackstop(
      makeConfig({ dryRun: true }),
      deps,
    );

    expect(result.rescued).toBe(1);
    expect(deps.judge).toHaveBeenCalledTimes(1);
    expect(deps.uploadScore).not.toHaveBeenCalled();
    expect(deps.enqueueScoreIngestion).not.toHaveBeenCalled();
  });
});
