import type { OgcId } from './identity.js';

/** Who may see the optional parts of a profile (bio, photo, member-since date). */
export type ProfileVisibility = 'EVERYONE' | 'CONTACTS';

/** Who may send this user a contact request. */
export type ContactRequestPolicy = 'EVERYONE' | 'NOBODY';

export interface PrivacySettings {
  profileVisibility: ProfileVisibility;
  /** When false, only existing contacts can look the account up by OGC ID or QR code. */
  discoverable: boolean;
  contactRequests: ContactRequestPolicy;
}

/**
 * The viewer's relationship to another account, computed server-side.
 * `BLOCKED` means *the viewer* blocked them; being blocked by someone is never revealed.
 */
export type Relationship =
  'SELF' | 'NONE' | 'OUTGOING_REQUEST' | 'INCOMING_REQUEST' | 'CONTACT' | 'BLOCKED';

/** Another account as the viewer is allowed to see it. Optional fields are null when hidden. */
export interface PublicProfile {
  ogcId: OgcId;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  memberSince: string | null;
  relationship: Relationship;
  /** Whether the viewer can send a contact request right now. */
  canSendContactRequest: boolean;
  /** The pending request between viewer and this account, if any (to accept, decline or cancel). */
  pendingRequestId: string | null;
}

/** The signed-in user's own profile, including private settings. */
export interface OwnProfile {
  ogcId: OgcId;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  memberSince: string;
  privacy: PrivacySettings;
}

/** Minimal public card used in lists (contacts, requests, blocks). */
export interface ProfileSummary {
  ogcId: OgcId;
  displayName: string;
  avatarUrl: string | null;
}

export interface ContactView {
  profile: ProfileSummary;
  since: string;
}

export interface ContactRequestView {
  id: string;
  /** The other party: the sender for incoming requests, the recipient for outgoing ones. */
  profile: ProfileSummary;
  createdAt: string;
}

export interface BlockView {
  profile: ProfileSummary;
  blockedAt: string;
}

/** Cursor-paginated list. Pass `nextCursor` back as `?cursor=` to fetch the next page. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type ReportCategory =
  'SPAM' | 'HARASSMENT' | 'IMPERSONATION' | 'INAPPROPRIATE_CONTENT' | 'SCAM_OR_FRAUD' | 'OTHER';

export type ReportStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';

/** A report as seen by moderators. */
export interface UserReportView {
  id: string;
  category: ReportCategory;
  description: string | null;
  status: ReportStatus;
  reporterOgcId: OgcId | null;
  reportedOgcId: OgcId | null;
  createdAt: string;
}

/** Result of sending a contact request (a mutual request becomes a contact immediately). */
export interface ContactRequestResult {
  relationship: Extract<Relationship, 'OUTGOING_REQUEST' | 'CONTACT'>;
}
