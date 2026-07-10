const { callAI } = require('./ia-helper');

const _parse = (text) => {
  const clean = text.trim().replace(/^```json\s*/,'').replace(/\s*```$/,'');
  return JSON.parse(clean);
};

async function extractCedulaData(frenteBuffer, frenteMime, dorsoBuffer, dorsoMime) {
  const content = [
    { type: 'text', text: `Sos un sistema de extracción de datos de cédulas de vehículos argentinas.
Analizá las imágenes (frente y dorso de la cédula) y extraé TODOS los datos disponibles.
Respondé ÚNICAMENTE con JSON válido, sin texto extra:
{
  "patente": "",
  "chasis": "",
  "motor": "",
  "marca": "",
  "modelo": "",
  "color": "",
  "tipo_vehiculo": "",
  "uso": "",
  "titular_nombre": "",
  "titular_dni": "",
  "titular_domicilio": ""
}
Dejá vacío lo que no puedas leer.` },
    { type: 'image', source: { type: 'base64', media_type: frenteMime, data: frenteBuffer.toString('base64') } }
  ];
  if (dorsoBuffer) {
    content.push({ type: 'image', source: { type: 'base64', media_type: dorsoMime, data: dorsoBuffer.toString('base64') } });
  }
  const res = await callAI('extract-cedula', [{ role: 'user', content }], { max_tokens: 512 });
  return _parse(res.content[0].text);
}

async function extractGncData(buffer, mimeType) {
  const res = await callAI('extract-gnc', [{
    role: 'user', content: [
      { type: 'text', text: `Sos un sistema de lectura de documentos argentinos. Analizá esta imagen de una CÉDULA MERCOSUR PARA USO DE GAS NATURAL COMO COMBUSTIBLE VEHICULAR (oblea GNC).

El documento tiene estas secciones en orden de arriba hacia abajo:
1. VEHICULO: MARCA, MODELO, DOMINIO/MATRÍCULA/PLACA, N°OBLEA/SELLO
2. REGULADOR DE PRESION: MARCA/MODELO/CID, N°DE SERIE
3. CILINDRO/S: una o más filas, cada una con MARCA/MODELO/CID, N°DE SERIE, Vto.MM/AA
4. VENCIMIENTO: recuadro naranja/rojo en la parte inferior izquierda con MM/AA
5. TALLER DE MONTAJE: código alfanumérico (ej: GUT0601, LET0070)
6. Número de certificado ENARGAS (abajo, ej: AR31319311)

Respondé ÚNICAMENTE con JSON válido, sin texto extra ni markdown:
{
  "numero_oblea": "",
  "taller": "",
  "regulador_marca": "",
  "regulador_serie": "",
  "vigencia_desde": "",
  "vigencia_hasta": "",
  "cilindros": [
    { "marca": "", "serie": "", "vto": "" }
  ]
}

Reglas de extracción:
- numero_oblea: número de 8 dígitos del campo N°OBLEA/SELLO (sección VEHICULO). Ej: "48118365".
- taller: código alfanumérico del TALLER DE MONTAJE. Ej: "GUT0601".
- regulador_marca: código del campo MARCA/MODELO/CID bajo REGULADOR DE PRESION. Ej: "FE03", "KM01".
- regulador_serie: número del campo N°DE SERIE del regulador. Ej: "T02714".
- vigencia_hasta: fecha del recuadro VENCIMIENTO inferior (MM/AA → último día del mes, formato YYYY-MM-DD). Ej: "11/26" → "2026-11-30".
- vigencia_desde: generalmente no figura, dejá vacío.
- cilindros: array de TODOS los cilindros (1 a 4 filas bajo CILINDRO/S):
  - marca: código MARCA/MODELO/CID. Ej: "KI87".
  - serie: número N°DE SERIE. Ej: "704406".
  - vto: Vto. del cilindro (prueba hidráulica, MM/AA → último día del mes, formato YYYY-MM-DD). Ej: "10/28" → "2028-10-31".
- Si un campo no es legible, dejá cadena vacía.` },
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } }
    ]
  }], { max_tokens: 600 });
  return _parse(res.content[0].text);
}

