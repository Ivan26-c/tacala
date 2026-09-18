const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { exec, spawn } = require('child_process');

const PORT = 3000;
const SCANS_DIR = path.join(__dirname, 'escaneos');
const DOCS_SAVED_DIR = path.join(__dirname, 'documentos_guardados');

// Ensure scans and saved docs directories exist
if (!fs.existsSync(SCANS_DIR)) {
  fs.mkdirSync(SCANS_DIR, { recursive: true });
}
if (!fs.existsSync(DOCS_SAVED_DIR)) {
  fs.mkdirSync(DOCS_SAVED_DIR, { recursive: true });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.json': 'application/json'
};

// ==========================================================================
// HP eSCL / AirScan Network Protocol Helpers
// ==========================================================================
function httpRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const isHttps = options.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: buffer
        });
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(25000, () => {
      req.destroy(new Error('Tiempo de espera agotado con la impresora HP.'));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// Test connectivity and fetch eSCL capabilities from HP printer
async function testHpPrinter(printerIp) {
  const cleanIp = printerIp.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const ports = [80, 8080, 443];

  for (const port of ports) {
    try {
      const isHttps = port === 443;
      const options = {
        protocol: isHttps ? 'https:' : 'http:',
        hostname: cleanIp,
        port: port,
        path: '/eSCL/ScannerCapabilities',
        method: 'GET',
        headers: { 'Accept': 'text/xml, application/xml' },
        rejectUnauthorized: false
      };

      const res = await httpRequest(options);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const xmlText = res.data.toString('utf-8');
        const hasAdf = xmlText.toLowerCase().includes('feeder');
        const hasPlaten = xmlText.toLowerCase().includes('platen');
        return {
          success: true,
          ip: cleanIp,
          port: port,
          protocol: isHttps ? 'https' : 'http',
          hasAdf: hasAdf,
          hasPlaten: hasPlaten,
          rawCaps: xmlText
        };
      }
    } catch (e) {
      // Try next port
    }
  }

  // Also check if port 80 responds (standard web interface)
  try {
    const res = await httpRequest({
      hostname: cleanIp,
      port: 80,
      path: '/',
      method: 'GET'
    });
    if (res.statusCode === 200) {
      return {
        success: true,
        ip: cleanIp,
        port: 80,
        protocol: 'http',
        hasAdf: true,
        hasPlaten: true,
        note: 'Servidor web HP detectado'
      };
    }
  } catch (e) {
    // ignore
  }

  throw new Error(`No se pudo conectar con la HP en ${cleanIp}. Verifica que esté encendida y conectada a la misma red.`);
}

// Perform eSCL scan job on HP printer
async function scanFromHp({ ip, port = 80, protocol = 'http', source = 'Feeder', colorMode = 'RGB24', resolution = 300, duplex = false }) {
  const cleanIp = ip.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const isHttps = protocol === 'https' || port === 443;
  const isDuplex = Boolean(duplex);
  // Para HP eSCL, el alimentador dúplex se identifica como 'Adf'
  const actualSource = (source === 'Platen' && !isDuplex) ? 'Platen' : 'Adf';

  // Check if ADF is empty before attempting scan
  if (actualSource === 'Adf' || actualSource === 'Feeder') {
    try {
      const statusRes = await httpRequest({
        protocol: isHttps ? 'https:' : 'http:',
        hostname: cleanIp,
        port: port,
        path: '/eSCL/ScannerStatus',
        method: 'GET',
        rejectUnauthorized: false
      });
      if (statusRes.statusCode === 200) {
        const sXml = statusRes.data.toString('utf-8');
        if (sXml.includes('ScannerAdfEmpty')) {
          throw new Error('La bandeja superior (ADF) está VACÍA. Coloca las hojas en la bandeja superior hasta que la impresora haga un sonidito o detecte el papel antes de hacer clic en Escanear.');
        }
      }
    } catch (e) {
      if (e.message.includes('VACÍA')) throw e;
    }
  }

  // Calculate pixel dimensions for standard A4 at target DPI
  // A4 = 8.27 x 11.69 inches
  const widthPx = Math.round(8.27 * resolution);
  const heightPx = Math.round(11.69 * resolution);
  // Normalizar modo de color eSCL
  let normalizedColor = 'RGB24';
  if (colorMode === 'Grayscale') normalizedColor = 'Grayscale8';
  else if (colorMode === 'Mono') normalizedColor = 'BlackAndWhite1';

  // Variantes de ScanSettings para máxima compatibilidad con HP eSCL
  const variants = [];
  if (isDuplex) {
    variants.push({
      name: 'HP Adf Duplex (Adf + AdfOptions + Duplex)',
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.0</pwg:Version>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:Height>${heightPx}</pwg:Height>
      <pwg:Width>${widthPx}</pwg:Width>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:InputSource>Adf</pwg:InputSource>
  <scan:InputSource>Adf</scan:InputSource>
  <scan:ColorMode>${normalizedColor}</scan:ColorMode>
  <scan:XResolution>${resolution}</scan:XResolution>
  <scan:YResolution>${resolution}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:AdfOptions>
    <scan:AdfOption>Duplex</scan:AdfOption>
  </scan:AdfOptions>
  <scan:Duplex>true</scan:Duplex>
</scan:ScanSettings>`
    });

    variants.push({
      name: 'HP Feeder Duplex (Feeder + AdfOptions + Duplex)',
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.0</pwg:Version>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:Height>${heightPx}</pwg:Height>
      <pwg:Width>${widthPx}</pwg:Width>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:InputSource>Feeder</pwg:InputSource>
  <scan:InputSource>Feeder</scan:InputSource>
  <scan:ColorMode>${normalizedColor}</scan:ColorMode>
  <scan:XResolution>${resolution}</scan:XResolution>
  <scan:YResolution>${resolution}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:AdfOptions>
    <scan:AdfOption>Duplex</scan:AdfOption>
  </scan:AdfOptions>
  <scan:Duplex>true</scan:Duplex>
</scan:ScanSettings>`
    });

    variants.push({
      name: 'HP Adf Duplex (Adf + Duplex)',
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.0</pwg:Version>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:Height>${heightPx}</pwg:Height>
      <pwg:Width>${widthPx}</pwg:Width>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:InputSource>Adf</pwg:InputSource>
  <scan:InputSource>Adf</scan:InputSource>
  <scan:ColorMode>${normalizedColor}</scan:ColorMode>
  <scan:XResolution>${resolution}</scan:XResolution>
  <scan:YResolution>${resolution}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:Duplex>true</scan:Duplex>
</scan:ScanSettings>`
    });

    variants.push({
      name: 'HP Feeder Duplex (Feeder + Duplex)',
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.0</pwg:Version>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:Height>${heightPx}</pwg:Height>
      <pwg:Width>${widthPx}</pwg:Width>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:InputSource>Feeder</pwg:InputSource>
  <scan:InputSource>Feeder</scan:InputSource>
  <scan:ColorMode>${normalizedColor}</scan:ColorMode>
  <scan:XResolution>${resolution}</scan:XResolution>
  <scan:YResolution>${resolution}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:Duplex>true</scan:Duplex>
</scan:ScanSettings>`
    });
  } else {
    variants.push({
      name: 'Simplex (1 cara)',
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.0</pwg:Version>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:Height>${heightPx}</pwg:Height>
      <pwg:Width>${widthPx}</pwg:Width>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:InputSource>${actualSource}</pwg:InputSource>
  <scan:InputSource>${actualSource}</scan:InputSource>
  <scan:ColorMode>${normalizedColor}</scan:ColorMode>
  <scan:XResolution>${resolution}</scan:XResolution>
  <scan:YResolution>${resolution}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:Duplex>false</scan:Duplex>
</scan:ScanSettings>`
    });
  }

  // 1. Crear trabajo con soporte multi-variante
  let locationHeader = null;
  let lastJobError = null;

  for (const v of variants) {
    console.log(`[Tacala] Probando configuración eSCL: ${v.name}...`);
    try {
      const createJobOptions = {
        protocol: isHttps ? 'https:' : 'http:',
        hostname: cleanIp,
        port: port,
        path: '/eSCL/ScanJobs',
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml',
          'Content-Length': Buffer.byteLength(v.xml)
        },
        rejectUnauthorized: false
      };

      const jobRes = await httpRequest(createJobOptions, v.xml);
      console.log(`[Tacala] Respuesta ${v.name}: HTTP ${jobRes.statusCode}`);

      if (jobRes.statusCode === 201) {
        locationHeader = jobRes.headers['location'] || jobRes.headers['Location'];
        console.log(`[Tacala] ¡Impresora HP aceptó configuración '${v.name}'! Location: ${locationHeader}`);
        break;
      } else {
        const responseBody = jobRes.data.toString('utf-8');
        console.warn(`  [Tacala] '${v.name}' rechazada con HTTP ${jobRes.statusCode}: ${responseBody}`);
        lastJobError = new Error(`HTTP ${jobRes.statusCode}: ${responseBody}`);
      }
    } catch (err) {
      lastJobError = err;
    }
  }

  if (!locationHeader) {
    throw lastJobError || new Error('No se recibió la ubicación del trabajo de escaneo (Location Header).');
  }

  // Location can be relative "/eSCL/ScanJobs/..." or absolute URL
  let jobPath = locationHeader;
  if (jobPath.startsWith('http')) {
    jobPath = new URL(locationHeader).pathname;
  }

  // 2. Poll & Download Scanned Pages with Duplex Retry Loop
  const scannedPages = [];
  const maxPages = (actualSource === 'Adf' || source === 'Feeder') ? (isDuplex ? 120 : 60) : 1;

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    let gotPage = false;
    let retries = 0;
    const maxRetriesForPage = pageNum === 1 ? 30 : (isDuplex && pageNum % 2 === 0 ? 35 : 15);
    let consecutive404 = 0;

    while (retries < maxRetriesForPage) {
      await new Promise((r) => setTimeout(r, 1200));

      const docOptions = {
        protocol: isHttps ? 'https:' : 'http:',
        hostname: cleanIp,
        port: port,
        path: `${jobPath}/NextDocument`,
        method: 'GET',
        rejectUnauthorized: false
      };

      try {
        const docRes = await httpRequest(docOptions);

        if (docRes.statusCode === 200) {
          const imgBytes = docRes.data;
          const b64 = imgBytes.toString('base64');
          const dataUrl = `data:image/jpeg;base64,${b64}`;

          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `hp4103_${timestamp}_cara${pageNum}.jpg`;
          const savePath = path.join(SCANS_DIR, filename);
          fs.writeFileSync(savePath, imgBytes);

          scannedPages.push({ dataUrl, type: 'image', filename });
          console.log(`[Tacala] -> Cara ${pageNum} escaneada y recibida (${Math.round(imgBytes.length / 1024)} KB)`);
          gotPage = true;
          consecutive404 = 0;
          break;
        } else if (docRes.statusCode === 503) {
          console.log(`[Tacala] Procesando cara ${pageNum} (impresora ocupada - 503)... esperando (${retries + 1}/${maxRetriesForPage})`);
          retries++;
          continue;
        } else if (docRes.statusCode === 404) {
          consecutive404++;
          console.log(`[Tacala] Cara ${pageNum} esperando... (404 intento ${consecutive404}/${maxRetriesForPage})`);

          if (scannedPages.length > 0) {
            const isWaitingBackSide = isDuplex && (scannedPages.length % 2 !== 0);
            const threshold404 = isWaitingBackSide ? 15 : 3;

            if (consecutive404 >= threshold404) {
              let jobDone = false;
              try {
                const jobStateRes = await httpRequest({
                  protocol: isHttps ? 'https:' : 'http:',
                  hostname: cleanIp,
                  port: port,
                  path: jobPath,
                  method: 'GET',
                  rejectUnauthorized: false
                });
                if (jobStateRes.statusCode === 200) {
                  const stateXml = jobStateRes.data.toString('utf-8');
                  const match = stateXml.match(/<[^>]*JobState[^>]*>\s*([^<]+)\s*</i);
                  const reportedState = match ? match[1].trim() : 'Unknown';
                  console.log(`[Tacala] Estado reportado del trabajo: '${reportedState}'`);

                  if (/^(Completed|Canceled|Aborted)$/i.test(reportedState)) {
                    jobDone = true;
                  } else if (/Processing|Pending/i.test(reportedState)) {
                    jobDone = false;
                    console.log(`[Tacala] La impresora sigue procesando ('${reportedState}')... continuando espera`);
                  }
                }
              } catch (e) {
                if (!isWaitingBackSide) jobDone = true;
              }

              if (jobDone) {
                console.log(`[Tacala] Trabajo de escaneo finalizado en la impresora.`);
                break;
              }
            }
          }
          retries++;
          continue;
        } else {
          retries++;
        }
      } catch (err) {
        retries++;
      }
    }

    if (!gotPage) {
      break;
    }

    if (actualSource === 'Platen') break;
  }

  // 3. Delete / Finish scan job
  try {
    await httpRequest({
      protocol: isHttps ? 'https:' : 'http:',
      hostname: cleanIp,
      port: port,
      path: jobPath,
      method: 'DELETE',
      rejectUnauthorized: false
    });
  } catch (e) {
    // ignore clean up error
  }

  if (scannedPages.length === 0) {
    throw new Error('No se recibieron hojas escaneadas. Revisa que haya papel en la bandeja o alimentador de la HP.');
  }

  return scannedPages;
}

// ==========================================================================
// Windows WIA Local Driver Integration (HP Smart)
// ==========================================================================
function getWiaDevices() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const script = `
      try {
        $dm = New-Object -ComObject WIA.DeviceManager
        $scanners = @()
        foreach ($d in $dm.DeviceInfos) {
          if ($d.Type -eq 1) {
            $name = try { $d.Properties.Item("Name").Value } catch { "Escáner WIA" }
            $scanners += @{ id = $d.DeviceID; name = $name }
          }
        }
        $scanners | ConvertTo-Json -Compress
      } catch { '[]' }
    `;
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/\n/g, ' ')}"`, (err, stdout) => {
      try {
        const parsed = JSON.parse((stdout || '').trim() || '[]');
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch (e) {
        resolve([]);
      }
    });
  });
}

function scanWithWia({ duplex = false, source = 'Feeder', deviceId = '' } = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      return reject(new Error('El controlador WIA solo está disponible en Windows.'));
    }
    const isDuplex = Boolean(duplex);
    const reqSource = source || 'Feeder';
    const escapedScansDir = SCANS_DIR.replace(/\\/g, '\\\\');
    const escapedDevId = (deviceId || '').replace(/"/g, '`"');

    const script = `
      try {
        $dm = New-Object -ComObject WIA.DeviceManager
        $selectedDev = $null
        $devId = "${escapedDevId}"
        if ($devId) {
          foreach ($d in $dm.DeviceInfos) {
            if ($d.DeviceID -eq $devId) { $selectedDev = $d.Connect(); break }
          }
        }
        if (-not $selectedDev) {
          foreach ($d in $dm.DeviceInfos) {
            if ($d.Type -eq 1) { $selectedDev = $d.Connect(); break }
          }
        }
        if (-not $selectedDev) {
          throw "No se encontró ningún escáner WIA compatible en Windows."
        }
        try {
          $prop = $selectedDev.Properties.Item("3088")
          if ("${reqSource}" -eq "Platen") { $prop.Value = 2 }
          elseif (${isDuplex ? '$true' : '$false'}) { $prop.Value = 5 }
          else { $prop.Value = 1 }
        } catch {}
        try { $selectedDev.Properties.Item("3096").Value = 0 } catch {}

        $scansDir = "${escapedScansDir}"
        $pages = @()
        $hasMore = $true
        $pageIdx = 0
        $fmt = "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}"

        while ($hasMore -and $pageIdx -lt 100) {
          try {
            $item = $selectedDev.Items.Item(1)
            $img = $null
            try { $img = $item.Transfer($fmt) } catch { $img = $item.Transfer() }
            if ($img) {
              $pageIdx++
              $ts = (Get-Date).ToString("yyyyMMdd_HHmmss")
              $fn = "hp_wia_${ts}_cara$pageIdx.jpg"
              $save = Join-Path $scansDir $fn
              $img.SaveFile($save)
              $bytes = [System.IO.File]::ReadAllBytes($save)
              $b64 = [Convert]::ToBase64String($bytes)
              $pages += @{ dataUrl = "data:image/jpeg;base64,$b64"; type = "image"; filename = $fn }
              if ("${reqSource}" -eq "Platen") { $hasMore = $false }
            } else { $hasMore = $false }
          } catch { $hasMore = $false }
        }
        if ($pages.Count -eq 0) { throw "No se obtuvieron hojas del alimentador o cristal." }
        @{ success = $true; pages = $pages } | ConvertTo-Json -Depth 4
      } catch {
        @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json
      }
    `;

    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/\n/g, ' ')}"`, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      try {
        const res = JSON.parse((stdout || '').trim());
        if (res.success && res.pages) {
          resolve(res.pages);
        } else {
          reject(new Error(res.error || stderr || 'Error en escaneo WIA.'));
        }
      } catch (e) {
        reject(new Error(stderr || stdout || 'Error al ejecutar escáner WIA.'));
      }
    });
  });
}

