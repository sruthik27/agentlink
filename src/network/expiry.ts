/** Normalize owner CLI input only. Persisted/network timestamps stay canonical. */
export function expiryFromOptions(options: Record<string, string>, maximumMs: number, now = Date.now()): string {
  if ((options.ttl === undefined) === (options['expires-at'] === undefined)) {
    throw new Error('Specify exactly one of --ttl (e.g. 12h, 30m) or --expires-at (UTC ISO timestamp)');
  }
  let expiry: number;
  if (options.ttl !== undefined) {
    const match = /^([1-9]\d*)(s|m|h|d)$/.exec(options.ttl);
    if (!match) throw new Error('--ttl must be a positive whole duration such as 30m or 12h (units: s, m, h, d)');
    expiry = now + Number(match[1]) * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!]!);
  } else {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(?:Z|\+00:00)$/.exec(options['expires-at']!);
    if (!match) throw new Error('--expires-at must be a UTC ISO timestamp, e.g. 2026-10-18T10:15:18Z');
    const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
    expiry = Date.parse(canonical);
    if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== canonical) throw new Error('--expires-at contains an invalid UTC calendar date or time');
  }
  if (!Number.isSafeInteger(expiry) || expiry <= now || expiry - now > maximumMs) {
    throw new Error(`Expiry must be in the future and within ${maximumMs / 3_600_000} hours`);
  }
  return new Date(expiry).toISOString();
}
