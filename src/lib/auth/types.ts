export interface AuthConfig {
  clientId: string;
  redirectUri: string;
  appId: number;
  /** OAuth scopes as a space-separated string. Defaults to 'trade account_manage' */
  scopes?: string;
}

export interface AuthInfo {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  scope: string;
  refresh_token: string;
}

/** Deriv account from the new REST API */
export interface DerivRestAccount {
  account_id: string;
  account_type: 'demo' | 'real';
  currency: string;
  balance: string;
  group: string;
  status: string;
}

/** Legacy token-based account (from acct1/token1/cur1 params) */
export interface DerivTokenAccount {
  loginid: string;
  token: string;
  currency: string;
  is_virtual: boolean;
}

export interface OTPResponse {
  data: { url: string };
}

export interface TokenExchangeParams {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface CallbackParams {
  code?: string | null;
  state?: string | null;
  scope?: string | null;
  error?: string | null;
  error_description?: string | null;
}

export type AuthState = 'unauthenticated' | 'authenticating' | 'authenticated' | 'error';

export interface StoredCSRFToken {
  value: string;
  createdAt: number;
}

export interface StoredCodeVerifier {
  value: string;
  createdAt: number;
}
