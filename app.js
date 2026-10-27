const state = { pages: [], currentId: null, cv: null, cvPromise: null, pdfPromise: null, toastTimer: null, previewTimer: null, isExporting: false };

const $ = (selector) => document.querySelector(selector);
const els = {
  fileInput: $('#fileInput'), cameraInput: $('#cameraInput'), choosePhotos: $('#choosePhotos'), takePhoto: $('#takePhoto'), addPhotos: $('#addPhotos'), pagesAdd: $('#pagesAdd'), addPageCard: $('#addPageCard'), dropZone: $('#dropZone'), emptyState: $('#emptyState'), workspace: $('#scanWorkspace'), sourceCanvas: $('#sourceCanvas'), overlay: $('#cornerOverlay'), resultCanvas: $('#resultCanvas'), resultPaper: $('.result-paper'), resultPlaceholder: $('#resultPlaceholder'), imageLoader: $('#imageLoader'), statusText: $('#statusText'), statusIndicator: $('#statusIndicator'), pageList: $('#pageList'), pagesEmpty: $('#pagesEmpty'), pageCount: $('#pageCount'), pagePosition: $('#pagePosition'), docName: $('#documentName'), subtitle: $('#documentSubtitle'), clearAll: $('#clearAll'), autoDetect: $('#autoDetect'), createPdf: $('#createPdf'), stepAdjust: $('#stepAdjust'), stepExport: $('#stepExport'), pagesTip: $('#pagesTip'), exportNote: $('#exportNote'), toast: $('#toast'), imageStage: $('#imageStage')
};

