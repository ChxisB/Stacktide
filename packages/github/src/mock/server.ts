import sodium from "libsodium-wrappers";
import { parse } from "yaml";
import { API_VERSION } from "../client";
import { MockGit, treeEntries } from "./git";

/**
 * An in-process GitHub for tests (invariant 7: tests never touch the real one). It speaks the REST API under
 * `/api/v3`, the path of a GitHub Enterprise Server, which is where `createGithubClient` looks for any host
 * that is not github.com. Later tasks add their routes here; the checks below are the ones every route shares and
 * are stricter than GitHub on purpose: a request without a token, the API-version header or a user agent fails.
 */

export interface MockRequest {
  method: string;
  /** Path below `/api/v3`, query string excluded. */
  path: string;
  query: URLSearchParams;
  /** The request headers except `authorization`: a log must never hold a token. */
  headers: Record<string, string>;
  authorized: boolean;
  body: unknown;
}

/** Answers the next `times` matching requests with `status` before auth and routing, as a flaky or limiting GitHub would. */
export interface Injection {
  method: string;
  path: string;
  status: number;
  times: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface MockGithubOptions {
  /** The one token accepted. Default: any token of 8 or more characters. */
  token?: string;
  /** Page size cap, so a test paginates with a handful of items. */
  maxPerPage?: number;
  /**
   * Repository routes (below `/repos/:owner/:repo`, such as `/hooks`) the token may not use: they answer 403 as a
   * fine-grained token without that permission does. An organization's Actions routes are named in full
   * (`/orgs/acme/actions/secrets`).
   */
  denied?: string[];
  /** A dispatched run is left out of the workflow's run list for this many reads, as GitHub is slow to show one. Default: 0. */
  runAppearsAfter?: number;
  /** Every dispatch starts two runs of the same name, as when someone else dispatches the same thing at the same time. */
  alsoDispatches?: boolean;
  /** The OAuth app that signs people in (FRG-25): `/login/oauth/access_token` answers 404 without one. */
  oauth?: { clientId: string; clientSecret: string };
}

export interface MockRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  archived: boolean;
  visibility: string;
}

/** What a repository starts with: one commit on its default branch holding these files. */
export interface RepoSeed {
  files?: Record<string, string>;
}

/** What a test says about a workflow run; the rest is filled in the way GitHub would. */
export interface RunSeed {
  /** `null` is a run of a tag. Default: `main`. */
  branch?: string | null;
  /** Default: the head of the branch. */
  sha?: string;
  /** GitHub's `status`: queued (the default), in_progress, completed, waiting, requested, pending. */
  status?: string;
  /** GitHub's `conclusion`, set once the run is completed. */
  conclusion?: string | null;
  /** Default: one job called `build`. A job takes the run's status and conclusion unless it says its own. */
  jobs?: { name: string; status?: string; conclusion?: string | null }[];
  /** The run's `display_title`. Default: `Run <number>`. */
  title?: string;
  /** What started it. Default: `push`. */
  event?: string;
  /** The workflow file's name below `.github/workflows/`. Default: `ci.yml`. */
  workflow?: string;
}

/** What a test says about a deployment; the rest is filled in the way GitHub would. */
export interface DeploymentSeed {
  environment: string;
  /** Default: `main`. */
  ref?: string;
  /** Default: the head of the ref. */
  sha?: string;
  /**
   * The state of its first status: queued, pending, in_progress, success, failure, error or inactive. Default: none,
   * which is a deployment nothing has reported on yet.
   */
  state?: string;
}

/** Whose Actions items: a repository (`owner/name`), one of its environments, or an organization. */
export type ActionsWhere = { repository: string; environment?: string } | { organization: string };

export interface HeldItem {
  value: string;
  updatedAt: string;
  /** An organization's items only: `all`, `private` or `selected`. */
  visibility?: string;
}

export interface MockGithub {
  /** Web address of the mock; give it to the client as `baseUrl` with `allowInsecureHttp`. */
  url: string;
  requests: MockRequest[];
  inject(i: Injection): void;
  addRepo(owner: string, name: string, over?: Partial<MockRepo> & RepoSeed): MockRepo;
  addTag(owner: string, name: string, tag: string, ref: string): void;
  /** Merges a pull request the way GitHub reports it: closed, with a `merged_at`. */
  mergePull(owner: string, name: string, number: number): void;
  /** GitHub's `mergeable_state` of one pull request (`clean`, `dirty`, `blocked`, `unknown`, ...); `clean` by default. */
  setMergeState(owner: string, name: string, number: number, state: string): void;
  /** A workflow run with its jobs; returns its id and its number in the repository. */
  addRun(owner: string, name: string, run?: RunSeed): { id: number; number: number };
  /** Moves a run on the way GitHub reports it (jobs are left as they are). */
  setRun(
    owner: string,
    name: string,
    id: number,
    to: { status?: string; conclusion?: string | null },
  ): void;
  /**
   * Moves one job of a run, or adds it when the run has none of that name (a later level's job appears when the one
   * before it is done). A job moved to `completed` with no conclusion of its own keeps the one it had.
   */
  setJob(
    owner: string,
    name: string,
    runId: number,
    job: string,
    to: { status?: string; conclusion?: string | null },
  ): void;
  /** A deployment of a commit to an environment; returns its id. */
  addDeployment(owner: string, name: string, seed: DeploymentSeed): { id: number };
  /** Posts a status to a deployment, as the deploying job does while it runs; `logUrl` is the address GitHub shows for it. */
  setDeployment(owner: string, name: string, id: number, state: string, logUrl?: string): void;
  /** A review of a pull request, as its author sees it in the list: `state` is APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
  addReview(
    owner: string,
    name: string,
    number: number,
    review: { login: string; state: string; commit?: string },
  ): void;
  /**
   * Protects a branch. `approvals` is the number of approving reviews the protection requires; `null` is protection
   * with no pull request reviews in it.
   */
  protectBranch(
    owner: string,
    name: string,
    branch: string,
    over: { approvals: number | null },
  ): void;
  /** A ruleset that applies to a branch and requires `approvals` approving reviews. */
  addRuleset(owner: string, name: string, branch: string, over: { approvals: number }): void;
  /** An environment with the protection rules GitHub would list for it (`required_reviewers`, `wait_timer`, ...), as it sends them. */
  addEnvironment(owner: string, name: string, environment: string, rules?: unknown[]): void;
  /**
   * What a repository, one of its environments or an organization holds in Actions. A secret's value is what the
   * mock opened with the scope's own key, which is how a test sees that what was written is what was meant.
   */
  actions(where: ActionsWhere): {
    secrets: Record<string, HeldItem>;
    variables: Record<string, HeldItem>;
  };
  /** A comment on a pull request written by `login` (made an account when it is none); returns the comment's id. */
  addComment(owner: string, name: string, number: number, login: string, body: string): number;
  /** The comments on a pull request, oldest first. */
  comments(
    owner: string,
    name: string,
    number: number,
  ): { id: number; login: string; body: string }[];
  /** A user account. Ids are shared with organizations, as GitHub's account ids are. */
  addUser(login: string): { id: number; login: string };
  addOrg(login: string): { id: number; login: string };
  /**
   * Makes a user a collaborator of a repository. `role` is GitHub's role name (read, triage, write, maintain, admin or a
   * custom role's); `permission`, the old three-valued one, follows from it unless a custom role says what it is built on.
   */
  addCollaborator(
    owner: string,
    name: string,
    login: string,
    role: string,
    permission?: string,
  ): void;
  /** Makes a user a member of an organization: `role` admin, member or billing_manager; `state` active or pending. */
  addOrgMember(org: string, login: string, role: string, state?: string): void;
  /**
   * What GitHub sends back to the app after a person approves it: a code for the account, good once. With a
   * PKCE `challenge` (S256) the exchange must bring the verifier it came from.
   */
  grant(login: string, challenge?: string): string;
  /** The OAuth access tokens handed out so far, for a test that checks none of them leaks. */
  issuedTokens(): string[];
  stop(): void;
}

