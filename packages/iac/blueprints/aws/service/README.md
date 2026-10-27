# service, AWS

An ECS Fargate service behind an HTTPS-only application load balancer, with its own image repository and log group.

- **Creates:** `aws_ecs_cluster`, `aws_ecs_task_definition`, `aws_ecs_service`, `aws_lb` with one HTTPS listener and its target group, `aws_ecr_repository`, `aws_cloudwatch_log_group`, two security groups, an execution role and a task role. Until `image` is set it runs a placeholder web server on port 80.
- **Safe by default:** the load balancer is **internal** unless `public` is on, and `public` is the only thing that opens port 443 to the internet. There is no listener on port 80, not even a redirect. Tasks sit in the private subnets with no public address, take traffic from the load balancer only, and send out HTTPS and the database port inside the VPC (other outbound ports are closed). Images are scanned on push and tags are immutable.
- **Roles:** the execution role pulls from this service's repository, writes this service's log group and reads the secrets of the databases in `databases`, each by name (`<environment>-<database>-database-url`). The one `"*"` resource in them is `ecr:GetAuthorizationToken`, which AWS does not let be narrower. The task role (the application's own) reads and writes objects in the buckets in `buckets` and nothing else. No managed policy is attached.
- **Environment:** each database's URL is injected as `DATABASE_URL` (one database) or `DATABASE_URL_<NAME>` (several), from Secrets Manager, never as a value in the task definition. Each bucket's name is set as `BUCKET_<NAME>`.
- **Needs the network first**, and each database and bucket it names: stacks `depends_on` them. The VPC and subnets are found by the tags the network module sets.
- **HTTPS needs a certificate** (`certificate_arn`, an ACM certificate in the region). The `url` output is the load balancer's own address, which the certificate will not match: point a name it covers at it.
- **Health check:** `GET /` on the container port; any answer below 500 counts as healthy. A deploy that never becomes healthy rolls back by itself.
- **The image** is set by this stack only until the first deploy: the service ignores later changes to its task definition, so a deploy (feature 36, `deploy-ecs.sh`) is not undone by the next apply. Changing `image` here afterwards does not redeploy.
- **Needs from the runner's role:** `ecs:*` and `elasticloadbalancing:*` on what it creates, `ecr:*` and `logs:*` on this service's repository and log group, `iam:CreateRole`, `PutRolePolicy`, `PassRole` (on the two roles) and their delete counterparts, the EC2 security group actions and `ec2:Describe*`, `sts:GetCallerIdentity`.
- **Idle cost:** the load balancer (about 17 USD a month in us-east-1) and the tasks (`small`: one 0.25 vCPU task, about 9 USD a month) bill all the time. Fargate does not scale to zero here.
- **Outputs:** `url`, `console_url`, `repository`, `task_role`.
