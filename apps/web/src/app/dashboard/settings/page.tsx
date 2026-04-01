'use client';

import { useState, useEffect } from 'react';
import { useTheme } from 'next-themes';
import { User, Bell, Shield, Palette, Moon, Sun, Monitor, Check, Globe, Users, Bot, LayoutDashboard } from 'lucide-react';
import { useLocale, type Locale } from '@/lib/locale';
import { useApiConfig } from '@/lib/api-client';
import { useSidebarData } from '@/components/layout/use-sidebar-data';

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale, formatCurrency, formatDate } = useLocale();
  const { apiUrl } = useApiConfig();
  const { showFullSidebar, setShowFullSidebar } = useSidebarData();
  const [mounted, setMounted] = useState(false);
  const [resourceUsage, setResourceUsage] = useState<{
    teamMembers: { current: number; limit: number | null };
    agents: { current: number; limit: number | null };
  } | null>(null);
  const [notifications, setNotifications] = useState({
    email: true,
    push: false,
    streams: true,
    transfers: true,
  });

  // Prevent hydration mismatch by only showing theme-dependent content after mount
  useEffect(() => {
    setMounted(true);
  }, []);

  // Fetch resource usage
  useEffect(() => {
    async function fetchUsage() {
      try {
        const { createSupabaseBrowserClient } = await import('@/lib/supabase/client');
        const supabase = createSupabaseBrowserClient();
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) return;

        const res = await fetch(`${apiUrl}/v1/organization`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.maxTeamMembers || data.maxAgents) {
          setResourceUsage({
            teamMembers: { current: data.teamMemberCount || 0, limit: data.maxTeamMembers || null },
            agents: { current: data.agentCount || 0, limit: data.maxAgents || null },
          });
        }
      } catch {
        // Non-critical — just don't show usage
      }
    }
    fetchUsage();
  }, []);

  const localeOptions: Array<{ value: Locale; label: string; description: string; example: string }> = [
    {
      value: 'en-US',
      label: 'United States',
      description: 'USD, MM/DD/YYYY',
      example: `${formatCurrency(1234.56, 'USD')} • ${formatDate(new Date())}`
    },
    {
      value: 'en-EU',
      label: 'Europe',
      description: 'EUR, DD/MM/YYYY',
      example: `${formatCurrency(1234.56, 'EUR')} • ${formatDate(new Date())}`
    },
    {
      value: 'es-LATAM',
      label: 'Latin America',
      description: 'USD, DD/MM/YYYY',
      example: `${formatCurrency(1234.56, 'USD')} • ${formatDate(new Date())}`
    },
  ];

  const themeOptions = [
    { value: 'light', label: 'Light', icon: Sun, description: 'Light background with dark text' },
    { value: 'dark', label: 'Dark', icon: Moon, description: 'Dark background with light text' },
    { value: 'system', label: 'System', icon: Monitor, description: 'Follow system preference' },
  ];

  return (
      <div className="space-y-6">
        {/* Profile Section */}
        <section className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-blue-100 dark:bg-blue-950 rounded-xl flex items-center justify-center">
              <User className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Profile</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">Your personal information</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Display Name
              </label>
              <input
                type="text"
                defaultValue="Admin User"
                className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Email
              </label>
              <input
                type="email"
                defaultValue="admin@payos.io"
                className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled
              />
              <p className="mt-1 text-xs text-gray-500">Email cannot be changed</p>
            </div>
          </div>
        </section>

        {/* Resource Usage Section (shown when limits are set) */}
        {resourceUsage && (resourceUsage.teamMembers.limit || resourceUsage.agents.limit) && (
          <section className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 bg-indigo-100 dark:bg-indigo-950 rounded-xl flex items-center justify-center">
                <Users className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Resource Usage</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400">Your current plan limits</p>
              </div>
            </div>

            <div className="space-y-4">
              {resourceUsage.teamMembers.limit && (
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5" /> Team Members
                    </span>
                    <span className="text-gray-500 dark:text-gray-400">
                      {resourceUsage.teamMembers.current} / {resourceUsage.teamMembers.limit}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full transition-all ${
                        resourceUsage.teamMembers.current >= resourceUsage.teamMembers.limit
                          ? 'bg-red-500'
                          : resourceUsage.teamMembers.current >= resourceUsage.teamMembers.limit * 0.8
                          ? 'bg-yellow-500'
                          : 'bg-indigo-500'
                      }`}
                      style={{ width: `${Math.min(100, (resourceUsage.teamMembers.current / resourceUsage.teamMembers.limit) * 100)}%` }}
                    />
                  </div>
                </div>
              )}

              {resourceUsage.agents.limit && (
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                      <Bot className="h-3.5 w-3.5" /> Agents
                    </span>
                    <span className="text-gray-500 dark:text-gray-400">
                      {resourceUsage.agents.current} / {resourceUsage.agents.limit}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full transition-all ${
                        resourceUsage.agents.current >= resourceUsage.agents.limit
                          ? 'bg-red-500'
                          : resourceUsage.agents.current >= resourceUsage.agents.limit * 0.8
                          ? 'bg-yellow-500'
                          : 'bg-indigo-500'
                      }`}
                      style={{ width: `${Math.min(100, (resourceUsage.agents.current / resourceUsage.agents.limit) * 100)}%` }}
                    />
                  </div>
                </div>
              )}

              <p className="text-xs text-gray-400 dark:text-gray-500">
                Need higher limits? Contact us at support@getsly.ai
              </p>
            </div>
          </section>
        )}

        {/* Localization Section */}
        <section className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-green-100 dark:bg-green-950 rounded-xl flex items-center justify-center">
              <Globe className="h-5 w-5 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Localization</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">Date and currency formatting</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Region
            </label>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {localeOptions.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setLocale(option.value)}
                  className={`relative p-4 rounded-xl border-2 transition-all text-left ${locale === option.value
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                      : 'border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700'
                    }`}
                >
                  {locale === option.value && (
                    <div className="absolute top-2 right-2 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                      <Check className="h-3 w-3 text-white" />
                    </div>
                  )}
                  <div className="text-sm font-medium text-gray-900 dark:text-white mb-1">
                    {option.label}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    {option.description}
                  </div>
                  <div className="text-xs text-gray-400 dark:text-gray-500 font-mono">
                    {option.example}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Dashboard Section */}
        <section className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-orange-100 dark:bg-orange-950 rounded-xl flex items-center justify-center">
              <LayoutDashboard className="h-5 w-5 text-orange-600 dark:text-orange-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Dashboard</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">Customize your sidebar and navigation</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-2">
              <div>
                <div className="text-sm font-medium text-gray-900 dark:text-white">Show all sidebar sections</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Display the Operations section in the sidebar</div>
              </div>
              <button
                onClick={() => setShowFullSidebar(!showFullSidebar)}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  showFullSidebar
                    ? 'bg-blue-600'
                    : 'bg-gray-200 dark:bg-gray-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    showFullSidebar
                      ? 'translate-x-5'
                      : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>
        </section>

        {/* Appearance Section */}
        <section className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-purple-100 dark:bg-purple-950 rounded-xl flex items-center justify-center">
              <Palette className="h-5 w-5 text-purple-600 dark:text-purple-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Appearance</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">Customize how Sly looks</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Theme
            </label>
            <div className="grid grid-cols-3 gap-3">
              {themeOptions.map((option) => {
                const isSelected = mounted && theme === option.value;
                return (
                  <button
                    key={option.value}
                    onClick={() => setTheme(option.value)}
                    className={`relative p-4 rounded-xl border-2 transition-all ${isSelected
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                        : 'border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700'
                      }`}
                  >
                    {isSelected && (
                      <div className="absolute top-2 right-2 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                        <Check className="h-3 w-3 text-white" />
                      </div>
                    )}
                    <option.icon className={`h-6 w-6 mb-2 ${isSelected ? 'text-blue-600' : 'text-gray-400'
                      }`} />
                    <div className="text-sm font-medium text-gray-900 dark:text-white">
                      {option.label}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {option.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Notifications Section */}
        <section className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-yellow-100 dark:bg-yellow-950 rounded-xl flex items-center justify-center">
              <Bell className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Notifications</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">Configure your notification preferences</p>
            </div>
          </div>

          <div className="space-y-4">
            {[
              { key: 'email', label: 'Email Notifications', description: 'Receive updates via email' },
              { key: 'push', label: 'Push Notifications', description: 'Browser push notifications' },
              { key: 'streams', label: 'Stream Alerts', description: 'Alerts for stream health changes' },
              { key: 'transfers', label: 'Transfer Updates', description: 'Notifications for transfer status' },
            ].map((item) => (
              <div key={item.key} className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm font-medium text-gray-900 dark:text-white">{item.label}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{item.description}</div>
                </div>
                <button
                  onClick={() => setNotifications(prev => ({
                    ...prev,
                    [item.key]: !prev[item.key as keyof typeof prev]
                  }))}
                  className={`relative w-11 h-6 rounded-full transition-colors ${notifications[item.key as keyof typeof notifications]
                      ? 'bg-blue-600'
                      : 'bg-gray-200 dark:bg-gray-700'
                    }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${notifications[item.key as keyof typeof notifications]
                        ? 'translate-x-5'
                        : 'translate-x-0'
                      }`}
                  />
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Security Section */}
        <section className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-red-100 dark:bg-red-950 rounded-xl flex items-center justify-center">
              <Shield className="h-5 w-5 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Security</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">Manage your security settings</p>
            </div>
          </div>

          <div className="space-y-4">
            <button className="w-full px-4 py-3 text-left bg-gray-50 dark:bg-gray-900 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors">
              <div className="text-sm font-medium text-gray-900 dark:text-white">Change Password</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Update your password</div>
            </button>
            <button className="w-full px-4 py-3 text-left bg-gray-50 dark:bg-gray-900 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors">
              <div className="text-sm font-medium text-gray-900 dark:text-white">Two-Factor Authentication</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Add an extra layer of security</div>
            </button>
            <button className="w-full px-4 py-3 text-left bg-gray-50 dark:bg-gray-900 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors">
              <div className="text-sm font-medium text-gray-900 dark:text-white">Active Sessions</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">View and manage logged in devices</div>
            </button>
          </div>
        </section>

      </div>
  );
}
