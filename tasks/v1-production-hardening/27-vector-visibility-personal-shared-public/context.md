# Vector Visibility Personal Shared Public

## Why This Task Exists
The current retrieval path is effectively company-wide. V1 needs scoped retrieval so personal learning, shared company knowledge, and public corpus can coexist without cross-user leakage.

## Current State
1. External Qdrant integration exists.
2. Retrieval filters are company-centric today.
3. Contracts and persistence do not fully model `visibility` and `ownerUserId`.

## In Scope
1. Keep a single Qdrant collection.
2. Extend vector payload and persistence model with `visibility` and `ownerUserId`.
3. Apply retrieval policy for `personal`, `shared`, and `public`.
4. Ensure payload indexes exist for `visibility`, `ownerUserId`, and `companyId`.
5. Backfill existing company vectors to `shared`.

## Out of Scope
1. Admin approval workflow for sharing.
2. Cross-provider vector backend changes.
3. New retrieval ranking strategies.

## Dependencies
16-qdrant-external-adapter
18-retrieval-grounding-in-zoho-agent

## Deliverables
1. Schema/contracts for scoped vector metadata.
2. Qdrant index and filter updates.
3. Retrieval path updates using requester scope.
4. Tests for cross-user and cross-company isolation.

## Exit Criteria
Retrieval respects personal, shared, and public scope boundaries.
