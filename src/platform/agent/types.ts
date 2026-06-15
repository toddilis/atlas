import type { EventType, AppendedEvent } from '../events/types.js';

export type AgentKind = 'worker' | 'analytical' | 'orchestrator';

export interface AgentDefinition {
  name: string;                                          // 'controller'
  domain: string;                                        // 'finance'
  kind: AgentKind;
  description?: string;
  /** Event types the agent subscribes to. */
  triggers: EventType[];
  /** Tool names from the registry the agent will use. Granted in `tool_grants`. */
  tools: string[];
  /** Canonical read-models the agent reads from. Used for documentation + future RLS scoping. */
  readScope: string[];
  /** Handler invoked when a subscribed event is dispatched. */
  onEvent(event: AppendedEvent): Promise<void>;
}
