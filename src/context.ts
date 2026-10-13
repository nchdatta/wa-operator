import type { Config } from './config/env.js';
import type { Logger } from './observability/logger.js';
import type { Db } from './persistence/db.js';
import type { Clock } from './shared/clock.js';

/** Everything long-lived that services need, passed explicitly (no globals) so tests can swap parts. */
export interface AppContext {
  config: Config;
  db: Db;
  logger: Logger;
  clock: Clock;
  /** Secret values that must never appear in logs, audit rows or messages. */
  secrets: readonly string[];
}
