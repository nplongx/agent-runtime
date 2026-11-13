import { AgentSessionStore } from './agent-session-store.js';
import {
  AGENT_SESSION_API_VERSION,
  AGENT_SESSION_DELIVERY_HOOKS,
  createAgentSessionApi,
  createAgentSessionPort,
  createAgentSessionLifecycleParticipant
} from './agent-session-api.js';
import {
  assertAgentSessionWorkflowPort,
  createAgentSessionWorkflowPort
} from './agent-session-ports.js';

export const AGENT_SESSION_RUNTIME_VERSION = 1;

/**
 * Compose the Agent Session persistence owner with host-owned Workflow APIs.
 * The database connection is supplied by the host and must be the same object
 * used by Workflow so row/event transitions remain atomic.
 */
export function createAgentSessionRuntime({ database, workflowPort } = {}) {
  if (!database || typeof database.exec !== 'function' || typeof database.prepare !== 'function') {
    throw new TypeError('createAgentSessionRuntime requires a SQLite-compatible database connection');
  }
  const hostWorkflowPort = workflowPort?.kind === 'agent-session-workflow-port' &&
    workflowPort.version === 1 && Object.isFrozen(workflowPort)
    ? assertAgentSessionWorkflowPort(workflowPort)
    : createAgentSessionWorkflowPort(workflowPort);
  if (hostWorkflowPort.assertSharedConnection(database) !== true) {
    throw new TypeError('Agent Session Workflow Port must confirm the exact injected SQLite connection');
  }

  // These callbacks preserve the existing host compatibility facade: delivery
  // orchestration re-enters the same AgentSessionStore's durable receipt/ACK/
  // uncertainty/retry operations. They are not external host authority.
  let store;
  const deliveryHooks = Object.freeze(Object.fromEntries(AGENT_SESSION_DELIVERY_HOOKS.map(method => [
    method,
    (...args) => {
      if (!store) throw new Error(`Agent Session delivery hook used before store initialization: ${method}`);
      return store[method](...args);
    }
  ])));

  store = new AgentSessionStore({
    database,
    workflowPort: hostWorkflowPort,
    deliveryHooks: Object.freeze({
      kind: 'agent-session-delivery-port',
      version: 1,
      ...deliveryHooks
    })
  });
  const domainPort = createAgentSessionPort(store);
  const lifecycleParticipant = createAgentSessionLifecycleParticipant(store);
  return Object.freeze({
    version: AGENT_SESSION_RUNTIME_VERSION,
    api: createAgentSessionApi(domainPort),
    lifecycleParticipant
  });
}
