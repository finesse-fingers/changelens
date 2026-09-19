/**
 * Incremental NDJSON framing.
 *
 * A chunk boundary can fall anywhere, including mid-string inside a large tool
 * input, so lines must be reassembled across chunks rather than parsed per
 * chunk. Single findings payloads routinely exceed one chunk.
 */
export class NdjsonParser {
  private buffer = '';

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A malformed line is a lost event, not a reason to abandon the stream.
        out.push({ type: 'parse_error', raw: line.slice(0, 500) });
      }
    }
    return out;
  }

  /** Anything left when the process exits: a final line without its newline. */
  flush(): unknown[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) return [];
    try {
      return [JSON.parse(rest)];
    } catch {
      return [{ type: 'parse_error', raw: rest.slice(0, 500) }];
    }
  }
}
