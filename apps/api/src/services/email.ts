import { Resend } from 'resend';
import { createClient } from '../db/client.js';

let resendClient: Resend | null = null;

function getClient(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

const fromEmail = () => process.env.RESEND_FROM_EMAIL || 'admin@getsly.ai';
const dashboardUrl = () => process.env.APP_URL || 'http://localhost:3000';

interface SendResult {
  sent: boolean;
  messageId?: string;
  error?: string;
}

// Shared HTML layout to keep emails consistent
function emailLayout(content: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a;">
  <div style="text-align: center; margin-bottom: 32px;">
    <h1 style="font-size: 24px; font-weight: 600; margin: 0;">Sly</h1>
  </div>
  ${content}
  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;" />
  <p style="font-size: 12px; color: #999;">Sly — The Agentic Economy Platform</p>
</body>
</html>`;
}

function ctaButton(href: string, label: string): string {
  return `<div style="text-align: center; margin: 32px 0;">
    <a href="${href}" style="display: inline-block; padding: 12px 32px; background-color: #0f172a; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500;">${label}</a>
  </div>`;
}

async function sendEmail(to: string, subject: string, html: string, tag: string): Promise<SendResult> {
  const client = getClient();
  if (!client) {
    console.log(`[email] Resend not configured — skipping ${tag} to`, to);
    return { sent: false, error: 'Email service not configured' };
  }

  try {
    const { data, error } = await client.emails.send({
      from: fromEmail(),
      to,
      subject,
      html,
    });

    if (error) {
      console.error(`[email] Failed to send ${tag}:`, error);
      return { sent: false, error: error.message };
    }

    return { sent: true, messageId: data?.id };
  } catch (err: any) {
    console.error(`[email] Failed to send ${tag}:`, err);
    return { sent: false, error: err.message || 'Unknown error' };
  }
}

// ============================================
// Helper: look up email addresses for a user or tenant admins
// ============================================

export async function getUserEmail(userId: string): Promise<string | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;

  try {
    const resp = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
    });
    if (!resp.ok) return null;
    const user: any = await resp.json();
    return user?.email || null;
  } catch {
    return null;
  }
}

export async function getNotificationRecipients(
  tenantId: string,
  roles: string[] = ['owner', 'admin'],
): Promise<string[]> {
  const supabase = createClient();
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return [];

  const { data: profiles } = await (supabase
    .from('user_profiles') as any)
    .select('id')
    .eq('tenant_id', tenantId)
    .in('role', roles);

  if (!profiles || profiles.length === 0) return [];

  const emails: string[] = [];
  for (const profile of profiles) {
    const email = await getUserEmail(profile.id);
    if (email) emails.push(email);
  }
  return emails;
}

// ============================================
// Existing email functions (refactored to use shared helpers)
// ============================================

export async function sendTeamInviteEmail(params: {
  to: string;
  inviterName: string;
  organizationName: string;
  role: string;
  inviteUrl: string;
  expiresAt: string;
}): Promise<SendResult> {
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">You've been invited!</h2>
  <p>${params.inviterName} has invited you to join <strong>${params.organizationName}</strong> as a <strong>${params.role}</strong>.</p>
  ${ctaButton(params.inviteUrl, 'Accept Invitation')}
  <p style="font-size: 14px; color: #666;">This invitation expires on ${new Date(params.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.</p>
  <p style="font-size: 14px; color: #666;">If you didn't expect this invitation, you can safely ignore this email.</p>`);

  return sendEmail(
    params.to,
    `${params.inviterName} invited you to join ${params.organizationName} on Sly`,
    html,
    'invite',
  );
}

export async function sendInviteAcceptedEmail(params: {
  to: string;
  userName: string;
  organizationName: string;
  role: string;
  dashboardUrl: string;
}): Promise<SendResult> {
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">Welcome aboard, ${params.userName}!</h2>
  <p>You've joined <strong>${params.organizationName}</strong> as a <strong>${params.role}</strong>.</p>
  ${ctaButton(params.dashboardUrl, 'Go to Dashboard')}
  <p style="font-size: 14px; color: #666;">You can manage your account settings and team from the dashboard.</p>`);

  return sendEmail(
    params.to,
    `Welcome to ${params.organizationName} on Sly!`,
    html,
    'invite-accepted',
  );
}

// ============================================
// Tier 1: New email functions
// ============================================

export async function sendWelcomeEmail(params: {
  to: string;
  userName: string;
  organizationName: string;
}): Promise<SendResult> {
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">Welcome to Sly, ${params.userName}!</h2>
  <p>Your organization <strong>${params.organizationName}</strong> is ready. You can start configuring accounts, creating API keys, and sending your first transfers.</p>
  ${ctaButton(dashboardUrl(), 'Go to Dashboard')}
  <p style="font-size: 14px; color: #666;">Need help getting started? Check out our documentation or reach out to support.</p>`);

  return sendEmail(params.to, 'Welcome to Sly', html, 'welcome');
}

