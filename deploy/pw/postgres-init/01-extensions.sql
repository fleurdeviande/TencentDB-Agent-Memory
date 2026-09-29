-- Extensions the pw Postgres backends rely on, plus the MemoryKnowledge database.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE DATABASE tdai_knowledge;
\connect tdai_knowledge
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
