// Cutout — client-side background remover.
// Uses @imgly/background-removal (ISNet matting model) running fully in-browser
// via ONNX Runtime Web (WebGPU when available, WASM fallback). No uploads.

let removeBackground = null;
let modelLib = null;

// Lazy-load the library only when the user picks an image (keeps first paint fast).
async function ensureLib() {
  if (removeBackground) return removeBackground;
  setProgress('Loading AI engine…', 5);
  const mod = await import('https://esm.sh/@imgly/background-removal@1.7.0');
  modelLib = mod;
  removeBackground = mod.removeBackground || mod.default || mod;
  if (typeof removeBackground !== 'function') {
    throw new Error('Background-removal library failed to load.');
  }
  return removeBackground;
}

// Lazy-load the in-browser upscaler (UpscalerJS + ESRGAN model via TensorFlow.js).
// Cached per scale factor. Runs entirely on-device — nothing is uploaded.
const upscalers = {};
async function ensureUpscaler(scale) {
  if (upscalers[scale]) return upscalers[scale];
  setProgress('Loading upscaler… (first time downloads the model)', 5);
  const [uMod, mMod] = await Promise.all([
    import('https://esm.sh/upscaler@1.0.0'),
    import(`https://esm.sh/@upscalerjs/esrgan-slim@1.0.0/${scale}x`),
  ]);
  const Upscaler = uMod.default || uMod;
  const model = mMod.default || mMod;
  if (typeof Upscaler !== 'function') throw new Error('Upscaler library failed to load.');
  const up = new Upscaler({ model });
  upscalers[scale] = up;
  return up;
}

const $ = (id) => document.getElementById(id);

// ---- Global "images processed" counter ----
const statsBar = document.getElementById('statsBar');
const statCount = document.getElementById('statCount');
function renderCount(n) {
  if (typeof n !== 'number' || n < 0) return;
  statCount.textContent = n.toLocaleString();
  statsBar.hidden = false;
}
async function loadStats() {
  try {
    const r = await fetch('/api/stats');
    const d = await r.json();
    renderCount(d.processed);
  } catch { /* stats are best-effort; ignore */ }
}
async function bumpStats() {
  try {
    const r = await fetch('/api/processed', { method: 'POST' });
    const d = await r.json();
    renderCount(d.processed);
  } catch { /* ignore */ }
}
loadStats();
const dropzone = $('dropzone');
const fileInput = $('fileInput');
const workspace = $('workspace');
const origImg = $('origImg');
const resultImg = $('resultImg');
const progressOverlay = $('progressOverlay');
const progressText = $('progressText');
const progressFill = $('progressFill');
const downloadBtn = $('downloadBtn');
const newBtn = $('newBtn');
const errorBox = $('errorBox');
const customColor = $('customColor');

// State
let cutoutBlobUrl = null;   // transparent PNG object URL (the raw matte result)
let cutoutBitmap = null;    // ImageBitmap of the transparent result, for compositing
let currentBg = 'transparent';
let currentName = 'cutout';
let mode = 'bg';            // 'bg' | 'upscale'
let lastFile = null;        // most recently selected file (upscale runs on click)
let upscaledURL = null;     // data URL of the upscaled result

function setProgress(text, pct) {
  progressOverlay.classList.remove('hidden');
  progressText.textContent = text;
  if (typeof pct === 'number') progressFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
}
function hideProgress() { progressOverlay.classList.add('hidden'); }
function showError(msg) {
  errorBox.textContent = '⚠️ ' + msg;
  errorBox.classList.remove('hidden');
  hideProgress();
}
function clearError() { errorBox.classList.add('hidden'); }

// ---- Input wiring ----
$('browseBtn').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });

['dragenter', 'dragover'].forEach(ev =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});

// Paste from clipboard
window.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.type.startsWith('image/')) { handleFile(it.getAsFile()); break; }
  }
});

newBtn.addEventListener('click', resetAll);

function resetAll() {
  workspace.classList.add('hidden');
  dropzone.classList.remove('hidden');
  clearError();
  if (cutoutBlobUrl) URL.revokeObjectURL(cutoutBlobUrl);
  cutoutBlobUrl = null; cutoutBitmap = null;
  upscaledURL = null;
  resultImg.removeAttribute('src');
  resultImg._exportURL = null;
  origImg.removeAttribute('src');
  downloadBtn.disabled = true;
  if (upscaleBtn) upscaleBtn.disabled = false;
  fileInput.value = '';
}

// ---- Mode switcher (background removal ⇄ upscale) ----
const modeBtns = document.querySelectorAll('.mode-btn');
const bgOptions = $('bgOptions');
const upscaleOptions = $('upscaleOptions');
const resultHolder = $('resultHolder');
const dzTitle = $('dzTitle');
const scaleSelect = $('scaleSelect');
const upscaleBtn = $('upscaleBtn');

