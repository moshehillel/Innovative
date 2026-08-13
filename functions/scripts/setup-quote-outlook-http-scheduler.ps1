# Creates (or updates) a Cloud Scheduler HTTP job that hits syncQuoteOutlookInboxes.
# Cadence matches Jerry check-mail-inbox-http: every 20 minutes, America/New_York.
# Dashboard-triggered sync via getQuoteDispatcherInbox remains unchanged.

$ErrorActionPreference = "Stop"

$Project = "tai-invoice-automation"
$Location = "us-central1"
$JobName = "sync-quote-outlook-http"
$Uri = "https://us-central1-tai-invoice-automation.cloudfunctions.net/syncQuoteOutlookInboxes?tenantId=default"
$Schedule = "*/20 * * * *"
$TimeZone = "America/New_York"

Write-Host "Project: $Project"
Write-Host "Job:     $JobName"
Write-Host "URI:     $Uri"
Write-Host "Schedule: every 20 minutes ($Schedule, $TimeZone)"
Write-Host "Note: syncQuoteOutlookInboxes runs synchronously so processing finishes before HTTP returns."
Write-Host ""

$existing = gcloud scheduler jobs describe $JobName `
  --project=$Project `
  --location=$Location `
  2>$null

if ($LASTEXITCODE -eq 0) {
  Write-Host "Updating existing job..."
  gcloud scheduler jobs update http $JobName `
    --project=$Project `
    --location=$Location `
    --schedule=$Schedule `
    --time-zone=$TimeZone `
    --uri=$Uri `
    --http-method=GET `
    --attempt-deadline=540s
} else {
  Write-Host "Creating new job..."
  gcloud scheduler jobs create http $JobName `
    --project=$Project `
    --location=$Location `
    --schedule=$Schedule `
    --time-zone=$TimeZone `
    --uri=$Uri `
    --http-method=GET `
    --attempt-deadline=540s
}

Write-Host ""
Write-Host "Running job once now to verify..."
gcloud scheduler jobs run $JobName --project=$Project --location=$Location

Write-Host ""
Write-Host "Done. Check logs:"
Write-Host "  firebase functions:log --project $Project | Select-String syncQuoteOutlook"
