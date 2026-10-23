# Single sign-on (SSO-1 to SSO-7)

An organization can let its people sign in with its own **OpenID Connect** provider (Keycloak, Okta, Entra ID, Google
Workspace and the like) instead of GitLab. The decisions are in [ADR-0016](adr/0016-external-identity-providers.md): OIDC
only, one provider per organization, a person is the provider's `sub` (never the email), and the roles they hold come
from rules you write, not from the provider's say-so.

> **Not yet checked against a real provider.** The tests run against a fake provider shaped like Keycloak. The first
> real sign-in is yours to try: set the provider up, press **Test**, turn it on, and sign in with a person who has a rule.

## Set up

1. **Turn sign-in on for the deployment.** Set `ORCH_SSO_REDIRECT_URI` to `https://<host>/auth/sso/callback`
   ([self-host](self-host.md)). Without it `/auth/sso/*` answers 503. The address must be `https` (plain `http` only for
   `localhost`, `127.0.0.1` or `[::1]`) and end in exactly `/auth/sso/callback`, or the API refuses to start.
2. **At the provider**, make a confidential client for the authorization-code flow and register that same address as its
   redirect URI. The platform asks for the scopes `openid email profile`, uses PKCE and a `nonce`, and expects RS256 tokens.
3. **In Settings → Single sign-on** (an organization **owner**; admins can read it), press **Set up** and give:
   * the **issuer**: the provider's own name for itself, the `iss` of its tokens, such as
     `https://idp.example.com/realms/acme`. Discovery is read from `<issuer>/.well-known/openid-configuration` and the
     document must name this issuer exactly. It cannot be changed afterwards (another issuer is another provider);
   * the **client ID** and **client secret**;
   * the **email domains** whose people may sign in (`acme.example`: the whole domain, any case, no wildcard);
   * the **role rules**.
4. Press **Test**: the platform fetches the discovery document and the key set and says what it found. A test never
   signs anyone in.
5. Press **Turn on**. It needs at least one domain and one rule, and a change cannot remove the last of either while it is on.
6. People sign in at `https://<host>/auth/sso/<organization-slug>/login`. A provider that is off, or none, answers 404.

The same is available over the API under `/organizations/{orgId}/sso` (`GET`, `PUT`, `PATCH`, `DELETE`, and `POST` to
`/test`, `/enable` and `/disable`); see [openapi.json](openapi.json).

## Role rules

A rule is `claim`, `value`, `role` (`viewer`, `member`, `admin`, `owner`). It matches when the sign-in's `id_token` has that
claim equal to the value, as a string, or as a list that holds the value, to the character: no pattern, no other case, no
number. **The highest role of all the rules that match wins, and no match is a refused sign-in**: the person is not made.
At most 50 rules, and one rule per claim and value (the same pair twice is refused, even with different roles).

```json
[
  { "claim": "groups", "value": "platform", "role": "admin" },
  { "claim": "groups", "value": "everyone", "role": "viewer" }
]
```

A claim that merely names a role (`role: "owner"`) grants nothing unless a rule says so. The role holds for the session
(12 hours) and is worked out again at every sign-in; a provider turned off gives no role at once. Nobody becomes a platform
admin through a provider. Where a person also holds a role through GitLab, the higher of the two applies in each
organization.

## Organizations and who holds a role

The **Organizations** page (`#/organizations`) shows the organization you are in. An **admin** can rename it and sees
**Members**: the people who hold a role through the provider right now, by username, with their role and when it ends.
A member's email and `sub` are not shown, and GitLab's own members are not listed (their roles come from the GitLab group).
An **owner** can delete the organization by typing its slug; it needs no projects, connections, sinks or provider left.
A **platform admin** (a GitLab user whose id is in `ORCH_PLATFORM_ADMIN_GITLAB_IDS`) can also create one. The GitLab group
is asked for in the page because it is how the organization gets its first owner: the API accepts none, but an
organization with no group has nobody who holds a role (only an owner can set a provider up), so an organization
that signs in only through a provider cannot be started yet. It is linked at creation and not afterwards, and it shows in the switcher once the creator holds a role in it. Over the API this is
`GET /organizations/{orgId}/members` (action `member.read`, org admin).

## Signing in, linking and giving up an identity

On the login page, type your organization's slug under **Or through your organization** and follow the link; it sends you
to the provider and back. If no rule gives you a role, you are refused and no account is made.

A person who already has an account (GitLab, or a provider) can **add another way in** from **Settings > Sign-in methods**:
type the other organization's slug and sign in there once. This is the only way an identity joins an account that exists:
it needs the session you are already signed in with, and that session must still be the one you hold when the provider
sends you back. **An identity is never matched by email or username**, so a provider that claims your address (verified or
not) gets a separate account, not yours. An identity another account already holds is refused (`409 identity_taken`).
The link also gives you the role its rules give, for one session length (12 hours), like any sign-in.
A person with a GitLab account keeps the username and name GitLab gave: a provider's claims never rename them.

