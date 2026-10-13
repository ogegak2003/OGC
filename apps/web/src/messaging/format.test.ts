import { describe, expect, it } from 'vitest';
import {
  attachmentKind,
  dayLabel,
  duration,
  fileSize,
  playableAudio,
  safeFileName,
  safeMime,
} from './format';

describe('messaging formatting', () => {
  it('classifies attachments by type, inline images only for raster formats', () => {
    expect(attachmentKind('image/png')).toBe('IMAGE');
    expect(attachmentKind('image/svg+xml')).toBe('FILE');
    expect(attachmentKind('audio/webm')).toBe('AUDIO');
    expect(attachmentKind('application/pdf')).toBe('DOCUMENT');
    expect(attachmentKind('application/x-msdownload')).toBe('FILE');
  });

  it('sanitises file names and media types', () => {
    expect(safeFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(safeFileName('..')).toBe('file');
    expect(safeMime('text/html; charset=utf-8')).toBe('application/octet-stream');
    expect(safeMime('image/png')).toBe('image/png');
  });

  it('plays only known audio formats', () => {
    expect(playableAudio('audio/webm')).toBe(true);
    expect(playableAudio('text/html')).toBe(false);
  });

  it('formats sizes, durations and day labels', () => {
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(2048)).toBe('2 KB');
    expect(fileSize(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(duration(65_000)).toBe('1:05');
    const now = new Date('2026-10-12T15:00:00');
    expect(dayLabel('2026-10-12T09:00:00', now)).toBe('Today');
    expect(dayLabel('2026-10-11T09:00:00', now)).toBe('Yesterday');
  });
});
