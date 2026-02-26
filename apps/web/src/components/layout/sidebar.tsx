'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api-client';
import { cn } from '@sly/ui';
import {
  Home,
  Users,
  Bot,
  ArrowLeftRight,
  Activity,
  FileText,
  Settings,
  Key,
  Webhook,
  Shield,
  Wallet,
  Landmark,
  CreditCard,
  FileCode,
  ShieldCheck,
  ChevronLeft,
  ChevronDown,
  LayoutDashboard,
  Zap,
  BarChart3,
  Globe,
  Code,
  FileCheck,
  ShoppingCart,
  Terminal,
  ScrollText,
  RotateCcw,
  Calendar,
  UserCheck,
  Package,
  Plug,
  Rocket,
  GitBranch,
  DollarSign,
  Network,
  MessageSquare,
} from 'lucide-react';
import { useSidebar } from './sidebar-context';
import { useState } from 'react';

const agenticPaymentsChildren = [
  {
    href: '/dashboard/agentic-payments',
    label: 'Overview',
    icon: LayoutDashboard,
    exact: true, // Only highlight when exactly on this path
  },
  {
    href: '/dashboard/agentic-payments/analytics',
    label: 'Analytics',
    icon: BarChart3
  },
  {
    label: 'UCP',
    icon: Globe,
    children: [
      { href: '/dashboard/agentic-payments/ucp/hosted-checkouts', label: 'Checkouts', icon: ShoppingCart },
      { href: '/dashboard/agentic-payments/ucp/orders', label: 'Orders', icon: Package },
      { href: '/dashboard/agentic-payments/ucp/identity', label: 'Identity', icon: Users },
      { href: '/dashboard/agentic-payments/ucp/integration', label: 'Integration', icon: Code },
    ]
  },
  {
    label: 'ACP',
    icon: ShoppingCart,
    children: [
      { href: '/dashboard/agentic-payments/acp/checkouts', label: 'Checkouts', icon: CreditCard },
      { href: '/dashboard/agentic-payments/acp/integration', label: 'Integration', icon: Code },
    ]
  },
  {
    label: 'AP2',
    icon: Bot,
    children: [
      { href: '/dashboard/agentic-payments/ap2/mandates', label: 'Mandates', icon: FileCheck },
      { href: '/dashboard/agentic-payments/ap2/integration', label: 'Integration', icon: Code },
    ]
  },
  {
    label: 'x402',
    icon: Zap,
    children: [
      { href: '/dashboard/agentic-payments/x402/endpoints', label: 'Endpoints', icon: Globe },
      { href: '/dashboard/agentic-payments/x402/integration', label: 'Integration', icon: Code },
    ]
  },
];

const configurationNav = [
  { href: '/dashboard/protocols', label: 'Protocols', icon: Globe },
  { href: '/dashboard/payment-handlers', label: 'Payment Handlers', icon: Plug },
  { href: '/dashboard/card-networks', label: 'Card Networks', icon: CreditCard },
  { href: '/dashboard/settlement-rules', label: 'Settlement Rules', icon: Settings },
  { href: '/dashboard/templates', label: 'Templates', icon: FileCode },
  { href: '/dashboard/verification-tiers', label: 'Verification Tiers', icon: ShieldCheck },
  { href: '/dashboard/agent-tiers', label: 'Agent Tiers (KYA)', icon: UserCheck },
  // Developer section items (collapsible)
  { href: '/dashboard/api-keys', label: 'API Keys', icon: Key },
  { href: '/dashboard/webhooks', label: 'Webhooks', icon: Webhook },
  { href: '/dashboard/logs', label: 'Logs', icon: ScrollText },
];

const settingsNav = [
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
  { href: '/dashboard/settings/team', label: 'Team', icon: Users },
];

interface NavItemProps {
  href: string;
  label: string;
  icon: any;
  badge?: number;
  exact?: boolean;
}

