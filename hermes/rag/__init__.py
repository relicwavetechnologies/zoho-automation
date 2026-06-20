"""RAG (retrieval-augmented generation) subsystem for company-mode Divo.

Ported to full parity with the legacy ``advance-backend`` RAG stack:

  * **Vector store** — Qdrant Cloud, the *same* cluster/collection
    (``retrieval_v3``) the legacy backend indexes into, addressed with the
    identical deterministic point-ID scheme + named multi-vectors
    (``dense_text_v2`` / ``dense_mm_v1``). See :mod:`rag.vector_store`.
  * **Embeddings** — Gemini ``gemini-embedding-001`` (3072-dim) primary,
    OpenAI ``text-embedding-3-*`` secondary, deterministic SHA-256 fallback
    that never blocks the pipeline. See :mod:`rag.embeddings`.
  * **Reranker** — Groq listwise judge (``llama-3.1-8b-instant``) scoring
    chunks 0–10, with a score-sort fallback. See :mod:`rag.reranker`.
  * **Retrieval** — query rewriting/expansion, parallel semantic search,
    rerank, corrective retry, citation assembly. See :mod:`rag.document_rag`.
  * **Tools** — ``document_rag`` (search/read_full/list_files) and
    ``context_search`` (unified multi-source). Registered in
    ``tools/rag_tools.py``.

Because the vector backend is the same Qdrant cluster the legacy system
already populates, the retrieval path is immediately useful against real
company documents the moment the envs are wired (see :class:`rag.config.RagConfig`).
"""
