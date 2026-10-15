import { type ReactNode, Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { GuestOnly, RequireAccount } from '../auth/guards';
import { BlockedPage } from '../pages/BlockedPage';
import { CheckEmailPage } from '../pages/CheckEmailPage';
import { ContactsPage } from '../pages/ContactsPage';
import { DiscoverPage } from '../pages/DiscoverPage';
import { EditProfilePage } from '../pages/EditProfilePage';
import { ForgotPasswordPage } from '../pages/ForgotPasswordPage';
import { HomePage } from '../pages/HomePage';
import { LoginPage } from '../pages/LoginPage';
import { MessagesPage } from '../pages/MessagesPage';
import { PendingVerificationPage } from '../pages/PendingVerificationPage';
import { PrivacyPage } from '../pages/PrivacyPage';
import { PublicProfilePage } from '../pages/PublicProfilePage';
import { RegisterPage } from '../pages/RegisterPage';
import { ResetPasswordPage } from '../pages/ResetPasswordPage';
import { ReportPage } from '../pages/ReportPage';
import { SecurityPage } from '../pages/SecurityPage';
import { VerifyEmailPage } from '../pages/VerifyEmailPage';
import { WelcomePage } from '../pages/WelcomePage';
import { Spinner } from '../components/ui';
import { CallOverlay } from '../components/calls/CallOverlay';

// Community pages load on demand, keeping the initial bundle small.
const ChannelsPage = lazy(() =>
  import('../pages/ChannelsPage').then((m) => ({ default: m.ChannelsPage })),
);
const ChannelPage = lazy(() =>
  import('../pages/ChannelPage').then((m) => ({ default: m.ChannelPage })),
);
const InvitationsPage = lazy(() =>
  import('../pages/InvitationsPage').then((m) => ({ default: m.InvitationsPage })),
);
const JoinPage = lazy(() => import('../pages/JoinPage').then((m) => ({ default: m.JoinPage })));
const CommunitiesPage = lazy(() =>
  import('../pages/CommunitiesPage').then((m) => ({ default: m.CommunitiesPage })),
);
const NotificationSettingsPage = lazy(() =>
  import('../pages/NotificationSettingsPage').then((m) => ({
    default: m.NotificationSettingsPage,
  })),
);
const CallsPage = lazy(() => import('../pages/CallsPage').then((m) => ({ default: m.CallsPage })));
const NotificationsPage = lazy(() =>
  import('../pages/NotificationsPage').then((m) => ({ default: m.NotificationsPage })),
);

const guest = (page: ReactNode) => <GuestOnly>{page}</GuestOnly>;
const member = (page: ReactNode) => <RequireAccount>{page}</RequireAccount>;
const lazyMember = (page: ReactNode) => (
  <RequireAccount>
    <Suspense fallback={<Spinner label="Loading" />}>{page}</Suspense>
  </RequireAccount>
);

export function App() {
  return (
    <>
      <AppRoutes />
      {/* Incoming, outgoing and active calls, over whichever page is open. */}
      <CallOverlay />
    </>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={guest(<WelcomePage />)} />
      <Route path="/register" element={guest(<RegisterPage />)} />
      <Route path="/login" element={guest(<LoginPage />)} />
      <Route path="/forgot-password" element={guest(<ForgotPasswordPage />)} />
      {/* Emailed link: /reset-password#token=ogc_pr_… (the token never reaches a server log). */}
      <Route path="/reset-password" element={<ResetPasswordPage />} />
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
      <Route path="/messages" element={member(<MessagesPage />)} />
      <Route path="/messages/:conversationId" element={member(<MessagesPage />)} />
      <Route path="/invitations" element={lazyMember(<InvitationsPage />)} />
      {/* Invitation links: /join#token=ogc_inv_… (the token never reaches a server log). */}
      <Route path="/join" element={lazyMember(<JoinPage />)} />
      <Route path="/communities" element={lazyMember(<CommunitiesPage />)} />
      <Route path="/channels" element={lazyMember(<ChannelsPage />)} />
      <Route path="/channels/:channelId" element={lazyMember(<ChannelPage />)} />
      <Route path="/calls" element={lazyMember(<CallsPage />)} />
      <Route path="/settings/notifications" element={lazyMember(<NotificationSettingsPage />)} />
      <Route path="/notifications" element={lazyMember(<NotificationsPage />)} />
      <Route path="/profile/edit" element={member(<EditProfilePage />)} />
      <Route path="/discover" element={member(<DiscoverPage />)} />
      {/* Web form of the OGC identity link ogc://id/OGC… (future universal link). */}
      <Route path="/id/:ogcId" element={member(<PublicProfilePage />)} />
      <Route path="/contacts" element={member(<ContactsPage />)} />
      <Route path="/settings/privacy" element={member(<PrivacyPage />)} />
      <Route path="/settings/blocked" element={member(<BlockedPage />)} />
      <Route path="/settings/security" element={member(<SecurityPage />)} />
      <Route path="/report/:ogcId" element={member(<ReportPage />)} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