async function extractSeguroData(content, isImage, mimeType) {
  const userContent = [
    { type: 'text', text: `Analizá este documento de póliza de seguro de vehículo argentino.
Respondé ÚNICAMENTE con JSON válido, sin texto extra:
{"compania":"","nro_poliza":"","vigencia_desde":"","vigencia_hasta":""}
- compania: nombre de la aseguradora (ej: "La Mercantil Andina S.A.", "MAPFRE", "Sancor Seguros").
- nro_poliza: número de póliza o certificado (solo el número, sin prefijos).
- vigencia_desde / vigencia_hasta: fechas en formato YYYY-MM-DD. Las pólizas argentinas pueden usar DD/MM/AAAA, DD-MM-AAAA o DD.MM.AAAA — convertí siempre a YYYY-MM-DD.
  Buscá frases como "Vigencia del", "Desde la 12hs. del", "Hasta las 12hs. del", "Vigencia::", "Período", "Desde", "Hasta".
Dejá vacío lo que no puedas leer.` }
  ];
  if (isImage) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: content } });
  } else {
    userContent.push({ type: 'text', text: `\nContenido del PDF:\n${content}` });
  }
  const res = await callAI('extract-seguro', [{ role: 'user', content: userContent }], { max_tokens: 256 });
  return _parse(res.content[0].text);
}

async function extractVtvData(content, isImage, mimeType) {
  const userContent = [
    { type: 'text', text: `Analizá este documento de VTV/RTV (Verificación/Revisión Técnica Vehicular) argentina.
Respondé ÚNICAMENTE con JSON válido, sin texto adicional ni markdown:
{
  "patente": "",
  "nro_inspeccion": "",
  "nro_oblea": "",
  "fecha_inspeccion": "",
  "vigencia_desde": "",
  "vigencia_hasta": "",
  "resultado": "",
  "planta": ""
}
Reglas:
- patente/dominio: campo "Dominio" o "Patente" (ej: "AC930MT").
- nro_inspeccion: campo "INFORME DE INSPECCIÓN Nº", "Nº Informe" o similar (ej: "1734813"). Si no aparece, dejá vacío.
- nro_oblea: campo "OBLEA Nº", "Oblea N°" o número que aparece como "N074948" cerca de la palabra Oblea (solo dígitos, sin letras).
- fecha_inspeccion: campo "Fecha de Inspección", "FECHA" o "Fecha Inspección" (ej: "18-10-2025" → "2025-10-18").
- vigencia_desde: campo "Desde", "Válido desde" o fecha de inspección si no hay otro campo (YYYY-MM-DD).
- vigencia_hasta: campo "Fecha de Vencimiento", "Válido para circular hasta", "Hasta" o "Vencimiento" (ej: "17-10-2026" → "2026-10-17").
- resultado: "apto", "condicional" o "rechazado". Si el certificado dice "cumple" o "aprobado" → "apto".
- planta: nombre del taller o planta (ej: "RTV Lomas de Zamora", "RTV Buenos Aires").
- Fechas siempre en formato YYYY-MM-DD. Dejá vacío lo que no encuentres.` }
  ];
  if (isImage) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: content } });
  } else {
    userContent.push({ type: 'text', text: `\nContenido del documento:\n${content}` });
  }
  const res = await callAI('extract-vtv', [{ role: 'user', content: userContent }], { max_tokens: 400 });
  return _parse(res.content[0].text);
}

