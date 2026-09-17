/**
 * TACALA - Modern Clean PDF Studio & Digitalizer
 * PDF.js for crisp rendering, PDF-Lib for high performance manipulation,
 * native eSCL scanning for HP LaserJet Pro MFP 4103fdw (with duplex support).
 */

// Initialize PDF.js worker (local offline vendor with fallback)
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
}

(function () {
  'use strict';

  // ==========================================================================
  // Application State
  // ==========================================================================
  const state = {
    pages: [], // Array of Page objects
    sourceDocuments: new Map(), // docId -> { name, bytes, pdfJsDoc }
    draggedIndex: null,
    selectedPageIds: new Set(),
    lastSelectedId: null,
    deskew: {
      activePageId: null,
      angle: 0,
      offsetX: 0,
      offsetY: 0,
      img: null,
      canvas: null,
      ctx: null
    },
    editor: {
      activePageId: null,
      tool: 'pen', // 'pen' | 'highlighter' | 'text' | 'eraser'
      color: '#0f172a',
      strokeSize: 4,
      isDrawing: false,
      history: [],
      historyStep: -1,
      bgCanvas: null,
      drawCanvas: null,
      drawCtx: null,
      bgCtx: null
    }
  };

  // Standard A4 dimensions in PDF points (72 DPI)
  const A4_PORTRAIT = { width: 595.28, height: 841.89 };

  // ==========================================================================
  // DOM Elements
  // ==========================================================================
  const DOM = {
    // Inputs
    pdfFileInput: document.getElementById('pdfFileInput'),
    imageFileInput: document.getElementById('imageFileInput'),

    // Navbar
    btnOpenHpScan: document.getElementById('btnOpenHpScan'),
    btnUploadPdf: document.getElementById('btnUploadPdf'),
    btnSaveToFolder: document.getElementById('btnSaveToFolder'),
    btnDownloadPdf: document.getElementById('btnDownloadPdf'),
    downloadBtnText: document.getElementById('downloadBtnText'),
    downloadSpinner: document.getElementById('downloadSpinner'),
    btnClearAll: document.getElementById('btnClearAll'),

    // Empty state & Workspace
    emptyState: document.getElementById('emptyState'),
    dropzone: document.getElementById('dropzone'),
    btnHpScanMain: document.getElementById('btnHpScanMain'),
    btnSelectPdfMain: document.getElementById('btnSelectPdfMain'),
    workbenchView: document.getElementById('workbenchView'),
    pagesGrid: document.getElementById('pagesGrid'),
    chipCurrentCount: document.getElementById('chipCurrentCount'),
    btnWorkbenchScanMore: document.getElementById('btnWorkbenchScanMore'),
    btnQuickAddBlank: document.getElementById('btnQuickAddBlank'),
    btnRotateAllCw: document.getElementById('btnRotateAllCw'),
    btnZoomIn: document.getElementById('btnZoomIn'),
    btnZoomOut: document.getElementById('btnZoomOut'),

    // Floating Bulk Action Bar
    bulkActionBar: document.getElementById('bulkActionBar'),
    bulkCountText: document.getElementById('bulkCountText'),
    btnBulkRotate: document.getElementById('btnBulkRotate'),
    btnBulkDelete: document.getElementById('btnBulkDelete'),
    btnBulkSelectAll: document.getElementById('btnBulkSelectAll'),
    btnBulkDeselectAll: document.getElementById('btnBulkDeselectAll'),

    // HP Scan Modal
    hpScanModal: document.getElementById('hpScanModal'),
    btnCloseHpModal: document.getElementById('btnCloseHpModal'),
    btnCancelHpScan: document.getElementById('btnCancelHpScan'),
    cardSourceAdf: document.getElementById('cardSourceAdf'),
    cardSourcePlaten: document.getElementById('cardSourcePlaten'),
    btnDuplexNo: document.getElementById('btnDuplexNo'),
    btnDuplexYes: document.getElementById('btnDuplexYes'),
    hpDuplexCheck: document.getElementById('hpDuplexCheck'),
    duplexStateBadge: document.getElementById('duplexStateBadge'),
    hpScanProgressBox: document.getElementById('hpScanProgressBox'),
    hpScanProgressTitle: document.getElementById('hpScanProgressTitle'),
    hpScanProgressSubtitle: document.getElementById('hpScanProgressSubtitle'),
    btnToggleIpConfig: document.getElementById('btnToggleIpConfig'),
    ipEditDrawer: document.getElementById('ipEditDrawer'),
    displayCurrentIpText: document.getElementById('displayCurrentIpText'),
    hpPrinterIp: document.getElementById('hpPrinterIp'),
    btnTestHpConnection: document.getElementById('btnTestHpConnection'),
    hpStatusFeedback: document.getElementById('hpStatusFeedback'),
    hpStatusText: document.getElementById('hpStatusText'),
    btnStartHpScan: document.getElementById('btnStartHpScan'),
    btnDiagnose: document.getElementById('btnDiagnose'),
    diagnosisPanel: document.getElementById('diagnosisPanel'),
    diagnosisContent: document.getElementById('diagnosisContent'),
    btnCloseDiagnosis: document.getElementById('btnCloseDiagnosis'),

    // Deskew Modal
    deskewModal: document.getElementById('deskewModal'),
    btnCloseDeskew: document.getElementById('btnCloseDeskew'),
    btnCancelDeskew: document.getElementById('btnCancelDeskew'),
    btnApplyDeskew: document.getElementById('btnApplyDeskew'),
    deskewPageBadge: document.getElementById('deskewPageBadge'),
    deskewAngleVal: document.getElementById('deskewAngleVal'),
    deskewSlider: document.getElementById('deskewSlider'),
    btnResetDeskewAngle: document.getElementById('btnResetDeskewAngle'),
    deskewCanvas: document.getElementById('deskewCanvas'),
    alignmentGridOverlay: document.getElementById('alignmentGridOverlay'),
    offsetXSlider: document.getElementById('offsetXSlider'),
    offsetYSlider: document.getElementById('offsetYSlider'),
    offsetXVal: document.getElementById('offsetXVal'),
    offsetYVal: document.getElementById('offsetYVal'),

    // Editor Modal
    editorModal: document.getElementById('editorModal'),
    modalPageNumberBadge: document.getElementById('modalPageNumberBadge'),
    btnCloseEditor: document.getElementById('btnCloseEditor'),
    btnCancelEditor: document.getElementById('btnCancelEditor'),
    btnSaveEditor: document.getElementById('btnSaveEditor'),
    bgCanvas: document.getElementById('bgCanvas'),
    drawCanvas: document.getElementById('drawCanvas'),
    canvasWrapper: document.getElementById('canvasWrapper'),
    strokeSizeRange: document.getElementById('strokeSizeRange'),
    strokeSizeVal: document.getElementById('strokeSizeVal'),
    customColorPicker: document.getElementById('customColorPicker'),
    btnUndoCanvas: document.getElementById('btnUndoCanvas'),

    // Toasts
    toastContainer: document.getElementById('toastContainer')
  };

  // ==========================================================================
  // Initialization
  // ==========================================================================
  function init() {
    setupUploadHandlers();
    setupWorkbenchToolbar();
    setupHpScanner();
    setupBulkActionBar();
    setupDeskewEngine();
    setupEditorModal();
    setupSaveAndDownload();
    setupClearHandler();
    updateUIState();
  }

  // ==========================================================================
  // Notifications & UI Helpers
  // ==========================================================================
  function showToast(message, type = 'info', duration = 3200) {
    if (!DOM.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let iconClass = 'fa-circle-info';
    if (type === 'success') iconClass = 'fa-circle-check';
    if (type === 'danger') iconClass = 'fa-circle-exclamation';

    toast.innerHTML = `
      <i class="fa-solid ${iconClass}"></i>
      <span>${escapeHtml(message)}</span>
    `;

    DOM.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(40px)';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function updateUIState() {
    const count = state.pages.length;
    DOM.chipCurrentCount.textContent = `${count} ${count === 1 ? 'página' : 'páginas'}`;

    if (count === 0) {
      DOM.emptyState.classList.remove('hidden');
      DOM.workbenchView.classList.add('hidden');
      DOM.bulkActionBar.classList.add('hidden');
      state.selectedPageIds.clear();
    } else {
      DOM.emptyState.classList.add('hidden');
      DOM.workbenchView.classList.remove('hidden');
      updateBulkActionBar();
    }
  }

  // ==========================================================================
  // Upload & File Handling
  // ==========================================================================
  function setupUploadHandlers() {
    // Triggers
    DOM.btnUploadPdf.addEventListener('click', () => DOM.pdfFileInput.click());
    DOM.btnSelectPdfMain.addEventListener('click', () => DOM.pdfFileInput.click());

    // File input changes
    DOM.pdfFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handlePdfFiles(Array.from(e.target.files));
        DOM.pdfFileInput.value = '';
      }
    });

    DOM.imageFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleImageFiles(Array.from(e.target.files));
        DOM.imageFileInput.value = '';
      }
    });

    // Drag and Drop on Empty State Dropzone
    const dropzone = DOM.dropzone;
    ['dragenter', 'dragover'].forEach((ev) => {
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropzone.classList.add('drag-active');
      });
    });

    ['dragleave', 'drop'].forEach((ev) => {
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropzone.classList.remove('drag-active');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      const pdfFiles = files.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
      const imgFiles = files.filter((f) => f.type.startsWith('image/'));

      if (pdfFiles.length > 0) handlePdfFiles(pdfFiles);
      if (imgFiles.length > 0) handleImageFiles(imgFiles);

      if (pdfFiles.length === 0 && imgFiles.length === 0) {
        showToast('Por favor sube archivos PDF o imágenes.', 'danger');
      }
    });
  }

  async function handlePdfFiles(files) {
    showToast(`Cargando ${files.length} archivo(s)...`, 'info', 2000);

    for (const file of files) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const docId = 'doc_' + Math.random().toString(36).substring(2, 9);

        // Clone the buffer so PDF.js Web Worker does not detach our copy for PDFLib
        const pdfLibBytes = new Uint8Array(arrayBuffer.slice(0));

        // Render pages with PDF.js
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
        const pdfJsDoc = await loadingTask.promise;

        state.sourceDocuments.set(docId, {
          name: file.name,
          bytes: pdfLibBytes,
          pdfJsDoc: pdfJsDoc
        });

        const numPages = pdfJsDoc.numPages;
        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
          const pdfPage = await pdfJsDoc.getPage(pageNum);
          const viewport = pdfPage.getViewport({ scale: 1.0 });

          // Render thumbnail
          const thumbScale = 1.0;
          const thumbViewport = pdfPage.getViewport({ scale: thumbScale });
          const thumbCanvas = document.createElement('canvas');
          thumbCanvas.width = thumbViewport.width;
          thumbCanvas.height = thumbViewport.height;
          const thumbCtx = thumbCanvas.getContext('2d');

          await pdfPage.render({
            canvasContext: thumbCtx,
            viewport: thumbViewport
          }).promise;

          const pageObj = {
            id: 'page_' + Math.random().toString(36).substring(2, 9),
            type: 'pdf-page',
            sourceDocId: docId,
            sourcePageIndex: pageNum - 1,
            width: viewport.width,
            height: viewport.height,
            rotation: 0,
            thumbnailUrl: thumbCanvas.toDataURL('image/jpeg', 0.88),
            canvasDataUrl: null,
            isEdited: false,
            originalName: `${file.name} (Pág. ${pageNum})`
          };

          state.pages.push(pageObj);
        }

        showToast(`"${file.name}" cargado (${numPages} pág.)`, 'success');
      } catch (err) {
        console.error('Error cargando PDF:', err);
        showToast(`Error al procesar "${file.name}": ${err.message}`, 'danger');
      }
    }

    renderPagesGrid();
    updateUIState();
  }

  async function handleImageFiles(files) {
    for (const file of files) {
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const img = new Image();
        img.src = dataUrl;
        await img.decode();

        let targetWidth = A4_PORTRAIT.width;
        let targetHeight = (img.height / img.width) * targetWidth;

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth * 2;
        canvas.height = targetHeight * 2;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const pageCanvasUrl = canvas.toDataURL('image/png');

        const pageObj = {
          id: 'page_' + Math.random().toString(36).substring(2, 9),
          type: 'image',
          sourceDocId: null,
          sourcePageIndex: null,
          width: targetWidth,
          height: targetHeight,
          rotation: 0,
          thumbnailUrl: pageCanvasUrl,
          canvasDataUrl: pageCanvasUrl,
          isEdited: true,
          originalName: file.name
        };

        state.pages.push(pageObj);
        showToast(`Imagen "${file.name}" agregada`, 'success');
      } catch (err) {
        console.error('Error agregando imagen:', err);
        showToast(`Error al cargar imagen: ${err.message}`, 'danger');
      }
    }

    renderPagesGrid();
    updateUIState();
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Quick Blank Page
  function addBlankPageQuick() {
    const canvas = document.createElement('canvas');
    canvas.width = A4_PORTRAIT.width * 1.5;
    canvas.height = A4_PORTRAIT.height * 1.5;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const blankUrl = canvas.toDataURL('image/jpeg', 0.9);

    const pageObj = {
      id: 'page_' + Math.random().toString(36).substring(2, 9),
      type: 'image',
      sourceDocId: null,
      sourcePageIndex: null,
      width: A4_PORTRAIT.width,
      height: A4_PORTRAIT.height,
      rotation: 0,
      thumbnailUrl: blankUrl,
      canvasDataUrl: blankUrl,
      isEdited: true,
      originalName: 'Hoja en Blanco'
    };

    state.pages.push(pageObj);
    renderPagesGrid();
    updateUIState();
    showToast('Hoja en blanco agregada', 'success');
  }

  // ==========================================================================
  // Workbench Toolbar
  // ==========================================================================
  function setupWorkbenchToolbar() {
    DOM.btnWorkbenchScanMore.addEventListener('click', openHpScanModal);
    DOM.btnQuickAddBlank.addEventListener('click', addBlankPageQuick);

    DOM.btnRotateAllCw.addEventListener('click', () => {
      if (state.pages.length === 0) return;
      state.pages.forEach((p) => {
        p.rotation = (p.rotation + 90) % 360;
      });
      renderPagesGrid();
      showToast('Todas las hojas giradas 90°', 'info', 2000);
    });

    DOM.btnZoomIn.addEventListener('click', () => {
      DOM.pagesGrid.classList.remove('zoom-sm');
      DOM.pagesGrid.classList.toggle('zoom-lg');
    });

    DOM.btnZoomOut.addEventListener('click', () => {
      DOM.pagesGrid.classList.remove('zoom-lg');
      DOM.pagesGrid.classList.toggle('zoom-sm');
    });
  }

  // ==========================================================================
  // Pages Grid Rendering & Drag-and-Drop
  // ==========================================================================
  function renderPagesGrid() {
    DOM.pagesGrid.innerHTML = '';

    state.pages.forEach((page, index) => {
      const card = document.createElement('div');
      card.className = 'page-card';
      card.dataset.id = page.id;
      card.dataset.index = index;
      card.draggable = true;

      const isSelected = state.selectedPageIds.has(page.id);
      if (isSelected) {
        card.classList.add('selected');
      }

      // Card Header
      const header = document.createElement('div');
      header.className = 'card-top-bar';
      header.innerHTML = `
        <div class="page-number-pill">
          <i class="fa-solid fa-file"></i>
          <span>Pág. ${index + 1}</span>
        </div>
        ${page.rotation !== 0 ? `<span style="font-size:0.75rem;color:var(--text-muted);font-family:monospace;">${page.rotation}°</span>` : ''}
      `;

      // Select Check badge if selected
      if (isSelected) {
        const checkBadge = document.createElement('div');
        checkBadge.className = 'page-card-select-check';
        checkBadge.innerHTML = '<i class="fa-solid fa-check"></i>';
        card.appendChild(checkBadge);
      }

      // Preview Area
      const previewArea = document.createElement('div');
      previewArea.className = 'card-preview-area';

      const img = document.createElement('img');
      img.className = 'card-canvas';
      img.src = page.canvasDataUrl || page.thumbnailUrl;
      img.alt = `Página ${index + 1}`;
      img.style.transform = `rotate(${page.rotation}deg)`;

      // Hover quick actions overlay
      const hoverOverlay = document.createElement('div');
      hoverOverlay.className = 'card-hover-overlay';
      hoverOverlay.innerHTML = `
        <button class="btn-overlay-action btn-edit-page" title="Dibujar o firmar esta hoja">
          <i class="fa-solid fa-pen"></i> Editar
        </button>
      `;

      previewArea.appendChild(img);
      previewArea.appendChild(hoverOverlay);

      // Card Bottom Actions
      const bottomActions = document.createElement('div');
      bottomActions.className = 'card-bottom-actions';
      bottomActions.innerHTML = `
        <div class="action-btn-group">
          <button class="card-act-btn btn-rotate-cw" title="Girar 90°">
            <i class="fa-solid fa-rotate-right"></i>
          </button>
          <button class="card-act-btn deskew-btn btn-deskew" title="Enderezar hoja chueca">
            <i class="fa-solid fa-compass-drafting"></i>
          </button>
        </div>
        <button class="card-act-btn delete-btn btn-delete-page" title="Eliminar hoja">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      `;

      card.appendChild(header);
      card.appendChild(previewArea);
      card.appendChild(bottomActions);

      // Event: Selection (Ctrl + Click or direct Click)
      card.addEventListener('click', (e) => {
        // Ignore if clicked on an action button
        if (e.target.closest('.card-act-btn') || e.target.closest('.btn-overlay-action')) return;

        if (e.ctrlKey || e.metaKey) {
          // Toggle individual in multi-selection
          if (state.selectedPageIds.has(page.id)) {
            state.selectedPageIds.delete(page.id);
          } else {
            state.selectedPageIds.add(page.id);
          }
        } else {
          // Single select or toggle
          if (state.selectedPageIds.has(page.id) && state.selectedPageIds.size === 1) {
            state.selectedPageIds.clear();
          } else {
            state.selectedPageIds.clear();
            state.selectedPageIds.add(page.id);
          }
        }
        state.lastSelectedId = page.id;
        renderPagesGrid();
        updateBulkActionBar();
      });

      // Actions inside card
      hoverOverlay.querySelector('.btn-edit-page').addEventListener('click', (e) => {
        e.stopPropagation();
        openEditorModal(page.id);
      });

      bottomActions.querySelector('.btn-rotate-cw').addEventListener('click', (e) => {
        e.stopPropagation();
        page.rotation = (page.rotation + 90) % 360;
        renderPagesGrid();
      });

      bottomActions.querySelector('.btn-deskew').addEventListener('click', (e) => {
        e.stopPropagation();
        openDeskewModal(page.id);
      });

      bottomActions.querySelector('.btn-delete-page').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSinglePage(page.id);
      });

      // Drag & Drop Reordering
      setupCardDragAndDrop(card, index);

      DOM.pagesGrid.appendChild(card);
    });

    updateBulkActionBar();
  }

  function deleteSinglePage(pageId) {
    const idx = state.pages.findIndex((p) => p.id === pageId);
    if (idx !== -1) {
      state.pages.splice(idx, 1);
      state.selectedPageIds.delete(pageId);
      renderPagesGrid();
      updateUIState();
      showToast('Hoja eliminada', 'info', 1800);
    }
  }

  function setupCardDragAndDrop(card, index) {
    card.addEventListener('dragstart', (e) => {
      state.draggedIndex = index;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      state.draggedIndex = null;
      document.querySelectorAll('.page-card').forEach((c) => c.classList.remove('drag-over'));
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (state.draggedIndex !== null && state.draggedIndex !== index) {
        card.classList.add('drag-over');
      }
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const fromIdx = state.draggedIndex;
      const toIdx = index;

      if (fromIdx !== null && fromIdx !== toIdx) {
        const [movedPage] = state.pages.splice(fromIdx, 1);
        state.pages.splice(toIdx, 0, movedPage);
        renderPagesGrid();
        showToast(`Hoja movida a la posición ${toIdx + 1}`, 'info', 1800);
      }
    });
  }

  // ==========================================================================
  // Floating Bulk Action Bar (Multi-Select)
  // ==========================================================================
  function setupBulkActionBar() {
    DOM.btnBulkRotate.addEventListener('click', () => {
      if (state.selectedPageIds.size === 0) return;
      state.pages.forEach((p) => {
        if (state.selectedPageIds.has(p.id)) {
          p.rotation = (p.rotation + 90) % 360;
        }
      });
      renderPagesGrid();
      showToast(`${state.selectedPageIds.size} hoja(s) girada(s) 90°`, 'info', 2000);
    });

    DOM.btnBulkDelete.addEventListener('click', () => {
      if (state.selectedPageIds.size === 0) return;
      const count = state.selectedPageIds.size;
      state.pages = state.pages.filter((p) => !state.selectedPageIds.has(p.id));
      state.selectedPageIds.clear();
      renderPagesGrid();
      updateUIState();
      showToast(`${count} hoja(s) eliminada(s)`, 'danger', 2500);
    });

    DOM.btnBulkSelectAll.addEventListener('click', () => {
      state.pages.forEach((p) => state.selectedPageIds.add(p.id));
      renderPagesGrid();
    });

    DOM.btnBulkDeselectAll.addEventListener('click', () => {
      state.selectedPageIds.clear();
      renderPagesGrid();
    });
  }

  function updateBulkActionBar() {
    const count = state.selectedPageIds.size;
    if (count > 0) {
      DOM.bulkActionBar.classList.remove('hidden');
      DOM.bulkCountText.innerHTML = `<strong>${count}</strong> ${count === 1 ? 'seleccionada' : 'seleccionadas'}`;
    } else {
      DOM.bulkActionBar.classList.add('hidden');
    }
  }

  // ==========================================================================
  // HP Scanner Modal (Ultra Simple & Clean)
  // ==========================================================================
  function setupHpScanner() {
    // Open/Close triggers
    DOM.btnOpenHpScan.addEventListener('click', openHpScanModal);
    DOM.btnHpScanMain.addEventListener('click', openHpScanModal);
    DOM.btnCloseHpModal.addEventListener('click', closeHpScanModal);
    DOM.btnCancelHpScan.addEventListener('click', closeHpScanModal);

    // Source selection: ADF vs Cristal
    DOM.cardSourceAdf.addEventListener('click', () => {
      DOM.cardSourceAdf.classList.add('active');
      DOM.cardSourcePlaten.classList.remove('active');
      DOM.cardSourceAdf.querySelector('input').checked = true;
    });

    DOM.cardSourcePlaten.addEventListener('click', () => {
      DOM.cardSourcePlaten.classList.add('active');
      DOM.cardSourceAdf.classList.remove('active');
      DOM.cardSourcePlaten.querySelector('input').checked = true;
      
      // Platen cannot do duplex physically
      if (DOM.hpDuplexCheck.checked) {
        setDuplexState(false);
        showToast('El cristal solo escanea 1 cara a la vez', 'info', 2500);
      }
    });

    // Duplex selector (1 cara vs 2 caras)
    DOM.btnDuplexNo.addEventListener('click', () => setDuplexState(false));
    DOM.btnDuplexYes.addEventListener('click', () => {
      // If currently Platen, switch to Feeder automatically
      if (DOM.cardSourcePlaten.classList.contains('active')) {
        DOM.cardSourceAdf.click();
      }
      setDuplexState(true);
    });

    // Restore saved duplex preference
    const savedDuplex = localStorage.getItem('tacala_hp_duplex') === 'true';
    setDuplexState(savedDuplex);

    // IP Accordion Drawer
    DOM.btnToggleIpConfig.addEventListener('click', () => {
      DOM.ipEditDrawer.classList.toggle('hidden');
    });

    // Restore saved IP
    const savedIp = localStorage.getItem('tacala_hp_printer_ip') || '192.168.1.50';
    DOM.hpPrinterIp.value = savedIp;
    DOM.displayCurrentIpText.textContent = `Impresora en red: ${savedIp}`;

    DOM.hpPrinterIp.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      DOM.displayCurrentIpText.textContent = `Impresora en red: ${val || 'Sin IP'}`;
    });

    // Test connection
    DOM.btnTestHpConnection.addEventListener('click', testHpConnection);

    // Start network scan
    DOM.btnStartHpScan.addEventListener('click', startHpNetworkScan);

    // Diagnose duplex capabilities
    DOM.btnDiagnose.addEventListener('click', runDuplexDiagnosis);
    DOM.btnCloseDiagnosis.addEventListener('click', () => {
      DOM.diagnosisPanel.classList.add('hidden');
    });
  }

  function setDuplexState(isDuplex) {
    DOM.hpDuplexCheck.checked = isDuplex;
    localStorage.setItem('tacala_hp_duplex', isDuplex ? 'true' : 'false');

    if (isDuplex) {
      DOM.btnDuplexYes.classList.add('active');
      DOM.btnDuplexNo.classList.remove('active');
      DOM.duplexStateBadge.textContent = '2 Caras (Ambos lados)';
      DOM.duplexStateBadge.classList.add('active');
    } else {
      DOM.btnDuplexNo.classList.add('active');
      DOM.btnDuplexYes.classList.remove('active');
      DOM.duplexStateBadge.textContent = '1 Cara';
      DOM.duplexStateBadge.classList.remove('active');
    }
  }

  function openHpScanModal() {
    DOM.hpScanModal.classList.remove('hidden');
  }

  function closeHpScanModal() {
    DOM.hpScanModal.classList.add('hidden');
    DOM.hpScanProgressBox.classList.add('hidden');
  }

  async function testHpConnection() {
    const ip = DOM.hpPrinterIp.value.trim();
    if (!ip) {
      showToast('Por favor escribe la IP de la impresora HP', 'danger');
      return;
    }

    localStorage.setItem('tacala_hp_printer_ip', ip);
    updateHpFeedback('checking', `Probando conexión con HP en ${ip}...`);

    try {
      const res = await fetch('/api/scanner/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip })
      });
      const data = await res.json();

      if (data.success) {
        updateHpFeedback('online', `¡HP MFP 4103fdw conectada! (Puerto: ${data.port})`);
        showToast('Impresora HP conectada y lista para escanear', 'success');
      } else {
        updateHpFeedback('error', `Error: ${data.error}`);
        showToast(`No se pudo conectar: ${data.error}`, 'danger');
      }
    } catch (err) {
      updateHpFeedback('error', `Fallo de conexión: ${err.message}`);
      showToast(`Error al consultar impresora: ${err.message}`, 'danger');
    }
  }

  function updateHpFeedback(status, text) {
    const dot = DOM.hpStatusFeedback.querySelector('.status-dot');
    dot.className = 'status-dot';
    if (status === 'checking') dot.classList.add('dot-checking');
    else if (status === 'online') dot.classList.add('dot-online');
    else if (status === 'error') dot.classList.add('dot-error');
    else dot.classList.add('dot-idle');

    DOM.hpStatusText.textContent = text;
  }

  async function runDuplexDiagnosis() {
    const ip = DOM.hpPrinterIp.value.trim();
    if (!ip) {
      showToast('Primero ingresa la IP de la impresora', 'danger');
      return;
    }

    DOM.btnDiagnose.disabled = true;
    DOM.btnDiagnose.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Diagnosticando...';
    DOM.diagnosisPanel.classList.add('hidden');

    try {
      const res = await fetch('/api/scanner/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip })
      });
      const data = await res.json();

      if (!data.success) {
        showToast(`Error: ${data.error}`, 'danger');
        return;
      }

      const d = data.diagnosis;
      const ds = d.duplexSupport;
      const adf = d.adfInfo;
      const modelName = d.model || 'HP LaserJet Pro MFP 4103fdw';
      const adfState = d.adfState || 'Unknown';

      const yesNo = (val) => val
        ? '<span class="diag-value diag-yes">✅ SÍ</span>'
        : '<span class="diag-value diag-no">❌ NO</span>';

      let html = '';

      // Model Header
      html += `<div style="display:flex;align-items:center;gap:0.5rem;font-weight:700;color:#f8fafc;margin-bottom:0.75rem;">
        <i class="fa-solid fa-print" style="color:#38bdf8;"></i>
        <span>${escapeHtml(modelName)}</span>
      </div>`;

      // ADF Sensor State Alert
      if (adfState === 'ScannerAdfLoaded') {
        html += `<div class="diag-alert diag-alert-success">
          <i class="fa-solid fa-circle-check"></i>
          <div><strong>Hojas detectadas en ADF:</strong> El sensor del alimentador superior detecta papel. Listo para escanear a doble cara.</div>
        </div>`;
      } else if (adfState === 'ScannerAdfEmpty') {
        html += `<div class="diag-alert diag-alert-warning">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <div><strong>Bandeja ADF vacía:</strong> No se detectan hojas en el alimentador superior. Para escanear a doble cara, coloca las hojas en la bandeja superior (no en el cristal) hasta que el sensor las detecte.</div>
        </div>`;
      } else if (adfState.includes('DoorOpen')) {
        html += `<div class="diag-alert diag-alert-danger">
          <i class="fa-solid fa-door-open"></i>
          <div><strong>Tapa del ADF abierta:</strong> Cierra bien la cubierta del alimentador.</div>
        </div>`;
      }

      // Duplex Support Alert
      if (ds.hasDuplexTag || d.summary.canDoDuplex) {
        html += `<div class="diag-alert diag-alert-success">
          <i class="fa-solid fa-circle-check"></i>
          <div><strong>Doble Cara Compatible:</strong> Tu impresora HP utiliza la directiva oficial nativa <code>&lt;scan:Duplex&gt;true&lt;/scan:Duplex&gt;</code>. Tacala la configurará automáticamente.</div>
        </div>`;
      } else {
        html += `<div class="diag-alert diag-alert-warning">
          <i class="fa-solid fa-circle-question"></i>
          <div><strong>Soporte Dúplex no confirmado:</strong> El escáner no reportó tags de dúplex estándar.</div>
        </div>`;
      }

      // Technical Details
      html += '<div class="diag-section-title">📋 Especificaciones eSCL Dúplex</div>';
      html += `<div class="diag-row"><span class="diag-label">Opción ADF Duplex (Oficial HP)</span>${yesNo(ds.hasAdfOption || ds.hasAdfOptions || ds.hasDuplexTag)}</div>`;
      html += `<div class="diag-row"><span class="diag-label">Directiva "scan:Duplex"</span>${yesNo(ds.hasDuplexTag)}</div>`;
      html += `<div class="diag-row"><span class="diag-label">Capacidades ADF Duplex</span>${yesNo(ds.hasAdfDuplexCaps || ds.hasAdfOption)}</div>`;
      html += `<div class="diag-row"><span class="diag-label">Modo Multi-Variante Auto-Recuperación</span><span class="diag-badge-yes"><i class="fa-solid fa-check"></i> Activo (4 variantes)</span></div>`;

      html += '<div class="diag-section-title">🖨️ Bandejas de Entrada</div>';
      html += `<div class="diag-row"><span class="diag-label">Alimentador ADF</span>${yesNo(adf.hasAdf)}</div>`;
      html += `<div class="diag-row"><span class="diag-label">Cristal (Platen)</span>${yesNo(adf.hasPlaten)}</div>`;

      if (adf.inputSources && adf.inputSources.length > 0) {
        html += '<div class="diag-section-title">📡 Fuentes de Entrada (InputSource)</div>';
        adf.inputSources.forEach(s => {
          html += `<div style="font-family:monospace;font-size:0.75rem;color:#94a3b8;">${escapeHtml(s)}</div>`;
        });
      }

      // Raw duplex lines from XML
      if (ds.rawDuplexLines && ds.rawDuplexLines.length > 0) {
        html += '<div class="diag-section-title">🔍 Líneas XML Duplex en tu HP</div>';
        html += '<pre>';
        ds.rawDuplexLines.forEach(l => {
          html += `L${l.line}: ${escapeHtml(l.content)}\n`;
        });
        html += '</pre>';
      }

      const fullXml = d.rawXml || d.rawCapabilitiesXml;
      if (fullXml) {
        html += '<div style="margin-top:10px;">';
        html += '<details><summary style="cursor:pointer;color:#38bdf8;font-size:0.8rem;"><i class="fa-solid fa-code"></i> Ver XML Completo de la Impresora (ScannerCapabilities)</summary>';
        html += `<textarea readonly style="width:100%;height:180px;background:#0f172a;color:#94a3b8;font-family:monospace;font-size:0.7rem;padding:8px;border-radius:6px;border:1px solid #334155;margin-top:6px;">${escapeHtml(fullXml)}</textarea>`;
        html += '</details>';
        html += '</div>';
      }

      DOM.diagnosisContent.innerHTML = html;
      DOM.diagnosisPanel.classList.remove('hidden');
      showToast('Diagnóstico completado', 'success');

    } catch (err) {
      showToast(`Error al diagnosticar: ${err.message}`, 'danger');
    } finally {
      DOM.btnDiagnose.disabled = false;
      DOM.btnDiagnose.innerHTML = '<i class="fa-solid fa-stethoscope"></i> Diagnosticar Doble Cara';
    }
  }

  async function startHpNetworkScan() {
    const ip = DOM.hpPrinterIp.value.trim();
    if (!ip) {
      showToast('Ingresa la IP de la impresora', 'danger');
      return;
    }

    localStorage.setItem('tacala_hp_printer_ip', ip);

    const isDuplexRequested = DOM.hpDuplexCheck.checked;
    // Si se pide doble cara, obligatoriamente se usa Feeder/ADF
    let source = DOM.cardSourceAdf.classList.contains('active') ? 'Feeder' : 'Platen';
    if (isDuplexRequested) {
      source = 'Feeder';
    }
    const duplex = isDuplexRequested;
    const colorMode = 'RGB24';
    const resolution = 300;

    // Show laser progress box
    DOM.hpScanProgressBox.classList.remove('hidden');
    DOM.hpScanProgressTitle.textContent = `Escaneando desde ${source === 'Feeder' ? 'Alimentador ADF' : 'Cristal'}...`;
    DOM.hpScanProgressSubtitle.textContent = `La HP está procesando las hojas ${duplex ? '(Doble cara - ambos lados)' : '(1 cara)'}. Espera unos segundos...`;
    DOM.btnStartHpScan.disabled = true;

    try {
      const res = await fetch('/api/scanner/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, source, colorMode, resolution, duplex })
      });
      const data = await res.json();

      if (data.success && data.pages && data.pages.length > 0) {
        await addScannedPages(data.pages);
        closeHpScanModal();
        showToast(`¡Se agregaron ${data.pages.length} hoja(s) escaneada(s)!`, 'success', 4500);
      } else {
        showToast(`Error de escaneo: ${data.error || 'No se obtuvieron páginas'}`, 'danger', 5000);
      }
    } catch (err) {
      showToast(`Error al comunicar con la impresora: ${err.message}`, 'danger', 5000);
    } finally {
      DOM.btnStartHpScan.disabled = false;
      DOM.hpScanProgressBox.classList.add('hidden');
    }
  }

  async function addScannedPages(pages) {
    for (const pageData of pages) {
      try {
        const img = new Image();
        img.src = pageData.dataUrl;
        await img.decode();

        let targetWidth = A4_PORTRAIT.width;
        let targetHeight = (img.height / img.width) * targetWidth;

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth * 2;
        canvas.height = targetHeight * 2;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const pageCanvasUrl = canvas.toDataURL('image/jpeg', 0.9);

        const pageObj = {
          id: 'page_' + Math.random().toString(36).substring(2, 9),
          type: 'image',
          sourceDocId: null,
          sourcePageIndex: null,
          width: targetWidth,
          height: targetHeight,
          rotation: 0,
          thumbnailUrl: pageCanvasUrl,
          canvasDataUrl: pageCanvasUrl,
          isEdited: true,
          originalName: pageData.filename || 'Escaneo HP 4103'
        };

        state.pages.push(pageObj);
      } catch (e) {
        console.error('Error adding scanned page:', e);
      }
    }

    renderPagesGrid();
    updateUIState();
  }

  // ==========================================================================
  // Deskew / Enderezado de Hojas Chuecas
  // ==========================================================================
  function setupDeskewEngine() {
    const deskew = state.deskew;
    deskew.canvas = DOM.deskewCanvas;
    deskew.ctx = DOM.deskewCanvas.getContext('2d');

    DOM.btnCloseDeskew.addEventListener('click', closeDeskewModal);
    DOM.btnCancelDeskew.addEventListener('click', closeDeskewModal);

    // Angle slider
    DOM.deskewSlider.addEventListener('input', (e) => {
      deskew.angle = parseFloat(e.target.value);
      DOM.deskewAngleVal.textContent = `${deskew.angle > 0 ? '+' : ''}${deskew.angle.toFixed(1)}°`;
      renderDeskewCanvas();
    });

    // Offset X slider (move content left/right)
    DOM.offsetXSlider.addEventListener('input', (e) => {
      deskew.offsetX = parseInt(e.target.value, 10);
      DOM.offsetXVal.textContent = `${deskew.offsetX > 0 ? '+' : ''}${deskew.offsetX}px`;
      renderDeskewCanvas();
    });

    // Offset Y slider (move content up/down)
    DOM.offsetYSlider.addEventListener('input', (e) => {
      deskew.offsetY = parseInt(e.target.value, 10);
      DOM.offsetYVal.textContent = `${deskew.offsetY > 0 ? '+' : ''}${deskew.offsetY}px`;
      renderDeskewCanvas();
    });

    // Reset all: angle + offsets
    DOM.btnResetDeskewAngle.addEventListener('click', () => {
      deskew.angle = 0;
      deskew.offsetX = 0;
      deskew.offsetY = 0;
      DOM.deskewSlider.value = 0;
      DOM.deskewAngleVal.textContent = '0.0°';
      DOM.offsetXSlider.value = 0;
      DOM.offsetYSlider.value = 0;
      DOM.offsetXVal.textContent = '0px';
      DOM.offsetYVal.textContent = '0px';
      renderDeskewCanvas();
    });

    // Direct mouse drag on canvas to move content
    let isDraggingContent = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let startOffsetX = 0;
    let startOffsetY = 0;

    DOM.deskewCanvas.style.cursor = 'grab';

    DOM.deskewCanvas.addEventListener('mousedown', (e) => {
      isDraggingContent = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      startOffsetX = deskew.offsetX;
      startOffsetY = deskew.offsetY;
      DOM.deskewCanvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDraggingContent) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      // Adjust movement to match scale
      deskew.offsetX = Math.max(-300, Math.min(300, Math.round(startOffsetX + dx)));
      deskew.offsetY = Math.max(-300, Math.min(300, Math.round(startOffsetY + dy)));
      DOM.offsetXSlider.value = deskew.offsetX;
      DOM.offsetYSlider.value = deskew.offsetY;
      DOM.offsetXVal.textContent = `${deskew.offsetX > 0 ? '+' : ''}${deskew.offsetX}px`;
      DOM.offsetYVal.textContent = `${deskew.offsetY > 0 ? '+' : ''}${deskew.offsetY}px`;
      renderDeskewCanvas();
    });

    window.addEventListener('mouseup', () => {
      if (isDraggingContent) {
        isDraggingContent = false;
        DOM.deskewCanvas.style.cursor = 'grab';
      }
    });

    DOM.btnApplyDeskew.addEventListener('click', applyDeskewChanges);
  }

  async function openDeskewModal(pageId) {
    const page = state.pages.find((p) => p.id === pageId);
    if (!page) return;

    state.deskew.activePageId = pageId;
    state.deskew.angle = 0;
    state.deskew.offsetX = 0;
    state.deskew.offsetY = 0;
    DOM.deskewSlider.value = 0;
    DOM.deskewAngleVal.textContent = '0.0°';
    DOM.offsetXSlider.value = 0;
    DOM.offsetYSlider.value = 0;
    DOM.offsetXVal.textContent = '0px';
    DOM.offsetYVal.textContent = '0px';

    const pageIdx = state.pages.indexOf(page);
    DOM.deskewPageBadge.textContent = `#${pageIdx + 1}`;

    const img = new Image();
    img.src = page.canvasDataUrl || page.thumbnailUrl;
    await img.decode();
    state.deskew.img = img;

    DOM.deskewModal.classList.remove('hidden');
    renderDeskewCanvas();
  }

  function closeDeskewModal() {
    DOM.deskewModal.classList.add('hidden');
    state.deskew.activePageId = null;
    state.deskew.img = null;
  }

  function renderDeskewCanvas() {
    const deskew = state.deskew;
    if (!deskew.img) return;

    const img = deskew.img;
    const angleRad = (deskew.angle * Math.PI) / 180;

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    deskew.canvas.width = w;
    deskew.canvas.height = h;

    const ctx = deskew.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    // Move to center, apply offset, then rotate
    ctx.translate(w / 2 + deskew.offsetX, h / 2 + deskew.offsetY);
    ctx.rotate(angleRad);

    // Auto-scale slightly to eliminate corner white triangles
    if (Math.abs(deskew.angle) > 0.05) {
      const scale = 1 + Math.abs(deskew.angle) / 38;
      ctx.scale(scale, scale);
    }

    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function applyDeskewChanges() {
    const deskew = state.deskew;
    const page = state.pages.find((p) => p.id === deskew.activePageId);
    if (!page) return;

    const dataUrl = deskew.canvas.toDataURL('image/jpeg', 0.92);
    page.canvasDataUrl = dataUrl;
    page.thumbnailUrl = dataUrl;
    page.isEdited = true;

    closeDeskewModal();
    renderPagesGrid();
    showToast('Hoja enderezada correctamente', 'success');
  }

  // ==========================================================================
  // Editor Modal (Dibujar, Firma, Resaltar)
  // ==========================================================================
  function setupEditorModal() {
    const editor = state.editor;
    editor.bgCanvas = DOM.bgCanvas;
    editor.bgCtx = DOM.bgCanvas.getContext('2d');
    editor.drawCanvas = DOM.drawCanvas;
    editor.drawCtx = DOM.drawCanvas.getContext('2d');

    DOM.btnCloseEditor.addEventListener('click', closeEditorModal);
    DOM.btnCancelEditor.addEventListener('click', closeEditorModal);
    DOM.btnSaveEditor.addEventListener('click', saveEditorChanges);

    // Tool selection
    const toolBtns = DOM.editorModal.querySelectorAll('.tool-icon-btn');
    toolBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        toolBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        editor.tool = btn.dataset.tool;
      });
    });

    // Swatches
    const swatches = DOM.editorModal.querySelectorAll('.swatch');
    swatches.forEach((swatch) => {
      swatch.addEventListener('click', () => {
        swatches.forEach((s) => s.classList.remove('active'));
        swatch.classList.add('active');
        editor.color = swatch.dataset.color;
      });
    });

    DOM.customColorPicker.addEventListener('input', (e) => {
      editor.color = e.target.value;
      swatches.forEach((s) => s.classList.remove('active'));
    });

    // Stroke size
    DOM.strokeSizeRange.addEventListener('input', (e) => {
      editor.strokeSize = parseInt(e.target.value, 10);
      DOM.strokeSizeVal.textContent = `${editor.strokeSize}px`;
    });

    // Undo
    DOM.btnUndoCanvas.addEventListener('click', () => {
      if (editor.historyStep > 0) {
        editor.historyStep--;
        const img = new Image();
        img.src = editor.history[editor.historyStep];
        img.onload = () => {
          editor.drawCtx.clearRect(0, 0, editor.drawCanvas.width, editor.drawCanvas.height);
          editor.drawCtx.drawImage(img, 0, 0);
        };
      } else if (editor.historyStep === 0) {
        editor.historyStep = -1;
        editor.drawCtx.clearRect(0, 0, editor.drawCanvas.width, editor.drawCanvas.height);
      }
    });

    setupCanvasDrawing();
  }

  function setupCanvasDrawing() {
    const editor = state.editor;
    const drawCanvas = editor.drawCanvas;

    let isDrawing = false;
    let lastX = 0;
    let lastY = 0;

    function getCoords(e) {
      const rect = drawCanvas.getBoundingClientRect();
      const scaleX = drawCanvas.width / rect.width;
      const scaleY = drawCanvas.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    }

    drawCanvas.addEventListener('mousedown', (e) => {
      if (editor.tool === 'text') {
        const coords = getCoords(e);
        const text = prompt('Escribe el texto a insertar:');
        if (text) {
          editor.drawCtx.font = `bold ${editor.strokeSize * 6}px sans-serif`;
          editor.drawCtx.fillStyle = editor.color;
          editor.drawCtx.fillText(text, coords.x, coords.y);
          saveDrawHistory();
        }
        return;
      }

      isDrawing = true;
      const coords = getCoords(e);
      lastX = coords.x;
      lastY = coords.y;
    });

    drawCanvas.addEventListener('mousemove', (e) => {
      if (!isDrawing) return;
      const coords = getCoords(e);
      const ctx = editor.drawCtx;

      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(coords.x, coords.y);

      if (editor.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = editor.strokeSize * 4;
      } else if (editor.tool === 'highlighter') {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = editor.color + '55'; // semi-transparent
        ctx.lineWidth = editor.strokeSize * 3;
        ctx.lineCap = 'square';
      } else {
        // pen / signature
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = editor.color;
        ctx.lineWidth = editor.strokeSize;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      }

      ctx.stroke();
      lastX = coords.x;
      lastY = coords.y;
    });

    const stopDrawing = () => {
      if (isDrawing) {
        isDrawing = false;
        saveDrawHistory();
      }
    };

    drawCanvas.addEventListener('mouseup', stopDrawing);
    drawCanvas.addEventListener('mouseleave', stopDrawing);
  }

  function saveDrawHistory() {
    const editor = state.editor;
    editor.historyStep++;
    editor.history = editor.history.slice(0, editor.historyStep);
    editor.history.push(editor.drawCanvas.toDataURL());
  }

  async function openEditorModal(pageId) {
    const page = state.pages.find((p) => p.id === pageId);
    if (!page) return;

    state.editor.activePageId = pageId;
    state.editor.history = [];
    state.editor.historyStep = -1;

    const pageIdx = state.pages.indexOf(page);
    DOM.modalPageNumberBadge.textContent = `#${pageIdx + 1}`;

    const img = new Image();
    img.src = page.canvasDataUrl || page.thumbnailUrl;
    await img.decode();

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    DOM.bgCanvas.width = w;
    DOM.bgCanvas.height = h;
    DOM.drawCanvas.width = w;
    DOM.drawCanvas.height = h;

    state.editor.bgCtx.drawImage(img, 0, 0);
    state.editor.drawCtx.clearRect(0, 0, w, h);

    DOM.editorModal.classList.remove('hidden');
  }

  function closeEditorModal() {
    DOM.editorModal.classList.add('hidden');
    state.editor.activePageId = null;
  }

  function saveEditorChanges() {
    const editor = state.editor;
    const page = state.pages.find((p) => p.id === editor.activePageId);
    if (!page) return;

    // Merge bgCanvas and drawCanvas
    const merged = document.createElement('canvas');
    merged.width = editor.bgCanvas.width;
    merged.height = editor.bgCanvas.height;
    const ctx = merged.getContext('2d');
    ctx.drawImage(editor.bgCanvas, 0, 0);
    ctx.drawImage(editor.drawCanvas, 0, 0);

    const dataUrl = merged.toDataURL('image/jpeg', 0.92);
    page.canvasDataUrl = dataUrl;
    page.thumbnailUrl = dataUrl;
    page.isEdited = true;

    closeEditorModal();
    renderPagesGrid();
    showToast('Anotaciones y cambios guardados', 'success');
  }

  // ==========================================================================
  // Direct Save to PC & Download PDF
  // ==========================================================================
  function setupSaveAndDownload() {
    // "Guardar en PC" -> native folder / file picker directly on computer
    DOM.btnSaveToFolder.addEventListener('click', saveDirectlyToPc);

    // "Descargar" -> standard browser download
    DOM.btnDownloadPdf.addEventListener('click', downloadPdfFile);
  }

  function dataUriToUint8Array(dataUri) {
    const commaIdx = dataUri.indexOf(',');
    const base64 = commaIdx >= 0 ? dataUri.slice(commaIdx + 1) : dataUri;
    const binaryStr = atob(base64);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes;
  }

  async function generateMergedPdfBytes() {
    if (state.pages.length === 0) {
      throw new Error('No hay hojas en el documento');
    }

    if (typeof PDFLib === 'undefined' || !PDFLib.PDFDocument) {
      throw new Error('La librería PDF-Lib no está lista. Por favor recarga la página.');
    }

    const { PDFDocument, degrees } = PDFLib;
    const mergedDoc = await PDFDocument.create();

    // Cache loaded PDFLib source documents
    const loadedPdfLibDocs = new Map();

    for (const page of state.pages) {
      try {
        if (page.isEdited || page.canvasDataUrl || page.type === 'image') {
          // Embed image (from scan, blank page, or edit)
          const imgUrl = page.canvasDataUrl || page.thumbnailUrl;
          const imgBytes = dataUriToUint8Array(imgUrl);

          let embeddedImg;
          if (imgUrl.startsWith('data:image/png')) {
            embeddedImg = await mergedDoc.embedPng(imgBytes);
          } else {
            embeddedImg = await mergedDoc.embedJpg(imgBytes);
          }

          const newPdfPage = mergedDoc.addPage([page.width, page.height]);
          newPdfPage.drawImage(embeddedImg, {
            x: 0,
            y: 0,
            width: page.width,
            height: page.height
          });

          if (page.rotation !== 0) {
            newPdfPage.setRotation(degrees(page.rotation));
          }
        } else {
          // Copy original vector PDF page
          const sourceInfo = state.sourceDocuments.get(page.sourceDocId);
          if (sourceInfo) {
            if (!loadedPdfLibDocs.has(page.sourceDocId)) {
              const pdfDoc = await PDFDocument.load(sourceInfo.bytes);
              loadedPdfLibDocs.set(page.sourceDocId, pdfDoc);
            }

            const pdfDoc = loadedPdfLibDocs.get(page.sourceDocId);
            const [copiedPage] = await mergedDoc.copyPages(pdfDoc, [page.sourcePageIndex]);

            if (page.rotation !== 0) {
              const currentRot = copiedPage.getRotation().angle || 0;
              copiedPage.setRotation(degrees((currentRot + page.rotation) % 360));
            }

            mergedDoc.addPage(copiedPage);
          }
        }
      } catch (pageErr) {
        console.error('Error procesando hoja para PDF:', pageErr);
        throw new Error(`Error al procesar hoja: ${pageErr.message}`);
      }
    }

    return await mergedDoc.save();
  }

  async function saveToServerFolder(pdfBytes, filename) {
    try {
      await fetch('/api/save-document', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/pdf',
          'x-filename': filename
        },
        body: pdfBytes
      });
      console.log(`[Tacala] Documento guardado automáticamente en carpeta local del servidor: ${filename}`);
    } catch (e) {
      console.warn('Aviso: no se pudo sincronizar copia con servidor local:', e);
    }
  }

  async function saveDirectlyToPc() {
    if (state.pages.length === 0) {
      showToast('No hay hojas para guardar', 'info');
      return;
    }

    DOM.downloadSpinner.classList.remove('hidden');

    try {
      showToast('Generando PDF para guardar...', 'info', 2000);
      const pdfBytes = await generateMergedPdfBytes();
      const filename = `Tacala_Documento_${new Date().toISOString().slice(0, 10)}.pdf`;

      // 1. Guardar copia en el servidor local (documentos_guardados/)
      await saveToServerFolder(pdfBytes, filename);

      const blob = new Blob([pdfBytes], { type: 'application/pdf' });

      // 2. Si el navegador soporta el selector nativo de Windows (File System Access API)
      if ('showSaveFilePicker' in window) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [
              {
                description: 'Documento PDF (*.pdf)',
                accept: { 'application/pdf': ['.pdf'] }
              }
            ]
          });

          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();

          showToast('¡Documento guardado directamente en tu PC con éxito!', 'success', 4000);
          return;
        } catch (pickerErr) {
          if (pickerErr.name === 'AbortError') return;
          console.warn('File picker error, falling back to direct download:', pickerErr);
        }
      }

      // 3. Fallback: descarga directa al equipo
      triggerBrowserDownload(blob, filename);
      showToast('¡Documento PDF guardado en tu equipo!', 'success', 4000);
    } catch (err) {
      console.error('Error saving PDF:', err);
      showToast(`Error al guardar PDF: ${err.message}`, 'danger', 5000);
    } finally {
      DOM.downloadSpinner.classList.add('hidden');
    }
  }

  async function downloadPdfFile() {
    if (state.pages.length === 0) {
      showToast('No hay hojas para descargar', 'info');
      return;
    }

    DOM.downloadBtnText.textContent = 'Procesando...';
    DOM.downloadSpinner.classList.remove('hidden');

    try {
      const pdfBytes = await generateMergedPdfBytes();
      const filename = `Tacala_Documento_${new Date().toISOString().slice(0, 10)}.pdf`;

      // Guardar copia en servidor también
      await saveToServerFolder(pdfBytes, filename);

      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      triggerBrowserDownload(blob, filename);
      showToast('¡Descarga completada con éxito!', 'success');
    } catch (err) {
      console.error('Error downloading PDF:', err);
      showToast(`Error al descargar: ${err.message}`, 'danger');
    } finally {
      DOM.downloadBtnText.textContent = 'Descargar';
      DOM.downloadSpinner.classList.add('hidden');
    }
  }

  function triggerBrowserDownload(blob, filename) {
    const fn = filename || `Tacala_Documento_${new Date().toISOString().slice(0, 10)}.pdf`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fn;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 300);
  }

  // ==========================================================================
  // Clear Document
  // ==========================================================================
  function setupClearHandler() {
    DOM.btnClearAll.addEventListener('click', () => {
      if (state.pages.length === 0) return;
      if (confirm('¿Deseas vaciar la mesa de trabajo y empezar un nuevo documento?')) {
        state.pages = [];
        state.sourceDocuments.clear();
        state.selectedPageIds.clear();
        renderPagesGrid();
        updateUIState();
        showToast('Documento reiniciado', 'info', 2000);
      }
    });
  }

  // Run on page load
  document.addEventListener('DOMContentLoaded', init);
})();
