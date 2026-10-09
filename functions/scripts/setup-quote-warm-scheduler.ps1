# Keeps the quote dashboard's hot Cloud Functions warm so buttons on the
# Netlify dashboard (innovative-quotes.netlify.app) respond without cold starts.
#
# One Cloud Scheduler job pings each endpoint every 5 minutes during the
# working day (7am-8pm ET, Mon-Fri). Unauthenticated GETs return 401/400
# immediately, but that still boots the Cloud Run container — loading
# functions/index.js is the slow part of a cold start.
#
# Cost: Cloud Scheduler is ~$0.10/job/month after the 3 free jobs;
# the pinged requests themselves are fractions of a cent.

# "Continue" so the expected NOT_FOUND from `jobs describe` (stderr) does not
# abort the script under PowerShell 5 stderr-redirect semantics.
$ErrorActionPreference = "Continue"

$Project = "tai-invoice-automation"
$Location = "us-central1"
$Base = "https://us-central1-tai-invoice-automation.cloudfunctions.net"
# Weekdays 7:00-20:55 ET, every 5 minutes.
$Schedule = "*/5 7-20 * * 1-5"
$TimeZone = "America/New_York"

# Hot endpoints behind dashboard buttons (inbox, open quote, save/generate/
# approve, dismiss, re-rate, catalog). Each gets its own tiny job so one slow
# endpoint never blocks warming the others.
$Endpoints = @(
  "getQuoteDispatcherInbox",
  "getQuoteDispatcherProfile",
  "getQuoteDispatcherData",
  "getQuoteAccessorialCatalog",
  "saveQuoteSelections",
  "generateQuoteEmail",
  "rerunQuoteRates",
  "approveQuoteEmail",
  "dismissQuote",
  "completeQuote",
  "markQuoteForReview"
)

Write-Host "Project:  $Project"
Write-Host "Schedule: every 5 min, weekdays 7am-8:55pm ($Schedule, $TimeZone)"
Write-Host "Warming $($Endpoints.Count) endpoints..."
Write-Host ""

foreach ($name in $Endpoints) {
  $jobName = "warm-quote-" + ($name -creplace "([A-Z])", "-`$1").ToLower().Trim("-")
  $uri = "$Base/$name" + "?warm=1&tenantId=default"

  gcloud scheduler jobs describe $jobName `
    --project=$Project `
    --location=$Location `
    2>$null | Out-Null

  if ($LASTEXITCODE -eq 0) {
    Write-Host "Updating $jobName ..."
    gcloud scheduler jobs update http $jobName `
      --project=$Project `
      --location=$Location `
      --schedule=$Schedule `
      --time-zone=$TimeZone `
      --uri=$uri `
      --http-method=GET `
      --attempt-deadline=60s | Out-Null
  } else {
    Write-Host "Creating $jobName ..."
    gcloud scheduler jobs create http $jobName `
      --project=$Project `
      --location=$Location `
      --schedule=$Schedule `
      --time-zone=$TimeZone `
      --uri=$uri `
      --http-method=GET `
      --attempt-deadline=60s | Out-Null
  }
}

Write-Host ""
Write-Host "Done. Jobs:"
gcloud scheduler jobs list --project=$Project --location=$Location --filter="name~warm-quote" --format="table(name.basename(), schedule, state)"
