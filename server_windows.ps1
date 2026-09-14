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
Write-Host "  TACALA PDF Studio (Version Nativa Windows - Sin Node) " -ForegroundColor Green
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
        $ip = $json.ip

        try {
            $testUrl = "http://$ip/eSCL/ScannerCapabilities"
            $testReq = [System.Net.WebRequest]::Create($testUrl)
            $testReq.Timeout = 5000
            $testRes = $testReq.GetResponse()
            $testRes.Close()

            $resJson = @{ success = $true; ip = $ip; port = 80; hasAdf = $true; hasPlaten = $true } | ConvertTo-Json
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($resJson)
            $res.ContentType = "application/json"
            $res.OutputStream.Write($buffer, 0, $buffer.Length)
        } catch {
            $errJson = @{ success = $false; error = "No se pudo conectar con la HP en $ip. Revisa que este encendida." } | ConvertTo-Json
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($errJson)
            $res.StatusCode = 400
            $res.ContentType = "application/json"
            $res.OutputStream.Write($buffer, 0, $buffer.Length)
        }
        $res.Close()
        continue
    }

    # ---------------------------------------------------------
    # API: Escaneo por Red HP (eSCL)
    # ---------------------------------------------------------
    if ($rawPath -eq "/api/scanner/scan" -and $req.HttpMethod -eq "POST") {
        $reader = New-Object System.IO.StreamReader($req.InputStream)
        $body = $reader.ReadToEnd()
        $params = $body | ConvertFrom-Json

        $ip = $params.ip
        $source = if ($params.source) { $params.source } else { "Platen" }
        $color = if ($params.colorMode) { $params.colorMode } else { "RGB24" }
        $resDpi = if ($params.resolution) { [int]$params.resolution } else { 300 }
        $duplex = if ($params.duplex) { "true" } else { "false" }

        $wPx = [math]::Round(8.27 * $resDpi)
        $hPx = [math]::Round(11.69 * $resDpi)

        $xmlPayload = "<?xml version=""1.0"" encoding=""UTF-8""?><scan:ScanSettings xmlns:scan=""http://schemas.hp.com/imaging/escl/2011/05/03"" xmlns:pwg=""http://www.pwg.org/schemas/2010/12/sm""><pwg:Version>2.0</pwg:Version><pwg:ScanRegions><pwg:ScanRegion><pwg:Height>$hPx</pwg:Height><pwg:Width>$wPx</pwg:Width><pwg:XOffset>0</pwg:XOffset><pwg:YOffset>0</pwg:YOffset></pwg:ScanRegion></pwg:ScanRegions><scan:InputSource>$source</scan:InputSource><scan:ColorMode>$color</scan:ColorMode><scan:XResolution>$resDpi</scan:XResolution><scan:YResolution>$resDpi</scan:YResolution><pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat><scan:Duplex>$duplex</scan:Duplex></scan:ScanSettings>"

        try {
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

            if (-not $location) { throw "No se recibio cabecera de ubicacion de escaneo de la HP." }

            Start-Sleep -Milliseconds 1500

            $docUrl = if ($location.StartsWith("http")) { "$location/NextDocument" } else { "http://$ip$location/NextDocument" }
            $docReq = [System.Net.HttpWebRequest]::Create($docUrl)
            $docReq.Timeout = 30000
            $docRes = $docReq.GetResponse()

            $ms = New-Object System.IO.MemoryStream
            $docRes.GetResponseStream().CopyTo($ms)
            $imgBytes = $ms.ToArray()
            $docRes.Close()

            $b64 = [Convert]::ToBase64String($imgBytes)
            $dataUrl = "data:image/jpeg;base64,$b64"

            $pagesList = @(
                @{ dataUrl = $dataUrl; type = "image"; filename = "hp_scan.jpg" }
            )

            $resJson = @{ success = $true; pages = $pagesList } | ConvertTo-Json
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
