/**
 * scraper.js — Verificación automática de multas por patente
 * Modo AUTO: Obscura (headless, stealth) — sin Chrome, sin ventana.
 * Modo MANUAL: Puppeteer visible — para CAPTCHAs que requieren intervención.
 * Usa IA para parsear resultados cuando no hay extractor DOM directo.
 */
'use strict';

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const puppeteerCore = require('puppeteer-core');
const { spawn }     = require('child_process');
const Anthropic     = require('@anthropic-ai/sdk');

let _aiClient = null;
const client = { messages: { create: (...args) => { if (!_aiClient) _aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); return _aiClient.messages.create(...args); } } };

// ── Obscura server ────────────────────────────────────────────────────────────
const OBSCURA_PORT = 9223;
let _obscuraProc   = null;
let _obscuraPid    = null;

async function _startObscura() {
  // Ya está corriendo
  if (_obscuraProc && !_obscuraProc.killed) return true;

  const bin = process.env.OBSCURA_BIN || 'obscura';
  return new Promise(resolve => {
    try {
      const args = ['serve', '--port', String(OBSCURA_PORT), '--stealth', '--workers', '3'];
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      _obscuraProc = proc;
      _obscuraPid  = proc.pid;

      let resolved = false;
      const done = (ok) => { if (!resolved) { resolved = true; resolve(ok); } };

      // Obscura escribe en stderr cuando está listo
      proc.stderr.on('data', d => {
        const s = d.toString();
        if (s.includes(String(OBSCURA_PORT)) || s.includes('Listening') || s.includes('listening')) done(true);
      });
      proc.on('error', () => done(false));
      proc.on('exit',  () => { _obscuraProc = null; done(false); });

      // Timeout generoso — primera vez V8 puede tardar
      setTimeout(() => done(true), 5000);
    } catch { resolve(false); }
  });
}

async function _connectObscura() {
  return puppeteerCore.connect({
    browserWSEndpoint: `ws://127.0.0.1:${OBSCURA_PORT}/devtools/browser`,
    defaultViewport: null,
  });
}

