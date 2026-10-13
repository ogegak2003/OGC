// Must be first: prepares crypto for the end-to-end encryption engine on Hermes.
import './src/crypto-setup';
import { color } from '@ogc/ui';
import { registerRootComponent } from 'expo';
import { createElement } from 'react';
import { Text, View } from 'react-native';
import { apiClient } from './src/api/default-client';
import { App } from './src/App';
import { runtimeConfig } from './src/config/runtime';

function Root() {
  if (!apiClient) {
    // A release build without valid endpoints: say so rather than calling a wrong server.
    return createElement(
      View,
      {
        style: {
          flex: 1,
          padding: 32,
          justifyContent: 'center',
          backgroundColor: color.background,
        },
        accessibilityRole: 'alert',
      },
      createElement(
        Text,
        { style: { color: color.textPrimary, fontSize: 16 } },
        `This build of OGC is not configured correctly: ${runtimeConfig.error ?? 'unknown error'}`,
      ),
    );
  }
  return createElement(App, { client: apiClient });
}

// Registers the root component for Expo Go and native builds alike.
registerRootComponent(Root);
