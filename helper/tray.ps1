# AI Center tray helper: notification-area icon, context menu, confirmation
# popup, sound playback and opening URLs. Driven by Node over stdin/stdout,
# one JSON object per line (see docs/superpowers/specs/2026-11-17-ai-center-design.md).
# It keeps no state worth saving: Node re-sends everything after "ready".
#
# Nothing but protocol JSON may ever reach stdout. In Windows PowerShell 5.1 with
# redirected stdout, Write-Host/Write-Warning/Write-Verbose output lands on stdout
# too, so none of those may be used.

$ErrorActionPreference = 'Continue'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$script:out = [Console]::Out

function Send-Event([hashtable]$Message) {
  try {
    $script:out.WriteLine((ConvertTo-Json -InputObject $Message -Compress))
    $script:out.Flush()
  } catch { }
}
function Send-Log([string]$Text) { Send-Event @{ event = 'log'; message = $Text } }
trap { Send-Log ('recovered: ' + $_.Exception.Message); continue }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class AiCenterPopup : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008; // NOACTIVATE | TOOLWINDOW | TOPMOST
      return cp;
    }
  }
}

public static class AiCenterStdin {
  public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
  private static volatile bool closed;
  public static bool Closed { get { return closed; } }
  public static void Start() {
    Thread reader = new Thread(() => {
      try {
        string line;
        while ((line = Console.In.ReadLine()) != null) Lines.Enqueue(line);
      } catch (Exception) { }
      closed = true;
    });
    reader.IsBackground = true;
    reader.Start();
  }
}

public static class AiCenterNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] public static extern bool DestroyIcon(IntPtr hIcon);
}
'@

[AiCenterNative]::SetProcessDPIAware() | Out-Null
[System.Windows.Forms.Application]::EnableVisualStyles()
$g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$script:scale = $g.DpiX / 96
$g.Dispose()
function S([double]$Value) { [int][Math]::Round($Value * $script:scale) }

# ---------------------------------------------------------------- icon

function Get-MarkColor {
  try {
    $light = (Get-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize' `
      -Name SystemUsesLightTheme -ErrorAction Stop).SystemUsesLightTheme
    if ($light -eq 1) { return [System.Drawing.Color]::FromArgb(255, 32, 38, 54) }
  } catch { }
  return [System.Drawing.Color]::FromArgb(255, 244, 246, 252)
}

function New-AppIcon([bool]$Muted) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $gr = [System.Drawing.Graphics]::FromImage($bmp)
  $gr.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $gr.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $mark = Get-MarkColor

  $pen = New-Object System.Drawing.Pen $mark, ([float]2.5)
  $gr.DrawRectangle($pen, 2, 2, 27, 27)
  $font = New-Object System.Drawing.Font 'Segoe UI', ([float]15), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush $mark
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $gr.DrawString('AI', $font, $brush, (New-Object System.Drawing.RectangleF 0, 1, 32, 32), $format)

  if ($Muted) {
    $red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 235, 86, 74))
    $gr.FillEllipse($red, 16, 16, 16, 16)
    $slash = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([float]2.5)
    $gr.DrawLine($slash, 19, 19, 29, 29)
    $red.Dispose(); $slash.Dispose()
  }
  $pen.Dispose(); $font.Dispose(); $brush.Dispose(); $format.Dispose(); $gr.Dispose()

  # FromHandle does not own the handle; a clone does, so the original can go now.
  $h = $bmp.GetHicon()
  try {
    $borrowed = [System.Drawing.Icon]::FromHandle($h)
    try { return $borrowed.Clone() } finally { $borrowed.Dispose() }
  } finally {
    [AiCenterNative]::DestroyIcon($h) | Out-Null
    $bmp.Dispose()
  }
}

# ---------------------------------------------------------------- tray + menu

$script:header = 'AI Center'
$script:soundEnabled = $true
$script:consoleUrl = $null
$script:icon = $null
$script:iconMuted = $null
$script:exitDeadline = $null
$script:stopping = $false

