import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, Cpu, Zap, BarChart3 } from 'lucide-react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { ExecutionsPage } from './ExecutionsPage';
import TokenUsagePage from './TokenUsagePage';
import { AiModelsPage } from './AiModelsPage';

const AI_OPS_TABS = ['executions', 'token-usage', 'models'] as const;
type AiOpsTab = (typeof AI_OPS_TABS)[number];

const isAiOpsTab = (value: string | null): value is AiOpsTab =>
  Boolean(value && AI_OPS_TABS.includes(value as AiOpsTab));

export const AiOpsPage = () => {
  const { session } = useAdminAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isSuperAdmin = session?.role === 'SUPER_ADMIN';

  const selectedTab = useMemo<AiOpsTab>(() => {
    const rawTab = searchParams.get('tab');
    if (isAiOpsTab(rawTab)) {
      if (rawTab === 'models' && !isSuperAdmin) {
        return 'executions';
      }
      return rawTab;
    }
    return 'executions';
  }, [isSuperAdmin, searchParams]);

  const setTab = (tab: AiOpsTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-8 w-full animate-in fade-in duration-700">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
          <Activity className="h-6 w-6 text-primary" />
          AI Operations
        </h1>
        <p className="text-sm text-muted-foreground">
          Monitor execution traces, analyze token consumption, and manage model posture.
        </p>
      </div>

      <Card className="bg-card border-border/50 shadow-sm overflow-hidden">
        <CardHeader className="border-b border-border/50 bg-secondary/5 px-6 py-4">
          <Tabs value={selectedTab} onValueChange={(value) => isAiOpsTab(value) && setTab(value)} className="w-full">
            <TabsList className="bg-transparent h-10 gap-6 border-none p-0">
              <TabsTrigger 
                value="executions" 
                className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-10 text-xs font-bold tracking-wider uppercase transition-all flex items-center gap-2"
              >
                <Zap className="h-3.5 w-3.5" />
                Executions
              </TabsTrigger>
              <TabsTrigger 
                value="token-usage" 
                className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-10 text-xs font-bold tracking-wider uppercase transition-all flex items-center gap-2"
              >
                <BarChart3 className="h-3.5 w-3.5" />
                Token Usage
              </TabsTrigger>
              {isSuperAdmin ? (
                <TabsTrigger 
                  value="models" 
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-10 text-xs font-bold tracking-wider uppercase transition-all flex items-center gap-2"
                >
                  <Cpu className="h-3.5 w-3.5" />
                  Models
                </TabsTrigger>
              ) : null}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="p-0">
          <div className="p-8 animate-in slide-in-from-bottom-2 duration-500">
            {selectedTab === 'executions' ? <ExecutionsPage /> : null}
            {selectedTab === 'token-usage' ? <TokenUsagePage /> : null}
            {selectedTab === 'models' && isSuperAdmin ? <AiModelsPage /> : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
