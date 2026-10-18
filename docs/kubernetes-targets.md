# Kubernetes targets

A sync target of type `kubernetes-secret` writes a project's variables into **one Kubernetes Secret**. It is
reached through a `kubernetes` connection (see [ADR-0013](adr/0013-target-credentials.md)): the API server's
address, the namespaces the platform may write to, and a service-account token that is stored sealed like every
other connection secret.

## The connection

```json
{ "type": "kubernetes", "name": "prod-cluster", "config": { "server": "https://k8s.example.com:6443", "namespaces": ["apps", "staging"], "ca": "-----BEGIN CERTIFICATE-----…" }, "token": "<service-account token>" }
```

- `server` is an https origin: no path, no credentials. A cluster that is only reachable through a proxy path
  (Rancher's `/k8s/clusters/…`) is not supported.
- `namespaces` (1–20) is the **allowlist**. A target in any other namespace is refused when it is planned,
  applied or checked for drift, whatever the token could do. It is not checked when the target is created, so
  a typo shows up at the first plan.
- `ca` is an optional PEM certificate that signs the server's certificate (a private CA).
- The connection test asks the API server (a `SelfSubjectAccessReview`, which changes nothing) whether the
  token may `get`, `create` and `patch` Secrets in each namespace. Those are the only verbs the platform uses: it
  never lists, replaces or deletes a Secret.

## The target

```json
{ "type": "kubernetes-secret", "connectionId": "…", "config": { "namespace": "apps", "name": "app-env", "protected": true } }
```

- The Secret is `<namespace>/<name>`, type `Opaque`; a variable `KEY` is the key `KEY` of its `data`.
- A Secret has **no scopes**: a variable of an environment cannot go in it, and a plan that has one is refused
  with the key named. Make one target (and one Secret) per environment, in that environment's namespace, and
  map no environments on it.
- The key is 1–253 letters, digits, `-`, `_` or `.` (not `.` or `..`). A name and a namespace are lowercase
  letters, digits and `-`, up to 63 characters (stricter than Kubernetes, which lets a Secret's name run longer
  with dots).
- Values are text. A Secret holds 512 KiB at most through this platform (Kubernetes allows 1 MiB); a plan
  that would pass it is refused with the key named and nothing is written. File variables are not supported.
- `protected: true` is the owner's declaration that RBAC guards the Secret, which the production guardrail
  ([guardrails](guardrails.md)) wants before a production variable is synced.

## What the platform will touch

Only a Secret it made. It carries the label `orch-managed=<name>`.

- A Secret that exists without the label (made by hand, by Helm, by another tool) is never listed, written or
  emptied. A create fails with `exists` and a message that says what to add; add the label to hand it over.
- Inside its own Secret the platform only writes the keys of the variables it syncs. A key someone else added
  stays, and is listed as a secret; the target's unmanaged policy decides whether a plan ever prunes it.
- A delete removes the key and leaves the Secret, empty, since pods may mount it.
- Every Secret is a secret to Kubernetes, so "not a secret" is kept as a list of keys in the annotation
  `orch-plain` (JSON). An annotation that is not a JSON list of names counts as an empty list: everything reads
  as a secret.
- Every write is a JSON merge patch carrying the `resourceVersion` the platform read. If someone changed the
  Secret in between, the API server refuses it (409) and the line fails with "the Secret changed while it
  was being written"; the next apply retries it.

## The token's permissions

A `Role` and `RoleBinding` in each allowed namespace, for the service account of the connection:

```yaml
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "create", "patch"]
```

`patch` is the verb a merge patch needs, and it is what changes and removes a key. `create` cannot be limited
by name; `get` and `patch` can, with `resourceNames`, once the Secret exists. The platform never asks for a
cluster-wide role; one is not noticed by the connection test.

## Restarting workloads

Pods do not see a changed Secret in an environment variable until they restart (a mounted file is updated by
the kubelet after a delay). **This platform does not restart anything.** Use a controller that watches the
Secret, such as [Stakater Reloader](https://github.com/stakater/Reloader), annotated on the Deployment.

## Known limits

- Not verified against a real cluster: the adapter is tested against a contract-level fake written from
  Kubernetes' documentation (`packages/sync/src/fake-kube.ts`).
- One `GET` per write. A target with thousands of keys wants a batch; this one is for the few dozen variables
  of an application.
- Text only: a key whose bytes are not UTF-8 is not listed and is never replaced.
- The label is a convention, not a lock: anyone who may patch the Secret can add or remove it.
- A private CA is passed to Bun's `fetch` (`tls: { ca }`), which has not been tried against a real private CA.
- The server's address is checked for the literal loopback only; a DNS name that resolves to a private
  address is not refused (see the SSRF follow-up in the GL-6 log).