/** A JSON answer; a string body is sent as it is (an HTML error page, a broken payload), and 204 has none. */
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  status === 204
    ? new Response(null, { status, headers })
    : new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: {
          "content-type":
            typeof body === "string" ? "text/html" : "application/json; charset=utf-8",
          ...headers,
        },
      });

/** Repository routes with one answer each, the permission probes of FRG-10 that have no logic behind them. */
const REPO_ROUTES: Record<string, unknown> = {
  "/actions/workflows": { total_count: 0, workflows: [] },
  "/hooks": [],
};

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  mergedAt: string | null;
  draft: boolean;
  head: string;
  /** The head when it was opened, for when the branch is gone. */
  headSha: string;
  base: string;
  mergeState: string;
}

interface PullState {
  list: Pull[];
  comments: { id: number; issue: number; body: string; user?: { id: number; login: string } }[];
  /** Pull requests and issues share one numbering. */
  next: number;
}

interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

interface Run {
  id: number;
  number: number;
  status: string;
  conclusion: string | null;
  branch: string | null;
  sha: string;
  jobs: Job[];
  title: string;
  event: string;
  /** The workflow file's path. */
  path: string;
  /** Reads of the workflow's run list that still leave the run out. */
  hidden: number;
}

/** A deployment and the statuses posted to it, oldest first. */
interface MockDeployment {
  id: number;
  environment: string;
  ref: string;
  sha: string;
  createdAt: string;
  statuses: { id: number; state: string; logUrl: string | null; createdAt: string }[];
}

/** An Actions secret or variable; `value` is plain text, a secret's opened with the scope's key. */
interface Held extends HeldItem {
  created: string;
}

/** One scope's Actions items and its key pair, made when first asked for, as GitHub has one key per scope. */
interface ActionsHold {
  secrets: Map<string, Held>;
  variables: Map<string, Held>;
  key?: { id: string; pk: Uint8Array; sk: Uint8Array };
}

