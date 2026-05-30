import React, {
  createContext, useContext, useState, useEffect,
  useCallback, useRef, useMemo,
} from "react";

import {
  derivApi,
  parseOAuthRedirect,
  getAppId,
  getClientId,
  type DerivAccount as LegacyDerivAccount,
  type AuthorizeResponse,
} from "@/services/deriv-api";

import {
  initiateLogin,
  initiateSignUp,
  handleOAuthCallback,
  refreshAccessToken,
  fetchRestAccounts,
  getWebSocketOTP,
  logout as authLogout,
  getAuthInfo,
  getRestAccounts,
  getActiveLoginId,
  setActiveLoginId,
  setAccountType,
  clearAllAuthData,
  identifyUserType,
  type AuthInfo,
  type DerivRestAccount,
  type AuthState,
} from "@/lib/auth";

import { useNavigate, useLocation } from "react-router-dom";

// ─── Auth mode: new PKCE or legacy token flow ────────────────────────────────
function getAuthMode(): 'pkce' | 'legacy' {
  return getClientId() ? 'pkce' : 'legacy';
}

function getAuthConfig() {
  return {
    clientId:    getClientId(),
    redirectUri: typeof window !== 'undefined' ? window.location.origin : '',
    appId:       getAppId(),
    scopes:      'read trade trading_information payments admin',
  };
}

// ─── Filter out CRW / VRW wallet accounts (legacy flow) ─────────────────────
const filterAllowedLegacy = (accounts: LegacyDerivAccount[]): LegacyDerivAccount[] =>
  accounts.filter(a => {
    const id = a.loginid.toUpperCase();
    return !id.startsWith('CRW') && !id.startsWith('VRW');
  });

