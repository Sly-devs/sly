/**
 * Reports: snapshots, readiness, baseline, rescans, exports.
 * All reads span the shared corpus; writes (rescans) tag the caller's tenant.
 */
import { Hono } from 'hono';
import { generateSnapshot, getSnapshots, formatSnapshotMarkdown, formatTrendMarkdown } from '../demand/snapshots.js';
import * as queries from '../db/queries.js';
import { scanDomain } from '../scanner.js';
import { getClient } from '../db/client.js';
import pLimit from 'p-limit';

export const reportsRouter = new Hono();

// ============================================
// SNAPSHOTS (Story 56.8)
// ============================================

reportsRouter.post('/snapshots', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const period = body.period || 'weekly';

  const snapshot = await generateSnapshot(period);
  return c.json(snapshot, 201);
});

reportsRouter.get('/snapshots', async (c) => {
  const period = c.req.query('period');
  const since = c.req.query('since');
  const limit = Math.min(parseInt(c.req.query('limit') || '52'), 200);

  const snapshots = await getSnapshots({
    period: period || undefined,
    since: since || undefined,
    limit,
  });

  return c.json({ data: snapshots });
});

reportsRouter.get('/snapshots/latest', async (c) => {
  const snapshots = await getSnapshots({ limit: 1 });
  if (snapshots.length === 0) {
    return c.json({ error: 'No snapshots yet. POST /v1/scanner/snapshots to create one.' }, 404);
  }
  return c.json(snapshots[0]);
});

reportsRouter.get('/snapshots/trend', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '12'), 52);
  const snapshots = await getSnapshots({ limit });
  return c.json({ data: snapshots });
});

// ============================================
// REPORTS (Story 56.12)
// ============================================

reportsRouter.get('/reports/readiness', async (c) => {
  const format = c.req.query('format') || 'json';
  const stats = await queries.getScanStats();
  const adoption = await queries.getProtocolAdoption();

  const report = {
    title: 'Agentic Commerce Readiness Report',
    generated_at: new Date().toISOString(),
    summary: stats,
    protocol_adoption: adoption,
  };

  if (format === 'markdown') {
    const snapshots = await getSnapshots({ limit: 2 });
    let md = '# Agentic Commerce Readiness Report\n\n';
    md += `*Generated: ${report.generated_at}*\n\n`;
    md += `**Total Scanned:** ${stats.total}\n`;
    md += `**Completed:** ${stats.completed}\n`;
    md += `**Avg Readiness:** ${stats.avg_readiness_score}/100\n\n`;

    md += '## Protocol Adoption\n\n';
    md += '| Protocol | Detected | Functional | Rate |\n';
    md += '|----------|----------|------------|------|\n';
    for (const [proto, data] of Object.entries(adoption)) {
      md += `| ${proto} | ${data.detected} | ${data.functional} | ${data.adoption_rate}% |\n`;
    }

    if (snapshots.length >= 2) {
      md += '\n' + formatTrendMarkdown(snapshots);
    } else if (snapshots.length === 1) {
      md += '\n' + formatSnapshotMarkdown(snapshots[0]);
    }

    c.header('Content-Type', 'text/markdown');
    return c.body(md);
  }

  return c.json(report);
});

reportsRouter.get('/reports/baseline', async (c) => {
  const { data: scans } = await queries.listMerchantScans({ limit: 100, page: 1 });
  const stats = await queries.getScanStats();
  const adoption = await queries.getProtocolAdoption();

  return c.json({
    title: 'State of Agentic Commerce — Baseline Report',
    generated_at: new Date().toISOString(),
    summary: stats,
    protocol_adoption: adoption,
    top_merchants: scans.slice(0, 25).map(s => ({
      domain: s.domain,
      merchant_name: (s as any).merchant_name,
      readiness_score: s.readiness_score,
      region: (s as any).region,
      merchant_category: (s as any).merchant_category,
    })),
  });
});

// ============================================
// RE-SCANS (Story 56.16)
// ============================================

