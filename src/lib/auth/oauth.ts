import type { AuthConfig, AuthInfo, CallbackParams, TokenExchangeParams } from './types';
import { generateRandomBase64url, sha256Base64url } from './crypto';
import {
  storeCSRFToken, getCSRFToken, clearCSRFToken,
  storeCodeVerifier, getCodeVerifier, clearCodeVerifier,
  storeAuthInfo, clearAllAuthData,
} from './storage';

const AUTH_BASE = 'https://oauth.deriv.com/oauth2';
const TOKEN_URL = `${AUTH_BASE}/token`;

/**
 * Build PKCE URLSearchParams and store CSRF + code verifier in sessionStorage.
 */
async function buildPkceParams(config: AuthConfig): Promise<URLSearchParams> {
  const csrfToken    = generateRandomBase64url(32);
  const codeVerifier = generateRandomBase64url(32);
  const codeChallenge = await sha256Base64url(codeVerifier);

  storeCSRFToken(csrfToken);
  storeCodeVerifier(codeVerifier);

  return new URLSearchParams({
    scope:                 config.scopes ?? 'read trade trading_information payments admin',
    response_type:         'code',
    client_id:             config.clientId,
    redirect_uri:          config.redirectUri,
    state:                 csrfToken,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });
}

/**
 * Build the OAuth2 PKCE login URL.
 */
export async function buildAuthorizationUrl(config: AuthConfig): Promise<string> {
  const params = await buildPkceParams(config);
  return `${AUTH_BASE}/auth?${params.toString()}`;
}

/**
 * Build the OAuth2 PKCE sign-up URL (adds prompt=registration).
 */
export async function buildSignUpUrl(config: AuthConfig): Promise<string> {
  const params = await buildPkceParams(config);
  params.set('prompt', 'registration');
  return `${AUTH_BASE}/auth?${params.toString()}`;
}

/**
 * Build legacy token-based OAuth URL (no client_id needed).
 * Used when VITE_CLIENT_ID is not set.
 */
export function buildLegacyOAuthUrl(appId: number): string {
  const redirectUri = encodeURIComponent(window.location.origin);
  return `https://oauth.deriv.com/oauth2/authorize?app_id=${appId}&redirect_uri=${redirectUri}`;
}

/** Initiate login (PKCE or legacy). */
export async function initiateLogin(config: AuthConfig): Promise<void> {
  if (config.clientId) {
    window.location.href = await buildAuthorizationUrl(config);
  } else {
    window.location.href = buildLegacyOAuthUrl(config.appId);
  }
}

/** Initiate sign-up (PKCE only — requires client_id). */
export async function initiateSignUp(config: AuthConfig): Promise<void> {
  if (config.clientId) {
    window.location.href = await buildSignUpUrl(config);
  } else {
    // Fall back to login when no client_id (sign-up page not available in legacy flow)
    window.location.href = buildLegacyOAuthUrl(config.appId);
  }
}

/** Parse ?code=&state= callback params. */
export function parseCallbackParams(url: string): CallbackParams {
  const u = new URL(url);
  return {
    code:              u.searchParams.get('code'),
    state:             u.searchParams.get('state'),
    scope:             u.searchParams.get('scope'),
    error:             u.searchParams.get('error'),
    error_description: u.searchParams.get('error_description'),
  };
}

/** Validate CSRF and extract auth code. Throws OAuthError on failure. */
export function validateCallback(params: CallbackParams, redirectUri: string): string {
  if (params.error) {
    cleanupUrl(redirectUri);
    throw new OAuthError(`OAuth error: ${params.error} - ${params.error_description ?? ''}`);
  }

  if (!params.state) {
    clearAllAuthData();
    cleanupUrl(redirectUri);
    throw new OAuthError('Missing state parameter — possible CSRF attack');
  }

  const storedToken = getCSRFToken();
  if (!storedToken || storedToken !== params.state) {
    clearAllAuthData();
    cleanupUrl(redirectUri);
    throw new OAuthError('CSRF token mismatch — possible CSRF attack');
  }

  clearCSRFToken();

  if (!params.code) throw new OAuthError('Missing authorization code');
  return params.code;
}

/** Exchange authorization code for access + refresh tokens. */
export async function exchangeCodeForTokens(params: TokenExchangeParams): Promise<AuthInfo> {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code:          params.code,
    client_id:     params.clientId,
    redirect_uri:  params.redirectUri,
    code_verifier: params.codeVerifier,
  });

  const response = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new OAuthError(`Token exchange failed (${response.status}): ${err}`);
  }

  const tokenData = await response.json();
  const authInfo: AuthInfo = {
    access_token: tokenData.access_token,
    token_type:   tokenData.token_type,
    expires_in:   tokenData.expires_in,
    expires_at:   tokenData.expires_at ?? Math.floor(Date.now() / 1000) + tokenData.expires_in,
    scope:        tokenData.scope,
    refresh_token: tokenData.refresh_token,
  };

  storeAuthInfo(authInfo);
  clearCodeVerifier();
  return authInfo;
}

/** Refresh an expired access token using the refresh token. */
export async function refreshAccessToken(refreshToken: string, clientId: string): Promise<AuthInfo> {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     clientId,
  });

  const response = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  if (!response.ok) {
    clearAllAuthData();
    throw new OAuthError(`Token refresh failed (${response.status})`);
  }

  const tokenData = await response.json();
  const authInfo: AuthInfo = {
    access_token:  tokenData.access_token,
    token_type:    tokenData.token_type,
    expires_in:    tokenData.expires_in,
    expires_at:    tokenData.expires_at ?? Math.floor(Date.now() / 1000) + tokenData.expires_in,
    scope:         tokenData.scope,
    refresh_token: tokenData.refresh_token,
  };

  storeAuthInfo(authInfo);
  return authInfo;
}

/**
 * Full PKCE callback handler: validate → exchange → store → return AuthInfo.
 */
export async function handleOAuthCallback(callbackUrl: string, config: AuthConfig): Promise<AuthInfo> {
  const params      = parseCallbackParams(callbackUrl);
  const code        = validateCallback(params, config.redirectUri);
  const codeVerifier = getCodeVerifier();

  if (!codeVerifier) throw new OAuthError('Code verifier expired or missing');

  const authInfo = await exchangeCodeForTokens({
    code,
    clientId:     config.clientId,
    redirectUri:  config.redirectUri,
    codeVerifier,
  });

  cleanupUrl(config.redirectUri);
  return authInfo;
}

/** Remove OAuth params from the address bar. */
export function cleanupUrl(baseUrl: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  ['code', 'state', 'scope', 'error', 'error_description'].forEach(p => url.searchParams.delete(p));
  window.history.replaceState(window.history.state, '', url.pathname + url.search);
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}
