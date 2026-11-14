document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('archive-search-form');
  const results = document.getElementById('archive-results');
  const status = document.getElementById('archive-status');
  if (!form || !results || !status) return;

  const API_BASE = window.SPHEREX_API_BASE || 'http://127.0.0.1:8000';
  const esc = (value) => String(value ?? '—');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const ra = Number(document.getElementById('input-ra').value);
    const dec = Number(document.getElementById('input-dec').value);
    const fov = Number(document.getElementById('input-radius').value);
    const collection = document.getElementById('archive-collection').value;
    if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(fov) || fov <= 0) {
      status.textContent = 'Comprueba RA, Dec y campo de visión.';
      return;
    }

    status.textContent = 'Buscando imágenes SPHEREx en IRSA…';
    results.replaceChildren();
    const params = new URLSearchParams({ ra, dec, radius: String(fov / 2), collection, limit: '100' });
    try {
      const response = await fetch(`${API_BASE}/api/spherex/search?${params}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `Error HTTP ${response.status}`);
      status.textContent = `${payload.count} archivo(s) encontrados en ${payload.collection}.`;
      if (!payload.results?.length) {
        results.textContent = 'No se encontraron archivos para estas coordenadas y colección.';
        return;
      }

      const fragment = document.createDocumentFragment();
      payload.results.forEach((item, index) => {
        const card = document.createElement('article');
        card.className = 'archive-result-card';
        const title = document.createElement('h3');
        title.textContent = esc(item.obs_title || item.obs_id || `Imagen ${index + 1}`);
        const details = document.createElement('p');
        details.textContent = `Centro: ${esc(item.s_ra)}, ${esc(item.s_dec)} · Banda: ${esc(item.bandpass_id)} · ID: ${esc(item.obs_id)}`;
        const actions = document.createElement('div');
        actions.className = 'archive-result-actions';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'ylma-btn primary-gold';
        open.textContent = 'ABRIR EN ALADIN';
        open.addEventListener('click', () => {
          const url = item.access_url;
          if (!url || !/^https:\/\//i.test(url)) {
            status.textContent = 'IRSA devolvió una URL de acceso no válida.';
            return;
          }
          const input = document.getElementById('fits-url-input');
          if (input) input.value = url;
          if (typeof window.loadMainFits === 'function') window.loadMainFits(url);
          else status.textContent = 'No se encontró el cargador FITS de Aladin Lite.';
        });
        const external = document.createElement('a');
        external.className = 'ylma-link';
        external.href = item.access_url;
        external.target = '_blank';
        external.rel = 'noopener noreferrer';
        external.textContent = 'URL del archivo';
        actions.append(open, external);
        card.append(title, details, actions);
        fragment.append(card);
      });
      results.append(fragment);
    } catch (error) {
      status.textContent = `No se pudo consultar IRSA: ${error.message}`;
    }
  });
});
