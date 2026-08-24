# Creates (or updates) Cloud Scheduler HTTP job for the undelivered-shipment
# missing-delivery-date report. Twice weekly: Monday and Thursday 8:00 AM
# America/Cayman (same offset as Jamaica office time).

$ErrorActionPreference = "Stop"

$Project = "tai-invoice-automation"
$Location = "us-central1"
$JobName = "undelivered-shipments-weekly"
$Uri = "https://us-central1-tai-invoice-automation.cloudfunctions.net/reportUndeliveredShipments"
$Schedule = "0 8 * * 1,4"
$TimeZone = "America/Cayman"

Write-Host "Project:  $Project"
Write-Host "Job:      $JobName"
Write-Host "URI:      $Uri"
Write-Host "Schedule: Mon+Thu 8:00 AM ($Schedule, $TimeZone)"
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
    --attempt-deadline=180s `
    --description="undelivered-shipments twice-weekly Mon+Thu 8am Cayman"
} else {
  Write-Host "Creating new job..."
  gcloud scheduler jobs create http $JobName `
    --project=$Project `
    --location=$Location `
    --schedule=$Schedule `
    --time-zone=$TimeZone `
    --uri=$Uri `
    --http-method=GET `
    --attempt-deadline=180s `
    --description="undelivered-shipments twice-weekly Mon+Thu 8am Cayman"
}

Write-Host ""
Write-Host "Done. Next run:"
gcloud scheduler jobs describe $JobName `
  --project=$Project `
  --location=$Location `
  --format="value(scheduleTime)"
