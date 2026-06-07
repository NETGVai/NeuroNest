---
id: embedding-generation
name: Embedding Generation
description: Generate and manage vector embeddings for semantic search, clustering, and similarity
source: bundled
version: 1.0.0
category: ai
tags: [embeddings, vectors, semantic-search, similarity, ai]
scope: project
---

# Embedding Generation

## Embedding Models

- **OpenAI text-embedding-3**: High quality, API-based
- **Sentence Transformers**: Open source, self-hosted
- **Cohere Embed**: Good multilingual support
- Choose based on quality needs, latency, and cost constraints

## Chunking Strategies

- Split documents at semantic boundaries (paragraphs, sections)
- Use overlapping chunks to preserve context at boundaries
- Keep chunk size aligned with model's optimal input length
- Include metadata (source, section, page) with each chunk

## Vector Storage

- Use purpose-built vector databases (Pinecone, Weaviate, Qdrant)
- Or use pgvector for PostgreSQL-integrated vector search
- Index with appropriate algorithm (HNSW for recall, IVF for speed)
- Tune index parameters based on dataset size and query patterns

## Similarity Search

- Cosine similarity for normalized embeddings
- Use hybrid search (vector + keyword) for better recall
- Apply reranking on top-k results for precision
- Filter by metadata before or after vector search
