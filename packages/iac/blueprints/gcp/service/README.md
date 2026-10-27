# service, GCP

A Cloud Run v2 service, an Artifact Registry repository for its images, and a service account that runs it.

- **Creates:** `google_cloud_run_v2_service`, `google_artifact_registry_repository`, `google_service_account`, one `google_secret_manager_secret_iam_member` per database and one `google_storage_bucket_iam_member` per bucket it uses, and (only when `public` is on) one `roles/run.invoker` binding. Enables the `run`, `artifactregistry` and `secretmanager` APIs and leaves them on when destroyed.
- **Safe by default:** `ingress` is internal only and nobody is allowed to invoke it from the internet unless `public: true`. The service account holds no role of its own: only `secretmanager.secretAccessor` on the connection secrets named in `uses`, and `storage.objectUser` on the buckets named in `uses`.
- **Wiring is by name.** A database `main` in this environment is the secret `<environment>-main-database-url`, mounted as `DATABASE_URL` (one database) or `DATABASE_URL_<NAME>`; a bucket `files` becomes the environment variable `BUCKET_FILES`. A network `main` is the network and subnet `<environment>-main-network` in the same region. The postgres, bucket and network stacks apply first (`depends_on`).
- **Image:** empty runs Google's hello image on port 8080 so the first apply has something to start. Terraform ignores the image after that, so a later apply never puts the hello image back; deploys set it. To change it from Terraform, replace the service.
- **Needs from the runner's identity:** `roles/run.admin`, `roles/artifactregistry.admin`, `roles/iam.serviceAccountAdmin`, `roles/iam.serviceAccountUser` on the new account, `roles/secretmanager.admin` and `roles/storage.admin` on what it grants, `roles/serviceusage.serviceUsageAdmin`.
- **Org policy:** `public: true` fails where the organisation blocks `allUsers` (domain restricted sharing).
- **Idle cost:** none at `min_instances = 0` (the `small` profile). `medium` and `large` keep instances running, which bill all the time. The image repository bills for the storage the images use.
- **Outputs:** `url`, `console_url`, `repository`, `service_account`.
