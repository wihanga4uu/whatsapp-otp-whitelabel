param(
  [Parameter(Mandatory=$true)]
  [string]$Phone,

  [Parameter(Mandatory=$true)]
  [string]$Message
)

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $project ".env"

if (-not (Test-Path $envFile)) {
    Write-Host ".env not found." -ForegroundColor Red
    exit 1
}

$apiLine = Get-Content $envFile | Where-Object { $_ -match '^API_KEY=' } | Select-Object -First 1
$apiKey = $apiLine.Substring(8)

$headers = @{ "x-api-key" = $apiKey }

$body = @{
  phone = $Phone
  message = $Message
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://127.0.0.1:3000/api/send-message" `
  -Method POST `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body | Format-List
