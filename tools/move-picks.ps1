<#
.SYNOPSIS
  Moves the picked RAWs of a shoot into its Picks folder, using the picks list Contact Sheet exported.

.DESCRIPTION
  Reads the newest *-picks.txt in <Folder>\Picks (or the list given with -List) and moves each listed
  RAW (ARW, RAF) from the shoot folder into Picks, together with its sidecars: DxO's .dop and any
  .xmp. Picked JPEGs are left alone, since the export already copied them into Picks.

  Without -Apply it only shows what it would do. It never overwrites: a file whose name is already
  in Picks is skipped and reported. Moving within one drive is instant and takes no extra space.
  -Undo moves the same files back.

.EXAMPLE
  .\move-picks.ps1 "F:\Photos\2026\JB Day Trip 18 Jul 2026\RX100"
  .\move-picks.ps1 "F:\Photos\2026\JB Day Trip 18 Jul 2026\RX100" -Apply
#>
param(
  [Parameter(Mandatory = $true)] [string] $Folder,
  [string] $List,
  [switch] $Apply,
  [switch] $Undo
)

$ErrorActionPreference = 'Stop'
$picks = Join-Path $Folder 'Picks'
if (-not (Test-Path -LiteralPath $picks -PathType Container)) { throw "No Picks folder in $Folder. Export from Contact Sheet first." }

if (-not $List) {
  $newest = Get-ChildItem -LiteralPath $picks -Filter '*-picks.txt' | Sort-Object LastWriteTime | Select-Object -Last 1
  if (-not $newest) { throw "No *-picks.txt in $picks. Export from Contact Sheet first." }
  $List = $newest.FullName
}
Write-Host "Picks list: $List"

$raws = Get-Content -LiteralPath $List | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '\.(arw|raf)$' }
if (-not $raws) { Write-Host 'No RAWs in the list.'; exit }

$from, $to = if ($Undo) { $picks, $Folder } else { $Folder, $picks }
$moved = 0; $skipped = @(); $missing = @()

foreach ($raw in $raws) {
  if (-not (Test-Path -LiteralPath (Join-Path $from $raw) -PathType Leaf)) { $missing += $raw; continue }
  # the RAW and its sidecars: DSC0465.ARW.dop (DxO), DSC0465.ARW.xmp (darktable), DSC0465.xmp
  $base = [IO.Path]::GetFileNameWithoutExtension($raw)
  $names = @($raw, "$raw.dop", "$raw.xmp", "$base.xmp") | Where-Object { Test-Path -LiteralPath (Join-Path $from $_) -PathType Leaf }
  $clash = $names | Where-Object { Test-Path -LiteralPath (Join-Path $to $_) }
  if ($clash) { $skipped += "$raw (already there: $($clash -join ', '))"; continue }
  foreach ($n in $names) {
    if ($Apply) { Move-Item -LiteralPath (Join-Path $from $n) -Destination (Join-Path $to $n) }
    else { Write-Host "  would move $n" }
  }
  $moved++
}

$verb = if ($Apply) { 'Moved' } else { 'Would move' }
$where = if ($Undo) { 'back to the shoot folder' } else { 'into Picks' }
Write-Host "$verb $moved RAWs (with their sidecars) $where."
if ($skipped) { Write-Host "Skipped, a file of that name is already there:"; $skipped | ForEach-Object { Write-Host "  $_" } }
if ($missing) { Write-Host "Not found in ${from}:"; $missing | ForEach-Object { Write-Host "  $_" } }
if (-not $Apply) { Write-Host 'Nothing was moved. Run again with -Apply to move them.' }
