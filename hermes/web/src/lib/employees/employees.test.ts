import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapApiMemberToEmployee } from "./map.js";

describe("mapApiMemberToEmployee", () => {
  it("maps partial API rows and nulls missing Lark metadata", () => {
    const row = mapApiMemberToEmployee({
      id: "cu_1",
      company_id: "company_test",
      email: "alice@example.com",
      display_name: "Alice",
      role: "MEMBER",
      department_id: "dept_eng",
      status: "active",
      first_login_at: "2026-06-01T00:00:00Z",
      last_login_at: "2026-06-12T00:00:00Z",
    });

    assert.equal(row.lark_open_id, null);
    assert.equal(row.department_name, "dept_eng");
    assert.equal(row.provider, "lark");
  });

  it("reads extended Lark fields when the API already returns them", () => {
    const row = mapApiMemberToEmployee({
      id: "cu_2",
      company_id: "company_test",
      email: "bob@example.com",
      display_name: "Bob",
      role: "COMPANY_ADMIN",
      department_id: "dept_ops",
      status: "active",
      first_login_at: null,
      last_login_at: null,
      lark_open_id: "ou_bob",
      lark_union_id: "on_bob",
      department_name: "Operations",
    } as never);

    assert.equal(row.lark_open_id, "ou_bob");
    assert.equal(row.lark_union_id, "on_bob");
    assert.equal(row.department_name, "Operations");
  });
});
