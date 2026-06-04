/**
 * Voice Operator Agent barrel (M10).
 *
 * Public surface used by the supervisor + tests. The agent consumes
 * VOICE.CALL_SCHEDULED and originates outbound calls via Asterisk ARI.
 */
export { VoiceOperatorAgent, type VoiceOperatorConfig } from './agent.js';
export {
  registerVoiceOperatorClass,
  __resetVoiceOperatorRegistrationForTests,
} from './register.js';
