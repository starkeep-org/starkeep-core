/**
 * The one shape every operation reports progress in. The installer defines it
 * (`@starkeep/admin-installer/operations/events`), because its operations
 * write the events, and the CLI and admin-web read them.
 */
export {
  EVENT_PREFIX,
  encodeEventLine,
  parseEventLine,
  silent,
  type Emit,
  type OperationEvent,
} from "@starkeep/admin-installer/operations/events";