export function Sidebar() {
  const pathname = usePathname();
  const { collapsed, setCollapsed } = useSidebar();
  const api = useApiClient();
  const [configExpanded, setConfigExpanded] = useState(false);
  const [agentsExpanded, setAgentsExpanded] = useState(() => pathname.startsWith('/dashboard/agents'));
  const [agenticExpanded, setAgenticExpanded] = useState(() => pathname.startsWith('/dashboard/agentic-payments'));

  // Fetch real compliance count
  const { data: complianceCount } = useQuery({
    queryKey: ['compliance', 'open-count'],
    queryFn: async () => {
      if (!api) return 0;
      return api.compliance.getOpenFlagsCount();
    },
    enabled: !!api,
    staleTime: 30 * 1000, // Cache for 30 seconds
    refetchOnWindowFocus: true, // Refetch when user comes back to window
  });

  // Build main nav with dynamic compliance count
  const mainNav = [
    { href: '/dashboard', label: 'Home', icon: Home },
    { href: '/dashboard/onboarding', label: 'Setup Guide', icon: Rocket },
    { href: '/dashboard/accounts', label: 'Accounts', icon: Users },
    { href: '/dashboard/transfers', label: 'Transactions', icon: ArrowLeftRight },
    { href: '/dashboard/settlements', label: 'Settlements', icon: Landmark },
    { href: '/dashboard/wallets', label: 'Wallets', icon: Wallet },
    { href: '/dashboard/schedules', label: 'Schedules', icon: Calendar },
    { href: '/dashboard/refunds', label: 'Refunds', icon: RotateCcw },
    { href: '/dashboard/cards', label: 'Cards', icon: CreditCard },
    { href: '/dashboard/workflows', label: 'Workflows', icon: GitBranch },
    { href: '/dashboard/funding', label: 'Funding', icon: DollarSign },
    { href: '/dashboard/compliance', label: 'Compliance', icon: Shield, badge: complianceCount || undefined },
    { href: '/dashboard/treasury', label: 'Treasury', icon: Landmark },
    { href: '/dashboard/developers', label: 'Developers', icon: Terminal },
    { href: '/dashboard/reports', label: 'Reports', icon: FileText },
  ];

  const isActive = (href: string, exact?: boolean) => {
    if (href === '/dashboard' || href === '#' || exact) {
      return pathname === href;
    }
    return pathname.startsWith(href);
  };

  // Check if any agents route is active
  const isAgentsActive = pathname.startsWith('/dashboard/agents');

  // Check if any agentic payments route is active
  const isAgenticActive = pathname.startsWith('/dashboard/agentic-payments');

  const NavItem = ({ item, className }: { item: NavItemProps; className?: string }) => {
    const Icon = item.icon;
    const active = isActive(item.href, item.exact);

    return (
      <Link
        href={item.href}
        className={cn(
          'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
          active
            ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400'
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800',
          collapsed && 'justify-center',
          item.badge && 'relative',
          className
        )}
        title={collapsed ? item.label : undefined}
      >
        <Icon className="w-5 h-5 flex-shrink-0" />
        {!collapsed && (
          <>
            <span className="flex-1 text-left">{item.label}</span>
            {item.badge && (
              <span className="px-2 py-0.5 text-xs font-medium bg-red-100 dark:bg-red-950 text-red-600 dark:text-red-400 rounded-full">
                {item.badge}
              </span>
            )}
          </>
        )}
        {collapsed && item.badge && (
          <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
        )}
      </Link>
    );
  };

  return (
    <aside className={cn(
      'hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:flex-col',
      'bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800',
      'transition-all duration-300',
      collapsed ? 'lg:w-20' : 'lg:w-64'
    )}>
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-6 border-b border-gray-200 dark:border-gray-800">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div
            className="w-8 h-8 flex-shrink-0 bg-blue-600"
            style={{
              WebkitMaskImage: 'url(/sly-logo.png)',
              WebkitMaskSize: 'contain',
              WebkitMaskRepeat: 'no-repeat',
              WebkitMaskPosition: 'center',
              maskImage: 'url(/sly-logo.png)',
              maskSize: 'contain',
              maskRepeat: 'no-repeat',
              maskPosition: 'center',
            }}
          />
          {!collapsed && (
            <span className="text-xl font-bold text-gray-900 dark:text-white">Sly</span>
          )}
        </Link>

        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
        >
          <ChevronLeft className={cn(
            'w-5 h-5 text-gray-600 dark:text-gray-400 transition-transform',
            collapsed && 'rotate-180'
          )} />
        </button>
      </div>

      {/* Main Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {/* Home Link */}
        <NavItem item={mainNav[0]} />

        {/* Agents - Collapsible Section */}
        <div className="space-y-1">
          {!collapsed ? (
            <>
              <button
                onClick={() => setAgentsExpanded(!agentsExpanded)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  isAgentsActive
                    ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                )}
              >
                <Bot className="w-5 h-5 flex-shrink-0" />
                <span className="flex-1 text-left">Agents</span>
                <ChevronDown className={cn(
                  'w-4 h-4 transition-transform',
                  agentsExpanded && 'rotate-180'
                )} />
              </button>
              {agentsExpanded && (
                <div className="ml-4 pl-4 border-l border-gray-200 dark:border-gray-700 space-y-1">
                  <NavItem item={{ href: '/dashboard/agents', label: 'Overview', icon: Bot, exact: true }} className="py-2" />
                  <div className="space-y-1 mb-1">
                    <div className="px-3 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 flex items-center gap-2 uppercase">
                      <Network className="w-3.5 h-3.5" />
                      <span>A2A</span>
                    </div>
                    <div className="space-y-0.5">
                      <NavItem item={{ href: '/dashboard/agents/a2a/tasks', label: 'Tasks', icon: FileText }} className="py-2 text-xs" />
                      <NavItem item={{ href: '/dashboard/agents/a2a/sessions', label: 'Sessions', icon: MessageSquare }} className="py-2 text-xs" />
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <Link
              href="/dashboard/agents"
              className={cn(
                'w-full flex items-center justify-center px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isAgentsActive
                  ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              )}
              title="Agents"
            >
              <Bot className="w-5 h-5" />
            </Link>
          )}
        </div>

        {/* Agentic Payments - Collapsible Section */}
        <div className="space-y-1">
          {!collapsed ? (
            <>
              <button
                onClick={() => setAgenticExpanded(!agenticExpanded)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  isAgenticActive
                    ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                )}
              >
                <Activity className="w-5 h-5 flex-shrink-0" />
                <span className="flex-1 text-left">Agentic Payments</span>
                <ChevronDown className={cn(
                  'w-4 h-4 transition-transform',
                  agenticExpanded && 'rotate-180'
                )} />
              </button>
              {agenticExpanded && (
                <div className="ml-4 pl-4 border-l border-gray-200 dark:border-gray-700 space-y-1">
                  {agenticPaymentsChildren.map((item: any) => {
                    if (item.children) {
                      return (
                        <div key={item.label} className="space-y-1 mb-1">
                          <div className="px-3 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 flex items-center gap-2 uppercase">
                            <item.icon className="w-3.5 h-3.5" />
                            <span>{item.label}</span>
                          </div>
                          <div className="space-y-0.5">
                            {item.children.map((child: any) => (
                              <NavItem key={child.href} item={child} className="py-2 text-xs" />
                            ))}
                          </div>
                        </div>
                      );
                    }
                    return <NavItem key={item.href} item={item} className="py-2" />;
                  })}
                </div>
              )}
            </>
          ) : (
            <Link
              href="/dashboard/agentic-payments"
              className={cn(
                'w-full flex items-center justify-center px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isAgenticActive
                  ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              )}
              title="Agentic Payments"
            >
              <Activity className="w-5 h-5" />
            </Link>
          )}
        </div>

        {/* Rest of Main Nav */}
        {mainNav.slice(1).map((item) => (
          <NavItem key={item.href} item={item} />
        ))}

        {/* Configuration Section - Collapsible (hidden when collapsed) */}
        {!collapsed && (
          <div className="pt-4 mt-4 border-t border-gray-200 dark:border-gray-800 space-y-1">
            <button
              onClick={() => setConfigExpanded(!configExpanded)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            >
              <span>Configuration</span>
              <ChevronDown className={cn(
                'w-4 h-4 transition-transform',
                configExpanded && 'rotate-180'
              )} />
            </button>
            {configExpanded && configurationNav.map((item) => (
              <NavItem key={item.href} item={item} />
            ))}
          </div>
        )}

        {/* Settings Section */}
        <div className="pt-4 mt-4 border-t border-gray-200 dark:border-gray-800 space-y-1">
          {settingsNav.map((item) => (
            <NavItem key={item.href} item={item} />
          ))}
        </div>
      </nav>

      {/* Version */}
      {!collapsed && (
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Sly v0.1.0
          </div>
        </div>
      )}
    </aside>
  );
}
