# Deploy "1 poll, 500,000+ stories" to its own Cloud Run service.
#
# Run from the tools/ directory, not from here:
#     cd ..; .\globe\deploy.ps1
#
# This deploys the same source tree as tools/deploy.ps1 but to a SEPARATE
# service, so the globe gets its own URL and is not touched by, or reachable
# from, the public toolkit. Nothing on gsec-tools links to it.
#
# --allow-unauthenticated means UNLISTED, not private: anyone with the link
# can open it. That matches every other GSEC tool. For genuinely private
# access, swap to --no-allow-unauthenticated and grant run.invoker per viewer,
# which then requires each tester to hold a Google identity and a token.

$Project = "macro-dreamer-406710"
$Region  = "europe-west1"
$Service = "gsec-globe"
$Account = "aaron.gardner@lrfoundation.org.uk"

gcloud run deploy $Service --source . `
  --project $Project --region $Region --account $Account `
  --allow-unauthenticated --memory 512Mi --cpu 1 --max-instances 4
