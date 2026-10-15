import { describe, expect, it } from '@jest/globals';
import { EndpointConfigurationError, isLocalHost, resolveEndpoints } from './endpoints';

describe('endpoint configuration', () => {
  it('uses the host computer as seen from emulators and simulators in development', () => {
    expect(
      resolveEndpoints({
        apiBaseUrl: undefined,
        webAppUrl: undefined,
        dev: true,
        platform: 'android',
      }),
    ).toEqual({
      apiBaseUrl: 'http://10.0.2.2:3000/api',
      webAppUrl: 'http://localhost:5173',
    });
    expect(
      resolveEndpoints({ apiBaseUrl: '', webAppUrl: '', dev: true, platform: 'ios' }).apiBaseUrl,
    ).toBe('http://localhost:3000/api');
  });

  it('accepts a LAN address for physical-device development', () => {
    expect(
      resolveEndpoints({
        apiBaseUrl: 'http://192.168.1.20:3000/api/',
        webAppUrl: undefined,
        dev: true,
        platform: 'android',
      }).apiBaseUrl,
    ).toBe('http://192.168.1.20:3000/api');
  });

  it('uses the LAN address Metro served the bundle from on a physical phone', () => {
    const resolve = (devServerHost: string | undefined, apiBaseUrl?: string) =>
      resolveEndpoints({
        apiBaseUrl,
        webAppUrl: undefined,
        dev: true,
        platform: 'android',
        devServerHost,
      }).apiBaseUrl;
    expect(resolve('192.168.0.11')).toBe('http://192.168.0.11:3000/api');
    // Loopback (adb reverse) and public tunnel hosts keep the emulator default.
    expect(resolve('localhost')).toBe('http://10.0.2.2:3000/api');
    expect(resolve('127.0.0.1')).toBe('http://10.0.2.2:3000/api');
    expect(resolve('abc-anonymous-8081.exp.direct')).toBe('http://10.0.2.2:3000/api');
    // An explicit URL always wins.
    expect(resolve('192.168.0.11', 'http://192.168.1.20:3000/api')).toBe(
      'http://192.168.1.20:3000/api',
    );
  });

  it('never falls back to the Metro host in release builds', () => {
    expect(() =>
      resolveEndpoints({
        apiBaseUrl: undefined,
        webAppUrl: 'https://ogc.example',
        dev: false,
        platform: 'android',
        devServerHost: '192.168.0.11',
      }),
    ).toThrow(EndpointConfigurationError);
  });

  it('requires public https endpoints in release builds, with no fallback', () => {
    expect(() =>
      resolveEndpoints({
        apiBaseUrl: undefined,
        webAppUrl: 'https://ogc.example',
        dev: false,
        platform: 'android',
      }),
    ).toThrow(EndpointConfigurationError);
    for (const bad of [
      'http://api.ogc.example/api',
      'https://localhost/api',
      'https://192.168.1.20/api',
      'https://10.0.2.2/api',
    ]) {
      expect(() =>
        resolveEndpoints({
          apiBaseUrl: bad,
          webAppUrl: 'https://ogc.example',
          dev: false,
          platform: 'android',
        }),
      ).toThrow(EndpointConfigurationError);
    }
    expect(
      resolveEndpoints({
        apiBaseUrl: 'https://api.ogc.example/api',
        webAppUrl: 'https://ogc.example',
        dev: false,
        platform: 'ios',
      }),
    ).toEqual({ apiBaseUrl: 'https://api.ogc.example/api', webAppUrl: 'https://ogc.example' });
  });

  it('rejects non-URLs and other schemes', () => {
    expect(() =>
      resolveEndpoints({
        apiBaseUrl: 'not a url',
        webAppUrl: undefined,
        dev: true,
        platform: 'ios',
      }),
    ).toThrow();
    expect(() =>
      resolveEndpoints({
        apiBaseUrl: 'ftp://x/api',
        webAppUrl: undefined,
        dev: true,
        platform: 'ios',
      }),
    ).toThrow();
  });

  it('recognises local hosts', () => {
    expect(
      ['localhost', '127.0.0.1', '10.0.2.2', '192.168.0.4', '172.20.1.1', 'pc.local'].every(
        isLocalHost,
      ),
    ).toBe(true);
    expect(['api.ogc.example', '172.32.0.1', '8.8.8.8'].some(isLocalHost)).toBe(false);
  });
});
