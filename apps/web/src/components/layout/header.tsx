'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { LogOut, Settings, User, Search, ChevronDown, Check, Play, Square, AlertTriangle } from 'lucide-react';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { useState } from 'react';
import { ThemeToggleSimple } from '@/components/theme-toggle';
import { GlobalSearch, useGlobalSearch } from '@/components/search/global-search';
import { NotificationsCenter } from '@/components/notifications/notifications-center';
import { useDemoMode } from '@/components/demo/demo-mode-context';
import { ScenarioSelector } from '@/components/demo/scenario-selector';
import { useEnvironment, type Environment } from '@/lib/environment-context';
import { toast } from 'sonner';

interface HeaderProps {
  user: SupabaseUser | null;
}

export function Header({ user }: HeaderProps) {
  const router = useRouter();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showEnvMenu, setShowEnvMenu] = useState(false);
  const [showProdConfirm, setShowProdConfirm] = useState(false);
  const [showScenarioSelector, setShowScenarioSelector] = useState(false);
  const { environment, setEnvironment } = useEnvironment();
  const globalSearch = useGlobalSearch();
  const demoMode = useDemoMode();
  const queryClient = useQueryClient();

  const handleSignOut = async () => {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    queryClient.clear();
    router.push('/auth/login');
    router.refresh();
  };

  const handleEnvironmentChange = (env: Environment) => {
    if (env === 'production' && environment !== 'production') {
      setShowEnvMenu(false);
      setShowProdConfirm(true);
      return;
    }
    applyEnvironmentChange(env);
  };

  const applyEnvironmentChange = (env: Environment) => {
    setEnvironment(env);
    setShowEnvMenu(false);
    setShowProdConfirm(false);
    queryClient.invalidateQueries();
    toast.success(`Switched to ${env === 'production' ? 'Production' : 'Sandbox'}`, {
      description: env === 'production'
        ? 'Showing live data. Transactions are real.'
        : 'Showing test data. Safe to experiment.',
    });
  };

  const initials = user?.email
    ? user.email.substring(0, 2).toUpperCase()
    : 'U';

  const userName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User';

  return (
    <>
      <header className="sticky top-0 z-40 h-16 flex items-center justify-between px-6 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
        {/* Search - Now triggers global search modal */}
        <div className="flex-1 max-w-xl">
          <button
            onClick={globalSearch.open}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left"
          >
            <Search className="w-4 h-4 text-gray-400" />
            <span className="flex-1 text-gray-500 dark:text-gray-400">Search or ask anything...</span>
            <kbd className="hidden sm:flex items-center gap-0.5 px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs text-gray-500 dark:text-gray-400 font-medium">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-3">
          {/* Environment Dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowEnvMenu(!showEnvMenu)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${environment === 'sandbox'
                ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'
                : 'bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-400 border border-orange-200 dark:border-orange-800'
                }`}
            >
              <span className={`w-2 h-2 rounded-full ${environment === 'sandbox' ? 'bg-emerald-500' : 'bg-orange-500'
                }`} />
              {environment === 'sandbox' ? 'SANDBOX' : 'PRODUCTION'}
              <ChevronDown className="w-4 h-4" />
            </button>

            {showEnvMenu && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowEnvMenu(false)}
                />
                <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-lg z-20 overflow-hidden">
                  <div className="p-1">
                    <button
                      onClick={() => handleEnvironmentChange('sandbox')}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-500" />
                        Sandbox
                      </div>
                      {environment === 'sandbox' && <Check className="w-4 h-4 text-emerald-500" />}
                    </button>
                    <button
                      onClick={() => handleEnvironmentChange('production')}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-orange-500" />
                        Production
                      </div>
                      {environment === 'production' && <Check className="w-4 h-4 text-orange-500" />}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Demo Mode Toggle — sandbox only */}
          {environment === 'sandbox' && (
            <div className="relative">
              <button
                onClick={() => {
                  if (demoMode.active) {
                    setShowScenarioSelector(!showScenarioSelector);
                  } else {
                    demoMode.setActive(true);
                    setShowScenarioSelector(true);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  demoMode.active
                    ? 'bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-400 border border-purple-200 dark:border-purple-800'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
              >
                {demoMode.active ? (
                  <Square className="w-3.5 h-3.5" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                Demo
              </button>
              {showScenarioSelector && (
                <ScenarioSelector onClose={() => setShowScenarioSelector(false)} />
              )}
            </div>
          )}

          {/* Theme Toggle */}
          <ThemeToggleSimple />

          {/* Notifications - Now uses NotificationsCenter */}
          <NotificationsCenter />

          {/* User menu */}
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-3 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
            >
              <div className="hidden md:block text-right">
                <div className="text-sm font-medium text-gray-900 dark:text-white">
                  {userName}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Admin
                </div>
              </div>
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center text-white text-sm font-semibold">
                {initials}
              </div>
            </button>

            {/* Dropdown */}
            {showUserMenu && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowUserMenu(false)}
                />
                <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-lg z-20 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                    <div className="text-sm font-medium text-gray-900 dark:text-white">
                      {userName}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {user?.email || 'No email'}
                    </div>
                  </div>
                  <div className="py-1">
                    <button className="w-full flex items-center gap-3 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                      <User className="w-4 h-4" />
                      Profile
                    </button>
                    <button
                      onClick={() => {
                        setShowUserMenu(false);
                        router.push('/dashboard/settings');
                      }}
                      className="w-full flex items-center gap-3 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    >
                      <Settings className="w-4 h-4" />
                      Settings
                    </button>
                  </div>
                  <div className="border-t border-gray-200 dark:border-gray-800 py-1">
                    <button
                      onClick={handleSignOut}
                      className="w-full flex items-center gap-3 px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign out
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Global Search Modal */}
      <GlobalSearch isOpen={globalSearch.isOpen} onClose={globalSearch.close} />

      {/* Production Confirmation Modal */}
      {showProdConfirm && (
        <>
          <div className="fixed inset-0 bg-black/50 z-50" onClick={() => setShowProdConfirm(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-md w-full p-6 border border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-orange-100 dark:bg-orange-950 rounded-lg">
                  <AlertTriangle className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Switch to Production?</h3>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                You are about to switch to the <strong>production environment</strong>. In this mode:
              </p>
              <ul className="text-sm text-gray-600 dark:text-gray-400 mb-6 space-y-1 list-disc list-inside">
                <li>All transactions use <strong>real funds</strong></li>
                <li>Wallet operations settle on <strong>Base mainnet</strong></li>
                <li>Actions <strong>cannot be reversed</strong></li>
              </ul>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setShowProdConfirm(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => applyEnvironmentChange('production')}
                  className="px-4 py-2 text-sm font-medium text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors"
                >
                  Switch to Production
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
