import React, { useState, useEffect } from 'react';
import axios from 'axios';

// Add type safety for Electron context bridge
declare global {
  interface Window {
    api: {
      startTracking: (token: string) => Promise<{ success: boolean; error?: string }>;
      stopTracking: () => Promise<{ success: boolean }>;
      getStatus: () => Promise<{ isTracking: boolean }>;
      logout: () => Promise<{ success: boolean }>;
      hideWindow: () => void;
      minimizeWindow: () => void;
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
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [updaterMsg, setUpdaterMsg] = useState('');

  useEffect(() => {
    // Check initial status on load
    window.api.getStatus().then((status) => {
      setIsTrackingActive(status.isTracking);
    });

    // Check if we are already logged in by retrieving token from backend status or keytar
    // Set authenticated if tracking is running or token was retrieved during main initialization
    const storedEmail = localStorage.getItem('agent_user_email');
    if (storedEmail) {
      setUserEmail(storedEmail);
      setIsAuthenticated(true);
    }

    // Subscribe to sync queue count updates
    const unsubscribeSync = window.api.onSyncStatus((data) => {
      setPendingSyncCount(data.pendingCount);
    });

    // Auto-update event listeners
    const unsubscribeAvailable = window.api.onUpdaterAvailable(() => {
      setUpdaterMsg('Downloading new update...');
    });

    const unsubscribeReady = window.api.onUpdaterReady(() => {
      setUpdaterMsg('New version ready! Restart app to install.');
    });

    return () => {
      unsubscribeSync();
      unsubscribeAvailable();
      unsubscribeReady();
    };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Authenticate with remote-desk-backend (running on port 3000 by default)
      const res = await axios.post('http://localhost:3000/auth/login', {
        email,
        password,
      });

      const { accessToken, role } = res.data;

      if (role !== 'EMPLOYEE' && role !== 'ADMIN' && role !== 'MANAGER') {
        throw new Error('Only company users can run the desktop agent.');
      }

      localStorage.setItem('agent_user_email', email);
      setUserEmail(email);
      setIsAuthenticated(true);

      // Start background tracking with the newly verified JWT
      const trackRes = await window.api.startTracking(accessToken);
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
      const res = await window.api.startTracking('');
      if (res.success) {
        setIsTrackingActive(true);
      }
    }
  };

  const handleLogout = async () => {
    await window.api.logout();
    localStorage.removeItem('agent_user_email');
    setIsAuthenticated(false);
    setIsTrackingActive(false);
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
                  <div className="avatar">
                    {userEmail.substring(0, 2).toUpperCase()}
                  </div>
                </div>

                <div className="status-indicator">
                  <div className={`status-ring ${isTrackingActive ? 'active' : ''}`}>
                    <div className="status-center">
                      <span className="status-text">Status</span>
                      <span className={`status-value ${isTrackingActive ? 'active' : 'paused'}`}>
                        {isTrackingActive ? 'Active' : 'Paused'}
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
                <button className="btn btn-secondary" onClick={handleLogout} style={{ marginTop: '8px' }}>
                  Sign Out
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