$notify = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$headerItem = New-Object System.Windows.Forms.ToolStripMenuItem 'AI Center'
$headerItem.Enabled = $false
$soundItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Zvuky'
$consoleItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Otevřít SkilledPlus4U MCP Console'
$consoleItem.Enabled = $false
$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Restartovat'
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Ukončit'
[void]$menu.Items.Add($headerItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($soundItem)
[void]$menu.Items.Add($consoleItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($restartItem)
[void]$menu.Items.Add($exitItem)
$notify.ContextMenuStrip = $menu

function Update-Tray {
  $muted = -not $script:soundEnabled
  if ($script:iconMuted -ne $muted) {
    $newIcon = New-AppIcon $muted
    $notify.Icon = $newIcon
    if ($script:icon) { $script:icon.Dispose() }
    $script:icon = $newIcon
    $script:iconMuted = $muted
  }
  $tip = if ($muted) { 'AI Center · zvuk vypnutý' } else { $script:header }
  $notify.Text = $tip.Substring(0, [Math]::Min(63, $tip.Length))
  $headerItem.Text = $script:header
  $soundItem.Checked = $script:soundEnabled
  $consoleItem.Enabled = [bool]$script:consoleUrl
}

function Open-Url([string]$Url) {
  $uri = $null
  if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri) -or ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https')) {
    Send-Log 'refused to open a non-http(s) URL'
    return
  }
  try { [void][System.Diagnostics.Process]::Start($uri.AbsoluteUri) }
  catch { Send-Log ('open failed: ' + $_.Exception.Message) }
}

$script:player = $null
function Start-Sound([string]$Path) {
  try {
    if ($script:player) { $script:player.Stop(); $script:player.Dispose() }
    $script:player = New-Object System.Media.SoundPlayer $Path
    $script:player.Play()
  } catch { Send-Log ('play failed: ' + $_.Exception.Message) }
}

$soundItem.Add_Click({ Send-Event @{ event = 'toggleSound' } })
$consoleItem.Add_Click({ if ($script:consoleUrl) { Open-Url $script:consoleUrl } })
$restartItem.Add_Click({ Send-Event @{ event = 'restart' } })
$exitItem.Add_Click({
  Send-Event @{ event = 'exit' }
  $script:exitDeadline = (Get-Date).AddSeconds(5)
})

# ---------------------------------------------------------------- popup

$script:popup = $null   # @{ Id; Form; Timer; Left; CountLabel; WaitLabel }

function Format-Waiting([int]$Count) {
  if ($Count -le 0) { return '' }
  if ($Count -le 4 -and $Count -ge 2) { return "+$Count čekají" }
  return "+$Count čeká"
}

function Close-Popup($Result) {
  $p = $script:popup
  if (-not $p) { return }
  $script:popup = $null
  $p.Timer.Stop(); $p.Timer.Dispose()
  $p.Form.Close()
  if ($Result) { Send-Event @{ event = 'confirm'; id = $p.Id; result = $Result } }
}

