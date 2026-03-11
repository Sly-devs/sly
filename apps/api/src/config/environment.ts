/**
 * Story 40.28: Environment Configuration System
 * 
 * This module provides a comprehensive environment configuration system
 * for PayOS API with:
 * - Environment enum: mock, sandbox, production
 * - Per-service environment overrides
 * - Feature flags for gradual rollout
 * - Validation to prevent production in dev
 * - Environment logging
 */

// ============================================
// Types
// ============================================

/**
 * PayOS environment types
 * - mock: Local development with all services mocked (no external calls)
 * - sandbox: External sandbox APIs (Circle sandbox, Base Sepolia, x402.org)
 * - production: Live production APIs (requires approval)
 */
export type PayOSEnvironment = 'mock' | 'sandbox' | 'production';

/**
 * Individual services that can have environment overrides
 */
export type ServiceName = 
  | 'circle'        // Circle Programmable Wallets
  | 'coinbase'      // Coinbase CDP (Developer Platform)
  | 'blockchain'    // Base/EVM blockchain
  | 'x402'          // x402 facilitator
  | 'stripe'        // Stripe for ACP
  | 'compliance'    // Elliptic/ComplyAdvantage
  | 'fx';           // FX rate providers

/**
 * Service-specific configuration
 */
export interface ServiceConfig {
  environment: PayOSEnvironment;
  apiUrl?: string;
  apiKey?: string;
  enabled: boolean;
}

/**
 * Feature flags for gradual rollout
 */
export interface FeatureFlags {
  // Circle Integration
  circlePayouts: boolean;           // Enable Circle Pix/SPEI payouts
  circleWallets: boolean;           // Enable Circle Programmable Wallets
  circleFxQuotes: boolean;          // Enable Circle FX quotes
  
  // Blockchain Integration
  x402Payments: boolean;            // Enable x402 blockchain payments
  x402Settlement: boolean;          // Enable x402 → Circle settlement bridge
  superfluidStreaming: boolean;     // Enable Superfluid streaming
  
  // Protocol Integration
  acpSharedPaymentToken: boolean;   // Enable ACP SharedPaymentToken
  ap2MandateVerification: boolean;  // Enable AP2 VDC verification
  
  // Gas Station (Epic 38)
  circleGasStation: boolean;        // Enable Circle Gas Station (gasless txns)

  // Compliance
  walletScreening: boolean;         // Enable Elliptic wallet screening
  entityScreening: boolean;         // Enable ComplyAdvantage screening

  // Operations
  batchSettlements: boolean;        // Enable batch settlements (100+)
  multiCurrency: boolean;           // Enable multi-currency (BRL↔MXN)
}

/**
 * Complete environment configuration
 */
export interface EnvironmentConfiguration {
  // Global environment (default for all services)
  environment: PayOSEnvironment;
  
  // Per-service overrides
  services: Partial<Record<ServiceName, Partial<ServiceConfig>>>;
  
  // Feature flags
  features: FeatureFlags;
  
