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
  Shield,
  Wallet,
  Landmark,
  CreditCard,
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
  Package,
  Rocket,
  GitBranch,
  DollarSign,
  Network,
  MessageSquare,
  Webhook,
  TrendingUp,
} from 'lucide-react';
import { useSidebar } from './sidebar-context';
import { useSidebarData } from './use-sidebar-data';
import { useState, type ReactNode } from 'react';

// --- Nav data ---

const agenticPaymentsChildren = [
  {
    href: '/dashboard/agentic-payments',
    label: 'Overview',
    icon: LayoutDashboard,
    exact: true,
  },
  {
    href: '/dashboard/agentic-payments/analytics',
    label: 'Analytics',
    icon: BarChart3,
  },
  {
    label: 'UCP',
    icon: Globe,
    children: [
      { href: '/dashboard/agentic-payments/ucp/hosted-checkouts', label: 'Checkouts', icon: ShoppingCart },
      { href: '/dashboard/agentic-payments/ucp/orders', label: 'Orders', icon: Package },
      { href: '/dashboard/agentic-payments/ucp/identity', label: 'Identity', icon: Users },
      { href: '/dashboard/agentic-payments/ucp/integration', label: 'Integration', icon: Code },
    ],
  },
  {
    label: 'ACP',
    icon: ShoppingCart,
    children: [
      { href: '/dashboard/agentic-payments/acp/checkouts', label: 'Checkouts', icon: CreditCard },
      { href: '/dashboard/agentic-payments/acp/analytics', label: 'Analytics', icon: BarChart3 },
      { href: '/dashboard/agentic-payments/acp/integration', label: 'Integration', icon: Code },
    ],
  },
  {
    label: 'AP2',
    icon: Bot,
    children: [
      { href: '/dashboard/agentic-payments/ap2/mandates', label: 'Mandates', icon: FileCheck },
      { href: '/dashboard/agentic-payments/ap2/analytics', label: 'Analytics', icon: BarChart3 },
      { href: '/dashboard/agentic-payments/ap2/integration', label: 'Integration', icon: Code },
    ],
  },
  {
    label: 'x402',
    icon: Zap,
    children: [
      { href: '/dashboard/agentic-payments/x402/endpoints', label: 'Endpoints', icon: Globe },
      { href: '/dashboard/agentic-payments/x402/integration', label: 'Integration', icon: Code },
    ],
  },
  {
    label: 'MPP',
    icon: DollarSign,
    children: [
      { href: '/dashboard/agentic-payments/mpp', label: 'Overview', icon: LayoutDashboard },
      { href: '/dashboard/agentic-payments/mpp/sessions', label: 'Sessions', icon: Activity },
    ],
  },
];

interface NavItemDef {
  href: string;
  label: string;
  icon: any;
  badge?: number;
  exact?: boolean;
}

// --- Reusable components ---

function CollapsibleSection({
  label,
  icon: Icon,
  expanded,
  onToggle,
  isActive,
  collapsed,
  href,
  children,
}: {
  label: string;
  icon: any;
  expanded: boolean;
  onToggle: () => void;
  isActive: boolean;
  collapsed: boolean;
  href: string;
  children: ReactNode;
}) {
  if (collapsed) {
    return (
      <Link
        href={href}
        className={cn(
          'w-full flex items-center justify-center px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
          isActive
            ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400'
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
        )}
        title={label}
      >
        <Icon className="w-5 h-5" />
      </Link>
    );
  }

  return (
    <div className="space-y-1">
      <button
        onClick={onToggle}
        className={cn(
          'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
          isActive
            ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400'
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
        )}
      >
        <Icon className="w-5 h-5 flex-shrink-0" />
        <span className="flex-1 text-left">{label}</span>
        <ChevronDown
          className={cn('w-4 h-4 transition-transform', expanded && 'rotate-180')}
        />
      </button>
      {expanded && (
        <div className="ml-4 pl-4 border-l border-gray-200 dark:border-gray-700 space-y-1">
          {children}
        </div>
      )}
    </div>
  );
}

function SectionHeader({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="pt-4 mt-4 border-t border-gray-200 dark:border-gray-800 space-y-1">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
      >
        <span>{label}</span>
        <ChevronDown
          className={cn('w-4 h-4 transition-transform', expanded && 'rotate-180')}
        />
      </button>
    </div>
  );
}

// --- Main sidebar ---

