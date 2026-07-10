/**
 * scraper.js — Verificación automática de multas por patente
 * Abre un navegador visible para que el usuario resuelva CAPTCHAs.
 * Usa IA para parsear los resultados independientemente del HTML.
 */
'use strict';

const puppeteer = require('puppeteer');
const Anthropic  = require('@anthropic-ai/sdk');
// Instanciar lazy para que dotenv ya haya cargado la key desde index.js
let _aiClient = null;
const client = { messages: { create: (...args) => { if (!_aiClient) _aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); return _aiClient.messages.create(...args); } } };

// ── Jobs activos ──────────────────────────────────────────────────────────────
const _jobs = new Map();

// ── Configuración específica por sitio ───────────────────────────────────────
// pre_steps: pasos previos a ejecutar antes de buscar el input (clicks en tabs, etc.)
// plate_fn:  función async(page, patente) personalizada, sobreescribe la lógica genérica
const SITE_CONFIG = {
  'infratrack.com.ar': {
    nombre: 'Infratrack (Lanús, etc.)',
    captcha_selector: '.g-recaptcha, iframe[src*="recaptcha"]',
    plate_fn: async (page, patente, send) => {
      // 1. Click en pestaña "Por Dominio"
      try {
        await page.waitForSelector('button, a, [role="tab"]', { timeout: 6000 });
        const clicked = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('button, a, [role="tab"], input[type="button"]'));
          const tab = all.find(el => /por\s*dominio/i.test(el.textContent));
          if (tab) { tab.click(); return true; }
          return false;
        });
        if (clicked) {
          send('filling', '✓ Pestaña "Por Dominio" seleccionada');
          await new Promise(r => setTimeout(r, 700));
        }
      } catch {}
      // 2. Llenar patente
      const filled = await _fillByLabel(page, patente, ['patente', 'dominio', 'numero']);
      if (filled) return true;
      return await _fillFirstInput(page, patente);
    },
    // pre_extract_fn: expande acordeones, entra a "Ver prueba" de cada acta
    // y captura las URLs reales de fotos/videos
    pre_extract_fn: async (page, send) => {
      send('extracting', 'Detectando actas en el listado...');

      // 1. Contar filas/actas en el acordeón (sin expandir nada todavía)
      const actaCount = await page.evaluate(() => {
        // Infratrack muestra una lista tipo acordeón; cada header de acta es un elemento clickeable
        const rows = Array.from(document.querySelectorAll(
          '.list-group-item, .accordion-header, .accordion-item, ' +
          '[class*="acta-row"], [class*="infrac-row"], ' +
          'tr[data-acta], tr[data-id], ' +
          '.panel-heading, .card-header'
        )).filter(el => /acta|F-\d|V-\d|infracción/i.test(el.innerText || ''));
        // Fallback: cualquier elemento con texto "Acta F-" o "Acta V-"
        if (rows.length === 0) {
          return Array.from(document.querySelectorAll('*'))
            .filter(el => el.children.length < 6 && /Acta\s+[FV]-\d+/i.test(el.innerText || ''))
            .length;
        }
        return rows.length;
      });

      send('extracting', `${actaCount} acta(s) detectada(s) — procesando una por una...`);

      const actas = [];

      for (let i = 0; i < actaCount; i++) {
        send('extracting', `Acta ${i + 1} de ${actaCount}: expandiendo...`);

        // 2. Expandir la i-ésima acta (click en su header/toggle)
        await page.evaluate((idx) => {
          const candidates = Array.from(document.querySelectorAll(
            '.list-group-item, .accordion-header, .accordion-item, ' +
            '[class*="acta-row"], [class*="infrac-row"], ' +
            '.panel-heading, .card-header'
          )).filter(el => /acta|F-\d|V-\d|infracción/i.test(el.innerText || ''));

          let target = candidates[idx];
          if (!target) {
            // Fallback: elementos con "Acta F-/V-"
            const all = Array.from(document.querySelectorAll('*'))
              .filter(el => el.children.length < 6 && /Acta\s+[FV]-\d+/i.test(el.innerText || ''));
            target = all[idx];
          }
          if (!target) return;

          // Buscar el botón/toggle dentro o adyacente al header
          const toggle = target.querySelector(
            'button, [data-toggle], [data-bs-toggle], .chevron, i.fa-chevron-right, i.fa-chevron-down, i.fa-angle-right, i.fa-angle-down'
          );
          if (toggle) toggle.click();
          else target.click();
        }, i);

        await new Promise(r => setTimeout(r, 800));

        // 3. Capturar el texto del acta expandida (contexto)
        const actaTexto = await page.evaluate((idx) => {
          const candidates = Array.from(document.querySelectorAll(
            '.list-group-item, .accordion-item, .panel, .card'
          )).filter(el => /acta|F-\d|V-\d|infracción/i.test(el.innerText || ''));
          const el = candidates[idx];
          return el ? (el.innerText || '').substring(0, 800) : '';
        }, i);

        // 4. Buscar el botón "Ver prueba" dentro del acta expandida
        const hasPruebaBtn = await page.evaluate((idx) => {
          const candidates = Array.from(document.querySelectorAll(
            '.list-group-item, .accordion-item, .panel, .card'
          )).filter(el => /acta|F-\d|V-\d|infracción/i.test(el.innerText || ''));
          const container = candidates[idx];
          if (!container) {
            // Buscar globalmente el primer botón "Ver prueba" visible
            const btn = Array.from(document.querySelectorAll('button, a'))
              .find(el => /ver\s*prueba|prueba|evidencia/i.test(el.textContent));
            return !!btn;
          }
          const btn = Array.from(container.querySelectorAll('button, a'))
            .find(el => /ver\s*prueba|prueba|evidencia/i.test(el.textContent));
          return !!btn;
        }, i);

        let pruebaUrls = [];
        if (hasPruebaBtn) {
          send('extracting', `Acta ${i + 1}: capturando pruebas...`);

          // 5. Click en "Ver prueba" dentro del container de esta acta
          const browser = page.browser();
          let newPagePromise = new Promise(resolve => {
            browser.once('targetcreated', async target => {
              if (target.type() === 'page') resolve(await target.page());
            });
            setTimeout(() => resolve(null), 4000);
          });

          await page.evaluate((idx) => {
            const candidates = Array.from(document.querySelectorAll(
              '.list-group-item, .accordion-item, .panel, .card'
            )).filter(el => /acta|F-\d|V-\d|infracción/i.test(el.innerText || ''));
            const container = candidates[idx];
            const scope = container || document;
            const btn = Array.from(scope.querySelectorAll('button, a'))
              .find(el => /ver\s*prueba|prueba|evidencia/i.test(el.textContent));
            if (btn) btn.click();
          }, i);

          await new Promise(r => setTimeout(r, 1500));

          // 6. Capturar URLs (nueva pestaña o modal en la misma página)
          const newTab = await newPagePromise;
          if (newTab) {
            try {
              await newTab.waitForSelector('img, video, source', { timeout: 5000 }).catch(() => {});
              pruebaUrls = await newTab.evaluate(() => {
                const imgs  = Array.from(document.querySelectorAll('img')).map(i => i.src).filter(Boolean);
                const vids  = Array.from(document.querySelectorAll('video, source')).map(v => v.src || v.getAttribute('src')).filter(Boolean);
                const links = Array.from(document.querySelectorAll('a[href]'))
                  .map(a => a.href)
                  .filter(h => /\.(mp4|avi|mov|webm|jpg|jpeg|png|gif|webp)/i.test(h));
                return [...new Set([...imgs, ...vids, ...links])];
              });
              await newTab.close().catch(() => {});
            } catch {}
          } else {
            // Modal en la misma página
            pruebaUrls = await page.evaluate(() => {
              const modal = document.querySelector(
                '.modal.show, .modal[style*="display: block"], .modal[style*="display:block"], ' +
                '[role="dialog"], .lightbox, .fancybox, .popup'
              );
              const scope = modal || document;
              const imgs  = Array.from(scope.querySelectorAll('img')).map(i => i.src).filter(Boolean);
              const vids  = Array.from(scope.querySelectorAll('video, source')).map(v => v.src || v.getAttribute('src')).filter(Boolean);
              const links = Array.from(scope.querySelectorAll('a[href]'))
                .map(a => a.href)
                .filter(h => /\.(mp4|avi|mov|webm|jpg|jpeg|png|gif|webp)/i.test(h));
              return [...new Set([...imgs, ...vids, ...links])];
            });
            // Cerrar modal si quedó abierto
            await page.evaluate(() => {
              const closeBtn = document.querySelector(
                '.modal .close, .modal [data-dismiss], .modal .btn-close, .modal-close, ' +
                '[role="dialog"] .close, .lightbox-close, .popup-close'
              );
              if (closeBtn) closeBtn.click();
            });
            await new Promise(r => setTimeout(r, 400));
          }
        }

        actas.push({ text: actaTexto, prueba_urls: pruebaUrls });

        // 7. Colapsar el acordeón antes de pasar a la siguiente acta
        await page.evaluate((idx) => {
          const candidates = Array.from(document.querySelectorAll(
            '.list-group-item, .accordion-item, .panel, .card'
          )).filter(el => /acta|F-\d|V-\d|infracción/i.test(el.innerText || ''));
          const container = candidates[idx];
          if (!container) return;
          const toggle = container.querySelector(
            'button[aria-expanded="true"], [data-toggle], [data-bs-toggle], ' +
            '.chevron, i.fa-chevron-down, i.fa-angle-down'
          );
          if (toggle) toggle.click();
        }, i);
        await new Promise(r => setTimeout(r, 400));
      }

      return actas.length > 0 ? actas : [{ text: '', prueba_urls: [] }];
    },
  },

  'multas.mda.gob.ar': {
    nombre: 'Avellaneda',
    captcha_selector: '.g-recaptcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]',
    plate_fn: async (page, patente, send) => {
      const ok = await _fillByLabel(page, patente, ['dominio', 'patente', 'placa']);
      if (ok) return true;
      return await _fillBySelectors(page, patente, [
        'input[name="dominio"]', 'input[name="patente"]', 'input[id*="dominio" i]', 'input[id*="patente" i]',
      ]);
    },
  },

  'buenosaires.gob.ar': {
    nombre: 'CABA',
    captcha_selector: '.g-recaptcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]',
    plate_fn: async (page, patente, send) => {
      // Esperar a que el formulario cargue completamente
      await new Promise(r => setTimeout(r, 1500));

      // 1. Intentar con selectores directos (tipeo real — compatible con React)
      const selectors = [
        'input[name="dominio"]', 'input[name="Dominio"]',
        'input[id*="dominio" i]', 'input[id*="patente" i]',
        'input[placeholder*="dominio" i]', 'input[placeholder*="patente" i]',
        'input[type="text"]',
      ];
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (!el) continue;
          const visible = await el.isIntersectingViewport().catch(() => true);
          if (!visible) continue;
          await el.click({ clickCount: 3 });
          await el.type(patente, { delay: 80 });
          // Setter React-compatible
          await page.evaluate((s, v) => {
            const inp = document.querySelector(s);
            if (!inp) return;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(inp, v);
            inp.dispatchEvent(new Event('input',  { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }, sel, patente);
          return true;
        } catch {}
      }

      // 2. Buscar por label "Dominio" (React puede usar div en vez de label[for])
      const filled = await page.evaluate((patente) => {
        const all = Array.from(document.querySelectorAll('label, div, span, p'));
        const label = all.find(el => /\bdominio\b/i.test(el.textContent) && el.children.length < 5);
        if (!label) return false;
        const inp = label.querySelector('input') ||
                    label.nextElementSibling?.querySelector('input') ||
                    label.closest('div')?.querySelector('input[type="text"]');
        if (!inp) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(inp, patente);
        inp.dispatchEvent(new Event('input',  { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, patente);
      return filled;
    },
  },

  'infraccionesba.gba.gob.ar': {
    nombre: 'Buenos Aires (Provincia)',
    captcha_selector: '.g-recaptcha, iframe[src*="recaptcha"], .captcha',
    plate_fn: async (page, patente) => {
      const ok = await _fillBySelectors(page, patente, [
        'input[name="dominio"]', 'input[name="Dominio"]', 'input[id*="dominio" i]',
        'input[placeholder*="dominio" i]',
      ]);
      if (ok) return true;
      return await _fillByLabel(page, patente, ['dominio', 'patente']);
    },
  },

  'lomasdezamora.gov.ar': {
    nombre: 'Lomas de Zamora',
    captcha_selector: '.g-recaptcha, #captcha, input[name*="captcha" i]',
    is_aspx: true,
    plate_fn: async (page, patente) => {
      const ok = await _fillBySelectors(page, patente, [
        'input[id*="Dominio"]', 'input[name*="Dominio"]',
        'input[id*="dominio" i]', 'input[id*="patente" i]',
      ]);
      if (ok) return true;
      return await _fillByLabel(page, patente, ['dominio', 'patente']);
    },
    // Extractor DOM directo — no necesita IA
    extract_fn: async (page, patente) => {
      return page.evaluate((pat) => {
        const rows = Array.from(document.querySelectorAll('table tbody tr, table tr:not(:first-child)'));
        if (!rows.length) return null;

        // Detectar encabezados de la tabla para mapear columnas
        const headers = Array.from(
          document.querySelectorAll('table thead th, table tr:first-child th, table tr:first-child td')
        ).map(th => th.innerText.trim().toLowerCase());

        const col = (name) => {
          const idx = headers.findIndex(h => h.includes(name));
          return idx >= 0 ? idx : -1;
        };

        const multas = [];
        rows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
          if (!cells.length) return;

          // Mapeo por columnas conocidas del sitio de Lomas de Zamora
          const iCausa  = col('causa');
          const iDom    = col('dominio');
          const iInfr   = col('infra');
          const iFecha  = col('fecha');
          const iLugar  = col('lugar');

          // Si no hay headers, usar posiciones fijas del sitio conocido:
          // Columnas: [RECIBO btn, INFO btn, Causa, Dominio, Infractor, Documento, Infracciones, Fecha Infracción, Lugar]
          const numero_acta   = cells[iCausa  >= 0 ? iCausa  : 2] || '';
          const descripcion   = cells[iInfr   >= 0 ? iInfr   : 6] || '';
          const fecha_raw     = cells[iFecha  >= 0 ? iFecha  : 7] || '';
          const lugar         = cells[iLugar  >= 0 ? iLugar  : 8] || '';

          if (!numero_acta && !descripcion) return;

          // Normalizar fecha DD/MM/YYYY → YYYY-MM-DD
          let fecha_infraccion = '';
          const dm = fecha_raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
          if (dm) {
            const y = dm[3].length === 2 ? '20' + dm[3] : dm[3];
            fecha_infraccion = `${y}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}`;
          }

          multas.push({
            numero_acta:      numero_acta.replace(/\s+/g,' ').trim(),
            fecha_infraccion,
            descripcion:      descripcion.replace(/\s+/g,' ').replace(/^--/,'').trim(),
            lugar:            lugar.replace(/\s+/g,' ').trim(),
            monto:            '',
            estado:           'pendiente',
            organismo:        'Municipio de Lomas de Zamora',
            prueba_urls:      [],
          });
        });

        return multas.length ? { encontradas: true, sin_multas: false, error_sitio: null, multas } : null;
      }, patente);
    },
  },

  'a.brown.gob.ar': {
    nombre: 'Alte Brown',
    captcha_selector: '.g-recaptcha, iframe[src*="recaptcha"]',
    plate_fn: async (page, patente) => {
      const ok = await _fillBySelectors(page, patente, [
        'input[name="dominio"]', 'input[name="patente"]',
        'input[id*="dominio" i]', 'input[id*="patente" i]',
        'input[placeholder*="dominio" i]', 'input[placeholder*="patente" i]',
      ]);
      if (ok) return true;
      return await _fillByLabel(page, patente, ['dominio', 'patente', 'chapa']);
    },
  },
};

function getSiteConfig(url) {
  try {
    const host = new URL(url).hostname;
    for (const key of Object.keys(SITE_CONFIG)) {
      if (host.includes(key)) return SITE_CONFIG[key];
    }
  } catch {}
  return null;
}

// ── Helpers de llenado ────────────────────────────────────────────────────────

/** Busca un input por el texto de su label asociado */
async function _fillByLabel(page, value, keywords) {
  return page.evaluate((value, keywords) => {
    const labels = Array.from(document.querySelectorAll('label'));
    for (const kw of keywords) {
      const label = labels.find(l => l.textContent.toLowerCase().includes(kw));
      if (!label) continue;
      let input = null;
      if (label.htmlFor) input = document.getElementById(label.htmlFor);
      if (!input) input = label.querySelector('input');
      if (!input) {
        // Buscar el input más cercano después del label
        let next = label.nextElementSibling;
        while (next && !input) {
          input = next.tagName === 'INPUT' ? next : next.querySelector('input[type="text"], input:not([type])');
          next = next.nextElementSibling;
        }
      }
      if (input && (input.type === 'text' || !input.type) && !input.disabled && !input.readOnly) {
        input.focus();
        input.value = '';
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, value, keywords);
}

/** Prueba una lista de selectores CSS y llena el primero que encuentre */
async function _fillBySelectors(page, value, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const visible = await el.isIntersectingViewport().catch(() => true);
        if (!visible) continue;
        await el.click({ clickCount: 3 });
        await el.type(value, { delay: 60 });
        // Disparar eventos para frameworks reactivos
        await page.evaluate((s, v) => {
          const inp = document.querySelector(s);
          if (inp) {
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, sel, value);
        return true;
      }
    } catch {}
  }
  return false;
}

/** Fallback: llena el primer input tipo texto visible en la página */
async function _fillFirstInput(page, value) {
  return page.evaluate((value) => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
    const input = inputs.find(i => {
      const style = window.getComputedStyle(i);
      return style.display !== 'none' && style.visibility !== 'hidden' && !i.disabled && !i.readOnly;
    });
    if (!input) return false;
    input.focus();
    input.value = '';
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, value);
}

/**
 * Hace click en el i-ésimo botón "Ver prueba" de la página y captura
 * todas las URLs de imágenes y videos que aparecen (en modal o nueva pestaña).
 */
async function _extractPruebaUrls(page, buttonIndex) {
  const browser = page.browser();
  const mediaUrls = [];

  // Escuchar si se abre una nueva pestaña
  let newPagePromise = new Promise(resolve => {
    browser.once('targetcreated', async target => {
      if (target.type() === 'page') {
        resolve(await target.page());
      }
    });
    // Timeout: si no abre nueva pestaña en 3s, resolver con null
    setTimeout(() => resolve(null), 3000);
  });

  // Guardar URL actual para detectar navegación
  const urlAntes = page.url();

  // Click en el botón
  await page.evaluate((idx) => {
    const btns = Array.from(document.querySelectorAll('button, a, input[type="button"]'))
      .filter(el => /ver\s*prueba|prueba|evidencia/i.test(el.textContent + (el.value || '')));
    if (btns[idx]) btns[idx].click();
  }, buttonIndex);

  await new Promise(r => setTimeout(r, 1500));

  // Caso 1: se abrió una nueva pestaña
  const newPage = await newPagePromise;
  if (newPage) {
    try {
      await newPage.waitForSelector('img, video, source', { timeout: 5000 }).catch(() => {});
      const urls = await newPage.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img')).map(i => i.src).filter(Boolean);
        const vids = Array.from(document.querySelectorAll('video, source')).map(v => v.src || v.getAttribute('src')).filter(Boolean);
        // También links directos a archivos multimedia
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.href)
          .filter(h => /\.(mp4|avi|mov|webm|jpg|jpeg|png|gif|webp)/i.test(h));
        return [...new Set([...imgs, ...vids, ...links])];
      });
      mediaUrls.push(...urls);
      await newPage.close().catch(() => {});
    } catch {}
    return mediaUrls;
  }

  // Caso 2: apareció un modal en la misma página
  const modalVisible = await page.evaluate(() => {
    const modals = Array.from(document.querySelectorAll(
      '.modal.show, .modal[style*="display: block"], .modal[style*="display:block"], ' +
      '[role="dialog"], .lightbox, .fancybox, .popup'
    ));
    return modals.length > 0;
  });

  if (modalVisible) {
    const urls = await page.evaluate(() => {
      const modal = document.querySelector(
        '.modal.show, .modal[style*="display: block"], .modal[style*="display:block"], ' +
        '[role="dialog"], .lightbox, .fancybox, .popup'
      );
      if (!modal) return [];
      const imgs  = Array.from(modal.querySelectorAll('img')).map(i => i.src).filter(Boolean);
      const vids  = Array.from(modal.querySelectorAll('video, source')).map(v => v.src || v.getAttribute('src')).filter(Boolean);
      const links = Array.from(modal.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(h => /\.(mp4|avi|mov|webm|jpg|jpeg|png|gif|webp)/i.test(h));
      return [...new Set([...imgs, ...vids, ...links])];
    });
    mediaUrls.push(...urls);

    // Cerrar el modal
    await page.evaluate(() => {
      const closeBtn = document.querySelector(
        '.modal .close, .modal [data-dismiss], .modal .btn-close, ' +
        '[role="dialog"] .close, .lightbox-close, .popup-close'
      );
      if (closeBtn) closeBtn.click();
    });
    await new Promise(r => setTimeout(r, 400));
    return mediaUrls;
  }

  // Caso 3: navegó a una nueva URL en la misma pestaña
  const urlDespues = page.url();
  if (urlDespues !== urlAntes) {
    await page.waitForSelector('img, video', { timeout: 5000 }).catch(() => {});
    const urls = await page.evaluate(() => {
      const imgs  = Array.from(document.querySelectorAll('img')).map(i => i.src).filter(Boolean);
      const vids  = Array.from(document.querySelectorAll('video, source')).map(v => v.src || v.getAttribute('src')).filter(Boolean);
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(h => /\.(mp4|avi|mov|webm|jpg|jpeg|png|gif|webp)/i.test(h));
      return [...new Set([...imgs, ...vids, ...links])];
    });
    mediaUrls.push(...urls);
    await page.goBack().catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    return mediaUrls;
  }

  // Caso 4: puede haber aparecido contenido inline (img/video inyectado dinámicamente)
  const inlineUrls = await page.evaluate(() => {
    // Buscar elementos media que aparecieron recientemente (sin src previo conocido)
    const imgs  = Array.from(document.querySelectorAll('img[src*="prueba"], img[src*="foto"], img[src*="evidencia"], img[src*="capture"]')).map(i => i.src);
    const vids  = Array.from(document.querySelectorAll('video[src], video source[src]')).map(v => v.src || v.getAttribute('src'));
    return [...new Set([...imgs, ...vids])].filter(Boolean);
  });
  mediaUrls.push(...inlineUrls);

  return mediaUrls;
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
function _broadcast(jobId, event) {
  const job = _jobs.get(jobId);
  if (!job) return;
  job.msgs.push(event);
  for (const res of job.sseClients) {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
  }
}

// ── API pública ───────────────────────────────────────────────────────────────

function getJob(jobId) { return _jobs.get(jobId) || null; }

function addSseClient(jobId, res) {
  const job = _jobs.get(jobId);
  if (!job) return false;
  job.sseClients.push(res);
  for (const m of job.msgs) {
    try { res.write(`data: ${JSON.stringify(m)}\n\n`); } catch {}
  }
  return true;
}

function removeSseClient(jobId, res) {
  const job = _jobs.get(jobId);
  if (!job) return;
  job.sseClients = job.sseClients.filter(r => r !== res);
}

async function iniciarVerificacion(jobId, url, patente) {
  if (_jobs.has(jobId)) return;
  _jobs.set(jobId, { browser: null, page: null, status: 'starting', msgs: [], result: null, sseClients: [], patente, url });
  _runJob(jobId, url, patente).catch(err => {
    _broadcast(jobId, { status: 'error', msg: `Error: ${err.message}` });
    const j = _jobs.get(jobId); if (j) j.status = 'error';
  });
}

async function _runJob(jobId, url, patente) {
  const send = (status, msg) => {
    const job = _jobs.get(jobId);
    if (job) job.status = status;
    _broadcast(jobId, { status, msg });
  };

  send('starting', 'Abriendo navegador...');

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
    defaultViewport: null,
  });

  const job = _jobs.get(jobId);
  job.browser = browser;

  try {
    const page = await browser.newPage();
    job.page = page;

    browser.on('disconnected', () => {
      if (_jobs.get(jobId)?.status !== 'done') {
        send('cancelled', 'Navegador cerrado por el usuario');
        _jobs.delete(jobId);
      }
    });

    send('navigating', `Navegando a ${url}...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Esperar un poco para que el JS del sitio termine de renderizar
    await new Promise(r => setTimeout(r, 1200));

    const config = getSiteConfig(url);
    send('filling', 'Buscando campo de patente...');

    let filled = false;
    try {
      if (config?.plate_fn) {
        filled = await config.plate_fn(page, patente, send);
      } else {
        // Genérico: labels primero, luego selectores comunes
        filled = await _fillByLabel(page, patente, ['patente', 'dominio', 'chapa', 'placa', 'numero'])
               || await _fillBySelectors(page, patente, [
                    'input[name="dominio"]', 'input[name="Dominio"]',
                    'input[name="patente"]', 'input[name="Patente"]',
                    'input[id*="dominio" i]', 'input[id*="patente" i]',
                    'input[placeholder*="dominio" i]', 'input[placeholder*="patente" i]',
                    'input[placeholder*="chapa" i]',
                  ])
               || await _fillFirstInput(page, patente);
      }
    } catch (e) {
      send('manual_fill', `⚠ No pude llenar el campo automáticamente. Ingresá la patente "${patente}" en el campo del navegador (usá el botón COPIAR del panel).`);
    }

    if (filled) {
      send('filled', `✓ Patente "${patente}" ingresada — enviá el formulario en el navegador`);
    } else if (!config?.plate_fn) {
      send('manual_fill', `⚠ No encontré el campo. Ingresá "${patente}" manualmente en el navegador (usá el botón COPIAR del panel).`);
    }

    // Detectar CAPTCHA
    const captchaSel = config?.captcha_selector || '.g-recaptcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]';
    let hasCaptcha = false;
    try { hasCaptcha = await page.$(captchaSel) !== null; } catch {}

    if (hasCaptcha) {
      send('captcha', '🔒 CAPTCHA detectado — resolvelo en el navegador, enviá el formulario y presioná "Extraer resultados" aquí cuando veas los resultados.');
    } else {
      send('waiting_submit', 'Enviá el formulario en el navegador. Cuando aparezcan los resultados, presioná "Extraer resultados" aquí.');
    }

    send('ready', 'Navegador listo — esperando tu señal para extraer');
    job.status = 'ready';

  } catch (err) {
    send('error', `Error: ${err.message}`);
    await browser.close().catch(() => {});
    _jobs.delete(jobId);
  }
}

async function extraerResultados(jobId) {
  const job = _jobs.get(jobId);
  if (!job || !job.page) throw new Error('Job no encontrado o navegador cerrado');

  _broadcast(jobId, { status: 'extracting', msg: 'Leyendo contenido de la página...' });

  const config = getSiteConfig(job.url);

  // 1. Extractor DOM directo por sitio (sin IA) — más rápido y confiable
  if (config?.extract_fn) {
    try {
      _broadcast(jobId, { status: 'extracting', msg: '📋 Extrayendo datos de la tabla...' });
      const parsed = await config.extract_fn(job.page, job.patente);
      if (parsed) {
        job.result = parsed;
        job.status = 'done';
        const n   = parsed.multas?.length || 0;
        const msg = parsed.error_sitio ? `⚠ ${parsed.error_sitio}`
                  : parsed.sin_multas  ? '✓ No hay infracciones para esta patente'
                  : `✓ ${n} infracción(es) encontrada(s)`;
        _broadcast(jobId, { status: parsed.error_sitio ? 'site_error' : 'done', msg, result: parsed });
        return parsed;
      }
      _broadcast(jobId, { status: 'extracting', msg: '⚠ Extractor directo no encontró tabla — intentando con IA...' });
    } catch (e) {
      _broadcast(jobId, { status: 'extracting', msg: `⚠ Extractor directo falló (${e.message}) — usando IA...` });
    }
  }

  // 2. Extractor genérico de tablas HTML (sin IA)
  try {
    _broadcast(jobId, { status: 'extracting', msg: '📋 Intentando extraer tabla genérica...' });
    const genericResult = await _extractGenericTable(job.page, job.patente);
    if (genericResult) {
      job.result = genericResult;
      job.status = 'done';
      const n   = genericResult.multas?.length || 0;
      const msg = genericResult.sin_multas ? '✓ No hay infracciones para esta patente'
                : `✓ ${n} infracción(es) encontrada(s) (extracción genérica)`;
      _broadcast(jobId, { status: 'done', msg, result: genericResult });
      return genericResult;
    }
  } catch (e) { /* continuar con IA */ }

  // 3. Fallback: IA para páginas complejas / sin tabla estructurada
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('No se encontraron datos en la tabla y la IA no está configurada (falta ANTHROPIC_API_KEY). Verificá que la búsqueda muestre resultados antes de extraer.');
  }

  // Ejecutar pasos pre-extracción específicos del sitio (expandir acordeones, etc.)
  let siteActas = [];
  if (config?.pre_extract_fn) {
    try {
      siteActas = await config.pre_extract_fn(job.page, (status, msg) => _broadcast(jobId, { status, msg })) || [];
    } catch (e) {
      _broadcast(jobId, { status: 'extracting', msg: `⚠ Pre-extracción parcial: ${e.message}` });
    }
  }

  // Leer texto completo de la página
  let pageText = '';
  try {
    pageText = await job.page.evaluate(() => document.body.innerText);
  } catch (e) {
    throw new Error('No se pudo leer la página: ' + e.message);
  }
  if (!pageText.trim()) throw new Error('La página parece estar vacía');

  _broadcast(jobId, { status: 'ai_parsing', msg: '🤖 IA analizando resultados...' });

  const extraContext = siteActas.length > 0
    ? `\n\nDATOS ESTRUCTURADOS EXTRAÍDOS DEL DOM:\n${JSON.stringify(siteActas, null, 2).substring(0, 3000)}`
    : '';

  const prompt = `Analizá este contenido de una página web de consulta de infracciones de tránsito argentina para el vehículo con patente "${job.patente}".
Extraé TODAS las infracciones/multas encontradas.
Respondé ÚNICAMENTE con JSON válido, sin texto extra:
{
  "encontradas": true,
  "sin_multas": false,
  "error_sitio": null,
  "multas": [
    {
      "numero_acta": "",
      "fecha_infraccion": "",
      "hora_infraccion": "",
      "fecha_vencimiento": "",
      "descripcion": "",
      "articulo_infringido": "",
      "lugar": "",
      "monto": "",
      "puntos": "",
      "estado": "",
      "organismo": "",
      "prueba_urls": []
    }
  ]
}
Reglas:
- Fechas en YYYY-MM-DD. Hora en HH:MM.
- Monto como número sin símbolos ni puntos de miles (ej: 126255.00).
- estado: "pendiente", "pagada", "vencida" según lo que diga la página.
- prueba_urls: lista de URLs de fotos/videos de prueba si las hay.
- Si no hay multas → "sin_multas":true, "multas":[].
- Si la página muestra el formulario sin resultados o un error del sitio → ponelo en "error_sitio".
${extraContext}

TEXTO DE LA PÁGINA:
${pageText.substring(0, 6000)}`;

  let parsed;
  try {
    const res = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = res.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('Error de IA al parsear resultados: ' + e.message);
  }

  job.result = parsed;
  job.status = 'done';

  const n   = parsed.multas?.length || 0;
  const msg = parsed.error_sitio  ? `⚠ ${parsed.error_sitio}`
            : parsed.sin_multas   ? '✓ No hay infracciones para esta patente'
            : `✓ ${n} infracción(es) encontrada(s)`;
  const st  = parsed.error_sitio ? 'site_error' : 'done';

  _broadcast(jobId, { status: st, msg, result: parsed });
  return parsed;
}

/**
 * Extractor genérico: busca la tabla con más filas de datos y mapea columnas
 * por palabras clave en los encabezados. Sin IA.
 */
async function _extractGenericTable(page, patente) {
  return page.evaluate((pat) => {
    const tables = Array.from(document.querySelectorAll('table'));
    if (!tables.length) return null;

    // Elegir la tabla con más filas de datos
    const table = tables.reduce((best, t) => {
      const rows = t.querySelectorAll('tbody tr, tr').length;
      return rows > (best ? best.querySelectorAll('tbody tr, tr').length : 0) ? t : best;
    }, null);
    if (!table) return null;

    const headerRow = table.querySelector('thead tr, tr:first-child');
    if (!headerRow) return null;
    const headers = Array.from(headerRow.querySelectorAll('th, td')).map(h => h.innerText.trim().toLowerCase());

    const findCol = (...keywords) => {
      for (const kw of keywords) {
        const i = headers.findIndex(h => h.includes(kw));
        if (i >= 0) return i;
      }
      return -1;
    };

    const iActa   = findCol('causa', 'acta', 'número', 'numero', 'expediente');
    const iDesc   = findCol('infraccion', 'descripcion', 'infr', 'articu', 'motivo');
    const iFecha  = findCol('fecha');
    const iMonto  = findCol('monto', 'importe', 'multa $', 'valor');
    const iLugar  = findCol('lugar', 'direccion', 'calle');
    const iEstado = findCol('estado', 'situacion', 'pagada');

    if (iActa < 0 && iDesc < 0) return null; // no parece una tabla de multas

    const dataRows = Array.from(table.querySelectorAll('tbody tr, tr')).slice(1);
    const multas = [];

    dataRows.forEach(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
      if (cells.length < 2) return;

      const numero_acta   = iActa  >= 0 ? cells[iActa]  || '' : '';
      const descripcion   = iDesc  >= 0 ? cells[iDesc]  || '' : '';
      const fecha_raw     = iFecha >= 0 ? cells[iFecha] || '' : '';
      const monto_raw     = iMonto >= 0 ? cells[iMonto] || '' : '';
      const lugar         = iLugar >= 0 ? cells[iLugar] || '' : '';
      const estado_raw    = iEstado>= 0 ? cells[iEstado]|| '' : '';

      if (!numero_acta && !descripcion) return;

      // Normalizar fecha
      let fecha_infraccion = '';
      const dm = fecha_raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
      if (dm) {
        const y = dm[3].length === 2 ? '20' + dm[3] : dm[3];
        fecha_infraccion = `${y}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}`;
      }

      // Normalizar monto
      let monto = '';
      const montoClean = monto_raw.replace(/[^\d,\.]/g,'');
      if (montoClean) {
        // es-AR: "50.000,00" → 50000.00
        const asFloat = parseFloat(montoClean.replace(/\./g,'').replace(',','.'));
        if (!isNaN(asFloat)) monto = String(asFloat);
      }

      // Estado
      let estado = 'pendiente';
      if (/pagad/i.test(estado_raw)) estado = 'pagada';
      else if (/venci/i.test(estado_raw)) estado = 'vencida';

      multas.push({
        numero_acta:    numero_acta.replace(/\s+/g,' ').trim(),
        fecha_infraccion,
        descripcion:    descripcion.replace(/\s+/g,' ').replace(/^--/,'').trim(),
        lugar:          lugar.replace(/\s+/g,' ').trim(),
        monto,
        estado,
        organismo:      '',
        prueba_urls:    [],
      });
    });

    if (!multas.length) return null;
    return { encontradas: true, sin_multas: false, error_sitio: null, multas };
  }, patente);
}

async function cancelarJob(jobId) {
  const job = _jobs.get(jobId);
  if (!job) return;
  if (job.browser) await job.browser.close().catch(() => {});
  _jobs.delete(jobId);
}

module.exports = { iniciarVerificacion, extraerResultados, cancelarJob, getJob, addSseClient, removeSseClient };
