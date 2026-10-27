# bucket, GCP

A Cloud Storage bucket that cannot be made public.

- **Creates:** one `google_storage_bucket` named `<environment>-<name>-<8 characters of the project id's hash>`. The hash keeps the name the same for every stack in the project, which is how a service in the environment finds it.
- **Safe by default:** uniform bucket-level access and public access prevention **enforced**: no object can be made public, by an ACL or by a role such as `allUsers`. Objects are encrypted with Google-managed keys. Versioning is off unless asked for.
- **Not deleted while it holds objects** (`force_destroy = false`): a teardown of an environment fails on a bucket with data in it until someone empties it.
- **Needs from the runner's identity:** `roles/storage.admin` on the project.
- **Idle cost:** storage bills for what is in it; an empty bucket costs nothing.
- **Outputs:** `bucket_name`, `console_url`.