export function Sidebar() {
  const pathname = usePathname();
  const { collapsed, setCollapsed } = useSidebar();
  const api = useApiClient();
  const { isAdmin, enabledProtocols, showFullSidebar } = useSidebarData();

  // Collapsible state — auto-expand if pathname matches
  const [agentsExpanded, setAgentsExpanded] = useState(() => pathname.startsWith('/dashboard/agents'));
  const [agenticExpanded, setAgenticExpanded] = useState(() => pathname.startsWith('/dashboard/agentic-payments'));
  // Ops + Dev subgroup state persists to localStorage so a tenant who
  // expands "Developers" to reach the Logs page keeps it expanded on the
  // next visit. Default: expanded for admins — the common user flow
  // (finding Logs, API Keys, Operations dashboards) broke when these
  // auto-collapsed off-path and users complained they couldn't find
  // observability in the menu.
  const OPS_EXPANDED_KEY = 'sly:sidebar-ops-expanded';
  const DEV_EXPANDED_KEY = 'sly:sidebar-dev-expanded';
  const [opsExpanded, setOpsExpanded] = useState(() => {
    if (['/dashboard/settlements', '/dashboard/schedules', '/dashboard/refunds', '/dashboard/funding',
         '/dashboard/treasury', '/dashboard/reports', '/dashboard/compliance', '/dashboard/workflows',
         '/dashboard/fx', '/dashboard/operations',
        ].some((p) => pathname.startsWith(p))) return true;
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(OPS_EXPANDED_KEY);
      if (stored === 'false') return false;
    }
    return true;
  });
  const [devExpanded, setDevExpanded] = useState(() => {
    if (['/dashboard/developers', '/dashboard/api-keys', '/dashboard/webhooks', '/dashboard/logs',
        ].some((p) => pathname.startsWith(p))) return true;
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(DEV_EXPANDED_KEY);
      if (stored === 'false') return false;
    }
    return true;
  });
  const toggleOps = () => setOpsExpanded((prev) => {
    const next = !prev;
    try { window.localStorage.setItem(OPS_EXPANDED_KEY, String(next)); } catch {}
    return next;
  });
  const toggleDev = () => setDevExpanded((prev) => {
    const next = !prev;
    try { window.localStorage.setItem(DEV_EXPANDED_KEY, String(next)); } catch {}
    return next;
  });

  // Fetch real compliance count
  const { data: complianceCount } = useQuery({
    queryKey: ['compliance', 'open-count'],
    queryFn: async () => {
      if (!api) return 0;
      return api.compliance.getOpenFlagsCount();
    },
    enabled: !!api,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
  });

  // --- Nav arrays ---

  const coreNav: NavItemDef[] = [
    { href: '/dashboard', label: 'Home', icon: Home, exact: true },
    { href: '/dashboard/onboarding', label: 'Setup Guide', icon: Rocket },
  ];

  const coreNavAfterAgentic: NavItemDef[] = [
    { href: '/dashboard/wallets', label: 'Wallets', icon: Wallet },
    { href: '/dashboard/accounts', label: 'Accounts', icon: Users },
    { href: '/dashboard/transfers', label: 'Transactions', icon: ArrowLeftRight },
    { href: '/dashboard/cards', label: 'Cards', icon: CreditCard },
  ];

  const operationsNav: NavItemDef[] = [
    { href: '/dashboard/settlements', label: 'Settlements', icon: Landmark },
    { href: '/dashboard/schedules', label: 'Schedules', icon: Calendar },
    { href: '/dashboard/refunds', label: 'Refunds', icon: RotateCcw },
    { href: '/dashboard/funding', label: 'Funding', icon: DollarSign },
    { href: '/dashboard/treasury', label: 'Treasury', icon: Landmark },
    { href: '/dashboard/reports', label: 'Reports', icon: FileText },
    { href: '/dashboard/compliance', label: 'Compliance', icon: Shield, badge: complianceCount || undefined },
    { href: '/dashboard/disputes', label: 'Disputes', icon: Shield },
    { href: '/dashboard/workflows', label: 'Workflows', icon: GitBranch },
    { href: '/dashboard/fx', label: 'FX Rates', icon: TrendingUp },
    { href: '/dashboard/operations', label: 'Operations', icon: Activity },
  ];

  const developersNav: NavItemDef[] = [
    { href: '/dashboard/developers', label: 'Portal', icon: Terminal },
    { href: '/dashboard/api-keys', label: 'API Keys', icon: Key },
    { href: '/dashboard/webhooks', label: 'Webhooks', icon: Webhook },
    { href: '/dashboard/logs', label: 'Logs', icon: ScrollText },
  ];

  const settingsNav: NavItemDef[] = [
    { href: '/dashboard/settings', label: 'Settings', icon: Settings },
  ];

  // Filter agentic payments children by protocol status + role
  const visibleAgenticChildren = agenticPaymentsChildren.filter((item) => {
    if (item.label === 'UCP') return enabledProtocols.ucp;
    if (item.label === 'ACP') return enabledProtocols.acp;
    if (item.label === 'AP2') return enabledProtocols.ap2;
    if (item.label === 'x402') return enabledProtocols.x402;
    if (item.label === 'MPP') return isAdmin;
    return true; // Overview, Analytics always shown
  });

  // --- Helpers ---

  const isActive = (href: string, exact?: boolean) => {
    if (href === '/dashboard' || href === '#' || exact) {
      return pathname === href;
    }
    return pathname.startsWith(href);
  };

  const isAgentsActive = pathname.startsWith('/dashboard/agents');
  const isAgenticActive = pathname.startsWith('/dashboard/agentic-payments');

  const NavItem = ({ item, className }: { item: NavItemDef; className?: string }) => {
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

  // --- Render ---

  return (
    <aside
      className={cn(
        'hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:flex-col',
        'bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800',
        'transition-all duration-300',
        collapsed ? 'lg:w-20' : 'lg:w-64'
      )}
    >
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
          <ChevronLeft
            className={cn(
              'w-5 h-5 text-gray-600 dark:text-gray-400 transition-transform',
              collapsed && 'rotate-180'
            )}
          />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {/* 1. Core nav: Home, Setup Guide */}
        {coreNav.map((item) => (
          <NavItem key={item.href} item={item} />
        ))}

        {/* 2. Agents — collapsible, always visible */}
        <CollapsibleSection
          label="Agents"
          icon={Bot}
          expanded={agentsExpanded}
          onToggle={() => setAgentsExpanded(!agentsExpanded)}
          isActive={isAgentsActive}
          collapsed={collapsed}
          href="/dashboard/agents"
        >
          <NavItem
            item={{ href: '/dashboard/agents', label: 'Overview', icon: Bot, exact: true }}
            className="py-2"
          />
          <div className="space-y-1 mb-1">
            <div className="px-3 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 flex items-center gap-2 uppercase">
              <Network className="w-3.5 h-3.5" />
              <span>A2A</span>
            </div>
            <div className="space-y-0.5">
              <NavItem
                item={{ href: '/dashboard/agents/a2a/tasks', label: 'Tasks', icon: FileText }}
                className="py-2 text-xs"
              />
              <NavItem
                item={{ href: '/dashboard/agents/a2a/sessions', label: 'Sessions', icon: MessageSquare }}
                className="py-2 text-xs"
              />
            </div>
          </div>
        </CollapsibleSection>

        {/* 3. Agentic Payments — collapsible, always visible, children protocol-filtered */}
        <CollapsibleSection
          label="Agentic Payments"
          icon={Activity}
          expanded={agenticExpanded}
          onToggle={() => setAgenticExpanded(!agenticExpanded)}
          isActive={isAgenticActive}
          collapsed={collapsed}
          href="/dashboard/agentic-payments"
        >
          {visibleAgenticChildren.map((item: any) => {
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
        </CollapsibleSection>

        {/* 4. Core nav: Wallets, Accounts, Transactions, Cards */}
        {coreNavAfterAgentic.map((item) => (
          <NavItem key={item.href} item={item} />
        ))}

        {/* 5. Operations — owner/admin only + full sidebar setting, collapsible */}
        {isAdmin && showFullSidebar && !collapsed && (
          <>
            <SectionHeader
              label="Operations"
              expanded={opsExpanded}
              onToggle={toggleOps}
            />
            {opsExpanded &&
              operationsNav.map((item) => <NavItem key={item.href} item={item} />)}
          </>
        )}

        {/* 6. Developers — owner/admin only, collapsible. Expand state
            persists to localStorage so Logs / API Keys / Webhooks stay
            reachable without re-expanding every visit. */}
        {isAdmin && !collapsed && (
          <>
            <SectionHeader
              label="Developers"
              expanded={devExpanded}
              onToggle={toggleDev}
            />
            {devExpanded &&
              developersNav.map((item) => <NavItem key={item.href} item={item} />)}
          </>
        )}

        {/* 7. Settings — always visible */}
        <div className="pt-4 mt-4 border-t border-gray-200 dark:border-gray-800 space-y-1">
          {settingsNav.map((item) => (
            <NavItem key={item.href} item={item} />
          ))}
        </div>
      </nav>

      {/* Version */}
      {!collapsed && (
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800">
          <div className="text-xs text-gray-500 dark:text-gray-400">Sly v0.1.0</div>
        </div>
      )}
    </aside>
  );
}