// ─── Context shape ───────────────────────────────────────────────────────────
interface AuthContextValue {
  isAuthorized:    boolean;
  isLoading:       boolean;
  authState:       AuthState;
  userType:        'new' | 'returning' | null;
  // PKCE accounts
  restAccounts:    DerivRestAccount[];
  activeRestAccount: DerivRestAccount | null;
  // Legacy accounts (also used for WS after PKCE)
  accounts:        LegacyDerivAccount[];
  activeAccount:   LegacyDerivAccount | null;
  accountInfo:     AuthorizeResponse["authorize"] | null;
  balance:         number;
  currency:        string;
  appId:           number;
  clientId:        string;
  authMode:        'pkce' | 'legacy';
  login:           () => Promise<void>;
  signUp:          () => Promise<void>;
  logout:          () => void;
  switchAccount:   (loginid: string) => Promise<void>;
  updateCredentials: (appId: string, clientId: string) => void;
  refreshBalance:  () => Promise<void>;
  error:           string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// ─── Provider ────────────────────────────────────────────────────────────────
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthorized, setIsAuthorized]     = useState(false);
  const [isLoading,    setIsLoading]        = useState(true);
  const [authState,    setAuthState]        = useState<AuthState>('unauthenticated');
  const [userType,     setUserType]         = useState<'new' | 'returning' | null>(null);
  const [error,        setError]            = useState<string | null>(null);

  // PKCE state
  const [restAccounts,      setRestAccounts]      = useState<DerivRestAccount[]>([]);
  const [activeRestAccount, setActiveRestAccount] = useState<DerivRestAccount | null>(null);
  const [wsUrl,             setWsUrl]             = useState<string | undefined>(undefined);

  // Legacy WS state (also used after PKCE to authorize WS)
  const [accounts,     setAccounts]     = useState<LegacyDerivAccount[]>([]);
  const [activeAccount, setActiveAccount] = useState<LegacyDerivAccount | null>(null);
  const [accountInfo,  setAccountInfo]  = useState<AuthorizeResponse["authorize"] | null>(null);
  const [balance,      setBalance]      = useState(0);
  const [currency,     setCurrency]     = useState('USD');
  const [appId,        setAppId]        = useState(getAppId);
  const [clientId,     setClientId]     = useState(getClientId);
  const [authMode,     setAuthMode]     = useState<'pkce' | 'legacy'>(getAuthMode);

  const location = useLocation();
  const navigate = useNavigate();

  const unsubscribeRef = useRef<null | (() => void)>(null);
  const authLock       = useRef(false);
  const initialized    = useRef(false);
  const activeAccountIdRef = useRef<string | null>(null);
  const tabHiddenAtRef     = useRef<number | null>(null);

  const cleanupSubscription = useCallback(() => {
    if (unsubscribeRef.current) { unsubscribeRef.current(); unsubscribeRef.current = null; }
  }, []);

  // ── Authorize a WS token (legacy or post-PKCE) ──────────────────────────
  const authorizeAccount = useCallback(async (account: LegacyDerivAccount) => {
    if (authLock.current) return;
    authLock.current = true;
    try {
      cleanupSubscription();
      const response = await derivApi.authorize(account.token);
      const auth = response.authorize;

      setAccountInfo(auth);
      setBalance(auth.balance ?? 0);
      setCurrency(auth.currency ?? 'USD');
      setActiveAccount(account);
      setIsAuthorized(true);
      setAuthState('authenticated');

      localStorage.setItem("last_active_loginid", account.loginid);

      await derivApi.getBalance();
      unsubscribeRef.current = derivApi.onMessage((data: any) => {
        if (data?.balance?.balance !== undefined) setBalance(data.balance.balance);
        if (data?.proposal_open_contract?.balance_after !== undefined)
          setBalance(data.proposal_open_contract.balance_after);
      });
    } catch (err) {
      console.error("WS authorize failed:", err);
      setIsAuthorized(false);
      setAuthState('error');
    } finally {
      authLock.current = false;
    }
  }, [cleanupSubscription]);

  // ── PKCE: fetch REST accounts + OTP → connect WS + authorize ──────────
  const completePkceAuth = useCallback(async (authInfo: AuthInfo) => {
    const config = getAuthConfig();
    const fetched = await fetchRestAccounts(authInfo, config.clientId);
    setRestAccounts(fetched);

    const type = identifyUserType(fetched);
    setUserType(type);

    if (fetched.length > 0) {
      const preferred = fetched.find(a => a.account_type === 'real') ?? fetched[0];
      setActiveRestAccount(preferred);
      activeAccountIdRef.current = preferred.account_id;

      // Get OTP WebSocket URL (authenticated, single-use)
      const otpUrl = await getWebSocketOTP(preferred.account_id, authInfo, config.clientId);
      setWsUrl(otpUrl);

      // Connect derivApi via the OTP URL — this gives an already-authenticated WS session
      // No authorize() call needed; the OTP URL carries the auth credentials
      try {
        await derivApi.connectWithUrl(otpUrl);
        // Get balance via WS (OTP session is pre-authorized)
        const balResp = await derivApi.getBalance();
        if (balResp?.balance?.balance !== undefined) {
          setBalance(balResp.balance.balance);
        }
        setCurrency(preferred.currency ?? 'USD');

        // Subscribe to live balance updates
        cleanupSubscription();
        unsubscribeRef.current = derivApi.onMessage((data: any) => {
          if (data?.balance?.balance !== undefined) setBalance(data.balance.balance);
          if (data?.proposal_open_contract?.balance_after !== undefined)
            setBalance(data.proposal_open_contract.balance_after);
        });
      } catch (err) {
        // WS connection failed — still mark authenticated (REST auth succeeded)
        console.warn('WS connect via OTP failed:', err);
      }

      setIsAuthorized(true);
      setAuthState('authenticated');
    }
  }, [cleanupSubscription]);

  // ── OTP refresh on tab focus (PKCE only) ────────────────────────────────
  const fetchOTPUrl = useCallback(async (accountId: string, authInfo: AuthInfo): Promise<string> => {
    return getWebSocketOTP(accountId, authInfo, getAuthConfig().clientId);
  }, []);

  useEffect(() => {
    if (authState !== 'authenticated' || authMode !== 'pkce') return;

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'hidden') {
        tabHiddenAtRef.current = Date.now();
        return;
      }
      const hiddenAt = tabHiddenAtRef.current;
      if (!hiddenAt || Date.now() - hiddenAt < 30_000) return;
      tabHiddenAtRef.current = null;

      const accountId = activeAccountIdRef.current;
      const storedAuth = getAuthInfo();
      if (!storedAuth || !accountId) return;

      try {
        const otpUrl = await fetchOTPUrl(accountId, storedAuth);
        setWsUrl(otpUrl);
        // Reconnect derivApi with the fresh OTP URL
        await derivApi.connectWithUrl(otpUrl);
        await derivApi.getBalance();
      } catch {
        clearAllAuthData();
        setAuthState('unauthenticated');
        setIsAuthorized(false);
        setWsUrl(undefined);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [authState, authMode, fetchOTPUrl]);

  // ── One-time init ────────────────────────────────────────────────────────
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    let cancelled = false;
    const mode = getAuthMode();
    setAuthMode(mode);

    const init = async () => {
      setIsLoading(true);
      try {
        const search = location.search;
        const urlParams = new URLSearchParams(search);

        // ── PKCE callback: ?code=...&state=... ─────────────────────────
        if (mode === 'pkce' && urlParams.has('code')) {
          setAuthState('authenticating');
          try {
            const authInfo = await handleOAuthCallback(window.location.href, getAuthConfig());
            if (!cancelled) {
              await completePkceAuth(authInfo);
              navigate("/", { replace: true });
            }
          } catch (err) {
            if (!cancelled) {
              const msg = err instanceof Error ? err.message : 'Authentication failed';
              setError(msg);
              setAuthState('error');
              clearAllAuthData();
            }
          }
          if (!cancelled) setIsLoading(false);
          return;
        }

        // ── Legacy callback: ?acct1=...&token1=...&cur1=... ────────────
        if (search.includes("acct1")) {
          const parsed = parseOAuthRedirect(search);
          if (parsed.length > 0 && !cancelled) {
            const allowed = filterAllowedLegacy(parsed);
            if (allowed.length === 0) { setIsLoading(false); return; }

            localStorage.setItem("deriv_accounts", JSON.stringify(allowed));
            setAccounts(allowed);
            setUserType('returning'); // legacy users always have existing accounts

            const saved = localStorage.getItem("last_active_loginid");
            const account = (saved && allowed.find(a => a.loginid === saved))
              ?? allowed.find(a => !a.is_virtual)
              ?? allowed[0];

            await authorizeAccount(account);
            if (!cancelled) navigate("/", { replace: true });
          }
          if (!cancelled) setIsLoading(false);
          return;
        }

        // ── PKCE: restore existing session ──────────────────────────────
        if (mode === 'pkce') {
          const storedAuth = getAuthInfo();
          if (storedAuth) {
            const isExpired = storedAuth.expires_at && Date.now() / 1000 > storedAuth.expires_at;
            if (isExpired) {
              try {
                const refreshed = await refreshAccessToken(storedAuth.refresh_token, getAuthConfig().clientId);
                if (!cancelled) await completePkceAuth(refreshed);
              } catch {
                clearAllAuthData();
                if (!cancelled) setAuthState('unauthenticated');
              }
            } else {
              const storedAccounts = getRestAccounts();
              if (storedAccounts && storedAccounts.length > 0) {
                setRestAccounts(storedAccounts);
                setUserType(identifyUserType(storedAccounts));
                const loginId = getActiveLoginId() ?? storedAccounts[0].account_id;
                const preferred = storedAccounts.find(a => a.account_id === loginId) ?? storedAccounts[0];
                setActiveRestAccount(preferred);
                activeAccountIdRef.current = preferred.account_id;

                try {
                  const otpUrl = await fetchOTPUrl(preferred.account_id, storedAuth);
                  if (!cancelled) {
                    setWsUrl(otpUrl);
                    setIsAuthorized(true);
                    setAuthState('authenticated');
                  }
                } catch {
                  clearAllAuthData();
                  if (!cancelled) setAuthState('unauthenticated');
                }
              } else {
                // Have auth token but no accounts — re-fetch
                try {
                  if (!cancelled) await completePkceAuth(storedAuth);
                } catch {
                  clearAllAuthData();
                  if (!cancelled) setAuthState('unauthenticated');
                }
              }
            }
          }
          if (!cancelled) setIsLoading(false);
          return;
        }

        // ── Legacy: restore existing session ────────────────────────────
        const stored = localStorage.getItem("deriv_accounts");
        if (stored) {
          const parsed: LegacyDerivAccount[] = JSON.parse(stored);
          const allowed = filterAllowedLegacy(parsed);
          if (allowed.length === 0) {
            localStorage.removeItem("deriv_accounts");
            if (!cancelled) setIsLoading(false);
            return;
          }
          setAccounts(allowed);
          setUserType('returning');
          const saved = localStorage.getItem("last_active_loginid");
          const account = (saved && allowed.find(a => a.loginid === saved))
            ?? allowed.find(a => !a.is_virtual)
            ?? allowed[0];
          await authorizeAccount(account);
        }
      } catch (err) {
        console.error("Init auth error:", err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    init();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupSubscription();
      derivApi.disconnect();
    };
  }, [cleanupSubscription]);

  // ── Public API ───────────────────────────────────────────────────────────
  const login = useCallback(async () => {
    await initiateLogin(getAuthConfig());
  }, []);

  const signUp = useCallback(async () => {
    await initiateSignUp(getAuthConfig());
  }, []);

  const logout = useCallback(() => {
    cleanupSubscription();
    derivApi.disconnect();
    authLogout();
    setIsAuthorized(false);
    setAuthState('unauthenticated');
    setUserType(null);
    setRestAccounts([]);
    setActiveRestAccount(null);
    setWsUrl(undefined);
    setAccounts([]);
    setActiveAccount(null);
    setAccountInfo(null);
    setBalance(0);
    setCurrency('USD');
    setError(null);
  }, [cleanupSubscription]);

  const switchAccount = useCallback(async (loginid: string) => {
    // PKCE mode: switch via REST account + new OTP
    if (authMode === 'pkce') {
      const storedAuth = getAuthInfo();
      if (!storedAuth) return;
      const account = restAccounts.find(a => a.account_id === loginid);
      if (!account) return;
      try {
        setAccountType(account.account_type);
        const otpUrl = await fetchOTPUrl(account.account_id, storedAuth);
        setActiveLoginId(account.account_id);
        activeAccountIdRef.current = account.account_id;
        setActiveRestAccount(account);
        setWsUrl(otpUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Account switch failed');
      }
      return;
    }
    // Legacy mode: re-authorize via WS token
    const account = accounts.find(a => a.loginid === loginid);
    if (!account) return;
    derivApi.disconnect();
    await authorizeAccount(account);
  }, [authMode, restAccounts, accounts, fetchOTPUrl, authorizeAccount]);

  const updateCredentials = useCallback((newAppId: string, newClientId: string) => {
    if (newAppId.trim())     localStorage.setItem('milliefx_app_id',    newAppId.trim());
    else                     localStorage.removeItem('milliefx_app_id');
    if (newClientId.trim())  localStorage.setItem('milliefx_client_id', newClientId.trim());
    else                     localStorage.removeItem('milliefx_client_id');

    setAppId(getAppId());
    setClientId(getClientId());
    setAuthMode(getAuthMode());

    if (isAuthorized && activeAccount) {
      derivApi.disconnect();
      authorizeAccount(activeAccount);
    }
  }, [isAuthorized, activeAccount, authorizeAccount]);

  // ── Refresh balance from WS ────────────────────────────────────────────────
  const refreshBalance = useCallback(async () => {
    try {
      const resp = await derivApi.getBalance();
      if (resp?.balance?.balance !== undefined) setBalance(resp.balance.balance);
    } catch (err) {
      console.warn('refreshBalance failed:', err);
    }
  }, []);

  // ── For PKCE mode: synthesise a legacy-shaped activeAccount from REST data ──
  // All pages (Dashboard, Settings, Sidebar) use activeAccount.loginid / .is_virtual / .currency
  // In PKCE mode we don't have those from WS; we map from DerivRestAccount instead.
  const computedActiveAccount = useMemo<LegacyDerivAccount | null>(() => {
    if (authMode === 'legacy') return activeAccount;
    if (!activeRestAccount) return null;
    return {
      loginid:    activeRestAccount.account_id,
      token:      '', // not used in PKCE mode
      currency:   activeRestAccount.currency,
      is_virtual: activeRestAccount.account_type === 'demo',
    };
  }, [authMode, activeAccount, activeRestAccount]);

  const value = useMemo<AuthContextValue>(() => ({
    isAuthorized, isLoading, authState, userType, error,
    restAccounts, activeRestAccount,
    accounts, activeAccount: computedActiveAccount, accountInfo,
    balance, currency, appId, clientId, authMode,
    login, signUp, logout, switchAccount, updateCredentials, refreshBalance,
  }), [
    isAuthorized, isLoading, authState, userType, error,
    restAccounts, activeRestAccount,
    accounts, computedActiveAccount, accountInfo,
    balance, currency, appId, clientId, authMode,
    login, signUp, logout, switchAccount, updateCredentials, refreshBalance,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
