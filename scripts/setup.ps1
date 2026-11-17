# One-time setup for the WSL proxy (needs admin, self-elevates):
#   - firewall rule allowing WSL to reach the app port
#   - scheduled task "wsl-ai-center proxy" running scripts\wsl-proxy.ps1 with highest privileges
# Run with -Remove (setup.cmd -Remove) to undo everything.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$TASK_NAME = 'wsl-ai-center proxy'
$RULE_NAME = 'wsl-ai-center proxy'
$APP_ROOT = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).ProviderPath
$PROXY_SCRIPT = Join-Path $APP_ROOT 'scripts\wsl-proxy.ps1'

function Get-ProxyConfig {
  $result = @{ Port = 7399; InterfaceAlias = 'vEthernet (WSL*)'; WslSubnet = '172.16.0.0/12' }
  $file = Join-Path $APP_ROOT 'config.json'
  if (Test-Path $file) {
    $config = Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json
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

function Start-Elevated {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($Remove) { $arguments += '-Remove' }
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments
}

function Remove-FirewallRules {
  Get-NetFirewallRule -DisplayName $RULE_NAME -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}

function Remove-PortProxies([int]$port) {
  netsh interface portproxy show v4tov4 |
    Select-String "^\s*(\S+)\s+$port\s" |
    ForEach-Object {
      netsh interface portproxy delete v4tov4 listenaddress=$($_.Matches[0].Groups[1].Value) listenport=$port | Out-Null
    }
}

function Install-FirewallRule($settings) {
  Remove-FirewallRules
  New-NetFirewallRule -DisplayName $RULE_NAME -Direction Inbound -Protocol TCP `
    -LocalPort $settings.Port -RemoteAddress $settings.WslSubnet -Action Allow | Out-Null
}

function Install-ProxyTask {
  $userId = "$env:USERDOMAIN\$env:USERNAME"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PROXY_SCRIPT`""
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Principal $principal -Force | Out-Null
}

if ($APP_ROOT.StartsWith('\\')) {
  Write-Host "The app is in a network path ($APP_ROOT)." -ForegroundColor Red
  Write-Host 'Clone it to a Windows drive (e.g. C:\Tools\wsl-ai-center), not to \\wsl.localhost or another UNC path, and run setup.cmd from there.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

if (-not (Test-IsAdmin)) {
  Start-Elevated
  exit
}

try {
  $settings = Get-ProxyConfig
  if ($Remove) {
    Remove-FirewallRules
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
    Remove-PortProxies $settings.Port
    Write-Host "Removed firewall rule, scheduled task and port proxy on port $($settings.Port)." -ForegroundColor Green
  } else {
    if (-not (Test-Path $PROXY_SCRIPT)) { throw "Missing $PROXY_SCRIPT" }
    Install-FirewallRule $settings
    Install-ProxyTask
    Write-Host "Done. Firewall rule '$RULE_NAME' (TCP $($settings.Port) from $($settings.WslSubnet)) and scheduled task '$TASK_NAME' created." -ForegroundColor Green
    Write-Host 'Next step: run start.cmd (no admin needed).'
  }
} catch {
  Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
}

Read-Host 'Press Enter to close'