function stopObscura() {
  if (_obscuraProc && !_obscuraProc.killed) {
    _obscuraProc.kill();
    _obscuraProc = null;
  }
}

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
    waitUntil: 'networkidle2',
    renderDelay: 2000,
    captcha_selector: '.g-recaptcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]',
    plate_fn: async (page, patente, send) => {
      // 1. Esperar a que Cloudflare Turnstile termine (desaparece el iframe de verificación)
      send('waiting_cf', '⏳ Esperando verificación Cloudflare...');
      await page.waitForFunction(
        () => {
          const cf = document.querySelector('iframe[src*="challenges.cloudflare"], .cf-turnstile iframe, #cf-turnstile iframe');
          if (!cf) return true; // no hay Turnstile, ok
          // Turnstile resuelto: el iframe desaparece o aparece el formulario real
          const input = document.querySelector('input[type="text"], input[placeholder]');
          return !!input;
        },
        { timeout: 60000, polling: 1000 }
      ).catch(() => {});

      await new Promise(r => setTimeout(r, 800));

      // 2. Click en tab "Dominio" si existe (React tabs)
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="tab"], .tab, .btn'));
        const domBtn = btns.find(b => /\bdominio\b/i.test(b.textContent));
        if (domBtn) domBtn.click();
      });
      await new Promise(r => setTimeout(r, 600));

      // 3. Llenar el campo con setter React-compatible
      const filled = await page.evaluate((pat) => {
        const inp = document.querySelector('input[type="text"], input[placeholder*="dominio" i], input[placeholder*="patente" i], input[name*="dominio" i]');
        if (!inp) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(inp, pat);
        inp.dispatchEvent(new Event('input',  { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.focus();
        return true;
      }, patente);

      if (filled) return true;

      // 4. Fallback: tipeo real
      return await _fillBySelectors(page, patente, [
        'input[type="text"]', 'input[name*="dominio" i]', 'input[placeholder*="dominio" i]',
      ]);
    },
  },

  'buenosaires.gob.ar': {
    nombre: 'CABA',
    waitUntil: 'networkidle2',
    renderDelay: 3000,
    captcha_selector: '.g-recaptcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]',
    plate_fn: async (page, patente, send) => {
      // Esperar a que React renderice el formulario
      await page.waitForFunction(
        () => document.body.innerText.trim() !== 'default' && document.querySelector('input'),
        { timeout: 15000 }
      ).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));

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

async function iniciarVerificacion(jobId, url, patente, modo) {
  // modo: 'auto' = forzar Obscura, 'manual' = forzar Chrome visible, undefined = auto-detectar
  if (_jobs.has(jobId)) return;
  _jobs.set(jobId, { browser: null, page: null, status: 'starting', msgs: [], result: null, sseClients: [], patente, url, modo: 'manual' });

  const obscuraBin = process.env.OBSCURA_BIN;
  const useObscura = modo === 'auto' || (modo !== 'manual' && !!obscuraBin);

  if (useObscura && !obscuraBin) {
    _broadcast(jobId, { status: 'error', msg: '✗ Obscura no configurado — establecé OBSCURA_BIN en .env' });
    const j = _jobs.get(jobId); if (j) j.status = 'error';
    return;
  }

  if (useObscura) {
    _runJobObscura(jobId, url, patente).catch(err => {
      const job = _jobs.get(jobId);
      if (!job || job.status === 'done') return;
      if (modo === 'auto') {
        // forzado: no fallback, reportar error
        _broadcast(jobId, { status: 'error', msg: `✗ Obscura falló: ${err.message}` });
        if (job) job.status = 'error';
      } else {
        // auto-detect: fallback al navegador visible
        _broadcast(jobId, { status: 'fallback', msg: `🔄 Auto no disponible (${err.message}) — abriendo navegador...` });
        if (job) { job.page = null; job.browser = null; job.modo = 'manual'; }
        _runJob(jobId, url, patente).catch(e => {
          _broadcast(jobId, { status: 'error', msg: `Error: ${e.message}` });
          const j = _jobs.get(jobId); if (j) j.status = 'error';
        });
      }
    });
  } else {
    _runJob(jobId, url, patente).catch(err => {
      _broadcast(jobId, { status: 'error', msg: `Error: ${err.message}` });
      const j = _jobs.get(jobId); if (j) j.status = 'error';
    });
  }
}

// ── Flujo automático con Obscura (headless + stealth) ────────────────────────
async function _runJobObscura(jobId, url, patente) {
  const send = (status, msg) => {
    const job = _jobs.get(jobId);
    if (job) job.status = status;
    _broadcast(jobId, { status, msg });
  };

  send('starting', '🤖 Iniciando verificación automática (Obscura)...');

  const started = await _startObscura();
  if (!started) throw new Error('Obscura no disponible');

  // Breve pausa para que el server esté aceptando conexiones
  await new Promise(r => setTimeout(r, 1200));

  const browser = await _connectObscura();
  const page    = await browser.newPage();

  const job = _jobs.get(jobId);
  job.browser = browser;
  job.page    = page;
  job.modo    = 'auto';

  try {
    send('navigating', `Navegando a ${url}...`);
    const _sConf = getSiteConfig(url);
    await page.goto(url, { waitUntil: _sConf?.waitUntil || 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, _sConf?.renderDelay ?? 1500));

    const config = getSiteConfig(url);
    const captchaSel = config?.captcha_selector || '.g-recaptcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]';

    // Verificar CAPTCHA antes de intentar llenar
    const hasCaptcha = await page.$(captchaSel).then(el => !!el).catch(() => false);
    if (hasCaptcha) throw new Error('CAPTCHA detectado — requiere intervención manual');

    send('filling', `Completando patente "${patente}"...`);
    let filled = false;
    if (config?.plate_fn) {
      filled = await config.plate_fn(page, patente, send);
    } else {
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
    if (!filled) throw new Error('No se encontró el campo de patente');

    send('submitting', 'Enviando formulario...');
    const submitted = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"], button'));
      const btn  = btns.find(b => /buscar|consultar|verificar|enviar|search/i.test((b.textContent || '') + (b.value || '')));
      if (btn) { btn.click(); return true; }
      const form = document.querySelector('form');
      if (form) { form.submit(); return true; }
      return false;
    });
    if (!submitted) throw new Error('No se encontró botón de envío');

    // Esperar navegación o carga dinámica
    send('waiting', 'Esperando resultados...');
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }),
      new Promise(r => setTimeout(r, 8000)),
    ]).catch(() => {});
    await new Promise(r => setTimeout(r, 800));

    // CAPTCHA post-submit
    const hasCaptchaAfter = await page.$(captchaSel).then(el => !!el).catch(() => false);
    if (hasCaptchaAfter) throw new Error('CAPTCHA apareció tras enviar — requiere intervención manual');

    // Extraer con los mismos extractores existentes
    send('extracting', 'Extrayendo resultados automáticamente...');
    const result = await _extractResult(jobId, page);

    job.status = 'done';
    job.result = result;
    const n   = result.multas?.length || 0;
    const msg = result.error_sitio ? `⚠ ${result.error_sitio}`
              : result.sin_multas  ? '✓ Sin infracciones para esta patente'
              : `✓ ${n} infracción(es) encontrada(s) [modo automático]`;
    _broadcast(jobId, { status: result.error_sitio ? 'site_error' : 'done', msg, result, modo: 'auto' });
    return result;

  } finally {
    await page.close().catch(() => {});
    await browser.disconnect().catch(() => {});
  }
}