  // Validation settings
  allowProductionInDev: boolean;
  
  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// ============================================
// Environment URLs
// ============================================

export const SERVICE_URLS: Record<ServiceName, Record<PayOSEnvironment, string>> = {
  circle: {
    mock: 'http://localhost:4000/mock/circle',
    sandbox: 'https://api-sandbox.circle.com',
    production: 'https://api.circle.com',
  },
  coinbase: {
    mock: 'http://localhost:4000/mock/coinbase',
    sandbox: 'https://api.developer.coinbase.com',  // CDP API
    production: 'https://api.developer.coinbase.com',
  },
  blockchain: {
    mock: 'http://localhost:8545',  // Local anvil/hardhat
    sandbox: 'https://sepolia.base.org',
    production: 'https://mainnet.base.org',
  },
  x402: {
    mock: 'http://localhost:4000/v1/x402/facilitator',
    sandbox: 'https://x402.org/facilitator',
    production: 'https://facilitator.coinbase.com',
  },
  stripe: {
    mock: 'http://localhost:4000/mock/stripe',
    sandbox: 'https://api.stripe.com',  // Test mode
    production: 'https://api.stripe.com',  // Live mode
  },
  compliance: {
    mock: 'http://localhost:4000/mock/compliance',
    sandbox: 'https://api-sandbox.elliptic.co',
    production: 'https://api.elliptic.co',
  },
  fx: {
    mock: 'http://localhost:4000/mock/fx',
    sandbox: 'https://api-sandbox.circle.com',  // Circle FX sandbox
    production: 'https://api.circle.com',
  },
};

// ============================================
// Default Feature Flags
// ============================================

const DEFAULT_FEATURE_FLAGS: Record<PayOSEnvironment, FeatureFlags> = {
  mock: {
    circlePayouts: true,
    circleWallets: true,
    circleFxQuotes: true,
    circleGasStation: false,
    x402Payments: true,
    x402Settlement: true,
    superfluidStreaming: false,
    acpSharedPaymentToken: true,
    ap2MandateVerification: true,
    walletScreening: false,
    entityScreening: false,
    batchSettlements: true,
    multiCurrency: true,
  },
  sandbox: {
    circlePayouts: true,
    circleWallets: true,
    circleFxQuotes: true,
    circleGasStation: true,   // Gas Station available in sandbox
    x402Payments: true,
    x402Settlement: true,
    superfluidStreaming: false,  // Enable when ready
    acpSharedPaymentToken: true,
    ap2MandateVerification: true,
    walletScreening: true,
    entityScreening: false,  // Enable when ComplyAdvantage ready
    batchSettlements: true,
    multiCurrency: true,
  },
  production: {
    circlePayouts: false,  // Requires approval
    circleWallets: false,  // Requires approval
    circleFxQuotes: false,
    circleGasStation: false,  // Enable after Gas Station funded
    x402Payments: false,
    x402Settlement: false,
    superfluidStreaming: false,
    acpSharedPaymentToken: false,
    ap2MandateVerification: false,
    walletScreening: false,
    entityScreening: false,
    batchSettlements: false,
    multiCurrency: false,
  },
};

// ============================================
// Environment Manager
// ============================================

class EnvironmentManager {
  private config: EnvironmentConfiguration;
  private initialized: boolean = false;

  constructor() {
    this.config = this.loadFromEnv();
  }

