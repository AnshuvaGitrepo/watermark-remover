import { removeWatermarkFromImage, createWatermarkEngine } from '@pilio/gemini-watermark-remover/browser';

const dropZone = document.getElementById('dropZone');
const imageInput = document.getElementById('imageInput');
const adaptiveMode = document.getElementById('adaptiveMode');
const exportFormat = document.getElementById('exportFormat');
const downloadBtn = document.getElementById('downloadBtn');
const resetBtn = document.getElementById('resetBtn');

const btnViewClean = document.getElementById('btnViewClean');
const btnViewOriginal = document.getElementById('btnViewOriginal');

const loadingSpinner = document.getElementById('loadingSpinner');
const placeholderText = document.getElementById('placeholderText');
const previewImg = document.getElementById('previewImg');

const statusAlert = document.getElementById('statusAlert');
const statusText = document.getElementById('statusText');
const timingText = document.getElementById('timingText');

const footerIp = document.getElementById('footerIp');
const footerRemaining = document.getElementById('footerRemaining');
const footerLimit = document.getElementById('footerLimit');

let loadedImageElement = null;
let originalDataUrl = null;
let cleanedDataUrl = null;
let watermarkEngine = null;
let activeView = 'clean';
let latestQuota = { remaining: null, inFlight: false };
let isLocalBusy = false;
let jobGeneration = 0;

function applyQuotaState(data) {
  latestQuota = data;
  footerIp.textContent = data.ip;
  footerRemaining.textContent = String(data.remaining);
  footerLimit.textContent = String(data.limit);
  const blocked = data.remaining <= 0 || data.inFlight;
  dropZone.classList.toggle('disabled', blocked);
}

function connectQuotaStream() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    try {
      applyQuotaState(JSON.parse(e.data));
    } catch {
      /* ignore malformed keep-alive frames */
    }
  };
  es.onerror = () => {
    footerIp.textContent = 'offline';
  };
}

async function reserveSlot() {
  const res = await fetch('/api/start', { method: 'POST' });
  const data = await res.json();
  applyQuotaState(data);
  if (!res.ok || !data.allowed) {
    throw new Error(data.reason || 'Request was not allowed by the server.');
  }
}

async function releaseSlot() {
  try {
    const res = await fetch('/api/finish', { method: 'POST' });
    applyQuotaState(await res.json());
  } catch (err) {
    console.warn('Failed to notify server that the job finished:', err);
  }
}

connectQuotaStream();

async function getEngine() {
  if (!watermarkEngine) {
    watermarkEngine = await createWatermarkEngine();
  }
  return watermarkEngine;
}

dropZone.addEventListener('click', () => {
  if (isLocalBusy) return;
  imageInput.click();
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (isLocalBusy) return;
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    handleFileSelect(e.dataTransfer.files[0]);
  }
});

imageInput.addEventListener('change', (e) => {
  if (isLocalBusy) return;
  if (e.target.files && e.target.files[0]) {
    handleFileSelect(e.target.files[0]);
  }
});

adaptiveMode.addEventListener('change', () => {
  if (loadedImageElement && !isLocalBusy) processWatermarkRemoval();
});

exportFormat.addEventListener('change', () => {
  if (cleanedDataUrl && activeView === 'clean' && !isLocalBusy) processWatermarkRemoval();
});

btnViewClean.addEventListener('click', () => {
  activeView = 'clean';
  btnViewClean.classList.add('active');
  btnViewOriginal.classList.remove('active');
  updatePreviewDisplay();
});

btnViewOriginal.addEventListener('click', () => {
  activeView = 'original';
  btnViewOriginal.classList.add('active');
  btnViewClean.classList.remove('active');
  updatePreviewDisplay();
});

resetBtn.addEventListener('click', resetState);
downloadBtn.addEventListener('click', handleDownload);

function failFileLoad(message) {
  isLocalBusy = false;
  loadedImageElement = null;
  originalDataUrl = null;
  imageInput.value = '';
  dropZone.classList.toggle('disabled', latestQuota.remaining <= 0 || latestQuota.inFlight);
  alert(message);
}

