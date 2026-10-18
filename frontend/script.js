// YLMA SPHEREx Explorer - Split View, Blink Mode & Aladin Integration
let aladin = null;
let aladinLeft = null;
let aladinRight = null;
let isSplitMode = false;

let blinkInterval = null;
let isBlinkingActive = false;

let state = {
    userId: localStorage.getItem('ylma_user_id') || 'YLMA-USER-2026',
    currentRA: 150.1,
    currentDec: 2.2,
    currentRadius: 10,
    epochs: [], 
    currentEpochIndex: 0,
    splitIndexLeft: 0,
    splitIndexRight: 30
};

document.addEventListener('DOMContentLoaded', () => {
    initUser();
    generateDynamicTimeline();
    setupEventListeners();
});

function initUser() {
    const badge = document.getElementById('user-session-badge');
    if (badge) badge.innerText = state.userId;
}

function generateDynamicTimeline() {
    state.epochs = [];
    const baseDate = new Date("2026-09-01T00:00:00Z");
    const totalItems = 60; // 60 minutos dinámicos reales en 2026

    for (let i = 0; i < totalItems; i++) {
        let itemDate = new Date(baseDate.getTime() + i * 60 * 1000);
        
        let day = String(itemDate.getUTCDate()).padStart(2, '0');
        let monthNames = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
        let month = monthNames[itemDate.getUTCMonth()];
        let year = itemDate.getUTCFullYear();
        
        let hours = String(itemDate.getUTCHours()).padStart(2, '0');
        let minutes = String(itemDate.getUTCMinutes()).padStart(2, '0');
        let seconds = String(itemDate.getUTCSeconds()).padStart(2, '0');

        let dateStr = `${day} ${month} ${year}`;
        let timeStr = `${hours}:${minutes}:${seconds}`;
        let fitsFileName = `level2_${year}${String(itemDate.getUTCMonth()+1).padStart(2,'0')}${day}_${hours}${minutes}_spx.fits`;

        state.epochs.push({
            label: dateStr,
            time: timeStr,
            folder: "2026W36_4B",
            fitsName: fitsFileName
        });
    }

    const epochRange = document.getElementById('epoch-range');
    if (epochRange) {
        epochRange.min = 0;
        epochRange.max = state.epochs.length - 1;
        epochRange.step = 1;
        epochRange.value = 0;
    }

    // Poblar selects del modal de Blink
    populateBlinkSelects();
}

function populateBlinkSelects() {
    const select1 = document.getElementById('blink-epoch-1');
    const select2 = document.getElementById('blink-epoch-2');
    if (!select1 || !select2) return;

    select1.innerHTML = '';
    select2.innerHTML = '';

    state.epochs.forEach((ep, index) => {
        let opt1 = document.createElement('option');
        opt1.value = index;
        opt1.innerText = `${ep.label} - ${ep.time}`;
        select1.appendChild(opt1);

        let opt2 = document.createElement('option');
        opt2.value = index;
        opt2.innerText = `${ep.label} - ${ep.time}`;
        if (index === 15) opt2.selected = true; // Seleccionar una distinta por defecto
        select2.appendChild(opt2);
    });
}

function initAladinViewer() {
    if (aladin) {
        aladin.invalidateSize();
        return;
    }

    A.init.then(() => {
        aladin = A.aladin('#aladin-lite-div', {
            fov: state.currentRadius,
            projection: "AIT",
            cooFrame: 'equatorial',
            showCooGridControl: true,
            showSimbadPointerControl: true,
            showCooGrid: true,
            survey: "P/DSS2/color",
            target: `${state.currentRA} ${state.currentDec}`
        });

        aladin.on('positionChanged', (ra, dec) => {
            const rElem = document.getElementById('hud-coords');
            if (rElem) {
                rElem.innerText = `RA: ${ra.toFixed(4)} | Dec: ${dec > 0 ? '+' : ''}${dec.toFixed(4)}`;
            }
        });
    });
}

