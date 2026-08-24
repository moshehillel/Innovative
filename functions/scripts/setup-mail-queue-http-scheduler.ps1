# Creates (or updates) a Cloud Scheduler HTTP job that drains gmailQueue.
# Run alongside setup-mail-inbox-http-scheduler.ps1 (discover every 20m, drain every 5m).

$ErrorActionPreference = "Stop"

$Project = "tai-invoice-automation"
$Location = "us-central1"
$JobName = "process-gmail-queue-http"
$Uri = "https://us-central1-tai-invoice-automation.cloudfunctions.net/processGmailQueue?tenantId=default"
$Schedule = "*/10 * * * 0-4"
$TimeZone = "America/Jamaica"

Write-Host "Project: $Project"
Write-Host "Job:     $JobName"
Write-Host "URI:     $Uri"
Write-Host "Schedule: every 10 minutes Sun-Thu ($Schedule, $TimeZone)"
Write-Host "Note: Friday/Saturday drain is skipped (America/Jamaica)."
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
    --attempt-deadline=1800s
} else {
  Write-Host "Creating new job..."
  gcloud scheduler jobs create http $JobName `
    --project=$Project `
    --location=$Location `
    --schedule=$Schedule `
    --time-zone=$TimeZone `
    --uri=$Uri `
    --http-method=GET `
    --attempt-deadline=1800s
}

Write-Host ""
Write-Host "Running job once now to verify..."
gcloud scheduler jobs run $JobName --project=$Project --location=$Location

Write-Host ""
Write-Host "Done. Check logs:"
Write-Host "  firebase functions:log --project $Project | Select-String processGmailQueue"
