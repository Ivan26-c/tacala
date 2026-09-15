param (
    [int]$Port = 3000
)

$currentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$scansDir = Join-Path $currentDir "escaneos"
$docsDir = Join-Path $currentDir "documentos_guardados"

if (-not (Test-Path $scansDir)) { New-Item -ItemType Directory -Path $scansDir | Out-Null }
if (-not (Test-Path $docsDir)) { New-Item -ItemType Directory -Path $docsDir | Out-Null }

$mimeTypes = @{
    ".html" = "text/html; charset=UTF-8"
    ".css"  = "text/css"
    ".js"   = "application/javascript"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".pdf"  = "application/pdf"
    ".json" = "application/json"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")

try {
    $listener.Start()
} catch {
    Write-Host "[ERROR] No se pudo iniciar el servidor en el puerto $Port. $_" -ForegroundColor Red
    exit
}

Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host "  TACALA PDF Studio (Servidor Nativo Windows)          " -ForegroundColor Green
Write-Host "  URL: http://localhost:$Port/                          " -ForegroundColor Yellow
Write-Host "=======================================================" -ForegroundColor Cyan

Start-Process "http://localhost:$Port/"

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $req = $context.Request
    $res = $context.Response

    $res.Headers.Add("Access-Control-Allow-Origin", "*")
    $res.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    $res.Headers.Add("Access-Control-Allow-Headers", "Content-Type, x-filename")

    if ($req.HttpMethod -eq "OPTIONS") {
        $res.StatusCode = 204
        $res.Close()
        continue
    }

    $rawPath = $req.Url.AbsolutePath
    if ($rawPath -eq "/") { $rawPath = "/index.html" }

    # ---------------------------------------------------------
    # API: Probar Conexión con HP
    # ---------------------------------------------------------
    if ($rawPath -eq "/api/scanner/test" -and $req.HttpMethod -eq "POST") {
        $reader = New-Object System.IO.StreamReader($req.InputStream)
        $body = $reader.ReadToEnd()
        $json = $body | ConvertFrom-Json
        $ip = $json.ip.Trim()

        try {
            $testUrl = "http://$ip/eSCL/ScannerCapabilities"
            $testReq = [System.Net.WebRequest]::Create($testUrl)
            $testReq.Timeout = 6000
            $testRes = $testReq.GetResponse()
            $testRes.Close()

            $resJson = @{ success = $true; ip = $ip; port = 80; hasAdf = $true; hasPlaten = $true } | ConvertTo-Json
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($resJson)
            $res.ContentType = "application/json"
            $res.OutputStream.Write($buffer, 0, $buffer.Length)
        } catch {
            $errJson = @{ success = $false; error = "No se pudo conectar con la HP en $ip. Verifica que este encendida y conectada a la red." } | ConvertTo-Json
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($errJson)
            $res.StatusCode = 400
            $res.ContentType = "application/json"
            $res.OutputStream.Write($buffer, 0, $buffer.Length)
        }
        $res.Close()
        continue
    }

    # ---------------------------------------------------------
    # API: Escaneo por Red HP (eSCL con soporte completo Dúplex)
    # ---------------------------------------------------------
    if ($rawPath -eq "/api/scanner/scan" -and $req.HttpMethod -eq "POST") {
        $reader = New-Object System.IO.StreamReader($req.InputStream)
        $body = $reader.ReadToEnd()
        $params = $body | ConvertFrom-Json

        $ip = $params.ip.Trim()
        $isDuplex = [bool]$params.duplex
        
        # Si es doble cara, debe usar el alimentador (Feeder) obligatoriamente
        $source = if ($isDuplex) { "Feeder" } elseif ($params.source) { $params.source } else { "Feeder" }
        $color = if ($params.colorMode) { $params.colorMode } else { "RGB24" }
        $resDpi = if ($params.resolution) { [int]$params.resolution } else { 300 }
        $duplexStr = if ($isDuplex) { "true" } else { "false" }

        $wPx = [math]::Round(8.27 * $resDpi)
        $hPx = [math]::Round(11.69 * $resDpi)

        # XML estandar eSCL con directiva de Duplex
        $xmlPayload = @"
<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.0</pwg:Version>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:Height>$hPx</pwg:Height>
      <pwg:Width>$wPx</pwg:Width>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <scan:InputSource>$source</scan:InputSource>
  <scan:ColorMode>$color</scan:ColorMode>
  <scan:XResolution>$resDpi</scan:XResolution>
  <scan:YResolution>$resDpi</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:Duplex>$duplexStr</scan:Duplex>
</scan:ScanSettings>
"@

        try {
            Write-Host "[Tacala] Iniciando escaneo en HP $ip (Origen: $source, Doble cara: $duplexStr)" -ForegroundColor Cyan
            
            $jobReq = [System.Net.HttpWebRequest]::Create("http://$ip/eSCL/ScanJobs")
            $jobReq.Method = "POST"
            $jobReq.ContentType = "text/xml"
            $jobReq.Timeout = 25000
            $postBytes = [System.Text.Encoding]::UTF8.GetBytes($xmlPayload)
            $jobReq.ContentLength = $postBytes.Length
            $postStream = $jobReq.GetRequestStream()
            $postStream.Write($postBytes, 0, $postBytes.Length)
            $postStream.Close()

            $jobRes = $jobReq.GetResponse()
            $location = $jobRes.Headers["Location"]
            $jobRes.Close()

            if (-not $location) { throw "No se recibio identificador del trabajo de escaneo de la impresora." }

            # Bucle para descargar TODAS las caras escaneadas (anverso, reverso y hojas siguientes del alimentador)
            $pagesList = @()
            $maxPages = if ($source -eq "Feeder") { 60 } else { 1 }
            $docBaseUrl = if ($location.StartsWith("http")) { "$location/NextDocument" } else { "http://$ip$location/NextDocument" }

            for ($pageNum = 1; $pageNum -le $maxPages; $pageNum++) {
                Start-Sleep -Milliseconds 1200
                try {
                    $docReq = [System.Net.HttpWebRequest]::Create($docBaseUrl)
                    $docReq.Timeout = 25000
                    $docRes = $docReq.GetResponse()

                    $statusCode = [int]$docRes.StatusCode
                    if ($statusCode -eq 200) {
                        $ms = New-Object System.IO.MemoryStream
                        $docRes.GetResponseStream().CopyTo($ms)
                        $imgBytes = $ms.ToArray()
                        $docRes.Close()

                        if ($imgBytes.Length -gt 0) {
                            $b64 = [Convert]::ToBase64String($imgBytes)
                            $dataUrl = "data:image/jpeg;base64,$b64"
                            $pagesList += @{ dataUrl = $dataUrl; type = "image"; filename = "hp4103_pagina_$pageNum.jpg" }
                            Write-Host "  -> Cara $pageNum escaneada y recibida ($([math]::Round($imgBytes.Length/1024)) KB)" -ForegroundColor Green
                        }

                        if ($source -eq "Platen") { break }
                    } else {
                        $docRes.Close()
                        break
                    }
                } catch [System.Net.WebException] {
                    $webEx = $_.Exception
                    if ($webEx.Response) {
                        $code = [int]$webEx.Response.StatusCode
                        # 404 Not Found o 503 indica que ya no hay mas caras o papel en el alimentador
                        if ($code -eq 404 -or $code -eq 503) {
                            break
                        }
                    }
                    if ($pageNum -gt 1) { break }
                    throw
                }
            }

            # Limpiar trabajo en la impresora
            try {
                $delUrl = if ($location.StartsWith("http")) { $location } else { "http://$ip$location" }
                $delReq = [System.Net.HttpWebRequest]::Create($delUrl)
                $delReq.Method = "DELETE"
                $delReq.Timeout = 5000
                $delRes = $delReq.GetResponse()
                $delRes.Close()
            } catch {}

            if ($pagesList.Count -eq 0) {
                throw "No se recibieron hojas. Revisa que las hojas esten colocadas en el alimentador o cristal."
            }

            Write-Host "[Tacala] Escaneo completado con exito. Total caras recibidas: $($pagesList.Count)" -ForegroundColor Green
            $resJson = @{ success = $true; pages = $pagesList } | ConvertTo-Json
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($resJson)
            $res.ContentType = "application/json"
            $res.OutputStream.Write($buffer, 0, $buffer.Length)
        } catch {
            Write-Host "[Tacala] Error durante el escaneo: $($_.Exception.Message)" -ForegroundColor Red
            $errJson = @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($errJson)
            $res.StatusCode = 500
            $res.ContentType = "application/json"
            $res.OutputStream.Write($buffer, 0, $buffer.Length)
        }
        $res.Close()
        continue
    }

    # ---------------------------------------------------------
    # API: Guardar Documento en Disco Local
    # ---------------------------------------------------------
    if ($rawPath -eq "/api/save-document" -and $req.HttpMethod -eq "POST") {
        try {
            $fn = $req.Headers["x-filename"]
            if (-not $fn) { $fn = "tacala_doc_$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).pdf" }
            $saveTarget = Join-Path $docsDir $fn
            $fs = [System.IO.File]::Create($saveTarget)
            $req.InputStream.CopyTo($fs)
            $fs.Close()

            $resJson = @{ success = $true; savedPath = $saveTarget; filename = $fn } | ConvertTo-Json
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($resJson)
            $res.ContentType = "application/json"
            $res.OutputStream.Write($buffer, 0, $buffer.Length)
        } catch {
            $errJson = @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($errJson)
            $res.StatusCode = 500
            $res.ContentType = "application/json"
            $res.OutputStream.Write($buffer, 0, $buffer.Length)
        }
        $res.Close()
        continue
    }

    # ---------------------------------------------------------
    # Servir Archivos Estáticos (HTML, CSS, JS)
    # ---------------------------------------------------------
    $safeRelPath = $rawPath.TrimStart("/").Replace("/", "\")
    $filePath = Join-Path $currentDir $safeRelPath

    if (Test-Path $filePath -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
        $contentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }

        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $res.ContentType = $contentType
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $res.StatusCode = 404
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }

    $res.Close()
}