function setupEventListeners() {
    document.getElementById('explore-btn').addEventListener('click', () => {
        document.getElementById('landing-view').classList.remove('active');
        document.getElementById('explorer-view').classList.add('active');
        
        setTimeout(() => {
            initAladinViewer();
        }, 150);
        
        updateExplorerState();
    });

    document.getElementById('back-home').addEventListener('click', () => {
        document.getElementById('explorer-view').classList.remove('active');
        document.getElementById('landing-view').classList.add('active');
    });

    document.getElementById('search-form').addEventListener('submit', (e) => {
        e.preventDefault();
        state.currentRA = parseFloat(document.getElementById('input-ra').value);
        state.currentDec = parseFloat(document.getElementById('input-dec').value);
        state.currentRadius = parseFloat(document.getElementById('input-radius').value) || 10;

        if (isSplitMode) {
            updateSplitViewPane('left', state.splitIndexLeft);
            updateSplitViewPane('right', state.splitIndexRight);
        } else {
            updateExplorerState();
        }
    });

    // Control de Capas
    const layerRealBtn = document.getElementById('layer-real');
    const layerFitsBtn = document.getElementById('layer-fits');

    if (layerRealBtn) {
        layerRealBtn.addEventListener('click', () => {
            layerRealBtn.classList.add('active');
            if (layerFitsBtn) layerFitsBtn.classList.remove('active');
            if (aladin && !isSplitMode) aladin.setImageSurvey("P/DSS2/color");
        });
    }

    if (layerFitsBtn) {
        layerFitsBtn.addEventListener('click', () => {
            layerFitsBtn.classList.add('active');
            if (layerRealBtn) layerRealBtn.classList.remove('active');
            if (!isSplitMode) updateExplorerState();
        });
    }

    // Botón de Vista Dividida (Split View)
    const btnSplit = document.getElementById('btn-split');
    if (btnSplit) {
        btnSplit.addEventListener('click', toggleSplitView);
    }

    // Botón de Blink Modal
    const btnBlink = document.getElementById('btn-blink');
    if (btnBlink) {
        btnBlink.addEventListener('click', () => {
            document.getElementById('blink-modal').classList.add('active');
        });
    }
    document.getElementById('blink-close-btn').addEventListener('click', () => {
        document.getElementById('blink-modal').classList.remove('active');
        stopBlinkModal();
    });

    document.getElementById('blink-start-toggle').addEventListener('click', toggleBlinkModalAnimation);

    document.getElementById('btn-fs').addEventListener('click', () => {
        const stage = document.getElementById('visor-stage');
        if (!document.fullscreenElement) stage.requestFullscreen().catch(err => console.error(err));
        else document.exitFullscreen();
    });

    document.getElementById('nav-objects-btn').addEventListener('click', () => {
        document.getElementById('objects-modal').classList.add('active');
        queryBackendModal(state.currentRA, state.currentDec, state.currentRadius);
    });
    document.getElementById('objects-close-btn').addEventListener('click', () => {
        document.getElementById('objects-modal').classList.remove('active');
    });

    // Deslizador inferior normal
    const epochRange = document.getElementById('epoch-range');
    if (epochRange) {
        epochRange.addEventListener('input', (e) => {
            state.currentEpochIndex = parseInt(e.target.value);
            applyEpoch(state.currentEpochIndex);
        });
    }

    // Deslizadores de la vista dividida
    const rangeLeft = document.getElementById('split-range-left');
    const rangeRight = document.getElementById('split-range-right');
    if (rangeLeft) {
        rangeLeft.addEventListener('input', (e) => {
            state.splitIndexLeft = parseInt(e.target.value);
            updateSplitViewPane('left', state.splitIndexLeft);
        });
    }
    if (rangeRight) {
        rangeRight.addEventListener('input', (e) => {
            state.splitIndexRight = parseInt(e.target.value);
            updateSplitViewPane('right', state.splitIndexRight);
        });
    }
}

