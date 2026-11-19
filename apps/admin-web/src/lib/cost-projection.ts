/**
 * The month-end projection the Dashboard shows beside the month-to-date costs.
 * The costs themselves come from `/api/costs`, whose handler reads the cost and
 * usage report through `@starkeep/operator/costs`.
 */

export interface ServiceCost {
  service: string;
  amount: number;
}

export function projectFullMonth(costs: ServiceCost[], today = new Date()): ServiceCost[] {
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  // Days elapsed = day-of-month (1-based), minimum 1 to avoid division by zero.
  const daysElapsed = Math.max(today.getDate(), 1);
  const factor = daysInMonth / daysElapsed;
  return costs.map(({ service, amount }) => ({
    service,
    amount: amount * factor,
  }));
}
