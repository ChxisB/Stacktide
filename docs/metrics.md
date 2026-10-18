# Metrics

`GET /metrics` serves Prometheus text (format 0.0.4) from the **API process**. It is off until you set a token:

```
ORCH_METRICS_TOKEN=$(openssl rand -hex 32)      # at least 32 characters
```

Without it the route answers 404. With it, the only way in is `Authorization: Bearer <token>`: a session, an API token or
the dev principal does not open it, and a wrong or missing token answers 401. Compare the token in a secret store, not in
`prometheus.yml`:

```yaml
scrape_configs:
  - job_name: orch
    authorization: { credentials_file: /etc/prometheus/orch-token }
    static_configs: [{ targets: ["orch.example.com"] }]
```

Do not publish `/metrics` on the open internet: put it behind the same network boundary as the database, or let the proxy
refuse it from outside. The token is the only protection the route has.

## What it reports

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `orch_http_requests_total` | counter | `method`, `route`, `status` | requests handled by this process. Errors are the 4xx and 5xx statuses |
| `orch_http_request_duration_seconds` | histogram | `method`, `route` | time from receiving to answering |
| `orch_jobs` | gauge | `queue`, `status` | jobs per queue and state (`queued`, `running`, `done`, `dead`) |
| `orch_job_oldest_age_seconds` | gauge | `queue`, `status` | how long the oldest **due** queued job has waited, or the oldest running job has run |
| `orch_sync_runs` | gauge | `status` | sync runs per state |
| `orch_sync_run_oldest_age_seconds` | gauge | `status` | how long the longest apply has been `applying` |
| `orch_stack_runs` | gauge | `status` | IaC stacks of runs per state |
| `orch_stack_run_oldest_age_seconds` | gauge | `status` | how long the longest `queued`, `planning` or `applying` stack has been so |
| `orch_gitlab_ratelimit_remaining` | gauge | `host` | what the instance last said was left in the window (`RateLimit-Remaining`) |
| `orch_gitlab_ratelimit_limit` | gauge | `host` | the window's size (`RateLimit-Limit`), when the instance sends it |
| `orch_metrics_series_dropped_total` | counter | | label sets refused because a metric was full (should stay 0) |

Alert on a growing `orch_job_oldest_age_seconds` (the worker is down or behind), on `orch_jobs{status="dead"}`,
on `orch_sync_run_oldest_age_seconds` or `orch_stack_run_oldest_age_seconds` past what an apply should take, on
`orch_gitlab_ratelimit_remaining` near 0, and on 5xx in `orch_http_requests_total`.

## What it never reports

The `route` label is the route **as registered** (`/organizations/:orgId/projects/:projectId`), never the path that was
asked for, and a request no route matched is `unmatched`. A method outside GET, POST, PUT, PATCH, DELETE, HEAD and OPTIONS
is `other`. The queue, state and status labels are names the code defines; the host is the GitLab instance's. No label
holds an id, a variable key, a value or a payload, and a metric that would grow past 500 label sets drops the new ones and
counts them in `orch_metrics_series_dropped_total` rather than grow.

## Limits

- **Per process.** Request figures are those of the API process that answered the scrape (run one scrape target per
  replica). The worker has no `/metrics`: its work is seen through the queue and run figures, which are read from the
  database, and the GitLab rate limit shown is the one the **API** saw (the worker's calls are not in it).
- **The GitLab rate limit is the last answer seen per host**, not per token: two organizations on one instance with
  different tokens overwrite each other's figure. At most 20 hosts are kept, the first ones seen; later hosts are not shown
  and nothing counts them.
- Queue, state and host gauges are cut at 500 rows without counting what was cut (queue and state names are a fixed small
  set, so this is not expected to happen). Scrapes of `/metrics` are themselves counted in the request figures
  (a wrong token is a 401 on `route="/metrics"`).
- **No durations of runs.** The run tables keep no start time, so how long a sync or an IaC run took is not reported, only
  how long one has been stuck in a state. Add a start time to the tables to get a histogram.
- The queue and run figures are counted from the tables when a scrape asks and reused for 5 seconds. Counts of `done`
  jobs and of finished runs shrink when rows are deleted (a deleted project's runs go with it): use them as gauges, not
  counters.