// ==========================================================================
// HTTP Server & Router
// ==========================================================================
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --------------------------------------------------------------------------
  // API: Probar Conexión con Impresora HP
  // --------------------------------------------------------------------------
  if (pathname === '/api/scanner/test' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', async () => {
      try {
        const { ip } = JSON.parse(body || '{}');
        if (!ip) throw new Error('Debes proporcionar la dirección IP de la impresora.');
        const result = await testHpPrinter(ip);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // --------------------------------------------------------------------------
  // API: Diagnóstico Completo de Capacidades de Escaneo Duplex
  // --------------------------------------------------------------------------
  if (pathname === '/api/scanner/diagnose' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', async () => {
      try {
        const { ip } = JSON.parse(body || '{}');
        if (!ip) throw new Error('Debes proporcionar la dirección IP.');
        const cleanIp = ip.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

        const diagnosis = {
          ip: cleanIp,
          timestamp: new Date().toISOString(),
          capabilities: null,
          scannerStatus: null,
          duplexSupport: {},
          adfInfo: {},
          rawCapabilitiesXml: null,
          errors: []
        };

        // 1. Fetch ScannerCapabilities
        const ports = [80, 8080, 443];
        let capsXml = null;
        let usedPort = 80;
        let usedProtocol = 'http';

        for (const port of ports) {
          try {
            const isHttps = port === 443;
            const capRes = await httpRequest({
              protocol: isHttps ? 'https:' : 'http:',
              hostname: cleanIp,
              port: port,
              path: '/eSCL/ScannerCapabilities',
              method: 'GET',
              headers: { 'Accept': 'text/xml, application/xml' },
              rejectUnauthorized: false
            });
            if (capRes.statusCode >= 200 && capRes.statusCode < 300) {
              capsXml = capRes.data.toString('utf-8');
              usedPort = port;
              usedProtocol = isHttps ? 'https' : 'http';
              break;
            }
          } catch (e) {
            diagnosis.errors.push(`Puerto ${port}: ${e.message}`);
          }
        }

        if (!capsXml) {
          throw new Error('No se pudo obtener ScannerCapabilities de la impresora.');
        }

        diagnosis.rawCapabilitiesXml = capsXml;
        try {
          fs.writeFileSync(path.join(SCANS_DIR, 'capacidades_hp.xml'), capsXml, 'utf-8');
          diagnosis.savedXmlPath = 'escaneos/capacidades_hp.xml';
        } catch (e) {}

        // 2. Parse duplex-related tags
        const xmlLower = capsXml.toLowerCase();
        
        // Check for ADF support
        diagnosis.adfInfo.hasAdf = xmlLower.includes('adf') || xmlLower.includes('feeder');
        diagnosis.adfInfo.hasPlaten = xmlLower.includes('platen');
        
        // Check all duplex-related tags
        diagnosis.duplexSupport.hasDuplexTag = xmlLower.includes('duplex');
        diagnosis.duplexSupport.hasDuplexMode = xmlLower.includes('duplexmode');
        diagnosis.duplexSupport.hasTwoSided = xmlLower.includes('twosided');
        diagnosis.duplexSupport.hasAdfOption = xmlLower.includes('adfoption');
        diagnosis.duplexSupport.hasAdfOptions = xmlLower.includes('adfoptions');
        diagnosis.duplexSupport.hasDuplexSupported = xmlLower.includes('duplexsupported');
        
        // Extract specific duplex section text
        const duplexMatches = capsXml.match(/[\s\S]*?[Dd]uplex[\s\S]*?/gi);
        diagnosis.duplexSupport.rawDuplexLines = [];
        if (duplexMatches) {
          // Find lines containing 'duplex' (case insensitive)
          const lines = capsXml.split('\n');
          lines.forEach((line, idx) => {
            if (line.toLowerCase().includes('duplex') || line.toLowerCase().includes('adfoption')) {
              diagnosis.duplexSupport.rawDuplexLines.push({ line: idx + 1, content: line.trim() });
            }
          });
        }

        // Extract ADF section
        const adfSectionMatch = capsXml.match(/<[^>]*[Aa]df[^>]*>[\s\S]*?<\/[^>]*[Aa]df[^>]*>/gi);
        diagnosis.adfInfo.rawAdfSections = adfSectionMatch || [];

        // Extract InputSource options
        const inputSourceMatches = capsXml.match(/<[^>]*InputSource[^>]*>[^<]*<\/[^>]*InputSource[^>]*>/gi);
        diagnosis.adfInfo.inputSources = inputSourceMatches || [];

        // 3. Fetch ScannerStatus
        try {
          const statusRes = await httpRequest({
            protocol: usedProtocol === 'https' ? 'https:' : 'http:',
            hostname: cleanIp,
            port: usedPort,
            path: '/eSCL/ScannerStatus',
            method: 'GET',
            headers: { 'Accept': 'text/xml, application/xml' },
            rejectUnauthorized: false
          });
          if (statusRes.statusCode === 200) {
            diagnosis.scannerStatus = statusRes.data.toString('utf-8');
          }
        } catch (e) {
          diagnosis.errors.push(`ScannerStatus: ${e.message}`);
        }

        // Extract Model and ADF sensor state
        const modelMatch = capsXml.match(/<[^>]*MakeAndModel[^>]*>([^<]+)</i);
        diagnosis.model = modelMatch ? modelMatch[1].trim() : 'HP Multifuncional';

        if (diagnosis.scannerStatus) {
          const adfMatch = diagnosis.scannerStatus.match(/<[^>]*AdfState[^>]*>([^<]+)</i);
          diagnosis.adfState = adfMatch ? adfMatch[1].trim() : 'Unknown';
        } else {
          diagnosis.adfState = 'Unknown';
        }

        // Summary
        diagnosis.summary = {
          canDoDuplex: diagnosis.duplexSupport.hasDuplexTag || diagnosis.duplexSupport.hasTwoSided,
          inputSources: diagnosis.adfInfo.inputSources,
          connectionPort: usedPort,
          connectionProtocol: usedProtocol,
          model: diagnosis.model,
          adfState: diagnosis.adfState
        };

        console.log('[Tacala] ===== DIAGNÓSTICO COMPLETO =====');
        console.log('[Tacala] Duplex support:', JSON.stringify(diagnosis.duplexSupport, null, 2));
        console.log('[Tacala] ADF info:', JSON.stringify(diagnosis.adfInfo, null, 2));
        console.log('[Tacala] =====================================');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, diagnosis }));
      } catch (err) {
        console.error('[Tacala] Error en diagnóstico:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // --------------------------------------------------------------------------
  // API: Iniciar Escaneo por Red con HP (eSCL)
  // --------------------------------------------------------------------------
  if (pathname === '/api/scanner/scan' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', async () => {
      try {
        const params = JSON.parse(body || '{}');
        if (!params.ip) throw new Error('Falta la dirección IP de la impresora HP.');

        console.log(`[Tacala] Iniciando escaneo eSCL en HP ${params.ip} (Origen: ${params.source}, Color: ${params.colorMode}, DPI: ${params.resolution})`);
        const pages = await scanFromHp(params);

        const isDuplex = Boolean(params.duplex);
        const isOddDuplex = isDuplex && pages && (pages.length % 2 !== 0);
        const duplexWarning = isOddDuplex ? "La impresora completó el trabajo tras escanear 1 sola cara. Para escaneo a doble cara con el motor oficial de HP Smart, selecciona 'Modo Windows WIA' en Tacala." : null;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, pages: pages, duplexWarning }));
      } catch (err) {
        console.error('[Tacala] Error durante escaneo:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // --------------------------------------------------------------------------
  // API: Listar Escáneres Windows WIA (HP Smart)
  // --------------------------------------------------------------------------
  if (pathname === '/api/scanner/wia-devices' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const devices = await getWiaDevices();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, devices }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message, devices: [] }));
    }
    return;
  }

  // --------------------------------------------------------------------------
  // API: Escaneo Nativo Windows WIA (Motor de HP Smart)
  // --------------------------------------------------------------------------
  if (pathname === '/api/scanner/wia-scan' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', async () => {
      try {
        const params = JSON.parse(body || '{}');
        const pages = await scanWithWia(params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, pages: pages }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/scanner/wia' && req.method === 'POST') {
    try {
      const pages = await scanWithWia();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, pages: pages }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // --------------------------------------------------------------------------
  // API: Consultar Archivos en Carpeta de Escaneos Compartida
  // --------------------------------------------------------------------------
  if (pathname === '/api/scanner/folder-scans' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(SCANS_DIR)
        .filter((f) => /\.(pdf|png|jpe?g)$/i.test(f))
        .map((f) => {
          const filePath = path.join(SCANS_DIR, f);
          const stat = fs.statSync(filePath);
          return {
            filename: f,
            mtime: stat.mtimeMs,
            size: stat.size
          };
        })
        .sort((a, b) => b.mtime - a.mtime); // Newest first

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, files: files, folderPath: SCANS_DIR }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // --------------------------------------------------------------------------
  // API: Obtener Archivo Específico de Escaneo
  // --------------------------------------------------------------------------
  if (pathname.startsWith('/api/scanner/file/') && req.method === 'GET') {
    const filename = path.basename(pathname.replace('/api/scanner/file/', ''));
    const targetFile = path.join(SCANS_DIR, filename);

    if (fs.existsSync(targetFile)) {
      const ext = path.extname(targetFile).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(targetFile).pipe(res);
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Archivo no encontrado');
      return;
    }
  }

  // --------------------------------------------------------------------------
  // API: Guardar Documento en Carpeta Local
  // --------------------------------------------------------------------------
  if (pathname === '/api/save-document' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const filename = req.headers['x-filename'] || `tacala_doc_${Date.now()}.pdf`;
        const targetPath = path.join(DOCS_SAVED_DIR, filename);
        fs.writeFileSync(targetPath, buffer);
        console.log(`[Tacala] Documento guardado con éxito en: ${targetPath}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, savedPath: targetPath, filename: filename }));
      } catch (err) {
        console.error('[Tacala] Error guardando documento:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // --------------------------------------------------------------------------
  // Static File Serving
  // --------------------------------------------------------------------------
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  const extname = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  TACALA PDF Studio + HP LaserJet MFP 4103fdw Server   `);
  console.log(`  URL: http://localhost:${PORT}/                       `);
  console.log(`  Carpeta de Escaneos: ${SCANS_DIR}                    `);
  console.log(`=======================================================`);
});
