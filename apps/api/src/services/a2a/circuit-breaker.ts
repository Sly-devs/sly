/**
 * Per-agent circuit breaker for A2A forwarding (R6).
 *
 * Prevents hammering a consistently failing agent endpoint
 * with retries across many tasks.
 *
 * States: closed (allow) → open (block) → half-open (probe)
 */

interface CircuitState {
  status: 'closed' | 'open' | 'half-open';
  failures: number;
  lastFailureAt: number;
  openedAt: number;
}

const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT_MS = 60_000; // 60s before half-open probe

export class AgentCircuitBreaker {
  private circuits = new Map<string, CircuitState>();

  /**
   * Check if a call to this agent is allowed.
   */
  canCall(agentId: string): boolean {
    const state = this.circuits.get(agentId);
    if (!state) return true;

    if (state.status === 'closed') return true;

    if (state.status === 'open') {
      // Check if enough time has passed to transition to half-open
      if (Date.now() - state.openedAt >= RESET_TIMEOUT_MS) {
        state.status = 'half-open';
        return true; // Allow one probe
      }
      return false;
    }

    // half-open: allow one probe (already transitioned above)
    return true;
  }

  /**
   * Record a successful call — close the circuit.
   */
  recordSuccess(agentId: string): void {
    this.circuits.delete(agentId);
  }

  /**
   * Record a failed call — increment failures, potentially open the circuit.
   */
  recordFailure(agentId: string): void {
    const state = this.circuits.get(agentId);

    if (!state) {
      this.circuits.set(agentId, {
        status: 'closed',
        failures: 1,
        lastFailureAt: Date.now(),
        openedAt: 0,
      });
      return;
    }

    state.failures++;
    state.lastFailureAt = Date.now();

    if (state.status === 'half-open') {
      // Probe failed — re-open
      state.status = 'open';
      state.openedAt = Date.now();
      return;
    }

    if (state.failures >= FAILURE_THRESHOLD) {
      state.status = 'open';
      state.openedAt = Date.now();
    }
  }

  /**
   * Get circuit state for an agent (for logging/diagnostics).
   */
  getState(agentId: string): CircuitState | undefined {
    return this.circuits.get(agentId);
  }
}

/** Singleton instance shared across all task processors. */
export const agentCircuitBreaker = new AgentCircuitBreaker();
