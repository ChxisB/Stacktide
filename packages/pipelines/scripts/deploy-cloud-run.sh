#!/bin/sh
# Deploys one build of the repository to the Cloud Run service a `service` blueprint created (ADR-0025).
# The forge's runner runs this; the platform never does. It reads only the ORCH_* names validated below, signs in
# with the runner's OIDC token (no key), and never prints a variable's value.
set -eu

fail() { echo "deploy-cloud-run: $1" >&2; exit 1; }
# every value reaches a shell, a JSON file or a command line: only a closed set of characters goes on
safe() { case "$2" in ""|-*|*[!A-Za-z0-9._/@:-]*) fail "$1 is missing or has a character it may not have" ;; esac; }
is_sha() { case "$1" in ""|*[!0-9a-f]*) return 1 ;; esac; [ "${#1}" -eq 40 ]; }
is_slug() { case "$1" in ""|*[!a-z0-9-]*|-*|*-|*--*) return 1 ;; esac; [ "${#1}" -le 63 ]; }
is_path() { case "$1" in ""|/*|-*|*..*|*[!A-Za-z0-9._/-]*) return 1 ;; esac; }

for name in ORCH_DEPLOY_ENV ORCH_DEPLOY_SHA ORCH_CLOUD_PROJECT ORCH_CLOUD_REGION ORCH_CLOUD_SERVICE \
  ORCH_CLOUD_REPOSITORY ORCH_CLOUD_PROVIDER ORCH_CLOUD_SERVICE_ACCOUNT; do
  eval "safe \$name \"\${$name:-}\""
done
[ -n "${ORCH_OIDC_TOKEN:-}" ] || fail "ORCH_OIDC_TOKEN is missing: the job must ask the forge for an identity token"
is_slug "$ORCH_DEPLOY_ENV" || fail "ORCH_DEPLOY_ENV is not an environment slug"
is_sha "$ORCH_DEPLOY_SHA" || fail "ORCH_DEPLOY_SHA is not a 40-character commit sha"
dockerfile="${ORCH_DOCKERFILE:-Dockerfile}"
context="${ORCH_CONTEXT:-.}"
is_path "$dockerfile" || fail "ORCH_DOCKERFILE is not a path inside the repository"
is_path "$context" || fail "ORCH_CONTEXT is not a path inside the repository"

# nothing the runner already holds is used: gcloud and docker keep their state here, and it is removed on exit
umask 077
work="$(mktemp -d "${TMPDIR:-/tmp}/orch-deploy.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export CLOUDSDK_CONFIG="$work/gcloud" DOCKER_CONFIG="$work/docker"
unset GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_AUTH_ACCESS_TOKEN CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE
printf %s "$ORCH_OIDC_TOKEN" > "$work/token"
# a credential configuration points at the token file; it holds no secret itself
printf '{"type":"external_account","audience":"//iam.googleapis.com/%s","subject_token_type":"urn:ietf:params:oauth:token-type:jwt","token_url":"https://sts.googleapis.com/v1/token","service_account_impersonation_url":"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/%s:generateAccessToken","credential_source":{"file":"%s"}}\n' \
  "$ORCH_CLOUD_PROVIDER" "$ORCH_CLOUD_SERVICE_ACCOUNT" "$work/token" > "$work/credentials.json"

gcloud auth login --cred-file="$work/credentials.json" --quiet > /dev/null 2>&1 || fail "could not sign in with the identity token"
registry="$ORCH_CLOUD_REGION-docker.pkg.dev"
image="$registry/$ORCH_CLOUD_PROJECT/$ORCH_CLOUD_REPOSITORY/app:$ORCH_DEPLOY_SHA"

# the commit's image is built once; a rollback, or a re-run, finds it there and deploys it as it is
if gcloud artifacts docker images describe "$image" --project "$ORCH_CLOUD_PROJECT" > /dev/null 2>&1; then
  echo "deploy-cloud-run: the image for $ORCH_DEPLOY_SHA is already in $ORCH_CLOUD_REPOSITORY"
else
  gcloud auth print-access-token | docker login --username oauth2accesstoken --password-stdin "$registry" > /dev/null 2>&1 \
    || fail "could not sign in to $registry"
  docker build --pull -f "$dockerfile" -t "$image" "$context"
  docker push "$image"
fi

# the service is Terraform's: only its image changes, and the command waits until the new revision is ready
gcloud run services update "$ORCH_CLOUD_SERVICE" --project "$ORCH_CLOUD_PROJECT" --region "$ORCH_CLOUD_REGION" \
  --image "$image" --quiet
url="$(gcloud run services describe "$ORCH_CLOUD_SERVICE" --project "$ORCH_CLOUD_PROJECT" --region "$ORCH_CLOUD_REGION" \
  --format 'value(status.url)')"
echo "deploy-cloud-run: $ORCH_CLOUD_SERVICE is running $ORCH_DEPLOY_SHA in $ORCH_DEPLOY_ENV at $url"
