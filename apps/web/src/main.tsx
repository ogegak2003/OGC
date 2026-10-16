import 'virtual:ogc-tokens.css';
import './styles/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './app/App';
import { AuthProvider } from './auth/AuthProvider';
import { MessagingProvider } from './messaging/MessagingProvider';
import { ThemeProvider } from './theme/ThemeProvider';
import { applyAppearance, loadAppearance } from './theme/theme';

// Apply the saved appearance before the first paint (no flash of the wrong theme).
applyAppearance(loadAppearance());

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <MessagingProvider>
            <App />
          </MessagingProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