**Link only a provider you trust: whoever runs it can sign in as you.** Once an identity is linked, a sign-in through that
provider is a sign-in to your account, with every role you hold, in every organization. So a link can only be started by
you: the web page asks the API (`POST /auth/sso/{slug}/link`, answering `{ "location" }`) and then goes there. It is a
POST, not a link to click, because another site can make your browser send a GET with your session but not a POST (the
session cookie is `SameSite=Lax`). A `?link=1` on the sign-in address is ignored.

**Sign-in methods** lists yours (the provider's organization and the email it last said, never its `sub`). You can unlink
a single sign-on identity while another way in is left; the role it gave goes with it at once. The last way in cannot be
removed (`409 last_identity`), and neither can the GitLab one (`409 identity_not_removable`): it is the account's own id.
Over the API this is `GET /auth/identities` and `DELETE /auth/identities/{id}`, for a browser session only: an API token
is refused (`401`). Both are audited (`identity.link`, `identity.unlink`).

**Signing out** (`POST /auth/logout`) ends the session. It does not end the roles a provider gave: those end on their own
when the session they came with would have (12 hours), and an API token made in the meantime keeps its role until it
expires or is revoked. There is no sign-out at the provider (RP-initiated logout is not built).

## The client secret

It goes in once, is stored encrypted under the master key (and is re-wrapped with the rest, see
[the keys runbook](runbook-keys-and-backup.md)), and is **never returned**: not by the API, not in the page, not in an audit
row or a log line. To replace it, send a new one; leave it out to keep the stored one. Without a master key the API
answers 503 to a change (turning a provider off still works).

## A second GitLab instance as the provider (FRG-6)

GitLab sign-in (`GITLAB_URL`) is **one** instance per deployment: `users.gitlab_id` is an id on that instance, and
GitLab-membership roles are read from it alone. Projects imported through a connection to **another** GitLab are
not asked about there, so user 100 on one instance can never hold the roles of user 100 on the other. People of a second
instance sign in through this page's SSO, with that GitLab as the OpenID Connect provider (issuer = its address,
an OAuth application on that GitLab with the `openid`, `profile` and `email` scopes):

* **Role rules use `groups_direct`**: the paths of the groups the person *directly* belongs to (for example claim
  `groups_direct`, value `acme/platform`). A person who is a member only of a *parent* group, or by inheritance, is not
  in it. GitLab's per-level claims (`https://gitlab.org/claims/groups/owner` and the like) and `groups` are returned by
  its userinfo endpoint only, which the platform does not read, so a rule cannot name a GitLab access level.
* **The email rule applies as for any provider.** GitLab's documentation says `email` and `email_verified` come only
  with the `email` scope and a public email address; a person with neither is refused.
* **The instance must be reachable by the address rule above** (`https`, a public address), so a GitLab on a private
  network cannot be a provider.
* **Their projects are linked through a connection** to that instance (the project then belongs to it, and a CI job
  token of that instance reaches it, see [ci.md](ci.md)). The organization's GitLab **group link** is the deployment's
  GitLab alone; there is no group link to a second instance, so its roles come from the rules above.
* Documented from GitLab's page (fetched 2026-10-22), **not run against a real instance**.

## The audit trail

Every change is an audit row in the organization (`sso_provider`): `sso.create`, `sso.update`, `sso.enable`, `sso.disable`,
`sso.delete` and `sso.test`, and the sign-in itself writes `auth.login` (with the role it gave) and `sso.membership.end`
when a person with no rule left loses a role. A row says what changed (`fields`), the issuer, client ID and domains, and
for the rules **how many and which roles they hand out**, not their claims or values. It says that a secret was changed, not
what it was.

## Limits and what to know

* **The issuer's address is judged like a notification sink's**: `https`, no credentials in the address, a public host,
  and every address its name resolves to is public. A private provider is refused (`422 issuer_refused`). It is judged when
  the provider is made, again by **Test**, and again at each sign-in, for every endpoint the discovery document names.
  *Shortcut*: the name is resolved once to check it and again to fetch it, so an answer that changes in between gets through.
* No redirect is followed, an answer is capped at 256 KB, and discovery is never cached (the keys are, per key-set address).
* **Test** sends a request, so it needs an owner. Admins read.
* **What the provider's token must carry.** `email` with `email_verified` exactly `true` (Entra ID leaves `email_verified` out
  unless you add it as an optional claim or a mapper), and the claims a rule reads must be **top-level** and a string or a
  list of strings: a nested claim (Keycloak's `realm_access.roles`) cannot be matched, so map groups to a top-level claim
  such as `groups` at the provider.
* Roles last as long as the session (12 hours) and logging out does not end them early: a person removed at the provider
  keeps their role until it ends.
* The organization's slug is how people find the sign-in page, and one key cache is kept per provider key-set address (never
  evicted: one small entry per provider an organization has ever had since the API started).
* Deleting a provider deletes its sign-ins and memberships. People who could only sign in through it keep their accounts
  (with their API tokens, which hold no role from the provider) and no way in; making the provider again makes them new
  people.
* GitLab cannot be unlinked, and an identity held by a separate single-sign-on-only account cannot be merged into a GitLab
  account: the person signs in with the one they want to keep and links the other from there.
* A person is linked to a provider by `(provider, sub)`. A new `sub` is a new person, even with a known email: nothing is
  linked automatically, and an organization cannot be made to require SSO (GitLab sign-in stays available).
