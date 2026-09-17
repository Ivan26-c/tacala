const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { exec } = require('child_process');

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
  // eSCL standard uses 'Adf' (not 'Feeder') for ADF input source
  const esclSource = (source === 'Feeder' || source === 'Adf') ? 'Adf' : 'Platen';
  const actualSource = isDuplex ? 'Adf' : esclSource;

  // Calculate pixel dimensions for standard A4 at target DPI
  // A4 = 8.27 x 11.69 inches
  const widthPx = Math.round(8.27 * resolution);
  const heightPx = Math.round(11.69 * resolution);

  // Build duplex XML tags — include ALL known variations for maximum compatibility
  let duplexXml = '';
  if (isDuplex) {
    duplexXml = `
  <scan:Duplex>true</scan:Duplex>
  <scan:DuplexMode>TwoSided</scan:DuplexMode>
  <scan:AdfOptions>
    <scan:AdfOption>Duplex</scan:AdfOption>
  </scan:AdfOptions>`;
  } else {
    duplexXml = `
  <scan:Duplex>false</scan:Duplex>
  <scan:DuplexMode>OneSided</scan:DuplexMode>`;
  }

  const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
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
  <scan:ColorMode>${colorMode}</scan:ColorMode>
  <scan:XResolution>${resolution}</scan:XResolution>
  <scan:YResolution>${resolution}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>${duplexXml}
</scan:ScanSettings>`;

  console.log(`[Tacala] ===== XML PAYLOAD ENVIADO =====`);
  console.log(xmlPayload);
  console.log(`[Tacala] ================================`);

  // 1. Create Scan Job
  const createJobOptions = {
    protocol: isHttps ? 'https:' : 'http:',
    hostname: cleanIp,
    port: port,
    path: '/eSCL/ScanJobs',
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xmlPayload)
    },
    rejectUnauthorized: false
  };

  const jobRes = await httpRequest(createJobOptions, xmlPayload);
  console.log(`[Tacala] Respuesta crear job: HTTP ${jobRes.statusCode}`);
  console.log(`[Tacala] Headers respuesta:`, JSON.stringify(jobRes.headers, null, 2));
  if (jobRes.statusCode !== 201) {
    const responseBody = jobRes.data.toString('utf-8');
    console.error(`[Tacala] Error body:`, responseBody);
    throw new Error(`La impresora respondió con código ${jobRes.statusCode}: ${responseBody}`);
  }

  const locationHeader = jobRes.headers['location'] || jobRes.headers['Location'];
  if (!locationHeader) {
    throw new Error('No se recibió la ubicación del trabajo de escaneo (Location Header).');
  }

  // Location can be relative "/eSCL/ScanJobs/..." or absolute URL
  let jobPath = locationHeader;
  if (jobPath.startsWith('http')) {
    jobPath = new URL(locationHeader).pathname;
  }

  // 2. Poll & Download Scanned Pages with Duplex Retry Loop
  const scannedPages = [];
  // Duplex doubles effective pages; increase max for ADF
  const maxPages = (actualSource === 'Adf' || source === 'Feeder') ? (isDuplex ? 120 : 60) : 1;

  let consecutive404 = 0;
  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    let gotPage = false;
    let retries = 0;
    // Give more time for duplex: printer needs to flip pages or process 2nd CIS sensor
    const maxRetriesForPage = pageNum === 1 ? 25 : (isDuplex ? 25 : 15);

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

        if (docRes.statusCode === 200 && docRes.data.length > 0) {
          const contentType = docRes.headers['content-type'] || 'image/jpeg';
          const base64Data = docRes.data.toString('base64');
          const dataUrl = `data:${contentType};base64,${base64Data}`;

          // Also save a copy to the escaneos directory
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `hp4103_${timestamp}_cara${pageNum}.jpg`;
          fs.writeFileSync(path.join(SCANS_DIR, filename), docRes.data);

          scannedPages.push({
            dataUrl: dataUrl,
            type: 'image',
            filename: filename
          });

          console.log(`[Tacala] Cara ${pageNum} escaneada y recibida (${Math.round(docRes.data.length / 1024)} KB)`);
          gotPage = true;
          consecutive404 = 0;
          break;
        } else if (docRes.statusCode === 503) {
          // 503 = Printer is flipping the page or processing next side (very common in duplex)
          console.log(`[Tacala] Procesando cara ${pageNum} (impresora ocupada - 503)... esperando (${retries + 1})`);
          if (isDuplex) {
            await new Promise((r) => setTimeout(r, 800));
          }
          retries++;
          continue;
        } else if (docRes.statusCode === 404) {
          consecutive404++;
          console.log(`[Tacala] Cara ${pageNum} esperando... (404 intento ${consecutive404})`);

          if (scannedPages.length > 0) {
            // If waiting for the back side of an already scanned sheet, wait longer
            const isWaitingBackSide = isDuplex && (scannedPages.length % 2 !== 0);
            const threshold404 = isWaitingBackSide ? 10 : 3;

            if (consecutive404 >= threshold404) {
              // Verify JobState via jobPath
              let stillProcessing = false;
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
                  if (stateXml.includes('Processing')) {
                    stillProcessing = true;
                    console.log(`[Tacala] El trabajo sigue en 'Processing'. Continuando espera...`);
                  }
                }
              } catch (e) {}

              if (!stillProcessing) {
                console.log(`[Tacala] Fin del trabajo de escaneo detectado.`);
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
// Windows WIA Local Driver Fallback
// ==========================================================================
function scanWithWia() {
  return new Promise((resolve, reject) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = path.join(SCANS_DIR, `wia_scan_${timestamp}.jpg`);

    // PowerShell script utilizing Windows WIA COM object
    const psScript = `
      try {
        $dialog = New-Object -ComObject WIA.CommonDialog
        $image = $dialog.ShowAcquireImage(1, 0, 0, "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}", $true, $true, $false)
        if ($image -ne $null) {
          $image.SaveFile("${outputPath.replace(/\\/g, '\\\\')}")
          Write-Output "OK"
        } else {
          Write-Output "CANCELLED"
        }
      } catch {
        Write-Error $_.Exception.Message
      }
    `;

    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ')}"`, (err, stdout, stderr) => {
      if (err || stderr.includes('Exception')) {
        return reject(new Error(stderr || err.message));
      }
      if (fs.existsSync(outputPath)) {
        const fileBytes = fs.readFileSync(outputPath);
        const dataUrl = `data:image/jpeg;base64,${fileBytes.toString('base64')}`;
        resolve([{ dataUrl, type: 'image', filename: path.basename(outputPath) }]);
      } else {
        reject(new Error('Escaneo cancelado o no se guardó la imagen.'));
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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, pages: pages }));
      } catch (err) {
        console.error('[Tacala] Error durante escaneo:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // --------------------------------------------------------------------------
  // API: Escaneo Nativo Windows WIA (Fallback)
  // --------------------------------------------------------------------------
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
