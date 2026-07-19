import React, { useState, useEffect } from 'react';
import axios from 'axios';

// Add type safety for Electron context bridge
declare global {
  interface Window {
    api: {
      startTracking: (token: string, apiUrl?: string, refreshToken?: string) => Promise<{ success: boolean; error?: string }>;
      stopTracking: () => Promise<{ success: boolean }>;
      getStatus: () => Promise<{ isTracking: boolean; uninstallAllowed?: boolean }>;
      logout: () => Promise<{ success: boolean }>;
      hideWindow: () => void;
      minimizeWindow: () => void;
      reportMouseEvent: () => void;
      reportKeyEvent: () => void;
      onSessionExpired: (callback: () => void) => () => void;
      onSyncStatus: (callback: (data: { pendingCount: number }) => void) => () => void;
      onUpdaterAvailable: (callback: () => void) => () => void;
      onUpdaterReady: (callback: () => void) => () => void;
    };
  }
}

const App: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isTrackingActive, setIsTrackingActive] = useState(false);
  const [userEmail, setUserEmail] = useState('');
  const [userRole, setUserRole] = useState('');
  const [uninstallAllowed, setUninstallAllowed] = useState(true);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [updaterMsg, setUpdaterMsg] = useState('');

  const [elapsedTime, setElapsedTime] = useState(0);

  // Helper to get today's date key: e.g. "tracked_seconds_2026-07-20_employee@email.com"
  const getTodayKey = (emailStr: string) => {
    if (!emailStr) return '';
    const dateStr = new Date().toISOString().split('T')[0];
    return `tracked_seconds_${dateStr}_${emailStr.toLowerCase()}`;
  };

  // Restore today's accumulated tracking seconds whenever userEmail changes or app mounts
  useEffect(() => {
    if (userEmail) {
      const key = getTodayKey(userEmail);
      const savedSeconds = localStorage.getItem(key);
      if (savedSeconds) {
        setElapsedTime(parseInt(savedSeconds, 10) || 0);
      } else {
        setElapsedTime(0);
      }
    }
  }, [userEmail]);

  // Timer tick effect: increments elapsedTime every second & persists to today's date key
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isTrackingActive) {
      timer = setInterval(() => {
        setElapsedTime((prev) => {
          const next = prev + 1;
          if (userEmail) {
            const key = getTodayKey(userEmail);
            if (key) {
              localStorage.setItem(key, String(next));
            }
          }
          return next;
        });
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isTrackingActive, userEmail]);

  const formatTime = (totalSeconds: number) => {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  useEffect(() => {
    // Read stored session first so role is available before async getStatus() resolves
    const storedEmail = localStorage.getItem('agent_user_email');
    const storedRole = localStorage.getItem('agent_user_role') || '';
    const storedAllowed = localStorage.getItem('agent_user_uninstall_allowed') !== 'false';
    if (storedEmail) {
      setUserEmail(storedEmail);
      setUserRole(storedRole);
      setUninstallAllowed(storedAllowed);
      setIsAuthenticated(true);
    }

    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

    // Check tracking/policy status from main process
    window.api.getStatus().then(async (status: any) => {
      setIsTrackingActive(status.isTracking);
      if (status.uninstallAllowed !== undefined) {
        // Only restrict sign-out for EMPLOYEEs; admins/managers always keep it enabled
        const role = localStorage.getItem('agent_user_role') || '';
        const allowed = role !== 'EMPLOYEE' ? true : status.uninstallAllowed;
        setUninstallAllowed(allowed);
        localStorage.setItem('agent_user_uninstall_allowed', String(allowed));
      }

      // If user session is active in UI but background tracker is not running, try to resume it
      if (storedEmail && !status.isTracking) {
        const res = await window.api.startTracking('', apiUrl);
        if (res.success) {
          setIsTrackingActive(true);
        } else {
          // No valid credentials in main process token store — force logout to show login screen
          handleLogout();
          setError('Please log in to start activity tracking.');
        }
      }
    });

    // Forward mouse & keyboard events from the renderer window to the main process.
    // Throttled so we don't flood IPC — at most one report per 500ms per event type.
    let mouseThrottle = false;
    let keyThrottle = false;

    const onMouseMove = () => {
      if (mouseThrottle) return;
      mouseThrottle = true;
      window.api.reportMouseEvent();
      setTimeout(() => { mouseThrottle = false; }, 500);
    };

    const onKeyDown = () => {
      if (keyThrottle) return;
      keyThrottle = true;
      window.api.reportKeyEvent();
      setTimeout(() => { keyThrottle = false; }, 500);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseMove);
    window.addEventListener('keydown', onKeyDown);

    // Subscribe to sync queue count updates
    const unsubscribeSync = window.api.onSyncStatus((data) => {
      setPendingSyncCount(data.pendingCount);
    });

    // Subscribe to session expiration events
    const unsubscribeSession = window.api.onSessionExpired(() => {
      handleLogout();
      setError('Your session has expired. Please log in again.');
    });

    // Auto-update event listeners
    const unsubscribeAvailable = window.api.onUpdaterAvailable(() => {
      setUpdaterMsg('Downloading new update...');
    });

    const unsubscribeReady = window.api.onUpdaterReady(() => {
      setUpdaterMsg('New version ready! Restart app to install.');
    });

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseMove);
      window.removeEventListener('keydown', onKeyDown);
      unsubscribeSync();
      unsubscribeSession();
      unsubscribeAvailable();
      unsubscribeReady();
    };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Authenticate with remote-desk-backend
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
      const res = await axios.post(`${apiUrl}/auth/login`, {
        email,
        password,
      });

      const { accessToken, refreshToken, user } = res.data;
      const role = user?.role;
      // Non-EMPLOYEE roles (ADMIN/MANAGER) always have sign-out access
      const allowed = role !== 'EMPLOYEE' ? true : (user?.uninstallAllowed ?? false);

      if (role !== 'EMPLOYEE' && role !== 'ADMIN' && role !== 'MANAGER') {
        throw new Error('Only company users can run the desktop agent.');
      }

      localStorage.setItem('agent_user_email', email);
      localStorage.setItem('agent_user_role', role || '');
      localStorage.setItem('agent_user_uninstall_allowed', String(allowed));
      setUserEmail(email);
      setUserRole(role);
      setUninstallAllowed(allowed);
      setIsAuthenticated(true);

      // Start background tracking with the newly verified JWT and refresh token
      const trackRes = await window.api.startTracking(accessToken, apiUrl, refreshToken);
      if (trackRes.success) {
        setIsTrackingActive(true);
      } else {
        setError(trackRes.error || 'Failed to initialize native tracking.');
      }
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message || 'Login failed.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleTracking = async () => {
    if (isTrackingActive) {
      const res = await window.api.stopTracking();
      if (res.success) setIsTrackingActive(false);
    } else {
      // Fetch token or request password. For simplicity in UI, we fetch from keytar inside main
      // Let's call start-tracking again. Main will reuse the current keychain token.
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
      const res = await window.api.startTracking('', apiUrl);
      if (res.success) {
        setIsTrackingActive(true);
      } else {
        setError(res.error || 'Failed to resume tracking. Please log in again.');
        handleLogout();
      }
    }
  };

  const handleLogout = async () => {
    await window.api.logout();
    localStorage.removeItem('agent_user_email');
    localStorage.removeItem('agent_user_role');
    localStorage.removeItem('agent_user_uninstall_allowed');
    setIsAuthenticated(false);
    setIsTrackingActive(false);
    setElapsedTime(0);
    setUninstallAllowed(true);
    setUserRole('');
    setEmail('');
    setPassword('');
    setError('');
  };

  return (
    <>
      <div className="titlebar">
        <span className="titlebar-title">Remote Desk Agent</span>
        <div className="titlebar-controls">
          <button className="titlebar-btn" onClick={() => window.api.minimizeWindow()}>−</button>
          <button className="titlebar-btn close" onClick={() => window.api.hideWindow()}>×</button>
        </div>
      </div>

      <div className="app-container">
        <div className="liquid-backlight"></div>

        <div className="glass-card">
          {!isAuthenticated ? (
            // ── Authentication View ──────────────────────────────────────────
            <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'center' }}>
              <div className="form-title">Welcome Back</div>
              <div className="form-subtitle">Log in to activate workspace monitoring</div>

              {error && <div className="error-alert">{error}</div>}

              <div className="input-group">
                <label className="input-label">Work Email</label>
                <input
                  type="email"
                  className="input-field"
                  placeholder="e.g. employee@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">Password</label>
                <input
                  type="password"
                  className="input-field"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              <button type="submit" className="btn" disabled={loading}>
                {loading ? 'Authenticating...' : 'Sign In & Start'}
              </button>
            </form>
          ) : (
            // ── Tracking Dashboard View ──────────────────────────────────────
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
              <div>
                <div className="status-header">
                  <div>
                    <h3 style={{ fontSize: '16px', fontWeight: 600 }}>Monitoring Active</h3>
                    <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>{userEmail}</p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div className="avatar">
                      {userEmail.substring(0, 2).toUpperCase()}
                    </div>
                    {(userRole !== 'EMPLOYEE' || uninstallAllowed) && (
                      <button className="signout-icon-btn" onClick={handleLogout} title="Sign Out">
                        🚪
                      </button>
                    )}
                  </div>
                </div>

                <div className="status-indicator">
                  <div className={`status-ring ${isTrackingActive ? 'active' : ''}`}>
                    <div className="status-center">
                      <span className="status-text">{isTrackingActive ? 'Tracking' : 'Paused'}</span>
                      <span className={`status-value ${isTrackingActive ? 'active' : 'paused'}`}>
                        {formatTime(elapsedTime)}
                      </span>
                    </div>
                  </div>
                </div>

                {pendingSyncCount > 0 && (
                  <div className="sync-badge">
                    <span className="sync-dot"></span>
                    <span>Buffering {pendingSyncCount} logs offline</span>
                  </div>
                )}

                {updaterMsg && (
                  <div style={{ textAlign: 'center', fontSize: '12px', color: 'var(--color-primary)', marginTop: '8px' }}>
                    {updaterMsg}
                  </div>
                )}
              </div>

              <div>
                <button className={`btn ${isTrackingActive ? 'btn-secondary' : ''}`} onClick={handleToggleTracking}>
                  {isTrackingActive ? '⏸️  Pause Tracking' : '▶️  Resume Tracking'}
                </button>
                <div className="footer-info">
                  Running version 1.0.0 • Remote Desk Agent
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default App;