/** What GitHub takes of a secret or a variable. */
const ACTIONS_MAX = 48 * 1024;
const actionsName = (n: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !/^github_/i.test(n);

interface Review {
  pull: number;
  user: { id: number; login: string };
  state: string;
  commit: string;
}

interface Account {
  id: number;
  login: string;
  type: "User" | "Organization";
}

/** The old `permission` of a collaborator, which folds triage into read and maintain into write. */
const LEGACY: Record<string, string> = {
  admin: "admin",
  maintain: "write",
  write: "write",
  triage: "read",
  read: "read",
};

/** What `rerun-failed-jobs` starts again. */
const FAILED = ["failure", "cancelled", "timed_out", "startup_failure"];

export function createMockGithub(opts: MockGithubOptions = {}): MockGithub {
  const requests: MockRequest[] = [];
  const injections: (Injection & { left: number })[] = [];
  const repos: MockRepo[] = [];
  const gits = new Map<string, MockGit>();
  const pulls = new Map<string, PullState>();
  const runs = new Map<string, Run[]>();
  const deployments = new Map<string, MockDeployment[]>();
  const maxPerPage = opts.maxPerPage ?? 100;
  let nextRepoId = 1000;
  let nextPullId = 5000;
  let nextCommentId = 9000;
  let nextRunId = 7000;
  let nextJobId = 8000;
  let nextDeploymentId = 3000;
  let nextStatusId = 4000;
  let nextAccountId = 100;
  const accounts: Account[] = [];
  const collaborators = new Map<string, Map<string, { role: string; permission: string }>>();
  const orgMembers = new Map<string, Map<string, { role: string; state: string }>>();
  const environments = new Map<string, Map<string, unknown[]>>();
  const reviews = new Map<string, Review[]>();
  const protections = new Map<string, Map<string, number | null>>();
  const rulesets = new Map<string, Map<string, number>>();
  const actionsHolds = new Map<string, ActionsHold>();
  let nextKeyId = 5_000_000;
  let tick = 0;
  const codes = new Map<string, { login: string; challenge?: string }>();
  const userTokens = new Map<string, string>(); // an OAuth access token and the login it speaks for

  /** `/login/oauth/access_token` the way GitHub answers: 200 with an `error` in the body when the exchange fails. */
  function exchange(req: Request, text: string) {
    const form = new URLSearchParams(text);
    // GitHub answers in a form-encoded body unless asked for JSON
    const answer = (body: Record<string, string>) =>
      req.headers.get("accept") === "application/json"
        ? json(200, body)
        : new Response(new URLSearchParams(body).toString(), {
            headers: { "content-type": "application/x-www-form-urlencoded" },
          });
    if (!opts.oauth) return json(404, { message: "Not Found" });
    if (form.get("client_id") !== opts.oauth.clientId)
      return answer({ error: "incorrect_client_credentials" });
    if (form.get("client_secret") !== opts.oauth.clientSecret) {
      return answer({ error: "incorrect_client_credentials" });
    }
    const code = form.get("code") ?? "";
    const grant = codes.get(code);
    codes.delete(code); // a code works once, whether or not the rest holds
    if (!grant) return answer({ error: "bad_verification_code" });
    if (grant.challenge) {
      const verifier = form.get("code_verifier") ?? "";
      const made = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
      if (!verifier || made !== grant.challenge) return answer({ error: "bad_verification_code" });
    }
    const token = `gho_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    userTokens.set(token, grant.login);
    return answer({ access_token: token, token_type: "bearer", scope: "read:user" });
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
        return exchange(req, text); // a form body, outside `/api/v3`: not a request the log below describes
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of req.headers) if (k !== "authorization") headers[k] = v;
      const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
      const authorized =
        (token !== undefined && userTokens.has(token)) ||
        (opts.token ? token === opts.token : (token?.length ?? 0) >= 8);
      const path = url.pathname.startsWith("/api/v3") ? url.pathname.slice("/api/v3".length) : "";
      requests.push({
        method: req.method,
        path,
        query: url.searchParams,
        headers,
        authorized,
        body: text ? JSON.parse(text) : undefined,
      });

      const hit = injections.find((i) => i.left > 0 && i.method === req.method && i.path === path);
      if (hit) {
        hit.left--;
        return json(hit.status, hit.body ?? { message: "injected" }, hit.headers);
      }
      if (!url.pathname.startsWith("/api/v3/")) return json(404, { message: "Not Found" });
      if (!authorized) return json(401, { message: "Bad credentials" });
      if (req.headers.get("x-github-api-version") !== API_VERSION) {
        return json(400, { message: "Unsupported X-GitHub-Api-Version" });
      }
      if (!req.headers.get("user-agent"))
        return json(403, { message: "Request forbidden: no User-Agent" });
      if (req.headers.get("accept") === null) return json(400, { message: "no Accept header" });

      if (req.method === "GET" && path === "/user") {
        // an OAuth token speaks for the person who approved it, with no public name unless they set one
        const who = accounts.find((a) => a.login === userTokens.get(token ?? ""));
        return json(
          200,
          who ? { ...who, name: null } : { id: 1, login: "mock-user", type: "User" },
        );
      }
      if (req.method === "GET" && path === "/user/repos") return page(url, repos.map(view));
      // an app installation's repositories: a list GitHub wraps in an object, the `items` case of `paginate`
      if (req.method === "GET" && path === "/installation/repositories") {
        return page(url, repos.map(view), "repositories");
      }
      const account = /^\/(user|organizations)\/(\d+)$/.exec(path);
      if (req.method === "GET" && account) {
        const a = accounts.find((x) => x.id === Number(account[2]));
        // `/user/:id` answers for any account, an organization's included
        const fits = account[1] === "user" || a?.type === "Organization";
        return a && fits ? json(200, a) : json(404, { message: "Not Found" });
      }
      const orgMember = /^\/orgs\/([^/]+)\/memberships\/([^/]+)$/.exec(path);
      if (req.method === "GET" && orgMember) {
        const m = orgMembers.get(orgMember[1] ?? "")?.get(orgMember[2] ?? "");
        return m
          ? json(200, { ...m, user: { login: orgMember[2] } })
          : json(404, { message: "Not Found" });
      }
      const byId = /^\/repositories\/(\d+)$/.exec(path);
      if (req.method === "GET" && byId) {
        const repo = repos.find((r) => r.id === Number(byId[1]));
        return repo ? json(200, view(repo)) : json(404, { message: "Not Found" });
      }
      const orgActions = /^\/orgs\/([^/]+)\/actions\/(secrets|variables)(?:\/([^/]+))?$/.exec(path);
      if (orgActions) {
        if (opts.denied?.some((d) => path === d || path.startsWith(`${d}/`))) {
          return json(403, { message: "Resource not accessible by personal access token" });
        }
        const org = accounts.find((a) => a.type === "Organization" && a.login === orgActions[1]);
        if (!org) return json(404, { message: "Not Found" });
        return actionsRoute({
          where: whereKey({ organization: org.login }),
          org: true,
          method: req.method,
          kind: orgActions[2] as "secrets" | "variables",
          name: orgActions[3],
          url,
          body: text ? JSON.parse(text) : {},
        });
      }
      const inRepo = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
      if (!inRepo) return json(404, { message: "Not Found" });
      const full = `${inRepo[1]}/${inRepo[2]}`;
      const repo = repos.find((r) => r.full_name === full);
      const git = gits.get(full);
      if (!repo || !git) return json(404, { message: "Not Found" });
      const rest = decodeURIComponent(inRepo[3] ?? "");
      if (rest === "")
        return req.method === "GET" ? json(200, view(repo)) : json(404, { message: "Not Found" });
      if (opts.denied?.some((d) => rest === d || rest.startsWith(`${d}/`))) {
        return json(403, { message: "Resource not accessible by personal access token" });
      }
      if (req.method === "GET" && rest in REPO_ROUTES) return json(200, REPO_ROUTES[rest]);
      const body = (text ? JSON.parse(text) : {}) as Ctx["body"];
      return repoRoute({
        repo,
        git,
        pulls: pullsOf(full),
        runs: runsOf(full),
        method: req.method,
        rest,
        url,
        body,
      });
    },
  });

  /** A run as `addRun` and a dispatch both make it; the caller adds it to the list. */
  function newRun(list: Run[], git: MockGit, seed: RunSeed & { hidden?: number }): Run {
    const branch = seed.branch === undefined ? "main" : seed.branch;
    const status = seed.status ?? "queued";
    const conclusion = seed.conclusion ?? null;
    const number = list.length + 1;
    return {
      id: nextRunId++,
      number,
      status,
      conclusion,
      branch,
      sha: seed.sha ?? git.branches.get(branch ?? "") ?? "0".repeat(40),
      jobs: (seed.jobs ?? [{ name: "build" }]).map((j) => ({
        id: nextJobId++,
        name: j.name,
        status: j.status ?? status,
        conclusion: j.conclusion === undefined ? (j.status ? null : conclusion) : j.conclusion,
      })),
      title: seed.title ?? `Run ${number}`,
      event: seed.event ?? "push",
      path: `.github/workflows/${seed.workflow ?? "ci.yml"}`,
      hidden: seed.hidden ?? 0,
    };
  }

  const view = (r: MockRepo) => ({ ...r, owner: { login: r.full_name.split("/")[0] } });
  const pullsOf = (full: string) => {
    const p = pulls.get(full) ?? { list: [], comments: [], next: 1 };
    pulls.set(full, p);
    return p;
  };

  const runsOf = (full: string) => {
    const r = runs.get(full) ?? [];
    runs.set(full, r);
    return r;
  };

  interface Ctx {
    repo: MockRepo;
    git: MockGit;
    pulls: PullState;
    runs: Run[];
    method: string;
    rest: string;
    url: URL;
    // biome-ignore lint/suspicious/noExplicitAny: a mock reads whatever shape the client under test sends
    body: Record<string, any>;
  }
  const bad = (message: string) =>
    json(422, { message: "Validation Failed", errors: [{ message }] });
  const notFound = () => json(404, { message: "Not Found" });

  /** The routes under `/repos/:owner/:repo` that read or change what the repository holds. */
  function repoRoute(c: Ctx): Response | Promise<Response> {
    const { repo, git, method, rest, url, body } = c;
    const q = url.searchParams;
    const own = /^\/actions\/(secrets|variables)(?:\/([^/]+))?$/.exec(rest);
    if (own) {
      return actionsRoute({
        where: whereKey({ repository: repo.full_name }),
        org: false,
        method,
        kind: own[1] as "secrets" | "variables",
        name: own[2],
        url,
        body,
      });
    }
    const env = /^\/environments\/([^/]+)\/(secrets|variables)(?:\/([^/]+))?$/.exec(rest);
    if (env) {
      if (!environments.get(repo.full_name)?.has(env[1] ?? "")) return notFound();
      return actionsRoute({
        where: whereKey({ repository: repo.full_name, environment: env[1] ?? "" }),
        org: false,
        method,
        kind: env[2] as "secrets" | "variables",
        name: env[3],
        url,
        body,
      });
    }
    const commitJson = (sha: string) => {
      const k = git.commits.get(sha);
      return {
        sha,
        commit: { message: k?.message ?? "", tree: { sha: k?.tree } },
        parents: (k?.parents ?? []).map((p) => ({ sha: p })),
      };
    };
    const on = (verb: string, re: RegExp) => (verb === method ? re.exec(rest) : null);
    let m: RegExpExecArray | null;

    m = on("POST", /^\/actions\/workflows\/([^/]+)\/dispatches$/);
    if (m) return dispatch(c, m[1] ?? "");
    m = on("GET", /^\/actions\/workflows\/([^/]+)\/runs$/);
    if (m) {
      const path = `.github/workflows/${m[1]}`;
      const event = q.get("event");
      const branch = q.get("branch");
      const hit = c.runs
        .filter((r) => r.path === path)
        .filter((r) => (event ? r.event === event : true))
        .filter((r) => (branch ? r.branch === branch : true))
        .filter((r) => !(r.hidden > 0 && r.hidden--))
        .reverse();
      return page(
        url,
        hit.map((r) => runJson(r, repo)),
        "workflow_runs",
      );
    }

    m = on("GET", /^\/branches\/(.+)\/protection\/required_pull_request_reviews$/);
    if (m) {
      const held = protections.get(repo.full_name)?.get(m[1] ?? "");
      if (held === undefined) return json(404, { message: "Branch not protected" });
      if (held === null) return json(404, { message: "Pull request reviews not enabled" });
      return json(200, { required_approving_review_count: held });
    }
    m = on("GET", /^\/rules\/branches\/(.+)$/);
    if (m) {
      const n = rulesets.get(repo.full_name)?.get(m[1] ?? "");
      return json(
        200,
        n === undefined
          ? []
          : [
              {
                type: "pull_request",
                ruleset_id: 1,
                parameters: { required_approving_review_count: n },
              },
            ],
      );
    }
    m = on("GET", /^\/pulls\/(\d+)\/reviews$/);
    if (m) {
      const mine = (reviews.get(repo.full_name) ?? []).filter((r) => r.pull === Number(m?.[1]));
      return page(
        url,
        mine.map((r, i) => ({ id: i + 1, user: r.user, state: r.state, commit_id: r.commit })),
      );
    }

    m = on("GET", /^\/environments$/);
    if (m) {
      const held = [...(environments.get(repo.full_name)?.keys() ?? [])];
      return page(
        url,
        held.map((name, i) => ({ id: i + 1, name })),
        "environments",
      );
    }
    m = on("GET", /^\/deployments$/);
    if (m) {
      const env = q.get("environment");
      const mine = (deployments.get(repo.full_name) ?? [])
        .filter((d) => env === null || d.environment === env)
        .toSorted((a, b) => b.id - a.id);
      return page(url, mine.map(deploymentJson));
    }
    m = on("GET", /^\/deployments\/(\d+)(\/statuses)?$/);
    if (m) {
      const d = (deployments.get(repo.full_name) ?? []).find((x) => x.id === Number(m?.[1]));
      if (!d) return notFound();
      if (!m[2]) return json(200, deploymentJson(d));
      return page(
        url,
        d.statuses.toReversed().map((st) => ({
          id: st.id,
          state: st.state,
          environment: d.environment,
          log_url: st.logUrl,
          created_at: st.createdAt,
          updated_at: st.createdAt,
        })),
      );
    }
    m = on("GET", /^\/environments\/([^/]+)$/);
    if (m) {
      const rules = environments.get(repo.full_name)?.get(m[1] ?? "");
      return rules
        ? json(200, { name: m[1], protection_rules: rules, deployment_branch_policy: null })
        : notFound();
    }

    m = on("GET", /^\/collaborators\/([^/]+)(\/permission)?$/);
    if (m) {
      const login = m[1] ?? "";
      const held = collaborators.get(repo.full_name)?.get(login);
      if (!m[2]) return held ? json(204, null) : notFound();
      // a stranger to a public repository can read it, which is what the permission route says of them
      const stranger = repo.private ? "none" : "read";
      return json(200, {
        permission: held?.permission ?? stranger,
        role_name: held?.role ?? stranger,
        user: { login },
      });
    }

    m = on("GET", /^\/branches\/(.+)$/);
    if (m) {
      const sha = git.branches.get(m[1] ?? "");
      if (!sha) return notFound();
      return json(200, { name: m[1], commit: commitJson(sha), protected: false });
    }
    if (method === "GET" && rest === "/commits") {
      const from = git.resolve(q.get("sha") ?? repo.default_branch);
      if (!from) return notFound();
      const path = q.get("path");
      const hit = git.chain(from).filter((k) => {
        if (!path) return true;
        const here = git.filesAt(k.sha)[path];
        const before = k.parents[0] ? git.filesAt(k.parents[0])[path] : undefined;
        return here !== before;
      });
      return page(
        url,
        hit.map((k) => commitJson(k.sha)),
      );
    }
    m = on("GET", /^\/commits\/(.+)$/);
    if (m) {
      const sha = git.resolve(m[1] ?? "");
      return sha ? json(200, commitJson(sha)) : bad(`No commit found for SHA: ${m[1]}`);
    }
    if (method === "GET" && (rest === "/contents" || rest.startsWith("/contents/"))) {
      const at = git.resolve(q.get("ref") ?? repo.default_branch);
      if (!at) return notFound();
      const path = rest.slice("/contents/".length);
      const files = git.filesAt(at);
      const blob = files[path];
      if (blob !== undefined) {
        const text = git.blobs.get(blob) ?? "";
        return json(200, {
          type: "file",
          encoding: "base64",
          name: path.split("/").pop(),
          path,
          sha: blob,
          size: Buffer.byteLength(text),
          content: `${Buffer.from(text)
            .toString("base64")
            .replace(/(.{60})/g, "$1\n")}\n`,
        });
      }
      const prefix = path === "" ? "" : `${path}/`;
      const below = Object.keys(files).filter((f) => f.startsWith(prefix));
      if (below.length === 0) return notFound();
      const names = [...new Set(below.map((f) => f.slice(prefix.length).split("/")[0] ?? ""))];
      return json(
        200,
        names.map((n) => ({
          type: files[prefix + n] === undefined ? "dir" : "file",
          name: n,
          path: prefix + n,
        })),
      );
    }
    m = on("GET", /^\/git\/trees\/(.+)$/);
    if (m) {
      const sha = git.resolve(m[1] ?? "");
      const files = sha ? git.filesAt(sha) : git.trees.get(m[1] ?? "");
      if (!files) return notFound();
      const tree = treeEntries(git, files, q.get("recursive") !== null);
      return json(200, { sha: m[1], tree, truncated: false });
    }
    if (method === "POST" && rest === "/git/trees") {
      const base = body.base_tree as string | undefined;
      const files = { ...(base === undefined ? {} : git.trees.get(base)) };
      if (base !== undefined && !git.trees.has(base)) return bad("The base tree does not exist");
      for (const item of (body.tree ?? []) as {
        path: string;
        sha?: string | null;
        content?: string;
      }[]) {
        if (item.sha === null) delete files[item.path];
        else if (typeof item.content === "string") files[item.path] = git.blob(item.content);
        else if (item.sha && git.blobs.has(item.sha)) files[item.path] = item.sha;
        else return bad(`${item.path} has no content`);
      }
      return json(201, { sha: git.tree(files) });
    }
    if (method === "POST" && rest === "/git/commits") {
      const parents = (body.parents ?? []) as string[];
      if (!git.trees.has(body.tree) || !parents.every((p) => git.commits.has(p))) {
        return bad("The tree or a parent does not exist");
      }
      const sha = git.commit(parents, body.tree, String(body.message ?? ""));
      return json(201, { sha, html_url: `${repo.html_url}/commit/${sha}`, message: body.message });
    }
    if (method === "POST" && rest === "/git/refs") {
      const ref = /^refs\/(heads|tags)\/(.+)$/.exec(String(body.ref ?? ""));
      if (!ref) return bad("The ref is not a branch or a tag");
      const table = ref[1] === "heads" ? git.branches : git.tags;
      if (!git.commits.has(body.sha)) return bad("Object does not exist");
      if (table.has(ref[2] ?? "")) return bad("Reference already exists");
      table.set(ref[2] ?? "", body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha, type: "commit" } });
    }
    m = on("PATCH", /^\/git\/refs\/heads\/(.+)$/) ?? on("DELETE", /^\/git\/refs\/heads\/(.+)$/);
    if (m) {
      const name = m[1] ?? "";
      const now = git.branches.get(name);
      if (!now) return bad("Reference does not exist");
      if (method === "DELETE") {
        git.branches.delete(name);
        return json(204, null);
      }
      if (!git.commits.has(body.sha)) return bad("Object does not exist");
      if (body.force !== true && !git.isAncestor(now, body.sha)) {
        return bad("Update is not a fast forward");
      }
      git.branches.set(name, body.sha);
      return json(200, { ref: `refs/heads/${name}`, object: { sha: body.sha } });
    }
    if (method === "GET" && rest === "/tags") {
      return page(
        url,
        [...git.tags].map(([name, sha]) => ({ name, commit: { sha } })),
      );
    }
    m = on("GET", /^\/compare\/(.+?)\.\.\.(.+)$/);
    if (m) {
      const a = git.resolve(m[1] ?? "");
      const b = git.resolve(m[2] ?? "");
      if (!a || !b) return notFound();
      const { commits, files } = git.compare(a, b);
      const per = Number(q.get("per_page") ?? 30) || 30;
      const n = Math.max(1, Number(q.get("page") ?? 1) || 1);
      const slice = <T>(all: T[]) => all.slice((n - 1) * per, n * per);
      return json(200, {
        status: a === b ? "identical" : "ahead",
        total_commits: commits.length,
        commits: slice(commits).map((k) => commitJson(k.sha)),
        files: slice(files),
      });
    }
    return pullRoute(c, bad, notFound);
  }

  const whereKey = (w: ActionsWhere) =>
    "organization" in w
      ? `org:${w.organization}`
      : w.environment === undefined
        ? `repo:${w.repository}`
        : `env:${w.repository}:${w.environment}`;
  const holdOf = (key: string) => {
    const h: ActionsHold = actionsHolds.get(key) ?? { secrets: new Map(), variables: new Map() };
    actionsHolds.set(key, h);
    return h;
  };
  const stamp = () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000).toISOString();

  /**
   * Actions secrets and variables of one scope, as strict as GitHub: names are stored in capitals, a secret is sealed
   * to the scope's own key and refused if it does not open with it or names another key, an organization's items need
   * a visibility, and nothing is over 48 KB.
   */
  async function actionsRoute(a: {
    where: string;
    org: boolean;
    method: string;
    kind: "secrets" | "variables";
    name: string | undefined;
    url: URL;
    // biome-ignore lint/suspicious/noExplicitAny: a mock reads whatever shape the client under test sends
    body: Record<string, any>;
  }): Promise<Response> {
    const { where, org, method, kind, name, url, body } = a;
    const hold = holdOf(where);
    const table = hold[kind];
    const view = (n: string, h: Held) => ({
      name: n,
      ...(kind === "variables" ? { value: h.value } : {}),
      created_at: h.created,
      updated_at: h.updatedAt,
      ...(org ? { visibility: h.visibility } : {}),
    });
    const visibility = (): { visibility?: string } | Response => {
      if (!org) return {};
      const v = body.visibility;
      if (v === "selected") {
        const ids = body.selected_repository_ids;
        return Array.isArray(ids) && ids.length > 0
          ? { visibility: v }
          : bad("selected_repository_ids is required for visibility selected");
      }
      return v === "all" || v === "private"
        ? { visibility: v }
        : bad("visibility must be all, private or selected");
    };

    if (name === undefined) {
      if (method === "GET") {
        const all = [...table].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
        return page(
          url,
          all.map(([n, h]) => view(n, h)),
          kind,
        );
      }
      if (method === "POST" && kind === "variables") {
        if (typeof body.name !== "string" || !actionsName(body.name)) {
          return bad("Variable name is not valid");
        }
        if (typeof body.value !== "string") return bad("Variable value must be a string");
        if (Buffer.byteLength(body.value) > ACTIONS_MAX) return bad("Variable value is too large");
        const v = visibility();
        if (v instanceof Response) return v;
        const n = body.name.toUpperCase();
        if (table.has(n)) return json(409, { message: "Variable already exists" });
        const now = stamp();
        table.set(n, { value: body.value, created: now, updatedAt: now, ...v });
        return json(201, {});
      }
      return notFound();
    }

    if (kind === "secrets" && name === "public-key") {
      if (method !== "GET") return notFound();
      await sodium.ready;
      hold.key ??= { id: String(nextKeyId++), ...keyPair() };
      return json(200, { key_id: hold.key.id, key: Buffer.from(hold.key.pk).toString("base64") });
    }
    if (!actionsName(name)) return bad("Name is not valid");
    const n = name.toUpperCase();
    const held = table.get(n);

    if (method === "GET") return held ? json(200, view(n, held)) : notFound();
    if (method === "DELETE") {
      if (!held) return notFound();
      table.delete(n);
      return json(204, null);
    }
    if (method === "PATCH" && kind === "variables") {
      if (!held) return notFound();
      if (typeof body.name === "string" && body.name.toUpperCase() !== n) {
        return bad("The mock does not rename a variable");
      }
      if (typeof body.value !== "string") return bad("Variable value must be a string");
      if (Buffer.byteLength(body.value) > ACTIONS_MAX) return bad("Variable value is too large");
      const v = body.visibility === undefined ? {} : visibility();
      if (v instanceof Response) return v;
      Object.assign(held, { value: body.value, updatedAt: stamp(), ...v });
      return json(204, null);
    }
    if (method === "PUT" && kind === "secrets") {
      await sodium.ready;
      hold.key ??= { id: String(nextKeyId++), ...keyPair() };
      const sealed = body.encrypted_value;
      if (
        typeof sealed !== "string" ||
        sealed.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(sealed)
      ) {
        return bad("encrypted_value must be padded base64");
      }
      if (body.key_id !== hold.key.id) return bad("key_id does not name this scope's public key");
      let plain: string;
      try {
        const bytes = sodium.crypto_box_seal_open(
          Buffer.from(sealed, "base64"),
          hold.key.pk,
          hold.key.sk,
        );
        if (bytes.length > ACTIONS_MAX) return bad("Secret is too large");
        plain = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return bad("encrypted_value could not be decrypted with the public key");
      }
      const v = visibility();
      if (v instanceof Response) return v;
      const now = stamp();
      if (held) Object.assign(held, { value: plain, updatedAt: now, ...v });
      else table.set(n, { value: plain, created: now, updatedAt: now, ...v });
      return json(held ? 204 : 201, held ? null : {});
    }
    return notFound();
  }
  const keyPair = () => {
    const k = sodium.crypto_box_keypair();
    return { pk: k.publicKey, sk: k.privateKey };
  };

  /**
   * `POST /actions/workflows/:file/dispatches`: reads the workflow at the ref, checks the inputs against the ones it
   * declares as GitHub does (an undeclared input, a missing required one and a choice outside its options are 422),
   * and makes a queued run titled by the workflow's `run-name`. It answers 204 and says nothing of the run.
   */
  function dispatch(c: Ctx, file: string): Response {
    const { git, body } = c;
    const ref = String(body.ref ?? "");
    const sha = git.resolve(ref);
    if (!sha) return bad(`No ref found for: ${ref}`);
    const path = `.github/workflows/${file}`;
    const blob = git.filesAt(sha)[path];
    if (blob === undefined) return notFound();
    const workflow = parse(git.blobs.get(blob) ?? "") as {
      name?: string;
      "run-name"?: string;
      on?: unknown;
    };
    const trigger = workflow.on;
    const dispatchable =
      trigger === "workflow_dispatch" ||
      (Array.isArray(trigger) && trigger.includes("workflow_dispatch")) ||
      (typeof trigger === "object" && trigger !== null && "workflow_dispatch" in trigger);
    if (!dispatchable) return bad("Workflow does not have 'workflow_dispatch' trigger");
    const declared = ((trigger as { workflow_dispatch?: { inputs?: object } })?.workflow_dispatch
      ?.inputs ?? {}) as Record<
      string,
      { required?: boolean; default?: string; options?: string[] }
    >;
    const given = (body.inputs ?? {}) as Record<string, unknown>;
    const extra = Object.keys(given).filter((k) => !(k in declared));
    if (extra.length > 0) return bad(`Unexpected inputs provided: ${JSON.stringify(extra)}`);
    const value: Record<string, string> = {};
    for (const [k, d] of Object.entries(declared)) {
      const v = given[k] ?? d.default;
      if (v === undefined) {
        if (d.required) return bad(`Required input '${k}' not provided`);
        continue;
      }
      if (typeof v !== "string") return bad(`Input '${k}' must be a string`);
      if (d.options && !d.options.includes(v)) {
        return bad(`Provided value '${v}' for input '${k}' not in the list of allowed values`);
      }
      value[k] = v;
    }
    // the expressions a `run-name` uses here: `inputs.x`, `github.sha` and 'a literal', the first that is not empty of
    // several joined by `||`; GitHub evaluates far more, and a name the mock cannot read stays as written
    const term = (t: string) => {
      const name = t.trim();
      if (name === "github.sha") return sha;
      const literal = /^'([^']*)'$/.exec(name);
      if (literal) return literal[1] ?? "";
      const input = /^inputs\.([\w-]+)$/.exec(name);
      return input ? (value[input[1] as string] ?? "") : undefined;
    };
    const title = (workflow["run-name"] ?? workflow.name ?? file).replace(
      /\$\{\{([^}]*)\}\}/g,
      (whole, e: string) => {
        const terms = e.split("||").map(term);
        return terms.includes(undefined) ? whole : (terms.find((v) => v) ?? "");
      },
    );
    for (let i = 0; i < (opts.alsoDispatches ? 2 : 1); i++) {
      c.runs.push(
        newRun(c.runs, git, {
          branch: git.branches.has(ref) ? ref : null,
          sha,
          title,
          event: "workflow_dispatch",
          workflow: file,
          hidden: opts.runAppearsAfter ?? 0,
        }),
      );
    }
    return json(204, null);
  }

  function pullRoute(c: Ctx, bad: (m: string) => Response, notFound: () => Response): Response {
    const { repo, git, pulls: state, method, rest, url, body } = c;
    const q = url.searchParams;
    const api = `${url.origin}/api/v3/repos/${repo.full_name}`;
    const full = (p: Pull) => ({
      id: p.id,
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.state,
      merged: p.mergedAt !== null,
      merged_at: p.mergedAt,
      draft: p.draft,
      html_url: `${repo.html_url}/pull/${p.number}`,
      head: { ref: p.head, sha: git.branches.get(p.head) ?? p.headSha },
      base: { ref: p.base, sha: git.branches.get(p.base) ?? "" },
      mergeable_state: p.mergeState,
    });
    // GitHub's list answers lack the fields that cost it a computation
    const summary = (p: Pull) => {
      const { merged: _m, mergeable_state: _s, ...kept } = full(p);
      return kept;
    };
    const find = (n: string | undefined) => state.list.find((p) => p.number === Number(n));
    const on = (verb: string, re: RegExp) => (verb === method ? re.exec(rest) : null);
    let m: RegExpExecArray | null;

    if (method === "GET" && rest === "/pulls") {
      const want = q.get("state") ?? "open";
      const head = q.get("head")?.split(":")[1];
      const base = q.get("base");
      const hit = state.list
        .filter((p) => want === "all" || p.state === want)
        .filter((p) => (head ? p.head === head : true) && (base ? p.base === base : true))
        .reverse();
      return page(url, hit.map(summary));
    }
    if (method === "POST" && rest === "/pulls") {
      const head = String(body.head ?? "");
      const base = String(body.base ?? "");
      const headSha = git.branches.get(head);
      const baseSha = git.branches.get(base);
      if (!headSha || !baseSha) return bad("The head or the base branch does not exist");
      if (git.isAncestor(headSha, baseSha)) return bad(`No commits between ${base} and ${head}`);
      if (state.list.some((p) => p.state === "open" && p.head === head && p.base === base)) {
        return bad(`A pull request already exists for ${repo.full_name.split("/")[0]}:${head}.`);
      }
      const p: Pull = {
        id: nextPullId++,
        number: state.next++,
        title: String(body.title ?? ""),
        body: typeof body.body === "string" ? body.body : "",
        state: "open",
        mergedAt: null,
        draft: body.draft === true,
        head,
        headSha,
        base,
        mergeState: "clean",
      };
      state.list.push(p);
      return json(201, full(p));
    }
    m = /^\/pulls\/(\d+)$/.exec(rest);
    if (m) {
      const p = find(m[1]);
      if (!p) return notFound();
      if (method === "GET") return json(200, full(p));
      if (method === "PATCH") {
        if (body.state === "open" && p.mergedAt)
          return bad("A merged pull request cannot be reopened");
        if (typeof body.base === "string" && !git.branches.has(body.base))
          return bad("The base does not exist");
        if (typeof body.title === "string") p.title = body.title;
        if (typeof body.body === "string") p.body = body.body;
        if (typeof body.base === "string") p.base = body.base;
        if (body.state === "open" || body.state === "closed") p.state = body.state;
        return json(200, full(p));
      }
    }
    m = /^\/actions\/runs\/(\d+)(?:\/(jobs|rerun-failed-jobs|cancel))?$/.exec(rest);
    if (m) {
      const r = c.runs.find((x) => x.id === Number(m?.[1]));
      if (!r) return notFound();
      const act = m[2];
      if (method === "GET" && !act) return json(200, runJson(r, repo));
      if (method === "GET" && act === "jobs") {
        return page(
          url,
          r.jobs.map((j) => jobJson(j, r, repo)),
          "jobs",
        );
      }
      if (method === "POST" && act === "rerun-failed-jobs") {
        if (r.status !== "completed") return json(403, { message: "Workflow is already running" });
        r.status = "queued";
        r.conclusion = null;
        for (const j of r.jobs.filter((x) => FAILED.includes(x.conclusion ?? ""))) {
          j.status = "queued";
          j.conclusion = null;
        }
        return json(201, {});
      }
      if (method === "POST" && act === "cancel") {
        if (r.status === "completed") {
          return json(409, { message: "Cannot cancel a workflow run that is completed." });
        }
        r.status = "completed";
        r.conclusion = "cancelled";
        for (const j of r.jobs.filter((x) => x.status !== "completed")) {
          j.status = "completed";
          j.conclusion = "cancelled";
        }
        return json(202, {});
      }
    }
    m = on("POST", /^\/issues\/(\d+)\/comments$/);
    if (m) {
      if (!find(m[1])) return notFound();
      const cm = { id: nextCommentId++, issue: Number(m[1]), body: String(body.body ?? "") };
      state.comments.push(cm);
      return json(201, comment(cm, api));
    }
    m = /^\/issues\/comments\/(\d+)$/.exec(rest);
    if (m) {
      const cm = state.comments.find((x) => x.id === Number(m?.[1]));
      if (!cm) return notFound();
      if (method === "PATCH") cm.body = String(body.body ?? "");
      if (method === "GET" || method === "PATCH") return json(200, comment(cm, api));
    }
    return notFound();
  }

  const comment = (
    cm: { id: number; issue: number; body: string; user?: { id: number; login: string } },
    api: string,
  ) => ({
    id: cm.id,
    body: cm.body,
    user: cm.user ?? { id: 1, login: "mock-user" },
    issue_url: `${api}/issues/${cm.issue}`,
  });

  const deploymentJson = (d: MockDeployment) => ({
    id: d.id,
    sha: d.sha,
    ref: d.ref,
    task: "deploy",
    environment: d.environment,
    created_at: d.createdAt,
    updated_at: d.statuses.at(-1)?.createdAt ?? d.createdAt,
  });

  const runJson = (r: Run, repo: MockRepo) => ({
    id: r.id,
    run_number: r.number,
    status: r.status,
    conclusion: r.conclusion,
    head_branch: r.branch,
    head_sha: r.sha,
    html_url: `${repo.html_url}/actions/runs/${r.id}`,
    display_title: r.title,
    event: r.event,
    path: r.path,
  });
  // A job that has not started has a `started_at` all the same (as GitHub's queued jobs are believed to); the
  // adapter must not show it as a start.
  const jobJson = (j: Job, r: Run, repo: MockRepo) => ({
    id: j.id,
    run_id: r.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    html_url: `${repo.html_url}/actions/runs/${r.id}/job/${j.id}`,
    started_at: "2026-01-01T00:00:00Z",
    completed_at: j.status === "completed" ? "2026-01-01T00:01:05Z" : null,
  });

  /** One page of a list, with GitHub's `Link: rel="next"` header while more remain. */
  function page(url: URL, all: unknown[], key?: string) {
    const per = Math.min(Number(url.searchParams.get("per_page") ?? 30) || 30, maxPerPage);
    const n = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
    const slice = all.slice((n - 1) * per, n * per);
    const headers: Record<string, string> = {};
    if (n * per < all.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(n + 1));
      next.searchParams.set("per_page", String(per));
      headers.link = `<${next}>; rel="next"`;
    }
    return json(200, key ? { total_count: all.length, [key]: slice } : slice, headers);
  }

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    inject: (i) => injections.push({ ...i, left: i.times }),
    addRepo(owner, name, over = {}) {
      const { files, ...fields } = over;
      const repo = {
        id: nextRepoId++,
        name,
        full_name: `${owner}/${name}`,
        private: false,
        default_branch: "main",
        html_url: `https://github.example/${owner}/${name}`,
        archived: false,
        visibility: "public",
        ...fields,
      };
      repos.push(repo);
      const git = new MockGit();
      git.seed(repo.default_branch, files ?? { "README.md": `# ${name}\n` });
      gits.set(repo.full_name, git);
      return repo;
    },
    addTag(owner, name, tag, ref) {
      const git = gits.get(`${owner}/${name}`);
      const sha = git?.resolve(ref);
      if (!git || !sha) throw new Error(`no ${ref} in ${owner}/${name}`);
      git.tags.set(tag, sha);
    },
    mergePull(owner, name, number) {
      const p = pulls.get(`${owner}/${name}`)?.list.find((x) => x.number === number);
      if (!p) throw new Error(`no pull request ${number} in ${owner}/${name}`);
      p.state = "closed";
      p.mergedAt = "2026-01-01T00:00:00Z";
    },
    setMergeState(owner, name, number, state) {
      const p = pulls.get(`${owner}/${name}`)?.list.find((x) => x.number === number);
      if (!p) throw new Error(`no pull request ${number} in ${owner}/${name}`);
      p.mergeState = state;
    },
    addRun(owner, name, seed = {}) {
      const full = `${owner}/${name}`;
      const git = gits.get(full);
      if (!git) throw new Error(`no repository ${full}`);
      const list = runsOf(full);
      const run = newRun(list, git, seed);
      list.push(run);
      return { id: run.id, number: run.number };
    },
    setRun(owner, name, id, to) {
      const r = runsOf(`${owner}/${name}`).find((x) => x.id === id);
      if (!r) throw new Error(`no run ${id} in ${owner}/${name}`);
      if (to.status !== undefined) r.status = to.status;
      if (to.conclusion !== undefined) r.conclusion = to.conclusion;
    },
    setJob(owner, name, runId, job, to) {
      const r = runsOf(`${owner}/${name}`).find((x) => x.id === runId);
      if (!r) throw new Error(`no run ${runId} in ${owner}/${name}`);
      let j = r.jobs.find((x) => x.name === job);
      if (!j) {
        j = { id: nextJobId++, name: job, status: "queued", conclusion: null };
        r.jobs.push(j);
      }
      if (to.status !== undefined) j.status = to.status;
      if (to.conclusion !== undefined) j.conclusion = to.conclusion;
    },
    addDeployment(owner, name, seed) {
      const full = `${owner}/${name}`;
      const git = gits.get(full);
      if (!git) throw new Error(`no repository ${full}`);
      const ref = seed.ref ?? "main";
      const createdAt = stamp();
      const d: MockDeployment = {
        id: nextDeploymentId++,
        environment: seed.environment,
        ref,
        sha: seed.sha ?? git.resolve(ref) ?? "0".repeat(40),
        createdAt,
        statuses: [],
      };
      if (seed.state)
        d.statuses.push({ id: nextStatusId++, state: seed.state, logUrl: null, createdAt });
      deployments.set(full, [...(deployments.get(full) ?? []), d]);
      return { id: d.id };
    },
    setDeployment(owner, name, id, state, logUrl) {
      const d = (deployments.get(`${owner}/${name}`) ?? []).find((x) => x.id === id);
      if (!d) throw new Error(`no deployment ${id} in ${owner}/${name}`);
      d.statuses.push({ id: nextStatusId++, state, logUrl: logUrl ?? null, createdAt: stamp() });
    },
    addReview(owner, name, number, review) {
      const full = `${owner}/${name}`;
      const pull = pulls.get(full)?.list.find((p) => p.number === number);
      const git = gits.get(full);
      if (!pull || !git) throw new Error(`no pull request ${number} in ${full}`);
      let user = accounts.find((a) => a.login === review.login);
      if (!user) {
        user = { id: nextAccountId++, login: review.login, type: "User" };
        accounts.push(user);
      }
      const held = reviews.get(full) ?? [];
      held.push({
        pull: number,
        user: { id: user.id, login: user.login },
        state: review.state,
        // GitHub records the commit the review was made on: the head at that time
        commit: review.commit ?? git.branches.get(pull.head) ?? pull.headSha,
      });
      reviews.set(full, held);
    },
    protectBranch(owner, name, branch, over) {
      const full = `${owner}/${name}`;
      const held = protections.get(full) ?? new Map();
      held.set(branch, over.approvals);
      protections.set(full, held);
    },
    addRuleset(owner, name, branch, over) {
      const full = `${owner}/${name}`;
      const held = rulesets.get(full) ?? new Map();
      held.set(branch, over.approvals);
      rulesets.set(full, held);
    },
    addEnvironment(owner, name, environment, rules = []) {
      const full = `${owner}/${name}`;
      const held = environments.get(full) ?? new Map();
      held.set(environment, rules);
      environments.set(full, held);
    },
    actions(where) {
      const hold = holdOf(whereKey(where));
      const items = (table: Map<string, Held>) =>
        Object.fromEntries(
          [...table].map(([n, h]) => [
            n,
            {
              value: h.value,
              updatedAt: h.updatedAt,
              ...(h.visibility ? { visibility: h.visibility } : {}),
            },
          ]),
        );
      return { secrets: items(hold.secrets), variables: items(hold.variables) };
    },
    addComment(owner, name, number, login, body) {
      const state = pulls.get(`${owner}/${name}`);
      if (!state?.list.some((p) => p.number === number)) throw new Error("no such pull request");
      let a = accounts.find((x) => x.login === login && x.type === "User");
      if (!a) {
        a = { id: nextAccountId++, login, type: "User" };
        accounts.push(a);
      }
      const cm = {
        id: nextCommentId++,
        issue: number,
        body,
        user: { id: a.id, login: a.login },
      };
      state.comments.push(cm);
      return cm.id;
    },
    comments: (owner, name, number) =>
      (pulls.get(`${owner}/${name}`)?.comments ?? [])
        .filter((c) => c.issue === number)
        .map((c) => ({ id: c.id, login: c.user?.login ?? "mock-user", body: c.body })),
    addUser(login) {
      const a: Account = { id: nextAccountId++, login, type: "User" };
      accounts.push(a);
      return { id: a.id, login };
    },
    addOrg(login) {
      const a: Account = { id: nextAccountId++, login, type: "Organization" };
      accounts.push(a);
      return { id: a.id, login };
    },
    addCollaborator(owner, name, login, role, permission) {
      const full = `${owner}/${name}`;
      const held = collaborators.get(full) ?? new Map();
      held.set(login, { role, permission: permission ?? LEGACY[role] ?? "read" });
      collaborators.set(full, held);
    },
    addOrgMember(org, login, role, state = "active") {
      const held = orgMembers.get(org) ?? new Map();
      held.set(login, { role, state });
      orgMembers.set(org, held);
    },
    grant(login, challenge) {
      const code = `code_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      codes.set(code, { login, challenge });
      return code;
    },
    issuedTokens: () => [...userTokens.keys()],
    stop: () => void server.stop(true),
  };
}
