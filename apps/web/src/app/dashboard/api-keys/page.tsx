'use client';

import { useState } from 'react';
import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardHeader, 
  CardTitle,
  Button,
  Input,
  Label,
  Badge,
} from '@sly/ui';
import { useApiConfig } from '@/lib/api-client';
import { Key, Eye, EyeOff, Check, Copy, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

export default function ApiKeysPage() {
  const { apiKey, setApiKey, isConfigured, authToken, apiUrl } = useApiConfig();
  const [newApiKey, setNewApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);

  // Check if user is authenticated via JWT (normal dashboard access)
  const isAuthenticatedViaJWT = !!authToken;

  const handleSaveKey = async () => {
    if (!newApiKey.startsWith('pk_')) {
      toast.error('Invalid API key format. Keys should start with pk_test_ or pk_live_');
      return;
    }

    setTesting(true);
    try {
      // Test the key by making a simple request
      const response = await fetch(`${apiUrl}/v1/accounts?limit=1`, {
        headers: {
          'Authorization': `Bearer ${newApiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error('Invalid API key');
      }

      setApiKey(newApiKey);
      setNewApiKey('');
      toast.success('API key saved successfully for programmatic access');
    } catch {
      toast.error('Failed to validate API key. Please check and try again.');
    } finally {
      setTesting(false);
    }
  };

  const handleCopyKey = () => {
    if (apiKey) {
      navigator.clipboard.writeText(apiKey);
      toast.success('API key copied to clipboard');
    }
  };

  const handleRemoveKey = () => {
    setApiKey(null);
    toast.success('API key removed');
  };

  const maskedKey = apiKey ? `${apiKey.slice(0, 12)}${'•'.repeat(20)}${apiKey.slice(-4)}` : '';

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">API Keys</h1>
        <p className="text-muted-foreground">
          Manage API keys for programmatic access to Sly (scripts, integrations, etc.)
        </p>
        {isAuthenticatedViaJWT && (
          <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-lg">
            <p className="text-sm text-blue-900 dark:text-blue-100">
              ✅ <strong>Dashboard Access Active:</strong> You're logged in and can use the dashboard.
              API keys are optional and only needed for programmatic access (command-line tools, scripts, external integrations).
            </p>
          </div>
        )}
      </div>

      {/* Current Key Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Current API Key
          </CardTitle>
          <CardDescription>
            Your API key is used to authenticate requests to the Sly API
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isConfigured ? (
            <>
              <div className="flex items-center gap-2">
                <Badge variant="success" className="gap-1">
                  <Check className="h-3 w-3" />
                  Configured
                </Badge>
                <Badge variant="outline">
                  {apiKey?.startsWith('pk_test_') ? 'Test Mode' : 'Live Mode'}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-muted px-3 py-2 text-sm font-mono">
                  {showKey ? apiKey : maskedKey}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button variant="outline" size="icon" onClick={handleCopyKey}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <Button variant="destructive" onClick={handleRemoveKey}>
                Remove API Key
              </Button>
            </>
          ) : isAuthenticatedViaJWT ? (
            <div className="flex items-center gap-2 text-green-600 dark:text-green-500">
              <CheckCircle2 className="h-5 w-5" />
              <span>Dashboard access via login (no API key needed)</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-yellow-600 dark:text-yellow-500">
              <AlertTriangle className="h-5 w-5" />
              <span>No authentication. Please log in or add an API key.</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add New Key */}
      {!apiKey && (
        <Card>
          <CardHeader>
            <CardTitle>Add API Key (Optional)</CardTitle>
            <CardDescription>
              {isAuthenticatedViaJWT 
                ? "Add an API key only if you need programmatic access to Sly from scripts or external tools."
                : "Enter your Sly API key to enable dashboard features. You can find your API key in the Sly developer portal."
              }
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="apiKey">API Key</Label>
              <Input
                id="apiKey"
                type="password"
                placeholder="pk_test_..."
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Test keys start with <code>pk_test_</code>, live keys start with <code>pk_live_</code>
              </p>
            </div>
            <Button onClick={handleSaveKey} disabled={!newApiKey || testing}>
              {testing ? 'Validating...' : 'Save API Key'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* API Key Info */}
      <Card>
        <CardHeader>
          <CardTitle>About API Keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p>
            Sly uses API keys to authenticate requests from your applications and
            the dashboard. There are two types of keys:
          </p>
          <ul className="list-disc list-inside space-y-2">
            <li>
              <strong className="text-foreground">Test keys</strong> (pk_test_*): Use these for
              development and testing. They work with test data only.
            </li>
            <li>
              <strong className="text-foreground">Live keys</strong> (pk_live_*): Use these in
              production. They work with real accounts and real money.
            </li>
          </ul>
          <p>
            Keep your API keys secure. Do not share them or commit them to version control.
            If you believe a key has been compromised, rotate it immediately.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

