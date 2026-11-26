/**
 * A service's cost as the Dashboard shows it. `/api/costs` answers the
 * month-to-date costs and their month-end projection, which
 * `@starkeep/operator/costs` computes on the server.
 */
export interface ServiceCost {
  service: string;
  amount: number;
}
