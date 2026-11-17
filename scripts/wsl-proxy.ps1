# Runs elevated via the "wsl-ai-center proxy" scheduled task (created by setup.ps1) from
# %ProgramFiles%\wsl-ai-center, with fixed arguments. Reads no config and no user-writable path.
# Forwards <Windows IP on the WSL network>:<port> -> 127.0.0.1:<port>.

param(
  [Parameter(Mandatory)][int]$Port,
  [Parameter(Mandatory)][string]$InterfaceAlias,
  [Parameter(Mandatory)][string]$LogFile
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$message) {
  "$((Get-Date).ToString('s', [Globalization.CultureInfo]::InvariantCulture)) $message" | Out-File -LiteralPath $LogFile -Append -Encoding utf8
}

function Remove-StaleProxies([int]$port) {
  # Old entries may point to a WSL IP from a previous boot
  $listing = netsh interface portproxy show v4tov4 2>&1
  if ($LASTEXITCODE -ne 0) { throw "netsh show failed: $($listing -join ' ')" }
  $listing |
    Select-String "^\s*(\S+)\s+$port\s" |
    ForEach-Object {
      $listenAddress = $_.Matches[0].Groups[1].Value
      $output = netsh interface portproxy delete v4tov4 listenaddress=$listenAddress listenport=$port 2>&1
      if ($LASTEXITCODE -ne 0) { throw "netsh delete failed for ${listenAddress}:${port}: $($output -join ' ')" }
    }
}

try {
  $port = $Port
  $alias = $InterfaceAlias

  # portproxy depends on the IP Helper service
  Start-Service -Name iphlpsvc

  $address = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $alias -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1
  if (-not $address) {
    Write-Log "ERROR: interface '$alias' not found. Is WSL running?"
    exit 1
  }
  $hostIp = $address.IPAddress

  Remove-StaleProxies $port
  $output = netsh interface portproxy add v4tov4 listenaddress=$hostIp listenport=$port `
    connectaddress=127.0.0.1 connectport=$port 2>&1
  if ($LASTEXITCODE -ne 0) { throw "netsh add failed: $($output -join ' ')" }
  Write-Log "OK: $($hostIp):$port -> 127.0.0.1:$port"
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
