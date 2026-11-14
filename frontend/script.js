const DEFAULT_SURVEY = 'P/DSS2/color';
const state = {
  userId: localStorage.getItem('ylma_user_id') || 'YLMA-USER-2026',
  currentRA: 150.1,
  currentDec: 2.2,
  currentFov: 10,
  currentFitsUrl: '',
  isSplit: false,
  blinkActive: false,
  blinkTimer: null,
  blinkIndex: 0,
  blinkViewer: null,
  mainViewer: null,
  leftViewer: null,
  rightViewer: null
};

const $ = (id) => document.getElementById(id);
let aladinReady;

document.addEventListener('DOMContentLoaded', () => {
  const badge = $('user-session-badge');
  if (badge) badge.textContent = state.userId;
  setupEventListeners();
});

function waitForAladin() {
  if (!aladinReady) {
    if (!window.A || !A.init) return Promise.reject(new Error('No se pudo cargar la API de Aladin Lite.'));
    aladinReady = A.init;
  }
  return aladinReady;
}

function showLoading(message = 'CARGANDO FITS…') {
  const overlay = $('loading-overlay');
  if (overlay) {
    $('loading-text').textContent = message;
    overlay.classList.add('active');
  }
}

function hideLoading() {
  $('loading-overlay')?.classList.remove('active');
}

function reportError(error) {
  console.error(error);
  const status = $('info-status');
  if (status) status.textContent = error.message || 'Error al cargar';
  hideLoading();
}

async function createViewer(container, options = {}) {
  await waitForAladin();
  return A.aladin(`#${container}`, {
    target: `${state.currentRA} ${state.currentDec}`,
    fov: state.currentFov,
    projection: 'AIT',
    cooFrame: 'equatorial',
    showCooGridControl: true,
    showCooGrid: true,
    survey: DEFAULT_SURVEY,
    ...options
  });
}

async function initMainViewer() {
  if (state.mainViewer) {
    state.mainViewer.refresh?.();
    state.mainViewer.getBaseImageLayer?.()?.setVisible?.(true);
    state.mainViewer.gotoRaDec(state.currentRA, state.currentDec);
    state.mainViewer.setFoV(state.currentFov);
    return state.mainViewer;
  }
  showLoading('INICIALIZANDO ALADIN LITE…');
  try {
    state.mainViewer = await createViewer('aladin-lite-div', { showSimbadPointerControl: true });
    state.mainViewer.on('positionChanged', (ra, dec) => {
      $('hud-coords').textContent = `RA: ${ra.toFixed(4)} | Dec: ${dec >= 0 ? '+' : ''}${dec.toFixed(4)}`;
    });
    hideLoading();
    $('info-status').textContent = 'Aladin Lite listo';
    return state.mainViewer;
  } catch (error) {
    reportError(error);
    throw error;
  }
}

function updateCoordinates() {
  if (state.mainViewer) {
    state.mainViewer.gotoRaDec(state.currentRA, state.currentDec);
    state.mainViewer.setFoV(state.currentFov);
  }
  $('info-radec').textContent = `${state.currentRA.toFixed(3)}, ${state.currentDec >= 0 ? '+' : ''}${state.currentDec.toFixed(3)}`;
}

function setActiveLayer(buttonId) {
  ['layer-real', 'layer-fits'].forEach((id) => $(id)?.classList.toggle('active', id === buttonId));
}

