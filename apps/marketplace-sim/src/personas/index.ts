/**
 * Persona templates — behavioral archetypes for the marketplace.
 *
 * A template is a *behavior* (style + role + prompt + default KYA tier).
 * The seeder uses these to mint multiple SimAgent instances per template
 * (e.g. 5 honest traders all sharing the same prompt but with distinct
 * agent IDs and wallets).
 *
 * Templates do NOT carry agent IDs or tokens — those live in tokens.json
 * after `pnpm seed-personas`. See agents/registry.ts for the loader.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { PersonaTemplate } from '../processors/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadPrompt(filename: string): string {
  const path = resolve(__dirname, filename);
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return `(prompt file ${filename} not found)`;
  }
}

// Estimated LLM inference cost per skill invocation by persona style.
// Based on: ~1000 input tokens + ~800 output tokens per task response.
// Model mapping: quality-reviewer/whale → Sonnet ($3/$15/M), honest → Gemini Flash ($0.1/$0.4/M),
// rogue-disputer → GPT-4o-mini ($0.15/$0.6/M), rogue-spam → DeepSeek ($0.14/$0.28/M),
// colluder → Mistral ($0.1/$0.3/M), mm → Qwen ($0.18/$0.18/M)
const COST_BY_STYLE: Record<string, number> = {
  'quality-reviewer': 0.015, // Sonnet: (1000*3 + 800*15)/1M
  'whale': 0.015,
  'honest': 0.0004, // Gemini Flash: (1000*0.1 + 800*0.4)/1M
  'rogue-disputer': 0.0006, // GPT-4o-mini
  'rogue-spam': 0.0004, // DeepSeek
  'colluder': 0.0003, // Mistral
  'mm': 0.0003, // Qwen
};

function withCosts(style: string, skills: PersonaTemplate['skills']): PersonaTemplate['skills'] {
  const cost = COST_BY_STYLE[style] || 0.001;
  return (skills || []).map(s => ({ ...s, estimated_cost: cost }));
}

export const PERSONA_TEMPLATES: Record<string, PersonaTemplate> = {
  'honest-trader': {
    id: 'honest-trader',
    namePrefix: 'HonestBot',
    role: 'Honest marketplace participant',
    prompt: loadPrompt('honest-trader.md'),
    style: 'honest',
    defaultKyaTier: 1,
    skills: [
      { skill_id: 'code_review', name: 'Code Review', description: 'Review pull requests for bugs, style, and correctness', base_price: 2.0, tags: ['engineering', 'review'] },
      { skill_id: 'documentation', name: 'Documentation Writing', description: 'Write clear technical documentation and README files', base_price: 1.5, tags: ['writing', 'docs'] },
    ],
  },
  'quality-reviewer': {
    id: 'quality-reviewer',
    namePrefix: 'QualityReviewer',
    role: 'Rigorous quality reviewer',
    prompt: loadPrompt('quality-reviewer.md'),
    style: 'quality-reviewer',
    defaultKyaTier: 2,
    skills: [
      { skill_id: 'code_review', name: 'Premium Code Review', description: 'Deep code review with security analysis, performance profiling, and architecture assessment', base_price: 4.0, tags: ['engineering', 'review', 'premium'] },
      { skill_id: 'architecture_review', name: 'Architecture Review', description: 'Evaluate system design, identify scaling bottlenecks, recommend improvements', base_price: 5.0, tags: ['architecture', 'premium'] },
    ],
  },
  'rogue-disputer': {
    id: 'rogue-disputer',
    namePrefix: 'DisputeBot',
    role: 'Adversarial dispute agent (authorized red team)',
    prompt: loadPrompt('rogue-disputer.md'),
    style: 'rogue-disputer',
    defaultKyaTier: 0,
    skills: [
      { skill_id: 'code_review', name: 'Code Review', description: 'Cheap code review service', base_price: 0.5, tags: ['engineering', 'review'] },
      { skill_id: 'data_analysis', name: 'Data Analysis', description: 'Quick data analysis and reporting', base_price: 0.5, tags: ['data', 'analysis'] },
    ],
  },
  'whale-buyer': {
    id: 'whale-buyer',
    namePrefix: 'WhaleBot',
    role: 'Well-funded buyer with high spending limits',
    prompt: loadPrompt('whale-buyer.md'),
    style: 'whale',
    defaultKyaTier: 2,
    skills: [
      { skill_id: 'market_analysis', name: 'Market Analysis', description: 'Comprehensive market research and competitive intelligence', base_price: 8.0, tags: ['research', 'market', 'premium'] },
    ],
  },
  'colluder': {
    id: 'colluder',
    namePrefix: 'ColluderBot',
    role: 'Ring-trading agent for collusion detection scenarios',
    prompt: loadPrompt('colluder.md'),
    style: 'colluder',
    defaultKyaTier: 1,
    skills: [
      { skill_id: 'code_review', name: 'Code Review', description: 'Standard code review', base_price: 2.0, tags: ['engineering', 'review'] },
      { skill_id: 'web_research', name: 'Web Research', description: 'Research topics and compile findings', base_price: 1.5, tags: ['research'] },
    ],
  },
  'budget-trader': {
    id: 'budget-trader',
    namePrefix: 'BudgetBot',
    role: 'Cost-conscious trader — competes on price, minimal effort',
    prompt: loadPrompt('budget-trader.md'),
    style: 'honest',
    defaultKyaTier: 1,
    skills: [
      { skill_id: 'code_review', name: 'Quick Code Review', description: 'Fast, surface-level code review — catches obvious issues', base_price: 0.75, tags: ['engineering', 'review', 'budget'] },
      { skill_id: 'documentation', name: 'Basic Docs', description: 'Minimal documentation and inline comments', base_price: 0.5, tags: ['writing', 'docs', 'budget'] },
      { skill_id: 'data_entry', name: 'Data Entry', description: 'Structured data extraction and formatting', base_price: 0.3, tags: ['data', 'budget'] },
    ],
  },
  'specialist': {
    id: 'specialist',
    namePrefix: 'SpecialistBot',
    role: 'Deep domain expert in security auditing',
    prompt: loadPrompt('specialist.md'),
    style: 'quality-reviewer',
    defaultKyaTier: 2,
    skills: [
      { skill_id: 'security_audit', name: 'Security Audit', description: 'OWASP top 10 analysis, dependency scanning, secrets detection, and vulnerability assessment', base_price: 6.0, tags: ['security', 'audit', 'premium'] },
      { skill_id: 'penetration_test', name: 'Penetration Test Report', description: 'Simulate attack vectors and document findings with remediation steps', base_price: 8.0, tags: ['security', 'pentest', 'premium'] },
    ],
  },
  'newcomer': {
    id: 'newcomer',
    namePrefix: 'NewcomerBot',
    role: 'New marketplace entrant building reputation from zero',
    prompt: loadPrompt('newcomer.md'),
    style: 'honest',
    defaultKyaTier: 0,
    skills: [
      { skill_id: 'code_review', name: 'Code Review', description: 'Eager newcomer offering thorough code reviews at low prices to build reputation', base_price: 1.0, tags: ['engineering', 'review'] },
      { skill_id: 'web_research', name: 'Web Research', description: 'Topic research and summarization', base_price: 0.8, tags: ['research'] },
      { skill_id: 'translation', name: 'Translation', description: 'Translate technical content between languages', base_price: 0.6, tags: ['writing', 'translation'] },
    ],
  },
  'rogue-spam': {
    id: 'rogue-spam',
    namePrefix: 'SpamBot',
    role: 'Adversarial spammer — floods with low-effort responses',
    prompt: loadPrompt('rogue-spam.md'),
    style: 'rogue-spam',
    defaultKyaTier: 0,
    skills: [
      { skill_id: 'code_review', name: 'Code Review', description: 'Instant code review', base_price: 0.1, tags: ['engineering'] },
      { skill_id: 'documentation', name: 'Documentation', description: 'Auto-generated docs', base_price: 0.1, tags: ['writing'] },
      { skill_id: 'data_analysis', name: 'Data Analysis', description: 'Automated analysis', base_price: 0.1, tags: ['data'] },
      { skill_id: 'web_research', name: 'Web Research', description: 'Quick search results', base_price: 0.1, tags: ['research'] },
    ],
  },
  'market-maker': {
    id: 'market-maker',
    namePrefix: 'MMBot',
    role: 'Market maker — buys and sells, earns the spread',
    prompt: loadPrompt('market-maker.md'),
    style: 'mm',
    defaultKyaTier: 1,
    skills: [
      { skill_id: 'code_review', name: 'Code Review', description: 'Balanced code review — reliable quality at market rate', base_price: 2.5, tags: ['engineering', 'review'] },
      { skill_id: 'api_integration', name: 'API Integration', description: 'Design and implement REST/GraphQL API integrations', base_price: 3.0, tags: ['engineering', 'integration'] },
      { skill_id: 'data_analysis', name: 'Data Analysis', description: 'Statistical analysis and data pipeline design', base_price: 2.5, tags: ['data', 'analysis'] },
    ],
  },
  'conservative-buyer': {
    id: 'conservative-buyer',
    namePrefix: 'ConservativeBot',
    role: 'Risk-averse buyer — only accepts premium quality',
    prompt: loadPrompt('conservative-buyer.md'),
    style: 'quality-reviewer',
    defaultKyaTier: 2,
    skills: [
      { skill_id: 'compliance_review', name: 'Compliance Review', description: 'Regulatory compliance assessment — GDPR, SOC2, PCI-DSS', base_price: 7.0, tags: ['compliance', 'legal', 'premium'] },
    ],
  },
  'opportunist': {
    id: 'opportunist',
    namePrefix: 'OpportunistBot',
    role: 'Adaptive trader — calibrates effort to price point',
    prompt: loadPrompt('opportunist.md'),
    style: 'honest',
    defaultKyaTier: 1,
    skills: [
      { skill_id: 'code_review', name: 'Code Review', description: 'Adaptive code review — effort scales with payment', base_price: 1.5, tags: ['engineering', 'review'] },
      { skill_id: 'web_research', name: 'Web Research', description: 'Topic research calibrated to budget', base_price: 1.0, tags: ['research'] },
      { skill_id: 'api_integration', name: 'API Integration', description: 'Build API integrations and connectors', base_price: 2.0, tags: ['engineering', 'integration'] },
    ],
  },
  'researcher': {
    id: 'researcher',
    namePrefix: 'ResearchBot',
    role: 'Academic-minded analyst — thorough comparisons and trade-offs',
    prompt: loadPrompt('researcher.md'),
    style: 'quality-reviewer',
    defaultKyaTier: 2,
    skills: [
      { skill_id: 'web_research', name: 'Deep Research', description: 'Comprehensive literature review, competitive analysis, and technology comparison', base_price: 4.0, tags: ['research', 'analysis', 'premium'] },
      { skill_id: 'data_analysis', name: 'Statistical Analysis', description: 'Rigorous data analysis with methodology documentation', base_price: 5.0, tags: ['data', 'analysis', 'premium'] },
      { skill_id: 'whitepaper', name: 'Technical Writing', description: 'Author technical whitepapers and research reports', base_price: 6.0, tags: ['writing', 'research', 'premium'] },
    ],
  },
};

export function getTemplate(id: string): PersonaTemplate {
  const t = PERSONA_TEMPLATES[id];
  if (!t) throw new Error(`Unknown persona template: ${id}. Available: ${Object.keys(PERSONA_TEMPLATES).join(', ')}`);
  return t;
}

// Apply estimated costs to all skills based on the persona's style → model pricing
for (const t of Object.values(PERSONA_TEMPLATES)) {
  if (t.skills) t.skills = withCosts(t.style, t.skills);
}

export function listTemplates(): PersonaTemplate[] {
  return Object.values(PERSONA_TEMPLATES);
}
