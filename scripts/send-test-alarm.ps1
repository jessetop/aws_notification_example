# Publish a synthetic rules-engine alert to the alarm topic, so you can exercise the
# workflow (and the "View logs" links) immediately instead of waiting for a burst.
param(
  [ValidateSet('cve-probe', 'php-fatal', 'web-login-failures', 'windows-logon-failures', 'windows-errors')]
  [string]$Rule = 'cve-probe',
  [string]$HostId = '',
  [string]$AwsProfile = 'roitraining',
  [string]$Region = 'us-east-1'
)
# Native tools (aws, cdk) write progress to stderr; PowerShell 5.1 would treat that as a
# terminating error under 'Stop'. Failures are detected via $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'

$rules = @{
  'cve-probe'              = @{ Name = 'Exploit / CVE probes'; Severity = 'HIGH'; Host = 'ubuntu-01'; Types = @('apache-access'); Terms = @('php-cgi', 'allow_url_include', 'wp-login.php', '/.env', '../', 'phpunit'); Ids = @(); Level = $null
                                Sample = '127.0.0.1 - - [17/Nov/2026:20:00:01 +0000] "GET /cgi-bin/php-cgi?%ADd+allow_url_include%3D1 HTTP/1.1" 404 435 "-" "zgrab/0.x"' }
  'php-fatal'              = @{ Name = 'PHP fatal errors'; Severity = 'MEDIUM'; Host = 'ubuntu-01'; Types = @('php-error'); Terms = @('PHP Fatal error'); Ids = @(); Level = $null
                                Sample = 'PHP Fatal error:  Uncaught PDOException: SQLSTATE[HY000] [2002] Connection refused in /var/www/html/permits.php:20' }
  'web-login-failures'     = @{ Name = 'Failed web logins'; Severity = 'MEDIUM'; Host = 'ubuntu-01'; Types = @('php-error'); Terms = @('Failed login'); Ids = @(); Level = $null
                                Sample = 'WARN [auth] Failed login for user "admin"' }
  'windows-logon-failures' = @{ Name = 'Windows failed logons (4625)'; Severity = 'HIGH'; Host = 'win-01'; Types = @('windows-security'); Terms = @(); Ids = @(4625); Level = $null
                                Sample = '[Security] [INFORMATION] [4625] [Microsoft-Windows-Security-Auditing] [EC2AMAZ] [An account failed to log on.]' }
  'windows-errors'         = @{ Name = 'Windows application/system errors'; Severity = 'LOW'; Host = 'win-01'; Types = @('windows-application', 'windows-system'); Terms = @(); Ids = @(); Level = 'ERROR'
                                Sample = '[Application] [ERROR] [1001] [PermitsPortal] [EC2AMAZ] [PermitService: database connection failed]' }
}
$r = $rules[$Rule]
if (-not $HostId) { $HostId = $r.Host }

$topic = aws cloudformation describe-stacks --stack-name NotificationDemoStack --profile $AwsProfile --region $Region `
  --query "Stacks[0].Outputs[?OutputKey=='AlarmTopicArn'].OutputValue" --output text
if ($LASTEXITCODE -ne 0 -or -not $topic) { throw 'Could not find AlarmTopicArn. Is the stack deployed?' }

$now = (Get-Date).ToUniversalTime()
$alert = [ordered]@{
  source        = 'notification-demo.rules'
  ruleId        = $Rule
  ruleName      = $r.Name
  host          = $HostId
  severity      = $r.Severity
  count         = 6
  threshold     = 3
  windowMinutes = 5
  windowStart   = $now.AddMinutes(-3).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  detectedAt    = $now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  logTypes      = @($r.Types)
  terms         = @($r.Terms)
  eventIds      = @($r.Ids)
  samples       = @($r.Sample)
}
if ($r.Level) { $alert.minLevel = $r.Level }
$json = $alert | ConvertTo-Json -Compress -Depth 5

$file = New-TemporaryFile
[IO.File]::WriteAllText($file, $json, (New-Object Text.UTF8Encoding $false))
aws sns publish --topic-arn $topic --message "file://$file" --profile $AwsProfile --region $Region --query MessageId --output text
Remove-Item $file
Write-Host "Published test '$Rule' alert for $HostId. Watch the Step Functions console for a new execution." -ForegroundColor Green