export async function sendTransferCompletedEmail(params: {
  to: string;
  amount: string;
  currency: string;
  recipientName: string;
  transferId: string;
}): Promise<SendResult> {
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">Transfer completed</h2>
  <p>A transfer of <strong>${params.amount} ${params.currency}</strong> to <strong>${params.recipientName}</strong> has been completed.</p>
  <p style="font-size: 14px; color: #666;">Transfer ID: ${params.transferId}</p>
  ${ctaButton(`${dashboardUrl()}/dashboard/transfers`, 'View Transfers')}`);

  return sendEmail(
    params.to,
    `Transfer of ${params.amount} ${params.currency} completed`,
    html,
    'transfer-completed',
  );
}

export async function sendTransferFailedEmail(params: {
  to: string;
  amount: string;
  currency: string;
  recipientName: string;
  transferId: string;
  reason?: string;
}): Promise<SendResult> {
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">Transfer failed</h2>
  <p>A transfer of <strong>${params.amount} ${params.currency}</strong> to <strong>${params.recipientName}</strong> has failed.</p>
  ${params.reason ? `<p style="font-size: 14px; color: #666;">Reason: ${params.reason}</p>` : ''}
  <p style="font-size: 14px; color: #666;">Transfer ID: ${params.transferId}</p>
  ${ctaButton(`${dashboardUrl()}/dashboard/transfers`, 'View Transfers')}`);

  return sendEmail(
    params.to,
    `Transfer of ${params.amount} ${params.currency} failed`,
    html,
    'transfer-failed',
  );
}

export async function sendAccountLockedEmail(params: {
  to: string;
  userName: string;
}): Promise<SendResult> {
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">Account locked</h2>
  <p>Hi ${params.userName},</p>
  <p>Your account has been temporarily locked due to multiple failed login attempts. It will unlock automatically after 15 minutes.</p>
  <p style="font-size: 14px; color: #666;">If this wasn't you, please contact support immediately.</p>`);

  return sendEmail(params.to, 'Your Sly account has been locked', html, 'account-locked');
}

export async function sendApiKeyCreatedEmail(params: {
  to: string;
  keyPrefix: string;
  keyName: string;
  environment: string;
}): Promise<SendResult> {
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">New API key created</h2>
  <p>A new <strong>${params.environment}</strong> API key "<strong>${params.keyName}</strong>" (${params.keyPrefix}...) was created on your account.</p>
  <p style="font-size: 14px; color: #666;">If you didn't create this key, please revoke it immediately and review your account security.</p>
  ${ctaButton(`${dashboardUrl()}/dashboard/settings`, 'Manage API Keys')}`);

  return sendEmail(params.to, 'New API key created on Sly', html, 'api-key-created');
}

export async function sendApiKeyRevokedEmail(params: {
  to: string;
  keyPrefix: string;
  keyName: string;
  environment: string;
}): Promise<SendResult> {
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">API key revoked</h2>
  <p>The <strong>${params.environment}</strong> API key "<strong>${params.keyName}</strong>" (${params.keyPrefix}...) has been revoked and will no longer work.</p>
  <p style="font-size: 14px; color: #666;">If you didn't revoke this key, please review your account security immediately.</p>
  ${ctaButton(`${dashboardUrl()}/dashboard/settings`, 'Manage API Keys')}`);

  return sendEmail(params.to, 'API key revoked on Sly', html, 'api-key-revoked');
}

