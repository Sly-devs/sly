'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { Button } from '@sly/ui';
import { Input } from '@sly/ui';
import { Label } from '@sly/ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@sly/ui';
import {
  Loader2, Zap, Copy, Check, AlertCircle, Download, Wallet,
  Bot, ArrowRight, Globe, Terminal, FileCode, Code, Network,
  Plus, Link2, ChevronRight, Shield,
} from 'lucide-react';

const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface ApiKeys {
  test: { key: string; prefix: string };
  live: { key: string; prefix: string };
}

interface WalletData {
  id: string;
  walletAddress: string;
  network: string;
  walletType: string;
  balance: number;
  currency: string;
}

interface AgentData {
  id: string;
  name: string;
  token?: string;
}

type IntegrationMethod = 'a2a' | 'mcp' | 'skills' | 'sdk' | 'api';

// ============================================================================
// Helpers
// ============================================================================

function downloadKeysAsEnv(testKey: string, liveKey: string, orgName: string) {
  const content = [
    `# ${orgName} — Sly API Keys`,
    `# Generated: ${new Date().toISOString()}`,
    `# Docs: https://docs.getsly.ai`,
    '',
    '# Sandbox (test mode)',
    `SLY_API_KEY=${testKey}`,
    '',
    '# Production (live mode)',
    `SLY_API_KEY_LIVE=${liveKey}`,
    '',
    '# API endpoint',
    'SLY_API_URL=https://api.getsly.ai',
    '',
  ].join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sly-api-keys.env';
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================================
// Main page wrapper
// ============================================================================

export default function SetupPage() {
  return (
    <Suspense>
      <SetupWizard />
    </Suspense>
  );
}

// ============================================================================
// 3-Step Setup Wizard
// ============================================================================

function SetupWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlInviteCode = searchParams.get('invite_code') || '';

  const [loading, setLoading] = useState(true);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1 state
  const [apiKeys, setApiKeys] = useState<ApiKeys | null>(null);
  const [orgName, setOrgName] = useState('');
  const [inviteCode, setInviteCode] = useState(urlInviteCode);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showOrgForm, setShowOrgForm] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);

  // Step 2 state
  const [walletData, setWalletData] = useState<WalletData | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [externalAddress, setExternalAddress] = useState('');

  // Step 3 state
  const [agentData, setAgentData] = useState<AgentData | null>(null);
  const [agentName, setAgentName] = useState('');
  const [agentDesc, setAgentDesc] = useState('');
  const [agentLoading, setAgentLoading] = useState(false);
  const [integrationMethod, setIntegrationMethod] = useState<IntegrationMethod | null>(null);

  // Account ID for wallet/agent creation
  const [accountId, setAccountId] = useState<string | null>(null);

  // ---- Provision tenant ----
  const provision = useCallback(async (orgNameVal: string, inviteCodeVal?: string) => {
    setProvisioning(true);
    setError(null);

    const supabase = createSupabaseBrowserClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session?.access_token) {
      router.push('/auth/login');
      return;
    }

    setAuthToken(session.access_token);

    try {
      const response = await fetch(`${apiUrl}/v1/auth/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({
          organizationName: orgNameVal,
          ...(inviteCodeVal ? { inviteCode: inviteCodeVal } : {}),
        }),
      });

      const json = await response.json();
      const data = json.data || json;

      if (!response.ok) {
        setError(data.error || json.error || 'Failed to set up organization');
        setProvisioning(false);
        return;
      }

      if (data.alreadyProvisioned) {
        router.push('/dashboard');
        return;
      }

      setOrgName(orgNameVal);
      if (data.apiKeys) {
        setApiKeys(data.apiKeys);
      }

      // Get or create the default account for wallet/agent creation
      try {
        const acctRes = await fetch(`${apiUrl}/v1/accounts?limit=1`, {
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        });
        const acctJson = await acctRes.json();
        const accts = acctJson.data || [];
        if (accts.length > 0) {
          setAccountId(accts[0].id);
        } else {
          // Create a default account with the org name
          const createRes = await fetch(`${apiUrl}/v1/accounts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
            body: JSON.stringify({ type: 'business', name: orgNameVal }),
          });
          const createJson = await createRes.json();
          const newAcct = createJson.data?.data || createJson.data || createJson;
          if (newAcct?.id) setAccountId(newAcct.id);
        }
      } catch { /* non-fatal */ }

    } catch {
      setError('Could not connect to the server. Please try again.');
    }
    setProvisioning(false);
  }, [router]);

  // ---- Check session on mount ----
  useEffect(() => {
    async function checkSession() {
      const supabase = createSupabaseBrowserClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        if (urlInviteCode) localStorage.setItem('sly_beta_invite_code', urlInviteCode);
        router.push('/auth/login');
        return;
      }

      setAuthToken(session.access_token);
      const orgNameMeta = session.user.user_metadata?.organization_name;
      const betaInviteCode = new URLSearchParams(window.location.search).get('invite_code')
        || localStorage.getItem('sly_beta_invite_code') || '';
      const betaOrgName = localStorage.getItem('sly_beta_org_name') || '';

      if (orgNameMeta) {
        const metaInviteCode = session.user.user_metadata?.invite_code || betaInviteCode;
        await provision(orgNameMeta, metaInviteCode);
      } else if (betaInviteCode && betaOrgName) {
        localStorage.removeItem('sly_beta_invite_code');
        localStorage.removeItem('sly_beta_org_name');
        await provision(betaOrgName, betaInviteCode);
      } else if (betaInviteCode) {
        setInviteCode(betaInviteCode);
        localStorage.removeItem('sly_beta_invite_code');
        setShowOrgForm(true);
      } else {
        setShowOrgForm(true);
      }
      setLoading(false);
    }
    checkSession();
  }, [router, provision, urlInviteCode]);

  // ---- Copy helper ----
  async function handleCopy(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopiedKey(label);
    setTimeout(() => setCopiedKey(null), 2000);
  }

  // ---- API helper ----
  async function apiCall(method: string, path: string, body?: any) {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) {
      const errMsg = json.error || json.data?.error || `Request failed (${res.status})`;
      throw new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
    }
    return json;
  }

  // ---- Create wallet ----
  async function createWallet(network: 'base' | 'tempo') {
    if (!accountId) { setError('No account found'); return; }
    setWalletLoading(true);
    setError(null);
    try {
      const blockchain = network === 'tempo' ? 'base' : 'base'; // both use base chain
      const json = await apiCall('POST', '/v1/wallets', {
        accountId,
        name: `${orgName} Wallet`,
        currency: 'USDC',
        walletType: 'circle_custodial',
        blockchain,
        purpose: 'Primary wallet for agent transactions',
      });
      const w = json.data || json;
      setWalletData({
        id: w.id,
        walletAddress: w.walletAddress || w.wallet_address,
        network: w.network,
        walletType: w.walletType || w.wallet_type,
        balance: w.balance || 0,
        currency: w.currency || 'USDC',
      });

      // Auto-fund if testnet
      if (network === 'tempo' && w.id) {
        await apiCall('POST', `/v1/wallets/${w.id}/test-fund`, { amount: 10, currency: 'USDC' });
        setWalletData(prev => prev ? { ...prev, balance: 10 } : prev);
      }
    } catch (e: any) {
      setError(e.message || 'Failed to create wallet');
    }
    setWalletLoading(false);
  }

  // ---- Link external wallet ----
  async function linkExternalWallet() {
    if (!accountId || !externalAddress.trim()) return;
    setWalletLoading(true);
    setError(null);
    try {
      const json = await apiCall('POST', '/v1/wallets/external', {
        accountId,
        walletAddress: externalAddress.trim(),
        name: `External Wallet`,
        currency: 'USDC',
      });
      const w = json.data || json;
      setWalletData({
        id: w.id,
        walletAddress: w.walletAddress || w.wallet_address || externalAddress,
        network: w.network || 'unknown',
        walletType: 'external',
        balance: 0,
        currency: 'USDC',
      });
    } catch (e: any) {
      setError(e.message || 'Failed to link wallet');
    }
    setWalletLoading(false);
  }

  // ---- Create agent ----
  async function createAgent() {
    if (!accountId || !agentName.trim()) return;
    setAgentLoading(true);
    setError(null);
    try {
      const json = await apiCall('POST', '/v1/agents', {
        accountId,
        name: agentName.trim(),
        description: agentDesc.trim() || undefined,
      });
      const data = json.data?.data || json.data || json;
      setAgentData({
        id: data.id,
        name: data.name,
        token: json.data?.credentials?.token,
      });
    } catch (e: any) {
      setError(e.message || 'Failed to create agent');
    }
    setAgentLoading(false);
  }

  // ---- Loading state ----
  if (loading || (provisioning && !showOrgForm)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-12 text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-primary" />
            <p className="text-muted-foreground">Setting up your organization...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---- Org name form (pre-provision) ----
  if (showOrgForm && !apiKeys) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <div className="flex justify-center mb-4">
              <div className="rounded-full bg-primary/10 p-3"><Zap className="h-8 w-8 text-primary" /></div>
            </div>
            <CardTitle className="text-2xl font-bold">Set up your organization</CardTitle>
            <CardDescription>One last step — give your organization a name.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={async (e) => {
              e.preventDefault();
              if (!orgName.trim()) { setError('Organization name is required'); return; }
              const code = inviteCode || new URLSearchParams(window.location.search).get('invite_code') || localStorage.getItem('sly_beta_invite_code') || '';
              await provision(orgName.trim(), code || undefined);
            }} className="space-y-4">
              {error && <div className="p-3 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-md">{error}</div>}
              <div className="space-y-2">
                <Label htmlFor="inviteCode">Invite Code</Label>
                <Input id="inviteCode" placeholder="beta_..." value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="orgName">Organization Name</Label>
                <Input id="orgName" placeholder="Acme Inc." value={orgName} onChange={(e) => setOrgName(e.target.value)} required autoFocus />
              </div>
              <Button type="submit" className="w-full" disabled={provisioning}>
                {provisioning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Organization
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---- Step progress bar ----
  const steps = [
    { num: 1, label: 'API Keys' },
    { num: 2, label: 'Wallet' },
    { num: 3, label: 'Agent' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 p-4">
      <div className="max-w-2xl mx-auto pt-8">
        {/* Progress */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {steps.map((s, i) => (
            <div key={s.num} className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                step > s.num ? 'bg-green-500 text-white' :
                step === s.num ? 'bg-primary text-primary-foreground' :
                'bg-muted text-muted-foreground'
              }`}>
                {step > s.num ? <Check className="h-4 w-4" /> : s.num}
              </div>
              <span className={`text-sm ${step === s.num ? 'font-medium' : 'text-muted-foreground'}`}>{s.label}</span>
              {i < steps.length - 1 && <div className="w-12 h-px bg-border" />}
            </div>
          ))}
        </div>

        {error && <div className="p-3 mb-4 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-md">{error}</div>}

        {/* ============================================================ */}
        {/* STEP 1: API Keys */}
        {/* ============================================================ */}
        {step === 1 && apiKeys && (
          <Card>
            <CardHeader className="text-center">
              <div className="flex justify-center mb-2">
                <div className="rounded-full bg-green-100 dark:bg-green-900/20 p-3"><Shield className="h-6 w-6 text-green-600" /></div>
              </div>
              <CardTitle>Your API Keys</CardTitle>
              <CardDescription>Save these keys — they won&apos;t be shown again.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg text-sm text-amber-800 dark:text-amber-200 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                These API keys are shown only once. Download or copy them now.
              </div>

              {[
                { label: 'Sandbox (Test)', key: apiKeys.test.key, id: 'test' },
                { label: 'Production (Live)', key: apiKeys.live.key, id: 'live' },
              ].map(({ label, key, id }) => (
                <div key={id} className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{label}</Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 p-2.5 bg-muted rounded-md text-xs font-mono break-all">{key}</code>
                    <Button variant="ghost" size="sm" onClick={() => handleCopy(key, id)}>
                      {copiedKey === id ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              ))}

              <div className="flex gap-2 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => downloadKeysAsEnv(apiKeys.test.key, apiKeys.live.key, orgName)}>
                  <Download className="mr-2 h-4 w-4" /> Download .env
                </Button>
                <Button className="flex-1" onClick={() => { setError(null); setStep(2); }}>
                  Next <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ============================================================ */}
        {/* STEP 2: Wallet */}
        {/* ============================================================ */}
        {step === 2 && !walletData && (
          <Card>
            <CardHeader className="text-center">
              <div className="flex justify-center mb-2">
                <div className="rounded-full bg-blue-100 dark:bg-blue-900/20 p-3"><Wallet className="h-6 w-6 text-blue-600" /></div>
              </div>
              <CardTitle>Connect a Wallet</CardTitle>
              <CardDescription>Wallets hold USDC for your agents to transact on-chain.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Create new */}
              <div className="border rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2 font-medium"><Plus className="h-4 w-4" /> Create New Wallet</div>
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" disabled={walletLoading} onClick={() => createWallet('base')}>
                    {walletLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Globe className="mr-2 h-4 w-4" />}
                    Base (Mainnet)
                  </Button>
                  <Button variant="outline" className="flex-1" disabled={walletLoading} onClick={() => createWallet('tempo')}>
                    {walletLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Zap className="mr-2 h-4 w-4" />}
                    Tempo (Testnet)
                  </Button>
                </div>
              </div>

              {/* Link existing */}
              <div className="border rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2 font-medium"><Link2 className="h-4 w-4" /> Link Existing Wallet</div>
                <div className="flex gap-2">
                  <Input placeholder="0x... or base58 address" value={externalAddress} onChange={(e) => setExternalAddress(e.target.value)} />
                  <Button variant="outline" disabled={!externalAddress.trim() || walletLoading} onClick={linkExternalWallet}>Link</Button>
                </div>
              </div>

              <button onClick={() => { setError(null); setStep(3); }} className="w-full text-center text-sm text-muted-foreground hover:text-foreground py-2">
                I&apos;ll connect a wallet later →
              </button>
            </CardContent>
          </Card>
        )}

        {/* Wallet created card */}
        {step === 2 && walletData && (
          <Card>
            <CardHeader className="text-center">
              <div className="flex justify-center mb-2">
                <div className="rounded-full bg-green-100 dark:bg-green-900/20 p-3"><Check className="h-6 w-6 text-green-600" /></div>
              </div>
              <CardTitle>Wallet Connected</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="border rounded-lg p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Address</span>
                  <code className="font-mono text-xs">{walletData.walletAddress ? `${walletData.walletAddress.substring(0, 8)}...${walletData.walletAddress.slice(-6)}` : 'Pending...'}</code>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Network</span>
                  <span>{walletData.network}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Balance</span>
                  <span>{walletData.balance} {walletData.currency}</span>
                </div>
              </div>
              <Button className="w-full" onClick={() => { setError(null); setStep(3); }}>
                Next <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        )}

        {/* ============================================================ */}
        {/* STEP 3: Connect Your Agent */}
        {/* ============================================================ */}
        {step === 3 && (
          <Card>
            <CardHeader className="text-center">
              <div className="flex justify-center mb-2">
                <div className="rounded-full bg-purple-100 dark:bg-purple-900/20 p-3"><Bot className="h-6 w-6 text-purple-600" /></div>
              </div>
              <CardTitle>Connect Your Agent</CardTitle>
              <CardDescription>Pick a method to connect your AI agent. It will self-register on first use.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Integration method picker */}
              {!integrationMethod ? (
                <div className="space-y-2">
                  {([
                    { id: 'mcp' as const, icon: Terminal, label: 'MCP Server', desc: 'Claude Desktop, Cursor, Windsurf' },
                    { id: 'a2a' as const, icon: Network, label: 'A2A Protocol', desc: 'Claude, GPT, custom LLMs' },
                    { id: 'sdk' as const, icon: Code, label: 'SDK', desc: 'Node.js / TypeScript apps' },
                    { id: 'api' as const, icon: Globe, label: 'REST API', desc: 'Any language / platform' },
                    { id: 'skills' as const, icon: FileCode, label: 'Skills.md', desc: 'Any LLM with tool use' },
                  ]).map(({ id, icon: Icon, label, desc }) => (
                    <button key={id} onClick={() => setIntegrationMethod(id)}
                      className="w-full flex items-center gap-3 p-3 border rounded-lg hover:bg-muted/50 transition-colors text-left">
                      <Icon className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div className="flex-1">
                        <div className="font-medium text-sm">{label}</div>
                        <div className="text-xs text-muted-foreground">{desc}</div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              ) : (
                /* Quickstart instructions for selected method */
                <div className="space-y-4">
                  <button onClick={() => setIntegrationMethod(null)} className="text-sm text-muted-foreground hover:text-foreground">← Back to methods</button>

                  {integrationMethod === 'mcp' && (
                    <div className="space-y-3">
                      <div className="text-sm text-muted-foreground">Add this to your <code className="bg-muted px-1 rounded">.mcp.json</code> or Claude Desktop config:</div>
                      <div className="relative">
                        <pre className="p-4 bg-muted rounded-lg text-xs font-mono overflow-x-auto">{`{
  "mcpServers": {
    "sly": {
      "command": "npx",
      "args": ["@sly/mcp-server"],
      "env": {
        "SLY_API_KEY": "${apiKeys?.test.key || 'pk_test_...'}"
      }
    }
  }
}`}</pre>
                        <Button variant="ghost" size="sm" className="absolute top-2 right-2" onClick={() => handleCopy(`{"mcpServers":{"sly":{"command":"npx","args":["@sly/mcp-server"],"env":{"SLY_API_KEY":"${apiKeys?.test.key || ''}"}}}}`, 'mcp')}>
                          {copiedKey === 'mcp' ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                        </Button>
                      </div>
                      <div className="text-xs text-muted-foreground">Your agent will auto-register when it first connects. Works with Claude Desktop, Cursor, Windsurf, and any MCP-compatible client.</div>
                    </div>
                  )}

                  {integrationMethod === 'a2a' && (
                    <div className="space-y-3">
                      <div className="text-sm text-muted-foreground">Register your agent via the A2A protocol:</div>
                      <pre className="p-4 bg-muted rounded-lg text-xs font-mono overflow-x-auto">{`# Register agent
curl -X POST https://api.getsly.ai/v1/agents \\
  -H "Authorization: Bearer ${apiKeys?.test.key || 'pk_test_...'}" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "My Agent", "accountId": "${accountId || '<account_id>'}"}'

# Your agent's A2A endpoint will be:
# https://api.getsly.ai/a2a/<agent_id>

# Other agents discover you at:
# https://api.getsly.ai/a2a/<agent_id>/.well-known/agent.json`}</pre>
                      <div className="text-xs text-muted-foreground">Agents communicate via JSON-RPC. Supports task delegation, payments, and skill discovery between agents.</div>
                    </div>
                  )}

                  {integrationMethod === 'sdk' && (
                    <div className="space-y-3">
                      <div className="text-sm text-muted-foreground">Install the SDK and connect:</div>
                      <pre className="p-4 bg-muted rounded-lg text-xs font-mono overflow-x-auto">{`npm install @sly/sdk

import { Sly } from '@sly/sdk';

const sly = new Sly({
  apiKey: '${apiKeys?.test.key || 'pk_test_...'}',
});

// Create an agent
const agent = await sly.request('/v1/agents', {
  method: 'POST',
  body: JSON.stringify({
    name: 'My Agent',
    accountId: '${accountId || '<account_id>'}',
  }),
});

// Get a settlement quote
const quote = await sly.getSettlementQuote({
  fromCurrency: 'USD',
  toCurrency: 'BRL',
  amount: '100',
});`}</pre>
                      <div className="text-xs text-muted-foreground">Full TypeScript SDK with typed methods for all protocols — x402, AP2, ACP, UCP, MPP.</div>
                    </div>
                  )}

                  {integrationMethod === 'api' && (
                    <div className="space-y-3">
                      <div className="text-sm text-muted-foreground">Use the REST API directly from any language:</div>
                      <pre className="p-4 bg-muted rounded-lg text-xs font-mono overflow-x-auto">{`# Register an agent
curl -X POST https://api.getsly.ai/v1/agents \\
  -H "Authorization: Bearer ${apiKeys?.test.key || 'pk_test_...'}" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "My Agent", "accountId": "${accountId || '<account_id>'}"}'

# List accounts
curl https://api.getsly.ai/v1/accounts \\
  -H "Authorization: Bearer ${apiKeys?.test.key || 'pk_test_...'}"

# API docs: https://docs.getsly.ai`}</pre>
                      <div className="text-xs text-muted-foreground">Works with any language or platform. Base URL: <code className="bg-muted px-1 rounded">https://api.getsly.ai</code></div>
                    </div>
                  )}

                  {integrationMethod === 'skills' && (
                    <div className="space-y-3">
                      <div className="text-sm text-muted-foreground">Create a <code className="bg-muted px-1 rounded">skills.md</code> file in your repo:</div>
                      <pre className="p-4 bg-muted rounded-lg text-xs font-mono overflow-x-auto">{`# My Agent

## Skills

### check_balance
- Price: free
- Input: account_id (string)
- Description: Check USDC balance for an account

### settlement_quote
- Price: 0.05 USDC
- Input: from_currency, to_currency, amount
- Description: Get real-time FX settlement quote

## Auth
api_key: ${apiKeys?.test.key || 'pk_test_...'}`}</pre>
                      <div className="text-xs text-muted-foreground">Other agents discover your skills automatically. Paid skills are billed via x402 micropayments.</div>
                    </div>
                  )}
                </div>
              )}

              <Button className="w-full" onClick={() => router.push('/dashboard')}>
                Go to Dashboard <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
