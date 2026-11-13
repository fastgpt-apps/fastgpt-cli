// RFC 5987 attr-char excludes these characters even though encodeURIComponent leaves them raw.
// In particular, an unescaped apostrophe can be mistaken for the filename* charset/language delimiter.
export function encodeMultipartFilename(name) {
  const safeName = String(name).replace(/[\u0000-\u001F\u007F]/g, '_');
  return encodeURIComponent(safeName)
    .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function multipartFileHeader(boundary, file) {
  const safeName = String(file.name).replace(/[\u0000-\u001F\u007F]/g, '_');
  const quotedName = safeName.replace(/["\\]/g, char => `\\${char}`);
  const encodedName = encodeMultipartFilename(safeName);
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
    `filename="${quotedName}"; filename*=UTF-8''${encodedName}\r\n` +
    `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`,
    'utf8'
  );
}
