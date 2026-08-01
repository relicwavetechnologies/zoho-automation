-- Hindsight provides semantic matching; this canonical fallback must preserve
-- tokens across English, Hinglish, names, codes, and languages without an
-- English-only stemmer silently discarding or changing them.
UPDATE "KnowledgeVersion"
SET "searchVector" = to_tsvector('simple', coalesce("searchText", ''));
