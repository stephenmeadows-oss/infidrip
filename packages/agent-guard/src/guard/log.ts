import type { ReceiptWriter } from "../receipt.js";
import { ReceiptError } from "../receipt.js";
import type { DecisionLogEntry } from "./check.js";

/**
 * Writes evaluate decisions through the receipt log so a later verifier can re-derive them.
 * Guard-level blocks (replay, chain id, decimals, ledger) are attempts or gap markers.
 * A DECISION receipt always re-runs evaluate, so those blocks must not be recorded as one.
 */
export function receiptDecisionLog(writer: ReceiptWriter): {
  appendDecision(entry: DecisionLogEntry): void;
} {
  return {
    appendDecision(entry: DecisionLogEntry): void {
      if (entry.kind === "evaluate") {
        if (!entry.evaluation) {
          throw new ReceiptError("Evaluate decision is missing its inputs.");
        }
        const args = {
          evaluation: entry.evaluation,
          intentId: entry.intentId,
          payloadHash: entry.payloadHash,
          providerRef: { activity_id: entry.intentId, fingerprint: entry.fingerprint },
        };
        writer.appendAttempt(args);
        writer.appendDecision(args);
        return;
      }
      if (entry.evaluation) {
        writer.appendAttempt({
          evaluation: entry.evaluation,
          intentId: entry.intentId,
          payloadHash: entry.payloadHash,
          providerRef: { activity_id: entry.intentId, fingerprint: entry.fingerprint },
        });
        return;
      }
      const note = entry.reasonMessages[0] ?? entry.reasons[0] ?? "guard block";
      writer.appendGap({ agentId: entry.agentId, now: entry.at, note });
    },
  };
}
