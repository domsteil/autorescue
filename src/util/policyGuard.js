export function evaluateDecision(decision, orderContext, policy) {
  if (!decision?.toolCall?.name) {
    return {
      allowed: false,
      reason: 'Decision missing tool call name',
    };
  }

  const action = decision.toolCall.name;
  const args = decision.toolCall.arguments ?? {};
  const reasons = [];

  switch (action) {
    case 'create_coupon': {
      const amountOff = Number(args.amountOff ?? args.amount_off ?? 0);
      if (!Number.isFinite(amountOff) || amountOff <= 0) {
        reasons.push('Coupon amount must be a positive number');
      }
      const orderTotal = computeOrderTotal(orderContext);
      const maxCredit =
        typeof policy?.maxCreditPercentage === 'number'
          ? orderTotal * policy.maxCreditPercentage
          : Infinity;
      if (amountOff > maxCredit) {
        reasons.push(
          `Coupon amount ${amountOff} exceeds max credit ${maxCredit.toFixed(2)}`,
        );
      }
      break;
    }
    case 'create_refund': {
      const amount =
        Number(args.amount ?? args.amountOff ?? args.amount_off ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        reasons.push('Refund amount must be a positive number');
      }
      if (
        typeof policy?.maxRefundAmount === 'number' &&
        amount > policy.maxRefundAmount
      ) {
        reasons.push(
          `Refund amount ${amount} exceeds max refund ${policy.maxRefundAmount}`,
        );
      }
      break;
    }
    case 'create_reshipment': {
      if (!Array.isArray(args.items) || args.items.length === 0) {
        reasons.push('Reshipment requires items array');
      }
      if (Array.isArray(orderContext?.resolutionHistory)) {
        const reshipsThisMonth = orderContext.resolutionHistory.filter(
          (entry) =>
            entry.type === 'reshipment' &&
            daysBetween(entry.completedAt, new Date()) <= 30,
        ).length;
        if (
          reshipsThisMonth >= Number(policy?.maxReshipmentsPerMonth ?? Infinity)
        ) {
          reasons.push('Customer exceeded reshipments allowed this month');
        }
      }
      break;
    }
    case 'manual_review':
      break;
    default:
      reasons.push(`Unknown action ${action}`);
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

function computeOrderTotal(orderContext) {
  if (!Array.isArray(orderContext?.lineItems)) return 0;
  return orderContext.lineItems.reduce((acc, item) => {
    const quantity = Number(item.quantity ?? 1);
    const price = Number(item.price ?? 0);
    if (!Number.isFinite(quantity) || !Number.isFinite(price)) {
      return acc;
    }
    return acc + quantity * price;
  }, 0);
}

function daysBetween(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  const diff = Math.abs(a.getTime() - b.getTime());
  return diff / (1000 * 60 * 60 * 24);
}
