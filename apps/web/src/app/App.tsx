import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { GuestOnly, RequireAccount } from '../auth/guards';
import { BlockedPage } from '../pages/BlockedPage';
import { CheckEmailPage } from '../pages/CheckEmailPage';
import { ContactsPage } from '../pages/ContactsPage';
import { DiscoverPage } from '../pages/DiscoverPage';
import { EditProfilePage } from '../pages/EditProfilePage';
import { HomePage } from '../pages/HomePage';
import { LoginPage } from '../pages/LoginPage';
import { PendingVerificationPage } from '../pages/PendingVerificationPage';
import { PrivacyPage } from '../pages/PrivacyPage';
import { PublicProfilePage } from '../pages/PublicProfilePage';
import { RegisterPage } from '../pages/RegisterPage';
import { ReportPage } from '../pages/ReportPage';
import { VerifyEmailPage } from '../pages/VerifyEmailPage';
import { WelcomePage } from '../pages/WelcomePage';

const guest = (page: ReactNode) => <GuestOnly>{page}</GuestOnly>;
const member = (page: ReactNode) => <RequireAccount>{page}</RequireAccount>;

export function App() {
  return (
    <Routes>
      <Route path="/" element={guest(<WelcomePage />)} />
      <Route path="/register" element={guest(<RegisterPage />)} />
      <Route path="/login" element={guest(<LoginPage />)} />
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
      <Route path="/home" element={member(<HomePage />)} />
      <Route path="/profile/edit" element={member(<EditProfilePage />)} />
      <Route path="/discover" element={member(<DiscoverPage />)} />
      {/* Web form of the OGC identity link ogc://id/OGC… (future universal link). */}
      <Route path="/id/:ogcId" element={member(<PublicProfilePage />)} />
      <Route path="/contacts" element={member(<ContactsPage />)} />
      <Route path="/settings/privacy" element={member(<PrivacyPage />)} />
      <Route path="/settings/blocked" element={member(<BlockedPage />)} />
      <Route path="/report/:ogcId" element={member(<ReportPage />)} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
