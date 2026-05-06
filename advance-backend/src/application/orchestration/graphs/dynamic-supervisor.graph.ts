import { END, START, StateGraph } from '@langchain/langgraph';
import { SupervisorGraphState, type SupervisorGraphStateValue } from './dynamic-supervisor.state';
import { supervisorThink, type SupervisorThinkDeps } from './nodes/supervisor-think';
import { formatResponse } from './nodes/format-response';

export type DynamicSupervisorGraph = ReturnType<typeof buildDynamicSupervisorGraph>;

export function buildDynamicSupervisorGraph(deps: SupervisorThinkDeps) {
  const graph = new StateGraph(SupervisorGraphState)
    .addNode('think', async (state: SupervisorGraphStateValue) => supervisorThink(state, deps))
    .addNode('format', formatResponse)
    .addEdge(START, 'think')
    .addEdge('think', 'format')
    .addEdge('format', END);

  return graph.compile();
}
