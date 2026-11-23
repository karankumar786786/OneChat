# AWS infrastructure (Terraform)

Creates what the chat engine needs in AWS:

- **One S3 bucket**, `chat-<env>-<random>`:
  - private: public access blocked, ACLs off;
  - encrypted (SSE-S3) and HTTPS-only;
  - versioning off on purpose: forwarding restarts a file's clock by copying it onto itself.
- **Auto-delete (lifecycle) rules**:
  - `chat/` after 30 days (`chat_file_ttl_days`);
  - `status/` after 1 day;
  - `avatar/` is kept.
- **An IAM user for the engine**, `chat-engine-<env>`, with an access key. It can only read, write and delete objects in that bucket.

## Use

Uses your AWS CLI credentials and the `ap-south-1` region by default.

```bash
cd infra/terraform
terraform init
terraform plan
terraform apply
./write-engine-env.sh      # puts bucket + key into engine/.env without printing the secret
```

Then restart the engine.

- **Another environment:** `terraform workspace new prod && terraform apply -var environment=prod`. Use a separate engine `.env` for prod.
- **Tear down (dev):** `terraform destroy -var force_destroy=true` deletes the bucket and its files.

## Notes

- **State contains the engine's secret key.** It's local and git-ignored. Before sharing this setup with a team, move state to a remote backend (an S3 bucket with locking).
- **Lifecycle rules are owned here.** `bun run s3:lifecycle` in the engine is only for buckets made without Terraform; the engine's IAM user isn't allowed to change lifecycle rules.
- **Keep the TTL in sync:** if you change `chat_file_ttl_days`, set the same `FILE_TTL_DAYS` in `engine/.env`.
