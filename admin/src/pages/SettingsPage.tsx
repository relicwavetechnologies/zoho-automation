import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Settings, Share2, Shield, History, Globe, Box, Bot } from 'lucide-react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { IntegrationsPage } from './IntegrationsPage';
import { AuditLogsPage } from './AuditLogsPage';
import { ControlsPage } from './ControlsPage';
import { VectorShareRequestsPage } from './VectorShareRequestsPage';
import { RbacPage } from './RbacPage';
import { AssistantSettingsPage } from './AssistantSettingsPage';
import { AgentProfilesSettingsPage } from './AgentProfilesSettingsPage';

const SETTINGS_TABS = ['assistant', 'agents', 'integrations', 'audit', 'controls', 'share-requests', 'governance'] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

const isSettingsTab = (value: string | null): value is SettingsTab =>
  Boolean(value && SETTINGS_TABS.includes(value as SettingsTab));

export const SettingsPage = () => {
  const { session } = useAdminAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isSuperAdmin = session?.role === 'SUPER_ADMIN';

  const selectedTab = useMemo<SettingsTab>(() => {
    const rawTab = searchParams.get('tab');
    if (isSettingsTab(rawTab)) {
      if (rawTab === 'governance' && !isSuperAdmin) {
        return 'integrations';
      }
      return rawTab;
    }
    return 'assistant';
  }, [isSuperAdmin, searchParams]);

  const setTab = (tab: SettingsTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-8 w-full animate-in fade-in duration-700">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
          <Settings className="h-6 w-6 text-primary" />
          Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage integrations, governance, audit logs, and platform controls.
        </p>
      </div>

      <Card className="bg-card border-border/50 shadow-sm overflow-hidden">
        <CardHeader className="border-b border-border/50 bg-secondary/5 px-6 py-4">
          <Tabs value={selectedTab} onValueChange={(value) => isSettingsTab(value) && setTab(value)} className="w-full">
            <TabsList className="bg-transparent h-10 gap-6 border-none p-0">
              <TabsTrigger 
                value="integrations" 
                className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-10 text-xs font-bold tracking-wider uppercase transition-all flex items-center gap-2"
              >
                <Box className="h-3.5 w-3.5" />
                Integrations
              </TabsTrigger>
              <TabsTrigger 
                value="assistant" 
                className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-10 text-xs font-bold tracking-wider uppercase transition-all flex items-center gap-2"
              >
                <Bot className="h-3.5 w-3.5" />
                Assistant
              </TabsTrigger>
              <TabsTrigger 
                value="agents" 
                className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-10 text-xs font-bold tracking-wider uppercase transition-all flex items-center gap-2"
              >
                <Bot className="h-3.5 w-3.5" />
                Agents
              </TabsTrigger>
              <TabsTrigger 
                value="audit" 
                className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-10 text-xs font-bold tracking-wider uppercase transition-all flex items-center gap-2"
              >
                <History className="h-3.5 w-3.5" />
                Audit Logs
              </TabsTrigger>
              <TabsTrigger 
                value="controls" 
                className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-10 text-xs font-bold tracking-wider uppercase transition-all flex items-center gap-2"
              >
                <Shield className="h-3.5 w-3.5" />
                Controls
              </TabsTrigger>
              <TabsTrigger 
                value="share-requests" 
                className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-10 text-xs font-bold tracking-wider uppercase transition-all flex items-center gap-2"
              >
                <Share2 className="h-3.5 w-3.5" />
                Share Requests
              </TabsTrigger>
              {isSuperAdmin ? (
                <TabsTrigger 
                  value="governance" 
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-10 text-xs font-bold tracking-wider uppercase transition-all flex items-center gap-2"
                >
                  <Globe className="h-3.5 w-3.5" />
                  Governance
                </TabsTrigger>
              ) : null}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="p-0">
          <div className="p-8 animate-in slide-in-from-bottom-2 duration-500">
            {selectedTab === 'assistant' ? <AssistantSettingsPage /> : null}
            {selectedTab === 'agents' ? <AgentProfilesSettingsPage /> : null}
            {selectedTab === 'integrations' ? <IntegrationsPage /> : null}
            {selectedTab === 'audit' ? <AuditLogsPage /> : null}
            {selectedTab === 'controls' ? <ControlsPage /> : null}
            {selectedTab === 'share-requests' ? <VectorShareRequestsPage /> : null}
            {selectedTab === 'governance' && isSuperAdmin ? <RbacPage /> : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