  /**
   * Load configuration from environment variables
   */
  private loadFromEnv(): EnvironmentConfiguration {
    const nodeEnv = process.env.NODE_ENV || 'development';
    const payosEnv = (process.env.PAYOS_ENVIRONMENT || 'mock') as PayOSEnvironment;
    
    // Validate environment
    if (!['mock', 'sandbox', 'production'].includes(payosEnv)) {
      throw new Error(`Invalid PAYOS_ENVIRONMENT: ${payosEnv}. Must be mock, sandbox, or production.`);
    }

    // Check production safety
    const allowProductionInDev = process.env.ALLOW_PRODUCTION_IN_DEV === 'true';
    if (payosEnv === 'production' && nodeEnv !== 'production' && !allowProductionInDev) {
      throw new Error(
        'Cannot use production environment outside of NODE_ENV=production. ' +
        'Set ALLOW_PRODUCTION_IN_DEV=true to override (NOT RECOMMENDED).'
      );
    }

    // Load per-service overrides
    const services: Partial<Record<ServiceName, Partial<ServiceConfig>>> = {};
    const serviceNames: ServiceName[] = ['circle', 'coinbase', 'blockchain', 'x402', 'stripe', 'compliance', 'fx'];
    
    for (const service of serviceNames) {
      const envOverride = process.env[`PAYOS_${service.toUpperCase()}_ENV`] as PayOSEnvironment | undefined;
      const apiUrl = process.env[`PAYOS_${service.toUpperCase()}_URL`];
      const apiKey = process.env[`PAYOS_${service.toUpperCase()}_API_KEY`];
      const enabled = process.env[`PAYOS_${service.toUpperCase()}_ENABLED`] !== 'false';
      
      if (envOverride || apiUrl || apiKey || !enabled) {
        services[service] = {
          environment: envOverride || payosEnv,
          apiUrl,
          apiKey,
          enabled,
        };
      }
    }

    // Load feature flag overrides
    const baseFlags = DEFAULT_FEATURE_FLAGS[payosEnv];
    const features: FeatureFlags = {
      circlePayouts: this.parseFeatureFlag('CIRCLE_PAYOUTS', baseFlags.circlePayouts),
      circleWallets: this.parseFeatureFlag('CIRCLE_WALLETS', baseFlags.circleWallets),
      circleFxQuotes: this.parseFeatureFlag('CIRCLE_FX_QUOTES', baseFlags.circleFxQuotes),
      circleGasStation: this.parseFeatureFlag('CIRCLE_GAS_STATION', baseFlags.circleGasStation),
      x402Payments: this.parseFeatureFlag('X402_PAYMENTS', baseFlags.x402Payments),
      x402Settlement: this.parseFeatureFlag('X402_SETTLEMENT', baseFlags.x402Settlement),
      superfluidStreaming: this.parseFeatureFlag('SUPERFLUID_STREAMING', baseFlags.superfluidStreaming),
      acpSharedPaymentToken: this.parseFeatureFlag('ACP_SPT', baseFlags.acpSharedPaymentToken),
      ap2MandateVerification: this.parseFeatureFlag('AP2_VDC', baseFlags.ap2MandateVerification),
      walletScreening: this.parseFeatureFlag('WALLET_SCREENING', baseFlags.walletScreening),
      entityScreening: this.parseFeatureFlag('ENTITY_SCREENING', baseFlags.entityScreening),
      batchSettlements: this.parseFeatureFlag('BATCH_SETTLEMENTS', baseFlags.batchSettlements),
      multiCurrency: this.parseFeatureFlag('MULTI_CURRENCY', baseFlags.multiCurrency),
    };

    // Log level
    const logLevel = (process.env.PAYOS_LOG_LEVEL || (nodeEnv === 'production' ? 'info' : 'debug')) as 'debug' | 'info' | 'warn' | 'error';

    return {
      environment: payosEnv,
      services,
      features,
      allowProductionInDev,
      logLevel,
    };
  }

  /**
   * Parse feature flag from environment
   */
  private parseFeatureFlag(name: string, defaultValue: boolean): boolean {
    const envValue = process.env[`PAYOS_FEATURE_${name}`];
    if (envValue === undefined) return defaultValue;
    return envValue === 'true' || envValue === '1';
  }

  /**
   * Get global environment
   */
  getEnvironment(): PayOSEnvironment {
    return this.config.environment;
  }

  /**
   * Get service-specific configuration
   */
  getServiceConfig(service: ServiceName): ServiceConfig {
    const override = this.config.services[service];
    const env = override?.environment || this.config.environment;
    
    return {
      environment: env,
      apiUrl: override?.apiUrl || SERVICE_URLS[service][env],
      apiKey: override?.apiKey,
      enabled: override?.enabled ?? true,
    };
  }

  /**
   * Get URL for a service
   */
  getServiceUrl(service: ServiceName): string {
    const config = this.getServiceConfig(service);
    return config.apiUrl || SERVICE_URLS[service][config.environment];
  }

  /**
   * Check if a service is enabled
   */
  isServiceEnabled(service: ServiceName): boolean {
    return this.getServiceConfig(service).enabled;
  }

  /**
   * Get feature flags
   */
  getFeatures(): FeatureFlags {
    return { ...this.config.features };
  }

  /**
   * Check if a feature is enabled
   */
  isFeatureEnabled(feature: keyof FeatureFlags): boolean {
    return this.config.features[feature];
  }

  /**
   * Get log level
   */
  getLogLevel(): string {
    return this.config.logLevel;
  }

