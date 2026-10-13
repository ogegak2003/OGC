/* global jest, TextEncoder */
/**
 * Test doubles for native-only Expo modules (no native runtime under Jest).
 * expo-file-system is an in-memory file tree so storage code can be tested
 * against the real API shape.
 */

jest.mock('expo-file-system', () => {
  const files = new Map();
  const join = (...parts) =>
    parts
      .map((p) => (typeof p === 'string' ? p : p.uri))
      .join('/')
      .replace(/\/+/g, '/');

  class File {
    constructor(...parts) {
      this.uri = join(...parts);
    }
    get name() {
      return this.uri.split('/').pop();
    }
    get exists() {
      return files.has(this.uri);
    }
    create() {
      if (!files.has(this.uri)) files.set(this.uri, new Uint8Array());
    }
    write(content) {
      files.set(
        this.uri,
        typeof content === 'string' ? new TextEncoder().encode(content) : content.slice(),
      );
    }
    bytes() {
      return Promise.resolve(files.get(this.uri).slice());
    }
    delete() {
      files.delete(this.uri);
    }
  }

  class Directory {
    constructor(...parts) {
      this.uri = join(...parts);
    }
    get exists() {
      return (
        [...files.keys()].some((k) => k.startsWith(`${this.uri}/`)) ||
        Directory.created.has(this.uri)
      );
    }
    create() {
      Directory.created.add(this.uri);
    }
    list() {
      return [...files.keys()]
        .filter((k) => k.startsWith(`${this.uri}/`) && !k.slice(this.uri.length + 1).includes('/'))
        .map((k) => new File(k));
    }
    delete() {
      for (const key of [...files.keys()]) if (key.startsWith(`${this.uri}/`)) files.delete(key);
      Directory.created.delete(this.uri);
    }
  }
  Directory.created = new Set();

  return {
    File,
    Directory,
    Paths: { document: new Directory('file:///documents'), cache: new Directory('file:///cache') },
    __files: files,
  };
});

jest.mock('expo-audio', () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: jest.fn(() => Promise.resolve({ granted: false })),
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
  useAudioRecorder: () => ({
    prepareToRecordAsync: jest.fn(() => Promise.resolve()),
    record: jest.fn(),
    stop: jest.fn(() => Promise.resolve()),
    uri: null,
  }),
  useAudioPlayer: () => ({
    play: jest.fn(),
    pause: jest.fn(),
    seekTo: jest.fn(() => Promise.resolve()),
  }),
  useAudioPlayerStatus: () => ({ playing: false, currentTime: 0, duration: 0 }),
}));

jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(() => Promise.resolve()) }));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(() => Promise.resolve({ canceled: true, assets: null })),
}));
