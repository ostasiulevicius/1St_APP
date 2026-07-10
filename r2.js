const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs   = require('fs');

// ── Detectar si R2 está realmente configurado ────────────────────────────────
function _r2Ready() {
  const ep  = process.env.R2_ENDPOINT  || '';
  const key = process.env.R2_ACCESS_KEY_ID || '';
  const sec = process.env.R2_SECRET_ACCESS_KEY || '';
  // Rechazar si tiene placeholders o está vacío
  return key && sec && ep && !ep.includes('<') && !ep.includes('>');
}

const s3 = _r2Ready()
  ? new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

// ── Fallback: guardar en disco local public/uploads/ ─────────────────────────
const LOCAL_DIR = path.join(__dirname, 'public', 'uploads');

function _saveLocal(buffer, folder, ext) {
  const dir = path.join(LOCAL_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${uuidv4()}${ext}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return `/uploads/${folder}/${filename}`;
}

// ── uploadFile: R2 si está configurado, local si no ──────────────────────────
async function uploadFile(buffer, originalName, folder = 'uploads') {
  const ext = path.extname(originalName || 'file.jpg').toLowerCase() || '.jpg';
  const contentType = getContentType(ext);

  if (!_r2Ready()) {
    // Almacenamiento local
    return _saveLocal(buffer, folder, ext);
  }

  const key = `${folder}/${uuidv4()}${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));

  const publicUrl = process.env.R2_PUBLIC_URL;
  return publicUrl ? `${publicUrl}/${key}` : key;
}

async function deleteFile(url) {
  if (!url) return;
  // Archivo local
  if (url.startsWith('/uploads/')) {
    const localPath = path.join(__dirname, 'public', url);
    try { fs.unlinkSync(localPath); } catch {}
    return;
  }
  // R2
  if (!_r2Ready()) return;
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl || !url.startsWith(publicUrl)) return;
  const key = url.replace(`${publicUrl}/`, '');
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
  } catch {}
}

function getContentType(ext) {
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png',  '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

module.exports = { uploadFile, deleteFile };