function displayFits(viewer, rawUrl, imageName = 'SPHEREx FITS') {
  const url = rawUrl.trim();
  if (!url) throw new Error('Introduce una URL directa a un archivo FITS.');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('La URL FITS no es válida.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('La URL debe usar HTTP o HTTPS.');
  if (!viewer || typeof viewer.displayFITS !== 'function') throw new Error('El visor Aladin Lite aún no está listo.');

  showLoading('DESCARGANDO Y PROCESANDO FITS…');
  $('info-status').textContent = 'Cargando FITS…';
  viewer.displayFITS(url, {}, (ra, dec, fov, image) => {
    if (image?.setColormap) image.setColormap('magma', { stretch: 'sqrt' });
    if (Number.isFinite(ra) && Number.isFinite(dec)) viewer.gotoRaDec(ra, dec);
    if (Number.isFinite(fov) && fov > 0) viewer.setFoV(2 * fov);
    hideLoading();
    $('info-status').textContent = 'FITS cargado';
    $('info-fits-url').textContent = url;
    $('hud-survey').textContent = `FITS: ${imageName}`;
    state.currentFitsUrl = url;
  });
}

async function loadMainFits(url = $('fits-url-input').value) {
  try {
    await initMainViewer();
    displayFits(state.mainViewer, url);
    setActiveLayer('layer-fits');
  } catch (error) {
    reportError(error);
  }
}

async function initSplitView() {
  const container = $('split-view-container');
  container.hidden = false;
  state.isSplit = true;
  $('btn-split').classList.add('active');
  $('btn-split').setAttribute('aria-pressed', 'true');
  $('aladin-lite-div').style.display = 'none';
  if (state.leftViewer && state.rightViewer) {
    state.leftViewer.refresh?.();
    state.rightViewer.refresh?.();
    return;
  }
  try {
    await waitForAladin();
    state.leftViewer = await createViewer('aladin-left-div');
    state.rightViewer = await createViewer('aladin-right-div');
  } catch (error) {
    reportError(error);
    closeSplitView();
  }
}

function closeSplitView() {
  state.isSplit = false;
  $('split-view-container').hidden = true;
  $('aladin-lite-div').style.display = '';
  $('btn-split').classList.remove('active');
  $('btn-split').setAttribute('aria-pressed', 'false');
  state.mainViewer?.refresh?.();
}

function loadSplitFits(side) {
  const viewer = side === 'left' ? state.leftViewer : state.rightViewer;
  const input = $(side === 'left' ? 'split-url-left' : 'split-url-right');
  try { displayFits(viewer, input.value, `FITS ${side === 'left' ? 'A' : 'B'}`); }
  catch (error) { reportError(error); }
}

async function initBlinkViewer() {
  if (!state.blinkViewer) state.blinkViewer = await createViewer('blink-aladin-div', { showCooGridControl: false, showCooGrid: false });
  else state.blinkViewer.refresh?.();
  return state.blinkViewer;
}

async function toggleBlink() {
  const urlA = $('blink-fits-url-1').value.trim();
  const urlB = $('blink-fits-url-2').value.trim();
  if (!urlA || !urlB) {
    $('blink-status-label').textContent = 'Introduce las dos URLs directas a archivos FITS.';
    return;
  }
  if (state.blinkActive) {
    stopBlink();
    return;
  }
  try {
    await initBlinkViewer();
    state.blinkActive = true;
    state.blinkIndex = 0;
    $('blink-start-toggle').textContent = 'DETENER BLINK';
    const switchImage = () => {
      const urls = [urlA, urlB];
      const url = urls[state.blinkIndex % 2];
      $('blink-status-label').textContent = `CARGANDO FITS ${state.blinkIndex % 2 === 0 ? 'A' : 'B'}…`;
      try {
        state.blinkViewer.displayFITS(url, {}, () => {
          $('blink-status-label').textContent = `FITS ${state.blinkIndex % 2 === 0 ? 'A' : 'B'} · ${url}`;
        });
      } catch (error) {
        $('blink-status-label').textContent = error.message;
        stopBlink();
      }
      state.blinkIndex += 1;
    };
    switchImage();
    state.blinkTimer = window.setInterval(switchImage, 2500);
  } catch (error) {
    $('blink-status-label').textContent = error.message;
    reportError(error);
  }
}

function stopBlink() {
  state.blinkActive = false;
  if (state.blinkTimer) window.clearInterval(state.blinkTimer);
  state.blinkTimer = null;
  $('blink-start-toggle').textContent = 'INICIAR BLINK';
}

function openModal(id) {
  $(id).classList.add('active');
  $(id).setAttribute('aria-hidden', 'false');
}
function closeModal(id) {
  $(id).classList.remove('active');
  $(id).setAttribute('aria-hidden', 'true');
}

function setupEventListeners() {
  $('explore-btn').addEventListener('click', async () => {
    $('landing-view').classList.remove('active');
    $('explorer-view').classList.add('active');
    try { await initMainViewer(); } catch { /* Error is displayed in the status panel. */ }
  });
  $('back-home').addEventListener('click', () => {
    $('explorer-view').classList.remove('active');
    $('landing-view').classList.add('active');
  });
  $('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    state.currentRA = Number($('input-ra').value);
    state.currentDec = Number($('input-dec').value);
    state.currentFov = Number($('input-radius').value);
    updateCoordinates();
  });
  $('fits-url-form').addEventListener('submit', (event) => {
    event.preventDefault();
    loadMainFits();
  });
  $('layer-real').addEventListener('click', async () => {
    try {
      const viewer = await initMainViewer();
      viewer.setImageSurvey(DEFAULT_SURVEY);
      $('hud-survey').textContent = 'SURVEY: DSS2/color';
      $('info-fits-url').textContent = 'Ninguno';
      setActiveLayer('layer-real');
    } catch (error) { reportError(error); }
  });
  $('layer-fits').addEventListener('click', () => loadMainFits());
  $('btn-split').addEventListener('click', () => state.isSplit ? closeSplitView() : initSplitView());
  $('load-split-left').addEventListener('click', () => loadSplitFits('left'));
  $('load-split-right').addEventListener('click', () => loadSplitFits('right'));
  $('btn-blink').addEventListener('click', async () => {
    openModal('blink-modal');
    try { await initBlinkViewer(); } catch (error) { $('blink-status-label').textContent = error.message; }
  });
  $('blink-start-toggle').addEventListener('click', toggleBlink);
  $('blink-close-btn').addEventListener('click', () => { stopBlink(); closeModal('blink-modal'); });
  $('objects-close-btn').addEventListener('click', () => closeModal('objects-modal'));
  $('nav-objects-btn').addEventListener('click', () => openModal('objects-modal'));
  $('btn-fs').addEventListener('click', () => {
    const stage = $('visor-stage');
    if (!document.fullscreenElement) stage.requestFullscreen?.().catch(reportError);
    else document.exitFullscreen?.();
  });
  document.querySelectorAll('.modal-overlay').forEach((modal) => modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      if (modal.id === 'blink-modal') stopBlink();
      closeModal(modal.id);
    }
  }));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      stopBlink();
      document.querySelectorAll('.modal-overlay.active').forEach((modal) => closeModal(modal.id));
    }
  });
}
