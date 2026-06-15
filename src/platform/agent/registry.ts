import { supabase, orgId } from '../../data/supabase.js';
import { registerProjector } from '../events/projector.js';
import { log } from '../log.js';
import type { AgentDefinition } from './types.js';

const registered: Map<string, AgentDefinition> = new Map();

/**
 * Register an agent in-process: wire its triggers into the projection dispatcher and upsert
 * the registry row in `agents`. Idempotent — re-registering the same name is allowed.
 */
export async function registerAgent(def: AgentDefinition): Promise<void> {
  registered.set(def.name, def);

  const sb = supabase();
  const { error } = await sb
    .from('agents')
    .upsert(
      {
        org_id: orgId(),
        name: def.name,
        domain: def.domain,
        kind: def.kind,
        description: def.description ?? null,
        enabled: true,
      },
      { onConflict: 'org_id,name' },
    );
  if (error) throw error;

  for (const trigger of def.triggers) {
    registerProjector(trigger, async (event) => {
      try {
        await def.onEvent(event);
      } catch (e) {
        log.error('agent.handler_failed', {
          agent: def.name,
          type: event.type,
          seq: event.seq,
          error: (e as Error).message,
        });
        throw e;
      }
    });
  }

  log.info('agent.registered', { name: def.name, triggers: def.triggers });
}

export function listRegisteredAgents(): AgentDefinition[] {
  return Array.from(registered.values());
}
