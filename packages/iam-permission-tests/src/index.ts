export { parseTfTrace, type CapturedCall, type ParseResult } from "./parse-tf-trace";
export { simulateCalls, type SimulationOutcome, type Verdict } from "./simulate";
export {
  buildContext,
  listContexts,
  type IamContext,
  type ContextInput,
  type PolicyDoc,
} from "./contexts";
