#!/usr/bin/env bash
set -euo pipefail

PROJECT="macro-dreamer-406710"
REGION="europe-west1"
SERVICE="gsec-tools"

gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --allow-unauthenticated \
  --memory 256Mi \
  --cpu 1 \
  --max-instances 10
