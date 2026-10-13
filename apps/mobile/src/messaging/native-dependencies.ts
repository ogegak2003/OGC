import { MessagingClient, RealtimeConnection, SealedStore } from '@ogc/messaging';
import type { MessagingDependencies } from './messaging-context';
import { FileKeyValueStore } from './native-store';
import { nativeTransport } from './native-transport';

/** Production wiring: sealed files (key in the platform keystore), REST and WebSocket. */
export const nativeDependencies: MessagingDependencies = {
  createEngine: async (ogcId, client) => {
    const { store, sealer } = await FileKeyValueStore.open(ogcId);
    return new MessagingClient(nativeTransport(client), new SealedStore(store, sealer), ogcId);
  },
  createRealtime: (client, options, onEvent, onReconnect) =>
    new RealtimeConnection(
      {
        origin: client.origin,
        transports: ['websocket'],
        // A fresh token for every (re)connection; the server closes sockets when tokens expire.
        accessToken: () => client.currentAccessToken(),
        onUnauthorized: async () => {
          await client.refresh();
        },
        ...options,
      },
      onEvent,
      onReconnect,
    ),
  destroyLocalData: (ogcId) => FileKeyValueStore.destroy(ogcId),
};
