import { Queue } from "bullmq";
import { QueueName, QueueJobs } from "../queues";
import { createBullMQQueueOptionsWithRedis } from "./redis";
import { scheduleRecurringJob } from "./scheduleRecurringJob";
import { logger } from "../logger";
import { env } from "../../env";

export class LowConfidenceEvalBackstopQueue {
  private static instance: Queue | null = null;

  public static getInstance(): Queue | null {
    if (env.LANGFUSE_EVAL_BACKSTOP_ENABLED !== "true") {
      return null;
    }

    if (LowConfidenceEvalBackstopQueue.instance) {
      return LowConfidenceEvalBackstopQueue.instance;
    }

    const queueOptionsWithRedis = createBullMQQueueOptionsWithRedis(
      QueueName.LowConfidenceEvalBackstopQueue,
    );
    LowConfidenceEvalBackstopQueue.instance = queueOptionsWithRedis
      ? new Queue(QueueName.LowConfidenceEvalBackstopQueue, {
          ...queueOptionsWithRedis,
          defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: 100,
            attempts: 3,
            backoff: {
              type: "exponential",
              delay: 5000,
            },
          },
        })
      : null;

    LowConfidenceEvalBackstopQueue.instance?.on("error", (err) => {
      logger.error("LowConfidenceEvalBackstopQueue error", err);
    });

    if (LowConfidenceEvalBackstopQueue.instance) {
      logger.debug("Scheduling jobs for LowConfidenceEvalBackstopQueue");
      scheduleRecurringJob(LowConfidenceEvalBackstopQueue.instance, {
        jobName: QueueJobs.LowConfidenceEvalBackstopJob,
        pattern: env.LANGFUSE_EVAL_BACKSTOP_CRON,
      });
    }

    return LowConfidenceEvalBackstopQueue.instance;
  }
}
