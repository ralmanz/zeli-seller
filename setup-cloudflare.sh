#!/usr/bin/env bash
# One-time Cloudflare setup for zeli-seller.
# Run from project root: ./setup-cloudflare.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "==> 1/6 Check Cloudflare login"
if ! wrangler whoami >/dev/null 2>&1; then
  echo "Not logged in. Opening browser..."
  wrangler login
fi
wrangler whoami

echo ""
echo "==> 2/6 Create remote D1 database (updates wrangler.toml)"
if grep -q 'REPLACE_WITH_YOUR_D1_DATABASE_ID' wrangler.toml; then
  wrangler d1 create zeli-seller --update-config --location=wnam
else
  echo "database_id already set in wrangler.toml — skipping create"
fi

echo ""
echo "==> 3/6 Apply schema to remote D1"
wrangler d1 execute zeli-seller --remote --file=schema.sql

echo ""
echo "==> 4/6 Seed demo listing on remote D1"
wrangler d1 execute zeli-seller --remote --file=seed.sql

echo ""
echo "==> 5/6 Upload ANTHROPIC_API_KEY secret"
if [[ ! -f .dev.vars ]]; then
  echo "Missing .dev.vars — copy .dev.vars.example and add your API key first."
  exit 1
fi
# shellcheck disable=SC1091
source .dev.vars
if [[ -z "${ANTHROPIC_API_KEY:-}" || "${ANTHROPIC_API_KEY}" == sk-ant-your-key-here ]]; then
  echo "Set a real ANTHROPIC_API_KEY in .dev.vars before deploying."
  exit 1
fi
printf '%s' "$ANTHROPIC_API_KEY" | wrangler secret put ANTHROPIC_API_KEY

echo ""
echo "==> 6/6 Deploy worker"
wrangler deploy

echo ""
echo "Done. Your app URL:"
wrangler deployments list 2>/dev/null | head -5 || true
echo ""
echo "Open: https://zeli-seller.<your-subdomain>.workers.dev/?listing=listing-sf-demo"
echo "(Replace subdomain with the one shown after deploy.)"
