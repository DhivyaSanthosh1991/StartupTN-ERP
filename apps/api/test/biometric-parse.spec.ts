import { parseBiometricLog, parseDateTime } from '../src/attendance/biometric-parse';

/**
 * The eSSL manual does not show what the punch list looks like, so these are the shapes such software is
 * known to produce. They are samples made up for these tests, not captures from StartupTN's machine.
 */
const iso = (s: string) => parseDateTime(s)?.toISOString();

describe('biometric punch list reader', () => {
  describe('dates and times', () => {
    it('reads India time in the formats machines use', () => {
      expect(iso('2026-10-26 09:10:11')).toBe('2026-10-26T03:40:11.000Z');
      expect(iso('2026/10/26 09:10')).toBe('2026-10-26T03:40:00.000Z');
      expect(iso('26/10/2026 09:10:11')).toBe('2026-10-26T03:40:11.000Z');
      expect(iso('26-10-2026 9:05')).toBe('2026-10-26T03:35:00.000Z');
      expect(iso('26-Oct-2026 06:15 PM')).toBe('2026-10-26T12:45:00.000Z');
      expect(iso('2026-10-26T09:10:11')).toBe('2026-10-26T03:40:11.000Z');
    });

    it('keeps a zone when the text carries one', () => {
      expect(iso('2026-10-26T09:10:11Z')).toBe('2026-10-26T09:10:11.000Z');
      expect(iso('2026-10-26T09:10:11+05:30')).toBe('2026-10-26T03:40:11.000Z');
    });

    it('reads 12 am and 12 pm correctly', () => {
      expect(iso('2026-10-26 12:05 AM')).toBe('2026-10-25T18:35:00.000Z');
      expect(iso('2026-10-26 12:05 PM')).toBe('2026-10-26T06:35:00.000Z');
    });

    it.each(['2026-02-31 09:00', '2026-13-01 09:00', '2026-10-26 25:00', '2026-10-26 09:61', '31/02/2026 09:00', 'yesterday', '09:10:11', ''])(
      'refuses %p', (text) => expect(parseDateTime(text)).toBeNull());
  });

  describe('text lines', () => {
    it('reads comma-separated lines with a header', () => {
      const r = parseBiometricLog(['EmployeeCode,LogDate,SerialNumber,Direction', '1123,2026-10-26 09:10:11,BRM9202760325,in', '1123,2026-10-26 18:20:00,BRM9202760325,out'].join('\n'));
      expect(r.rejected).toBe(0);
      expect(r.punches.map((p) => [p.code, p.at.toISOString(), p.serial, p.direction])).toEqual([
        ['1123', '2026-10-26T03:40:11.000Z', 'BRM9202760325', 'in'],
        ['1123', '2026-10-26T12:50:00.000Z', 'BRM9202760325', 'out'],
      ]);
    });

    it('reads lines with no header, in any order', () => {
      const r = parseBiometricLog('2026-10-26 09:10:11,1123,BRM9202760325\n1124,26/10/2026 09:12:00\n');
      expect(r.punches.map((p) => p.code)).toEqual(['1123', '1124']);
      expect(r.punches[0].serial).toBe('BRM9202760325');
    });

    it('joins a date and a time that arrive in separate columns', () => {
      const r = parseBiometricLog('Code,Date,Time\n7,2026-10-26,09:30:00\n7,2026-10-26,18:00:00');
      expect(r.punches.map((p) => p.at.toISOString())).toEqual(['2026-10-26T04:00:00.000Z', '2026-10-26T12:30:00.000Z']);
    });

    it('reads tab, pipe, semicolon and space separated lines, quotes and a byte-order mark', () => {
      const text = '﻿"1123"\t"2026-10-26 09:10:11"\n1124|2026-10-26 09:11:00\n1125;2026-10-26 09:12:00\n1126 2026-10-26 09:13:00 BRM9202760325';
      const r = parseBiometricLog(text);
      expect(r.punches.map((p) => p.code)).toEqual(['1123', '1124', '1125', '1126']);
      expect(r.punches[3].serial).toBe('BRM9202760325');
    });

    it('splits a single line of semicolon-separated rows', () => {
      const r = parseBiometricLog('1123,2026-10-26 09:10:11;1124,2026-10-26 09:11:11;1125,2026-10-26 09:12:11');
      expect(r.punches.map((p) => p.code)).toEqual(['1123', '1124', '1125']);
    });

    it('uses the machine it was asked about when a row does not name one', () => {
      const r = parseBiometricLog('1123,2026-10-26 09:10:11', { serial: 'BRM1' });
      expect(r.punches[0].serial).toBe('BRM1');
    });

    it('counts rows it cannot read, with examples, and keeps the rest', () => {
      const r = parseBiometricLog('1123,2026-10-26 09:10:11\nTotal rows: 2\n1124,not a time\n1125,2026-10-26 09:12:00');
      expect(r.punches.map((p) => p.code)).toEqual(['1123', '1125']);
      expect(r.rejected).toBe(2);
      expect(r.samples).toEqual(['Total rows: 2', '1124,not a time']);
    });

    it('returns nothing for empty text', () => {
      expect(parseBiometricLog('  \n ')).toEqual({ punches: [], rejected: 0, samples: [] });
    });
  });

  describe('JSON and XML', () => {
    it('reads a JSON array, whatever the field names are called', () => {
      const r = parseBiometricLog(JSON.stringify([
        { EmployeeCode: '1123', LogDate: '2026-10-26 09:10:11', SerialNumber: 'BRM1', Direction: 'in' },
        { empcode: 1124, punch_time: '2026-10-26 09:11:00' },
        { UserId: '1125', LogDate: '2026-10-26', LogTime: '09:12:00' },
        { nothing: 'useful' },
      ]));
      expect(r.punches.map((p) => [p.code, p.serial, p.direction])).toEqual([['1123', 'BRM1', 'in'], ['1124', null, null], ['1125', null, null]]);
      expect(r.rejected).toBe(1);
    });

    it('finds the list inside a wrapper object', () => {
      const r = parseBiometricLog('{"Table":[{"EmployeeCode":"7","LogDate":"2026-10-26 09:00:00"}]}');
      expect(r.punches).toHaveLength(1);
    });

    it('reads XML rows, including when the whole list arrives escaped', () => {
      const xml = '<NewDataSet><Table><EmployeeCode>1123</EmployeeCode><LogDate>2026-10-26 09:10:11</LogDate></Table><Table><EmployeeCode>1124</EmployeeCode><LogDate>2026-10-26 09:11:00</LogDate></Table></NewDataSet>';
      expect(parseBiometricLog(xml).punches.map((p) => p.code)).toEqual(['1123', '1124']);
      const escaped = xml.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      expect(parseBiometricLog(escaped).punches.map((p) => p.code)).toEqual(['1123', '1124']);
    });
  });
});
