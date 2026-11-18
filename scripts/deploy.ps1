# Bootstrap the account/region if needed, then deploy the stack.
param(
  [string]$AwsProfile = 'roitraining',
  [string]$Region = 'us-east-1'
)
# Native tools (aws, cdk) write progress to stderr; PowerShell 5.1 would treat that as a
# terminating error under 'Stop'. Failures are detected via $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot)

$account = aws sts get-caller-identity --profile $AwsProfile --query Account --output text
if ($LASTEXITCODE -ne 0) { throw "Could not authenticate with profile '$AwsProfile'." }
Write-Host "Deploying to account $account ($Region) with profile '$AwsProfile'" -ForegroundColor Cyan

aws cloudformation describe-stacks --stack-name CDKToolkit --profile $AwsProfile --region $Region --output text *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'CDK bootstrap stack not found; bootstrapping...' -ForegroundColor Yellow
  npx cdk bootstrap "aws://$account/$Region" --profile $AwsProfile
  if ($LASTEXITCODE -ne 0) { throw 'cdk bootstrap failed' }
}

npx cdk deploy --all --profile $AwsProfile --require-approval never --outputs-file cdk-outputs.json
if ($LASTEXITCODE -ne 0) { throw 'cdk deploy failed' }

Write-Host "`nOutputs saved to cdk-outputs.json" -ForegroundColor Green
Write-Host 'Next: click the SES verification link sent to the notification address (one time).'
