const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function extractVehicleData(frenteBuffer, dorsoBuffer, frenteMime, dorsoMime) {
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Sos un sistema de extracción de datos de cédulas de vehículos argentinas.
Analizá las siguientes imágenes (frente y dorso de la cédula) y extraé TODOS los datos disponibles.
Respondé ÚNICAMENTE con un JSON válido, sin texto adicional, con esta estructura exacta:
{
  "patente": "",
  "titular_nombre": "",
  "titular_domicilio": "",
  "chasis": "",
  "motor": "",
  "marca": "",
  "modelo": "",
  "anio": null,
  "color": ""
}
Si un campo no está visible o no existe en el documento, dejalo como string vacío o null para números.`,
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: frenteMime,
            data: frenteBuffer.toString('base64'),
          },
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: dorsoBuffer ? dorsoMime : frenteMime,
            data: dorsoBuffer ? dorsoBuffer.toString('base64') : frenteBuffer.toString('base64'),
          },
        },
      ],
    },
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages,
  });

  return JSON.parse(response.content[0].text.trim());
}

async function extractGncData(buffer, mimeType) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analizá esta imagen de una oblea o certificado de GNC argentino y extraé los datos.
Respondé ÚNICAMENTE con un JSON válido, sin texto adicional:
{
  "numero_oblea": "",
  "regulador": "",
  "fecha_vencimiento": ""
}
La fecha de vencimiento debe estar en formato YYYY-MM-DD si es posible identificarla. Si no podés identificar un campo, dejalo como string vacío.`,
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: buffer.toString('base64'),
            },
          },
        ],
      },
    ],
  });

  return JSON.parse(response.content[0].text.trim());
}

async function extractInsuranceData(content, isBase64Image, mimeType) {
  const userContent = [
    {
      type: 'text',
      text: `Analizá este documento de póliza de seguro de vehículo y extraé los datos clave.
Respondé ÚNICAMENTE con un JSON válido, sin texto adicional:
{
  "compania": "",
  "numero_poliza": "",
  "vigencia_desde": "",
  "vigencia_hasta": ""
}
Las fechas deben estar en formato YYYY-MM-DD. Si no podés identificar un campo, dejalo como string vacío.`,
    },
  ];

  if (isBase64Image) {
    userContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data: content,
      },
    });
  } else {
    userContent.push({
      type: 'text',
      text: `\n\nContenido del documento PDF:\n${content}`,
    });
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{ role: 'user', content: userContent }],
  });

  return JSON.parse(response.content[0].text.trim());
}

module.exports = { extractVehicleData, extractGncData, extractInsuranceData };
