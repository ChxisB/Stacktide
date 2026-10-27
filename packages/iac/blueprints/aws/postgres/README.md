# postgres, AWS

An RDS for PostgreSQL instance in the network's private subnets, its connection URL in Secrets Manager.

- **Creates:** `aws_db_instance` (identifier `<environment>-<name>-postgres`), its subnet group, parameter group and security group, a database and a user both called `app`, a generated 32-character password, and the secret `<environment>-<name>-database-url` holding `postgres://app:…@<endpoint>:5432/app?sslmode=require`. The secret has no recovery window, so deleting the stack frees its name at once.
- **Safe by default:** not publicly accessible; storage encrypted; TLS required (`rds.force_ssl`); seven days of backups; a final snapshot on delete; **deletion protection on**. To remove the database, turn it off in a reviewed change first (a destroy of this stack fails otherwise, on purpose). The only rule on its security group lets the VPC in on port 5432; it has no egress rule.
- **Needs the network first:** the `network` stack of this environment must be applied (stack `depends_on`): the VPC and its private subnets are found by the tags that module sets.
- **The password** is generated here and is in this stack's Terraform state, in clear text, because Terraform 1.5 cannot keep it out. The platform's own state is sealed (ADR-0017); a state kept anywhere else is not. It is in no output and in no log.
- **Version:** only the major version is set, so RDS picks the current minor and applies later minor upgrades itself.
- **Needs from the runner's role:** `rds:*` on instances, subnet groups, parameter groups and snapshots it creates, the EC2 security group and describe actions, `secretsmanager:CreateSecret`, `PutSecretValue`, `DeleteSecret`, `DescribeSecret`, `GetResourcePolicy` and `TagResource`.
- **Idle cost:** the instance bills by the hour all the time (`db.t4g.micro` is about 12 USD a month in us-east-1; `medium` and `large` are tens to hundreds). Storage, backups and the secret (about 0.40 USD a month) bill on top.
- **Outputs:** `instance_name`, `secret_id`, `console_url`.
