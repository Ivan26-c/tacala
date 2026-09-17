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
            $testSr = New-Object System.IO.StreamReader($testRes.GetResponseStream())
            $capXml = $testSr.ReadToEnd()
            $testRes.Close()

            $model = "HP LaserJet MFP"
            if ($capXml -match "<[^>]*MakeAndModel[^>]*>([^<]+)<") {
                $model = $matches[1].Trim()
            }

            $hasDuplex = ($capXml -match "Duplex" -or $capXml -match "TwoSided" -or $capXml -match "AdfOption")
            $hasAdf = ($capXml -match "Adf" -or $capXml -match "Feeder")

            # Consultar estado de la bandeja ADF
            $adfState = "Unknown"
            try {
                $sReq = [System.Net.WebRequest]::Create("http://$ip/eSCL/ScannerStatus")
                $sReq.Timeout = 3000
                $sRes = $sReq.GetResponse()
                $sSr = New-Object System.IO.StreamReader($sRes.GetResponseStream())
                $sXml = $sSr.ReadToEnd()
                $sRes.Close()
                if ($sXml -match "<[^>]*AdfState[^>]*>([^<]+)<") {
                    $adfState = $matches[1].Trim()
                }
            } catch {}

            $resJson = @{
                success = $true
                ip = $ip
                port = 80
                model = $model
                hasAdf = $hasAdf
                hasPlaten = $true
                hasDuplex = $hasDuplex
                adfState = $adfState
            } | ConvertTo-Json

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
    # API: Diagnóstico Completo de Capacidades de Escaneo Duplex
    # ---------------------------------------------------------
    if ($rawPath -eq "/api/scanner/diagnose" -and $req.HttpMethod -eq "POST") {
        $reader = New-Object System.IO.StreamReader($req.InputStream)
        $body = $reader.ReadToEnd()
        $json = $body | ConvertFrom-Json
        $ip = $json.ip.Trim()

        try {
            $capUrl = "http://$ip/eSCL/ScannerCapabilities"
            $capReq = [System.Net.WebRequest]::Create($capUrl)
            $capReq.Timeout = 8000
            $capRes = $capReq.GetResponse()
            $capSr = New-Object System.IO.StreamReader($capRes.GetResponseStream())
            $capsXml = $capSr.ReadToEnd()
            $capRes.Close()

            $model = "HP Multifuncional"
            if ($capsXml -match "<[^>]*MakeAndModel[^>]*>([^<]+)<") {
                $model = $matches[1].Trim()
            }

            # Analizar tags de dúplex
            $xmlLower = $capsXml.ToLower()
            $hasDuplexTag = $xmlLower.Contains("duplex")
            $hasDuplexMode = $xmlLower.Contains("duplexmode")
            $hasTwoSided = $xmlLower.Contains("twosided")
            $hasAdfOption = $xmlLower.Contains("adfoption")
            $hasAdfOptions = $xmlLower.Contains("adfoptions")
            $hasDuplexSupported = $xmlLower.Contains("duplexsupported")
            $hasAdfDuplexCaps = $xmlLower.Contains("adfduplexinputcaps")

            $hasAdf = ($xmlLower.Contains("adf") -or $xmlLower.Contains("feeder"))
            $hasPlaten = $xmlLower.Contains("platen")

            # Extraer líneas relacionadas con duplex
            $rawDuplexLines = @()
            $lines = $capsXml -split "`r?`n"
            for ($i = 0; $i -lt $lines.Length; $i++) {
                $l = $lines[$i]
                $ll = $l.ToLower()
                if ($ll.Contains("duplex") -or $ll.Contains("adfoption") -or $ll.Contains("twosided")) {
                    $rawDuplexLines += @{ line = ($i + 1); content = $l.Trim() }
                }
            }

            # Extraer fuentes de entrada
            $inputSources = @()
            $matches = [regex]::Matches($capsXml, "<[^>]*InputSource[^>]*>[^<]*<\/[^>]*InputSource[^>]*>")
            foreach ($m in $matches) {
                $inputSources += $m.Value
            }

            # Consultar ScannerStatus
            $scannerStatusXml = ""
            $adfState = "Unknown"
            try {
                $sReq = [System.Net.WebRequest]::Create("http://$ip/eSCL/ScannerStatus")
                $sReq.Timeout = 4000
                $sRes = $sReq.GetResponse()
                $sSr = New-Object System.IO.StreamReader($sRes.GetResponseStream())
                $scannerStatusXml = $sSr.ReadToEnd()
                $sRes.Close()
                if ($scannerStatusXml -match "<[^>]*AdfState[^>]*>([^<]+)<") {
                    $adfState = $matches[1].Trim()
                }
            } catch {}

            $canDoDuplex = ($hasDuplexTag -or $hasTwoSided -or $hasAdfOption -or $hasAdfDuplexCaps)

            $diagnosis = @{
                ip = $ip
                model = $model
                adfState = $adfState
                duplexSupport = @{
                    hasDuplexTag = $hasDuplexTag
                    hasDuplexMode = $hasDuplexMode
                    hasTwoSided = $hasTwoSided
                    hasAdfOption = $hasAdfOption
                    hasAdfOptions = $hasAdfOptions
                    hasDuplexSupported = $hasDuplexSupported
                    hasAdfDuplexCaps = $hasAdfDuplexCaps
                    rawDuplexLines = $rawDuplexLines
                }
                adfInfo = @{
                    hasAdf = $hasAdf
                    hasPlaten = $hasPlaten
                    inputSources = $inputSources
                }
                summary = @{
                    canDoDuplex = $canDoDuplex
                    connectionPort = 80
                    connectionProtocol = "http"
                }
            }

            Write-Host "[Tacala] Diagnostico completado para HP $($ip) - Modelo '$model', Soporta Duplex: $canDoDuplex, ADF Sensor: $adfState" -ForegroundColor Cyan
            $resJson = @{ success = $true; diagnosis = $diagnosis } | ConvertTo-Json -Depth 6
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($resJson)
            $res.ContentType = "application/json"
            $res.OutputStream.Write($buffer, 0, $buffer.Length)
        } catch {
            Write-Host "[Tacala] Error en diagnostico: $($_.Exception.Message)" -ForegroundColor Red
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
    # API: Escaneo por Red HP (eSCL con soporte completo Dúplex)
    # ---------------------------------------------------------
    if ($rawPath -eq "/api/scanner/scan" -and $req.HttpMethod -eq "POST") {
        $reader = New-Object System.IO.StreamReader($req.InputStream)
        $body = $reader.ReadToEnd()
        $params = $body | ConvertFrom-Json

        $ip = $params.ip.Trim()
        $isDuplex = [bool]$params.duplex
        $reqSource = if ($params.source) { $params.source } else { "Feeder" }

        # Detectar que origen acepta la impresora (Adf o Feeder)
        $inputSource = "Adf"
        try {
            $capReq = [System.Net.HttpWebRequest]::Create("http://$ip/eSCL/ScannerCapabilities")
            $capReq.Timeout = 3000
            $capRes = $capReq.GetResponse()
            $capSr = New-Object System.IO.StreamReader($capRes.GetResponseStream())
            $capXml = $capSr.ReadToEnd()
            $capRes.Close()

            if ($capXml -match "<[^>]*InputSource[^>]*>Feeder<" -and -not ($capXml -match "<[^>]*InputSource[^>]*>Adf<")) {
                $inputSource = "Feeder"
            }
        } catch {}

        # Si el usuario eligio Platen (cristal) y NO es duplex:
        $actualSource = if ($reqSource -eq "Platen" -and -not $isDuplex) { "Platen" } else { $inputSource }
        $color = if ($params.colorMode) { $params.colorMode } else { "RGB24" }
        $resDpi = if ($params.resolution) { [int]$params.resolution } else { 300 }

        $wPx = [math]::Round(8.27 * $resDpi)
        $hPx = [math]::Round(11.69 * $resDpi)

        # XML estandar eSCL con todas las directivas requeridas para Duplex en HP
        $duplexXml = if ($isDuplex) { @"
  <scan:Duplex>true</scan:Duplex>
  <scan:DuplexMode>TwoSided</scan:DuplexMode>
  <scan:AdfOptions>
    <scan:AdfOption>Duplex</scan:AdfOption>
  </scan:AdfOptions>
"@ } else { @"
  <scan:Duplex>false</scan:Duplex>
  <scan:DuplexMode>OneSided</scan:DuplexMode>
"@ }

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
  <pwg:InputSource>$actualSource</pwg:InputSource>
  <scan:InputSource>$actualSource</scan:InputSource>
  <scan:ColorMode>$color</scan:ColorMode>
  <scan:XResolution>$resDpi</scan:XResolution>
  <scan:YResolution>$resDpi</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
$duplexXml
</scan:ScanSettings>
"@

        try {
            Write-Host "[Tacala] Iniciando escaneo en HP $ip (Origen: $actualSource, Doble cara: $isDuplex)" -ForegroundColor Cyan
            Write-Host "[Tacala] Enviando ScanSettings eSCL..." -ForegroundColor DarkGray
            
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

            # Bucle inteligente para descargar TODAS las caras escaneadas
            # En duplex, la impresora procesa ambas caras y responde 503 o espera entre caras.
            $pagesList = @()
            $maxPages = if ($actualSource -eq "Platen") { 1 } else { if ($isDuplex) { 100 } else { 50 } }
            $docBaseUrl = if ($location.StartsWith("http")) { "$location/NextDocument" } else { "http://$ip$location/NextDocument" }
            $jobStatusUrl = if ($location.StartsWith("http")) { $location } else { "http://$ip$location" }

            for ($pageNum = 1; $pageNum -le $maxPages; $pageNum++) {
                $gotPage = $false
                $retries = 0
                $maxRetriesForPage = if ($pageNum -eq 1) { 25 } elseif ($isDuplex -and ($pageNum % 2 -eq 0)) { 25 } else { 15 }
                $consecutive404 = 0

                while ($retries -lt $maxRetriesForPage) {
                    Start-Sleep -Milliseconds 1200
                    $retries++

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
                                $timestamp = (Get-Date).ToString("yyyyMMdd_HHmmss")
                                $filename = "hp4103_${timestamp}_cara$pageNum.jpg"
                                
                                # Guardar tambien en disco en la carpeta escaneos
                                $savePath = Join-Path $scansDir $filename
                                [System.IO.File]::WriteAllBytes($savePath, $imgBytes)

                                $pagesList += @{ dataUrl = $dataUrl; type = "image"; filename = $filename }
                                Write-Host "  -> Cara $pageNum escaneada y recibida ($([math]::Round($imgBytes.Length/1024)) KB)" -ForegroundColor Green
                                $gotPage = $true
                                $consecutive404 = 0
                                break
                            }
                        } else {
                            $docRes.Close()
                        }
                    } catch [System.Net.WebException] {
                        $webEx = $_.Exception
                        if ($webEx.Response) {
                            $code = [int]$webEx.Response.StatusCode
                            if ($code -eq 503) {
                                Write-Host "  [HP 4103] Procesando cara $pageNum (impresora ocupada - 503)... esperando ($retries/$maxRetriesForPage)" -ForegroundColor Yellow
                                continue
                            } elseif ($code -eq 404) {
                                $consecutive404++
                                Write-Host "  [HP 4103] Cara $pageNum esperando... (404 intento $consecutive404)" -ForegroundColor DarkGray

                                if ($pagesList.Count -gt 0) {
                                    # Si es duplex y acabamos de recibir una cara impar, estamos esperando la segunda cara de la misma hoja:
                                    $waitingForBackSide = ($isDuplex -and ($pagesList.Count % 2 -ne 0))
                                    $threshold404 = if ($waitingForBackSide) { 10 } else { 3 }

                                    if ($consecutive404 -ge $threshold404) {
                                        # Consultar el estado del trabajo para estar 100% seguros
                                        $jobDone = $true
                                        try {
                                            $jReq = [System.Net.HttpWebRequest]::Create($jobStatusUrl)
                                            $jReq.Timeout = 3000
                                            $jRes = $jReq.GetResponse()
                                            $jSr = New-Object System.IO.StreamReader($jRes.GetResponseStream())
                                            $jXml = $jSr.ReadToEnd()
                                            $jRes.Close()
                                            if ($jXml -match "<[^>]*JobState[^>]*>Processing<") {
                                                $jobDone = $false
                                                Write-Host "  [HP 4103] La impresora sigue procesando la hoja ('Processing')... continuando espera" -ForegroundColor Cyan
                                            }
                                        } catch {}

                                        if ($jobDone) {
                                            Write-Host "  [HP 4103] Trabajo de escaneo finalizado en la impresora." -ForegroundColor DarkCyan
                                            break
                                        }
                                    }
                                }
                                continue
                            }
                        }
                    }
                }

                if (-not $gotPage) {
                    break
                }

                if ($actualSource -eq "Platen") { break }
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
                throw "No se recibieron hojas escaneadas. Revisa que las hojas esten bien insertadas en el alimentador superior (ADF) o en el cristal."
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
