import { ApiError } from './http';

export interface RegistrationEnv { PLAYER_REGISTRATION?: string }
export type RegistrationPolicy = 'open' | 'invitation' | 'closed';

/** Existing installations retain invitation-only enrollment until configured. */
export function registrationPolicy(env: RegistrationEnv): RegistrationPolicy {
  const value = env.PLAYER_REGISTRATION ?? 'invitation';
  if (value !== 'open' && value !== 'invitation' && value !== 'closed') {
    throw new ApiError(503, 'registration_not_configured');
  }
  return value;
}
