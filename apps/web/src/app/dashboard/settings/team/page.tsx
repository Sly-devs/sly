'use client';

import { useState, useEffect, useCallback } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { useApiConfig } from '@/lib/api-client';
import { Button } from '@sly/ui';
import { Input } from '@sly/ui';
import { Label } from '@sly/ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@sly/ui';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@sly/ui';
import { Loader2, UserPlus, Copy, Check, Trash2, Users, RefreshCw, X } from 'lucide-react';

interface TeamMember {
  id: string;
  name: string;
  email?: string;
  role: string;
}

interface TeamInvite {
  id: string;
  email: string;
  role: string;
  name?: string;
  expires_at?: string;
  expiresAt?: string;
  accepted_at?: string;
  acceptedAt?: string;
  expired?: boolean;
}

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];

const ROLE_BADGES: Record<string, string> = {
  owner: 'bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-300',
  admin: 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-300',
  member: 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300',
  viewer: 'bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-300',
};

async function getAuthHeaders(): Promise<Record<string, string>> {
  const supabase = createSupabaseBrowserClient();
  const { data: { session } } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
  };
}

export default function TeamSettingsPage() {
  const { apiUrl } = useApiConfig();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviting, setInviting] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteEmailSent, setInviteEmailSent] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [resendingInvite, setResendingInvite] = useState<string | null>(null);
  const [revokingInvite, setRevokingInvite] = useState<string | null>(null);

  // Current user (to determine permissions)
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);

  const fetchTeam = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const headers = await getAuthHeaders();

      const [teamRes, invitesRes, meRes] = await Promise.all([
        fetch(`${apiUrl}/v1/organization/team`, { headers }),
        fetch(`${apiUrl}/v1/organization/team/invites`, { headers }),
        fetch(`${apiUrl}/v1/auth/me`, { headers }),
      ]);

      if (teamRes.ok) {
        const teamData = await teamRes.json();
        // API returns { members: [...] } wrapped as { data: { members: [...] } }
        const inner = teamData.data || teamData;
        const memberList = inner.members || inner.data || [];
        setMembers(Array.isArray(memberList) ? memberList : []);
      }

      if (invitesRes.ok) {
        const inviteData = await invitesRes.json();
        // API returns { invites: [...] } wrapped as { data: { invites: [...] } }
        const inner = inviteData.data || inviteData;
        const allInvites = inner.invites || inner.data || [];
        const inviteList = Array.isArray(allInvites) ? allInvites : [];
        setInvites(inviteList.filter((i: TeamInvite) => !i.accepted_at && !i.acceptedAt));
      }

      if (meRes.ok) {
        const meData = await meRes.json();
        const me = meData.data || meData;
        // Session token path returns { user: { role }, tenant }
        const role = me.user?.role || me.role;
        if (role) {
          setCurrentUserRole(role);
        }
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load team');
    }

    setLoading(false);
  }, [apiUrl]);

  useEffect(() => {
    fetchTeam();
  }, [fetchTeam]);

  const canManageTeam = currentUserRole === 'owner' || currentUserRole === 'admin';

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInviteError(null);
    setInviteUrl(null);
    setInviteEmailSent(false);

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${apiUrl}/v1/organization/team/invite`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });

      const data = await res.json();

      if (!res.ok) {
        setInviteError(data.error || 'Failed to send invite');
        setInviting(false);
        return;
      }

      if (data.invite?.inviteUrl) {
        setInviteUrl(data.invite.inviteUrl);
        setInviteEmailSent(!!data.invite.emailSent);
      }

      setInviteEmail('');
      await fetchTeam();
    } catch (err: any) {
      setInviteError(err.message || 'Failed to send invite');
    }

    setInviting(false);
  }

  async function handleCopyUrl() {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  }

  async function handleRoleChange(userId: string, newRole: string) {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${apiUrl}/v1/organization/team/${userId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ role: newRole }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to update role');
        return;
      }

      await fetchTeam();
    } catch (err: any) {
      setError(err.message || 'Failed to update role');
    }
  }

  async function handleRemoveMember(userId: string, memberName: string) {
    if (!confirm(`Remove ${memberName} from the team?`)) return;

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${apiUrl}/v1/organization/team/${userId}`, {
        method: 'DELETE',
        headers,
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to remove member');
        return;
      }

      await fetchTeam();
    } catch (err: any) {
      setError(err.message || 'Failed to remove member');
    }
  }

  async function handleResendInvite(inviteId: string) {
    setResendingInvite(inviteId);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${apiUrl}/v1/organization/team/invites/${inviteId}/resend`, {
        method: 'POST',
        headers,
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to resend invite');
        setResendingInvite(null);
        return;
      }

      if (data.invite?.inviteUrl) {
        setInviteUrl(data.invite.inviteUrl);
        setInviteEmailSent(!!data.invite.emailSent);
      }

      await fetchTeam();
    } catch (err: any) {
      setError(err.message || 'Failed to resend invite');
    }
    setResendingInvite(null);
  }

  async function handleRevokeInvite(inviteId: string, email: string) {
    if (!confirm(`Revoke invite for ${email}?`)) return;
    setRevokingInvite(inviteId);

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${apiUrl}/v1/organization/team/invites/${inviteId}`, {
        method: 'DELETE',
        headers,
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to revoke invite');
        setRevokingInvite(null);
        return;
      }

      await fetchTeam();
    } catch (err: any) {
      setError(err.message || 'Failed to revoke invite');
    }
    setRevokingInvite(null);
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold">Team</h1>
        <p className="text-muted-foreground">Manage team members and invitations.</p>
      </div>

      {error && (
        <div className="p-3 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-md">
          {error}
        </div>
      )}

      {/* Invite Form */}
      {canManageTeam && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <UserPlus className="h-5 w-5" />
              Invite Member
            </CardTitle>
            <CardDescription>
              Send an invite link to add someone to your team.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleInvite} className="flex items-end gap-3">
              <div className="flex-1 space-y-2">
                <Label htmlFor="inviteEmail">Email</Label>
                <Input
                  id="inviteEmail"
                  type="email"
                  placeholder="colleague@company.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  required
                />
              </div>
              <div className="w-36 space-y-2">
                <Label htmlFor="inviteRole">Role</Label>
                <Select value={inviteRole} onValueChange={setInviteRole}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={inviting}>
                {inviting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Invite
              </Button>
            </form>

            {inviteError && (
              <div className="mt-3 p-3 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-md">
                {inviteError}
              </div>
            )}

            {inviteUrl && (
              <div className="mt-3 p-3 bg-green-50 dark:bg-green-900/10 rounded-md space-y-2">
                <p className="text-sm text-green-800 dark:text-green-200">
                  {inviteEmailSent
                    ? `Invite email sent to the recipient.`
                    : 'Invite created! Share this link:'}
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs bg-white dark:bg-gray-900 rounded px-2 py-1 break-all">
                    {inviteUrl}
                  </code>
                  <Button variant="outline" size="sm" onClick={handleCopyUrl}>
                    {copiedUrl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Members List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="h-5 w-5" />
            Members ({members.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No team members found.</p>
          ) : (
            <div className="divide-y">
              {members.map((member) => (
                <div key={member.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-medium">{member.name || member.email || 'Unknown'}</p>
                    {member.email && <p className="text-sm text-muted-foreground">{member.email}</p>}
                  </div>
                  <div className="flex items-center gap-3">
                    {canManageTeam && member.role !== 'owner' ? (
                      <Select
                        value={member.role}
                        onValueChange={(v) => handleRoleChange(member.id, v)}
                      >
                        <SelectTrigger className="w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${ROLE_BADGES[member.role] || ROLE_BADGES.member}`}>
                        {member.role}
                      </span>
                    )}

                    {canManageTeam && member.role !== 'owner' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveMember(member.id, member.name || member.email || 'this member')}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pending Invites */}
      {invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Pending Invites ({invites.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {invites.map((invite) => {
                const isExpired = invite.expired ?? new Date(invite.expiresAt || invite.expires_at || '') < new Date();
                return (
                  <div key={invite.id} className="flex items-center justify-between py-3">
                    <div>
                      <p className="font-medium">
                        {invite.email}
                        {isExpired && (
                          <span className="ml-2 text-xs px-2 py-0.5 rounded-full font-medium bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-300">
                            Expired
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {isExpired ? 'Expired' : 'Expires'} {new Date(invite.expiresAt || invite.expires_at || '').toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${ROLE_BADGES[invite.role] || ROLE_BADGES.member}`}>
                        {invite.role}
                      </span>
                      {canManageTeam && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={resendingInvite === invite.id}
                            onClick={() => handleResendInvite(invite.id)}
                            title="Resend invite"
                          >
                            {resendingInvite === invite.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={revokingInvite === invite.id}
                            onClick={() => handleRevokeInvite(invite.id, invite.email)}
                            title="Revoke invite"
                          >
                            {revokingInvite === invite.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <X className="h-4 w-4 text-red-500" />
                            )}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
