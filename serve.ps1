# Dev-only static file server for the app folder. Not part of the app.
# Usage:  powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8080] [-Lan]
# -Lan listens on all interfaces so the tablet can open http://<PC-IP>:<port>.
param([int]$Port = 8080, [switch]$Lan)

$root = $PSScriptRoot
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css'; '.js' = 'text/javascript'; '.mjs' = 'text/javascript'
  '.json' = 'application/json'; '.png' = 'image/png'; '.svg' = 'image/svg+xml'; '.jpg' = 'image/jpeg'
}
$addr = if ($Lan) { [Net.IPAddress]::Any } else { [Net.IPAddress]::Loopback }
$listener = New-Object Net.Sockets.TcpListener($addr, $Port)
try { $listener.Start() } catch {
  Write-Host "Port $Port is already in use (another serve.ps1 still running?). Use that one, or pick another: -Port 8081"
  exit 1
}
Write-Host "Serving $root at http://localhost:$Port/  (Ctrl+C to stop)"

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      # browsers open spare connections and may never send on them; don't wait forever
      $stream.ReadTimeout = 1000
      $reader = New-Object IO.StreamReader($stream)
      $line = $reader.ReadLine()
      if (-not $line) { continue }
      while ($reader.ReadLine()) { }  # skip headers
      $path = [Uri]::UnescapeDataString(($line -split ' ')[1].Split('?')[0])
      if ($path.EndsWith('/')) { $path += 'index.html' }
      $file = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
      if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
        $body = [IO.File]::ReadAllBytes($file)
        $type = $types[[IO.Path]::GetExtension($file).ToLower()]
        if (-not $type) { $type = 'application/octet-stream' }
        $head = "HTTP/1.1 200 OK`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
      } else {
        $body = [Text.Encoding]::UTF8.GetBytes('Not found')
        $head = "HTTP/1.1 404 Not Found`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
      }
      $h = [Text.Encoding]::ASCII.GetBytes($head)
      $stream.Write($h, 0, $h.Length); $stream.Write($body, 0, $body.Length)
      Write-Host "$($line)"
    } catch { } finally { $client.Close() }
  }
} finally { $listener.Stop() }
