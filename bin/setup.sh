#!/usr/bin/env bash
# Builds the local test bed in Docker: WordPress, MCP Adapter, the example
# plugin, four users with different roles, three drafts and two application
# passwords. Everything lives in this folder's Docker project; it never touches
# a site outside Docker.
#
# Options (environment variables):
#   WP_VERSION       WordPress image tag (default 7.1.3)
#   PHP_VERSION      PHP version of the WordPress and WP-CLI images (default 8.3)
#   ADAPTER_VERSION  MCP Adapter release: 0.6.1, 0.6.2 or 0.7.1 (default 0.6.2)
#   WP_PORT          port on 127.0.0.1 (default 8089)
#   MCP_LAB_RESET    set to "yes" to rebuild a test bed that is already installed
set -euo pipefail
cd "$(dirname "$0")/.."

WP_PORT="${WP_PORT:-8089}"
ADAPTER_VERSION="${ADAPTER_VERSION:-0.6.2}"
SITE_URL="http://localhost:${WP_PORT}"

# SHA-256 of each release ZIP, as published on the adapter's GitHub release page.
case "$ADAPTER_VERSION" in
  0.6.1) ADAPTER_SHA256=1c3cd47c32e99b4e7d8690a44a7890256e92a8b96f61776cbe1894e5483cf676 ;;
  0.6.2) ADAPTER_SHA256=fe6b12d1fe30334299dc1944fca04b12147f6c75a87cf5cc15bc598b150adf1c ;;
  0.7.1) ADAPTER_SHA256=c8bc28f83d3c39beffa2add4f6becc0b1ae54097df433697d1dbe6520a80d769 ;;
  *)
    echo "Unsupported ADAPTER_VERSION '${ADAPTER_VERSION}'. Use 0.6.1, 0.6.2 or 0.7.1." >&2
    exit 1
    ;;
esac
ADAPTER_ZIP="vendor-plugins/mcp-adapter-${ADAPTER_VERSION}.zip"

case "$WP_PORT" in
  '' | *[!0-9]*) echo "WP_PORT must be a number, got '${WP_PORT}'." >&2; exit 1 ;;
esac

for tool in docker curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing tool: ${tool}." >&2; exit 1; }
done
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required (docker compose)." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start it and run this script again." >&2; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

echo "WARNING: this builds a disposable WordPress in Docker (project mcp-least-privilege, 127.0.0.1:${WP_PORT}) with local test users. Run it on a development machine only." >&2

# A test bed that already exists is only rebuilt when you say so, because the rebuild
# deletes its users, posts and pages.
if [ -z "$(docker compose ps -q wordpress 2>/dev/null)" ]; then
  if (exec 3<>"/dev/tcp/127.0.0.1/${WP_PORT}") 2>/dev/null; then
    echo "Port ${WP_PORT} on 127.0.0.1 is already in use. Free it, or set WP_PORT to another port." >&2
    exit 1
  fi
fi

mkdir -p vendor-plugins .state
if [ ! -f "$ADAPTER_ZIP" ]; then
  curl -fsSL -o "$ADAPTER_ZIP" \
    "https://github.com/WordPress/mcp-adapter/releases/download/v${ADAPTER_VERSION}/mcp-adapter.zip"
fi
if [ "$(sha256_of "$ADAPTER_ZIP")" != "$ADAPTER_SHA256" ]; then
  echo "Checksum mismatch for ${ADAPTER_ZIP}; deleting it. Run the script again, or compare it with the release page." >&2
  rm -f "$ADAPTER_ZIP"
  exit 1
fi

docker compose up -d --wait db wordpress
docker compose up -d cli

wp() { docker compose exec -T cli wp "$@"; }

for _ in $(seq 1 60); do
  docker compose exec -T cli test -f /var/www/html/wp-config.php && break
  sleep 1
done

if wp core is-installed 2>/dev/null; then
  if [ "${MCP_LAB_RESET:-}" != "yes" ]; then
    echo "A test bed is already installed here. Rebuilding it deletes its users, posts and pages." >&2
    echo "Run again with MCP_LAB_RESET=yes to rebuild it, or start fresh with: docker compose down -v" >&2
    exit 1
  fi
else
  wp core install --url="$SITE_URL" --title="MCP least privilege" \
    --admin_user=admin --admin_password=admin-local-only \
    --admin_email=admin@example.test --skip-email
fi
wp rewrite structure '/%postname%/' --quiet

wp plugin install "/vendor-plugins/mcp-adapter-${ADAPTER_VERSION}.zip" --force --activate --quiet
wp plugin activate ilogr-draft-abilities --quiet
# Remove the temporary filter check A02 installs, in case an earlier run was interrupted.
docker compose exec -T cli rm -f wp-content/mu-plugins/check-rogue-permission-filter.php

# Users: one per role that matters to the tests. Recreated on every run.
for login in agent-editor agent-author agent-subscriber other-author; do
  if wp user get "$login" --field=ID >/dev/null 2>&1; then
    wp user delete "$login" --yes --reassign=1 --quiet
  fi
done
wp user create agent-editor     agent-editor@example.test     --role=editor     --user_pass=local-only-1 --quiet
wp user create agent-author     agent-author@example.test     --role=author     --user_pass=local-only-2 --quiet
wp user create agent-subscriber agent-subscriber@example.test --role=subscriber --user_pass=local-only-3 --quiet
wp user create other-author     other-author@example.test     --role=author     --user_pass=local-only-4 --quiet

# Remove every post and page, including the bin ("any" excludes trashed posts),
# then create three known drafts, one published post and one draft page.
for status in any trash; do
  existing=$(wp post list --post_type=post,page --post_status="$status" --format=ids)
  if [ -n "$existing" ]; then
    # shellcheck disable=SC2086
    wp post delete $existing --force --quiet
  fi
done
wp post create --post_type=post --post_status=draft --post_author="$(wp user get other-author --field=ID)" \
  --post_title="Spring menu launch" --post_excerpt="Original excerpt" --porcelain > .state/draft-other-author.id
wp post create --post_type=post --post_status=draft --post_author="$(wp user get agent-author --field=ID)" \
  --post_title="Supplier interview notes" --post_excerpt="Original excerpt" --porcelain > .state/draft-agent-author.id
wp post create --post_type=post --post_status=draft --post_author=1 \
  --post_title="Stale placeholder" --post_excerpt="Original excerpt" --porcelain > .state/draft-admin.id
wp post create --post_type=post --post_status=publish --post_author=1 \
  --post_title="Opening hours" --post_excerpt="Published excerpt" --porcelain > .state/published.id
wp post create --post_type=page --post_status=draft --post_author=1 \
  --post_title="Draft page" --post_excerpt="Page excerpt" --porcelain > .state/draft-page.id

# Application passwords for the HTTP transport. Printed only into .state/.
for login in agent-editor agent-subscriber; do
  wp user application-password delete "$login" --all --quiet 2>/dev/null || true
  wp user application-password create "$login" mcp-test --porcelain > ".state/${login}.app-password"
done

printf '%s\n' "$SITE_URL" > .state/site-url
echo "Ready: $SITE_URL (WordPress $(wp core version), PHP $(wp eval 'echo PHP_VERSION;'), MCP Adapter $(wp plugin get mcp-adapter --field=version))"
