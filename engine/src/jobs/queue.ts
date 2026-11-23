import { Queue, Worker } from "bullmq";
import { bullConnection } from "../lib/redis.ts";
import { logger } from "../lib/logger.ts";
import { cleanupExpiredStatuses } from "../modules/statuses/service.ts";
import { cleanupExpiredFiles } from "../modules/files/service.ts";
import { cleanupStalePending } from "../realtime/inbox.ts";
import { sendPush, type PushJob } from "./sendPush.ts";

let maintenance: Queue | null = null;
let push: Queue<PushJob> | null = null;
const workers: Worker[] = [];

function maintenanceQueue() {
  maintenance ??= new Queue("maintenance", { connection: bullConnection });
  return maintenance;
}

export function pushQueue() {
  push ??= new Queue<PushJob>("push", {
    connection: bullConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  });
  return push;
}

const PUSH_DELAY_MS = 3000;
const PUSH_COALESCE_MS = 15_000;

/** At most one push per chat (sender or group) → recipient every 15 seconds. */
export async function queuePush(job: PushJob) {
  const bucket = Math.floor(Date.now() / PUSH_COALESCE_MS);
  await pushQueue().add("push", job, {
    jobId: `push-${job.recipientId}-${job.groupId ?? job.senderId}-${bucket}`,
    delay: PUSH_DELAY_MS,
  });
}

export async function scheduleMaintenance() {
  const q = maintenanceQueue();
  await q.upsertJobScheduler("cleanup-statuses", { every: 10 * 60_000 }, { name: "cleanup-statuses" });
  await q.upsertJobScheduler("cleanup-files", { every: 60 * 60_000 }, { name: "cleanup-files" });
  await q.upsertJobScheduler("cleanup-pending", { every: 24 * 60 * 60_000 }, { name: "cleanup-pending" });
}

export async function runMaintenanceJob(name: string) {
  switch (name) {
    case "cleanup-statuses":
      return { removed: await cleanupExpiredStatuses() };
    case "cleanup-files":
      return { removed: await cleanupExpiredFiles() };
    case "cleanup-pending":
      return { removed: await cleanupStalePending() };
    default:
      throw new Error(`Unknown maintenance job ${name}`);
  }
}

export function startWorkers() {
  const m = new Worker("maintenance", async (job) => runMaintenanceJob(job.name), { connection: bullConnection });
  const p = new Worker<PushJob>("push", async (job) => sendPush(job.data), { connection: bullConnection, concurrency: 20 });
  for (const w of [m, p]) {
    w.on("failed", (job, err) => logger.error({ err, job: job?.name, id: job?.id }, "job failed"));
    workers.push(w);
  }
}

export async function closeJobs() {
  await Promise.allSettled([...workers.map((w) => w.close()), maintenance?.close(), push?.close()]);
  workers.length = 0;
  maintenance = null;
  push = null;
}
