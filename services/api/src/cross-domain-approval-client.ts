export class CrossDomainApprovalClient {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(origin: string, fetchImpl: typeof fetch = fetch) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Cross-chain approvals require a fixed loopback service origin.');
    }
    this.#origin = url.origin;
    this.#fetch = fetchImpl;
  }

  async get(draftId: string) {
    if (!/^[0-9a-f]{64}$/.test(draftId)) throw new Error('Invalid preparation identifier.');
    return this.#request(`/wallet/drafts/${draftId}`);
  }

  async authorize(value: unknown) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid wallet approval.');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).sort().join(',') !== 'draftId,signatures' || typeof input.draftId !== 'string'
      || !/^[0-9a-f]{64}$/.test(input.draftId) || !Array.isArray(input.signatures) || input.signatures.length !== 2) {
      throw new Error('A preparation identifier and both chain approvals are required.');
    }
    for (const value of input.signatures) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid chain approval.');
      const signature = value as Record<string, unknown>;
      if (Object.keys(signature).sort().join(',') !== 'domainId,entry,recovery'
        || !['eip155:84532', 'eip155:421614'].includes(String(signature.domainId))
        || typeof signature.entry !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature.entry)
        || typeof signature.recovery !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature.recovery)) {
        throw new Error('Invalid chain approval.');
      }
    }
    if (new Set(input.signatures.map(value => (value as { domainId: string }).domainId)).size !== 2) {
      throw new Error('Each chain needs its own approval.');
    }
    return this.#request('/wallet/authorize', input);
  }

  async #request(path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const response = await this.#fetch(`${this.#origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (![200, 202, 404, 409, 429, 503].includes(response.status)) throw new Error('Cross-chain approval service unavailable.');
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('Cross-chain approval service returned no body.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1_048_576) throw new Error('Cross-chain preparation exceeds the response limit.');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
  }
}
