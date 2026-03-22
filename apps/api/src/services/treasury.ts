/**
 * Treasury Service
 * Story 27.7: Liquidity & Float Management Dashboard
 *
 * Provides real-time visibility into float balances across settlement rails,
 * generates alerts, and provides rebalancing recommendations.
 */

import { createClient, SupabaseClient } from '../db/client.js';
import { getAdapter, getAllAdapters, RailId } from './rail-adapters/index.js';
import { logAudit } from '../utils/helpers.js';

// ============================================
// Types
// ============================================

export interface TreasuryAccount {
  id: string;
  tenantId: string;
  rail: string;
  currency: string;
  externalAccountId?: string;
  accountName?: string;
  balanceTotal: number;
  balanceAvailable: number;
  balancePending: number;
  balanceReserved: number;
  minBalanceThreshold: number;
  targetBalance: number;
  maxBalance?: number;
  status: 'active' | 'inactive' | 'suspended';
  lastSyncAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TreasuryBalanceSnapshot {
  id: string;
  treasuryAccountId: string;
  snapshotAt: string;
  balanceTotal: number;
  balanceAvailable: number;
  balancePending: number;
  balanceReserved: number;
  volumeInbound24h: number;
  volumeOutbound24h: number;
  snapshotType: 'hourly' | 'daily' | 'manual';
  createdAt: string;
}

export interface TreasuryAlert {
  id: string;
  tenantId: string;
  treasuryAccountId?: string;
  alertType: 'low_balance' | 'high_balance' | 'rebalance_needed' | 'sync_failed' | 'velocity_warning';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message?: string;
  rail?: string;
  currency?: string;
  currentValue?: number;
  thresholdValue?: number;
  status: 'open' | 'acknowledged' | 'resolved';
  acknowledgedAt?: string;
  resolvedAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TreasuryTransaction {
  id: string;
  tenantId: string;
  treasuryAccountId: string;
  type: 'inbound' | 'outbound' | 'rebalance_in' | 'rebalance_out' | 'fee' | 'adjustment';
  amount: number;
  currency: string;
  referenceType?: string;
  referenceId?: string;
  status: 'pending' | 'completed' | 'failed';
  externalTxId?: string;
  balanceAfter?: number;
  description?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RebalanceRecommendation {
  id: string;
  tenantId: string;
  status: 'pending' | 'approved' | 'executed' | 'rejected' | 'expired';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  sourceRail: string;
  sourceCurrency: string;
  sourceBalance: number;
  targetRail: string;
  targetCurrency: string;
  targetBalance: number;
  recommendedAmount: number;
  estimatedFees: number;
  estimatedDurationHours: number;
  reason: 'low_target_balance' | 'high_source_balance' | 'volume_rebalance' | 'fx_optimization';
  rationale?: string;
  executedAt?: string;
  expiresAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CurrencyExposure {
  currency: string;
  totalBalance: number;
  availableBalance: number;
  pendingBalance: number;
  reservedBalance: number;
  percentageOfTotal: number;
  rails: Array<{
    rail: string;
    balance: number;
    percentage: number;
  }>;
}

export interface FloatRunway {
  rail: string;
  currency: string;
  currentBalance: number;
  avgDailyVolume: number;
  runwayDays: number;
  status: 'healthy' | 'warning' | 'critical';
  estimatedDepletionDate?: string;
}

export interface SettlementVelocity {
  rail: string;
  avgSettlementTimeMs: number;
  avgSettlementTimeFormatted: string;
  successRate: number;
  totalSettlements24h: number;
  totalVolume24h: number;
}

export interface DashboardSummary {
  // Core balance fields
  totalFloat: number;
  totalAvailable: number;
  totalPending: number;
  totalReserved: number;
  primaryCurrency: string;
  
  // Alert fields
  openAlerts: number;
  criticalAlerts: number;
  pendingRecommendations: number;
  
  // Health metrics
  healthScore: number; // 0-100
  lastUpdated: string;
  
  // 24h flow metrics
  inflows24h: number;
  outflows24h: number;
  netFlow24h: number;
  
  // Legacy aliases for frontend compatibility
  totalBalance: number;
  alertsCount: number;
  accountsCount: number;
}

export interface FloatAllocation {
  partnerId: string;
  partnerName: string;
  allocatedFloat: number;
  utilizedFloat: number;
  utilizationPercentage: number;
  currency: string;
}

// ============================================
// Treasury Service
// ============================================

export class TreasuryService {
  private supabase: SupabaseClient;
  private environment: 'test' | 'live';

  constructor(environment: 'test' | 'live' = 'test') {
    this.supabase = createClient();
    this.environment = environment;
  }

  // ============================================
  // Account Management
  // ============================================

  /**
   * Get or create a treasury account for a rail/currency
   */
  async getOrCreateAccount(
    tenantId: string,
    rail: string,
    currency: string,
    options?: {
      externalAccountId?: string;
      accountName?: string;
      minBalanceThreshold?: number;
      targetBalance?: number;
      maxBalance?: number;
    }
  ): Promise<TreasuryAccount> {
    // Try to get existing account
    const { data: existing } = await this.supabase
      .from('treasury_accounts')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('environment', this.environment)
      .eq('rail', rail)
      .eq('currency', currency)
      .single();

    if (existing) {
      return this.mapAccount(existing);
    }

    // Create new account
    const { data: created, error } = await this.supabase
      .from('treasury_accounts')
      .insert({
        tenant_id: tenantId,
        environment: this.environment,
        rail,
        currency,
        external_account_id: options?.externalAccountId,
        account_name: options?.accountName || `${rail} - ${currency}`,
        min_balance_threshold: options?.minBalanceThreshold || 0,
        target_balance: options?.targetBalance || 0,
        max_balance: options?.maxBalance,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create treasury account: ${error.message}`);
    }

    return this.mapAccount(created);
  }

  /**
   * Get all treasury accounts for a tenant
   */
  async getAccounts(tenantId: string): Promise<TreasuryAccount[]> {
    const { data, error } = await this.supabase
      .from('treasury_accounts')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('environment', this.environment)
      .eq('status', 'active')
      .order('rail', { ascending: true });

    if (error) {
      throw new Error(`Failed to get treasury accounts: ${error.message}`);
    }

    return (data || []).map(this.mapAccount);
  }

  /**
   * Update treasury account settings
   */
  async updateAccount(
    tenantId: string,
    accountId: string,
    updates: Partial<{
      minBalanceThreshold: number;
      targetBalance: number;
      maxBalance: number;
      status: 'active' | 'inactive' | 'suspended';
      metadata: Record<string, unknown>;
    }>
  ): Promise<TreasuryAccount> {
    const updateData: Record<string, unknown> = {};
    if (updates.minBalanceThreshold !== undefined) updateData.min_balance_threshold = updates.minBalanceThreshold;
    if (updates.targetBalance !== undefined) updateData.target_balance = updates.targetBalance;
    if (updates.maxBalance !== undefined) updateData.max_balance = updates.maxBalance;
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.metadata !== undefined) updateData.metadata = updates.metadata;

    const { data, error } = await this.supabase
      .from('treasury_accounts')
      .update(updateData)
      .eq('id', accountId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update treasury account: ${error.message}`);
    }

    return this.mapAccount(data);
  }

  // ============================================
  // Balance Syncing
  // ============================================

  /**
   * Sync balances from external rails
   */
  async syncBalances(tenantId: string): Promise<{ synced: number; errors: string[] }> {
    const accounts = await this.getAccounts(tenantId);
    const errors: string[] = [];
    let synced = 0;

    for (const account of accounts) {
      try {
        const adapter = getAdapter(account.rail as RailId);
        const railBalance = await adapter.getBalance(account.currency);

        await this.supabase
          .from('treasury_accounts')
          .update({
            balance_total: railBalance.total,
            balance_available: railBalance.available,
            balance_pending: railBalance.pending,
            last_sync_at: new Date().toISOString(),
          })
          .eq('id', account.id);

        synced++;
      } catch (err) {
        const errorMsg = `Failed to sync ${account.rail}/${account.currency}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(errorMsg);
        console.error(`[Treasury] ${errorMsg}`);
      }
    }

    return { synced, errors };
  }

  /**
   * Take a snapshot of current balances for historical tracking
   */
  async takeSnapshot(
    tenantId: string,
    snapshotType: 'hourly' | 'daily' | 'manual' = 'manual'
  ): Promise<number> {
    const accounts = await this.getAccounts(tenantId);
    let snapshotCount = 0;

    for (const account of accounts) {
      // Get 24h volume
      const volumeStats = await this.get24hVolume(account.id);

      const { error } = await this.supabase
        .from('treasury_balance_history')
        .insert({
          treasury_account_id: account.id,
          balance_total: account.balanceTotal,
          balance_available: account.balanceAvailable,
          balance_pending: account.balancePending,
          balance_reserved: account.balanceReserved,
          volume_inbound_24h: volumeStats.inbound,
          volume_outbound_24h: volumeStats.outbound,
          snapshot_type: snapshotType,
        });

      if (!error) {
        snapshotCount++;
      }
    }

    return snapshotCount;
  }

  /**
   * Get 24h volume for an account
   */
  private async get24hVolume(accountId: string): Promise<{ inbound: number; outbound: number }> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data } = await this.supabase
      .from('treasury_transactions')
      .select('type, amount')
      .eq('treasury_account_id', accountId)
      .gte('created_at', cutoff);

    let inbound = 0;
    let outbound = 0;

    for (const tx of data || []) {
      if (tx.type === 'inbound' || tx.type === 'rebalance_in') {
        inbound += parseFloat(tx.amount);
      } else if (tx.type === 'outbound' || tx.type === 'rebalance_out' || tx.type === 'fee') {
        outbound += parseFloat(tx.amount);
      }
    }

    return { inbound, outbound };
  }

  // ============================================
  // Dashboard Analytics
  // ============================================

  /**
   * Get dashboard summary
   */
  async getDashboardSummary(tenantId: string): Promise<DashboardSummary> {
    const accounts = await this.getAccounts(tenantId);

    // Calculate totals (convert to USD for aggregation)
    let totalFloat = 0;
    let totalAvailable = 0;
    let totalPending = 0;
    let totalReserved = 0;

    const fxRates: Record<string, number> = {
      USD: 1,
      USDC: 1,
      BRL: 0.18, // Approximate rates
      MXN: 0.05,
    };

    for (const account of accounts) {
      const rate = fxRates[account.currency] || 1;
      totalFloat += account.balanceTotal * rate;
      totalAvailable += account.balanceAvailable * rate;
      totalPending += account.balancePending * rate;
      totalReserved += account.balanceReserved * rate;
    }

    // Calculate 24h flows from transfers
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    // Get inflows (completed transfers TO tenant's accounts)
    const { data: inflowData } = await this.supabase
      .from('transfers')
      .select('amount, currency')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .eq('direction', 'inbound')
      .gte('completed_at', twentyFourHoursAgo);
    
    // Get outflows (completed transfers FROM tenant's accounts)
    const { data: outflowData } = await this.supabase
      .from('transfers')
      .select('amount, currency')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .eq('direction', 'outbound')
      .gte('completed_at', twentyFourHoursAgo);
    
    // Sum up flows (convert to USD)
    let inflows24h = 0;
    let outflows24h = 0;
    
    for (const transfer of (inflowData || [])) {
      const rate = fxRates[transfer.currency] || 1;
      inflows24h += (transfer.amount || 0) * rate;
    }
    
    for (const transfer of (outflowData || [])) {
      const rate = fxRates[transfer.currency] || 1;
      outflows24h += (transfer.amount || 0) * rate;
    }

    // Count alerts
    const { count: openAlerts } = await this.supabase
      .from('treasury_alerts')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'open');

    const { count: criticalAlerts } = await this.supabase
      .from('treasury_alerts')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'open')
      .eq('severity', 'critical');

    // Count pending recommendations
    const { count: pendingRecommendations } = await this.supabase
      .from('treasury_rebalance_recommendations')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'pending');

    // Calculate health score (0-100)
    const healthScore = this.calculateHealthScore(accounts, openAlerts || 0, criticalAlerts || 0);

    return {
      totalFloat: Math.round(totalFloat * 100) / 100,
      totalAvailable: Math.round(totalAvailable * 100) / 100,
      totalPending: Math.round(totalPending * 100) / 100,
      totalReserved: Math.round(totalReserved * 100) / 100,
      primaryCurrency: 'USD',
      openAlerts: openAlerts || 0,
      criticalAlerts: criticalAlerts || 0,
      pendingRecommendations: pendingRecommendations || 0,
      healthScore,
      lastUpdated: new Date().toISOString(),
      // 24h flow metrics
      inflows24h: Math.round(inflows24h * 100) / 100,
      outflows24h: Math.round(outflows24h * 100) / 100,
      netFlow24h: Math.round((inflows24h - outflows24h) * 100) / 100,
      // Legacy aliases
      totalBalance: Math.round(totalFloat * 100) / 100,
      alertsCount: openAlerts || 0,
      accountsCount: accounts.length,
    };
  }

  /**
   * Calculate health score based on various factors
   */
  private calculateHealthScore(
    accounts: TreasuryAccount[],
    openAlerts: number,
    criticalAlerts: number
  ): number {
    let score = 100;

    // Deduct for critical alerts (-20 each)
    score -= criticalAlerts * 20;

    // Deduct for open alerts (-5 each, max -20)
    score -= Math.min(openAlerts * 5, 20);

    // Deduct for accounts below threshold
    for (const account of accounts) {
      if (account.minBalanceThreshold > 0 && account.balanceAvailable < account.minBalanceThreshold) {
        score -= 15;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Get currency exposure breakdown
   */
  async getCurrencyExposure(tenantId: string): Promise<CurrencyExposure[]> {
    const accounts = await this.getAccounts(tenantId);

    // Group by currency
    const currencyMap = new Map<string, {
      total: number;
      available: number;
      pending: number;
      reserved: number;
      rails: Map<string, number>;
    }>();

    let grandTotal = 0;

    for (const account of accounts) {
      if (!currencyMap.has(account.currency)) {
        currencyMap.set(account.currency, {
          total: 0,
          available: 0,
          pending: 0,
          reserved: 0,
          rails: new Map(),
        });
      }

      const curr = currencyMap.get(account.currency)!;
      curr.total += account.balanceTotal;
      curr.available += account.balanceAvailable;
      curr.pending += account.balancePending;
      curr.reserved += account.balanceReserved;
      curr.rails.set(account.rail, (curr.rails.get(account.rail) || 0) + account.balanceTotal);

      grandTotal += account.balanceTotal;
    }

    // Convert to array
    const exposures: CurrencyExposure[] = [];
    for (const [currency, data] of currencyMap) {
      exposures.push({
        currency,
        totalBalance: data.total,
        availableBalance: data.available,
        pendingBalance: data.pending,
        reservedBalance: data.reserved,
        percentageOfTotal: grandTotal > 0 ? (data.total / grandTotal) * 100 : 0,
        rails: Array.from(data.rails.entries()).map(([rail, balance]) => ({
          rail,
          balance,
          percentage: data.total > 0 ? (balance / data.total) * 100 : 0,
        })),
      });
    }

    return exposures.sort((a, b) => b.totalBalance - a.totalBalance);
  }

  /**
   * Get float runway analysis
   */
  async getFloatRunway(tenantId: string): Promise<FloatRunway[]> {
    const accounts = await this.getAccounts(tenantId);
    const runways: FloatRunway[] = [];

    for (const account of accounts) {
      // Get 7-day average daily outbound volume
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: txData } = await this.supabase
        .from('treasury_transactions')
        .select('amount')
        .eq('treasury_account_id', account.id)
        .in('type', ['outbound', 'rebalance_out'])
        .gte('created_at', cutoff);

      const totalOutbound = (txData || []).reduce((sum, tx) => sum + parseFloat(tx.amount), 0);
      const avgDailyVolume = totalOutbound / 7;

      // Calculate runway
      let runwayDays = Infinity;
      let estimatedDepletionDate: string | undefined;

      if (avgDailyVolume > 0) {
        runwayDays = account.balanceAvailable / avgDailyVolume;
        if (runwayDays < Infinity) {
          estimatedDepletionDate = new Date(Date.now() + runwayDays * 24 * 60 * 60 * 1000).toISOString();
        }
      }

      // Determine status
      let status: 'healthy' | 'warning' | 'critical' = 'healthy';
      if (runwayDays < 2) {
        status = 'critical';
      } else if (runwayDays < 7) {
        status = 'warning';
      }

      runways.push({
        rail: account.rail,
        currency: account.currency,
        currentBalance: account.balanceAvailable,
        avgDailyVolume: Math.round(avgDailyVolume * 100) / 100,
        runwayDays: Math.min(Math.round(runwayDays * 10) / 10, 999),
        status,
        estimatedDepletionDate,
      });
    }

    return runways.sort((a, b) => a.runwayDays - b.runwayDays);
  }

  /**
   * Get settlement velocity metrics
   */
  async getSettlementVelocity(tenantId: string): Promise<SettlementVelocity[]> {
    // Query settlement records for velocity metrics
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: settlements } = await this.supabase
      .from('settlement_records')
      .select('rail, status, amount, processing_time_ms')
      .eq('tenant_id', tenantId)
      .gte('created_at', cutoff);

    // Group by rail
    const railMap = new Map<string, {
      totalTimeMs: number;
      count: number;
      successCount: number;
      totalVolume: number;
    }>();

    for (const s of settlements || []) {
      if (!railMap.has(s.rail)) {
        railMap.set(s.rail, { totalTimeMs: 0, count: 0, successCount: 0, totalVolume: 0 });
      }

      const rail = railMap.get(s.rail)!;
      rail.count++;
      rail.totalVolume += parseFloat(s.amount) || 0;

      if (s.status === 'completed') {
        rail.successCount++;
        rail.totalTimeMs += s.processing_time_ms || 0;
      }
    }

    // Convert to array
    const velocities: SettlementVelocity[] = [];
    for (const [rail, data] of railMap) {
      const avgTimeMs = data.successCount > 0 ? data.totalTimeMs / data.successCount : 0;

      velocities.push({
        rail,
        avgSettlementTimeMs: Math.round(avgTimeMs),
        avgSettlementTimeFormatted: this.formatDuration(avgTimeMs),
        successRate: data.count > 0 ? (data.successCount / data.count) * 100 : 100,
        totalSettlements24h: data.count,
        totalVolume24h: Math.round(data.totalVolume * 100) / 100,
      });
    }

    return velocities.sort((a, b) => b.totalVolume24h - a.totalVolume24h);
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
  }

  /**
   * Get historical balance chart data
   */
  async getBalanceHistory(
    tenantId: string,
    options: {
      rail?: string;
      currency?: string;
      days?: number;
    } = {}
  ): Promise<TreasuryBalanceSnapshot[]> {
    const days = options.days || 30;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Get account IDs for the tenant
    let accountsQuery = this.supabase
      .from('treasury_accounts')
      .select('id')
      .eq('tenant_id', tenantId);

    if (options.rail) {
      accountsQuery = accountsQuery.eq('rail', options.rail);
    }
    if (options.currency) {
      accountsQuery = accountsQuery.eq('currency', options.currency);
    }

    const { data: accounts } = await accountsQuery;
    const accountIds = (accounts || []).map((a) => a.id);

    if (accountIds.length === 0) return [];

    const { data, error } = await this.supabase
      .from('treasury_balance_history')
      .select('*')
      .in('treasury_account_id', accountIds)
      .gte('snapshot_at', cutoff)
      .order('snapshot_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to get balance history: ${error.message}`);
    }

    return (data || []).map(this.mapSnapshot);
  }

  // ============================================
  // Alerts
  // ============================================

  /**
   * Check for float sufficiency and generate alerts
   */
  async checkAndGenerateAlerts(tenantId: string): Promise<TreasuryAlert[]> {
    const accounts = await this.getAccounts(tenantId);
    const runways = await this.getFloatRunway(tenantId);
    const newAlerts: TreasuryAlert[] = [];

    for (const account of accounts) {
      // Check low balance
      if (account.minBalanceThreshold > 0 && account.balanceAvailable < account.minBalanceThreshold) {
        const alert = await this.createAlert(tenantId, {
          treasuryAccountId: account.id,
          alertType: 'low_balance',
          severity: account.balanceAvailable < account.minBalanceThreshold * 0.5 ? 'critical' : 'warning',
          title: `Low ${account.currency} balance on ${account.rail}`,
          message: `Balance (${account.balanceAvailable.toFixed(2)} ${account.currency}) is below threshold (${account.minBalanceThreshold.toFixed(2)} ${account.currency})`,
          rail: account.rail,
          currency: account.currency,
          currentValue: account.balanceAvailable,
          thresholdValue: account.minBalanceThreshold,
        });
        if (alert) newAlerts.push(alert);
      }

      // Check high balance
      if (account.maxBalance && account.balanceAvailable > account.maxBalance) {
        const alert = await this.createAlert(tenantId, {
          treasuryAccountId: account.id,
          alertType: 'high_balance',
          severity: 'info',
          title: `High ${account.currency} balance on ${account.rail}`,
          message: `Balance (${account.balanceAvailable.toFixed(2)} ${account.currency}) exceeds max (${account.maxBalance.toFixed(2)} ${account.currency}). Consider rebalancing.`,
          rail: account.rail,
          currency: account.currency,
          currentValue: account.balanceAvailable,
          thresholdValue: account.maxBalance,
        });
        if (alert) newAlerts.push(alert);
      }
    }

    // Check runway
    for (const runway of runways) {
      if (runway.status === 'critical' || runway.status === 'warning') {
        const alert = await this.createAlert(tenantId, {
          alertType: 'velocity_warning',
          severity: runway.status === 'critical' ? 'critical' : 'warning',
          title: `Low float runway on ${runway.rail}`,
          message: `Only ${runway.runwayDays.toFixed(1)} days of runway remaining at current volume (${runway.avgDailyVolume.toFixed(2)} ${runway.currency}/day)`,
          rail: runway.rail,
          currency: runway.currency,
          currentValue: runway.runwayDays,
          thresholdValue: runway.status === 'critical' ? 2 : 7,
        });
        if (alert) newAlerts.push(alert);
      }
    }

    return newAlerts;
  }

  /**
   * Create an alert (avoiding duplicates)
   */
  private async createAlert(
    tenantId: string,
    alertData: Omit<TreasuryAlert, 'id' | 'tenantId' | 'status' | 'createdAt' | 'updatedAt' | 'metadata'> & {
      treasuryAccountId?: string;
    }
  ): Promise<TreasuryAlert | null> {
    // Check for existing open alert of same type for same account
    const { data: existing } = await this.supabase
      .from('treasury_alerts')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('alert_type', alertData.alertType)
      .eq('rail', alertData.rail || '')
      .eq('status', 'open')
      .maybeSingle();

    if (existing) {
      // Update existing alert instead
      const { data: updated, error } = await this.supabase
        .from('treasury_alerts')
        .update({
          current_value: alertData.currentValue,
          severity: alertData.severity,
          message: alertData.message,
        })
        .eq('id', existing.id)
        .select()
        .single();

      return updated ? this.mapAlert(updated) : null;
    }

    // Create new alert
    const { data: created, error } = await this.supabase
      .from('treasury_alerts')
      .insert({
        tenant_id: tenantId,
        treasury_account_id: alertData.treasuryAccountId,
        alert_type: alertData.alertType,
        severity: alertData.severity,
        title: alertData.title,
        message: alertData.message,
        rail: alertData.rail,
        currency: alertData.currency,
        current_value: alertData.currentValue,
        threshold_value: alertData.thresholdValue,
      })
      .select()
      .single();

    if (error) {
      console.error(`[Treasury] Failed to create alert: ${error.message}`);
      return null;
    }

    return this.mapAlert(created);
  }

  /**
   * Get alerts for a tenant
   */
  async getAlerts(
    tenantId: string,
    options: {
      status?: 'open' | 'acknowledged' | 'resolved';
      severity?: 'info' | 'warning' | 'critical';
      limit?: number;
    } = {}
  ): Promise<TreasuryAlert[]> {
    let query = this.supabase
      .from('treasury_alerts')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(options.limit || 100);

    if (options.status) {
      query = query.eq('status', options.status);
    }
    if (options.severity) {
      query = query.eq('severity', options.severity);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get alerts: ${error.message}`);
    }

    return (data || []).map(this.mapAlert);
  }

  /**
   * Acknowledge an alert
   */
  async acknowledgeAlert(tenantId: string, alertId: string, userId: string): Promise<TreasuryAlert> {
    const { data, error } = await this.supabase
      .from('treasury_alerts')
      .update({
        status: 'acknowledged',
        acknowledged_at: new Date().toISOString(),
        acknowledged_by: userId,
      })
      .eq('id', alertId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to acknowledge alert: ${error.message}`);
    }

    return this.mapAlert(data);
  }

  /**
   * Resolve an alert
   */
  async resolveAlert(tenantId: string, alertId: string, userId: string): Promise<TreasuryAlert> {
    const { data, error } = await this.supabase
      .from('treasury_alerts')
      .update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolved_by: userId,
      })
      .eq('id', alertId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to resolve alert: ${error.message}`);
    }

    return this.mapAlert(data);
  }

  // ============================================
  // Rebalancing
  // ============================================

  /**
   * Generate rebalancing recommendations
   */
  async generateRebalanceRecommendations(tenantId: string): Promise<RebalanceRecommendation[]> {
    const accounts = await this.getAccounts(tenantId);
    const recommendations: RebalanceRecommendation[] = [];

    // Group accounts by currency
    const byCurrency = new Map<string, TreasuryAccount[]>();
    for (const account of accounts) {
      if (!byCurrency.has(account.currency)) {
        byCurrency.set(account.currency, []);
      }
      byCurrency.get(account.currency)!.push(account);
    }

    // Check each currency group for rebalancing opportunities
    for (const [currency, currAccounts] of byCurrency) {
      // Find accounts below target
      const belowTarget = currAccounts.filter(
        (a) => a.targetBalance > 0 && a.balanceAvailable < a.targetBalance * 0.8
      );

      // Find accounts above max or significantly above target
      const aboveMax = currAccounts.filter(
        (a) =>
          (a.maxBalance && a.balanceAvailable > a.maxBalance) ||
          (a.targetBalance > 0 && a.balanceAvailable > a.targetBalance * 1.5)
      );

      // Generate recommendations
      for (const target of belowTarget) {
        for (const source of aboveMax) {
          const deficit = target.targetBalance - target.balanceAvailable;
          const surplus = source.maxBalance
            ? source.balanceAvailable - source.maxBalance
            : source.balanceAvailable - source.targetBalance;

          const recommendedAmount = Math.min(deficit, surplus);

          if (recommendedAmount > 0) {
            const recommendation = await this.createRecommendation(tenantId, {
              sourceRail: source.rail,
              sourceCurrency: source.currency,
              sourceBalance: source.balanceAvailable,
              targetRail: target.rail,
              targetCurrency: target.currency,
              targetBalance: target.balanceAvailable,
              recommendedAmount,
              reason: target.balanceAvailable < target.targetBalance * 0.5 ? 'low_target_balance' : 'volume_rebalance',
              rationale: `Transfer ${recommendedAmount.toFixed(2)} ${currency} from ${source.rail} to ${target.rail} to optimize float distribution`,
              priority: target.balanceAvailable < target.minBalanceThreshold ? 'urgent' : 'normal',
            });

            if (recommendation) {
              recommendations.push(recommendation);
            }
          }
        }
      }
    }

    return recommendations;
  }

  /**
   * Create a rebalance recommendation
   */
  private async createRecommendation(
    tenantId: string,
    data: Omit<RebalanceRecommendation, 'id' | 'tenantId' | 'status' | 'estimatedFees' | 'estimatedDurationHours' | 'executedAt' | 'expiresAt' | 'metadata' | 'createdAt' | 'updatedAt'>
  ): Promise<RebalanceRecommendation | null> {
    // Estimate fees and duration based on rails
    const estimatedFees = this.estimateRebalanceFees(data.sourceRail, data.targetRail, data.recommendedAmount);
    const estimatedDurationHours = this.estimateRebalanceDuration(data.sourceRail, data.targetRail);

    const { data: created, error } = await this.supabase
      .from('treasury_rebalance_recommendations')
      .insert({
        tenant_id: tenantId,
        source_rail: data.sourceRail,
        source_currency: data.sourceCurrency,
        source_balance: data.sourceBalance,
        target_rail: data.targetRail,
        target_currency: data.targetCurrency,
        target_balance: data.targetBalance,
        recommended_amount: data.recommendedAmount,
        estimated_fees: estimatedFees,
        estimated_duration_hours: estimatedDurationHours,
        reason: data.reason,
        rationale: data.rationale,
        priority: data.priority || 'normal',
      })
      .select()
      .single();

    if (error) {
      console.error(`[Treasury] Failed to create recommendation: ${error.message}`);
      return null;
    }

    return this.mapRecommendation(created);
  }

  private estimateRebalanceFees(sourceRail: string, targetRail: string, amount: number): number {
    // Simplified fee estimation
    const feeRates: Record<string, number> = {
      circle_usdc: 0.001, // 0.1%
      base_chain: 0.0005, // 0.05%
      pix: 0.002, // 0.2%
      spei: 0.003, // 0.3%
      wire: 0.005, // 0.5%
    };

    const sourceRate = feeRates[sourceRail] || 0.005;
    const targetRate = feeRates[targetRail] || 0.005;

    return amount * (sourceRate + targetRate);
  }

  private estimateRebalanceDuration(sourceRail: string, targetRail: string): number {
    // Duration in hours
    const durations: Record<string, number> = {
      circle_usdc: 0.5,
      base_chain: 0.1,
      pix: 1,
      spei: 2,
      wire: 24,
    };

    return Math.max(durations[sourceRail] || 24, durations[targetRail] || 24);
  }

  /**
   * Get rebalance recommendations
   */
  async getRecommendations(
    tenantId: string,
    options: {
      status?: 'pending' | 'approved' | 'executed' | 'rejected' | 'expired';
      limit?: number;
    } = {}
  ): Promise<RebalanceRecommendation[]> {
    let query = this.supabase
      .from('treasury_rebalance_recommendations')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(options.limit || 50);

    if (options.status) {
      query = query.eq('status', options.status);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get recommendations: ${error.message}`);
    }

