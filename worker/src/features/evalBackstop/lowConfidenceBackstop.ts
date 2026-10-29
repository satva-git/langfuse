import { randomUUID } from "crypto";
import { ScoreSourceEnum } from "@langfuse/shared";
import {
  eventTypes,
  logger,
  traceException,
  type LLMAdapter,
  type LLMConnection,
  type ScoreEventType,
} from "@langfuse/shared/src/server";
import {
  EFFORT_HOUR_QUESTION_IDS,
  type BackstopRubricEntry,
} from "./backstopRubric";

/**
 * Minimal view of a JEV decision-model score the backstop reasons over. The
 * confidence is not a column; it lives under `metadata.typesafe.confidence`.
 */
export interface BackstopScore {
  id: string;
  name: string;
  value: number;
  stringValue?: string | null;
  dataType: string;
  traceId: string | null;
  observationId: string | null;
  environment: string;
  metadata: Record<string, unknown> | null | undefined;
}

/** Opaque, dependency-resolved model configuration passed through to `judge`. */
export interface BackstopModelConfig {
  adapter: LLMAdapter;
  model: string;
  /** Still-encrypted secret; `generateLLMText` decrypts internally. */
  secretKey: string;
  extraHeaders?: string | null;
  baseURL?: string | null;
  config?: LLMConnection["config"];
}

type BackstopModelConfigResult =
  | { valid: true; config: BackstopModelConfig }
  | { valid: false; error: string };

interface BackstopJudgeAnswer {
  choice?: string;
  score?: number;
  reasoning: string;
}

export interface BackstopDeps {
  listCandidateScores: (params: {
    projectId: string;
    lookbackMinutes: number;
    scoreNames: string[];
  }) => Promise<BackstopScore[]>;
  fetchObservationIO: (params: {
    id: string;
    projectId: string;
    traceId: string | null;
  }) => Promise<{ input: unknown; output: unknown }>;
  fetchModelConfig: (projectId: string) => Promise<BackstopModelConfigResult>;
  judge: (params: {
    rubric: BackstopRubricEntry;
    input: unknown;
    output: unknown;
    modelConfig: BackstopModelConfig;
  }) => Promise<BackstopJudgeAnswer>;
  uploadScore: (params: {
    projectId: string;
    scoreId: string;
    eventId: string;
    event: ScoreEventType;
  }) => Promise<void>;
  enqueueScoreIngestion: (params: {
    projectId: string;
    scoreId: string;
    eventId: string;
  }) => Promise<void>;
  now: () => Date;
}

export interface BackstopConfig {
  projectIds: string[];
  confidenceThreshold: number;
  lookbackMinutes: number;
  maxPerRun: number;
  dryRun: boolean;
  model: string;
  /** Allowlist filter; when set, only these question ids are considered. */
  questionIds?: string[];
  /** Question ids to exclude on top of the always-excluded effort-hour ids. */
  excludeQuestionIds?: string[];
  rubric: Record<string, BackstopRubricEntry>;
}

export interface BackstopRunResult {
  scanned: number;
  candidates: number;
  rescued: number;
  skipped: number;
  errors: number;
}

const EFFORT_HOUR_IDS = new Set<string>(EFFORT_HOUR_QUESTION_IDS);

/**
 * Resolves the active rubric for a run: the full rubric narrowed by the
 * optional include list, the optional exclude list, and the always-on
 * effort-hour exclusion.
 */
function resolveActiveRubric(
  config: BackstopConfig,
): Map<string, BackstopRubricEntry> {
  const include = config.questionIds?.length
    ? new Set(config.questionIds)
    : null;
  const exclude = new Set(config.excludeQuestionIds ?? []);

  const active = new Map<string, BackstopRubricEntry>();
  for (const [questionId, entry] of Object.entries(config.rubric)) {
    if (EFFORT_HOUR_IDS.has(questionId)) continue;
    if (exclude.has(questionId)) continue;
    if (include && !include.has(questionId)) continue;
    active.set(questionId, entry);
  }
  return active;
}

function readTypesafeMetadata(
  metadata: Record<string, unknown> | null | undefined,
): { questionId?: string; confidence?: unknown } | null {
  if (!metadata || typeof metadata !== "object") return null;
  const typesafe = (metadata as Record<string, unknown>).typesafe;
  if (!typesafe || typeof typesafe !== "object") return null;
  return typesafe as { questionId?: string; confidence?: unknown };
}

function originalScoreValue(score: BackstopScore): string | number {
  return score.dataType === "CATEGORICAL"
    ? (score.stringValue ?? "")
    : score.value;
}

/**
 * Core scan -> filter -> judge -> rescue logic. Framework-agnostic and fully
 * dependency-injected so it can be unit tested with mocks.
 */
