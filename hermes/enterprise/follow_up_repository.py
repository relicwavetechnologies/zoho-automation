"""Postgres-backed storage for Divo Follow Ups control rows and events."""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from typing import Any

from enterprise.follow_ups.lifecycle import validate_transition
from enterprise.follow_ups.models import DEFAULT_FOLLOW_UP_POLICY, DivoFollowUp, DivoFollowUpEvent


def _new_id() -> str:
    return str(uuid.uuid4())


class FollowUpRepository:
    """CRUD + lifecycle updates for ``HermesFollowUp`` scoped to a company."""

    def __init__(self, connection: Any):
        self._connection = connection

    def create_follow_up(
        self,
        *,
        company_id: str,
        lark_task_guid: str,
        delegator_company_user_id: str,
        assignee_company_user_id: str,
        source_session_id: str | None = None,
        active_session_id: str | None = None,
        tracking_doc_token: str | None = None,
        tracking_doc_url: str | None = None,
        follow_up_policy_json: Mapping[str, Any] | None = None,
        status: str = "assigned",
    ) -> str:
        follow_up_id = _new_id()
        policy = dict(follow_up_policy_json or DEFAULT_FOLLOW_UP_POLICY)
        self._execute(
            """
            INSERT INTO "HermesFollowUp" (
                "id",
                "companyId",
                "larkTaskGuid",
                "delegatorCompanyUserId",
                "assigneeCompanyUserId",
                "sourceSessionId",
                "activeSessionId",
                "trackingDocToken",
                "trackingDocUrl",
                "status",
                "followUpPolicyJson"
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            """,
            (
                follow_up_id,
                company_id,
                lark_task_guid,
                delegator_company_user_id,
                assignee_company_user_id,
                source_session_id,
                active_session_id,
                tracking_doc_token,
                tracking_doc_url,
                status,
                json.dumps(policy, sort_keys=True),
            ),
        )
        return follow_up_id

    def get_follow_up(self, company_id: str, follow_up_id: str) -> DivoFollowUp | None:
        row = self._fetchone(
            """
            SELECT
                "id",
                "companyId",
                "larkTaskGuid",
                "delegatorCompanyUserId",
                "assigneeCompanyUserId",
                "sourceSessionId",
                "activeSessionId",
                "trackingDocToken",
                "trackingDocUrl",
                "status",
                "followUpPolicyJson",
                "startedAt",
                "pausedAt",
                "completedAt",
                "summary",
                "lastDocAppendAt",
                "createdAt",
                "updatedAt"
            FROM "HermesFollowUp"
            WHERE "companyId" = %s
              AND "id" = %s
            """,
            (company_id, follow_up_id),
        )
        return DivoFollowUp.from_row(row)

    def list_for_assignee(
        self,
        company_id: str,
        assignee_company_user_id: str,
    ) -> list[DivoFollowUp]:
        rows = self._fetchall(
            """
            SELECT
                "id",
                "companyId",
                "larkTaskGuid",
                "delegatorCompanyUserId",
                "assigneeCompanyUserId",
                "sourceSessionId",
                "activeSessionId",
                "trackingDocToken",
                "trackingDocUrl",
                "status",
                "followUpPolicyJson",
                "startedAt",
                "pausedAt",
                "completedAt",
                "summary",
                "lastDocAppendAt",
                "createdAt",
                "updatedAt"
            FROM "HermesFollowUp"
            WHERE "companyId" = %s
              AND "assigneeCompanyUserId" = %s
              AND "status" <> 'deleted'
            ORDER BY "createdAt" DESC, "id" DESC
            """,
            (company_id, assignee_company_user_id),
        )
        return [item for item in (DivoFollowUp.from_row(row) for row in rows) if item is not None]

    def list_for_user(
        self,
        company_id: str,
        company_user_id: str,
    ) -> list[DivoFollowUp]:
        rows = self._fetchall(
            """
            SELECT
                "id",
                "companyId",
                "larkTaskGuid",
                "delegatorCompanyUserId",
                "assigneeCompanyUserId",
                "sourceSessionId",
                "activeSessionId",
                "trackingDocToken",
                "trackingDocUrl",
                "status",
                "followUpPolicyJson",
                "startedAt",
                "pausedAt",
                "completedAt",
                "summary",
                "lastDocAppendAt",
                "createdAt",
                "updatedAt"
            FROM "HermesFollowUp"
            WHERE "companyId" = %s
              AND "status" <> 'deleted'
              AND (
                "assigneeCompanyUserId" = %s
                OR "delegatorCompanyUserId" = %s
              )
            ORDER BY "createdAt" DESC, "id" DESC
            """,
            (company_id, company_user_id, company_user_id),
        )
        return [item for item in (DivoFollowUp.from_row(row) for row in rows) if item is not None]

    def list_active(
        self,
        company_id: str,
        *,
        assignee_company_user_id: str | None = None,
    ) -> list[DivoFollowUp]:
        if assignee_company_user_id is None:
            rows = self._fetchall(
                """
                SELECT
                    "id",
                    "companyId",
                    "larkTaskGuid",
                    "delegatorCompanyUserId",
                    "assigneeCompanyUserId",
                    "sourceSessionId",
                    "activeSessionId",
                    "trackingDocToken",
                    "trackingDocUrl",
                    "status",
                    "followUpPolicyJson",
                    "startedAt",
                    "pausedAt",
                    "completedAt",
                    "summary",
                    "lastDocAppendAt",
                    "createdAt",
                    "updatedAt"
                FROM "HermesFollowUp"
                WHERE "companyId" = %s
                  AND "status" = 'active'
                ORDER BY "createdAt" DESC, "id" DESC
                """,
                (company_id,),
            )
        else:
            rows = self._fetchall(
                """
                SELECT
                    "id",
                    "companyId",
                    "larkTaskGuid",
                    "delegatorCompanyUserId",
                    "assigneeCompanyUserId",
                    "sourceSessionId",
                    "activeSessionId",
                    "trackingDocToken",
                    "trackingDocUrl",
                    "status",
                    "followUpPolicyJson",
                    "startedAt",
                    "pausedAt",
                    "completedAt",
                    "summary",
                    "lastDocAppendAt",
                    "createdAt",
                    "updatedAt"
                FROM "HermesFollowUp"
                WHERE "companyId" = %s
                  AND "assigneeCompanyUserId" = %s
                  AND "status" = 'active'
                ORDER BY "createdAt" DESC, "id" DESC
                """,
                (company_id, assignee_company_user_id),
            )
        return [item for item in (DivoFollowUp.from_row(row) for row in rows) if item is not None]

    def update_status(
        self,
        company_id: str,
        follow_up_id: str,
        *,
        target_status: str,
        actor_company_user_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> DivoFollowUp:
        current = self.get_follow_up(company_id, follow_up_id)
        if current is None:
            raise KeyError(f"Follow-up not found: {follow_up_id}")
        validate_transition(current.status, target_status)

        timestamp_sql = self._timestamp_sql_for_status(target_status)
        self._execute(
            f"""
            UPDATE "HermesFollowUp"
            SET "status" = %s,
                "updatedAt" = now()
                {timestamp_sql}
            WHERE "companyId" = %s
              AND "id" = %s
            """,
            (target_status, company_id, follow_up_id),
        )

        event_payload = {
            "from_status": current.status,
            "to_status": target_status,
            **dict(payload or {}),
        }
        self.append_event(
            company_id,
            follow_up_id,
            event_type="status_changed",
            actor_company_user_id=actor_company_user_id,
            payload=event_payload,
        )

        updated = self.get_follow_up(company_id, follow_up_id)
        if updated is None:
            raise KeyError(f"Follow-up not found after update: {follow_up_id}")
        return updated

    def attach_tracking_doc(
        self,
        company_id: str,
        follow_up_id: str,
        *,
        active_session_id: str,
        tracking_doc_token: str,
        tracking_doc_url: str | None,
    ) -> DivoFollowUp:
        self._execute(
            """
            UPDATE "HermesFollowUp"
            SET "activeSessionId" = %s,
                "trackingDocToken" = %s,
                "trackingDocUrl" = %s,
                "updatedAt" = now()
            WHERE "companyId" = %s
              AND "id" = %s
            """,
            (
                active_session_id,
                tracking_doc_token,
                tracking_doc_url,
                company_id,
                follow_up_id,
            ),
        )
        updated = self.get_follow_up(company_id, follow_up_id)
        if updated is None:
            raise KeyError(f"Follow-up not found after tracking doc attach: {follow_up_id}")
        return updated

    def update_assignee(
        self,
        company_id: str,
        follow_up_id: str,
        *,
        assignee_company_user_id: str,
    ) -> DivoFollowUp:
        self._execute(
            """
            UPDATE "HermesFollowUp"
            SET "assigneeCompanyUserId" = %s,
                "updatedAt" = now()
            WHERE "companyId" = %s
              AND "id" = %s
            """,
            (assignee_company_user_id, company_id, follow_up_id),
        )
        updated = self.get_follow_up(company_id, follow_up_id)
        if updated is None:
            raise KeyError(f"Follow-up not found after assignee update: {follow_up_id}")
        return updated

    def store_completion_summary(
        self,
        company_id: str,
        follow_up_id: str,
        *,
        summary: str,
        update_last_doc_append_at: bool = False,
    ) -> DivoFollowUp:
        last_doc_append_sql = ', "lastDocAppendAt" = now()' if update_last_doc_append_at else ""
        self._execute(
            f"""
            UPDATE "HermesFollowUp"
            SET "summary" = %s,
                "updatedAt" = now()
                {last_doc_append_sql}
            WHERE "companyId" = %s
              AND "id" = %s
            """,
            (summary, company_id, follow_up_id),
        )
        updated = self.get_follow_up(company_id, follow_up_id)
        if updated is None:
            raise KeyError(f"Follow-up not found after summary update: {follow_up_id}")
        return updated

    def mark_doc_appended(
        self,
        company_id: str,
        follow_up_id: str,
    ) -> DivoFollowUp:
        self._execute(
            """
            UPDATE "HermesFollowUp"
            SET "lastDocAppendAt" = now(),
                "updatedAt" = now()
            WHERE "companyId" = %s
              AND "id" = %s
            """,
            (company_id, follow_up_id),
        )
        updated = self.get_follow_up(company_id, follow_up_id)
        if updated is None:
            raise KeyError(f"Follow-up not found after doc append: {follow_up_id}")
        return updated

    def append_event(
        self,
        company_id: str,
        follow_up_id: str,
        *,
        event_type: str,
        actor_company_user_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> str:
        parent = self.get_follow_up(company_id, follow_up_id)
        if parent is None:
            raise KeyError(f"Follow-up not found: {follow_up_id}")

        event_id = _new_id()
        self._execute(
            """
            INSERT INTO "HermesFollowUpEvent" (
                "id",
                "followUpId",
                "eventType",
                "actorCompanyUserId",
                "payloadJson"
            )
            VALUES (%s, %s, %s, %s, %s::jsonb)
            """,
            (
                event_id,
                follow_up_id,
                event_type,
                actor_company_user_id,
                json.dumps(dict(payload or {}), sort_keys=True),
            ),
        )
        return event_id

    def list_events(self, company_id: str, follow_up_id: str) -> list[DivoFollowUpEvent]:
        parent = self.get_follow_up(company_id, follow_up_id)
        if parent is None:
            raise KeyError(f"Follow-up not found: {follow_up_id}")

        rows = self._fetchall(
            """
            SELECT
                e."id",
                e."followUpId",
                e."eventType",
                e."actorCompanyUserId",
                e."payloadJson",
                e."createdAt"
            FROM "HermesFollowUpEvent" e
            INNER JOIN "HermesFollowUp" f ON f."id" = e."followUpId"
            WHERE f."companyId" = %s
              AND e."followUpId" = %s
            ORDER BY e."createdAt" ASC, e."id" ASC
            """,
            (company_id, follow_up_id),
        )
        return [item for item in (DivoFollowUpEvent.from_row(row) for row in rows) if item is not None]

    @staticmethod
    def _timestamp_sql_for_status(target_status: str) -> str:
        if target_status == "active":
            return ', "startedAt" = COALESCE("startedAt", now())'
        if target_status == "paused":
            return ', "pausedAt" = now()'
        if target_status == "done":
            return ', "completedAt" = now()'
        return ""

    def _execute(self, sql: str, args: tuple[Any, ...]) -> None:
        result = self._connection.execute(sql, args)
        close = getattr(result, "close", None)
        if close is not None:
            close()

    def _fetchone(self, sql: str, args: tuple[Any, ...]) -> Any:
        result = self._connection.execute(sql, args)
        fetchone = getattr(result, "fetchone", None)
        if fetchone is None:
            return None
        try:
            return fetchone()
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()

    def _fetchall(self, sql: str, args: tuple[Any, ...]) -> list[Any]:
        result = self._connection.execute(sql, args)
        fetchall = getattr(result, "fetchall", None)
        if fetchall is None:
            return []
        try:
            rows = fetchall()
            return list(rows or [])
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()

    @staticmethod
    def _row_get(row: Any, key: str) -> Any:
        if row is None:
            return None
        if isinstance(row, Mapping):
            return row.get(key)
        try:
            return row[key]
        except (KeyError, TypeError, IndexError):
            return None
