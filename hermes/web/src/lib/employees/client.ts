import { api } from "@/lib/api";
import { MOCK_EMPLOYEES_RESPONSE } from "./fixtures";
import { mapApiMemberToEmployee, mapApiMembersToEmployees } from "./map";
import type { EmployeeRow, EmployeesListResponse } from "./types";

function useFixtureData(): boolean {
  return import.meta.env.VITE_EMPLOYEES_FIXTURE === "true";
}

export async function listEmployees(options?: {
  forceFixture?: boolean;
}): Promise<EmployeesListResponse> {
  if (options?.forceFixture || useFixtureData()) {
    return MOCK_EMPLOYEES_RESPONSE;
  }

  const response = await api.getCompanyTeamMembers();
  return {
    company_id: response.company_id,
    members: mapApiMembersToEmployees(response.members),
  };
}

export async function updateEmployee(
  id: string,
  updates: { role?: string; status?: string },
): Promise<EmployeeRow> {
  const response = await api.updateCompanyTeamMember(id, updates);
  return mapApiMemberToEmployee(response);
}
