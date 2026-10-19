# ADR-0015: Worker pools are runner tags, not a platform agent
Status: Accepted (the recommended decision, taken on your instruction to make them; amend or reverse it here) · Roadmap: POOL-7

## Context
Worker pools (POOL-1 to POOL-6) let a stack's plan, estimate, summary and apply jobs ask for the organization's own GitLab runners by **tag**. Roadmap decision D1 says GitLab CI is the runner and the platform is the control plane; invariant 3 says the control plane holds no cloud credentials, the runner does. Some platforms (the task cites Spacelift's pools) instead ship a **worker agent**: a process in the customer's network that polls the platform over outbound HTTPS, authenticates with a token and a certificate, takes one run at a time, and runs the tool there. The question is whether to build that as well, or instead.

## Options
| | (a) Runner tags (built) | (b) A platform-shipped pull-based agent |
|---|---|---|
| Who runs the job | a GitLab runner the customer registers | the platform's own agent |
| Who queues and dispatches | GitLab | the platform: a run queue per pool, leases, retries |
| Network | the runner already talks to GitLab | outbound HTTPS from the agent to the platform |
| Where cloud credentials are | on the runner, through OIDC, as before | on the agent's host; the platform never sees them |
| Where the stack's variables and secrets go | GitLab hands them to the job; the platform serves them to the job's own principal | the platform would have to **send** them to the agent: a new delivery path for decrypted values |
| Isolation | none beyond what GitLab gives: tags route, they do not isolate | one run per worker, so a stronger boundary, if the agent is built to give it |
| What is new to build and secure | nothing beyond the tag plumbing | an agent protocol, agent identity and rotation, log and artifact streaming, an upgrade path, a binary per platform, a second execution model next to GitLab CI |

## Decision
1. **Runner tags only.** The platform ships no agent. A pool is a name for tags (and an image), and GitLab decides which runner takes a job.
2. **D1 and invariant 3 stay as they are.** Nothing here changes either, which is the main reason for the decision.
3. **The limit is named, not hidden.** Tags are routing, not isolation: anyone who can register a runner with a pool's tags in GitLab receives those jobs and the credentials they are given. The boundary to protect is who may register runners in GitLab. This is said in the settings page, in `orch pool add` and in [worker pools](../worker-pools.md).

## What (b) would change, if it is ever chosen
- **D1.** GitLab CI would no longer be the only runner: the platform would own a run queue and a second execution path, with its own failure modes (an agent that vanishes mid-apply, a plan artifact the apply must find). The "no runner fleet to build" argument for D1 would no longer hold for the organizations that use it.
- **Invariant 3.** It could stay whole (the agent holds the credentials), but only if the agent never receives them from the platform. It would still receive the stack's **variables and secrets**, so the platform's "values are served only to the job's own principal" rule would become "values are sent to an agent", which needs its own ADR, sealing in transit beyond TLS, and a review of what an agent compromise yields.
- **Identity.** An agent needs a credential of its own (the task describes a token and a certificate), a way to revoke one agent, and an audit trail of which agent ran what. None of that exists.
- **Plans and applies.** The plan-then-apply guarantee (an apply uses the plan that was approved) rides today on GitLab's job artifacts. An agent would need its own artifact store or must keep using GitLab's.
- It would be planned as a **new feature**, with its own SPEC, a `/security-review` of the protocol, and a human gate on every item above.

## When to revisit
Choose (b) if customers need isolation tags cannot give (a run that cannot see another run's credentials on a shared host), or cannot run GitLab runners at all but can run an outbound-only process. Neither has been asked for. Until then (a) covers the stated need, which is running a stack's jobs on the organization's own runners.

## Consequences
- No new code, dependency, port or credential from this decision.
- An organization that needs one-run-per-worker isolation gets it from how it runs its GitLab runners (an ephemeral executor, a runner per run), and not from the platform.
- Not covered: any agent protocol, per-agent identity, runner registration by the platform (it never registers runners; that stays a GitLab action), and a check that a registered runner is isolated.
