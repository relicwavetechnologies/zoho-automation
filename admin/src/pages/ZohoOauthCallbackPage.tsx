import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { api } from '../lib/api';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

type ZohoOauthState = {
  companyId?: string;
  scopes?: string[];
  environment?: 'prod' | 'sandbox';
};

const decodeState = (raw: string | null): ZohoOauthState => {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(window.atob(raw)) as ZohoOauthState;
    return {
      companyId: parsed.companyId,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((scope) => typeof scope === 'string') : undefined,
      environment: parsed.environment === 'sandbox' ? 'sandbox' : 'prod',
    };
  } catch {
    return {};
  }
};

export const ZohoOauthCallbackPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token } = useAdminAuth();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const connectStartedRef = useRef(false);

  const code = searchParams.get('code');
  const parsedState = useMemo(() => decodeState(searchParams.get('state')), [searchParams]);

  useEffect(() => {
    const run = async () => {
      if (connectStartedRef.current) {
        return;
      }

      if (!token) {
        setStatus('error');
        setErrorMessage('Admin session missing. Please login and retry Zoho connect.');
        return;
      }
      if (!code) {
        setStatus('error');
        setErrorMessage('Missing OAuth authorization code in callback URL.');
        return;
      }

      const submissionKey = `zoho.oauth.connect.${code}`;
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
          '/api/admin/company/onboarding/connect',
          {
            companyId: parsedState.companyId || undefined,
            mode: 'rest',
            authorizationCode: code,
            scopes: parsedState.scopes && parsedState.scopes.length > 0
              ? parsedState.scopes
              : ['ZohoCRM.modules.ALL'],
            environment: parsedState.environment ?? 'prod',
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
        setErrorMessage(error instanceof Error ? error.message : 'Zoho OAuth connect failed');
      }
    };

    void run();
  }, [code, navigate, parsedState.companyId, parsedState.environment, parsedState.scopes, token]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-200 flex items-center justify-center px-4">
      <Card className="w-full max-w-lg bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20">
        <CardHeader>
          <CardTitle className="text-zinc-100">Zoho OAuth Callback</CardTitle>
          <CardDescription className="text-zinc-500">
            Finalizing Zoho connection for your workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === 'processing' ? (
            <div className="flex items-center gap-2 text-zinc-300">
              <RefreshCw className="h-4 w-4 animate-spin text-zinc-400" />
              <span>Connecting Zoho with authorization code…</span>
            </div>
          ) : null}

          {status === 'success' ? (
            <div className="text-emerald-400 text-sm">
              Zoho connected successfully. Redirecting to Integrations…
            </div>
          ) : null}

          {status === 'error' ? (
            <div className="space-y-3">
              <p className="text-red-400 text-sm">
                {errorMessage ?? 'Unable to complete Zoho OAuth callback.'}
              </p>
              <Button
                variant="outline"
                className="border-[#333] text-zinc-200 hover:bg-[#1a1a1a]"
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
