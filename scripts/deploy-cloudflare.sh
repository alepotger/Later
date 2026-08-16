#!/usr/bin/env bash
#
# `pnpm deploy:cloudflare` — everything about a Cloudflare deploy that a machine can do.
#
# Creates the D1 database, writes its real ID into wrangler.jsonc, uploads your secrets from
# .env, applies migrations, deploys, sets PUBLIC_BASE_URL to the origin it just got, and then
# tells you the one URI you must paste into Google's console.
#
# What it deliberately does NOT do: `wrangler login` (a browser handshake with your Cloudflare
# account) and registering the redirect URI (a browser session with your Google account). Both
# belong to you and neither can be automated without your credentials.
#
# Safe to re-run. It skips anything already done rather than duplicating it.

set -euo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
step() { printf '\n%s→ %s%s\n' "$BOLD" "$1" "$OFF"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
skip() { printf '  %s·%s %s\n' "$DIM" "$OFF" "$DIM$1$OFF"; }
die()  { printf '\n%sERROR%s %s\n\n' "$RED" "$OFF" "$1" >&2; exit 1; }

cd "$(dirname "$0")/.."

DB_NAME="later-db"
SECRETS=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET INGEST_TOKEN TOKEN_ENCRYPTION_KEY SESSION_SECRET)

# ── Preconditions ────────────────────────────────────────────────────────────
[ -f .env ] || die "No .env found. Run 'pnpm setup' first, then fill in the two Google values."

# Read .env without sourcing it — a stray backtick or $( in a secret would otherwise execute.
env_value() {
  grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

step "Checking what you have"

for key in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  [ -n "$(env_value "$key")" ] || die "$key is empty in .env.
  It comes from a Google Cloud OAuth client in your own Google account — free, ~15
  minutes, no card. Exact click path: docs/ACTION-REQUIRED.md, Batch 1."
done
ok "Google OAuth client present"

for key in INGEST_TOKEN TOKEN_ENCRYPTION_KEY SESSION_SECRET; do
  [ -n "$(env_value "$key")" ] || die "$key is empty in .env. Run 'pnpm setup' to generate it."
done
ok "Generated secrets present"

if ! pnpm exec wrangler whoami >/dev/null 2>&1; then
  die "Not logged in to Cloudflare.

  Run this once, approve it in the browser it opens, then run this script again:

      ${BOLD}pnpm exec wrangler login${OFF}

  A Cloudflare account is free and needs no card: https://dash.cloudflare.com/sign-up"
fi
ok "Logged in to Cloudflare"

# ── D1 ───────────────────────────────────────────────────────────────────────
step "Database"

current_id=$(grep -o '"database_id": *"[^"]*"' wrangler.jsonc | head -n1 | cut -d'"' -f4)

if [ "$current_id" = "PLACEHOLDER_REPLACED_ON_DEPLOY" ] || [ -z "$current_id" ]; then
  created=$(pnpm exec wrangler d1 create "$DB_NAME" 2>&1 || true)
  # Either it was just created, or it already existed and we read the ID back out.
  db_id=$(printf '%s' "$created" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n1)

  if [ -z "$db_id" ]; then
    db_id=$(pnpm exec wrangler d1 info "$DB_NAME" --json 2>/dev/null \
      | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n1)
  fi
  [ -n "$db_id" ] || die "Could not create or find the D1 database '$DB_NAME'. Output was:
$created"

  # Only the placeholder is ever replaced, so re-running can never clobber a real ID.
  perl -0pi -e "s/\"database_id\": *\"PLACEHOLDER_REPLACED_ON_DEPLOY\"/\"database_id\": \"$db_id\"/" wrangler.jsonc
  ok "D1 database ready, id written into wrangler.jsonc"
  printf '  %scommit wrangler.jsonc so the id is not lost%s\n' "$DIM" "$OFF"
else
  skip "wrangler.jsonc already has a database_id"
fi

# ── Secrets ──────────────────────────────────────────────────────────────────
step "Secrets"

existing=$(pnpm exec wrangler secret list --format json 2>/dev/null || echo '[]')
for key in "${SECRETS[@]}"; do
  if printf '%s' "$existing" | grep -q "\"$key\""; then
    skip "$key already set (change it in the dashboard if you need to)"
    continue
  fi
  # Piped on stdin so the value never appears in the process list or your shell history.
  env_value "$key" | pnpm exec wrangler secret put "$key" >/dev/null
  ok "$key uploaded"
done

# ── Migrate, then deploy ─────────────────────────────────────────────────────
# This order is not cosmetic: a Worker live against a database missing a column fails every
# request, while a database ahead of the code is harmless.
step "Applying migrations"
pnpm exec wrangler d1 migrations apply "$DB_NAME" --remote
ok "Schema up to date"

step "Deploying"
deploy_output=$(pnpm exec wrangler deploy 2>&1 | tee /dev/stderr)
origin=$(printf '%s' "$deploy_output" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -n1)

if [ -z "$origin" ]; then
  printf '\n%sDeployed, but I could not read the URL out of that output.%s\n' "$YELLOW" "$OFF"
  printf 'Find it in the Cloudflare dashboard, then run:\n\n'
  printf '    pnpm exec wrangler deploy --var PUBLIC_BASE_URL:https://YOUR-URL\n\n'
  exit 0
fi

# ── PUBLIC_BASE_URL ──────────────────────────────────────────────────────────
# Redeploy with the origin baked in. It builds the OAuth redirect URI, and Google matches that
# byte for byte — so it has to be the real deployed hostname, not a guess.
step "Setting PUBLIC_BASE_URL to $origin"
pnpm exec wrangler deploy --var "PUBLIC_BASE_URL:$origin" >/dev/null
ok "Redeployed"

health=$(curl -fsS "$origin/healthz" 2>/dev/null || echo 'unreachable')
case "$health" in
  *'"ok":true'*) ok "$origin/healthz says ok" ;;
  *) printf '  %s!%s /healthz did not answer yet — Cloudflare can take a few seconds\n' "$YELLOW" "$OFF" ;;
esac

# ── The one thing left ───────────────────────────────────────────────────────
cat <<EOF

${GREEN}${BOLD}Deployed.${OFF}  ${BOLD}${origin}${OFF}

${YELLOW}${BOLD}One step left, and only you can do it.${OFF}

Google will refuse to authorise until this exact URI is registered on your OAuth
client. It matches byte for byte, so copy it rather than typing it:

    ${BOLD}${origin}/auth/callback${OFF}

  1. Open  ${BOLD}https://console.cloud.google.com/auth/clients${OFF}
  2. Click your OAuth client (the one from Batch 1)
  3. Under ${BOLD}"Authorized redirect URIs"${OFF} click ${BOLD}"+ ADD URI"${OFF}
  4. Paste the line above. No trailing slash.
  5. Click ${BOLD}"SAVE"${OFF}

Then, ${BOLD}before you give this URL to anyone else${OFF} — the first person to reach
/auth/start claims the instance, and every later attempt is refused:

    open ${BOLD}${origin}${OFF}  →  "Connect Google"  →  Advanced  →  Go to Later (unsafe)

Paste a YouTube link, press ${BOLD}Save it${OFF}, and check your ${BOLD}Later${OFF} playlist.

${DIM}Still in OAuth "Testing" status? Google deletes your refresh token in exactly 7
days. Publish at https://console.cloud.google.com/auth/overview, then:
    pnpm exec wrangler deploy --var GOOGLE_OAUTH_PUBLISHING_STATUS:production${OFF}

EOF
