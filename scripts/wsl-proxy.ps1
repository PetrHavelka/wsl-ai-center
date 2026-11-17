# Runs elevated via the "wsl-ai-center proxy" scheduled task (created by setup.ps1).
# Forwards <Windows IP on the WSL network>:<port> -> 127.0.0.1:<port>.

$ErrorActionPreference = 'Stop'

$APP_ROOT = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).ProviderPath
$LOG_FILE = Join-Path $APP_ROOT 'wsl-proxy.log'

function Write-Log([string]$message) {
  "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') $message" | Out-File -FilePath $LOG_FILE -Append -Encoding utf8
}

function Get-ProxyConfig {
  $result = @{ Port = 7399; InterfaceAlias = 'vEthernet (WSL*)' }
  $file = Join-Path $APP_ROOT 'config.json'
  if (Test-Path $file) {
    $config = Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json
    if ($config.port) { $result.Port = [int]$config.port }
    if ($config.wslProxy -and $config.wslProxy.interfaceAlias) {
      $result.InterfaceAlias = [string]$config.wslProxy.interfaceAlias
    }
  }
  return $result
}

function Remove-StaleProxies([int]$port) {
  # Old entries may point to a WSL IP from a previous boot
  netsh interface portproxy show v4tov4 |
    Select-String "^\s*(\S+)\s+$port\s" |
    ForEach-Object {
      $listenAddress = $_.Matches[0].Groups[1].Value
      netsh interface portproxy delete v4tov4 listenaddress=$listenAddress listenport=$port | Out-Null
    }
}

try {
  $settings = Get-ProxyConfig
  $port = $settings.Port
  $alias = $settings.InterfaceAlias

  # portproxy depends on the IP Helper service
  Start-Service -Name iphlpsvc

  $address = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $alias -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $address) {
    Write-Log "ERROR: interface '$alias' not found. Is WSL running?"
    exit 1
  }
  $hostIp = $address.IPAddress

  Remove-StaleProxies $port
  netsh interface portproxy add v4tov4 listenaddress=$hostIp listenport=$port `
    connectaddress=127.0.0.1 connectport=$port | Out-Null
  Write-Log "OK: $($hostIp):$port -> 127.0.0.1:$port"
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
