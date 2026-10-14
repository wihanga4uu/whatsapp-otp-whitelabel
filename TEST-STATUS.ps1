$p=Split-Path -Parent $MyInvocation.MyCommand.Path
$line=Get-Content (Join-Path $p '.env') | Where-Object {$_ -match '^API_KEY='} | Select-Object -First 1
$key=$line.Substring(8)
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/status' -Headers @{'x-api-key'=$key} | Format-List