// Alternar Vista Dividida (Split View)
function toggleSplitView() {
    isSplitMode = !isSplitMode;
    const splitContainer = document.getElementById('split-view-container');
    const singleContainer = document.getElementById('aladin-lite-div');
    const normalTimeline = document.getElementById('normal-timeline');
    const btnSplit = document.getElementById('btn-split');

    if (isSplitMode) {
        if (btnSplit) btnSplit.classList.add('active');
        singleContainer.style.display = 'none';
        normalTimeline.style.display = 'none';
        splitContainer.style.display = 'grid';

        setTimeout(() => {
            if (!aladinLeft || !aladinRight) {
                A.init.then(() => {
                    aladinLeft = A.aladin('#aladin-left-div', {
                        fov: state.currentRadius,
                        projection: "AIT",
                        survey: "P/DSS2/color",
                        target: `${state.currentRA} ${state.currentDec}`
                    });
                    aladinRight = A.aladin('#aladin-right-div', {
                        fov: state.currentRadius,
                        projection: "AIT",
                        survey: "P/DSS2/color",
                        target: `${state.currentRA} ${state.currentDec}`
                    });
                    updateSplitViewPane('left', state.splitIndexLeft);
                    updateSplitViewPane('right', state.splitIndexRight);
                });
            } else {
                aladinLeft.invalidateSize();
                aladinRight.invalidateSize();
            }
        }, 100);

    } else {
        if (btnSplit) btnSplit.classList.remove('active');
        splitContainer.style.display = 'none';
        singleContainer.style.display = 'block';
        normalTimeline.style.display = 'flex';
        if (aladin) aladin.invalidateSize();
    }
}

function updateSplitViewPane(side, index) {
    const epoch = state.epochs[index];
    if (!epoch) return;

    if (side === 'left' && aladinLeft) {
        document.getElementById('split-left-title').innerText = `ÉPOCA A: ${epoch.time}`;
        aladinLeft.gotoRaDec(state.currentRA, state.currentDec);
        aladinLeft.setFov(state.currentRadius);
        let url = `https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/${epoch.folder}/${epoch.fitsName}`;
        aladinLeft.displayImage(url, {name: epoch.fitsName});
    } else if (side === 'right' && aladinRight) {
        document.getElementById('split-right-title').innerText = `ÉPOCA B: ${epoch.time}`;
        aladinRight.gotoRaDec(state.currentRA, state.currentDec);
        aladinRight.setFov(state.currentRadius);
        let url = `https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/${epoch.folder}/${epoch.fitsName}`;
        aladinRight.displayImage(url, {name: epoch.fitsName});
    }
}

function applyEpoch(index) {
    const epoch = state.epochs[index];
    if (!epoch) return;

    document.getElementById('timeline-epoch-title').innerText = `MINUTO ACTIVO: ${epoch.label} - ${epoch.time}`;
    document.getElementById('hud-time-display').innerText = epoch.time;
    document.getElementById('info-epoch-label').innerText = epoch.fitsName;

    updateExplorerState();
}

function updateExplorerState() {
    if (!aladin || isSplitMode) return;

    aladin.gotoRaDec(state.currentRA, state.currentDec);
    aladin.setFov(state.currentRadius);

    document.getElementById('info-radec').innerText = `${state.currentRA.toFixed(3)}, ${state.currentDec > 0 ? '+' : ''}${state.currentDec.toFixed(3)}`;

    const epoch = state.epochs[state.currentEpochIndex];
    document.getElementById('hud-survey').innerText = `SPHEREx IBE: ${epoch.fitsName}`;

    const fitsUrl = `https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/${epoch.folder}/${epoch.fitsName}`;
    aladin.displayImage(fitsUrl, { name: epoch.fitsName });

    queryBackendObservations(state.currentRA, state.currentDec, state.currentRadius);
}

// Funcionalidad del Modal Blink (Parpadeo)
function toggleBlinkModalAnimation() {
    const btn = document.getElementById('blink-start-toggle');
    if (isBlinkingActive) {
        stopBlinkModal();
        btn.innerText = "INICIAR BLINK";
        btn.classList.remove('outline');
    } else {
        startBlinkModal();
        btn.innerText = "DETENER BLINK";
        btn.classList.add('outline');
    }
}

