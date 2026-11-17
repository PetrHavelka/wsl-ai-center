# One-time setup for the WSL proxy (needs admin, self-elevates):
#   - firewall rule allowing WSL to reach the app port
#   - a copy of scripts\wsl-proxy.ps1 in %ProgramFiles%\wsl-ai-center (admin-only write access, so
#     nothing the user or WSL can modify runs elevated)
#   - scheduled task "wsl-ai-center proxy" running that copy with highest privileges
# Run with -Remove (setup.cmd -Remove) to undo everything.

param([switch]$Remove, [string]$ForUser)

$ErrorActionPreference = 'Stop'

$TASK_NAME = 'wsl-ai-center proxy'
$RULE_NAME = 'wsl-ai-center proxy'
$APP_ROOT = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).ProviderPath
$SOURCE_SCRIPT = Join-Path $APP_ROOT 'scripts\wsl-proxy.ps1'
$INSTALL_DIR = Join-Path $env:ProgramFiles 'wsl-ai-center'
$INSTALLED_SCRIPT = Join-Path $INSTALL_DIR 'wsl-proxy.ps1'
$INSTALLED_LOG = Join-Path $INSTALL_DIR 'wsl-proxy.log'
$NETSH = Join-Path $env:SystemRoot 'System32\netsh.exe'
$POWERSHELL_EXE = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$CURRENT_USER = "$env:USERDOMAIN\$env:USERNAME"

function Get-ProxyConfig {
  $result = @{ Port = 7399; InterfaceAlias = 'vEthernet (WSL*)'; WslSubnet = '172.16.0.0/12' }
  $file = Join-Path $APP_ROOT 'config.json'
  if (Test-Path -LiteralPath $file) {
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $file | ConvertFrom-Json
    if ($config.port) { $result.Port = [int]$config.port }
    if ($config.wslProxy) {
      if ($config.wslProxy.interfaceAlias) { $result.InterfaceAlias = [string]$config.wslProxy.interfaceAlias }
      if ($config.wslProxy.wslSubnet) { $result.WslSubnet = [string]$config.wslProxy.wslSubnet }
    }
  }
  return $result
}

function Test-IsAdmin {
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-NetworkDrive {
  try {
    return ([IO.DriveInfo]::new($APP_ROOT)).DriveType -eq 'Network'
  } catch {
    return $false
  }
}

function Start-Elevated {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
    '-ForUser', "`"$CURRENT_USER`"")
  if ($Remove) { $arguments += '-Remove' }
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments
}

function Remove-FirewallRules {
  Get-NetFirewallRule -DisplayName $RULE_NAME -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}

function Remove-PortProxies([int]$port) {
  $listing = & $NETSH interface portproxy show v4tov4 2>&1
  if ($LASTEXITCODE -ne 0) { throw "netsh show failed: $($listing -join ' ')" }
  $listing |
    Select-String "^\s*(\S+)\s+$port\s" |
    ForEach-Object {
      $listenAddress = $_.Matches[0].Groups[1].Value
      $output = & $NETSH interface portproxy delete v4tov4 listenaddress=$listenAddress listenport=$port 2>&1
      if ($LASTEXITCODE -ne 0) { throw "netsh delete failed for ${listenAddress}:${port}: $($output -join ' ')" }
    }
}

function Assert-ValidSettings($settings) {
  # Checked before anything is installed; the alias ends up in the task's command line
  if ($settings.InterfaceAlias -notmatch '^[\w ().*-]+$') {
    throw "wslProxy.interfaceAlias '$($settings.InterfaceAlias)' may only contain letters, digits, spaces and ( ) . * _ -"
  }
  if ($settings.Port -lt 1 -or $settings.Port -gt 65535) { throw "port $($settings.Port) is out of range" }
}

function Install-FirewallRule($settings) {
  Remove-FirewallRules
  New-NetFirewallRule -DisplayName $RULE_NAME -Direction Inbound -Protocol TCP `
    -LocalPort $settings.Port -RemoteAddress $settings.WslSubnet -Action Allow | Out-Null
}

function Install-ProxyScript {
  New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
  Copy-Item -LiteralPath $SOURCE_SCRIPT -Destination $INSTALLED_SCRIPT -Force
}

function Install-ProxyTask($settings) {
  # All values are fixed at setup time; the script in Program Files does not read config.json
  $argument = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$INSTALLED_SCRIPT`" " +
    "-Port $($settings.Port) -InterfaceAlias `"$($settings.InterfaceAlias)`" -LogFile `"$INSTALLED_LOG`""
  $action = New-ScheduledTaskAction -Execute $POWERSHELL_EXE -Argument $argument
  $principal = New-ScheduledTaskPrincipal -UserId $CURRENT_USER -LogonType Interactive -RunLevel Highest
  $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::FromMinutes(5))
  Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Principal $principal -Settings $taskSettings -Force | Out-Null
}

if ($APP_ROOT.StartsWith('\\') -or (Test-NetworkDrive)) {
  Write-Host "The app is in a network path ($APP_ROOT)." -ForegroundColor Red
  Write-Host 'Clone it to a Windows drive (e.g. C:\Tools\wsl-ai-center), not to \\wsl.localhost, another UNC path or a mapped network drive, and run setup.cmd from there.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

if (-not (Test-IsAdmin)) {
  try {
    Start-Elevated
  } catch {
    Write-Host "Could not start elevated (UAC cancelled?): $($_.Exception.Message)" -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
  }
  exit
}

# -ne is case-insensitive in PowerShell
if ($ForUser -and ($ForUser -ne $CURRENT_USER)) {
  Write-Host "Elevated as $CURRENT_USER, but setup was started by $ForUser." -ForegroundColor Red
  Write-Host 'Your own account must be a local administrator: confirm the UAC prompt, do not enter other credentials.' -ForegroundColor Red
  Write-Host 'Standard users should use WSL mirrored networking instead (no proxy and no setup needed).' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

try {
  $settings = Get-ProxyConfig
  if ($Remove) {
    Remove-FirewallRules
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
    Remove-PortProxies $settings.Port
    if (Test-Path -LiteralPath $INSTALL_DIR) { Remove-Item -LiteralPath $INSTALL_DIR -Recurse -Force }
    Write-Host "Removed firewall rule, scheduled task, installed script and port proxy on port $($settings.Port)." -ForegroundColor Green
  } else {
    if (-not (Test-Path -LiteralPath $SOURCE_SCRIPT)) { throw "Missing $SOURCE_SCRIPT" }
    Assert-ValidSettings $settings
    Install-FirewallRule $settings
    Install-ProxyScript
    Install-ProxyTask $settings
    Write-Host "Done. Firewall rule '$RULE_NAME' (TCP $($settings.Port) from $($settings.WslSubnet)) and scheduled task '$TASK_NAME' created." -ForegroundColor Green
    Write-Host "The elevated script is installed in $INSTALL_DIR (log: $INSTALLED_LOG). Run setup.cmd again after updating the app."
    Write-Host 'Next step: run start.cmd (no admin needed).'
  }
} catch {
  Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
}

Read-Host 'Press Enter to close'
