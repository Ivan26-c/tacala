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
async function scanFromHp({ ip, port = 80, protocol = 'http', source = 'Platen', colorMode = 'RGB24', resolution = 300, duplex = false }) {
  const cleanIp = ip.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const isHttps = protocol === 'https' || port === 443;

  // Calculate pixel dimensions for standard A4 at target DPI
  // A4 = 8.27 x 11.69 inches
  const widthPx = Math.round(8.27 * resolution);
  const heightPx = Math.round(11.69 * resolution);

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
  <scan:InputSource>${source}</scan:InputSource>
  <scan:ColorMode>${colorMode}</scan:ColorMode>
  <scan:XResolution>${resolution}</scan:XResolution>
  <scan:YResolution>${resolution}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:Duplex>${duplex ? 'true' : 'false'}</scan:Duplex>
</scan:ScanSettings>`;

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
  if (jobRes.statusCode !== 201) {
    throw new Error(`La impresora respondió con código ${jobRes.statusCode}: ${jobRes.data.toString('utf-8')}`);
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

  // 2. Poll & Download Scanned Pages
  const scannedPages = [];
  const maxPages = source === 'Feeder' ? 50 : 1; // Feeder may have multiple pages

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    // Wait slightly for document to process
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
        const filename = `hp4103_${timestamp}_pag${pageNum}.jpg`;
        fs.writeFileSync(path.join(SCANS_DIR, filename), docRes.data);

        scannedPages.push({
          dataUrl: dataUrl,
          type: contentType.includes('pdf') ? 'pdf' : 'image',
          filename: filename
        });

        if (source === 'Platen') break; // Platen only has 1 page
      } else if (docRes.statusCode === 404 || docRes.statusCode === 503) {
        // Feeder is empty, no more pages
        break;
      }
    } catch (err) {
      if (pageNum > 1) break; // End of ADF pages
      throw err;
    }
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