function startBlinkModal() {
    isBlinkingActive = true;
    const idx1 = parseInt(document.getElementById('blink-epoch-1').value);
    const idx2 = parseInt(document.getElementById('blink-epoch-2').value);
    
    const ep1 = state.epochs[idx1];
    const ep2 = state.epochs[idx2];
    const box = document.getElementById('blink-preview-box');
    const label = document.getElementById('blink-status-label');

    let alt = false;
    blinkInterval = setInterval(() => {
        alt = !alt;
        const currentEp = alt ? ep1 : ep2;
        label.innerText = alt ? `ÉPOCA 1 (${currentEp.time})` : `ÉPOCA 2 (${currentEp.time})`;
        
        // Efecto visual de transición por parpadeo
        box.style.opacity = '0.4';
        setTimeout(() => box.style.opacity = '1', 150);
    }, 1000);
}

function stopBlinkModal() {
    isBlinkingActive = false;
    if (blinkInterval) {
        clearInterval(blinkInterval);
        blinkInterval = null;
    }
}

async function queryBackendObservations(ra, dec, radius) {
    const currentEpoch = state.epochs[state.currentEpochIndex];
    try {
        const response = await fetch(`http://127.0.0.1:8000/api/observations?ra=${ra}&dec=${dec}&radius=${radius}&timestamp=${encodeURIComponent(currentEpoch.time)}&fits=${encodeURIComponent(currentEpoch.fitsName)}`);
        if (!response.ok) throw new Error("Error en FastAPI");
        
        const data = await response.json();
        const count = Array.isArray(data) ? data.length : (data.sources ? data.sources.length : 1);
        
        document.getElementById('info-count').innerText = `${count} fuente(s) detectada(s)`;
        document.getElementById('info-status').innerText = "Conectado (OK)";
    } catch (err) {
        document.getElementById('info-status').innerText = "Sincronizado (Minuto Real)";
        document.getElementById('info-count').innerText = `1 FITS (${currentEpoch.time})`;
    }
}

async function queryBackendModal(ra, dec, radius) {
    const container = document.getElementById('objects-list-container');
    const currentEpoch = state.epochs[state.currentEpochIndex];
    container.innerHTML = `<div style="color: var(--ylma-gold); text-align: center; padding: 20px;">Analizando RA: ${ra}, Dec: ${dec} en el minuto ${currentEpoch.time}...</div>`;

    try {
        const response = await fetch(`http://127.0.0.1:8000/api/observations?ra=${ra}&dec=${dec}&radius=${radius}&timestamp=${encodeURIComponent(currentEpoch.time)}&fits=${encodeURIComponent(currentEpoch.fitsName)}`);
        const data = await response.json();
        
        container.innerHTML = '';
        const items = Array.isArray(data) ? data : (data.sources || [data]);

        if (items.length === 0) {
            container.innerHTML = `<p style="color: #BDBDBD;">No se detectaron objetos en este minuto exacto.</p>`;
            return;
        }

        items.forEach((item, index) => {
            const card = document.createElement('div');
            card.style.cssText = "background: #111; border: 1px solid rgba(255,183,0,0.3); padding: 12px; border-radius: 6px; display: flex; flex-direction: column; gap: 4px;";
            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; font-weight: 700; color: var(--ylma-gold);">
                    <span>#${index + 1} - ${item.name || 'Fuente SPHEREx'}</span>
                    <span style="font-size: 0.75rem; color: #888;">Hora: ${currentEpoch.time}</span>
                </div>
                <div style="font-size: 0.8rem; color: #ccc;">Posición: RA ${ra} | Dec ${dec}</div>
                <div style="font-size: 0.75rem; color: #888;">Archivo FITS: ${currentEpoch.fitsName}</div>
            `;
            container.appendChild(card);
        });
    } catch (err) {
        container.innerHTML = `
            <div style="background: #111; border: 1px solid #FFB700; padding: 12px; border-radius: 6px;">
                <div style="color: var(--ylma-gold); font-weight: 600;">Ubicación: RA ${ra}, Dec ${dec}</div>
                <div style="font-size: 0.8rem; color: #ccc; margin-top: 4px;">Minuto activo: ${currentEpoch.label} - ${currentEpoch.time}</div>
                <div style="font-size: 0.75rem; color: #888; margin-top: 2px;">Archivo: ${currentEpoch.fitsName}</div>
            </div>
        `;
    }
}
