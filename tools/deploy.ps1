$ErrorActionPreference = "Stop"

$Project = "macro-dreamer-406710"
$Region  = "europe-west1"
$Service = "gsec-tools"

gcloud run deploy $Service `
  --source . `
  --project $Project `
  --region $Region `
  --allow-unauthenticated `
  --memory 256Mi `
  --cpu 1 `
  --max-instances 10
