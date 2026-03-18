import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { api } from '../lib/api';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

export const GoogleOauthCallbackPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token } = useAdminAuth();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const connectStartedRef = useRef(false);

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const oauthError = searchParams.get('error');

  useEffect(() => {
    const run = async () => {
      if (connectStartedRef.current) {
        return;
      }
      if (oauthError) {
        setStatus('error');
        setErrorMessage(`Google OAuth failed: ${oauthError}`);
        return;
      }
      if (!token) {
        setStatus('error');
        setErrorMessage('Admin session missing. Please login and retry Google connect.');
        return;
      }
      if (!code || !state) {
        setStatus('error');
        setErrorMessage('Missing Google authorization code or state in callback URL.');
        return;
      }

      const submissionKey = `google.oauth.connect.${code}`;
      if (window.sessionStorage.getItem(submissionKey) === 'done') {
        setStatus('success');
        window.setTimeout(() => {
          navigate('/integrations', { replace: true });
        }, 600);
        return;
      }

      connectStartedRef.current = true;
      window.sessionStorage.setItem(submissionKey, 'done');

      try {
        await api.post(
          '/api/admin/company/onboarding/google-connect',
          {
            authorizationCode: code,
            state,
          },
          token,
        );
        setStatus('success');
        window.setTimeout(() => {
          navigate('/integrations', { replace: true });
        }, 1200);
      } catch (error) {
        window.sessionStorage.removeItem(submissionKey);
        setStatus('error');
        setErrorMessage(error instanceof Error ? error.message : 'Google connect failed');
      }
    };

    void run();
  }, [code, navigate, oauthError, state, token]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-200 flex items-center justify-center px-4">
      <Card className="w-full max-w-lg bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20">
        <CardHeader>
          <CardTitle className="text-zinc-100">Google Workspace Callback</CardTitle>
          <CardDescription className="text-zinc-500">
            Finalizing Google Workspace connection for this company.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === 'processing' ? (
            <div className="flex items-center gap-2 text-zinc-300">
              <RefreshCw className="h-4 w-4 animate-spin text-zinc-400" />
              <span>Connecting Google Workspace…</span>
            </div>
          ) : null}

          {status === 'success' ? (
            <div className="text-emerald-400 text-sm">
              Google Workspace connected successfully. Redirecting to Integrations…
            </div>
          ) : null}

          {status === 'error' ? (
            <div className="space-y-3">
              <div className="text-red-400 text-sm">
                {errorMessage ?? 'Unable to complete Google OAuth callback.'}
              </div>
              <Button
                type="button"
                variant="outline"
                className="border-[#2a2a2a] text-zinc-300 hover:bg-[#1a1a1a]"
                onClick={() => navigate('/integrations', { replace: true })}
              >
                Back to Integrations
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
};
