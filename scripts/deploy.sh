#!/usr/bin/env bash
# Terminal fallback. Browser deployment is documented in docs/runbook.md.
set -euo pipefail
cd "$(dirname "$0")/.."
wrangler=(./node_modules/.bin/wrangler)
if [[ ! -x "${wrangler[0]}" ]]; then
  echo 'Run npm ci first.' >&2
  exit 1
fi
"${wrangler[@]}" whoami
# Only populate missing binding IDs. Never replace provisioned resources.
# Stop on an unreadable config rather than treating a parser error as missing IDs.
binding_state="$(node --input-type=module -e 'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync("wrangler.jsonc","utf8")); if(c.name!=="fitbridge")throw Error("This fallback script targets only a Worker named fitbridge. Use Wrangler directly for a renamed instance."); console.log((c.d1_databases?.find(x=>x.binding==="DB")?.database_id ? "db" : "missing-db")+" "+(c.kv_namespaces?.find(x=>x.binding==="OAUTH_KV")?.id ? "kv" : "missing-kv"))')"
if [[ " $binding_state " == *' missing-db '* ]]; then
  "${wrangler[@]}" d1 create fitbridge --binding DB --update-config
fi
if [[ " $binding_state " == *' missing-kv '* ]]; then
  "${wrangler[@]}" kv namespace create OAUTH_KV --binding OAUTH_KV --update-config
fi
listing_errors="$(mktemp)"
trap 'rm -f "$listing_errors"' EXIT
if listing="$("${wrangler[@]}" secret list --format json 2>"$listing_errors")"; then
  stored="$(printf '%s' "$listing" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).map(s=>s.name).join(" "))')"
elif grep -Eq 'Worker "fitbridge" not found|does not exist.*10007|10007.*does not exist' "$listing_errors"; then
  stored=""
else
  cat "$listing_errors" >&2
  echo 'Secret listing failed. No secret was changed. Check authentication and try again.' >&2
  exit 1
fi
if [[ " $stored " == *' INGEST_SECRET '* && " $stored " != *' SETUP_CODE '* ]]; then
  echo 'This looks like a legacy instance. Follow docs/maintenance.md before switching authentication.' >&2
  exit 1
fi
if [[ " $stored " != *' SETUP_CODE '* ]]; then
  mkdir -p .secrets
  chmod 700 .secrets
  if [[ ! -s .secrets/setup-code ]]; then
    (umask 077 && openssl rand -hex 32 | tr -d '\n' > .secrets/setup-code)
  fi
  "${wrangler[@]}" secret put SETUP_CODE < .secrets/setup-code
fi
npm run deploy
printf '\nOpen the Worker URL above. Your private setup code is in .secrets/setup-code if this script generated it.\n'
