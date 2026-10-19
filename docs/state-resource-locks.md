# Note: resource-level locks and scoped plans for platform-hosted state (STATE-9)

**Recommendation: drop.** Do not build resource-level locks or scoped plans. The lock and the unit of work stay the whole
stack, as in [ADR-0017](adr/0017-sql-state.md). This is a spike: nothing here was built, and nothing was run against a
real Terraform or OpenTofu client. The protocol facts are from Terraform's documentation and source as I know them, so
check them against the version you run before you reopen the question.

## The question

Stategraph-style state keeps resources as rows and lets two runs that touch different resources go at the same time.
Can the platform's state backend (Terraform's `http` backend, STATE-3 and STATE-4) do anything finer than "one lock per
stack, one document per stack"? And if not, what would it take?

## What the HTTP backend protocol can carry

| Part of the protocol | What it carries | Finer than a stack? |
|---|---|---|
| `GET` / `POST` on the state address | the whole state document; a write replaces it, at a higher `serial`, under one `lineage` | No. There is no "change these resources" request |
| `LOCK` / `UNLOCK` | a `LockInfo`: `ID`, `Operation` (`plan`, `apply`, ...), `Who`, `Version`, `Created`, `Path`, `Info` | No. It names no resources, because Terraform does not know which resources an operation touches until it has read the state and the configuration, which is after it holds the lock |
| Workspaces | to my knowledge the `http` backend does not support them | One state per address, so the stack is the only unit the protocol offers |

The server could keep a finer lock table, but it has nothing to key it by: the client never says which resources it
will touch. A lock that the client takes first and narrows later is not something `statemgr` (Terraform's state
interface) can do, and the backend interface is compiled into the Terraform and OpenTofu binaries, so the platform
cannot plug a different one in.

## What a finer lock would need

Any of these, and each is a project of its own:

1. **A server that merges states.** Two runs on disjoint resources each write a whole document that lacks the other's
   changes. The server would have to merge them by resource address and then settle `outputs`, `serial`, `check_results`
   and dependencies. A wrong merge corrupts the one thing the platform must not lose, and Terraform's local copy of the
   state would no longer be what the server holds.
2. **A wrapper around `terraform`** that plans first, reads the resource addresses out of the plan, takes the platform's
   resource locks for exactly those, and only then applies (with `-target`). It adds a service the job calls, a lock
   protocol of our own, and handling for a job that dies holding locks. A plan that was made before a neighbour's apply
   finished is out of date for the resources it shares with it.
3. **A fork** of Terraform or OpenTofu with a different state manager. A permanent maintenance cost to track upstream.

## Scoped plans

`-target` is a client flag, and the platform could put it in a generated job. It is not worth it:

- Terraform documents `-target` as for exceptional situations. A partial apply leaves the configuration and the state
  disagreeing, and the next full plan has to put that right.
- The plan summary, cost gate, policy and drift detection of this platform all assume a plan of the whole stack. A
  scoped plan would pass them while saying nothing about the rest.
- The resource index (STATE-6) already lists the addresses a person would pick from, so the only new part would be the
  risk.

## What to do instead

- **Split the stack.** The platform's unit of locking, planning, ordering (`dependsOn`) and permissions is the stack.
  Two teams that keep tripping over one lock have two stacks in one directory: move the resources into two stacks and
  carry the resources over in a job with `import` blocks or `terraform state mv -state-out`. The platform cannot do
  it for you: it never hands state to a person and does not edit it (ADR-0017).
- **Wait for the lock.** A job that finds the lock held gets a `423` and Terraform retries for as long as
  `-lock-timeout` says. Set it in the job. Jobs retry until the lock frees, in no fair order: it is waiting, not a queue.
- **See what is locked.** An organization admin can force-unlock a stack whose job has died (`docs/ci.md`), and a lock
  ends with its job's token in any case.

## When to reopen this

If stacks have to stay large because splitting them breaks something real (a shared module that cannot be divided, say)
and OpenTofu or Terraform ships a backend that can lock by address. Then the table to key a lock by is
`state_resources`, which STATE-6 already fills.
