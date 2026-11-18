# Stop or start the demo EC2 hosts (found by the Project tag) without deleting them.
param(
  [Parameter(Mandatory)][ValidateSet('stop', 'start', 'status')][string]$Action,
  [string]$AwsProfile = 'roitraining',
  [string]$Region = 'us-east-1'
)
# Native tools (aws, cdk) write progress to stderr; PowerShell 5.1 would treat that as a
# terminating error under 'Stop'. Failures are detected via $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'

$ids = aws ec2 describe-instances --profile $AwsProfile --region $Region `
  --filters 'Name=tag:Project,Values=notification-demo' 'Name=instance-state-name,Values=pending,running,stopping,stopped' `
  --query 'Reservations[].Instances[].InstanceId' --output text
if ($LASTEXITCODE -ne 0) { throw 'describe-instances failed' }
$ids = @($ids -split '\s+' | Where-Object { $_ })
if ($ids.Count -eq 0) { Write-Host 'No demo instances found.'; exit 0 }

switch ($Action) {
  'stop'  { aws ec2 stop-instances --instance-ids $ids --profile $AwsProfile --region $Region --query 'StoppingInstances[].[InstanceId,CurrentState.Name]' --output table }
  'start' { aws ec2 start-instances --instance-ids $ids --profile $AwsProfile --region $Region --query 'StartingInstances[].[InstanceId,CurrentState.Name]' --output table }
  'status' {
    aws ec2 describe-instances --instance-ids $ids --profile $AwsProfile --region $Region `
      --query 'Reservations[].Instances[].[InstanceId,Tags[?Key==`Name`]|[0].Value,State.Name]' --output table
  }
}
