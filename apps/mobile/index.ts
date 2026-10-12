import { registerRootComponent } from 'expo';
import { createElement } from 'react';
import { apiClient } from './src/api/default-client';
import { App } from './src/App';

function Root() {
  return createElement(App, { client: apiClient });
}

// Registers the root component for Expo Go and native builds alike.
registerRootComponent(Root);
