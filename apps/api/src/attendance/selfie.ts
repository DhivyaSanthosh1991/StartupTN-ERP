/** Smallest and largest photo accepted. The web app shrinks selfies to about 40 to 120 KB before sending. */
export const MIN_SELFIE_BYTES = 2_000;
export const MAX_SELFIE_BYTES = 300_000;

/**
 * Turns the base64 text sent with a punch into the JPEG bytes, or null if it is not a plausible JPEG.
 * Accepts a bare base64 string or a `data:image/jpeg;base64,` URL. This checks the file's shape only;
 * nothing here can tell whether the picture is of the right person, or of a person at all.
 */
export function decodeSelfie(input: string): Buffer | null {
  const text = input.replace(/^data:image\/jpe?g;base64,/i, '').replace(/\s+/g, '');
  if (!text || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length < MIN_SELFIE_BYTES || bytes.length > MAX_SELFIE_BYTES) return null;
  const startsLikeJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const endsLikeJpeg = bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  return startsLikeJpeg && endsLikeJpeg ? bytes : null;
}

export function selfieKey(employeeId: string, workDate: string, eventId: string): string {
  return `selfies/${employeeId}/${workDate}/${eventId}.jpg`;
}
