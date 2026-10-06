import { createHash } from 'node:crypto';

export function contractSemanticContent(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const withoutMarkers = normalized.replace(/^<!--\s*agentlink-[^\n]*-->\s*\n?/gim, '');
  const withoutStatus = withoutMarkers.replace(/(^|\n)## Status[ \t]*\n[\s\S]*?(?=\n## |$)/i, '$1');
  return withoutStatus
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function computeContractRevision(content: string): string {
  return createHash('sha256').update(contractSemanticContent(content), 'utf8').digest('hex');
}

export function computeContractContentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
