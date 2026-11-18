# Windows event generator for the demo.
# Writes REAL Windows Event Log entries in bursts separated by quiet periods:
#   - Application log errors from a "PermitsPortal" source (event 1001)
#   - Security log failed logons (event 4625), by calling LogonUser with a nonexistent account
#   - System log warnings from a "PermitsSync" source (event 2001; visible in logs, no alert by default)
# The CloudWatch Agent ships these to the fleet log groups.
$ErrorActionPreference = 'Continue'

function Get-Setting($name, $default) {
  $v = [Environment]::GetEnvironmentVariable($name, 'Machine')
  if ([string]::IsNullOrEmpty($v)) { return $default } else { return $v }
}

$BurstLines    = [int](Get-Setting 'BURST_LINES' 8)
$BurstInterval = [int](Get-Setting 'BURST_INTERVAL' 5)
$QuietSeconds  = [int](Get-Setting 'QUIET_SECONDS' 900)

$AppSource = 'PermitsPortal'
$SysSource = 'PermitsSync'
if (-not [Diagnostics.EventLog]::SourceExists($AppSource)) { New-EventLog -LogName Application -Source $AppSource }
if (-not [Diagnostics.EventLog]::SourceExists($SysSource)) { New-EventLog -LogName System -Source $SysSource }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DemoLogon {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool LogonUser(string user, string domain, string password, int logonType, int provider, out IntPtr token);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
}
"@

$Errors = 'PermitService: database connection failed (SQLSTATE[HY000] [2002] Connection refused)',
          'PaymentGateway: request timed out after 30s',
          'PermitService: unhandled TypeError in PermitController::show()'

function AppError {
  Write-EventLog -LogName Application -Source $AppSource -EntryType Error -EventId 1001 -Message ($Errors | Get-Random)
}
function FailedLogon {
  # Nonexistent account: generates a real 4625 audit failure without risking a lockout.
  $user = "svc_scan$(Get-Random -Minimum 10 -Maximum 99)"
  $token = [IntPtr]::Zero
  if ([DemoLogon]::LogonUser($user, '.', 'not-the-password', 3, 0, [ref]$token)) { [DemoLogon]::CloseHandle($token) | Out-Null }
}
function SystemWarning {
  Write-EventLog -LogName System -Source $SysSource -EntryType Warning -EventId 2001 -Message 'Permit sync job exceeded its 30s timeout; retry scheduled.'
}

while ($true) {
  $kind = 'AppError', 'FailedLogon', 'SystemWarning' | Get-Random
  for ($i = 0; $i -lt $BurstLines; $i++) {
    & $kind
    Start-Sleep -Seconds $BurstInterval
  }
  Start-Sleep -Seconds $QuietSeconds
}