// Extractor interno compartido (sin depender del job.page mutable)
async function _extractResult(jobId, page) {
  const job    = _jobs.get(jobId);
  const config = getSiteConfig(job.url);

  if (config?.extract_fn) {
    try {
      const r = await config.extract_fn(page, job.patente);
      if (r) return r;
    } catch {}
  }

  const generic = await _extractGenericTable(page, job.patente);
  if (generic) return generic;

  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Sin tabla y sin ANTHROPIC_API_KEY para parsear con IA');

  let siteActas = [];
  if (config?.pre_extract_fn) {
    try { siteActas = await config.pre_extract_fn(page, (s, m) => _broadcast(jobId, { status: s, msg: m })) || []; } catch {}
  }

  const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
  if (!pageText.trim()) throw new Error('Página vacía');

  _broadcast(jobId, { status: 'ai_parsing', msg: '🤖 IA analizando resultados...' });

  const extraCtx = siteActas.length ? `\n\nDOM:\n${JSON.stringify(siteActas).substring(0, 3000)}` : '';
  const prompt = `Analizá este contenido de una página de infracciones de tránsito argentina para la patente "${job.patente}".
Respondé SOLO con JSON válido:
{"encontradas":true,"sin_multas":false,"error_sitio":null,"multas":[{"numero_acta":"","fecha_infraccion":"","hora_infraccion":"","fecha_vencimiento":"","descripcion":"","articulo_infringido":"","lugar":"","monto":"","puntos":"","estado":"","organismo":"","prueba_urls":[]}]}
Fechas: YYYY-MM-DD. Monto: número sin puntos de miles. estado: pendiente/pagada/vencida. Si no hay multas → sin_multas:true.${extraCtx}
TEXTO:
${pageText.substring(0, 6000)}`;

  const res = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] });
  const raw = res.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(raw);
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
    const siteConf = getSiteConfig(url);
    const waitUntil = siteConf?.waitUntil || 'domcontentloaded';
    await page.goto(url, { waitUntil, timeout: 45000 });

    // Esperar renderizado JS (más para SPAs)
    await new Promise(r => setTimeout(r, siteConf?.renderDelay ?? 1200));

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

  // Modo auto: el resultado ya fue extraído por _runJobObscura
  if (job.modo === 'auto' && job.result) return job.result;

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

// ── ARCA: Scraping "Mis Comprobantes" ────────────────────────────────────────
// ── Helper interno: login AFIP + nav a portal ARCA ───────────────────────────
async function _arcaLogin(cuit, clave, log) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

  const screenshot = async (name) => page.screenshot({ path: `./scraper-debug-${name}.png` }).catch(()=>{});

  log('Navegando al login AFIP...');
  await page.goto('https://auth.afip.gob.ar/contribuyente/login.xhtml', { waitUntil: 'networkidle2', timeout: 30000 });
  await screenshot('1-login');

  await page.waitForSelector('#F1\\:username', { timeout: 10000 });
  await page.type('#F1\\:username', String(cuit).replace(/[-\s]/g, ''));
  await page.click('#F1\\:btnSiguiente');
  log('CUIT ingresado, esperando campo de clave...');
  await page.waitForSelector('#F1\\:password', { timeout: 10000 });
  await screenshot('2-password');

  await page.type('#F1\\:password', clave);
  await page.click('#F1\\:btnIngresar');
  log('Clave ingresada, esperando redirect...');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
  await screenshot('3-post-login');

  if (page.url().includes('login') || page.url().includes('error')) {
    await browser.close();
    throw new Error('Login fallido — verificar CUIT/clave. URL: ' + page.url());
  }
  log('Login OK → ' + page.url());

  // Buscar "Mis Comprobantes" en el portal donde aterrizó el login (portalcf o arca)
  await screenshot('4-portal-post-login');

  const _clickMisComprobantes = async () => {
    const h = await page.evaluateHandle(() => {
      const all = Array.from(document.querySelectorAll('a, button, span, div, td, li'));
      return all.find(el => {
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        return t === 'mis comprobantes' || t.startsWith('mis comprobantes');
      }) || null;
    });
    const el = h.asElement();
    if (!el) return false;
    log('Clickeando "Mis Comprobantes"...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(()=>{}),
      el.click(),
    ]);
    await screenshot('5-after-mc-click');
    log('Redirigido a → ' + page.url());
    return true;
  };

  // Intentar en la página actual (portalcf)
  let found = await _clickMisComprobantes();

  // Fallback: ir al portal público y buscar ahí
  if (!found) {
    log('No encontrado en portalcf, probando www.arca.gob.ar...');
    await page.goto('https://www.arca.gob.ar/', { waitUntil: 'networkidle2', timeout: 30000 });
    await screenshot('4b-arca-publica');
    found = await _clickMisComprobantes();
  }

  if (!found) {
    log('⚠ "Mis Comprobantes" no encontrado — navegando directo (puede fallar sesión)');
  }

  return { browser, page, screenshot };
}

