# Remove every resource the stack created (tables, buckets, and log groups are set to DESTROY).
param(
  [string]$AwsProfile = 'roitraining',
  [string]$Region = 'us-east-1'
)
# Native tools (aws, cdk) write progress to stderr; PowerShell 5.1 would treat that as a
# terminating error under 'Stop'. Failures are detected via $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot)

npx cdk destroy --all --profile $AwsProfile --force
if ($LASTEXITCODE -ne 0) { throw 'cdk destroy failed' }
Write-Host 'Stack destroyed. (The CDKToolkit bootstrap stack is left in place; it costs nothing idle.)' -ForegroundColor Green
