/**
 * Applies the bucket lifecycle rules that make S3 delete files on its own:
 *   chat/    expires FILE_TTL_DAYS (30) days after the object was created
 *   status/  expires 1 day after creation (the API already hides statuses after 24h)
 *   avatar/  never expires
 * Forwarding a chat file copies the object onto itself, which resets its creation
 * time and therefore its 30-day clock.
 *
 * Run once per bucket: bun run s3:lifecycle
 */
import { PutBucketLifecycleConfigurationCommand, GetBucketLifecycleConfigurationCommand } from "@aws-sdk/client-s3";
import { s3 } from "../src/lib/s3.ts";
import { env } from "../src/config/env.ts";

if (!env.S3_BUCKET) {
  console.error("S3_BUCKET is not set");
  process.exit(1);
}

await s3.send(
  new PutBucketLifecycleConfigurationCommand({
    Bucket: env.S3_BUCKET,
    LifecycleConfiguration: {
      Rules: [
        {
          ID: "expire-chat-files",
          Status: "Enabled",
          Filter: { Prefix: "chat/" },
          Expiration: { Days: env.FILE_TTL_DAYS },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        },
        {
          ID: "expire-status-media",
          Status: "Enabled",
          Filter: { Prefix: "status/" },
          Expiration: { Days: 1 },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        },
      ],
    },
  }),
);

const current = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: env.S3_BUCKET }));
console.log(`Lifecycle rules on ${env.S3_BUCKET}:`);
for (const r of current.Rules ?? []) console.log(`  ${r.ID}: ${r.Filter?.Prefix} → ${r.Expiration?.Days} day(s)`);
process.exit(0);
