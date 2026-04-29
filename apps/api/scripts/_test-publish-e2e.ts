// End-to-end probe: actually buy the published endpoint via the probe wallet
// using x402-fetch + CDP-managed signing, exactly the way the publish flow's
// triggerFirstSettle does. Reports each step so we can pinpoint failures.
import 'dotenv/config';

async function main() {
  const apiKeyId = process.env.CDP_API_KEY_ID || process.env.CDP_API_KEY_NAME;
  const apiKeySecret =
    process.env.CDP_API_KEY_SECRET ||
    process.env.CDP_PRIVATE_KEY ||
    process.env.CDP_API_KEY_PRIVATE_KEY;
  const walletSecret = process.env.CDP_WALLET_SECRET;
  const probeWalletAddress = process.env.SLY_PUBLISH_PROBE_WALLET_ID;
  if (!apiKeyId || !apiKeySecret || !walletSecret || !probeWalletAddress) {
    console.error('Missing CDP creds or probe wallet');
    process.exit(1);
  }

  const gatewayUrl = process.env.SLY_TEST_URL || 'https://api.getsly.ai/x402/demo/poem';
  console.log(`[1/5] target: ${gatewayUrl}`);

  // Step 1: raw fetch — see the 402 + headers
  const raw = await fetch(gatewayUrl);
  console.log(`[2/5] raw GET status: ${raw.status}`);
  const paymentRequired = raw.headers.get('PAYMENT-REQUIRED');
  console.log(`      PAYMENT-REQUIRED present: ${!!paymentRequired}`);
  if (!paymentRequired) {
    console.error('No PAYMENT-REQUIRED header — gateway is misconfigured');
    process.exit(1);
  }

  // Step 2: load CDP + x402 buyer libs
  const { CdpClient } = await import('@coinbase/cdp-sdk');
  const { wrapFetchWithPayment, x402Client } = await import('@x402/fetch');
  const { ExactEvmScheme } = await import('@x402/evm');

  const cdp = new CdpClient({ apiKeyId, apiKeySecret, walletSecret });
  const account: any = await cdp.evm.getAccount({ address: probeWalletAddress as `0x${string}` });
  console.log(`[3/5] CDP account loaded: ${account.address}`);

  const signer = {
    address: probeWalletAddress as `0x${string}`,
    signTypedData: async (msg: any) => {
      console.log('       signTypedData domain:', JSON.stringify(msg.domain).slice(0, 100));
      return account.signTypedData(msg);
    },
  };

  const client = new x402Client().register('eip155:8453', new ExactEvmScheme(signer));
  const fetchWithPay = wrapFetchWithPayment(globalThis.fetch as any, client);
  console.log('[4/5] x402Client registered for "eip155:8453" with ExactEvmScheme');

  // Step 3: actual buy
  console.log('[5/5] fetchWithPay → ' + gatewayUrl);
  try {
    const headers: Record<string, string> = {};
    if (process.env.SLY_TEST_REFERER) headers['referer'] = process.env.SLY_TEST_REFERER;
    if (process.env.SLY_TEST_SOURCE) headers['x-sly-source'] = process.env.SLY_TEST_SOURCE;
    if (process.env.SLY_TEST_UA) headers['user-agent'] = process.env.SLY_TEST_UA;
    const res = await fetchWithPay(gatewayUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    console.log(`       status: ${res.status}`);
    console.log(`       receipt: ${res.headers.get('x-payment-receipt') || res.headers.get('PAYMENT-RESPONSE') || '(none)'}`);
    console.log(`       extension-responses: ${res.headers.get('extension-responses') || '(none)'}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`       FAILED body: ${body.slice(0, 600)}`);
      process.exit(1);
    }
    const body = await res.text().catch(() => '');
    console.log(`       OK body (truncated): ${body.slice(0, 800)}`);
    console.log('');
    console.log('✅ End-to-end buy succeeded — CDP settled on-chain.');
  } catch (err: any) {
    console.error('       BUYER FETCH THREW:', err?.message || err);
    if (err?.cause) console.error('       cause:', err.cause?.message || err.cause);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