function handleFileSelect(file) {
  if (!file.type.startsWith('image/')) {
    alert('Please select a valid image file (PNG, JPG, WebP, GIF).');
    return;
  }

  if (file.size > 25 * 1024 * 1024) {
    alert('File size exceeds 25MB limit. Please select a smaller image.');
    return;
  }

  isLocalBusy = true;
  dropZone.classList.add('disabled');

  const reader = new FileReader();
  reader.onerror = () => failFileLoad('Could not read the selected file. Please try again.');
  reader.onload = (e) => {
    originalDataUrl = e.target.result;
    const img = new Image();
    img.onerror = () => failFileLoad('That file is not a readable image. Please choose a different one.');
    img.onload = () => {
      try {
        const MAX_DIMENSION = 4000;
        let drawWidth = img.naturalWidth;
        let drawHeight = img.naturalHeight;
        if (drawWidth > MAX_DIMENSION || drawHeight > MAX_DIMENSION) {
          const scale = Math.min(MAX_DIMENSION / drawWidth, MAX_DIMENSION / drawHeight);
          drawWidth = Math.floor(drawWidth * scale);
          drawHeight = Math.floor(drawHeight * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = drawWidth;
        canvas.height = drawHeight;
        canvas.getContext('2d').drawImage(img, 0, 0, drawWidth, drawHeight);
        loadedImageElement = canvas;
        processWatermarkRemoval();
      } catch (err) {
        failFileLoad('Could not decode that image: ' + err.message);
      }
    };
    img.src = originalDataUrl;
  };
  reader.readAsDataURL(file);
}

async function processWatermarkRemoval() {
  if (!loadedImageElement) return;

  const generation = ++jobGeneration;
  isLocalBusy = true;
  dropZone.classList.add('disabled');

  let slotReserved = false;
  try {
    await reserveSlot();
    slotReserved = true;
  } catch (err) {
    if (generation === jobGeneration) {
      isLocalBusy = false;
      dropZone.classList.toggle('disabled', latestQuota.remaining <= 0 || latestQuota.inFlight);
      alert(err.message);
    }
    return;
  }

  if (generation !== jobGeneration) {
    // Superseded by a reset while we were waiting on the server; release the
    // slot we just reserved and discard this run's output.
    await releaseSlot();
    return;
  }

  placeholderText.classList.add('d-none');
  previewImg.classList.add('d-none');
  loadingSpinner.classList.remove('d-none');
  statusAlert.classList.add('d-none');
  downloadBtn.disabled = true;

  const startTime = performance.now();

  try {
    const engine = await getEngine();
    const result = await removeWatermarkFromImage(loadedImageElement, {
      engine,
      adaptiveMode: adaptiveMode.checked ? 'always' : 'auto'
    });

    const mime = exportFormat.value || 'image/png';
    const dataUrl = await canvasToDataURL(result.canvas, mime, 0.95);
    const elapsed = Math.round(performance.now() - startTime);

    if (generation !== jobGeneration) return;

    cleanedDataUrl = dataUrl;
    activeView = 'clean';
    btnViewClean.classList.add('active');
    btnViewOriginal.classList.remove('active');
    updatePreviewDisplay();

    statusText.textContent = `Watermark processed successfully (${result.canvas.width}x${result.canvas.height}px)`;
    timingText.textContent = `${elapsed}ms`;
    statusAlert.classList.remove('d-none');

    downloadBtn.disabled = false;
  } catch (err) {
    console.error('Error removing watermark:', err);
    if (generation === jobGeneration) alert('Error processing image watermark: ' + err.message);
  } finally {
    if (generation === jobGeneration) {
      loadingSpinner.classList.add('d-none');
      isLocalBusy = false;
    }
    if (slotReserved) await releaseSlot();
  }
}

async function canvasToDataURL(canvas, mime = 'image/png', quality = 0.95) {
  if (typeof canvas.toDataURL === 'function') {
    return canvas.toDataURL(mime, quality);
  }

  if (typeof canvas.convertToBlob === 'function') {
    const blob = await canvas.convertToBlob({ type: mime, quality });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  throw new Error('Canvas conversion to Data URL is not supported in this environment.');
}

function updatePreviewDisplay() {
  previewImg.src = activeView === 'original' ? originalDataUrl : (cleanedDataUrl || originalDataUrl);
  previewImg.classList.remove('d-none');
}

function handleDownload() {
  if (!cleanedDataUrl) return;
  const format = exportFormat.value || 'image/png';
  const ext = format.split('/')[1] || 'png';
  const a = document.createElement('a');
  a.href = cleanedDataUrl;
  a.download = `gemini_watermark_removed_${Date.now()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function resetState() {
  jobGeneration += 1;
  isLocalBusy = false;

  loadedImageElement = null;
  originalDataUrl = null;
  cleanedDataUrl = null;
  imageInput.value = '';

  previewImg.classList.add('d-none');
  placeholderText.classList.remove('d-none');
  statusAlert.classList.add('d-none');
  loadingSpinner.classList.add('d-none');
  downloadBtn.disabled = true;

  btnViewClean.classList.add('active');
  btnViewOriginal.classList.remove('active');
  activeView = 'clean';

  dropZone.classList.toggle('disabled', latestQuota.remaining <= 0 || latestQuota.inFlight);
}