// ── Helper interno: filtrar fechas y extraer tabla (con paginación) ───────────
async function _arcaFiltrarYExtraer(page, screenshot, url, fechaDesde, fechaHasta, log, mapRow) {
  log(`Navegando a ${url}...`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await screenshot('6-target-page');

  if (page.url().includes('login') || page.url().includes('auth.afip')) {
    throw new Error('Sesión no persistió. URL: ' + page.url());
  }

  // Debug: inputs disponibles
  const formDebug = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input,select')).map(e => ({ id: e.id, name: e.name, type: e.type, value: e.value.slice(0,30) }))
  );
  log('Inputs: ' + JSON.stringify(formDebug));

  const _toAR = (iso) => { const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; };
  const fmtDesde = _toAR(fechaDesde);
  const fmtHasta = _toAR(fechaHasta);
  const rangeVal = `${fmtDesde} - ${fmtHasta}`;

  // ARCA usa un range picker único: "DD/MM/YYYY - DD/MM/YYYY"
  // Estrategia: (1) buscar input con value que ya contenga " - " o placeholder similar
  //             (2) intentar con hidden inputs separados como fallback
  const fechaSet = await page.evaluate((range, desde, hasta) => {
    // Buscar range picker (input único con guión)
    const rangePickers = Array.from(document.querySelectorAll('input')).filter(e =>
      (e.value && e.value.includes(' - ')) ||
      (e.placeholder && e.placeholder.includes(' - ')) ||
      e.id.toLowerCase().includes('fecha') || e.name.toLowerCase().includes('fecha')
    );
    if (rangePickers.length > 0) {
      const rp = rangePickers[0];
      rp.value = range;
      rp.dispatchEvent(new Event('input',  { bubbles: true }));
      rp.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: 'range', id: rp.id, name: rp.name };
    }
    // Fallback: dos campos separados
    const candidates = Array.from(document.querySelectorAll('input[type="text"],input:not([type])'));
    const d1 = candidates.find(e => /desde|inicio|from|start/i.test(e.id + e.name));
    const d2 = candidates.find(e => /hasta|fin|to|end/i.test(e.id + e.name));
    if (d1) { d1.value = desde; d1.dispatchEvent(new Event('change', {bubbles:true})); }
    if (d2) { d2.value = hasta; d2.dispatchEvent(new Event('change', {bubbles:true})); }
    return { found: 'split', d1: d1?.id, d2: d2?.id };
  }, rangeVal, fmtDesde, fmtHasta);
  log('Fecha set: ' + JSON.stringify(fechaSet));
  await screenshot('7-after-dates');

  // Clickear BUSCAR
  const btnBuscar = await page.evaluateHandle(() => {
    const btns = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],a'));
    return btns.find(b => /buscar/i.test(b.textContent || b.value || b.innerText)) || null;
  });
  const btnEl = btnBuscar.asElement();
  if (btnEl) {
    log('Clickeando BUSCAR...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(()=>{}),
      btnEl.click(),
    ]);
  }
  await screenshot('8-results-p1');

  // ── Extraer todas las páginas ─────────────────────────────────────────────
  const allRows = [];
  let pageNum = 1;

  const extractTableRows = () => page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    // Buscar la tabla de datos (la que tenga más columnas)
    const dataTable = tables.reduce((best, t) => {
      const cols = (t.querySelector('tr')?.querySelectorAll('th,td')?.length || 0);
      return cols > (best?.querySelector('tr')?.querySelectorAll('th,td')?.length || 0) ? t : best;
    }, null);
    if (!dataTable) return [];
    const rows = Array.from(dataTable.querySelectorAll('tr')).slice(1); // skip header
    return rows.map(tr => {
      const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
      return tds.length >= 3 ? tds : null;
    }).filter(Boolean);
  });

  while (true) {
    const pageRows = await extractTableRows();
    log(`Página ${pageNum}: ${pageRows.length} filas`);
    allRows.push(...pageRows);

    // Buscar botón "siguiente" de la paginación
    const nextBtn = await page.evaluateHandle(() => {
      const links = Array.from(document.querySelectorAll('a, button'));
      return links.find(el => {
        const txt = (el.textContent || el.innerText || '').trim();
        return txt === '»' || txt === '>' || txt === 'Siguiente' || txt === 'Next' ||
               el.getAttribute('aria-label') === 'Next' ||
               (el.className && /next|siguiente/i.test(el.className));
      }) || null;
    });
    const nextEl = nextBtn.asElement();
    if (!nextEl) break;

    // Verificar que no esté deshabilitado
    const disabled = await page.evaluate(el =>
      el.disabled || el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true'
    , nextEl);
    if (disabled) break;

    pageNum++;
    log(`Navegando a página ${pageNum}...`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(()=>{}),
      nextEl.click(),
    ]);
    await new Promise(r => setTimeout(r, 500));
  }

  await screenshot('9-results-final');
  log(`Total extraído: ${allRows.length} filas en ${pageNum} página(s)`);
  return allRows.map(mapRow);
}