const uid = () => `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const fileBaseName = (name) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function showToast(message) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('visible');
  state.toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 3500);
}

function setStep(number) {
  els.stepAdjust.classList.toggle('active', number >= 2);
  els.stepAdjust.classList.toggle('done', number > 2);
  els.stepExport.classList.toggle('active', number >= 3);
}

function setStatus(text, kind = 'good') {
  els.statusText.textContent = text;
  els.statusIndicator.className = `status-indicator ${kind === 'manual' ? 'manual' : kind === 'error' ? 'error' : ''}`;
}

function selectedPage() { return state.pages.find((page) => page.id === state.currentId) || state.pages[0] || null; }

function imageFromFile(file) {
  if ('createImageBitmap' in window) return createImageBitmap(file, { imageOrientation: 'from-image' });
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This image could not be opened.')); };
    image.src = url;
  });
}

async function loadOpenCv() {
  if (state.cv?.Mat) return state.cv;
  if (state.cvPromise) return state.cvPromise;
  state.cvPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The page finder took too long to load. Check your connection and try again.')), 45000);
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.x/opencv.js';
    script.async = true;
    script.onload = () => {
      const runtime = window.cv;
      if (runtime?.Mat) { clearTimeout(timeout); state.cv = runtime; resolve(runtime); return; }
      if (!runtime) { clearTimeout(timeout); reject(new Error('The page finder could not start.')); return; }
      runtime.onRuntimeInitialized = () => { clearTimeout(timeout); state.cv = window.cv; resolve(state.cv); };
      runtime.onAbort = () => { clearTimeout(timeout); reject(new Error('The page finder could not start.')); };
    };
    script.onerror = () => { clearTimeout(timeout); reject(new Error('The page finder could not load. Check your connection and try again.')); };
    document.head.appendChild(script);
  }).catch((error) => { state.cvPromise = null; throw error; });
  return state.cvPromise;
}

async function loadPdfLib() {
  if (window.PDFLib?.PDFDocument) return window.PDFLib;
  if (state.pdfPromise) return state.pdfPromise;
  state.pdfPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
    script.async = true;
    script.onload = () => window.PDFLib?.PDFDocument ? resolve(window.PDFLib) : reject(new Error('The PDF maker could not start.'));
    script.onerror = () => reject(new Error('The PDF maker could not load. Check your connection and try again.'));
    document.head.appendChild(script);
  }).catch((error) => { state.pdfPromise = null; throw error; });
  return state.pdfPromise;
}

function makeAnalysisCanvas(source) {
  const limit = 1100;
  const scale = Math.min(1, limit / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, scale };
}

function orderedCorners(points) {
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  const clockwise = [...points].sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
  let first = 0;
  for (let i = 1; i < clockwise.length; i += 1) if (clockwise[i].x + clockwise[i].y < clockwise[first].x + clockwise[first].y) first = i;
  return [...clockwise.slice(first), ...clockwise.slice(0, first)];
}

async function findPageCorners(sourceCanvas) {
  const cv = await loadOpenCv();
  const { canvas: analysis, scale } = makeAnalysisCanvas(sourceCanvas);
  const src = cv.imread(analysis);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let kernel;
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blurred, edges, 35, 115);
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const candidates = [];
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const area = Math.abs(cv.contourArea(contour));
      if (area < analysis.width * analysis.height * 0.12) { contour.delete(); continue; }
      const perimeter = cv.arcLength(contour, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const coords = [];
        for (let j = 0; j < 4; j += 1) coords.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
        const xs = coords.map((p) => p.x), ys = coords.map((p) => p.y);
        const bounds = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
        candidates.push({ area, score: area / Math.max(bounds, 1), points: coords });
      }
      approx.delete();
      contour.delete();
    }
    candidates.sort((a, b) => b.area - a.area);
    const best = candidates.find((candidate) => candidate.area < analysis.width * analysis.height * 0.985 && candidate.score > 0.5);
    if (!best) throw new Error('No clear page outline found.');
    return orderedCorners(best.points.map((point) => ({ x: clamp(Math.round(point.x / scale), 0, sourceCanvas.width - 1), y: clamp(Math.round(point.y / scale), 0, sourceCanvas.height - 1) })));
  } finally {
    src.delete(); gray.delete(); blurred.delete(); edges.delete(); contours.delete(); hierarchy.delete(); kernel?.delete();
  }
}

function fullImageCorners(canvas) {
  const inset = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * 0.035));
  return [{ x: inset, y: inset }, { x: canvas.width - inset - 1, y: inset }, { x: canvas.width - inset - 1, y: canvas.height - inset - 1 }, { x: inset, y: canvas.height - inset - 1 }];
}

function sizeForPoints(points) {
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const width = Math.round(Math.max(distance(points[0], points[1]), distance(points[3], points[2])));
  const height = Math.round(Math.max(distance(points[0], points[3]), distance(points[1], points[2])));
  const scale = Math.min(1, 2800 / Math.max(width, height));
  return { width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale)) };
}

function perspectiveWarp(sourceCanvas, points) {
  const cv = state.cv;
  const { width, height } = sizeForPoints(points);
  const src = cv.imread(sourceCanvas);
  const dst = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, points.flatMap(({ x, y }) => [x, y]));
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]);
  const matrix = cv.getPerspectiveTransform(from, to);
  try {
    cv.warpPerspective(src, dst, matrix, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    const result = document.createElement('canvas');
    result.width = width; result.height = height;
    cv.imshow(result, dst);
    return result;
  } finally { src.delete(); dst.delete(); from.delete(); to.delete(); matrix.delete(); }
}

function makeFilteredCanvas(source, filter) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width; canvas.height = source.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  if (filter === 'color') return canvas;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  let histogram, threshold = 165;
  if (filter === 'bw') {
    histogram = new Uint32Array(256);
    for (let i = 0; i < pixels.length; i += 4) histogram[Math.round(.299 * pixels[i] + .587 * pixels[i + 1] + .114 * pixels[i + 2])] += 1;
    const total = pixels.length / 4;
    let sum = 0; for (let i = 0; i < 256; i += 1) sum += i * histogram[i];
    let sumBackground = 0, weightBackground = 0, maxVariance = -1;
    for (let i = 0; i < 256; i += 1) {
      weightBackground += histogram[i]; if (!weightBackground) continue;
      const weightForeground = total - weightBackground; if (!weightForeground) break;
      sumBackground += i * histogram[i];
      const meanBackground = sumBackground / weightBackground, meanForeground = (sum - sumBackground) / weightForeground;
      const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
      if (variance > maxVariance) { maxVariance = variance; threshold = i; }
    }
  }
  for (let i = 0; i < pixels.length; i += 4) {
    const gray = Math.round(.299 * pixels[i] + .587 * pixels[i + 1] + .114 * pixels[i + 2]);
    const value = filter === 'bw' ? (gray > threshold ? 255 : 22) : gray;
    pixels[i] = value; pixels[i + 1] = value; pixels[i + 2] = value;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function fitCanvasPreview(canvas, source) {
  const maxWidth = Math.max(1, source.clientWidth || source.parentElement.clientWidth - 24);
  const maxHeight = 235;
  const ratio = Math.min(maxWidth / canvas.width, maxHeight / canvas.height, 1);
  canvas.style.width = `${Math.max(1, Math.round(canvas.width * ratio))}px`;
  canvas.style.height = `${Math.max(1, Math.round(canvas.height * ratio))}px`;
}

function syncOverlay(page) {
  if (!page) return;
  const stage = els.imageStage;
  const canvasRect = els.sourceCanvas.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  if (!canvasRect.width || !canvasRect.height) return;
  const left = canvasRect.left - stageRect.left;
  const top = canvasRect.top - stageRect.top;
  els.overlay.style.left = `${left}px`; els.overlay.style.top = `${top}px`;
  els.overlay.style.width = `${canvasRect.width}px`; els.overlay.style.height = `${canvasRect.height}px`;
  els.overlay.setAttribute('viewBox', `0 0 ${page.sourceCanvas.width} ${page.sourceCanvas.height}`);
  const radius = Math.max(9, 10 * page.sourceCanvas.width / canvasRect.width);
  els.overlay.innerHTML = `<polygon class="corner-polygon" points="${page.points.map(({ x, y }) => `${x},${y}`).join(' ')}"></polygon>${page.points.map(({ x, y }, index) => `<circle class="corner-handle" data-corner="${index}" cx="${x}" cy="${y}" r="${radius}" tabindex="0" aria-label="Page corner ${index + 1}"></circle>`).join('')}`;
}

function schedulePreview(page) {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => {
    try {
      page.correctedCanvas = perspectiveWarp(page.sourceCanvas, page.points);
      drawResultPreview(page);
      setStatus(page.autoDetected ? 'Page edges found — adjust if needed' : 'Edges set manually — drag to refine', page.autoDetected ? 'good' : 'manual');
      renderPageList();
    } catch (error) { setStatus('Could not straighten this page', 'error'); showToast(error.message); }
  }, 120);
}

function drawResultPreview(page) {
  if (!page?.correctedCanvas) return;
  const filtered = makeFilteredCanvas(page.correctedCanvas, page.filter);
  const ctx = els.resultCanvas.getContext('2d');
  els.resultCanvas.width = filtered.width; els.resultCanvas.height = filtered.height;
  ctx.drawImage(filtered, 0, 0);
  fitCanvasPreview(els.resultCanvas, els.resultStage);
  els.resultPaper.classList.add('ready');
  els.resultPlaceholder.classList.remove('visible');
}

async function processPage(page) {
  els.imageLoader.classList.add('visible');
  setStatus('Finding the page edges…');
  try {
    page.points = await findPageCorners(page.sourceCanvas);
    page.autoDetected = true;
    page.correctedCanvas = perspectiveWarp(page.sourceCanvas, page.points);
    setStatus('Page edges found — adjust if needed');
  } catch (error) {
    page.points = fullImageCorners(page.sourceCanvas);
    page.autoDetected = false;
    try { page.correctedCanvas = perspectiveWarp(page.sourceCanvas, page.points); } catch { page.correctedCanvas = page.sourceCanvas; }
    setStatus('Page outline not found — drag corners to fit', 'manual');
    if (!state.cv) showToast(error.message);
  } finally {
    els.imageLoader.classList.remove('visible');
    if (selectedPage()?.id === page.id) renderCurrentPage();
    renderPageList();
  }
}

async function addFiles(fileList) {
  const files = [...fileList].filter((file) => file.type.startsWith('image/'));
  if (!files.length) { showToast('Choose JPG, PNG, or another image file to get started.'); return; }
  const invalid = [...fileList].length - files.length;
  if (invalid) showToast('A few files were skipped. Please choose image files.');
  for (const file of files) {
    try {
      const image = await imageFromFile(file);
      const maxSide = 2800;
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0, canvas.width, canvas.height);
      image.close?.();
      const page = { id: uid(), name: fileBaseName(file.name) || `Page ${state.pages.length + 1}`, sourceCanvas: canvas, points: fullImageCorners(canvas), correctedCanvas: null, filter: 'color', autoDetected: false };
      state.pages.push(page);
      if (!state.currentId) state.currentId = page.id;
      updateWorkspaceVisibility();
      if (state.pages.length === 1) els.docName.value = fileBaseName(file.name) || 'Untitled document';
      await processPage(page);
    } catch (error) { showToast(`${file.name}: ${error.message || 'could not be opened.'}`); }
  }
  els.fileInput.value = ''; els.cameraInput.value = '';
  renderCurrentPage(); renderPageList();
}

function updateWorkspaceVisibility() {
  const hasPages = state.pages.length > 0;
  els.emptyState.hidden = hasPages;
  els.workspace.hidden = !hasPages;
  els.addPhotos.hidden = !hasPages;
  els.pagesAdd.hidden = !hasPages;
  els.clearAll.hidden = !hasPages;
  els.addPageCard.hidden = !hasPages;
  els.pagesEmpty.hidden = hasPages;
  els.pagesTip.hidden = hasPages;
  els.exportNote.hidden = !hasPages;
  els.pageCount.textContent = String(state.pages.length);
  els.subtitle.textContent = hasPages ? `${state.pages.length} ${state.pages.length === 1 ? 'page' : 'pages'} · Click to rename` : 'A little order for your paperwork';
  setStep(hasPages ? 2 : 1);
}

function renderCurrentPage() {
  const page = selectedPage();
  if (!page) return;
  state.currentId = page.id;
  els.sourceCanvas.width = page.sourceCanvas.width; els.sourceCanvas.height = page.sourceCanvas.height;
  els.sourceCanvas.getContext('2d').drawImage(page.sourceCanvas, 0, 0);
  els.sourceCanvas.style.width = ''; els.sourceCanvas.style.height = '';
  requestAnimationFrame(() => syncOverlay(page));
  els.resultPaper.classList.remove('ready');
  els.resultPlaceholder.classList.add('visible');
  if (page.correctedCanvas) drawResultPreview(page);
  els.pagePosition.textContent = `Page ${state.pages.findIndex((candidate) => candidate.id === page.id) + 1} of ${state.pages.length}`;
  document.querySelectorAll('.filter-option').forEach((button) => button.classList.toggle('selected', button.dataset.filter === page.filter));
  document.querySelectorAll('.page-item').forEach((item) => item.classList.toggle('selected', item.dataset.id === page.id));
  setStep(2);
}

function canvasThumbnail(canvas) {
  if (!canvas) return '';
  const thumb = document.createElement('canvas');
  const scale = Math.min(1, 96 / Math.max(canvas.width, canvas.height));
  thumb.width = Math.max(1, Math.round(canvas.width * scale)); thumb.height = Math.max(1, Math.round(canvas.height * scale));
  thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL('image/jpeg', .72);
}

function renderPageList() {
  els.pageCount.textContent = String(state.pages.length);
  els.pagePosition.textContent = state.pages.length ? `Page ${state.pages.findIndex((page) => page.id === state.currentId) + 1} of ${state.pages.length}` : '';
  els.pageList.innerHTML = '';
  state.pages.forEach((page, index) => {
    const item = document.createElement('li'); item.className = `page-item${page.id === state.currentId ? ' selected' : ''}`; item.dataset.id = page.id; item.tabIndex = 0; item.setAttribute('role', 'button'); item.setAttribute('aria-label', `Select page ${index + 1}: ${page.name}`);
    const thumb = document.createElement('div'); thumb.className = 'page-thumb';
    if (page.correctedCanvas) { const image = new Image(); image.alt = ''; image.src = canvasThumbnail(makeFilteredCanvas(page.correctedCanvas, page.filter)); thumb.append(image); }
    const info = document.createElement('div'); info.className = 'page-info';
    const name = document.createElement('strong'); name.textContent = page.name;
    const detail = document.createElement('small'); detail.textContent = page.autoDetected ? 'Edges detected' : 'Manual edges';
    info.append(name, detail);
    const tools = document.createElement('div'); tools.className = 'page-tools';
    const up = document.createElement('button'); up.type = 'button'; up.className = 'page-tool'; up.textContent = '↑'; up.title = 'Move page up'; up.setAttribute('aria-label', 'Move page up'); up.disabled = index === 0; up.addEventListener('click', (event) => { event.stopPropagation(); movePage(index, -1); });
    const down = document.createElement('button'); down.type = 'button'; down.className = 'page-tool'; down.textContent = '↓'; down.title = 'Move page down'; down.setAttribute('aria-label', 'Move page down'); down.disabled = index === state.pages.length - 1; down.addEventListener('click', (event) => { event.stopPropagation(); movePage(index, 1); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'page-tool remove'; remove.textContent = '×'; remove.title = 'Remove page'; remove.setAttribute('aria-label', `Remove ${page.name}`); remove.addEventListener('click', (event) => { event.stopPropagation(); removePage(page.id); });
    tools.append(up, down, remove); item.append(thumb, info, tools);
    item.addEventListener('click', () => { state.currentId = page.id; renderCurrentPage(); });
    item.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); state.currentId = page.id; renderCurrentPage(); } });
    els.pageList.append(item);
  });
}

function movePage(index, amount) {
  const target = index + amount;
  if (target < 0 || target >= state.pages.length) return;
  [state.pages[index], state.pages[target]] = [state.pages[target], state.pages[index]];
  renderCurrentPage(); renderPageList();
}

function removePage(id) {
  const index = state.pages.findIndex((page) => page.id === id);
  if (index < 0) return;
  state.pages.splice(index, 1);
  if (state.currentId === id) state.currentId = state.pages[Math.min(index, state.pages.length - 1)]?.id || null;
  updateWorkspaceVisibility(); renderPageList();
  if (state.pages.length) renderCurrentPage();
}

async function redoDetection() {
  const page = selectedPage(); if (!page) return;
  els.imageLoader.classList.add('visible');
  try {
    page.points = await findPageCorners(page.sourceCanvas); page.autoDetected = true;
    page.correctedCanvas = perspectiveWarp(page.sourceCanvas, page.points);
    setStatus('Page edges found — adjust if needed'); renderCurrentPage(); renderPageList();
  } catch (error) { page.autoDetected = false; setStatus('Page outline not found — drag corners to fit', 'manual'); showToast('Couldn’t find a new outline. Try adjusting the corners by hand.'); }
  finally { els.imageLoader.classList.remove('visible'); }
}

function setFilter(filter) {
  const page = selectedPage(); if (!page) return;
  page.filter = filter; drawResultPreview(page); renderPageList();
  document.querySelectorAll('.filter-option').forEach((button) => button.classList.toggle('selected', button.dataset.filter === filter));
}

async function exportPdf() {
  if (!state.pages.length || state.isExporting) return;
  state.isExporting = true; els.createPdf.disabled = true; els.createPdf.querySelector('span:first-child').textContent = 'Making your PDF…';
  try {
    const { PDFDocument } = await loadPdfLib();
    const pdf = await PDFDocument.create();
    const format = 'a4';
    for (const page of state.pages) {
      if (!page.correctedCanvas) page.correctedCanvas = page.sourceCanvas;
      const imageCanvas = makeFilteredCanvas(page.correctedCanvas, page.filter);
      const bytes = await new Promise((resolve, reject) => imageCanvas.toBlob((blob) => blob ? blob.arrayBuffer().then(resolve) : reject(new Error(`Could not prepare ${page.name}.`)), 'image/jpeg', .93));
      const image = await pdf.embedJpg(bytes);
      const [portraitWidth, portraitHeight] = format === 'letter' ? [612, 792] : [595.28, 841.89];
      const landscape = image.width / image.height > 1.06;
      const pageWidth = landscape ? portraitHeight : portraitWidth;
      const pageHeight = landscape ? portraitWidth : portraitHeight;
      const sheet = pdf.addPage([pageWidth, pageHeight]);
      const margin = 17;
      const scale = Math.min((pageWidth - margin * 2) / image.width, (pageHeight - margin * 2) / image.height);
      const width = image.width * scale, height = image.height * scale;
      sheet.drawImage(image, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
    }
    const bytes = await pdf.save();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const title = (els.docName.value.trim() || 'folio-scan').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-');
    anchor.href = url; anchor.download = `${title}.pdf`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    els.exportNote.hidden = false; setStep(3); showToast('Your scan is ready to share.');
  } catch (error) { showToast(error.message || 'Couldn’t create your PDF. Please try again.'); }
  finally { state.isExporting = false; els.createPdf.disabled = false; els.createPdf.querySelector('span:first-child').textContent = 'Create PDF'; }
}

function openFilePicker(input) { input.click(); }

els.choosePhotos.addEventListener('click', () => openFilePicker(els.fileInput));
els.takePhoto.addEventListener('click', () => openFilePicker(els.cameraInput));
els.addPhotos.addEventListener('click', () => openFilePicker(els.fileInput));
els.pagesAdd.addEventListener('click', () => openFilePicker(els.fileInput));
els.addPageCard.addEventListener('click', () => openFilePicker(els.fileInput));
els.fileInput.addEventListener('change', () => addFiles(els.fileInput.files));
els.cameraInput.addEventListener('change', () => addFiles(els.cameraInput.files));
els.autoDetect.addEventListener('click', redoDetection);
els.createPdf.addEventListener('click', exportPdf);
document.querySelectorAll('.filter-option').forEach((button) => button.addEventListener('click', () => setFilter(button.dataset.filter)));

els.dropZone.addEventListener('click', (event) => { if (event.target.closest('button')) return; openFilePicker(els.fileInput); });
els.dropZone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFilePicker(els.fileInput); } });
for (const eventName of ['dragenter', 'dragover']) els.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); els.dropZone.classList.add('drag-active'); });
for (const eventName of ['dragleave', 'drop']) els.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); els.dropZone.classList.remove('drag-active'); });
els.dropZone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => { if (event.target.closest('#dropZone')) return; event.preventDefault(); if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files); });

let draggingCorner = null;
els.overlay.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest('[data-corner]'); if (!handle) return;
  event.preventDefault(); draggingCorner = Number(handle.dataset.corner); els.overlay.setPointerCapture(event.pointerId);
});
els.overlay.addEventListener('pointermove', (event) => {
  if (draggingCorner === null) return;
  const page = selectedPage(); if (!page) return;
  const rect = els.overlay.getBoundingClientRect();
  page.points[draggingCorner] = { x: clamp((event.clientX - rect.left) / rect.width * page.sourceCanvas.width, 0, page.sourceCanvas.width - 1), y: clamp((event.clientY - rect.top) / rect.height * page.sourceCanvas.height, 0, page.sourceCanvas.height - 1) };
  syncOverlay(page); els.resultPlaceholder.classList.add('visible'); els.resultPaper.classList.remove('ready'); schedulePreview(page);
});
els.overlay.addEventListener('pointerup', () => { draggingCorner = null; });
els.clearAll.addEventListener('click', () => { state.pages = []; state.currentId = null; updateWorkspaceVisibility(); renderPageList(); els.docName.value = 'Untitled document'; });
window.addEventListener('resize', () => { const page = selectedPage(); if (page) syncOverlay(page); });

