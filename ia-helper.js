// ia-helper.js — wrapper centralizado de llamadas a Anthropic con logging de tokens
const { getPool } = require('./database');

let _iaCredCache = null;
let _iaCredCacheAt = 0;
const IA_CACHE_TTL = 60_000;

async function _getActiveIACred() {
  const now = Date.now();
  if (_iaCredCache && (now - _iaCredCacheAt) < IA_CACHE_TTL) return _iaCredCache;
  try {
    const db = await getPool();
    const [[row]] = await db.query('SELECT * FROM credenciales_ia WHERE activa=1 ORDER BY id DESC LIMIT 1');
    _iaCredCache = row || null;
    _iaCredCacheAt = now;
    return _iaCredCache;
  } catch (_) { return null; }
}

function invalidateIACredCache() { _iaCredCache = null; _iaCredCacheAt = 0; }

const _TAREA_MODULO = {
  'extract-km': 'Turnos', 'extract-aceite': 'Turnos',
  'extract-gnc': 'Vehículos', 'extract-vtv': 'Vehículos', 'extract-seguro': 'Vehículos', 'extract-cedula': 'Vehículos',
  'extract-factura': 'Servicios', 'extract-multa': 'Multas',
  'extract-comprobante': 'Rendiciones', 'ocr-text': null,
};

async function callAI(tarea, messages, opts = {}) {
  const Anthropic = require('@anthropic-ai/sdk');
  const cred = await _getActiveIACred();
  const apiKey = cred?.api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No hay credencial de IA activa configurada.');
  const modelo = opts.model || cred?.modelo || 'claude-sonnet-4-6';
  const client = new Anthropic({ apiKey });
  const params = { model: modelo, max_tokens: opts.max_tokens || 1024, messages };
  if (opts.system) params.system = opts.system;
  const resp = await client.messages.create(params);
  // Log async — no bloquea la respuesta
  setImmediate(async () => {
    try {
      const db = await getPool();
      const inp  = resp.usage?.input_tokens  || 0;
      const out  = resp.usage?.output_tokens || 0;
      const pi   = cred?.precio_input  ?? 3;
      const po   = cred?.precio_output ?? 15;
      const costo = (inp * pi + out * po) / 1_000_000;
      const modulo = opts.modulo !== undefined ? opts.modulo : (_TAREA_MODULO[tarea] ?? null);
      await db.query(
        'INSERT INTO ia_log (credencial_id,tarea,modelo,input_tokens,output_tokens,costo_usd,modulo,entidad_id) VALUES (?,?,?,?,?,?,?,?)',
        [cred?.id || null, tarea, modelo, inp, out, costo, modulo, opts.entidad_id || null]
      );
    } catch (_) {}
  });
  return resp;
}

module.exports = { callAI, invalidateIACredCache };
