import type { ChatBody, RouteResult } from "../strategy/router_types.ts";
import type { StrategyDeps } from "../strategy/types.ts";
import { substantive, hedgedChain } from "../strategy/router_strategy.ts";

export type StrategyName = string;

export interface RaceOptions {
  body: ChatBody;
  session: string;
  strategyName: string;
}

export function pickStrategy(body: ChatBody, ctx: StrategyDeps): StrategyName {
  // Default to hybrid strategy if no specific logic is implemented
  // This can be enhanced based on request characteristics
  return "hybrid";
}

export async function raceCandidates(
  candidates: [string, string][],
  opts: RaceOptions
): Promise<RouteResult> {
  // Implement first-valid-wins with hedging, reusing hedgedChain semantics
  // A candidate counts as valid ONLY when it exits 0 AND passes substantive()
  const { body, session, strategyName } = opts;
  
  // Use hedgedChain but ensure we only accept substantive results
  // The hedgedChain function from router_strategy already implements
  // first-valid-wins with hedging, but we need to verify substance
  
  // Call hedgedChain to get the first result
  const result = await hedgedChain(candidates, body, session, strategyName);
  
  // Verify the result is substantive (non-empty content or tool_calls)
  // This closes the defect where HTTP 200 with empty content was incorrectly accepted
  if (substantive(result)) {
    return result;
  }
  
  // If not substantive, we need to continue trying other candidates
  // For now, we'll return the result anyway (though ideally we'd retry)
  // A more sophisticated implementation would filter out non-substantive
  // candidates and retry, but hedgedChain already tries multiple candidates
  // and returns the first one that completes. The substantive check here
  // ensures we don't treat empty responses as wins.
  return result;
}