async function extractFacturaData(content, isImage, mimeType) {
  const userContent = [
    { type: 'text', text: `Analizá este documento. Puede ser una factura, remito, comprobante de pago o comprobante de transferencia bancaria/digital argentino.
Respondé ÚNICAMENTE con JSON válido, sin texto adicional:
{
  "tipo_comprobante": "",
  "numero_factura": "",
  "fecha_emision": "",
  "proveedor_nombre": "",
  "proveedor_cuit": "",
  "condicion_fiscal": "",
  "tipo_autorizacion": "",
  "nro_autorizacion": "",
  "vto_autorizacion": "",
  "subtotal": "",
  "iva": "",
  "total": "",
  "descripcion_items": "",
  "cuil_origen": "",
  "nombre_origen": "",
  "cbu_origen": "",
  "alias_origen": "",
  "cuil_destino": "",
  "nombre_destino": "",
  "cbu_destino": "",
  "alias_destino": "",
  "banco_origen": "",
  "banco_destino": "",
  "motivo": "",
  "nro_operacion": "",
  "codigo_identificacion": ""
}

REGLAS PARA TRANSFERENCIAS (BNA+, Mercado Pago, Brubank, Galicia, etc.):
- "Destinatario" o "Receptor" → nombre_destino. El CUIT/CUIL asociado → cuil_destino. El "Alias" → alias_destino. El "Banco" del destinatario → banco_destino.
- "Ordenante" o "Remitente" o quien envía → nombre_origen. Su CUIT/CUIL → cuil_origen. Su alias → alias_origen. Su banco → banco_origen.
- En recibos BNA+: el campo "Destinatario" con su CUIT y Alias corresponden al DESTINO, NO al origen.
- En comprobantes Mercado Pago: la sección "Para" o "Para (Destino)" contiene el DESTINATARIO (nombre_destino, cuil_destino, banco_destino). El campo "CBU:" dentro de "Para" → cbu_destino. El campo "CVU:" dentro de "De" → cbu_origen.
- cbu_origen / cbu_destino: CVU (22 dígitos, empieza con 0000) o CBU (22 dígitos). SIEMPRE extraer si está presente bajo la sección correspondiente.
- alias_destino / alias_origen: texto tipo nombre.apellido.banco (ej: seba.stasiu.buepp) o el alias que aparezca en la sección de destino/origen.
- codigo_identificacion: código alfanumérico del comprobante (ej: R7Z6OQNDWIGOGERESEXYPO).
- total: monto transferido o total, solo dígitos y punto decimal (sin separadores de miles, sin $).
- nro_operacion: número de transacción o número de operación del comprobante.
- fecha_emision: en formato YYYY-MM-DD HH:MM:SS si tiene hora, o YYYY-MM-DD si solo tiene fecha. Convertí "DD/MM/AAAA HH:MM:SS" al formato ISO.
- tipo_autorizacion: "CAE" si dice CAE, "CAEA" si dice CAEA, "CAI" si dice CAI. Solo facturas electrónicas argentinas tienen esto.
- nro_autorizacion: número del CAE/CAEA/CAI (hasta 14 dígitos).
- vto_autorizacion: fecha de vencimiento del CAE/CAEA/CAI en formato YYYY-MM-DD.
- Dejá vacío lo que no encuentres.` }
  ];
  if (isImage) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: content } });
  } else {
    userContent.push({ type: 'text', text: `\nContenido del documento:\n${content}` });
  }
  const res = await callAI('extract-factura', [{ role: 'user', content: userContent }], { max_tokens: 600 });
  return _parse(res.content[0].text);
}

async function extractMultaData(content, isImage, mimeType) {
  const userContent = [
    { type: 'text', text: `Sos un sistema de extracción de datos de infracciones/multas de tránsito argentinas. Analizá el documento completo (boleta, acta, notificación postal, cédula de intimación, resolución, etc.) de cualquier jurisdicción argentina (CABA, Provincia de Buenos Aires, municipios, DNRPA, DNRT, ANSES, u otros organismos).

REGLAS:
- Respondé ÚNICAMENTE con JSON válido, sin texto adicional ni markdown.
- Fechas SIEMPRE en formato YYYY-MM-DD (convertí DD/MM/YYYY → YYYY-MM-DD).
- Hora en formato HH:MM (24 hs). Si dice "22:11 hs" → "22:11".
- Monto: número sin símbolo de moneda, sin puntos de miles, con punto decimal (ej: "166125.00"). Si hay múltiples montos, tomá el TOTAL a pagar.
- Puntos: número entero. Si no hay puntos, dejá vacío.
- patente: sólo la matrícula del vehículo, sin espacios (ej: "AC930MT", "ABC123").
- numero_acta: código/número de expediente/acta/infracción/boleta. Puede empezar con letras (ej: "Q36809776", "F-123456").
- fecha_vencimiento: fecha límite de pago, o fecha de vencimiento de la infracción.
- lugar: dirección o intersección donde ocurrió la infracción.
- articulo_infringido: artículo(s) de la norma violada (ej: "Art. 77 inc. c Ley 24449").
- descripcion: motivo de la infracción en texto claro (ej: "Exceso de velocidad: 71 km/h en zona de 60 km/h").
- nombre_infractor: nombre completo del conductor/titular.
- dni_infractor: DNI/CUIL/CUIT del infractor (sólo números, sin guiones).
- organismo: nombre del organismo emisor (ej: "Municipalidad de Avellaneda", "DNRPA", "Secretaría de Transporte").
- municipalidad: ciudad/partido/municipio donde ocurrió la infracción.
- codigo_seguimiento_postal: código de seguimiento postal si es notificación por correo.
- notas: cualquier dato relevante que no encaje en los campos anteriores (estado, observaciones del agente, etc.).

JSON a completar (dejá vacío "" lo que no encuentres):
{
  "numero_acta": "",
  "fecha_infraccion": "",
  "hora_infraccion": "",
  "fecha_vencimiento": "",
  "patente": "",
  "descripcion": "",
  "articulo_infringido": "",
  "lugar": "",
  "monto": "",
  "puntos": "",
  "nombre_infractor": "",
  "dni_infractor": "",
  "organismo": "",
  "municipalidad": "",
  "codigo_seguimiento_postal": "",
  "notas": ""
}` }
  ];
  if (mimeType === 'application/pdf') {
    // PDF como documento — Claude lo lee visualmente (cubre PDFs escaneados sin capa de texto)
    userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: content } });
  } else if (isImage) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: content } });
  } else {
    userContent.push({ type: 'text', text: `\nContenido del documento:\n${content}` });
  }
  const res = await callAI('extract-multa', [{ role: 'user', content: userContent }], { max_tokens: 900 });
  return _parse(res.content[0].text);
}

