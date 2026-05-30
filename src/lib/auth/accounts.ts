import type { AuthInfo, DerivRestAccount, OTPResponse } from './types';
import {
  storeRestAccounts, setActiveLoginId, setAccountType, clearAllAuthData,
} from './storage';

const API_BASE = 'https://api.derivws.com/trading/v1/options';

/**
 * Fetch the list of trading accounts for the authenticated user via REST API.
 * Identifies if user is new (no real account) or returning (has real account).
 */
export async function fetchRestAccounts(
  authInfo: AuthInfo,
  clientId: string
): Promise<DerivRestAccount[]> {
  const response = await fetch(`${API_BASE}/accounts`, {
    headers: {
      Authorization:  `Bearer ${authInfo.access_token}`,
      'Deriv-App-ID': clientId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch accounts (${response.status})`);
  }

  const data = await response.json();
  const accounts: DerivRestAccount[] = data.data;

  storeRestAccounts(accounts);

  if (accounts.length > 0) {
    // Prefer real account; fall back to first (demo)
    const realAccount = accounts.find(a => a.account_type === 'real') ?? accounts[0];
    setActiveLoginId(realAccount.account_id);
    setAccountType(realAccount.account_type);
  }

  return accounts;
}

/**
 * Get a one-time WebSocket URL for an authenticated account session.
 */
export async function getWebSocketOTP(
  accountId: string,
  authInfo: AuthInfo,
  clientId: string
): Promise<string> {
  const response = await fetch(`${API_BASE}/accounts/${accountId}/otp`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${authInfo.access_token}`,
      'Deriv-App-ID': clientId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get WebSocket OTP (${response.status})`);
  }

  const data: OTPResponse = await response.json();
  return data.data.url;
}

/**
 * Logout: clear all stored auth data.
 */
export function logout(): void {
  clearAllAuthData();
}

/**
 * Determine if the user is new (no real account) or returning (has real account).
 * Returns 'new' if only demo accounts, 'returning' otherwise.
 */
export function identifyUserType(accounts: DerivRestAccount[]): 'new' | 'returning' {
  const hasReal = accounts.some(a => a.account_type === 'real');
  return hasReal ? 'returning' : 'new';
}
