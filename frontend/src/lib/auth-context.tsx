import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  name: string | null;
  merchantId: string | null;
};

type AuthContextValue = {
  accessToken: string | null;
  user: AuthUser | null;
  isReady: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    name: string;
    role: "customer" | "merchant_admin";
  }) => Promise<void>;
  logout: () => Promise<void>;
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; fields?: Record<string, string> };
    if (body.fields) {
      return Object.values(body.fields)[0] ?? body.error ?? "Request failed";
    }
    return body.error ?? "Request failed";
  } catch {
    return "Request failed";
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isReady, setIsReady] = useState(false);

  const loadMe = useCallback(async (token: string) => {
    const response = await fetch(`${API_BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error("session expired");
    }
    const body = (await response.json()) as { user: AuthUser };
    setUser(body.user);
  }, []);

  const refreshSession = useCallback(async (): Promise<string | null> => {
    const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });
    if (!response.ok) {
      setAccessToken(null);
      setUser(null);
      return null;
    }
    const body = (await response.json()) as { accessToken: string };
    setAccessToken(body.accessToken);
    await loadMe(body.accessToken);
    return body.accessToken;
  }, [loadMe]);

  useEffect(() => {
    void refreshSession().finally(() => setIsReady(true));
  }, [refreshSession]);

  const login = useCallback(
    async (email: string, password: string) => {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        throw new Error(await parseError(response));
      }
      const body = (await response.json()) as { accessToken: string; user: AuthUser };
      setAccessToken(body.accessToken);
      setUser(body.user);
    },
    [],
  );

  const register = useCallback(
    async (input: {
      email: string;
      password: string;
      name: string;
      role: "customer" | "merchant_admin";
    }) => {
      const response = await fetch(`${API_BASE_URL}/auth/register`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error(await parseError(response));
      }
      const body = (await response.json()) as { accessToken: string; user: AuthUser };
      setAccessToken(body.accessToken);
      setUser(body.user);
    },
    [],
  );

  const logout = useCallback(async () => {
    if (accessToken) {
      await fetch(`${API_BASE_URL}/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    }
    setAccessToken(null);
    setUser(null);
  }, [accessToken]);

  const authFetch = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (accessToken) {
        headers.set("Authorization", `Bearer ${accessToken}`);
      }

      let response = await fetch(`${API_BASE_URL}${path}`, {
        ...init,
        credentials: "include",
        headers,
      });

      if (response.status === 401) {
        const nextToken = await refreshSession();
        if (!nextToken) {
          return response;
        }
        headers.set("Authorization", `Bearer ${nextToken}`);
        response = await fetch(`${API_BASE_URL}${path}`, {
          ...init,
          credentials: "include",
          headers,
        });
      }

      return response;
    },
    [accessToken, refreshSession],
  );

  const value = useMemo(
    () => ({ accessToken, user, isReady, login, register, logout, authFetch }),
    [accessToken, user, isReady, login, register, logout, authFetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