  /**
   * Check if running in mock mode
   */
  isMock(): boolean {
    return this.config.environment === 'mock';
  }

  /**
   * Check if running in sandbox mode
   */
  isSandbox(): boolean {
    return this.config.environment === 'sandbox';
  }

  /**
   * Check if running in production mode
   */
  isProduction(): boolean {
    return this.config.environment === 'production';
  }

  /**
   * Get full configuration (for logging)
   */
  getFullConfig(): EnvironmentConfiguration {
    return { ...this.config };
  }

  /**
   * Log environment configuration on startup
   */
  logStartupInfo(): void {
    const env = this.config.environment.toUpperCase();
    const services = Object.entries(this.config.services);
    const enabledFeatures = Object.entries(this.config.features)
      .filter(([_, enabled]) => enabled)
      .map(([name]) => name);

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    ENVIRONMENT CONFIGURATION                  ║
╠══════════════════════════════════════════════════════════════╣
║  🌍 Environment: ${env.padEnd(44)}║
║  📊 Log Level: ${this.config.logLevel.padEnd(47)}║
╠══════════════════════════════════════════════════════════════╣
║  External Services:                                          ║`);

    const serviceNames: ServiceName[] = ['circle', 'coinbase', 'blockchain', 'x402', 'stripe', 'compliance', 'fx'];
    for (const service of serviceNames) {
      const config = this.getServiceConfig(service);
      const status = config.enabled ? config.environment.toUpperCase() : 'DISABLED';
      const icon = config.enabled ? '✅' : '❌';
      console.log(`║  ${icon} ${service.padEnd(12)}: ${status.padEnd(45)}║`);
    }

    console.log(`╠══════════════════════════════════════════════════════════════╣
║  Feature Flags (${enabledFeatures.length} enabled):                                    ║`);
    
    // Show first 5 enabled features
    for (const feature of enabledFeatures.slice(0, 5)) {
      console.log(`║    • ${feature.padEnd(56)}║`);
    }
    if (enabledFeatures.length > 5) {
      console.log(`║    ... and ${(enabledFeatures.length - 5).toString()} more`.padEnd(63) + '║');
    }

    console.log(`╚══════════════════════════════════════════════════════════════╝`);
  }

  /**
   * Validate configuration for a specific operation
   */
  validateForOperation(operation: string, requiredFeatures: (keyof FeatureFlags)[]): void {
    for (const feature of requiredFeatures) {
      if (!this.config.features[feature]) {
        throw new Error(
          `Feature '${feature}' is disabled. Cannot perform '${operation}'. ` +
          `Enable it with PAYOS_FEATURE_${feature.toUpperCase().replace(/([A-Z])/g, '_$1')}=true`
        );
      }
    }
  }

  /**
   * Get environment-appropriate error message
   */
  getEnvironmentHint(): string {
    if (this.isMock()) {
      return 'Running in MOCK mode. All external services are simulated.';
    } else if (this.isSandbox()) {
      return 'Running in SANDBOX mode. Using external sandbox/testnet APIs.';
    } else {
      return 'Running in PRODUCTION mode. Using live APIs with real money.';
    }
  }
}

// ============================================
// Singleton Export
// ============================================

export const environmentManager = new EnvironmentManager();

// Convenience exports
export const getEnvironment = () => environmentManager.getEnvironment();
export const getServiceConfig = (service: ServiceName) => environmentManager.getServiceConfig(service);
export const getServiceUrl = (service: ServiceName) => environmentManager.getServiceUrl(service);
export const isServiceEnabled = (service: ServiceName) => environmentManager.isServiceEnabled(service);
export const getFeatures = () => environmentManager.getFeatures();
export const isFeatureEnabled = (feature: keyof FeatureFlags) => environmentManager.isFeatureEnabled(feature);
export const isMock = () => environmentManager.isMock();
export const isSandbox = () => environmentManager.isSandbox();
export const isProduction = () => environmentManager.isProduction();

// Export the manager for advanced use cases
export default environmentManager;