    return (data || []).map(this.mapRecommendation);
  }

  /**
   * Approve a recommendation
   */
  async approveRecommendation(tenantId: string, recommendationId: string): Promise<RebalanceRecommendation> {
    const { data, error } = await this.supabase
      .from('treasury_rebalance_recommendations')
      .update({ status: 'approved' })
      .eq('id', recommendationId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to approve recommendation: ${error.message}`);
    }

    return this.mapRecommendation(data);
  }

  /**
   * Reject a recommendation
   */
  async rejectRecommendation(tenantId: string, recommendationId: string): Promise<RebalanceRecommendation> {
    const { data, error } = await this.supabase
      .from('treasury_rebalance_recommendations')
      .update({ status: 'rejected' })
      .eq('id', recommendationId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to reject recommendation: ${error.message}`);
    }

    return this.mapRecommendation(data);
  }

  // ============================================
  // Partner Float Allocation (White-Label)
  // ============================================

  /**
   * Get float allocation by partner
   */
  async getFloatAllocationByPartner(tenantId: string): Promise<FloatAllocation[]> {
    // This would typically query a partner-specific float allocation table
    // For now, we'll aggregate from accounts table
    const { data: accounts } = await this.supabase
      .from('accounts')
      .select(`
        id,
        balance_total,
        currency,
        tenant:tenants!inner(id, business_name)
      `)
      .eq('type', 'treasury');

    // Group by tenant (partner)
    const partnerMap = new Map<string, {
      name: string;
      allocated: number;
      utilized: number;
      currency: string;
    }>();

    for (const account of accounts || []) {
      const partnerId = (account.tenant as { id: string })?.id || 'unknown';
      const partnerName = (account.tenant as { business_name: string })?.business_name || 'Unknown';

      if (!partnerMap.has(partnerId)) {
        partnerMap.set(partnerId, {
          name: partnerName,
          allocated: 0,
          utilized: 0,
          currency: account.currency || 'USD',
        });
      }

      const partner = partnerMap.get(partnerId)!;
      partner.allocated += parseFloat(account.balance_total) || 0;
    }

    return Array.from(partnerMap.entries()).map(([partnerId, data]) => ({
      partnerId,
      partnerName: data.name,
      allocatedFloat: data.allocated,
      utilizedFloat: data.utilized,
      utilizationPercentage: data.allocated > 0 ? (data.utilized / data.allocated) * 100 : 0,
      currency: data.currency,
    }));
  }

  // ============================================
  // Transactions
  // ============================================

  /**
   * Record a treasury transaction
   */
  async recordTransaction(
    tenantId: string,
    accountId: string,
    data: {
      type: 'inbound' | 'outbound' | 'rebalance_in' | 'rebalance_out' | 'fee' | 'adjustment';
      amount: number;
      currency: string;
      referenceType?: string;
      referenceId?: string;
      externalTxId?: string;
      description?: string;
    }
  ): Promise<TreasuryTransaction> {
    // Get current balance
    const { data: account } = await this.supabase
      .from('treasury_accounts')
      .select('balance_total')
      .eq('id', accountId)
      .single();

    const balanceAfter = (parseFloat(account?.balance_total) || 0) +
      (['inbound', 'rebalance_in', 'adjustment'].includes(data.type) ? data.amount : -data.amount);

    // Insert transaction
    const { data: tx, error } = await this.supabase
      .from('treasury_transactions')
      .insert({
        tenant_id: tenantId,
        treasury_account_id: accountId,
        type: data.type,
        amount: data.amount,
        currency: data.currency,
        reference_type: data.referenceType,
        reference_id: data.referenceId,
        external_tx_id: data.externalTxId,
        balance_after: balanceAfter,
        description: data.description,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to record transaction: ${error.message}`);
    }

    // Update account balance
    const balanceUpdate: Record<string, unknown> = {};
    if (['inbound', 'rebalance_in', 'adjustment'].includes(data.type)) {
      balanceUpdate.balance_total = balanceAfter;
      balanceUpdate.balance_available = balanceAfter;
    } else {
      balanceUpdate.balance_total = balanceAfter;
      balanceUpdate.balance_available = balanceAfter;
    }

    await this.supabase
      .from('treasury_accounts')
      .update(balanceUpdate)
      .eq('id', accountId);

    return this.mapTransaction(tx);
  }

  /**
   * Get transactions for an account
   */
  async getTransactions(
    tenantId: string,
    options: {
      accountId?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<TreasuryTransaction[]> {
    let query = this.supabase
      .from('treasury_transactions')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(options.limit || 50);

    if (options.accountId) {
      query = query.eq('treasury_account_id', options.accountId);
    }
    if (options.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get transactions: ${error.message}`);
    }

    return (data || []).map(this.mapTransaction);
  }

  // ============================================
  // Mappers
  // ============================================

  private mapAccount(data: Record<string, unknown>): TreasuryAccount {
    return {
      id: data.id as string,
      tenantId: data.tenant_id as string,
      rail: data.rail as string,
      currency: data.currency as string,
      externalAccountId: data.external_account_id as string | undefined,
      accountName: data.account_name as string | undefined,
      balanceTotal: parseFloat(data.balance_total as string) || 0,
      balanceAvailable: parseFloat(data.balance_available as string) || 0,
      balancePending: parseFloat(data.balance_pending as string) || 0,
      balanceReserved: parseFloat(data.balance_reserved as string) || 0,
      minBalanceThreshold: parseFloat(data.min_balance_threshold as string) || 0,
      targetBalance: parseFloat(data.target_balance as string) || 0,
      maxBalance: data.max_balance ? parseFloat(data.max_balance as string) : undefined,
      status: data.status as 'active' | 'inactive' | 'suspended',
      lastSyncAt: data.last_sync_at as string | undefined,
      metadata: (data.metadata as Record<string, unknown>) || {},
      createdAt: data.created_at as string,
      updatedAt: data.updated_at as string,
    };
  }

  private mapSnapshot(data: Record<string, unknown>): TreasuryBalanceSnapshot {
    return {
      id: data.id as string,
      treasuryAccountId: data.treasury_account_id as string,
      snapshotAt: data.snapshot_at as string,
      balanceTotal: parseFloat(data.balance_total as string) || 0,
      balanceAvailable: parseFloat(data.balance_available as string) || 0,
      balancePending: parseFloat(data.balance_pending as string) || 0,
      balanceReserved: parseFloat(data.balance_reserved as string) || 0,
      volumeInbound24h: parseFloat(data.volume_inbound_24h as string) || 0,
      volumeOutbound24h: parseFloat(data.volume_outbound_24h as string) || 0,
      snapshotType: data.snapshot_type as 'hourly' | 'daily' | 'manual',
      createdAt: data.created_at as string,
    };
  }

  private mapAlert(data: Record<string, unknown>): TreasuryAlert {
    return {
      id: data.id as string,
      tenantId: data.tenant_id as string,
      treasuryAccountId: data.treasury_account_id as string | undefined,
      alertType: data.alert_type as TreasuryAlert['alertType'],
      severity: data.severity as 'info' | 'warning' | 'critical',
      title: data.title as string,
      message: data.message as string | undefined,
      rail: data.rail as string | undefined,
      currency: data.currency as string | undefined,
      currentValue: data.current_value ? parseFloat(data.current_value as string) : undefined,
      thresholdValue: data.threshold_value ? parseFloat(data.threshold_value as string) : undefined,
      status: data.status as 'open' | 'acknowledged' | 'resolved',
      acknowledgedAt: data.acknowledged_at as string | undefined,
      resolvedAt: data.resolved_at as string | undefined,
      metadata: (data.metadata as Record<string, unknown>) || {},
      createdAt: data.created_at as string,
      updatedAt: data.updated_at as string,
    };
  }

  private mapTransaction(data: Record<string, unknown>): TreasuryTransaction {
    return {
      id: data.id as string,
      tenantId: data.tenant_id as string,
      treasuryAccountId: data.treasury_account_id as string,
      type: data.type as TreasuryTransaction['type'],
      amount: parseFloat(data.amount as string) || 0,
      currency: data.currency as string,
      referenceType: data.reference_type as string | undefined,
      referenceId: data.reference_id as string | undefined,
      status: data.status as 'pending' | 'completed' | 'failed',
      externalTxId: data.external_tx_id as string | undefined,
      balanceAfter: data.balance_after ? parseFloat(data.balance_after as string) : undefined,
      description: data.description as string | undefined,
      metadata: (data.metadata as Record<string, unknown>) || {},
      createdAt: data.created_at as string,
    };
  }

  private mapRecommendation(data: Record<string, unknown>): RebalanceRecommendation {
    return {
      id: data.id as string,
      tenantId: data.tenant_id as string,
      status: data.status as RebalanceRecommendation['status'],
      priority: data.priority as 'low' | 'normal' | 'high' | 'urgent',
      sourceRail: data.source_rail as string,
      sourceCurrency: data.source_currency as string,
      sourceBalance: parseFloat(data.source_balance as string) || 0,
      targetRail: data.target_rail as string,
      targetCurrency: data.target_currency as string,
      targetBalance: parseFloat(data.target_balance as string) || 0,
      recommendedAmount: parseFloat(data.recommended_amount as string) || 0,
      estimatedFees: parseFloat(data.estimated_fees as string) || 0,
      estimatedDurationHours: data.estimated_duration_hours as number,
      reason: data.reason as RebalanceRecommendation['reason'],
      rationale: data.rationale as string | undefined,
      executedAt: data.executed_at as string | undefined,
      expiresAt: data.expires_at as string,
      metadata: (data.metadata as Record<string, unknown>) || {},
      createdAt: data.created_at as string,
      updatedAt: data.updated_at as string,
    };
  }
}

export const treasuryService = new TreasuryService();

