#!/usr/bin/env bash
#
# add-pdf.sh — Add a new PDF to the review repo.
#
# Usage:
#   ./scripts/add-pdf.sh "Document Title" path/to/file.pdf
#
# What it does:
#   1. Generates a random doc_id (24 hex chars) and admin_token (48 hex chars)
#   2. Copies the PDF to docs/<doc_id>/document.pdf
#   3. Writes docs/<doc_id>/meta.json with title + tokens
#   4. Updates docs/manifest.json with the new entry
#   5. Registers the doc with the Cloudflare Worker (so admin tokens are enforceable)
#   6. Prints the review URL and admin URL
#
# Requires: bash, curl, openssl (for random bytes), jq, the WORKER_URL env var or config.js

set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 \"Document Title\" path/to/file.pdf"
    exit 1
fi

TITLE="$1"
PDF_PATH="$2"

if [[ ! -f "$PDF_PATH" ]]; then
    echo "Error: PDF not found: $PDF_PATH" >&2
    exit 1
fi

# Get Worker URL — env var takes precedence, else read from config.js
if [[ -n "${WORKER_URL:-}" ]]; then
    : # use env var
elif [[ -f config.js ]]; then
    WORKER_URL=$(grep -oE 'WORKER_URL[[:space:]]*[:=][[:space:]]*['\''"][^'\''"]*' config.js | sed -E 's/^[^'\''"]*[\x27"]//' | head -1)
fi
if [[ -z "${WORKER_URL:-}" || "$WORKER_URL" == "PASTE_WORKER_URL_HERE" ]]; then
    echo "Error: WORKER_URL not set. Either:"
    echo "  - export WORKER_URL=https://your-worker.workers.dev"
    echo "  - or set WORKER_URL in config.js"
    exit 1
fi
WORKER_URL="${WORKER_URL%/}"  # strip trailing slash

# Generate random IDs
DOC_ID=$(openssl rand -hex 12)         # 24 hex chars
ADMIN_TOKEN=$(openssl rand -hex 24)    # 48 hex chars
CREATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

DOC_DIR="docs/${DOC_ID}"
mkdir -p "$DOC_DIR"

# Copy PDF
cp "$PDF_PATH" "${DOC_DIR}/document.pdf"
FILE_SIZE=$(wc -c < "${DOC_DIR}/document.pdf" | tr -d ' ')

# Write meta.json
cat > "${DOC_DIR}/meta.json" <<EOF
{
  "doc_id": "${DOC_ID}",
  "title": "${TITLE//\"/\\\"}",
  "admin_token": "${ADMIN_TOKEN}",
  "created_at": "${CREATED_AT}",
  "file_size": ${FILE_SIZE}
}
EOF

# Update manifest.json — append to docs array
MANIFEST="docs/manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
    echo '{"docs": []}' > "$MANIFEST"
fi

# Use jq to append safely. Manifest entries do NOT include the admin_token.
jq --arg id "$DOC_ID" --arg title "$TITLE" --arg created "$CREATED_AT" \
   '.docs += [{"doc_id": $id, "title": $title, "created_at": $created}]' \
   "$MANIFEST" > "${MANIFEST}.tmp" && mv "${MANIFEST}.tmp" "$MANIFEST"

# Register doc with the Worker
echo "Registering document with Cloudflare Worker..."
HTTP_RESP=$(curl -sS -o /tmp/register-resp.json -w "%{http_code}" \
    -X POST "${WORKER_URL}/docs" \
    -H "Content-Type: application/json" \
    -d "{\"doc_id\":\"${DOC_ID}\",\"admin_token\":\"${ADMIN_TOKEN}\"}")

if [[ "$HTTP_RESP" != "200" ]]; then
    echo "Error: Worker rejected registration (HTTP $HTTP_RESP)" >&2
    cat /tmp/register-resp.json >&2
    echo "" >&2
    echo "Rolling back local changes..." >&2
    rm -rf "$DOC_DIR"
    # Restore previous manifest by removing the entry we just added
    jq --arg id "$DOC_ID" '.docs |= map(select(.doc_id != $id))' "$MANIFEST" > "${MANIFEST}.tmp" && mv "${MANIFEST}.tmp" "$MANIFEST"
    exit 1
fi

# Done — print URLs
# Try to read site URL from config.js, else use a placeholder
SITE_URL=""
if [[ -f config.js ]]; then
    SITE_URL=$(grep -oE 'SITE_URL[[:space:]]*[:=][[:space:]]*[\x27"][^\x27"]*' config.js | sed -E 's/^[^\x27"]*[\x27"]//' | head -1)
fi
if [[ -z "$SITE_URL" || "$SITE_URL" == "PASTE_SITE_URL_HERE" ]]; then
    SITE_URL="https://YOUR-USERNAME.github.io/YOUR-REPO"
fi
SITE_URL="${SITE_URL%/}"

echo ""
echo "Added: $TITLE"
echo "  Folder:  $DOC_DIR"
echo ""
echo "  Review URL:"
echo "    ${SITE_URL}/?doc=${DOC_ID}"
echo ""
echo "  Admin URL (keep private):"
echo "    ${SITE_URL}/?doc=${DOC_ID}&admin=${ADMIN_TOKEN}"
echo ""
echo "Now commit and push:"
echo "  git add docs/"
echo "  git commit -m \"Add ${TITLE}\""
echo "  git push"
