import 'virtual:ogc-tokens.css';
import './styles/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './app/App';
import { AuthProvider } from './auth/AuthProvider';
import { MessagingProvider } from './messaging/MessagingProvider';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <MessagingProvider>
          <App />
        </MessagingProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
