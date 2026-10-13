import { domainsIn } from './tiers.js';

/**
 * Per-task taint. Once a task has read a web page, an email or a downloaded file, its later sends,
 * uploads and visits to new websites move up one tier. This blocks "read a secret, then leak it in a URL".
 */
export class TaintTracker {
  private taintedBy: string | null = null;
  private readonly domains = new Set<string>();

  constructor(ownerPrompt: string) {
    for (const d of domainsIn(ownerPrompt)) this.domains.add(d);
  }

  get tainted(): boolean {
    return this.taintedBy !== null;
  }

  get source(): string | null {
    return this.taintedBy;
  }

  get knownDomains(): ReadonlySet<string> {
    return this.domains;
  }

  /** Record an allowed call. Visits before taint become known; the first tainting read sets taint. */
  record(call: { toolName: string; taints: boolean; domain?: string | undefined }): void {
    if (call.domain && !this.tainted) this.domains.add(call.domain);
    if (call.taints && !this.tainted) this.taintedBy = call.toolName;
  }

  /** The owner added to the task: domains they name are trusted too. */
  addOwnerText(text: string): void {
    for (const d of domainsIn(text)) this.domains.add(d);
  }
}
