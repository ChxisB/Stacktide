import { fetchJwks } from "@orch/gitlab";

/** The `iss` of every GitHub Actions identity token on github.com (an Enterprise Server has its own, unsupported). */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/** The keys that sign those tokens: public, and the same for every repository (FRG-23). */
export const githubKeys = (timeoutMs?: number) => ({
  jwks: () =>
    fetchJwks(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`, "GitHub GET /.well-known/jwks", timeoutMs),
});
