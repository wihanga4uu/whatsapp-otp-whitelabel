param([Parameter(Mandatory=$true)][string]$Phone)
$p=Split-Path -Parent $MyInvocation.MyCommand.Path
$line=Get-Content (Join-Path $p '.env') | Where-Object {$_ -match '^API_KEY='} | Select-Object -First 1
$key=$line.Substring(8)
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/request-otp' -Method POST -Headers @{'x-api-key'=$key} -ContentType 'application/json' -Body (@{phone=$Phone}|ConvertTo-Json) | Format-List
