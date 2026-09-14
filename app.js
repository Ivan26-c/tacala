/**
 * TACALA - Modern Client-Side PDF Studio & Editor
 * Uses PDF.js for ultra-sharp canvas rendering and PDF-Lib for high performance manipulation.
 */

// Initialize PDF.js worker
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

(function () {
  'use strict';

  // ==========================================================================
  // Application State
  // ==========================================================================
  const state = {
    pages: [], // Array of Page objects
    sourceDocuments: new Map(), // docId -> { name, bytes, pdfJsDoc, pdfLibDoc }
    draggedIndex: null,
    selectedPageIds: new Set(),
    lastSelectedId: null,
    deskew: {
      activePageId: null,
      angle: 0,
      img: null,
      canvas: null,
      ctx: null
    },
    editor: {
      activePageId: null,
      tool: 'pen', // 'pen' | 'highlighter' | 'text' | 'eraser'
      color: '#1e293b',
      strokeSize: 4,
      fontSize: 24,
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
  const A4_LANDSCAPE = { width: 841.89, height: 595.28 };

  // ==========================================================================
  // DOM Elements
  // ==========================================================================
  const DOM = {
    // Nav & General
    navStatus: document.getElementById('navStatus'),
    pageCountStatus: document.getElementById('pageCountStatus'),
    pdfFileInput: document.getElementById('pdfFileInput'),
    imageFileInput: document.getElementById('imageFileInput'),
    btnUploadPdf: document.getElementById('btnUploadPdf'),
    btnAddPageDropdown: document.getElementById('btnAddPageDropdown'),
    addPageMenu: document.getElementById('addPageMenu'),
    btnMenuBlankPage: document.getElementById('btnMenuBlankPage'),
    btnMenuUploadImage: document.getElementById('btnMenuUploadImage'),
    btnMenuAppendPdf: document.getElementById('btnMenuAppendPdf'),
    btnClearAll: document.getElementById('btnClearAll'),
    btnSaveToFolder: document.getElementById('btnSaveToFolder'),
    btnDownloadPdf: document.getElementById('btnDownloadPdf'),
    downloadBtnText: document.getElementById('downloadBtnText'),
    downloadSpinner: document.getElementById('downloadSpinner'),

    // Views
    emptyState: document.getElementById('emptyState'),
    dropzone: document.getElementById('dropzone'),
    btnSelectPdfMain: document.getElementById('btnSelectPdfMain'),
    btnStartBlankDoc: document.getElementById('btnStartBlankDoc'),
    workbenchView: document.getElementById('workbenchView'),
    pagesGrid: document.getElementById('pagesGrid'),
    chipCurrentCount: document.getElementById('chipCurrentCount'),
    btnRotateAllCw: document.getElementById('btnRotateAllCw'),
    btnWorkbenchScanMore: document.getElementById('btnWorkbenchScanMore'),
    btnQuickAddBlank: document.getElementById('btnQuickAddBlank'),
    btnZoomIn: document.getElementById('btnZoomIn'),
    btnZoomOut: document.getElementById('btnZoomOut'),

    // Bulk Action Bar
    bulkActionBar: document.getElementById('bulkActionBar'),
    bulkCountText: document.getElementById('bulkCountText'),
    btnBulkRotate: document.getElementById('btnBulkRotate'),
    btnBulkDelete: document.getElementById('btnBulkDelete'),
    btnBulkSelectAll: document.getElementById('btnBulkSelectAll'),
    btnBulkDeselectAll: document.getElementById('btnBulkDeselectAll'),

    // Deskew Modal
    deskewModal: document.getElementById('deskewModal'),
    deskewPageBadge: document.getElementById('deskewPageBadge'),
    btnCloseDeskew: document.getElementById('btnCloseDeskew'),
    btnCancelDeskew: document.getElementById('btnCancelDeskew'),
    btnApplyDeskew: document.getElementById('btnApplyDeskew'),
    deskewAngleVal: document.getElementById('deskewAngleVal'),
    deskewSlider: document.getElementById('deskewSlider'),
    deskewGridToggle: document.getElementById('deskewGridToggle'),
    deskewCropToggle: document.getElementById('deskewCropToggle'),
    deskewCanvas: document.getElementById('deskewCanvas'),
    alignmentGridOverlay: document.getElementById('alignmentGridOverlay'),

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
    fontSizeSelect: document.getElementById('fontSizeSelect'),
    textOptionsGroup: document.getElementById('textOptionsGroup'),
    btnUndoCanvas: document.getElementById('btnUndoCanvas'),
    btnClearCanvas: document.getElementById('btnClearCanvas'),

    // Blank Page Modal
    blankPageModal: document.getElementById('blankPageModal'),
    btnCloseBlankModal: document.getElementById('btnCloseBlankModal'),
    btnCancelBlankModal: document.getElementById('btnCancelBlankModal'),
    btnConfirmAddBlank: document.getElementById('btnConfirmAddBlank'),
    pageOrientationSelect: document.getElementById('pageOrientationSelect'),
    pageInsertPositionSelect: document.getElementById('pageInsertPositionSelect'),

    // Clear Modal
    confirmClearModal: document.getElementById('confirmClearModal'),
    btnCloseClearModal: document.getElementById('btnCloseClearModal'),
    btnCancelClear: document.getElementById('btnCancelClear'),
    btnConfirmClear: document.getElementById('btnConfirmClear'),

    // HP Scan Modal
    btnOpenHpScan: document.getElementById('btnOpenHpScan'),
    btnHpScanMain: document.getElementById('btnHpScanMain'),
    btnMenuHpScan: document.getElementById('btnMenuHpScan'),
    hpScanModal: document.getElementById('hpScanModal'),
    btnCloseHpModal: document.getElementById('btnCloseHpModal'),
    btnCancelHpScan: document.getElementById('btnCancelHpScan'),
    hpPrinterIp: document.getElementById('hpPrinterIp'),
    btnTestHpConnection: document.getElementById('btnTestHpConnection'),
    hpStatusFeedback: document.getElementById('hpStatusFeedback'),
    hpStatusText: document.getElementById('hpStatusText'),
    hpResolutionSelect: document.getElementById('hpResolutionSelect'),
    hpDuplexCheck: document.getElementById('hpDuplexCheck'),
    duplexStateBadge: document.getElementById('duplexStateBadge'),
    hpScanProgressBox: document.getElementById('hpScanProgressBox'),
    hpScanProgressTitle: document.getElementById('hpScanProgressTitle'),
    hpScanProgressSubtitle: document.getElementById('hpScanProgressSubtitle'),
    btnStartHpScan: document.getElementById('btnStartHpScan'),
    btnScanWia: document.getElementById('btnScanWia'),
    btnToggleFolderScans: document.getElementById('btnToggleFolderScans'),
    btnRefreshFolderScans: document.getElementById('btnRefreshFolderScans'),
    folderFilesList: document.getElementById('folderFilesList'),

    // Toast
    toastContainer: document.getElementById('toastContainer')
  };

  // ==========================================================================
  // Initialization & Event Listeners
  // ==========================================================================
  function init() {
    setupUploadHandlers();
    setupDropdown();
    setupWorkbenchBar();
    setupBlankPageModal();
    setupClearModal();
    setupHpScanner();
    setupMultiSelection();
    setupDeskewEngine();
    setupEditorModal();
    setupCanvasInteractions();
    setupDownload();
    updateUIState();
  }

  // ==========================================================================
  // UI Helpers & Toasts
  // ==========================================================================
  function showToast(message, type = 'info', duration = 3200) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

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
      toast.style.transform = 'translateX(50px)';
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
    DOM.chipCurrentCount.textContent = count;
    
    if (count === 0) {
      DOM.emptyState.classList.remove('hidden');
      DOM.workbenchView.classList.add('hidden');
      DOM.pageCountStatus.textContent = 'Sin documentos cargados';
      DOM.navStatus.querySelector('.status-indicator').classList.remove('active');
    } else {
      DOM.emptyState.classList.add('hidden');
      DOM.workbenchView.classList.remove('hidden');
      DOM.pageCountStatus.textContent = `${count} ${count === 1 ? 'página activa' : 'páginas activas'}`;
      DOM.navStatus.querySelector('.status-indicator').classList.add('active');
    }
  }

  // ==========================================================================
  // Dropdown Handling
  // ==========================================================================
  function setupDropdown() {
    DOM.btnAddPageDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
      DOM.btnAddPageDropdown.parentElement.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
      if (!DOM.btnAddPageDropdown.parentElement.contains(e.target)) {
        DOM.btnAddPageDropdown.parentElement.classList.remove('open');
      }
    });

    DOM.btnMenuBlankPage.addEventListener('click', () => {
      DOM.btnAddPageDropdown.parentElement.classList.remove('open');
      openBlankPageModal();
    });

    DOM.btnMenuUploadImage.addEventListener('click', () => {
      DOM.btnAddPageDropdown.parentElement.classList.remove('open');
      DOM.imageFileInput.click();
    });

    DOM.btnMenuAppendPdf.addEventListener('click', () => {
      DOM.btnAddPageDropdown.parentElement.classList.remove('open');
      DOM.pdfFileInput.click();
    });
  }

  // ==========================================================================
  // Upload & File Ingestion
  // ==========================================================================
  function setupUploadHandlers() {
    // Buttons triggering inputs
    DOM.btnUploadPdf.addEventListener('click', () => DOM.pdfFileInput.click());
    DOM.btnSelectPdfMain.addEventListener('click', () => DOM.pdfFileInput.click());
    DOM.btnStartBlankDoc.addEventListener('click', () => openBlankPageModal());

    // File inputs change
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
    ['dragenter', 'dragover'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropzone.classList.add('drag-active');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropzone.classList.remove('drag-active');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      const pdfFiles = files.filter((f) => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
      const imgFiles = files.filter((f) => f.type.startsWith('image/'));

      if (pdfFiles.length > 0) handlePdfFiles(pdfFiles);
      if (imgFiles.length > 0) handleImageFiles(imgFiles);

      if (pdfFiles.length === 0 && imgFiles.length === 0) {
        showToast('Por favor sube archivos PDF o imágenes compatibles.', 'danger');
      }
    });
  }

  async function handlePdfFiles(files) {
    showToast(`Cargando ${files.length} archivo(s) PDF...`, 'info', 2000);

    for (const file of files) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const docId = 'doc_' + Math.random().toString(36).substring(2, 9);

        // Load with PDF.js for rendering
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
        const pdfJsDoc = await loadingTask.promise;

        // Store source document
        state.sourceDocuments.set(docId, {
          name: file.name,
          bytes: new Uint8Array(arrayBuffer),
          pdfJsDoc: pdfJsDoc
        });

        // Extract pages
        const numPages = pdfJsDoc.numPages;
        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
          const pdfPage = await pdfJsDoc.getPage(pageNum);
          const viewport = pdfPage.getViewport({ scale: 1.0 });

          // Generate thumbnail
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
            sourcePageIndex: pageNum - 1, // 0-based
            width: viewport.width,
            height: viewport.height,
            rotation: 0,
            thumbnailUrl: thumbCanvas.toDataURL('image/jpeg', 0.85),
            canvasDataUrl: null, // set when edited
            isEdited: false,
            originalName: `${file.name} (Pág. ${pageNum})`
          };

          state.pages.push(pageObj);
        }

        showToast(`PDF "${file.name}" cargado (${numPages} páginas)`, 'success');
      } catch (err) {
        console.error('Error loading PDF:', err);
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

        // Fit into standard A4 canvas proportions or use image native size
        let targetWidth = A4_PORTRAIT.width;
        let targetHeight = (img.height / img.width) * targetWidth;

        // Render to canvas
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth * 2; // high res
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
        showToast(`Imagen "${file.name}" agregada como hoja`, 'success');
      } catch (err) {
        console.error('Error adding image:', err);
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

  // ==========================================================================
  // Blank Page Creation
  // ==========================================================================
  function setupBlankPageModal() {
    DOM.btnCloseBlankModal.addEventListener('click', closeBlankPageModal);
    DOM.btnCancelBlankModal.addEventListener('click', closeBlankPageModal);

    // Pattern radio selection
    const styleCards = DOM.blankPageModal.querySelectorAll('.style-card');
    styleCards.forEach((card) => {
      card.addEventListener('click', () => {
        styleCards.forEach((c) => c.classList.remove('active'));
        card.classList.add('active');
        const radio = card.querySelector('input[type="radio"]');
        if (radio) radio.checked = true;
      });
    });

    DOM.btnConfirmAddBlank.addEventListener('click', () => {
      const selectedRadio = DOM.blankPageModal.querySelector('input[name="pagePattern"]:checked');
      const pattern = selectedRadio ? selectedRadio.value : 'blank';
      const orientation = DOM.pageOrientationSelect.value;
      const position = DOM.pageInsertPositionSelect.value;

      createBlankPage(pattern, orientation, position);
      closeBlankPageModal();
    });
  }

  function openBlankPageModal() {
    DOM.blankPageModal.classList.remove('hidden');
  }

  function closeBlankPageModal() {
    DOM.blankPageModal.classList.add('hidden');
  }

  function createBlankPage(pattern, orientation, position) {
    const dims = orientation === 'landscape' ? A4_LANDSCAPE : A4_PORTRAIT;
    const canvas = document.createElement('canvas');
    canvas.width = dims.width * 2;
    canvas.height = dims.height * 2;
    const ctx = canvas.getContext('2d');

    // Fill background according to pattern
    if (pattern === 'dark') {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (pattern === 'lined') {
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 1.5;
        const lineSpacing = 32;
        for (let y = lineSpacing; y < canvas.height; y += lineSpacing) {
          ctx.beginPath();
          ctx.moveTo(40, y);
          ctx.lineTo(canvas.width - 40, y);
          ctx.stroke();
        }
      } else if (pattern === 'grid') {
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1;
        const gridSpacing = 28;
        for (let x = 0; x < canvas.width; x += gridSpacing) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, canvas.height);
          ctx.stroke();
        }
        for (let y = 0; y < canvas.height; y += gridSpacing) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(canvas.width, y);
          ctx.stroke();
        }
      }
    }

    const dataUrl = canvas.toDataURL('image/png');

    const newPage = {
      id: 'page_' + Math.random().toString(36).substring(2, 9),
      type: 'blank',
      sourceDocId: null,
      sourcePageIndex: null,
      width: dims.width,
      height: dims.height,
      rotation: 0,
      thumbnailUrl: dataUrl,
      canvasDataUrl: dataUrl,
      isEdited: true,
      originalName: `Hoja en blanco (${pattern})`
    };

    if (position === 'start') {
      state.pages.unshift(newPage);
    } else {
      state.pages.push(newPage);
    }

    renderPagesGrid();
    updateUIState();
    showToast('Nueva hoja agregada exitosamente', 'success');
  }

  // ==========================================================================
  // Workbench Bar Actions (Rotate All, Zoom, Quick Add)
  // ==========================================================================
  function setupWorkbenchBar() {
    DOM.btnRotateAllCw.addEventListener('click', () => {
      if (state.pages.length === 0) return;
      state.pages.forEach((p) => {
        p.rotation = (p.rotation + 90) % 360;
      });
      renderPagesGrid();
      showToast('Todas las páginas fueron rotadas 90°', 'info');
    });

    DOM.btnQuickAddBlank.addEventListener('click', () => {
      createBlankPage('blank', 'portrait', 'end');
    });

    DOM.btnZoomIn.addEventListener('click', () => {
      if (DOM.pagesGrid.classList.contains('zoom-sm')) {
        DOM.pagesGrid.classList.remove('zoom-sm');
      } else {
        DOM.pagesGrid.classList.add('zoom-lg');
      }
    });

    DOM.btnZoomOut.addEventListener('click', () => {
      if (DOM.pagesGrid.classList.contains('zoom-lg')) {
        DOM.pagesGrid.classList.remove('zoom-lg');
      } else {
        DOM.pagesGrid.classList.add('zoom-sm');
      }
    });
  }

  // ==========================================================================
  // Clear All Modal
  // ==========================================================================
  function setupClearModal() {
    DOM.btnClearAll.addEventListener('click', () => {
      if (state.pages.length === 0) return;
      DOM.confirmClearModal.classList.remove('hidden');
    });

    DOM.btnCloseClearModal.addEventListener('click', () => {
      DOM.confirmClearModal.classList.add('hidden');
    });

    DOM.btnCancelClear.addEventListener('click', () => {
      DOM.confirmClearModal.classList.add('hidden');
    });

    DOM.btnConfirmClear.addEventListener('click', () => {
      state.pages = [];
      state.sourceDocuments.clear();
      renderPagesGrid();
      updateUIState();
      DOM.confirmClearModal.classList.add('hidden');
      showToast('Se han eliminado todas las hojas del proyecto', 'danger');
    });
  }

  // ==========================================================================
  // Page Cards Grid, Multi-Selection & Drag & Drop
  // ==========================================================================
  function setupMultiSelection() {
    DOM.btnBulkRotate.addEventListener('click', rotateSelectedPages);
    DOM.btnBulkDelete.addEventListener('click', deleteSelectedPages);
    DOM.btnBulkSelectAll.addEventListener('click', () => {
      state.pages.forEach((p) => state.selectedPageIds.add(p.id));
      renderPagesGrid();
      updateBulkActionBar();
    });
    DOM.btnBulkDeselectAll.addEventListener('click', () => {
      state.selectedPageIds.clear();
      renderPagesGrid();
      updateBulkActionBar();
    });
  }

  function togglePageSelection(pageId) {
    if (state.selectedPageIds.has(pageId)) {
      state.selectedPageIds.delete(pageId);
    } else {
      state.selectedPageIds.add(pageId);
    }
    state.lastSelectedId = pageId;
    renderPagesGrid();
    updateBulkActionBar();
  }

  function selectRange(startId, endId) {
    const ids = state.pages.map((p) => p.id);
    const startIdx = ids.indexOf(startId);
    const endIdx = ids.indexOf(endId);
    if (startIdx === -1 || endIdx === -1) return;

    const min = Math.min(startIdx, endIdx);
    const max = Math.max(startIdx, endIdx);
    for (let i = min; i <= max; i++) {
      state.selectedPageIds.add(ids[i]);
    }
    renderPagesGrid();
    updateBulkActionBar();
  }

  function updateBulkActionBar() {
    const count = state.selectedPageIds.size;
    if (count > 0) {
      DOM.bulkActionBar.classList.remove('hidden');
      DOM.bulkCountText.innerHTML = `<strong>${count}</strong> ${count === 1 ? 'hoja seleccionada' : 'hojas seleccionadas'}`;
    } else {
      DOM.bulkActionBar.classList.add('hidden');
    }
  }

  function rotateSelectedPages() {
    if (state.selectedPageIds.size === 0) return;
    state.pages.forEach((p) => {
      if (state.selectedPageIds.has(p.id)) {
        p.rotation = (p.rotation + 90) % 360;
      }
    });
    renderPagesGrid();
    showToast(`Se rotaron 90° las hojas seleccionadas`, 'info', 2000);
  }

  function deleteSelectedPages() {
    if (state.selectedPageIds.size === 0) return;
    const count = state.selectedPageIds.size;
    state.pages = state.pages.filter((p) => !state.selectedPageIds.has(p.id));
    state.selectedPageIds.clear();
    renderPagesGrid();
    updateUIState();
    updateBulkActionBar();
    showToast(`Se eliminaron ${count} hoja(s) seleccionada(s)`, 'danger', 2500);
  }

  function renderPagesGrid() {
    DOM.pagesGrid.innerHTML = '';

    state.pages.forEach((page, index) => {
      const card = createPageCardElement(page, index);
      DOM.pagesGrid.appendChild(card);
    });

    updateBulkActionBar();
  }

  function createPageCardElement(page, index) {
    const card = document.createElement('div');
    const isSelected = state.selectedPageIds.has(page.id);
    card.className = `page-card ${isSelected ? 'selected' : ''}`;
    card.draggable = true;
    card.dataset.index = index;
    card.dataset.id = page.id;

    // Selected indicator checkmark pill
    if (isSelected) {
      const checkBadge = document.createElement('div');
      checkBadge.className = 'page-card-select-check';
      checkBadge.innerHTML = '<i class="fa-solid fa-check"></i>';
      card.appendChild(checkBadge);
    }

    // Header with page number badge and rotation
    const topBar = document.createElement('div');
    topBar.className = 'card-top-bar';

    const numBadge = document.createElement('div');
    numBadge.className = 'page-number-pill';
    numBadge.innerHTML = `
      <i class="fa-solid fa-grip-vertical drag-handle" title="Arrastra para mover"></i>
      <span>Pág. ${index + 1}</span>
      ${page.isEdited ? '<span class="page-tag-edited">Editada</span>' : ''}
    `;

    const rotBadge = document.createElement('span');
    rotBadge.className = 'page-rotation-pill';
    rotBadge.textContent = page.rotation > 0 ? `${page.rotation}°` : '';

    topBar.appendChild(numBadge);
    topBar.appendChild(rotBadge);

    // Preview area
    const previewArea = document.createElement('div');
    previewArea.className = 'card-preview-area';

    const img = document.createElement('img');
    img.className = 'card-canvas';
    img.src = page.thumbnailUrl;
    img.alt = `Página ${index + 1}`;
    img.style.transform = `rotate(${page.rotation}deg)`;

    // Hover Quick Edit Button
    const overlay = document.createElement('div');
    overlay.className = 'card-hover-overlay';
    const editOverlayBtn = document.createElement('button');
    editOverlayBtn.className = 'btn-edit-page-overlay';
    editOverlayBtn.innerHTML = '<i class="fa-solid fa-pen"></i><span>Editar Hoja</span>';
    editOverlayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditorModal(page.id);
    });
    overlay.appendChild(editOverlayBtn);

    previewArea.appendChild(img);
    previewArea.appendChild(overlay);

    // Bottom Action Controls
    const bottomBar = document.createElement('div');
    bottomBar.className = 'card-bottom-actions';

    // Move buttons
    const moveGroup = document.createElement('div');
    moveGroup.className = 'action-btn-group';

    const btnMoveLeft = document.createElement('button');
    btnMoveLeft.className = 'card-act-btn';
    btnMoveLeft.title = 'Mover hacia la izquierda';
    btnMoveLeft.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
    btnMoveLeft.disabled = index === 0;
    btnMoveLeft.addEventListener('click', (e) => {
      e.stopPropagation();
      movePage(index, index - 1);
    });

    const btnMoveRight = document.createElement('button');
    btnMoveRight.className = 'card-act-btn';
    btnMoveRight.title = 'Mover hacia la derecha';
    btnMoveRight.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
    btnMoveRight.disabled = index === state.pages.length - 1;
    btnMoveRight.addEventListener('click', (e) => {
      e.stopPropagation();
      movePage(index, index + 1);
    });

    moveGroup.appendChild(btnMoveLeft);
    moveGroup.appendChild(btnMoveRight);

    // Action buttons: Rotate, Deskew, Duplicate & Delete
    const actGroup = document.createElement('div');
    actGroup.className = 'action-btn-group';

    const btnRotate = document.createElement('button');
    btnRotate.className = 'card-act-btn';
    btnRotate.title = 'Rotar 90°';
    btnRotate.innerHTML = '<i class="fa-solid fa-rotate-right"></i>';
    btnRotate.addEventListener('click', (e) => {
      e.stopPropagation();
      page.rotation = (page.rotation + 90) % 360;
      img.style.transform = `rotate(${page.rotation}deg)`;
      rotBadge.textContent = page.rotation > 0 ? `${page.rotation}°` : '';
    });

    const btnDeskew = document.createElement('button');
    btnDeskew.className = 'card-act-btn';
    btnDeskew.title = 'Enderezar escaneo chueco';
    btnDeskew.innerHTML = '<i class="fa-solid fa-compass-drafting"></i>';
    btnDeskew.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeskewModal(page.id);
    });

    const btnDuplicate = document.createElement('button');
    btnDuplicate.className = 'card-act-btn';
    btnDuplicate.title = 'Duplicar esta hoja';
    btnDuplicate.innerHTML = '<i class="fa-solid fa-copy"></i>';
    btnDuplicate.addEventListener('click', (e) => {
      e.stopPropagation();
      duplicatePage(index);
    });

    const btnDelete = document.createElement('button');
    btnDelete.className = 'card-act-btn delete-btn';
    btnDelete.title = 'Eliminar hoja';
    btnDelete.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
    btnDelete.addEventListener('click', (e) => {
      e.stopPropagation();
      deletePage(index);
    });

    actGroup.appendChild(btnRotate);
    actGroup.appendChild(btnDeskew);
    actGroup.appendChild(btnDuplicate);
    actGroup.appendChild(btnDelete);

    bottomBar.appendChild(moveGroup);
    bottomBar.appendChild(actGroup);

    card.appendChild(topBar);
    card.appendChild(previewArea);
    card.appendChild(bottomBar);

    // Click handler for Multi-Selection (Ctrl + Click & Shift + Click)
    card.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return;

      if (e.shiftKey && state.lastSelectedId) {
        selectRange(state.lastSelectedId, page.id);
      } else {
        togglePageSelection(page.id);
      }
    });

    // Setup Drag & Drop Handlers (Supports dragging single or grouped selection!)
    card.addEventListener('dragstart', (e) => {
      if (!state.selectedPageIds.has(page.id)) {
        state.selectedPageIds.clear();
        state.selectedPageIds.add(page.id);
        renderPagesGrid();
      }
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
      if (state.draggedIndex !== null && state.draggedIndex !== index) {
        moveGroupSelection(state.draggedIndex, index);
      }
    });

    return card;
  }

  function movePage(fromIndex, toIndex) {
    if (toIndex < 0 || toIndex >= state.pages.length) return;
    const [moved] = state.pages.splice(fromIndex, 1);
    state.pages.splice(toIndex, 0, moved);
    renderPagesGrid();
    showToast(`Página movida a la posición ${toIndex + 1}`, 'info', 1500);
  }

  function moveGroupSelection(fromIndex, toIndex) {
    // If only one card is selected or dragging unselected
    if (state.selectedPageIds.size <= 1) {
      movePage(fromIndex, toIndex);
      return;
    }

    // Multiple pages selected: move all selected in preserved relative order
    const selectedIndices = [];
    const selectedItems = [];

    state.pages.forEach((p, idx) => {
      if (state.selectedPageIds.has(p.id)) {
        selectedIndices.push(idx);
        selectedItems.push(p);
      }
    });

    const targetPage = state.pages[toIndex];
    const remaining = state.pages.filter((p) => !state.selectedPageIds.has(p.id));
    let insertAt = remaining.indexOf(targetPage);
    if (insertAt === -1) insertAt = toIndex > fromIndex ? remaining.length : 0;

    remaining.splice(insertAt, 0, ...selectedItems);
    state.pages = remaining;

    renderPagesGrid();
    showToast(`Se movieron ${selectedItems.length} hojas seleccionadas en grupo`, 'info', 2000);
  }

  function duplicatePage(index) {
    const original = state.pages[index];
    const cloned = {
      ...original,
      id: 'page_' + Math.random().toString(36).substring(2, 9)
    };
    state.pages.splice(index + 1, 0, cloned);
    renderPagesGrid();
    updateUIState();
    showToast(`Página ${index + 1} duplicada`, 'success');
  }

  function deletePage(index) {
    const removed = state.pages.splice(index, 1)[0];
    state.selectedPageIds.delete(removed.id);
    renderPagesGrid();
    updateUIState();
    updateBulkActionBar();
    showToast(`Página ${index + 1} eliminada`, 'danger', 2000);
  }

  // ==========================================================================
  // Page Editor Modal & Canvas Drawing Engine
  // ==========================================================================
  function setupEditorModal() {
    const editor = state.editor;
    editor.bgCanvas = DOM.bgCanvas;
    editor.drawCanvas = DOM.drawCanvas;
    editor.bgCtx = DOM.bgCanvas.getContext('2d');
    editor.drawCtx = DOM.drawCanvas.getContext('2d');

    // Close & Cancel
    DOM.btnCloseEditor.addEventListener('click', closeEditorModal);
    DOM.btnCancelEditor.addEventListener('click', closeEditorModal);

    // Tool buttons selection
    const toolTiles = DOM.editorModal.querySelectorAll('.tool-tile');
    toolTiles.forEach((tile) => {
      tile.addEventListener('click', () => {
        toolTiles.forEach((t) => t.classList.remove('active'));
        tile.classList.add('active');
        editor.tool = tile.dataset.tool;

        if (editor.tool === 'text') {
          DOM.textOptionsGroup.style.display = 'flex';
        } else {
          DOM.textOptionsGroup.style.display = 'none';
        }
      });
    });

    // Color swatches selection
    const swatches = DOM.editorModal.querySelectorAll('.color-swatch');
    swatches.forEach((swatch) => {
      swatch.addEventListener('click', () => {
        swatches.forEach((s) => s.classList.remove('active'));
        swatch.classList.add('active');
        editor.color = swatch.dataset.color;
      });
    });

    DOM.customColorPicker.addEventListener('input', (e) => {
      swatches.forEach((s) => s.classList.remove('active'));
      editor.color = e.target.value;
    });

    // Stroke size slider
    DOM.strokeSizeRange.addEventListener('input', (e) => {
      editor.strokeSize = parseInt(e.target.value, 10);
      DOM.strokeSizeVal.textContent = `${editor.strokeSize}px`;
    });

    // Font size select
    DOM.fontSizeSelect.addEventListener('change', (e) => {
      editor.fontSize = parseInt(e.target.value, 10);
    });

    // Undo & Clear Canvas
    DOM.btnUndoCanvas.addEventListener('click', undoCanvasStep);
    DOM.btnClearCanvas.addEventListener('click', () => {
      editor.drawCtx.clearRect(0, 0, editor.drawCanvas.width, editor.drawCanvas.height);
      saveCanvasHistory();
      showToast('Se limpiaron los trazos de la hoja', 'info');
    });

    // Save Changes
    DOM.btnSaveEditor.addEventListener('click', saveEditorChanges);
  }

  async function openEditorModal(pageId) {
    const page = state.pages.find((p) => p.id === pageId);
    if (!page) return;

    state.editor.activePageId = pageId;
    const pageIndex = state.pages.indexOf(page);
    DOM.modalPageNumberBadge.textContent = `#${pageIndex + 1}`;

    const editor = state.editor;
    const bgCanvas = editor.bgCanvas;
    const drawCanvas = editor.drawCanvas;
    const bgCtx = editor.bgCtx;
    const drawCtx = editor.drawCtx;

    // Reset history
    editor.history = [];
    editor.historyStep = -1;

    // Determine target canvas dimensions (crisp scale)
    const scale = 1.8;
    const targetWidth = Math.round(page.width * scale);
    const targetHeight = Math.round(page.height * scale);

    bgCanvas.width = targetWidth;
    bgCanvas.height = targetHeight;
    drawCanvas.width = targetWidth;
    drawCanvas.height = targetHeight;

    // Reset contexts
    bgCtx.clearRect(0, 0, targetWidth, targetHeight);
    drawCtx.clearRect(0, 0, targetWidth, targetHeight);

    // Render background
    if (page.canvasDataUrl) {
      // If page has a cached canvas dataUrl (blank, image, or previous edit)
      const img = new Image();
      img.src = page.canvasDataUrl;
      await img.decode();
      bgCtx.drawImage(img, 0, 0, targetWidth, targetHeight);
    } else if (page.type === 'pdf-page' && page.sourceDocId) {
      const srcDoc = state.sourceDocuments.get(page.sourceDocId);
      if (srcDoc && srcDoc.pdfJsDoc) {
        const pdfPage = await srcDoc.pdfJsDoc.getPage(page.sourcePageIndex + 1);
        const viewport = pdfPage.getViewport({ scale: scale });
        await pdfPage.render({
          canvasContext: bgCtx,
          viewport: viewport
        }).promise;
      }
    } else {
      bgCtx.fillStyle = '#ffffff';
      bgCtx.fillRect(0, 0, targetWidth, targetHeight);
    }

    // Save initial state to history
    saveCanvasHistory();

    DOM.editorModal.classList.remove('hidden');
  }

  function closeEditorModal() {
    DOM.editorModal.classList.add('hidden');
    state.editor.activePageId = null;
  }

  function setupCanvasInteractions() {
    const editor = state.editor;
    const drawCanvas = DOM.drawCanvas;
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
      const { x, y } = getCoords(e);
      lastX = x;
      lastY = y;

      if (editor.tool === 'text') {
        insertTextAt(x, y);
        return;
      }

      editor.isDrawing = true;
      draw(x, y, true);
    });

    window.addEventListener('mousemove', (e) => {
      if (!editor.isDrawing) return;
      const { x, y } = getCoords(e);
      draw(x, y);
      lastX = x;
      lastY = y;
    });

    window.addEventListener('mouseup', () => {
      if (editor.isDrawing) {
        editor.isDrawing = false;
        saveCanvasHistory();
      }
    });

    function draw(x, y, isStart = false) {
      const ctx = editor.drawCtx;
      ctx.beginPath();

      if (editor.tool === 'pen') {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = editor.color;
        ctx.lineWidth = editor.strokeSize;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = 1.0;
      } else if (editor.tool === 'highlighter') {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = editor.color;
        ctx.lineWidth = editor.strokeSize * 3.5;
        ctx.lineCap = 'square';
        ctx.lineJoin = 'miter';
        ctx.globalAlpha = 0.35;
      } else if (editor.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = editor.strokeSize * 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = 1.0;
      }

      if (isStart) {
        ctx.moveTo(x, y);
        ctx.lineTo(x, y);
      } else {
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.closePath();
    }

    function insertTextAt(x, y) {
      const userText = prompt('Ingresa el texto que deseas agregar a la hoja:');
      if (!userText || userText.trim() === '') return;

      const ctx = editor.drawCtx;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = `bold ${editor.fontSize * 1.8}px 'Outfit', sans-serif`;
      ctx.fillStyle = editor.color;
      ctx.globalAlpha = 1.0;
      ctx.fillText(userText, x, y);
      ctx.restore();

      saveCanvasHistory();
    }
  }

  function saveCanvasHistory() {
    const editor = state.editor;
    const ctx = editor.drawCtx;
    // Trim forward history if we rewound
    if (editor.historyStep < editor.history.length - 1) {
      editor.history = editor.history.slice(0, editor.historyStep + 1);
    }
    const imgData = ctx.getImageData(0, 0, editor.drawCanvas.width, editor.drawCanvas.height);
    editor.history.push(imgData);
    editor.historyStep = editor.history.length - 1;
  }

  function undoCanvasStep() {
    const editor = state.editor;
    if (editor.historyStep > 0) {
      editor.historyStep--;
      const prevData = editor.history[editor.historyStep];
      editor.drawCtx.putImageData(prevData, 0, 0);
    } else if (editor.historyStep === 0) {
      editor.historyStep = -1;
      editor.drawCtx.clearRect(0, 0, editor.drawCanvas.width, editor.drawCanvas.height);
    }
  }

  function saveEditorChanges() {
    const editor = state.editor;
    const page = state.pages.find((p) => p.id === editor.activePageId);
    if (!page) return;

    // Merge background canvas and draw canvas into a composite canvas
    const mergedCanvas = document.createElement('canvas');
    mergedCanvas.width = editor.bgCanvas.width;
    mergedCanvas.height = editor.bgCanvas.height;
    const mergedCtx = mergedCanvas.getContext('2d');

    // Draw background
    mergedCtx.drawImage(editor.bgCanvas, 0, 0);
    // Draw annotations overlay
    mergedCtx.drawImage(editor.drawCanvas, 0, 0);

    const fullDataUrl = mergedCanvas.toDataURL('image/png');

    // Update page state
    page.canvasDataUrl = fullDataUrl;
    page.thumbnailUrl = fullDataUrl;
    page.isEdited = true;

    // Re-render the grid
    renderPagesGrid();
    closeEditorModal();
    showToast('Cambios guardados exitosamente en la hoja', 'success');
  }

  // ==========================================================================
  // HP LaserJet Pro MFP 4103fdw Scanner Engine
  // ==========================================================================
  function setupHpScanner() {
    // Open / Close handlers
    if (DOM.btnOpenHpScan) DOM.btnOpenHpScan.addEventListener('click', openHpScanModal);
    if (DOM.btnHpScanMain) DOM.btnHpScanMain.addEventListener('click', openHpScanModal);
    if (DOM.btnWorkbenchScanMore) DOM.btnWorkbenchScanMore.addEventListener('click', openHpScanModal);
    if (DOM.btnMenuHpScan) {
      DOM.btnMenuHpScan.addEventListener('click', () => {
        DOM.btnAddPageDropdown.parentElement.classList.remove('open');
        openHpScanModal();
      });
    }

    if (DOM.btnCloseHpModal) DOM.btnCloseHpModal.addEventListener('click', closeHpScanModal);
    if (DOM.btnCancelHpScan) DOM.btnCancelHpScan.addEventListener('click', closeHpScanModal);

    // Load saved IP
    const savedIp = localStorage.getItem('tacala_hp_printer_ip') || '192.168.1.50';
    if (DOM.hpPrinterIp) DOM.hpPrinterIp.value = savedIp;

    // Load saved Duplex preference & bind persistent change listener
    const savedDuplex = localStorage.getItem('tacala_hp_duplex') === 'true';
    if (DOM.hpDuplexCheck) {
      DOM.hpDuplexCheck.checked = savedDuplex;
      updateDuplexBadge(savedDuplex);
      DOM.hpDuplexCheck.addEventListener('change', () => {
        const isChecked = DOM.hpDuplexCheck.checked;
        localStorage.setItem('tacala_hp_duplex', isChecked);
        updateDuplexBadge(isChecked);
        showToast(`Doble cara ${isChecked ? 'activada' : 'desactivada'} (guardado)`, 'info', 1500);
      });
    }

    // Test Connection Button
    if (DOM.btnTestHpConnection) DOM.btnTestHpConnection.addEventListener('click', testHpConnection);

    // Source Card Radio Click
    const sourceCards = DOM.hpScanModal ? DOM.hpScanModal.querySelectorAll('.source-card') : [];
    sourceCards.forEach((card) => {
      card.addEventListener('click', () => {
        const groupName = card.querySelector('input[type="radio"]').name;
        DOM.hpScanModal.querySelectorAll(`input[name="${groupName}"]`).forEach((r) => {
          r.closest('.source-card').classList.remove('active');
        });
        card.classList.add('active');
        card.querySelector('input[type="radio"]').checked = true;
      });
    });

    // Start eSCL Scan
    if (DOM.btnStartHpScan) DOM.btnStartHpScan.addEventListener('click', startHpNetworkScan);

    // WIA Scan
    if (DOM.btnScanWia) DOM.btnScanWia.addEventListener('click', startWiaScan);

    // Folder Scans Drawer
    if (DOM.btnRefreshFolderScans) DOM.btnRefreshFolderScans.addEventListener('click', refreshFolderScans);
    if (DOM.btnToggleFolderScans) {
      DOM.btnToggleFolderScans.addEventListener('click', () => {
        DOM.folderFilesList.classList.toggle('hidden');
        if (!DOM.folderFilesList.classList.contains('hidden')) {
          refreshFolderScans();
        }
      });
    }
  }

  function updateDuplexBadge(active) {
    if (!DOM.duplexStateBadge) return;
    if (active) {
      DOM.duplexStateBadge.textContent = 'Activado (Guardado)';
      DOM.duplexStateBadge.classList.add('active');
    } else {
      DOM.duplexStateBadge.textContent = 'Desactivado';
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
        updateHpFeedback('online', `¡HP MFP 4103fdw conectada! (Puerto: ${data.port}, Cama: Sí, ADF: Sí)`);
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

  async function startHpNetworkScan() {
    const ip = DOM.hpPrinterIp.value.trim();
    if (!ip) {
      showToast('Ingresa la IP de la impresora', 'danger');
      return;
    }

    localStorage.setItem('tacala_hp_printer_ip', ip);

    const source = DOM.hpScanModal.querySelector('input[name="hpSource"]:checked').value;
    const colorMode = DOM.hpScanModal.querySelector('input[name="hpColor"]:checked').value;
    const resolution = parseInt(DOM.hpResolutionSelect.value, 10);
    const duplex = DOM.hpDuplexCheck.checked && source === 'Feeder';

    // Show laser progress box
    DOM.hpScanProgressBox.classList.remove('hidden');
    DOM.hpScanProgressTitle.textContent = `Escaneando desde ${source === 'Feeder' ? 'Alimentador ADF' : 'Cama Plana'}...`;
    DOM.hpScanProgressSubtitle.textContent = `La HP 4103fdw está procesando las hojas ${duplex ? '(Doble cara)' : ''} y transfiriendo a Tacala.`;
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
        showToast(`¡Se agregaron ${data.pages.length} hoja(s) escaneada(s) al documento!`, 'success', 4500);
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

  async function startWiaScan() {
    DOM.hpScanProgressBox.classList.remove('hidden');
    DOM.hpScanProgressTitle.textContent = 'Iniciando escáner con driver de Windows (WIA)...';
    DOM.hpScanProgressSubtitle.textContent = 'Si aparece el cuadro de diálogo de Windows, selecciona tu HP 4103.';
    DOM.btnScanWia.disabled = true;

    try {
      const res = await fetch('/api/scanner/wia', { method: 'POST' });
      const data = await res.json();

      if (data.success && data.pages && data.pages.length > 0) {
        await addScannedPages(data.pages);
        closeHpScanModal();
        showToast('Hoja escaneada correctamente mediante Windows WIA', 'success');
      } else {
        showToast(`Error: ${data.error}`, 'danger');
      }
    } catch (err) {
      showToast(`Error al ejecutar WIA: ${err.message}`, 'danger');
    } finally {
      DOM.btnScanWia.disabled = false;
      DOM.hpScanProgressBox.classList.add('hidden');
    }
  }

  async function refreshFolderScans() {
    try {
      const res = await fetch('/api/scanner/folder-scans');
      const data = await res.json();

      if (data.success) {
        DOM.folderFilesList.classList.remove('hidden');
        DOM.folderFilesList.innerHTML = '';

        if (data.files.length === 0) {
          DOM.folderFilesList.innerHTML = '<p style="font-size:0.78rem;color:var(--text-muted);padding:0.3rem;">No hay archivos en la carpeta de escaneos aún.</p>';
          return;
        }

        data.files.forEach((file) => {
          const row = document.createElement('div');
          row.className = 'folder-file-row';
          const sizeKb = Math.round(file.size / 1024);
          row.innerHTML = `
            <div class="folder-file-info">
              <i class="fa-solid fa-file-image"></i>
              <span>${escapeHtml(file.filename)} <small style="color:var(--text-muted);">(${sizeKb} KB)</small></span>
            </div>
            <button class="btn btn-sm btn-primary btn-import-scan" data-filename="${escapeHtml(file.filename)}">
              <i class="fa-solid fa-plus"></i> Importar
            </button>
          `;

          row.querySelector('.btn-import-scan').addEventListener('click', async () => {
            await importFolderScan(file.filename);
          });

          DOM.folderFilesList.appendChild(row);
        });
      }
    } catch (err) {
      console.error('Error fetching folder scans:', err);
    }
  }

  async function importFolderScan(filename) {
    try {
      showToast(`Importando ${filename}...`, 'info');
      const res = await fetch(`/api/scanner/file/${encodeURIComponent(filename)}`);
      const blob = await res.blob();
      const file = new File([blob], filename, { type: blob.type });

      if (blob.type.includes('pdf') || filename.endsWith('.pdf')) {
        await handlePdfFiles([file]);
      } else {
        await handleImageFiles([file]);
      }
      closeHpScanModal();
      showToast(`Archivo "${filename}" importado a la mesa de trabajo`, 'success');
    } catch (err) {
      showToast(`Error al importar archivo: ${err.message}`, 'danger');
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
  // Deskew / Enderezado de Hojas Chuecas Engine
  // ==========================================================================
  function setupDeskewEngine() {
    const deskew = state.deskew;
    deskew.canvas = DOM.deskewCanvas;
    deskew.ctx = DOM.deskewCanvas.getContext('2d');

    DOM.btnCloseDeskew.addEventListener('click', closeDeskewModal);
    DOM.btnCancelDeskew.addEventListener('click', closeDeskewModal);

    DOM.deskewSlider.addEventListener('input', (e) => {
      deskew.angle = parseFloat(e.target.value);
      DOM.deskewAngleVal.textContent = `${deskew.angle > 0 ? '+' : ''}${deskew.angle.toFixed(1)}°`;
      renderDeskewCanvas();
    });

    const quickBtns = DOM.deskewModal.querySelectorAll('.quick-ang-btn');
    quickBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        deskew.angle = parseFloat(btn.dataset.angle);
        DOM.deskewSlider.value = deskew.angle;
        DOM.deskewAngleVal.textContent = `${deskew.angle > 0 ? '+' : ''}${deskew.angle.toFixed(1)}°`;
        renderDeskewCanvas();
      });
    });

    DOM.deskewGridToggle.addEventListener('change', (e) => {
      DOM.alignmentGridOverlay.classList.toggle('hidden', !e.target.checked);
    });

    DOM.deskewCropToggle.addEventListener('change', () => {
      renderDeskewCanvas();
    });

    DOM.btnApplyDeskew.addEventListener('click', applyDeskewChanges);
  }

  async function openDeskewModal(pageId) {
    const page = state.pages.find((p) => p.id === pageId);
    if (!page) return;

    state.deskew.activePageId = pageId;
    state.deskew.angle = 0;
    DOM.deskewSlider.value = 0;
    DOM.deskewAngleVal.textContent = '0.0°';

    const pageIdx = state.pages.indexOf(page);
    DOM.deskewPageBadge.textContent = `#${pageIdx + 1}`;

    const img = new Image();
    if (page.canvasDataUrl) {
      img.src = page.canvasDataUrl;
    } else if (page.thumbnailUrl) {
      img.src = page.thumbnailUrl;
    }
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
    const crop = DOM.deskewCropToggle.checked;

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    deskew.canvas.width = w;
    deskew.canvas.height = h;

    const ctx = deskew.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(angleRad);

    // Scale slightly if auto-crop is enabled to hide corner triangles
    if (crop && Math.abs(deskew.angle) > 0.05) {
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

    const dataUrl = deskew.canvas.toDataURL('image/png');
    page.canvasDataUrl = dataUrl;
    page.thumbnailUrl = dataUrl;
    page.isEdited = true;

    renderPagesGrid();
    closeDeskewModal();
    showToast('¡Hoja enderezada y actualizada con éxito!', 'success');
  }

  // ==========================================================================
  // Download & Save to PC Folder Engine (PDF-Lib)
  // ==========================================================================
  function setupDownload() {
    DOM.btnDownloadPdf.addEventListener('click', exportPdf);
    if (DOM.btnSaveToFolder) DOM.btnSaveToFolder.addEventListener('click', savePdfToFolder);
  }

  async function generatePdfBytes() {
    if (typeof PDFLib === 'undefined') {
      throw new Error('La biblioteca PDF-Lib no se ha cargado.');
    }

    const { PDFDocument, degrees } = PDFLib;
    const outputPdf = await PDFDocument.create();

    const pdfLibDocCache = new Map();
    for (const [docId, docInfo] of state.sourceDocuments.entries()) {
      try {
        const loadedLibDoc = await PDFDocument.load(docInfo.bytes);
        pdfLibDocCache.set(docId, loadedLibDoc);
      } catch (e) {
        console.warn('Could not parse doc with pdf-lib directly:', e);
      }
    }

    for (let i = 0; i < state.pages.length; i++) {
      const page = state.pages[i];

      if (page.isEdited || page.type === 'blank' || page.type === 'image' || !page.sourceDocId) {
        const pngBytes = await fetch(page.canvasDataUrl || page.thumbnailUrl).then((res) => res.arrayBuffer());
        const pngImage = await outputPdf.embedPng(pngBytes);

        const newPage = outputPdf.addPage([page.width, page.height]);
        newPage.drawImage(pngImage, {
          x: 0,
          y: 0,
          width: page.width,
          height: page.height
        });

        if (page.rotation !== 0) {
          newPage.setRotation(degrees(page.rotation));
        }
      } else {
        const srcLibDoc = pdfLibDocCache.get(page.sourceDocId);
        if (srcLibDoc) {
          const [copiedPage] = await outputPdf.copyPages(srcLibDoc, [page.sourcePageIndex]);
          const originalRotation = copiedPage.getRotation().angle || 0;
          const finalRotation = (originalRotation + page.rotation) % 360;
          copiedPage.setRotation(degrees(finalRotation));
          outputPdf.addPage(copiedPage);
        } else {
          const pngBytes = await fetch(page.thumbnailUrl).then((res) => res.arrayBuffer());
          const pngImage = await outputPdf.embedPng(pngBytes);
          const newPage = outputPdf.addPage([page.width, page.height]);
          newPage.drawImage(pngImage, {
            x: 0,
            y: 0,
            width: page.width,
            height: page.height
          });
          if (page.rotation !== 0) {
            newPage.setRotation(degrees(page.rotation));
          }
        }
      }
    }

    return await outputPdf.save();
  }

  async function exportPdf() {
    if (state.pages.length === 0) {
      showToast('No hay páginas para descargar', 'danger');
      return;
    }

    DOM.btnDownloadPdf.disabled = true;
    DOM.downloadBtnText.textContent = 'Procesando...';
    DOM.downloadSpinner.classList.remove('hidden');

    try {
      const pdfBytes = await generatePdfBytes();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const downloadUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = downloadUrl;
      const timestamp = new Date().toISOString().slice(0, 10);
      link.download = `tacala-documento-${timestamp}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(downloadUrl);

      showToast('¡Tu PDF ha sido compilado y descargado con éxito!', 'success', 4000);
    } catch (err) {
      console.error('Error generating PDF:', err);
      showToast(`Error al compilar el PDF: ${err.message}`, 'danger');
    } finally {
      DOM.btnDownloadPdf.disabled = false;
      DOM.downloadBtnText.textContent = 'Descargar PDF';
      DOM.downloadSpinner.classList.add('hidden');
    }
  }

  async function savePdfToFolder() {
    if (state.pages.length === 0) {
      showToast('No hay páginas en el documento para guardar', 'danger');
      return;
    }

    try {
      showToast('Generando documento PDF...', 'info', 1800);
      const pdfBytes = await generatePdfBytes();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const defaultName = `tacala-documento-${new Date().toISOString().slice(0, 10)}.pdf`;

      // 1. Try Native Windows File System Access API (showSaveFilePicker)
      if ('showSaveFilePicker' in window) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: defaultName,
            types: [{
              description: 'Documento PDF (*.pdf)',
              accept: { 'application/pdf': ['.pdf'] }
            }]
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();

          showToast('¡PDF guardado con éxito en la carpeta seleccionada de tu PC!', 'success', 4500);
          return;
        } catch (pickerErr) {
          if (pickerErr.name === 'AbortError') return; // User simply pressed cancel in the Windows dialog
          console.warn('showSaveFilePicker fallback:', pickerErr);
        }
      }

      // 2. Also send a copy to local server documents_guardados
      try {
        await fetch('/api/save-document', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/pdf',
            'x-filename': defaultName
          },
          body: blob
        });
      } catch (e) {
        // ignore backend copy error
      }

      // 3. Fallback to standard save download link
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = defaultName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(downloadUrl);

      showToast('¡Archivo guardado en tu PC!', 'success', 3500);
    } catch (err) {
      console.error('Error saving PDF:', err);
      showToast(`Error al guardar: ${err.message}`, 'danger');
    }
  }

  // Run on DOM Ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

