export interface HLCTimestamp {
  readonly wallTime: number;
  readonly counter: number;
  readonly nodeId: string;
}

export interface HLCClock {
  now(): HLCTimestamp;
  send(): HLCTimestamp;
  receive(remote: HLCTimestamp): HLCTimestamp;
}
