declare global {
  // Used by AgentLoop to expose an abort handle to the outer process SIGINT handler.
  var __korinfraAgentAbort: (() => void) | undefined;
}

export {};
