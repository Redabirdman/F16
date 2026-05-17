/**
 * Sales Agent barrel — exposes the placeholder class (M5.T4) and the class
 * registration helper. M6 will replace the agent body without changing this
 * surface.
 */
export { SalesAgent } from './agent.js';
export { registerSalesAgentClass, __resetSalesAgentRegistrationForTests } from './register.js';
