import type Redis from 'ioredis';
import { err, ok, type Result } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type { RateLimitCheck, RateLimitStore, RateLimitWindow, RateLimitWindowState } from '../../application/governance/rate-limit.port';

/**
 * Redis is the shared source of truth for live request budgets. The Lua
 * operation checks every window before incrementing any of them, preventing a
 * request from consuming its minute quota when its daily quota is exhausted.
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async inspect(windows: readonly RateLimitWindow[]): Promise<Result<RateLimitCheck, InfraError>> {
    if (windows.length === 0) return ok({ allowed: true, windows: [] });
    try {
      const values = await this.redis.mget(windows.map(window => window.key));
      const ttls = await Promise.all(windows.map(window => this.redis.ttl(window.key)));
      const states = windows.map((window, index) => stateFor(
        window,
        Number.parseInt(values[index] ?? '0', 10) || 0,
        (ttls[index] ?? 0) > 0 ? (ttls[index] ?? 0) : window.ttlSeconds,
      ));
      return ok({ allowed: states.every(state => state.used < state.limit), windows: states });
    } catch (cause) {
      return err(wrapInfra('redis', 'rate_limit.inspect', cause));
    }
  }

  async consume(windows: readonly RateLimitWindow[]): Promise<Result<RateLimitCheck, InfraError>> {
    if (windows.length === 0) return ok({ allowed: true, windows: [] });
    try {
      const args = windows.flatMap(window => [String(window.limit), String(window.ttlSeconds)]);
      const raw = await this.redis.eval(CONSUME_WINDOWS_LUA, windows.length, ...windows.map(window => window.key), ...args);
      const rows = Array.isArray(raw) ? raw : [];
      const states = windows.map((window, index) => {
        const used = Number(rows[index * 2] ?? 0);
        const retryAfterSeconds = Number(rows[(index * 2) + 1] ?? window.ttlSeconds);
        return stateFor(window, used, retryAfterSeconds);
      });
      return ok({ allowed: Number(rows[windows.length * 2] ?? 0) === 1, windows: states });
    } catch (cause) {
      return err(wrapInfra('redis', 'rate_limit.consume', cause));
    }
  }
}

function stateFor(window: RateLimitWindow, used: number, retryAfterSeconds: number): RateLimitWindowState {
  return { ...window, used, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
}

const CONSUME_WINDOWS_LUA = `
local allowed = 1
local values = {}
for i = 1, #KEYS do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  values[i] = current
  local limit = tonumber(ARGV[(i - 1) * 2 + 1])
  if current >= limit then allowed = 0 end
end

local result = {}
for i = 1, #KEYS do
  local ttl = tonumber(ARGV[(i - 1) * 2 + 2])
  local current = values[i]
  if allowed == 1 then
    current = redis.call('INCR', KEYS[i])
    if current == 1 then redis.call('EXPIRE', KEYS[i], ttl) end
  end
  local remainingTtl = redis.call('TTL', KEYS[i])
  if remainingTtl < 1 then remainingTtl = ttl end
  table.insert(result, current)
  table.insert(result, remainingTtl)
end
table.insert(result, allowed)
return result
`;
