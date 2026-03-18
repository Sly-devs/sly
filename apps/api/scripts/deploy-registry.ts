/**
 * Compile and deploy the SlyAgentRegistry contract to Base Sepolia.
 *
 * Usage:
 *   cd apps/api && source .env && npx tsx scripts/deploy-registry.ts
 *
 * Required env vars:
 *   EVM_PRIVATE_KEY          - deployer wallet private key
 *   BASE_SEPOLIA_RPC_URL     - (optional) RPC endpoint, defaults to https://sepolia.base.org
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

// ── Paths ────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTRACT_PATH = path.join(PROJECT_ROOT, 'contracts', 'SlyAgentRegistry.sol');

// ── Compile ──────────────────────────────────────────────────────────
function compile() {
  const source = fs.readFileSync(CONTRACT_PATH, 'utf8');

  const input = {
    language: 'Solidity',
    sources: {
      'SlyAgentRegistry.sol': { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': { '*': ['abi', 'evm.bytecode'] },
      },
    },
  };

  function findImports(importPath: string) {
    // Resolve @openzeppelin imports from node_modules
    const candidates = [
      path.join(PROJECT_ROOT, 'node_modules', importPath),
      path.join(PROJECT_ROOT, 'node_modules', '.pnpm', 'node_modules', importPath),
    ];

    for (const fullPath of candidates) {
      if (fs.existsSync(fullPath)) {
        return { contents: fs.readFileSync(fullPath, 'utf8') };
      }
    }

    // Try to find in pnpm's content-addressable store structure
    const nodeModulesRoot = path.join(PROJECT_ROOT, 'node_modules');
    if (importPath.startsWith('@openzeppelin/')) {
      // pnpm hoists to node_modules/@openzeppelin
      const hoisted = path.join(nodeModulesRoot, importPath);
      if (fs.existsSync(hoisted)) {
        return { contents: fs.readFileSync(hoisted, 'utf8') };
      }
    }

    return { error: `File not found: ${importPath}` };
  }

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports }),
  );

  if (output.errors) {
    const fatal = output.errors.filter((e: any) => e.severity === 'error');
    if (fatal.length > 0) {
      console.error('Compilation errors:');
      for (const err of fatal) console.error(err.formattedMessage);
      process.exit(1);
    }
    // Print warnings
    for (const w of output.errors.filter((e: any) => e.severity === 'warning')) {
      console.warn(w.formattedMessage);
    }
  }

  const contract = output.contracts['SlyAgentRegistry.sol']['SlyAgentRegistry'];
  return {
    abi: contract.abi as Abi,
    bytecode: `0x${contract.evm.bytecode.object}` as `0x${string}`,
  };
}

// ── Deploy ───────────────────────────────────────────────────────────
async function deploy() {
  console.log('=== Deploy SlyAgentRegistry to Base Sepolia ===\n');

  // Validate env
  const pk = process.env.EVM_PRIVATE_KEY;
  if (!pk) {
    console.error('EVM_PRIVATE_KEY is required');
    process.exit(1);
  }

  // Compile
  console.log('Compiling SlyAgentRegistry.sol...');
  const { abi, bytecode } = compile();
  console.log(`  ABI entries: ${abi.length}`);
  console.log(`  Bytecode size: ${(bytecode.length - 2) / 2} bytes\n`);

  // Set up clients
  const formattedKey = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
  const account = privateKeyToAccount(formattedKey);
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  console.log(`Deployer: ${account.address}`);
  console.log(`Chain:    Base Sepolia (84532)`);
  console.log(`RPC:      ${rpcUrl}\n`);

  // Check balance
  const balance = await publicClient.getBalance({ address: account.address });
  const balanceEth = Number(balance) / 1e18;
  console.log(`Balance:  ${balanceEth.toFixed(6)} ETH`);
  if (balanceEth < 0.001) {
    console.error('Insufficient ETH for deployment. Need at least 0.001 ETH.');
    process.exit(1);
  }

  // Deploy
  console.log('\nDeploying...');
  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [],
  });
  console.log(`Tx hash: ${hash}`);
  console.log(`Explorer: https://sepolia.basescan.org/tx/${hash}\n`);

  console.log('Waiting for confirmation...');
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== 'success') {
    console.error('Deployment failed! Transaction reverted.');
    process.exit(1);
  }

  const contractAddress = receipt.contractAddress!;
  console.log(`\n✅ Contract deployed at: ${contractAddress}`);
  console.log(`   BaseScan: https://sepolia.basescan.org/address/${contractAddress}\n`);

  // Verify name
  const name = await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: 'name',
  });
  console.log(`Contract name(): "${name}"`);

  console.log('\n=== Next Steps ===');
  console.log(`1. Update TESTNET_IDENTITY_REGISTRY in:`);
  console.log(`   - apps/api/src/services/erc8004/registry.ts`);
  console.log(`   - apps/api/src/services/reputation/sources/erc8004.ts`);
  console.log(`   to: '${contractAddress}'`);
  console.log(`2. Clear erc8004_agent_id in the DB`);
  console.log(`3. Re-run: npx tsx scripts/register-agents-erc8004.ts`);
}

deploy().catch((err) => {
  console.error('Deploy failed:', err);
  process.exit(1);
});
