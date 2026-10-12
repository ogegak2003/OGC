import { Navigate, Route, Routes } from 'react-router';
import { GuestOnly, RequireAccount } from '../auth/guards';
import { CheckEmailPage } from '../pages/CheckEmailPage';
import { HomePage } from '../pages/HomePage';
import { LoginPage } from '../pages/LoginPage';
import { PendingVerificationPage } from '../pages/PendingVerificationPage';
import { RegisterPage } from '../pages/RegisterPage';
import { VerifyEmailPage } from '../pages/VerifyEmailPage';
import { WelcomePage } from '../pages/WelcomePage';

export function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <GuestOnly>
            <WelcomePage />
          </GuestOnly>
        }
      />
      <Route
        path="/register"
        element={
          <GuestOnly>
            <RegisterPage />
          </GuestOnly>
        }
      />
      <Route
        path="/login"
        element={
          <GuestOnly>
            <LoginPage />
          </GuestOnly>
        }
      />
      <Route path="/check-email" element={<CheckEmailPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route
        path="/verify"
        element={
          <RequireAccount allowPending>
            <PendingVerificationPage />
          </RequireAccount>
        }
      />
      <Route
        path="/home"
        element={
          <RequireAccount>
            <HomePage />
          </RequireAccount>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
