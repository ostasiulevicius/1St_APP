// Compatibilidad con código viejo que llama makeSearchableSelect / refreshSearchableSelect
function makeSearchableSelect(selectId) {
  const sel = typeof selectId === 'string' ? document.getElementById(selectId) : selectId;
  if (sel) SmartCombo.init(sel);
}
function refreshSearchableSelect(selectId) {
  const sel = typeof selectId === 'string' ? document.getElementById(selectId) : selectId;
  SmartCombo.refresh(sel);
}
function initAllSearchableSelects() { /* reemplazado por SmartCombo.initAll() */ }

// ══════════════════════════════════════════════════════════════
// DROPZONE CLASS — componente estándar reutilizable
// Uso: new DropZone({ mountId, id, label, icon, task, onExtract })
// ══════════════════════════════════════════════════════════════
class DropZone {
  // Registro de tareas: cada task define endpoints, campo del form y datos esperados
  static TASKS = {
    tablero: {
      accept:      'image/*',
      aiEndpoint:  '/api/ai/extract-km',
      aiField:     'imagen',
      ocrEndpoint: null,   // Tesseract no sirve en dashboards — usar IA
    },
    multa: {
      accept:      'image/*,application/pdf',
      aiEndpoint:  '/api/ai/extract-multa',
      aiField:     'multa',
      ocrEndpoint: null,
    },
    vtv: {
      accept:      'image/*,application/pdf',
      aiEndpoint:  '/api/ai/extract-vtv',
      aiField:     'vtv',
      ocrEndpoint: null,
    },
    gnc: {
      accept:      'image/*,application/pdf',
      aiEndpoint:  '/api/ai/extract-gnc',
      aiField:     'oblea',
      ocrEndpoint: null,
    },
    factura: {
      accept:      'image/*,application/pdf',
      aiEndpoint:  '/api/ai/extract-factura',
      aiField:     'factura',
      ocrEndpoint: null,
    },
    foto: {
      accept:      'image/*,application/pdf',
      aiEndpoint:  null,
      ocrEndpoint: null,
    },
    aceite: {
      accept:      'image/*',
      aiEndpoint:  '/api/ai/extract-aceite',
      aiField:     'imagen',
      ocrEndpoint: null,
    },
  };

  constructor(opts = {}) {
    const { mountId, id, label = 'Adjuntá un archivo', icon = 'fa-file',
            task = 'foto', onExtract, onFileSet, onUpload, camera = true,
            uploadEndpoint = '/api/upload/turno-foto' } = opts;
    this.id             = id;
    this.taskKey        = task;
    this.taskCfg        = DropZone.TASKS[task] || DropZone.TASKS.foto;
    this.uploadEndpoint = uploadEndpoint;
    this.onExtract = onExtract || null;
    this.onFileSet = onFileSet || null;
    this.onUpload  = onUpload  || null;
    this._file     = null;
    this._existingUrl = null;

    const mount = document.getElementById(mountId);
    if (!mount) { console.warn(`DropZone: mountId "${mountId}" no encontrado`); return; }

    // Generar HTML estándar
    mount.innerHTML = `
      <div class="cedula-dropzone dz-img-top" id="${id}-dropzone" tabindex="0" style="margin-bottom:6px;outline:none;">
        <img id="${id}-preview" class="dz-top-img" style="display:none;">
        <i class="fa-solid ${icon} dz-bottom-icon"></i>
        <small class="dz-bottom-label">${label}</small>
        <button type="button" class="dz-overlay-del"><i class="fa-solid fa-xmark"></i></button>
        ${camera ? `<button type="button" class="dz-overlay-cam"><i class="fa-solid fa-camera"></i></button>` : ''}
        <button type="button" class="dz-overlay-eye" style="display:none;"><i class="fa-solid fa-eye"></i></button>
      </div>
      <input type="file" id="${id}-file" accept="${this.taskCfg.accept || 'image/*'}" style="display:none;">`;

    // Refs DOM
    this._dz  = document.getElementById(`${id}-dropzone`);
    this._img = document.getElementById(`${id}-preview`);
    this._inp = document.getElementById(`${id}-file`);
    this._eye = this._dz.querySelector('.dz-overlay-eye');
    this._del = this._dz.querySelector('.dz-overlay-del');
    this._cam = this._dz.querySelector('.dz-overlay-cam');

    // Eventos dropzone
    this._dz.addEventListener('click', () => {
      if (document.getElementById('float-img-viewer')?.style.display === 'flex') return;
      this._inp.click();
    });
    this._dz.addEventListener('dragover',  e => { e.preventDefault(); this._dz.classList.add('drag-over'); });
    this._dz.addEventListener('dragleave', () => this._dz.classList.remove('drag-over'));
    this._dz.addEventListener('drop',      e => { e.preventDefault(); this._dz.classList.remove('drag-over'); const f = e.dataTransfer?.files?.[0]; if (f) this.setFile(f); });
    this._inp.addEventListener('change',   e => { const f = e.target?.files?.[0]; if (f) this.setFile(f); });
    this._del?.addEventListener('click',   e => { e.stopPropagation(); this.clear(); });
    this._cam?.addEventListener('click',   e => { e.stopPropagation(); openCamera(id + '-file'); });
    this._eye?.addEventListener('click',   e => { e.stopPropagation(); this._openViewer(); });
    // Pegar desde portapapeles (Ctrl+V) — hacé clic en el dropzone para enfocarlo y pegá
    this._dz.addEventListener('focus', () => this._dz.style.boxShadow = '0 0 0 2px var(--accent-color)');
    this._dz.addEventListener('blur',  () => this._dz.style.boxShadow = '');
    this._dz.addEventListener('paste', e => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) { e.preventDefault(); this.setFile(file); }
          break;
        }
      }
    });

    // Toolbar OCR + IA
    this._injectToolbar();
  }

  _injectToolbar() {
    const bar = document.createElement('div');
    bar.className = 'dz-toolbar';
    const hasAI  = !!this.taskCfg.aiEndpoint;
    const hasOCR = !!this.taskCfg.ocrEndpoint;
    if (hasOCR) bar.innerHTML += `<button type="button" class="dz-btn dz-ocr" id="${this.id}-btn-ocr"><i class="fa-solid fa-font"></i> OCR</button>`;
    if (hasAI)  bar.innerHTML += `<button type="button" class="dz-btn dz-ai"  id="${this.id}-btn-ai" ${_aiAvailable?'':'disabled title="Requiere API Key"'}><i class="fa-solid fa-wand-magic-sparkles"></i> IA</button>`;
    // Slot estándar para el pin de acople/desacople del visor flotante (oculto hasta que se abra el visor)
    bar.innerHTML += `<button type="button" class="dz-btn dz-pin" id="${this.id}-btn-pin" style="display:none;padding:0;width:28px;justify-content:center;"></button>`;
    bar.innerHTML += `<span class="dz-status" id="${this.id}-dz-status"></span>`;
    this._dz.insertAdjacentElement('afterend', bar);
    this._stEl = document.getElementById(`${this.id}-dz-status`);
    document.getElementById(`${this.id}-btn-ocr`)?.addEventListener('click', () => this.runOCR());
    document.getElementById(`${this.id}-btn-ai` )?.addEventListener('click', () => this.runAI());
  }

  _setStatus(msg, type = 'info') {
    if (!this._stEl) return;
    this._stEl.textContent = msg;
    this._stEl.style.color = type === 'ok'    ? 'var(--color-success)'
                           : type === 'error' ? 'var(--color-error)'
                           : type === 'warn'  ? 'orange'
                           : 'var(--accent-color)';
  }

  _openViewer() {
    // OJO: no usar this._img.src como fallback genérico — un <img> con src="" (tras clear())
    // devuelve la URL de la página actual al leerlo, no "" (rareza del DOM). Por eso acá se
    // decide explícitamente la fuente según sea PDF o imagen, sin apoyarse en ese valor.
    const isPdf = (this._file && this._file.type === 'application/pdf') ||
                  (this._existingUrl && this._existingUrl.split('?')[0].toLowerCase().endsWith('.pdf'));
    if (isPdf) {
      const src = this._existingUrl || (this._file ? URL.createObjectURL(this._file) : null);
      if (!src) return;
      _openViewerDzRef = this;
      openDocViewer(src, this.id, true);
    } else {
      const src = (this._img && this._img.style.display !== 'none' && this._img.src) || this._existingUrl;
      if (!src) return;
      _openViewerDzRef = this;
      openImgViewer(src, this.id, this.id);
    }
  }

  _showPreview(file) {
    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      this._img.src = url; this._img.style.display = 'block';
      this._dz.classList.add('has-img');
      this._eye.style.display = '';
    } else {
      this._showPdfThumb();
    }
  }

  _showPdfThumb() {
    this._img.style.display = 'none';
    this._dz.classList.add('has-img');
    if (!this._dz.querySelector('.dz-pdf-thumb')) {
      const pt = document.createElement('div');
      pt.className = 'dz-pdf-thumb';
      pt.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;pointer-events:none;';
      pt.innerHTML = '<i class="fa-solid fa-file-pdf" style="font-size:40px;color:#e53e3e;"></i>';
      this._dz.appendChild(pt);
    }
    this._eye.style.display = '';
  }

  // API pública ─────────────────────────────────────────────

  setFile(file) {
    this._file = file;
    this._showPreview(file);
    this._setStatus('⏫ Guardando imagen...', 'info');
    this.onFileSet?.(file);
    // Auto-upload inmediato al servidor — STANDARD DropZone
    const fd = new FormData();
    fd.append('file', file, file.name);
    fetch(this.uploadEndpoint, { method: 'POST', body: fd })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => {
        if (d?.url) {
          this._existingUrl = d.url;
          const hasOCR = !!this.taskCfg.ocrEndpoint;
          const hasAI  = !!this.taskCfg.aiEndpoint;
          this._setStatus(`📎 Foto cargada`, 'info');
          this.onUpload?.(d.url);
        }
      })
      .catch(() => {
        this._setStatus(`⚠ No se pudo guardar la imagen`, 'warn');
      });
  }

  loadUrl(url) {
    if (!url) return;
    this._existingUrl = url;
    this._dz.querySelector('.dz-pdf-thumb')?.remove();
    if (url.split('?')[0].toLowerCase().endsWith('.pdf')) {
      this._showPdfThumb();
    } else {
      this._img.src = url; this._img.style.display = 'block';
      this._dz.classList.add('has-img');
      this._eye.style.display = '';
    }
    this._setStatus('📁 Foto guardada', 'ok');
  }

  clear() {
    this._file = null; this._existingUrl = null;
    this._img.src = ''; this._img.style.display = 'none';
    this._dz.classList.remove('has-img');
    this._dz.querySelector('.dz-pdf-thumb')?.remove();
    this._eye.style.display = 'none';
    this._inp.value = '';
    this._setStatus('', 'info');
  }

  setReadonly(on) {
    this._readonly = on;
    // Bloquear click en el dropzone (abre selector de archivo)
    this._dz.style.pointerEvents = on ? 'none' : '';
    this._dz.style.cursor        = on ? 'default' : '';
    // Ocultar botón eliminar y cámara; mantener visible el ojo
    if (this._del) this._del.style.display = on ? 'none' : '';
    if (this._cam) this._cam.style.display = on ? 'none' : '';
    // Ocultar botones IA / OCR de la toolbar
    const aiBtn  = document.getElementById(`${this.id}-btn-ai`);
    const ocrBtn = document.getElementById(`${this.id}-btn-ocr`);
    if (aiBtn)  aiBtn.style.display  = on ? 'none' : '';
    if (ocrBtn) ocrBtn.style.display = on ? 'none' : '';
    // Re-habilitar el ojo para ver la imagen
    if (this._eye && this._existingUrl) this._eye.style.pointerEvents = 'auto';
  }

  getFile()        { return this._file; }
  getExistingUrl() { return this._existingUrl; }

  async runAI() {
    if (!this._file && !this._existingUrl) { this._setStatus('⚠ Cargá un archivo primero', 'warn'); return; }
    if (!this.taskCfg.aiEndpoint) return;
    const btn = document.getElementById(`${this.id}-btn-ai`);
    if (btn) btn.disabled = true;
    this._setStatus('⏳ IA procesando...', 'info');
    try {
      const fd = new FormData();
      if (this._file) {
        fd.append(this.taskCfg.aiField, this._file);
      } else if (this._existingUrl) {
        // Foto ya guardada de una carga anterior (no se volvió a elegir archivo): la recuperamos del servidor.
        const blob = await fetch(this._existingUrl).then(r => r.blob());
        fd.append(this.taskCfg.aiField, blob, 'foto.jpg');
      }
      const res = await fetch(this.taskCfg.aiEndpoint, { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.json()).message);
      const data = await res.json();
      // Si el endpoint devuelve foto_url, actualizar el hidden existente
      if (data.foto_url) this._existingUrl = data.foto_url;
      this._setStatus('✓ IA completó', 'ok');
      this.onExtract?.(data);
    } catch(err) {
      this._setStatus('✗ ' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async runOCR() {
    if (!this._file) { this._setStatus('⚠ Cargá un archivo primero', 'warn'); return; }
    if (!this.taskCfg.ocrEndpoint) return;
    const btn = document.getElementById(`${this.id}-btn-ocr`);
    if (btn) btn.disabled = true;
    this._setStatus('⏳ OCR leyendo...', 'info');
    try {
      const fd = new FormData();
      fd.append(this.taskCfg.ocrField || 'imagen', this._file);
      const res = await fetch(this.taskCfg.ocrEndpoint, { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.json()).message);
      const data = await res.json();
      this._setStatus('✓ OCR completó', 'ok');
      this.onExtract?.(data);
    } catch(err) {
      this._setStatus('✗ ' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }
}

// ══════════════════════════════════════════════════════════════
// ALERT / CONFIRM PERSONALIZADOS — reemplazan showAlert() y confirm()
// ══════════════════════════════════════════════════════════════
let _alertResolve = null;

/**
 * Reemplaza showAlert() — muestra modal centrado con el nombre de la app.
 * type: 'info' | 'success' | 'error' | 'warning'
 */
function showAlert(msg, type = 'info', extraButtons = '') {
  return new Promise(resolve => {
    _alertResolve = resolve;
    _alertIsConfirm = false;
    const icons = {
      info:    '<i class="fa-solid fa-circle-info"    style="color:var(--accent-color);"></i>',
      success: '<i class="fa-solid fa-circle-check"  style="color:var(--color-success);"></i>',
      error:   '<i class="fa-solid fa-circle-xmark"  style="color:var(--color-error);"></i>',
      warning: '<i class="fa-solid fa-triangle-exclamation" style="color:orange;"></i>',
    };
    document.getElementById('app-alert-icon').innerHTML = icons[type] || icons.info;
    document.getElementById('app-alert-msg').textContent = msg;
    document.getElementById('app-alert-btns').innerHTML = `
      ${extraButtons}
      <button class="btn btn-primary" style="min-width:90px;" onclick="_closeAppAlert(true)">
        Aceptar <kbd class="_alert-kbd">Enter</kbd>
      </button>`;
    _setAvisoType(type);
    document.getElementById('modal-app-alert').classList.add('active');
  });
}

let _alertIsConfirm = false;

/**
 * Reemplaza confirm() — devuelve Promise<bool>.
 */
function showConfirm(msg, okLabel = 'Confirmar', cancelLabel = 'Cancelar') {
  return new Promise(resolve => {
    _alertResolve = resolve;
    _alertIsConfirm = true;
    document.getElementById('app-alert-icon').innerHTML =
      '<i class="fa-solid fa-circle-question" style="color:orange;font-size:2.2rem;"></i>';
    document.getElementById('app-alert-msg').textContent = msg;
    document.getElementById('app-alert-btns').innerHTML = `
      <button class="btn btn-secondary" style="min-width:80px;" onclick="_closeAppAlert(false)">
        ${cancelLabel} <kbd class="_alert-kbd">Esc</kbd>
      </button>
      <button class="btn btn-primary" style="min-width:80px;" onclick="_closeAppAlert(true)">
        ${okLabel} <kbd class="_alert-kbd">Enter</kbd>
      </button>`;
    _setAvisoType('warning');
    document.getElementById('modal-app-alert').classList.add('active');
  });
}

function _setAvisoType(type) {
  const card = document.querySelector('#modal-app-alert .modal-card');
  if (!card) return;
  card.classList.add('modal-aviso');
  card.classList.remove('aviso-info','aviso-warn','aviso-error','aviso-success');
  const map = { info:'aviso-info', warning:'aviso-warn', error:'aviso-error', success:'aviso-success' };
  card.classList.add(map[type] || 'aviso-info');
}

function _closeAppAlert(result) {
  document.getElementById('modal-app-alert').classList.remove('active');
  _alertIsConfirm = false;
  if (_alertResolve) { _alertResolve(result); _alertResolve = null; }
}

// Atajos de teclado para alert/confirm
document.addEventListener('keydown', e => {
  if (!_alertResolve) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    _closeAppAlert(true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    _closeAppAlert(_alertIsConfirm ? false : true);
  }
});

// Listas en memoria para caching y búsquedas rápidas (Edición)
let cachedChoferes = [];
let _choferesSelectLoadPromise = null;
let cachedVehiculos = [];
let cachedProveedores = [];
let cachedMarcas = [];
let cachedAseguradoras = [];
let activeVehiculoId = null;

// ══════════════════════════════════════════════════════════════
// SISTEMA UNIVERSAL DE TOOLBARS PARA DRAG & DROP
// ══════════════════════════════════════════════════════════════
let _aiAvailable = false; // se setea en initApp() consultando /api/ai/status

/**
 * Crea e inyecta una barra de acciones debajo de un dropzone.
 * @param {string} dzId      - id del div dropzone
 * @param {string} inputId   - id del <input type="file"> asociado
 * @param {object} opts
 *   opts.statusId  - id del span de estado (si ya existe en HTML)
 *   opts.camera    - bool (default true)
 *   opts.ai        - nombre de función JS para IA, o null
 *   opts.aiLabel   - texto del botón IA (default 'IA')
 *   opts.ocr       - nombre de función JS para OCR, o null
 *   opts.ocrLabel  - texto del botón OCR (default 'OCR')
 */
function injectDzToolbar(dzId, inputId, opts = {}) {
  const dz = document.getElementById(dzId);
  if (!dz) return;
  // Si ya tiene toolbar, no duplicar
  if (dz.nextElementSibling && dz.nextElementSibling.classList.contains('dz-toolbar')) return;

  const cam    = opts.camera !== false;
  const aiFn   = opts.ai   || null;
  const ocrFn  = opts.ocr  || null;
  const aiLbl  = opts.aiLabel  || 'IA';
  const ocrLbl = opts.ocrLabel || 'OCR';
  const statusId = opts.statusId || `dz-status-${dzId}`;

  const bar = document.createElement('div');
  bar.className = 'dz-toolbar';
  bar.dataset.forDz = dzId;

  if (cam) {
    bar.innerHTML += `<button type="button" class="dz-btn dz-cam" onclick="openCamera('${inputId}')" title="Cámara">
      <i class="fa-solid fa-camera"></i></button>`;
  }
  if (ocrFn) {
    bar.innerHTML += `<button type="button" class="dz-btn dz-ocr" onclick="${ocrFn}()" id="dz-ocr-${dzId}">
      <i class="fa-solid fa-font"></i> ${ocrLbl}</button>`;
  }
  if (aiFn) {
    const dis = _aiAvailable ? '' : 'disabled title="Requiere ANTHROPIC_API_KEY configurado"';
    bar.innerHTML += `<button type="button" class="dz-btn dz-ai" onclick="${aiFn}()" id="dz-ai-${dzId}" ${dis}>
      <i class="fa-solid fa-wand-magic-sparkles"></i> ${aiLbl}</button>`;
  }
  // Span de estado compartido
  if (!document.getElementById(statusId)) {
    bar.innerHTML += `<span class="dz-status" id="${statusId}"></span>`;
  }

  dz.insertAdjacentElement('afterend', bar);
}

/**
 * Actualiza el texto/color del span de estado de una toolbar.
 */
function dzSetStatus(dzId, msg, type = 'info') {
  const statusId = `dz-status-${dzId}`;
  const el = document.getElementById(statusId);
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'ok'    ? 'var(--color-success)'
                 : type === 'error' ? 'var(--color-error)'
                 : type === 'warn'  ? 'orange'
                 : 'var(--accent-color)';
}

/**
 * Habilita/deshabilita el botón AI de todas las toolbars según disponibilidad.
 */
function _applyAiAvailability() {
  const tip = _aiAvailable ? '' : 'Requiere API Key de IA configurada en Credenciales';
  // Botones generados por injectDzToolbar
  document.querySelectorAll('.dz-btn.dz-ai').forEach(btn => {
    btn.disabled = !_aiAvailable;
    btn.title = tip;
  });
  // Botones manuales con convención de IDs (backward compat)
  document.querySelectorAll('[id^="btn-ai-"],[id$="-btn-ai"],[id="pg-btn-ai"],[id="chofer-btn-ai"],[id="btn-extract-cedula-ai"],[id="btn-extract-gnc-ai"],[id="btn-extract-seguro-ai"]').forEach(btn => {
    btn.disabled = !_aiAvailable;
    if (!_aiAvailable) btn.title = tip;
  });
}

/**
 * Llama /api/ai/status y actualiza _aiAvailable + botones.
 */
async function checkAiStatus() {
  try {
    const r = await fetch('/api/ai/status');
    const d = await r.json();
    _aiAvailable = !!d.available;
  } catch { _aiAvailable = false; }
  _applyAiAvailability();
}

/**
 * Punto de entrada: inyecta toolbars en TODOS los dropzones del sistema.
 * Llamar después de que el DOM esté listo y checkAiStatus() haya terminado.
 */
function initAllDzToolbars() {
  // ── Vehículo: cédula, fotos y Chofer docs → barras estáticas en HTML (no inyectar aquí)

  // ── VTV
  injectDzToolbar('vtv-dropzone', 'vtv-file-input', {
    ai: 'extractVtvAI', aiLabel: 'IA',
    ocr: 'extractVtvOCR', ocrLabel: 'OCR',
    statusId: 'vtv-ai-status'
  });

  // ── GNC
  injectDzToolbar('gnc-oblea-dropzone', 'gnc-file', {
    ai: 'extractGncAI', aiLabel: 'IA',
    ocr: 'extractGncOCR', ocrLabel: 'OCR',
    statusId: 'ai-gnc-status'
  });

  // ── Seguro
  injectDzToolbar('seg-poliza-dropzone', 'seg-file', {
    ai: 'extractSeguroAI', aiLabel: 'IA',
    ocr: 'extractSeguroOCR', ocrLabel: 'OCR',
    statusId: 'ai-seguro-status'
  });

  // ── Service: factura — migrado a clase DropZone, se instancia en _initSvcFacturaDropzone()

  // ── Service: fotos (solo cámara)
  injectDzToolbar('svc-foto-drop', 'svc-foto-input', {
    camera: true, ai: null, ocr: null
  });

  // ── Multa: dropzone OCR en tab Datos — inicializado como DropZone estándar en initMultaOcrDz()

  // ── Multa: adjuntos (cámara)
  injectDzToolbar('multa-adj-drop', 'multa-adj-input', {
    camera: true, ai: null, ocr: null
  });

  // ── Producto: foto + escaneo de barcode
  injectDzToolbar('prod-foto-drop', 'prod-foto-input', {
    camera: true,
    ocr: 'scanBarcode', ocrLabel: 'Leer Código de Barras',
    ai: null
  });

  // ── Pago / Cobro / Reintegro: comprobante
  injectDzToolbar('pg-comprobante-drop', 'pg-comprobante-input', {
    camera: true,
    ocr: 'extractPagoOCR', ocrLabel: 'OCR',
    ai: 'extractPagoAI',  aiLabel: 'IA',
    statusId: 'pg-ocr-status'
  });

  // ── Turno km: montados como DropZone class en _initTurnoKmDropzones()
}

// ══════════════════════════════════════════════════════════════
// EXPORTAR A XLS + ENVIAR POR WHATSAPP
// ══════════════════════════════════════════════════════════════

/**
 * Config de tablas exportables:
 * tableId: id del <table>, label: nombre legible, sectionId: sección donde se inyectan los botones
 */
const _EXPORT_TABLES = [
  { tableId: 'table-choferes',       label: 'Choferes',        sectionId: 'tab-choferes' },
  { tableId: 'table-vehiculos-gestion', label: 'Vehículos',    sectionId: 'tab-vehiculos' },
  { tableId: 'table-proveedores',    label: 'Proveedores',     sectionId: 'tab-proveedores' },
  { tableId: 'table-services',       label: 'Services',        sectionId: 'tab-services' },
  { tableId: 'table-multas',         label: 'Infracciones',    sectionId: 'tab-multas' },
  { tableId: 'table-municipalidades',label: 'Municipalidades', sectionId: 'tab-municipalidades' },
  { tableId: 'table-usuarios',       label: 'Usuarios',        sectionId: 'tab-usuarios' },
  { tableId: 'table-productos',      label: 'Productos',       sectionId: 'tab-stock' },
  { tableId: 'table-entregas',       label: 'Entregas Stock',  sectionId: 'tab-stock' },
  { tableId: 'table-rendiciones',    label: 'Rendiciones',     sectionId: 'tab-rendiciones' },
  { tableId: 'table-peajes',         label: 'Peajes',          sectionId: 'tab-peajes' },
  { tableId: 'table-arca',           label: 'ARCA',            sectionId: 'tab-arca' },
  { tableId: 'table-finanzas',       label: 'Finanzas',        sectionId: 'tab-finanzas' },
];

/**
 * Inyecta barra de Export/WhatsApp encima de cada tabla registrada en _EXPORT_TABLES.
 * Llamar después de que cada sección haya renderizado su tabla.
 */
function injectExportBar(tableId, label) {
  const table = document.getElementById(tableId);
  if (!table) return;

  // Buscar el filter-bar en la misma sección para inyectar los botones ahí
  const section = table.closest('section, .content-view, .modal-body') || table.parentElement;
  const filterBar = section?.querySelector('.filter-bar');
  const btnGroupId = `export-btns-${tableId}`;
  document.getElementById(btnGroupId)?.remove(); // limpiar anterior

  if (filterBar) {
    // Inyectar XLS + WA directamente en el filter-bar existente (sin fila extra)
    const grp = document.createElement('div');
    grp.id = btnGroupId;
    grp.style.cssText = 'display:flex;gap:6px;align-items:flex-end;margin-left:auto;';
    grp.innerHTML = `
      <button class="btn-export" onclick="exportTableToXLS('${tableId}','${label}')" title="Exportar a Excel">
        <i class="fa-solid fa-file-excel"></i> XLS
      </button>
      <button class="btn-export btn-wa" onclick="openWhatsAppModal('${tableId}','${label}')" title="Enviar por WhatsApp">
        <i class="fa-brands fa-whatsapp"></i> WhatsApp
      </button>`;
    // Si ya hay un badge con margin-left:auto, insertar antes de él
    const badge = filterBar.querySelector('[style*="margin-left:auto"]');
    if (badge) {
      grp.style.marginLeft = ''; // el badge ya tiene el auto
      filterBar.insertBefore(grp, badge);
    } else {
      filterBar.appendChild(grp);
    }
  }

  // Asegurar que la tabla esté dentro de un .table-container (para scroll vertical + botones)
  let tableWrap = table.closest('.table-container');
  if (!tableWrap) {
    const responsive = table.closest('.table-responsive') || table;
    const parent = responsive.parentElement;
    if (parent && !parent.classList.contains('table-container')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'table-container';
      parent.insertBefore(wrapper, responsive);
      wrapper.appendChild(responsive);
      tableWrap = wrapper;
    } else {
      tableWrap = parent;
    }
  }

  // Ya no insertamos barra separada — solo hacemos el wrap y scroll nav
  const insertBefore = tableWrap || (table.closest('.table-responsive') || table);
  void insertBefore; // referencia conservada para el scrollNav abajo

  if (tableWrap) {
    _attachScrollNav(tableWrap, tableWrap);
    tableWrap._scrollNavReposition?.();
  }
  // Notificar a TODOS los scroll-nav para que re-evalúen
  window.dispatchEvent(new Event('flota:tablerender'));
}

/**
 * Exporta la tabla visible a .xlsx y lo descarga.
 */
function exportTableToXLS(tableId, label) {
  const table = document.getElementById(tableId);
  if (!table) { showToast('No hay datos para exportar'); return; }
  if (!window.XLSX) { showToast('Librería XLS no cargada'); return; }
  try {
    const wb = XLSX.utils.book_new();
    // raw:true → evita que XLSX parsee "50.000,00" como 50 (lo deja como string para convertir abajo)
    const ws = XLSX.utils.table_to_sheet(table, { raw: true });
    // Convertir strings en formato es-AR a números reales
    Object.keys(ws).forEach(key => {
      if (key[0] === '!') return;
      const cell = ws[key];
      if (cell.t !== 's' || typeof cell.v !== 'string') return;
      const s = cell.v.trim().replace(/^\$\s*/, '').trim();
      // "50.000,00" o "1.234.567,89" → número
      if (/^-?[\d.]+,\d{1,2}$/.test(s)) {
        const num = parseFloat(s.replace(/\./g, '').replace(',', '.'));
        if (!isNaN(num)) { cell.t = 'n'; cell.v = num; delete cell.w; }
      }
    });
    XLSX.utils.book_append_sheet(wb, ws, label.substring(0, 31));
    const _now = new Date();
    const _pad = n => String(n).padStart(2,'0');
    const _fechaLocal = `${_now.getFullYear()}-${_pad(_now.getMonth()+1)}-${_pad(_now.getDate())}`;
    const _horaLocal  = `${_pad(_now.getHours())}-${_pad(_now.getMinutes())}`;
    const _filterSuffix = window._exportFiltersMap?.[tableId]?.() || '';
    const _fname = [label, _filterSuffix, _fechaLocal, _horaLocal].filter(Boolean).join('_');
    XLSX.writeFile(wb, `${_fname}.xlsx`);
    showToast(`📊 ${_fname}.xlsx descargado`);
  } catch(e) {
    showToast('Error al exportar: ' + e.message);
  }
}

/**
 * Abre el modal de WhatsApp pre-cargando tabla y título.
 */
// ── WhatsApp modal dock (acople lateral al opener, mismo patrón que el visor) ─
let _waDocked      = false;
let _waOpenerModal = null;   // id del modal opener (ej: 'modal-turno')
const _WA_GAP      = 12;

function _waRenderDockBtn() {
  const btn = document.getElementById('wa-dock-btn');
  if (!btn) return;
  if (_waDocked) {
    // Acoplado: thumbtack tachado, estilo neutro
    btn.innerHTML =
      '<span style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;">' +
        '<i class="fa-solid fa-thumbtack" style="font-size:13px;"></i>' +
        '<span style="position:absolute;width:150%;height:1.5px;background:currentColor;transform:rotate(-45deg);border-radius:1px;pointer-events:none;"></span>' +
      '</span>';
    btn.title = 'Acoplado — se mueven juntos. Clic para desacoplar.';
    btn.style.background  = 'rgba(255,255,255,0.08)';
    btn.style.borderColor = 'rgba(255,255,255,0.25)';
    btn.style.color       = 'rgba(255,255,255,0.55)';
  } else {
    // Desacoplado: thumbtack rojo, llama la atención
    btn.innerHTML = '<i class="fa-solid fa-thumbtack" style="font-size:13px;"></i>';
    btn.title = 'Desacoplado — flota libre. Clic para acoplar.';
    btn.style.background  = 'rgba(255,59,48,0.18)';
    btn.style.borderColor = 'rgba(255,59,48,0.45)';
    btn.style.color       = '#ffb3ae';
  }
}

function _waSetOverlayTransparent(on) {
  const ov = document.getElementById('modal-whatsapp');
  if (!ov) return;
  if (on) {
    ov.style.background     = 'transparent';
    ov.style.pointerEvents  = 'none';
    const card = ov.querySelector('.modal-card');
    if (card) card.style.pointerEvents = 'auto';
  } else {
    ov.style.background    = '';
    ov.style.pointerEvents = '';
    const card = ov.querySelector('.modal-card');
    if (card) card.style.pointerEvents = '';
  }
}

function _waAutoPosition() {
  if (!_waOpenerModal) return;
  const openerCard = document.getElementById(_waOpenerModal)?.querySelector('.modal-card');
  const waCard     = document.getElementById('modal-whatsapp')?.querySelector('.modal-card');
  if (!openerCard || !waCard) return;

  const rect = openerCard.getBoundingClientRect();
  const waW  = waCard.offsetWidth  || 480;
  const waH  = waCard.offsetHeight || 500;
  const sw   = window.innerWidth;
  const sh   = window.innerHeight;

  // Intentar a la izquierda del opener; si no cabe, a la derecha
  let left = rect.left - waW - _WA_GAP;
  if (left < 8) left = rect.right + _WA_GAP;
  if (left + waW > sw - 8) left = Math.max(8, (sw - waW) / 2);

  const top = Math.max(8, Math.min(rect.top, sh - waH - 8));

  // Mover el card con transform (igual que el sistema de drag)
  const nat = waCard.getBoundingClientRect();
  const m   = new DOMMatrix(getComputedStyle(waCard).transform);
  const curTX = isFinite(m.m41) ? m.m41 : 0;
  const curTY = isFinite(m.m42) ? m.m42 : 0;
  const newTX = curTX + (left - nat.left);
  const newTY = curTY + (top  - nat.top);
  waCard.style.transition = 'transform 0.2s ease';
  waCard.style.transform  = `translate(${newTX}px,${newTY}px)`;
  setTimeout(() => { if (waCard) waCard.style.transition = ''; }, 220);
}

function waToggleDock() {
  _waDocked = !_waDocked;
  _waRenderDockBtn();
  _waSetOverlayTransparent(_waDocked);
  if (_waDocked) _waAutoPosition();
}

// preselect: { tipo: 'chofer'|'propietario', id: number }
function _waShowDisconnected(st, httpStatus, msg) {
  const errMsg = '✗ ' + (msg || 'Error al enviar');
  if (httpStatus === 503) {
    st.innerHTML = `<span style="color:var(--color-error);">${errMsg}</span>
      <button type="button" onclick="waReconectarDesdeModal()" class="btn btn-sm" style="margin-left:10px;padding:2px 10px;font-size:11px;background:#25d366;color:#fff;border:none;border-radius:6px;cursor:pointer;">
        <i class="fa-solid fa-rotate"></i> Reconectar
      </button>`;
  } else {
    st.innerHTML = `<span style="color:var(--color-error);">${errMsg}</span>`;
  }
}

async function openWhatsAppModal(tableId, label, preselect = null) {
  // Si se abre desde la barra de export (tabla real), descartar cualquier XLS pre-generado de turno
  if (tableId) _waPreXls = null;
  document.getElementById('wa-export-table-id').value = tableId;
  document.getElementById('wa-export-title').value = label;
  document.getElementById('wa-message').value = `Adjunto listado de ${label} — FlotaControl`;
  document.getElementById('wa-status').textContent = '';
  document.getElementById('wa-phone').value = '';
  document.getElementById('wa-dest-nombre').value = '';
  document.getElementById('wa-dest-id').value = '';
  document.getElementById('wa-dest-phone-preview').textContent = '';

  // Tipo de destinatario
  const tipo = preselect?.tipo || 'chofer';
  const radios = document.querySelectorAll('input[name="wa-dest-tipo"]');
  radios.forEach(r => r.checked = r.value === tipo);
  await waOnDestinoTipo();

  // Preseleccionar destinatario si se pasó id
  if (preselect?.id) {
    const sel = document.getElementById('wa-dest-select');
    if (sel) {
      // Esperar a que el select esté poblado
      const trySelect = () => {
        const opt = [...sel.options].find(o => String(o.value) === String(preselect.id));
        if (opt) {
          sel.value = preselect.id;
          sel.dispatchEvent(new Event('change'));
        }
      };
      setTimeout(trySelect, 150);
    }
  }

  // Detectar opener (modal activo antes de abrir WA) para acople
  const activeModals = [...document.querySelectorAll('.modal-overlay.active')];
  _waOpenerModal = activeModals.length ? activeModals[activeModals.length - 1].id : null;
  const dockBtn = document.getElementById('wa-dock-btn');
  if (dockBtn) dockBtn.style.display = _waOpenerModal ? 'inline-flex' : 'none';

  // Subir z-index sobre el visor flotante si está visible
  const waOverlay = document.getElementById('modal-whatsapp');
  const fvVisible = document.getElementById('float-img-viewer')?.style.display === 'flex';
  if (waOverlay) waOverlay.style.zIndex = fvVisible ? '12000' : '';

  // Abrir desacoplado por defecto; el usuario activa el acople con el thumbtack
  _waDocked = false;
  _waSetOverlayTransparent(false);
  _waRenderDockBtn();

  // Verificar si el bot está online
  fetch('/api/bot-status').then(r => r.json()).then(d => {
    const st  = document.getElementById('wa-status');
    const sst = document.getElementById('wa-send-status');
    if (!d.online) {
      if (st) st.innerHTML = `<span style="background:#e07b00;color:#fff;padding:2px 8px;border-radius:6px;font-weight:600;">⚠️ Bot no conectado</span>
        <button type="button" onclick="waReconectarDesdeModal()" class="btn btn-sm" style="margin-left:10px;padding:2px 10px;font-size:11px;background:#25d366;color:#fff;border:none;border-radius:6px;cursor:pointer;">
          <i class="fa-solid fa-rotate"></i> Reconectar / Nuevo QR
        </button>`;
    } else {
      if (st)  st.innerHTML  = '<span style="color:var(--color-success);">✓ Bot conectado</span>';
      if (sst) sst.innerHTML = ''; // limpiar error previo de envío fallido
    }
  }).catch(e => {
    const st = document.getElementById('wa-status');
    if (st) { st.innerHTML = `<span style="background:#e07b00;color:#fff;padding:2px 8px;border-radius:6px;font-weight:600;">⚠️ No se pudo verificar estado del bot</span>`; }
    console.warn('[bot-status]', e);
  });
  // Mostrar/ocultar el toggle XLS según si hay tabla o XLS pre-generado
  const xlsToggle = document.getElementById('wa-xls-toggle');
  const hasXls = !!(tableId || _waPreXls);
  if (xlsToggle) xlsToggle.style.display = hasXls ? 'flex' : 'none';

  openModal('modal-whatsapp');
  requestAnimationFrame(() => {
    waUpdateTipoBtns();
    waXlsHover(document.getElementById('wa-xls-toggle'));
  });
}

async function waOnDestinoTipo() {
  const tipo = document.querySelector('input[name="wa-dest-tipo"]:checked')?.value || 'chofer';
  const selWrap = document.getElementById('wa-dest-select-wrap');
  const manWrap = document.getElementById('wa-dest-manual-wrap');
  const sel     = document.getElementById('wa-dest-select');

  if (tipo === 'manual') {
    selWrap.style.display = 'none';
    manWrap.style.display = '';
    document.getElementById('wa-phone').value = '';
    document.getElementById('wa-dest-nombre').value = 'Número manual';
    return;
  }
  selWrap.style.display = '';
  manWrap.style.display = 'none';

  // Poblar select según tipo
  sel.innerHTML = '<option value="">— Seleccioná —</option>';
  const isTg = _waCanal === 'telegram';
  if (tipo === 'chofer') {
    if (!cachedChoferes.length) await loadChoferesSelect();
    cachedChoferes.forEach(c => {
      const nombre = `${c.nombre || ''} ${c.apellido || ''}`.trim();
      const contacto = isTg ? (c.telegram_chat_id || '') : (c.telefono || '');
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.dataset.phone = contacto;
      opt.dataset.nombre = nombre;
      opt.dataset.tgId = c.telegram_chat_id || '';
      opt.textContent = nombre + (contacto ? ` · ${isTg ? '🔵 ' : ''}${contacto}` : isTg ? ' (sin Telegram)' : ' (sin tel.)');
      opt.disabled = !contacto;
      sel.appendChild(opt);
    });
  } else {
    let personas = [];
    try { const r = await fetch('/api/personas'); personas = await r.json(); } catch(_) {}
    personas.forEach(p => {
      const nombre = `${p.apellido || ''}, ${p.nombre || ''}`.trim();
      const contacto = isTg ? (p.telegram_chat_id || '') : (p.celular || p.telefono || '');
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.dataset.phone = contacto;
      opt.dataset.nombre = nombre;
      opt.dataset.tgId = p.telegram_chat_id || '';
      opt.textContent = nombre + (contacto ? ` · ${isTg ? '🔵 ' : ''}${contacto}` : isTg ? ' (sin Telegram)' : ' (sin tel.)');
      opt.disabled = !contacto;
      sel.appendChild(opt);
    });
  }
  waOnDestinoSelect();
}

function waOnDestinoSelect() {
  const sel = document.getElementById('wa-dest-select');
  const opt = sel.options[sel.selectedIndex];
  const phone  = opt?.dataset?.phone  || '';
  const nombre = opt?.dataset?.nombre || '';
  const id     = sel.value || '';
  document.getElementById('wa-phone').value      = phone.replace(/\D/g,'');
  document.getElementById('wa-dest-nombre').value = nombre;
  document.getElementById('wa-dest-id').value    = id;
  const preview = document.getElementById('wa-dest-phone-preview');
  if (preview) preview.textContent = phone ? `Tel: ${phone}` : (sel.value ? '⚠ Sin teléfono registrado' : '');
}

/**
 * Genera el XLS en memoria (base64) y lo envía por WhatsApp via backend.
 */
// ── Canal WA / Telegram ──────────────────────────────────────────────────────
let _waCanal = 'whatsapp'; // 'whatsapp' | 'telegram'

function waSwitchCanal() {
  _waCanal = document.querySelector('input[name="wa-canal"]:checked')?.value || 'whatsapp';
  const isTg = _waCanal === 'telegram';
  const hdr  = document.getElementById('wa-modal-header');
  const title = document.getElementById('wa-modal-title');
  const sendBtn = document.querySelector('#modal-whatsapp .modal-footer .btn-primary');
  const xlsToggle = document.getElementById('wa-xls-toggle');

  if (isTg) {
    hdr.style.background   = 'linear-gradient(135deg,#0d47a1 0%,#1565c0 60%,#2196f3 130%)';
    title.innerHTML        = '<i class="fa-brands fa-telegram" style="font-size:1.6rem;filter:drop-shadow(0 1px 4px rgba(0,0,0,.3));"></i> Enviar por Telegram';
    if (sendBtn) { sendBtn.style.background = 'linear-gradient(135deg,#1565c0,#2196f3)'; sendBtn.innerHTML = '<i class="fa-brands fa-telegram" style="font-size:1.1rem;"></i> Enviar'; }
    // En Telegram el XLS se envía como documento — siempre disponible
    _waCheckTelegramStatus();
  } else {
    hdr.style.background   = 'linear-gradient(135deg,#075e54 0%,#128c7e 60%,#25d366 130%)';
    title.innerHTML        = '<i class="fa-brands fa-whatsapp" style="font-size:1.6rem;filter:drop-shadow(0 1px 4px rgba(0,0,0,.3));"></i> Enviar mensaje';
    if (sendBtn) { sendBtn.style.background = 'linear-gradient(135deg,#128c7e,#25d366)'; sendBtn.innerHTML = '<i class="fa-brands fa-whatsapp" style="font-size:1.1rem;"></i> Enviar'; }
    _waCheckBotStatus();
  }
  // Repoblar select con campo correcto (tel para WA, telegram_chat_id para TG)
  waOnDestinoTipo();
}

async function _waCheckTelegramStatus() {
  const st = document.getElementById('wa-status');
  if (!st) return;
  try {
    const d = await fetch('/api/telegram/status').then(r => r.json());
    if (!d.configured) {
      st.innerHTML = `<span style="background:#e07b00;color:#fff;padding:2px 8px;border-radius:6px;font-weight:600;">⚠️ Token no configurado</span>
        <a href="#" onclick="event.preventDefault();" style="margin-left:8px;font-size:11px;color:var(--accent-color);">Agregá TELEGRAM_BOT_TOKEN en .env</a>`;
    } else if (!d.online) {
      st.innerHTML = `<span style="background:#e07b00;color:#fff;padding:2px 8px;border-radius:6px;font-weight:600;">⚠️ Bot offline — verificá el token</span>`;
    } else {
      st.innerHTML = `<span style="color:var(--color-success);">✓ Bot @${d.username} conectado</span>`;
    }
  } catch(_) {
    st.innerHTML = `<span style="background:#e07b00;color:#fff;padding:2px 8px;border-radius:6px;font-weight:600;">⚠️ No se pudo verificar el bot</span>`;
  }
}

async function _waCheckBotStatus() {
  const st = document.getElementById('wa-status');
  if (!st) return;
  try {
    const d = await fetch('/api/bot-status').then(r => r.json());
    if (!d.online) {
      st.innerHTML = `<span style="background:#e07b00;color:#fff;padding:2px 8px;border-radius:6px;font-weight:600;">⚠️ Bot no conectado</span>
        <button type="button" onclick="waReconectarDesdeModal()" class="btn btn-sm" style="margin-left:10px;padding:2px 10px;font-size:11px;background:#25d366;color:#fff;border:none;border-radius:6px;cursor:pointer;">
          <i class="fa-solid fa-rotate"></i> Reconectar / Nuevo QR
        </button>`;
    } else {
      st.innerHTML = '<span style="color:var(--color-success);">✓ Bot conectado</span>';
    }
  } catch(_) {
    st.innerHTML = `<span style="background:#e07b00;color:#fff;padding:2px 8px;border-radius:6px;font-weight:600;">⚠️ No se pudo verificar estado del bot</span>`;
  }
}

function waUpdateTipoBtns() {
  // Fuerza re-render visual de los pills (el CSS :checked lo hace, pero por si acaso)
  document.querySelectorAll('.wa-tipo-btn input').forEach(r => {
    const span = r.nextElementSibling;
    if (!span) return;
    if (r.checked) {
      span.style.borderColor = '#25d366';
      span.style.background  = 'rgba(37,211,102,.12)';
      span.style.color       = '#25d366';
    } else {
      span.style.borderColor = '';
      span.style.background  = '';
      span.style.color       = '';
    }
  });
}

function waXlsHover(label) {
  const cb    = document.getElementById('wa-adjuntar-xls');
  const icon  = document.getElementById('wa-xls-icon');
  const check = document.getElementById('wa-xls-check');
  if (!cb) return;
  const on = cb.checked;
  if (label) {
    label.style.borderColor = on ? '#1d6f42' : 'var(--border-color)';
    label.style.background  = on ? 'rgba(29,111,66,.08)' : 'var(--bg-secondary)';
  }
  if (icon)  icon.style.opacity  = on ? '1' : '.35';
  if (check) check.style.opacity = on ? '1' : '0';
}

function _waHaceTexto(date) {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60)    return 'hace menos de 1 minuto';
  if (diff < 3600)  return `hace ${Math.floor(diff/60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff/3600)}h`;
  const d = Math.floor(diff/86400);
  return `hace ${d} día${d>1?'s':''}`;
}

function _waFechaFmt(isoStr) {
  // MySQL puede devolver "2026-06-27 09:15:00" sin la T — forzamos parseo correcto
  const d = new Date(String(isoStr).replace(' ', 'T'));
  if (isNaN(d)) return isoStr || '—';
  const pad = n => String(n).padStart(2,'0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function _waConfirmReenvio(hist, destNombre, label) {
  return new Promise(resolve => {
    const filas = hist.map((h, i) => {
      const fecha = h.fecha ? _waFechaFmt(h.fecha) : '—';
      const hace  = h.fecha ? _waHaceTexto(new Date(h.fecha)) : '—';
      const user  = h.usuario_nombre || 'Sistema';
      const bg    = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.06)';
      return `<tr style="background:${bg};">
        <td style="padding:8px 12px;white-space:nowrap;font-weight:600;color:#f1f5f9;font-size:13px;">${fecha}</td>
        <td style="padding:8px 12px;white-space:nowrap;color:#f97316;font-size:12px;font-weight:600;">${hace}</td>
        <td style="padding:8px 12px;color:#94a3b8;font-size:13px;"><i class="fa-solid fa-user" style="font-size:10px;margin-right:5px;opacity:.5;"></i>${user}</td>
      </tr>`;
    }).join('');

    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;inset:0;z-index:25000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);animation:_waFadeIn .18s ease;';

    // Inyectar keyframes si no existen
    if (!document.getElementById('_waKf')) {
      const s = document.createElement('style');
      s.id = '_waKf';
      s.textContent = `
        @keyframes _waFadeIn { from{opacity:0;transform:scale(.95)} to{opacity:1;transform:scale(1)} }
        @keyframes _waBlink  { 0%,100%{opacity:1} 50%{opacity:.25} }
        ._wa-blink { animation: _waBlink 1s ease-in-out infinite; }
      `;
      document.head.appendChild(s);
    }

    div.innerHTML = `
      <div style="background:var(--bg-card,#1e1e2e);border-radius:18px;box-shadow:0 16px 60px rgba(0,0,0,.6),0 0 0 1px rgba(249,115,22,.3);max-width:500px;width:93vw;overflow:hidden;">

        <!-- Header llamativo -->
        <div style="background:linear-gradient(135deg,#b45309,#f97316);padding:18px 22px;display:flex;align-items:center;gap:14px;">
          <div class="_wa-blink" style="font-size:2.2rem;line-height:1;">⚠️</div>
          <div>
            <div style="color:#fff;font-weight:800;font-size:17px;letter-spacing:-.01em;">¡Ya fue enviado!</div>
            <div style="color:rgba(255,255,255,.8);font-size:12px;margin-top:2px;">Revisá el historial antes de reenviar</div>
          </div>
        </div>

        <!-- Cuerpo -->
        <div style="padding:20px 22px;">
          <p style="margin:0 0 14px;font-size:13.5px;color:var(--text-primary);line-height:1.5;">
            <strong style="color:#f97316;">"${label}"</strong> ya fue enviado a <strong>${destNombre}</strong>:
          </p>
          <div style="border-radius:10px;overflow:hidden;border:1px solid rgba(249,115,22,.25);">
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
              <thead>
                <tr style="background:rgba(249,115,22,.12);">
                  <th style="padding:8px 12px;text-align:left;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#f97316;">Fecha y hora</th>
                  <th style="padding:8px 12px;text-align:left;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#f97316;">Hace</th>
                  <th style="padding:8px 12px;text-align:left;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#f97316;">Usuario</th>
                </tr>
              </thead>
              <tbody>${filas}</tbody>
            </table>
          </div>
          <p style="margin:16px 0 0;font-size:13px;color:var(--text-secondary);">¿Querés enviarlo de todas formas?</p>
        </div>

        <!-- Footer -->
        <div style="padding:10px 22px 20px;display:flex;justify-content:flex-end;gap:10px;">
          <button id="_waConfirmCancel" class="btn btn-secondary" style="font-size:13px;">
            <i class="fa-solid fa-ban"></i> Cancelar
          </button>
          <button id="_waConfirmOk" class="btn btn-primary" style="background:linear-gradient(135deg,#128c7e,#25d366);border:none;font-size:13px;font-weight:700;box-shadow:0 2px 10px rgba(37,211,102,.3);">
            <i class="fa-brands fa-whatsapp"></i> Sí, enviar igual
          </button>
        </div>
      </div>`;

    document.body.appendChild(div);
    const cleanup = (val) => {
      div.remove();
      document.removeEventListener('keydown', _keyHandler);
      resolve(val);
    };
    const _keyHandler = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault(); cleanup(false); }
      if (e.key === 'Enter')  { e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault(); cleanup(true);  }
    };
    document.addEventListener('keydown', _keyHandler, true); // capture: intercepta antes del handler de modales
    div.querySelector('#_waConfirmOk').onclick    = () => cleanup(true);
    div.querySelector('#_waConfirmCancel').onclick = () => cleanup(false);
    div.addEventListener('click', e => { if (e.target === div) cleanup(false); });
  });
}

async function sendViaWhatsApp() {
  if (_waCanal === 'telegram') { await _sendViaTelegram(); return; }

  const tableId = document.getElementById('wa-export-table-id').value;
  const label   = document.getElementById('wa-export-title').value;
  const tipo    = document.querySelector('input[name="wa-dest-tipo"]:checked')?.value || 'chofer';
  const rawPhone = tipo === 'manual'
    ? document.getElementById('wa-phone-manual').value.trim()
    : document.getElementById('wa-phone').value.trim();
  const phone   = rawPhone.replace(/\D/g,'');
  const message = document.getElementById('wa-message').value.trim();
  const adjuntar = document.getElementById('wa-adjuntar-xls').checked;
  const destNombre = tipo === 'manual' ? 'Número manual' : (document.getElementById('wa-dest-nombre').value || phone);
  const destId     = document.getElementById('wa-dest-id').value || null;
  const st = document.getElementById('wa-status');

  if (!phone) { st.textContent = 'Ingresá el número de teléfono'; st.style.color = 'var(--color-error)'; return; }

  // Verificar envíos previos: solo si tenemos AMBOS (destinatario + documento)
  // Con solo uno de los dos el resultado no es confiable y genera falsos positivos
  if (destId && label) {
    try {
      const params = new URLSearchParams({ recipientId: destId, docName: label });
      const hist = await fetch('/api/whatsapp/historial?' + params).then(r => r.json()).catch(() => []);
      if (hist.length) {
        const ok = await _waConfirmReenvio(hist, destNombre, label);
        if (!ok) return;
      }
    } catch(_) {}
  }

  st.textContent = '⏳ Enviando...'; st.style.color = 'var(--accent-color)';

  try {
    let xlsBase64 = null;
    let xlsFilename = null;

    if (adjuntar && window.XLSX) {
      if (_waPreXls) {
        // XLS pre-generado (ej: detalle de turno)
        xlsBase64   = _waPreXls.base64;
        xlsFilename = _waPreXls.filename;
        _waPreXls   = null;
      } else {
        const table = document.getElementById(tableId);
        if (table) {
          const wb = XLSX.utils.book_new();
          const ws = XLSX.utils.table_to_sheet(table);
          XLSX.utils.book_append_sheet(wb, ws, label.substring(0, 31));
          xlsBase64   = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
          xlsFilename = `${label}_${new Date().toISOString().split('T')[0]}.xlsx`;
        }
      }
    }

    const audit = {
      recipientTipo:   tipo,
      recipientNombre: destNombre,
      recipientId:     destId,
      docName:         label,
    };
    const res = await fetch('/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message, xlsBase64, xlsFilename, audit })
    });
    const data = await res.json();
    if (!res.ok) {
      _waShowDisconnected(st, res.status, data.message);
      return;
    }

    // Enviar adjuntos de multas seleccionados
    const adjChecks  = document.querySelectorAll('#wa-multa-adjs-list input[type=checkbox]:checked');
    const adjsToSend = Array.from(adjChecks).map(cb => _waMultaAdjs[parseInt(cb.dataset.adjIdx)]).filter(Boolean);

    if (adjsToSend.length) {
      st.textContent = `✓ Mensaje enviado — enviando ${adjsToSend.length} adjunto(s)...`;
      let sentAdjs = 0, failAdjs = 0;
      for (const adj of adjsToSend) {
        try {
          const fetchUrl = adj.tipo === 'link'
            ? `/api/proxy-imagen?url=${encodeURIComponent(adj.url)}`
            : adj.url;
          const blob   = await fetch(fetchUrl).then(r => { if (!r.ok) throw new Error(); return r.blob(); });
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          const sendRes = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, message: '', mediaBase64: base64, mediaMime: blob.type || 'application/octet-stream', mediaFilename: adj.nombre, audit: null })
          });
          if (sendRes.ok) { sentAdjs++; st.textContent = `Enviando adjuntos... ${sentAdjs}/${adjsToSend.length}`; }
          else failAdjs++;
          // Pausa entre envíos para evitar rate-limit de whatsapp-web.js
          await new Promise(r => setTimeout(r, 1200));
        } catch { failAdjs++; }
      }
      st.textContent = failAdjs
        ? `✓ Enviado — ${sentAdjs} adjunto(s) OK, ${failAdjs} con error`
        : `✓ Enviado con ${sentAdjs} adjunto(s)`;
    } else {
      st.textContent = '✓ Enviado correctamente';
    }

    st.style.color = 'var(--color-success)';
    _waMultaAdjs = [];
    setTimeout(() => closeModal('modal-whatsapp'), 1800);
  } catch(e) {
    st.textContent = 'Error: ' + (e?.message || String(e) || 'desconocido');
    st.style.color = 'var(--color-error)';
    console.error('[sendViaWhatsApp]', e);
  }
}

async function _sendViaTelegram() {
  const tableId    = document.getElementById('wa-export-table-id').value;
  const label      = document.getElementById('wa-export-title').value;
  const tipo       = document.querySelector('input[name="wa-dest-tipo"]:checked')?.value || 'chofer';
  const sel        = document.getElementById('wa-dest-select');
  const opt        = sel?.options[sel.selectedIndex];
  let   chatId     = tipo === 'manual'
    ? document.getElementById('wa-phone-manual').value.trim()
    : (opt?.dataset?.tgId || opt?.dataset?.phone || '').trim();
  const message    = document.getElementById('wa-message').value.trim();
  const adjuntar   = document.getElementById('wa-adjuntar-xls').checked;
  const destNombre = tipo === 'manual' ? 'Chat ID manual' : (document.getElementById('wa-dest-nombre').value || chatId);
  const destId     = document.getElementById('wa-dest-id').value || null;
  const st         = document.getElementById('wa-status');

  if (!chatId) {
    st.textContent = 'Este contacto no tiene Telegram Chat ID configurado';
    st.style.color = 'var(--color-error)';
    return;
  }

  st.textContent = '⏳ Enviando por Telegram...'; st.style.color = 'var(--accent-color)';

  try {
    let xlsBase64 = null, xlsFilename = null;
    if (adjuntar && window.XLSX) {
      if (_waPreXls) {
        xlsBase64 = _waPreXls.base64; xlsFilename = _waPreXls.filename; _waPreXls = null;
      } else {
        const table = document.getElementById(tableId);
        if (table) {
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, XLSX.utils.table_to_sheet(table), label.substring(0, 31));
          xlsBase64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
          xlsFilename = `${label}_${new Date().toISOString().split('T')[0]}.xlsx`;
        }
      }
    }
    const audit = { recipientTipo: tipo, recipientNombre: destNombre, recipientId: destId, docName: label };
    const res = await fetch('/api/telegram/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, message, xlsBase64, xlsFilename, audit })
    });
    const data = await res.json();
    if (!res.ok) {
      st.textContent = '✗ ' + (data.message || 'Error al enviar'); st.style.color = 'var(--color-error)';
      return;
    }

    // Enviar adjuntos de multas seleccionados
    const adjChecks  = document.querySelectorAll('#wa-multa-adjs-list input[type=checkbox]:checked');
    const adjsToSend = Array.from(adjChecks).map(cb => _waMultaAdjs[parseInt(cb.dataset.adjIdx)]).filter(Boolean);
    if (adjsToSend.length) {
      st.textContent = `✓ Mensaje enviado — enviando ${adjsToSend.length} adjunto(s)...`;
      let sentAdjs = 0, failAdjs = 0;
      for (const adj of adjsToSend) {
        try {
          const fetchUrl = adj.tipo === 'link'
            ? `/api/proxy-imagen?url=${encodeURIComponent(adj.url)}`
            : adj.url;
          const blob   = await fetch(fetchUrl).then(r => { if (!r.ok) throw new Error(); return r.blob(); });
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          const sendRes = await fetch('/api/telegram/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId, message: '', mediaBase64: base64, mediaMime: blob.type || 'application/octet-stream', mediaFilename: adj.nombre, audit: null })
          });
          if (sendRes.ok) sentAdjs++; else failAdjs++;
        } catch { failAdjs++; }
      }
      st.textContent = failAdjs
        ? `✓ Enviado — ${sentAdjs} adjunto(s) OK, ${failAdjs} con error`
        : `✓ Enviado con ${sentAdjs} adjunto(s)`;
    } else {
      st.textContent = '✓ Enviado por Telegram';
    }

    st.style.color = 'var(--color-success)';
    _waMultaAdjs = [];
    setTimeout(() => closeModal('modal-whatsapp'), 1800);
  } catch(e) {
    st.textContent = 'Error: ' + (e?.message || String(e)); st.style.color = 'var(--color-error)';
  }
}

// Sanitize phone fields on blur — strip all non-digits
document.addEventListener('focusout', e => {
  const phoneIds = ['ch-telefono','usr-celular','aseg-telefono','prov-telefono','suc-telefono','vh-titular-celular'];
  if (phoneIds.includes(e.target.id) && e.target.value) {
    const clean = e.target.value.replace(/\D/g, '');
    if (clean !== e.target.value) e.target.value = clean;
  }
});

document.addEventListener('DOMContentLoaded', () => {
  // Registrar ChartDataLabels globalmente una sola vez al arrancar
  if (window.ChartDataLabels) Chart.register(ChartDataLabels);

  // Inicializar selects buscables
  initAllSearchableSelects();

  // Tab Navigation Lógica
  const navItems = document.querySelectorAll('.nav-item');
  const contentViews = document.querySelectorAll('.content-view');
  const pageTitle = document.getElementById('page-title');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tabId = item.getAttribute('data-tab');
      navItems.forEach(btn => btn.classList.remove('active'));
      item.classList.add('active');
      contentViews.forEach(view => view.classList.remove('active'));
      const targetView = document.getElementById(tabId);
      if (targetView) targetView.classList.add('active');
      pageTitle.innerText = item.querySelector('.nav-label')?.innerText || item.innerText.trim();
      loadTabData(tabId);
    });
  });
  // initApp() se llama desde bootApp() luego del login
});

// Inicializar la aplicación
async function initApp() {
  loadStats();
  loadDashboardVehicles();
  loadFiscalConditions();
  loadChoferesSelect();
  loadCuentasSelect();
  loadMarcasSelect();
  loadAseguradorasSelect();
  initDragAndDropOCR();
  initFileUploader('vh-foto-file', 'vh-foto-principal', 'vh-foto-principal-lbl');
  // vtv usa su propio dropzone + handleVtvFileSelect — no necesita initFileUploader
  initFileUploader('gnc-file', 'gnc-archivo', 'gnc-archivo-lbl');
  initFileUploader('seg-file', 'seg-archivo', 'seg-archivo-lbl');
  initModalTabs();

  // ── Toolbars universales de Drag & Drop ──
  await checkAiStatus();   // determina si la API Key está configurada
  initAllDzToolbars();     // inyecta Camera / OCR / IA en todos los dropzones

  // Registrar fecha+hora actual por defecto en el formulario de pagos
  const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().substring(0, 16);
  document.getElementById('pg-fecha').value = nowLocal;
}

// Carga de datos dependiendo de la pestaña activa
function loadTabData(tabId) {
  switch (tabId) {
    case 'tab-dashboard':
      loadStats();
      loadDashboardVehicles();
      break;
    case 'tab-alertas':
      loadAlertasModulo();
      break;
    case 'tab-choferes':
      loadChoferes();
      break;
    case 'tab-vehiculos':
      loadVehiculos();
      break;
    case 'tab-proveedores':
      loadProveedores();
      break;
    case 'tab-aseguradoras':
      loadAseguradoras();
      break;
    case 'tab-services':
      loadServices();
      break;
    case 'tab-multas':
      loadMultas();
      break;
    case 'tab-municipalidades':
      loadMunicipalidades();
      break;
    case 'tab-stock':
      loadStock();
      break;
    case 'tab-turnos':
      loadTurnos();
      break;
    case 'tab-rendiciones':
      loadRendiciones();
      break;
    case 'tab-peajes':
      loadPeajes();
      break;
    case 'tab-finanzas':
      loadPrestamos();
      loadPagos();
      break;
    case 'tab-usuarios':
      loadUsuarios();
      break;
    case 'tab-auditoria':
      loadAuditoria();
      break;
  }
}

function navigateTo(tabId) {
  const btn = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (btn) btn.click();
}

// Helpers para Modales

// Garantiza que el contenido del modal-card esté dentro de un .modal-body scrolleable
function _ensureModalBody(card) {
  if (card._mbDone) return;
  card._mbDone = true;

  const header = card.querySelector(':scope > .modal-header');
  const footer = card.querySelector(':scope > .modal-footer');

  // Si ya tiene un .modal-body directo, nada que hacer
  if (card.querySelector(':scope > .modal-body')) return;

  // Recoger todos los nodos hijos que NO son header ni footer
  const children = [...card.childNodes].filter(n => n !== header && n !== footer && !(n.nodeType === 3 && !n.textContent.trim()));
  if (!children.length) return;

  const body = document.createElement('div');
  body.className = 'modal-body';
  // Insertar el body después del header (o al inicio si no hay header)
  const anchor = header ? header.nextSibling : card.firstChild;
  card.insertBefore(body, anchor);
  children.forEach(n => body.appendChild(n));
}

// Stack de modales abiertos para manejar Enter/Esc correctamente con anidados
const _modalStack = [];

function _injectModalKbdHints(overlay) {
  const footer = overlay.querySelector('.modal-footer');
  if (!footer) return;
  // Quitar hints anteriores para no duplicar
  footer.querySelectorAll('._modal-kbd').forEach(k => k.remove());
  // Botón primario → Enter
  const primary = footer.querySelector('.btn-primary');
  if (primary) {
    const kbd = document.createElement('kbd');
    kbd.className = '_alert-kbd _modal-kbd';
    kbd.textContent = '↵';
    primary.appendChild(kbd);
  }
  // Botón secundario (Cancelar) → Esc — buscar por onclick closeModal o texto "cancelar"
  const cancel = [...footer.querySelectorAll('.btn-secondary')]
    .find(b => (b.getAttribute('onclick') || '').includes('closeModal') || b.textContent.trim().toLowerCase().startsWith('cancelar'))
    || [...footer.querySelectorAll('.btn-secondary')].at(0);
  if (cancel) {
    const kbd = document.createElement('kbd');
    kbd.className = '_alert-kbd _modal-kbd';
    kbd.textContent = 'Esc';
    cancel.appendChild(kbd);
  }
}

function _modalKeyHandler(e) {
  // No actuar si el alert/confirm propio está abierto
  if (_alertResolve) return;
  const id = _modalStack.at(-1);
  if (!id) return;
  const overlay = document.getElementById(id);
  if (!overlay?.classList.contains('active')) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    // Modal de verificación: confirmar antes de cerrar si hay resultados cargados
    if (id === 'modal-verificacion' && _verifResultado?.multas?.length) {
      showConfirm('¿Cerrar la verificación? Se perderán los resultados del scraper y las imágenes cargadas.').then(ok => { if (ok) closeModal('modal-verificacion'); });
      return;
    }
    const footer = overlay.querySelector('.modal-footer');
    const btns = footer ? [...footer.querySelectorAll('.btn-secondary')] : [];
    const cancel = btns.find(b => (b.getAttribute('onclick')||'').includes('closeModal') || b.textContent.trim().toLowerCase().startsWith('cancelar'))
      || btns.at(0);
    const doClose = () => { if (cancel) cancel.click(); else closeModal(id); };
    // Confirmación si hay datos cargados (tanto alta como edición)
    const form = overlay.querySelector('form');
    if (form && overlay.id !== 'modal-whatsapp') {
      const idField = form.querySelector('input[type=hidden]');
      const isNew = !idField?.value;
      const isDirty = isNew
        ? [...form.querySelectorAll('input:not([type=hidden]),textarea')].some(el => el.value.trim() !== '')
        : form.dataset.dirty === '1'; // edición: marcado por _markFormDirty()
      if (isDirty) {
        const msg = isNew
          ? '¿Querés descartar los datos ingresados y cerrar?'
          : '¿Querés cerrar sin guardar los cambios?';
        showConfirm(msg).then(ok => { if (ok) doClose(); });
        return;
      }
    }
    doClose();
  } else if (e.key === 'Enter' && !e.shiftKey) {
    // No disparar si el foco está en textarea, select, input que no sea botón
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA') return;
    if (tag === 'INPUT' && document.activeElement.type !== 'button') {
      // Permitir Enter en inputs de texto (navegación natural) excepto si el footer tiene foco
      const inFooter = overlay.querySelector('.modal-footer')?.contains(document.activeElement);
      if (!inFooter) return;
    }
    e.preventDefault();
    const footer = overlay.querySelector('.modal-footer');
    const primary = footer?.querySelector('.btn-primary');
    if (primary) primary.click();
  }
}

function openModal(id) {
  // Ocultar todos los scroll-nav-btns mientras hay un modal abierto
  window.dispatchEvent(new Event('flota:modalopen'));
  const overlay = document.getElementById(id);
  if (!overlay) return;
  const card = overlay.querySelector('.modal-card');
  if (card) {
    // Resetear posición arrastrada
    card.style.position = '';
    card.style.top      = '';
    card.style.left     = '';
    card.style.width    = '';
    card.style.height   = '';
    card.style.margin   = '';
    card.style.transform = '';
    card.dataset.dragged = '';

    // Asegurar que todo el contenido entre header y footer esté en .modal-body
    _ensureModalBody(card);

    // Botones Top/Bottom en el modal-body
    const body = card.querySelector('.modal-body');
    if (body) _attachScrollNav(body, card);
  }
  // Si hay otro modal activo, elevar el z-index para que el nuevo quede encima
  const alreadyOpen = document.querySelectorAll('.modal-overlay.active').length;
  overlay.style.zIndex = alreadyOpen > 0 ? (1100 + alreadyOpen * 10) : '';
  // Ocultar flechas de scroll de modales ya abiertos (quedarían encima)
  if (alreadyOpen > 0) {
    document.querySelectorAll('.modal-scroll-arrows').forEach(el => el.style.display = 'none');
  }
  overlay.classList.add('active');
  document.body.classList.add('modal-open');

  // Si el visor float está abierto desde OTRO modal QUE YA NO ESTÁ ACTIVO, cerrarlo
  // para evitar que su iframe PDF intercepte eventos del nuevo modal (ej: click en campo fecha).
  // Si el modal que lo abrió sigue activo (ej: "+ Nuevo proveedor" desde Editar Service),
  // dejamos el visor abierto para poder seguir consultando sus datos.
  const fvEl = document.getElementById('float-img-viewer');
  const fvOpenerStillActive = _fvOpenerModal && document.getElementById(_fvOpenerModal)?.classList.contains('active');
  if (fvEl && fvEl.style.display === 'flex' && _fvOpenerModal && _fvOpenerModal !== id && !fvOpenerStillActive) {
    closeFloatViewer();
  }

  _bindModalScrollArrows(id);
  // Sincronizar display de todos los searchable-selects dentro del modal
  overlay.querySelectorAll('select[data-ss-done]').forEach(sel => {
    const inp = sel.parentElement?.querySelector('.ss-input');
    if (!inp) return;
    const cur = [...sel.options].find(o => o.value === sel.value);
    inp.value = cur && cur.value !== '' ? cur.text : '';
    inp.placeholder = sel.options[0]?.text || 'Buscar...';
  });
  // Inyectar hints de teclado y registrar en stack
  _injectModalKbdHints(overlay);
  if (!_modalStack.includes(id)) _modalStack.push(id);
  if (_modalStack.length === 1) {
    document.addEventListener('keydown', _modalKeyHandler);
  }
  // Dirty tracking para confirmación ESC en edición
  const form = overlay.querySelector('form');
  if (form) {
    form.dataset.dirty = '0';
    if (!form._dirtyBound) {
      form._dirtyBound = true;
      form.addEventListener('input',  () => { form.dataset.dirty = '1'; });
      form.addEventListener('change', () => { form.dataset.dirty = '1'; });
    }
  }
}

// ── Dirty-tracking para modales con formulario ────────────────────────────────
const _formDirty = {};
function _markModalClean(modalId) { _formDirty[modalId] = false; }
function _markModalDirty(modalId) { _formDirty[modalId] = true; }

function _initDirtyTracking(formId, modalId) {
  const form = document.getElementById(formId);
  if (!form || form._dirtyModalId === modalId) return; // ya inicializado
  form._dirtyModalId = modalId;
  form.addEventListener('input',  () => { if (_formDirty[modalId] === false) _markModalDirty(modalId); });
  form.addEventListener('change', () => { if (_formDirty[modalId] === false) _markModalDirty(modalId); });
}

async function closeModalSafe(modalId) {
  if (_formDirty[modalId]) {
    const ok = await showConfirm('Hay cambios sin guardar. ¿Salir de todos modos?', 'Salir', 'Seguir editando');
    if (!ok) return;
  }
  _markModalClean(modalId);
  closeModal(modalId);
}

function closeModal(id) {
  const _cmo = document.getElementById(id);
  if (_cmo) {
    _cmo.classList.remove('active'); _cmo.style.zIndex = '';
    // Limpiar dirty flag al cerrar
    const form = _cmo.querySelector('form');
    if (form) form.dataset.dirty = '0';
  }
  _unbindModalScrollArrows(id);
  // Notificar a todos los _attachScrollNav para que re-evalúen visibilidad
  window.dispatchEvent(new Event('flota:modalclose'));
  if (!document.querySelector('.modal-overlay.active')) {
    document.body.classList.remove('modal-open');
  }
  if (_fvOpenerModal === id && id !== 'modal-whatsapp') closeFloatViewer();
  if (id === 'modal-wa-qr') {
    _stopWaQrPoll(); _stopWaQrCountdown?.();
    // Si el modal WA está abierto, refrescar estado del bot
    if (document.getElementById('modal-whatsapp')?.classList.contains('active')) {
      const st = document.getElementById('wa-status');
      const sst = document.getElementById('wa-send-status');
      fetch('/api/bot-status').then(r => r.json()).then(d => {
        if (st) st.innerHTML = d.online
          ? '<span style="color:var(--color-success);">✓ Bot conectado</span>'
          : '<span style="background:#e07b00;color:#fff;padding:2px 8px;border-radius:6px;font-weight:600;">⚠️ Bot no conectado</span>';
        if (sst && d.online) sst.innerHTML = '';
      }).catch(() => {});
    }
  }
  if (id === 'modal-whatsapp') {
    const waOverlayEl = document.getElementById('modal-whatsapp');
    if (waOverlayEl) waOverlayEl.style.zIndex = '';
    _waSetOverlayTransparent(false);
    const waCard = document.getElementById('modal-whatsapp')?.querySelector('.modal-card');
    if (waCard) { waCard.style.transform = ''; delete waCard.dataset.dragged; }
    _waDocked = false; _waOpenerModal = null;
    // Restaurar toggle XLS (puede haber sido ocultado por fvOpenWaSend)
    const xlsToggle = document.getElementById('wa-xls-toggle');
    if (xlsToggle) xlsToggle.style.display = '';
  }
  // Sacar del stack
  const idx = _modalStack.lastIndexOf(id);
  if (idx !== -1) _modalStack.splice(idx, 1);
  if (_modalStack.length === 0) {
    document.removeEventListener('keydown', _modalKeyHandler);
  }
}

// ── Flechas de scroll pegadas al modal-card ───────────────────────────────────
// El CARD hace scroll ahora (max-height: 90vh; overflow-y: auto)
let _activeScrollCard = null;
let _scrollArrowListener = null;
let _scrollArrowResizeObs = null;
let _scrollArrowPositioner = null; // ref a la closure _positionArrows activa

function _msaActiveCount() {
  return document.querySelectorAll('.modal-overlay.active').length;
}

function _bindModalScrollArrows(overlayId) {
  const overlay = document.getElementById(overlayId);
  if (!overlay) return;
  const card = overlay.querySelector('.modal-card');
  if (!card) return;
  _activeScrollCard = card;

  // Crear flechas en body (position:fixed) para que sean siempre visibles
  let arrows = document.getElementById(`msa-wrap-${overlayId}`);
  if (!arrows) {
    arrows = document.createElement('div');
    arrows.id = `msa-wrap-${overlayId}`;
    arrows.className = 'modal-scroll-arrows';
    arrows.innerHTML = `
      <button class="modal-scroll-arrow" id="msa-top-${overlayId}" onclick="_modalScrollTo('top')" title="Ir al inicio">
        <i class="fa-solid fa-chevron-up"></i>
      </button>
      <button class="modal-scroll-arrow" id="msa-bot-${overlayId}" onclick="_modalScrollTo('bottom')" title="Ir al final">
        <i class="fa-solid fa-chevron-down"></i>
      </button>`;
    document.body.appendChild(arrows);
  }
  // Solo mostrar si este es el único modal activo
  arrows.style.display = _msaActiveCount() <= 1 ? 'flex' : 'none';

  // Alinear las flechas sobre el scrollbar del card (ancho real y posición)
  function _positionArrows() {
    if (_msaActiveCount() > 1) { arrows.style.display = 'none'; return; }
    const rect = card.getBoundingClientRect();
    const sbWidth = card.offsetWidth - card.clientWidth;
    arrows.style.width = Math.max(sbWidth, 12) + 'px';
    arrows.style.right  = (window.innerWidth - rect.right) + 'px';
  }
  _scrollArrowPositioner = _positionArrows;
  requestAnimationFrame(() => { _positionArrows(); _updateScrollArrows(card, overlayId); });

  // Re-posicionar si el card cambia de tamaño
  if (window.ResizeObserver) {
    if (_scrollArrowResizeObs) _scrollArrowResizeObs.disconnect();
    _scrollArrowResizeObs = new ResizeObserver(() => _positionArrows());
    _scrollArrowResizeObs.observe(card);
  }

  _scrollArrowListener = () => _updateScrollArrows(card, overlayId);
  card.addEventListener('scroll', _scrollArrowListener);
}

function _unbindModalScrollArrows(overlayId) {
  // Ocultar flechas del body
  const arrows = document.getElementById(`msa-wrap-${overlayId}`);
  if (arrows) arrows.style.display = 'none';

  if (_scrollArrowResizeObs) { _scrollArrowResizeObs.disconnect(); _scrollArrowResizeObs = null; }

  const overlay = document.getElementById(overlayId);
  if (overlay && _scrollArrowListener) {
    const card = overlay.querySelector('.modal-card');
    if (card) {
      card.removeEventListener('scroll', _scrollArrowListener);
      card.scrollTop = 0;
    }
  }
  _scrollArrowListener = null;
  _activeScrollCard = null;
  _scrollArrowPositioner = null;
  // Re-bind al modal que quedó debajo si hay uno
  const remaining = document.querySelector('.modal-overlay.active');
  if (remaining) _bindModalScrollArrows(remaining.id);
}

function _updateScrollArrows(card, overlayId) {
  const arrowTop = document.getElementById(`msa-top-${overlayId}`);
  const arrowBot = document.getElementById(`msa-bot-${overlayId}`);
  if (!arrowTop || !arrowBot) return;
  const atTop    = card.scrollTop <= 10;
  const atBottom = card.scrollTop + card.clientHeight >= card.scrollHeight - 10;
  arrowTop.classList.toggle('hidden', atTop);
  arrowBot.classList.toggle('hidden', atBottom);
}

function _modalScrollTo(pos) {
  const card = _activeScrollCard;
  if (!card) return;
  card.scrollTo({ top: pos === 'top' ? 0 : card.scrollHeight, behavior: 'smooth' });
}

function _clearSelect(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el._ssSet) el._ssSet(''); else el.value = '';
}

// Formateador de moneda (ARS)
function formatCurrency(amount) {
  return '$ ' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount || 0);
}

// Inputs de monto con separador de miles (genérico)
// ── Money input helpers ───────────────────────────────────────────────────
// Format: 1,320,000.50  (comma=thousands, dot=decimals)
// Formatea campo celular para uso en WhatsApp: solo dígitos (sin +, espacios, guiones, paréntesis)
function fmtPhoneInput(el) {
  const pos = el.selectionStart;
  const prev = el.value.length;
  el.value = el.value.replace(/[\s+\-().]/g, '');
  const diff = prev - el.value.length;
  el.setSelectionRange(Math.max(0, pos - diff), Math.max(0, pos - diff));
}

function fmtAmountInput(el) {
  const cursor = el.selectionStart;
  const prevLen = el.value.length;

  // Allow digits, one dot for decimals
  let raw = el.value.replace(/[^0-9.]/g, '');
  // Keep only first dot
  const dotIdx = raw.indexOf('.');
  if (dotIdx !== -1) raw = raw.slice(0, dotIdx + 1) + raw.slice(dotIdx + 1).replace(/\./g, '');

  const [intPart, decPart] = raw.split('.');
  const intFmt = (intPart || '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const formatted = decPart !== undefined ? intFmt + '.' + decPart : intFmt;

  el.value = formatted;
  el.dataset.raw = raw;

  // Restore cursor accounting for added commas
  const diff = el.value.length - prevLen;
  try { el.setSelectionRange(cursor + diff, cursor + diff); } catch(_) {}
}

function _fmtAmountBlur(el) {
  const raw = parseFloat((el.dataset.raw || el.value).replace(/,/g, '')) || 0;
  if (!raw && !el.dataset.allowZero) { el.value = ''; el.dataset.raw = ''; return; }
  el.value = raw.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  el.dataset.raw = String(raw);
}

function getAmt(id) {
  const el = document.getElementById(id);
  if (!el) return 0;
  const raw = el.dataset.raw;
  if (raw !== undefined && raw !== '') return parseFloat(raw) || 0;
  // Fallback: strip commas (thousands) then parse
  return parseFloat((el.value || '').replace(/,/g, '')) || 0;
}

function setAmt(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  const num = parseFloat(val) || 0;
  if (num || el.dataset.allowZero) {
    // Estándar de la app: coma = miles, punto = decimales (igual que fmtAmountInput/getAmt/formatCurrency)
    el.value = num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    el.dataset.raw = String(num);
  } else {
    el.value = '';
    el.dataset.raw = '';
  }
}

// Auto-attach blur formatter to all money inputs on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[oninput*="fmtAmountInput"], input.money-input').forEach(el => {
    el.addEventListener('blur', () => _fmtAmountBlur(el));
  });
});

// Formateador CUIT: auto-inserta guiones → XX-XXXXXXXX-X
function formatCuit(inp) {
  let v = inp.value.replace(/\D/g, '').slice(0, 11);
  if (v.length > 10)      v = v.slice(0,2) + '-' + v.slice(2,10) + '-' + v.slice(10);
  else if (v.length > 2)  v = v.slice(0,2) + '-' + v.slice(2);
  inp.value = v;
}

// Formateador de fechas
function _aiErrorMsg(err) {
  const msg = err?.message || '';
  if (msg.includes('credenciales') || msg.includes('authentication') || msg.includes('apiKey') || msg.includes('503'))
    return '⚙️ Se debe configurar las credenciales de IA';
  return '⚠ Error: ' + msg;
}

function sanitizePhone(val) {
  if (!val) return null;
  const digits = val.replace(/\D/g, '');
  return digits || null;
}

// Formato argentino para modalidad de comisión: 50000 → "50.000", 0.5 → "0,5"
function fmtModalidad(val) {
  const n = parseFloat(String(val).replace(/\./g, '').replace(',', '.'));
  if (isNaN(n)) return String(val);
  return n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
// Convierte "50.000" o "0,5" de vuelta al valor crudo para guardar en BD
function parseModalidad(val) {
  if (!val) return null;
  const raw = String(val).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(raw);
  return isNaN(n) ? val : String(n);
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Normaliza celular argentino al formato requerido por WhatsApp BOT: 5491162448302
function normalizarCelular(cel) {
  if (!cel) return '';
  let d = cel.replace(/\D/g, '');       // solo dígitos
  d = d.replace(/^0+/, '');             // quitar ceros iniciales
  if (d.startsWith('54')) return d;     // ya tiene código país
  if (d.startsWith('9') && d.length >= 10) return '54' + d;  // 9 11 XXXX-XXXX
  if (d.length === 10) return '549' + d; // 11 XXXX-XXXX sin código país ni 9
  return d;
}

// Calcular la edad dinámicamente
function calculateAge(birthDateString) {
  if (!birthDateString) return '-';
  const birthDate = new Date(birthDateString);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age >= 0 ? `${age} años` : '-';
}

// Cargar estadísticas globales
async function loadStats() {
  try {
    const res = await fetch('/api/dashboard-stats');
    const stats = await res.json();

    document.getElementById('stat-choferes').innerText = stats.choferes || 0;
    document.getElementById('stat-vehiculos').innerText = stats.vehiculos || 0;
    document.getElementById('stat-multas').innerText = stats.multas || 0;
    document.getElementById('stat-services').innerText = stats.services || 0;
  } catch (error) {
    console.error('Error al cargar estadísticas:', error);
  }
}

// Cargar vehículos para el Dashboard
async function loadDashboardVehicles() {
  try {
    const res = await fetch('/api/vehiculos');
    const vehiculos = await res.json();
    const tbody = document.getElementById('dashboard-autos-list');
    tbody.innerHTML = '';

    vehiculos.forEach(v => {
      const respClass = v.telepeaje_responsable === 'chofer' ? 'badge-info' : 'badge-success';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${v.patente}</strong></td>
        <td>${v.marca || ''} ${v.modelo || ''}</td>
        <td><code>${v.telepeaje_tag || 'Sin Tag'}</code></td>
        <td><span class="badge ${respClass}">${v.telepeaje_responsable}</span></td>
        <td><span class="badge ${v.activo ? 'badge-success' : 'badge-danger'}">${v.activo ? 'activo' : 'inactivo'}</span></td>
      `;
      tbody.appendChild(tr);
    });
    bindHeaderEvents();
  } catch (error) {
    console.error('Error al cargar resumen de flota:', error);
  }
}

// --- CRUD: CHOFERES ---

function openAddChoferModal() {
  document.getElementById('form-chofer').reset();
  document.getElementById('ch-id').value = '';
  document.getElementById('modal-chofer-title').innerText = 'Alta de Chofer';
  document.getElementById('btn-submit-chofer').innerText = 'Registrar';
  document.getElementById('ch-activo-container').style.display = 'none';
  // Limpiar dropzones de documentos
  ['ch-prev-dni-frente','ch-prev-dni-dorso','ch-prev-reg-frente','ch-prev-reg-dorso'].forEach(id => {
    const el = document.getElementById(id); if (el) { el.src=''; el.style.display='none'; }
  });
  ['ch-drop-dni-frente','ch-drop-dni-dorso','ch-drop-reg-frente','ch-drop-reg-dorso'].forEach(id => {
    const dz = document.getElementById(id); if (!dz) return;
    dz.classList.remove('has-img');
    const sm = dz.querySelector('small'); if (sm) sm.textContent='Arrastrá o hacé clic';
  });
  ['ch-eye-dni-frente','ch-eye-dni-dorso','ch-eye-reg-frente','ch-eye-reg-dorso'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display='none';
  });
  Object.keys(_choferFiles).forEach(k => delete _choferFiles[k]);
  const jAlert = document.getElementById('chofer-jurisdiccion-alert');
  if (jAlert) jAlert.style.display = 'none';
  document.getElementById('ai-chofer-status').textContent = '';
  // Limpiar GPS
  ['ch-lat','ch-lng'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  const gpsStatus = document.getElementById('ch-gps-status'); if(gpsStatus) gpsStatus.textContent='';
  const chMap = document.getElementById('ch-map'); if(chMap){ chMap.style.display='none'; chMap.innerHTML=''; }
  const chMapBtn = document.getElementById('ch-map-btn'); if(chMapBtn) chMapBtn.style.display='none';
  openModal('modal-chofer');
}

async function loadChoferes() {
  try {
    const res = await fetch('/api/choferes');
    cachedChoferes = await res.json();
    const tbody = document.getElementById('choferes-table-body');
    tbody.innerHTML = '';

    cachedChoferes.forEach(c => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${c.nombre}</strong></td>
        <td>
          DNI: ${c.dni || '-'}<br>
          <small class="text-secondary">CUIL: ${c.cuil || '-'}</small>
        </td>
        <td>
          <a href="https://wa.me/${c.telefono}" target="_blank" style="color: var(--accent-green);">
            <i class="fa-brands fa-whatsapp"></i> ${c.telefono || '-'}
          </a>
          <button class="btn btn-sm" id="wa-btn-chofer-${c.id}" onclick="openChoferWAQr('chofer-${c.id}','${(c.nombre||'').replace(/'/g,"\\'")} ${(c.apellido||'').replace(/'/g,"\\'")}')" style="padding:2px 6px;font-size:11px;margin-left:4px;background:transparent;border:1px solid #25d366;color:#25d366;border-radius:4px;" title="Conectar WhatsApp de este número">QR</button>
          <br><small class="text-secondary">${c.email || '-'}</small>
        </td>
        <td>${c.modalidad ? fmtModalidad(c.modalidad) : '-'}</td>
        <td>${calculateAge(c.fecha_nacimiento)}</td>
        <td>${c.condicion_fiscal || 'Sin asignar'}</td>
        <td>
          <div style="display: flex; gap: 4px;">
            <span class="badge ${c.foto_chofer ? 'badge-success' : 'badge-danger'}" title="Foto Perfil">Perfil</span>
            <span class="badge ${(c.dni_frente_url||c.dni_dorso_url||c.foto_dni) ? 'badge-success' : 'badge-danger'}" title="${(c.dni_frente_url||c.dni_dorso_url) ? 'DNI cargado ✓' : 'Sin foto DNI'}">DNI</span>
            <span class="badge ${(c.registro_frente_url||c.registro_dorso_url||c.foto_registro) ? 'badge-success' : 'badge-danger'}" title="${(c.registro_frente_url||c.registro_dorso_url) ? 'Registro cargado ✓' : 'Sin foto Registro'}">Registro</span>
          </div>
        </td>
        <td><span class="badge ${c.activo ? 'badge-success' : 'badge-danger'}">${c.activo ? 'activo' : 'inactivo'}</span></td>
        <td style="text-align:center;white-space:nowrap;">
          <button class="tbl-action-btn tbl-btn-view"   onclick="verChofer(${c.id})"            title="Ver / Detalle"><i class="fa-solid fa-eye"></i></button>
          <button class="tbl-action-btn tbl-btn-edit"   onclick="editChofer(${c.id})"           title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
          ${canDelete()
            ? `<button class="tbl-action-btn tbl-btn-delete" onclick="deleteChofer(${c.id})"    title="Eliminar"><i class="fa-solid fa-trash"></i></button>`
            : `<button class="tbl-action-btn tbl-btn-toggle-${c.activo?'off':'on'}" onclick="toggleActivoChofer(${c.id},${c.activo})" title="${c.activo?'Desactivar':'Activar'}"><i class="fa-solid fa-${c.activo?'circle-pause':'circle-play'}"></i></button>`
          }
        </td>
      `;
      tbody.appendChild(tr);
    });
    bindHeaderEvents();
  injectExportBar('table-choferes', 'Choferes');
  } catch (error) {
    console.error('Error al cargar choferes:', error);
  }
}

function verChofer(id) {
  editChofer(id);
  // Poner en modo solo lectura
  const form = document.getElementById('form-chofer');
  if (form) {
    form.querySelectorAll('input,textarea,select').forEach(el => {
      el.readOnly = true;
      el.style.pointerEvents = 'none';
    });
    form.style.pointerEvents = 'none';
    // Pero los botones ojo deben seguir siendo clicables en modo detalle
    form.querySelectorAll('.dz-overlay-eye').forEach(el => el.style.pointerEvents = 'auto');
  }
  document.getElementById('btn-submit-chofer').style.display = 'none';
  _setModalTitle('modal-chofer-title', '<i class="fa-solid fa-id-badge"></i>', 'Detalle Chofer',
    (() => { const c = cachedChoferes.find(x => x.id === id); return c ? (c.apellido ? `${c.apellido}, ${c.nombre||''}` : c.nombre) : ''; })()
  );
}

function editChofer(id) {
  const chofer = cachedChoferes.find(c => c.id === id);
  if (!chofer) return;

  // Asegurar que el form esté en modo editable (por si venía de verChofer)
  const _form = document.getElementById('form-chofer');
  if (_form) {
    _form.style.pointerEvents = '';
    _form.querySelectorAll('input,textarea,select').forEach(el => { el.readOnly = false; el.style.pointerEvents = ''; });
  }
  const _sb = document.getElementById('btn-submit-chofer');
  if (_sb) _sb.style.display = '';

  document.getElementById('ch-id').value = chofer.id;
  document.getElementById('ch-nombre').value = chofer.nombre;
  document.getElementById('ch-telefono').value = chofer.telefono;
  document.getElementById('ch-telegram-chat-id').value = chofer.telegram_chat_id || '';
  document.getElementById('ch-dni').value = chofer.dni || '';
  document.getElementById('ch-cuil').value = chofer.cuil || '';
  document.getElementById('ch-email').value = chofer.email || '';
  document.getElementById('ch-domicilio').value = chofer.domicilio || '';
  document.getElementById('ch-entre-calles').value = chofer.entre_calles || '';
  document.getElementById('ch-cp').value = chofer.codigo_postal || '';
  document.getElementById('ch-modalidad').value = chofer.modalidad ? fmtModalidad(chofer.modalidad) : '';
  
  if (chofer.fecha_nacimiento) {
    document.getElementById('ch-nacimiento').value = chofer.fecha_nacimiento.split('T')[0];
  } else {
    document.getElementById('ch-nacimiento').value = '';
  }
  
  document.getElementById('ch-fiscal').value = chofer.condicion_fiscal_id || '';
  document.getElementById('ch-activo').checked = chofer.activo === 1;
  document.getElementById('ch-wapp2').value         = chofer.telefono_alt1 || '';
  document.getElementById('ch-wapp2-vinculo').value = chofer.telefono_alt1_vinculo || '';
  document.getElementById('ch-wapp3').value         = chofer.telefono_alt2 || '';
  document.getElementById('ch-wapp3-vinculo').value = chofer.telefono_alt2_vinculo || '';
  document.getElementById('ch-liquidacion').value   = chofer.liquidacion || '';

  _setModalTitle('modal-chofer-title', '<i class="fa-solid fa-id-badge"></i>', 'Modificar Chofer',
    chofer.apellido ? `${chofer.apellido}, ${chofer.nombre||''}` : chofer.nombre);
  document.getElementById('btn-submit-chofer').innerText = 'Guardar Cambios';
  document.getElementById('ch-activo-container').style.display = 'flex';

  // Limpiar dropzones completamente antes de cargar el nuevo chofer
  ['ch-prev-dni-frente','ch-prev-dni-dorso','ch-prev-reg-frente','ch-prev-reg-dorso','ch-prev-calif1','ch-prev-calif2'].forEach(id => {
    const el = document.getElementById(id); if (el) { el.src=''; el.style.display='none'; }
  });
  const _dzDefaults = [
    ['ch-drop-dni-frente', 'DNI Frente'],
    ['ch-drop-dni-dorso',  'DNI Dorso'],
    ['ch-drop-reg-frente', 'Registro Frente'],
    ['ch-drop-reg-dorso',  'Registro Dorso'],
    ['ch-drop-calif1',     'Calificación 1'],
    ['ch-drop-calif2',     'Calificación 2'],
  ];
  _dzDefaults.forEach(([dzId, label]) => {
    const dz = document.getElementById(dzId); if (!dz) return;
    dz.classList.remove('has-img');
    const sm = dz.querySelector('.dz-bottom-label'); if (sm) sm.textContent = label;
  });
  ['ch-eye-dni-frente','ch-eye-dni-dorso','ch-eye-reg-frente','ch-eye-reg-dorso','ch-eye-calif1','ch-eye-calif2'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display='none';
  });
  Object.keys(_choferFiles).forEach(k => delete _choferFiles[k]);
  _clearedChoferSlots.clear();
  document.getElementById('ai-chofer-status').textContent = '';
  // Mostrar docs existentes si los hay
  // Cargar imágenes existentes: preview + botón ojo + clase has-img + blob en _choferFiles para OCR
  const _docSlotMap = [
    { url: chofer.dni_frente_url,      prevId: 'ch-prev-dni-frente', dzId: 'ch-drop-dni-frente', eyeId: 'ch-eye-dni-frente', key: 'dni_frente' },
    { url: chofer.dni_dorso_url,       prevId: 'ch-prev-dni-dorso',  dzId: 'ch-drop-dni-dorso',  eyeId: 'ch-eye-dni-dorso',  key: 'dni_dorso' },
    { url: chofer.registro_frente_url, prevId: 'ch-prev-reg-frente', dzId: 'ch-drop-reg-frente', eyeId: 'ch-eye-reg-frente', key: 'reg_frente' },
    { url: chofer.registro_dorso_url,  prevId: 'ch-prev-reg-dorso',  dzId: 'ch-drop-reg-dorso',  eyeId: 'ch-eye-reg-dorso',  key: 'reg_dorso' },
    { url: chofer.calif1_url,          prevId: 'ch-prev-calif1',     dzId: 'ch-drop-calif1',     eyeId: 'ch-eye-calif1',     key: 'calif1' },
    { url: chofer.calif2_url,          prevId: 'ch-prev-calif2',     dzId: 'ch-drop-calif2',     eyeId: 'ch-eye-calif2',     key: 'calif2' },
  ];
  const _cbust = `?t=${Date.now()}`;
  _docSlotMap.forEach(({ url, prevId, dzId, eyeId }) => {
    if (!url) return;
    const p = document.getElementById(prevId); if(p){p.src=url+_cbust;p.style.display='block';}
    const d = document.getElementById(dzId);   if(d) d.classList.add('has-img');
    const e = document.getElementById(eyeId);  if(e) e.style.display='flex';
  });
  // Fetch blobs → _choferFiles para que OCR/IA funcione en modificación
  // Muestra estado de carga y habilita los botones al terminar
  const ocrBtn = document.querySelector('#chofer-docs-toolbar .dz-ocr');
  const aiBtn  = document.getElementById('chofer-btn-ai');
  const status = document.getElementById('ai-chofer-status');
  const urlsToFetch = _docSlotMap.filter(s => s.url);
  if (urlsToFetch.length) {
    if (ocrBtn) ocrBtn.disabled = true;
    if (aiBtn)  aiBtn.disabled  = true;
    if (status) { status.textContent = '⏳ Cargando imágenes…'; status.style.color = ''; }
    Promise.all(urlsToFetch.map(({ url, key }) =>
      fetch(url + _cbust).then(r => r.blob()).then(blob => {
        const file = new File([blob], `${key}.jpg`, { type: blob.type || 'image/jpeg' });
        _choferFiles[key] = file;
        // Intentar leer el código de barras del DNI frente automáticamente al cargar en modo edición
        if (key === 'dni_frente') _tryReadDNIBarcode(file);
      }).catch(() => {})
    )).then(() => {
      if (ocrBtn) ocrBtn.disabled = false;
      if (aiBtn  && _aiAvailable) aiBtn.disabled = false;
      if (status) status.textContent = '✓ Imágenes listas — podés usar OCR o IA';
    });
  }
  if (chofer.registro_categoria)  document.getElementById('ch-reg-categoria').value = chofer.registro_categoria;
  if (chofer.registro_vencimiento) document.getElementById('ch-reg-vencimiento').value = chofer.registro_vencimiento?.split('T')[0] || '';

  // GPS del chofer
  const chLat = document.getElementById('ch-lat'); const chLng = document.getElementById('ch-lng');
  const chGpsStatus = document.getElementById('ch-gps-status');
  const chMapBtn = document.getElementById('ch-map-btn');
  const chMap = document.getElementById('ch-map');
  if (chLat) chLat.value = chofer.lat || '';
  if (chLng) chLng.value = chofer.lng || '';
  if (chofer.lat && chofer.lng) {
    if (chGpsStatus) { chGpsStatus.textContent = `📍 GPS guardado: ${parseFloat(chofer.lat).toFixed(5)}, ${parseFloat(chofer.lng).toFixed(5)}`; chGpsStatus.style.color = 'var(--color-success)'; }
    if (chMapBtn) chMapBtn.style.display = '';
    if (chMap) showInlineMap('ch-map', parseFloat(chofer.lat), parseFloat(chofer.lng), chofer.domicilio || 'Domicilio');
  } else {
    if (chGpsStatus) chGpsStatus.textContent = '';
    if (chMapBtn) chMapBtn.style.display = 'none';
    if (chMap) { chMap.style.display = 'none'; chMap.innerHTML = ''; }
  }

  openModal('modal-chofer');
}

async function saveChofer(e) {
  e.preventDefault();
  
  const id = document.getElementById('ch-id').value;
  const isEdit = id !== '';

  const nombre   = document.getElementById('ch-nombre').value.trim();
  const telefono = document.getElementById('ch-telefono').value.trim();
  if (!nombre)   { showAlert('El Nombre Completo es obligatorio.', 'warning'); document.getElementById('ch-nombre').focus();   return; }
  if (!telefono) { showAlert('El WhatsApp/Celular es obligatorio.', 'warning'); document.getElementById('ch-telefono').focus(); return; }

  const data = {
    nombre: document.getElementById('ch-nombre').value,
    telefono: sanitizePhone(document.getElementById('ch-telefono').value),
    telegram_chat_id: document.getElementById('ch-telegram-chat-id').value.trim() || null,
    dni: document.getElementById('ch-dni').value || null,
    cuil: document.getElementById('ch-cuil').value || null,
    email: document.getElementById('ch-email').value || null,
    domicilio: document.getElementById('ch-domicilio').value || null,
    entre_calles: document.getElementById('ch-entre-calles').value.trim() || null,
    codigo_postal: document.getElementById('ch-cp').value || null,
    lat: document.getElementById('ch-lat').value || null,
    lng: document.getElementById('ch-lng').value || null,
    modalidad: parseModalidad(document.getElementById('ch-modalidad').value) || null,
    fecha_nacimiento: document.getElementById('ch-nacimiento').value || null,
    condicion_fiscal_id: parseInt(document.getElementById('ch-fiscal').value, 10) || null,
    activo: isEdit ? (document.getElementById('ch-activo').checked ? 1 : 0) : 1,
    telefono_alt1:         document.getElementById('ch-wapp2').value.trim() || null,
    telefono_alt1_vinculo: document.getElementById('ch-wapp2-vinculo').value.trim() || null,
    telefono_alt2:         document.getElementById('ch-wapp3').value.trim() || null,
    telefono_alt2_vinculo: document.getElementById('ch-wapp3-vinculo').value.trim() || null,
    liquidacion:           document.getElementById('ch-liquidacion').value || null
  };

  const url = isEdit ? `/api/choferes/${id}` : '/api/choferes';
  const method = isEdit ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      const resData = await res.json();
      const savedId = isEdit ? parseInt(id) : resData.id;
      // Subir archivos de documentos nuevos/modificados/rotados
      if (savedId) {
        const docMap = { dni_frente: 'dni_frente', dni_dorso: 'dni_dorso', reg_frente: 'registro_frente', reg_dorso: 'registro_dorso', calif1: 'calif1', calif2: 'calif2' };
        const fd2 = new FormData();
        let hasDocFiles = false;
        Object.entries(docMap).forEach(([key, fieldName]) => {
          const f = _choferFiles[key];
          if (f instanceof File) { fd2.append(fieldName, f, f.name); hasDocFiles = true; }
        });
        if (hasDocFiles) {
          await fetch(`/api/choferes/${savedId}/upload-docs`, { method: 'POST', body: fd2 });
        }
      }
      // Guardar documentos: nuevas URLs extraídas + borrados explícitos (__CLEAR__)
      const _slotToUrlKey = { dni_frente: '_dni_frente_url', dni_dorso: '_dni_dorso_url', reg_frente: '_registro_frente_url', reg_dorso: '_registro_dorso_url' };
      const _slotToDocField = { dni_frente: 'dni_frente_url', dni_dorso: 'dni_dorso_url', reg_frente: 'registro_frente_url', reg_dorso: 'registro_dorso_url', calif1: 'calif1_url', calif2: 'calif2_url' };
      const hasNewUrls = _choferFiles._dni_frente_url || _choferFiles._dni_dorso_url || _choferFiles._registro_frente_url || _choferFiles._registro_dorso_url;
      if (savedId && (hasNewUrls || _clearedChoferSlots.size > 0)) {
        const docBody = {};
        if (hasNewUrls) {
          if (_choferFiles._dni_frente_url)      docBody.dni_frente_url = _choferFiles._dni_frente_url;
          if (_choferFiles._dni_dorso_url)       docBody.dni_dorso_url = _choferFiles._dni_dorso_url;
          if (_choferFiles._registro_frente_url) docBody.registro_frente_url = _choferFiles._registro_frente_url;
          if (_choferFiles._registro_dorso_url)  docBody.registro_dorso_url = _choferFiles._registro_dorso_url;
        }
        // Slots borrados → mandar __CLEAR__ (solo si no vino una URL nueva para ese mismo slot)
        _clearedChoferSlots.forEach(slot => {
          const docField = _slotToDocField[slot];
          if (docField && !docBody[docField]) docBody[docField] = '__CLEAR__';
        });
        docBody.registro_categoria = document.getElementById('ch-reg-categoria')?.value || null;
        docBody.registro_vencimiento = document.getElementById('ch-reg-vencimiento')?.value || null;
        await fetch(`/api/choferes/${savedId}/documentos`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(docBody)
        });
        delete _choferFiles._dni_frente_url; delete _choferFiles._dni_dorso_url;
        delete _choferFiles._registro_frente_url; delete _choferFiles._registro_dorso_url;
        _clearedChoferSlots.clear();
      }
      showAlert(isEdit ? '¡Chofer actualizado con éxito!' : '¡Chofer registrado con éxito!');
      closeModal('modal-chofer');
      loadChoferes();
      loadChoferesSelect();
      loadStats();
    } else {
      const err = await res.json();
      showAlert(`Error: ${err.message}`);
    }
  } catch (error) {
    showAlert('Fallo al guardar chofer.');
  }
}

async function toggleActivoChofer(id, activo) {
  const chofer = cachedChoferes.find(c => c.id === id);
  if (!chofer) return;
  const accion = activo ? 'desactivar' : 'activar';
  if (!await showConfirm(`¿${activo?'Desactivar':'Activar'} al chofer "${chofer.nombre}"?`)) return;
  try {
    const res = await fetch(`/api/choferes/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...chofer, activo: activo ? 0 : 1 })
    });
    if (res.ok) { showAlert(`Chofer ${accion}do.`, 'success'); loadChoferes(); loadChoferesSelect(); loadStats(); }
    else { const e = await res.json(); showAlert(`Error: ${e.message}`); }
  } catch { showAlert('Error de conexión.', 'error'); }
}

async function deleteChofer(id) {
  const chofer = cachedChoferes.find(c => c.id === id);
  if (!chofer) return;

  if (await showConfirm(`¿Estás seguro de que deseas desactivar al chofer "${chofer.nombre}"? No se eliminarán sus registros históricos.`)) {
    try {
      const res = await fetch(`/api/choferes/${id}`, { method: 'DELETE' });
      if (res.ok) {
        showAlert('Chofer desactivado de forma lógica con éxito.', 'success');
        loadChoferes();
        loadChoferesSelect();
        loadStats();
      } else {
        const err = await res.json();
        showAlert(`Error: ${err.message}`);
      }
    } catch (err) {
      showAlert('Error de conexión.', 'error');
    }
  }
}


// --- CRUD: VEHÍCULOS ---

async function _loadVhPersonaSelect(selectedId = null) {
  const sel = document.getElementById('vh-persona-id');
  if (!sel) return;
  const personas = await fetch('/api/personas').then(r => r.json()).catch(() => []);
  sel.innerHTML = '<option value="">— Sin propietario —</option>' +
    personas.filter(p => p.activo).map(p =>
      `<option value="${p.id}" ${p.id == selectedId ? 'selected' : ''}>` +
      `${p.apellido ? p.apellido + ', ' : ''}${p.nombre}` +
      `${p.dni ? ' · DNI ' + p.dni : ''}` +
      `</option>`
    ).join('');
  SmartCombo.refresh(sel);
  _onVhPersonaChange(sel);
}

function _onVhPersonaChange(sel) {
  const info = document.getElementById('vh-persona-info');
  if (!info) return;
  const opt = sel.options[sel.selectedIndex];
  if (!sel.value || !opt) { info.textContent = ''; return; }
  info.textContent = '👤 ' + opt.text;
}

function openAddVehiculoModal() {
  document.getElementById('form-vehiculo').reset();
  document.getElementById('vh-id').value = '';
  document.getElementById('modal-vehiculo-title').innerText = 'Alta de Vehículo';
  document.getElementById('btn-submit-vehiculo').innerText = 'Registrar';
  const datosBtn = document.querySelector('#modal-vehiculo [data-modal-tab="vh-tab-datos"]');
  if (datosBtn) switchModalTab(datosBtn, 'vh-tab-datos');
  document.getElementById('vh-activo-container').style.display = 'none';
  document.getElementById('vh-fecha-alta').value = new Date().toISOString().split('T')[0];
  document.getElementById('vh-foto-principal').value = '';
  document.getElementById('vh-marca-input').value = '';
  document.getElementById('vh-marca').value = '';
  document.getElementById('vh-modelo-input').value = '';
  document.getElementById('vh-modelo').value = '';
  _cachedModelos = [];
  _loadVhPersonaSelect(null);
  openModal('modal-vehiculo');
}

async function loadVehiculos() {
  try {
    const res = await fetch('/api/vehiculos');
    cachedVehiculos = await res.json();
    const tbody = document.getElementById('vehiculos-table-body');
    tbody.innerHTML = '';

    cachedVehiculos.forEach(v => {
      const respClass = v.telepeaje_responsable === 'chofer' ? 'badge-info' : 'badge-success';
      const tr = document.createElement('tr');
      
      // Calculate document alerts
      const vtvStatus = getVigenciaStatus(v.vtv_hasta);
      const gncStatus = getVigenciaStatus(v.gnc_hasta);
      const seguroStatus = getVigenciaStatus(v.seguro_hasta);
      
      const vtvBadge = `<span class="vigencia-row-badge ${vtvStatus.class}" title="VTV: ${vtvStatus.label}">VTV: ${vtvStatus.label}</span>`;
      const gncBadge = `<span class="vigencia-row-badge ${gncStatus.class}" title="GNC: ${gncStatus.label}">GNC: ${gncStatus.label}</span>`;
      const seguroBadge = `<span class="vigencia-row-badge ${seguroStatus.class}" title="Seguro: ${seguroStatus.label}">Seg: ${v.seguro_compania || ''} ${seguroStatus.label}</span>`;
      
      // Active status alta/baja string
      const activeBadge = `<span class="badge ${v.activo ? 'badge-success' : 'badge-danger'}" style="font-size:10px; padding:2px 4px;">${v.activo ? 'activo' : 'inactivo'}</span>`;
      const datesInfo = `<small class="text-secondary" style="font-size:11px;">Alta: ${formatDate(v.fecha_alta)}${v.fecha_baja ? `<br>Baja: ${formatDate(v.fecha_baja)}` : ''}</small>`;

      // Propietario: persona vinculada o titular DNRPA como fallback
      const propietario = v.persona_apellido
        ? `${v.persona_apellido}, ${v.persona_nombre}` + (v.persona_dni ? `<br><small style="opacity:.6;">DNI ${v.persona_dni}</small>` : '')
        : v.titular_nombre
          ? `<small style="opacity:.75;">${v.titular_nombre}</small>` + (v.titular_dni ? `<br><small style="opacity:.5;">DNI ${v.titular_dni}</small>` : '')
          : '<span style="opacity:.35;">—</span>';

      tr.innerHTML = `
        <td>
          <strong>${v.patente}</strong>
        </td>
        <td>${propietario}</td>
        <td>
          ${v.marca || '-'} ${v.modelo || '-'}<br>
          <small class="text-secondary">Chasis: ${v.nro_chasis || '-'}</small>
        </td>
        <td>
          <div class="vigencias-badges-container">
            ${vtvBadge}
            ${gncBadge}
            ${seguroBadge}
          </div>
        </td>
        <td>${v.color || '-'}</td>
        <td>
          Motor: <code>${v.nro_motor || '-'}</code>
        </td>
        <td>
          <code>${v.telepeaje_tag || '-'}</code><br>
          <span class="badge ${respClass}" style="font-size: 10px;">${v.telepeaje_responsable}</span>
        </td>
        <td>
          ${activeBadge}
        </td>
        <td style="text-align:center;white-space:nowrap;">
          <button class="tbl-action-btn tbl-btn-view"   onclick="openVehiculoDetalleModal(${v.id})" title="Ver Historial / Documentación / Services"><i class="fa-solid fa-eye"></i></button>
          <button class="tbl-action-btn tbl-btn-edit"   onclick="editVehiculo(${v.id})"             title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
          ${canDelete()
            ? `<button class="tbl-action-btn tbl-btn-delete" onclick="deleteVehiculo(${v.id})"     title="Eliminar"><i class="fa-solid fa-trash"></i></button>`
            : `<button class="tbl-action-btn tbl-btn-toggle-${v.activo?'off':'on'}" onclick="toggleActivoVehiculo(${v.id},${v.activo})" title="${v.activo?'Dar de baja':'Reactivar'}"><i class="fa-solid fa-${v.activo?'circle-pause':'circle-play'}"></i></button>`
          }
        </td>
      `;
      tbody.appendChild(tr);
    });
    
    // Bind double-click events for table headers
    bindHeaderEvents();
  injectExportBar('table-vehiculos-gestion', 'Vehículos');
  } catch (error) {
    console.error('Error al cargar vehículos:', error);
  }
}

async function abrirVehiculoDesdePersona(vid) {
  // Si el vehículo no está en el cache global (contexto de propietarios), lo cargamos
  if (!cachedVehiculos.find(x => x.id === vid)) {
    const fresh = await fetch('/api/vehiculos').then(r => r.json()).catch(() => []);
    if (fresh.length) cachedVehiculos = fresh;
  }
  // Abrir el modal de vehículo encima del de propietario (sin cerrarlo)
  editVehiculo(vid);
}

async function editVehiculo(id) {
  const v = cachedVehiculos.find(x => x.id === id);
  if (!v) return;

  document.getElementById('vh-id').value = v.id;
  document.getElementById('vh-patente').value = v.patente;
  document.getElementById('vh-color').value = v.color || '';
  document.getElementById('vh-año').value = v.año || '';
  document.getElementById('vh-motor').value = v.nro_motor || '';
  document.getElementById('vh-chasis').value = v.nro_chasis || '';
  document.getElementById('vh-tag').value = v.telepeaje_tag || '';
  document.getElementById('vh-tag-responsable').value = v.telepeaje_responsable;
  document.getElementById('vh-activo').checked = v.activo === 1;
  
  if (v.fecha_alta) {
    document.getElementById('vh-fecha-alta').value = v.fecha_alta.split('T')[0];
  } else {
    document.getElementById('vh-fecha-alta').value = '';
  }
  
  if (v.fecha_baja) {
    document.getElementById('vh-fecha-baja').value = v.fecha_baja.split('T')[0];
  } else {
    document.getElementById('vh-fecha-baja').value = '';
  }
  
  document.getElementById('vh-motivo-baja').value = v.motivo_baja || '';
  document.getElementById('vh-foto-principal').value = v.foto_principal || '';

  // Marca y Modelo searchable
  let matchedMarcaId = v.marca_id;
  if (!matchedMarcaId && v.marca) {
    const brandObj = cachedMarcas.find(m => m.nombre.toUpperCase() === v.marca.toUpperCase());
    if (brandObj) matchedMarcaId = brandObj.id;
  }
  if (matchedMarcaId) {
    const marcaObj = cachedMarcas.find(m => m.id === matchedMarcaId);
    document.getElementById('vh-marca-input').value = marcaObj?.nombre || '';
    document.getElementById('vh-marca').value = matchedMarcaId;
    await loadModelosForMarca(matchedMarcaId, v.modelo_id);
  } else {
    document.getElementById('vh-marca-input').value = '';
    document.getElementById('vh-marca').value = '';
    document.getElementById('vh-modelo-input').value = '';
    document.getElementById('vh-modelo').value = '';
  }

  // Datos del titular DNRPA
  document.getElementById('vh-titular-nombre').value = v.titular_nombre || '';
  document.getElementById('vh-titular-dni').value = v.titular_dni || '';
  document.getElementById('vh-titular-domicilio').value = v.titular_domicilio || '';
  document.getElementById('vh-titular-cp').value = v.titular_codigo_postal || '';
  document.getElementById('vh-titular-lat').value = v.titular_lat || '';
  document.getElementById('vh-titular-lng').value = v.titular_lng || '';
  const vhGpsSt = document.getElementById('vh-titular-gps-status');
  const vhMapBtn = document.getElementById('vh-titular-map-btn');
  if (v.titular_lat && v.titular_lng) {
    if (vhGpsSt) { vhGpsSt.textContent = `📍 ${parseFloat(v.titular_lat).toFixed(5)}, ${parseFloat(v.titular_lng).toFixed(5)}`; vhGpsSt.style.color = 'var(--color-success)'; }
    if (vhMapBtn) vhMapBtn.style.display = '';
    showInlineMap('vh-titular-map', parseFloat(v.titular_lat), parseFloat(v.titular_lng), v.titular_domicilio);
  } else {
    if (vhGpsSt) vhGpsSt.textContent = '';
    if (vhMapBtn) vhMapBtn.style.display = 'none';
  }
  document.getElementById('vh-titular-cuit').value = v.titular_cuit || '';
  document.getElementById('vh-titular-email').value = v.titular_email || '';
  document.getElementById('vh-titular-celular').value = v.titular_celular || '';

  _setModalTitle('modal-vehiculo-title', '<i class="fa-solid fa-car"></i>', 'Modificar Vehículo',
    [v.patente, [v.marca, v.modelo].filter(Boolean).join(' ')].filter(Boolean).join(' · '));
  document.getElementById('btn-submit-vehiculo').innerText = 'Guardar Cambios';
  document.getElementById('vh-activo-container').style.display = 'flex';

  // Limpiar dropzones de imágenes y cargar las del vehículo actual
  const imgSlots = [
    { dzId: 'cedula-dropzone-frente', prevId: 'cedula-preview-frente', eyeId: 'vh-eye-ced-frente',    key: 'cedula_frente_url' },
    { dzId: 'cedula-dropzone-dorso',  prevId: 'cedula-preview-dorso',  eyeId: 'vh-eye-ced-dorso',     key: 'cedula_dorso_url'  },
    { dzId: 'foto-drop-frente',       prevId: 'foto-preview-frente',   eyeId: 'vh-eye-foto-frente',   key: 'foto_frente_url'   },
    { dzId: 'foto-drop-lat-der',      prevId: 'foto-preview-lat-der',  eyeId: 'vh-eye-foto-lat-der',  key: 'foto_lat_der_url'  },
    { dzId: 'foto-drop-lat-izq',      prevId: 'foto-preview-lat-izq',  eyeId: 'vh-eye-foto-lat-izq',  key: 'foto_lat_izq_url'  },
    { dzId: 'foto-drop-detras',       prevId: 'foto-preview-detras',   eyeId: 'vh-eye-foto-detras',   key: 'foto_detras_url'   },
  ];
  // Limpiar pendingFiles de vehículo
  ['cedula_frente','cedula_dorso','foto_frente','foto_lat_der','foto_lat_izq','foto_detras'].forEach(k => { if (_pendingFiles) delete _pendingFiles[k]; });
  imgSlots.forEach(({ dzId, prevId, eyeId, key }) => {
    const dz   = document.getElementById(dzId);
    const prev = document.getElementById(prevId);
    const eye  = document.getElementById(eyeId);
    const url  = v[key];
    if (prev) { prev.src = url ? url + '?t=' + Date.now() : ''; prev.style.display = url ? 'block' : 'none'; }
    if (dz)   { url ? dz.classList.add('has-img') : dz.classList.remove('has-img'); }
    if (eye)  { eye.style.display = url ? 'flex' : 'none'; }
  });

  // Propietario vinculado
  _loadVhPersonaSelect(v.persona_id || null);

  // Resetear a tab Datos
  const datosBtn = document.querySelector('#modal-vehiculo [data-modal-tab="vh-tab-datos"]');
  if (datosBtn) switchModalTab(datosBtn, 'vh-tab-datos');

  openModal('modal-vehiculo');
}

async function saveVehiculo(e) {
  e.preventDefault();

  const id = document.getElementById('vh-id').value;
  const isEdit = id !== '';

  const data = {
    patente: document.getElementById('vh-patente').value,
    color: document.getElementById('vh-color').value || null,
    año: parseInt(document.getElementById('vh-año').value, 10) || null,
    nro_motor: document.getElementById('vh-motor').value || null,
    nro_chasis: document.getElementById('vh-chasis').value || null,
    telepeaje_tag: document.getElementById('vh-tag').value || null,
    telepeaje_responsable: document.getElementById('vh-tag-responsable').value,
    modelo_id: parseInt(document.getElementById('vh-modelo').value, 10) || null,
    fecha_alta: document.getElementById('vh-fecha-alta').value || null,
    fecha_baja: document.getElementById('vh-fecha-baja').value || null,
    motivo_baja: document.getElementById('vh-motivo-baja').value || null,
    foto_principal: document.getElementById('vh-foto-principal').value || null,
    activo: isEdit ? (document.getElementById('vh-activo').checked ? 1 : 0) : 1,
    // Datos titular DNRPA
    titular_nombre: document.getElementById('vh-titular-nombre').value || null,
    titular_dni: document.getElementById('vh-titular-dni').value || null,
    titular_domicilio: document.getElementById('vh-titular-domicilio').value || null,
    titular_codigo_postal: document.getElementById('vh-titular-cp').value || null,
    titular_lat: document.getElementById('vh-titular-lat').value || null,
    titular_lng: document.getElementById('vh-titular-lng').value || null,
    titular_cuit: document.getElementById('vh-titular-cuit').value || null,
    titular_email: document.getElementById('vh-titular-email').value || null,
    titular_celular: sanitizePhone(document.getElementById('vh-titular-celular').value),
    persona_id: document.getElementById('vh-persona-id')?.value || null,
  };

  const url = isEdit ? `/api/vehiculos/${id}` : '/api/vehiculos';
  const method = isEdit ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      const responseData = await res.json();
      const savedId = isEdit ? parseInt(id) : responseData.id;
      if (savedId) {
        await uploadVehiculoFiles(savedId);
        await saveContactosAlternativos(savedId);
      }
      showAlert(isEdit ? '¡Vehículo modificado con éxito!' : '¡Vehículo registrado con éxito!');
      closeModal('modal-vehiculo');
      loadVehiculos();
      loadDashboardVehicles();
      loadStats();
    } else {
      const err = await res.json();
      showAlert(`Error: ${err.message}`);
    }
  } catch (error) {
    showAlert('Fallo al guardar vehículo.');
  }
}

async function deleteVehiculo(id) {
  const v = cachedVehiculos.find(x => x.id === id);
  if (!v) return;

  const motivo = prompt('Por favor, ingrese el motivo de desactivación / baja del vehículo:', 'Baja por renovación de unidad');
  if (motivo === null) return; // Cancelled prompt

  try {
    const res = await fetch(`/api/vehiculos/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motivo_baja: motivo })
    });
    const reply = await res.json();
    showAlert(reply.message);
    loadVehiculos();
    loadDashboardVehicles();
    loadStats();
  } catch (err) {
    showAlert('Error al desactivar vehículo.', 'error', 'error');
  }
}

async function toggleActivoVehiculo(id, activo) {
  const label = activo ? 'desactivar' : 'activar';
  if (!await showConfirm(`¿${activo?'Desactivar':'Activar'} este vehículo?`)) return;
  const res = await fetch(`/api/vehiculos/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activo: activo ? 0 : 1 })
  });
  if (res.ok) { showAlert(`Vehículo ${label}do.`, 'success'); loadVehiculos(); loadStats(); }
  else { const e = await res.json(); showAlert(`Error: ${e.message}`); }
}


// --- CRUD: ASEGURADORAS ---

let cachedAseguradorasFull = [];   // lista completa con todos los campos
let _asegContactosTmp = [];        // contactos del modal actual (pendientes de guardar)
let _asegContactosExisting = [];   // contactos ya guardados en la BD

function openAddAseguradoraModal() {
  document.getElementById('form-aseguradora').reset();
  document.getElementById('aseg-id').value = '';
  document.getElementById('modal-aseguradora-title').innerText = 'Nueva Aseguradora';
  document.getElementById('btn-submit-aseguradora').innerText = 'Guardar';
  _asegContactosTmp = [];
  _asegContactosExisting = [];
  _renderAsegContactos();
  // Resetear a tab Datos
  const datosBtn = document.querySelector('#modal-aseguradora .modal-tab-btn');
  if (datosBtn) switchModalTab(datosBtn, 'aseg-tab-datos');
  openModal('modal-aseguradora');
}

async function editAseguradora(id) {
  try {
    const res = await fetch(`/api/aseguradoras/${id}`);
    const d = await res.json();
    document.getElementById('aseg-id').value = d.id;
    document.getElementById('aseg-nombre').value   = d.nombre   || '';
    document.getElementById('aseg-cuit').value     = d.cuit     || '';
    document.getElementById('aseg-telefono').value = d.telefono || '';
    document.getElementById('aseg-email').value    = d.email    || '';
    document.getElementById('aseg-web').value      = d.web      || '';
    document.getElementById('aseg-domicilio').value = d.domicilio || '';
    document.getElementById('aseg-entre-calles').value = d.entre_calles || '';
    document.getElementById('aseg-cp').value        = d.codigo_postal || '';
    document.getElementById('aseg-lat').value       = d.lat || '';
    document.getElementById('aseg-lng').value       = d.lng || '';
    const asegGpsSt = document.getElementById('aseg-gps-status');
    const asegMapBtn = document.getElementById('aseg-map-btn');
    if (d.lat && d.lng) {
      if (asegGpsSt) { asegGpsSt.textContent = `📍 ${parseFloat(d.lat).toFixed(5)}, ${parseFloat(d.lng).toFixed(5)}`; asegGpsSt.style.color = 'var(--color-success)'; }
      if (asegMapBtn) asegMapBtn.style.display = '';
      showInlineMap('aseg-map', parseFloat(d.lat), parseFloat(d.lng), d.domicilio);
    } else {
      if (asegGpsSt) asegGpsSt.textContent = '';
      if (asegMapBtn) asegMapBtn.style.display = 'none';
    }
    document.getElementById('aseg-notas').value    = d.notas    || '';
    document.getElementById('modal-aseguradora-title').innerText = 'Editar Aseguradora';
    document.getElementById('btn-submit-aseguradora').innerText = 'Guardar Cambios';
    _asegContactosTmp = [];
    _asegContactosExisting = d.contactos || [];
    _renderAsegContactos();
    const datosBtn = document.querySelector('#modal-aseguradora .modal-tab-btn');
    if (datosBtn) switchModalTab(datosBtn, 'aseg-tab-datos');
    openModal('modal-aseguradora');
  } catch(e) { showToast('Error al cargar aseguradora', 'error'); }
}

async function saveAseguradora(e) {
  e.preventDefault();
  const id = document.getElementById('aseg-id').value;
  const body = {
    nombre:    document.getElementById('aseg-nombre').value.trim(),
    cuit:      document.getElementById('aseg-cuit').value.trim(),
    telefono:  sanitizePhone(document.getElementById('aseg-telefono').value),
    email:     document.getElementById('aseg-email').value.trim(),
    web:       document.getElementById('aseg-web').value.trim(),
    domicilio: document.getElementById('aseg-domicilio').value.trim(),
    entre_calles: document.getElementById('aseg-entre-calles').value.trim() || null,
    codigo_postal: document.getElementById('aseg-cp').value.trim() || null,
    lat: document.getElementById('aseg-lat').value || null,
    lng: document.getElementById('aseg-lng').value || null,
    notas:     document.getElementById('aseg-notas').value.trim(),
  };
  try {
    let asegId = id;
    if (id) {
      const r = await fetch(`/api/aseguradoras/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if (!r.ok) { const e = await r.json(); throw new Error(e.message); }
    } else {
      const r = await fetch('/api/aseguradoras', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if (!r.ok) { const e = await r.json(); throw new Error(e.message); }
      const d = await r.json();
      asegId = d.id;
    }
    // Guardar contactos nuevos (temporales)
    for (const ct of _asegContactosTmp) {
      await fetch(`/api/aseguradoras/${asegId}/contactos`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(ct) });
    }
    closeModal('modal-aseguradora');
    showToast(id ? 'Aseguradora actualizada' : 'Aseguradora creada', 'success');
    loadAseguradoras();
    loadAseguradorasSelect();  // refrescar dropdown en modal Seguro
  } catch(err) { showToast(err.message, 'error'); }
}

async function deleteAseguradora(id) {
  const ok = await showConfirm('¿Eliminar esta aseguradora?');
  if (!ok) return;
  try {
    const r = await fetch(`/api/aseguradoras/${id}`, { method:'DELETE' });
    const d = await r.json();
    if (!r.ok) { showToast(d.message, 'error'); return; }
    showToast('Aseguradora eliminada', 'success');
    loadAseguradoras();
    loadAseguradorasSelect();
  } catch(e) { showToast('Error al eliminar', 'error'); }
}

async function loadAseguradoras() {
  try {
    const res = await fetch('/api/aseguradoras');
    cachedAseguradorasFull = await res.json();
    const tbody = document.getElementById('aseguradoras-tbody');
    if (!tbody) return;
    if (!cachedAseguradorasFull.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-secondary);">Sin aseguradoras registradas</td></tr>';
      return;
    }
    tbody.innerHTML = cachedAseguradorasFull.map(a => `
      <tr>
        <td><strong>${a.nombre}</strong></td>
        <td>${a.cuit || '-'}</td>
        <td>${a.telefono || '-'}</td>
        <td>${a.email ? `<a href="mailto:${a.email}" style="color:var(--accent-purple)">${a.email}</a>` : '-'}</td>
        <td>${a.web ? `<a href="${a.web}" target="_blank" style="color:var(--accent-blue);font-size:12px;">${a.web.replace(/^https?:\/\//,'')}</a>` : '-'}</td>
        <td><span class="badge" style="background:var(--bg-tertiary);" id="aseg-ct-count-${a.id}">...</span></td>
        <td style="text-align:center;white-space:nowrap;">
          <button class="tbl-action-btn tbl-btn-view"   onclick="editAseguradora(${a.id})"   title="Ver"><i class="fa-solid fa-eye"></i></button>
          <button class="tbl-action-btn tbl-btn-edit"   onclick="editAseguradora(${a.id})"   title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
          <button class="tbl-action-btn tbl-btn-delete" onclick="deleteAseguradora(${a.id})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>`).join('');
    // Contar contactos async
    cachedAseguradorasFull.forEach(async a => {
      const r = await fetch(`/api/aseguradoras/${a.id}/contactos`);
      const cts = await r.json();
      const el = document.getElementById(`aseg-ct-count-${a.id}`);
      if (el) el.textContent = cts.length ? `${cts.length} contacto${cts.length>1?'s':''}` : 'Sin contactos';
    });
    injectExportBar('table-aseguradoras','Aseguradoras');
  } catch(e) { console.error('Error loadAseguradoras', e); }
}

// ── Contactos temporales (antes de guardar la aseguradora) ──
function addAsegContacto() {
  const nombre = document.getElementById('aseg-ct-nombre').value.trim();
  if (!nombre) { showToast('Ingresá el nombre del contacto', 'warning'); return; }
  const ct = {
    nombre,
    cargo:    document.getElementById('aseg-ct-cargo').value.trim(),
    telefono: document.getElementById('aseg-ct-telefono').value.trim(),
    celular:  document.getElementById('aseg-ct-celular').value.trim(),
    email:    document.getElementById('aseg-ct-email').value.trim(),
  };
  const asegId = document.getElementById('aseg-id').value;
  if (asegId) {
    // Ya existe la aseguradora → guardar directo
    fetch(`/api/aseguradoras/${asegId}/contactos`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(ct) })
      .then(r => r.json())
      .then(d => {
        _asegContactosExisting.push({ ...ct, id: d.id });
        _clearAsegCtForm();
        _renderAsegContactos();
        showToast('Contacto agregado', 'success');
      }).catch(() => showToast('Error al guardar contacto', 'error'));
  } else {
    // Nueva aseguradora → pendiente
    _asegContactosTmp.push(ct);
    _clearAsegCtForm();
    _renderAsegContactos();
  }
}

async function deleteAsegContacto(ctId, isTmp) {
  if (isTmp !== undefined) {
    _asegContactosTmp.splice(isTmp, 1);
    _renderAsegContactos();
    return;
  }
  const asegId = document.getElementById('aseg-id').value;
  await fetch(`/api/aseguradoras/${asegId}/contactos/${ctId}`, { method:'DELETE' });
  _asegContactosExisting = _asegContactosExisting.filter(c => c.id !== ctId);
  _renderAsegContactos();
  showToast('Contacto eliminado', 'success');
}

function _clearAsegCtForm() {
  ['aseg-ct-nombre','aseg-ct-cargo','aseg-ct-telefono','aseg-ct-celular','aseg-ct-email'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
}

function _renderAsegContactos() {
  const container = document.getElementById('aseg-contactos-list');
  if (!container) return;
  const all = [..._asegContactosExisting.map(c => ({...c, existing:true})), ..._asegContactosTmp.map((c,i) => ({...c, tmpIdx:i}))];
  document.getElementById('aseg-contactos-empty').style.display = all.length ? 'none' : '';
  // Limpiar cards anteriores
  container.querySelectorAll('.aseg-ct-card').forEach(el => el.remove());
  all.forEach(ct => {
    const card = document.createElement('div');
    card.className = 'aseg-ct-card';
    card.style.cssText = 'background:var(--bg-tertiary);border-radius:10px;padding:12px 14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px;';
    const delFn = ct.existing ? `deleteAsegContacto(${ct.id})` : `deleteAsegContacto(null,${ct.tmpIdx})`;
    card.innerHTML = `
      <div style="flex:1;line-height:1.7;font-size:13px;">
        <strong>${ct.nombre}</strong>${ct.cargo ? ` <span style="color:var(--text-secondary);font-size:12px;">· ${ct.cargo}</span>` : ''}
        ${ct.telefono ? `<br><i class="fa-solid fa-phone" style="width:14px;color:var(--accent-purple);"></i> ${ct.telefono}` : ''}
        ${ct.celular  ? `<br><i class="fa-solid fa-mobile" style="width:14px;color:var(--accent-purple);"></i> ${ct.celular}` : ''}
        ${ct.email    ? `<br><i class="fa-solid fa-envelope" style="width:14px;color:var(--accent-purple);"></i> <a href="mailto:${ct.email}" style="color:var(--accent-blue);">${ct.email}</a>` : ''}
        ${!ct.existing ? '<br><span style="font-size:11px;color:var(--accent-orange);">⏳ Se guarda junto a la aseguradora</span>' : ''}
      </div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="${delFn}" title="Eliminar" style="padding:4px 8px;color:var(--accent-red);flex-shrink:0;">
        <i class="fa-solid fa-trash"></i>
      </button>`;
    container.appendChild(card);
  });
}

// ── CRUD: TARJETAS ────────────────────────────────────────────────────────
let _cachedTarjetas = [];

async function openTarjetas() {
  await Promise.all([loadTarjetas(), _loadBancos()]);
  openModal('modal-tarjetas');
}

async function loadTarjetas() {
  _cachedTarjetas = await fetch('/api/tarjetas').then(r => r.json()).catch(() => []);
  const tbody = document.getElementById('tarjetas-tbody');
  if (!tbody) return;
  if (!_cachedTarjetas.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:.5;padding:24px;">Sin tarjetas registradas</td></tr>';
    return;
  }
  tbody.innerHTML = _cachedTarjetas.map(t => `
    <tr>
      <td>${t.persona_nombre?.trim() || '<span style="opacity:.4">—</span>'}</td>
      <td>${t.banco_emoji ? t.banco_emoji + ' ' : ''}${t.banco_nombre || '—'}</td>
      <td><span style="display:inline-flex;align-items:center;gap:5px;">${_tarjetaMarcaIcon(t.marca)} ${t.marca}</span></td>
      <td style="font-family:monospace;letter-spacing:1px;">${t.nro_mascara || (t.ultimos_4 ? `•••• •••• •••• ${t.ultimos_4}` : '—')}</td>
      <td style="text-align:center;white-space:nowrap;">
        <button class="tbl-action-btn tbl-btn-edit"   onclick="editTarjeta(${t.id})" title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
        ${canDelete() ? `<button class="tbl-action-btn tbl-btn-delete" onclick="deleteTarjeta(${t.id})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>` : ''}
      </td>
    </tr>`).join('');
  injectExportBar('table-tarjetas', 'Tarjetas');
}

function _tarjetaMarcaIcon(marca) {
  const m = (marca || '').toLowerCase();
  if (m.includes('visa'))       return '<i class="fa-brands fa-cc-visa"       style="color:#1a1f71;font-size:16px;"></i>';
  if (m.includes('master'))     return '<i class="fa-brands fa-cc-mastercard" style="color:#eb001b;font-size:16px;"></i>';
  if (m.includes('amex')||m.includes('american')) return '<i class="fa-brands fa-cc-amex" style="color:#007bc1;font-size:16px;"></i>';
  if (m.includes('diners'))     return '<i class="fa-brands fa-cc-diners-club" style="color:#004a97;font-size:16px;"></i>';
  if (m.includes('discover'))   return '<i class="fa-brands fa-cc-discover"   style="color:#f76f20;font-size:16px;"></i>';
  return '<i class="fa-solid fa-credit-card" style="color:var(--accent-purple);font-size:14px;"></i>';
}

async function openAddTarjetaForm() {
  document.getElementById('tarjeta-id').value = '';
  document.getElementById('tarjeta-marca').value = '';
  document.getElementById('tarjeta-ultimos4').value = '';
  const nroEl = document.getElementById('tarjeta-nro');
  if (nroEl) { nroEl.value = ''; nroEl.type = 'password'; }
  const eyeI = document.querySelector('#tarjeta-nro-eye i');
  if (eyeI) eyeI.className = 'fa-solid fa-eye';
  _poblarBancosEnTarjetaSelect();
  const bSel = document.getElementById('tarjeta-banco-id');
  if (bSel?._ssSet) bSel._ssSet(''); else if (bSel) bSel.value = '';
  await _loadTarjetaPersonaSelect(null);
  document.getElementById('tarjeta-form-wrap').style.display = '';
}

function editTarjeta(id) {
  const t = _cachedTarjetas.find(x => x.id === id);
  if (!t) return;
  document.getElementById('tarjeta-id').value        = t.id;
  document.getElementById('tarjeta-marca').value     = t.marca || '';
  document.getElementById('tarjeta-ultimos4').value  = t.ultimos_4 || '';
  // Campo número: mostrar placeholder con últimos 4 si hay número guardado
  const nroEl = document.getElementById('tarjeta-nro');
  if (nroEl) {
    nroEl.value = '';
    nroEl.type  = 'password';
    nroEl.placeholder = t.tiene_nro
      ? `•••• •••• •••• ${t.ultimos_4 || '••••'}  (dejar vacío para conservar)`
      : '•••• •••• •••• ••••';
  }
  const eyeI = document.querySelector('#tarjeta-nro-eye i');
  if (eyeI) eyeI.className = 'fa-solid fa-eye';
  _poblarBancosEnTarjetaSelect();
  const bSel = document.getElementById('tarjeta-banco-id');
  if (bSel?._ssSet) bSel._ssSet(t.banco_id || ''); else if (bSel) bSel.value = t.banco_id || '';
  _loadTarjetaPersonaSelect(t.persona_id);
  document.getElementById('tarjeta-form-wrap').style.display = '';
}

function toggleCardNroVisibility() {
  const inp = document.getElementById('tarjeta-nro');
  const ico = document.querySelector('#tarjeta-nro-eye i');
  if (!inp) return;
  if (inp.type === 'password') {
    // Si estamos en edición y el campo está vacío, pedir el número al servidor
    const tid = document.getElementById('tarjeta-id').value;
    const t   = tid ? _cachedTarjetas.find(x => x.id == tid) : null;
    if (tid && t?.tiene_nro && !inp.value) {
      fetch(`/api/tarjetas/${tid}/numero`).then(r => r.json()).then(d => {
        if (d.nro) { inp.value = formatCardDisplay(d.nro); inp.type = 'text'; if (ico) ico.className = 'fa-solid fa-eye-slash'; }
        else showToast('No se pudo descifrar el número', 'error');
      }).catch(() => showToast('Error al obtener número', 'error'));
      return;
    }
    inp.type = 'text';
    if (ico) ico.className = 'fa-solid fa-eye-slash';
  } else {
    inp.type = 'password';
    if (ico) ico.className = 'fa-solid fa-eye';
  }
}

function formatCardDisplay(digits) {
  const d = digits.replace(/\D/g, '');
  return d.match(/.{1,4}/g)?.join(' ') || d;
}

function formatCardInput(el) {
  const start = el.selectionStart;
  const oldVal = el.value;
  const raw = oldVal.replace(/\D/g, '').slice(0, 16);
  const fmt = raw.match(/.{1,4}/g)?.join(' ') || raw;
  if (el.value === fmt) return;
  el.value = fmt;
  // calcular cuántos dígitos había antes del cursor en el valor anterior
  const digitsBeforeCursor = oldVal.slice(0, start).replace(/\D/g, '').length;
  // encontrar la posición en el nuevo valor formateado correspondiente a esos dígitos
  let newPos = 0, digits = 0;
  for (let i = 0; i < fmt.length; i++) {
    if (digits === digitsBeforeCursor) { newPos = i; break; }
    if (fmt[i] !== ' ') digits++;
    newPos = i + 1;
  }
  try { el.setSelectionRange(newPos, newPos); } catch {}
}

function _poblarBancosEnTarjetaSelect() {
  const sel = document.getElementById('tarjeta-banco-id');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Sin especificar —</option>';
  _cachedBancos.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = `${b.logo_emoji || ''} ${b.nombre}`;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

function closeTarjetaForm() {
  document.getElementById('tarjeta-form-wrap').style.display = 'none';
}

async function _loadTarjetaPersonaSelect(selectedId) {
  const sel = document.getElementById('tarjeta-persona-id');
  if (!sel) return;
  const personas = await fetch('/api/personas').then(r => r.json()).catch(() => []);
  sel.innerHTML = '<option value="">— Sin propietario —</option>' +
    personas.filter(p => p.activo).map(p =>
      `<option value="${p.id}" ${p.id == selectedId ? 'selected' : ''}>${p.apellido ? p.apellido+', ' : ''}${p.nombre}</option>`
    ).join('');
}

async function saveTarjeta() {
  const id    = document.getElementById('tarjeta-id').value;
  const marca = document.getElementById('tarjeta-marca').value;
  if (!marca) { showToast('Seleccioná la marca de la tarjeta', 'error'); return; }
  const nroRaw = (document.getElementById('tarjeta-nro')?.value || '').replace(/\D/g, '');
  const data = {
    persona_id:   document.getElementById('tarjeta-persona-id').value || null,
    banco_id:     parseInt(document.getElementById('tarjeta-banco-id').value) || null,
    marca,
    nro_tarjeta:  nroRaw || (id ? undefined : null), // en edición: undefined = conservar
  };
  const url    = id ? `/api/tarjetas/${id}` : '/api/tarjetas';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (res.ok) { closeTarjetaForm(); loadTarjetas(); showToast(id ? 'Tarjeta actualizada' : 'Tarjeta registrada'); }
  else { const e = await res.json(); showToast(e.message, 'error'); }
}

async function deleteTarjeta(id) {
  if (!await showConfirm('¿Eliminar esta tarjeta?')) return;
  const res = await fetch(`/api/tarjetas/${id}`, { method: 'DELETE' });
  if (res.ok) loadTarjetas();
  else { const e = await res.json(); showToast(e.message, 'error'); }
}

// ── Service: grilla multi-pago ────────────────────────────────────────────
let _svcPagos = []; // [{medio, monto, cuenta_id, tarjeta_id, cuotas, notas, comprobante_url, _file}]
let _svcPagoDzs = [];

function _svcPagosUpdateSummary() {
  const costo = getAmt('svc-costo');
  const total = _svcPagos.reduce((s, p) => s + (parseFloat(p.monto) || 0), 0);
  const saldo = costo - total;
  const fmt = v => formatCurrency(Math.abs(v));
  const costoEl  = document.getElementById('svc-pagos-costo-ref');
  const totalEl  = document.getElementById('svc-pagos-total');
  const saldoEl  = document.getElementById('svc-pagos-saldo');
  if (costoEl) costoEl.textContent  = fmt(costo);
  if (totalEl) totalEl.textContent  = fmt(total);
  if (saldoEl) {
    saldoEl.textContent = (saldo < 0 ? '- ' : '') + fmt(saldo);
    saldoEl.style.color = saldo <= 0.01 ? 'var(--color-success)' : 'var(--color-error)';
  }
}

function addSvcPagoRow(preset = {}) {
  // Autocompletar con el saldo pendiente si no se especifica monto
  let montoAuto = preset.monto || '';
  if (!montoAuto) {
    const costo  = getAmt('svc-costo') || 0;
    const pagado = _svcPagos.reduce((s, p) => s + (parseFloat(p.monto) || 0), 0);
    const saldo  = costo - pagado;
    if (saldo > 0) montoAuto = String(saldo);
  }
  _svcPagos.push({ medio: preset.medio || 'efectivo', monto: montoAuto, cuenta_id: preset.cuenta_id || '', tarjeta_id: preset.tarjeta_id || '', cuotas: preset.cuotas || 1, notas: preset.notas || '', comprobante_url: preset.comprobante_url || '', _file: null });
  renderSvcPagos();
}

function removeSvcPagoRow(i) {
  _svcPagos.splice(i, 1);
  renderSvcPagos();
}

function renderSvcPagos() {
  const grid = document.getElementById('svc-pagos-grid');
  if (!grid) return;

  const cuentasOpts = (_cachedCuentas || []).map(c =>
    `<option value="${c.id}">${c.alias}${c.banco_nombre ? ' · ' + c.banco_nombre : ''}</option>`).join('');

  const tarjetasOpts = (_cachedTarjetas || []).map(t =>
    `<option value="${t.id}">${_tarjetaMarcaLabel(t)} ${t.ultimos_4 ? '••'+t.ultimos_4 : ''}${t.banco_nombre ? ' · '+t.banco_nombre : ''}</option>`).join('');

  const medioIcon = { efectivo:'💵', transferencia:'🏦', tarjeta:'💳', adeuda:'📋' };
  const medioLabel = { efectivo:'Efectivo', transferencia:'Transferencia', tarjeta:'Tarjeta', adeuda:'Adeuda al Proveedor' };

  grid.innerHTML = _svcPagos.map((p, i) => {
    const isTransf  = p.medio === 'transferencia';
    const isTarjeta = p.medio === 'tarjeta';
    const isAdeuda  = p.medio === 'adeuda';

    const extraFields = isTransf ? `
        <div style="margin-top:8px;">
          <label style="font-size:10px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;">Cuenta destino</label>
          <select style="width:100%;margin-top:3px;" onchange="_svcPagos[${i}].cuenta_id=this.value">
            <option value="">— Seleccionar cuenta —</option>${cuentasOpts.replace(`value="${p.cuenta_id}"`,`value="${p.cuenta_id}" selected`)}
          </select>
        </div>` : isTarjeta ? `
        <div style="margin-top:8px;display:grid;grid-template-columns:1fr 80px;gap:8px;">
          <div>
            <label style="font-size:10px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;">Tarjeta</label>
            <select style="width:100%;margin-top:3px;" onchange="_svcPagos[${i}].tarjeta_id=this.value">
              <option value="">— Seleccionar tarjeta —</option>${tarjetasOpts.replace(`value="${p.tarjeta_id}"`,`value="${p.tarjeta_id}" selected`)}
            </select>
          </div>
          <div>
            <label style="font-size:10px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;">Cuotas</label>
            <input type="number" min="1" max="48" value="${p.cuotas||1}" style="width:100%;margin-top:3px;"
              onchange="_svcPagos[${i}].cuotas=this.value">
          </div>
        </div>` : isAdeuda ? `
        <div style="margin-top:8px;">
          <label style="font-size:10px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;">Notas</label>
          <input type="text" placeholder="Observaciones (opcional)" value="${p.notas||''}" style="width:100%;margin-top:3px;"
            oninput="_svcPagos[${i}].notas=this.value">
        </div>` : '';

    return `
    <div style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:10px;padding:14px 16px;position:relative;">
      <button type="button" onclick="removeSvcPagoRow(${i})"
        style="position:absolute;top:10px;right:10px;background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:2px 6px;border-radius:4px;font-size:14px;line-height:1;"
        title="Eliminar">×</button>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start;">
        <div>
          <label style="font-size:10px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;">Medio de pago</label>
          <select onchange="_onSvcPagoMedio(${i},this.value)" style="width:100%;margin-top:3px;">
            <option value="efectivo"      ${p.medio==='efectivo'     ?'selected':''}>💵 Efectivo</option>
            <option value="transferencia" ${p.medio==='transferencia'?'selected':''}>🏦 Transferencia</option>
            <option value="tarjeta"       ${p.medio==='tarjeta'      ?'selected':''}>💳 Tarjeta</option>
            <option value="adeuda"        ${p.medio==='adeuda'       ?'selected':''}>📋 Adeuda al Proveedor</option>
          </select>
        </div>
        <div>
          <label style="font-size:10px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;">Monto</label>
          <input type="text" inputmode="numeric" placeholder="0" value="${p.monto ? Number(p.monto).toLocaleString('es-AR') : ''}"
            style="width:100%;margin-top:3px;font-size:22px;font-weight:700;text-align:right;color:var(--accent-color);"
            oninput="fmtAmountInput(this);_svcPagos[${i}].monto=this.dataset.raw;_svcPagosUpdateSummary()">
        </div>
      </div>
      ${extraFields}
      <div style="margin-top:10px;">
        <label style="font-size:10px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;">Comprobante</label>
        <div id="svc-pago-dz-mount-${i}" style="margin-top:3px;"></div>
      </div>
    </div>`;
  }).join('') || `<div style="text-align:center;padding:28px 0;color:var(--text-secondary);font-size:13px;">
      <i class="fa-solid fa-credit-card" style="font-size:24px;margin-bottom:8px;display:block;opacity:.3;"></i>
      Sin pagos cargados — hacé clic en "+ Agregar pago"
    </div>`;

  _svcPagosUpdateSummary();

  // Crear DropZones para comprobantes (se recrean en cada render; el _file/url se preserva en _svcPagos[i])
  _svcPagoDzs = _svcPagos.map((p, i) => {
    const dz = new DropZone({
      mountId: `svc-pago-dz-mount-${i}`,
      id:      `svc-pago-dz-${i}`,
      label:   'Comprobante (imagen o PDF)',
      icon:    'fa-receipt',
      task:    'foto',
      camera:  false,
      uploadEndpoint: '/api/upload/svc-pago-comprobante',
      onFileSet: (file) => { _svcPagos[i]._file = file; _svcPagos[i].comprobante_url = ''; },
    });
    if (p._file)           dz.setFile(p._file);
    else if (p.comprobante_url) dz.loadUrl(p.comprobante_url);
    return dz;
  });
}

function _onSvcPagoMedio(i, val) {
  _svcPagos[i].medio = val;
  _svcPagos[i].cuenta_id = '';
  _svcPagos[i].tarjeta_id = '';
  renderSvcPagos();
}

function _tarjetaMarcaLabel(t) {
  return `${t.marca}`;
}

async function _loadSvcPagos(serviceId) {
  if (!serviceId) { _svcPagos = []; renderSvcPagos(); return; }
  const rows = await fetch(`/api/services/${serviceId}/pagos`).then(r => r.json()).catch(() => []);
  _svcPagos = rows.map(r => ({ medio: r.medio, monto: r.monto, cuenta_id: r.cuenta_id || '', tarjeta_id: r.tarjeta_id || '', cuotas: r.cuotas || 1, notas: r.notas || '', comprobante_url: r.comprobante_url || '', _file: null }));
  renderSvcPagos();
}

async function _saveSvcPagos(serviceId) {
  if (!serviceId || !_svcPagos.length) return;
  // Subir comprobantes nuevos antes de guardar
  const pagos = _svcPagos.filter(p => p.monto && parseFloat(p.monto) > 0);
  for (const p of pagos) {
    if (p._file) {
      try {
        const fd = new FormData();
        fd.append('file', p._file);
        const r = await fetch('/api/upload/svc-pago-comprobante', { method: 'POST', body: fd });
        if (r.ok) { const d = await r.json(); p.comprobante_url = d.url; }
      } catch(_) {}
      p._file = null;
    }
  }
  await fetch(`/api/services/${serviceId}/pagos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pagos.map(p => ({ medio: p.medio, monto: p.monto, cuenta_id: p.cuenta_id, tarjeta_id: p.tarjeta_id, cuotas: p.cuotas, notas: p.notas, comprobante_url: p.comprobante_url || null })))
  });
}

// --- CRUD: PROVEEDORES ---

function openAddProveedorModal() {
  document.getElementById('form-proveedor').reset();
  document.getElementById('prov-id').value = '';
  document.getElementById('prov-lat').value = '';
  document.getElementById('prov-lng').value = '';
  document.getElementById('prov-gps-status').textContent = '';
  hideInlineMap('prov-map');
  const mb = document.getElementById('prov-map-btn'); if (mb) mb.style.display = 'none';
  document.getElementById('modal-proveedor-title').innerText = 'Alta de Proveedor';
  document.getElementById('btn-submit-proveedor').innerText = 'Registrar';
  document.getElementById('prov-activo-container').style.display = 'none';
  // Reset tabs to Datos
  switchModalTab(document.querySelector('#modal-proveedor .modal-tab-btn'), 'prov-tab-datos');
  // Load condiciones fiscales
  loadCondicionesFiscalesSelect('prov-condicion-fiscal');
  // Clear sucursales
  document.getElementById('sucursales-table-body').innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--placeholder-color);">Sin sucursales cargadas</td></tr>';
  closeSucursalForm();
  openModal('modal-proveedor');
  _markModalClean('modal-proveedor');
  _initDirtyTracking('form-proveedor', 'modal-proveedor');
}

async function loadProveedores() {
  try {
    const res = await fetch('/api/proveedores');
    cachedProveedores = await res.json();
    const tbody = document.getElementById('proveedores-table-body');
    tbody.innerHTML = '';

    cachedProveedores.forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${p.nombre}</strong></td>
        <td>${p.cuit || '-'}</td>
        <td>${p.telefono || '-'}</td>
        <td>${p.direccion || '-'}</td>
        <td><i class="fa-solid fa-wrench" style="font-size:12px; color: var(--accent-purple);"></i> ${p.rubro || 'General'}</td>
        <td><span class="badge ${p.activo ? 'badge-success' : 'badge-danger'}">${p.activo ? 'activo' : 'inactivo'}</span></td>
        <td style="text-align:center;white-space:nowrap;">
          <button class="tbl-action-btn tbl-btn-view"   onclick="editProveedor(${p.id})"          title="Ver / Detalle"><i class="fa-solid fa-eye"></i></button>
          <button class="tbl-action-btn tbl-btn-edit"   onclick="editProveedor(${p.id})"          title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
          ${canDelete()
            ? `<button class="tbl-action-btn tbl-btn-delete" onclick="deleteProveedor(${p.id})"  title="Eliminar"><i class="fa-solid fa-trash"></i></button>`
            : `<button class="tbl-action-btn tbl-btn-toggle-${p.activo?'off':'on'}" onclick="toggleActivoProveedor(${p.id},${p.activo})" title="${p.activo?'Desactivar':'Activar'}"><i class="fa-solid fa-${p.activo?'circle-pause':'circle-play'}"></i></button>`
          }
        </td>
      `;
      tbody.appendChild(tr);
    });
    bindHeaderEvents();
  injectExportBar('table-proveedores', 'Proveedores');
  } catch (error) {
    console.error('Error al cargar proveedores:', error);
  }
}

function editProveedor(id) {
  const p = cachedProveedores.find(x => x.id === id);
  if (!p) return;

  document.getElementById('prov-id').value = p.id;
  document.getElementById('prov-nombre').value = p.nombre;
  document.getElementById('prov-cuit').value = p.cuit || '';
  document.getElementById('prov-telefono').value = p.telefono || '';
  document.getElementById('prov-email').value = p.email || '';
  document.getElementById('prov-direccion').value = p.direccion || '';
  document.getElementById('prov-rubro').value = p.rubro || '';
  document.getElementById('prov-lat').value = p.lat || '';
  document.getElementById('prov-lng').value = p.lng || '';
  document.getElementById('prov-activo').checked = p.activo === 1;
  const provAlias = document.getElementById('prov-alias'); if (provAlias) provAlias.value = p.alias || '';
  const provCbu   = document.getElementById('prov-cbu-cvu'); if (provCbu) provCbu.value = p.cbu_cvu || '';

  const gpsStatus = document.getElementById('prov-gps-status');
  if (p.lat && p.lng) {
    gpsStatus.textContent = '📍 GPS guardado';
    gpsStatus.style.color = 'var(--color-success)';
    showInlineMap('prov-map', parseFloat(p.lat), parseFloat(p.lng), p.direccion || p.nombre);
    const mb = document.getElementById('prov-map-btn'); if (mb) mb.style.display = '';
  } else {
    gpsStatus.textContent = '';
    hideInlineMap('prov-map');
    const mb = document.getElementById('prov-map-btn'); if (mb) mb.style.display = 'none';
  }

  _setModalTitle('modal-proveedor-title', '<i class="fa-solid fa-store"></i>', 'Modificar Proveedor', p.nombre);
  document.getElementById('btn-submit-proveedor').innerText = 'Guardar Cambios';
  document.getElementById('prov-activo-container').style.display = 'flex';

  // Load condiciones fiscales then set value
  loadCondicionesFiscalesSelect('prov-condicion-fiscal', p.condicion_fiscal_id);
  // Reset tabs
  switchModalTab(document.querySelector('#modal-proveedor .modal-tab-btn'), 'prov-tab-datos');
  // Load sucursales
  loadSucursales(id);
  closeSucursalForm();

  openModal('modal-proveedor');
  _markModalClean('modal-proveedor');
  _initDirtyTracking('form-proveedor', 'modal-proveedor');
}

async function saveProveedor(e) {
  e.preventDefault();

  const id = document.getElementById('prov-id').value;
  const isEdit = id !== '';

  const data = {
    nombre: document.getElementById('prov-nombre').value,
    cuit: document.getElementById('prov-cuit').value || null,
    telefono: sanitizePhone(document.getElementById('prov-telefono').value),
    email: document.getElementById('prov-email').value || null,
    direccion: document.getElementById('prov-direccion').value || null,
    rubro: document.getElementById('prov-rubro').value || null,
    condicion_fiscal_id: document.getElementById('prov-condicion-fiscal').value || null,
    lat: document.getElementById('prov-lat').value || null,
    lng: document.getElementById('prov-lng').value || null,
    alias:   document.getElementById('prov-alias')?.value.trim() || null,
    cbu_cvu: document.getElementById('prov-cbu-cvu')?.value.trim() || null,
    activo: isEdit ? (document.getElementById('prov-activo').checked ? 1 : 0) : 1
  };

  const url = isEdit ? `/api/proveedores/${id}` : '/api/proveedores';
  const method = isEdit ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      const reply = await res.json();
      showAlert(isEdit ? '¡Proveedor modificado con éxito!' : '¡Proveedor registrado con éxito!');
      closeModal('modal-proveedor');
      loadProveedores();
      // Si se llamó desde el modal de Service, recargar el select y auto-seleccionar el nuevo proveedor
      if (!isEdit && window._svcProveedorAfterSave && reply.id) {
        window._svcProveedorAfterSave = false;
        await _loadSvcProveedorSelect(reply.id);
      }
    } else {
      const err = await res.json();
      showAlert(`Error: ${err.message}`);
    }
  } catch (error) {
    showAlert('Fallo al guardar proveedor.');
  }
}

async function deleteProveedor(id) {
  const p = cachedProveedores.find(x => x.id === id);
  if (!p) return;

  if (await showConfirm(`¿Estás seguro de que deseas eliminar al proveedor "${p.nombre}"?`)) {
    try {
      const res = await fetch(`/api/proveedores/${id}`, { method: 'DELETE' });
      const reply = await res.json();
      showAlert(reply.message);
      loadProveedores();
    } catch (err) {
      showAlert('Error al eliminar proveedor.', 'error', 'error');
    }
  }
}

async function toggleActivoProveedor(id, activo) {
  const p = cachedProveedores.find(x => x.id === id);
  if (!p || !await showConfirm(`¿${activo?'Desactivar':'Activar'} al proveedor "${p.nombre}"?`)) return;
  const res = await fetch(`/api/proveedores/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...p, activo: activo ? 0 : 1 })
  });
  if (res.ok) { showAlert(`Proveedor ${activo?'desactivado':'activado'}.`, 'success'); loadProveedores(); }
  else { const e = await res.json(); showAlert(`Error: ${e.message}`); }
}


// --- SERVICES CRUD ---

async function loadServices() {
  try {
    _populateServicesFilters();
    const vehiculo  = document.getElementById('services-filter-vehiculo')?.value  || '';
    const proveedor = document.getElementById('services-filter-proveedor')?.value || '';
    const desde     = document.getElementById('services-filter-desde')?.value     || '';
    const hasta     = document.getElementById('services-filter-hasta')?.value     || '';
    const params = new URLSearchParams();
    if (vehiculo)  params.set('vehiculo_id',  vehiculo);
    if (proveedor) params.set('proveedor_id', proveedor);
    if (desde)     params.set('desde',        desde);
    if (hasta)     params.set('hasta',        hasta);
    const res = await fetch('/api/services?' + params.toString());
    const services = await res.json();
    const tbody = document.getElementById('services-table-body');
    tbody.innerHTML = '';

    let totalCosto = 0;
    services.forEach(s => {
      const costo = parseFloat(s.costo || s.costo_materiales || 0);
      totalCosto += costo;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${s.patente}</strong><br><small class="text-secondary">${s.marca || ''} ${s.modelo || ''}</small></td>
        <td>${formatDate(s.fecha)}</td>
        <td>${s.tipo || s.trabajo_realizado || '-'}<br><small style="color:var(--placeholder-color)">${s.descripcion || ''}</small></td>
        <td>${s.proveedor || '-'}</td>
        <td>${costo ? formatCurrency(costo) : '-'}</td>
        <td>${s.kilometraje ? `${s.kilometraje.toLocaleString()} km` : (s.kms ? `${s.kms.toLocaleString()} km` : '-')}</td>
        <td style="text-align:center; white-space:nowrap;">
          <button class="tbl-action-btn tbl-btn-view"   onclick="openServiceDetalle(${s.id})" title="Ver Detalle / Fotos / Factura"><i class="fa-solid fa-eye"></i></button>
          <button class="tbl-action-btn tbl-btn-edit"   onclick="editService(${s.id})"        title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
          ${canDelete()
            ? `<button class="tbl-action-btn tbl-btn-delete" onclick="deleteService(${s.id})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>`
            : ''
          }
        </td>
      `;
      tbody.appendChild(tr);
    });
    _cachedServices = services;
    const badge = document.getElementById('svc-total-badge');
    if (badge) {
      if (services.length) animateCounter(badge, totalCosto, v => formatCurrency(v));
      else badge.textContent = '';
    }
    const svcCountBadge = document.getElementById('svc-count-badge');
    if (svcCountBadge) svcCountBadge.textContent = services.length ? `${services.length} service${services.length !== 1 ? 's' : ''}` : '';
    const svcRow = document.getElementById('svc-totals-row');
    if (svcRow) svcRow.style.display = services.length ? '' : 'none';
    staggerTableRows(tbody);
    bindHeaderEvents();
    injectExportBar('table-services', 'Services');
  } catch (error) {
    console.error('Error al cargar services:', error);
  }
}

async function _populateServicesFilters() {
  const vSel = document.getElementById('services-filter-vehiculo');
  const pSel = document.getElementById('services-filter-proveedor');
  if (!vSel || !pSel || vSel.dataset.loaded) return;
  try {
    const [vRes, pRes] = await Promise.all([fetch('/api/vehiculos'), fetch('/api/proveedores')]);
    const [vList, pList] = await Promise.all([vRes.json(), pRes.json()]);
    vList.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.patente} - ${v.marca || ''} ${v.modelo || ''}`.trim();
      vSel.appendChild(opt);
    });
    pList.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.nombre;
      pSel.appendChild(opt);
    });
    vSel.dataset.loaded = '1';
  } catch(_) {}
}

let _svcGrChartEvol = null, _svcGrChartLine = null, _svcGrChartVeh = null, _svcGrChartProv = null, _svcGrChartTipo = null;

function openServicesGraficos() {
  if (!_cachedServices?.length) { showToast('No hay services para graficar', 'warning'); return; }

  let overlay = document.getElementById('modal-svc-graficos');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modal-svc-graficos';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:900px;width:95%;overflow:hidden;">
        <div class="modal-header">
          <h3 style="margin:0;font-size:17px;font-weight:700;display:flex;align-items:center;gap:8px;">
            <i class="fa-solid fa-chart-bar" style="color:var(--accent-color);"></i> Gráficos de Services
          </h3>
          <button class="btn-close" onclick="closeModal('modal-svc-graficos')">&times;</button>
        </div>
        <div class="modal-body" style="overflow-y:auto;max-height:calc(90vh - 60px);padding:16px 20px;">
          <!-- Filtros -->
          <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px;">
            <div class="form-group filter-col" style="margin:0;">
              <label class="form-label" style="font-size:11px;">Desde</label>
              <input type="date" id="svc-gr-desde" class="form-control" style="width:125px;">
            </div>
            <div class="form-group filter-col" style="margin:0;">
              <label class="form-label" style="font-size:11px;">Hasta</label>
              <input type="date" id="svc-gr-hasta" class="form-control" style="width:125px;">
            </div>
            <div class="form-group" style="margin:0;">
              <label class="form-label" style="font-size:11px;">Vehículo</label>
              <select id="svc-gr-vehiculo" class="form-control" data-no-combo style="min-width:140px;">
                <option value="">— Todos —</option>
              </select>
            </div>
            <button class="btn btn-primary btn-sm" onclick="_renderSvcGraficos()">
              <i class="fa-solid fa-chart-bar"></i> Actualizar
            </button>
            <div style="display:flex;gap:12px;align-items:center;margin-left:6px;padding-left:12px;border-left:1px solid var(--border-color);">
              <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;white-space:nowrap;">
                <input type="checkbox" id="svc-gr-show-x" checked onchange="_renderSvcGraficos()"> Eje X
              </label>
              <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;white-space:nowrap;">
                <input type="checkbox" id="svc-gr-show-y" checked onchange="_renderSvcGraficos()"> Eje Y
              </label>
              <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;white-space:nowrap;">
                <input type="checkbox" id="svc-gr-show-lbl" onchange="_renderSvcGraficos()"> Valores
              </label>
            </div>
          </div>
          <!-- Chips de totales -->
          <div id="svc-gr-totals" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px;"></div>
          <!-- Fila 1: Barras agrupadas por vehículo (ancho completo) -->
          <div style="margin-bottom:20px;">
            <h4 style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Costo por Mes — por Vehículo</h4>
            <div style="position:relative;height:220px;"><canvas id="svc-chart-evol"></canvas></div>
          </div>
          <!-- Fila 2: Línea de evolución total (ancho completo) -->
          <div style="margin-bottom:20px;">
            <h4 style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Evolución — Línea por Vehículo</h4>
            <div style="position:relative;height:200px;"><canvas id="svc-chart-line"></canvas></div>
          </div>
          <!-- Fila 3: Por vehículo + Por proveedor -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;">
            <div>
              <h4 style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Por Vehículo</h4>
              <div style="position:relative;height:200px;"><canvas id="svc-chart-veh"></canvas></div>
            </div>
            <div>
              <h4 style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Por Proveedor</h4>
              <div style="position:relative;height:200px;"><canvas id="svc-chart-prov"></canvas></div>
            </div>
          </div>
          <!-- Fila 4: Por tipo de service -->
          <div>
            <h4 style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Por Tipo de Service</h4>
            <div style="position:relative;height:200px;"><canvas id="svc-chart-tipo"></canvas></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    // Activar DatePicker en los inputs de fecha
    DatePicker.init(document.getElementById('svc-gr-desde'));
    DatePicker.init(document.getElementById('svc-gr-hasta'));
  }

  // Poblar selector de vehículos
  const sel = document.getElementById('svc-gr-vehiculo');
  if (sel) {
    const patentes = [...new Set(_cachedServices.map(s => s.patente).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">— Todos —</option>' + patentes.map(p => `<option value="${p}">${p}</option>`).join('');
  }

  openModal('modal-svc-graficos');
  _renderSvcGraficos();
}

function _renderSvcGraficos() {
  const desde  = document.getElementById('svc-gr-desde')?.value || '';
  const hasta  = document.getElementById('svc-gr-hasta')?.value || '';
  const vehFil = document.getElementById('svc-gr-vehiculo')?.value || '';
  const fmtK   = v => v >= 1000000 ? `$${(v/1000000).toFixed(1)}M` : v >= 1000 ? `$${(v/1000).toFixed(0)}K` : `$${v.toFixed(0)}`;
  const showX   = document.getElementById('svc-gr-show-x')?.checked ?? true;
  const showY   = document.getElementById('svc-gr-show-y')?.checked ?? true;
  const showLbl = document.getElementById('svc-gr-show-lbl')?.checked ?? false;
  const dFmt   = { display: ctx => showLbl && (ctx.dataset.data[ctx.dataIndex] / ctx.dataset.data.reduce((a,b)=>a+b,0)) > 0.05,
                   color:'#fff', font:{size:9,weight:'700'}, formatter: v=>fmtK(v) };

  let data = _cachedServices || [];
  if (desde) data = data.filter(s => (s.fecha||'') >= desde);
  if (hasta) data = data.filter(s => (s.fecha||'') <= hasta);
  if (vehFil) data = data.filter(s => s.patente === vehFil);

  const costo = s => parseFloat(s.costo || s.costo_materiales || 0);
  const total  = data.reduce((sum,s) => sum + costo(s), 0);

  // Chips
  const totalsEl = document.getElementById('svc-gr-totals');
  if (totalsEl) totalsEl.innerHTML = [
    ['Total período', formatCurrency(total)],
    ['Registros', data.length],
    ['Promedio x service', data.length ? formatCurrency(total/data.length) : '$0'],
  ].map(([lbl,val]) => `
    <div style="background:var(--bg-secondary);border-radius:8px;padding:8px 14px;border:1px solid var(--border-color);">
      <div style="font-size:10px;color:var(--text-secondary);font-weight:600;text-transform:uppercase;letter-spacing:.4px;">${lbl}</div>
      <div style="font-size:1.2rem;font-weight:800;">${val}</div>
    </div>`).join('');

  // Mes keys y labels compartidos
  const mesSet = new Set();
  data.forEach(s => { const m = (s.fecha||'').substring(0,7); if(m) mesSet.add(m); });
  const mesKeys   = [...mesSet].sort();
  const mesLabels = mesKeys.map(m => { const [y,mo] = m.split('-'); return `${mo}/${y.slice(2)}`; });

  // Vehículos
  const vehList = [...new Set(data.map(s=>s.patente).filter(Boolean))].sort();

  // Agregación por vehículo × mes
  const byVehMes = {};
  vehList.forEach(p => { byVehMes[p] = {}; });
  data.forEach(s => {
    if (!s.patente) return;
    const m = (s.fecha||'').substring(0,7); if (!m) return;
    byVehMes[s.patente][m] = (byVehMes[s.patente][m]||0) + costo(s);
  });

  // ── 1. Barras agrupadas por vehículo ──
  const evolCvs = document.getElementById('svc-chart-evol');
  if (_svcGrChartEvol) { _svcGrChartEvol.destroy(); _svcGrChartEvol = null; }
  if (evolCvs && mesKeys.length) {
    const datasets = vehList.length
      ? vehList.map((pat, i) => ({
          label: pat,
          data: mesKeys.map(m => byVehMes[pat]?.[m] || 0),
          backgroundColor: _CHART_PALETTE[i%_CHART_PALETTE.length].top,
          borderColor: _CHART_PALETTE[i%_CHART_PALETTE.length].bot,
          borderWidth: 0, borderRadius: 6, borderSkipped: false,
        }))
      : [{ label:'Total', data: mesKeys.map(m => {
            let t=0; data.forEach(s=>{ if((s.fecha||'').substring(0,7)===m) t+=costo(s); }); return t;
          }), backgroundColor: _CHART_PALETTE[0].top, borderRadius:8, borderSkipped:false }];
    _svcGrChartEvol = new Chart(evolCvs, {
      type: 'bar',
      data: { labels: mesLabels, datasets },
      options: {
        responsive:true, maintainAspectRatio:false,
        animation:{ duration:900, easing:'easeInOutQuart' },
        interaction:{ mode:'index', intersect:false },
        plugins: {
          legend:{ position:'bottom', labels:{ font:{size:10,weight:'600'}, usePointStyle:true, boxWidth:10 } },
          datalabels: {
            display: showLbl,
            clip: false, clamp: false,
            font: { size: 9, weight: '700' },
            formatter: v => v > 0 ? fmtK(v) : '',
            anchor: ctx => {
              const bar = ctx.chart.getDatasetMeta(ctx.datasetIndex).data[ctx.dataIndex];
              return bar && (bar.base - bar.y) > 28 ? 'center' : 'end';
            },
            align: ctx => {
              const bar = ctx.chart.getDatasetMeta(ctx.datasetIndex).data[ctx.dataIndex];
              return bar && (bar.base - bar.y) > 28 ? 'center' : 'top';
            },
            color: ctx => {
              const bar = ctx.chart.getDatasetMeta(ctx.datasetIndex).data[ctx.dataIndex];
              return bar && (bar.base - bar.y) > 28 ? '#fff' : (ctx.dataset.backgroundColor || '#888');
            },
          },
          tooltip:{ ..._chartTooltip(), callbacks:{ label: ctx=>`  ${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y)}` } }
        },
        scales: {
          x:{ grid:{ display:false }, ticks:{ display:showX, font:{size:10} } },
          y:{ grid:_chartGrid(), ticks:{ display:showY, font:{size:10}, callback: v=>fmtK(v) } }
        }
      },
      plugins: _makeChartPlugins(false, null)
    });
  }

  // ── 2. Líneas por vehículo ──
  const lineCvs = document.getElementById('svc-chart-line');
  if (_svcGrChartLine) { _svcGrChartLine.destroy(); _svcGrChartLine = null; }
  if (lineCvs && mesKeys.length) {
    const lineDs = vehList.length
      ? vehList.map((pat, i) => ({
          label: pat,
          data: mesKeys.map(m => byVehMes[pat]?.[m] || 0),
          borderColor: _CHART_PALETTE[i%_CHART_PALETTE.length].top,
          backgroundColor: _CHART_PALETTE[i%_CHART_PALETTE.length].top + '18',
          borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 7,
          tension: 0.35, fill: false,
        }))
      : [{ label:'Total', data: mesKeys.map(m => {
            let t=0; data.forEach(s=>{ if((s.fecha||'').substring(0,7)===m) t+=costo(s); }); return t;
          }), borderColor: _CHART_PALETTE[0].top, backgroundColor: _CHART_PALETTE[0].top+'18',
          borderWidth:2.5, pointRadius:4, pointHoverRadius:7, tension:0.35, fill:true }];
    _svcGrChartLine = new Chart(lineCvs, {
      type: 'line',
      data: { labels: mesLabels, datasets: lineDs },
      options: {
        responsive:true, maintainAspectRatio:false,
        animation:{ duration:900, easing:'easeInOutQuart' },
        interaction:{ mode:'index', intersect:false },
        plugins: {
          legend:{ position:'bottom', labels:{ font:{size:10,weight:'600'}, usePointStyle:true, boxWidth:10 } },
          datalabels:{ display: showLbl, anchor:'end', align:'top', clip:false, clamp:true, font:{size:9,weight:'700'}, formatter: v => v > 0 ? fmtK(v) : '' },
          tooltip:{ ..._chartTooltip(), callbacks:{ label: ctx=>`  ${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y)}` } }
        },
        scales: {
          x:{ grid:{ display:false }, ticks:{ display:showX, font:{size:10} } },
          y:{ grid:_chartGrid(), ticks:{ display:showY, font:{size:10}, callback: v=>fmtK(v) } }
        }
      }
    });
  }

  // ── 3. Por vehículo (doughnut) ──
  const byVeh = {};
  data.forEach(s => { if (s.patente) byVeh[s.patente] = (byVeh[s.patente]||0) + costo(s); });
  const vehKeys = Object.keys(byVeh).sort((a,b) => byVeh[b]-byVeh[a]);
  const vehCvs = document.getElementById('svc-chart-veh');
  if (_svcGrChartVeh) { _svcGrChartVeh.destroy(); _svcGrChartVeh = null; }
  if (vehCvs && vehKeys.length) {
    _svcGrChartVeh = new Chart(vehCvs, {
      type: 'doughnut',
      data: { labels: vehKeys, datasets: [{ data: vehKeys.map(k => byVeh[k]),
        backgroundColor: vehKeys.map((_,i) => _CHART_PALETTE[i%_CHART_PALETTE.length].top),
        borderColor:     vehKeys.map((_,i) => _CHART_PALETTE[i%_CHART_PALETTE.length].bot),
        borderWidth: 2, hoverOffset: 18 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 900, easing: 'easeInOutQuart' },
        plugins: {
          legend: { position: 'right', labels: { font: {size:10,weight:'600'}, boxWidth:10, usePointStyle:true } },
          datalabels: dFmt,
          tooltip: { ..._chartTooltip(), callbacks: { label: ctx => `  ${ctx.label}: ${formatCurrency(ctx.parsed)}` } }
        }
      }
    });
  }

  // ── 4. Por proveedor (doughnut) ──
  const byProv = {};
  data.forEach(s => { const k = s.proveedor||'Sin proveedor'; byProv[k]=(byProv[k]||0)+costo(s); });
  const provKeys = Object.keys(byProv).sort((a,b)=>byProv[b]-byProv[a]).slice(0,8);
  const provCvs = document.getElementById('svc-chart-prov');
  if (_svcGrChartProv) { _svcGrChartProv.destroy(); _svcGrChartProv = null; }
  if (provCvs && provKeys.length) {
    _svcGrChartProv = new Chart(provCvs, {
      type: 'doughnut',
      data: { labels: provKeys, datasets: [{ data: provKeys.map(k=>byProv[k]),
        backgroundColor: provKeys.map((_,i)=>_CHART_PALETTE[i%_CHART_PALETTE.length].top),
        borderColor:     provKeys.map((_,i)=>_CHART_PALETTE[i%_CHART_PALETTE.length].bot),
        borderWidth:2, hoverOffset:18 }] },
      options: {
        responsive:true, maintainAspectRatio:false,
        animation:{ duration:900, easing:'easeInOutQuart' },
        plugins: {
          legend:{ position:'right', labels:{ font:{size:10,weight:'600'}, boxWidth:10, usePointStyle:true } },
          datalabels: dFmt,
          tooltip:{ ..._chartTooltip(), callbacks:{ label: ctx=>`  ${ctx.label}: ${formatCurrency(ctx.parsed)}` } }
        }
      }
    });
  }

  // ── 5. Por tipo de service (doughnut) ──
  const byTipo = {};
  data.forEach(s => { const k = s.tipo||'Sin tipo'; byTipo[k]=(byTipo[k]||0)+costo(s); });
  const tipoKeys = Object.keys(byTipo).sort((a,b)=>byTipo[b]-byTipo[a]);
  const tipoCvs = document.getElementById('svc-chart-tipo');
  if (_svcGrChartTipo) { _svcGrChartTipo.destroy(); _svcGrChartTipo = null; }
  if (tipoCvs && tipoKeys.length) {
    _svcGrChartTipo = new Chart(tipoCvs, {
      type: 'doughnut',
      data: { labels: tipoKeys, datasets: [{ data: tipoKeys.map(k=>byTipo[k]),
        backgroundColor: tipoKeys.map((_,i)=>_CHART_PALETTE[(i+2)%_CHART_PALETTE.length].top),
        borderColor:     tipoKeys.map((_,i)=>_CHART_PALETTE[(i+2)%_CHART_PALETTE.length].bot),
        borderWidth:2, hoverOffset:18 }] },
      options: {
        responsive:true, maintainAspectRatio:false,
        animation:{ duration:900, easing:'easeInOutQuart' },
        plugins: {
          legend:{ position:'right', labels:{ font:{size:10,weight:'600'}, boxWidth:10, usePointStyle:true } },
          datalabels: dFmt,
          tooltip:{ ..._chartTooltip(), callbacks:{ label: ctx=>`  ${ctx.label}: ${formatCurrency(ctx.parsed)}` } }
        }
      }
    });
  }
}

function clearServicesFilters() {
  _clearSelect('services-filter-vehiculo');
  _clearSelect('services-filter-proveedor');
  ['services-filter-desde','services-filter-hasta'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  loadServices();
}

let _cachedServices = [];

// Setter para combos "SmartCombo" del modal Service — usa el setter propio del
// componente (_ssSet) para que el texto visible se sincronice, no solo el <select> nativo.
function _svcSet(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el._ssSet) el._ssSet(val ?? ''); else el.value = val ?? '';
}

async function openAddServiceModal() {
  document.getElementById('form-service').reset();
  document.getElementById('svc-id').value = '';
  document.getElementById('modal-service-title').innerText = 'Nuevo Service';
  document.getElementById('btn-submit-service').innerText = 'Registrar';
  document.getElementById('svc-fotos-info').style.display = 'block';
  document.getElementById('svc-fotos-area').style.display = 'none';
  document.getElementById('svc-fecha').value = new Date().toISOString().split('T')[0];
  await _loadServiceSelects();
  _initSvcFacturaDropzone();
  _dzSvcFactura?.clear();
  document.getElementById('svc-factura-url').value = '';
  _svcPagos = []; renderSvcPagos(); _svcPagosUpdateSummary();
  _initDiag(null);
  switchModalTab(document.querySelector('#modal-service .modal-tab-btn'), 'svc-tab-datos');
  openModal('modal-service');
}

async function editService(id) {
  try {
  const res = await fetch('/api/services');
  if (!res.ok) throw new Error('Error al cargar services');
  const all = await res.json();
  // eslint-disable-next-line eqeqeq
  const s = all.find(x => x.id == id);
  if (!s) { showToast('Service no encontrado', 'error'); return; }

  document.getElementById('svc-id').value = s.id;
  _setModalTitle('modal-service-title', '<i class="fa-solid fa-screwdriver-wrench"></i>', 'Editar Service', `${s.patente} · ${s.tipo || ''}`);
  document.getElementById('btn-submit-service').innerText = 'Guardar Cambios';

  await _loadServiceSelects();
  _svcSet('svc-vehiculo', s.vehiculo_id);
  _svcSet('svc-proveedor', s.proveedor_id || '');
  document.getElementById('svc-tipo').value = s.tipo || s.trabajo_realizado || '';
  document.getElementById('svc-fecha').value = s.fecha ? s.fecha.split('T')[0] : '';
  setAmt('svc-costo', s.costo || s.costo_materiales || 0);
  document.getElementById('svc-km').value = s.kilometraje || s.kms || '';
  document.getElementById('svc-km-intervalo').value = s.km_intervalo || '';
  document.getElementById('svc-km-proximo').value = s.km_proximo || '';
  document.getElementById('svc-descripcion').value = s.descripcion || '';
  document.getElementById('svc-notas').value = s.notas || '';

  // Datos de factura
  _initSvcFacturaDropzone();
  if (s.factura_url) _dzSvcFactura.loadUrl(s.factura_url); else _dzSvcFactura.clear();
  document.getElementById('svc-factura-url').value = s.factura_url || '';
  document.getElementById('svc-fact-numero').value = s.factura_numero || '';
  _svcSet('svc-fact-tipo', s.factura_tipo || '');
  document.getElementById('svc-fact-fecha').value = s.factura_fecha ? s.factura_fecha.split('T')[0] : '';
  _svcSet('svc-fact-proveedor-sel', s.factura_proveedor_id || '');
  _svcSet('svc-fact-tipo-auth', s.factura_tipo_auth || '');
  document.getElementById('svc-fact-cae').value = s.factura_cae || '';
  document.getElementById('svc-fact-cae-vto').value = s.factura_cae_vto ? s.factura_cae_vto.split('T')[0] : '';
  setAmt('svc-fact-subtotal', s.factura_subtotal || 0);
  setAmt('svc-fact-iva', s.factura_iva || 0);
  setAmt('svc-fact-total', s.factura_total || 0);
  document.getElementById('svc-fact-items').value    = s.factura_items    || '';
  _svcSet('svc-fact-receptor', s.factura_receptor || '');

  // Show fotos
  document.getElementById('svc-fotos-info').style.display = 'none';
  document.getElementById('svc-fotos-area').style.display = 'block';
  loadServiceFotos(s.id);

  // Cargar pagos existentes
  await _loadSvcPagos(s.id);

  // Diagnóstico YPF
  let diagData = null;
  try { diagData = typeof s.diagnostico_json === 'string' ? JSON.parse(s.diagnostico_json) : s.diagnostico_json; } catch(_) {}
  _initDiag(diagData);

  switchModalTab(document.querySelector('#modal-service .modal-tab-btn'), 'svc-tab-datos');
  openModal('modal-service');
  } catch(err) { showToast('Error al abrir service: ' + err.message, 'error'); console.error(err); }
}

async function _loadServiceSelects() {
  // Vehiculos
  const vRes = await fetch('/api/vehiculos');
  const vList = await vRes.json();
  const vSel = document.getElementById('svc-vehiculo');
  vSel.innerHTML = '<option value="">-- Seleccionar --</option>';
  vList.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = `${v.patente} - ${v.marca || ''} ${v.modelo || ''}`.trim();
    vSel.appendChild(opt);
  });
  // Proveedores — poblar ambos selects (service y factura)
  const pRes = await fetch('/api/proveedores');
  const pList = await pRes.json();
  const selIds = ['svc-proveedor', 'svc-fact-proveedor-sel'];
  selIds.forEach(selId => {
    const pSel = document.getElementById(selId);
    if (!pSel) return;
    pSel.innerHTML = '<option value="">-- Sin proveedor --</option>';
    pList.filter(p => p.activo).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.dataset.cuit = p.cuit || '';
      opt.textContent = `${p.nombre}${p.cuit ? ' · ' + p.cuit : ''}`;
      pSel.appendChild(opt);
    });
    refreshSearchableSelect(selId);
  });
  // Tarjetas (para grilla de pagos)
  if (!_cachedTarjetas.length) _cachedTarjetas = await fetch('/api/tarjetas').then(r => r.json()).catch(() => []);
  // Cuentas (para grilla de pagos — reusar _cachedCuentas si ya está)
  if (!_cachedCuentas.length) {
    const cRes = await fetch('/api/cuentas');
    _cachedCuentas = await cRes.json();
  }
  // Titulares para receptor de factura
  const rSel = document.getElementById('svc-fact-receptor');
  if (rSel && rSel.options.length <= 1) {
    try {
      const tList = await fetch('/api/vehiculos/titulares').then(r => r.json());
      tList.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.titular_nombre + (t.titular_cuit ? ' · CUIT ' + t.titular_cuit : '');
        opt.textContent = opt.value;
        rSel.appendChild(opt);
      });
    } catch(_) {}
  }
}

async function _loadSvcProveedorSelect(selectId = null) {
  const pRes = await fetch('/api/proveedores').catch(() => null);
  if (!pRes) return;
  const pList = await pRes.json();
  ['svc-proveedor', 'svc-fact-proveedor-sel'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const prev = el.value;
    el.innerHTML = '<option value="">-- Sin proveedor --</option>';
    pList.filter(p => p.activo).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.dataset.cuit = p.cuit || '';
      opt.textContent = `${p.nombre}${p.cuit ? ' · ' + p.cuit : ''}`;
      el.appendChild(opt);
    });
    el.value = selectId || prev || '';
    refreshSearchableSelect(id);
  });
}

// Calcula el próximo service sumando el intervalo al km actual
function calcProximoService() {
  const km = parseInt(document.getElementById('svc-km').value) || 0;
  const intervalo = parseInt(document.getElementById('svc-km-intervalo').value) || 0;
  const proxEl = document.getElementById('svc-km-proximo');
  if (km > 0 && intervalo > 0) {
    proxEl.value = km + intervalo;
  } else if (km > 0 && !intervalo) {
    proxEl.value = ''; // sin intervalo, limpiar
  }
}

// ── Diagnóstico YPF ────────────────────────────────────────────────────────────
const _DIAG_SECCIONES = {
  seguridad: {
    containerId: 'diag-sec-seguridad',
    items: [
      { key: 'luces', label: 'Luces exteriores y baúl' },
      { key: 'tuercas', label: 'Tuercas neumáticos' },
      { key: 'escobillas', label: 'Escobillas limpiaparabrisas' },
      { key: 'prof_ti', label: 'Prof. neumático TI (mm)', mm: true },
      { key: 'prof_td', label: 'Prof. neumático TD (mm)', mm: true },
      { key: 'prof_di', label: 'Prof. neumático DI (mm)', mm: true },
      { key: 'prof_dd', label: 'Prof. neumático DD (mm)', mm: true },
      { key: 'pastillas', label: 'Pastillas de freno' },
      { key: 'flexibles', label: 'Flexibles de frenos' },
      { key: 'discos', label: 'Discos de frenos' },
      { key: 'amortiguadores', label: 'Amortiguadores' },
      { key: 'pres_traseros', label: 'Presión neumáticos traseros (PSI)', mm: true },
      { key: 'pres_delanteros', label: 'Presión neumáticos delanteros (PSI)', mm: true },
    ]
  },
  fluidos: {
    containerId: 'diag-sec-fluidos',
    items: [
      { key: 'bateria', label: 'Batería' },
      { key: 'dir_hidraulica', label: 'Líquido dirección hidráulica' },
      { key: 'limpiaparabrisas', label: 'Líquido limpiaparabrisas' },
      { key: 'anticongelante_pto', label: 'Punto congelamiento anticongelante' },
      { key: 'refrigerante', label: 'Líquido refrigerante/anticongelante' },
      { key: 'liq_frenos', label: 'Líquido de frenos' },
    ]
  },
  lubricantes: {
    containerId: 'diag-sec-lubricantes',
    items: [
      { key: 'filtro_combustible', label: 'Filtro de combustible' },
      { key: 'aceite_diferencial', label: 'Aceite diferencial' },
      { key: 'aceite_transferencia', label: 'Aceite caja de transferencia' },
      { key: 'aceite_cambios', label: 'Aceite caja de cambios' },
      { key: 'filtro_aire', label: 'Filtro de aire' },
      { key: 'cambio_aceite_filtro', label: 'Cambio de aceite y filtro' },
    ]
  },
  mecanica: {
    containerId: 'diag-sec-mecanica',
    items: [
      { key: 'arandela_carter', label: 'Arandela tapón de carter' },
      { key: 'bisagras', label: 'Bisagras de puertas' },
      { key: 'escape', label: 'Caño de escape' },
      { key: 'correa_alternador', label: 'Correa alternador' },
      { key: 'correa_ac', label: 'Correa aire acondicionado' },
      { key: 'correa_direccion', label: 'Correa dirección asistida' },
      { key: 'guardapolvos', label: 'Guardapolvos y transmisión' },
      { key: 'mangueras', label: 'Revisión de mangueras' },
    ]
  },
  dinamica: {
    containerId: 'diag-sec-dinamica',
    items: [
      { key: 'cinturones', label: 'Cinturones de seguridad' },
    ]
  },
  escaneo: {
    containerId: 'diag-sec-escaneo',
    items: [
      { key: 'abs', label: 'ABS' },
      { key: 'airbag', label: 'Airbag' },
      { key: 'climatizacion', label: 'Climatización' },
      { key: 'historial_fallas', label: 'Historial de fallas' },
      { key: 'instrumental', label: 'Instrumental' },
      { key: 'inyeccion', label: 'Inyección' },
      { key: 'reseteo', label: 'Reseteo service' },
      { key: 'sensores', label: 'Sensores y actuadores' },
      { key: 'sonda_lambda', label: 'Sonda lambda' },
    ]
  },
};

let _diagProductos = [];

function _renderDiagSecciones(data) {
  Object.entries(_DIAG_SECCIONES).forEach(([, sec]) => {
    const container = document.getElementById(sec.containerId);
    if (!container) return;
    container.innerHTML = '';
    sec.items.forEach(item => {
      const val = data?.[item.key] || {};
      const estado = val.estado || '';
      const mmVal  = val.mm || '';
      const div = document.createElement('div');
      div.className = 'diag-item';
      div.dataset.key = item.key;
      let mmHtml = '';
      if (item.mm) {
        mmHtml = `<div class="diag-item-mm"><input type="number" min="0" step="0.1" value="${mmVal}" placeholder="0" style="width:44px;" data-mm="${item.key}"></div>`;
      }
      div.innerHTML = `
        <span class="diag-item-label" title="${item.label}">${item.label}</span>
        ${mmHtml}
        <div class="diag-estado-btns">
          ${['BIEN','REG','MAL','N/A'].map(s => {
            const key = s === 'N/A' ? 'NA' : s === 'REG' ? 'REGULAR' : s;
            const active = estado === key ? ` active-${key}` : '';
            return `<button type="button" class="diag-estado-btn${active}" data-item="${item.key}" data-estado="${key}">${s}</button>`;
          }).join('')}
        </div>`;
      container.appendChild(div);
    });
  });

  // Event delegation on the tab
  document.getElementById('svc-tab-diag').querySelectorAll('.diag-estado-btn').forEach(btn => {
    btn.onclick = function() {
      const key = this.dataset.item;
      const estado = this.dataset.estado;
      // toggle buttons in this item
      this.closest('.diag-estado-btns').querySelectorAll('.diag-estado-btn').forEach(b => {
        b.className = 'diag-estado-btn' + (b.dataset.estado === estado && b.dataset.item === key ? ` active-${estado}` : '');
      });
    };
  });
}

function _renderDiagProductos() {
  const tbody = document.getElementById('diag-productos-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  _diagProductos.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" value="${p.nombre||''}" oninput="_diagProductos[${i}].nombre=this.value" placeholder="Nombre del producto"></td>
      <td><input type="text" value="${p.nro_partida||''}" oninput="_diagProductos[${i}].nro_partida=this.value" placeholder="Nro."></td>
      <td><input type="number" min="0" step="1" value="${p.cantidad||1}" oninput="_diagProductos[${i}].cantidad=this.value" style="width:60px;"></td>
      <td><button type="button" class="btn-icon-sm" onclick="_diagRemoveProducto(${i})"><i class="fa-solid fa-xmark"></i></button></td>`;
    tbody.appendChild(tr);
  });
}

function addDiagProducto() {
  _diagProductos.push({ nombre: '', nro_partida: '', cantidad: 1 });
  _renderDiagProductos();
}

function _diagRemoveProducto(i) {
  _diagProductos.splice(i, 1);
  _renderDiagProductos();
}

function _initDiag(data) {
  const d = data || {};
  document.getElementById('diag-taller').value        = d.taller || '';
  document.getElementById('diag-tecnico').value       = d.tecnico || '';
  document.getElementById('diag-tipo-tecnico').value  = d.tipo_tecnico || '';
  document.getElementById('diag-fecha-prox').value    = d.fecha_prox || '';
  document.getElementById('diag-observaciones').value = d.observaciones || '';
  _diagProductos = d.productos ? JSON.parse(JSON.stringify(d.productos)) : [];
  _renderDiagSecciones(d.items || {});
  _renderDiagProductos();
}

function _getDiagnosticoData() {
  const items = {};
  document.getElementById('svc-tab-diag').querySelectorAll('.diag-item').forEach(div => {
    const key = div.dataset.key;
    const activeBtn = div.querySelector('.diag-estado-btn[class*="active-"]');
    const mmInput = div.querySelector('[data-mm]');
    const entry = {};
    if (activeBtn) entry.estado = activeBtn.dataset.estado;
    if (mmInput && mmInput.value) entry.mm = mmInput.value;
    if (Object.keys(entry).length) items[key] = entry;
  });
  const productos = _diagProductos.filter(p => p.nombre || p.nro_partida);
  const obs = document.getElementById('diag-observaciones').value || '';
  const taller = document.getElementById('diag-taller').value || '';
  const tecnico = document.getElementById('diag-tecnico').value || '';
  const tipo_tecnico = document.getElementById('diag-tipo-tecnico').value || '';
  const fecha_prox = document.getElementById('diag-fecha-prox').value || '';
  if (!taller && !tecnico && !obs && !productos.length && !Object.keys(items).length) return null;
  return { taller, tecnico, tipo_tecnico, fecha_prox, observaciones: obs, productos, items };
}

async function saveService(e) {
  e.preventDefault();
  const id = document.getElementById('svc-id').value;
  const isEdit = id !== '';

  const factProveedorSel = document.getElementById('svc-fact-proveedor-sel');

  const data = {
    vehiculo_id: document.getElementById('svc-vehiculo').value,
    proveedor_id: document.getElementById('svc-proveedor').value || null,
    tipo: document.getElementById('svc-tipo').value,
    fecha: document.getElementById('svc-fecha').value || null,
    costo: getAmt('svc-costo') || null,
    kilometraje: document.getElementById('svc-km').value || null,
    km_intervalo: document.getElementById('svc-km-intervalo').value || null,
    km_proximo: document.getElementById('svc-km-proximo').value || null,
    descripcion: document.getElementById('svc-descripcion').value || null,
    notas: document.getElementById('svc-notas').value || null,
    // Datos de factura (pestaña "Factura" — antes nunca se mandaban al guardar)
    factura_tipo: document.getElementById('svc-fact-tipo')?.value || null,
    factura_numero: document.getElementById('svc-fact-numero')?.value || null,
    factura_fecha: document.getElementById('svc-fact-fecha')?.value || null,
    factura_proveedor_id: factProveedorSel?.value || null,
    factura_proveedor: factProveedorSel?.selectedOptions?.[0]?.textContent?.split(' · ')[0] || null,
    factura_tipo_auth: document.getElementById('svc-fact-tipo-auth')?.value || null,
    factura_cae: document.getElementById('svc-fact-cae')?.value || null,
    factura_cae_vto: document.getElementById('svc-fact-cae-vto')?.value || null,
    factura_subtotal: getAmt('svc-fact-subtotal') || null,
    factura_iva: getAmt('svc-fact-iva') || null,
    factura_total: getAmt('svc-fact-total') || null,
    factura_items:    document.getElementById('svc-fact-items')?.value    || null,
    factura_receptor: document.getElementById('svc-fact-receptor')?.value || null,
    factura_url: document.getElementById('svc-factura-url')?.value || null,
    diagnostico_json: _getDiagnosticoData(),
  };

  try {
    const res = await fetch(isEdit ? `/api/services/${id}` : '/api/services', {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (res.ok) {
      const reply = await res.json();
      const newId = isEdit ? id : reply.id;
      // Guardar pagos (multi-pago)
      await _saveSvcPagos(newId);
      // Show fotos area now that we have an ID
      document.getElementById('svc-id').value = newId;
      document.getElementById('svc-fotos-info').style.display = 'none';
      document.getElementById('svc-fotos-area').style.display = 'block';
      loadServiceFotos(newId);
      document.getElementById('btn-submit-service').innerText = 'Guardar Cambios';
      document.getElementById('modal-service-title').innerText = 'Editar Service';
      showToast(isEdit ? 'Service actualizado' : 'Service registrado');
      loadServices();
    } else {
      const err = await res.json();
      showAlert(`Error: ${err.message}`);
    }
  } catch (err) {
    showAlert('Error al guardar service.', 'error', 'error');
  }
}

async function deleteService(id) {
  if (!await showConfirm('¿Eliminar este service?')) return;
  try {
    await fetch(`/api/services/${id}`, { method: 'DELETE' });
    loadServices();
  } catch(err) { showAlert('Error al eliminar.', 'error', 'error'); }
}

async function loadServiceFotos(serviceId) {
  const gallery = document.getElementById('svc-fotos-gallery');
  gallery.innerHTML = '';
  try {
    const res = await fetch(`/api/services/${serviceId}/fotos`);
    const fotos = await res.json();
    fotos.forEach(f => {
      const div = document.createElement('div');
      div.style.cssText = 'position:relative;width:100px;height:100px;';
      div.innerHTML = `
        <img src="${f.url}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;cursor:pointer;" onclick="openDocViewer('${f.url}','Foto Service')">
        <button onclick="deleteSvcFoto(${f.id},${serviceId})" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,0.6);border:none;color:#fff;border-radius:50%;width:22px;height:22px;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;">&times;</button>
      `;
      gallery.appendChild(div);
    });
  } catch(e) { console.error(e); }
}

async function deleteSvcFoto(fotoId, serviceId) {
  if (!await showConfirm('¿Eliminar esta foto?')) return;
  await fetch(`/api/services/${serviceId}/fotos/${fotoId}`, { method: 'DELETE' });
  loadServiceFotos(serviceId);
}

function handleSvcFotoDrop(event) {
  event.preventDefault();
  document.getElementById('svc-foto-drop').classList.remove('drag-over');
  uploadSvcFotos(event.dataTransfer.files);
}

async function uploadSvcFotos(files) {
  const id = document.getElementById('svc-id').value;
  if (!id) return;
  const fd = new FormData();
  for (const f of files) fd.append('fotos', f);
  try {
    await fetch(`/api/services/${id}/fotos`, { method: 'POST', body: fd });
    loadServiceFotos(id);
    showToast(`${files.length} foto(s) subida(s)`);
  } catch(e) { showAlert('Error al subir fotos', 'error', 'error'); }
}

function openServiceFotos(serviceId) {
  editService(serviceId).then(() => {
    switchModalTab(document.querySelectorAll('#modal-service .modal-tab-btn')[2], 'svc-tab-fotos');
  });
}

// Botón "Detalle" desde la tabla → abre modal en tab Fotos/Detalle
function openServiceDetalle(serviceId) {
  editService(serviceId).then(() => {
    switchModalTab(document.querySelectorAll('#modal-service .modal-tab-btn')[2], 'svc-tab-fotos');
  });
}

// --- GPS validation helper ---
async function validateGPS(addressInputId, latInputId, lngInputId, statusId) {
  const address = document.getElementById(addressInputId).value.trim();
  if (!address) { showAlert('Ingresá una dirección primero.'); return; }
  const statusEl = document.getElementById(statusId);
  statusEl.textContent = 'Buscando...';
  statusEl.style.color = 'var(--placeholder-color)';
  try {
    const res = await fetch(`/api/geocode?address=${encodeURIComponent(address)}`);
    const data = await res.json();
    if (data.lat && data.lng) {
      document.getElementById(latInputId).value = data.lat;
      document.getElementById(lngInputId).value = data.lng;
      statusEl.textContent = '📍 GPS guardado';
      statusEl.style.color = 'var(--color-success)';
      // Mostrar mapa inline automáticamente
      const mapContainerId = statusId.replace('-gps-status', '-map');
      showInlineMap(mapContainerId, data.lat, data.lng, address);
      // Mostrar botón de mapa si existe
      const mapBtnId = statusId.replace('-gps-status', '-map-btn');
      const mapBtn = document.getElementById(mapBtnId);
      if (mapBtn) mapBtn.style.display = '';
    } else {
      statusEl.textContent = 'No se encontró la dirección. Revisá el texto.';
      statusEl.style.color = 'var(--color-error)';
    }
  } catch(e) {
    statusEl.textContent = 'Error al consultar GPS.';
    statusEl.style.color = 'var(--color-error)';
  }
}

/**
 * Muestra un mapa embebido de OpenStreetMap dentro de containerId,
 * centrado en lat/lng con un marcador en la ubicación.
 */
// ── Visor flotante modeless de imagen / documento ───────────────────────────
let _imgViewerRot     = 0;      // grados acumulados
let _imgViewerScale   = 1;      // zoom actual
let _imgViewerFileKey = null;   // para "Aplicar rotación"
let _fvOpenerModal    = null;   // id del modal que abrió el visor
let _fvCropPending    = false;  // true cuando hay un recorte listo para guardar
let _openViewerDzRef  = null;   // referencia al DropZone que abrió el visor

// ── Posicionamiento automático del visor relativo a su modal opener ──
const _FV_BASE_W = 720;
const _FV_TXT_W  = 320;
const _FV_GAP    = 16;

// Estado de vinculación (bloque): true = DropZone + Visor se mueven como unidad
let _fvLinked = false;

function _fvInjectLinkBtn() {
  _fvRemoveLinkBtn();
  // Siempre mostrar el pin en el title bar del visor (siempre visible para el usuario)
  const fvPinBtn = document.getElementById('fv-pin-btn');
  if (fvPinBtn) {
    fvPinBtn.style.display = 'inline-flex';
    _fvRenderLinkBtn(fvPinBtn, _fvLinked);
  }
  // Estándar: si el visor lo abrió un DropZone (clase reutilizable), el pin vive en su propia
  // toolbar, al lado del botón IA — siempre visible sin depender del scroll del modal.
  if (_openViewerDzRef && _openViewerDzRef.id) {
    const dzBtn = document.getElementById(`${_openViewerDzRef.id}-btn-pin`);
    if (dzBtn) {
      dzBtn.style.display = 'inline-flex';
      dzBtn.onclick = _fvToggleLink;
      _fvRenderLinkBtn(dzBtn, _fvLinked);
      return;
    }
  }
  // Fallback: dropzones legacy que todavía no usan la clase DropZone — botón en el footer del modal
  const openerModal = _fvOpenerModal ? document.getElementById(_fvOpenerModal) : null;
  const footer = openerModal?.querySelector('.modal-card .modal-footer');
  if (!footer) return;
  const btn = document.createElement('button');
  btn.id = 'fv-link-btn';
  btn.type = 'button';
  btn.className = 'btn btn-sm';
  btn.style.cssText = 'width:36px;height:36px;min-width:36px;padding:0;border-radius:50%;font-size:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;transition:transform 0.15s ease,box-shadow 0.18s ease;';
  btn.onclick = _fvToggleLink;
  _fvRenderLinkBtn(btn, _fvLinked);
  // Insertar al inicio del footer (antes de Cancelar)
  footer.insertBefore(btn, footer.firstChild);
}

function _fvRemoveLinkBtn() {
  document.getElementById('fv-link-btn')?.remove();
  const fvPinBtn = document.getElementById('fv-pin-btn');
  if (fvPinBtn) { fvPinBtn.style.display = 'none'; }
  if (_openViewerDzRef && _openViewerDzRef.id) {
    const dzBtn = document.getElementById(`${_openViewerDzRef.id}-btn-pin`);
    if (dzBtn) { dzBtn.style.display = 'none'; dzBtn.onclick = null; }
  }
}

function _fvRenderLinkBtn(btn, linked) {
  if (!btn) btn = document.getElementById('fv-pin-btn') || document.getElementById('fv-link-btn');
  if (!btn) return;
  if (linked) {
    // ACOPLADO: thumbtack tachado (slash) en estilo neutro — igual a barra de accesos rápidos
    btn.innerHTML =
      '<span style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;">' +
        '<i class="fa-solid fa-thumbtack" style="font-size:13px;"></i>' +
        '<span style="position:absolute;width:150%;height:1.5px;background:currentColor;transform:rotate(-45deg);border-radius:1px;pointer-events:none;"></span>' +
      '</span>';
    btn.title = 'Acoplado — DropZone y Visor se mueven como bloque. Clic para desacoplar.';
    btn.style.background  = 'var(--bg-card,var(--bg-secondary))';
    btn.style.color       = 'var(--text-secondary)';
    btn.style.border      = '1.5px solid var(--border-color)';
    btn.style.borderRadius = '50%';
    btn.style.boxShadow   = 'none';
  } else {
    // DESACOPLADO: thumbtack en círculo rojo como la X de cerrar — llama la atención
    btn.innerHTML = '<i class="fa-solid fa-thumbtack" style="font-size:13px;"></i>';
    btn.title = 'Desacoplado — el visor flota libre. Clic para acoplar.';
    btn.style.background  = 'rgba(255,59,48,0.12)';
    btn.style.color       = '#ff3b30';
    btn.style.border      = '1.5px solid rgba(255,59,48,0.30)';
    btn.style.borderRadius = '50%';
    btn.style.boxShadow   = 'none';
  }
}

function _fvToggleLink() {
  _fvLinked = !_fvLinked;
  // Actualizar todos los botones pin (title bar del visor + toolbar del DZ)
  _fvRenderLinkBtn(document.getElementById('fv-pin-btn'), _fvLinked);
  if (_openViewerDzRef?.id) _fvRenderLinkBtn(document.getElementById(`${_openViewerDzRef.id}-btn-pin`), _fvLinked);
  _fvRenderLinkBtn(document.getElementById('fv-link-btn'), _fvLinked);
  if (_fvLinked) {
    // Al vincular: re-acoplar inmediatamente
    _fvAutoPosition();
  } else {
    // Al desvincular: restaurar card del formulario a su posición natural
    const openerModal = _fvOpenerModal ? document.getElementById(_fvOpenerModal) : null;
    const openerCard  = openerModal?.querySelector('.modal-card');
    if (openerCard && !openerCard.dataset.dragged) {
      openerCard.style.transform = '';
      openerCard.style.maxHeight = '';
    }
  }
}

function _fvAutoPosition() {
  const fv = document.getElementById('float-img-viewer');
  if (!fv || fv.dataset.moved) return;

  // Leer ancho actual del visor (lo controla _fvAutoFit, no lo sobreescribimos aquí)
  const fvW = fv.offsetWidth || _FV_BASE_W;

  const openerModal = _fvOpenerModal ? document.getElementById(_fvOpenerModal) : null;
  const openerCard  = openerModal ? openerModal.querySelector('.modal-card') : null;

  if (openerCard && _fvLinked) {
    // ── MODO VINCULADO: DropZone + Visor se mueven y dimensionan como bloque ──
    if (!openerCard.dataset.dragged) openerCard.style.transform = '';
    void openerCard.offsetWidth;
    const rect  = openerCard.getBoundingClientRect();
    const ow    = rect.width;
    const oh    = rect.height;
    const sw    = window.innerWidth;
    const sh    = window.innerHeight;
    const fvTop = Math.max(70, rect.top);

    openerCard.dataset.naturalLeft = rect.left;

    // Mismo alto para ambos paneles (sin exceder el borde inferior)
    const targetH = Math.min(oh, sh - fvTop - 8);
    fv.style.height    = targetH + 'px';
    fv.style.maxHeight = targetH + 'px';

    if (!openerCard.dataset.dragged) {
      openerCard.style.transition = 'transform 0.2s ease';
      const totalW = ow + _FV_GAP + fvW;
      const groupL = Math.max(8, (sw - totalW) / 2);
      openerCard.style.transform = `translateX(${groupL - rect.left}px)`;
      if (_scrollArrowPositioner) setTimeout(_scrollArrowPositioner, 220);
      fv.style.left = Math.max(8, Math.min(groupL + ow + _FV_GAP, sw - fvW - 8)) + 'px';
    } else {
      fv.style.left = Math.max(8, Math.min(rect.right + _FV_GAP, sw - fvW - 8)) + 'px';
    }
    fv.style.top       = fvTop + 'px';
    fv.style.transform = 'none';
  } else if (openerCard && !_fvLinked) {
    // ── MODO DESVINCULADO: el formulario queda en su lugar, visor flota libre ──
    // No tocamos el opener card. El visor se centra en pantalla si no fue movido.
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    fv.style.left      = Math.max(8, (sw - fvW) / 2) + 'px';
    fv.style.top       = '70px';
    fv.style.transform = 'none';
    fv.style.height    = Math.min(sh - 90, 640) + 'px';
    fv.style.maxHeight = Math.min(sh - 90, 640) + 'px';
  } else {
    // Sin opener card
    const isPdfMode = document.getElementById('fv-pdf-frame')?.style.display === 'block';
    fv.style.left      = '50%';
    fv.style.top       = '70px';
    fv.style.transform = 'translateX(-50%)';
    if (isPdfMode) {
      const sh = window.innerHeight;
      fv.style.height    = Math.min(sh - 90, 920) + 'px';
      fv.style.maxHeight = Math.min(sh - 90, 920) + 'px';
    } else {
      fv.style.height    = '';
      fv.style.maxHeight = '';
    }
  }

  // Re-ajustar zoom de la imagen después de redimensionar
  setTimeout(_fvAutoFit, 50);
}

function _fvRestoreOpener() {
  const openerModal = _fvOpenerModal ? document.getElementById(_fvOpenerModal) : null;
  const openerCard  = openerModal ? openerModal.querySelector('.modal-card') : null;
  // Solo restaurar transform si el modal no fue arrastrado manualmente (position sigue siendo relativo)
  if (openerCard && !openerCard.dataset.dragged) {
    openerCard.style.transform  = '';
    openerCard.style.transition = '';
    openerCard.style.maxHeight  = '';
    delete openerCard.dataset.naturalLeft;
    if (_scrollArrowPositioner) setTimeout(_scrollArrowPositioner, 50);
  }
}

function openImgViewer(src, title = '', fileKey = null) {
  if (!src || src === window.location.href) return;
  _openFvImage(src, title, fileKey);
}

// Función interna compartida para abrir imagen en el visor
function _openFvImage(src, title, fileKey) {
  fvCancelCrop(); // cancelar recorte previo si lo había
  _fvCropPending = false;
  _imgViewerRot = 0; _imgViewerScale = 1; _fvPanX = 0; _fvPanY = 0;
  _imgViewerFileKey = fileKey || null;

  // Si hay fileKey y no hay archivo pendiente, cargar desde la URL para que
  // rotación/recorte/OCR tengan acceso al archivo aunque ya esté guardado en servidor
  if (fileKey && src && src.startsWith('http') && (!_pendingFiles || !_pendingFiles[fileKey])) {
    fetch(src).then(r => r.blob()).then(blob => {
      if (!_pendingFiles) _pendingFiles = {};
      _pendingFiles[fileKey] = new File([blob], fileKey + '.jpg', { type: blob.type || 'image/jpeg' });
    }).catch(() => {}); // silencioso si falla (CORS, etc.)
  }
  _fvTextVisible = false;

  if (!_fvOpenerModal) {
    const activeOverlay = document.querySelector('.modal-overlay.active');
    _fvOpenerModal = activeOverlay ? activeOverlay.id : null;
  }

  // Activar vinculación al abrir el visor e inyectar botón en el formulario
  _fvLinked = true;
  _fvInjectLinkBtn();

  const fv    = document.getElementById('float-img-viewer');
  const img   = document.getElementById('img-viewer-src');
  const frame = document.getElementById('fv-pdf-frame');
  if (!fv || !img) return;

  // Ocultar PDF frame, mostrar imagen
  if (frame) { frame.style.display = 'none'; frame.src = ''; }
  img.style.display   = 'block';
  img.style.transform = 'translate(0,0) scale(1) rotate(0deg)';

  // Resetear ancho al abrir (sin panel de texto)
  fv.style.width = _FV_BASE_W + 'px';

  document.getElementById('img-viewer-title').textContent = title || 'Vista';
  const dl = document.getElementById('img-viewer-download');
  if (dl) { dl.href = src; dl.download = (title || 'imagen') + '.jpg'; }

  // Botones zoom/rotar visibles
  document.querySelectorAll('#fv-titlebar .btn:not(#fv-txt-btn):not(#img-viewer-apply-rot)').forEach(b => b.style.display = '');
  const txtBtn = document.getElementById('fv-txt-btn');
  if (txtBtn) txtBtn.style.display = '';

  // Botón guardar rotación: inactivo hasta que se gire
  const applyBtn = document.getElementById('img-viewer-apply-rot');
  if (applyBtn) {
    applyBtn.style.background = 'var(--bg-tertiary)';
    applyBtn.style.color      = 'var(--text-secondary)';
    applyBtn.style.opacity    = _imgViewerFileKey ? '0.45' : '0.2';
    applyBtn.style.cursor     = 'default';
  }

  // Resetear panel de texto
  const tp = document.getElementById('fv-text-panel');
  const ta = document.getElementById('fv-text-area');
  if (tp) tp.style.display = 'none';
  if (ta) { ta.value = ''; ta.setAttribute('readonly',''); }

  document.getElementById('fv-body').style.cursor = 'grab';

  // Resetear posición del modal opener y del visor para acople lateral correcto
  delete fv.dataset.moved; // limpiar posición manual previa
  if (_fvOpenerModal) {
    const _opCard = document.getElementById(_fvOpenerModal)?.querySelector('.modal-card');
    if (_opCard) {
      _opCard.style.transition = '';
      _opCard.style.transform  = '';
      delete _opCard.dataset.dragged;
    }
  }

  fv.style.display = 'flex';

  img.onload = () => { _fvAutoPosition(); _fvAutoFit(); img.onload = null; };
  img.src = src;
  if (img.complete && img.naturalWidth) {
    _fvAutoPosition();  // fija altura (targetH) primero → bh correcto para autoFit
    _fvAutoFit();       // calcula escala y ancho ideal con bh ya definido
  } else {
    _fvAutoPosition();  // posicionamiento inicial con ancho base (720px)
  }

  _initFvPan();
}

// Abre imagen O pdf en el visor flotante (nunca en pestaña aparte)
function openDocViewer(url, title = '', forcePdf = false) {
  if (!url) return;
  const isPdf = forcePdf || url.toLowerCase().endsWith('.pdf') || url.includes('application/pdf');
  const fv    = document.getElementById('float-img-viewer');
  const img   = document.getElementById('img-viewer-src');
  const frame = document.getElementById('fv-pdf-frame');
  if (!fv) return;

  // Resetear estado anterior
  _imgViewerRot = 0; _imgViewerScale = 1; _fvPanX = 0; _fvPanY = 0;
  _fvTextVisible = false;
  const tp = document.getElementById('fv-text-panel');
  const ta = document.getElementById('fv-text-area');
  if (tp) tp.style.display = 'none';
  if (ta) { ta.value = ''; ta.setAttribute('readonly',''); }

  // Guardar opener — si ya fue seteado externamente (ej: desde onclick del botón ojo), respetar ese valor
  if (!_fvOpenerModal) {
    const activeOverlay = document.querySelector('.modal-overlay.active');
    _fvOpenerModal = activeOverlay ? activeOverlay.id : null;
  }

  document.getElementById('img-viewer-title').textContent = title || 'Documento';
  const dl = document.getElementById('img-viewer-download');
  if (dl) { dl.href = url; dl.download = title ? `${title}` : 'documento'; }

  // Botones zoom/rotar solo para imágenes
  const zoomBtns = document.querySelectorAll('#fv-titlebar .btn:not(#fv-txt-btn):not(#img-viewer-apply-rot)');

  if (isPdf) {
    img.style.display   = 'none';
    img.src             = '';
    const pdfUrl = url.includes('#') ? url : url + '#zoom=page-width&toolbar=1&page=1';
    if (frame) { frame.src = pdfUrl; frame.style.display = 'block'; }
    // PDF: solo botón IA/Texto, ocultar todo lo demás (zoom, rotar, perspectiva)
    zoomBtns.forEach(b => { if (b.id !== 'fv-wa-btn' && b.id !== 'fv-persp-btn') b.style.display = 'none'; });
    const perspBtn = document.getElementById('fv-persp-btn'); if (perspBtn) perspBtn.style.display = 'none';
    const txtBtn = document.getElementById('fv-txt-btn');
    if (txtBtn) {
      txtBtn.style.display = '';
      txtBtn.title = _aiAvailable ? 'Extraer texto del PDF con IA' : 'Falta API Key de IA para extraer texto';
      txtBtn.style.opacity = _aiAvailable ? '' : '0.45';
      txtBtn.style.cursor  = _aiAvailable ? '' : 'default';
    }
    document.getElementById('fv-body').style.cursor = 'default';
    // Cerrar panel de texto si estaba abierto (para que el ancho vuelva al base)
    _fvTextVisible = false;
    const tp = document.getElementById('fv-text-panel');
    const ta = document.getElementById('fv-text-area');
    if (tp) tp.style.display = 'none';
    if (ta) { ta.value = ''; ta.setAttribute('readonly', ''); }
    // PDF: ancho amplio para que una hoja A4 sea legible
    const pdfW = Math.min(Math.round(window.innerWidth * 0.72), 1100);
    fv.style.width  = pdfW + 'px';
    fv.style.height = Math.min(window.innerHeight - 60, 920) + 'px';
    // Activar modo ACOPLADO
    _fvLinked = true;
    _fvInjectLinkBtn();
  } else {
    _openFvImage(url, title || 'Documento', null);
    return; // _openFvImage maneja todo: display, pan, fit, posición
  }

  // Resetear posición del opener y del visor para garantizar acople lateral
  delete fv.dataset.moved;
  if (_fvOpenerModal) {
    const _opCard2 = document.getElementById(_fvOpenerModal)?.querySelector('.modal-card');
    if (_opCard2) { _opCard2.style.transition = ''; _opCard2.style.transform = ''; delete _opCard2.dataset.dragged; }
  }
  fv.style.display = 'flex';
  _fvAutoPosition();
}

function closeFloatViewer() {
  fvCancelCrop();
  fvCancelPersp();
  fvCloseWaPanel();
  _fvRestoreOpener();
  _fvRemoveLinkBtn();
  _fvLinked = false;
  const fv = document.getElementById('float-img-viewer');
  if (fv) { fv.style.display = 'none'; fv.dataset.moved = ''; fv.dataset.userResized = ''; fv.style.width = ''; fv.style.height = ''; }
  _fvOpenerModal = null;
  _openViewerDzRef = null;
  // Reset panel de texto
  const tp = document.getElementById('fv-text-panel');
  if (tp) tp.style.display = 'none';
  const ta = document.getElementById('fv-text-area');
  if (ta) ta.value = '';
  // Limpiar iframe PDF
  const frame = document.getElementById('fv-pdf-frame');
  if (frame) { frame.src = ''; frame.style.display = 'none'; }
}

// ─────────────────────────────────────────────
// PERSPECTIVA — corrección de 4 puntos
// ─────────────────────────────────────────────
let _perspActive  = false;
let _perspCanvas  = null;
let _perspSrcImg  = null;
let _perspHandles = [];   // [{x,y}] x4 en coords del canvas overlay
let _perspDragIdx = -1;
let _perspImgX = 0, _perspImgY = 0, _perspImgW = 0, _perspImgH = 0; // imagen dibujada en canvas

function fvStartPersp() {
  const img = document.getElementById('img-viewer-src');
  if (!img || !img.src || img.style.display === 'none') { showAlert('No hay imagen en el visor.'); return; }
  fvCancelCrop();
  _perspActive = true;
  _perspSrcImg = img;

  // Crear canvas overlay sobre fv-body
  const body = document.getElementById('fv-body');
  body.style.position = 'relative';
  const cvs = document.createElement('canvas');
  cvs.id = 'fv-persp-canvas';
  cvs.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:20;touch-action:none;';
  body.appendChild(cvs);
  _perspCanvas = cvs;

  // Dimensiones físicas del canvas (retina-safe)
  const dpr = window.devicePixelRatio || 1;
  cvs.width  = body.offsetWidth  * dpr;
  cvs.height = body.offsetHeight * dpr;
  const ctx = cvs.getContext('2d');
  ctx.scale(dpr, dpr);

  // Calcular cómo encaja la imagen
  const cw = body.offsetWidth, ch = body.offsetHeight;
  const iw = img.naturalWidth,  ih = img.naturalHeight;
  const pad = 30;
  const scale = Math.min((cw - pad*2) / iw, (ch - pad*2) / ih);
  _perspImgW = iw * scale;
  _perspImgH = ih * scale;
  _perspImgX = (cw - _perspImgW) / 2;
  _perspImgY = (ch - _perspImgH) / 2;

  // Handles iniciales en las 4 esquinas de la imagen
  _perspHandles = [
    { x: _perspImgX,               y: _perspImgY },               // TL
    { x: _perspImgX + _perspImgW,  y: _perspImgY },               // TR
    { x: _perspImgX + _perspImgW,  y: _perspImgY + _perspImgH },  // BR
    { x: _perspImgX,               y: _perspImgY + _perspImgH },  // BL
  ];

  _perspDraw();

  // Eventos mouse
  cvs.addEventListener('mousedown',  _perspMD);
  cvs.addEventListener('mousemove',  _perspMM);
  cvs.addEventListener('mouseup',    _perspMU);
  cvs.addEventListener('mouseleave', _perspMU);
  // Touch
  cvs.addEventListener('touchstart', _perspTD, { passive: false });
  cvs.addEventListener('touchmove',  _perspTM, { passive: false });
  cvs.addEventListener('touchend',   _perspMU);

  // Mostrar Apply/Cancel, ocultar botón de inicio
  document.getElementById('fv-persp-btn').style.display    = 'none';
  document.getElementById('fv-persp-apply').style.display  = '';
  document.getElementById('fv-persp-cancel').style.display = '';
  // Ocultar otros botones que no aplican en este modo
  ['fv-crop-btn','img-viewer-apply-rot'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
}

const _HANDLE_R = 14; // radio handle px

function _perspDraw() {
  if (!_perspCanvas || !_perspSrcImg) return;
  const dpr = window.devicePixelRatio || 1;
  const cw  = _perspCanvas.width / dpr;
  const ch  = _perspCanvas.height / dpr;
  const ctx = _perspCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Fondo semitransparente
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, cw, ch);

  // Imagen
  ctx.drawImage(_perspSrcImg, _perspImgX, _perspImgY, _perspImgW, _perspImgH);

  const [tl, tr, br, bl] = _perspHandles;

  // Zona seleccionada (clip path del quad)
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(_perspSrcImg, _perspImgX, _perspImgY, _perspImgW, _perspImgH);
  ctx.restore();

  // Líneas del quad
  ctx.strokeStyle = '#00cfff';
  ctx.lineWidth   = 2;
  ctx.setLineDash([8, 4]);
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // Labels
  const labels = ['TL','TR','BR','BL'];
  const colors  = ['#ff4444','#ffaa00','#00dd88','#aa44ff'];

  _perspHandles.forEach((h, i) => {
    // Sombra
    ctx.beginPath();
    ctx.arc(h.x, h.y, _HANDLE_R + 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fill();
    // Handle
    ctx.beginPath();
    ctx.arc(h.x, h.y, _HANDLE_R, 0, Math.PI * 2);
    ctx.fillStyle = i === _perspDragIdx ? '#fff' : colors[i];
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Label
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labels[i], h.x, h.y);
  });
}

function _perspPt(e) {
  const r = _perspCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    x: (e.clientX - r.left),
    y: (e.clientY - r.top)
  };
}
function _perspMD(e) {
  const p = _perspPt(e);
  _perspDragIdx = -1;
  _perspHandles.forEach((h, i) => {
    if (Math.hypot(h.x - p.x, h.y - p.y) < _HANDLE_R + 8) _perspDragIdx = i;
  });
  if (_perspDragIdx >= 0) e.preventDefault();
}
function _perspMM(e) {
  if (_perspDragIdx < 0) return;
  e.preventDefault();
  const p = _perspPt(e);
  _perspHandles[_perspDragIdx] = p;
  _perspDraw();
}
function _perspMU() { _perspDragIdx = -1; _perspDraw(); }

function _perspTD(e) {
  e.preventDefault();
  const t = e.touches[0];
  _perspMD({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => {} });
}
function _perspTM(e) {
  e.preventDefault();
  const t = e.touches[0];
  _perspMM({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => {} });
}

function fvCancelPersp() {
  if (_perspCanvas) { _perspCanvas.remove(); _perspCanvas = null; }
  _perspActive  = false;
  _perspHandles = [];
  _perspDragIdx = -1;
  const _pb = document.getElementById('fv-persp-btn');    if (_pb) _pb.style.display = '';
  const _pa = document.getElementById('fv-persp-apply');  if (_pa) _pa.style.display = 'none';
  const _pc = document.getElementById('fv-persp-cancel'); if (_pc) _pc.style.display = 'none';
  ['fv-crop-btn','img-viewer-apply-rot'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = '';
  });
}

async function fvApplyPersp() {
  if (_perspHandles.length < 4) return;

  // Convertir handles (coords canvas display) a coords de imagen natural
  const toImg = h => ({
    x: (h.x - _perspImgX) / _perspImgW * _perspSrcImg.naturalWidth,
    y: (h.y - _perspImgY) / _perspImgH * _perspSrcImg.naturalHeight
  });
  const corners = _perspHandles.map(toImg); // TL, TR, BR, BL

  // Mostrar progreso
  document.getElementById('fv-persp-apply').textContent = '…';
  document.getElementById('fv-persp-apply').disabled = true;

  // Fuente en canvas
  const srcCvs = document.createElement('canvas');
  srcCvs.width  = _perspSrcImg.naturalWidth;
  srcCvs.height = _perspSrcImg.naturalHeight;
  srcCvs.getContext('2d').drawImage(_perspSrcImg, 0, 0);

  // Ejecutar warp en el siguiente tick para no congelar la UI
  await new Promise(r => setTimeout(r, 20));
  const outCvs = _perspWarp(srcCvs, corners);

  outCvs.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    // Actualizar imagen en el visor
    const img = document.getElementById('img-viewer-src');
    if (img) img.src = url;
    // Actualizar pending file para OCR/AI
    const key = _imgViewerFileKey;
    if (key) _pendingFiles[key] = new File([blob], key + '_corr.jpg', { type: 'image/jpeg' });
    fvCancelPersp();
  }, 'image/jpeg', 0.95);
}

// ── Matemática de perspectiva ──────────────────
function _gaussElim(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let mx = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[mx][c])) mx = r;
    [M[c], M[mx]] = [M[mx], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n] / M[i][i];
    for (let j = i - 1; j >= 0; j--) M[j][n] -= M[j][i] * x[i];
  }
  return x;
}

function _perspComputeH(from4, to4) {
  // H mapea from4[i] → to4[i]
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [fx, fy] = [from4[i].x, from4[i].y];
    const [tx, ty] = [to4[i].x,   to4[i].y];
    A.push([fx, fy, 1, 0, 0, 0, -tx * fx, -tx * fy]); b.push(tx);
    A.push([0, 0, 0, fx, fy, 1, -ty * fx, -ty * fy]); b.push(ty);
  }
  const h = _gaussElim(A, b);
  return [[h[0],h[1],h[2]],[h[3],h[4],h[5]],[h[6],h[7],1]];
}

function _perspApplyH(H, x, y) {
  const w = H[2][0]*x + H[2][1]*y + H[2][2];
  return { x: (H[0][0]*x + H[0][1]*y + H[0][2]) / w,
           y: (H[1][0]*x + H[1][1]*y + H[1][2]) / w };
}

function _perspWarp(srcCvs, corners) {
  // corners: TL, TR, BR, BL en píxeles de imagen fuente
  const [tl, tr, br, bl] = corners;
  const outW = Math.round(Math.max(
    Math.hypot(tr.x-tl.x, tr.y-tl.y),
    Math.hypot(br.x-bl.x, br.y-bl.y)
  ));
  const outH = Math.round(Math.max(
    Math.hypot(bl.x-tl.x, bl.y-tl.y),
    Math.hypot(br.x-tr.x, br.y-tr.y)
  ));

  // Limitar resolución máxima para mantener velocidad
  const MAX = 2400;
  const downscale = Math.min(1, MAX / Math.max(outW, outH));
  const dW = Math.round(outW * downscale);
  const dH = Math.round(outH * downscale);

  // H mapea píxel de salida → píxel de entrada (inverse mapping)
  const dstRect = [{x:0,y:0},{x:dW,y:0},{x:dW,y:dH},{x:0,y:dH}];
  const H = _perspComputeH(dstRect, corners.map(p => ({ x: p.x * downscale, y: p.y * downscale })));

  // Escalar fuente si se redujo
  let src = srcCvs;
  if (downscale < 1) {
    const tmp = document.createElement('canvas');
    tmp.width = Math.round(srcCvs.width * downscale);
    tmp.height = Math.round(srcCvs.height * downscale);
    tmp.getContext('2d').drawImage(srcCvs, 0, 0, tmp.width, tmp.height);
    src = tmp;
  }

  const outCvs = document.createElement('canvas');
  outCvs.width = dW; outCvs.height = dH;
  const outCtx = outCvs.getContext('2d');
  const outData = outCtx.createImageData(dW, dH);

  const srcCtx  = src.getContext('2d');
  const srcData = srcCtx.getImageData(0, 0, src.width, src.height).data;
  const sw = src.width, sh = src.height;

  for (let oy = 0; oy < dH; oy++) {
    for (let ox = 0; ox < dW; ox++) {
      const { x: sx, y: sy } = _perspApplyH(H, ox, oy);
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = x0 + 1,         y1 = y0 + 1;
      if (x0 < 0 || y0 < 0 || x1 >= sw || y1 >= sh) continue;
      const fx = sx - x0, fy = sy - y0;
      const oi = (oy * dW + ox) * 4;
      for (let c = 0; c < 3; c++) {
        const a = srcData[(y0*sw+x0)*4+c], b_ = srcData[(y0*sw+x1)*4+c];
        const d = srcData[(y1*sw+x0)*4+c], e_ = srcData[(y1*sw+x1)*4+c];
        outData.data[oi+c] = a*(1-fx)*(1-fy) + b_*fx*(1-fy) + d*(1-fx)*fy + e_*fx*fy;
      }
      outData.data[oi+3] = 255;
    }
  }
  outCtx.putImageData(outData, 0, 0);
  return outCvs;
}

let _fvTextVisible = false;
function fvToggleText() {
  const tp = document.getElementById('fv-text-panel');
  if (!tp) return;
  _fvTextVisible = !_fvTextVisible;
  tp.style.display = _fvTextVisible ? 'flex' : 'none';
  if (!_fvTextVisible) document.getElementById('fv-ocr-choice')?.remove();
  const fvEl = document.getElementById('float-img-viewer');
  if (fvEl) {
    fvEl.style.width = (_FV_BASE_W + (_fvTextVisible ? _FV_TXT_W : 0)) + 'px';
    // Forzar reposicionamiento del bloque al cambiar el ancho del visor
    // (el visor puede haberse movido pero igual hay que reubicar para que no tape el modal)
    fvEl.dataset.moved = '';
  }
  // Resetear posición del opener para que _fvAutoPosition recentre el bloque
  if (_fvLinked && _fvOpenerModal) {
    const _opCard = document.getElementById(_fvOpenerModal)?.querySelector('.modal-card');
    if (_opCard) { _opCard.style.transition = ''; _opCard.style.transform = ''; delete _opCard.dataset.dragged; }
  }
  _fvAutoPosition();
  const ta = document.getElementById('fv-text-area');
  if (_fvTextVisible && ta && !ta.value.trim()) {
    // Detectar si hay PDF en el visor
    const frame = document.getElementById('fv-pdf-frame');
    const isPdf = frame && frame.style.display !== 'none' && frame.src;
    if (isPdf) {
      // PDF: solo IA, nunca OCR tesseract
      if (_aiAvailable) {
        fvRunOCR();
      } else {
        ta.value = '⚠️ Se necesita API Key de IA para extraer texto de un PDF.';
        ta.setAttribute('readonly', '');
      }
    } else if (_aiAvailable) {
      _fvAskOcrOrAI();
    } else {
      fvRunOCR_tesseract();
    }
  }
}

function _fvAskOcrOrAI() {
  const ta  = document.getElementById('fv-text-area');
  const existing = document.getElementById('fv-ocr-choice');
  if (existing) return;
  const bar = document.createElement('div');
  bar.id = 'fv-ocr-choice';
  bar.style.cssText = 'position:absolute;bottom:8px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:10;background:var(--bg-card);border:1px solid var(--border-color);border-radius:10px;padding:8px 12px;box-shadow:0 4px 16px rgba(0,0,0,0.18);white-space:nowrap;';
  bar.innerHTML = `
    <span style="font-size:12px;color:var(--text-secondary);align-self:center;">Extraer texto con:</span>
    <button class="btn btn-sm" style="background:var(--accent-blue);color:#fff;border:none;border-radius:6px;padding:4px 12px;cursor:pointer;" onclick="document.getElementById('fv-ocr-choice')?.remove();fvRunOCR_tesseract()">
      <i class="fa-solid fa-font"></i> OCR
    </button>
    <button class="btn btn-sm" style="background:var(--accent-orange,#f59e0b);color:#fff;border:none;border-radius:6px;padding:4px 12px;cursor:pointer;" onclick="document.getElementById('fv-ocr-choice')?.remove();fvRunOCR()">
      <i class="fa-solid fa-wand-magic-sparkles"></i> IA
    </button>
  `;
  const body = document.getElementById('fv-body');
  if (body) body.style.position = 'relative';
  (body || document.getElementById('float-img-viewer')).appendChild(bar);
}

async function fvRunOCR_tesseract() {
  const ta  = document.getElementById('fv-text-area');
  const btn = document.getElementById('fv-ocr-run-btn');
  if (!ta) return;
  ta.value = 'Extrayendo texto (OCR)…';
  if (btn) btn.disabled = true;
  try {
    const img = document.getElementById('img-viewer-src');
    if (!img || !img.src || img.src === window.location.href) { ta.value = '(Sin imagen en el visor)'; return; }
    const response = await fetch(img.src);
    const blob = await response.blob();
    const fd = new FormData();
    fd.append('cedula_img', blob, 'visor.jpg');
    const res = await fetch('/api/ocr/cedula', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const d = await res.json();
    ta.value = (d.raw_text || d.text || '(Sin texto extraído)').trim();
    ta.removeAttribute('readonly');
  } catch (err) {
    ta.value = 'Error OCR: ' + err.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function fvRunOCR() {
  const ta  = document.getElementById('fv-text-area');
  const btn = document.getElementById('fv-ocr-run-btn');
  if (!ta) return;
  ta.value = 'Extrayendo texto con IA…';
  if (btn) btn.disabled = true;
  try {
    const frame = document.getElementById('fv-pdf-frame');
    const img   = document.getElementById('img-viewer-src');
    let blob;
    if (frame && frame.style.display !== 'none' && frame.src) {
      // PDF en el visor — obtener blob de la URL del frame
      const r = await fetch(frame.src.replace(/#.*$/, ''));
      blob = await r.blob();
    } else if (img && img.src && img.src !== window.location.href) {
      const r = await fetch(img.src);
      blob = await r.blob();
    } else {
      ta.value = '(Sin archivo en el visor)'; return;
    }
    const fd = new FormData();
    fd.append('img', blob, blob.type === 'application/pdf' ? 'doc.pdf' : 'visor.jpg');
    const res = await fetch('/api/ai/ocr-text', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const d = await res.json();
    ta.value = (d.text || '(Sin texto extraído)').trim();
    ta.removeAttribute('readonly');
  } catch (err) {
    ta.value = 'Error: ' + err.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function fvCopyText() {
  const ta = document.getElementById('fv-text-area');
  if (!ta || !ta.value) return;
  // Si hay texto seleccionado, copiar solo eso; si no, todo el contenido
  const selected = ta.value.substring(ta.selectionStart, ta.selectionEnd);
  const toCopy = selected.length > 0 ? selected : ta.value;
  navigator.clipboard.writeText(toCopy).then(() =>
    showToast(selected.length > 0 ? 'Selección copiada' : 'Texto completo copiado', 'success')
  );
}

let _fvPanX = 0, _fvPanY = 0;

function fvZoom(delta) {
  _imgViewerScale = Math.min(8, Math.max(0.05, _imgViewerScale + delta));
  _fvApplyTransform();
}
function fvZoomReset() {
  _fvAutoFit();
}
function rotateImgViewer(deg) {
  _imgViewerRot = ((_imgViewerRot + deg) % 360 + 360) % 360;
  _fvApplyTransform();
  // Activar botón guardar cuando hay rotación aplicada
  const applyBtn = document.getElementById('img-viewer-apply-rot');
  if (applyBtn) {
    const hasRot = _imgViewerRot !== 0;
    applyBtn.style.background = hasRot ? 'var(--accent-purple)' : 'var(--bg-tertiary)';
    applyBtn.style.color      = hasRot ? '#fff' : 'var(--text-secondary)';
    applyBtn.style.opacity    = hasRot ? '1'   : '0.45';
    applyBtn.style.cursor     = hasRot ? 'pointer' : 'default';
  }
}
function _fvApplyTransform() {
  const img = document.getElementById('img-viewer-src');
  if (img) img.style.transform = `translate(${_fvPanX}px,${_fvPanY}px) scale(${_imgViewerScale}) rotate(${_imgViewerRot}deg)`;
}
// Auto-fit: escala la imagen para que entre en el área del viewer
function _fvAutoFit() {
  const img  = document.getElementById('img-viewer-src');
  const body = document.getElementById('fv-body');
  const fv   = document.getElementById('float-img-viewer');
  if (!img || !body || !fv) return;

  const bw = body.clientWidth  - 4;
  const bh = body.clientHeight - 4;
  // Guard: si el visor no está visible aún, no hay medidas válidas
  if (bw <= 0 || bh <= 0) return;

  const iw = img.naturalWidth  || img.width  || 1;
  const ih = img.naturalHeight || img.height || 1;
  _imgViewerScale = Math.min(bw / iw, bh / ih);
  _fvPanX = 0; _fvPanY = 0;
  _fvApplyTransform();

  // Compactar el viewer para eliminar espacios negros (solo si no fue movido/redimensionado por el usuario)
  if (!fv.dataset.moved && !fv.dataset.userResized) {
    const titlebarH = document.getElementById('fv-titlebar')?.offsetHeight || 44;
    const tp = document.getElementById('fv-text-panel');
    const txtW = (tp && tp.style.display !== 'none') ? (tp.offsetWidth || _FV_TXT_W) : 0;
    const imgBodyW = fv.offsetWidth - txtW;
    // Recalcular escala con el ancho real disponible sin panel de texto
    const scaleW = (imgBodyW - 4) / iw;
    const scaleH = (bh) / ih;
    const finalScale = Math.min(scaleW, scaleH);
    _imgViewerScale = finalScale;
    _fvApplyTransform();
    // Solo ajustar ANCHO para eliminar barras negras laterales (la altura la controla _fvAutoPosition)
    const displayedW = Math.ceil(iw * finalScale) + 8;
    const idealW = displayedW + txtW + 6;
    const maxW = window.innerWidth - 24;
    const newW = Math.min(Math.max(idealW, 280), maxW);
    if (Math.abs(newW - fv.offsetWidth) > 16) {
      fv.style.width = newW + 'px';
      // _fvAutoPosition lee fv.offsetWidth (ya actualizado), no setea ancho → sin loop
      setTimeout(() => {
        _fvAutoPosition();
        if (_scrollArrowPositioner) _scrollArrowPositioner();
      }, 30);
    }
  }
}
// Inicializar pan con mouse dentro de #fv-body
function _initFvPan() {
  const fv   = document.getElementById('float-img-viewer');
  const body = document.getElementById('fv-body');
  if (!body || body.dataset.panBound) return;
  body.dataset.panBound = '1';
  // Detectar cuando el usuario redimensiona el viewer manualmente (drag del resize handle nativo)
  if (fv) {
    let _fvW = fv.offsetWidth, _fvH = fv.offsetHeight;
    const ro = new ResizeObserver(() => {
      if (fv.offsetWidth !== _fvW || fv.offsetHeight !== _fvH) {
        _fvW = fv.offsetWidth; _fvH = fv.offsetHeight;
        if (fv.dataset.moved || fv.dataset.userResized) fv.dataset.userResized = '1';
        setTimeout(_fvAutoFit, 30);
      }
    });
    ro.observe(fv);
  }
  let dragging = false, sx = 0, sy = 0, px = 0, py = 0;
  body.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    dragging = true; sx = e.clientX; sy = e.clientY; px = _fvPanX; py = _fvPanY;
    body.classList.add('fv-dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    _fvPanX = px + (e.clientX - sx);
    _fvPanY = py + (e.clientY - sy);
    _fvApplyTransform();
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    document.getElementById('fv-body')?.classList.remove('fv-dragging');
  });
  // Touch pan
  body.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    dragging = true; sx = e.touches[0].clientX; sy = e.touches[0].clientY; px = _fvPanX; py = _fvPanY;
  }, { passive: true });
  body.addEventListener('touchmove', e => {
    if (!dragging || e.touches.length !== 1) return;
    _fvPanX = px + (e.touches[0].clientX - sx);
    _fvPanY = py + (e.touches[0].clientY - sy);
    _fvApplyTransform();
  }, { passive: true });
  body.addEventListener('touchend', () => { dragging = false; });
}

// Zoom con rueda del mouse sobre el cuerpo del visor
document.addEventListener('DOMContentLoaded', () => {
  const body = document.getElementById('fv-body');
  if (body) {
    body.addEventListener('wheel', e => {
      if (!document.getElementById('float-img-viewer').style.display.includes('flex')) return;
      const frame = document.getElementById('fv-pdf-frame');
      if (frame && frame.style.display !== 'none') return; // dejar que el PDF maneje su scroll
      e.preventDefault();
      fvZoom(e.deltaY < 0 ? 0.12 : -0.12);
    }, { passive: false });
  }
  _initFloatViewerDrag();
  _initFloatViewerResize();
  _initAllModalsDrag();
  _initScrollNavBtns();
  SmartCombo.initAll();
  DatePicker.initAll();
});

// ── Resize desde todos los bordes para cualquier .modal-card ──────────────────
function _initModalCardResize(card) {
  if (card._mcResizeInit) return;
  card._mcResizeInit = true;

  const dirs = ['n','s','e','w','ne','nw','se','sw'];
  dirs.forEach(dir => {
    const h = document.createElement('div');
    h.className = 'mc-rh mc-rh-' + dir;
    h.dataset.dir = dir;
    card.appendChild(h);

    h.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();

      // Pasar a position:fixed con coordenadas absolutas para poder redimensionar
      const r = card.getBoundingClientRect();
      card.style.transition = 'none';
      card.style.position   = 'fixed';
      card.style.margin     = '0';
      card.style.left       = r.left + 'px';
      card.style.top        = r.top  + 'px';
      card.style.width      = r.width  + 'px';
      card.style.height     = r.height + 'px';
      card.style.transform  = '';
      card.style.maxWidth   = 'none';
      card.style.maxHeight  = 'none';

      const startX = e.clientX, startY = e.clientY;
      const startW = r.width, startH = r.height;
      const startL = r.left,  startT = r.top;

      const onMove = ev => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let w = startW, h2 = startH, l = startL, t = startT;

        if (dir.includes('e'))  w  = Math.max(340, startW + dx);
        if (dir.includes('s'))  h2 = Math.max(200, startH + dy);
        if (dir.includes('w')) { w  = Math.max(340, startW - dx); l = startL + (startW - w); }
        if (dir.includes('n')) { h2 = Math.max(200, startH - dy); t = startT + (startH - h2); }

        // Límite superior: el header nunca puede quedar fuera de pantalla
        if (t < 0) { h2 = Math.max(200, h2 + t); t = 0; }

        card.style.width  = w  + 'px';
        card.style.height = h2 + 'px';
        card.style.left   = l  + 'px';
        card.style.top    = t  + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  });
}

// Observar apertura de modales para inyectar resize
new MutationObserver(muts => {
  muts.forEach(m => {
    if (m.type === 'attributes' && m.target.classList.contains('active')) {
      const card = m.target.querySelector('.modal-card');
      if (card) _initModalCardResize(card);
    }
  });
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });

// ── Drag para todos los modales (transform-based, sin cambio de position) ─────
function _initAllModalsDrag() {
  let _dragCard = null, _dragOverlay = null;
  let _prevX, _prevY, _curTX, _curTY;

  document.addEventListener('mousedown', e => {
    const header = e.target.closest('.modal-overlay .modal-header');
    if (!header) return;
    if (e.target.closest('button, a, input, select, textarea')) return;
    const card = header.closest('.modal-card');
    if (!card) return;
    _dragOverlay = header.closest('.modal-overlay');
    e.preventDefault();

    // Leer translate actual para continuar desde ahí (sin salto)
    const m = new DOMMatrix(getComputedStyle(card).transform);
    _curTX = isFinite(m.m41) ? m.m41 : 0;
    _curTY = isFinite(m.m42) ? m.m42 : 0;
    _prevX = e.clientX; _prevY = e.clientY;
    _dragCard = card;
    card.dataset.dragged = '1';
    card.style.transition = '';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!_dragCard) return;
    const dX = e.clientX - _prevX;
    const dY = e.clientY - _prevY;
    _prevX = e.clientX; _prevY = e.clientY;
    _curTX += dX; _curTY += dY;
    _dragCard.style.transform = `translate(${_curTX}px,${_curTY}px)`;

    // Límites: barra de título siempre visible
    const rect    = _dragCard.getBoundingClientRect();
    const headerH = _dragCard.querySelector('.modal-header')?.offsetHeight || 48;
    if (rect.top < 4)                                    { _curTY += 4 - rect.top; _dragCard.style.transform = `translate(${_curTX}px,${_curTY}px)`; }
    if (rect.top > window.innerHeight - headerH - 4)    { _curTY -= rect.top - (window.innerHeight - headerH - 4); _dragCard.style.transform = `translate(${_curTX}px,${_curTY}px)`; }
    if (rect.right < 80)                                 { _curTX += 80 - rect.right; _dragCard.style.transform = `translate(${_curTX}px,${_curTY}px)`; }
    if (rect.left > window.innerWidth - 80)              { _curTX -= rect.left - (window.innerWidth - 80); _dragCard.style.transform = `translate(${_curTX}px,${_curTY}px)`; }

    // Flechas de scroll alineadas (sistema antiguo msa-wrap)
    if (_dragOverlay) {
      const arrows = document.getElementById(`msa-wrap-${_dragOverlay.id}`);
      if (arrows) { const r = _dragCard.getBoundingClientRect(); arrows.style.right = (window.innerWidth - r.right) + 'px'; }
    }
    // Botones Top/Bottom de _attachScrollNav (position:fixed, necesitan reposicionarse)
    window.dispatchEvent(new Event('flota:modalreposition'));

    // Dropdowns flotantes (marca/modelo)
    ['vh-marca-dropdown:vh-marca-input', 'vh-modelo-dropdown:vh-modelo-input'].forEach(pair => {
      const [dropId, inpId] = pair.split(':');
      const drop = document.getElementById(dropId); const inp = document.getElementById(inpId);
      if (drop && inp && drop.style.display !== 'none') {
        const r = inp.getBoundingClientRect();
        drop.style.top = r.bottom + 2 + 'px'; drop.style.left = r.left + 'px'; drop.style.width = r.width + 'px';
      }
    });

    // Arrastre conjunto: si vinculado y esta card es el opener, mover el visor también
    if (_fvLinked && _fvOpenerModal) {
      const openerModal = document.getElementById(_fvOpenerModal);
      const openerCard  = openerModal?.querySelector('.modal-card');
      if (openerCard === _dragCard) {
        const fv = document.getElementById('float-img-viewer');
        if (fv && fv.style.display !== 'none') {
          fv.style.left = (parseFloat(fv.style.left) + dX) + 'px';
          fv.style.top  = (parseFloat(fv.style.top)  + dY) + 'px';
        }
      }
    }

    // Arrastre conjunto WA acoplado: si WA está acoplado y se arrastra el opener, mover WA también
    if (_waDocked && _waOpenerModal) {
      const waOpenerCard = document.getElementById(_waOpenerModal)?.querySelector('.modal-card');
      if (waOpenerCard === _dragCard) {
        const waCard = document.getElementById('modal-whatsapp')?.querySelector('.modal-card');
        if (waCard) {
          const wm = new DOMMatrix(getComputedStyle(waCard).transform);
          const wx = (isFinite(wm.m41) ? wm.m41 : 0) + dX;
          const wy = (isFinite(wm.m42) ? wm.m42 : 0) + dY;
          waCard.style.transform = `translate(${wx}px,${wy}px)`;
        }
      }
      // Si se arrastra el card de WA cuando está acoplado, mover el opener también
      const waCard = document.getElementById('modal-whatsapp')?.querySelector('.modal-card');
      if (waCard === _dragCard) {
        const waOpenerCard2 = document.getElementById(_waOpenerModal)?.querySelector('.modal-card');
        if (waOpenerCard2) {
          const om = new DOMMatrix(getComputedStyle(waOpenerCard2).transform);
          const ox = (isFinite(om.m41) ? om.m41 : 0) + dX;
          const oy = (isFinite(om.m42) ? om.m42 : 0) + dY;
          waOpenerCard2.style.transform = `translate(${ox}px,${oy}px)`;
          waOpenerCard2.dataset.dragged = '1';
          // Actualizar flechas de scroll del opener
          const opOv = document.getElementById(_waOpenerModal);
          if (opOv) {
            const arrows = document.getElementById(`msa-wrap-${_waOpenerModal}`);
            if (arrows) { const r = waOpenerCard2.getBoundingClientRect(); arrows.style.right = (window.innerWidth - r.right) + 'px'; }
          }
        }
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (_dragCard) { _dragCard = null; document.body.style.userSelect = ''; }
  });
}

function _initScrollNavBtns() {
  // Aplica botones Top/Bottom a cualquier elemento con clase scroll-wrap que contenga un scrolleable
  // Y al sidebar-nav específicamente
  _attachScrollNav(document.querySelector('.sidebar-nav'), document.querySelector('.sidebar'));

  // Vista principal de contenido
  const vc = document.querySelector('.view-container');
  if (vc) _attachScrollNav(vc, vc);

  // Para tablas: se llama también desde injectExportBar al renderizar cada módulo
}

function _attachScrollNav(scrollEl, wrapEl) {
  if (!scrollEl || !wrapEl) return;
  if (scrollEl._scrollNavAttached) return;
  scrollEl._scrollNavAttached = true;

  // Usar position:fixed anclado al body para funcionar tanto en página como en modales
  const btns = document.createElement('div');
  btns.className = 'scroll-nav-btns';
  btns.innerHTML = `
    <button class="scroll-nav-btn" title="Ir al inicio"><i class="fa-solid fa-chevron-up"></i></button>
    <button class="scroll-nav-btn" title="Ir al final"><i class="fa-solid fa-chevron-down"></i></button>`;

  btns.querySelectorAll('.scroll-nav-btn').forEach((btn, i) => {
    btn.onclick = () => scrollEl.scrollTo({ top: i === 0 ? 0 : 999999, behavior: 'smooth' });
  });

  document.body.appendChild(btns);

  const reposition = () => {
    // Si el scrollEl vive dentro de un modal que ya no está activo → ocultar siempre
    const parentModal = scrollEl.closest?.('.modal-overlay');
    if (parentModal && !parentModal.classList.contains('active')) {
      btns.style.opacity = '0'; btns.style.pointerEvents = 'none'; return;
    }
    // Si hay otro modal activo encima y este scrollEl no está dentro → ocultar
    const activeModal = document.querySelector('.modal-overlay.active');
    if (activeModal && !activeModal.contains(scrollEl)) {
      btns.style.opacity = '0'; btns.style.pointerEvents = 'none'; return;
    }
    const r = scrollEl.getBoundingClientRect();
    // Ocultar si el elemento no está visible en viewport
    const visible = r.width > 0 && r.height > 10 && r.top < window.innerHeight && r.bottom > 0;
    if (!visible) { btns.style.opacity = '0'; btns.style.pointerEvents = 'none'; return; }
    const canScroll = scrollEl.scrollHeight > scrollEl.clientHeight + 20;
    btns.style.opacity = canScroll ? '1' : '0';
    btns.style.pointerEvents = canScroll ? 'auto' : 'none';
    btns.style.top = (r.top + r.height / 2) + 'px';
    btns.style.left = (r.right - 18) + 'px';
  };

  // Escuchar scroll en el propio elemento y en cualquier ancestro scrolleable
  const scrollListeners = [];
  let el = scrollEl;
  while (el) {
    el.addEventListener('scroll', reposition, { passive: true });
    scrollListeners.push(el);
    el = el.parentElement;
  }

  const ro = new ResizeObserver(reposition);
  ro.observe(scrollEl);
  ro.observe(document.body);

  // Ocultar al cerrar cualquier modal, y también al ABRIR (scroll nav no aplica cuando hay modal encima)
  window.addEventListener('flota:modalclose', reposition, { passive: true });
  window.addEventListener('flota:modalreposition', reposition, { passive: true });
  window.addEventListener('flota:tablerender', reposition, { passive: true });
  const hideForModal = () => { btns.style.opacity = '0'; btns.style.pointerEvents = 'none'; };
  window.addEventListener('flota:modalopen', hideForModal, { passive: true });

  // Exponer reposition para llamada directa desde injectExportBar y renders
  scrollEl._scrollNavReposition = reposition;

  // Limpiar si el elemento es removido del DOM
  new MutationObserver(() => {
    if (!document.body.contains(scrollEl)) {
      btns.remove();
      scrollListeners.forEach(e => e.removeEventListener('scroll', reposition));
      window.removeEventListener('flota:modalclose', reposition);
      window.removeEventListener('flota:modalreposition', reposition);
      window.removeEventListener('flota:tablerender', reposition);
      window.removeEventListener('flota:modalopen', hideForModal);
      ro.disconnect();
    }
  }).observe(document.body, { childList: true, subtree: true });

  reposition();
}

function _initFloatViewerResize() {
  const fv = document.getElementById('float-img-viewer');
  if (!fv) return;
  const handles = fv.querySelectorAll('.fv-resize-handle');
  handles.forEach(h => {
    h.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      const dir   = h.dataset.dir;
      const startX = e.clientX, startY = e.clientY;
      const r      = fv.getBoundingClientRect();
      const startW = r.width, startH = r.height;
      const startL = r.left,  startT = r.top;

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let newW = startW, newH = startH, newL = startL, newT = startT;

        if (dir.includes('e'))  newW = Math.max(320, startW + dx);
        if (dir.includes('s'))  newH = Math.max(200, startH + dy);
        if (dir.includes('w')) { newW = Math.max(320, startW - dx); newL = startL + (startW - newW); }
        if (dir.includes('n')) { newH = Math.max(200, startH - dy); newT = startT + (startH - newH); }

        fv.style.width    = newW + 'px';
        fv.style.height   = newH + 'px';
        fv.style.left     = newL + 'px';
        fv.style.top      = newT + 'px';
        fv.style.transform = '';
        fv.dataset.moved  = '1';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  });
}

function _initFloatViewerDrag() {
  const fv     = document.getElementById('float-img-viewer');
  const handle = document.getElementById('fv-titlebar');
  if (!fv || !handle) return;
  // Traer al frente al hacer click en cualquier parte del visor
  fv.addEventListener('mousedown', () => { fv.style.zIndex = '12000'; }, { capture: true });
  document.addEventListener('mousedown', e => { if (!fv.contains(e.target)) fv.style.zIndex = '11000'; }, { capture: true });
  let dragging = false, _prevFvX, _prevFvY;
  handle.addEventListener('mousedown', e => {
    if (e.target.closest('button,a')) return;
    dragging = true;
    // Anclar posición absoluta desde la visual actual (sin salto)
    const rect = fv.getBoundingClientRect();
    fv.style.left      = rect.left + 'px';
    fv.style.top       = rect.top  + 'px';
    fv.style.transform = 'none';
    _prevFvX = e.clientX; _prevFvY = e.clientY;
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dX = e.clientX - _prevFvX;
    const dY = e.clientY - _prevFvY;
    _prevFvX = e.clientX; _prevFvY = e.clientY;

    const titleH   = handle.offsetHeight || 44;
    const newLeft  = Math.max(-(fv.offsetWidth - 120), Math.min(parseFloat(fv.style.left) + dX, window.innerWidth - 120));
    const newTop   = Math.max(4, Math.min(parseFloat(fv.style.top) + dY, window.innerHeight - titleH - 4));
    fv.style.left  = newLeft + 'px';
    fv.style.top   = newTop  + 'px';
    fv.dataset.moved = '1';

    // Arrastre conjunto: mover el modal opener con el mismo delta
    if (_fvLinked && _fvOpenerModal) {
      const openerModal = document.getElementById(_fvOpenerModal);
      const openerCard  = openerModal?.querySelector('.modal-card');
      if (openerCard) {
        const m = new DOMMatrix(getComputedStyle(openerCard).transform);
        const curTX = isFinite(m.m41) ? m.m41 : 0;
        const curTY = isFinite(m.m42) ? m.m42 : 0;
        openerCard.style.transition = '';
        openerCard.style.transform  = `translate(${curTX + dX}px,${curTY + dY}px)`;
        openerCard.dataset.dragged  = '1';
      }
    }
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.userSelect = '';
  });
}

function _fvSaveCurrentForm() {
  // La imagen recortada ya está en _pendingFiles y en la preview del dropzone.
  // Solo cerramos el visor — el usuario guarda desde el formulario normalmente.
  closeFloatViewer();
  showAlert('✓ Recorte listo. Completá los datos y usá el botón Guardar del formulario.');
}

function applyImgViewerRotation() {
  // Si hay un recorte pendiente de guardar, disparar save del formulario
  if (_fvCropPending) {
    _fvCropPending = false;
    _fvSaveCurrentForm();
    return;
  }
  if (!_imgViewerRot || _imgViewerRot % 360 === 0) {
    showAlert('La imagen ya está en su orientación original.'); return;
  }
  const img = document.getElementById('img-viewer-src');
  if (!img || !img.src) return;
  const canvas = document.createElement('canvas');
  const tmpImg = new Image();
  tmpImg.crossOrigin = 'anonymous';
  tmpImg.onload = () => {
    const rad = (_imgViewerRot * Math.PI) / 180;
    const sin = Math.abs(Math.sin(rad)), cos = Math.abs(Math.cos(rad));
    canvas.width  = Math.round(tmpImg.width * cos + tmpImg.height * sin);
    canvas.height = Math.round(tmpImg.width * sin + tmpImg.height * cos);
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(tmpImg, -tmpImg.width / 2, -tmpImg.height / 2);
    canvas.toBlob(blob => {
      if (!blob) return;
      const newSrc = URL.createObjectURL(blob);
      img.src = newSrc;
      _imgViewerRot = 0; _fvPanX = 0; _fvPanY = 0;
      _fvApplyTransform();
      setTimeout(_fvAutoFit, 50); // re-fit tras cambio de dimensiones
      const dl = document.getElementById('img-viewer-download');
      if (dl) { dl.href = newSrc; }
      // Resetear botón guardar a inactivo
      const applyBtn = document.getElementById('img-viewer-apply-rot');
      if (applyBtn) {
        applyBtn.style.background = 'var(--bg-tertiary)';
        applyBtn.style.color      = 'var(--text-secondary)';
        applyBtn.style.opacity    = '0.45';
        applyBtn.style.cursor     = 'default';
      }
      if (_imgViewerFileKey) {
        const fname = (_imgViewerFileKey || 'imagen') + '.jpg';
        const newFile = new File([blob], fname, { type: 'image/jpeg' });
        if (_choferFiles && _imgViewerFileKey in _choferFiles) _choferFiles[_imgViewerFileKey] = newFile;
        // Siempre actualizar _pendingFiles (aunque la clave no existiera antes)
        if (!_pendingFiles) _pendingFiles = {};
        _pendingFiles[_imgViewerFileKey] = newFile;
        const prevMap = {
          'dni_frente':    'ch-prev-dni-frente',   'dni_dorso':  'ch-prev-dni-dorso',
          'reg_frente':    'ch-prev-reg-frente',    'reg_dorso':  'ch-prev-reg-dorso',
          'cedula_frente': 'cedula-prev-frente',    'cedula_dorso': 'cedula-prev-dorso',
          'foto_frente':   'foto-prev-frente',      'foto_lat_der': 'foto-prev-lat-der',
          'foto_lat_izq':  'foto-prev-lat-izq',     'foto_detras':  'foto-prev-detras',
          'gnc_oblea':     'gnc-oblea-preview',
          'seg_poliza':    'seg-poliza-prev',
          'vtv_frente':    'vtv-prev-frente',       'vtv_dorso': 'vtv-prev-dorso',
        };
        const prevId = prevMap[_imgViewerFileKey];
        if (prevId) { const el = document.getElementById(prevId); if (el) el.src = newSrc; }
      }
      showAlert('✓ Rotación aplicada.');
    }, 'image/jpeg', 0.92);
  };
  tmpImg.src = img.src;
}

// ─── CROP DEL VISOR FLOTANTE ─────────────────────────────────────────────────
let _fvCropActive = false;
let _fvCropStart  = null;   // {x,y} en coords del fv-body
let _fvCropRect   = null;   // {x,y,w,h} en coords del fv-body
let _fvCropMouseMove = null;
let _fvCropMouseUp   = null;

function fvToggleCrop() {
  if (_fvCropActive) { fvCancelCrop(); return; }
  _fvCropActive = true;
  _fvCropRect   = null;
  _fvCropStart  = null;
  const body    = document.getElementById('fv-body');
  const overlay = document.getElementById('fv-crop-overlay');
  const sel     = document.getElementById('fv-crop-sel');
  const btn     = document.getElementById('fv-crop-btn');
  const applyBtn= document.getElementById('fv-crop-apply');
  const cancelBtn=document.getElementById('fv-crop-cancel');
  if (!body || !overlay) return;

  body.classList.add('fv-crop-mode');
  overlay.style.display = 'block';
  sel.style.display = 'none';
  if (btn)       btn.classList.add('active');
  if (applyBtn)  applyBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';

  // Estado: false = esperando 1er click, true = esperando 2do click
  let _waitingSecond = false;

  function getPos(e) {
    const r  = overlay.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    return {x: cx, y: cy};
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const pos = getPos(e);

    if (!_waitingSecond) {
      // 1er click: fijar punto de inicio
      _fvCropStart    = pos;
      _fvCropRect     = null;
      _waitingSecond  = true;
      if (applyBtn) applyBtn.style.display = 'none';
      sel.style.left    = pos.x + 'px';
      sel.style.top     = pos.y + 'px';
      sel.style.width   = '0px';
      sel.style.height  = '0px';
      sel.style.display = 'block';
    } else {
      // 2do click: fijar punto final
      const x = Math.min(pos.x, _fvCropStart.x);
      const y = Math.min(pos.y, _fvCropStart.y);
      const w = Math.abs(pos.x - _fvCropStart.x);
      const h = Math.abs(pos.y - _fvCropStart.y);
      _waitingSecond = false;
      if (w < 10 || h < 10) {
        // demasiado chico, reiniciar
        _fvCropStart = null;
        sel.style.display = 'none';
        return;
      }
      _fvCropRect = {x, y, w, h};
      sel.style.left   = x + 'px';
      sel.style.top    = y + 'px';
      sel.style.width  = w + 'px';
      sel.style.height = h + 'px';
      if (applyBtn) applyBtn.style.display = 'inline-flex';
    }
  }

  function onMove(e) {
    if (!_waitingSecond || !_fvCropStart) return;
    const pos = getPos(e);
    const x = Math.min(pos.x, _fvCropStart.x);
    const y = Math.min(pos.y, _fvCropStart.y);
    const w = Math.abs(pos.x - _fvCropStart.x);
    const h = Math.abs(pos.y - _fvCropStart.y);
    sel.style.left   = x + 'px';
    sel.style.top    = y + 'px';
    sel.style.width  = w + 'px';
    sel.style.height = h + 'px';
  }

  _fvCropMouseMove = onMove;
  _fvCropMouseUp   = onClick; // reutilizamos el slot para removeEventListener

  overlay.addEventListener('click',     onClick);
  overlay.addEventListener('mousemove', onMove);
  overlay.addEventListener('touchend',  onClick);
}

function fvCancelCrop() {
  if (!_fvCropActive && !document.getElementById('fv-crop-overlay')?.style?.display?.includes('block')) return;
  _fvCropActive = false;
  _fvCropStart  = null;
  _fvCropRect   = null;
  const body    = document.getElementById('fv-body');
  const overlay = document.getElementById('fv-crop-overlay');
  const sel     = document.getElementById('fv-crop-sel');
  const btn     = document.getElementById('fv-crop-btn');
  const applyBtn= document.getElementById('fv-crop-apply');
  const cancelBtn=document.getElementById('fv-crop-cancel');
  // Los listeners están en el overlay → el replaceWith los limpia todos
  _fvCropMouseMove = null;
  _fvCropMouseUp   = null;
  if (body)    body.classList.remove('fv-crop-mode');
  if (overlay) { overlay.style.display = 'none'; overlay.replaceWith(overlay.cloneNode(true)); } // remove overlay listeners
  if (sel)     sel.style.display = 'none';
  if (btn)     btn.classList.remove('active');
  if (applyBtn) applyBtn.style.display = 'none';
  if (cancelBtn)cancelBtn.style.display = 'none';
}

function fvApplyCrop() {
  if (!_fvCropRect || _fvCropRect.w < 10 || _fvCropRect.h < 10) {
    showAlert('Seleccioná un área primero.'); return;
  }
  const img = document.getElementById('img-viewer-src');
  if (!img || !img.src) return;

  // Las coords del rect están en el espacio del fv-body (viewport del contenedor).
  // La imagen tiene transform: translate + scale + rotate aplicado.
  // Para obtener las coords en píxeles de imagen original, invertimos la transformada.
  const scale = _imgViewerScale || 1;
  const rot   = ((_imgViewerRot % 360) + 360) % 360; // normalizar 0-359

  // Rect en coords del contenedor centrado en la imagen
  const body   = document.getElementById('fv-body');
  const bRect  = body.getBoundingClientRect();
  const iRect  = img.getBoundingClientRect();

  // Esquinas del rect de selección (relativas a fv-body)
  const rx = _fvCropRect.x, ry = _fvCropRect.y, rw = _fvCropRect.w, rh = _fvCropRect.h;

  // Las coords absolutas de la imagen renderizada en pantalla:
  const imgLeft   = iRect.left - bRect.left;
  const imgTop    = iRect.top  - bRect.top;
  const imgWidth  = iRect.width;
  const imgHeight = iRect.height;

  // Convertir coords del recorte a coords relativas a la imagen renderizada
  const relX = rx - imgLeft;
  const relY = ry - imgTop;
  const relW = rw;
  const relH = rh;

  // Convertir a coords en la imagen original (sin escala, sin rotación aplicada a canvas)
  // Usamos la imagen natural para el canvas y le aplicamos la transformación inversa.
  const natW = img.naturalWidth;
  const natH = img.naturalHeight;

  const tmpImg = new Image();
  tmpImg.crossOrigin = 'anonymous';
  tmpImg.onload = () => {
    // Paso 1: crear canvas con la imagen rotada (igual que applyImgViewerRotation)
    const rad = (rot * Math.PI) / 180;
    const sin = Math.abs(Math.sin(rad)), cos = Math.abs(Math.cos(rad));
    const rotW = Math.round(natW * cos + natH * sin);
    const rotH = Math.round(natW * sin + natH * cos);

    const rotCanvas = document.createElement('canvas');
    rotCanvas.width  = rotW;
    rotCanvas.height = rotH;
    const rCtx = rotCanvas.getContext('2d');
    rCtx.translate(rotW / 2, rotH / 2);
    rCtx.rotate(rad);
    rCtx.drawImage(tmpImg, -natW / 2, -natH / 2);

    // Paso 2: la imagen renderizada tiene dimensiones imgWidth x imgHeight en pantalla
    // → factor de escala entre imagen rotada y pantalla
    const scaleX = rotW / imgWidth;
    const scaleY = rotH / imgHeight;

    // Coordenadas de recorte en la imagen rotada (espacio original de píxeles)
    const cropX = Math.max(0, Math.round(relX * scaleX));
    const cropY = Math.max(0, Math.round(relY * scaleY));
    const cropW = Math.min(Math.round(relW * scaleX), rotW - cropX);
    const cropH = Math.min(Math.round(relH * scaleY), rotH - cropY);

    if (cropW < 10 || cropH < 10) { showAlert('El área seleccionada es demasiado pequeña.'); return; }

    // Paso 3: recortar
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width  = cropW;
    cropCanvas.height = cropH;
    cropCanvas.getContext('2d').drawImage(rotCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    cropCanvas.toBlob(blob => {
      if (!blob) return;
      const newSrc = URL.createObjectURL(blob);

      // Actualizar imagen en visor
      img.src = newSrc;
      _imgViewerRot = 0; _fvPanX = 0; _fvPanY = 0;
      _fvApplyTransform();
      setTimeout(_fvAutoFit, 50);

      // Actualizar link de descarga
      const dl = document.getElementById('img-viewer-download');
      if (dl) dl.href = newSrc;

      // Actualizar _pendingFiles / _choferFiles y la preview en el formulario
      if (_imgViewerFileKey) {
        const fname = (_imgViewerFileKey || 'imagen') + '_crop.jpg';
        const newFile = new File([blob], fname, {type: 'image/jpeg'});
        // Siempre asignar, aunque la clave no existiera (imagen ya guardada en servidor)
        if (!_pendingFiles) _pendingFiles = {};
        _pendingFiles[_imgViewerFileKey] = newFile;
        if (_choferFiles && _imgViewerFileKey in _choferFiles) _choferFiles[_imgViewerFileKey] = newFile;
        const prevMap = {
          'p_dni_frente':  'p-prev-dni-frente',    'p_dni_dorso':   'p-prev-dni-dorso',
          'usr_dni_frente':'usr-prev-dni-frente',  'usr_dni_dorso': 'usr-prev-dni-dorso',
          'dni_frente':    'ch-prev-dni-frente',   'dni_dorso':     'ch-prev-dni-dorso',
          'reg_frente':    'ch-prev-reg-frente',   'reg_dorso':     'ch-prev-reg-dorso',
          'cedula_frente': 'cedula-prev-frente',   'cedula_dorso':  'cedula-prev-dorso',
          'foto_frente':   'foto-prev-frente',     'foto_lat_der':  'foto-prev-lat-der',
          'foto_lat_izq':  'foto-prev-lat-izq',    'foto_detras':   'foto-prev-detras',
          'gnc_oblea':     'gnc-oblea-preview',
          'seg_poliza':    'seg-poliza-prev',
          'vtv_frente':    'vtv-prev-frente',      'vtv_dorso':     'vtv-prev-dorso',
        };
        const prevId = prevMap[_imgViewerFileKey];
        if (prevId) { const el = document.getElementById(prevId); if (el) el.src = newSrc; }
        if (_openViewerDzRef?._img) { _openViewerDzRef._img.src = newSrc; _openViewerDzRef._existingUrl = newSrc; }
      } else if (_openViewerDzRef?._img) {
        _openViewerDzRef._img.src = newSrc;
        _openViewerDzRef._existingUrl = newSrc;
      }

      // Marcar que hay recorte pendiente de guardar y activar botón 💾
      _fvCropPending = true;
      const applyRotBtn = document.getElementById('img-viewer-apply-rot');
      if (applyRotBtn) {
        applyRotBtn.style.background = '#7c3aed';
        applyRotBtn.style.color      = '#fff';
        applyRotBtn.style.opacity    = '1';
        applyRotBtn.style.cursor     = 'pointer';
        applyRotBtn.title            = 'Confirmar recorte y cerrar visor';
      }

      fvCancelCrop();
      showAlert('✓ Recorte listo — guardá el registro para confirmar.');
    }, 'image/jpeg', 0.92);
  };
  tmpImg.src = img.src;
}
// ─────────────────────────────────────────────────────────────────────────────

function showInlineMap(containerId, lat, lng, label) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const delta = 0.004; // zoom ~16
  const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;
  container.innerHTML = `
    <div style="position:relative;border-radius:10px;overflow:hidden;border:1px solid var(--border-color);margin-top:8px;">
      <div style="position:absolute;top:6px;left:6px;z-index:10;background:rgba(0,0,0,.55);color:#fff;font-size:11px;padding:3px 8px;border-radius:6px;max-width:80%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        📍 ${label || `${lat}, ${lng}`}
      </div>
      <a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}&zoom=16" target="_blank"
         title="Abrir en OpenStreetMap"
         style="position:absolute;bottom:6px;right:6px;z-index:10;background:rgba(0,0,0,.55);color:#fff;font-size:11px;padding:3px 8px;border-radius:6px;text-decoration:none;">
        <i class="fa-solid fa-up-right-from-square"></i> Ver más grande
      </a>
      <iframe
        src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}"
        style="width:100%;height:220px;border:none;display:block;"
        loading="lazy"
        referrerpolicy="no-referrer">
      </iframe>
    </div>`;
  container.style.display = 'block';
}

function hideInlineMap(containerId) {
  const c = document.getElementById(containerId);
  if (c) { c.innerHTML = ''; c.style.display = 'none'; }
}

// --- Sucursales ---
async function loadSucursales(proveedorId) {
  const tbody = document.getElementById('sucursales-table-body');
  tbody.innerHTML = '';
  try {
    const res = await fetch(`/api/proveedores/${proveedorId}/sucursales`);
    const list = await res.json();
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--placeholder-color);">Sin sucursales cargadas</td></tr>';
      return;
    }
    list.forEach(s => {
      const tr = document.createElement('tr');
      const gps = s.lat && s.lng ? `<span title="GPS disponible" style="color:var(--color-success)"><i class="fa-solid fa-location-dot"></i></span>` : '-';
      tr.innerHTML = `
        <td>${s.nombre}</td>
        <td>${s.domicilio || '-'}</td>
        <td>${s.telefono || '-'}</td>
        <td>${s.email || '-'}</td>
        <td>${gps}</td>
        <td style="text-align:center;">
          <button class="tbl-action-btn tbl-btn-edit"   onclick="editSucursal(${s.id})"   title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
          <button class="tbl-action-btn tbl-btn-delete" onclick="deleteSucursal(${s.id})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch(e) { console.error(e); }
}

let _cachedSucursales = [];

function openAddSucursalForm() {
  document.getElementById('suc-id').value = '';
  document.getElementById('suc-nombre').value = '';
  document.getElementById('suc-telefono').value = '';
  document.getElementById('suc-email').value = '';
  document.getElementById('suc-domicilio').value = '';
  document.getElementById('suc-entre-calles').value = '';
  document.getElementById('suc-cp').value = '';
  document.getElementById('suc-lat').value = '';
  document.getElementById('suc-lng').value = '';
  document.getElementById('suc-gps-status').textContent = '';
  document.getElementById('sucursal-form-area').style.display = 'block';
}

function closeSucursalForm() {
  document.getElementById('sucursal-form-area').style.display = 'none';
}

async function saveSucursal() {
  const provId = document.getElementById('prov-id').value;
  if (!provId) { showAlert('Guardá el proveedor primero.'); return; }
  const nombre = document.getElementById('suc-nombre').value.trim();
  if (!nombre) { showAlert('El nombre de la sucursal es obligatorio.'); return; }
  const sucId = document.getElementById('suc-id').value;
  const isEdit = sucId !== '';
  const data = {
    nombre,
    domicilio: document.getElementById('suc-domicilio').value || null,
    entre_calles: document.getElementById('suc-entre-calles').value.trim() || null,
    codigo_postal: document.getElementById('suc-cp').value || null,
    lat: document.getElementById('suc-lat').value || null,
    lng: document.getElementById('suc-lng').value || null,
    telefono: sanitizePhone(document.getElementById('suc-telefono').value),
    email: document.getElementById('suc-email').value || null,
  };
  try {
    const url = isEdit ? `/api/proveedores/${provId}/sucursales/${sucId}` : `/api/proveedores/${provId}/sucursales`;
    await fetch(url, { method: isEdit ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    closeSucursalForm();
    loadSucursales(provId);
    showToast('Sucursal guardada');
  } catch(e) { showAlert('Error al guardar sucursal.', 'error', 'error'); }
}

async function editSucursal(id) {
  const provId = document.getElementById('prov-id').value;
  const res = await fetch(`/api/proveedores/${provId}/sucursales`);
  const list = await res.json();
  const s = list.find(x => x.id === id);
  if (!s) return;
  document.getElementById('suc-id').value = s.id;
  document.getElementById('suc-nombre').value = s.nombre;
  document.getElementById('suc-telefono').value = s.telefono || '';
  document.getElementById('suc-email').value = s.email || '';
  document.getElementById('suc-domicilio').value = s.domicilio || '';
  document.getElementById('suc-entre-calles').value = s.entre_calles || '';
  document.getElementById('suc-cp').value = s.codigo_postal || '';
  document.getElementById('suc-lat').value = s.lat || '';
  document.getElementById('suc-lng').value = s.lng || '';
  const st = document.getElementById('suc-gps-status');
  if (s.lat && s.lng) {
    st.textContent = `📍 ${parseFloat(s.lat).toFixed(5)}, ${parseFloat(s.lng).toFixed(5)}`;
    st.style.color = 'var(--color-success)';
    showInlineMap('suc-map', parseFloat(s.lat), parseFloat(s.lng), s.domicilio || s.nombre);
    const mb = document.getElementById('suc-map-btn'); if (mb) mb.style.display = '';
  } else {
    st.textContent = '';
    hideInlineMap('suc-map');
    const mb = document.getElementById('suc-map-btn'); if (mb) mb.style.display = 'none';
  }
  document.getElementById('sucursal-form-area').style.display = 'block';
}

async function deleteSucursal(id) {
  if (!await showConfirm('¿Eliminar esta sucursal?')) return;
  const provId = document.getElementById('prov-id').value;
  await fetch(`/api/proveedores/${provId}/sucursales/${id}`, { method: 'DELETE' });
  loadSucursales(provId);
}

// Helper: load condiciones fiscales into a select
async function loadCondicionesFiscalesSelect(selectId, selectedId = null) {
  try {
    const res = await fetch('/api/condiciones-fiscales');
    const list = await res.json();
    const sel = document.getElementById(selectId);
    const current = sel.value;
    sel.innerHTML = '<option value="">-- Seleccionar --</option>';
    list.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.nombre || c.descripcion || c.condicion;
      if (selectedId && c.id == selectedId) opt.selected = true;
      sel.appendChild(opt);
    });
    if (!selectedId && current) sel.value = current;
  } catch(e) { console.error('condiciones fiscales:', e); }
}

// Simple toast notification
// ── Anime.js utilities ────────────────────────────────────────────────────────

// Contador animado: anima el número dentro de `el` desde 0 hasta `targetVal`
// fmtFn: función de formato (ej: formatCurrency, v => v + ' registros')
function animateCounter(el, targetVal, fmtFn) {
  if (!window.anime || !el) return;
  const num = parseFloat(String(targetVal).replace(/[^0-9.-]/g, '')) || 0;
  if (num === 0) { el.textContent = fmtFn ? fmtFn(0) : '0'; return; }
  const obj = { val: 0 };
  anime({
    targets: obj,
    val: num,
    duration: 900,
    easing: 'easeOutExpo',
    update() { el.textContent = fmtFn ? fmtFn(obj.val) : Math.round(obj.val).toLocaleString('es-AR'); }
  });
}

// Stagger de filas de tabla al cargar — llama después de poblar el tbody
function staggerTableRows(tbodyOrId) {
  if (!window.anime) return;
  const tbody = typeof tbodyOrId === 'string' ? document.getElementById(tbodyOrId) : tbodyOrId;
  if (!tbody) return;
  const rows = [...tbody.querySelectorAll('tr')];
  if (!rows.length) return;
  rows.forEach(r => { r.style.opacity = '0'; r.style.transform = 'translateY(8px)'; });
  anime({
    targets: rows,
    opacity: [0, 1],
    translateY: [8, 0],
    duration: 280,
    delay: anime.stagger(28, { start: 30 }),
    easing: 'easeOutQuad'
  });
}

// Shake en un elemento (error)
function shakeEl(el) {
  if (!window.anime || !el) return;
  anime({ targets: el, translateX: [0, -8, 8, -6, 6, -3, 3, 0], duration: 420, easing: 'easeInOutSine' });
}

// Pulse/bounce en un elemento (éxito)
function pulseEl(el) {
  if (!window.anime || !el) return;
  anime({ targets: el, scale: [1, 1.06, 0.97, 1], duration: 380, easing: 'easeInOutBack' });
}

function showToast(msg, type) {
  let t = document.getElementById('_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '_toast';
    t.style.cssText = 'position:fixed;bottom:30px;right:30px;color:#fff;padding:10px 20px;border-radius:8px;z-index:99999;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
    document.body.appendChild(t);
  }
  const bg = type === 'error' ? '#dc2626' : type === 'warning' ? '#d97706' : type === 'success' ? '#16a34a' : 'var(--accent-color)';
  t.style.background = bg;
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2500);
  // feedback animado
  if (window.anime) {
    if (type === 'error')   shakeEl(t);
    else if (type === 'success') pulseEl(t);
    else anime({ targets: t, translateY: [20, 0], opacity: [0, 1], duration: 320, easing: 'easeOutBack' });
  }
}

// ============================================================
// MULTAS CRUD
// ============================================================
let _cachedMultas = [];
let _dzMultaOcr   = null;  // DropZone estándar para escanear la infracción (tab Datos)
let _dzMultaPago  = null;  // DropZone estándar para comprobante de pago

function clearMultasFilters() {
  _clearSelect('multas-filter-vehiculo');
  _clearSelect('multas-filter-chofer');
  _clearSelect('multas-filter-estado');
  _clearSelect('multas-filter-municipalidad');
  const d = document.getElementById('multas-filter-desde'); if (d) d.value = '';
  const h = document.getElementById('multas-filter-hasta'); if (h) h.value = '';
  loadMultas();
}

async function loadMultas() {
  try {
    const chofer        = document.getElementById('multas-filter-chofer')?.value || '';
    const vehiculo      = document.getElementById('multas-filter-vehiculo')?.value || '';
    const estado        = document.getElementById('multas-filter-estado')?.value || '';
    const desde         = document.getElementById('multas-filter-desde')?.value || '';
    const hasta         = document.getElementById('multas-filter-hasta')?.value || '';
    const municipalidad = document.getElementById('multas-filter-municipalidad')?.value || '';
    const params = new URLSearchParams();
    if (chofer)        params.set('chofer_id',        chofer);
    if (vehiculo)      params.set('vehiculo_id',      vehiculo);
    if (estado)        params.set('estado',           estado);
    if (desde)         params.set('desde',            desde);
    if (hasta)         params.set('hasta',            hasta);
    if (municipalidad) params.set('municipalidad_id', municipalidad);
    const res = await fetch('/api/multas?' + params.toString());
    _cachedMultas = await res.json();
    const badge = document.getElementById('multas-total-badge');
    if (badge) {
      const total = _cachedMultas.reduce((s, m) => s + parseFloat(m.monto || 0), 0);
      badge.textContent = _cachedMultas.length ? formatCurrency(total) : '';
    }
    const multasCountBadge = document.getElementById('multas-count-badge');
    if (multasCountBadge) multasCountBadge.textContent = _cachedMultas.length ? `${_cachedMultas.length} multa${_cachedMultas.length !== 1 ? 's' : ''}` : '';
    const multasRow = document.getElementById('multas-totals-row');
    if (multasRow) multasRow.style.display = _cachedMultas.length ? '' : 'none';
    const tbody = document.getElementById('multas-table-body');
    tbody.innerHTML = '';
    _cachedMultas.forEach((m, idx) => {
      const estadoColors = { pendiente:'badge-warning', pagada:'badge-success', impugnada:'badge-info', vencida:'badge-danger', anulada:'badge-secondary' };
      const cl = estadoColors[m.estado] || 'badge-secondary';
      const venc = m.fecha_vencimiento ? (new Date(m.fecha_vencimiento) < new Date() ? `<span style="color:var(--color-error)">${formatDate(m.fecha_vencimiento)}</span>` : formatDate(m.fecha_vencimiento)) : '-';
      const tr = document.createElement('tr');
      if (idx % 2 === 1) tr.classList.add('row-alt');
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        document.querySelectorAll('#multas-table-body tr').forEach(r => r.classList.remove('row-selected'));
        tr.classList.add('row-selected');
      });
      const choferCell = m.chofer_nombre
        ? `<span style="font-size:13px;">${m.chofer_nombre}</span>`
        : `<span style="color:var(--color-warning);font-size:12px;font-weight:600;">⚠ Sin asignar</span>
           <button onclick="autoAsignarChoferMulta(${m.id})" title="Buscar chofer por turno" class="tbl-action-btn tbl-btn-view" style="width:24px;height:24px;font-size:11px;margin-left:4px;vertical-align:middle;"><i class="fa-solid fa-magnifying-glass"></i></button>`;
      tr.innerHTML = `
        <td><strong>${m.patente}</strong><br><small style="color:var(--placeholder-color)">${m.marca||''} ${m.modelo||''}</small></td>
        <td>${choferCell}</td>
        <td>${formatDate(m.fecha_infraccion)}</td>
        <td>${m.hora_infraccion ? m.hora_infraccion.substring(0,5) : '-'}</td>
        <td>${m.numero_acta || '-'}</td>
        <td>${m.descripcion}</td>
        <td>${m.municipalidad_nombre || '-'}</td>
        <td style="color:var(--color-error);font-weight:600;">${m.monto ? formatCurrency(m.monto) : '-'}</td>
        <td>${venc}</td>
        <td><span class="badge ${cl}">${m.estado}</span></td>
        <td style="text-align:center;">
          ${(() => {
            if (!m.adj_count) return '<span style="opacity:.2;font-size:16px;"><i class="fa-solid fa-minus"></i></span>';
            const icons = { imagen:'fa-file-image', pdf:'fa-file-pdf', video:'fa-file-video', link:'fa-link' };
            const colors = { imagen:'#2196f3', pdf:'#e53e3e', video:'#9c27b0', link:'#ff9800' };
            const tipo = m.primer_adj_tipo || 'link';
            const icon = icons[tipo] || 'fa-paperclip';
            const color = colors[tipo] || 'var(--text-secondary)';
            const label = m.adj_count > 1 ? `<sup style="font-size:9px;font-weight:700;">${m.adj_count}</sup>` : '';
            return `<span onclick="openMultaAdjuntos(${m.id})" title="${m.adj_count} adjunto(s)" style="cursor:pointer;font-size:17px;color:${color};">` +
                   `<i class="fa-solid ${icon}"></i>${label}</span>`;
          })()}
        </td>
        <td style="text-align:center;">
          <button class="tbl-action-btn tbl-btn-view"   onclick="viewMulta(${m.id})"    title="Consultar"><i class="fa-solid fa-eye"></i></button>
          <button class="tbl-action-btn tbl-btn-edit"   onclick="editMulta(${m.id})"    title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
          <button class="tbl-action-btn" style="background:var(--color-whatsapp,#25d366);color:#fff;" onclick="enviarMultaWA(${m.id})" title="Enviar por WhatsApp"><i class="fa-brands fa-whatsapp"></i></button>
          ${canDelete() ? `<button class="tbl-action-btn tbl-btn-delete" onclick="deleteMulta(${m.id})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>` : ''}
        </td>`;
      tbody.appendChild(tr);
    });
    _populateMultasVehiculoFilter(_cachedMultas);
    _populateMultasChoferFilter(_cachedMultas);
    _populateMultasMunicipalidadFilter(_cachedMultas);
    staggerTableRows(tbody);
    bindHeaderEvents();
    window._exportFiltersMap = window._exportFiltersMap || {};
    window._exportFiltersMap['table-multas'] = () => {
      const _gv = id => { const el = document.getElementById(id); return el?.value?.trim() || ''; };
      const _gt = id => { const el = document.getElementById(id); const sel = el?.selectedIndex; return sel > 0 ? el.options[sel].text.trim() : ''; };
      const parts = [
        _gt('multas-filter-vehiculo'),
        _gt('multas-filter-chofer'),
        _gt('multas-filter-municipalidad'),
        _gt('multas-filter-estado'),
        _gv('multas-filter-desde'),
        _gv('multas-filter-hasta'),
      ].filter(Boolean).map(s => s.replace(/[^\w\dÁÉÍÓÚáéíóúÑñ\-]/g, '_').replace(/_+/g,'_').replace(/^_|_$/g,''));
      return parts.join('_');
    };
    injectExportBar('table-multas', 'Infracciones');
  } catch (err) { console.error('Error al cargar multas:', err); }
}

function _populateMultasChoferFilter(list) {
  const sel = document.getElementById('multas-filter-chofer');
  if (!sel) return;
  const current = sel.value;
  const choferes = [...new Map(
    list.filter(r => r.chofer_id && r.chofer_nombre)
        .map(r => [r.chofer_id, r.chofer_nombre])
  ).entries()].sort((a,b) => a[1].localeCompare(b[1]));
  const fixed = ['', 'sin_asignar'];
  [...sel.options].forEach(o => { if (!fixed.includes(o.value)) o.remove(); });
  choferes.forEach(([id, nombre]) => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = nombre;
    if (String(id) === current) opt.selected = true;
    sel.appendChild(opt);
  });
  SmartCombo.refresh(sel);
}

function _populateMultasMunicipalidadFilter(list) {
  const sel = document.getElementById('multas-filter-municipalidad');
  if (!sel) return;
  const current = sel.value;
  const munis = [...new Map(
    list.filter(r => r.municipalidad_id && r.municipalidad_nombre)
        .map(r => [r.municipalidad_id, r.municipalidad_nombre])
  ).entries()].sort((a,b) => a[1].localeCompare(b[1]));
  [...sel.options].forEach(o => { if (o.value !== '') o.remove(); });
  munis.forEach(([id, nombre]) => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = nombre;
    if (String(id) === current) opt.selected = true;
    sel.appendChild(opt);
  });
}

function _populateMultasVehiculoFilter(list) {
  const sel = document.getElementById('multas-filter-vehiculo');
  if (!sel) return;
  const current = sel.value;
  const vehiculos = [...new Map(
    list.filter(r => r.vehiculo_id && r.patente)
        .map(r => [r.vehiculo_id, r.patente])
  ).entries()].sort((a,b) => a[1].localeCompare(b[1]));
  [...sel.options].forEach(o => { if (o.value !== '') o.remove(); });
  vehiculos.forEach(([id, patente]) => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = patente;
    if (String(id) === current) opt.selected = true;
    sel.appendChild(opt);
  });
  SmartCombo.refresh(sel);
}

function initMultaOcrDz() {
  if (_dzMultaOcr) return;
  _dzMultaOcr = new DropZone({
    mountId:   'multa-ocr-dz-mount',
    id:        'multa-ocr-dz',
    label:     'Foto / Escáner de la Infracción',
    icon:      'fa-file-invoice-dollar',
    task:      'multa',
    camera:    true,
    onExtract: _fillMultaFromAI,
  });
}

function _resetMultaOcrDropzone() {
  _dzMultaOcr?.clear();
}

function _onMultaMedioPagoChange(medio, cuentaId = '', tarjetaId = '', cuotas = 1) {
  const area = document.getElementById('multa-pago-extra');
  if (!area) return;
  const needsCuenta  = ['Transferencia','MercadoPago','Uala'].includes(medio);
  const needsTarjeta = medio === 'Tarjeta';
  if (!needsCuenta && !needsTarjeta) { area.style.display = 'none'; area.innerHTML = ''; return; }

  if (needsCuenta) {
    const opts = (_cachedCuentas || []).map(c => {
      const titular = [c.nombre, c.apellido].filter(Boolean).join(' ');
      const banco   = c.banco_nombre ? ` · ${c.banco_emoji || ''}${c.banco_nombre}` : '';
      return `<option value="${c.id}" ${c.id == cuentaId ? 'selected' : ''}>${c.alias}${titular ? ' — ' + titular : ''}${banco}</option>`;
    }).join('');
    area.innerHTML = `<div class="form-group">
      <label for="multa-cuenta-pago">Cuenta utilizada</label>
      <select id="multa-cuenta-pago">
        <option value="">-- Sin especificar --</option>${opts}
      </select>
    </div>`;
  } else {
    const tarjOpts = (_cachedTarjetas || []).map(t =>
      `<option value="${t.id}" ${t.id == tarjetaId ? 'selected' : ''}>${_tarjetaMarcaLabel(t)} ${t.ultimos_4 ? '••'+t.ultimos_4 : ''}${t.banco_nombre ? ' · '+t.banco_nombre : ''}</option>`
    ).join('');
    area.innerHTML = `<div style="display:grid;grid-template-columns:1fr 100px;gap:12px;">
      <div class="form-group">
        <label for="multa-tarjeta-pago">Tarjeta utilizada</label>
        <select id="multa-tarjeta-pago">
          <option value="">-- Seleccionar tarjeta --</option>${tarjOpts}
        </select>
      </div>
      <div class="form-group">
        <label for="multa-cuotas-pago">Cuotas</label>
        <input type="number" id="multa-cuotas-pago" min="1" max="48" value="${cuotas || 1}" style="text-align:center;">
      </div>
    </div>`;
  }
  area.style.display = 'block';
}

function _toggleMultaPagoArea(multaId) {
  const noId = document.getElementById('multa-pago-no-id');
  const area  = document.getElementById('multa-pago-dropzone-area');
  if (!noId || !area) return;
  if (multaId) {
    noId.style.display = 'none'; area.style.display = 'block';
    if (!_dzMultaPago) {
      _dzMultaPago = new DropZone({
        mountId:        'multa-pago-dz-mount',
        id:             'multa-pago-dz',
        label:          'Comprobante de pago',
        icon:           'fa-receipt',
        task:           'foto',
        camera:         false,
        uploadEndpoint: '/api/upload/multa-foto',
        onFileSet: (file) => {
          if (!file) return;
          const isPdf = file.type === 'application/pdf';
          const ocrBtn = document.getElementById('dz-ocr-multa-pago-dz-dropzone');
          if (ocrBtn) { ocrBtn.disabled = isPdf; ocrBtn.title = isPdf ? 'OCR solo para imágenes — se usa IA automáticamente' : ''; }
          if (_aiAvailable) {
            dzSetStatus('multa-pago-dz-dropzone', '⏳ Extrayendo datos…', 'info');
            setTimeout(() => extractMultaPagoAI(), 300);
          } else if (!isPdf) {
            dzSetStatus('multa-pago-dz-dropzone', '⏳ Leyendo comprobante…', 'info');
            setTimeout(() => extractMultaPagoOCR(), 300);
          } else {
            dzSetStatus('multa-pago-dz-dropzone', 'PDF cargado — configurá IA para extraer datos', 'warn');
          }
        },
      });
      injectDzToolbar('multa-pago-dz-dropzone', 'multa-pago-dz-file', {
        camera:   false,
        ocr:      'extractMultaPagoOCR', ocrLabel: 'OCR',
        ai:       'extractMultaPagoAI',  aiLabel:  'IA',
        statusId: 'dz-status-multa-pago-dz-dropzone',
      });
    }
  } else {
    noId.style.display = ''; area.style.display = 'none';
    _dzMultaPago?.clear();
  }
}

function _showMultaPagoPreview(url) {
  if (!_dzMultaPago) return;
  if (url) _dzMultaPago.loadUrl(url); else _dzMultaPago.clear();
}

async function _previewMultaAdjInDropzone(multaId) {
  const adjs = await fetch(`/api/multas/${multaId}/adjuntos`).then(r => r.json()).catch(() => []);
  if (!adjs.length) return;
  const a = adjs[0];
  if (!_dzMultaOcr) return;
  if (a.tipo === 'imagen' || a.tipo === 'pdf') {
    _dzMultaOcr.loadUrl(a.url);
    _dzMultaOcr._setStatus(`${a.tipo === 'pdf' ? '📄' : '📷'} ${a.nombre_original || a.url}`, 'ok');
  }
}

function _restoreMultaForm() {
  const form = document.getElementById('form-multa');
  if (!form) return;
  form.style.pointerEvents = ''; form.style.userSelect = '';
  form.querySelectorAll('input,textarea,select').forEach(el => { el.disabled = false; });
  _dzMultaPago?.setReadonly(false);
  const btn = document.getElementById('btn-submit-multa');
  if (btn) btn.style.display = '';
}

async function openAddMultaModal() {
  initMultaOcrDz();
  _restoreMultaForm();
  document.getElementById('form-multa').reset();
  document.getElementById('multa-id').value = '';
  document.getElementById('modal-multa-title').innerText = 'Registrar Infracción';
  document.getElementById('btn-submit-multa').innerText = 'Registrar';
  document.getElementById('multa-adj-info').style.display = 'block';
  document.getElementById('multa-adj-area').style.display = 'none';
  document.getElementById('multa-url-link').style.display = 'none';
  document.getElementById('multa-fecha').value = new Date().toISOString().split('T')[0];
  const btnWa = document.getElementById('btn-buscar-wa');
  if (btnWa) btnWa.style.display = 'none';  // oculto en nueva multa
  // Limpiar auditoría
  document.getElementById('multa-fecha-emision-acta').value = '';
  document.getElementById('multa-fecha-notificacion').value = '';
  document.getElementById('multa-medio-notificacion').value = '';
  document.getElementById('multa-codigo-postal').value = '';
  document.getElementById('multa-constancia-recepcion').checked = false;
  document.getElementById('multa-audit-alerts').innerHTML = '';
  document.getElementById('multa-audit-calculos').style.display = 'none';
  _resetMultaOcrDropzone();
  _toggleMultaPagoArea(null);
  _showMultaPagoPreview('');
  await _loadMultaSelects();
  switchModalTab(document.querySelector('#modal-multa .modal-tab-btn'), 'multa-tab-datos');
  openModal('modal-multa');
}

async function editMulta(id) {
  initMultaOcrDz();
  _restoreMultaForm();
  const m = _cachedMultas.find(x => x.id === id);
  if (!m) return;
  await _loadMultaSelects();
  document.getElementById('multa-id').value = m.id;
  // Usar _ssSet para que SmartCombo sincronice el input visible
  const vSel = document.getElementById('multa-vehiculo');
  if (vSel._ssSet) vSel._ssSet(String(m.vehiculo_id || ''));
  else vSel.value = m.vehiculo_id;
  const cSel = document.getElementById('multa-chofer');
  if (cSel._ssSet) cSel._ssSet(String(m.chofer_id || ''));
  else cSel.value = m.chofer_id || '';
  const mSel = document.getElementById('multa-municipalidad');
  if (mSel._ssSet) mSel._ssSet(String(m.municipalidad_id || ''));
  else mSel.value = m.municipalidad_id || '';
  document.getElementById('multa-numero-acta').value = m.numero_acta || '';
  document.getElementById('multa-fecha').value = m.fecha_infraccion ? m.fecha_infraccion.split('T')[0] : '';
  document.getElementById('multa-hora').value = m.hora_infraccion ? m.hora_infraccion.substring(0,5) : '';
  document.getElementById('multa-vto-voluntario').value = (m.fecha_vto_voluntario || m.fecha_vencimiento || '').split('T')[0] || '';
  document.getElementById('multa-vto-total').value = m.fecha_vto_total ? m.fecha_vto_total.split('T')[0] : '';
  document.getElementById('multa-descripcion').value = m.descripcion;
  document.getElementById('multa-articulo').value = m.articulo_infringido || '';
  document.getElementById('multa-lugar').value = m.lugar || '';
  setAmt('multa-monto-voluntario', m.monto_voluntario ?? m.monto ?? 0);
  setAmt('multa-monto-total', m.monto_total || 0);
  document.getElementById('multa-puntos').value = m.puntos || '';
  document.getElementById('multa-estado').value = m.estado || 'pendiente';
  document.getElementById('multa-url-consulta').value = m.url_consulta || '';
  document.getElementById('multa-nombre-infractor').value = m.nombre_infractor || '';
  document.getElementById('multa-dni-infractor').value = m.dni_infractor || '';
  document.getElementById('multa-notas').value = m.notas || '';
  // Auditoría procesal
  document.getElementById('multa-fecha-emision-acta').value = m.fecha_emision_acta ? m.fecha_emision_acta.substring(0,10) : '';
  document.getElementById('multa-fecha-notificacion').value = m.fecha_notificacion ? m.fecha_notificacion.substring(0,10) : '';
  document.getElementById('multa-medio-notificacion').value = m.medio_notificacion || '';
  document.getElementById('multa-codigo-postal').value = m.codigo_seguimiento_postal || '';
  document.getElementById('multa-constancia-recepcion').checked = !!m.constancia_recepcion;
  recalcMultaAuditoria(m);
  _loadMultaWAHist(m);
  // Campos de pago
  document.getElementById('multa-fecha-pago').value = m.fecha_pago ? m.fecha_pago.split('T')[0] : '';
  document.getElementById('multa-medio-pago').value = m.medio_pago_multa || '';
  document.getElementById('multa-nro-operacion-pago').value = m.nro_operacion_pago || '';
  _onMultaMedioPagoChange(m.medio_pago_multa || '', m.cuenta_id_pago || '', m.tarjeta_id_pago || '', m.cuotas_pago || 1);
  _toggleMultaPagoArea(m.id);
  _showMultaPagoPreview(m.comprobante_pago_url || '');
  const urlLink = document.getElementById('multa-url-link');
  if (m.url_consulta) { urlLink.href = m.url_consulta; urlLink.style.display = 'flex'; }
  else { urlLink.style.display = 'none'; }
  const tituloFecha = m.fecha_infraccion ? formatDate(m.fecha_infraccion) : '';
  const tituloHora  = m.hora_infraccion  ? m.hora_infraccion.substring(0,5) : '';
  const tituloSub   = [m.patente, m.numero_acta, tituloFecha, tituloHora].filter(Boolean).join(' · ');
  document.getElementById('modal-multa-title').innerHTML =
    `Editar Infracción <small style="font-weight:400;font-size:.7em;opacity:.7;">${tituloSub}</small>`;
  document.getElementById('btn-submit-multa').innerText = 'Guardar Cambios';
  document.getElementById('multa-adj-info').style.display = 'none';
  document.getElementById('multa-adj-area').style.display = 'block';
  // Mostrar botón WhatsApp solo en edición (multa ya guardada)
  const btnWa = document.getElementById('btn-buscar-wa');
  if (btnWa) btnWa.style.display = 'inline-flex';
  _resetMultaOcrDropzone();
  _previewMultaAdjInDropzone(m.id);
  loadMultaAdjuntos(m.id, m.numero_acta);
  switchModalTab(document.querySelector('#modal-multa .modal-tab-btn'), 'multa-tab-datos');
  openModal('modal-multa');
}

async function _loadMultaSelects() {
  const vRes = await fetch('/api/vehiculos');
  const vList = await vRes.json();
  const vSel = document.getElementById('multa-vehiculo');
  vSel.innerHTML = '<option value="">-- Seleccionar --</option>';
  vList.forEach(v => { const o = document.createElement('option'); o.value=v.id; o.textContent=`${v.patente} - ${v.marca||''} ${v.modelo||''}`.trim(); vSel.appendChild(o); });

  const cRes = await fetch('/api/choferes');
  const cList = await cRes.json();
  const cSel = document.getElementById('multa-chofer');
  cSel.innerHTML = '<option value="">-- Sin chofer --</option>';
  cList.forEach(c => { const o = document.createElement('option'); o.value=c.id; o.textContent=`${c.nombre} ${c.apellido||''}`.trim(); cSel.appendChild(o); });

  const mRes = await fetch('/api/municipalidades');
  const mList = await mRes.json();
  const mSel = document.getElementById('multa-municipalidad');
  mSel.innerHTML = '<option value="">-- Sin especificar --</option>';
  mList.forEach(m => { const o = document.createElement('option'); o.value=m.id; o.textContent=m.nombre; mSel.appendChild(o); });
}

async function saveMulta(e) {
  e.preventDefault();
  const id = document.getElementById('multa-id').value;
  const isEdit = id !== '';
  const urlVal = document.getElementById('multa-url-consulta').value;
  const data = {
    vehiculo_id: document.getElementById('multa-vehiculo').value,
    chofer_id: document.getElementById('multa-chofer').value || null,
    municipalidad_id: document.getElementById('multa-municipalidad').value || null,
    numero_acta: document.getElementById('multa-numero-acta').value || null,
    fecha_infraccion: document.getElementById('multa-fecha').value || null,
    hora_infraccion: document.getElementById('multa-hora').value || null,
    fecha_vencimiento:     document.getElementById('multa-vto-voluntario').value || null,
    fecha_vto_voluntario:  document.getElementById('multa-vto-voluntario').value || null,
    fecha_vto_total:       document.getElementById('multa-vto-total').value || null,
    descripcion: document.getElementById('multa-descripcion').value,
    articulo_infringido: document.getElementById('multa-articulo').value || null,
    lugar: document.getElementById('multa-lugar').value || null,
    monto:            getAmt('multa-monto-voluntario') || null,
    monto_voluntario: getAmt('multa-monto-voluntario') || null,
    monto_total:      getAmt('multa-monto-total') || null,
    puntos: document.getElementById('multa-puntos').value || null,
    estado: document.getElementById('multa-estado').value,
    url_consulta: urlVal || null,
    nombre_infractor: document.getElementById('multa-nombre-infractor').value || null,
    dni_infractor: document.getElementById('multa-dni-infractor').value || null,
    notas: document.getElementById('multa-notas').value || null,
    fecha_emision_acta: document.getElementById('multa-fecha-emision-acta').value || null,
    fecha_notificacion: document.getElementById('multa-fecha-notificacion').value || null,
    medio_notificacion: document.getElementById('multa-medio-notificacion').value || null,
    codigo_seguimiento_postal: document.getElementById('multa-codigo-postal').value || null,
    constancia_recepcion: document.getElementById('multa-constancia-recepcion').checked ? 1 : 0,
    fecha_pago: document.getElementById('multa-fecha-pago').value || null,
    medio_pago_multa: document.getElementById('multa-medio-pago').value || null,
    nro_operacion_pago: document.getElementById('multa-nro-operacion-pago').value || null,
    cuenta_id_pago: document.getElementById('multa-cuenta-pago')?.value || null,
    tarjeta_id_pago: document.getElementById('multa-tarjeta-pago')?.value || null,
    cuotas_pago: document.getElementById('multa-cuotas-pago')?.value || null,
  };

  // Auto-estado pagada cuando se registra un pago
  if (data.fecha_pago && !['anulada','impugnada'].includes(data.estado)) {
    data.estado = 'pagada';
    const estadoSel = document.getElementById('multa-estado');
    if (estadoSel?._ssSet) estadoSel._ssSet('pagada');
    else if (estadoSel) estadoSel.value = 'pagada';
  }

  try {
    const res = await fetch(isEdit ? `/api/multas/${id}` : '/api/multas', {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) { const err = await res.json(); showAlert(`Error: ${err.message}`); return; }
    const reply = await res.json();
    const newId = isEdit ? id : reply.id;
    document.getElementById('multa-id').value = newId;

    // Si hay archivo en el dropzone OCR, subirlo como primer adjunto
    const _ocrFile = _dzMultaOcr?._file || null;
    if (_ocrFile) {
      const fd = new FormData();
      fd.append('adjuntos', _ocrFile);
      await fetch(`/api/multas/${newId}/adjuntos`, { method: 'POST', body: fd }).catch(()=>{});
      _resetMultaOcrDropzone();
    }

    // Vincular comprobante de pago si el DZ tiene una URL nueva
    const dzUrl = _dzMultaPago?._existingUrl || null;
    if (dzUrl) {
      await fetch(`/api/multas/${newId}/comprobante-pago`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: dzUrl }),
      }).catch(() => null);
    }
    _toggleMultaPagoArea(newId);
    if (dzUrl) _showMultaPagoPreview(dzUrl);

    document.getElementById('multa-adj-info').style.display = 'none';
    document.getElementById('multa-adj-area').style.display = 'block';
    loadMultaAdjuntos(newId);
    document.getElementById('btn-submit-multa').innerText = 'Guardar Cambios';
    document.getElementById('modal-multa-title').innerText = 'Editar Infracción';
    if (urlVal) { document.getElementById('multa-url-link').href = urlVal; document.getElementById('multa-url-link').style.display = 'flex'; }
    showToast(isEdit ? 'Infracción actualizada' : 'Infracción registrada');
    loadMultas();
  } catch(err) { showAlert('Error al guardar.', 'error', 'error'); }
}

async function deleteMulta(id) {
  if (!await showConfirm('¿Eliminar esta infracción?')) return;
  await fetch(`/api/multas/${id}`, { method: 'DELETE' });
  loadMultas();
}

async function viewMulta(id) {
  await editMulta(id);
  // Poner en modo lectura
  const form = document.getElementById('form-multa');
  if (form) {
    form.style.pointerEvents = 'none';
    form.style.userSelect = 'none';
    form.querySelectorAll('input,textarea,select').forEach(el => { el.disabled = true; });
    // Restaurar interactividad en botones del visor del DZ (ojo, eliminar, toolbar)
    form.querySelectorAll('.dz-overlay-eye, .dz-overlay-del, .dz-btn, .modal-footer button').forEach(el => {
      el.style.pointerEvents = 'auto';
    });
  }
  _dzMultaPago?.setReadonly(true);
  document.getElementById('btn-submit-multa').style.display = 'none';
  document.getElementById('modal-multa-title').innerHTML =
    document.getElementById('modal-multa-title').innerHTML.replace('Editar Infracción', 'Consulta Infracción');
  // Restaurar clicks en galería de adjuntos (se carga async, puede no existir aún)
  const patchGallery = () => {
    const gallery = document.getElementById('multa-adj-gallery');
    if (!gallery) return;
    gallery.style.pointerEvents = 'auto';
    // Ocultar botones de borrar en modo consulta
    gallery.querySelectorAll('button').forEach(btn => { btn.style.display = 'none'; });
  };
  patchGallery();
  // Reintentar cuando la galería termine de cargarse
  setTimeout(patchGallery, 600);
}

async function verificarPagoMP() {
  const nro = document.getElementById('multa-nro-operacion-pago')?.value?.trim();
  const box = document.getElementById('mp-verificacion-result');
  if (!nro) { showToast('Ingresá el número de operación primero', 'warning'); return; }
  box.style.display = 'block';
  box.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">Consultando Mercado Pago…</span>';
  try {
    const res = await fetch(`/api/mp/payment/${nro}`);
    const d = await res.json();
    if (!res.ok) {
      box.innerHTML = `<div style="padding:8px 12px;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;font-size:12px;color:#b91c1c;">✗ ${d.message}</div>`;
      return;
    }
    const statusColor = { approved:'#16a34a', pending:'#c96a00', rejected:'#b91c1c', cancelled:'#6b7280' }[d.status] || '#6b7280';
    const statusLabel = { approved:'✓ Aprobado', pending:'⏳ Pendiente', rejected:'✗ Rechazado', cancelled:'Cancelado' }[d.status] || d.status;
    const fecha = d.fecha ? new Date(d.fecha).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) : '—';
    const monto = d.monto != null ? `$ ${Number(d.monto).toLocaleString('es-AR',{minimumFractionDigits:2})}` : '—';
    box.innerHTML = `
      <div style="padding:10px 14px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-left:4px solid ${statusColor};border-radius:6px;font-size:12px;display:flex;flex-direction:column;gap:4px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;color:${statusColor};">${statusLabel}</span>
          <span style="font-weight:700;">${monto}</span>
        </div>
        ${d.fecha ? `<div style="color:var(--text-secondary);">${fecha}</div>` : ''}
        ${d.pagador_email ? `<div style="color:var(--text-secondary);">Pagador: ${d.pagador_nombre || ''} &lt;${d.pagador_email}&gt;</div>` : ''}
        ${d.medio ? `<div style="color:var(--text-secondary);">Medio: ${d.medio} (${d.tipo})</div>` : ''}
      </div>`;
    // Si está aprobado, auto-setear fecha de pago si está vacía
    if (d.status === 'approved' && d.fecha) {
      const fpEl = document.getElementById('multa-fecha-pago');
      if (fpEl && !fpEl.value) fpEl.value = d.fecha.split('T')[0];
      const medioEl = document.getElementById('multa-medio-pago');
      if (medioEl && !medioEl.value && d.medio?.toLowerCase().includes('mercado')) {
        if (medioEl._ssSet) medioEl._ssSet('MercadoPago'); else medioEl.value = 'MercadoPago';
      }
    }
  } catch (e) {
    box.innerHTML = `<div style="padding:8px 12px;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;font-size:12px;color:#b91c1c;">✗ Error: ${e.message}</div>`;
  }
}

async function enviarMultaWA(id) {
  const m = _cachedMultas.find(x => x.id === id);
  if (!m) return;
  const fecha        = m.fecha_infraccion ? formatDate(m.fecha_infraccion) : '-';
  const montoVol     = m.monto_voluntario ? formatCurrency(m.monto_voluntario) : (m.monto ? formatCurrency(m.monto) : '-');
  const montoTotal   = m.monto_total ? formatCurrency(m.monto_total) : '-';
  const vtoVol       = m.fecha_vto_voluntario || m.fecha_vencimiento;
  const vtoTotal     = m.fecha_vto_total;
  const estado = m.estado || '-';
  const acta   = m.numero_acta || '-';
  const muni   = m.municipalidad_nombre || '-';
  const chofer = m.chofer_nombre || 'Sin asignar';
  const lines  = [
    `🚨 *Infracción de Tránsito*`,
    `📋 Acta: ${acta}`,
    `🚗 Vehículo: ${m.patente}`,
    `👤 Chofer: ${chofer}`,
    `📅 Fecha: ${fecha}${m.hora_infraccion ? ' ' + m.hora_infraccion.substring(0,5) + ' h' : ''}`,
    `🏛 Municipalidad: ${muni}`,
    `💰 Pago voluntario: ${montoVol}${vtoVol ? ' (vto. ' + formatDate(vtoVol) + ')' : ''}`,
    montoTotal !== '-' ? `💸 Pago total (al vencer): ${montoTotal}${vtoTotal ? ' (vto. ' + formatDate(vtoTotal) + ')' : ''}` : '',
    `📌 Estado: ${estado}`,
    m.lugar ? `📍 ${m.lugar}` : '',
    m.descripcion ? `📝 ${m.descripcion}` : '',
  ].filter(Boolean).join('\n');
  const label = `Infracción ${acta} — ${m.patente}`;
  await openWhatsAppModal(null, label, m.chofer_id ? { tipo: 'chofer', id: m.chofer_id } : null);
  document.getElementById('wa-message').value = lines;
  await _loadWAMultaAdjs([m]);
}

function openMultasGraficos() {
  const multas = _cachedMultas;
  if (!multas.length) { showToast('No hay infracciones para graficar', 'warning'); return; }

  // Agrupar por estado
  const porEstado = {};
  multas.forEach(m => { const e = m.estado || 'pendiente'; porEstado[e] = (porEstado[e] || 0) + 1; });

  // Agrupar monto por mes
  const porMes = {};
  multas.forEach(m => {
    if (!m.fecha_infraccion) return;
    const mes = m.fecha_infraccion.substring(0,7);
    porMes[mes] = (porMes[mes] || 0) + parseFloat(m.monto || 0);
  });
  const meses = Object.keys(porMes).sort();

  const estadoColors = { pendiente:'#f59e0b', pagada:'#22c55e', impugnada:'#3b82f6', vencida:'#ef4444', anulada:'#94a3b8' };
  const maxMonto = Math.max(...meses.map(k => porMes[k]), 1);

  const barH = 28;
  const totalEstados = Object.keys(porEstado).length;
  const totalMeses   = meses.length;
  const svgH = Math.max(300, totalEstados * (barH + 8) + totalMeses * (barH + 8) + 120);

  let svgBars = '';
  let y = 40;
  svgBars += `<text x="10" y="24" style="font-size:13px;font-weight:700;fill:var(--text-primary)">Por Estado (cantidad)</text>`;
  Object.entries(porEstado).sort((a,b) => b[1]-a[1]).forEach(([est, cnt]) => {
    const w = Math.max(4, Math.round((cnt / multas.length) * 340));
    const col = estadoColors[est] || '#94a3b8';
    svgBars += `<rect x="120" y="${y}" width="${w}" height="${barH}" rx="4" fill="${col}" opacity=".85"/>`;
    svgBars += `<text x="115" y="${y+barH/2+5}" text-anchor="end" style="font-size:12px;fill:var(--text-secondary)">${est}</text>`;
    svgBars += `<text x="${120+w+6}" y="${y+barH/2+5}" style="font-size:12px;fill:var(--text-primary)">${cnt}</text>`;
    y += barH + 8;
  });

  y += 24;
  svgBars += `<text x="10" y="${y-8}" style="font-size:13px;font-weight:700;fill:var(--text-primary)">Monto por mes</text>`;
  meses.forEach(mes => {
    const w = Math.max(4, Math.round((porMes[mes] / maxMonto) * 340));
    svgBars += `<rect x="120" y="${y}" width="${w}" height="${barH}" rx="4" fill="#3b82f6" opacity=".75"/>`;
    svgBars += `<text x="115" y="${y+barH/2+5}" text-anchor="end" style="font-size:11px;fill:var(--text-secondary)">${mes}</text>`;
    svgBars += `<text x="${120+w+6}" y="${y+barH/2+5}" style="font-size:11px;fill:var(--text-primary)">${formatCurrency(porMes[mes])}</text>`;
    y += barH + 8;
  });

  document.getElementById('modal-multas-graficos')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'modal-multas-graficos';
  overlay.style.cssText = 'display:flex;z-index:1100;';
  overlay.innerHTML = `<div class="modal-card" style="max-width:600px;width:95%;max-height:90vh;overflow-y:auto;">
    <div class="modal-header"><h2>Gráficos — Infracciones</h2><button class="btn-close" onclick="document.getElementById('modal-multas-graficos').remove()">&times;</button></div>
    <div class="modal-body" style="padding:16px;">
      <svg viewBox="0 0 500 ${y+20}" xmlns="http://www.w3.org/2000/svg" style="width:100%;font-family:inherit">${svgBars}</svg>
    </div>
  </div>`;
  document.body.appendChild(overlay);
}

async function autoAsignarChoferMulta(multaId) {
  showToast('Buscando chofer en turnos…', 'info');
  try {
    const res  = await fetch(`/api/multas/${multaId}/buscar-chofer`);
    const data = await res.json();
    if (!data.found) {
      showToast(`Sin turno en ese horario: ${data.reason}`, 'warning');
      return;
    }
    const fInicio = data.fecha_inicio ? _fmtDT(data.fecha_inicio) : '?';
    const fFin    = data.fecha_fin    ? _fmtDT(data.fecha_fin)    : 'en curso';
    const ok = await showConfirm(
      `Turno encontrado:\n${data.chofer_nombre}\n${fInicio} → ${fFin}\n\n¿Asignar como chofer de esta infracción?`
    );
    if (!ok) return;
    // Obtener datos actuales de la multa para hacer PATCH correcto
    const multa = _cachedMultas.find(m => m.id === multaId);
    if (!multa) { showToast('Recargá la tabla primero', 'warning'); return; }
    const body = {
      vehiculo_id: multa.vehiculo_id,
      chofer_id: data.chofer_id,
      municipalidad_id: multa.municipalidad_id || null,
      fecha_infraccion: multa.fecha_infraccion ? multa.fecha_infraccion.split('T')[0] : null,
      hora_infraccion: multa.hora_infraccion ? multa.hora_infraccion.substring(0,5) : null,
      fecha_vencimiento:    multa.fecha_vencimiento ? multa.fecha_vencimiento.split('T')[0] : null,
      fecha_vto_voluntario: multa.fecha_vto_voluntario ? multa.fecha_vto_voluntario.split('T')[0] : null,
      fecha_vto_total:      multa.fecha_vto_total ? multa.fecha_vto_total.split('T')[0] : null,
      numero_acta: multa.numero_acta || null,
      descripcion: multa.descripcion,
      articulo_infringido: multa.articulo_infringido || null,
      lugar: multa.lugar || null,
      monto:            multa.monto_voluntario ?? multa.monto ?? null,
      monto_voluntario: multa.monto_voluntario || null,
      monto_total:      multa.monto_total || null,
      puntos: multa.puntos || null,
      estado: multa.estado || 'pendiente',
      url_consulta: multa.url_consulta || null,
      nombre_infractor: multa.nombre_infractor || null,
      dni_infractor: multa.dni_infractor || null,
      notas: multa.notas || null,
    };
    const upd = await fetch(`/api/multas/${multaId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!upd.ok) { showToast('Error al guardar', 'error'); return; }
    showToast(`✓ Asignado: ${data.chofer_nombre}`, 'success');
    loadMultas();
  } catch (err) {
    showToast('Error de conexión', 'error');
    console.error(err);
  }
}

// ── Galería de adjuntos ─────────────────────────────────────
let _adjNumeroActa = null;

async function loadMultaAdjuntos(multaId, numeroActa) {
  if (numeroActa !== undefined) _adjNumeroActa = numeroActa || null;
  const gallery = document.getElementById('multa-adj-gallery');
  gallery.innerHTML = '';
  // Encabezado con ACTA si está disponible
  if (_adjNumeroActa) {
    const hdr = document.createElement('div');
    hdr.style.cssText = 'width:100%;display:flex;align-items:center;gap:8px;margin-bottom:8px;';
    hdr.innerHTML = `<span style="font-size:11px;font-weight:700;color:var(--text-secondary);letter-spacing:.5px;text-transform:uppercase;">ACTA</span>
      <span style="font-size:13px;font-weight:600;color:var(--accent-color);">${_adjNumeroActa}</span>
      <span style="flex:1;height:1px;background:var(--border-color);display:block;"></span>`;
    gallery.appendChild(hdr);
  }
  try {
    const res = await fetch(`/api/multas/${multaId}/adjuntos`);
    const adj = await res.json();
    adj.forEach(a => {
      const nombre = a.nombre_original || '';
      const urlEsc = a.url.replace(/'/g, "\\'");
      const nomEsc = nombre.replace(/'/g, "\\'");
      const div = document.createElement('div');
      div.style.cssText = 'position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;width:110px;';
      let preview = '';
      if (a.tipo === 'imagen') {
        preview = `<div style="width:100px;height:80px;border-radius:6px;overflow:hidden;cursor:pointer;background:var(--bg-tertiary);" onclick="openDocViewer('${urlEsc}','${nomEsc}')">
          <img src="${a.url}" style="width:100%;height:100%;object-fit:cover;">
        </div>
        <span style="font-size:10px;text-align:center;word-break:break-all;color:var(--text-secondary);cursor:pointer;" onclick="openDocViewer('${urlEsc}','${nomEsc}')"><i class="fa-solid fa-image" style="margin-right:2px;"></i>${nombre||'Imagen'}</span>`;
      } else if (a.tipo === 'pdf') {
        preview = `<div style="width:100px;height:80px;border-radius:6px;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;cursor:pointer;" onclick="openDocViewer('${urlEsc}','${nomEsc}')">
          <i class="fa-solid fa-file-pdf" style="font-size:2.5rem;color:#e53e3e;"></i>
        </div>
        <span style="font-size:10px;text-align:center;word-break:break-all;color:var(--accent-color);cursor:pointer;" onclick="openDocViewer('${urlEsc}','${nomEsc}')"><i class="fa-solid fa-eye" style="margin-right:2px;"></i>${nombre||'PDF'}</span>`;
      } else if (a.tipo === 'video') {
        preview = `<div style="width:100px;height:80px;border-radius:6px;overflow:hidden;background:#000;cursor:pointer;position:relative;" onclick="openMultaVideo('${urlEsc}','${nomEsc}')">
          <video src="${a.url}" style="width:100%;height:100%;object-fit:cover;" muted preload="metadata"></video>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.35);pointer-events:none;">
            <i class="fa-solid fa-circle-play" style="font-size:1.8rem;color:#fff;opacity:0.9;"></i>
          </div>
        </div>
        <span style="font-size:10px;text-align:center;word-break:break-all;color:var(--text-secondary);cursor:pointer;" onclick="openMultaVideo('${urlEsc}','${nomEsc}')"><i class="fa-solid fa-video" style="margin-right:2px;"></i>${nombre||'Video'}</span>`;
      } else {
        // tipo='link': intentar renderizar como imagen con fallback al ícono de cadena
        preview = `<div style="width:100px;height:80px;border-radius:6px;overflow:hidden;cursor:pointer;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;"
            onclick="openDocViewer('${urlEsc}','${nomEsc}')">
          <img src="${a.url}" style="width:100%;height:100%;object-fit:cover;"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
          <span style="display:none;align-items:center;justify-content:center;width:100%;height:100%;">
            <i class="fa-solid fa-link" style="font-size:2rem;color:var(--accent-color);"></i>
          </span>
        </div>
        <a href="${a.url}" target="_blank" style="font-size:10px;text-align:center;word-break:break-all;color:var(--accent-color);text-decoration:none;">${nombre||'Ver prueba'}</a>`;
      }
      div.innerHTML = `${preview}
        <button onclick="deleteMultaAdj(${a.id},${multaId})" style="background:rgba(0,0,0,0.55);border:none;color:#fff;border-radius:4px;padding:2px 7px;cursor:pointer;font-size:11px;margin-top:2px;"><i class="fa-solid fa-trash"></i></button>`;
      gallery.appendChild(div);
    });
    // Actualizar ícono del dropzone y la pestaña según el tipo del primer adjunto
    const dz = document.getElementById('multa-adj-drop');
    const tabBtn = document.querySelector('[data-modal-tab="multa-tab-adjuntos"]');
    const iconMap = { imagen: 'fa-file-image', pdf: 'fa-file-pdf', video: 'fa-video', link: 'fa-link' };
    const colorMap = { imagen: '#2196f3', pdf: '#e53e3e', video: '#9c27b0', link: '#ff9800' };
    if (adj.length > 0) {
      const tipo = adj[0].tipo || 'link';
      const ic = iconMap[tipo] || 'fa-paperclip';
      const col = colorMap[tipo] || 'var(--placeholder-color)';
      if (dz) dz.querySelector('i')?.setAttribute('class', `fa-solid ${ic}`);
      if (dz) dz.querySelector('i')?.setAttribute('style', `font-size:2rem;color:${col};`);
      if (tabBtn) tabBtn.innerHTML = `<i class="fa-solid ${ic}" style="color:${col};"></i> Adjuntos <span style="background:${col};color:#fff;border-radius:9px;padding:1px 7px;font-size:11px;font-weight:700;">${adj.length}</span>`;
    } else {
      if (dz) { const i = dz.querySelector('i'); if(i){i.className='fa-solid fa-paperclip';i.style.cssText='font-size:2rem;color:var(--placeholder-color);';} }
      if (tabBtn) tabBtn.innerHTML = `<i class="fa-solid fa-paperclip"></i> Adjuntos`;
    }
  } catch(e) { console.error(e); }
}

// ── Auditoría procesal de multas ─────────────────────────────────────────────

// Días hábiles entre dos fechas (lun–vie, sin feriados — estimación)
function _diasHabiles(desde, hasta) {
  if (!desde || !hasta) return null;
  const d1 = new Date(desde + 'T00:00:00');
  const d2 = new Date(hasta + 'T00:00:00');
  if (d2 <= d1) return 0;
  let dias = 0;
  const cur = new Date(d1);
  while (cur < d2) {
    cur.setDate(cur.getDate() + 1);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) dias++;
  }
  return dias;
}

async function _loadMultaWAHist(m) {
  const el = document.getElementById('multa-audit-wa-hist');
  if (!el) return;
  el.textContent = '…';
  try {
    const docName = `Infracción ${m.numero_acta || ''} — ${m.patente || ''}`.trim();
    const params = new URLSearchParams({ docName });
    if (m.chofer_id) params.set('recipientId', m.chofer_id);
    const hist = await fetch('/api/whatsapp/historial?' + params).then(r => r.json()).catch(() => []);
    if (!hist.length) { el.textContent = 'Sin notificaciones enviadas.'; return; }
    el.innerHTML = hist.map(h => {
      const fecha = h.fecha ? new Date(h.fecha).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false }) : '';
      return `<div style="padding:5px 0;border-bottom:1px solid var(--border-color);display:flex;gap:8px;align-items:flex-start;">
        <i class="fa-brands fa-whatsapp" style="color:#25d366;margin-top:2px;flex-shrink:0;"></i>
        <span><strong>${fecha}</strong> — ${h.descripcion || ''}<br><span style="font-size:11px;color:var(--text-secondary);">${h.usuario_nombre || ''}</span></span>
      </div>`;
    }).join('');
  } catch { el.textContent = 'No se pudo cargar el historial.'; }
}

function recalcMultaAuditoria(m) {
  // Leer valores del form si no se pasó objeto
  const fechaInf    = (m?.fecha_infraccion  || document.getElementById('multa-fecha')?.value || '').substring(0,10);
  const fechaEmis   = document.getElementById('multa-fecha-emision-acta')?.value || '';
  const fechaNotif  = document.getElementById('multa-fecha-notificacion')?.value || '';
  const medio       = document.getElementById('multa-medio-notificacion')?.value || '';
  const constancia  = document.getElementById('multa-constancia-recepcion')?.checked || false;

  const alertasEl   = document.getElementById('multa-audit-alerts');
  const calculosEl  = document.getElementById('multa-audit-calculos');
  if (!alertasEl) return;

  const alertas = [];
  const calculos = [];

  // ── Alertas ──────────────────────────────────────────────────────────────
  if (!fechaEmis) {
    alertas.push({ tipo: 'warn', texto: 'No consta fecha de emisión/despacho del acta.' });
  } else if (fechaInf) {
    const dias = _diasHabiles(fechaInf, fechaEmis);
    calculos.push({ label: 'Días hábiles hasta despacho', valor: dias, limite: 60, unidad: 'días hábiles' });
    if (dias > 60) {
      alertas.push({ tipo: 'danger', texto: `Posible incumplimiento: ${dias} días hábiles entre infracción y despacho (límite 60 días hábiles).` });
    } else {
      alertas.push({ tipo: 'ok', texto: `Despacho dentro del plazo: ${dias} días hábiles tras la infracción.` });
    }
  }

  if (!medio) {
    alertas.push({ tipo: 'warn', texto: 'Falta información sobre la modalidad de notificación.' });
  }

  if (!fechaNotif) {
    alertas.push({ tipo: 'warn', texto: 'No consta fecha de notificación fehaciente.' });
  } else {
    if (!constancia) {
      alertas.push({ tipo: 'warn', texto: 'No consta constancia de recepción.' });
    } else {
      alertas.push({ tipo: 'ok', texto: 'Notificación con constancia de recepción registrada.' });
    }
    if (fechaEmis) {
      const diasEntrega = _diasHabiles(fechaEmis, fechaNotif);
      calculos.push({ label: 'Días hábiles despacho → entrega', valor: diasEntrega, unidad: 'días hábiles' });
    }
  }

  // ── Renderizar alertas ────────────────────────────────────────────────────
  const iconos = { warn: '⚠️', danger: '🚨', ok: '✅' };
  const colores = {
    warn:   'color:#92400e;background:#fef3c7;border-left:3px solid #f59e0b;',
    danger: 'color:#991b1b;background:#fee2e2;border-left:3px solid #ef4444;',
    ok:     'color:#166534;background:#dcfce7;border-left:3px solid #22c55e;',
  };
  if (alertas.length === 0) {
    alertasEl.innerHTML = '';
  } else {
    alertasEl.innerHTML = alertas.map(a =>
      `<div style="padding:8px 12px;border-radius:6px;margin-bottom:6px;font-size:13px;${colores[a.tipo]}">${iconos[a.tipo]} ${a.texto}</div>`
    ).join('');
  }

  // ── Renderizar cálculos ───────────────────────────────────────────────────
  if (calculos.length === 0) {
    calculosEl.style.display = 'none';
  } else {
    calculosEl.style.display = 'block';
    calculosEl.innerHTML = calculos.map(c => {
      const excede = c.limite != null && c.valor > c.limite;
      const color  = excede ? '#dc2626' : 'var(--text-primary)';
      return `<div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="color:var(--text-secondary);">${c.label}</span>
        <span style="font-weight:700;font-size:15px;color:${color};">${c.valor} <span style="font-size:11px;font-weight:400;">${c.unidad}</span>${c.limite ? ` <span style="font-size:10px;opacity:.6;">/ límite ${c.limite}</span>` : ''}</span>
      </div>`;
    }).join('<hr style="border:none;border-top:1px solid var(--border-color);margin:6px 0;">');
  }
}

function openMultaVideo(url, titulo) {
  // Abre el video en una ventana/modal simple
  const w = window.open('', '_blank', 'width=800,height=600,resizable=yes');
  if (w) {
    w.document.write(`<!DOCTYPE html><html><head><title>${titulo||'Video'}</title>
      <style>body{margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh;}
      video{max-width:100%;max-height:100vh;}</style></head>
      <body><video src="${url}" controls autoplay style="max-width:100%;max-height:100vh;"></video></body></html>`);
    w.document.close();
  }
}

function handleMultaAdjDrop(event) {
  event.preventDefault();
  document.getElementById('multa-adj-drop').classList.remove('drag-over');
  uploadMultaAdjuntos(event.dataTransfer.files);
}

async function uploadMultaAdjuntos(files) {
  const id = document.getElementById('multa-id').value;
  if (!id) return;
  dzSetStatus('multa-adj-drop', '⏳ Subiendo...', 'info');
  const fd = new FormData();
  for (const f of files) fd.append('adjuntos', f);
  try {
    await fetch(`/api/multas/${id}/adjuntos`, { method: 'POST', body: fd });
    loadMultaAdjuntos(id);
    dzSetStatus('multa-adj-drop', `✓ ${files.length} archivo(s) subido(s)`, 'ok');
    showToast(`${files.length} adjunto(s) subido(s)`);
  } catch(e) { dzSetStatus('multa-adj-drop', 'Error al subir', 'error'); }
}

async function addMultaLink() {
  const id = document.getElementById('multa-id').value;
  if (!id) return;
  const url = document.getElementById('multa-link-input').value.trim();
  const nombre = document.getElementById('multa-link-nombre').value.trim();
  if (!url) { showAlert('Ingresá una URL'); return; }
  await fetch(`/api/multas/${id}/adjuntos/link`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({url, nombre}) });
  document.getElementById('multa-link-input').value = '';
  document.getElementById('multa-link-nombre').value = '';
  loadMultaAdjuntos(id);
  showToast('Link guardado');
}

async function deleteMultaAdj(adjId, multaId) {
  if (!await showConfirm('¿Eliminar este adjunto?')) return;
  await fetch(`/api/multas/${multaId}/adjuntos/${adjId}`, { method: 'DELETE' });
  loadMultaAdjuntos(multaId);
}

// ── Callback IA multa (usado por _dzMultaOcr.onExtract) ─────
function _fillMultaFromAI(d) {
  let filled = 0;
  const set = (id, val) => {
    if (!val) return;
    const el = document.getElementById(id);
    if (!el) return;
    if (el._ssSet) el._ssSet(String(val)); else el.value = val;
    filled++;
  };

  set('multa-numero-acta',    d.numero_acta);
  set('multa-fecha',          d.fecha_infraccion);
  set('multa-hora',           d.hora_infraccion);
  set('multa-vencimiento',    d.fecha_vencimiento);
  set('multa-descripcion',    d.descripcion);
  set('multa-articulo',       d.articulo_infringido);
  set('multa-lugar',          d.lugar);
  set('multa-puntos',         d.puntos);
  set('multa-nombre-infractor', d.nombre_infractor);
  set('multa-dni-infractor',  d.dni_infractor);
  set('multa-notas',          d.notas);
  set('multa-codigo-postal',  d.codigo_seguimiento_postal);
  if (d.monto) { setAmt('multa-monto', d.monto); filled++; }

  // Autoseleccionar municipalidad/organismo
  const orgTexto = (d.municipalidad || d.organismo || '').toLowerCase().trim();
  if (orgTexto) {
    const mSel = document.getElementById('multa-municipalidad');
    if (mSel) {
      let best = null, bestScore = 0;
      for (const opt of mSel.options) {
        const t = opt.text.toLowerCase();
        if (t.includes(orgTexto) || orgTexto.includes(t.split(' ')[0])) {
          const score = t === orgTexto ? 3 : t.includes(orgTexto) ? 2 : 1;
          if (score > bestScore) { best = opt; bestScore = score; }
        }
      }
      if (best) {
        if (mSel._ssSet) mSel._ssSet(best.value); else mSel.value = best.value;
        filled++;
      }
    }
  }

  // Autoseleccionar vehículo por patente
  if (d.patente) {
    const vSel = document.getElementById('multa-vehiculo');
    if (vSel) {
      for (const opt of vSel.options) {
        if (opt.text.toUpperCase().includes(d.patente.replace(/[^A-Z0-9]/gi, '').toUpperCase())) {
          if (vSel._ssSet) vSel._ssSet(opt.value); else vSel.value = opt.value;
          filled++; break;
        }
      }
    }
  }

  const st = _dzMultaOcr?._stEl;
  if (st) {
    st.textContent = filled > 0 ? `✓ ${filled} campos completados` : '⚠ No se encontraron datos';
    st.style.color = filled > 0 ? 'var(--color-success)' : 'orange';
  }
  if (filled > 0) showToast(`✓ ${filled} campos extraídos de la multa`);
  else showAlert('La IA no pudo extraer datos suficientes del documento');
}

// ============================================================
// BÚSQUEDA DE RESPONSABLE EN WHATSAPP
// ============================================================
let _waChoferEncontradoId = null;  // chofer_id sugerido por la IA

async function buscarResponsableWA() {
  const multaId = document.getElementById('multa-id').value;
  if (!multaId) { showAlert('Guardá la multa primero'); return; }

  const fecha   = document.getElementById('multa-fecha').value;
  const hora    = document.getElementById('multa-hora').value;
  const patente = document.querySelector('#multa-vehiculo option:checked')?.text?.split(' - ')[0] || '';

  if (!fecha) { showAlert('La multa no tiene fecha de infracción cargada'); return; }

  // Mostrar modal con spinner
  _waChoferEncontradoId = null;
  document.getElementById('wa-resultado-body').innerHTML = `
    <div style="text-align:center;padding:30px 0;">
      <i class="fa-solid fa-spinner fa-spin" style="font-size:2rem;color:#25D366;"></i>
      <p style="margin-top:12px;color:var(--text-secondary);">Analizando chats de WhatsApp de los choferes…<br>
      <small>Buscando mensajes entre ${formatDate(fecha)}${hora ? ' a las ' + hora : ''}</small></p>
    </div>`;
  document.getElementById('btn-wa-asignar-chofer').style.display = 'none';
  openModal('modal-wa-resultado');

  try {
    const res = await fetch('/api/whatsapp/buscar-responsable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        multa_id: multaId,
        fecha_infraccion: fecha,
        hora_infraccion: hora || null,
        patente,
        vehiculo_id: document.getElementById('multa-vehiculo').value,
      })
    });
    const data = await res.json();

    if (!res.ok) {
      document.getElementById('wa-resultado-body').innerHTML = `
        <div class="badge badge-danger" style="font-size:13px;padding:10px 14px;display:block;">
          <i class="fa-solid fa-circle-xmark"></i> ${data.message}
        </div>`;
      return;
    }

    _renderWAResultado(data, fecha, hora, patente);

  } catch (err) {
    document.getElementById('wa-resultado-body').innerHTML = `
      <div class="badge badge-danger" style="font-size:13px;padding:10px 14px;display:block;">
        Error: ${err.message}
      </div>`;
  }
}

function _renderWAResultado(data, fecha, hora, patente) {
  const body = document.getElementById('wa-resultado-body');
  const btnAsignar = document.getElementById('btn-wa-asignar-chofer');

  // Confianza → color
  const confColor = { alta: 'var(--color-success)', media: 'orange', baja: 'var(--color-error)' }[data.confianza] || 'var(--text-secondary)';

  // Choferes analizados
  const analizados = (data.choferes_analizados || [])
    .map(c => `<span class="badge badge-success" style="font-size:11px;margin:2px;">${c.nombre} (${c.mensajes} msgs)</span>`)
    .join('') || '<span style="color:var(--text-secondary);">ninguno</span>';

  const sinChat = (data.choferes_sin_chat || [])
    .map(c => `<span class="badge badge-secondary" style="font-size:11px;margin:2px;" title="${c.error}">${c.chofer}</span>`)
    .join('');

  if (!data.encontrado) {
    body.innerHTML = `
      <div style="background:var(--bg-tertiary);border-radius:8px;padding:16px;margin-bottom:14px;">
        <p style="font-size:14px;color:var(--text-secondary);margin:0;">
          <i class="fa-solid fa-magnifying-glass-minus"></i>
          <strong>No se encontró evidencia</strong> de quién tenía el vehículo <strong>${patente}</strong> el
          ${formatDate(fecha)}${hora ? ' a las ' + hora : ''}.
        </p>
        ${data.explicacion ? `<p style="margin:10px 0 0;font-size:13px;">${data.explicacion}</p>` : ''}
      </div>
      <div style="font-size:12px;color:var(--text-secondary);">
        <strong>Chats analizados:</strong> ${analizados}<br>
        ${sinChat ? `<strong>Sin chat encontrado:</strong> ${sinChat}` : ''}
      </div>`;
    btnAsignar.style.display = 'none';
    return;
  }

  const ch = data.chofer_responsable;
  _waChoferEncontradoId = ch?.id || null;

  body.innerHTML = `
    <div style="background:var(--bg-tertiary);border-radius:10px;padding:18px;margin-bottom:14px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <div style="width:44px;height:44px;border-radius:50%;background:#25D366;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <i class="fa-solid fa-user" style="color:#fff;font-size:1.2rem;"></i>
        </div>
        <div>
          <div style="font-size:16px;font-weight:700;">${ch?.nombre || '—'}</div>
          <div style="font-size:12px;color:var(--text-secondary);">${ch?.celular || ''}</div>
        </div>
        <div style="margin-left:auto;text-align:right;">
          <div style="font-size:11px;color:var(--text-secondary);">Confianza</div>
          <div style="font-weight:700;color:${confColor};font-size:14px;">${(data.confianza||'').toUpperCase()}</div>
        </div>
      </div>

      ${data.evidencia ? `
      <div style="background:rgba(37,211,102,0.08);border-left:3px solid #25D366;border-radius:4px;padding:10px 12px;margin-bottom:10px;">
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">
          <i class="fa-brands fa-whatsapp" style="color:#25D366;"></i>
          Mensaje clave${data.fecha_mensaje ? ' — ' + data.fecha_mensaje : ''}
        </div>
        <div style="font-size:13px;font-style:italic;">"${data.evidencia}"</div>
      </div>` : ''}

      ${data.explicacion ? `<p style="font-size:13px;margin:8px 0 0;color:var(--text-secondary);">${data.explicacion}</p>` : ''}
    </div>

    <div style="font-size:12px;color:var(--text-secondary);">
      <strong>Chats analizados:</strong> ${analizados}<br>
      ${sinChat ? `<strong>Sin chat:</strong> ${sinChat}` : ''}
    </div>`;

  btnAsignar.style.display = _waChoferEncontradoId ? 'inline-flex' : 'none';
}

async function asignarChoferDesdeWA() {
  if (!_waChoferEncontradoId) return;
  const multaId = document.getElementById('multa-id').value;
  if (!multaId) return;

  // Actualizar el select de chofer en el modal
  document.getElementById('multa-chofer').value = _waChoferEncontradoId;

  // Guardar cambio directo en DB
  try {
    await fetch(`/api/multas/${multaId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vehiculo_id:     document.getElementById('multa-vehiculo').value,
        chofer_id:       _waChoferEncontradoId,
        municipalidad_id: document.getElementById('multa-municipalidad').value || null,
        numero_acta:     document.getElementById('multa-numero-acta').value || null,
        fecha_infraccion: document.getElementById('multa-fecha').value || null,
        hora_infraccion:  document.getElementById('multa-hora').value || null,
        fecha_vencimiento: document.getElementById('multa-vencimiento').value || null,
        descripcion:     document.getElementById('multa-descripcion').value,
        articulo_infringido: document.getElementById('multa-articulo').value || null,
        lugar:           document.getElementById('multa-lugar').value || null,
        monto:           getAmt('multa-monto') || null,
        puntos:          document.getElementById('multa-puntos').value || null,
        estado:          document.getElementById('multa-estado').value,
        url_consulta:    document.getElementById('multa-url-consulta').value || null,
        nombre_infractor: document.getElementById('multa-nombre-infractor').value || null,
        dni_infractor:   document.getElementById('multa-dni-infractor').value || null,
        notas:           document.getElementById('multa-notas').value || null,
      })
    });
    showToast('✓ Chofer asignado a la multa');
    closeModal('modal-wa-resultado');
    loadMultas();
  } catch (err) {
    showAlert('Error al asignar: ' + err.message);
  }
}

async function openMultaAdjuntos(multaId) {
  const m = _cachedMultas.find(x => x.id === multaId);
  // Si hay exactamente 1 adjunto PDF → abrir directo en el visor flotante
  if (m && m.adj_count === 1 && m.primer_adj_tipo === 'pdf') {
    try {
      const res = await fetch(`/api/multas/${multaId}/adjuntos`);
      const adjs = await res.json();
      if (adjs.length === 1 && adjs[0].url) {
        const nombre = adjs[0].nombre_original || `Multa ${m.numero_acta || multaId}`;
        openDocViewer(adjs[0].url, nombre, true);
        return;
      }
    } catch(_) {}
  }
  // Varios adjuntos o no es PDF: abrir el tab completo
  editMulta(multaId).then(() => {
    // El tab Adjuntos es el 3° (índice 2) porque ahora hay: Datos, Auditoría, Adjuntos
    const tabs = document.querySelectorAll('#modal-multa .modal-tab-btn');
    const adjTab = Array.from(tabs).find(t => t.dataset.modalTab === 'multa-tab-adjuntos');
    if (adjTab) switchModalTab(adjTab, 'multa-tab-adjuntos');
  });
}

// ============================================================
// MUNICIPALIDADES CRUD
// ============================================================
let _cachedMunicipalidades = [];

async function loadMunicipalidades() {
  try {
    const res = await fetch('/api/municipalidades');
    _cachedMunicipalidades = await res.json();
    const tbody = document.getElementById('municipalidades-table-body');
    tbody.innerHTML = '';
    _cachedMunicipalidades.forEach((m, idx) => {
      const tr = document.createElement('tr');
      if (idx % 2 === 1) tr.classList.add('row-alt');
      const jBadge = {CABA:'badge-info',PBA:'badge-success',NACIONAL:'badge-warning',OTRO:'badge-secondary'}[m.jurisdiccion]||'badge-secondary';
      const hasUrl = !!m.url_consulta;
      tr.innerHTML = `
        <td><strong>${m.nombre}</strong>${m.notas?`<br><small style="color:var(--text-secondary);font-size:11px;">${m.notas.substring(0,60)}</small>`:''}</td>
        <td><span class="badge ${jBadge}">${m.jurisdiccion}</span></td>
        <td>${m.provincia||'-'}</td>
        <td>${hasUrl
          ? `<a href="${m.url_consulta}" target="_blank" class="link-celda" title="${m.url_consulta}" style="max-width:200px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;"><i class="fa-solid fa-external-link-alt"></i> ${m.url_consulta.replace(/^https?:\/\//,'').substring(0,35)}…</a>`
          : '-'}</td>
        <td>${m.telefono||'-'}</td>
        <td><span class="badge ${m.activa?'badge-success':'badge-danger'}">${m.activa?'activa':'inactiva'}</span></td>
        <td style="text-align:center;">
          ${hasUrl
            ? `<button class="btn btn-primary btn-sm" onclick="abrirModalVerificacion(${m.id})" title="Verificar multas en este organismo">
                <i class="fa-solid fa-magnifying-glass"></i>
               </button>`
            : `<span style="color:var(--text-secondary);font-size:11px;">sin URL</span>`}
        </td>
        <td style="text-align:center;">
          <button class="tbl-action-btn tbl-btn-edit"   onclick="editMunicipalidad(${m.id})"   title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
          <button class="tbl-action-btn tbl-btn-delete" onclick="deleteMunicipalidad(${m.id})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>
        </td>`;
      tbody.appendChild(tr);
    });
    bindHeaderEvents();
    injectExportBar('table-municipalidades', 'Municipalidades');
  } catch(err) { console.error('Error al cargar municipalidades:', err); }
}

function openAddMunicipalidadModal() {
  document.getElementById('form-municipalidad').reset();
  document.getElementById('mun-id').value = '';
  document.getElementById('modal-municipalidad-title').innerText = 'Nueva Municipalidad';
  document.getElementById('btn-submit-municipalidad').innerText = 'Registrar';
  document.getElementById('mun-activa-container').style.display = 'none';
  openModal('modal-municipalidad');
}

function editMunicipalidad(id) {
  const m = _cachedMunicipalidades.find(x => x.id === id);
  if (!m) return;
  document.getElementById('mun-id').value = m.id;
  document.getElementById('mun-nombre').value = m.nombre;
  document.getElementById('mun-jurisdiccion').value = m.jurisdiccion;
  document.getElementById('mun-provincia').value = m.provincia||'';
  document.getElementById('mun-telefono').value = m.telefono||'';
  document.getElementById('mun-email').value = m.email_contacto||'';
  document.getElementById('mun-url-consulta').value = m.url_consulta||'';
  document.getElementById('mun-url-pago').value = m.url_pago||'';
  document.getElementById('mun-notas').value = m.notas||'';
  document.getElementById('mun-activa').checked = m.activa === 1;
  document.getElementById('mun-activa-container').style.display = 'block';
  document.getElementById('modal-municipalidad-title').innerText = 'Editar Municipalidad';
  document.getElementById('btn-submit-municipalidad').innerText = 'Guardar Cambios';
  openModal('modal-municipalidad');
}

async function saveMunicipalidad(e) {
  e.preventDefault();
  const id = document.getElementById('mun-id').value;
  const isEdit = id !== '';
  const data = {
    nombre: document.getElementById('mun-nombre').value,
    jurisdiccion: document.getElementById('mun-jurisdiccion').value,
    provincia: document.getElementById('mun-provincia').value || null,
    telefono: document.getElementById('mun-telefono').value || null,
    email_contacto: document.getElementById('mun-email').value || null,
    url_consulta: document.getElementById('mun-url-consulta').value || null,
    url_pago: document.getElementById('mun-url-pago').value || null,
    notas: document.getElementById('mun-notas').value || null,
    activa: isEdit ? (document.getElementById('mun-activa').checked ? 1 : 0) : 1,
  };
  try {
    const res = await fetch(isEdit ? `/api/municipalidades/${id}` : '/api/municipalidades', {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (res.ok) {
      showToast(isEdit ? 'Municipalidad actualizada' : 'Municipalidad registrada');
      closeModal('modal-municipalidad');
      loadMunicipalidades();
    } else { const err = await res.json(); showAlert(`Error: ${err.message}`); }
  } catch(err) { showAlert('Error al guardar.', 'error', 'error'); }
}

async function deleteMunicipalidad(id) {
  if (!await showConfirm('¿Eliminar esta municipalidad?')) return;
  await fetch(`/api/municipalidades/${id}`, { method: 'DELETE' });
  loadMunicipalidades();
}

// ============================================================
// VERIFICACIÓN DE MULTAS — Puppeteer
// ============================================================
let _verifJobId        = null;
let _verifMuniId       = null;
let _verifMuniNombre   = '';
let _verifSseSource    = null;
let _verifResultado    = null;   // resultado parseado por IA
let _verifPatente      = '';     // patente del vehículo en consulta

async function abrirModalVerificacion(municipalidadId) {
  const muni = _cachedMunicipalidades.find(m => m.id === municipalidadId);
  if (!muni) return;

  _verifMuniId     = municipalidadId;
  _verifMuniNombre = muni.nombre;
  _verifJobId      = null;
  _verifResultado  = null;

  document.getElementById('verif-muni-nombre').textContent = muni.nombre;

  // Panel derecho oculto, izquierdo visible
  _verifCerrarPanel();

  // Bot WA solo para CABA
  const esCABA = (muni.url_consulta || '').includes('buenosaires.gob.ar');
  const btnWaBot = document.getElementById('verif-btn-wa-bot');
  if (btnWaBot) btnWaBot.style.display = esCABA ? 'flex' : 'none';

  // Cargar vehículos
  const vSel = document.getElementById('verif-vehiculo');
  vSel.innerHTML = '<option value="">-- Seleccionar --</option>';
  try {
    const vRes = await fetch('/api/vehiculos');
    const vList = await vRes.json();
    vList.forEach(v => {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = `${v.patente} — ${(v.marca||'')} ${(v.modelo||'')}`.trim();
      vSel.appendChild(o);
    });
    SmartCombo.refresh(vSel);
  } catch {}

  openModal('modal-verificacion');
}

function _verifCerrarPanel() {
  const right = document.getElementById('verif-panel-right');
  if (right) right.style.display = 'none';
  const s2 = document.getElementById('verif-step-2');
  const s3 = document.getElementById('verif-step-3');
  if (s2) s2.style.display = 'none';
  if (s3) s3.style.display = 'none';
  const pb = document.getElementById('verif-patente-box');
  if (pb) pb.style.display = 'none';
  const log = document.getElementById('verif-log');
  if (log) log.innerHTML = '';
  const extraer = document.getElementById('verif-btn-extraer');
  if (extraer) extraer.style.display = 'none';
}

function _verifCerrarNavegador() {
  // Cierra el navegador/job pero NO cierra el modal ni el panel izquierdo
  if (_verifJobId) {
    fetch(`/api/verificacion/${_verifJobId}`, { method: 'DELETE' }).catch(() => {});
    _verifJobId = null;
  }
  if (_verifSseSource) { _verifSseSource.close(); _verifSseSource = null; }
  _registrarVerifLog('cancelado', 0);
  _verifCerrarPanel();
}

async function _verifOnVehiculoChange(vehiculoId) {
  const infoBox   = document.getElementById('verif-ultima-info');
  const histBox   = document.getElementById('verif-historial');
  const histList  = document.getElementById('verif-historial-list');
  if (!vehiculoId || !_verifMuniId) { if (infoBox) infoBox.style.display = 'none'; if (histBox) histBox.style.display = 'none'; return; }
  try {
    const [ultimo, historial] = await Promise.all([
      fetch(`/api/verificacion/log/ultimo/${vehiculoId}/${_verifMuniId}`).then(r => r.json()),
      fetch(`/api/verificacion/log/${vehiculoId}/${_verifMuniId}`).then(r => r.json()),
    ]);
    if (ultimo) {
      const fecha = new Date(ultimo.fecha).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });
      const colores = { sin_multas:'var(--color-success)', con_multas:'var(--color-error)', error:'var(--color-warning)', cancelado:'var(--text-secondary)' };
      const labels  = { sin_multas:'Sin multas', con_multas:`${ultimo.multas_encontradas} multa(s) encontrada(s)`, error:'Error', cancelado:'Cancelado' };
      document.getElementById('verif-ultima-fecha').textContent = fecha;
      document.getElementById('verif-ultima-resultado').innerHTML = `<span style="color:${colores[ultimo.resultado]||''};font-weight:600;">${labels[ultimo.resultado]||ultimo.resultado}</span>${ultimo.usuario ? ` · ${ultimo.usuario}` : ''}`;
      infoBox.style.display = 'block';
    } else {
      infoBox.style.display = 'none';
    }
    if (historial?.length > 1) {
      histList.innerHTML = historial.slice(0,8).map(h => {
        const f = new Date(h.fecha).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
        const col = { sin_multas:'var(--color-success)', con_multas:'var(--color-error)', error:'#c96a00', cancelado:'var(--text-secondary)' }[h.resultado] || '';
        const ico = { sin_multas:'✓', con_multas:'⚠', error:'✗', cancelado:'–' }[h.resultado] || '·';
        return `<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-color);">
          <span style="color:${col};font-weight:700;">${ico}</span>
          <span style="flex:1;color:var(--text-secondary);">${f}</span>
          <span style="color:${col};">${h.multas_encontradas ? h.multas_encontradas+'m' : ''}</span>
        </div>`;
      }).join('');
      histBox.style.display = 'block';
    } else {
      histBox.style.display = 'none';
    }
  } catch (_) { if (infoBox) infoBox.style.display = 'none'; }
}

async function _registrarVerifLog(resultado, multasEncontradas = 0, multasImportadas = 0) {
  const vehiculoId = document.getElementById('verif-vehiculo')?.value;
  if (!vehiculoId || !_verifMuniId) return;
  await fetch('/api/verificacion/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vehiculo_id: vehiculoId, municipalidad_id: _verifMuniId, resultado, multas_encontradas: multasEncontradas, multas_importadas: multasImportadas })
  }).catch(() => {});
  // Refrescar info en panel izquierdo
  _verifOnVehiculoChange(vehiculoId);
}

async function iniciarVerificacion(modo = 'manual') {
  const vehiculoId = document.getElementById('verif-vehiculo').value;
  if (!vehiculoId) { showAlert('Seleccioná un vehículo'); return; }

  // Mostrar panel derecho con step-2
  const right = document.getElementById('verif-panel-right');
  if (right) { right.style.display = 'flex'; }
  document.getElementById('verif-step-2').style.display = 'flex';
  document.getElementById('verif-step-3').style.display = 'none';

  // Resetear botón Extraer por si quedó de una sesión anterior
  const _btnEx = document.getElementById('verif-btn-extraer');
  if (_btnEx) {
    _btnEx.style.display = 'none';
    _btnEx.disabled = false;
    _btnEx.innerHTML = '<i class="fa-solid fa-download"></i> Extraer resultados de la página';
  }
  const _hint = document.getElementById('verif-hint');
  if (_hint) _hint.textContent = '';

  _verifLog(modo === 'auto' ? '🤖 Iniciando con Obscura (headless)...' : '🌐 Iniciando navegador...', 'info');

  try {
    const res = await fetch('/api/verificacion/iniciar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ municipalidad_id: _verifMuniId, vehiculo_id: vehiculoId, modo })
    });
    if (!res.ok) { const e = await res.json(); _verifLog('✗ Error: ' + e.message, 'error'); return; }
    const data = await res.json();
    _verifJobId    = data.jobId;
    _verifPatente  = data.patente || '';
    _mostrarPatenteVerif(_verifPatente);

    // Abrir SSE
    _verifSseSource = new EventSource(`/api/verificacion/${_verifJobId}/stream`);
    _verifSseSource.onmessage = (e) => _handleVerifEvent(JSON.parse(e.data));
    _verifSseSource.onerror   = () => _verifLog('⚠ Conexión SSE interrumpida', 'warn');

  } catch (err) {
    _verifLog('✗ Error al iniciar: ' + err.message, 'error');
  }
}

function _mostrarPatenteVerif(patente) {
  let box = document.getElementById('verif-patente-box');
  if (!box) return;
  if (!patente) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  const span = document.getElementById('verif-patente-txt');
  if (span) span.textContent = patente;
}

function _copiarPatenteVerif() {
  const p = _verifPatente || document.getElementById('verif-patente-txt')?.textContent || '';
  if (!p) return;
  navigator.clipboard.writeText(p).then(() => showToast(`✓ "${p}" copiado`, 'success')).catch(() => {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = p; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    showToast(`✓ "${p}" copiado`, 'success');
  });
}

async function consultarViaWABot() {
  const vehiculoId = document.getElementById('verif-vehiculo').value;
  if (!vehiculoId) { showAlert('Seleccioná un vehículo'); return; }

  // Obtener patente del select
  const opt = document.querySelector('#verif-vehiculo option:checked');
  const patente = opt ? opt.textContent.split('—')[0].trim() : '';
  if (!patente) { showAlert('No se pudo determinar la patente'); return; }

  // Mostrar paso 2 como log de progreso
  document.getElementById('verif-step-1').style.display = 'none';
  document.getElementById('verif-step-2').style.display = 'block';
  document.getElementById('verif-log').innerHTML = '';
  document.getElementById('verif-btn-extraer').style.display = 'none';
  _verifPatente = patente;
  _mostrarPatenteVerif(patente);

  _verifLog('📱 Iniciando consulta vía Bot de WhatsApp CABA…', 'info');
  _verifLog(`🔍 Consultando infracciones de "${patente}"…`, 'info');
  _verifLog('⏳ Esperando respuesta del bot (puede tardar hasta 20 segundos)…', 'info');

  try {
    const res  = await fetch('/api/multas/consultar-wa-caba', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patente })
    });
    const data = await res.json();

    if (!res.ok) {
      _verifLog(`✗ Error: ${data.message}`, 'error');
      document.getElementById('verif-btn-cancel').style.display = 'inline-flex';
      return;
    }

    _verifLog(data.sin_multas
      ? `✅ Sin infracciones pendientes para ${patente}`
      : `🎉 Encontradas ${data.multas?.length || 0} infracción(es) — total $${(data.total||0).toLocaleString('es-AR')}`,
      data.sin_multas ? 'ok' : 'ok');

    // Mostrar en paso 3 (misma estructura que el scraper)
    _mostrarResultadosVerificacion({
      patente,
      sin_multas: data.sin_multas,
      multas: (data.multas || []).map((m, i) => ({
        numero_acta:       `WA-${patente}-${i+1}`,
        fecha:             m.fecha_infraccion || '',
        hora:              m.hora_infraccion  || '',
        descripcion:       m.descripcion      || '',
        lugar:             m.lugar            || '',
        monto:             m.monto            || 0,
        puntos:            m.puntos           || 0,
        fecha_vencimiento: m.fecha_vencimiento|| '',
        estado:            'pendiente',
        url_prueba:        m.url_prueba       || '',
        fuente:            'wa_bot_caba'
      }))
    });

  } catch (err) {
    _verifLog(`✗ Error de conexión: ${err.message}`, 'error');
  }
}

function _verifLog(msg, type = 'info') {
  const log = document.getElementById('verif-log');
  if (!log) return;
  const color = type === 'error' ? 'var(--color-error)'
              : type === 'ok'    ? 'var(--color-success)'
              : type === 'warn'  ? 'orange'
              : 'var(--text-primary)';
  const line = document.createElement('div');
  line.style.color = color;
  line.textContent = msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function _handleVerifEvent(event) {
  const { status, msg, result } = event;

  const icons = {
    starting: '🚀', navigating: '🌐', filled: '✍️', manual_fill: '⚠️',
    captcha: '🔒', waiting_submit: '📋', ready: '✅', extracting: '🔍',
    ai_parsing: '🤖', done: '🎉', site_error: '⚠️', error: '❌',
    cancelled: '🚫'
  };
  _verifLog(`${icons[status]||'•'} ${msg}`, status === 'error' || status === 'cancelled' ? 'error' : status === 'done' || status === 'filled' ? 'ok' : 'info');

  const btnExtraer = document.getElementById('verif-btn-extraer');
  const hint       = document.getElementById('verif-hint');

  if (status === 'ready' || status === 'waiting_submit' || status === 'captcha' || status === 'manual_fill') {
    btnExtraer.style.display = 'inline-flex';
    if (status === 'captcha') {
      hint.textContent = 'Resolvé el CAPTCHA en el navegador que se abrió, enviá el formulario y cuando veas los resultados presioná "Extraer resultados".';
    } else if (status === 'manual_fill') {
      hint.textContent = `Ingresá la patente en el navegador, enviá el formulario y presioná "Extraer resultados".`;
    } else {
      hint.textContent = 'Cuando el navegador muestre los resultados de la consulta, presioná "Extraer resultados".';
    }
  }

  if (status === 'done' || status === 'site_error') {
    btnExtraer.style.display = 'none';
    hint.textContent = '';
    if (_verifSseSource) { _verifSseSource.close(); _verifSseSource = null; }
    _mostrarResultadosVerificacion(result);
  }

  if (status === 'error' || status === 'cancelled') {
    btnExtraer.style.display = 'none';
    if (_verifSseSource) { _verifSseSource.close(); _verifSseSource = null; }
  }
}

async function extraerResultadosVerificacion() {
  if (!_verifJobId) return;
  const btn = document.getElementById('verif-btn-extraer');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Extrayendo...';
  try {
    const res = await fetch(`/api/verificacion/${_verifJobId}/extraer`, { method: 'POST' });
    if (!res.ok) {
      const e = await res.json();
      _verifLog('✗ ' + e.message, 'error');
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-download"></i> Extraer resultados de la página';
    }
    // El resultado llega por SSE (_handleVerifEvent con status done)
  } catch (err) {
    _verifLog('✗ Error: ' + err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-download"></i> Extraer resultados de la página';
  }
}

async function _mostrarResultadosVerificacion(result) {
  if (!result) return;
  _verifResultado = result;

  // Mostrar panel derecho con step-3
  const right = document.getElementById('verif-panel-right');
  if (right) right.style.display = 'flex';
  document.getElementById('verif-step-2').style.display = 'none';
  document.getElementById('verif-step-3').style.display = 'flex';

  const msgEl = document.getElementById('verif-resultado-msg');
  const cont   = document.getElementById('verif-multas-container');
  const btnImp = document.getElementById('verif-btn-importar');

  if (result.error_sitio) {
    msgEl.innerHTML = `<div class="badge badge-warning" style="font-size:13px;padding:8px 12px;">⚠ ${result.error_sitio}</div>
      <p style="margin-top:10px;font-size:13px;color:var(--text-secondary);">El sitio puede requerir que completes el formulario manualmente o hubo un error al consultar.</p>`;
    cont.style.display = 'none';
    btnImp.style.display = 'none';
    _registrarVerifLog('error', 0);
    return;
  }

  if (result.sin_multas || !result.multas?.length) {
    msgEl.innerHTML = `<div class="badge badge-success" style="font-size:13px;padding:8px 12px;">✓ No hay infracciones registradas para esta patente</div>`;
    cont.style.display = 'none';
    btnImp.style.display = 'none';
    _registrarVerifLog('sin_multas', 0);
    return;
  }

  // Verificar cuáles actas ya están registradas en el sistema
  const todasActas = result.multas.map(m => m.numero_acta).filter(Boolean);
  const existingActas = new Set();
  if (todasActas.length) {
    try {
      const params = new URLSearchParams();
      todasActas.forEach(a => params.append('acta', a));
      const r = await fetch('/api/multas/check-actas?' + params);
      if (r.ok) { const d = await r.json(); d.forEach(a => existingActas.add(a)); }
    } catch {}
  }

  const nuevas = result.multas.filter(m => !existingActas.has(m.numero_acta)).length;
  const n = result.multas.length;
  _registrarVerifLog('con_multas', n);
  msgEl.innerHTML = `<div class="badge badge-warning" style="font-size:13px;padding:8px 12px;">
    <i class="fa-solid fa-triangle-exclamation"></i> ${n} infracción(es) encontrada(s)
    ${existingActas.size ? ` — <span style="color:#86efac;">${existingActas.size} ya registrada${existingActas.size!==1?'s':''}</span>, <strong>${nuevas} nueva${nuevas!==1?'s':''} para importar</strong>` : ' — revisalas y seleccioná las que querés importar'}
  </div>`;

  const tbody = document.getElementById('verif-multas-tbody');
  tbody.innerHTML = '';
  result.multas.forEach((m, i) => {
    const yaRegistrada = existingActas.has(m.numero_acta);
    const estadoBadge = { pagada: 'badge-success', vencida: 'badge-danger', pendiente: 'badge-warning' }[m.estado?.toLowerCase()] || 'badge-warning';
    const pruebaCount = m.prueba_urls?.length || 0;
    const pruebaDataAttr = encodeURIComponent(JSON.stringify(m.prueba_urls || []));
    const pruebaLabel   = encodeURIComponent(`${m.numero_acta||'Acta'} · ${_verifPatente||''}`);
    const pruebaTag = `<button type="button" id="prueba-btn-${i}" onclick="openPruebasViewer(decodeURIComponent('${pruebaDataAttr}'),decodeURIComponent('${pruebaLabel}'),${i})"
         style="background:none;border:none;padding:0;cursor:pointer;">
         <span class="badge ${pruebaCount > 0 ? 'badge-info' : 'badge-secondary'}" style="font-size:10px;cursor:pointer;">
           <i class="fa-solid fa-camera"></i> ${pruebaCount} Prueba${pruebaCount!==1?'s':''}
         </span>
       </button>`;
    // Fecha siempre editable (datetime-local para capturar hora también)
    const fechaVal = m.fecha_infraccion
      ? (m.fecha_infraccion.includes('T') ? m.fecha_infraccion.substring(0,16) : m.fecha_infraccion + 'T00:00')
      : '';
    const fechaCell = `<input type="datetime-local" class="verif-fecha-input" data-idx="${i}"
         value="${fechaVal}" style="width:155px;font-size:12px;"
         title="Fecha y hora de infracción">`;
    const tr = document.createElement('tr');
    if (yaRegistrada) tr.style.cssText = 'opacity:.45;';
    tr.innerHTML = `
      <td style="text-align:center;"><input type="checkbox" class="verif-multa-chk" value="${i}" ${yaRegistrada ? '' : 'checked'}></td>
      <td style="font-weight:600;">${m.numero_acta||'-'}${yaRegistrada ? ' <span title="Ya registrada en el sistema" style="font-size:10px;color:#22c55e;font-weight:400;">✓ ya registrada</span>' : ''}</td>
      <td>${fechaCell}</td>
      <td style="max-width:200px;">${m.descripcion||'-'}<br>
        <small style="color:var(--text-secondary);">${m.articulo_infringido||''}</small><br>
        <small style="color:var(--text-secondary);">${m.lugar||''}</small>
      </td>
      <td style="color:var(--color-error);font-weight:600;">${m.monto ? '$' + parseFloat(m.monto).toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2}) : '-'}</td>
      <td>${m.fecha_vencimiento ? formatDate(m.fecha_vencimiento) : '-'}</td>
      <td><span class="badge ${estadoBadge}">${m.estado||'pendiente'}</span></td>
      <td>${pruebaTag}</td>`;
    tbody.appendChild(tr);
    // Inicializar DatePicker estándar en celdas de fecha vacía
    const dpInput = tr.querySelector('.verif-fecha-input');
    if (dpInput) {
      DatePicker.init(dpInput);
      dpInput.addEventListener('change', () => _verifSetFecha(i, dpInput.value));
    }
  });

  cont.style.display = 'block';
  btnImp.style.display = 'inline-flex';
  document.getElementById('verif-check-all').checked = nuevas > 0;
}

function toggleAllVerifMultas(checked) {
  document.querySelectorAll('.verif-multa-chk').forEach(cb => cb.checked = checked);
}

function _verifSetFecha(idx, value) {
  if (_verifResultado?.multas?.[idx]) {
    _verifResultado.multas[idx].fecha_infraccion = value;
  }
}

// ── Visor de pruebas de multas (grid fotos + video + DropZones) ───────────────
let _pruebaManualUrls = []; // URLs de imágenes pegadas/arrastradas manualmente
let _pruebaMultaIdx   = -1; // índice de la multa en _verifResultado.multas actualmente abierta
let _pruebaCurrentUrls = []; // copia mutable de las URLs del visor abierto (fotos ya existentes)

// Extrae timestamp YYYYMMDDHHMMSS del nombre de archivo para ordenar cronológicamente
function _pruebaExtractTs(url) {
  const m = (url || '').match(/(\d{14})/);
  return m ? m[1] : url;
}

function openPruebasViewer(urlsJson, label, multaIdx) {
  let urls = [];
  try { urls = JSON.parse(urlsJson); } catch {}
  _pruebaManualUrls = [];
  _pruebaMultaIdx   = multaIdx ?? -1;
  _pruebaCurrentUrls = [...urls];

  const isVid = u => /\.(mp4|webm|ogg|mov|avi|mkv)(\?|$)/i.test(u) || /video/i.test(u);
  // Ordenar fotos por timestamp en filename (más antigua primero = secuencia de la infracción)
  const fotos = urls.filter(u => !isVid(u)).sort((a,b) => _pruebaExtractTs(a).localeCompare(_pruebaExtractTs(b)));
  const vids  = urls.filter(u =>  isVid(u));

  let ov = document.getElementById('modal-pruebas-viewer');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'modal-pruebas-viewer';
    ov.className = 'modal-overlay';
    ov.style.cssText = 'background:transparent;pointer-events:none;';
    document.body.appendChild(ov);
  }

  ov.innerHTML = `
    <div id="pruebas-panel" style="
      position:fixed;top:80px;left:50%;transform:translateX(-50%);
      width:min(1100px,96vw);max-height:85vh;
      background:#1e2a3a;border-radius:12px;
      box-shadow:0 8px 40px rgba(0,0,0,.5);
      display:flex;flex-direction:column;overflow:hidden;
      pointer-events:auto;z-index:13000;">
      <!-- Header draggable -->
      <div id="pruebas-hdr" style="
        display:flex;align-items:center;gap:8px;
        padding:10px 14px;border-bottom:1px solid var(--border-color);
        cursor:move;user-select:none;background:#162030;border-radius:12px 12px 0 0;color:#e2e8f0;">
        <i class="fa-solid fa-camera" style="color:var(--text-secondary);"></i>
        <span style="font-weight:600;font-size:14px;flex:1;">Imágenes de Infracción${label ? ' <span style="color:var(--text-secondary);font-weight:400;">— ' + label + '</span>' : ''}</span>
        <button type="button" onclick="_closePruebasViewer()"
          style="background:none;border:none;cursor:pointer;font-size:20px;
                 color:var(--text-secondary);line-height:1;padding:2px 6px;"
          title="Cerrar">×</button>
      </div>
      <!-- Grid de fotos -->
      <div style="padding:14px;overflow-y:auto;flex:1;background:#1e2a3a;">
        <div id="pruebas-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;">
          ${fotos.map((u,i) => _pruebaThumbHtml(u, i)).join('')}
          ${_pruebaDzSlots(fotos.length)}
        </div>
      </div>
      <!-- Footer: videos + cerrar -->
      <div style="display:flex;align-items:center;justify-content:space-between;
                  padding:10px 14px;border-top:1px solid #2d4060;gap:8px;flex-wrap:wrap;background:#162030;border-radius:0 0 12px 12px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          ${vids.map((u,i) => `
            <a href="${u}" target="_blank" rel="noopener" class="btn btn-secondary" style="font-size:13px;gap:6px;">
              <i class="fa-solid fa-circle-play"></i> Ver video${vids.length>1?' '+(i+1):''}
            </a>`).join('')}
          <button type="button" onclick="_pruebaDzAddSlots()" class="btn btn-secondary" style="font-size:13px;gap:6px;">
            <i class="fa-solid fa-plus"></i> Más slots
          </button>
          <button type="button" onclick="_pruebaCropOpen()" class="btn btn-secondary" style="font-size:13px;gap:6px;" title="Pegá una captura de pantalla y recortá la zona que querés guardar">
            <i class="fa-solid fa-crop-simple"></i> Recortar
          </button>
        </div>
        <button type="button" onclick="_closePruebasViewer()" class="btn btn-secondary">Cerrar</button>
      </div>
    </div>`;

  ov.classList.add('active');
  _pruebaMakeDraggable(document.getElementById('pruebas-panel'), document.getElementById('pruebas-hdr'));
  _pruebaDzInit();
}

function _pruebaThumbHtml(url, i) {
  const safe = url.replace(/'/g,"&#39;");
  return `<div style="position:relative;border-radius:6px;overflow:hidden;background:#1a1a2e;
           aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;
           border:2px solid var(--border-color);">
    <img src="${safe}" alt="Foto ${i+1}"
      style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;"
      onclick="_pruebaZoom('${safe}')"
      onerror="this.parentElement.innerHTML='<div style=\'display:flex;flex-direction:column;align-items:center;gap:6px;color:#555;padding:16px;\'><i class=\'fa-solid fa-image-slash\' style=\'font-size:1.8rem;\'></i><span style=\'font-size:11px;\'>No disponible</span></div>'">
    <button type="button" onclick="event.stopPropagation();_pruebaDeleteImg(${i})"
      title="Eliminar imagen"
      style="position:absolute;top:5px;right:5px;width:24px;height:24px;border-radius:50%;
             border:none;background:rgba(0,0,0,.7);color:#fff;font-size:13px;line-height:1;
             cursor:pointer;display:flex;align-items:center;justify-content:center;
             transition:background .15s;z-index:2;"
      onmouseover="this.style.background='#dc2626'" onmouseout="this.style.background='rgba(0,0,0,.7)'">
      <i class="fa-solid fa-xmark"></i>
    </button>
  </div>`;
}

function _pruebaDeleteImg(idx) {
  showConfirm('¿Eliminar esta imagen?').then(ok => {
    if (!ok) return;
    // Quitar del array en memoria
    _pruebaCurrentUrls.splice(idx, 1);
    // Si la multa existe en el resultado, sincronizar
    if (_pruebaMultaIdx >= 0 && _verifResultado?.multas?.[_pruebaMultaIdx]) {
      _verifResultado.multas[_pruebaMultaIdx].prueba_urls = [..._pruebaCurrentUrls];
      // Actualizar badge
      const total = _pruebaCurrentUrls.length;
      const btn = document.getElementById(`prueba-btn-${_pruebaMultaIdx}`);
      if (btn) {
        const badge = btn.querySelector('.badge');
        if (badge) {
          badge.className = `badge ${total > 0 ? 'badge-info' : 'badge-secondary'}`;
          badge.innerHTML = `<i class="fa-solid fa-camera"></i> ${total} Prueba${total!==1?'s':''}`;
        }
        const newData = encodeURIComponent(JSON.stringify(_pruebaCurrentUrls));
        const lbl = btn.getAttribute('onclick')?.match(/decodeURIComponent\('([^']+)'\),\s*\d/)?.[1] || '';
        btn.setAttribute('onclick', `openPruebasViewer(decodeURIComponent('${newData}'),decodeURIComponent('${lbl}'),${_pruebaMultaIdx})`);
      }
    }
    // Re-renderizar el grid
    const grid = document.getElementById('pruebas-grid');
    if (!grid) return;
    const isVid = u => /\.(mp4|webm|ogg|mov|avi|mkv)(\?|$)/i.test(u) || /video/i.test(u);
    const fotos = _pruebaCurrentUrls.filter(u => !isVid(u))
                    .sort((a,b) => _pruebaExtractTs(a).localeCompare(_pruebaExtractTs(b)));
    // Preservar slots de dropzone existentes
    const slots = grid.querySelectorAll('.prueba-dz-slot');
    grid.innerHTML = fotos.map((u, i) => _pruebaThumbHtml(u, i)).join('');
    slots.forEach(s => grid.appendChild(s));
  });
}

let _pruebaDzCount = 0; // total de slots creados

function _pruebaDzSlotHtml(i) {
  return `<div class="prueba-dz-slot" data-slot="${i}"
    style="border:2px dashed var(--border-color);border-radius:6px;aspect-ratio:4/3;
           display:flex;flex-direction:column;align-items:center;justify-content:center;
           gap:6px;color:var(--text-secondary);cursor:pointer;font-size:12px;
           transition:border-color .2s,background .2s;"
    onclick="document.getElementById('prueba-file-${i}').click()"
    ondragover="event.preventDefault();this.style.borderColor='var(--accent-primary)';this.style.background='rgba(99,102,241,.08)'"
    ondragleave="this.style.borderColor='';this.style.background=''"
    ondrop="_pruebaDzDrop(event,${i})">
    <i class="fa-solid fa-photo-film" style="font-size:1.5rem;opacity:.4;"></i>
    <span style="text-align:center;line-height:1.4;">Foto o video<br>
      <span style="font-size:11px;">Arrastrá · Clic · <kbd style="font-size:10px;padding:1px 4px;border:1px solid var(--border-color);border-radius:3px;">Ctrl+V</kbd></span>
    </span>
    <input type="file" id="prueba-file-${i}" accept="image/*,video/*" style="display:none"
      onchange="_pruebaDzLoad(event,${i})">
  </div>`;
}

function _pruebaDzSlots(existing) {
  _pruebaDzCount = 4;
  return Array.from({length:4}, (_,i) => _pruebaDzSlotHtml(i)).join('');
}

function _pruebaDzAddSlots() {
  const grid = document.getElementById('pruebas-grid');
  if (!grid) return;
  // Agregar 4 slots más
  for (let i = _pruebaDzCount; i < _pruebaDzCount + 4; i++) {
    grid.insertAdjacentHTML('beforeend', _pruebaDzSlotHtml(i));
  }
  _pruebaDzCount += 4;
}

function _pruebaDzInit() {
  // Bloquear ESC mientras el visor esté abierto
  document._pruebaEscHandler = e => {
    if (e.key !== 'Escape') return;
    const filled = [...document.querySelectorAll('.prueba-dz-slot')].some(s => s.dataset.filled);
    if (filled) {
      e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault();
      showConfirm('¿Cerrar el visor? Las imágenes cargadas manualmente se perderán.').then(ok => { if (ok) _closePruebasViewer(); });
    } else {
      e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault();
      _closePruebasViewer();
    }
  };
  document.addEventListener('keydown', document._pruebaEscHandler, true);

  // Paste global: pegar imagen/video en el primer slot libre
  document._pruebaPasteHandler = e => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/') || item.type.startsWith('video/')) {
        const file = item.getAsFile();
        const slots = document.querySelectorAll('.prueba-dz-slot');
        const freeIdx = [...slots].findIndex(s => !s.dataset.filled);
        if (file && freeIdx !== -1) _pruebaDzSetFile(file, freeIdx);
      }
    }
  };
  document.addEventListener('paste', document._pruebaPasteHandler);
}

function _pruebaDzDrop(e, slot) {
  e.preventDefault();
  e.currentTarget.style.borderColor = '';
  e.currentTarget.style.background  = '';
  const file = e.dataTransfer.files[0];
  if (file) _pruebaDzSetFile(file, slot);
}

function _pruebaDzLoad(e, slot) {
  const file = e.target.files[0];
  if (file) _pruebaDzSetFile(file, slot);
}

function _pruebaDzSetFile(file, slot) {
  // Reusar el primer slot vacío disponible si el slot pedido ya está ocupado
  const slots = document.querySelectorAll('.prueba-dz-slot');
  let targetSlot = slot;
  if (slots[slot] && !slots[slot].dataset.filled) {
    targetSlot = slot;
  } else {
    for (let i = 0; i < slots.length; i++) {
      if (!slots[i].dataset.filled) { targetSlot = i; break; }
    }
  }
  const url = URL.createObjectURL(file);
  _pruebaManualUrls[targetSlot] = url;
  const slotEl = document.querySelector(`.prueba-dz-slot[data-slot="${targetSlot}"]`);
  if (!slotEl) return;
  slotEl.dataset.filled = '1';
  slotEl.style.padding  = '0';
  slotEl.style.border   = '2px solid var(--border-color)';
  slotEl.style.overflow = 'hidden';
  slotEl.onclick = null;

  const isVid = file.type.startsWith('video/');
  if (isVid) {
    slotEl.innerHTML = `
      <div style="position:relative;width:100%;height:100%;background:#111;display:flex;align-items:center;justify-content:center;">
        <video src="${url}" style="width:100%;height:100%;object-fit:cover;" muted></video>
        <div onclick="event.stopPropagation();_pruebaZoomVideo('${url}')"
          style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;cursor:pointer;background:rgba(0,0,0,.3);">
          <i class="fa-solid fa-circle-play" style="font-size:2.5rem;color:#fff;opacity:.9;"></i>
        </div>
      </div>`;
  } else {
    slotEl.innerHTML = `
      <img src="${url}" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;"
        onclick="event.stopPropagation();_pruebaZoom('${url}')">`;
  }
}

// ── Herramienta de recorte (captura de pantalla nativa) ──────────────────────
async function _pruebaCropOpen() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'never' }, audio: false });
  } catch { return; } // usuario canceló

  // Capturar un frame del stream
  const video = document.createElement('video');
  video.srcObject = stream;
  await new Promise(r => { video.onloadedmetadata = r; });
  await video.play();
  await new Promise(r => requestAnimationFrame(r)); // esperar primer frame

  const fw = video.videoWidth, fh = video.videoHeight;
  const snap = document.createElement('canvas');
  snap.width = fw; snap.height = fh;
  snap.getContext('2d').drawImage(video, 0, 0);
  stream.getTracks().forEach(t => t.stop());

  // Overlay a pantalla completa con la captura
  let ov = document.getElementById('prueba-crop-ov');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'prueba-crop-ov';
  ov.style.cssText = 'position:fixed;inset:0;z-index:999999;cursor:crosshair;user-select:none;';
  document.body.appendChild(ov);

  // Canvas de fondo (screenshot)
  const bg = document.createElement('canvas');
  bg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  bg.width = fw; bg.height = fh;
  bg.getContext('2d').drawImage(snap, 0, 0);
  ov.appendChild(bg);

  // Canvas de overlay (oscuro + selección)
  const ol = document.createElement('canvas');
  ol.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  ol.width = fw; ol.height = fh;
  ov.appendChild(ol);
  const octx = ol.getContext('2d');

  // Label de instrucción
  const lbl = document.createElement('div');
  lbl.style.cssText = 'position:absolute;top:16px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.7);color:#fff;padding:6px 18px;border-radius:20px;font-size:14px;pointer-events:none;z-index:2;';
  lbl.textContent = 'Arrastrá para seleccionar la zona — ESC para cancelar';
  ov.appendChild(lbl);

  // Botón cancelar
  const btnCancel = document.createElement('button');
  btnCancel.textContent = '✕ Cancelar';
  btnCancel.style.cssText = 'position:absolute;top:16px;right:24px;z-index:3;background:#475569;border:none;color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px;';
  btnCancel.onclick = () => { ov.remove(); };
  ov.appendChild(btnCancel);

  // Estado drag
  let dragging = false, start = null, sel = null;

  function scalePos(e) {
    const rw = ol.getBoundingClientRect().width;
    const rh = ol.getBoundingClientRect().height;
    return { x: e.clientX * fw / rw, y: e.clientY * fh / rh };
  }

  function drawOverlay() {
    octx.clearRect(0, 0, fw, fh);
    octx.fillStyle = 'rgba(0,0,0,.5)';
    octx.fillRect(0, 0, fw, fh);
    if (!sel) return;
    octx.clearRect(sel.x, sel.y, sel.w, sel.h);
    octx.strokeStyle = '#38bdf8';
    octx.lineWidth = Math.max(2, fw / 800);
    octx.strokeRect(sel.x, sel.y, sel.w, sel.h);
  }
  drawOverlay();

  ov.addEventListener('mousedown', e => {
    dragging = true; start = scalePos(e); sel = null; drawOverlay();
  });
  ov.addEventListener('mousemove', e => {
    if (!dragging) return;
    const p = scalePos(e);
    sel = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y),
            w: Math.abs(p.x - start.x),  h: Math.abs(p.y - start.y) };
    drawOverlay();
  });
  ov.addEventListener('mouseup', () => {
    dragging = false;
    if (!sel || sel.w < 10 || sel.h < 10) return;
    // Recortar y guardar
    const out = document.createElement('canvas');
    out.width = sel.w; out.height = sel.h;
    out.getContext('2d').drawImage(snap, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
    out.toBlob(blob => {
      const slots = document.querySelectorAll('.prueba-dz-slot');
      const freeIdx = [...slots].findIndex(s => !s.dataset.filled);
      if (freeIdx !== -1) _pruebaDzSetFile(new File([blob], 'recorte.png', { type: 'image/png' }), freeIdx);
    }, 'image/png');
    ov.remove();
  });

  // ESC cancela
  const escH = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); ov.remove(); document.removeEventListener('keydown', escH, true); } };
  document.addEventListener('keydown', escH, true);
}

function _pruebaCropClose() {}
function _pruebaCropSave()  {}

function _pruebaZoomVideo(url) {
  let lbx = document.getElementById('prueba-lightbox');
  if (!lbx) {
    lbx = document.createElement('div');
    lbx.id = 'prueba-lightbox';
    lbx.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:99999;display:flex;align-items:center;justify-content:center;cursor:pointer;';
    lbx.onclick = e => { if (e.target === lbx) lbx.remove(); };
    document.body.appendChild(lbx);
  }
  lbx.innerHTML = `
    <div style="position:relative;max-width:95vw;max-height:95vh;">
      <video src="${url}" controls autoplay style="max-width:95vw;max-height:95vh;border-radius:6px;box-shadow:0 4px 32px rgba(0,0,0,.6);display:block;"></video>
      <button onclick="document.getElementById('prueba-lightbox').remove()"
        style="position:absolute;top:-14px;right:-14px;background:#333;border:none;color:#fff;border-radius:50%;width:28px;height:28px;cursor:pointer;font-size:16px;line-height:1;">×</button>
    </div>`;
  lbx.style.display = 'flex';
}

function _closePruebasViewer() {
  // Guardar imágenes manuales de vuelta en _verifResultado
  if (_pruebaMultaIdx >= 0 && _verifResultado?.multas?.[_pruebaMultaIdx]) {
    const manuals = Object.values(_pruebaManualUrls).filter(Boolean);
    if (manuals.length) {
      // Usar _pruebaCurrentUrls (ya refleja eliminaciones) como base
      _verifResultado.multas[_pruebaMultaIdx].prueba_urls = [..._pruebaCurrentUrls, ...manuals];
      // Actualizar badge
      const total = _verifResultado.multas[_pruebaMultaIdx].prueba_urls.length;
      const btn = document.getElementById(`prueba-btn-${_pruebaMultaIdx}`);
      if (btn) {
        const badge = btn.querySelector('.badge');
        if (badge) {
          badge.className = 'badge badge-info';
          badge.innerHTML = `<i class="fa-solid fa-camera"></i> ${total} Prueba${total!==1?'s':''}`;
        }
        // Actualizar onclick con las nuevas URLs
        const newData = encodeURIComponent(JSON.stringify(_verifResultado.multas[_pruebaMultaIdx].prueba_urls));
        const label   = encodeURIComponent(btn.onclick?.toString().match(/decodeURIComponent\('([^']+)'\),\d/)?.[1] || '');
        btn.setAttribute('onclick', `openPruebasViewer(decodeURIComponent('${newData}'),decodeURIComponent('${label}'),${_pruebaMultaIdx})`);
      }
    }
  }

  const ov = document.getElementById('modal-pruebas-viewer');
  if (ov) { ov.classList.remove('active'); ov.innerHTML = ''; }
  if (document._pruebaPasteHandler) {
    document.removeEventListener('paste', document._pruebaPasteHandler);
    delete document._pruebaPasteHandler;
  }
  if (document._pruebaEscHandler) {
    document.removeEventListener('keydown', document._pruebaEscHandler, true);
    delete document._pruebaEscHandler;
  }
  _pruebaMultaIdx = -1;
}

function _pruebaMakeDraggable(panel, handle) {
  let ox = 0, oy = 0, startX = 0, startY = 0;
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX; startY = e.clientY;
    const r = panel.getBoundingClientRect();
    ox = r.left; oy = r.top;
    panel.style.transform = 'none';
    panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
    function onMove(e) {
      panel.style.left = (ox + e.clientX - startX) + 'px';
      panel.style.top  = (oy + e.clientY - startY) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

function _pruebaZoom(url) {
  let lbx = document.getElementById('prueba-lightbox');
  if (!lbx) {
    lbx = document.createElement('div');
    lbx.id = 'prueba-lightbox';
    lbx.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:99999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
    lbx.onclick = () => lbx.remove();
    document.body.appendChild(lbx);
  }
  lbx.innerHTML = `<img src="${url}" style="max-width:95vw;max-height:95vh;object-fit:contain;border-radius:4px;box-shadow:0 4px 32px rgba(0,0,0,.6);">`;
  lbx.style.display = 'flex';
}

async function importarMultasVerificadas() {
  if (!_verifResultado?.multas?.length) return;
  const vehiculoId = document.getElementById('verif-vehiculo').value
                  || document.querySelector('#verif-vehiculo option:checked')?.value;

  const seleccionadas = [];
  document.querySelectorAll('.verif-multa-chk:checked').forEach(cb => {
    seleccionadas.push(_verifResultado.multas[parseInt(cb.value)]);
  });
  if (!seleccionadas.length) { showAlert('Seleccioná al menos una infracción'); return; }

  // Todas las prueba_urls (blob:, data:, http:) se descargan desde el browser
  // y se suben como archivos reales post-import. El browser tiene las cookies del portal.
  const dataUrlMap = {}; // numero_acta -> [url, ...]
  const multasParaEnviar = seleccionadas.map(m => {
    const allUrls = (m.prueba_urls || []).filter(Boolean);
    if (allUrls.length) dataUrlMap[m.numero_acta || '_noact_' + Math.random()] = allUrls;
    return { ...m, prueba_urls: [] }; // el backend no guarda URLs, todo se sube como archivo
  });

  const btnImp = document.getElementById('verif-btn-importar');
  btnImp.disabled = true;
  btnImp.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importando...';

  try {
    const res = await fetch(`/api/verificacion/${_verifJobId}/importar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ multas: multasParaEnviar, vehiculo_id: vehiculoId, municipalidad_id: _verifMuniId })
    });
    const data = await res.json();

    // Subir imágenes pegadas manualmente como adjuntos reales
    if (data.ids?.length && Object.keys(dataUrlMap).length) {
      for (const { numero_acta, id: multaId } of data.ids) {
        const dataUrls = dataUrlMap[numero_acta];
        if (!dataUrls?.length) continue;
        for (let i = 0; i < dataUrls.length; i++) {
          const url = dataUrls[i];
          let saved = false;
          // Intentar descargar desde el browser (tiene cookies del portal)
          if (!url.startsWith('blob:') && !url.startsWith('data:')) {
            // URL externa: probar fetch con credenciales (cookies)
            try {
              const resp = await fetch(url, { credentials: 'include', mode: 'cors' });
              if (resp.ok) {
                const blob = await resp.blob();
                const ext = blob.type.split('/')[1]?.split('+')[0] || 'jpg';
                const fd = new FormData();
                fd.append('adjuntos', blob, `prueba_${numero_acta}_${i+1}.${ext}`);
                await fetch(`/api/multas/${multaId}/adjuntos`, { method: 'POST', body: fd });
                saved = true;
              }
            } catch(_) {}
            // Fallback: si CORS bloqueó o falló, guardar como link para no perder la referencia
            if (!saved) {
              await fetch(`/api/multas/${multaId}/adjuntos/link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, nombre: `Prueba ${numero_acta} #${i+1}` })
              }).catch(() => {});
            }
          } else {
            // blob: o data: — subir directamente
            try {
              const blob = url.startsWith('data:') ? await fetch(url).then(r => r.blob()) : await fetch(url).then(r => r.blob());
              const ext = blob.type.split('/')[1]?.split('+')[0] || 'png';
              const fd = new FormData();
              fd.append('adjuntos', blob, `prueba_${numero_acta}_${i+1}.${ext}`);
              await fetch(`/api/multas/${multaId}/adjuntos`, { method: 'POST', body: fd });
            } catch(_) {}
          }
        }
      }
    }

    await _registrarVerifLog('con_multas', _verifResultado.multas.length, data.importadas);
    showToast(`✓ ${data.importadas} infracción(es) importada(s)`);
    _verifCerrarPanel();
    loadMultas();
  } catch(err) {
    showAlert('Error al importar: ' + err.message);
    btnImp.disabled = false;
    btnImp.innerHTML = '<i class="fa-solid fa-file-import"></i> Importar seleccionadas';
  }
}

async function cancelarVerificacion() {
  if (_verifJobId || _verifResultado?.multas?.length) {
    const ok = await showConfirm('¿Cerrar la verificación? Se perderán los resultados cargados.');
    if (!ok) return;
  }
  if (_verifSseSource) { _verifSseSource.close(); _verifSseSource = null; }
  if (_verifJobId) {
    fetch(`/api/verificacion/${_verifJobId}`, { method: 'DELETE' }).catch(() => {});
    _verifJobId = null;
  }
  _verifResultado = null;
  _verifCerrarPanel();
  closeModal('modal-verificacion');
}

// ============================================================
// FACTURA AI — tab en Service (clase DropZone estándar)
// ============================================================
let _dzSvcFactura = null;

function _initSvcFacturaDropzone() {
  _dzSvcFactura = new DropZone({
    mountId: 'svc-factura-mount',
    id: 'svc-factura-dz',
    label: 'Factura / Boleta / Remito',
    icon: 'fa-file-invoice',
    task: 'factura',
    onUpload: (url) => { document.getElementById('svc-factura-url').value = url; },
    onExtract: (data) => {
      if (data.numero_factura)   document.getElementById('svc-fact-numero').value = data.numero_factura;
      _svcSet('svc-fact-tipo', data.tipo_comprobante || '');
      if (data.fecha_emision)    document.getElementById('svc-fact-fecha').value = data.fecha_emision;
      _svcSet('svc-fact-tipo-auth', data.tipo_autorizacion || '');
      if (data.nro_autorizacion)  document.getElementById('svc-fact-cae').value = data.nro_autorizacion;
      if (data.vto_autorizacion)  document.getElementById('svc-fact-cae-vto').value = data.vto_autorizacion;
      if (data.cae)               document.getElementById('svc-fact-cae').value = data.cae;
      if (data.cae_vto)           document.getElementById('svc-fact-cae-vto').value = data.cae_vto;
      // Auto-match proveedor por CUIT o nombre
      if (data.proveedor_cuit || data.proveedor_nombre) {
        const sel = document.getElementById('svc-fact-proveedor-sel');
        if (sel) {
          const norm = s => (s||'').replace(/\D/g,'');
          const opt = [...sel.options].find(o =>
            (data.proveedor_cuit && norm(o.dataset.cuit) === norm(data.proveedor_cuit)) ||
            (data.proveedor_nombre && o.text.toLowerCase().includes(data.proveedor_nombre.toLowerCase().split(' ')[0]))
          );
          if (opt) _svcSet('svc-fact-proveedor-sel', opt.value);
        }
      }
      if (data.subtotal) setAmt('svc-fact-subtotal', data.subtotal);
      if (data.iva)      setAmt('svc-fact-iva', data.iva);
      if (data.total)    setAmt('svc-fact-total', data.total);
      if (data.descripcion_items) document.getElementById('svc-fact-items').value = data.descripcion_items;
      if (data.total && !getAmt('svc-costo')) setAmt('svc-costo', data.total);
    },
  });
}

// ── BANCOS CRUD ──────────────────────────────────────────────────────────────
let _bancosFilter = '';
let _cachedBancos = [];

async function openBancos() {
  openModal('modal-bancos');
  await _loadBancos(true);
  renderBancos();
}

async function _loadBancos(force = false) {
  if (!force && _cachedBancos.length) return;
  try { _cachedBancos = await (await fetch('/api/bancos')).json(); } catch {}
}

function filterBancos(btn, tipo) {
  document.querySelectorAll('.banco-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _bancosFilter = tipo;
  renderBancos();
}

function renderBancos() {
  const tbody = document.getElementById('bancos-tbody');
  if (!tbody) return;
  const q = (document.getElementById('bancos-search')?.value || '').toLowerCase().trim();
  let list = _bancosFilter ? _cachedBancos.filter(b => b.tipo === _bancosFilter) : _cachedBancos;
  if (q) list = list.filter(b =>
    (b.nombre      || '').toLowerCase().includes(q) ||
    (b.codigo_bcra || '').toLowerCase().includes(q) ||
    (b.cvu_prefix  || '').toLowerCase().includes(q) ||
    (b.tipo        || '').toLowerCase().includes(q)
  );
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-secondary);">Sin registros</td></tr>`;
    return;
  }
  const tipoLabel = { banco:'Banco', fintech:'Fintech', billetera:'Billetera' };
  tbody.innerHTML = list.map(b => `
    <tr>
      <td style="font-size:18px;text-align:center;">${b.logo_emoji || '🏦'}</td>
      <td><strong>${b.nombre}</strong></td>
      <td><span class="badge badge-info" style="font-size:10px;">${tipoLabel[b.tipo]||b.tipo}</span></td>
      <td style="font-family:monospace;font-size:12px;">${b.codigo_bcra ? `<code>${b.codigo_bcra}</code>` : '<span style="color:var(--text-secondary)">—</span>'}</td>
      <td style="font-family:monospace;font-size:12px;">${b.cvu_prefix  ? `<code>${b.cvu_prefix}</code>`  : '<span style="color:var(--text-secondary)">—</span>'}</td>
      <td style="text-align:center;white-space:nowrap;">
        <button class="tbl-action-btn tbl-btn-edit"   onclick="editBanco(${b.id})"                              title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
        <button class="tbl-action-btn tbl-btn-delete" onclick="deleteBanco(${b.id},${JSON.stringify(b.nombre)})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`).join('');
}

function editBanco(id) {
  const b = _cachedBancos.find(x => x.id === id);
  if (!b) return;
  document.getElementById('banco-id').value     = b.id;
  document.getElementById('banco-nombre').value = b.nombre || '';
  document.getElementById('banco-tipo').value   = b.tipo   || 'banco';
  document.getElementById('banco-codigo').value = b.codigo_bcra || '';
  document.getElementById('banco-cvu').value    = b.cvu_prefix  || '';
  document.getElementById('banco-emoji').value  = b.logo_emoji  || '';
  document.getElementById('btn-banco-submit').textContent = 'Guardar Cambios';
  document.getElementById('banco-nombre').focus();
}

function resetBancoForm() {
  document.getElementById('banco-id').value = '';
  document.getElementById('form-banco').reset();
  document.getElementById('btn-banco-submit').textContent = 'Agregar';
}

async function saveBanco(e) {
  e.preventDefault();
  const id = document.getElementById('banco-id').value;
  const body = {
    nombre:      document.getElementById('banco-nombre').value.trim(),
    tipo:        document.getElementById('banco-tipo').value,
    codigo_bcra: document.getElementById('banco-codigo').value.trim() || null,
    cvu_prefix:  document.getElementById('banco-cvu').value.trim()    || null,
    logo_emoji:  document.getElementById('banco-emoji').value.trim()  || null,
  };
  try {
    const res = await fetch(id ? `/api/bancos/${id}` : '/api/bancos', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.message || 'Error al guardar'); return; }
    showToast(id ? 'Banco actualizado' : 'Banco agregado', 'success');
    resetBancoForm();
    await _loadBancos(true);
    renderBancos();
  } catch { showToast('Error de conexión'); }
}

async function deleteBanco(id, nombre) {
  if (!confirm(`¿Eliminar "${nombre}"?`)) return;
  try {
    const res = await fetch(`/api/bancos/${id}`, { method: 'DELETE' });
    if (!res.ok) { showToast((await res.json()).message || 'Error'); return; }
    showToast('Eliminado');
    await _loadBancos(true);
    renderBancos();
  } catch { showToast('Error de conexión'); }
}

function _bancosListaActual() {
  const q = (document.getElementById('bancos-search')?.value || '').toLowerCase().trim();
  let list = _bancosFilter ? _cachedBancos.filter(b => b.tipo === _bancosFilter) : [..._cachedBancos];
  if (q) list = list.filter(b =>
    (b.nombre||'').toLowerCase().includes(q) ||
    (b.codigo_bcra||'').toLowerCase().includes(q) ||
    (b.cvu_prefix||'').toLowerCase().includes(q)
  );
  return list;
}

function exportBancosXLS() {
  const list = _bancosListaActual();
  if (!list.length) { showToast('Sin datos para exportar'); return; }
  const tipoLabel = { banco:'Banco', fintech:'Fintech', billetera:'Billetera' };
  const rows = [['Nombre','Tipo','Cód. BCRA','Prefijo CVU','Emoji']];
  list.forEach(b => rows.push([
    b.nombre, tipoLabel[b.tipo]||b.tipo, b.codigo_bcra||'', b.cvu_prefix||'', b.logo_emoji||''
  ]));
  const ws = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + ws], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bancos_fintechs.csv';
  a.click();
}

async function sendBancosWA() {
  const list = _bancosListaActual();
  if (!list.length) { showToast('Sin datos'); return; }
  const tipoLabel = { banco:'Banco', fintech:'Fintech', billetera:'Billetera' };
  const lines = ['*Bancos y Fintechs registrados*', ''];
  const grupos = { banco: [], fintech: [], billetera: [] };
  list.forEach(b => (grupos[b.tipo] || grupos.banco).push(b));
  for (const [tipo, items] of Object.entries(grupos)) {
    if (!items.length) continue;
    lines.push(`*${tipoLabel[tipo]}s:*`);
    items.forEach(b => {
      const codigo = b.codigo_bcra ? ` · CBU: ${b.codigo_bcra}` : b.cvu_prefix ? ` · CVU: ${b.cvu_prefix}` : '';
      lines.push(`${b.logo_emoji||'🏦'} ${b.nombre}${codigo}`);
    });
    lines.push('');
  }
  const phone = prompt('Número de WhatsApp (ej: 5491112345678):');
  if (!phone) return;
  try {
    const res = await fetch('/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message: lines.join('\n') })
    });
    const d = await res.json();
    showToast(res.ok ? '✓ Enviado por WhatsApp' : (d.message || 'Error al enviar'));
  } catch { showToast('Error de conexión'); }
}

// ── CUENTAS CRUD ─────────────────────────────────────────────────────────────
let _cachedCuentas = [];

let _cachedPersonasParaCuenta = [];

async function _loadPersonasParaCuenta() {
  _cachedPersonasParaCuenta = await fetch('/api/personas').then(r => r.json()).catch(() => []);
  const sel = document.getElementById('cuenta-persona-id');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Sin propietario vinculado —</option>';
  _cachedPersonasParaCuenta.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.apellido}, ${p.nombre}${p.dni ? ' · DNI ' + p.dni : ''}`;
    sel.appendChild(opt);
  });
  if (cur && sel._ssSet) sel._ssSet(cur);
  else if (cur) sel.value = cur;
}

function _toggleCuentaCamposManuales(pid) {
  const wrap = document.getElementById('cuenta-campos-manuales');
  if (!wrap) return;
  wrap.style.display = pid ? 'none' : 'contents';
}

function _onCuentaPersonaChange(pid) {
  _toggleCuentaCamposManuales(pid);
  if (!pid) return;
  const p = _cachedPersonasParaCuenta.find(x => x.id == pid);
  if (!p) return;
  // Guardar en campos ocultos para que el backend los tenga si los necesita
  const nombre   = document.getElementById('cuenta-nombre');
  const apellido = document.getElementById('cuenta-apellido');
  const dni      = document.getElementById('cuenta-dni');
  const cuil     = document.getElementById('cuenta-cuil');
  if (nombre)   nombre.value   = p.nombre   || '';
  if (apellido) apellido.value = p.apellido || '';
  if (dni)      dni.value      = p.dni      || '';
  if (cuil)     cuil.value     = p.cuil     || '';
}

function _autoLinkCuentaPersonaByDNI(dniVal) {
  if (!dniVal) return;
  const p = _cachedPersonasParaCuenta.find(x => x.dni && x.dni.replace(/\D/g,'') === dniVal.replace(/\D/g,''));
  if (!p) return;
  const sel = document.getElementById('cuenta-persona-id');
  if (!sel) return;
  if (sel._ssSet) sel._ssSet(p.id);
  else sel.value = p.id;
}

let _cuentasPersonaFija = null; // persona_id fijo cuando se abre desde Propietarios

async function openCuentas(personaId = null) {
  _cuentasPersonaFija = personaId || null;
  openModal('modal-cuentas');
  await _loadBancos();
  _poblarBancosEnCuentaSelect();
  await _loadPersonasParaCuenta();
  await loadCuentas();

  // Si viene con persona fija: pre-setear y bloquear el combo
  const persSel = document.getElementById('cuenta-persona-id');
  const persWrap = persSel?.closest('.form-group');
  if (_cuentasPersonaFija && persSel) {
    if (persSel._ssSet) persSel._ssSet(_cuentasPersonaFija);
    else persSel.value = _cuentasPersonaFija;
    // Bloquear visualmente (deshabilitar SmartCombo input)
    const ssInput = persSel.parentElement?.querySelector('.ss-input');
    if (ssInput) { ssInput.disabled = true; ssInput.style.opacity = '.55'; ssInput.style.cursor = 'not-allowed'; }
    if (persWrap) {
      let badge = persWrap.querySelector('._persona-fija-badge');
      if (!badge) {
        badge = document.createElement('small');
        badge.className = '_persona-fija-badge';
        badge.style.cssText = 'color:var(--accent-color);font-size:11px;margin-top:3px;display:block;';
        badge.innerHTML = '<i class="fa-solid fa-lock"></i> Propietario fijo desde el módulo Personas';
        persWrap.appendChild(badge);
      }
    }
  } else if (persSel) {
    const ssInput = persSel.parentElement?.querySelector('.ss-input');
    if (ssInput) { ssInput.disabled = false; ssInput.style.opacity = ''; ssInput.style.cursor = ''; }
    persWrap?.querySelector('._persona-fija-badge')?.remove();
  }

  // Filtrar tabla si hay persona fija
  renderCuentas();
}

function _poblarBancosEnCuentaSelect() {
  const sel = document.getElementById('cuenta-banco-id');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Sin especificar --</option>';
  _cachedBancos.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = `${b.logo_emoji || ''} ${b.nombre}`;
    sel.appendChild(opt);
  });
}

async function loadCuentas() {
  try {
    const res = await fetch('/api/cuentas');
    _cachedCuentas = await res.json();
    renderCuentas();
    // También refrescar el select de cuentas en el form de pagos
    loadCuentasSelect();
  } catch (e) { showToast('Error cargando cuentas'); }
}

function renderCuentas() {
  const tbody = document.getElementById('cuentas-tbody');
  if (!tbody) return;
  const q = (document.getElementById('cuentas-search')?.value || '').toLowerCase().trim();
  let list = _cachedCuentas;
  // Si hay persona fija, mostrar solo sus cuentas
  if (_cuentasPersonaFija) list = list.filter(c => c.persona_id == _cuentasPersonaFija);
  if (q) list = list.filter(c =>
    (c.alias      || '').toLowerCase().includes(q) ||
    (c.nombre     || '').toLowerCase().includes(q) ||
    (c.apellido   || '').toLowerCase().includes(q) ||
    (c.dni        || '').toLowerCase().includes(q) ||
    (c.cuil       || '').toLowerCase().includes(q) ||
    (c.cbu_cvu    || '').toLowerCase().includes(q) ||
    (c.banco_nombre|| '').toLowerCase().includes(q)
  );
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-secondary);">Sin cuentas registradas</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(c => {
    const bancoLabel = c.banco_nombre
      ? `<span style="font-size:11px;">${c.banco_emoji||''} ${c.banco_nombre}</span>`
      : '<span style="color:var(--text-secondary)">—</span>';
    // Titular: preferir persona vinculada, fallback a datos manuales
    const titApellido = c.persona_apellido || c.apellido || '';
    const titNombre   = c.persona_nombre   || c.nombre   || '';
    const titDni      = c.persona_dni      || c.dni      || '';
    const titCuil     = c.cuil || '';
    const titLabel    = [titApellido, titNombre].filter(Boolean).join(', ') || '<span style="opacity:.4">—</span>';
    const titBadge    = c.persona_id
      ? `<span class="badge badge-info" style="font-size:10px;margin-left:4px;" title="Vinculado a Propietarios"><i class="fa-solid fa-link"></i></span>`
      : '';
    return `
    <tr>
      <td>${c.id}</td>
      <td><strong>${c.alias || ''}</strong></td>
      <td>${titLabel}${titBadge}<br><small style="color:var(--text-secondary);font-size:10px;">${titDni ? 'DNI '+titDni : ''}${titCuil ? ' · '+titCuil : ''}</small></td>
      <td style="font-family:monospace;font-size:11px;">${c.cbu_cvu || '<span style="color:var(--text-secondary)">—</span>'}</td>
      <td>${bancoLabel}</td>
      <td style="text-align:center;white-space:nowrap;">
        <button class="tbl-action-btn tbl-btn-edit"   onclick="editCuenta(${c.id})"                                    title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
        <button class="tbl-action-btn tbl-btn-delete" onclick="deleteCuenta(${c.id},${JSON.stringify(c.alias||'')})"   title="Eliminar"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
}

function editCuenta(id) {
  const c = _cachedCuentas.find(x => x.id === id);
  if (!c) return;
  document.getElementById('cuenta-id').value        = c.id;
  document.getElementById('cuenta-alias').value     = c.alias || '';
  document.getElementById('cuenta-nombre').value    = c.nombre || '';
  document.getElementById('cuenta-apellido').value  = c.apellido || '';
  document.getElementById('cuenta-dni').value       = c.dni || '';
  document.getElementById('cuenta-cuil').value      = c.cuil || '';
  document.getElementById('cuenta-cbu').value       = c.cbu_cvu || '';
  const bancoSel = document.getElementById('cuenta-banco-id');
  if (bancoSel) {
    let bancoId = c.banco_id || '';
    if (!bancoId && c.cbu_cvu) {
      const b = _identifyBancoObj(c.cbu_cvu);
      if (b) bancoId = b.id;
    }
    if (bancoSel._ssSet) bancoSel._ssSet(bancoId);
    else bancoSel.value = bancoId;
  }
  // Propietario vinculado
  const persSel = document.getElementById('cuenta-persona-id');
  if (persSel) {
    const pid = c.persona_id || '';
    if (persSel._ssSet) persSel._ssSet(pid);
    else persSel.value = pid;
    if (!pid && c.dni) _autoLinkCuentaPersonaByDNI(c.dni);
    _toggleCuentaCamposManuales(pid);
  }
  document.getElementById('btn-cuenta-submit').textContent = 'Guardar Cambios';
  document.getElementById('cuenta-alias').focus();
}

function resetCuentaForm() {
  document.getElementById('cuenta-id').value = '';
  document.getElementById('form-cuenta').reset();
  document.getElementById('btn-cuenta-submit').textContent = 'Agregar Cuenta';
  const bancoSel = document.getElementById('cuenta-banco-id');
  if (bancoSel?._ssClear) bancoSel._ssClear();
  const persSel = document.getElementById('cuenta-persona-id');
  const pid = _cuentasPersonaFija || '';
  if (persSel?._ssSet) persSel._ssSet(pid);
  else if (persSel) persSel.value = pid;
  _toggleCuentaCamposManuales(pid);
}

async function saveCuenta(e) {
  e.preventDefault();
  const id = document.getElementById('cuenta-id').value;
  const body = {
    alias:      document.getElementById('cuenta-alias').value.trim(),
    nombre:     document.getElementById('cuenta-nombre').value.trim() || null,
    apellido:   document.getElementById('cuenta-apellido').value.trim() || null,
    dni:        document.getElementById('cuenta-dni').value.trim() || null,
    cuil:       document.getElementById('cuenta-cuil').value.trim() || null,
    cbu_cvu:    document.getElementById('cuenta-cbu').value.trim() || null,
    banco_id:   parseInt(document.getElementById('cuenta-banco-id').value) || null,
    persona_id: parseInt(document.getElementById('cuenta-persona-id').value) || null,
  };
  try {
    const url    = id ? `/api/cuentas/${id}` : '/api/cuentas';
    const method = id ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { showToast(data.message || 'Error al guardar'); return; }
    showToast(id ? 'Cuenta actualizada' : 'Cuenta creada', 'success');
    resetCuentaForm();
    await loadCuentas();
  } catch (e) { showToast('Error de conexión'); }
}

async function deleteCuenta(id, alias) {
  if (!confirm(`¿Eliminar la cuenta "${alias}"?`)) return;
  try {
    const res = await fetch(`/api/cuentas/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { showToast(data.message || 'Error al eliminar'); return; }
    showToast('Cuenta eliminada');
    await loadCuentas();
  } catch (e) { showToast('Error de conexión'); }
}

function _cuentasListaActual() {
  const q = (document.getElementById('cuentas-search')?.value || '').toLowerCase().trim();
  if (!q) return [..._cachedCuentas];
  return _cachedCuentas.filter(c =>
    (c.alias      || '').toLowerCase().includes(q) ||
    (c.nombre     || '').toLowerCase().includes(q) ||
    (c.apellido   || '').toLowerCase().includes(q) ||
    (c.dni        || '').toLowerCase().includes(q) ||
    (c.cuil       || '').toLowerCase().includes(q) ||
    (c.cbu_cvu    || '').toLowerCase().includes(q) ||
    (c.banco_nombre|| '').toLowerCase().includes(q)
  );
}

function exportCuentasXLS() {
  const list = _cuentasListaActual();
  if (!list.length) { showToast('Sin datos para exportar'); return; }
  const rows = [['ID','Alias','Nombre','Apellido','DNI','CUIL','CBU/CVU','Banco/Fintech']];
  list.forEach(c => rows.push([
    c.id, c.alias||'', c.nombre||'', c.apellido||'',
    c.dni||'', c.cuil||'', c.cbu_cvu||'',
    c.banco_nombre ? `${c.banco_emoji||''} ${c.banco_nombre}` : ''
  ]));
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cuentas.csv';
  a.click();
}

async function sendCuentasWA() {
  const list = _cuentasListaActual();
  if (!list.length) { showToast('Sin datos'); return; }
  const lines = ['*Cuentas registradas*', ''];
  list.forEach(c => {
    const titular = [c.nombre, c.apellido].filter(Boolean).join(' ');
    const banco   = c.banco_nombre ? ` · ${c.banco_emoji||''}${c.banco_nombre}` : '';
    const cbu     = c.cbu_cvu ? `\nCBU/CVU: ${c.cbu_cvu}` : '';
    const cuil    = c.cuil ? ` · CUIL: ${c.cuil}` : '';
    lines.push(`*${c.alias}*${banco}`);
    if (titular) lines.push(`${titular}${cuil}`);
    if (cbu)     lines.push(cbu);
    lines.push('');
  });
  const phone = prompt('Número de WhatsApp (ej: 5491112345678):');
  if (!phone) return;
  try {
    const res = await fetch('/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message: lines.join('\n') })
    });
    const d = await res.json();
    showToast(res.ok ? '✓ Enviado por WhatsApp' : (d.message || 'Error al enviar'));
  } catch { showToast('Error de conexión'); }
}

async function loadPrestamos() {
  try {
    const res = await fetch('/api/prestamos');
    const prestamos = await res.json();
    const tbody = document.getElementById('prestamos-table-body');
    tbody.innerHTML = '';

    prestamos.forEach(p => {
      const estadoClass = p.estado === 'pagado' ? 'badge-success' : (p.estado === 'activo' ? 'badge-info' : 'badge-warning');
      const tipoBanco = p.banco_nombre ? `${p.tipo_prestamo} (${p.banco_nombre})` : p.tipo_prestamo;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <strong>${p.nombre_prestatario}</strong><br>
          <small class="text-secondary">${p.observaciones || ''}</small>
        </td>
        <td><span class="badge badge-info">${tipoBanco}</span></td>
        <td>${formatDate(p.fecha_prestamo)}</td>
        <td style="font-weight: 600;">${formatCurrency(p.monto)}</td>
        <td><span class="badge ${estadoClass}">${p.estado}</span></td>
      `;
      tbody.appendChild(tr);
    });
    bindHeaderEvents();
  } catch (error) {
    console.error('Error al cargar préstamos:', error);
  }
}

function openPagoModal(id = null, readOnly = false) {
  _pagoEditId = readOnly ? null : (id || null); // en modo ver no edita
  // Rehabilitar form (puede venir en modo solo-lectura de una vista anterior)
  const form = document.getElementById('form-pago');
  if (form) {
    form.style.pointerEvents = '';
    form.style.userSelect = '';
    form.querySelectorAll('input,textarea').forEach(el => el.readOnly = false);
  }
  const submitBtn = document.getElementById('btn-pago-submit');
  if (submitBtn) submitBtn.style.display = '';

  if (!id) {
    document.getElementById('form-pago')?.reset();
    clearPagoComprobante();
    const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset()*60000).toISOString().substring(0,16);
    document.getElementById('pg-fecha').value = nowLocal;
    document.getElementById('modal-pago-title').textContent = 'Cargar Pago o Reintegro';
    // Limpiar monto y su campo oculto (form.reset() no borra dataset.raw)
    const montoEl = document.getElementById('pg-monto');
    if (montoEl) { montoEl.value = ''; montoEl.dataset.raw = ''; }
    const montoRaw = document.getElementById('pg-monto-raw');
    if (montoRaw) montoRaw.value = '';
    const difHint = document.getElementById('pg-monto-dif-hint');
    if (difHint) difHint.style.display = 'none';
    // Limpiar conceptos de imputación
    ['pg-rend-alquiler','pg-rend-peajes','pg-rend-deuda','pg-rend-productos','pg-rend-otro'].forEach(eid => {
      const el = document.getElementById(eid);
      if (el) { el.value = ''; el.dataset.raw = ''; }
    });
    const difConc = document.getElementById('pg-rend-diferencia');
    if (difConc) { difConc.textContent = '$ 0'; difConc.style.color = 'var(--color-success)'; }
    onPagoTipoChange();
  }
  openModal('modal-pago');
  if (id) _loadPagoEnModal(id, readOnly);
}

async function _loadPagoEnModal(id, readOnly = false) {
  try {
    // Cargar selects primero (necesarios para asignar valores)
    await Promise.all([loadChoferesSelect(), loadCuentasSelect()]);

    const res = await fetch(`/api/pagos/${id}`);
    if (!res.ok) return;
    const p = await res.json();

    const setVal = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val ?? ''; };
    // Asigna valor a un <select> usando selectedIndex — más robusto que el.value=x cuando hay mismatch número/string
    const setSelect = (elId, val) => {
      const el = document.getElementById(elId);
      if (!el) return;
      const strVal = String(val ?? '');
      // SmartCombo: usar _ssSet para sincronizar el input visible
      if (el._ssSet) { el._ssSet(strVal); return; }
      // Select nativo: match exacto por value, luego normalizado
      const norm = v => String(v).toLowerCase().replace(/\s+/g, '');
      for (let i = 0; i < el.options.length; i++) {
        if (el.options[i].value === strVal) { el.selectedIndex = i; return; }
      }
      for (let i = 0; i < el.options.length; i++) {
        if (norm(el.options[i].value) === norm(strVal)) { el.selectedIndex = i; return; }
      }
      el.selectedIndex = 0;
    };

    // Transferencias siempre son ingreso
    const tipoVal = (p.medio_pago === 'Transferencia' || p.medio_pago === 'MercadoPago') ? 'ingreso' : (p.tipo || 'ingreso');
    setSelect('pg-tipo', tipoVal);
    onPagoTipoChange();
    setSelect('pg-chofer', p.chofer_id);
    const monto = parseFloat(p.monto || 0);
    setVal('pg-monto-raw', monto);
    const montoVis = document.getElementById('pg-monto');
    if (montoVis) montoVis.value = monto.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const fecha = p.fecha ? new Date(p.fecha).toISOString().substring(0,16) : '';
    setVal('pg-fecha',   fecha);
    setSelect('pg-medio',  p.medio_pago);
    onPagoMedioChange();
    setSelect('pg-cuenta', p.cuenta_id  || '');
    setVal('pg-nro-trf', p.nro_transaccion || '');
    setVal('pg-detalle', p.detalle || '');

    // Comprobante preview
    if (p.comprobante_url) {
      const prev = document.getElementById('pg-comprobante-prev');
      const eye  = document.getElementById('pg-comprobante-eye');
      if (prev) { prev.src = p.comprobante_url; prev.style.display = ''; }
      if (eye)  eye.style.display = '';
      // Sincronizar visor flotante con el comprobante de este cobro
      const fv = document.getElementById('float-img-viewer');
      if (fv && fv.style.display !== 'none') {
        openImgViewer(p.comprobante_url, `Comprobante Cobro #${id}`);
      }
    }
    calcPagoConceptos();

    // Limpiar campos de concepto (evita valores stale de sesión anterior)
    ['pg-rend-alquiler','pg-rend-peajes','pg-rend-deuda','pg-rend-productos','pg-rend-otro'].forEach(eid => {
      const el = document.getElementById(eid);
      if (el) { el.value = ''; el.dataset.raw = ''; }
    });

    // Auto-imputar alquiler: si es transferencia y monto == modalidad del chofer
    if ((p.medio_pago === 'Transferencia' || p.medio_pago === 'MercadoPago') && p.chofer_modalidad) {
      const modalidadNum = parseFloat(String(p.chofer_modalidad).replace(/[^0-9.]/g,'')) || 0;
      if (modalidadNum > 0 && Math.abs(monto - modalidadNum) < 0.01) {
        const alqEl = document.getElementById('pg-rend-alquiler');
        // Solo auto-imputar si el campo está vacío (no pisar imputación manual previa)
        if (alqEl && !alqEl.dataset.raw) {
          alqEl.dataset.raw = String(monto);
          alqEl.value = monto.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
        }
      }
    }

    // Cargar conceptos imputados
    try {
      const cRes = await fetch(`/api/pagos/${id}/conceptos`);
      if (cRes.ok) {
        const conceptos = await cRes.json();
        const nameMap = { alquiler:'pg-rend-alquiler', peajes:'pg-rend-peajes', multas:'pg-rend-deuda', cobranza_productos:'pg-rend-productos', otro:'pg-rend-otro' };
        conceptos.forEach(c => {
          const el = document.getElementById(nameMap[c.concepto]);
          if (el) {
            const raw = parseFloat(c.monto) || 0;
            el.dataset.raw = String(raw);
            el.value = raw.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
          }
        });
        calcPagoConceptos();
        // Si la DB no tenía conceptos pero el auto-imputar los completó, persitirlos silenciosamente
        if (conceptos.length === 0) {
          const cIds   = ['pg-rend-alquiler','pg-rend-peajes','pg-rend-deuda','pg-rend-productos','pg-rend-otro'];
          const cNames = ['alquiler','peajes','multas','cobranza_productos','otro'];
          const toSave = cIds.map((eid,i) => ({ concepto: cNames[i], monto: getAmt(eid) })).filter(c => c.monto > 0);
          if (toSave.length > 0) {
            fetch(`/api/pagos/${id}/conceptos`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(toSave) }).catch(()=>{});
          }
        }
      }
    } catch(_) {}

    // Modo solo lectura
    if (readOnly) {
      const form = document.getElementById('form-pago');
      if (form) {
        form.style.pointerEvents = 'none';
        form.style.userSelect = 'none';
        form.querySelectorAll('input,textarea').forEach(el => el.readOnly = true);
        // Restaurar clicks en botones de visualización del DZ (eye, no el del form)
        form.querySelectorAll('.dz-overlay-eye, .dz-overlay-del, .dz-btn, .modal-footer button').forEach(el => {
          el.style.pointerEvents = 'auto';
        });
      }
      document.getElementById('modal-pago-title').textContent = `Ver Cobro #${id}`;
      const submitBtn = document.getElementById('btn-pago-submit');
      if (submitBtn) submitBtn.style.display = 'none';
    } else {
      const form = document.getElementById('form-pago');
      if (form) { form.style.pointerEvents = ''; form.style.userSelect = ''; }
      form?.querySelectorAll('input,textarea').forEach(el => el.readOnly = false);
      document.getElementById('modal-pago-title').textContent = `Editar Cobro #${id}`;
      const submitBtn = document.getElementById('btn-pago-submit');
      if (submitBtn) submitBtn.style.display = '';
    }
  } catch(e) { showToast('Error al cargar cobro: ' + e.message, 'error'); }
}

async function loadPagos() {
  try {
    const res = await fetch('/api/pagos');
    const pagos = await res.json();
    const tbody = document.getElementById('pagos-table-body');
    tbody.innerHTML = '';

    pagos.forEach(p => {
      let montoColor = 'var(--text-primary)';
      if (p.tipo === 'ingreso') montoColor = 'var(--accent-green)';
      else if (p.tipo === 'reintegro' || p.tipo === 'egreso') montoColor = 'var(--accent-red)';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${p.chofer_nombre || 'General (Sistema)'}</strong></td>
        <td>${formatDate(p.fecha)}</td>
        <td>
          <span class="badge badge-info">${p.concepto}</span><br>
          <small class="text-secondary" style="font-size:11px;">${p.detalle || ''}</small>
        </td>
        <td style="color: ${montoColor}; font-weight: 600;">${p.tipo === 'ingreso' ? '+' : '-'}${formatCurrency(p.monto)}</td>
        <td>${p.medio_pago || '-'}<br><small class="text-secondary">${p.cuenta_alias || ''}${p.nro_transaccion ? ` · Op. ${p.nro_transaccion}` : ''}</small></td>
      `;
      tbody.appendChild(tr);
    });
    bindHeaderEvents();
    injectExportBar('table-finanzas', 'Finanzas');
  } catch (error) {
    console.error('Error al cargar pagos:', error);
  }
}


// --- SELECTS Y AUXILIARES DE FORMULARIOS ---

async function loadFiscalConditions() {
  try {
    const res = await fetch('/api/condiciones-fiscales');
    const condiciones = await res.json();
    const select = document.getElementById('ch-fiscal');
    select.innerHTML = '<option value="">-- Seleccionar --</option>';

    condiciones.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.innerText = c.nombre;
      select.appendChild(opt);
    });
  } catch (error) {
    console.error('Error al cargar condiciones fiscales:', error);
  }
}

function _buildChoferesSelectDOM(choferes) {
  const select = document.getElementById('pg-chofer');
  if (!select) return;
  select.innerHTML = '<option value="">-- Seleccionar Chofer --</option>';
  choferes.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    const dni = c.dni ? ` · DNI ${c.dni}` : '';
    const inactivo = !c.activo ? ' (inactivo)' : '';
    opt.innerText = `${c.nombre}${c.apellido ? ' ' + c.apellido : ''}${dni}${inactivo}`;
    if (!c.activo) opt.style.color = 'var(--text-secondary)';
    select.appendChild(opt);
  });
}

async function loadChoferesSelect() {
  if (cachedChoferes.length) { _buildChoferesSelectDOM(cachedChoferes); return; }
  if (!_choferesSelectLoadPromise) {
    _choferesSelectLoadPromise = fetch('/api/choferes')
      .then(r => r.json())
      .then(data => { cachedChoferes = data; _buildChoferesSelectDOM(data); })
      .catch(e => console.error('Error al cargar selector de choferes:', e))
      .finally(() => { _choferesSelectLoadPromise = null; });
  }
  return _choferesSelectLoadPromise;
}

async function loadCuentasSelect() {
  try {
    // Usa cache si ya está cargado, sino fetch
    const cuentas = _cachedCuentas.length ? _cachedCuentas : await fetch('/api/cuentas').then(r => r.json());
    if (!_cachedCuentas.length) _cachedCuentas = cuentas;
    const select = document.getElementById('pg-cuenta');
    if (!select) return;
    select.innerHTML = '<option value="">-- Sin cuenta (Efectivo) --</option>';
    cuentas.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      const banco = c.banco_nombre ? ` · ${c.banco_emoji || ''}${c.banco_nombre}` : '';
      const titular = [c.nombre, c.apellido].filter(Boolean).join(' ');
      const cbu = c.cbu_cvu ? ` · ${c.cbu_cvu}` : '';
      opt.innerText = `${c.alias}${titular ? ' — ' + titular : ''}${banco}${cbu}`;
      select.appendChild(opt);
    });
  } catch (error) {
    console.error('Error al cargar selector de cuentas:', error);
  }
}

// Infiere y setea el Medio de Pago a partir de los datos del comprobante.
// Usado tanto por OCR como por IA. No pisa si el usuario ya eligió algo.
// Retorna true si efectivamente seteó un valor.
function _inferMedioPago(data) {
  const sel = document.getElementById('pg-medio');
  if (!sel || sel.value) return false;

  let medio = data.medio_pago || null;

  if (!medio) {
    const banco = [data.banco_origen, data.banco_destino].filter(Boolean).join(' ').toLowerCase();
    if      (banco.includes('mercado') || /\bmp\b/.test(banco)) medio = 'MercadoPago';
    else if (banco.includes('ual'))                             medio = 'Uala';
    else if (banco.includes('cocos'))                           medio = 'Cocos';
    else if (banco)                                             medio = 'Transferencia'; // cualquier banco/fintech
    // Fallback: Nro. Operación de 10+ dígitos = transferencia bancaria
    else if (/^\d{10,}$/.test(String(data.nro_transaccion || ''))) medio = 'Transferencia';
  }

  if (!medio) return false;
  sel.value = medio;
  onPagoMedioChange();
  return true;
}

// Aviso temprano de duplicado al completar el Nro. de Operación
async function checkDupNro() {
  const hint = document.getElementById('pg-nro-dup-hint');
  if (!hint) return;
  const nro = document.getElementById('pg-nro-trf')?.value?.trim();
  _inferMedioPago({ nro_transaccion: nro });
  if (!nro) { hint.style.display = 'none'; return; }
  const choferId = document.getElementById('pg-chofer')?.value || '';
  try {
    const res = await fetch(`/api/pagos/check-dup?nro_transaccion=${encodeURIComponent(nro)}${choferId ? '&chofer_id=' + choferId : ''}`);
    if (!res.ok) return;
    const { existe, fecha: fExiste, id: dupId } = await res.json();
    if (existe) {
      hint.innerHTML = `⚠ Ya existe un cobro con este Nro. de Operación${fExiste ? ' del <b>' + formatDate(fExiste) + '</b>' : ''}.
`;
      hint.style.display = 'block';
    } else {
      hint.style.display = 'none';
    }
  } catch (_) { hint.style.display = 'none'; }
}

function onPagoTipoChange() {
  const tipo = document.getElementById('pg-tipo').value;
  const conceptosSection = document.getElementById('pg-conceptos-section');
  const title = document.getElementById('modal-pago-title');
  const submitBtn = document.getElementById('btn-pago-submit');
  const conceptoHidden = document.getElementById('pg-concepto');

  if (tipo === 'ingreso') {
    if (title) title.textContent = 'Cargar Cobro';
    if (submitBtn) submitBtn.textContent = 'Guardar Cobro';
    if (conceptosSection) conceptosSection.style.display = 'block';
    if (conceptoHidden) conceptoHidden.value = 'ingreso';
  } else if (tipo === 'reintegro') {
    if (title) title.textContent = 'Cargar Reintegro';
    if (submitBtn) submitBtn.textContent = 'Guardar Reintegro';
    if (conceptosSection) conceptosSection.style.display = 'none';
    if (conceptoHidden) conceptoHidden.value = 'reintegro';
  } else {
    if (title) title.textContent = 'Cargar Cobro / Reintegro';
    if (submitBtn) submitBtn.textContent = 'Guardar';
    if (conceptosSection) conceptosSection.style.display = 'none';
    if (conceptoHidden) conceptoHidden.value = 'egreso';
  }
  calcPagoConceptos();
}

function calcPagoConceptos() {
  const campos = ['pg-rend-alquiler','pg-rend-peajes','pg-rend-deuda','pg-rend-productos','pg-rend-otro'];
  const suma = campos.reduce((acc, id) => acc + getAmt(id), 0);
  const montoEl = document.getElementById('pg-monto');
  const rawEl   = document.getElementById('pg-monto-raw');
  const total = parseFloat(montoEl?.dataset?.raw)
             || parseFloat(rawEl?.value)
             || parseFloat((montoEl?.value||'').replace(/\./g,'').replace(/,/g,'.'))
             || 0;
  const dif = total - suma;
  const absDif = Math.abs(dif);
  const tipo = document.getElementById('pg-tipo')?.value;

  // Hint debajo del monto (siempre visible cuando tipo=ingreso)
  const hint = document.getElementById('pg-monto-dif-hint');
  if (hint) {
    if (tipo === 'ingreso' && total > 0) {
      const txt = absDif < 0.01 ? '✓ Imputación completa'
                : `Diferencia: $ ${absDif.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} ${dif < -0.005 ? 'de más' : 'pendiente'}`;
      hint.textContent = txt;
      hint.style.color = absDif < 0.01 ? 'var(--color-success)' : 'var(--color-error)';
      hint.style.display = 'block';
    } else {
      hint.style.display = 'none';
    }
  }

  // Diferencia dentro de la sección imputación
  const el = document.getElementById('pg-rend-diferencia');
  if (!el) return;
  if (suma === 0 && total === 0) {
    el.textContent = '$ 0.00';
    el.style.color = 'var(--text-secondary)';
    return;
  }
  el.textContent = `$ ${absDif.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}${dif < -0.005 ? ' de más' : dif > 0.005 ? ' pendiente' : ''}`;
  el.style.color = absDif < 0.01 ? 'var(--color-success)' : 'var(--color-error)';
}

function onPagoMedioChange() {
  const medio = document.getElementById('pg-medio').value;
  const panel = document.getElementById('pg-trf-panel');
  const dzArea = document.getElementById('pg-comprobante-drop')?.closest('.form-group');
  const esEfectivo = medio === 'Efectivo';
  // Ocultar panel de transferencia si es efectivo
  if (panel) panel.style.display = esEfectivo ? 'none' : '';
  // Ocultar nro de operación si es efectivo
  const nroGroup = document.getElementById('pg-nro-trf')?.closest('.form-group');
  if (nroGroup) nroGroup.style.display = esEfectivo ? 'none' : '';
}

// ── Comprobante de pago ───────────────────────────────────────────────────────
let _pagoComprobanteFile = null;

function handlePagoComprobanteDrop(e) {
  e.preventDefault();
  const dz = document.getElementById('pg-comprobante-drop');
  if (dz) dz.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) previewPagoComprobante(file);
}

function previewPagoComprobante(file) {
  if (!file) return;
  _pagoComprobanteFile = file;
  const dz   = document.getElementById('pg-comprobante-drop');
  const prev = document.getElementById('pg-comprobante-prev');
  const eye  = document.getElementById('pg-comprobante-eye');
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const fileUrl = URL.createObjectURL(file);
  if (isPdf) {
    if (prev) prev.style.display = 'none';
    // Miniatura PDF
    if (dz) {
      let pdfThumb = dz.querySelector('.dz-pdf-thumb');
      if (!pdfThumb) {
        pdfThumb = document.createElement('div');
        pdfThumb.className = 'dz-pdf-thumb';
        pdfThumb.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;pointer-events:none;';
        pdfThumb.innerHTML = '<i class="fa-solid fa-file-pdf" style="font-size:40px;color:#e53e3e;"></i><span style="font-size:11px;color:var(--text-secondary);max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>';
        dz.appendChild(pdfThumb);
      }
      pdfThumb.style.display = 'flex';
      pdfThumb.querySelector('span').textContent = file.name;
    }
    if (eye) { eye.style.display = 'flex'; eye.onclick = (e) => { e.stopPropagation(); _fvOpenerModal = eye.closest('.modal-overlay')?.id || document.querySelector('.modal-overlay.active')?.id || null; openDocViewer(fileUrl, file.name, true); }; }
  } else if (file.type.startsWith('image/')) {
    if (prev) { prev.src = fileUrl; prev.style.display = 'block'; }
    if (eye)  { eye.style.display = 'flex'; eye.onclick = (e) => { e.stopPropagation(); _fvOpenerModal = eye.closest('.modal-overlay')?.id || document.querySelector('.modal-overlay.active')?.id || null; openImgViewer(fileUrl, file.name); }; }
  }
  if (dz)  dz.classList.add('has-img');
  dzSetStatus('pg-ocr-status', `✓ ${file.name}`, 'ok');
  // Auto-extraer con IA si está disponible
  if (_aiAvailable) extractPagoAI();
  else extractPagoOCR();
}

function clearPagoComprobante() {
  _pagoComprobanteFile = null;
  _pagoTrfData = null;
  const dz   = document.getElementById('pg-comprobante-drop');
  const prev = document.getElementById('pg-comprobante-prev');
  const eye  = document.getElementById('pg-comprobante-eye');
  const inp  = document.getElementById('pg-comprobante-input');
  if (dz)   { dz.classList.remove('has-img'); const t = dz.querySelector('.dz-pdf-thumb'); if (t) t.style.display = 'none'; }
  if (prev) { prev.src = ''; prev.style.display = 'none'; }
  if (eye)  eye.style.display = 'none';
  if (inp)  try { inp.value = ''; } catch(e) {}
  dzSetStatus('pg-ocr-status', '');
  // Ocultar panel de datos extraídos por OCR/IA
  const trfPanel = document.getElementById('pg-trf-panel');
  if (trfPanel) trfPanel.style.display = 'none';
}

// OCR del comprobante de pago — extrae monto, fecha y destinatario
async function extractPagoOCR() {
  if (!_pagoComprobanteFile) return;
  dzSetStatus('pg-ocr-status', '⏳ Leyendo comprobante…', 'info');
  try {
    const fd = new FormData();
    fd.append('comprobante', _pagoComprobanteFile);
    const res = await fetch('/api/ocr/comprobante', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    let filled = 0;
    // ── Monto ──
    if (data.monto) {
      setAmt('pg-monto', data.monto);
      const raw = document.getElementById('pg-monto-raw'); if (raw) raw.value = data.monto;
      filled++;
      calcPagoConceptos();
    }
    // ── Fecha ──
    if (data.fecha) {
      const fmtDT = data.fecha.replace(' ', 'T').substring(0, 16);
      const el = document.getElementById('pg-fecha');
      if (el) { el.value = fmtDT; filled++; }
    }
    // ── Nro operación ──
    if (data.nro_transaccion) {
      const el = document.getElementById('pg-nro-trf');
      if (el && !el.value) { el.value = data.nro_transaccion; filled++; }
    }
    // ── Medio de pago: inferido del banco, fintech o nro. de operación ──
    if (_inferMedioPago(data)) filled++;
    // Detalle/Notas — no se autocomplet, lo escribe el usuario
    // ── Panel Origen / Destino ──
    const panel = document.getElementById('pg-trf-panel');
    if (panel && (data.nombre_origen || data.nombre_destino)) {
      panel.style.display = '';
      const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt || ''; };
      setText('pg-origen-nombre', data.nombre_origen || '');
      setText('pg-origen-cuil',   data.cuil_origen   ? `CUIL/CUIT: ${data.cuil_origen}` : '');
      setText('pg-origen-banco',  data.medio_pago    || '');
      setText('pg-destino-nombre', data.nombre_destino || '');
      setText('pg-destino-cuil',   data.cuil_destino   ? `CUIL/CUIT: ${data.cuil_destino}` : '');
      setText('pg-destino-banco',  data.banco_destino  || '');
      if (data.monto) document.getElementById('pg-trf-monto').textContent = `$ ${data.monto.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}`;
      if (data.nro_transaccion) document.getElementById('pg-trf-nro').textContent = `Op. ${data.nro_transaccion}`;
      // Cruzar cuentas (asegurar cache cargado)
      if (!_cachedCuentas.length) await loadCuentasSelect();
      const co = _matchCuenta(data.cuil_origen,  data.cbu_origen,  null);
      // Para destino probar CBU/CVU primero, luego CUIL
      const aliasD = data.alias_destino || data.alias || null;
      const cd = _matchCuenta(data.cuil_destino, data.cbu_destino, aliasD)
              || _matchCuenta(null, data.cbu_destino, null);
      document.getElementById('pg-origen-match').innerHTML  = _matchLabel(co)  || '<span style="color:var(--text-secondary);font-size:11px;">No registrado</span>';
      document.getElementById('pg-destino-match').innerHTML = _matchLabel(cd)  || '<span style="color:var(--text-secondary);font-size:11px;">No registrado</span>';
      // Auto-seleccionar cuenta destino en el select
      const cuentaId = (cd || co)?.id;
      if (cuentaId) { const sel = document.getElementById('pg-cuenta'); if (sel) { if (sel._ssSet) sel._ssSet(cuentaId); else sel.value = cuentaId; } }
      // Auto-identificar chofer por CUIL/nombre del origen
      if (!cachedChoferes.length) await loadChoferesSelect();
      if (_autoSelectChofer(data.cuil_origen, data.nombre_origen)) filled++;
      filled++;
    }
    // ── Guardar para save ──
    _pagoTrfData = {
      origen_nombre: data.nombre_origen, origen_cuil: data.cuil_origen,
      origen_cbu: data.cvu_origen, origen_alias: data.alias, origen_banco: data.medio_pago,
      destino_nombre: data.nombre_destino, destino_cuil: data.cuil_destino,
      destino_cbu: data.cbu_destino, destino_alias: null, destino_banco: data.banco_destino,
      codigo_identificacion: data.codigo_identificacion,
    };
    const sinMonto = !data.monto;
    const msg = filled > 0
      ? `✓ OCR: ${filled} campo${filled!==1?'s':''} completado${filled!==1?'s':''}${sinMonto ? ' — importe no detectado, usá IA' : ''}`
      : '⚠ OCR sin datos suficientes — probá con IA';
    dzSetStatus('pg-ocr-status', msg, filled > 0 ? (sinMonto ? 'warn' : 'ok') : 'warn');
  } catch(err) {
    dzSetStatus('pg-ocr-status', '✗ Error OCR: ' + err.message, 'error');
  }
}

// Formatea monto con separadores de miles mientras el usuario escribe
function fmtMontoInput(el) {
  fmtAmountInput(el);
  const num = parseFloat((el.dataset.raw || '').replace(/,/g, '')) || 0;
  const hidEl = document.getElementById('pg-monto-raw');
  if (hidEl) hidEl.value = num || '';
}

// Identifica banco/fintech a partir de CBU (cod. BCRA primeros 3 dígitos)
// o CVU (prefijo 8 dígitos fintechs) — usa el _cachedBancos ya declarado arriba
function _identifyBanco(cbu) {
  const b = _identifyBancoObj(cbu);
  return b ? b.nombre : null;
}

function _identifyBancoObj(cbu) {
  if (!cbu) return null;
  const digits = cbu.replace(/\D/g, '');
  if (digits.length < 8) return null;
  if (digits.startsWith('000')) {
    const m = _cachedBancos.find(b => b.cvu_prefix && digits.startsWith(b.cvu_prefix));
    if (m) return m;
  }
  const cod = digits.substring(0, 3);
  return _cachedBancos.find(b => b.codigo_bcra === cod) || null;
}

// Auto-detecta banco desde CBU/CVU y setea el select del formulario de cuenta
async function cuentaCbuInput() {
  await _loadBancos();
  const cbu = document.getElementById('cuenta-cbu')?.value || '';
  const banco = _identifyBancoObj(cbu);
  const sel = document.getElementById('cuenta-banco-id');
  if (sel && banco && !sel.value) {
    if (sel._ssSet) sel._ssSet(banco.id);
    else sel.value = banco.id;
  }
}

// Busca en _cachedCuentas por CUIL/CUIT, CBU/CVU o alias
function _matchCuenta(cuil, cbu, alias) {
  if (!_cachedCuentas?.length) return null;
  const norm = s => (s || '').replace(/\D/g, '');
  const nb = norm(cbu), nc = norm(cuil), na = (alias||'').toLowerCase().trim();
  // Prioridad: CBU exacto > alias exacto > CUIL (puede tener varias cuentas)
  if (nb) { const r = _cachedCuentas.find(c => norm(c.cbu_cvu) === nb); if (r) return r; }
  if (na) { const r = _cachedCuentas.find(c => na === (c.alias||'').toLowerCase().trim()); if (r) return r; }
  if (nc) { const r = _cachedCuentas.find(c => norm(c.cuil) === nc); if (r) return r; }
  return null;
}

// Intenta identificar un chofer a partir de CUIL, DNI o nombre extraído del comprobante
function _matchChofer(cuil, nombre) {
  if (!cachedChoferes?.length) return null;
  const normDigits = s => (s || '').replace(/\D/g, '');
  const nc = normDigits(cuil);
  // 1. Por CUIL/CUIT exacto (dígitos)
  if (nc) {
    const found = cachedChoferes.find(c => normDigits(c.cuil) === nc || normDigits(c.dni) === nc);
    if (found) return found;
  }
  // 2. Por nombre parcial (ambas palabras deben aparecer)
  if (nombre) {
    const parts = nombre.toLowerCase().split(/\s+/).filter(p => p.length > 2);
    if (parts.length) {
      const found = cachedChoferes.find(c => {
        const full = `${c.nombre||''} ${c.apellido||''}`.toLowerCase();
        return parts.every(p => full.includes(p));
      });
      if (found) return found;
    }
  }
  return null;
}

function _autoSelectChofer(cuil, nombre) {
  const chofer = _matchChofer(cuil, nombre);
  if (!chofer) return false;
  const sel = document.getElementById('pg-chofer');
  if (sel) { if (sel._ssSet) sel._ssSet(chofer.id); else sel.value = chofer.id; }
  return true;
}

function _matchLabel(cuenta) {
  if (!cuenta) return null;
  return `<span style="color:var(--accent-green,#22c55e);font-weight:600;">✓ ${[cuenta.nombre, cuenta.apellido].filter(Boolean).join(' ')} (${cuenta.alias})</span>`;
}

let _pagoTrfData = null; // datos extraídos por IA para guardar con el pago
let _pagoEditId  = null; // ID del pago en modo edición (null = nuevo)

async function extractPagoAI() {
  if (!_pagoComprobanteFile) return;
  dzSetStatus('pg-ocr-status', '🤖 Analizando con IA…', 'info');
  _pagoTrfData = null;
  try {
    await _loadBancos();
    const fd = new FormData();
    fd.append('factura', _pagoComprobanteFile);
    const res = await fetch('/api/ai/extract-factura', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const d = await res.json();

    // ── Monto ──
    const monto = parseFloat((d.total || '').toString().replace(/[^\d.]/g, '')) || 0;
    if (monto) {
      const raw = document.getElementById('pg-monto-raw');
      const vis = document.getElementById('pg-monto');
      if (raw) raw.value = monto;
      if (vis) vis.value = monto.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2});
    }

    // ── Fecha del comprobante ──
    if (d.fecha_emision) {
      const el = document.getElementById('pg-fecha');
      if (el) el.value = d.fecha_emision.replace(' ', 'T').substring(0, 16);
    }

    // ── Nro operación ──
    const nro = d.nro_operacion || d.numero_factura || '';
    if (nro) { const el = document.getElementById('pg-nro-trf'); if (el) el.value = nro; }

    // ── Identificar banco por CBU/CVU ──
    const bancoOrigen  = d.banco_origen  || _identifyBanco(d.cbu_origen)  || '';
    const bancoDestino = d.banco_destino || _identifyBanco(d.cbu_destino) || '';
    // Enriquecer d con bancos computados para _inferMedioPago
    d.banco_origen  = bancoOrigen;
    d.banco_destino = bancoDestino;

    // ── Medio de pago: inferido de banco, fintech o nro. de operación ──
    _inferMedioPago(d);

    // ── Panel Origen / Destino ──
    const panel = document.getElementById('pg-trf-panel');
    if (panel) {
      const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt || ''; };
      setText('pg-origen-nombre',  d.nombre_origen  || d.proveedor_nombre || '');
      setText('pg-origen-cuil',    d.cuil_origen    ? `CUIL/CUIT: ${d.cuil_origen}` : '');
      setText('pg-origen-banco',   bancoOrigen);
      setText('pg-destino-nombre', d.nombre_destino || '');
      setText('pg-destino-cuil',   d.cuil_destino   ? `CUIL/CUIT: ${d.cuil_destino}` : '');
      setText('pg-destino-banco',  bancoDestino + (d.alias_destino ? ` · ${d.alias_destino}` : ''));
      document.getElementById('pg-trf-monto').textContent = monto ? `$ ${monto.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}` : '';
      document.getElementById('pg-trf-nro').textContent   = nro   ? `Op. ${nro}` : '';

      // Cruzar con cuentas registradas (asegurar cache cargado)
      if (!_cachedCuentas.length) await loadCuentasSelect();
      const cuentaOrigen  = _matchCuenta(d.cuil_origen,  d.cbu_origen,  null);
      const cuentaDestino = _matchCuenta(d.cuil_destino, d.cbu_destino, d.alias_destino)
                         || _matchCuenta(null, d.cbu_destino, null);
      document.getElementById('pg-origen-match').innerHTML  = _matchLabel(cuentaOrigen)  || '<span style="color:var(--text-secondary);font-size:11px;">No registrado</span>';
      document.getElementById('pg-destino-match').innerHTML = _matchLabel(cuentaDestino) || '<span style="color:var(--text-secondary);font-size:11px;">No registrado</span>';

      // Auto-seleccionar cuenta
      const cuentaId = (cuentaDestino || cuentaOrigen)?.id;
      if (cuentaId) { const sel = document.getElementById('pg-cuenta'); if (sel) { if (sel._ssSet) sel._ssSet(cuentaId); else sel.value = cuentaId; } }
      // Auto-identificar chofer por CUIL/nombre del origen
      if (!cachedChoferes.length) await loadChoferesSelect();
      _autoSelectChofer(d.cuil_origen || d.proveedor_cuit, d.nombre_origen || d.proveedor_nombre);
      panel.style.display = '';
    }

    // Guardar para el save
    _pagoTrfData = {
      origen_nombre: d.nombre_origen || d.proveedor_nombre || null,
      origen_cuil:   d.cuil_origen   || null,
      origen_cbu:    d.cbu_origen    || null,
      origen_alias:  d.alias_origen  || d.alias || null,
      origen_banco:  bancoOrigen     || null,
      destino_nombre: d.nombre_destino || null,
      destino_cuil:   d.cuil_destino   || null,
      destino_cbu:    d.cbu_destino    || null,
      destino_alias:  d.alias_destino  || null,
      destino_banco:  bancoDestino     || null,
      codigo_identificacion: d.codigo_identificacion || null,
      nro_transaccion: nro || null,
    };

    dzSetStatus('pg-ocr-status', '✓ Datos extraídos del comprobante', 'ok');
  } catch (err) {
    if (st) st.textContent = _aiErrorMsg(err);
  }
}

// ── OCR / IA para comprobante de pago de multa ──────────────────────────────

const _MULTA_PAGO_STATUS = 'multa-pago-dz-dropzone';

function _fillMultaPagoFields(data) {
  // Fecha
  if (data.fecha) {
    const el = document.getElementById('multa-fecha-pago');
    if (el) el.value = data.fecha.replace(' ', 'T').substring(0, 10);
  }
  // Nro operación
  const nro = data.nro_transaccion || data.nro_operacion || data.numero_factura || '';
  if (nro) { const el = document.getElementById('multa-nro-operacion-pago'); if (el) el.value = nro; }
  // Medio de pago + cuenta
  const medio = _inferMedioPagoStr(data);
  const cuentaId = (function() {
    if (!_cachedCuentas.length) return '';
    const c = _matchCuenta(data.cuil_destino || data.cuil_origen, data.cbu_destino || data.cbu_origen, data.alias_destino || data.alias_origen || null)
           || _matchCuenta(data.cuil_origen, data.cbu_origen, null);
    return c?.id || '';
  })();
  const sel = document.getElementById('multa-medio-pago');
  if (sel && medio) sel.value = medio;
  _onMultaMedioPagoChange(medio || (sel?.value || ''), cuentaId, '', 1);
}

// Devuelve el string de medio de pago inferido (igual que _inferMedioPago pero sin tocar el DOM de Pagos)
function _inferMedioPagoStr(data) {
  const banco = (data.banco_origen || data.banco_destino || data.medio_pago || '').toLowerCase();
  if (/mercado\s?pago|mp\.com/i.test(banco))  return 'MercadoPago';
  if (/uala|ualá/i.test(banco))               return 'Uala';
  if (/transfer/i.test(banco) || data.cbu_origen || data.cbu_destino) return 'Transferencia';
  if (/tarjeta|visa|master|cabal/i.test(banco)) return 'Tarjeta';
  if (/efectivo|cash/i.test(banco))             return 'Efectivo';
  return '';
}

async function extractMultaPagoOCR() {
  const file = _dzMultaPago?._file;
  if (!file) return;
  dzSetStatus(_MULTA_PAGO_STATUS, '⏳ Leyendo comprobante…', 'info');
  try {
    const fd = new FormData();
    fd.append('comprobante', file);
    const res = await fetch('/api/ocr/comprobante', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (!_cachedCuentas.length) await loadCuentasSelect();
    _fillMultaPagoFields(data);
    dzSetStatus(_MULTA_PAGO_STATUS, '✓ OCR: datos completados', 'ok');
  } catch(err) {
    dzSetStatus(_MULTA_PAGO_STATUS, '✗ Error OCR: ' + err.message, 'error');
  }
}

async function extractMultaPagoAI() {
  const file = _dzMultaPago?._file;
  if (!file) return;
  dzSetStatus(_MULTA_PAGO_STATUS, '🤖 Analizando con IA…', 'info');
  try {
    await _loadBancos();
    const fd = new FormData();
    fd.append('factura', file);
    const res = await fetch('/api/ai/extract-factura', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const d = await res.json();
    // Enriquecer con bancos identificados por CBU
    d.banco_origen  = d.banco_origen  || _identifyBanco(d.cbu_origen)  || '';
    d.banco_destino = d.banco_destino || _identifyBanco(d.cbu_destino) || '';
    // Normalizar campos al formato que espera _fillMultaPagoFields
    d.fecha           = d.fecha_emision || d.fecha || '';
    d.nro_transaccion = d.nro_operacion || d.numero_factura || '';
    if (!_cachedCuentas.length) await loadCuentasSelect();
    _fillMultaPagoFields(d);
    dzSetStatus(_MULTA_PAGO_STATUS, '✓ IA: datos extraídos', 'ok');
  } catch(err) {
    dzSetStatus(_MULTA_PAGO_STATUS, '✗ ' + _aiErrorMsg(err), 'error');
  }
}

async function savePago(e) {
  e.preventDefault();

  const choferId = parseInt(document.getElementById('pg-chofer').value, 10) || null;
  if (!choferId) { showAlert('El Chofer es obligatorio'); return; }

  // datetime-local → "YYYY-MM-DD HH:MM:SS" para MySQL DATETIME
  const fechaRaw = document.getElementById('pg-fecha').value; // "YYYY-MM-DDTHH:MM"
  const fechaMySQL = fechaRaw ? fechaRaw.replace('T', ' ') + ':00' : '';

  const montoEl  = document.getElementById('pg-monto');
  const pgRawEl  = document.getElementById('pg-monto-raw');
  const monto = parseFloat(montoEl?.dataset?.raw)
             || parseFloat(pgRawEl?.value)
             || parseFloat((montoEl?.value||'').replace(/\./g,'').replace(/,/g,'.'))
             || 0;
  if (pgRawEl) pgRawEl.value = monto || '';
  if (!monto) { showAlert('El monto es obligatorio'); return; }

  // Validar imputaciones para ingresos: obligatorio y debe balancear
  const tipo = document.getElementById('pg-tipo').value;
  if (tipo === 'ingreso') {
    const campos = ['pg-rend-alquiler','pg-rend-peajes','pg-rend-deuda','pg-rend-productos','pg-rend-otro'];
    const suma = campos.reduce((acc, id) => acc + getAmt(id), 0);
    if (suma < 0.01) {
      showAlert('Debés imputar el monto en al menos un concepto antes de guardar.', 'warning');
      document.getElementById('pg-rend-diferencia')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (Math.abs(monto - suma) > 0.01) {
      const dif = monto - suma;
      showAlert(`La imputación no balancea: $${Math.abs(dif).toLocaleString('en-US',{minimumFractionDigits:2})} ${dif < 0 ? 'de más' : 'pendiente'}.\n\nCorregí los conceptos antes de guardar.`, 'warning');
      document.getElementById('pg-rend-diferencia')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }

  const data = {
    chofer_id: choferId,
    tipo: document.getElementById('pg-tipo').value,
    concepto: document.getElementById('pg-concepto').value,
    monto,
    fecha: fechaMySQL,
    medio_pago: document.getElementById('pg-medio').value || null,
    cuenta_id: parseInt(document.getElementById('pg-cuenta').value, 10) || null,
    nro_transaccion: document.getElementById('pg-nro-trf')?.value || null,
    detalle: document.getElementById('pg-detalle').value || null
  };

  // ── Control de duplicados ─────────────────────────────────────────
  const nroTrf = document.getElementById('pg-nro-trf')?.value?.trim();
  // (checkDupNro ya pudo haber mostrado el hint; aquí confirmamos antes de guardar)
  if (nroTrf) {
    try {
      const dup = await fetch(`/api/pagos/check-dup?nro_transaccion=${encodeURIComponent(nroTrf)}&chofer_id=${choferId}${_pagoEditId ? '&exclude_id=' + _pagoEditId : ''}`);
      if (dup.ok) {
        const { existe, fecha: fExiste, id: dupId } = await dup.json();
        if (existe) {
          const fecha = fExiste ? ` del ${formatDate(fExiste)}` : '';
          const ok = await showConfirm(`Ya existe un cobro con Nro. Operación ${nroTrf}${fecha}.\n¿Registrar de todas formas?`, 'Registrar igual', 'Cancelar');
          if (!ok) return;
        }
      }
    } catch (_) {}
  }

  try {
    let res;
    // Conceptos (solo tipo ingreso)
    const conceptoIds = ['pg-rend-alquiler','pg-rend-peajes','pg-rend-deuda','pg-rend-productos','pg-rend-otro'];
    const conceptoNames = ['alquiler','peajes','multas','cobranza_productos','otro'];
    const conceptos = conceptoIds.map((id, i) => ({ concepto: conceptoNames[i], monto: getAmt(id) })).filter(c => c.monto > 0);

    const url    = _pagoEditId ? `/api/pagos/${_pagoEditId}` : '/api/pagos';
    const method = _pagoEditId ? 'PUT' : 'POST';

    if (_pagoComprobanteFile) {
      const fd = new FormData();
      Object.entries(data).forEach(([k, v]) => { if (v !== null && v !== undefined) fd.append(k, v); });
      // _pagoTrfData: excluir campos que ya vienen en `data` para evitar duplicados en FormData
      if (_pagoTrfData) Object.entries(_pagoTrfData).forEach(([k, v]) => { if (v && !(k in data)) fd.append(k, v); });
      if (conceptos.length) fd.append('conceptos', JSON.stringify(conceptos));
      fd.append('comprobante', _pagoComprobanteFile);
      res = await fetch(url, { method, body: fd });
    } else {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, conceptos: conceptos.length ? conceptos : undefined })
      });
    }

    if (res.ok) {
      showAlert(_pagoEditId ? 'Cobro actualizado con éxito' : '¡Operación registrada con éxito!', 'success');
      clearPagoComprobante();
      closeModal('modal-pago');
      document.getElementById('form-pago').reset();
      const pgRaw = document.getElementById('pg-monto-raw'); if (pgRaw) pgRaw.value = '';
      const pgPanel = document.getElementById('pg-trf-panel'); if (pgPanel) pgPanel.style.display = 'none';
      const pgNroGroup = document.getElementById('pg-nro-trf')?.closest('.form-group'); if (pgNroGroup) pgNroGroup.style.display = '';
      _pagoTrfData = null;
      document.getElementById('pg-fecha').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().substring(0, 16);
      loadPrestamos();
      loadPagos();
      loadRendiciones(true);
    } else {
      const err = await res.json();
      showAlert(`Error: ${err.message}`);
    }
  } catch (error) {
    showAlert('Fallo al registrar operación financiera.');
  }
}

// --- CATALOGS AND DROPDOWNS ---

let _cachedModelos = [];

async function loadMarcasSelect() {
  try {
    const res = await fetch('/api/marcas');
    cachedMarcas = await res.json();
    // No hace falta poblar un <select> — el input searchable usa cachedMarcas
  } catch (error) { console.error('Error al cargar marcas:', error); }
}

// ── Dropdown flotante anclado al input (position:fixed para no ser clippeado por overflow del modal) ──
function _makeSearchDrop(items, dropId, onSelect, extraStyle, anchorInputId) {
  // Si hay anchorInputId, usar dropdown flotante fijo; si no, dropdown estático legacy
  const drop = document.getElementById(dropId);
  if (!drop) return;
  drop.innerHTML = '';
  const limit = Math.min(items.length, 30);
  items.slice(0, limit).forEach(item => {
    const d = document.createElement('div');
    d.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:13px;color:var(--text-primary);' + (extraStyle||'');
    d.textContent = item.nombre;
    d.onmouseover = () => d.style.background = 'var(--bg-tertiary)';
    d.onmouseleave = () => d.style.background = '';
    d.onmousedown = () => onSelect(item);
    drop.appendChild(d);
  });
  if (!items.length) { drop.style.display = 'none'; return; }

  if (anchorInputId) {
    // Posición fija anclada al input para esquivar el overflow del modal
    const inp = document.getElementById(anchorInputId);
    if (inp) {
      const rect = inp.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropH = Math.min(limit * 37, 220);
      if (spaceBelow >= dropH || spaceBelow >= 80) {
        // Abrir hacia abajo
        drop.style.position = 'fixed';
        drop.style.top    = rect.bottom + 2 + 'px';
        drop.style.bottom = '';
        drop.style.left   = rect.left + 'px';
        drop.style.width  = rect.width + 'px';
      } else {
        // Abrir hacia arriba
        drop.style.position = 'fixed';
        drop.style.bottom   = (window.innerHeight - rect.top + 2) + 'px';
        drop.style.top      = '';
        drop.style.left     = rect.left + 'px';
        drop.style.width    = rect.width + 'px';
      }
      drop.style.zIndex = '99999';
      // Mover al body si aún está dentro del card (sólo primera vez)
      if (drop.parentElement !== document.body) {
        document.body.appendChild(drop);
      }
    }
  }
  drop.style.display = 'block';
}

function filterMarcas(q) {
  const filtered = cachedMarcas.filter(m => m.nombre.toLowerCase().includes((q||'').toLowerCase().trim()));
  _makeSearchDrop(filtered, 'vh-marca-dropdown', (m) => {
    document.getElementById('vh-marca-input').value = m.nombre;
    document.getElementById('vh-marca').value = m.id;
    document.getElementById('vh-marca-dropdown').style.display = 'none';
    // Limpiar modelo al cambiar marca
    document.getElementById('vh-modelo-input').value = '';
    document.getElementById('vh-modelo').value = '';
    _cachedModelos = [];
    loadModelosForMarca(m.id);
  }, '', 'vh-marca-input');
}

function hideMarcaDrop() {
  setTimeout(() => { const d = document.getElementById('vh-marca-dropdown'); if(d) d.style.display='none'; }, 200);
}

function filterModelos(q) {
  const filtered = _cachedModelos.filter(m => m.nombre.toLowerCase().includes((q||'').toLowerCase().trim()));
  _makeSearchDrop(filtered, 'vh-modelo-dropdown', (m) => {
    document.getElementById('vh-modelo-input').value = m.nombre;
    document.getElementById('vh-modelo').value = m.id;
    document.getElementById('vh-modelo-dropdown').style.display = 'none';
  }, '', 'vh-modelo-input');
}

function hideModeloDrop() {
  setTimeout(() => { const d = document.getElementById('vh-modelo-dropdown'); if(d) d.style.display='none'; }, 200);
}

async function loadModelosForMarca(marcaId, selectedModeloId = null) {
  _cachedModelos = [];
  document.getElementById('vh-modelo-input').value = '';
  document.getElementById('vh-modelo').value = '';
  try {
    const res = await fetch(`/api/modelos?marca_id=${marcaId}`);
    _cachedModelos = await res.json();
    if (selectedModeloId) {
      const m = _cachedModelos.find(x => x.id === selectedModeloId);
      if (m) {
        document.getElementById('vh-modelo-input').value = m.nombre;
        document.getElementById('vh-modelo').value = m.id;
      }
    }
  } catch (error) { console.error('Error al cargar modelos:', error); }
}

function onMarcaChange() {} // reemplazado por filterMarcas

async function loadAseguradorasSelect() {
  try {
    const res = await fetch('/api/aseguradoras');
    cachedAseguradoras = await res.json();
    
    // Populate form insurance select
    const select = document.getElementById('seg-compania');
    select.innerHTML = '<option value="">-- Seleccionar Compañía --</option>';
    cachedAseguradoras.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.innerText = a.nombre;
      select.appendChild(opt);
    });
  } catch (error) {
    console.error('Error al cargar aseguradoras:', error);
  }
}

// --- DRAG AND DROP OCR ---

function initDragAndDropOCR() {
  const dropzone = document.getElementById('cedula-dropzone');
  const fileInput = document.getElementById('cedula-file-input');
  
  if (!dropzone) return;

  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      processCedulaOCR(files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      processCedulaOCR(fileInput.files[0]);
    }
  });
}

async function processCedulaOCR(file) {
  const loading = document.getElementById('ocr-loading');
  loading.style.display = 'flex';
  
  const formData = new FormData();
  formData.append('cedula_img', file);

  try {
    const res = await fetch('/api/ocr/cedula', {
      method: 'POST',
      body: formData
    });

    if (!res.ok) throw new Error('Error al procesar la imagen.');

    const data = await res.json();
    if (data.success) {
      showAlert(`OCR: Escaneo exitoso! Dominio detectado: ${data.patente || 'N/A'}`);
      
      // Auto-fill fields
      if (data.patente) document.getElementById('vh-patente').value = data.patente;
      if (data.motor) document.getElementById('vh-motor').value = data.motor;
      if (data.chasis) document.getElementById('vh-chasis').value = data.chasis;
      
      // Auto select brand and model
      if (data.marca_id) {
        const marcaObj = cachedMarcas.find(m => m.id === data.marca_id);
        document.getElementById('vh-marca-input').value = marcaObj?.nombre || '';
        document.getElementById('vh-marca').value = data.marca_id;
        await loadModelosForMarca(data.marca_id, data.modelo_id);
      }
      
      if (data.archivo_url) {
        document.getElementById('vh-foto-principal').value = data.archivo_url;
      }
    } else {
      showAlert('No se pudieron extraer los datos estructurados. Complete manualmente.');
    }
  } catch (error) {
    console.error('Error OCR:', error);
    showAlert('Fallo al conectar con el motor OCR. Intente de nuevo.');
  } finally {
    loading.style.display = 'none';
  }
}

// --- FILE UPLOADER UTILITY ---

function initFileUploader(fileInputId, hiddenInputId, labelId) {
  const fileInput = document.getElementById(fileInputId);
  const hiddenInput = document.getElementById(hiddenInputId);
  const label = document.getElementById(labelId);
  
  if (!fileInput) return;

  fileInput.addEventListener('change', async () => {
    if (fileInput.files.length === 0) return;
    
    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('archivo', file);
    
    label.innerText = 'Subiendo...';

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      
      if (!res.ok) throw new Error('Error en subida');
      
      const data = await res.json();
      if (data.success) {
        hiddenInput.value = data.archivo_url;
        label.innerText = `Listo: ${data.original_name}`;
      }
    } catch (error) {
      console.error('Subida error:', error);
      label.innerText = 'Error al subir';
    }
  });
}

// Switch tab within the same modal card (scoped)
function switchModalTab(btnEl, tabContentId) {
  if (!btnEl) return;
  const card = btnEl.closest('.modal-card');
  if (!card) return;
  card.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.remove('active'));
  card.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));
  btnEl.classList.add('active');
  const tab = document.getElementById(tabContentId);
  if (tab) tab.classList.add('active');
}

// --- DETAIL MODAL TAB SYSTEM ---

function initModalTabs() {
  document.querySelectorAll('.modal-tab-btn').forEach(btn => {
    // Los botones con onclick inline se manejan solos
    if (btn.getAttribute('onclick')) return;
    btn.addEventListener('click', () => {
      const card = btn.closest('.modal-card');
      if (!card) return;
      card.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const contentId = btn.getAttribute('data-modal-tab');
      if (!contentId) return;
      const tab = document.getElementById(contentId);
      if (!tab) return;
      card.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
    });
  });
}

// Desde el modal Editar Vehículo, tab VTV/GNC/Seguro/Service → abre modal detalle en esa solapa
function switchVhEditTabDetalle(detalleTabId, btn) {
  const vhId = document.getElementById('vh-id')?.value;
  if (!vhId) {
    showToast('Guardá primero el vehículo para acceder a esta sección.', 'warning');
    return;
  }
  btn.closest('.modal-card')?.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  closeModal('modal-vehiculo');
  openVehiculoDetalleModal(parseInt(vhId), detalleTabId);
}

// --- HISTORICAL CRUD VEHICLE DETAIL ---

async function openVehiculoDetalleModal(id, initialTab) {
  activeVehiculoId = id;
  const v = cachedVehiculos.find(x => x.id === id);
  if (!v) return;

  document.getElementById('det-patente').innerText = v.patente;

  // Set tab buttons state (scoped al modal detalle)
  const detalleCard = document.querySelector('#modal-vehiculo-detalle .modal-card');
  if (detalleCard) {
    detalleCard.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.remove('active'));
    detalleCard.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));
  }
  const startTabId = initialTab || 'det-tab-general';
  const startBtn = document.querySelector(`#modal-vehiculo-detalle [data-modal-tab="${startTabId}"]`);
  if (startBtn) startBtn.classList.add('active');
  const startContent = document.getElementById(startTabId);
  if (startContent) startContent.classList.add('active');

  // Load information
  loadVehiculoGeneralDetalle(v);
  loadVehiculoVTVHistory(id);
  loadVehiculoGNCHistory(id);
  loadVehiculoSegurosHistory(id);
  loadVehiculoServicesHistory(id);

  // Reset inner forms
  document.getElementById('form-vtv').reset();
  clearVtvFile();
  
  document.getElementById('form-gnc').reset();
  document.getElementById('gnc-archivo').value = '';
  document.getElementById('gnc-archivo-lbl').innerText = '';
  
  document.getElementById('form-seguro').reset();
  _segClearPoliza();
  const segArch = document.getElementById('seg-archivo');
  const segLbl  = document.getElementById('seg-archivo-lbl');
  if (segArch) segArch.value = '';
  if (segLbl)  segLbl.innerText = '';

  openModal('modal-vehiculo-detalle');
}

function loadVehiculoGeneralDetalle(v) {
  document.getElementById('det-gen-patente').innerText = v.patente;
  document.getElementById('det-gen-marca-modelo').innerText = `${v.marca || ''} ${v.modelo || ''}`;
  document.getElementById('det-gen-color').innerText = v.color || '-';
  document.getElementById('det-gen-motor').innerText = v.nro_motor || '-';
  document.getElementById('det-gen-chasis').innerText = v.nro_chasis || '-';
  document.getElementById('det-gen-tag').innerText = v.telepeaje_tag || '-';
  
  const respBadge = document.getElementById('det-gen-responsable');
  respBadge.innerText = v.telepeaje_responsable;
  respBadge.className = `badge ${v.telepeaje_responsable === 'chofer' ? 'badge-info' : 'badge-success'}`;

  document.getElementById('det-gen-fecha-alta').innerText = formatDate(v.fecha_alta);
  
  const stateBadge = document.getElementById('det-gen-estado');
  stateBadge.innerText = v.activo ? 'activo' : 'inactivo';
  stateBadge.className = `badge ${v.activo ? 'badge-success' : 'badge-danger'}`;

  document.getElementById('det-gen-baja-info').innerText = !v.activo ? `Baja: ${formatDate(v.fecha_baja)} - ${v.motivo_baja || ''}` : '-';

  // Datos del Titular DNRPA
  const hayTitular = v.titular_nombre || v.titular_dni || v.titular_domicilio;
  document.getElementById('det-gen-titular-section').style.display = hayTitular ? '' : 'none';
  document.getElementById('det-gen-titular-nombre').innerText = v.titular_nombre || '-';
  document.getElementById('det-gen-titular-dni').innerText = v.titular_dni || '-';
  document.getElementById('det-gen-titular-domicilio').innerText = v.titular_domicilio || '-';
  document.getElementById('det-gen-titular-cuit').innerText = v.titular_cuit || '-';
  document.getElementById('det-gen-titular-email').innerText = v.titular_email || '-';
  document.getElementById('det-gen-titular-celular').innerText = v.titular_celular || '-';

  const fotoContainer = document.getElementById('det-gen-foto-container');
  const cedFrente  = v.cedula_frente_url;
  const cedDorso   = v.cedula_dorso_url;
  const fotoFrente = v.foto_frente_url;
  const fotoLatDer = v.foto_lat_der_url;
  const fotoLatIzq = v.foto_lat_izq_url;
  const fotoDetras = v.foto_detras_url;
  const fotoPpal   = v.foto_principal;

  const thumb = (url, label) => url
    ? `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
         <img src="${url}?t=${Date.now()}" onclick="openImgViewer('${url}','${label}',null)"
              style="width:120px;height:90px;object-fit:cover;border-radius:6px;border:1px solid var(--border-color);cursor:pointer;" title="${label}">
         <span style="font-size:10px;color:var(--text-secondary);">${label}</span>
       </div>`
    : '';

  const cedHtml  = [thumb(cedFrente,'Cédula Frente'), thumb(cedDorso,'Cédula Dorso')].filter(Boolean).join('');
  const fotoHtml = [thumb(fotoFrente,'Frente'), thumb(fotoLatDer,'Lateral Der.'), thumb(fotoLatIzq,'Lateral Izq.'), thumb(fotoDetras,'Detrás')].filter(Boolean).join('');
  const ppalHtml = fotoPpal ? `<div style="grid-column:1/-1;margin-top:6px;"><img src="${fotoPpal}" style="max-height:180px;max-width:100%;border-radius:8px;border:1px solid var(--border-color);" alt="Foto Principal"></div>` : '';

  if (cedHtml || fotoHtml || ppalHtml) {
    fotoContainer.innerHTML = `
      ${cedHtml ? `<div style="margin-bottom:10px;"><p style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;">Cédula del Vehículo</p><div style="display:flex;gap:10px;flex-wrap:wrap;">${cedHtml}</div></div>` : ''}
      ${fotoHtml ? `<div style="border-top:${cedHtml?'1px solid var(--border-color)':'none'};padding-top:${cedHtml?'10px':'0'};margin-bottom:6px;"><p style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;">Fotos del Estado</p><div style="display:flex;gap:10px;flex-wrap:wrap;">${fotoHtml}</div></div>` : ''}
      ${ppalHtml ? `<div style="border-top:1px solid var(--border-color);padding-top:10px;"><p style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;">Foto Principal</p><div style="display:grid;">${ppalHtml}</div></div>` : ''}
    `;
  } else {
    fotoContainer.innerHTML = `<p class="text-secondary" style="font-size:13px;"><i class="fa-solid fa-image" style="font-size:24px;margin-bottom:5px;"></i><br>Sin fotos registradas</p>`;
  }
}

// 1. VTV History CRUD
// ──────────────────────────────────────────────────────────────
// VTV — Dropzone + OCR + AI + historial
// ──────────────────────────────────────────────────────────────
let _vtvPendingFile = null;

function handleVtvDrop(event) {
  event.preventDefault();
  document.getElementById('vtv-dropzone').classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (file) handleVtvFileSelect(file);
}

function handleVtvFileSelect(file) {
  if (!file) return;
  _vtvPendingFile = file;
  const lbl = document.getElementById('vtv-archivo-lbl');
  if (lbl) lbl.textContent = `📎 ${file.name}`;
  const dz  = document.getElementById('vtv-dropzone');
  const img = document.getElementById('vtv-preview-img');
  const eye = document.getElementById('vtv-eye-btn');
  if (file.type.startsWith('image/')) {
    const url = URL.createObjectURL(file);
    if (img) { img.src = url; img.style.display = 'block'; }
    if (dz)  dz.classList.add('has-img');
    if (eye) { eye.style.display = ''; eye.onclick = () => { _fvOpenerModal = eye.closest('.modal-overlay')?.id || document.querySelector('.modal-overlay.active')?.id || null; openImgViewer(url, file.name); }; }
  } else {
    // PDF — mostrar ícono en el dropzone, deshabilitar OCR (solo imágenes) y auto-ejecutar IA
    const ocrBtn = document.getElementById('dz-ocr-vtv-dropzone');
    if (ocrBtn) { ocrBtn.disabled = true; ocrBtn.title = 'OCR solo funciona con imágenes — para PDFs se usa IA automáticamente'; }
    if (img) img.style.display = 'none';
    if (dz) {
      dz.classList.add('has-img');
      // Ícono PDF dentro del dropzone
      let pdfThumb = dz.querySelector('.dz-pdf-thumb');
      if (!pdfThumb) {
        pdfThumb = document.createElement('div');
        pdfThumb.className = 'dz-pdf-thumb';
        pdfThumb.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;pointer-events:none;';
        pdfThumb.innerHTML = '<i class="fa-solid fa-file-pdf" style="font-size:40px;color:#e53e3e;"></i><span style="font-size:11px;color:var(--text-secondary);max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>';
        dz.appendChild(pdfThumb);
      }
      pdfThumb.style.display = 'flex';
      pdfThumb.querySelector('span').textContent = file.name;
    }
    if (eye) {
      eye.style.display = '';
      const pdfUrl = URL.createObjectURL(file);
      eye.onclick = () => {
        // Asegurar que el opener modal quede registrado aunque la query .active falle
        _fvOpenerModal = eye.closest('.modal-overlay')?.id || document.querySelector('.modal-overlay.active')?.id || null;
        openDocViewer(pdfUrl, file.name, true);
      };
    }
    // Auto-ejecutar IA al cargar PDF (OCR no funciona con PDFs)
    if (_aiAvailable) {
      dzSetStatus('vtv-dropzone', '⏳ Extrayendo datos del PDF…', 'info');
      setTimeout(() => _runVtvAI(), 300);
    } else {
      dzSetStatus('vtv-dropzone', 'PDF listo — presioná IA para extraer datos', 'info');
    }
  }
}

function clearVtvFile() {
  _vtvPendingFile = null;
  const dz  = document.getElementById('vtv-dropzone');
  const img = document.getElementById('vtv-preview-img');
  const eye = document.getElementById('vtv-eye-btn');
  const lbl = document.getElementById('vtv-archivo-lbl');
  const inp = document.getElementById('vtv-file-input');
  if (dz)  { dz.classList.remove('has-img'); const t = dz.querySelector('.dz-pdf-thumb'); if (t) t.style.display = 'none'; }
  if (img) { img.src = ''; img.style.display = 'none'; }
  if (eye) eye.style.display = 'none';
  if (lbl) lbl.textContent = '';
  if (inp) try { inp.value = ''; } catch(e) {}
  dzSetStatus('vtv-ai-status', '');
  const ocrBtn = document.getElementById('dz-ocr-vtv-dropzone');
  if (ocrBtn) { ocrBtn.disabled = false; ocrBtn.title = ''; }
}

async function extractVtvOCR() {
  if (!_vtvPendingFile) { showAlert('Cargá una imagen primero'); return; }
  if (!_vtvPendingFile.type.startsWith('image/')) { showAlert('OCR solo funciona con imágenes — para PDFs usá IA'); return; }
  const btn    = document.getElementById('dz-ocr-vtv-dropzone');
  const status = document.getElementById('vtv-ai-status');
  if (btn) btn.disabled = true;
  if (status) { status.textContent = 'Leyendo VTV…'; status.style.color = 'var(--accent-color)'; status.style.display = ''; }
  try {
    const fd = new FormData();
    fd.append('cedula_img', _vtvPendingFile);
    const res = await fetch('/api/ocr/cedula', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const d = await res.json();
    const txt = (d.raw_text || d.text || '').toUpperCase();
    let filled = 0;

    // ── Resultado (APTO / RECHAZADO / CONDICIONAL) ─────────────────────────
    if (/\bAPTO\b/.test(txt) && !/RECHAZADO|CONDICIONAL/.test(txt)) {
      document.getElementById('vtv-resultado').value = 'apto'; filled++;
    } else if (/RECHAZADO/.test(txt)) {
      document.getElementById('vtv-resultado').value = 'rechazado'; filled++;
    } else if (/CONDICIONAL/.test(txt)) {
      document.getElementById('vtv-resultado').value = 'condicional'; filled++;
    }

    // ── Fechas — buscar patrones DD/MM/AAAA o AAAA-MM-DD ──────────────────
    const toISO = s => {
      const m = s.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}`;
      const m2 = s.match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
      if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
      return null;
    };

    // Fecha de inspección — línea con INSPECCION/FECHA EMISION
    const inspM = txt.match(/(?:INSPECCI[OÓ]N|FECHA\s+EMISI[OÓ]N|EMITIDO)\D{0,20}(\d{2}[\/\-]\d{2}[\/\-]\d{4})/);
    if (inspM) { const v = toISO(inspM[1]); if (v) { document.getElementById('vtv-inspeccion').value = v; filled++; } }

    // Vigencia DESDE
    const desdeM = txt.match(/(?:DESDE|VIGENCIA\s+DESDE|V[ÁA]LIDO\s+DESDE|INICIO)\D{0,20}(\d{2}[\/\-]\d{2}[\/\-]\d{4})/);
    if (desdeM) { const v = toISO(desdeM[1]); if (v) { document.getElementById('vtv-desde').value = v; filled++; } }

    // Vigencia HASTA
    const hastaM = txt.match(/(?:HASTA|VIGENCIA\s+HASTA|V[ÁA]LIDO\s+HASTA|VENCIMIENTO|VENCE)\D{0,20}(\d{2}[\/\-]\d{2}[\/\-]\d{4})/);
    if (hastaM) { const v = toISO(hastaM[1]); if (v) { document.getElementById('vtv-hasta').value = v; filled++; } }

    // Fallback: si solo hay 2-3 fechas en el doc, asignar en orden
    if (!desdeM && !hastaM) {
      const allDates = [...txt.matchAll(/(\d{2}[\/\-]\d{2}[\/\-]\d{4})/g)].map(m => toISO(m[1])).filter(Boolean);
      if (allDates.length >= 2) {
        document.getElementById('vtv-desde').value = allDates[0]; filled++;
        document.getElementById('vtv-hasta').value = allDates[1]; filled++;
      }
    }

    // ── Nº Informe de Inspección ────────────────────────────────────────────
    // "INFORME DE INSPECCIÓN Nº 1734813"
    const inspNroM = txt.match(/INFORME\s+DE\s+INSPECCI[OÓ]N\s*N[º°]?\s*[:\-]?\s*(\d{5,10})/i)
                  || txt.match(/N[º°]\s*INFORME\s*[:\-]?\s*(\d{5,10})/i)
                  || txt.match(/INSPECCI[OÓ]N\s*N[º°]\s*(\d{5,10})/i);
    if (inspNroM) {
      const el = document.getElementById('vtv-nro-inspeccion');
      if (el && !el.value) { el.value = inspNroM[1].trim(); filled++; }
    }

    // ── Nº Oblea ────────────────────────────────────────────────────────────
    // "OBLEA Nº 262837964"
    const obleaM = txt.match(/OBLEA\s*N[º°]?\s*[:\-]?\s*(\d{6,10})/i)
               || txt.match(/N[º°]\s*OBLEA\s*[:\-]?\s*(\d{6,10})/i);
    if (obleaM) {
      const el = document.getElementById('vtv-nro-oblea');
      if (el && !el.value) { el.value = obleaM[1].trim(); filled++; }
    }

    if (status) {
      status.textContent = filled > 0
        ? `✓ OCR — ${filled} campo${filled > 1 ? 's' : ''} completado${filled > 1 ? 's' : ''}`
        : '⚠ OCR sin resultados — si la imagen está girada, rotá y guardá (💾) antes de correr OCR';
      status.style.color = filled > 0 ? 'var(--color-success)' : 'orange';
    }
  } catch (err) {
    if (status) { status.textContent = '✗ Error OCR: ' + err.message; status.style.color = 'var(--color-error)'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function extractVtvAI() {
  if (!_vtvPendingFile) { showAlert('Cargá una imagen o PDF primero'); return; }
  await _runVtvAI();
}

async function _runVtvAI() {
  const btn = document.getElementById('dz-ai-vtv-dropzone');
  const origText = btn?.innerHTML;
  if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; btn.disabled = true; }
  try {
    const fd = new FormData();
    fd.append('vtv', _vtvPendingFile);
    const res = await fetch('/api/ai/extract-vtv', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const data = await res.json();
    if (data.vigencia_desde) document.getElementById('vtv-desde').value = data.vigencia_desde;
    if (data.vigencia_hasta) document.getElementById('vtv-hasta').value = data.vigencia_hasta;
    if (data.fecha_inspeccion) document.getElementById('vtv-inspeccion').value = data.fecha_inspeccion;
    if (data.resultado) document.getElementById('vtv-resultado').value = data.resultado;
    if (data.nro_inspeccion) { const el = document.getElementById('vtv-nro-inspeccion'); if (el) el.value = data.nro_inspeccion; }
    if (data.nro_oblea)      { const el = document.getElementById('vtv-nro-oblea');      if (el) el.value = data.nro_oblea; }
    showToast('Datos VTV extraídos ✓');
  } catch(e) {
    showAlert('Error al extraer datos: ' + e.message);
  } finally {
    if (btn) { btn.innerHTML = origText; btn.disabled = false; }
  }
}

async function loadVehiculoVTVHistory(id) {
  const tbody = document.getElementById('vtv-history-tbody');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Cargando...</td></tr>';
  try {
    const res = await fetch(`/api/vehiculos/${id}/vtv`);
    const history = await res.json();
    tbody.innerHTML = '';
    if (history.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);">Sin registros</td></tr>';
      return;
    }
    history.forEach((r, idx) => {
      const status = getVigenciaStatus(r.vigencia_hasta);
      const stClass = status.class === 'valid' ? 'badge-success' : status.class === 'warning' ? 'badge-warning' : 'badge-danger';
      const stLabel = status.class === 'valid' ? 'Vigente' : status.class === 'warning' ? 'Por vencer' : 'Vencida';
      const resIcons = { apto: '✅ Apto', condicional: '⚠️ Condicional', rechazado: '❌ Rechazado' };
      const docLink = r.archivo_adjunto ? `<button type="button" class="btn btn-secondary btn-sm" onclick="openDocViewer('${r.archivo_adjunto}','VTV ${formatDate(r.vigencia_desde)}')" style="padding:4px 8px;color:var(--accent-color);"><i class="fa-solid fa-file"></i></button>` : '-';
      const tr = document.createElement('tr');
      if (idx % 2 === 1) tr.classList.add('row-alt');
      tr.innerHTML = `
        <td>${r.fecha_inspeccion ? formatDate(r.fecha_inspeccion) : '-'}</td>
        <td>${formatDate(r.vigencia_desde)}</td>
        <td>${formatDate(r.vigencia_hasta)}</td>
        <td><span class="badge ${stClass}">${stLabel}</span> ${r.resultado ? `<span style="font-size:11px;">${resIcons[r.resultado]||''}</span>` : ''}</td>
        <td style="text-align:center;">${docLink}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (error) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--color-error);">Error al cargar historial</td></tr>';
  }
}

async function saveVTV(e) {
  e.preventDefault();
  if (!activeVehiculoId) return;

  try {
    let res;
    if (_vtvPendingFile) {
      // Usar el endpoint de upload que guarda el archivo
      const fd = new FormData();
      fd.append('vtv', _vtvPendingFile);
      fd.append('vigencia_desde', document.getElementById('vtv-desde').value);
      fd.append('vigencia_hasta', document.getElementById('vtv-hasta').value);
      fd.append('resultado', document.getElementById('vtv-resultado').value || '');
      fd.append('fecha_inspeccion', document.getElementById('vtv-inspeccion').value || '');
      fd.append('nro_inspeccion', document.getElementById('vtv-nro-inspeccion').value || '');
      fd.append('nro_oblea', document.getElementById('vtv-nro-oblea').value || '');
      res = await fetch(`/api/vehiculos/${activeVehiculoId}/vtv-upload`, { method: 'POST', body: fd });
    } else {
      res = await fetch(`/api/vehiculos/${activeVehiculoId}/vtv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vigencia_desde: document.getElementById('vtv-desde').value,
          vigencia_hasta: document.getElementById('vtv-hasta').value,
          resultado: document.getElementById('vtv-resultado').value || null,
          fecha_inspeccion: document.getElementById('vtv-inspeccion').value || null,
          nro_inspeccion: document.getElementById('vtv-nro-inspeccion').value || null,
          nro_oblea: document.getElementById('vtv-nro-oblea').value || null,
        })
      });
    }

    if (res.ok) {
      showToast('VTV guardada con éxito');
      document.getElementById('form-vtv').reset();
      document.getElementById('vtv-archivo-lbl').innerText = '';
      document.getElementById('vtv-preview-img').style.display = 'none';
      _vtvPendingFile = null;
      loadVehiculoVTVHistory(activeVehiculoId);
      loadVehiculos();
    } else {
      const err = await res.json();
      showAlert(`Error: ${err.message}`);
    }
  } catch (error) {
    showAlert('Error al guardar VTV.', 'error', 'error');
  }
}

// 2. GNC History CRUD
async function loadVehiculoGNCHistory(id) {
  const tbody = document.getElementById('gnc-history-tbody');
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Cargando...</td></tr>';
  try {
    const res = await fetch(`/api/vehiculos/${id}/gnc`);
    const history = await res.json();
    tbody.innerHTML = '';

    if (history.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-secondary);">Sin registros históricos</td></tr>';
      return;
    }

    history.forEach(r => {
      const status = getVigenciaStatus(r.vigencia_hasta);
      const docLink = r.archivo_adjunto ? `<button type="button" class="btn btn-secondary btn-sm" onclick="openDocViewer('${r.archivo_adjunto}','GNC ${formatDate(r.vigencia_desde)}')" style="padding:4px 8px;color:var(--accent-blue);"><i class="fa-solid fa-file-pdf"></i></button>` : '-';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formatDate(r.vigencia_desde)}</td>
        <td>${formatDate(r.vigencia_hasta)}</td>
        <td><span class="badge ${status.class === 'valid' ? 'badge-success' : (status.class === 'warning' ? 'badge-warning' : 'badge-danger')}">${status.class === 'valid' ? 'vigente' : (status.class === 'warning' ? 'por vencer' : 'vencido')}</span></td>
        <td style="text-align:center;">${docLink}</td>
      `;
      tbody.appendChild(tr);
    });

    // Cargar el archivo del registro más reciente en el dropzone + _pendingFiles
    // para que el OCR pueda usarlo sin que el usuario tenga que re-subir la imagen
    const latest = history[0];
    if (latest?.archivo_adjunto) {
      const prev = document.getElementById('gnc-oblea-preview');
      const eye  = document.getElementById('gnc-oblea-eye');
      const isImg = /\.(jpe?g|png|gif|webp)(\?|$)/i.test(latest.archivo_adjunto);
      if (prev && isImg) {
        prev.src = latest.archivo_adjunto;
        prev.style.display = 'block';
        if (eye) eye.style.display = '';
        // Descargar y poner en _pendingFiles para OCR
        if (!_pendingFiles['gnc_oblea']) {
          fetch(latest.archivo_adjunto)
            .then(r2 => r2.blob())
            .then(blob => {
              _pendingFiles['gnc_oblea'] = new File([blob], 'gnc_oblea.jpg', { type: blob.type || 'image/jpeg' });
            })
            .catch(() => {});
        }
      }
      // Llenar cilindros si el registro los tiene
      gncClearCilindros();
      let hasCil = false;
      for (let i = 1; i <= 4; i++) {
        const m = latest[`cil${i}_marca`], s = latest[`cil${i}_serie`], v = latest[`cil${i}_vto`];
        if (m || s || v) {
          hasCil = true;
          const mEl = document.getElementById(`gnc-cil${i}-marca`);
          const sEl = document.getElementById(`gnc-cil${i}-serie`);
          const vEl = document.getElementById(`gnc-cil${i}-vto`);
          if (mEl) mEl.value = m || '';
          if (sEl) sEl.value = s || '';
          if (vEl) vEl.value = v ? v.slice(0,10) : '';
        }
      }
      if (hasCil) {
        const extra = document.getElementById('gnc-cil-extra');
        if (extra) extra.style.display = 'block';
        const btn = document.getElementById('gnc-add-cil-btn');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-minus"></i> Menos cilindros';
      }
    }
  } catch (error) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--accent-red);">Error al cargar historial</td></tr>';
  }
}

async function saveGNC(e) {
  e.preventDefault();
  if (!activeVehiculoId) return;

  const data = {
    vigencia_desde: document.getElementById('gnc-desde').value,
    vigencia_hasta: document.getElementById('gnc-hasta').value,
    archivo_adjunto: document.getElementById('gnc-archivo').value || null
  };

  try {
    const res = await fetch(`/api/vehiculos/${activeVehiculoId}/gnc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      showAlert('¡GNC guardado con éxito!', 'success');
      document.getElementById('form-gnc').reset();
      document.getElementById('gnc-archivo').value = '';
      document.getElementById('gnc-archivo-lbl').innerText = '';
      loadVehiculoGNCHistory(activeVehiculoId);
      loadVehiculos(); // Refresh general list alerts
    } else {
      const err = await res.json();
      showAlert(`Error: ${err.message}`);
    }
  } catch (error) {
    showAlert('Error al guardar GNC.', 'error', 'error');
  }
}

// 3. Seguro History CRUD
async function loadVehiculoSegurosHistory(id) {
  const tbody = document.getElementById('seguros-history-tbody');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Cargando...</td></tr>';
  try {
    const res = await fetch(`/api/vehiculos/${id}/seguros`);
    const history = await res.json();
    tbody.innerHTML = '';
    
    if (history.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-secondary);">Sin registros históricos</td></tr>';
      return;
    }

    history.forEach(r => {
      const status = getVigenciaStatus(r.vigencia_hasta);
      const docLink = r.archivo_adjunto ? `<button type="button" class="btn btn-secondary btn-sm" onclick="openDocViewer('${r.archivo_adjunto}','Póliza ${r.nro_poliza}')" style="padding:4px 8px;color:var(--accent-blue);"><i class="fa-solid fa-file-pdf"></i></button>` : '-';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${r.aseguradora_nombre}</strong></td>
        <td><code>${r.nro_poliza}</code></td>
        <td>${formatDate(r.vigencia_hasta)}</td>
        <td><span class="badge ${status.class === 'valid' ? 'badge-success' : (status.class === 'warning' ? 'badge-warning' : 'badge-danger')}">${status.class === 'valid' ? 'vigente' : (status.class === 'warning' ? 'por vencer' : 'vencido')}</span></td>
        <td style="text-align:center;">${docLink}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (error) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--accent-red);">Error al cargar historial</td></tr>';
  }
}

async function saveSeguro(e) {
  e.preventDefault();
  if (!activeVehiculoId) return;

  const data = {
    aseguradora_id: parseInt(document.getElementById('seg-compania').value, 10),
    nro_poliza: document.getElementById('seg-poliza').value,
    vigencia_desde: document.getElementById('seg-desde').value,
    vigencia_hasta: document.getElementById('seg-hasta').value,
    archivo_adjunto: document.getElementById('seg-archivo').value || null
  };

  try {
    const res = await fetch(`/api/vehiculos/${activeVehiculoId}/seguros`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      showAlert('¡Seguro guardado con éxito!', 'success');
      document.getElementById('form-seguro').reset();
      document.getElementById('seg-archivo').value = '';
      document.getElementById('seg-archivo-lbl').innerText = '';
      loadVehiculoSegurosHistory(activeVehiculoId);
      loadVehiculos(); // Refresh general list alerts
    } else {
      const err = await res.json();
      showAlert(`Error: ${err.message}`);
    }
  } catch (error) {
    showAlert('Error al guardar Seguro.', 'error', 'error');
  }
}

// 4. Vehicle Specific Services history
async function loadVehiculoServicesHistory(id) {
  const tbody = document.getElementById('det-services-history-tbody');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Cargando...</td></tr>';
  try {
    const res = await fetch(`/api/vehiculos/${id}/services`);
    const history = await res.json();
    tbody.innerHTML = '';
    
    if (history.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-secondary);">No hay servicios registrados para esta unidad</td></tr>';
      return;
    }

    history.forEach(s => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formatDate(s.fecha)}</td>
        <td>${s.trabajo_realizado}</td>
        <td>${s.kms ? `${s.kms.toLocaleString()} km` : '-'}</td>
        <td style="font-weight:600;">${formatCurrency(s.costo_materiales + s.costo_mano_obra)}</td>
        <td><i class="fa-solid fa-store"></i> ${s.proveedor || '-'}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (error) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--accent-red);">Error al cargar servicios</td></tr>';
  }
}

// --- DOCUMENT ALERTS CALCULATION HELPER ---

function getVigenciaStatus(dateStr) {
  if (!dateStr) return { class: 'missing', label: 'Sin registro', daysLeft: null };
  const expDate = new Date(dateStr);
  const today = new Date();
  
  // Reset time components
  expDate.setHours(0,0,0,0);
  today.setHours(0,0,0,0);
  
  const diffTime = expDate - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays < 0) {
    return { class: 'expired', label: `Vencido (${formatDate(dateStr)})`, daysLeft: diffDays };
  } else if (diffDays <= 30) {
    return { class: 'warning', label: `Vence pronto: ${diffDays}d`, daysLeft: diffDays };
  } else {
    return { class: 'valid', label: `Al día (${formatDate(dateStr)})`, daysLeft: diffDays };
  }
}

// --- SEARCH ENGINE AND COLUMN HIGHLIGHTS ---

function toggleSearch(viewId) {
  const container = document.getElementById(`search-box-${viewId}`);
  if (!container) return;

  const toggleBtn = container.previousElementSibling.querySelector('.btn-search-toggle') || 
                    document.querySelector(`[onclick="toggleSearch('${viewId}')"]`);
  
  if (container.style.display === 'none') {
    container.style.display = 'block';
    const input = container.querySelector('.search-input');
    input.focus();
  } else {
    const input = container.querySelector('.search-input');
    if (input.value) {
      input.value = '';
      const viewElement = container.closest('.content-view, .widget-card');
      clearTableFilter(viewElement);
      
      const tables = viewElement.querySelectorAll('table');
      tables.forEach(table => {
        delete table.dataset.activeSearchCol;
        table.querySelectorAll('th').forEach(h => h.classList.remove('highlight-column-th'));
        table.querySelectorAll('td').forEach(d => d.classList.remove('highlight-column-td'));
      });
      
      if (toggleBtn) toggleBtn.classList.remove('active-filter');
    }
    container.style.display = 'none';
  }
}

function toggleSearch(id) {
  const btn   = document.getElementById(id + '-search-btn');
  const input = document.getElementById(id + '-search-input');
  if (!btn || !input) return;
  const opening = !btn.classList.contains('active');
  if (opening) {
    input.style.display = '';
    requestAnimationFrame(() => input.classList.add('open'));
    btn.classList.add('active');
    setTimeout(() => input.focus(), 50);
  } else {
    input.classList.remove('open');
    btn.classList.remove('active');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => { input.style.display = 'none'; }, 260);
  }
}

function toggleChoferesSearch() { toggleSearch('choferes'); }

function handleSearchKeydown(event, viewId) {
  if (event.key === 'Enter') {
    const input = event.target;
    const query = input.value;
    const container = document.getElementById(`search-box-${viewId}`);
    const viewElement = container.closest('.content-view, .widget-card');
    const toggleBtn = container.previousElementSibling.querySelector('.btn-search-toggle') || 
                      document.querySelector(`[onclick="toggleSearch('${viewId}')"]`);
    
    if (query) {
      filterTableData(viewElement, query);
      if (toggleBtn) toggleBtn.classList.add('active-filter');
    } else {
      clearTableFilter(viewElement);
      if (toggleBtn) toggleBtn.classList.remove('active-filter');
    }
  }
}

function filterTableData(viewElement, query) {
  const cleanQuery = query.toLowerCase().trim();
  const tables = viewElement.querySelectorAll('table');
  
  tables.forEach(table => {
    const colIndex = table.dataset.activeSearchCol !== undefined ? parseInt(table.dataset.activeSearchCol, 10) : null;
    const rows = table.querySelectorAll('tbody tr');
    
    rows.forEach(row => {
      if (row.cells.length <= 1 && row.cells[0]?.colSpan > 1) return; // Skip placeholders
      
      let textToMatch = '';
      if (colIndex !== null) {
        const cell = row.cells[colIndex];
        textToMatch = cell ? cell.innerText : '';
      } else {
        textToMatch = Array.from(row.cells).map(c => c.innerText).join(' ');
      }
      
      if (textToMatch.toLowerCase().includes(cleanQuery)) {
        row.style.display = '';
      } else {
        row.style.display = 'none';
      }
    });
  });
}

function clearTableFilter(viewElement) {
  const tables = viewElement.querySelectorAll('table');
  tables.forEach(table => {
    const rows = table.querySelectorAll('tbody tr');
    rows.forEach(row => {
      row.style.display = '';
    });
  });
}

function bindHeaderEvents() {
  document.querySelectorAll('.modern-table th').forEach(th => {
    if (th.dataset.bound) return;
    th.dataset.bound = "true";
    
    th.addEventListener('dblclick', () => {
      const cellIndex = th.cellIndex;
      const table = th.closest('table');
      const ths = table.querySelectorAll('th');
      
      const wasHighlighted = th.classList.contains('highlight-column-th');
      
      // Clear current highlights in this table
      ths.forEach(h => h.classList.remove('highlight-column-th'));
      table.querySelectorAll('td').forEach(d => d.classList.remove('highlight-column-td'));
      
      if (!wasHighlighted) {
        th.classList.add('highlight-column-th');
        
        // Highlight all matching cells in table rows
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(row => {
          const cell = row.cells[cellIndex];
          if (cell) cell.classList.add('highlight-column-td');
        });
        
        table.dataset.activeSearchCol = cellIndex;
      } else {
        delete table.dataset.activeSearchCol;
      }
      
      // Re-filter if search query is already typed
      const view = th.closest('.content-view, .widget-card');
      if (view) {
        const input = view.querySelector('.search-input');
        if (input && input.value) {
          filterTableData(view, input.value);
        }
      }
    });
  });
}

// ============================================================
// MÓDULO VEHÍCULOS — IA + R2
// ============================================================

// Archivos seleccionados para subir
const _pendingFiles = {};

function _bindDropzone(dropzoneId, fileInputId, previewId, key) {
  const dz = document.getElementById(dropzoneId);
  const fi = document.getElementById(fileInputId);
  if (!dz || !fi) return;

  fi.addEventListener('change', () => {
    const file = fi.files[0];
    if (!file) return;
    _pendingFiles[key] = file;
    if (previewId) {
      const prev = document.getElementById(previewId);
      if (prev) { prev.src = URL.createObjectURL(file); prev.style.display = 'block'; }
    }
    const label = dz.querySelector('small');
    if (label) label.textContent = file.name;
  });

  dz.addEventListener('dragover', e => { e.preventDefault(); dz.style.borderColor = 'var(--accent-purple)'; });
  dz.addEventListener('dragleave', () => { dz.style.borderColor = ''; });
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.style.borderColor = '';
    const file = e.dataTransfer.files[0];
    if (!file) return;
    _pendingFiles[key] = file;
    if (previewId) {
      const prev = document.getElementById(previewId);
      if (prev) { prev.src = URL.createObjectURL(file); prev.style.display = 'block'; }
    }
    const label = dz.querySelector('small');
    if (label) label.textContent = file.name;
  });
}

function initNewDropzones() {
  _bindDropzone('cedula-dropzone-frente', 'cedula-file-frente', 'cedula-preview-frente', 'cedula_frente');
  _bindDropzone('cedula-dropzone-dorso',  'cedula-file-dorso',  'cedula-preview-dorso',  'cedula_dorso');
  _bindDropzone('foto-drop-frente',   'foto-file-frente',   null, 'foto_frente');
  _bindDropzone('foto-drop-lat-der',  'foto-file-lat-der',  null, 'foto_lat_der');
  _bindDropzone('foto-drop-lat-izq',  'foto-file-lat-izq',  null, 'foto_lat_izq');
  _bindDropzone('foto-drop-detras',   'foto-file-detras',   null, 'foto_detras');
  // gnc-oblea-dropzone y seg-poliza-dropzone usan sus propios handlers
}

// ── Seguro: dropzone estándar con preview + overlay ───────────────────────────
function _segPreviewPoliza(file) {
  if (!file) return;
  _pendingFiles['seg_poliza'] = file;
  const dz      = document.getElementById('seg-poliza-dropzone');
  const prev    = document.getElementById('seg-poliza-prev');
  const eye     = document.getElementById('seg-poliza-eye');
  const pdfThumb = document.getElementById('seg-poliza-pdf-thumb');
  const pdfName  = document.getElementById('seg-poliza-pdf-name');
  const isPdf   = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (isPdf) {
    if (prev) { prev.src = ''; prev.style.display = 'none'; }
    if (pdfThumb) pdfThumb.style.display = 'flex';
    if (pdfName)  pdfName.textContent = file.name;
  } else if (file.type.startsWith('image/')) {
    if (pdfThumb) pdfThumb.style.display = 'none';
    if (prev) { prev.src = URL.createObjectURL(file); prev.style.display = 'block'; }
  }
  if (dz)  dz.classList.add('has-img');
  if (eye) eye.style.display = 'flex';
  const ocrBtn = document.querySelector('[id^="dz-ocr-seg-poliza"]');
  const aiBtn  = document.querySelector('[id^="dz-ai-seg-poliza"]');
  if (ocrBtn) ocrBtn.style.display = '';
  if (aiBtn)  aiBtn.style.display  = '';
  const st = document.getElementById('ai-seguro-status');
  if (st) st.textContent = `✓ ${file.name}`;
}
function _segClearPoliza() {
  _pendingFiles['seg_poliza'] = null;
  const dz      = document.getElementById('seg-poliza-dropzone');
  const prev    = document.getElementById('seg-poliza-prev');
  const eye     = document.getElementById('seg-poliza-eye');
  const inp     = document.getElementById('seg-file');
  const pdfThumb = document.getElementById('seg-poliza-pdf-thumb');
  if (dz)  dz.classList.remove('has-img');
  if (prev){ prev.src = ''; prev.style.display = 'none'; }
  if (pdfThumb) pdfThumb.style.display = 'none';
  if (eye) eye.style.display = 'none';
  if (inp) try { inp.value = ''; } catch(e) {}
  const st = document.getElementById('ai-seguro-status');
  if (st) st.textContent = '';
}
function _segOpenViewer() {
  const pending = _pendingFiles['seg_poliza'];
  if (pending) {
    const blobUrl = URL.createObjectURL(pending);
    const isPdf   = pending.type === 'application/pdf' || pending.name.toLowerCase().endsWith('.pdf');
    if (isPdf) openDocViewer(blobUrl, pending.name, true);
    else       openImgViewer(blobUrl, pending.name, null);
    return;
  }
  // post-save: buscar URL guardada
  const prev = document.getElementById('seg-poliza-prev');
  if (prev?.src && prev.src !== window.location.href) { openImgViewer(prev.src, 'Póliza de Seguro', null); return; }
  // intentar desde el campo hidden / dato del form
  const urlInput = document.getElementById('seg-poliza-url');
  if (urlInput?.value) { openDocViewer(urlInput.value, 'Póliza de Seguro'); }
}
function _segPolarDrop(e) {
  const file = e.dataTransfer?.files?.[0];
  if (file) _segPreviewPoliza(file);
}

// ── GNC: dropzone estándar con preview + overlay ──────────────────────────────
function _gncPreviewOblea(file) {
  if (!file) return;
  _pendingFiles['gnc_oblea'] = file;
  const dz   = document.getElementById('gnc-oblea-dropzone');
  const prev = document.getElementById('gnc-oblea-preview');
  const eye  = document.getElementById('gnc-oblea-eye');
  if (prev && file.type.startsWith('image/')) {
    prev.src = URL.createObjectURL(file);
    prev.style.display = 'block';
  } else if (prev && file.type === 'application/pdf') {
    prev.src = '';
    prev.style.display = 'none';
  }
  if (dz)  dz.classList.add('has-img');
  if (eye) eye.style.display = 'flex';
  const ocrBtn = document.querySelector('[id^="dz-ocr-gnc-oblea"]');
  const aiBtn  = document.querySelector('[id^="dz-ai-gnc-oblea"]');
  if (ocrBtn) ocrBtn.style.display = '';
  if (aiBtn)  aiBtn.style.display  = '';
  const st = document.getElementById('ai-gnc-status');
  if (st) { st.textContent = `✓ ${file.name}`; st.style.display = ''; }
}
function clearGncOblea() {
  _pendingFiles['gnc_oblea'] = null;
  const dz   = document.getElementById('gnc-oblea-dropzone');
  const prev = document.getElementById('gnc-oblea-preview');
  const eye  = document.getElementById('gnc-oblea-eye');
  const inp  = document.getElementById('gnc-file');
  if (dz)  dz.classList.remove('has-img');
  if (prev){ prev.src = ''; prev.style.display = 'none'; }
  if (eye) eye.style.display = 'none';
  if (inp) try { inp.value = ''; } catch(e) {}
  const st = document.getElementById('ai-gnc-status');
  if (st) st.textContent = '';
}
function handleGncObleaDrop(e) {
  const file = e.dataTransfer?.files?.[0];
  if (file) { _gncPreviewOblea(file); extractGncAI(); }
}

// Alias para los botones estáticos en HTML del vehículo
const extractCedulaAI  = () => extractVehiculoAI();
const extractCedulaOCR = () => extractVehiculoOCR();

async function extractVehiculoAI() {
  const btn = document.getElementById('vh-cedula-btn-ai') || document.getElementById('btn-extract-cedula-ai');
  const frente = _pendingFiles['cedula_frente'];
  if (!frente) { showAlert('Cargá al menos la imagen del frente de la cédula.'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Analizando…'; }
  try {
    const fd = new FormData();
    fd.append('frente', frente);
    if (_pendingFiles['cedula_dorso']) fd.append('dorso', _pendingFiles['cedula_dorso']);
    const res = await fetch('/api/ai/extract-cedula', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const d = await res.json();
    if (d.patente)               document.getElementById('vh-patente').value = d.patente;
    if (d.nro_motor || d.motor)  document.getElementById('vh-motor').value = d.nro_motor || d.motor;
    if (d.chasis || d.nro_chasis) document.getElementById('vh-chasis').value = d.chasis || d.nro_chasis;
    if (d.color)                 document.getElementById('vh-color').value = d.color;
    // Datos del titular extraídos de la cédula
    if (d.titular_nombre)    document.getElementById('vh-titular-nombre').value = d.titular_nombre;
    if (d.titular_dni)       document.getElementById('vh-titular-dni').value = d.titular_dni;
    if (d.titular_domicilio) document.getElementById('vh-titular-domicilio').value = d.titular_domicilio;
    // Autocompletar marca/modelo si viene
    if (d.marca) {
      const matchMarca = cachedMarcas.find(m => m.nombre.toUpperCase() === (d.marca||'').toUpperCase());
      if (matchMarca) {
        document.getElementById('vh-marca-input').value = matchMarca.nombre;
        document.getElementById('vh-marca').value = matchMarca.id;
        await loadModelosForMarca(matchMarca.id, null);
        if (d.modelo) {
          const modeloInput = document.getElementById('vh-modelo-input');
          const modeloHidden = document.getElementById('vh-modelo');
          if (modeloInput) modeloInput.value = d.modelo;
        }
      }
    }
    if (btn) btn.textContent = '✓ Datos cargados';
    const st = document.getElementById('ai-cedula-status');
    if (st) { st.textContent = '✓ Datos extraídos con IA'; st.style.display = ''; }
  } catch (err) {
    showAlert('Error IA: ' + err.message);
    if (btn) btn.textContent = 'Extraer con IA';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function extractGncAI() {
  const oblea = _pendingFiles['gnc_oblea'];
  if (!oblea) { showAlert('Cargá la imagen de la oblea primero.'); return; }
  const status = document.getElementById('ai-gnc-status');
  status.textContent = 'Analizando con IA…';
  try {
    const fd = new FormData();
    fd.append('oblea', oblea);
    const res = await fetch('/api/ai/extract-gnc', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const d = await res.json();
    let filled = 0;
    if (d.vigencia_desde) { document.getElementById('gnc-desde').value = d.vigencia_desde; filled++; }
    if (d.vigencia_hasta) { document.getElementById('gnc-hasta').value = d.vigencia_hasta; filled++; }
    if (d.numero_oblea)   { document.getElementById('gnc-numero-oblea').value = d.numero_oblea; filled++; }
    // Regulador: combinar marca + serie
    const regLabel = [d.regulador_marca, d.regulador_serie].filter(Boolean).join(' — ') || d.regulador || '';
    if (regLabel) { document.getElementById('gnc-regulador').value = regLabel; filled++; }
    // Cilindros
    const cils = Array.isArray(d.cilindros) ? d.cilindros : [];
    if (cils.length > 1) {
      const extra = document.getElementById('gnc-cil-extra');
      if (extra) extra.style.display = 'block';
      const btn = document.getElementById('gnc-add-cil-btn');
      if (btn) btn.innerHTML = '<i class="fa-solid fa-minus"></i> Menos cilindros';
    }
    cils.forEach((c, i) => {
      const n = i + 1;
      if (n > 4) return;
      const mEl = document.getElementById(`gnc-cil${n}-marca`);
      const sEl = document.getElementById(`gnc-cil${n}-serie`);
      const vEl = document.getElementById(`gnc-cil${n}-vto`);
      if (mEl && c.marca) { mEl.value = c.marca; filled++; }
      if (sEl && c.serie) { sEl.value = c.serie; filled++; }
      if (vEl && c.vto)   { vEl.value = c.vto;   filled++; }
    });
    status.textContent = filled > 0 ? `✓ ${filled} datos extraídos` : '⚠ No se encontraron datos';
  } catch (err) {
    status.textContent = _aiErrorMsg(err);
  }
}

async function extractSeguroAI() {
  const poliza = _pendingFiles['seg_poliza'];
  if (!poliza) { showAlert('Cargá el archivo de la póliza primero.'); return; }
  const status = document.getElementById('ai-seguro-status');
  status.textContent = 'Analizando…';
  try {
    const fd = new FormData();
    fd.append('poliza', poliza);
    const res = await fetch('/api/ai/extract-seguro', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const d = await res.json();
    if (d.vigencia_desde) document.getElementById('seg-desde').value = d.vigencia_desde;
    if (d.vigencia_hasta) document.getElementById('seg-hasta').value = d.vigencia_hasta;
    if (d.nro_poliza)     document.getElementById('seg-poliza').value = d.nro_poliza;
    if (d.compania) {
      document.getElementById('seg-compania-input').value = d.compania;
      // Intentar match en lista cacheada
      const match = (window._aseguradoras || []).find(a => a.nombre.toLowerCase() === d.compania.toLowerCase());
      if (match) {
        document.getElementById('seg-compania-id').value = match.id;
      } else {
        document.getElementById('seg-compania-id').value = '';
      }
    }
    status.textContent = '✓ Datos extraídos';
  } catch (err) {
    status.textContent = _aiErrorMsg(err);
  }
}

// Contactos alternativos
function addContactoAlt() {
  const list = document.getElementById('contactos-alternativos-list');
  const idx = list.children.length;
  const div = document.createElement('div');
  div.className = 'contacto-alt-row';
  div.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;margin-bottom:8px;align-items:center;';
  div.innerHTML = `
    <input type="text" placeholder="Nombre *" class="ca-nombre" style="padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:13px;">
    <input type="tel" placeholder="Celular" class="ca-celular" style="padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:13px;">
    <input type="email" placeholder="Email" class="ca-email" style="padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:13px;">
    <button type="button" onclick="this.closest('.contacto-alt-row').remove()" style="background:var(--accent-red,#e53e3e);border:none;color:#fff;border-radius:6px;padding:6px 10px;cursor:pointer;"><i class="fa-solid fa-trash"></i></button>
  `;
  list.appendChild(div);
}

// Aseguradoras searchable
window._aseguradoras = [];

async function loadAseguradorasCache() {
  try {
    const res = await fetch('/api/aseguradoras');
    window._aseguradoras = await res.json();
  } catch (e) {}
}

function filterAseguradoras(query) {
  const drop = document.getElementById('seg-compania-dropdown');
  if (!drop) return;
  const q = query.toLowerCase().trim();
  const filtered = q ? window._aseguradoras.filter(a => a.nombre.toLowerCase().includes(q)) : window._aseguradoras;
  drop.innerHTML = '';
  if (!q && !filtered.length) { drop.style.display = 'none'; return; }

  // Option to create new if not exact match
  const exactMatch = window._aseguradoras.some(a => a.nombre.toLowerCase() === q);
  if (q && !exactMatch) {
    const opt = document.createElement('div');
    opt.style.cssText = 'padding:8px 12px;cursor:pointer;color:var(--accent-purple);font-weight:600;font-size:13px;';
    opt.textContent = `+ Crear "${query}"`;
    opt.onmousedown = async () => {
      const res = await fetch('/api/aseguradoras', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: query }) });
      const data = await res.json();
      window._aseguradoras.push({ id: data.id, nombre: query });
      document.getElementById('seg-compania-input').value = query;
      document.getElementById('seg-compania-id').value = data.id;
      drop.style.display = 'none';
    };
    drop.appendChild(opt);
  }

  filtered.slice(0, 8).forEach(a => {
    const opt = document.createElement('div');
    opt.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:13px;color:var(--text-primary);';
    opt.textContent = a.nombre;
    opt.onmouseover = () => opt.style.background = 'var(--bg-tertiary)';
    opt.onmouseleave = () => opt.style.background = '';
    opt.onmousedown = () => {
      document.getElementById('seg-compania-input').value = a.nombre;
      document.getElementById('seg-compania-id').value = a.id;
      drop.style.display = 'none';
    };
    drop.appendChild(opt);
  });

  drop.style.display = drop.children.length ? 'block' : 'none';
}

function hideAseguradorasDrop() {
  setTimeout(() => {
    const drop = document.getElementById('seg-compania-dropdown');
    if (drop) drop.style.display = 'none';
  }, 200);
}

function gncToggleExtraCil() {
  const extra = document.getElementById('gnc-cil-extra');
  const btn   = document.getElementById('gnc-add-cil-btn');
  if (!extra) return;
  const show = extra.style.display === 'none';
  extra.style.display = show ? 'block' : 'none';
  if (btn) btn.innerHTML = show
    ? '<i class="fa-solid fa-minus"></i> Menos cilindros'
    : '<i class="fa-solid fa-plus"></i> Agregar cilindro';
}

function gncClearCilindros() {
  for (let i = 1; i <= 4; i++) {
    const m = document.getElementById(`gnc-cil${i}-marca`);
    const s = document.getElementById(`gnc-cil${i}-serie`);
    const v = document.getElementById(`gnc-cil${i}-vto`);
    if (m) m.value = '';
    if (s) s.value = '';
    if (v) v.value = '';
  }
  const extra = document.getElementById('gnc-cil-extra');
  if (extra) extra.style.display = 'none';
  const btn = document.getElementById('gnc-add-cil-btn');
  if (btn) btn.innerHTML = '<i class="fa-solid fa-plus"></i> Agregar cilindro';
}

// Override saveGNC para usar endpoint con upload
async function saveGNC(e) {
  e.preventDefault();
  if (!activeVehiculoId) return;

  const fd = new FormData();
  fd.append('vigencia_desde', document.getElementById('gnc-desde').value);
  fd.append('vigencia_hasta', document.getElementById('gnc-hasta').value);
  const numOblea = document.getElementById('gnc-numero-oblea')?.value;
  const regulador = document.getElementById('gnc-regulador')?.value;
  if (numOblea) fd.append('numero_oblea', numOblea);
  if (regulador) fd.append('regulador', regulador);
  if (_pendingFiles['gnc_oblea']) fd.append('oblea', _pendingFiles['gnc_oblea']);

  // Cilindros
  for (let i = 1; i <= 4; i++) {
    const m = document.getElementById(`gnc-cil${i}-marca`)?.value || '';
    const s = document.getElementById(`gnc-cil${i}-serie`)?.value || '';
    const v = document.getElementById(`gnc-cil${i}-vto`)?.value   || '';
    if (m || s || v) {
      fd.append(`cil${i}_marca`, m);
      fd.append(`cil${i}_serie`, s);
      fd.append(`cil${i}_vto`,   v);
    }
  }

  try {
    const res = await fetch(`/api/vehiculos/${activeVehiculoId}/gnc-upload`, { method: 'POST', body: fd });
    if (res.ok) {
      showAlert('¡GNC guardado con éxito!', 'success');
      delete _pendingFiles['gnc_oblea'];
      document.getElementById('ai-gnc-status').textContent = '';
      document.getElementById('form-gnc').reset();
      gncClearCilindros();
      loadVehiculoGNCHistory(activeVehiculoId);
      loadVehiculos();
    } else {
      const err = await res.json();
      showAlert(`Error: ${err.message}`);
    }
  } catch (err) {
    showAlert('Error al guardar GNC.', 'error', 'error');
  }
}

// Override saveSeguro para usar endpoint con upload + aseguradora dinámica
async function saveSeguro(e) {
  e.preventDefault();
  if (!activeVehiculoId) return;

  const compInput = document.getElementById('seg-compania-input');
  const compId = document.getElementById('seg-compania-id');

  const fd = new FormData();
  if (compId?.value) fd.append('aseguradora_id', compId.value);
  else if (compInput?.value) fd.append('aseguradora_nombre', compInput.value);
  fd.append('nro_poliza', document.getElementById('seg-poliza').value);
  fd.append('vigencia_desde', document.getElementById('seg-desde').value);
  fd.append('vigencia_hasta', document.getElementById('seg-hasta').value);
  if (_pendingFiles['seg_poliza']) fd.append('poliza', _pendingFiles['seg_poliza']);

  try {
    const res = await fetch(`/api/vehiculos/${activeVehiculoId}/seguros-upload`, { method: 'POST', body: fd });
    if (res.ok) {
      const data = await res.json();
      showAlert('¡Seguro guardado con éxito!', 'success');
      delete _pendingFiles['seg_poliza'];
      document.getElementById('ai-seguro-status').textContent = '';
      document.getElementById('form-seguro').reset();
      if (compInput) compInput.value = '';
      if (compId) compId.value = '';
      loadVehiculoSegurosHistory(activeVehiculoId);
      loadVehiculos();
      // Actualizar caché de aseguradoras
      if (data.aseguradora_id) loadAseguradorasCache();
    } else {
      const err = await res.json();
      showAlert(`Error: ${err.message}`);
    }
  } catch (err) {
    showAlert('Error al guardar Seguro.', 'error', 'error');
  }
}

// Upload fotos + cedulas al guardar vehículo (llamado después de crear/editar)
async function uploadVehiculoFiles(vehiculoId) {
  const fileKeys = ['cedula_frente','cedula_dorso','foto_frente','foto_lat_der','foto_lat_izq','foto_detras'];
  const hasFiles = fileKeys.some(k => _pendingFiles[k]);
  const titEmail = document.getElementById('vh-titular-email')?.value;
  const titCel = document.getElementById('vh-titular-celular')?.value;

  if (!hasFiles && !titEmail && !titCel) return;

  const fd = new FormData();
  fileKeys.forEach(k => { if (_pendingFiles[k]) fd.append(k, _pendingFiles[k]); });
  if (titEmail) fd.append('titular_email', titEmail);
  if (titCel) fd.append('titular_celular', titCel);

  try {
    await fetch(`/api/vehiculos/${vehiculoId}/fotos`, { method: 'POST', body: fd });
    fileKeys.forEach(k => delete _pendingFiles[k]);
  } catch (e) {}
}

// Guardar contactos alternativos
async function saveContactosAlternativos(vehiculoId) {
  const rows = document.querySelectorAll('#contactos-alternativos-list .contacto-alt-row');
  for (const row of rows) {
    const nombre = row.querySelector('.ca-nombre')?.value?.trim();
    const celular = row.querySelector('.ca-celular')?.value?.trim();
    const email = row.querySelector('.ca-email')?.value?.trim();
    if (!nombre) continue;
    await fetch(`/api/vehiculos/${vehiculoId}/contactos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, celular, email })
    });
  }
}

// ============================================================
// ALERTAS DE VENCIMIENTO — módulo consolidado (VTV, Seguro, GNC,
// Registro de conductor, Service por KM proyectado)
// ============================================================
const _ALERTA_TIPO_LABEL = { vtv: 'VTV', seguro: 'Seguro', gnc: 'GNC', registro: 'Registro', service: 'Service', afip_cert: 'Cert AFIP', multa: 'MULTA' };
const _ALERTA_TIPO_ICON  = { vtv: 'fa-clipboard-check', seguro: 'fa-shield-halved', gnc: 'fa-gas-pump', registro: 'fa-id-card', service: 'fa-screwdriver-wrench', afip_cert: 'fa-file-certificate', multa: 'fa-triangle-exclamation' };

// Texto + estado visual para una alerta, según días restantes (o falta de dato para Service)
function _alertaEstado(a) {
  if (a.dias == null) {
    const msg = a.sinDato === 'sin_km_actual'
      ? 'Sin datos de KM actual (cargá un Turno con Km Fin)'
      : a.sinDato === 'sin_promedio_km'
        ? 'Sin historial de KM reciente para estimar'
        : 'Sin fecha estimada';
    return { texto: msg, clase: 'ok', color: 'var(--text-secondary)', orden: 3 };
  }
  if (a.dias < 0)  return { texto: `Vencido hace ${Math.abs(a.dias)} día${Math.abs(a.dias)===1?'':'s'}`, clase: 'vencido', color: 'var(--color-error)', orden: 0 };
  if (a.dias <= 30) return { texto: `Vence en ${a.dias} día${a.dias===1?'':'s'}`, clase: 'proximo', color: '#c96a00', orden: 1 };
  return { texto: `Vence en ${a.dias} días`, clase: 'ok', color: 'var(--color-success)', orden: 2 };
}

function _alertaDetalleLinea(a) {
  const quien = a.tipo === 'registro' ? a.chofer_nombre : a.patente;
  let extra = '';
  if (a.tipo === 'service' && a.km_proximo != null) {
    extra = a.km_actual != null
      ? ` · ${Math.round(a.km_actual).toLocaleString('en-US')} km actual / ${Math.round(a.km_proximo).toLocaleString('en-US')} km próximo`
      : ` · próximo a los ${Math.round(a.km_proximo).toLocaleString('en-US')} km`;
  }
  return `<strong>${quien}</strong> — ${a.detalle}${extra}`;
}

let _cachedAlertas = [];

// Widget compacto en el Dashboard — top alertas más urgentes
async function loadAlertasWidget() {
  const container = document.getElementById('alertas-widget');
  if (!container) return;
  try {
    const res = await fetch('/api/alertas/consolidado');
    const alertas = await res.json();
    _cachedAlertas = alertas;
    const top = alertas.filter(a => a.dias != null).slice(0, 6);
    if (!top.length) { container.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;">Sin alertas pendientes.</p>'; return; }
    container.innerHTML = top.map(a => {
      const est = _alertaEstado(a);
      return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;margin-bottom:6px;background:var(--bg-tertiary);border-radius:8px;border-left:3px solid ${est.color};">
        <span style="font-size:13px;">${_alertaDetalleLinea(a)}</span>
        <span style="font-size:12px;font-weight:600;color:${est.color};white-space:nowrap;margin-left:10px;">${est.texto}</span>
      </div>
    `;
    }).join('');
  } catch (e) {}
}

async function loadAlertasModulo() {
  const body = document.getElementById('alertas-modulo-body');
  if (!body) return;
  body.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;">Cargando alertas…</p>';
  try {
    const res = await fetch('/api/alertas/consolidado');
    _cachedAlertas = await res.json();
    // Poblar select de vehículos con las patentes presentes en las alertas
    const sel = document.getElementById('alertas-filter-vehiculo');
    if (sel) {
      const patentes = [...new Set(_cachedAlertas.map(a => a.patente).filter(Boolean))].sort();
      sel.innerHTML = '<option value="">-- Todos --</option>' +
        patentes.map(p => `<option value="${p}">${p}</option>`).join('');
    }
    renderAlertasModulo();
  } catch (e) {
    body.innerHTML = `<p style="color:var(--color-error);font-size:13px;">Error al cargar alertas: ${e.message}</p>`;
  }
}

function clearAlertasFilters() {
  _clearSelect('alertas-filter-tipo');
  _clearSelect('alertas-filter-estado');
  _clearSelect('alertas-filter-vehiculo');
  ['alertas-filter-desde','alertas-filter-hasta'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const sInp = document.getElementById('alertas-search-input');
  if (sInp && sInp.value) { sInp.value = ''; if (document.getElementById('alertas-search-btn')?.classList.contains('active')) toggleSearch('alertas'); }
  renderAlertasModulo();
}

function _alertaWaTexto(a) {
  const fv = a.fecha_vencimiento ? new Date(a.fecha_vencimiento).toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric'}) : null;
  const label = _ALERTA_TIPO_LABEL[a.tipo] || a.tipo;
  if (a.tipo === 'registro') return `Hola ${a.chofer_nombre}, te recordamos que tu Registro de Conductor vence el ${fv}. Por favor renovalo a tiempo. Gracias.`;
  if (a.tipo === 'vtv')     return `Recordatorio: la VTV del vehículo ${a.patente} vence el ${fv}. Coordinar turno.`;
  if (a.tipo === 'seguro')  return `Recordatorio: el Seguro del vehículo ${a.patente} vence el ${fv}. Coordinar renovación.`;
  if (a.tipo === 'gnc')     return `Recordatorio: la habilitación GNC del vehículo ${a.patente} vence el ${fv}. Coordinar renovación.`;
  if (a.tipo === 'multa')   return `Atención: multa del vehículo ${a.patente} — ${a.detalle}. Vence el ${fv}. Proceder al pago.`;
  return `Recordatorio: ${label} — ${a.detalle}${fv ? ` vence el ${fv}` : ''}.`;
}

async function _alertaEnviarWA(a) {
  if (a.tipo === 'multa' && a.multa_id) {
    if (!_cachedMultas.find(x => x.id === a.multa_id)) {
      const data = await fetch('/api/multas').then(r => r.json()).catch(() => []);
      if (Array.isArray(data.data || data)) _cachedMultas = data.data || data;
    }
    enviarMultaWA(a.multa_id);
  } else if (a.wa_numero) {
    window.open(`https://wa.me/${a.wa_numero}?text=${encodeURIComponent(_alertaWaTexto(a))}`, '_blank');
  }
}

async function _alertaVerRegistro(a) {
  if (a.tipo === 'multa' && a.multa_id) {
    if (!_cachedMultas.find(x => x.id === a.multa_id)) {
      const data = await fetch('/api/multas').then(r => r.json()).catch(() => []);
      if (Array.isArray(data.data || data)) _cachedMultas = data.data || data;
    }
    editMulta(a.multa_id);
  } else if (a.tipo === 'registro' && a.chofer_id) {
    if (!cachedChoferes.find(x => x.id === a.chofer_id)) {
      cachedChoferes = await fetch('/api/choferes').then(r => r.json()).catch(() => []);
    }
    editChofer(a.chofer_id);
  } else if (a.vehiculo_id) {
    if (!cachedVehiculos.find(x => x.id === a.vehiculo_id)) {
      cachedVehiculos = await fetch('/api/vehiculos').then(r => r.json()).catch(() => []);
    }
    editVehiculo(a.vehiculo_id);
  }
}

function exportAlertasXLS() {
  const list = _lastAlertasList || [];
  if (!list.length) { alert('No hay alertas para exportar.'); return; }
  const rows = list.map(a => {
    const est = _alertaEstado(a);
    const fv = a.fecha_vencimiento ? new Date(a.fecha_vencimiento).toLocaleDateString('es-AR') : '';
    return {
      Tipo: _ALERTA_TIPO_LABEL[a.tipo] || a.tipo,
      Detalle: a.detalle || '',
      Patente: a.patente || '',
      Chofer: a.chofer_nombre || '',
      'Fecha venc.': fv,
      Estado: est.texto,
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Alertas');
  const now = new Date();
  const fecha = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const hora  = `${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
  XLSX.writeFile(wb, `Alertas_${fecha}_${hora}.xlsx`);
}

function enviarWaMasivoAlertas() {
  const list = (_lastAlertasList || []).filter(a => a.wa_numero);
  if (!list.length) { alert('No hay alertas con número de WhatsApp en el filtro actual.'); return; }
  if (!confirm(`Vas a abrir ${list.length} chat(s) de WhatsApp. ¿Continuar?`)) return;
  list.forEach((a, i) => {
    setTimeout(() => {
      window.open(`https://wa.me/${a.wa_numero}?text=${encodeURIComponent(_alertaWaTexto(a))}`, '_blank');
    }, i * 600);
  });
}

let _lastAlertasList = [];

function renderAlertasModulo() {
  const body = document.getElementById('alertas-modulo-body');
  if (!body) return;
  const tipoF     = document.getElementById('alertas-filter-tipo')?.value || '';
  const estadoF   = document.getElementById('alertas-filter-estado')?.value || '';
  const vehiculoF = document.getElementById('alertas-filter-vehiculo')?.value || '';
  const desdeF    = document.getElementById('alertas-filter-desde')?.value || '';
  const hastaF    = document.getElementById('alertas-filter-hasta')?.value || '';
  const qF        = (document.getElementById('alertas-search-input')?.value || '').toLowerCase().trim();

  let list = _cachedAlertas.slice();
  if (tipoF)     list = list.filter(a => a.tipo === tipoF);
  if (estadoF)   list = list.filter(a => _alertaEstado(a).clase === estadoF || (estadoF === 'ok' && a.dias == null));
  if (vehiculoF) list = list.filter(a => a.patente === vehiculoF);
  if (qF)        list = list.filter(a => {
    const hay = [a.patente, a.chofer_nombre, a.detalle, a.tipo].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(qF);
  });
  if (desdeF || hastaF) {
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    list = list.filter(a => {
      if (a.dias == null) return false; // sin fecha estimada, no se puede ubicar en el rango
      const fechaEstimada = new Date(hoy.getTime() + a.dias * 86400000);
      if (desdeF && fechaEstimada < new Date(desdeF)) return false;
      if (hastaF && fechaEstimada > new Date(hastaF)) return false;
      return true;
    });
  }

  _lastAlertasList = list;

  if (!list.length) {
    body.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;text-align:center;padding:24px;">Sin alertas para este filtro.</p>';
    return;
  }

  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${list.map((a, idx) => {
        const est = _alertaEstado(a);
        const fv = a.fecha_vencimiento ? new Date(a.fecha_vencimiento).toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric'}) : '—';
        return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:var(--bg-tertiary);border-radius:10px;border-left:4px solid ${est.color};">
          <div style="display:flex;align-items:center;gap:12px;">
            <i class="fa-solid ${_ALERTA_TIPO_ICON[a.tipo]||'fa-bell'}" style="font-size:18px;color:${est.color};width:22px;text-align:center;"></i>
            <div>
              <div style="font-size:14px;">${_alertaDetalleLinea(a)}</div>
              <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.03em;">${_ALERTA_TIPO_LABEL[a.tipo]||a.tipo}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-left:10px;flex-shrink:0;">
            <span style="font-size:12px;color:var(--text-secondary);white-space:nowrap;">${fv}</span>
            <span style="font-size:13px;font-weight:700;color:${est.color};white-space:nowrap;min-width:130px;text-align:right;">${est.texto}</span>
            <div style="display:flex;gap:4px;">
              <button onclick="_alertaVerRegistro(_lastAlertasList[${idx}])" class="tbl-action-btn tbl-btn-view" title="Ver registro"><i class="fa-solid fa-eye"></i></button>
              ${(a.wa_numero || a.tipo === 'multa')
                ? `<button onclick="_alertaEnviarWA(_lastAlertasList[${idx}])" class="tbl-action-btn" style="background:var(--color-whatsapp,#25d366);color:#fff;" title="Enviar por WhatsApp"><i class="fa-brands fa-whatsapp"></i></button>`
                : `<button class="tbl-action-btn" disabled style="opacity:.3;cursor:default;" title="Sin número de WhatsApp"><i class="fa-brands fa-whatsapp"></i></button>`
              }
            </div>
          </div>
        </div>
      `;
      }).join('')}
    </div>`;
}

// ============================================================
// MÓDULO CHOFERES — Documentos DNI + Registro
// ============================================================

const _choferFiles = {};

function _bindChoferDrop(dropId, fileId, prevId, key) {
  const dz = document.getElementById(dropId);
  const fi = document.getElementById(fileId);
  if (!dz || !fi) return;

  const setFile = (file) => {
    _choferFiles[key] = file;
    const prev = document.getElementById(prevId);
    if (prev) { prev.src = URL.createObjectURL(file); prev.style.display = 'block'; }
    const sm = dz.querySelector('small');
    if (sm) sm.textContent = file.name;
  };

  fi.addEventListener('change', () => { if (fi.files[0]) setFile(fi.files[0]); });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.style.borderColor = 'var(--accent-purple)'; });
  dz.addEventListener('dragleave', () => { dz.style.borderColor = ''; });
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.style.borderColor = '';
    if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });
}

function initChoferDropzones() {
  _bindChoferDrop('ch-drop-dni-frente', 'ch-file-dni-frente', 'ch-prev-dni-frente', 'dni_frente');
  _bindChoferDrop('ch-drop-dni-dorso',  'ch-file-dni-dorso',  'ch-prev-dni-dorso',  'dni_dorso');
  _bindChoferDrop('ch-drop-reg-frente', 'ch-file-reg-frente', 'ch-prev-reg-frente', 'reg_frente');
  _bindChoferDrop('ch-drop-reg-dorso',  'ch-file-reg-dorso',  'ch-prev-reg-dorso',  'reg_dorso');
  // Habilitar/deshabilitar botón IA según API key
  const btnAI = document.getElementById('chofer-btn-ai');
  if (btnAI) { btnAI.disabled = !_aiAvailable; if (!_aiAvailable) btnAI.title = 'Requiere ANTHROPIC_API_KEY'; }
}

// ── Helpers para dropzones con imagen-arriba (Chofer + Vehículo) ──────────────

// Mapa key: input id → _choferFiles key
const _CHOFER_FILE_KEYS = {
  'ch-file-dni-frente': 'dni_frente',
  'ch-file-dni-dorso':  'dni_dorso',
  'ch-file-reg-frente': 'reg_frente',
  'ch-file-reg-dorso':  'reg_dorso',
  'ch-file-calif1':     'calif1',
  'ch-file-calif2':     'calif2',
};

function previewChoferDoc(input, prevId, dzId, eyeId) {
  if (!input.files[0]) return;
  const file = input.files[0];
  // Actualizar _choferFiles directamente (no depender solo de _bindChoferDrop)
  const key = _CHOFER_FILE_KEYS[input.id];
  if (key) _choferFiles[key] = file;
  // Preview imagen arriba
  const img = document.getElementById(prevId);
  if (img) { img.src = URL.createObjectURL(file); img.style.display = 'block'; }
  // Clase has-img en dropzone
  const dz = document.getElementById(dzId);
  if (dz) dz.classList.add('has-img');
  // Mostrar botón ojo
  const eye = document.getElementById(eyeId);
  if (eye) eye.style.display = 'flex';
  // Intentar leer QR / PDF417 del DNI automáticamente (solo DNI frente)
  if (input.id === 'ch-file-dni-frente') {
    _tryReadDNIBarcode(file);
  }
}

// ── Lectura automática de código de barras / QR del DNI argentino ─────────────
// El DNI argentino lleva un PDF417 (2D barcode) con toda la info personal.
// Formato del string decodificado: @APELLIDO@NOMBRE@SEXO@NRO@EJEMPLAR@FEC_NAC@FEC_EMI@...
async function _tryReadDNIBarcode(file) {
  const status = document.getElementById('ch-ocr-status');
  // Nota: el QR/PDF417 solo existe en el DNI (cédula de identidad), NO en el Registro de Conducir
  if (!('BarcodeDetector' in window)) {
    if (status) {
      status.textContent = 'ℹ️ Lectura de código QR/barras no disponible en este navegador — usá OCR o IA para completar';
      status.style.color = 'var(--text-secondary)';
    }
    return;
  }
  try {
    const detector = new BarcodeDetector({ formats: ['pdf417', 'qr_code', 'data_matrix', 'aztec'] });
    const bitmap = await createImageBitmap(file);
    const codes = await detector.detect(bitmap);
    if (!codes.length) {
      if (status) {
        status.textContent = 'ℹ️ No se detectó código QR/barras en el DNI — usá el botón OCR para extraer los datos';
        status.style.color = 'var(--text-secondary)';
      }
      return;
    }
    const raw = codes[0].rawValue || '';
    _parseDNIBarcode(raw);
  } catch (e) {
    console.warn('BarcodeDetector error:', e);
    if (status) {
      status.textContent = 'ℹ️ Error al leer código del DNI — usá OCR o IA';
      status.style.color = 'var(--text-secondary)';
    }
  }
}

function _parseDNIBarcode(raw) {
  if (!raw) return;
  // Formato estándar RENAPER: @APELLIDO@NOMBRE@SEXO@DNI@TRAMITE@FEC_NAC@FEC_EMI@[extras]
  // Algunos tienen "@" al principio, otros no.
  let parts = raw.replace(/^@/, '').split('@');
  if (parts.length < 5) return; // no parece DNI argentino

  // Formato RENAPER: partes[0]=APELLIDO, [1]=NOMBRE, [2]=SEXO, [3]=DNI, [4]=TRAMITE, [5]=FEC_NAC, [6]=FEC_EMI
  const apellido  = (parts[0] || '').trim();
  const nombre    = (parts[1] || '').trim();
  const nroDNI    = (parts[3] || '').replace(/\D/g, '');
  const fechaNac  = (parts[5] || '').trim();  // DD/MM/AAAA

  let filled = 0;
  const setVal = (id, val) => {
    if (!val) return;
    const el = document.getElementById(id);
    if (el) { el.value = val; filled++; }
  };

  // El form tiene un solo campo "ch-nombre" que guarda nombre completo
  const nombreCompleto = apellido && nombre ? `${nombre} ${apellido}` : (apellido || nombre);
  setVal('ch-nombre', nombreCompleto);
  setVal('ch-dni',    nroDNI);

  // Fecha de nacimiento: DD/MM/AAAA → AAAA-MM-DD
  if (fechaNac) {
    const m = fechaNac.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) setVal('ch-nacimiento', `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);
  }

  if (filled > 0) {
    const status = document.getElementById('ch-ocr-status');
    if (status) status.textContent = `✓ Código del DNI leído automáticamente — ${filled} campos completados`;
    console.log('[DNI Barcode]', { apellido, nombre, nroDNI, fechaNac });
  }
}

// Eliminar foto de un slot — limpia preview, estado y archivo
// Slots de documentos de chofer que fueron borrados explícitamente en esta sesión
const _clearedChoferSlots = new Set();

function clearDzSlot(dzId, inputId, prevId, eyeId, fileKey) {
  // Preview
  const img = document.getElementById(prevId);
  if (img) { img.src = ''; img.style.display = 'none'; }
  // Dropzone state
  const dz = document.getElementById(dzId);
  if (dz) dz.classList.remove('has-img');
  // Botón ojo
  const eye = document.getElementById(eyeId);
  if (eye) eye.style.display = 'none';
  // File input
  const inp = document.getElementById(inputId);
  if (inp) { try { inp.value = ''; } catch(e) {} }
  // _choferFiles
  if (fileKey && _choferFiles[fileKey]) delete _choferFiles[fileKey];
  // _pendingFiles (vehículo)
  if (fileKey && _pendingFiles[fileKey]) delete _pendingFiles[fileKey];
  // Marcar que este slot fue borrado explícitamente (para persistir __CLEAR__ al guardar)
  const choferDocKeys = new Set(['dni_frente','dni_dorso','reg_frente','reg_dorso','calif1','calif2']);
  if (fileKey && choferDocKeys.has(fileKey)) _clearedChoferSlots.add(fileKey);
}

function handleChoferDocDrop(event, inputId, prevId, dzId) {
  event.preventDefault();
  const dz = event.currentTarget;
  dz.classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.getElementById(inputId);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// Cámara unificada para Chofer — rellena el primer slot vacío
const _CHOFER_DOC_SLOTS = [
  { inputId: 'ch-file-dni-frente', prevId: 'ch-prev-dni-frente', dzId: 'ch-drop-dni-frente', key: 'dni_frente' },
  { inputId: 'ch-file-dni-dorso',  prevId: 'ch-prev-dni-dorso',  dzId: 'ch-drop-dni-dorso',  key: 'dni_dorso' },
  { inputId: 'ch-file-reg-frente', prevId: 'ch-prev-reg-frente', dzId: 'ch-drop-reg-frente', key: 'reg_frente' },
  { inputId: 'ch-file-reg-dorso',  prevId: 'ch-prev-reg-dorso',  dzId: 'ch-drop-reg-dorso',  key: 'reg_dorso' },
];
let _choferCamSlot = null;

function openChoferDocCamera() {
  // Busca primer slot vacío; si todos llenos, usa el primero
  _choferCamSlot = _CHOFER_DOC_SLOTS.find(s => !_choferFiles[s.key]) || _CHOFER_DOC_SLOTS[0];
  openCamera(_choferCamSlot.inputId);
}

// Helper genérico: preview imagen arriba
function previewVhDoc(input, prevId, dzId, eyeId) {
  if (!input.files[0]) return;
  const file = input.files[0];
  const img = document.getElementById(prevId);
  const dz  = document.getElementById(dzId);
  if (img) { img.src = URL.createObjectURL(file); img.style.display = 'block'; }
  if (dz)  { dz.classList.add('has-img'); }
  // Mostrar botón ojo
  const eye = eyeId ? document.getElementById(eyeId) : null;
  if (eye) eye.style.display = 'flex';
  // También actualizar _pendingFiles si es cédula o foto
  const pendingMap = {
    'cedula-file-frente': 'cedula_frente',
    'cedula-file-dorso':  'cedula_dorso',
    'foto-file-frente':   'foto_frente',
    'foto-file-lat-der':  'foto_lat_der',
    'foto-file-lat-izq':  'foto_lat_izq',
    'foto-file-detras':   'foto_detras',
  };
  const pk = pendingMap[input.id];
  if (pk) _pendingFiles[pk] = file;
}

function handleVhCedulaDrop(event, inputId, prevId, dzId) {
  event.preventDefault();
  const dz = event.currentTarget;
  dz.classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.getElementById(inputId);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  previewVhDoc(input, prevId, dzId);
}

function handleVhFotoDrop(event, inputId, prevId, dzId) {
  event.preventDefault();
  const dz = event.currentTarget;
  dz.classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.getElementById(inputId);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  previewVhDoc(input, prevId, dzId);
}

// Cámara unificada para Cédula Vehículo — primer slot vacío
const _VH_CEDULA_SLOTS = [
  { inputId: 'cedula-file-frente', prevId: 'cedula-preview-frente', dzId: 'cedula-dropzone-frente' },
  { inputId: 'cedula-file-dorso',  prevId: 'cedula-preview-dorso',  dzId: 'cedula-dropzone-dorso' },
];

function openVhCedulaCamera() {
  const slot = _VH_CEDULA_SLOTS.find(s => {
    const inp = document.getElementById(s.inputId);
    return !inp || !inp.files[0];
  }) || _VH_CEDULA_SLOTS[0];
  openCamera(slot.inputId);
}

// Cámara unificada para Fotos Vehículo — primer slot vacío
const _VH_FOTO_SLOTS = [
  { inputId: 'foto-file-frente',   prevId: 'foto-preview-frente',   dzId: 'foto-drop-frente' },
  { inputId: 'foto-file-lat-der',  prevId: 'foto-preview-lat-der',  dzId: 'foto-drop-lat-der' },
  { inputId: 'foto-file-lat-izq',  prevId: 'foto-preview-lat-izq',  dzId: 'foto-drop-lat-izq' },
  { inputId: 'foto-file-detras',   prevId: 'foto-preview-detras',   dzId: 'foto-drop-detras' },
];

function openVhFotoCamera() {
  const slot = _VH_FOTO_SLOTS.find(s => {
    const inp = document.getElementById(s.inputId);
    return !inp || !inp.files[0];
  }) || _VH_FOTO_SLOTS[0];
  openCamera(slot.inputId);
}

function _fillChoferFields(data) {
  if (data.nombre)             document.getElementById('ch-nombre').value = data.nombre;
  if (data.dni)                document.getElementById('ch-dni').value = data.dni;
  if (data.cuil)               document.getElementById('ch-cuil').value = data.cuil;
  if (data.fecha_nacimiento)   document.getElementById('ch-nacimiento').value = data.fecha_nacimiento;
  if (data.domicilio)          document.getElementById('ch-domicilio').value = data.domicilio;
  if (data.registro_categoria) document.getElementById('ch-reg-categoria').value = data.registro_categoria;
  if (data.registro_vencimiento) document.getElementById('ch-reg-vencimiento').value = data.registro_vencimiento;

  // Guardar URLs de imágenes para enviar al guardar
  if (data.dni_frente_url)      _choferFiles._dni_frente_url = data.dni_frente_url;
  if (data.dni_dorso_url)       _choferFiles._dni_dorso_url = data.dni_dorso_url;
  if (data.registro_frente_url) _choferFiles._registro_frente_url = data.registro_frente_url;
  if (data.registro_dorso_url)  _choferFiles._registro_dorso_url = data.registro_dorso_url;

  // Validar jurisdicción
  _checkJurisdiccion(
    data.provincia_dni || data.jurisdiccion_dni,
    data.provincia_registro || data.jurisdiccion_registro
  );
}

function _checkJurisdiccion(provDNI, provReg) {
  const alertDiv = document.getElementById('chofer-jurisdiccion-alert');
  const alertMsg = document.getElementById('chofer-jurisdiccion-msg');
  if (!alertDiv) return;
  if (provDNI && provReg && provDNI.toUpperCase() !== provReg.toUpperCase()) {
    alertMsg.textContent = `Jurisdicción diferente: DNI (${provDNI}) vs Registro (${provReg}). Verificá los documentos.`;
    alertDiv.style.display = 'block';
  } else if (provDNI || provReg) {
    alertDiv.style.display = 'none';
  }
}

async function extractChoferOCR() {
  // Fallback: leer archivos directo de los inputs si _choferFiles está vacío
  Object.entries(_CHOFER_FILE_KEYS).forEach(([inputId, key]) => {
    if (!_choferFiles[key]) {
      const inp = document.getElementById(inputId);
      if (inp && inp.files[0]) _choferFiles[key] = inp.files[0];
    }
  });
  const hasFile = _choferFiles.dni_frente || _choferFiles.dni_dorso || _choferFiles.reg_frente || _choferFiles.reg_dorso;
  if (!hasFile) { showAlert('Cargá al menos una imagen de documento.'); return; }

  const btn = document.querySelector('#chofer-docs-toolbar .dz-ocr');
  const status = document.getElementById('ai-chofer-status');
  if (btn) btn.disabled = true; status.textContent = 'Procesando OCR…';

  try {
    const choferId = document.getElementById('ch-id').value || 'tmp';
    const fd = new FormData();
    if (_choferFiles.dni_frente)  fd.append('dni_frente', _choferFiles.dni_frente);
    if (_choferFiles.dni_dorso)   fd.append('dni_dorso', _choferFiles.dni_dorso);
    if (_choferFiles.reg_frente)  fd.append('registro_frente', _choferFiles.reg_frente);
    if (_choferFiles.reg_dorso)   fd.append('registro_dorso', _choferFiles.reg_dorso);

    const res = await fetch(`/api/ocr/chofer/${choferId}`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const data = await res.json();
    _fillChoferFields(data);
    const filledCount = ['nombre','dni','fecha_nacimiento','registro_categoria','registro_vencimiento'].filter(k => data[k]).length;
    status.textContent = `✓ OCR completado — ${filledCount} campos completados`;
    // Debug: mostrar snippet del texto OCR para diagnosticar si Tesseract lee bien
    if (data._debug) {
      console.log('[OCR-CHOFER] DNI frente:', data._debug.dni_frente_snippet);
      console.log('[OCR-CHOFER] Reg frente:', data._debug.reg_frente_snippet);
      console.log('[OCR-CHOFER] Reg dorso:', data._debug.reg_dorso_snippet);
      if (!data.nombre) {
        const snip = (data._debug.reg_frente_snippet || data._debug.dni_frente_snippet || '').substring(0, 100);
        status.textContent += `  ⚠ OCR leyó: "${snip}"`;
      }
    }
  } catch (err) {
    status.textContent = _aiErrorMsg(err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function extractChoferAI() {
  Object.entries(_CHOFER_FILE_KEYS).forEach(([inputId, key]) => {
    if (!_choferFiles[key]) {
      const inp = document.getElementById(inputId);
      if (inp && inp.files[0]) _choferFiles[key] = inp.files[0];
    }
  });
  const hasFile = _choferFiles.dni_frente || _choferFiles.dni_dorso || _choferFiles.reg_frente || _choferFiles.reg_dorso;
  if (!hasFile) { showAlert('Cargá al menos una imagen de documento.'); return; }

  const btn = document.getElementById('chofer-btn-ai');
  const status = document.getElementById('ai-chofer-status');
  if (btn) btn.disabled = true; status.textContent = 'Analizando con IA…';

  try {
    const fd = new FormData();
    if (_choferFiles.dni_frente)  fd.append('dni_frente', _choferFiles.dni_frente);
    if (_choferFiles.dni_dorso)   fd.append('dni_dorso', _choferFiles.dni_dorso);
    if (_choferFiles.reg_frente)  fd.append('registro_frente', _choferFiles.reg_frente);
    if (_choferFiles.reg_dorso)   fd.append('registro_dorso', _choferFiles.reg_dorso);

    const res = await fetch('/api/ai/extract-chofer', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const data = await res.json();
    _fillChoferFields(data);
    status.textContent = '✓ Datos extraídos con IA';
  } catch (err) {
    status.textContent = _aiErrorMsg(err);
    btn.disabled = false;
  }
}

// Verificar si hay API key disponible para habilitar botones IA
async function checkAIAvailability() {
  try {
    const res = await fetch('/api/ai/status');
    const { available } = await res.json();
    // Cubre btn-ai-* y botones de IA con IDs nuevos
    document.querySelectorAll('[id^="btn-ai-"], #btn-extract-cedula-ai, #chofer-btn-ai, #vh-cedula-btn-ai, .dz-ai').forEach(btn => {
      btn.disabled = !available;
      if (!available) {
        btn.title = 'Requiere ANTHROPIC_API_KEY en .env';
        btn.style.opacity = '0.45';
        btn.style.cursor = 'not-allowed';
      } else {
        btn.title = '';
        btn.style.opacity = '';
        btn.style.cursor = '';
      }
    });
  } catch (e) {}
}

// OCR para cédula de vehículo (usa endpoint existente)
async function extractVehiculoOCR() {
  const frente = _pendingFiles['cedula_frente'];
  if (!frente) { showAlert('Cargá al menos la imagen del frente de la cédula.'); return; }
  const btn = document.getElementById('vh-cedula-btn-ocr') || document.getElementById('btn-ocr-cedula');
  const status = document.getElementById('ai-cedula-status');
  if (btn) btn.disabled = true; status.textContent = 'Procesando OCR…';
  try {
    const fd = new FormData();
    fd.append('cedula_img', frente);
    const res = await fetch('/api/ocr/cedula', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const d = await res.json();
    let filled = 0;
    const setF = (id, val) => { if (val) { const el = document.getElementById(id); if (el) { el.value = val; filled++; } } };
    setF('vh-patente', d.patente);
    setF('vh-motor',   d.motor);
    setF('vh-chasis',  d.chasis);
    setF('vh-color',   d.color);
    setF('vh-anio',    d.año);
    // Titular DNRPA
    setF('vh-titular-nombre',    d.titular_nombre);
    setF('vh-titular-dni',       d.titular_dni);
    setF('vh-titular-domicilio', d.titular_domicilio);
    // Marca y Modelo — igual que el flujo IA
    if (d.marca_id) {
      const marcaObj = cachedMarcas.find(m => m.id === d.marca_id);
      if (marcaObj) {
        document.getElementById('vh-marca-input').value = marcaObj.nombre;
        document.getElementById('vh-marca').value = d.marca_id;
        filled++;
        await loadModelosForMarca(d.marca_id, d.modelo_id);
        if (d.modelo_id) filled++;
      }
    } else if (d.marca) {
      // Fallback: el servidor devolvió el nombre de marca como texto
      const matchMarca = cachedMarcas.find(m => m.nombre.toUpperCase() === d.marca.toUpperCase());
      if (matchMarca) {
        document.getElementById('vh-marca-input').value = matchMarca.nombre;
        document.getElementById('vh-marca').value = matchMarca.id;
        filled++;
        await loadModelosForMarca(matchMarca.id, null);
        if (d.modelo) {
          const mod = _cachedModelos.find(m => m.nombre.toUpperCase().includes(d.modelo.toUpperCase()));
          if (mod) { document.getElementById('vh-modelo-input').value = mod.nombre; document.getElementById('vh-modelo').value = mod.id; filled++; }
        }
      }
    }
    status.textContent = filled > 0 ? `✓ OCR completado — ${filled} campos completados` : '✓ OCR completado — revisá los datos';
  } catch (err) {
    status.textContent = _aiErrorMsg(err);
  } finally { if (btn) btn.disabled = false; }
}

// OCR para oblea GNC
async function extractGncOCR() {
  // El OCR clásico (Tesseract) falla en fotos de obleas GNC — redirigir siempre a IA
  return extractGncAI();
}
async function _extractGncOCR_legacy() {
  const oblea = _pendingFiles['gnc_oblea'];
  if (!oblea) { showAlert('Cargá la imagen de la oblea primero.'); return; }
  const btn    = document.getElementById('dz-ocr-gnc-oblea-dropzone');
  const status = document.getElementById('ai-gnc-status');
  if (btn) btn.disabled = true;
  if (status) { status.textContent = 'Procesando OCR…'; status.style.display = ''; }
  try {
    const fd = new FormData();
    fd.append('cedula_img', oblea);
    const res = await fetch('/api/ocr/cedula', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const d = await res.json();
    const rawTxt = d.raw_text || d.text || '';
    const txtUp  = rawTxt.toUpperCase();
    console.log('[GNC-OCR] Texto crudo:\n', rawTxt); // debug — ver en consola F12
    let filled = 0;

    // Layout de la Cédula Mercosur GNC:
    // ┌─ VEHICULO ────────────────────────────────────────────┐
    // │ MARCA: FIAT    MODELO: PALIO FIRE MPI 16V             │
    // │ DOMINIO: -GER304    N°OBLEA/SELLO: 48843162           │
    // ├─ REGULADOR DE PRESION ────────────────────────────────┤
    // │ MARCA/MODELO/CID: KM01   N°DE SERIE: 10055            │
    // ├─ CILINDRO/S ──────────────────────────────────────────┤
    // │ MARCA/MODELO/CID: KK92   N°DE SERIE: 1073475  Vto.04/31│
    // ├─ VENCIMIENTO (caja naranja, abajo a la izq.) ─────────┤
    // │ 04/27                                                 │
    // └───────────────────────────────────────────────────────┘

    // ── N° de Oblea/Sello ─────────────────────────────────────────────────────
    // Está en la sección VEHICULO, después de "N°OBLEA/SELLO" o "OBLEA/SELLO"
    // Solo buscar ESTRICTAMENTE cerca de esa etiqueta — NO usar fallback de 8 dígitos
    const obleaMatch = txtUp.match(/(?:N[°º.]?\s*)?OBLEA[\/\s]*SELLO[\s:.\-]*(\d{5,12})/)
                    || txtUp.match(/SELLO[\s:.\-]{0,10}(\d{5,12})/);
    if (obleaMatch) {
      const el = document.getElementById('gnc-numero-oblea');
      if (el) { el.value = obleaMatch[1]; filled++; }
    }

    // ── Regulador de Presión ──────────────────────────────────────────────────
    // Sección "REGULADOR DE PRESION" → primera MARCA/MODELO/CID que le sigue
    // El código es tipo "KM01", "ECO01", etc. — letras+dígitos, 3-8 chars
    const regIdx = txtUp.indexOf('REGULADOR');
    const cilIdx = txtUp.indexOf('CILINDRO');
    if (regIdx >= 0) {
      // Solo buscar entre REGULADOR y CILINDRO para no contaminar con datos de cilindros
      const regZone = txtUp.slice(regIdx, cilIdx > regIdx ? cilIdx : regIdx + 300);
      const regMatch = regZone.match(/(?:MARCA[\/\s]*MODELO[\/\s]*CID|CID)\s*[:\-]?\s*([A-Z]{1,4}\d{2,4}[A-Z0-9]{0,4})/i)
                    || regZone.match(/\b([A-Z]{2,4}\d{2,4})\b/);
      if (regMatch) {
        const el = document.getElementById('gnc-regulador');
        if (el) { el.value = regMatch[1].trim(); filled++; }
      }
    }

    // ── Vencimiento principal (caja naranja) ──────────────────────────────────
    // Etiqueta "VENCIMIENTO" seguida de MM/AA — esta es la fecha de vigencia del GNC
    // NO confundir con "Vto." de cilindros (que es prueba hidráulica, se guarda aparte)
    const vtoMatch = txtUp.match(/VENCIMIENTO[\s\n\r:.\-]{0,30}(\d{2})[\/\-](\d{2,4})(?!\d)/);
    if (vtoMatch) {
      const mm = vtoMatch[1].padStart(2,'0');
      const yy = vtoMatch[2].length === 2 ? '20' + vtoMatch[2] : vtoMatch[2];
      if (parseInt(mm) >= 1 && parseInt(mm) <= 12) {
        const lastDay = new Date(parseInt(yy), parseInt(mm), 0).getDate();
        document.getElementById('gnc-hasta').value = `${yy}-${mm}-${String(lastDay).padStart(2,'0')}`;
        filled++;
      }
    }

    // ── Cilindros ─────────────────────────────────────────────────────────────
    // Sección "CILINDRO/S" — cada fila: MARCA/MODELO/CID  XX  N°DE SERIE  XXXXXXX  Vto.MM/AA
    // "Vto." acá es el vencimiento de la PRUEBA HIDRÁULICA del cilindro
    if (cilIdx >= 0) {
      const cilTxt = txtUp.slice(cilIdx);
      // Estrategia 1: buscar filas completas con marca + serie + Vto
      const cilFull = /\b([A-Z]{2,4}\d{2,4}[A-Z0-9]{0,4})\b[\s\S]{0,60}?(?:N[°º]?[\s.]?DE[\s.]?SERIE|SERIE)\s*[:\-]?\s*(\d{5,10})[\s\S]{0,40}?VTO[.:\s]*(\d{2})[\/\-](\d{2,4})/gi;
      const cilMatches = [];
      let cm;
      while ((cm = cilFull.exec(cilTxt)) !== null && cilMatches.length < 4) {
        cilMatches.push({ marca: cm[1], serie: cm[2], mm: cm[3], yy: cm[4] });
      }
      // Estrategia 2: si no encontró completos, buscar al menos serie + Vto
      if (cilMatches.length === 0) {
        const cilPartial = /(\d{5,10})[\s\S]{0,30}?VTO[.:\s]*(\d{2})[\/\-](\d{2,4})/gi;
        while ((cm = cilPartial.exec(cilTxt)) !== null && cilMatches.length < 4) {
          cilMatches.push({ marca: '', serie: cm[1], mm: cm[2], yy: cm[3] });
        }
      }
      if (cilMatches.length > 0) {
        if (cilMatches.length > 1) {
          const extra = document.getElementById('gnc-cil-extra');
          if (extra) extra.style.display = 'block';
          const btn2 = document.getElementById('gnc-add-cil-btn');
          if (btn2) btn2.innerHTML = '<i class="fa-solid fa-minus"></i> Menos cilindros';
        }
        cilMatches.forEach((c, idx) => {
          const n = idx + 1;
          const mm = c.mm.padStart(2,'0');
          const yy = c.yy.length === 2 ? '20' + c.yy : c.yy;
          if (parseInt(mm) < 1 || parseInt(mm) > 12) return;
          const lastDay = new Date(parseInt(yy), parseInt(mm), 0).getDate();
          const mEl = document.getElementById(`gnc-cil${n}-marca`);
          const sEl = document.getElementById(`gnc-cil${n}-serie`);
          const vEl = document.getElementById(`gnc-cil${n}-vto`);
          if (mEl && c.marca) { mEl.value = c.marca; filled++; }
          if (sEl && c.serie) { sEl.value = c.serie; filled++; }
          if (vEl) { vEl.value = `${yy}-${mm}-${String(lastDay).padStart(2,'0')}`; filled++; }
        });
      }
    }

    if (status) status.textContent = filled > 0
      ? `✓ OCR — ${filled} campo${filled > 1 ? 's' : ''} completado${filled > 1 ? 's' : ''}`
      : '⚠ OCR sin resultados — si la imagen está girada, abrí el visor, rotá y guardá (💾) antes de correr OCR';
  } catch (err) {
    if (status) status.textContent = _aiErrorMsg(err);
  } finally { if (btn) btn.disabled = false; }
} // fin _extractGncOCR_legacy

// OCR para póliza de seguro — soporta imagen y PDF
async function extractSeguroOCR() {
  const poliza = _pendingFiles['seg_poliza'];
  if (!poliza) { showAlert('Cargá el archivo de la póliza primero.'); return; }
  const btn = document.getElementById('dz-ocr-seg-poliza-dropzone');
  const status = document.getElementById('ai-seguro-status');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Procesando…';
  try {
    const fd = new FormData();
    fd.append('cedula_img', poliza);
    const res = await fetch('/api/ocr/cedula', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const d = await res.json();

    // Normalizar texto: quitar caracteres mal codificados de PDFs (Mac Roman, etc.)
    const rawText = (d.raw_text || d.text || '')
      .replace(/[ìÌ]/g, 'i').replace(/[ÛûÙù]/g, 'u').replace(/[ÒòÓó]/g, 'o')
      .replace(/[ÈèÉé]/g, 'e').replace(/[ÀàÁá]/g, 'a').replace(/[∫º°ª]/g, '');
    const txt = rawText.toUpperCase();
    let filled = 0;

    // ── Número de póliza ──────────────────────────────────────────────────────
    // Acepta: Póliza Nª 5928787 / Certificado N° 001-005 / RUTA Aseg.: 0065-0556248
    const polizaMatch =
      txt.match(/P[OÓ]LIZA\s*N[ÑAº°.:]?\s*[:.#]?\s*([\dA-Z][\d\-]{3,20})/i) ||
      txt.match(/P[OÓ]LIZA\s+([\dA-Z][\d\-]{3,20})/i) ||
      txt.match(/CERTIFICADO\s*N[º°∫]?\s*[:.#]?\s*([\d][\d\-]{2,20})/i) ||
      txt.match(/NRO\.?\s*RUTA\s*ASEG[^\n\r]*[\n\r]+\s*([\d][\d\-]{3,20})/i) ||
      txt.match(/RUTA\s*ASEG[^:]*:\s*([\d][\d\-]{3,20})/i);
    if (polizaMatch) {
      const el = document.getElementById('seg-poliza');
      if (el) { el.value = polizaMatch[1].trim(); filled++; }
    }

    // ── Fechas vigencia ───────────────────────────────────────────────────────
    // Acepta separadores / - . (ej: Mercantil Andina usa DD.MM.AAAA)
    const allDates = rawText.match(/\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4}/g) || [];
    const uniqueDates = [...new Set(allDates)];
    if (uniqueDates[0]) { document.getElementById('seg-desde').value = _parseDate(uniqueDates[0]); filled++; }
    if (uniqueDates[1]) { document.getElementById('seg-hasta').value = _parseDate(uniqueDates[1]); filled++; }

    // ── Aseguradora ───────────────────────────────────────────────────────────
    const asegKnown = [
      'ANTARTIDA','ANTÁRTIDA','ORBIS','MAPFRE','ZURICH','SANCOR',
      'RIO URUGUAY','ALLIANZ','FEDERACION PATRONAL','LA SEGUNDA',
      'RIVADAVIA','SMG','GALICIA SEGUROS','EXPERTA','PROVINCIA SEGUROS',
      'NACION SEGUROS','BOSTON','BERKLEY','HDI','QBE','SWISS MEDICAL',
      'MERCANTIL ANDINA','LA MERIDIONAL','CHUBB','INTEGRITY','ZURICH','NATIVA',
      'SAN CRISTOBAL','LIDERAR','TRIUNFO COOPERATIVA','PREVINCA'
    ];
    let asegNombre = '';
    for (const a of asegKnown) {
      if (txt.includes(a.toUpperCase())) {
        asegNombre = a.replace('ANTARTIDA','ANTÁRTIDA');
        break;
      }
    }
    // Buscar también en el cache de aseguradoras de la app
    if (!asegNombre && cachedAseguradoras) {
      const found = cachedAseguradoras.find(a => txt.includes(a.nombre.toUpperCase()));
      if (found) asegNombre = found.nombre;
    }
    if (asegNombre) {
      const inp = document.getElementById('seg-compania-input');
      if (inp) { inp.value = asegNombre; filled++; }
      if (cachedAseguradoras) {
        const match = cachedAseguradoras.find(a => a.nombre.toUpperCase().includes(asegNombre.toUpperCase()));
        if (match) { const hid = document.getElementById('seg-compania-id'); if (hid) hid.value = match.id; }
      }
    }

    if (status) {
      status.textContent = filled > 0
        ? `✓ OCR — ${filled} campo${filled > 1 ? 's' : ''} completado${filled > 1 ? 's' : ''}`
        : '✓ OCR completado — revisá los datos';
      status.style.display = '';
    }
  } catch (err) {
    if (status) status.textContent = _aiErrorMsg(err);
  } finally { if (btn) btn.disabled = false; }
}

function _parseDate(str) {
  // dd/mm/yyyy, dd-mm-yyyy o dd.mm.yyyy → yyyy-mm-dd
  const p = str.split(/[\/\-\.]/);
  if (p.length === 3 && p[2].length === 4) return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
  return str;
}

// ============================================================
// AUTENTICACIÓN
// ============================================================
let _currentUser = null;

function toggleLoginPassword() {
  const input = document.getElementById('login-password');
  const icon = document.getElementById('icon-toggle-pass');
  if (input.type === 'password') {
    input.type = 'text';
    icon.className = 'fa-solid fa-eye';
  } else {
    input.type = 'password';
    icon.className = 'fa-solid fa-eye-slash';
  }
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
      const e = await res.json();
      errEl.textContent = e.message; errEl.style.display = 'block'; return;
    }
    const user = await res.json();
    _currentUser = user;
    document.getElementById('login-screen').classList.add('hidden');
    applyUserSession(user);
    bootApp();
  } catch (e) {
    errEl.textContent = 'Error de conexión'; errEl.style.display = 'block';
  }
}

// Enter en inputs de login
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('login-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-password').focus(); });
});

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  _currentUser = null;
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('user-dropdown').classList.remove('open');
}

function canDelete() {
  return _currentUser?.rol === 'superadmin' || !!_currentUser?.puede_eliminar;
}
function canEdit() {
  return _currentUser?.rol === 'superadmin' || _currentUser?.rol === 'admin';
}

// Inyecta subtítulo con nombre de entidad en el título de un modal
function _setModalTitle(elId, icon, accion, subtitulo) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = `${icon} ${accion}${subtitulo ? ` <span style="font-weight:400;opacity:.65;font-size:.82em;">— ${subtitulo}</span>` : ''}`;
}

function applyUserSession(user) {
  document.getElementById('user-display-name').textContent = user.nombre;
  const isSuperAdmin = user.rol === 'superadmin';
  const isSuperOrAdmin = isSuperAdmin || user.rol === 'admin';
  document.getElementById('nav-usuarios').style.display = isSuperOrAdmin ? '' : 'none';
  document.getElementById('dd-usuarios').style.display = isSuperOrAdmin ? '' : 'none';
  const audNav = document.getElementById('nav-auditoria');
  if (audNav) audNav.style.display = isSuperAdmin ? '' : 'none';
  const credNav = document.getElementById('nav-credenciales');
  if (credNav) credNav.style.display = isSuperAdmin ? '' : 'none';
  const peajesExcelBtn = document.getElementById('peajes-import-excel-btn');
  if (peajesExcelBtn) peajesExcelBtn.style.display = isSuperAdmin ? '' : 'none';
  const peajesDedupBtn = document.getElementById('peajes-dedup-btn');
  if (peajesDedupBtn) peajesDedupBtn.style.display = isSuperAdmin ? '' : 'none';
  // Mostrar/ocultar nav items según permisos
  document.querySelectorAll('.nav-item[data-pantalla]').forEach(btn => {
    const p = btn.dataset.pantalla;
    if (p === 'usuarios') return;
    const allowed = user.rol === 'superadmin' || (user.permisos || []).includes(p);
    btn.style.display = allowed ? '' : 'none';
  });
}

function toggleUserDropdown() {
  document.getElementById('user-dropdown').classList.toggle('open');
}
document.addEventListener('click', e => {
  const dd = document.getElementById('user-dropdown');
  if (dd && !e.target.closest('.user-profile')) dd.classList.remove('open');
});

// ============================================================
// SIDEBAR — COLAPSO Y POSICIÓN
// ============================================================
let _sidebarCollapsed = localStorage.getItem('sidebar_collapsed') === '1';
let _sidebarPos = localStorage.getItem('sidebar_pos') || 'left';

function toggleSidebar() {
  _sidebarCollapsed = !_sidebarCollapsed;
  localStorage.setItem('sidebar_collapsed', _sidebarCollapsed ? '1' : '0');
  _applySidebarState();
}

function _applySidebarState() {
  const sidebar = document.getElementById('sidebar');
  const chevron = document.getElementById('sidebar-chevron');
  const label = document.getElementById('sidebar-toggle-label');
  if (_sidebarCollapsed) {
    sidebar.classList.add('collapsed');
    if (chevron) chevron.className = 'fa-solid fa-chevron-right';
    if (label) label.textContent = 'Expandir panel';
  } else {
    sidebar.classList.remove('collapsed');
    if (chevron) chevron.className = 'fa-solid fa-chevron-left';
    if (label) label.textContent = 'Contraer panel';
  }
}

function setSidebarPos(pos) {
  _sidebarPos = pos;
  localStorage.setItem('sidebar_pos', pos);
  _applyPos();
}

function _applyPos() {
  const app = document.getElementById('app-container');
  app.classList.remove('sidebar-left', 'sidebar-right', 'sidebar-top', 'sidebar-bottom');
  if (_sidebarPos !== 'left') app.classList.add('sidebar-' + _sidebarPos);
  // Actualizar botones activos
  ['left','right','top','bottom'].forEach(p => {
    const btn = document.getElementById('pos-' + p);
    if (btn) btn.classList.toggle('active', p === _sidebarPos);
  });
}

// ============================================================
// CONFIGURACIÓN — BRILLO Y COLOR
// ============================================================
function toggleSettings() {
  document.getElementById('settings-panel').classList.toggle('open');
  document.getElementById('user-dropdown').classList.remove('open');
}

function setBrightness(val) {
  val = Math.min(150, Math.max(30, parseInt(val)));
  document.documentElement.style.setProperty('--brightness', val / 100);
  const slider = document.getElementById('brightness-slider');
  const valEl = document.getElementById('brightness-val');
  if (slider) slider.value = val;
  if (valEl) valEl.textContent = val + '%';
  localStorage.setItem('ui_brightness', val);
}

function setThemeMode(mode) {
  const apply = () => {
    localStorage.setItem('ui_theme', mode);
    if (mode === 'light') {
      document.body.classList.add('theme-light');
      document.getElementById('btn-dark-mode')?.classList.remove('active');
      document.getElementById('btn-light-mode')?.classList.add('active');
    } else {
      document.body.classList.remove('theme-light');
      document.getElementById('btn-dark-mode')?.classList.add('active');
      document.getElementById('btn-light-mode')?.classList.remove('active');
    }
  };
  if (!document.startViewTransition) { apply(); return; }
  document.startViewTransition(apply);
}

function setAccentColor(color, el) {
  document.documentElement.style.setProperty('--accent-color', color);
  document.documentElement.style.setProperty('--accent-purple', color);
  const custom = document.getElementById('accent-custom');
  if (custom) custom.value = color;
  localStorage.setItem('ui_accent', color);
  // Marcar swatch activo solo dentro del primer grupo de swatches
  const firstGroup = document.getElementById('color-swatches');
  if (firstGroup) firstGroup.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === color);
  });
}

function setBrandColor(color, el) {
  document.documentElement.style.setProperty('--brand-color', color);
  // Aplicar al sidebar como color de fondo de la logo area
  document.documentElement.style.setProperty('--sidebar-brand', color);
  const custom = document.getElementById('brand-custom');
  if (custom) custom.value = color;
  localStorage.setItem('ui_brand', color);
  el?.closest('.settings-color-row')?.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
  if (el) el.classList.add('active');
}

function setHighlightColor(color, el) {
  document.documentElement.style.setProperty('--highlight-color', color);
  document.documentElement.style.setProperty('--accent-orange', color);
  const custom = document.getElementById('highlight-custom');
  if (custom) custom.value = color;
  localStorage.setItem('ui_highlight', color);
  el?.closest('.settings-color-row')?.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
  if (el) el.classList.add('active');
}

function setCSSVar(varName, value) {
  document.documentElement.style.setProperty(varName, value);
  localStorage.setItem('ui_cssvar_' + varName, value);
}

function setScrollAccent(color) {
  document.documentElement.style.setProperty('--scroll-accent', color);
  localStorage.setItem('ui_scroll_accent', color);
  const picker = document.getElementById('scroll-accent-color');
  if (picker && picker.value !== color) picker.value = color;
}

async function resetPreferences() {
  if (!await showConfirm('¿Restablecer todas las preferencias visuales a los valores por defecto?')) return;
  ['ui_brightness','ui_theme','ui_accent','ui_brand','ui_highlight','ui_scroll_accent',
   'ui_cssvar_--input-border-color','ui_cssvar_--placeholder-color',
   'ui_cssvar_--color-error','ui_cssvar_--color-success',
   'sidebar_collapsed','sidebar_pos'].forEach(k => localStorage.removeItem(k));
  location.reload();
}

function _initBrightnessWheel() {
  const slider = document.getElementById('brightness-slider');
  if (!slider) return;
  slider.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 5 : -5;
    setBrightness(parseInt(slider.value) + delta);
  }, { passive: false });
}

function _loadUIPrefs() {
  const brightness = localStorage.getItem('ui_brightness') || '100';
  setBrightness(brightness);

  const theme = localStorage.getItem('ui_theme') || 'dark';
  setThemeMode(theme);

  const accent = localStorage.getItem('ui_accent') || '#7f56d9';
  setAccentColor(accent, null);

  const brand = localStorage.getItem('ui_brand');
  if (brand) setBrandColor(brand, null);

  const highlight = localStorage.getItem('ui_highlight');
  if (highlight) setHighlightColor(highlight, null);

  const scrollAccent = localStorage.getItem('ui_scroll_accent') || '#ff3b30';
  setScrollAccent(scrollAccent);

  // CSS vars de formularios
  [['--input-border-color','#ffffff14'],['--placeholder-color','#9aa2c0'],
   ['--color-error','#ff3b30'],['--color-success','#34c759']].forEach(([v, def]) => {
    const saved = localStorage.getItem('ui_cssvar_' + v);
    const el = document.getElementById(v.replace('--','').replace(/-/g,'') + '-color') ||
               document.getElementById(v.slice(2));
    if (saved) {
      document.documentElement.style.setProperty(v, saved);
      if (el) el.value = saved;
    }
  });

  // Sync pickers con valores guardados
  const accentPicker = document.getElementById('accent-custom');
  if (accentPicker) accentPicker.value = accent;
  const brandPicker = document.getElementById('brand-custom');
  if (brandPicker && brand) brandPicker.value = brand;
  const hlPicker = document.getElementById('highlight-custom');
  if (hlPicker && highlight) hlPicker.value = highlight;

  _applySidebarState();
  _applyPos();
  _initBrightnessWheel();
}

// ──────────────────────────────────────────────────────────────
// GESTIÓN DE USUARIOS (versión completa con campos nuevos)
// ──────────────────────────────────────────────────────────────
function updatePermisosDefault() {
  const rol = document.getElementById('usr-rol').value;
  const all = document.querySelectorAll('#permisos-grid input[name=perm]');
  all.forEach(cb => {
    if (rol === 'admin') cb.checked = true;
    else if (rol === 'operador') cb.checked = ['dashboard','choferes','vehiculos','services'].includes(cb.value);
    else if (rol === 'solo_lectura') cb.checked = cb.value === 'dashboard';
  });
}

function _showPuedeEliminarContainer() {
  const el = document.getElementById('usr-puede-eliminar-container');
  if (el) el.style.display = _currentUser?.rol === 'superadmin' ? 'block' : 'none';
}

// ──────────────────────────────────────────────────────────────
function openNewUsuarioModal() {
  document.getElementById('form-usuario').reset();
  document.getElementById('usr-id').value = '';
  document.getElementById('usr-lat').value = '';
  document.getElementById('usr-lng').value = '';
  document.getElementById('usr-gps-status').textContent = '';
  document.getElementById('usr-activo-container').style.display = 'none';
  document.getElementById('usr-map-btn').style.display = 'none';
  hideInlineMap('usr-map');
  document.getElementById('usr-pass-hint').textContent = '(requerida)';
  document.getElementById('modal-usuario-title').textContent = 'Nuevo Usuario';
  document.querySelectorAll('#permisos-grid input[name=perm]').forEach(cb => { cb.checked = cb.value === 'dashboard'; });
  const pelEl = document.getElementById('usr-puede-eliminar');
  if (pelEl) pelEl.checked = false;
  _showPuedeEliminarContainer();
  openModal('modal-usuario');
}

// Reemplazar la función editUsuario para incluir nuevos campos
async function editUsuario(id) {
  const res = await fetch('/api/usuarios');
  const users = await res.json();
  const u = users.find(x => x.id === id);
  if (!u) return;
  const permsRes = await fetch(`/api/usuarios/${id}/permisos`);
  const perms = await permsRes.json();

  document.getElementById('usr-id').value = u.id;
  document.getElementById('usr-nombre').value = u.nombre;
  document.getElementById('usr-email').value = u.email;
  document.getElementById('usr-celular').value = u.celular || '';
  document.getElementById('usr-nacimiento').value = u.fecha_nacimiento ? u.fecha_nacimiento.split('T')[0] : '';
  document.getElementById('usr-domicilio').value = u.domicilio || '';
  document.getElementById('usr-entre-calles').value = u.entre_calles || '';
  document.getElementById('usr-cp').value = u.codigo_postal || '';
  document.getElementById('usr-lat').value = u.lat || '';
  document.getElementById('usr-lng').value = u.lng || '';
  document.getElementById('usr-password').value = '';
  document.getElementById('usr-rol').value = u.rol;
  document.getElementById('usr-activo').checked = u.activo === 1;
  document.getElementById('usr-activo-container').style.display = 'flex';
  document.getElementById('usr-pass-hint').textContent = '(dejar vacío para no cambiar)';
  const gpsStatus = document.getElementById('usr-gps-status');
  const mapBtn = document.getElementById('usr-map-btn');
  if (u.lat && u.lng) {
    gpsStatus.textContent = '📍 GPS guardado';
    gpsStatus.style.color = 'var(--color-success)';
    mapBtn.style.display = 'flex';
    showInlineMap('usr-map', parseFloat(u.lat), parseFloat(u.lng), u.domicilio || u.nombre);
  } else {
    gpsStatus.textContent = '';
    mapBtn.style.display = 'none';
    hideInlineMap('usr-map');
  }
  document.querySelectorAll('#permisos-grid input[name=perm]').forEach(cb => { cb.checked = (perms.pantallas||perms).includes(cb.value); });
  const pelEl = document.getElementById('usr-puede-eliminar');
  if (pelEl) pelEl.checked = !!perms.puede_eliminar;
  _showPuedeEliminarContainer();
  // Reset DNI files
  _usrFiles.usr_dni_frente = null; _usrFiles.usr_dni_dorso = null;
  // Cargar previews DNI si existen
  [['usr-prev-dni-frente','usr-drop-dni-frente','usr-eye-dni-frente', u.dni_frente_url],
   ['usr-prev-dni-dorso', 'usr-drop-dni-dorso', 'usr-eye-dni-dorso',  u.dni_dorso_url]
  ].forEach(([prevId, dzId, eyeId, url]) => {
    const img = document.getElementById(prevId);
    const dz  = document.getElementById(dzId);
    const eye = document.getElementById(eyeId);
    if (url && img) { img.src = url; img.style.display = 'block'; if (dz) dz.classList.add('has-img'); if (eye) eye.style.display = 'flex'; }
    else { if (img) { img.src=''; img.style.display='none'; } if (dz) dz.classList.remove('has-img'); if (eye) eye.style.display='none'; }
  });
  document.getElementById('modal-usuario-title').textContent = 'Editar Usuario';
  openModal('modal-usuario');
}

// Reemplazar loadUsuarios para incluir celular y acciones
async function loadUsuarios() {
  const tbody = document.getElementById('usuarios-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Cargando...</td></tr>';
  try {
    const res = await fetch('/api/usuarios');
    if (!res.ok) throw new Error('Error ' + res.status);
    const users = await res.json();
    const rolClass = { superadmin:'role-superadmin', admin:'role-admin', operador:'role-operador', solo_lectura:'role-solo_lectura' };
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--placeholder-color);">Sin usuarios registrados</td></tr>';
      return;
    }
    tbody.innerHTML = users.map((u, idx) => `
      <tr class="${idx%2===1?'row-alt':''}">
        <td>${u.nombre}</td>
        <td>${u.email}</td>
        <td>${u.celular || '-'}</td>
        <td><span class="role-badge ${rolClass[u.rol]||''}">${u.rol}</span></td>
        <td><span class="badge ${u.activo ? 'badge-success':'badge-danger'}">${u.activo?'Activo':'Inactivo'}</span></td>
        <td style="text-align:center;">
          ${u.email !== 'oscarstasiulevicius@gmail.com'
            ? `<button class="tbl-action-btn tbl-btn-edit" onclick="editUsuario(${u.id})" title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>`
            : '<span style="font-size:11px;color:var(--text-secondary);">Superadmin</span>'}
        </td>
      </tr>
    `).join('');
  injectExportBar('table-usuarios', 'Usuarios');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--color-error);">Error al cargar usuarios: ${e.message}</td></tr>`;
  }
}

// ── Archivos DNI de usuario ──────────────────────────────────────────────────
const _usrFiles = { usr_dni_frente: null, usr_dni_dorso: null };

function handleUsrDocDrop(e, inputId, prevId, dzId, eyeId) {
  e.preventDefault();
  const dz = document.getElementById(dzId);
  if (dz) dz.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const inp = document.getElementById(inputId);
  const dt = new DataTransfer();
  dt.items.add(file);
  if (inp) inp.files = dt.files;
  previewUsrDoc({ id: inputId, files: [file] }, prevId, dzId, eyeId);
}

function previewUsrDoc(input, prevId, dzId, eyeId) {
  const file = input.files ? input.files[0] : input;
  if (!file) return;
  const keyMap = { 'usr-file-dni-frente': 'usr_dni_frente', 'usr-file-dni-dorso': 'usr_dni_dorso' };
  const key = keyMap[input.id || ''];
  if (key) _usrFiles[key] = file;
  const img = document.getElementById(prevId);
  if (img) { img.src = URL.createObjectURL(file); img.style.display = 'block'; }
  const dz = document.getElementById(dzId);
  if (dz) dz.classList.add('has-img');
  const eye = document.getElementById(eyeId);
  if (eye) eye.style.display = 'flex';
  // Intentar leer QR/barcode si es DNI frente
  if ((input.id || '') === 'usr-file-dni-frente') _tryReadDNIBarcodeToUsr(file);
}

async function _tryReadDNIBarcodeToUsr(file) {
  if (!('BarcodeDetector' in window)) return;
  try {
    const detector = new BarcodeDetector({ formats: ['pdf417', 'qr_code', 'data_matrix', 'aztec'] });
    const bitmap = await createImageBitmap(file);
    const codes = await detector.detect(bitmap);
    if (!codes.length) return;
    const raw = codes[0].rawValue || '';
    if (!raw) return;
    let parts = raw.replace(/^@/, '').split('@');
    if (parts.length < 5) return;
    const apellido = (parts[0] || '').trim();
    const nombre   = (parts[1] || '').trim();
    const nroDNI   = (parts[3] || '').replace(/\D/g, '');
    const fechaNac = (parts[5] || '').trim();
    let filled = 0;
    const setVal = (id, val) => { if (!val) return; const el = document.getElementById(id); if (el) { el.value = val; filled++; } };
    const nombreCompleto = apellido && nombre ? `${nombre} ${apellido}` : (apellido || nombre);
    setVal('usr-nombre', nombreCompleto);
    if (fechaNac) {
      const m = fechaNac.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) setVal('usr-nacimiento', `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);
    }
    if (filled > 0) {
      const st = document.getElementById('usr-ocr-status');
      if (st) st.textContent = `✓ Código DNI leído — ${filled} campos completados`;
    }
  } catch(e) { console.warn('BarcodeDetector usr:', e); }
}

async function extractUsrOCR() {
  const file = _usrFiles.usr_dni_frente || _usrFiles.usr_dni_dorso;
  if (!file) { showAlert('Cargá al menos una imagen de DNI primero.'); return; }
  const status = document.getElementById('usr-ocr-status');
  if (status) status.textContent = '⏳ Procesando OCR...';
  try {
    const fd = new FormData();
    if (_usrFiles.usr_dni_frente) fd.append('dni_frente', _usrFiles.usr_dni_frente);
    if (_usrFiles.usr_dni_dorso)  fd.append('dni_dorso',  _usrFiles.usr_dni_dorso);
    const res = await fetch('/api/ocr/chofer', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    let filled = 0;
    const setVal = (id, val) => { if (!val) return; const el = document.getElementById(id); if (el && !el.value) { el.value = val; filled++; } };
    if (data.nombre) setVal('usr-nombre', data.nombre);
    if (data.fecha_nacimiento) setVal('usr-nacimiento', data.fecha_nacimiento);
    if (status) status.textContent = filled > 0 ? `✓ OCR completado — ${filled} campos completados` : '⚠ OCR no encontró datos suficientes';
  } catch(err) {
    if (status) status.textContent = '✗ Error en OCR: ' + err.message;
  }
}

async function extractUsrAI() {
  showAlert('IA para usuarios próximamente.');
}

async function saveUsuario(e) {
  e.preventDefault();
  const id = document.getElementById('usr-id').value;
  const permisos = [...document.querySelectorAll('#permisos-grid input[name=perm]:checked')].map(cb => cb.value);

  // Usar FormData si hay archivos DNI
  const hasDni = _usrFiles.usr_dni_frente || _usrFiles.usr_dni_dorso;
  let res;
  if (hasDni) {
    const fd = new FormData();
    fd.append('nombre', document.getElementById('usr-nombre').value);
    fd.append('email',  document.getElementById('usr-email').value);
    const pw = document.getElementById('usr-password').value;
    if (pw) fd.append('password', pw);
    fd.append('rol',    document.getElementById('usr-rol').value);
    fd.append('activo', id ? (document.getElementById('usr-activo').checked ? 1 : 0) : 1);
    fd.append('celular', sanitizePhone(document.getElementById('usr-celular').value) || '');
    fd.append('fecha_nacimiento', document.getElementById('usr-nacimiento').value || '');
    fd.append('domicilio', document.getElementById('usr-domicilio').value || '');
    fd.append('entre_calles', document.getElementById('usr-entre-calles').value.trim() || '');
    fd.append('codigo_postal', document.getElementById('usr-cp').value || '');
    fd.append('lat', document.getElementById('usr-lat').value || '');
    fd.append('lng', document.getElementById('usr-lng').value || '');
    fd.append('permisos', JSON.stringify(permisos));
    fd.append('puede_eliminar', document.getElementById('usr-puede-eliminar')?.checked ? 1 : 0);
    if (_usrFiles.usr_dni_frente) fd.append('dni_frente', _usrFiles.usr_dni_frente);
    if (_usrFiles.usr_dni_dorso)  fd.append('dni_dorso',  _usrFiles.usr_dni_dorso);
    const url = id ? `/api/usuarios/${id}` : '/api/usuarios';
    res = await fetch(url, { method: id ? 'PUT' : 'POST', body: fd });
  } else {
    const body = {
      nombre: document.getElementById('usr-nombre').value,
      email: document.getElementById('usr-email').value,
      password: document.getElementById('usr-password').value || undefined,
      rol: document.getElementById('usr-rol').value,
      activo: id ? (document.getElementById('usr-activo').checked ? 1 : 0) : 1,
      celular: sanitizePhone(document.getElementById('usr-celular').value),
      fecha_nacimiento: document.getElementById('usr-nacimiento').value || null,
      domicilio: document.getElementById('usr-domicilio').value || null,
      entre_calles: document.getElementById('usr-entre-calles').value.trim() || null,
      codigo_postal: document.getElementById('usr-cp').value || null,
      lat: document.getElementById('usr-lat').value || null,
      lng: document.getElementById('usr-lng').value || null,
      permisos,
      puede_eliminar: document.getElementById('usr-puede-eliminar')?.checked ? 1 : 0
    };
    const url = id ? `/api/usuarios/${id}` : '/api/usuarios';
    res = await fetch(url, { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  try {
    if (res.ok) {
      // Reset DNI files y dropzones
      _usrFiles.usr_dni_frente = null; _usrFiles.usr_dni_dorso = null;
      ['usr-drop-dni-frente','usr-drop-dni-dorso'].forEach(dzId => {
        const dz = document.getElementById(dzId);
        if (dz) dz.classList.remove('has-img');
      });
      ['usr-prev-dni-frente','usr-prev-dni-dorso'].forEach(id => {
        const el = document.getElementById(id); if (el) { el.src=''; el.style.display='none'; }
      });
      closeModal('modal-usuario');
      loadUsuarios();
      showToast(id ? 'Usuario actualizado' : 'Usuario creado');
    } else {
      const err = await res.json();
      showAlert('Error: ' + err.message);
    }
  } catch (err) { showAlert('Error al guardar usuario.', 'error', 'error'); }
}

// Helper: mostrar mapa inline desde inputs lat/lng (el statusId se deduce del latId)
function openMapFromInputs(latId, lngId, addressId) {
  const lat = parseFloat(document.getElementById(latId).value);
  const lng = parseFloat(document.getElementById(lngId).value);
  const addr = document.getElementById(addressId)?.value || '';
  if (!isNaN(lat) && !isNaN(lng)) {
    // Deducir containerId: usr-lat → usr-map, prov-lat → prov-map, etc.
    const prefix = latId.replace(/-lat$/, '');
    const containerId = `${prefix}-map`;
    showInlineMap(containerId, lat, lng, addr);
  } else if (addr) {
    window.open(`https://www.openstreetmap.org/search?query=${encodeURIComponent(addr)}`, '_blank');
  }
}

// ──────────────────────────────────────────────────────────────
// CÁMARA — modal con selector de dispositivo (notebook + celular)
// ──────────────────────────────────────────────────────────────
let _cameraTargetInputId = null;
let _cameraStream = null;
let _camCapturedBlob = null;

async function openCamera(targetInputId) {
  _cameraTargetInputId = targetInputId;
  _camCapturedBlob = null;

  // Resetear UI
  document.getElementById('cam-preview-wrap').style.display = 'none';
  document.getElementById('cam-btn-capturar').style.display = '';
  document.getElementById('cam-btn-confirmar').style.display = 'none';
  document.getElementById('cam-btn-reintentar').style.display = 'none';
  document.getElementById('cam-video').style.display = '';

  openModal('modal-camera');

  // Enumerar cámaras disponibles
  try {
    // Primer acceso para obtener permisos (necesario antes de enumerateDevices en algunos browsers)
    const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
    tempStream.getTracks().forEach(t => t.stop());
  } catch(e) { /* sin permiso todavía */ }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    const sel = document.getElementById('cam-device-select');
    sel.innerHTML = '';

    if (cameras.length === 0) {
      sel.innerHTML = '<option value="">Sin cámaras detectadas</option>';
      showToast('No se encontraron cámaras disponibles');
      return;
    }

    cameras.forEach((cam, idx) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      // Etiquetas descriptivas
      let label = cam.label || `Cámara ${idx + 1}`;
      // Intentar identificar tipo por label
      if (!cam.label) {
        if (idx === 0) label = 'Cámara principal';
      } else {
        // Normalizar etiquetas comunes
        if (/back|rear|environment|trasera/i.test(label)) label = `📷 Trasera — ${label}`;
        else if (/front|user|frontal|delantera|integrated|integrada|built.?in|webcam/i.test(label)) label = `🖥️ Notebook/Frontal — ${label}`;
        else label = `📷 ${label}`;
      }
      opt.textContent = label;
      sel.appendChild(opt);
    });

    // Arrancar con la primera cámara
    await _startCameraDevice(cameras[0].deviceId);

  } catch(e) {
    showToast('Error al acceder a cámaras: ' + e.message);
  }
}

async function _startCameraDevice(deviceId) {
  // Detener stream anterior si existe
  if (_cameraStream) {
    _cameraStream.getTracks().forEach(t => t.stop());
    _cameraStream = null;
  }
  try {
    const constraints = deviceId
      ? { video: { deviceId: { exact: deviceId } } }
      : { video: true };
    _cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = document.getElementById('cam-video');
    video.srcObject = _cameraStream;
  } catch(e) {
    showToast('No se pudo iniciar cámara: ' + e.message);
  }
}

async function switchCamera() {
  const sel = document.getElementById('cam-device-select');
  const deviceId = sel.value;
  if (deviceId) await _startCameraDevice(deviceId);
  // Resetear estado de captura si había preview
  reintentarFoto();
}

function closeCamera() {
  if (_cameraStream) { _cameraStream.getTracks().forEach(t => t.stop()); _cameraStream = null; }
  _camCapturedBlob = null;
  closeModal('modal-camera');
}

function capturarFoto() {
  const video = document.getElementById('cam-video');
  const canvas = document.getElementById('cam-canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  canvas.toBlob(blob => {
    _camCapturedBlob = blob;
    // Mostrar preview
    const preview = document.getElementById('cam-preview');
    preview.src = URL.createObjectURL(blob);
    document.getElementById('cam-preview-wrap').style.display = '';
    document.getElementById('cam-video').style.display = 'none';
    // Cambiar botones
    document.getElementById('cam-btn-capturar').style.display = 'none';
    document.getElementById('cam-btn-confirmar').style.display = '';
    document.getElementById('cam-btn-reintentar').style.display = '';
  }, 'image/jpeg', 0.92);
}

function reintentarFoto() {
  _camCapturedBlob = null;
  document.getElementById('cam-preview-wrap').style.display = 'none';
  document.getElementById('cam-video').style.display = '';
  document.getElementById('cam-btn-capturar').style.display = '';
  document.getElementById('cam-btn-confirmar').style.display = 'none';
  document.getElementById('cam-btn-reintentar').style.display = 'none';
}

function confirmarFoto() {
  if (!_camCapturedBlob) return;
  const file = new File([_camCapturedBlob], `camara_${Date.now()}.jpg`, { type: 'image/jpeg' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.getElementById(_cameraTargetInputId);
  if (input) {
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  closeCamera();
}

// ──────────────────────────────────────────────────────────────
// STOCK / PRODUCTOS
// ──────────────────────────────────────────────────────────────
let _cachedProductos = [];

async function loadStock() {
  try {
    const res = await fetch('/api/productos');
    _cachedProductos = await res.json();
    const tbody = document.getElementById('stock-table-body');
    tbody.innerHTML = '';
    _cachedProductos.forEach((p, idx) => {
      const tr = document.createElement('tr');
      if (idx % 2 === 1) tr.classList.add('row-alt');
      tr.innerHTML = `
        <td>${p.foto_url ? `<img src="${p.foto_url}" style="width:40px;height:40px;object-fit:cover;border-radius:6px;">` : '-'}</td>
        <td><strong>${p.nombre}</strong><br><small style="color:var(--placeholder-color)">${p.descripcion||''}</small></td>
        <td>${p.precio_venta ? formatCurrency(p.precio_venta) : '-'}</td>
        <td><span style="font-size:1.1rem;font-weight:700;color:${p.stock_central<5?'var(--color-error)':'var(--color-success)'}">${p.stock_central}</span></td>
        <td>${p.codigo_barras||'-'}</td>
        <td><span class="badge ${p.activo?'badge-success':'badge-danger'}">${p.activo?'activo':'inactivo'}</span></td>
        <td style="text-align:center;">
          <button class="tbl-action-btn tbl-btn-edit" onclick="editProducto(${p.id})" title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
          ${canDelete()
            ? `<button class="tbl-action-btn tbl-btn-delete" onclick="deleteProducto(${p.id})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>`
            : `<button class="tbl-action-btn tbl-btn-toggle-${p.activo?'off':'on'}" onclick="toggleActivoProducto(${p.id},${p.activo})" title="${p.activo?'Desactivar':'Activar'}"><i class="fa-solid fa-${p.activo?'circle-pause':'circle-play'}"></i></button>`
          }
        </td>`;
      tbody.appendChild(tr);
    });
    loadEntregas();
  injectExportBar('table-productos', 'Productos');
  } catch(e) { console.error('Error al cargar stock:', e); }
}

function openAddProductoModal() {
  document.getElementById('form-producto').reset();
  document.getElementById('prod-id').value = '';
  document.getElementById('prod-foto-url-existing').value = '';
  document.getElementById('prod-foto-preview').style.display = 'none';
  document.getElementById('prod-foto-icon').style.display = 'block';
  document.getElementById('modal-producto-title').innerText = 'Nuevo Producto';
  openModal('modal-producto');
}

function editProducto(id) {
  const p = _cachedProductos.find(x => x.id === id);
  if (!p) return;
  document.getElementById('prod-id').value = p.id;
  document.getElementById('prod-nombre').value = p.nombre;
  document.getElementById('prod-descripcion').value = p.descripcion || '';
  setAmt('prod-precio', p.precio_venta || 0);
  document.getElementById('prod-stock').value = p.stock_central || 0;
  document.getElementById('prod-codigo-barras').value = p.codigo_barras || '';
  document.getElementById('prod-foto-url-existing').value = p.foto_url || '';
  if (p.foto_url) {
    document.getElementById('prod-foto-preview').src = p.foto_url;
    document.getElementById('prod-foto-preview').style.display = 'block';
    document.getElementById('prod-foto-icon').style.display = 'none';
  }
  document.getElementById('modal-producto-title').innerText = 'Editar Producto';
  openModal('modal-producto');
}

function handleProdFotoDrop(e) {
  e.preventDefault();
  document.getElementById('prod-foto-drop').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleProdFotoSelect(file);
}

function handleProdFotoSelect(file) {
  if (!file?.type.startsWith('image/')) return;
  // Mostrar preview
  const url = URL.createObjectURL(file);
  document.getElementById('prod-foto-preview').src = url;
  document.getElementById('prod-foto-preview').style.display = 'block';
  document.getElementById('prod-foto-icon').style.display = 'none';
  // Intentar leer código de barras automáticamente
  _tryReadBarcode(file);
}

async function _tryReadBarcode(file) {
  const statusEl = document.getElementById('dz-status-prod-foto-drop');
  const barcodeInput = document.getElementById('prod-codigo-barras');

  // No sobreescribir si ya hay un código cargado manualmente
  if (barcodeInput.value.trim()) return;

  if (statusEl) { statusEl.textContent = '🔍 Buscando código de barras...'; statusEl.style.color = 'var(--accent-color)'; }

  // 1. Intentar con BarcodeDetector nativo (Chrome/Edge — más preciso)
  if ('BarcodeDetector' in window) {
    try {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
      const detector = new BarcodeDetector({
        formats: ['ean_13','ean_8','code_128','code_39','code_93','upc_a','upc_e','qr_code','data_matrix','itf']
      });
      const barcodes = await detector.detect(img);
      if (barcodes.length > 0) {
        const val = barcodes[0].rawValue;
        barcodeInput.value = val;
        if (statusEl) { statusEl.textContent = `✓ Código detectado: ${val}`; statusEl.style.color = 'var(--color-success)'; }
        showToast(`📦 Código de barras: ${val}`);
        return;
      }
    } catch(e) { /* continúa al fallback */ }
  }

  // 2. Fallback: enviar al servidor para OCR numérico con Tesseract
  try {
    const fd = new FormData();
    fd.append('imagen', file);
    const res = await fetch('/api/ocr/barcode', { method: 'POST', body: fd });
    if (res.ok) {
      const d = await res.json();
      if (d.barcode) {
        barcodeInput.value = d.barcode;
        if (statusEl) { statusEl.textContent = `✓ OCR: ${d.barcode}`; statusEl.style.color = 'var(--color-success)'; }
        showToast(`📦 Código detectado (OCR): ${d.barcode}`);
        return;
      }
    }
  } catch(e) { /* silencioso */ }

  // Sin resultado
  if (statusEl) { statusEl.textContent = 'No se detectó código — ingresalo manualmente'; statusEl.style.color = 'orange'; }
  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3500);
}

// Botón "Leer Código de Barras" de la toolbar → abre cámara
async function scanBarcode() {
  await openCamera('prod-foto-input');
}

async function saveProducto(e) {
  e.preventDefault();
  const id = document.getElementById('prod-id').value;
  const fd = new FormData();
  fd.append('nombre', document.getElementById('prod-nombre').value);
  fd.append('descripcion', document.getElementById('prod-descripcion').value || '');
  fd.append('precio_venta', getAmt('prod-precio') || '');
  fd.append('stock_central', document.getElementById('prod-stock').value || 0);
  fd.append('codigo_barras', document.getElementById('prod-codigo-barras').value || '');
  fd.append('foto_url_existing', document.getElementById('prod-foto-url-existing').value || '');
  const fotoInput = document.getElementById('prod-foto-input');
  if (fotoInput.files[0]) fd.append('foto', fotoInput.files[0]);
  try {
    const res = await fetch(id ? `/api/productos/${id}` : '/api/productos', { method: id ? 'PUT' : 'POST', body: fd });
    if (res.ok) { closeModal('modal-producto'); loadStock(); showToast('Producto guardado'); }
    else { const err = await res.json(); showAlert(err.message, 'error'); }
  } catch(e) { showAlert('Error al guardar producto', 'error', 'error'); }
}

async function deleteProducto(id) {
  if (!await showConfirm('¿Eliminar este producto?')) return;
  const res = await fetch(`/api/productos/${id}`, { method: 'DELETE' });
  if (res.ok) loadStock();
  else { const e = await res.json(); showAlert(e.message || 'Error al eliminar', 'error'); }
}

async function toggleActivoProducto(id, activo) {
  const res = await fetch(`/api/productos/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activo: activo ? 0 : 1 })
  });
  if (res.ok) loadStock();
  else { const e = await res.json(); showAlert(e.message || 'Error', 'error'); }
}

// Entregas de set
async function loadEntregas() {
  try {
    const res = await fetch('/api/stock-entregas');
    const list = await res.json();
    const tbody = document.getElementById('entregas-table-body');
    tbody.innerHTML = '';
    list.forEach((e, idx) => {
      const tr = document.createElement('tr');
      if (idx%2===1) tr.classList.add('row-alt');
      tr.innerHTML = `<td>${e.chofer_nombre}</td><td>${e.patente||'-'}</td><td>${formatDate(e.fecha_entrega)}</td>
        <td><button class="btn btn-secondary btn-sm" onclick="verEntregaItems(${e.id})"><i class="fa-solid fa-list"></i> Ver ítems</button></td>
        <td style="text-align:center;"><button class="btn btn-secondary btn-sm" onclick="openRemanente(${e.id})"><i class="fa-solid fa-calculator"></i> Remanente</button></td>`;
      tbody.appendChild(tr);
    });
  injectExportBar('table-entregas', 'Entregas');
  } catch(e) { console.error(e); }
}

async function openAddEntregaModal() {
  document.getElementById('form-entrega').reset();
  document.getElementById('entrega-id').value = '';
  document.getElementById('entrega-fecha').value = new Date().toISOString().split('T')[0];
  document.getElementById('entrega-items-container').innerHTML = '';
  await _loadEntregaSelects();
  openModal('modal-entrega');
}

async function _loadEntregaSelects() {
  const cRes = await fetch('/api/choferes');
  const cList = await cRes.json();
  const cSel = document.getElementById('entrega-chofer');
  cSel.innerHTML = '<option value="">-- Seleccionar --</option>';
  cList.forEach(c => { const o = document.createElement('option'); o.value=c.id; o.textContent=`${c.nombre} ${c.apellido||''}`.trim(); cSel.appendChild(o); });
  const vRes = await fetch('/api/vehiculos');
  const vList = await vRes.json();
  const vSel = document.getElementById('entrega-vehiculo');
  vSel.innerHTML = '<option value="">-- Sin asignar --</option>';
  vList.forEach(v => { const o = document.createElement('option'); o.value=v.id; o.textContent=`${v.patente} - ${v.marca||''} ${v.modelo||''}`.trim(); vSel.appendChild(o); });
}

function addEntregaItem() {
  const container = document.getElementById('entrega-items-container');
  const idx = container.children.length;
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:8px;align-items:center;';
  div.innerHTML = `
    <select style="flex:1;" class="entrega-item-prod">
      <option value="">-- Producto --</option>
      ${_cachedProductos.filter(p=>p.activo).map(p=>`<option value="${p.id}">${p.nombre} (Stock: ${p.stock_central})</option>`).join('')}
    </select>
    <input type="number" placeholder="Cant." min="1" style="width:80px;" class="entrega-item-qty">
    <button type="button" class="btn btn-secondary btn-sm" onclick="this.parentElement.remove()" style="color:var(--color-error);"><i class="fa-solid fa-times"></i></button>`;
  container.appendChild(div);
}

async function saveEntrega(e) {
  e.preventDefault();
  const items = [...document.querySelectorAll('.entrega-item-prod')].map((sel, i) => ({
    producto_id: sel.value,
    cantidad: document.querySelectorAll('.entrega-item-qty')[i].value
  })).filter(x => x.producto_id && x.cantidad > 0);
  if (!items.length) { showAlert('Agregá al menos un ítem'); return; }
  const body = {
    chofer_id: document.getElementById('entrega-chofer').value,
    vehiculo_id: document.getElementById('entrega-vehiculo').value || null,
    fecha_entrega: document.getElementById('entrega-fecha').value,
    notas: document.getElementById('entrega-notas').value || null,
    items
  };
  try {
    const res = await fetch('/api/stock-entregas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) { closeModal('modal-entrega'); loadStock(); showToast('Entrega registrada'); }
    else { const err = await res.json(); showAlert(err.message, 'error'); }
  } catch(e) { showAlert('Error al guardar entrega', 'error', 'error'); }
}

async function verEntregaItems(id) {
  const res = await fetch(`/api/stock-entregas/${id}/items`);
  const items = await res.json();
  const lines = items.map(i => `• ${i.producto_nombre}: entregados ${i.cantidad_entregada}, remanente ${i.cantidad_remanente ?? '?'}, vendidos ${i.cantidad_vendida ?? '?'} · $${Math.round((i.cantidad_vendida||0) * (i.precio_venta||0)).toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}`).join('\n');
  showAlert('Ítems de la entrega:\n\n' + lines);
}

async function openRemanente(entregaId) {
  const res = await fetch(`/api/stock-entregas/${entregaId}/items`);
  const items = await res.json();
  const lines = items.map(i => `${i.producto_nombre}: ${prompt(`Remanente de "${i.producto_nombre}" (entregados: ${i.cantidad_entregada})`, i.cantidad_remanente ?? '')}`);
  // save
  const rems = items.map((i, idx) => ({ item_id: i.id, cantidad_remanente: parseInt(lines[idx]) || 0 }));
  await fetch(`/api/stock-entregas/${entregaId}/remanente`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: rems }) });
  showToast('Remanente guardado');
  loadStock();
}

function showDupDialog(htmlMsg, dupId) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:var(--color-surface);border-radius:12px;padding:28px 32px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.3);">
        <div style="font-size:15px;line-height:1.5;margin-bottom:20px;">${htmlMsg}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;">
          <button id="dup-cancel" class="btn btn-secondary">Cancelar</button>
          <button id="dup-igual" class="btn btn-warning">Registrar de todas formas</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = val => { document.body.removeChild(overlay); resolve(val); };
    overlay.querySelector('#dup-cancel').onclick = () => close('cancel');
    overlay.querySelector('#dup-igual').onclick = () => close('igual');
    if (dupId) overlay.querySelector('#dup-ver').onclick = () => close('ver');
  });
}

// ──────────────────────────────────────────────────────────────
// RENDICIONES
// ──────────────────────────────────────────────────────────────

async function _populateRendChoferFilter() {
  const sel = document.getElementById('rend-filter-chofer');
  if (!sel || sel.dataset.loaded) return;
  try {
    const r = await fetch('/api/choferes'); const list = await r.json();
    list.forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.nombre; sel.appendChild(o); });
    sel.dataset.loaded = '1';
  } catch(_) {}
}

async function _populateRendCuentaFilter() {
  const sel = document.getElementById('rend-filter-cuenta');
  if (!sel || sel.dataset.loaded) return;
  try {
    const r = await fetch('/api/cuentas'); const list = await r.json();
    list.forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.alias || c.banco; sel.appendChild(o); });
    sel.dataset.loaded = '1';
  } catch(_) {}
}

async function loadRendiciones(silent = false) {
  await _populateRendChoferFilter();
  await _populateRendCuentaFilter();
  const desde   = document.getElementById('rend-filter-desde')?.value || '';
  const hasta   = document.getElementById('rend-filter-hasta')?.value || '';
  const chofer  = document.getElementById('rend-filter-chofer')?.value || '';
  const cuenta  = document.getElementById('rend-filter-cuenta')?.value || '';
  const params  = new URLSearchParams();
  if (desde)  params.set('desde',     desde);
  if (hasta)  params.set('hasta',     hasta);
  if (chofer) params.set('chofer_id', chofer);
  if (cuenta) params.set('cuenta_id', cuenta);
  try {
    const res  = await fetch('/api/rendiciones?' + params.toString());
    const data = await res.json();
    const tbody = document.getElementById('rendiciones-table-body');
    if (!tbody) return;
    let total = 0;
    tbody.innerHTML = data.map(r => {
      const monto = parseFloat(r.monto_total || 0);
      total += monto;
      const fecha = formatDate(r.fecha);
      const destino = r.cuenta_alias || r.medio_pago || '—';
      // Columna 📎: ícono imagen si hay comprobante
      const clipCol = r.comprobante_url
        ? `<button class="tbl-action-btn tbl-btn-detail" onclick="openDocViewer('${r.comprobante_url}','Comprobante',true)" title="Ver comprobante"><i class="fa-solid fa-image"></i></button>`
        : '—';

      // Botones del medio según estado de factura
      let middleBtns;
      if (r.factura_url) {
        // Ya tiene factura: mostrar PDF de factura + opción de reemplazar
        middleBtns = `<button class="tbl-action-btn tbl-btn-factura-pdf" onclick="openDocViewer('${r.factura_url}','Factura #${r.id}',true)" title="Ver factura PDF"><i class="fa-solid fa-file-pdf"></i></button>`
                   + `<button class="tbl-action-btn tbl-btn-clip" onclick="adjuntarFacturaPDF(${r.id})" title="Reemplazar PDF de factura"><i class="fa-solid fa-paperclip"></i></button>`;
      } else if (r.factura_ref === 'pending') {
        // Factura en proceso: cancelar + adjuntar manual
        middleBtns = `<button class="tbl-action-btn tbl-btn-pending" onclick="buscarFacturaWa(${r.id})" title="Buscar último PDF de Facturitas en WhatsApp y vincular"><i class="fa-brands fa-whatsapp fa-beat"></i></button>`
                   + `<button class="tbl-action-btn tbl-btn-clip" onclick="adjuntarFacturaPDF(${r.id})" title="Adjuntar PDF manualmente"><i class="fa-solid fa-paperclip"></i></button>`
                   + `<button class="tbl-action-btn tbl-btn-delete" onclick="cancelarFacturaPending(${r.id})" title="Cancelar — Facturitas no respondió"><i class="fa-solid fa-xmark"></i></button>`;
      } else {
        // Sin factura: AFIP directo + WA/Facturitas + clip manual
        middleBtns = `<button class="tbl-action-btn tbl-btn-afip" onclick="facturarAfip(${r.id})" title="Emitir Factura B directo en AFIP"><i class="fa-solid fa-a"></i></button>`
                   + `<button class="tbl-action-btn tbl-btn-facturar-pend" onclick="facturarRendicion(${r.id})" title="Pendiente de facturar — enviar via Facturitas"><i class="fa-solid fa-file-circle-plus"></i></button>`
                   + `<button class="tbl-action-btn tbl-btn-clip" onclick="adjuntarFacturaPDF(${r.id})" title="Adjuntar PDF de factura manualmente"><i class="fa-solid fa-paperclip"></i></button>`;
      }

      const rowStyle = r.factura_url ? 'background:rgba(239,68,68,0.06);' : '';
      return `<tr data-id="${r.id}" data-origen="${r._origen||'pagos'}" style="${rowStyle}">
        <td>${r.chofer_nombre||'—'}</td>
        <td>${destino}</td>
        <td>${fecha}</td>
        <td><strong>${formatCurrency(monto)}</strong></td>
        ${(() => {
            const esTransf = r.medio_pago === 'Transferencia' || r.medio_pago === 'MercadoPago';
            const sinCuenta = !r.cuenta_id_val;
            const imputado = parseFloat(r.imputado_total || 0);
            const monto_total = parseFloat(r.monto_total || 0);
            const sinImputar = esTransf && monto_total > 0 && imputado < monto_total - 0.01;
            const needsAttention = sinCuenta || sinImputar;
            const estadoBadge = needsAttention
              ? '<span class="badge badge-warning">Pendiente</span>'
              : '<span class="badge badge-success">Cobranza</span>';
            return `<td>${estadoBadge}</td>`;
          })()}
        <td>Op. ${r.nro_transaccion||'—'}</td>
        <td style="text-align:center;">${clipCol}</td>
        <td style="text-align:center;white-space:nowrap;">
          <button class="tbl-action-btn tbl-btn-view" onclick="viewRendicion(${r.id},'${r._origen||'pagos'}')" title="Ver detalle"><i class="fa-solid fa-eye"></i></button>
          ${(() => {
            const esTransf = r.medio_pago === 'Transferencia' || r.medio_pago === 'MercadoPago';
            const sinCuenta = !r.cuenta_id_val;
            const imputado = parseFloat(r.imputado_total || 0);
            const monto_total = parseFloat(r.monto_total || 0);
            const sinImputar = esTransf && monto_total > 0 && imputado < monto_total - 0.01;
            const needsAttention = sinCuenta || sinImputar;
            const tip = sinCuenta ? 'Cuenta no identificada — completar'
                      : sinImputar ? 'Transferencia pendiente de imputar — completar conceptos'
                      : 'Editar cobro';
            return `<button class="tbl-action-btn ${needsAttention ? 'tbl-btn-warn' : 'tbl-btn-edit'}" onclick="openPagoModal(${r.id})" title="${tip}"><i class="fa-solid ${needsAttention ? 'fa-clock' : 'fa-pen-to-square'}"></i></button>`;
          })()}
          ${middleBtns}
          <button class="tbl-action-btn tbl-btn-delete" onclick="deleteRendicion(${r.id})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');
    const badge = document.getElementById('rend-total-badge');
    if (badge) animateCounter(badge, total, v => formatCurrency(v));
    const rendCountBadge = document.getElementById('rend-count-badge');
    if (rendCountBadge) rendCountBadge.textContent = data.length ? `${data.length} cobranza${data.length !== 1 ? 's' : ''}` : '';
    const rendRow = document.getElementById('rend-totals-row');
    if (rendRow) rendRow.style.display = '';
    staggerTableRows(document.getElementById('rendiciones-table-body'));
    injectExportBar('table-rendiciones', 'Rendiciones');
  } catch(e) {
    if (!silent) showToast('Error al cargar rendiciones: ' + e.message, 'error');
  }
}

function filterRendicionesTable(q) {
  const rows = document.querySelectorAll('#rendiciones-table-body tr');
  const t = q.toLowerCase();
  rows.forEach(row => { row.style.display = row.textContent.toLowerCase().includes(t) ? '' : 'none'; });
}

function clearRendicionesFilters() {
  ['rend-filter-desde','rend-filter-hasta','rend-filter-chofer','rend-filter-cuenta','rendiciones-search-input'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el._ssSet) el._ssSet(''); else el.value = '';
  });
  filterRendicionesTable('');
  loadRendiciones();
}

async function buscarFacturaWa(id) {
  showToast('Buscando PDF en historial de WhatsApp...', 'info');
  try {
    const res = await fetch(`/api/pagos/${id}/factura-buscar-wa`, { method: 'POST' });
    const d   = await res.json();
    if (!res.ok) { showToast(d.message || 'No se encontró PDF', 'error'); return; }
    showToast('✅ Factura vinculada desde WhatsApp', 'success');
    loadRendiciones(true);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

async function cancelarFacturaPending(id) {
  const ok = await showConfirm('¿Cancelar la factura pendiente de Facturitas?\nEl cobro vuelve al estado sin factura.');
  if (!ok) return;
  try {
    const res = await fetch(`/api/pagos/${id}/factura-pending`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json(); showToast(d.message || 'Error', 'error'); return; }
    showToast('Pendiente cancelado', 'success');
    loadRendiciones(true);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

async function viewRendicion(id, origen) {
  openPagoModal(id, true);
}

async function deleteRendicion(id) {
  const ok = await showConfirm('¿Eliminar esta cobranza?');
  if (!ok) return;
  try {
    const res = await fetch(`/api/pagos/${id}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json(); showToast(d.message||'Error', 'error'); return; }
    showToast('Cobranza eliminada');
    loadRendiciones(true);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

async function facturarRendicion(id) {
  const ok = await showConfirm(`¿Facturar cobro #${id} via WhatsApp Facturitas?`);
  if (!ok) return;
  try {
    const res = await fetch(`/api/pagos/${id}/facturar`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showToast(data.message || 'Error al facturar', 'error'); return; }
    showToast('Factura solicitada — esperando PDF de Facturitas...', 'success');
    loadRendiciones(true);
    // Polling hasta que llegue el PDF (máx 60 seg, cada 4 seg)
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const r = await fetch(`/api/pagos/${id}`).then(x => x.json());
        if (r.factura_url) {
          clearInterval(poll);
          showToast('✓ Factura PDF vinculada correctamente', 'success');
          loadRendiciones(true);
        } else if (attempts >= 15) {
          clearInterval(poll);
          loadRendiciones(true);
        }
      } catch { clearInterval(poll); }
    }, 4000);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

async function consultarCuilAfip() {
  const cuil = document.getElementById('ch-cuil')?.value?.replace(/[-\s]/g, '');
  if (!cuil || cuil.length !== 11) { showToast('Ingresá un CUIL de 11 dígitos', 'error'); return; }
  const resDiv = document.getElementById('ch-afip-result');
  resDiv.style.display = 'block';
  resDiv.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Consultando AFIP...';
  try {
    const res  = await fetch(`/api/afip/contribuyente/${cuil}`);
    const data = await res.json();
    if (!res.ok) { resDiv.innerHTML = `<i class="fa-solid fa-circle-xmark" style="color:#ef4444"></i> ${data.message}`; return; }

    const nombre = data.razon_social || [data.nombre, data.apellido].filter(Boolean).join(' ') || '—';
    resDiv.innerHTML = `
      <i class="fa-solid fa-circle-check" style="color:#22c55e"></i>
      <strong>${nombre}</strong> &nbsp;·&nbsp; ${data.condicion_iva}
      ${data.estado !== 'ACTIVO' ? `&nbsp;<span style="color:#ef4444">(${data.estado})</span>` : ''}
      ${data.domicilio ? `<br><span style="color:var(--text-secondary)">${data.domicilio}</span>` : ''}
    `;

    // Auto-completar nombre/apellido si el form está vacío
    const fNombre   = document.getElementById('ch-nombre');
    const fApellido = document.getElementById('ch-apellido');
    if (fNombre   && !fNombre.value   && data.nombre)   fNombre.value   = data.nombre;
    if (fApellido && !fApellido.value && data.apellido) fApellido.value = data.apellido;
  } catch(e) {
    resDiv.innerHTML = `<i class="fa-solid fa-circle-xmark" style="color:#ef4444"></i> Error: ${e.message}`;
  }
}

async function facturarAfip(id) {
  // Intentar resolución automática: cuenta → propietario → contribuyente AFIP
  let contribId = null;
  try {
    const rAuto = await fetch(`/api/pagos/${id}/facturar-afip`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const dAuto = await rAuto.json();
    if (rAuto.ok) {
      showToast(`✓ Factura B emitida por ${dAuto.emisor} — CAE ${dAuto.cae}`, 'success');
      loadRendiciones(true);
      return;
    }
    // Si el error no es "no encontró contribuyente", mostrarlo y salir
    if (rAuto.status !== 400 || !dAuto.message?.includes('No se encontró')) {
      showToast(dAuto.message || 'Error AFIP', 'error');
      return;
    }
  } catch(e) { showToast('Error: ' + e.message, 'error'); return; }

  // Fallback: selección manual de contribuyente
  let contribs = [];
  try {
    const r = await fetch('/api/afip/contribuyentes');
    const all = await r.json();
    contribs = all.filter(c => c.activo && c.tiene_cert && c.tiene_key);
  } catch(e) { showToast('Error cargando contribuyentes AFIP', 'error'); return; }

  if (!contribs.length) {
    showToast('No hay contribuyentes AFIP con certificado cargado. Configurá uno en ARCA → Contribuyentes.', 'error');
    return;
  }

  const opts = contribs.map(c => `<option value="${c.id}">${c.nombre} (${c.cuit})</option>`).join('');
  contribId = await new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:400px">
        <div class="modal-header"><h3>Emitir Factura B · Cobro #${id}</h3></div>
        <div class="modal-body" style="padding:20px">
          <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">
            <i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i>
            La cuenta no tiene propietario/contribuyente AFIP vinculado. Seleccioná manualmente.
          </p>
          <label class="form-label">Contribuyente emisor</label>
          <select id="_afip-contrib-sel" class="form-control">${opts}</select>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="_afip-cancel">Cancelar</button>
          <button class="btn btn-primary" id="_afip-confirm"><i class="fa-solid fa-a"></i> Emitir</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#_afip-cancel').onclick  = () => { modal.remove(); resolve(null); };
    modal.querySelector('#_afip-confirm').onclick = () => { const v = modal.querySelector('#_afip-contrib-sel').value; modal.remove(); resolve(v); };
  });
  if (!contribId) return;

  try {
    const res  = await fetch(`/api/pagos/${id}/facturar-afip`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contribuyente_id: contribId })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.message || 'Error AFIP', 'error'); return; }
    showToast(`✓ Factura B emitida por ${data.emisor} — CAE ${data.cae}`, 'success');
    loadRendiciones(true);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

function adjuntarFacturaPDF(id) {
  // Input file oculto reutilizable
  let inp = document.getElementById('_fact-pdf-inp');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/pdf';
    inp.id = '_fact-pdf-inp'; inp.style.display = 'none';
    document.body.appendChild(inp);
  }
  inp.value = '';
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('pdf', file);
    showToast('Subiendo PDF...', 'info');
    try {
      const res = await fetch(`/api/pagos/${id}/factura-manual`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) { showToast(data.message || 'Error al subir PDF', 'error'); return; }
      showToast('✓ Factura PDF adjuntada correctamente', 'success');
      loadRendiciones(true);
    } catch(e) { showToast('Error: ' + e.message, 'error'); }
  };
  inp.click();
}

let _rendChartType = 'bar';
function setChartType(type, btn) {
  _rendChartType = type;
  document.querySelectorAll('.chart-type-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderRendicionesCharts();
}

async function openRendicionesCharts() {
  const desde  = document.getElementById('rend-filter-desde')?.value || '';
  const hasta  = document.getElementById('rend-filter-hasta')?.value || '';
  const chofer = document.getElementById('rend-filter-chofer')?.value || '';
  const cd = document.getElementById('chart-desde'); if (cd && desde) cd.value = desde;
  const ch = document.getElementById('chart-hasta'); if (ch && hasta) ch.value = hasta;
  openModal('modal-rendiciones-charts');
  await renderRendicionesCharts();
}

async function renderRendicionesCharts() {
  const desde  = document.getElementById('chart-desde')?.value || '';
  const hasta  = document.getElementById('chart-hasta')?.value || '';
  const params = new URLSearchParams();
  if (desde) params.set('desde', desde);
  if (hasta) params.set('hasta', hasta);
  try {
    const [rendRes, cpRes] = await Promise.all([
      fetch('/api/rendiciones?' + params),
      fetch('/api/rendiciones/stats-conceptos?' + params)
    ]);
    const rends = await rendRes.json();
    const conceptos = await cpRes.json();
    const showX      = document.getElementById('rend-chart-show-x')?.checked ?? true;
    const showY      = document.getElementById('rend-chart-show-y')?.checked ?? true;
    const showLabels = document.getElementById('rend-chart-show-labels')?.checked ?? false;
    const colors = [0,1,2,3,4].map(i => document.getElementById(`rend-color-${i}`)?.value || '#7F56D9');
    const txtColor   = document.getElementById('rend-color-txt')?.value || '#555';
    const total = rends.reduce((s, r) => s + parseFloat(r.monto_total||0), 0);
    const totalsEl = document.getElementById('rend-chart-totals');
    if (totalsEl) totalsEl.innerHTML = `
      <div style="background:var(--bg-secondary);border-radius:8px;padding:10px 16px;">
        <div style="font-size:11px;color:var(--text-secondary);">Total período</div>
        <div style="font-size:1.3rem;font-weight:700;">${formatCurrency(total)}</div>
      </div>
      <div style="background:var(--bg-secondary);border-radius:8px;padding:10px 16px;">
        <div style="font-size:11px;color:var(--text-secondary);">Registros</div>
        <div style="font-size:1.3rem;font-weight:700;">${rends.length}</div>
      </div>`;

    // Agrupar por medio de pago
    const byMedio = {};
    rends.forEach(r => { const k = r.medio_pago||'Sin especificar'; byMedio[k] = (byMedio[k]||0) + parseFloat(r.monto_total||0); });
    // Agrupar por cuenta
    const byCuenta = {};
    rends.forEach(r => { const k = r.cuenta_alias||'Efectivo'; byCuenta[k] = (byCuenta[k]||0) + parseFloat(r.monto_total||0); });
    // Agrupar por chofer (top 10)
    const byChofer = {};
    rends.forEach(r => { byChofer[r.chofer_nombre||'?'] = (byChofer[r.chofer_nombre||'?']||0) + parseFloat(r.monto_total||0); });
    const topChofer = Object.entries(byChofer).sort((a,b)=>b[1]-a[1]).slice(0,10);

    const PALETTE = [
      { top: '#818CF8', bot: '#4338CA' },
      { top: '#34D399', bot: '#047857' },
      { top: '#FB923C', bot: '#C2410C' },
      { top: '#60A5FA', bot: '#1D4ED8' },
      { top: '#F472B6', bot: '#BE185D' },
      { top: '#A78BFA', bot: '#6D28D9' },
      { top: '#FCD34D', bot: '#B45309' },
      { top: '#22D3EE', bot: '#0E7490' },
    ];
    const isPie = _rendChartType === 'pie';
    const gradPlugin = {
      id: 'rend_grad',
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea } = chart;
        if (!chartArea || isPie) return;
        const ds = chart.data.datasets[0];
        // Sobrescribimos backgroundColor con gradientes reales — Chart.js los usa en el mismo ciclo de dibujo
        ds.backgroundColor = chart.data.labels.map((_, i) => {
          const p = PALETTE[i % PALETTE.length];
          const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          g.addColorStop(0, p.top);
          g.addColorStop(1, p.bot);
          return g;
        });
      }
    };
    const shadowPlugin = {
      id: 'rend_shadow',
      beforeDatasetDraw(chart) {
        const ctx = chart.ctx;
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.30)';
        ctx.shadowBlur = 12;
        ctx.shadowOffsetX = 3;
        ctx.shadowOffsetY = 6;
      },
      afterDatasetDraw(chart) { chart.ctx.restore(); }
    };
    const chartOpts = (labels, data) => ({
      type: _rendChartType,
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length].top),
          borderColor:      labels.map((_, i) => PALETTE[i % PALETTE.length].bot),
          borderWidth: isPie ? 2 : 0,
          borderRadius: isPie ? 0 : 10,
          borderSkipped: false,
          hoverOffset: isPie ? 22 : 0,
          hoverBackgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length].top),
        }]
      },
      options: {
        responsive: true,
        animation: { duration: 900, easing: 'easeInOutQuart' },
        plugins: {
          legend: {
            display: isPie,
            labels: {
              color: txtColor, font: { size: 12, weight: '600' },
              padding: 16, usePointStyle: true, pointStyleWidth: 12
            }
          },
          datalabels: showLabels ? {
            anchor: 'end',
            align: 'top',
            color: txtColor,
            formatter: v => formatCurrency(v),
            font: { size: 10, weight: '700' },
            clip: false,
            clamp: true,
          } : false,
          tooltip: {
            backgroundColor: 'rgba(10,10,20,0.90)',
            titleColor: '#fff',
            bodyColor: '#94a3b8',
            borderColor: 'rgba(129,140,248,0.5)',
            borderWidth: 1,
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              label: ctx => '  ' + formatCurrency(ctx.parsed.y ?? ctx.parsed)
            }
          }
        },
        scales: isPie ? {} : {
          x: {
            display: showX,
            ticks: { color: txtColor, font: { size: 11 } },
            grid: { display: false }
          },
          y: {
            display: showY,
            ticks: {
              color: txtColor, font: { size: 10 },
              callback: v => '$' + (v >= 1000 ? (v/1000).toFixed(0) + 'k' : v)
            },
            grid: { color: 'rgba(148,163,184,0.10)', borderDash: [5, 5] }
          }
        }
      },
      plugins: [gradPlugin, shadowPlugin]
    });

    ['chart-by-medio','chart-by-cuenta','chart-by-chofer','chart-by-concepto'].forEach(id => {
      const c = document.getElementById(id); if (!c) return;
      if (c._chartInst) { c._chartInst.destroy(); c._chartInst = null; }
    });

    const cMedio = document.getElementById('chart-by-medio');
    if (cMedio) { const e = Object.entries(byMedio); cMedio._chartInst = new Chart(cMedio, chartOpts(e.map(x=>x[0]), e.map(x=>x[1]))); }
    const cCuenta = document.getElementById('chart-by-cuenta');
    if (cCuenta) { const e = Object.entries(byCuenta); cCuenta._chartInst = new Chart(cCuenta, chartOpts(e.map(x=>x[0]), e.map(x=>x[1]))); }
    const cChofer = document.getElementById('chart-by-chofer');
    if (cChofer) { cChofer._chartInst = new Chart(cChofer, chartOpts(topChofer.map(x=>x[0]), topChofer.map(x=>x[1]))); }
    const cConc = document.getElementById('chart-by-concepto');
    const nodata = document.getElementById('chart-concepto-nodata');
    if (cConc) {
      if (conceptos.length) {
        if (nodata) nodata.style.display = 'none';
        cConc._chartInst = new Chart(cConc, chartOpts(conceptos.map(c=>c.concepto), conceptos.map(c=>parseFloat(c.total))));
      } else {
        if (nodata) nodata.style.display = '';
      }
    }
  } catch(e) { showToast('Error al cargar gráficos: ' + e.message, 'error'); }
}

function exportRendicionesChartXLS() {
  showToast('Exportar XLS de gráficos no implementado', 'info');
}
function exportRendicionesChartWA() {
  showToast('Enviar por WA no implementado', 'info');
}

// ──────────────────────────────────────────────────────────────
// PEAJES
// ──────────────────────────────────────────────────────────────

// ── PERSONAS ────────────────────────────────────────────────────────────────

let _personaEditId = null;

async function loadPersonas() {
  const q = document.getElementById('personas-search-input')?.value?.trim() || '';
  const url = '/api/personas' + (q ? `?q=${encodeURIComponent(q)}` : '');
  const rows = await fetch(url).then(r => r.json()).catch(() => []);
  const tbody = document.getElementById('personas-tbody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;opacity:.5;padding:32px;">Sin registros</td></tr>`;
    return;
  }
  const canDel = canDelete();
  tbody.innerHTML = rows.map(p => {
    const vehs = p.vehiculos || [];
    const vehsHtml = vehs.length
      ? vehs.map(v => `
          <span class="badge ${v.activo ? 'badge-info' : 'badge-secondary'}"
                style="cursor:pointer;margin:1px;"
                onclick="event.stopPropagation();editVehiculo(${v.id})"
                title="${[v.marca, v.modelo, v.color].filter(Boolean).join(' ')}">
            <i class="fa-solid fa-car" style="font-size:9px;"></i> ${v.patente}
          </span>`).join('')
      : '<span style="opacity:.4;font-size:12px;">—</span>';

    return `
    <tr>
      <td><strong>${p.apellido || ''}${p.apellido && p.nombre ? ', ' : ''}${p.nombre || ''}</strong></td>
      <td>${p.dni || '—'}</td>
      <td>${p.cuil || '—'}</td>
      <td>${p.email ? `<a href="mailto:${p.email}" style="color:var(--accent-color)">${p.email}</a>` : '—'}</td>
      <td>${p.celular || '—'}</td>
      <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${p.domicilio||''}">${p.domicilio || '—'}</td>
      <td style="min-width:130px;">${vehsHtml}</td>
      <td><span class="badge ${p.activo ? 'badge-success' : 'badge-danger'}">${p.activo ? 'Activo' : 'Inactivo'}</span></td>
      <td style="white-space:nowrap;">
        <button class="tbl-action-btn tbl-btn-view"   onclick="openPersonaModal(${p.id},'vehiculos')" title="Ver vehículos"><i class="fa-solid fa-eye"></i></button>
        <button class="tbl-action-btn tbl-btn-edit"   onclick="openPersonaModal(${p.id})" title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
        ${canDel ? `<button class="tbl-action-btn tbl-btn-delete" onclick="deletePersona(${p.id},'${(p.nombre+' '+p.apellido).trim()}')" title="Eliminar"><i class="fa-solid fa-trash"></i></button>` : ''}
      </td>
    </tr>`;
  }).join('');
  injectExportBar('personas-table', 'Propietarios');
}

function switchPersonaTab(tab) {
  document.querySelectorAll('.ptab').forEach(b => b.classList.toggle('active', b.dataset.ptab === tab));
  document.querySelectorAll('.ptab-panel').forEach(p => p.style.display = 'none');
  const panel = document.getElementById('ptab-' + tab);
  if (panel) panel.style.display = (tab === 'foto') ? 'flex' : (tab === 'datos' ? 'grid' : 'block');

  // Botón contextual en footer-left
  const actionEl = document.getElementById('persona-tab-action');
  if (actionEl) {
    const pid = _personaEditId;
    if (tab === 'cuentas' && pid) {
      actionEl.innerHTML = `<button class="btn btn-primary btn-sm" onclick="closeModal('modal-persona');openCuentas(${pid})"><i class="fa-solid fa-plus"></i> Nueva Cuenta</button>`;
    } else if (tab === 'tarjetas' && pid) {
      actionEl.innerHTML = `<button class="btn btn-primary btn-sm" onclick="closeModal('modal-persona');openTarjetas();setTimeout(()=>openAddTarjetaForm(${pid}),400)"><i class="fa-solid fa-plus"></i> Nueva Tarjeta</button>
        <button class="btn btn-secondary btn-sm" style="margin-left:6px;" onclick="closeModal('modal-persona');openTarjetas()"><i class="fa-solid fa-credit-card"></i> Ver Tarjetas</button>`;
    } else if (tab === 'vehiculos' && pid) {
      actionEl.innerHTML = `<button class="btn btn-primary btn-sm" onclick="openAddVehiculoModal();setTimeout(()=>{const s=document.getElementById('vh-persona-id');if(s){s.value=${pid};_onVhPersonaChange(s);}},600)"><i class="fa-solid fa-plus"></i> Nuevo Vehículo</button>`;
    } else if (tab === 'services' && pid) {
      actionEl.innerHTML = `<button class="btn btn-primary btn-sm" onclick="closeModal('modal-persona');openAddServiceModal()"><i class="fa-solid fa-plus"></i> Nuevo Service</button>`;
    } else {
      actionEl.innerHTML = '';
    }
  }

  const pid = _personaEditId;
  if (!pid) return;

  if (tab === 'cuentas') _loadPersonaCuentas(pid);
  if (tab === 'tarjetas') _loadPersonaTarjetas(pid);
  if (tab === 'vehiculos') _loadPersonaVehiculos(pid);
  if (tab === 'services') _loadPersonaServices(pid);
  if (tab === 'foto') {
    setTimeout(() => {
      if (!_pLeafMap) _initPersonaLeafMap();
      const lat = parseFloat(document.getElementById('p-lat')?.value);
      const lng = parseFloat(document.getElementById('p-lng')?.value);
      if (!isNaN(lat) && !isNaN(lng)) _updatePersonaLeafMap(lat, lng);
      else if (_pLeafMap) _pLeafMap.invalidateSize();
    }, 120);
  }
}

async function _loadPersonaCuentas(pid) {
  const el = document.getElementById('persona-cuentas-content');
  el.innerHTML = '<span style="opacity:.5;">Cargando…</span>';
  if (!_cachedPersonasParaCuenta.length) {
    _cachedPersonasParaCuenta = await fetch('/api/personas').then(r => r.json()).catch(() => []);
  }
  const rows = await fetch(`/api/personas/${pid}/cuentas`).then(r => r.json()).catch(() => []);
  const p = _cachedPersonasParaCuenta?.find(x => x.id == pid);
  const pNombre = p ? `${p.apellido}, ${p.nombre}` : '';
  el.innerHTML = `
    ${!rows.length
      ? '<div style="opacity:.4;text-align:center;padding:24px;">Sin cuentas vinculadas</div>'
      : `<table class="table" style="font-size:13px;">
          <thead><tr><th></th><th>Banco</th><th>Alias</th><th>CBU/CVU</th><th></th></tr></thead>
          <tbody>${rows.map(c => `<tr>
            <td>${c.banco_emoji||''}</td>
            <td>${c.banco_nombre||'—'}</td>
            <td><strong>${c.alias||'—'}</strong></td>
            <td style="font-family:monospace;font-size:11px;">${c.cbu_cvu||'—'}</td>
            <td>
              <button class="btn btn-secondary btn-sm" title="Editar" onclick="closeModal('modal-persona');openCuentas(${pid});setTimeout(()=>editCuenta(${c.id}),400)">
                <i class="fa-solid fa-edit"></i>
              </button>
            </td>
          </tr>`).join('')}</tbody>
        </table>`
    }`;
}

async function _loadPersonaTarjetas(pid) {
  const el = document.getElementById('persona-tarjetas-content');
  el.innerHTML = '<span style="opacity:.5;">Cargando…</span>';
  const rows = await fetch(`/api/tarjetas?persona_id=${pid}`).then(r => r.json()).catch(() => []);
  if (!rows.length) {
    el.innerHTML = '<div style="opacity:.4;text-align:center;padding:32px;">Sin tarjetas vinculadas</div>';
    return;
  }
  el.innerHTML = `<table class="table" style="font-size:13px;">
    <thead><tr><th>Banco</th><th>Marca</th><th>Número</th><th></th></tr></thead>
    <tbody>${rows.map(t => `<tr>
      <td>${t.banco_emoji||''} ${t.banco_nombre||'—'}</td>
      <td>${t.marca||'—'}</td>
      <td style="font-family:monospace;letter-spacing:1px;">${t.nro_mascara || (t.ultimos_4 ? '•••• •••• •••• '+t.ultimos_4 : '—')}</td>
      <td>
        <button class="btn btn-secondary btn-sm" title="Editar" onclick="closeModal('modal-persona');openTarjetas();setTimeout(()=>editTarjeta(${t.id}),500)">
          <i class="fa-solid fa-edit"></i>
        </button>
      </td>
    </tr>`).join('')}</tbody>
  </table>`;
}

async function _loadPersonaVehiculos(pid) {
  const el = document.getElementById('persona-vehiculos-content');
  el.innerHTML = '<span style="opacity:.5;">Cargando…</span>';
  const vehs = await fetch(`/api/personas/${pid}/vehiculos`).then(r => r.json()).catch(() => []);
  if (!vehs.length) { el.innerHTML = '<div style="opacity:.4;text-align:center;padding:32px;">Sin vehículos vinculados</div>'; return; }
  el.innerHTML = `<table class="table" style="font-size:13px;">
    <thead><tr><th>Patente</th><th>Marca</th><th>Modelo</th><th>Año</th><th>Color</th><th></th></tr></thead>
    <tbody>${vehs.map(v => `<tr style="${v.activo?'':'opacity:.45'}">
      <td><strong>${v.patente}</strong></td>
      <td>${v.marca||'—'}</td>
      <td>${v.modelo||'—'}</td>
      <td>${v.año||'—'}</td>
      <td>${v.color||'—'}</td>
      <td><button class="tbl-action-btn tbl-btn-view" onclick="abrirVehiculoDesdePersona(${v.id})" title="Abrir vehículo"><i class="fa-solid fa-arrow-up-right-from-square"></i></button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

async function _loadPersonaServices(pid) {
  const el = document.getElementById('persona-services-content');
  el.innerHTML = '<span style="opacity:.5;">Cargando…</span>';
  const rows = await fetch(`/api/personas/${pid}/services`).then(r => r.json()).catch(() => []);
  if (!rows.length) { el.innerHTML = '<div style="opacity:.4;text-align:center;padding:32px;">Sin services registrados</div>'; return; }
  el.innerHTML = `<table class="table" style="font-size:12px;">
    <thead><tr><th>Fecha</th><th>Vehículo</th><th>Trabajo</th><th>Costo</th><th>Proveedor</th></tr></thead>
    <tbody>${rows.map(s => {
      const total = (+s.costo_materiales||0) + (+s.costo_mano_obra||0) + (+s.costo||0);
      return `<tr>
        <td>${s.fecha ? new Date(s.fecha).toLocaleDateString('es-AR') : '—'}</td>
        <td><span class="badge badge-info">${s.patente}</span> <small>${[s.marca,s.modelo].filter(Boolean).join(' ')}</small></td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(s.trabajo_realizado||s.tipo||s.descripcion||'').replace(/"/g,'&quot;')}">${s.trabajo_realizado||s.tipo||s.descripcion||'—'}</td>
        <td>${total ? '$'+total.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2}) : '—'}</td>
        <td>${s.proveedor_nombre||'—'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// ── Mapa interactivo Leaflet para Persona ────────────────────────────────────
let _pLeafMap = null;
let _pLeafMarker = null;

function _initPersonaLeafMap() {
  const container = document.getElementById('p-leaflet-map');
  if (!container || !window.L) return;
  if (_pLeafMap) { _pLeafMap.invalidateSize(); return; }

  // Centro Argentina por defecto
  const lat0 = -34.6037, lng0 = -58.3816;
  _pLeafMap = L.map('p-leaflet-map', { zoomControl: true }).setView([lat0, lng0], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19
  }).addTo(_pLeafMap);

  // Marcador draggable
  _pLeafMarker = L.marker([lat0, lng0], { draggable: true, opacity: 0 }).addTo(_pLeafMap);

  _pLeafMarker.on('dragend', () => {
    const ll = _pLeafMarker.getLatLng();
    document.getElementById('p-lat').value = ll.lat.toFixed(7);
    document.getElementById('p-lng').value = ll.lng.toFixed(7);
    _reverseGeocodePersona(ll.lat, ll.lng);
    _updatePersonaGpsStatus();
  });

  // Click en mapa mueve el marcador
  _pLeafMap.on('click', e => {
    _pLeafMarker.setLatLng(e.latlng).setOpacity(1);
    document.getElementById('p-lat').value = e.latlng.lat.toFixed(7);
    document.getElementById('p-lng').value = e.latlng.lng.toFixed(7);
    _reverseGeocodePersona(e.latlng.lat, e.latlng.lng);
    _updatePersonaGpsStatus();
  });
}

function _updatePersonaLeafMap(lat, lng, label) {
  if (!window.L) return;
  const mapDiv = document.getElementById('p-leaflet-map');
  if (!mapDiv) return;
  // Inicializar si no existe
  if (!_pLeafMap) _initPersonaLeafMap();
  if (!_pLeafMap || !_pLeafMarker) return;
  const ll = L.latLng(lat, lng);
  _pLeafMarker.setLatLng(ll).setOpacity(1);
  _pLeafMap.setView(ll, 17);
  if (label) _pLeafMarker.bindPopup(`<b>${label}</b>`).openPopup();
  setTimeout(() => _pLeafMap.invalidateSize(), 100);
}

function _onPersonaLatLngChange() {
  const lat = parseFloat(document.getElementById('p-lat')?.value);
  const lng = parseFloat(document.getElementById('p-lng')?.value);
  if (!isNaN(lat) && !isNaN(lng)) {
    _updatePersonaLeafMap(lat, lng);
    _updatePersonaGpsStatus();
  }
}

function _centerPersonaMap() {
  const lat = parseFloat(document.getElementById('p-lat')?.value);
  const lng = parseFloat(document.getElementById('p-lng')?.value);
  if (!isNaN(lat) && !isNaN(lng) && _pLeafMap) {
    _pLeafMap.setView([lat, lng], 17);
  }
}

function _abrirTabMapaPersona() {
  switchPersonaTab('foto');
  setTimeout(() => {
    if (!_pLeafMap) _initPersonaLeafMap();
    const lat = parseFloat(document.getElementById('p-lat')?.value);
    const lng = parseFloat(document.getElementById('p-lng')?.value);
    if (!isNaN(lat) && !isNaN(lng)) _updatePersonaLeafMap(lat, lng);
    else _pLeafMap?.invalidateSize();
  }, 150);
}

async function _geocodificarYAbrirMapaPersona() {
  await _geocodificarPersona();
  switchPersonaTab('foto');
  setTimeout(() => _pLeafMap?.invalidateSize(), 150);
}

async function _geocodificarPersona() {
  const dom = document.getElementById('p-domicilio')?.value?.trim();
  const loc = document.getElementById('p-localidad')?.value?.trim();
  const ref = document.getElementById('p-referencia')?.value?.trim();
  const cp  = document.getElementById('p-cp')?.value?.trim();
  if (!dom && !ref) return showAlert('Ingresá un domicilio primero');
  const status = document.getElementById('p-gps-status');
  if (status) { status.textContent = 'Buscando…'; status.style.color = 'var(--placeholder-color)'; }
  // Intentos: nombre oficial primero, luego referencia/nombre anterior como fallback
  const queries = [
    [dom, loc, cp, 'Argentina'].filter(Boolean).join(', '),
    [dom, loc, 'Argentina'].filter(Boolean).join(', '),
    [dom, cp, 'Argentina'].filter(Boolean).join(', '),
    [dom, 'Argentina'].filter(Boolean).join(', '),
    ref ? [ref, loc, cp, 'Argentina'].filter(Boolean).join(', ') : null,
    ref ? [ref, loc, 'Argentina'].filter(Boolean).join(', ') : null,
    ref ? [ref, 'Argentina'].join(', ') : null,
  ].filter(Boolean).filter((q, i, arr) => arr.indexOf(q) === i);
  try {
    let found = null;
    for (const q of queries) {
      const res = await fetch(`/api/geocode?address=${encodeURIComponent(q)}`);
      const d = await res.json();
      if (d.lat) { found = d; break; }
    }
    if (!found) { if (status) { status.textContent = '⚠️ No encontrado'; status.style.color = 'orange'; } return; }
    const lat = found.lat, lng = found.lng;
    document.getElementById('p-lat').value = lat.toFixed(7);
    document.getElementById('p-lng').value = lng.toFixed(7);
    _updatePersonaLeafMap(lat, lng, dom);
    _updatePersonaGpsStatus();
    const addrEl = document.getElementById('p-map-addr');
    if (addrEl) addrEl.textContent = found.display || '';
    const mapBtn = document.getElementById('p-map-btn');
    if (mapBtn) mapBtn.style.display = '';
  } catch { if (status) { status.textContent = 'Error al geocodificar'; status.style.color = 'red'; } }
}

async function _reverseGeocodePersona(lat, lng) {
  const addrEl = document.getElementById('p-map-addr');
  if (!addrEl) return;
  addrEl.textContent = 'Obteniendo dirección…';
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`, {
      headers: { 'Accept-Language': 'es' }
    });
    const data = await res.json();
    const addr = data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    addrEl.textContent = addr;
    // Proponer actualizar domicilio
    const dom = document.getElementById('p-domicilio');
    if (dom && !dom.value.trim()) {
      const road = data.address?.road || '';
      const num  = data.address?.house_number || '';
      const city = data.address?.city || data.address?.town || data.address?.village || '';
      if (road) dom.value = [road + (num ? ' ' + num : ''), city].filter(Boolean).join(', ');
    }
  } catch { addrEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`; }
}

function _updatePersonaGpsStatus() {
  const lat = document.getElementById('p-lat')?.value;
  const lng = document.getElementById('p-lng')?.value;
  const status = document.getElementById('p-gps-status');
  const mapBtn = document.getElementById('p-map-btn');
  if (lat && lng) {
    if (status) { status.textContent = `📍 GPS: ${parseFloat(lat).toFixed(5)}, ${parseFloat(lng).toFixed(5)}`; status.style.color = 'var(--color-success)'; }
    if (mapBtn) mapBtn.style.display = '';
  } else {
    if (status) status.textContent = '';
    if (mapBtn) mapBtn.style.display = 'none';
  }
}

// Stub para compatibilidad con código que llama _updatePersonaMap / _openPersonaGoogleMaps
function _updatePersonaMap() { _onPersonaLatLngChange(); }
function _openPersonaGoogleMaps() { _abrirTabMapaPersona(); }

function _previewPersonaDoc(input, prevId, dzId, eyeId) {
  const file = input.files[0];
  if (!file) return;
  const img = document.getElementById(prevId);
  if (img) { img.src = URL.createObjectURL(file); img.style.display = 'block'; }
  const dz = document.getElementById(dzId);
  if (dz) dz.classList.add('has-img');
  const eye = document.getElementById(eyeId);
  if (eye) eye.style.display = 'flex';
}

function _handlePersonaDocDrop(event, inputId, prevId, dzId, eyeId) {
  event.preventDefault();
  const dz = document.getElementById(dzId);
  if (dz) dz.classList.remove('dz-over');
  const file = event.dataTransfer?.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;
  const input = document.getElementById(inputId);
  if (input) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
  }
  _previewPersonaDoc({ files: [file] }, prevId, dzId, eyeId);
}

function _resetPersonaDniDropzones() {
  [['p-drop-dni-frente','p-file-dni-frente','p-prev-dni-frente','p-eye-dni-frente'],
   ['p-drop-dni-dorso', 'p-file-dni-dorso', 'p-prev-dni-dorso', 'p-eye-dni-dorso']].forEach(([dz,fi,pr,ey]) => {
    const dzEl = document.getElementById(dz);
    if (dzEl) dzEl.classList.remove('has-img');
    const prEl = document.getElementById(pr);
    if (prEl) { prEl.src = ''; prEl.style.display = 'none'; }
    const fiEl = document.getElementById(fi);
    if (fiEl) fiEl.value = '';
    const eyEl = document.getElementById(ey);
    if (eyEl) eyEl.style.display = 'none';
  });
}

function _loadPersonaDniImages(p) {
  if (p.dni_frente_url) {
    const img = document.getElementById('p-prev-dni-frente');
    if (img) { img.src = p.dni_frente_url; img.style.display = 'block'; }
    document.getElementById('p-drop-dni-frente')?.classList.add('has-img');
    const eye = document.getElementById('p-eye-dni-frente');
    if (eye) eye.style.display = 'flex';
  }
  if (p.dni_dorso_url) {
    const img = document.getElementById('p-prev-dni-dorso');
    if (img) { img.src = p.dni_dorso_url; img.style.display = 'block'; }
    document.getElementById('p-drop-dni-dorso')?.classList.add('has-img');
    const eye = document.getElementById('p-eye-dni-dorso');
    if (eye) eye.style.display = 'flex';
  }
}

function _onPersonaFotoChange(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = document.getElementById('p-avatar-preview');
    if (img) img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  document.getElementById('p-foto-lbl').textContent = file.name;
}

async function openPersonaModal(id = null, openTab = null) {
  _personaEditId = id;
  document.getElementById('persona-modal-title').innerHTML = id
    ? '<i class="fa-solid fa-id-card"></i> Editar Propietario'
    : '<i class="fa-solid fa-id-card"></i> Nuevo Propietario';
  // El subtítulo se actualiza después de cargar los datos (ver más abajo)

  // Reset
  ['nombre','apellido','dni','cuil','email','celular','domicilio','localidad','referencia','entre-calles','cp','lat','lng'].forEach(f => {
    const el = document.getElementById('p-'+f); if (el) el.value = '';
  });
  // Reset mapa Leaflet
  if (_pLeafMarker) _pLeafMarker.setOpacity(0);
  const addrEl = document.getElementById('p-map-addr');
  if (addrEl) addrEl.textContent = '';
  const gpsStatus = document.getElementById('p-gps-status');
  if (gpsStatus) gpsStatus.textContent = '';
  const mapBtn = document.getElementById('p-map-btn');
  if (mapBtn) mapBtn.style.display = 'none';
  document.getElementById('p-activo').checked = true;
  const avatarEl = document.getElementById('p-avatar-preview');
  if (avatarEl) avatarEl.src = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'><circle cx='40' cy='30' r='18' fill='%23aaa'/><ellipse cx='40' cy='70' rx='28' ry='18' fill='%23aaa'/></svg>";
  const fotoInput = document.getElementById('p-foto-input');
  if (fotoInput) fotoInput.value = '';
  const fotoLbl = document.getElementById('p-foto-lbl');
  if (fotoLbl) fotoLbl.textContent = 'JPG / PNG / WEBP';

  // Reset DNI dropzones
  _resetPersonaDniDropzones();

  // Reset tabs
  switchPersonaTab('datos');

  if (id) {
    const p = await fetch(`/api/personas/${id}`).then(r => r.json()).catch(() => null);
    if (p) {
      document.getElementById('p-nombre').value    = p.nombre || '';
      document.getElementById('p-apellido').value  = p.apellido || '';
      document.getElementById('p-dni').value       = p.dni || '';
      document.getElementById('p-cuil').value      = p.cuil || '';
      document.getElementById('p-email').value     = p.email || '';
      document.getElementById('p-celular').value   = p.celular || '';
      document.getElementById('p-telegram-chat-id').value = p.telegram_chat_id || '';
      document.getElementById('p-domicilio').value    = p.domicilio || '';
      document.getElementById('p-localidad').value    = p.localidad || '';
      document.getElementById('p-referencia').value   = p.referencia || '';
      document.getElementById('p-entre-calles').value  = p.entre_calles || '';
      document.getElementById('p-cp').value            = p.codigo_postal || '';
      if (p.lat) document.getElementById('p-lat').value = p.lat;
      if (p.lng) document.getElementById('p-lng').value = p.lng;
      // Mostrar botón mapa y status si ya tiene coordenadas
      const mapBtn = document.getElementById('p-map-btn');
      const gpsStatus = document.getElementById('p-gps-status');
      if (p.lat && p.lng) {
        if (mapBtn) mapBtn.style.display = '';
        if (gpsStatus) { gpsStatus.textContent = '📍 GPS guardado'; gpsStatus.style.color = 'var(--color-success)'; }
      } else {
        if (mapBtn) mapBtn.style.display = 'none';
        if (gpsStatus) gpsStatus.textContent = '';
      }
      document.getElementById('p-activo').checked  = !!p.activo;
      if (p.foto_url && avatarEl) avatarEl.src = p.foto_url;
      _loadPersonaDniImages(p);
      _setModalTitle('persona-modal-title', '<i class="fa-solid fa-id-card"></i>', 'Editar Propietario',
        p.apellido ? `${p.apellido}, ${p.nombre||''}` : p.nombre);
    }
  }
  openModal('modal-persona');
  if (openTab) switchPersonaTab(openTab);
}

async function savePersona() {
  const nombre   = document.getElementById('p-nombre').value.trim();
  const apellido = document.getElementById('p-apellido').value.trim();
  if (!nombre || !apellido) return showAlert('Nombre y apellido son requeridos');
  const body = {
    nombre, apellido,
    dni:          document.getElementById('p-dni').value.trim() || null,
    cuil:         document.getElementById('p-cuil').value.trim() || null,
    email:        document.getElementById('p-email').value.trim() || null,
    celular:           normalizarCelular(document.getElementById('p-celular').value.trim()) || null,
    telegram_chat_id:  document.getElementById('p-telegram-chat-id').value.trim() || null,
    domicilio:    document.getElementById('p-domicilio').value.trim() || null,
    localidad:    document.getElementById('p-localidad').value.trim() || null,
    referencia:   document.getElementById('p-referencia').value.trim() || null,
    entre_calles: document.getElementById('p-entre-calles').value.trim() || null,
    codigo_postal:document.getElementById('p-cp').value.trim() || null,
    lat:          document.getElementById('p-lat').value || null,
    lng:          document.getElementById('p-lng').value || null,
    activo:       document.getElementById('p-activo').checked ? 1 : 0,
  };
  const url    = _personaEditId ? `/api/personas/${_personaEditId}` : '/api/personas';
  const method = _personaEditId ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) return showAlert(data.message || 'Error al guardar');
  const savedId = _personaEditId || data.id;

  if (savedId) {
    // Subir foto perfil si se seleccionó
    const fotoInput = document.getElementById('p-foto-input');
    if (fotoInput?.files?.length) {
      const fd = new FormData();
      fd.append('foto', fotoInput.files[0]);
      await fetch(`/api/personas/${savedId}/foto`, { method: 'POST', body: fd }).catch(() => {});
    }
    // Subir DNI frente/dorso si se seleccionaron
    const dniFr = document.getElementById('p-file-dni-frente');
    const dniDo = document.getElementById('p-file-dni-dorso');
    if (dniFr?.files?.length || dniDo?.files?.length) {
      const fd2 = new FormData();
      if (dniFr?.files?.length) fd2.append('dni_frente', dniFr.files[0]);
      if (dniDo?.files?.length) fd2.append('dni_dorso',  dniDo.files[0]);
      await fetch(`/api/personas/${savedId}/upload-docs`, { method: 'POST', body: fd2 }).catch(() => {});
    }
  }

  closeModal('modal-persona');
  loadPersonas();
  _refreshPersonasCombos();
}

async function deletePersona(id, nombre) {
  if (!await showConfirm(`¿Eliminar a <strong>${nombre}</strong>?<br><small>Se desvinculará de vehículos y cuentas asociadas.</small>`)) return;
  const res = await fetch(`/api/personas/${id}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) return showAlert(data.message || 'Error al eliminar');
  loadPersonas();
}

// Cache de personas para los combos en otros módulos
let _personasCache = [];
async function _loadPersonasCache() {
  _personasCache = await fetch('/api/personas').then(r => r.json()).catch(() => []);
  return _personasCache;
}
function _refreshPersonasCombos() {
  _loadPersonasCache().then(lista => {
    document.querySelectorAll('select.persona-select').forEach(sel => {
      const cur = sel.value;
      sel.innerHTML = '<option value="">— Sin propietario —</option>' +
        lista.map(p => `<option value="${p.id}" ${p.id==cur?'selected':''}>${p.apellido}, ${p.nombre}${p.dni?' ('+p.dni+')':''}</option>`).join('');
      SmartCombo.refresh(sel);
    });
  });
}

async function seedPersonas() {
  if (!await showConfirm(
    '¿Importar propietarios desde <strong>Cuentas</strong> y <strong>Vehículos</strong>?<br>' +
    '<small style="opacity:.7;">Se usa el DNI como clave. No se borran registros existentes,<br>solo se insertan nuevos y se enriquecen los vacíos.</small>'
  )) return;

  const res  = await fetch('/api/personas/seed', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) return showAlert(data.message || 'Error al importar');

  await showAlert(
    `<i class="fa-solid fa-circle-check" style="color:var(--accent-green);font-size:20px;"></i><br><br>` +
    `<strong>${data.total}</strong> propietarios únicos procesados<br>` +
    `✦ ${data.insertados} insertados nuevos<br>` +
    `✦ ${data.actualizados} enriquecidos<br>` +
    `✦ ${data.vinculados} vínculos actualizados`
  );
  loadPersonas();
}

// ── PRÉSTAMOS ────────────────────────────────────────────────────────────────

let _prestamoEditId   = null;
let _cuotasPrestamoId = null;
let _cuotasParsed     = [];

const _FMT_MONEY = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _FMT_DATE  = new Intl.DateTimeFormat('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });

function _fmtMoney(v)  { return _FMT_MONEY.format(+v || 0); }
function _fmtDateLocal(iso) {
  if (!iso) return '—';
  const [y,m,d] = String(iso).slice(0,10).split('-');
  return `${d}/${m}/${y}`;
}
function _parseMoney(s) {
  // Acepta: 465.556,18  /  465556.18  /  465,556.18
  if (!s) return null;
  s = String(s).trim();
  // Si tiene coma decimal (formato AR): quitar puntos de miles, reemplazar coma por punto
  if (/\d,\d{1,2}$/.test(s)) s = s.replace(/\./g,'').replace(',','.');
  else s = s.replace(/,/g,'');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function _parseDate(s) {
  // Acepta: DD/MM/AAAA  o  AAAA-MM-DD  o  Excel serial (number)
  if (!s && s !== 0) return null;
  s = String(s).trim();
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [d,m,y] = s.split('/');
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  // Excel serial date
  const n = parseInt(s);
  if (!isNaN(n) && n > 40000) {
    const d = new Date((n - 25569) * 86400000);
    return d.toISOString().slice(0,10);
  }
  return null;
}

// ── Cache cuentas y vehículos para los combos ─────────────────────────────
let _prCuentasCache   = [];
let _prVehiculosCache = [];

async function _loadPrCaches() {
  [_prCuentasCache, _prVehiculosCache] = await Promise.all([
    fetch('/api/cuentas').then(r=>r.json()).catch(()=>[]),
    fetch('/api/vehiculos').then(r=>r.json()).catch(()=>[]),
  ]);
}

function _fillPrCuentaSelect(selId, curVal) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  sel.innerHTML = '<option value="">— Sin cuenta —</option>' +
    _prCuentasCache.map(c => {
      // Orden: 1º Banco/Entidad  2º Propietario  3º CBU/CVU  4º Alias
      const banco    = [c.banco_emoji, c.banco_nombre].filter(Boolean).join(' ') || 'Sin banco';
      const propietario = c.persona_apellido
        ? `${c.persona_apellido}, ${c.persona_nombre}`
        : [c.apellido, c.nombre].filter(Boolean).join(', ') || '—';
      const cbu      = c.cbu_cvu ? c.cbu_cvu.slice(0,8)+'…' : '—';
      const alias    = c.alias || '—';
      const label    = `${banco}  ·  ${propietario}  ·  ${cbu}  ·  ${alias}`;
      return `<option value="${c.id}" ${c.id==curVal?'selected':''}>${label}</option>`;
    }).join('');
  SmartCombo.refresh(sel);
}

function _fillPrVehiculoSelect(selId, curVal) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  sel.innerHTML = '<option value="">— Sin vehículo —</option>' +
    _prVehiculosCache.filter(v=>v.activo).map(v => {
      const persona = v.persona_apellido ? `${v.persona_apellido}, ${v.persona_nombre}` : (v.titular_nombre||'');
      return `<option value="${v.id}" ${v.id==curVal?'selected':''}>${v.patente}${persona?' — '+persona:''}</option>`;
    }).join('');
  SmartCombo.refresh(sel);
}

function _onPrCuentaChange(sel) {
  const c    = _prCuentasCache.find(x=>x.id==sel.value);
  const info = document.getElementById('pr-persona-info');
  if (!info) return;
  if (!c) { info.textContent=''; return; }
  const partes = [[c.apellido,c.nombre].filter(Boolean).join(', '), c.dni?'DNI '+c.dni:null, c.cuil?'CUIL '+c.cuil:null].filter(Boolean);
  info.textContent = partes.length ? '👤 '+partes.join(' · ') : '';
}

function _onPrVehiculoChange(sel) {
  const v    = _prVehiculosCache.find(x=>x.id==sel.value);
  const info = document.getElementById('pr-vehiculo-persona-info');
  if (!info) return;
  if (!v) { info.textContent=''; return; }
  const persona = v.persona_apellido ? `${v.persona_apellido}, ${v.persona_nombre}` : (v.titular_nombre||'');
  info.textContent = persona ? '👤 '+persona+(v.persona_dni||v.titular_dni?' · DNI '+(v.persona_dni||v.titular_dni):'') : '';
}

// ──────────────────────────────────────────────────────────────────────────
// TURNOS
// ──────────────────────────────────────────────────────────────────────────
let _turnoEditId = null;
let _turnoNovedadFile = null;

// ── Instancias DropZone para km de turno ─────────────────────────────────────
let _dzKmInicio = null;
let _dzKmFin    = null;
let _dzAceite   = null;

function _parseArchivoTablero(filename) {
  // Formato: PATENTE - YYYY-MM-DD HHhsMM.ext  (ej: FNJ894 - 2026-06-15 18hs40.jpeg)
  const m = filename.match(/^([A-Z0-9]+)\s*-\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2})hs(\d{2})/i);
  if (!m) return null;
  const [, patente, fecha, hh, mm] = m;
  return {
    patente: patente.toUpperCase(),
    datetime: `${fecha}T${String(hh).padStart(2,'0')}:${mm}`,
  };
}

function _initTurnoKmDropzones() {
  // Solo crear una vez — el HTML del mount ya existe en el modal
  if (_dzKmInicio) return;

  const _onKmExtract = (tipo) => (data) => {
    // km
    if (data.km) {
      const el = document.getElementById(`tur-km-${tipo}`);
      if (el) { el.value = data.km; fmtKmInput(el); calcTurno(); }
    }
    // combustible
    const hComb = document.getElementById(`tur-combustible-${tipo}`);
    if (hComb && data.combustible) hComb.value = data.combustible;
    // foto_url guardada por el servidor
    const hFoto = document.getElementById(`tur-foto-km-${tipo}`);
    if (hFoto && data.foto_url) hFoto.value = data.foto_url;
    // feedback en status
    const combIcon = data.combustible ? ` · ${_COMBUSTIBLE_ICON[data.combustible]||''} ${data.combustible}` : '';
    const kmTxt    = data.km ? `✓ ${parseInt(data.km,10).toLocaleString('es-AR')} km${combIcon}` : '';
    if (kmTxt) (tipo==='inicio' ? _dzKmInicio : _dzKmFin)?._setStatus(kmTxt, 'ok');
    _turCheckCombustible();
  };

  const _onKmFileSet = (tipo) => (file) => {
    const parsed = _parseArchivoTablero(file.name);
    if (!parsed) return;

    // Fecha/hora
    const fieldId = tipo === 'inicio' ? 'tur-inicio' : 'tur-fin';
    const elFecha = document.getElementById(fieldId);
    if (elFecha) {
      elFecha.value = parsed.datetime;
      if (elFecha._ssSet) elFecha._ssSet(parsed.datetime);
    }

    // Vehículo por patente (solo en km-inicio, y solo si no hay vehículo seleccionado)
    if (tipo === 'inicio' && parsed.patente) {
      const selV = document.getElementById('tur-vehiculo');
      if (selV && !selV.value) {
        const opt = [...selV.options].find(o =>
          o.textContent.toUpperCase().startsWith(parsed.patente)
        );
        if (opt) {
          selV.value = opt.value;
          selV._ssSet?.(opt.value);
          selV._scRefresh?.();
        }
      }
    }

    calcTurno();
  };

  _dzKmInicio = new DropZone({
    mountId:   'tur-km-inicio-mount',
    id:        'tur-km-inicio-dz',
    label:     'Tablero — IA lee odómetro y combustible',
    icon:      'fa-gauge-high',
    task:      'tablero',
    onExtract: _onKmExtract('inicio'),
    onFileSet: _onKmFileSet('inicio'),
  });

  _dzKmFin = new DropZone({
    mountId:   'tur-km-fin-mount',
    id:        'tur-km-fin-dz',
    label:     'Tablero — IA lee odómetro y combustible',
    icon:      'fa-gauge-high',
    task:      'tablero',
    onExtract: _onKmExtract('fin'),
    onFileSet: _onKmFileSet('fin'),
  });

  _dzAceite = new DropZone({
    mountId:   'tur-aceite-mount',
    id:        'tur-aceite-dz',
    label:     'Foto varilla — IA determina nivel de aceite',
    icon:      'fa-oil-can',
    task:      'aceite',
    onExtract: (data) => {
      const hNivel = document.getElementById('tur-aceite-nivel');
      if (hNivel) hNivel.value = data.nivel || '';
      // foto_url viene del servidor
      const hFoto = document.getElementById('tur-foto-aceite');
      if (hFoto) hFoto.value = data.foto_url || '';
      const _ACEITE_ICON = { normal:'🟢', bajo:'🔴', alto:'🟠', sin_aceite:'⚫' };
      const icon = _ACEITE_ICON[data.nivel] || '❓';
      const label = { normal:'Normal', bajo:'Bajo — ¡requiere atención!', alto:'Alto', sin_aceite:'Sin aceite detectado' }[data.nivel] || data.nivel || '?';
      const obs = data.observacion ? ` · ${data.observacion}` : '';
      _dzAceite._setStatus(`${icon} Aceite: ${label}${obs}`, data.nivel === 'bajo' || data.nivel === 'sin_aceite' ? 'error' : 'ok');
    },
  });
}
const _COMBUSTIBLE_ORDER = ['E','1/4','1/2','3/4','F'];
const _COMBUSTIBLE_ICON  = { 'E':'🔴', '1/4':'🟠', '1/2':'🟡', '3/4':'🟢', 'F':'🟢' };

async function _turKmRunAI(tipo) {
  const file = _turKmFiles[tipo];
  if (!file) { dzSetStatus(`tur-km-${tipo}-dropzone`, '⚠ Cargá una foto del tablero primero', 'warn'); return; }
  const btn = document.getElementById(`dz-ai-tur-km-${tipo}-dropzone`);
  if (btn) btn.disabled = true;
  dzSetStatus(`tur-km-${tipo}-dropzone`, '⏳ IA leyendo tablero...', 'info');
  try {
    const fd = new FormData();
    fd.append('imagen', file);
    const res = await fetch('/api/ai/extract-km', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).message);
    const d = await res.json();
    if (!d.km) throw new Error('No se pudo leer el odómetro');
    // Km
    const el = document.getElementById(`tur-km-${tipo}`);
    el.value = d.km;
    fmtKmInput(el);
    calcTurno();
    // Guardar URL foto y combustible en hidden
    const hFoto = document.getElementById(`tur-foto-km-${tipo}`);
    const hComb = document.getElementById(`tur-combustible-${tipo}`);
    if (hFoto) hFoto.value = d.foto_url || '';
    if (hComb) hComb.value = d.combustible || '';
    // Estado en toolbar
    const combIcon = d.combustible ? ` · ${_COMBUSTIBLE_ICON[d.combustible]||''} ${d.combustible}` : '';
    dzSetStatus(`tur-km-${tipo}-dropzone`, `✓ ${parseInt(d.km,10).toLocaleString('es-AR')} km${combIcon}`, 'ok');
    // Comparar combustible si tenemos los dos
    _turCheckCombustible();
  } catch(err) {
    dzSetStatus(`tur-km-${tipo}-dropzone`, '✗ ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function _turCheckCombustible() {
  const ci = document.getElementById('tur-combustible-inicio')?.value;
  const cf = document.getElementById('tur-combustible-fin')?.value;
  const wrap = document.getElementById('tur-combustible-alert-wrap');
  const box  = document.getElementById('tur-combustible-alert');
  if (!wrap || !box) return;
  if (!ci || !cf) { wrap.style.display = 'none'; return; }
  const idxI = _COMBUSTIBLE_ORDER.indexOf(ci);
  const idxF = _COMBUSTIBLE_ORDER.indexOf(cf);
  if (idxI === -1 || idxF === -1) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  if (idxF < idxI) {
    // Bajó el combustible
    box.style.background = '#fff3cd';
    box.style.color = '#92400e';
    box.style.border = '1px solid #f59e0b';
    box.innerHTML = `⛽ Combustible bajó de <strong>${ci}</strong> → <strong>${cf}</strong> — El chofer debe cargar nafta`;
  } else if (idxF === idxI) {
    box.style.background = '#f0fdf4';
    box.style.color = '#166534';
    box.style.border = '1px solid #22c55e';
    box.innerHTML = `⛽ Combustible sin cambios: <strong>${cf}</strong>`;
  } else {
    box.style.background = '#f0fdf4';
    box.style.color = '#166534';
    box.style.border = '1px solid #22c55e';
    box.innerHTML = `⛽ Combustible aumentó de <strong>${ci}</strong> → <strong>${cf}</strong> ✓`;
  }
}

// ── Dropzone foto novedad ────────────────────────────────────────────────────
function turNovedadDrop(e) {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) turNovedadSetFile(file);
}
function turNovedadFileSelect(e) {
  const file = e.target?.files?.[0];
  if (file) turNovedadSetFile(file);
}
function turNovedadSetFile(file) {
  _turnoNovedadFile = file;
  const wrap = document.getElementById('tur-novedad-preview-wrap');
  const prev = document.getElementById('tur-novedad-preview');
  const lbl  = document.getElementById('tur-novedad-drop-label');
  if (prev && file.type.startsWith('image/')) {
    prev.src = URL.createObjectURL(file);
    if (wrap) { wrap.style.display = 'inline-block'; wrap.style.display = ''; }
  }
  if (lbl) lbl.textContent = file.name;
}
function turNovedadClear() {
  _turnoNovedadFile = null;
  const wrap = document.getElementById('tur-novedad-preview-wrap');
  const prev = document.getElementById('tur-novedad-preview');
  const lbl  = document.getElementById('tur-novedad-drop-label');
  const inp  = document.getElementById('tur-novedad-file');
  if (prev) prev.src = '';
  if (wrap) wrap.style.display = 'none';
  if (lbl) lbl.textContent = 'Foto de novedad (pinchadura, choque, etc.) — opcional';
  if (inp) inp.value = '';
}
let _turnosData      = [];
let _turnosRendTotal = 0; // rendiciones del período actual (para XLS y saldo)
let _turnosRendList      = []; // lista completa de rendiciones del período (para Detalle)
let _turnosDetalleRendList = []; // rendList con conceptos — para XLS/WA del detalle modal

async function loadTurnos() {
  try {
    // Pre-fill mes actual si los filtros están vacíos
    const desdeEl = document.getElementById('turnos-desde');
    const hastaEl = document.getElementById('turnos-hasta');
    if (desdeEl && !desdeEl.value) {
      const hoy = new Date();
      desdeEl.value = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}-01`;
      hastaEl.value = hoy.toISOString().slice(0,10);
    }
    const desde   = desdeEl?.value || '';
    const hasta   = hastaEl?.value || '';
    const chofer  = document.getElementById('turnos-filter-chofer')?.value || '';
    const vehiculo= document.getElementById('turnos-filter-vehiculo')?.value || '';
    const params  = new URLSearchParams();
    if (desde)   params.set('desde',      desde);
    if (hasta)   params.set('hasta',      hasta);
    if (chofer)  params.set('chofer_id',  chofer);
    if (vehiculo)params.set('vehiculo_id',vehiculo);
    // Traer turnos y rendiciones del período en paralelo
    const pagosParams = new URLSearchParams({ tipo: 'ingreso' });
    if (desde)  pagosParams.set('desde',     desde);
    if (hasta)  pagosParams.set('hasta',     hasta);
    if (chofer) pagosParams.set('chofer_id', chofer);
    const [turnosRes, pagosRes] = await Promise.all([
      fetch('/api/turnos?' + params),
      fetch('/api/pagos?' + pagosParams)
    ]);
    _turnosData     = await turnosRes.json();
    const pagosRend = await pagosRes.json();
    _turnosRendList  = Array.isArray(pagosRend) ? pagosRend : [];
    _turnosRendTotal = _turnosRendList.reduce((s, r) => s + parseFloat(r.monto || 0), 0);
    _renderTurnos(_turnosRendTotal);
    _populateTurnoFiltros();
  } catch(e) { showToast('Error al cargar turnos: ' + e.message, 'error'); }
}

function _fmtDT(dt) {
  if (!dt) return '—';
  const d = new Date(dt);
  return d.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit'}) + ' ' +
         d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',hour12:false});
}
function _fmtN(n, dec=1) { return n != null ? Number(n).toLocaleString('es-AR',{minimumFractionDigits:dec,maximumFractionDigits:dec}) : '—'; }
// Formatea horas decimales como "14h 56min" (o "14:56" para WA/texto corto)
function _fmtHM(h, short = false) {
  if (h == null || isNaN(h) || h <= 0) return '—';
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  if (short) return mm > 0 ? `${hh}:${String(mm).padStart(2,'0')}` : `${hh}:00`;
  return mm > 0 ? `${hh}h ${mm}min` : `${hh}h`;
}
function _fmtPeso(n)  { return n != null ? '$ ' + Number(n).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'; }
function _fmtAmt(n)   { return n != null && parseFloat(n) !== 0 ? Number(n).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'; }
function _fmtMod(m) {
  if (m == null) return '—';
  return parseFloat(m) < 1 ? (parseFloat(m)*100).toFixed(0) + '%' : '$ ' + Number(m).toLocaleString('es-AR',{minimumFractionDigits:0,maximumFractionDigits:0});
}
function _calcHoras(ini, fin) {
  if (!ini || !fin) return null;
  const h = (new Date(fin) - new Date(ini)) / 3600000;
  return h > 0 ? h : null;
}
// ── TURNOS GRÁFICOS ──────────────────────────────────────────────
// ── Paleta y plugins compartidos para TODOS los gráficos ──────────────────────
const _CHART_PALETTE = [
  { top: '#818CF8', bot: '#4338CA' },
  { top: '#34D399', bot: '#047857' },
  { top: '#FB923C', bot: '#C2410C' },
  { top: '#60A5FA', bot: '#1D4ED8' },
  { top: '#F472B6', bot: '#BE185D' },
  { top: '#A78BFA', bot: '#6D28D9' },
  { top: '#FCD34D', bot: '#B45309' },
  { top: '#22D3EE', bot: '#0E7490' },
];

// Crea plugins de gradiente + sombra reutilizables
// singleColor: si es true, aplica un gradiente sobre un solo color (barras de serie temporal)
// singleColor: string → gradiente monocolorcon ese color (serie temporal)
//              null    → multi-dataset: usa el color original de cada dataset
//              undefined → categorías: usa _CHART_PALETTE por barra
function _makeChartPlugins(isPie, singleColor) {
  const _origColors = new WeakMap();
  const gradPlugin = {
    id: 'grad_' + Math.random().toString(36).slice(2),
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea || isPie) return;
      chart.data.datasets.forEach((ds, di) => {
        // Guardar color original la primera vez
        if (!_origColors.has(ds)) _origColors.set(ds, ds.backgroundColor);
        const orig = _origColors.get(ds);
        ds.backgroundColor = chart.data.labels.map((_, i) => {
          let top, bot;
          if (singleColor) {
            // Serie temporal: un color del picker
            top = singleColor; bot = singleColor + 'aa';
          } else if (null === singleColor) {
            // Multi-dataset: usa el color original de cada dataset
            const base = typeof orig === 'string' ? orig : (orig?.[i] || '#888');
            top = base; bot = base + 'aa';
          } else {
            // Categorías: paleta por barra
            const p = _CHART_PALETTE[i % _CHART_PALETTE.length];
            top = p.top; bot = p.bot;
          }
          const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          g.addColorStop(0, top);
          g.addColorStop(1, bot);
          return g;
        });
      });
    }
  };
  const shadowPlugin = {
    id: 'shd_' + Math.random().toString(36).slice(2),
    // usar hooks POR-dataset (singular) para que ctx.restore() corra ANTES de que
    // ChartDataLabels (plugin global) dibuje en afterDatasetsDraw — evita sombra en etiquetas
    beforeDatasetDraw(chart) {
      chart.ctx.save();
      chart.ctx.shadowColor   = 'rgba(0,0,0,0.28)';
      chart.ctx.shadowBlur    = 10;
      chart.ctx.shadowOffsetX = 3;
      chart.ctx.shadowOffsetY = 5;
    },
    afterDatasetDraw(chart) { chart.ctx.restore(); }
  };
  return [gradPlugin, shadowPlugin];
}

// Opciones comunes de tooltip y grid para todos los módulos
function _chartTooltip() {
  return {
    backgroundColor: 'rgba(10,10,20,0.90)',
    titleColor: '#fff', bodyColor: '#94a3b8',
    borderColor: 'rgba(129,140,248,0.5)', borderWidth: 1,
    padding: 10, cornerRadius: 8
  };
}
function _chartGrid() {
  return { color: 'rgba(148,163,184,0.10)', borderDash: [5, 5] };
}
// ─────────────────────────────────────────────────────────────────────────────
let _tgChartBar = null, _tgChartBarVeh = null, _tgChartPieCh = null, _tgChartPieVeh = null;
let _tgMetric   = 'importe';
let _tgData     = [];   // datos crudos del período

async function openTurnosGraficos() {
  // Pre-cargar filtros con los valores actuales de la grilla
  const desde  = document.getElementById('turnos-desde')?.value          || '';
  const hasta  = document.getElementById('turnos-hasta')?.value           || '';
  const chof   = document.getElementById('turnos-filter-chofer')?.value  || '';
  const veh    = document.getElementById('turnos-filter-vehiculo')?.value || '';

  document.getElementById('tg-desde').value   = desde;
  document.getElementById('tg-hasta').value   = hasta;

  // Poblar selects si no están cargados
  const selCh = document.getElementById('tg-chofer');
  if (!selCh.dataset.loaded) {
    if (!cachedChoferes.length) await loadChoferesSelect();
    cachedChoferes.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.nombre || '';
      selCh.appendChild(o);
    });
    selCh.dataset.loaded = '1';
  }
  const selV = document.getElementById('tg-vehiculo');
  if (!selV.dataset.loaded) {
    try {
      const vehList = await fetch('/api/vehiculos').then(r=>r.json());
      vehList.forEach(v => {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = _vehLabel(v);
        selV.appendChild(o);
      });
      selV.dataset.loaded = '1';
    } catch(_) {}
  }
  selCh.value = chof;
  selV.value  = veh;

  openModal('modal-turnos-graficos');
  await renderTurnosGraficos();
}

function setTGMetric(m) {
  _tgMetric = m;
  document.querySelectorAll('.tg-tab').forEach(b => b.classList.toggle('active', b.dataset.metric === m));
  _tgRenderCharts();
}

async function renderTurnosGraficos() {
  const params = new URLSearchParams();
  const desde  = document.getElementById('tg-desde').value;
  const hasta  = document.getElementById('tg-hasta').value;
  const chof   = document.getElementById('tg-chofer').value;
  const veh    = document.getElementById('tg-vehiculo').value;
  if (desde) params.set('desde', desde);
  if (hasta) params.set('hasta', hasta);
  if (chof)  params.set('chofer_id', chof);
  if (veh)   params.set('vehiculo_id', veh);

  try {
    _tgData = await fetch('/api/turnos?' + params).then(r => r.json());
  } catch(_) { _tgData = []; }
  _tgRenderCharts();
}

function _tgGroup(data, agrupacion) {
  // Devuelve {label, importe, viajes, gnc, horas, recorrido, adeuda}[]
  const map = new Map();
  const key = t => {
    if (agrupacion === 'chofer')   return t.chofer_nombre || 'Sin chofer';
    if (agrupacion === 'vehiculo') return t.vehiculo_patente || 'Sin vehículo';
    if (agrupacion === 'semana') {
      const d = new Date(t.fecha_inicio);
      const startOfYear = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil(((d - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
      return `${d.getFullYear()}-S${String(week).padStart(2,'0')}`;
    }
    // mes
    const d = new Date(t.fecha_inicio);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  };
  data.forEach(t => {
    const k = key(t);
    if (!map.has(k)) map.set(k, {label:k, importe:0, viajes:0, gnc:0, horas:0, recorrido:0, adeuda:0});
    const r = map.get(k);
    r.importe   += parseFloat(t.importe   || 0);
    r.viajes    += parseFloat(t.viajes    || 0);
    r.gnc       += parseFloat(t.gnc       || 0);
    r.horas     += _calcHoras(t.fecha_inicio, t.fecha_fin) || 0;
    r.recorrido += (parseFloat(t.km_fin||0) - parseFloat(t.km_inicio||0));
    r.adeuda    += (parseFloat(t.peajes_auto||0) + parseFloat(t.multas_pendientes||0));
  });
  return [...map.entries()].sort((a,b) => a[0] < b[0] ? -1 : 1).map(e => e[1]);
}

function _tgRenderCharts(redrawOnly) {
  const agrup  = document.getElementById('tg-agrupacion').value;
  const groups = _tgGroup(_tgData, agrup);

  const labels  = groups.map(g => g.label);
  const values  = groups.map(g => Math.max(0, g[_tgMetric] || 0));

  const metricLabel = {importe:'Importe ($)', viajes:'Viajes ($)', gnc:'GNC ($)', horas:'Horas', recorrido:'Recorrido (km)', adeuda:'Total Adeuda ($)'};
  const pieColors = ['#6366f1','#22c55e','#f59e0b','#ef4444','#3b82f6','#ec4899','#14b8a6','#a855f7','#f97316','#84cc16'];

  const showX      = document.getElementById('tg-show-x')?.checked !== false;
  const showY      = document.getElementById('tg-show-y')?.checked !== false;
  const showLabels = document.getElementById('tg-show-labels')?.checked === true;
  const colorX     = document.getElementById('tg-color-x')?.value   || '#555555';
  const colorY     = document.getElementById('tg-color-y')?.value   || '#555555';
  const colorBar   = document.getElementById('tg-color-bar')?.value || '#6366f1';
  const hexAlpha   = (hex, a) => hex + Math.round(a*255).toString(16).padStart(2,'0');

  if (window.ChartDataLabels) Chart.register(ChartDataLabels);

  const tgFmtTick = v => _tgFmt(v);
  const tgFmtLabel = v => v > 0 ? _tgFmt(v) : null;

  // ── Barras: redrawOnly ──
  // Siempre recrear (el redrawOnly solo ajustaba colores, ahora los plugins manejan gradientes)
  {
    const ctxBar = document.getElementById('tg-chart-bar').getContext('2d');
    if (_tgChartBar) { _tgChartBar.destroy(); _tgChartBar = null; }
    _tgChartBar = new Chart(ctxBar, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: metricLabel[_tgMetric],
          data: values,
          backgroundColor: colorBar,
          borderColor: 'transparent',
          borderWidth: 0,
          borderRadius: 10,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 900, easing: 'easeInOutQuart' },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: colorX, font: { size: 11 } } },
          datalabels: showLabels
            ? { display: true, anchor: 'end', align: 'top', color: colorX, font: { size: 9, weight: '700' }, formatter: tgFmtLabel, clip: false, clamp: true }
            : { display: false },
          tooltip: { ...(_chartTooltip()), callbacks: { label: ctx => `  ${ctx.dataset.label}: ${_tgFmt(ctx.parsed.y)}` } }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: showX ? { color: colorX, font: { size: 10 } } : { display: false }
          },
          y: {
            beginAtZero: true,
            grid: _chartGrid(),
            ticks: showY ? { color: colorY, callback: tgFmtTick } : { display: false }
          }
        }
      },
      plugins: _makeChartPlugins(false, colorBar)
    });
  }

  // ── Barras agrupadas por vehículo ──
  {
    const vehList = [...new Set(_tgData.map(t => t.vehiculo_patente).filter(Boolean))].sort();
    const periodKey = t => {
      if (agrup === 'chofer' || agrup === 'vehiculo') {
        const d = new Date(t.fecha_inicio);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      }
      return groups.find(() => true)?.label ? _tgGroup([t], agrup)[0]?.label : '';
    };
    // Reusar la misma lógica de agrupación pero por vehículo × período
    const periodos = labels.length ? labels : [...new Set(_tgData.map(t => {
      const d = new Date(t.fecha_inicio);
      if (agrup === 'semana') {
        const s = new Date(d.getFullYear(),0,1);
        return `${d.getFullYear()}-S${String(Math.ceil(((d-s)/86400000+s.getDay()+1)/7)).padStart(2,'0')}`;
      }
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    })).sort()];

    // Para agrupacion chofer/vehiculo no tiene sentido temporal — mostrar por mes igualmente
    const periodosMes = [...new Set(_tgData.map(t => {
      const d = new Date(t.fecha_inicio);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    }))].sort();
    const usePeriodos = (agrup === 'mes' || agrup === 'semana') ? periodos : periodosMes;

    const vehMesMap = {};
    _tgData.forEach(t => {
      const pat = t.vehiculo_patente; if (!pat) return;
      const d = new Date(t.fecha_inicio);
      let pk;
      if (agrup === 'semana') {
        const s = new Date(d.getFullYear(),0,1);
        pk = `${d.getFullYear()}-S${String(Math.ceil(((d-s)/86400000+s.getDay()+1)/7)).padStart(2,'0')}`;
      } else {
        pk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      }
      if (!vehMesMap[pat]) vehMesMap[pat] = {};
      const val = _tgMetric === 'horas' ? (_calcHoras(t.fecha_inicio, t.fecha_fin)||0)
                : _tgMetric === 'recorrido' ? (parseFloat(t.km_fin||0)-parseFloat(t.km_inicio||0))
                : _tgMetric === 'adeuda' ? (parseFloat(t.peajes_auto||0)+parseFloat(t.multas_pendientes||0))
                : parseFloat(t[_tgMetric]||0);
      vehMesMap[pat][pk] = (vehMesMap[pat][pk]||0) + val;
    });

    const vehCvs = document.getElementById('tg-chart-bar-veh');
    if (_tgChartBarVeh) { _tgChartBarVeh.destroy(); _tgChartBarVeh = null; }
    if (vehCvs && vehList.length && usePeriodos.length) {
      _tgChartBarVeh = new Chart(vehCvs, {
        type: 'bar',
        data: {
          labels: usePeriodos,
          datasets: vehList.map((pat, i) => ({
            label: pat,
            data: usePeriodos.map(p => vehMesMap[pat]?.[p] || 0),
            backgroundColor: _CHART_PALETTE[i%_CHART_PALETTE.length].top,
            borderColor:     _CHART_PALETTE[i%_CHART_PALETTE.length].bot,
            borderWidth: 0, borderRadius: 6, borderSkipped: false,
          }))
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          animation: { duration: 900, easing: 'easeInOutQuart' },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'bottom', labels: { font: { size: 10, weight: '600' }, usePointStyle: true, boxWidth: 10 } },
            datalabels: { display: false },
            tooltip: { ..._chartTooltip(), callbacks: { label: ctx => `  ${ctx.dataset.label}: ${_tgFmt(ctx.parsed.y)}` } }
          },
          scales: {
            x: { grid: { display: false }, ticks: { font: { size: 10 }, color: colorX } },
            y: { grid: _chartGrid(), ticks: { font: { size: 10 }, color: colorY, callback: tgFmtTick } }
          }
        },
        plugins: _makeChartPlugins(false, null)
      });
    }
  }

  // ── Torta Chofer ──
  const byChofer  = _tgGroup(_tgData, 'chofer');
  const ctxPieCh  = document.getElementById('tg-chart-pie-chofer').getContext('2d');
  if (_tgChartPieCh) _tgChartPieCh.destroy();
  _tgChartPieCh = new Chart(ctxPieCh, {
    type: 'doughnut',
    data: {
      labels: byChofer.map(g=>g.label),
      datasets: [{ data: byChofer.map(g=>Math.max(0,g[_tgMetric]||0)),
        backgroundColor: byChofer.map((_,i)=>_CHART_PALETTE[i%_CHART_PALETTE.length].top),
        borderColor: byChofer.map((_,i)=>_CHART_PALETTE[i%_CHART_PALETTE.length].bot),
        borderWidth: 2, hoverOffset: 20 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 900, easing: 'easeInOutQuart' },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11, weight: '600' }, boxWidth: 12, usePointStyle: true } },
        title:  { display: true, text: 'Por chofer', font: { size: 12, weight: '700' } },
        datalabels: { display: false },
        tooltip: _chartTooltip()
      }
    }
  });

  // ── Torta Vehículo ──
  const byVeh    = _tgGroup(_tgData, 'vehiculo');
  const ctxPieV  = document.getElementById('tg-chart-pie-vehiculo').getContext('2d');
  if (_tgChartPieVeh) _tgChartPieVeh.destroy();
  _tgChartPieVeh = new Chart(ctxPieV, {
    type: 'doughnut',
    data: {
      labels: byVeh.map(g=>g.label),
      datasets: [{ data: byVeh.map(g=>Math.max(0,g[_tgMetric]||0)),
        backgroundColor: byVeh.map((_,i)=>_CHART_PALETTE[i%_CHART_PALETTE.length].top),
        borderColor: byVeh.map((_,i)=>_CHART_PALETTE[i%_CHART_PALETTE.length].bot),
        borderWidth: 2, hoverOffset: 20 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 900, easing: 'easeInOutQuart' },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11, weight: '600' }, boxWidth: 12, usePointStyle: true } },
        title:  { display: true, text: 'Por vehículo', font: { size: 12, weight: '700' } },
        datalabels: { display: false },
        tooltip: _chartTooltip()
      }
    }
  });

  // ── Summary chips ──
  const tot = _tgData.reduce((a,t) => {
    a.turnos++;
    a.importe   += parseFloat(t.importe||0);
    a.viajes    += parseFloat(t.viajes||0);
    a.gnc       += parseFloat(t.gnc||0);
    a.horas     += _calcHoras(t.fecha_inicio,t.fecha_fin)||0;
    a.adeuda    += parseFloat(t.peajes_auto||0)+parseFloat(t.multas_pendientes||0);
    return a;
  }, {turnos:0,importe:0,viajes:0,gnc:0,horas:0,adeuda:0});

  const chip = (label, val, color='') => `<span style="background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;padding:6px 14px;font-size:12px;white-space:nowrap;${color?'color:'+color+';':''}"><b>${label}</b> ${val}</span>`;
  document.getElementById('tg-summary').innerHTML =
    chip('Turnos', tot.turnos) +
    chip('Importe', _fmtPeso(tot.importe), 'var(--accent-color)') +
    chip('Viajes',  _fmtPeso(tot.viajes)) +
    chip('GNC',     _fmtPeso(tot.gnc)) +
    chip('Horas',   _fmtHM(tot.horas)) +
    (tot.adeuda>0 ? chip('Adeuda', _fmtPeso(tot.adeuda), '#dc2626') : '');
}

function exportTurnosGraficosXLS() {
  if (!_tgData.length) return showToast('Sin datos para exportar');
  if (!window.XLSX)    return showToast('Librería XLS no cargada');
  const fecha  = new Date().toISOString().slice(0,10);
  const agrup  = document.getElementById('tg-agrupacion').value;
  const groups = _tgGroup(_tgData, agrup);
  const wb     = XLSX.utils.book_new();

  // Hoja 1 — resumen agrupado
  const aoa = [['Período','Importe','Viajes','GNC','Horas','Recorrido km','Adeuda']];
  groups.forEach(g => aoa.push([g.label, g.importe, g.viajes, g.gnc, +g.horas.toFixed(2), +g.recorrido.toFixed(0), g.adeuda]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Resumen');

  // Hoja 2 — auditoría (todos los turnos del período)
  const audit = [['ID','Chofer','Vehículo','Fecha Inicio','Fecha Fin','Horas','Km Inicio','Km Fin','Recorrido','Modalidad','GNC','Viajes','Peajes Decl.','Importe','Peajes Auto','Multas','Total Adeuda']];
  _tgData.forEach(t => {
    const h   = _calcHoras(t.fecha_inicio, t.fecha_fin);
    const rec = t.km_inicio != null && t.km_fin != null ? +(parseFloat(t.km_fin) - parseFloat(t.km_inicio)).toFixed(0) : '';
    audit.push([
      t.id, t.chofer_nombre||'', t.vehiculo_patente||'',
      t.fecha_inicio ? new Date(t.fecha_inicio).toLocaleString('es-AR') : '',
      t.fecha_fin    ? new Date(t.fecha_fin).toLocaleString('es-AR')    : '',
      h ? +h.toFixed(2) : '', t.km_inicio??'', t.km_fin??'', rec,
      t.modalidad??'', +t.gnc||0, +t.viajes||0, +t.peajes||0, +t.importe||0,
      t.peajes_auto != null ? +t.peajes_auto : '', t.multas_pendientes != null ? +t.multas_pendientes : '',
      (parseFloat(t.peajes_auto)||0)+(parseFloat(t.multas_pendientes)||0)
    ]);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(audit), 'Auditoría');

  // PNG del gráfico
  if (_tgChartBar) {
    try {
      const a = document.createElement('a');
      a.href = _tgChartBar.toBase64Image('image/png', 1);
      a.download = `Turnos_grafico_${fecha}.png`;
      a.click();
    } catch(_) {}
  }

  XLSX.writeFile(wb, `Turnos_graficos_${fecha}.xlsx`);
  showToast('XLS + imagen PNG descargados');
}

async function exportTurnosGraficosWA() {
  if (!_tgData.length) return showToast('Sin datos para exportar');
  const agrup  = document.getElementById('tg-agrupacion').value;
  const groups = _tgGroup(_tgData, agrup);
  const desde  = document.getElementById('tg-desde').value;
  const hasta  = document.getElementById('tg-hasta').value;

  // Tabla oculta para el modal WA
  let tbl = document.getElementById('_tg-wa-table');
  if (!tbl) { tbl = document.createElement('table'); tbl.id = '_tg-wa-table'; tbl.style.display = 'none'; document.body.appendChild(tbl); }
  const head = `<thead><tr><th>Período</th><th>Importe</th><th>Viajes</th><th>GNC</th><th>Horas</th><th>Recorrido</th><th>Adeuda</th></tr></thead>`;
  const body = '<tbody>' + groups.map(g =>
    `<tr><td>${g.label}</td><td>${_fmtAmt(g.importe)}</td><td>${_fmtAmt(g.viajes)}</td><td>${_fmtAmt(g.gnc)}</td><td>${_fmtHM(g.horas)}</td><td>${_fmtN(g.recorrido,0)} km</td><td>${g.adeuda>0?_fmtAmt(g.adeuda):'—'}</td></tr>`
  ).join('') + '</tbody>';
  tbl.innerHTML = head + body;

  const titulo = `Turnos — Gráficos (${desde||''}${hasta?' al '+hasta:''})`;
  await openWhatsAppModal('_tg-wa-table', titulo);
}

function _tgFmt(v) {
  if (_tgMetric==='horas')     return _fmtHM(v);
  if (_tgMetric==='recorrido') return _fmtN(v,0)+' km';
  return Number(v).toLocaleString('es-AR',{minimumFractionDigits:0,maximumFractionDigits:0});
}

function exportTurnosXLS() {
  if (!_turnosData.length) { showToast('Sin datos para exportar'); return; }

  const desde  = document.getElementById('turnos-desde')?.value || '';
  const hasta  = document.getElementById('turnos-hasta')?.value  || '';
  const periodo = desde && hasta ? `${desde} al ${hasta}` : new Date().toLocaleDateString('es-AR');
  const nTurnos = _turnosData.length;

  // ── Helpers de estilo ────────────────────────────────────────────────────
  const S = (fill, font = {}, align = {}, numFmt = null) => {
    const s = {};
    if (fill) s.fill = { patternType: 'solid', fgColor: { rgb: fill } };
    if (Object.keys(font).length)  s.font  = { name: 'Calibri', sz: 11, ...font };
    if (Object.keys(align).length) s.alignment = align;
    if (numFmt) s.numFmt = numFmt;
    return s;
  };
  const C = (v, style, t) => {
    const cell = { v, s: style };
    if (t)                          cell.t = t;
    else if (typeof v === 'number') cell.t = 'n';
    else                            cell.t = 's';
    if (style?.numFmt) { cell.z = style.numFmt; delete cell.s.numFmt; }
    return cell;
  };

  // Paleta
  const NAV  = '1B3A5C'; // azul navy — encabezado
  const GRN  = '166534'; // verde oscuro — saldo positivo
  const RED  = '7F1D1D'; // rojo oscuro — saldo negativo
  const AMB  = '78350F'; // ámbar oscuro — adeuda
  const TOT  = '1E293B'; // gris dark — totales
  const WHT  = 'FFFFFF';
  const LB1  = 'DBEAFE'; // azul muy claro — filas pares
  const LG   = 'DCFCE7'; // verde claro — importe
  const LAM  = 'FEF3C7'; // ámbar claro — peajes/multas/adeudado
  const FMT  = '#,##0.00';
  const FKM  = '#,##0';
  const FHRS = '0.0"h"';

  // ── Estilos predefinidos ─────────────────────────────────────────────────
  const sHdr    = S(NAV, { bold: true, color: { rgb: WHT }, sz: 10 }, { horizontal: 'center', vertical: 'center', wrapText: true });
  const sHdrAmb = S(AMB, { bold: true, color: { rgb: WHT }, sz: 10 }, { horizontal: 'center', vertical: 'center', wrapText: true });
  const sHdrGrn = S('14532D', { bold: true, color: { rgb: WHT }, sz: 10 }, { horizontal: 'center', vertical: 'center', wrapText: true });
  const sTxt0   = S(WHT,  { sz: 10 }, { vertical: 'center' });
  const sTxt1   = S(LB1,  { sz: 10 }, { vertical: 'center' });
  const sNum0   = S(WHT,  { sz: 10 }, { horizontal: 'right', vertical: 'center' }, FMT);
  const sNum1   = S(LB1,  { sz: 10 }, { horizontal: 'right', vertical: 'center' }, FMT);
  const sKm0    = S(WHT,  { sz: 10 }, { horizontal: 'right', vertical: 'center' }, FKM);
  const sKm1    = S(LB1,  { sz: 10 }, { horizontal: 'right', vertical: 'center' }, FKM);
  const sImp0   = S(LG,   { sz: 10, color: { rgb: '166534' } }, { horizontal: 'right', vertical: 'center' }, FMT);
  const sImp1   = S('BBF7D0', { sz: 10, color: { rgb: '166534' } }, { horizontal: 'right', vertical: 'center' }, FMT);
  const sAmb0   = S(LAM,  { sz: 10, color: { rgb: AMB } }, { horizontal: 'right', vertical: 'center' }, FMT);
  const sAmb1   = S('FDE68A', { sz: 10, color: { rgb: AMB } }, { horizontal: 'right', vertical: 'center' }, FMT);
  const sTot    = S(TOT,  { bold: true, color: { rgb: WHT }, sz: 11 }, { horizontal: 'right', vertical: 'center' }, FMT);
  const sTotL   = S(TOT,  { bold: true, color: { rgb: WHT }, sz: 11 }, { vertical: 'center' });
  const sTotAmb = S('B45309', { bold: true, color: { rgb: WHT }, sz: 11 }, { horizontal: 'right', vertical: 'center' }, FMT);
  const sTotGrn = S('166534', { bold: true, color: { rgb: WHT }, sz: 11 }, { horizontal: 'right', vertical: 'center' }, FMT);
  const sTit    = S(NAV,  { bold: true, color: { rgb: WHT }, sz: 14 }, { horizontal: 'left', vertical: 'center' });
  const sSub    = S('2D5986', { italic: true, color: { rgb: WHT }, sz: 10 }, { horizontal: 'left', vertical: 'center' });

  // ── Construir filas ──────────────────────────────────────────────────────
  // Fila 0: título
  // Fila 1: subtítulo
  // Fila 2: encabezados
  // Filas 3..N+2: datos
  // Fila N+3: vacía
  // Fila N+4: totales
  // Fila N+5: saldo

  const NCOLS = 17; // A..Q
  const HDR = ['Fecha Inicio','Fecha Fin','Horas','Chofer','Vehículo',
               'Km\nInicio','Km\nFin','Recorrido\n(km)','Modal.',
               'GNC ($)','Viajes ($)','Importe ($)',
               'Peajes ($)','Multas ($)','ADEUDADO ($)',
               'Total Día ($)','Pagos ($)'];

  const rows = []; // cada elemento es array de cells

  // Fila 0 — título (merge se agrega después)
  const titRow = Array(NCOLS).fill(C('', S(NAV)));
  titRow[0] = C(`FlotaControl — Resumen de Turnos`, sTit, 's');
  rows.push(titRow);

  // Fila 1 — subtítulo
  const subRow = Array(NCOLS).fill(C('', S('2D5986')));
  subRow[0] = C(`Período: ${periodo}  ·  ${nTurnos} turno${nTurnos!==1?'s':''}`, sSub, 's');
  rows.push(subRow);

  // Fila 2 — encabezados (col 12,13,14 = ámbar; col 11,15 = verde)
  const hdrRow = HDR.map((h, i) => {
    const sH = (i >= 12 && i <= 14) ? sHdrAmb : (i === 11 || i === 15) ? sHdrGrn : sHdr;
    return C(h, sH, 's');
  });
  rows.push(hdrRow);

  // Filas de datos
  _turnosData.forEach((t, idx) => {
    const h    = _calcHoras(t.fecha_inicio, t.fecha_fin);
    const rec  = Math.max(0, (parseFloat(t.km_fin)||0) - (parseFloat(t.km_inicio)||0));
    const imp  = parseFloat(t.importe)||0;
    const pej  = parseFloat(t.peajes_auto)||0;
    const mul  = parseFloat(t.multas_pendientes)||0;
    const ade  = pej + mul;
    const tot  = imp + pej + mul;
    const par  = idx % 2 === 0;

    const sT = par ? sTxt0 : sTxt1;
    const sN = par ? sNum0 : sNum1;
    const sK = par ? sKm0  : sKm1;
    const sI = par ? sImp0 : sImp1;
    const sA = par ? sAmb0 : sAmb1;

    rows.push([
      C(t.fecha_inicio ? new Date(t.fecha_inicio).toLocaleString('es-AR') : '', sT, 's'),
      C(t.fecha_fin    ? new Date(t.fecha_fin).toLocaleString('es-AR')    : '', sT, 's'),
      C(h ? +h.toFixed(2) : 0, { ...sN, numFmt: FHRS }),
      C(t.chofer_nombre||'', sT, 's'),
      C(t.vehiculo_patente||'', { ...sT, font: { ...sT.font, bold: true } }, 's'),
      C(t.km_inicio != null ? parseFloat(t.km_inicio) : 0, sK),
      C(t.km_fin    != null ? parseFloat(t.km_fin)    : 0, sK),
      C(rec > 0 ? +rec.toFixed(0) : 0, sK),
      C(t.modalidad||'', sT, 's'),
      C(parseFloat(t.gnc)||0, sN),
      C(parseFloat(t.viajes)||0, sN),
      C(imp, sI),
      C(pej, sA),
      C(mul, sA),
      C(ade, sA),
      C(tot, sN),
      C(0, sN),  // Pagos — no disponible por turno individual
    ]);
  });

  // Fila vacía separadora
  rows.push(Array(NCOLS).fill(C('', {})));

  // Cálculos de totales
  const totHoras  = _turnosData.reduce((s,t) => s + (_calcHoras(t.fecha_inicio,t.fecha_fin)||0), 0);
  const totKm     = _turnosData.reduce((s,t) => s + Math.max(0,(parseFloat(t.km_fin)||0)-(parseFloat(t.km_inicio)||0)), 0);
  const totImp    = _turnosData.reduce((s,t) => s + (parseFloat(t.importe)||0), 0);
  const totGnc    = _turnosData.reduce((s,t) => s + (parseFloat(t.gnc)||0), 0);
  const totViajes = _turnosData.reduce((s,t) => s + (parseFloat(t.viajes)||0), 0);
  const totPjAuto = _turnosData.reduce((s,t) => s + (parseFloat(t.peajes_auto)||0), 0);
  const totMultas = _turnosData.reduce((s,t) => s + (parseFloat(t.multas_pendientes)||0), 0);
  const totAdeuda = totPjAuto + totMultas;
  const totDia    = totImp + totPjAuto + totMultas;
  const saldo     = totImp - totAdeuda - _turnosRendTotal;

  // Fila TOTALES
  rows.push([
    C('TOTALES', sTotL, 's'),
    C('', sTot, 's'),
    C(+totHoras.toFixed(2), { ...sTot, numFmt: FHRS }),
    C('', sTot, 's'), C('', sTot, 's'),
    C('', sTot), C('', sTot),
    C(totKm > 0 ? +totKm.toFixed(0) : 0, { ...sTot, numFmt: FKM }),
    C('', sTot, 's'),
    C(totGnc, sTot), C(totViajes, sTot),
    C(totImp, sTotGrn),
    C(totPjAuto, sTotAmb), C(totMultas, sTotAmb), C(totAdeuda, sTotAmb),
    C(totDia, sTot),
    C(_turnosRendTotal, sTotGrn),
  ]);

  // Fila SALDO
  const saldoPos  = saldo >= 0;
  const sSaldoVal = S(saldoPos ? GRN : RED, { bold: true, color: { rgb: WHT }, sz: 13 }, { horizontal: 'right', vertical: 'center' }, FMT);
  const sSaldoLbl = S(saldoPos ? GRN : RED, { bold: true, color: { rgb: WHT }, sz: 13 }, { vertical: 'center' });
  const sSaldoBlk = S(saldoPos ? GRN : RED, { color: { rgb: WHT }, sz: 11 });
  rows.push([
    C('SALDO PENDIENTE', sSaldoLbl, 's'),
    ...Array(10).fill(C('', sSaldoBlk, 's')),
    C(saldo, sSaldoVal),
    ...Array(5).fill(C('', sSaldoBlk, 's')),
  ]);

  // ── Construir hoja ────────────────────────────────────────────────────────
  const ws = {};
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (!cell) return;
      const addr = XLSX.utils.encode_cell({ r, c });
      ws[addr] = { v: cell.v, t: cell.t, s: cell.s };
      if (cell.z) ws[addr].z = cell.z;
    });
  });

  const lastRow = rows.length - 1;
  const lastCol = NCOLS - 1;
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: lastCol } });

  // Merge título y subtítulo (A1:Q1 y A2:Q2)
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: NCOLS - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: NCOLS - 1 } },
    { s: { r: lastRow, c: 0 }, e: { r: lastRow, c: 10 } }, // merge label saldo
  ];

  // Anchos de columna
  ws['!cols'] = [
    { wch: 20 }, // Fecha Inicio
    { wch: 20 }, // Fecha Fin
    { wch: 7  }, // Horas
    { wch: 22 }, // Chofer
    { wch: 9  }, // Vehículo
    { wch: 9  }, // Km Inicio
    { wch: 9  }, // Km Fin
    { wch: 9  }, // Recorrido
    { wch: 8  }, // Modal
    { wch: 10 }, // GNC
    { wch: 10 }, // Viajes
    { wch: 13 }, // Importe
    { wch: 12 }, // Peajes
    { wch: 12 }, // Multas
    { wch: 13 }, // Adeudado
    { wch: 13 }, // Total Día
    { wch: 13 }, // Pagos
  ];

  // Altura de filas: título=28, subtítulo=16, encabezado=36, datos=20
  ws['!rows'] = [{ hpt: 28 }, { hpt: 16 }, { hpt: 36 }];
  for (let i = 3; i < rows.length; i++) ws['!rows'].push({ hpt: 20 });

  // Freeze encabezado (filas título + subtítulo + header = primeras 3 filas)
  ws['!sheetViews'] = [{ state: 'frozen', ySplit: 3, topLeftCell: 'A4', activePane: 'bottomLeft', pane: { ySplit: 3, topLeftCell: 'A4', activePane: 'bottomLeft', state: 'frozen' } }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Turnos');
  const fname = `Turnos_${(desde||new Date().toISOString().slice(0,10)).replace(/-/g,'')}_${(hasta||'').replace(/-/g,'')}.xlsx`;
  XLSX.writeFile(wb, fname.replace('_.xlsx','.xlsx'));
  showToast('Turnos.xlsx descargado');
}
async function shareTurnosWA() {
  if (!_turnosData.length) { showToast('Sin datos para compartir'); return; }
  const desde = document.getElementById('turnos-desde')?.value || '';
  const hasta  = document.getElementById('turnos-hasta')?.value  || '';
  let txt = `*Turnos FlotaControl*`;
  if (desde || hasta) txt += ` (${desde||''}${hasta?' → '+hasta:''})`;
  txt += `\n`;
  _turnosData.forEach(t => {
    const h = _calcHoras(t.fecha_inicio, t.fecha_fin);
    txt += `\n• ${new Date(t.fecha_inicio).toLocaleDateString('es-AR')} — ${t.chofer_nombre||''} / ${t.vehiculo_patente||'—'}`;
    if (h) txt += ` (${_fmtHM(h)})`;
    if (parseFloat(t.importe)) txt += ` Imp: $${Number(t.importe).toLocaleString('es-AR',{minimumFractionDigits:0})}`;
    const adeuda = (parseFloat(t.peajes_auto)||0)+(parseFloat(t.multas_pendientes)||0);
    if (adeuda > 0) txt += ` ⚠ Adeuda: $${adeuda.toLocaleString('es-AR',{minimumFractionDigits:0})}`;
  });
  await openWhatsAppModal(null, 'Turnos');
  document.getElementById('wa-message').value = txt;
}

function toggleExtraCols() {
  const tbl = document.getElementById('table-turnos');
  if (tbl) tbl.classList.toggle('cols-expanded');
}

function _renderTurnos(totalRendiciones = 0) {
  const tbody = document.getElementById('turnos-tbody');
  if (!tbody) return;
  if (!_turnosData.length) {
    document.getElementById('turnos-totals-row').style.display = 'none';
    tbody.innerHTML = '<tr><td colspan="16" style="text-align:center;color:var(--text-secondary);padding:32px;">Sin turnos en el período</td></tr>';
    injectExportBar('table-turnos', 'Turnos');
    _renderTurnosSaldo(-totalRendiciones);
    return;
  }
  let totHoras = 0, totKm = 0, totImporte = 0, totGnc = 0, totViajes = 0, totPeajes = 0, totPjAuto = 0, totMultas = 0;
  const canDel = canDelete();
  tbody.innerHTML = _turnosData.map(t => {
    const horas = _calcHoras(t.fecha_inicio, t.fecha_fin);
    const rec   = t.km_inicio != null && t.km_fin != null ? (parseFloat(t.km_fin) - parseFloat(t.km_inicio)) : null;
    totHoras    += horas || 0;
    totKm       += rec   || 0;
    totImporte  += parseFloat(t.importe || 0);
    totGnc      += parseFloat(t.gnc    || 0);
    totViajes   += parseFloat(t.viajes || 0);
    totPeajes   += parseFloat(t.peajes || 0);
    totPjAuto += parseFloat(t.peajes_auto       || 0);
    totMultas += parseFloat(t.multas_pendientes || 0);
    const noFin = !t.fecha_fin;
    return `<tr>
      <td style="white-space:nowrap;">${_fmtDT(t.fecha_inicio)}</td>
      <td style="white-space:nowrap;">${_fmtDT(t.fecha_fin)}</td>
      <td style="text-align:center;">${_fmtHM(horas)}</td>
      <td>${t.chofer_nombre || ''}</td>
      <td>${t.vehiculo_patente || '—'}</td>
      <td style="text-align:right;">${t.km_inicio != null ? _fmtN(t.km_inicio,0) : '—'}</td>
      <td style="text-align:right;">${t.km_fin    != null ? _fmtN(t.km_fin,0)   : '—'}</td>
      <td style="text-align:right;">${rec != null && rec >= 0 ? _fmtN(rec,0) + ' km' : '—'}</td>
      <td style="text-align:center;">${_fmtMod(t.modalidad)}</td>
      <td class="col-extra" style="text-align:right;">${parseFloat(t.gnc)   >0 ? _fmtAmt(t.gnc)    : '—'}</td>
      <td class="col-extra" style="text-align:right;">${parseFloat(t.viajes)>0 ? _fmtAmt(t.viajes) : '—'}</td>
      <td style="text-align:right;font-weight:600;color:var(--accent-green,#22c55e);">${parseFloat(t.importe)>0 ? _fmtAmt(t.importe) : '—'}</td>
      <td style="text-align:right;color:#f97316;">${noFin ? '<span title="Sin fecha fin" style="color:var(--text-secondary);font-size:10px;">sin fin</span>' : parseFloat(t.peajes_auto)>0 ? _fmtAmt(t.peajes_auto) : '—'}</td>
      <td style="text-align:right;color:#ef4444;">${noFin ? '' : parseFloat(t.multas_pendientes)>0 ? _fmtAmt(t.multas_pendientes) : '—'}</td>
      <td style="text-align:right;font-weight:700;">${noFin ? '' : (parseFloat(t.importe)||0)+(parseFloat(t.peajes_auto)||0)+(parseFloat(t.multas_pendientes)||0)>0 ? _fmtAmt((parseFloat(t.importe)||0)+(parseFloat(t.peajes_auto)||0)+(parseFloat(t.multas_pendientes)||0)) : '—'}</td>
      <td style="white-space:nowrap;">
        <button class="tbl-action-btn tbl-btn-view"   onclick="openModalTurno(${t.id}, true)"  title="Ver detalle"><i class="fa-solid fa-eye"></i></button>
        <button class="tbl-action-btn tbl-btn-edit"   onclick="openModalTurno(${t.id}, false)" title="Editar"><i class="fa-solid fa-pen"></i></button>
        ${canDel ? `<button class="tbl-action-btn tbl-btn-delete" onclick="deleteTurno(${t.id})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>` : ''}
      </td>
    </tr>`;
  }).join('');

  // Fila de totales
  const totRow = document.getElementById('turnos-totals-row');
  if (totRow) {
    document.getElementById('tt-count').textContent  = `${_turnosData.length} turnos`;
    document.getElementById('tt-horas').textContent  = totHoras   > 0 ? _fmtHM(totHoras) : '';
    document.getElementById('tt-km').textContent     = totKm      > 0 ? _fmtN(totKm,0) + ' km'  : '';
    document.getElementById('tt-gnc').textContent    = totGnc    > 0 ? _fmtAmt(totGnc)    : '';
    document.getElementById('tt-viajes').textContent = totViajes > 0 ? _fmtAmt(totViajes) : '';
    const _ttImporte = document.getElementById('tt-importe');
    if (_ttImporte) { if (totImporte > 0) animateCounter(_ttImporte, totImporte, v => _fmtAmt(v)); else _ttImporte.textContent = ''; }
    document.getElementById('tt-pjauto').textContent = totPjAuto  > 0 ? _fmtAmt(totPjAuto)        : '';
    document.getElementById('tt-multas').textContent = totMultas  > 0 ? _fmtAmt(totMultas)        : '';
    const totDia = totImporte + totPjAuto + totMultas;
    document.getElementById('tt-adeuda').textContent = totDia > 0 ? _fmtAmt(totDia) : '';
    const ttPagos = document.getElementById('tt-pagos');
    if (ttPagos) ttPagos.textContent = totalRendiciones > 0 ? _fmtAmt(totalRendiciones) : '';
    totRow.style.display = '';
  }
  // Saldo = Total Día (importe + peajes + multas) − Pagos (rendiciones)
  const saldo = totImporte + totPjAuto + totMultas - totalRendiciones;
  staggerTableRows(document.getElementById('turnos-tbody'));
  injectExportBar('table-turnos', 'Turnos');
  _renderTurnosSaldo(saldo);
}

function _renderTurnosSaldo(saldo) {
  const slot  = document.getElementById('turnos-saldo-slot');
  const valor = document.getElementById('turnos-saldo-valor');
  if (!slot || !valor) return;

  const color    = saldo >= 0 ? '#22c55e' : '#ef4444';
  const signo    = saldo >= 0 ? '+' : '−';
  const monto    = Math.abs(saldo).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const borderC  = saldo >= 0 ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.35)';

  valor.textContent      = `${signo}$ ${monto}`;
  valor.style.color      = color;
  slot.style.display     = 'flex';
  slot.style.borderColor = borderC;

  // Mostrar botón Detalle solo cuando hay un chofer filtrado
  const choferId = document.getElementById('turnos-filter-chofer')?.value;
  const detalleBtn = document.getElementById('turnos-detalle-btn');
  if (detalleBtn) detalleBtn.style.display = choferId ? '' : 'none';
}

async function openTurnosDetalle() {
  const selEl    = document.getElementById('turnos-filter-chofer');
  const choferId = selEl?.value;
  if (!choferId) {
    showToast('Seleccioná un chofer para ver el detalle', 'warning');
    return;
  }
  const choferNombre = selEl.options[selEl.selectedIndex]?.text || '';
  document.getElementById('td-chofer-nombre').textContent = choferNombre;

  const body = document.getElementById('td-body');
  body.innerHTML = '<div style="text-align:center;padding:32px;"><i class="fa-solid fa-spinner fa-spin" style="font-size:1.5rem;"></i></div>';
  openModal('modal-turnos-detalle');

  // Filtrar rendiciones por chofer seleccionado (evita mezclar con otros choferes)
  const rendDelChofer = _turnosRendList.filter(r => String(r.chofer_id) === String(choferId));
  // Obtener desglose de conceptos para cada rendición tipo 'pagos'
  const rendConConceptos = await Promise.all(
    rendDelChofer.map(async r => {
      if (!r._origen || r._origen === 'pagos') {
        try {
          const d = await fetch(`/api/pagos/${r.id}`).then(res => res.json());
          const cmap = {};
          (d.conceptos || []).forEach(c => { cmap[c.concepto] = parseFloat(c.monto) || 0; });
          return { ...r, cmap };
        } catch(_) { return { ...r, cmap: {} }; }
      }
      return { ...r, cmap: {} };
    })
  );

  _turnosDetalleRendList = rendConConceptos;
  _renderTurnosDetalle(rendConConceptos);
}

// Construye array unificado turno+rendición ordenado por fecha.
// Rendiciones aparecen como valores negativos (el chofer pagó).
function _buildTurnosDetalleRows(rendList) {
  const rows = [];
  _turnosData.forEach(t => {
    const alq = parseFloat(t.importe)           || 0;
    const pj  = parseFloat(t.peajes_auto)       || 0;
    const mul = parseFloat(t.multas_pendientes) || 0;
    rows.push({ tipo:'turno', id: t.id, fecha:new Date(t.fecha_inicio),
      label:_fmtDT(t.fecha_inicio), alquiler:alq, peajes:pj, multas:mul,
      total:alq + pj + mul, medio:'',
      fotoInicio: t.foto_km_inicio || '', fotoFin: t.foto_km_fin || '',
      kmInicio: t.km_inicio, kmFin: t.km_fin,
      fechaFin: t.fecha_fin });
  });
  rendList.forEach(r => {
    const monto = parseFloat(r.monto_total || r.monto) || 0;
    const alq   = r.cmap?.alquiler || 0;
    const pj    = r.cmap?.peajes   || 0;
    const mul   = r.cmap?.multas   || 0;
    const hasB  = alq + pj + mul > 0;
    const fch   = r.fecha ? new Date(r.fecha) : new Date(0);
    const fchHora = fch.getTime() ? fch.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',hour12:false}) : '';
    rows.push({ tipo:'rendicion', id: r.id, origen: r._origen || 'rendiciones', fecha:fch,
      label: fch.getTime() ? fch.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit'}) + (fchHora ? ' ' + fchHora : '') : '—',
      alquiler: hasB ? -alq : -monto,   // si hay desglose, alquiler; si no, total en col alquiler
      peajes:  -pj, multas: -mul,
      total:   -monto,                   // siempre el total real de la rendición
      medio:   r.cuenta_alias || r.medio_pago || '',
      comprobanteUrl: r.comprobante_url || '' });
  });
  return rows.sort((a, b) => a.fecha - b.fecha);
}

function _renderTurnosDetalle(rendList) {
  const body = document.getElementById('td-body');
  const rows = _buildTurnosDetalleRows(rendList);

  // Totales por columna (saldo neto de cada categoría)
  const totAlq  = rows.reduce((s, r) => s + r.alquiler, 0);
  const totPj   = rows.reduce((s, r) => s + r.peajes,   0);
  const totMul  = rows.reduce((s, r) => s + r.multas,   0);
  const totSald = rows.reduce((s, r) => s + r.total,    0); // == saldo del badge

  const thS = 'padding:7px 10px;font-size:12px;font-weight:600;border-bottom:2px solid var(--border-color);white-space:nowrap;position:sticky;top:0;background:var(--bg-secondary);z-index:1;';
  const tdS = 'padding:5px 10px;font-size:13px;border-bottom:1px solid var(--border-color);';
  const tdR = tdS + 'text-align:right;';
  const tfS = 'padding:8px 10px;font-weight:700;font-size:13px;border-top:2px solid var(--border-color);background:var(--bg-secondary);';
  const tfR = tfS + 'text-align:right;';

  const fmtAbs  = n => n !== 0 ? _fmtPeso(Math.abs(n)) : '—';
  const signStr = n => n < 0 ? '-' : '';
  const netColor = n => n > 0 ? '#22c55e' : n < 0 ? '#ef4444' : 'var(--text-secondary)';

  const tableRows = rows.map((r, idx) => {
    const isR   = r.tipo === 'rendicion';
    const zebra = idx % 2 === 0 ? 'background:var(--bg-secondary);' : 'background:var(--bg-primary,#fff);';
    const rowBg = isR ? 'background:rgba(239,68,68,.10);' : zebra;
    const badge = isR
      ? ` <span style="font-size:10px;font-weight:700;background:rgba(239,68,68,.15);color:#ef4444;padding:1px 5px;border-radius:4px;vertical-align:middle;">↩ REN</span>`
      : '';
    // Colores por tipo de fila
    const cAlq = isR ? '#ef4444' : '#22c55e';
    const cPj  = isR ? '#ef4444' : '#f97316';
    const cMul = '#ef4444';
    const cTot = isR ? '#ef4444' : '';
    const wTot = isR ? 'font-weight:700;' : 'font-weight:700;';

    const viewerData = JSON.stringify({
      tipo: r.tipo, id: r.id, label: r.label,
      fotoInicio: r.fotoInicio || '', fotoFin: r.fotoFin || '',
      kmInicio: r.kmInicio ?? '', kmFin: r.kmFin ?? '',
      fechaFin: r.fechaFin || '', comprobanteUrl: r.comprobanteUrl || '',
      origen: r.origen || ''
    }).replace(/'/g, '&#39;');
    const tdC = tdS + 'text-align:center;width:40px;padding:4px 6px;';

    return `<tr style="${rowBg}">
      <td style="${tdS}white-space:nowrap;">${r.label}${badge}</td>
      <td style="${tdC}"><button class="tbl-action-btn tbl-btn-view" onclick='openDetalleRowViewer(${viewerData})' title="Ver fotos / detalle"><i class="fa-solid fa-eye"></i></button></td>
      <td style="${tdR}color:${cAlq};">${r.alquiler !== 0 ? signStr(r.alquiler) + fmtAbs(r.alquiler) : '—'}</td>
      <td style="${tdR}color:${cPj};">${r.peajes   !== 0 ? signStr(r.peajes)   + fmtAbs(r.peajes)   : '—'}</td>
      <td style="${tdR}color:${cMul};">${r.multas   !== 0 ? signStr(r.multas)   + fmtAbs(r.multas)   : '—'}</td>
      <td style="${tdR}${wTot}color:${cTot || netColor(r.total)};">${signStr(r.total)}${fmtAbs(r.total)}</td>
      <td style="${tdS}font-size:11px;color:var(--text-secondary);">${r.medio}</td>
    </tr>`;
  }).join('');

  const saldoColor = totSald >= 0 ? '#22c55e' : '#ef4444';
  const saldoSign  = totSald >= 0 ? '+' : '−';

  body.innerHTML = `
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="${thS}text-align:left;">Fecha</th>
        <th style="${thS}width:40px;"></th>
        <th style="${thS}text-align:right;">Importe</th>
        <th style="${thS}text-align:right;color:#f97316;">Peajes</th>
        <th style="${thS}text-align:right;color:#ef4444;">Multas</th>
        <th style="${thS}text-align:right;">Total</th>
        <th style="${thS}text-align:left;">Medio</th>
      </tr></thead>
      <tbody>${tableRows || `<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--text-secondary);">Sin datos</td></tr>`}</tbody>
      <tfoot><tr>
        <td style="${tfS}" colspan="2">SALDO</td>
        <td style="${tfR}color:${netColor(totAlq)};">${totAlq!==0?signStr(totAlq)+fmtAbs(totAlq):'—'}</td>
        <td style="${tfR}color:${netColor(totPj)};">${totPj!==0?signStr(totPj)+fmtAbs(totPj):'—'}</td>
        <td style="${tfR}color:${netColor(totMul)};">${totMul!==0?signStr(totMul)+fmtAbs(totMul):'—'}</td>
        <td style="${tfR}font-size:16px;color:${saldoColor};">${saldoSign}${_fmtPeso(Math.abs(totSald))}</td>
        <td style="${tfS}"></td>
      </tr></tfoot>
    </table>`;
}

function exportTurnosDetalleXLS() {
  if (!window.XLSX) { showToast('Librería XLS no cargada'); return; }
  const rows   = _buildTurnosDetalleRows(_turnosDetalleRendList);
  if (!rows.length) { showToast('Sin datos para exportar'); return; }
  const chofer = document.getElementById('td-chofer-nombre')?.textContent || 'Chofer';
  const desde  = document.getElementById('turnos-desde')?.value || '';
  const hasta  = document.getElementById('turnos-hasta')?.value  || '';

  const aoa = [['Fecha', 'Tipo', 'Importe/Alquiler', 'Peajes', 'Multas/Deuda', 'Total', 'Medio']];
  rows.forEach(r => aoa.push([
    r.label,
    r.tipo === 'turno' ? 'Turno' : 'Rendición',
    r.alquiler || 0,
    r.peajes   || 0,
    r.multas   || 0,
    r.total    || 0,
    r.medio    || '',
  ]));
  const totSald = rows.reduce((s, r) => s + r.total, 0);
  const totAlq  = rows.reduce((s, r) => s + r.alquiler, 0);
  const totPj   = rows.reduce((s, r) => s + r.peajes,   0);
  const totMul  = rows.reduce((s, r) => s + r.multas,   0);
  aoa.push([]);
  aoa.push(['SALDO', '', totAlq, totPj, totMul, totSald, '']);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const numCols = [2, 3, 4, 5];
  for (let ri = 1; ri < aoa.length; ri++) {
    numCols.forEach(ci => {
      const addr = XLSX.utils.encode_cell({ r: ri, c: ci });
      if (ws[addr] && typeof ws[addr].v === 'number') { ws[addr].t = 'n'; ws[addr].z = '#,##0.00'; }
    });
  }
  ws['!cols'] = [{wch:22},{wch:12},{wch:16},{wch:14},{wch:14},{wch:16},{wch:22}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Detalle');
  const fname = `Detalle_${chofer.replace(/\s+/g,'_')}_${desde}${hasta?'_'+hasta:''}.xlsx`;
  XLSX.writeFile(wb, fname);
  showToast('Detalle.xlsx descargado');
}

async function shareTurnosDetalleWA() {
  const rows   = _buildTurnosDetalleRows(_turnosDetalleRendList);
  if (!rows.length) { showToast('Sin datos para compartir'); return; }
  const chofer = document.getElementById('td-chofer-nombre')?.textContent || '';
  const desde  = document.getElementById('turnos-desde')?.value || '';
  const hasta  = document.getElementById('turnos-hasta')?.value  || '';
  const fmtD   = s => s ? s.split('-').reverse().join('/') : '';
  const totSald = rows.reduce((s, r) => s + r.total, 0);

  let txt = `*Detalle — ${chofer}*`;
  if (desde || hasta) txt += `\nPeríodo: ${fmtD(desde)}${hasta ? ' → ' + fmtD(hasta) : ''}`;
  txt += '\n';

  rows.forEach(r => {
    const isR   = r.tipo === 'rendicion';
    const signo = r.total >= 0 ? '+' : '-';
    const monto = '$ ' + Math.abs(r.total).toLocaleString('es-AR', {minimumFractionDigits:2, maximumFractionDigits:2});
    const extra = isR && r.medio ? ` (${r.medio})` : '';
    txt += `\n${isR ? '↩ Rend.' : '🔷 Turno'} ${r.label}: ${signo}${monto}${extra}`;
  });

  const saldoSign = totSald >= 0 ? '+' : '-';
  const saldoMonto = '$ ' + Math.abs(totSald).toLocaleString('es-AR', {minimumFractionDigits:2, maximumFractionDigits:2});
  txt += `\n\n*Saldo: ${saldoSign}${saldoMonto}*`;

  // Pre-generar XLS para adjuntar
  if (window.XLSX) {
    const aoa = [['Fecha', 'Tipo', 'Importe/Alquiler', 'Peajes', 'Multas/Deuda', 'Total', 'Medio']];
    rows.forEach(r => aoa.push([r.label, r.tipo === 'turno' ? 'Turno' : 'Rendición', r.alquiler||0, r.peajes||0, r.multas||0, r.total||0, r.medio||'']));
    const totAlq = rows.reduce((s, r) => s + r.alquiler, 0);
    const totPj  = rows.reduce((s, r) => s + r.peajes,   0);
    const totMul = rows.reduce((s, r) => s + r.multas,   0);
    aoa.push([]);
    aoa.push(['SALDO', '', totAlq, totPj, totMul, totSald, '']);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{wch:22},{wch:12},{wch:16},{wch:14},{wch:14},{wch:16},{wch:22}];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Detalle');
    const fname = `Detalle_${chofer.replace(/\s+/g,'_')}_${desde}${hasta?'_'+hasta:''}.xlsx`;
    _waPreXls = { base64: XLSX.write(wb, { bookType: 'xlsx', type: 'base64' }), filename: fname };
  }

  await openWhatsAppModal(null, `Detalle ${chofer}`);
  const waEl = document.getElementById('wa-message');
  if (waEl) waEl.value = txt;
}

// ── Mini-visor de fotos desde el detalle de chofer ───────────────────────────
function openDetalleRowViewer(data) {
  const ov = document.getElementById('modal-row-viewer');
  if (!ov) return;

  const isTurno = data.tipo === 'turno';
  const title   = isTurno
    ? `Turno — ${data.label}`
    : `Rendición — ${data.label}`;

  document.getElementById('drv-title').textContent = title;

  const body = document.getElementById('drv-body');

  if (isTurno) {
    const hasInicio = !!data.fotoInicio;
    const hasFin    = !!data.fotoFin;
    const kmI = data.kmInicio != null && data.kmInicio !== '' ? _fmtN(data.kmInicio, 0) + ' km' : '—';
    const kmF = data.kmFin    != null && data.kmFin    !== '' ? _fmtN(data.kmFin,    0) + ' km' : '—';
    const fFin = data.fechaFin ? _fmtDT(data.fechaFin) : '—';

    body.innerHTML = `
      <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">
        <span style="font-size:12px;color:var(--text-secondary);">Fin: <b>${fFin}</b></span>
        <span style="font-size:12px;color:var(--text-secondary);">KM inicio: <b>${kmI}</b></span>
        <span style="font-size:12px;color:var(--text-secondary);">KM fin: <b>${kmF}</b></span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">📷 KM Inicio</div>
          ${hasInicio
            ? `<img src="${data.fotoInicio}" style="width:100%;border-radius:6px;cursor:zoom-in;border:1px solid var(--border-color);" onclick="openImgViewer('${data.fotoInicio}','KM Inicio')">`
            : `<div style="width:100%;aspect-ratio:4/3;background:var(--bg-secondary);border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--text-secondary);font-size:12px;border:1px dashed var(--border-color);">Sin foto</div>`}
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">📷 KM Fin</div>
          ${hasFin
            ? `<img src="${data.fotoFin}" style="width:100%;border-radius:6px;cursor:zoom-in;border:1px solid var(--border-color);" onclick="openImgViewer('${data.fotoFin}','KM Fin')">`
            : `<div style="width:100%;aspect-ratio:4/3;background:var(--bg-secondary);border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--text-secondary);font-size:12px;border:1px dashed var(--border-color);">Sin foto</div>`}
        </div>
      </div>`;
  } else {
    const hasComp = !!data.comprobanteUrl;
    const isPdf   = hasComp && data.comprobanteUrl.toLowerCase().endsWith('.pdf');
    body.innerHTML = `
      <div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;">🧾 Comprobante de pago</div>
      ${hasComp
        ? isPdf
          ? `<div style="text-align:center;padding:24px;background:var(--bg-secondary);border-radius:6px;border:1px solid var(--border-color);">
               <i class="fa-solid fa-file-pdf" style="font-size:48px;color:#e74c3c;display:block;margin-bottom:8px;"></i>
               <button class="btn btn-secondary btn-sm" onclick="openDocViewer('${data.comprobanteUrl}','Comprobante',true)">
                 <i class="fa-solid fa-eye"></i> Ver PDF
               </button>
             </div>`
          : `<img src="${data.comprobanteUrl}" style="width:100%;border-radius:6px;cursor:zoom-in;border:1px solid var(--border-color);max-height:400px;object-fit:contain;" onclick="openImgViewer('${data.comprobanteUrl}','Comprobante')">`
        : `<div style="padding:32px;text-align:center;background:var(--bg-secondary);border-radius:6px;border:1px dashed var(--border-color);color:var(--text-secondary);font-size:13px;">Sin comprobante adjunto</div>`}`;
  }

  openModal('modal-row-viewer');
}

function _vehLabel(v) {
  return [v.patente, [v.marca, v.modelo].filter(Boolean).join(' ')].filter(Boolean).join(' - ');
}

async function _populateTurnoFiltros() {
  // Choferes
  const selCh = document.getElementById('turnos-filter-chofer');
  if (selCh && !selCh.dataset.loaded) {
    selCh.dataset.loaded = '1';
    if (!cachedChoferes.length) await loadChoferesSelect();
    cachedChoferes.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.nombre || '';
      selCh.appendChild(o);
    });
    SmartCombo.refresh(selCh);
  }
  // Vehículos
  const selV = document.getElementById('turnos-filter-vehiculo');
  if (selV && !selV.dataset.loaded) {
    selV.dataset.loaded = '1';
    try {
      const veh = await fetch('/api/vehiculos').then(r=>r.json());
      veh.forEach(v => {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = _vehLabel(v);
        selV.appendChild(o);
      });
      SmartCombo.refresh(selV);
    } catch(_) { delete selV.dataset.loaded; }
  }
}

function clearTurnosFilters() {
  const hoy = new Date();
  document.getElementById('turnos-desde').value = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}-01`;
  document.getElementById('turnos-hasta').value = hoy.toISOString().slice(0,10);
  _clearSelect('turnos-filter-chofer');
  _clearSelect('turnos-filter-vehiculo');
  loadTurnos();
}

async function openModalTurno(id = null, soloVer = false) {
  _turnoEditId = soloVer ? null : id;
  document.getElementById('form-turno').reset();
  document.getElementById('tur-horas').value     = '';
  document.getElementById('tur-recorrido').value = '';
  document.getElementById('tur-importe').value   = '';
  // Resetear dropzones km y novedad
  _turnoNovedadFile = null;
  _initTurnoKmDropzones();
  _dzKmInicio?.clear(); _dzKmInicio?.setReadonly(false);
  _dzKmFin?.clear();    _dzKmFin?.setReadonly(false);
  // Limpiar campos KM explícitamente (form.reset() no borra dataset.raw)
  ['tur-km-inicio','tur-km-fin'].forEach(id2 => {
    const el = document.getElementById(id2);
    if (el) { el.value = ''; el.dataset.raw = ''; }
  });
  _dzAceite?.clear();   _dzAceite?.setReadonly(false);
  const _hFotoAceiteReset = document.getElementById('tur-foto-aceite');
  if (_hFotoAceiteReset) _hFotoAceiteReset.value = '';
  const _novedadDropReset = document.getElementById('tur-novedad-drop');
  if (_novedadDropReset) { _novedadDropReset.style.pointerEvents = ''; _novedadDropReset.style.cursor = 'pointer'; }
  document.getElementById('tur-foto-km-inicio')?.setAttribute('value','');
  document.getElementById('tur-foto-km-fin')?.setAttribute('value','');
  document.getElementById('tur-combustible-inicio')?.setAttribute('value','');
  document.getElementById('tur-combustible-fin')?.setAttribute('value','');
  const alertWrap = document.getElementById('tur-combustible-alert-wrap');
  if (alertWrap) alertWrap.style.display = 'none';
  turNovedadClear();
  // Ocultar detalle al abrir
  const detEl = document.getElementById('tur-detalle-adeuda');
  if (detEl) detEl.style.display = 'none';

  // Poblar selects del modal
  const selCh = document.getElementById('tur-chofer');
  selCh.innerHTML = '<option value="">— Seleccionar —</option>';
  if (!cachedChoferes.length) await loadChoferesSelect();
  cachedChoferes.filter(c=>c.activo).forEach(c => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = (c.nombre||'') + (c.apellido ? ' ' + c.apellido : '');
    o.dataset.modalidad = c.modalidad || '';
    selCh.appendChild(o);
  });

  const selV = document.getElementById('tur-vehiculo');
  selV.innerHTML = '<option value="">— Sin vehículo —</option>';
  try {
    const veh = await fetch('/api/vehiculos').then(r=>r.json());
    veh.forEach(v => {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.patente + (v.marca ? ' (' + v.marca + (v.modelo?' '+v.modelo:'') + ')' : '');
      selV.appendChild(o);
    });
  } catch(_) {}

  if (id) {
    document.getElementById('modal-turno-title').innerHTML = soloVer
      ? `<i class="fa-solid fa-eye"></i> Turno #${id}`
      : `<i class="fa-solid fa-clock-rotate-left"></i> Editar Turno #${id}`;
    document.getElementById('btn-turno-submit').style.display = soloVer ? 'none' : '';
    try {
      const r = await fetch(`/api/turnos/${id}`);
      if (!r.ok) throw new Error((await r.json().catch(()=>({message:r.statusText}))).message);
      const t = await r.json();
      // Primero setear los valores, luego deshabilitar
      const _ss = (elId, val) => {
        const el = document.getElementById(elId);
        if (!el || val == null) return;
        el.value = String(val);
        if (el._ssSet) el._ssSet(String(val));
      };
      _ss('tur-chofer',   t.chofer_id);
      _ss('tur-vehiculo', t.vehiculo_id ?? '');
      document.getElementById('tur-inicio').value    = t.fecha_inicio ? new Date(new Date(t.fecha_inicio).getTime()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16) : '';
      document.getElementById('tur-fin').value       = t.fecha_fin    ? new Date(new Date(t.fecha_fin).getTime()   -new Date().getTimezoneOffset()*60000).toISOString().slice(0,16) : '';
      setAmt('tur-modalidad', t.modalidad ?? 0);
      fmtKmInput(Object.assign(document.getElementById('tur-km-inicio'), { value: t.km_inicio ?? '' }));
      fmtKmInput(Object.assign(document.getElementById('tur-km-fin'),    { value: t.km_fin    ?? '' }));
      document.getElementById('tur-notas').value = t.notas || '';
      // Fotos km y combustible
      const _setH = (id, val) => { const el=document.getElementById(id); if(el) el.value=val||''; };
      _setH('tur-foto-km-inicio',     t.foto_km_inicio);
      _setH('tur-foto-km-fin',        t.foto_km_fin);
      _setH('tur-combustible-inicio', t.combustible_inicio);
      _setH('tur-combustible-fin',    t.combustible_fin);
      // Fotos km existentes → instancias DropZone
      if (t.foto_km_inicio) {
        _dzKmInicio?.loadUrl(t.foto_km_inicio);
        const combI = t.combustible_inicio ? ` · ${_COMBUSTIBLE_ICON[t.combustible_inicio]||''} ${t.combustible_inicio}` : '';
        _dzKmInicio?._setStatus(`📁 Foto guardada${combI}`, 'ok');
      } else {
        _dzKmInicio?._setStatus('Sin foto tablero — arrastrá una imagen y clickeá IA', 'info');
      }
      if (t.foto_km_fin) {
        _dzKmFin?.loadUrl(t.foto_km_fin);
        const combF = t.combustible_fin ? ` · ${_COMBUSTIBLE_ICON[t.combustible_fin]||''} ${t.combustible_fin}` : '';
        _dzKmFin?._setStatus(`📁 Foto guardada${combF}`, 'ok');
      } else {
        _dzKmFin?._setStatus('Sin foto tablero — arrastrá una imagen y clickeá IA', 'info');
      }
      _turCheckCombustible();
      // Foto aceite existente
      const hNivel = document.getElementById('tur-aceite-nivel');
      const hFotoA = document.getElementById('tur-foto-aceite');
      if (hNivel) hNivel.value = t.aceite_nivel || '';
      if (hFotoA) hFotoA.value = t.foto_aceite || '';
      if (t.foto_aceite) {
        _dzAceite?.loadUrl(t.foto_aceite);
        if (t.aceite_nivel) {
          const _ACEITE_ICON = { normal:'🟢', bajo:'🔴', alto:'🟠', sin_aceite:'⚫' };
          const icon = _ACEITE_ICON[t.aceite_nivel] || '❓';
          _dzAceite?._setStatus(`${icon} Aceite: ${t.aceite_nivel}`, t.aceite_nivel === 'bajo' || t.aceite_nivel === 'sin_aceite' ? 'error' : 'ok');
        }
      }
      // Foto novedad existente
      turNovedadClear();
      if (t.foto_novedad) {
        const prev = document.getElementById('tur-novedad-preview');
        const wrap = document.getElementById('tur-novedad-preview-wrap');
        const lbl  = document.getElementById('tur-novedad-drop-label');
        if (prev) { prev.src = t.foto_novedad; prev.dataset.url = t.foto_novedad; }
        if (wrap) wrap.style.display = '';
        if (lbl)  lbl.textContent = 'Foto adjunta (tocá para cambiar)';
      }
      setAmt('tur-viajes', t.viajes);
      setAmt('tur-gnc',    t.gnc);
      setAmt('tur-peajes', t.peajes);
      calcTurno();
      requestAnimationFrame(() => { ['tur-chofer','tur-vehiculo'].forEach(id2 => document.getElementById(id2)?._scRefresh?.()); });
      // Deshabilitar DESPUÉS de setear valores
      const formEls = document.querySelectorAll('#form-turno input, #form-turno select, #form-turno textarea');
      formEls.forEach(el => { el.disabled = soloVer; });
      // Bloquear dropzones en modo vista
      _dzKmInicio?.setReadonly(soloVer);
      _dzKmFin?.setReadonly(soloVer);
      _dzAceite?.setReadonly(soloVer);
      // Dropzone de novedad (manual, no usa clase DropZone)
      const novedadDrop = document.getElementById('tur-novedad-drop');
      if (novedadDrop) {
        novedadDrop.style.pointerEvents = soloVer ? 'none' : '';
        novedadDrop.style.cursor        = soloVer ? 'default' : 'pointer';
      }
      const novedadDelBtn = document.querySelector('#tur-novedad-preview-wrap button');
      if (novedadDelBtn) novedadDelBtn.style.display = soloVer ? 'none' : '';
      // Detalle peajes + multas
      _renderTurnoDetalle(t);
    } catch(e) { showToast('Error al cargar turno: ' + e.message, 'error'); console.error(e); return; }
  } else {
    // Modo nuevo — habilitar todo
    document.querySelectorAll('#form-turno input, #form-turno select, #form-turno textarea').forEach(el => { el.disabled = false; });
    document.getElementById('btn-turno-submit').style.display = '';
    document.getElementById('modal-turno-title').innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i> Nuevo Turno`;
    const now = new Date(Date.now() - new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
    document.getElementById('tur-inicio').value = now;
    requestAnimationFrame(() => { ['tur-chofer','tur-vehiculo'].forEach(id2 => document.getElementById(id2)?._scRefresh?.()); });
  }
  openModal('modal-turno');
}

let _turnoDetalleActual = null;
let _waPreXls = null; // XLS pre-generado para adjuntar en WA

function _renderTurnoDetalle(t) {
  _turnoDetalleActual = t;
  const el = document.getElementById('tur-detalle-adeuda');
  const btnXls = document.getElementById('btn-turno-xls');
  const btnWa  = document.getElementById('btn-turno-wa');
  if (!el) return;

  if (!t.fecha_fin) {
    el.innerHTML = `<div style="color:var(--text-secondary);font-size:12px;padding:8px 0;"><i class="fa-solid fa-circle-info"></i> Sin fecha/hora fin — completá el turno para ver peajes y multas asignados.</div>`;
    el.style.display = 'block';
    if (btnXls) btnXls.style.display = 'none';
    if (btnWa)  btnWa.style.display  = 'none';
    return;
  }

  const peajes = t.peajes_detalle || [];
  const multas = t.multas_detalle || [];

  if (!peajes.length && !multas.length) {
    el.innerHTML = '<div style="color:var(--text-secondary);font-size:12px;padding:8px 0;"><i class="fa-solid fa-circle-check"></i> Sin peajes ni multas en este turno.</div>';
    el.style.display = 'block';
    if (btnXls) btnXls.style.display = 'none';
    if (btnWa)  btnWa.style.display  = 'none';
    return;
  }

  // Mostrar botones de exportación
  if (btnXls) btnXls.style.display = '';
  if (btnWa)  btnWa.style.display  = '';

  let html = '';

  if (peajes.length) {
    const total = peajes.reduce((s,p) => s + parseFloat(p.importe||0), 0);
    html += `<div style="margin-top:12px;">
      <div style="font-weight:600;color:#f97316;margin-bottom:4px;"><i class="fa-solid fa-road"></i> Peajes en el turno — ${_fmtPeso(total)}</div>
      <table style="width:100%;font-size:12px;border-collapse:collapse;">
        <thead><tr style="color:var(--text-secondary);border-bottom:1px solid var(--border-color);">
          <th style="text-align:left;padding:3px 6px;">Autopista</th>
          <th style="text-align:left;padding:3px 6px;">Barrera</th>
          <th style="text-align:left;padding:3px 6px;">Patente</th>
          <th style="text-align:center;padding:3px 6px;">Fecha y Hora</th>
          <th style="text-align:right;padding:3px 6px;">Importe</th>
        </tr></thead><tbody>
        ${peajes.map(p => `<tr style="border-top:1px solid var(--border-color);">
          <td style="padding:3px 6px;">${p.autopista||'—'}</td>
          <td style="padding:3px 6px;">${p.barrera||'—'}</td>
          <td style="padding:3px 6px;font-weight:600;">${p.patente||'—'}</td>
          <td style="padding:3px 6px;text-align:center;white-space:nowrap;">${p.fecha_hora ? new Date(p.fecha_hora).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '—'}</td>
          <td style="padding:3px 6px;text-align:right;color:#f97316;">${_fmtPeso(p.importe)}</td>
        </tr>`).join('')}
        </tbody>
      </table></div>`;
  }

  if (multas.length) {
    const total = multas.reduce((s,m) => s + parseFloat(m.monto||0), 0);
    html += `<div style="margin-top:12px;">
      <div style="font-weight:600;color:#ef4444;margin-bottom:4px;"><i class="fa-solid fa-triangle-exclamation"></i> Multas del turno — ${_fmtPeso(total)}</div>
      <table style="width:100%;font-size:12px;border-collapse:collapse;">
        <thead><tr style="color:var(--text-secondary);border-bottom:1px solid var(--border-color);">
          <th style="text-align:left;padding:3px 6px;">Acta</th>
          <th style="text-align:left;padding:3px 6px;">Descripción</th>
          <th style="text-align:center;padding:3px 6px;">Fecha y Hora</th>
          <th style="text-align:right;padding:3px 6px;">Monto</th>
          <th style="text-align:center;padding:3px 6px;">Estado</th>
          <th style="text-align:center;padding:3px 6px;">Adj.</th>
        </tr></thead><tbody>
        ${multas.map(m => {
          let adjuntos = [];
          try { adjuntos = m.adjuntos_json ? (typeof m.adjuntos_json === 'string' ? JSON.parse(m.adjuntos_json) : m.adjuntos_json) : []; } catch(_) {}
          if (m.archivo_adjunto && !adjuntos.length) adjuntos = [{url: m.archivo_adjunto, tipo: 'imagen', nombre: 'adjunto'}];
          const adjHtml = adjuntos.length
            ? adjuntos.map(a => {
                const icon = a.tipo === 'pdf' ? 'fa-file-pdf' : a.tipo === 'video' ? 'fa-file-video' : 'fa-image';
                const color = a.tipo === 'pdf' ? '#ef4444' : a.tipo === 'video' ? '#8b5cf6' : '#3b82f6';
                return `<a href="${a.url}" target="_blank" title="${a.nombre||'ver adjunto'}" style="color:${color};font-size:14px;margin:0 2px;"><i class="fa-solid ${icon}"></i></a>`;
              }).join('')
            : '—';
          const fechaHora = m.fecha_infraccion
            ? new Date(m.fecha_infraccion).toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit'})
              + (m.hora_infraccion ? ' ' + m.hora_infraccion.slice(0,5) : '')
            : '—';
          const estadoBadge = m.estado === 'pagada'
            ? `<span style="background:#22c55e;color:#fff;font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600;">Pagada</span>`
            : m.estado === 'apelada'
            ? `<span style="background:#3b82f6;color:#fff;font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600;">Apelada</span>`
            : `<span style="background:#f59e0b;color:#fff;font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600;">Pendiente</span>`;
          const rowStyle = m.estado === 'pagada' ? 'opacity:.7;' : '';
          return `<tr style="border-top:1px solid var(--border-color);${rowStyle}">
            <td style="padding:3px 6px;white-space:nowrap;">${m.numero_acta||'—'}</td>
            <td style="padding:3px 6px;">${m.descripcion||'—'}</td>
            <td style="padding:3px 6px;text-align:center;white-space:nowrap;">${fechaHora}</td>
            <td style="padding:3px 6px;text-align:right;color:#ef4444;">${_fmtPeso(m.monto)}</td>
            <td style="padding:3px 6px;text-align:center;">${estadoBadge}</td>
            <td style="padding:3px 6px;text-align:center;">${adjHtml}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table></div>`;
  }

  el.innerHTML = html;
  el.style.display = 'block';
}

function _buildTurnoWB(t) {
  const wb = XLSX.utils.book_new();
  const resumen = [
    ['Campo','Valor'],
    ['Turno #', t.id],
    ['Chofer', t.chofer_nombre||''],
    ['Vehículo', t.vehiculo_patente||''],
    ['Fecha Inicio', t.fecha_inicio ? new Date(t.fecha_inicio).toLocaleString('es-AR') : ''],
    ['Fecha Fin',    t.fecha_fin    ? new Date(t.fecha_fin).toLocaleString('es-AR')    : ''],
    ['Horas', t.fecha_fin ? +((new Date(t.fecha_fin)-new Date(t.fecha_inicio))/3600000).toFixed(2) : ''],
    ['Km Inicio', t.km_inicio??''], ['Km Fin', t.km_fin??''],
    ['Recorrido km', t.km_inicio!=null&&t.km_fin!=null ? +(parseFloat(t.km_fin)-parseFloat(t.km_inicio)).toFixed(1) : ''],
    ['Modalidad', t.modalidad??''], ['GNC', t.gnc??0], ['Viajes', t.viajes??0],
    ['Peajes Declarados', t.peajes??0], ['Importe', t.importe??0],
    ['',''],
    ['Total Peajes Auto', t.peajes_auto??0], ['Total Multas', t.multas_pendientes??0],
    ['TOTAL ADEUDA', (parseFloat(t.peajes_auto)||0)+(parseFloat(t.multas_pendientes)||0)],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumen), 'Resumen');
  // Hoja peajes
  if ((t.peajes_detalle||[]).length) {
    const totalPeajesAuto = t.peajes_detalle.reduce((s,p) => s + (parseFloat(p.importe)||0), 0);
    const totalMultasP    = parseFloat(t.multas_pendientes)||0;
    const alquilerP       = parseFloat(t.importe)||0;
    const rows = [['Autopista','Barrera / Pórtico','Patente','Fecha y Hora','Importe']];
    t.peajes_detalle.forEach(p => rows.push([
      p.autopista||'',
      p.barrera||'',
      p.patente||'',
      p.fecha_hora ? new Date(p.fecha_hora).toLocaleString('es-AR') : '',
      parseFloat(p.importe)||0
    ]));
    rows.push(['','','','','']);
    rows.push(['','','','Total peajes auto', totalPeajesAuto]);
    if (totalMultasP) rows.push(['','','','Total multas pendientes', totalMultasP]);
    rows.push(['','','','TOTAL ADEUDA', totalPeajesAuto + totalMultasP]);
    rows.push(['','','','','']);
    rows.push(['','','','Alquiler', alquilerP]);
    rows.push(['','','','TOTAL GENERAL', alquilerP + totalPeajesAuto + totalMultasP]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Peajes');
  }
  // Hoja multas
  if ((t.multas_detalle||[]).length) {
    const rows = [['Acta','Descripción','Fecha','Hora','Lugar','Monto','Estado']];
    t.multas_detalle.forEach(m => rows.push([m.numero_acta||'', m.descripcion||'', m.fecha_infraccion?new Date(m.fecha_infraccion).toLocaleDateString('es-AR'):'', m.hora_infraccion||'', m.lugar||'', parseFloat(m.monto)||0, m.estado||'']));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Multas');
  }
  return wb;
}

function exportTurnoDetalleXLS() {
  const t = _turnoDetalleActual;
  if (!t) return;
  const wb = _buildTurnoWB(t);
  XLSX.writeFile(wb, `Turno_${t.id}_${(t.chofer_nombre||'').replace(/\s+/g,'_')}.xlsx`);
  showToast('Excel del turno descargado');
}

async function shareTurnoDetalleWA() {
  const t = _turnoDetalleActual;
  if (!t) return;

  const _dt = (d) => {
    if (!d) return '—';
    const x = new Date(d);
    return `${String(x.getDate()).padStart(2,'0')}/${String(x.getMonth()+1).padStart(2,'0')}/${String(x.getFullYear()).slice(2)}  ${String(x.getHours()).padStart(2,'0')}:${String(x.getMinutes()).padStart(2,'0')}`;
  };
  const SEP = '――――――――――――――――――――';
  const horas = t.fecha_fin ? _fmtHM((new Date(t.fecha_fin)-new Date(t.fecha_inicio))/3600000) : '—';
  const km = t.km_inicio!=null&&t.km_fin!=null ? (parseFloat(t.km_fin)-parseFloat(t.km_inicio)).toFixed(0)+' km' : '—';

  let txt = '';
  txt += `🚖 *Turno #${t.id} — FlotaControl*\n`;
  txt += SEP + '\n';
  txt += `👤 *${t.chofer_nombre||'—'}*\n`;
  txt += `🚗 ${t.vehiculo_patente||'—'}   ⏱ ${horas}h   📍 ${km}\n`;
  txt += `📅 ${_dt(t.fecha_inicio)}  →  ${_dt(t.fecha_fin)}\n`;
  txt += SEP + '\n';

  const alquiler = parseFloat(t.importe)||0;
  txt += `💰 Alquiler:  *${_fmtPeso(alquiler)}*\n`;

  // Peajes
  const peajesDetalle = t.peajes_detalle || [];
  const totalPeajes = peajesDetalle.length
    ? peajesDetalle.reduce((s,p) => s + parseFloat(p.importe||0), 0)
    : parseFloat(t.peajes_auto)||0;
  if (peajesDetalle.length) {
    txt += SEP + '\n';
    txt += `🛣 *Peajes autopista*\n`;
    // Preparar filas: 4 columnas — Autopista | Barrera | Fecha+Hora | Importe
    const pRows = peajesDetalle.map(p => {
      const dt  = p.fecha_hora ? (() => { const x=new Date(p.fecha_hora); return `${String(x.getDate()).padStart(2,'0')}/${String(x.getMonth()+1).padStart(2,'0')}  ${String(x.getHours()).padStart(2,'0')}:${String(x.getMinutes()).padStart(2,'0')}`; })() : '—';
      const imp = _fmtPeso(p.importe).replace('$ ','$');
      return { aut: p.autopista||'—', bar: p.barrera||'—', dt, imp };
    });
    const wA = Math.max(...pRows.map(r=>r.aut.length), 6);
    const wB = Math.max(...pRows.map(r=>r.bar.length), 7);
    const wD = 11; // "DD/MM  HH:MM"
    const wI = Math.max(...pRows.map(r=>r.imp.length), 8);
    const SEP2 = ' │ ';
    const linea = '─'.repeat(wA + wB + wD + wI + SEP2.length*3 + 2);
    txt += '```\n';
    pRows.forEach(r => {
      txt += r.aut.padEnd(wA) + SEP2 + r.bar.padEnd(wB) + SEP2 + r.dt.padEnd(wD) + SEP2 + r.imp.padStart(wI) + '\n';
    });
    txt += linea + '\n';
    const totStr = _fmtPeso(totalPeajes).replace('$ ','$');
    txt += 'TOTAL'.padEnd(wA + wB + wD + SEP2.length*2 + 2) + SEP2 + totStr.padStart(wI) + '\n';
    txt += '```\n';
  } else if (totalPeajes > 0) {
    txt += `🛣 Peajes:  *${_fmtPeso(totalPeajes)}*\n`;
  }

  // Multas
  const multasDetalle = t.multas_detalle || [];
  const totalMultas = multasDetalle.length
    ? multasDetalle.reduce((s,m) => s + parseFloat(m.monto||0), 0)
    : parseFloat(t.multas_pendientes)||0;
  if (multasDetalle.length) {
    txt += SEP + '\n';
    txt += `⛔ *Multas pendientes*\n`;
    const mRows = multasDetalle.map(m => {
      const fecha = m.fecha_infraccion ? new Date(m.fecha_infraccion).toLocaleDateString('es-AR') : '—';
      const acta  = `Acta ${m.numero_acta||'—'}`;
      const imp   = _fmtPeso(m.monto).replace('$ ','$');
      const desc  = m.descripcion ? ` (${m.descripcion})` : '';
      return { acta: acta + desc, fecha, imp };
    });
    const wActa = Math.max(...mRows.map(r => r.acta.length), 5);
    const wImpM = Math.max(...mRows.map(r => r.imp.length), 8);
    const lineaM = '─'.repeat(wActa + 14 + wImpM);
    txt += '```\n';
    mRows.forEach(r => {
      txt += r.acta.padEnd(wActa) + '  ' + r.fecha.padEnd(10) + '  ' + r.imp.padStart(wImpM) + '\n';
    });
    txt += lineaM + '\n';
    const totMStr = _fmtPeso(totalMultas).replace('$ ','$');
    txt += 'Total'.padEnd(wActa + 14) + totMStr.padStart(wImpM) + '\n';
    txt += '```\n';
  } else if (totalMultas > 0) {
    txt += `⛔ Multas:  *${_fmtPeso(totalMultas)}*\n`;
  }

  const totalGeneral = alquiler + totalPeajes + totalMultas;
  txt += SEP + '\n';
  txt += `💵 *TOTAL: ${_fmtPeso(totalGeneral)}*\n`;
  const partes = [`alquiler ${_fmtPeso(alquiler)}`];
  if (totalPeajes > 0) partes.push(`peajes ${_fmtPeso(totalPeajes)}`);
  if (totalMultas > 0) partes.push(`multas ${_fmtPeso(totalMultas)}`);
  txt += `_${partes.join(' + ')}_`;
  txt += '\n' + SEP + '\n';
  txt += `🚭 _Recordatorio: está prohibido fumar dentro del vehículo — chofer y pasajeros._`;

  // Pre-generar XLS para adjuntar
  if (window.XLSX) {
    const wb = _buildTurnoWB(t);
    _waPreXls = {
      base64:   XLSX.write(wb, { bookType: 'xlsx', type: 'base64' }),
      filename: `Turno_${t.id}_${(t.chofer_nombre||'').replace(/\s+/g,'_')}.xlsx`
    };
  }

  // Cargar adjuntos de multas del turno
  await _loadWAMultaAdjs(t.multas_detalle || []);

  await openWhatsAppModal(null, `Turno #${t.id}`, { tipo: 'chofer', id: t.chofer_id });
  document.getElementById('wa-message').value = txt;
}

let _waMultaAdjs = []; // [{ url, nombre, tipo, multaId }]

async function _loadWAMultaAdjs(multas) {
  _waMultaAdjs = [];
  const container = document.getElementById('wa-multa-adjs');
  const list      = document.getElementById('wa-multa-adjs-list');
  if (!container || !list || !multas.length) { if (container) container.style.display = 'none'; return; }

  // Fetch adjuntos de cada multa en paralelo
  const results = await Promise.all(multas.map(m =>
    fetch(`/api/multas/${m.id}/adjuntos`).then(r => r.json()).catch(() => [])
  ));

  results.forEach((adjs, i) => {
    const m = multas[i];
    // Agregar comprobante de pago primero si existe y no está ya en adjuntos
    if (m.comprobante_pago_url) {
      const compNombre = `Comprobante_${m.numero_acta || m.id}.pdf`;
      const yaEsta = adjs.some(a => a.url === m.comprobante_pago_url);
      if (!yaEsta) {
        _waMultaAdjs.push({ url: m.comprobante_pago_url, nombre: compNombre, tipo: 'pdf', multaId: m.id, esComprobante: true });
      }
    }
    adjs.forEach(a => {
      _waMultaAdjs.push({ url: a.url, nombre: a.nombre_original || a.url.split('/').pop(), tipo: a.tipo, multaId: m.id });
    });
  });

  if (!_waMultaAdjs.length) { container.style.display = 'none'; return; }

  const iconos = { imagen: '🖼', pdf: '📄', video: '🎥' };
  list.innerHTML = _waMultaAdjs.map((a, i) => `
    <label style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;border:1px solid var(--border-color);cursor:pointer;font-size:12px;" onmouseover="this.style.background='var(--hover-bg)'" onmouseout="this.style.background=''">
      <input type="checkbox" data-adj-idx="${i}" checked style="accent-color:#25d366;width:14px;height:14px;flex-shrink:0;">
      <span>${iconos[a.tipo] || '📎'}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${a.nombre}</span>
      <span style="color:var(--text-secondary);text-transform:uppercase;font-size:10px;font-weight:700;">${a.tipo}</span>
    </label>`).join('');
  container.style.display = 'flex';
}

function _kmFormat(raw) {
  // Formatea con coma como separador de miles: 422013 → "422,013"
  return raw ? parseInt(raw, 10).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '';
}
function fmtKmInput(el) {
  // Usado al cargar datos de DB o después de extracción IA
  let str = String(el.value ?? '').trim();
  // DB puede devolver decimales "269192.0" — tomar solo parte entera (1-2 decimales)
  if (/^\d+\.\d{1,2}$/.test(str)) str = str.split('.')[0];
  const raw = str.replace(/\D/g, '').slice(0, 10);
  el.dataset.raw = raw;
  el.value = _kmFormat(raw);
}
function kmInputAllow(el) {
  // Durante el tipeo: solo dígitos, sin formatear (no interrumpe al escribir)
  const raw = el.value.replace(/\D/g, '').slice(0, 10);
  el.value = raw;
  el.dataset.raw = raw;
}
function kmFocus(el) {
  // Al hacer foco: mostrar dígitos crudos para facilitar edición
  const raw = el.dataset.raw || el.value.replace(/\D/g, '');
  el.value = raw;
}
function kmBlur(el) {
  // Al perder foco: formatear con coma como separador
  const raw = (el.value || '').replace(/\D/g, '').slice(0, 10);
  el.dataset.raw = raw;
  el.value = _kmFormat(raw);
}

function validateKmFin() {
  const fin = document.getElementById('tur-fin')?.value;
  if (!fin && !_turnoEditId) return; // en turno nuevo sin fecha fin, no validar
  const elI = document.getElementById('tur-km-inicio');
  const elF = document.getElementById('tur-km-fin');
  const kmI = parseInt((elI.dataset.raw || elI.value.replace(/\D/g,'')), 10) || 0;
  const kmF = parseInt((elF.dataset.raw || elF.value.replace(/\D/g,'')), 10) || 0;
  if (kmF && kmI && kmF < kmI) {
    elF.style.borderColor = 'var(--color-error)';
    showToast('Km Fin no puede ser menor que Km Inicio', 'error');
  } else {
    elF.style.borderColor = '';
  }
}

function _getKm(id) {
  const el = document.getElementById(id);
  const raw = el?.dataset?.raw || el?.value?.replace(/\./g,'') || '';
  return parseInt(raw, 10) || null;
}

function onTurnoChoferChange() {
  const sel = document.getElementById('tur-chofer');
  const opt = sel.options[sel.selectedIndex];
  const mod = opt?.dataset?.modalidad || '';
  if (mod) setAmt('tur-modalidad', mod);
  calcTurno();
}

function calcTurno() {
  // Horas
  const ini = document.getElementById('tur-inicio').value;
  const fin  = document.getElementById('tur-fin').value;
  let horas = null;
  if (ini && fin) {
    const diff = (new Date(fin) - new Date(ini)) / 3600000;
    if (diff > 0) { horas = diff; document.getElementById('tur-horas').value = _fmtHM(diff); }
    else document.getElementById('tur-horas').value = '—';
  } else { document.getElementById('tur-horas').value = '—'; }

  // Recorrido
  const kmI = _getKm('tur-km-inicio');
  const kmF = _getKm('tur-km-fin');
  let rec = null;
  if (kmI && kmF && kmF > kmI) rec = kmF - kmI;
  else if (!kmI && kmF) rec = null; // sin km inicial no hay recorrido confiable
  document.getElementById('tur-recorrido').value = rec != null ? _fmtN(rec,1) + ' km' : (kmI || kmF) ? '—' : '';

  // Importe
  const mod    = _getAmtRaw('tur-modalidad');
  const viajes = _getAmtRaw('tur-viajes');
  const gnc    = _getAmtRaw('tur-gnc');
  const peajes = _getAmtRaw('tur-peajes');
  let importe = null;
  if (mod > 0) {
    if (mod < 1) importe = (viajes - gnc) * mod;
    else         importe = mod + peajes;
  }
  document.getElementById('tur-importe').value = importe != null ? _fmtPeso(importe) : '—';
  document.getElementById('tur-importe').dataset.val = importe ?? '';
}

function _getAmtRaw(id) {
  const el = document.getElementById(id);
  if (!el) return 0;
  const raw = el.dataset.raw;
  if (raw !== undefined && raw !== '') return parseFloat(raw) || 0;
  return parseFloat((el.value||'').replace(/\./g,'').replace(',','.')) || 0;
}

function _ensureFotoUrl(dz, hiddenId) {
  const hid = document.getElementById(hiddenId);
  if (!hid) return;
  // Si el dropzone fue borrado (clear()), limpiar el hidden también
  if (dz && !dz._existingUrl && !dz._file) { hid.value = ''; return; }
  // Si IA ya corrió, el hidden tiene la URL — no tocar
  if (hid.value) return;
  // Si el auto-upload de setFile ya completó, copiar la URL
  if (dz?._existingUrl) hid.value = dz._existingUrl;
}

async function saveTurno(e) {
  e.preventDefault();
  // Asegurar que las URLs de fotos estén en los hidden fields
  _ensureFotoUrl(_dzKmInicio, 'tur-foto-km-inicio');
  _ensureFotoUrl(_dzKmFin,    'tur-foto-km-fin');
  _ensureFotoUrl(_dzAceite,   'tur-foto-aceite');
  // Validar km solo si hay fecha fin o es edición con km_fin cargado
  const kmI  = _getKm('tur-km-inicio');
  const kmF  = _getKm('tur-km-fin');
  const _finVal = document.getElementById('tur-fin')?.value;
  if (kmI && kmF && kmF < kmI && (_finVal || _turnoEditId)) {
    const elF = document.getElementById('tur-km-fin');
    if (elF) elF.style.borderColor = 'var(--color-error)';
    showToast('Km Fin no puede ser menor que Km Inicio', 'error');
    return;
  }
  const _elRaw = id => { const el = document.getElementById(id); return parseFloat((el?.dataset?.raw||el?.value||'').replace(/\./g,'').replace(',','.')) || null; };
  const mod    = _elRaw('tur-modalidad');
  const viajes = _getAmtRaw('tur-viajes');
  const gnc    = _getAmtRaw('tur-gnc');
  const peajes = _getAmtRaw('tur-peajes');
  const importe = parseFloat(document.getElementById('tur-importe').dataset?.val) || null;
  const ini  = document.getElementById('tur-inicio').value;
  const fin  = document.getElementById('tur-fin').value;
  const horas = ini && fin ? Math.max(0,(new Date(fin)-new Date(ini))/3600000) : null;
  const aceiteNivel = document.getElementById('tur-aceite-nivel')?.value || '';
  const aceiteOk = aceiteNivel === 'normal' ? '1' : (aceiteNivel ? '0' : '');
  const fd = new FormData();
  fd.append('fecha_inicio', ini);
  fd.append('fecha_fin',    fin || '');
  fd.append('horas',        horas ?? '');
  fd.append('km_inicio',    kmI ?? '');
  fd.append('km_fin',       kmF ?? '');
  fd.append('recorrido',    (kmI && kmF && kmF>kmI ? kmF-kmI : '') );
  fd.append('vehiculo_id',  document.getElementById('tur-vehiculo').value || '');
  fd.append('chofer_id',    document.getElementById('tur-chofer').value);
  fd.append('modalidad',    mod ?? '');
  fd.append('gnc',          gnc ?? 0);
  fd.append('viajes',       viajes ?? 0);
  fd.append('peajes',       peajes ?? 0);
  fd.append('importe',      importe ?? '');
  fd.append('notas',        document.getElementById('tur-notas').value || '');
  fd.append('aceite_ok',    aceiteOk);
  fd.append('aceite_nivel', aceiteNivel);
  fd.append('foto_aceite',  document.getElementById('tur-foto-aceite')?.value || '');
  fd.append('foto_km_inicio',     document.getElementById('tur-foto-km-inicio')?.value || '');
  fd.append('foto_km_fin',        document.getElementById('tur-foto-km-fin')?.value    || '');
  fd.append('combustible_inicio', document.getElementById('tur-combustible-inicio')?.value || '');
  fd.append('combustible_fin',    document.getElementById('tur-combustible-fin')?.value    || '');
  if (_turnoEditId) fd.append('foto_novedad_url', document.getElementById('tur-novedad-preview')?.dataset?.url || '');
  if (_turnoNovedadFile) fd.append('foto_novedad', _turnoNovedadFile, _turnoNovedadFile.name);
  try {
    const url    = _turnoEditId ? `/api/turnos/${_turnoEditId}` : '/api/turnos';
    const method = _turnoEditId ? 'PUT' : 'POST';
    const res = await fetch(url, { method, body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Error al guardar');
    closeFloatViewer();
    closeModal('modal-turno');
    showToast(_turnoEditId ? 'Turno actualizado' : 'Turno registrado');
    loadTurnos();
  } catch(err) { showToast(err.message, 'error'); }
}

async function deleteTurno(id) {
  if (!await showConfirm('¿Eliminar este turno?', 'Eliminar', 'Cancelar')) return;
  try {
    await fetch(`/api/turnos/${id}`, { method:'DELETE' });
    showToast('Turno eliminado');
    loadTurnos();
  } catch(e) { showToast('Error al eliminar', 'error'); }
}

// ── CRUD Cabecera ─────────────────────────────────────────────────────────

async function loadPrestamos() {
  const q      = (document.getElementById('prestamos-search')?.value||'').trim().toLowerCase();
  const estado = document.getElementById('prestamos-filter-estado')?.value||'';
  let rows = await fetch('/api/prestamos').then(r=>r.json()).catch(()=>[]);

  if (q) rows = rows.filter(r => {
    const txt = [r.persona_nombre, r.persona_apellido, r.persona_dni,
                 r.cuenta_alias, r.vehiculo_patente, r.descripcion,
                 r.nombre_prestatario].join(' ').toLowerCase();
    return txt.includes(q);
  });
  if (estado) rows = rows.filter(r => r.estado === estado);

  const tbody = document.getElementById('prestamos-tbody');
  if (!tbody) return;

  const canDel = canDelete();
  const estadoBadge = e => ({
    activo:    '<span class="badge badge-success">Activo</span>',
    cancelado: '<span class="badge badge-secondary">Cancelado</span>',
    mora:      '<span class="badge badge-danger">En mora</span>',
    pendiente: '<span class="badge badge-warning">Pendiente</span>',
    pagado:    '<span class="badge badge-info">Pagado</span>',
  }[e] || `<span class="badge">${e||'—'}</span>`);

  // Mostrar sólo préstamos con datos de cabecera nueva (capital o cuenta) primero;
  // los viejos del módulo finanzas aparecen al final si no tienen capital
  rows.sort((a,b) => {
    const aNew = (a.capital>0||a.cuenta_id) ? 0 : 1;
    const bNew = (b.capital>0||b.cuenta_id) ? 0 : 1;
    return aNew - bNew;
  });

  const label = r => {
    if (r.persona_apellido || r.persona_nombre)
      return `<strong>${[r.persona_apellido,r.persona_nombre].filter(Boolean).join(', ')}</strong>`;
    if (r.nombre_prestatario)
      return `<span style="opacity:.7;">${r.nombre_prestatario}</span>`;
    return '<span style="opacity:.35;">—</span>';
  };

  tbody.innerHTML = rows.length
    ? rows.map(r => `
      <tr style="cursor:pointer;" onclick="loadCuotas(${r.id},'${[r.persona_apellido,r.persona_nombre].filter(Boolean).join(', ')||r.nombre_prestatario||r.cuenta_alias||'#'+r.id}')">
        <td>${label(r)}</td>
        <td>${r.banco_nombre ? `<span title="${r.cuenta_alias||''}">${r.banco_emoji||''} ${r.banco_nombre}</span>` : '—'}</td>
        <td>${r.vehiculo_patente||'—'}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums;">${r.capital>0?'$ '+_fmtMoney(r.capital):'—'}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums;">${r.total_importe>0?'$ '+_fmtMoney(r.total_importe):'—'}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums;">${(() => {
          const saldo = (parseFloat(r.total_importe)||0) - (parseFloat(r.total_pagado)||0);
          if (!r.total_importe) return '—';
          const color = saldo <= 0 ? 'var(--color-success,#34c759)' : 'inherit';
          return `<span style="color:${color};">$ ${_fmtMoney(saldo)}</span>`;
        })()}</td>
        <td style="text-align:right;">${r.tasa!=null&&r.tasa>0?r.tasa+'%':'—'}</td>
        <td style="white-space:nowrap;">${r.tipo_amortizacion||'—'}</td>
        <td style="text-align:center;">${r.plazo_meses?r.plazo_meses+' m':'—'}</td>
        <td style="text-align:center;">${r.total_cuotas||0}</td>
        <td>${estadoBadge(r.estado)}</td>
        <td onclick="event.stopPropagation()" style="white-space:nowrap;text-align:center;">
          <button class="tbl-action-btn tbl-btn-view"   onclick="openPrestamoModal(${r.id},true)" title="Ver"><i class="fa-solid fa-eye"></i></button>
          <button class="tbl-action-btn tbl-btn-edit"   onclick="openPrestamoModal(${r.id})" title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
          ${canDel?`<button class="tbl-action-btn tbl-btn-delete" onclick="deletePrestamo(${r.id})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>`:''}
        </td>
      </tr>`).join('')
    : `<tr><td colspan="12" style="text-align:center;opacity:.5;padding:32px;">Sin préstamos</td></tr>`;

  // Fila de totales encima de los títulos, alineada con sus columnas
  const totRow = document.getElementById('prestamos-totals-row');
  if (totRow && rows.length) {
    const sumCapital = rows.reduce((s, r) => s + (parseFloat(r.capital)       || 0), 0);
    const sumCuotas  = rows.reduce((s, r) => s + (parseFloat(r.total_importe) || 0), 0);
    const sumSaldo   = rows.reduce((s, r) => s + ((parseFloat(r.total_importe)||0) - (parseFloat(r.total_pagado)||0)), 0);
    document.getElementById('pr-tot-count').textContent   = `${rows.length} préstamo${rows.length!==1?'s':''}`;
    document.getElementById('pr-tot-capital').textContent = `$ ${_fmtMoney(sumCapital)}`;
    document.getElementById('pr-tot-cuotas').textContent  = `$ ${_fmtMoney(sumCuotas)}`;
    const saldoEl = document.getElementById('pr-tot-saldo');
    saldoEl.textContent = `$ ${_fmtMoney(sumSaldo)}`;
    saldoEl.style.color = sumSaldo <= 0 ? 'var(--color-success,#34c759)' : 'var(--accent-color)';
    totRow.style.display = '';
  } else if (totRow) {
    totRow.style.display = 'none';
  }

  injectExportBar('prestamos-table', 'Préstamos');
}

async function openPrestamoModal(id=null, readonly=false) {
  _prestamoEditId = id;
  document.getElementById('prestamo-modal-title').innerHTML = id
    ? (readonly ? '<i class="fa-solid fa-file-invoice-dollar"></i> Ver Préstamo' : '<i class="fa-solid fa-file-invoice-dollar"></i> Editar Préstamo')
    : '<i class="fa-solid fa-file-invoice-dollar"></i> Nuevo Préstamo';

  await _loadPrCaches();
  _fillPrCuentaSelect('pr-cuenta-id', null);
  _fillPrVehiculoSelect('pr-vehiculo-id', null);

  ['pr-capital','pr-tasa','pr-plazo','pr-fecha-inicio','pr-descripcion'].forEach(id=>{
    const el=document.getElementById(id); if(el) { el.value=''; el.dataset.raw=''; }
  });
  // Limpiar sección de cuotas inline
  _cuotasParsed = [];
  const pasteArea = document.getElementById('cuotas-paste-area');
  if (pasteArea) pasteArea.value = '';
  const pastePreview = document.getElementById('cuotas-paste-preview');
  if (pastePreview) pastePreview.style.display = 'none';
  document.getElementById('pr-tipo').value    = '';
  document.getElementById('pr-estado').value  = 'activo';
  document.getElementById('pr-persona-info').textContent          = '';
  document.getElementById('pr-vehiculo-persona-info').textContent = '';

  if (id) {
    const p = await fetch(`/api/prestamos/${id}`).then(r=>r.json()).catch(()=>null);
    if (p) {
      _fillPrCuentaSelect('pr-cuenta-id', p.cuenta_id);
      _fillPrVehiculoSelect('pr-vehiculo-id', p.vehiculo_id);
      setAmt('pr-capital', p.capital);
      document.getElementById('pr-tasa').value         = p.tasa||'';
      document.getElementById('pr-tipo').value         = p.tipo_amortizacion||'';
      document.getElementById('pr-plazo').value        = p.plazo_meses||'';
      document.getElementById('pr-fecha-inicio').value = (p.fecha_inicio||'').slice(0,10);
      document.getElementById('pr-estado').value       = p.estado||'activo';
      document.getElementById('pr-descripcion').value  = p.descripcion||'';
      _onPrCuentaChange(document.getElementById('pr-cuenta-id'));
      _onPrVehiculoChange(document.getElementById('pr-vehiculo-id'));
      // Subtítulo con propietario de la cuenta o vehículo
      const sub = [p.cp_apellido, p.cp_nombre].filter(Boolean).join(', ')
               || [p.vp_apellido, p.vp_nombre].filter(Boolean).join(', ')
               || p.nombre_prestatario || '';
      _setModalTitle('prestamo-modal-title', '<i class="fa-solid fa-file-invoice-dollar"></i>', 'Editar Préstamo', sub);
    }
  }
  // Modo vista vs edición
  const pasteSection = document.getElementById('pr-cuotas-paste-section');
  const viewSection  = document.getElementById('pr-cuotas-view');
  const btnEditar    = document.getElementById('btn-pr-editar');
  const btnGuardar   = document.getElementById('btn-pr-guardar');
  const modalCard    = document.querySelector('#modal-prestamo .modal-card');

  document.querySelectorAll('#modal-prestamo input, #modal-prestamo select, #modal-prestamo textarea')
    .forEach(el => { el.disabled = readonly; });

  if (pasteSection) pasteSection.style.display = readonly ? 'none' : '';
  if (viewSection)  viewSection.style.display  = readonly ? '' : 'none';
  if (btnEditar)    btnEditar.style.display     = (readonly && canEdit()) ? '' : 'none';
  if (btnGuardar)   btnGuardar.style.display    = readonly ? 'none' : '';
  if (modalCard)    modalCard.style.maxWidth     = readonly ? '640px' : '720px';

  if (readonly && id) {
    const cuotas = await fetch(`/api/prestamos/${id}/cuotas`).then(r=>r.json()).catch(()=>[]);
    const tbody  = document.getElementById('pr-cuotas-view-tbody');
    if (tbody) {
      tbody.innerHTML = cuotas.length
        ? cuotas.map(c => `<tr style="${c.pagada?'opacity:.5;text-decoration:line-through;':''}">
            <td style="text-align:center;">${c.nro_cuota}</td>
            <td>${_fmtDateLocal(c.fecha)}</td>
            <td style="text-align:right;font-variant-numeric:tabular-nums;">$&nbsp;${_fmtMoney(c.importe)}</td>
            <td style="text-align:center;">${c.pagada?'<i class="fa-solid fa-check" style="color:var(--color-success)"></i>':'<span style="opacity:.3">—</span>'}</td>
          </tr>`).join('')
        : '<tr><td colspan="4" style="text-align:center;opacity:.4;padding:16px;">Sin cuotas cargadas</td></tr>';
    }
  }

  openModal('modal-prestamo');
}

function openCascadaVencimientos() {
  const capital  = getAmt('pr-capital');
  const tasa     = parseFloat(document.getElementById('pr-tasa').value);
  const plazo    = parseInt(document.getElementById('pr-plazo').value);
  const tipo     = document.getElementById('pr-tipo').value;
  const fechaStr = document.getElementById('pr-fecha-inicio').value;

  if (!capital || capital <= 0) return showAlert('Ingresá el capital primero');
  if (!plazo   || plazo <= 0)   return showAlert('Ingresá el plazo en meses');
  if (!fechaStr)                return showAlert('Ingresá la fecha de inicio');

  const cuotas = _generarCascada(capital, tasa || 0, plazo, tipo, fechaStr);
  _cuotasParsed = cuotas;

  // Mostrar preview inline dentro del mismo modal (sin pre-llenar el textarea)
  const count = document.getElementById('cuotas-paste-count');
  const tbody = document.getElementById('cuotas-paste-tbody');
  count.textContent = `${cuotas.length} cuota${cuotas.length !== 1 ? 's' : ''} generada${cuotas.length !== 1 ? 's' : ''}`;
  tbody.innerHTML = cuotas.map(c => `
    <tr>
      <td style="text-align:center;">${c.nro_cuota}</td>
      <td>${_fmtDateLocal(c.fecha)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">$&nbsp;${_fmtMoney(c.importe)}</td>
    </tr>`).join('');
  document.getElementById('cuotas-paste-preview').style.display = 'block';
}

function _generarCascada(capital, tasaAnual, plazo, tipo, fechaInicioISO) {
  const cuotas = [];
  const tm = tasaAnual / 100 / 12; // tasa mensual
  let [y, m, d] = fechaInicioISO.split('-').map(Number);

  function addMonths(year, month, day, n) {
    let nm = month + n;
    let ny = year + Math.floor((nm - 1) / 12);
    nm = ((nm - 1) % 12) + 1;
    // Ajustar día si el mes destino tiene menos días
    const maxD = new Date(ny, nm, 0).getDate();
    return `${ny}-${String(nm).padStart(2,'0')}-${String(Math.min(day, maxD)).padStart(2,'0')}`;
  }

  if (tipo === 'frances' && tm > 0) {
    // Cuota fija: C = P * tm / (1 - (1+tm)^-n)
    const cuotaFija = capital * tm / (1 - Math.pow(1 + tm, -plazo));
    for (let i = 1; i <= plazo; i++) {
      cuotas.push({ nro_cuota: i, fecha: addMonths(y, m, d, i), importe: Math.round(cuotaFija * 100) / 100 });
    }

  } else if (tipo === 'aleman' && tm > 0) {
    // Amortización fija, intereses decrecientes
    const amort = capital / plazo;
    let saldo = capital;
    for (let i = 1; i <= plazo; i++) {
      const interes = saldo * tm;
      cuotas.push({ nro_cuota: i, fecha: addMonths(y, m, d, i), importe: Math.round((amort + interes) * 100) / 100 });
      saldo -= amort;
    }

  } else if (tipo === 'americano' || tipo === 'bullet') {
    // Solo intereses hasta el último mes, capital en la última cuota
    for (let i = 1; i <= plazo; i++) {
      const interes = capital * tm;
      const importe = i === plazo ? capital + interes : interes;
      cuotas.push({ nro_cuota: i, fecha: addMonths(y, m, d, i), importe: Math.round(importe * 100) / 100 });
    }

  } else {
    // Sin tasa o tipo desconocido: dividir capital equitativamente
    const cuotaFija = capital / plazo;
    for (let i = 1; i <= plazo; i++) {
      cuotas.push({ nro_cuota: i, fecha: addMonths(y, m, d, i), importe: Math.round(cuotaFija * 100) / 100 });
    }
  }

  return cuotas;
}

async function savePrestamo() {
  const capital = getAmt('pr-capital');
  if (!capital || capital <= 0) return showAlert('El capital es requerido');

  const cuentaId   = document.getElementById('pr-cuenta-id').value  || null;
  const vehiculoId = document.getElementById('pr-vehiculo-id').value || null;

  // Derivar nombre_prestatario desde cache de cuentas o vehículos
  let nombre_prestatario = '';
  if (cuentaId) {
    const c = _prCuentasCache.find(x => x.id == cuentaId);
    if (c) nombre_prestatario = c.persona_apellido
      ? `${c.persona_apellido}, ${c.persona_nombre}`
      : [c.apellido, c.nombre].filter(Boolean).join(', ');
  }
  if (!nombre_prestatario && vehiculoId) {
    const v = _prVehiculosCache.find(x => x.id == vehiculoId);
    if (v) nombre_prestatario = v.persona_apellido
      ? `${v.persona_apellido}, ${v.persona_nombre}`
      : (v.titular_nombre || '');
  }
  if (!nombre_prestatario) return showAlert('Seleccioná una cuenta o vehículo para identificar al prestatario');

  const body = {
    cuenta_id:        cuentaId,
    vehiculo_id:      vehiculoId,
    nombre_prestatario,
    capital,
    tasa:             parseFloat(document.getElementById('pr-tasa').value)||null,
    tipo_amortizacion:document.getElementById('pr-tipo').value         || null,
    plazo_meses:      parseInt(document.getElementById('pr-plazo').value)||null,
    fecha_inicio:     document.getElementById('pr-fecha-inicio').value || null,
    estado:           document.getElementById('pr-estado').value       || 'activo',
    descripcion:      document.getElementById('pr-descripcion').value  || null,
  };
  const url    = _prestamoEditId ? `/api/prestamos/${_prestamoEditId}` : '/api/prestamos';
  const method = _prestamoEditId ? 'PUT' : 'POST';
  const res    = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const data   = await res.json();
  if (!res.ok) return showAlert(data.message||'Error al guardar');
  const prestamoId = data.id || _prestamoEditId;
  if (data.id) { _prestamoEditId = data.id; _cuotasPrestamoId = data.id; }

  // Guardar cuotas inline si hay pegadas o generadas por cascada
  if (_cuotasParsed.length && prestamoId) {
    await fetch(`/api/prestamos/${prestamoId}/cuotas/bulk`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ cuotas: _cuotasParsed })
    });
    _cuotasParsed = [];
  }

  closeModal('modal-prestamo');
  loadPrestamos();
}

async function deletePrestamo(id) {
  if (!await showConfirm('¿Eliminar este préstamo y todas sus cuotas?')) return;
  const res = await fetch(`/api/prestamos/${id}`, { method:'DELETE' });
  if (!res.ok) { const d=await res.json(); return showAlert(d.message||'Error'); }
  if (_cuotasPrestamoId===id) closeCuotasPanel();
  loadPrestamos();
}

// ── Cuotas ───────────────────────────────────────────────────────────────

async function loadCuotas(prestamoId, label) {
  _cuotasPrestamoId = prestamoId;
  const panel = document.getElementById('prestamos-cuotas-panel');
  const title = document.getElementById('prestamos-cuotas-title');
  if (!panel) return;
  title.textContent = `Cuotas — ${label}`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior:'smooth', block:'nearest' });

  const cuotas = await fetch(`/api/prestamos/${prestamoId}/cuotas`).then(r=>r.json()).catch(()=>[]);
  const tbody  = document.getElementById('prestamos-cuotas-tbody');
  const canDel = canDelete();

  tbody.innerHTML = cuotas.length
    ? cuotas.map(c => `
      <tr style="${c.pagada?'opacity:.55;text-decoration:line-through;':''}">
        <td style="text-align:center;">${c.nro_cuota}</td>
        <td>${_fmtDateLocal(c.fecha)}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums;">$&nbsp;${_fmtMoney(c.importe)}</td>
        <td style="text-align:center;">
          ${c.pagada
            ? `<span class="badge badge-success">Pagada</span>`
            : `<button class="btn btn-sm" onclick="pagarCuota(${c.id})" title="Marcar como pagada"><i class="fa-solid fa-check"></i></button>`}
        </td>
        <td style="text-align:center;">
          ${canDel?`<button class="btn btn-sm btn-danger" onclick="deleteCuota(${c.id})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>`:''}
        </td>
      </tr>`).join('')
    : `<tr><td colspan="5" style="text-align:center;opacity:.5;padding:20px;">Sin cuotas — usá "Pegar cuotas" para cargarlas</td></tr>`;
}

function closeCuotasPanel() {
  _cuotasPrestamoId = null;
  document.getElementById('prestamos-cuotas-panel').style.display = 'none';
}

async function pagarCuota(cuotaId) {
  const res = await fetch(`/api/prestamos/cuotas/${cuotaId}/pagar`, { method:'PUT' });
  if (!res.ok) { const d=await res.json(); return showAlert(d.message||'Error'); }
  loadCuotas(_cuotasPrestamoId, document.getElementById('prestamos-cuotas-title').textContent.replace('Cuotas — ',''));
}

async function deleteCuota(cuotaId) {
  if (!await showConfirm('¿Eliminar esta cuota?')) return;
  const res = await fetch(`/api/prestamos/cuotas/${cuotaId}`, { method:'DELETE' });
  if (!res.ok) { const d=await res.json(); return showAlert(d.message||'Error'); }
  loadCuotas(_cuotasPrestamoId, document.getElementById('prestamos-cuotas-title').textContent.replace('Cuotas — ',''));
}

// ── Paste cuotas ─────────────────────────────────────────────────────────

// Parser genérico reutilizable
function _parseCuotasRaw(raw) {
  const lines = raw.split('\n').map(l=>l.trim()).filter(Boolean);
  const rows  = [];
  for (const line of lines) {
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const fecha    = _parseDate(cols[0].trim());
    const nroCuota = parseInt(cols[1]);
    const importe  = _parseMoney(cols[2]);
    if (!fecha || isNaN(nroCuota) || importe === null) continue;
    rows.push({ fecha, nro_cuota: nroCuota, importe });
  }
  return rows;
}

// Inline: usado en modal-prestamo
function parseCuotasPaste() {
  const rows = _parseCuotasRaw(document.getElementById('cuotas-paste-area').value);
  _cuotasParsed = rows;
  const preview = document.getElementById('cuotas-paste-preview');
  const count   = document.getElementById('cuotas-paste-count');
  const tbody   = document.getElementById('cuotas-paste-tbody');
  if (!rows.length) { preview.style.display = 'none'; return; }
  count.textContent = `${rows.length} cuota${rows.length!==1?'s':''} detectada${rows.length!==1?'s':''}`;
  tbody.innerHTML   = rows.map(r => `
    <tr>
      <td style="text-align:center;">${r.nro_cuota}</td>
      <td>${_fmtDateLocal(r.fecha)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">$&nbsp;${_fmtMoney(r.importe)}</td>
    </tr>`).join('');
  preview.style.display = 'block';
}

// Edit modal: usado en modal-cuotas-paste (edición de préstamo existente)
let _cuotasParsedEdit = [];
function parseCuotasPasteEdit() {
  const rows = _parseCuotasRaw(document.getElementById('cuotas-paste-area-edit').value);
  _cuotasParsedEdit = rows;
  const preview = document.getElementById('cuotas-paste-preview-edit');
  const count   = document.getElementById('cuotas-paste-count-edit');
  const tbody   = document.getElementById('cuotas-paste-tbody-edit');
  const btn     = document.getElementById('cuotas-paste-save-btn');
  if (!rows.length) { preview.style.display = 'none'; btn.disabled = true; return; }
  count.textContent = `${rows.length} cuota${rows.length!==1?'s':''} detectada${rows.length!==1?'s':''}`;
  tbody.innerHTML   = rows.map(r => `
    <tr>
      <td style="text-align:center;">${r.nro_cuota}</td>
      <td>${_fmtDateLocal(r.fecha)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">$&nbsp;${_fmtMoney(r.importe)}</td>
    </tr>`).join('');
  preview.style.display = 'block';
  btn.disabled = false;
}

function openCuotasPaste() {
  if (!_cuotasPrestamoId) return showAlert('Primero seleccioná un préstamo');
  document.getElementById('cuotas-paste-area-edit').value = '';
  document.getElementById('cuotas-paste-preview-edit').style.display = 'none';
  document.getElementById('cuotas-paste-save-btn').disabled = true;
  _cuotasParsedEdit = [];
  openModal('modal-cuotas-paste');
}

async function saveCuotasPaste() {
  if (!_cuotasParsedEdit.length || !_cuotasPrestamoId) return;
  if (!await showConfirm(`¿Reemplazar las cuotas actuales con las ${_cuotasParsedEdit.length} cuotas pegadas?`)) return;
  const res = await fetch(`/api/prestamos/${_cuotasPrestamoId}/cuotas/bulk`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ cuotas: _cuotasParsedEdit })
  });
  const data = await res.json();
  if (!res.ok) return showAlert(data.message||'Error al guardar');
  closeModal('modal-cuotas-paste');
  const label = document.getElementById('prestamos-cuotas-title').textContent.replace('Cuotas — ','');
  loadCuotas(_cuotasPrestamoId, label);
  showAlert(`✓ ${data.count} cuotas guardadas correctamente`);
}

// ── Préstamos: toggle search ────────────────────────────────────────────────
function togglePrestamosSearch() {
  const btn   = document.getElementById('prestamos-search-btn');
  const input = document.getElementById('prestamos-search');
  const opening = !btn.classList.contains('active');
  if (opening) {
    input.style.display = '';
    requestAnimationFrame(() => input.classList.add('open'));
    btn.classList.add('active');
    setTimeout(() => input.focus(), 50);
  } else {
    input.classList.remove('open');
    btn.classList.remove('active');
    input.value = '';
    loadPrestamos();
    setTimeout(() => { input.style.display = 'none'; }, 260);
  }
}

// ── Préstamos: Gráficos ──────────────────────────────────────────────────────
let _prChartInstance     = null;
let _prChartLineas       = null;
let _prChartPiePersona   = null;
let _prChartPieCuenta    = null;
let _prChartData         = null;

// Paleta de colores para tortas
const _PR_PALETTE = ['#7f56d9','#ff9500','#34c759','#4f6ef7','#ef4444','#06b6d4','#f59e0b','#10b981','#8b5cf6','#ec4899'];

async function openPrestamosCharts() {
  openModal('modal-prestamos-charts');
  await renderPrestamosCharts();
}

async function renderPrestamosCharts(keepData = false) {
  const desde     = document.getElementById('pr-chart-desde')?.value   || '';
  const hasta     = document.getElementById('pr-chart-hasta')?.value   || '';
  const personaId = document.getElementById('pr-chart-persona')?.value || '';
  const agrup     = document.getElementById('pr-chart-agrup')?.value   || 'mes';

  if (!keepData || !_prChartData) {
    const params = new URLSearchParams();
    if (desde)     params.set('desde', desde);
    if (hasta)     params.set('hasta', hasta);
    if (personaId) params.set('persona_id', personaId);
    try {
      const res    = await fetch('/api/prestamos/cuotas/por-mes?' + params.toString());
      _prChartData = await res.json();
    } catch (_) { return; }

    // Poblar select personas (primera vez)
    const pSel = document.getElementById('pr-chart-persona');
    if (pSel && _prChartData.personas && pSel.options.length <= 1) {
      _prChartData.personas.forEach(p => {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = `${p.apellido||''}, ${p.nombre||''}`.trim().replace(/^,\s*/, '');
        pSel.appendChild(o);
      });
    }
  }

  const rawRows = _prChartData?.rows || [];
  const fmt   = n => '$ ' + n.toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmtK  = n => '$ ' + (n>=1000000 ? (n/1000000).toFixed(1)+'M' : n>=1000 ? (n/1000).toFixed(0)+'K' : n.toFixed(0));

  // Agrupar client-side según agrupación seleccionada
  const _prGroupKey = mes => {
    if (agrup === 'trimestre') { const [y,m] = mes.split('-'); return `${y}-Q${Math.ceil(parseInt(m)/3)}`; }
    if (agrup === 'año')       { return mes.substring(0,4); }
    return mes;
  };
  const agrupMap = new Map();
  rawRows.forEach(r => {
    const k = _prGroupKey(r.mes);
    if (!agrupMap.has(k)) agrupMap.set(k, { total:0, pagado:0, pendiente:0 });
    const g = agrupMap.get(k);
    g.total     += parseFloat(r.total)||0;
    g.pagado    += parseFloat(r.pagado)||0;
    g.pendiente += parseFloat(r.pendiente)||0;
  });
  const rows   = [...agrupMap.entries()].map(([k,v]) => ({ mes:k, ...v }));
  const labels = rows.map(r => r.mes);
  const totals = rows.map(r => r.total);
  const pagados= rows.map(r => r.pagado);
  const pends  = rows.map(r => r.pendiente);

  // Chips resumen — fondo sólido para legibilidad
  const sumEl = document.getElementById('pr-chart-summary');
  if (sumEl) {
    const tot = totals.reduce((a,b)=>a+b,0);
    const pag = pagados.reduce((a,b)=>a+b,0);
    const pen = pends.reduce((a,b)=>a+b,0);
    sumEl.innerHTML = [
      ['Total', fmt(tot), '#e07b00'],
      ['Pagado', fmt(pag), '#16a34a'],
      ['Pendiente', fmt(pen), '#7f56d9'],
    ].map(([l,v,c]) => `<span style="font-size:12px;font-weight:700;padding:4px 12px;border-radius:14px;background:${c};color:#fff;">${l}: ${v}</span>`).join('');
  }

  const showX   = document.getElementById('pr-chart-show-x')?.checked ?? true;
  const showY   = document.getElementById('pr-chart-show-y')?.checked ?? true;
  const showLbl = document.getElementById('pr-chart-show-labels')?.checked ?? false;
  const cTotal  = document.getElementById('pr-chart-color-total')?.value      || '#ff9500';
  const cPend   = document.getElementById('pr-chart-color-pendiente')?.value  || '#7f56d9';
  const cPag    = document.getElementById('pr-chart-color-pagado')?.value     || '#34c759';
  const cX      = document.getElementById('pr-chart-color-x')?.value  || '#555';
  const cY      = document.getElementById('pr-chart-color-y')?.value  || '#555';

  // Registrar plugin datalabels globalmente si no está registrado
  if (window.ChartDataLabels && !Chart._prDatalabelsRegistered) {
    Chart.register(ChartDataLabels);
    Chart._prDatalabelsRegistered = true;
  }

  // ── Gráfico barras mes a mes ──────────────────────────────────────────────
  const canvas = document.getElementById('chart-prestamos-mensual');
  if (canvas && window.Chart) {
    if (_prChartInstance) { _prChartInstance.destroy(); _prChartInstance = null; }
    _prChartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label:'Total',     data:totals,  backgroundColor:cTotal, borderColor:'transparent', borderWidth:0, borderRadius:8, borderSkipped:false },
          { label:'Pagado',    data:pagados, backgroundColor:cPag,   borderColor:'transparent', borderWidth:0, borderRadius:8, borderSkipped:false },
          { label:'Pendiente', data:pends,   backgroundColor:cPend,  borderColor:'transparent', borderWidth:0, borderRadius:8, borderSkipped:false },
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        animation: { duration: 900, easing: 'easeInOutQuart' },
        plugins: {
          legend: { position:'bottom', labels: { font:{size:11,weight:'600'}, usePointStyle:true } },
          datalabels: {
            display: showLbl,
            anchor: 'end', align: 'top', clip:false, clamp:true,
            font: { size:9, weight:'700' },
            color: ctx => [cTotal, cPag, cPend][ctx.datasetIndex],
            formatter: v => v > 0 ? fmtK(v) : ''
          },
          tooltip: _chartTooltip()
        },
        scales: {
          x: { grid:{ display:false }, ticks: { display:showX, color:cX, font:{size:11} } },
          y: { grid: _chartGrid(), ticks: { display:showY, color:cY, font:{size:11}, callback: v => fmtK(v) } }
        }
      },
      plugins: _makeChartPlugins(false, null)
    });
  }

  // ── Tortas ────────────────────────────────────────────────────────────────
  // Datos por persona desde el API (personas con su pendiente acumulado)
  const personas = _prChartData?.personas || [];

  // Para las tortas necesitamos los préstamos actuales — los pedimos
  let prestamos = [];
  try { prestamos = await fetch('/api/prestamos').then(r=>r.json()); } catch(_){}

  // Distribución por persona (pendiente total)
  const porPersona = {};
  prestamos.forEach(p => {
    if (p.estado === 'pagado' || p.estado === 'cancelado') return;
    const nombre = [p.persona_apellido, p.persona_nombre].filter(Boolean).join(', ')
      || p.nombre_prestatario || p.cuenta_alias || `Préstamo #${p.id}`;
    const monto  = parseFloat(p.saldo_pendiente || p.capital || 0);
    porPersona[nombre] = (porPersona[nombre] || 0) + monto;
  });

  // Distribución por banco/cuenta
  const porBanco = {};
  prestamos.forEach(p => {
    if (p.estado === 'pagado' || p.estado === 'cancelado') return;
    const banco = p.banco_nombre || p.cuenta_alias || 'Sin banco';
    const monto = parseFloat(p.saldo_pendiente || p.capital || 0);
    porBanco[banco] = (porBanco[banco] || 0) + monto;
  });

  const _makePie = (canvasId, dataObj, existingChart) => {
    const cvs = document.getElementById(canvasId);
    if (!cvs) return existingChart;
    if (existingChart) { existingChart.destroy(); }
    const keys = Object.keys(dataObj).sort((a,b) => dataObj[b]-dataObj[a]);
    if (!keys.length) return existingChart;
    return new Chart(cvs, {
      type: 'doughnut',
      data: {
        labels: keys,
        datasets: [{ data: keys.map(k=>dataObj[k]),
          backgroundColor: keys.map((_,i) => _CHART_PALETTE[i % _CHART_PALETTE.length].top),
          borderColor:     keys.map((_,i) => _CHART_PALETTE[i % _CHART_PALETTE.length].bot),
          borderWidth: 2, hoverOffset: 20 }]
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        animation: { duration: 900, easing: 'easeInOutQuart' },
        plugins: {
          legend: { position:'right', labels:{ font:{size:10,weight:'600'}, boxWidth:12, usePointStyle:true } },
          datalabels: {
            display: ctx => (ctx.dataset.data[ctx.dataIndex] / ctx.dataset.data.reduce((a,b)=>a+b,0)) > 0.04,
            color:'#fff', font:{size:9,weight:'700'},
            formatter: v => fmtK(v)
          },
          tooltip: _chartTooltip()
        }
      }
    });
  };

  _prChartPiePersona = _makePie('chart-prestamos-pie-persona', porPersona, _prChartPiePersona);
  _prChartPieCuenta  = _makePie('chart-prestamos-pie-cuenta',  porBanco,   _prChartPieCuenta);

  // ── Gráfico de líneas ──
  const linCvs = document.getElementById('chart-prestamos-lineas');
  if (_prChartLineas) { _prChartLineas.destroy(); _prChartLineas = null; }
  if (linCvs && labels.length) {
    _prChartLineas = new Chart(linCvs, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label:'Total',     data:totals,  borderColor:cTotal, backgroundColor:cTotal+'22',
            borderWidth:2.5, pointRadius:4, pointHoverRadius:7, tension:0.35, fill:false },
          { label:'Pendiente', data:pends,   borderColor:cPend,  backgroundColor:cPend+'22',
            borderWidth:2.5, pointRadius:4, pointHoverRadius:7, tension:0.35, fill:false },
          { label:'Pagado',    data:pagados, borderColor:cPag,   backgroundColor:cPag+'22',
            borderWidth:2,   pointRadius:3, pointHoverRadius:6, tension:0.35, fill:false },
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        animation:{ duration:900, easing:'easeInOutQuart' },
        interaction:{ mode:'index', intersect:false },
        plugins: {
          legend:{ position:'bottom', labels:{ font:{size:11,weight:'600'}, usePointStyle:true, boxWidth:10 } },
          datalabels:{ display:false },
          tooltip:{ ..._chartTooltip(), callbacks:{ label: ctx=>`  ${ctx.dataset.label}: ${fmtK(ctx.parsed.y)}` } }
        },
        scales: {
          x:{ grid:{ display:false }, ticks:{ color:cX, font:{size:10}, display:showX } },
          y:{ grid:_chartGrid(), ticks:{ color:cY, font:{size:10}, callback:v=>fmtK(v), display:showY } }
        }
      }
    });
  }
}

function exportPrestamosChartXLS() {
  const table = document.createElement('table');
  const rows  = _prChartData?.rows || [];
  table.innerHTML = '<thead><tr><th>Mes</th><th>Total</th><th>Pagado</th><th>Pendiente</th><th>Cuotas</th></tr></thead>'
    + '<tbody>' + rows.map(r =>
      `<tr><td>${r.mes}</td><td>${r.total}</td><td>${r.pagado}</td><td>${r.pendiente}</td><td>${r.cant_cuotas}</td></tr>`
    ).join('') + '</tbody>';
  if (!window.XLSX) return;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.table_to_sheet(table), 'Cuotas');
  XLSX.writeFile(wb, 'Prestamos_Graficos.xlsx');
}

function exportPrestamosChartWA() {
  const rows = _prChartData?.rows || [];
  if (!rows.length) return showAlert('Sin datos para compartir');
  let txt = '*Gráficos — Préstamos*\n';
  rows.forEach(r => {
    txt += `\n📅 *${r.mes}*  Total: $ ${parseFloat(r.total).toLocaleString('es-AR',{minimumFractionDigits:2})}  Pend: $ ${parseFloat(r.pendiente).toLocaleString('es-AR',{minimumFractionDigits:2})}`;
  });
  openWhatsAppModal(null, 'Gráficos Préstamos', txt);
}

// ── CashFlow ─────────────────────────────────────────────────────────────────
function openCashFlow() {
  const now  = new Date();
  const pad  = n => String(n).padStart(2,'0');
  const y    = now.getFullYear();
  const m    = now.getMonth() + 1;
  const last = new Date(y, m, 0).getDate(); // último día del mes actual
  document.getElementById('cf-desde').value = `${y}-${pad(m)}-${pad(now.getDate())}`;
  document.getElementById('cf-hasta').value = `${y}-${pad(m)}-${pad(last)}`;
  openModal('modal-cashflow');
  loadCashFlow();
}

async function loadCashFlow() {
  const desde = document.getElementById('cf-desde')?.value || '';
  const hasta = document.getElementById('cf-hasta')?.value || '';

  const empty = document.getElementById('cf-empty');
  const thead = document.getElementById('cf-thead');
  const tbody = document.getElementById('cf-tbody');

  if (!desde || !hasta) {
    if (empty) empty.style.display = '';
    if (thead) thead.innerHTML = '';
    if (tbody) tbody.innerHTML = '';
    return;
  }

  let data = null;
  try {
    const res = await fetch(`/api/prestamos/cashflow?desde=${desde}&hasta=${hasta}`);
    data = await res.json();
  } catch(_) { return; }

  const { fechas = [], bancos = [], pivot = {}, totales = {} } = data;

  if (!bancos.length) {
    if (empty) empty.style.display = '';
    if (thead) thead.innerHTML = '';
    if (tbody) tbody.innerHTML = '';
    document.getElementById('cf-summary').innerHTML = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  const fmt  = n => n ? '$ ' + parseFloat(n).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2}) : '';
  const fmtT = n => '$ ' + parseFloat(n||0).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const hoy  = new Date().toISOString().slice(0,10);

  // Encabezado: Banco | [fecha1] | [fecha2] | ... | Total período | Resto
  const fmtFecha = iso => { const [y,m,d] = iso.split('-'); return `${d}-${m}-${y}`; };
  thead.innerHTML = `<tr>
    <th>Banco / Cuenta</th>
    ${fechas.map(f => `<th style="text-align:right;font-size:11px;${f < hoy ? 'color:#ef4444;' : ''}">${fmtFecha(f)}</th>`).join('')}
    <th style="text-align:right;">Total período</th>
    <th style="text-align:right;opacity:.6;" title="Vencimientos fuera del período">Resto</th>
  </tr>`;

  tbody.innerHTML = bancos.map((b, i) => {
    const bData  = pivot[b] || {};
    const rowTot = fechas.reduce((s, f) => s + (bData[f] || 0), 0);
    const resto  = bData.__resto || 0;
    const celdas = fechas.map(f => {
      const v = bData[f] || 0;
      return `<td style="text-align:right;font-variant-numeric:tabular-nums;${f < hoy && v > 0 ? 'color:#ef4444;font-weight:700;' : ''}">${fmt(v)}</td>`;
    });
    return `<tr class="${i%2===1?'row-alt':''}">
      <td style="font-weight:600;">${b}</td>
      ${celdas.join('')}
      <td style="text-align:right;font-weight:700;font-variant-numeric:tabular-nums;">${fmtT(rowTot)}</td>
      <td style="text-align:right;opacity:.6;font-variant-numeric:tabular-nums;">${fmt(resto)}</td>
    </tr>`;
  }).join('');

  // Fila totales
  const granTotal = fechas.reduce((s, f) => s + (totales[f] || 0), 0);
  tbody.innerHTML += `<tr style="font-weight:800;border-top:2px solid var(--border-color);background:var(--bg-secondary);">
    <td>TOTAL</td>
    ${fechas.map(f => `<td style="text-align:right;font-variant-numeric:tabular-nums;">${fmtT(totales[f])}</td>`).join('')}
    <td style="text-align:right;font-variant-numeric:tabular-nums;">${fmtT(granTotal)}</td>
    <td style="text-align:right;opacity:.6;font-variant-numeric:tabular-nums;">${fmtT(totales.__resto)}</td>
  </tr>`;

  document.getElementById('cf-summary').innerHTML = [
    ['Vencimientos en período', fmtT(granTotal), '#ef4444'],
    ['Resto pendiente', fmtT(totales.__resto || 0), '#e07b00'],
    ['Bancos/Cuentas', bancos.length + ' activos', '#4f6ef7'],
  ].map(([l,v,c])=>`<span style="font-size:12px;font-weight:700;padding:4px 12px;border-radius:14px;background:${c};color:#fff;">${l}: ${v}</span>`).join('');
}

function exportCashFlowXLS() {
  const table = document.getElementById('cf-table');
  if (!table || !window.XLSX) return;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.table_to_sheet(table), 'CashFlow');
  XLSX.writeFile(wb, 'CashFlow_Prestamos.xlsx');
}

function exportCashFlowWA() {
  const rows = document.querySelectorAll('#cf-tbody tr:not(:last-child)');
  if (!rows.length) return showAlert('Sin datos para compartir');
  let txt = '*💧 Cash Flow — Vencimientos de Cuotas*\n';
  rows.forEach(r => {
    const cells = r.querySelectorAll('td');
    if (cells.length >= 4)
      txt += `\n📅 *${cells[0].textContent}*  Pend: ${cells[3].textContent.trim()}`;
  });
  openWhatsAppModal(null, 'CashFlow Préstamos', txt);
}

let _peajesParsed = []; // filas parseadas del pegado antes de confirmar

// ══ ARCA / AFIP ══════════════════════════════════════════════════════════════

let _arcaTab = 'emitidos';
let _arcaContribs = [];
let _allContribs = [];

async function _loadArcaContribs() {
  try {
    const r = await fetch('/api/afip/contribuyentes');
    _arcaContribs = (await r.json()).filter(c => c.activo);
    const sel = document.getElementById('arca-contrib-sel');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">Todos los contribuyentes</option>' +
      _arcaContribs.map(c => `<option value="${c.id}" data-cuit="${c.cuit}">${c.nombre}</option>`).join('');
    if (prev) sel.value = prev;
  } catch {}
}

function switchArcaTab(tab) {
  _arcaTab = tab;
  document.querySelectorAll('.arca-tab').forEach(b => b.classList.toggle('active', b.dataset.arcaTab === tab));
  const isContribs = tab === 'contribuyentes';
  const vComp = document.getElementById('arca-view-comprobantes');
  const vCont = document.getElementById('arca-view-contribuyentes');
  if (vComp) vComp.style.display = isContribs ? 'none' : '';
  if (vCont) vCont.style.display = isContribs ? '' : 'none';
  if (isContribs) {
    loadContribuyentesTable();
  } else {
    const th = document.getElementById('arca-th-contraparte');
    if (th) th.textContent = tab === 'emitidos' ? 'Receptor' : 'Emisor';
    loadArca();
  }
}

// ── Gestión de contribuyentes AFIP ───────────────────────────────────────────
async function loadContribuyentesTable() {
  const tbody = document.getElementById('contrib-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;"><i class="fa-solid fa-spinner fa-spin"></i></td></tr>';
  try {
    const rows = await fetch('/api/afip/contribuyentes').then(r => r.json());
    _allContribs = rows;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-secondary);padding:24px;">Sin contribuyentes. Agregá uno con el botón de arriba.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(c => {
      const certBadge = c.tiene_cert ? '<span class="badge badge-success"><i class="fa-solid fa-check"></i></span>' : '<span class="badge badge-danger"><i class="fa-solid fa-xmark"></i></span>';
      const keyBadge  = c.tiene_key  ? '<span class="badge badge-success"><i class="fa-solid fa-check"></i></span>' : '<span class="badge badge-danger"><i class="fa-solid fa-xmark"></i></span>';
      const vto = c.cert_vence ? formatDate(c.cert_vence) : '—';
      const vtoColor = c.cert_vence && new Date(c.cert_vence) < new Date(Date.now() + 30*864e5) ? 'color:#c96a00;font-weight:700;' : '';
      const ambBadge = c.production ? '<span class="badge badge-danger">Producción</span>' : '<span class="badge badge-info">Homologación</span>';
      const actBadge = c.activo ? '<span class="badge badge-success">Activo</span>' : '<span class="badge badge-secondary">Inactivo</span>';
      return `<tr data-id="${c.id}">
        <td style="font-family:monospace;">${c.cuit}</td>
        <td>${c.nombre}</td>
        <td style="text-align:center;">${c.punto_venta}</td>
        <td>${ambBadge}</td>
        <td style="text-align:center;">${certBadge}</td>
        <td style="text-align:center;">${keyBadge}</td>
        <td style="${vtoColor}">${vto}</td>
        <td>${actBadge}</td>
        <td style="text-align:center;white-space:nowrap;">
          <button class="tbl-action-btn" onclick="subirCertContrib(${c.id},'cert')" title="Subir certificado .crt"><i class="fa-solid fa-certificate"></i></button>
          <button class="tbl-action-btn" onclick="subirCertContrib(${c.id},'key')"  title="Subir clave privada .key"><i class="fa-solid fa-key"></i></button>
          <button class="tbl-action-btn tbl-btn-edit" onclick="editarContribuyente(${c.id})" title="Editar"><i class="fa-solid fa-pen"></i></button>
          ${c.activo
            ? `<button class="tbl-action-btn tbl-btn-del"  onclick="desactivarContrib(${c.id},'${c.nombre.replace(/'/g,"\\'")}',false)" title="Desactivar"><i class="fa-solid fa-ban"></i></button>`
            : `<button class="tbl-action-btn tbl-btn-edit" onclick="desactivarContrib(${c.id},'${c.nombre.replace(/'/g,"\\'")}',true)"  title="Activar" style="color:#22c55e;"><i class="fa-solid fa-circle-check"></i></button>`
          }
        </td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#ef4444;padding:24px;">${e.message}</td></tr>`;
  }
}

async function subirCertContrib(id, tipo) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = tipo === 'cert' ? '.crt,.pem' : '.key,.pem';
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch(`/api/afip/contribuyentes/${id}/cert?tipo=${tipo}`, { method:'POST', body: fd });
      const d = await r.json();
      if (!r.ok) { showToast(d.message || 'Error', 'error'); return; }
      const msg = tipo === 'cert'
        ? `✓ Certificado cargado${d.cert_vence ? ' · vence ' + formatDate(d.cert_vence) : ''}`
        : '✓ Clave privada cargada';
      showToast(msg, 'success');
      loadContribuyentesTable();
      _loadArcaContribs();
    } catch(e) { showToast(e.message, 'error'); }
  };
  inp.click();
}

async function desactivarContrib(id, nombre, activar = false) {
  const accion = activar ? 'Activar' : 'Desactivar';
  const ok = await showConfirm(`¿${accion} contribuyente "${nombre}"?`);
  if (!ok) return;
  let r;
  if (activar) {
    const rows = await fetch('/api/afip/contribuyentes').then(x => x.json());
    const c = rows.find(x => String(x.id) === String(id));
    if (!c) return;
    r = await fetch(`/api/afip/contribuyentes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: c.nombre, punto_venta: c.punto_venta, production: c.production, notas: c.notas, activo: 1 }),
    });
  } else {
    r = await fetch(`/api/afip/contribuyentes/${id}`, { method: 'DELETE' });
  }
  if (r.ok) {
    showToast(`Contribuyente ${activar ? 'activado' : 'desactivado'}`, 'success');
    loadContribuyentesTable();
    _loadArcaContribs();
  }
}

function editarContribuyente(id) {
  const c = _allContribs.find(x => String(x.id) === String(id));
  if (!c) { showToast('Contribuyente no encontrado (id=' + id + ')', 'error'); return; }
  abrirModalContribuyente(c);
}

function abrirModalContribuyente(c = null) {
  const titulo = c ? 'Editar contribuyente' : 'Nuevo contribuyente';
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  const ambBadge = c?.production
    ? `<span class="badge badge-danger" style="font-size:11px;">Producción</span>`
    : `<span class="badge badge-info"   style="font-size:11px;">Homologación</span>`;
  modal.innerHTML = `
    <div class="modal-card modal-crud" style="max-width:520px;width:100%;">
      <div class="modal-header">
        <div style="display:flex;align-items:center;gap:10px;">
          <i class="fa-solid fa-building-columns" style="font-size:18px;color:var(--accent-color);"></i>
          <div>
            <h2 style="margin:0;font-size:16px;">${titulo}</h2>
            ${c ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:1px;">${c.cuit} ${ambBadge}</div>` : ''}
          </div>
        </div>
        <button class="btn-close" onclick="this.closest('.modal-overlay').remove()"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="modal-body" style="padding:20px 24px;">
        <div style="display:grid;gap:16px;">

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div>
              <label class="form-label">CUIT <span style="color:var(--color-error);">*</span></label>
              <input id="_mc-cuit" class="form-control" placeholder="20238166277" value="${c?.cuit||''}" ${c?'readonly':''}>
            </div>
            <div>
              <label class="form-label">Punto de venta</label>
              <input id="_mc-pv" class="form-control" type="number" min="1" value="${c?.punto_venta||1}">
            </div>
          </div>

          <div>
            <label class="form-label">Nombre / Razón social <span style="color:var(--color-error);">*</span></label>
            <input id="_mc-nombre" class="form-control" placeholder="Ej: Juan Pérez" value="${c?.nombre||''}">
          </div>

          <div>
            <label class="form-label">Ambiente</label>
            <select id="_mc-prod" class="form-control">
              <option value="0" ${!c?.production?'selected':''}>🧪 Homologación (pruebas)</option>
              <option value="1" ${c?.production?'selected':''}>🚀 Producción</option>
            </select>
          </div>

          <div>
            <label class="form-label">Notas</label>
            <input id="_mc-notas" class="form-control" placeholder="Alias, observaciones…" value="${c?.notas||''}">
          </div>

          <div>
            <label class="form-label" style="display:flex;align-items:center;gap:6px;">
              <i class="fa-solid fa-file-invoice" style="color:var(--text-secondary);font-size:11px;"></i>
              Concepto base de facturación
              <span style="font-size:10px;color:var(--text-secondary);font-weight:400;">(se agrega el N° de operación automáticamente)</span>
            </label>
            <input id="_mc-concepto" class="form-control" placeholder="Ej: Alquiler vehículo" value="${c?.concepto_base||''}">
          </div>

          <div style="border-top:1px solid var(--border-color);padding-top:14px;">
            <label class="form-label" style="display:flex;align-items:center;gap:6px;">
              <i class="fa-solid fa-link" style="color:var(--text-secondary);font-size:11px;"></i>
              URL WSCDC
              <span style="font-size:10px;color:var(--text-secondary);font-weight:400;">(opcional — sobreescribe el default)</span>
            </label>
            <input id="_mc-wscdc" class="form-control" style="font-size:12px;font-family:monospace;"
              placeholder="https://servicios1.afip.gov.ar/WSCDC/service.asmx?WSDL"
              value="${c?.wscdc_url||''}">
          </div>

        </div>
      </div>
      <div class="modal-footer" style="padding:16px 24px;margin-top:0;">
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
        <button class="btn btn-primary" id="_mc-save"><i class="fa-solid fa-floppy-disk"></i> Guardar</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('active'));

  modal.querySelector('#_mc-save').onclick = async () => {
    const body = {
      cuit:        modal.querySelector('#_mc-cuit').value.trim(),
      nombre:      modal.querySelector('#_mc-nombre').value.trim(),
      punto_venta: parseInt(modal.querySelector('#_mc-pv').value) || 1,
      production:  modal.querySelector('#_mc-prod').value === '1' ? 1 : 0,
      notas:         modal.querySelector('#_mc-notas').value.trim(),
      concepto_base: modal.querySelector('#_mc-concepto').value.trim() || null,
      wscdc_url:     modal.querySelector('#_mc-wscdc').value.trim() || null,
    };
    if (!body.cuit || !body.nombre) { showToast('CUIT y nombre son obligatorios', 'error'); return; }
    const url    = c ? `/api/afip/contribuyentes/${c.id}` : '/api/afip/contribuyentes';
    const method = c ? 'PUT' : 'POST';
    try {
      const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) { showToast(d.message || 'Error', 'error'); return; }
      showToast(c ? '✓ Contribuyente actualizado' : '✓ Contribuyente creado', 'success');
      modal.remove();
      loadContribuyentesTable();
      _loadArcaContribs();
    } catch(e) { showToast(e.message, 'error'); }
  };
}

async function loadArca(filtrar = false) {
  _loadArcaContribs();
  // Defaults de fecha: último mes
  const desdeEl = document.getElementById('arca-desde');
  const hastaEl = document.getElementById('arca-hasta');
  if (!desdeEl.value) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    desdeEl.value = d.toISOString().split('T')[0];
  }
  if (!hastaEl.value) hastaEl.value = new Date().toISOString().split('T')[0];

  const direccion = _arcaTab === 'emitidos' ? 'emitido' : 'recibido';
  const params = new URLSearchParams({
    direccion,
    desde: desdeEl.value,
    hasta: hastaEl.value,
  });
  const tipo      = document.getElementById('arca-tipo')?.value;
  const contribId = document.getElementById('arca-contrib-sel')?.value;
  if (tipo)      params.set('tipo', tipo);
  if (contribId) params.set('cuit_emisor', document.getElementById('arca-contrib-sel').selectedOptions[0]?.dataset.cuit || '');

  const tbody = document.getElementById('arca-table-body');
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;"><i class="fa-solid fa-spinner fa-spin"></i> Cargando…</td></tr>';

  try {
    const rows = await fetch('/api/arca/comprobantes?' + params).then(r => r.json());
    if (!Array.isArray(rows)) throw new Error(rows.message || 'Error');

    let total = 0, iva = 0;
    tbody.innerHTML = rows.length === 0
      ? '<tr><td colspan="12" style="text-align:center;color:var(--text-secondary);padding:24px;">Sin comprobantes para el período. Usá <strong>Sincronizar AFIP</strong> para traer novedades.</td></tr>'
      : rows.map(r => {
          total += parseFloat(r.importe_total || 0);
          iva   += parseFloat(r.importe_iva   || 0);
          const contraparte = r.razon_social || (direccion === 'emitido' ? r.cuit_receptor : r.cuit_emisor) || '—';
          const nro = `${String(r.pto_venta).padStart(5,'0')}-${String(r.nro_comprobante).padStart(8,'0')}`;
          const caeVto  = r.cae_vto       ? formatDate(r.cae_vto)       : '—';
          const vtoPago = r.fecha_vto_pago ? formatDate(r.fecha_vto_pago) : '—';
          const estadoBadge = r.estado === 'A'
            ? '<span class="badge badge-success">Activo</span>'
            : `<span class="badge badge-warning">${r.estado}</span>`;
          const pdfBtn = r.pdf_url
            ? `<button class="tbl-action-btn tbl-btn-factura-pdf" onclick="openDocViewer('${r.pdf_url}','${r.desc_tipo} ${nro}',true)" title="Ver PDF"><i class="fa-solid fa-file-pdf"></i></button>`
            : `<button class="tbl-action-btn tbl-btn-clip" onclick="adjuntarArcaPdf(${r.id})" title="Adjuntar PDF"><i class="fa-solid fa-paperclip"></i></button>`;
          const texto = `*${r.desc_tipo} ${nro}*\nFecha: ${formatDate(r.fecha_cbte)}\n${contraparte}\nTotal: ${formatCurrency(r.importe_total)}\nCAE: ${r.cae||'—'} (vto ${caeVto})`;
          return `<tr data-id="${r.id}">
            <td>${formatDate(r.fecha_cbte)}</td>
            <td>${r.desc_tipo || r.codigo_tipo}</td>
            <td style="font-family:monospace;">${nro}</td>
            <td>${contraparte}</td>
            <td><strong>${formatCurrency(r.importe_total)}</strong></td>
            <td>${formatCurrency(r.importe_iva)}</td>
            <td>${vtoPago}</td>
            <td style="font-family:monospace;font-size:11px;">${r.cae || '—'}</td>
            <td>${caeVto}</td>
            <td>${estadoBadge}</td>
            <td style="text-align:center;">${pdfBtn}</td>
            <td style="text-align:center;white-space:nowrap;">
              <button class="tbl-action-btn tbl-btn-wa" onclick="enviarArcaWA(${JSON.stringify(texto).replace(/'/g,'&apos;')})" title="Enviar por WhatsApp"><i class="fa-brands fa-whatsapp"></i></button>
            </td>
          </tr>`;
        }).join('');

    const totRow = document.getElementById('arca-totals-row');
    if (totRow) totRow.style.display = 'flex';
    const elCount = document.getElementById('arca-badge-count');
    const elTotal = document.getElementById('arca-badge-total');
    const elIva   = document.getElementById('arca-badge-iva');
    if (elCount) elCount.textContent = rows.length;
    if (elTotal) animateCounter(elTotal, total, v => formatCurrency(v));
    if (elIva)   animateCounter(elIva,   iva,   v => formatCurrency(v));

    staggerTableRows(tbody);
    injectExportBar('table-arca', 'ARCA-Comprobantes');
    _loadArcaSyncInfo();
  } catch(e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;color:#ef4444;padding:24px;">${e.message}</td></tr>`;
  }
}

function adjuntarArcaPdf(id) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/pdf';
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    const fd = new FormData(); fd.append('pdf', file);
    try {
      const res  = await fetch(`/api/arca/comprobantes/${id}/pdf`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) { showToast(data.message || 'Error', 'error'); return; }
      showToast('✓ PDF vinculado', 'success');
      loadArca(true);
    } catch(e) { showToast('Error: ' + e.message, 'error'); }
  };
  inp.click();
}

function enviarArcaWA(texto) {
  // Abre el selector de destinatario WA reutilizando el panel existente
  if (typeof openWAComposer === 'function') {
    openWAComposer(texto);
  } else {
    // Fallback: copiar al portapapeles
    navigator.clipboard.writeText(texto).then(() => showToast('Texto copiado al portapapeles', 'success'));
  }
}

async function _loadArcaSyncInfo() {
  try {
    const info = await fetch('/api/arca/sync-info').then(r => r.json());
    const el = document.getElementById('arca-sync-info');
    if (!el) return;
    if (info.last_sync) {
      const d = new Date(info.last_sync);
      el.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#22c55e"></i> Última sync: ${d.toLocaleString('es-AR')} — datos hasta ${formatDate(info.last_fecha)}`;
    } else {
      el.innerHTML = '<i class="fa-solid fa-circle-info" style="color:#888"></i> Sin sincronizaciones previas.';
    }
  } catch {}
}

async function syncArca() {
  const btn = document.getElementById('btn-arca-sync');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sincronizando…'; }
  try {
    const desde       = document.getElementById('arca-desde')?.value || '';
    const hasta       = document.getElementById('arca-hasta')?.value || '';
    const contribId   = document.getElementById('arca-contrib-sel')?.value || '';
    const body        = { direccion: 'ambos' };
    if (desde)     body.desde = desde;
    if (hasta)     body.hasta = hasta;
    if (contribId) body.contribuyente_id = contribId;

    const res  = await fetch('/api/arca/sync', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { showToast(data.message || 'Error al sincronizar', 'error'); return; }
    showToast(`✓ Sync completa — ${data.nuevos} comprobante(s) nuevo(s) (${data.desde} → ${data.hasta})`, 'success');
    loadArca();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
  finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Sincronizar AFIP'; }
  }
}

function clearArcaFilters() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  const desde = document.getElementById('arca-desde');
  const hasta  = document.getElementById('arca-hasta');
  if (desde) desde.value = d.toISOString().split('T')[0];
  if (hasta)  hasta.value = new Date().toISOString().split('T')[0];
  const tipo   = document.getElementById('arca-tipo');
  const contrib = document.getElementById('arca-contrib-sel');
  const search  = document.getElementById('arca-search-input');
  if (tipo)    tipo.value    = '';
  if (contrib) contrib.value = '';
  if (search)  search.value  = '';
  loadArca(true);
}

function filterArcaTable(q) {
  const rows = document.querySelectorAll('#arca-table-body tr');
  const term = q.toLowerCase();
  rows.forEach(r => { r.style.display = r.textContent.toLowerCase().includes(term) ? '' : 'none'; });
}

// ══ Fin ARCA ══════════════════════════════════════════════════════════════════

async function loadPeajes() {
  try {
    const desde   = document.getElementById('peajes-filter-desde')?.value || '';
    const hasta   = document.getElementById('peajes-filter-hasta')?.value || '';
    const patente = document.getElementById('peajes-filter-patente')?.value || '';
    const chofer  = document.getElementById('peajes-filter-chofer')?.value || '';
    const params  = new URLSearchParams();
    if (desde)   params.set('desde',     desde);
    if (hasta)   params.set('hasta',     hasta);
    if (patente) params.set('patente',   patente);
    if (chofer)  params.set('chofer_id', chofer);

    const res  = await fetch('/api/peajes?' + params.toString());
    const list = await res.json();
    if (!res.ok) throw new Error(list.message || 'Error');

    const tbody = document.getElementById('peajes-table-body');
    tbody.innerHTML = '';
    const canDel = canDelete();

    list.forEach((r, idx) => {
      const tr = document.createElement('tr');
      if (idx % 2 === 1) tr.classList.add('row-alt');
      const choferCell = r.chofer_nombre
        ? `<span style="font-size:13px;">${r.chofer_nombre}</span>`
        : `<span style="color:var(--color-warning);font-size:12px;font-weight:600;">⚠ Sin asignar</span>`;
      tr.innerHTML = `
        <td>${r.autopista}</td>
        <td>${r.barrera||''}</td>
        <td><span style="font-family:monospace;font-weight:600;">${r.patente||'—'}</span></td>
        <td>${choferCell}</td>
        <td>${formatDateTime(r.fecha_hora)}</td>
        <td style="text-align:right;font-weight:700;">${formatCurrency(r.importe)}</td>
        <td style="text-align:center;">
          ${canDel ? `<button class="tbl-action-btn tbl-btn-delete" onclick="deletePeaje(${r.id})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>` : ''}
        </td>`;
      tbody.appendChild(tr);
    });

    const total = list.reduce((s, r) => s + parseFloat(r.importe || 0), 0);
    const badge = document.getElementById('peajes-total-badge');
    if (badge) {
      if (list.length) animateCounter(badge, total, v => `${formatCurrency(v)} (${list.length})`);
      else badge.textContent = '';
    }
    const peajesRow = document.getElementById('peajes-totals-row');
    if (peajesRow) peajesRow.style.display = list.length ? '' : 'none';

    staggerTableRows(tbody);
    _populatePeajesPatenteFilter(list);
    _populatePeajesChoferFilter(list);
    injectExportBar('table-peajes', 'Peajes');
  } catch(e) { showToast('Error al cargar peajes: ' + e.message, 'error'); }
}

function _populatePeajesChoferFilter(list) {
  const sel = document.getElementById('peajes-filter-chofer');
  if (!sel || sel.dataset.loaded) return;
  const current = sel.value;
  const choferes = [...new Map(
    list.filter(r => r.chofer_id && r.chofer_nombre)
        .map(r => [r.chofer_id, r.chofer_nombre])
  ).entries()].sort((a,b) => a[1].localeCompare(b[1]));
  // Mantener opciones fijas y agregar choferes dinámicamente
  const fixed = ['', 'sin_asignar'];
  [...sel.options].forEach(o => { if (!fixed.includes(o.value)) o.remove(); });
  choferes.forEach(([id, nombre]) => {
    if ([...sel.options].some(o => o.value == id)) return;
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = nombre;
    if (String(id) === current) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.dataset.loaded = '1';
}

function _populatePeajesPatenteFilter(list) {
  const sel = document.getElementById('peajes-filter-patente');
  if (!sel) return;
  const current = sel.value;
  const patentes = [...new Set(list.map(r => r.patente).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">-- Todas --</option>';
  patentes.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    if (p === current) opt.selected = true;
    sel.appendChild(opt);
  });
}

function clearPeajesFilters() {
  ['peajes-filter-desde','peajes-filter-hasta'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  _clearSelect('peajes-filter-patente');
  _clearSelect('peajes-filter-chofer');
  const fc = document.getElementById('peajes-filter-chofer');
  if (fc) delete fc.dataset.loaded;
  loadPeajes();
}

function filterPeajesTable(q) {
  const rows = document.querySelectorAll('#peajes-table-body tr');
  const term = q.toLowerCase();
  rows.forEach(tr => { tr.style.display = tr.textContent.toLowerCase().includes(term) ? '' : 'none'; });
}

async function deletePeaje(id) {
  if (!await showConfirm('¿Eliminar este registro de peaje? No se puede deshacer.')) return;
  try {
    const res = await fetch(`/api/peajes/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).message);
    showToast('Peaje eliminado');
    loadPeajes();
  } catch(e) { showAlert('Error: ' + e.message, 'error'); }
}

async function deduplicarPeajes() {
  const ok = await showConfirm('¿Depurar duplicados?\n\nSe eliminará el registro con la barrera más corta cuando haya entradas con misma autopista, patente, fecha/hora e importe.\n\nEsta acción no se puede deshacer.');
  if (!ok) return;
  try {
    const res  = await fetch('/api/peajes/deduplicar', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    if (data.eliminados === 0) {
      showToast('No se encontraron duplicados', 'info');
    } else {
      showToast(`Depuración completa: ${data.eliminados} registro(s) eliminado(s) en ${data.grupos} grupo(s)`, 'success');
      loadPeajes();
    }
  } catch(e) { showAlert('Error: ' + e.message, 'error'); }
}

// ── Pegar datos ──────────────────────────────────────────────

function openPeajesPaste() {
  document.getElementById('peajes-paste-input').value = '';
  document.getElementById('peajes-paste-preview').style.display = 'none';
  document.getElementById('peajes-paste-status').textContent = '';
  document.getElementById('btn-peajes-save').style.display = 'none';
  _peajesParsed = [];
  openModal('modal-peajes-paste');
}

async function peajesMostrarConfirmPegar() {
  // Si el permiso ya fue concedido, pegar directo sin overlay
  try {
    const text = await navigator.clipboard.readText();
    const ta = document.getElementById('peajes-paste-input');
    ta.value = text;
    ta.dispatchEvent(new Event('input'));
    ta.focus();
    return;
  } catch(_) {
    // Permiso no concedido aún → mostrar overlay con trampa Ctrl+V
  }
  const overlay = document.getElementById('peajes-confirm-pegar');
  overlay.style.display = 'flex';
  document.getElementById('peajes-btn-permitir').onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      overlay.style.display = 'none';
      const ta = document.getElementById('peajes-paste-input');
      ta.value = text;
      ta.dispatchEvent(new Event('input'));
      ta.focus();
    } catch(_) {
      showAlert('Acceso al portapapeles denegado. Habilitalo en la configuración del navegador.');
    }
  };
  setTimeout(() => document.getElementById('peajes-btn-permitir')?.focus(), 50);
}

function parsePeajesPaste() {
  const raw = document.getElementById('peajes-paste-input').value.trim();
  if (!raw) { showToast('Pegá datos primero', 'error'); return; }

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  // Detectar si la primera fila es encabezado
  const firstLower = lines[0].toLowerCase();
  const hasHeader  = firstLower.includes('autopista') || firstLower.includes('patente') || firstLower.includes('fecha');
  const dataLines  = hasHeader ? lines.slice(1) : lines;

  _peajesParsed = [];
  const errors = [];

  dataLines.forEach((line, i) => {
    const cols = line.split('\t');
    if (cols.length < 4) { errors.push(`Fila ${i+1}: menos de 4 columnas`); return; }

    // Formato: Autopista | Barrera/Pórtico | Patente | Fecha Hora Paso | Importe
    const autopista  = cols[0].trim();
    const barrera    = cols.length >= 5 ? cols[1].trim()                  : '';
    const patente    = cols.length >= 5 ? cols[2].trim().toUpperCase()    : cols[1].trim().toUpperCase();
    const fechaStr   = cols.length >= 5 ? cols[3].trim()                  : cols[2].trim();
    const importeStr = cols.length >= 5 ? cols[4].trim()                  : cols[3].trim();

    if (!autopista) { errors.push(`Fila ${i+1}: autopista vacía`); return; }

    // Parsear fecha: requiere DD-MM-YYYY HH:MM (con hora obligatoria para asignación a turno)
    let fecha_hora = null;
    const mFechaHora = fechaStr.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})\s+(\d{1,2}):(\d{2})/);
    if (mFechaHora) {
      fecha_hora = `${mFechaHora[3]}-${mFechaHora[2].padStart(2,'0')}-${mFechaHora[1].padStart(2,'0')} ${mFechaHora[4].padStart(2,'0')}:${mFechaHora[5]}:00`;
    } else if (fechaStr.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/)) {
      errors.push(`Fila ${i+1}: fecha sin hora "${fechaStr}" — se requiere hora para asignar al turno`);
      return;
    } else {
      errors.push(`Fila ${i+1}: fecha inválida "${fechaStr}"`);
      return;
    }

    // Parsear importe: "$4.431,94" o "$1.500" → número
    const importe = parseFloat(importeStr.replace(/[$\s]/g,'').replace(/\./g,'').replace(',','.')) || 0;
    if (!importe) { errors.push(`Fila ${i+1}: importe inválido "${importeStr}"`); return; }

    _peajesParsed.push({ autopista, barrera, patente, fecha_hora, importe });
  });

  // Preview
  const previewBody = document.getElementById('peajes-paste-preview-body');
  previewBody.innerHTML = '';
  _peajesParsed.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.autopista}</td><td>${r.barrera||''}</td><td>${r.patente||''}</td><td>${r.fecha_hora}</td><td style="text-align:right;">${formatCurrency(r.importe)}</td>`;
    previewBody.appendChild(tr);
  });

  document.getElementById('peajes-paste-count').textContent =
    `${_peajesParsed.length} fila(s) válidas${errors.length ? ` · ${errors.length} con error` : ''}`;
  document.getElementById('peajes-paste-preview').style.display = _peajesParsed.length ? '' : 'none';
  document.getElementById('btn-peajes-save').style.display = _peajesParsed.length ? '' : 'none';

  if (errors.length) {
    document.getElementById('peajes-paste-status').innerHTML =
      `<span style="color:var(--accent-orange);">⚠ Errores: ${errors.join(' · ')}</span>`;
  } else {
    document.getElementById('peajes-paste-status').textContent = '';
  }
}

async function savePeajesPaste() {
  if (!_peajesParsed.length) return;
  const btn = document.getElementById('btn-peajes-save');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importando…';
  try {
    const res  = await fetch('/api/peajes/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: _peajesParsed })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);

    const msg = `✓ Importados: ${data.inserted}  ·  Duplicados omitidos: ${data.duplicates}${data.errors ? `  ·  Errores: ${data.errors}` : ''}`;
    document.getElementById('peajes-paste-status').innerHTML = `<span style="color:var(--accent-green);">${msg}</span>`;
    showToast(`Peajes importados: ${data.inserted} nuevos`, 'success');
    _peajesParsed = [];
    document.getElementById('btn-peajes-save').style.display = 'none';
    loadPeajes();
    setTimeout(() => closeModal('modal-peajes-paste'), 1800);
  } catch(e) {
    showAlert('Error al importar: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Importar';
  }
}

// ── Importar Excel del servidor (superadmin) ─────────────────

async function importPeajesExcel(input) {
  const file = input?.files?.[0];
  if (!file) return;
  input.value = '';
  try {
    showToast('Importando Excel…', 'info');
    const fd = new FormData();
    fd.append('file', file);
    const res  = await fetch('/api/peajes/import-excel', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    showAlert(`Excel importado:\n✓ Insertados: ${data.inserted}\n⟳ Duplicados: ${data.duplicates}\n✗ Errores: ${data.errors}\nTotal filas: ${data.total}`, 'success');
    loadPeajes();
  } catch(e) { showAlert('Error: ' + e.message, 'error'); }
}

function formatDateTime(dt) {
  if (!dt) return '-';
  const d = new Date(dt);
  if (isNaN(d)) return dt;
  return d.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' })
       + ' ' + d.toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit', hour12: false });
}

// ──────────────────────────────────────────────────────────────
// SMART COMBO — convierte todos los <select> en combobox buscable
// ──────────────────────────────────────────────────────────────
const SmartCombo = (() => {
  const SKIP = ['[data-no-combo]', '[data-no-smart]'];

  function shouldSkip(sel) {
    return SKIP.some(s => sel.matches(s)) || sel.closest('[data-no-combo]');
  }

  function buildLabel(opt) {
    return opt.textContent.trim();
  }

  function init(sel) {
    if (sel._scInit || shouldSkip(sel)) return;
    // Si ya está dentro de un ss-wrap (sistema viejo), sacarlo primero
    if (sel.parentNode?.classList.contains('ss-wrap')) {
      const oldWrap = sel.parentNode;
      oldWrap.parentNode.insertBefore(sel, oldWrap);
      oldWrap.remove();
    }
    sel._scInit = true;
    delete sel.dataset.ssDone; // limpiar marca del sistema viejo

    // Wrapper
    const wrap = document.createElement('div');
    wrap.className = 'ss-wrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    // Input visible
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ss-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (sel.disabled) input.disabled = true;
    wrap.insertBefore(input, sel);

    // Dropdown
    const drop = document.createElement('div');
    drop.className = 'ss-drop';
    wrap.appendChild(drop);

    let _open = false;
    let _cursor = -1;
    let _opts = [];

    function getOptions() {
      return Array.from(sel.options).map(o => ({
        value: o.value,
        label: buildLabel(o),
        disabled: o.disabled,
        placeholder: !o.value && o.value !== 0
      }));
    }

    function renderDrop(filter) {
      const q = (filter || '').toLowerCase();
      _opts = getOptions();
      const visible = _opts.filter(o => !o.placeholder && (!q || o.label.toLowerCase().includes(q)));
      drop.innerHTML = '';
      _cursor = -1;

      if (!visible.length) {
        drop.innerHTML = '<div class="ss-no-results">Sin resultados</div>';
        return;
      }
      visible.forEach((o, i) => {
        const div = document.createElement('div');
        div.className = 'ss-opt' + (o.disabled ? ' ss-opt--disabled' : '');
        div.textContent = o.label;
        div.dataset.val = o.value;
        if (o.value === sel.value) { div.classList.add('ss-active'); _cursor = i; }
        div.addEventListener('mousedown', e => {
          e.preventDefault();
          if (!o.disabled) pick(o.value, o.label);
        });
        drop.appendChild(div);
      });
    }

    function syncLabel() {
      const sel_opt = sel.options[sel.selectedIndex];
      if (sel_opt && sel_opt.value) {
        input.value = buildLabel(sel_opt);
        input.placeholder = '';
      } else {
        input.value = '';
        // Placeholder: buscar la opción vacía explícita, o el atributo placeholder del select
        const emptyOpt = Array.from(sel.options).find(o => !o.value);
        input.placeholder = sel.dataset.placeholder
          || (emptyOpt ? buildLabel(emptyOpt) : null)
          || sel.getAttribute('placeholder')
          || '— Seleccionar —';
      }
    }

    function openDrop() {
      if (_open) return;
      _open = true;
      wrap.classList.add('ss-open');
      renderDrop('');
      drop.style.display = 'block';
      // Posición: abre hacia arriba si no hay espacio abajo
      const rect = wrap.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      drop.style.bottom = spaceBelow < 240 ? (rect.height + 4) + 'px' : '';
      drop.style.top    = spaceBelow < 240 ? 'auto' : '';
      input.select();
    }

    function closeDrop() {
      if (!_open) return;
      _open = false;
      wrap.classList.remove('ss-open');
      drop.style.display = 'none';
      syncLabel();
    }

    function pick(value, label) {
      sel.value = value;
      input.value = label;
      input.placeholder = '';
      closeDrop();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function moveCursor(dir) {
      const items = drop.querySelectorAll('.ss-opt:not(.ss-opt--disabled)');
      if (!items.length) return;
      _cursor = Math.max(0, Math.min(items.length - 1, _cursor + dir));
      items.forEach((el, i) => el.classList.toggle('ss-active', i === _cursor));
      items[_cursor]?.scrollIntoView({ block: 'nearest' });
    }

    // Events
    // mousedown: si ya está abierto, cerrarlo antes de que focus lo vuelva a abrir
    input.addEventListener('mousedown', e => {
      if (_open) {
        e.preventDefault(); // evita que blur+focus cicle y el dropdown parpadee
        closeDrop();
      }
    });
    // focus: abre sólo si no está ya abierto (tab, click cuando estaba cerrado)
    input.addEventListener('focus', () => { if (!_open) openDrop(); });
    input.addEventListener('input', () => { renderDrop(input.value); if (!_open) openDrop(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown')  { e.preventDefault(); _open ? moveCursor(1)  : openDrop(); }
      if (e.key === 'ArrowUp')    { e.preventDefault(); _open ? moveCursor(-1) : openDrop(); }
      if (e.key === 'Enter') {
        e.preventDefault();
        const active = drop.querySelector('.ss-opt.ss-active');
        if (active) pick(active.dataset.val, active.textContent);
        else closeDrop();
      }
      if (e.key === 'Escape') { closeDrop(); input.blur(); }
      if (e.key === 'Tab')    closeDrop();
    });
    input.addEventListener('blur', () => setTimeout(closeDrop, 150));

    // Cerrar si se hace click fuera del wrap
    document.addEventListener('mousedown', e => {
      if (_open && !wrap.contains(e.target)) closeDrop();
    }, true);

    // Observar cambios de opciones (selects poblados dinámicamente por JS)
    const mo = new MutationObserver(() => {
      if (_open) renderDrop(input.value);
      else syncLabel();
    });
    mo.observe(sel, { childList: true });

    // Observar disabled
    const attrObs = new MutationObserver(() => { input.disabled = sel.disabled; });
    attrObs.observe(sel, { attributes: true, attributeFilter: ['disabled'] });

    // API pública en el select
    sel._scRefresh = () => { syncLabel(); if (_open) renderDrop(input.value); };
    sel._scSetVal  = (v) => { sel.value = v; syncLabel(); };
    // Compatibilidad con código viejo
    sel._ssSet   = (v) => { sel.value = v; syncLabel(); };
    sel._ssClear = ()  => { sel.value = ''; syncLabel(); };

    syncLabel();
  }

  function initAll(root) {
    (root || document).querySelectorAll('select').forEach(s => {
      if (!s._scInit) init(s);
    });
  }

  // Auto-init en selects que aparezcan dinámicamente
  new MutationObserver(muts => {
    muts.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (n.tagName === 'SELECT') init(n);
      else n.querySelectorAll?.('select').forEach(s => { if (!s._scInit) init(s); });
    }));
  }).observe(document.body, { childList: true, subtree: true });

  return {
    init,
    initAll,
    refresh: sel => sel?._scRefresh?.(),
    setValue: (sel, v) => sel?._scSetVal?.(v)
  };
})();

// ──────────────────────────────────────────────────────────────
// CREDENCIALES (superadmin)
// ──────────────────────────────────────────────────────────────
const _credLabels = {
  ANTHROPIC_API_KEY:     { label: 'Anthropic API Key (Claude IA)', icon: '🤖', placeholder: 'sk-ant-...' },
  R2_ACCOUNT_ID:         { label: 'Cloudflare R2 — Account ID',    icon: '☁️', placeholder: 'a1b2c3...' },
  R2_ACCESS_KEY_ID:      { label: 'Cloudflare R2 — Access Key ID', icon: '☁️', placeholder: '' },
  R2_SECRET_ACCESS_KEY:  { label: 'Cloudflare R2 — Secret Key',    icon: '☁️', placeholder: '' },
  R2_BUCKET_NAME:        { label: 'Cloudflare R2 — Bucket Name',   icon: '☁️', placeholder: 'mi-bucket' },
  R2_PUBLIC_URL:         { label: 'Cloudflare R2 — URL Pública',   icon: '☁️', placeholder: 'https://...' },
  SHEETJS_LICENSE_KEY:   { label: 'SheetJS Pro — License Key (exportar imágenes dentro de XLS)', icon: '📊', placeholder: 'xxxx-xxxx-xxxx-xxxx', note: 'Requiere licencia en https://sheetjs.com — sin ella los gráficos se exportan como PNG separado.' },
};

// ── CREDENCIALES IA ──────────────────────────────────────────────────────────
const _TAREA_LABELS = {
  'extract-cedula': 'Cédula vehículo', 'extract-gnc': 'Oblea GNC',
  'extract-seguro': 'Póliza seguro', 'extract-vtv': 'VTV',
  'extract-multa': 'Multa', 'extract-factura': 'Factura/Comprobante',
  'extract-chofer': 'Doc. Chofer (IA)', 'ocr-text': 'OCR texto',
  'analizar-multa-whatsapp': 'Análisis multa WhatsApp',
};

async function loadIaCredenciales() {
  try {
    const res = await fetch('/api/ia/credenciales');
    if (!res.ok) return;
    const list = await res.json();
    const el = document.getElementById('ia-cred-list');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = `<div style="color:var(--text-secondary);font-size:13px;padding:10px 0;">
        Sin credenciales configuradas. Agregá una para habilitar las funciones de IA.
        <br><small style="opacity:.7;">Si tenés ANTHROPIC_API_KEY en el .env, seguirá funcionando como fallback.</small>
      </div>`;
      return;
    }
    el.innerHTML = list.map(c => `
      <div style="background:var(--bg-secondary);border:1px solid ${c.activa ? 'var(--accent-purple,#a855f7)' : 'var(--border-color)'};border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:12px;">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span style="font-weight:600;font-size:13px;">${c.nombre}</span>
            ${c.activa ? '<span style="background:var(--accent-purple,#a855f7);color:#fff;font-size:10px;padding:2px 8px;border-radius:20px;font-weight:600;">ACTIVA</span>' : ''}
          </div>
          <div style="font-size:11px;color:var(--text-secondary);display:flex;gap:12px;flex-wrap:wrap;">
            <span><i class="fa-solid fa-robot"></i> ${c.modelo}</span>
            <span><i class="fa-solid fa-key"></i> ${c.api_key_preview}…</span>
            <span><i class="fa-solid fa-dollar-sign"></i> $${c.precio_input}/$${c.precio_output} /1M</span>
            ${c.notas ? `<span><i class="fa-solid fa-note-sticky"></i> ${c.notas}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          ${!c.activa ? `<button class="btn btn-sm" style="background:var(--accent-purple,#a855f7);color:#fff;padding:5px 10px;" onclick="setIACredActiva(${c.id})" title="Marcar como activa"><i class="fa-solid fa-check"></i></button>` : ''}
          <button class="btn btn-secondary btn-sm" style="padding:5px 10px;" onclick="openModalEditIACred(${c.id})" title="Editar"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-sm" style="background:var(--bg-tertiary);color:var(--accent-red,#ef4444);border:1px solid var(--border-color);padding:5px 10px;" onclick="deleteIACred(${c.id},'${c.nombre}')" title="Eliminar"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`).join('');
  } catch (e) { console.error('loadIaCredenciales:', e); }
}

function openModalNuevaCredIA() {
  document.getElementById('iac-id').value = '';
  document.getElementById('iac-nombre').value = '';
  document.getElementById('iac-apikey').value = '';
  document.getElementById('iac-modelo').value = 'claude-sonnet-4-6';
  document.getElementById('iac-proveedor').value = 'anthropic';
  document.getElementById('iac-precio-in').value = '3';
  document.getElementById('iac-precio-out').value = '15';
  document.getElementById('iac-notas').value = '';
  document.getElementById('iac-activa').checked = false;
  document.getElementById('modal-ia-cred-title').innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Nueva Credencial IA';
  openModal('modal-ia-cred');
}

async function openModalEditIACred(id) {
  try {
    const res = await fetch('/api/ia/credenciales');
    const list = await res.json();
    const c = list.find(x => x.id === id);
    if (!c) return;
    document.getElementById('iac-id').value = c.id;
    document.getElementById('iac-nombre').value = c.nombre;
    document.getElementById('iac-apikey').value = '';
    document.getElementById('iac-apikey').placeholder = c.api_key_preview + '… (dejá vacío para no cambiar)';
    document.getElementById('iac-modelo').value = c.modelo;
    document.getElementById('iac-proveedor').value = c.proveedor;
    document.getElementById('iac-precio-in').value = c.precio_input;
    document.getElementById('iac-precio-out').value = c.precio_output;
    document.getElementById('iac-notas').value = c.notas || '';
    document.getElementById('iac-activa').checked = !!c.activa;
    document.getElementById('modal-ia-cred-title').innerHTML = '<i class="fa-solid fa-pen"></i> Editar Credencial IA';
    openModal('modal-ia-cred');
  } catch (e) { showAlert('Error al cargar credencial: ' + e.message); }
}

async function saveIACred(e) {
  e.preventDefault();
  const id = document.getElementById('iac-id').value;
  const body = {
    nombre:        document.getElementById('iac-nombre').value.trim(),
    proveedor:     document.getElementById('iac-proveedor').value,
    api_key:       document.getElementById('iac-apikey').value.trim(),
    modelo:        document.getElementById('iac-modelo').value.trim() || 'claude-sonnet-4-6',
    precio_input:  parseFloat(document.getElementById('iac-precio-in').value) || 3,
    precio_output: parseFloat(document.getElementById('iac-precio-out').value) || 15,
    notas:         document.getElementById('iac-notas').value.trim(),
    activa:        document.getElementById('iac-activa').checked ? 1 : 0,
  };
  if (!body.nombre) { showAlert('El nombre es obligatorio', 'warning'); return; }
  if (!id && !body.api_key) { showAlert('La API Key es obligatoria para una credencial nueva', 'warning'); return; }
  try {
    const res = await fetch(id ? `/api/ia/credenciales/${id}` : '/api/ia/credenciales', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) { const d = await res.json(); showAlert(d.message || 'Error', 'error'); return; }
    showToast('Credencial guardada', 'success');
    closeModal('modal-ia-cred');
    loadIaCredenciales();
    checkAiStatus();
  } catch (err) { showAlert('Error: ' + err.message); }
}

async function setIACredActiva(id) {
  try {
    const res = await fetch(`/api/ia/credenciales/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activa: 1 })
    });
    if (!res.ok) { const d = await res.json(); showAlert(d.message, 'error'); return; }
    showToast('Credencial marcada como activa', 'success');
    loadIaCredenciales();
    checkAiStatus();
  } catch (e) { showAlert('Error: ' + e.message); }
}

async function deleteIACred(id, nombre) {
  if (!await showConfirm(`¿Eliminar credencial "${nombre}"?`)) return;
  try {
    const res = await fetch(`/api/ia/credenciales/${id}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json(); showAlert(d.message, 'error'); return; }
    showToast('Credencial eliminada', 'success');
    loadIaCredenciales();
    checkAiStatus();
  } catch (e) { showAlert('Error: ' + e.message); }
}

// ── Consumo IA ────────────────────────────────────────────────────────────────
let _iaLogRows = [];

async function loadIaLog() {
  const now = new Date();
  const desde = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  try {
    const res = await fetch('/api/ia/log?' + new URLSearchParams({ limit: 500, desde }));
    if (!res.ok) return;
    const { totals } = await res.json();
    const costo = (+totals?.total_costo||0);
    const fmt = n => (n||0).toLocaleString('es-AR');
    const el = id => document.getElementById(id);
    if (el('ia-resumen-costo'))      el('ia-resumen-costo').textContent      = `$${costo.toFixed(4)} USD`;
    if (el('ia-resumen-llamadas'))   el('ia-resumen-llamadas').textContent   = fmt(totals?.total);
    if (el('ia-resumen-tokens-in'))  el('ia-resumen-tokens-in').textContent  = fmt(totals?.total_input);
    if (el('ia-resumen-tokens-out')) el('ia-resumen-tokens-out').textContent = fmt(totals?.total_output);
  } catch(e) {}
}

async function openIaLogModal() {
  const now = new Date();
  const y = now.getFullYear(), m = String(now.getMonth()+1).padStart(2,'0'), d = String(now.getDate()).padStart(2,'0');
  const desdeEl = document.getElementById('ia-modal-desde');
  const hastaEl = document.getElementById('ia-modal-hasta');
  if (desdeEl && !desdeEl.value) desdeEl.value = `${y}-${m}-01`;
  if (hastaEl && !hastaEl.value) hastaEl.value = `${y}-${m}-${d}`;
  openModal('modal-ia-log');
  await loadIaLogModal();
}

async function loadIaLogModal() {
  const desde = document.getElementById('ia-modal-desde')?.value || '';
  const hasta  = document.getElementById('ia-modal-hasta')?.value  || '';
  const tarea  = document.getElementById('ia-modal-tarea')?.value  || '';
  const params = new URLSearchParams({ limit: 500 });
  if (desde) params.set('desde', desde);
  if (hasta)  params.set('hasta', hasta);
  const tbody = document.getElementById('ia-modal-body');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-secondary);">Cargando...</td></tr>';
  try {
    const res = await fetch('/api/ia/log?' + params);
    if (!res.ok) return;
    const { rows } = await res.json();
    _iaLogRows = rows;
    // Poblar select de tareas (solo 1ª vez)
    const tareaEl = document.getElementById('ia-modal-tarea');
    if (tareaEl && tareaEl.options.length <= 1) {
      [...new Set(rows.map(r => r.tarea).filter(Boolean))].sort().forEach(t => {
        const o = document.createElement('option'); o.value = t;
        o.textContent = _TAREA_LABELS[t] || t; tareaEl.appendChild(o);
      });
    }
    const filtered = tarea ? rows.filter(r => r.tarea === tarea) : rows;
    // KPIs
    const kpiEl = document.getElementById('ia-modal-kpis');
    if (kpiEl) {
      const tot = filtered.reduce((a,r) => { a.c++; a.ti+=r.input_tokens||0; a.to+=r.output_tokens||0; a.co+=(+r.costo_usd||0); return a; }, {c:0,ti:0,to:0,co:0});
      const kpi = (icon,color,val,label) => `<div style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:10px;"><i class="fa-solid ${icon}" style="font-size:20px;color:${color};"></i><div><div style="font-size:18px;font-weight:700;">${val}</div><div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-secondary);">${label}</div></div></div>`;
      kpiEl.innerHTML =
        kpi('fa-bolt','var(--accent-blue)',tot.c.toLocaleString('es-AR'),'Llamadas') +
        kpi('fa-arrow-right-to-bracket','var(--color-success)',tot.ti.toLocaleString('es-AR'),'Tokens In') +
        kpi('fa-arrow-right-from-bracket','var(--accent-orange)',tot.to.toLocaleString('es-AR'),'Tokens Out') +
        kpi('fa-dollar-sign','var(--accent-purple,#a855f7)','$'+tot.co.toFixed(4)+' USD','Costo total');
    }
    // Tabla
    if (tbody) {
      const _fmtIaFecha = iso => {
        const d = new Date(String(iso).replace(' ','T'));
        if (isNaN(d)) return iso || '–';
        const p = n => String(n).padStart(2,'0');
        return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
      };
      tbody.innerHTML = !filtered.length
        ? '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-secondary);">Sin registros para el período</td></tr>'
        : filtered.map(r => {
          const tareaLabel = _TAREA_LABELS[r.tarea] || r.tarea || '–';
          const moduloBadge = r.modulo ? `<span style="font-size:10px;background:var(--bg-card);border:1px solid var(--border-color);border-radius:4px;padding:1px 5px;margin-left:4px;color:var(--text-secondary);">${r.modulo}</span>` : '';
          const idBadge = r.entidad_id ? `<span style="font-size:10px;color:var(--accent-blue);margin-left:3px;">#${r.entidad_id}</span>` : '';
          return `<tr>
            <td style="white-space:nowrap;font-family:monospace;font-size:12px;">${_fmtIaFecha(r.fecha)}</td>
            <td>${tareaLabel}${moduloBadge}${idBadge}</td>
            <td style="font-size:11px;color:var(--text-secondary);">${r.modelo||'–'}</td>
            <td style="font-size:11px;">${r.credencial_nombre||'<span style="opacity:.5">fallback env</span>'}</td>
            <td style="text-align:right;">${(r.input_tokens||0).toLocaleString('es-AR')}</td>
            <td style="text-align:right;">${(r.output_tokens||0).toLocaleString('es-AR')}</td>
            <td style="text-align:right;font-family:monospace;font-weight:600;color:var(--accent-purple,#a855f7);">$${(+r.costo_usd||0).toFixed(5)}</td>
          </tr>`;
        }).join('');
    }
    loadIaLog();
  } catch(e) { console.error('loadIaLogModal:', e); }
}

function exportIaLogXLS() {
  const tarea = document.getElementById('ia-modal-tarea')?.value || '';
  const rows = tarea ? _iaLogRows.filter(r => r.tarea === tarea) : _iaLogRows;
  if (!rows.length) { showToast('Sin datos para exportar'); return; }
  const ws = [['Fecha','Tarea','Modelo','Credencial','Tokens In','Tokens Out','Costo USD'],
    ...rows.map(r => [new Date(String(r.fecha).replace(' ','T')).toLocaleString('es-AR'), _TAREA_LABELS[r.tarea]||r.tarea, r.modelo||'', r.credencial_nombre||'fallback env', r.input_tokens||0, r.output_tokens||0, (+r.costo_usd||0).toFixed(5)])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ws), 'Consumo IA');
  XLSX.writeFile(wb, `consumo-ia-${new Date().toISOString().substring(0,10)}.xlsx`);
}

function exportIaLogWA() {
  const tarea = document.getElementById('ia-modal-tarea')?.value || '';
  const rows = (tarea ? _iaLogRows.filter(r => r.tarea === tarea) : _iaLogRows).slice(0,30);
  let tbl = document.getElementById('_ia-log-wa-table');
  if (!tbl) { tbl = document.createElement('table'); tbl.id = '_ia-log-wa-table'; tbl.style.display='none'; document.body.appendChild(tbl); }
  tbl.innerHTML = `<thead><tr><th>Fecha</th><th>Tarea</th><th>Tokens In</th><th>Tokens Out</th><th>Costo USD</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${new Date(String(r.fecha).replace(' ','T')).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</td><td>${_TAREA_LABELS[r.tarea]||r.tarea}</td><td>${(r.input_tokens||0).toLocaleString('es-AR')}</td><td>${(r.output_tokens||0).toLocaleString('es-AR')}</td><td>$${(+r.costo_usd||0).toFixed(5)}</td></tr>`).join('')}</tbody>`;
  openWhatsAppModal('_ia-log-wa-table', 'Consumo IA — FlotaControl');
}

async function loadCredenciales() {
  try {
    const res = await fetch('/api/config/credenciales');
    if (!res.ok) { showToast('Sin acceso a credenciales', 'error'); return; }
    const list = await res.json();
    const container = document.getElementById('cred-list');
    if (!container) return;
    container.innerHTML = '';
    list.forEach(c => {
      const meta = _credLabels[c.clave] || { label: c.clave, icon: '🔑', placeholder: '' };
      const row = document.createElement('div');
      row.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;padding:14px 16px;';
      row.innerHTML = `
        <label style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;margin-bottom:8px;">
          <span style="font-size:16px;">${meta.icon}</span> ${meta.label}
          ${c.tieneValor ? '<span style="background:var(--accent-green,#22c55e);color:#fff;font-size:10px;padding:2px 7px;border-radius:20px;font-weight:500;">ACTIVA</span>' : '<span style="background:var(--bg-tertiary);color:var(--text-secondary);font-size:10px;padding:2px 7px;border-radius:20px;">Sin configurar</span>'}
        </label>
        ${c.descripcion ? `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px;">${c.descripcion}</div>` : ''}
        ${meta.note ? `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px;font-style:italic;opacity:.7;"><i class="fa-solid fa-circle-info" style="color:var(--accent-blue);margin-right:4px;"></i>${meta.note}</div>` : ''}
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="password" data-clave="${c.clave}"
            class="form-control" style="font-family:monospace;font-size:13px;flex:1;"
            placeholder="${c.tieneValor ? c.preview + ' — dejá vacío para no cambiar' : (meta.placeholder || 'Ingresar valor...')}"
            autocomplete="new-password">
          <button type="button" class="btn btn-secondary btn-sm" style="padding:6px 10px;"
            onclick="this.previousElementSibling.type = this.previousElementSibling.type==='password'?'text':'password'; this.innerHTML = this.previousElementSibling.type==='password'?'<i class=\\'fa-solid fa-eye\\'></i>':'<i class=\\'fa-solid fa-eye-slash\\'></i>'">
            <i class="fa-solid fa-eye"></i>
          </button>
          ${c.tieneValor ? `<button type="button" class="btn btn-sm" style="padding:6px 10px;background:var(--bg-tertiary);color:var(--accent-red,#ef4444);border:1px solid var(--border-color);" onclick="clearCredencial('${c.clave}',this)" title="Borrar credencial"><i class="fa-solid fa-trash"></i></button>` : ''}
        </div>`;
      container.appendChild(row);
    });
  } catch (e) { showToast('Error al cargar credenciales: ' + e.message, 'error'); }
}

async function clearCredencial(clave, btn) {
  const ok = await showConfirm(`¿Borrar la credencial "${clave}"?`);
  if (!ok) return;
  try {
    const res = await fetch('/api/config/credenciales', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credenciales: [{ clave, valor: '' }] })
    });
    if (res.ok) { showToast('Credencial eliminada', 'success'); loadCredenciales(); checkAiStatus(); }
    else { const e = await res.json(); showToast(e.message, 'error'); }
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function saveCredenciales(e) {
  e.preventDefault();
  const inputs = document.querySelectorAll('#cred-list input[data-clave]');
  const credenciales = [];
  inputs.forEach(inp => {
    if (inp.value.trim()) credenciales.push({ clave: inp.dataset.clave, valor: inp.value.trim() });
  });
  if (!credenciales.length) { showToast('No hay cambios para guardar', 'info'); return; }
  try {
    const res = await fetch('/api/config/credenciales', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credenciales })
    });
    const d = await res.json();
    if (res.ok) {
      showToast('Credenciales guardadas correctamente', 'success');
      loadCredenciales();
      checkAiStatus(); // re-verificar disponibilidad de IA
    } else { showToast(d.message || 'Error al guardar', 'error'); }
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
}

// ──────────────────────────────────────────────────────────────
// BOOT — verificar sesión y arrancar
// ──────────────────────────────────────────────────────────────
function bootApp() {
  _loadUIPrefs();
  initNewDropzones();
  initChoferDropzones();
  loadAseguradorasCache();
  loadAlertasWidget();
  checkAIAvailability();
  initApp();

  const segInput = document.getElementById('seg-compania-input');
  if (segInput) segInput.addEventListener('focus', () => filterAseguradoras(segInput.value));
}

document.addEventListener('DOMContentLoaded', async () => {
  _loadUIPrefs();
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const user = await res.json();
      _currentUser = user;
      document.getElementById('login-screen').classList.add('hidden');
      applyUserSession(user);
      bootApp();
    }
  } catch (e) {}

  // Login con Enter
  document.getElementById('login-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-password')?.focus(); });
  document.getElementById('login-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
});

// ── Auditoría ────────────────────────────────────────────────────────────────
const _ACCION_COLORS = { login:'#4a9eff', crear:'var(--color-success)', editar:'var(--accent-orange)', eliminar:'var(--color-error)', desactivar:'#e08d2f', activar:'var(--color-success)' };

async function _loadAuditoriaUsuarios() {
  const sel = document.getElementById('aud-filtro-usuario');
  if (!sel || sel.options.length > 1) return; // ya poblado
  try {
    const res = await fetch('/api/usuarios');
    const users = await res.json();
    users.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.nombre || u.alias;
      sel.appendChild(opt);
    });
  } catch(_) {}
}

async function loadAuditoria() {
  const tbody = document.getElementById('auditoria-tbody');
  if (!tbody) return;
  _loadAuditoriaUsuarios();
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Cargando...</td></tr>';
  try {
    const params = new URLSearchParams();
    const mod  = document.getElementById('aud-filtro-modulo')?.value;
    const acc  = document.getElementById('aud-filtro-accion')?.value;
    const uid  = document.getElementById('aud-filtro-usuario')?.value;
    const des  = document.getElementById('aud-filtro-desde')?.value;
    const has  = document.getElementById('aud-filtro-hasta')?.value;
    if (mod)  params.set('modulo', mod);
    if (acc)  params.set('accion', acc);
    if (uid)  params.set('usuario_id', uid);
    if (des)  params.set('desde', des);
    if (has)  params.set('hasta', has);
    params.set('limit', 500);
    const res = await fetch('/api/auditoria?' + params.toString());
    const rows = await res.json();
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--placeholder-color);">Sin registros</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r, i) => {
      const color = _ACCION_COLORS[r.accion] || 'var(--text-secondary)';
      const fecha = new Date(r.fecha).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });
      return `<tr class="${i%2===1?'row-alt':''}">
        <td style="white-space:nowrap;font-size:12px;">${fecha}</td>
        <td>${r.usuario_nombre || '<em style="color:var(--placeholder-color)">sistema</em>'}</td>
        <td style="text-transform:capitalize;">${r.modulo}</td>
        <td><span style="color:${color};font-weight:600;text-transform:capitalize;">${r.accion}</span></td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${r.descripcion||''}">${r.descripcion||'-'}</td>
        <td style="font-size:11px;color:var(--text-secondary);">${r.ip||'-'}</td>
      </tr>`;
    }).join('');
    injectExportBar('table-auditoria', 'Auditoría');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--color-error);text-align:center;">Error: ${err.message}</td></tr>`;
  }
}

function clearAuditoriaFiltros() {
  ['aud-filtro-desde','aud-filtro-hasta'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  ['aud-filtro-modulo','aud-filtro-accion','aud-filtro-usuario'].forEach(id => _clearSelect(id));
  loadAuditoria();
}

function exportarAuditoria() {
  const params = new URLSearchParams();
  const mod = document.getElementById('aud-filtro-modulo')?.value;
  const acc = document.getElementById('aud-filtro-accion')?.value;
  const uid = document.getElementById('aud-filtro-usuario')?.value;
  const des = document.getElementById('aud-filtro-desde')?.value;
  const has = document.getElementById('aud-filtro-hasta')?.value;
  if (mod) params.set('modulo', mod);
  if (acc) params.set('accion', acc);
  if (uid) params.set('usuario_id', uid);
  if (des) params.set('desde', des);
  if (has) params.set('hasta', has);
  params.set('limit', 9999);
  window.open('/api/auditoria?' + params.toString(), '_blank');
}

// Cargar usuarios cuando se navega a esa pestaña
const _origNavigateTo = typeof navigateTo === 'function' ? navigateTo : null;

// ── Bot WhatsApp: estado + QR ─────────────────────────────────────────────────
function _updateBotStatusUI(online) {
  const el    = document.getElementById('bot-status');
  const label = document.getElementById('bot-status-label');
  if (!el) return;
  if (online) {
    el.className = 'bot-status-indicator online';
    if (label) label.textContent = 'Bot WhatsApp: Conectado';
  } else {
    el.className = 'bot-status-indicator offline';
    if (label) label.textContent = 'Bot WhatsApp: Desconectado';
  }
}

async function pollBotStatus() {
  try {
    const d = await fetch('/api/bot-status').then(r => r.json());
    _updateBotStatusUI(d.online);
  } catch(_) {}
}

// Polling cada 15s
pollBotStatus();
setInterval(pollBotStatus, 15000);

let _waQrCurrentSid = 'default'; // sesión activa en el modal

function waReconectarDesdeModal() {
  // Abre el modal de QR/estado sin cerrar el modal de envío
  openWAStatusModal();
}

async function openWAStatusModal() {
  _waQrCurrentSid = 'default';
  document.querySelector('#modal-wa-qr .modal-header h2').innerHTML =
    '<i class="fa-brands fa-whatsapp" style="color:#25d366;"></i> Bot WhatsApp';
  openModal('modal-wa-qr');
  await loadWAQR('default');
}

async function openChoferWAQr(sid, label) {
  _waQrCurrentSid = sid;
  document.querySelector('#modal-wa-qr .modal-header h2').innerHTML =
    `<i class="fa-brands fa-whatsapp" style="color:#25d366;"></i> WhatsApp — ${label}`;
  // Iniciar sesión en el servidor si no existe
  await fetch(`/api/whatsapp/connect/${encodeURIComponent(sid)}`, { method: 'POST' });
  openModal('modal-wa-qr');
  await loadWAQR(sid);
}

async function disconnectChoferWA() {
  const sid = _waQrCurrentSid || 'default';
  const label = sid === 'default' ? 'el bot principal' : `la sesión "${sid}"`;
  const ok = await showConfirm(`¿Desconectar ${label}? Podrás reconectar escaneando el QR.`);
  if (!ok) return;
  const endpoint = sid === 'default'
    ? '/api/bot-disconnect'
    : `/api/whatsapp/disconnect/${encodeURIComponent(sid)}`;
  const body = document.getElementById('wa-qr-body');
  if (body) body.innerHTML = `<div style="padding:20px 0;"><span class="spinner"></span><p style="margin-top:12px;color:var(--text-secondary);">Desconectando...</p></div>`;
  const r = await fetch(endpoint, { method: 'DELETE' }).catch(() => null);
  if (r?.ok) {
    if (sid === 'default') _updateBotStatusUI(false);
    const disconnectBtn = document.getElementById('wa-qr-disconnect-btn');
    if (disconnectBtn) disconnectBtn.style.display = 'none';
    if (body) body.innerHTML = `
      <div style="text-align:center;">
        <i class="fa-brands fa-whatsapp" style="font-size:3rem;color:var(--text-secondary);opacity:.4;"></i>
        <p style="margin-top:12px;font-size:15px;font-weight:600;color:var(--text-primary);">Desconectado</p>
        <p style="color:var(--text-secondary);font-size:13px;margin-top:4px;">El bot está offline.</p>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:18px;flex-wrap:wrap;">
          <button type="button" class="btn btn-secondary" onclick="reconnectWA('${sid}')">
            <i class="fa-solid fa-rotate-right"></i> Reconectar
          </button>
          <button type="button" class="btn btn-primary" onclick="reconnectWANewQR('${sid}')">
            <i class="fa-brands fa-whatsapp"></i> Conectar con QR
          </button>
        </div>
      </div>`;
  }
}

async function reconnectWA(sid) {
  sid = sid || _waQrCurrentSid || 'default';
  const endpoint = sid === 'default' ? '/api/bot-reconnect' : `/api/whatsapp/connect/${encodeURIComponent(sid)}`;
  await fetch(endpoint, { method: 'POST' }).catch(() => null);
  await loadWAQR(sid);
}

async function reconnectWANewQR(sid) {
  sid = sid || _waQrCurrentSid || 'default';
  // Fuerza QR nuevo: borra la sesión guardada y reinicia
  await fetch('/api/bot-reconnect?clearAuth=1', { method: 'POST' }).catch(() => null);
  await loadWAQR(sid);
}

let _waQrPollIv = null;

function _stopWaQrPoll() { if (_waQrPollIv) { clearInterval(_waQrPollIv); _waQrPollIv = null; } }

let _waQrCountdownIv = null;
function _stopWaQrCountdown() { if (_waQrCountdownIv) { clearInterval(_waQrCountdownIv); _waQrCountdownIv = null; } }

function _setWaButtons(state) {
  const disconnectBtn = document.getElementById('wa-qr-disconnect-btn');
  const refreshBtn    = document.getElementById('wa-qr-refresh-btn');
  const countdown     = document.getElementById('wa-qr-countdown');
  _stopWaQrCountdown();
  if (disconnectBtn) disconnectBtn.style.display = state === 'connected' ? '' : 'none';
  if (refreshBtn)    refreshBtn.style.display    = state === 'qr'        ? '' : 'none';
  if (countdown)     countdown.textContent       = '';
  if (state === 'qr') {
    let secs = 60;
    if (countdown) countdown.textContent = `(${secs}s)`;
    _waQrCountdownIv = setInterval(() => {
      secs--;
      if (countdown) countdown.textContent = secs > 0 ? `(${secs}s)` : '';
      if (secs <= 0) _stopWaQrCountdown();
    }, 1000);
  }
}

async function loadWAQR(sid) {
  sid = sid || _waQrCurrentSid || 'default';
  _waQrCurrentSid = sid;
  _stopWaQrPoll();
  const body = document.getElementById('wa-qr-body');
  if (!body) return;
  _setWaButtons('loading');

  const qrEndpoint     = sid === 'default' ? '/api/whatsapp/qr' : `/api/whatsapp/qr/${encodeURIComponent(sid)}`;
  const statusEndpoint = sid === 'default' ? '/api/bot-status'  : `/api/whatsapp/status/${encodeURIComponent(sid)}`;

  const renderState = async () => {
    try {
      const d = await fetch(qrEndpoint).then(r => r.json());
      if (d.connected) {
        _stopWaQrPoll();
        _setWaButtons('connected');
        if (sid === 'default') _updateBotStatusUI(true);
        body.innerHTML = `
          <div style="padding:20px 0;">
            <i class="fa-brands fa-whatsapp" style="font-size:3.5rem;color:#25d366;"></i>
            <p style="margin-top:14px;font-size:16px;font-weight:700;color:var(--text-primary);">¡Conectado!</p>
            <p style="color:var(--text-secondary);font-size:13px;margin-top:6px;">${sid === 'default' ? 'El bot está activo y listo para enviar mensajes.' : 'Esta sesión de WhatsApp está activa.'}</p>
            <p style="margin-top:12px;font-size:12px;color:var(--text-secondary);">Para cambiar de cuenta, primero <strong>Desconectá</strong> y luego escaneá el nuevo QR.</p>
          </div>`;
        return 'connected';
      } else if (d.qr) {
        _stopWaQrPoll();
        _setWaButtons('qr');
        body.innerHTML = `
          <div style="padding:8px 0;">
            <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">Escaneá este QR desde <strong>WhatsApp → Dispositivos vinculados</strong></p>
            <img src="${d.qr}" style="width:250px;height:250px;border-radius:10px;border:2px solid var(--border-color);box-shadow:0 2px 12px rgba(0,0,0,.12);">
            <p style="font-size:11px;color:var(--text-secondary);margin-top:10px;">El QR expira en ~60 seg. Si venció, usá <strong>Actualizar QR</strong>.</p>
          </div>`;
        // Poll hasta que escaneen
        _waQrPollIv = setInterval(async () => {
          try {
            const s = await fetch(statusEndpoint).then(r => r.json());
            if (s.online || s.ready) await renderState();
          } catch(_) {}
        }, 3000);
        return 'qr';
      } else {
        // Iniciando
        _setWaButtons('loading');
        body.innerHTML = `
          <div style="padding:20px 0;">
            <i class="fa-solid fa-spinner fa-spin" style="font-size:2.5rem;color:var(--accent-color);"></i>
            <p style="margin-top:14px;font-size:14px;font-weight:600;color:var(--text-primary);">Iniciando bot...</p>
            <p style="color:var(--text-secondary);font-size:12px;margin-top:6px;">El servidor está conectando con WhatsApp.<br>Esto puede tardar unos segundos.</p>
          </div>`;
        _stopWaQrPoll();
        _waQrPollIv = setInterval(async () => {
          const result = await renderState().catch(() => null);
          if (result === 'connected' || result === 'qr') _stopWaQrPoll();
        }, 4000);
        return 'waiting';
      }
    } catch(err) {
      _setWaButtons('loading');
      const _waFrases = [
        'El servidor salió a tomar mate y olvidó volver.',
        'Parece que el backend se tomó el día.',
        'El bot se fue a escanear un QR en la playa.',
        'Houston, tenemos un problema. Y no es de WhatsApp.',
        'El servidor está en modo "¿Viste que iba a pasar esto?"',
        'Error 404: servidor no encontrado (igual que mis llaves).',
        'El bot está meditando. Interrumpirlo puede traer mala suerte.',
      ];
      const frase = _waFrases[Math.floor(err.message.length * 13 % _waFrases.length)];
      body.innerHTML = `
        <div style="padding:24px 16px;text-align:center;">
          <div style="font-size:2.5rem;margin-bottom:12px;">🤙</div>
          <p style="font-weight:700;font-size:14px;color:var(--text-primary);margin-bottom:6px;">${frase}</p>
          <p style="font-size:12px;color:var(--text-secondary);margin-bottom:16px;">Verificá que el servidor esté corriendo y volvé a intentarlo.</p>
          <button class="btn btn-sm btn-secondary" onclick="loadWAQR(_waQrCurrentSid)" style="font-size:12px;">
            <i class="fa-solid fa-rotate"></i> Reintentar
          </button>
          <details style="margin-top:14px;text-align:left;">
            <summary style="font-size:11px;color:var(--text-secondary);cursor:pointer;">Detalle técnico</summary>
            <code style="font-size:10px;color:var(--accent-red,#e53e3e);display:block;margin-top:6px;word-break:break-all;">${err.message}</code>
          </details>
        </div>`;
      return 'error';
    }
  };

  body.innerHTML = `<div style="padding:20px 0;"><i class="fa-solid fa-spinner fa-spin" style="font-size:2rem;color:var(--accent-color);"></i></div>`;
  await renderState();
}

async function waClearCacheAndRestart() {
  if (!await showConfirm('¿Limpiar caché de WhatsApp y pedir QR nuevo? La sesión actual se cerrará.')) return;
  // Detener poll existente Y fijar UI estática ANTES del fetch para evitar parpadeos
  _stopWaQrPoll();
  const body = document.getElementById('wa-qr-body');
  if (body) body.innerHTML = `
    <div style="padding:28px 16px;text-align:center;">
      <i class="fa-solid fa-spinner fa-spin" style="font-size:2rem;color:var(--accent-color);"></i>
      <p style="margin-top:14px;font-size:14px;font-weight:600;color:var(--text-primary);">Limpiando caché...</p>
      <p style="color:var(--text-secondary);font-size:12px;margin-top:6px;">Esperando QR nuevo. Puede tardar unos segundos.</p>
    </div>`;
  const btn = document.getElementById('wa-qr-clear-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Limpiando...'; }
  try {
    const res = await fetch('/api/bot-reconnect?clearAuth=1', { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).message);
    // Poll silencioso: solo re-renderiza cuando hay QR o está conectado
    _waQrPollIv = setInterval(async () => {
      try {
        const d = await fetch('/api/whatsapp/qr').then(r => r.json());
        if (d.connected || d.qr) { _stopWaQrPoll(); loadWAQR('default'); }
      } catch(_) {}
    }, 3000);
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-broom"></i> Limpiar caché'; }
  }
}

// ── WhatsApp: Broadcast a grupos ─────────────────────────────────────────────

let _waGroups = [];
let _waGroupsLoading = false;

async function openWABroadcast(defaultMsg = '') {
  document.getElementById('broadcast-msg').value = defaultMsg;
  document.getElementById('broadcast-status').textContent = '';
  bcSwitchTab('grupos');
  openModal('modal-wa-broadcast');
  await loadWAGroups();
}

function bcSwitchTab(tab) {
  const tabs = ['grupos', 'recordatorios'];
  tabs.forEach(t => {
    const btn   = document.getElementById(`bc-tab-${t}`);
    const panel = document.getElementById(`bc-panel-${t}`);
    const active = t === tab;
    if (btn) {
      btn.style.color       = active ? '#128c7e' : 'var(--text-secondary)';
      btn.style.borderBottom = active ? '2px solid #128c7e' : '2px solid transparent';
    }
    if (panel) panel.style.display = active ? 'flex' : 'none';
  });
  if (tab === 'recordatorios') {
    recOnTipo();
    loadRecordatorios();
    // Presetear fecha/hora a 1h desde ahora
    const now = new Date(Date.now() + 3600000 - new Date().getTimezoneOffset()*60000);
    const iso  = now.toISOString().substring(0,16);
    const fdt = document.getElementById('rec-datetime'); if (fdt) fdt.value = iso;
  }
}

function _extractPatente(groupName) {
  const parts = groupName.split('_');
  return parts.length >= 3 ? parts[parts.length - 1].trim().toUpperCase() : null;
}

function _waHiddenGroups() {
  try { return JSON.parse(localStorage.getItem('wa_hidden_groups') || '[]'); } catch { return []; }
}
function _waHideGroup(chatId) {
  const hidden = _waHiddenGroups();
  if (!hidden.includes(chatId)) { hidden.push(chatId); localStorage.setItem('wa_hidden_groups', JSON.stringify(hidden)); }
  loadWAGroups();
}
function waBroadcastShowHidden() {
  localStorage.removeItem('wa_hidden_groups');
  loadWAGroups();
}

async function loadWAGroups() {
  if (_waGroupsLoading) return;
  _waGroupsLoading = true;
  const list = document.getElementById('broadcast-groups-list');
  if (list) list.innerHTML = '<span style="color:var(--text-secondary);font-size:13px;padding:8px;"><i class="fa-solid fa-spinner fa-spin"></i> Cargando grupos...</span>';
  try {
    const forceRefresh = _waGroups.length === 0;
    const res = await fetch('/api/whatsapp/groups' + (forceRefresh ? '?refresh=1' : ''));
    if (!res.ok) throw new Error((await res.json()).message);
    _waGroups = await res.json();
    _waGroups.forEach(g => { g.patente = _extractPatente(g.name); });

    // Filtrar grupos sin nombre (evita error localeCompare)
    _waGroups = _waGroups.filter(g => g && g.name);

    const hidden = _waHiddenGroups();
    const visible = _waGroups.filter(g => !hidden.includes(g.id));
    const visibleFiltered = visible; // ya filtrados arriba

    // Mostrar botón de restaurar ocultos si hay alguno
    const restBtn = document.getElementById('broadcast-show-hidden-btn');
    if (restBtn) restBtn.style.display = hidden.length ? '' : 'none';

    if (!visibleFiltered.length) {
      list.innerHTML = '<span style="color:var(--text-secondary);font-size:13px;padding:8px;">No hay grupos disponibles</span>';
      return;
    }

    list.innerHTML = visibleFiltered.map((g, i) => {
      const globalIdx = _waGroups.indexOf(g);
      const isFlota = !!g.patente;
      return `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;transition:background .15s;" onmouseover="this.style.background='var(--hover-bg)'" onmouseout="this.style.background=''">
        <input type="checkbox" data-idx="${globalIdx}" ${isFlota ? 'checked' : ''} style="accent-color:#25d366;width:15px;height:15px;flex-shrink:0;cursor:pointer;">
        <label style="flex:1;font-size:13px;font-weight:${isFlota?'600':'400'};cursor:pointer;margin:0;" onclick="this.previousElementSibling.click()">${g.name}</label>
        ${g.patente ? `<span style="font-family:monospace;font-size:11px;font-weight:700;color:#25d366;background:rgba(37,211,102,.12);padding:2px 6px;border-radius:4px;">${g.patente}</span>` : ''}
        <span style="font-size:11px;color:var(--text-secondary);white-space:nowrap;">${g.participants} miembros</span>
        <button onclick="waBroadcastHideGroup('${g.id}')" title="Ocultar de la lista" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);padding:2px 4px;opacity:.5;font-size:13px;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.5">
          <i class="fa-solid fa-eye-slash"></i>
        </button>
      </div>`;
    }).join('');
  } catch(e) {
    if (list) list.innerHTML = `<span style="color:var(--color-error);font-size:13px;padding:8px;">${e.message} <button onclick="loadWAGroups()" style="border:none;background:none;color:#128c7e;cursor:pointer;font-size:12px;text-decoration:underline;">Reintentar</button></span>`;
  } finally {
    _waGroupsLoading = false;
  }
}

function waBroadcastHideGroup(chatId) {
  _waHideGroup(chatId);
}

// ── Recordatorios ────────────────────────────────────────────────────────────

let _recChoferes = [];

async function recOnTipo() {
  const tipo  = document.querySelector('input[name="rec-tipo"]:checked')?.value || 'grupos';
  const wrap  = document.getElementById('rec-dest-wrap');
  if (!wrap) return;

  // Estilos de labels
  ['grupos','choferes'].forEach(t => {
    const lbl = document.getElementById(`rec-tipo-label-${t}`);
    if (lbl) lbl.style.borderColor = t === tipo ? '#128c7e' : 'var(--border-color)';
  });

  const itemStyle = `display:flex;align-items:center;gap:7px;padding:5px 7px;border-radius:6px;cursor:pointer;font-size:12px;overflow:hidden;`;

  if (tipo === 'grupos') {
    if (!_waGroups.length) {
      wrap.innerHTML = '<span style="font-size:12px;color:var(--text-secondary);padding:4px;">Cargando grupos...</span>';
      await loadWAGroups();
    }
    const hidden = _waHiddenGroups();
    const items  = _waGroups.filter(g => !hidden.includes(g.id));
    wrap.innerHTML = items.length
      ? items.map(g => `
          <label style="${itemStyle}" onmouseover="this.style.background='var(--hover-bg)'" onmouseout="this.style.background=''">
            <input type="checkbox" data-rec-chatid="${g.id}" data-rec-label="${(g.name||'').replace(/"/g,'')}" data-rec-patente="${g.patente||''}" ${g.patente ? 'checked' : ''} style="accent-color:#128c7e;width:13px;height:13px;flex-shrink:0;">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${g.name||''}">${g.name||''}</span>
          </label>`).join('')
      : `<span style="font-size:12px;color:var(--text-secondary);padding:4px;">Sin grupos.
          ${hidden.length ? `<button onclick="localStorage.removeItem('wa_hidden_groups');recOnTipo()" style="border:none;background:none;color:#128c7e;cursor:pointer;font-size:12px;padding:0 4px;text-decoration:underline;"><i class='fa-solid fa-eye'></i> Restaurar ocultos</button>` : ''}
          <button onclick="recOnTipo()" style="border:none;background:none;color:#128c7e;cursor:pointer;font-size:12px;padding:0;text-decoration:underline;">Reintentar</button>
        </span>`;
  } else {
    try {
      if (!_recChoferes.length) {
        const r = await fetch('/api/choferes');
        _recChoferes = await r.json();
      }
      wrap.innerHTML = _recChoferes.filter(c => c.telefono).map(c => `
        <label style="${itemStyle}" onmouseover="this.style.background='var(--hover-bg)'" onmouseout="this.style.background=''">
          <input type="checkbox" data-rec-chatid="549${c.telefono}@c.us" data-rec-label="${(c.nombre||'').replace(/"/g,'')}" data-rec-patente="" checked style="accent-color:#128c7e;width:13px;height:13px;flex-shrink:0;">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.nombre||''}</span>
        </label>`).join('') ||
        '<span style="font-size:12px;color:var(--text-secondary);padding:4px;grid-column:1/-1;">No hay choferes con teléfono cargado.</span>';
    } catch(e) {
      wrap.innerHTML = `<span style="font-size:12px;color:var(--color-error);padding:4px;grid-column:1/-1;">Error al cargar choferes</span>`;
    }
  }
}

async function guardarRecordatorio(editId) {
  const mensaje = document.getElementById('rec-mensaje').value.trim();
  const dt = document.getElementById('rec-datetime').value;
  if (!mensaje) { showToast('Escribí un mensaje', 'warning'); return; }
  if (!dt) { showToast('Elegí fecha y hora', 'warning'); return; }

  const dests = [...document.querySelectorAll('#rec-dest-wrap input[type=checkbox]:checked')]
    .map(cb => ({ chatId: cb.dataset.recChatid, label: cb.dataset.recLabel, patente: cb.dataset.recPatente || null }));
  if (!dests.length) { showToast('Seleccioná al menos un destinatario', 'warning'); return; }

  const tipo       = document.querySelector('input[name="rec-tipo"]:checked')?.value || 'grupos';
  const repeticion = document.getElementById('rec-repeticion')?.value || 'none';
  const fecha_hora = dt.replace('T', ' ') + ':00';
  const isEdit     = !!editId;

  try {
    const res = await fetch(isEdit ? `/api/wa/programados/${editId}` : '/api/wa/programados', {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensaje, destinatarios_tipo: tipo, destinatarios: dests, fecha_hora, repeticion })
    });
    if (!res.ok) throw new Error((await res.json()).message);
    showToast(isEdit ? '✓ Recordatorio actualizado' : '✓ Recordatorio programado', 'success');
    document.getElementById('rec-mensaje').value = '';
    // Restaurar botón a modo "Programar"
    const btn = document.getElementById('rec-programar-btn');
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Programar'; btn.onclick = () => guardarRecordatorio(); }
    loadRecordatorios();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

async function loadRecordatorios() {
  const lista = document.getElementById('rec-lista');
  if (!lista) return;
  try {
    const res  = await fetch('/api/wa/programados');
    const rows = await res.json();
    if (!rows.length) {
      lista.innerHTML = '<span style="font-size:12px;color:var(--text-secondary);">No hay mensajes programados.</span>';
      return;
    }
    const estadoBadge = {
      pendiente: 'background:#fef3c7;color:#92400e;',
      enviado:   'background:#d1fae5;color:#065f46;',
      error:     'background:#fee2e2;color:#991b1b;',
    };
    const repLabel = { none:'Sin repetir', daily:'Diaria', weekly:'Semanal', monthly:'Mensual' };
    // Guardar rows para editarRecordatorio()
    window._recProgramados = rows;
    lista.innerHTML = rows.map(r => {
      const dests  = typeof r.destinatarios === 'string' ? JSON.parse(r.destinatarios) : r.destinatarios;
      const fh     = r.fecha_hora ? new Date(r.fecha_hora).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) : '-';
      const eStyle = estadoBadge[r.estado] || estadoBadge.pendiente;
      const rep    = r.repeticion && r.repeticion !== 'none'
        ? `<span style="font-size:11px;color:#7c3aed;background:rgba(124,58,237,.1);padding:2px 7px;border-radius:10px;"><i class="fa-solid fa-rotate"></i> ${repLabel[r.repeticion]||r.repeticion}</span>` : '';
      const destNames = dests.map(d => d.label || d.chatId).join(', ');
      return `
        <div id="rec-card-${r.id}" style="border:1px solid var(--border-color);border-radius:8px;overflow:hidden;">
          <!-- Cabecera clickeable -->
          <div onclick="recToggleCard(${r.id})" style="padding:10px 12px;display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;">
            <i id="rec-chevron-${r.id}" class="fa-solid fa-chevron-right" style="font-size:11px;color:var(--text-secondary);transition:transform .2s;flex-shrink:0;"></i>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.mensaje.substring(0,70)}${r.mensaje.length>70?'…':''}</div>
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:3px;">
                <span style="font-size:11px;padding:1px 7px;border-radius:10px;font-weight:700;${eStyle}">${r.estado}</span>
                <span style="font-size:11px;color:var(--text-secondary);"><i class="fa-solid fa-clock"></i> ${fh}</span>
                <span style="font-size:11px;color:var(--text-secondary);"><i class="fa-solid fa-users"></i> ${dests.length}</span>
                ${rep}
              </div>
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0;" onclick="event.stopPropagation()">
              <button onclick="editarRecordatorio(${r.id})" title="Editar" style="background:none;border:none;cursor:pointer;color:var(--accent-color);font-size:13px;padding:3px 5px;border-radius:5px;"><i class="fa-solid fa-pen"></i></button>
              <button onclick="eliminarRecordatorio(${r.id})" title="Eliminar" style="background:none;border:none;cursor:pointer;color:var(--color-error);font-size:13px;padding:3px 5px;border-radius:5px;"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>
          <!-- Panel expandido -->
          <div id="rec-detail-${r.id}" style="display:none;border-top:1px solid var(--border-color);padding:10px 12px;display:none;flex-direction:column;gap:8px;background:var(--bg-secondary);">
            <div>
              <div style="font-size:10px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Mensaje completo</div>
              <div style="font-size:13px;white-space:pre-wrap;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:6px;padding:8px 10px;line-height:1.5;">${r.mensaje.replace(/</g,'&lt;')}</div>
            </div>
            <div>
              <div style="font-size:10px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Destinatarios (${dests.length})</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 6px;">
                ${dests.map(d=>`<span style="font-size:12px;padding:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${d.label||''}">${d.label||d.chatId}</span>`).join('')}
              </div>
            </div>
            ${r.error_msg ? `<div style="font-size:12px;color:var(--color-error);"><i class="fa-solid fa-triangle-exclamation"></i> ${r.error_msg}</div>` : ''}
          </div>
        </div>`;
    }).join('');
  } catch(e) {
    lista.innerHTML = `<span style="font-size:12px;color:var(--color-error);">Error al cargar: ${e.message}</span>`;
  }
}

function recToggleCard(id) {
  const detail  = document.getElementById(`rec-detail-${id}`);
  const chevron = document.getElementById(`rec-chevron-${id}`);
  if (!detail) return;
  const open = detail.style.display === 'flex';
  detail.style.display  = open ? 'none' : 'flex';
  if (chevron) chevron.style.transform = open ? '' : 'rotate(90deg)';
}

function editarRecordatorio(id) {
  const r = (window._recProgramados || []).find(x => x.id === id);
  if (!r) return;

  // Precargar formulario arriba
  const msgEl = document.getElementById('rec-mensaje');
  if (msgEl) msgEl.value = r.mensaje;

  const dtEl = document.getElementById('rec-datetime');
  if (dtEl && r.fecha_hora) {
    // Convertir a formato datetime-local (yyyy-MM-ddTHH:mm)
    const d = new Date(r.fecha_hora);
    const pad = n => String(n).padStart(2,'0');
    dtEl.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const repEl = document.getElementById('rec-repeticion');
  if (repEl) repEl.value = r.repeticion || 'none';

  // Marcar tipo y recargar destinatarios, luego marcar los que correspondan
  const dests = typeof r.destinatarios === 'string' ? JSON.parse(r.destinatarios) : r.destinatarios;
  const tipo = r.destinatarios_tipo || 'grupos';
  const tipoRadio = document.querySelector(`input[name="rec-tipo"][value="${tipo}"]`);
  if (tipoRadio) { tipoRadio.checked = true; }
  recOnTipo().then(() => {
    const ids = new Set(dests.map(d => d.chatId));
    document.querySelectorAll('#rec-dest-wrap input[type=checkbox]').forEach(cb => {
      cb.checked = ids.has(cb.dataset.recChatid);
    });
  });

  // Cambiar botón a "Actualizar" y guardar id en edición
  const btn = document.querySelector('button[onclick="guardarRecordatorio()"]');
  if (btn) {
    btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Actualizar';
    btn.dataset.editId = id;
    btn.onclick = () => guardarRecordatorio(id);
  }

  // Scroll al formulario
  document.getElementById('rec-mensaje')?.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

async function eliminarRecordatorio(id) {
  if (!await showConfirm('¿Eliminar este recordatorio?')) return;
  try {
    await fetch(`/api/wa/programados/${id}`, { method: 'DELETE' });
    showToast('Eliminado', 'info');
    loadRecordatorios();
  } catch(e) { showToast('Error', 'error'); }
}

function waBroadcastToggleAll(checked) {
  document.querySelectorAll('#broadcast-groups-list input[type=checkbox]').forEach(cb => cb.checked = checked);
}

async function sendWABroadcast() {
  const msg = document.getElementById('broadcast-msg').value.trim();
  if (!msg) { showToast('Escribí un mensaje', 'error'); return; }
  const selected = [...document.querySelectorAll('#broadcast-groups-list input[type=checkbox]')]
    .filter(cb => cb.checked)
    .map(cb => _waGroups[parseInt(cb.dataset.idx)])
    .filter(Boolean)
    .map(g => ({
      chatId:  g.id,
      label:   g.name,
      // Personalizar mensaje: {patente} → patente del grupo
      message: g.patente ? msg.replace(/\{patente\}/gi, g.patente) : msg
    }));
  if (!selected.length) { showToast('Seleccioná al menos un grupo', 'error'); return; }

  const btn = document.getElementById('broadcast-send-btn');
  const status = document.getElementById('broadcast-status');
  btn.disabled = true;
  status.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Enviando a ${selected.length} grupo(s)...`;

  try {
    const res = await fetch('/api/whatsapp/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: selected, message: msg /* fallback global */ })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    const ok  = data.results.filter(r => r.ok).length;
    const err = data.results.filter(r => !r.ok);
    status.innerHTML = `<span style="color:#22c55e;font-weight:600;">✓ Enviado a ${ok} grupo(s)</span>` +
      (err.length ? `<br><span style="color:var(--color-error);font-size:12px;">Falló: ${err.map(r=>r.label).join(', ')}</span>` : '');
    showToast(`Mensaje enviado a ${ok} grupo(s)`, 'success');
  } catch(e) {
    status.innerHTML = `<span style="color:var(--color-error);">${e.message}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// ── WhatsApp: enviar documento desde el visor flotante ────────────────────────
let _fvWaCurrentUrl   = null;
let _fvWaCurrentName  = '';
let _fvWaChoferes     = [];
let _fvWaUsuarios     = [];
let _fvWaPropietarios = [];
let _fvWaTipo         = 'chofer';       // chofer | usuario | propietario | manual
let _fvWaRecipient    = null;           // { tipo, id, nombre, telefono }

async function fvOpenWaSend() {
  const dl   = document.getElementById('img-viewer-download');
  const url  = dl?.href;
  const name = document.getElementById('img-viewer-title')?.textContent || 'Documento';
  if (!url || url === '#' || url === window.location.href) return showToast('No hay documento abierto para enviar.', 'warning');

  const isPdf = url.toLowerCase().includes('.pdf') || name.toLowerCase().endsWith('.pdf');
  const tipo  = isPdf ? 'pdf' : 'imagen';

  // Usar el modal estándar con el documento pre-cargado como adjunto
  await openWhatsAppModal(null, name, null);

  // Pre-cargar el documento del visor en la sección de adjuntos
  _waMultaAdjs = [{ url, nombre: name, tipo }];
  const container = document.getElementById('wa-multa-adjs');
  const list      = document.getElementById('wa-multa-adjs-list');
  if (container && list) {
    const iconos = { imagen: '🖼', pdf: '📄', video: '🎥' };
    list.innerHTML = `<label style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;border:1px solid var(--border-color);cursor:pointer;font-size:12px;">
      <input type="checkbox" data-adj-idx="0" checked style="accent-color:#25d366;width:14px;height:14px;flex-shrink:0;">
      <span>${iconos[tipo] || '📎'}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</span>
      <span style="color:var(--text-secondary);text-transform:uppercase;font-size:10px;font-weight:700;">${tipo}</span>
    </label>`;
    container.style.display = 'flex';
  }

  // Ocultar toggle XLS — no aplica cuando se envía un documento del visor
  const xlsToggle = document.getElementById('wa-xls-toggle');
  if (xlsToggle) xlsToggle.style.display = 'none';
}

function fvWaSetTipo(tipo) {
  _fvWaTipo      = tipo;
  _fvWaRecipient = null;
  document.querySelectorAll('.fv-wa-tipo-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tipo === tipo);
    b.style.background    = b.dataset.tipo === tipo ? 'var(--accent-color)'    : '';
    b.style.color         = b.dataset.tipo === tipo ? '#fff'                   : '';
    b.style.borderColor   = b.dataset.tipo === tipo ? 'var(--accent-color)'    : '';
  });
  const searchBlock = document.getElementById('fv-wa-search-block');
  const label       = document.getElementById('fv-wa-search-label');
  const si          = document.getElementById('fv-wa-chofer-search');
  const numInp      = document.getElementById('fv-wa-numero');
  if (tipo === 'manual') {
    if (searchBlock) searchBlock.style.display = 'none';
    if (numInp) { numInp.value = ''; numInp.readOnly = false; }
  } else {
    if (searchBlock) searchBlock.style.display = '';
    if (numInp) { numInp.value = ''; numInp.readOnly = true; }
    const labels = { chofer: 'Chofer activo', usuario: 'Usuario del sistema', propietario: 'Propietario de vehículo', contacto: 'Buscar chofer → contacto emergencia' };
    if (label) label.textContent = labels[tipo] || '';
    if (si)    si.value = '';
    fvWaHideDropdown();
  }
}

function fvWaFilterCurrent(q) {
  const dd   = document.getElementById('fv-wa-chofer-dropdown');
  if (!dd) return;
  const term = q.toLowerCase().trim();
  // Modo contacto: búsqueda en 2 pasos (chofer → contactos alt)
  if (_fvWaTipo === 'contacto') {
    const source  = _fvWaChoferes.filter(c => c.telefono_alt1 || c.telefono_alt2);
    const matches = term
      ? source.filter(c => `${c.nombre||''} ${c.apellido||''}`.toLowerCase().includes(term))
      : source;
    dd.innerHTML = '';
    if (!matches.length) {
      dd.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:var(--text-secondary);">Sin resultados</div>';
    } else {
      matches.forEach(c => {
        const nombre = `${c.nombre||''} ${c.apellido||''}`.trim();
        const div = document.createElement('div');
        div.style.cssText = 'padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border-color);display:flex;align-items:center;gap:8px;';
        div.innerHTML = `<i class="fa-solid fa-user" style="font-size:12px;color:var(--text-secondary);"></i><span style="font-size:13px;">${nombre}</span><span style="font-size:11px;color:var(--text-secondary);margin-left:auto;"><i class="fa-solid fa-chevron-right"></i></span>`;
        div.onmouseover = () => div.style.background = 'var(--bg-hover,rgba(255,255,255,0.06))';
        div.onmouseout  = () => div.style.background = '';
        div.onmousedown = () => {
          // Mostrar contactos del chofer seleccionado
          const si = document.getElementById('fv-wa-chofer-search');
          if (si) si.value = nombre;
          dd.innerHTML = `<div style="padding:6px 10px;font-size:11px;font-weight:600;color:var(--text-secondary);border-bottom:1px solid var(--border-color);letter-spacing:.5px;">CONTACTOS DE ${nombre.toUpperCase()}</div>`;
          const contactos = [];
          if (c.telefono_alt1) contactos.push({ tel: c.telefono_alt1, vinculo: c.telefono_alt1_vinculo || 'Contacto 1' });
          if (c.telefono_alt2) contactos.push({ tel: c.telefono_alt2, vinculo: c.telefono_alt2_vinculo || 'Contacto 2' });
          if (!contactos.length) {
            dd.innerHTML += '<div style="padding:8px 12px;font-size:12px;color:var(--text-secondary);">Sin contactos cargados</div>';
          } else {
            contactos.forEach(ct => {
              const row = document.createElement('div');
              row.style.cssText = 'padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--border-color);display:flex;justify-content:space-between;align-items:center;';
              row.innerHTML = `<span style="font-size:13px;">${nombre} <span style="color:var(--accent-color);font-weight:600;">— ${ct.vinculo}</span></span><span style="font-size:11px;color:var(--text-secondary);">${ct.tel}</span>`;
              row.onmouseover = () => row.style.background = 'var(--bg-hover,rgba(255,255,255,0.06))';
              row.onmouseout  = () => row.style.background = '';
              row.onmousedown = () => {
                const numInp = document.getElementById('fv-wa-numero');
                const si2    = document.getElementById('fv-wa-chofer-search');
                const phone  = ct.tel.replace(/\D/g,'');
                if (numInp) { numInp.value = phone; numInp.readOnly = true; }
                if (si2)    si2.value = `${nombre} — ${ct.vinculo} · ${ct.tel}`;
                _fvWaRecipient = { tipo: 'contacto', id: c.id, nombre: `${nombre} — ${ct.vinculo}`, telefono: phone };
                fvWaHideDropdown();
              };
              dd.appendChild(row);
            });
          }
          dd.style.display = 'block';
        };
        dd.appendChild(div);
      });
    }
    dd.style.display = 'block';
    return;
  }

  let list   = [];
  if      (_fvWaTipo === 'chofer')      list = _fvWaChoferes;
  else if (_fvWaTipo === 'usuario')     list = _fvWaUsuarios;
  else if (_fvWaTipo === 'propietario') list = _fvWaPropietarios;

  const matches = term
    ? list.filter(x => `${x.nombre||''} ${x.apellido||''} ${x.telefono||''} ${x.celular||''} ${x.patente||''}`.toLowerCase().includes(term))
    : list;

  dd.innerHTML = '';
  if (!matches.length) {
    dd.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:var(--text-secondary);">Sin resultados</div>';
  } else {
    matches.forEach(x => {
      const nombre = `${x.nombre||''} ${x.apellido||''}`.trim();
      const tel    = x.telefono || x.celular || '';
      const sub    = _fvWaTipo === 'propietario' ? `Patente ${x.patente}` : (tel || 'sin teléfono');
      const div    = document.createElement('div');
      div.style.cssText = 'padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border-color);display:flex;justify-content:space-between;align-items:center;';
      div.innerHTML = `<span style="font-size:13px;">${nombre}</span><span style="font-size:11px;color:var(--text-secondary);">${sub}</span>`;
      div.onmousedown = () => {
        const numInp = document.getElementById('fv-wa-numero');
        const si     = document.getElementById('fv-wa-chofer-search');
        const phone  = (tel).replace(/\D/g,'');
        if (numInp) { numInp.value = phone; numInp.readOnly = true; }
        if (si)     si.value = `${nombre}${tel ? ' · '+tel : ''}`;
        _fvWaRecipient = { tipo: _fvWaTipo, id: x.id, nombre, telefono: phone };
        fvWaHideDropdown();
      };
      div.onmouseover = () => div.style.background = 'var(--bg-hover,rgba(255,255,255,0.06))';
      div.onmouseout  = () => div.style.background = '';
      dd.appendChild(div);
    });
  }
  dd.style.display = 'block';
}

// Alias para compatibilidad con onfocus del input
function fvWaShowDropdown() { fvWaFilterCurrent(document.getElementById('fv-wa-chofer-search')?.value || ''); }
function fvWaHideDropdown() { const dd = document.getElementById('fv-wa-chofer-dropdown'); if (dd) dd.style.display = 'none'; }

function fvCloseWaPanel() {
  const panel = document.getElementById('fv-wa-panel');
  if (panel) panel.style.display = 'none';
  _fvWaRecipient = null;
}

function fvLogDownload() {
  const name = document.getElementById('img-viewer-title')?.textContent || 'Documento';
  fetch('/api/auditoria/accion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modulo: 'visor', accion: 'descargar', descripcion: `Descarga: ${name}` })
  }).catch(() => {});
}

async function fvSendViaWA() {
  const numInp = document.getElementById('fv-wa-numero');
  const msgInp = document.getElementById('fv-wa-msg');
  const status = document.getElementById('fv-wa-status');
  const phone  = (numInp?.value || '').trim().replace(/\D/g,'');
  if (!phone) { if (status) status.textContent = 'Ingresá un número.'; return; }
  if (!_fvWaCurrentUrl) { if (status) status.textContent = 'Sin documento.'; return; }

  if (status) status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enviando…';

  try {
    // Si es blob URL (pre-save) usar directo; si es URL del servidor hacer fetch
    let b64, mimeType, filename;
    filename = _fvWaCurrentName || 'documento';

    if (_fvWaCurrentUrl.startsWith('blob:')) {
      // Ya tenemos el objeto en _pendingFiles — leer desde ahí si existe
      const pendingKey = _imgViewerFileKey;
      const pendingFile = pendingKey && _pendingFiles?.[pendingKey];
      const source = pendingFile || await fetch(_fvWaCurrentUrl).then(r => r.blob());
      mimeType = source.type || 'application/octet-stream';
      b64 = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload  = () => res(fr.result.split(',')[1]);
        fr.onerror = rej;
        fr.readAsDataURL(source);
      });
    } else {
      const resp = await fetch(_fvWaCurrentUrl);
      if (!resp.ok) throw new Error(`No se pudo descargar el archivo (HTTP ${resp.status})`);
      const blob = await resp.blob();
      mimeType = blob.type || 'application/octet-stream';
      b64 = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload  = () => res(fr.result.split(',')[1]);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
    }

    // Determinar destinatario para auditoría
    let recipientTipo   = _fvWaTipo === 'manual' ? 'numero_manual' : (_fvWaRecipient?.tipo || 'desconocido');
    let recipientNombre = _fvWaRecipient?.nombre || `Número ${phone}`;
    let recipientId     = _fvWaRecipient?.id || null;

    const sendResp = await fetch('/api/whatsapp/send-doc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone, message: msgInp?.value || '', fileBase64: b64, mimeType, filename,
        audit: { recipientTipo, recipientNombre, recipientId, docName: _fvWaCurrentName }
      })
    });
    const text = await sendResp.text();
    let data;
    try { data = JSON.parse(text); } catch(_) { throw new Error(`Respuesta inválida del servidor: ${text.slice(0,80)}`); }
    if (!sendResp.ok) {
      if (sendResp.status === 503) {
        if (status) status.innerHTML = `<span style="color:var(--color-error);">✗ ${data.message || 'Bot no conectado'}</span>
          <button type="button" onclick="waReconectarDesdeModal()" style="margin-left:10px;padding:2px 10px;font-size:11px;background:#25d366;color:#fff;border:none;border-radius:6px;cursor:pointer;">
            <i class="fa-solid fa-rotate"></i> Reconectar
          </button>`;
      } else {
        throw new Error(data.message || `Error HTTP ${sendResp.status}`);
      }
      return;
    }
    if (status) status.innerHTML = '<span style="color:#25d366;"><i class="fa-solid fa-check"></i> Enviado correctamente</span>';
    setTimeout(fvCloseWaPanel, 1800);
  } catch (err) {
    if (status) status.innerHTML = `<span style="color:var(--accent-red,#e53e3e);">${err.message}</span>`;
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// DATE PICKER â€” reemplaza el input[type=date/datetime-local] nativo
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const DatePicker = (() => {
  const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const WDS    = ['Lu','Ma','Mi','Ju','Vi','Sa','Do'];
  let _popup = null, _cur = null;

  function _parse(val) {
    if (!val) return null;
    const m = val.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (!m) return null;
    return { y:+m[1], mo:+m[2]-1, d:+m[3], h:m[4]?+m[4]:0, min:m[5]?+m[5]:0 };
  }

  function _fmtDisp(dt, isdt) {
    if (!dt) return '';
    const dd = String(dt.d).padStart(2,'0'), mm = String(dt.mo+1).padStart(2,'0');
    return isdt
      ? `${dd}/${mm}/${dt.y}  ${String(dt.h).padStart(2,'0')}:${String(dt.min).padStart(2,'0')}`
      : `${dd}/${mm}/${dt.y}`;
  }

  function _fmtVal(dt, isdt) {
    const dd = String(dt.d).padStart(2,'0'), mm = String(dt.mo+1).padStart(2,'0');
    return isdt
      ? `${dt.y}-${mm}-${dd}T${String(dt.h).padStart(2,'0')}:${String(dt.min).padStart(2,'0')}`
      : `${dt.y}-${mm}-${dd}`;
  }

  function _buildPopup() {
    const el = document.createElement('div');
    el.className = 'dp-popup';
    el.innerHTML =
      '<div class="dp-nav">' +
        '<button class="dp-nav-btn" id="dp-prev">&#8249;</button>' +
        '<span class="dp-month-lbl" id="dp-month-lbl"></span>' +
        '<button class="dp-nav-btn" id="dp-next">&#8250;</button>' +
      '</div>' +
      '<div class="dp-weekdays">' + WDS.map(w => '<div class="dp-wd">' + w + '</div>').join('') + '</div>' +
      '<div class="dp-days" id="dp-days"></div>' +
      '<div class="dp-time-row" id="dp-time-row">' +
        '<span class="dp-time-lbl">Hora</span>' +
        '<input type="number" id="dp-h" min="0" max="23" placeholder="HH">' +
        '<span class="dp-sep">:</span>' +
        '<input type="number" id="dp-m" min="0" max="59" placeholder="MM">' +
      '</div>' +
      '<div class="dp-footer">' +
        '<button class="dp-footer-btn" id="dp-clear">Borrar</button>' +
        '<button class="dp-footer-btn dp-today-btn" id="dp-today">Hoy</button>' +
        '<button class="dp-footer-btn dp-ok-btn" id="dp-ok">Aceptar ↵</button>' +
      '</div>';
    document.body.appendChild(el);

    el.querySelector('#dp-prev').addEventListener('mousedown', function(e) {
      e.preventDefault();
      _cur.month--;
      if (_cur.month < 0) { _cur.month = 11; _cur.year--; }
      _grid();
    });
    el.querySelector('#dp-next').addEventListener('mousedown', function(e) {
      e.preventDefault();
      _cur.month++;
      if (_cur.month > 11) { _cur.month = 0; _cur.year++; }
      _grid();
    });
    el.querySelector('#dp-clear').addEventListener('mousedown', function(e) {
      e.preventDefault(); _commit(null); _close();
    });
    el.querySelector('#dp-today').addEventListener('mousedown', function(e) {
      e.preventDefault();
      var n = new Date();
      _commit({ y: n.getFullYear(), mo: n.getMonth(), d: n.getDate(), h: (_cur.sel && _cur.sel.h) || 0, min: (_cur.sel && _cur.sel.min) || 0 });
      if (!_cur.isdt) _close();
    });
    el.querySelector('#dp-ok').addEventListener('mousedown', function(e) {
      e.preventDefault(); _close();
    });
    el.querySelector('#dp-h').addEventListener('input', _applyTime);
    el.querySelector('#dp-m').addEventListener('input', _applyTime);

    document.addEventListener('keydown', function(e) {
      if (!_cur || !_popup || _popup.style.display === 'none') return;
      if (e.key === 'Enter') { e.preventDefault(); _close(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation(); _close(); }
    }, true); // capture=true: intercepta antes del handler de modales

    document.addEventListener('mousedown', function(e) {
      if (_cur && _popup && !_popup.contains(e.target) && e.target !== _cur.disp) _close();
    }, true);

    return el;
  }

  function _applyTime() {
    if (!_cur || !_cur.sel) return;
    _cur.sel.h   = Math.min(23, Math.max(0, parseInt(document.getElementById('dp-h').value) || 0));
    _cur.sel.min = Math.min(59, Math.max(0, parseInt(document.getElementById('dp-m').value) || 0));
    _commit(_cur.sel);
  }

  function _grid() {
    var year = _cur.year, month = _cur.month, sel = _cur.sel;
    document.getElementById('dp-month-lbl').textContent = MONTHS[month] + ' ' + year;
    var grid = document.getElementById('dp-days');
    grid.innerHTML = '';
    var today = new Date();
    var fd  = (new Date(year, month, 1).getDay() + 6) % 7;
    var dim = new Date(year, month + 1, 0).getDate();
    var dprev = new Date(year, month, 0).getDate();

    for (var i = 0; i < fd; i++) {
      var d = document.createElement('div');
      d.className = 'dp-day dp-day--other';
      d.textContent = dprev - fd + 1 + i;
      grid.appendChild(d);
    }
    for (var d2 = 1; d2 <= dim; d2++) {
      (function(day) {
        var el2 = document.createElement('div');
        el2.className = 'dp-day';
        el2.textContent = day;
        if (today.getFullYear() === year && today.getMonth() === month && today.getDate() === day)
          el2.classList.add('dp-day--today');
        if (sel && sel.y === year && sel.mo === month && sel.d === day)
          el2.classList.add('dp-day--sel');
        el2.addEventListener('mousedown', function(ev) {
          ev.preventDefault();
          var newSel = { y: year, mo: month, d: day, h: (_cur.sel && _cur.sel.h) || 0, min: (_cur.sel && _cur.sel.min) || 0 };
          _commit(newSel);
          if (!_cur.isdt) _close(); else _grid();
        });
        grid.appendChild(el2);
      })(d2);
    }
    var total = fd + dim, rem = total % 7 === 0 ? 0 : 7 - (total % 7);
    for (var j = 1; j <= rem; j++) {
      var dv = document.createElement('div');
      dv.className = 'dp-day dp-day--other';
      dv.textContent = j;
      grid.appendChild(dv);
    }
  }

  function _commit(dt) {
    _cur.sel = dt;
    if (dt) { _cur.year = dt.y; _cur.month = dt.mo; }
    var real = _cur.real, disp = _cur.disp, isdt = _cur.isdt;
    var nativeDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(real), 'value');
    var nativeSet  = nativeDesc && nativeDesc.set;
    if (dt) {
      if (nativeSet) nativeSet.call(real, _fmtVal(dt, isdt));
      disp.value = _fmtDisp(dt, isdt);
    } else {
      if (nativeSet) nativeSet.call(real, '');
      disp.value = '';
    }
    real.dispatchEvent(new Event('input',  { bubbles: true }));
    real.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function _open(real, disp, isdt) {
    if (!_popup) _popup = _buildPopup();
    var parsed = _parse(real.value);
    var now = new Date();
    _cur = {
      real: real, disp: disp, isdt: isdt,
      sel: parsed,
      year:  parsed ? parsed.y  : now.getFullYear(),
      month: parsed ? parsed.mo : now.getMonth()
    };
    var tr = _popup.querySelector('#dp-time-row');
    tr.style.display = isdt ? 'flex' : 'none';
    if (isdt && parsed) {
      _popup.querySelector('#dp-h').value = String(parsed.h).padStart(2, '0');
      _popup.querySelector('#dp-m').value = String(parsed.min).padStart(2, '0');
    } else {
      _popup.querySelector('#dp-h').value = '';
      _popup.querySelector('#dp-m').value = '';
    }
    _grid();
    _popup.style.display = 'block';
    var rect = disp.getBoundingClientRect();
    var ph = _popup.offsetHeight, pw = _popup.offsetWidth;
    var top2  = (window.innerHeight - rect.bottom > ph + 8) ? rect.bottom + 4 : rect.top - ph - 4;
    var left2 = Math.min(rect.left, window.innerWidth - pw - 8);
    _popup.style.top  = Math.max(4, top2)  + 'px';
    _popup.style.left = Math.max(4, left2) + 'px';
  }

  function _close() {
    if (_popup) _popup.style.display = 'none';
    _cur = null;
  }

  function init(real) {
    if (real._dpInit || real.dataset.noDp !== undefined) return;
    real._dpInit = true;
    var isdt = real.type === 'datetime-local';

    var anchor = document.createElement('div');
    anchor.className = 'dp-anchor';
    real.parentNode.insertBefore(anchor, real);
    anchor.appendChild(real);

    var disp = document.createElement('input');
    disp.type = 'text';
    disp.className = 'dp-display';
    real.classList.forEach(function(c) { if (c !== 'dp-display') disp.classList.add(c); });
    // Copiar el style inline (ancho, padding, font-size, etc.) — sin esto, cualquier
    // style="width:..." puesto en el <input type="date"> original se ignora en pantalla,
    // porque lo que se ve es este proxy de texto, no el input real (que queda oculto).
    if (real.getAttribute('style')) disp.setAttribute('style', real.getAttribute('style'));
    // Siempre preservar espacio derecho para el ícono de calendario,
    // aunque el style copiado incluya padding shorthand que lo achique.
    disp.style.paddingRight = '36px';
    disp.placeholder = isdt ? 'dd/mm/aaaa hh:mm' : 'dd/mm/aaaa';
    if (real.disabled) disp.disabled = true;
    anchor.insertBefore(disp, real);
    real.style.display = 'none';

    var p0 = _parse(real.value);
    if (p0) disp.value = _fmtDisp(p0, isdt);

    // Abrir picker solo al hacer clic en el ícono de calendario (pseudo-element ::after)
    // o cuando el campo está vacío y el usuario hace clic
    disp.addEventListener('click', function(e) {
      if (!disp.disabled) {
        var rect2 = disp.getBoundingClientRect();
        var clickX = e.clientX - rect2.left;
        // Clic en la zona del ícono (últimos 36px) → abrir picker
        if (clickX > rect2.width - 40 || disp.value === '') _open(real, disp, isdt);
      }
    });

    // Permitir escribir la fecha directamente en formato DD/MM/AAAA [HH:MM]
    disp.addEventListener('input', function() {
      var allowed = isdt ? /[^0-9\/ :]/g : /[^0-9\/]/g;
      var raw = disp.value.replace(allowed, '');
      // Auto-insertar separadores según posición
      if (!isdt) {
        if (/^\d{2}$/.test(raw))             raw = raw + '/';
        else if (/^\d{2}\/\d{2}$/.test(raw)) raw = raw + '/';
      } else {
        if (/^\d{2}$/.test(raw))                            raw = raw + '/';
        else if (/^\d{2}\/\d{2}$/.test(raw))               raw = raw + '/';
        else if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw))        raw = raw + ' ';
        else if (/^\d{2}\/\d{2}\/\d{4} \d{2}$/.test(raw)) raw = raw + ':';
      }
      if (raw !== disp.value) { disp.value = raw; }

      function setReal(val) {
        var nd = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(real), 'value');
        if (nd && nd.set) nd.set.call(real, val);
        real.dispatchEvent(new Event('input',  { bubbles: true }));
        real.dispatchEvent(new Event('change', { bubbles: true }));
      }

      if (!raw) { setReal(''); return; }

      if (!isdt) {
        var m2 = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (m2) {
          var d2 = +m2[1], mo2 = +m2[2] - 1, y2 = +m2[3];
          var chk = new Date(y2, mo2, d2);
          if (chk.getDate() === d2 && chk.getMonth() === mo2 && chk.getFullYear() === y2)
            setReal(y2 + '-' + String(mo2+1).padStart(2,'0') + '-' + String(d2).padStart(2,'0'));
        }
      } else {
        var m2dt = raw.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);
        if (m2dt) {
          var d2 = +m2dt[1], mo2 = +m2dt[2] - 1, y2 = +m2dt[3], h2 = +m2dt[4], min2 = +m2dt[5];
          var chk = new Date(y2, mo2, d2, h2, min2);
          if (chk.getDate() === d2 && chk.getMonth() === mo2 && chk.getFullYear() === y2 && h2 < 24 && min2 < 60)
            setReal(y2 + '-' + String(mo2+1).padStart(2,'0') + '-' + String(d2).padStart(2,'0') + 'T' + String(h2).padStart(2,'0') + ':' + String(min2).padStart(2,'0'));
        }
      }
    });

    // Al salir del campo, normalizar el texto mostrado
    disp.addEventListener('blur', function() {
      var ok = isdt ? /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(disp.value)
                    : /^\d{2}\/\d{2}\/\d{4}$/.test(disp.value);
      if (!ok) disp.value = real.value ? _fmtDisp(_parse(real.value), isdt) : '';
    });

    // Override .value setter
    var proto = Object.getPrototypeOf(real);
    var desc2  = Object.getOwnPropertyDescriptor(proto, 'value');
    Object.defineProperty(real, 'value', {
      get: function() { return desc2.get.call(this); },
      set: function(v) {
        desc2.set.call(this, v);
        var p2 = _parse(v);
        disp.value = p2 ? _fmtDisp(p2, isdt) : '';
      },
      configurable: true
    });

    // Override .disabled setter
    var ddesc = Object.getOwnPropertyDescriptor(proto, 'disabled');
    if (ddesc) {
      Object.defineProperty(real, 'disabled', {
        get: function() { return ddesc.get.call(this); },
        set: function(v) { ddesc.set.call(this, v); disp.disabled = !!v; },
        configurable: true
      });
    }
  }

  function initAll(root) {
    (root || document).querySelectorAll('input[type="date"], input[type="datetime-local"]').forEach(function(el) {
      if (!el.dataset.noDp) init(el);
    });
  }

  return { init: init, initAll: initAll };
})();
