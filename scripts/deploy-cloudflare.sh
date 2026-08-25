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

# Everything in .env has to reach the Worker, or .env means one thing on Docker and something
# else on Cloudflare — which is how you end up with a deployment that shows a permanent
# "expires in 7 days" warning that is not true, or a Telegram bot that silently does not exist.
#
# `wrangler deploy` does not read .env at all. Values in wrangler.jsonc's `vars` block are
# defaults for the deploy-button path, where no .env exists; anything you set locally has to be
# passed explicitly, and `--var` merges over them rather than replacing the block.
#
# The universe of keys is read from .env.example rather than listed here, so adding a config
# option to that file carries it through automatically instead of quietly not.

# Uploaded with `wrangler secret put`: encrypted at rest, never shown in the dashboard.
# NOTIFY_WEBHOOK_URL is here because a Discord or Slack webhook URL is a credential.
SECRET_KEYS=(
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
  INGEST_TOKEN INGEST_HMAC_SECRET
  TOKEN_ENCRYPTION_KEY SESSION_SECRET
  GEMINI_API_KEY OPENAI_API_KEY INSTAGRAM_OEMBED_TOKEN
  TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET NOTIFY_WEBHOOK_URL
)

# Meaningless or dangerous on a Worker. DATABASE_PATH is a local file; the Worker uses the D1
# binding. USE_FIXTURES would deploy a service that reaches nothing and saves nothing.
LOCAL_ONLY_KEYS=(DATABASE_PATH USE_FIXTURES)

# Required before a deploy is worth attempting at all.
REQUIRED_KEYS=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET TOKEN_ENCRYPTION_KEY SESSION_SECRET)

contains() { local n="$1"; shift; for e in "$@"; do [ "$e" = "$n" ] && return 0; done; return 1; }

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

for key in TOKEN_ENCRYPTION_KEY SESSION_SECRET; do
  [ -n "$(env_value "$key")" ] || die "$key is empty in .env. Run 'pnpm setup' to generate it."
done
# INGEST_TOKEN is required in SOLO and ignored in MULTI, where each account mints its own.
if [ "$(env_value LATER_MODE)" != "MULTI" ] && [ -z "$(env_value INGEST_TOKEN)" ]; then
  die "INGEST_TOKEN is empty in .env. Run 'pnpm setup' to generate it."
fi
ok "Generated secrets present"

case "$(env_value USE_FIXTURES)" in
  true|TRUE|1|yes)
    die "USE_FIXTURES=true in .env.

  Deploying that would give you a public service that reaches nothing, saves nothing,
  and says everything worked. Set USE_FIXTURES=false and run this again." ;;
esac

# Anything in .env that .env.example does not define would be dropped without a word, so say so.
unknown=$(comm -23 \
  <(grep -oE '^[A-Z][A-Z0-9_]*=' .env | tr -d '=' | sort -u) \
  <(grep -oE '^[A-Z][A-Z0-9_]*=' .env.example | tr -d '=' | sort -u))
if [ -n "$unknown" ]; then
  printf '  %s!%s not defined in .env.example, so not sent to the Worker: %s\n' \
    "$YELLOW" "$OFF" "$(printf '%s' "$unknown" | tr '\n' ' ')"
fi

# `wrangler whoami` exits 0 even when nobody is logged in — it reports the fact on stdout and
# calls that a successful report. So the exit code alone is not the answer; without reading the
# output this check waves an unauthenticated run straight through to a confusing failure four
# steps later, in the middle of creating a database.
whoami_out=$(pnpm exec wrangler whoami 2>&1 || true)
if printf '%s' "$whoami_out" | grep -qi 'not authenticated\|you are not logged in'; then
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
for key in "${SECRET_KEYS[@]}"; do
  value=$(env_value "$key")
  [ -n "$value" ] || continue          # optional ones you have not configured
  if printf '%s' "$existing" | grep -q "\"$key\""; then
    skip "$key already set (delete it in the dashboard to replace it)"
    continue
  fi
  # Piped on stdin so the value never appears in the process list or your shell history.
  printf '%s' "$value" | pnpm exec wrangler secret put "$key" >/dev/null
  ok "$key uploaded"
done

# ── Variables ────────────────────────────────────────────────────────────────
# Everything in .env.example that is neither a secret nor local-only. PUBLIC_BASE_URL is held
# back: on the first deploy the origin is not known yet.
step "Variables"

VAR_ARGS=()
carried=0
while read -r key; do
  contains "$key" "${SECRET_KEYS[@]}" && continue
  contains "$key" "${LOCAL_ONLY_KEYS[@]}" && continue
  [ "$key" = "PUBLIC_BASE_URL" ] && continue
  value=$(env_value "$key")
  [ -n "$value" ] || continue
  VAR_ARGS+=(--var "$key:$value")
  carried=$((carried + 1))
done < <(grep -oE '^[A-Z][A-Z0-9_]*=' .env.example | tr -d '=' | sort -u)

ok "$carried carried from .env"
[ "$(env_value GOOGLE_OAUTH_PUBLISHING_STATUS)" = "production" ] &&
  ok "GOOGLE_OAUTH_PUBLISHING_STATUS=production — no 7-day expiry warning"

# ── Migrate, then deploy ─────────────────────────────────────────────────────
# This order is not cosmetic: a Worker live against a database missing a column fails every
# request, while a database ahead of the code is harmless.
step "Applying migrations"
pnpm exec wrangler d1 migrations apply "$DB_NAME" --remote
ok "Schema up to date"

# A PUBLIC_BASE_URL you set yourself wins — that is how a custom domain is configured, and
# overwriting it with the workers.dev origin would break the redirect URI you registered.
# A loopback value is the .env.example default rather than a choice, so it is ignored here.
configured_base=$(env_value PUBLIC_BASE_URL)
case "$configured_base" in
  ''|*localhost*|*127.0.0.1*) configured_base='' ;;
esac

step "Deploying"
if [ -n "$configured_base" ]; then
  ok "using PUBLIC_BASE_URL from .env: $configured_base"
  pnpm exec wrangler deploy "${VAR_ARGS[@]}" --var "PUBLIC_BASE_URL:$configured_base" 2>&1 | tee /dev/stderr
  origin="$configured_base"
else
  deploy_output=$(pnpm exec wrangler deploy "${VAR_ARGS[@]}" 2>&1 | tee /dev/stderr)
  origin=$(printf '%s' "$deploy_output" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -n1)

  if [ -z "$origin" ]; then
    printf '\n%sDeployed, but I could not read the URL out of that output.%s\n' "$YELLOW" "$OFF"
    printf 'Find it in the Cloudflare dashboard, then run:\n\n'
    printf '    pnpm deploy:cloudflare\n\n'
    printf 'after setting PUBLIC_BASE_URL in .env to that origin.\n\n'
    exit 0
  fi

  # Redeploy with the origin baked in. It builds the OAuth redirect URI, and Google matches
  # that byte for byte — so it has to be the real deployed hostname, not a guess. The vars are
  # passed again because each deploy is independent, not a patch on the last.
  step "Setting PUBLIC_BASE_URL to $origin"
  pnpm exec wrangler deploy "${VAR_ARGS[@]}" --var "PUBLIC_BASE_URL:$origin" >/dev/null
  ok "Redeployed"
fi

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

${DIM}Changed something in .env? Re-run this script — it re-sends every variable.
Editing a variable in the Cloudflare dashboard works too, but the next deploy
overwrites it, so .env is the copy worth keeping right.${OFF}

EOF