function Show-Popup($Id, [string]$Url, [int]$TimeoutSec, [int]$Waiting) {
  if ($script:popup) { Close-Popup 'no' }
  $uri = $null
  if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) {
    Send-Event @{ event = 'confirm'; id = $Id; result = 'no' }
    return
  }

  $bg      = [System.Drawing.Color]::FromArgb(32, 32, 36)
  $border  = [System.Drawing.Color]::FromArgb(70, 70, 82)
  $muted   = [System.Drawing.Color]::FromArgb(160, 160, 170)
  $accent  = [System.Drawing.Color]::FromArgb(0, 120, 212)
  $neutral = [System.Drawing.Color]::FromArgb(60, 60, 68)
  $white   = [System.Drawing.Color]::White
  $W = S 380; $H = S 150; $pad = S 16

  $form = New-Object AiCenterPopup
  $form.FormBorderStyle = 'None'
  $form.StartPosition = 'Manual'
  $form.ShowInTaskbar = $false
  $form.TopMost = $true
  $form.BackColor = $bg
  $form.ForeColor = $white
  $form.Font = New-Object System.Drawing.Font 'Segoe UI', 9
  $form.ClientSize = New-Object System.Drawing.Size $W, $H
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Location = New-Object System.Drawing.Point ($wa.Right - $W - (S 12)), ($wa.Bottom - $H - (S 12))
  $form.Tag = $border
  $form.Add_Paint({
    param($sender, $e)
    $p = New-Object System.Drawing.Pen $sender.Tag
    $e.Graphics.DrawRectangle($p, 0, 0, $sender.ClientSize.Width - 1, $sender.ClientSize.Height - 1)
    $p.Dispose()
  })

  $small = New-Object System.Drawing.Font 'Segoe UI', 8.5
  $newLabel = {
    param([string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height, $Font, $Color)
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $Text
    $l.Location = New-Object System.Drawing.Point $X, $Y
    $l.Size = New-Object System.Drawing.Size $Width, $Height
    $l.AutoEllipsis = $true
    $l.UseMnemonic = $false
    $l.ForeColor = $Color
    $l.Font = $Font
    $form.Controls.Add($l)
    $l
  }
  $waitWidth = S 90
  [void](& $newLabel 'AI Center · požadavek na otevření odkazu' $pad (S 12) ($W - 2 * $pad - $waitWidth) (S 18) $small $muted)
  $waitLabel = & $newLabel (Format-Waiting $Waiting) ($W - $pad - $waitWidth) (S 12) $waitWidth (S 18) $small $muted
  $waitLabel.TextAlign = [System.Drawing.ContentAlignment]::TopRight
  [void](& $newLabel $uri.Host $pad (S 32) ($W - 2 * $pad) (S 26) (New-Object System.Drawing.Font 'Segoe UI', 12, ([System.Drawing.FontStyle]::Bold)) $white)
  [void](& $newLabel $uri.AbsoluteUri $pad (S 60) ($W - 2 * $pad) (S 18) $small $muted)
  $countLabel = & $newLabel "Zamítne se samo za $TimeoutSec s" $pad ($H - $pad - (S 22)) (S 160) (S 18) (New-Object System.Drawing.Font 'Segoe UI', 8) $muted

  $newButton = {
    param([string]$Text, [int]$X, $Back)
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $Text
    $b.FlatStyle = 'Flat'
    $b.FlatAppearance.BorderSize = 0
    $b.BackColor = $Back
    $b.ForeColor = $white
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    $b.Size = New-Object System.Drawing.Size (S 92), (S 30)
    $b.Location = New-Object System.Drawing.Point $X, ($H - $pad - (S 30))
    $form.Controls.Add($b)
    $b
  }
  $openButton = & $newButton 'Otevřít' ($W - $pad - (S 92)) $accent
  $rejectButton = & $newButton 'Zamítnout' ($W - $pad - 2 * (S 92) - (S 8)) $neutral
  $openButton.Add_Click({ Close-Popup 'yes' })
  $rejectButton.Add_Click({ Close-Popup 'no' })

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 1000
  $timer.Add_Tick({
    $p = $script:popup
    if (-not $p) { return }
    $p.Left = $p.Left - 1
    if ($p.Left -le 0) { Close-Popup 'timeout' }
    else { $p.CountLabel.Text = "Zamítne se samo za $($p.Left) s" }
  })

  $script:popup = @{ Id = $Id; Form = $form; Timer = $timer; Left = $TimeoutSec; CountLabel = $countLabel; WaitLabel = $waitLabel }
  $form.Show()
  $timer.Start()
}

# ---------------------------------------------------------------- protocol

function Invoke-HelperCommand($Msg) {
  switch ([string]$Msg.cmd) {
    'init' {
      $script:header = [string]$Msg.header
      $script:soundEnabled = [bool]$Msg.soundEnabled
      Update-Tray
    }
    'soundEnabled' { $script:soundEnabled = [bool]$Msg.value; Update-Tray }
    'consoleUrl' {
      $script:consoleUrl = if ($Msg.url) { [string]$Msg.url } else { $null }
      Update-Tray
    }
    'play' { Start-Sound ([string]$Msg.path) }
    'confirm' { Show-Popup $Msg.id ([string]$Msg.url) ([int]$Msg.timeoutSec) ([int]$Msg.waiting) }
    'waiting' {
      if ($script:popup -and $script:popup.Id -eq $Msg.id) { $script:popup.WaitLabel.Text = Format-Waiting ([int]$Msg.count) }
    }
    'cancel' { if ($script:popup -and $script:popup.Id -eq $Msg.id) { Close-Popup $null } }
    'open' { Open-Url ([string]$Msg.url) }
    default { Send-Log ('unknown command: ' + $Msg.cmd) }
  }
}

function Stop-Helper {
  if ($script:stopping) { return }
  $script:stopping = $true
  $pump.Stop()
  Close-Popup $null
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

$pump = New-Object System.Windows.Forms.Timer
$pump.Interval = 50
$pump.Add_Tick({
  $line = $null
  while ([AiCenterStdin]::Lines.TryDequeue([ref]$line)) {
    if (-not $line.Trim()) { continue }
    try { Invoke-HelperCommand ($line | ConvertFrom-Json) }
    catch { Send-Log ('bad command: ' + $_.Exception.Message) }
  }
  if ([AiCenterStdin]::Closed -and [AiCenterStdin]::Lines.IsEmpty) { Stop-Helper }
  elseif ($script:exitDeadline -and (Get-Date) -gt $script:exitDeadline) { Stop-Helper }
})

Update-Tray
$notify.Visible = $true
[AiCenterStdin]::Start()
$pump.Start()
Send-Event @{ event = 'ready' }
[System.Windows.Forms.Application]::Run()
