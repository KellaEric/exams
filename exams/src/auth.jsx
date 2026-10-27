import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setCsrf } from './api.js';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, perms: new Set(), mfaSetup: false });
  const apply = (d) => { setCsrf(d?.csrf || null); setState({ loading: false, user: d?.user || null, perms: new Set(d?.permissions || []), mfaSetup: !!d?.mfa_setup_required }); };
  useEffect(() => { api.get('/api/auth/me').then(apply).catch(() => apply(null)); }, []);
  const login = useCallback(async (email, password, mfa_code) => { const d = await api.post('/api/auth/login', { email, password, mfa_code: mfa_code || undefined }); apply(d); return d; }, []);
  const logout = useCallback(async () => { try { await api.post('/api/auth/logout'); } finally { apply(null); } }, []);
  const can = useCallback((p) => state.perms.has(p), [state.perms]);
  return <Ctx.Provider value={{ ...state, login, logout, can, isStudent: state.user?.role_key === 'student', isStaff: !!state.user && state.user.role_key !== 'student' }}>{children}</Ctx.Provider>;
}
