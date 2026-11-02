import { AppConfig } from '../config/config';

const NAMESPACE = 'http://tempuri.org/';
const MAX_RESPONSE_CHARS = 20_000_000;

export class BiometricApiError extends Error {}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** The machine's server wants dates as yyyy/MM/dd. */
const slashDate = (iso: string) => iso.replace(/-/g, '/');

function element(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i').exec(xml);
  return m ? unescapeXml(m[1]).trim() : null;
}

/**
 * Asks the eSSL eTimeTracklite Web API service for the punches of one machine over a date range
 * (its GetTransactionsLog method, a SOAP 1.1 call). Returns the text of the punch list, to be read
 * by parseBiometricLog.
 *
 * The credentials are the ones the eTimeTracklite administrator gave to the API user. They travel in the
 * request body, so the address should be reached over a private network or https.
 */
export async function fetchTransactionsLog(
  config: Pick<AppConfig, 'biometricApiUrl' | 'biometricApiUser' | 'biometricApiPassword'>,
  serial: string,
  fromDate: string,
  toDate: string,
  timeoutMs = 60_000,
): Promise<string> {
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><GetTransactionsLog xmlns="${NAMESPACE}">` +
    `<FromDate>${slashDate(fromDate)}</FromDate><ToDate>${slashDate(toDate)}</ToDate>` +
    `<SerialNumber>${escapeXml(serial)}</SerialNumber>` +
    `<UserName>${escapeXml(config.biometricApiUser)}</UserName><UserPassword>${escapeXml(config.biometricApiPassword)}</UserPassword>` +
    `<strDataList>Blank</strDataList></GetTransactionsLog></soap:Body></soap:Envelope>`;

  let res: Response;
  try {
    res = await fetch(config.biometricApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${NAMESPACE}GetTransactionsLog"` },
      body: envelope,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = (err as Error).name === 'TimeoutError' ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : (err as Error).message;
    throw new BiometricApiError(`Could not reach the biometric server: ${reason}`);
  }

  const body = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
  if (!res.ok) {
    const fault = element(body, 'faultstring');
    throw new BiometricApiError(`The biometric server answered ${res.status}${fault ? `: ${fault.slice(0, 200)}` : ''}`);
  }

  const result = element(body, 'GetTransactionsLogResult') ?? '';
  const list = element(body, 'strDataList') ?? '';
  // The manual does not say whether the punches come back in the result or in strDataList, so take whichever has them.
  const data = list && list.toLowerCase() !== 'blank' ? list : result;
  if (/authentication|invalid (user|credential)|unauthori[sz]ed|login failed/i.test(result) && !/\d{1,2}:\d{2}/.test(data)) {
    throw new BiometricApiError(`The biometric server refused the user name or password (${result.slice(0, 100)})`);
  }
  if (/^(failure|failed|error)\b/i.test(result) && !/\d{1,2}:\d{2}/.test(data)) {
    throw new BiometricApiError(`The biometric server reported: ${result.slice(0, 160)}`);
  }
  return /\d{1,2}:\d{2}/.test(data) ? data : '';
}