export async function runLowConfidenceBackstop(
  config: BackstopConfig,
  deps: BackstopDeps,
): Promise<BackstopRunResult> {
  const result: BackstopRunResult = {
    scanned: 0,
    candidates: 0,
    rescued: 0,
    skipped: 0,
    errors: 0,
  };

  const activeRubric = resolveActiveRubric(config);
  if (activeRubric.size === 0) {
    logger.warn("[eval-backstop] No active rubric questions; nothing to do");
    return result;
  }
  const scoreNames = [
    ...new Set([...activeRubric.values()].map((entry) => entry.scoreName)),
  ];

  for (const projectId of config.projectIds) {
    if (result.rescued >= config.maxPerRun) break;

    let scores: BackstopScore[];
    try {
      scores = await deps.listCandidateScores({
        projectId,
        lookbackMinutes: config.lookbackMinutes,
        scoreNames,
      });
    } catch (e) {
      result.errors++;
      logger.error(
        `[eval-backstop] Failed to list candidate scores for project ${projectId}`,
        e,
      );
      traceException(e);
      continue;
    }

    let modelConfig: BackstopModelConfig | null = null;
    try {
      const cfg = await deps.fetchModelConfig(projectId);
      if (!cfg.valid) {
        logger.warn(
          `[eval-backstop] Skipping project ${projectId}: ${cfg.error}`,
        );
        continue;
      }
      modelConfig = cfg.config;
    } catch (e) {
      result.errors++;
      logger.error(
        `[eval-backstop] Failed to resolve model config for project ${projectId}`,
        e,
      );
      traceException(e);
      continue;
    }

    for (const score of scores) {
      if (result.rescued >= config.maxPerRun) break;
      result.scanned++;

      try {
        const typesafe = readTypesafeMetadata(score.metadata);
        if (!typesafe) {
          result.skipped++;
          continue;
        }

        // Allowlist + name match. The rubric is keyed by questionId; the score
        // name must equal the rubric's scoreName.
        const questionId = typesafe.questionId;
        const rubric = questionId ? activeRubric.get(questionId) : undefined;
        if (!rubric || rubric.scoreName !== score.name) {
          result.skipped++;
          continue;
        }

        // Idempotency: never touch a score we already rescued.
        if (
          score.metadata &&
          "rescued_from_jev" in (score.metadata as Record<string, unknown>)
        ) {
          result.skipped++;
          continue;
        }

        const confidence = Number(typesafe.confidence);
        if (
          !Number.isFinite(confidence) ||
          confidence >= config.confidenceThreshold
        ) {
          result.skipped++;
          continue;
        }

        if (!score.observationId) {
          result.skipped++;
          continue;
        }

        result.candidates++;

        const observation = await deps.fetchObservationIO({
          id: score.observationId,
          projectId,
          traceId: score.traceId,
        });

        const answer = await deps.judge({
          rubric,
          input: observation.input,
          output: observation.output,
          modelConfig,
        });

        let value: string | number;
        let dataType: "CATEGORICAL" | "NUMERIC";
        let newDisplay: string;
        if (rubric.kind === "choice") {
          const choice = answer.choice;
          if (!choice || !(rubric.options ?? []).includes(choice)) {
            throw new Error(
              `Backstop judge returned "${choice}", which is not an option of "${rubric.scoreName}"`,
            );
          }
          value = choice;
          dataType = "CATEGORICAL";
          newDisplay = choice;
        } else {
          const num = answer.score;
          if (typeof num !== "number" || !Number.isFinite(num)) {
            throw new Error(
              `Backstop judge returned a non-numeric score for "${rubric.scoreName}"`,
            );
          }
          value = num;
          dataType = "NUMERIC";
          newDisplay = String(num);
        }

        const original = originalScoreValue(score);
        const metadata: Record<string, unknown> = {
          ...((score.metadata as Record<string, unknown>) ?? {}),
          rescued_from_jev: {
            original_value: original,
            original_confidence: confidence,
            model: config.model,
            rescued_at: deps.now().toISOString(),
            threshold: config.confidenceThreshold,
          },
        };
        const comment = `Rescued (JEV confidence ${confidence} < ${config.confidenceThreshold}); was ${original}. ${answer.reasoning}`;

        if (config.dryRun) {
          logger.info(
            `[eval-backstop][DRY RUN] would rescue ${score.id} ${original} -> ${newDisplay} (conf ${confidence} < threshold ${config.confidenceThreshold})`,
          );
          result.rescued++;
          continue;
        }

        const eventId = randomUUID();
        const event = {
          id: eventId,
          timestamp: deps.now().toISOString(),
          type: eventTypes.SCORE_CREATE,
          body: {
            // Same id as the original score => upsert in place.
            id: score.id,
            traceId: score.traceId,
            observationId: score.observationId,
            name: score.name,
            comment,
            metadata,
            source: ScoreSourceEnum.EVAL,
            environment: score.environment,
            value,
            dataType,
          },
        } as unknown as ScoreEventType;

        await deps.uploadScore({
          projectId,
          scoreId: score.id,
          eventId,
          event,
        });
        await deps.enqueueScoreIngestion({
          projectId,
          scoreId: score.id,
          eventId,
        });

        logger.info(
          `[eval-backstop] Rescued ${score.id} ${original} -> ${newDisplay} (conf ${confidence} < threshold ${config.confidenceThreshold})`,
        );
        result.rescued++;
      } catch (e) {
        result.errors++;
        logger.error(
          `[eval-backstop] Failed to rescue score ${score.id} in project ${projectId}`,
          e,
        );
        traceException(e);
        continue;
      }
    }
  }

  logger.info(
    `[eval-backstop] Run complete: scanned=${result.scanned} candidates=${result.candidates} rescued=${result.rescued} skipped=${result.skipped} errors=${result.errors}${config.dryRun ? " (dry run)" : ""}`,
  );
  return result;
}