reportsRouter.post('/rescan', async (c) => {
  const { tenantId } = c.get('ctx');
  const body = await c.req.json().catch(() => ({}));
  const maxAge = body.max_age_days || 7;
  const concurrency = Math.min(body.concurrency || 10, 20);
  const limitCount = Math.min(body.limit || 100, 500);

  const db = getClient();
  const staleDate = new Date();
  staleDate.setDate(staleDate.getDate() - maxAge);

  // Stale-scan selection is shared-corpus: find globally stale domains.
  const { data: staleScans, error } = await (db
    .from('merchant_scans') as any)
    .select('domain, merchant_name, merchant_category, country_code, region')
    .eq('scan_status', 'completed')
    .lt('last_scanned_at', staleDate.toISOString())
    .order('last_scanned_at', { ascending: true })
    .limit(limitCount) as { data: Array<{ domain: string; merchant_name: string | null; merchant_category: string | null; country_code: string | null; region: string | null }> | null; error: { message: string } | null };

  if (error) {
    return c.json({ error: `Failed to find stale scans: ${error.message}` }, 500);
  }

  if (!staleScans || staleScans.length === 0) {
    return c.json({ message: 'No stale scans found', rescanned: 0 });
  }

  const limit = pLimit(concurrency);
  let completed = 0;
  let failed = 0;

  const tasks = staleScans.map(scan =>
    limit(async () => {
      try {
        await scanDomain({
          tenantId,
          domain: scan.domain,
          merchant_name: scan.merchant_name || undefined,
          merchant_category: scan.merchant_category || undefined,
          country_code: scan.country_code || undefined,
          region: scan.region || undefined,
        });
        completed++;
      } catch {
        failed++;
      }
    })
  );

  Promise.allSettled(tasks).then(() => {
    console.log(`[Rescan] Complete: ${completed} ok, ${failed} failed out of ${staleScans.length}`);
  });

  return c.json({
    message: `Re-scan started for ${staleScans.length} stale merchants`,
    total: staleScans.length,
    max_age_days: maxAge,
    concurrency,
  }, 202);
});

reportsRouter.get('/rescan/status', async (c) => {
  const maxAge = parseInt(c.req.query('max_age_days') || '7');
  const db = getClient();

  const staleDate = new Date();
  staleDate.setDate(staleDate.getDate() - maxAge);

  const { count: staleCount } = await db
    .from('merchant_scans')
    .select('id', { count: 'exact', head: true })
    .eq('scan_status', 'completed')
    .lt('last_scanned_at', staleDate.toISOString());

  const { count: totalCount } = await db
    .from('merchant_scans')
    .select('id', { count: 'exact', head: true })
    .eq('scan_status', 'completed');

  const { count: pendingCount } = await db
    .from('merchant_scans')
    .select('id', { count: 'exact', head: true })
    .eq('scan_status', 'pending');

  const { count: failedCount } = await db
    .from('merchant_scans')
    .select('id', { count: 'exact', head: true })
    .eq('scan_status', 'failed');

  return c.json({
    total_completed: totalCount || 0,
    stale: staleCount || 0,
    pending: pendingCount || 0,
    failed: failedCount || 0,
    max_age_days: maxAge,
    stale_threshold: staleDate.toISOString(),
  });
});

// ============================================
// EXPORTS (Story 56.17)
// ============================================

reportsRouter.get('/export', async (c) => {
  const format = c.req.query('format') || 'csv';
  const category = c.req.query('category');
  const region = c.req.query('region');
  const minScore = c.req.query('min_score');
  const maxScore = c.req.query('max_score');
  const limitCount = Math.min(parseInt(c.req.query('limit') || '1000'), 5000);

  const result = await queries.listMerchantScans({
    category: category || undefined,
    region: region || undefined,
    min_score: minScore ? parseInt(minScore) : undefined,
    max_score: maxScore ? parseInt(maxScore) : undefined,
    page: 1,
    limit: limitCount,
  });

  if (format === 'csv') {
    const header = 'domain,merchant_name,merchant_category,country_code,region,readiness_score,protocol_score,data_score,accessibility_score,checkout_score,scan_status,last_scanned_at';
    const rows = result.data.map(s => {
      const r = s as any;
      return `${r.domain},"${(r.merchant_name || '').replace(/"/g, '""')}",${r.merchant_category || ''},${r.country_code || ''},${r.region || ''},${r.readiness_score},${r.protocol_score},${r.data_score},${r.accessibility_score},${r.checkout_score},${r.scan_status},${r.last_scanned_at || ''}`;
    });
    const csv = [header, ...rows].join('\n');

    c.header('Content-Type', 'text/csv');
    c.header('Content-Disposition', `attachment; filename="scan-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(csv);
  }

  if (format === 'markdown') {
    let md = '# Scan Export\n\n';
    md += `*${result.total} merchants | Generated: ${new Date().toISOString()}*\n\n`;
    md += '| Domain | Name | Category | Region | Score | Status |\n';
    md += '|--------|------|----------|--------|-------|--------|\n';
    for (const s of result.data) {
      const r = s as any;
      md += `| ${r.domain} | ${r.merchant_name || '-'} | ${r.merchant_category || '-'} | ${r.region || '-'} | ${r.readiness_score} | ${r.scan_status} |\n`;
    }

    c.header('Content-Type', 'text/markdown');
    c.header('Content-Disposition', `attachment; filename="scan-export-${new Date().toISOString().slice(0, 10)}.md"`);
    return c.body(md);
  }

  return c.json({
    data: result.data,
    total: result.total,
    exported_at: new Date().toISOString(),
  });
});