export async function sendRoleChangedEmail(params: {
  to: string;
  userName: string;
  organizationName: string;
  newRole: string;
}): Promise<SendResult> {
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">Your role has been updated</h2>
  <p>Hi ${params.userName},</p>
  <p>Your role in <strong>${params.organizationName}</strong> has been changed to <strong>${params.newRole}</strong>.</p>
  ${ctaButton(dashboardUrl(), 'Go to Dashboard')}`);

  return sendEmail(
    params.to,
    `Your role was changed to ${params.newRole}`,
    html,
    'role-changed',
  );
}

export async function sendMemberRemovedEmail(params: {
  to: string;
  userName: string;
  organizationName: string;
}): Promise<SendResult> {
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">You've been removed from ${params.organizationName}</h2>
  <p>Hi ${params.userName},</p>
  <p>You have been removed from <strong>${params.organizationName}</strong> on Sly. You will no longer have access to this organization's resources.</p>
  <p style="font-size: 14px; color: #666;">If you believe this was a mistake, please contact the organization administrator.</p>`);

  return sendEmail(
    params.to,
    `You've been removed from ${params.organizationName}`,
    html,
    'member-removed',
  );
}

// ============================================
// Beta Access emails
// ============================================

export async function sendBetaApplicationReceivedEmail(params: {
  to: string;
  organizationName?: string;
}): Promise<SendResult> {
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">We received your application</h2>
  <p>Thanks for applying to the Sly beta${params.organizationName ? ` for <strong>${params.organizationName}</strong>` : ''}!</p>
  <p>We're reviewing applications on a rolling basis and will get back to you soon. In the meantime, you can learn more about what we're building.</p>
  <p style="font-size: 14px; color: #666;">If you have questions, reply to this email — we read every response.</p>`);

  return sendEmail(
    params.to,
    'We received your Sly beta application',
    html,
    'beta-application-received',
  );
}

export async function sendBetaApprovedEmail(params: {
  to: string;
  code: string;
  organizationName?: string;
}): Promise<SendResult> {
  const signupUrl = `${dashboardUrl()}/auth/signup/code?code=${encodeURIComponent(params.code)}`;
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">You're in!</h2>
  <p>Great news — your Sly beta application${params.organizationName ? ` for <strong>${params.organizationName}</strong>` : ''} has been approved.</p>
  <p>Use the button below to create your account. Your invite code is:</p>
  <div style="text-align: center; margin: 16px 0;">
    <code style="display: inline-block; padding: 8px 16px; background-color: #f4f4f5; border-radius: 6px; font-size: 16px; font-weight: 600; letter-spacing: 1px;">${params.code}</code>
  </div>
  ${ctaButton(signupUrl, 'Create Your Account')}
  <p style="font-size: 14px; color: #666;">This code is single-use and tied to your application. Don't share it.</p>`);

  return sendEmail(
    params.to,
    "You're in! Your Sly beta access is ready",
    html,
    'beta-approved',
  );
}

export async function sendBetaRejectedEmail(params: {
  to: string;
  organizationName?: string;
}): Promise<SendResult> {
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">Update on your application</h2>
  <p>Thanks for your interest in Sly${params.organizationName ? ` for <strong>${params.organizationName}</strong>` : ''}.</p>
  <p>After review, we're unable to offer beta access at this time. We're onboarding in waves and may revisit your application in the future.</p>
  <p style="font-size: 14px; color: #666;">If you have questions, feel free to reply to this email.</p>`);

  return sendEmail(
    params.to,
    'Update on your Sly beta application',
    html,
    'beta-rejected',
  );
}

export async function sendBetaNewApplicationNotification(params: {
  to: string;
  applicantEmail: string;
  organizationName?: string;
  applicantType: string;
}): Promise<SendResult> {
  const html = emailLayout(`
  <h2 style="font-size: 20px; font-weight: 600;">New beta application</h2>
  <p>A new ${params.applicantType} application has been submitted:</p>
  <ul style="font-size: 14px; color: #333; padding-left: 20px;">
    <li><strong>Email:</strong> ${params.applicantEmail}</li>
    ${params.organizationName ? `<li><strong>Organization:</strong> ${params.organizationName}</li>` : ''}
    <li><strong>Type:</strong> ${params.applicantType}</li>
  </ul>
  ${ctaButton(`${dashboardUrl()}/admin/beta`, 'Review Applications')}`);

  return sendEmail(
    params.to,
    `New beta application from ${params.applicantEmail}`,
    html,
    'beta-new-application',
  );
}
