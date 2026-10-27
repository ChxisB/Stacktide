# bucket, AWS

An S3 bucket that cannot be made public.

- **Creates:** `aws_s3_bucket` named `<environment>-<name>-<account id>`, its public access block and its default encryption, and `aws_s3_bucket_versioning` only when `versioning` is on. The account id keeps the name the same for every stack in the account, which is how a service in the environment finds it.
- **Safe by default:** all four public access blocks are on, so no ACL and no bucket policy can make the bucket or an object public. Objects are encrypted with S3-managed keys (SSE-S3). Versioning is off unless asked for; turning it off again suspends it and keeps the versions already stored.
- **Not deleted while it holds objects** (`force_destroy = false`): a teardown of an environment fails on a bucket with data in it until someone empties it.
- **Needs from the runner's role:** `s3:CreateBucket`, `DeleteBucket`, `Get*`/`Put*` on bucket configuration (policy, public access block, encryption, versioning, tagging) and `sts:GetCallerIdentity`.
- **Idle cost:** storage bills for what is in it; an empty bucket costs nothing.
- **Outputs:** `bucket_name`, `console_url`.
