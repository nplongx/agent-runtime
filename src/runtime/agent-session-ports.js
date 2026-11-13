/** Versioned host contracts required by the Agent Session persistence owner. */
export const AGENT_SESSION_WORKFLOW_PORT_VERSION = 1;
export const AGENT_SESSION_WORKFLOW_PORT_KIND = 'agent-session-workflow-port';
export const AGENT_SESSION_WORKFLOW_PORT_METHODS = Object.freeze([
  'assertSharedConnection',
  'getTask',
  'lockTaskForAgentSession',
  'recordEvent',
  'getEvent',
  'listEventsForJob',
  'countEventsForJobType',
  'listTasksWithOpenClawSession'
]);

export const AGENT_SESSION_DELIVERY_PORT_VERSION = 1;
export const AGENT_SESSION_DELIVERY_PORT_KIND = 'agent-session-delivery-port';
export const AGENT_SESSION_DELIVERY_PORT_METHODS = Object.freeze([
  'ackSessionMessage',
  'markSessionMessageDeliveryUncertain',
  'retrySessionMessage',
  'recordSessionDeliveryReceipt'
]);

function bindPort(implementation, methods, kind, version, label) {
  if (!implementation || typeof implementation !== 'object') {
    throw new TypeError(`${label} implementation is required`);
  }
  const port = { kind, version };
  for (const method of methods) {
    if (typeof implementation[method] !== 'function') {
      throw new TypeError(`${label} must provide ${method}()`);
    }
    Object.defineProperty(port, method, {
      enumerable: true,
      configurable: false,
      writable: false,
      value: implementation[method].bind(implementation)
    });
  }
  return Object.freeze(port);
}

function assertPort(port, methods, kind, version, label) {
  if (!port || typeof port !== 'object' || port.kind !== kind || port.version !== version ||
      !Object.isFrozen(port) || Object.hasOwn(port, 'db') || Object.hasOwn(port, 'database') ||
      typeof port.transaction === 'function' || typeof port.exec === 'function' || typeof port.prepare === 'function') {
    throw new TypeError(`${label} must be a frozen versioned contract without a database handle or transaction controls`);
  }
  for (const method of methods) {
    if (typeof port[method] !== 'function') throw new TypeError(`${label} must provide ${method}()`);
  }
  return port;
}

export function createAgentSessionWorkflowPort(implementation) {
  return bindPort(implementation, AGENT_SESSION_WORKFLOW_PORT_METHODS,
    AGENT_SESSION_WORKFLOW_PORT_KIND, AGENT_SESSION_WORKFLOW_PORT_VERSION,
    'Agent Session Workflow Port v1');
}

export function assertAgentSessionWorkflowPort(port) {
  return assertPort(port, AGENT_SESSION_WORKFLOW_PORT_METHODS,
    AGENT_SESSION_WORKFLOW_PORT_KIND, AGENT_SESSION_WORKFLOW_PORT_VERSION,
    'Agent Session Workflow Port v1');
}

export function createAgentSessionDeliveryPort(implementation) {
  return bindPort(implementation, AGENT_SESSION_DELIVERY_PORT_METHODS,
    AGENT_SESSION_DELIVERY_PORT_KIND, AGENT_SESSION_DELIVERY_PORT_VERSION,
    'Agent Session Delivery Port v1');
}

export function assertAgentSessionDeliveryPort(port) {
  return assertPort(port, AGENT_SESSION_DELIVERY_PORT_METHODS,
    AGENT_SESSION_DELIVERY_PORT_KIND, AGENT_SESSION_DELIVERY_PORT_VERSION,
    'Agent Session Delivery Port v1');
}
