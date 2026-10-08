#!/usr/bin/env bash
# Loads a dotenv file into the linked Vercel project's Production environment, without printing
# any value. Re-running replaces existing values.
#   bash scripts/vercel-env.sh .env.vercel
set -euo pipefail
FILE=${1:-.env.vercel}
[ -f "$FILE" ] || { echo "No $FILE"; exit 1; }
[ -f .vercel/project.json ] || { echo "Run 'npx vercel link' in this folder first."; exit 1; }

while IFS= read -r line || [ -n "$line" ]; do
  [[ -z "${line// }" || "$line" == \#* ]] && continue
  key=${line%%=*}
  val=${line#*=}
  val=${val#\'}; val=${val%\'}; val=${val#\"}; val=${val%\"}
  npx --yes vercel@latest env rm "$key" production --yes >/dev/null 2>&1 || true
  printf '%s' "$val" | npx --yes vercel@latest env add "$key" production >/dev/null
  echo "  set $key"
done < "$FILE"
echo "Done. Deploy with: npx vercel@latest --prod"