function applyMode(m) {
  mode = m;
  modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  bgOptions.classList.toggle('hidden', m !== 'bg');
  upscaleOptions.classList.toggle('hidden', m !== 'upscale');
  resultHolder.classList.toggle('checker', m === 'bg'); // opaque bg for upscale
  dzTitle.textContent = m === 'bg' ? 'Drop an image here' : 'Drop an image to upscale';
  resetAll();
}
modeBtns.forEach(b => b.addEventListener('click', () => applyMode(b.dataset.mode)));

// ---- Upscale flow ----
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

upscaleBtn.addEventListener('click', async () => {
  if (!lastFile) return;
  clearError();
  const scale = scaleSelect.value;
  downloadBtn.disabled = true;
  upscaleBtn.disabled = true;
  setProgress('Loading upscaler… (first time downloads the model)', 5);
  try {
    const up = await ensureUpscaler(scale);
    const img = await loadImage(lastFile);
    if (Math.max(img.width, img.height) * Number(scale) > 8000) {
      throw new Error('that image is too large for ' + scale + '× — try 2× or a smaller image');
    }
    setProgress('Upscaling… this can take a bit', 12);
    let out = await up.upscale(img, {
      output: 'base64',
      patchSize: 128,
      padding: 6,
      progress: (rate) => setProgress('Upscaling… this can take a bit', 12 + (rate || 0) * 86),
    });
    if (!String(out).startsWith('data:')) out = 'data:image/png;base64,' + out;
    upscaledURL = out;
    resultImg.src = out;
    resultImg._exportURL = out;
    hideProgress();
    downloadBtn.disabled = false;
    bumpStats();
  } catch (err) {
    console.error(err);
    showError('Upscaling failed: ' + (err?.message || err) + '. Try a smaller image or a browser with WebGL support.');
  } finally {
    upscaleBtn.disabled = false;
  }
});

// ---- Main flow ----
async function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showError('Please choose an image file (PNG, JPG, WebP, etc.).');
    return;
  }
  clearError();
  currentName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'cutout';

  // Show original + switch to workspace
  const origUrl = URL.createObjectURL(file);
  origImg.src = origUrl;
  dropzone.classList.add('hidden');
  workspace.classList.remove('hidden');
  resultImg.removeAttribute('src');
  downloadBtn.disabled = true;
  lastFile = file;

  if (mode === 'bg') {
    await runBgRemoval(file);
  } else {
    hideProgress(); // upscale runs when the user clicks "Upscale"
  }
}

async function runBgRemoval(file) {
  setProgress('Loading AI model…', 8);
  try {
    const remove = await ensureLib();
    setProgress('Removing background…', 15);

    const config = {
      output: { format: 'image/png', quality: 0.9 },
      model: 'isnet_fp16', // best quality/size balance
      progress: (key, current, total) => {
        // key looks like "fetch:/models/…" during model download, then compute steps
        const frac = total ? current / total : 0;
        if (String(key).startsWith('fetch')) {
          setProgress('Downloading AI model… (first time only)', 15 + frac * 55);
        } else {
          setProgress('Removing background…', 70 + frac * 28);
        }
      },
    };

    const resultBlob = await remove(file, config);

    if (cutoutBlobUrl) URL.revokeObjectURL(cutoutBlobUrl);
    cutoutBlobUrl = URL.createObjectURL(resultBlob);
    cutoutBitmap = await createImageBitmap(resultBlob);

    await renderWithBackground(currentBg);
    hideProgress();
    downloadBtn.disabled = false;
    bumpStats(); // count this successful removal in the global tally
  } catch (err) {
    console.error(err);
    showError('Could not remove the background: ' + (err?.message || err) +
      '. Try a different image, or a browser with WebGPU/WebAssembly support.');
  }
}

// Composite the transparent cutout over the chosen background color (or leave transparent).
async function renderWithBackground(bg) {
  currentBg = bg;
  if (!cutoutBitmap) return;
  const w = cutoutBitmap.width, h = cutoutBitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (bg && bg !== 'transparent') {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(cutoutBitmap, 0, 0);
  const url = canvas.toDataURL('image/png');
  resultImg.src = url;
  resultImg._exportCanvas = canvas; // stash for download
}

// ---- Background swatches ----
document.querySelectorAll('.bg-swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('custom')) return; // handled by color input
    document.querySelectorAll('.bg-swatch').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderWithBackground(btn.dataset.bg);
  });
});
customColor.addEventListener('input', () => {
  document.querySelectorAll('.bg-swatch').forEach(b => b.classList.remove('active'));
  customColor.closest('.bg-swatch').classList.add('active');
  renderWithBackground(customColor.value);
});

// ---- Download ----
downloadBtn.addEventListener('click', () => {
  if (mode === 'upscale') {
    if (!upscaledURL) return;
    const a = document.createElement('a');
    a.href = upscaledURL;
    a.download = `${currentName}-upscaled-${scaleSelect.value}x.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const canvas = resultImg._exportCanvas;
  if (!canvas) return;
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${currentName}-cutout.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
});
