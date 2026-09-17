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
                rawXml = $capsXml
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

        # Para HP, el alimentador superior en eSCL es "Feeder"
        $actualSource = if ($reqSource -eq "Platen" -and -not $isDuplex) { "Platen" } else { "Feeder" }
        $color = if ($params.colorMode -eq "Grayscale") { "Grayscale8" } elseif ($params.colorMode -eq "Mono") { "BlackAndWhite1" } else { "RGB24" }
        $resDpi = if ($params.resolution) { [int]$params.resolution } else { 300 }
        $duplexStr = if ($isDuplex) { "true" } else { "false" }

        $wPx = [math]::Round(8.27 * $resDpi)
        $hPx = [math]::Round(11.69 * $resDpi)

        # Variantes de ScanSettings para máxima compatibilidad con HP eSCL
        $variants = @()
        if ($isDuplex) {
            # Variante 1: Oficial HP ADF Duplex (AdfOptions + DuplexMode + Duplex)
            $v1 = @"
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
  <scan:AdfOptions>
    <scan:AdfOption>Duplex</scan:AdfOption>
  </scan:AdfOptions>
  <scan:DuplexMode>TwoSided</scan:DuplexMode>
  <scan:Duplex>true</scan:Duplex>
</scan:ScanSettings>
"@
            # Variante 2: HP AdfOptions (Duplex) + Duplex booleano (sin DuplexMode)
            $v2 = @"
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
  <scan:AdfOptions>
    <scan:AdfOption>Duplex</scan:AdfOption>
  </scan:AdfOptions>
  <scan:Duplex>true</scan:Duplex>
</scan:ScanSettings>
"@
            # Variante 3: Solo AdfOptions (Duplex)
            $v3 = @"
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
  <scan:AdfOptions>
    <scan:AdfOption>Duplex</scan:AdfOption>
  </scan:AdfOptions>
</scan:ScanSettings>
"@
            # Variante 4: eSCL scan:Duplex estándar
            $v4 = @"
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
  <scan:Duplex>true</scan:Duplex>
</scan:ScanSettings>
"@
            $variants = @(
                @{ name = "HP Duplex Completo (AdfOptions + DuplexMode + Duplex)"; xml = $v1 },
                @{ name = "HP Duplex (AdfOptions + Duplex booleano)"; xml = $v2 },
                @{ name = "HP Duplex (AdfOptions)"; xml = $v3 },
                @{ name = "eSCL Estándar (scan:Duplex)"; xml = $v4 }
            )
        } else {
            $simplexXml = @"
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
  <scan:Duplex>false</scan:Duplex>
</scan:ScanSettings>
"@
            $variants = @( @{ name = "Simplex (1 cara)"; xml = $simplexXml } )
        }

        try {
            # Verificación previa: Si se escanea con Feeder (ADF), comprobar si hay hojas
            if ($actualSource -eq "Feeder") {
                try {
                    $chkReq = [System.Net.HttpWebRequest]::Create("http://$ip/eSCL/ScannerStatus")
                    $chkReq.Timeout = 3000
                    $chkRes = $chkReq.GetResponse()
                    $chkSr = New-Object System.IO.StreamReader($chkRes.GetResponseStream())
                    $chkXml = $chkSr.ReadToEnd()
                    $chkRes.Close()
                    if ($chkXml -match "<[^>]*AdfState[^>]*>ScannerAdfEmpty<") {
                        throw "La bandeja superior (ADF) está VACÍA. Coloca las hojas en la bandeja superior hasta que la impresora haga un sonidito o detecte el papel antes de hacer clic en Escanear."
                    }
                } catch [System.Management.Automation.RuntimeException] {
                    throw $_
                } catch {}
            }

            Write-Host "[Tacala] Iniciando escaneo en HP $($ip) (Origen: $actualSource, Doble cara: $isDuplex)" -ForegroundColor Cyan
            
            $location = $null
            $lastError = $null

            # Intentar variantes automáticas para asegurar que la impresora acepte la directiva duplex exacta
            foreach ($v in $variants) {
                Write-Host "[Tacala] Enviando configuración eSCL: $($v.name)..." -ForegroundColor DarkGray
                try {
                    $jobReq = [System.Net.HttpWebRequest]::Create("http://$ip/eSCL/ScanJobs")
                    $jobReq.Method = "POST"
                    $jobReq.ContentType = "text/xml"
                    $jobReq.Timeout = 20000
                    $postBytes = [System.Text.Encoding]::UTF8.GetBytes($v.xml)
                    $jobReq.ContentLength = $postBytes.Length
                    $postStream = $jobReq.GetRequestStream()
                    $postStream.Write($postBytes, 0, $postBytes.Length)
                    $postStream.Close()

                    $jobRes = $jobReq.GetResponse()
                    $statusCode = [int]$jobRes.StatusCode
                    $loc = $jobRes.Headers["Location"]
                    $jobRes.Close()

                    if ($loc) {
                        $location = $loc
                        Write-Host "[Tacala] ¡Impresora HP aceptó configuración '$($v.name)' (HTTP $statusCode)!" -ForegroundColor Green
                        break
                    }
                } catch [System.Net.WebException] {
                    $lastError = $_.Exception
                    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
                    Write-Host "  [Tacala] '$($v.name)' respondió HTTP $code. Probando siguiente variante..." -ForegroundColor Yellow
                }
            }

            if (-not $location) {
                $errMsg = if ($lastError) { $lastError.Message } else { "No se recibió respuesta de trabajo de la impresora." }
                throw "La impresora no aceptó la orden de escaneo: $errMsg"
            }

            # Bucle para descargar TODAS las caras escaneadas
            # En duplex, la impresora procesa ambas caras y responde 503 o 404 temporal mientras procesa la cara 2.
            $pagesList = @()
            $maxPages = if ($actualSource -eq "Platen") { 1 } else { if ($isDuplex) { 100 } else { 50 } }
            $docBaseUrl = if ($location.StartsWith("http")) { "$location/NextDocument" } else { "http://$ip$location/NextDocument" }
            $jobStatusUrl = if ($location.StartsWith("http")) { $location } else { "http://$ip$location" }

            for ($pageNum = 1; $pageNum -le $maxPages; $pageNum++) {
                $gotPage = $false
                $retries = 0
                # En duplex, la cara 2 (reverso) tarda en voltearse o procesarse: permitir hasta 35 reintentos (~45s)
                $maxRetriesForPage = if ($pageNum -eq 1) { 30 } elseif ($isDuplex -and ($pageNum % 2 -eq 0)) { 35 } else { 15 }
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
                                
                                # Guardar también en disco en la carpeta escaneos
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
                                Write-Host "  [HP 4103] Cara $pageNum esperando... (404 intento $consecutive404/$maxRetriesForPage)" -ForegroundColor DarkGray

                                if ($pagesList.Count -gt 0) {
                                    # Si es duplex y acabamos de recibir una cara impar (1, 3, 5...), estamos esperando el REVERSO de la misma hoja:
                                    $waitingForBackSide = ($isDuplex -and ($pagesList.Count % 2 -ne 0))
                                    # Si estamos esperando el reverso, damos al menos 15 intentos (20s) antes de verificar si el trabajo concluyó
                                    $threshold404 = if ($waitingForBackSide) { 15 } else { 3 }

                                    if ($consecutive404 -ge $threshold404) {
                                        # Consultar el estado del trabajo para no cortar antes de tiempo
                                        $jobDone = $false
                                        try {
                                            $jReq = [System.Net.HttpWebRequest]::Create($jobStatusUrl)
                                            $jReq.Timeout = 3000
                                            $jRes = $jReq.GetResponse()
                                            $jSr = New-Object System.IO.StreamReader($jRes.GetResponseStream())
                                            $jXml = $jSr.ReadToEnd()
                                            $jRes.Close()

                                            $jobState = "Unknown"
                                            if ($jXml -match "<[^>]*JobState[^>]*>\s*([^<]+)\s*<") {
                                                $jobState = $matches[1].Trim()
                                            }
                                            Write-Host "  [HP 4103] Estado reportado del trabajo: '$jobState'" -ForegroundColor DarkCyan

                                            if ($jobState -match "^(?i)(Completed|Canceled|Aborted)$") {
                                                $jobDone = $true
                                            } elseif ($jobState -match "(?i)(Processing|Pending)") {
                                                $jobDone = $false
                                                Write-Host "  [HP 4103] La impresora sigue procesando la hoja ('$jobState')... continuando espera" -ForegroundColor Cyan
                                            }
                                        } catch {
                                            if (-not $waitingForBackSide) { $jobDone = $true }
                                        }

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
        } catch [System.Net.WebException] {
            $webEx = $_.Exception
            $statusCode = 500
            $errorMsg = $webEx.Message

            if ($webEx.Response) {
                $httpRes = [System.Net.HttpWebResponse]$webEx.Response
                $statusCode = [int]$httpRes.StatusCode
                try {
                    $s = $httpRes.GetResponseStream()
                    $sr = New-Object System.IO.StreamReader($s)
                    $body = $sr.ReadToEnd()
                    $sr.Close()
                    Write-Host "[Tacala] Respuesta de error de la impresora ($statusCode): $body" -ForegroundColor Red
                    if ($body -match "<[^>]*Reason[^>]*>([^<]+)<") {
                        $errorMsg = "La impresora respondió: $($matches[1].Trim())"
                    }
                } catch {}
            }

            if ($statusCode -eq 409) {
                $errorMsg = "Error 409 (Conflicto en la impresora): La impresora rechazó la orden. Revisa que las hojas estén bien colocadas en el alimentador superior (ADF) y que no haya ningún trabajo previo atascado."
            }

            Write-Host "[Tacala] Error durante el escaneo: $errorMsg" -ForegroundColor Red
            $errJson = @{ success = $false; error = $errorMsg } | ConvertTo-Json
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($errJson)
            $res.StatusCode = 500
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
