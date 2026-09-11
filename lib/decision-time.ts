export type DecisionCardInput = {
  headline?: string | null;
  category?: string | null;
  sourceLabel?: string | null;
  cardHtml?: string | null;
  agentContext?: string | null;
  decisionEstimateMs?: number | null;
  decisionEstimateReason?: string | null;
};

export type DecisionEstimate = {
  estimatedMs: number | null;
  reason: string;
};

function safeContext(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function positiveNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function estimateDecisionTime(card: DecisionCardInput): DecisionEstimate {
  const context = safeContext(card.agentContext);
  let estimatedMs = positiveNumber(card.decisionEstimateMs);
  if (estimatedMs === null) {
    for (const key of ["effortSeconds", "decisionEstimateSeconds", "decisionTimeEstimateSeconds", "reviewEstimateSeconds"]) {
      const seconds = positiveNumber(context[key]);
      if (seconds !== null && Number.isFinite(seconds * 1_000)) {
        estimatedMs = seconds * 1_000;
        break;
      }
    }
  }
  if (estimatedMs === null) return { estimatedMs: null, reason: "" };

  const reasons = [card.decisionEstimateReason, context.effortReason, context.decisionEstimateReason,
    context.decisionTimeEstimateReason, context.reviewEstimateReason];
  const reason = reasons.find((value): value is string => typeof value === "string" && !!value.trim());
  return { estimatedMs, reason: reason?.trim() ?? "" };
}
