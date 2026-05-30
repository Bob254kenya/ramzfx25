export {
  buildAuthorizationUrl,
  buildSignUpUrl,
  buildLegacyOAuthUrl,
  initiateLogin,
  initiateSignUp,
  parseCallbackParams,
  validateCallback,
  exchangeCodeForTokens,
  refreshAccessToken,
  handleOAuthCallback,
  cleanupUrl,
  OAuthError,
} from './oauth';

export {
  fetchRestAccounts,
  getWebSocketOTP,
  logout,
  identifyUserType,
} from './accounts';

export {
  generateRandomBase64url,
  sha256Base64url,
  base64urlEncode,
} from './crypto';

export {
  storeCSRFToken, getCSRFToken, clearCSRFToken,
  storeCodeVerifier, getCodeVerifier, clearCodeVerifier,
  storeAuthInfo, getAuthInfo, clearAuthInfo,
  storeRestAccounts, getRestAccounts, clearRestAccounts,
  setActiveLoginId, getActiveLoginId,
  setAccountType, getAccountType,
  clearAllAuthData,
} from './storage';

export type {
  AuthConfig, AuthInfo, DerivRestAccount, DerivTokenAccount,
  OTPResponse, TokenExchangeParams, CallbackParams, AuthState,
  StoredCSRFToken, StoredCodeVerifier,
} from './types';
