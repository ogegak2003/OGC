import { MessagingClient, RealtimeConnection, SealedStore } from '@ogc/messaging';
import { IdbKeyValueStore } from './idb-store';
import type { MessagingDependencies } from './messaging-context';
import { webTransport } from './web-transport';

/** Production wiring: IndexedDB (sealed with a non-extractable key), REST and same-origin Socket.IO. */
export const browserDependencies: MessagingDependencies = {
  createEngine: async (ogcId) => {
    const { store, sealer } = await IdbKeyValueStore.open(ogcId);
    return new MessagingClient(webTransport, new SealedStore(store, sealer), ogcId);
  },
  // Same origin: the session cookie authenticates the socket (the server checks the Origin).
  createRealtime: (options, onEvent, onReconnect) =>
    new RealtimeConnection({ origin: '', ...options }, onEvent, onReconnect),
  destroyLocalData: (ogcId) => IdbKeyValueStore.destroy(ogcId),
};
