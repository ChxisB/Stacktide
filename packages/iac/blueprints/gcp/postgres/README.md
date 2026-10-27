# postgres, GCP

A Cloud SQL for PostgreSQL instance with a private address only, its connection URL in Secret Manager.

- **Creates:** `google_sql_database_instance` (name `<environment>-<name>-postgres-<random>`), a database and a user both called `app`, a generated 32-character password, and the secret `<environment>-<name>-database-url` holding `postgres://app:…@<private ip>:5432/app?sslmode=require`. Enables the `sqladmin` and `secretmanager` APIs and leaves them on when destroyed.
- **Safe by default:** no public address (`ipv4_enabled = false`), TLS required, daily backups with point-in-time recovery, and **deletion protection in both places** Cloud SQL has it. To remove the database, turn both off in a reviewed change first (a destroy of this stack fails otherwise, on purpose). Disk autoresize is on and a disk never shrinks.
- **Needs the network first:** the `network` stack of this environment must be applied (stack `depends_on`): the instance takes its private address from the private service access that module reserves.
- **The password** is generated here and is in this stack's Terraform state, in clear text, because Terraform 1.5 cannot keep it out. The platform's own state is sealed (ADR-0017); a state kept anywhere else is not. It is in no output and in no log.
- **A new instance name every time:** Cloud SQL holds an instance's name for a week after deletion. The random suffix is chosen once and kept in the state, so tearing down and re-creating an environment works.
- **Needs from the runner's identity:** `roles/cloudsql.admin`, `roles/secretmanager.admin`, `roles/compute.networkUser` and `roles/serviceusage.serviceUsageAdmin`.
- **Idle cost:** the instance bills by the hour all the time, scaled to nothing never (`db-f1-micro` is the cheapest at a few USD a month; `medium` and `large` are tens to hundreds). Storage and backups bill on top.
- **Outputs:** `instance_name`, `secret_id`, `console_url`.
