import { Processor } from "bullmq";
import {
  logger,
  generateLLMText,
  getScoresForObservations,
  getObservationByIdFromEventsTable,
  getObservationsV2FromEventsTableForPublicApi,
  DefaultEvalModelService,
} from "@langfuse/shared/src/server";
import { env } from "../env";
import { createProductionEvalExecutionDeps } from "../features/evaluation/evalExecutionDeps";
import { BACKSTOP_RUBRIC } from "../features/evalBackstop/backstopRubric";
import {
  runLowConfidenceBackstop,
  type BackstopConfig,
  type BackstopDeps,
} from "../features/evalBackstop/lowConfidenceBackstop";

const CONVERSATIONAL_TURN_NAME = "Conversational Turn";
const BACKSTOP_RECENT_TURN_LIMIT = 500;

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

/**
 * Production dependency implementation. Reads scores and observations from
 * ClickHouse, resolves the model/key from Postgres, and reuses the eval
 * execution deps for score persistence.
 */
function createProductionBackstopDeps(): BackstopDeps {
  const evalDeps = createProductionEvalExecutionDeps();

  return {
    listCandidateScores: async ({ projectId, lookbackMinutes, scoreNames }) => {
      const minTimestamp = new Date(Date.now() - lookbackMinutes * 60_000);

      // Recent root "Conversational Turn" observations in the window.
      const observations = await getObservationsV2FromEventsTableForPublicApi({
        projectId,
        page: 1,
        limit: BACKSTOP_RECENT_TURN_LIMIT,
        name: CONVERSATIONAL_TURN_NAME,
        isRootObservation: true,
        fromStartTime: minTimestamp.toISOString(),
        toStartTime: new Date().toISOString(),
        fields: ["core"],
      });

      const observationIds = observations
        .map((o) => o.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (observationIds.length === 0) return [];

      const scores = await getScoresForObservations({
        projectId,
        observationIds,
        minTimestamp,
      });

      const wanted = new Set(scoreNames);
      return scores
        .filter((s) => wanted.has(s.name))
        .map((s) => ({
          id: s.id,
          name: s.name,
          value: s.value,
          stringValue: s.stringValue,
          dataType: s.dataType,
          traceId: s.traceId,
          observationId: s.observationId,
          environment: s.environment,
          metadata: s.metadata as Record<string, unknown> | null | undefined,
        }));
    },

    fetchObservationIO: async ({ id, projectId, traceId }) => {
      const observation = await getObservationByIdFromEventsTable({
        id,
        projectId,
        fetchWithInputOutput: true,
        ...(traceId ? { traceId } : {}),
      });
      return {
        input: observation?.input ?? null,
        output: observation?.output ?? null,
      };
    },

    fetchModelConfig: async (projectId) => {
      const result = await DefaultEvalModelService.fetchValidModelConfig(
        projectId,
        env.LANGFUSE_EVAL_BACKSTOP_PROVIDER,
        env.LANGFUSE_EVAL_BACKSTOP_MODEL,
      );
      if (!result.valid) {
        return { valid: false, error: result.error };
      }
      const apiKey = result.config.apiKey;
      return {
        valid: true,
        config: {
          adapter: result.config.adapter,
          model: result.config.model,
          secretKey: apiKey.secretKey,
          extraHeaders: apiKey.extraHeaders,
          baseURL: apiKey.baseURL,
          config: apiKey.config,
        },
      };
    },

    judge: async ({ rubric, input, output, modelConfig }) => {
      const answerShape =
        rubric.kind === "choice"
          ? `{"choice": <one of ${JSON.stringify(rubric.options ?? [])}>, "reasoning": "<one sentence>"}`
          : `{"score": <a number, index into ${JSON.stringify(rubric.levels ?? [])}>, "reasoning": "<one sentence>"}`;

      const systemPrompt =
        "You are a careful evaluator re-judging a single question about a conversational turn between a user and an AI assistant. " +
        "Respond with ONLY minified JSON and nothing else.";
      const userPrompt = [
        `Question instructions:\n${rubric.instructions}`,
        rubric.kind === "choice"
          ? `Allowed options: ${JSON.stringify(rubric.options ?? [])}`
          : `Levels (index = value): ${JSON.stringify(rubric.levels ?? [])}`,
        `Turn input:\n${JSON.stringify(input)}`,
        `Turn output:\n${JSON.stringify(output)}`,
        `Answer strictly as JSON of the form: ${answerShape}`,
      ].join("\n\n");

      const generated = await generateLLMText({
        model: { adapter: modelConfig.adapter, id: modelConfig.model },
        connection: {
          secretKey: modelConfig.secretKey,
          extraHeaders: modelConfig.extraHeaders,
          baseURL: modelConfig.baseURL,
          config: modelConfig.config,
        },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        maxOutputTokens: 512,
        timeout: env.LANGFUSE_EVAL_BACKSTOP_LLM_TIMEOUT_MS,
      });

      let parsed: { choice?: unknown; score?: unknown; reasoning?: unknown };
      try {
        parsed = JSON.parse(stripJsonFences(generated.text));
      } catch {
        throw new Error(
          `Backstop judge returned non-JSON output for "${rubric.scoreName}"`,
        );
      }

      return {
        choice: typeof parsed.choice === "string" ? parsed.choice : undefined,
        score: typeof parsed.score === "number" ? parsed.score : undefined,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      };
    },

    uploadScore: (params) => evalDeps.uploadScore(params),
    enqueueScoreIngestion: (params) => evalDeps.enqueueScoreIngestion(params),
    now: () => new Date(),
  };
}

function parseIdList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

/** Builds the run configuration from the worker environment. */
function buildBackstopConfigFromEnv(): BackstopConfig {
  return {
    projectIds: parseIdList(env.LANGFUSE_EVAL_BACKSTOP_PROJECT_IDS) ?? [],
    confidenceThreshold: env.LANGFUSE_EVAL_BACKSTOP_CONFIDENCE_THRESHOLD,
    lookbackMinutes: env.LANGFUSE_EVAL_BACKSTOP_LOOKBACK_MINUTES,
    maxPerRun: env.LANGFUSE_EVAL_BACKSTOP_MAX_PER_RUN,
    dryRun: env.LANGFUSE_EVAL_BACKSTOP_DRY_RUN !== "false",
    model: env.LANGFUSE_EVAL_BACKSTOP_MODEL,
    questionIds: parseIdList(env.LANGFUSE_EVAL_BACKSTOP_QUESTION_IDS),
    excludeQuestionIds: parseIdList(
      env.LANGFUSE_EVAL_BACKSTOP_EXCLUDE_QUESTION_IDS,
    ),
    rubric: BACKSTOP_RUBRIC,
  };
}

export const lowConfidenceEvalBackstopProcessor: Processor =
  async (): Promise<void> => {
    const config = buildBackstopConfigFromEnv();

    if (config.projectIds.length === 0) {
      logger.warn(
        "[eval-backstop] No project ids configured (LANGFUSE_EVAL_BACKSTOP_PROJECT_IDS); skipping run",
      );
      return;
    }

    logger.info(
      `[eval-backstop] Starting run for ${config.projectIds.length} project(s)${config.dryRun ? " (dry run)" : ""}`,
    );

    await runLowConfidenceBackstop(config, createProductionBackstopDeps());
  };