async function scrapearComprobantesRecibidos(cuit, clave, fechaDesde, fechaHasta, onProgress) {
  const log = msg => { console.log(`[ARCA scraper recibidos] ${msg}`); if (onProgress) onProgress(msg); };
  const { browser, page, screenshot } = await _arcaLogin(cuit, clave, log);
  try {
    const rows = await _arcaFiltrarYExtraer(
      page, screenshot,
      'https://fes.afip.gob.ar/mcmp/jsp/comprobantesRecibidos.do',
      fechaDesde, fechaHasta, log,
      (tds) => ({
        fecha:         tds[0] || null,
        tipo:          tds[1] || null,
        numero:        tds[2] || null,
        cuit_emisor:   tds[3] || null,
        nombre_emisor: tds[4] || null,
        importe:       tds[5] || null,
        raw:           tds,
      })
    );
    log(`Encontrados: ${rows.length} comprobantes recibidos`);
    return rows;
  } finally {
    await browser.close();
  }
}

async function scrapearComprobantesEmitidos(cuit, clave, fechaDesde, fechaHasta, onProgress) {
  const log = msg => { console.log(`[ARCA scraper emitidos] ${msg}`); if (onProgress) onProgress(msg); };
  const { browser, page, screenshot } = await _arcaLogin(cuit, clave, log);
  try {
    const rows = await _arcaFiltrarYExtraer(
      page, screenshot,
      'https://fes.afip.gob.ar/mcmp/jsp/comprobantesEmitidos.do',
      fechaDesde, fechaHasta, log,
      (tds) => {
        // Tabla web: Fecha | Tipo | Número (PV-NRO) | Denominación Receptor | Imp. Total
        const numero = tds[2] || null; // "00003-00000015"
        const [pvStr, nroStr] = (numero || '').split('-');
        return {
          fecha:                 tds[0] || null,
          tipo:                  tds[1] || null,  // "11 - Factura C"
          numero,
          pto_venta:             parseInt((pvStr||'').replace(/\D/g,'')) || null,
          nro_comprobante:       parseInt((nroStr||'').replace(/\D/g,'')) || null,
          denominacion_receptor: tds[3] || null,
          importe:               tds[4] || null,
          raw:                   tds,
        };
      }
    );
    log(`Encontrados: ${rows.length} comprobantes emitidos`);
    return rows;
  } finally {
    await browser.close();
  }
}

module.exports = { iniciarVerificacion, extraerResultados, cancelarJob, getJob, addSseClient, removeSseClient, stopObscura, scrapearComprobantesRecibidos, scrapearComprobantesEmitidos };