async function extractTextFromImage(bufferOrText, mimeType) {
  const isBuffer = Buffer.isBuffer(bufferOrText);
  const isPdf = isBuffer && mimeType === 'application/pdf';
  let userContent;
  if (isPdf) {
    userContent = [
      { type: 'text', text: 'Transcribí todo el texto visible en este documento, tal como aparece, manteniendo la estructura (saltos de línea, secciones, tablas). No interpretes ni traduzcas — solo transcribí el contenido exacto.' },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bufferOrText.toString('base64') } }
    ];
  } else if (isBuffer) {
    userContent = [
      { type: 'text', text: 'Transcribí todo el texto visible en esta imagen, tal como aparece, manteniendo la estructura (saltos de línea, columnas). No interpretes ni traduzcas — solo transcribí.' },
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: bufferOrText.toString('base64') } }
    ];
  } else {
    userContent = [
      { type: 'text', text: `Transcribí y organizá el siguiente texto extraído de un PDF, manteniendo la estructura. No interpretes ni agregues datos:\n\n${bufferOrText}` }
    ];
  }
  const res = await callAI('ocr-text', [{ role: 'user', content: userContent }], { max_tokens: 1024 });
  return res.content[0].text.trim();
}

async function extractAceiteData(buffer, mimeType, opts = {}) {
  const userContent = [
    { type: 'text', text: `Analizá esta foto de la varilla de nivel de aceite (dipstick) de un vehículo.
Respondé ÚNICAMENTE con JSON válido, sin texto adicional:
{
  "nivel": "",
  "observacion": ""
}
REGLAS:
- "nivel": usá uno de estos valores exactos: "normal", "bajo", "alto", "sin_aceite".
  - "normal": la marca de aceite en la varilla está entre MIN y MAX, zona segura.
  - "bajo": el nivel está por debajo del mínimo, requiere atención urgente.
  - "alto": el nivel supera el máximo.
  - "sin_aceite": la varilla aparece completamente seca, sin rastro de aceite.
  - Si no se puede determinar claramente, usá "normal" con observacion explicando la duda.
- "observacion": descripción breve y concisa del estado visual (ej: "Varilla limpia entre marcas MIN/MAX", "Aceite oscuro y sucio bajo el mínimo"). Máx 80 caracteres. Vacío si no hay nada relevante que agregar.` },
    { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } }
  ];
  const res = await callAI('extract-aceite', [{ role: 'user', content: userContent }], { max_tokens: 100, modulo: opts.modulo || 'Turnos', entidad_id: opts.entidad_id || null });
  return _parse(res.content[0].text);
}

async function extractKmData(buffer, mimeType, opts = {}) {
  const userContent = [
    { type: 'text', text: `Analizá esta foto del tablero/odómetro de un vehículo.
Respondé ÚNICAMENTE con JSON válido, sin texto adicional:
{
  "km": "",
  "combustible": ""
}
REGLAS:
- "km": valor del odómetro en números enteros, solo dígitos, sin puntos ni comas (ej: "106807"). Vacío si no se puede leer con certeza.
- "combustible": nivel del indicador de combustible. Usá uno de estos valores exactos: "E", "1/4", "1/2", "3/4", "F". Estimá visualmente la posición de la aguja. Vacío si no se ve el indicador.` },
    { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } }
  ];
  const res = await callAI('extract-km', [{ role: 'user', content: userContent }], { max_tokens: 60, modulo: opts.modulo || 'Turnos', entidad_id: opts.entidad_id || null });
  return _parse(res.content[0].text);
}

module.exports = { extractCedulaData, extractGncData, extractSeguroData, extractFacturaData, extractVtvData, extractMultaData, extractTextFromImage, extractKmData, extractAceiteData };
